import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore } from './store.js';

describe('owner-scoped media receipt settlement', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database);
  beforeAll(async () => migrateDatabase(database));
  afterAll(async () => database.close());
  const fixture = async () => {
    const owner = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
    const usage = {
      userId: owner.id,
      kind: 'model_inference',
      resourceClass: 'media:transcription',
      quantity: 2,
      unit: 'second',
      credits: 0,
      idempotencyKey: randomUUID(),
      costUsd: 0.5
    };
    await store.recordUsage({ ...usage, state: 'reserved', reserveAgainstCaps: true });
    return usage;
  };
  it('settles a null-task reservation with the actual charge and billed duration exactly once', async () => {
    const usage = await fixture();
    await expect(
      store.recordUsage({
        ...usage,
        costUsd: 0.08,
        quantity: 2.7,
        state: 'settled',
        settleReservation: true
      })
    ).resolves.toBeUndefined();
    const result = await database.query(
      'SELECT state,cost_usd,quantity,task_id FROM usage_entries WHERE idempotency_key=$1',
      [usage.idempotencyKey]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      state: 'settled',
      cost_usd: 0.08,
      quantity: 2.7,
      task_id: null
    });
    await expect(
      store.recordUsage({ ...usage, state: 'settled', settleReservation: true })
    ).rejects.toMatchObject({ code: 'media_reservation_missing' });
  });
  it('refuses another owner, task, resource or invalid quantity while leaving the reservation held', async () => {
    const usage = await fixture();
    const variants = [
      { userId: randomUUID() },
      { taskId: randomUUID() },
      { resourceClass: 'media:image' },
      { quantity: -1 },
      { quantity: NaN }
    ];
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants)
      await expect(
        store.recordUsage({ ...usage, ...variant, state: 'settled', settleReservation: true })
      ).rejects.toThrow();
    expect(
      (
        await database.query('SELECT state FROM usage_entries WHERE idempotency_key=$1', [
          usage.idempotencyKey
        ])
      ).rows
    ).toEqual([{ state: 'reserved' }]);
  });
  it('releases an owner-only reservation after a confirmed provider rejection', async () => {
    const usage = await fixture();
    await store.recordUsage({ ...usage, state: 'released', costUsd: 0, settleReservation: true });
    expect(
      (
        await database.query('SELECT state,cost_usd FROM usage_entries WHERE idempotency_key=$1', [
          usage.idempotencyKey
        ])
      ).rows
    ).toEqual([{ state: 'released', cost_usd: 0 }]);
  });
  it.each(['model:task-title', 'model:claim-review', 'model:decisions'])(
    'counts held %s requests against allowance and settles their actual credits',
    async (resourceClass) => {
      const owner = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
      await store.setSpendLimits({ userId: owner.id, dailyCapUsd: 0.7, monthlyCapUsd: 1 });
      const usage = {
        userId: owner.id,
        kind: 'model_inference',
        resourceClass,
        quantity: 1000,
        unit: 'tokens',
        credits: 0.5,
        costUsd: 0.5,
        idempotencyKey: randomUUID()
      };
      await store.recordUsage({ ...usage, state: 'reserved', reserveAgainstCaps: true });
      await expect(
        store.recordUsage({
          ...usage,
          idempotencyKey: randomUUID(),
          state: 'reserved',
          reserveAgainstCaps: true
        })
      ).rejects.toMatchObject({ code: 'spend_cap_reached' });
      await store.recordUsage({
        ...usage,
        costUsd: 0.1,
        credits: 0.02,
        quantity: 200,
        state: 'settled',
        settleReservation: true
      });
      expect(
        (
          await database.query(
            'SELECT state,credits,cost_usd FROM usage_entries WHERE idempotency_key=$1',
            [usage.idempotencyKey]
          )
        ).rows
      ).toEqual([{ state: 'settled', credits: 0.02, cost_usd: 0.1 }]);
      await expect(
        store.recordUsage({
          ...usage,
          idempotencyKey: randomUUID(),
          state: 'reserved',
          reserveAgainstCaps: true
        })
      ).resolves.toBeUndefined();
    }
  );
  it('limits invoice recovery to the original owner and dictation provenance', async () => {
    const usage = await fixture();
    expect(await store.listDictationReceipts(usage.userId)).toHaveLength(0);
    const own = { ...usage, idempotencyKey: `dictation:${usage.userId}:${randomUUID()}` };
    await store.recordUsage({ ...own, state: 'reserved', reserveAgainstCaps: true });
    const receipts = await store.listDictationReceipts(usage.userId);
    expect(receipts).toHaveLength(1);
    const body = {
      userId: usage.userId,
      id: receipts[0]!.id,
      costUsd: 0.12,
      receiptCiphertext: { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'sealed' }
    };
    await expect(
      store.reconcileDictationReceipt({ ...body, userId: randomUUID() })
    ).rejects.toMatchObject({ code: 'dictation_receipt_unavailable' });
    await expect(store.reconcileDictationReceipt({ ...body, costUsd: NaN })).rejects.toThrow();
    const ordinary = (
      await database.query('SELECT id FROM usage_entries WHERE idempotency_key=$1', [
        usage.idempotencyKey
      ])
    ).rows[0]!;
    await expect(
      store.reconcileDictationReceipt({ ...body, id: String(ordinary.id) })
    ).rejects.toMatchObject({ code: 'dictation_receipt_unavailable' });
    await expect(store.reconcileDictationReceipt(body)).resolves.toMatchObject({
      state: 'settled',
      costUsd: 0.12,
      reservationUsd: 0
    });
    await expect(store.reconcileDictationReceipt(body)).rejects.toMatchObject({
      code: 'dictation_receipt_unavailable'
    });
  });
});
