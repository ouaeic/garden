import type {
  ModelRelease,
  ModelPurpose,
  PurposeModelChoice,
  PrivacyRoute
} from '@garden/contracts';
import {
  priceCeilingFields,
  selectModel,
  type OwnerPriceCeiling,
  type ModelTaskKind
} from './model-policy.js';

/**
 * What each job actually needs of a model, which is not the same for all of them.
 *
 * A conversation needs tools; a summariser does not - it is handed text and asked for prose, and
 * demanding `tools` of it would exclude exactly the cheap chat routes the job wants. The context
 * floors differ for the same reason: compaction reads the window the lead model is about to
 * overflow, so it needs a large one, while a title is a sentence about a sentence.
 */
const PURPOSE_REQUIREMENTS: Record<
  Extract<ModelPurpose, 'main' | 'specialist' | 'coding' | 'summarise' | 'title' | 'decisions'>,
  { capabilities: ModelRelease['capabilities']; minContextTokens: number }
> = {
  main: { capabilities: ['chat', 'tools'], minContextTokens: 16_000 },
  specialist: { capabilities: ['chat', 'tools', 'reasoning'], minContextTokens: 16_000 },
  coding: { capabilities: ['chat', 'tools'], minContextTokens: 16_000 },
  // 32k is `COMPACTION_MIN_CONTEXT_TOKENS`: below it the condensed transcript would not fit
  // alongside the brief it has to extend.
  summarise: { capabilities: ['chat'], minContextTokens: 32_000 },
  title: { capabilities: ['chat'], minContextTokens: 8_000 },
  decisions: { capabilities: ['decisions'], minContextTokens: 8_000 }
};

/** One selection contract for settings previews and the requests that use them. */
export function selectPurposeModel(input: {
  purpose: Extract<
    ModelPurpose,
    'main' | 'specialist' | 'coding' | 'summarise' | 'title' | 'decisions'
  >;
  choice: PurposeModelChoice;
  catalog: readonly ModelRelease[];
  privacyRoute: PrivacyRoute;
  provider?: string;
  ceiling?: OwnerPriceCeiling;
  taskKind?: ModelTaskKind;
}): { model: ModelRelease | null; reason: string | null } {
  const catalog = input.catalog.filter(
    (model) => !input.provider || model.provider === input.provider
  );
  const requirements = PURPOSE_REQUIREMENTS[input.purpose];
  const result = selectModel(catalog, {
    privacyRoute: input.privacyRoute,
    requiredCapabilities: requirements.capabilities,
    requiredModalities: ['text'],
    minContextTokens: requirements.minContextTokens,
    preference: input.purpose === 'decisions' ? 'fast' : input.choice.preference,
    taskKind:
      input.purpose === 'coding'
        ? 'coding'
        : // Both auxiliary jobs are faithful condensation of text already in hand, which is the
          // kind the router prices cheapest - and is what makes an automatic pick land there.
          input.purpose === 'summarise' || input.purpose === 'title'
          ? 'bulk_summarisation'
          : (input.taskKind ?? 'general'),
    ...priceCeilingFields(input.ceiling),
    ...(!input.choice.automatic ? { requestedId: input.choice.modelId } : {})
  });
  const model =
    result.ceilingOutcome === 'requested_over_ceiling'
      ? null
      : (catalog.find((item) => item.id === result.choice?.model.id) ?? null);
  return {
    model,
    reason: model
      ? null
      : (result.message ?? 'The selected model is unavailable for this purpose and privacy route.')
  };
}
