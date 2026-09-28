import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { decryptJson, encryptJson, sha256, wrapDataKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase, type TaskRecord } from '@garden/data';
import type { RouteContext } from '../http/server-context.js';
import { TaskEvidenceReader } from '../task-evidence.js';
import { buildTaskPresentation } from '../task-presentation.js';
import { registerPreviewStartRoutes } from './preview-start.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const masterKey = Buffer.alloc(32, 3),
  key = Buffer.alloc(32, 7);
beforeAll(async () => migrateDatabase(database));
afterAll(async () => database.close());

async function fixture() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspaceId = randomUUID();
  await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'App',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: wrapDataKey(key, masterKey, workspaceId)
  });
  await store.updateWorkspaceStatus(workspaceId, 'running');
  const task = await store.createTask({
    userId: user.id,
    workspaceId,
    modelId: 'test/model',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 5,
    maxSpendUsd: 3,
    securityMode: 'autonomous',
    titleCiphertext: encryptJson({ title: 'App' }, key),
    promptCiphertext: encryptJson({ prompt: 'App' }, key),
    nameIndex: { nameTokens: '', openingTokens: '' }
  });
  await database.query('UPDATE tasks SET status=$2,agent_state_ciphertext=$3::jsonb WHERE id=$1', [
    task.id,
    'completed',
    JSON.stringify(
      encryptJson(
        { messages: [{ role: 'user', content: 'Build an app' }], turn: 1 },
        key,
        `task-state:${task.id}`
      )
    )
  ]);
  const preview = await store.createWorkspacePreview({
    userId: user.id,
    workspaceId,
    label: 'App',
    port: 8080,
    slug: randomUUID().replaceAll('-', ''),
    accessTokenHash: sha256('private'),
    entryPath: 'app/'
  });
  await store.appendTaskEvent({
    taskId: task.id,
    kind: 'preview',
    summary: 'App',
    payloadCiphertext: encryptJson({ previewId: preview.id }, key, `task-event:${task.id}`)
  });
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = request.headers['x-outsider'] ? { ...user, id: randomUUID() } : user;
    if (request.headers['x-api-token'])
      request.apiToken = {} as NonNullable<typeof request.apiToken>;
  });
  const models = vi.fn(async () => [
    {
      id: task.modelId,
      availability: 'available',
      privacyRoute: task.privacyRoute,
      usageClass: 'light'
    }
  ]);
  const probe = vi.fn(async () => ({ available: false }));
  registerPreviewStartRoutes({
    app,
    store,
    database,
    masterKey,
    reservedPreviewPortSet: new Set([4300]),
    runner: { request: probe },
    modelsForUser: models,
    privateTaskResponse: async (value: TaskRecord) => value,
    config: { TASK_MAX_STEPS: 20 },
    idempotent: async (_r: unknown, _p: unknown, _u: unknown, execute: () => unknown) => execute()
  } as unknown as RouteContext);
  const url = `/v1/tasks/${task.id}/previews/${preview.id}/start`;
  const send = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers, payload: {} });
  return { app, user, task, preview, send, models, probe, url };
}

it('starts one real continuation across concurrent clicks, preserving policy and allowance, and renews the private link', async () => {
  const f = await fixture();
  try {
    await database.query(
      "UPDATE workspace_previews SET expires_at=NOW()-INTERVAL '1 day' WHERE id=$1",
      [f.preview.id]
    );
    const responses = await Promise.all([f.send(), f.send()]);
    expect(responses.map((r) => [r.statusCode, r.json<unknown>()])).toEqual([
      [200, { state: 'starting' }],
      [200, { state: 'starting' }]
    ]);
    const task = (await store.getTask(f.user.id, f.task.id))!;
    expect(task).toMatchObject({
      status: 'queued',
      modelId: f.task.modelId,
      maxSpendUsd: 3,
      maxComputeCredits: 5,
      privacyRoute: 'provider_zdr',
      securityMode: 'autonomous'
    });
    expect(f.models).toHaveBeenCalledTimes(1);
    const state = decryptJson<{ messages: { content: string }[] }>(
      task.agentStateCiphertext!,
      key,
      `task-state:${task.id}`
    );
    expect(state.messages.at(-1)!.content).toContain('timeoutSeconds=3600');
    expect(state.messages.at(-1)!.content).toContain(
      'Do not publish another preview or change its visibility'
    );
    const { events } = await new TaskEvidenceReader(database).read(task.id, key);
    expect(events.filter((event) => event.kind === 'user_message')).toHaveLength(1);
    const p = (await store.getWorkspacePreview(f.user.id, f.preview.id))!;
    expect(Date.parse(p.expiresAt!)).toBeGreaterThan(Date.now());
    expect(p.accessTokenHash).toBe(f.preview.accessTokenHash);
    const presented = (status: string) =>
      buildTaskPresentation({
        taskId: task.id,
        workspaceId: task.workspaceId,
        taskStatus: status,
        events,
        plan: null,
        artifacts: [],
        previews: [{ ...p, url: 'https://garden.test/preview' }],
        previewAvailability: new Map([[p.id, 'unavailable']]),
        files: new Map()
      });
    expect(presented('queued').results[0]).toMatchObject({
      startPath: f.url,
      startState: 'starting',
      detail: 'The app has stopped. Start its preview again when you’re ready.'
    });
    expect(presented('awaiting_user').results[0]?.startState).toBe('attention');
    expect(presented('completed').results[0]?.startState).toBeUndefined();
    expect(presented('queued').surface?.currentResultIds).toContain(`preview:${p.id}`);
  } finally {
    await f.app.close();
  }
});

it('reopens an already running app without a model call or another turn', async () => {
  const f = await fixture();
  try {
    f.probe.mockResolvedValue({ available: true });
    const response = await f.send();
    expect([response.statusCode, response.json()]).toEqual([200, { state: 'ready' }]);
    expect(f.models).not.toHaveBeenCalled();
    expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('completed');
  } finally {
    await f.app.close();
  }
});

it('refuses foreign ownership, unassociated previews, revoked links and API tokens before executing work', async () => {
  const f = await fixture();
  try {
    expect((await f.send({ 'x-outsider': 'yes' })).statusCode).toBe(404);
    expect((await f.send({ 'x-api-token': 'yes' })).statusCode).toBe(403);
    await database.query('DELETE FROM task_events WHERE task_id=$1', [f.task.id]);
    expect((await f.send()).statusCode).toBe(404);
    await store.revokeWorkspacePreview(f.user.id, f.preview.id);
    expect((await f.send()).statusCode).toBe(404);
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.models).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});

it('does not interrupt other work or queue recovery when the computer cannot be reached', async () => {
  const f = await fixture();
  try {
    await store.setTaskStatusForUser(f.user.id, f.task.id, 'running');
    expect((await f.send()).statusCode).toBe(409);
    expect(f.models).not.toHaveBeenCalled();
    await store.setTaskStatusForUser(f.user.id, f.task.id, 'completed');
    f.probe.mockRejectedValue(new Error('Computer disconnected'));
    expect((await f.send()).statusCode).toBe(500);
    expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('completed');
  } finally {
    await f.app.close();
  }
});

it('wakes a sleeping project through its existing owner-scoped workspace control', async () => {
  const f = await fixture();
  try {
    await store.updateWorkspaceStatus(f.task.workspaceId, 'hibernated');
    expect((await f.send()).statusCode).toBe(200);
    expect(f.probe.mock.calls[0]).toEqual([
      expect.objectContaining({
        workspaceId: f.task.workspaceId,
        role: 'control',
        scopes: ['workspace.manage'],
        path: `/v1/workspaces/${f.task.workspaceId}/resume`
      })
    ]);
    expect((await store.getWorkspace(f.user.id, f.task.workspaceId))?.status).toBe('running');
  } finally {
    await f.app.close();
  }
});
