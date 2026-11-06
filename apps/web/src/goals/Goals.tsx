import { useEffect, useMemo, useState } from 'react';
import type { Task, TaskPage } from '@garden/contracts';
import { get } from '../client';
import { growth, type Growth } from '../app/derive';
import { go } from '../app/route';
import { useGarden } from '../app/store';
import GoalRow from '../today/GoalRow';
import '../today/today.css';
import './lists.css';

const FILTERS: { id: 'all' | Growth | 'finished'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'ready', label: 'Ready' },
  { id: 'finished', label: 'Accepted' },
  { id: 'failed', label: 'Stopped short' }
];
type Filter = (typeof FILTERS)[number]['id'];

const DAY = 86_400_000;
const groupOf = (task: Task, now: number) => {
  const at = Date.parse(task.completedAt ?? task.updatedAt);
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  if (at >= midnight) return 'Today';
  if (at >= midnight - DAY) return 'Yesterday';
  if (at >= midnight - 6 * DAY) return 'This week';
  if (at >= midnight - 30 * DAY) return 'This month';
  return 'Earlier';
};

/**
 * Every goal, not only the ones on Home: filtered by where it stands, found by its name, and read a
 * page at a time from the server rather than only what the first load happened to carry.
 */
export default function Goals() {
  const { bootstrap, moves } = useGarden();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [older, setOlder] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const include = filter === 'finished' || filter === 'all' ? 'all' : 'active';

  // A different reach starts again from the first page; the bootstrap holds only active goals.
  useEffect(() => {
    setOlder([]);
    setCursor(include === 'active' ? (bootstrap?.tasksCursor ?? null) : undefined);
  }, [include]);

  const loadMore = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const page = await get<TaskPage>(
        `/v1/tasks?${new URLSearchParams({
          include,
          limit: '100',
          ...(cursor ? { cursor } : {})
        })}`
      );
      setOlder((list) => [...list, ...page.tasks]);
      setCursor(page.hasMore ? page.nextCursor : null);
      setFailed('');
    } catch (cause) {
      // What the desk already holds stays listed; only the reach further back is missing.
      setFailed(cause instanceof Error ? cause.message : 'Older goals did not load.');
      setCursor(null);
    } finally {
      setBusy(false);
    }
  };
  // The first page of every goal, accepted ones included, is not in the bootstrap.
  useEffect(() => {
    if (cursor === undefined) void loadMore();
  }, [cursor]);

  const all = useMemo(() => {
    const byId = new Map<string, Task>();
    for (const task of older) byId.set(task.id, task);
    // What the desk holds is the freshest copy of anything it has.
    for (const task of bootstrap?.tasks ?? []) byId.set(task.id, task);
    return [...byId.values()]
      .filter((task) => !task.parentMissionId)
      .sort(
        (a, b) =>
          Date.parse(b.completedAt ?? b.updatedAt) - Date.parse(a.completedAt ?? a.updatedAt)
      );
  }, [older, bootstrap?.tasks]);

  const counts = useMemo(() => {
    const tally: Partial<Record<Filter, number>> = { all: 0 };
    for (const task of all) {
      if (task.scheduleId) continue;
      const state = growth(task, moves);
      const key: Filter = state === 'done' ? 'finished' : (state as Filter);
      tally[key] = (tally[key] ?? 0) + 1;
      tally.all = (tally.all ?? 0) + 1;
    }
    return tally;
  }, [all, moves]);

  const needle = query.trim().toLowerCase();
  const shown = all.filter((task) => {
    const state = growth(task, moves);
    // A schedule's runs are read on Automations unless one of them wants the owner.
    if (task.scheduleId && state !== 'needs') return false;
    if (filter === 'finished' ? state !== 'done' : filter !== 'all' && state !== filter)
      return false;
    if (filter === 'working' && state !== 'working') return false;
    return !needle || task.title.toLowerCase().includes(needle);
  });
  const now = Date.now();
  const groups: { label: string; tasks: Task[] }[] = [];
  for (const task of shown) {
    const label = groupOf(task, now);
    const last = groups.at(-1);
    if (last?.label === label) last.tasks.push(task);
    else groups.push({ label, tasks: [task] });
  }

  return (
    <div className="list-view">
      <header className="list-head">
        <div className="list-title">
          <h1>Goals</h1>
          <span className="list-sub">
            {counts.working ? `${counts.working} working` : 'Nothing working'}
            {counts.needs ? ` · ${counts.needs} need you` : ''}
          </span>
        </div>
        <input
          type="search"
          className="list-filter"
          placeholder="Find a goal"
          aria-label="Find a goal by name"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="list-chips" role="group" aria-label="Show">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              {counts[item.id] ? <span className="chip-count">{counts[item.id]}</span> : null}
            </button>
          ))}
        </div>
      </header>
      <div className="list-body scroll">
        {groups.map((group) => (
          <section key={group.label} className="list-group" aria-label={group.label}>
            <h2 className="list-group-h">{group.label}</h2>
            <ul className="goal-rows">
              {group.tasks.map((task) => (
                <GoalRow key={task.id} task={task} moves={moves} />
              ))}
            </ul>
          </section>
        ))}
        {!groups.length && !busy && (
          <div className="list-empty">
            <p>
              {needle
                ? `No goal is called anything like “${query.trim()}”.`
                : filter === 'all'
                  ? 'No goals yet.'
                  : 'None here right now.'}
            </p>
            <button type="button" className="btn" onClick={() => go({ view: 'today' })}>
              Ask for something
            </button>
          </div>
        )}
        {failed && (
          <p className="list-empty" role="alert">
            {failed}
          </p>
        )}
        {(cursor || busy) && (
          <div className="list-more">
            <button type="button" className="btn" disabled={busy} onClick={() => void loadMore()}>
              {busy ? 'Loading…' : 'Show older goals'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
