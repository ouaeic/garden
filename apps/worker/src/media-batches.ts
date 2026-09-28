import { runtimeUUID } from '@garden/core';

import { GardenError, decryptJson, encryptJson, sha256, unwrapDataKey } from '@garden/core';
import type { DataStore, MediaBatchRecord } from '@garden/data';
import {
  isNativeOpenAIEndpoint,
  NativeMediaLibraryClient,
  NativeMediaProviderRejectionError,
  NativeMediaSubmissionUncertainError,
  readVideoGenerationJob,
  mediaRecord,
  MAX_NATIVE_VIDEO_BATCH_BYTES
} from '@garden/model-gateway';
import type { ModelToolCall } from '@garden/model-gateway';
import type { InferenceCredential } from './agent-state.js';
import type { ToolContext } from './tool-dispatch.js';
import { VideoBatchControls, mediaArguments } from './media-controls.js';
import { prepareVideoGeneration } from './media-generation.js';
import { mediaJobAad, mediaJobErrorAad, type StoredVideoRequest } from './media-job-domain.js';
export const mediaBatchAad = (id: string) => `provider-media-batch:${id}`;
export const mediaBatchErrorAad = (id: string) => `provider-media-batch-error:${id}`;
export interface StoredVideoBatch {
  provider: StoredVideoRequest['provider'];
  shots: Array<{ id: string; request: StoredVideoRequest }>;
}

const nativeBatchJsonl = (request: StoredVideoBatch): string => {
  const jsonl = request.shots
    .map(({ id, request: { input } }) =>
      JSON.stringify({
        custom_id: id,
        method: 'POST',
        url: '/v1/videos',
        body: {
          model: input.model,
          prompt: input.prompt,
          seconds: String(input.duration),
          ...(input.size ? { size: input.size } : {}),
          ...(input.characters?.length ? { characters: input.characters } : {}),
          ...(input.frameImages?.[0]
            ? { input_reference: { image_url: input.frameImages[0].image } }
            : {})
        }
      })
    )
    .join('\n');
  if (Buffer.byteLength(jsonl) > MAX_NATIVE_VIDEO_BATCH_BYTES)
    throw new GardenError(
      'media_batch_too_large',
      'The combined prompts and image references exceed this batch upload limit; divide the shot list into smaller batches',
      413
    );
  return jsonl;
};
export const queueVideoBatch = async (
  context: ToolContext,
  call: ModelToolCall,
  secret: InferenceCredential
) => {
  if (!context.consequentialApproved)
    throw new GardenError(
      'media_batch_approval_required',
      'Approve this batch and its temporary provider retention first',
      409
    );
  const { action: _action, kind: _kind, ...batchArguments } = mediaArguments(call.arguments);
  const input = VideoBatchControls.parse(batchArguments);
  if (
    !isNativeOpenAIEndpoint(secret.baseUrl) ||
    secret.mediaRoutes?.video?.apiProtocol !== 'openai'
  )
    throw new GardenError(
      'media_batch_route_invalid',
      'Choose a native video route for batch rendering',
      409
    );
  const prepared = [];
  for (const [index, shot] of input.shots.entries()) {
    const { prompt, path, ...controls } = shot;
    prepared.push(
      await prepareVideoGeneration(
        context,
        {
          id: `${call.id}:${index}`,
          name: 'generate_media',
          arguments: {
            kind: 'video',
            prompt,
            ...(path ? { path } : {}),
            options: { ...controls, modelId: input.modelId, operation: 'generate' }
          }
        },
        secret
      )
    );
  }
  const id = runtimeUUID();
  for (const item of prepared) {
    // Standard native video batches use their published half-rate; an unknown quote stays unknown.
    item.request.quoteUsd = item.request.quoteUsd === null ? null : item.request.quoteUsd / 2;
    item.intent.reservationUsd = item.request.quoteUsd ?? item.intent.reservationUsd;
    item.intent.requestCiphertext = encryptJson(
      item.request,
      context.key,
      mediaJobAad(item.intent.id)
    );
  }
  const total = prepared.reduce((sum, item) => sum + item.intent.reservationUsd, 0);
  if (input.maxCostUsd !== undefined && total > input.maxCostUsd)
    throw new GardenError(
      'media_batch_limit',
      'The batch quote exceeds its approved spending limit',
      402
    );
  const stored: StoredVideoBatch = {
    provider: prepared[0]!.request.provider,
    shots: prepared.map((item) => ({ id: item.intent.id, request: item.request }))
  };
  nativeBatchJsonl(stored);
  const batch = await context.store.createMediaBatch({
    id,
    userId: context.task.userId,
    workspaceId: context.task.workspaceId,
    taskId: context.task.id,
    requestKey: `video-batch:${context.task.id}:${call.id}`,
    requestHash: sha256(JSON.stringify(call.arguments)),
    requestCiphertext: encryptJson(stored, context.key, mediaBatchAad(id)),
    retentionApproved: true,
    shots: prepared.map((item) => item.intent)
  });
  const jobs = await context.store.listMediaBatchJobs(context.task.userId, batch.id);
  return {
    mediaBatchId: batch.id,
    status: batch.status,
    reservationUsd: batch.reservationUsd,
    jobs: jobs.map((job) => ({ mediaJobId: job.id, path: job.outputPath, status: job.status })),
    instruction:
      'The reserved batch runs without model polling. Each completed shot will appear as a downloadable artifact. Provider batch processing may take up to 24 hours; garden downloads results in the background.'
  };
};
type BatchClient = Pick<
  NativeMediaLibraryClient,
  'uploadBatch' | 'submitBatch' | 'readBatch' | 'readBatchResults' | 'cancelBatch'
>;
export class MediaBatchWorker {
  constructor(
    private readonly options: {
      store: DataStore;
      masterKey: Buffer;
      workerId: string;
      client?: (request: StoredVideoBatch) => BatchClient;
    }
  ) {}
  async tick(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const { store } = this.options,
      leaseOwner = `${this.options.workerId}:batch:${runtimeUUID()}`;
    const batch = await store.leaseMediaBatch(leaseOwner);
    if (!batch) return false;
    const workspace = await store.getWorkspaceById(batch.workspaceId);
    if (!workspace?.wrappedKey || workspace.userId !== batch.userId) {
      await store.updateMediaBatch({
        id: batch.id,
        leaseOwner,
        status:
          batch.status === 'uploading' || batch.status === 'submitting'
            ? 'submission_uncertain'
            : 'failed'
      });
      return true;
    }
    const key = unwrapDataKey(workspace.wrappedKey, this.options.masterKey, workspace.id);
    const save = (
      fields: Omit<Parameters<DataStore['updateMediaBatch']>[0], 'id' | 'leaseOwner'>
    ) => store.updateMediaBatch({ id: batch.id, leaseOwner, ...fields });
    try {
      const request = decryptJson<StoredVideoBatch>(
        batch.requestCiphertext,
        key,
        mediaBatchAad(batch.id)
      );
      const client =
        this.options.client?.(request) ??
        new NativeMediaLibraryClient({ ...request.provider, privacyRoute: 'external' });
      if (
        batch.cancelRequested &&
        !batch.providerBatchId &&
        ['uploading', 'submitting'].includes(batch.status)
      ) {
        await save({
          status: 'cancelled',
          releaseUnsubmitted: true,
          providerStatus: 'not_submitted'
        });
        return true;
      }
      if (
        batch.cancelRequested &&
        !batch.cancelSent &&
        batch.providerBatchId &&
        batch.status === 'pending'
      ) {
        if (await store.markMediaBatchCancelSent(batch.id, leaseOwner)) {
          try {
            const cancelled = await client.cancelBatch(batch.providerBatchId, signal);
            await save({ status: 'pending', providerStatus: cancelled.status, nextPollSeconds: 1 });
          } catch (error) {
            await save({
              status: 'pending',
              errorCiphertext: encryptJson(
                {
                  message:
                    error instanceof Error
                      ? error.message
                      : 'Cancellation could not be confirmed; garden will keep checking the provider status'
                },
                key,
                mediaBatchErrorAad(batch.id)
              ),
              nextPollSeconds: 1
            });
          }
        }
        return true;
      }
      if (batch.status === 'uploading') {
        const jsonl = nativeBatchJsonl(request);
        const file = await client.uploadBatch({ jsonl, ...(signal ? { signal } : {}) });
        try {
          if (!(await save({ status: 'file_uploaded', inputFileId: file.id, nextPollSeconds: 1 })))
            throw new Error('The upload receipt lease expired');
        } catch (error) {
          throw new NativeMediaSubmissionUncertainError(error);
        }
        return true;
      }
      if (batch.status === 'submitting') {
        if (!batch.inputFileId) throw new Error('The persisted batch input file is missing');
        const submitted = await client.submitBatch(batch.inputFileId, signal);
        try {
          if (
            !(await save({ status: 'pending', providerBatchId: submitted.id, nextPollSeconds: 1 }))
          )
            throw new Error('The batch receipt lease expired');
        } catch (error) {
          throw new NativeMediaSubmissionUncertainError(error);
        }
        return true;
      }
      if (batch.status === 'delivering') {
        const jobs = await store.listMediaBatchJobs(batch.userId, batch.id);
        if (!jobs.length) throw new Error('The reserved batch shots are missing');
        const completed = jobs.filter((job) => job.status === 'completed').length;
        const failed = jobs.filter((job) =>
          ['failed', 'expired', 'cancelled', 'delivery_failed'].includes(job.status)
        ).length;
        await save({
          status:
            completed + failed === jobs.length
              ? batch.providerStatus === 'cancelled'
                ? 'cancelled'
                : failed === jobs.length
                  ? 'failed'
                  : 'completed'
              : 'delivering',
          completed,
          failed
        });
        return true;
      }
      if (!batch.providerBatchId) throw new Error('The batch provider ID is missing');
      const observed = await client.readBatch(batch.providerBatchId, signal);
      if (batch.inputFileId && observed.inputFileId !== batch.inputFileId)
        throw new Error('The provider returned a different batch input file');
      if (!['completed', 'failed', 'expired', 'cancelled'].includes(observed.status)) {
        await save({
          status: 'pending',
          providerStatus: observed.status,
          ...(observed.counts
            ? { completed: observed.counts.completed, failed: observed.counts.failed }
            : {}),
          nextPollSeconds: 30
        });
        return true;
      }
      const rows: unknown[] = [];
      for (const fileId of [observed.outputFileId, observed.errorFileId])
        if (fileId) rows.push(...(await client.readBatchResults(fileId, signal)));
      const byId = new Map<string, unknown>();
      for (const row of rows) {
        if (
          !mediaRecord(row) ||
          typeof row.custom_id !== 'string' ||
          byId.has(row.custom_id) ||
          !request.shots.some((shot) => shot.id === row.custom_id)
        )
          throw new Error('The provider returned mismatched or repeated batch shot IDs');
        byId.set(row.custom_id, row);
      }
      const results = request.shots.map((shot) => {
        const row = byId.get(shot.id),
          response = mediaRecord(row) && mediaRecord(row.response) ? row.response : null;
        if (response && Number(response.status_code) >= 200 && Number(response.status_code) < 300) {
          const video = readVideoGenerationJob(response.body);
          if (video.status === 'completed')
            return {
              jobId: shot.id,
              providerJobId: video.id,
              ...(video.costUsd === undefined
                ? shot.request.quoteUsd === null
                  ? {}
                  : { costUsd: shot.request.quoteUsd, costSource: 'quote' as const }
                : { costUsd: video.costUsd, costSource: 'provider' as const })
            };
        }
        return {
          jobId: shot.id,
          errorCiphertext: encryptJson(
            {
              message: `The provider batch did not complete this shot (${observed.status}). Its cost remains unresolved.`
            },
            key,
            mediaJobErrorAad(shot.id)
          )
        };
      });
      await store.assignMediaBatchResults({
        id: batch.id,
        leaseOwner,
        results,
        providerStatus: observed.status
      });
    } catch (error) {
      const submitting = batch.status === 'uploading' || batch.status === 'submitting';
      const refused = error instanceof NativeMediaProviderRejectionError;
      const status: MediaBatchRecord['status'] = submitting
        ? refused
          ? 'failed'
          : 'submission_uncertain'
        : batch.status;
      await save({
        status,
        releaseUnsubmitted: submitting && refused,
        errorCiphertext: encryptJson(
          {
            message:
              error instanceof Error
                ? error.message.slice(0, 2000)
                : 'The native video batch needs attention'
          },
          key,
          mediaBatchErrorAad(batch.id)
        ),
        nextPollSeconds: 60
      });
    }
    return true;
  }
}
