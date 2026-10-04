import type { ManagedProcess } from '@garden/contracts';
import { Activity } from './icons';
import {
  processActive,
  processDuration,
  processElapsed,
  processMemory,
  processName,
  processNeedsAttention
} from './process-display';
import { useVisibleClock } from './visible-clock';
import { useProcessFeed } from './process-feed';
import './runs.css';

/** What is executing on the computer, as one shared feed per list (see `process-feed.ts`). */
export function useRuns(endpoint: string | null) {
  const { list } = useProcessFeed(endpoint);
  const active = (list?.processes ?? []).filter(
    (process) => processActive(process) || processNeedsAttention(process)
  );
  return { list, active };
}

/** One line a person can read at a glance: what, for how long, and how hard it is working. */
export function runSummary(process: ManagedProcess, observedAt: string | undefined, now: number) {
  const parts = [processDuration(processElapsed(process, observedAt, now))];
  const sample = process.resources;
  if (sample?.cpuPercent !== null && sample?.cpuPercent !== undefined)
    parts.push(`CPU ${Math.round(sample.cpuPercent)}%`);
  if (sample) parts.push(processMemory(sample.residentBytes));
  const progress = process.workflow?.progress;
  if (progress) {
    const done = progress.completed + progress.cached;
    parts.push(`${done} stages done${progress.failed ? ` · ${progress.failed} failed` : ''}`);
  }
  if (processNeedsAttention(process)) parts.unshift('Needs a look');
  return parts.join(' · ');
}

export function RunRows({
  processes,
  observedAt,
  onOpen,
  limit = Infinity,
  onMore
}: {
  processes: readonly ManagedProcess[];
  observedAt: string | undefined;
  onOpen: (process: ManagedProcess) => void;
  /** Rows shown before the rest are summarised in one line. */
  limit?: number;
  onMore?: () => void;
}) {
  const now = useVisibleClock(processes.length > 0, 5_000, observedAt);
  const shown = processes.slice(0, limit);
  const rest = processes.slice(shown.length);
  const restCpu = rest.reduce((total, process) => total + (process.resources?.cpuPercent ?? 0), 0);
  const restRam = rest.reduce(
    (total, process) => total + (process.resources?.residentBytes ?? 0),
    0
  );
  return (
    <>
      {shown.map((process) => (
        <button
          type="button"
          className={`run-row${processNeedsAttention(process) ? ' needs-look' : ''}`}
          key={process.sessionId}
          onClick={() => onOpen(process)}
        >
          <Activity size={16} aria-hidden="true" />
          <span>
            <strong>{processName(process)}</strong>
            <small>{runSummary(process, observedAt, now)}</small>
          </span>
        </button>
      ))}
      {rest.length > 0 && (
        <button
          type="button"
          className="run-row run-more"
          onClick={onMore ?? (() => onOpen(rest[0]!))}
        >
          <Activity size={16} aria-hidden="true" />
          <span>
            <strong>+{rest.length} more running</strong>
            <small>
              CPU {Math.round(restCpu)}% · {processMemory(restRam)}
            </small>
          </span>
        </button>
      )}
    </>
  );
}
