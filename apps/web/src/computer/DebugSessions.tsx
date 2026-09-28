import { lazy, Suspense, useEffect, useState } from 'react';
import type { DebugSession } from '@garden/contracts';
import { get, post } from '../client';
import { message } from './format';
const SourceInspector = lazy(() => import('./SourceInspector'));

export function DebugSessionCard({
  session,
  busy,
  onStop
}: {
  session: DebugSession;
  busy: boolean;
  onStop: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [source, setSource] = useState<DebugSession['frames'][number] | null>(null);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [sourceEdited, setSourceEdited] = useState(false);
  const active = !['terminated', 'lost'].includes(session.state) || session.cleanupPending;
  const stopping = session.state === 'stopping';
  return (
    <article className="computer-item stack">
      <div className="row between">
        <strong>{session.program.split('/').at(-1)}</strong>
        <span className="badge">
          {session.language === 'python' ? 'Python' : 'JavaScript'} · {session.state}
        </span>
      </div>
      <p className="muted">
        {session.program} · {session.cwd}
        {active ? ` · ends ${new Date(session.deadlineAt).toLocaleString()}` : ''}
      </p>
      {session.reason && session.state === 'stopped' && (
        <p role="status">
          Paused at {session.reason}. Inspection shown below belongs to stop {session.stopEpoch}.
        </p>
      )}
      {session.note && <p role="status">{session.note}</p>}
      {session.frames.length > 0 && (
        <details open>
          <summary>Call stack</summary>
          <ol className="garden-computation-files">
            {session.frames.map((frame) => (
              <li key={frame.id}>
                <code>{frame.name}</code>
                <button className="button" disabled={sourceDirty} onClick={() => setSource(frame)}>
                  {frame.path}:{frame.line}
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
      {session.excludedFrames > 0 && (
        <p className="muted">External library frames are excluded from source inspection.</p>
      )}
      {source && (
        <div className="stack">
          <Suspense fallback={<p role="status">Opening paused source…</p>}>
            <SourceInspector
              key={`${session.workspaceId}:${source.path}:${source.line}`}
              workspaceId={session.workspaceId}
              path={source.path}
              line={source.line}
              expectedHash={source.sourceHash}
              onDirtyChange={setSourceDirty}
              onSaved={async () => setSourceEdited(true)}
            />
          </Suspense>
          {sourceEdited && (
            <p role="status">
              Source saved. The paused process still uses its loaded code; restart the debugging
              task to test these edits.
            </p>
          )}
          <div>
            <button className="button" disabled={sourceDirty} onClick={() => setSource(null)}>
              Close source
            </button>
          </div>
        </div>
      )}
      {session.variables.length > 0 && (
        <details open>
          <summary>Inspected values</summary>
          <div className="garden-computation-values">
            {session.variables.map((variable, index) => (
              <div key={`${index}:${variable.name}`}>
                <code>{variable.name}</code>
                <span className="muted">{variable.type}</span>
                <pre>{variable.value}</pre>
              </div>
            ))}
          </div>
        </details>
      )}
      {session.state === 'stopped' && (
        <p className="muted">
          Ask garden to inspect values, evaluate an expression, or step through the program. Live
          value inspection and execution require approval.
        </p>
      )}
      {session.output && (
        <details>
          <summary>Program output</summary>
          <pre className="computer-log">{session.output}</pre>
        </details>
      )}
      {active && !confirm && (
        <div>
          <button className="button" disabled={busy || stopping} onClick={() => setConfirm(true)}>
            End debug session…
          </button>
        </div>
      )}
      {active && confirm && (
        <div className="computer-confirm" role="alert">
          <p>End this debug session and stop the program? In-memory state will be lost.</p>
          <div className="row">
            <button
              className="button"
              disabled={busy || stopping}
              onClick={() => setConfirm(false)}
            >
              Keep debugging
            </button>
            <button
              className="button"
              disabled={busy || stopping}
              onClick={() => {
                setConfirm(false);
                onStop();
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
export default function DebugSessions({ workspaceId }: { workspaceId: string }) {
  const [sessions, setSessions] = useState<DebugSession[]>([]);
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState(''),
    [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const base = `/v1/workspaces/${workspaceId}/debugger`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSessions([]);
    setAvailable({});
    setLoadError('');
    setActionError('');
    setBusy(null);
    async function load() {
      try {
        const result = await get<{ sessions: DebugSession[]; available: Record<string, boolean> }>(
          base,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        setSessions(result.sessions);
        setAvailable(result.available);
        setLoadError('');
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(message(error));
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
      if (timer) clearTimeout(timer);
    };
  }, [base, revision]);
  async function stop(sessionId: string) {
    setBusy(sessionId);
    setActionError('');
    try {
      await post(`${base}/${sessionId}/control`, { action: 'stop' });
      setRevision((value) => value + 1);
    } catch (error) {
      setActionError(message(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="stack">
      <div>
        <h3>Debugging</h3>
        <p className="muted">
          Task-scoped Python and JavaScript debugging. Refreshing this view reads saved inspection
          results.
        </p>
      </div>
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      {!loadError && sessions.length === 0 && (
        <p className="muted">
          No debug sessions.{' '}
          {available.python || available.javascript
            ? 'Ask garden to debug a program in this workspace.'
            : 'The native debug adapters are not available on this computer.'}
        </p>
      )}
      {sessions.map((session) => (
        <DebugSessionCard
          key={session.sessionId}
          session={session}
          busy={busy === session.sessionId}
          onStop={() => void stop(session.sessionId)}
        />
      ))}
    </section>
  );
}
