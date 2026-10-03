import ScrollRegion from './ScrollRegion';
import { WorkflowProgress } from './WorkflowProgress';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, MessageSquare, RefreshCw, Square } from './icons';
import type { ComputationSession, ManagedProcess, ProcessList } from '@garden/contracts';
import { get, post } from './client';
import { Button, Dialog, ErrorNotice, Spinner } from './ui';
import { useVisibleClock } from './visible-clock';
import {
  computationActive,
  processActive,
  processDuration,
  processElapsed,
  processMemory,
  processName,
  processNeedsAttention,
  processState
} from './process-display';
import './processes.css';
const SavedProcessHistory = lazy(() => import('./SavedProcessHistory'));
const ProjectComputations = lazy(() => import('./ProjectComputations'));

export default function ProcessPanel({
  workspaceId,
  taskId,
  projectId,
  compact = false,
  visible = true,
  onOpen,
  onAsk
}: {
  workspaceId: string;
  taskId?: string;
  projectId?: string;
  compact?: boolean;
  visible?: boolean;
  onOpen?: () => void;
  /** Hands a run to the conversation as something to talk about. */
  onAsk?: (process: ManagedProcess) => void;
}) {
  const endpoint = projectId
    ? `/v1/projects/${projectId}/processes`
    : taskId
      ? `/v1/tasks/${taskId}/processes`
      : `/v1/workspaces/${workspaceId}/processes`;
  const [list, setList] = useState<ProcessList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ManagedProcess | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [showFinished, setShowFinished] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(10);
  const clock = useVisibleClock(
    visible && Boolean(list?.processes.some(processActive)),
    30_000,
    list?.observedAt
  );
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const [result, computations] = await Promise.all([
        get<ProcessList>(endpoint, { signal: controller.signal }),
        !taskId && !projectId
          ? get<{ sessions: ComputationSession[] }>(`/v1/workspaces/${workspaceId}/computation`, {
              signal: controller.signal
            }).catch(() => null)
          : Promise.resolve(undefined)
      ]);
      if (computations !== undefined) {
        result.computationSessions = computations?.sessions ?? [];
        if (!computations) result.unavailableComputationWorkspaces = 1;
      }
      if (controller.signal.aborted) return;
      setList(result);
      setError(null);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [endpoint, taskId, projectId, workspaceId]);
  useEffect(() => {
    generation.current++;
    setList(null);
    setLogs({});
    setConfirm(null);
    setBusy(null);
    setError(null);
    setShowFinished(false);
    setShowSaved(false);
    setHistoryLimit(10);
    return () => {
      generation.current++;
      request.current?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    if (visible) void refresh();
    else request.current?.abort();
  }, [refresh, visible]);
  const refreshAfterMs = Math.max(60_000, list?.refreshAfterMs ?? 120_000);
  const kernels = list?.computationSessions ?? [];
  const kernelCount = kernels.filter((session) => computationActive(session.state)).length;
  const pollAfterMs = kernels.some((session) => session.state === 'busy') ? 10_000 : refreshAfterMs;
  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, pollAfterMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh, pollAfterMs, visible]);
  const active = list?.processes.filter(processActive) ?? [];
  const attention = list?.processes.filter(processNeedsAttention) ?? [];
  const finished = (
    list?.processes.filter(
      (process) => !processActive(process) && !processNeedsAttention(process)
    ) ?? []
  ).sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || a.sessionId.localeCompare(b.sessionId)
  );
  const failed = finished.filter((process) => processState(process) === 'failed').length;
  const endedKernels = kernels.filter((session) => !computationActive(session.state));
  const rows = showFinished ? finished.slice(0, historyLimit) : [...active, ...attention];
  const key = (process: ManagedProcess) =>
    `${process.workspaceId ?? workspaceId}/${process.sessionId}`;
  const act = async (process: ManagedProcess, action: 'log' | 'kill' | 'resume') => {
    const at = generation.current,
      id = key(process);
    setBusy(id);
    setError(null);
    try {
      const base = `/v1/workspaces/${process.workspaceId ?? workspaceId}/processes/${encodeURIComponent(process.sessionId)}`;
      const workflow = action === 'resume' ? process.workflow : undefined;
      const result = await post<{ stdout?: string; stderr?: string }>(
        workflow
          ? `/v1/workspaces/${process.workspaceId ?? workspaceId}/workflows/${workflow.workflowId}/resume`
          : action === 'resume'
            ? `${base}/resume`
            : base,
        workflow ? { attempt: workflow.attempt } : action === 'resume' ? {} : { action }
      );
      if (generation.current !== at) return;
      if (action === 'log')
        setLogs((previous) => ({
          ...previous,
          [id]: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-100_000)
        }));
      else setConfirm(null);
      await refresh();
    } catch (cause) {
      if (generation.current === at) setError(cause);
    } finally {
      if (generation.current === at) setBusy(null);
    }
  };
  return (
    <section
      className={`project-processes${compact ? ' desk-card desk-processes' : ''}`}
      aria-label={
        compact ? 'Jobs card' : taskId || projectId ? 'Project processes' : 'Computer processes'
      }
    >
      <header className="process-panel-heading">
        <div>
          <h2>
            <Activity size={19} aria-hidden="true" /> {compact ? 'Processes' : 'Jobs'}{' '}
            {list && <span className="process-count">{active.length + kernelCount} active</span>}
          </h2>
          <p>
            {taskId || projectId
              ? 'Jobs, services and analysis sessions from this project and its branches.'
              : 'Jobs, services and analysis sessions on this computer.'}
          </p>
        </div>
        {compact && onOpen && (
          <Button onClick={onOpen} aria-label="Open all project processes">
            All <ArrowUpRight size={14} />
          </Button>
        )}
        <Button aria-label="Refresh processes" busy={loading} onClick={() => void refresh()}>
          <RefreshCw size={15} aria-hidden="true" />
          <span>Refresh</span>
        </Button>
      </header>
      <ErrorNotice error={error} onRetry={() => void refresh()} />
      {Boolean(error) && list && (
        <p className="process-note">
          Showing the last received status; the computer may have changed.
        </p>
      )}
      {!list && !error && <Spinner label="Reading processes…" />}
      {list?.note && <p className="process-note">{list.note}</p>}
      {list?.reachableFromOutsideThisComputer?.length ? (
        <p className="process-note">
          Reachable from outside this computer: {list.reachableFromOutsideThisComputer.join(', ')}
        </p>
      ) : null}
      {list && (
        <>
          {list.host && (
            <details className="process-capacity">
              <summary>Computer capacity & sampling</summary>
              <p>
                {list.host.logicalCpus ?? 'Unknown'} available CPU cores ·{' '}
                {processMemory(list.host.memoryBytes)} host RAM.
                {list.host.commandMemoryLimitBytes !== null
                  ? ` Command memory allowance: ${processMemory(list.host.commandMemoryLimitBytes)}.`
                  : ' Command memory allowance unavailable.'}
              </p>
              <p>
                CPU and RAM are sampled about every {Math.round(refreshAfterMs / 60_000)} minutes.
                CPU is averaged between samples; 100% represents one core. RAM is resident memory
                across the process tree; shared pages may be counted more than once. Host memory and
                disk safeguards still apply.
              </p>
            </details>
          )}
          <nav className="job-view-nav" aria-label="Job views">
            <Button
              aria-pressed={!showFinished}
              onClick={() => {
                setShowFinished(false);
                setShowSaved(false);
                setHistoryLimit(10);
              }}
            >
              Current <span>{active.length + attention.length + kernelCount}</span>
            </Button>
            <Button aria-pressed={showFinished} onClick={() => setShowFinished(true)}>
              History{' '}
              <span>
                {finished.length + endedKernels.length}
                {failed ? ` · ${failed} failed` : ''}
              </span>
            </Button>
          </nav>
          {!showFinished && !active.length && !attention.length && !kernelCount && (
            <p className="process-empty">
              {finished.length
                ? 'No jobs are running. Previous runs and their output are in History.'
                : list.unavailableWorkspaces
                  ? 'No processes available to display from the reachable execution roots.'
                  : 'No jobs are running.'}
            </p>
          )}
          {Boolean(list.unavailableComputationWorkspaces) && (
            <p role="status">Some analysis sessions could not be read. Refresh to try again.</p>
          )}
          <ScrollRegion
            label={showFinished ? 'Recent job history' : 'Current jobs'}
            resetKey={`${endpoint}/${showFinished}`}
          >
            <div className="process-list">
              {rows.map((process) => {
                const id = key(process),
                  sample = process.resources;
                const age = sample ? Math.max(0, clock - Date.parse(sample.sampledAt)) : 0;
                const stale = sample && age > refreshAfterMs * 2;
                const state = processState(process);
                const prominent = processActive(process) || processNeedsAttention(process);
                const metrics = (
                  <dl className="process-metrics">
                    <div>
                      <dt>{process.status === 'running' ? 'Running' : 'Duration'}</dt>
                      <dd>
                        {processDuration(
                          processElapsed(
                            process,
                            list.observedAt,
                            error && list.observedAt ? Date.parse(list.observedAt) : clock
                          )
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>CPU{stale ? ' · stale' : ''}</dt>
                      <dd>
                        {sample?.cpuPercent == null ? '—' : `${Math.round(sample.cpuPercent)}%`}
                      </dd>
                    </div>
                    <div>
                      <dt>RAM{stale ? ' · stale' : ''}</dt>
                      <dd>{sample ? processMemory(sample.residentBytes) : '—'}</dd>
                    </div>
                    <div>
                      <dt>Processes / threads</dt>
                      <dd>{sample ? `${sample.processCount} / ${sample.threadCount}` : '—'}</dd>
                    </div>
                  </dl>
                );
                return (
                  <article className="process-card" key={id} aria-label={processName(process)}>
                    <div className="process-card-heading">
                      <h3>{processName(process)}</h3>
                      <span
                        className={`process-status ${processActive(process) ? 'is-active' : ''}`}
                      >
                        {state.replaceAll('_', ' ')}
                      </span>
                    </div>
                    {process.workflow && <WorkflowProgress run={process.workflow} />}
                    {prominent && metrics}
                    <p className="process-timing">
                      {!prominent && `${processDuration(process.ranForMs)} · `}
                      Started{' '}
                      <time dateTime={process.startedAt}>
                        {new Date(process.startedAt).toLocaleString()}
                      </time>
                      {process.deadlineAt
                        ? ` · Deadline ${new Date(process.deadlineAt).toLocaleString()}`
                        : process.lifetime === 'job'
                          ? ' · No time limit'
                          : ''}
                      {process.exitCode != null ? ` · Exit ${process.exitCode}` : ''}
                    </p>
                    {processActive(process) && (
                      <p className="process-sample-age">
                        {sample
                          ? `Resources sampled ${processDuration(age)} ago${sample.cpuPercent === null ? ' · CPU available after the next sample' : ` · ${processDuration(sample.intervalMs ?? 0)} average`}`
                          : list.resourcesAvailable === false ||
                              process.resourceState === 'unavailable'
                            ? 'Resource sampling is unavailable on this computer.'
                            : 'Waiting for a resource sample.'}
                      </p>
                    )}
                    <details className="process-details">
                      <summary>Command & details</summary>
                      {!prominent && metrics}
                      <pre>
                        {Array.isArray(process.command)
                          ? process.command
                              .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
                              .join(' ')
                          : process.command}
                      </pre>
                      <p>
                        {process.lifetime === 'job'
                          ? 'Finite job. Completion never triggers a rerun.'
                          : process.service
                            ? 'Persistent service. Stopping also disables automatic restart.'
                            : 'Task background process.'}{' '}
                        Output: {processMemory(process.outputBytes)}.
                      </p>
                      {process.job && (
                        <p>
                          {process.job.checkpointResumable
                            ? 'Can recover through its declared checkpoint command.'
                            : 'An interrupted run needs attention; saved files remain available.'}{' '}
                          Restarts: {process.job.restarts}.
                        </p>
                      )}
                      {process.terminal && (
                        <p>
                          Interactive terminal · {process.terminal.columns} ×{' '}
                          {process.terminal.rows}. Standard output and errors share one stream.
                        </p>
                      )}
                      {process.job?.lastExit?.reason && <p>{process.job.lastExit.reason}</p>}
                      {sample?.children.length ? (
                        <ul className="process-children">
                          {sample.children.map((child) => (
                            <li key={child.pid}>
                              <code>{child.pid}</code>
                              <span>
                                {child.name} · {child.state}
                                {child.ranForMs !== undefined
                                  ? ` · ${processDuration(child.ranForMs)}`
                                  : ''}
                              </span>
                              <span>{processMemory(child.residentBytes)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </details>
                    <div className="process-actions">
                      {onAsk && (
                        <Button onClick={() => onAsk(process)}>
                          <MessageSquare size={14} aria-hidden="true" /> Ask about this
                        </Button>
                      )}
                      <Button disabled={busy !== null} onClick={() => void act(process, 'log')}>
                        Read output
                      </Button>
                      {!process.workflow &&
                        process.job?.state === 'interrupted' &&
                        process.job.checkpointResumable && (
                          <Button
                            disabled={busy !== null}
                            onClick={() => void act(process, 'resume')}
                          >
                            Resume checkpoint
                          </Button>
                        )}
                      {process.workflow?.canResume && (
                        <Button
                          disabled={busy !== null}
                          onClick={() => void act(process, 'resume')}
                        >
                          {process.workflow.state === 'completed'
                            ? 'Rerun using cache'
                            : 'Resume workflow'}
                        </Button>
                      )}
                      {['running', 'restarting', 'crash_looped', 'interrupted'].includes(state) && (
                        <Button
                          className="process-stop"
                          disabled={busy !== null}
                          onClick={() => setConfirm(process)}
                        >
                          <Square size={13} aria-hidden="true" /> Stop
                        </Button>
                      )}
                    </div>
                    {logs[id] !== undefined && (
                      <textarea
                        className="process-output"
                        readOnly
                        rows={Math.min(12, Math.max(2, (logs[id] ?? '').split('\n').length))}
                        aria-label={`Output from ${processName(process)}`}
                        value={logs[id] || 'No captured output.'}
                      />
                    )}
                  </article>
                );
              })}
              {kernels.length > 0 && (
                <Suspense fallback={<Spinner />}>
                  <ProjectComputations
                    key={endpoint}
                    sessions={
                      showFinished
                        ? endedKernels.slice(0, historyLimit)
                        : kernels.filter((session) => computationActive(session.state))
                    }
                    onChange={refresh}
                  />
                </Suspense>
              )}
            </div>
          </ScrollRegion>
          {showFinished && !finished.length && !endedKernels.length && (
            <p className="process-empty">
              No recent job history. Saved records are available below.
            </p>
          )}

          {showFinished && Math.max(finished.length, endedKernels.length) > historyLimit && (
            <Button
              className="process-history-toggle"
              onClick={() => setHistoryLimit((value) => value + 10)}
            >
              Show earlier jobs
            </Button>
          )}
          {showFinished && (
            <Button
              className="process-history-toggle"
              aria-expanded={showSaved}
              onClick={() => setShowSaved((value) => !value)}
            >
              {showSaved ? 'Hide saved history' : 'Browse saved history'}
            </Button>
          )}
          {showFinished && showSaved && (
            <Suspense fallback={<Spinner label="Loading saved history…" />}>
              <SavedProcessHistory key={endpoint} endpoint={endpoint} />
            </Suspense>
          )}
        </>
      )}
      {confirm && (
        <Dialog
          title={`Stop ${processName(confirm)}?`}
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
        >
          <p>
            This stops the process and its children. Saved files remain; unsaved computation may be
            lost.{confirm.service ? ' The service will not restart automatically.' : ''}
          </p>
          <ErrorNotice error={error} />
          <div className="dialog-actions">
            <Button disabled={busy !== null} onClick={() => setConfirm(null)}>
              Keep running
            </Button>
            <Button
              className="danger"
              busy={busy !== null}
              onClick={() => void act(confirm, 'kill')}
            >
              Stop process
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
