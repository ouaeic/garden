import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaJob, MediaCharacterAsset, MediaBatch } from '@garden/contracts';
import { encryptJson, sha256, wrapDataKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import type { RouteContext } from '../http/server-context.js';
import { registerMediaJobRoutes } from './media-jobs.js';

describe('owner-scoped durable media controls', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
    store = new DataStore(database),
    app = Fastify();
  const masterKey = Buffer.alloc(32, 21),
    key = Buffer.alloc(32, 22);
  let ownerId = '',
    taskId = '',
    jobId = '';
  beforeAll(async () => {
    await migrateDatabase(database);
    const owner = await store.createUser({ username: 'media-owner-api', displayName: 'Owner' });
    const other = await store.createUser({ username: 'media-other-api', displayName: 'Other' });
    ownerId = owner.id;
    const workspaceId = randomUUID();
    await store.createWorkspace({
      id: workspaceId,
      userId: ownerId,
      name: 'Video',
      storageLimitBytes: 10_000_000_000,
      imageRevision: 'test',
      region: 'local',
      securityMode: 'balanced',
      wrappedKey: wrapDataKey(key, masterKey, workspaceId)
    });
    const task = await store.createTask({
      userId: ownerId,
      workspaceId,
      nameIndex: { nameTokens: 'video', openingTokens: 'make a clip' },
      titleCiphertext: encryptJson({ title: 'Video' }, key, `task-title:${workspaceId}`),
      promptCiphertext: encryptJson({ prompt: 'Make a clip' }, key, `task-prompt:${workspaceId}`),
      modelId: 'test/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      securityMode: 'balanced'
    });
    taskId = task.id;
    jobId = randomUUID();
    await store.createMediaJob({
      id: jobId,
      userId: ownerId,
      workspaceId,
      taskId,
      requestKey: `video:${taskId}`,
      requestHash: sha256('approved'),
      requestCiphertext: encryptJson(
        { apiKey: 'MUST-NOT-LEAVE-SERVER', prompt: 'PRIVATE-PROMPT' },
        key,
        `provider-media-job:${jobId}`
      ),
      modelId: 'openrouter:vendor/video',
      reservationUsd: 0.5,
      privacyRoute: 'external',
      retentionApproved: true,
      outputPath: 'workspace/clip.mp4'
    });
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      request.user = request.headers['x-owner'] === 'yes' ? owner : other;
    });
    registerMediaJobRoutes({
      app,
      store,
      masterKey,
      idempotent: async (_r: unknown, _p: unknown, _u: unknown, run: () => Promise<unknown>) =>
        run()
    } as unknown as RouteContext);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });
  it('shows public progress and reservations without provider credentials or private prompts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/media-jobs`,
      headers: { 'x-owner': 'yes' }
    });
    expect(response.statusCode, response.body).toBe(200);
    const jobs = MediaJob.array().parse(response.json());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: jobId,
      status: 'queued',
      reservationUsd: 0.5,
      cancellationSupported: false
    });
    expect(response.body).not.toContain('MUST-NOT-LEAVE-SERVER');
    expect(response.body).not.toContain('PRIVATE-PROMPT');
    expect((await app.inject({ method: 'GET', url: `/v1/media/jobs/${jobId}` })).statusCode).toBe(
      404
    );
    expect(
      (await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}/media-jobs` })).statusCode
    ).toBe(404);
  });
  it('pauses only local watching and preserves provider state and reserved spend', async () => {
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/media/jobs/${jobId}`,
          payload: { watching: false }
        })
      ).statusCode
    ).toBe(404);
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/media/jobs/${jobId}`,
      headers: { 'x-owner': 'yes' },
      payload: { watching: false }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(MediaJob.parse(response.json())).toMatchObject({
      watching: false,
      status: 'queued',
      reservationUsd: 0.5,
      cancellationSupported: false
    });
    expect((await store.usageHistory(ownerId))[0]).toMatchObject({
      state: 'reserved',
      costUsd: 0.5
    });
    expect(await store.leaseMediaJob('watching-paused')).toBeNull();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/media/jobs/${jobId}/cancel`,
          headers: { 'x-owner': 'yes' }
        })
      ).statusCode
    ).toBe(404);
  });
  it('shows retained asset receipts and settles only the matching owner invoice', async () => {
    const task = (await store.getTask(ownerId, taskId))!,
      id = randomUUID();
    await store.createMediaAsset({
      id,
      userId: ownerId,
      workspaceId: task.workspaceId,
      taskId,
      providerHash: 'account-hash',
      requestKey: `asset:${id}`,
      requestHash: 'asset-request',
      requestCiphertext: encryptJson(
        {
          name: 'Moss',
          provider: { baseUrl: 'https://api.openai.com/v1', apiKey: 'MUST-NOT-LEAVE-SERVER' }
        },
        key,
        `provider-media-asset:${id}`
      ),
      reservationUsd: 0.1,
      retentionApproved: true
    });
    await store.finishMediaAsset({
      id,
      userId: ownerId,
      status: 'completed',
      resultCiphertext: encryptJson(
        { id: 'char_moss', name: 'Moss' },
        key,
        `provider-media-asset:${id}`
      )
    });
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/media-assets`,
      headers: { 'x-owner': 'yes' }
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(MediaCharacterAsset.array().parse(listed.json())).toEqual([
      expect.objectContaining({ id, name: 'Moss', providerAssetId: 'char_moss', costUsd: null })
    ]);
    expect(listed.body).not.toContain('MUST-NOT-LEAVE-SERVER');
    expect(listed.body).not.toContain('account-hash');
    expect(
      (await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}/media-assets` })).statusCode
    ).toBe(404);
    const url = `/v1/media/assets/${id}/reconcile`,
      payload = { providerCharacterId: 'char_moss', costUsd: 0.03 };
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'x-owner': 'yes' },
          payload: { ...payload, providerCharacterId: 'different' }
        })
      ).statusCode
    ).toBe(409);
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-owner': 'yes' },
      payload
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(MediaCharacterAsset.parse(response.json())).toMatchObject({
      costUsd: 0.03,
      status: 'completed'
    });
    expect(
      (await app.inject({ method: 'POST', url, headers: { 'x-owner': 'yes' }, payload })).statusCode
    ).toBe(409);
  });
  it('keeps batch watching, cancellation requests and uncertain receipt stages distinct', async () => {
    const task = (await store.getTask(ownerId, taskId))!,
      id = randomUUID();
    const shot = {
      id: randomUUID(),
      userId: ownerId,
      workspaceId: task.workspaceId,
      taskId,
      requestKey: `batch-shot:${id}`,
      requestHash: 'shot',
      requestCiphertext: encryptJson(
        { private: 'MUST-NOT-LEAVE-SERVER' },
        key,
        `provider-media-job:${id}`
      ),
      modelId: 'native:sora-2',
      operation: 'generate' as const,
      reservationUsd: 0.4,
      privacyRoute: 'external' as const,
      retentionApproved: true,
      outputPath: 'workspace/shot.mp4'
    };
    await store.createMediaBatch({
      id,
      userId: ownerId,
      workspaceId: task.workspaceId,
      taskId,
      requestKey: `batch:${id}`,
      requestHash: 'batch',
      requestCiphertext: encryptJson(
        { apiKey: 'MUST-NOT-LEAVE-SERVER' },
        key,
        `provider-media-batch:${id}`
      ),
      retentionApproved: true,
      shots: [shot]
    });
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/media-batches`,
      headers: { 'x-owner': 'yes' }
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(MediaBatch.array().parse(listed.json())).toEqual([
      expect.objectContaining({
        id,
        status: 'queued',
        total: 1,
        cancellationSupported: true,
        cancelRequested: false
      })
    ]);
    expect(listed.body).not.toContain('MUST-NOT-LEAVE-SERVER');
    expect(
      (await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}/media-batches` })).statusCode
    ).toBe(404);
    await store.leaseMediaBatch('api-uploader');
    await database.query(
      "UPDATE provider_media_batches SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [id]
    );
    await store.leaseMediaBatch('recover');
    const reconcile = `/v1/media/batches/${id}/reconcile`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: reconcile,
          headers: { 'x-owner': 'yes' },
          payload: { inputFileId: 'file_input' }
        })
      ).statusCode
    ).toBe(200);
    await store.leaseMediaBatch('api-submitter');
    await database.query(
      "UPDATE provider_media_batches SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [id]
    );
    await store.leaseMediaBatch('recover');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: reconcile,
          headers: { 'x-owner': 'yes' },
          payload: { inputFileId: 'file_input' }
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: reconcile,
          headers: { 'x-owner': 'yes' },
          payload: { providerBatchId: 'batch_found' }
        })
      ).statusCode
    ).toBe(200);
    const stopped = await app.inject({
      method: 'PATCH',
      url: `/v1/media/batches/${id}`,
      headers: { 'x-owner': 'yes' },
      payload: { watching: false }
    });
    expect(MediaBatch.parse(stopped.json())).toMatchObject({
      watching: false,
      status: 'pending',
      cancelRequested: false
    });
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/media/batches/${id}/cancel`,
      headers: { 'x-owner': 'yes' },
      payload: {}
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(MediaBatch.parse(cancel.json())).toMatchObject({
      status: 'pending',
      cancelRequested: true
    });
  });
});
