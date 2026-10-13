import type { PrivacyRoute, PurposeModelChoice } from '@garden/contracts';
import {
  isModelEligible,
  selectPurposeModel,
  type RoutableModel,
  type ModelRequest
} from '@garden/core';

export const TITLE_MAX_COST_USD = 0.005;
/** What a title is expected to cost to write, for choosing a route; the request names no length. */
export const TITLE_OUTPUT_TOKENS = 256;

export interface TitleRoute {
  model: RoutableModel;
  maxCostUsd: number;
  maxPrice: { prompt: number; completion: number; request: 0 };
  reasoningEffort?: 'none';
}

/** Reserve for the bounded text request with a UTF-8 byte estimate and framing headroom. */
export const selectTitleRoute = (
  models: readonly RoutableModel[],
  input: {
    provider?: string;
    choice?: PurposeModelChoice;
    inputText: string;
    privacyRoute: PrivacyRoute;
    ceiling: Pick<ModelRequest, 'maxInputUsdPerMillionTokens' | 'maxOutputUsdPerMillionTokens'>;
  }
): TitleRoute | null => {
  const candidates: TitleRoute[] = [];
  // These requests have two text messages and no tools, images or conversation history.
  const inputTokens = Buffer.byteLength(input.inputText, 'utf8') + 1_024;
  for (const model of models) {
    if (
      (input.provider && model.provider !== input.provider) ||
      model.privacyRoute !== input.privacyRoute
    )
      continue;
    if (input.choice && !input.choice.automatic && model.id !== input.choice.modelId) continue;
    if (model.expiresAt && Date.parse(model.expiresAt) <= Date.now()) continue;
    const reasoning = model.reasoning;
    if (reasoning?.mandatory) continue;
    const disableReasoning = reasoning?.supportedEfforts?.includes('none') === true;
    const nonReasoning =
      reasoning?.defaultEnabled === false ||
      (model.supportsReasoningEffort === false && !model.capabilities.includes('reasoning'));
    if (!disableReasoning && !nonReasoning) continue;
    if (
      !isModelEligible(model, {
        privacyRoute: input.privacyRoute,
        requiredCapabilities: ['chat'],
        requiredModalities: ['text'],
        minContextTokens: Math.max(4_096, inputTokens + TITLE_OUTPUT_TOKENS),
        preference: 'fast',
        ...input.ceiling
      })
    )
      continue;
    const rates = [
      { input: model.inputUsdPerMillionTokens, output: model.outputUsdPerMillionTokens },
      ...(model.priceTiers ?? []).map((tier) => ({
        input: tier.inputUsdPerMillionTokens,
        output: tier.outputUsdPerMillionTokens
      }))
    ];
    if (
      rates.some(
        (rate) =>
          typeof rate.input !== 'number' ||
          !Number.isFinite(rate.input) ||
          rate.input < 0 ||
          typeof rate.output !== 'number' ||
          !Number.isFinite(rate.output) ||
          rate.output < 0
      )
    )
      continue;
    const prompt = Math.max(...rates.map((rate) => rate.input!));
    const completion = Math.max(...rates.map((rate) => rate.output!));
    if (
      (input.ceiling.maxInputUsdPerMillionTokens !== undefined &&
        prompt > input.ceiling.maxInputUsdPerMillionTokens) ||
      (input.ceiling.maxOutputUsdPerMillionTokens !== undefined &&
        completion > input.ceiling.maxOutputUsdPerMillionTokens)
    )
      continue;
    if (model.maxOutputTokens != null && model.maxOutputTokens < TITLE_OUTPUT_TOKENS) continue;
    const maxCostUsd = (inputTokens * prompt + TITLE_OUTPUT_TOKENS * completion) / 1_000_000;
    if (!Number.isFinite(maxCostUsd) || maxCostUsd > TITLE_MAX_COST_USD) continue;
    candidates.push({
      model,
      maxCostUsd,
      maxPrice: { prompt, completion, request: 0 },
      ...(disableReasoning ? { reasoningEffort: 'none' as const } : {})
    });
  }
  if (input.choice) {
    const selected = selectPurposeModel({
      purpose: 'title',
      choice: input.choice,
      catalog: candidates.map((candidate) => candidate.model),
      privacyRoute: input.privacyRoute,
      ceiling: input.ceiling
    });
    return candidates.find((candidate) => candidate.model.id === selected.model?.id) ?? null;
  }
  return (
    candidates.sort(
      (a, b) => a.maxCostUsd - b.maxCostUsd || a.model.id.localeCompare(b.model.id)
    )[0] ?? null
  );
};
