import { runtimeClearTimer, runtimeSetInterval, runtimeSetTimeout } from '@garden/core';
/**
 * Holding a task, and letting go of it.
 *
 * A worker owns a task through a lease it has to keep renewing, and every long wait inside a turn -
 * a model request, a tool call, a compaction - has to happen without that lease lapsing underneath
 * it. The deadline and renewal wrappers here are what makes a long operation safe to await, and
 * `haltReason` is the other end: the check that says the task is no longer ours to finish.
 *
 * The unanswered-tool-call pair is part of the same lifecycle. A turn that stops between issuing a
 * call and answering it leaves the window in a shape no provider will accept, so whatever resumes
 * that turn has to seal the gap before the next request.
 */
import { GardenError } from '@garden/core';
import type { ModelMessage } from '@garden/model-gateway';

/**
 * A single shell or coding_agent call may legitimately run for an hour, so the lease is refreshed
 * on a timer while a tool executes; renewing only once per outer step would let another worker
 * claim and duplicate the task mid-tool.
 */
export const TASK_LEASE_SECONDS = 120;
const LEASE_RENEWAL_INTERVAL_MS = 45_000;
/**
 * How often a running tool call checks whether the user has stopped the task. Short enough that
 * Cancel feels immediate, long enough that an hour-long shell command costs sixty cheap reads.
 */
export const CANCELLATION_POLL_INTERVAL_MS = 3_000;

/**
 * Every tool call an assistant message declares must be answered before that message is persisted:
 * providers reject a follow-up request whose history contains a tool_calls block with no matching
 * tool result, which would strand the task forever.
 */
export const unansweredToolCallIds = (messages: ModelMessage[]): string[] => {
  const answered = new Set(
    messages.flatMap((message) =>
      message.role === 'tool' && message.toolCallId ? [message.toolCallId] : []
    )
  );
  const pending: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      if (!answered.has(call.id) && !pending.includes(call.id)) pending.push(call.id);
    }
  }
  return pending;
};

export const sealUnansweredToolCalls = (messages: ModelMessage[], reason: string): string[] => {
  const pending = unansweredToolCallIds(messages);
  for (const toolCallId of pending)
    messages.push({
      role: 'tool',
      toolCallId,
      content: `Not executed: ${reason}`
    });
  return pending;
};

export const COMPLETION_HANDOFF_ATTEMPTS = 6;
export const COMPLETION_HANDOFF_DELAY_MS = 250;

/**
 * Handing the task to its next queued message races the API, but once this worker's lease is gone
 * neither write can ever succeed, so the retry is bounded and checks ownership between attempts
 * instead of spinning on a live CPU.
 */
export const retryTurnHandoff = async (input: {
  attempt: () => Promise<boolean>;
  stillOwned: () => Promise<boolean>;
  sleep: (milliseconds: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}): Promise<'handed_off' | 'released' | 'exhausted'> => {
  const attempts = input.attempts ?? COMPLETION_HANDOFF_ATTEMPTS;
  for (let index = 0; index < attempts; index += 1) {
    if (await input.attempt()) return 'handed_off';
    if (!(await input.stillOwned())) return 'released';
    await input.sleep(input.delayMs ?? COMPLETION_HANDOFF_DELAY_MS);
  }
  return 'exhausted';
};

export const MODEL_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A provider that accepts the connection and then stalls would hold one of the worker's few task
 * slots forever, so every model request carries its own deadline.
 */
export const withRequestDeadline = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds = MODEL_REQUEST_TIMEOUT_MS
): Promise<T> => {
  const controller = new AbortController();
  const timer = runtimeSetTimeout(() => {
    controller.abort(
      new GardenError(
        'model_request_timeout',
        `The model provider did not respond within ${Math.round(milliseconds / 1000)} seconds`
      )
    );
  }, milliseconds);
  timer.unref();
  try {
    return await operation(controller.signal);
  } finally {
    runtimeClearTimer(timer);
  }
};

/**
 * Keeps a periodic side effect running for exactly as long as the operation does, so a lease is
 * refreshed while a single tool call runs for up to an hour rather than only between outer steps.
 */
export const withPeriodicRenewal = async <T>(
  operation: () => Promise<T>,
  renew: () => Promise<unknown>,
  intervalMs = LEASE_RENEWAL_INTERVAL_MS
): Promise<T> => {
  const timer = runtimeSetInterval(() => {
    void Promise.resolve()
      .then(renew)
      .catch(() => undefined);
  }, intervalMs);
  timer.unref();
  try {
    return await operation();
  } finally {
    runtimeClearTimer(timer);
  }
};

/** Whether the owner has stopped a task, and whose it is to run. */
export interface TaskClaim {
  status: string;
  leaseOwner: string | null;
}

/**
 * Why a step in flight should stop.
 *
 * `stopped` is the owner: they pressed Pause or Stop, and what this worker has done so far is worth
 * recording before it goes. `disowned` is everything else that means this run is no longer the one
 * in charge - the task was re-queued, or its lease moved - and there the only safe act is silence,
 * because whoever holds it now is writing the trajectory this worker would otherwise write over.
 */
export type StepHalt = 'stopped' | 'disowned';

export const haltReason = (claim: TaskClaim | null, workerId: string): StepHalt | null => {
  if (!claim) return 'disowned';
  if (claim.status === 'paused' || claim.status === 'cancelled') return 'stopped';
  // A resume sets the status back to `queued` and clears the lease in the same statement, which is
  // what lets a second worker take the task while this one is still generating. Seeing `queued` on
  // a task this worker is running means exactly that has happened.
  if (claim.status !== 'running' && claim.status !== 'planning') return 'disowned';
  if (claim.leaseOwner !== null && claim.leaseOwner !== workerId) return 'disowned';
  return null;
};

/** A running request and the reason it was torn down, if it was torn down for this. */
export interface StopWatch {
  /** Joined into the request's own signal. */
  readonly signal: AbortSignal;
  /** Set before the abort, so the caller can tell this apart from a provider fault. */
  readonly halt: StepHalt | null;
  stop(): void;
}

/**
 * Delivers Stop to the request that is actually running.
 *
 * A model call is the longest thing a turn does - minutes of it, on a high-reasoning step - and it
 * carried no notion of the owner having changed their mind. Pressing Stop wrote a status in the API
 * process and the worker read it at the next step boundary, so the answer kept being written across
 * the screen for as long as the provider felt like writing it, after the interface had already said
 * the task was stopped. Aborting the request is what makes the two agree, and it is also what stops
 * the owner paying for the rest of a reply they cancelled.
 *
 * The reason is recorded before the abort rather than read off the error afterwards, because the
 * error is not reliably an abort: a cancel that lands before the response headers is caught inside
 * the provider adapter and re-thrown as `provider_unavailable`, which would otherwise be handled as
 * a transient fault and fail the task on a resource it never ran out of.
 */
export const startStopWatch = (
  claim: () => Promise<TaskClaim | null>,
  workerId: string,
  intervalMs = CANCELLATION_POLL_INTERVAL_MS
): StopWatch => {
  const controller = new AbortController();
  let halt: StepHalt | null = null;
  let reading = false;
  const timer = runtimeSetInterval(() => {
    // One read in flight at a time: a database that has become slow must not queue a poll per tick.
    if (reading || controller.signal.aborted) return;
    reading = true;
    void claim()
      .then((latest) => {
        const reason = haltReason(latest, workerId);
        if (!reason || controller.signal.aborted) return;
        halt = reason;
        controller.abort();
      })
      .catch(() => undefined)
      .finally(() => {
        reading = false;
      });
  }, intervalMs);
  timer.unref();
  return {
    signal: controller.signal,
    get halt() {
      return halt;
    },
    stop: () => runtimeClearTimer(timer)
  };
};
