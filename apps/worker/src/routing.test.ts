import type { MediaModelOption, ModelRelease } from '@garden/contracts';
import type { RoutingMetadata } from '@garden/core';
import type { ModelRequest } from '@garden/model-gateway';
import { describe, expect, it } from 'vitest';
import {
  compactionEventSummary,
  compactionModel,
  routeTo,
  transcriptionRouteAllowed,
  usableCapabilities
} from './routing.js';

describe('capability routing', () => {
  const modelRelease = (overrides: Partial<ModelRelease> = {}): ModelRelease => ({
    id: 'vendor/model',
    providerModelId: 'vendor/model',
    displayName: 'Model',
    provider: 'openrouter',
    revision: 'openrouter-live',
    availability: 'available',
    openness: 'remote_proprietary',
    license: 'provider-hosted',
    commercialUse: true,
    privacyRoute: 'provider_zdr',
    contextTokens: 128_000,
    modalities: ['text', 'image'],
    capabilities: ['chat', 'tools', 'vision'],
    usageClass: 'medium',
    recommendationTags: [],
    measuredQuality: 0.7,
    measuredLatencyMs: 400,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  });

  it('reports what a healthy model can be used for', () => {
    expect([...usableCapabilities(modelRelease(), 'provider_zdr')]).toEqual([
      'chat',
      'tools',
      'vision'
    ]);
  });

  it('ignores a vision claim the live modalities contradict', () => {
    const capabilities = usableCapabilities(modelRelease({ modalities: ['text'] }), 'provider_zdr');
    expect(capabilities.has('vision')).toBe(false);
    expect(capabilities.has('tools')).toBe(true);
  });

  it('withdraws a model whose zero-retention route is gone from a private task', () => {
    expect(
      usableCapabilities(modelRelease({ zeroDataRetentionAvailable: false }), 'provider_zdr').size
    ).toBe(0);
  });

  it('withdraws a model the registry no longer serves', () => {
    expect(usableCapabilities(modelRelease({ availability: 'review' }), 'provider_zdr').size).toBe(
      0
    );
    expect(
      usableCapabilities(modelRelease({ providerAvailable: false }), 'provider_zdr').size
    ).toBe(0);
  });

  it('keeps a zero-retention model usable for an ordinary task', () => {
    expect(usableCapabilities(modelRelease(), 'external').has('vision')).toBe(true);
  });

  it('refuses an external-only route for a zero-retention task', () => {
    expect(
      usableCapabilities(modelRelease({ privacyRoute: 'external' }), 'provider_zdr').size
    ).toBe(0);
  });

  /*
   * Audio asks too. A recording is the owner speaking, and the transcription model is picked from
   * whatever the provider happens to list, so without the check a private task could send a voice
   * to an endpoint no reviewed row on the box vouches for.
   */
  describe('the model a recording is read by', () => {
    const route = (overrides: Partial<MediaModelOption> = {}): MediaModelOption => ({
      id: 'vendor/hears',
      providerModelId: 'vendor/hears-1',
      displayName: 'Hears',
      provider: 'vendor',
      modality: 'transcription',
      apiProtocol: 'openai',
      usdPerImage: null,
      usdPerMillionCharacters: null,
      usdPerMinute: 0.01,
      priceSource: 'provider',
      zeroDataRetentionAvailable: true,
      recommendationTags: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides
    });

    /*
     * The route the owner never chose. `audio_read` then falls back to whatever the provider listed
     * a moment ago, and this box has recorded nothing about it either way.
     */
    it('sends nothing private down a route this box knows nothing about', () => {
      expect(transcriptionRouteAllowed(undefined, 'provider_zdr')).toBe(false);
    });

    it('refuses a chosen route that offers no zero-retention endpoint', () => {
      expect(
        transcriptionRouteAllowed(route({ zeroDataRetentionAvailable: false }), 'provider_zdr')
      ).toBe(false);
      // Absent is not the same as false, but it is just as far from a promise.
      expect(
        transcriptionRouteAllowed(route({ zeroDataRetentionAvailable: undefined }), 'provider_zdr')
      ).toBe(false);
    });

    /*
     * The case the first version of this guard could not reach. It asked the chat catalogue, which
     * by construction holds no transcription model at all, so it answered no on every box - and a
     * check that can only refuse is the tool removed rather than the recording protected.
     */
    it('allows a chosen route that does offer one', () => {
      expect(transcriptionRouteAllowed(route(), 'provider_zdr', true)).toBe(true);
    });

    it('refuses generic ZDR metadata without verified native connection authority', () => {
      expect(transcriptionRouteAllowed(route(), 'provider_zdr')).toBe(false);
      expect(
        transcriptionRouteAllowed(route({ apiProtocol: 'openrouter' }), 'provider_zdr', true)
      ).toBe(false);
    });

    it('leaves an ordinary task the route it already had', () => {
      expect(transcriptionRouteAllowed(undefined, 'external')).toBe(true);
    });
  });
});

describe('summarising compaction routing', () => {
  const release = (overrides: Partial<ModelRelease> & { id: string }): ModelRelease => ({
    providerModelId: overrides.id,
    displayName: overrides.id,
    provider: 'openrouter',
    revision: 'openrouter-live',
    availability: 'available',
    openness: 'remote_proprietary',
    license: 'provider-hosted',
    commercialUse: true,
    privacyRoute: 'provider_zdr',
    contextTokens: 200_000,
    modalities: ['text'],
    capabilities: ['chat', 'tools', 'reasoning'],
    usageClass: 'medium',
    recommendationTags: [],
    measuredQuality: 0.7,
    measuredLatencyMs: 400,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  });
  const lead = release({ id: 'vendor/lead', usageClass: 'extra_high' });

  it('summarises with the cheapest usable model rather than the lead', () => {
    const cheap = release({ id: 'vendor/light', usageClass: 'light' });
    expect(
      compactionModel([lead, release({ id: 'vendor/mid' }), cheap], lead, 'provider_zdr').id
    ).toBe('vendor/light');
  });

  it('breaks a tie on published input price', () => {
    expect(
      compactionModel(
        [
          release({ id: 'vendor/a', usageClass: 'light', inputUsdPerMillionTokens: 0.4 }),
          release({ id: 'vendor/b', usageClass: 'light', inputUsdPerMillionTokens: 0.1 }),
          lead
        ],
        lead,
        'provider_zdr'
      ).id
    ).toBe('vendor/b');
  });

  it('refuses a model the task privacy route or the run credential cannot reach', () => {
    // #gateway registers exactly one provider and rejects anything else, so a cheaper model on
    // another provider is not actually callable from this run.
    const offRoute = release({
      id: 'vendor/external',
      usageClass: 'light',
      privacyRoute: 'external'
    });
    const offProvider = release({ id: 'vendor/other', usageClass: 'light', provider: 'custom' });
    expect(compactionModel([lead, offRoute, offProvider], lead, 'provider_zdr').id).toBe(
      'vendor/lead'
    );
  });

  it('refuses a model too small to hold the condensed span and the brief', () => {
    expect(
      compactionModel(
        [lead, release({ id: 'vendor/tiny', usageClass: 'light', contextTokens: 8_000 })],
        lead,
        'provider_zdr'
      ).id
    ).toBe('vendor/lead');
  });

  it('falls back to the lead model instead of skipping summarisation entirely', () => {
    expect(compactionModel([], lead, 'provider_zdr')).toBe(lead);
  });

  it('tells the user what was condensed and whether a model wrote it', () => {
    expect(
      compactionEventSummary({ trigger: 'budget', condensedMessages: 42, source: 'model' })
    ).toBe(
      'Condensed earlier work to stay inside the context window: 42 messages summarised into the running brief'
    );
    expect(
      compactionEventSummary({ trigger: 'agent', condensedMessages: 1, source: 'deterministic' })
    ).toBe('Condensed a finished phase: 1 message recorded mechanically in the running brief');
  });
});

/**
 * What a catalogue entry is allowed to tell the provider adapter about its route.
 *
 * The list is derived rather than written: any field that exists on both `RoutingMetadata` and the
 * adapter's `ModelRequest` is by definition something the catalogue collects and the adapter
 * honours, and the only question left is whether anything carries it between the two. For a long
 * time the answer was no for all three - the refresh stored them, the store round-tripped them, the
 * adapter read them, and every request was built without them. The mapped type below is the same
 * trick `routingMetadataReaders` uses to keep the store's own list honest: adding a fourth such
 * field without forwarding it will not compile.
 */
type RoutedRequestField = Extract<keyof RoutingMetadata, keyof ModelRequest>;

describe('what a request carries about its route', () => {
  const forwarded: { readonly [K in RoutedRequestField]: true } = {
    promptCacheStyle: true,
    maxOutputTokens: true,
    supportsReasoningEffort: true
  };

  it('forwards every routing field the adapter reads', () => {
    const request = routeTo({
      providerModelId: 'vendor/model-1',
      promptCacheStyle: 'explicit',
      maxOutputTokens: 8_192,
      supportsReasoningEffort: false
    });

    expect(request.model).toBe('vendor/model-1');
    for (const field of Object.keys(forwarded) as RoutedRequestField[])
      expect(
        request,
        `${field} is collected by the catalogue and never reaches the request`
      ).toHaveProperty(field);
    expect(request).toMatchObject({
      promptCacheStyle: 'explicit',
      maxOutputTokens: 8_192,
      // `false` is the whole point of this one: a route that does not take a reasoning effort must
      // be asked without it, which under zero data retention is the difference between a narrower
      // answer and a 404 for a model the catalogue correctly listed.
      supportsReasoningEffort: false
    });
  });

  it('leaves absent fields absent rather than inventing a default', () => {
    // `undefined` and `false` mean different things here - "the refresh never reported this" is not
    // "the route says no" - and a request that spelled the first as the second would withhold a
    // parameter from every route whose metadata has simply not been refreshed yet.
    expect(Object.keys(routeTo({ providerModelId: 'vendor/model-1' }))).toEqual(['model']);
  });
});
