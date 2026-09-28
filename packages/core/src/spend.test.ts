import { describe, expect, it } from 'vitest';
import { GardenError } from './errors.js';
import {
  assertSpendAllowed,
  evaluateSpendCaps,
  localDayKey,
  roundUsd,
  spendWindowBounds
} from './spend.js';

const daily = (spentUsd: number, capUsd: number | null) =>
  ({ name: 'daily', spentUsd, capUsd }) as const;

describe('evaluateSpendCaps', () => {
  it('allows work that stays inside the cap', () => {
    const decision = evaluateSpendCaps({ windows: [daily(4, 10)], estimateUsd: 2 });
    expect(decision).toMatchObject({ outcome: 'allow', blockedBy: null, warnedBy: [] });
    expect(decision.windows[0]).toMatchObject({ projectedUsd: 6, warnAtUsd: 8, state: 'ok' });
  });

  it('warns once the projection reaches the soft threshold and still allows the work', () => {
    const decision = evaluateSpendCaps({ windows: [daily(7, 10)], estimateUsd: 1 });
    expect(decision.outcome).toBe('warn');
    expect(decision.warnedBy).toEqual(['daily']);
    expect(decision.blockedBy).toBeNull();
    expect(decision.reason).toBe('Spending on today is at $8.00 of the $10.00 cap.');
  });

  it('refuses work whose estimate would take the window past the hard cap', () => {
    const decision = evaluateSpendCaps({ windows: [daily(9, 10)], estimateUsd: 2 });
    expect(decision).toMatchObject({ outcome: 'deny', blockedBy: 'daily' });
    expect(decision.reason).toBe('Spending on today would reach $11.00, past the $10.00 cap.');
  });

  it('spends exactly the cap rather than stopping a cent short of it', () => {
    // Float addition of provider costs lands a hair either side of the round number, and an owner
    // who set a $10 cap means to be allowed to spend the tenth dollar.
    expect(evaluateSpendCaps({ windows: [daily(9.9, 10)], estimateUsd: 0.1 }).outcome).not.toBe(
      'deny'
    );
  });

  it('reports a cap that is already breached even when nothing new is proposed', () => {
    const decision = evaluateSpendCaps({ windows: [daily(12, 10)], estimateUsd: 0 });
    expect(decision).toMatchObject({ outcome: 'deny', blockedBy: 'daily' });
    expect(decision.reason).toBe('Spending on today has reached $12.00, past the $10.00 cap.');
  });

  it('never blocks on a window the owner left uncapped', () => {
    const decision = evaluateSpendCaps({
      windows: [daily(5_000, null), { name: 'monthly', spentUsd: 5_000, capUsd: null }],
      estimateUsd: 900
    });
    expect(decision.outcome).toBe('allow');
    expect(decision.windows.every((window) => window.warnAtUsd === null)).toBe(true);
  });

  it('names the narrowest breached window, so the owner is told what to raise', () => {
    const decision = evaluateSpendCaps({
      windows: [
        { name: 'monthly', spentUsd: 90, capUsd: 100 },
        { name: 'task', spentUsd: 1.9, capUsd: 2 },
        daily(9, 10)
      ],
      estimateUsd: 5
    });
    expect(decision.blockedBy).toBe('task');
    expect(decision.windows.map((window) => window.name)).toEqual(['task', 'daily', 'monthly']);
  });

  it('counts headroom already promised to open work without inflating what was spent', () => {
    const decision = evaluateSpendCaps({
      windows: [{ name: 'daily', spentUsd: 4, pendingUsd: 5, capUsd: 10 }],
      estimateUsd: 2
    });
    expect(decision.outcome).toBe('deny');
    expect(decision.windows[0]).toMatchObject({ spentUsd: 4, pendingUsd: 5, projectedUsd: 11 });
  });

  it('honours a soft threshold the owner moved', () => {
    const decision = evaluateSpendCaps({
      windows: [daily(5, 10)],
      estimateUsd: 0,
      warnAtPercent: 50
    });
    expect(decision.outcome).toBe('warn');
    expect(decision.windows[0]?.warnAtUsd).toBe(5);
  });

  it('refuses work whose cost could not be estimated instead of waving it through', () => {
    const decision = evaluateSpendCaps({ windows: [daily(0, 10)], estimateUsd: Number.NaN });
    expect(decision).toMatchObject({ outcome: 'deny', blockedBy: null });
    expect(decision.reason).toBe(
      'The cost of this work could not be estimated, so it was not started.'
    );
  });

  it('rounds float drift out of the reported totals', () => {
    const decision = evaluateSpendCaps({ windows: [daily(0.1, null)], estimateUsd: 0.2 });
    expect(decision.windows[0]?.projectedUsd).toBe(0.3);
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
  });
});

describe('assertSpendAllowed', () => {
  it('passes an allowed decision straight through', () => {
    const decision = evaluateSpendCaps({ windows: [daily(1, 10)], estimateUsd: 1 });
    expect(assertSpendAllowed(decision)).toBe(decision);
  });

  it('throws a 402 carrying the window that blocked', () => {
    const decision = evaluateSpendCaps({ windows: [daily(11, 10)], estimateUsd: 1 });
    try {
      assertSpendAllowed(decision);
      expect.unreachable('the denial should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(GardenError);
      const garden = error as GardenError;
      expect(garden.code).toBe('spend_cap_reached');
      expect(garden.statusCode).toBe(402);
      expect(garden.details?.blockedBy).toBe('daily');
    }
  });
});

describe('spendWindowBounds', () => {
  it('rolls the day over at local midnight, not at UTC midnight', () => {
    // 2026-03-10T02:00Z is still the evening of 2026-03-09 in Los Angeles (already on daylight
    // time, so local midnight is 07:00Z), and already the morning of 2026-03-10 in Tokyo.
    const now = new Date('2026-03-10T02:00:00Z');
    expect(spendWindowBounds('America/Los_Angeles', now).daily.start.toISOString()).toBe(
      '2026-03-09T07:00:00.000Z'
    );
    expect(spendWindowBounds('Asia/Tokyo', now).daily.start.toISOString()).toBe(
      '2026-03-09T15:00:00.000Z'
    );
  });

  it('gives a 23-hour day across a spring-forward transition', () => {
    // US daylight saving begins on 2026-03-08. A day computed as "start plus 24 hours" would run
    // an hour into the next day and let an hour of spend fall through the daily cap twice.
    const bounds = spendWindowBounds('America/Los_Angeles', new Date('2026-03-08T18:00:00Z'));
    expect(bounds.daily.end.getTime() - bounds.daily.start.getTime()).toBe(23 * 60 * 60_000);
  });

  it('gives a 25-hour day across an autumn fall-back transition', () => {
    const bounds = spendWindowBounds('America/Los_Angeles', new Date('2026-11-01T18:00:00Z'));
    expect(bounds.daily.end.getTime() - bounds.daily.start.getTime()).toBe(25 * 60 * 60_000);
  });

  it('runs the month from the first local day to the first of the next', () => {
    const bounds = spendWindowBounds('Europe/Berlin', new Date('2026-07-31T22:30:00Z'));
    // 22:30Z on the 31st is already 1 August in Berlin, so the month is August.
    expect(bounds.monthly.start.toISOString()).toBe('2026-07-31T22:00:00.000Z');
    expect(bounds.monthly.end.toISOString()).toBe('2026-08-31T22:00:00.000Z');
  });

  it('runs the week from the owner’s own Monday', () => {
    // 22:30Z on Saturday 1 August is already Sunday 2 August in Berlin, so the week is still the
    // one that began on Monday 27 July - a UTC weekday would have rolled it over a day early.
    const bounds = spendWindowBounds('Europe/Berlin', new Date('2026-08-01T22:30:00Z'));
    expect(bounds.weekly.start.toISOString()).toBe('2026-07-26T22:00:00.000Z');
    expect(bounds.weekly.end.toISOString()).toBe('2026-08-02T22:00:00.000Z');
  });

  it('gives a 167-hour week across a spring-forward transition', () => {
    // Wednesday 4 March 2026, so the week runs from Monday the 2nd through Sunday the 8th - the
    // day US clocks jump forward. A week computed as "start plus seven days" would overrun it.
    const bounds = spendWindowBounds('America/Los_Angeles', new Date('2026-03-04T18:00:00Z'));
    expect(bounds.weekly.start.toISOString()).toBe('2026-03-02T08:00:00.000Z');
    expect(bounds.weekly.end.getTime() - bounds.weekly.start.getTime()).toBe(167 * 60 * 60_000);
  });

  it('falls back to UTC on an unknown zone rather than stopping every task on the machine', () => {
    const bounds = spendWindowBounds('Mars/Olympus', new Date('2026-07-31T02:00:00Z'));
    expect(bounds.daily.start.toISOString()).toBe('2026-07-31T00:00:00.000Z');
    // Friday 31 July 2026, so the week began on Monday the 27th.
    expect(bounds.weekly.start.toISOString()).toBe('2026-07-27T00:00:00.000Z');
  });
});

describe('localDayKey', () => {
  it('keys an instant by the owner’s calendar day', () => {
    const instant = new Date('2026-03-10T02:00:00Z');
    expect(localDayKey('America/Los_Angeles', instant)).toBe('2026-03-09');
    expect(localDayKey('Asia/Tokyo', instant)).toBe('2026-03-10');
    expect(localDayKey('UTC', instant)).toBe('2026-03-10');
  });
});
