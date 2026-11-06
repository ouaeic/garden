import type { TaskScheduleSpec } from '@garden/contracts';

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
