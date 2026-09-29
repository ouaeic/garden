import type { ModelRelease } from '@garden/contracts';
import {
  GardenError,
  RETIREMENT_HORIZON_DAYS,
  type BenchmarkPopulations,
  type ModelPriceTier,
  type RoutableModel
} from '@garden/core';
import { currentCommercialLicenseReview } from './license-manifest.js';
import { readOpenRouterModels } from './openrouter-shape.js';
import { promptCacheStyleFor, type PromptCacheStyle } from './prompt-cache.js';
import type { ReasoningOptions } from './reasoning.js';

/**
 * How much of the provider's catalogue the owner is offered.
 *
 * - `provider_catalog` (default) exposes every model the owner's own provider account can reach.
 *   Garden never redistributes model weights, so a model's weight licence governs redistribution
 *   rather than API use; it is reported as a badge instead of a gate. New models appear without a
 *   code change, which is what keeps an unattended server working as providers ship releases.
 * - `reviewed_open_weight` restricts selection to models that carry a current independent
 *   commercial-licence review. This is the stricter posture for owners who want to run only
 *   permissively licensed open-weight models, and it fails closed when a review lapses.
 */
export type ModelCatalogScope = 'provider_catalog' | 'reviewed_open_weight';

interface Options {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  now?: Date;
  scope?: ModelCatalogScope;
  /**
   * The catalogue as it stood before this refresh. Zero-retention flags are carried forward from it
   * when the endpoint feed cannot be reached, so one failing request cannot withdraw the owner's
   * private routes on the strength of an outage.
   */
  previous?: ModelRelease[];
}

/*
 * These five describe a model AFTER `readOpenRouterModels` has read it, not as it arrives on the
 * wire. That distinction is the whole point of the module beside this one: what arrives is
 * `unknown`, exactly one function ever looks at it, and everything below here reads the result.
 *
 * So the optional fields are gone. Every field is present and every one carries its own answer for
 * "the feed said nothing" - an empty list, a null number, an undefined rate - which is what lets
 * the code below stop guessing whether a field it is about to index exists. Two stay nullable, and
 * for one reason: `alias_target` is the one whose absence is load-bearing - the ranking pass reads
 * it as "this model was measured in its own right", so an always-present object would make every
 * model an alias and empty the benchmark population - and `reasoning` is nullable to match it, the
 * same decision the twin declaration in openrouter-shape.ts records.
 */
interface OpenRouterPriceTier {
  min_prompt_tokens: number | null;
  prompt: string | undefined;
  completion: string | undefined;
  input_cache_read: string | undefined;
  input_cache_write: string | undefined;
}

interface OpenRouterPricing {
  audio: string | undefined;
  image_token: string | undefined;
  prompt: string | undefined;
  completion: string | undefined;
  input_cache_read: string | undefined;
  input_cache_write: string | undefined;
  overrides: OpenRouterPriceTier[];
}

interface ArtificialAnalysisBenchmark {
  intelligence_index: number | null;
  coding_index: number | null;
  agentic_index: number | null;
}

interface DesignArenaEntry {
  arena: string | undefined;
  category: string | undefined;
  elo: number | null;
  win_rate: number | null;
  rank: number | null;
}

interface OpenRouterModel {
  id: string;
  name: string | undefined;
  context_length: number | null;
  architecture: { input_modalities: string[]; output_modalities: string[] };
  pricing: OpenRouterPricing;
  supported_parameters: string[];
  top_provider: { max_completion_tokens: number | null };
  knowledge_cutoff: string | null;
  expiration_date: string | null;
  /** Set on the `~vendor/model-latest` entries, which carry no benchmarks of their own. */
  alias_target: { slug: string | undefined; name: string | undefined } | null;
  reasoning: ReasoningOptions | null;
  benchmarks: {
    artificial_analysis: ArtificialAnalysisBenchmark | null;
    design_arena: DesignArenaEntry[];
  };
}

/**
 * The endpoint feed is scalar where it was once declared as an object: `latency_last_30m` is a
 * number or null, and it is null on every endpoint observed so far. The uptime fields beside it are
 * populated on all of them, which makes them the reliability signal actually available today.
 */
interface ZdrEndpoint {
  model_id?: string;
  status?: number;
  latency_last_30m?: number | null;
  uptime_last_1d?: number | null;
  supports_implicit_caching?: boolean;
  max_completion_tokens?: number | null;
}

/**
 * A catalogue entry with the live metadata this refresh was able to read. Everything beyond
 * `ModelRelease` is optional, so an entry that predates a field simply does not carry it.
 */
export type CatalogModelRelease = RoutableModel;

const checkedJson = async <T>(response: Response, label: string): Promise<T> => {
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  return response.json() as Promise<T>;
};

/**
 * The bounds this refresh puts on numbers it did not produce.
 *
 * Nothing from the feed used to be checked on the way in, and every one of these figures is read by
 * something that immediately acts on it: the context builder packs a request up to `contextTokens`
 * and subtracts `maxOutputTokens` from it, and a price sets the model's usage class and decides
 * whether the owner's spending ceiling admits the model at all. One mistyped field in a catalogue
 * this software does not control therefore reached the arithmetic intact.
 *
 * These are ceilings on belief, not statements about what exists. Each sits an order of magnitude
 * above anything a provider has published, so a real release passes through untouched and only a
 * figure that cannot be a figure is caught.
 */
export const MAX_CREDIBLE_CONTEXT_TOKENS = 10_000_000;
const MAX_CREDIBLE_OUTPUT_TOKENS = 1_000_000;
const MAX_CREDIBLE_USD_PER_MILLION_TOKENS = 10_000;
/** What a chat route is assumed to hold when the feed states no window at all. */
const DEFAULT_CONTEXT_TOKENS = 128_000;
/** How many dropped routes the journal line names before it counts the rest. */
const JOURNALLED_DROP_LIMIT = 5;
/**
 * How much of one dropped route's id the journal line may spend on it.
 *
 * CHOSEN at 80. The longest model id anywhere in this repository's catalogues and fixtures is 36
 * characters, so no id a provider has actually published comes near this and the line reads exactly
 * as it did before; 80 also fits inside a terminal's traditional width, so five of them plus the
 * surrounding sentence cannot push the count of the remainder off the screen.
 */
const JOURNALLED_ID_CHARS = 80;
/**
 * One dropped route's id, as it may appear on a line an owner reads.
 *
 * These ids are the feed's own strings and not this repository's. `readOpenRouterModels` passes a
 * stated id through exactly as written - it is the name the provider will be called back with, so
 * tidying it would invent an id nobody published - which makes every id here untrusted text on its
 * way to `garden logs`. That module is careful that its own `malformed` strings never quote the
 * document, and there is a test holding it to that; the two id clauses beside it in `journalDrops`
 * print the document directly, so the bound has to be here.
 *
 * Two things are done to it, and nothing else. Anything outside printable ASCII becomes a dot,
 * because a newline inside an id would end garden's line and begin one the feed wrote, in the
 * journal's own voice and indistinguishable from it. Then it is cut to `JOURNALLED_ID_CHARS`.
 *
 * This does NOT make the id safe to act on, and nothing does act on it: it is one line of evidence
 * about a route that was already dropped. It is also not a general escape - a dot is not reversible,
 * so an owner reading a mangled id here is being told the provider published a strange one.
 */
const journalSafeId = (id: string): string => {
  const printable = id.replace(/[^\x20-\x7e]/g, '.');
  return printable.length > JOURNALLED_ID_CHARS
    ? `${printable.slice(0, JOURNALLED_ID_CHARS)}...`
    : printable;
};
/**
 * What `refreshOpenRouterMediaCatalog` below can actually offer. A model that emits none of these
 * and no text has no route anywhere in this build, which is the one drop the chat refresh used to
 * make without a word - see `journalDrops`. Adding a kind here is not enough to serve it; this list
 * exists so the journal stays true to what the media catalogue does, not to widen it.
 */
const MEDIA_OUTPUT_MODALITIES = ['image', 'audio', 'transcription'];

/** Price per million input tokens decides how a run is weighed against the owner's usage windows. */
const usageClassForPrice = (inputUsdPerMillion: number | null): ModelRelease['usageClass'] => {
  if (inputUsdPerMillion === null || !Number.isFinite(inputUsdPerMillion)) return 'medium';
  if (inputUsdPerMillion <= 1) return 'light';
  if (inputUsdPerMillion <= 3) return 'medium';
  if (inputUsdPerMillion <= 10) return 'high';
  return 'extra_high';
};

/**
 * Prices arrive as per-token decimals; scaling by a million in binary floating point leaves noise in
 * the last bits, and a ceiling of exactly $2.00 has to admit a model priced at exactly $2.00.
 *
 * A rate above the credible ceiling is not read as a price. It is not treated as a cheap one
 * either - `pricedAbsurdly` below is what the caller asks before it decides what to do with the
 * route, because an unpriced route is `usageClass: 'medium'` and walks through a spending ceiling
 * untouched, which is the wrong answer to give about a number that was too large to believe.
 */
const perMillion = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const scaled = Math.round(parsed * 1_000_000 * 1e6) / 1e6;
  return scaled > MAX_CREDIBLE_USD_PER_MILLION_TOKENS ? null : scaled;
};

/**
 * Whether any rate this route publishes - including the tier it grows into part-way through a long
 * task - is a number no inference has ever cost. A per-token decimal published as a whole number is
 * the ordinary way this happens: `"1"` is one million dollars per million tokens.
 */
const pricedAbsurdly = (pricing: OpenRouterPricing | undefined): boolean =>
  [
    pricing?.prompt,
    pricing?.completion,
    pricing?.input_cache_read,
    pricing?.input_cache_write,
    ...(pricing?.overrides ?? []).flatMap((tier) => [tier.prompt, tier.completion])
  ].some((value) => {
    if (value === undefined) return false;
    const parsed = Number(value);
    return (
      Number.isFinite(parsed) &&
      parsed >= 0 &&
      parsed * 1_000_000 > MAX_CREDIBLE_USD_PER_MILLION_TOKENS
    );
  });

/**
 * A window this software will pack a request against, or nothing.
 *
 * `ModelRelease.contextTokens` is a positive integer, so a feed stating `0` did not merely produce a
 * bad number - it produced a row the contract parse drops at the API boundary, taking the model out
 * of the picker with nothing said.
 */
const credibleContextTokens = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null;
  return Math.min(Math.floor(value), MAX_CREDIBLE_CONTEXT_TOKENS);
};

/**
 * A reply cannot be longer than the window it is written into. `modelInputBudget` subtracts this
 * figure from the context window, so a `max_completion_tokens` larger than `context_length` - the
 * two arriving from the same feed entry - leaves no room for the conversation and `contextShortfall`
 * refuses the model outright. A stated zero is the absence of a limit, not a limit of nothing.
 */
const credibleOutputTokens = (
  value: number | null | undefined,
  contextTokens: number | null
): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null;
  return Math.min(
    Math.floor(value),
    contextTokens ?? MAX_CREDIBLE_OUTPUT_TOKENS,
    MAX_CREDIBLE_OUTPUT_TOKENS
  );
};

const titleCase = (value: string): string =>
  value
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** OpenRouter usually supplies "Vendor: Model"; a bare slug is humanised as a last resort. */
const displayNameFor = (model: OpenRouterModel): string => {
  const provided = model.name?.trim();
  if (provided)
    return provided.includes(': ') ? provided.split(': ').slice(1).join(': ') : provided;
  return titleCase(model.id.split('/').pop() ?? model.id);
};

/**
 * Where a value sits in the population that carries the same measurement: the count at or below it
 * over the count of all of them, so the best-scoring model is 1.0 by construction.
 *
 * This is the whole of the normalisation. The published indices are weighted averages of hard
 * evaluations that no model is meant to approach 100 on - the best in the world scores about 61 on
 * intelligence and 55 on agentic - so dividing by 100 made being benchmarked a penalty against any
 * unmeasured model's prior. A percentile also survives the next index revision without a code
 * change, which the previous scaling did not.
 */
const percentileOf = (value: number, sorted: number[]): number => {
  if (sorted.length === 0) return 0;
  let atOrBelow = 0;
  for (const entry of sorted) {
    if (entry <= value) atOrBelow += 1;
    else break;
  }
  return Math.round((atOrBelow / sorted.length) * 1e4) / 1e4;
};

const sortedFinite = (values: Array<number | null | undefined>): number[] =>
  values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right);

/**
 * A design-arena standing is real evidence, and for the 51 models that carry one but no hard-eval
 * index it is the only evidence there is. It is also head-to-head preference on visual and
 * front-end work, so it moves a model inside the middle of the distribution and can never place one
 * above a model measured on hard evaluations.
 */
const ARENA_EVIDENCE_FLOOR = 0.4;
const ARENA_EVIDENCE_SPAN = 0.4;

const bestArenaElo = (entries: DesignArenaEntry[] | null | undefined): number | null => {
  if (!entries?.length) return null;
  const models = entries.filter((entry) => entry.arena === 'models');
  const pool = models.length ? models : entries;
  const elos = pool
    .map((entry) => entry.elo)
    .filter((elo): elo is number => typeof elo === 'number' && Number.isFinite(elo));
  return elos.length ? Math.max(...elos) : null;
};

const derivedTags = (
  supported: Set<string>,
  inputModalities: Set<string>,
  contextTokens: number,
  expiresAt: string | null
): string[] => [
  ...(supported.has('tools') ? ['Tools'] : []),
  ...(supported.has('reasoning') ? ['Reasoning'] : []),
  ...(inputModalities.has('image') ? ['Vision'] : []),
  ...(inputModalities.has('file') ? ['Documents'] : []),
  ...(contextTokens >= 400_000 ? ['Long context'] : []),
  ...(expiresAt ? [`Retires ${expiresAt}`] : [])
];

const priceTiersOf = (pricing: OpenRouterPricing | undefined): ModelPriceTier[] =>
  (pricing?.overrides ?? [])
    .filter((tier) => typeof tier.min_prompt_tokens === 'number')
    .map((tier) => ({
      minPromptTokens: tier.min_prompt_tokens ?? 0,
      inputUsdPerMillionTokens: perMillion(tier.prompt),
      outputUsdPerMillionTokens: perMillion(tier.completion)
    }))
    .sort((left, right) => left.minPromptTokens - right.minPromptTokens);

/**
 * Asks the provider about the credential itself, before anything is saved under it.
 *
 * Neither request below is a check of the key. `/models` and `/endpoints/zdr` are public catalogue
 * routes: both answer 200 to a request carrying no credential at all, so a key with a trailing
 * character, a revoked key, and an account with nothing left to spend all completed the settings
 * screen's "Verify and save" and were written to the database. The first thing that ever read the
 * credential was the owner's next conversation, which failed as a raw 401 in the middle of a task.
 *
 * `/key` is the one route that reads it, it costs nothing, and its answer carries what the key may
 * still spend - so the two failures that are not "wrong key" can be told apart and named.
 */
export const verifyOpenRouterKey = async (options: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): Promise<void> => {
  const request = options.fetch ?? globalThis.fetch;
  const response = await request(`${options.baseUrl.replace(/\/$/, '')}/key`, {
    headers: { authorization: `Bearer ${options.apiKey}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 401 || response.status === 403)
    throw new GardenError(
      'provider_key_rejected',
      'The provider did not accept this key. Paste it again whole — a trailing space or a missing character is enough — and check it has not been revoked.',
      422
    );
  if (!response.ok)
    throw new GardenError(
      'provider_key_uncheckable',
      `The provider answered ${response.status} when asked about this key, so nothing was saved. Try again in a moment.`,
      502
    );
  const body = (await response.json().catch(() => null)) as {
    data?: { limit_remaining?: number | null };
  } | null;
  /*
   * Stated as a number, or not stated at all. A key with no spend limit set reports null here, and
   * an unknown balance must not be reported as an empty one - the point of this call is to stop
   * claiming knowledge it does not have.
   */
  const remaining = body?.data?.limit_remaining;
  if (typeof remaining === 'number' && remaining <= 0)
    throw new GardenError(
      'provider_credit_exhausted',
      'This key works but has nothing left to spend. Add credit to the provider account, or raise this key’s limit, then verify again.',
      422
    );
};

/**
 * Builds the owner's selectable model catalogue from live OpenRouter metadata.
 *
 * In `reviewed_open_weight` scope this enriches, but can never expand, the independently reviewed
 * licence allowlist. In the default `provider_catalog` scope the allowlist supplies curated
 * defaults and the rest of the provider's chat models are offered alongside them.
 *
 * Two requests, settled independently. The model list carries prices, context, capabilities and
 * benchmarks; the endpoint list carries zero-retention routes and uptime. They used to sit in one
 * `Promise.all`, so a failure on either - and the third, undocumented, user-scoped benchmarks call
 * that is now gone - silently blanked the entire catalogue back to seeds, on an unattended server,
 * for months.
 */
export const refreshOpenRouterCatalog = async (
  allowlist: ModelRelease[],
  options: Options
): Promise<CatalogModelRelease[]> => {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${options.apiKey}` };
  const [modelsResult, zdrResult] = await Promise.allSettled([
    request(`${baseUrl}/models?output_modalities=all`, {
      headers,
      signal: AbortSignal.timeout(15_000)
    }).then((response) => checkedJson<unknown>(response, 'OpenRouter models')),
    request(`${baseUrl}/endpoints/zdr`, {
      headers,
      signal: AbortSignal.timeout(15_000)
    }).then((response) => checkedJson<{ data?: unknown }>(response, 'OpenRouter ZDR endpoints'))
  ]);
  // Without the model list there is no catalogue to build, so that failure still propagates.
  if (modelsResult.status === 'rejected') throw modelsResult.reason;
  const zdrBody = zdrResult.status === 'fulfilled' ? zdrResult.value : null;

  /*
   * The feed is read once, here, and everything below this line works on the narrowed rows.
   *
   * `checkedJson` asks only whether the response was ok, so what it hands back is a document, not a
   * catalogue. Four reshapes of that document each used to throw a raw TypeError out of this whole
   * function - see openrouter-shape.ts, which names them - and a reshaped field now costs its own
   * row that field rather than costing the owner the refresh.
   */
  const { models: listed, malformed } = readOpenRouterModels(modelsResult.value);
  const models = new Map<string, OpenRouterModel>(listed.map((model) => [model.id, model]));
  /*
   * An empty list is an outage wearing a 200, and it has to be refused here rather than believed.
   *
   * `checkedJson` only asks whether the response was ok, so a proxy interstitial, a shape change, or
   * an account with nothing enabled all arrive as a body with no models in it - and the answer built
   * from that is not empty, it is the reviewed allowlist on its own, at availability 'unavailable'
   * because no live endpoint backed any of it. Believing that flattens the catalogue on the settings
   * route and, on the registry's replace, deletes every enriched model on the box and leaves four
   * seeds behind - in both cases without a single failed request to account for it.
   */
  if (models.size === 0)
    throw new GardenError(
      'provider_catalog_empty',
      'The provider answered but listed no models, so the catalogue was left as it was',
      502
    );
  /*
   * The endpoint feed is read with the same suspicion as the model feed, and for the same measured
   * reason: `data` arriving as an object threw "object is not iterable" out of this function, and
   * the `Promise.allSettled` above cannot catch it, because the request succeeded and it is the
   * body that is wrong. So one failing shape on the feed that only carries privacy and uptime took
   * down the refresh that carries every model.
   *
   * It gets a guard rather than a narrowing module of its own. Three fields are read off an
   * endpoint below and every one of them is already asked `typeof` before it is believed, so the
   * only thing missing was the shape of the list itself and of the rows in it.
   */
  const zdrRows: unknown[] = Array.isArray(zdrBody?.data) ? zdrBody.data : [];
  const zdr = new Map<string, ZdrEndpoint[]>();
  for (const row of zdrRows) {
    const endpoint = row as ZdrEndpoint | null;
    if (
      typeof endpoint?.model_id !== 'string' ||
      endpoint.model_id === '' ||
      (endpoint.status !== undefined && endpoint.status !== 0)
    )
      continue;
    const current = zdr.get(endpoint.model_id) ?? [];
    current.push(endpoint);
    zdr.set(endpoint.model_id, current);
  }
  const previous = new Map((options.previous ?? []).map((model) => [model.id, model]));

  const now = options.now ?? new Date();
  const updatedAt = now.toISOString();
  const retirementHorizon = now.getTime() + RETIREMENT_HORIZON_DAYS * 86_400_000;

  /** An alias entry carries no benchmarks of its own; it inherits its target's. */
  const benchmarksOf = (
    model: OpenRouterModel | undefined
  ): OpenRouterModel['benchmarks'] | null => {
    if (!model) return null;
    if (model.benchmarks?.artificial_analysis || model.benchmarks?.design_arena?.length)
      return model.benchmarks;
    const target = model.alias_target?.slug ? models.get(model.alias_target.slug) : undefined;
    return target?.benchmarks ?? model.benchmarks ?? null;
  };

  // The population is the models that were measured in their own right. Aliases inherit a score and
  // must not be counted twice inside the distribution they are then ranked against.
  const measured = [...models.values()].filter((model) => !model.alias_target);
  const intelligenceScale = sortedFinite(
    measured.map((model) => model.benchmarks?.artificial_analysis?.intelligence_index)
  );
  const codingScale = sortedFinite(
    measured.map((model) => model.benchmarks?.artificial_analysis?.coding_index)
  );
  const agenticScale = sortedFinite(
    measured.map((model) => model.benchmarks?.artificial_analysis?.agentic_index)
  );
  const arenaScale = sortedFinite(
    measured.map((model) => bestArenaElo(model.benchmarks?.design_arena))
  );
  // The columns do not cover the same models - a live read counted 117 on coding, 108 on agentic and
  // 107 on intelligence - so each percentile reports the count of its own column, and the single
  // number stays only for the overall score, which is the mean of whichever columns a model carried.
  const benchmarkPopulations: BenchmarkPopulations = {
    coding: codingScale.length,
    agentic: agenticScale.length,
    intelligence: intelligenceScale.length
  };
  const benchmarkPopulation = Math.max(
    intelligenceScale.length,
    codingScale.length,
    agenticScale.length
  );

  interface Quality {
    measuredQuality: number | null;
    agenticQuality: number | null;
    codingQuality: number | null;
    intelligenceQuality: number | null;
    agenticIndex: number | null;
    codingIndex: number | null;
    intelligenceIndex: number | null;
    benchmarkSource: string | null;
    benchmarkPopulation: number | null;
    benchmarkPopulations: BenchmarkPopulations | null;
  }

  const qualityOf = (model: OpenRouterModel | undefined): Quality => {
    const benchmarks = benchmarksOf(model);
    const analysis = benchmarks?.artificial_analysis ?? null;
    const index = (value: number | null | undefined): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    const agenticIndex = index(analysis?.agentic_index);
    const codingIndex = index(analysis?.coding_index);
    const intelligenceIndex = index(analysis?.intelligence_index);
    const agenticQuality = agenticIndex === null ? null : percentileOf(agenticIndex, agenticScale);
    const codingQuality = codingIndex === null ? null : percentileOf(codingIndex, codingScale);
    const intelligenceQuality =
      intelligenceIndex === null ? null : percentileOf(intelligenceIndex, intelligenceScale);
    const columns = [agenticQuality, codingQuality, intelligenceQuality].filter(
      (value): value is number => value !== null
    );
    if (columns.length)
      return {
        measuredQuality:
          Math.round((columns.reduce((sum, value) => sum + value, 0) / columns.length) * 1e4) / 1e4,
        agenticQuality,
        codingQuality,
        intelligenceQuality,
        agenticIndex,
        codingIndex,
        intelligenceIndex,
        benchmarkSource: 'artificial-analysis',
        benchmarkPopulation,
        benchmarkPopulations
      };
    const elo = bestArenaElo(benchmarks?.design_arena);
    if (elo !== null)
      return {
        measuredQuality:
          Math.round(
            (ARENA_EVIDENCE_FLOOR + ARENA_EVIDENCE_SPAN * percentileOf(elo, arenaScale)) * 1e4
          ) / 1e4,
        agenticQuality: null,
        codingQuality: null,
        intelligenceQuality: null,
        agenticIndex: null,
        codingIndex: null,
        intelligenceIndex: null,
        benchmarkSource: 'design-arena',
        benchmarkPopulation: arenaScale.length,
        // An arena standing is not a column of the hard-evaluation table, so it claims none of them.
        benchmarkPopulations: null
      };
    return {
      measuredQuality: null,
      agenticQuality: null,
      codingQuality: null,
      intelligenceQuality: null,
      agenticIndex: null,
      codingIndex: null,
      intelligenceIndex: null,
      benchmarkSource: null,
      benchmarkPopulation: null,
      benchmarkPopulations: null
    };
  };

  // Rank is a standing among the models measured on hard evaluations, so a head-to-head arena
  // placing informs a model's quality without claiming a position in that table.
  const overall = measured
    .map((model) => ({ id: model.id, quality: qualityOf(model) }))
    .filter((entry) => entry.quality.benchmarkSource === 'artificial-analysis')
    .map((entry) => ({ id: entry.id, score: entry.quality.measuredQuality ?? 0 }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((entry) => entry.id);
  const ranked = new Map(overall.map((id, position) => [id, position + 1]));
  /** An alias is the same model as its target, so it reports the target's standing, not a second one. */
  const rankOf = (model: OpenRouterModel | undefined): number | null => {
    if (!model) return null;
    const own = ranked.get(model.id);
    if (own !== undefined) return own;
    const target = model.alias_target?.slug;
    return (target === undefined ? undefined : ranked.get(target)) ?? null;
  };

  const scope: ModelCatalogScope = options.scope ?? 'provider_catalog';

  /** Routes left out of the answer because their stated price could not be one. */
  const unbelievablyPriced: string[] = [];
  /** Routes left out because nothing in this build can carry what they emit. */
  const unroutableOutput: string[] = [];

  /*
   * One line for the whole refresh, at the same cadence and in the same place as the registry's own
   * failure line: the journal, read through `garden logs`. A route that quietly stopped being
   * offered is otherwise unaccountable - this service has one owner, no listener and no metrics
   * endpoint - and a line per dropped route would bury the rest of the unit's log the first time a
   * provider shipped a broken price column across a vendor's whole range.
   *
   * Three clauses, because there are three ways to lose a route here and only one of them used to
   * be said out loud. An absurd price was journalled from the start; a row too reshaped to read and
   * a model emitting something this build has no route for were both dropped in silence, and the
   * second of those is how a new output modality would arrive - dropped from the chat catalogue for
   * not emitting text and from the media catalogue for not emitting one of the three kinds it
   * offers, with nothing anywhere to say the provider had shipped it.
   *
   * It is written from both of this function's exits rather than only from the last one, because a
   * `reviewed_open_weight` refresh returns before the loop below and reads the same feed: the rows
   * it could not parse are a fact about the document, not about the owner's scope.
   */
  const journalDrops = (): void => {
    const named = (ids: string[]): string =>
      `${ids.slice(0, JOURNALLED_DROP_LIMIT).map(journalSafeId).join(', ')}${
        ids.length > JOURNALLED_DROP_LIMIT ? ` and ${ids.length - JOURNALLED_DROP_LIMIT} more` : ''
      }`;
    const clauses = [
      unbelievablyPriced.length
        ? `${unbelievablyPriced.length} live ${
            unbelievablyPriced.length === 1 ? 'route was' : 'routes were'
          } left out because the provider stated a rate above $${MAX_CREDIBLE_USD_PER_MILLION_TOKENS} per million tokens: ${named(unbelievablyPriced)}`
        : null,
      unroutableOutput.length
        ? `${unroutableOutput.length} live ${
            unroutableOutput.length === 1 ? 'route was' : 'routes were'
          } left out because this build has no route for what ${
            unroutableOutput.length === 1 ? 'it emits' : 'they emit'
          }: ${named(unroutableOutput)}`
        : null,
      malformed.length
        ? `${malformed.length} ${
            malformed.length === 1 ? 'row was' : 'rows were'
          } skipped as unreadable: ${named(malformed)}`
        : null
    ].filter((clause): clause is string => clause !== null);
    if (clauses.length) process.stderr.write(`[garden] model catalogue: ${clauses.join('; ')}\n`);
  };

  /** Live metadata shared by reviewed and unreviewed models alike. */
  const enrich = (providerModelId: string, catalogueId: string) => {
    const live = models.get(providerModelId);
    const endpoints = zdr.get(providerModelId) ?? [];
    const supported = new Set(live?.supported_parameters ?? []);
    const inputModalities = new Set(live?.architecture?.input_modalities ?? []);
    const quality = qualityOf(live);
    const inputUsdPerMillionTokens = perMillion(live?.pricing?.prompt);
    const outputUsdPerMillionTokens = perMillion(live?.pricing?.completion);
    const uptimes = endpoints
      .map((endpoint) => endpoint.uptime_last_1d)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const latencies = endpoints
      .map((endpoint) => endpoint.latency_last_30m)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const expiresAt = live?.expiration_date ?? null;
    // Zero-retention is a fact about live endpoints. When that feed could not be read we do not
    // claim to know it: the previous answer is carried forward, and failing that the flag is left
    // absent, which the privacy projection reads as "not verified" rather than as "verified safe".
    const zeroDataRetentionAvailable: boolean | undefined = zdrBody
      ? endpoints.length > 0
      : previous.get(catalogueId)?.zeroDataRetentionAvailable;
    const contextTokens = credibleContextTokens(live?.context_length);
    return {
      live,
      endpoints,
      supported,
      inputModalities,
      inputUsdPerMillionTokens,
      zeroDataRetentionAvailable,
      contextTokens,
      expiresAt,
      shared: {
        modalities: [
          'text' as const,
          ...(['image', 'audio', 'video'] as const).filter((kind) => inputModalities.has(kind))
        ],
        nativeInputPricing: {
          audioUsdPerMillionTokens: perMillion(live?.pricing?.audio),
          videoUsdPerMillionTokens:
            inputModalities.has('video') &&
            inputUsdPerMillionTokens !== null &&
            (!inputModalities.has('audio') || perMillion(live?.pricing?.audio) !== null)
              ? Math.max(
                  inputUsdPerMillionTokens,
                  perMillion(live?.pricing?.audio) ?? 0,
                  perMillion(live?.pricing?.image_token) ?? 0
                )
              : null
        },
        capabilities: live?.architecture.output_modalities.includes('decisions')
          ? ['decisions' as const]
          : [
              'chat' as const,
              ...(supported.has('tools') ? (['tools'] as const) : []),
              ...(inputModalities.has('image') ? (['vision'] as const) : []),
              ...(supported.has('reasoning') ? (['reasoning'] as const) : [])
            ],
        measuredQuality: quality.measuredQuality,
        agenticQuality: quality.agenticQuality,
        codingQuality: quality.codingQuality,
        intelligenceQuality: quality.intelligenceQuality,
        agenticIndex: quality.agenticIndex,
        codingIndex: quality.codingIndex,
        intelligenceIndex: quality.intelligenceIndex,
        benchmarkPopulation: quality.benchmarkPopulation,
        benchmarkPopulations: quality.benchmarkPopulations,
        measuredLatencyMs: latencies.length ? Math.round(Math.min(...latencies)) : null,
        uptimeLast1dPercent: uptimes.length ? Math.min(...uptimes) : null,
        inputUsdPerMillionTokens,
        outputUsdPerMillionTokens,
        cacheReadUsdPerMillionTokens: perMillion(live?.pricing?.input_cache_read),
        cacheWriteUsdPerMillionTokens: perMillion(live?.pricing?.input_cache_write),
        priceTiers: priceTiersOf(live?.pricing),
        promptCacheStyle: promptCacheStyleFor({
          providerModelId,
          cacheReadUsdPerMillionTokens: perMillion(live?.pricing?.input_cache_read),
          cacheWriteUsdPerMillionTokens: perMillion(live?.pricing?.input_cache_write),
          supportsImplicitCaching:
            endpoints.length > 0 &&
            endpoints.every((endpoint) => endpoint.supports_implicit_caching === true),
          catalogued: live !== undefined
        }) satisfies PromptCacheStyle,
        supportsReasoningEffort: supported.has('reasoning_effort'),
        ...(live?.reasoning ? { reasoning: live.reasoning } : {}),
        maxOutputTokens: credibleOutputTokens(
          live?.top_provider?.max_completion_tokens,
          contextTokens
        ),
        knowledgeCutoff: live?.knowledge_cutoff ?? null,
        expiresAt,
        metadataSource: 'measured' as const,
        benchmarkRank: rankOf(live),
        benchmarkSource: quality.benchmarkSource,
        // OpenRouter publishes the score but not the date it was run, so this records when garden
        // last read it - which is the only honest answer available and still tells an owner whether
        // they are looking at something from this week or from a catalogue that stopped refreshing.
        benchmarkUpdatedAt: quality.benchmarkSource ? updatedAt : null,
        revision: 'openrouter-live',
        updatedAt
      }
    };
  };

  const reviewedEntries = allowlist.map((entry): CatalogModelRelease => {
    const { live, shared, zeroDataRetentionAvailable, contextTokens, expiresAt } = enrich(
      entry.providerModelId,
      entry.id
    );
    const livePrivateRoute = Boolean(live) && zeroDataRetentionAvailable === true;
    const licenseReview = currentCommercialLicenseReview(entry.providerModelId, entry.license);
    // Strict scope keeps the original fail-closed contract: a model with no review is withdrawn
    // from selection. Provider scope only withdraws the open-weight claim, because the review
    // describes the weights rather than the owner's right to call a hosted endpoint.
    const reviewGated = scope === 'reviewed_open_weight';
    const retiring = expiresAt !== null && Date.parse(expiresAt) <= retirementHorizon;
    return {
      ...entry,
      ...shared,
      ...(reviewGated || licenseReview
        ? {}
        : { openness: 'remote_proprietary' as const, license: 'provider-hosted' }),
      availability: livePrivateRoute
        ? reviewGated && !licenseReview
          ? ('review' as const)
          : ('available' as const)
        : ('unavailable' as const),
      contextTokens: contextTokens ?? entry.contextTokens,
      recommendationTags: retiring
        ? [
            ...entry.recommendationTags.filter((tag) => !tag.startsWith('Retires ')),
            `Retires ${expiresAt}`
          ]
        : entry.recommendationTags.filter((tag) => !tag.startsWith('Retires ')),
      providerAvailable: Boolean(live && (licenseReview || !reviewGated)),
      ...(zeroDataRetentionAvailable === undefined
        ? {}
        : {
            zeroDataRetentionAvailable: Boolean(livePrivateRoute && (licenseReview || !reviewGated))
          })
    };
  });

  if (scope === 'reviewed_open_weight') {
    journalDrops();
    return reviewedEntries;
  }

  const reviewedIds = new Set(allowlist.map((entry) => entry.providerModelId));
  const liveEntries: CatalogModelRelease[] = [];
  for (const [providerModelId, live] of models) {
    if (reviewedIds.has(providerModelId)) continue;
    const outputModalities = live.architecture.output_modalities;
    // Image, audio and video generators are reached through the media service, not the chat loop.
    if (
      outputModalities.length &&
      !outputModalities.includes('text') &&
      !outputModalities.includes('decisions')
    ) {
      // ...unless the media service has no route for it either, in which case the model is gone
      // from both catalogues and this is the only place that can say so.
      if (!outputModalities.some((modality) => MEDIA_OUTPUT_MODALITIES.includes(modality)))
        unroutableOutput.push(providerModelId);
      continue;
    }
    /*
     * A route whose price cannot be a price is left out rather than offered with the price removed.
     * `perMillion` has already refused the figure, and an entry carrying no price is not a cautious
     * entry: `usageClassForPrice` calls it 'medium' and the owner's two-rate ceiling has nothing to
     * compare, so believing nothing about the number would present the most expensive thing in the
     * catalogue as one of the cheapest. The reviewed allowlist above is deliberately not treated
     * this way - it is the curated set, and dropping one of four would empty the strict catalogue -
     * so there the price alone is refused and the seed's own usage class stands.
     */
    if (pricedAbsurdly(live.pricing)) {
      unbelievablyPriced.push(providerModelId);
      continue;
    }
    const catalogueId = `openrouter/${providerModelId}`;
    const {
      supported,
      inputModalities,
      inputUsdPerMillionTokens,
      zeroDataRetentionAvailable,
      contextTokens: statedContextTokens,
      shared
    } = enrich(providerModelId, catalogueId);
    const contextTokens = statedContextTokens ?? DEFAULT_CONTEXT_TOKENS;
    const review = currentCommercialLicenseReview(providerModelId, 'Apache-2.0');
    const expiresAt = live.expiration_date ?? null;
    const retiring = expiresAt !== null && Date.parse(expiresAt) <= retirementHorizon;
    liveEntries.push({
      ...shared,
      id: catalogueId,
      providerModelId,
      displayName: displayNameFor(live),
      provider: 'openrouter',
      availability: 'available',
      openness: review ? 'permissive_open_weight' : 'remote_proprietary',
      license: review?.license ?? 'provider-hosted',
      // The owner licenses a hosted service from their own provider account; Garden neither
      // redistributes weights nor resells inference.
      commercialUse: true,
      /*
       * The same fact as `zeroDataRetentionAvailable`, said in the field that routes on it.
       *
       * This was the literal `'provider_zdr'`, three lines below the honest per-model answer the
       * endpoint feed had just produced - so a model served from no zero-retention endpoint was
       * written `zeroDataRetentionAvailable: false` *and* `privacyRoute: 'provider_zdr'`, two
       * columns describing one fact and disagreeing. `privacyRoute` is the routing input:
       * `isPrivacyRouteEligible` matches on it, and the worker's delegate picker reads the
       * catalogue raw and compares the route alone, with no second look at the flag. On a
       * zero-retention task that picker was choosing the strongest specialist it could find from
       * models with no private route at all.
       *
       * Unknown is not false, here as everywhere else in this file. When the endpoint feed could
       * not be read the flag is absent and nothing new is claimed - the route stays what it was
       * offered as, and the `!== false` guards in `isPrivacyRouteEligible` and the worker's
       * `usableCapabilities` keep deciding the absent case, as they already did.
       */
      privacyRoute: zeroDataRetentionAvailable === false ? 'external' : 'provider_zdr',
      contextTokens,
      usageClass: usageClassForPrice(inputUsdPerMillionTokens),
      recommendationTags: derivedTags(
        supported,
        inputModalities,
        contextTokens,
        retiring ? expiresAt : null
      ),
      providerAvailable: true,
      ...(zeroDataRetentionAvailable === undefined ? {} : { zeroDataRetentionAvailable })
    });
  }

  journalDrops();

  return [...reviewedEntries, ...liveEntries];
};

export { refreshOpenRouterMediaCatalog } from './media-catalog.js';

/** Projects shared live endpoint metadata into one owner's current privacy policy. */
export const applyOpenRouterPrivacyPolicy = <T extends ModelRelease>(
  model: T,
  requireZeroDataRetention: boolean
): T => {
  if (model.provider !== 'openrouter' || model.providerAvailable === undefined) return model;
  const eligible = requireZeroDataRetention
    ? model.zeroDataRetentionAvailable === true
    : model.providerAvailable;
  return {
    ...model,
    privacyRoute: requireZeroDataRetention ? 'provider_zdr' : 'external',
    availability:
      model.availability === 'review' ? 'review' : eligible ? 'available' : 'unavailable'
  };
};
