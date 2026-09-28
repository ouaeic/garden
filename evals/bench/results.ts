/**
 * Execution and assembly, separated: one JSON record per task as it finishes, and a row built from
 * the records afterwards.
 *
 * WHY THE SEPARATION EXISTS. The first paid run drove twenty tasks through one process, held every
 * result in memory, and wrote one row at the end - so a process that died on task nineteen had
 * nothing to show for the eighteen before it, and a second process could not help because the row
 * was assembled from a single in-memory list. It also read cost off the provider account's running
 * total, which is one number for the whole key: two processes sharing a key cannot tell whose calls
 * moved it. The arm ladder needs three arms times three runs, sequential within a process (see
 * `scoreRun`), and at the measured 417 s a task that is a day of wall clock in one process. Several
 * processes on disjoint (arm, run-index) pairs is the only way to finish it, and that needs cost
 * attributable per task and a row that can be built from files rather than from a process.
 *
 * So a run WRITES and an assembler READS, and the two never share a process:
 *
 *   DIR/<arm>/run-<i>/<taskId>.json          everything the row needs about this task
 *   DIR/<arm>/run-<i>/<taskId>.events.jsonl  the loop's own events, one per line
 *
 * A task whose record exists is skipped by the next run of the same (arm, run-index), which is the
 * whole of resumability: a crashed process loses the task it was in and nothing else. The events
 * file is what the edit-format lane asked for - the refusals a real turn's `file_edit` produced are
 * in the events and nowhere else.
 *
 * WHAT ASSEMBLY REFUSES. One box, one build, one model per row. A row carries a single `backend`, a
 * single `garden_commit` and a single `model` column, and every number in it is read as being
 * about that triple. Records that disagree on any of the three are two measurements, and averaging
 * them puts a claim on the row that was true of neither half - the same refusal `scoreRun` makes
 * for mixed boxes within one process, applied across processes.
 *
 * A task with no record in a run-index is not dropped: it is present in the run with
 * `resolved: null`, so `scoreOf` scores it 0 against the declared denominator (discipline 2 in
 * `parity.ts`), and the assembler prints which they were. A missing record is a task the harness
 * failed to produce a verdict for, whatever the reason, and the row is the worse for it exactly as
 * it should be.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  ARM_SECURITY_MODE,
  COLUMNS,
  renderCsv,
  rowFrom,
  type Arm,
  type RowInput,
  type RunRecord,
  type TaskResult
} from './parity.js';
import { rowInputFrom, taskSetShaOf, type TaskSetMember } from './score.js';
import { createHash } from 'node:crypto';

/** The record version, so a reader of an old directory is told rather than misled. */
export const TASK_RECORD_VERSION = 1;

export interface TaskRecordFile {
  readonly version: typeof TASK_RECORD_VERSION;
  readonly benchmark: string;
  readonly arm: Arm;
  readonly runIndex: number;
  readonly taskId: string;
  readonly startedAt: string;
  /** Who answered: the columns that name the run. */
  readonly identity: {
    readonly model: string;
    readonly modelRoute: string;
    readonly provider: string;
  };
  /** Which garden produced it. */
  readonly garden: { readonly version: string; readonly commit: string };
  readonly securityMode: 'review' | 'balanced' | 'autonomous';
  /** Cards the auto-approver answered on this task. Zero under any arm but `unattended`. */
  readonly autoAnswered: number;
  /** Whether the auto-approver's re-entry ceiling was reached, which ends the task parked. */
  readonly autoApproveCapReached: boolean;
  /** Provider calls priced from the loop's ledger because the response carried no usage frame. */
  readonly providerUsageFallbacks: number;
  readonly result: TaskResult;
  readonly ranIn: { readonly name: string; readonly isolatesNetwork: boolean };
  readonly status: string;
  readonly verification: string;
  readonly verifierExit: number | null;
  readonly verifierStderr: string;
  readonly commandsRun: number;
  readonly catalogue: readonly string[];
  readonly holds: readonly string[];
  readonly pushback: readonly string[];
  readonly error: string | null;
  readonly misses: readonly string[];
  readonly absentRequests: number;
  readonly observedRoutes: readonly string[];
  /** What decides what solving this task means; the task-set digest is computed over these. */
  readonly taskSetMember: TaskSetMember;
  readonly bounds: {
    readonly maxSteps: number;
    readonly maxCredits: number;
    /** The process's spend ceiling, which with parallel processes is a global one. */
    readonly maxSpendUsd: number | null;
  };
  /** The benchmark box's catalogue in bytes, measured on the checkout that ran the task. */
  readonly catalogueBytes: number;
}

export interface TaskEvent {
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
}

export const runDirectory = (dir: string, arm: Arm, runIndex: number): string =>
  path.join(dir, arm, `run-${String(runIndex)}`);

export const taskRecordPath = (dir: string, arm: Arm, runIndex: number, taskId: string): string =>
  path.join(runDirectory(dir, arm, runIndex), `${taskId}.json`);

export const taskEventsPath = (dir: string, arm: Arm, runIndex: number, taskId: string): string =>
  path.join(runDirectory(dir, arm, runIndex), `${taskId}.events.jsonl`);

/** Whether this (arm, run-index, task) already has a record, which is what makes a run resumable. */
export const taskRecordExists = (
  dir: string,
  arm: Arm,
  runIndex: number,
  taskId: string
): boolean => existsSync(taskRecordPath(dir, arm, runIndex, taskId));

/**
 * One record and its events, written as the task finishes.
 *
 * The events go to their own file rather than into the record: a long turn's events run to
 * megabytes, and the assembler reads every record of every run to build a row and needs none of
 * them.
 */
export const writeTaskRecord = (
  dir: string,
  arm: Arm,
  runIndex: number,
  record: TaskRecordFile,
  events: readonly TaskEvent[]
): { readonly record: string; readonly events: string } => {
  mkdirSync(runDirectory(dir, arm, runIndex), { recursive: true });
  const recordPath = taskRecordPath(dir, arm, runIndex, record.taskId);
  const eventsPath = taskEventsPath(dir, arm, runIndex, record.taskId);
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(eventsPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  return { record: recordPath, events: eventsPath };
};

export interface ReadTaskRecord {
  readonly runIndex: number;
  readonly record: TaskRecordFile;
}

/**
 * Every record under DIR/<arm>, whichever run-index directories exist.
 *
 * A file that is not a record of this version is a refusal rather than a skip: silently ignoring
 * it would turn a directory written by a different version of this rig into a row of missing
 * tasks, which scores 0 with no hint of why.
 */
export const readTaskRecords = (dir: string, arm: Arm): readonly ReadTaskRecord[] => {
  const armDirectory = path.join(dir, arm);
  if (!existsSync(armDirectory)) return [];
  const found: ReadTaskRecord[] = [];
  for (const entry of readdirSync(armDirectory, { withFileTypes: true })) {
    const match = /^run-(\d+)$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const runIndex = Number(match[1]);
    const runPath = path.join(armDirectory, entry.name);
    for (const file of readdirSync(runPath)) {
      if (!file.endsWith('.json')) continue;
      const parsed = JSON.parse(
        readFileSync(path.join(runPath, file), 'utf8')
      ) as Partial<TaskRecordFile>;
      if (parsed.version !== TASK_RECORD_VERSION)
        throw new Error(
          `${path.join(runPath, file)} is a version ${String(parsed.version)} record and this rig reads version ${String(TASK_RECORD_VERSION)}. No row.`
        );
      if (parsed.arm !== arm || parsed.runIndex !== runIndex)
        throw new Error(
          `${path.join(runPath, file)} says arm ${String(parsed.arm)} run ${String(parsed.runIndex)} and sits under ${arm}/run-${String(runIndex)}. No row.`
        );
      found.push({ runIndex, record: parsed as TaskRecordFile });
    }
  }
  return found;
};

/** The result a run has for a task it never recorded: no verdict, and scored 0 for it. */
const missingResult = (taskId: string): TaskResult => ({
  taskId,
  resolved: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  steps: null,
  wallSeconds: null,
  compactions: null,
  approvalCardsFired: null,
  // A record that was never written is a process that did not finish the task, whatever stopped
  // it. Advisory, like every infra flag: it moves no denominator and is printed beside the row.
  infraFailure: true
});

export interface AssembleOptions {
  readonly dir: string;
  readonly arm: Arm;
  /** How many run-indexes the row claims: 0..runs-1, every one of them scored. */
  readonly runs: number;
  /** The declared task set, in order. The denominator, and the order the digest is taken in. */
  readonly taskIds: readonly string[];
  /**
   * The task set as loaded from the benchmark's own directory, when the caller has it. The digest
   * is recomputed from it and must agree with the digest over the records' own members, so a row
   * cannot claim a task set the records were not run on.
   */
  readonly taskSet?: readonly TaskSetMember[] | undefined;
  readonly out: (line: string) => void;
  /**
   * Whether two commits ship the same loop.
   *
   * A row is one build, and the build is the code that RAN - `apps`, `packages` and `services` -
   * not the label on the checkout. The first ladder had two of nine rows voided by a shim gap,
   * the shim was fixed and the two tasks re-run, and the re-run records then carried the fixing
   * commit while the other fifty-eight carried the one before it. Refusing that row would have
   * said the loop changed when only the instrument had. So records from different commits share a
   * row exactly when git says the shipped trees are byte-identical between every pair, and the
   * row names the newest of them. Absent, the question is asked of git; a test hands in an answer.
   */
  readonly sameBuild?: ((a: string, b: string) => boolean) | undefined;
}

/** Asks git whether the code that runs is identical between two commits. Unknown commits are not. */
export const shippedTreesAgree = (a: string, b: string): boolean => {
  try {
    execFileSync('git', ['diff', '--quiet', a, b, '--', 'apps', 'packages', 'services'], {
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
};

/** The later of two commits by ancestry, or `b` when git cannot say. */
const laterCommit = (a: string, b: string): string => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
    return b;
  } catch {
    return a;
  }
};

export interface AssembledRow {
  readonly input: RowInput | null;
  readonly row: readonly string[] | null;
  readonly refusal: string | null;
  /** (run-index, task id) pairs with no record, each present in the row at 0. */
  readonly missing: ReadonlyArray<{ readonly runIndex: number; readonly taskId: string }>;
}

const distinct = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * The row, from the records, or a refusal.
 *
 * Refusals here are the cross-process ones - mixed box, mixed build, mixed model, a task set the
 * records do not agree on - and then `rowFrom`'s own. Both are printed as the row's absence rather
 * than softened into a row with a caveat, because a caveat is not a column.
 */
export const assembleRow = (options: AssembleOptions): AssembledRow => {
  if (!Number.isInteger(options.runs) || options.runs <= 0)
    return { input: null, row: null, refusal: 'a row needs at least one run', missing: [] };
  if (options.taskIds.length === 0)
    return { input: null, row: null, refusal: 'a row needs a declared task set', missing: [] };
  const all = readTaskRecords(options.dir, options.arm);
  const wanted = new Set(options.taskIds);
  /*
   * A record for a task OUTSIDE the declared set, in a run-index the row claims, is a refusal.
   *
   * The declared set is the denominator, and a caller who declares five ids over a directory that
   * holds twenty records has typed a row about five tasks out of a run of twenty - a 1.0 with
   * nothing on the row or in the output saying fifteen were left out. Measured: a directory with
   * three records, one unresolved, assembled with the two resolved ids printed `score_mean=1`,
   * exit 0, and upserted a second row beside the honest one (the task-set digest differs, so the
   * key does). The records are the run; the row is over every task the run recorded, or it is
   * not this run's row. A record in a run-index BEYOND `--runs` is different: a third run still in
   * progress while a two-run row is built is a legitimate state, so those are printed and left out
   * rather than refused.
   */
  const stray = all.filter((one) => one.runIndex < options.runs && !wanted.has(one.record.taskId));
  if (stray.length)
    return {
      input: null,
      row: null,
      refusal: `${String(stray.length)} record(s) under ${path.join(options.dir, options.arm)} are for task(s) not in the declared set: ${stray
        .map((one) => `run-${String(one.runIndex)} ${one.record.taskId}`)
        .join(
          ', '
        )}. The declared set is the row's denominator, so a record left out of it would make the row about fewer tasks than were run. Declare every task the run recorded, or move the records. No row.`,
      missing: []
    };
  for (const one of all.filter((one) => one.runIndex >= options.runs))
    options.out(
      `  IGNORED run-${String(one.runIndex)} ${one.record.taskId}: run-index beyond --runs ${String(options.runs)}, not in the row`
    );
  const records = all.filter((one) => one.runIndex < options.runs && wanted.has(one.record.taskId));
  if (records.length === 0)
    return {
      input: null,
      row: null,
      refusal: `no record under ${runDirectory(options.dir, options.arm, 0)} (or any run-index below ${String(options.runs)}) names a task in the declared set. No row.`,
      missing: []
    };

  const refuseMixed = (what: string, values: readonly string[]): string | null =>
    values.length > 1
      ? `these records were produced on ${String(values.length)} different ${what}s (${values.join(', ')}), so no single ${what} column is true of the row: one box, one build, one model per row. No row.`
      : null;
  const sameBuild = options.sameBuild ?? shippedTreesAgree;
  let buildCommit: string | null = null;
  const refuseMixedBuild = (commits: readonly string[]): string | null => {
    if (commits.length <= 1) return null;
    const pairs = commits.flatMap((a, i) => commits.slice(i + 1).map((b) => [a, b] as const));
    if (!pairs.every(([a, b]) => sameBuild(a, b))) return refuseMixed('garden commit', commits);
    buildCommit = commits.reduce((newest, commit) =>
      options.sameBuild ? commit : laterCommit(newest, commit)
    );
    options.out(
      `  records carry ${String(commits.length)} commits (${commits.join(', ')}) whose apps, packages and services are byte-identical; the row names ${buildCommit}`
    );
    return null;
  };
  const mixed =
    refuseMixed(
      'backend',
      distinct(
        records.map((one) => `${one.record.ranIn.name}/${String(one.record.ranIn.isolatesNetwork)}`)
      )
    ) ??
    refuseMixedBuild(distinct(records.map((one) => one.record.garden.commit))) ??
    refuseMixed('model', distinct(records.map((one) => one.record.identity.model))) ??
    refuseMixed('benchmark', distinct(records.map((one) => one.record.benchmark))) ??
    refuseMixed('security mode', distinct(records.map((one) => one.record.securityMode)));
  if (mixed) return { input: null, row: null, refusal: mixed, missing: [] };

  /*
   * The task set, from the records. Each task's member must read the same in every run that
   * recorded it - the same prompt, seed and verifier - or the runs solved different tasks under one
   * id, and the digest over them would be a digest over nothing.
   */
  const members = new Map<string, TaskSetMember>();
  for (const one of records) {
    const known = members.get(one.record.taskId);
    const mine = one.record.taskSetMember;
    if (known && JSON.stringify(known) !== JSON.stringify(mine))
      return {
        input: null,
        row: null,
        refusal: `task "${one.record.taskId}" is not the same task in every run (prompt, seed or verifier differ between records). No row.`,
        missing: []
      };
    members.set(one.record.taskId, mine);
  }
  const unrecorded = options.taskIds.filter((id) => !members.has(id));
  if (options.taskSet === undefined && unrecorded.length)
    return {
      input: null,
      row: null,
      refusal: `no run recorded ${unrecorded.join(', ')}, so the task set cannot be digested from the records alone; pass --root to load the task set from the benchmark directory. No row.`,
      missing: []
    };
  const ordered: TaskSetMember[] = [];
  for (const id of options.taskIds) {
    const member = members.get(id) ?? options.taskSet?.find((one) => one.id === id);
    if (!member)
      return {
        input: null,
        row: null,
        refusal: `task "${id}" is in neither the records nor the loaded task set. No row.`,
        missing: []
      };
    ordered.push(member);
  }
  const taskSetSha = taskSetShaOf(ordered);
  if (options.taskSet !== undefined) {
    const loaded = options.taskIds.map((id) => options.taskSet?.find((one) => one.id === id));
    if (loaded.some((one) => one === undefined))
      return {
        input: null,
        row: null,
        refusal: `the loaded task set does not contain every declared task id. No row.`,
        missing: []
      };
    const loadedSha = taskSetShaOf(loaded as TaskSetMember[]);
    if (loadedSha !== taskSetSha)
      return {
        input: null,
        row: null,
        refusal: `the task set loaded from --root digests to ${loadedSha} and the records' own to ${taskSetSha}: the tasks on disk are not the tasks that were run. No row.`,
        missing: []
      };
  }

  const missing: Array<{ runIndex: number; taskId: string }> = [];
  const runs: RunRecord[] = [];
  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    const mine = new Map(
      records
        .filter((one) => one.runIndex === runIndex)
        .map((one) => [one.record.taskId, one.record] as const)
    );
    const tasks = options.taskIds.map((id) => {
      const record = mine.get(id);
      if (!record) {
        missing.push({ runIndex, taskId: id });
        return missingResult(id);
      }
      return record.result;
    });
    runs.push({
      startedAt:
        [...mine.values()].map((one) => one.startedAt).sort()[0] ?? new Date(0).toISOString(),
      tasks
    });
  }
  for (const gap of missing)
    options.out(
      `  MISSING run-${String(gap.runIndex)} ${gap.taskId}: no record, present in the row at 0`
    );

  const first = records[0]?.record;
  if (!first) return { input: null, row: null, refusal: 'no record', missing };
  const input = rowInputFrom({
    benchmark: first.benchmark,
    taskIds: options.taskIds,
    taskSetSha,
    nTasks: options.taskIds.length,
    model: first.identity.model,
    modelRoute: first.identity.modelRoute,
    provider: first.identity.provider,
    harnessVersion: first.garden.version,
    harnessCommit: buildCommit ?? first.garden.commit,
    arm: options.arm,
    securityMode: first.securityMode,
    approvalsAutoAnswered: records.reduce((total, one) => total + one.record.autoAnswered, 0),
    taskMaxSteps: Math.max(...records.map((one) => one.record.bounds.maxSteps)),
    maxComputeCredits: Math.max(...records.map((one) => one.record.bounds.maxCredits)),
    // The largest ceiling any of the processes ran under. With parallel processes on one key the
    // ceiling is global to the key, so the smallest would understate what was allowed to be spent.
    maxSpendUsd: records.reduce<number | null>(
      (most, one) =>
        one.record.bounds.maxSpendUsd === null
          ? most
          : Math.max(most ?? 0, one.record.bounds.maxSpendUsd),
      null
    ),
    catalogueBytes: Math.max(...records.map((one) => one.record.catalogueBytes)),
    ranIn: first.ranIn,
    shimMisses: distinct(records.flatMap((one) => one.record.misses)),
    absentRequests: records.reduce((total, one) => total + one.record.absentRequests, 0),
    runs
  });
  if (input.securityMode !== ARM_SECURITY_MODE[options.arm]) {
    // `rowFrom` refuses this too; said here as well so the sentence names the records.
    return {
      input,
      row: null,
      refusal: `the records were run ${input.securityMode} and arm "${options.arm}" is ${ARM_SECURITY_MODE[options.arm]}. No row.`,
      missing
    };
  }
  try {
    const row = rowFrom(input, (value) =>
      createHash('sha256').update(value).digest('hex').slice(0, 16)
    );
    return { input, row, refusal: null, missing };
  } catch (cause) {
    return {
      input,
      row: null,
      refusal: cause instanceof Error ? cause.message : String(cause),
      missing
    };
  }
};

/* ------------------------------------------------------------------------------ the CSV, kept */

/**
 * The CSV read back, RFC 4180 quoting honoured.
 *
 * `renderCsv` quotes a cell holding a comma, a quote or a newline, and `declared_drops` and
 * `task_set` routinely do, so a split on commas would shred exactly the rows this file is for.
 */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

/** The data rows of a parity CSV, or none for a file that does not exist or holds only a header. */
export const readCsvRows = (csvPath: string): string[][] => {
  if (!existsSync(csvPath)) return [];
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  const header = rows[0];
  if (!header) return [];
  if (header.join(',') !== COLUMNS.join(','))
    throw new Error(
      `${csvPath} has a header this rig does not write (${String(header.length)} columns against ${String(COLUMNS.length)}); its rows cannot be kept without knowing which column is which.`
    );
  return rows.slice(1).filter((row) => row.some((value) => value !== ''));
};

/**
 * The columns that identify a row: the same benchmark, task set, arm, model, build and run count
 * is the same measurement re-done, and replaces the old one. Anything else is another row.
 */
const KEY_COLUMNS = [
  'benchmark',
  'task_set_sha',
  'arm',
  'model',
  'garden_commit',
  'n_runs'
] as const;

const ARM_ORDER: readonly string[] = ['shipped', 'autonomous', 'unattended'];

const keyOf = (row: readonly string[]): string =>
  KEY_COLUMNS.map((column) => row[COLUMNS.indexOf(column)] ?? '').join('\u0000');

/**
 * One row in, the rest kept.
 *
 * The file was rewritten whole with a single row by the first paid run, which is fine for a file
 * with one row and destroys the ladder the moment it has two. Rows are kept in arm order so the
 * ladder reads top to bottom - shipped, autonomous, unattended - and within an arm in the order they
 * arrived.
 */
export const upsertRow = (
  csvPath: string,
  row: readonly string[]
): { readonly replaced: boolean; readonly rows: number } => {
  if (row.length !== COLUMNS.length)
    throw new Error(
      `a row has ${String(row.length)} cells and the CSV has ${String(COLUMNS.length)} columns`
    );
  const existing = readCsvRows(csvPath);
  const key = keyOf(row);
  const replaced = existing.some((one) => keyOf(one) === key);
  const kept = existing.filter((one) => keyOf(one) !== key);
  kept.push([...row]);
  const armColumn = COLUMNS.indexOf('arm');
  const rank = (one: readonly string[]): number => {
    const index = ARM_ORDER.indexOf(one[armColumn] ?? '');
    return index < 0 ? ARM_ORDER.length : index;
  };
  // A stable sort, so rows within an arm keep their arrival order.
  const sorted = kept
    .map((one, index) => ({ one, index }))
    .sort((left, right) => rank(left.one) - rank(right.one) || left.index - right.index)
    .map((entry) => entry.one);
  mkdirSync(path.dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, renderCsv(sorted));
  return { replaced, rows: sorted.length };
};
