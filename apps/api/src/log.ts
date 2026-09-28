import { GardenError } from '@garden/core';

/**
 * The API's end of the one journal format.
 *
 * The logger itself, and with it the allowlist that decides what a line may name, is in
 * `@garden/worker`: the API depends on that package, nothing depends on the API, and the only
 * other thing every process imports is compiled into the browser bundle where there is no stdout
 * to write to. What stays here is what needs garden's own error vocabulary, which lives a layer
 * above the logger.
 */
export {
  createLogger,
  journalLevelPrefix,
  silentLogger,
  type Logger,
  type LoggerOptions,
  type LogFields,
  type LogLevel,
  type LogThreshold,
  type LogValue
} from '@garden/worker';
import type { LogFields, Logger } from '@garden/worker';

/**
 * A stack trace names code locations, never the data that flowed through them, so the frames are
 * the one part of a thrown value that is safe to keep. The message is not: a validation or driver
 * error routinely quotes the offending value back.
 */
const errorFrames = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || !error.stack) return undefined;
  /*
   * Found by cutting the header off the front, rather than by recognising what a frame looks like.
   *
   * A stack begins with the message, the message can be several lines long, and one of those lines
   * can be shaped exactly like a frame - which is not a contrivance: an error that wraps a failed
   * subprocess carries that program's own trace in its message, and that trace names the owner's
   * files. Recognising frames by shape printed those, because a real frame and a quoted one are the
   * same string. The header is the one part of a stack whose exact text is known here; a stack that
   * does not begin with the one it should - anything that rewrote it - gets no frames at all,
   * because silence is the only safe answer to a string this cannot account for.
   */
  const header = error.message === '' ? error.name : `${error.name}: ${error.message}`;
  if (!error.stack.startsWith(header)) return undefined;
  const frames = error.stack
    .slice(header.length)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^at\s\S.*:\d+:\d+\)?$/.test(line))
    .slice(0, 3);
  return frames.length ? frames.join(' | ') : undefined;
};

/**
 * One word, or nothing.
 *
 * Every candidate for `code` on this line is a string somebody else chose. Two of them are not
 * garden's to trust however much they look like it: an GardenError's code is this repository's
 * own vocabulary where it is written by hand, but `runnerFailure` mints one from the `code` field
 * of whatever JSON the workspace runner answered with, and `name` is an ordinary writable property
 * that a library is free to put a sentence in. Both arrive off a wire, unbounded, free to carry
 * what the failing call was about - which is the owner's.
 *
 * So the shape is the gate rather than the provenance, and it is the same shape the worker holds
 * its half of this format to. A value that is not one machine word is dropped, and the line still
 * says what failed and where.
 */
const MACHINE_WORD = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The identity of a failure without its wording: an Garden code where one exists, otherwise a
 * driver's SQLSTATE or a system errno, otherwise the class name.
 */
export const errorFields = (error: unknown): LogFields => {
  const carried = (error as { code?: unknown } | null)?.code;
  const code =
    error instanceof GardenError
      ? MACHINE_WORD.test(error.code)
        ? error.code
        : 'api_failed'
      : typeof carried === 'string' && MACHINE_WORD.test(carried)
        ? carried
        : error instanceof Error
          ? MACHINE_WORD.test(error.name)
            ? error.name
            : 'Error'
          : 'non_error_throw';
  const frames = errorFrames(error);
  // What was thrown, when it left no frames to read.
  //
  // A throw with no usable stack logs a bare code and nothing else - `{"code":"TypeError"}` and not
  // one word about where it came from - which is the least diagnosable line this logger can emit
  // and turns up exactly when something unusual happened. Naming the shape is the difference
  // between "something threw a TypeError somewhere in the API" and knowing it was not an Error at
  // all, which is the fact that explains the missing frames.
  const shape = frames
    ? undefined
    : error === null || error === undefined
      ? String(error)
      : error instanceof Error
        ? 'Error without a stack'
        : (Object.getPrototypeOf(error) as { constructor?: { name?: unknown } } | null)?.constructor
              ?.name === 'Object'
          ? 'plain object'
          : typeof error;
  return { code, ...(frames ? { frames } : {}), ...(shape ? { thrown: shape } : {}) };
};

export interface ProcessGuardTarget {
  on(event: string, listener: (value: unknown) => void): unknown;
  exit(code: number): void;
}

/**
 * Node's default for an unobserved rejection is to rethrow it and kill the process, which turns a
 * single failed sweep into an outage the owner sees only as a systemd restart. Logging it and
 * carrying on is the right trade for a personal server: the request that raised it is already
 * lost, and the alternative loses every other one too. An uncaught exception is different - the
 * process state is no longer trustworthy - so that one still exits, but with a line explaining
 * why first.
 */
export const installProcessGuards = (
  logger: Logger,
  target: ProcessGuardTarget = process
): void => {
  target.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', errorFields(reason));
  });
  target.on('uncaughtException', (error) => {
    logger.error('process.uncaught_exception', errorFields(error));
    target.exit(1);
  });
};
