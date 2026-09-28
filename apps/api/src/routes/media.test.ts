import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MediaSettings } from '@garden/contracts';
import { decryptJson, encryptJson, inferenceCredentialAad } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import type { InferenceSecret } from '../context.js';
import type { RouteContext, ServerBase } from '../http/server-context.js';
import { createServerSupport } from './support.js';
import { registerMediaRoutes } from './media.js';

const secret: InferenceSecret = {
  provider: 'openrouter',
  baseUrl: 'https://provider.example/v1',
  apiKey: 'fixture-key',
  enforceZeroDataRetention: true
};
const image = {
  id: 'vendor/draw',
  name: 'Draw',
  architecture: { output_modalities: ['image', 'text'] }
};
const endpoint = (tag: string, cost: number) => ({
  provider_tag: tag,
  supported_parameters: {
    n: { type: 'range', min: 1, max: 3 },
    output_format: { type: 'enum', values: ['png', 'webp'] }
  },
  pricing: [{ billable: 'output_image', unit: 'megapixel', cost_usd: cost }]
});

describe('selected media route through the authenticated settings API', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database),
    app = Fastify(),
    masterKey = Buffer.alloc(32, 43);
  let ownerId = '',
    fail = false;
  let duringResolve: (() => Promise<void>) | undefined;
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if (fail) throw new Error('offline fixture outage');
    const path = url instanceof Request ? url.url : String(url);
    const body = path.endsWith('/images/models/vendor/draw/endpoints')
      ? {
          endpoints: [
            endpoint('retaining', 0.001),
            endpoint('private-expensive', 0.08),
            endpoint('private', 0.014)
          ]
        }
      : {
          data: path.endsWith('/images/models')
            ? [image]
            : path.endsWith('/endpoints/zdr')
              ? ['private', 'private-expensive'].map((tag) => ({
                  model_id: image.id,
                  tag,
                  status: 0
                }))
              : []
        };
    return new Response(JSON.stringify(body));
  });
  let support: ReturnType<typeof createServerSupport>;
  beforeAll(async () => {
    await migrateDatabase(database);
    const owner = await store.createUser({ username: 'media-owner', displayName: 'Owner' });
    ownerId = owner.id;
    await store.upsertManagedProviderCredential({
      userId: ownerId,
      provider: 'inference',
      secretCiphertext: encryptJson(secret, masterKey, inferenceCredentialAad(ownerId)),
      externalRef: 'self-hosted',
      monthlyLimitUsd: 0,
      status: 'active'
    });
    support = createServerSupport({
      database,
      store,
      masterKey,
      overrides: { modelCatalogFetch: fetch },
      config: {},
      log: { warn: vi.fn() }
    } as unknown as ServerBase);
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      request.user = owner;
    });
    registerMediaRoutes({
      app,
      store,
      masterKey,
      ...support,
      mediaRoutesFor: async (...args: Parameters<typeof support.mediaRoutesFor>) => {
        const hook = duringResolve;
        duringResolve = undefined;
        await hook?.();
        return support.mediaRoutesFor(...args);
      },
      idempotent: async (
        _request: unknown,
        _reply: unknown,
        _user: unknown,
        execute: () => Promise<unknown>
      ) => execute()
    } as unknown as RouteContext);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('persists and returns the same private endpoint, typed quote and available controls', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/media/models',
      payload: {
        image: { automatic: false, preference: 'best', modelId: 'openrouter/vendor/draw' }
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    const settings = MediaSettings.parse(response.json());
    const effective = settings.modalities.find((m) => m.modality === 'image')?.effective;
    expect(effective).toMatchObject({
      providerEndpointTag: 'private',
      usdPerImage: null,
      pricing: [{ billable: 'output_image', unit: 'megapixel', costUsd: 0.014 }],
      capabilities: { parameters: { n: { type: 'range', min: 1, max: 3 } } }
    });
    const credential = await store.getManagedProviderCredential(ownerId, 'inference');
    expect(credential).toBeDefined();
    const saved = decryptJson<InferenceSecret>(
      credential!.secretCiphertext,
      masterKey,
      inferenceCredentialAad(ownerId)
    );
    expect(saved.mediaRoutes?.image).toEqual(effective);
    expect(
      fetch.mock.calls.filter(([url]) =>
        (url instanceof Request ? url.url : String(url)).includes(
          '/images/models/vendor/draw/endpoints'
        )
      )
    ).toHaveLength(1);
    expect(JSON.stringify(settings)).not.toContain(secret.apiKey);
  });

  it('keeps independent audio routes usable when automatic image endpoint hydration fails', async () => {
    const independent = createServerSupport({
      database,
      store,
      masterKey,
      config: {},
      log: { warn: vi.fn() },
      overrides: {
        modelCatalogFetch: async (url: string | URL | Request) => {
          const path = url instanceof Request ? url.url : String(url);
          if (path.endsWith('/images/models/vendor/draw/endpoints'))
            throw new Error('Image metadata unavailable');
          return Response.json({
            data: path.endsWith('/images/models')
              ? [image]
              : path.includes('output_modalities=speech')
                ? [
                    {
                      id: 'vendor/speaker',
                      name: 'Speaker',
                      architecture: { output_modalities: ['speech'] },
                      pricing: { prompt: '0.000001' }
                    }
                  ]
                : path.endsWith('/endpoints/zdr')
                  ? [
                      { model_id: image.id, tag: 'private', status: 0 },
                      { model_id: 'vendor/speaker', tag: 'private', status: 0 }
                    ]
                  : []
          });
        }
      }
    } as unknown as ServerBase);
    const routes = await independent.mediaRoutesFor(secret, undefined);
    expect(routes?.image?.unavailableReason).toContain('could not be verified');
    expect(routes?.audio?.providerModelId).toBe('vendor/speaker');
    await expect(
      independent.mediaRoutesFor(secret, {
        image: { automatic: false, preference: 'best', modelId: 'openrouter/vendor/draw' }
      })
    ).rejects.toThrow('selected media route is unavailable');
  });
  it('never transfers cached routes to another credential when discovery fails', async () => {
    fail = true;
    const catalog = await support.mediaCatalogFor({ ...secret, apiKey: 'another-key' });
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((model) => Boolean(model.unavailableReason))).toBe(true);
    expect(catalog.some((model) => model.providerModelId === image.id)).toBe(false);
    expect(await support.mediaCatalogFor({ ...secret, provider: 'openai-compatible' })).toEqual([]);
  });
  it('cannot overwrite a credential rotated while its media models were being verified', async () => {
    fail = false;
    duringResolve = async () => {
      const current = (await store.primaryInferenceCredential(ownerId))!;
      await store.upsertManagedProviderCredential({
        userId: ownerId,
        provider: current.provider,
        externalRef: 'self-hosted',
        monthlyLimitUsd: 0,
        secretCiphertext: encryptJson(
          { ...secret, apiKey: 'rotated-key' },
          masterKey,
          inferenceCredentialAad(ownerId)
        )
      });
    };
    const response = await app.inject({ method: 'PUT', url: '/v1/media/models', payload: {} });
    expect(response.statusCode, response.body).toBe(409);
    const latest = (await store.primaryInferenceCredential(ownerId))!;
    expect(
      decryptJson<InferenceSecret>(
        latest.secretCiphertext,
        masterKey,
        inferenceCredentialAad(ownerId)
      ).apiKey
    ).toBe('rotated-key');
  });
});
