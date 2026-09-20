import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@athanor/data';
import { decryptJson, encryptJson, generateDataKey, wrapDataKey } from '@athanor/core';
import type { SupportedContext } from '../http/server-context.js';
import { createProviderWallMaintenance } from './provider-walls.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const masterKey = Buffer.alloc(32, 42);
const context = {
  database,
  store,
  masterKey,
  log: { info: vi.fn(), warn: vi.fn() }
} as unknown as SupportedContext;
let maintenance = createProviderWallMaintenance(context);
afterEach(async () => {
  vi.restoreAllMocks();
  await database.query("UPDATE tasks SET status='paused',lease_owner=NULL,lease_expires_at=NULL");
  maintenance = createProviderWallMaintenance(context);
});
beforeAll(() => migrateDatabase(database));
afterAll(() => database.close());

async function fixture(state: Record<string, unknown> = {}, owner?: { id: string }) {
  const user = owner ?? (await store.createUser({ username: randomUUID(), displayName: 'Owner' }));
  const key = generateDataKey(),
    workspaceId = randomUUID();
  await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Analysis',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: wrapDataKey(key, masterKey, workspaceId)
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId,
    titleCiphertext: encryptJson({ title: 'Analysis' }, key),
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'offline',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    promptCiphertext: encryptJson({ prompt: 'Analyse' }, key)
  });
  await store.appendTaskEvent({
    taskId: task.id,
    kind: 'warning',
    summary: 'Encrypted warning',
    payloadCiphertext: encryptJson(
      { summary: 'Provider unavailable', payload: { code: 'provider_unavailable' } },
      key,
      `task-event:${task.id}`
    )
  });
  const checkpoint = encryptJson(
    { messages: [], step: 2, credits: 0, ...state },
    key,
    `task-state:${task.id}`
  );
  await database.query(
    "UPDATE tasks SET status='awaiting_resource',attempt=1,updated_at=NOW()-INTERVAL '2 hours',agent_state_ciphertext=$2::jsonb WHERE id=$1",
    [task.id, JSON.stringify(checkpoint)]
  );
  return { user, task, key, checkpoint };
}

async function recover(mode: string, userId: string) {
  return mode === 'retry'
    ? maintenance.retryProviderWalls()
    : maintenance.resumeTasksWaitingOnAProvider(userId);
}

describe('provider recovery preserves the reason a task is waiting', () => {
  it.each(['retry', 'credentials'])(
    'does not let %s wake a current background wait',
    async (mode) => {
      const f = await fixture({ jobWaitId: randomUUID() });
      const before = await store.listTaskEvents(f.task.id);
      expect(
        await (mode === 'retry'
          ? maintenance.retryProviderWalls()
          : maintenance.resumeTasksWaitingOnAProvider(f.user.id))
      ).toBe(0);
      expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('awaiting_resource');
      expect(await store.listTaskEvents(f.task.id)).toEqual(before);
      await store.setTaskStatusForUser(f.user.id, f.task.id, 'paused');
    }
  );

  it.each(['retry', 'credentials'])('lets %s resume a provider hold exactly once', async (mode) => {
    const f = await fixture();
    const before = await store.listTaskEvents(f.task.id);
    expect(await recover(mode, f.user.id)).toBe(1);
    expect(await recover(mode, f.user.id)).toBe(0);
    expect(await store.getTask(f.user.id, f.task.id)).toMatchObject({
      status: 'queued',
      attempt: 0
    });
    const events = await store.listTaskEvents(f.task.id);
    expect(events).toHaveLength(before.length + 1);
    expect(
      decryptJson<{ payload: { code: string } }>(
        events.at(-1)!.payloadCiphertext!,
        f.key,
        `task-event:${f.task.id}`
      ).payload.code
    ).toBe(mode === 'retry' ? 'provider_unavailable' : 'provider_reconnected');
  });

  it.each(['retry', 'credentials'])(
    'keeps %s off unreadable, unrelated and child waits',
    async (mode) => {
      for (const reason of ['corrupt', 'unrelated', 'children']) {
        const f = await fixture();
        if (reason === 'corrupt')
          await database.query('UPDATE tasks SET agent_state_ciphertext=$2::jsonb WHERE id=$1', [
            f.task.id,
            JSON.stringify(encryptJson({}, generateDataKey(), `task-state:${f.task.id}`))
          ]);
        if (reason === 'unrelated')
          await store.appendTaskEvent({
            taskId: f.task.id,
            kind: 'error',
            summary: 'Encrypted warning',
            payloadCiphertext: encryptJson(
              { summary: 'A different wait', payload: { code: 'different_failure' } },
              f.key,
              `task-event:${f.task.id}`
            )
          });
        if (reason === 'children')
          await database.query(
            'INSERT INTO coding_families(parent_task_id,ceiling_credits,initial_credits,wait_requested) VALUES ($1,1,0,TRUE)',
            [f.task.id]
          );
        const before = await store.listTaskEvents(f.task.id);
        expect(await recover(mode, f.user.id), reason).toBe(0);
        expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('awaiting_resource');
        expect(await store.listTaskEvents(f.task.id)).toEqual(before);
        await store.setTaskStatusForUser(f.user.id, f.task.id, 'paused');
      }
    }
  );

  it.each(['retry', 'credentials'])(
    'does not let %s override a change after inspecting a hold',
    async (mode) => {
      for (const change of [
        'paused',
        'cancelled',
        'completed',
        'checkpoint',
        'timestamp',
        'lease',
        'children',
        'sealed_child'
      ]) {
        const f = await fixture();
        const before = await store.listTaskEvents(f.task.id);
        const original = store.resumeTaskFromResourceWait.bind(store);
        const spy = vi
          .spyOn(store, 'resumeTaskFromResourceWait')
          .mockImplementationOnce(async (input) => {
            if (change === 'checkpoint')
              await database.query(
                'UPDATE tasks SET agent_state_ciphertext=$2::jsonb WHERE id=$1',
                [
                  f.task.id,
                  JSON.stringify(
                    encryptJson({ jobWaitId: randomUUID() }, f.key, `task-state:${f.task.id}`)
                  )
                ]
              );
            else if (change === 'timestamp')
              await database.query(
                "UPDATE tasks SET updated_at=updated_at+INTERVAL '1 microsecond' WHERE id=$1",
                [f.task.id]
              );
            else if (change === 'lease')
              await database.query(
                "UPDATE tasks SET lease_owner='other-worker',lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
                [f.task.id]
              );
            else if (change === 'children')
              await database.query(
                'INSERT INTO coding_families(parent_task_id,ceiling_credits,initial_credits,wait_requested) VALUES ($1,1,0,TRUE)',
                [f.task.id]
              );
            else if (change === 'sealed_child')
              await database.query('UPDATE tasks SET parent_mission_id=$2 WHERE id=$1', [
                f.task.id,
                randomUUID()
              ]);
            else await store.setTaskStatusForUser(f.user.id, f.task.id, change);
            return original(input);
          });
        expect(await recover(mode, f.user.id), change).toBe(0);
        expect(spy).toHaveBeenCalledOnce();
        expect((await store.getTask(f.user.id, f.task.id))?.status).not.toBe('queued');
        expect(await store.listTaskEvents(f.task.id)).toEqual(before);
        spy.mockRestore();
        await store.setTaskStatusForUser(f.user.id, f.task.id, 'paused');
      }
    }
  );

  it('does not let old background records block a later provider hold', async () => {
    const f = await fixture();
    await database.query(
      'INSERT INTO task_job_waits(task_id,id,dependencies_ciphertext) VALUES ($1,$2,$3::jsonb)',
      [f.task.id, randomUUID(), JSON.stringify(encryptJson({}, f.key))]
    );
    expect(await maintenance.retryProviderWalls()).toBe(1);
  });

  it('supports a provider hold before the first checkpoint', async () => {
    const f = await fixture();
    await database.query('UPDATE tasks SET agent_state_ciphertext=NULL WHERE id=$1', [f.task.id]);
    expect(await maintenance.resumeTasksWaitingOnAProvider(f.user.id)).toBe(1);
  });

  it('rejects a recovery attempt by another owner without leaving a retry event', async () => {
    const f = await fixture();
    const timestamp = await database.query<{ updated_at: string }>(
      'SELECT updated_at::text AS updated_at FROM tasks WHERE id=$1',
      [f.task.id]
    );
    const before = await store.listTaskEvents(f.task.id);
    expect(
      await store.resumeTaskFromResourceWait({
        userId: randomUUID(),
        taskId: f.task.id,
        expectedUpdatedAt: timestamp.rows[0]!.updated_at,
        expectedStateCiphertext: f.checkpoint,
        eventSummary: 'Should not be written',
        eventCiphertext: encryptJson({}, f.key)
      })
    ).toBe(false);
    expect(await store.listTaskEvents(f.task.id)).toEqual(before);
  });

  it('rotates retry scans past a full page of analysis waits', async () => {
    const fixtures = [];
    for (let i = 0; i < 21; i++) fixtures.push(await fixture({ jobWaitId: randomUUID() }));
    const last = [...fixtures].sort((a, b) => a.task.id.localeCompare(b.task.id)).at(-1)!;
    await database.query('UPDATE tasks SET agent_state_ciphertext=$2::jsonb WHERE id=$1', [
      last.task.id,
      JSON.stringify(encryptJson({}, last.key, `task-state:${last.task.id}`))
    ]);
    expect(await maintenance.retryProviderWalls()).toBe(0);
    expect(await maintenance.retryProviderWalls()).toBe(1);
    expect((await store.getTask(last.user.id, last.task.id))?.status).toBe('queued');
    for (const f of fixtures.filter((f) => f !== last))
      expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('awaiting_resource');
  });

  it('saving a key reaches provider holds beyond a full page of analysis waits', async () => {
    const owner = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
    const fixtures = [];
    for (let i = 0; i < 51; i++) fixtures.push(await fixture({ jobWaitId: randomUUID() }, owner));
    const last = [...fixtures].sort((a, b) => a.task.id.localeCompare(b.task.id)).at(-1)!;
    await database.query('UPDATE tasks SET agent_state_ciphertext=$2::jsonb WHERE id=$1', [
      last.task.id,
      JSON.stringify(encryptJson({}, last.key, `task-state:${last.task.id}`))
    ]);
    expect(await maintenance.resumeTasksWaitingOnAProvider(owner.id)).toBe(1);
    for (const f of fixtures)
      expect((await store.getTask(owner.id, f.task.id))?.status).toBe(
        f === last ? 'queued' : 'awaiting_resource'
      );
  });
});
