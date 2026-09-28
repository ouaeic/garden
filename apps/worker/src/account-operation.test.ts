import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import {
  encryptJson,
  executeConnectorAction,
  parseAccountConnectorAction,
  type ConnectorTransport
} from '@garden/core';
import { withAccountOperation } from './account-operation.js';

describe('worker account operation persistence', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database),
    key = Buffer.alloc(32, 11);
  let userId: string, taskId: string;
  const connectorId = randomUUID();
  const input = {
    action: 'account_calendar_create',
    summary: 'PRIVATE_EVENT_TITLE',
    start: '2026-10-01T12:00:00Z',
    end: '2026-10-01T13:00:00Z'
  };
  beforeAll(async () => {
    await migrateDatabase(database);
    const user = await store.createUser({ username: 'calendar-owner', displayName: 'Owner' });
    userId = user.id;
    const workspace = await store.createWorkspace({
      userId,
      name: 'Fixture',
      storageLimitBytes: 1024,
      imageRevision: 'fixture',
      region: 'auto',
      wrappedKey: 'fixture'
    });
    const envelope = encryptJson({}, key, 'fixture');
    const task = await store.createTask({
      userId,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'fixture',
      privacyRoute: 'provider_zdr',
      securityMode: 'balanced',
      maxComputeCredits: 1,
      promptCiphertext: envelope
    });
    taskId = task.id;
    await store.createConnector({
      id: connectorId,
      userId,
      kind: 'google',
      authMode: 'oauth',
      label: 'Fixture',
      baseUrl: 'https://gmail.googleapis.com',
      scopes: ['calendar:events.write'],
      secretCiphertext: encryptJson({}, key, `connector:${userId}:${connectorId}`)
    });
  });
  afterAll(async () => database.close());

  it('resumes a lost acknowledgement using the saved encrypted identity across worker instances and reordered arguments', async () => {
    let event: Record<string, unknown> | undefined;
    const transport = vi.fn<ConnectorTransport>(async (request) => {
      if (request.method === 'POST') {
        event = JSON.parse(Buffer.from(request.body!).toString()) as Record<string, unknown>;
        throw new Error('ack lost');
      }
      expect(request.url.pathname).toContain(String(event?.id));
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(event)), durationMs: 1 };
    });
    const run = (taskInput: typeof input) =>
      withAccountOperation({
        store: new DataStore(database),
        key,
        userId,
        connectorId,
        taskId,
        turn: 1,
        action: input.action,
        parameters: parseAccountConnectorAction(taskInput),
        execute: (operation) =>
          executeConnectorAction({
            kind: 'google',
            baseUrl: 'https://gmail.googleapis.com',
            scopes: ['calendar:events.write'],
            secret: {
              accountOAuth: {
                version: 1,
                provider: 'google',
                clientId: 'client',
                clientSecret: 'secret',
                redirectUrl: 'https://garden.example/callback',
                requestedScopes: ['calendar'],
                tokens: {
                  accessToken: 'access',
                  refreshToken: 'refresh',
                  expiresAt: Date.now() + 3600000,
                  scopes: ['calendar']
                },
                account: { id: 'owner', address: 'owner@example.org' }
              }
            },
            action: taskInput,
            allowedHostSuffixes: [],
            transport,
            operation
          })
      });
    await expect(run(input)).rejects.toThrow('ack lost');
    const reordered = {
      end: input.end,
      start: input.start,
      summary: input.summary,
      action: input.action
    };
    const recovered = await run(reordered);
    expect(recovered.result).toMatchObject({ status: 'created', recovered: true });
    await expect(run(input)).resolves.toMatchObject({ result: recovered.result });
    expect(transport.mock.calls.map(([call]) => call.method)).toEqual(['POST', 'GET']);
    const rows = await database.query('SELECT * FROM connector_operations WHERE task_id=$1', [
      taskId
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toContain('PRIVATE_EVENT_TITLE');
    expect(JSON.stringify(rows.rows)).not.toContain(String(event?.id));
  });

  it('distinguishes a new owner turn and refuses a revoked account before its adapter runs', async () => {
    const ids: string[] = [];
    for (const turn of [2, 3])
      await withAccountOperation({
        store,
        key,
        userId,
        connectorId,
        taskId,
        turn,
        action: input.action,
        parameters: parseAccountConnectorAction(input),
        execute: async (operation) => {
          ids.push(operation.id);
          await operation.complete({ confirmed: true });
        }
      });
    expect(new Set(ids).size).toBe(2);
    await store.revokeConnector(userId, connectorId);
    const execute = vi.fn();
    await expect(
      withAccountOperation({
        store,
        key,
        userId,
        connectorId,
        taskId,
        turn: 4,
        action: input.action,
        parameters: input,
        execute
      })
    ).rejects.toThrow('unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
});
