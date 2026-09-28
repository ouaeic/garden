import type {
  MediaModality,
  MediaModelChoice,
  MediaModelOption,
  ModelRelease,
  PrivacyRoute
} from '@garden/contracts';
import type { RoutableModel } from '@garden/core';
import { managedMediaModels } from './license-manifest.js';
import type { ConfiguredModelDescription } from './openai-compatible.js';

type Seed = Omit<ModelRelease, 'updatedAt'>;

/**
 * Commercially usable open-weight allowlist. Live OpenRouter metadata can
 * improve capabilities, prices, performance, and benchmark signals, but it
 * cannot add a model that has not passed our independent licence review.
 */
export const seedModels = (now = new Date()): ModelRelease[] => {
  const updatedAt = now.toISOString();
  const seeds: Seed[] = [
    {
      id: 'openrouter/deepseek/deepseek-v4-flash',
      providerModelId: 'deepseek/deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      provider: 'openrouter',
      revision: 'openrouter-live',
      availability: 'review',
      openness: 'permissive_open_weight',
      license: 'MIT',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 1_000_000,
      modalities: ['text'],
      capabilities: ['chat', 'tools', 'reasoning'],
      usageClass: 'light',
      recommendationTags: ['Fast default', 'Efficient', 'Included'],
      measuredQuality: null,
      measuredLatencyMs: null,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      benchmarkRank: null,
      benchmarkSource: null,
      benchmarkUpdatedAt: null
    },
    {
      id: 'openrouter/z-ai/glm-5.2',
      providerModelId: 'z-ai/glm-5.2',
      displayName: 'GLM-5.2',
      provider: 'openrouter',
      revision: 'openrouter-live',
      availability: 'review',
      openness: 'permissive_open_weight',
      license: 'MIT',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 1_000_000,
      modalities: ['text'],
      capabilities: ['chat', 'tools', 'reasoning'],
      usageClass: 'high',
      recommendationTags: ['Best for long agent work', 'Coding', 'Included'],
      measuredQuality: null,
      measuredLatencyMs: null,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      benchmarkRank: null,
      benchmarkSource: null,
      benchmarkUpdatedAt: null
    },
    {
      id: 'openrouter/qwen/qwen3.6-35b-a3b',
      providerModelId: 'qwen/qwen3.6-35b-a3b',
      displayName: 'Qwen 3.6 Vision',
      provider: 'openrouter',
      revision: 'openrouter-live',
      availability: 'review',
      openness: 'permissive_open_weight',
      license: 'Apache-2.0',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 262_144,
      // Images and text only, because that is the whole of what garden ever sends a model: the
      // only non-text part any request carries is an `image_url`. A seed that advertised video
      // would put a modality in the picker that nothing on this computer can put a model's way.
      modalities: ['text', 'image'],
      capabilities: ['chat', 'vision', 'tools', 'reasoning'],
      usageClass: 'medium',
      recommendationTags: ['Vision specialist', 'Screenshots and images', 'Included'],
      measuredQuality: null,
      measuredLatencyMs: null,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      benchmarkRank: null,
      benchmarkSource: null,
      benchmarkUpdatedAt: null
    },
    {
      id: 'openrouter/openai/gpt-oss-120b',
      providerModelId: 'openai/gpt-oss-120b',
      displayName: 'gpt-oss 120B',
      provider: 'openrouter',
      revision: 'openrouter-live',
      availability: 'review',
      openness: 'permissive_open_weight',
      license: 'Apache-2.0',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 131_072,
      modalities: ['text'],
      capabilities: ['chat', 'tools', 'reasoning'],
      usageClass: 'medium',
      recommendationTags: ['Reliable reasoning', 'Tools', 'Included'],
      measuredQuality: null,
      measuredLatencyMs: null,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      benchmarkRank: null,
      benchmarkSource: null,
      benchmarkUpdatedAt: null
    }
  ];
  return seeds.map((model) => ({ ...model, updatedAt }));
};

/**
 * Every model a directly configured account can reach, turned into a catalogue.
 *
 * This is what `'ollama-cloud'` was missing. The provider had been in the enum and in the settings
 * form since before this file, and the whole of its support was: the owner types one model id, the
 * save route checks that id appears in `/models`, and exactly one row is written with a context
 * window and a capability list the owner had to guess. A subscription that reaches thirty cloud
 * models produced a catalogue of one, and reaching a second one meant going back to Settings and
 * retyping. The refresh loop never touched it either - it is OpenRouter-shaped throughout - so the
 * one row also never changed again.
 *
 * The endpoint's own answer is the source. `describe` reads context windows, output limits, prices
 * and supported parameters where they are published and reports what was not, which is the whole
 * difference between this and the invented metadata it replaces: a field nobody stated stays at the
 * owner's declared fallback and the entry says its metadata was never measured, so it is selectable
 * by name and never by automatic ranking.
 */
export const configuredModelCatalog = (
  described: readonly ConfiguredModelDescription[],
  options: {
    privacyRoute: PrivacyRoute;
    /** What the owner said when the endpoint would not say. */
    contextTokens: number;
    capabilities: ModelRelease['capabilities'];
    modalities: ModelRelease['modalities'];
    /** The badge on every row, naming where these came from. */
    tag: string;
    connectionId?: string;
    previous?: ReadonlyArray<Record<string, unknown>>;
    now?: Date;
  }
): RoutableModel[] => {
  const updatedAt = (options.now ?? new Date()).toISOString();
  return described
    .filter((model) => model.id.trim().length > 0)
    .map((model) => ({
      id: String(
        (options.previous?.find(
          (row) => row.providerModelId === model.id && typeof row.id === 'string'
        )?.id as string | undefined) ??
          (options.connectionId
            ? `custom/${options.connectionId}/${encodeURIComponent(model.id)}`
            : `custom/${model.id}`)
      ),
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      providerModelId: model.id,
      displayName: model.displayName,
      provider: 'custom',
      revision: 'provider-managed',
      availability: 'available' as const,
      openness: 'remote_proprietary' as const,
      license: 'Provider-defined',
      commercialUse: true,
      privacyRoute: options.privacyRoute,
      contextTokens: model.contextTokens ?? options.contextTokens,
      modalities: model.inputModalities ?? options.modalities,
      ...(model.nativeInputPricing ? { nativeInputPricing: model.nativeInputPricing } : {}),
      // Only ever narrowed on an explicit denial. `supportsTools` is null when the endpoint listed
      // no parameters at all, and reading silence as "cannot call tools" would take every model on
      // a quiet endpoint out of agent work, which is all of them on most.
      capabilities: [
        ...(model.supportsTools === false
          ? options.capabilities.filter((capability) => capability !== 'tools')
          : options.capabilities),
        // Vision arrives with the modalities: a model whose input modalities accept an image is
        // vision-capable by the same evidence, and the capability row is what every gate reads
        // (usableCapabilities, the picker, the vision specialist ranking).
        ...(model.inputModalities?.includes('image') && !options.capabilities.includes('vision')
          ? (['vision'] as const)
          : [])
      ],
      usageClass: usageClassForPrice(model.inputUsdPerMillionTokens),
      recommendationTags: [
        options.tag,
        ...(model.metadataSource === 'unknown' ? [] : ['Declared'])
      ],
      measuredQuality: null,
      measuredLatencyMs: null,
      inputUsdPerMillionTokens: model.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: model.outputUsdPerMillionTokens,
      maxOutputTokens: model.maxOutputTokens,
      ...(model.supportsReasoningEffort === null
        ? {}
        : { supportsReasoningEffort: model.supportsReasoningEffort }),
      ...(model.reasoning ? { reasoning: model.reasoning } : {}),
      metadataSource: model.metadataSource,
      updatedAt
    }));
};

/** Price per million input tokens decides how a run is weighed against the owner's usage windows. */
const usageClassForPrice = (inputUsdPerMillion: number | null): ModelRelease['usageClass'] => {
  if (inputUsdPerMillion === null || !Number.isFinite(inputUsdPerMillion)) return 'medium';
  if (inputUsdPerMillion <= 1) return 'light';
  if (inputUsdPerMillion <= 3) return 'medium';
  if (inputUsdPerMillion <= 10) return 'high';
  return 'extra_high';
};

/**
 * The two media routes garden has actually run, offered as catalogue entries like any other.
 *
 * These are the models that were hard-coded until now - the same ids, the same prices - but they
 * are no longer the answer, only the entry that is always present. Their prices are marked
 * `measured` rather than `provider`: they are figures this software recorded from real generations
 * on these routes, not something read back off a feed, and an owner comparing them with a live
 * catalogue entry deserves to know which kind of number they are looking at.
 */
export const seedMediaModels = (now = new Date()): MediaModelOption[] => {
  const updatedAt = now.toISOString();
  return [
    {
      id: `openrouter/${managedMediaModels.image.modelId}`,
      providerModelId: managedMediaModels.image.modelId,
      displayName: managedMediaModels.image.displayName,
      provider: 'openrouter',
      modality: 'image' as const,
      usdPerImage: managedMediaModels.image.baseUsdPerImage,
      usdPerMillionCharacters: null,
      usdPerMinute: null,
      priceSource: 'measured' as const,
      defaultVoice: null,
      recommendationTags: ['Reviewed', managedMediaModels.image.license],
      updatedAt
    },
    {
      id: `openrouter/${managedMediaModels.audio.modelId}`,
      providerModelId: managedMediaModels.audio.modelId,
      displayName: managedMediaModels.audio.displayName,
      provider: 'openrouter',
      modality: 'audio' as const,
      usdPerImage: null,
      usdPerMillionCharacters: managedMediaModels.audio.usdPerMillionCharacters,
      usdPerMinute: null,
      priceSource: 'measured' as const,
      defaultVoice: managedMediaModels.audio.defaultVoice,
      recommendationTags: ['Reviewed', managedMediaModels.audio.license],
      updatedAt
    }
  ];
};

/** The unit a modality is billed in, so one comparison can order a mixed catalogue. */
const comparablePrice = (option: MediaModelOption): number | null =>
  option.modality === 'audio'
    ? option.usdPerMillionCharacters
    : option.modality === 'transcription'
      ? option.usdPerMinute
      : option.modality === 'video'
        ? (option.usdPerSecond ?? null)
        : option.usdPerImage;

/**
 * The order the three automatic modes read the catalogue in, and the whole of the evidence behind
 * them.
 *
 * The chat picker's modes stand on measured benchmarks. Nothing measures a media model: the
 * provider feed that carries an intelligence index for chat routes carries no quality column for
 * image or speech generation at all, and inventing one would be the same mistake that once let an
 * unmeasured local route outrank every benchmarked model in the catalogue. So price is the only
 * ordering there is, it is used as an ordering and not dressed up as a quality score, and the
 * Settings copy says exactly that beside the control.
 *
 * A model whose price nobody published always sorts last, in every mode. An unknown price is not a
 * cheap one, and it is not a premium one either - it is a number the owner will first see on an
 * invoice, so it is never what an automatic mode reaches for on their behalf.
 */
export const rankMediaModels = (
  options: readonly MediaModelOption[],
  preference: MediaModelChoice['preference']
): MediaModelOption[] => {
  const selectable = options.filter((option) => !option.unavailableReason);
  const priced = selectable.filter((option) => comparablePrice(option) !== null);
  const unpriced = selectable.filter((option) => comparablePrice(option) === null);
  const byPrice = [...priced].sort(
    (left, right) =>
      (comparablePrice(left) ?? 0) - (comparablePrice(right) ?? 0) ||
      left.id.localeCompare(right.id)
  );
  const ordered =
    preference === 'fast'
      ? byPrice
      : preference === 'best'
        ? [...byPrice].reverse()
        : // Recommended leads with the route garden has itself run and priced, because that is the
          // one entry whose cost figure came from generations rather than from a feed. Everything
          // else follows cheapest-first, which is the safest thing to fall to when it is absent.
          [
            ...byPrice.filter((option) => option.priceSource === 'measured'),
            ...byPrice.filter((option) => option.priceSource !== 'measured')
          ];
  return [...ordered, ...unpriced.sort((left, right) => left.id.localeCompare(right.id))];
};

/**
 * Which model a modality will actually use, from the owner's choice and what their provider offers.
 *
 * An explicit selection never grants permission to choose another model. Unavailable pinned
 * options retain their explanation; a missing id returns null until the owner chooses again.
 */
export const resolveMediaModel = (
  options: readonly MediaModelOption[],
  choice: MediaModelChoice | undefined,
  modality: MediaModality
): MediaModelOption | null => {
  const forModality = options.filter((option) => option.modality === modality);
  if (!choice?.automatic && choice?.modelId) {
    const pinned = forModality.find(
      (option) => option.id === choice.modelId || option.providerModelId === choice.modelId
    );
    return pinned ?? null;
  }
  return rankMediaModels(forModality, choice?.preference ?? 'balanced')[0] ?? null;
};
