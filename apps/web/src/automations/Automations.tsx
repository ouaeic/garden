import { lazy, Suspense, useState } from 'react';
import type { Task, TaskSchedule } from '@garden/contracts';
import { del, post } from '../client';
import { askWith } from '../ask/ask-bus';
import { ago, GROWTH_COLOR, GROWTH_WORD, growth, until } from '../app/derive';
import { Pause, Play, Plus, Refresh, Repeat } from '../app/icons';
import { go, openGoal } from '../app/route';
import { primaryWorkspace, refreshSoon, useGarden } from '../app/store';
import { toast } from '../app/toast';
import { rhythmText } from './rhythm';
import '../goals/lists.css';
import './automations.css';

const Editor = lazy(() =>
  import('../library/Watches').then((module) => ({ default: module.AutomationEditor }))
);

/** A one-off that has had its run: nothing to pause or resume, only what it did. */
const spent = (schedule: TaskSchedule) =>
  schedule.spec.kind === 'once' && !schedule.enabled && Boolean(schedule.lastRunAt);

/**
 * Work that starts on its own, read as a feed: what each one does, when it runs next, and how its
 * recent runs went - including the quiet ones - with every run one click from its record.
 *
 * Making one is a sentence on Home ("Every weekday at 8am, ..."); garden sets the schedule and asks
 * before it does. The form is here too, for setting the clock or the instruction by hand.
 */
export default function Automations({ section }: { section: string | null }) {
  const { bootstrap, moves } = useGarden();
  const [editing, setEditing] = useState<TaskSchedule | 'new' | null>(
    section === 'new' ? 'new' : null
  );
  if (!bootstrap) return null;
  const workspace = primaryWorkspace(bootstrap);
  const runsOf = new Map<string, Task[]>();
  for (const task of bootstrap.tasks) {
    if (!task.scheduleId) continue;
    const list = runsOf.get(task.scheduleId) ?? [];
    list.push(task);
    runsOf.set(task.scheduleId, list);
  }
  const schedules = [...bootstrap.schedules].sort(
    (a, b) =>
      Number(spent(a)) - Number(spent(b)) ||
      Number(!a.enabled) - Number(!b.enabled) ||
      Date.parse(a.nextRunAt ?? '9999') - Date.parse(b.nextRunAt ?? '9999')
  );
  const on = schedules.filter((schedule) => schedule.enabled).length;
  const start = () => {
    go({ view: 'today' });
    askWith('Every weekday at 8am, ');
  };
  return (
    <div className="list-view">
      <header className="list-head">
        <div className="list-title">
          <h1>Automations</h1>
          <span className="list-sub">
            {schedules.length
              ? `${on} on${schedules.length > on ? ` · ${schedules.length - on} paused or done` : ''}`
              : 'Work that starts on its own'}
          </span>
        </div>
        <div className="list-head-acts">
          <button type="button" className="btn small" onClick={() => setEditing('new')}>
            Set one by hand
          </button>
          <button type="button" className="btn leaf small" onClick={start}>
            <Plus /> New automation
          </button>
        </div>
      </header>
      <div className="list-body scroll">
        {schedules.length ? (
          <ul className="automations">
            {schedules.map((schedule) => (
              <AutomationCard
                key={schedule.id}
                schedule={schedule}
                runs={(runsOf.get(schedule.id) ?? []).sort(
                  (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
                )}
                total={bootstrap.scheduleRunCounts[schedule.id] ?? 0}
                moves={moves}
                onEdit={() => setEditing(schedule)}
              />
            ))}
          </ul>
        ) : (
          <div className="automations-empty">
            <Repeat />
            <h2>Say it once, and it keeps happening.</h2>
            <p>
              “Every weekday at 8am, read my inbox and draft replies to anything urgent.” “Each
              Monday, check our competitors’ pricing pages and tell me what changed.” Write it on
              Home in your own words; garden sets the schedule and asks you before it does.
            </p>
            <button type="button" className="btn leaf" onClick={start}>
              <Plus /> New automation
            </button>
          </div>
        )}
      </div>
      {editing && (
        <Suspense fallback={null}>
          <Editor
            schedule={editing === 'new' ? null : editing}
            workspace={workspace}
            onClose={() => setEditing(null)}
            onChange={refreshSoon}
          />
        </Suspense>
      )}
    </div>
  );
}

function AutomationCard({
  schedule,
  runs,
  total,
  moves,
  onEdit
}: {
  schedule: TaskSchedule;
  runs: Task[];
  total: number;
  moves: Parameters<typeof growth>[1];
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const done = spent(schedule);
  const act = async (work: () => Promise<unknown>, said: string) => {
    setBusy(true);
    try {
      await work();
      toast(said);
      refreshSoon();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };
  const last = runs[0];
  const lastState = last ? growth(last, moves) : null;
  return (
    <li
      className={`automation ${schedule.enabled ? 'is-on' : 'is-off'}`}
      data-schedule-id={schedule.id}
    >
      <div className="automation-main">
        <div className="automation-top">
          <h2>{schedule.title}</h2>
          <span className={`automation-state ${schedule.enabled ? 'is-on' : ''}`}>
            {done ? 'Done' : schedule.enabled ? 'On' : 'Paused'}
          </span>
        </div>
        <p className="automation-when">
          <Repeat aria-hidden="true" />
          <span>
            {rhythmText(schedule.spec, Boolean(schedule.trigger))}
            {schedule.trigger ? ' · also when called' : ''}
            {schedule.enabled && schedule.nextRunAt ? ` · next ${until(schedule.nextRunAt)}` : ''}
          </span>
        </p>
        {schedule.prompt && (
          <button
            type="button"
            className={`automation-prompt ${open ? 'is-open' : ''}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {schedule.prompt}
          </button>
        )}
        <div className="automation-runs">
          {runs.length ? (
            <>
              <span className="automation-runs-label">
                {total > runs.length
                  ? `${total} runs`
                  : `${runs.length} run${runs.length === 1 ? '' : 's'}`}
              </span>
              <span className="run-dots">
                {runs.slice(0, 12).map((run) => {
                  const state = growth(run, moves);
                  return (
                    <button
                      key={run.id}
                      type="button"
                      className="run-dot"
                      style={{ '--c': GROWTH_COLOR[state] } as React.CSSProperties}
                      title={`${new Date(run.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · ${GROWTH_WORD[state]}`}
                      aria-label={`Run ${ago(run.createdAt)}: ${GROWTH_WORD[state]}`}
                      onClick={() => openGoal(run.id)}
                    />
                  );
                })}
              </span>
              {last && (
                <button type="button" className="link" onClick={() => openGoal(last.id)}>
                  Last run {ago(last.createdAt)} · {GROWTH_WORD[lastState!]}
                </button>
              )}
            </>
          ) : schedule.lastRunAt ? (
            <span className="automation-runs-label">Last ran {ago(schedule.lastRunAt)}</span>
          ) : (
            <span className="automation-runs-label">Has not run yet</span>
          )}
          {schedule.lastErrorCode && (
            <span className="automation-error">Last start failed: {schedule.lastErrorCode}</span>
          )}
        </div>
      </div>
      <div className="automation-acts">
        {!done && (
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() =>
              void act(
                () => post(`/v1/schedules/${schedule.id}/run`),
                `Running “${schedule.title}” now.`
              )
            }
          >
            <Refresh /> Run now
          </button>
        )}
        {!done && (
          <button
            type="button"
            className="icon-btn"
            disabled={busy}
            aria-label={schedule.enabled ? 'Pause' : 'Resume'}
            title={schedule.enabled ? 'Pause' : 'Resume'}
            onClick={() =>
              void act(
                () => post(`/v1/schedules/${schedule.id}/${schedule.enabled ? 'pause' : 'resume'}`),
                schedule.enabled ? 'Paused.' : 'Resumed.'
              )
            }
          >
            {schedule.enabled ? <Pause /> : <Play />}
          </button>
        )}
        <button type="button" className="btn ghost small" onClick={onEdit}>
          Edit
        </button>
        {confirming ? (
          <span className="automation-confirm">
            <button
              type="button"
              className="btn danger small"
              disabled={busy}
              onClick={() =>
                void act(() => del(`/v1/schedules/${schedule.id}`), 'Removed. Its runs are kept.')
              }
            >
              Remove
            </button>
            <button type="button" className="btn ghost small" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button type="button" className="btn ghost small" onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}
