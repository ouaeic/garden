import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@garden/data';
import { withTaskDeliveryStatus } from './task-delivery-status.js';

describe('batched task delivery summaries', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  beforeAll(async () =>
    database.exec(
      'CREATE TABLE provider_media_jobs(id UUID, user_id UUID, task_id UUID, output_path TEXT, status TEXT, created_at TIMESTAMPTZ)'
    )
  );
  afterAll(async () => database.close());
  it('reuses an owned page projection without a second query and refuses foreign cached projections', async () => {
    const userId = randomUUID();
    const tasks = [
      { id: randomUUID(), userId, deliveryStatus: 'pending' as const, pendingDeliveryCount: 1 }
    ];
    const query = vi.spyOn(database, 'query');
    expect(await withTaskDeliveryStatus(database, userId, tasks)).toEqual(tasks);
    expect(query).not.toHaveBeenCalled();
    expect((await withTaskDeliveryStatus(database, randomUUID(), tasks))[0]).toMatchObject({
      deliveryStatus: null,
      pendingDeliveryCount: 0
    });
    expect(query).toHaveBeenCalledOnce();
    query.mockRestore();
  });
  it('enriches a task page in one query and clears pending when the newest output attempt completes', async () => {
    const owner = randomUUID(),
      first = randomUUID(),
      second = randomUUID(),
      empty = randomUUID();
    const rows = [
      { id: randomUUID(), task: first, path: 'video.mp4', status: 'failed', time: '2026-01-01' },
      {
        id: randomUUID(),
        task: first,
        path: 'workspace/video.mp4',
        status: 'pending',
        time: '2026-01-02'
      },
      {
        id: randomUUID(),
        task: second,
        path: 'second.mp4',
        status: 'submission_uncertain',
        time: '2026-01-03'
      }
    ];
    for (const row of rows)
      await database.query('INSERT INTO provider_media_jobs VALUES($1,$2,$3,$4,$5,$6)', [
        row.id,
        owner,
        row.task,
        row.path,
        row.status,
        row.time
      ]);
    const spy = vi.spyOn(database, 'query');
    const tasks = [{ id: first }, { id: second }, { id: empty }];
    const before = await withTaskDeliveryStatus(database, owner, tasks);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(before.map((task) => [task.deliveryStatus, task.pendingDeliveryCount])).toEqual([
      ['pending', 1],
      ['incomplete', 0],
      [null, 0]
    ]);
    await database.query("UPDATE provider_media_jobs SET status='completed' WHERE id=$1", [
      rows[1]!.id
    ]);
    expect((await withTaskDeliveryStatus(database, owner, tasks))[0]?.deliveryStatus).toBe('ready');
    const foreign = await withTaskDeliveryStatus(database, randomUUID(), tasks);
    expect(foreign).toHaveLength(tasks.length);
    expect(foreign.every((task) => task.deliveryStatus === null)).toBe(true);
    const count = spy.mock.calls.length;
    expect(await withTaskDeliveryStatus(database, owner, [])).toEqual([]);
    expect(spy.mock.calls).toHaveLength(count);
    spy.mockRestore();
  });
});
