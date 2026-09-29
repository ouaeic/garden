import { configuredModelCatalog, createModelAdapter, withListPrices } from '@garden/model-gateway';
import type { ModelRelease, PrivacyRoute } from '@garden/contracts';

/**
 * The hourly refresh for a provider that is not OpenRouter.
 *
 * "openrouter etc." was the owner's phrase for what should keep its own model list current, and
 * until this file "etc." covered nothing. The registry is OpenRouter-shaped end to end, so an owner
 * on Ollama Cloud, on a gateway, or on their own endpoint had a catalogue written once - by the API,
 * at the moment they pasted the key - and then frozen for the life of the box. Prices from that
 * afternoon were the prices every run was charged against for ever. A model the provider withdrew
 * went on being offered until a task tried it. A model released afterwards never appeared. And the
 * two surfaces that mentioned any of this told that owner, specifically and only that owner, that
 * saving a provider key in Settings is what starts the refresh - which is the thing they had done.
 *
 * Nothing new is needed to fix it. `describe()` is the *same request the save path already makes*,
 * against the same endpoint, and `configuredModelCatalog` already turns its answer into catalogue
 * rows. The registry simply never called either. This calls both, on the hour, and hands the result
 * to the same `replaceModelCatalog` the OpenRouter path uses - which scopes its prune to the
 * providers present in the answer, so a `custom` refresh cannot touch an OpenRouter row and an
 * OpenRouter refresh cannot touch this one. That scoping was already there and was already the
 * reason a configured catalogue survived the hourly OpenRouter pass at all.
 */
export interface ConfiguredCatalogInput {
  provider: string;
  connectionId?: string;
  defaults?: Pick<ModelRelease, 'contextTokens' | 'capabilities' | 'modalities'>;
  baseUrl: string;
  apiKey?: string | undefined;
  /** The single model the owner named, when the save wrote a single row rather than a catalogue. */
  modelId?: string | undefined;
  enforceZeroDataRetention?: boolean | undefined;
  /**
   * The rows this box already holds for this provider. Two jobs: they are the only record anywhere
   * of what the owner declared at the settings screen, and they say which ids a single-model save
   * committed to.
   */
  previous: ReadonlyArray<Record<string, unknown>>;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number;
}

/** The same fifteen seconds the OpenRouter refresh and the save path both give an endpoint. */
const DESCRIBE_TIMEOUT_MS = 15_000;

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * What the owner told the settings screen, read back out of the rows that screen wrote.
 *
 * The save does not keep the declared context window, capability list or modality list anywhere a
 * later process can read - it spends them on `configuredModelCatalog` and stores only the key, the
 * endpoint and the model id. The catalogue it wrote *is* the record, so this recovers the
 * declaration from it rather than inventing a second set of defaults that would disagree with the
 * owner's the first time either moved.
 *
 * Capabilities and modalities are unioned because `configuredModelCatalog` narrows capabilities per
 * model on an explicit `supportsTools === false`; the union is the declared set before narrowing,
 * and the narrowing is then re-applied by the same function against this refresh's own answer.
 *
 * The context window is the *smallest* on record, not the largest, and it is only ever a fallback
 * for a model the endpoint publishes no window for. Over-claiming here is not a cosmetic error: the
 * context builder packs a request up to this number, so guessing high on a model nobody stated a
 * window for produces a request the provider rejects at the end of a turn's work.
 */
const declaredBy = (
  previous: ReadonlyArray<Record<string, unknown>>
): {
  contextTokens: number;
  capabilities: ModelRelease['capabilities'];
  modalities: ModelRelease['modalities'];
} => {
  const capabilities = new Set<string>();
  const modalities = new Set<string>();
  let contextTokens = Number.POSITIVE_INFINITY;
  for (const row of previous) {
    for (const capability of stringsOf(row.capabilities)) capabilities.add(capability);
    for (const modality of stringsOf(row.modalities)) modalities.add(modality);
    if (typeof row.contextTokens === 'number' && Number.isFinite(row.contextTokens))
      contextTokens = Math.min(contextTokens, row.contextTokens);
  }
  return {
    // The same figure the settings form offers when an owner has declared nothing at all, which is
    // only reachable here on a provider whose rows were all written without one.
    contextTokens: Number.isFinite(contextTokens) ? contextTokens : 128_000,
    capabilities: (capabilities.size
      ? [...capabilities]
      : ['chat', 'tools']) as ModelRelease['capabilities'],
    modalities: (modalities.size ? [...modalities] : ['text']) as ModelRelease['modalities']
  };
};

/**
 * The badge every row carries, kept identical to the save path's so that an hourly refresh does not
 * silently rename what the owner is looking at in the picker.
 */
const tagFor = (provider: string): string =>
  provider === 'ollama-cloud' ? 'Ollama Cloud' : 'Configured endpoint';

export const refreshConfiguredCatalog = async (
  input: ConfiguredCatalogInput
): Promise<Array<Record<string, unknown>>> => {
  const privacyRoute: PrivacyRoute = input.enforceZeroDataRetention ? 'provider_zdr' : 'external';
  const adapter = createModelAdapter({
    provider: input.provider,
    privacyRoute,
    baseUrl: input.baseUrl,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {})
  });
  const described = await adapter.describe(
    AbortSignal.timeout(input.timeoutMs ?? DESCRIBE_TIMEOUT_MS)
  );
  /*
   * A subscription is a catalogue; a configured endpoint is a model.
   *
   * This is the save path's distinction and it is deliberate there: an Ollama Cloud account reaches
   * every cloud model on the plan, while a gateway fronting thirty ids is usually one served model
   * whose facts the owner typed in - and writing that one model's declared facts across all thirty
   * would attach them to twenty-nine models they are not true of. Reproducing the distinction here
   * rather than re-deciding it is what stops the hourly refresh contradicting the save.
   *
   * For the single-model case the ids already in the catalogue are used when the credential carries
   * no `modelId`, because a row written by an older save is still a commitment this box made.
   */
  const pinned = new Set<string>([
    ...(input.modelId ? [input.modelId] : []),
    ...input.previous.flatMap((row) =>
      typeof row.providerModelId === 'string' ? [row.providerModelId] : []
    )
  ]);
  const catalogue = input.modelId
    ? described.filter((model) => model.id === input.modelId)
    : input.connectionId || input.provider === 'ollama-cloud'
      ? described
      : described.filter((model) => pinned.has(model.id));
  /*
   * An endpoint that answered with nothing this refresh recognises is an outage wearing a 200, the
   * same way an empty `/models` is on the OpenRouter path - a gateway restarting, a proxy
   * interstitial, a subscription between plans. Returning an empty list rather than throwing hands
   * it to `replaceModelCatalog`, which prunes nothing on one, so the catalogue already here goes on
   * serving instead of the picker emptying.
   */
  if (catalogue.length === 0) return [];
  const rows = configuredModelCatalog(catalogue, {
    privacyRoute,
    tag: tagFor(input.provider),
    ...(input.connectionId ? { connectionId: input.connectionId, previous: input.previous } : {}),
    ...(input.defaults ?? declaredBy(input.previous))
  });
  // Refreshed with the list prices each hour too, so a price change reaches the spending limits.
  return withListPrices(rows, input.baseUrl, input.fetch ?? globalThis.fetch);
};
