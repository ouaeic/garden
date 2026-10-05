import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AGREED_DEAL_MARKER, type TaskDeal } from '@garden/contracts';
import { decryptJson, encryptJson, wrapDataKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase, type TaskRecord } from '@garden/data';
import { registerTaskRoutes } from './routes/tasks.js';
import { createQuestionDefaultSweep } from './maintenance/question-defaults.js';
import type { RouteContext } from './http/server-context.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const key = Buffer.alloc(32, 7),
  masterKey = Buffer.alloc(32, 9);
beforeAll(async () => migrateDatabase(database));
afterAll(async () => database.close());

const deal: TaskDeal = {
  summary: 'Ready the tax return and apply to roles in Berlin.',
  goals: [
    {
      title: '2025 tax return',
      outcome: 'A return ready to file.',
      doneWhen: 'It passes validation.',
      capUsd: 8
    },
    {
      title: 'Bioinformatics roles in Berlin',
      outcome: 'Tailored applications.',
      doneWhen: 'Each matches the brief.',
      rhythm: 'Mondays and Thursdays',
      capUsd: 12
    }
  ],
  questions: [
    { question: 'Claim the home office?', options: ['2 days a week', 'No'] },
    { question: 'Lowest salary?', options: ['€75k', '€85k'] }
  ],
  actAsYou: false
};

const fixture = async () => {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspaceId = randomUUID();
  await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Work',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: wrapDataKey(key, masterKey, workspaceId)
  });
  await store.updateWorkspaceStatus(workspaceId, 'running');
  const task = await store.createTask({
    userId: user.id,
    workspaceId,
    modelId: 'model',
    reasoningEffort: 'high',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 4,
    maxSpendUsd: 30,
    securityMode: 'balanced',
    titleCiphertext: encryptJson({ title: 'Lisbon' }, key, `task-title:${workspaceId}`),
    promptCiphertext: encryptJson(
      { prompt: 'Do my taxes and apply to jobs' },
      key,
      `task-prompt:${workspaceId}`
    ),
    nameIndex: { nameTokens: '', openingTokens: '' }
  });
  const questionId = randomUUID();
  await store.appendTaskEvent({
    id: questionId,
    taskId: task.id,
    kind: 'question_asked',
    summary: deal.summary,
    payloadCiphertext: encryptJson(
      {
        __gardenEventVersion: 1,
        summary: deal.summary,
        payload: { question: deal.summary, questionId, deal }
      },
      key,
      `task-event:${task.id}`
    )
  } as Parameters<typeof store.appendTaskEvent>[0]);
  await database.query('UPDATE tasks SET status=$2,agent_state_ciphertext=$3::jsonb WHERE id=$1', [
    task.id,
    'awaiting_user',
    JSON.stringify(
      encryptJson(
        {
          messages: [{ role: 'user', content: 'Do my taxes and apply to jobs' }],
          step: 1,
          turn: 0,
          credits: 0.2,
          question: { id: questionId, question: deal.summary, askedAtStep: 1, deal: true }
        },
        key,
        `task-state:${task.id}`
      )
    )
  ]);
  const model = {
    id: 'model',
    displayName: 'Model',
    usageClass: 'medium',
    availability: 'available',
    privacyRoute: 'provider_zdr',
    reasoning: { supportedEfforts: ['high'], mandatory: false }
  };
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = user;
  });
  const context = {
    app,
    store,
    database,
    masterKey,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    config: { TASK_MAX_STEPS: 20 },
    runner: { request: vi.fn() },
    modelsForUser: async () => [model],
    privateTaskResponse: async (value: TaskRecord) => value,
    privateTaskPlanResponse: async () => null,
    nameIndexFor: () => ({ nameTokens: '', openingTokens: '' }),
    openPrompt: (record: TaskRecord) =>
      decryptJson<{ prompt: string }>(record.promptCiphertext, key).prompt,
    resolveSpendCeiling: async (_user: string, cap?: number) => cap ?? 5,
    assertSpendCeilingAllowed: vi.fn(async () => undefined),
    computeAllowanceFor: () => 50,
    pickModelUnderPriceCeiling: async () => ({ model, message: null }),
    idempotent: (
      _request: unknown,
      _reply: unknown,
      _user: unknown,
      work: () => Promise<unknown>
    ) => work()
  } as unknown as RouteContext;
  registerTaskRoutes(context);
  return { app, user, task, questionId, context };
};

describe('planting a deal', () => {
  it('lends the keys, caps each goal, starts the second goal and answers the first', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'POST',
      url: `/v1/tasks/${f.task.id}/deal`,
      payload: {
        questionId: f.questionId,
        answers: ['2 days a week', ''],
        goals: [0, 1],
        actAsYou: true,
        capsUsd: [6, 10]
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    const { taskIds } = response.json<{ taskIds: string[] }>();
    expect(taskIds).toHaveLength(2);
    expect(taskIds[0]).toBe(f.task.id);

    const planted = (await store.getTask(f.user.id, f.task.id))!;
    expect(planted.securityMode).toBe('autonomous');
    expect(planted.maxSpendUsd).toBe(6);
    const answer = await store.getNextQueuedTaskMessage(f.task.id);
    const words = decryptJson<{ prompt: string }>(answer!.promptCiphertext, key).prompt;
    expect(words.startsWith(AGREED_DEAL_MARKER)).toBe(true);
    expect(words).toContain('Done when: It passes validation.');
    expect(words).toContain('Claim the home office? 2 days a week');
    expect(words).toContain('Lowest salary? No answer: take the safe choice.');
    expect(words).toContain('not yours to do: Bioinformatics roles in Berlin');

    const sibling = (await store.getTask(f.user.id, taskIds[1]!))!;
    expect(sibling.securityMode).toBe('autonomous');
    expect(sibling.maxSpendUsd).toBe(10);
    const prompt = decryptJson<{ prompt: string }>(sibling.promptCiphertext, key).prompt;
    expect(prompt.startsWith(AGREED_DEAL_MARKER)).toBe(true);
    expect(prompt).toContain('Rhythm: Mondays and Thursdays');
    expect(prompt).toContain('Do my taxes and apply to jobs');
  });

  it('refuses a deal that is no longer waiting, and a goal it never proposed', async () => {
    const f = await fixture();
    const unknownGoal = await f.app.inject({
      method: 'POST',
      url: `/v1/tasks/${f.task.id}/deal`,
      payload: { questionId: f.questionId, answers: [], goals: [3], actAsYou: false, capsUsd: [1] }
    });
    expect(unknownGoal.statusCode, unknownGoal.body).toBe(400);
    const stale = await f.app.inject({
      method: 'POST',
      url: `/v1/tasks/${f.task.id}/deal`,
      payload: {
        questionId: randomUUID(),
        answers: [],
        goals: [0],
        actAsYou: false,
        capsUsd: [1]
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
    expect((await store.getTask(f.user.id, f.task.id))!.securityMode).toBe('balanced');
  });
});

describe('a question that said how long it would wait', () => {
  const park = async (f: Awaited<ReturnType<typeof fixture>>, answerBy: string) => {
    const questionId = randomUUID();
    await store.appendTaskEvent({
      id: questionId,
      taskId: f.task.id,
      kind: 'question_asked',
      summary: 'Apply anyway?',
      payloadCiphertext: encryptJson(
        { __gardenEventVersion: 1, summary: 'Apply anyway?', payload: { questionId } },
        key,
        `task-event:${f.task.id}`
      )
    } as Parameters<typeof store.appendTaskEvent>[0]);
    await database.query('UPDATE tasks SET agent_state_ciphertext=$2::jsonb WHERE id=$1', [
      f.task.id,
      JSON.stringify(
        encryptJson(
          {
            messages: [],
            step: 1,
            turn: 0,
            credits: 0,
            question: {
              id: questionId,
              question: 'Apply anyway?',
              askedAtStep: 1,
              default: 'Skip it',
              answerBy
            }
          },
          key,
          `task-state:${f.task.id}`
        )
      )
    ]);
  };

  it('is answered with its default once the time has passed, and not before', async () => {
    const f = await fixture();
    const sweep = createQuestionDefaultSweep(f.context);
    await park(f, new Date(Date.now() + 3_600_000).toISOString());
    expect(await sweep()).toBe(0);
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
    await park(f, new Date(Date.now() - 60_000).toISOString());
    expect(await sweep()).toBe(1);
    const answer = await store.getNextQueuedTaskMessage(f.task.id);
    expect(decryptJson<{ prompt: string }>(answer!.promptCiphertext, key).prompt).toContain(
      'taking the default I offered: Skip it'
    );
  });
});
