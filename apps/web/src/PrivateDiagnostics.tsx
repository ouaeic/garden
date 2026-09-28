import { useEffect, useRef, useState } from 'react';
import type { DiagnosticCaptureStatus } from '@garden/contracts';
import { post, request } from './client';
import { bytes } from './model';
import { Button, ErrorNotice } from './ui';

type Status = { capture: DiagnosticCaptureStatus | null };
const reasons = {
  record_too_large: 'A record exceeded the recording limit.',
  storage_limit: 'The recording reached its storage limit.',
  write_failed: 'Recording storage was interrupted.',
  unsupported_record: 'A record could not be captured.'
};
export default function PrivateDiagnostics({ taskId }: { taskId: string }) {
  const endpoint = `/v1/tasks/${encodeURIComponent(taskId)}/diagnostic-capture`;
  const [open, setOpen] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [capture, setCapture] = useState<DiagnosticCaptureStatus | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false),
    [refresh, setRefresh] = useState(0);
  const newId = useRef(crypto.randomUUID()),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await request<Status>(endpoint, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setCapture(result.capture);
          setLoaded(true);
          setError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void read(), 5000);
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint, open, busy, refresh]);
  const control = async (action: 'start' | 'stop' | 'delete') => {
    if (busy || !loaded) return;
    setBusy(true);
    setError(null);
    const id = capture?.id ?? newId.current;
    try {
      const result = await post<Status>(endpoint, { id, action });
      if (mounted.current) {
        setCapture(result.capture);
        setConfirmDelete(false);
        if (action === 'delete') newId.current = crypto.randomUUID();
      }
    } catch (cause) {
      if (mounted.current) setError(cause);
      // Read the durable state after a lost acknowledgement before offering another action.
      try {
        const result = await request<Status>(endpoint);
        if (mounted.current) {
          setCapture(result.capture);
          const reconciled =
            action === 'delete'
              ? !result.capture
              : result.capture?.id === id &&
                result.capture.state === (action === 'start' ? 'recording' : 'stopped');
          if (reconciled) {
            if (action === 'delete') newId.current = crypto.randomUUID();
            setError(null);
            setConfirmDelete(false);
          }
        }
      } catch {
        if (mounted.current) setLoaded(false);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <details className="private-diagnostic" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Private recording for a difficult issue</summary>
      {open && (
        <div className="private-diagnostic-body">
          <p className="muted">
            Save prompts, model replies and tool observations encrypted on your server. Downloads
            contain private text. Nothing is uploaded automatically.
          </p>
          <p role="status">
            {!loaded
              ? 'Reading recording status…'
              : !capture
                ? 'Recording is off.'
                : `${capture.state === 'recording' ? (capture.records ? 'Recording enabled' : 'Recording enabled for the next work') : capture.state === 'failed' ? 'Recording stopped with incomplete evidence' : 'Recording stopped'} · ${capture.records} records · ${bytes(capture.bytes)} of ${bytes(capture.limitBytes)}`}
          </p>
          {capture?.reason && (
            <p>
              {reasons[capture.reason]} Your task continues normally. Download and delete this
              recording to start another.
            </p>
          )}
          <p className="muted">
            Starts with the next turn or resumed work. Stop takes effect immediately; your task
            keeps running.
          </p>
          {error != null && <ErrorNotice error={error} />}
          <div className="row">
            {loaded && (!capture || capture.state === 'stopped') && (
              <Button busy={busy} onClick={() => void control('start')}>
                {capture ? 'Record future work' : 'Record next work'}
              </Button>
            )}
            {capture?.state === 'recording' && (
              <Button busy={busy} onClick={() => void control('stop')}>
                Stop recording
              </Button>
            )}
            {capture && (
              <a
                href={`${endpoint}/${encodeURIComponent(capture.id)}/export`}
                download="garden-private-diagnostic.ndjson"
              >
                Download private recording
              </a>
            )}
            {capture && (
              <Button disabled={busy} onClick={() => setConfirmDelete(true)}>
                Delete recording…
              </Button>
            )}
            {!loaded && (
              <Button busy={busy} onClick={() => setRefresh((value) => value + 1)}>
                Retry status
              </Button>
            )}
          </div>
          {confirmDelete && (
            <div
              role="group"
              aria-label="Delete private recording"
              className="private-diagnostic-delete"
            >
              <p>
                Delete this recording and stop capturing? The conversation and its files remain
                available.
              </p>
              <div className="row">
                <Button busy={busy} onClick={() => void control('delete')}>
                  Delete recording
                </Button>
                <Button disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Keep recording
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
