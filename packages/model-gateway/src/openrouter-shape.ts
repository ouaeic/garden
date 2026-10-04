/**
 * The one place this package looks at OpenRouter's `/models` document before believing any of it.
 *
 * That document comes from a service garden does not control, and a bare TypeScript interface is
 * only a compile-time description of what the wire is expected to hold, which nothing checks at run
 * time. Read through one, four reshapes of the document each throw a raw TypeError out of the whole
 * refresh rather than out of one row: `supported_parameters` as an object,
 * `architecture.input_modalities` as an object, `pricing.overrides` as an object, and a single
 * `null` inside `data`. Every caller records the failure and leaves the previous catalogue serving,
 * but the owner would read a raw JavaScript sentence in `garden doctor`, and one provider's field
 * reshape would stop every model in the catalogue from being refreshed for as long as it lasted.
 *
 * This is a narrowing, not a schema. It brings in no validation vocabulary and no dependency: it
 * walks the document once and answers with the shape the rest of openrouter-catalog.ts already
 * assumes, replacing each field it could not read with the value that field's absence already
 * produced. The module exports one function and imports nothing, so a reviewer can hold the whole
 * of it at once and confirm that it decides nothing.
 *
 * What it does NOT do is judge. Whether a window is credible, whether a rate can be a rate, whether
 * a model has a route in this build - all of that stays in openrouter-catalog.ts, because those are
 * questions about belief rather than about shape, and answering both behind one call is how a
 * narrowing turns into a policy nobody can find.
 *
 * It also does not repair an id. A row whose id is missing, empty or not a string is put on
 * `malformed` and skipped, and a row's stated id is passed through exactly as written even when it
 * carries surrounding whitespace: that string is the name the provider will be called back with, so
 * tidying it would invent an id the provider never published.
 */

import { readReasoningOptions, type ReasoningOptions } from './reasoning.js';

/** A rate as this feed publishes rates, or nothing said. */
type Rate = string | undefined;

interface ShapedPriceTier {
  min_prompt_tokens: number | null;
  prompt: Rate;
  completion: Rate;
  input_cache_read: Rate;
  input_cache_write: Rate;
}

interface ShapedPricing {
  audio: Rate;
  image_token: Rate;
  prompt: Rate;
  completion: Rate;
  input_cache_read: Rate;
  input_cache_write: Rate;
  overrides: ShapedPriceTier[];
}

interface ShapedAnalysis {
  intelligence_index: number | null;
  coding_index: number | null;
  agentic_index: number | null;
}

interface ShapedArenaEntry {
  arena: string | undefined;
  category: string | undefined;
  elo: number | null;
  win_rate: number | null;
  rank: number | null;
}

/**
 * One model, in the shape the catalogue builder reads.
 *
 * Every field is present, which is what lets the builder stop asking whether the feed mentioned it.
 * Two are deliberately still nullable rather than always-an-object, because their absence is read
 * as a fact rather than as a blank: `alias_target` is what tells the ranking pass which models were
 * measured in their own right - an always-present object would make every model an alias of nothing
 * and empty the benchmark population - and `reasoning` is nullable to match it.
 */
interface ShapedModel {
  id: string;
  name: string | undefined;
  context_length: number | null;
  architecture: { input_modalities: string[]; output_modalities: string[] };
  pricing: ShapedPricing;
  supported_parameters: string[];
  top_provider: { max_completion_tokens: number | null };
  knowledge_cutoff: string | null;
  expiration_date: string | null;
  alias_target: { slug: string | undefined; name: string | undefined } | null;
  reasoning: ReasoningOptions | null;
  benchmarks: { artificial_analysis: ShapedAnalysis | null; design_arena: ShapedArenaEntry[] };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textIn = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** The strings in a list, and nothing else in it: a list of mixed junk yields the strings it has. */
const textsIn = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * A number the feed stated, or nothing.
 *
 * The string arm is not tidiness. `context_length` arriving as "1000000" was measured against the
 * built parser: its `typeof value !== 'number'` refused the field, the entry fell back to the
 * 128,000 default, and a million-token model was offered at 12.8% of the window it has, silently.
 * A decimal string is the ordinary way a JSON producer emits a large integer, so the digits are
 * read. `Number('')` and `Number('  ')` are both 0, which would state the absence of a window as a
 * window of nothing, so an empty string is refused before the conversion rather than after it.
 */
const numberIn = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * A rate, kept as the string the price arithmetic downstream already expects.
 *
 * A rate that arrives as a JSON number works by accident - `perMillion` calls `Number` on it and
 * never looks at the type - so it is converted here rather than dropped, which keeps that accident
 * working under a type that is true of the value instead of merely declared about it.
 */
const rateIn = (value: unknown): Rate => {
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
};

const priceTierIn = (value: unknown): ShapedPriceTier => {
  const tier = isRecord(value) ? value : {};
  return {
    min_prompt_tokens: numberIn(tier.min_prompt_tokens),
    prompt: rateIn(tier.prompt),
    completion: rateIn(tier.completion),
    input_cache_read: rateIn(tier.input_cache_read),
    input_cache_write: rateIn(tier.input_cache_write)
  };
};

const pricingIn = (value: unknown): ShapedPricing => {
  const pricing = isRecord(value) ? value : {};
  return {
    prompt: rateIn(pricing.prompt),
    audio: rateIn(pricing.audio),
    image_token: rateIn(pricing.image_token),
    completion: rateIn(pricing.completion),
    input_cache_read: rateIn(pricing.input_cache_read),
    input_cache_write: rateIn(pricing.input_cache_write),
    overrides: Array.isArray(pricing.overrides) ? pricing.overrides.map(priceTierIn) : []
  };
};

/**
 * The hard-evaluation block, kept as an object whenever the feed sent one.
 *
 * An empty object is not the same as a missing block here: an alias entry inherits its target's
 * benchmarks only when it carries none of its own, and that question is asked of this field's
 * presence. So a block with no readable index still answers "the feed said something about this
 * model", exactly as it did before.
 */
const analysisIn = (value: unknown): ShapedAnalysis | null =>
  isRecord(value)
    ? {
        intelligence_index: numberIn(value.intelligence_index),
        coding_index: numberIn(value.coding_index),
        agentic_index: numberIn(value.agentic_index)
      }
    : null;

const arenaEntryIn = (value: unknown): ShapedArenaEntry => {
  const entry = isRecord(value) ? value : {};
  return {
    arena: textIn(entry.arena),
    category: textIn(entry.category),
    elo: numberIn(entry.elo),
    win_rate: numberIn(entry.win_rate),
    rank: numberIn(entry.rank)
  };
};

const aliasTargetIn = (value: unknown): ShapedModel['alias_target'] =>
  isRecord(value) ? { slug: textIn(value.slug), name: textIn(value.name) } : null;

const modelIn = (row: Record<string, unknown>, id: string): ShapedModel => {
  const architecture = isRecord(row.architecture) ? row.architecture : {};
  const topProvider = isRecord(row.top_provider) ? row.top_provider : {};
  const benchmarks = isRecord(row.benchmarks) ? row.benchmarks : {};
  return {
    id,
    name: textIn(row.name),
    context_length: numberIn(row.context_length),
    architecture: {
      input_modalities: textsIn(architecture.input_modalities),
      output_modalities: textsIn(architecture.output_modalities)
    },
    pricing: pricingIn(row.pricing),
    supported_parameters: textsIn(row.supported_parameters),
    top_provider: { max_completion_tokens: numberIn(topProvider.max_completion_tokens) },
    knowledge_cutoff: textIn(row.knowledge_cutoff) ?? null,
    expiration_date: textIn(row.expiration_date) ?? null,
    alias_target: aliasTargetIn(row.alias_target),
    reasoning: readReasoningOptions(row.reasoning),
    benchmarks: {
      artificial_analysis: analysisIn(benchmarks.artificial_analysis),
      design_arena: Array.isArray(benchmarks.design_arena)
        ? benchmarks.design_arena.map(arenaEntryIn)
        : []
    }
  };
};

/**
 * Reads the `/models` document into models the builder can walk, and a list naming the rows it could
 * not read at all.
 *
 * A row is unreadable only when it has no id to be called back with; every other reshape costs that
 * row the field and no more. The `malformed` strings say which row and why in fixed words and never
 * quote the feed, because they are written to the journal an owner reads and a document this
 * software does not control must not choose what appears there.
 *
 * That guarantee covers these strings and no others. The journal line `journalDrops` assembles in
 * openrouter-catalog.ts puts `malformed` beside two clauses that do name ids the feed published, so
 * a reader must not take the fixed-words property as a statement about the whole line; those ids
 * are bounded and stripped of anything unprintable by `journalSafeId` in that module instead.
 */
export const readOpenRouterModels = (
  body: unknown
): { models: ShapedModel[]; malformed: string[] } => {
  const rows: unknown[] = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const models: ShapedModel[] = [];
  const malformed: string[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row)) {
      malformed.push(`row ${index} is not a model`);
      return;
    }
    const id = textIn(row.id);
    if (id === undefined || id.trim() === '') {
      malformed.push(`row ${index} states no id`);
      return;
    }
    models.push(modelIn(row, id));
  });
  return { models, malformed };
};
