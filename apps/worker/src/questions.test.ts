import { closeTurnAtCeiling, type TurnCloseContext } from './turn/close.js';
import type { HandoffDeps } from './handoff.js';
import { resumeParkedTurn, type TurnResumeDeps } from './turn/resume.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@athanor/data';
import { decryptJson, encryptJson } from '@athanor/core';
import type { AgentState } from './agent-state.js';
import { askUser, waitForQuestion, parkBrowserHandoff } from './questions.js';
import { drainCorrection } from './turn-control.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database),
  key = Buffer.alloc(32, 38);
beforeAll(async () => migrateDatabase(database));
afterAll(async () => database.close());
async function fixture() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspace = await store.createWorkspace({
    userId: user.id,
    name: 'Study',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: 'fixture'
  });
  const sealed = encryptJson({}, key, 'fixture');
  const task = await store.createTask({
    userId: user.id,
    workspaceId: workspace.id,
    modelId: 'model',
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
  const state: AgentState = {
    messages: [{ role: 'user', content: 'Analyze the samples.' }],
    step: 1,
    credits: 0.2,
    turnToolResults: { read: { name: 'file_read', success: true } }
  };
  const deps = { store, config: { WORKER_ID: 'worker' } };
  const ask = (continueWith?: string) =>
    askUser(deps, task, key, state, {
      id: 'ask-1',
      name: 'ask',
      arguments: {
        question: 'Which sample is the control?',
        why: 'The comparison needs the control label.',
        options: ['Sample A', 'Sample B'],
        ...(continueWith ? { continueWith } : {})
      }
    });
  const queue = async (prompt: string, questionId?: string, interrupt = true) => {
    const id = randomUUID();
    await store.enqueueTaskMessage({
      id,
      taskId: task.id,
      userId: user.id,
      modelId: 'model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 0,
      maxSpendUsd: null,
      resourceClass: 'light',
      reservationKey: id,
      interrupt,
      ...(questionId ? { questionId } : {}),
      promptCiphertext: encryptJson(
        { prompt, ...(questionId ? { questionId } : {}) },
        key,
        `task-message:${task.id}`
      ),
      queuedEventCiphertext: encryptJson(
        { markdown: prompt, questionId },
        key,
        `task-event:${task.id}`
      )
    });
    return id;
  };
  return { task, state, deps, ask, queue };
}

describe('durable questions during independent work', () => {
  it('publishes an answerable question and checkpoint atomically without releasing the working lease', async () => {
    const f = await fixture();
    expect(await f.ask('Check read quality in both samples.')).toBe(false);
    const saved = (await store.getTask(f.task.userId, f.task.id))!;
    expect(saved.status).toBe('running');
    expect(saved.leaseOwner).toBe('worker');
    expect(saved.hasOpenQuestion).toBe(true);
    expect(decryptJson(saved.agentStateCiphertext!, key)).toEqual(f.state);
    const events = await store.listTaskEvents(f.task.id, 0, { kind: 'question_asked', limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(f.state.question!.id);
    expect(await f.ask('Something else')).toBe(false);
    expect(
      await store.listTaskEvents(f.task.id, 0, { kind: 'question_asked', limit: 10 })
    ).toHaveLength(1);
  });
  it('takes the exact answer once, retains the allowance and survives reopening the saved trajectory', async () => {
    const f = await fixture();
    await f.ask('Check read quality.');
    await f.queue('Sample B', f.state.question!.id);
    expect(await drainCorrection(f.deps, f.task, key, f.state)).toBe(true);
    expect(f.state.question).toBeUndefined();
    expect(f.state.messages.at(-1)).toMatchObject({ role: 'user', content: 'Sample B' });
    const saved = (await store.getTask(f.task.userId, f.task.id))!;
    expect(saved.maxComputeCredits).toBe(5);
    expect(saved.maxSpendUsd).toBe(2);
    expect(saved.hasOpenQuestion).toBe(false);
    const restarted = decryptJson<AgentState>(saved.agentStateCiphertext!, key);
    expect(restarted.question).toBeUndefined();
    expect(await drainCorrection(f.deps, saved, key, restarted)).toBe(false);
  });
  it('keeps an unanswered question through unrelated corrections and rejects a stale wait ID', async () => {
    const f = await fixture();
    await f.ask('Check read quality.');
    const id = f.state.question!.id;
    await f.queue('Also report the read lengths.');
    await drainCorrection(f.deps, f.task, key, f.state);
    expect(f.state.question!.id).toBe(id);
    expect(
      await askUser(f.deps, f.task, key, f.state, {
        id: 'wait',
        name: 'ask',
        arguments: { waitFor: randomUUID() }
      })
    ).toBe(false);
    expect((await store.getTask(f.task.userId, f.task.id))!.status).toBe('running');
  });
  it('parks when independent work is exhausted without claiming completion', async () => {
    const f = await fixture();
    await f.ask('Check read quality.');
    expect(
      await waitForQuestion(f.deps, f.task, key, f.state, {
        id: 'finish',
        name: 'finish',
        arguments: {}
      })
    ).toBe(true);
    const saved = (await store.getTask(f.task.userId, f.task.id))!;
    expect(saved.status).toBe('awaiting_user');
    expect(saved.leaseOwner).toBeNull();
    expect(decryptJson<AgentState>(saved.agentStateCiphertext!, key).question?.waiting).toBe(true);
    expect(await store.listTaskEvents(f.task.id, 0, { kind: 'completed', limit: 10 })).toEqual([]);
  });
  it('does not lose an answer queued just before the worker parks', async () => {
    const f = await fixture();
    await f.ask('Check read quality.');
    await f.queue('Sample A', f.state.question!.id);
    await waitForQuestion(f.deps, f.task, key, f.state, { id: 'wait', name: 'ask', arguments: {} });
    const saved = (await store.getTask(f.task.userId, f.task.id))!;
    expect(saved.status).toBe('queued');
    expect(saved.leaseOwner).toBeNull();
    expect(await store.getNextQueuedTaskMessage(f.task.id)).not.toBeNull();
  });
  it('preserves a direction when a challenge arrives and serves that challenge after the answer', async () => {
    const f = await fixture();
    await f.ask('Read the public quality guide.');
    const original = f.state.question!.id;
    f.state.browserHandoff = {
      vendor: 'site',
      url: 'https://fixture.test/challenge',
      reason: 'Human check',
      tabId: 'tab-owned'
    };
    expect(await parkBrowserHandoff(f.deps, f.task, key, f.state)).toBe(true);
    expect(f.state.question!.id).toBe(original);
    expect(f.state.browserHandoff?.tabId).toBe('tab-owned');
    await f.queue('Sample B', original);
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
      [f.task.id]
    );
    await drainCorrection(f.deps, f.task, key, f.state);
    expect(await parkBrowserHandoff(f.deps, f.task, key, f.state)).toBe(true);
    expect(f.state.browserHandoff).toBeUndefined();
    expect(f.state.question?.handoff).toMatchObject({ kind: 'challenge', tabId: 'tab-owned' });
    const events = await store.listTaskEvents(f.task.id, 0, { kind: 'question_asked', limit: 10 });
    expect(events).toHaveLength(2);
  });

  it('keeps an unanswered dependency at the step ceiling without a closing model call', async () => {
    const f = await fixture();
    await f.ask('Review independent metadata.');
    await closeTurnAtCeiling(f.deps as HandoffDeps, f.task, key, f.state, {} as TurnCloseContext, {
      reason: 'steps',
      code: 'step_limit_reached',
      spent: 'used its steps'
    });
    expect((await store.getTask(f.task.userId, f.task.id))!.status).toBe('awaiting_user');
    expect(f.state.question?.waiting).toBe(true);
  });

  it('does not treat an older ordinary follow-up as the answer when a question is re-leased', async () => {
    const f = await fixture();
    await f.queue('After the analysis, make a plot.', undefined, false);
    await f.ask('Check quality.');
    await waitForQuestion(f.deps, f.task, key, f.state, { id: 'wait', name: 'ask', arguments: {} });
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
      [f.task.id]
    );
    const run = {} as Parameters<typeof resumeParkedTurn>[4];
    expect(
      await resumeParkedTurn(f.deps as TurnResumeDeps, f.task, key, f.state, run, async () => false)
    ).toBe(true);
    expect(f.state.question?.question).toBe('Which sample is the control?');
    expect(await store.getNextQueuedTaskMessage(f.task.id)).not.toBeNull();
  });

  it('refuses stale workers and rolls back the state if publishing its event fails', async () => {
    const f = await fixture();
    await database.query("UPDATE tasks SET status='paused' WHERE id=$1", [f.task.id]);
    await expect(f.ask('Check quality.')).rejects.toMatchObject({ code: 'task_lease_lost' });
    expect(await store.listTaskEvents(f.task.id, 0, { kind: 'question_asked', limit: 10 })).toEqual(
      []
    );
    await database.query("UPDATE tasks SET status='running' WHERE id=$1", [f.task.id]);
    const checkpoint = encryptJson({ marker: 'must roll back' }, key, `task-state:${f.task.id}`);
    const duplicate = await store.appendTaskEvent({
      taskId: f.task.id,
      kind: 'status',
      summary: 'Existing event'
    });
    await expect(
      store.saveTaskQuestion({
        taskId: f.task.id,
        workerId: 'worker',
        agentStateCiphertext: checkpoint,
        actualComputeCredits: 1,
        park: true,
        event: { id: duplicate.id, payloadCiphertext: checkpoint }
      })
    ).rejects.toThrow();
    expect((await store.getTask(f.task.userId, f.task.id))!.agentStateCiphertext).toBeNull();
    expect((await store.getTask(f.task.userId, f.task.id))!.status).toBe('running');
  });
});
