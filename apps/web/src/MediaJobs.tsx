import { useEffect, useRef, useState } from 'react';
import { observeVisiblePoll } from './visible-poll';
import type { MediaJob, MediaCharacterAsset, MediaBatch, Task } from '@garden/contracts';
import { useGardenSelector } from './app/store';
import { Download, Film, RefreshCw } from './icons';
import { get, patch, post } from './client';
import { Button, ErrorNotice } from './ui';
import { money } from './model';
import MediaRecovery from './MediaRecovery';
import MediaBatches from './MediaBatches';
import { mergeMediaPoll } from './media-state';

/** Statuses that will not change unless somebody acts, so there is nothing to wait for. */
const SETTLED_JOB = new Set<MediaJob['status']>([
  'completed',
  'failed',
  'cancelled',
  'expired',
  'delivery_failed'
]);
const SETTLED_BATCH = new Set<MediaBatch['status']>(['completed', 'failed', 'cancelled']);
const SETTLED_ASSET = new Set<MediaCharacterAsset['status']>(['completed', 'failed']);

/**
 * What the desk knows about this goal's media, as one value that moves whenever a job starts,
 * lands or fails - and whenever the goal itself moves, which covers what the delivery state
 * does not count. Empty for a goal the desk does not list.
 */
const mediaWake = (tasks: readonly Task[] | undefined, taskId: string): string => {
  const task = tasks?.find((item) => item.id === taskId);
  return task
    ? `${task.status}:${task.deliveryStatus ?? 'none'}:${task.pendingDeliveryCount ?? 0}`
    : '';
};

function TaskMediaJobs({ taskId, onDelivered }: { taskId: string; onDelivered: () => void }) {
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [batches, setBatches] = useState<MediaBatch[]>([]);
  const [assets, setAssets] = useState<MediaCharacterAsset[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Held by reference: a parent that passes a new function each render would otherwise restart
  // the poll on every render, and a restarted poll reads at once - a loop, when what it calls on a
  // delivery makes the parent render again.
  const onDeliveredRef = useRef(onDelivered);
  onDeliveredRef.current = onDelivered;
  /** The deliveries already seen, so each is announced once and only after this goal opened. */
  const delivered = useRef<Set<string> | null>(null);
  const wake = useGardenSelector((state) => mediaWake(state.bootstrap?.tasks, taskId));
  useEffect(() => {
    // Until a read says otherwise, assume there may be something to follow.
    let inProgress = true;
    return observeVisiblePoll(
      async (signal) => {
        const [jobResult, assetResult, batchResult] = await Promise.allSettled([
          get<MediaJob[]>(`/v1/tasks/${taskId}/media-jobs`, { signal }),
          get<MediaCharacterAsset[]>(`/v1/tasks/${taskId}/media-assets`, {
            signal
          }),
          get<MediaBatch[]>(`/v1/tasks/${taskId}/media-batches`, { signal })
        ]);
        if (signal.aborted) return;
        inProgress =
          jobResult.status === 'rejected' ||
          assetResult.status === 'rejected' ||
          batchResult.status === 'rejected' ||
          jobResult.value.some((job) => !SETTLED_JOB.has(job.status)) ||
          assetResult.value.some((asset) => !SETTLED_ASSET.has(asset.status)) ||
          batchResult.value.some((batch) => !SETTLED_BATCH.has(batch.status));
        if (jobResult.status === 'fulfilled')
          setJobs((previous) => mergeMediaPoll(previous, jobResult.value));
        if (assetResult.status === 'fulfilled')
          setAssets((previous) => mergeMediaPoll(previous, assetResult.value));
        if (batchResult.status === 'fulfilled')
          setBatches((previous) => mergeMediaPoll(previous, batchResult.value));
        setLoadError(
          jobResult.status === 'rejected'
            ? jobResult.reason
            : assetResult.status === 'rejected'
              ? assetResult.reason
              : batchResult.status === 'rejected'
                ? batchResult.reason
                : null
        );
        if (jobResult.status === 'fulfilled') {
          const landed = jobResult.value.flatMap((job) => (job.artifactId ? [job.artifactId] : []));
          const seen = delivered.current;
          // What had landed before this goal was opened is in the record it opened with.
          if (!seen) delivered.current = new Set(landed);
          else if (landed.some((id) => !seen.has(id))) {
            for (const id of landed) seen.add(id);
            onDeliveredRef.current();
          }
        }
      },
      // Five seconds while something is generating; nothing at all once everything has settled,
      // until the desk says this goal's media or its state has moved.
      () => (inProgress ? 5000 : null),
      setLoadError
    );
  }, [taskId, wake]);
  if (!jobs.length && !assets.length && !batches.length && !error && !loadError) return null;
  return (
    <section className="garden-media-jobs" aria-label="Media generation">
      <ErrorNotice error={error} />
      <ErrorNotice error={loadError} />
      <MediaBatches
        batches={batches}
        onChange={(updated) =>
          setBatches((rows) => rows.map((row) => (row.id === updated.id ? updated : row)))
        }
      />
      {jobs.map((job) => (
        <article key={job.id} className="garden-media-job">
          <div className="row between">
            <span className="eyebrow">
              <Film size={14} />
              {job.operation === 'edit'
                ? 'Video edit'
                : job.operation === 'extend'
                  ? 'Video extension'
                  : 'Video'}
            </span>
            <span className="badge">{job.status.replaceAll('_', ' ')}</span>
          </div>
          <h3>{job.modelId}</h3>
          {job.progress !== null && job.status !== 'completed' && (
            <div className="garden-media-progress">
              <progress
                value={job.progress}
                max={100}
                aria-label="Provider-reported video progress"
              />
              <span>{job.progress}%</span>
            </div>
          )}
          {/* Generated media has no supplied caption track. */}
          {job.artifactId && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              controls
              preload="metadata"
              src={`/v1/artifacts/${job.artifactId}/content`}
              aria-label="Generated video"
            />
          )}
          <p className="muted">
            {job.costUsd !== null
              ? `${job.costSource === 'provider' ? 'Provider cost' : 'Quoted cost'} ${money(job.costUsd)}`
              : `${money(job.reservationUsd)} reserved · final cost pending`}
          </p>
          {job.error && <p role="status">{job.error}</p>}
          {job.status === 'submission_uncertain' && (
            <MediaRecovery
              busy={busy === job.id}
              onReconcile={async (providerJobId) => {
                setBusy(job.id);
                try {
                  const updated = await post<MediaJob>(`/v1/media/jobs/${job.id}/reconcile`, {
                    providerJobId
                  });
                  setJobs((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
                  setError(null);
                } catch (cause) {
                  setError(cause);
                } finally {
                  setBusy(null);
                }
              }}
            />
          )}
          <div className="row">
            {job.artifactId && (
              <a
                className="button"
                download="garden-video.mp4"
                href={`/v1/artifacts/${job.artifactId}/content`}
              >
                <Download size={15} />
                Download video
              </a>
            )}
            {!['completed', 'failed', 'cancelled', 'expired'].includes(job.status) && (
              <Button
                busy={busy === job.id}
                onClick={async () => {
                  setBusy(job.id);
                  try {
                    const updated = await patch<MediaJob>(`/v1/media/jobs/${job.id}`, {
                      watching: !job.watching
                    });
                    setJobs((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
                  } catch (cause) {
                    setError(cause);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <RefreshCw size={14} />
                {job.watching ? 'Stop watching' : 'Resume watching'}
              </Button>
            )}
          </div>
          {!['completed', 'failed', 'cancelled', 'expired'].includes(job.status) && (
            <small className="muted">
              Generation runs at the provider. Stopping updates does not cancel it or its cost.
            </small>
          )}
        </article>
      ))}
      {assets.map((asset) => (
        <article key={asset.id} className="garden-media-job">
          <div className="row between">
            <span className="eyebrow">Reusable character</span>
            <span className="badge">{asset.status.replaceAll('_', ' ')}</span>
          </div>
          <h3>{asset.name}</h3>
          <p className="muted">
            {asset.costUsd === null
              ? `${money(asset.reservationUsd)} reserved · receipt pending`
              : `Provider charge ${money(asset.costUsd)}`}
          </p>
          {asset.costUsd === null &&
            ['completed', 'submission_uncertain'].includes(asset.status) && (
              <MediaRecovery
                asset
                providerId={asset.providerAssetId ?? ''}
                busy={busy === asset.id}
                onReconcile={async (providerCharacterId, costUsd) => {
                  setBusy(asset.id);
                  try {
                    const updated = await post<MediaCharacterAsset>(
                      `/v1/media/assets/${asset.id}/reconcile`,
                      { providerCharacterId, costUsd }
                    );
                    setAssets((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
                    setError(null);
                  } catch (cause) {
                    setError(cause);
                  } finally {
                    setBusy(null);
                  }
                }}
              />
            )}
        </article>
      ))}
    </section>
  );
}

export default function MediaJobs(props: { taskId: string; onDelivered: () => void }) {
  return <TaskMediaJobs key={props.taskId} {...props} />;
}
