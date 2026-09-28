import { lazy, Suspense, useState } from 'react';
import type { ComputationSession } from '@garden/contracts';
import { Dialog } from '../ui';
import { bytes } from './format';
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
            {!active && 'Last sample · '}
            CPU {sample.cpuPercent === null ? 'pending' : `${Math.round(sample.cpuPercent)}%`} · RAM{' '}
            {processMemory(sample.residentBytes)}
          </summary>
          <p className="muted">
            Sampled {new Date(sample.sampledAt).toLocaleString()} · {sample.processCount}{' '}
            {sample.processCount === 1 ? 'process' : 'processes'}, {sample.threadCount}{' '}
            {sample.threadCount === 1 ? 'thread' : 'threads'}. CPU is averaged between samples; 100%
            is one core. Shared memory may be counted more than once.
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
          <summary>
            {session.stateRetained ? 'Values in memory' : 'Recorded variables'} ·{' '}
            {session.variables.length}
          </summary>
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
        <Dialog title={`End ${session.name}?`} onClose={() => setConfirmStop(false)}>
          <p>Values held in memory will be lost. Saved files and checkpoints remain available.</p>
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
        </Dialog>
      )}
    </article>
  );
}
