import { GardenError, redactText } from '@garden/core';
import { TASK_MAX_ATTEMPTS } from '@garden/data';
import type { LogFields, LogLevel } from './log.js';

/** How many stacks are remembered before the set is emptied and one of them may repeat. */
const REMEMBERED_FAILURE_STACKS = 64;

/**
 * The shape of everything this record is allowed to name: a code, an errno, a class. Anything that
 * does not fit was not chosen by the machine, and this record carries only what the machine chose.
 */
const MACHINE_WORD = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The identity of a failure without its wording: a driver's SQLSTATE or a system errno where the
 * thrown value carries one, otherwise the class that was thrown. Null for an GardenError, whose
 * code already says what it is.
 */
const failureClass = (error: unknown): string | null => {
  if (error instanceof GardenError) return null;
  const carried = (error as { code?: unknown } | null)?.code;
  if (typeof carried === 'string' && MACHINE_WORD.test(carried)) return carried;
  // `name` is a class name in every error anyone writes, but it is an ordinary writable property
  // and a library is free to put a sentence in it, so it is held to the same shape as the rest.
  if (error instanceof Error) return MACHINE_WORD.test(error.name) ? error.name : 'Error';
  return error === null || error === undefined ? String(error) : typeof error;
};

/**
 * The code, if it is one.
 *
 * An GardenError's code is garden's own vocabulary everywhere it is written by hand - but not
 * everywhere it is constructed. `runnerFailure` in runner-client.ts mints one from the `code` field
 * of whatever JSON the workspace runner answered with, and that is a value off a wire rather than
 * out of this repository: unbounded, free to carry a newline that would split this record in two,
 * and free to carry whatever the failing call was about. Held to the same shape as everything else
 * on the line, and where it does not fit the line still says a task failed and how far it got.
 */
const failureCode = (error: unknown): string => {
  if (!(error instanceof GardenError)) return 'agent_failed';
  return MACHINE_WORD.test(error.code) ? error.code : 'agent_failed';
};

const failureStack = (error: unknown): string => {
  if (!(error instanceof Error) || !error.stack) return '';
  /*
   * The frames, taken by cutting the whole message off the front rather than by recognising what a
   * frame looks like.
   *
   * A stack begins with the message, the message can be several lines long, and one of those lines
   * can be shaped exactly like a frame - which is not a contrivance: an error that wraps a failed
   * subprocess carries that program's own trace in its message, and that trace names the owner's
   * files. Recognising frames by shape printed those, so this recognises the header instead, which
   * is the one part of a stack whose exact text is known here. A stack that does not begin with the
   * header it should - anything that rewrote it - gets no frames at all, because silence is the
   * only safe answer to a string this cannot account for.
   */
  const header = error.message === '' ? error.name : `${error.name}: ${error.message}`;
  if (!error.stack.startsWith(header)) return '';
  return redactText(
    error.stack
      .slice(header.length)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^at\s\S.*:\d+:\d+\)?$/.test(line))
      .slice(0, 3)
      .join(' | ')
  );
};

/**
 * The identity of a failure that is not a task's, in the same words a failed task uses: garden's
 * own code where it has one, otherwise the driver's SQLSTATE, the system errno or the class that
 * was thrown - and the frames, which name code locations and never what flowed through them.
 */
export const failureFields = (error: unknown): LogFields => {
  const kind = failureClass(error);
  const stack = kind ? failureStack(error) : '';
  return {
    code: error instanceof GardenError ? failureCode(error) : (kind ?? 'unknown'),
    ...(stack ? { frames: stack } : {})
  };
};

export interface TaskFailureLog {
  taskId: string;
  attempt: number;
  turn: number;
  step: number;
  modelId: string;
  /** Omitted when the caller did not see this attempt start; a guess would be worse than silence. */
  durationMs?: number;
  error: unknown;
  /** The turn is parked on something outside this box rather than broken. */
  waiting: boolean;
}

/**
 * The journal record an operator can act on, for a turn that has just died.
 *
 * The encrypted `error` event is the owner's record and stays exactly as it is - it can quote a
 * path, a command, a fragment of the work - which means reading it needs the master key and a
 * script. This is the other record, describing the same failure in nothing but facts the machine
 * chose for itself: which task, how far it got, how long it ran, which model, and the code. Never
 * the message, because the message is where the owner's content ends up - a driver quotes the
 * offending value back, a filesystem error names the file, a provider echoes the prompt.
 *
 * The stack is the exception: frames name code locations and never the data that flowed through
 * them. They are recorded only where the failure came from the machine rather than from garden's
 * own judgement - an GardenError says what it is in one word and needs no frames - and only the
 * first time this process records that particular stack, so a task handed out six times leaves six
 * records and one trace. `framesRepeated` is how the five other records say where it went.
 *
 * A turn parked on a provider is a warning rather than an error, which is what keeps
 * `journalctl -p err` a list of things that are actually broken.
 */
export const taskFailureRecord = (
  input: TaskFailureLog,
  loggedStacks: Set<string> = new Set()
): { level: LogLevel; event: string; fields: LogFields } => {
  const code = failureCode(input.error);
  const kind = failureClass(input.error);
  const stack = kind ? failureStack(input.error) : '';
  const fingerprint = `${code}|${kind ?? ''}|${stack}`;
  const repeated = stack !== '' && loggedStacks.has(fingerprint);
  if (stack && !repeated) {
    // Bounded by emptying rather than by evicting the oldest: forgetting costs one repeated trace,
    // which is not worth the code an eviction order would take to avoid.
    if (loggedStacks.size >= REMEMBERED_FAILURE_STACKS) loggedStacks.clear();
    loggedStacks.add(fingerprint);
  }
  return {
    level: input.waiting ? 'warn' : 'error',
    event: input.waiting ? 'task.waiting' : 'task.failed',
    fields: {
      taskId: input.taskId,
      turn: input.turn,
      step: input.step,
      attempt: input.attempt,
      attempts: TASK_MAX_ATTEMPTS,
      modelId: input.modelId,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      code,
      ...(kind ? { class: kind } : {}),
      ...(stack ? (repeated ? { framesRepeated: true } : { frames: stack }) : {})
    }
  };
};
