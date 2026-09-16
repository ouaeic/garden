import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore, TASK_MAX_ATTEMPTS } from './store.js';
import type { TaskRecord } from './types.js';

describe('task reasoning preferences survive each durable message path', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database);
  const envelope = { v: 1 as const, iv: 'iv', tag: 'tag', ciphertext: 'sealed' };
  let userId = '',
    workspaceId = '';
  beforeAll(async () => {
    await migrateDatabase(database);
    const user = await store.createUser({ username: 'effort-owner', displayName: 'Owner' });
    userId = user.id;
    workspaceId = (
      await store.createWorkspace({
        userId,
        name: 'Science',
        storageLimitBytes: 1_000_000,
        imageRevision: 'test',
        region: 'local',
        wrappedKey: 'test'
      })
    ).id;
  });
  afterAll(async () => database.close());
  const create = (reasoningEffort?: TaskRecord['reasoningEffort']) =>
    store.createTask({
      userId,
      workspaceId,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 10,
      ...(reasoningEffort ? { reasoningEffort } : {})
    });
  const queue = async (
    taskId: string,
    effort: NonNullable<TaskRecord['reasoningEffort']>,
    securityMode?: TaskRecord['securityMode']
  ) => {
    const id = randomUUID();
    await store.enqueueTaskMessage({
      id,
      taskId,
      userId,
      modelId: 'model',
      reasoningEffort: effort,
      ...(securityMode ? { securityMode } : {}),
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      resourceClass: 'light',
      reservationKey: `message:${id}`,
      promptCiphertext: envelope,
      queuedEventCiphertext: envelope,
      interrupt: true
    });
    return id;
  };

  it('defaults historical-style callers to Auto and reads a choice after reopening the store', async () => {
    expect((await create()).reasoningEffort).toBe('auto');
    const task = await create('max');
    expect((await new DataStore(database).getTask(userId, task.id))?.reasoningEffort).toBe('max');
  });

  it('keeps queued preferences separate until atomic promotion', async () => {
    const task = await create('high');
    const messageId = await queue(task.id, 'minimal', 'autonomous');
    expect((await store.getTask(userId, task.id))?.reasoningEffort).toBe('high');
    expect((await store.getTask(userId, task.id))?.securityMode).toBe('balanced');
    expect((await store.getNextQueuedTaskMessage(task.id))?.reasoningEffort).toBe('minimal');
    await database.query("UPDATE tasks SET lease_owner='worker',status='running' WHERE id=$1", [
      task.id
    ]);
    const promoted = await store.promoteQueuedTaskMessage({
      taskId: task.id,
      messageId,
      workerId: 'worker',
      modelId: 'model',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 1,
      agentStateCiphertext: envelope,
      userMessageCiphertext: envelope,
      statusEventCiphertext: envelope
    });
    expect(promoted?.reasoningEffort).toBe('minimal');
    expect(promoted?.securityMode).toBe('autonomous');
    expect(await store.getNextQueuedTaskMessage(task.id)).toBeNull();
  });

  it('applies an in-turn correction only under the active lease', async () => {
    const task = await create('low');
    const messageId = await queue(task.id, 'xhigh', 'review');
    await database.query("UPDATE tasks SET lease_owner='worker',status='running' WHERE id=$1", [
      task.id
    ]);
    const input = {
      taskId: task.id,
      messageId,
      workerId: 'wrong-worker',
      additionalComputeCredits: 1,
      userMessageCiphertext: envelope
    };
    expect(await store.consumeQueuedTaskMessageInTurn(input)).toBe(false);
    expect((await store.getTask(userId, task.id))?.reasoningEffort).toBe('low');
    expect(await store.consumeQueuedTaskMessageInTurn({ ...input, workerId: 'worker' })).toBe(
      false
    );
    await database.query(
      "UPDATE tasks SET lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
      [task.id]
    );
    expect(await store.consumeQueuedTaskMessageInTurn({ ...input, workerId: 'worker' })).toBe(true);
    expect((await store.getTask(userId, task.id))?.reasoningEffort).toBe('xhigh');
    expect((await store.getTask(userId, task.id))?.securityMode).toBe('review');
  });

  it('preserves a choice on follow-up and lets the owner explicitly restore Auto', async () => {
    const task = await create('high');
    await database.query("UPDATE tasks SET status='completed' WHERE id=$1", [task.id]);
    const input = {
      id: task.id,
      userId,
      modelId: 'model',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 1,
      agentStateCiphertext: envelope,
      reservationKey: `followup:${randomUUID()}`,
      resourceClass: 'light',
      userMessageCiphertext: envelope
    };
    expect((await store.continueTask(input))?.reasoningEffort).toBe('high');
    await database.query("UPDATE tasks SET status='completed' WHERE id=$1", [task.id]);
    expect(
      (
        await store.continueTask({
          ...input,
          reservationKey: `followup:${randomUUID()}`,
          reasoningEffort: 'auto',
          securityMode: 'autonomous'
        })
      )?.reasoningEffort
    ).toBe('auto');
    expect((await store.getTask(userId, task.id))?.securityMode).toBe('autonomous');
  });

  it('inherits the parent preference when branching', async () => {
    const parent = await create('low');
    const branch = await store.createTaskBranch({
      userId,
      workspaceId,
      parentTaskId: parent.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      agentStateCiphertext: envelope,
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'model',
      privacyRoute: 'provider_zdr'
    });
    expect(branch.reasoningEffort).toBe('low');
  });
  it.each(['cancel', 'attempt-limit'] as const)(
    'keeps independent provider reservations when the task ends through %s',
    async (ending) => {
      const task = await create();
      const reserve = async (kind: string, suffix: string) =>
        database.query(
          `INSERT INTO usage_entries(id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'media:video',1,'jobs',1,'reserved',$6)`,
          [randomUUID(), userId, workspaceId, task.id, kind, `${task.id}:${suffix}`]
        );
      await reserve('task_compute', 'task');
      await reserve('model_inference', 'provider-job');
      if (ending === 'cancel')
        expect(await store.cancelTaskAndReleaseReservations(userId, task.id)).toBe(true);
      else {
        await database.query('UPDATE tasks SET attempt=$2 WHERE id=$1', [
          task.id,
          TASK_MAX_ATTEMPTS
        ]);
        expect((await store.failTasksAtAttemptLimit()).some((entry) => entry.id === task.id)).toBe(
          true
        );
      }
      const rows = (
        await database.query(
          'SELECT kind,state FROM usage_entries WHERE task_id=$1 ORDER BY kind',
          [task.id]
        )
      ).rows;
      expect(rows).toHaveLength(2);
      expect(rows).toEqual([
        { kind: 'model_inference', state: 'reserved' },
        { kind: 'task_compute', state: 'released' }
      ]);
    }
  );
});
