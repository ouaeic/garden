import { OPENAI_VIDEO_RETIREMENT_AT } from '@garden/model-gateway';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptJson, encryptJson } from '@garden/core';
import { queueVideoGeneration } from './media-generation.js';
import { mediaJobAad, type StoredVideoRequest } from './media-job-domain.js';
import type { ToolContext } from './tool-dispatch.js';
import type { InferenceCredential } from './agent-state.js';
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(OPENAI_VIDEO_RETIREMENT_AT) - 1);
});
afterEach(() => vi.restoreAllMocks());
const key = Buffer.alloc(32, 7);
const sourceId = '11111111-1111-4111-8111-111111111111';
const original: StoredVideoRequest = {
  provider: { baseUrl: 'https://api.openai.com/v1', apiKey: 'same-account', apiProtocol: 'openai' },
  input: { model: 'sora-2', prompt: 'Source', duration: 8, size: '1280x720' },
  quoteUsd: 0.8
};
const secret: InferenceCredential = {
  provider: 'openai-compatible',
  baseUrl: original.provider.baseUrl,
  apiKey: original.provider.apiKey,
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
const fixture = (overrides: Record<string, unknown> = {}) => {
  const createMediaJob = vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    status: 'queued'
  }));
  const context = {
    consequentialApproved: true,
    key,
    task: { id: 'task', userId: 'owner', workspaceId: 'workspace' },
    store: {
      createMediaJob,
      getMediaJob: async () => ({
        id: sourceId,
        userId: 'owner',
        workspaceId: 'workspace',
        status: 'completed',
        providerJobId: 'video_source',
        durationSeconds: 8,
        extensionCount: 0,
        requestCiphertext: encryptJson(original, key, mediaJobAad(sourceId)),
        ...overrides
      })
    },
    runner: {}
  } as unknown as ToolContext;
  return { context, createMediaJob };
};
const call = (operation: 'edit' | 'extend', duration: number) => ({
  id: 'call',
  name: 'generate_media',
  arguments: {
    kind: 'video',
    prompt: 'Warm evening light',
    options: {
      operation,
      sourceJobId: sourceId,
      modelId: 'openai/sora-2',
      duration,
      size: '1280x720'
    }
  }
});
describe('native video source lineage', () => {
  it('persists an edit of the complete source and an extension with bounded total duration', async () => {
    const { context, createMediaJob } = fixture();
    expect(await queueVideoGeneration(context, call('edit', 8), secret)).toMatchObject({
      operation: 'edit',
      sourceJobId: sourceId,
      status: 'queued'
    });
    const saved = createMediaJob.mock.calls[0]![0];
    expect(saved).toMatchObject({
      operation: 'edit',
      durationSeconds: 8,
      extensionCount: 0,
      sourceJobId: sourceId,
      reservationUsd: 0.8
    });
    const stored = decryptJson<StoredVideoRequest>(
      saved.requestCiphertext as Parameters<typeof decryptJson>[0],
      key,
      mediaJobAad(String(saved.id))
    );
    expect(stored.input).toMatchObject({
      operation: 'edit',
      sourceProviderId: 'video_source',
      model: 'sora-2'
    });
    await queueVideoGeneration(context, call('extend', 4), secret);
    expect(createMediaJob.mock.calls[1]![0]).toMatchObject({
      operation: 'extend',
      durationSeconds: 12,
      extensionCount: 1,
      reservationUsd: 0.4
    });
  });
  it('refuses cross-account, cross-workspace and changed duration sources before reserving', async () => {
    const { context, createMediaJob } = fixture();
    await expect(
      queueVideoGeneration(context, call('edit', 8), { ...secret, apiKey: 'different-account' })
    ).rejects.toThrow('original provider account');
    await expect(queueVideoGeneration(context, call('edit', 4), secret)).rejects.toThrow(
      'full source duration'
    );
    expect(createMediaJob).not.toHaveBeenCalled();
    const elsewhere = fixture({ workspaceId: 'another-workspace' });
    await expect(
      queueVideoGeneration(elsewhere.context, call('extend', 4), secret)
    ).rejects.toThrow('this workspace');
    expect(elsewhere.createMediaJob).not.toHaveBeenCalled();
  });
  it('keeps per-job approval and both extension limits mandatory', async () => {
    const { context, createMediaJob } = fixture({ durationSeconds: 118 });
    await expect(queueVideoGeneration(context, call('extend', 4), secret)).rejects.toThrow(
      'one hundred twenty'
    );
    await expect(
      queueVideoGeneration({ ...context, consequentialApproved: false }, call('edit', 8), secret)
    ).rejects.toThrow('own approval');
    expect(createMediaJob).not.toHaveBeenCalled();
    const full = fixture({ extensionCount: 6 });
    await expect(queueVideoGeneration(full.context, call('extend', 4), secret)).rejects.toThrow(
      'six extensions'
    );
    expect(full.createMediaJob).not.toHaveBeenCalled();
  });
});
