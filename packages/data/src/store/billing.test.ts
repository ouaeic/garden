import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from '../database.js';
import { DataStore } from '../store.js';

/**
 * The ledger readers, pinned against the states the ledger actually holds.
 *
 * `usage_entries` is append-only and four-valued: a charge is `reserved` before the work runs,
 * `settled` when the provider's own figure lands, `released` when the reservation was never spent,
 * and `credited` when money that was taken came back. Only `settled` is money gone. Every reader
 * that answers "what has been spent" has to say so in SQL.
 */
describe('BillingStore spend readers', () => {
  let database: Database;
  let store: DataStore;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
  });

  afterEach(async () => database.close());

  const seedTask = async (): Promise<{ userId: string; taskId: string }> => {
    const user = await store.createUser({ username: 'ledger', displayName: 'Ledger' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'ledger',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    return { userId: user.id, taskId: task.id };
  };

  /**
   * The media brake reads this number and refuses to generate past it, so anything it counts that
   * is not money the owner spent shortens the task for no reason. A reservation that never settled
   * is money nobody took; a refund is money that came back. Without a `state` filter both would
   * count for the life of the task.
   */
  it('counts reserved and settled media charges against the media brake', async () => {
    const { userId, taskId } = await seedTask();
    const charge = async (
      key: string,
      state: 'reserved' | 'settled' | 'released' | 'credited',
      costUsd: number,
      resourceClass = 'media:image'
    ): Promise<void> =>
      store.recordUsage({
        userId,
        taskId,
        kind: 'media',
        resourceClass,
        quantity: 1,
        unit: 'image',
        credits: 0,
        state,
        idempotencyKey: key,
        costUsd
      });

    await charge('settled-image', 'settled', 0.3);
    await charge('reserved-image', 'reserved', 0.5);
    await charge('released-image', 'released', 0.7);
    await charge('credited-image', 'credited', 0.11);
    // A settled row that cost nothing - a free tier, a cached generation - contributes nothing to
    // the sum and is outside `usage_entries_task_spend_idx`. The five neighbouring readers all pair
    // `state='settled'` with `cost_usd>0` so they match that partial index; this one now does too.
    await charge('free-image', 'settled', 0);
    // Not media, so out of scope whatever its state.
    await charge('settled-tokens', 'settled', 4.5, 'model:tokens');

    await expect(store.mediaSpendForTask(taskId)).resolves.toBeCloseTo(0.8, 10);
  });

  /** The neighbours this reader was brought into line with, on the same rows. */
  it('keeps unsettled reservations in the media brake while task totals report actual spend', async () => {
    const { userId, taskId } = await seedTask();
    for (const [key, state, cost] of [
      ['settled-a', 'settled', 0.25],
      ['reserved-a', 'reserved', 9],
      ['credited-a', 'credited', 9]
    ] as const) {
      await store.recordUsage({
        userId,
        taskId,
        kind: 'media',
        resourceClass: 'media:transcription',
        quantity: 1,
        unit: 'second',
        credits: 0,
        state,
        idempotencyKey: key,
        costUsd: cost
      });
    }
    await expect(store.taskSpend(taskId)).resolves.toBeCloseTo(0.25, 10);
    await expect(store.mediaSpendForTask(taskId)).resolves.toBeCloseTo(9.25, 10);
  });
});
