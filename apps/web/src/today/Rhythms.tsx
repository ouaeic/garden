import { useState } from 'react';
import type { TaskSchedule, TaskScheduleSpec } from '@garden/contracts';
import { post } from '../client';
import { refreshSoon } from '../app/store';
import { ago, until } from '../app/derive';
import { go, openGoal } from '../app/route';
import { Pause, Play, Refresh } from '../app/icons';
import { toast } from '../app/toast';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The rhythm in words: "Daily · 07:30", "Mon, Thu · 09:00", "Every 2 h". */
export function rhythmText(spec: TaskScheduleSpec, trigger?: boolean): string {
  switch (spec.kind) {
    case 'once':
      return `Once · ${new Date(spec.runAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    case 'interval':
      return spec.everyMinutes % 60
        ? `Every ${spec.everyMinutes} min`
        : `Every ${spec.everyMinutes / 60 === 1 ? 'hour' : `${spec.everyMinutes / 60} h`}`;
    case 'daily':
      return `Daily · ${spec.localTime}`;
    case 'weekly':
      return `${spec.weekdays.map((day) => DAYS[day]).join(', ')} · ${spec.localTime}`;
    case 'cron':
      return trigger ? 'When called, and on a schedule' : `Cron · ${spec.expression}`;
  }
}

/** A one-off that has had its run: nothing to pause or resume, only what it did. */
const spent = (schedule: TaskSchedule) =>
  schedule.spec.kind === 'once' && !schedule.enabled && Boolean(schedule.lastRunAt);

/** Standing work and work set for a time: what runs, when it runs next, how its last run went. */
export default function Rhythms({ schedules }: { schedules: readonly TaskSchedule[] }) {
  const repeating = schedules.filter((schedule) => schedule.spec.kind !== 'once').length;
  const once = schedules.filter(
    (schedule) => schedule.spec.kind === 'once' && !spent(schedule)
  ).length;
  const shown = [...schedules].sort(
    (a, b) =>
      Number(spent(a)) - Number(spent(b)) ||
      Date.parse(a.nextRunAt ?? '9999') - Date.parse(b.nextRunAt ?? '9999')
  );
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (schedule: TaskSchedule, action: 'run' | 'pause' | 'resume') => {
    setBusy(schedule.id);
    try {
      await post(`/v1/schedules/${schedule.id}/${action}`);
      toast(
        action === 'run'
          ? `Running “${schedule.title}” now.`
          : action === 'pause'
            ? 'Paused.'
            : 'Resumed.'
      );
      refreshSoon();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'That did not go through.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="pane rhythms" aria-labelledby="rhythms-title">
      <div className="pane-head">
        <h2 id="rhythms-title">Rhythms</h2>
        <span className="pane-tools">
          <span className="count">
            {[repeating && `${repeating} repeating`, once && `${once} set for later`]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <button
            type="button"
            className="count link"
            onClick={() => go({ view: 'computer', tab: 'rhythms', section: 'new' })}
          >
            Schedule
          </button>
        </span>
      </div>
      {schedules.length ? (
        <ul className="rhythm-list">
          {shown.map((schedule) => {
            const failing = Boolean(schedule.lastErrorCode);
            const done = spent(schedule);
            return (
              <li key={schedule.id} className="rhythm" data-enabled={schedule.enabled}>
                <span
                  className="dot"
                  style={
                    {
                      '--c': !schedule.enabled
                        ? 'var(--ink-3)'
                        : failing
                          ? 'var(--rose)'
                          : 'var(--leaf)'
                    } as React.CSSProperties
                  }
                />
                <button
                  type="button"
                  className="rhythm-main"
                  disabled={!schedule.lastTaskId}
                  onClick={() => schedule.lastTaskId && openGoal(schedule.lastTaskId)}
                >
                  <span className="rhythm-title">{schedule.title}</span>
                  <span className="rhythm-sub">
                    {failing
                      ? 'The last run did not finish. Open it to see why.'
                      : schedule.lastRunAt
                        ? `Last ran ${ago(schedule.lastRunAt)}`
                        : 'Not run yet'}
                  </span>
                </button>
                <span className="rhythm-when mono">
                  <span>{rhythmText(schedule.spec, Boolean(schedule.trigger))}</span>
                  <span className="faint">
                    {done
                      ? 'done'
                      : schedule.enabled
                        ? schedule.nextRunAt
                          ? `next ${until(schedule.nextRunAt)}`
                          : ''
                        : 'paused'}
                  </span>
                </span>
                <span className="rhythm-acts" hidden={done}>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={busy === schedule.id}
                    aria-label={`Run ${schedule.title} now`}
                    onClick={() => void act(schedule, 'run')}
                  >
                    <Refresh />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={busy === schedule.id}
                    aria-label={
                      schedule.enabled ? `Pause ${schedule.title}` : `Resume ${schedule.title}`
                    }
                    onClick={() => void act(schedule, schedule.enabled ? 'pause' : 'resume')}
                  >
                    {schedule.enabled ? <Pause /> : <Play />}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="pane-note">
          Ask for anything on a rhythm (“every Monday, check…”) or for a set time (“on Friday at
          nine…”), or schedule it yourself, and it will stand here.
        </p>
      )}
    </section>
  );
}
