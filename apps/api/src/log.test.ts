import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GardenError } from '@garden/core';
import { createLogger, errorFields, installProcessGuards, type Logger } from './log.js';

beforeEach(() => vi.stubEnv('JOURNAL_STREAM', undefined));
afterEach(() => vi.unstubAllEnvs());

const capture = (level: Parameters<typeof createLogger>[0]['level'] = 'info') => {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level,
    service: 'api',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date('2026-07-31T12:00:00.000Z')
  });
  return { logger, lines };
};

describe('server logging', () => {
  test('writes one identifying line per event', () => {
    const { logger, lines } = capture();
    logger.info('schedule.dispatched', {
      scheduleId: 'a2b1',
      taskId: 'c3d4',
      durationMs: 42
    });
    expect(lines).toEqual([
      {
        time: '2026-07-31T12:00:00.000Z',
        level: 'info',
        service: 'api',
        event: 'schedule.dispatched',
        scheduleId: 'a2b1',
        taskId: 'c3d4',
        durationMs: 42
      }
    ]);
  });

  test('drops every field that is not on the allowlist', () => {
    const { logger, lines } = capture();
    logger.error('http.error', {
      code: 'request_failed',
      requestId: 'req-9',
      prompt: 'summarise my divorce papers',
      message: 'the assistant replied',
      title: 'Private task',
      apiKey: 'sk-live-000111222333444555666',
      cookie: 'garden_session=abcdef'
    });
    expect(lines[0]).toEqual({
      time: '2026-07-31T12:00:00.000Z',
      level: 'error',
      service: 'api',
      event: 'http.error',
      code: 'request_failed',
      requestId: 'req-9'
    });
    expect(JSON.stringify(lines[0])).not.toContain('divorce');
    expect(JSON.stringify(lines[0])).not.toContain('sk-live');
  });

  test('scrubs a secret that reaches an allowlisted field anyway', () => {
    const { logger, lines } = capture();
    logger.warn('connector.failed', { code: 'Bearer sk-live-000111222333444555666' });
    expect(lines[0]!.code).not.toContain('sk-live');
    expect(lines[0]!.code).toContain('[REDACTED]');
  });

  test('refuses structured values outright', () => {
    const { logger, lines } = capture();
    logger.info('task.action', {
      taskId: 'c3d4',
      // Objects are not part of the field type; a caller that reaches for one gets nothing.
      code: { toString: () => 'leaked' } as unknown as string
    });
    expect(lines[0]).not.toHaveProperty('code');
  });

  test('honours the configured threshold', () => {
    const { logger, lines } = capture('warn');
    logger.debug('http.request', { route: '/v1/tasks' });
    logger.info('api.ready', { port: 4100 });
    logger.warn('maintenance.failed', { code: 'ECONNREFUSED' });
    expect(lines.map((line) => line.event)).toEqual(['maintenance.failed']);
  });

  test('says nothing at all when silenced', () => {
    const { logger, lines } = capture('silent');
    logger.error('process.uncaught_exception', { code: 'Error' });
    expect(lines).toHaveLength(0);
  });
});

describe('error identity in logs', () => {
  test('keeps the Garden code and the frames but never the wording', () => {
    const error = new GardenError('quota_exceeded', 'Task "Email the board" needs 40 credits');
    const fields = errorFields(error);
    expect(fields.code).toBe('quota_exceeded');
    expect(String(fields.frames)).toContain('at ');
    expect(JSON.stringify(fields)).not.toContain('Email the board');
  });

  test('will not accept a line of the message as a stack frame', () => {
    const error = new Error('at the board meeting we discussed acquiring Northwind');
    expect(String(errorFields(error).frames)).not.toContain('Northwind');
  });

  /*
   * A message can be several lines long and one of those lines can be shaped exactly like a frame,
   * which is not a contrivance: an error wrapping a failed subprocess carries that program's trace
   * in its wording, and that trace names the owner's files. Frames picked out by shape published
   * them, because a real frame and a quoted one are the same string. The header tells them apart.
   */
  test('will not accept a quoted trace as this process’s own frames', () => {
    const error = new Error(
      [
        'command failed: node build.js',
        '    at Object.<anonymous> (/home/owner/tax-return-2025/index.js:3:9)',
        '    at Module._compile (node:internal/modules/cjs/loader:1234:14)'
      ].join('\n')
    );
    expect(String(errorFields(error).frames)).not.toContain('tax-return-2025');
    expect(String(errorFields(error).frames)).toContain('log.test.ts');
  });

  test('falls back to a driver code, then to the class name', () => {
    const driverError = Object.assign(new Error('terminating connection'), { code: '57P01' });
    expect(errorFields(driverError).code).toBe('57P01');
    expect(errorFields(new TypeError('x is not a function')).code).toBe('TypeError');
    expect(errorFields('a thrown string').code).toBe('non_error_throw');
  });

  /*
   * `code` looks like the one field on this line nobody could hide anything in, and it is the field
   * two different wires write. `runnerFailure` builds an GardenError whose code is the `code` of
   * whatever JSON the workspace runner answered with, and `name` is a writable property a library
   * may put a sentence in. Both were printed whole, so a runner that quoted the failing command
   * back published it - the same shape of leak as the message, wearing the one field that had
   * always been safe. One machine word, or the line says only that something failed.
   */
  test('will not print a sentence that arrived where a code was expected', () => {
    const fromTheRunner = new GardenError(
      'refused: psql -c "select * from clients" --password=hunter2',
      'the runner said no'
    );
    expect(errorFields(fromTheRunner).code).toBe('api_failed');

    const renamed = new Error('boom');
    renamed.name = 'Failed while reading /home/owner/tax-return-2025/settlement.pdf';
    expect(errorFields(renamed).code).toBe('Error');

    // And the ordinary case is untouched: garden's own vocabulary still reads as itself.
    expect(errorFields(new GardenError('workspace_busy', 'busy')).code).toBe('workspace_busy');
  });
});

describe('process guards', () => {
  const guardTarget = () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const exits: number[] = [];
    return {
      listeners,
      exits,
      on: (event: string, listener: (value: unknown) => void) => {
        listeners.set(event, listener);
      },
      exit: (code: number) => {
        exits.push(code);
      }
    };
  };

  test('logs an unhandled rejection and keeps the process alive', () => {
    const { logger, lines } = capture();
    const target = guardTarget();
    installProcessGuards(logger, target);
    target.listeners.get('unhandledRejection')!(new GardenError('workspace_missing', 'gone'));
    expect(lines[0]).toMatchObject({
      event: 'process.unhandled_rejection',
      code: 'workspace_missing'
    });
    expect(target.exits).toEqual([]);
  });

  test('logs an uncaught exception before letting the process go', () => {
    const { logger, lines } = capture();
    const target = guardTarget();
    installProcessGuards(logger, target);
    target.listeners.get('uncaughtException')!(new Error('boom'));
    expect(lines[0]).toMatchObject({ event: 'process.uncaught_exception', code: 'Error' });
    expect(target.exits).toEqual([1]);
  });

  test('accepts any logger shape the server passes it', () => {
    const seen: string[] = [];
    const logger: Logger = {
      debug: (event) => seen.push(event),
      info: (event) => seen.push(event),
      warn: (event) => seen.push(event),
      error: (event) => seen.push(event)
    };
    const target = guardTarget();
    installProcessGuards(logger, target);
    target.listeners.get('unhandledRejection')!(new Error('boom'));
    expect(seen).toEqual(['process.unhandled_rejection']);
  });
});

describe('a throw that leaves no frames', () => {
  /*
   * The least diagnosable line this logger can emit is a bare code: `{"code":"TypeError"}` and not
   * one word about where it came from. It happens when the thrown value is not an Error, which is
   * exactly the unusual case worth knowing about - and the silence was indistinguishable from an
   * ordinary failure.
   */
  test('names what was thrown when there is no stack to read', () => {
    expect(errorFields({ code: 'TypeError' })).toMatchObject({
      code: 'TypeError',
      thrown: 'plain object'
    });
    expect(errorFields('a bare string')).toMatchObject({ thrown: 'string' });
    expect(errorFields(null)).toMatchObject({ thrown: 'null' });
  });

  test('says nothing extra when the frames are there', () => {
    const fields = errorFields(new Error('ordinary'));
    expect(fields.frames).toBeTruthy();
    expect(fields).not.toHaveProperty('thrown');
  });
});
