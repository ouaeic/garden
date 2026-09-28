import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { generateDataKey, sha256, wrapDataKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase, type UserRecord } from '@garden/data';
import { createIdempotentOperation } from '../http/idempotency.js';
import type { RouteContext } from '../http/server-context.js';
import { registerDraftRoutes } from './drafts.js';

describe('revisioned encrypted drafts', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: 'memory://' });
  const store = new DataStore(database),
    masterKey = generateDataKey(),
    app = Fastify();
  let user: UserRecord, workspaceId: string;
  beforeAll(async () => {
    await migrateDatabase(database);
    await app.register(cookie);
    app.addHook('onRequest', async (request) => {
      request.user = user;
    });
    registerDraftRoutes({
      app,
      store,
      masterKey,
      secure: false,
      idempotent: createIdempotentOperation({ database, store, masterKey })
    } as RouteContext);
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    user = await store.createUser({ username: randomUUID(), displayName: 'Draft test' });
    workspaceId = randomUUID();
    await store.createWorkspace({
      id: workspaceId,
      userId: user.id,
      name: 'Draft test',
      storageLimitBytes: 1024 ** 3,
      imageRevision: 'test',
      region: 'auto',
      wrappedKey: wrapDataKey(generateDataKey(), masterKey, workspaceId)
    });
  });
  afterAll(async () => {
    await app.close();
    await database.query('SELECT 1');
    await database.close();
  });
  const save = (body: string, revision = 0, key = randomUUID()) =>
    app.inject({
      method: 'PUT',
      url: '/v1/drafts',
      headers: { 'idempotency-key': key },
      payload: { workspaceId, body, expectedRevision: revision }
    });
  it('replays acknowledgements without advancing the revision and stores no plaintext', async () => {
    const key = randomUUID();
    const first = await save('private draft', 0, key);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await save('private draft', 0, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    const rows = await database.query('SELECT * FROM message_drafts WHERE workspace_id=$1', [
      workspaceId
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.revision).toBe(1);
    expect(JSON.stringify(rows.rows)).not.toContain('private draft');
  });
  it('preserves selected analysis context through encrypted storage and removes it when cleared', async () => {
    const context = {
      kind: 'analysis',
      workspaceId,
      manifestPath: 'workspace/private-run.json',
      sha256: 'a'.repeat(64),
      runId: randomUUID(),
      name: 'Private analysis name'
    };
    const controls = {
      modelId: '',
      reasoningEffort: 'auto',
      privacyRoute: 'provider_zdr',
      spendCap: '',
      context
    };
    const written = await app.inject({
      method: 'PUT',
      url: '/v1/drafts',
      headers: { 'idempotency-key': randomUUID() },
      payload: { workspaceId, body: '', controls }
    });
    expect(written.statusCode, written.body).toBe(200);
    const current = await app.inject({
      method: 'GET',
      url: `/v1/drafts?workspaceId=${workspaceId}`
    });
    expect(current.json<{ controls: { context: unknown } }>().controls.context).toEqual(context);
    const rows = await database.query('SELECT * FROM message_drafts WHERE workspace_id=$1', [
      workspaceId
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toContain('private-run.json');
    expect(JSON.stringify(rows.rows)).not.toContain('Private analysis name');
    expect((await save('', 1)).statusCode).toBe(200);
    const cleared = await app.inject({
      method: 'GET',
      url: `/v1/drafts?workspaceId=${workspaceId}`
    });
    expect(cleared.json()).not.toHaveProperty('controls');
  });
  it('refuses an old device after clearing a draft and exposes the current tombstone', async () => {
    expect((await save('old')).statusCode).toBe(200);
    expect((await save('', 1)).statusCode).toBe(200);
    expect((await save('stale resurrection', 1)).statusCode).toBe(409);
    const current = await app.inject({
      method: 'GET',
      url: `/v1/drafts?workspaceId=${workspaceId}`
    });
    expect(current.json()).toMatchObject({ body: '', attachments: [], revision: 2 });
  });
  it('admits one of two concurrent devices at the same revision', async () => {
    await save('initial');
    const results = await Promise.all([save('device A', 1), save('device B', 1)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect((await store.getMessageDraft(user.id, workspaceId, null))?.revision).toBe(2);
  });
  it('rolls back the draft if its receipt cannot be persisted', async () => {
    const key = randomUUID();
    vi.spyOn(store, 'completeOperation').mockRejectedValueOnce(new Error('write failure'));
    expect((await save('must remain retryable', 0, key)).statusCode).toBe(500);
    expect(await store.getMessageDraft(user.id, workspaceId, null)).toBeNull();
    expect((await save('must remain retryable', 0, key)).statusCode).toBe(200);
  });
  it('requires a live owner session for the device key and binds keys to individual sessions', async () => {
    const token = randomUUID(),
      other = randomUUID();
    const firstId = await store.createSession(
      user.id,
      sha256(token),
      new Date(Date.now() + 60_000)
    );
    await store.createSession(user.id, sha256(other), new Date(Date.now() + 60_000));
    const keyFor = (value?: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/drafts/device-key',
        headers: value ? { cookie: `garden_session=${value}` } : {}
      });
    expect((await keyFor()).statusCode).toBe(401);
    const first = await keyFor(token),
      again = await keyFor(token),
      second = await keyFor(other);
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.json<{ key: string }>().key).toBe(again.json<{ key: string }>().key);
    expect(first.json<{ key: string }>().key).not.toBe(second.json<{ key: string }>().key);
    await store.deleteSessionForUser(user.id, firstId);
    expect((await keyFor(token)).statusCode).toBe(401);
  });
  it('rejects a draft associated with a nonexistent conversation', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/drafts',
      headers: { 'idempotency-key': randomUUID() },
      payload: { workspaceId, taskId: randomUUID(), body: 'misfiled' }
    });
    expect(response.statusCode).toBe(404);
    expect(await store.getMessageDraft(user.id, workspaceId, null)).toBeNull();
  });
});
