import { describe, expect, it, vi } from 'vitest';
import type { AthanorError } from '@athanor/core';
import type { ModelRelease } from '@athanor/contracts';
import { seedModels } from './catalog.js';
import { currentCommercialLicenseReview } from './license-manifest.js';
import {
  applyOpenRouterPrivacyPolicy,
  MAX_CREDIBLE_CONTEXT_TOKENS,
  refreshOpenRouterCatalog,
  refreshOpenRouterMediaCatalog,
  verifyOpenRouterKey
} from './openrouter-catalog.js';

const NOW = new Date('2026-08-03T01:00:00.000Z');

/** Three measured models, one unmeasured, one measured only by the design arena. */
const modelsPayload = {
  data: [
    {
      id: 'z-ai/glm-5.2',
      context_length: 250_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.000001', completion: '0.000004' },
      supported_parameters: ['tools', 'reasoning'],
      benchmarks: {
        artificial_analysis: { intelligence_index: 40, coding_index: 50, agentic_index: 30 }
      }
    },
    {
      id: 'anthropic/claude-opus-5',
      name: 'Anthropic: Claude Opus 5',
      context_length: 1_000_000,
      architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
      pricing: {
        prompt: '0.000005',
        completion: '0.000025',
        input_cache_read: '0.0000005',
        input_cache_write: '0.00000625'
      },
      supported_parameters: ['tools', 'reasoning', 'reasoning_effort'],
      top_provider: { max_completion_tokens: 128_000 },
      knowledge_cutoff: '2026-02-16',
      benchmarks: {
        artificial_analysis: { intelligence_index: 60.7, coding_index: 78, agentic_index: 55.3 }
      }
    },
    {
      id: 'openai/gpt-5.6-terra',
      name: 'OpenAI: GPT-5.6 Terra',
      context_length: 500_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: {
        prompt: '0.000001',
        completion: '0.000006',
        input_cache_read: '0.0000001',
        input_cache_write: '0.00000125',
        overrides: [{ min_prompt_tokens: 200_000, prompt: '0.000002', completion: '0.000012' }]
      },
      supported_parameters: ['tools', 'reasoning_effort'],
      benchmarks: {
        artificial_analysis: { intelligence_index: 55, coding_index: 76.7, agentic_index: 47.4 }
      }
    },
    {
      id: 'unreviewed/new-model',
      context_length: 1_000_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] }
    },
    {
      id: 'designer/pixel-1',
      context_length: 128_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      benchmarks: {
        design_arena: [
          { arena: 'models', category: 'dataviz', elo: 1379, win_rate: 66.2, rank: 2 },
          { arena: 'agents', category: 'webapps', elo: 900, win_rate: 20, rank: 40 }
        ]
      }
    },
    {
      id: 'designer/pixel-0',
      context_length: 128_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      benchmarks: { design_arena: [{ arena: 'models', category: 'dataviz', elo: 1000, rank: 30 }] }
    },
    {
      id: '~anthropic/claude-opus-latest',
      name: 'Anthropic: Claude Opus (latest)',
      context_length: 1_000_000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: {
        prompt: '0.000005',
        completion: '0.000025',
        input_cache_read: '0.0000005',
        input_cache_write: '0.00000625'
      },
      supported_parameters: ['tools', 'reasoning'],
      alias_target: { name: 'Anthropic: Claude Opus 5', slug: 'anthropic/claude-opus-5' },
      benchmarks: null
    },
    {
      id: 'openai/gpt-5.3-chat',
      context_length: 128_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.0000005', completion: '0.0000015' },
      supported_parameters: ['tools'],
      expiration_date: '2026-08-10'
    },
    {
      id: 'black-forest-labs/flux-2',
      architecture: { input_modalities: ['text'], output_modalities: ['image'] }
    }
  ]
};

const zdrPayload = {
  data: [
    {
      model_id: 'z-ai/glm-5.2',
      status: 0,
      latency_last_30m: null,
      uptime_last_1d: 99.8,
      supports_implicit_caching: false
    },
    {
      model_id: 'anthropic/claude-opus-5',
      status: 0,
      latency_last_30m: null,
      uptime_last_1d: 99.99
    },
    { model_id: 'anthropic/claude-opus-5', status: 0, latency_last_30m: null, uptime_last_1d: 88 },
    { model_id: 'openai/gpt-5.6-terra', status: 0, latency_last_30m: 250, uptime_last_1d: 99.5 },
    { model_id: 'z-ai/glm-5.2', status: -2, latency_last_30m: null, uptime_last_1d: 12 }
  ]
};

const respondWith = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

const liveFetch = (options: { zdrStatus?: number } = {}) =>
  vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.split('?')[0]!.endsWith('/models')) return respondWith(modelsPayload);
    if (url.endsWith('/endpoints/zdr'))
      return options.zdrStatus && options.zdrStatus !== 200
        ? new Response('{"error":{"code":401}}', { status: options.zdrStatus })
        : respondWith(zdrPayload);
    throw new Error(`unexpected request to ${url}`);
  });

describe('OpenRouter live catalog', () => {
  it('reads the benchmarks that ship with the models response and asks for nothing else', async () => {
    const request = liveFetch();
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: request as typeof fetch,
      now: NOW
    });

    // The undocumented, user-scoped /benchmarks call is gone: two requests, both documented.
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.map(([input]) =>
        (input instanceof Request ? input.url : String(input)).replace(
          'https://openrouter.ai/api/v1',
          ''
        )
      )
    ).toEqual(['/models?output_modalities=all', '/endpoints/zdr']);
    expect(
      result.find((model) => model.providerModelId === 'anthropic/claude-opus-5')
    ).toBeDefined();
  });

  it('normalises quality to a percentile of the live catalogue instead of dividing an index by 100', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const opus = result.find((model) => model.providerModelId === 'anthropic/claude-opus-5');
    const terra = result.find((model) => model.providerModelId === 'openai/gpt-5.6-terra');
    const glm = result.find((model) => model.providerModelId === 'z-ai/glm-5.2');

    // The best model in the world scores 1.0, not 0.607, and the raw index is kept for display.
    expect(opus?.agenticQuality).toBe(1);
    expect(opus?.codingQuality).toBe(1);
    expect(opus?.intelligenceQuality).toBe(1);
    expect(opus?.agenticIndex).toBe(55.3);
    expect(opus?.intelligenceIndex).toBe(60.7);
    expect(opus?.benchmarkPopulation).toBe(3);
    expect(opus?.benchmarkRank).toBe(1);
    expect(opus?.benchmarkSource).toBe('artificial-analysis');

    expect(terra?.agenticQuality).toBeCloseTo(2 / 3, 3);
    expect(terra?.benchmarkRank).toBe(2);
    expect(glm?.agenticQuality).toBeCloseTo(1 / 3, 3);
    expect(glm?.benchmarkRank).toBe(3);

    // Every measured model now sits above the unmeasured prior of 0.4 except the weakest, which is
    // the point: the ordering is by measurement, not by the absence of it.
    const unmeasured = result.find((model) => model.providerModelId === 'unreviewed/new-model');
    expect(unmeasured?.measuredQuality).toBeNull();
    expect(unmeasured?.benchmarkRank).toBeNull();
  });

  it('uses a design-arena standing where it is the only measurement, bounded so it cannot outrank a hard eval', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const best = result.find((model) => model.providerModelId === 'designer/pixel-1');
    const worst = result.find((model) => model.providerModelId === 'designer/pixel-0');
    expect(best?.benchmarkSource).toBe('design-arena');
    expect(best?.measuredQuality).toBeCloseTo(0.8, 6);
    expect(worst?.measuredQuality).toBeCloseTo(0.6, 6);
    // No hard-eval column is invented from an arena placing, and it claims no rank in that table.
    expect(best?.agenticQuality).toBeNull();
    expect(best?.benchmarkRank).toBeNull();
    const opus = result.find((model) => model.providerModelId === 'anthropic/claude-opus-5');
    expect(best?.measuredQuality ?? 0).toBeLessThan(opus?.measuredQuality ?? 0);
  });

  it('resolves an alias to its target so the "latest" id is not a metadata-free duplicate', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const alias = result.find((model) => model.providerModelId === '~anthropic/claude-opus-latest');
    expect(alias?.intelligenceQuality).toBe(1);
    expect(alias?.intelligenceIndex).toBe(60.7);
    // ...and the tilde no longer hides an explicit-cache route from the breakpoint logic.
    expect(alias?.promptCacheStyle).toBe('explicit');
  });

  it('decides prompt caching from what the route charges, not from its vendor prefix', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const byId = new Map(result.map((model) => [model.providerModelId, model]));
    expect(byId.get('anthropic/claude-opus-5')?.promptCacheStyle).toBe('explicit');
    // The whole openai/gpt-5.6 family bills cache writes and used to be sent nothing at all.
    expect(byId.get('openai/gpt-5.6-terra')?.promptCacheStyle).toBe('explicit');
    expect(byId.get('openai/gpt-5.6-terra')?.cacheReadUsdPerMillionTokens).toBeCloseTo(0.1, 6);
    expect(byId.get('openai/gpt-5.6-terra')?.cacheWriteUsdPerMillionTokens).toBeCloseTo(1.25, 6);
    expect(byId.get('z-ai/glm-5.2')?.promptCacheStyle).toBe('none');
  });

  it('carries the fields that keep an unattended server working', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const byId = new Map(result.map((model) => [model.providerModelId, model]));
    const opus = byId.get('anthropic/claude-opus-5');
    expect(opus?.maxOutputTokens).toBe(128_000);
    expect(opus?.knowledgeCutoff).toBe('2026-02-16');
    expect(opus?.supportsReasoningEffort).toBe(true);
    expect(opus?.recommendationTags).toContain('Documents');
    // The worst endpoint decides, because the provider may route to it.
    expect(opus?.uptimeLast1dPercent).toBe(88);

    const retiring = byId.get('openai/gpt-5.3-chat');
    expect(retiring?.expiresAt).toBe('2026-08-10');
    expect(retiring?.recommendationTags).toContain('Retires 2026-08-10');
    expect(byId.get('z-ai/glm-5.2')?.recommendationTags).not.toContain('Retires 2026-08-10');

    const terra = byId.get('openai/gpt-5.6-terra');
    expect(terra?.priceTiers).toEqual([
      { minPromptTokens: 200_000, inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 12 }
    ]);
    // Scaling a per-token decimal by a million must land exactly on the published rate.
    expect(terra?.inputUsdPerMillionTokens).toBe(1);
    expect(terra?.outputUsdPerMillionTokens).toBe(6);
    // latency_last_30m is a scalar on the wire, not an object with a p50.
    expect(terra?.measuredLatencyMs).toBe(250);
    expect(opus?.measuredLatencyMs).toBeNull();
  });

  it('keeps prices and benchmarks when the endpoint feed fails, and carries the previous privacy flags', async () => {
    const previous: ModelRelease[] = [
      {
        ...seedModels(NOW)[1]!,
        id: 'openrouter/z-ai/glm-5.2',
        providerModelId: 'z-ai/glm-5.2',
        zeroDataRetentionAvailable: true,
        providerAvailable: true
      }
    ];
    const request = liveFetch({ zdrStatus: 401 });
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: request as typeof fetch,
      now: NOW,
      previous
    });

    // One 401 used to reject the whole Promise.all and blank the catalogue back to seeds.
    const opus = result.find((model) => model.providerModelId === 'anthropic/claude-opus-5');
    expect(opus?.inputUsdPerMillionTokens).toBe(5);
    expect(opus?.intelligenceQuality).toBe(1);
    // Nothing was verified, so nothing is claimed: the flag stays absent rather than becoming false.
    expect(opus?.zeroDataRetentionAvailable).toBeUndefined();
    // ...except where the previous refresh had an answer, which is carried forward.
    const glm = result.find((model) => model.id === 'openrouter/z-ai/glm-5.2');
    expect(glm?.zeroDataRetentionAvailable).toBe(true);
    expect(glm?.availability).toBe('available');
  });

  it('refuses a 200 that lists no models rather than answering with the allowlist alone', async () => {
    // The caller replaces the whole catalogue with this answer, so an answer of "just the seeds"
    // would delete every enriched model on the box with no failed request to account for it.
    await expect(
      refreshOpenRouterCatalog(seedModels(NOW), {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'registry-key',
        fetch: (async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })) as typeof fetch,
        now: NOW
      })
    ).rejects.toMatchObject({ code: 'provider_catalog_empty' });
  });

  it('still fails when the model list itself cannot be read, because there is no catalogue without it', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.split('?')[0]!.endsWith('/models')) return new Response('nope', { status: 500 });
      return respondWith(zdrPayload);
    });
    await expect(
      refreshOpenRouterCatalog(seedModels(NOW), {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'registry-key',
        fetch: request as typeof fetch,
        now: NOW
      })
    ).rejects.toThrow('OpenRouter models returned 500');
  });

  it('never expands the reviewed allowlist in strict scope and requires a live ZDR endpoint', async () => {
    const reviewed = seedModels(NOW);
    const result = await refreshOpenRouterCatalog(reviewed, {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW,
      scope: 'reviewed_open_weight'
    });
    expect(result).toHaveLength(reviewed.length);
    expect(result.some((model) => model.providerModelId === 'unreviewed/new-model')).toBe(false);
    expect(result.find((model) => model.providerModelId === 'z-ai/glm-5.2')).toMatchObject({
      availability: 'available',
      contextTokens: 250_000,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 4,
      providerAvailable: true,
      zeroDataRetentionAvailable: true
    });
    expect(
      result
        .filter((model) => model.providerModelId !== 'z-ai/glm-5.2')
        .every((model) => model.availability === 'unavailable')
    ).toBe(true);
  });

  /*
   * Strict scope's fail-closed contract, tested on a condition that can actually occur.
   *
   * This used to read the clock forward to a review's `reviewExpiresAt` and assert the model went
   * to `review` on that day. Reviews no longer expire - a published licence is a fact about a
   * published artefact, not a subscription - so what remains is the disagreement the review exists
   * to catch: the catalogue declaring one licence while the manifest reviewed another. That is what
   * a relicensing upstream looks like from here, and unlike a date it is a real event.
   */
  it('fails closed in strict scope when the catalogue declares a licence the review does not confirm', async () => {
    const relicensed = seedModels().map((model) =>
      model.providerModelId === 'z-ai/glm-5.2'
        ? { ...model, license: 'Apache-2.0' as const }
        : model
    );
    expect(currentCommercialLicenseReview('z-ai/glm-5.2', 'MIT')).toBeDefined();
    expect(currentCommercialLicenseReview('z-ai/glm-5.2', 'Apache-2.0')).toBeUndefined();

    const result = await refreshOpenRouterCatalog(relicensed, {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW,
      scope: 'reviewed_open_weight'
    });
    const glm = result.find((model) => model.providerModelId === 'z-ai/glm-5.2');
    expect(glm?.availability).toBe('review');
    expect(glm?.providerAvailable).toBe(false);
  });

  it('offers the provider catalogue by default so new models need no code change', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });

    const claude = result.find((model) => model.providerModelId === 'anthropic/claude-opus-5');
    expect(claude).toMatchObject({
      id: 'openrouter/anthropic/claude-opus-5',
      displayName: 'Claude Opus 5',
      availability: 'available',
      openness: 'remote_proprietary',
      commercialUse: true,
      usageClass: 'high',
      contextTokens: 1_000_000,
      zeroDataRetentionAvailable: true
    });
    expect(claude?.capabilities).toEqual(
      expect.arrayContaining(['chat', 'tools', 'vision', 'reasoning'])
    );
    expect(claude?.recommendationTags).toEqual(
      expect.arrayContaining(['Tools', 'Reasoning', 'Vision', 'Long context'])
    );
    // A media-only route is not a chat model and must not reach the model picker.
    expect(result.some((model) => model.providerModelId === 'black-forest-labs/flux-2')).toBe(
      false
    );
    // The reviewed seed keeps its open-weight badge and its live ZDR route.
    expect(result.find((model) => model.providerModelId === 'z-ai/glm-5.2')).toMatchObject({
      openness: 'permissive_open_weight',
      availability: 'available',
      zeroDataRetentionAvailable: true
    });
  });

  it('records only the modalities it can actually put in front of a model', async () => {
    const omniFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/endpoints/zdr')) return respondWith(zdrPayload);
      return respondWith({
        data: [
          {
            id: 'qwen/qwen3.6-omni',
            name: 'Qwen: Qwen 3.6 Omni',
            context_length: 131_072,
            architecture: {
              input_modalities: ['text', 'image', 'audio', 'video'],
              output_modalities: ['text']
            },
            pricing: { prompt: '0.0000005', completion: '0.000002' },
            supported_parameters: ['tools']
          }
        ]
      });
    });

    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: omniFetch as typeof fetch,
      now: NOW
    });

    const omni = result.find((model) => model.providerModelId === 'qwen/qwen3.6-omni');
    expect(omni?.modalities).toEqual(['text', 'image', 'audio', 'video']);
    expect(omni?.nativeInputPricing).toEqual({
      audioUsdPerMillionTokens: null,
      videoUsdPerMillionTokens: null
    });
    // The picture half is not collateral damage: a model that takes images still says so.
    expect(omni?.capabilities).toContain('vision');
  });

  /*
   * The other half of the same contract: outside strict scope an unreviewed model is still offered,
   * it just does not get to claim open weights. Degrading the claim rather than withdrawing the
   * model is what keeps the default catalogue usable, and it is the arm that would silently stop
   * mattering if the reviewed set ever covered everything.
   */
  it('keeps a model whose review does not confirm its licence selectable, without the open-weight claim', async () => {
    const relicensed = seedModels().map((model) =>
      model.providerModelId === 'z-ai/glm-5.2'
        ? { ...model, license: 'Apache-2.0' as const }
        : model
    );
    const result = await refreshOpenRouterCatalog(relicensed, {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });

    expect(result.find((model) => model.providerModelId === 'z-ai/glm-5.2')).toMatchObject({
      availability: 'available',
      openness: 'remote_proprietary',
      license: 'provider-hosted'
    });
  });

  /*
   * Two columns describing one fact, and they used to disagree.
   *
   * `privacyRoute` was the literal `'provider_zdr'` on every live entry, written three lines below
   * the honest per-model answer the endpoint feed had just produced. So a model the provider serves
   * from no zero-retention endpoint at all was stored as `zeroDataRetentionAvailable: false` *and*
   * `privacyRoute: 'provider_zdr'`, and `privacyRoute` is the routing input - it is what
   * `isPrivacyRouteEligible` matches on and what the worker's delegate picker compares a task
   * against. That picker reads the catalogue raw and checks the route alone, so on a zero-retention
   * task the strongest specialist available was chosen from models with no private route.
   */
  it('offers a model on the zero-retention route only where the endpoint feed found one', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const byId = new Map(result.map((model) => [model.providerModelId, model]));

    // Served by a live ZDR endpoint, so the route it is offered on is the private one.
    expect(byId.get('openai/gpt-5.6-terra')).toMatchObject({
      zeroDataRetentionAvailable: true,
      privacyRoute: 'provider_zdr'
    });
    // No ZDR endpoint in the feed. The two columns now say the same thing.
    expect(byId.get('unreviewed/new-model')).toMatchObject({
      zeroDataRetentionAvailable: false,
      privacyRoute: 'external'
    });
    expect(byId.get('designer/pixel-1')?.privacyRoute).toBe('external');
  });

  /*
   * Unknown is not false, here as everywhere else in this file. With the endpoint feed unread the
   * flag is left absent, and `isPrivacyRouteEligible` and `usableCapabilities` both admit an absent
   * flag on the private route deliberately - so nothing new may be claimed here and nothing already
   * offered may be withdrawn on the strength of one failed request.
   */
  it('claims nothing new about the route when the endpoint feed could not be read', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch({ zdrStatus: 401 }) as typeof fetch,
      now: NOW
    });
    const unknown = result.find((model) => model.providerModelId === 'unreviewed/new-model');
    expect(unknown?.zeroDataRetentionAvailable).toBeUndefined();
    expect(unknown?.privacyRoute).toBe('provider_zdr');
  });

  it('keeps non-ZDR models visible but unavailable until the owner permits provider policy', () => {
    const model = {
      ...seedModels()[0]!,
      availability: 'unavailable' as const,
      providerAvailable: true,
      zeroDataRetentionAvailable: false
    };
    expect(applyOpenRouterPrivacyPolicy(model, true)).toMatchObject({
      privacyRoute: 'provider_zdr',
      availability: 'unavailable'
    });
    expect(applyOpenRouterPrivacyPolicy(model, false)).toMatchObject({
      privacyRoute: 'external',
      availability: 'available'
    });
  });
});

/*
 * "Verify and save" verified nothing about the key. Both routes the refresh reads are public - they
 * answer 200 to a request carrying no credential at all - so a mistyped key, a revoked key and a
 * spent-out account each produced a green success message on the settings screen and a raw 401 in
 * the middle of the owner's next task.
 */
describe('checking the key before it is saved', () => {
  /** The last credential the stub was handed, so the request can be shown to carry it. */
  let sent: string | undefined;
  const keyFetch = (status: number, body: unknown = {}) =>
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith('/key')) throw new Error(`unexpected request to ${url}`);
      sent = (init?.headers as Record<string, string> | undefined)?.authorization;
      return new Response(JSON.stringify(body), { status });
    });

  it('asks the one route the provider gates, carrying the key', async () => {
    const request = keyFetch(200, { data: { label: 'athanor', limit_remaining: 12.5 } });
    await expect(
      verifyOpenRouterKey({
        baseUrl: 'https://openrouter.ai/api/v1/',
        apiKey: 'sk-or-real',
        fetch: request as typeof fetch
      })
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(sent).toBe('Bearer sk-or-real');
  });

  /** The refusal itself, so the copy an owner reads can be asserted rather than only its code. */
  const refusal = async (status: number, body?: unknown): Promise<AthanorError> => {
    try {
      await verifyOpenRouterKey({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-doubtful',
        fetch: keyFetch(status, body) as typeof fetch
      });
    } catch (cause) {
      return cause as AthanorError;
    }
    throw new Error('the key was accepted');
  };

  it('refuses a key the provider rejects, and names what causes it', async () => {
    const error = await refusal(401);
    expect(error.code).toBe('provider_key_rejected');
    expect(error.message).toContain('trailing space');
    expect(error.statusCode).toBe(422);
  });

  it('refuses a working key with nothing left to spend, rather than saving a 401 for later', async () => {
    const error = await refusal(200, { data: { limit_remaining: 0 } });
    expect(error.code).toBe('provider_credit_exhausted');
    expect(error.message).toContain('Add credit');
  });

  // A key with no spend limit set reports null here. Unknown is not empty, and refusing on it would
  // lock the owner out of their own settings screen over a field the provider never filled in.
  it('accepts a key whose remaining balance the provider does not state', async () => {
    await expect(
      verifyOpenRouterKey({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-real',
        fetch: keyFetch(200, { data: { limit_remaining: null } }) as typeof fetch
      })
    ).resolves.toBeUndefined();
  });

  it('saves nothing when the provider could not be asked at all', async () => {
    const error = await refusal(503);
    expect(error.code).toBe('provider_key_uncheckable');
    expect(error.statusCode).toBe(502);
  });
});

describe('benchmark populations', () => {
  /**
   * The three columns do not cover the same models. A live catalogue read on 2026-08-03 carried 117
   * coding scores, 108 agentic and 107 intelligence, so a percentile that borrows the largest count
   * tells the owner a number that never measured the column being reported.
   */
  const unevenColumns = {
    data: [
      {
        id: 'vendor/all-three',
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000004' },
        benchmarks: {
          artificial_analysis: { intelligence_index: 60, coding_index: 78, agentic_index: 55 }
        }
      },
      {
        id: 'vendor/coding-only-high',
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000004' },
        benchmarks: { artificial_analysis: { coding_index: 70 } }
      },
      {
        id: 'vendor/coding-only-low',
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000004' },
        benchmarks: { artificial_analysis: { coding_index: 10 } }
      }
    ]
  };

  it('counts each benchmark column separately, because they measure different models', async () => {
    const result = await refreshOpenRouterCatalog([], {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.split('?')[0]!.endsWith('/models')) return respondWith(unevenColumns);
        return respondWith({ data: [] });
      }) as typeof fetch,
      now: NOW
    });

    const all = result.find((model) => model.providerModelId === 'vendor/all-three');
    expect(all?.benchmarkPopulations).toEqual({ coding: 3, agentic: 1, intelligence: 1 });
    // The single number stays the widest column, which is the population behind the overall score.
    expect(all?.benchmarkPopulation).toBe(3);
    // ...and the percentiles are computed within each column, not against a pooled distribution.
    expect(all?.codingQuality).toBe(1);
    expect(all?.agenticQuality).toBe(1);
    const partial = result.find((model) => model.providerModelId === 'vendor/coding-only-high');
    expect(partial?.codingQuality).toBeCloseTo(2 / 3, 3);
    expect(partial?.agenticQuality).toBeNull();
    expect(partial?.benchmarkPopulations).toEqual({ coding: 3, agentic: 1, intelligence: 1 });
  });

  it('claims no hard-eval column for a model measured only by the arena', async () => {
    const result = await refreshOpenRouterCatalog([], {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    expect(
      result.find((model) => model.providerModelId === 'designer/pixel-1')?.benchmarkPopulations
    ).toBeNull();
    expect(
      result.find((model) => model.providerModelId === 'unreviewed/new-model')?.benchmarkPopulations
    ).toBeNull();
  });
});

/*
 * Nothing arriving from the provider used to be bounded on the way in.
 *
 * `contextTokens` was `context_length` or a 128,000 default, `maxOutputTokens` was whatever
 * `top_provider.max_completion_tokens` said, and `perMillion` refused only negatives and
 * non-finites. Every one of those numbers is read by something that acts on it: the context builder
 * packs a window to `contextTokens` and subtracts `maxOutputTokens` from it, and a price decides
 * both the model's usage class and whether the owner's spending ceiling lets it be picked at all.
 * A single mistyped figure in a feed nobody here controls therefore reached the arithmetic intact.
 */
describe('bounds on what the feed is allowed to say', () => {
  /** One entry per way the feed can state a number that cannot be true. */
  const unbelievable = {
    data: [
      {
        id: 'vendor/impossible-window',
        name: 'Vendor: Impossible Window',
        context_length: 100_000_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000004' },
        supported_parameters: ['tools']
      },
      {
        id: 'vendor/no-window',
        name: 'Vendor: No Window',
        context_length: 0,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000004' },
        supported_parameters: ['tools']
      },
      {
        id: 'vendor/reply-longer-than-window',
        name: 'Vendor: Reply Longer Than Window',
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000004' },
        supported_parameters: ['tools'],
        top_provider: { max_completion_tokens: 900_000_000 }
      },
      {
        id: 'vendor/zero-reply',
        name: 'Vendor: Zero Reply',
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000004' },
        supported_parameters: ['tools'],
        top_provider: { max_completion_tokens: 0 }
      },
      {
        /* A per-token decimal published as a whole number: one million dollars per million tokens. */
        id: 'vendor/priced-per-million-by-mistake',
        name: 'Vendor: Priced By Mistake',
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '1', completion: '4' },
        supported_parameters: ['tools']
      },
      {
        /* The route itself is priced sanely; the tier it grows into is not. */
        id: 'vendor/absurd-tier',
        name: 'Vendor: Absurd Tier',
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: {
          prompt: '0.000001',
          completion: '0.000004',
          overrides: [{ min_prompt_tokens: 100_000, prompt: '2', completion: '9' }]
        },
        supported_parameters: ['tools']
      }
    ]
  };

  /** The second feed, so both halves of the refresh are exercised by these fixtures. */
  const unbelievableZdr = {
    data: [
      {
        model_id: 'vendor/impossible-window',
        status: 0,
        latency_last_30m: null,
        uptime_last_1d: 99.1
      },
      { model_id: 'vendor/no-window', status: 0, latency_last_30m: null, uptime_last_1d: 99.1 },
      {
        model_id: 'vendor/reply-longer-than-window',
        status: 0,
        latency_last_30m: null,
        uptime_last_1d: 99.1,
        max_completion_tokens: 900_000_000
      },
      {
        model_id: 'vendor/priced-per-million-by-mistake',
        status: 0,
        latency_last_30m: null,
        uptime_last_1d: 99.1
      }
    ]
  };

  const boundedFetch = () =>
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.split('?')[0]!.endsWith('/models')) return respondWith(unbelievable);
      return respondWith(unbelievableZdr);
    });

  const refresh = async (allowlist: ModelRelease[] = []) =>
    refreshOpenRouterCatalog(allowlist, {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: boundedFetch() as typeof fetch,
      now: NOW
    });

  it('clamps a context window too large to be true, and falls back where the feed states none', async () => {
    const byId = new Map((await refresh()).map((model) => [model.providerModelId, model]));
    // A hundred million tokens is not a window; the context builder would pack against it.
    expect(byId.get('vendor/impossible-window')?.contextTokens).toBe(MAX_CREDIBLE_CONTEXT_TOKENS);
    // Zero is not a window either, and the contract refuses it: `contextTokens` is a positive int,
    // so this row used to be dropped by the parse at the API boundary rather than corrected here.
    expect(byId.get('vendor/no-window')?.contextTokens).toBe(128_000);
  });

  it('never lets the stated reply length exceed the window the reply is written into', async () => {
    const byId = new Map((await refresh()).map((model) => [model.providerModelId, model]));
    // `modelInputBudget` subtracts this from the window. Left alone it made the budget negative.
    expect(byId.get('vendor/reply-longer-than-window')?.maxOutputTokens).toBe(200_000);
    // A stated zero is not a limit, it is the absence of one.
    expect(byId.get('vendor/zero-reply')?.maxOutputTokens).toBeNull();
  });

  it('leaves out a route whose stated price cannot be a price, and says so once in the journal', async () => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const ids = (await refresh()).map((model) => model.providerModelId);
      // Kept out rather than kept with a null price: a null price reads as "unpriced", which
      // `usageClassForPrice` calls 'medium' and the owner's ceiling waves straight through - so
      // believing nothing about the number would have made the absurd route look like a cheap one.
      expect(ids).not.toContain('vendor/priced-per-million-by-mistake');
      expect(ids).not.toContain('vendor/absurd-tier');
      expect(ids).toContain('vendor/impossible-window');
    } finally {
      stderr.mockRestore();
    }
    // One line for the whole refresh, naming the routes. This service has no listener and no
    // metrics endpoint; a route that silently stopped being offered is otherwise unaccountable.
    const journal = written.filter((line) => line.includes('model catalogue'));
    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain('vendor/priced-per-million-by-mistake');
    expect(journal[0]).toContain('vendor/absurd-tier');
  });

  it('refuses the absurd price without withdrawing a reviewed model from the catalogue', async () => {
    const reviewed = seedModels(NOW).map((model) => ({
      ...model,
      providerModelId: 'vendor/priced-per-million-by-mistake'
    }));
    const result = await refresh([reviewed[0]!]);
    const curated = result.find((model) => model.id === reviewed[0]!.id);
    // The allowlist is the curated set; dropping one of four would empty the strict catalogue. So
    // here the price is refused rather than the entry, and the usage class stays the seed's own.
    expect(curated).toBeDefined();
    expect(curated?.inputUsdPerMillionTokens).toBeNull();
    expect(curated?.usageClass).toBe(reviewed[0]!.usageClass);
  });

  it('says nothing in the journal when every stated price is believable', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await refreshOpenRouterCatalog(seedModels(NOW), {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'registry-key',
        fetch: liveFetch() as typeof fetch,
        now: NOW
      });
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('the media catalogue the chat refresh throws away', () => {
  it('offers the generators the owner is paying for, which had existed nowhere before', async () => {
    const options = await refreshOpenRouterMediaCatalog({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'owner-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const live = options.find((entry) => entry.providerModelId === 'black-forest-labs/flux-2');
    expect(live?.modality).toBe('image');
    // No chat model gets in: a model that can answer with text belongs in the composer's picker,
    // whatever else it can also emit.
    expect(options.some((entry) => entry.providerModelId === 'z-ai/glm-5.2')).toBe(false);
  });

  it('says a live model’s price is unpublished rather than borrowing the default’s', async () => {
    const options = await refreshOpenRouterMediaCatalog({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'owner-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const live = options.find((entry) => entry.providerModelId === 'black-forest-labs/flux-2');
    // There is no field in this feed that this repository can point at for dollars per image, and a
    // number under a control the owner is about to trust must not be a guess. The worker turns this
    // admission into an approval card on every generation from that route.
    expect(live).toMatchObject({ priceSource: 'unknown', usdPerImage: null });
    const reviewed = options.find((entry) => entry.priceSource === 'measured');
    expect(reviewed?.usdPerImage).toBeGreaterThan(0);
  });

  it('says when the reviewed route is one this account cannot reach', async () => {
    const options = await refreshOpenRouterMediaCatalog({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'owner-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    // Said here rather than at the moment a generation fails mid-task.
    expect(options.filter((entry) => entry.priceSource === 'measured')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unavailableReason: 'this provider account does not list it' })
      ])
    );
  });

  it('withholds a model with no private endpoint only when private routes were demanded', async () => {
    const request = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'owner-key', now: NOW };
    const relaxed = await refreshOpenRouterMediaCatalog({
      ...request,
      fetch: liveFetch() as typeof fetch
    });
    const strict = await refreshOpenRouterMediaCatalog({
      ...request,
      fetch: liveFetch() as typeof fetch,
      requireZeroDataRetention: true
    });
    const of = (all: typeof relaxed) =>
      all.find((entry) => entry.providerModelId === 'black-forest-labs/flux-2');
    expect(of(relaxed)?.unavailableReason).toBeUndefined();
    expect(of(strict)?.unavailableReason).toBe('no verified private route');
  });

  /**
   * The pricing block this path used to throw away, and what reading it settles.
   *
   * The importer had never looked at it, and tagged every live entry "Price not published" on the
   * strength of not having looked. It is there, and it is per-token on both fields the importer
   * parses - which converts to dollars per minute for nothing. So no price is set, and the two
   * facts the old tag ran together are now told apart.
   */
  const pricedInTokens = {
    data: [
      {
        id: 'vendor/hears-1',
        name: 'Vendor: Hears 1',
        architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] },
        pricing: { prompt: '0.000001', completion: '0.000004' }
      },
      {
        id: 'vendor/draws-1',
        architecture: { input_modalities: ['text'], output_modalities: ['image'] }
      }
    ]
  };

  it('reads the pricing block rather than claiming the provider published nothing', async () => {
    const options = await refreshOpenRouterMediaCatalog({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'owner-key',
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.split('?')[0]!.endsWith('/models')) return respondWith(pricedInTokens);
        return respondWith({ data: [] });
      }) as typeof fetch,
      now: NOW
    });

    const hears = options.find((entry) => entry.providerModelId === 'vendor/hears-1');
    // The feed's own word for a model that reads a recording, which is what separates it from a
    // chat model that merely accepts audio in a conversation.
    expect(hears?.modality).toBe('transcription');
    // Raw prompt/completion fields carry no billing-unit discriminator for STT.
    expect(hears).toMatchObject({
      priceSource: 'unknown',
      usdPerMinute: null,
      zeroDataRetentionAvailable: false,
      requiresRetentionApproval: true
    });
    expect(hears?.recommendationTags).toEqual(['External transcription requires approval']);
    const draws = options.find((entry) => entry.providerModelId === 'vendor/draws-1');
    expect(draws?.recommendationTags).toEqual(['No per-image price published']);
  });

  it('does not withdraw private media routes on the strength of one failed request', async () => {
    const options = await refreshOpenRouterMediaCatalog({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'owner-key',
      fetch: liveFetch({ zdrStatus: 500 }) as typeof fetch,
      requireZeroDataRetention: true,
      now: NOW
    });
    // Unknown is not false. With the endpoint feed unread, nothing is claimed either way, and the
    // owner keeps a picker rather than losing every media route to an outage.
    const live = options.find((entry) => entry.providerModelId === 'black-forest-labs/flux-2');
    expect(live?.zeroDataRetentionAvailable).toBeUndefined();
    expect(live?.unavailableReason).toBeUndefined();
  });
});

/*
 * The feed is a document from a service nobody here controls, and until `readOpenRouterModels` was
 * put in front of it the parser read that document through a TypeScript interface alone - which
 * describes what the wire was expected to hold and checks nothing at run time.
 *
 * Every fixture below was measured against the parser as it stood. The first four threw a raw
 * TypeError out of `refreshOpenRouterCatalog` itself, so one reshaped field cost the owner the
 * whole refresh rather than costing one model one capability, and the sentence they read in
 * `athanor doctor` was "object is not iterable". The fifth cost a million-token model 87% of its
 * window without throwing anything at all, which is worse, because nothing said so.
 */
describe('a feed that changed shape underneath the parser', () => {
  const feedOf = (rows: unknown[]) =>
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.split('?')[0]!.endsWith('/models')) return respondWith({ data: rows });
      return respondWith({ data: [] });
    }) as unknown as typeof fetch;

  /** One well-formed row, so every reshape below is the only thing wrong with its feed. */
  const wellFormed = {
    id: 'vendor/steady',
    name: 'Vendor: Steady',
    context_length: 200_000,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    pricing: {
      prompt: '0.000001',
      completion: '0.000004',
      overrides: [{ min_prompt_tokens: 100_000, prompt: '0.000002', completion: '0.000008' }]
    },
    supported_parameters: ['tools', 'reasoning']
  };

  /** The refresh, with the journal captured rather than written to the test runner's output. */
  const refresh = async (rows: unknown[]) => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const models = await refreshOpenRouterCatalog([], {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'registry-key',
        fetch: feedOf(rows),
        now: NOW
      });
      return {
        byId: new Map(models.map((model) => [model.providerModelId, model])),
        journal: written.filter((line) => line.includes('model catalogue'))
      };
    } finally {
      stderr.mockRestore();
    }
  };

  it('keeps the row when supported_parameters arrives as an object instead of a list', async () => {
    // Measured before the narrowing existed: TypeError: object is not iterable, thrown out of
    // `enrich` and up through the whole refresh, so every other model in the feed went with it.
    const { byId, journal } = await refresh([
      { ...wellFormed, supported_parameters: { tools: true } },
      { ...wellFormed, id: 'vendor/bystander' }
    ]);
    const reshaped = byId.get('vendor/steady');
    expect(reshaped).toBeDefined();
    // The row loses exactly the field that could not be read, and nothing else it stated.
    expect(reshaped?.capabilities).toEqual(['chat', 'vision']);
    expect(reshaped?.recommendationTags).toEqual(['Vision']);
    expect(reshaped?.contextTokens).toBe(200_000);
    expect(reshaped?.inputUsdPerMillionTokens).toBeCloseTo(1, 6);
    // ...and the model that was standing next to it in the same document is untouched.
    expect(byId.get('vendor/bystander')?.capabilities).toEqual([
      'chat',
      'tools',
      'vision',
      'reasoning'
    ]);
    // Nothing was dropped, so there is nothing for the journal to account for.
    expect(journal).toEqual([]);
  });

  it('keeps the row when architecture.input_modalities arrives as an object', async () => {
    const { byId, journal } = await refresh([
      {
        ...wellFormed,
        architecture: { input_modalities: { text: true, image: true }, output_modalities: ['text'] }
      }
    ]);
    const reshaped = byId.get('vendor/steady');
    expect(reshaped).toBeDefined();
    // Unreadable is not "no image": it is "the feed did not say", which is what an absent field
    // already meant here, and the picker offers text alone rather than an image route nobody stated.
    expect(reshaped?.modalities).toEqual(['text']);
    expect(reshaped?.capabilities).toEqual(['chat', 'tools', 'reasoning']);
    expect(reshaped?.contextTokens).toBe(200_000);
    expect(journal).toEqual([]);
  });

  it('keeps the row when pricing.overrides arrives as an object', async () => {
    // Measured: TypeError: ((intermediate value) ?? []).flatMap is not a function, thrown out of
    // `pricedAbsurdly` - which is the guard that decides whether the route is offered at all.
    const { byId, journal } = await refresh([
      { ...wellFormed, pricing: { ...wellFormed.pricing, overrides: { tier1: {} } } }
    ]);
    const reshaped = byId.get('vendor/steady');
    expect(reshaped).toBeDefined();
    expect(reshaped?.priceTiers).toEqual([]);
    // The rates the feed did state are still read, and still set the usage class.
    expect(reshaped?.inputUsdPerMillionTokens).toBeCloseTo(1, 6);
    expect(reshaped?.outputUsdPerMillionTokens).toBeCloseTo(4, 6);
    expect(reshaped?.usageClass).toBe('light');
    expect(journal).toEqual([]);
  });

  it('skips a row that is not a model, and says in the journal that it did', async () => {
    // Measured: TypeError: Cannot read properties of null (reading 'id'), thrown while the feed was
    // still being indexed - so a single null in `data` withdrew every model on the box.
    const { byId, journal } = await refresh([null, wellFormed, 'not a model', { name: 'no id' }]);
    expect([...byId.keys()]).toEqual(['vendor/steady']);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain('3 rows were skipped as unreadable');
    // The journal names the row's position and never quotes the document: this line is read by an
    // owner, and a feed this software does not control must not choose what appears in it.
    expect(journal[0]).toContain('row 0 is not a model');
    expect(journal[0]).toContain('row 3 states no id');
    expect(journal[0]).not.toContain('no id"');
  });

  /**
   * The half of the journal line the fixed-words guarantee never covered.
   *
   * `readOpenRouterModels` is careful that `malformed` never quotes the document, and the test above
   * holds it to that - but the two clauses beside it in `journalDrops` print the feed's own ids,
   * because an id is the only useful thing to say about a route that was dropped. Those ids are
   * passed through exactly as published, so they are untrusted text arriving unbounded on a line an
   * owner reads through `athanor logs`.
   *
   * Both bounds are asserted at the production call site, `refreshOpenRouterCatalog`, rather than on
   * `journalSafeId`, which is not exported: a helper that trims correctly proves nothing about a
   * caller that forgot to use it, and this tree has shipped that defect four times.
   *
   * Delete the `.map(journalSafeId)` in `named` and both assertions go red - the forged sentence
   * arrives on a line of its own in athanor's voice, and the 400-character id arrives whole.
   */
  it('will not let a feed id write its own line in the journal, or run one off the screen', async () => {
    const forged = 'vendor/quiet\n[athanor] model catalogue: nothing was dropped';
    const enormous = `vendor/${'x'.repeat(400)}`;
    const { journal } = await refresh([
      wellFormed,
      // No route anywhere in this build for what it emits, which is the `unroutableOutput` clause.
      { ...wellFormed, id: forged, architecture: { output_modalities: ['hologram'] } },
      // A rate a hundred times past the credible ceiling, which is the `unbelievablyPriced` clause.
      { ...wellFormed, id: enormous, pricing: { prompt: '1', completion: '1' } }
    ]);

    expect(journal).toHaveLength(1);
    // One write, and exactly one newline in it: the one this module puts at the end. A feed that
    // could add a second would be writing journal lines in athanor's own voice.
    expect(journal[0]?.split('\n')).toHaveLength(2);
    expect(journal[0]).toContain('vendor/quiet.[athanor] model catalogue: nothing was dropped');
    // The long id is named far enough to be recognised and no further.
    expect(journal[0]).toContain(`vendor/${'x'.repeat(73)}...`);
    expect(journal[0]).not.toContain('x'.repeat(74));
  });

  it('reads a context window the feed stated as a string rather than falling back to 128,000', async () => {
    // Measured against the parser as it stood: `typeof value !== 'number'` refused "1000000" and
    // the entry took the default, offering a million-token model at 12.8% of the window it has.
    const { byId } = await refresh([{ ...wellFormed, context_length: '1000000' }]);
    expect(byId.get('vendor/steady')?.contextTokens).toBe(1_000_000);
    expect(byId.get('vendor/steady')?.recommendationTags).toContain('Long context');
  });

  it('leaves the catalogue as it was when no row in the document can be read', async () => {
    // The backstop, unchanged: a document with nothing usable in it is an outage wearing a 200, and
    // the refresh refuses it rather than replacing a live catalogue with the seeds alone.
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        refreshOpenRouterCatalog([], {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'registry-key',
          fetch: feedOf([null, null]),
          now: NOW
        })
      ).rejects.toMatchObject({ code: 'provider_catalog_empty' });
    } finally {
      stderr.mockRestore();
    }
  });
});

/*
 * The other direction, which is the one that decides whether this is a bound or an outage. A feed
 * is allowed to grow: new modalities, new parameters, new ways of charging. None of these is
 * malformed, none of them may cost a model its entry, and none of them may put a line in a journal
 * an owner is meant to be able to trust as a list of things that went wrong.
 */
describe('shapes the feed is allowed to grow', () => {
  const feedOf = (rows: unknown[]) =>
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.split('?')[0]!.endsWith('/models')) return respondWith({ data: rows });
      return respondWith({ data: [] });
    }) as unknown as typeof fetch;

  const refresh = async (rows: unknown[]) => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      const models = await refreshOpenRouterCatalog([], {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'registry-key',
        fetch: feedOf(rows),
        now: NOW
      });
      return {
        byId: new Map(models.map((model) => [model.providerModelId, model])),
        journal: written.filter((line) => line.includes('model catalogue'))
      };
    } finally {
      stderr.mockRestore();
    }
  };

  const grown = {
    id: 'vendor/grown',
    context_length: 200_000,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000004' },
    supported_parameters: ['tools', 'reasoning']
  };

  it('preserves supported native input modalities from the feed', async () => {
    const { byId, journal } = await refresh([
      {
        ...grown,
        architecture: {
          input_modalities: ['text', 'image', 'video'],
          output_modalities: ['text']
        }
      }
    ]);
    expect(byId.get('vendor/grown')?.modalities).toEqual(['text', 'image', 'video']);
    expect(byId.get('vendor/grown')?.capabilities).toEqual([
      'chat',
      'tools',
      'vision',
      'reasoning'
    ]);
    expect(journal).toEqual([]);
  });

  it('accepts a supported parameter this build has never heard of', async () => {
    const { byId, journal } = await refresh([
      { ...grown, supported_parameters: ['tools', 'reasoning', 'thinking_budget'] }
    ]);
    expect(byId.get('vendor/grown')?.capabilities).toEqual([
      'chat',
      'tools',
      'vision',
      'reasoning'
    ]);
    expect(byId.get('vendor/grown')?.supportsReasoningEffort).toBe(false);
    expect(journal).toEqual([]);
  });

  it('accepts a pricing block that charges per request rather than per token', async () => {
    const { byId, journal } = await refresh([
      { ...grown, pricing: { request: '0.01', image: '0.04', web_search: '0.004' } }
    ]);
    const priced = byId.get('vendor/grown');
    expect(priced).toBeDefined();
    // Nothing this catalogue can convert is stated, so nothing is claimed - and the route is kept,
    // because a rate in a unit this software cannot read is not a rate it has grounds to disbelieve.
    expect(priced?.inputUsdPerMillionTokens).toBeNull();
    expect(priced?.outputUsdPerMillionTokens).toBeNull();
    expect(priced?.usageClass).toBe('medium');
    expect(journal).toEqual([]);
  });

  it('offers the same entries for a well-formed feed as it did before the narrowing existed', async () => {
    const models = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    // The whole live fixture in one line per entry. It was compared byte for byte against the same
    // fixture's output before `readOpenRouterModels` was put in front of the feed, and this is what
    // stops a later change to the narrowing quietly moving a window, a price or a capability.
    expect(
      models
        .map(
          (model) =>
            `${model.providerModelId} ${model.contextTokens} ${model.usageClass} ` +
            `[${model.capabilities.join(',')}] [${model.recommendationTags.join(',')}]`
        )
        .sort()
    ).toEqual([
      'anthropic/claude-opus-5 1000000 high [chat,tools,vision,reasoning] [Tools,Reasoning,Vision,Documents,Long context]',
      'deepseek/deepseek-v4-flash 1000000 light [chat] [Fast default,Efficient,Included]',
      'designer/pixel-0 128000 medium [chat] []',
      'designer/pixel-1 128000 medium [chat] []',
      'openai/gpt-5.3-chat 128000 light [chat,tools] [Tools,Retires 2026-08-10]',
      'openai/gpt-5.6-terra 500000 light [chat,tools] [Tools,Long context]',
      'openai/gpt-oss-120b 131072 medium [chat] [Reliable reasoning,Tools,Included]',
      'qwen/qwen3.6-35b-a3b 262144 medium [chat] [Vision specialist,Screenshots and images,Included]',
      'unreviewed/new-model 1000000 medium [chat] [Long context]',
      'z-ai/glm-5.2 250000 high [chat,tools,reasoning] [Best for long agent work,Coding,Included]',
      '~anthropic/claude-opus-latest 1000000 high [chat,tools,vision,reasoning] [Tools,Reasoning,Vision,Long context]'
    ]);
  });
});

/*
 * The one drop in this file that used to happen in complete silence.
 *
 * A model whose output is neither text nor one of the three kinds the media catalogue offers is
 * skipped by the chat refresh for not emitting text and skipped by the media refresh for emitting
 * nothing it can carry, so it exists nowhere - which is exactly how a new output modality would
 * arrive. An absurd price has always been journalled; this was not, and an owner asking why their
 * provider's new release never appeared had nothing anywhere to read.
 */
describe('a model this build has no route for at all', () => {
  const feed = (rows: unknown[]) =>
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.split('?')[0]!.endsWith('/models')) return respondWith({ data: rows });
      return respondWith({ data: [] });
    }) as unknown as typeof fetch;

  const rows = [
    {
      id: 'vendor/holograms-1',
      architecture: { input_modalities: ['text'], output_modalities: ['hologram'] }
    },
    {
      id: 'vendor/draws-1',
      architecture: { input_modalities: ['text'], output_modalities: ['image'] }
    },
    {
      id: 'vendor/chats-1',
      context_length: 200_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.000001', completion: '0.000004' }
    }
  ];

  it('names it in the journal instead of dropping it from both catalogues without a word', async () => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    let chat;
    try {
      chat = await refreshOpenRouterCatalog([], {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'registry-key',
        fetch: feed(rows),
        now: NOW
      });
    } finally {
      stderr.mockRestore();
    }
    const media = await refreshOpenRouterMediaCatalog({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'owner-key',
      fetch: feed(rows),
      now: NOW
    });

    // Gone from both, which is the fact that needed saying.
    expect(chat.map((model) => model.providerModelId)).toEqual(['vendor/chats-1']);
    expect(media.map((option) => option.providerModelId)).not.toContain('vendor/holograms-1');
    const journal = written.filter((line) => line.includes('model catalogue'));
    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain('1 live route was left out because this build has no route');
    expect(journal[0]).toContain('vendor/holograms-1');
    // The image generator is not named: it left the chat catalogue for the media one, which is a
    // move rather than a loss, and reporting it would teach an owner to ignore this line.
    expect(journal[0]).not.toContain('vendor/draws-1');
    expect(media.map((option) => option.providerModelId)).toContain('vendor/draws-1');
  });
});

/*
 * The other half of the same defect, found while the model feed was being narrowed and measured
 * the same way. `/endpoints/zdr` is the feed that carries privacy routes and uptime and nothing
 * else, it is fetched beside the model list precisely so that losing it costs the owner only those
 * facts - and `data` arriving as an object threw "object is not iterable" out of the whole refresh,
 * because `Promise.allSettled` settles on the request and this happens afterwards, in the body.
 */
describe('an endpoint feed that changed shape underneath the parser', () => {
  const reshapedZdr = (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.split('?')[0]!.endsWith('/models')) return Promise.resolve(respondWith(modelsPayload));
    return Promise.resolve(
      respondWith({ data: { 'z-ai/glm-5.2': { status: 0, uptime_last_1d: 99 } } })
    );
  };

  it('keeps every model in the catalogue when the endpoint feed is unreadable', async () => {
    const models = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: vi.fn(reshapedZdr) as unknown as typeof fetch,
      now: NOW
    });
    // The models are all here, with their prices and benchmarks, and only the facts that feed
    // states are missing - which is what the two separate requests were for in the first place.
    expect(models.map((model) => model.providerModelId)).toContain('z-ai/glm-5.2');
    const glm = models.find((model) => model.providerModelId === 'z-ai/glm-5.2');
    expect(glm?.inputUsdPerMillionTokens).toBeCloseTo(1, 6);
    // A row that could not be read is not a route that was verified: an unreadable feed claims no
    // private endpoint for anyone, rather than claiming one from a row it could not parse.
    expect(glm?.uptimeLast1dPercent).toBeNull();
    expect(glm?.zeroDataRetentionAvailable).toBe(false);
  });

  it('keeps the media catalogue when the endpoint feed is unreadable', async () => {
    const options = await refreshOpenRouterMediaCatalog({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'owner-key',
      fetch: vi.fn(reshapedZdr) as unknown as typeof fetch,
      now: NOW
    });
    expect(options.map((option) => option.providerModelId)).toContain('black-forest-labs/flux-2');
  });

  it('reads the endpoints it can when only some rows are unreadable', async () => {
    const models = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: vi.fn((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.split('?')[0]!.endsWith('/models'))
          return Promise.resolve(respondWith(modelsPayload));
        return Promise.resolve(respondWith({ data: [null, { model_id: 7 }, ...zdrPayload.data] }));
      }) as unknown as typeof fetch,
      now: NOW
    });
    // One junk row costs its own row and nothing else: the endpoints beside it are still read, and
    // the model they belong to still has its private route and its uptime.
    const glm = models.find((model) => model.providerModelId === 'z-ai/glm-5.2');
    expect(glm?.zeroDataRetentionAvailable).toBe(true);
    expect(glm?.uptimeLast1dPercent).toBeCloseTo(99.8, 6);
  });
});
