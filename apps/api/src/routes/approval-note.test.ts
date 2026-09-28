import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { GardenError, decryptJson, encryptJson, wrapDataKey } from '@garden/core';
import { APPROVAL_NOTE_MAX_CHARS } from '@garden/contracts';
import { ZodError } from 'zod';
import { registerApprovalRoutes } from './approvals.js';
import { createIdempotentOperation } from '../http/idempotency.js';
import type { RouteContext } from '../http/server-context.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const key = Buffer.alloc(32, 13),
  masterKey = Buffer.alloc(32, 9);
const apps: FastifyInstance[] = [];
beforeAll(async () => migrateDatabase(database));
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
afterAll(async () => database.close());
async function fixture() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const foreign = await store.createUser({ username: randomUUID(), displayName: 'Another owner' });
  const workspaceId = randomUUID();
  await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Approval',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: wrapDataKey(key, masterKey, workspaceId)
  });
  const sealed = encryptJson({ prompt: 'Work' }, key, 'fixture');
  const task = await store.createTask({
    userId: user.id,
    workspaceId,
    modelId: 'selected',
    reasoningEffort: 'high',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 5,
    maxSpendUsd: 2,
    titleCiphertext: sealed,
    promptCiphertext: sealed,
    nameIndex: { nameTokens: '', openingTokens: '' }
  });
  await database.query(
    "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
    [task.id]
  );
  const approvalId = randomUUID();
  await store.parkTaskForApproval({
    id: approvalId,
    userId: user.id,
    taskId: task.id,
    workerId: 'worker',
    action: 'shell',
    sideEffect: 'external_consequential',
    previewCiphertext: sealed,
    previewHash: 'test',
    expiresAt: new Date(Date.now() + 60_000),
    agentStateCiphertext: sealed,
    actualComputeCredits: 0.2
  });
  const app = Fastify();
  apps.push(app);
  app.addHook('preHandler', async (request) => {
    request.user = request.headers['x-test-foreign'] ? foreign : user;
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
  const send = (
    body: unknown = {},
    requestKey = randomUUID(),
    decision = 'deny',
    foreign = false
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/${decision}`,
      headers: {
        'idempotency-key': requestKey,
        'content-type': 'application/json',
        ...(foreign ? { 'x-test-foreign': 'yes' } : {})
      },
      payload: JSON.stringify(body)
    });
  return { task, user, approvalId, send };
}

describe('owner denial note HTTP contract', () => {
  it('seals sanitized owner prose with real newlines and replays the exact idempotent result once', async () => {
    const f = await fixture();
    const before = (
      await database.query('SELECT * FROM usage_entries WHERE task_id=$1 ORDER BY id', [f.task.id])
    ).rows;
    const requestKey = randomUUID();
    const body = { note: '  Use\t a valid\u202e copy argument.\n\n\nThen retry.\u0001  ' };
    const response = await f.send(body, requestKey);
    expect(response.statusCode).toBe(200);
    const queued = (await store.getNextQueuedTaskMessage(f.task.id, { interruptOnly: true }))!;
    expect(queued).not.toBeNull();
    const expected =
      'I did not approve that shell request. Here is why:\n\nUse a valid copy argument.\n\nThen retry.';
    expect(decryptJson(queued.promptCiphertext, key, `task-message:${f.task.id}`)).toEqual({
      prompt: expected
    });
    expect(
      JSON.stringify(
        (await database.query('SELECT * FROM task_message_queue WHERE task_id=$1', [f.task.id]))
          .rows
      )
    ).not.toContain('valid copy');
    const replay = await f.send(body, requestKey);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const conflict = await f.send({ note: 'Different' }, requestKey);
    expect(conflict.json()).toMatchObject({ code: 'idempotency_conflict' });
    const duplicate = await f.send(body);
    expect(duplicate.json()).toMatchObject({ code: 'approval_unavailable' });
    expect(
      (await database.query('SELECT id FROM task_message_queue WHERE task_id=$1', [f.task.id])).rows
    ).toHaveLength(1);
    expect(
      (
        await database.query('SELECT * FROM usage_entries WHERE task_id=$1 ORDER BY id', [
          f.task.id
        ])
      ).rows
    ).toEqual(before);
    expect(await store.getTask(f.user.id, f.task.id)).toMatchObject({
      status: 'queued',
      modelId: 'selected',
      privacyRoute: 'provider_zdr',
      reasoningEffort: 'high',
      maxComputeCredits: 5,
      maxSpendUsd: 2
    });
  });
  it('keeps absent and sanitised-empty notes as plain denials without a correction', async () => {
    for (const body of [{}, { note: ' \u202e\u0001\t ' }]) {
      const f = await fixture();
      expect((await f.send(body)).statusCode).toBe(200);
      expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
      expect(await store.getApproval(f.approvalId)).toMatchObject({ status: 'denied' });
    }
  });
  it('rejects excessive, nonstring, unknown and approve notes before settling anything', async () => {
    for (const [body, decision] of [
      [{ note: 'x'.repeat(APPROVAL_NOTE_MAX_CHARS + 1) }, 'deny'],
      [{ note: 42 }, 'deny'],
      [{ note: 'No', maxSpendUsd: 500 }, 'deny'],
      [{ note: 'No' }, 'approve']
    ] as const) {
      const f = await fixture();
      expect((await f.send(body, randomUUID(), decision)).statusCode).toBe(400);
      expect(await store.getApproval(f.approvalId)).toMatchObject({ status: 'pending' });
      expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
    }
    const f = await fixture();
    expect((await f.send({ note: 'x'.repeat(APPROVAL_NOTE_MAX_CHARS) })).statusCode).toBe(200);
  });
  it('refuses a different owner and keeps a paused owner decision paused', async () => {
    const f = await fixture();
    expect((await f.send({ note: 'No' }, randomUUID(), 'deny', true)).json()).toMatchObject({
      code: 'approval_unavailable'
    });
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
    await store.setTaskStatusForUser(f.user.id, f.task.id, 'paused');
    expect((await f.send({ note: 'Use another argument' })).statusCode).toBe(200);
    expect(await store.getTask(f.user.id, f.task.id)).toMatchObject({
      status: 'paused',
      leaseOwner: null
    });
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toMatchObject({
      approvalId: f.approvalId
    });
  });
});
