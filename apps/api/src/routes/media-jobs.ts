import { z } from 'zod';
import { Id, MediaJob, MediaCharacterAsset, MediaBatch } from '@garden/contracts';
import { GardenError, decryptJson, encryptJson, unwrapDataKey } from '@garden/core';
import type { MediaJobRecord } from '@garden/data';
import { mediaJobErrorAad } from '@garden/worker/media-job-domain';
import { NativeMediaLibraryClient } from '@garden/model-gateway';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerMediaJobRoutes = (context: RouteContext): void => {
  const { app, store, masterKey, idempotent } = context;
  const responseFor = async (job: MediaJobRecord) => {
    let error: string | null = null;
    if (job.errorCiphertext) {
      const workspace = await store.getWorkspace(job.userId, job.workspaceId);
      if (workspace?.wrappedKey) {
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        error = decryptJson<{ message: string }>(
          job.errorCiphertext,
          key,
          mediaJobErrorAad(job.id)
        ).message;
      }
    }
    return MediaJob.parse({ ...job, modality: 'video', cancellationSupported: false, error });
  };
  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/media-jobs', async (request) => {
    const owner = requireUser(request.user),
      taskId = Id.parse(request.params.taskId);
    if (!(await store.getTask(owner.id, taskId)))
      throw new GardenError('task_not_found', 'Task not found', 404);
    return Promise.all((await store.listMediaJobs(owner.id, taskId)).map(responseFor));
  });
  app.get<{ Params: { id: string } }>('/v1/media/jobs/:id', async (request) => {
    const owner = requireUser(request.user);
    const job = await store.getMediaJob(owner.id, Id.parse(request.params.id));
    if (!job) throw new GardenError('media_job_not_found', 'Video job not found', 404);
    return responseFor(job);
  });
  app.patch<{ Params: { id: string } }>('/v1/media/jobs/:id', async (request, reply) => {
    const owner = requireUser(request.user);
    return idempotent(request, reply, owner, async () => {
      const input = z.object({ watching: z.boolean() }).strict().parse(request.body);
      const job = await store.setMediaJobWatching(
        owner.id,
        Id.parse(request.params.id),
        input.watching
      );
      if (!job) throw new GardenError('media_job_not_found', 'Video job not found', 404);
      return responseFor(job);
    });
  });
  app.post<{ Params: { id: string } }>('/v1/media/jobs/:id/reconcile', async (request, reply) => {
    const owner = requireUser(request.user);
    return idempotent(request, reply, owner, async () => {
      const input = z
        .object({ providerJobId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/) })
        .strict()
        .parse(request.body);
      const job = await store.reconcileMediaJob(
        owner.id,
        Id.parse(request.params.id),
        input.providerJobId
      );
      if (!job)
        throw new GardenError(
          'media_job_not_reconcilable',
          'This job is not an uncertain submission belonging to this account',
          409
        );
      return responseFor(job);
    });
  });
  const assetAad = (id: string) => `provider-media-asset:${id}`;
  const assetFor = async (asset: NonNullable<Awaited<ReturnType<typeof store.getMediaAsset>>>) => {
    const workspace = await store.getWorkspace(asset.userId, asset.workspaceId);
    if (!workspace?.wrappedKey)
      throw new GardenError('workspace_not_found', 'Workspace not found', 404);
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    const request = decryptJson<{ name: string }>(asset.requestCiphertext, key, assetAad(asset.id));
    return MediaCharacterAsset.parse({
      ...asset,
      name: request.name,
      providerAssetId:
        asset.status === 'completed' && asset.resultCiphertext
          ? decryptJson<{ id: string }>(asset.resultCiphertext, key, assetAad(asset.id)).id
          : null,
      status:
        asset.status === 'submitting' && Date.now() - Date.parse(asset.createdAt) > 180_000
          ? 'submission_uncertain'
          : asset.status
    });
  };
  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/media-assets', async (request) => {
    const owner = requireUser(request.user),
      taskId = Id.parse(request.params.taskId);
    if (!(await store.getTask(owner.id, taskId)))
      throw new GardenError('task_not_found', 'Task not found', 404);
    return Promise.all((await store.listTaskMediaAssets(owner.id, taskId)).map(assetFor));
  });
  app.post<{ Params: { id: string } }>('/v1/media/assets/:id/reconcile', async (request, reply) => {
    const owner = requireUser(request.user);
    return idempotent(request, reply, owner, async () => {
      const input = z
        .object({
          providerCharacterId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/),
          costUsd: z.number().nonnegative().max(10_000)
        })
        .strict()
        .parse(request.body);
      const asset = await store.getMediaAsset(owner.id, Id.parse(request.params.id));
      if (!asset) throw new GardenError('media_asset_not_found', 'Character asset not found', 404);
      const workspace = await store.getWorkspace(owner.id, asset.workspaceId);
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found', 404);
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const original = decryptJson<{
        name: string;
        provider?: { baseUrl: string; apiKey: string };
      }>(asset.requestCiphertext, key, assetAad(asset.id));
      if (asset.status === 'completed' && asset.resultCiphertext) {
        const receipt = decryptJson<{ id: string }>(
          asset.resultCiphertext,
          key,
          assetAad(asset.id)
        );
        if (receipt.id !== input.providerCharacterId)
          throw new GardenError(
            'media_asset_id_mismatch',
            'Use the provider ID already recorded for this asset',
            409
          );
      } else {
        if (!original.provider)
          throw new GardenError(
            'media_asset_provider_missing',
            'The original provider account is unavailable for reconciliation',
            409
          );
        await new NativeMediaLibraryClient({
          ...original.provider,
          privacyRoute: 'external'
        }).getCharacter(input.providerCharacterId);
      }
      const updated = await store.reconcileMediaAsset({
        id: asset.id,
        userId: owner.id,
        costUsd: input.costUsd,
        resultCiphertext: encryptJson(
          { id: input.providerCharacterId, name: original.name, receiptSource: 'owner' },
          key,
          assetAad(asset.id)
        )
      });
      if (!updated)
        throw new GardenError(
          'media_asset_not_reconcilable',
          'This asset no longer has an unresolved reservation',
          409
        );
      return assetFor(updated);
    });
  });
  const batchFor = async (batch: NonNullable<Awaited<ReturnType<typeof store.getMediaBatch>>>) => {
    const workspace = await store.getWorkspace(batch.userId, batch.workspaceId);
    if (!workspace?.wrappedKey)
      throw new GardenError('workspace_not_found', 'Workspace not found', 404);
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    return MediaBatch.parse({
      ...batch,
      cancellationSupported: true,
      reconciliation:
        batch.status === 'submission_uncertain'
          ? batch.inputFileId
            ? 'batch'
            : 'input_file'
          : null,
      error: batch.errorCiphertext
        ? decryptJson<{ message: string }>(
            batch.errorCiphertext,
            key,
            `provider-media-batch-error:${batch.id}`
          ).message
        : null
    });
  };
  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/media-batches', async (request) => {
    const owner = requireUser(request.user),
      taskId = Id.parse(request.params.taskId);
    if (!(await store.getTask(owner.id, taskId)))
      throw new GardenError('task_not_found', 'Task not found', 404);
    return Promise.all((await store.listMediaBatches(owner.id, taskId)).map(batchFor));
  });
  app.patch<{ Params: { id: string } }>('/v1/media/batches/:id', async (request, reply) => {
    const owner = requireUser(request.user);
    return idempotent(request, reply, owner, async () => {
      const input = z.object({ watching: z.boolean() }).strict().parse(request.body);
      const batch = await store.setMediaBatchWatching(
        owner.id,
        Id.parse(request.params.id),
        input.watching
      );
      if (!batch) throw new GardenError('media_batch_not_found', 'Video batch not found', 404);
      return batchFor(batch);
    });
  });
  app.post<{ Params: { id: string } }>(
    '/v1/media/batches/:id/reconcile',
    async (request, reply) => {
      const owner = requireUser(request.user);
      return idempotent(request, reply, owner, async () => {
        const providerId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/);
        const input = z
          .union([
            z.object({ inputFileId: providerId }).strict(),
            z.object({ providerBatchId: providerId }).strict()
          ])
          .parse(request.body);
        const batch = await store.reconcileMediaBatch(owner.id, Id.parse(request.params.id), input);
        if (!batch)
          throw new GardenError(
            'media_batch_not_reconcilable',
            'Use the expected receipt type for an uncertain batch owned by this account',
            409
          );
        return batchFor(batch);
      });
    }
  );
  app.post<{ Params: { id: string } }>('/v1/media/batches/:id/cancel', async (request, reply) => {
    const owner = requireUser(request.user);
    return idempotent(request, reply, owner, async () => {
      z.object({})
        .strict()
        .parse(request.body ?? {});
      const batch = await store.requestMediaBatchCancel(owner.id, Id.parse(request.params.id));
      if (!batch)
        throw new GardenError(
          'media_batch_not_cancellable',
          'This batch is already terminal or needs submission reconciliation first',
          409
        );
      return batchFor(batch);
    });
  });
};
