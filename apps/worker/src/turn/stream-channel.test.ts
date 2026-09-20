/**
 * The frame channel, and the two things a stall heartbeat must never do.
 *
 * The channel is built by the caller *before* the claim watch whose answer `disowned` reads, so the
 * accessor it is handed is only safe to call later. A heartbeat that asked the question while
 * arming itself reached that watch inside its own temporal dead zone and threw out of channel
 * construction - not on a stalled turn, on every turn, because arming is unconditional. The first
 * test below is that shape exactly: a `disowned` that throws until the caller is ready.
 *
 * The second is the heartbeat's own reason for existing. The line the owner watches is fed by
 * frames; a step that thinks for two minutes feeds it nothing, and a channel with nothing to say
 * reads on screen exactly like one that has died.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { decryptJson, encryptJson } from '@athanor/core';
import { createDatabase, migrateDatabase, DataStore, type Database } from '@athanor/data';
import type { AgentState } from '../agent-state.js';
import { createStreamChannel } from './stream-channel.js';

let database: Database | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

const fixture = async () => {
  database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  await migrateDatabase(database);
  const store = new DataStore(database);
  const key = new Uint8Array(32).fill(7);
  const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
  const workspace = await store.createWorkspace({
    userId: user.id,
    name: 'Fixture',
    storageLimitBytes: 1024 ** 3,
    imageRevision: 'fixture',
    region: 'auto',
    wrappedKey: 'fixture'
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId: workspace.id,
    titleCiphertext: encryptJson('Fixture', key),
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'fixture',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    promptCiphertext: encryptJson('Fixture', key)
  });
  return { store, key, task, state: { messages: [] } as unknown as AgentState };
};

const deltas = async (store: DataStore, taskId: string): Promise<number> =>
  (await store.listTaskEvents(taskId)).filter((row) => row.kind === 'assistant_delta').length;

/** Waits for a condition the heartbeat reaches on its own timer, rather than on a fixed sleep. */
const until = async (predicate: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was never reached');
};

describe('the frame channel', () => {
  it('does not ask whether the turn is disowned while it is being built', async () => {
    const { store, key, task, state } = await fixture();
    let watchReady = false;
    // Standing in for the `const stopWatch` the caller declares after this returns: asking before
    // the caller is ready is exactly the ReferenceError that took every generation down.
    const disowned = (): boolean => {
      if (!watchReady) throw new ReferenceError("Cannot access 'stopWatch' before initialization");
      return false;
    };
    const channel = createStreamChannel({ store }, task, key, state, disowned);
    watchReady = true;
    channel.close();
    expect(channel.settle).toBeTypeOf('function');
  });

  it('sends empty heartbeats without duplicating answer text', async () => {
    const { store, key, task, state } = await fixture();
    let clock = 0;
    const channel = createStreamChannel(
      { store, stallIntervalMs: 5, now: () => clock },
      task,
      key,
      state,
      () => false
    );
    channel.emitStreamFrame('The first half of the sentence');
    // Not `settle()`: that ends the generation, and ending it is what stops the heartbeat. The
    // stall this covers happens mid-turn, with the channel still open and nothing arriving.
    await until(async () => (await deltas(store, task.id)) === 1);
    clock += 1_000;
    await until(async () => (await deltas(store, task.id)) > 1);
    await channel.settle();
    const rows = (await store.listTaskEvents(task.id)).filter(
      (row) => row.kind === 'assistant_delta'
    );
    expect(rows.length).toBeGreaterThan(1);
    const payloads = rows.map(
      (row) =>
        decryptJson<{ payload: { markdown: string; streamId: string; heartbeat?: boolean } }>(
          row.payloadCiphertext!,
          key,
          `task-event:${task.id}`
        ).payload
    );
    expect(payloads.map((payload) => payload.markdown).join('')).toBe(
      'The first half of the sentence'
    );
    expect(new Set(payloads.map((payload) => payload.streamId)).size).toBe(1);
    expect(payloads[0]!.streamId).toMatch(/^[a-f0-9-]{36}$/);
    expect(payloads.slice(1).every((payload) => payload.heartbeat === true)).toBe(true);
  });

  it('stops re-asserting once the turn has settled', async () => {
    const { store, key, task, state } = await fixture();
    let clock = 0;
    const channel = createStreamChannel(
      { store, stallIntervalMs: 5, now: () => clock },
      task,
      key,
      state,
      () => false
    );
    channel.emitStreamFrame('Something');
    await channel.settle();
    const settled = await deltas(store, task.id);
    clock += 1_000;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await deltas(store, task.id)).toBe(settled);
  });
});
