import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { encryptJson, decryptJson } from '@athanor/core';
import { createDatabase, migrateDatabase } from './database.js';
import { migrations } from './migrations.js';
import { DataStore, connectorOperationAad, type ConnectorOperationIdentity } from './store.js';

describe('durable connected-service write receipts', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database),
    key = Buffer.alloc(32, 7);
  let base: Omit<ConnectorOperationIdentity, 'operationKey'>;
  beforeAll(async () => {
    await migrateDatabase(database);
    const user = await store.createUser({ username: 'operation-owner', displayName: 'Owner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Fixture',
      storageLimitBytes: 1024,
      imageRevision: 'fixture',
      region: 'auto',
      wrappedKey: 'fixture'
    });
    const envelope = encryptJson({}, key, 'fixture');
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'fixture',
      privacyRoute: 'provider_zdr',
      securityMode: 'autonomous',
      maxComputeCredits: 1,
      promptCiphertext: envelope
    });
    const id = randomUUID();
    await store.createConnector({
      id,
      userId: user.id,
      kind: 'google',
      authMode: 'oauth',
      label: 'Fixture',
      baseUrl: 'https://gmail.googleapis.com',
      scopes: ['mail:message.send'],
      secretCiphertext: encryptJson({}, key, `connector:${user.id}:${id}`)
    });
    base = { userId: user.id, connectorId: id, taskId: task.id, action: 'account_mail_send' };
  });
  afterAll(async () => database.close());
  const identity = (letter: string) => ({ ...base, operationKey: letter.repeat(64) });

  it('commits a checkpoint before an effect and reopens it after a lost acknowledgement', async () => {
    const input = identity('a');
    let originalId: string | undefined;
    await expect(
      store.withConnectorOperation(input, async ({ operation, fresh, saveRecovery }) => {
        expect(fresh).toBe(true);
        originalId = operation.id;
        await saveRecovery(
          encryptJson(
            { phase: 'sending', draftId: 'PRIVATE_DRAFT_CANARY' },
            key,
            connectorOperationAad(operation, 'recovery')
          )
        );
        const persisted = await database.query(
          'SELECT recovery_ciphertext FROM connector_operations WHERE id=$1',
          [operation.id]
        );
        expect(persisted.rows).toHaveLength(1);
        expect(JSON.stringify(persisted.rows)).not.toContain('PRIVATE_DRAFT_CANARY');
        expect(
          decryptJson(persisted.rows[0]!.recovery_ciphertext as ReturnType<typeof encryptJson>, key)
        ).toEqual({ phase: 'sending', draftId: 'PRIVATE_DRAFT_CANARY' });
        throw new Error('acknowledgement lost');
      })
    ).rejects.toThrow('acknowledgement lost');
    await new DataStore(database).withConnectorOperation(
      input,
      async ({ operation, fresh, complete }) => {
        expect(fresh).toBe(false);
        expect(operation.id).toBe(originalId);
        expect(decryptJson(operation.recoveryCiphertext!, key)).toMatchObject({ phase: 'sending' });
        await complete(
          encryptJson({ confirmed: true }, key, connectorOperationAad(operation, 'result'))
        );
      }
    );
    await store.withConnectorOperation(input, async ({ operation, fresh, saveRecovery }) => {
      expect(fresh).toBe(false);
      expect(operation.state).toBe('completed');
      expect(decryptJson(operation.resultCiphertext!, key)).toEqual({ confirmed: true });
      await expect(
        saveRecovery(encryptJson({}, key, connectorOperationAad(operation, 'recovery')))
      ).rejects.toThrow('final receipt');
    });
  });

  it('serializes competing executors and exposes a completed receipt to the follower', async () => {
    const input = identity('b');
    let effects = 0;
    const run = () =>
      new DataStore(database).withConnectorOperation(
        input,
        async ({ operation, fresh, complete }) => {
          if (fresh) {
            effects++;
            await complete(
              encryptJson({ accepted: true }, key, connectorOperationAad(operation, 'result'))
            );
          } else expect(operation.state).toBe('completed');
          return operation.id;
        }
      );
    const ids = await Promise.all([run(), run(), run()]);
    expect(effects).toBe(1);
    expect(new Set(ids).size).toBe(1);
  });

  it('refuses transaction-scoped checkpoints and cancels the operation lifetime after release', async () => {
    const input = identity('d');
    for (const rootHandle of [true, false]) {
      await expect(
        database.transaction(async (scoped) => {
          const selected = rootHandle ? store : new DataStore(scoped);
          return selected.withConnectorOperation(input, async () => {
            throw new Error('must not execute');
          });
        })
      ).rejects.toThrow('cannot run inside a database transaction');
    }
    let lifetime: AbortSignal | undefined;
    await store.withConnectorOperation(input, async ({ signal }) => {
      expect(signal.aborted).toBe(false);
      lifetime = signal;
    });
    expect(lifetime?.aborted).toBe(true);
  });

  it('resolves a pending intent across owner turns and preserves the later turn alias after completion', async () => {
    const first = { ...identity('e'), intentKey: 'f'.repeat(64) };
    const next = { ...first, operationKey: 'f'.repeat(64) };
    let originalId: string | undefined;
    await store.withConnectorOperation(first, async ({ operation, saveRecovery }) => {
      originalId = operation.id;
      await saveRecovery(
        encryptJson({ phase: 'submitted' }, key, connectorOperationAad(operation, 'recovery'))
      );
    });
    await store.withConnectorOperation(next, async ({ operation, fresh, complete }) => {
      expect(fresh).toBe(false);
      expect(operation.id).toBe(originalId);
      expect(decryptJson(operation.recoveryCiphertext!, key)).toEqual({ phase: 'submitted' });
      await complete(
        encryptJson({ confirmed: true }, key, connectorOperationAad(operation, 'result'))
      );
    });
    for (const request of [first, next])
      await store.withConnectorOperation(request, async ({ operation, fresh }) => {
        expect(fresh).toBe(false);
        expect(operation.id).toBe(originalId);
        expect(operation.state).toBe('completed');
      });
    await store.withConnectorOperation(
      { ...first, operationKey: '0'.repeat(64) },
      async ({ operation, fresh }) => {
        expect(fresh).toBe(true);
        expect(operation.id).not.toBe(originalId);
      }
    );
  });

  it('preserves completed receipts and request aliases when its migration is reapplied', async () => {
    const input = identity('6');
    const id = await store.withConnectorOperation(input, async ({ operation, complete }) => {
      await complete(
        encryptJson({ confirmed: true }, key, connectorOperationAad(operation, 'result'))
      );
      return operation.id;
    });
    const migration = migrations.find((entry) => entry.name === 'durable_connector_operations');
    expect(migration).toBeDefined();
    const snapshot = async () => ({
      operations: (await database.query('SELECT * FROM connector_operations ORDER BY id')).rows,
      requests: (
        await database.query('SELECT * FROM connector_operation_requests ORDER BY operation_key')
      ).rows
    });
    const before = await snapshot();
    expect(before.operations.length).toBeGreaterThan(0);
    expect(before.requests.length).toBeGreaterThan(0);
    for (let pass = 0; pass < 2; pass++)
      await database.transaction((transaction) => transaction.exec(migration!.sql));
    expect(await snapshot()).toEqual(before);
    await store.withConnectorOperation(input, async ({ operation, fresh }) => {
      expect(fresh).toBe(false);
      expect(operation.id).toBe(id);
      expect(operation.state).toBe('completed');
    });
  });

  it('rejects another owner, another task, wrong encryption context and late callbacks', async () => {
    const input = identity('c');
    await expect(
      store.withConnectorOperation({ ...input, userId: randomUUID() }, async () => 'bad')
    ).rejects.toThrow('unavailable');
    let late: (() => Promise<void>) | undefined;
    await store.withConnectorOperation(input, async ({ operation, saveRecovery }) => {
      await expect(saveRecovery(encryptJson({}, key, 'wrong'))).rejects.toThrow('context');
      late = () => saveRecovery(encryptJson({}, key, connectorOperationAad(operation, 'recovery')));
    });
    expect(late).toBeTypeOf('function');
    await expect(late!()).rejects.toThrow('lock was released');
    await expect(
      store.withConnectorOperation({ ...input, taskId: randomUUID() }, async () => 'bad')
    ).rejects.toThrow('different work');
    await store.revokeConnector(input.userId, input.connectorId);
    await expect(store.withConnectorOperation(input, async () => 'bad')).rejects.toThrow(
      'unavailable'
    );
  });
});
