import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRelease } from '@garden/contracts';
import { decryptJson, encryptJson, inferenceCredentialAad, modelConnectionId } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import type { RouteContext, ServerBase } from '../http/server-context.js';
import type { InferenceSecret } from '../context.js';
import { createServerSupport } from './support.js';
import { registerProviderRoutes } from './providers.js';

describe('saved provider connection lifecycle', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database),
    app = Fastify(),
    masterKey = Buffer.alloc(32, 24);
  let userId = '',
    rejectMedia = false;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const catalogFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = url instanceof Request ? url.url : String(url);
    calls.push({ url: address, authorization: new Headers(init?.headers).get('authorization') });
    return new Response(
      JSON.stringify({
        data: [
          { id: 'shared/model', name: 'Shared model', context_length: 128000 },
          { id: 'another-model', name: 'Another model', context_length: 64000 }
        ]
      })
    );
  });
  let support: ReturnType<typeof createServerSupport>;
  beforeAll(async () => {
    await migrateDatabase(database);
    const user = await store.createUser({ username: 'connection-owner', displayName: 'Owner' });
    userId = user.id;
    const base = {
      app,
      database,
      store,
      masterKey,
      config: {
        AI_PROVIDER: 'openrouter',
        AI_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        AI_REQUIRE_ZDR: true,
        PUBLIC_APP_URL: 'https://garden.example',
        ALLOW_INSECURE_PROVIDER_URLS: false,
        MODEL_CATALOG_SCOPE: 'provider_catalog'
      },
      overrides: { modelCatalogFetch: catalogFetch },
      log: { warn: vi.fn(), info: vi.fn() }
    } as unknown as ServerBase;
    support = createServerSupport(base);
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      request.user = user;
    });
    registerProviderRoutes({
      ...base,
      ...support,
      requireRecentStepUp: async () => undefined,
      idempotent: async (
        _request: unknown,
        _reply: unknown,
        _user: unknown,
        execute: () => Promise<unknown>
      ) => execute(),
      mediaRoutesFor: async () => {
        if (rejectMedia) throw new Error('Media verification failed');
        return {};
      },
      resumeTasksWaitingOnAProvider: async () => 0
    } as unknown as RouteContext);
    await app.ready();
  });
  beforeEach(async () => {
    await database.query('DELETE FROM model_releases');
    await database.query('DELETE FROM managed_provider_credentials');
    calls.length = 0;
    rejectMedia = false;
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });
  const connect = (provider: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'PUT',
      url: '/v1/providers',
      payload: {
        provider,
        enforceZeroDataRetention: true,
        ...(provider === 'openai-compatible' ? { baseUrl: 'https://compatible.example/v1' } : {}),
        ...extra
      }
    });

  it('discovers both catalogs, preserves exact model identity and removes only the selected connection', async () => {
    for (const provider of ['ollama-cloud', 'openai-compatible']) {
      const response = await connect(provider, { apiKey: `${provider}-key` });
      expect(response.statusCode, response.body).toBe(200);
    }
    const models = (await store.listModels()).map((record) => ModelRelease.parse(record));
    expect(models).toHaveLength(4);
    const shared = models.filter((model) => model.providerModelId === 'shared/model');
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((model) => model.id)).size).toBe(2);
    expect(
      shared.map((model) => modelConnectionId(model, ['ollama-cloud', 'openai-compatible'])).sort()
    ).toEqual(['ollama-cloud', 'openai-compatible']);
    const settings = (await app.inject({ method: 'GET', url: '/v1/providers' })).json<{
      connections: unknown[];
    }>();
    expect(settings.connections).toHaveLength(2);
    expect(JSON.stringify(settings)).not.toContain('ollama-cloud-key');
    expect(JSON.stringify(settings)).not.toContain('openai-compatible-key');
    const removed = await app.inject({
      method: 'DELETE',
      url: '/v1/providers?connectionId=ollama-cloud'
    });
    expect(removed.json()).toEqual({ deleted: true });
    const remaining = await support.inferenceConnections(userId);
    expect([...remaining.keys()]).toEqual(['openai-compatible']);
    const user = (await store.getUserById(userId))!;
    const reachable = await support.modelsForUser(user);
    expect(reachable).toHaveLength(2);
    expect(reachable.every((model) => model.connectionId === 'openai-compatible')).toBe(true);
  });

  it('saves named endpoints independently, binds duplicate model names and removes only one account', async () => {
    const first = 'openai-compatible:10000000-0000-4000-8000-000000000001';
    const second = 'openai-compatible:10000000-0000-4000-8000-000000000002';
    for (const [connectionId, label, baseUrl, apiKey] of [
      [first, 'Work', 'https://work.example/v1', 'work-account-key'],
      [second, 'Research', 'https://research.example/v1', 'research-account-key']
    ]) {
      const response = await connect('openai-compatible', { connectionId, label, baseUrl, apiKey });
      expect(response.statusCode, response.body).toBe(200);
    }
    const user = (await store.getUserById(userId))!;
    const models = await support.modelsForUser(user);
    const shared = models.filter((model) => model.providerModelId === 'shared/model');
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((model) => model.id)).size).toBe(2);
    expect(shared.map((model) => model.connectionLabel).sort()).toEqual(['Research', 'Work']);
    const settings = (await app.inject({ method: 'GET', url: '/v1/providers' })).json<{
      connections: Array<{ connectionId: string; label: string }>;
    }>();
    expect(settings.connections).toHaveLength(2);
    expect(JSON.stringify(settings)).not.toContain('-account-key');
    calls.length = 0;
    const edited = await connect('openai-compatible', {
      connectionId: first,
      label: 'Work renamed',
      baseUrl: 'https://work.example/v1'
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.authorization === 'Bearer work-account-key')).toBe(true);
    expect((await support.inferenceConnections(userId)).get(second)?.secret.apiKey).toBe(
      'research-account-key'
    );
    const cleared = await connect('openai-compatible', {
      connectionId: first,
      label: '',
      baseUrl: 'https://work.example/v1'
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await support.inferenceConnections(userId)).get(first)?.secret.label).toBe(
      'work.example'
    );
    expect((await support.inferenceConnections(userId)).get(second)?.secret.label).toBe('Research');
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/providers?connectionId=${encodeURIComponent(first)}`
    });
    expect(removed.statusCode).toBe(200);
    expect([...(await support.inferenceConnections(userId)).keys()]).toEqual([second]);
    const remaining = await support.modelsForUser(user);
    expect(remaining).toHaveLength(2);
    expect(remaining.every((model) => model.connectionId === second)).toBe(true);
  });

  it('connects model companies from the preset list side by side, each on its own protocol', async () => {
    const claude = 'openai-compatible:10000000-0000-4000-8000-000000000004';
    const gemini = 'openai-compatible:10000000-0000-4000-8000-000000000005';
    const saves = [
      [claude, 'anthropic', 'anthropic-key'],
      [gemini, 'google', 'gemini-key']
    ] as const;
    for (const [connectionId, vendor, apiKey] of saves) {
      const response = await connect('openai-compatible', {
        connectionId,
        vendor,
        apiKey,
        baseUrl: undefined
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    // The address came from the preset, and each vendor heard its own key its own way.
    const anthropic = calls.filter((call) => call.url.startsWith('https://api.anthropic.com/v1/'));
    const google = calls.filter((call) =>
      call.url.startsWith('https://generativelanguage.googleapis.com/v1beta/openai/')
    );
    expect(anthropic.length).toBeGreaterThan(0);
    expect(google.length).toBeGreaterThan(0);
    expect(anthropic.every((call) => call.authorization === null)).toBe(true);
    expect(google.every((call) => call.authorization === 'Bearer gemini-key')).toBe(true);
    const settings = (await app.inject({ method: 'GET', url: '/v1/providers' })).json<{
      connections: Array<{ connectionId: string; label: string; vendor: string | null }>;
      vendors: Array<{ id: string; keyUrl: string }>;
    }>();
    expect(settings.vendors.map((vendor) => vendor.id)).toEqual(
      expect.arrayContaining(['anthropic', 'openai', 'google'])
    );
    expect(
      settings.connections.map(({ connectionId, label, vendor }) => ({
        connectionId,
        label,
        vendor
      }))
    ).toEqual(
      expect.arrayContaining([
        { connectionId: claude, label: 'Anthropic', vendor: 'anthropic' },
        { connectionId: gemini, label: 'Google Gemini', vendor: 'google' }
      ])
    );
    const user = (await store.getUserById(userId))!;
    const labels = new Set(
      (await support.modelsForUser(user)).map((model) => model.connectionLabel)
    );
    expect(labels).toEqual(new Set(['Anthropic', 'Google Gemini']));
  });

  it('refuses a preset without a key, on another protocol or that is not on the list', async () => {
    const connectionId = 'openai-compatible:10000000-0000-4000-8000-000000000006';
    // The server's error handler turns the schema refusals into a 400; this app has none, so the
    // reason is what the assertion reads.
    for (const [provider, extra, reason] of [
      ['openai-compatible', { connectionId, vendor: 'anthropic' }, 'Anthropic requires an API key'],
      [
        'ollama-cloud',
        { vendor: 'anthropic', apiKey: 'key' },
        'A listed provider is saved as its own compatible connection'
      ],
      [
        'openai-compatible',
        { connectionId, vendor: 'nobody', apiKey: 'key' },
        'Choose a listed provider'
      ]
    ] as const) {
      const response = await connect(provider, { ...extra, baseUrl: undefined });
      expect(response.statusCode).not.toBe(200);
      expect(response.body).toContain(reason);
    }
    expect(calls).toHaveLength(0);
  });

  it('does not borrow a saved key for a newly named account at the same endpoint', async () => {
    expect((await connect('openai-compatible', { apiKey: 'default-key' })).statusCode).toBe(200);
    calls.length = 0;
    const response = await connect('openai-compatible', {
      connectionId: 'openai-compatible:10000000-0000-4000-8000-000000000003'
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.authorization === null)).toBe(true);
  });

  it('rejects malformed identities or a connection belonging to a different protocol before discovery', async () => {
    for (const connectionId of [
      'openai-compatible:../escape',
      'ollama-cloud',
      'openrouter:10000000-0000-4000-8000-000000000003'
    ]) {
      const response = await connect('openai-compatible', {
        connectionId,
        apiKey: 'must-not-be-sent'
      });
      expect(response.statusCode).toBe(422);
    }
    expect(calls).toHaveLength(0);
  });

  it('keeps the chosen vendor key when a different vendor was edited most recently', async () => {
    expect((await connect('ollama-cloud', { apiKey: 'ollama-key' })).statusCode).toBe(200);
    expect((await connect('openai-compatible', { apiKey: 'compatible-key' })).statusCode).toBe(200);
    calls.length = 0;
    const saved = await connect('ollama-cloud');
    expect(saved.statusCode, saved.body).toBe(200);
    const requests = calls.filter((call) => call.url.startsWith('https://ollama.com/'));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((call) => call.authorization === 'Bearer ollama-key')).toBe(true);
  });

  it('refuses to send a saved key to a changed endpoint and leaves the saved connection intact', async () => {
    expect((await connect('openai-compatible', { apiKey: 'private-key' })).statusCode).toBe(200);
    calls.length = 0;
    const changed = await connect('openai-compatible', { baseUrl: 'https://different.example/v1' });
    expect(changed.statusCode).toBe(422);
    expect(calls).toHaveLength(0);
    expect(
      (await support.inferenceConnections(userId)).get('openai-compatible')?.secret
    ).toMatchObject({ baseUrl: 'https://compatible.example/v1', apiKey: 'private-key' });
  });

  it('persists fallback metadata and an optional restriction without changing other connections', async () => {
    const response = await connect('openai-compatible', {
      apiKey: 'key',
      modelId: 'shared/model',
      contextTokens: 98304,
      capabilities: ['chat', 'tools'],
      modalities: ['text']
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      modelId: 'shared/model',
      contextTokens: 98304,
      capabilities: ['chat', 'tools']
    });
    expect(await store.listModels()).toHaveLength(1);
    const credential = (await store.getManagedProviderCredential(
      userId,
      'inference:openai-compatible'
    ))!;
    expect(
      decryptJson<InferenceSecret>(
        credential.secretCiphertext,
        masterKey,
        inferenceCredentialAad(userId)
      ).catalogDefaults
    ).toMatchObject({ contextTokens: 98304, capabilities: ['chat', 'tools'] });
  });

  it('does not write a catalog or credential if explicit media verification fails', async () => {
    rejectMedia = true;
    const failed = await connect('openai-compatible', {
      apiKey: 'key',
      mediaModels: { image: { automatic: true, preference: 'balanced' } }
    });
    expect(failed.statusCode).toBe(500);
    expect(await store.listModels()).toHaveLength(0);
    expect(await store.listManagedProviderCredentials(userId)).toHaveLength(0);
  });

  it('preserves an existing legacy model id when its source identifies the same vendor', async () => {
    const first = await connect('ollama-cloud', { apiKey: 'key' });
    expect(first.statusCode).toBe(200);
    const model = (await store.listModels()).find(
      (entry) => entry.providerModelId === 'shared/model'
    )!;
    await database.query('DELETE FROM model_releases');
    await store.upsertModels([{ ...model, id: 'custom/shared/model', connectionId: undefined }]);
    await store.upsertManagedProviderCredential({
      userId,
      provider: 'inference',
      monthlyLimitUsd: 0,
      externalRef: 'legacy',
      secretCiphertext: encryptJson(
        {
          provider: 'ollama-cloud',
          baseUrl: 'https://ollama.com/v1',
          apiKey: 'legacy-key',
          enforceZeroDataRetention: true
        },
        masterKey,
        inferenceCredentialAad(userId)
      )
    });
    expect((await connect('ollama-cloud', { apiKey: 'new-key' })).statusCode).toBe(200);
    const preserved = (await store.listModels()).filter(
      (entry) => entry.providerModelId === 'shared/model'
    );
    expect(preserved).toHaveLength(1);
    expect(preserved[0]).toMatchObject({ id: 'custom/shared/model', connectionId: 'ollama-cloud' });
    expect((await support.inferenceConnections(userId)).get('ollama-cloud')?.secret.apiKey).toBe(
      'new-key'
    );
  });
});
