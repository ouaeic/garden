import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  buildMemorySourceIndex,
  encryptJson,
  memoryIndexKey,
  planMemoryQuery,
  wrapDataKey
} from '@athanor/core';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore } from './store.js';
import { projectResponse } from './projects.js';
import {
  readTaskModelPreferences,
  writeProjectModelPreferences
} from './project-model-preferences.js';
const db = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
  store = new DataStore(db),
  key = Buffer.alloc(32, 9),
  master = Buffer.alloc(32, 7);
beforeAll(() => migrateDatabase(db));
afterAll(() => db.close());
async function fixture() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspace = async () => {
    const id = randomUUID();
    return store.createWorkspace({
      id,
      userId: user.id,
      name: 'Computer',
      imageRevision: 'fixture',
      region: 'auto',
      storageLimitBytes: 1e9,
      wrappedKey: wrapDataKey(key, master, id)
    });
  };
  const first = await workspace(),
    second = await workspace();
  const create = (
    workspaceId: string,
    projectId?: string,
    choices?: Parameters<DataStore['createTask']>[0]['modelChoicesCiphertext']
  ) =>
    store.createTask({
      userId: user.id,
      workspaceId,
      titleCiphertext: encryptJson({ title: 'Analysis' }, key),
      promptCiphertext: encryptJson({ prompt: 'Project brief' }, key),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'fixture',
      privacyRoute: 'external',
      securityMode: 'autonomous',
      maxComputeCredits: 1,
      ...(projectId ? { projectId } : {}),
      ...(choices ? { modelChoicesCiphertext: choices, modelOverride: true } : {})
    });
  const root = await create(first.id),
    child = await create(second.id, root.projectId),
    other = await create(first.id);
  return { user, first, second, root, child, other, create };
}
it('keeps project identity, sealed settings and conversations independent of ancestry and first-task deletion', async () => {
  const f = await fixture(),
    id = f.root.projectId!;
  const project = await store.getProject(f.user.id, id);
  expect(project).not.toBeNull();
  expect(projectResponse(project!, master)).toMatchObject({
    conversationCount: 2,
    activeCount: 2,
    securityMode: 'autonomous',
    brief: 'Project brief'
  });
  const next = await store.updateProject(
    f.user.id,
    id,
    {
      expectedRevision: 1,
      title: 'Genome study',
      brief: 'Use the verified assembly',
      securityMode: 'review'
    },
    master
  );
  expect(projectResponse(next, master)).toMatchObject({
    title: 'Genome study',
    brief: 'Use the verified assembly',
    revision: 2,
    securityMode: 'review'
  });
  const raw = await db.query('SELECT title,brief_ciphertext FROM projects WHERE id=$1', [id]);
  expect(JSON.stringify(raw.rows)).not.toContain('Genome study');
  await expect(
    store.updateProject(f.user.id, id, { expectedRevision: 1, title: 'Stale' }, master)
  ).rejects.toMatchObject({ code: 'project_changed' });
  await db.query('DELETE FROM tasks WHERE id=$1', [f.root.id]);
  expect((await store.getProject(f.user.id, id))?.conversationCount).toBe(1);
  expect((await store.listProjectConversations(f.user.id, id)).tasks.map((t) => t.id)).toEqual([
    f.child.id
  ]);
  expect(await store.getProject(randomUUID(), id)).toBeNull();
  await expect(f.create(f.first.id, randomUUID())).rejects.toThrow();
});
it('paginates without repeating conversations and keeps per-conversation purpose overrides sealed', async () => {
  const f = await fixture(),
    id = f.root.projectId!;
  const choice = { automatic: false, preference: 'fast' as const, modelId: 'chosen-project' };
  await writeProjectModelPreferences(store, master, f.root, {
    expectedRevision: 0,
    choices: { image: choice, main: choice }
  });
  const override = { ...choice, modelId: 'chosen-conversation' };
  const conversation = await f.create(
    f.second.id,
    id,
    encryptJson({ image: override }, key, `conversation-models:${id}`)
  );
  expect((await readTaskModelPreferences(store, master, conversation)).choices).toEqual({
    main: choice,
    image: override
  });
  expect((await readTaskModelPreferences(store, master, f.child)).choices.image).toEqual(choice);
  const first = await store.listProjectConversations(f.user.id, id, { limit: 2 });
  expect(first.tasks).toHaveLength(2);
  expect(first.nextCursor).not.toBeNull();
  const next = await store.listProjectConversations(f.user.id, id, {
    limit: 2,
    before: first.nextCursor!
  });
  expect(next.tasks).toHaveLength(1);
  expect(next.nextCursor).toBeNull();
  expect(new Set([...first.tasks, ...next.tasks].map((t) => t.id)).size).toBe(3);
});
it('searches and expands only this project across execution roots in both memory tiers', async () => {
  const f = await fixture(),
    project = { userId: f.user.id, projectId: f.root.projectId! },
    indexKey = memoryIndexKey(key);
  const add = async (task: typeof f.root, body: string) => {
    const index = buildMemorySourceIndex(body, indexKey);
    return store.createMemorySource({
      userId: f.user.id,
      workspaceId: task.workspaceId,
      taskId: task.id,
      role: 'assistant',
      channel: 'chat',
      bodyCiphertext: encryptJson({ body }, key, `memory-source:${task.workspaceId}`),
      ...index
    });
  };
  const one = await add(f.root, 'The genome alignment completed.'),
    two = await add(f.child, 'The genome quality check passed.'),
    foreign = await add(f.other, 'The genome analysis belongs to a different project.');
  const input = {
    workspaceId: f.child.workspaceId,
    project,
    plan: planMemoryQuery('genome', indexKey)
  };
  const hits = await store.searchMemorySources(input);
  expect(new Set(hits.map((h) => h.id))).toEqual(new Set([one.id, two.id]));
  expect(
    (
      await store.listMemorySourceWindow(f.child.workspaceId, one.id, {
        project,
        before: 0,
        after: 0
      })
    ).map((r) => r.id)
  ).toEqual([one.id]);
  expect(await store.listMemorySourceWindow(f.child.workspaceId, foreign.id, { project })).toEqual(
    []
  );
  expect(await store.memorySourceCoverage(f.child.workspaceId, project)).toMatchObject({
    turns: 2,
    conversations: 2
  });
  expect(
    await store.searchMemorySources({ ...input, project: { ...project, userId: randomUUID() } })
  ).toEqual([]);
  await db.query('UPDATE mem.source SET indexed=FALSE WHERE id=$1', [one.id]);
  expect(
    (await store.searchMemorySources({ ...input, reach: 'archived' })).map((h) => h.id)
  ).toEqual([one.id]);
});

it('retains source-linked corrections, rejects stale writers and does not revive removed claims', async () => {
  const f = await fixture(),
    id = f.root.projectId!;
  const one = await store.addProjectNote(
    f.user.id,
    id,
    { kind: 'finding', body: 'Initial finding', source: { taskId: f.root.id } },
    master
  );
  const two = await store.addProjectNote(
    f.user.id,
    id,
    {
      kind: 'decision',
      body: 'Corrected interpretation',
      source: { taskId: f.child.id },
      replacesId: one.id
    },
    master
  );
  expect((await store.listProjectNotes(f.user.id, id, master)).notes).toMatchObject([
    {
      id: two.id,
      body: 'Corrected interpretation',
      replacesId: one.id,
      source: { taskId: f.child.id }
    }
  ]);
  const history = (await store.listProjectNotes(f.user.id, id, master, { history: true })).notes;
  expect(history).toHaveLength(2);
  expect(history.find((note) => note.id === one.id)?.supersededBy).toBe(two.id);
  await expect(
    store.addProjectNote(
      f.user.id,
      id,
      { kind: 'finding', body: 'stale', replacesId: one.id },
      master
    )
  ).rejects.toMatchObject({ code: 'project_note_changed' });
  await expect(
    store.addProjectNote(
      f.user.id,
      id,
      { kind: 'finding', body: 'foreign', source: { taskId: f.other.id } },
      master
    )
  ).rejects.toMatchObject({ code: 'project_source_unavailable' });
  await expect(store.listProjectNotes(randomUUID(), id, master)).rejects.toMatchObject({
    code: 'project_not_found'
  });
  const raw = await db.query(
    'SELECT body_ciphertext,source_ciphertext FROM project_notes WHERE project_id=$1',
    [id]
  );
  expect(raw.rows).toHaveLength(2);
  expect(JSON.stringify(raw.rows)).not.toContain('Corrected interpretation');
  await store.removeProjectNote(f.user.id, id, two.id);
  expect((await store.listProjectNotes(f.user.id, id, master)).notes).toEqual([]);
});

it('retains execution directories and settled project spending after conversations are removed', async () => {
  const f = await fixture(),
    id = f.root.projectId!;
  await db.query('UPDATE workspaces SET parent_workspace_id=$1 WHERE id=$2', [
    f.first.id,
    f.second.id
  ]);
  await db.query('UPDATE tasks SET workspace_id=workspace_id WHERE id=$1', [f.child.id]);
  const shared = await f.create(f.second.id, id);
  await db.query('DELETE FROM tasks WHERE id=$1', [shared.id]);
  expect(await store.projectExecutionMembers(f.user.id, id, 'project')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ taskId: shared.id, workspaceId: f.second.id })
    ])
  );
  expect(await store.projectInputWorkspaceIds(f.user.id, f.root.id)).toEqual([f.second.id]);
  expect(await store.projectInputWorkspaceIds(randomUUID(), f.root.id)).toEqual([]);
  const usageId = randomUUID();
  await db.query(
    `INSERT INTO usage_entries(id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,idempotency_key,cost_usd)
 VALUES($1::uuid,$2,$3,$4,'model','fixture',1,'tokens',1,'settled',($1::uuid)::text,1.25)`,
    [usageId, f.user.id, f.second.id, f.child.id]
  );
  expect((await store.getProject(f.user.id, id))?.spentUsd).toBe(1.25);
  await db.query('DELETE FROM tasks WHERE id=$1', [f.child.id]);
  expect((await store.getProject(f.user.id, id))?.spentUsd).toBe(1.25);
  expect(await store.projectExecutionMembers(f.user.id, f.root.id)).toEqual(
    expect.arrayContaining([{ taskId: f.child.id, workspaceId: f.second.id }])
  );
  await db.query('DELETE FROM tasks WHERE id=$1', [f.root.id]);
  const retained = await store.projectExecutionMembers(f.user.id, id, 'project');
  expect(retained).toHaveLength(2);
  expect(retained).toEqual(
    expect.arrayContaining([
      { taskId: f.child.id, workspaceId: f.second.id },
      { taskId: shared.id, workspaceId: f.second.id }
    ])
  );
  expect(await store.projectExecutionMembers(f.user.id, id)).toEqual([]);
  expect((await store.getProject(f.user.id, id))?.conversationCount).toBe(0);
  expect((await store.getProject(f.user.id, id))?.spentUsd).toBe(1.25);
  expect(await store.projectExecutionMembers(randomUUID(), id, 'project')).toEqual([]);
});

it('counts a working conversation with an unanswered direction as needing attention', async () => {
  const f = await fixture();
  const questionId = randomUUID();
  await db.query("UPDATE tasks SET status='completed' WHERE project_id=$1", [f.root.projectId]);
  await db.query("UPDATE tasks SET status='running',pending_question_id=$2 WHERE id=$1", [
    f.child.id,
    questionId
  ]);
  expect(await store.getProject(f.user.id, f.root.projectId!)).toMatchObject({
    activeCount: 1,
    attentionCount: 1
  });
  expect(
    (await store.listProjectConversations(f.user.id, f.root.projectId!)).tasks.find(
      (task) => task.id === f.child.id
    )
  ).toMatchObject({ hasOpenQuestion: true });
  await store.enqueueTaskMessage({
    id: randomUUID(),
    taskId: f.child.id,
    userId: f.user.id,
    modelId: f.child.modelId,
    privacyRoute: f.child.privacyRoute,
    maxComputeCredits: 0,
    maxSpendUsd: null,
    resourceClass: 'light',
    reservationKey: randomUUID(),
    interrupt: true,
    questionId,
    promptCiphertext: f.child.promptCiphertext,
    queuedEventCiphertext: f.child.promptCiphertext
  });
  expect(await store.getProject(f.user.id, f.root.projectId!)).toMatchObject({
    activeCount: 1,
    attentionCount: 0
  });
  await db.query("UPDATE tasks SET status='cancelled',pending_question_id=$2 WHERE id=$1", [
    f.child.id,
    questionId
  ]);
  expect(await store.getProject(f.user.id, f.root.projectId!)).toMatchObject({
    activeCount: 0,
    attentionCount: 0
  });
});

it('keeps pending deliveries visible in project and conversation status, using the latest attempt per output', async () => {
  const f = await fixture();
  await db.query("UPDATE tasks SET status='completed' WHERE project_id=$1", [f.root.projectId]);
  const job = async (status: string, date: string) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO provider_media_jobs(id,user_id,workspace_id,task_id,request_key,request_hash,request_ciphertext,model_id,status,reservation_usd,retention_approved_at,output_path,created_at)
      VALUES($1,$2,$3,$4,($1::uuid)::text,'hash',$5::jsonb,'model',$6,0.1,NOW(),'workspace/chart.mp4',$7)`,
      [
        id,
        f.user.id,
        f.child.workspaceId,
        f.child.id,
        JSON.stringify(f.child.promptCiphertext),
        status,
        date
      ]
    );
  };
  await job('failed', '2026-01-01');
  expect(await store.getProject(f.user.id, f.root.projectId!)).toMatchObject({
    activeCount: 0,
    attentionCount: 1
  });
  await job('pending', '2026-01-02');
  expect(await store.getProject(f.user.id, f.root.projectId!)).toMatchObject({
    activeCount: 1,
    attentionCount: 0
  });
  const page = await store.listProjectConversations(f.user.id, f.root.projectId!);
  expect(page.tasks.find((task) => task.id === f.child.id)).toMatchObject({
    deliveryStatus: 'pending',
    pendingDeliveryCount: 1
  });
  expect(
    (await store.listProjects(f.user.id)).projects.find(
      (project) => project.id === f.root.projectId
    )
  ).toMatchObject({ activeCount: 1, attentionCount: 0 });
  await job('completed', '2026-01-03');
  expect(await store.getProject(f.user.id, f.root.projectId!)).toMatchObject({
    activeCount: 0,
    attentionCount: 0
  });
});
