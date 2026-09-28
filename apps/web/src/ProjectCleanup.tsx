import { useEffect, useRef, useState } from 'react';
import type {
  ProjectPurgePreview,
  ProjectPurgeResult,
  ProjectPurgeSelection,
  ProjectRevision
} from '@garden/contracts';
import { post } from './client';
import { bytes } from './model';
import { Button, Dialog, ErrorNotice, Spinner } from './ui';

type Receipt = ProjectPurgeResult & { revisions?: ProjectRevision[] };
export type CleanupRequest = { selection: ProjectPurgeSelection; requestId?: string };
export default function ProjectCleanup({
  projectId,
  request,
  onChanged,
  onClose
}: {
  projectId: string;
  request: CleanupRequest;
  onChanged: (revisions: ProjectRevision[]) => void;
  onClose: () => void;
}) {
  const endpoint = `/v1/projects/${projectId}/cleanup`;
  const [preview, setPreview] = useState<ProjectPurgePreview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [reading, setReading] = useState(true),
    [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null),
    [generation, setGeneration] = useState(0);
  const identity = useRef(request.requestId ?? crypto.randomUUID());
  const active = useRef(true),
    changed = useRef(onChanged),
    announced = useRef(false);
  changed.current = onChanged;
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    setReading(true);
    setError(null);
    setPreview(null);
    const read = request.requestId
      ? post<Receipt>(
          `${endpoint}/status`,
          { requestId: request.requestId },
          { signal: controller.signal }
        ).then((value) => {
          if (!controller.signal.aborted) setReceipt(value);
        })
      : post<ProjectPurgePreview>(`${endpoint}/preview`, request.selection, {
          signal: controller.signal
        }).then((value) => {
          if (!controller.signal.aborted) setPreview(value);
        });
    void read
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [endpoint, request, generation]);
  useEffect(() => {
    if (!receipt) return;
    if (receipt.state === 'removed') {
      if (!announced.current) {
        announced.current = true;
        changed.current(receipt.revisions ?? []);
      }
      return;
    }
    if (!receipt.running) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void post<Receipt>(
        `${endpoint}/status`,
        { requestId: receipt.requestId },
        { signal: controller.signal }
      )
        .then((value) => {
          if (!controller.signal.aborted) {
            setReceipt(value);
            setError(null);
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setError(cause);
            setReceipt((value) => (value ? { ...value, running: false } : value));
          }
        });
    }, 2000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, receipt]);
  const apply = async () => {
    if (applying || (!preview && !receipt)) return;
    setApplying(true);
    setError(null);
    const input = {
      selection: receipt?.selection ?? request.selection,
      digest: receipt?.digest ?? preview!.digest,
      requestId: receipt?.requestId ?? identity.current
    };
    try {
      const value = await post<Receipt>(`${endpoint}/apply`, input);
      if (active.current) setReceipt(value);
    } catch (cause) {
      // A lost acknowledgement may already have crossed the irreversible boundary.
      try {
        const value = await post<Receipt>(`${endpoint}/status`, { requestId: input.requestId });
        if (active.current) setReceipt(value);
      } catch {
        if (active.current) setError(cause);
      }
    } finally {
      if (active.current) setApplying(false);
    }
  };
  return (
    <Dialog
      title="Free project storage"
      onClose={() => {
        if (!applying) onClose();
      }}
    >
      <div className="stack project-version-archive">
        <p>
          Permanently remove the selected files. Their history and check receipts remain visible.
          These files cannot be restored from project history.
        </p>
        <ErrorNotice error={error} />
        {reading && <Spinner label="Checking files and their remaining uses…" />}
        <p className="muted">
          Managed Git repositories keep their committed history separately. Removing version files
          does not remove those Git copies.
        </p>
        {!receipt && preview && (
          <>
            <p>
              <strong>{bytes(preview.estimatedFreedBytes)} estimated space released</strong> ·{' '}
              {bytes(preview.logicalBytes)} in selected file paths
            </p>
            <ul className="project-version-archive-preview">
              {preview.items.map((item) => (
                <li key={`${item.kind}:${item.id}`}>
                  <strong>{item.title}</strong>
                  <span className="muted">
                    {item.kind === 'version'
                      ? 'Archived version'
                      : item.kind === 'update'
                        ? 'Candidate files'
                        : 'Check files and output'}{' '}
                    · {bytes(item.logicalBytes)}
                  </span>
                  {item.reasons.length ? (
                    <ul>
                      {item.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted">Ready to remove</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="muted">
              Files still needed elsewhere are retained. Shared files, sparse files and filesystem
              snapshots can make released space differ from apparent file size.
            </p>
          </>
        )}
        {receipt && (
          <div role="status" className="stack">
            {receipt.state === 'removed' ? (
              <>
                <strong>Cleanup complete</strong>
                <p>
                  {receipt.removedPaths.toLocaleString()} selected paths removed. Estimated space
                  released: {bytes(receipt.estimatedFreedBytes)}.
                </p>
              </>
            ) : receipt.running ? (
              <>
                <Spinner label="Removing the reviewed files…" />
                <p>You can close this view. Cleanup continues on the server.</p>
              </>
            ) : (
              <>
                <strong>Cleanup needs to resume</strong>
                <p>
                  {receipt.detail ??
                    'The saved selection is ready to resume. No additional files will be included.'}
                </p>
              </>
            )}
          </div>
        )}
        <div className="row">
          {!receipt && (
            <Button
              disabled={reading || applying}
              onClick={() => {
                identity.current = crypto.randomUUID();
                setGeneration((value) => value + 1);
              }}
            >
              Refresh preview
            </Button>
          )}
          <Button disabled={applying} onClick={onClose}>
            {receipt ? 'Close' : 'Cancel'}
          </Button>
          {receipt?.state !== 'removed' && !receipt?.running && (
            <Button
              className="danger"
              busy={applying}
              disabled={
                reading ||
                applying ||
                (!receipt && (!preview || preview.items.some((item) => item.reasons.length)))
              }
              onClick={() => void apply()}
            >
              {receipt ? 'Resume saved cleanup' : 'Permanently remove files'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function PendingCleanup({
  projectId,
  onOpen,
  generation = 0
}: {
  projectId: string;
  onOpen: (request: CleanupRequest) => void;
  generation?: number;
}) {
  const [pending, setPending] = useState<ProjectPurgeResult[]>([]),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    void post<ProjectPurgeResult[]>(
      `/v1/projects/${projectId}/cleanup/pending`,
      {},
      { signal: controller.signal }
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setPending(value);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [projectId, generation]);
  return (
    <>
      <ErrorNotice error={error} />
      {pending.map((value) => (
        <Button
          key={value.requestId}
          onClick={() => onOpen({ selection: value.selection, requestId: value.requestId })}
        >
          {value.running ? 'View active cleanup' : 'Resume saved cleanup'}
        </Button>
      ))}
    </>
  );
}
