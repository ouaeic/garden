import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@athanor/data';
import { decryptJson, encryptJson, generateDataKey, wrapDataKey } from '@athanor/core';
import type { AgentState } from './agent-state.js';
import type { AgentRunnerClient } from './runner-client.js';
import { parkProcessWait, reconcileJobWaits } from './job-waits.js';
import type { TurnDispatchDeps } from './turn/dispatch.js';
import type { ModelToolCall } from '@athanor/model-gateway';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const master = Buffer.alloc(32, 5);
beforeAll(() => migrateDatabase(database));
afterAll(() => database.close());

async function fixture(kind: 'job' | 'computation' = 'job') {
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
  const state: AgentState = {
    messages: [],
    step: 3,
    credits: 0.01,
    turn: 1,
    jobWaitId: id,
    seenCalls: { 'file_read:{}': 'stale', 'memory_recall:{}': 'memory' }
  };
  const startedAt = '2026-09-16T12:00:00.000Z';
  const sessionId = kind === 'computation' ? `kernel-${randomUUID()}` : 'job-a';
  const interpreterCreatedAt = '2026-09-16T11:00:00.000Z';
  const input = {
    id,
    taskId: task.id,
    workerId: 'worker',
    dependenciesCiphertext: encryptJson(
      {
        turn: 1,
        jobs: [
          {
            sessionId,
            startedAt,
            ...(kind === 'computation' ? { kind, cellId: 'cell-1', interpreterCreatedAt } : {})
          }
        ]
      },
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
  let cellId = 'cell-1';
  const snapshot = () => ({
    sessionId,
    workspaceId,
    taskId: task.id,
    createdAt: interpreterCreatedAt,
    state: status === 'running' ? 'busy' : 'idle',
    variables: [{ name: 'private-canary', preview: 'DO NOT ENTER THE SYSTEM WINDOW' }],
    latestCell: { cellId, startedAt: generation, state: status, stdout: 'UNTRUSTED OUTPUT CANARY' }
  });
  const call = vi.fn(
    async (_workspace: string, _task: string, _scope: unknown, endpoint: string) => {
      if (kind === 'computation') {
        expect(_workspace).toBe(workspaceId);
        expect(_task).toBe(task.id);
        expect(_scope).toBe('files.read');
        expect(endpoint).toBe(`/v1/workspaces/${workspaceId}/computation`);
        return { sessions: [snapshot()] };
      }
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
    sessionId,
    snapshot,
    changeCell: () => {
      cellId = 'cell-2';
    },
    setStatus: (next: string) => {
      status = next;
    },
    restart: () => {
      generation = '2026-09-16T13:00:00.000Z';
    }
  };
}

describe('durable job wakeups', () => {
  it.each(['completed', 'failed', 'interrupted'])(
    'waits for a retained cell and wakes once for %s without replay or untrusted content',
    async (terminal) => {
      const f = await fixture('computation');
      expect(await reconcileJobWaits(store, f.runner, master, new AbortController().signal)).toBe(
        0
      );
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
      const task = await store.getTask(f.user.id, f.task.id);
      expect(task?.status).toBe('queued');
      const resumed = decryptJson<AgentState>(task!.agentStateCiphertext!, f.key);
      const message = resumed.messages.at(-1)?.content;
      expect(message).toContain('"kind":"computation"');
      expect(message).toContain('"cellId":"cell-1"');
      expect(message).toContain(terminal);
      expect(message).not.toContain('CANARY');
      expect(message).not.toContain('private-canary');
      expect(resumed.jobWaitId).toBeUndefined();
      expect(resumed.seenCalls).toEqual({ 'memory_recall:{}': 'memory' });
      expect(f.call).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['cell', 'generation', 'missing', 'lost'])(
    'reports %s cell identity or state without waiting for later work',
    async (change) => {
      const f = await fixture('computation');
      if (change === 'cell') f.changeCell();
      if (change === 'generation') f.restart();
      if (change === 'missing') f.call.mockResolvedValueOnce({ sessions: [] });
      if (change === 'lost')
        f.call.mockResolvedValueOnce({ sessions: [{ ...f.snapshot(), state: 'lost' }] });
      expect(await reconcileJobWaits(store, f.runner, master, new AbortController().signal)).toBe(
        1
      );
      const task = await store.getTask(f.user.id, f.task.id);
      const message = decryptJson<AgentState>(task!.agentStateCiphertext!, f.key).messages.at(
        -1
      )?.content;
      expect(message).toContain(change === 'lost' ? 'interrupted' : 'outcomeUnknown');
      if (change === 'cell' || change === 'generation')
        expect(message).toContain('generationChanged');
    }
  );

  it('refuses foreign interpreter metadata and keeps a paused owner task paused', async () => {
    const f = await fixture('computation');
    f.call.mockResolvedValueOnce({ sessions: [{ ...f.snapshot(), taskId: randomUUID() }] });
    const errors = vi.fn();
    expect(
      await reconcileJobWaits(store, f.runner, master, new AbortController().signal, errors)
    ).toBe(0);
    expect(errors).toHaveBeenCalledTimes(1);
    await store.setTaskStatusForUser(f.user.id, f.task.id, 'paused');
    const calls = f.call.mock.calls.length;
    f.setStatus('completed');
    expect(await reconcileJobWaits(store, f.runner, master, new AbortController().signal)).toBe(0);
    expect(f.call.mock.calls.length).toBe(calls);
  });

  it('parks a mixed job and analysis wait with exact cell identity and defers later calls', async () => {
    const f = await fixture('computation');
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [f.task.id]
    );
    const execute = vi.fn(async (_task: unknown, call: ModelToolCall) =>
      call.arguments.action === 'compute'
        ? f.snapshot()
        : {
            sessionId: 'job-other',
            startedAt: '2026-09-16T12:00:00.000Z',
            status: 'running',
            lifetime: 'job'
          }
    );
    const recordToolResult = vi.fn();
    const deps = {
      store,
      config: { WORKER_ID: 'worker' },
      resume: { execute },
      recordToolResult
    } as unknown as TurnDispatchDeps;
    const state: AgentState = { ...f.state, messages: [] };
    const call = {
      id: 'wait-call',
      name: 'process',
      arguments: { action: 'wait', sessionIds: [f.sessionId, 'job-other', f.sessionId] }
    };
    expect(
      await parkProcessWait(
        deps,
        f.task,
        f.key,
        state,
        call,
        [{ id: 'later', name: 'shell', arguments: {} }],
        {} as Parameters<typeof parkProcessWait>[6]
      )
    ).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[1].arguments).toEqual({
      action: 'compute',
      sessionId: f.sessionId,
      options: { action: 'status' }
    });
    const task = await store.getTask(f.user.id, f.task.id);
    expect(task?.status).toBe('awaiting_resource');
    const waits = await store.claimJobWaits();
    const wait = waits.find((row) => row.taskId === f.task.id);
    expect(wait).toBeDefined();
    const dependencies = decryptJson<{ jobs: unknown[] }>(
      wait!.dependenciesCiphertext,
      f.key,
      `job-wait:${f.task.id}`
    );
    expect(dependencies.jobs).toEqual([
      {
        kind: 'computation',
        sessionId: f.sessionId,
        startedAt: f.snapshot().latestCell.startedAt,
        cellId: 'cell-1',
        interpreterCreatedAt: f.snapshot().createdAt
      },
      { sessionId: 'job-other', startedAt: '2026-09-16T12:00:00.000Z' }
    ]);
    expect(JSON.stringify(recordToolResult.mock.calls)).not.toContain('CANARY');
    expect(state.messages).toEqual([
      expect.objectContaining({ role: 'tool', toolCallId: 'later' })
    ]);
    f.setStatus('completed');
    let jobStatus = 'running';
    const mixedCall = vi.fn(
      async (_workspace: string, _task: string, _scope: unknown, endpoint: string) =>
        endpoint.endsWith('/computation')
          ? { sessions: [f.snapshot()] }
          : {
              processes: [
                {
                  sessionId: 'job-other',
                  startedAt: '2026-09-16T12:00:00.000Z',
                  status: jobStatus,
                  lifetime: 'job'
                }
              ]
            }
    );
    const mixedRunner = { call: mixedCall } as unknown as AgentRunnerClient;
    await database.query('UPDATE task_job_waits SET checked_at=NULL WHERE task_id=$1', [f.task.id]);
    expect(await reconcileJobWaits(store, mixedRunner, master, new AbortController().signal)).toBe(
      0
    );
    jobStatus = 'completed';
    await database.query('UPDATE task_job_waits SET checked_at=NULL WHERE task_id=$1', [f.task.id]);
    expect(await reconcileJobWaits(store, mixedRunner, master, new AbortController().signal)).toBe(
      1
    );
    expect(mixedCall).toHaveBeenCalledTimes(4);
    expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('queued');
  });

  it.each(['empty', 'completed'])('does not park an %s analysis session', async (state) => {
    const f = await fixture('computation');
    f.setStatus('completed');
    const snapshot = f.snapshot();
    const { latestCell: _cell, ...empty } = snapshot;
    const park = vi.fn();
    const recordToolResult = vi.fn();
    const deps = {
      store: { parkTaskForJobs: park },
      resume: { execute: vi.fn(async () => (state === 'empty' ? empty : snapshot)) },
      recordToolResult
    } as unknown as TurnDispatchDeps;
    const run = parkProcessWait(
      deps,
      f.task,
      f.key,
      f.state,
      {
        id: 'wait',
        name: 'process',
        arguments: { action: 'wait', sessionId: f.sessionId }
      },
      [],
      {} as Parameters<typeof parkProcessWait>[6]
    );
    if (state === 'empty') await expect(run).rejects.toThrow('no cell to wait for');
    else {
      expect(await run).toBe(false);
      expect(recordToolResult).toHaveBeenCalledWith(
        f.task,
        f.key,
        f.state,
        expect.anything(),
        expect.objectContaining({ waiting: false }),
        undefined,
        undefined
      );
    }
    expect(park).not.toHaveBeenCalled();
    await store.setTaskStatusForUser(f.user.id, f.task.id, 'paused');
  });
  it('yields a held lease without losing state, money or the owner stop', async () => {
    const f = await fixture();
    await database.query(
      "UPDATE tasks SET status='running',attempt=3,lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [f.task.id]
    );
    const saved = encryptJson(
      { ...f.state, step: 75, selfContinuations: 2 },
      f.key,
      `task-state:${f.task.id}`
    );
    const input = {
      taskId: f.task.id,
      workerId: 'worker',
      agentStateCiphertext: saved,
      actualComputeCredits: 0.2
    };
    expect(await store.yieldTaskLease(input)).toBe(true);
    const task = await store.getTask(f.user.id, f.task.id);
    expect(task).toMatchObject({
      status: 'queued',
      leaseOwner: null,
      attempt: 0,
      maxComputeCredits: 1,
      actualComputeCredits: 0.2
    });
    expect(task!.agentStateCiphertext).toEqual(saved);
    expect(await store.yieldTaskLease(input)).toBe(false);
    await store.setTaskStatusForUser(f.user.id, f.task.id, 'paused');
    expect(await store.yieldTaskLease(input)).toBe(false);
    expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('paused');
  });

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
      expect(resumed.seenCalls).toEqual({ 'memory_recall:{}': 'memory' });
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
