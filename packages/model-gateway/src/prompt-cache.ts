/**
 * Provider prompt caching. Explicit routes accept `cache_control` breakpoints; automatic routes
 * detect repeated prefixes without that field. Cache-write pricing alone does not prove a route
 * needs explicit markers, since automatic caches can charge for writes too.
 */
export type PromptCacheStyle = 'explicit' | 'automatic' | 'none';

/** Anthropic accepts at most four cache breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * A breakpoint only pays for itself above the provider's minimum cacheable prefix (1024 tokens
 * for the smallest Anthropic models, 2048 for larger ones). Marking a short prefix costs a cache
 * write and returns nothing, so the context layer skips breakpoints below this estimate.
 *
 * The prefix being measured is the whole request up to the breakpoint, not the messages alone: the
 * tool catalogue is serialized ahead of them and is cached with them. Measuring a message run on
 * its own declines to cache blocks that are comfortably over the threshold once the definitions in
 * front of them are counted, which is why the context layer takes those tokens as an input.
 */
export const MIN_CACHEABLE_TOKENS = 2_048;

/**
 * Vendors known to bill explicit cache writes, used only when the catalogue carries no pricing for
 * a route. It is a fallback, not the rule: every entry here is confirmed by the catalogue anyway,
 * and the list must not grow - a route the catalogue describes is decided from what it publishes.
 */
const EXPLICIT_CACHE_PREFIXES = ['anthropic/', 'google/'];

/**
 * Routes are identified by their OpenRouter `vendor/model` slug. Alias ids are prefixed with a
 * tilde (`~anthropic/claude-opus-latest`), and an alias is the id an unattended server should
 * prefer, because it tracks the current release without a code change. A bare model id from a
 * custom OpenAI-compatible endpoint has no vendor prefix and is treated as automatic.
 */
export const promptCacheStyle = (providerModelId: string): PromptCacheStyle => {
  const slug = providerModelId.toLowerCase().replace(/^~/, '');
  return EXPLICIT_CACHE_PREFIXES.some((prefix) => slug.startsWith(prefix))
    ? 'explicit'
    : 'automatic';
};

/** What the catalogue says about one route's caching. */
export interface PromptCacheFacts {
  readonly providerModelId: string;
  readonly cacheReadUsdPerMillionTokens?: number | null;
  readonly cacheWriteUsdPerMillionTokens?: number | null;
  /** True when every eligible endpoint serving this route reports implicit caching. */
  readonly supportsImplicitCaching?: boolean;
  /** Whether the provider catalogue described this route at all. */
  readonly catalogued?: boolean;
}

/**
 * Prefer declared automatic caching over pricing heuristics. OpenAI caches automatically even
 * when it charges for writes; its optional explicit format is not `cache_control`.
 */
export const promptCacheStyleFor = (facts: PromptCacheFacts): PromptCacheStyle => {
  if (facts.supportsImplicitCaching === true) return 'automatic';
  if (facts.providerModelId.toLowerCase().replace(/^~/, '').startsWith('openai/'))
    return 'automatic';
  if (typeof facts.cacheWriteUsdPerMillionTokens === 'number') return 'explicit';
  if (typeof facts.cacheReadUsdPerMillionTokens === 'number') return 'automatic';
  if (facts.catalogued === true) return 'none';
  return promptCacheStyle(facts.providerModelId);
};

export interface CacheUsageFields {
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/**
 * Reads cache accounting from a completion body. Providers disagree about where these live and
 * new fields appear without notice, so every shape is optional and an unreadable value simply
 * means "not reported" rather than zero.
 */
export const readCacheUsage = (
  usage: CacheUsageFields | undefined | null
): { cachedInputTokens?: number; cacheWriteTokens?: number } => {
  if (!usage) return {};
  const cached =
    nonNegativeInteger(usage.prompt_tokens_details?.cached_tokens) ??
    nonNegativeInteger(usage.cache_read_input_tokens);
  const written =
    nonNegativeInteger(usage.prompt_tokens_details?.cache_write_tokens) ??
    nonNegativeInteger(usage.cache_creation_input_tokens);
  return {
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(written === undefined ? {} : { cacheWriteTokens: written })
  };
};
