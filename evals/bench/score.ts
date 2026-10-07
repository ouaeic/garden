/**
 * The join, whole: a real `AgentWorker` runs a task to completion against this shim over a real
 * socket against a real directory, and the box decides whether it was solved.
 *
 * THIS FILE EXISTS BECAUSE EVERYTHING ELSE IN THIS DIRECTORY WAS PROVED IN ISOLATION. The shim
 * answered requests this rig composed. `wiring.ts` went one better and drove garden's own
 * `AgentRunnerClient` over the socket, which is the wire - but no turn ran, no tool dispatched, no
 * approval floor was consulted and no score was ever produced. That is the computed-and-unwired
 * shape this programme has now shipped three times, and this is the line that was never written.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, stated before any number below is read:
 *
 *   real - `AgentWorker.run`, the same object the worker process runs, built the way
 *          `evals/harness.ts` builds it, with `WORKSPACE_RUNNER_URL` pointed at this shim.
 *   real - the tool catalogue, the tool dispatch, the plan and acceptance holds, the approval
 *          floor, compaction, the runner protocol, the shim, the box, the files, the verifier.
 *   NOT  - the model. It is a script (`task.ts`), so no provider is called and nothing is billed.
 *
 * So a score of 1.0 below means the loop can carry a scripted solution end to end into a real
 * filesystem and have a command in that filesystem agree. It says NOTHING about garden's ability
 * on a benchmark, and a reader who takes it for one has been misled by this file. That is why the
 * row goes to `parity-wire.csv` and never to `parity.csv`, why its `model` column names itself as
 * scripted, and why README.md's paid command is still the first number that would mean anything.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFixture, runIdentity, type LiveProvider } from '../harness.js';

import { localBackend, type ExecResult, type WorkspaceBackend } from './backend.js';
import { benchmarkBoxCatalogueBytes, BYTES_PER_TOKEN } from './catalogue.js';
import { writeFile } from './files.js';
import {
  ARM_SECURITY_MODE,
  renderCsv,
  rowFrom,
  type Arm,
  type RowInput,
  type RunRecord,
  type TaskResult
} from './parity.js';
import { createShim, type Shim } from './shim.js';
import { fixtureFor, TASKS, VERIFIER_PATH, type WireTask } from './task.js';

/**
 * What this environment does NOT do that garden does, printed in the row rather than omitted.
 *
 * Restated from `shim.ts` and `backend.ts` because a row read a year from now will not have those
 * files open beside it. Each is a real difference between the box that produced the number and the
 * box garden ships onto.
 */
export const LOCAL_DROPS: readonly string[] = [
  'no capability-token verification (the real runner verifies a signed token per request)',
  'no Landlock sandbox and no rlimits',
  'no per-call egress gating: a command shares this host network namespace',
  'no EXIF strip on /image',
  'background work is never stopped',
  'the verifier runs in the same box the agent could reach'
];

export interface ScoredTask {
  readonly task: WireTask;
  readonly result: TaskResult;
  /**
   * The box this task actually ran in, carried up so the row cannot misname it.
   *
   * `rowFrom` hardcoded `backend: 'local'`, which was true for as long as `scoreTask` could only
   * open a local one. The first real Terminal-Bench run then wrote a row saying `local` while every
   * task had run in its own container - a false claim in the one artefact whose whole value is that
   * its claims can be checked. It is read off the backend rather than passed in beside it, because
   * a caller that could assert it could assert it wrongly.
   */
  readonly ranIn: { readonly name: string; readonly isolatesNetwork: boolean };
  /** What the box said when the verifier ran, for a reader asking why a task scored 0. */
  readonly verifierExit: number | null;
  readonly verifierStderr: string;
  /** The end of the verifier's report, which names the check that failed. */
  readonly verifierStdout?: string;
  readonly status: string;
  /**
   * What the turn said about its own evidence, from the completion event.
   *
   * Beside the verdict and never instead of it. `status` and this are garden's account of itself;
   * `resolved` is the box's. A benchmark adapter that scored on either of these two would be
   * scoring the agent's own report - see this file's header, and the acceptance ceiling in
   * `apps/worker/src/turn-bounds.ts:360`, which ends a turn `completed` after four failed rounds of
   * the model's own checks.
   */
  readonly verification: string;
  /**
   * Commands the turn ran IN THE BOX, counted off the wire by the harness seam.
   *
   * The number that says the acceptance check was carried out rather than merely declared: the
   * scripted model makes two `shell` calls, so anything above two is the loop running a check of
   * its own against the real box through the real shim.
   */
  readonly commandsRun: number;
  /**
   * The tool catalogue the loop offered on this turn's last request, by name.
   *
   * Here so a live run can be asked whether the surface gate HELD, which is the one thing
   * `routes.ts` says outright it had never observed. Under this shim `/surfaces` answers
   * `absent, absent`, so the seven surface tools and `connector_action` must not be in this list -
   * and until a turn actually ran against the shim there was nothing to ask.
   */
  readonly catalogue: readonly string[];
  readonly holds: readonly string[];
  /** What the loop actually said back on each hold, in full. */
  readonly pushback: readonly string[];
  readonly error: string | null;
  /** Routes the run asked for that this shim does not implement. Non-empty voids the whole row. */
  readonly misses: readonly string[];
  readonly absentRequests: number;
  readonly observedRoutes: readonly string[];
  /**
   * The loop's own events for this turn, whole, so a paid run can keep the transcript per task.
   * Payloads are the decrypted objects the harness already holds; nothing here re-reads them.
   */
  readonly events: ReadonlyArray<{
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
  }>;
  /** The mode the task was minted under, which the row has to agree with. */
  readonly securityMode: 'review' | 'balanced' | 'autonomous';
  /** Cards the auto-approver answered. Zero unless the arm was `unattended`. */
  readonly autoAnswered: number;
  /** Whether the auto-approver hit its re-entry ceiling and left the task parked. */
  readonly autoApproveCapReached: boolean;
  /**
   * Live calls priced and counted from the loop's ledger rather than the provider's frame, because
   * the response carried none. Zero scripted. @see `RunOutcome.providerUsageFallbacks`.
   */
  readonly providerUsageFallbacks: number;
}

/**
 * The arm as the harness sees it: the mode the task is minted under, and whether anybody answers.
 *
 * `unattended` is autonomous plus an approver that answers every card approved with nobody reading
 * it, which is what every published leaderboard adapter is. The other two leave the card standing.
 */
export const armFixtureFields = (
  arm: Arm
): {
  readonly securityMode: 'review' | 'balanced' | 'autonomous';
  readonly autoApprove: boolean;
} => ({
  securityMode: ARM_SECURITY_MODE[arm],
  autoApprove: arm === 'unattended'
});

export interface ScoreOptions {
  readonly tasks: readonly WireTask[];
  readonly arm: Arm;
  /**
   * Whether the caller has accepted that the local backend runs commands as this user with this
   * user's network and filesystem. Required for any task whose commands did not come from this
   * repository. @see `WireTask.origin` and `backend.ts`.
   */
  readonly trustLocal: boolean;
  readonly onTask?: (scored: ScoredTask) => void;
}

/**
 * What decides what solving a task means: the prompt, the seed and the verifier argv. The task-set
 * digest is taken over these and nothing else, so two rows claiming the same set can be checked
 * rather than believed - and a record written by a paid run carries its own copy, so a row can be
 * assembled from records after the process that ran them is gone.
 */
export interface TaskSetMember {
  readonly id: string;
  readonly request: string;
  readonly seed: Readonly<Record<string, string>>;
  readonly verifyCall: WireTask['verify']['call'];
}

export const taskSetMemberOf = (task: WireTask): TaskSetMember => ({
  id: task.id,
  request: task.request,
  seed: task.seed,
  verifyCall: task.verify.call
});

export const taskSetShaOf = (members: readonly TaskSetMember[]): string =>
  createHash('sha256')
    .update(JSON.stringify(members.map((one) => [one.id, one.request, one.seed, one.verifyCall])))
    .digest('hex')
    .slice(0, 16);

/**
 * Everything a row is built from, in one shape, so the in-process path and the record assembler
 * (`results.ts`) build the SAME `RowInput`. Two builders would be two places for a column's meaning
 * to drift, in the one file whose whole purpose is that a row cannot flatter what produced it.
 */
export interface RowFacts {
  readonly benchmark: string;
  readonly taskIds: readonly string[];
  readonly taskSetSha: string;
  readonly nTasks: number;
  readonly model: string;
  readonly modelRoute: string;
  readonly provider: string;
  readonly harnessVersion: string;
  readonly harnessCommit: string;
  readonly arm: Arm;
  readonly securityMode: 'review' | 'balanced' | 'autonomous';
  readonly approvalsAutoAnswered: number;
  readonly taskMaxSteps: number;
  readonly maxComputeCredits: number;
  readonly maxSpendUsd: number | null;
  readonly catalogueBytes: number;
  readonly ranIn: { readonly name: string; readonly isolatesNetwork: boolean };
  readonly shimMisses: readonly string[];
  readonly absentRequests: number;
  readonly runs: readonly RunRecord[];
}

export const rowInputFrom = (facts: RowFacts): RowInput => ({
  benchmark: facts.benchmark,
  taskSet: facts.taskIds.join('+'),
  taskSetSha: facts.taskSetSha,
  nTasks: facts.nTasks,
  model: facts.model,
  modelRoute: facts.modelRoute,
  provider: facts.provider,
  harness: 'garden',
  harnessVersion: facts.harnessVersion,
  harnessCommit: facts.harnessCommit,
  arm: facts.arm,
  securityMode: facts.securityMode,
  approvalsAutoAnswered: facts.approvalsAutoAnswered,
  taskMaxSteps: facts.taskMaxSteps,
  // `evals/harness.ts` pins `TASK_MAX_SELF_CONTINUATIONS: 0`, so every step count here is the
  // cost of one budget rather than of two.
  selfContinuations: 0,
  maxComputeCredits: facts.maxComputeCredits,
  maxSpendUsd: facts.maxSpendUsd,
  catalogueBytes: facts.catalogueBytes,
  catalogueTokensPerCall: Math.round(facts.catalogueBytes / BYTES_PER_TOKEN),
  surfaces: { browser: 'absent', desktop: 'absent' },
  backend: facts.ranIn.name,
  isolatesNetwork: facts.ranIn.isolatesNetwork,
  verifierEnv: 'same',
  networkMode: 'host',
  declaredDrops: LOCAL_DROPS,
  shimMisses: facts.shimMisses,
  absentRequests: facts.absentRequests,
  runs: facts.runs
});

/**
 * The task's own verifier, run in the box.
 *
 * One function because it runs TWICE - once before the turn and once after - and a second copy of
 * the argv, the environment and the bounds would be a second place for the two runs to drift
 * apart. They must be the same command or the comparison between them says nothing.
 */
const runVerifier = async (backend: WorkspaceBackend, task: WireTask): Promise<ExecResult> =>
  await backend.exec({
    executable: task.verify.call.executable,
    args: task.verify.call.args,
    cwd: task.verify.call.cwd,
    // PATH explicitly, and nothing else: the box's own environment is not this rig's. @see task.ts.
    env: { PATH: VERIFIER_PATH, LC_ALL: 'C' },
    // The task's own ceiling where it declares one. @see `Verifier.timeoutSeconds`.
    timeoutSeconds: task.verify.timeoutSeconds ?? 120,
    network: false,
    maxOutputBytes: 64 * 1024
  });

/**
 * One task, driven to completion.
 *
 * A fresh shim and a fresh temporary directory per task, for the reason a benchmark starts a fresh
 * container per task: a solution that only works because the previous task left a file behind is a
 * solution that scored on evidence nobody declared.
 */
export const scoreTask = async (
  task: WireTask,
  trustLocal: boolean,
  /*
   * The box this task runs in, or nothing for the local one.
   *
   * Hardcoded to `localBackend()` until now, which is why `dockerBackend` had been written, tested
   * by `selftest.ts` against its argv, and never once attached to a running container: there was no
   * way to hand one in. The lifecycle stays outside on purpose - `backend.ts` says so in its own
   * comment, because only the benchmark's task definition knows the image, the network mode and
   * what the verifier expects - so a caller that wants a container builds it, starts it, passes an
   * attached backend here, and stops it afterwards.
   *
   * A FACTORY rather than a backend, because `scoreTask` promises a fresh box per task and a
   * caller handing the same object twice would quietly break that promise for the second one.
   */
  openBox: (() => Promise<WorkspaceBackend>) | undefined = undefined,
  /*
   * Putting the task's own tests into the box, and TAKING THEM OUT AGAIN before the turn.
   *
   * Two rules collide here and both are right. This rig demands the verifier run before the turn
   * and fail, because a task that starts solved is not a task. Terminal-Bench stages its tests
   * only AFTER the agent has finished, because an agent that can read the tests can write code
   * that satisfies them without solving anything - and that is a score of 1 earned by reading.
   *
   * Staging once and leaving them satisfies the first rule and breaks the second, silently and in
   * the flattering direction. So the tests are placed, the guard is run, and they are removed
   * before the shim is even created; the turn happens in a box that has never held them; then they
   * are placed again for the verdict. Both properties hold, and the cost is one extra copy.
   *
   * Absent for a task that carries its tests in its seed, which is every builtin one.
   */
  staging:
    | { readonly place: () => Promise<void>; readonly remove: () => Promise<void> }
    | undefined = undefined,
  /** A real provider for this turn, or nothing for the scripted one. @see `Fixture.live`. */
  live: LiveProvider | undefined = undefined,
  /**
   * The arm, which decides the mode the task is minted under and whether cards are answered. The
   * offline default is the arm the owner installs.
   */
  arm: Arm = 'shipped'
): Promise<ScoredTask> => {
  if (task.origin !== 'builtin' && !trustLocal && !openBox)
    throw new Error(
      `task "${task.id}" is an external task definition and the local backend is not a sandbox: its commands would run as this user with this user's network. Pass --trust-local to accept that, or run it on the docker backend.`
    );
  const backend: WorkspaceBackend = openBox ? await openBox() : await localBackend();
  let shim: Shim | null = null;
  let stop: (() => Promise<void>) | null = null;
  const startedWall = Date.now();
  try {
    await backend.ensure();
    for (const [file, contents] of Object.entries(task.seed))
      await writeFile(backend, file, Buffer.from(contents, 'utf8'));

    /*
     * THE TASK MUST NOT ALREADY BE SOLVED, asked before the turn is allowed to start.
     *
     * A verifier run only at the END cannot tell work from a starting state that already satisfied
     * it. MEASURED 2026-09-02, before this guard existed: replace the solution script with `true`
     * and add the answer file to `seed`, and this driver printed `resolved`, wrote `score_mean 1`
     * to `parity-wire.csv` and exited 0 while the turn did nothing whatever - and `pnpm eval:bench`
     * said "clean" beside it. Nothing else here could have caught it, because `status`,
     * `verification`, `steps` and `commandsRun` all read EXACTLY as they do on the honest run: the
     * agent still ran its two commands and its acceptance check, and the check passed, because the
     * answer was already on disk.
     *
     * So the verifier runs twice and the first run has to FAIL. It is one exec on a task that
     * costs five model calls, and it is the guard this rig needs at the moment it grows the task
     * loader `WireTask` was shaped to accept: a leaked answer in somebody else's task set arrives
     * as a free point and is indistinguishable from a score. What would change it: nothing. A task
     * that starts solved is not a task.
     */
    await staging?.place();
    const before = await runVerifier(backend, task);
    // Out again before anything the agent can reach exists. @see the `staging` parameter.
    await staging?.remove();
    if (before.exitCode === 0)
      throw new Error(
        `task "${task.id}" passes its own verifier BEFORE the turn runs (${task.verify.label}), so solving it requires nothing of the agent and a score of 1 would belong to the seed. No run.`
      );

    shim = createShim({ backend });
    const server = await shim.listen();
    stop = server.close;

    const fields = armFixtureFields(arm);
    const outcome = await runFixture(fixtureFor(task, server.url, live, fields));

    /*
     * The verdict, taken from the box and from nowhere else.
     *
     * NOT from `outcome.status`, and the distinction is the whole of the discipline: a turn that
     * reports `completed` having written the wrong number is a turn that scored 0, and a rig that
     * read its own loop's satisfaction as a score would be a harness marking its own homework.
     * `status` travels beside the verdict as evidence, not as the verdict.
     *
     * The same command that was already run and already failed above, so a pass here is a
     * DIFFERENCE the turn made rather than a property the box arrived with.
     */
    await staging?.place();
    const verified = await runVerifier(backend, task);
    const wallSeconds = (Date.now() - startedWall) / 1_000;

    return {
      task,
      ranIn: { name: backend.name, isolatesNetwork: backend.isolatesNetwork },
      result: {
        taskId: task.id,
        // `null` would mean the run produced no verdict at all, which is not what happened: the
        // verifier ran and answered. A failed verifier is `false`, and `scoreOf` divides by the
        // declared task count either way, so neither reading changes the denominator.
        resolved: verified.exitCode === 0,
        // Live: the provider's own per-call cost, summed by the harness off every answered
        // response's usage frame - attributable to THIS task, which the account's running total
        // is not once two processes share a key. Scripted: no provider was called, so nothing was billed, and
        // zero is a fact about this run and not a cost measurement; the `model` column names the
        // run as scripted so the cell cannot be read as "garden solved this for nothing".
        costUsd: live === undefined ? 0 : outcome.providerCostUsd,
        // Live: the provider's own input count, off the same response frames as the cost.
        // Scripted: measured on the wire by `evals/harness.ts` rather than estimated, the whole
        // request body, catalogue included. `promptTokens` reads the same either way; see the
        // harness's live branch.
        inputTokens: live === undefined ? outcome.promptTokens : outcome.providerInputTokens,
        outputTokens: live === undefined ? outcome.outputTokens : outcome.providerOutputTokens,
        steps: outcome.modelCalls,
        wallSeconds,
        compactions: outcome.compactions,
        approvalCardsFired: outcome.approvalsRaised,
        cachedTokens: live === undefined ? null : outcome.providerCachedTokens,
        approvalsAutoAnswered: outcome.approvalsAutoAnswered,
        // An infrastructure failure is something that stopped the run from being about the agent.
        // A throw out of the loop is one; a wrong answer is not.
        infraFailure: outcome.error !== null
      },
      verifierExit: verified.exitCode,
      verifierStderr: verified.stderr.trim().slice(0, 400),
      verifierStdout: verified.stdout.trim().slice(-3_000),
      status: outcome.status,
      verification: outcome.verification,
      commandsRun: outcome.commandsRun,
      catalogue: outcome.finalCatalogue,
      holds: outcome.holds,
      pushback: outcome.pushback,
      error: outcome.error,
      misses: shim.misses,
      absentRequests: shim.absentRequests,
      observedRoutes: outcome.observedRoutes,
      events: outcome.events,
      securityMode: fields.securityMode,
      autoAnswered: outcome.approvalsAutoAnswered,
      autoApproveCapReached: outcome.autoApproveCapReached,
      providerUsageFallbacks: outcome.providerUsageFallbacks
    };
  } finally {
    if (stop) await stop();
    await backend.dispose();
  }
};

export interface ScoreReport {
  readonly scored: readonly ScoredTask[];
  /** The row, or null when `rowFrom` refused it - see `refusal`. */
  readonly row: readonly string[] | null;
  readonly refusal: string | null;
  readonly csv: string;
}

export const scoreRun = async (options: ScoreOptions): Promise<ScoreReport> => {
  if (options.tasks.length === 0) throw new Error('a scored run needs at least one task');
  const identity = runIdentity();
  const startedAt = new Date().toISOString();
  const scored: ScoredTask[] = [];
  for (const task of options.tasks) {
    // Sequentially, like `evals/run.ts` and `observe.ts`, and for the same reason: `runFixture`
    // installs its own `globalThis.fetch` for the duration of a run. Two at once measure each other.
    const one = await scoreTask(
      task,
      options.trustLocal,
      undefined,
      undefined,
      undefined,
      options.arm
    );
    scored.push(one);
    options.onTask?.(one);
  }

  /*
   * One box for the whole row, or no row. A run that scored half its tasks in a container and half
   * on this host is two measurements, and averaging them would put a single `backend` and a single
   * `isolates_network` on a row that was true of neither half.
   */
  const boxes = new Set(
    scored.map((one) => `${one.ranIn.name}/${String(one.ranIn.isolatesNetwork)}`)
  );
  if (boxes.size > 1)
    throw new Error(
      `this run used ${String(boxes.size)} different boxes (${[...boxes].join(', ')}), so no single backend column is true of it. No row.`
    );
  const ranIn = scored[0]?.ranIn ?? { name: 'local', isolatesNetwork: false };
  const input = rowInputFrom({
    benchmark: 'garden-wire',
    taskIds: scored.map((one) => one.task.id),
    // The tasks themselves, hashed, so two rows claiming the same task set can be checked rather
    // than believed. Over the prompt, the seed and the verifier argv - everything that decides what
    // solving it means.
    taskSetSha: taskSetShaOf(scored.map((one) => taskSetMemberOf(one.task))),
    nTasks: options.tasks.length,
    // Named for what it is in every row it appears in. No provider was reached; see this file's
    // header for what that does and does not invalidate.
    model: 'scripted-no-provider',
    modelRoute: 'none',
    provider: 'none',
    harnessVersion: identity.version,
    harnessCommit: identity.commit ?? 'uncommitted',
    arm: options.arm,
    // The mode the arm IS, and the mode every task was minted under: `scoreTask` derives both from
    // the arm through `armFixtureFields`, so the row and the run cannot disagree. `rowFrom` still
    // checks, because a row that named an arm it did not run under is exactly what it refuses.
    securityMode: ARM_SECURITY_MODE[options.arm],
    approvalsAutoAnswered: scored.reduce((total, one) => total + one.autoAnswered, 0),
    taskMaxSteps: Math.max(...options.tasks.map((task) => task.maxSteps)),
    maxComputeCredits: Math.max(...options.tasks.map((task) => task.maxCredits)),
    maxSpendUsd: null,
    catalogueBytes: benchmarkBoxCatalogueBytes(),
    ranIn,
    // The gate. Any route the run asked for that this shim does not implement voids the row, and
    // the misses are unioned across every task because one bad task is one bad environment.
    shimMisses: [...new Set(scored.flatMap((one) => one.misses))],
    absentRequests: scored.reduce((total, one) => total + one.absentRequests, 0),
    runs: [{ startedAt, tasks: scored.map((one) => one.result) }]
  });

  let row: string[] | null = null;
  let refusal: string | null = null;
  try {
    row = rowFrom(input, (value) => createHash('sha256').update(value).digest('hex').slice(0, 16));
  } catch (cause) {
    refusal = cause instanceof Error ? cause.message : String(cause);
  }
  return { scored, row, refusal, csv: renderCsv(row === null ? [] : [row]) };
};

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * A separate artefact from `parity.csv`, and the separation is the point.
 *
 * `parity.csv` is the benchmark artefact and it is committed with zero rows, because there is no
 * garden benchmark score in this repository. A row produced by a scripted model against a local
 * shim is not one, and putting it in that file would put a `score_mean` of 1.0 in the artefact a
 * reader goes to for garden's number. Same columns, same `rowFrom`, same refusals; different file,
 * and every row in it says `scripted-no-provider` in its model column.
 */
export const WIRE_CSV = path.join(here, 'parity-wire.csv');

/** `--score`. Writes the wire artefact and returns the process exit code. */
export const runScore = async (options: {
  readonly arm: Arm;
  readonly trustLocal: boolean;
  readonly filter?: string | undefined;
  readonly out: (line: string) => void;
}): Promise<number> => {
  const tasks = options.filter
    ? TASKS.filter((task) => task.id.includes(options.filter ?? ''))
    : TASKS;
  if (tasks.length === 0) {
    options.out(`No wire task matches "${options.filter ?? ''}".`);
    return 2;
  }
  options.out(
    `Driving ${tasks.length} task(s) through a real AgentWorker against the shim. Scripted model, no provider, no key, no cost.`
  );
  const report = await scoreRun({
    tasks,
    arm: options.arm,
    trustLocal: options.trustLocal,
    onTask: (one) => {
      options.out(
        `  ${one.result.resolved === true ? 'resolved' : 'UNRESOLVED'}  ${one.task.id}  status=${one.status}/${one.verification} steps=${String(one.result.steps)} commands=${String(one.commandsRun)} cards=${String(one.result.approvalCardsFired)} verifier=exit ${String(one.verifierExit)}${one.error === null ? '' : ` error=${one.error}`}`
      );
      if (one.holds.length) options.out(`      holds: ${one.holds.join(', ')}`);
      // Only when the task did not resolve. A hold on a task that still passed is the loop working,
      // and printing four paragraphs of it every run trains a reader to skim the one that matters.
      if (one.result.resolved !== true)
        for (const said of one.pushback)
          options.out(`      >> ${said.replace(/\n/g, ' | ').slice(0, 300)}`);
      options.out(`      routes: ${one.observedRoutes.join(', ')}`);
      if (one.misses.length) options.out(`      MISSES: ${one.misses.join(', ')}`);
    }
  });
  writeFileSync(WIRE_CSV, report.csv);
  options.out('');
  if (report.refusal !== null) {
    options.out(`No row: ${report.refusal}`);
    return 1;
  }
  options.out(`One row, earned, written to ${WIRE_CSV}.`);
  options.out(
    '  It is a wire proof and not a benchmark score: the model is a script. See README.md section 5 for the command that produces a number about garden.'
  );
  return report.scored.every((one) => one.result.resolved === true) ? 0 : 1;
};
