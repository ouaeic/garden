import { runtimeNow } from '@garden/core';
/**
 * Running the acceptance record in the harness: once per state of the workspace, and inside one
 * deadline for the suite rather than one per check.
 *
 * A suite is a build and a test run, so two things bound what it costs. A suite that passed is not
 * run again against a workspace nothing has touched since, however many times the turn asks. And
 * the suite as a whole has one deadline, because `MAX_ACCEPTANCE_CHECKS` checks at
 * `ACCEPTANCE_COMMAND_TIMEOUT_SECONDS` each would otherwise compose to two hours.
 */
import type { DataStore, TaskRecord } from '@garden/data';
import type { JsonProofResult } from '@garden/contracts';
import {
  acceptanceAlreadyObserved,
  acceptanceCommandText,
  resultCommand,
  type AcceptanceRecord,
  type AcceptanceResult
} from './acceptance.js';
import type { AgentState, ExecObservation } from './agent-state.js';
import { evidenceFloor } from './completion.js';
import type { AgentRunnerClient } from './runner-client.js';
import { event } from './tool-recording.js';
import { inspectAcceptanceChecks } from './acceptance-inspection.js';

/**
 * How long the whole suite may take, in seconds.
 *
 * Deliberately the same figure one command may spend: a single long build is what the per-check
 * ceiling was calibrated for and nothing about it changes, while eight of them can no longer
 * multiply into a turn that holds the owner's computer for two hours after the model said it was
 * done.
 *
 * Command checks are clamped to the remaining budget. Render checks receive the same absolute
 * deadline, including time spent in transport, conversion and per-page probes. Cancellation
 * reaches the runner through the request signal and kills the converter's process group.
 */
export const ACCEPTANCE_SUITE_DEADLINE_SECONDS = 900;

/** What running the suite needs from the worker that owns the turn. */
export interface AcceptanceRunnerDeps {
  readonly store: DataStore;
  readonly runner: AgentRunnerClient;
  withLeaseRenewal<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T>;
  withCancellationWatch<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T>;
}

/**
 * One run of the suite per state of the workspace, held against the turn it was run for.
 *
 * A `WeakMap` keyed on the state object rather than a field on `AgentState`, for two reasons. The
 * state is serialised into every checkpoint, so a field would put a full set of results - stderr
 * included - into the encrypted row on every write. And a resumed turn must re-run the checks: the
 * process that observed the workspace is gone, and a memo that survived a restart would be
 * asserting something about a computer it never looked at.
 */
const suiteMemo = new WeakMap<AgentState, { key: string; results: AcceptanceResult[] }>();

/**
 * What has to be the same for one run of the suite to answer the next ask.
 *
 * The revisions count moves whenever the model declares a different record; `lastMutation` is the
 * shared reading of "after the last change" that the completion contract already uses, so a turn
 * that writes another file invalidates the memo exactly where the contract says the evidence went
 * stale. The tool-result count is stricter than either: any call at all that lands in the window
 * throws the memo away, which covers the case where a non-mutating command changes what
 * `observedCommands` can answer without moving the floor.
 *
 * `purpose` is in the key because the two purposes ask different questions.
 */
const acceptanceMemoKey = (
  record: AcceptanceRecord,
  state: AgentState,
  options: { purpose: 'finish' | 'continuation' }
): string =>
  [
    options.purpose,
    record.revisions,
    record.declaredAtStep,
    evidenceFloor(state).lastMutation,
    Object.keys(state.turnToolResults ?? {}).length
  ].join(':');

/**
 * Runs the acceptance record the model declared, in the harness, at the moment it says it is done.
 *
 * The arguments were fixed before the work; nothing here is chosen by the model at this moment,
 * which is the difference between a check and a second chance to act. A check that cannot run at
 * all counts as a failure rather than a pass - "the test runner is not installed" is a true
 * statement about a job that is not finished.
 *
 * The same run answers a second question at declaration time: does this check already pass? A
 * record that cannot fail on the unfinished job is the model asserting its own success in a form
 * the harness can execute, and the only way to know is to run it before the work rather than to
 * ask the model whether its test is a real one.
 */
export const runAcceptanceChecks = async (
  deps: AcceptanceRunnerDeps,
  task: TaskRecord,
  key: Uint8Array,
  record: AcceptanceRecord,
  /**
   * `continuation` asks the finish-time question at the step ceiling - is this job done? - so it
   * gets the finish-time timeouts. Only the sentence the owner reads differs, because a check run
   * to decide whether to keep working is not the same event as one run to decide whether to stop.
   */
  options: {
    purpose: 'finish' | 'continuation';
    /**
     * Commands garden already ran this turn, after the last change. Never passed for a baseline:
     * that run's whole job is to watch the checks fail before the work, which is a question no
     * earlier observation can answer.
     */
    observed?: ReadonlyMap<string, number>;
  } = { purpose: 'finish' },
  /**
   * The turn, so one run of the suite can answer a second ask about the same workspace.
   *
   * Optional: a run without a turn has nothing to memoise against, so it always runs fresh.
   */
  state?: AgentState
): Promise<AcceptanceResult[]> => {
  /*
   * Watched, like every other run of commands this file makes.
   *
   * An acceptance suite is a build and a test run: the two longest things a turn does after the
   * model call, and the only ones the owner is told are running. Without the watch a Stop pressed
   * during the checks would stop nothing - the suite would run to the runner's own ceiling on the
   * box, still writing files, while the interface said the task had stopped. `#withCancellationWatch`
   * aborts the runner requests, which surface as failed checks and let the loop take the task down
   * cleanly. Around the whole suite rather than around each check, so one Stop reaches all of them.
   */
  const memoKey = state ? acceptanceMemoKey(record, state, options) : null;
  if (memoKey !== null && state) {
    const memo = suiteMemo.get(state);
    if (memo?.key === memoKey) return memo.results;
  }
  const results = await deps.withCancellationWatch(task, () =>
    acceptanceChecks(deps, task, key, record, options)
  );
  /*
   * Only a suite that passed is remembered.
   *
   * A failing run is the harness telling the model to go and fix something, and the whole point of
   * the next answer is to find out whether it did - so a failure is re-run every time, and the
   * "failed, fixed, passed inside one turn" path is untouched by this. What the memo covers is a
   * suite that passed, asked again with no tool call in between to have changed anything: the only
   * case where the second run could not say anything the first did not.
   */
  if (memoKey !== null && state && results.every((result) => result.passed))
    suiteMemo.set(state, { key: memoKey, results });
  return results;
};

export const acceptanceChecks = async (
  deps: AcceptanceRunnerDeps,
  task: TaskRecord,
  key: Uint8Array,
  record: AcceptanceRecord,
  options: {
    purpose: 'finish' | 'continuation';
    observed?: ReadonlyMap<string, number>;
  }
): Promise<AcceptanceResult[]> => {
  /*
   * THE VERIFIER IS NOT ISOLATED FROM THE AGENT, and a reader looking for that guarantee should
   * stop here and read this as a no.
   *
   * `${root}/exec` is the identical endpoint, workspace id and `exec` scope that the model's own
   * `shell` tool posts to (apps/worker/src/tools/workspace.ts:743). Nothing snapshots the tree
   * between the moment the record is declared and the moment it runs, so a check CAN be written by
   * the same turn that runs it: `bash workspace/rename-scans.sh` is a pinned-accepted declaration,
   * and the agent wrote that script this turn. What garden has instead is a weaker pair - the
   * arguments are fixed before the work rather than chosen at finish time, and the red baseline
   * falsifies the record on the paths where it runs - and neither of those is isolation.
   *
   * The honest repair is a runner endpoint that runs the finish-time suite against a copy of the
   * workspace the agent has never held a handle to. It needs services/workspace-runner and this file
   * together, so it is a wave and not a line, and it is not attempted here. The test named for this
   * sentence pins the endpoint, so the day someone does route the suite elsewhere this comment goes
   * red rather than quietly becoming a lie.
   */
  const root = `/v1/workspaces/${task.workspaceId}`;
  const results: AcceptanceResult[] = [];
  /*
   * One clock for the suite, not one per check.
   *
   * Every per-check ceiling in this file is correct and they compose badly: a record may declare
   * `MAX_ACCEPTANCE_CHECKS` checks and each may ask for `ACCEPTANCE_COMMAND_TIMEOUT_SECONDS`, so
   * eight wedged checks are two hours of a turn nobody is watching - on the path that runs after
   * the model has already said it is done. The deadline is the same 900 seconds one check may
   * spend, so a single long build is unaffected and eight of them can no longer multiply it.
   *
   * Read from the wall clock rather than accumulated from the runner's own `durationMs`: what is
   * bounded is how long the turn is held, which includes the round trips and a runner that answers
   * slowly, not only the time a command was running.
   */
  const deadlineAt = runtimeNow() + ACCEPTANCE_SUITE_DEADLINE_SECONDS * 1_000;
  for (const check of record.checks) {
    try {
      const issues = await inspectAcceptanceChecks(deps.runner, task, [check]);
      if (issues.length) {
        results.push({
          id: check.id,
          label: check.label,
          passed: false,
          detail: `the check could not run: ${issues.join(' ')}`,
          ...resultCommand(check)
        });
        continue;
      }
      const already = options.observed ? acceptanceAlreadyObserved(check, options.observed) : null;
      if (already) {
        results.push(already);
        continue;
      }
      // Asked after the free answer above, deliberately: a check the harness already watched run
      // costs nothing to report, and a suite that is out of time is still allowed to say what it
      // already knows.
      const remainingSeconds = Math.ceil((deadlineAt - runtimeNow()) / 1_000);
      if (remainingSeconds <= 0) {
        // A failure, on the same rule as every other check that could not run: "the suite ran out
        // of time" is a true statement about this computer and it is not evidence of the work.
        results.push({
          id: check.id,
          label: check.label,
          passed: false,
          detail: `the check could not run: the acceptance suite ran out of time after ${ACCEPTANCE_SUITE_DEADLINE_SECONDS}s`,
          ...resultCommand(check)
        });
        continue;
      }
      if (check.kind === 'command') {
        const timeoutSeconds = Math.min(
          check.timeoutSeconds,
          // Never longer than the suite has left, so the last check to start cannot outlive the
          // deadline it started inside.
          remainingSeconds
        );
        const observation = await deps.withLeaseRenewal(task, () =>
          deps.runner.call<ExecObservation>(task.workspaceId, task.id, 'exec', `${root}/exec`, {
            executable: check.executable,
            args: [...check.args],
            cwd: check.cwd,
            timeoutSeconds
          })
        );
        const exitOk = observation.exitCode === check.expectExit;
        const containsOk =
          !check.expectStdoutContains ||
          // Both streams, because a test runner reporting to stderr is still reporting - and the
          // schema now says so rather than promising stdout and searching both.
          `${observation.stdout}\n${observation.stderr}`.includes(check.expectStdoutContains);
        results.push({
          id: check.id,
          label: check.label,
          command: acceptanceCommandText(check),
          passed: exitOk && containsOk && !observation.timedOut,
          detail: observation.timedOut
            ? `timed out after ${timeoutSeconds}s running ${check.executable}`
            : !exitOk
              ? `exit ${observation.exitCode ?? 'null'} (expected ${check.expectExit}): ${(observation.stderr || observation.stdout).trim().slice(0, 2_000) || 'no output'}`
              : !containsOk
                ? `exit ${observation.exitCode}, but the output does not contain "${check.expectStdoutContains}": ${(observation.stdout || observation.stderr).trim().slice(-800)}`
                : `exit ${observation.exitCode}`
        });
        continue;
      }
      const directory = check.path.split('/').slice(0, -1).join('/') || 'workspace';
      const name = check.path.split('/').filter(Boolean).pop() ?? '';
      const listing = await deps.runner.call<{
        entries: Array<{ name: string; type: string; sizeBytes: number }>;
      }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/files?path=${encodeURIComponent(directory)}`
      );
      const entry = listing.entries.find((candidate) => candidate.name === name);
      const present = entry?.type === 'file' && entry.sizeBytes >= check.minBytes;
      /*
       * What the file is, for a job a byte count was never about.
       *
       * Asked of the runner, and only once the file is known to be there: it renders the
       * deliverable as it stands at this moment - the .pptx itself, not a proof PDF from earlier
       * in the turn - and answers with the finding already in the sentence the owner reads. A
       * render that cannot be made throws, which the surrounding catch reports as a check that
       * could not run; nothing here can report an unmeasured document as a passing one.
       */
      const render = check.render;
      const rendered =
        present && render
          ? await deps.withLeaseRenewal(task, () =>
              deps.runner.call<{ passed: boolean; detail: string }>(
                task.workspaceId,
                task.id,
                'exec',
                `${root}/document/render-proof`,
                {
                  path: check.path,
                  deadlineAt,
                  ...(render.expectPages === undefined ? {} : { expectPages: render.expectPages }),
                  marginPoints: render.marginPoints
                }
              )
            )
          : undefined;
      const json =
        present && check.json
          ? await deps.runner.call<JsonProofResult>(
              task.workspaceId,
              task.id,
              'files.read',
              `${root}/json-proof`,
              {
                path: check.path,
                json: check.json
              }
            )
          : undefined;
      results.push({
        id: check.id,
        label: check.label,
        passed: present && (rendered?.passed ?? true) && (json?.passed ?? true),
        detail: !entry
          ? `${check.path} does not exist`
          : entry.type !== 'file'
            ? `${check.path} is a ${entry.type}, not a file`
            : rendered || json
              ? (rendered ?? json)!.detail
              : `${entry.sizeBytes} bytes (needs at least ${check.minBytes})`
      });
    } catch (error) {
      results.push({
        id: check.id,
        label: check.label,
        passed: false,
        detail: `the check could not run: ${error instanceof Error ? error.message : 'unknown error'}`,
        ...resultCommand(check)
      });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  await event(
    deps.store,
    task,
    key,
    'status',
    options.purpose === 'continuation'
      ? `Acceptance checks at the step ceiling: ${passed} of ${results.length} passed`
      : `Acceptance checks: ${passed} of ${results.length} passed`,
    { acceptance: results }
  ).catch(() => undefined);
  return results;
};
