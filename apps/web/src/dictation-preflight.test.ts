import { describe, expect, it } from 'vitest';
import type { DictationOptions } from '@garden/contracts';
import { authorizeDictation } from './dictation-preflight';

const options: DictationOptions = {
  available: true,
  reason: null,
  routeId: 'owner-route',
  routeProof: 'opaque-selection-proof',
  modelId: 'transcriber',
  displayName: 'Transcriber',
  provider: 'Provider',
  privacyRoutes: ['provider_zdr'],
  defaultPrivacyRoute: 'provider_zdr',
  requiresExternalConsent: false,
  requiresMaxCostUsd: false,
  pricing: [],
  usdPerMinute: 0.006,
  reservationUsd: null,
  maxDurationSeconds: 300,
  maxBytes: 14_000_000
};

describe('dictation preflight', () => {
  it('binds one recording to its reviewed model, credential route and privacy policy', () => {
    expect(authorizeDictation(options, '', false)).toEqual({
      expectedRouteId: 'owner-route',
      expectedModelId: 'transcriber',
      expectedRouteProof: 'opaque-selection-proof',
      privacyRoute: 'provider_zdr'
    });
  });

  it('requires explicit consent for retained audio even if a route omits its consent hint', () => {
    const external: DictationOptions = {
      ...options,
      defaultPrivacyRoute: 'external',
      privacyRoutes: ['external'],
      requiresExternalConsent: false
    };
    expect(() => authorizeDictation(external, '', false)).toThrow('retention');
    expect(authorizeDictation(external, '', true)).toMatchObject({
      privacyRoute: 'external',
      externalConsent: true
    });
  });

  it('refuses missing, nonfinite and nonpositive required spending limits', () => {
    const unpriced = {
      ...options,
      requiresMaxCostUsd: true,
      usdPerMinute: null,
      reservationUsd: 0.03
    };
    const rejected = ['', '0', '-1', 'Infinity', 'NaN', '101'];
    expect(rejected.length).toBeGreaterThan(0);
    for (const value of rejected)
      expect(() => authorizeDictation(unpriced, value, false)).toThrow();
    expect(authorizeDictation(unpriced, '0.04', false).maxCostUsd).toBe(0.04);
    expect(() => authorizeDictation(unpriced, '.001', false)).toThrow('minimum request');
    expect(() => authorizeDictation({ ...unpriced, reservationUsd: null }, '.04', false)).toThrow(
      'verified request'
    );
  });

  it('cannot authorize an unavailable model or a route absent from the provider capabilities', () => {
    expect(() =>
      authorizeDictation({ ...options, available: false, reason: 'No route' }, '', true)
    ).toThrow('No route');
    expect(() => authorizeDictation({ ...options, modelId: null }, '', true)).toThrow(
      'unavailable'
    );
    expect(() => authorizeDictation({ ...options, privacyRoutes: [] }, '', true)).toThrow(
      'privacy route'
    );
  });
});
