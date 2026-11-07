import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_OUTCOME_IDS, TaskOutcomes, type TaskOutcome } from '@garden/contracts';
import { encryptJson, sha256, wrapDataKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import type { RouteContext } from '../http/server-context.js';
import { registerErrorHandler } from '../http/errors.js';
import { silentLogger } from '../log.js';
import { registerOutcomeRoutes } from './outcomes.js';

describe('a page of finished goals, read as their results', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database);
  const masterKey = Buffer.alloc(32, 5);
  const app = Fastify();
  const ownerKey = Buffer.alloc(32, 8),
    otherKey = Buffer.alloc(32, 9);
  let ownerId = '',
    otherId = '',
    workspaceId = '',
    otherWorkspaceId = '';

  const workspace = async (userId: string, key: Buffer, name: string) => {
    const id = randomUUID();
    await store.createWorkspace({
      id,
      userId,
      name,
      storageLimitBytes: 10_000_000_000,
      imageRevision: 'test',
      region: 'local',
      wrappedKey: wrapDataKey(key, masterKey, id)
    });
    await store.updateWorkspaceStatus(id, 'running');
    return id;
  };
  const task = async (userId: string, inWorkspace: string, key: Buffer, status: string) => {
    const created = await store.createTask({
      userId,
      workspaceId: inWorkspace,
      titleCiphertext: encryptJson({ title: 'Goal' }, key, `task-title:${inWorkspace}`),
      promptCiphertext: encryptJson({ prompt: 'Do it' }, key, `task-prompt:${inWorkspace}`),
      nameIndex: { nameTokens: 'goal', openingTokens: 'do' },
      modelId: 'test/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1
    });
    await database.query('UPDATE tasks SET status=$2 WHERE id=$1', [created.id, status]);
    return created.id;
  };
  /** Sealed the way the worker seals every event it writes. */
  const emit = (taskId: string, key: Buffer, kind: string, summary: string, payload: unknown) =>
    store.appendTaskEvent({
      taskId,
      kind,
      summary: `Encrypted ${kind.replaceAll('_', ' ')} event`,
      payloadCiphertext: encryptJson(
        { __gardenEventVersion: 1, summary, payload },
        key,
        `task-event:${taskId}`
      )
    });
  const publish = async (
    taskId: string,
    inWorkspace: string,
    key: Buffer,
    name: string,
    path = `workspace/${name}`
  ) =>
    String(
      (
        await store.createArtifact({
          userId: ownerId,
          workspaceId: inWorkspace,
          taskId,
          logicalKey: sha256(path),
          nameCiphertext: encryptJson({ name }, key, `artifact-name:${inWorkspace}`),
          mimeType: 'application/pdf',
          sizeBytes: 2_048,
          sha256: sha256(randomUUID()),
          storageKey: randomUUID()
        })
      ).id
    );
  const ask = (ids: readonly string[], as = 'owner') =>
    app.inject({
      method: 'GET',
      url: `/v1/outcomes?ids=${ids.join(',')}`,
      headers: { 'x-test-user': as }
    });
  const outcomesOf = async (ids: readonly string[]): Promise<TaskOutcome[]> => {
    const response = await ask(ids);
    expect(response.statusCode, response.body).toBe(200);
    return TaskOutcomes.parse(response.json()).outcomes;
  };

  const reply = [
    '**Done** — the landing page is rebuilt and live on the preview. It loads in under a second.',
    '',
    'The hero now leads with the offer.',
    '',
    'Checked: ran the build; opened it at 375px and 1440px · Lighthouse 98',
    'Your call: keep the green, or try the blue variant?'
  ].join('\n');
  let finished = '',
    finishedPreview = '',
    newestReport = '',
    finishedAt = '';

  beforeAll(async () => {
    await migrateDatabase(database);
    const owner = await store.createUser({ username: 'outcome-owner', displayName: 'Owner' });
    const other = await store.createUser({ username: 'outcome-other', displayName: 'Other' });
    ownerId = owner.id;
    otherId = other.id;
    workspaceId = await workspace(ownerId, ownerKey, 'Owner computer');
    otherWorkspaceId = await workspace(otherId, otherKey, 'Other computer');

    finished = await task(ownerId, workspaceId, ownerKey, 'completed');
    await emit(finished, ownerKey, 'user_message', 'Rebuild the landing page', {
      markdown: 'Rebuild the landing page'
    });
    await emit(finished, ownerKey, 'assistant_message', 'Building it now.', {
      markdown: 'Building it now.'
    });
    await emit(finished, ownerKey, 'tool_started', 'Running a command', {
      tool: 'shell',
      toolCallId: 'call-1',
      arguments: {}
    });
    await emit(finished, ownerKey, 'tool_result', 'Command finished', {
      toolCallId: 'call-1',
      result: { exitCode: 0 }
    });
    const live = await store.createWorkspacePreview({
      userId: ownerId,
      workspaceId,
      label: 'Landing page',
      port: 5173,
      slug: randomUUID().replaceAll('-', ''),
      accessTokenHash: sha256('preview-token-never-returned')
    });
    finishedPreview = live.id;
    const revoked = await store.createWorkspacePreview({
      userId: ownerId,
      workspaceId,
      label: 'Old draft',
      port: 5174,
      slug: randomUUID().replaceAll('-', ''),
      accessTokenHash: sha256(randomUUID())
    });
    await store.revokeWorkspacePreview(ownerId, revoked.id);
    // Published in the same workspace by no receipt of this conversation's.
    await store.createWorkspacePreview({
      userId: ownerId,
      workspaceId,
      label: 'Someone else’s app',
      port: 5175,
      slug: randomUUID().replaceAll('-', ''),
      accessTokenHash: sha256(randomUUID())
    });
    for (const preview of [revoked, live])
      await emit(finished, ownerKey, 'preview', `${preview.label} is ready`, {
        previewId: preview.id,
        label: preview.label,
        port: preview.port,
        url: 'https://preview.test/?access=preview-token-never-returned',
        visibility: 'private'
      });
    await publish(finished, workspaceId, ownerKey, 'report.pdf');
    await publish(finished, workspaceId, ownerKey, 'notes.pdf');
    newestReport = await publish(finished, workspaceId, ownerKey, 'report.pdf');
    await emit(finished, ownerKey, 'assistant_message', reply.slice(0, 500), { markdown: reply });
    const completed = await emit(finished, ownerKey, 'completed', 'Task completed', {
      summary: 'Done — the landing page is rebuilt and live on the preview.',
      answer: reply,
      answerChannel: 'final',
      verification: {
        status: 'verified',
        evidence: [],
        remainingRisks: ['Only checked in Chromium', '', 7]
      }
    });
    finishedAt = completed.createdAt;

    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      request.user = request.headers['x-test-user'] === 'other' ? other : owner;
    });
    registerErrorHandler({
      app,
      log: silentLogger,
      requestStarted: new WeakMap()
    } as unknown as Parameters<typeof registerErrorHandler>[0]);
    registerOutcomeRoutes({ app, store, database, masterKey } as unknown as RouteContext);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('reads a finished goal as its answer, its verdict, its checks and what it made', async () => {
    const [outcome] = await outcomesOf([finished]);
    expect(outcome).toEqual({
      taskId: finished,
      answer:
        '**Done** — the landing page is rebuilt and live on the preview. It loads in under a second.\n\nThe hero now leads with the offer.',
      headline: 'Done — the landing page is rebuilt and live on the preview.',
      checked: ['ran the build', 'opened it at 375px and 1440px', 'Lighthouse 98'],
      yourCall: ['keep the green, or try the blue variant?'],
      verification: 'verified',
      risks: ['Only checked in Chromium'],
      files: [
        expect.objectContaining({ id: newestReport, name: 'report.pdf', version: 2 }),
        expect.objectContaining({ name: 'notes.pdf', version: 1, mimeType: 'application/pdf' })
      ],
      previews: [
        expect.objectContaining({ id: finishedPreview, label: 'Landing page', port: 5173 })
      ],
      at: finishedAt
    });
    const response = await ask([finished]);
    expect(response.headers['cache-control']).toBe('private, no-store');
    // A receipt's address carries the preview's bearer token; the outcome is built from the row.
    expect(response.body).not.toContain('preview-token-never-returned');
  });

  it('answers a running goal that has only spoken beside its work with nothing yet', async () => {
    const running = await task(ownerId, workspaceId, ownerKey, 'running');
    await emit(running, ownerKey, 'user_message', 'Research the market', {
      markdown: 'Research the market'
    });
    await emit(running, ownerKey, 'assistant_message', 'Checked: nothing yet, starting.', {
      markdown: 'Checked: nothing yet, starting.'
    });
    await emit(running, ownerKey, 'tool_started', 'Reading sources', {
      tool: 'web_search',
      toolCallId: 'call-1',
      arguments: { query: 'market' }
    });
    expect(await outcomesOf([running])).toEqual([
      {
        taskId: running,
        answer: null,
        headline: null,
        checked: [],
        yourCall: [],
        verification: null,
        risks: [],
        files: [],
        previews: [],
        at: null
      }
    ]);
  });

  it('does not show an earlier direction’s ending over the follow-up being worked now', async () => {
    const followed = await task(ownerId, workspaceId, ownerKey, 'running');
    await emit(followed, ownerKey, 'user_message', 'Write the memo', {
      markdown: 'Write the memo'
    });
    await emit(followed, ownerKey, 'assistant_message', 'The memo is written.', {
      markdown: 'The memo is written.\n\nChecked: it reads cleanly'
    });
    await emit(followed, ownerKey, 'completed', 'Task completed', {
      summary: 'The memo is written.',
      answer: 'The memo is written.\n\nChecked: it reads cleanly',
      verification: { status: 'verified', evidence: [], remainingRisks: [] }
    });
    const [settled] = await outcomesOf([followed]);
    expect(settled).toMatchObject({
      headline: 'The memo is written.',
      checked: ['it reads cleanly']
    });
    await emit(followed, ownerKey, 'user_message', 'Now make it shorter', {
      markdown: 'Now make it shorter'
    });
    expect(await outcomesOf([followed])).toEqual([
      expect.objectContaining({ answer: null, headline: null, verification: null, at: null })
    ]);
    // A reply the follow-up gives before anything closes it is the reply, with no verification yet.
    const spoken = await emit(followed, ownerKey, 'assistant_message', 'Shorter now.', {
      markdown: 'Shorter now.\n\nYour call: send it?'
    });
    expect(await outcomesOf([followed])).toEqual([
      expect.objectContaining({
        answer: 'Shorter now.',
        yourCall: ['send it?'],
        checked: [],
        verification: null,
        risks: [],
        at: spoken.createdAt
      })
    ]);
  });

  it('takes the answer a completion carries over the earlier message it supersedes', async () => {
    // A reply to a failed check restates the answer without a bubble of its own, so the
    // completion is the only place the final words are.
    const repaired = await task(ownerId, workspaceId, ownerKey, 'completed');
    await emit(repaired, ownerKey, 'user_message', 'Fix the test', { markdown: 'Fix the test' });
    await emit(repaired, ownerKey, 'assistant_message', 'Fixed.', { markdown: 'Fixed.' });
    await emit(repaired, ownerKey, 'status', '1 of 1 checks failed', { acceptance: [] });
    await emit(repaired, ownerKey, 'completed', 'Task completed', {
      summary: 'Fixed properly this time.',
      answer: 'Fixed properly this time.\n\nChecked: pnpm test passes',
      verification: { status: 'checks_failed', evidence: [], remainingRisks: ['A check failed'] }
    });
    expect(await outcomesOf([repaired])).toEqual([
      expect.objectContaining({
        answer: 'Fixed properly this time.',
        checked: ['pnpm test passes'],
        verification: 'checks_failed',
        risks: ['A check failed']
      })
    ]);
  });

  it('tells files apart by their source, keeps the newest version of each, and shows six', async () => {
    const made = await task(ownerId, workspaceId, ownerKey, 'completed');
    for (const index of [1, 2, 3, 4, 5])
      await publish(made, workspaceId, ownerKey, `source-${index}.pdf`);
    // Two different files that happen to share a display name are two results.
    await publish(made, workspaceId, ownerKey, 'chart.png', 'workspace/a/chart.png');
    await publish(made, workspaceId, ownerKey, 'chart.png', 'workspace/b/chart.png');
    const revised = await publish(made, workspaceId, ownerKey, 'source-1.pdf');
    await emit(made, ownerKey, 'completed', 'Task completed', { summary: 'Seven files.' });
    const [outcome] = await outcomesOf([made]);
    expect(outcome?.files.map((file) => [file.name, file.version])).toEqual([
      ['source-1.pdf', 2],
      ['chart.png', 1],
      ['chart.png', 1],
      ['source-5.pdf', 1],
      ['source-4.pdf', 1],
      ['source-3.pdf', 1]
    ]);
    expect(outcome?.files[0]?.id).toBe(revised);
  });

  it('omits another owner’s goal, an unknown id and a malformed one, and keeps the order asked', async () => {
    const foreign = await task(otherId, otherWorkspaceId, otherKey, 'completed');
    await emit(foreign, otherKey, 'assistant_message', 'Private answer.', {
      markdown: 'Private answer.'
    });
    await emit(foreign, otherKey, 'completed', 'Task completed', {
      summary: 'Private answer.',
      answer: 'Private answer.'
    });
    const second = await task(ownerId, workspaceId, ownerKey, 'completed');
    await emit(second, ownerKey, 'completed', 'Task completed', { summary: 'Second goal done.' });
    const outcomes = await outcomesOf([
      second,
      foreign,
      randomUUID(),
      'not-a-task',
      finished.toUpperCase()
    ]);
    expect(outcomes.map((outcome) => outcome.taskId)).toEqual([second, finished]);
    expect(outcomes[0]).toMatchObject({ answer: 'Second goal done.', verification: null });
    expect(JSON.stringify(outcomes)).not.toContain('Private answer');
    // The other owner reads their own goal, and nothing of this one.
    const theirs = await ask([foreign, finished], 'other');
    expect(TaskOutcomes.parse(theirs.json()).outcomes.map((outcome) => outcome.taskId)).toEqual([
      foreign
    ]);
  });

  it(`refuses more than ${MAX_OUTCOME_IDS} ids before reading any of them`, async () => {
    const many = Array.from({ length: MAX_OUTCOME_IDS }, () => randomUUID());
    expect((await ask(many)).statusCode).toBe(200);
    // The same id twice is one id.
    expect((await ask([...many, many[0]!])).statusCode).toBe(200);
    const refused = await ask([...many, randomUUID()]);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('outcome_ids_limit');
    expect((await ask([])).json()).toEqual({ outcomes: [] });
  });

  it('lists what a goal published before it moved to its project’s own computer', async () => {
    const sourceKey = Buffer.alloc(32, 12);
    const source = await workspace(ownerId, sourceKey, 'Source computer');
    const moved = await task(ownerId, source, sourceKey, 'completed');
    const executionId = randomUUID();
    await store.beginProjectExecution({
      userId: ownerId,
      taskId: moved,
      workspaceId: executionId,
      wrappedKey: wrapDataKey(ownerKey, masterKey, executionId),
      seedKind: 'legacy',
      sourceManifestCiphertext: encryptJson({ paths: [] }, ownerKey)
    });
    expect(
      await store.finishProjectExecution({
        userId: ownerId,
        taskId: moved,
        workspaceId: executionId,
        receiptCiphertext: encryptJson({ copied: [] }, ownerKey),
        rewrite: () => ({
          titleCiphertext: encryptJson({ title: 'Goal' }, ownerKey, `task-title:${executionId}`),
          promptCiphertext: encryptJson({ prompt: 'Do it' }, ownerKey, `task-prompt:${executionId}`)
        })
      })
    ).toBe(true);
    const before = await publish(moved, source, sourceKey, 'before the move.pdf');
    const after = await publish(moved, executionId, ownerKey, 'after the move.pdf');
    await emit(moved, ownerKey, 'completed', 'Task completed', { summary: 'Both are ready.' });
    const [outcome] = await outcomesOf([moved]);
    expect(outcome?.answer).toBe('Both are ready.');
    expect(outcome?.files.map((file) => [file.id, file.name])).toEqual([
      [after, 'after the move.pdf'],
      [before, 'before the move.pdf']
    ]);
  });
});
