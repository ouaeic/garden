import { registerWorkspaceRoutes } from './workspaces.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, DataStore, migrateDatabase, type WorkspaceRecord } from '@garden/data';
import { decryptJson, encryptJson, unwrapDataKey, wrapDataKey } from '@garden/core';
import { registerUsageRoutes } from './usage.js';
import { registerPrivacyRoutes } from './privacy.js';
import { registerScheduleRoutes } from './schedules.js';
import { registerAccountRoutes } from './account.js';
import type { RouteContext } from '../http/server-context.js';
import { createIdempotentOperation } from '../http/idempotency.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const masterKey = Buffer.alloc(32, 12);
const apps: FastifyInstance[] = [];
beforeAll(async () => migrateDatabase(database));
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});
afterAll(async () => database.close());

async function fixture() {
  const owner = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const other = await store.createUser({ username: randomUUID(), displayName: 'Other' });
  async function workspace(userId: string, name: string, value: number) {
    const id = randomUUID(),
      key = Buffer.alloc(32, value);
    const record = await store.createWorkspace({
      id,
      userId,
      name,
      wrappedKey: wrapDataKey(key, masterKey, id),
      storageLimitBytes: 1e9,
      imageRevision: 'fixture',
      region: 'local'
    });
    await store.updateWorkspaceStatus(id, 'running');
    await store.setWorkspaceStorage(userId, id, value);
    const task = await store.createTask({
      userId,
      workspaceId: id,
      modelId: 'fixture-model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      nameIndex: { nameTokens: '', openingTokens: '' },
      titleCiphertext: encryptJson({ title: `${name} title` }, key, `task-title:${id}`),
      promptCiphertext: encryptJson({ prompt: `${name} prompt` }, key, `task-prompt:${id}`)
    });
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'tool_started',
      summary: 'Encrypted tool started event',
      payloadCiphertext: encryptJson(
        {
          __gardenEventVersion: 1,
          summary: `${name} event`,
          payload: { tool: `${name}-tool`, arguments: {} }
        },
        key,
        `task-event:${task.id}`
      )
    });
    await store.createTaskPlan({
      taskId: task.id,
      expectedVersion: 0,
      branchName: 'main',
      createdBy: 'agent',
      stepsCiphertext: encryptJson({ label: `${name} plan` }, key, `task-plan:${task.id}`)
    });
    return { record: { ...record, status: 'running' }, task, key };
  }
  const parent = await workspace(owner.id, 'Parent', 10);
  const project = await workspace(owner.id, 'Project', 20);
  const foreign = await workspace(other.id, 'Foreign', 30);
  await database.query(
    'UPDATE workspaces SET parent_workspace_id=$2,project_task_id=$3 WHERE id=$1',
    [project.record.id, parent.record.id, project.task.id]
  );
  const schedule = await store.createTaskSchedule({
    userId: owner.id,
    workspaceId: project.record.id,
    modelId: 'fixture-model',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    titleCiphertext: encryptJson(
      { title: 'Project schedule' },
      project.key,
      `task-title:${project.record.id}`
    ),
    promptCiphertext: encryptJson(
      { prompt: 'Project scheduled prompt' },
      project.key,
      `task-prompt:${project.record.id}`
    ),
    spec: { kind: 'interval', everyMinutes: 60 },
    nextRunAt: new Date(Date.now() + 60_000)
  });
  const metered = vi.fn(async (record: WorkspaceRecord) => {
    await store.setWorkspaceStorage(
      record.userId,
      record.id,
      record.id === parent.record.id ? 13 : 29
    );
    return null;
  });
  const runnerRequest = vi.fn<(input: unknown) => Promise<Record<string, never>>>(async () => ({}));
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  app.addHook('preHandler', async (request) => {
    request.user = owner;
  });
  const reveal = (record: WorkspaceRecord) =>
    unwrapDataKey(record.wrappedKey!, masterKey, record.id);
  const context = {
    app,
    store,
    masterKey,
    secure: false,
    meterWorkspace: metered,
    runner: { request: runnerRequest },
    providerSpend: async () => null,
    requireRecentStepUp: vi.fn(async () => undefined),
    idempotent: createIdempotentOperation({ store, database, masterKey }),
    taskTitle: async (task: typeof parent.task, record: WorkspaceRecord) =>
      decryptJson<{ title: string }>(
        task.titleCiphertext!,
        reveal(record),
        `task-title:${record.id}`
      ).title,
    scheduleTitle: async (item: typeof schedule, record: WorkspaceRecord) =>
      decryptJson<{ title: string }>(
        item.titleCiphertext,
        reveal(record),
        `task-title:${record.id}`
      ).title,
    privateTaskPlanResponse: async (
      plan: Awaited<ReturnType<DataStore['listTaskPlans']>>[number],
      record: WorkspaceRecord
    ) => ({
      taskId: plan.taskId,
      ...decryptJson<object>(plan.stepsCiphertext, reveal(record), `task-plan:${plan.taskId}`)
    }),
    privateScheduleResponse: async (item: typeof schedule, record: WorkspaceRecord) => ({
      id: item.id,
      workspaceId: item.workspaceId,
      title: decryptJson<{ title: string }>(
        item.titleCiphertext,
        reveal(record),
        `task-title:${record.id}`
      ).title,
      prompt: decryptJson<{ prompt: string }>(
        item.promptCiphertext,
        reveal(record),
        `task-prompt:${record.id}`
      ).prompt
    })
  } as unknown as RouteContext;
  registerWorkspaceRoutes(context);
  registerUsageRoutes(context);
  registerPrivacyRoutes(context);
  registerScheduleRoutes(context);
  registerAccountRoutes(context);
  await app.ready();
  const remove = () =>
    app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: { 'idempotency-key': randomUUID() },
      payload: { confirmUsername: owner.username }
    });
  return { app, owner, other, parent, project, foreign, schedule, metered, runnerRequest, remove };
}

describe('owner routes across project execution namespaces', () => {
  it('opens the owned project workspace without exposing another owner or its sealed key', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${f.project.record.id}`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: f.project.record.id });
    expect(response.json()).not.toHaveProperty('wrappedKey');
    const foreign = await f.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${f.foreign.record.id}`
    });
    expect(foreign.statusCode).toBe(404);
  });
  it('meters every owner root and sums public aggregate storage once', async () => {
    const f = await fixture();
    const response = await f.app.inject({ method: 'GET', url: '/v1/usage' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ storageBytes: 42 });
    expect(f.metered.mock.calls.map(([row]) => row.id).sort()).toEqual(
      [f.parent.record.id, f.project.record.id].sort()
    );
    expect((await store.getWorkspace(f.other.id, f.foreign.record.id))?.storageBytes).toBe(30);
  });
  it('opens project tool events with their exact owner-scoped workspace key', async () => {
    const f = await fixture();
    const response = await f.app.inject({ method: 'GET', url: '/v1/usage/tool-opens' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tasksScanned: 2, turns: 2, unreadableCalls: 0 });
  });
  it('exports project prompts, events, plans and schedules exactly once under their namespace', async () => {
    const f = await fixture();
    const response = await f.app.inject({ method: 'GET', url: '/v1/privacy/export' });
    expect(response.statusCode).toBe(200);
    const exported = response.json<{
      taskContents: Array<{
        taskId: string;
        workspaceId: string;
        title: string;
        prompt: string;
        events: Array<{ summary: string }>;
      }>;
      taskPlanContents: Array<{ taskId: string; label: string }>;
      scheduleContents: Array<{ scheduleId: string; title: string; prompt: string }>;
    }>();
    expect(exported.taskContents).toHaveLength(2);
    expect(exported.taskContents.find((task) => task.taskId === f.project.task.id)).toMatchObject({
      workspaceId: f.project.record.id,
      title: 'Project title',
      prompt: 'Project prompt',
      events: [{ summary: 'Project event' }]
    });
    expect(new Set(exported.taskContents.map((task) => task.taskId)).size).toBe(2);
    expect(exported.taskPlanContents).toHaveLength(2);
    expect(exported.taskPlanContents).toContainEqual({
      taskId: f.project.task.id,
      label: 'Project plan'
    });
    expect(exported.scheduleContents).toEqual([
      {
        scheduleId: f.schedule.id,
        workspaceId: f.project.record.id,
        title: 'Project schedule',
        prompt: 'Project scheduled prompt'
      }
    ]);
    expect(response.body).not.toContain(f.foreign.task.id);
    const schedules = await f.app.inject({ method: 'GET', url: '/v1/schedules' });
    expect(schedules.statusCode).toBe(200);
    expect(schedules.json()).toEqual([
      {
        id: f.schedule.id,
        workspaceId: f.project.record.id,
        title: 'Project schedule',
        prompt: 'Project scheduled prompt',
        trigger: null,
        triggerUrlPath: null
      }
    ]);
  });
  it('cancels work and deletes every owner runner root before destroying the account keys', async () => {
    const f = await fixture(),
      deleted: string[] = [];
    f.runnerRequest.mockImplementation(async (input) => {
      const request = input as {
        workspaceId: string;
        userId: string;
        method: string;
        path: string;
      };
      expect(await store.getUserById(f.owner.id)).not.toBeNull();
      for (const task of [f.parent.task, f.project.task])
        expect((await store.getTask(f.owner.id, task.id))?.status).toBe('cancelled');
      expect(request).toMatchObject({
        userId: f.owner.id,
        method: 'DELETE',
        path: `/v1/workspaces/${request.workspaceId}`
      });
      expect((await store.getWorkspace(f.owner.id, request.workspaceId))?.status).toBe('deleting');
      deleted.push(request.workspaceId);
      return {};
    });
    const response = await f.remove();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deleted: true });
    expect(deleted).toEqual([f.project.record.id, f.parent.record.id]);
    expect(f.metered).toHaveBeenCalledTimes(2);
    expect(await store.getUserById(f.owner.id)).toBeNull();
    expect(await store.getTask(f.other.id, f.foreign.task.id)).not.toBeNull();
  });
  it('keeps the account and keys recoverable when a project runner refuses deletion', async () => {
    const f = await fixture();
    f.runnerRequest.mockRejectedValue(new Error('Project cleanup unavailable'));
    const response = await f.remove();
    expect(response.statusCode).toBe(500);
    expect(await store.getUserById(f.owner.id)).not.toBeNull();
    expect(await store.listWorkspaceMetadata(f.owner.id)).toHaveLength(2);
    expect(f.runnerRequest).toHaveBeenCalledTimes(1);
    expect((await store.getTask(f.owner.id, f.project.task.id))?.status).toBe('cancelled');
  });
});
