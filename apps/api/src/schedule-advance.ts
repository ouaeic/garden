import type { TaskScheduleSpec } from '@garden/contracts';
import { nextScheduleRun } from '@garden/core';

type WallClockSpec = Extract<TaskScheduleSpec, { timeZone: string }>;

const isWallClock = (spec: TaskScheduleSpec): spec is WallClockSpec => 'timeZone' in spec;

const wallClockFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

/**
 * The instant's local wall clock, expressed as the epoch that clock would name if it were UTC.
 * Two instants that share this value are the same reading on the wall - which is exactly what a
 * daily or cron schedule is written against, and exactly what a fall-back hour produces twice.
 */
const wallClockMs = (instant: Date, formatter: Intl.DateTimeFormat): number => {
  const parts = formatter.formatToParts(instant);
  const field = (kind: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === kind)?.value ?? '0');
  return Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second')
  );
};

const zoneOffset = (instant: Date, formatter: Intl.DateTimeFormat): number =>
  wallClockMs(instant, formatter) - instant.getTime();

/** The exact first instant carrying the later offset: it becomes a run time, so it is not rounded. */
const findTransition = (
  fromMs: number,
  toMs: number,
  offsetBefore: number,
  formatter: Intl.DateTimeFormat
): Date => {
  let low = fromMs;
  let high = toMs;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (zoneOffset(new Date(middle), formatter) > offsetBefore) high = middle;
    else low = middle;
  }
  return new Date(high);
};

const utcSpec = (spec: WallClockSpec): TaskScheduleSpec => ({ ...spec, timeZone: 'UTC' });

/**
 * Whether the spring-forward gap at `transition` swallowed a run. The skipped minutes have no
 * instant to scan, so the question is asked of the wall clock alone: UTC never jumps, so running
 * the same matcher there over the same wall-clock fields answers whether one of them was due.
 */
const runLostToGap = (
  spec: WallClockSpec,
  formatter: Intl.DateTimeFormat,
  transition: Date
): boolean => {
  const beforeWall = wallClockMs(new Date(transition.getTime() - 1_000), formatter);
  const afterWall = wallClockMs(transition, formatter);
  if (afterWall <= beforeWall) return false;
  const due = nextScheduleRun(utcSpec(spec), new Date(beforeWall));
  return due !== null && due.getTime() < afterWall;
};

/**
 * Scanning for offset changes costs an Intl format per step, so it is bounded. Daily, weekly and
 * every ordinary cron land far inside this; a yearly cron that steps over a transition keeps the
 * plain next occurrence rather than paying for a year-long scan.
 */
const maxGapScanMs = 40 * 24 * 60 * 60_000;
const gapScanStepMs = 6 * 60 * 60_000;

const runLostBetween = (
  spec: WallClockSpec,
  formatter: Intl.DateTimeFormat,
  from: Date,
  until: Date
): Date | null => {
  if (until.getTime() - from.getTime() > maxGapScanMs) return null;
  let cursor = from.getTime();
  let cursorOffset = zoneOffset(from, formatter);
  while (cursor < until.getTime()) {
    const probe = Math.min(cursor + gapScanStepMs, until.getTime());
    const probeOffset = zoneOffset(new Date(probe), formatter);
    if (probeOffset > cursorOffset) {
      const transition = findTransition(cursor, probe, cursorOffset, formatter);
      if (runLostToGap(spec, formatter, transition)) return transition;
    }
    cursor = probe;
    cursorOffset = probeOffset;
  }
  return null;
};

/**
 * The next run for a schedule that has just fired, in a zone that observes daylight saving.
 *
 * A wall-clock schedule names a reading, not an instant, and twice a year a zone breaks that
 * one-to-one. On the fall-back the named minute happens twice, so advancing from "now" finds the
 * repeat and the schedule fires a second time - once a year, per schedule, for work that is often
 * an irreversible external action. On the spring-forward the named minute never happens, and the
 * plain scan walks past the whole day without a word. Both are decided here rather than by the
 * matcher, because only the dispatcher knows which reading was just served.
 */
export const advanceScheduleRun = (
  spec: TaskScheduleSpec,
  firedFor: Date | null,
  now = new Date()
): Date | null => {
  const candidate = nextScheduleRun(spec, now);
  if (!candidate || !isWallClock(spec)) return candidate;
  const formatter = wallClockFormatter(spec.timeZone);
  let next = candidate;
  if (firedFor) {
    const firedWall = wallClockMs(firedFor, formatter);
    for (let guard = 0; guard < 4; guard += 1) {
      if (next.getTime() === firedFor.getTime()) break;
      if (wallClockMs(next, formatter) !== firedWall) break;
      const repeated = nextScheduleRun(spec, next);
      if (!repeated) return null;
      next = repeated;
    }
  }
  const lost = runLostBetween(spec, formatter, now, next);
  return lost && lost.getTime() < next.getTime() ? lost : next;
};
