/**
 * The acceptance record: what would prove this job is done, taken from the model and made real.
 *
 * The one mechanism in garden that cannot be satisfied by the model deciding its own work is good,
 * and the reason is the red baseline below: before the turn has changed anything, the checks are
 * run *as declared*, and a record where none of them fails is refused. A test that passes before
 * the work is a test of nothing.
 *
 * Once the turn has already changed something there is no such reading to be had - what passes now
 * may be the work or may always have been true - so the record is taken as it stands and no
 * baseline is claimed for it. The caveat that says so travels to the completion card.
 *
 * Lifted out of `AgentWorker.run()`'s batch loop unchanged; the arm's `continue`s became `return`s,
 * which is the whole of the edit.
 */
import type { ModelToolCall } from '@garden/model-gateway';
import type { TaskRecord, DataStore } from '@garden/data';
import {
  acceptanceAcceptedResult,
  describeAcceptanceCheck,
  parseAcceptanceChecks,
  type AcceptanceRecord,
  type AcceptanceResult
} from '../acceptance.js';
import type { AgentState } from '../agent-state.js';
import { event } from '../tool-recording.js';
import type { AgentRunnerClient } from '../runner-client.js';
import { inspectAcceptanceChecks } from '../acceptance-inspection.js';
import {
  ACCEPTANCE_ALREADY_PASSED_CAVEAT,
  MAX_ACCEPTANCE_BASELINE_REFUSALS,
  acceptanceBaselineNote,
  acceptanceBaselineRefusal
} from '../turn-bounds.js';

/** What declaring an acceptance record needs from the worker that owns the turn. */
export interface AcceptanceDeclarationDeps {
  readonly store: DataStore;
  readonly runner: AgentRunnerClient;
  runAcceptanceChecks(
    task: TaskRecord,
    key: Uint8Array,
    record: AcceptanceRecord,
    options?: {
      purpose: 'finish' | 'baseline' | 'continuation';
      observed?: ReadonlyMap<string, number>;
    },
    state?: AgentState
  ): Promise<AcceptanceResult[]>;
}

/** Answers a `set_acceptance` call. The call is always answered; the batch always moves on. */
export const declareAcceptance = async (
  deps: AcceptanceDeclarationDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall,
  /** The turn this record is being declared for, which is what makes it this turn's evidence. */
  turn: number
): Promise<void> => {
  const parsed = parseAcceptanceChecks(call.arguments.checks);
  state.turnToolResults ??= {};
  if (!parsed.ok) {
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: `Acceptance record rejected: ${parsed.reason}`
    });
    state.turnToolResults[call.id] = { name: call.name, success: false };
    return;
  }
  const issues = await inspectAcceptanceChecks(deps.runner, task, parsed.checks);
  if (issues.length) {
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: `Acceptance record rejected: ${issues.join(' ')} Use exact artifact JSON assertions when appropriate.`
    });
    state.turnToolResults[call.id] = { name: call.name, success: false };
    return;
  }
  const previous = state.acceptance;
  const record: AcceptanceRecord = {
    checks: parsed.checks,
    revisions: (previous?.revisions ?? 0) + 1,
    declaredAtStep: state.step
  };
  // The red baseline, and the only part of this mechanism that cannot be satisfied by the
  // model deciding its own work is good: the checks are run against the job as it stands
  // before the turn has changed anything, and a record where none of them fails is refused.
  // Once the turn has already changed something there is no such reading to be had - what
  // passes now may be the work or may always have been true - so the record is taken as it
  // stands and no baseline is claimed for it.
  //
  // Set only by the branch below. What the completion says about the checks now describes
  // the checks; when there is nothing of that kind to say, it says nothing.
  let caveat: string | undefined;
  let baseline: AcceptanceResult[] | null = null;
  if (!state.mutated) {
    baseline = await deps.runAcceptanceChecks(task, key, record, { purpose: 'baseline' });
    if (baseline.every((result) => result.passed)) {
      const attempt = (state.acceptanceBaselineRefusals ?? 0) + 1;
      state.acceptanceBaselineRefusals = attempt;
      if (attempt < MAX_ACCEPTANCE_BASELINE_REFUSALS) {
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: acceptanceBaselineRefusal(baseline, attempt, MAX_ACCEPTANCE_BASELINE_REFUSALS)
        });
        state.turnToolResults[call.id] = { name: call.name, success: false };
        await event(
          deps.store,
          task,
          key,
          'status',
          'Acceptance checks refused: they already pass',
          { checks: parsed.checks.map(describeAcceptanceCheck), acceptance: baseline }
        );
        return;
      }
      caveat = ACCEPTANCE_ALREADY_PASSED_CAVEAT;
    } else state.acceptanceBaselineRefusals = 0;
  }
  state.acceptance = record;
  state.acceptanceTurn = turn;
  if (caveat) state.acceptanceCaveat = caveat;
  else delete state.acceptanceCaveat;
  // Both versions reach the timeline. Weakening your own test in front of the owner is a
  // different act from passing it, and it should read like one.
  await event(
    deps.store,
    task,
    key,
    'status',
    previous
      ? `Acceptance checks revised (version ${record.revisions})`
      : 'Acceptance checks declared',
    {
      revision: record.revisions,
      checks: parsed.checks.map(describeAcceptanceCheck),
      ...(previous ? { replaced: previous.checks.map(describeAcceptanceCheck) } : {}),
      ...(baseline ? { baseline } : {}),
      ...(caveat ? { caveat } : {})
    }
  );
  state.messages.push({
    role: 'tool',
    toolCallId: call.id,
    content: [
      acceptanceAcceptedResult(record),
      caveat ?? (baseline ? acceptanceBaselineNote(baseline) : '')
    ]
      .filter(Boolean)
      .join('\n')
  });
  state.turnToolResults[call.id] = { name: call.name, success: true };
};
