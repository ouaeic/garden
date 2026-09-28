import { randomUUID } from 'node:crypto';
import { decryptJson, encryptJson } from '@garden/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from '../database.js';
import { DataStore } from '../store.js';
import { migrations } from '../migrations.js';
import { TASK_QUEUE_CHANNEL } from './tasks.js';

const envelope = { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' } as const;
let database: Database;
let store: DataStore;
beforeEach(async () => {
  database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  await migrateDatabase(database);
  store = new DataStore(database);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.close();
});

async function seed() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspace = await store.createWorkspace({
    userId: user.id,
    name: 'Approval fixture',
    storageLimitBytes: 1024 ** 3,
    imageRevision: 'fixture',
    region: 'auto',
    wrappedKey: 'fixture'
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId: workspace.id,
    titleCiphertext: envelope,
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'fixture',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    promptCiphertext: envelope
  });
  await database.query(
    "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
    [task.id]
  );
  const input = {
    id: randomUUID(),
    userId: user.id,
    taskId: task.id,
    workerId: 'worker',
    action: 'shell',
    sideEffect: 'external_consequential',
    previewCiphertext: envelope,
    previewHash: 'fixture',
    expiresAt: new Date(Date.now() + 60_000),
    agentStateCiphertext: { ...envelope, ciphertext: 'pending-call' },
    actualComputeCredits: 0.25
  };
  return { user, task, input };
}

describe('approval and continuation transactions', () => {
  it.each(['approved', 'denied'] as const)(
    'settles %s once and wakes the queued continuation',
    async (decision) => {
      const { user, task, input } = await seed();
      expect(await store.parkTaskForApproval(input)).toBe(true);
      expect(await store.getTask(user.id, task.id)).toMatchObject({
        status: 'awaiting_user',
        leaseOwner: null,
        agentStateCiphertext: input.agentStateCiphertext
      });
      const signal = vi.spyOn(database, 'notify');
      expect(await store.resolveApproval(user.id, input.id, decision)).toBe(true);
      expect(signal).toHaveBeenCalledWith(TASK_QUEUE_CHANNEL, task.id);
      expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'queued' });
      expect(await store.getApproval(input.id)).toMatchObject({ status: decision });
      expect(await store.resolveApproval(user.id, input.id, decision)).toBe(false);
    }
  );

  it('settles the card without removing an owner pause', async () => {
    const { user, task, input } = await seed();
    expect(await store.parkTaskForApproval(input)).toBe(true);
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    expect(await store.resolveApproval(user.id, input.id, 'approved')).toBe(true);
    expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'paused' });
  });

  it.each(['completed', 'failed', 'cancelled'])('never restarts a %s task', async (status) => {
    const { user, task, input } = await seed();
    expect(await store.parkTaskForApproval(input)).toBe(true);
    await store.setTaskStatusForUser(user.id, task.id, status);
    expect(await store.resolveApproval(user.id, input.id, 'approved')).toBe(false);
    expect(await store.getTask(user.id, task.id)).toMatchObject({ status });
  });

  it('leaves cancellation authoritative on either side of the answer', async () => {
    for (const answerFirst of [true, false]) {
      const { user, task, input } = await seed();
      expect(await store.parkTaskForApproval(input)).toBe(true);
      if (answerFirst)
        expect(await store.resolveApproval(user.id, input.id, 'approved')).toBe(true);
      expect(await store.cancelTaskAndReleaseReservations(user.id, task.id)).toBe(true);
      if (!answerFirst)
        expect(await store.resolveApproval(user.id, input.id, 'approved')).toBe(false);
      expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'cancelled' });
    }
  });

  it('refuses foreign and expired decisions before changing task state', async () => {
    const { user, task, input } = await seed();
    expect(await store.parkTaskForApproval(input)).toBe(true);
    expect(await store.resolveApproval(randomUUID(), input.id, 'approved')).toBe(false);
    await database.query("UPDATE approvals SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [
      input.id
    ]);
    expect(await store.resolveApproval(user.id, input.id, 'approved')).toBe(false);
    expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'awaiting_user' });
    expect(await store.getApproval(input.id)).toMatchObject({ status: 'pending' });
  });

  it('rolls back the decision when its task cannot be queued', async () => {
    const { user, task, input } = await seed();
    expect(await store.parkTaskForApproval(input)).toBe(true);
    await database.query(`CREATE FUNCTION refuse_approval_queue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'queued' THEN RAISE EXCEPTION 'fixture queue failure'; END IF;
        RETURN NEW;
      END $$`);
    await database.query(`CREATE TRIGGER refuse_approval_queue BEFORE UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION refuse_approval_queue()`);
    await expect(store.resolveApproval(user.id, input.id, 'approved')).rejects.toThrow(
      'fixture queue failure'
    );
    expect(await store.getApproval(input.id)).toMatchObject({ status: 'pending' });
    expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'awaiting_user' });
  });

  it('rolls back parking if its card cannot be inserted', async () => {
    const { user, task, input } = await seed();
    const existingId = await store.createApproval(input);
    await expect(store.parkTaskForApproval({ ...input, id: existingId })).rejects.toThrow();
    expect(await store.getTask(user.id, task.id)).toMatchObject({
      status: 'running',
      leaseOwner: 'worker',
      agentStateCiphertext: null
    });
    const cards = await store.listApprovals(user.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe(existingId);
  });

  it.each(['paused', 'cancelled', 'expired', 'replacement'])(
    'does not publish a decision from a %s lease',
    async (kind) => {
      const { user, task, input } = await seed();
      if (kind === 'paused' || kind === 'cancelled')
        await store.setTaskStatusForUser(user.id, task.id, kind);
      else if (kind === 'expired')
        await database.query(
          "UPDATE tasks SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
          [task.id]
        );
      else input.workerId = 'another-worker';
      expect(await store.parkTaskForApproval(input)).toBe(false);
      expect(await store.getApproval(input.id)).toBeNull();
      expect((await store.getTask(user.id, task.id))?.agentStateCiphertext).toBeNull();
    }
  );
});

const denialKey = Buffer.alloc(32, 23);
const denialCorrection = (taskId: string) => ({
  promptCiphertext: encryptJson(
    { prompt: 'Use a valid copy argument.' },
    denialKey,
    `task-message:${taskId}`
  ),
  queuedEventCiphertext: encryptJson(
    { markdown: 'Use a valid copy argument.' },
    denialKey,
    `task-event:${taskId}`
  )
});

describe('denial corrections within existing task authority', () => {
  it('commits one encrypted interrupt with no usage allocation under concurrent answers', async () => {
    const { user, task, input } = await seed();
    await store.parkTaskForApproval(input);
    const before = (
      await database.query('SELECT * FROM usage_entries WHERE task_id=$1 ORDER BY id', [task.id])
    ).rows;
    const correction = denialCorrection(task.id);
    const decisions = await Promise.all([
      store.resolveApproval(user.id, input.id, 'denied', correction),
      store.resolveApproval(user.id, input.id, 'denied', correction)
    ]);
    expect(decisions.sort()).toEqual([false, true]);
    const queued = await store.getNextQueuedTaskMessage(task.id, { interruptOnly: true });
    expect(queued).toMatchObject({
      approvalId: input.id,
      interrupt: true,
      maxComputeCredits: 0,
      maxSpendUsd: null
    });
    expect(decryptJson(queued!.promptCiphertext, denialKey, `task-message:${task.id}`)).toEqual({
      prompt: 'Use a valid copy argument.'
    });
    const events = (
      await database.query("SELECT * FROM task_events WHERE task_id=$1 AND kind='queued_message'", [
        task.id
      ])
    ).rows;
    expect(events).toHaveLength(1);
    expect(
      decryptJson(
        events[0]!.payload_ciphertext as typeof correction.queuedEventCiphertext,
        denialKey,
        `task-event:${task.id}`
      )
    ).toEqual({ markdown: 'Use a valid copy argument.' });
    expect(JSON.stringify(events)).not.toContain('Use a valid copy');
    expect(
      (await database.query('SELECT * FROM usage_entries WHERE task_id=$1 ORDER BY id', [task.id]))
        .rows
    ).toEqual(before);
    expect(await store.getTask(user.id, task.id)).toMatchObject({
      maxComputeCredits: 1,
      maxSpendUsd: null,
      modelId: task.modelId,
      privacyRoute: task.privacyRoute
    });
  });

  it('prioritizes denial without losing older messages and atomically retains current settings and state', async () => {
    const { user, task, input } = await seed();
    const ordinary = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      ordinary.push(id);
      await store.enqueueTaskMessage({
        id,
        taskId: task.id,
        userId: user.id,
        modelId: 'older',
        privacyRoute: 'external',
        reasoningEffort: 'low',
        maxComputeCredits: 2,
        maxSpendUsd: 3,
        resourceClass: 'task_compute',
        reservationKey: id,
        interrupt: true,
        ...denialCorrection(task.id)
      });
      await database.query(
        "UPDATE task_message_queue SET created_at=NOW()-($2::integer * INTERVAL '1 minute') WHERE id=$1",
        [id, 2 - i]
      );
    }
    await store.parkTaskForApproval(input);
    await store.resolveApproval(user.id, input.id, 'denied', denialCorrection(task.id));
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 minute',reasoning_effort='high',model_id='current',privacy_route='provider_zdr',max_spend_usd=8 WHERE id=$1",
      [task.id]
    );
    const queued = (await store.getNextQueuedTaskMessage(task.id, { interruptOnly: true }))!;
    expect(queued).toMatchObject({
      approvalId: input.id,
      reasoningEffort: 'high',
      modelId: 'current',
      privacyRoute: 'provider_zdr'
    });
    const state = encryptJson(
      { messages: [{ role: 'user', content: 'Use a valid copy argument.' }] },
      denialKey,
      `task-state:${task.id}`
    );
    const consume = {
      taskId: task.id,
      messageId: queued.id,
      workerId: 'worker',
      additionalComputeCredits: 999,
      additionalSpendUsd: 999,
      userMessageCiphertext: denialCorrection(task.id).queuedEventCiphertext,
      agentStateCiphertext: state
    };
    expect(await store.consumeQueuedTaskMessageInTurn(consume)).toBe(true);
    expect(await store.consumeQueuedTaskMessageInTurn(consume)).toBe(false);
    expect(await store.getTask(user.id, task.id)).toMatchObject({
      maxComputeCredits: 1,
      maxSpendUsd: 8,
      reasoningEffort: 'high',
      modelId: 'current',
      privacyRoute: 'provider_zdr',
      agentStateCiphertext: state
    });
    expect((await store.getNextQueuedTaskMessage(task.id))?.id).toBe(ordinary[0]);
    expect(
      (
        await database.query(
          "SELECT id FROM task_message_queue WHERE task_id=$1 AND status='queued' ORDER BY created_at,id",
          [task.id]
        )
      ).rows.map((row) => row.id)
    ).toEqual(ordinary);
  });

  it('keeps paused corrections dormant and refuses terminal, expired and foreign decisions', async () => {
    const { user, task, input } = await seed();
    await store.parkTaskForApproval(input);
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    expect(
      await store.resolveApproval(user.id, input.id, 'denied', denialCorrection(task.id))
    ).toBe(true);
    expect(await store.getTask(user.id, task.id)).toMatchObject({
      status: 'paused',
      leaseOwner: null
    });
    const queued = (await store.getNextQueuedTaskMessage(task.id))!;
    expect(
      await store.consumeQueuedTaskMessageInTurn({
        taskId: task.id,
        messageId: queued.id,
        workerId: 'worker',
        additionalComputeCredits: 0,
        userMessageCiphertext: envelope
      })
    ).toBe(false);
    for (const mode of ['completed', 'failed', 'cancelled', 'expired', 'foreign']) {
      const f = await seed();
      await store.parkTaskForApproval(f.input);
      if (mode === 'expired')
        await database.query(
          "UPDATE approvals SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
          [f.input.id]
        );
      else if (mode !== 'foreign') await store.setTaskStatusForUser(f.user.id, f.task.id, mode);
      expect(
        await store.resolveApproval(
          mode === 'foreign' ? randomUUID() : f.user.id,
          f.input.id,
          'denied',
          denialCorrection(f.task.id)
        )
      ).toBe(false);
      expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
    }
  });

  it('rolls back the decision and queue when its timeline insert fails', async () => {
    const { user, task, input } = await seed();
    await store.parkTaskForApproval(input);
    await database.query(
      `CREATE FUNCTION refuse_denial_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='queued_message' THEN RAISE EXCEPTION 'fixture correction event failure'; END IF; RETURN NEW; END $$`
    );
    await database.query(
      `CREATE TRIGGER refuse_denial_event BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION refuse_denial_event()`
    );
    await expect(
      store.resolveApproval(user.id, input.id, 'denied', denialCorrection(task.id))
    ).rejects.toThrow('fixture correction event failure');
    expect(await store.getApproval(input.id)).toMatchObject({ status: 'pending' });
    expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'awaiting_user' });
    expect(await store.getNextQueuedTaskMessage(task.id)).toBeNull();
  });

  it('does not consume a denial without its checkpoint and rolls back all consumption on a state-write failure', async () => {
    const { user, task, input } = await seed();
    await store.parkTaskForApproval(input);
    await store.resolveApproval(user.id, input.id, 'denied', denialCorrection(task.id));
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
      [task.id]
    );
    const queued = (await store.getNextQueuedTaskMessage(task.id))!;
    const consume = {
      taskId: task.id,
      messageId: queued.id,
      workerId: 'worker',
      additionalComputeCredits: 0,
      userMessageCiphertext: denialCorrection(task.id).queuedEventCiphertext
    };
    await expect(store.consumeQueuedTaskMessageInTurn(consume)).rejects.toMatchObject({
      code: 'approval_correction_checkpoint'
    });
    await database.query(
      `CREATE FUNCTION refuse_denial_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.agent_state_ciphertext IS DISTINCT FROM OLD.agent_state_ciphertext THEN RAISE EXCEPTION 'fixture correction state failure'; END IF; RETURN NEW; END $$`
    );
    await database.query(
      `CREATE TRIGGER refuse_denial_state BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_denial_state()`
    );
    await expect(
      store.consumeQueuedTaskMessageInTurn({
        ...consume,
        agentStateCiphertext: encryptJson({ messages: [] }, denialKey, `task-state:${task.id}`)
      })
    ).rejects.toThrow('fixture correction state failure');
    expect((await store.getNextQueuedTaskMessage(task.id))?.id).toBe(queued.id);
    expect(
      (
        await database.query(
          "SELECT id FROM task_events WHERE task_id=$1 AND kind='user_message'",
          [task.id]
        )
      ).rows
    ).toHaveLength(0);
    expect(await store.getTask(user.id, task.id)).toMatchObject({
      agentStateCiphertext: input.agentStateCiphertext
    });
  });

  it('database constraints reject allocation or noninterrupt authority on a bound correction', async () => {
    const { user, task, input } = await seed();
    await store.parkTaskForApproval(input);
    await store.resolveApproval(user.id, input.id, 'denied', denialCorrection(task.id));
    const migration = migrations.find((item) => item.version === 94);
    expect(migration).toBeDefined();
    await database.exec(migration!.sql);
    expect(
      (await database.query('SELECT id FROM task_message_queue WHERE approval_id=$1', [input.id]))
        .rows
    ).toHaveLength(1);
    for (const assignment of ['max_compute_credits=1', 'max_spend_usd=1', 'interrupt=FALSE'])
      await expect(
        database.query(`UPDATE task_message_queue SET ${assignment} WHERE approval_id=$1`, [
          input.id
        ])
      ).rejects.toThrow('approval_correction_retains_allocation');
    await expect(
      store.resolveApproval(user.id, input.id, 'approved', denialCorrection(task.id))
    ).rejects.toMatchObject({ code: 'approval_correction_invalid' });
  });
});

describe('denial handoff preserves the current owner controls', () => {
  it('refuses stale or paused promotion and preserves allocation/settings when a live worker hands off', async () => {
    const { user, task, input } = await seed();
    await store.parkTaskForApproval(input);
    await store.resolveApproval(user.id, input.id, 'denied', denialCorrection(task.id));
    const queued = (await store.getNextQueuedTaskMessage(task.id))!;
    const promote = {
      taskId: task.id,
      messageId: queued.id,
      workerId: 'worker',
      modelId: 'stale',
      privacyRoute: 'external',
      additionalComputeCredits: 999,
      additionalSpendUsd: 999,
      agentStateCiphertext: encryptJson({ messages: [] }, denialKey, `task-state:${task.id}`),
      userMessageCiphertext: denialCorrection(task.id).queuedEventCiphertext,
      statusEventCiphertext: envelope
    };
    for (const mode of ['expired', 'paused', 'cancelled', 'completed']) {
      await database.query(
        "UPDATE tasks SET status=$2,lease_owner='worker',lease_expires_at=NOW()+($3::integer * INTERVAL '1 minute'),model_id='current',reasoning_effort='high',max_spend_usd=8 WHERE id=$1",
        [task.id, mode === 'expired' ? 'running' : mode, mode === 'expired' ? -1 : 1]
      );
      expect(await store.promoteQueuedTaskMessage(promote)).toBeNull();
      expect((await store.getNextQueuedTaskMessage(task.id))?.id).toBe(queued.id);
    }
    await database.query("UPDATE tasks SET status='running' WHERE id=$1", [task.id]);
    expect(await store.promoteQueuedTaskMessage(promote)).toMatchObject({
      modelId: 'current',
      reasoningEffort: 'high',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      maxSpendUsd: 8
    });
  });
});
