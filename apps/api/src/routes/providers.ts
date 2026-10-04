/**
 * The account this box calls a model with.
 *
 * Saving a key is the one write that takes a wall down: everything parked in `awaiting_resource`
 * goes back in the queue from here rather than waiting out a backoff that was measuring the wrong
 * thing. Saving the first key is also where a spending ceiling is put in place, because a box with
 * a key and no ceiling is a box that can spend a month's allowance overnight.
 */

import { MediaModelSelection } from '@garden/contracts';
import {
  GardenError,
  assertTimeZone,
  decryptJson,
  encryptJson,
  inferenceCredentialAad,
  inferenceConnectionProvider,
  environmentInferenceSecret
} from '@garden/core';
import {
  createModelAdapter,
  configuredModelCatalog,
  refreshOpenRouterCatalog,
  seedModels,
  vendorPreset,
  verifyOpenRouterKey,
  withListPrices
} from '@garden/model-gateway';
import { z } from 'zod';
import { DataStore } from '@garden/data';
import type { InferenceSecret } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { recordSecurityEvent } from '../security-events.js';
import { privateProviderAddress } from '../provider-address.js';

/**
 * The two ceilings a first connection puts in place, from the one number the owner was asked for.
 *
 * A month is the unit a provider bill arrives in and the only one worth asking for at a keyboard.
 * The day is what makes a monthly ceiling mean anything overnight: a loop that has gone wrong can
 * spend a month's allowance between two and six in the morning without ever crossing a monthly cap.
 * A quarter of the month in a single day is far above ordinary use and far below a runaway, and the
 * agent asks the guard again at every step, against money that has actually changed hands - so a
 * run that goes wrong at 2am is stopped by the day's ceiling within a step of reaching it.
 *
 * A per-conversation ceiling is deliberately NOT seeded, and it is the one number here that cannot
 * be chosen well without knowing what the owner does. Unlike the other two it is enforced by
 * reservation: a conversation that is queued or running holds its whole ceiling against the day
 * whether or not it spends a penny of it. Seed a tenth of the month and the third conversation of
 * the morning is refused for money nobody has spent, which reads as the product being broken rather
 * than as a setting. It remains under Spending caps for an owner who wants one, sized to the way
 * they work.
 */
const seededSpendCaps = (
  monthlyCapUsd: number
): { monthlyCapUsd: number; dailyCapUsd: number; defaultTaskCapUsd: null } => ({
  monthlyCapUsd,
  dailyCapUsd: Math.round(monthlyCapUsd * 25) / 100,
  defaultTaskCapUsd: null
});

export const registerProviderRoutes = (context: RouteContext): void => {
  const {
    app,
    database,
    store,
    masterKey,
    providerSettings,
    inferenceConnections,
    mediaRoutesFor,
    config,
    overrides,
    requireRecentStepUp,
    idempotent,
    resumeTasksWaitingOnAProvider
  } = context;
  app.get('/v1/providers', async (request) => providerSettings(requireUser(request.user).id));

  app.put('/v1/providers', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = z
        .object({
          provider: z.enum(['openrouter', 'ollama-cloud', 'openai-compatible']),
          localEndpoint: z.boolean().default(false),
          /**
           * A model company from the preset list. It fixes the address and names the connection;
           * the connection itself is an ordinary named compatible endpoint, so several companies
           * can be connected side by side.
           */
          vendor: z
            .string()
            .max(40)
            .refine((id) => vendorPreset(id) !== null, 'Choose a listed provider')
            .optional(),
          connectionId: z.string().max(100).optional(),
          label: z.string().trim().max(80).optional(),
          baseUrl: z.string().url().optional(),
          apiKey: z.string().max(2_000).optional(),
          modelId: z.string().trim().min(1).max(300).optional(),
          enforceZeroDataRetention: z.boolean().default(true),
          contextTokens: z.number().int().min(4_096).max(10_000_000).optional(),
          capabilities: z
            .array(z.enum(['chat', 'vision', 'tools', 'reasoning', 'embedding']))
            .min(1)
            .default(['chat', 'tools', 'reasoning']),
          modalities: z
            .array(z.enum(['text', 'image', 'audio', 'video']))
            .min(1)
            .default(['text']),
          /**
           * Which model generates an image and which speaks. Absent leaves whatever was saved
           * before, so the screen can save a key without also having to restate a media choice it
           * did not touch.
           */
          mediaModels: MediaModelSelection.optional(),
          /**
           * The answer to the one question about money worth asking at this moment, and the only
           * moment it is worth asking: saving a key is when spending becomes possible at all, and
           * the owner is already thinking about a bill. Absent means this save was not about money;
           * an explicit null is the owner declining a ceiling, which is theirs to decline on their
           * own computer - what is not acceptable is a cap system that is off because nobody asked.
           */
          spendCeiling: z
            .object({
              monthlyCapUsd: z.number().positive().max(1_000_000).nullable(),
              timeZone: z.string().min(1).max(100).optional()
            })
            .optional()
        })
        .superRefine((value, context) => {
          if (value.localEndpoint && (value.provider !== 'openai-compatible' || value.vendor))
            context.addIssue({
              code: 'custom',
              path: ['localEndpoint'],
              message: 'Choose a compatible local endpoint'
            });
          if (value.localEndpoint && value.contextTokens === undefined)
            context.addIssue({
              code: 'custom',
              path: ['contextTokens'],
              message: 'Enter the context window configured on the local server'
            });
          if (value.vendor && value.provider !== 'openai-compatible')
            context.addIssue({
              code: 'custom',
              path: ['vendor'],
              message: 'A listed provider is saved as its own compatible connection'
            });
          // Ollama Cloud does not need a model named by hand: the catalogue below lists every model
          // that account can reach, the same way OpenRouter's does, so a named model is an optional
          // pin.
          if (value.spendCeiling?.timeZone !== undefined) {
            try {
              assertTimeZone(value.spendCeiling.timeZone);
            } catch {
              context.addIssue({
                code: 'custom',
                path: ['spendCeiling', 'timeZone'],
                message: 'Choose a valid IANA time zone'
              });
            }
          }
        })
        .parse(request.body);
      const connectionId = input.connectionId ?? input.provider;
      const preset = vendorPreset(input.vendor);
      const contextTokens = input.contextTokens ?? preset?.contextTokens ?? 128_000;
      if (inferenceConnectionProvider(connectionId) !== input.provider)
        throw new GardenError(
          'provider_connection_invalid',
          'Choose a connection for this provider',
          422
        );
      const baseUrl =
        input.provider === 'openrouter'
          ? 'https://openrouter.ai/api/v1'
          : input.provider === 'ollama-cloud'
            ? 'https://ollama.com/v1'
            : (preset?.baseUrl ?? input.baseUrl ?? config.AI_BASE_URL);
      const existingSecret = (await inferenceConnections(user.id)).get(connectionId)?.secret;
      const sameEndpoint = (secret: InferenceSecret | undefined) =>
        secret?.provider === input.provider &&
        secret.baseUrl.replace(/\/+$/, '') === baseUrl.replace(/\/+$/, '');
      const environment = environmentInferenceSecret(config);
      const apiKey =
        input.apiKey?.trim() ||
        (sameEndpoint(existingSecret) ? existingSecret?.apiKey : undefined) ||
        (!existingSecret && connectionId === input.provider && sameEndpoint(environment)
          ? environment.apiKey
          : undefined);
      if (!input.apiKey?.trim() && existingSecret?.apiKey && !sameEndpoint(existingSecret))
        throw new GardenError(
          'provider_key_required',
          'Enter the key issued for this endpoint. A saved key cannot be sent to a different endpoint.',
          422
        );
      if ((['openrouter', 'ollama-cloud'].includes(input.provider) || preset) && !apiKey)
        throw new GardenError(
          'provider_key_required',
          `${preset?.label ?? (input.provider === 'openrouter' ? 'OpenRouter' : 'Ollama Cloud')} requires an API key`,
          422
        );
      const url = new URL(baseUrl);
      if (url.username || url.password || url.search || url.hash)
        throw new GardenError(
          'provider_url_invalid',
          'Provider URLs cannot contain credentials, query parameters, or fragments'
        );
      if (input.localEndpoint && !privateProviderAddress(url))
        throw new GardenError(
          'provider_url_invalid',
          'Use localhost or a private LAN IP address for a local endpoint',
          422
        );
      const privateHttp = url.protocol === 'http:' && privateProviderAddress(url);
      if (
        url.protocol !== 'https:' &&
        !((config.ALLOW_INSECURE_PROVIDER_URLS || input.localEndpoint) && privateHttp)
      )
        throw new GardenError(
          'provider_url_insecure',
          'Use HTTPS, or explicitly allow private HTTP provider URLs on this server'
        );
      /*
       * The key is proven before any of the work below reports success.
       *
       * Every other call this route makes for an OpenRouter key - the catalogue refresh's `/models`
       * and `/endpoints/zdr` - is a public route that answers 200 anonymously. Without `/key`, the
       * screen's "Verify and save" would verify the provider was reachable and nothing about the
       * credential, and a mistyped or revoked key would be stored, encrypted, under a green success
       * message. `/key` is the one call the provider gates, and it is made first so a refusal costs
       * one request and leaves the previously saved credential untouched.
       */
      if (input.provider === 'openrouter')
        await verifyOpenRouterKey({
          baseUrl,
          apiKey: apiKey!,
          ...(overrides.modelCatalogFetch ? { fetch: overrides.modelCatalogFetch } : {})
        });
      const adapter = createModelAdapter({
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        provider: input.provider === 'openrouter' ? 'openrouter' : 'custom',
        privacyRoute: input.enforceZeroDataRetention ? 'provider_zdr' : 'external',
        appUrl: config.PUBLIC_APP_URL,
        appTitle: 'garden',
        ...(overrides.modelCatalogFetch ? { fetch: overrides.modelCatalogFetch } : {}),
        enforceZeroDataRetention: input.provider === 'openrouter' && input.enforceZeroDataRetention
      });
      let pendingModels: Array<Record<string, unknown>>;
      if (input.provider === 'openrouter') {
        // No `adapter.list()` in this arm: its answer would only be read by the branch below, so an
        // OpenRouter save would spend a whole extra round trip on a list it discarded before asking
        // for the catalogue it actually wants.
        const liveModels = await refreshOpenRouterCatalog(seedModels(), {
          baseUrl,
          apiKey: apiKey!,
          scope: config.MODEL_CATALOG_SCOPE,
          ...(overrides.modelCatalogFetch ? { fetch: overrides.modelCatalogFetch } : {})
        });
        pendingModels = liveModels.map((model) => ({ ...model, connectionId }));
      } else {
        /*
         * One request, read twice as hard.
         *
         * `describe` asks the same `/models` route `list` did and keeps the context windows,
         * output limits, prices and supported parameters the endpoint published, instead of
         * throwing them away and having the owner type a context window in a form. It is also the
         * only credential check available here: OpenRouter has `/key`, a route it gates and this
         * server calls above, and no equivalent is confirmed anywhere in this repository for
         * Ollama Cloud - so a 401 or 403 from the models route is treated as a rejected key, and
         * anything else that fails is reported as unreachable rather than as verified.
         */
        const described = await adapter.describe(AbortSignal.timeout(15_000)).catch((error) => {
          const status = error instanceof GardenError ? /\b(\d{3})$/.exec(error.message)?.[1] : '';
          if (status === '401' || status === '403')
            throw new GardenError(
              'provider_key_rejected',
              'The provider did not accept this key. Paste it again whole — a trailing space or a missing character is enough — and check it has not been revoked.',
              422
            );
          throw error;
        });
        if (input.modelId && !described.some((model) => model.id === input.modelId))
          throw new GardenError(
            'provider_model_not_found',
            `The endpoint did not list model ${input.modelId}`,
            422
          );
        const catalogue = input.modelId
          ? described.filter((model) => model.id === input.modelId)
          : described;
        if (!catalogue.length)
          throw new GardenError(
            'provider_model_not_found',
            'The endpoint listed no models for this key',
            422
          );
        const listed = configuredModelCatalog(catalogue, {
          privacyRoute: input.enforceZeroDataRetention ? 'provider_zdr' : 'external',
          contextTokens,
          capabilities: input.capabilities,
          modalities: input.modalities,
          tag: input.provider === 'ollama-cloud' ? 'Ollama Cloud' : 'Configured endpoint',
          connectionId,
          previous: (await store.listModels()).filter(
            (record) =>
              record.connectionId === connectionId ||
              (connectionId === input.provider &&
                !record.connectionId &&
                Array.isArray(record.recommendationTags) &&
                record.recommendationTags.includes(
                  input.provider === 'ollama-cloud' ? 'Ollama Cloud' : 'Configured endpoint'
                ))
          )
        });
        // A company's own endpoint lists no prices; its published list prices stand in for them,
        // so spending limits count these calls at what they cost rather than at a guess.
        pendingModels = await withListPrices(
          listed,
          baseUrl,
          overrides.modelCatalogFetch ?? globalThis.fetch
        );
      }
      /*
       * Carried forward when this save did not mention it, and dropped when the provider changes.
       * A media id only means something against the account that listed it, so keeping an image
       * model pinned across a move to another provider would leave the choice pointing at a route
       * the new key cannot reach - and the first anyone would hear of it is a failed generation
       * mid-task.
       */
      const mediaModels =
        input.mediaModels ??
        (existingSecret?.provider === input.provider ? existingSecret.mediaModels : undefined);
      const connectionLabel =
        (input.label === undefined ? existingSecret?.label : input.label) ||
        preset?.label ||
        (connectionId !== input.provider ? new URL(baseUrl).hostname : undefined);
      const saved: InferenceSecret = {
        connectionId,
        ...(connectionLabel ? { label: connectionLabel } : {}),
        provider: input.provider,
        localEndpoint: input.localEndpoint,
        ...(preset ? { vendor: preset.id } : {}),
        catalogDefaults: {
          contextTokens,
          capabilities: input.capabilities,
          modalities: input.modalities
        },
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        enforceZeroDataRetention: input.enforceZeroDataRetention,
        ...(mediaModels ? { mediaModels } : {})
      };
      // Seal account-specific routes once; the worker never borrows another provider's defaults.
      const mediaRoutes = mediaModels
        ? await mediaRoutesFor(saved, mediaModels)
        : await mediaRoutesFor(saved, undefined).catch(() => ({}));
      await database.transaction(async (transaction) => {
        const target = new DataStore(transaction);
        await target.replaceModelCatalog(pendingModels);
        await target.upsertManagedProviderCredential({
          userId: user.id,
          provider: `inference:${connectionId}`,
          secretCiphertext: encryptJson(
            { ...saved, ...(mediaRoutes ? { mediaRoutes } : {}) },
            masterKey,
            inferenceCredentialAad(user.id)
          ),
          externalRef: 'self-hosted',
          monthlyLimitUsd: 0,
          status: 'active'
        });
      });
      await recordSecurityEvent(store, {
        userId: user.id,
        kind: 'inference_provider_configured',
        outcome: 'completed',
        metadata: { provider: input.provider, ...(preset ? { vendor: preset.id } : {}) }
      });
      /*
       * A ceiling only ever gets put in place here, never moved.
       *
       * Without this every cap ships null, the guard builds no window for a null cap, and the whole
       * DST-correct, commitment-aware machinery refuses nothing until the owner goes looking for a
       * setting they do not know exists. The answer given at the keyboard is written once, and only
       * onto a box that has never had spending limits of any kind - so re-saving a key years later
       * cannot quietly undo caps the owner has since chosen, and declining is a decision this
       * records rather than a question it asks again.
       */
      if (input.spendCeiling && !(await store.getSpendLimits(user.id))) {
        const { monthlyCapUsd, timeZone } = input.spendCeiling;
        await store.setSpendLimits({
          userId: user.id,
          ...(monthlyCapUsd === null
            ? { dailyCapUsd: null, monthlyCapUsd: null, defaultTaskCapUsd: null }
            : seededSpendCaps(monthlyCapUsd)),
          ...(timeZone ? { timeZone } : {})
        });
      }
      // A key is the one wall a person takes down by hand, so the work behind it goes now rather
      // than on the retry sweep's clock.
      await resumeTasksWaitingOnAProvider(user.id);
      return providerSettings(user.id);
    });
  });

  app.delete('/v1/providers', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      /*
       * Disconnecting takes every connection, not one row called `inference`.
       *
       * An account can hold several now, and a delete that removed only the legacy key would leave
       * a box reporting no provider while the worker still held a usable one - which is worse than
       * either state on its own.
       */
      const query = z
        .object({
          connectionId: z
            .string()
            .max(100)
            .refine((id) => inferenceConnectionProvider(id) !== null)
            .optional()
        })
        .parse(request.query);
      const connections = await store.listManagedProviderCredentials(user.id);
      const selected = query.connectionId;
      let deleted = false;
      for (const connection of connections) {
        if (selected) {
          const vendor =
            connection.provider === 'openrouter'
              ? 'openrouter'
              : connection.provider === 'inference'
                ? decryptJson<InferenceSecret>(
                    connection.secretCiphertext,
                    masterKey,
                    inferenceCredentialAad(user.id)
                  ).provider
                : connection.provider.slice('inference:'.length);
          if (vendor !== selected) continue;
        }
        deleted =
          (await store.removeManagedProviderCredential(user.id, connection.provider)) || deleted;
      }
      return { deleted };
    });
  });
};
