import { runtimeClearTimer, runtimeNow, runtimeRandom, runtimeSetTimeout } from '@athanor/core';
import { AthanorError } from '@athanor/core';

/**
 * Provider faults an identical later request has a real chance of surviving. Anything else
 * (a rejected prompt, an unknown model, a malformed tool schema) fails the same way every time,
 * so retrying it only burns the owner's budget.
 */
const RETRYABLE_CODES = new Set(['provider_unavailable', 'provider_quota_exhausted']);

export interface RetryPolicy {
  /** Total attempts including the first; `1` disables retry. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Ceiling for a wait this side invented: the exponential curve and its jitter. */
  maxDelayMs: number;
  /**
   * Ceiling for a wait the provider itself asked for by name.
   *
   * Separate from `maxDelayMs` because the two bound different things, and one number was answering
   * both questions. The exponential curve is this side guessing when an upstream might be well
   * again, and a guess must not park a task; a `Retry-After` is the provider stating when it will
   * serve this key again, and asking before then is spending an attempt on a refusal that is
   * already known. Under one twenty-second cap a provider asking for sixty seconds was asked three
   * more times inside its own window and the whole attempt budget was gone before the window
   * opened.
   *
   * Two minutes, because past that a wait stops being a wait: `isProviderWall` below already names
   * this class of failure to the caller, and the caller's answer to a wall is to park the task and
   * pick it up later rather than to hold a worker's slot asleep in front of it.
   */
  maxRetryAfterMs: number;
  /** Jitter source in [0, 1); injected so tests are deterministic. */
  random: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      runtimeClearTimer(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = runtimeSetTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });

/** See `RetryPolicy.maxRetryAfterMs`; published so a caller building its own policy can reuse it. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 120_000;

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  maxRetryAfterMs: DEFAULT_MAX_RETRY_AFTER_MS,
  random: runtimeRandom,
  sleep: wait
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Adapters surface upstream status differently, so every conventional carrier is checked. */
export const httpStatusOf = (error: unknown): number | undefined => {
  const record = asRecord(error);
  if (!record) return undefined;
  return (
    finiteNumber(record.status) ??
    finiteNumber(record.statusCode) ??
    finiteNumber(asRecord(record.response)?.status) ??
    finiteNumber(asRecord(record.details)?.status)
  );
};

const retryAfterHeader = (holder: Record<string, unknown> | undefined): string | undefined => {
  const headers = asRecord(holder?.headers);
  const get = headers?.get;
  if (typeof get !== 'function') return undefined;
  const value = (get as (name: string) => unknown).call(headers, 'retry-after');
  return typeof value === 'string' ? value : undefined;
};

/** Retry-After is either a delay in seconds or an HTTP date; both forms appear in the wild. */
const parseRetryAfter = (value: unknown): number | undefined => {
  const seconds = finiteNumber(value);
  if (seconds !== undefined) return Math.max(0, seconds * 1000);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const asSeconds = Number(value.trim());
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(value.trim());
  return Number.isFinite(asDate) ? Math.max(0, asDate - runtimeNow()) : undefined;
};

export const retryAfterMsOf = (error: unknown): number | undefined => {
  const record = asRecord(error);
  if (!record) return undefined;
  const response = asRecord(record.response);
  return (
    parseRetryAfter(asRecord(record.details)?.retryAfter) ??
    parseRetryAfter(record.retryAfter) ??
    parseRetryAfter(retryAfterHeader(response)) ??
    parseRetryAfter(retryAfterHeader(record))
  );
};

/**
 * A status that means the provider turned the work away rather than refusing it.
 *
 * The same three numbers `isRetryableError` reads, named once so the two horizons cannot drift: a
 * fault worth asking about again in ten seconds is a fault worth waiting behind for an hour, and
 * they were being decided by two copies of one expression. Everything at 4xx other than 408 and 429
 * is the request itself being wrong - an unknown model, a rejected prompt, a malformed tool schema -
 * and asking again at any interval only spends the owner's money on the identical refusal.
 */
export const isProviderWallStatus = (status: number): boolean =>
  status === 408 || status === 429 || (status >= 500 && status < 600);

export const isRetryableError = (error: unknown): boolean => {
  if (error instanceof AthanorError && RETRYABLE_CODES.has(error.code)) return true;
  const status = httpStatusOf(error);
  if (status === undefined) return false;
  return isProviderWallStatus(status);
};

/**
 * Codes that name a wall whatever status they arrived with.
 *
 * Two of them are thrown without one at all - `list()` raises `provider_unavailable` with
 * AthanorError's default of 400, and the request deadline raises `model_request_timeout` the same
 * way - so a status-only reading calls the most obvious walls on the box client mistakes.
 */
const PROVIDER_WALL_CODES = new Set([
  'provider_unavailable',
  'provider_quota_exhausted',
  'provider_not_connected',
  'model_request_timeout'
]);

/**
 * Whether waiting is any use: the provider turned this work away, rather than refusing it.
 *
 * The same question `isRetryableError` asks, at the other horizon. Retry asks it about the next ten
 * seconds inside one step; this asks it about the next day, on behalf of the caller deciding
 * whether a task that has run for hours should be parked and picked up again or marked failed and
 * left for a person to notice. Getting it wrong in the terminal direction is what turned a
 * ninety-second load-shedding 503 into a dead scheduled run with eighteen steps of work on disk.
 */
export const isProviderWall = (error: unknown): boolean => {
  if (error instanceof AthanorError && PROVIDER_WALL_CODES.has(error.code)) return true;
  const status = httpStatusOf(error);
  return status === undefined ? false : isProviderWallStatus(status);
};

const isAbortError = (error: unknown): boolean => {
  const record = asRecord(error);
  return record?.name === 'AbortError' || record?.code === 'ABORT_ERR';
};

/**
 * Exponential backoff with full jitter, so a fleet of agents that all hit the same rate limit
 * spreads out instead of resynchronising on the provider's next window. A provider's own
 * Retry-After hint raises the floor, and raises the ceiling with it: a wait this side invented is
 * never longer than `maxDelayMs`, and a wait the provider named is honoured up to the separate,
 * larger `maxRetryAfterMs`. Neither can park a task unboundedly, which is what the single cap was
 * there to prevent - it just stopped asking again at twenty seconds when the provider had said
 * sixty.
 */
export const backoffDelayMs = (policy: RetryPolicy, attempt: number, error: unknown): number => {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const jittered = exponential * (0.5 + policy.random() * 0.5);
  const asked = retryAfterMsOf(error);
  // Branching on the presence of the hint rather than defaulting it to zero, so an error carrying
  // none takes arithmetic byte-identical to what it took before: only a request the provider itself
  // put a number on can be waited on for longer than it used to be.
  if (asked === undefined) return Math.min(policy.maxDelayMs, jittered);
  return Math.min(policy.maxRetryAfterMs, Math.max(asked, jittered));
};

export interface RetryOptions {
  policy: RetryPolicy;
  /**
   * Whether the failed attempt already handed text to the caller. Replaying such a request would
   * repeat visible output, so a partially streamed failure is always terminal.
   */
  hasStreamed: () => boolean;
  signal?: AbortSignal;
}

export const withRetry = async <T>(
  attempt: () => Promise<T>,
  options: RetryOptions
): Promise<T> => {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (
        tries >= options.policy.maxAttempts ||
        options.hasStreamed() ||
        options.signal?.aborted ||
        isAbortError(error) ||
        !isRetryableError(error)
      )
        throw error;
      await options.policy.sleep(backoffDelayMs(options.policy, tries, error), options.signal);
      if (options.signal?.aborted) throw error;
    }
  }
};
