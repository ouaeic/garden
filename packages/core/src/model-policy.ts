import type { ModelRelease, PrivacyRoute } from '@garden/contracts';
import { ReasoningOptions } from '@garden/contracts';

export type ModelCapability = ModelRelease['capabilities'][number];
export type ModelModality = ModelRelease['modalities'][number];
export type ModelUsageClass = ModelRelease['usageClass'];
export type ModelPreference = 'fast' | 'balanced' | 'best';

/**
 * Where a model's numbers came from.
 *
 * - `measured` - an independent benchmark ran the model and published a score.
 * - `declared` - the endpoint or the owner told us, at configure time, what this route is.
 * - `unknown` - nobody has said anything. Garden invents nothing for these: they are reachable by
 *   name and never by automatic ranking, because a route we know nothing about must not be scored
 *   as if we did.
 */
export type ModelMetadataProvenance = 'measured' | 'declared' | 'unknown';

/**
 * A long-context price tier, as providers publish them: above `minPromptTokens` the route bills at
 * these rates instead. A task that passes a spend ceiling on its first turn would otherwise breach
 * it silently once the transcript grows, which is exactly the long agent run the ceiling protects.
 */
export interface ModelPriceTier {
  readonly minPromptTokens: number;
  readonly inputUsdPerMillionTokens: number | null;
  readonly outputUsdPerMillionTokens: number | null;
}

/**
 * How many models carried each benchmark column. The columns do not cover the same models - a live
 * catalogue read on 2026-08-03 measured 117 on coding, 108 on agentic and 107 on intelligence - so a
 * percentile has to name the population it was computed against rather than borrow another's.
 */
export interface BenchmarkPopulations {
  readonly coding: number | null;
  readonly agentic: number | null;
  readonly intelligence: number | null;
}

/**
 * Catalogue facts the router uses that the stored `ModelRelease` shape does not carry yet. Every
 * field is optional, so a plain `ModelRelease` is a valid `RoutableModel` and a catalogue that has
 * not been refreshed since these were added simply ranks without them.
 *
 * These are the fields an unattended server needs and the stored shape drops. `readRoutingMetadata`
 * below is the one place that decides what they are, so the store and the API round-trip them in a
 * single call instead of each keeping a hand-written list that silently falls behind this type.
 */
export type RoutingMetadata = {
  /** Defaults to `measured` when absent, which is what every catalogue entry has always been. */
  readonly metadataSource?: ModelMetadataProvenance;
  /** Raw benchmark indices, kept for display. Ranking uses the percentile fields on ModelRelease. */
  readonly agenticIndex?: number | null;
  readonly codingIndex?: number | null;
  readonly intelligenceIndex?: number | null;
  /** How many models carried any benchmark at all, which is the population behind the overall score. */
  readonly benchmarkPopulation?: number | null;
  /** How many carried each column, for the percentile that was actually computed on that column. */
  readonly benchmarkPopulations?: BenchmarkPopulations | null;
  readonly cacheReadUsdPerMillionTokens?: number | null;
  readonly cacheWriteUsdPerMillionTokens?: number | null;
  /**
   * How this route caches a repeated prompt prefix, read from what it charges for cache writes and
   * reads rather than guessed from its vendor prefix. `explicit` routes cache nothing unless the
   * request marks where the stable prefix ends.
   */
  readonly promptCacheStyle?: 'explicit' | 'automatic' | 'none';
  /**
   * Whether the route accepts a `reasoning_effort` parameter. Sending one where it is not supported
   * narrows or fails routing when the request also demands the provider honour every parameter,
   * which is exactly what the zero-retention posture demands.
   */
  readonly supportsReasoningEffort?: boolean;
  readonly reasoning?: NonNullable<ModelRelease['reasoning']> | undefined;
  readonly priceTiers?: readonly ModelPriceTier[];
  /** Worst one-day uptime across the endpoints that serve this model, as a percentage. */
  readonly uptimeLast1dPercent?: number | null;
  /** The date the provider withdraws this route, ISO `YYYY-MM-DD` or a full timestamp. */
  readonly expiresAt?: string | null;
  /** Most tokens the route will write in one response. */
  readonly maxOutputTokens?: number | null;
  readonly knowledgeCutoff?: string | null;
};

/** A catalogue entry plus whatever live metadata the refresh managed to carry with it. */
export type RoutableModel = ModelRelease & RoutingMetadata;

const finiteNumberOrNull = (value: unknown): number | null | undefined =>
  value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const nonEmptyStringOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' && value.length > 0 ? value : undefined;

const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (value: unknown): T | undefined =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : undefined;

const readPriceTiers = (value: unknown): readonly ModelPriceTier[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const tiers: ModelPriceTier[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const minPromptTokens = finiteNumberOrNull(record.minPromptTokens);
    // A tier without the threshold it applies above cannot be evaluated, so it is not a tier.
    if (typeof minPromptTokens !== 'number') continue;
    tiers.push({
      minPromptTokens,
      inputUsdPerMillionTokens: finiteNumberOrNull(record.inputUsdPerMillionTokens) ?? null,
      outputUsdPerMillionTokens: finiteNumberOrNull(record.outputUsdPerMillionTokens) ?? null
    });
  }
  return tiers;
};

const readPopulations = (value: unknown): BenchmarkPopulations | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    coding: finiteNumberOrNull(record.coding) ?? null,
    agentic: finiteNumberOrNull(record.agentic) ?? null,
    intelligence: finiteNumberOrNull(record.intelligence) ?? null
  };
};

/**
 * One reader per routing field.
 *
 * The mapped type is the point: adding a field to `RoutingMetadata` without adding a reader here is
 * a compile error, so the round trip cannot quietly start dropping it. That is exactly how the
 * retirement dates, output limits, cache styles and provenance flags were lost - each of the three
 * places that copied a model kept its own list of fields, and none of them was this type.
 */
const routingMetadataReaders: {
  readonly [K in keyof Required<RoutingMetadata>]: (
    value: unknown
  ) => Required<RoutingMetadata>[K] | undefined;
} = {
  reasoning: (value) => {
    const parsed = ReasoningOptions.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  },
  metadataSource: oneOf(['measured', 'declared', 'unknown']),
  agenticIndex: finiteNumberOrNull,
  codingIndex: finiteNumberOrNull,
  intelligenceIndex: finiteNumberOrNull,
  benchmarkPopulation: finiteNumberOrNull,
  benchmarkPopulations: readPopulations,
  cacheReadUsdPerMillionTokens: finiteNumberOrNull,
  cacheWriteUsdPerMillionTokens: finiteNumberOrNull,
  promptCacheStyle: oneOf(['explicit', 'automatic', 'none']),
  supportsReasoningEffort: (value) => (typeof value === 'boolean' ? value : undefined),
  priceTiers: readPriceTiers,
  uptimeLast1dPercent: finiteNumberOrNull,
  expiresAt: nonEmptyStringOrNull,
  maxOutputTokens: finiteNumberOrNull,
  knowledgeCutoff: nonEmptyStringOrNull
};

const routingMetadataKeys = Object.keys(routingMetadataReaders) as Array<
  keyof Required<RoutingMetadata>
>;

/**
 * Reads the routing metadata off anything shaped like a model or like the JSON blob one was stored
 * in. It is both halves of the round trip - what to persist, and what to trust on the way back - so
 * a value that survives the journey is the value that was written, and a field that arrives
 * malformed is dropped on its own rather than taking the rest of the entry with it.
 *
 * An absent field stays absent. `undefined` and `null` mean different things here: "the refresh
 * never reported this" is not "the provider publishes nothing", and the router reads them apart.
 */
export const readRoutingMetadata = (source: unknown): RoutingMetadata => {
  if (typeof source !== 'object' || source === null) return {};
  const record = source as Record<string, unknown>;
  const readers = routingMetadataReaders as Record<string, (value: unknown) => unknown>;
  const result: Record<string, unknown> = {};
  for (const key of routingMetadataKeys) {
    if (!(key in record)) continue;
    const value = readers[key]?.(record[key]);
    if (value !== undefined) result[key] = value;
  }
  return result as RoutingMetadata;
};

export interface ModelRequest {
  requestedId?: string;
  privacyRoute: PrivacyRoute;
  requiredCapabilities: ModelCapability[];
  requiredModalities: ModelModality[];
  minContextTokens: number;
  maxUsageClass?: ModelUsageClass;
  preference: ModelPreference;
  taskKind?: ModelTaskKind;
  /**
   * The owner's ceiling, as two rates, because "$2 per million in and $10 per million out" has no
   * single-number equivalent. Both are inclusive: a model priced at exactly the ceiling is admitted.
   *
   * When either is set, a model that publishes no price is *ineligible* rather than assumed cheap -
   * a ceiling a route can pass by declining to publish a price is not a ceiling. The rates are
   * evaluated at the tier `minContextTokens` actually reaches, so a model that only fits under the
   * ceiling at short context is admitted for short work and excluded for long.
   */
  maxInputUsdPerMillionTokens?: number;
  maxOutputUsdPerMillionTokens?: number;
  /**
   * Older single blended ceiling. It cannot express two rates and it treats an unpublished price as
   * under the ceiling, so it is superseded by the pair above; it stays for callers that already pass
   * it and is ignored when either of the two rates is set.
   */
  maxUsdPerMillionTokens?: number;
  /** Clock for retirement checks. Defaults to now; tests and replays pass their own. */
  asOf?: string;
}

/**
 * The shapes of work the router distinguishes. The first three are the historical coarse kinds and
 * stay in the union so callers that only know them keep type-checking.
 */
export type ModelTaskKind =
  | 'general'
  | 'coding'
  | 'agentic'
  | 'conversation'
  | 'reasoning'
  | 'vision'
  | 'long_context'
  | 'bulk_summarisation';

const usageRank: Record<ModelUsageClass, number> = {
  light: 1,
  medium: 2,
  high: 3,
  extra_high: 4
};

/**
 * What an unmeasured model scores on quality.
 *
 * The benchmark sub-scores are percentiles within the live catalogue, so 0.4 is literally "the
 * fortieth percentile of the models somebody has actually measured". An unmeasured model is
 * therefore reachable - it beats the weakest measured models, as it should, since most of them are
 * genuinely poor - and can never be preferred over a strong one. The previous priors ran to 0.80,
 * which under a raw index that tops out near 60 meant being benchmarked was a penalty.
 */
export const UNMEASURED_QUALITY_PRIOR = 0.4;

const usageClassPricePrior: Record<ModelUsageClass, number> = {
  light: 1,
  medium: 0.75,
  high: 0.5,
  extra_high: 0.25
};

/** A latency at or beyond this reads as "slow"; the sub-score floors at zero there. */
const LATENCY_CEILING_MS = 30_000;

/**
 * How much of a ranking pool has to carry a measured latency before the term is allowed to decide
 * anything.
 *
 * The ceiling above is thirty seconds, so every plausible route - 200 ms to 2 s - scores between
 * 0.93 and 0.99. The sub-score barely separates two timed models; what it separates sharply is
 * timed from untimed. That makes "does this row happen to carry a number" a stronger signal than
 * anything the number says, and on the `fast` dial for a conversation the term carries 0.64 of the
 * weight. `openrouter-catalog.ts` fills `measuredLatencyMs` only for the routes the
 * `/endpoints/zdr` feed happens to cover, while the ranking pool on a box that never asked for
 * zero retention is the whole catalogue - so a thin scatter of timed rows across an untimed
 * catalogue is the ordinary shape, not an edge case.
 *
 * Below this coverage the term is dropped for the whole pool and every candidate is scored on
 * identical weights, which is what the pool-wide switch was always reaching for; it just admitted
 * the term when *any* model carried a figure rather than when nearly all of them did.
 */
const LATENCY_COVERAGE_FLOOR = 0.8;

/** Blended dollars per million tokens at which the price sub-score is exactly one half. */
const PRICE_HALF_POINT_USD = 1;

/**
 * Prices arrive as per-token decimals and are scaled by a million, so two rates that are equal to
 * the cent can differ in the last float bit. Comparisons against a ceiling allow that much slack.
 */
const PRICE_EPSILON_USD = 1e-6;

/**
 * A model within this many days of its published retirement date is kept out of automatic
 * selection. An unattended server that picks a route which stops answering next week has failed at
 * the one job it has, and the successor is always one refresh away.
 */
export const RETIREMENT_HORIZON_DAYS = 30;

/** A route serving less than this share of requests over the last day is treated as broken. */
export const MIN_HEALTHY_UPTIME_PERCENT = 90;

/**
 * Share of a multi-step task's input tokens that arrive as a cache read rather than a fresh prompt.
 * An agent resends the contract, the tool catalogue and the whole trajectory every step, so after
 * the first turn almost all of the prefix is a repeat; three quarters is a deliberately conservative
 * reading of that. It only ever applies where the route publishes a cache-read rate.
 */
const CACHED_INPUT_SHARE = 0.75;

export interface TaskWeights {
  readonly quality: number;
  readonly latency: number;
  readonly price: number;
  readonly context: number;
}

export interface TaskProfile {
  readonly kind: ModelTaskKind;
  /** Which benchmark column actually speaks to this task. */
  readonly benchmark: 'coding' | 'agentic' | 'intelligence';
  readonly weights: TaskWeights;
  /** Capabilities the task cannot be performed without. */
  readonly requiredCapabilities: readonly ModelCapability[];
  readonly requiredModalities: readonly ModelModality[];
  /** Context the task is expected to need; the headroom sub-score is measured against it. */
  readonly referenceContextTokens: number;
  /**
   * Whether the work resends a growing transcript every step. Where it does, and the route
   * publishes a cache-read rate, price is judged on what the task will really cost rather than on
   * charging every input token at the full prompt rate.
   */
  readonly resendsTranscript: boolean;
}

const profiles: Record<ModelTaskKind, TaskProfile> = {
  conversation: {
    kind: 'conversation',
    benchmark: 'intelligence',
    weights: { quality: 0.25, latency: 0.45, price: 0.2, context: 0.1 },
    requiredCapabilities: ['chat'],
    requiredModalities: ['text'],
    referenceContextTokens: 16_000,
    resendsTranscript: false
  },
  general: {
    kind: 'general',
    benchmark: 'intelligence',
    weights: { quality: 0.45, latency: 0.25, price: 0.2, context: 0.1 },
    requiredCapabilities: ['chat'],
    requiredModalities: ['text'],
    referenceContextTokens: 32_000,
    resendsTranscript: false
  },
  reasoning: {
    kind: 'reasoning',
    benchmark: 'intelligence',
    weights: { quality: 0.7, latency: 0.05, price: 0.1, context: 0.15 },
    requiredCapabilities: ['chat', 'reasoning'],
    requiredModalities: ['text'],
    referenceContextTokens: 64_000,
    resendsTranscript: false
  },
  coding: {
    kind: 'coding',
    benchmark: 'coding',
    weights: { quality: 0.65, latency: 0.1, price: 0.1, context: 0.15 },
    requiredCapabilities: ['chat', 'tools'],
    requiredModalities: ['text'],
    referenceContextTokens: 128_000,
    resendsTranscript: true
  },
  agentic: {
    kind: 'agentic',
    benchmark: 'agentic',
    weights: { quality: 0.6, latency: 0.1, price: 0.1, context: 0.2 },
    requiredCapabilities: ['chat', 'tools'],
    requiredModalities: ['text'],
    referenceContextTokens: 128_000,
    resendsTranscript: true
  },
  vision: {
    kind: 'vision',
    benchmark: 'intelligence',
    weights: { quality: 0.55, latency: 0.15, price: 0.15, context: 0.15 },
    requiredCapabilities: ['chat', 'vision'],
    requiredModalities: ['text', 'image'],
    referenceContextTokens: 32_000,
    resendsTranscript: false
  },
  long_context: {
    kind: 'long_context',
    benchmark: 'intelligence',
    weights: { quality: 0.4, latency: 0.05, price: 0.15, context: 0.4 },
    requiredCapabilities: ['chat'],
    requiredModalities: ['text'],
    referenceContextTokens: 400_000,
    resendsTranscript: false
  },
  bulk_summarisation: {
    kind: 'bulk_summarisation',
    benchmark: 'intelligence',
    weights: { quality: 0.15, latency: 0.2, price: 0.55, context: 0.1 },
    requiredCapabilities: ['chat'],
    requiredModalities: ['text'],
    referenceContextTokens: 32_000,
    resendsTranscript: false
  }
};

export const taskProfile = (kind: ModelTaskKind): TaskProfile => profiles[kind];

/** Every task kind the router knows, in a stable order, so callers can enumerate them. */
export const modelTaskKinds: readonly ModelTaskKind[] = Object.freeze([
  'general',
  'coding',
  'agentic',
  'conversation',
  'reasoning',
  'vision',
  'long_context',
  'bulk_summarisation'
] as const);

/**
 * Whether a value is a kind this router has a profile for.
 *
 * Exported because a declared kind is the one routing signal that does not originate in this
 * repository - it arrives from a request body, a stored row, or a tier some other process picked -
 * and `ModelTaskKind` on a field is a claim about such a value rather than a check of it. Anything
 * that turns an outside label into a kind runs it through here first, because the failure is not a
 * bad route: `profiles` has no entry for an unknown key, so the very next read of
 * `requiredCapabilities` is off `undefined` and the turn dies inside the router.
 */
export const isModelTaskKind = (value: unknown): value is ModelTaskKind =>
  (modelTaskKinds as readonly unknown[]).includes(value);

/**
 * A label from outside, quoted for a line a person reads: bounded to the length of a word and
 * stripped of everything that is not one. It is reported rather than swallowed - a caller that
 * declared a kind this router does not know has a bug, and a silent fall-through to the prose
 * regexes is how that bug stays unfound - but it is reported as evidence, not as prose to trust.
 */
const quotedLabel = (value: string): string =>
  `"${value.replace(/[^A-Za-z0-9_. -]/g, '.').slice(0, 24)}"`;

/**
 * How the preference dial bends a task profile. It multiplies rather than replaces the profile so
 * that "fast coding" still ranks on the coding benchmark, just with latency weighted harder.
 */
const preferenceBias: Record<ModelPreference, TaskWeights> = {
  fast: { quality: 0.5, latency: 2, price: 1.5, context: 0.75 },
  balanced: { quality: 1, latency: 1, price: 1, context: 1 },
  best: { quality: 1.8, latency: 0.4, price: 0.5, context: 1.2 }
};

const normaliseWeights = (raw: TaskWeights, fallback: TaskWeights): TaskWeights => {
  const total = raw.quality + raw.latency + raw.price + raw.context;
  if (total <= 0) return fallback;
  return {
    quality: raw.quality / total,
    latency: raw.latency / total,
    price: raw.price / total,
    context: raw.context / total
  };
};

export const blendWeights = (profile: TaskProfile, preference: ModelPreference): TaskWeights => {
  const bias = preferenceBias[preference];
  return normaliseWeights(
    {
      quality: profile.weights.quality * bias.quality,
      latency: profile.weights.latency * bias.latency,
      price: profile.weights.price * bias.price,
      context: profile.weights.context * bias.context
    },
    profile.weights
  );
};

/**
 * Drops the latency term and shares its weight out across the rest.
 *
 * Falling back to a table indexed by price when nothing has timed the route would make most of
 * the "fast" dial a price lookup wearing a latency label. A sub-score that is honestly absent is
 * better than one that is silently price.
 *
 * Latency is published for some routes and withheld for others rather than absent everywhere:
 * `openrouter-catalog.ts` fills `measuredLatencyMs` from `latency_last_30m`, but only for the
 * models carried by the `/endpoints/zdr` feed, while the ranking pool on a box that never asked
 * for zero retention is the whole catalogue. A mixed pool is therefore the ordinary case, which is
 * why `scoreModel` applies this per candidate rather than once per ranking.
 */
export const withoutLatency = (weights: TaskWeights): TaskWeights =>
  normaliseWeights({ ...weights, latency: 0 }, weights);

export type MetadataSource =
  | 'benchmark'
  | 'overall'
  | 'measured'
  | 'catalogue'
  | 'usage_class'
  | 'unknown';

export interface SubScore {
  readonly value: number;
  readonly source: MetadataSource;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const benchmarkValue = (
  model: RoutableModel,
  benchmark: TaskProfile['benchmark']
): number | null => {
  const raw =
    benchmark === 'coding'
      ? model.codingQuality
      : benchmark === 'agentic'
        ? model.agenticQuality
        : model.intelligenceQuality;
  return typeof raw === 'number' ? raw : null;
};

/** The raw published index behind a percentile, where the catalogue carried one. */
const benchmarkIndex = (
  model: RoutableModel,
  benchmark: TaskProfile['benchmark']
): number | null => {
  const raw =
    benchmark === 'coding'
      ? model.codingIndex
      : benchmark === 'agentic'
        ? model.agenticIndex
        : model.intelligenceIndex;
  return typeof raw === 'number' ? raw : null;
};

/**
 * Quality on one comparable scale.
 *
 * `codingQuality`, `agenticQuality`, `intelligenceQuality` and `measuredQuality` are percentiles
 * within the live catalogue, not percentages of a benchmark: the best-scoring model on a column is
 * 1.0 by construction. That is what keeps the scale meaningful when the index behind it is revised,
 * and what stops an unmeasured model outranking a measured one on the sub-score whose whole job is
 * to reward capability.
 */
export const qualityScore = (
  model: RoutableModel,
  benchmark: TaskProfile['benchmark']
): SubScore => {
  if (model.metadataSource === 'unknown') return { value: 0, source: 'unknown' };
  const dimension = benchmarkValue(model, benchmark);
  if (dimension !== null) return { value: clamp01(dimension), source: 'benchmark' };
  if (typeof model.measuredQuality === 'number')
    return { value: clamp01(model.measuredQuality), source: 'overall' };
  return { value: UNMEASURED_QUALITY_PRIOR, source: 'usage_class' };
};

export const latencyScore = (model: RoutableModel): SubScore | null => {
  if (typeof model.measuredLatencyMs === 'number')
    return { value: clamp01(1 - model.measuredLatencyMs / LATENCY_CEILING_MS), source: 'measured' };
  return null;
};

/**
 * The two published rates at the tier a prompt of this size actually reaches. Tiers are the
 * provider's own `pricing.overrides`: above their threshold the route bills differently, and a
 * ceiling that ignores them is a ceiling the task walks straight through as its transcript grows.
 */
export const pricesAtPromptSize = (
  model: RoutableModel,
  promptTokens: number
): { input: number | null; output: number | null } => {
  let input =
    typeof model.inputUsdPerMillionTokens === 'number' ? model.inputUsdPerMillionTokens : null;
  let output =
    typeof model.outputUsdPerMillionTokens === 'number' ? model.outputUsdPerMillionTokens : null;
  const tiers = [...(model.priceTiers ?? [])].sort(
    (left, right) => left.minPromptTokens - right.minPromptTokens
  );
  for (const tier of tiers) {
    if (promptTokens < tier.minPromptTokens) break;
    if (typeof tier.inputUsdPerMillionTokens === 'number') input = tier.inputUsdPerMillionTokens;
    if (typeof tier.outputUsdPerMillionTokens === 'number') output = tier.outputUsdPerMillionTokens;
  }
  return { input, output };
};

/**
 * Agent transcripts are input-heavy - a long tool log in, a short decision out - so the blended
 * rate weights prompt tokens far above completion tokens. Returns null when the catalogue carries
 * neither price, which callers must treat as "unknown", never as "free".
 */
export const blendedPricePerMillionTokens = (model: RoutableModel): number | null => {
  const input =
    typeof model.inputUsdPerMillionTokens === 'number' ? model.inputUsdPerMillionTokens : null;
  const output =
    typeof model.outputUsdPerMillionTokens === 'number' ? model.outputUsdPerMillionTokens : null;
  if (input === null && output === null) return null;
  return (input ?? output ?? 0) * 0.75 + (output ?? input ?? 0) * 0.25;
};

/**
 * What the work will really cost per million tokens. On a route that publishes a cache-read rate,
 * a task that resends its transcript pays that rate for most of its input, which is close to an
 * order of magnitude below the prompt rate - the difference between a caching model at $5/M and a
 * non-caching one at $1/M being the right choice.
 */
export const effectivePricePerMillionTokens = (
  model: RoutableModel,
  profile: TaskProfile
): number | null => {
  const blended = blendedPricePerMillionTokens(model);
  if (blended === null) return null;
  const cacheRead =
    typeof model.cacheReadUsdPerMillionTokens === 'number'
      ? model.cacheReadUsdPerMillionTokens
      : null;
  const input =
    typeof model.inputUsdPerMillionTokens === 'number' ? model.inputUsdPerMillionTokens : null;
  if (!profile.resendsTranscript || cacheRead === null || input === null) return blended;
  const output =
    typeof model.outputUsdPerMillionTokens === 'number' ? model.outputUsdPerMillionTokens : input;
  const effectiveInput = input * (1 - CACHED_INPUT_SHARE) + cacheRead * CACHED_INPUT_SHARE;
  return effectiveInput * 0.75 + output * 0.25;
};

export const priceScore = (model: RoutableModel, profile?: TaskProfile): SubScore => {
  const price = profile
    ? effectivePricePerMillionTokens(model, profile)
    : blendedPricePerMillionTokens(model);
  if (price === null)
    return { value: usageClassPricePrior[model.usageClass], source: 'usage_class' };
  return { value: PRICE_HALF_POINT_USD / (PRICE_HALF_POINT_USD + price), source: 'catalogue' };
};

/**
 * Headroom, not raw size: a window exactly the size of the task scores 0.5, sixteen times the task
 * scores 1. Without the cap a million-token model would win every ranking on context alone.
 */
export const contextHeadroomScore = (contextTokens: number, referenceTokens: number): number => {
  if (contextTokens <= 0 || referenceTokens <= 0) return 0;
  const headroom = contextTokens / referenceTokens;
  if (headroom <= 1) return clamp01(headroom * 0.5);
  return clamp01(0.5 + Math.log2(headroom) / 8);
};

export const isPrivacyRouteEligible = (model: RoutableModel, route: PrivacyRoute): boolean => {
  if (model.privacyRoute !== route) return false;
  // A reviewed zero-retention model whose live endpoints have all lost their ZDR contract is not a
  // zero-retention route any more, so it must never carry privacy-bound work.
  if (route === 'provider_zdr' && model.zeroDataRetentionAvailable === false) return false;
  return true;
};

const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
    : tokens >= 1_000
      ? `${Math.round(tokens / 1_000)}K`
      : String(tokens);

const formatUsd = (usd: number): string => (usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

/**
 * Everything except the owner's price ceiling: can this model do the work at all.
 */
export const meetsRequirements = (model: RoutableModel, request: ModelRequest): boolean => {
  if (model.availability !== 'available') return false;
  if (model.providerAvailable === false) return false;
  if (!model.commercialUse) return false;
  // A route nobody has measured or described is reachable by name and never by automatic ranking.
  if (model.metadataSource === 'unknown' && !request.requestedId) return false;
  if (!isPrivacyRouteEligible(model, request.privacyRoute)) return false;
  if (model.contextTokens < request.minContextTokens) return false;
  if (request.maxUsageClass && usageRank[model.usageClass] > usageRank[request.maxUsageClass])
    return false;
  if (!request.requiredCapabilities.every((item) => model.capabilities.includes(item)))
    return false;
  return request.requiredModalities.every((item) => model.modalities.includes(item));
};

/** Whether the request carries the owner's two-rate ceiling. */
export const hasPriceCeiling = (request: ModelRequest): boolean =>
  typeof request.maxInputUsdPerMillionTokens === 'number' ||
  typeof request.maxOutputUsdPerMillionTokens === 'number';

/**
 * Which of the two things went wrong.
 *
 * - `over_ceiling` - a rate the provider publishes, and the owner has said it is more than they
 *   will pay.
 * - `no_published_price` - the catalogue does not answer the question, on either rate the ceiling
 *   would compare. A route can be free and land here; every row in the reviewed open-weight seed
 *   allowlist does, and so does any row on a box whose live price refresh has not run yet, and so
 *   does a row whose stated rate this software refused to believe. It does NOT mean "cheap", and it
 *   is reported only after both published rates have been compared - see the ordering below.
 *
 * They are one string in `priceCeilingBreach` and they are not one fact, which is why this type
 * exists: a caller deciding whether the ceiling should overrule something has to be able to tell
 * "too expensive" from "unknown".
 */
export type PriceCeilingBreachKind = 'over_ceiling' | 'no_published_price';

export interface PriceCeilingBreach {
  readonly kind: PriceCeilingBreachKind;
  /** The sentence the interface shows, already formatted. */
  readonly reason: string;
}

/**
 * Why the ceiling excludes this model, or null when it does not, with the two reasons kept apart.
 *
 * This exists because inferring the reason from the sentence is what a caller was doing and it was
 * wrong: `apps/api/src/routes/support.ts` read a non-null advisory message as "over the ceiling"
 * and so dropped an owner's standing pin for every route the catalogue does not price - free routes
 * included, and the whole seed catalogue on a box whose price refresh has not run. Prose is not an
 * API. A caller that must branch on the reason branches on `kind` here; `priceCeilingBreach` below
 * is for callers that only want the sentence.
 *
 * The blended-ceiling shape (`maxUsdPerMillionTokens`) never produces `no_published_price`: an
 * unpriced route blends to null and is admitted. Only the two-rate shape refuses one, and that
 * asymmetry predates this and is left alone here - `isModelEligible` still keeps unpriced routes
 * out of an automatic ranking under a two-rate ceiling, because a rate nobody published is not a
 * rate the owner approved.
 */
export const priceCeilingBreachReason = (
  model: RoutableModel,
  request: ModelRequest
): PriceCeilingBreach | null => {
  if (!hasPriceCeiling(request)) {
    if (typeof request.maxUsdPerMillionTokens !== 'number') return null;
    const blended = blendedPricePerMillionTokens(model);
    if (blended === null || blended <= request.maxUsdPerMillionTokens + PRICE_EPSILON_USD)
      return null;
    return {
      kind: 'over_ceiling',
      reason: `${formatUsd(blended)} blended is above the ${formatUsd(request.maxUsdPerMillionTokens)} ceiling`
    };
  }
  const { input, output } = pricesAtPromptSize(model, request.minContextTokens);
  const maxInput = request.maxInputUsdPerMillionTokens;
  const maxOutput = request.maxOutputUsdPerMillionTokens;
  /*
   * Every published rate is compared before any missing one is reported, and the order matters
   * because one caller now spends the owner's money on the difference.
   *
   * A row can carry one rate and not the other. `perMillion` in
   * `packages/model-gateway/src/openrouter-catalog.ts` reads prompt and completion independently,
   * so a feed that omits one side, or states one side above the credible ceiling, yields a row that
   * is priced on one side and null on the other - and on a `reviewed_open_weight` box such a row is
   * deliberately KEPT with the price removed rather than dropped (openrouter-catalog.ts, the
   * `pricedAbsurdly` block), because dropping one of four would empty the strict catalogue.
   *
   * Checking `input === null` first, as this did, returned `no_published_price` for a route whose
   * OUTPUT rate the catalogue publishes and the owner's ceiling refuses - the over-ceiling side was
   * never reached. `isModelEligible` did not care, since it only asks null or not, but the standing
   * pin in `apps/api/src/routes/support.ts` does: it honours `no_published_price` and drops
   * `over_ceiling`, so a pin on a $900-per-million-output route ran unattended under a $15 output
   * ceiling. Measured through POST /v1/schedules: the pin was returned rather than the $3/$9 ranked
   * pick on the same box.
   *
   * `no_published_price` therefore means what it says - no rate this ceiling could be compared
   * against - and never "a rate that is over the ceiling on the side we did not look at".
   */
  if (typeof maxInput === 'number' && input !== null && input > maxInput + PRICE_EPSILON_USD)
    return {
      kind: 'over_ceiling',
      reason: `${formatUsd(input)} per million input is above the ${formatUsd(maxInput)} ceiling`
    };
  if (typeof maxOutput === 'number' && output !== null && output > maxOutput + PRICE_EPSILON_USD)
    return {
      kind: 'over_ceiling',
      reason: `${formatUsd(output)} per million output is above the ${formatUsd(maxOutput)} ceiling`
    };
  if (
    (typeof maxInput === 'number' && input === null) ||
    (typeof maxOutput === 'number' && output === null)
  )
    return { kind: 'no_published_price', reason: 'no published price' };
  return null;
};

/**
 * Why the ceiling excludes this model, or null when it does not. The sentence is the one the
 * interface shows, so "no published price" reads as a reason rather than as a silent omission.
 *
 * Both reasons flatten to a string here, deliberately: for showing and for `isModelEligible` they
 * are the same answer. Do not read the string back to recover which one it was - that is
 * `priceCeilingBreachReason`.
 */
export const priceCeilingBreach = (model: RoutableModel, request: ModelRequest): string | null =>
  priceCeilingBreachReason(model, request)?.reason ?? null;

export const isModelEligible = (model: RoutableModel, request: ModelRequest): boolean =>
  meetsRequirements(model, request) && priceCeilingBreach(model, request) === null;

const asOfDate = (request: ModelRequest): Date => {
  if (!request.asOf) return new Date();
  const parsed = new Date(request.asOf);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

/** Whether the provider has published a withdrawal date this side of the horizon. */
export const isRetiringSoon = (model: RoutableModel, asOf: Date): boolean => {
  if (!model.expiresAt) return false;
  const expiry = Date.parse(model.expiresAt);
  if (!Number.isFinite(expiry)) return false;
  return expiry - asOf.getTime() <= RETIREMENT_HORIZON_DAYS * 86_400_000;
};

/** Whether the endpoints serving this model were failing often enough yesterday to route around. */
export const isDegraded = (model: RoutableModel): boolean =>
  typeof model.uptimeLast1dPercent === 'number' &&
  model.uptimeLast1dPercent < MIN_HEALTHY_UPTIME_PERCENT;

export interface ScoreBreakdown {
  readonly quality: SubScore;
  /** Null when nothing measured a latency for this model, in which case the term was dropped. */
  readonly latency: SubScore | null;
  readonly price: SubScore;
  readonly context: number;
  readonly weights: TaskWeights;
}

export interface RankedModel {
  model: RoutableModel;
  score: number;
  reasons: string[];
  breakdown: ScoreBreakdown;
  /** One sentence a person can read in the interface to see why this model was picked. */
  explanation: string;
}

const benchmarkLabel: Record<TaskProfile['benchmark'], string> = {
  coding: 'coding',
  agentic: 'agentic',
  intelligence: 'intelligence'
};

const taskLabel: Record<ModelTaskKind, string> = {
  general: 'general work',
  coding: 'coding',
  agentic: 'agentic work',
  conversation: 'fast conversation',
  reasoning: 'deep reasoning',
  vision: 'vision work',
  long_context: 'long-context work',
  bulk_summarisation: 'bulk summarisation'
};

const ordinal = (value: number): string => {
  const rounded = Math.round(value);
  const tens = rounded % 100;
  if (tens >= 11 && tens <= 13) return `${rounded}th`;
  const unit = rounded % 10;
  return `${rounded}${unit === 1 ? 'st' : unit === 2 ? 'nd' : unit === 3 ? 'rd' : 'th'}`;
};

/**
 * The benchmark line. The owner sees the published index and where it sits, never a synthetic
 * decimal: "agentic 55.3, 99th percentile of 117 measured" says something; "0.99" does not.
 */
const describeBenchmark = (
  model: RoutableModel,
  profile: TaskProfile,
  quality: SubScore
): string => {
  const label = benchmarkLabel[profile.benchmark];
  if (quality.source === 'unknown') return 'Nothing is known about this endpoint; it is unrated';
  if (quality.source === 'usage_class')
    return `Not benchmarked; ranked at the ${ordinal(UNMEASURED_QUALITY_PRIOR * 100)} percentile of measured models rather than measured`;
  const percentile = `${ordinal(quality.value * 100)} percentile`;
  // The column the percentile was computed on, never another column's count: the three do not cover
  // the same models, so borrowing the largest overstates how many measured the one being reported.
  const counted =
    quality.source === 'benchmark'
      ? (model.benchmarkPopulations?.[profile.benchmark] ?? model.benchmarkPopulation ?? null)
      : (model.benchmarkPopulation ?? null);
  const population =
    typeof counted === 'number' && counted > 0 ? ` of ${counted} measured` : ' of measured models';
  if (quality.source === 'overall')
    return `No ${label} benchmark yet; overall benchmark ${percentile}${population}`;
  const index = benchmarkIndex(model, profile.benchmark);
  return index === null
    ? `${label} benchmark ${percentile}${population}`
    : `${label} benchmark ${index.toFixed(1)}, ${percentile}${population}`;
};

const buildReasons = (
  model: RoutableModel,
  profile: TaskProfile,
  breakdown: ScoreBreakdown,
  request: ModelRequest
): string[] => {
  const reasons: string[] = [];
  reasons.push(
    request.privacyRoute === 'provider_zdr'
      ? 'Served by a zero-retention endpoint'
      : 'Eligible on the external route'
  );
  reasons.push(`Chosen for ${taskLabel[profile.kind]}`);
  reasons.push(describeBenchmark(model, profile, breakdown.quality));
  reasons.push(
    `${formatTokens(model.contextTokens)} context for a task sized at ${formatTokens(profile.referenceContextTokens)}`
  );
  const blended = blendedPricePerMillionTokens(model);
  const effective = effectivePricePerMillionTokens(model, profile);
  reasons.push(
    blended === null
      ? 'Price not published; ranked on usage class'
      : effective !== null && Math.abs(effective - blended) > PRICE_EPSILON_USD
        ? `${formatUsd(blended)} per million tokens blended, ${formatUsd(effective)} once the prefix is cached`
        : `${formatUsd(blended)} per million tokens blended`
  );
  reasons.push(
    breakdown.latency
      ? `${Math.round(model.measuredLatencyMs ?? 0)} ms measured latency`
      : 'Latency not measured on this server; ranked without it'
  );
  if (typeof model.uptimeLast1dPercent === 'number')
    reasons.push(`${model.uptimeLast1dPercent.toFixed(2)}% uptime over the last day`);
  if (model.expiresAt) reasons.push(`Provider withdraws this route on ${model.expiresAt}`);
  return reasons;
};

export interface ScoreOptions {
  /**
   * Whether the pool this model is being ranked inside carries enough measured latencies for the
   * term to compare anything. `rankModels` decides it once per ranking; on its own `scoreModel`
   * assumes it is, and still drops the term for a model nothing has timed.
   */
  readonly latencyComparable?: boolean;
}

export const scoreModel = (
  model: RoutableModel,
  request: ModelRequest,
  options: ScoreOptions = {}
): { score: number; breakdown: ScoreBreakdown; reasons: string[]; explanation: string } => {
  const profile = taskProfile(request.taskKind ?? 'general');
  // Two separate reasons to drop the term, and the old code had neither right. It scored an
  // untimed model as `0` on a term still carrying its full weight - "slower than the 30-second
  // ceiling" rather than "not measured" - and it admitted the term whenever *any* member of the
  // pool carried a figure. Measured on the shipped build: publishing a single 800 ms latency for a
  // 30th-percentile route at $5/M moved it above an untimed 99th-percentile route at $0.50/M, from
  // last place to first. Now the term takes part only where the pool can actually compare on it,
  // and never turns a missing measurement into a number.
  const latency = options.latencyComparable === false ? null : latencyScore(model);
  const blended = blendWeights(profile, request.preference);
  const weights = latency === null ? withoutLatency(blended) : blended;
  const quality = qualityScore(model, profile.benchmark);
  const price = priceScore(model, profile);
  const context = contextHeadroomScore(
    model.contextTokens,
    Math.max(profile.referenceContextTokens, request.minContextTokens)
  );
  const breakdown: ScoreBreakdown = { quality, latency, price, context, weights };
  const score =
    quality.value * weights.quality +
    (latency?.value ?? 0) * weights.latency +
    price.value * weights.price +
    context * weights.context;
  const reasons = buildReasons(model, profile, breakdown, request);
  const explanation = `${model.displayName} leads for ${taskLabel[profile.kind]}: ${reasons
    .slice(2)
    .join(', ')}.`;
  return { score, breakdown, reasons, explanation };
};

/** The same request with the owner's price ceiling lifted, and nothing else changed. */
const withoutCeiling = (request: ModelRequest): ModelRequest => ({
  privacyRoute: request.privacyRoute,
  requiredCapabilities: request.requiredCapabilities,
  requiredModalities: request.requiredModalities,
  minContextTokens: request.minContextTokens,
  preference: request.preference,
  ...(request.requestedId === undefined ? {} : { requestedId: request.requestedId }),
  ...(request.maxUsageClass === undefined ? {} : { maxUsageClass: request.maxUsageClass }),
  ...(request.taskKind === undefined ? {} : { taskKind: request.taskKind }),
  ...(request.asOf === undefined ? {} : { asOf: request.asOf })
});

export const rankModels = (models: RoutableModel[], request: ModelRequest): RankedModel[] => {
  if (request.requestedId) {
    // An explicit pick is never constrained by the ceiling: it governs what garden chooses for the
    // owner, never what the owner chooses for themselves.
    const relaxed = withoutCeiling(request);
    return models
      .filter((model) => model.id === request.requestedId && isModelEligible(model, relaxed))
      .map((model) => {
        const scored = scoreModel(model, request);
        return {
          model,
          score: 1,
          reasons: ['Explicitly selected by the user', ...scored.reasons],
          breakdown: scored.breakdown,
          explanation: `${model.displayName} was selected by you; it is ${scored.reasons[0]?.toLowerCase() ?? 'eligible'}.`
        };
      });
  }

  const eligible = models.filter((model) => isModelEligible(model, request));
  // A route the provider is about to withdraw, or one that was failing yesterday, is kept out of
  // automatic selection - unless it is all there is, in which case saying so beats refusing to work.
  const asOf = asOfDate(request);
  const healthy = eligible.filter((model) => !isRetiringSoon(model, asOf) && !isDegraded(model));
  const pool = healthy.length > 0 ? healthy : eligible;
  const timed = pool.filter((model) => typeof model.measuredLatencyMs === 'number').length;
  const latencyComparable = pool.length > 0 && timed / pool.length >= LATENCY_COVERAGE_FLOOR;

  return pool
    .map((model) => {
      const scored = scoreModel(model, request, { latencyComparable });
      return {
        model,
        score: scored.score,
        reasons: scored.reasons,
        breakdown: scored.breakdown,
        explanation: scored.explanation
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.model.benchmarkRank ?? Number.MAX_SAFE_INTEGER) -
          (right.model.benchmarkRank ?? Number.MAX_SAFE_INTEGER) ||
        left.model.id.localeCompare(right.model.id)
    );
};

/**
 * What the owner's ceiling did to this selection.
 *
 * Read it as a statement about the *ceiling*, not about the pool: the question a caller has is
 * "did my ceiling cause this", and only `blocked` answers yes.
 *
 * - `no_ceiling` - the ceiling took no part. No ceiling was set; or the owner named a model the
 *   ceiling has no objection to; or nothing was eligible for reasons the ceiling had no hand in.
 * - `within` - a model was picked and the ceiling did not have to give anything up to pick it.
 * - `relaxed_unbenchmarked` - every benchmarked model that could do the work is above the ceiling, so
 *   an unmeasured one was used and said so.
 * - `blocked` - nothing fits at all. Nothing is picked, because silently spending over a ceiling the
 *   owner set while they are asleep is the one outcome a ceiling exists to prevent.
 * - `requested_over_ceiling` - the owner named a model whose published rate is above their ceiling.
 *   It is still the choice, because an explicit pick outranks the ceiling; the outcome is here so a
 *   caller that has decided otherwise for its own path can act on it.
 * - `requested_unpriced` - the owner named a model the catalogue publishes no price for, so the
 *   ceiling could not be applied either way. Distinct from `requested_over_ceiling` because these
 *   two carried the same advisory sentence and a caller that told them apart by that sentence
 *   revoked pins for unpriced routes, free ones included.
 */
export type CeilingOutcome =
  | 'no_ceiling'
  | 'within'
  | 'relaxed_unbenchmarked'
  | 'blocked'
  | 'requested_over_ceiling'
  | 'requested_unpriced';

export interface ModelSelection {
  /** Every eligible model in rank order. Empty when the ceiling blocked the whole catalogue. */
  readonly ranked: RankedModel[];
  readonly choice: RankedModel | null;
  readonly ceilingOutcome: CeilingOutcome;
  /** One sentence for the interface and the timeline, or null when nothing needs saying. */
  readonly message: string | null;
  /** When blocked, the cheapest model that could have done the work with the ceiling lifted. */
  readonly cheapestAboveCeiling: RoutableModel | null;
}

/**
 * The owner's price ceiling as it is stored, either rate optional.
 *
 * It is a type of its own because it crosses three boundaries - the `spend_limits` row, the
 * `SpendLimits` contract and `ModelRequest` - and it is `priceCeilingFields` below that takes the
 * last step, so the conversion has one home rather than one per call site.
 *
 * Every producer of a `ModelRequest` on the live path reads the owner's stored limits and spreads
 * them in:
 *
 * - `apps/api/src/routes/models.ts` - `/v1/models/recommend`, so a recommendation is never a route
 *   the box is not allowed to take.
 * - `apps/api/src/routes/support.ts` - the support picker, through `selectModel` rather than
 *   `rankModels(...)[0]`, because `blocked` is an answer and an empty array is not.
 * - `apps/api/src/routes/tasks.ts` - `modelFit`, which spreads the request through unchanged, so
 *   the "you could have used X" line never names a route the ceiling forbids.
 * - `apps/worker/src/vision.ts` - the vision specialist, which hands the ceiling to
 *   `requestForWork` below, ranks under it, and then asks `selectModel` which of the two refusals
 *   it is looking at.
 *
 * Anything that stops spreading it is a silent regression, because a request with no ceiling is
 * indistinguishable from an owner who set none. `model-policy.test.ts` holds the negative control.
 */
export interface OwnerPriceCeiling {
  readonly maxInputUsdPerMillionTokens?: number | null;
  readonly maxOutputUsdPerMillionTokens?: number | null;
}

/**
 * The stored ceiling as `ModelRequest` fields, ready to spread into a request.
 *
 * `null` means no ceiling and `0` means a ceiling of zero, which admits only a route that publishes
 * a price of zero and is a thing an owner may legitimately want on a box that must never bill. A
 * caller spreading the record through `??` turns the second into the first, so the conversion has
 * one home rather than one per call site.
 */
export const priceCeilingFields = (
  ceiling: OwnerPriceCeiling | null | undefined
): Pick<ModelRequest, 'maxInputUsdPerMillionTokens' | 'maxOutputUsdPerMillionTokens'> => {
  if (!ceiling) return {};
  return {
    ...(typeof ceiling.maxInputUsdPerMillionTokens === 'number'
      ? { maxInputUsdPerMillionTokens: ceiling.maxInputUsdPerMillionTokens }
      : {}),
    ...(typeof ceiling.maxOutputUsdPerMillionTokens === 'number'
      ? { maxOutputUsdPerMillionTokens: ceiling.maxOutputUsdPerMillionTokens }
      : {})
  };
};

/** Whether this request carries a price ceiling of any of the three shapes. */
const carriesPriceCeiling = (request: ModelRequest): boolean =>
  hasPriceCeiling(request) || typeof request.maxUsdPerMillionTokens === 'number';

/**
 * What the work costs per million tokens at the tier this request will actually reach.
 *
 * `blendedPricePerMillionTokens` cannot answer this: it reads the headline rates and ignores
 * `priceTiers`, so on a route that is cheap to 200K and dear past it, it would name the wrong model
 * as the cheapest one over the ceiling - and send the owner to raise a ceiling for a route that was
 * never the expensive one. Unpriced routes sort last, because "unknown" is not "free".
 */
const ceilingCostAt = (model: RoutableModel, request: ModelRequest): number => {
  const { input, output } = pricesAtPromptSize(model, request.minContextTokens);
  if (input === null && output === null) return Number.POSITIVE_INFINITY;
  return (input ?? output ?? 0) * 0.75 + (output ?? input ?? 0) * 0.25;
};

const isBenchmarked = (model: RoutableModel, request: ModelRequest): boolean =>
  qualityScore(model, taskProfile(request.taskKind ?? 'general').benchmark).source !==
  'usage_class';

/**
 * Rank, then say what the owner's ceiling did to the answer - including refusing to answer.
 *
 * `rankModels` has always applied the ceiling correctly; what did not exist was a producer of this
 * verdict, so its `blocked` arm - the only arm that refuses - had no way to reach a caller. A
 * ranking that comes back empty is indistinguishable from a catalogue that is still loading, and a
 * caller that reads `[0]?.model` and falls through to a default is how a ceiling becomes a
 * suggestion. This returns the reason with the result so the caller has to handle it.
 *
 * Two callers handle it today, and both turn `blocked` into something the owner can act on: the
 * support picker answers 402 with `message`, and the vision path posts the same sentence into the
 * transcript *and* to the owner, because a model cannot raise a price ceiling and an owner cannot
 * read a system message. A third caller that reads `.choice` and ignores `.ceilingOutcome` would
 * compile and would put the refusal back where it started.
 */
export const selectModel = (models: RoutableModel[], request: ModelRequest): ModelSelection => {
  const ranked = rankModels(models, request);
  const choice = ranked[0] ?? null;
  const none = {
    ranked,
    choice,
    ceilingOutcome: 'no_ceiling',
    message: null,
    cheapestAboveCeiling: null
  } as const;
  if (!carriesPriceCeiling(request)) return none;

  if (request.requestedId) {
    /*
     * An explicit pick is never constrained by the ceiling - it governs what garden chooses for
     * the owner, never what the owner chooses for themselves - but it is not silent about it
     * either. A model the owner named that is over their own ceiling is worth one sentence.
     *
     * The outcome says which of the two reasons produced that sentence, because one caller has to
     * overrule the explicit pick on its own path: the standing pin in
     * `apps/api/src/routes/support.ts` governs runs the owner is not present for, so there the
     * ceiling wins. Deciding by `message !== null` would not do: that is true for an unpriced route
     * as well as an expensive one, and so it would revoke pins the ceiling has no verdict on at
     * all.
     */
    const breach = choice ? priceCeilingBreachReason(choice.model, request) : null;
    if (!choice || !breach) return none;
    return breach.kind === 'over_ceiling'
      ? {
          ...none,
          ceilingOutcome: 'requested_over_ceiling',
          message: `You chose ${choice.model.displayName}, which is above your price ceiling: ${breach.reason}.`
        }
      : {
          ...none,
          ceilingOutcome: 'requested_unpriced',
          message: `You chose ${choice.model.displayName}, and its price is not published, so your price ceiling cannot be checked against it.`
        };
  }

  const relaxed = withoutCeiling(request);
  const excluded = models
    .filter((model) => isModelEligible(model, relaxed) && !isModelEligible(model, request))
    .sort(
      (left, right) =>
        ceilingCostAt(left, request) - ceilingCostAt(right, request) ||
        left.id.localeCompare(right.id)
    );

  if (!choice) {
    const cheapest = excluded[0];
    // Nothing was eligible - but the ceiling is only to blame when lifting it would have produced
    // something. A catalogue with no model that can do the work at any price is a different
    // problem, and calling it `blocked` sends the owner to change the one setting that cannot help.
    if (!cheapest) return none;
    const breach = priceCeilingBreach(cheapest, request);
    return {
      ranked,
      choice: null,
      ceilingOutcome: 'blocked',
      message: `No model can do this work under your price ceiling. The cheapest that could is ${cheapest.displayName}, and ${breach ?? 'it is above the ceiling'}.`,
      cheapestAboveCeiling: cheapest
    };
  }

  // Only worth saying when the ceiling is what cost the measurement. An unmeasured pick on a
  // catalogue where nothing is measured is a catalogue that has not been benchmarked, not a
  // ceiling that gave something up.
  if (
    !isBenchmarked(choice.model, request) &&
    excluded.some((model) => isBenchmarked(model, request))
  )
    return {
      ranked,
      choice,
      ceilingOutcome: 'relaxed_unbenchmarked',
      message: `${choice.model.displayName} is under your price ceiling but nobody has benchmarked it; every measured model that could do this work is above the ceiling.`,
      cheapestAboveCeiling: null
    };

  return { ranked, choice, ceilingOutcome: 'within', message: null, cheapestAboveCeiling: null };
};

export interface TaskSignals {
  readonly prompt: string;
  /**
   * The kind the caller already knows, because it read the request rather than guessing at it. It
   * outranks every prose hint: a keyword list that decides in advance what shape a job has is the
   * mold, and this is the way out of it.
   */
  readonly declaredKind?: ModelTaskKind;
  /** The turn carries screenshots or photographs, whatever the words say. */
  readonly hasImages?: boolean;
  /** Tokens of transcript, files or tool output the model has to read alongside the prompt. */
  readonly attachedContextTokens?: number;
  readonly interactive?: boolean;
  /**
   * Whether the turn is being handed a tool catalogue and a computer.
   *
   * It gates the conversation profile, and it has to, because `interactive` on its own measures the
   * length of the request rather than the size of the work. Measured: "Generate a cartoon logo, cut
   * the background out cleanly, produce several sizes and a contact sheet" is ninety-eight
   * characters, and on the short-prompt rule alone it classified as `conversation` - the profile
   * that weights latency at 0.45 and quality at 0.25 against a 16K reference window. What that
   * sentence actually asked for was image maths, a script, several runs of it and a montage, on a
   * window that reached 37,000 tokens. A short imperative typed at a machine that can act is not a
   * chat, and no reading of the words was ever going to say so.
   */
  readonly usesTools?: boolean;
  /** Set when the caller is the system talking to itself rather than the owner. */
  readonly internalPurpose?: 'summarisation' | 'classification' | 'extraction';
}

export interface TaskClassification {
  readonly kind: ModelTaskKind;
  /** The observations that produced the kind, in the order they fired. */
  readonly signals: readonly string[];
}

/** Attached context at or above this no longer fits a normal window comfortably. */
export const LONG_CONTEXT_SIGNAL_TOKENS = 120_000;

/** A short prompt in a live turn is a conversation, not a project. */
export const CONVERSATION_PROMPT_CHARS = 160;

const visionPattern =
  /\b(screenshot|screen shot|screengrab|image|images|photo|photograph|picture|ocr|scanned page|video frame|look at this)\b/i;
const longContextPattern =
  /\b(whole (?:repo|repository|codebase|book|transcript|thread)|entire (?:repo|repository|codebase|book|transcript|corpus|archive)|full transcript|hundreds of pages|across all (?:files|documents|papers)|every file in)\b/i;
const bulkPattern =
  /\b(?:summari[sz]e|summaries of|classify|categori[sz]e|label|tag)\s+(?:these|all|each|every|the following)\b/i;
const codingPattern =
  /\b(code|coding|codebase|repository|repo|debug|bug|refactor|typescript|javascript|python|rust|golang|java|compile|unit test|integration test|pull request|website|web app|api|database|sql)\b/i;
const reasoningPattern =
  /\b(prove|proof|theorem|derive|derivation|first principles|step by step|reason through|think through|trade-?offs?|root cause|why does|why did|formally verify|architecture decision|design doc)\b/i;
/**
 * Only phrases that mean the work leaves this process - a browser, an installer, a deployment, a
 * calendar. A word that merely describes an artefact does not belong here: with one, "Summarise
 * this document for me" is routed to the agentic profile with a 128K reference window. An artefact
 * is not a plan, and this list must never grow into one.
 */
const agenticPattern =
  /\b(research|browse|browser|find online|search the web|compare sources|apply for|install|deploy|publish|schedule|book a|order a|host a demo|fill (?:in|out) (?:the|this|a) form)\b/i;

/**
 * Deterministic, ordered classification. Order encodes precedence: what the caller knows outranks
 * what the words suggest, a hard capability need (images) outranks a subject-matter hint, and a
 * measured context size outranks any wording.
 */
export const classifyModelTask = (signals: TaskSignals): TaskClassification => {
  const prompt = signals.prompt;
  /*
   * An unrecognised label loses its precedence, before the rule that grants it.
   *
   * It is answered here rather than folded into the branch below so that the precedence rule stays
   * the two lines it has always been and reads as what it is. The fallback is what makes that rule
   * safe to grant: a kind with no profile is not a worse route, it is a `TypeError` two lines into
   * `modelFit`, on the one path whose whole job is to be the safe one.
   */
  if (signals.declaredKind !== undefined && !isModelTaskKind(signals.declaredKind)) {
    const { declaredKind: unrecognised, ...rest } = signals;
    const inferred = classifyModelTask(rest);
    return {
      ...inferred,
      signals: [
        `Ignored an unknown declared kind ${quotedLabel(unrecognised)}`,
        ...inferred.signals
      ]
    };
  }
  if (signals.declaredKind)
    return { kind: signals.declaredKind, signals: ['The caller named the kind of work'] };
  if (signals.internalPurpose)
    return {
      kind: 'bulk_summarisation',
      signals: [`Internal ${signals.internalPurpose} request`]
    };
  if (signals.hasImages === true)
    return { kind: 'vision', signals: ['The turn carries image attachments'] };
  if (visionPattern.test(prompt))
    return { kind: 'vision', signals: ['The prompt asks about visual material'] };
  if (
    typeof signals.attachedContextTokens === 'number' &&
    signals.attachedContextTokens >= LONG_CONTEXT_SIGNAL_TOKENS
  )
    return {
      kind: 'long_context',
      signals: [`${signals.attachedContextTokens} tokens of attached context`]
    };
  if (longContextPattern.test(prompt))
    return { kind: 'long_context', signals: ['The prompt spans a whole corpus'] };
  if (bulkPattern.test(prompt))
    return {
      kind: 'bulk_summarisation',
      signals: ['The prompt is bulk summarisation or labelling']
    };
  if (codingPattern.test(prompt)) return { kind: 'coding', signals: ['The prompt is about code'] };
  if (reasoningPattern.test(prompt))
    return { kind: 'reasoning', signals: ['The prompt asks for a derivation or a judgement'] };
  if (agenticPattern.test(prompt))
    return { kind: 'agentic', signals: ['The prompt asks for multi-step work with tools'] };
  if (
    signals.interactive === true &&
    signals.usesTools !== true &&
    prompt.trim().length <= CONVERSATION_PROMPT_CHARS
  )
    return {
      kind: 'conversation',
      signals: ['Short prompt in a live conversation, with no tools']
    };
  return { kind: 'general', signals: ['No specialised signal; treated as general work'] };
};

/**
 * A piece of work the caller can describe, and the ceiling it has to be done under.
 *
 * The profiles hold what each kind of work needs - which capabilities, which modalities, which
 * window it is judged against - and every ranking site outside this file wrote those out by hand
 * beside its own call. That is two spellings of one rule: the profile decides how a candidate is
 * *scored* for vision work while the call site decides who is *eligible* for it, and nothing makes
 * them agree. Adding `reasoning` to a profile then silently fails to narrow the pool at the one
 * place that ranks under it.
 */
export interface DeclaredWork {
  /** What the caller knows about the turn, including the kind when it knows that too. */
  readonly signals: TaskSignals;
  readonly privacyRoute: PrivacyRoute;
  readonly minContextTokens: number;
  /** Defaults to `balanced`, which is the dial an unattended site should be asking for. */
  readonly preference?: ModelPreference;
  /** The owner's stored ceiling. Absent is not the same as none; see `priceCeilingFields`. */
  readonly ceiling?: OwnerPriceCeiling | null;
  /** Capabilities this site needs beyond the profile's, if it has any of its own. */
  readonly alsoRequires?: readonly ModelCapability[];
}

/**
 * The request the router should be asked, given what the caller knows.
 *
 * The classification runs even when the kind is declared, because the precedence rule is the thing
 * being reused: a declared kind outranks the prose, an unrecognised one loses that precedence, and
 * both answers come from one function rather than from each call site's idea of them.
 */
export const requestForWork = (work: DeclaredWork): ModelRequest => {
  const profile = taskProfile(classifyModelTask(work.signals).kind);
  return {
    privacyRoute: work.privacyRoute,
    taskKind: profile.kind,
    requiredCapabilities: [
      ...new Set([...profile.requiredCapabilities, ...(work.alsoRequires ?? [])])
    ],
    requiredModalities: [...profile.requiredModalities],
    minContextTokens: work.minContextTokens,
    preference: work.preference ?? 'balanced',
    ...priceCeilingFields(work.ceiling)
  };
};

/**
 * The model that answered a moment ago, put back at the head of a ranking it is still in.
 *
 * A ranking is recomputed every time a sequence of calls needs a model, and the catalogue it reads
 * moves underneath a run that lasts hours: availability, price and measured quality are all
 * refreshed while the turn is in progress. Recomputed from scratch each time, a turn can be handed
 * to a different model halfway through - which is a downgrade nobody chose if the newcomer is
 * worse, a different describer of the same conversation if it is better, and in both cases a
 * prompt prefix the provider has never seen before, on a `sessionId` whose entire purpose is that
 * it has.
 *
 * It reorders, and it never re-admits: the incumbent has to still be in the ranking it is being
 * moved up inside, so every eligibility rule - the privacy route, the owner's price ceiling, a
 * withdrawn row, a route that lost the endpoint - has already excluded it before this is asked.
 * Stickiness that could resurrect a candidate would be a way of routing around exactly the checks
 * that are worth having.
 */
export const preferIncumbent = <T extends { readonly id: string }>(
  ranked: readonly T[],
  incumbentId: string | undefined
): readonly T[] => {
  if (incumbentId === undefined) return ranked;
  const index = ranked.findIndex((entry) => entry.id === incumbentId);
  // Absent, or already leading: nothing to move, and no copy of the array to make.
  if (index <= 0) return ranked;
  return [ranked[index]!, ...ranked.slice(0, index), ...ranked.slice(index + 1)];
};

/**
 * Why this model cannot do this work, in the terms the request was made in. Empty means it can.
 *
 * `meetsRequirements` answers the same question with a boolean, which is all a filter needs and
 * nothing an owner can act on. The sentences are the same clauses, in the same order, said once.
 */
export const unmetRequirements = (model: RoutableModel, request: ModelRequest): string[] => {
  const missing: string[] = [];
  if (model.availability !== 'available')
    missing.push(`the provider lists it as ${model.availability}`);
  if (model.providerAvailable === false) missing.push('its provider is not answering');
  if (!model.commercialUse) missing.push('its licence has not been cleared');
  if (model.metadataSource === 'unknown') missing.push('nothing is known about this endpoint');
  if (!isPrivacyRouteEligible(model, request.privacyRoute))
    missing.push(
      request.privacyRoute === 'provider_zdr'
        ? 'it has no verified zero-retention route'
        : 'it is not on this privacy route'
    );
  if (model.contextTokens < request.minContextTokens)
    missing.push(
      `${formatTokens(model.contextTokens)} context for ${formatTokens(request.minContextTokens)} of work`
    );
  for (const capability of request.requiredCapabilities)
    if (!model.capabilities.includes(capability)) missing.push(`no ${capability}`);
  for (const modality of request.requiredModalities)
    if (!model.modalities.includes(modality)) missing.push(`it cannot read ${modality}`);
  return missing;
};

/**
 * How far down the ranking the model in use has to sit before the gap is worth a line. Third place
 * on a catalogue of hundreds is the router disagreeing with itself, not a bad choice.
 */
const FIT_RANK_FLOOR = 4;

/**
 * And how much blended score has to separate it from the leader. Both have to be true: a wide gap
 * between first and second is a strong leader, not a poor pick, and rank alone is noise.
 */
const FIT_SCORE_GAP = 0.12;

export interface ModelFit {
  /** The shape of work the request was read as, and the observations that produced it. */
  readonly classification: TaskClassification;
  /** Where the model in use placed, 1-based. Null when it was not rankable for this work at all. */
  readonly rank: number | null;
  readonly ranked: number;
  /** What it cannot do for this work. Empty when it can, and the whole answer when it cannot. */
  readonly missing: readonly string[];
  /** What leads instead, or null when the model in use already does. */
  readonly leader: RoutableModel | null;
  /** One line for the transcript, or null when the fit is fine and nothing needs saying. */
  readonly headline: string | null;
  /** The benchmark behind the line, which is the part worth reading twice. Empty when silent. */
  readonly detail: string;
}

/**
 * Whether the model about to answer suits the work in front of it.
 *
 * `rankModels` short-circuits a named model to a score of 1 and the reason "Explicitly selected by
 * the user" - correct, because the owner's pick is not garden's to overrule, and the reason
 * nothing anywhere compares the model in use against the one the router would have reached for. A
 * fast route pointed at precise multi-step work degenerates quietly: it costs almost nothing per
 * call, so no ceiling fires, and the only signal reaching the owner is a spinner.
 *
 * It is judged on `fast`, whatever the owner asked for. That dial weights latency and price hardest
 * and quality least, so it is the most forgiving reading a cheap route can get; a model that still
 * places near the bottom under it is behind on terms nobody chose. This says so once and stops -
 * changing the route mid-task is a decision with its own failure modes, and the owner has a model
 * control two inches from where this line lands.
 */
export const modelFit = (input: {
  models: RoutableModel[];
  /** The model that will actually answer. */
  chosen: RoutableModel;
  /** The request as the router would have received it, without the owner's pick short-circuiting it. */
  request: ModelRequest;
  signals: TaskSignals;
}): ModelFit => {
  // Whether the turn can act is a fact about the request, not something a caller should be able to
  // get wrong: a ranking that requires the tools capability is by definition ranking for tool work.
  const classification = classifyModelTask({
    ...input.signals,
    usesTools: input.request.requiredCapabilities.includes('tools')
  });
  const profile = taskProfile(classification.kind);
  const { requestedId: _pinned, ...open } = input.request;
  const request: ModelRequest = {
    ...open,
    preference: 'fast',
    taskKind: classification.kind,
    requiredCapabilities: [
      ...new Set([...input.request.requiredCapabilities, ...profile.requiredCapabilities])
    ],
    requiredModalities: [
      ...new Set([...input.request.requiredModalities, ...profile.requiredModalities])
    ]
  };
  const ranked = rankModels(input.models, request);
  const leader = ranked[0] ?? null;
  const index = ranked.findIndex((entry) => entry.model.id === input.chosen.id);
  const chosen = index >= 0 ? ranked[index]! : null;
  const silent: ModelFit = {
    classification,
    rank: chosen ? index + 1 : null,
    ranked: ranked.length,
    missing: [],
    leader: null,
    headline: null,
    detail: ''
  };
  // Nothing to compare against, or the model in use is already the answer.
  if (!leader || leader.model.id === input.chosen.id) return silent;
  const benchmarkOf = (model: RoutableModel): string =>
    `${model.displayName}: ${describeBenchmark(model, profile, qualityScore(model, profile.benchmark)).toLowerCase()}`;
  if (!chosen) {
    const missing = unmetRequirements(input.chosen, request);
    // Ranked out for something this function does not model - a retirement date, a bad day on the
    // provider's endpoints. Both are already reported where they are decided; neither is a fit.
    if (missing.length === 0) return silent;
    return {
      ...silent,
      missing,
      leader: leader.model,
      headline: `${input.chosen.displayName} cannot do ${taskLabel[classification.kind]} here: ${missing.join(', ')}. ${leader.model.displayName} can.`,
      detail: benchmarkOf(leader.model)
    };
  }
  if (index + 1 < FIT_RANK_FLOOR || leader.score - chosen.score < FIT_SCORE_GAP) return silent;
  return {
    ...silent,
    leader: leader.model,
    headline: `${input.chosen.displayName} ranks ${index + 1} of ${ranked.length} for ${taskLabel[classification.kind]}; ${leader.model.displayName} leads.`,
    detail: `${benchmarkOf(input.chosen)}. ${benchmarkOf(leader.model)}.`
  };
};

/** Collapses the full task vocabulary onto the three kinds older callers understand. */
export const coarsenTaskKind = (kind: ModelTaskKind): 'general' | 'coding' | 'agentic' =>
  kind === 'coding' ? 'coding' : kind === 'agentic' ? 'agentic' : 'general';

/**
 * The kind a prompt implies, in the router's full vocabulary. Coarsened to three kinds on the way
 * out, it would leave five carefully written profiles - vision, long context, reasoning, bulk
 * summarisation, conversation - unreachable from the only entry point that uses it.
 */
export const inferModelTask = (prompt: string): ModelTaskKind => classifyModelTask({ prompt }).kind;
