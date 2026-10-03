import { describe, expect, it } from 'vitest';
import { runLeaseLoops, type WorkerCounters } from './lease.js';

const counters = (): WorkerCounters => ({ active: 0, completed: 0, failed: 0, leaseErrors: 0 });

/**
 * A promise the test resolves when the thing it is waiting for has actually happened.
 *
 * Waiting a fixed few milliseconds before asserting would be a bet that the machine schedules
 * three lease attempts inside that window. On a loaded box it does not, and this is the one file
 * that exists to show the queue keeps running when things go wrong, so it must not flake. Nothing
 * here waits on the clock: every assertion is gated on the loops reporting that they reached the
 * state.
 */
const gate = (): { reached: Promise<void>; reach: () => void } => {
  let reach = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { reached, reach };
};

/** A real macrotask wait, so an idle queue yields the event loop instead of spinning it. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

/** A queue of tasks handed out one at a time, exactly as leaseNextTask does. */
const queue = (ids: string[]) => {
  const pending = [...ids];
  return async (): Promise<string | null> => pending.shift() ?? null;
};

describe('worker lease loops', () => {
  it('runs several tasks at once instead of holding the queue behind the first', async () => {
    // The single-slot loop this replaced meant one long build blocked every scheduled run and
    // every follow-up message for as long as it took, with no way to raise the limit.
    const release: Array<() => void> = [];
    const started: string[] = [];
    const allStarted = gate();
    let running = true;
    const gauge = counters();
    const loops = runLeaseLoops({
      concurrency: 3,
      pollMs: 1,
      counters: gauge,
      running: () => running,
      lease: queue(['a', 'b', 'c']),
      run: async (task: string) => {
        started.push(task);
        if (started.length === 3) allStarted.reach();
        await new Promise<void>((resolve) => release.push(resolve));
      },
      fail: async () => undefined,
      idle: tick
    });

    await allStarted.reached;
    expect(started).toEqual(['a', 'b', 'c']);
    expect(gauge.active).toBe(3);

    for (const resolve of release) resolve();
    running = false;
    await loops;
    expect(gauge).toEqual({ active: 0, completed: 3, failed: 0, leaseErrors: 0 });
  });

  it('reports a real gauge rather than a boolean dressed as a counter', async () => {
    const gauge = counters();
    const bothInFlight = gate();
    const release: Array<() => void> = [];
    let running = true;
    let peak = 0;
    const loops = runLeaseLoops({
      concurrency: 2,
      pollMs: 1,
      counters: gauge,
      running: () => running,
      lease: queue(['a', 'b']),
      run: async () => {
        peak = Math.max(peak, gauge.active);
        if (peak === 2) bothInFlight.reach();
        await new Promise<void>((resolve) => release.push(resolve));
      },
      fail: async () => undefined,
      idle: tick
    });
    await bothInFlight.reached;
    for (const resolve of release) resolve();
    running = false;
    await loops;
    expect(peak).toBe(2);
  });

  it('keeps the other slots alive when recording a failure itself fails', async () => {
    // fail() writes to the store, which is exactly what may have just become unreachable. An
    // unhandled rejection here would end the process and take every in-flight task with it.
    const gauge = counters();
    const bothSeen = gate();
    let running = true;
    let completed = 0;
    let seen = 0;
    const account = (): void => {
      seen += 1;
      if (seen === 2) bothSeen.reach();
    };
    const loops = runLeaseLoops({
      concurrency: 2,
      pollMs: 1,
      counters: gauge,
      running: () => running,
      lease: queue(['boom', 'good']),
      run: async (task: string) => {
        if (task === 'boom') throw new Error('provider exploded');
        completed += 1;
        account();
      },
      fail: async () => {
        account();
        throw new Error('database unreachable');
      },
      idle: tick
    });
    await bothSeen.reached;
    running = false;
    await loops;
    expect(completed).toBe(1);
    expect(gauge.failed).toBe(1);
    expect(gauge.completed).toBe(1);
  });

  it('survives a lease call that rejects', async () => {
    const gauge = counters();
    let attempts = 0;
    const loops = runLeaseLoops({
      concurrency: 1,
      pollMs: 1,
      counters: gauge,
      // The loop stops on the attempt count rather than on elapsed time, so the two rejections and
      // the one task are all that this waits for.
      running: () => attempts < 4,
      lease: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('connection reset');
        return attempts === 3 ? 'a' : null;
      },
      run: async () => undefined,
      fail: async () => undefined,
      idle: tick
    });
    await loops;
    expect(attempts).toBe(4);
    expect(gauge.completed).toBe(1);
  });
  it('counts and reports a lease that fails, and says so once rather than every poll', async () => {
    // A failing lease returns no task, which at this level is indistinguishable from an empty
    // queue. Uncounted, the worker reported itself healthy forever while accepting nothing, and
    // the release gate that reads these counters cleared on a process doing no work at all.
    const counters = { active: 0, completed: 0, failed: 0, leaseErrors: 0 };
    const health: Array<boolean> = [];
    let polls = 0;
    let running = true;
    await runLeaseLoops({
      concurrency: 1,
      pollMs: 0,
      counters,
      running: () => running,
      lease: () => {
        polls += 1;
        if (polls > 4) running = false;
        // Fails twice, then recovers to an empty queue.
        return polls <= 2
          ? Promise.reject(new Error('the database is not accepting connections'))
          : Promise.resolve(null);
      },
      run: () => Promise.resolve(),
      fail: () => Promise.resolve(),
      idle: () => Promise.resolve(),
      onLeaseHealth: (healthy) => health.push(healthy)
    });
    expect(counters.leaseErrors).toBe(2);
    // Reported on every failing poll so a deduping caller decides, but the count is what the
    // metric exposes; recovery is reported too, so the journal shows the outage ending.
    expect(health.at(0)).toBe(false);
    expect(health.at(-1)).toBe(true);
  });
});
