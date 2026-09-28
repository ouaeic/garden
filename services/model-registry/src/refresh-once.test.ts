import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptJson, inferenceCredentialAad } from '@garden/core';
import { refreshOpenRouterCatalog } from '@garden/model-gateway';
import { refreshOnce, type CatalogStore } from './refresh-once.js';

const masterKey = randomBytes(32);
const OWNER = 'ffffffff-2222-4222-8222-ffffffffffff';

interface Catalogue {
  store: CatalogStore;
  /** Every whole-catalogue replacement this pass performed, in order. */
  replaced: Array<Array<Record<string, unknown>>>;
  /** Every seed write. On a box with a live catalogue this list has to stay empty. */
  upserted: Array<Array<Record<string, unknown>>>;
}

const catalogue = (
  existing: Array<Record<string, unknown>>,
  savedKey?: string,
  savedProvider = 'openrouter'
): Catalogue => {
  const replaced: Array<Array<Record<string, unknown>>> = [];
  const upserted: Array<Array<Record<string, unknown>>> = [];
  const rows = [...existing];
  return {
    replaced,
    upserted,
    store: {
      soleUser: async () => ({ id: OWNER }),
      listManagedProviderCredentials: async (userId: string) => {
        if (!savedKey || userId !== OWNER) return [];
        return [
          {
            provider: 'inference',
            status: 'active',
            secretCiphertext: encryptJson(
              { provider: savedProvider, apiKey: savedKey, baseUrl: 'https://endpoint.test/v1' },
              masterKey,
              inferenceCredentialAad(OWNER)
            )
          }
        ];
      },
      listModels: async () => rows,
      replaceModelCatalog: async (models) => {
        replaced.push(models);
        rows.splice(0, rows.length, ...models);
      },
      upsertModels: async (models) => {
        upserted.push(models);
        rows.push(...models);
      }
    }
  };
};

const pass = (store: CatalogStore, over: Partial<Parameters<typeof refreshOnce>[0]> = {}) =>
  refreshOnce({
    store,
    masterKey: null,
    baseUrl: 'https://openrouter.test/api/v1',
    scope: 'provider_catalog',
    refreshCatalog: async () => [],
    ...over
  });

describe('refreshOnce', () => {
  it('writes the built-in seed into an empty catalogue, which is the only thing that fills it on a box with no provider key', async () => {
    const fake = catalogue([]);
    const outcome = await pass(fake.store);
    expect(outcome.state).toBe('seeded');
    expect(outcome.reason).toBeNull();
    expect(fake.upserted).toHaveLength(1);
    expect(outcome.models).toBeGreaterThan(0);
    expect(fake.upserted[0]).toHaveLength(outcome.models);
    expect(fake.replaced).toEqual([]);
  });

  /*
   * The regression guard, for a defect this box has already had. The seed used to be written on
   * every pass with no key at all, and no shipped path sets a registry key - so within an hour of
   * finishing setup the static seed landed on top of the catalogue the API had enriched from the
   * owner's own provider account. The curated models went back to availability 'review', lost
   * their prices, left the picker, and every task or schedule pinned to one failed with
   * model_unavailable. The `!existing.length` guard is what ended that, and until now nothing
   * held it in place.
   */
  it('leaves a catalogue that already holds models exactly as it is when there is no key, rather than writing the seed over what the API enriched', async () => {
    const enriched = [
      {
        id: 'openrouter/anthropic/claude-sonnet-4.5',
        availability: 'available',
        usageClass: 'high'
      }
    ];
    const fake = catalogue(enriched);
    const outcome = await pass(fake.store);
    expect(outcome).toEqual({ state: 'frozen', models: 1, reason: null });
    expect(fake.upserted).toEqual([]);
    expect(fake.replaced).toEqual([]);
  });

  it('replaces the whole catalogue from the key the owner saved, and hands the refresh what the catalogue said before it', async () => {
    const fake = catalogue(
      [{ id: 'openrouter/withdrawn-last-quarter', provider: 'openrouter' }],
      'sk-owner'
    );
    let sawKey = '';
    let sawPrevious = -1;
    const outcome = await pass(fake.store, {
      masterKey,
      refreshCatalog: async (_allowlist, options) => {
        sawKey = options.apiKey;
        sawPrevious = options.previous.length;
        return [
          { id: 'openrouter/live-today', provider: 'openrouter' },
          { id: 'openrouter/released-yesterday', provider: 'openrouter' }
        ];
      }
    });
    expect(outcome).toEqual({ state: 'refreshed', models: 2, reason: null });
    expect(sawKey).toBe('sk-owner');
    expect(sawPrevious).toBe(0);
    expect(fake.replaced).toEqual([
      [
        { id: 'openrouter/live-today', provider: 'openrouter', connectionId: 'openrouter' },
        { id: 'openrouter/released-yesterday', provider: 'openrouter', connectionId: 'openrouter' }
      ]
    ]);
    expect(fake.upserted).toEqual([]);
  });

  it('reports what went wrong instead of throwing, because a pass that throws is a loop that stops', async () => {
    const fake = catalogue([{ id: 'openrouter/one' }], 'sk-owner');
    const outcome = await pass(fake.store, {
      masterKey,
      refreshCatalog: async () => {
        throw new Error('OpenRouter models returned 503');
      }
    });
    expect(outcome).toEqual({
      state: 'failed',
      models: 1,
      reason: 'OpenRouter models returned 503'
    });
    expect(fake.replaced).toEqual([]);
    expect(fake.upserted).toEqual([]);
  });

  /*
   * The end-to-end shape of the silent failure: a provider answers, every model still arrives, and
   * none of them is described as taking tools any more - one renamed field upstream. The replace
   * used to run on that and report `refreshed`, which left `selectModel` ranking an empty pool with
   * nothing anywhere on the box naming a cause. What has to be true is all three of these at once:
   * the catalogue already here is untouched, the pass says so in a state of its own, and the reason
   * is carried out where the journal and `garden doctor` can both put it in front of the owner.
   */
  it('refuses to replace a good catalogue with an answer that stopped describing models, and says which fact went', async () => {
    const described = Array.from({ length: 40 }, (_unused, index) => ({
      id: `openrouter/m-${index}`,
      provider: 'openrouter',
      capabilities: ['chat', 'tools'],
      inputUsdPerMillionTokens: 3,
      measuredQuality: 0.8
    }));
    const fake = catalogue(described, 'sk-owner');
    const outcome = await pass(fake.store, {
      masterKey,
      refreshCatalog: async () => described.map((model) => ({ ...model, capabilities: ['chat'] }))
    });
    expect(outcome.state).toBe('refused');
    expect(outcome.models).toBe(40);
    expect(outcome.reason).toContain('models that can be given tools');
    expect(fake.replaced).toEqual([]);
    expect(fake.upserted).toEqual([]);
  });

  it('counts the catalogue that survives a provider answering with nothing, since an empty answer prunes nothing', async () => {
    const fake = catalogue([{ id: 'openrouter/one' }, { id: 'openrouter/two' }], 'sk-owner');
    const outcome = await pass(fake.store, { masterKey });
    expect(outcome).toEqual({ state: 'refreshed', models: 2, reason: null });
  });
});

/*
 * "openrouter etc.", where etc. used to mean nothing.
 *
 * A credential for any provider but OpenRouter answered null, the pass reported `frozen`, and the
 * catalogue an owner on Ollama Cloud or their own endpoint saw was the one written at the moment
 * they pasted their key - for the life of the box. These are the three things that have to be true
 * now: the endpoint is asked, its answer is written, and the prune reaches only that provider's
 * rows, because a catalogue holding both kinds must not lose one to a refresh of the other.
 */
describe('a provider that is not OpenRouter', () => {
  const configured = [
    {
      id: 'custom/served',
      providerModelId: 'served',
      provider: 'custom',
      recommendationTags: ['Ollama Cloud'],
      capabilities: ['chat']
    }
  ];
  const alsoOnTheBox = [{ id: 'openrouter/seed', provider: 'openrouter', capabilities: ['chat'] }];

  it('asks the owner endpoint on the hour instead of freezing their catalogue at key-save', async () => {
    const fake = catalogue([...configured, ...alsoOnTheBox], 'sk-owner', 'ollama-cloud');
    let sawBaseUrl = '';
    let sawPrevious: string[] = [];
    const outcome = await pass(fake.store, {
      masterKey,
      configuredCatalog: async (given) => {
        sawBaseUrl = given.baseUrl;
        sawPrevious = given.previous.map((row) => String(row.id));
        return [
          { id: 'custom/served', provider: 'custom', capabilities: ['chat'] },
          { id: 'custom/added-since', provider: 'custom', capabilities: ['chat'] }
        ];
      },
      refreshCatalog: async () => {
        throw new Error(
          'an endpoint that is not OpenRouter must not be asked OpenRouter questions'
        );
      }
    });
    expect(outcome.state).toBe('refreshed');
    expect(sawBaseUrl).toBe('https://endpoint.test/v1');
    // Only this provider's rows go in as the record of what the owner declared.
    expect(sawPrevious).toEqual(['custom/served']);
    expect(fake.replaced).toHaveLength(1);
    expect(fake.replaced[0]?.map((row) => row.id)).toEqual(['custom/served', 'custom/added-since']);
    // Two custom rows plus the OpenRouter row the answer said nothing about and did not touch.
    expect(outcome.models).toBe(3);
  });

  it('leaves the catalogue alone when the endpoint lists none of the models this box holds', async () => {
    const fake = catalogue([...configured, ...alsoOnTheBox], 'sk-owner', 'openai-compatible');
    const outcome = await pass(fake.store, { masterKey, configuredCatalog: async () => [] });
    expect(outcome).toEqual({ state: 'refreshed', models: 2, reason: null });
    expect(fake.replaced).toEqual([[]]);
  });
});

/*
 * The same defect through the real importer, with a provider body rather than a hand-written row.
 *
 * The test above proves the pass refuses rows that lost a fact. This proves the fact is actually
 * lost by the thing the brief says loses it: `refreshOpenRouterCatalog` reads
 * `supported_parameters` and nothing validates it, so renaming that one key upstream - the whole
 * of the attack - produces forty models the loop would have written over a working catalogue. One
 * shape change already happened in this feed's recorded history (`latency_last_30m` went from an
 * object to a number-or-null), so the next one is a question of when.
 */
describe('a provider that renames a field the importer reads', () => {
  const providerModels = (parametersKey: string): unknown[] =>
    Array.from({ length: 40 }, (_unused, index) => ({
      id: `vendor/model-${index}`,
      name: `Model ${index}`,
      context_length: 200_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.000003', completion: '0.000015' },
      [parametersKey]: ['tools', 'reasoning'],
      benchmarks: { artificial_analysis: { intelligence_index: 50, agentic_index: 40 } }
    }));

  const providerFetch =
    (parametersKey: string): typeof fetch =>
    async (input) =>
      new Response(
        JSON.stringify(
          (typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).endsWith('/endpoints/zdr')
            ? {
                data: Array.from({ length: 40 }, (_unused, index) => ({
                  model_id: `vendor/model-${index}`,
                  status: 0,
                  uptime_last_1d: 99
                }))
              }
            : { data: providerModels(parametersKey) }
        ),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );

  const runAgainst = async (parametersKey: string, seedRows: Array<Record<string, unknown>>) => {
    const fake = catalogue(seedRows, 'sk-owner');
    const outcome = await refreshOnce({
      store: fake.store,
      masterKey,
      baseUrl: 'https://openrouter.test/api/v1',
      scope: 'provider_catalog',
      refreshCatalog: (allowlist, options) =>
        refreshOpenRouterCatalog(allowlist, { ...options, fetch: providerFetch(parametersKey) })
    });
    return { outcome, fake };
  };

  it('is written whole while the field is named what this build expects', async () => {
    const { outcome, fake } = await runAgainst('supported_parameters', []);
    expect(outcome.state).toBe('refreshed');
    const written = fake.replaced.at(-1) ?? [];
    const withTools = written.filter(
      (model) => Array.isArray(model.capabilities) && model.capabilities.includes('tools')
    );
    expect(withTools.length).toBeGreaterThan(0);
  });

  it('is refused once it is not, instead of deleting a working catalogue and reporting success', async () => {
    const healthy = (await runAgainst('supported_parameters', [])).fake;
    const catalogueOnTheBox = healthy.replaced.at(-1) ?? [];
    const { outcome, fake } = await runAgainst('capabilities_supported', catalogueOnTheBox);
    expect(outcome.state).toBe('refused');
    expect(outcome.reason).toContain('models that can be given tools');
    expect(outcome.models).toBe(catalogueOnTheBox.length);
    expect(fake.replaced).toEqual([]);
  });
});
