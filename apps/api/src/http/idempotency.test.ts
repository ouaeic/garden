import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDataKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase, type UserRecord } from '@garden/data';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createIdempotentOperation } from './idempotency.js';
import { operationReceipts, sealLegacyOperationResponses } from './operation-receipts.js';

describe('durable operation receipts', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: 'memory://' });
  const store = new DataStore(database);
  const masterKey = generateDataKey();
  const wrap = () => createIdempotentOperation({ database, store, masterKey });
  let user: UserRecord;
  let request: FastifyRequest;
  const reply = () =>
    ({
      statusCode: 200,
      status(this: { statusCode: number }, code: number) {
        this.statusCode = code;
        return this;
      },
      header: vi.fn().mockReturnThis()
    }) as unknown as FastifyReply;
  const mutate = async () => {
    const row = await database.query(
      'INSERT INTO operation_probe(owner_id) VALUES ($1) RETURNING id',
      [user.id]
    );
    return { id: row.rows[0]!.id, title: 'Private project title' };
  };
  const count = async () =>
    Number(
      (
        await database.query('SELECT COUNT(*) AS count FROM operation_probe WHERE owner_id=$1', [
          user.id
        ])
      ).rows[0]!.count
    );

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.exec(
      'CREATE TABLE operation_probe(id SERIAL PRIMARY KEY, owner_id TEXT NOT NULL)'
    );
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    user = await store.createUser({ username: randomUUID(), displayName: 'Receipt test' });
    request = {
      headers: { 'idempotency-key': randomUUID() },
      method: 'POST',
      routeOptions: { url: '/operation-probe' },
      url: '/operation-probe',
      body: { title: 'Private project title' }
    } as unknown as FastifyRequest;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await database.close();
  });

  it('replays sealed content after recreating the handler without storing the title in JSONB', async () => {
    const first = await wrap()(request, reply(), user, mutate);
    const response = reply();
    const header = vi.fn().mockReturnValue(response);
    response.header = header;
    expect(await wrap()(request, response, user, mutate)).toEqual(first);
    expect(header).toHaveBeenCalledWith('idempotency-replayed', 'true');
    expect(await count()).toBe(1);
    const rows = await database.query('SELECT * FROM api_operations WHERE user_id=$1', [user.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.response_body).toBeNull();
    expect(rows.rows[0]!.response_ciphertext).toBeTruthy();
    expect(JSON.stringify(rows.rows)).not.toContain('Private project title');
    await expect(
      wrap()({ ...request, body: { title: 'Changed' } } as FastifyRequest, reply(), user, mutate)
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('never starts new work when a recovered client asks only for an existing receipt', async () => {
    const recovered = {
      ...request,
      headers: { ...request.headers, 'idempotency-replay-only': 'true' }
    } as FastifyRequest;
    await expect(wrap()(recovered, reply(), user, mutate)).rejects.toMatchObject({
      code: 'operation_receipt_unavailable'
    });
    expect(await count()).toBe(0);
    const first = await wrap()(request, reply(), user, mutate);
    expect(await wrap()(recovered, reply(), user, mutate)).toEqual(first);
    await database.query(
      "UPDATE api_operations SET expires_at=NOW()-INTERVAL '1 day' WHERE user_id=$1",
      [user.id]
    );
    await store.cleanupExpired();
    await expect(wrap()(recovered, reply(), user, mutate)).rejects.toMatchObject({
      code: 'operation_receipt_unavailable'
    });
    expect(await count()).toBe(1);
  });

  it('does not repeat an external effect after a receipt write failure or expiry cleanup', async () => {
    vi.spyOn(store, 'completeOperation').mockRejectedValueOnce(new Error('receipt unavailable'));
    await expect(wrap()(request, reply(), user, mutate)).rejects.toThrow('receipt unavailable');
    await database.query(
      "UPDATE api_operations SET expires_at=NOW()-INTERVAL '1 day' WHERE user_id=$1",
      [user.id]
    );
    await store.cleanupExpired();
    await expect(wrap()(request, reply(), user, mutate)).rejects.toMatchObject({
      code: 'operation_outcome_unknown'
    });
    expect(await count()).toBe(1);
  });

  it.each(['failed', 'running'])(
    'reconciles an identity-journaled effect after an incomplete %s API receipt',
    async (state) => {
      let journaled: Awaited<ReturnType<typeof mutate>> | undefined;
      const original = async () => (journaled ??= await mutate());
      const reconcile = vi.fn(async () => {
        expect(journaled).toBeDefined();
        return journaled!;
      });
      vi.spyOn(store, 'completeOperation').mockRejectedValueOnce(new Error('receipt unavailable'));
      await expect(wrap()(request, reply(), user, original, { reconcile })).rejects.toThrow(
        'receipt unavailable'
      );
      if (state === 'running')
        await database.query("UPDATE api_operations SET state='running' WHERE user_id=$1", [
          user.id
        ]);
      const repeat = vi.fn(async () => {
        throw new Error('Original effect was repeated');
      });
      const result = await wrap()(request, reply(), user, repeat, { reconcile });
      expect(result).toEqual(journaled);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(repeat).not.toHaveBeenCalled();
      expect(await count()).toBe(1);
      expect(await wrap()(request, reply(), user, repeat, { reconcile })).toEqual(journaled);
      expect(reconcile).toHaveBeenCalledTimes(1);
    }
  );

  it('never reconciles a read-only receipt lookup or a changed request', async () => {
    const uncertain = async () => {
      throw new Error('acknowledgement missing');
    };
    await expect(wrap()(request, reply(), user, uncertain)).rejects.toThrow(
      'acknowledgement missing'
    );
    const reconcile = vi.fn(mutate);
    await expect(
      wrap()(
        {
          ...request,
          headers: { ...request.headers, 'idempotency-replay-only': 'true' }
        } as FastifyRequest,
        reply(),
        user,
        mutate,
        { reconcile }
      )
    ).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    await expect(
      wrap()(
        { ...request, body: { title: 'Different operation' } } as FastifyRequest,
        reply(),
        user,
        mutate,
        { reconcile }
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(reconcile).not.toHaveBeenCalled();
    expect(await count()).toBe(0);
  });

  it('keeps the first committed receipt immutable when two reconciliations overlap', async () => {
    const uncertain = async () => {
      throw new Error('acknowledgement missing');
    };
    await expect(wrap()(request, reply(), user, uncertain)).rejects.toThrow(
      'acknowledgement missing'
    );
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = wrap()(request, reply(), user, uncertain, {
      reconcile: async () => {
        entered();
        await pending;
        return { observation: 'later' };
      }
    });
    await started;
    const first = await wrap()(request, reply(), user, uncertain, {
      reconcile: async () => ({ observation: 'first' })
    });
    release();
    expect(await slow).toEqual(first);
    expect(first).toEqual({ observation: 'first' });
    expect(await wrap()(request, reply(), user, uncertain)).toEqual(first);
    expect(await count()).toBe(0);
  });

  it('rolls a database mutation and its claim back when the receipt fails, allowing a safe retry', async () => {
    vi.spyOn(store, 'completeOperation').mockRejectedValueOnce(new Error('receipt unavailable'));
    await expect(wrap()(request, reply(), user, mutate, { databaseOnly: true })).rejects.toThrow(
      'receipt unavailable'
    );
    expect(await count()).toBe(0);
    await wrap()(request, reply(), user, mutate, { databaseOnly: true });
    expect(await count()).toBe(1);
  });

  it('does not overwrite completion if its database acknowledgement is lost', async () => {
    const complete = store.completeOperation.bind(store);
    vi.spyOn(store, 'completeOperation').mockImplementationOnce(async (...args) => {
      await complete(...args);
      throw new Error('connection lost after commit');
    });
    await expect(wrap()(request, reply(), user, mutate)).rejects.toThrow('connection lost');
    await wrap()(request, reply(), user, mutate);
    expect(await count()).toBe(1);
  });

  it('blocks a simultaneous request while its original effect is still running', async () => {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = wrap()(request, reply(), user, async () => {
      entered();
      await pending;
      return mutate();
    });
    await started;
    try {
      await expect(wrap()(request, reply(), user, mutate)).rejects.toMatchObject({
        code: 'operation_in_progress'
      });
    } finally {
      release();
      await first;
    }
    expect(await count()).toBe(1);
  });

  it('seals legacy receipts without losing replay and rejects moved or unauthenticated envelopes', async () => {
    await wrap()(request, reply(), user, mutate);
    await database.query(
      'UPDATE api_operations SET response_body=$2::jsonb,response_ciphertext=NULL WHERE user_id=$1',
      [user.id, JSON.stringify({ title: 'Legacy private title' })]
    );
    await sealLegacyOperationResponses(database, masterKey);
    expect(await wrap()(request, reply(), user, mutate)).toEqual({ title: 'Legacy private title' });
    await sealLegacyOperationResponses(database, masterKey);
    const row = (await database.query('SELECT * FROM api_operations WHERE user_id=$1', [user.id]))
      .rows[0]!;
    expect(row.response_body).toBeNull();
    const identity = {
      userId: user.id,
      idempotencyKey: String(row.idempotency_key),
      method: 'POST',
      path: '/operation-probe',
      requestHash: String(row.request_hash)
    };
    const cipher = operationReceipts(masterKey);
    const sealed = cipher.seal(identity, 200, { secret: true });
    expect(() => cipher.open({ ...identity, userId: randomUUID() }, 200, sealed)).toThrow(
      'context mismatch'
    );
    expect(() => cipher.open(identity, 201, sealed)).toThrow('context mismatch');
    const { aad: _aad, ...unbound } = sealed;
    expect(() => cipher.open(identity, 200, unbound)).toThrow('context mismatch');
    expect(() => operationReceipts(generateDataKey()).open(identity, 200, sealed)).toThrow();
  });
});
