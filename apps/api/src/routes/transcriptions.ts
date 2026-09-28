import { createHmac } from 'node:crypto';
import {
  DICTATION_MAX_BYTES,
  DICTATION_MAX_SECONDS,
  DICTATION_MAX_COST_USD,
  AUDIO_RECEIPT_REFERENCE_MAX_LENGTH,
  PrivacyRoute,
  type DictationOptions,
  type MediaModelOption
} from '@garden/contracts';
import { GardenError, decryptJson, encryptJson, sha256, userMemoryKey } from '@garden/core';
import {
  MediaClient,
  MediaProviderRejectionError,
  TranscriptionEmptyError,
  isNativeOpenAIEndpoint,
  nativeTranscriptionBound,
  quoteMediaPrice
} from '@garden/model-gateway';
import { z } from 'zod';
import { TRANSCRIPTION_FORMATS, type InferenceSecret } from '../context.js';
import {
  decodeDictationBase64,
  dictationDecoder,
  prepareDictationAudio
} from '../audio-preparation.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

const DictationRequest = z
  .object({
    data: z
      .string()
      .min(1)
      .max(Math.ceil(DICTATION_MAX_BYTES / 3) * 4),
    format: z.enum(TRANSCRIPTION_FORMATS),
    expectedRouteId: z.string().min(1).max(512).optional(),
    expectedModelId: z.string().min(1).max(512).optional(),
    expectedRouteProof: z.string().min(1).max(128).optional(),
    privacyRoute: PrivacyRoute.optional(),
    externalConsent: z.boolean().optional(),
    maxCostUsd: z.number().finite().positive().max(DICTATION_MAX_COST_USD).optional()
  })
  .strict();

const durationRate = (route: MediaModelOption | null): number | null => {
  if (!route || route.priceSource === 'unknown') return null;
  if (route.pricing?.length) return quoteMediaPrice(route.pricing, { seconds: 60 });
  return typeof route.usdPerMinute === 'number' &&
    Number.isFinite(route.usdPerMinute) &&
    route.usdPerMinute >= 0
    ? route.usdPerMinute
    : null;
};

export const dictationOptionsFor = async (
  context: RouteContext,
  userId: string
): Promise<{
  options: DictationOptions;
  secret: InferenceSecret;
  route: MediaModelOption | null;
}> => {
  const { secret } = await context.inferenceCredential(userId);
  let route = secret.mediaRoutes?.transcription ?? null;
  if (secret.provider === 'openrouter' || !route) {
    const current = (await context.mediaSettings(userId)).modalities.find(
      (entry) => entry.modality === 'transcription'
    );
    route = route
      ? (current?.options?.find((option) => option.id === route!.id) ??
        (current?.effective?.id === route.id
          ? current.effective
          : {
              ...route,
              unavailableReason:
                'The selected transcription model is no longer advertised. Review the model in Settings.'
            }))
      : (current?.effective ?? null);
  }
  const native = secret.provider !== 'openrouter' && isNativeOpenAIEndpoint(secret.baseUrl);
  const protocolMatches =
    route &&
    (secret.provider === 'openrouter'
      ? route.apiProtocol !== 'openai'
      : native && route.apiProtocol === 'openai');
  const privacyRoutes: DictationOptions['privacyRoutes'] = [];
  if (
    native &&
    protocolMatches &&
    route?.zeroDataRetentionAvailable &&
    secret.enforceZeroDataRetention
  )
    privacyRoutes.push('provider_zdr');
  if (secret.provider === 'openrouter' || (native && !secret.enforceZeroDataRetention))
    privacyRoutes.push('external');
  const rate = durationRate(route);
  const bound = native ? nativeTranscriptionBound(route) : null;
  const reason = !secret.apiKey
    ? 'Connect a provider credential in Settings.'
    : !route || route.modality !== 'transcription' || !route.providerModelId
      ? 'Choose a transcription model in Settings.'
      : (route.unavailableReason ??
        (!protocolMatches
          ? 'The selected transcription route does not match this provider connection.'
          : !privacyRoutes.length
            ? 'The selected transcription route cannot meet the configured privacy requirement.'
            : rate === null && bound === null
              ? 'This transcription route has no verified whole-recording cost bound. Choose a supported priced transcription model.'
              : !(await dictationDecoder())
                ? 'Install the native media capability before using dictation.'
                : null));
  return {
    secret,
    route,
    options: {
      available: reason === null,
      reason,
      routeId: route?.id ?? null,
      routeProof: route
        ? createHmac('sha256', userMemoryKey(context.masterKey, userId))
            .update(
              JSON.stringify({
                userId,
                baseUrl: secret.baseUrl,
                provider: secret.provider,
                apiKey: secret.apiKey,
                enforceZeroDataRetention: secret.enforceZeroDataRetention,
                route: { ...route, updatedAt: undefined, metadataVerifiedAt: undefined },
                bound
              })
            )
            .digest('base64url')
        : null,
      modelId: route?.providerModelId ?? null,
      displayName: route?.displayName ?? null,
      provider: route?.provider ?? null,
      privacyRoutes,
      defaultPrivacyRoute: privacyRoutes.includes('provider_zdr') ? 'provider_zdr' : 'external',
      requiresExternalConsent: !privacyRoutes.includes('provider_zdr'),
      requiresMaxCostUsd: false,
      pricing: route?.pricing ?? [],
      usdPerMinute: rate,
      reservationUsd: bound?.reservationUsd ?? null,
      maxDurationSeconds: Math.min(
        DICTATION_MAX_SECONDS,
        bound?.maxSeconds ?? DICTATION_MAX_SECONDS
      ),
      maxBytes: DICTATION_MAX_BYTES
    }
  };
};

export const registerTranscriptionRoutes = (context: RouteContext): void => {
  const { app, store, config, masterKey, idempotent } = context;
  const preparing = new Set<string>();
  app.get('/v1/audio/transcriptions/receipts', async (request) =>
    store.listDictationReceipts(requireUser(request.user).id)
  );
  app.post<{ Params: { receiptId: string } }>(
    '/v1/audio/transcriptions/:receiptId/reconcile',
    async (request, reply) => {
      const user = requireUser(request.user);
      if (request.apiToken)
        throw new GardenError(
          'dictation_owner_required',
          'Reconcile dictation from a signed-in browser',
          403
        );
      return idempotent(request, reply, user, async () => {
        if (preparing.has(user.id))
          throw new GardenError(
            'dictation_active',
            'Wait for the active dictation request to finish before reconciling its charge',
            409
          );
        const id = z.string().uuid().parse(request.params.receiptId);
        const input = z
          .object({
            costUsd: z.number().finite().min(0).max(1_000_000),
            providerReceiptRef: z.string().trim().min(1).max(AUDIO_RECEIPT_REFERENCE_MAX_LENGTH)
          })
          .strict()
          .parse(request.body);
        return store.reconcileDictationReceipt({
          userId: user.id,
          id,
          costUsd: input.costUsd,
          receiptCiphertext: encryptJson(
            { providerReceiptRef: input.providerReceiptRef },
            userMemoryKey(masterKey, user.id),
            `dictation-reconciliation:${user.id}:${id}`
          )
        });
      });
    }
  );
  app.get('/v1/audio/transcriptions/options', async (request) => {
    const user = requireUser(request.user);
    try {
      return (await dictationOptionsFor(context, user.id)).options;
    } catch (error) {
      if (!(error instanceof GardenError)) throw error;
      return {
        available: false,
        reason: error.message,
        routeId: null,
        routeProof: null,
        modelId: null,
        displayName: null,
        provider: null,
        privacyRoutes: [],
        defaultPrivacyRoute: 'provider_zdr',
        requiresExternalConsent: false,
        requiresMaxCostUsd: true,
        pricing: [],
        usdPerMinute: null,
        reservationUsd: null,
        maxDurationSeconds: DICTATION_MAX_SECONDS,
        maxBytes: DICTATION_MAX_BYTES
      } satisfies DictationOptions;
    }
  });
  app.post('/v1/audio/transcriptions', async (request, reply) => {
    const user = requireUser(request.user);
    if (request.apiToken)
      throw new GardenError(
        'dictation_owner_required',
        'Start dictation from a signed-in browser',
        403
      );
    const input = DictationRequest.parse(request.body);
    const key = userMemoryKey(masterKey, user.id),
      aad = `dictation-response:${user.id}:${sha256(String(request.headers['idempotency-key']))}`;
    const sealed = await idempotent(request, reply, user, async () => {
      if (preparing.has(user.id))
        throw new GardenError(
          'dictation_busy',
          'Finish the current recording before starting another',
          409
        );
      preparing.add(user.id);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const closed = () => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', closed);
      try {
        const bytes = decodeDictationBase64(input.data);
        const { secret, route, options } = await dictationOptionsFor(context, user.id);
        if (!route || !options.available)
          throw new GardenError(
            'transcription_route_unavailable',
            options.reason ?? 'Choose a transcription model in Settings',
            409
          );
        if (
          (input.expectedRouteId !== undefined && input.expectedRouteId !== options.routeId) ||
          (input.expectedModelId !== undefined && input.expectedModelId !== options.modelId) ||
          (input.expectedRouteProof !== undefined &&
            input.expectedRouteProof !== options.routeProof)
        )
          throw new GardenError(
            'dictation_selection_changed',
            'The transcription connection or model changed. Review it again before sending this recording.',
            409
          );
        const privacyRoute = input.privacyRoute ?? 'provider_zdr';
        if (!options.privacyRoutes.includes(privacyRoute))
          throw new GardenError(
            'transcription_privacy_conflict',
            'Choose the advertised privacy route before sending this recording',
            409
          );
        if (
          privacyRoute === 'external' &&
          (input.externalConsent !== true ||
            !input.expectedRouteId ||
            !input.expectedModelId ||
            !input.expectedRouteProof)
        )
          throw new GardenError(
            'transcription_consent_required',
            'Review the selected transcription connection and explicitly allow external retention before sending this recording',
            409
          );
        if (options.usdPerMinute === null && options.reservationUsd === null)
          throw new GardenError(
            'transcription_price_unbounded',
            'Choose a supported priced transcription model',
            409
          );
        const prepared = await prepareDictationAudio(bytes, input.format, controller.signal);
        if (prepared.seconds > options.maxDurationSeconds)
          throw new GardenError(
            'transcription_duration_exceeded',
            'This recording exceeds the selected model’s bounded duration. Dictate a shorter direction.',
            413
          );
        const estimateUsd =
          options.reservationUsd ?? Math.ceil(prepared.seconds / 60) * options.usdPerMinute!;
        if (input.maxCostUsd !== undefined && estimateUsd > input.maxCostUsd)
          throw new GardenError(
            'transcription_reservation_exceeded',
            'This recording exceeds the chosen transcription cost limit',
            402
          );
        const operationKey = String(request.headers['idempotency-key']);
        const usage = {
          userId: user.id,
          kind: 'model_inference',
          resourceClass: 'media:transcription',
          quantity: prepared.seconds,
          unit: 'second',
          credits: 0,
          idempotencyKey: `dictation:${user.id}:${sha256(operationKey)}`,
          providerRef: `${secret.provider}:${route.providerModelId}`,
          modelId: route.providerModelId
        };
        let reserved = false,
          settled = false;
        const reading = await new MediaClient({
          baseUrl: secret.baseUrl,
          apiKey: secret.apiKey!,
          appUrl: config.PUBLIC_APP_URL,
          openRouter: secret.provider === 'openrouter',
          timeoutSeconds: 60
        })
          .transcribe({
            model: route.providerModelId,
            privacyRoute,
            ...(input.externalConsent === true ? { externalConsent: true } : {}),
            audio: prepared.bytes,
            format: prepared.format,
            seconds: prepared.seconds,
            usdPerMinute: options.usdPerMinute,
            ...(route.pricing?.length ? { pricing: route.pricing } : {}),
            signal: controller.signal,
            onBeforeSubmit: async () => {
              const current = (await dictationOptionsFor(context, user.id)).options;
              if (!current.available || current.routeProof !== options.routeProof)
                throw new GardenError(
                  'dictation_selection_changed',
                  'The transcription connection or model changed. Review it again before sending this recording.',
                  409
                );
              await store.recordUsage({
                ...usage,
                costUsd: estimateUsd,
                state: 'reserved',
                reserveAgainstCaps: true
              });
              reserved = true;
            },
            onUsage: async (receipt) => {
              if (receipt.costKnown && !settled) {
                await store.recordUsage({
                  ...usage,
                  quantity: receipt.billedSeconds ?? prepared.seconds,
                  costUsd: receipt.costUsd,
                  state: 'settled',
                  settleReservation: true
                });
                settled = true;
              }
            }
          })
          .catch(async (error: unknown) => {
            if (reserved && !settled && error instanceof MediaProviderRejectionError)
              await store.recordUsage({
                ...usage,
                costUsd: 0,
                state: 'released',
                settleReservation: true
              });
            if (error instanceof GardenError) throw error;
            if (error instanceof TranscriptionEmptyError)
              throw new GardenError(
                'transcription_empty',
                'The model returned no speech from this recording',
                422
              );
            throw new GardenError(
              'transcription_failed',
              reserved && !settled && !(error instanceof MediaProviderRejectionError)
                ? 'The provider response could not be confirmed. Its spending reservation remains held; this recording will not be submitted again under the same request.'
                : 'The recording could not be transcribed',
              error instanceof MediaProviderRejectionError
                ? error.status === 429
                  ? 429
                  : 422
                : 503
            );
          });
        return encryptJson(
          {
            text: reading.text,
            model: route.providerModelId,
            privacyRoute,
            usage: {
              seconds: reading.billedSeconds ?? prepared.seconds,
              cost: reading.costKnown ? reading.costUsd : null,
              costSource: reading.costFromProvider
                ? 'provider'
                : reading.costKnown
                  ? 'quote'
                  : 'unresolved',
              ...(!reading.costKnown ? { reservationUsd: estimateUsd } : {})
            }
          },
          key,
          aad
        );
      } finally {
        preparing.delete(user.id);
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', closed);
      }
    });
    return decryptJson(sealed, key, aad);
  });
};
