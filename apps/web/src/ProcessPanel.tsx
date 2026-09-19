import { WorkflowProgress } from './WorkflowProgress';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw, Square } from 'lucide-react';
import type { ManagedProcess, ProcessList } from '@athanor/contracts';
import { get, post } from './client';
import { Button, Dialog, ErrorNotice, Spinner } from './ui';
import { useVisibleClock } from './visible-clock';
import {
  processActive,
  processDuration,
  processElapsed,
  processMemory,
  processName,
  processNeedsAttention,
  processState
} from './process-display';
import './processes.css';

export default function ProcessPanel({
  workspaceId,
  taskId,
  projectId
}: {
  workspaceId: string;
  taskId?: string;
  projectId?: string;
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
  const [historyLimit, setHistoryLimit] = useState(10);
  const clock = useVisibleClock(
    Boolean(list?.processes.some(processActive)),
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
      const result = await get<ProcessList>(endpoint, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setList(result);
      setError(null);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [endpoint]);
  useEffect(() => {
    generation.current++;
    setList(null);
    setLogs({});
    setConfirm(null);
    setBusy(null);
    setError(null);
    setShowFinished(false);
    setHistoryLimit(10);
    void refresh();
    return () => {
      generation.current++;
      request.current?.abort();
    };
  }, [refresh]);
  const refreshAfterMs = Math.max(60_000, list?.refreshAfterMs ?? 120_000);
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, refreshAfterMs);
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh, refreshAfterMs]);
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
  const rows = [...active, ...attention, ...(showFinished ? finished.slice(0, historyLimit) : [])];
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
      className="project-processes"
      aria-label={taskId || projectId ? 'Project processes' : 'Computer processes'}
    >
      <header className="process-panel-heading">
        <div>
          <h2>
            <Activity size={19} aria-hidden="true" /> Processes{' '}
            {list && <span className="process-count">{active.length} active</span>}
          </h2>
          <p>
            {taskId || projectId
              ? 'Jobs and services from this project and its branches.'
              : 'Background jobs and services on this computer.'}
          </p>
        </div>
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
          {!active.length && !attention.length && (
            <p className="process-empty">
              {finished.length
                ? 'No processes are running. Finished runs and their output are available below.'
                : list.unavailableWorkspaces
                  ? 'No processes available to display from the reachable execution roots.'
                  : 'No background processes have been reported for this project.'}
            </p>
          )}
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
                    <span className={`process-status ${processActive(process) ? 'is-active' : ''}`}>
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
                        Interactive terminal · {process.terminal.columns} × {process.terminal.rows}.
                        Standard output and errors share one stream.
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
                      <Button disabled={busy !== null} onClick={() => void act(process, 'resume')}>
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
          </div>
          {showFinished && finished.length > historyLimit && (
            <Button
              className="process-history-toggle"
              onClick={() => setHistoryLimit((value) => value + 10)}
            >
              Show earlier processes ({finished.length - historyLimit} remaining)
            </Button>
          )}
          {finished.length > 0 && (
            <Button
              className="process-history-toggle"
              aria-expanded={showFinished}
              onClick={() => {
                setShowFinished((value) => !value);
                setHistoryLimit(10);
              }}
            >
              {showFinished
                ? 'Hide finished processes'
                : `Show finished processes (${finished.length}${failed ? ` · ${failed} failed` : ''})`}
            </Button>
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
