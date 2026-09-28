import { taskReasoningEffort } from '../reasoning.js';
import type { ReasoningEffort } from '@garden/contracts';
/**
 * Everything that has to be true, and everything that has to be measured, before a request is sent.
 *
 * Four things in a fixed order, and the order is what this phase is for:
 *
 *   - `lastStepUsd` is cleared **after** the guard that reads it and **before** the calls that fill
 *     it. A step is whatever this iteration spends - the lead call plus any specialist, compaction
 *     or search that runs inside it - and each of those used to overwrite it rather than add to it,
 *     so the spend guard was quoted the price of whichever happened to bill last;
 *   - the window is checked against the model **once**, before the first request, rather than after
 *     the provider refuses it. A window that cannot hold the catalogue and still leave room to work
 *     is a fact about the model the owner chose, and it is answerable - pick another one - but only
 *     if they are told;
 *   - compaction runs **before** the window is prepared, not while preparing it, because it is a
 *     durable edit to the persisted trajectory: the request that follows it, and every request
 *     until the next one, only appends to a prefix the provider has already cached;
 *   - and only then is the window prepared and the effort chosen from what it weighs.
 *
 * `windowOptions` is handed back rather than rebuilt by the caller because the derivation invariant
 * in `generate.ts` re-derives the request from exactly these, and the line after them overwrites
 * one: `toolOutputFloor` goes in as the *previous* step's floor and comes back as this step's, so a
 * re-derivation reading it off the state would be re-deriving a different request and would fail on
 * every healthy step.
 *
 * Lifted out of `AgentWorker.run()` unchanged.
 */
import type { TaskRecord } from '@garden/data';
import { GardenError } from '@garden/core';
import type { AgentState } from '../agent-state.js';
import {
  compactionTrigger,
  contextShortfall,
  estimatedContextTokens,
  modelInputBudget,
  prepareModelContext,
  type PreparedContext
} from '../context.js';
import { effortFloorEarned, reasoningEffortForStep } from '../turn-bounds.js';
import type { TurnRun } from './claim.js';
import type { CompactContext, TurnLoopControl, TurnStepBudget } from './loop-context.js';

/** What preparing a request needs from the worker that owns it. */
export interface TurnRequestDeps {
  /** Runs before the window is prepared, never while preparing it. */
  readonly compactContext: CompactContext;
  /** Throws rather than letting the turn spend a step discovering the route is not there. */
  assertProviderConfigured(task: TaskRecord): Promise<void>;
}

/** The three things the generation phase reads off this one. */
export interface PreparedStepRequest {
  readonly preparedContext: PreparedContext;
  readonly reasoningEffort: ReasoningEffort | undefined;
  /** Held so the derivation invariant re-derives from the same options this request used. */
  readonly windowOptions: {
    precedingTokens: number;
    reservedTokens: number;
    toolOutputFloor?: number;
  };
}

/** Prepares one step's request. Throws only where the owner can act on what it says. */
export const prepareStepRequest = async (
  deps: TurnRequestDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  run: TurnRun,
  budget: TurnStepBudget,
  control: Pick<TurnLoopControl, 'refreshActivePlan'>
): Promise<PreparedStepRequest> => {
  const { model, catalog, reservedTokens } = run;
  const { maxOutputTokens, turn } = budget;
  const { refreshActivePlan } = control;
  // Cleared here, after the guard that reads it and before the calls that fill it. A step is
  // whatever this iteration spends - the lead call plus any specialist, compaction or search
  // that runs inside it - and each of those used to overwrite this rather than add to it, so
  // the guard was quoted the price of whichever happened to bill last.
  state.lastStepUsd = 0;
  // Said once, before the first request rather than after the provider refuses it. A window
  // that cannot hold the catalogue and still leave room to work is a fact about the model the
  // owner chose, and it is answerable - pick another one - but only if they are told.
  const shortfall = contextShortfall(model.contextTokens, maxOutputTokens, reservedTokens);
  if (shortfall > 0)
    throw new GardenError(
      'model_context_too_small',
      `${model.displayName} has a ${model.contextTokens.toLocaleString()}-token window, and every request already carries about ${reservedTokens.toLocaleString()} tokens of tools before your first word. It is short by roughly ${shortfall.toLocaleString()} tokens, so this task cannot run on it - choose a model with a larger window.`
    );
  // Condensed before the window is prepared, not while preparing it: compaction is a durable
  // edit to the persisted trajectory, so the request that follows it - and every request until
  // the next one - only appends to a prefix the provider has already cached.
  if (
    // The size the last request actually had, not the size of the untrimmed trajectory. On the
    // first step of a turn there is no previous request, so the raw estimate stands in - it is
    // the conservative direction, and one early compaction is cheaper than one refused request.
    (state.preparedInputTokens ?? estimatedContextTokens(state.messages)) >
    compactionTrigger(modelInputBudget(model.contextTokens, maxOutputTokens, reservedTokens))
  ) {
    const compacted = await deps.compactContext(task, key, state, {
      model,
      catalog,
      maxOutputTokens,
      reservedTokens,
      trigger: 'budget',
      turn
    });
    if (compacted) await refreshActivePlan();
  }
  /*
   * Held rather than written inline, because the invariant below re-derives from exactly these
   * and the next line overwrites one of them: `toolOutputFloor` goes in as the *previous*
   * step's floor and comes back as this step's, so a re-derivation reading it off the state
   * would be re-deriving a different request and would fail on every healthy step.
   */
  const windowOptions = {
    precedingTokens: reservedTokens,
    reservedTokens,
    ...(state.toolOutputFloor === undefined ? {} : { toolOutputFloor: state.toolOutputFloor })
  };
  const preparedContext = prepareModelContext(
    state.messages,
    model.contextTokens,
    maxOutputTokens,
    windowOptions
  );
  state.toolOutputFloor = preparedContext.olderToolOutputChars;
  state.preparedInputTokens = preparedContext.estimatedInputTokens;
  const automaticEffort = reasoningEffortForStep({
    ...state,
    estimatedInputTokens: preparedContext.estimatedInputTokens,
    inputBudgetTokens: modelInputBudget(model.contextTokens, maxOutputTokens, reservedTokens)
  });
  const reasoningEffort = taskReasoningEffort(
    state.ownerReasoningEffort,
    automaticEffort,
    model.reasoning
  );
  // The ratchet, recorded rather than recomputed: once a turn has become the kind of turn that
  // needs the full budget it does not stop being one, and pinning the field is also what keeps
  // the provider's cached trajectory from being discarded on the next flip. The opening step is
  // deliberately excluded - it is high because it is the opening step, not because the work is
  // hard, and letting it set the floor would make every task high for its whole length. A tool
  // that threw is excluded for the same reason: it raises this step and not the turn.
  if (
    (!state.ownerReasoningEffort || state.ownerReasoningEffort === 'auto') &&
    state.step > 0 &&
    reasoningEffort === 'high' &&
    effortFloorEarned(state)
  )
    state.reasoningFloor = 'high';
  await deps.assertProviderConfigured(task);
  return { preparedContext, reasoningEffort, windowOptions };
};
