import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OwnerMove, RecordEntry, TaskDeal } from '@garden/contracts';
import { encryptJson, wrapDataKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase, type TaskRecord } from '@garden/data';
import { registerMoveRoutes } from './routes/moves.js';
import type { RouteContext } from './http/server-context.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const key = Buffer.alloc(32, 5),
  masterKey = Buffer.alloc(32, 6);
beforeAll(async () => migrateDatabase(database));
afterAll(async () => database.close());

const deal: TaskDeal = {
  summary: 'A return ready to file.',
  goals: [{ title: '2025 tax return', outcome: 'Ready to file.', doneWhen: 'Valid.', capUsd: 8 }],
  questions: [],
  actAsYou: false
};

const setup = async () => {
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
  const sealed = encryptJson({ prompt: 'x' }, key, 'test');
  const task = async (title: string) =>
    store.createTask({
      userId: user.id,
      workspaceId,
      modelId: 'model',
      reasoningEffort: 'auto',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      maxSpendUsd: 5,
      titleCiphertext: encryptJson({ title }, key, `task-title:${workspaceId}`),
      promptCiphertext: sealed,
      nameIndex: { nameTokens: '', openingTokens: '' }
    });
  const park = async (record: TaskRecord, question: Record<string, unknown>, payload: object) => {
    const id = randomUUID();
    await store.appendTaskEvent({
      id,
      taskId: record.id,
      kind: 'question_asked',
      summary: 'Asked',
      payloadCiphertext: encryptJson(
        { __gardenEventVersion: 1, summary: 'Asked', payload },
        key,
        `task-event:${record.id}`
      )
    } as Parameters<typeof store.appendTaskEvent>[0]);
    await database.query(
      "UPDATE tasks SET status='awaiting_user', agent_state_ciphertext=$2::jsonb WHERE id=$1",
      [
        record.id,
        JSON.stringify(
          encryptJson(
            { messages: [], question: { ...question, id, askedAtStep: 1 } },
            key,
            `task-state:${record.id}`
          )
        )
      ]
    );
  };
  const dealt = await task('Taxes');
  await park(dealt, { question: deal.summary, deal: true }, { deal });
  const asked = await task('Mail');
  await park(asked, { question: 'Which mailbox?' }, { options: ['work@', 'billing@'] });
  const paused = await task('Paper');
  await database.query('UPDATE tasks SET spend_paused_at=NOW() WHERE id=$1', [paused.id]);
  const carded = await task('Applications');
  await database.query(
    `INSERT INTO approvals(id,user_id,task_id,action,side_effect,preview_ciphertext,preview_hash,expires_at)
     VALUES ($1,$2,$3,'browser_action','external_consequential',$4::jsonb,'hash',NOW() + INTERVAL '1 hour')`,
    [
      randomUUID(),
      user.id,
      carded.id,
      JSON.stringify(
        encryptJson(
          { action: 'Submit the application', preview: 'Spreeline Bio', tool: 'browser_action' },
          key,
          `approval:${carded.id}`
        )
      )
    ]
  );
  await store.recordKeyAuthorizedAction({
    userId: user.id,
    taskId: carded.id,
    action: 'Send the email',
    sideEffect: 'external_consequential',
    previewCiphertext: encryptJson(
      { action: 'Send the email', preview: 'To the recruiter', tool: 'connector_action' },
      key,
      `approval:${carded.id}`
    ),
    previewHash: 'hash'
  });
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = user;
  });
  registerMoveRoutes({
    app,
    store,
    database,
    masterKey,
    privateTaskResponse: async (record: TaskRecord) => ({
      ...record,
      title: (await import('@garden/core')).decryptJson<{ title: string }>(
        record.titleCiphertext!,
        key
      ).title
    })
  } as unknown as RouteContext);
  return { app };
};

describe('what is waiting on the owner, and what left the computer', () => {
  it('lists a deal, a question, a spend pause and a card, each typed and titled', async () => {
    const { app } = await setup();
    const moves = (await app.inject({ method: 'GET', url: '/v1/moves' })).json<OwnerMove[]>();
    const byKind = Object.fromEntries(moves.map((move) => [move.kind, move]));
    expect(Object.keys(byKind).sort()).toEqual(['approval', 'deal', 'question', 'spend']);
    expect(byKind.deal).toMatchObject({ taskTitle: 'Taxes', deal });
    expect(byKind.question).toMatchObject({
      taskTitle: 'Mail',
      question: 'Which mailbox?',
      options: ['work@', 'billing@']
    });
    expect(byKind.spend).toMatchObject({ taskTitle: 'Paper' });
    expect(byKind.approval).toMatchObject({
      taskTitle: 'Applications',
      action: 'Submit the application',
      detail: 'Spreeline Bio'
    });
  });

  it('records the card the owner is asked and the send a lent key allowed, in one list', async () => {
    const { app } = await setup();
    const record = (await app.inject({ method: 'GET', url: '/v1/record' })).json<RecordEntry[]>();
    expect(record.map((entry) => [entry.source, entry.verdict, entry.action]).sort()).toEqual([
      ['card', 'waiting', 'Submit the application'],
      ['key', 'approved', 'Send the email']
    ]);
  });
});
