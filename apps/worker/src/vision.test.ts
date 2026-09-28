import { describe, expect, it, vi } from 'vitest';
import { decryptJson, generateDataKey } from '@garden/core';
import type { ModelRelease } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import { GardenError } from '@garden/core';
import type { ModelGateway, ModelResponse, ModelToolCall } from '@garden/model-gateway';
import type { AgentState } from './agent-state.js';
import { MODEL_CATALOG_CACHE_MS, currentCatalog, routeImageObservation } from './vision.js';
import type { CatalogCache, VisionDeps } from './vision.js';

const dataKey = generateDataKey();
const taskId = '33333333-3333-4333-8333-333333333333';

const task = {
  id: taskId,
  userId: 'user-1',
  workspaceId: 'workspace-1',
  privacyRoute: 'provider_zdr'
} as unknown as TaskRecord;

const release = (over: Partial<ModelRelease>): ModelRelease =>
  ({
    id: 'model',
    providerModelId: 'vendor/model',
    displayName: 'Model',
    provider: 'custom',
    revision: 'r1',
    availability: 'available',
    openness: 'permissive_open_weight',
    license: 'apache-2.0',
    commercialUse: true,
    privacyRoute: 'provider_zdr',
    contextTokens: 128_000,
    modalities: ['text'],
    capabilities: ['chat', 'tools'],
    usageClass: 'light',
    recommendationTags: [],
    measuredQuality: 0.5,
    measuredLatencyMs: 100,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over
  }) as ModelRelease;

/** A lead that cannot see, on the provider this box actually holds a credential for. */
const lead = release({ id: 'lead', displayName: 'Lead', provider: 'custom' });

const seer = (over: Partial<ModelRelease>): ModelRelease =>
  release({
    modalities: ['text', 'image'],
    capabilities: ['chat', 'vision'],
    ...over
  });

const image = { mimeType: 'image/jpeg', base64: 'aGVsbG8=' };
const call = { id: 'call-1', name: 'browser_snapshot', arguments: {} } as unknown as ModelToolCall;

const answer = (text: string): ModelResponse =>
  ({
    text,
    toolCalls: [],
    reasoning: '',
    finishReason: 'stop',
    truncated: false,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 0.001,
      estimated: false
    },
    metadata: { provider: 'custom', model: 'vendor/seer' }
  }) as unknown as ModelResponse;

interface Probe {
  readonly deps: VisionDeps;
  readonly asked: string[];
  readonly notices: string[];
  readonly events: Array<{ summary: string; payload: unknown }>;
  readonly state: AgentState;
  readonly listModels: () => number;
}

const probe = (
  catalog: ModelRelease[],
  chat: (model: ModelRelease) => Promise<ModelResponse>
): Probe => {
  const asked: string[] = [];
  const events: Array<{ summary: string; payload: unknown }> = [];
  let listModels = 0;
  const state = { messages: [], credits: 0, step: 0 } as unknown as AgentState;
  const store = {
    listModels: async () => {
      listModels += 1;
      return catalog;
    },
    effectiveSpendLimits: async () => ({
      timeZone: 'UTC',
      maxInputUsdPerMillionTokens: null,
      maxOutputUsdPerMillionTokens: null
    }),
    recordUsage: async () => undefined,
    appendTaskEvent: async (input: { payloadCiphertext: Parameters<typeof decryptJson>[0] }) => {
      const body = decryptJson<{ summary: string; payload: unknown }>(
        input.payloadCiphertext,
        dataKey
      );
      events.push(body);
      return { id: 'event', sequence: events.length };
    }
  } as unknown as DataStore;
  const cache: { current: CatalogCache | null } = { current: null };
  const deps: VisionDeps = {
    store,
    catalogCache: cache,
    assertProviderConfigured: async () => undefined,
    gateway: async (_task, model) => {
      asked.push(model.id);
      return {
        provider: 'custom',
        gateway: {
          chat: async () => chat(model)
        } as unknown as ModelGateway
      };
    },
    withLeaseRenewal: async (_task, operation) => operation()
  };
  return {
    deps,
    asked,
    events,
    state,
    listModels: () => listModels,
    get notices() {
      return (state.messages ?? [])
        .filter((message) => message.role === 'system')
        .map((message) => message.content);
    }
  };
};

describe('who reads a picture the lead cannot see', () => {
  /*
   * The box was migrated from one provider to another, so the catalogue still carries the old
   * provider's rows - and one of them outranks everything on the provider this box actually holds
   * a credential for. `#gateway` throws `provider_model_mismatch` for any model that is not on the
   * configured provider, and the picker used to take `[0]` of a list it had not filtered, so the
   * same doomed candidate was chosen for every image for the life of the box.
   */
  it('never offers the image to a model on a provider this box has no credential for', async () => {
    const migrated = seer({
      id: 'stranded',
      displayName: 'Stranded',
      provider: 'openrouter',
      // Ranked first on merit, which is what made it the permanent choice.
      measuredQuality: 0.99
    });
    const reachable = seer({ id: 'reachable', displayName: 'Reachable', measuredQuality: 0.6 });
    const p = probe([lead, migrated, reachable], async () => answer('A login form.'));

    await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);

    expect(p.asked).toEqual(['reachable']);
    expect(p.notices.join('\n')).toContain('VISION SPECIALIST HANDOFF');
    expect(p.notices.join('\n')).toContain('A login form.');
  });

  /*
   * The retry itself. `VISION_SPECIALIST_ATTEMPTS` is two and no test in the repository reached it:
   * both existing cases exercise a single-candidate pool or a first-candidate success, so neither
   * the loop nor the `isProviderWall` break had ever been executed.
   */
  it('falls through to the next candidate when the first one throws', async () => {
    const first = seer({ id: 'first', displayName: 'First', measuredQuality: 0.9 });
    const second = seer({ id: 'second', displayName: 'Second', measuredQuality: 0.6 });
    const p = probe([lead, first, second], async (model) => {
      if (model.id === 'first') throw new Error('the endpoint returned malformed JSON');
      return answer('Two buttons and a table.');
    });

    await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);

    expect(p.asked).toEqual(['first', 'second']);
    const said = p.notices.join('\n');
    expect(said).toContain('VISION SPECIALIST HANDOFF');
    expect(said).toContain('Second');
    expect(said).toContain('Two buttons and a table.');
    // The first candidate's failure is not reported as the turn's answer: something did read the
    // picture, and a routing notice beside a successful handoff would tell the model to work from
    // the text it does not need to work from.
    expect(said).not.toContain('VISION ROUTING NOTICE');
  });

  /*
   * And the case that must not retry. A quota wall, an outage or a missing credential is not this
   * candidate's fault, and the next candidate is behind the same wall - so a second attempt is a
   * second billed call for the same refusal.
   */
  it('stops at a provider wall rather than paying for the same refusal twice', async () => {
    const first = seer({ id: 'first', displayName: 'First', measuredQuality: 0.9 });
    const second = seer({ id: 'second', displayName: 'Second', measuredQuality: 0.6 });
    const p = probe([lead, first, second], async () => {
      throw new GardenError('provider_quota_exhausted', 'the account is out of credit', 402);
    });

    await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);

    expect(p.asked).toEqual(['first']);
    expect(p.notices.join('\n')).toContain('VISION ROUTING NOTICE');
  });

  /*
   * The bound on the loop itself, which no test held. Both cases above have two candidates, so
   * `VISION_SPECIALIST_ATTEMPTS` could be raised to the length of the ranking - every image on a
   * browsing turn paying for a whole catalogue of refusals - without a red run anywhere.
   */
  it('pays for two attempts and no more, whatever the ranking offers', async () => {
    const pool = [
      seer({ id: 'first', displayName: 'First', measuredQuality: 0.9 }),
      seer({ id: 'second', displayName: 'Second', measuredQuality: 0.6 }),
      seer({ id: 'third', displayName: 'Third', measuredQuality: 0.3 })
    ];
    const p = probe([lead, ...pool], async () => {
      throw new Error('the endpoint returned malformed JSON');
    });

    await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);

    expect(p.asked).toEqual(['first', 'second']);
    expect(p.notices.join('\n')).toContain('VISION ROUTING NOTICE');
  });
});

/*
 * Sticky selection for the length of a turn.
 *
 * The registry is refreshed under a run that can last hours, and `MODEL_CATALOG_CACHE_MS` is
 * deliberately a minute so a mid-run outage is routed around. The cost of that, until this, was
 * that the specialist was re-ranked from scratch on every image: a browsing turn reads a picture on
 * nearly every step, so a catalogue that moves at all hands the second half of the turn to a
 * different describer than the first, on a shared `sessionId` whose whole purpose is that the
 * provider recognises the prefix. One turn's pictures should be read by one pair of eyes.
 */
describe('who reads the next picture in the same turn', () => {
  const first = seer({ id: 'first', displayName: 'First', measuredQuality: 0.9 });
  const second = seer({ id: 'second', displayName: 'Second', measuredQuality: 0.6 });

  it('keeps the specialist that answered the last image on this task', async () => {
    const catalog = [lead, first, second];
    const p = probe(catalog, async () => answer('A chart.'));

    vi.useFakeTimers();
    try {
      await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);
      // The registry moves, as it does hourly, and a newcomer now outranks the incumbent.
      catalog.splice(
        1,
        0,
        seer({ id: 'newcomer', displayName: 'Newcomer', measuredQuality: 0.99 })
      );
      vi.setSystemTime(Date.now() + MODEL_CATALOG_CACHE_MS + 1);
      await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);

      expect(p.asked).toEqual(['first', 'first']);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * And the half that makes stickiness safe: it reorders the eligible, it never re-admits. A row
   * the registry has withdrawn, or a route that has lost the endpoint that accepts an image, is
   * not a model to keep sending pictures to because it answered the last one.
   */
  it('lets go of an incumbent the catalogue no longer serves', async () => {
    const catalog = [lead, first, second];
    const p = probe(catalog, async () => answer('A chart.'));

    vi.useFakeTimers();
    try {
      await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);
      catalog.splice(1, 1, seer({ ...first, availability: 'unavailable' }));
      vi.setSystemTime(Date.now() + MODEL_CATALOG_CACHE_MS + 1);
      await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);

      expect(p.asked).toEqual(['first', 'second']);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * One worker leases one task at a time but not the same task forever, and the memo lives on the
   * worker. A second task inheriting the first one's specialist would be a routing decision taken
   * for a run that never made it.
   */
  it('does not carry the specialist from one task into the next', async () => {
    const catalog = [lead, first, second];
    const p = probe(catalog, async () => answer('A chart.'));
    const later = { ...task, id: '44444444-4444-4444-8444-444444444444' } as TaskRecord;

    vi.useFakeTimers();
    try {
      await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);
      catalog.splice(
        1,
        0,
        seer({ id: 'newcomer', displayName: 'Newcomer', measuredQuality: 0.99 })
      );
      vi.setSystemTime(Date.now() + MODEL_CATALOG_CACHE_MS + 1);
      await routeImageObservation(p.deps, later, dataKey, p.state, call, image, lead, [lead]);

      expect(p.asked).toEqual(['first', 'newcomer']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what the registry read costs', () => {
  it('answers a second image from the first read, and reads again once the memo is stale', async () => {
    const reachable = seer({ id: 'reachable', displayName: 'Reachable' });
    const p = probe([lead, reachable], async () => answer('A chart.'));

    vi.useFakeTimers();
    try {
      await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);
      await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);
      // A browsing turn reads a picture on nearly every step, and each one used to be a whole-table
      // read of `model_releases` to follow a registry that refreshes hourly.
      expect(p.listModels()).toBe(1);

      vi.setSystemTime(Date.now() + MODEL_CATALOG_CACHE_MS + 1);
      await routeImageObservation(p.deps, task, dataKey, p.state, call, image, lead, [lead]);
      expect(p.listModels()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pin the fallback when the store will not answer', async () => {
    const cache: { current: CatalogCache | null } = { current: null };
    let reads = 0;
    const store = {
      listModels: async () => {
        reads += 1;
        throw new Error('the database is restarting');
      }
    } as unknown as DataStore;

    const fallback = [lead];
    expect(await currentCatalog({ store, catalogCache: cache }, fallback)).toEqual(fallback);
    expect(await currentCatalog({ store, catalogCache: cache }, fallback)).toEqual(fallback);
    // Two reads, not one: a store that could not answer must not hold the snapshot the task was
    // leased with in place for a minute.
    expect(reads).toBe(2);
    expect(cache.current).toBeNull();
  });
});
