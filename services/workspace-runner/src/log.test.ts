import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, failureCode, journalLevelPrefix, type RunnerEvent } from './log.js';

const capture = () => {
  const lines: string[] = [];
  return {
    logger: createLogger({
      write: (line) => lines.push(line),
      now: () => new Date('2026-08-12T09:00:00.000Z')
    }),
    lines
  };
};

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Every file this process actually runs: the tests and the journal module itself are not it. */
const productionSources = async (): Promise<{ name: string; text: string }[]> => {
  const names = (await readdir(sourceDirectory)).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'log.ts'
  );
  expect(names.length).toBeGreaterThan(0);
  return Promise.all(
    names.map(async (name) => ({
      name,
      text: await readFile(path.join(sourceDirectory, name), 'utf8')
    }))
  );
};

describe('the journal this process writes', () => {
  beforeEach(() => {
    vi.stubEnv('JOURNAL_STREAM', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes one identifying object per line, still saying what the prose said', () => {
    const { logger, lines } = capture();
    logger.warn('command.limits_unavailable', { executable: '/usr/bin/prlimit' });
    expect(JSON.parse(lines[0]!)).toEqual({
      time: '2026-08-12T09:00:00.000Z',
      level: 'warn',
      service: 'runner',
      event: 'command.limits_unavailable',
      detail:
        'the resource limiter is missing, so commands run without memory, file-size and process limits. Install util-linux to restore them.',
      executable: '/usr/bin/prlimit'
    });
  });

  /**
   * The hardest honest case for the allowlist is the browser line, which is the one carrying the
   * most fields and the one raised closest to a page nobody here wrote. A guard that dropped any
   * of these would leave the owner told that something degraded and not which workspace, not
   * whether a screen was involved, and not whether the sandbox survived - which is all of what
   * makes the line worth writing.
   */
  it('keeps every field the degraded browser launch is worth reporting', () => {
    const { logger, lines } = capture();
    logger.warn('browser.reduced_launch', {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      headless: true,
      sandbox: false,
      code: 'Error'
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      headless: true,
      sandbox: false,
      code: 'Error'
    });
  });

  it('drops every field that is not on the allowlist', () => {
    const { logger, lines } = capture();
    logger.warn('browser.frame_scan_failed', {
      code: 'TimeoutError',
      url: 'https://bank.example/statements/2026-07',
      selector: '#account-balance',
      pageText: 'Balance: 12,904.11'
    } as never);
    expect(JSON.parse(lines[0]!)).toEqual({
      time: '2026-08-12T09:00:00.000Z',
      level: 'warn',
      service: 'runner',
      event: 'browser.frame_scan_failed',
      detail: 'a frame could not be scanned for controls',
      code: 'TimeoutError'
    });
  });

  it('scrubs a secret that reaches an allowlisted field anyway', () => {
    const { logger, lines } = capture();
    logger.warn('command.limits_unavailable', {
      executable: 'https://jo:app-password@cloud.example/prlimit'
    });
    expect(lines[0]).not.toContain('app-password');
    expect(lines[0]).toContain('[REDACTED]');
  });

  /**
   * Without the prefix every one of these sits at the default priority, and
   * `journalctl -p warning -u garden-runner` - the first thing anybody runs on a box that is
   * misbehaving - answers that the runner has never had anything to report.
   */
  it('marks the priority for journald, and only when journald is reading', () => {
    const { logger, lines } = capture();
    vi.stubEnv('JOURNAL_STREAM', '8:1234567');
    logger.warn('browser.reduced_launch', { headless: true, sandbox: true });
    expect(lines[0]!.startsWith('<4>')).toBe(true);
    expect(JSON.parse(lines[0]!.slice(3))).toMatchObject({ level: 'warn' });
    // The whole map, because it is what `scripts/check-repository.mjs` holds against the worker's.
    expect(journalLevelPrefix('debug')).toBe('<7>');
    expect(journalLevelPrefix('info')).toBe('<6>');
    expect(journalLevelPrefix('warn')).toBe('<4>');
    expect(journalLevelPrefix('error')).toBe('<3>');
    vi.stubEnv('JOURNAL_STREAM', undefined);
    // Started in a terminal there is no journal to file anything in, so the line is JSON and
    // nothing else - a runner run by hand must not print `<4>` at the owner.
    logger.warn('browser.reduced_launch', { headless: true, sandbox: true });
    expect(lines[1]!.startsWith('{')).toBe(true);
    expect(journalLevelPrefix('warn')).toBe('');
  });
});

describe('the identity of a failure without its wording', () => {
  it('prefers the errno the system gave, then the class, and never a sentence', () => {
    expect(
      failureCode(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
    ).toBe('EACCES');
    expect(failureCode(Object.assign(new Error('nope'), { code: 'ENOTDIR' }))).toBe('ENOTDIR');
    expect(failureCode(new TypeError('nope'))).toBe('TypeError');
    // A driver is free to put its whole complaint in either property, and that complaint is where
    // the URL and the path it failed on live.
    expect(
      failureCode({ code: 'Failed to launch chromium because /home/jo/notes.pdf was open' })
    ).toBe('unknown');
    expect(failureCode('a bare string')).toBe('unknown');
    expect(failureCode(undefined)).toBe('unknown');
  });
});

/**
 * The two directions the last eleven of these were found in.
 *
 * A journal line that nothing raises is a fiction, and a degradation still printed as prose is the
 * defect this module was written to close - the runner had said all of these out loud for months
 * and `journalctl -p warning` never returned one of them.
 */
describe('the wiring at both ends', () => {
  it('raises every event it defines from somewhere this process runs', async () => {
    const sources = await productionSources();
    const declared = [
      ...(await readFile(path.join(sourceDirectory, 'log.ts'), 'utf8')).matchAll(
        /^ {2}'([a-z_]+\.[a-z_]+)':/gm
      )
    ].map((match) => match[1] as RunnerEvent);
    expect(declared.length).toBeGreaterThan(0);
    const orphaned = declared.filter(
      (event) => !sources.some(({ text }) => text.includes(`'${event}'`))
    );
    expect(orphaned).toEqual([]);
  });

  it('leaves no degradation still going out as unprioritised prose', async () => {
    const shouting = (await productionSources())
      .filter(({ text }) => /console\.(warn|error)\(/.test(text))
      .map(({ name }) => name);
    expect(shouting).toEqual([]);
  });
});
