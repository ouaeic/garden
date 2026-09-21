import { redactText } from '@athanor/core';

/**
 * The runner's end of the one journal format, held here rather than imported.
 *
 * `createLogger` is in `@athanor/worker`, and the reason it is there is that the API depends on
 * that package while nothing depends on the API. The runner has no such edge to ride. It depends
 * on `@athanor/contracts` and `@athanor/core`, and `@athanor/core` is compiled into the web bundle
 * behind a hard size gate, where there is no stdout to write a journal line to.
 *
 * Each way of closing that gap costs more than this file does. Depending on `@athanor/worker`
 * would put the database layer and the model gateway - that package's own dependencies - into the
 * module graph of the one process on this box that executes whatever the agent was told to
 * execute, and it inverts the deployment order: the worker calls the runner over HTTP, so an
 * import the other way makes the runner unstartable until the worker is built. A subpath on
 * `@athanor/core` would put `process` and a stdout write one accidental import away from the web
 * build, and "no bundler will ever follow this" is a promise no one here can keep. A package of
 * its own would only be canonical if the API and the worker moved onto it too, which is a change
 * to two files this cannot make; until they do it is this file with a build step attached.
 *
 * So this is a copy, made on the same terms as the one in `services/relay`: a standalone
 * deployable, its own field vocabulary, writing the format everything else on the box writes. The
 * one thing that must not drift - the priority map, which is the whole point of the exercise - is
 * held against the worker's by `scripts/check-repository.mjs`.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

/**
 * The runner's whole vocabulary, and the sentence each entry files under.
 *
 * The prose lives here rather than at the call site because the allowlist below cannot protect a
 * free-text field: this is the process that opens pages the owner did not write and runs commands
 * the owner did not type, so a caller able to pass its own wording is a caller able to publish a
 * page's contents to the journal. Sourced from a table, the sentence is a literal by construction
 * and everything that varies has to go through the fields.
 */
const events = {
  'computation.record_write_failed':
    'an analysis session stopped, but its final receipt could not be saved',
  'process.history_write_failed':
    'a terminal process receipt could not be saved; retained records have not been evicted',
  'services.record_write_failed':
    'could not record services in .athanor/services.json - services will not survive a restart',
  'command.limits_unavailable':
    'the resource limiter is missing, so commands run without memory, file-size and process limits. Install util-linux to restore them.',
  'browser.cleanup_failed': 'the project browser namespace could not be released',
  'desktop.cleanup_failed': 'the project desktop namespace could not be released',
  'browser.frame_scan_failed': 'a frame could not be scanned for controls',
  'browser.download_cleanup_failed': 'a temporary browser download could not be removed',
  'sessions.retirement_failed': 'an idle browser or empty desktop could not be retired',
  'browser.reduced_launch': 'the browser started after the preferred configuration was refused',
  'desktop.encoder_failed':
    'the desktop display encoder could not run, so the Computer pane is frozen. Install ffmpeg to restore the stream.'
} as const;

export type RunnerEvent = keyof typeof events;

/**
 * An allowlist, for the same reason the worker keeps one: a name nobody put here is dropped rather
 * than printed, so a field that turns out to carry a page, a path or a prompt is a gap in a line
 * instead of a disclosure. Everything on it is a machine's own word for something, a boolean the
 * machine decided, or an identifier the machine minted.
 */
const loggableFields = new Set([
  /** What refused, in one word: an errno where the system gave one, otherwise the thrown class. */
  'code',
  /** Which program was looked for and not found. Configured on this box, not read off a wire. */
  'executable',
  /** Whether the browser came up with no screen, which changes what pages serve it. */
  'headless',
  /** Whether the renderer sandbox is on, which is the boundary around arbitrary web content. */
  'sandbox',
  'workspaceId'
]);

/**
 * Objects and arrays are refused outright, and strings still go through the shared secret
 * scrubber, so a value that turns out to embed a key is neutered rather than published.
 */
const safeValue = (value: LogValue): LogValue => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  // Types are a promise, not a guarantee, and a logger that threw on an unexpected value would
  // silence the very degradation it was called to record.
  if (typeof value !== 'string') return undefined;
  return redactText(value).slice(0, 300);
};

const loggableEntries = (fields: LogFields): Record<string, string | number | boolean> => {
  const entries: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (!loggableFields.has(key)) continue;
    const value = safeValue(raw);
    if (value === undefined || value === null) continue;
    entries[key] = value;
  }
  return entries;
};

/**
 * systemd reads a leading `<N>` off a line and files it at that priority, which is the difference
 * between `journalctl -p warning -u athanor-runner` finding a browser that lost its sandbox and it
 * answering that nothing has ever gone wrong here. JOURNAL_STREAM is set by systemd itself, and
 * only when this process's output goes to the journal, so a runner started in a terminal writes
 * plain JSON and journald is the only reader that ever sees the marker.
 *
 * Copied whole, including the three levels this file has no caller for, because the map is the
 * fact the drift check holds against the worker and a subset could not be compared to it.
 */
export const journalLevelPrefix = (level: LogLevel): string =>
  process.env.JOURNAL_STREAM ? { debug: '<7>', info: '<6>', warn: '<4>', error: '<3>' }[level] : '';

/**
 * Only `warn`. Every degradation this process has to report is one, and a method with no caller is
 * a thing this repository has had to go looking for too many times already.
 */
export interface Logger {
  warn(event: RunnerEvent, fields?: LogFields): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  now?: () => Date;
}

/** One JSON object per line on stdout, which is what journald stores and `athanor logs` replays. */
export const createLogger = (options: LoggerOptions = {}): Logger => {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  return {
    warn: (event, fields = {}) => {
      write(
        `${journalLevelPrefix('warn')}${JSON.stringify({
          time: now().toISOString(),
          level: 'warn',
          service: 'runner',
          event,
          detail: events[event],
          ...loggableEntries(fields)
        })}`
      );
    }
  };
};

/** The journal this process writes to. */
export const runnerLogger = createLogger();

/**
 * One machine word, or nothing.
 *
 * `code` and `name` are both ordinary writable properties, and a driver is free to put a sentence
 * in either. The shape is the gate rather than the provenance, which is how the worker holds its
 * half of this format too.
 */
const MACHINE_WORD = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The identity of a failure without its wording.
 *
 * The message is what is missing, and deliberately. Every caller here is holding a throw from a
 * browser driver or from the filesystem, and those messages quote back the URL, the selector or
 * the path they failed on. What the owner can act on is in the fields already - that the sandbox
 * is off, that the limiter is absent - so the reason the driver gave is the part worth losing.
 */
export const failureCode = (cause: unknown): string => {
  const carried = (cause as { code?: unknown } | null)?.code;
  if (typeof carried === 'string' && MACHINE_WORD.test(carried)) return carried;
  if (cause instanceof Error && MACHINE_WORD.test(cause.name)) return cause.name;
  return 'unknown';
};
