import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@athanor/data';
import { decryptJson, encryptJson, generateDataKey, wrapDataKey } from '@athanor/core';
import type { AgentState } from './agent-state.js';
import type { AgentRunnerClient } from './runner-client.js';
import { reconcileJobWaits } from './job-waits.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const master = Buffer.alloc(32, 5);
beforeAll(() => migrateDatabase(database));
afterAll(() => database.close());

async function fixture() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const key = generateDataKey();
  const workspaceId = randomUUID();
  const workspace = await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Analysis',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: wrapDataKey(key, master, workspaceId)
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId: workspace.id,
    titleCiphertext: encryptJson({ title: 'Analysis' }, key),
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'fixture',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    promptCiphertext: encryptJson({ prompt: 'Analyse the data' }, key)
  });
  await database.query(
    "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
    [task.id]
  );
  const id = randomUUID();
  const state: AgentState = { messages: [], step: 3, credits: 0.01, turn: 1, jobWaitId: id };
  const startedAt = '2026-09-16T12:00:00.000Z';
  const input = {
    id,
    taskId: task.id,
    workerId: 'worker',
    dependenciesCiphertext: encryptJson(
      { turn: 1, jobs: [{ sessionId: 'job-a', startedAt }] },
      key,
      `job-wait:${task.id}`
    ),
    agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
    actualComputeCredits: 0.01,
    eventCiphertext: encryptJson({ jobWait: id }, key, `task-event:${task.id}`)
  };
  expect(await store.parkTaskForJobs(input)).toBe(true);
  let status = 'running';
  let generation = startedAt;
  const call = vi.fn(
    async (_workspace: string, _task: string, _scope: unknown, endpoint: string) => {
      expect(endpoint).toBe(`/v1/workspaces/${workspaceId}/processes`);
      return {
        processes: [{ sessionId: 'job-a', startedAt: generation, status, lifetime: 'job' }]
      };
    }
  );
  const runner = { call } as unknown as AgentRunnerClient;
  return {
    user,
    task,
    key,
    state,
    input,
    runner,
    call,
    setStatus: (next: string) => {
      status = next;
    },
    restart: () => {
      generation = '2026-09-16T13:00:00.000Z';
    }
  };
}

describe('durable job wakeups', () => {
  it.each(['completed', 'failed', 'stopped', 'interrupted', 'timed_out'])(
    'queues one continuation for %s with no command replay',
    async (terminal) => {
      const f = await fixture();
      expect(await reconcileJobWaits(store, f.runner, master, new AbortController().signal)).toBe(
        0
      );
      expect(await store.getTask(f.user.id, f.task.id)).toMatchObject({
        status: 'awaiting_resource',
        leaseOwner: null,
        actualComputeCredits: 0.01
      });
      f.setStatus(terminal);
      await database.query('UPDATE task_job_waits SET checked_at=NULL WHERE task_id=$1', [
        f.task.id
      ]);
      expect(
        await reconcileJobWaits(
          new DataStore(database),
          f.runner,
          master,
          new AbortController().signal
        )
      ).toBe(1);
      expect(await reconcileJobWaits(store, f.runner, master, new AbortController().signal)).toBe(
        0
      );
      const ready = await store.getTask(f.user.id, f.task.id);
      expect(ready).toMatchObject({ status: 'queued', actualComputeCredits: 0.01 });
      const resumed = decryptJson<AgentState>(ready!.agentStateCiphertext!, f.key);
      expect(resumed.jobWaitId).toBeUndefined();
      expect(resumed.messages.at(-1)?.content).toContain(terminal);
      expect(f.call).toHaveBeenCalledTimes(2);
    }
  );

  it('does not restart a task the owner paused or overwrite newer state', async () => {
    const f = await fixture();
    f.setStatus('completed');
    await store.setTaskStatusForUser(f.user.id, f.task.id, 'paused');
    expect(await reconcileJobWaits(store, f.runner, master, new AbortController().signal)).toBe(0);
    expect(f.call).not.toHaveBeenCalled();
    const outcome = encryptJson({ status: 'completed' }, f.key);
    expect(
      await store.wakeTaskFromJobs({
        id: f.input.id,
        taskId: f.task.id,
        expectedState: f.input.agentStateCiphertext,
        agentStateCiphertext: outcome,
        outcomeCiphertext: outcome
      })
    ).toBe(false);
    expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('paused');
  });

  it('reports a different process generation instead of silently following a replacement', async () => {
    const f = await fixture();
    f.restart();
    expect(await reconcileJobWaits(store, f.runner, master, new AbortController().signal)).toBe(1);
    const task = await store.getTask(f.user.id, f.task.id);
    expect(
      decryptJson<AgentState>(task!.agentStateCiphertext!, f.key).messages.at(-1)?.content
    ).toContain('generationChanged');
  });

  it('does not confuse a missing receipt with successful computation', async () => {
    const f = await fixture();
    f.call.mockResolvedValueOnce({ processes: [] });
    expect(await reconcileJobWaits(store, f.runner, master, new AbortController().signal)).toBe(1);
    const task = await store.getTask(f.user.id, f.task.id);
    expect(
      decryptJson<AgentState>(task!.agentStateCiphertext!, f.key).messages.at(-1)?.content
    ).toContain('outcomeUnknown');
  });

  it('continues scanning when another workspace cannot be inspected', async () => {
    const broken = await fixture();
    const healthy = await fixture();
    healthy.setStatus('completed');
    const runner = {
      call: vi.fn(async (workspace: string, ...args: unknown[]) => {
        if (workspace === broken.task.workspaceId) throw new Error('Unavailable workspace');
        return healthy.call(workspace, args[0] as string, args[1], args[2] as string);
      })
    } as unknown as AgentRunnerClient;
    const errors = vi.fn();
    expect(
      await reconcileJobWaits(store, runner, master, new AbortController().signal, errors)
    ).toBe(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect((await store.getTask(broken.user.id, broken.task.id))?.status).toBe('awaiting_resource');
    await store.setTaskStatusForUser(broken.user.id, broken.task.id, 'paused');
  });

  it('settles concurrent recovery attempts atomically', async () => {
    const f = await fixture();
    const outcome = encryptJson({ status: 'completed' }, f.key);
    const wake = {
      id: f.input.id,
      taskId: f.task.id,
      expectedState: f.input.agentStateCiphertext,
      agentStateCiphertext: outcome,
      outcomeCiphertext: outcome
    };
    expect(
      (await Promise.all([store.wakeTaskFromJobs(wake), store.wakeTaskFromJobs(wake)])).filter(
        Boolean
      )
    ).toHaveLength(1);
    expect(
      (await store.listTaskEvents(f.task.id)).filter(
        (event) => event.summary === 'Encrypted job completion'
      )
    ).toHaveLength(1);
  });
});
