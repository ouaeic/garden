/**
 * A reply without tool calls is the answer. Before it stands, the harness runs the acceptance
 * checks the model declared for work this turn changed; a failure goes back to the model a bounded
 * number of times, and past that the answer completes with the failure stated beside it.
 */
import type { TaskRecord, DataStore } from '@garden/data';
import { deliveryFilePath, mediaDeliveryState } from '@garden/contracts';
import type { MemoryDeadEndCheck } from '@garden/core';
import {
  acceptanceFailureMessage,
  acceptanceObservation,
  acceptancePassedEvidence,
  type AcceptanceCommandCheck,
  type AcceptanceRecord,
  type AcceptanceResult
} from '../acceptance.js';
import type { AgentState, AgentWorkerConfig } from '../agent-state.js';
import {
  harnessEvidence,
  harnessVerificationStatus,
  observedCommands,
  type CompletionVerification
} from '../completion.js';
import { parkCodingMissionWait } from '../coding-missions.js';
import { declaredTaskOutputs, resolveDelivery } from '../delivery.js';
import { waitForQuestion } from '../questions.js';
import type { AgentRunnerClient } from '../runner-client.js';
import { event } from '../tool-recording.js';
import {
  ACCEPTANCE_COULD_NOT_RUN_CAVEAT,
  ACCEPTANCE_FAILED_CAVEAT,
  MAX_ACCEPTANCE_FAILURES
} from '../turn-bounds.js';

export interface TurnCompletion {
  summary: string;
  answer?: string;
  deliverables?: unknown[];
  verification: CompletionVerification;
  interrupted?: boolean;
  outstanding?: string[];
  acceptance?: string[];
  verifiedCommands?: readonly AcceptanceCommandCheck[];
}

/** What completing a turn needs from the worker that owns it. */
export interface TurnCompleteDeps {
  readonly runner: AgentRunnerClient;
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  outstandingPlanSteps(task: TaskRecord, key: Uint8Array): Promise<string[]>;
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
  completeTurn(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    completion: TurnCompletion,
    options?: { label?: string; deadEnds?: readonly MemoryDeadEndCheck[] }
  ): Promise<void>;
}

/** `continue` sends the model round again; the other two end this run of the loop. */
export type CompletionOutcome = 'continue' | 'completed' | 'parked';

/** The answer's first sentence or line, for the event summary and notifications. */
export const answerSummary = (answer: string): string => {
  const flat = answer.replace(/[#*_`>]/g, '').trim();
  const first = /^(.{1,400}?[.!?])(\s|$)/s.exec(flat)?.[1] ?? flat.split('\n')[0] ?? '';
  return first.slice(0, 400) || 'Done.';
};

export const completeAnswer = async (
  deps: TurnCompleteDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  assistantText: string
): Promise<CompletionOutcome> => {
  // A pending question or running specialists make an ended reply a wait, not an answer.
  if (state.question) {
    await waitForQuestion(deps, task, key, state);
    return 'parked';
  }
  if (await parkCodingMissionWait(deps, task, key, state)) return 'parked';

  let verification: CompletionVerification = {
    status: 'not_applicable',
    evidence: [],
    remainingRisks: []
  };
  let acceptance: string[] = [];
  let verifiedCommands: AcceptanceCommandCheck[] = [];
  let deadEnds: MemoryDeadEndCheck[] = [];
  if (state.acceptance && state.mode !== 'plan' && state.mutatedBeyondProse) {
    const results = await deps.runAcceptanceChecks(
      task,
      key,
      state.acceptance,
      { purpose: 'finish', observed: observedCommands(state) },
      state
    );
    const failed = results.filter((result) => !result.passed);
    if (failed.length) {
      const attempt = (state.acceptanceFailures ?? 0) + 1;
      state.acceptanceFailures = attempt;
      if (attempt < MAX_ACCEPTANCE_FAILURES) {
        state.repairStep = true;
        state.messages.push({
          role: 'system',
          content: acceptanceFailureMessage(results, attempt, MAX_ACCEPTANCE_FAILURES)
        });
        await event(
          deps.store,
          task,
          key,
          'status',
          `${failed.length} of ${results.length} checks failed — ${failed
            .map((result) => result.label)
            .join('; ')
            .slice(0, 160)}`,
          { acceptance: results }
        );
        return 'continue';
      }
    } else state.acceptanceFailures = 0;
    verifiedCommands = state.acceptance.checks.filter(
      (check): check is AcceptanceCommandCheck =>
        check.kind === 'command' &&
        results.some((result) => result.id === check.id && result.passed)
    );
    deadEnds = state.acceptance.checks.flatMap((check) => {
      if (check.kind !== 'command') return [];
      const result = results.find((entry) => entry.id === check.id && !entry.passed);
      if (!result || acceptanceObservation(result) !== 'failed') return [];
      return [
        {
          label: check.label,
          command: [check.executable, ...check.args].join(' '),
          cwd: check.cwd,
          detail: result.detail
        }
      ];
    });
    acceptance = acceptancePassedEvidence(results);
    verification = {
      status: harnessVerificationStatus('verified', results),
      evidence: harnessEvidence(results),
      remainingRisks: failed.map((result) => `${result.label} — ${result.detail}`)
    };
    if (failed.length) {
      const caveat =
        verification.status === 'checks_did_not_run'
          ? ACCEPTANCE_COULD_NOT_RUN_CAVEAT
          : ACCEPTANCE_FAILED_CAVEAT;
      acceptance = [caveat, ...acceptance];
      verification.remainingRisks = [caveat, ...verification.remainingRisks].slice(0, 20);
    }
  }

  const outputs = state.mode === 'plan' ? [] : await declaredTaskOutputs(deps.store, task.id, key);
  const mediaDelivery = mediaDeliveryState(
    await deps.store.listMediaJobs(task.userId, task.id, 100)
  );
  const delivery = await resolveDelivery(deps, task, key, state, [], {
    outputs,
    passedCheckIds: new Set(verifiedCommands.map((check) => check.id)),
    deferredFiles: new Set(
      [...mediaDelivery.pending, ...mediaDelivery.failed]
        .map((job) => deliveryFilePath(job.outputPath))
        .filter((path): path is string => path !== null)
    )
  });
  if (mediaDelivery.failed.length)
    delivery.unavailable.push('A requested media output failed. Inspect its recorded job status.');
  if (delivery.unavailable.length)
    verification = {
      ...verification,
      status: 'delivery_incomplete',
      remainingRisks: [
        ...delivery.unavailable.map((value) => `Unavailable output: ${value}`),
        ...verification.remainingRisks
      ].slice(0, 20)
    };
  else if (mediaDelivery.pending.length)
    verification = {
      ...verification,
      status:
        verification.status === 'verified' || verification.status === 'not_applicable'
          ? 'delivery_pending'
          : verification.status,
      remainingRisks: [
        'Media is still generating; the files appear when the provider delivers them.',
        ...verification.remainingRisks
      ].slice(0, 20)
    };

  await deps.completeTurn(
    task,
    key,
    state,
    {
      summary: answerSummary(assistantText),
      answer: assistantText,
      deliverables: delivery.deliverables,
      verification,
      ...(acceptance.length ? { acceptance } : {}),
      ...(verifiedCommands.length ? { verifiedCommands } : {})
    },
    deadEnds.length ? { deadEnds } : {}
  );
  return 'completed';
};
