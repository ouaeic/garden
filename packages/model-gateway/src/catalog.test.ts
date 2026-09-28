import { describe, expect, it } from 'vitest';
import type { MediaModelOption } from '@garden/contracts';
import {
  configuredModelCatalog,
  rankMediaModels,
  resolveMediaModel,
  seedMediaModels,
  seedModels
} from './catalog.js';
import type { ConfiguredModelDescription } from './openai-compatible.js';

describe('cloud-only model catalog', () => {
  it('contains only independently reviewed OpenRouter open-weight routes', () => {
    const models = seedModels(new Date('2026-07-21T00:00:00.000Z'));
    expect(models.length).toBeGreaterThan(0);
    expect(
      models.every(
        (model) =>
          model.provider === 'openrouter' &&
          model.privacyRoute === 'provider_zdr' &&
          model.openness === 'permissive_open_weight' &&
          model.commercialUse &&
          !`${model.id} ${model.displayName} ${model.provider}`.toLowerCase().includes('local')
      )
    ).toBe(true);
  });

  it('offers a compact catalog from fast default through specialist vision and high-end work', () => {
    const aliases = seedModels().map((model) => [model.providerModelId, model.usageClass]);
    expect(aliases).toEqual(
      expect.arrayContaining([
        ['deepseek/deepseek-v4-flash', 'light'],
        ['qwen/qwen3.6-35b-a3b', 'medium'],
        ['openai/gpt-oss-120b', 'medium'],
        ['z-ai/glm-5.2', 'high']
      ])
    );
  });

  it('advertises only the modalities garden can put into a request', () => {
    // The gateway builds exactly one non-text content block, `image_url`, so a reviewed seed that
    // offered audio or video would show the owner a capability nothing on this computer can reach:
    // a screenshot is sent to a vision model, a recording never is.
    const offered = new Set(seedModels().flatMap((model) => model.modalities));
    expect([...offered].sort()).toEqual(['image', 'text']);
  });

  it('keeps provider model ids separate from stable garden ids', () => {
    expect(seedModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openrouter/z-ai/glm-5.2',
          provider: 'openrouter',
          providerModelId: 'z-ai/glm-5.2'
        })
      ])
    );
  });
});

describe('media model catalogue', () => {
  const option = (
    overrides: Partial<MediaModelOption> & Pick<MediaModelOption, 'id'>
  ): MediaModelOption => ({
    providerModelId: overrides.id,
    displayName: overrides.id,
    provider: 'openrouter',
    modality: 'image',
    usdPerImage: null,
    usdPerMillionCharacters: null,
    usdPerMinute: null,
    priceSource: 'provider',
    recommendationTags: [],
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides
  });

  it('offers a reviewed route for each modality garden can actually generate', () => {
    const offered = seedMediaModels().map((entry) => entry.modality);
    // Video is absent by construction: there is no request shape behind it, and a catalogue entry
    // would be an offer garden cannot keep.
    expect(offered.sort()).toEqual(['audio', 'image']);
    expect(seedMediaModels().every((entry) => entry.priceSource === 'measured')).toBe(true);
  });

  it('never lets an automatic mode reach for a model whose price nobody published', () => {
    const models = [
      option({ id: 'cheap', usdPerImage: 0.01 }),
      option({ id: 'dear', usdPerImage: 0.5 }),
      option({ id: 'silent', priceSource: 'unknown' })
    ];
    // An unknown price is neither the cheap end nor the premium end. It is a number the owner first
    // sees on an invoice, so it sorts last in every mode rather than winning the one it looks like.
    for (const preference of ['fast', 'balanced', 'best'] as const)
      expect(rankMediaModels(models, preference).at(-1)?.id).toBe('silent');
    expect(rankMediaModels(models, 'fast')[0]?.id).toBe('cheap');
    expect(rankMediaModels(models, 'best')[0]?.id).toBe('dear');
  });

  it('leads Recommended with the route garden has itself measured', () => {
    const models = [
      option({ id: 'cheaper', usdPerImage: 0.001 }),
      option({ id: 'reviewed', usdPerImage: 0.014, priceSource: 'measured' })
    ];
    expect(rankMediaModels(models, 'balanced')[0]?.id).toBe('reviewed');
    expect(rankMediaModels(models, 'fast')[0]?.id).toBe('cheaper');
  });

  it('refuses to substitute another model when the pinned model has left the catalogue', () => {
    const models = [option({ id: 'still-here', usdPerImage: 0.02 })];
    const resolved = resolveMediaModel(
      models,
      { automatic: false, preference: 'balanced', modelId: 'withdrawn-last-month' },
      'image'
    );
    expect(resolved).toBeNull();
  });

  it('will not resolve to a model that cannot be chosen', () => {
    const models = [
      option({ id: 'blocked', usdPerImage: 0.001, unavailableReason: 'no verified private route' }),
      option({ id: 'private', usdPerImage: 0.09 })
    ];
    expect(resolveMediaModel(models, undefined, 'image')?.id).toBe('private');
  });

  it('answers null for a modality the provider offers nothing for', () => {
    expect(resolveMediaModel([option({ id: 'an-image-model' })], undefined, 'audio')).toBeNull();
  });
});

describe('a catalogue built from what a configured endpoint says about itself', () => {
  const described = (
    overrides: Partial<ConfiguredModelDescription> & Pick<ConfiguredModelDescription, 'id'>
  ): ConfiguredModelDescription => ({
    displayName: overrides.id,
    contextTokens: null,
    maxOutputTokens: null,
    inputUsdPerMillionTokens: null,
    outputUsdPerMillionTokens: null,
    supportsTools: null,
    supportsReasoningEffort: null,
    unknownFields: [],
    metadataSource: 'unknown',
    ...overrides
  });

  const options = {
    privacyRoute: 'provider_zdr' as const,
    contextTokens: 128_000,
    capabilities: ['chat', 'tools', 'reasoning'] as const,
    modalities: ['text'] as const,
    tag: 'Ollama Cloud'
  };

  it('writes every model the account reaches, not the one the owner typed', () => {
    const catalogue = configuredModelCatalog(
      [described({ id: 'a' }), described({ id: 'b' }), described({ id: 'c' })],
      { ...options, capabilities: [...options.capabilities], modalities: [...options.modalities] }
    );
    expect(catalogue.map((model) => model.id)).toEqual(['custom/a', 'custom/b', 'custom/c']);
    expect(catalogue.every((model) => model.provider === 'custom')).toBe(true);
  });

  it('prefers the endpoint’s own numbers and falls back to the owner’s only where it was silent', () => {
    const [declared, silent] = configuredModelCatalog(
      [
        described({
          id: 'declared',
          contextTokens: 262_144,
          inputUsdPerMillionTokens: 5,
          metadataSource: 'declared'
        }),
        described({ id: 'silent' })
      ],
      { ...options, capabilities: [...options.capabilities], modalities: [...options.modalities] }
    );
    expect(declared?.contextTokens).toBe(262_144);
    expect(declared?.usageClass).toBe('high');
    expect(silent?.contextTokens).toBe(128_000);
    // Never invented as measured: an unmeasured route is selectable by name and never by ranking.
    expect(silent?.metadataSource).toBe('unknown');
    expect(silent?.measuredQuality).toBeNull();
  });

  it('only takes tools away from a model that said it has none', () => {
    const [quiet, refusing] = configuredModelCatalog(
      [described({ id: 'quiet' }), described({ id: 'refusing', supportsTools: false })],
      { ...options, capabilities: [...options.capabilities], modalities: [...options.modalities] }
    );
    // Silence is not a denial. Reading it as one would take every model on a quiet endpoint out of
    // agent work, which is all of them on most endpoints.
    expect(quiet?.capabilities).toContain('tools');
    expect(refusing?.capabilities).not.toContain('tools');
  });
});
