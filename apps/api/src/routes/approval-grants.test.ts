import { createHmac, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { GardenError, decryptJson, encryptJson, wrapDataKey } from '@garden/core';
import { canonicalApprovalScope, type TaskApprovalOffer } from '@garden/contracts';
import { ZodError } from 'zod';
import { registerApprovalRoutes } from './approvals.js';
import { createIdempotentOperation } from '../http/idempotency.js';
import type { RouteContext } from '../http/server-context.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const key = Buffer.alloc(32, 7),
  masterKey = Buffer.alloc(32, 9);
const offer: TaskApprovalOffer = {
  turn: 2,
  securityMode: 'balanced',
  scope: {
    tool: 'shell',
    permissions: ['network'],
    programs: ['curl'],
    origins: ['https://unpkg.com'],
    directories: []
  }
};
const apps: FastifyInstance[] = [];
beforeAll(async () => migrateDatabase(database));
afterAll(async () => {
  for (const app of apps) await app.close();
  await database.close();
});
async function fixture() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const foreign = await store.createUser({ username: randomUUID(), displayName: 'Other owner' });
  const workspaceId = randomUUID();
  await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Permission fixture',
    storageLimitBytes: 1e9,
    imageRevision: 'fixture',
    region: 'local',
    wrappedKey: wrapDataKey(key, masterKey, workspaceId)
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId,
    titleCiphertext: encryptJson('Test', key),
    promptCiphertext: encryptJson('Test', key),
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'fixture',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1
  });
  await database.query(
    "UPDATE tasks SET status='running',lease_owner='fixture',lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
    [task.id]
  );
  const id = randomUUID();
  await store.parkTaskForApproval({
    id,
    userId: user.id,
    taskId: task.id,
    workerId: 'fixture',
    action: 'shell',
    sideEffect: 'external_reversible',
    previewHash: 'fixture',
    previewCiphertext: encryptJson({ tool: 'shell', taskGrant: offer }, key, `approval:${task.id}`),
    agentStateCiphertext: encryptJson({ turn: 2 }, key, `task-state:${task.id}`),
    actualComputeCredits: 0,
    expiresAt: new Date(Date.now() + 60000)
  });
  const app = Fastify();
  apps.push(app);
  app.addHook('preHandler', async (request) => {
    request.user = request.headers['x-other'] ? foreign : user;
    request.apiToken = request.headers['x-token'] ? ({} as never) : null;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ code: 'validation_error' });
    if (error instanceof GardenError)
      return reply.code(error.statusCode).send({ code: error.code });
    throw error;
  });
  registerApprovalRoutes({
    app,
    store,
    masterKey,
    idempotent: createIdempotentOperation({ store, database, masterKey })
  } as RouteContext);
  const send = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/v1/approvals/${id}/approve`,
      payload: body,
      headers: { 'idempotency-key': randomUUID(), ...headers }
    });
  const list = () =>
    app.inject({ method: 'GET', url: `/v1/approvals/tasks/${task.id}/permissions` });
  const hash = createHmac('sha256', key).update(canonicalApprovalScope(offer.scope)).digest('hex');
  const matches = () => store.hasTaskApprovalGrant(user.id, task.id, 2, 'balanced', hash);
  return { app, user, foreign, task, id, send, list, matches, hash };
}

describe('owner permissions for one run', () => {
  it('refuses reusable authority for a consequential or mismatched action even if its preview contains an offer', async () => {
    const f = await fixture();
    await database.query("UPDATE approvals SET side_effect='external_consequential' WHERE id=$1", [
      f.id
    ]);
    expect((await f.send({ scope: 'run' })).statusCode).toBe(409);
    expect(
      (await f.app.inject({ method: 'GET', url: '/v1/approvals' })).json<
        Array<{ preview: { taskGrant?: unknown } }>
      >()[0]?.preview.taskGrant
    ).toBeUndefined();
    await database.query(
      "UPDATE approvals SET side_effect='external_reversible',preview_ciphertext=$2::jsonb WHERE id=$1",
      [
        f.id,
        JSON.stringify(
          encryptJson({ tool: 'file_write', taskGrant: offer }, key, `approval:${f.task.id}`)
        )
      ]
    );
    expect((await f.send({ scope: 'run' })).statusCode).toBe(409);
    expect(await f.matches()).toBe(false);
  });
  it('keeps approve once as the default without creating a reusable permission', async () => {
    const f = await fixture();
    expect((await f.send()).statusCode).toBe(200);
    expect(await f.matches()).toBe(false);
    expect((await f.list()).json()).toEqual([]);
  });
  it('atomically approves and seals the displayed scope, with idempotent replay and ownership checks', async () => {
    const f = await fixture();
    const cards = (await f.app.inject({ method: 'GET', url: '/v1/approvals' })).json<
      Array<{ preview: { taskGrant: { description: string } } }>
    >();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.preview.taskGrant.description).toContain('https://unpkg.com');
    const headers = { 'idempotency-key': randomUUID() };
    expect((await f.send({ scope: 'run' }, headers)).statusCode).toBe(200);
    expect((await f.send({ scope: 'run' }, headers)).statusCode).toBe(200);
    expect(await f.matches()).toBe(true);
    expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('queued');
    const rows = (
      await database.query('SELECT * FROM task_approval_grants WHERE task_id=$1', [f.task.id])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('https://unpkg.com');
    expect(
      decryptJson(
        rows[0]!.scope_ciphertext as Parameters<typeof decryptJson>[0],
        key,
        `task-approval:${f.task.id}:${f.id}`
      )
    ).toEqual(offer.scope);
    expect((await f.list()).json()).toHaveLength(1);
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: `/v1/approvals/tasks/${f.task.id}/permissions?before=${f.id}`
        })
      ).json()
    ).toEqual([]);
    expect(await store.hasTaskApprovalGrant(f.foreign.id, f.task.id, 2, 'balanced', f.hash)).toBe(
      false
    );
    expect(await store.hasTaskApprovalGrant(f.user.id, f.task.id, 3, 'balanced', f.hash)).toBe(
      false
    );
    expect(await store.hasTaskApprovalGrant(f.user.id, randomUUID(), 2, 'balanced', f.hash)).toBe(
      false
    );
  });
  it('rejects forged scope bodies, other owners, API tokens and expired decisions', async () => {
    const f = await fixture();
    expect((await f.send({ scope: 'run', programs: ['anything'] })).statusCode).toBe(400);
    expect((await f.send({ scope: 'run' }, { 'x-other': '1' })).statusCode).not.toBe(200);
    expect((await f.send({ scope: 'run' }, { 'x-token': '1' })).statusCode).toBe(403);
    await database.query("UPDATE approvals SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [
      f.id
    ]);
    expect((await f.send({ scope: 'run' })).statusCode).not.toBe(200);
    expect(await f.matches()).toBe(false);
  });
  it('rejects a stale run and offers no reusable approval for a card without a scope', async () => {
    const f = await fixture();
    await database.query('UPDATE tasks SET agent_state_ciphertext=$2::jsonb WHERE id=$1', [
      f.task.id,
      JSON.stringify(encryptJson({ turn: 3 }, key, `task-state:${f.task.id}`))
    ]);
    expect((await f.send({ scope: 'run' })).statusCode).toBe(409);
    await database.query('UPDATE approvals SET preview_ciphertext=$2::jsonb WHERE id=$1', [
      f.id,
      JSON.stringify(encryptJson({ tool: 'shell' }, key, `approval:${f.task.id}`))
    ]);
    expect((await f.send({ scope: 'run' })).statusCode).toBe(409);
    expect(await f.matches()).toBe(false);
  });
  it('survives pause and restart reads, and revokes only the selected owner permission', async () => {
    const f = await fixture();
    expect((await f.send({ scope: 'run' })).statusCode).toBe(200);
    await database.query("UPDATE tasks SET status='paused' WHERE id=$1", [f.task.id]);
    const reconnected = new DataStore(database);
    expect(
      await reconnected.hasTaskApprovalGrant(f.user.id, f.task.id, 2, 'balanced', f.hash)
    ).toBe(true);
    expect(await reconnected.revokeTaskApprovalGrant(f.foreign.id, f.task.id, f.id)).toBe(false);
    const reply = await f.app.inject({
      method: 'POST',
      url: `/v1/approvals/tasks/${f.task.id}/permissions/${f.id}/revoke`,
      payload: {},
      headers: { 'idempotency-key': randomUUID() }
    });
    expect(reply.statusCode).toBe(200);
    expect(await f.matches()).toBe(false);
    expect((await store.getApproval(f.id))?.status).toBe('approved');
  });
  it('ends permissions on a mode change or terminal transition without resurrecting them later', async () => {
    const f = await fixture();
    expect((await f.send({ scope: 'run' })).statusCode).toBe(200);
    await database.query("UPDATE tasks SET security_mode='review' WHERE id=$1", [f.task.id]);
    await database.query("UPDATE tasks SET security_mode='balanced' WHERE id=$1", [f.task.id]);
    expect(await f.matches()).toBe(false);
    const next = await fixture();
    expect((await next.send({ scope: 'run' })).statusCode).toBe(200);
    await database.query("UPDATE tasks SET status='completed' WHERE id=$1", [next.task.id]);
    await database.query("UPDATE tasks SET status='queued' WHERE id=$1", [next.task.id]);
    expect(await next.matches()).toBe(false);
  });
});
