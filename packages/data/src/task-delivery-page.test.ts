import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore } from './store.js';
import { taskDeliveryCountsSql } from './task-delivery.js';
import { PENDING_MEDIA_DELIVERY } from '@garden/contracts';
const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const sealed = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
beforeAll(async () => migrateDatabase(database));
afterAll(async () => database.close());
describe('bounded page delivery projection', () => {
  it('returns current owner-scoped output state in one page query without changing pagination', async () => {
    const owner = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
    const foreign = await store.createUser({ username: randomUUID(), displayName: 'Other' });
    const workspace = await store.createWorkspace({
      userId: owner.id,
      name: 'Work',
      storageLimitBytes: 1e9,
      imageRevision: 'test',
      region: 'local',
      wrappedKey: 'sealed'
    });
    const tasks = [];
    for (let index = 0; index < 3; index++) {
      const task = await store.createTask({
        userId: owner.id,
        workspaceId: workspace.id,
        titleCiphertext: sealed,
        promptCiphertext: sealed,
        modelId: 'model',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        nameIndex: { nameTokens: '', openingTokens: '' }
      });
      await database.query('UPDATE tasks SET created_at=$2,updated_at=$2 WHERE id=$1', [
        task.id,
        `2026-01-0${3 - index}T00:00:00Z`
      ]);
      tasks.push(task);
    }
    const job = async (
      taskId: string,
      path: string,
      status: string,
      time: string,
      userId = owner.id
    ) => {
      const id = randomUUID();
      await database.query(
        `INSERT INTO provider_media_jobs(id,user_id,workspace_id,task_id,request_key,request_hash,request_ciphertext,model_id,status,reservation_usd,retention_approved_at,output_path,created_at)
        VALUES($1,$2,$3,$4,$9,'hash',$5::jsonb,'model',$6,0.1,NOW(),$7,$8)`,
        [id, userId, workspace.id, taskId, JSON.stringify(sealed), status, path, time, id]
      );
      return id;
    };
    await job(tasks[0]!.id, 'video.mp4', 'failed', '2026-01-01');
    const pending = await job(tasks[0]!.id, 'workspace/video.mp4', 'pending', '2026-01-02');
    await job(tasks[0]!.id, 'foreign.mp4', 'failed', '2026-01-03', foreign.id);
    await job(tasks[1]!.id, 'done.mp4', 'completed', '2026-01-01');
    const scoped = await database.query(taskDeliveryCountsSql('SELECT $2::uuid', '$3'), [
      owner.id,
      tasks[0]!.id,
      [...PENDING_MEDIA_DELIVERY]
    ]);
    expect(scoped.rows).toEqual([{ task_id: tasks[0]!.id, pending: 1, failed: 0 }]);
    const query = vi.spyOn(database, 'query');
    const first = await store.listTaskPage(owner.id, { limit: 1 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(first.tasks).toHaveLength(1);
    expect(first.tasks[0]).toMatchObject({
      id: tasks[0]!.id,
      deliveryStatus: 'pending',
      pendingDeliveryCount: 1
    });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listTaskPage(owner.id, { limit: 1, cursor: first.nextCursor });
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0]).toMatchObject({
      id: tasks[1]!.id,
      deliveryStatus: 'ready',
      pendingDeliveryCount: 0
    });
    const third = await store.listTaskPage(owner.id, { limit: 1, cursor: second.nextCursor });
    expect(third.tasks).toHaveLength(1);
    expect(third.tasks[0]).toMatchObject({
      id: tasks[2]!.id,
      deliveryStatus: null,
      pendingDeliveryCount: 0
    });
    expect(third.hasMore).toBe(false);
    expect((await store.listTaskPage(foreign.id)).tasks).toEqual([]);
    await database.query("UPDATE provider_media_jobs SET status='completed' WHERE id=$1", [
      pending
    ]);
    expect((await store.listTaskPage(owner.id, { limit: 1 })).tasks[0]).toMatchObject({
      deliveryStatus: 'ready',
      pendingDeliveryCount: 0
    });
    query.mockRestore();
  });
});
