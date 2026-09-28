import { useEffect, useState } from 'react';
import type { ComputationSession } from '@garden/contracts';
import { loadEventPage } from '../stream';
import { Button, ErrorNotice } from '../ui';
import { computationHistory, type ComputationHistoryEntry } from './computation-history';
import { bytes } from './format';

interface HistoryPage {
  entries: ComputationHistoryEntry[];
  hasMore: boolean;
  oldestSequence: number | null;
  newestSequence: number;
  eventCount: number;
}
export default function ComputationHistory({ session }: { session: ComputationSession }) {
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [cursors, setCursors] = useState([Number.MAX_SAFE_INTEGER]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const before = cursors.at(-1)!;
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setPage(null);
    setError(null);
    void loadEventPage(session.taskId, { before, limit: 200, signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        // Keep one projected page, rather than retaining unrelated tool payloads as history grows.
        setPage({
          entries: computationHistory(value.events, session.sessionId),
          hasMore: value.hasMore,
          oldestSequence: value.oldestSequence,
          newestSequence: value.nextCursor,
          eventCount: value.events.length
        });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [session.taskId, session.sessionId, before, revision]);
  const entries = page?.entries ?? [];
  function exportHistory() {
    const payload = {
      format: 'garden-execution-history-1',
      session: {
        sessionId: session.sessionId,
        taskId: session.taskId,
        workspaceId: session.workspaceId,
        language: session.language,
        cwd: session.cwd
      },
      coverage: {
        olderEventsAvailable: page?.hasMore ?? true,
        newerEventsAvailable: cursors.length > 1,
        oldestSequence: page?.oldestSequence,
        newestSequence: page?.newestSequence,
        eventCount: page?.eventCount
      },
      note: 'Execution evidence from the saved transcript. Manifests, when present, identify the interpreter and declared input snapshots taken before execution. Files were not locked; undeclared dependencies and in-memory state are not captured. This is not an environment lock or an automatic replay recipe.',
      entries
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${session.sessionId}-history.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="stack" aria-label="Execution history">
      <div className="row between">
        <strong>Execution history</strong>
        <div className="row">
          <Button disabled={busy} onClick={() => setRevision((value) => value + 1)}>
            Refresh history
          </Button>
          <Button disabled={!entries.length || busy} onClick={exportHistory}>
            Export this history page
          </Button>
        </div>
      </div>
      <p className="muted">
        Saved code and execution receipts from one page of the task history.
        {page && ` Events ${page.oldestSequence ?? 0}–${page.newestSequence}.`} Source and receipts
        on another page are shown as unavailable here.
      </p>
      <ErrorNotice error={error} />
      <nav className="row" aria-label="Execution history pages">
        {page?.hasMore && page.oldestSequence !== null && (
          <Button
            disabled={busy}
            onClick={() => setCursors((value) => [...value, page.oldestSequence!])}
          >
            Earlier history
          </Button>
        )}
        {cursors.length > 1 && (
          <>
            <Button disabled={busy} onClick={() => setCursors((value) => value.slice(0, -1))}>
              Newer history
            </Button>
            <Button disabled={busy} onClick={() => setCursors([Number.MAX_SAFE_INTEGER])}>
              Latest history
            </Button>
          </>
        )}
      </nav>
      {entries.map((entry) => (
        <details key={entry.cellId} className="computer-item">
          <summary>
            <code>{entry.cellId}</code> · {entry.receipt?.state ?? 'submitted'}
            {entry.action !== 'cell' && entry.action !== 'unknown' ? ` · ${entry.action}` : ''}
          </summary>
          {entry.source !== undefined ? (
            <pre className="computer-log">{entry.source}</pre>
          ) : (
            <p className="muted">
              {entry.action === 'checkpoint' || entry.action === 'restore'
                ? `Checkpoint path: ${entry.path ?? 'not recorded'}`
                : 'Source is outside the loaded event window or was not recorded.'}
            </p>
          )}
          {entry.receipt?.manifest && (
            <details>
              <summary>Source and input record</summary>
              {entry.receipt.manifest.runtime && (
                <p className="muted">
                  {session.language} {entry.receipt.manifest.runtime.version} ·{' '}
                  {entry.receipt.manifest.runtime.platform} ·{' '}
                  {entry.receipt.manifest.runtime.architecture}
                </p>
              )}
              {entry.receipt.manifest.sourceSha256 && (
                <p className="computer-path">
                  Source SHA-256: <code>{entry.receipt.manifest.sourceSha256}</code>
                </p>
              )}
              {entry.receipt.manifest.predecessorCellId && (
                <p className="muted">
                  Continues session state after{' '}
                  <code>{entry.receipt.manifest.predecessorCellId}</code>.
                </p>
              )}
              <p className="muted">
                Pre-execution snapshots cover the declared files below. They do not lock files or
                capture unlisted dependencies and session values.
              </p>
              {entry.receipt.manifest.inputs.length ? (
                <ul className="computer-manifest-inputs">
                  {entry.receipt.manifest.inputs.map((input, index) => (
                    <li key={`${input.path}:${index}`} className="stack">
                      <code className="computer-path">{input.path}</code>
                      {input.status === 'hashed' ? (
                        <>
                          <span className="muted">{bytes(input.bytes)}</span>
                          <code className="computer-path">{input.sha256}</code>
                        </>
                      ) : (
                        <span className="muted">
                          Hash unavailable: {input.reason.replaceAll('_', ' ')}.
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No input files were declared.</p>
              )}
            </details>
          )}
          {entry.receipt?.stdout && <pre className="computer-log">{entry.receipt.stdout}</pre>}
          {entry.receipt?.stderr && <pre className="computer-log">{entry.receipt.stderr}</pre>}
          {entry.receipt?.error && <p className="error">{entry.receipt.error}</p>}
          {entry.receipt?.result !== undefined && (
            <pre className="computer-log">{JSON.stringify(entry.receipt.result, null, 2)}</pre>
          )}
          {entry.errors.map((message, index) => (
            <p key={index} className="error">
              Attempt error: {message}
            </p>
          ))}
          {!entry.receipt && (
            <p className="muted">No execution receipt is present in the loaded history.</p>
          )}
          {Boolean(entry.receipt?.artifacts.length) && (
            <ul className="garden-computation-files">
              {entry.receipt!.artifacts.map((artifact) => (
                <li key={artifact.path}>
                  <a
                    href={`/v1/workspaces/${session.workspaceId}/download?path=${encodeURIComponent(artifact.path)}`}
                    download={artifact.path.split('/').at(-1)}
                  >
                    {artifact.path.split('/').at(-1)}
                  </a>
                  <span className="muted">{bytes(artifact.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      ))}
      {busy && <p role="status">Loading execution history…</p>}
      {!busy && !entries.length && !error && (
        <p className="muted">
          No cell receipts in the loaded event window.
          {page?.hasMore ? ' Open earlier history to look further back.' : ''}
        </p>
      )}
    </section>
  );
}
