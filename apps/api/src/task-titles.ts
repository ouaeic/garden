import {
  OwnerPreferences,
  TASK_TITLE_MAX_LENGTH,
  type PurposeModelChoice
} from '@athanor/contracts';
import {
  AthanorError,
  buildConversationNameIndex,
  decryptJson,
  encryptJson,
  memoryIndexKey,
  unwrapDataKey
} from '@athanor/core';
import {
  readTaskModelPreferences,
  resolvePurposeChoice,
  type DataStore,
  type TaskRecord
} from '@athanor/data';
import { errorFields, type Logger } from './log.js';
import { TITLE_MAX_COST_USD } from './title-route.js';

/** Owner names win; the main task can supply its headline without an auxiliary model call. */
/** Input safety bound; the interface handles visual truncation without changing the name. */
export const MAX_GENERATED_TITLE_LENGTH = TASK_TITLE_MAX_LENGTH;

/** How many conversations one sweep names, so a backlog is worked through rather than swallowed. */
const TITLES_PER_SWEEP = 5;

/**
 * How far down the backlog one sweep is willing to look.
 *
 * Sweeps advance through this bounded window even when every conversation in it is unnameable.
 * At the end they wrap, so skipped conversations can become eligible after their limits change.
 */
const BACKLOG_WINDOW = 25;

/**
 * How many times one conversation is asked about before it is left alone.
 *
 * A request the model refuses to name, or one whose answer never parses into a title, would
 * otherwise be paid for on every wake for the life of the process. The placeholder stays, which is
 * exactly what was there before. Only a call that actually reached the provider counts: a
 * conversation passed over because the box was at its ceiling has not been tried, and tomorrow it
 * is nameable again.
 */
const MAX_ATTEMPTS_PER_TASK = 3;

/** Bounds the memory of failed attempts on a box that has been up for months. */
const MAX_TRACKED_ATTEMPTS = 500;

/** How long the titler waits out a provider that just failed, rather than asking it per answer. */
const PROVIDER_COOLDOWN_MS = 5 * 60_000;

/** Provider outages defer naming without consuming a task attempt. */
const PROVIDER_WALL_CODES = new Set([
  'provider_quota_exhausted',
  'provider_unavailable',
  'provider_not_connected'
]);

/**
 * How long a shutdown gives a naming call that is already in flight.
 *
 * The call is aborted first, and an HTTP client that honours its signal is gone immediately. This
 * bounds the case where it does not: a restart is a restart, and a conversation keeping its
 * placeholder for one more turn is not worth holding the process open for.
 */
const SHUTDOWN_GRACE_MS = 2_000;

/** How much of the request the namer is shown. A title comes from the opening, never the tail. */
const PROMPT_EXCERPT_CHARACTERS = 2_000;

export const TITLE_SYSTEM_PROMPT =
  'You name conversations. Reply with nothing but a clear, specific title naming the request and its intended outcome. Keep it concise, but preserve the details needed to distinguish this work, in the language the request is written in. No quotation marks, no final full stop, no preamble.';

/** A bounded provisional name is useful even when optional title inference is unavailable. */
export function provisionalTaskTitle(prompt: string): string {
  const opening =
    prompt
      .replace(/https?:\/\/\S+/g, (value) => {
        try {
          return new URL(value).hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      })
      .replace(/^[\s#>*`-]+/, '')
      .replace(
        /^(?:(?:please|can you|could you|would you|I want you to|I would like you to)\s+)+/i,
        ''
      )
      .split(/\n|[.!?。！？](?:\s|$)/, 1)[0]
      ?.trim() ?? '';
  const words = opening.split(/\s+/).filter(Boolean);
  let title = '';
  for (const word of words.slice(0, 7)) {
    if (Array.from(`${title} ${word}`).length > 56) break;
    title += `${title ? ' ' : ''}${word}`;
  }
  if (!title) title = Array.from(opening).slice(0, 48).join('');
  if (!title) return 'New project';
  return (
    title.charAt(0).toLocaleUpperCase() +
    title.slice(1) +
    (title.length < opening.length ? '…' : '')
  );
}

/**
 * Turns whatever the model said into a name, or nothing.
 *
 * Models answer this question with a bare title most of the time and with "Title: …", a quoted
 * string, or a sentence the rest of the time. What cannot be reduced to a plausible line is
 * refused: the placeholder is a poor name, and a paragraph in the sidebar is a worse one.
 */
export const cleanGeneratedTitle = (raw: string): string | null => {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  const stripped = firstLine
    .replace(/^(?:title|name)\s*[:\-–]\s*/i, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  return stripped.length <= MAX_GENERATED_TITLE_LENGTH ? stripped : null;
};

/** What the provider call has to give back for a title to be written and paid for. */
export interface TitleCompletion {
  readonly text: string;
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly providerRef: string;
  readonly resourceClass: string;
}

export interface TaskTitlerDeps {
  readonly store: DataStore;
  readonly masterKey: Buffer;
  readonly log: Logger;
  /** No bounded route is a skip; a provider outage starts a shared cooldown. */
  readonly complete: (input: {
    userId: string;
    modelId: string;
    choice?: PurposeModelChoice;
    privacyRoute: string;
    prompt: string;
    beforeSubmit?: (admission: {
      costUsd: number;
      providerRef: string;
      modelId: string;
    }) => Promise<void>;
    /** Aborted when the process is shutting down, so a restart never waits out a provider call. */
    signal?: AbortSignal;
  }) => Promise<TitleCompletion | { skipped: true } | null>;
}

const recordAttempt = (attempts: Map<string, number>, taskId: string): void => {
  if (attempts.size >= MAX_TRACKED_ATTEMPTS) attempts.clear();
  attempts.set(taskId, (attempts.get(taskId) ?? 0) + 1);
};

/**
 * Names one conversation, and answers whether it was named.
 *
 * Every failure is contained here: a workspace whose key will not unwrap, a prompt sealed under a
 * context that does not match, a provider that refuses. None of them is worth failing a sweep
 * over, and none of them costs the owner anything except a name they can still write themselves.
 */
const titleOneTask = async (
  deps: TaskTitlerDeps,
  task: TaskRecord,
  signal?: AbortSignal
): Promise<'named' | 'not_now' | 'unusable' | 'provider_failed' | 'skipped'> => {
  const workspace = await deps.store.getWorkspaceById(task.workspaceId);
  if (!workspace?.wrappedKey) return 'not_now';
  const key = unwrapDataKey(workspace.wrappedKey, deps.masterKey, workspace.id);
  if (task.promptCiphertext.aad !== `task-prompt:${workspace.id}`) return 'unusable';
  const prompt = decryptJson<{ prompt: string }>(task.promptCiphertext, key).prompt;
  if (!prompt.trim()) return 'unusable';

  const decision = await deps.store.spendGuard({
    userId: task.userId,
    taskId: task.id,
    estimateUsd: TITLE_MAX_COST_USD
  });
  if (decision.outcome === 'deny') return 'not_now';

  const user = await deps.store.getUserById(task.userId);
  if (!user) return 'not_now';
  const owner = OwnerPreferences.parse(user.preferences);
  const project = task.projectId
    ? await readTaskModelPreferences(deps.store, deps.masterKey, task)
    : { choices: {} };
  const { choice } = resolvePurposeChoice('title', project.choices, owner.modelPurposes ?? {});
  let reserved = false;
  const completion = await deps.complete({
    userId: task.userId,
    modelId: task.modelId,
    choice,
    privacyRoute: task.privacyRoute,
    prompt: prompt.slice(0, PROMPT_EXCERPT_CHARACTERS),
    beforeSubmit: async (admission) => {
      signal?.throwIfAborted();
      if (
        !Number.isFinite(admission.costUsd) ||
        admission.costUsd < 0 ||
        admission.costUsd > TITLE_MAX_COST_USD
      )
        throw new AthanorError(
          'title_cost_invalid',
          'Title generation exceeds its spending limit',
          409
        );
      await deps.store.recordUsage({
        userId: task.userId,
        workspaceId: workspace.id,
        taskId: task.id,
        kind: 'model_inference',
        resourceClass: 'model:task-title',
        quantity: 0,
        unit: 'tokens',
        credits: 0,
        state: 'reserved',
        reserveAgainstCaps: true,
        idempotencyKey: `task:${task.id}:title`,
        providerRef: admission.providerRef,
        modelId: admission.modelId,
        costUsd: admission.costUsd
      });
      reserved = true;
      signal?.throwIfAborted();
    },
    ...(signal ? { signal } : {})
  });
  if (!completion) return 'provider_failed';
  if ('skipped' in completion) return 'skipped';

  // Missing usage retains the bounded reservation instead of inventing a zero charge.
  if (completion.costUsd !== null)
    await deps.store.recordUsage({
      userId: task.userId,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: reserved ? 'model:task-title' : completion.resourceClass,
      quantity: completion.inputTokens + completion.outputTokens,
      unit: 'tokens',
      credits: 0,
      state: 'settled',
      ...(reserved ? { settleReservation: true } : {}),
      idempotencyKey: `task:${task.id}:title`,
      providerRef: completion.providerRef,
      costUsd: completion.costUsd
    });

  const title = cleanGeneratedTitle(completion.text);
  if (!title) return 'unusable';
  const written = await deps.store.setGeneratedTaskTitle(
    task.id,
    encryptJson({ title }, key, `task-title:${workspace.id}`),
    // The name the box worked out is the one the owner will search by, so it is indexed with the
    // same call the placeholder was - a name nobody can find is not much better than no name.
    buildConversationNameIndex(title, prompt, memoryIndexKey(key))
  );
  // Not written means the owner renamed it while this call was in flight, and their name stands.
  return written ? 'named' : 'unusable';
};

/**
 * One pass over the conversations still wearing a placeholder. Returns how many were named.
 *
 * `attempts` and `providerReadyAt` are the caller's, so they survive between sweeps: the first
 * bounds how often one stubborn conversation is retried, the second stops a provider outage from
 * being asked about once per answer for as long as it lasts.
 */
export const titleTasksOnce = async (
  deps: TaskTitlerDeps,
  state: {
    attempts: Map<string, number>;
    providerReadyAt: number;
    cursor?: string;
    retryAfter?: Map<string, number>;
  },
  now: number = Date.now(),
  signal?: AbortSignal
): Promise<number> => {
  if (now < state.providerReadyAt) return 0;
  let pending = await deps.store.listTasksNeedingTitle(BACKLOG_WINDOW, state.cursor);
  if (!pending.length && state.cursor) {
    delete state.cursor;
    pending = await deps.store.listTasksNeedingTitle(BACKLOG_WINDOW);
  }
  let named = 0;
  for (const task of pending) {
    if (signal?.aborted) break;
    if (named >= TITLES_PER_SWEEP) break;
    state.cursor = task.id;
    if ((state.attempts.get(task.id) ?? 0) >= MAX_ATTEMPTS_PER_TASK) continue;
    if ((state.retryAfter?.get(task.id) ?? 0) > now) continue;
    state.retryAfter?.delete(task.id);
    try {
      const outcome = await titleOneTask(deps, task, signal);
      if (outcome === 'named') {
        named += 1;
        deps.log.debug('task.titled', { taskId: task.id });
      } else if (outcome === 'skipped') {
        state.retryAfter ??= new Map();
        if (state.retryAfter.size >= MAX_TRACKED_ATTEMPTS)
          state.retryAfter.delete(state.retryAfter.keys().next().value!);
        state.retryAfter.set(task.id, now + PROVIDER_COOLDOWN_MS);
      } else if (outcome === 'unusable') {
        recordAttempt(state.attempts, task.id);
      } else if (outcome === 'provider_failed') {
        state.providerReadyAt = now + PROVIDER_COOLDOWN_MS;
        return named;
      }
    } catch (error) {
      // A call cut short by shutdown is the shutdown working, not a failure to report.
      if (signal?.aborted) break;
      // A wall reached us as a throw rather than as `null`. It is still a wall: stand down for the
      // cooldown and say so once, rather than charging this conversation an attempt it did not get
      // and asking the same refusing provider again for the next one.
      if (
        error instanceof AthanorError &&
        ['media_submission_exists', 'spend_cap_reached'].includes(error.code)
      )
        continue;
      if (error instanceof AthanorError && PROVIDER_WALL_CODES.has(error.code)) {
        state.providerReadyAt = now + PROVIDER_COOLDOWN_MS;
        deps.log.warn('task.title_provider_unavailable', { code: error.code });
        return named;
      }
      recordAttempt(state.attempts, task.id);
      deps.log.warn('task.title_failed', { taskId: task.id, ...errorFields(error) });
    }
  }
  if (pending.length < BACKLOG_WINDOW && pending.at(-1)?.id === state.cursor) delete state.cursor;
  return named;
};

export interface TaskTitler {
  /** Resolves once the loop has left the wait it is in. */
  readonly stop: () => Promise<void>;
}

/**
 * Runs the titler until it is stopped.
 *
 * It wakes on the answer itself - the same LISTEN/NOTIFY signal the activity stream uses, so a
 * conversation is named seconds after it replies rather than on the next tick of a clock - and
 * falls back to `pollMs` for the case that signal is what failed: a listener dropped mid-stream,
 * or a name left behind by a restart that happened between the answer and the sweep.
 */
export const startTaskTitler = (deps: TaskTitlerDeps, pollMs: number): TaskTitler => {
  const state = { attempts: new Map<string, number>(), providerReadyAt: 0 };
  const shutdown = new AbortController();
  let wake = (): void => undefined;
  const stopping = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const loop = (async () => {
    while (!shutdown.signal.aborted) {
      try {
        await titleTasksOnce(deps, state, Date.now(), shutdown.signal);
      } catch (error) {
        // A database blip must not end the loop: an unhandled rejection here would take the whole
        // API process with it, over a name.
        deps.log.error('task.title_sweep_failed', errorFields(error));
      }
      if (shutdown.signal.aborted) break;
      await Promise.race([deps.store.waitForAnsweredTask(pollMs), stopping]);
    }
  })();
  return {
    stop: async () => {
      // Aborting first is what makes this quick: a naming call already in flight is cut off rather
      // than held onto, so a restart costs a name rather than twenty seconds.
      shutdown.abort();
      wake();
      await Promise.race([
        loop,
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref())
      ]);
    }
  };
};
