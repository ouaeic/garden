/**
 * The paid path: a borrowed task set, a real model, one container per task, one record per task.
 *
 * Everything here is assembly. The pieces it joins each refuse on their own terms and none of those
 * refusals are softened: `terminal-bench.ts` refuses a task it cannot read whole, `provider.ts`
 * refuses to start without a key, `score.ts` refuses a task that passes its verifier before the
 * turn, `results.ts` refuses records from two boxes or two builds, and `parity.ts` refuses a row
 * that would name a configuration it was not measured under. A run that ends with no row has still
 * told the truth.
 *
 * WHAT A RUN WRITES, AND WHAT IT DOES NOT. A run writes one record per task under `--results` as
 * each task finishes, and never touches `parity.csv`. The row is built afterwards by `--assemble`
 * from whatever records exist, so several processes can run disjoint (arm, run-index) pairs on one
 * box at once and a process that dies loses the task it was in and nothing else. See `results.ts`
 * for why that separation had to exist.
 *
 * COST, TWICE. The per-task figure printed and stored is the provider's own per-call cost, read by
 * the gateway off each completion and summed by the harness - attributable to that task whatever
 * else is running on the key. The account's running total is read at the start and the end and
 * printed as the whole-process check with the discrepancy, and between tasks it is the spend
 * ceiling: with parallel processes on one key that ceiling is GLOBAL to the key, so every process
 * stops when the key as a whole has spent it, whoever spent it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReasoningEffort } from '../../packages/contracts/src/index.js';
import { runIdentity, type LiveProvider } from '../harness.js';

import { benchmarkBoxCatalogueBytes } from './catalogue.js';
import { ARM_SECURITY_MODE, COLUMNS, type Arm } from './parity.js';
import { providerCredential, providerModelIdOf } from './provider.js';
import {
  assembleRow,
  taskRecordExists,
  taskRecordPath,
  upsertRow,
  writeTaskRecord,
  type TaskRecordFile
} from './results.js';
import { taskSetMemberOf } from './score.js';
import { loadTerminalBenchSuite, terminalBenchTaskIds } from './terminal-bench.js';
import { imagesPresent, scoreTerminalBenchTask } from './terminal-run.js';

/**
 * What the account has actually been billed, asked of the provider.
 *
 * Not a price table and not a sum of usage frames: the provider's own figure for this key, read
 * before and after. It lags a second or two behind a call, which is why it is read once per task
 * rather than once per step - and it is one number for the whole key, which is why it is the
 * ceiling and the whole-process check rather than the per-task cost.
 */
const accountSpend = async (apiKey: string): Promise<number> => {
  const response = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) throw new Error(`the provider would not report this key: ${response.status}`);
  const body = (await response.json()) as { data?: { usage?: number } };
  return typeof body.data?.usage === 'number' ? body.data.usage : 0;
};

/**
 * The key's spend, where the route publishes one.
 *
 * Only OpenRouter answers for a key as a whole. Any other OpenAI-compatible endpoint - a vendor's
 * own API, a subscription plan, a local server - has no such route, and asking OpenRouter about its
 * key fails the run before the first task. There the per-call figures this process has summed are
 * the whole of what is known, and the ceiling is held to them instead.
 */
const spentOnKey = async (
  credential: { readonly provider: string; readonly apiKey: string },
  perCallCost: number
): Promise<number> =>
  credential.provider === 'openrouter' ? accountSpend(credential.apiKey) : perCallCost;

const here = path.dirname(fileURLToPath(import.meta.url));
export const PARITY_CSV = path.join(here, 'parity.csv');

export const ARMS: readonly Arm[] = ['shipped', 'autonomous', 'unattended'];
export const isArm = (value: string): value is Arm => (ARMS as readonly string[]).includes(value);

export interface TerminalBenchOptions {
  readonly root: string;
  readonly model: string;
  /** The process's ceiling on the KEY's spend, checked between tasks. Global across processes. */
  readonly maxSpendUsd: number;
  /** The step ceiling every task runs under, which is what `task_max_steps` then says. */
  readonly maxCallsPerTask: number;
  readonly ids?: readonly string[] | undefined;
  readonly sudo: boolean;
  readonly arm: Arm;
  /** Where records go: DIR/<arm>/run-<runIndex>/<taskId>.json. */
  readonly results: string;
  readonly runIndex: number;
  readonly out: (line: string) => void;
}

export const runTerminalBench = async (options: TerminalBenchOptions): Promise<number> => {
  const { out, arm } = options;
  if (!Number.isInteger(options.runIndex) || options.runIndex < 0) {
    out(`--run-index must be a whole number; got ${String(options.runIndex)}.`);
    return 2;
  }
  if (!Number.isInteger(options.maxCallsPerTask) || options.maxCallsPerTask <= 0) {
    out(`--max-calls must be a positive whole number; got ${String(options.maxCallsPerTask)}.`);
    return 2;
  }

  const ids = options.ids?.length ? options.ids : terminalBenchTaskIds(options.root);
  /*
   * `--max-calls` IS the step ceiling. It used to be accepted, printed in the usage text, and read
   * by nothing: the first paid run said `--max-calls 120` and every task ran under the loader's
   * own `TERMINAL_BENCH_MAX_STEPS` of 50, which is what its `task_max_steps` column reported. The
   * flag now sets the loader's ceiling, so the column and the flag say the same number and a
   * reader can believe either.
   */
  const tasks = loadTerminalBenchSuite(options.root, ids, { maxSteps: options.maxCallsPerTask });
  out(
    `Loaded ${tasks.length} task(s) from ${options.root}. Arm ${arm} (${ARM_SECURITY_MODE[arm]}${arm === 'unattended' ? ', auto-approver on' : ', nobody answering'}), step ceiling ${String(options.maxCallsPerTask)}.`
  );

  /*
   * A missing image is a REFUSAL, never a zero. A task whose container could not start did not
   * fail; it did not run, and averaging it in as 0 would report the agent's competence as lower
   * than anything measured it to be.
   */
  const images = await imagesPresent(tasks, options.sudo);
  if (images.missing.length) {
    out(`No image built for ${images.missing.length} task(s): ${images.missing.join(', ')}`);
    out('Build them first. A task with no container is not a task that scored 0.');
    return 2;
  }

  const credential = providerCredential();
  if (!credential) {
    out('No provider key. This path bills a real account, so it does not start without one.');
    return 2;
  }
  const effort = process.env.AI_REASONING_EFFORT;
  const reasoningEffort = ReasoningEffort.safeParse(effort).data;
  if (effort && !reasoningEffort) {
    out(`AI_REASONING_EFFORT=${effort} is not a reasoning effort.`);
    return 2;
  }
  const live: LiveProvider = {
    baseUrl: credential.baseUrl,
    apiKey: credential.apiKey,
    provider: credential.provider,
    providerModelId: providerModelIdOf(options.model),
    contextTokens: 1_000_000,
    vision: process.env.AI_VISION === '1',
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
  const identity = runIdentity();
  const openedAt = await spentOnKey(credential, 0);
  out(
    `Model ${options.model} via ${live.providerModelId} at ${live.baseUrl}. Ceiling $${options.maxSpendUsd.toFixed(2)} on the key as a whole; it has spent $${openedAt.toFixed(4)} so far.`
  );
  out(`Records: ${path.join(options.results, arm, `run-${String(options.runIndex)}`)}`);

  let ran = 0;
  let skipped = 0;
  let perCallCost = 0;
  let spentBefore = openedAt;
  for (const task of tasks) {
    if (taskRecordExists(options.results, arm, options.runIndex, task.id)) {
      skipped += 1;
      out(
        `  skipped     ${task.id}  (record exists: ${taskRecordPath(options.results, arm, options.runIndex, task.id)})`
      );
      continue;
    }
    const startedAt = new Date().toISOString();
    // Sequentially: `runFixture` installs its own `globalThis.fetch` for the duration of a run, so
    // one process runs one task at a time. Parallelism is several processes on disjoint
    // (arm, run-index) pairs, which is what the records directory is for.
    const scored = await scoreTerminalBenchTask(
      task,
      {
        sudo: options.sudo,
        // The verifier runs twice - once before the turn, to refuse a task that is already solved,
        // and once after it - each under the task's own test ceiling, so the box has to outlive
        // the agent's ceiling and both of those. A shorter life stops the container mid-check and
        // a task the agent solved is scored as failed.
        lifetimeSeconds:
          (task.maxAgentTimeoutSeconds ?? 900) + 2 * (task.maxTestTimeoutSeconds ?? 600) + 300,
        // The (arm, run-index) pair IS this process's identity on the box; see `DockerOptions.label`.
        label: `${arm}-r${String(options.runIndex)}`
      },
      live,
      arm
    );
    const record: TaskRecordFile = {
      version: 1,
      benchmark: 'terminal-bench',
      arm,
      runIndex: options.runIndex,
      taskId: task.id,
      startedAt,
      identity: {
        model: options.model,
        modelRoute: providerModelIdOf(options.model),
        provider: credential.provider
      },
      garden: { version: identity.version, commit: identity.commit ?? 'uncommitted' },
      securityMode: scored.securityMode,
      autoAnswered: scored.autoAnswered,
      autoApproveCapReached: scored.autoApproveCapReached,
      providerUsageFallbacks: scored.providerUsageFallbacks,
      result: scored.result,
      ranIn: scored.ranIn,
      status: scored.status,
      verification: scored.verification,
      verifierExit: scored.verifierExit,
      verifierStderr: scored.verifierStderr,
      ...(scored.verifierStdout ? { verifierStdout: scored.verifierStdout } : {}),
      commandsRun: scored.commandsRun,
      catalogue: scored.catalogue,
      holds: scored.holds,
      pushback: scored.pushback,
      error: scored.error,
      misses: scored.misses,
      absentRequests: scored.absentRequests,
      observedRoutes: scored.observedRoutes,
      taskSetMember: taskSetMemberOf(task),
      bounds: {
        maxSteps: task.maxSteps,
        maxCredits: task.maxCredits,
        maxSpendUsd: options.maxSpendUsd
      },
      catalogueBytes: benchmarkBoxCatalogueBytes()
    };
    const written = writeTaskRecord(options.results, arm, options.runIndex, record, scored.events);
    ran += 1;
    perCallCost += scored.result.costUsd ?? 0;
    out(
      `  ${scored.result.resolved === true ? 'RESOLVED  ' : 'unresolved'}  ${task.id}  status=${scored.status}/${scored.verification} steps=${String(scored.result.steps)} cards=${String(scored.result.approvalCardsFired)} answered=${String(scored.autoAnswered)}${scored.autoApproveCapReached ? ' (call ceiling)' : ''} verifier=exit ${String(scored.verifierExit)} $${(scored.result.costUsd ?? 0).toFixed(4)} in=${String(scored.result.inputTokens)} cached=${String(scored.result.cachedTokens ?? 0)} out=${String(scored.result.outputTokens)}${scored.providerUsageFallbacks > 0 ? ` (${String(scored.providerUsageFallbacks)} call(s) priced from the ledger: no usage frame)` : ''}${scored.error === null ? '' : ` error=${scored.error}`}`
    );
    out(`      record ${written.record}`);
    /*
     * The ceiling, checked BETWEEN tasks and never inside one. A turn already under way is not
     * interrupted: a half-run task scores 0 and would be counted as a failure the agent caused, so
     * the bound is "start no task that would go past it" - the only place it can be enforced
     * without corrupting the number it exists to protect. It is the KEY's spend, so with several
     * processes on one key every one of them stops here when the key as a whole reaches it.
     */
    const now = await spentOnKey(credential, perCallCost);
    out(
      `      account moved $${(now - spentBefore).toFixed(4)} over this task (shared key; the per-call figure above is this task's own)`
    );
    spentBefore = now;
    if (now - openedAt >= options.maxSpendUsd) {
      out('');
      out(
        `The $${options.maxSpendUsd.toFixed(2)} ceiling is reached ($${(now - openedAt).toFixed(4)} spent on the key since this process opened). No further task is started; re-run the same command to resume from the records.`
      );
      break;
    }
  }

  const closedAt = await spentOnKey(credential, perCallCost);
  const accountDelta = closedAt - openedAt;
  out('');
  out(
    `Ran ${String(ran)} task(s), skipped ${String(skipped)} already recorded. Per-call cost summed over the tasks this process ran: $${perCallCost.toFixed(4)}.`
  );
  out(
    `The account moved $${accountDelta.toFixed(4)} while this process ran; discrepancy $${(accountDelta - perCallCost).toFixed(4)} (other processes on the key, the provider's own rounding, or calls the gateway did not price).`
  );
  out('');
  out('No row was written. Assemble one from the records when every run-index is in:');
  out(
    `  pnpm eval:bench --assemble --results ${options.results} --arm ${arm} --runs ${String(options.runIndex + 1)} --tasks ${tasks.map((task) => task.id).join(',')} --root ${options.root}`
  );
  return 0;
};

export interface AssembleCliOptions {
  readonly results: string;
  readonly arm: Arm;
  readonly runs: number;
  readonly taskIds: readonly string[];
  /** The benchmark directory, to recompute the task-set digest from the tasks on disk. */
  readonly root?: string | undefined;
  readonly out: (line: string) => void;
}

/** `--assemble`. Builds the row from the records, upserts it into `parity.csv`, and says so. */
export const runAssemble = (options: AssembleCliOptions): number => {
  const { out } = options;
  if (!existsSync(options.results)) {
    out(`No records directory at ${options.results}.`);
    return 2;
  }
  const taskSet =
    options.root === undefined
      ? undefined
      : loadTerminalBenchSuite(options.root, options.taskIds).map(taskSetMemberOf);
  const assembled = assembleRow({
    dir: options.results,
    arm: options.arm,
    runs: options.runs,
    taskIds: options.taskIds,
    taskSet,
    out
  });
  if (assembled.row === null) {
    out(`No row: ${assembled.refusal ?? 'refused'}`);
    return 1;
  }
  const cell = (column: string): string => assembled.row?.[COLUMNS.indexOf(column)] ?? '';
  out('');
  out(
    `Row: ${cell('benchmark')} arm=${cell('arm')} n_tasks=${cell('n_tasks')} n_runs=${cell('n_runs')} score_mean=${cell('score_mean')} score_std=${cell('score_std') || '-'} cost_usd_mean=${cell('cost_usd_mean')} steps_mean=${cell('steps_mean')} steps_p95=${cell('steps_p95')} input_tokens_mean=${cell('input_tokens_mean')} approval_cards_fired_mean=${cell('approval_cards_fired_mean')} approvals_auto_answered=${cell('approvals_auto_answered')} security_mode=${cell('security_mode')} task_max_steps=${cell('task_max_steps')} backend=${cell('backend')} infra_failures_advisory=${cell('infra_failures_advisory')} garden_commit=${cell('garden_commit')}`
  );
  if (assembled.missing.length)
    out(
      `  ${String(assembled.missing.length)} (run, task) pair(s) had no record and stand in the row at 0.`
    );
  const upserted = upsertRow(PARITY_CSV, assembled.row);
  out(
    `${upserted.replaced ? 'Replaced the row with the same key in' : 'Added the row to'} ${PARITY_CSV}; ${String(upserted.rows)} row(s) now.`
  );
  return 0;
};
