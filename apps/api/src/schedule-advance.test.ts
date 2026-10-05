import { describe, expect, test } from 'vitest';
import type { TaskScheduleSpec } from '@garden/contracts';
import { nextScheduleRun } from '@garden/core';
import { advanceScheduleRun } from './schedule-advance.js';

const newYork = 'America/New_York';

describe('advancing a schedule across a daylight-saving transition', () => {
  test('does not fire twice in the repeated fall-back hour', () => {
    const spec = { kind: 'daily', timeZone: newYork, localTime: '01:30' } as const;
    // 2026-11-01 01:30 America/New_York happens at 05:30Z (EDT) and again at 06:30Z (EST).
    const fired = new Date('2026-11-01T05:30:00.000Z');
    expect(nextScheduleRun(spec, fired)?.toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(advanceScheduleRun(spec, fired, fired)?.toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });

  test('does not fire twice for the cron form of the same reading', () => {
    const spec = { kind: 'cron', timeZone: newYork, expression: '30 1 * * *' } as const;
    const fired = new Date('2026-11-01T05:30:00.000Z');
    expect(nextScheduleRun(spec, fired)?.toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(advanceScheduleRun(spec, fired, fired)?.toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });

  test('still fires the repeated hour once when dispatch is late', () => {
    const spec = { kind: 'daily', timeZone: newYork, localTime: '01:30' } as const;
    // The run for 01:30 EDT was served late, well inside the second pass over 01:30.
    const fired = new Date('2026-11-01T05:30:00.000Z');
    expect(
      advanceScheduleRun(spec, fired, new Date('2026-11-01T06:15:00.000Z'))?.toISOString()
    ).toBe('2026-11-02T06:30:00.000Z');
  });

  test('keeps a weekly schedule on its own weekday through the fall-back', () => {
    const spec: TaskScheduleSpec = {
      kind: 'weekly',
      timeZone: newYork,
      localTime: '01:30',
      weekdays: [0]
    };
    const fired = new Date('2026-11-01T05:30:00.000Z');
    expect(advanceScheduleRun(spec, fired, fired)?.toISOString()).toBe('2026-11-08T06:30:00.000Z');
  });

  test('runs at the transition instead of dropping the skipped spring-forward hour', () => {
    const spec = { kind: 'daily', timeZone: newYork, localTime: '02:30' } as const;
    // 2026-03-08 02:30 America/New_York does not exist: 02:00 EST becomes 03:00 EDT.
    const fired = new Date('2026-03-07T07:30:00.000Z');
    expect(nextScheduleRun(spec, fired)?.toISOString()).toBe('2026-03-09T06:30:00.000Z');
    expect(advanceScheduleRun(spec, fired, fired)?.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  test('carries on normally from the run recovered out of the gap', () => {
    const spec = { kind: 'daily', timeZone: newYork, localTime: '02:30' } as const;
    const recovered = new Date('2026-03-08T07:00:00.000Z');
    expect(advanceScheduleRun(spec, recovered, recovered)?.toISOString()).toBe(
      '2026-03-09T06:30:00.000Z'
    );
  });

  test('recovers a first run that lands in the gap for a schedule just created', () => {
    const spec = { kind: 'daily', timeZone: newYork, localTime: '02:30' } as const;
    // Created the evening before the transition, so its very first occurrence never happens.
    const created = new Date('2026-03-07T23:00:00.000Z');
    expect(advanceScheduleRun(spec, null, created)?.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  test('leaves a reading the spring-forward did not skip alone', () => {
    const spec = { kind: 'daily', timeZone: newYork, localTime: '01:30' } as const;
    const fired = new Date('2026-03-07T06:30:00.000Z');
    expect(advanceScheduleRun(spec, fired, fired)?.toISOString()).toBe('2026-03-08T06:30:00.000Z');
  });

  test('agrees with the plain matcher on an ordinary day', () => {
    const spec = { kind: 'daily', timeZone: newYork, localTime: '09:15' } as const;
    const fired = new Date('2026-07-20T13:15:00.000Z');
    expect(advanceScheduleRun(spec, fired, fired)?.toISOString()).toBe(
      nextScheduleRun(spec, fired)!.toISOString()
    );
  });

  test('passes interval and one-off schedules straight through', () => {
    const now = new Date('2026-11-01T05:30:00.000Z');
    expect(
      advanceScheduleRun({ kind: 'interval', everyMinutes: 30 }, now, now)?.toISOString()
    ).toBe('2026-11-01T06:00:00.000Z');
    expect(advanceScheduleRun({ kind: 'once', runAt: now.toISOString() }, now, now)).toBeNull();
  });

  test('spends a one-off on its first run, even when it was run before its time', () => {
    const now = new Date('2026-11-01T05:30:00.000Z');
    const later = '2026-11-04T09:00:00.000Z';
    expect(advanceScheduleRun({ kind: 'once', runAt: later }, null, now)?.toISOString()).toBe(
      later
    );
    expect(advanceScheduleRun({ kind: 'once', runAt: later }, now, now)).toBeNull();
  });

  test('never returns a run at or before the moment it was asked', () => {
    const spec = { kind: 'cron', timeZone: newYork, expression: '*/30 * * * *' } as const;
    for (const iso of [
      '2026-11-01T04:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-03-08T06:30:00.000Z',
      '2026-03-08T07:00:00.000Z'
    ]) {
      const fired = new Date(iso);
      const next = advanceScheduleRun(spec, fired, fired);
      expect(next!.getTime()).toBeGreaterThan(fired.getTime());
    }
  });
});
