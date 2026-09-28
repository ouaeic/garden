/**
 * How a turn ends when a ceiling ended it: one closing model call, and a written record of where
 * the work stopped whether or not that call can be made.
 *
 * This existed three times inside `AgentWorker.run()` - once at the wall-clock ceiling, once at the
 * compute-credit ceiling, once at the step ceiling - as three copies of the same forty lines. They
 * differed in a `reason` field, an error code, and six words of one sentence. Everything else was
 * duplicated: the handoff call with its eight-field context, the outstanding-plan read that must
 * not be allowed to throw, the carry-over message, the best-effort state write, and the closing
 * `GardenError`.
 *
 * Three copies of a recovery path is worse than three copies of anything else, because the copy
 * that is exercised least is the one that is wrong. The insurance comment - "a provider that is
 * down for the closing call must not also cost the record of where the work stopped" - was written
 * out twice and paraphrased a third time; the behaviour is now stated once.
 *
 * It takes `HandoffDeps` rather than a bag of its own: the ceiling policy already lives in
 * `handoff.ts` and already asks for exactly these two operations, and a second deps interface over
 * the same two would be scaffolding. What this file adds is the *phase* - what the turn does about
 * a ceiling - which is the part that was inline.
 */
import { encryptJson, GardenError } from '@garden/core';
import type { ModelRelease, WebToolPlan } from '@garden/contracts';
import type { TaskRecord } from '@garden/data';
import type { ModelGateway, ModelTool } from '@garden/model-gateway';
import type { AgentState } from '../agent-state.js';
import { handOffAtStepLimit, type HandoffDeps } from '../handoff.js';
import { stepLimitCarryOver } from '../turn-bounds.js';
import { saveQuestion } from '../questions.js';

/** The run-scoped facts the closing call is built from, fixed for the life of the turn. */
export interface TurnCloseContext {
  readonly gateway: ModelGateway;
  readonly provider: string;
  readonly model: ModelRelease;
  readonly catalog: ModelRelease[];
  readonly turn: number;
  readonly maxOutputTokens: number;
  readonly tools: ModelTool[];
  readonly webPlan: WebToolPlan;
}

/** Which ceiling was reached, in the two places the turn's ending differs because of it. */
export interface TurnCeiling {
  readonly reason?: 'steps' | 'credits' | 'time';
  readonly code: 'task_budget_reached' | 'step_limit_reached';
  /**
   * The clause naming the ceiling, as it reads in the sentence the owner is given: "ran for its
   * whole time budget", "used its whole compute budget", "used all 40 of its steps".
   */
  readonly spent: string;
}

/**
 * The closing handoff for a turn that reached a ceiling, and the insurance behind it.
 *
 * The handoff is one model call. A provider that is down for it must not also cost the record of
 * where the work stopped, so the carry-over is persisted either way - and the ceiling is then
 * reported with the same sentence every bounded stop in this loop uses, which is that the work is
 * saved and a reply continues it.
 */
export const closeTurnAtCeiling = async (
  deps: HandoffDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  context: TurnCloseContext,
  ceiling: TurnCeiling
): Promise<void> => {
  if (state.question) {
    state.question.waiting = true;
    await saveQuestion(deps, task, key, state, true);
    return;
  }
  await handOffAtStepLimit(deps, task, key, state, {
    ...context,
    ...(ceiling.reason === undefined ? {} : { reason: ceiling.reason })
  }).catch(async (error: unknown) => {
    const outstanding = await deps.outstandingPlanSteps(task, key).catch(() => []);
    state.messages.push({ role: 'system', content: stepLimitCarryOver(state.step, outstanding) });
    await deps.store
      .updateTask({
        id: task.id,
        workerId: deps.config.WORKER_ID,
        status: 'running',
        actualComputeCredits: state.credits,
        agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
      })
      .catch(() => undefined);
    throw new GardenError(
      ceiling.code,
      `This turn ${ceiling.spent}, and the closing handoff could not be written either (${error instanceof Error ? error.message : 'unknown error'}).${
        outstanding.length ? ` Still open: ${outstanding.slice(0, 3).join('; ')}.` : ''
      } Everything it produced is saved - reply to carry on from where it stopped.`
    );
  });
};
