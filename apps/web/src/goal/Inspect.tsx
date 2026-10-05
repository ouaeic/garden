import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { RecordEntry, Task, TaskEvent } from '@garden/contracts';
import { get } from '../client';
import { RecordRow } from '../record/RecordRow';
import { Dialog } from '../ui';

const Trajectory = lazy(() => import('../Trajectory'));

const FILTERS = {
  everything: () => true,
  actions: (event: TaskEvent) => event.kind === 'tool_started' || event.kind === 'tool_result',
  words: (event: TaskEvent) =>
    ['user_message', 'queued_message', 'assistant_message', 'question_asked'].includes(event.kind),
  decisions: (event: TaskEvent) =>
    event.kind.startsWith('approval') || event.kind === 'question_asked',
  results: (event: TaskEvent) => ['artifact', 'preview', 'completed', 'plan'].includes(event.kind),
  spend: (event: TaskEvent) => event.kind === 'cost',
  problems: (event: TaskEvent) => event.kind === 'error' || event.kind === 'warning'
} as const;
type Filter = keyof typeof FILTERS;

const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

/**
 * Everything exactly. First what left the computer on this goal's behalf, with the key or the card
 * that allowed it; then every event in the record, as it was written, newest first.
 */
export default function Inspect({
  task,
  events,
  onBranched
}: {
  task: Task;
  events: readonly TaskEvent[];
  onBranched: (task: Task) => void;
}) {
  const [rewinding, setRewinding] = useState<TaskEvent | null>(null);
  const [outward, setOutward] = useState<RecordEntry[] | null>(null);
  const [filter, setFilter] = useState<Filter>('everything');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void get<RecordEntry[]>(`/v1/record?taskId=${task.id}`).then(setOutward, () => setOutward([]));
  }, [task.id, events.length]);
  const shown = useMemo(
    () => [...events].reverse().filter(FILTERS[filter]).slice(0, 600),
    [events, filter]
  );
  return (
    <div className="inspect">
      <section className="inspect-outward scroll" aria-labelledby="outward-title">
        <h2 id="outward-title" className="look-h">
          What it did outside your computer
        </h2>
        {outward === null ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : outward.length ? (
          <ul className="ledger">
            {outward.map((entry) => (
              <RecordRow key={entry.id} entry={entry} />
            ))}
          </ul>
        ) : (
          <p className="faint small">Nothing has left your computer for this goal.</p>
        )}
      </section>
      <section className="inspect-raw scroll" aria-labelledby="raw-title">
        <h2 id="raw-title" className="look-h">
          Everything, exactly <span className="faint">{events.length} events</span>
        </h2>
        <div className="chips" role="group" aria-label="Show">
          {(Object.keys(FILTERS) as Filter[]).map((name) => (
            <button
              key={name}
              type="button"
              className="chip"
              aria-pressed={filter === name}
              onClick={() => setFilter(name)}
            >
              {name[0]!.toUpperCase() + name.slice(1)}
            </button>
          ))}
        </div>
        <ol className="raw">
          {shown.map((event) => {
            const payload = event.payload as Record<string, unknown> | undefined;
            const tool = typeof payload?.tool === 'string' ? payload.tool : null;
            return (
              <li key={event.id} className={`raw-row is-${event.kind}`}>
                <button
                  type="button"
                  aria-expanded={open === event.id}
                  onClick={() => setOpen((at) => (at === event.id ? null : event.id))}
                >
                  <span className="raw-time">{time(event.createdAt)}</span>
                  <span className="raw-kind">{tool ?? event.kind.replace(/_/g, ' ')}</span>
                  <span className="raw-summary">{event.summary}</span>
                </button>
                {open === event.id && (
                  <>
                    {event.kind === 'user_message' && (
                      <button
                        type="button"
                        className="btn small raw-rewind"
                        onClick={() => setRewinding(event)}
                      >
                        Rewind or branch from here
                      </button>
                    )}
                    <pre className="raw-payload">
                      {JSON.stringify(event.payload ?? null, null, 2).slice(0, 12_000)}
                    </pre>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </section>
      {rewinding && (
        <Dialog title="Rewind or branch" onClose={() => setRewinding(null)} wide>
          <Suspense fallback={<div className="skeleton" style={{ height: 160 }} />}>
            <Trajectory
              task={task}
              event={rewinding}
              onCreated={(next) => {
                setRewinding(null);
                onBranched(next);
              }}
            />
          </Suspense>
        </Dialog>
      )}
    </div>
  );
}
