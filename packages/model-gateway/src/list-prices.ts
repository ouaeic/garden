import type { RoutableModel } from '@garden/core';
import { usageClassForPrice } from './catalog.js';
import { readOpenRouterModels } from './openrouter-shape.js';
import { vendorForEndpoint } from './vendors.js';

/**
 * Prices for a model company's own endpoint, where the endpoint publishes none.
 *
 * A direct key lists models without prices, so every call through it used to be costed at a flat
 * guess per usage class - which put a model that bills fifteen dollars per million output tokens
 * against the owner's ceiling at four. The companies' list prices are published, and the one feed
 * that carries all of them in a single machine-readable place is the aggregator's public model
 * list, which states each first-party model at the price its maker charges. That list is read -
 * publicly, with no key and nothing of the owner's in the request - and matched to the direct
 * model by name.
 *
 * Only for the companies whose own models these are. A host serving open models sets its own
 * prices, which the aggregator's figure for the same weights says nothing about, so those stay
 * unpriced rather than wrongly priced.
 */
const SLUGS: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  xai: 'x-ai',
  mistral: 'mistralai',
  deepseek: 'deepseek',
  moonshot: 'moonshotai',
  qwen: 'qwen'
};

const PRICE_LIST_URL = 'https://openrouter.ai/api/v1/models';
const PRICE_LIST_TTL_MS = 60 * 60 * 1000;

type ListPrice = {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
};

/**
 * One spelling for a model name on both sides: lower case, dots as dashes, and no release date or
 * `latest`/`preview` suffix - `claude-sonnet-4-5-20250929` and `claude-sonnet-4.5` are one model.
 */
export const listPriceName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/\./g, '-')
    .replace(/-(latest|preview)$/, '')
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');

/** The feed states dollars per token as text; the catalogue holds dollars per million. */
const perMillion = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed * 1_000_000 * 1e6) / 1e6
    : null;
};

let cached: { at: number; prices: Map<string, ListPrice> } | null = null;

const priceList = async (fetchImpl: typeof fetch): Promise<Map<string, ListPrice>> => {
  if (cached && Date.now() - cached.at < PRICE_LIST_TTL_MS) return cached.prices;
  const response = await fetchImpl(PRICE_LIST_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Price list returned ${response.status}`);
  const { models } = readOpenRouterModels(await response.json());
  const prices = new Map<string, ListPrice>();
  for (const model of models) {
    // Variants (`:free`, `:thinking`) are the aggregator's own offers, not the maker's price.
    if (model.id.includes(':')) continue;
    const [slug, ...rest] = model.id.split('/');
    if (!slug || !rest.length) continue;
    const input = perMillion(model.pricing.prompt);
    const output = perMillion(model.pricing.completion);
    if (input === null || output === null) continue;
    const raw = rest.join('/');
    const key = `${slug}/${listPriceName(raw)}`;
    // A dated release and the undated name meet at one key; the undated one is the current price.
    const undated = listPriceName(raw) === raw.toLowerCase().replace(/\./g, '-');
    if (prices.has(key) && !undated) continue;
    prices.set(key, {
      input,
      output,
      cacheRead: perMillion(model.pricing.input_cache_read),
      cacheWrite: perMillion(model.pricing.input_cache_write)
    });
  }
  cached = { at: Date.now(), prices };
  return prices;
};

/**
 * The same catalogue rows, with list prices filled in where the endpoint gave none. A row that
 * already carries a price keeps it, a name the list does not know stays unpriced, and a list that
 * cannot be read changes nothing: this can only make a cost more accurate, never block a save.
 */
export const withListPrices = async (
  rows: RoutableModel[],
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<RoutableModel[]> => {
  const slug = SLUGS[vendorForEndpoint(baseUrl)?.id ?? ''];
  if (!slug || rows.every((row) => typeof row.inputUsdPerMillionTokens === 'number')) return rows;
  let prices: Map<string, ListPrice>;
  try {
    prices = await priceList(fetchImpl);
  } catch {
    return rows;
  }
  return rows.map((row) => {
    if (typeof row.inputUsdPerMillionTokens === 'number') return row;
    const price = prices.get(`${slug}/${listPriceName(row.providerModelId)}`);
    if (!price) return row;
    return {
      ...row,
      inputUsdPerMillionTokens: price.input,
      outputUsdPerMillionTokens: price.output,
      cacheReadUsdPerMillionTokens: price.cacheRead,
      cacheWriteUsdPerMillionTokens: price.cacheWrite,
      usageClass: usageClassForPrice(price.input),
      recommendationTags: [...row.recommendationTags, 'List price']
    };
  });
};

/** For tests: forget the price list read earlier in this process. */
export const forgetListPrices = () => {
  cached = null;
};
