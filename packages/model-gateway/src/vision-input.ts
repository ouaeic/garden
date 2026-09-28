/**
 * Image INPUT routes for providers whose chat models accept images but publish no media catalogue.
 *
 * Ollama Cloud is the case this exists for: `/api/show` publishes a `vision` capability on eight
 * chat models, and none of them appears in any media feed, so `MediaRouteResolver.catalog`
 * returned nothing and every gate keyed on `modalities.includes('image')` refused an image the
 * endpoint can actually take. A vision-capable chat model IS the route: the image rides the chat
 * request as a base64 block, priced by the chat token, with no second endpoint to verify.
 *
 * Audio, transcription and video stay off this table deliberately. Ollama Cloud publishes no
 * generation or transcription capability for them, and an option that cannot run is a card that
 * trains the owner to click through.
 */

import type { MediaModelOption } from '@garden/contracts';

export const resolveVisionInputRoutes = (
  models: ReadonlyArray<{
    readonly id: string;
    readonly providerModelId: string;
    readonly displayName: string;
    readonly provider: string;
    readonly modalities: readonly string[];
    readonly capabilities: readonly string[];
    readonly availability: string;
    readonly recommendationTags?: readonly string[];
    readonly updatedAt?: string;
  }>,
  now = new Date()
): MediaModelOption[] =>
  models
    .filter(
      (model) =>
        model.availability === 'available' &&
        model.capabilities.includes('vision') &&
        model.modalities.includes('image')
    )
    .map((model) => ({
      id: model.id,
      providerModelId: model.providerModelId,
      displayName: model.displayName,
      provider: model.provider,
      modality: 'image' as const,
      usdPerImage: null,
      usdPerMillionCharacters: null,
      usdPerMinute: null,
      recommendationTags: [...(model.recommendationTags ?? [])],
      priceSource: 'unknown' as const,
      updatedAt: model.updatedAt ?? now.toISOString()
    }));
