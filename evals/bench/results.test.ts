/**
 * The records directory and the row built from it, against directories written here.
 *
 * Every case writes its own records into a temporary directory from the values in this file, so
 * what is asserted is visible beside the assertion, and none of them reaches a container, a
 * provider or the committed `parity.csv`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { COLUMNS, renderCsv, type Arm, type TaskResult } from './parity.js';
import {
  assembleRow,
  parseCsv,
  readCsvRows,
  readTaskRecords,
  taskRecordExists,
  upsertRow,
  writeTaskRecord,
  type TaskRecordFile
} from './results.js';

const scratch: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'garden-results-'));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const resultOf = (
  taskId: string,
  resolved: boolean,
  extra: Partial<TaskResult> = {}
): TaskResult => ({
  taskId,
  resolved,
  costUsd: 0.02,
  inputTokens: 1_000,
  outputTokens: 100,
  steps: 5,
  wallSeconds: 30,
  compactions: 0,
  approvalCardsFired: 0,
  infraFailure: false,
  ...extra
});

const recordOf = (
  arm: Arm,
  runIndex: number,
  taskId: string,
  resolved: boolean,
  overrides: Partial<TaskRecordFile> = {}
): TaskRecordFile => ({
  version: 1,
  benchmark: 'terminal-bench',
  arm,
  runIndex,
  taskId,
  startedAt: `2026-09-03T00:0${String(runIndex)}:00.000Z`,
  identity: { model: 'openrouter/m', modelRoute: 'm', provider: 'openrouter' },
  garden: { version: '0.1.1', commit: 'abc1234' },
  securityMode: arm === 'shipped' ? 'balanced' : 'autonomous',
  autoAnswered: 0,
  autoApproveCapReached: false,
  providerUsageFallbacks: 0,
  result: resultOf(taskId, resolved),
  ranIn: { name: 'docker', isolatesNetwork: false },
  status: 'completed',
  verification: 'verified',
  verifierExit: resolved ? 0 : 1,
  verifierStderr: '',
  commandsRun: 3,
  catalogue: ['shell', 'finish'],
  holds: [],
  pushback: [],
  error: null,
  misses: [],
  absentRequests: 0,
  observedRoutes: ['POST /exec'],
  taskSetMember: {
    id: taskId,
    request: `solve ${taskId}`,
    seed: {},
    verifyCall: { executable: '/bin/sh', args: ['-c', 'true'], cwd: '/app' }
  },
  bounds: { maxSteps: 50, maxCredits: 500, maxSpendUsd: 20 },
  catalogueBytes: 36_853,
  ...overrides
});

const quiet = (): { out: (line: string) => void; lines: string[] } => {
  const lines: string[] = [];
  return { out: (line) => lines.push(line), lines };
};

describe('task records', () => {
  it('writes one record and one events file per (arm, run, task), and reads them back', () => {
    const dir = fresh();
    const record = recordOf('shipped', 0, 'alpha', true);
    const written = writeTaskRecord(dir, 'shipped', 0, record, [
      { kind: 'cost', summary: 'Step 1 completed', payload: { usage: { inputTokens: 1 } } },
      { kind: 'completed', summary: 'Done', payload: {} }
    ]);
    expect(written.record).toBe(path.join(dir, 'shipped', 'run-0', 'alpha.json'));
    expect(taskRecordExists(dir, 'shipped', 0, 'alpha')).toBe(true);
    expect(taskRecordExists(dir, 'shipped', 1, 'alpha')).toBe(false);
    expect(readFileSync(written.events, 'utf8').trim().split('\n')).toHaveLength(2);
    const read = readTaskRecords(dir, 'shipped');
    expect(read).toHaveLength(1);
    expect(read[0]?.record).toEqual(record);
    expect(readTaskRecords(dir, 'unattended')).toEqual([]);
  });

  it('refuses a record that sits under the wrong arm or run directory', () => {
    const dir = fresh();
    writeTaskRecord(dir, 'shipped', 0, recordOf('autonomous', 0, 'alpha', true), []);
    expect(() => readTaskRecords(dir, 'shipped')).toThrow(/says arm autonomous/);
  });
});

describe('assembling a row', () => {
  const tasks = ['alpha', 'beta', 'gamma'];

  it('scores a task with no record 0 in that run, keeps the denominator, and prints it', () => {
    const dir = fresh();
    writeTaskRecord(dir, 'shipped', 0, recordOf('shipped', 0, 'alpha', true), []);
    writeTaskRecord(dir, 'shipped', 0, recordOf('shipped', 0, 'beta', true), []);
    writeTaskRecord(dir, 'shipped', 0, recordOf('shipped', 0, 'gamma', false), []);
    writeTaskRecord(dir, 'shipped', 1, recordOf('shipped', 1, 'alpha', true), []);
    // run-1 never recorded beta or gamma.
    const { out, lines } = quiet();
    const assembled = assembleRow({ dir, arm: 'shipped', runs: 2, taskIds: tasks, out });
    expect(assembled.refusal).toBeNull();
    expect(assembled.missing).toEqual([
      { runIndex: 1, taskId: 'beta' },
      { runIndex: 1, taskId: 'gamma' }
    ]);
    expect(lines.filter((line) => line.includes('MISSING'))).toHaveLength(2);
    expect(lines.some((line) => line.includes('run-1 beta'))).toBe(true);
    const cell = (column: string): string => assembled.row?.[COLUMNS.indexOf(column)] ?? '';
    // run-0: 2/3. run-1: 1/3 with the two missing at 0. Mean 0.5, denominator 3 both times.
    expect(cell('n_tasks')).toBe('3');
    expect(cell('n_runs')).toBe('2');
    expect(cell('score_mean')).toBe('0.5');
    expect(cell('infra_failures_advisory')).toBe('2');
    expect(assembled.input?.runs[1]?.tasks.map((task) => task.resolved)).toEqual([
      true,
      null,
      null
    ]);
  });

  it('refuses records for tasks outside the declared set, and prints records beyond --runs', () => {
    const dir = fresh();
    writeTaskRecord(dir, 'shipped', 0, recordOf('shipped', 0, 'alpha', true), []);
    writeTaskRecord(dir, 'shipped', 0, recordOf('shipped', 0, 'beta', false), []);
    writeTaskRecord(dir, 'shipped', 0, recordOf('shipped', 0, 'gamma', true), []);
    writeTaskRecord(dir, 'shipped', 1, recordOf('shipped', 1, 'alpha', true), []);
    const { out, lines } = quiet();
    // The unresolved task left out of the declared set: a 1.0 row about two thirds of the run.
    const bad = assembleRow({ dir, arm: 'shipped', runs: 1, taskIds: ['alpha', 'gamma'], out });
    expect(bad.row).toBeNull();
    expect(bad.refusal).toMatch(/not in the declared set/);
    expect(bad.refusal).toMatch(/run-0 beta/);
    // Every recorded task declared: a row, with the record in the run-index beyond --runs named
    // and left out rather than refused - a third run still in progress is a legitimate state.
    const good = assembleRow({ dir, arm: 'shipped', runs: 1, taskIds: tasks, out });
    expect(good.refusal).toBeNull();
    expect(lines.some((line) => line.includes('IGNORED run-1 alpha'))).toBe(true);
    const cell = (column: string): string => good.row?.[COLUMNS.indexOf(column)] ?? '';
    expect(cell('n_tasks')).toBe('3');
    expect(cell('n_runs')).toBe('1');
    expect(Number(cell('score_mean'))).toBeCloseTo(2 / 3, 3);
  });

  it('refuses records from two boxes', () => {
    const dir = fresh();
    writeTaskRecord(dir, 'shipped', 0, recordOf('shipped', 0, 'alpha', true), []);
    writeTaskRecord(
      dir,
      'shipped',
      1,
      recordOf('shipped', 1, 'alpha', true, { ranIn: { name: 'local', isolatesNetwork: false } }),
      []
    );
    const { out } = quiet();
    const assembled = assembleRow({ dir, arm: 'shipped', runs: 2, taskIds: ['alpha'], out });
    expect(assembled.row).toBeNull();
    expect(assembled.refusal).toMatch(/2 different backends/);
  });

  it('refuses records from two builds and from two models', () => {
    const dir = fresh();
    writeTaskRecord(dir, 'shipped', 0, recordOf('shipped', 0, 'alpha', true), []);
    writeTaskRecord(
      dir,
      'shipped',
      1,
      recordOf('shipped', 1, 'alpha', true, { garden: { version: '0.1.1', commit: 'fff9999' } }),
      []
    );
    const { out } = quiet();
    expect(
      assembleRow({ dir, arm: 'shipped', runs: 2, taskIds: ['alpha'], out, sameBuild: () => false })
        .refusal
    ).toMatch(/2 different garden commits/);
    const other = fresh();
    writeTaskRecord(other, 'shipped', 0, recordOf('shipped', 0, 'alpha', true), []);
    writeTaskRecord(
      other,
      'shipped',
      1,
      recordOf('shipped', 1, 'alpha', true, {
        identity: { model: 'openrouter/n', modelRoute: 'n', provider: 'openrouter' }
      }),
      []
    );
    expect(
      assembleRow({ dir: other, arm: 'shipped', runs: 2, taskIds: ['alpha'], out }).refusal
    ).toMatch(/2 different models/);
  });

  it('shares a row across commits whose shipped code is identical, and names the newer one', () => {
    /*
     * The instrument changed, the loop did not: a shim fix landed between one task's re-run and
     * the fifty-eight records beside it. What git says about apps, packages and services is the
     * question; here it is answered by hand in both directions.
     */
    const dir = fresh();
    writeTaskRecord(dir, 'shipped', 0, recordOf('shipped', 0, 'alpha', true), []);
    writeTaskRecord(
      dir,
      'shipped',
      1,
      recordOf('shipped', 1, 'alpha', true, { garden: { version: '0.1.1', commit: 'fff9999' } }),
      []
    );
    const shared = quiet();
    const assembled = assembleRow({
      dir,
      arm: 'shipped',
      runs: 2,
      taskIds: ['alpha'],
      sameBuild: () => true,
      out: shared.out
    });
    expect(assembled.refusal).toBeNull();
    expect(assembled.row?.[COLUMNS.indexOf('garden_commit')]).toBe('fff9999');
    expect(shared.lines.some((line) => line.includes('byte-identical'))).toBe(true);
    const refused = assembleRow({
      dir,
      arm: 'shipped',
      runs: 2,
      taskIds: ['alpha'],
      sameBuild: () => false,
      out: quiet().out
    });
    expect(refused.refusal).toMatch(/2 different garden commits/);
  });

  it('passes rowFrom for unattended with cards auto-answered, and is refused for shipped', () => {
    const answered = (arm: Arm, runIndex: number, id: string): TaskRecordFile =>
      recordOf(arm, runIndex, id, true, {
        autoAnswered: 2,
        result: resultOf(id, true, { approvalCardsFired: 2, approvalsAutoAnswered: 2 })
      });
    const unattended = fresh();
    writeTaskRecord(unattended, 'unattended', 0, answered('unattended', 0, 'alpha'), []);
    writeTaskRecord(unattended, 'unattended', 0, answered('unattended', 0, 'beta'), []);
    const { out } = quiet();
    const good = assembleRow({
      dir: unattended,
      arm: 'unattended',
      runs: 1,
      taskIds: ['alpha', 'beta'],
      out
    });
    expect(good.refusal).toBeNull();
    const cell = (column: string): string => good.row?.[COLUMNS.indexOf(column)] ?? '';
    expect(cell('approvals_auto_answered')).toBe('4');
    expect(cell('security_mode')).toBe('autonomous');
    expect(cell('approval_cards_fired_mean')).toBe('2');

    const shipped = fresh();
    // The same records labelled shipped: balanced mode, and yet cards were answered.
    writeTaskRecord(
      shipped,
      'shipped',
      0,
      { ...answered('unattended', 0, 'alpha'), arm: 'shipped', securityMode: 'balanced' },
      []
    );
    const bad = assembleRow({ dir: shipped, arm: 'shipped', runs: 1, taskIds: ['alpha'], out });
    expect(bad.row).toBeNull();
    expect(bad.refusal).toMatch(/auto-answered under arm "shipped"/);
  });

  it('refuses an unattended row where cards fired and none were answered', () => {
    const dir = fresh();
    writeTaskRecord(
      dir,
      'unattended',
      0,
      recordOf('unattended', 0, 'alpha', false, {
        result: resultOf('alpha', false, { approvalCardsFired: 1 })
      }),
      []
    );
    const { out } = quiet();
    const assembled = assembleRow({ dir, arm: 'unattended', runs: 1, taskIds: ['alpha'], out });
    expect(assembled.row).toBeNull();
    expect(assembled.refusal).toMatch(/none auto-answered/);
  });

  it('refuses a loaded task set whose digest differs from the records', () => {
    const dir = fresh();
    writeTaskRecord(dir, 'shipped', 0, recordOf('shipped', 0, 'alpha', true), []);
    const { out } = quiet();
    const assembled = assembleRow({
      dir,
      arm: 'shipped',
      runs: 1,
      taskIds: ['alpha'],
      taskSet: [
        {
          id: 'alpha',
          request: 'a different prompt',
          seed: {},
          verifyCall: { executable: '/bin/sh', args: ['-c', 'true'], cwd: '/app' }
        }
      ],
      out
    });
    expect(assembled.row).toBeNull();
    expect(assembled.refusal).toMatch(/not the tasks that were run/);
  });
});

describe('the CSV, kept', () => {
  const rowFor = (overrides: Readonly<Record<string, string>>): string[] =>
    COLUMNS.map((column) => overrides[column] ?? '');
  const key = {
    benchmark: 'terminal-bench',
    task_set_sha: 'abcd',
    model: 'openrouter/m',
    garden_commit: 'abc1234',
    n_runs: '3'
  };

  it('parses what renderCsv writes, quotes and all', () => {
    const row = rowFor({
      ...key,
      arm: 'shipped',
      declared_drops: 'a, "quoted" drop; another\nline'
    });
    expect(parseCsv(renderCsv([row]))).toEqual([[...COLUMNS], row]);
  });

  it('replaces the row with the same key, keeps the others, and orders by arm', () => {
    const csv = path.join(fresh(), 'parity.csv');
    upsertRow(csv, rowFor({ ...key, arm: 'unattended', score_mean: '0.5' }));
    upsertRow(csv, rowFor({ ...key, arm: 'shipped', score_mean: '0.25' }));
    const first = upsertRow(csv, rowFor({ ...key, arm: 'autonomous', score_mean: '0.3' }));
    expect(first).toEqual({ replaced: false, rows: 3 });
    // The same shipped measurement re-done replaces the old row rather than adding a fourth.
    const again = upsertRow(csv, rowFor({ ...key, arm: 'shipped', score_mean: '0.35' }));
    expect(again).toEqual({ replaced: true, rows: 3 });
    // A different build is another row, not a replacement.
    const other = upsertRow(
      csv,
      rowFor({ ...key, garden_commit: 'def5678', arm: 'shipped', score_mean: '0.4' })
    );
    expect(other).toEqual({ replaced: false, rows: 4 });
    const rows = readCsvRows(csv);
    const arm = COLUMNS.indexOf('arm');
    const score = COLUMNS.indexOf('score_mean');
    expect(rows.map((row) => [row[arm], row[score]])).toEqual([
      ['shipped', '0.35'],
      ['shipped', '0.4'],
      ['autonomous', '0.3'],
      ['unattended', '0.5']
    ]);
    expect(readFileSync(csv, 'utf8').split('\n')[0]).toBe(COLUMNS.join(','));
  });

  it('reads an absent or header-only file as no rows, and refuses a foreign header', () => {
    const dir = fresh();
    expect(readCsvRows(path.join(dir, 'missing.csv'))).toEqual([]);
    const headerOnly = path.join(dir, 'header.csv');
    writeFileSync(headerOnly, renderCsv([]));
    expect(readCsvRows(headerOnly)).toEqual([]);
    const foreign = path.join(dir, 'foreign.csv');
    writeFileSync(foreign, 'a,b,c\n1,2,3\n');
    expect(() => readCsvRows(foreign)).toThrow(/header this rig does not write/);
  });
});
