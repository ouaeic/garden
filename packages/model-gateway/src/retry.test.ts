import { GardenError } from '@garden/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_RETRY_AFTER_MS,
  backoffDelayMs,
  isProviderWall,
  isRetryableError,
  retryAfterMsOf,
  withRetry,
  type RetryPolicy
} from './retry.js';

const policy = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  maxRetryAfterMs: DEFAULT_MAX_RETRY_AFTER_MS,
  random: () => 0,
  sleep: async () => {},
  ...overrides
});

describe('retry classification', () => {
  it('retries transient provider faults and leaves permanent ones alone', () => {
    expect(isRetryableError(new GardenError('provider_unavailable', 'down', 503))).toBe(true);
    expect(isRetryableError(new GardenError('provider_quota_exhausted', 'slow down'))).toBe(true);
    expect(isRetryableError(new GardenError('provider_request_failed', 'bad prompt'))).toBe(false);
    expect(isRetryableError(new GardenError('provider_not_configured', 'missing', 404))).toBe(
      false
    );
    expect(isRetryableError(new Error('socket hang up'))).toBe(false);
  });

  it('retries 408, 429 and 5xx however the adapter carries the status', () => {
    expect(isRetryableError(Object.assign(new Error('timeout'), { status: 408 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('limited'), { statusCode: 429 }))).toBe(true);
    expect(
      isRetryableError(Object.assign(new Error('gateway'), { response: { status: 502 } }))
    ).toBe(true);
    expect(isRetryableError(Object.assign(new Error('teapot'), { status: 418 }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error('nope'), { status: 404 }))).toBe(false);
  });
});

describe('retry-after hints', () => {
  it('reads a hint from error details, a seconds header or an HTTP date header', () => {
    expect(
      retryAfterMsOf(new GardenError('provider_quota_exhausted', 'wait', 429, { retryAfter: 7 }))
    ).toBe(7000);
    expect(
      retryAfterMsOf(
        Object.assign(new Error('limited'), {
          response: { status: 429, headers: new Headers({ 'retry-after': '12' }) }
        })
      )
    ).toBe(12_000);
    const hint = retryAfterMsOf(
      Object.assign(new Error('limited'), {
        headers: new Headers({ 'retry-after': new Date(Date.now() + 30_000).toUTCString() })
      })
    );
    expect(hint).toBeGreaterThan(25_000);
    expect(hint).toBeLessThanOrEqual(30_000);
    expect(retryAfterMsOf(new Error('no hint'))).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially, jitters within the attempt window and stays under the ceiling', () => {
    const zeroJitter = policy({ random: () => 0 });
    expect(backoffDelayMs(zeroJitter, 1, new Error('x'))).toBe(250);
    expect(backoffDelayMs(zeroJitter, 2, new Error('x'))).toBe(500);
    expect(backoffDelayMs(zeroJitter, 3, new Error('x'))).toBe(1000);
    const fullJitter = policy({ random: () => 0.999 });
    expect(backoffDelayMs(fullJitter, 1, new Error('x'))).toBeGreaterThan(250);
    expect(backoffDelayMs(fullJitter, 1, new Error('x'))).toBeLessThanOrEqual(500);
    expect(backoffDelayMs(zeroJitter, 20, new Error('x'))).toBe(10_000);
  });

  it('raises the wait to a provider hint without exceeding the ceiling', () => {
    const error = new GardenError('provider_quota_exhausted', 'wait', 429, { retryAfter: 5 });
    expect(backoffDelayMs(policy(), 1, error)).toBe(5000);
    const longHint = new GardenError('provider_quota_exhausted', 'wait', 429, {
      retryAfter: 600
    });
    expect(backoffDelayMs(policy(), 1, longHint)).toBe(120_000);
  });

  it('honours a named wait past the fallback cap and clamps a wait it invented itself', () => {
    // The two ceilings bound different things. A provider asking for sixty seconds and being asked
    // again at twenty spends the whole attempt budget inside its own window and never reaches the
    // moment it said it would serve the key; a wait this side guessed at must still not park a task.
    const named = (seconds: number): GardenError =>
      new GardenError('provider_quota_exhausted', 'wait', 429, { retryAfter: seconds });
    expect(backoffDelayMs(policy(), 1, named(60))).toBe(60_000);
    expect(backoffDelayMs(policy(), 1, named(119))).toBe(119_000);
    expect(backoffDelayMs(policy(), 1, named(3_600))).toBe(DEFAULT_MAX_RETRY_AFTER_MS);
    // No hint anywhere on the error, at the attempt where the curve is fully saturated: the wait is
    // the one it has always been, which is what makes the change above visible only where a
    // provider named a number.
    expect(backoffDelayMs(policy({ random: () => 0.999 }), 20, new Error('x'))).toBeLessThanOrEqual(
      20_000
    );
    expect(backoffDelayMs(policy({ random: () => 0 }), 20, new Error('x'))).toBe(10_000);
    // A policy whose hint ceiling is the shorter of the two still clamps to it: the hint raises the
    // wait to what the policy allows, never to what the provider wants.
    expect(backoffDelayMs(policy({ maxRetryAfterMs: 3_000 }), 1, named(60))).toBe(3_000);
    // And that same short hint ceiling does not reach a wait nobody asked for. This is the pair
    // that keeps the two horizons genuinely separate: fold the hint ceiling into the un-hinted path
    // and this line drops to 3,000 while every other line here stays exactly where it is.
    expect(
      backoffDelayMs(policy({ maxRetryAfterMs: 3_000, random: () => 0 }), 20, new Error('x'))
    ).toBe(10_000);
  });
});

describe('withRetry', () => {
  it('stops after the configured attempt budget and rethrows the last failure', async () => {
    let attempts = 0;
    const waits: number[] = [];
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new GardenError('provider_unavailable', 'upstream down', 503);
        },
        {
          policy: policy({
            maxAttempts: 3,
            sleep: async (ms) => {
              waits.push(ms);
            }
          }),
          hasStreamed: () => false
        }
      )
    ).rejects.toThrow('upstream down');
    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 500]);
  });

  it('does not retry once the attempt has already emitted output', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new GardenError('provider_unavailable', 'stream cut', 503);
        },
        { policy: policy(), hasStreamed: () => true }
      )
    ).rejects.toThrow('stream cut');
    expect(attempts).toBe(1);
  });

  it('does not retry an aborted request', async () => {
    const controller = new AbortController();
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          controller.abort();
          throw new GardenError('provider_unavailable', 'cancelled mid-flight', 503);
        },
        { policy: policy(), hasStreamed: () => false, signal: controller.signal }
      )
    ).rejects.toThrow('cancelled mid-flight');
    expect(attempts).toBe(1);
  });

  it('does not retry an AbortError raised by the transport', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('aborted'), { name: 'AbortError', status: 503 });
        },
        { policy: policy(), hasStreamed: () => false }
      )
    ).rejects.toThrow('aborted');
    expect(attempts).toBe(1);
  });
});

describe('provider status classification', () => {
  it('retries a 5xx, which is the status the adapter actually produces for an upstream fault', () => {
    // The adapter must construct this error with its status: without one it inherits GardenError's
    // default of 400, and a long task dies on one upstream blip.
    for (const status of [500, 502, 503, 504]) {
      expect(
        isRetryableError(
          new GardenError(
            'provider_request_failed',
            `openrouter request failed (${status})`,
            status
          )
        )
      ).toBe(true);
    }
  });

  it('still refuses to retry a genuine client-side rejection', () => {
    expect(isRetryableError(new GardenError('provider_request_failed', 'bad prompt', 400))).toBe(
      false
    );
  });

  it('honours a Retry-After carried on the error details', () => {
    expect(
      retryAfterMsOf(
        new GardenError('provider_quota_exhausted', 'rate limited', 429, { retryAfter: '30' })
      )
    ).toBe(30_000);
  });
});

/**
 * The same question at the other horizon: retry asks about the next ten seconds inside one step,
 * this asks whether a task that has run for hours should be parked and asked again tomorrow or
 * marked failed and left for a person to find in the morning.
 */
describe('whether waiting is any use', () => {
  it('calls every status the provider turns work away with a wall', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 529])
      expect(
        isProviderWall(new GardenError('provider_request_failed', `refused (${status})`, status))
      ).toBe(true);
  });

  it('leaves a request the provider refused terminal', () => {
    // A rejected prompt, an unknown model and a malformed tool schema fail identically however
    // often they are asked. Parking a task behind one of them is parking it behind nothing.
    for (const status of [400, 401, 403, 404, 413, 422])
      expect(
        isProviderWall(new GardenError('provider_request_failed', `refused (${status})`, status))
      ).toBe(false);
  });

  it('reads the codes that are thrown without a status of their own', () => {
    // `list()` raises this one with GardenError's default of 400, and the request deadline raises
    // `model_request_timeout` the same way. A status-only reading calls both client mistakes.
    expect(isProviderWall(new GardenError('provider_unavailable', 'could not be reached'))).toBe(
      true
    );
    expect(isProviderWall(new GardenError('model_request_timeout', 'no answer in 900s'))).toBe(
      true
    );
    expect(isProviderWall(new GardenError('provider_not_connected', 'add a provider', 503))).toBe(
      true
    );
    expect(isProviderWall(new Error('socket hang up'))).toBe(false);
  });
});
