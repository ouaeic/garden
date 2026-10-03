/** The acceptance record: checks the model declares and the harness runs when the turn ends. */
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

/** What declaring an acceptance record needs from the worker that owns the turn. */
export interface AcceptanceDeclarationDeps {
  readonly store: DataStore;
  readonly runner: AgentRunnerClient;
  runAcceptanceChecks(
    task: TaskRecord,
    key: Uint8Array,
    record: AcceptanceRecord,
    options?: {
      purpose: 'finish' | 'continuation';
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
  state.acceptance = record;
  state.acceptanceTurn = turn;
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
      ...(previous ? { replaced: previous.checks.map(describeAcceptanceCheck) } : {})
    }
  );
  state.messages.push({
    role: 'tool',
    toolCallId: call.id,
    content: acceptanceAcceptedResult(record)
  });
  state.turnToolResults[call.id] = { name: call.name, success: true };
};
