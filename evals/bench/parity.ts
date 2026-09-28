/**
 * The artefact: one CSV row per (benchmark, harness, arm), with the knobs that moved it declared
 * as columns rather than buried in a file.
 *
 * WHY A CSV AND NOT A SCORE. A leaderboard row conflates the model, the harness and the budget,
 * and the field's own convention hides the third: `max_steps` in a Python file, a summarisation
 * threshold as a kwarg default, `--permission-mode=bypassPermissions` hard-coded in an adapter.
 * garden's differentiating artefact is not its rank. It is that its row says what it was run
 * with, including the parts that cost it points.
 *
 * THE THREE DISCIPLINES THIS FILE ENFORCES RATHER THAN DOCUMENTS:
 *   1. THE AGGREGATOR IS A COLUMN AND IT IS `mean`. `Max` over n attempts silently turns pass^1
 *      into pass@k. `aggregate()` below has no other mode, and `aggregator` is written into every
 *      row, so a reader never has to assume.
 *   2. A MISSING RESULT SCORES 0, NEVER DROPPED. A task the run never produced a verdict for is a
 *      task the harness failed, and dropping it moves the denominator in the harness's favour.
 *   3. AN ARM IS MANDATORY AND `approvals_auto_answered` MUST AGREE WITH IT. A run where cards
 *      were auto-answered and the arm is not `unattended` is refused as fabricated, because that
 *      is a number produced by a configuration the row does not name.
 *
 * WHAT IS NOT HERE. There is no reference-harness row yet, and there is no garden row either -
 * both cost money and this lane may not spend it. What exists is the shape, the aggregation and
 * the refusals, all exercisable at zero cost. `README.md` carries the command that fills it in.
 */

/** The one aggregator. Named in every row so a reader never has to assume it. */
export const AGGREGATOR = 'mean' as const;

/**
 * The arm ladder, one field apart, the way `evals/arms` already requires of a sibling.
 *
 * `shipped`     securityMode `balanced`, nobody answering. A card that fires ends the run in
 *               `awaiting_user` and that task scores 0. THIS IS WHAT THE OWNER INSTALLS.
 * `autonomous`  securityMode `autonomous`, still nobody answering. The irreducible floor
 *               (`apps/worker/src/approval-policy.ts:692`) still fires and still scores 0.
 * `unattended`  autonomous plus an auto-approver. THIS IS WHAT EVERY OTHER NUMBER IN THE FIELD
 *               ALREADY IS, and the only arm comparable to a leaderboard row.
 *
 * THE GAP BETWEEN `shipped` AND `unattended` IS THE PRICE OF THE APPROVAL FLOOR IN BENCHMARK
 * POINTS, and nobody in this field publishes it. That number is more interesting than the rank.
 *
 * `lean` IS DELIBERATELY ABSENT, and this is a decline with evidence rather than an omission. The
 * research proposed it as "unattended plus the bare 44 kB catalogue", to ask whether sending the
 * whole catalogue every request pays for itself. Under this shim it measures nothing: the 44,000
 * byte assertion at `apps/worker/src/tool-catalogue.test.ts:749` is over `bare` - a box with
 * `browser: 'absent', desktop: 'absent'` (:667) - and this shim answers `/surfaces` with exactly
 * that by default, so every arm above already runs at that floor. `connector_action`, the largest
 * single entry at about 6.6 kB, is withdrawn separately by `apps/worker/src/turn/claim.ts:212`
 * when the box has no connections, which a benchmark box does not. A `lean` rung would have been
 * a fourth row identical to the third. The question it was for is answered by the
 * `surfaces_browser` / `surfaces_desktop` columns instead, which is why they are columns.
 */
export type Arm = 'shipped' | 'autonomous' | 'unattended';

/**
 * The security mode each arm IS, both ways round.
 *
 * The guard used to run in one direction only: an `unattended` row had to be autonomous, and
 * nothing said anything about the other two. That left the flattering direction wide open, and it
 * is the direction that matters here. `shipped` is the arm that is supposed to COST points -
 * `balanced` stops for what the computer cannot take back and a card that fires with nobody at the
 * keyboard parks the task at 0 - so a row labelled `shipped` and measured under `autonomous` prints
 * a smaller gap between the arms than exists. The gap between `shipped` and `unattended` is the one
 * number this artefact exists to publish, and shrinking it flatters garden.
 *
 * A map rather than three conditions, so an arm added to the ladder has to declare its mode here or
 * fail to compile, rather than silently arriving with no guard on it.
 */
export const ARM_SECURITY_MODE: Readonly<Record<Arm, 'review' | 'balanced' | 'autonomous'>> = {
  shipped: 'balanced',
  autonomous: 'autonomous',
  unattended: 'autonomous'
};

/** One task's outcome in one run. `resolved: null` means the run never produced a verdict. */
export interface TaskResult {
  readonly taskId: string;
  readonly resolved: boolean | null;
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly steps: number | null;
  readonly wallSeconds: number | null;
  readonly compactions: number | null;
  readonly approvalCardsFired: number | null;
  /**
   * Infrastructure failure, advisory only.
   *
   * IT NEVER MOVES THE DENOMINATOR. A harness that reclassifies its own failures as environment
   * problems and drops them is scoring itself; the count travels as its own column so a reader
   * can discount the row themselves.
   */
  readonly infraFailure: boolean;
  /**
   * Input tokens the provider served from its prompt cache, when the provider said. Optional and
   * advisory: no column reads it yet, and a scripted run has no cache to report. Kept on the result
   * because a paid row's cost cannot be argued from `inputTokens` alone once two thirds of them
   * were billed at the cache-read rate.
   */
  readonly cachedTokens?: number | null;
  /**
   * Cards this task's turn had answered for it by an auto-approver. The row's own
   * `approvalsAutoAnswered` is the sum of these, and `rowFrom` refuses that sum under any arm but
   * `unattended`; it travels per task so an assembled row can be checked against its records.
   */
  readonly approvalsAutoAnswered?: number;
}

export interface RunRecord {
  readonly startedAt: string;
  readonly tasks: readonly TaskResult[];
}

export interface RowInput {
  readonly benchmark: string;
  readonly taskSet: string;
  readonly taskSetSha: string;
  /** The denominator. Every run is scored against it, whatever the run actually produced. */
  readonly nTasks: number;
  readonly model: string;
  readonly modelRoute: string;
  readonly provider: string;
  readonly harness: string;
  readonly harnessVersion: string;
  readonly harnessCommit: string;
  readonly arm: Arm;
  readonly securityMode: 'review' | 'balanced' | 'autonomous';
  readonly approvalsAutoAnswered: number;
  readonly taskMaxSteps: number;
  readonly selfContinuations: number;
  /**
   * The number that actually bounds the bill, and the one the research's cost model never named.
   *
   * `TASK_MAX_STEPS` is not the ceiling: `TASK_MAX_SELF_CONTINUATIONS` buys more steps and
   * `apps/worker/src/config.ts:88-96` says a renewal "buys steps and nothing else - `maxComputeCredits`
   * and the owner's spend caps are untouched". So three budgets cost no more than one, and the
   * thing that stops the money is this. It is a column for exactly the reason the research charges
   * the field with burying such defaults.
   */
  readonly maxComputeCredits: number | null;
  readonly maxSpendUsd: number | null;
  readonly catalogueBytes: number;
  readonly catalogueTokensPerCall: number;
  readonly surfaces: { browser: string; desktop: string };
  /** `local` or `docker`. Part of what was measured, so part of the row. */
  readonly backend: string;
  /** Whether `network: false` was actually enforced. False on the local backend, always. */
  readonly isolatesNetwork: boolean;
  /** Whether the verifier ran somewhere the agent could not reach. */
  readonly verifierEnv: 'separate' | 'same';
  readonly networkMode: string;
  /**
   * What this row's environment does NOT do that garden does. Printed, not omitted.
   *
   * This is the difference between garden's row and garden, and it is the sentence that has to
   * travel with the number for the number to mean anything.
   */
  readonly declaredDrops: readonly string[];
  /** Routes the shim was asked for and does not implement. A non-empty list voids the row. */
  readonly shimMisses: readonly string[];
  /*
   * How many times the run asked for a route this box declares it does not have, and got the named
   * 503 rather than an answer.
   *
   * A column rather than a diagnostic because it is the one number that says how hard the run
   * pushed against its own declared absences. `surfaces_browser` and `surfaces_desktop` say what
   * the box claimed; this says how often the claim bit. A row with `absent` surfaces and a large
   * count here is a task set that wanted a browser, and a reader comparing it against a harness
   * that had one should be able to see that without rerunning anything.
   *
   * It does not void a row. A declared absence answered as declared is the shim working, which is
   * the whole difference between it and `shimMisses` above.
   */
  readonly absentRequests: number;
  readonly runs: readonly RunRecord[];
}

/**
 * Mean and sample standard deviation. Sample, not population: three runs are a sample of the
 * harness's behaviour, not the whole of it, and n-1 is the convention a reader will assume.
 * Undefined for fewer than two runs, which is printed as an empty cell rather than as 0 - a zero
 * standard deviation from one run is the most flattering lie available here.
 */
export const aggregate = (
  values: readonly number[]
): { readonly mean: number; readonly std: number | null } => {
  if (values.length === 0) return { mean: 0, std: null };
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  if (values.length < 2) return { mean, std: null };
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
  return { mean, std: Math.sqrt(variance) };
};

/**
 * One run's score against the DECLARED denominator.
 *
 * A task the run never produced a verdict for counts as unresolved. So does a task the run never
 * mentioned at all: `nTasks` is the denominator, not `run.tasks.length`. This is the whole of
 * discipline 2 and it is four lines, which is why there is no excuse for the field not doing it.
 */
export const scoreOf = (run: RunRecord, nTasks: number): number => {
  if (nTasks <= 0) throw new Error('a score needs a declared task count');
  const resolved = run.tasks.filter((task) => task.resolved === true).length;
  return resolved / nTasks;
};

const sum = (run: RunRecord, pick: (task: TaskResult) => number | null): number =>
  run.tasks.reduce((total, task) => total + (pick(task) ?? 0), 0);

const meanOf = (run: RunRecord, pick: (task: TaskResult) => number | null): number =>
  run.tasks.length === 0 ? 0 : sum(run, pick) / run.tasks.length;

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
};

export const COLUMNS: readonly string[] = [
  'benchmark',
  'task_set',
  'n_tasks',
  'task_set_sha',
  'model',
  'model_route',
  'provider',
  'harness',
  'harness_version',
  'harness_commit',
  'arm',
  'n_runs',
  'aggregator',
  'score_mean',
  'score_std',
  'resolved_ids_sha',
  'cost_usd_mean',
  'cost_usd_std',
  'input_tokens_mean',
  'output_tokens_mean',
  'steps_mean',
  'steps_p95',
  'wall_seconds_mean',
  'catalogue_bytes',
  'catalogue_tokens_per_call',
  'compaction_events_mean',
  'approval_cards_fired_mean',
  'approvals_auto_answered',
  'security_mode',
  'task_max_steps',
  'self_continuations',
  'max_compute_credits',
  'max_spend_usd',
  'surfaces_browser',
  'surfaces_desktop',
  'absent_route_requests',
  'backend',
  'isolates_network',
  'verifier_env',
  'network_mode',
  'infra_failures_advisory',
  'declared_drops',
  'run_started_at',
  'garden_commit'
];

const cell = (value: string | number | null): string => {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const round = (value: number, places: number): number =>
  Number.isFinite(value) ? Number(value.toFixed(places)) : 0;

/**
 * One row, or a refusal.
 *
 * Every throw below is a case where emitting a number would have been worse than emitting
 * nothing. That is the whole design: this rig's job is to be unable to flatter itself.
 */
export const rowFrom = (input: RowInput, digest: (value: string) => string): string[] => {
  if (input.shimMisses.length > 0)
    throw new Error(
      `this run asked for ${input.shimMisses.length} route(s) the shim does not implement (${input.shimMisses.join(', ')}), so every number in it was produced against a workspace that could not answer. No row.`
    );
  if (input.nTasks <= 0) throw new Error('a row needs a declared task count');
  if (input.runs.length === 0) throw new Error('a row needs at least one run');
  if (input.approvalsAutoAnswered > 0 && input.arm !== 'unattended')
    throw new Error(
      `${input.approvalsAutoAnswered} approval card(s) were auto-answered under arm "${input.arm}". Only "unattended" declares an auto-approver, so this row would name a configuration it was not measured under. No row.`
    );
  if (input.securityMode !== ARM_SECURITY_MODE[input.arm])
    throw new Error(
      `arm "${input.arm}" is ${ARM_SECURITY_MODE[input.arm]} and this run was ${input.securityMode}. No row.`
    );
  /*
   * And the other half of the auto-approver's story: an `unattended` row where cards fired and none
   * were answered.
   *
   * `unattended` is autonomous PLUS an auto-approver, and the auto-approver is the whole difference
   * between it and `autonomous`. A run whose approver was never attached raises cards, parks the
   * tasks at 0 and produces an `autonomous` number wearing the `unattended` label - so the
   * published gap between `shipped` and `unattended` reads smaller than it is, which is the
   * flattering direction: it says the approval floor costs less than it does.
   *
   * Only when cards actually fired. A task set where nothing reaches the floor legitimately answers
   * none, and refusing that would be refusing an honest row for having had nothing to do.
   */
  if (input.arm === 'unattended' && input.approvalsAutoAnswered === 0) {
    const fired = input.runs.reduce(
      (total, run) =>
        total + run.tasks.reduce((cards, task) => cards + (task.approvalCardsFired ?? 0), 0),
      0
    );
    if (fired > 0)
      throw new Error(
        `arm "unattended" declares an auto-approver and ${fired} approval card(s) fired with none auto-answered, so this run was "autonomous" under an "unattended" label. No row.`
      );
  }

  const scores = input.runs.map((run) => scoreOf(run, input.nTasks));
  const score = aggregate(scores);
  const cost = aggregate(input.runs.map((run) => sum(run, (task) => task.costUsd)));
  const steps = input.runs.flatMap((run) => run.tasks.map((task) => task.steps ?? 0));
  // The ids resolved in EVERY run, hashed. Two harnesses reporting the same score on different
  // tasks is the finding the score itself cannot show.
  const resolvedEverywhere = input.runs
    .map((run) => new Set(run.tasks.filter((task) => task.resolved === true).map((t) => t.taskId)))
    .reduce(
      (kept, current) => new Set([...kept].filter((id) => current.has(id))),
      new Set(
        input.runs[0]?.tasks.filter((task) => task.resolved === true).map((t) => t.taskId) ?? []
      )
    );

  return [
    input.benchmark,
    input.taskSet,
    String(input.nTasks),
    input.taskSetSha,
    input.model,
    input.modelRoute,
    input.provider,
    input.harness,
    input.harnessVersion,
    input.harnessCommit,
    input.arm,
    String(input.runs.length),
    AGGREGATOR,
    String(round(score.mean, 4)),
    score.std === null ? '' : String(round(score.std, 4)),
    digest([...resolvedEverywhere].sort().join('\n')),
    String(round(cost.mean, 4)),
    cost.std === null ? '' : String(round(cost.std, 4)),
    String(round(aggregate(input.runs.map((r) => sum(r, (t) => t.inputTokens))).mean, 0)),
    String(round(aggregate(input.runs.map((r) => sum(r, (t) => t.outputTokens))).mean, 0)),
    String(round(aggregate(input.runs.map((r) => meanOf(r, (t) => t.steps))).mean, 2)),
    String(percentile(steps, 0.95)),
    String(round(aggregate(input.runs.map((r) => meanOf(r, (t) => t.wallSeconds))).mean, 1)),
    String(input.catalogueBytes),
    String(input.catalogueTokensPerCall),
    String(round(aggregate(input.runs.map((r) => meanOf(r, (t) => t.compactions))).mean, 2)),
    String(round(aggregate(input.runs.map((r) => meanOf(r, (t) => t.approvalCardsFired))).mean, 2)),
    String(input.approvalsAutoAnswered),
    input.securityMode,
    String(input.taskMaxSteps),
    String(input.selfContinuations),
    input.maxComputeCredits === null ? '' : String(input.maxComputeCredits),
    input.maxSpendUsd === null ? '' : String(input.maxSpendUsd),
    input.surfaces.browser,
    input.surfaces.desktop,
    String(input.absentRequests),
    input.backend,
    String(input.isolatesNetwork),
    input.verifierEnv,
    input.networkMode,
    String(
      input.runs.reduce((total, run) => total + run.tasks.filter((t) => t.infraFailure).length, 0)
    ),
    input.declaredDrops.join('; '),
    input.runs[0]?.startedAt ?? '',
    input.harnessCommit
  ];
};

export const renderCsv = (rows: readonly (readonly string[])[]): string =>
  [COLUMNS, ...rows].map((row) => row.map(cell).join(',')).join('\n') + '\n';
