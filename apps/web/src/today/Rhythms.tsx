import { useState } from 'react';
import type { TaskSchedule, TaskScheduleSpec } from '@garden/contracts';
import { post } from '../client';
import { refreshSoon } from '../app/store';
import { ago, until } from '../app/derive';
import { openGoal } from '../app/route';
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

/** Standing work: what runs on its own, when it runs next, and how its last run went. */
export default function Rhythms({ schedules }: { schedules: readonly TaskSchedule[] }) {
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
        <span className="count">{schedules.length ? `${schedules.length} standing` : ''}</span>
      </div>
      {schedules.length ? (
        <ul className="rhythm-list">
          {schedules.map((schedule) => {
            const failing = Boolean(schedule.lastErrorCode);
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
                    {schedule.enabled
                      ? schedule.nextRunAt
                        ? `next ${until(schedule.nextRunAt)}`
                        : ''
                      : 'paused'}
                  </span>
                </span>
                <span className="rhythm-acts">
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
          Ask for anything on a rhythm (“every Monday, check…”) and it will stand here.
        </p>
      )}
    </section>
  );
}
