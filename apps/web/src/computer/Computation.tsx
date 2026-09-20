import { lazy, Suspense, useEffect, useState } from 'react';
import type { ComputationSession } from '@athanor/contracts';
import { get, post } from '../client';
import { bytes, message } from './format';
import { useVisibleClock } from '../visible-clock';
import { computationActive, processDuration, processMemory } from '../process-display';
import './computation.css';
const ComputationHistory = lazy(() => import('./ComputationHistory'));

export function ComputationCard({
  session,
  busy,
  onControl
}: {
  session: ComputationSession;
  busy: boolean;
  onControl: (action: 'interrupt' | 'stop') => void;
}) {
  const [confirmStop, setConfirmStop] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const active = computationActive(session.state);
  const clock = useVisibleClock(active, 30_000, session.createdAt);
  const sample = session.resources;
  const cell = session.latestCell;
  return (
    <article className="computation-card" aria-label={session.name}>
      <div className="row between">
        <strong>{session.name}</strong>
        <span className="badge">
          {{ python: 'Python', javascript: 'JavaScript', r: 'R' }[session.language]} ·{' '}
          {session.state}
        </span>
      </div>
      <p className="muted">
        {session.stateRetained
          ? 'Values are retained for the next cell.'
          : session.state === 'lost'
            ? 'Runtime state was lost. Earlier cells have not been replayed.'
            : 'No retained runtime state is reported.'}
        {active ? ` Session ends ${new Date(session.deadlineAt).toLocaleString()}.` : ''}
      </p>
      <p className="muted">
        {active
          ? `Running for ${processDuration(Math.max(0, clock - Date.parse(session.createdAt)))}`
          : `Started ${new Date(session.createdAt).toLocaleString()}`}
      </p>
      {sample && (
        <details>
          <summary>
            CPU {sample.cpuPercent === null ? 'pending' : `${Math.round(sample.cpuPercent)}%`} · RAM{' '}
            {processMemory(sample.residentBytes)}
          </summary>
          <p className="muted">
            Sampled {new Date(sample.sampledAt).toLocaleString()} · {sample.processCount} processes,{' '}
            {sample.threadCount} threads. CPU is averaged between samples; 100% is one core. Shared
            memory may be counted more than once.
          </p>
        </details>
      )}
      {active && sample && session.resourceState === 'unavailable' && (
        <p className="muted">
          The latest resource scan is unavailable; showing the previous sample.
        </p>
      )}
      {active && !sample && (
        <p className="muted">
          {session.resourceState === 'unavailable'
            ? 'Resource sampling is unavailable for this session.'
            : 'Waiting for a resource sample.'}
        </p>
      )}
      {session.note && <p role="status">{session.note}</p>}
      {session.variables.length > 0 && (
        <details>
          <summary>Values in memory · {session.variables.length}</summary>
          <div className="garden-computation-values">
            {session.variables.map((variable) => (
              <div key={variable.name}>
                <code>{variable.name}</code>
                <span className="muted">{variable.type}</span>
                <pre>{variable.preview ?? 'Preview unavailable'}</pre>
              </div>
            ))}
          </div>
        </details>
      )}
      {cell && (
        <details>
          <summary>Latest cell · {cell.state}</summary>
          {cell.stdout && <pre className="computer-log">{cell.stdout}</pre>}
          {cell.stderr && <pre className="computer-log">{cell.stderr}</pre>}
          {cell.error && <p className="error">{cell.error}</p>}
          {cell.result !== undefined && (
            <pre className="computer-log">
              {typeof cell.result === 'string' ? cell.result : JSON.stringify(cell.result, null, 2)}
            </pre>
          )}
          {cell.artifacts.length > 0 && (
            <ul className="garden-computation-files">
              {cell.artifacts.map((artifact) => (
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
      )}
      <button
        className="button"
        aria-expanded={showHistory}
        onClick={() => setShowHistory((value) => !value)}
      >
        {showHistory ? 'Hide execution history' : 'View execution history'}
      </button>
      {showHistory && (
        <Suspense fallback={<p role="status">Loading execution history…</p>}>
          <ComputationHistory key={session.sessionId} session={session} />
        </Suspense>
      )}
      {active && (
        <div className="row">
          {session.state === 'busy' && (
            <button className="button" disabled={busy} onClick={() => onControl('interrupt')}>
              Interrupt cell
            </button>
          )}
          <button className="button" disabled={busy} onClick={() => setConfirmStop(true)}>
            End session…
          </button>
        </div>
      )}
      {confirmStop && active && (
        <div className="computer-confirm" role="alert">
          <p>
            End this session? Values held in memory will be lost. Saved files and checkpoints remain
            available.
          </p>
          <div className="row">
            <button className="button" disabled={busy} onClick={() => setConfirmStop(false)}>
              Keep session
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setConfirmStop(false);
                onControl('stop');
              }}
            >
              End session
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export default function Computation({ workspaceId }: { workspaceId: string }) {
  const [sessions, setSessions] = useState<ComputationSession[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const base = `/v1/workspaces/${workspaceId}/computation`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await get<{ sessions: ComputationSession[] }>(base, {
          signal: controller.signal
        });
        if (controller.signal.aborted) return;
        setSessions(result.sessions);
        setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError(message(cause));
      }
      if (!controller.signal.aborted)
        timer = setTimeout(
          () => void load(),
          document.visibilityState === 'visible' ? 5000 : 30000
        );
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, revision]);
  async function control(sessionId: string, action: 'interrupt' | 'stop') {
    setBusy(sessionId);
    setError('');
    try {
      await post(`${base}/${encodeURIComponent(sessionId)}/control`, { action });
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="stack" aria-label="Computation sessions">
      <div className="row between">
        <h3>Computation sessions</h3>
        <button
          className="button"
          disabled={busy !== null}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh sessions
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {sessions.map((session) => (
        <ComputationCard
          key={session.sessionId}
          session={session}
          busy={busy === session.sessionId}
          onControl={(action) => void control(session.sessionId, action)}
        />
      ))}
      {!sessions.length && !error && (
        <p className="muted">
          No active or saved computation sessions. Sessions appear here when a task starts an
          analysis that keeps values between cells.
        </p>
      )}
    </section>
  );
}
