import { AUDIO_READ_MAX_SECONDS, type MediaModelOption } from '@garden/contracts';
import {
  managedMediaModels,
  nativeTranscriptionBound,
  quoteMediaPrice,
  resolveImageDimensions,
  type TranscriptionBound
} from '@garden/model-gateway';

/**
 * What generated media costs, decided here rather than by the model.
 *
 * The estimate is not a `generate_media` parameter. Taken from the model, both the approval card
 * and the tool result would quote whatever it wrote, unchecked, so a call carrying
 * `estimatedCostUsd: 0` - or omitting it, which arrives as NaN - would spend the owner's provider
 * money with no card in front of it. The prices are the provider's own and the request already
 * carries everything they depend on, so the number is derived on this side of the boundary in both
 * places and the model's opinion is not consulted.
 */
export const managedMediaCatalog = {
  image: {
    ...managedMediaModels.image,
    /** Flat per image up to a megapixel, then a small area surcharge, as the provider bills it. */
    estimate: (input: { width: number; height: number }) =>
      (managedMediaModels.image.baseUsdPerImage * (input.width * input.height)) / 1_000_000
  },
  audio: {
    ...managedMediaModels.audio,
    estimate: (input: { characterCount: number }) =>
      (input.characterCount * managedMediaModels.audio.usdPerMillionCharacters) / 1_000_000
  }
} as const;

/** Current verified routes, resolved with the same policy used by the model settings API. */
export interface StoredMediaRoutes {
  image?: MediaModelOption;
  audio?: MediaModelOption;
  transcription?: MediaModelOption;
  video?: MediaModelOption;
}

/** The exact route and typed price used by approval and generation. */
export interface ResolvedMediaModel {
  route?: MediaModelOption;
  transcriptionBound?: TranscriptionBound;
  modelId: string;
  displayName: string;
  usdPerImage: number | null;
  usdPerMillionCharacters: number | null;
  usdPerMinute: number | null;
  voice: string | undefined;
  /**
   * Whether the price above came from anywhere at all. False means the provider published no cost
   * for this route and garden has never measured it, which is the state the approval floor below
   * treats as "always ask" - see `mediaEstimateUsd`'s callers.
   */
  priceKnown: boolean;
}

export const resolvedMediaModel = (
  kind: 'image' | 'audio' | 'video',
  routes?: StoredMediaRoutes
): ResolvedMediaModel => {
  const option = routes?.[kind];
  if (kind === 'video')
    return {
      ...(option ? { route: option } : {}),
      modelId: option?.providerModelId ?? '',
      displayName: option?.displayName ?? 'Video',
      usdPerImage: null,
      usdPerMillionCharacters: null,
      usdPerMinute: null,
      voice: undefined,
      priceKnown: Boolean(option?.pricing?.length)
    };
  if (!option || option.modality !== kind || !option.providerModelId)
    return {
      modelId: '',
      displayName: kind === 'image' ? 'Image' : 'Speech',
      usdPerImage: null,
      usdPerMillionCharacters: null,
      usdPerMinute: null,
      voice: undefined,
      priceKnown: false
    };
  return {
    route: option,
    modelId: option.providerModelId,
    displayName: option.displayName,
    usdPerImage: option.usdPerImage,
    usdPerMillionCharacters: option.usdPerMillionCharacters,
    usdPerMinute: option.usdPerMinute,
    voice: option.defaultVoice ?? undefined,
    priceKnown:
      option.priceSource !== 'unknown' &&
      (kind === 'image'
        ? option.usdPerImage !== null || Boolean(option.pricing?.length)
        : option.usdPerMillionCharacters !== null)
  };
};

/** Resolve only the selected recording route and its complete price evidence. */
export const resolvedTranscriptionRoute = (
  routes?: StoredMediaRoutes,
  nativeConnection = false
): ResolvedMediaModel | null => {
  const option = routes?.transcription;
  if (!option || option.modality !== 'transcription' || !option.providerModelId) return null;
  const rate =
    option.priceSource === 'unknown'
      ? null
      : option.pricing?.length
        ? quoteMediaPrice(option.pricing, { seconds: 60 })
        : finiteRate(option.usdPerMinute);
  const bound = nativeConnection ? nativeTranscriptionBound(option) : null;
  return {
    route: option,
    ...(bound ? { transcriptionBound: bound } : {}),
    modelId: option.providerModelId,
    displayName: option.displayName,
    usdPerImage: null,
    usdPerMillionCharacters: null,
    usdPerMinute: rate,
    voice: undefined,
    priceKnown: rate !== null
  };
};

const finiteRate = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export interface TranscriptionRate {
  usdPerMinute: number | null;
  source: 'published' | 'unknown';
}

/** A previous invoice is an observation, not a bound on another recording's token usage. */
export const transcriptionRate = (model: ResolvedMediaModel | null): TranscriptionRate => {
  const published = model?.priceKnown ? finiteRate(model.usdPerMinute) : null;
  return published === null
    ? { usdPerMinute: null, source: 'unknown' }
    : { usdPerMinute: published, source: 'published' };
};

/** Record invoice arithmetic for reporting only; admission never reads this measurement. */
export const transcriptionRateFromReading = (
  reading: { costUsd: number; billedSeconds: number | null; costFromProvider: boolean },
  preparedSeconds: number
): number | null => {
  if (!reading.costFromProvider) return null;
  const cost = finiteRate(reading.costUsd);
  const seconds = finiteRate(reading.billedSeconds) ?? finiteRate(preparedSeconds);
  if (cost === null || seconds === null || seconds <= 0) return null;
  return Math.round(((cost * 60) / seconds) * 1e6) / 1e6;
};

/** Round duration up to a billing minute before checking the owner's limit. */
export const transcriptionEstimateAtRate = (
  seconds: number,
  rate: TranscriptionRate
): number | null =>
  rate.usdPerMinute === null ? null : Math.ceil(Math.max(0, seconds) / 60) * rate.usdPerMinute;

export const transcriptionEstimateUsd = (
  seconds: number,
  model: ResolvedMediaModel | null
): number | null =>
  transcriptionEstimateAtRate(seconds, transcriptionRate(model)) ??
  model?.transcriptionBound?.reservationUsd ??
  null;

/** Clip once before preparation; native bounds must never activate provider auto-chunking. */
export const transcriptionWindow = (input: {
  startSeconds: number;
  endSeconds?: number | undefined;
  maxSeconds: number;
}): { endSeconds: number; limited: boolean } => {
  const start = Math.max(0, Math.floor(input.startSeconds));
  const asked = Number(input.endSeconds);
  const requested =
    Number.isFinite(asked) && asked > start
      ? Math.min(86_400, Math.floor(asked))
      : Math.min(86_400, start + AUDIO_READ_MAX_SECONDS);
  const endSeconds = Math.min(requested, start + input.maxSeconds, start + AUDIO_READ_MAX_SECONDS);
  return { endSeconds, limited: endSeconds < requested };
};

const clamp = (value: unknown, minimum: number, maximum: number, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

/** The bounds `generate_media` declares, applied before anything is priced. */
export const mediaDimension = (value: unknown): number => clamp(value, 256, 4_096, 1_024);
export const mediaImageDimensions = (input: MediaEstimateInput) =>
  resolveImageDimensions({
    model: input.model?.modelId ?? '',
    capabilities: input.model?.route?.capabilities,
    width: input.width === undefined ? undefined : mediaDimension(input.width),
    height: input.height === undefined ? undefined : mediaDimension(input.height),
    resolution: typeof input.resolution === 'string' ? input.resolution : undefined
  });
const mediaCharacterCount = (value: unknown): number => clamp(value, 1, 20_000, 1_000);

/**
 * The provider cost of one generation, from the request alone.
 *
 * Speech is billed per character, and the characters are the prompt: `generate_media` has no
 * separate length parameter, so the same text that is spoken is the text that is priced. An
 * unknown kind estimates zero rather than throwing, because the caller that rejects it is the
 * dispatch arm, not the pricer.
 */
export interface MediaEstimateInput {
  kind: string;
  width?: unknown;
  height?: unknown;
  characterCount?: unknown;
  count?: unknown;
  quality?: unknown;
  resolution?: unknown;
  size?: unknown;
  duration?: unknown;
  inputReferenceCount?: number;
  /**
   * The route this generation will take, when the caller has resolved the owner's choice. Omitting
   * it prices against the reviewed default, which is what every caller did when the default was the
   * only model there was.
   */
  model?: ResolvedMediaModel;
}
export const mediaQuoteUsd = (input: MediaEstimateInput): number | null => {
  const { width, height } =
    input.kind === 'image'
      ? mediaImageDimensions(input)
      : { width: mediaDimension(input.width), height: mediaDimension(input.height) };
  if (input.model?.route?.pricing?.length)
    return quoteMediaPrice(input.model.route.pricing, {
      width,
      height,
      count: Math.max(1, Math.min(10, Number(input.count) || 1)),
      characters: mediaCharacterCount(input.characterCount),
      ...(input.kind === 'video' && Number.isFinite(Number(input.duration))
        ? { seconds: Number(input.duration) }
        : {}),
      ...(typeof (input.kind === 'video' ? (input.size ?? input.resolution) : input.quality) ===
      'string'
        ? {
            variant: String(
              input.kind === 'video' ? (input.size ?? input.resolution) : input.quality
            )
          }
        : {}),
      ...(input.inputReferenceCount === undefined
        ? {}
        : { inputImageCount: input.inputReferenceCount })
    });
  if (!input.model?.priceKnown) return null;
  if (input.kind === 'image') {
    const base = input.model.usdPerImage;
    if (base === null) return null;
    return (
      (input.model?.route ? base : (base * (width * height)) / 1_000_000) *
      Math.max(1, Math.min(10, Number(input.count) || 1))
    );
  }
  if (input.kind === 'audio') {
    const characters = mediaCharacterCount(input.characterCount);
    const perMillion = input.model.usdPerMillionCharacters;
    if (perMillion === null) return null;
    return (characters * perMillion) / 1_000_000;
  }
  return null;
};
export const mediaEstimateUsd = (input: MediaEstimateInput): number => mediaQuoteUsd(input) ?? 0;

/**
 * The cumulative media-spend threshold, which now lives in the contracts package because the
 * Settings screen that chooses the model has to state the same number this card enforces.
 */
export { MEDIA_APPROVAL_USD } from '@garden/contracts';
