import ScrollRegion from './ScrollRegion';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectProcessHistory, ManagedProcess, ComputationSession } from '@athanor/contracts';
import { ApiError, get, post } from './client';
import { Button, ErrorNotice } from './ui';
import { processDuration, processName, processState } from './process-display';
import { ComputationCard } from './computer/Computation';

type Kind = 'processes' | 'computation';
export default function SavedProcessHistory({ endpoint }: { endpoint: string }) {
  const [kind, setKind] = useState<Kind>('processes');
  const [page, setPage] = useState<ProjectProcessHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [logError, setLogError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [logBusy, setLogBusy] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const load = useCallback(
    async (selected: Kind, cursor?: string) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError(null);
      try {
        const params = new URLSearchParams({ kind: selected });
        if (cursor) params.set('cursor', cursor);
        const result = await get<ProjectProcessHistory>(`${endpoint}/history?${params}`, {
          signal: controller.signal
        });
        if (controller.signal.aborted) return;
        setPage((previous) =>
          cursor && previous
            ? {
                ...result,
                processes: unique([...previous.processes, ...result.processes]),
                computationSessions: unique([
                  ...previous.computationSessions,
                  ...result.computationSessions
                ])
              }
            : result
        );
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [endpoint]
  );
  useEffect(() => {
    generation.current++;
    void load(kind);
    return () => {
      generation.current++;
      pending.current?.abort();
    };
  }, [kind, load]);
  const output = async (process: ManagedProcess) => {
    const at = generation.current,
      id = `${process.workspaceId}/${process.sessionId}`;
    setLogBusy(id);
    setLogError(null);
    try {
      const result = await post<{ stdout?: string; stderr?: string }>(
        `/v1/workspaces/${process.workspaceId}/processes/${encodeURIComponent(process.sessionId)}`,
        { action: 'log' }
      );
      if (at === generation.current)
        setLogs((previous) => ({
          ...previous,
          [id]: `${result.stdout ?? ''}${result.stderr ?? ''}`
        }));
    } catch (cause) {
      if (at === generation.current) setLogError(cause);
    } finally {
      if (at === generation.current) setLogBusy(null);
    }
  };
  return (
    <section aria-label="Saved process history" className="process-saved-history">
      <h3>Saved history</h3>
      <p className="process-note">
        Finished work is kept here after it leaves the recent list. Newest saved records appear
        first. Runs removed before saved history was enabled may be missing.
      </p>
      <div className="process-actions" aria-label="History category">
        {(['processes', 'computation'] as const).map((value) => (
          <Button
            key={value}
            className={kind === value ? 'primary' : ''}
            aria-pressed={kind === value}
            onClick={() => {
              if (kind !== value) {
                setPage(null);
                setLogs({});
                setLogBusy(null);
                setLogError(null);
                setKind(value);
              }
            }}
          >
            {value === 'processes' ? 'Processes' : 'Analysis sessions'}
          </Button>
        ))}
        <Button
          aria-disabled={busy}
          aria-busy={busy}
          onClick={() => {
            if (!busy) void load(kind);
          }}
        >
          Refresh history
        </Button>
      </div>
      <ErrorNotice
        error={error}
        onRetry={() =>
          void load(
            kind,
            error instanceof ApiError && (error.status === 400 || error.status === 409)
              ? undefined
              : (page?.nextCursor ?? undefined)
          )
        }
      />
      <ErrorNotice error={logError} />
      {busy && <p role="status">Reading saved history…</p>}
      {!busy && !error && page && !page.processes.length && !page.computationSessions.length && (
        <p>
          No saved {kind === 'processes' ? 'processes' : 'analysis sessions'} yet. Recent runs are
          listed above.
        </p>
      )}
      <ScrollRegion label="Saved job records">
        <div className="process-list">
          {page?.processes.map((process) => {
            const id = `${process.workspaceId}/${process.sessionId}`;
            return (
              <article key={id} className="process-card" aria-label={processName(process)}>
                <div className="process-card-heading">
                  <h4>{processName(process)}</h4>
                  <span className="process-status">
                    {processState(process).replaceAll('_', ' ')}
                  </span>
                </div>
                <p>
                  {new Date(process.startedAt).toLocaleString()} ·{' '}
                  {processDuration(process.ranForMs)}
                  {process.exitCode != null ? ` · Exit ${process.exitCode}` : ''}
                </p>
                <details className="process-details">
                  <summary>Command & details</summary>
                  <pre>
                    {Array.isArray(process.command) ? process.command.join(' ') : process.command}
                  </pre>
                  {process.commandTruncated && (
                    <p>
                      The command preview is shortened. The saved receipt retains the complete
                      command.
                    </p>
                  )}
                  {process.resources && (
                    <p>
                      Last sample: {new Date(process.resources.sampledAt).toLocaleString()} · CPU{' '}
                      {process.resources.cpuPercent == null
                        ? 'unavailable'
                        : `${Math.round(process.resources.cpuPercent)}%`}{' '}
                      · RAM {(process.resources.residentBytes / 1024 ** 2).toFixed(1)} MiB.
                    </p>
                  )}
                  {process.job?.lastExit?.reason && <p>{process.job.lastExit.reason}</p>}
                </details>
                <Button
                  aria-disabled={logBusy !== null}
                  onClick={() => {
                    if (logBusy === null) void output(process);
                  }}
                >
                  {logBusy === id ? 'Reading output…' : 'Read saved output'}
                </Button>
                {logs[id] !== undefined && (
                  <textarea
                    className="process-output"
                    rows={6}
                    readOnly
                    aria-label={`Saved output from ${processName(process)}`}
                    value={logs[id] || 'No captured output.'}
                  />
                )}
              </article>
            );
          })}
          {page?.computationSessions.map((session) => (
            <ComputationCard
              key={`${session.workspaceId}/${session.sessionId}`}
              session={session}
              busy={false}
              onControl={() => undefined}
            />
          ))}
        </div>
      </ScrollRegion>
      {page && (page.processes.length > 0 || page.computationSessions.length > 0) && (
        <Button
          aria-disabled={busy || !page.nextCursor}
          aria-busy={busy}
          onClick={() => {
            if (!busy && page.nextCursor) void load(kind, page.nextCursor);
          }}
        >
          {page.nextCursor ? 'Load earlier saved runs' : 'End of available saved history'}
        </Button>
      )}
    </section>
  );
}
function unique<T extends ManagedProcess | ComputationSession>(values: T[]): T[] {
  return [
    ...new Map(values.map((value) => [`${value.workspaceId}/${value.sessionId}`, value])).values()
  ];
}
