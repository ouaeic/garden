/**
 * The poll loop, and the two things a loop on this box has to get right: not waking up when it
 * cannot possibly have work, and stopping when it is told rather than when it next looks.
 *
 * It lived inside `index.ts` as a bare `while` under a top-level `await`, which meant neither
 * property could be stated as a test - a module whose only shape is a running process cannot be
 * asked a question. It is a factory here for that reason and no other: `index.ts` still owns the
 * configuration, the database, the global VAPID registration and the health port, and hands this
 * one function of `deferredLastSweep` back in.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { SweepResult } from './sweep.js';

/** Everything the metrics port reports, accumulated across passes. */
export interface NotifierTotals {
  delivered: number;
  failed: number;
  suppressed: number;
  retired: number;
  /** Endpoint waits from the last pass alone: it widens the next page, so it does not accumulate. */
  deferred: number;
  /** Items the last pass decided to hold for the owner. Also a level, not a total. */
  held: number;
  /** Items the last pass had no way to send. A level too, and a standing one is a misconfiguration. */
  unsendable: number;
}

export interface NotifierInput {
  /** One pass. Given the previous pass's endpoint waits, because those widen this pass's page. */
  sweep: (deferredLastSweep: number) => Promise<SweepResult>;
  pollMs: number;
  /**
   * Whether this box can send anything at all: Web Push signing keys for devices, or the master
   * key that opens a paired destination's configuration.
   *
   * Read once, from configuration read once, and nothing in the process can change it - so when it
   * is false there is no sequence of events that ends in a delivery, and a loop is not a bounded
   * wait for one, it is 43,200 wakeups a day against a decision that was made at startup.
   */
  deliveryEnabled: boolean;
  signal: AbortSignal;
}

/**
 * Waits for shutdown and nothing else, with no timer at all.
 *
 * The disabled branch used to be `await delay(pollMs); continue;`, which is a timer firing every
 * two seconds for the life of a box that cannot send anything - on a small VPS that is a wakeup
 * that keeps the CPU out of its deep idle states, forever, to re-read a constant. Exiting instead
 * is not an option and never was: the process has to stay up to keep answering the health port
 * with the reason delivery is off, which is the only place an owner finds out.
 */
const untilAborted = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });

export const createNotifier = (input: NotifierInput) => {
  const totals: NotifierTotals = {
    delivered: 0,
    failed: 0,
    suppressed: 0,
    retired: 0,
    deferred: 0,
    held: 0,
    unsendable: 0
  };
  /*
   * One pass, then the decision whether to wait.
   *
   * A sweep that could not attempt anything - every endpoint inside its backoff, or every item held
   * because the owner is at the keyboard or asleep - has nothing to show for the candidate UNION it
   * just ran, so asking again immediately re-runs it as fast as the database will answer. Everything
   * else falls straight through to the next batch, which is what drains a backlog quickly.
   */
  const run = async (): Promise<void> => {
    if (!input.deliveryEnabled) {
      await untilAborted(input.signal);
      return;
    }
    while (!input.signal.aborted) {
      const result = await input.sweep(totals.deferred);
      totals.delivered += result.delivered;
      totals.failed += result.failed;
      totals.suppressed += result.suppressed;
      totals.retired += result.retired;
      totals.deferred = result.deferred;
      totals.held = result.held;
      totals.unsendable = result.unsendable;
      /*
       * Abortable, unlike the plain `delay` this replaced.
       *
       * `garden restart` and every update stop each service in turn, and a flag set by the signal
       * handler is not read until the current wait is over. The registry hit this first and wrote
       * it down - "thirty seconds of the outage the owner is watching, spent on a process that had
       * nothing to finish" - and the fix was never carried the twenty lines across to here.
       */
      if (result.idle)
        await delay(input.pollMs, undefined, { signal: input.signal }).catch(() => undefined);
    }
  };
  return { totals, run };
};
