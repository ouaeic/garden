import type { DictationOptions } from '@garden/contracts';
import { spendCap } from './composer-operations';

// Kept in step with the API contract by scripts/check-repository.mjs.
export const DICTATION_MAX_COST_USD = 100;

export interface DictationConsent {
  expectedRouteId: string;
  expectedModelId: string;
  expectedRouteProof: string;
  privacyRoute: 'provider_zdr' | 'external';
  externalConsent?: true;
  maxCostUsd?: number;
}

export function authorizeDictation(
  options: DictationOptions,
  cap: string,
  externalConsent: boolean
): DictationConsent {
  if (!options.available || !options.routeId || !options.modelId || !options.routeProof)
    throw new Error(options.reason || 'Dictation is unavailable. Check your provider settings.');
  if (!options.privacyRoutes.includes(options.defaultPrivacyRoute))
    throw new Error('The selected dictation privacy route is unavailable. Refresh its options.');
  if (options.usdPerMinute === null && options.reservationUsd === null)
    throw new Error(
      'This dictation model has no verified request cost bound. Choose a supported route.'
    );
  if (
    (options.requiresExternalConsent || options.defaultPrivacyRoute === 'external') &&
    !externalConsent
  )
    throw new Error('Review and accept the provider retention terms before recording.');
  const maxCostUsd = spendCap(cap);
  if (maxCostUsd !== undefined && maxCostUsd > DICTATION_MAX_COST_USD)
    throw new Error(`Choose a transcription limit no higher than ${DICTATION_MAX_COST_USD} USD.`);
  if (
    maxCostUsd !== undefined &&
    maxCostUsd < (options.reservationUsd ?? options.usdPerMinute ?? 0)
  )
    throw new Error('This limit is below the selected model’s minimum request reservation.');
  if (options.requiresMaxCostUsd && maxCostUsd === undefined)
    throw new Error('Set a maximum transcription cost before recording.');
  return {
    expectedRouteId: options.routeId,
    expectedModelId: options.modelId,
    expectedRouteProof: options.routeProof,
    privacyRoute: options.defaultPrivacyRoute,
    ...(options.defaultPrivacyRoute === 'external' ? { externalConsent: true as const } : {}),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd })
  };
}
