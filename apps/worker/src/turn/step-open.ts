import type { TaskRecord } from '@athanor/data';
import { encryptJson } from '@athanor/core';
import type { AgentState } from '../agent-state.js';
import { refreshArtifactLedger } from '../context.js';
import { noteStepBudget, stepCeiling, turnWallClockReached, type HandoffDeps } from '../handoff.js';
import { applyDormantRules, toolsRunThisTurn } from '../rules/index.js';
import { closeTurnAtCeiling, type TurnCloseContext } from './close.js';
import type { TurnLoopControl } from './loop-context.js';

/** What opening a step needs from the worker that owns it. */
export interface TurnStepOpenDeps {
  /** The step budget and all three closing handoffs are built from this one set. */
  readonly handoff: HandoffDeps;
  /** The owner's own daily and monthly caps, which are neither a step nor a credit. */
  haltIfOutOfMoney(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<boolean>;
}

/**
 * Runs the opening of one step.
 *
 * `'closed'` means the turn is over and has already said so on the owner's timeline - the caller
 * returns without writing anything further. `'open'` means the step may be prepared.
 */
export const openStep = async (
  deps: TurnStepOpenDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  /** Fixed for the life of the run; what any of the three ceilings hands over. */
  closeContext: TurnCloseContext,
  /** When this turn was leased, which is what the clock ceiling is measured from. */
  turnStartedAt: number,
  control: Pick<
    TurnLoopControl,
    'honorUserControl' | 'drainCorrection' | 'refreshActivePlan' | 'refreshRuntimeContext'
  >
): Promise<'open' | 'closed'> => {
  const { honorUserControl, drainCorrection, refreshActivePlan, refreshRuntimeContext } = control;
  if (await honorUserControl()) return 'closed';
  // Before the plan is refreshed, so a correction that changes the goal is in the window when
  // the plan is read rather than one step behind it.
  await drainCorrection();
  await refreshActivePlan(state.mutated === true || state.step >= 2);
  await noteStepBudget(deps.handoff, task, key, state, stepCeiling(deps.handoff, state));
  /*
   * The dormant rules, read against the step the model just produced.
   *
   * Here rather than where the assistant message is pushed, for two reasons that are both about
   * shape. At a step boundary every tool call has been answered, so a correction appended now
   * cannot land between a call and its result - which is the malformed request the cut-off-reply
   * branch below refuses for the same reason. And a rule's view of the turn includes what the
   * step's own calls *did*, which is not known until they have run: the render-proof rule asks
   * whether this turn has looked at a rendered page, and the answer arrives with the tool result
   * rather than with the request for it.
   *
   * Ahead of the runtime block deliberately, so the block that carries the clock stays last and
   * keeps costing nothing. @see rules/index.ts for why this is a tier of its own and why the
   * firing rate is instrumented from the first commit.
   */
  applyDormantRules(state.messages, toolsRunThisTurn(state.turnToolResults));
  /*
   * What this turn has changed, re-rendered from the durable record rather than appended.
   *
   * Here, and not where the write happens, because the point of the block is that it is rebuilt:
   * a fact appended once travels backwards through the window and the first compaction that
   * reaches it condenses it away, which is the whole of why the plan the agent narrates in prose
   * scores 0.0 in every compacted configuration of `evals/context-quality` and the plan carried
   * by a re-rendered block scores 5.0. Second from the tail, in front of the runtime block, so it
   * sits inside `MIN_PROTECTED_TAIL_MESSAGES` and no compaction ever reaches it either.
   *
   * Synchronous and unconditional, so it needs nothing from the worker and cannot fail: it reads
   * `state.artifactLedger`, which `executeWorkspaceTool` has already bounded. @see
   * refreshArtifactLedger in `context.ts`.
   */
  refreshArtifactLedger(state.messages, state.artifactLedger);
  // Last of the tail blocks, and re-pushed on every step rather than once per turn: a block
  // left where the next step's tool results bury it stops being free to change. At a step
  // boundary every tool call has been answered, so nothing here can split a call from its
  // result.
  refreshRuntimeContext();
  if (state.credits >= task.maxComputeCredits) {
    // The same closing call the step ceiling gets. A turn that stops because it ran out of
    // money has exactly as much to hand over as one that ran out of steps, and the owner is
    // owed the same thing: what was done, what is left, and that a reply carries on.
    if (await honorUserControl()) return 'closed';
    await closeTurnAtCeiling(deps.handoff, task, key, state, closeContext, {
      reason: 'credits',
      code: 'task_budget_reached',
      spent: 'used its whole compute budget'
    });
    return 'closed';
  }
  if (await deps.haltIfOutOfMoney(task, key, state)) return 'closed';
  // Yield only between settled steps. The next lease inherits the same turn, credits and limits.
  if (turnWallClockReached(turnStartedAt)) {
    if (await honorUserControl()) return 'closed';
    await deps.handoff.store.yieldTaskLease({
      taskId: task.id,
      workerId: deps.handoff.config.WORKER_ID,
      agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
      actualComputeCredits: state.credits
    });
    return 'closed';
  }
  return 'open';
};
