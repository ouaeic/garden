import { redactText } from '@garden/core';

/**
 * What every garden process writes to the journal.
 *
 * Two formats used to share this box. The API wrote one JSON object per line, with an allowlist of
 * field names deciding what may appear; this process wrote English sentences, each of them guarding
 * its own values by hand. Both were defensible alone. Together they meant the owner greps twice for
 * one failure, and that half the lines on the box rested on every author remembering the rule
 * rather than on a list that drops what nobody put on it. The lease line is what that costs: it
 * printed the thrown message, so a database that refused a connection published whatever the driver
 * felt like quoting back.
 *
 * The structured line won, and it gained the one thing the sentences had that it lacked - the
 * priority prefix, so `journalctl -p err` still finds a real failure.
 *
 * It lives here rather than in the API because the API depends on this package and not the other
 * way round, and the only other thing both import - `@garden/contracts` - is compiled into the
 * browser bundle, where there is no `process` to read a journal stream or a stdout off.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogThreshold = LogLevel | 'silent';
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

const levelRank: Record<LogThreshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

/**
 * Logs exist so the owner can tie a failure report back to what the process did, and for nothing
 * else. Prompts, messages, titles, file contents, keys, tokens and cookies must never reach a log
 * line, so the field set is an allowlist rather than a denylist: a name nobody put here is dropped
 * instead of printed, which makes an accidental leak a missing field rather than a disclosure.
 * Everything on the list is a random identifier, a code the machine itself chose, or a number.
 */
const loggableFields = new Set([
  'approvalId',
  'attempt',
  /** How many attempts a task gets in all, so `attempt` reads as a fraction of something. */
  'attempts',
  /** Which build produced the line: a version and a revision, and nothing about this box. */
  'build',
  /** Which restore point a line is about: the row's own random id, and nothing about its contents. */
  'checkpointId',
  /** What was thrown, where garden's own vocabulary has no word for it. */
  'class',
  'code',
  'concurrency',
  'count',
  'driver',
  'delayMs',
  'durationMs',
  'frames',
  /** The same stack came round again and was printed further up rather than a second time. */
  'framesRepeated',
  /** What a throw was, when it carried no frames to read. */
  'thrown',
  'kind',
  /** The box's relay address: derived from its own public key, and public in certificate logs. */
  'label',
  'method',
  'modelId',
  'outcome',
  'port',
  'privacyRoute',
  'requestId',
  'resourceClass',
  'route',
  'scheduleId',
  'service',
  'status',
  'statusCode',
  'step',
  'taskId',
  'turn',
  'userId',
  'workerId',
  'workspaceId'
]);

/**
 * Objects and arrays are refused outright: nothing structured on a failure path is worth the risk
 * that one of its branches carries user data. Strings still pass through the shared secret
 * scrubber, so a value that turns out to embed an API key is neutered rather than published.
 */
const safeValue = (value: LogValue): LogValue => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  // Types are a promise, not a guarantee: a logger that throws on an unexpected value would
  // silence the very failure it was called to record.
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
 * between a failed task appearing in `journalctl -p err` and sitting at info among everything else
 * the box says. JOURNAL_STREAM is set by systemd itself, and only when this process's output goes
 * to the journal, so a process started in a terminal writes plain JSON and journald is the only
 * reader that ever sees the marker.
 */
export const journalLevelPrefix = (level: LogLevel): string =>
  process.env.JOURNAL_STREAM ? { debug: '<7>', info: '<6>', warn: '<4>', error: '<3>' }[level] : '';

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level: LogThreshold;
  service?: string;
  write?: (line: string) => void;
  now?: () => Date;
}

/** One JSON object per line on stdout, which is what journald stores and `garden logs` replays. */
export const createLogger = (options: LoggerOptions): Logger => {
  const threshold = levelRank[options.level];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (levelRank[level] < threshold) return;
    write(
      `${journalLevelPrefix(level)}${JSON.stringify({
        time: now().toISOString(),
        level,
        ...(options.service ? { service: options.service } : {}),
        event,
        ...loggableEntries(fields)
      })}`
    );
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields)
  };
};

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/** The journal this process writes to when nobody handed it one. */
export const workerLogger = createLogger({ level: 'info', service: 'worker' });
