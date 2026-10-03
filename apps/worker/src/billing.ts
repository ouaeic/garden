/**
 * What a step cost, in the two currencies this box counts in.
 *
 * Compute credits are the owner's budget for a task and dollars are what the provider will actually
 * charge; they are not the same number and neither is derivable from the other, so both are
 * computed here from the same usage figures.
 *
 * The idempotency keys are in this file rather than beside the ledger writer because a key is the
 * whole of what stops a retried step from being billed twice - it is a money decision written as a
 * string, and it belongs where the money decisions are.
 */
import type { ModelRelease } from '@garden/contracts';
import { pricesAtPromptSize, readRoutingMetadata, sha256 } from '@garden/core';
import type { DataStore } from '@garden/data';
import type { ModelResponse } from '@garden/model-gateway';

/** A native request settles or holds its own durable receipt before the ordinary step returns. */
export const recordModelStepUsage = async (
  store: Pick<DataStore, 'recordUsage'>,
  response: ModelResponse,
  usage: Parameters<DataStore['recordUsage']>[0]
): Promise<void> => {
  if (response.nativeInputUsageRecorded) return;
  const generationId = response.metadata.generationId;
  // Provider IDs can repeat across requests. A retained local invocation distinguishes charges
  // while a replay of the same response still settles only once.
  const receiptKey =
    response.metadata.requestId && usage.taskId
      ? `task:${usage.taskId}:request:${sha256(response.metadata.requestId)}`
      : generationId && usage.taskId
        ? `task:${usage.taskId}:generation:${sha256(`${response.metadata.provider}:${generationId}`)}`
        : usage.idempotencyKey;
  await store.recordUsage({ ...usage, idempotencyKey: receiptKey });
};

export const DELEGATE_BUDGET_SHARE = 0.25;

/**
 * What one delegated specialist may spend.
 *
 * The share is of the whole task and is now divided between the missions in flight. Each mission
 * used to check the full 25% independently, so three of them could jointly spend three quarters of
 * the task's compute before the lead had done anything with their reports.
 */
export const delegateBudget = (maxComputeCredits: number, missions = 1): number =>
  Math.max(0.05, (Math.max(0, maxComputeCredits) * DELEGATE_BUDGET_SHARE) / Math.max(1, missions));

export const reservationUsageKey = (taskId: string, turn = 0): string =>
  turn === 0 ? `task:${taskId}:reservation` : `task:${taskId}:turn:${turn}:reservation`;

export const stepUsageKey = (taskId: string, turn: number, step: number): string =>
  turn === 0 ? `task:${taskId}:step:${step}` : `task:${taskId}:turn:${turn}:step:${step}`;

/**
 * What a model call costs in compute credits, which is the unit the task's own ceiling is set in.
 *
 * It used to take a fourth argument, `seconds`, for a `computeSeconds` figure that was declared on
 * the response type and produced by nothing: no adapter has ever set it, so the term was zero on
 * every call this product has ever made, and the six `computeSeconds ? 'gpu_seconds' : 'tokens'`
 * ternaries beside its call sites each had one reachable arm. Removed rather than wired: a rented
 * GPU billed by the second is not a route garden offers, and a parameter that has never once been
 * non-zero is a claim about the product that is not true.
 */
export const usageCredit = (model: ModelRelease, input: number, output: number): number => {
  const multiplier = { light: 0.5, medium: 1, high: 2.5, extra_high: 5 }[model.usageClass];
  return Math.max(0.001, ((input + output * 2) / 1_000_000) * multiplier);
};

/**
 * Providers bill a cache read at roughly a tenth of the normal input rate and a cache write at
 * roughly 1.25x. This estimate is only used when the provider does not report a real cost, so it
 * stays deliberately approximate rather than tracking each route's exact multipliers.
 */
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;

export const estimatedInferenceCostUsd = (
  model: ModelRelease,
  inputTokens: number,
  outputTokens: number,
  cache: { cachedInputTokens?: number; cacheWriteTokens?: number } = {}
): number => {
  const fallback = {
    light: { input: 0.5, output: 1 },
    medium: { input: 1, output: 4 },
    high: { input: 2, output: 8 },
    extra_high: { input: 5, output: 15 }
  }[model.usageClass];
  /*
   * The rates at the tier this prompt actually reached, not the headline pair.
   *
   * A long-context route bills differently above its threshold - that is what `priceTiers` records,
   * and the selector already reads them: `pricesAtPromptSize` is what decides whether a model is
   * inside the owner's ceiling for work of this size. Billing read the flat pair beside them, so a
   * transcript that grew past the threshold was selected under one price and estimated under
   * another, and the estimate was always the cheaper of the two. Only an estimate is affected -
   * where the provider reports a real cost this function is not called at all.
   */
  // Through `readRoutingMetadata` because the stored row is a `ModelRelease`: the tiers live in the
  // routing metadata the store round-trips beside it, and reading them any other way is how the
  // rest of this list came to be lost.
  const tiered = pricesAtPromptSize({ ...model, ...readRoutingMetadata(model) }, inputTokens);
  const inputRate = tiered.input ?? fallback.input;
  const outputRate = tiered.output ?? fallback.output;
  const cached = Math.min(Math.max(cache.cachedInputTokens ?? 0, 0), inputTokens);
  const written = Math.min(Math.max(cache.cacheWriteTokens ?? 0, 0), inputTokens - cached);
  const uncached = Math.max(0, inputTokens - cached - written);
  return (
    (uncached * inputRate +
      cached * inputRate * CACHE_READ_RATE +
      written * inputRate * CACHE_WRITE_RATE +
      outputTokens * outputRate) /
    1_000_000
  );
};
