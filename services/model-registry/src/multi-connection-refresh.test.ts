import { describe, expect, it } from 'vitest';
import { encryptJson, inferenceCredentialAad } from '@garden/core';
import { catalogCredentials } from './catalog-credential.js';
import { refreshOnce, type CatalogStore } from './refresh-once.js';

const masterKey = Buffer.alloc(32, 8),
  ownerId = 'registry-owner';
const rows = ['ollama-cloud', 'openai-compatible'].map((provider) => ({
  provider: `inference:${provider}`,
  status: 'active',
  secretCiphertext: encryptJson(
    {
      provider,
      baseUrl: `https://${provider}.example/v1`,
      apiKey: `${provider}-key`,
      enforceZeroDataRetention: true
    },
    masterKey,
    inferenceCredentialAad(ownerId)
  )
}));
const previous = ['ollama-cloud', 'openai-compatible'].map((connectionId) => ({
  id: `custom/${connectionId}/shared`,
  providerModelId: 'shared',
  provider: 'custom',
  connectionId,
  capabilities: ['chat', 'tools'],
  contextTokens: 128000
}));
function fixture() {
  const replaced: Array<Array<Record<string, unknown>>> = [];
  const store: CatalogStore = {
    soleUser: async () => ({ id: ownerId }),
    listManagedProviderCredentials: async () => rows,
    listModels: async () => previous,
    replaceModelCatalog: async (models) => {
      replaced.push(models);
    },
    upsertModels: async () => {
      throw new Error('A configured catalog must not be seeded');
    }
  };
  return { store, replaced };
}

describe('refreshing every saved connection', () => {
  it('reads vendor-keyed credentials and preserves independent vendors beside an operator registry key', async () => {
    const { store } = fixture();
    const credentials = await catalogCredentials({
      store,
      masterKey,
      environmentKey: 'registry-key'
    });
    expect(credentials.map((entry) => entry.provider)).toEqual([
      'openrouter',
      'ollama-cloud',
      'openai-compatible'
    ]);
    expect(credentials.map((entry) => entry.apiKey)).toEqual([
      'registry-key',
      'ollama-cloud-key',
      'openai-compatible-key'
    ]);
  });

  it('refreshes both catalogs with their own key and existing model facts', async () => {
    const { store, replaced } = fixture();
    const seen: string[] = [];
    const outcome = await refreshOnce({
      store,
      masterKey,
      baseUrl: 'https://openrouter.example/v1',
      scope: 'provider_catalog',
      configuredCatalog: async (input) => {
        expect(input.apiKey).toBe(`${input.provider}-key`);
        expect(input.previous).toHaveLength(1);
        expect(input.previous[0]?.connectionId).toBe(input.provider);
        seen.push(input.provider);
        return input.previous.map((model) => ({ ...model, contextTokens: 256000 }));
      }
    });
    expect(seen).toEqual(['ollama-cloud', 'openai-compatible']);
    expect(replaced).toHaveLength(2);
    expect(outcome).toEqual({ state: 'refreshed', models: 2, reason: null });
  });

  it('preserves a failed provider catalog and still refreshes the other provider', async () => {
    const { store, replaced } = fixture();
    const outcome = await refreshOnce({
      store,
      masterKey,
      baseUrl: 'https://openrouter.example/v1',
      scope: 'provider_catalog',
      configuredCatalog: async (input) => {
        if (input.provider === 'ollama-cloud') throw new Error('Provider temporarily unavailable');
        return input.previous.map((model) => ({ ...model, contextTokens: 256000 }));
      }
    });
    expect(outcome.state).toBe('failed');
    expect(outcome.models).toBe(2);
    expect(outcome.reason).toContain('temporarily unavailable');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.[0]?.connectionId).toBe('openai-compatible');
  });
});

describe('named accounts during scheduled catalog refresh', () => {
  it.each([
    { failNamed: false, legacyId: undefined },
    { failNamed: true, legacyId: undefined },
    { failNamed: false, legacyId: 'custom' },
    { failNamed: true, legacyId: 'custom' }
  ])(
    'retains account identity and model facts across legacy rows and endpoint failure: %j',
    async ({ failNamed, legacyId }) => {
      const ids = [
        'openai-compatible',
        'openai-compatible:10000000-0000-4000-8000-000000000001',
        'openai-compatible:10000000-0000-4000-8000-000000000002'
      ];
      const records = ids.map((connectionId, index) => ({
        id: `custom/account-${index}/shared`,
        providerModelId: 'shared',
        provider: 'custom',
        ...(index ? { connectionId } : legacyId ? { connectionId: legacyId } : {}),
        recommendationTags: ['Configured endpoint'],
        capabilities: ['chat', 'tools'],
        contextTokens: 128000 + index * 1000
      }));
      const credentials = ids.map((connectionId, index) => ({
        provider: `inference:${connectionId}`,
        status: 'active',
        secretCiphertext: encryptJson(
          {
            connectionId,
            provider: 'openai-compatible',
            baseUrl: `https://account-${index}.example/v1`,
            apiKey: `account-${index}-key`,
            enforceZeroDataRetention: true
          },
          masterKey,
          inferenceCredentialAad(ownerId)
        )
      }));
      const { store, replaced } = fixture();
      store.listManagedProviderCredentials = async () => credentials;
      store.listModels = async () => records;
      const seen: Array<{
        connectionId: string | undefined;
        key: string | undefined;
        previousIds: unknown[];
      }> = [];
      const outcome = await refreshOnce({
        store,
        masterKey,
        baseUrl: 'https://openrouter.example/v1',
        scope: 'provider_catalog',
        configuredCatalog: async (input) => {
          seen.push({
            connectionId: input.connectionId,
            key: input.apiKey,
            previousIds: input.previous.map((row) => row.id)
          });
          if (failNamed && input.apiKey === 'account-1-key')
            throw new Error('Named endpoint temporarily unavailable');
          return input.previous.map((row) => ({
            ...row,
            contextTokens: Number(row.contextTokens) + 1000
          }));
        }
      });
      expect(outcome).toEqual({
        state: failNamed ? 'failed' : 'refreshed',
        models: 3,
        reason: failNamed ? 'Named endpoint temporarily unavailable' : null
      });
      expect(seen).toEqual(
        ids.map((connectionId, index) => ({
          connectionId,
          key: `account-${index}-key`,
          previousIds: [`custom/account-${index}/shared`]
        }))
      );
      expect(replaced).toHaveLength(failNamed ? 2 : 3);
      expect(
        replaced.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            connectionId: row.connectionId,
            contextTokens: row.contextTokens
          }))
        )
      ).toEqual(
        ids.flatMap((connectionId, index) =>
          failNamed && index === 1
            ? []
            : [
                [
                  {
                    id: `custom/account-${index}/shared`,
                    connectionId,
                    contextTokens: 129000 + index * 1000
                  }
                ]
              ]
        )
      );
    }
  );
});
