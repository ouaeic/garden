import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { decryptJson, encryptJson } from '@athanor/core';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore } from './store.js';

describe('durable connector authorization', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database);
  const key = Buffer.alloc(32, 9);
  let userId: string;
  beforeAll(async () => {
    await migrateDatabase(database);
    userId = (await store.createUser({ username: 'account-owner', displayName: 'Owner' })).id;
  });
  afterAll(async () => database.close());
  const create = async () => {
    const id = randomUUID();
    return store.createConnector({
      id,
      userId,
      kind: 'mcp_http',
      authMode: 'oauth',
      label: 'Test account',
      baseUrl: 'https://example.org',
      scopes: ['mcp:tools.read'],
      secretCiphertext: encryptJson({ token: 'initial-secret' }, key, `connector:${userId}:${id}`)
    });
  };

  it('serializes concurrent refresh decisions against the newly committed credential', async () => {
    const connection = await create();
    const refresh = vi.fn((token: string) => `${token}-rotated`);
    const authorize = () =>
      new DataStore(database).withConnectorAuthorization(userId, connection.id, async (current) => {
        const { token } = decryptJson<{ token: string }>(current.secretCiphertext, key);
        if (token !== 'initial-secret') return { value: token };
        const next = refresh(token);
        return {
          value: next,
          secretCiphertext: encryptJson(
            { token: next },
            key,
            `connector:${userId}:${connection.id}`
          )
        };
      });
    expect(await Promise.all([authorize(), authorize(), authorize()])).toEqual(
      Array(3).fill('initial-secret-rotated')
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    const saved = (await store.getConnector(userId, connection.id))!;
    expect(decryptJson(saved.secretCiphertext, key)).toEqual({ token: 'initial-secret-rotated' });
    expect(
      JSON.stringify(
        (
          await database.query('SELECT secret_ciphertext FROM connectors WHERE id=$1', [
            connection.id
          ])
        ).rows
      )
    ).not.toContain('initial-secret');
  });

  it('rejects wrong owners, disconnected accounts and another connection encryption context', async () => {
    const connection = await create();
    const authorize = vi.fn();
    await expect(
      store.withConnectorAuthorization(randomUUID(), connection.id, authorize)
    ).rejects.toThrow('unavailable');
    expect(authorize).not.toHaveBeenCalled();
    await expect(
      store.withConnectorAuthorization(userId, connection.id, async () => ({
        value: 'bad',
        secretCiphertext: encryptJson({}, key, 'another-connection')
      }))
    ).rejects.toThrow('context');
    expect(
      decryptJson((await store.getConnector(userId, connection.id))!.secretCiphertext, key)
    ).toEqual({ token: 'initial-secret' });
    await store.revokeConnector(userId, connection.id);
    const removed = await database.query('SELECT secret_ciphertext FROM connectors WHERE id=$1', [
      connection.id
    ]);
    expect(removed.rows).toHaveLength(1);
    expect(removed.rows[0]!.secret_ciphertext).toMatchObject({ ciphertext: '', tag: '', iv: '' });
    await expect(
      store.withConnectorAuthorization(userId, connection.id, authorize)
    ).rejects.toThrow('unavailable');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('releases the lock after a failed refresh without overwriting the credential', async () => {
    const connection = await create();
    await expect(
      store.withConnectorAuthorization(userId, connection.id, async () => {
        throw new Error('provider unavailable');
      })
    ).rejects.toThrow('provider unavailable');
    expect(
      await store.withConnectorAuthorization(userId, connection.id, async (current) => ({
        value: decryptJson(current.secretCiphertext, key)
      }))
    ).toEqual({ token: 'initial-secret' });
  });
});
