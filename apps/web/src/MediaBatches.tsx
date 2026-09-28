import { useState } from 'react';
import type { MediaBatch } from '@garden/contracts';
import { Film, RefreshCw, Square } from 'lucide-react';
import { patch, post } from './client';
import { Button, ErrorNotice } from './ui';
import { money } from './model';
import MediaRecovery from './MediaRecovery';

export default function MediaBatches({
  batches,
  onChange
}: {
  batches: MediaBatch[];
  onChange: (batch: MediaBatch) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const act = async (id: string, operation: () => Promise<MediaBatch>) => {
    setBusy(id);
    try {
      onChange(await operation());
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <ErrorNotice error={error} />
      {batches.map((batch) => {
        const terminal = ['completed', 'failed', 'cancelled'].includes(batch.status);
        const labels: Record<string, string> = {
          queued: 'Queued',
          uploading: 'Uploading shot list',
          file_uploaded: 'Ready to submit',
          submitting: 'Submitting',
          submission_uncertain: 'Receipt needed',
          pending: 'Rendering',
          delivering: 'Delivering videos',
          completed: 'Finished',
          failed: 'Failed',
          cancelled: 'Cancelled'
        };
        return (
          <article key={batch.id} className="garden-media-job" aria-label="Video batch">
            <div className="row between">
              <span className="eyebrow">
                <Film size={14} />
                Video batch
              </span>
              <span className="badge">{labels[batch.status] ?? batch.status}</span>
            </div>
            <h3>
              {batch.total} {batch.total === 1 ? 'shot' : 'shots'}
            </h3>
            <div className="garden-media-progress">
              <progress
                value={batch.completed + batch.failed}
                max={batch.total}
                aria-label="Batch shots resolved"
              />
              <span>
                {batch.completed + batch.failed} / {batch.total}
              </span>
            </div>
            <p className="muted">
              {batch.completed} {batch.status === 'pending' ? 'rendered at the provider' : 'ready'}
              {batch.failed > 0 ? ` · ${batch.failed} failed` : ''}. Each ready video appears below
              with playback and download.
            </p>
            <p className="muted">
              {money(batch.reservationUsd)} initially reserved. Each shot shows its own final cost
              or unresolved reservation.
            </p>
            {batch.error && <p role="status">{batch.error}</p>}
            {batch.cancelRequested && !terminal && (
              <p role="status">
                {batch.providerStatus === 'cancelling'
                  ? 'The provider is cancelling this batch.'
                  : 'Cancellation requested; waiting for provider confirmation.'}{' '}
                Completed work is still billed and delivered.
              </p>
            )}
            {batch.reconciliation && (
              <MediaRecovery
                batchReceipt={batch.reconciliation}
                busy={busy === batch.id}
                onReconcile={async (id) =>
                  act(batch.id, () =>
                    post<MediaBatch>(
                      `/v1/media/batches/${batch.id}/reconcile`,
                      batch.reconciliation === 'input_file'
                        ? { inputFileId: id }
                        : { providerBatchId: id }
                    )
                  )
                }
              />
            )}
            {!terminal && (
              <>
                <div className="row">
                  <Button
                    busy={busy === batch.id}
                    onClick={() =>
                      void act(batch.id, () =>
                        patch<MediaBatch>(`/v1/media/batches/${batch.id}`, {
                          watching: !batch.watching
                        })
                      )
                    }
                  >
                    <RefreshCw size={14} />
                    {batch.watching ? 'Stop watching' : 'Resume watching'}
                  </Button>
                  {batch.cancellationSupported &&
                    !batch.reconciliation &&
                    batch.status !== 'delivering' && (
                      <Button
                        busy={busy === batch.id}
                        disabled={batch.cancelRequested && !batch.error}
                        onClick={() =>
                          void act(batch.id, () =>
                            post<MediaBatch>(`/v1/media/batches/${batch.id}/cancel`, {})
                          )
                        }
                      >
                        <Square size={13} />
                        {batch.cancelRequested ? 'Cancellation requested' : 'Cancel batch'}
                      </Button>
                    )}
                </div>
                <small className="muted">
                  Stopping updates does not cancel provider processing or charges. Provider
                  cancellation can take up to ten minutes.
                </small>
              </>
            )}
          </article>
        );
      })}
    </>
  );
}
