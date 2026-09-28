import { OPENAI_VIDEO_RETIREMENT_AT } from '@garden/model-gateway';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptJson, encryptJson } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { executeMediaLibrary, mediaAssetAad } from './media-library.js';
import { queueVideoGeneration } from './media-generation.js';
import { mediaJobAad, type StoredVideoRequest } from './media-job-domain.js';
import { approvalRequirement } from './approval-policy.js';
import type { InferenceCredential } from './agent-state.js';
import type { ToolContext } from './tool-dispatch.js';
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(OPENAI_VIDEO_RETIREMENT_AT) - 1);
});
afterEach(() => vi.restoreAllMocks());
const key = Buffer.alloc(32, 4),
  mp4 = Buffer.from('0000ftypisom0000');
const secret: InferenceCredential = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'owner-native-key',
  enforceZeroDataRetention: true,
  mediaRoutes: {
    video: {
      id: 'openai/sora-2',
      providerModelId: 'sora-2',
      displayName: 'Sora',
      provider: 'openai',
      modality: 'video',
      apiProtocol: 'openai',
      usdPerImage: null,
      usdPerMinute: null,
      usdPerMillionCharacters: null,
      priceSource: 'provider',
      pricing: [{ billable: 'output_video', unit: 'second', costUsd: 0.1, variant: '1280x720' }],
      recommendationTags: [],
      updatedAt: new Date().toISOString()
    }
  }
};
const call = () => ({
  id: randomUUID(),
  name: 'generate_media',
  arguments: {
    action: 'library',
    options: {
      operation: 'create_character',
      referencePath: 'workspace/moss.mp4',
      name: 'Moss',
      maxCostUsd: 0.1
    }
  }
});
describe('retained native character asset lifecycle', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
    store = new DataStore(database);
  let userId = '',
    workspaceId = '';
  beforeAll(async () => {
    await migrateDatabase(database);
    userId = (await store.createUser({ username: 'asset-owner', displayName: 'Owner' })).id;
    workspaceId = (
      await store.createWorkspace({
        userId,
        name: 'Assets',
        storageLimitBytes: 100_000_000,
        imageRevision: 'test',
        region: 'local',
        wrappedKey: 'fixture'
      })
    ).id;
  });
  afterAll(async () => database.close());
  afterEach(() => vi.unstubAllGlobals());
  const context = async () =>
    ({
      key,
      store,
      consequentialApproved: true,
      task: await store.createTask({
        userId,
        workspaceId,
        titleCiphertext: encryptJson({ title: 'Assets' }, key, 'title'),
        promptCiphertext: encryptJson({ prompt: 'Moss' }, key, 'prompt'),
        modelId: 'test/model',
        nameIndex: { nameTokens: 'assets', openingTokens: 'moss' },
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        maxSpendUsd: 2,
        securityMode: 'balanced'
      }),
      runner: { readBytes: vi.fn(async () => ({ mimeType: 'video/mp4', bytes: mp4 })) }
    }) as unknown as ToolContext;
  it('persists an upload intent before HTTP and binds reuse to the same workspace and provider account', async () => {
    const ctx = await context(),
      request = call();
    const fetch = vi.fn(async () => {
      expect((await store.listTaskMediaAssets(userId, ctx.task.id))[0]).toMatchObject({
        status: 'submitting',
        reservationUsd: 0.1
      });
      return Response.json({ id: 'char_moss' });
    });
    vi.stubGlobal('fetch', fetch);
    const result = (await executeMediaLibrary(ctx, request, secret)) as { assetId: string };
    const asset = await store.getMediaAsset(userId, result.assetId);
    expect(asset).toMatchObject({ status: 'completed', costUsd: null });
    expect(await store.getMediaAsset(randomUUID(), result.assetId)).toBeNull();
    expect(decryptJson(asset!.resultCiphertext!, key, mediaAssetAad(result.assetId))).toEqual({
      id: 'char_moss',
      name: 'Moss'
    });
    await expect(executeMediaLibrary(ctx, request, secret)).rejects.toMatchObject({
      code: 'media_asset_submission_exists'
    });
    expect(fetch).toHaveBeenCalledOnce();
    const video = {
      id: randomUUID(),
      name: 'generate_media',
      arguments: {
        kind: 'video',
        prompt: 'Moss walks through a forest',
        options: {
          modelId: 'openai/sora-2',
          duration: 8,
          size: '1280x720',
          characterAssetIds: [result.assetId]
        }
      }
    };
    const queued = await queueVideoGeneration(ctx, video, secret);
    const job = await store.getMediaJob(userId, queued.mediaJobId);
    expect(
      decryptJson<StoredVideoRequest>(job!.requestCiphertext, key, mediaJobAad(job!.id)).input
        .characters
    ).toEqual([{ id: 'char_moss' }]);
    await expect(
      queueVideoGeneration(
        ctx,
        { ...video, id: randomUUID() },
        { ...secret, apiKey: 'different-account' }
      )
    ).rejects.toMatchObject({ code: 'media_character_unavailable' });
    await expect(
      queueVideoGeneration(
        ctx,
        {
          ...video,
          id: randomUUID(),
          arguments: { ...video.arguments, prompt: 'A different subject' }
        },
        secret
      )
    ).rejects.toMatchObject({ code: 'media_character_name_missing' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('holds uncertain uploads, releases proven rejections and allows only the owner to reconcile billing', async () => {
    const ctx = await context();
    const fetch = vi.fn(async () => {
      throw new Error('lost response');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(executeMediaLibrary(ctx, call(), secret)).rejects.toMatchObject({
      code: 'media_asset_submission_uncertain'
    });
    const [asset] = await store.listTaskMediaAssets(userId, ctx.task.id);
    expect(asset).toMatchObject({ status: 'submission_uncertain', costUsd: null });
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.1);
    const receipt = encryptJson(
      { id: 'char_recovered', name: 'Moss', receiptSource: 'owner' },
      key,
      mediaAssetAad(asset!.id)
    );
    expect(
      await store.reconcileMediaAsset({
        id: asset!.id,
        userId: randomUUID(),
        resultCiphertext: receipt,
        costUsd: 0.02
      })
    ).toBeNull();
    expect(
      await store.reconcileMediaAsset({
        id: asset!.id,
        userId,
        resultCiphertext: receipt,
        costUsd: 0.02
      })
    ).toMatchObject({ status: 'completed', costUsd: 0.02 });
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.02);
    expect(
      await store.reconcileMediaAsset({
        id: asset!.id,
        userId,
        resultCiphertext: receipt,
        costUsd: 0
      })
    ).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('refused', { status: 400 }))
    );
    await expect(executeMediaLibrary(ctx, call(), secret)).rejects.toMatchObject({
      code: 'media_asset_refused'
    });
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.02);
  });
  it('keeps upload and deletion behind their explicit floors and refuses unapproved dispatch', async () => {
    const ctx = await context(),
      request = call(),
      fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const approval = approvalRequirement(request.name, request.arguments, 'balanced');
    expect(approval).toMatchObject({ sideEffect: 'external_reversible' });
    expect(approval?.preview).toMatch(/not eligible for zero data retention/);
    expect(
      approvalRequirement(
        'generate_media',
        { action: 'library', options: { operation: 'delete_video', providerVideoId: 'video_1' } },
        'balanced'
      )
    ).toMatchObject({ sideEffect: 'external_consequential' });
    await expect(
      executeMediaLibrary({ ...ctx, consequentialApproved: false }, request, secret)
    ).rejects.toMatchObject({ code: 'media_library_approval_required' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.listTaskMediaAssets(userId, ctx.task.id)).toEqual([]);
  });
});
