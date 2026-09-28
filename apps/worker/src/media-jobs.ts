import { runtimeNow, runtimeUUID } from '@garden/core';

import { setTimeout as sleep } from 'node:timers/promises';
import { decryptJson, encryptJson, sha256, unwrapDataKey } from '@garden/core';
import { agentNotificationAad, type DataStore, type MediaJobRecord } from '@garden/data';
import { VideoClient, VideoSubmissionUncertainError } from '@garden/model-gateway';
import { AgentRunnerClient, withRunnerAbort } from './runner-client.js';
import { MediaBatchWorker } from './media-batches.js';

import { mediaJobAad, mediaJobErrorAad, type StoredVideoRequest } from './media-job-domain.js';
export interface MediaJobWorkerOptions {
  store: DataStore;
  masterKey: Buffer;
  runner: Pick<AgentRunnerClient, 'writeBytes' | 'call'>;
  workerId: string;
  onError?: (error: unknown) => void;
  client?: (request: StoredVideoRequest) => Pick<VideoClient, 'submit' | 'poll' | 'download'>;
}

function mediaEvent(job: MediaJobRecord, key: Buffer, status: string, artifactId?: string) {
  return {
    taskId: job.taskId,
    kind: artifactId ? 'artifact' : 'status',
    summary: 'Encrypted media event',
    payloadCiphertext: encryptJson(
      {
        __gardenEventVersion: 1,
        summary: artifactId ? 'Video ready' : `Video ${status.replaceAll('_', ' ')}`,
        payload: {
          mediaJobId: job.id,
          status,
          operation: job.operation,
          sourceJobId: job.sourceJobId,
          ...(artifactId ? { artifactId, path: job.outputPath, mimeType: 'video/mp4' } : {})
        }
      },
      key,
      `task-event:${job.taskId}`
    )
  };
}

/** Polling and delivery use provider HTTP calls only; they never consume an agent model turn. */
export class MediaJobWorker {
  constructor(private readonly options: MediaJobWorkerOptions) {}
  private async publishPendingDelivery(): Promise<boolean> {
    const { store, masterKey } = this.options;
    const leaseOwner = `${this.options.workerId}:media-delivery:${runtimeUUID()}`;
    const delivery = await store.leaseMediaDelivery(leaseOwner);
    if (!delivery) return false;
    try {
      const job = await store.getMediaJob(delivery.userId, delivery.jobId);
      if (!job?.artifactId) throw new Error('Media delivery has no published artifact');
      const workspace = await store.getWorkspaceById(job.workspaceId);
      if (!workspace?.wrappedKey || workspace.userId !== job.userId)
        throw new Error('Media delivery workspace is unavailable');
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      return await store.publishMediaDelivery({
        jobId: job.id,
        leaseOwner,
        payloadCiphertext: mediaEvent(job, key, 'completed', job.artifactId).payloadCiphertext,
        messageCiphertext: encryptJson(
          { message: 'Your video is ready to play and download in this task.' },
          key,
          agentNotificationAad(job.taskId)
        )
      });
    } catch (error) {
      await store.deferMediaDelivery(delivery.jobId, leaseOwner);
      throw error;
    }
  }
  private async deliverReady(): Promise<boolean> {
    try {
      return await this.publishPendingDelivery();
    } catch (error) {
      this.options.onError?.(error);
      return false;
    }
  }
  async tick(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const { store, masterKey, runner } = this.options;
    const published = await this.deliverReady();
    const leaseOwner = `${this.options.workerId}:media:${runtimeUUID()}`;
    const job = await store.leaseMediaJob(leaseOwner);
    if (!job) return published;
    const workspace = await store.getWorkspaceById(job.workspaceId);
    if (!workspace?.wrappedKey || workspace.userId !== job.userId) {
      await store.updateMediaJob({
        id: job.id,
        leaseOwner,
        status: job.status === 'submitting' ? 'submission_uncertain' : 'failed'
      });
      return true;
    }
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    const report = (status: string) => store.appendTaskEvent(mediaEvent(job, key, status));
    const fail = async (status: MediaJobRecord['status'], error: unknown) => {
      const updated = await store.updateMediaJob({
        id: job.id,
        leaseOwner,
        status,
        errorCiphertext: encryptJson(
          {
            message:
              error instanceof Error ? error.message.slice(0, 2000) : 'The video operation failed'
          },
          key,
          mediaJobErrorAad(job.id)
        ),
        nextPollSeconds: Math.min(600, 15 * 2 ** Math.min(job.attempts, 5))
      });
      if (updated && status !== job.status) await report(status);
    };
    try {
      const request = decryptJson<StoredVideoRequest>(
        job.requestCiphertext,
        key,
        mediaJobAad(job.id)
      );
      const client =
        this.options.client?.(request) ??
        new VideoClient({ ...request.provider, privacyRoute: 'external' });
      if (job.status === 'submitting') {
        try {
          const submitted = await client.submit({
            ...request.input,
            ...(signal ? { signal } : {})
          });
          const saved = await store
            .updateMediaJob({
              id: job.id,
              leaseOwner,
              status: submitted.status === 'completed' ? 'pending' : submitted.status,
              providerJobId: submitted.id,
              ...(submitted.progress === undefined ? {} : { progress: submitted.progress }),
              ...(submitted.costUsd === undefined
                ? {}
                : { costUsd: submitted.costUsd, costSource: 'provider' }),
              nextPollSeconds: 1
            })
            .catch((error) => {
              throw new VideoSubmissionUncertainError(error);
            });
          if (saved) await report(submitted.status);
        } catch (error) {
          await fail(
            error instanceof VideoSubmissionUncertainError ? 'submission_uncertain' : 'failed',
            error
          );
        }
        return true;
      }
      if (!job.providerJobId)
        throw new Error('The provider job ID is missing; reconcile the submission');
      if (job.status === 'delivering') {
        const output = await client.download(job.providerJobId, signal);
        if (!job.outputPath) throw new Error('The output path is missing');
        const storageKey = `.garden/artifacts/media-${job.id}`;
        await runner.writeBytes(job.workspaceId, job.taskId, job.outputPath, output.bytes);
        await runner.writeBytes(job.workspaceId, job.taskId, storageKey, output.bytes);
        const completed = await store.completeMediaJob({
          id: job.id,
          leaseOwner,
          nameCiphertext: encryptJson(
            { name: job.outputPath.split('/').at(-1) ?? 'Video.mp4' },
            key,
            `artifact-name:${job.workspaceId}`
          ),
          sizeBytes: output.bytes.length,
          sha256: sha256(output.bytes),
          storageKey
        });
        if (completed?.artifactId) await this.deliverReady();
        return true;
      }
      const observed = await client.poll(job.providerJobId, signal);
      const status = observed.status === 'completed' ? 'delivering' : observed.status;
      const cost = observed.costUsd ?? (observed.status === 'completed' ? request.quoteUsd : null);
      const updated = await store.updateMediaJob({
        id: job.id,
        leaseOwner,
        status,
        ...(observed.progress === undefined ? {} : { progress: observed.progress }),
        ...(cost === null || cost === undefined
          ? {}
          : { costUsd: cost, costSource: observed.costUsd === undefined ? 'quote' : 'provider' }),
        ...(observed.error
          ? {
              errorCiphertext: encryptJson(
                { message: observed.error },
                key,
                mediaJobErrorAad(job.id)
              )
            }
          : {}),
        nextPollSeconds: status === 'delivering' ? 1 : 15
      });
      if (updated && (status !== job.status || observed.progress !== job.progress))
        await report(status);
    } catch (error) {
      const deliveryExpired =
        job.status === 'delivering' &&
        runtimeNow() - Date.parse(job.createdAt) > 24 * 60 * 60 * 1000;
      await fail(
        job.status === 'submitting'
          ? 'submission_uncertain'
          : deliveryExpired
            ? 'delivery_failed'
            : job.status,
        error
      );
    }
    return true;
  }
}

export const runMediaJobLoop = async (options: {
  store: DataStore;
  masterKey: Buffer;
  runnerBaseUrl: string;
  runnerSecret: string;
  workerId: string;
  signal: AbortSignal;
  onError: (error: unknown) => void;
}): Promise<void> => {
  const worker = new MediaJobWorker({
    ...options,
    runner: new AgentRunnerClient(options.runnerBaseUrl, options.runnerSecret)
  });
  const batches = new MediaBatchWorker(options);
  let failures = 0;
  while (!options.signal.aborted) {
    let delay = 5_000;
    try {
      const batchWorked = await batches.tick(options.signal);
      const worked = await withRunnerAbort(options.signal, () => worker.tick(options.signal));
      failures = 0;
      if (worked || batchWorked) delay = 1_000;
    } catch (error) {
      if (options.signal.aborted) break;
      failures += 1;
      options.onError(error);
      delay = Math.min(60_000, 5_000 * 2 ** Math.min(failures, 4));
    }
    await sleep(delay, undefined, { signal: options.signal }).catch(() => undefined);
  }
};
