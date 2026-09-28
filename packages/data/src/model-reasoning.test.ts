import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ReasoningOptions } from '@garden/contracts';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore } from './store.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
beforeAll(async () => migrateDatabase(database));
afterAll(async () => database.close());

it('preserves exact reasoning controls through catalogue replacement and refresh', async () => {
  const options: Array<ReasoningOptions | undefined> = [
    { mandatory: true, supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'max' },
    {
      mandatory: false,
      supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'none'],
      defaultEnabled: false
    },
    { mandatory: false, supportedEfforts: null, supportsMaxTokens: true },
    { mandatory: true, supportedEfforts: [] },
    undefined
  ];
  const models = options.map((reasoning, index) => ({
    id: `custom/reasoning-${index}`,
    providerModelId: `reasoning-${index}`,
    displayName: `Reasoning ${index}`,
    provider: 'custom',
    revision: 'live',
    availability: 'available',
    openness: 'remote_proprietary',
    license: 'Provider-defined',
    commercialUse: true,
    privacyRoute: 'provider_zdr',
    contextTokens: 128000,
    modalities: ['text'],
    capabilities: ['chat', 'tools', 'reasoning'],
    usageClass: 'medium',
    recommendationTags: [],
    measuredQuality: null,
    measuredLatencyMs: null,
    ...(reasoning ? { reasoning } : {})
  }));
  await store.replaceModelCatalog(models);
  const saved = await store.listModels();
  expect(saved).toHaveLength(options.length);
  expect(saved.map((model) => model.reasoning)).toEqual(options);
  const updated = {
    ...models[0]!,
    reasoning: { mandatory: true, supportedEfforts: ['high', 'low'] }
  };
  await store.upsertModels([updated]);
  expect((await store.listModels()).find((model) => model.id === updated.id)?.reasoning).toEqual(
    updated.reasoning
  );
  const absent = { ...updated, reasoning: undefined };
  await store.upsertModels([absent]);
  expect((await store.listModels()).find((model) => model.id === updated.id)).not.toHaveProperty(
    'reasoning'
  );
});
