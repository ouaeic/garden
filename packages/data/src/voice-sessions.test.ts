import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptJson, wrapDataKey } from '@garden/core';
import type { VoiceSession } from '@garden/contracts';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore } from './store.js';
import { VoiceStore } from './store/voice-sessions.js';
const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
  store = new DataStore(database),
  voice = new VoiceStore(database),
  key = Buffer.alloc(32, 8),
  sealed = encryptJson({ private: 'sealed' }, key, 'test');
beforeAll(async () => migrateDatabase(database));
afterAll(async () => database.close());
async function fixture(createSession = true) {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' }),
    workspaceId = randomUUID();
  await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Voice',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: wrapDataKey(key, key, workspaceId)
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId,
    modelId: 'task-model',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 4,
    maxSpendUsd: 1,
    titleCiphertext: sealed,
    promptCiphertext: sealed,
    nameIndex: { nameTokens: '', openingTokens: '' }
  });
  const id = randomUUID(),
    session: VoiceSession = {
      id,
      taskId: task.id,
      workspaceId,
      provider: 'openai',
      providerModelId: 'gpt-realtime-2.1-mini',
      privacyRoute: 'provider_zdr',
      retention: 'Owner configured',
      voice: 'marin',
      reasoningEffort: 'low',
      status: 'preparing',
      createdAt: new Date().toISOString(),
      connectedAt: null,
      deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      endedAt: null,
      maxSpendUsd: 0.5,
      settledUsd: 0,
      pendingUsd: 0,
      inputSeconds: 0,
      outputSeconds: 0,
      currentResponseId: null,
      cleanupPending: false,
      errorCode: null,
      note: null
    };
  const input = {
    userId: user.id,
    requestKey: randomUUID(),
    requestHash: 'request',
    authHash: 'auth',
    ticketHash: 'ticket',
    ticketExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    session,
    minimumReservationUsd: 0.02,
    configuration: sealed,
    connection: sealed
  };
  if (createSession) await voice.create(input);
  const controllerId = randomUUID();
  const connect = async () => {
    await voice.claim(user.id, id, 'auth', 'ticket', controllerId, 0.02);
    await voice.connected(user.id, id, controllerId);
  };
  return { user, task, id, controllerId, input, connect };
}
describe('durable voice authority and receipts', () => {
  it('admits only an affordable first response without reserving or increasing the task allowance', async () => {
    const f = await fixture(false);
    await database.query('UPDATE tasks SET max_spend_usd=0.01 WHERE id=$1', [f.task.id]);
    await expect(voice.create(f.input)).rejects.toMatchObject({
      code: 'voice_budget_unavailable',
      details: { minimumReservationUsd: 0.02, availableUsd: 0.01, blockedBy: 'task' }
    });
    expect(await voice.list(f.user.id, f.task.id)).toEqual([]);
    expect((await store.getTask(f.user.id, f.task.id))?.maxSpendUsd).toBe(0.01);
    expect(
      (await database.query('SELECT id FROM usage_entries WHERE user_id=$1', [f.user.id])).rows
    ).toEqual([]);
    await database.query('UPDATE tasks SET max_spend_usd=0.02 WHERE id=$1', [f.task.id]);
    expect((await voice.create(f.input)).session.id).toBe(f.id);
    await f.connect();
    expect(
      (await database.query('SELECT id FROM usage_entries WHERE user_id=$1', [f.user.id])).rows
    ).toEqual([]);
    expect((await store.getTask(f.user.id, f.task.id))?.maxSpendUsd).toBe(0.02);
  });
  it('includes settled parent charges and pending media from the same coding family', async () => {
    const f = await fixture(false);
    const parent = await store.createTask({
      userId: f.user.id,
      workspaceId: f.task.workspaceId,
      modelId: 'parent-model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 4,
      maxSpendUsd: 0.3,
      titleCiphertext: sealed,
      promptCiphertext: sealed,
      nameIndex: { nameTokens: '', openingTokens: '' }
    });
    await database.query('UPDATE tasks SET parent_task_id=$2,parent_mission_id=$3 WHERE id=$1', [
      f.task.id,
      parent.id,
      randomUUID()
    ]);
    for (const [state, costUsd] of [
      ['settled', 0.2],
      ['reserved', 0.09]
    ] as const)
      await store.recordUsage({
        userId: f.user.id,
        taskId: parent.id,
        kind: 'model_inference',
        resourceClass: 'media:image',
        quantity: 1,
        unit: 'image',
        credits: 0,
        state,
        costUsd,
        idempotencyKey: randomUUID()
      });
    await expect(voice.create(f.input)).rejects.toMatchObject({
      code: 'voice_budget_unavailable',
      details: { blockedBy: 'task' }
    });
    expect(await voice.list(f.user.id, f.task.id)).toEqual([]);
    await database.query('UPDATE tasks SET max_spend_usd=0.31 WHERE id=$1', [parent.id]);
    expect((await voice.create(f.input)).session.id).toBe(f.id);
  });
  it.each(['daily', 'monthly'] as const)(
    'includes owner-held receipts in the %s allowance before creating a session',
    async (window) => {
      const f = await fixture(false);
      await store.setSpendLimits({
        userId: f.user.id,
        dailyCapUsd: window === 'daily' ? 0.1 : null,
        monthlyCapUsd: window === 'monthly' ? 0.1 : null
      });
      await store.recordUsage({
        userId: f.user.id,
        kind: 'model_inference',
        resourceClass: 'media:dictation',
        quantity: 0,
        unit: 'second',
        credits: 0,
        state: 'reserved',
        costUsd: 0.09,
        idempotencyKey: randomUUID()
      });
      await expect(voice.create(f.input)).rejects.toMatchObject({
        code: 'voice_budget_unavailable',
        details: { blockedBy: window }
      });
      expect(await voice.list(f.user.id, f.task.id)).toEqual([]);
      expect(
        (
          await database.query('SELECT cost_usd,state FROM usage_entries WHERE user_id=$1', [
            f.user.id
          ])
        ).rows
      ).toEqual([{ cost_usd: 0.09, state: 'reserved' }]);
    }
  );
  it('counts other open task commitments without counting its own task ceiling twice', async () => {
    const f = await fixture(false);
    await store.setSpendLimits({ userId: f.user.id, dailyCapUsd: 0.1, monthlyCapUsd: null });
    const other = await store.createTask({
      userId: f.user.id,
      workspaceId: f.task.workspaceId,
      modelId: 'other-model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 4,
      maxSpendUsd: 0.09,
      titleCiphertext: sealed,
      promptCiphertext: sealed,
      nameIndex: { nameTokens: '', openingTokens: '' }
    });
    await expect(voice.create(f.input)).rejects.toMatchObject({
      code: 'voice_budget_unavailable',
      details: { blockedBy: 'daily' }
    });
    await database.query("UPDATE tasks SET status='completed' WHERE id=$1", [other.id]);
    expect((await voice.create(f.input)).session.id).toBe(f.id);
  });
  it('rechecks affordability when the ticket is claimed and rolls back a rejected claim', async () => {
    const f = await fixture();
    await store.recordUsage({
      userId: f.user.id,
      taskId: f.task.id,
      kind: 'model_inference',
      resourceClass: 'media:image',
      quantity: 1,
      unit: 'image',
      credits: 0,
      state: 'reserved',
      costUsd: 0.99,
      idempotencyKey: randomUUID()
    });
    await expect(voice.create(f.input)).rejects.toMatchObject({ code: 'voice_budget_unavailable' });
    await expect(f.connect()).rejects.toMatchObject({ code: 'voice_budget_unavailable' });
    expect((await voice.get(f.user.id, f.id))?.session).toMatchObject({
      status: 'preparing',
      pendingUsd: 0,
      cleanupPending: false
    });
    expect(
      (
        await database.query('SELECT ticket_hash,controller_id FROM voice_sessions WHERE id=$1', [
          f.id
        ])
      ).rows
    ).toEqual([{ ticket_hash: 'ticket', controller_id: null }]);
    expect(await voice.pending(f.user.id, f.id)).toEqual([]);
  });
  it('replays one sealed connection and consumes the exact owner/browser ticket only once', async () => {
    const f = await fixture();
    expect((await voice.create(f.input)).session.id).toBe(f.id);
    await expect(voice.create({ ...f.input, authHash: 'different' })).rejects.toThrow();
    await expect(
      voice.claim(f.user.id, f.id, 'different', 'ticket', f.controllerId, 0.02)
    ).rejects.toThrow();
    await expect(
      voice.claim(randomUUID(), f.id, 'auth', 'ticket', f.controllerId, 0.02)
    ).rejects.toThrow();
    await f.connect();
    await expect(
      voice.claim(f.user.id, f.id, 'auth', 'ticket', f.controllerId, 0.02)
    ).rejects.toThrow();
    await expect(
      voice.create({
        ...f.input,
        session: { ...f.input.session, id: randomUUID() },
        requestKey: randomUUID()
      })
    ).rejects.toMatchObject({ code: 'voice_already_active' });
  });
  it('serializes response reservations under session and task caps and retains ambiguous cost', async () => {
    const f = await fixture();
    await f.connect();
    const attempts = await Promise.allSettled([
      voice.reserve(f.user.id, f.id, f.controllerId, 0.3),
      voice.reserve(f.user.id, f.id, f.controllerId, 0.3)
    ]);
    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((x) => x.status === 'rejected')).toHaveLength(1);
    const response = (
      attempts.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<string>
    ).value;
    await voice.bindResponse(f.user.id, f.id, response, 'resp_1');
    await voice.finish(f.user.id, f.id, f.controllerId, 'ended');
    expect((await voice.get(f.user.id, f.id))?.session).toMatchObject({
      status: 'usage_uncertain',
      pendingUsd: 0.3,
      cleanupPending: false
    });
    expect(await voice.pending(f.user.id, f.id)).toEqual([
      expect.objectContaining({ id: response, providerResponseId: 'resp_1' })
    ]);
    await expect(
      voice.settle(randomUUID(), f.id, response, {
        costUsd: 0.02,
        quantity: 50,
        providerResponseId: 'resp_1'
      })
    ).rejects.toThrow();
    await expect(
      voice.settle(f.user.id, f.id, response, {
        costUsd: 0.02,
        quantity: 50,
        providerResponseId: 'wrong'
      })
    ).rejects.toThrow();
    await voice.settle(f.user.id, f.id, response, {
      costUsd: 0.02,
      quantity: 50,
      providerResponseId: 'resp_1'
    });
    expect((await voice.get(f.user.id, f.id))?.session).toMatchObject({
      status: 'ended',
      pendingUsd: 0,
      settledUsd: 0.02
    });
    await expect(
      voice.settle(f.user.id, f.id, response, {
        costUsd: 0,
        quantity: 0,
        providerResponseId: 'resp_1'
      })
    ).rejects.toThrow();
  });
  it('shares the task dollar ceiling and rolls failed admission back without another usage row', async () => {
    const f = await fixture();
    await f.connect();
    await store.recordUsage({
      userId: f.user.id,
      taskId: f.task.id,
      kind: 'model_inference',
      resourceClass: 'test',
      quantity: 1,
      unit: 'token',
      credits: 0,
      state: 'settled',
      idempotencyKey: randomUUID(),
      costUsd: 0.9
    });
    await expect(voice.reserve(f.user.id, f.id, f.controllerId, 0.2)).rejects.toMatchObject({
      code: 'spend_cap_reached'
    });
    expect(await voice.pending(f.user.id, f.id)).toEqual([]);
    expect((await voice.get(f.user.id, f.id))?.session).toMatchObject({
      status: 'listening',
      pendingUsd: 0
    });
  });
  it('keeps an owner receipt after task deletion and rejects fresh responses', async () => {
    const f = await fixture();
    await f.connect();
    const response = await voice.reserve(f.user.id, f.id, f.controllerId, 0.2);
    await voice.bindResponse(f.user.id, f.id, response, 'resp_deleted');
    await database.query('DELETE FROM tasks WHERE id=$1', [f.task.id]);
    expect((await voice.get(f.user.id, f.id))?.liveTaskId).toBeNull();
    expect(await voice.heartbeat(f.user.id, f.id, f.controllerId, 1, 1)).toBe(false);
    await voice.finish(f.user.id, f.id, f.controllerId, 'lost');
    await voice.settle(f.user.id, f.id, response, {
      costUsd: 0.03,
      quantity: 0,
      providerResponseId: 'resp_deleted',
      receipt: sealed
    });
    expect(
      (
        await database.query(
          "SELECT cost_usd,task_id,state FROM usage_entries WHERE resource_class='media:voice' AND user_id=$1",
          [f.user.id]
        )
      ).rows
    ).toEqual([{ cost_usd: 0.03, task_id: null, state: 'settled' }]);
  });
  it('recovers expired tickets and lost controller leases without releasing provider commitments', async () => {
    const f = await fixture();
    await f.connect();
    await voice.reserve(f.user.id, f.id, f.controllerId, 0.2);
    await database.query(
      "UPDATE voice_sessions SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [f.id]
    );
    expect(await voice.recover()).toBeGreaterThan(0);
    expect((await voice.get(f.user.id, f.id))?.session).toMatchObject({
      status: 'usage_uncertain',
      pendingUsd: 0.2
    });
    await expect(voice.reserve(f.user.id, f.id, f.controllerId, 0.1)).rejects.toThrow();
  });
  it('keeps an older held invoice visible ahead of recent ended sessions', async () => {
    const f = await fixture();
    await f.connect();
    await voice.reserve(f.user.id, f.id, f.controllerId, 0.2);
    await voice.finish(f.user.id, f.id, f.controllerId, 'lost');
    await database.query(
      `WITH generated AS(SELECT gen_random_uuid() AS id,n FROM generate_series(1,101) n)
      INSERT INTO voice_sessions(id,user_id,original_task_id,workspace_id,request_key,request_hash,auth_hash,ticket_expires_at,deadline_at,details,configuration,connection,status,created_at)
      SELECT g.id,s.user_id,s.original_task_id,s.workspace_id,g.id::text,s.request_hash,s.auth_hash,s.ticket_expires_at,s.deadline_at,
        jsonb_set(s.details,'{id}',to_jsonb(g.id::text)),s.configuration,s.connection,'ended',NOW()+g.n*INTERVAL '1 second'
      FROM generated g CROSS JOIN voice_sessions s WHERE s.id=$1`,
      [f.id]
    );
    const rows = await voice.listOwner(f.user.id);
    expect(rows).toHaveLength(101);
    expect(new Set(rows.map((row) => row.id)).size).toBe(101);
    expect(rows[0]).toMatchObject({ id: f.id, pendingUsd: 0.2 });
    expect(await voice.listOwner(randomUUID())).toEqual([]);
  });
  it('does not multiply the session allowance across settled responses', async () => {
    const f = await fixture();
    await f.connect();
    const response = await voice.reserve(f.user.id, f.id, f.controllerId, 0.4);
    await voice.bindResponse(f.user.id, f.id, response, 'resp_paid');
    await voice.settle(f.user.id, f.id, response, {
      costUsd: 0.3,
      quantity: 10,
      providerResponseId: 'resp_paid'
    });
    await expect(voice.reserve(f.user.id, f.id, f.controllerId, 0.21)).rejects.toMatchObject({
      code: 'voice_spend_cap_reached'
    });
    expect(await voice.pending(f.user.id, f.id)).toEqual([]);
  });
});

it('binds recovery tickets to the live controller and consumes them atomically without more reservations', async () => {
  const f = await fixture();
  await f.connect();
  const identity = {
    userId: f.user.id,
    id: f.id,
    authHash: 'auth',
    controllerId: f.controllerId,
    ticketHash: 'resume'
  };
  const issue = { ...identity, expiresAt: new Date(Date.now() + 30_000).toISOString() };
  for (const change of [
    { userId: randomUUID() },
    { authHash: 'other' },
    { controllerId: randomUUID() }
  ]) {
    await expect(voice.reconnectTicket({ ...issue, ...change })).rejects.toMatchObject({
      code: 'voice_session_unavailable'
    });
  }
  await voice.reconnectTicket(issue);
  const results = await Promise.allSettled([voice.reconnect(identity), voice.reconnect(identity)]);
  expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((value) => value.status === 'rejected')).toHaveLength(1);
  expect((await voice.get(f.user.id, f.id))?.controllerId).toBe(f.controllerId);
  expect(
    (await database.query('SELECT id FROM usage_entries WHERE user_id=$1', [f.user.id])).rows
  ).toEqual([]);
  await voice.reconnectTicket(issue);
  await database.query(
    "UPDATE voice_sessions SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [f.id]
  );
  await expect(voice.reconnect(identity)).rejects.toMatchObject({
    code: 'voice_session_unavailable'
  });
  await expect(voice.reconnectTicket(issue)).rejects.toMatchObject({
    code: 'voice_session_unavailable'
  });
});

it('recovers an expired API controller lease without clearing reservations or extending owner limits', async () => {
  const f = await fixture(false);
  f.input.session.shareTaskContext = true;
  await voice.create(f.input);
  await f.connect();
  const reservation = await voice.reserve(f.user.id, f.id, f.controllerId, 0.1);
  const request = {
    userId: f.user.id,
    id: f.id,
    authHash: 'auth',
    ticketHash: 'replacement',
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    minimumReservationUsd: 0.02
  };
  await expect(voice.recoveryTicket(request)).rejects.toMatchObject({
    code: 'voice_recovery_wait'
  });
  await database.query(
    "UPDATE voice_sessions SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
    [f.id]
  );
  const restored = await voice.recoveryTicket(request);
  expect(restored.session).toMatchObject({
    status: 'preparing',
    providerGeneration: 1,
    pendingUsd: 0.1,
    deadlineAt: f.input.session.deadlineAt,
    maxSpendUsd: f.input.session.maxSpendUsd
  });
  expect((await voice.pending(f.user.id, f.id)).map((row) => row.id)).toEqual([reservation]);
  await expect(
    voice.recoveryTicket({ ...request, authHash: 'wrong-owner-session' })
  ).rejects.toThrow('no longer available');
  await voice.finish(f.user.id, f.id, null, 'ended');
  await expect(voice.recoveryTicket(request)).rejects.toThrow('no longer available');
});
