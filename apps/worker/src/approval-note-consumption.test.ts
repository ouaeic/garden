import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { decryptJson, encryptJson } from '@garden/core';
import type { ModelRelease, WebToolPlan } from '@garden/contracts';
import type { AgentState } from './agent-state.js';
import { drainCorrection } from './turn-control.js';
import { resumeParkedTurn, type TurnResumeDeps } from './turn/resume.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
  store = new DataStore(database);
const key = Buffer.alloc(32, 18);
beforeAll(async () => migrateDatabase(database));
afterAll(async () => database.close());
async function fixture(question = false) {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspace = await store.createWorkspace({
    userId: user.id,
    name: 'Work',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: 'fixture'
  });
  const sealed = encryptJson({}, key, 'fixture');
  const task = await store.createTask({
    userId: user.id,
    workspaceId: workspace.id,
    modelId: 'selected',
    reasoningEffort: 'high',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 5,
    maxSpendUsd: 2,
    titleCiphertext: sealed,
    promptCiphertext: sealed,
    nameIndex: { nameTokens: '', openingTokens: '' }
  });
  const state = {
    messages: [{ role: 'user', content: 'Make the copy' }],
    step: 1,
    turn: 0,
    credits: 0.2,
    ownerReasoningEffort: 'high',
    ...(question ? { question: { question: 'Which folder?', askedAtStep: 1 } } : {})
  } as AgentState;
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
    previewHash: 'fixture',
    previewCiphertext: sealed,
    expiresAt: new Date(Date.now() + 60_000),
    actualComputeCredits: 0.2,
    agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
  });
  await store.resolveApproval(user.id, approvalId, 'denied', {
    promptCiphertext: encryptJson(
      { prompt: 'Use valid copy syntax.\nKeep the destination.' },
      key,
      `task-message:${task.id}`
    ),
    queuedEventCiphertext: encryptJson(
      { markdown: 'Use valid copy syntax.' },
      key,
      `task-event:${task.id}`
    )
  });
  await database.query(
    "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
    [task.id]
  );
  const current = (await store.getTask(user.id, task.id))!;
  const checkpoint = vi.fn(async () => {
    throw new Error('Separate checkpoint must not be necessary');
  });
  const deps = { store, config: { WORKER_ID: 'worker' }, checkpoint } as unknown as TurnResumeDeps;
  return { task: current, state, deps, approvalId, checkpoint };
}

describe('denied owner reason in the active trajectory', () => {
  it('commits owner words and consumption together, preserves effort and cannot duplicate after restart', async () => {
    const f = await fixture();
    expect(await drainCorrection(f.deps, f.task, key, f.state)).toBe(true);
    expect(f.state.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Use valid copy syntax.\nKeep the destination.'
    });
    expect(f.state.ownerReasoningEffort).toBe('high');
    expect(f.task.reasoningEffort).toBe('high');
    const persisted = (await store.getTask(f.task.userId, f.task.id))!;
    expect(decryptJson(persisted.agentStateCiphertext!, key, `task-state:${f.task.id}`)).toEqual(
      f.state
    );
    expect(f.checkpoint).not.toHaveBeenCalled();
    const restarted = decryptJson<AgentState>(
      persisted.agentStateCiphertext!,
      key,
      `task-state:${f.task.id}`
    );
    expect(await drainCorrection(f.deps, persisted, key, restarted)).toBe(false);
    expect(
      restarted.messages.filter((m) => m.role === 'user' && m.content.includes('valid copy'))
    ).toHaveLength(1);
    expect(persisted).toMatchObject({
      maxComputeCredits: 5,
      maxSpendUsd: 2,
      modelId: 'selected',
      privacyRoute: 'provider_zdr'
    });
  });
  it('leaves in-memory state untouched when atomic consumption loses its lease', async () => {
    const f = await fixture();
    const before = structuredClone(f.state);
    await database.query(
      "UPDATE tasks SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [f.task.id]
    );
    await expect(drainCorrection(f.deps, f.task, key, f.state)).rejects.toMatchObject({
      code: 'approval_correction_conflict'
    });
    expect(f.state).toEqual(before);
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toMatchObject({
      approvalId: f.approvalId
    });
  });
  it('does not silently continue after a correction read failure', async () => {
    const f = await fixture();
    const read = vi
      .spyOn(store, 'getNextQueuedTaskMessage')
      .mockRejectedValueOnce(new Error('fixture unavailable queue'));
    await expect(drainCorrection(f.deps, f.task, key, f.state)).rejects.toThrow(
      'fixture unavailable queue'
    );
    read.mockRestore();
  });
  it('applies denial before parking the separate unanswered question, retaining both durably', async () => {
    const f = await fixture(true);
    const parked = await resumeParkedTurn(
      f.deps,
      f.task,
      key,
      f.state,
      { model: {} as ModelRelease, catalog: [], webPlan: {} as WebToolPlan },
      async () => false
    );
    expect(parked).toBe(true);
    expect(f.state.question?.question).toBe('Which folder?');
    expect(f.state.messages.at(-1)?.content).toContain('valid copy');
    const saved = (await store.getTask(f.task.userId, f.task.id))!;
    expect(saved.status).toBe('awaiting_user');
    expect(
      decryptJson<AgentState>(saved.agentStateCiphertext!, key, `task-state:${f.task.id}`)
    ).toEqual(f.state);
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
  });
});

describe('question answer after a denial correction', () => {
  it('keeps the unanswered question on rollback, then resumes once with both owner messages and existing settings', async () => {
    const f = await fixture(true),
      answerId = randomUUID();
    await store.enqueueTaskMessage({
      id: answerId,
      taskId: f.task.id,
      userId: f.task.userId,
      modelId: f.task.modelId,
      reasoningEffort: 'low',
      privacyRoute: f.task.privacyRoute,
      maxComputeCredits: 2,
      maxSpendUsd: 1,
      resourceClass: 'task_compute',
      reservationKey: answerId,
      promptCiphertext: encryptJson(
        { prompt: 'Use the output folder.' },
        key,
        `task-message:${f.task.id}`
      ),
      queuedEventCiphertext: encryptJson(
        { markdown: 'Use the output folder.' },
        key,
        `task-event:${f.task.id}`
      )
    });
    await database.query(
      `CREATE FUNCTION refuse_answer_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM task_message_queue WHERE task_id=NEW.id AND approval_id IS NULL AND status='promoted') THEN RAISE EXCEPTION 'fixture answer state failure'; END IF; RETURN NEW; END $$`
    );
    await database.query(
      `CREATE TRIGGER refuse_answer_state BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_answer_state()`
    );
    const run = { model: {} as ModelRelease, catalog: [], webPlan: {} as WebToolPlan };
    try {
      await expect(
        resumeParkedTurn(f.deps, f.task, key, f.state, run, async () => false)
      ).rejects.toThrow('fixture answer state failure');
      const failed = (await store.getTask(f.task.userId, f.task.id))!;
      const saved = decryptJson<AgentState>(
        failed.agentStateCiphertext!,
        key,
        `task-state:${f.task.id}`
      );
      expect(saved.question?.question).toBe('Which folder?');
      expect(saved.messages.filter((m) => m.content.includes('valid copy'))).toHaveLength(1);
      expect(saved.messages.some((m) => m.content.includes('output folder'))).toBe(false);
      expect((await store.getNextQueuedTaskMessage(f.task.id))?.id).toBe(answerId);
      expect(f.state).toEqual(saved);
    } finally {
      await database.query('DROP TRIGGER refuse_answer_state ON tasks');
      await database.query('DROP FUNCTION refuse_answer_state()');
    }
    const current = (await store.getTask(f.task.userId, f.task.id))!;
    const restarted = decryptJson<AgentState>(
      current.agentStateCiphertext!,
      key,
      `task-state:${f.task.id}`
    );
    expect(await resumeParkedTurn(f.deps, current, key, restarted, run, async () => false)).toBe(
      false
    );
    expect(restarted.question).toBeUndefined();
    expect(restarted.messages.filter((m) => m.content.includes('valid copy'))).toHaveLength(1);
    expect(restarted.messages.filter((m) => m.content.includes('output folder'))).toHaveLength(1);
    const final = (await store.getTask(f.task.userId, f.task.id))!;
    expect(decryptJson(final.agentStateCiphertext!, key, `task-state:${f.task.id}`)).toEqual(
      restarted
    );
    expect(final).toMatchObject({
      maxComputeCredits: 7,
      maxSpendUsd: 3,
      reasoningEffort: 'low',
      modelId: 'selected',
      privacyRoute: 'provider_zdr'
    });
    expect(f.checkpoint).not.toHaveBeenCalled();
  });
});
