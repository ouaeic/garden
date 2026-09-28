import type { TaskScheduleSpec } from '@garden/contracts';

const weekdayNumbers: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

export const assertTimeZone = (timeZone: string): void => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Unknown IANA time zone: ${timeZone}`);
  }
};

const localParts = (
  date: Date,
  timeZone: string,
  formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
): { month: number; day: number; weekday: number; hour: number; minute: number } => {
  const parts = formatter.formatToParts(date);
  const value = (kind: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === kind)?.value ?? '';
  return {
    month: Number(value('month')),
    day: Number(value('day')),
    weekday: weekdayNumbers[value('weekday')] ?? -1,
    hour: Number(value('hour')),
    minute: Number(value('minute'))
  };
};

const nextMinute = (after: Date): Date => {
  const timestamp = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  return new Date(timestamp);
};

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

const months: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12
};

const weekdays: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6
};

const cronValue = (
  value: string,
  minimum: number,
  maximum: number,
  names: Record<string, number>
): number => {
  const named = names[value.toUpperCase()];
  const parsed = named ?? Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`Invalid cron value: ${value}`);
  return parsed;
};

const cronField = (
  source: string,
  minimum: number,
  maximum: number,
  names: Record<string, number> = {},
  sundayAlias = false
): CronField => {
  const values = new Set<number>();
  const addRange = (start: number, end: number, step: number) => {
    if (start > end && sundayAlias) {
      for (let value = start; value <= maximum; value += step) values.add(value === 7 ? 0 : value);
      for (let value = minimum; value <= end; value += step) values.add(value);
      return;
    }
    if (start > end) throw new Error(`Invalid descending cron range: ${start}-${end}`);
    for (let value = start; value <= end; value += step)
      values.add(sundayAlias && value === 7 ? 0 : value);
  };
  for (const part of source.split(',')) {
    if (!part) throw new Error('Cron fields cannot contain empty list items');
    const [rangeSource, stepSource, ...extra] = part.split('/');
    if (extra.length || !rangeSource) throw new Error(`Invalid cron field: ${source}`);
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (!Number.isInteger(step) || step < 1 || step > maximum - minimum + 1)
      throw new Error(`Invalid cron step: ${stepSource ?? ''}`);
    if (rangeSource === '*') {
      addRange(minimum, maximum, step);
      continue;
    }
    const range = rangeSource.split('-');
    if (range.length > 2) throw new Error(`Invalid cron range: ${rangeSource}`);
    const start = cronValue(range[0]!, minimum, maximum, names);
    const end = range.length === 2 ? cronValue(range[1]!, minimum, maximum, names) : start;
    addRange(start, end, step);
  }
  if (!values.size) throw new Error('Cron field selects no values');
  return { values, wildcard: source === '*' };
};

const parseCron = (expression: string) => {
  const parts = expression.trim().replace(/\s+/g, ' ').split(' ');
  if (parts.length !== 5)
    throw new Error('Cron expressions must contain minute, hour, day, month, and weekday');
  return {
    minute: cronField(parts[0]!, 0, 59),
    hour: cronField(parts[1]!, 0, 23),
    day: cronField(parts[2]!, 1, 31),
    month: cronField(parts[3]!, 1, 12, months),
    weekday: cronField(parts[4]!, 0, 7, weekdays, true)
  };
};

export const assertCronExpression = (expression: string): void => {
  parseCron(expression);
};

export const nextScheduleRun = (spec: TaskScheduleSpec, after = new Date()): Date | null => {
  if (!Number.isFinite(after.getTime())) throw new Error('Schedule cursor is invalid');
  if (spec.kind === 'once') {
    const runAt = new Date(spec.runAt);
    if (!Number.isFinite(runAt.getTime())) throw new Error('One-time schedule date is invalid');
    return runAt.getTime() > after.getTime() ? runAt : null;
  }
  if (spec.kind === 'interval') {
    return new Date(after.getTime() + spec.everyMinutes * 60_000);
  }

  assertTimeZone(spec.timeZone);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: spec.timeZone,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  if (spec.kind === 'cron') {
    const cron = parseCron(spec.expression);
    let cursor = nextMinute(after);
    const deadline = cursor.getTime() + 5 * 366 * 24 * 60 * 60_000;
    while (cursor.getTime() <= deadline) {
      const local = localParts(cursor, spec.timeZone, formatter);
      if (!cron.minute.values.has(local.minute)) {
        let delta = 1;
        while (delta <= 60 && !cron.minute.values.has((local.minute + delta) % 60)) delta += 1;
        cursor = new Date(cursor.getTime() + delta * 60_000);
        continue;
      }
      const dayMatches =
        (cron.day.wildcard && cron.weekday.wildcard) ||
        (cron.day.wildcard && cron.weekday.values.has(local.weekday)) ||
        (cron.weekday.wildcard && cron.day.values.has(local.day)) ||
        (!cron.day.wildcard &&
          !cron.weekday.wildcard &&
          (cron.day.values.has(local.day) || cron.weekday.values.has(local.weekday)));
      if (cron.hour.values.has(local.hour) && cron.month.values.has(local.month) && dayMatches)
        return cursor;
      cursor = new Date(cursor.getTime() + 60 * 60_000);
    }
    throw new Error('No valid cron occurrence was found within five years');
  }
  const [wantedHour, wantedMinute] = spec.localTime.split(':').map(Number) as [number, number];
  let cursor = nextMinute(after);
  // Fifteen days covers the next valid weekly occurrence even when a local wall-clock
  // minute is skipped by a daylight-saving transition.
  for (let index = 0; index < 15 * 24 * 60; index += 1) {
    const local = localParts(cursor, spec.timeZone, formatter);
    const weekdayMatches = spec.kind === 'daily' || spec.weekdays.includes(local.weekday);
    if (weekdayMatches && local.hour === wantedHour && local.minute === wantedMinute) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new Error('No valid schedule occurrence was found within fifteen days');
};
