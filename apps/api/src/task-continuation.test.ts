import Fastify from 'fastify';
import { registerQuestionRoutes } from './routes/questions.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { decryptJson, encryptJson, wrapDataKey } from '@garden/core';
import type { TaskRecord } from '@garden/data';
import type { RouteContext } from './http/server-context.js';
import {
  continueTaskOperation,
  taskContinuationSnapshot,
  type TaskContinuationSnapshot
} from './task-continuation.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const key = Buffer.alloc(32, 7),
  masterKey = Buffer.alloc(32, 9);
const sealed = encryptJson({ prompt: 'Start' }, key, 'test');
beforeAll(async () => migrateDatabase(database));
afterAll(async () => database.close());
const fixture = async (status = 'running') => {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspaceId = randomUUID();
  const workspace = await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Work',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: wrapDataKey(key, masterKey, workspaceId)
  });
  await store.updateWorkspaceStatus(workspace.id, 'running');
  const task = await store.createTask({
    userId: user.id,
    workspaceId,
    modelId: 'model',
    reasoningEffort: 'high',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 4,
    maxSpendUsd: 8,
    titleCiphertext: sealed,
    promptCiphertext: sealed,
    nameIndex: { nameTokens: '', openingTokens: '' }
  });
  await database.query(
    'UPDATE tasks SET status=$2,agent_state_ciphertext=$3::jsonb,actual_compute_credits=0.7 WHERE id=$1',
    [
      task.id,
      status,
      JSON.stringify(
        encryptJson(
          { messages: [{ role: 'user', content: 'Start' }], step: 2, turn: 1, credits: 0.7 },
          key,
          `task-state:${task.id}`
        )
      )
    ]
  );
  const current = (await store.getTask(user.id, task.id))!;
  const model = {
    id: 'model',
    displayName: 'Model',
    usageClass: 'medium',
    availability: 'available',
    privacyRoute: 'provider_zdr',
    reasoning: { supportedEfforts: ['high'], mandatory: false }
  };
  const resolveSpendCeiling = vi.fn(async () => 2);
  const context = {
    store,
    database,
    masterKey,
    runner: {
      request: vi.fn(
        async (input: { workspaceId: string; body?: BodyInit; role: string; scopes: string[] }) => {
          expect(input.role).toBe('control');
          expect(input.scopes).toEqual(['workspace.manage']);
          if (typeof input.body !== 'string') throw Error('Expected preparation request JSON');
          const body = JSON.parse(input.body) as { taskId: string; workspaceId: string };
          return {
            status: 'ready',
            sourceWorkspaceId: input.workspaceId,
            workspaceId: body.workspaceId,
            taskId: body.taskId,
            bytes: 0
          };
        }
      )
    },
    config: { TASK_MAX_STEPS: 20 },
    modelsForUser: async () => [model],
    privateTaskResponse: async (value: TaskRecord) => value,
    resolveSpendCeiling,
    assertSpendCeilingAllowed: vi.fn(async () => undefined),
    computeAllowanceFor: () => 50
  } as unknown as RouteContext;
  const retained = { expected: taskContinuationSnapshot(current), messageId: randomUUID() };
  const send = (body: unknown = { prompt: 'Check the result' }) =>
    continueTaskOperation(context, user, task.id, body, { retainBudget: retained });
  return { task: current, user, context, retained, send, resolveSpendCeiling };
};

describe('attachment delivery in owner messages', () => {
  it('keeps queued attachment references sealed beside the exact typed text', async () => {
    const f = await fixture();
    const input = { prompt: 'Read the attached note.', attachments: ['workspace/note.txt'] };
    await continueTaskOperation(f.context, f.user, f.task.id, input);
    const queued = await store.getNextQueuedTaskMessage(f.task.id);
    expect(queued).not.toBeNull();
    expect(decryptJson(queued!.promptCiphertext, key, `task-message:${f.task.id}`)).toEqual(input);
    const events = await store.listTaskEvents(f.task.id, 0, { kind: 'queued_message', limit: 1 });
    expect(events).toHaveLength(1);
    expect(
      decryptJson(events[0]!.payloadCiphertext!, key, `task-event:${f.task.id}`)
    ).toMatchObject({
      markdown: input.prompt,
      attachments: input.attachments
    });
  });

  it('puts completed-task follow-up attachments in model context and preserves the transcript', async () => {
    const f = await fixture('completed');
    const input = { prompt: 'Read this note.', attachments: ['workspace/follow-up.txt'] };
    await continueTaskOperation(f.context, f.user, f.task.id, input);
    const current = (await store.getTask(f.user.id, f.task.id))!;
    const state = decryptJson<{ messages: Array<{ content: string }> }>(
      current.agentStateCiphertext!,
      key,
      `task-state:${f.task.id}`
    );
    expect(state.messages.length).toBeGreaterThan(0);
    expect(state.messages.at(-1)!.content).toContain(input.attachments[0]);
    const events = await store.listTaskEvents(f.task.id, 0, { kind: 'user_message', limit: 1 });
    expect(events).toHaveLength(1);
    expect(
      decryptJson(events[0]!.payloadCiphertext!, key, `task-event:${f.task.id}`)
    ).toMatchObject({
      markdown: input.prompt,
      attachments: input.attachments
    });
  });
});

describe('confirmed continuation within existing task authority', () => {
  it('queues and promotes real work without raising either allowance or changing the selected route', async () => {
    const f = await fixture();
    await f.send();
    const queued = await store.getNextQueuedTaskMessage(f.task.id);
    expect(queued).toMatchObject({
      id: f.retained.messageId,
      maxComputeCredits: 0,
      maxSpendUsd: null,
      modelId: f.task.modelId,
      reasoningEffort: 'high',
      privacyRoute: f.task.privacyRoute,
      interrupt: false
    });
    const queueEvents = await store.listTaskEvents(f.task.id, 0, {
      kind: 'queued_message',
      limit: 1
    });
    expect(queueEvents).toHaveLength(1);
    expect(
      decryptJson(queueEvents[0]!.payloadCiphertext!, key, `task-event:${f.task.id}`)
    ).toMatchObject({
      markdown: 'Check the result',
      messageId: queued!.id
    });
    expect(f.resolveSpendCeiling).not.toHaveBeenCalled();
    await database.query("UPDATE tasks SET lease_owner='worker' WHERE id=$1", [f.task.id]);
    const promoted = await store.promoteQueuedTaskMessage({
      taskId: f.task.id,
      messageId: queued!.id,
      workerId: 'worker',
      modelId: queued!.modelId,
      privacyRoute: queued!.privacyRoute,
      additionalComputeCredits: queued!.maxComputeCredits,
      additionalSpendUsd: queued!.maxSpendUsd,
      agentStateCiphertext: f.task.agentStateCiphertext!,
      userMessageCiphertext: sealed,
      statusEventCiphertext: sealed
    });
    expect(promoted).toMatchObject({
      maxComputeCredits: 4,
      maxSpendUsd: 8,
      reasoningEffort: 'high'
    });
    expect(
      (
        await database.query('SELECT credits FROM usage_entries WHERE idempotency_key=$1', [
          queued!.reservationKey
        ])
      ).rows
    ).toEqual([{ credits: 0 }]);
  });
  it('resumes a completed checkpoint with carried credits and one stable message identity', async () => {
    const f = await fixture('completed');
    await f.send();
    const resumed = (await store.getTask(f.user.id, f.task.id))!;
    expect(resumed).toMatchObject({
      status: 'queued',
      maxComputeCredits: 4,
      maxSpendUsd: 8,
      modelId: 'model',
      reasoningEffort: 'high',
      privacyRoute: 'provider_zdr'
    });
    const state = decryptJson<{ credits: number; messages: unknown[]; turn: number }>(
      resumed.agentStateCiphertext!,
      key
    );
    expect(state.credits).toBe(0.7);
    expect(state.turn).toBe(2);
    expect(state.messages.at(-1)).toEqual({ role: 'user', content: 'Check the result' });
    await expect(f.send()).resolves.toMatchObject({ id: f.task.id });
    expect(
      (await database.query('SELECT id FROM task_events WHERE task_id=$1', [f.task.id])).rows
    ).toEqual([{ id: f.retained.messageId }]);
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
  });
  it('leaves a real pending approval parked while accepting the proposed message', async () => {
    const f = await fixture('awaiting_user');
    const approvalId = await store.createApproval({
      userId: f.user.id,
      taskId: f.task.id,
      action: 'connector_action',
      sideEffect: 'external_consequential',
      previewCiphertext: sealed,
      previewHash: 'test-hash',
      expiresAt: new Date(Date.now() + 60_000)
    });
    await f.send();
    expect(await store.getApproval(approvalId)).toMatchObject({ status: 'pending' });
    expect(await store.getTask(f.user.id, f.task.id)).toMatchObject({
      status: 'awaiting_user',
      queuedMessageCount: 1
    });
    const question = await fixture('awaiting_user');
    await question.send();
    expect(await store.getTask(question.user.id, question.task.id)).toMatchObject({
      status: 'queued',
      queuedMessageCount: 1
    });
  });
  it('refuses stale authority, setting overrides, other owners, and exhausted spend before writing work', async () => {
    const f = await fixture();
    const expected = f.retained.expected;
    const changes: Array<Partial<TaskContinuationSnapshot>> = [
      { id: randomUUID() },
      { userId: randomUUID() },
      { workspaceId: randomUUID() },
      { modelId: 'other' },
      { privacyRoute: 'external' },
      { reasoningEffort: 'low' },
      { securityMode: 'autonomous' },
      { maxComputeCredits: 5 },
      { maxSpendUsd: 9 }
    ];
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      f.retained.expected = { ...expected, ...change };
      await expect(f.send()).rejects.toMatchObject({ code: 'task_proposal_changed' });
    }
    f.retained.expected = expected;
    for (const extra of [
      { maxSpendUsd: 100 },
      { maxComputeCredits: 100 },
      { interrupt: true },
      { modelId: 'other' }
    ])
      await expect(f.send({ prompt: 'Check', ...extra })).rejects.toThrow();
    await expect(
      continueTaskOperation(
        f.context,
        { ...f.user, id: randomUUID() },
        f.task.id,
        { prompt: 'Check' },
        { retainBudget: f.retained }
      )
    ).rejects.toMatchObject({ code: 'task_not_found' });
    await database.query('UPDATE tasks SET max_spend_usd=0.05 WHERE id=$1', [f.task.id]);
    f.retained.expected = taskContinuationSnapshot((await store.getTask(f.user.id, f.task.id))!);
    await store.recordUsage({
      userId: f.user.id,
      taskId: f.task.id,
      workspaceId: f.task.workspaceId,
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 1,
      unit: 'tokens',
      credits: 0.1,
      costUsd: 0.1,
      state: 'settled',
      idempotencyKey: randomUUID()
    });
    await expect(f.send()).rejects.toThrow();
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
    expect(
      (await database.query('SELECT id FROM task_events WHERE task_id=$1', [f.task.id])).rows
    ).toEqual([]);
  });
  it('rolls back with its confirmation transaction and accepts concurrent replay only once', async () => {
    const f = await fixture('completed');
    await expect(
      database.transaction(async () => {
        await f.send();
        throw new Error('confirmation failed');
      })
    ).rejects.toThrow('confirmation failed');
    expect(await store.getTask(f.user.id, f.task.id)).toMatchObject({ status: 'completed' });
    expect(
      (await database.query('SELECT id FROM task_events WHERE task_id=$1', [f.task.id])).rows
    ).toEqual([]);
    await Promise.all([f.send(), f.send()]);
    expect(
      (await database.query('SELECT id FROM task_events WHERE task_id=$1', [f.task.id])).rows
    ).toEqual([{ id: f.retained.messageId }]);
    expect(
      (
        await database.query('SELECT id FROM usage_entries WHERE idempotency_key=$1', [
          `task:${f.task.id}:message:${f.retained.messageId}:reservation`
        ])
      ).rows
    ).toHaveLength(1);
    await expect(f.send({ prompt: 'Different work' })).rejects.toMatchObject({
      code: 'task_message_identity_conflict'
    });
  });
  it('keeps ordinary typed follow-up allocation behavior on the same operation', async () => {
    const f = await fixture();
    await continueTaskOperation(f.context, f.user, f.task.id, {
      prompt: 'A new turn',
      maxComputeCredits: 2,
      maxSpendUsd: 2
    });
    expect((await store.getTask(f.user.id, f.task.id))?.workspaceId).not.toBe(f.task.workspaceId);
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toMatchObject({
      maxComputeCredits: 50,
      maxSpendUsd: 2
    });
    expect(f.resolveSpendCeiling).toHaveBeenCalledExactlyOnceWith(f.user.id, 2);
  });
});

describe('durable question replies', () => {
  it('keeps a blocked or disconnected handoff pending, then accepts an acknowledged completion', async () => {
    const f = await fixture('awaiting_user');
    const question = await store.appendTaskEvent({
      taskId: f.task.id,
      kind: 'question_asked',
      summary: 'Complete verification',
      payloadCiphertext: encryptJson(
        { question: 'Complete verification' },
        key,
        `task-event:${f.task.id}`
      )
    });
    await database.query('UPDATE tasks SET agent_state_ciphertext=$2::jsonb WHERE id=$1', [
      f.task.id,
      JSON.stringify(
        encryptJson(
          {
            messages: [],
            question: {
              question: 'Complete verification',
              askedAtStep: 1,
              handoff: { kind: 'challenge', tabId: 'tab-2', url: 'https://fixture.test/challenge' }
            }
          },
          key,
          `task-state:${f.task.id}`
        )
      )
    ]);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ error: { code: 'browser_bot_wall' } })
      .mockRejectedValueOnce(new Error('Connection closed'))
      .mockResolvedValueOnce({ ok: true });
    const app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (r) => {
      r.user = f.user;
    });
    registerQuestionRoutes({
      ...f.context,
      app,
      runner: { request } as unknown as RouteContext['runner']
    });
    try {
      const input = {
        method: 'POST' as const,
        url: `/v1/tasks/${f.task.id}/answer`,
        payload: {
          questionId: question.id,
          prompt: 'I completed verification.',
          tabId: 'tab-reopened'
        }
      };
      const blocked = await app.inject(input);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json<{ message: string }>().message).toContain(
        'still needs human verification'
      );
      expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('awaiting_user');
      expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
      const disconnected = await app.inject(input);
      expect(disconnected.statusCode).toBe(503);
      expect(disconnected.json<{ message: string }>().message).toContain('Reconnect');
      expect((await app.inject(input)).statusCode).toBe(200);
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[0]?.[0]).toMatchObject({
        workspaceId: f.task.workspaceId,
        body: JSON.stringify({
          tabId: 'tab-reopened',
          expectedUrl: 'https://fixture.test/challenge'
        }),
        acceptAnyStatus: true
      });
      expect(f.resolveSpendCeiling).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('binds a reply to the current question across duplicate device requests without adding budget', async () => {
    const f = await fixture('awaiting_user');
    const question = await store.appendTaskEvent({
      taskId: f.task.id,
      kind: 'question_asked',
      summary: 'Choose a direction',
      payloadCiphertext: encryptJson(
        { question: 'Choose a direction' },
        key,
        `task-event:${f.task.id}`
      )
    });
    await database.query('UPDATE tasks SET agent_state_ciphertext=$2::jsonb WHERE id=$1', [
      f.task.id,
      JSON.stringify(
        encryptJson(
          { messages: [], question: { question: 'Choose a direction', askedAtStep: 2 } },
          key,
          `task-state:${f.task.id}`
        )
      )
    ]);
    const app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      request.user = f.user;
    });
    registerQuestionRoutes({ ...f.context, app });
    try {
      const payload = { questionId: question.id, prompt: 'Use the public dataset' };
      const first = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${f.task.id}/answer`,
        payload
      });
      expect(first.statusCode).toBe(200);
      const retry = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${f.task.id}/answer`,
        payload
      });
      expect(retry.statusCode).toBe(200);
      const events = await store.listTaskEvents(f.task.id, 0, {
        kind: 'queued_message',
        limit: 10
      });
      expect(events).toHaveLength(1);
      expect((await store.getNextQueuedTaskMessage(f.task.id))?.maxComputeCredits).toBe(0);
      expect(f.resolveSpendCeiling).not.toHaveBeenCalled();
      const stale = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${f.task.id}/answer`,
        payload: { ...payload, questionId: randomUUID() }
      });
      expect(stale.statusCode).toBe(409);
      const different = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${f.task.id}/answer`,
        payload: { ...payload, prompt: 'Different answer' }
      });
      expect(different.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});

describe('answers during independent work', () => {
  it.each(['running', 'paused', 'awaiting_resource'])(
    'saves one bound answer while %s, ahead of unrelated follow-ups and without new allowance',
    async (status) => {
      const f = await fixture('running');
      const questionId = randomUUID();
      await store.appendTaskEvent({
        id: questionId,
        taskId: f.task.id,
        kind: 'question_asked',
        summary: 'Control sample',
        payloadCiphertext: encryptJson(
          { question: 'Which control?', continueWith: 'Read quality checks.' },
          key,
          `task-event:${f.task.id}`
        )
      });
      await database.query(
        "UPDATE tasks SET lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 minute',agent_state_ciphertext=$2::jsonb,pending_question_id=$3::uuid WHERE id=$1",
        [
          f.task.id,
          JSON.stringify(
            encryptJson(
              {
                messages: [],
                question: {
                  id: questionId,
                  question: 'Which control?',
                  continueWith: 'Read quality checks.',
                  askedAtStep: 2
                }
              },
              key,
              `task-state:${f.task.id}`
            )
          ),
          questionId
        ]
      );
      await continueTaskOperation(f.context, f.user, f.task.id, {
        prompt: 'Afterwards, draw a chart.'
      });
      const app = Fastify();
      app.decorateRequest('user', null);
      app.addHook('onRequest', async (request) => {
        request.user = f.user;
      });
      registerQuestionRoutes({ ...f.context, app });
      try {
        f.context.modelsForUser = async () => {
          throw new Error('Model account unavailable');
        };
        await database.query(
          "UPDATE tasks SET status=$2,lease_owner=CASE WHEN $2='running' THEN lease_owner ELSE NULL END,lease_expires_at=CASE WHEN $2='running' THEN lease_expires_at ELSE NULL END WHERE id=$1",
          [f.task.id, status]
        );

        const request = {
          method: 'POST' as const,
          url: `/v1/tasks/${f.task.id}/answer`,
          payload: { questionId, prompt: 'Sample B' }
        };
        const responses = await Promise.all([app.inject(request), app.inject(request)]);
        expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
        const queued = await store.getNextQueuedTaskMessage(f.task.id, { interruptOnly: true });
        expect(queued?.interrupt).toBe(true);
        expect(queued?.maxComputeCredits).toBe(0);
        expect(queued?.maxSpendUsd).toBeNull();
        expect(decryptJson(queued!.promptCiphertext, key)).toMatchObject({
          prompt: 'Sample B',
          questionId
        });
        const current = (await store.getTask(f.user.id, f.task.id))!;
        expect(current.status).toBe(status);
        expect(current.leaseOwner).toBe(status === 'running' ? 'worker' : null);
        expect(current.hasOpenQuestion).toBe(false);
        expect(current.maxComputeCredits).toBe(4);
        const stale = await app.inject({
          ...request,
          payload: { questionId: randomUUID(), prompt: 'Sample A' }
        });
        expect(stale.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    }
  );
});
