import { describe, expect, it } from 'vitest';
import type { ModelRelease } from '@garden/contracts';
import type { DataStore } from '@garden/data';
import { routingForTurn } from './routing-policy.js';

const model = { id: 'openrouter/vendor/model', providerModelId: 'vendor/model' } as ModelRelease;

const storeWith = (
  ceiling: { tokensPerSecond: number; providerName: string } | null,
  preferences: Record<string, unknown> = {}
) =>
  ({
    modelThroughputCeiling: async () => ceiling,
    getUserById: async () => ({ preferences })
  }) as unknown as DataStore;

const routing = (
  ceiling: { tokensPerSecond: number; providerName: string } | null,
  preferences: Record<string, unknown> = {},
  release: ModelRelease = model
) => routingForTurn({ store: storeWith(ceiling, preferences), model: release, userId: 'u1' });

/**
 * The owner's rule needs a ceiling to take a share of, and the aggregator publishes none. So a turn
 * with no fresh ceiling is routed to the company it ranks quickest - which loses that turn nothing,
 * being the fastest route there is - and its generation is read afterwards for the figure.
 */
describe('what a turn asks the aggregator for', () => {
  it('floors at the owner’s share of the measured ceiling and sorts on price', async () => {
    // The real table: 142 tokens a second at the top, so 40% is 56 - above DeepInfra's 16 and
    // io.net's 3, which is what stops the price sort landing on the cheapest and slowest.
    await expect(routing({ tokensPerSecond: 142, providerName: 'Novita' })).resolves.toEqual({
      preferences: { sort: 'price', preferred_min_throughput: 56 },
      measuring: false
    });
  });

  /**
   * The reason the floor cannot be a rate. Judged against its own field, a model whose quickest
   * company manages forty is asked for sixteen; a fixed sixty would deprioritise every endpoint it
   * has, and a price sort over a wholly deprioritised field returns the cheapest - the aggregator's
   * own default, which is the behaviour being replaced.
   */
  it('scales the floor to what the model can actually reach', async () => {
    await expect(routing({ tokensPerSecond: 40, providerName: 'Slow' })).resolves.toMatchObject({
      preferences: { preferred_min_throughput: 16 }
    });
  });

  it('goes and measures when it has no ceiling to take a share of', async () => {
    await expect(routing(null)).resolves.toEqual({
      preferences: { sort: 'throughput' },
      measuring: true
    });
  });

  it('carries the owner’s own share', async () => {
    await expect(
      routing(
        { tokensPerSecond: 142, providerName: 'Novita' },
        {
          providerRouting: { throughputFloorPercent: 75 }
        }
      )
    ).resolves.toMatchObject({ preferences: { preferred_min_throughput: 106 } });
  });

  it('does not go measuring for an owner who asked for fastest or cheapest', async () => {
    await expect(routing(null, { providerRouting: { objective: 'fastest' } })).resolves.toEqual({
      preferences: { sort: 'throughput' },
      measuring: false
    });
    await expect(routing(null, { providerRouting: { objective: 'cheapest' } })).resolves.toEqual({
      preferences: { sort: 'price' },
      measuring: false
    });
  });

  it('passes on a company the owner struck off', async () => {
    await expect(
      routing(
        { tokensPerSecond: 142, providerName: 'Novita' },
        {
          providerRouting: { ignoredProviders: ['Novita'] }
        }
      )
    ).resolves.toMatchObject({ preferences: { ignore: ['novita'] } });
  });

  it('says nothing for a model that is not one of the aggregator’s routes', async () => {
    await expect(
      routing(null, {}, { id: 'local', providerModelId: 'llama3' } as ModelRelease)
    ).resolves.toEqual({ preferences: undefined, measuring: false });
  });

  /*
   * An unreadable ceiling is an unmeasured one, never a reason to stop routing: the turn goes out
   * on the fastest company and tries to measure again.
   */
  it('routes by speed when the ceiling cannot be read', async () => {
    const store = {
      modelThroughputCeiling: async () => {
        throw new Error('down');
      },
      getUserById: async () => ({ preferences: {} })
    } as unknown as DataStore;
    await expect(routingForTurn({ store, model, userId: 'u1' })).resolves.toEqual({
      preferences: { sort: 'throughput' },
      measuring: true
    });
  });
});
