import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptJson, wrapDataKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import {
  NativeMediaSubmissionUncertainError,
  OPENAI_VIDEO_RETIREMENT_AT
} from '@garden/model-gateway';
import { MediaBatchWorker, queueVideoBatch } from './media-batches.js';
import { MediaJobWorker } from './media-jobs.js';
import { approvalRequirement } from './approval-policy.js';
import { resolvedMediaModel } from './media.js';
import type { InferenceCredential } from './agent-state.js';
import type { ToolContext } from './tool-dispatch.js';
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(OPENAI_VIDEO_RETIREMENT_AT) - 1);
});
afterEach(() => vi.restoreAllMocks());
const masterKey = Buffer.alloc(32, 31),
  key = Buffer.alloc(32, 32),
  mp4 = Buffer.from('0000ftypisom0000');
const secret: InferenceCredential = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'native-batch-key',
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
const request = (duration = 8) => ({
  id: randomUUID(),
  name: 'generate_media',
  arguments: {
    action: 'batch',
    kind: 'video',
    options: {
      modelId: 'openai/sora-2',
      shots: [
        { prompt: 'Morning garden', duration, size: '1280x720', path: 'generated/morning.mp4' },
        { prompt: 'Evening garden', duration, size: '1280x720', path: 'generated/evening.mp4' }
      ]
    }
  }
});
describe('durable native video batches', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
    store = new DataStore(database);
  let userId = '',
    workspaceId = '';
  beforeAll(async () => {
    await migrateDatabase(database);
    userId = (await store.createUser({ username: 'batch-owner', displayName: 'Owner' })).id;
    workspaceId = randomUUID();
    await store.createWorkspace({
      id: workspaceId,
      userId,
      name: 'Batch',
      storageLimitBytes: 100_000_000,
      imageRevision: 'test',
      region: 'local',
      wrappedKey: wrapDataKey(key, masterKey, workspaceId)
    });
  });
  afterAll(async () => database.close());
  const context = async (maxSpendUsd = 5) =>
    ({
      key,
      store,
      consequentialApproved: true,
      runner: {},
      task: await store.createTask({
        userId,
        workspaceId,
        titleCiphertext: encryptJson({ title: 'Batch' }, key, 'title'),
        promptCiphertext: encryptJson({ prompt: 'Make a batch' }, key, 'prompt'),
        modelId: 'test/model',
        nameIndex: { nameTokens: 'batch', openingTokens: 'make' },
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        maxSpendUsd,
        securityMode: 'balanced'
      })
    }) as unknown as ToolContext;
  const ready = async (id: string) =>
    database.query('UPDATE provider_media_batches SET next_poll_at=NOW() WHERE id=$1', [id]);
  const stopOthers = async () => {
    await database.query('UPDATE provider_media_batches SET watching=FALSE');
    await database.query('UPDATE provider_media_jobs SET watching=FALSE');
  };
  it('reserves discounted shots together, persists both submissions, then publishes each finished result without model polling', async () => {
    await stopOthers();
    const ctx = await context(1),
      call = request();
    expect(
      approvalRequirement(call.name, call.arguments, 'balanced', {
        mediaModel: resolvedMediaModel('video', secret.mediaRoutes)
      })
    ).toMatchObject({ sideEffect: 'external_reversible' });
    const batch = await queueVideoBatch(ctx, call, secret);
    expect(batch).toMatchObject({ reservationUsd: 0.8, status: 'queued' });
    expect(batch.jobs).toHaveLength(2);
    expect(await store.leaseMediaJob('must-not-submit-single')).toBeNull();
    const uploadBatch = vi.fn(async ({ jsonl }: { jsonl: string }) => {
      expect(
        jsonl
          .split('\n')
          .map((line) => (JSON.parse(line) as { custom_id: string }).custom_id)
          .sort()
      ).toEqual(batch.jobs.map((job) => job.mediaJobId).sort());
      expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.8);
      return { id: 'file_batch' };
    });
    const submitBatch = vi.fn(async () => ({
      id: 'batch_provider',
      status: 'validating' as const,
      inputFileId: 'file_batch',
      outputFileId: null,
      errorFileId: null,
      counts: null
    }));
    const readBatch = vi.fn(async () => ({
      id: 'batch_provider',
      status: 'completed' as const,
      inputFileId: 'file_batch',
      outputFileId: 'file_results',
      errorFileId: null,
      counts: { total: 2, completed: 1, failed: 1 }
    }));
    const client = {
      cancelBatch: vi.fn(),
      uploadBatch,
      submitBatch,
      readBatch,
      readBatchResults: vi.fn(async () =>
        batch.jobs.map((job, index) => ({
          custom_id: job.mediaJobId,
          response:
            index === 0
              ? { status_code: 200, body: { id: 'video_finished', status: 'completed' } }
              : { status_code: 400, body: { error: 'declined' } }
        }))
      )
    };
    const worker = new MediaBatchWorker({
      store,
      masterKey,
      workerId: 'batch-one',
      client: () => client
    });
    await worker.tick();
    expect(await store.getMediaBatch(userId, batch.mediaBatchId)).toMatchObject({
      status: 'file_uploaded',
      inputFileId: 'file_batch'
    });
    await ready(batch.mediaBatchId);
    await worker.tick();
    expect(await store.getMediaBatch(userId, batch.mediaBatchId)).toMatchObject({
      status: 'pending',
      providerBatchId: 'batch_provider'
    });
    await ready(batch.mediaBatchId);
    await worker.tick();
    expect(await store.getMediaBatch(userId, batch.mediaBatchId)).toMatchObject({
      status: 'delivering',
      completed: 0,
      failed: 1
    });
    const shots = await store.listMediaBatchJobs(userId, batch.mediaBatchId);
    expect(shots.filter((job) => job.status === 'delivering')).toHaveLength(1);
    expect(shots.filter((job) => job.status === 'failed')).toHaveLength(1);
    expect(shots.find((job) => job.status === 'delivering')).toMatchObject({
      costUsd: 0.4,
      costSource: 'quote'
    });
    const writeBytes = vi.fn(async () => undefined);
    const delivery = new MediaJobWorker({
      store,
      masterKey,
      workerId: 'delivery',
      runner: { writeBytes, call: vi.fn() } as never,
      client: () => ({
        submit: vi.fn(async () => {
          throw new Error('no repeated submit');
        }),
        poll: vi.fn(async () => {
          throw new Error('already terminal');
        }),
        download: vi.fn(async () => ({
          bytes: mp4,
          mimeType: 'video/mp4' as const,
          filename: 'shot.mp4'
        }))
      })
    });
    await delivery.tick();
    expect(writeBytes).toHaveBeenCalledTimes(2);
    expect(
      (await store.listMediaBatchJobs(userId, batch.mediaBatchId)).filter((job) => job.artifactId)
    ).toHaveLength(1);
    await ready(batch.mediaBatchId);
    await worker.tick();
    expect(await store.getMediaBatch(userId, batch.mediaBatchId)).toMatchObject({
      status: 'completed',
      completed: 1,
      failed: 1
    });
    expect(uploadBatch).toHaveBeenCalledOnce();
    expect(submitBatch).toHaveBeenCalledOnce();
    expect(readBatch).toHaveBeenCalledOnce();
  });
  it('never replays an uncertain batch POST and requires the correct owner receipt type', async () => {
    await stopOthers();
    const ctx = await context(),
      call = request(),
      batch = await queueVideoBatch(ctx, call, secret);
    const submitBatch = vi.fn(async () => {
      throw new NativeMediaSubmissionUncertainError(new Error('lost POST response'));
    });
    const worker = new MediaBatchWorker({
      store,
      masterKey,
      workerId: 'uncertain',
      client: () => ({
        cancelBatch: vi.fn(),
        uploadBatch: vi.fn(async () => ({ id: 'file_uncertain' })),
        submitBatch,
        readBatch: vi.fn(),
        readBatchResults: vi.fn()
      })
    });
    await worker.tick();
    await ready(batch.mediaBatchId);
    await worker.tick();
    expect(await store.getMediaBatch(userId, batch.mediaBatchId)).toMatchObject({
      status: 'submission_uncertain'
    });
    expect(await worker.tick()).toBe(false);
    expect(submitBatch).toHaveBeenCalledOnce();
    expect((await queueVideoBatch(ctx, { ...call, id: randomUUID() }, secret)).mediaBatchId).toBe(
      batch.mediaBatchId
    );
    expect(
      await store.reconcileMediaBatch(userId, batch.mediaBatchId, { inputFileId: 'file_uncertain' })
    ).toBeNull();
    expect(
      await store.reconcileMediaBatch(randomUUID(), batch.mediaBatchId, {
        providerBatchId: 'batch_found'
      })
    ).toBeNull();
    expect(
      await store.reconcileMediaBatch(userId, batch.mediaBatchId, {
        providerBatchId: 'batch_found'
      })
    ).toMatchObject({ status: 'pending', providerBatchId: 'batch_found' });
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.8);
  });
  it('refuses cross-batch receipts and repeated shot identities before any delivery assignment', async () => {
    await stopOthers();
    const ctx = await context(),
      batch = await queueVideoBatch(ctx, request(), secret);
    let wrongFile = true,
      duplicate = false;
    const worker = new MediaBatchWorker({
      store,
      masterKey,
      workerId: 'identity',
      client: () => ({
        cancelBatch: vi.fn(),
        uploadBatch: vi.fn(async () => ({ id: 'file_identity' })),
        submitBatch: vi.fn(async () => ({
          id: 'batch_identity',
          status: 'validating' as const,
          inputFileId: 'file_identity',
          outputFileId: null,
          errorFileId: null,
          counts: null
        })),
        readBatch: vi.fn(async () => ({
          id: 'batch_identity',
          status: 'completed' as const,
          inputFileId: wrongFile ? 'file_other' : 'file_identity',
          outputFileId: 'file_result_identity',
          errorFileId: null,
          counts: null
        })),
        readBatchResults: vi.fn(async () =>
          batch.jobs.map((job, index) => ({
            custom_id: duplicate ? batch.jobs[0]!.mediaJobId : job.mediaJobId,
            response: {
              status_code: 200,
              body: { id: `video_identity_${index}`, status: 'completed' }
            }
          }))
        )
      })
    });
    await worker.tick();
    await ready(batch.mediaBatchId);
    await worker.tick();
    await ready(batch.mediaBatchId);
    await worker.tick();
    expect(await store.getMediaBatch(userId, batch.mediaBatchId)).toMatchObject({
      status: 'pending'
    });
    let shots = await store.listMediaBatchJobs(userId, batch.mediaBatchId);
    expect(shots).toHaveLength(2);
    expect(shots.every((job) => job.status === 'queued' && job.providerJobId === null)).toBe(true);
    wrongFile = false;
    duplicate = true;
    await ready(batch.mediaBatchId);
    await worker.tick();
    expect(await store.getMediaBatch(userId, batch.mediaBatchId)).toMatchObject({
      status: 'pending'
    });
    shots = await store.listMediaBatchJobs(userId, batch.mediaBatchId);
    expect(shots).toHaveLength(2);
    expect(shots.every((job) => job.status === 'queued' && job.providerJobId === null)).toBe(true);
    duplicate = false;
    await ready(batch.mediaBatchId);
    await worker.tick();
    expect(await store.getMediaBatch(userId, batch.mediaBatchId)).toMatchObject({
      status: 'delivering',
      completed: 0
    });
  });
  it('rolls the complete reservation back when the full shot list exceeds the task cap', async () => {
    await stopOthers();
    const ctx = await context(1);
    await expect(queueVideoBatch(ctx, request(12), secret)).rejects.toMatchObject({
      code: 'spend_cap_reached'
    });
    expect(await store.listMediaBatches(userId, ctx.task.id)).toEqual([]);
    expect(await store.listMediaJobs(userId, ctx.task.id)).toEqual([]);
    expect(await store.mediaSpendForTask(ctx.task.id)).toBe(0);
    await expect(
      queueVideoBatch({ ...ctx, consequentialApproved: false }, request(), secret)
    ).rejects.toMatchObject({ code: 'media_batch_approval_required' });
  });
  it('quarantines an expired uploader and keeps stale workers from attaching another provider batch', async () => {
    await stopOthers();
    const ctx = await context(),
      batch = await queueVideoBatch(ctx, request(), secret);
    const leased = await store.leaseMediaBatch('lost-uploader');
    expect(leased?.id).toBe(batch.mediaBatchId);
    await database.query(
      "UPDATE provider_media_batches SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [batch.mediaBatchId]
    );
    expect(await store.leaseMediaBatch('recovery')).toBeNull();
    expect(await store.getMediaBatch(userId, batch.mediaBatchId)).toMatchObject({
      status: 'submission_uncertain'
    });
    expect(
      await store.updateMediaBatch({
        id: batch.mediaBatchId,
        leaseOwner: 'lost-uploader',
        status: 'pending',
        providerBatchId: 'wrong_batch'
      })
    ).toBe(false);
  });
  it('cancels unsubmitted batches locally and reports provider cancellation only after its receipt', async () => {
    await stopOthers();
    const ctx = await context(),
      queued = await queueVideoBatch(ctx, request(), secret);
    const cancelBatch = vi.fn(async () => ({
      id: 'batch_cancel',
      status: 'cancelling' as const,
      inputFileId: 'file_cancel',
      outputFileId: null,
      errorFileId: null,
      counts: null
    }));
    const uploadBatch = vi.fn(async () => ({ id: 'file_cancel' }));
    const worker = new MediaBatchWorker({
      store,
      masterKey,
      workerId: 'cancellation',
      client: () => ({
        cancelBatch,
        uploadBatch,
        submitBatch: vi.fn(async () => ({
          id: 'batch_cancel',
          status: 'validating' as const,
          inputFileId: 'file_cancel',
          outputFileId: null,
          errorFileId: null,
          counts: null
        })),
        readBatch: vi.fn(async () => ({
          id: 'batch_cancel',
          status: 'cancelled' as const,
          inputFileId: 'file_cancel',
          outputFileId: null,
          errorFileId: null,
          counts: null
        })),
        readBatchResults: vi.fn()
      })
    });
    expect(await store.requestMediaBatchCancel(randomUUID(), queued.mediaBatchId)).toBeNull();
    expect(await store.requestMediaBatchCancel(userId, queued.mediaBatchId)).toMatchObject({
      status: 'queued',
      cancelRequested: true
    });
    await worker.tick();
    expect(await store.getMediaBatch(userId, queued.mediaBatchId)).toMatchObject({
      status: 'cancelled',
      providerStatus: 'not_submitted'
    });
    expect(uploadBatch).not.toHaveBeenCalled();
    expect(cancelBatch).not.toHaveBeenCalled();
    expect(await store.mediaSpendForTask(ctx.task.id)).toBe(0);
    const running = await queueVideoBatch(ctx, request(), secret);
    await worker.tick();
    await ready(running.mediaBatchId);
    await worker.tick();
    expect(await store.requestMediaBatchCancel(userId, running.mediaBatchId)).toMatchObject({
      status: 'pending',
      cancelRequested: true
    });
    await worker.tick();
    expect(await store.getMediaBatch(userId, running.mediaBatchId)).toMatchObject({
      status: 'pending',
      providerStatus: 'cancelling',
      cancelSent: true
    });
    expect(cancelBatch).toHaveBeenCalledExactlyOnceWith('batch_cancel', undefined);
    await ready(running.mediaBatchId);
    await worker.tick();
    await ready(running.mediaBatchId);
    await worker.tick();
    expect(await store.getMediaBatch(userId, running.mediaBatchId)).toMatchObject({
      status: 'cancelled',
      failed: 2,
      providerStatus: 'cancelled'
    });
    expect(cancelBatch).toHaveBeenCalledOnce();
  });
});
