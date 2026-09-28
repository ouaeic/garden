import { registerWorkspaceRoutes } from './workspaces.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { encryptJson, decryptJson, wrapDataKey } from '@garden/core';
import type { RouteContext } from '../http/server-context.js';
import { registerCodingMissionRoutes } from './coding-missions.js';
import { registerTaskRoutes } from './tasks.js';

const key = Buffer.alloc(32, 3),
  master = Buffer.alloc(32, 8),
  sealed = encryptJson({ fixture: true }, key),
  digest = 'a'.repeat(64);
describe('owner coding mission controls', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
    store = new DataStore(database),
    apps: FastifyInstance[] = [];
  beforeAll(async () => migrateDatabase(database));
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await database.close();
  });
  const fixture = async () => {
    const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' }),
      workspaceId = randomUUID();
    const workspace = await store.createWorkspace({
      id: workspaceId,
      userId: user.id,
      name: 'Parent',
      storageLimitBytes: 1e9,
      imageRevision: 'test',
      region: 'local',
      wrappedKey: wrapDataKey(key, master, workspaceId)
    });
    await store.updateWorkspaceStatus(workspace.id, 'running');
    const parent = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: sealed,
      nameIndex: { nameTokens: '', openingTokens: '' },
      promptCiphertext: sealed,
      modelId: 'model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1
    });
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [parent.id]
    );
    const childWorkspaceId = randomUUID(),
      missionId = randomUUID();
    const mission = await store.createCodingMission({
      id: missionId,
      userId: user.id,
      parentTaskId: parent.id,
      workerId: 'worker',
      requestKey: missionId,
      requestHash: 'hash',
      allocatedCredits: 0.4,
      manifestCiphertext: encryptJson(
        {
          name: 'Parser',
          instruction: 'Implement parser',
          sourceRoot: 'workspace',
          outputPaths: ['src'],
          maxComputeCredits: 0.4
        },
        key
      ),
      workspace: {
        id: childWorkspaceId,
        userId: user.id,
        name: 'Child',
        storageLimitBytes: 1e9,
        imageRevision: 'test',
        region: 'local',
        wrappedKey: wrapDataKey(key, master, childWorkspaceId)
      },
      task: {
        userId: user.id,
        workspaceId: childWorkspaceId,
        titleCiphertext: sealed,
        nameIndex: { nameTokens: '', openingTokens: '' },
        promptCiphertext: sealed,
        modelId: 'model',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 0.4
      }
    });
    await store.activateCodingMission(user.id, mission.id, 1);
    const runner = {
      request: vi.fn(async (input: { path: string; body?: string }): Promise<unknown> => {
        if (input.path.endsWith('/review'))
          return {
            digest,
            changes: [
              {
                path: 'src/app.ts',
                kind: 'modified',
                bytes: 5,
                baseHash: 'base',
                resultHash: 'result',
                conflict: false,
                permitted: true,
                diff: '-old\n+new',
                binary: false,
                diffOmitted: false
              }
            ],
            canIntegrate: true,
            detail: 'Review'
          };
        return { integrated: true };
      })
    };
    const app = Fastify();
    apps.push(app);
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      request.user = {
        id: request.headers['x-test-other'] ? randomUUID() : user.id
      } as typeof request.user;
    });
    const context = {
      app,
      store,
      database,
      runner,
      masterKey: master,
      privateTaskResponse: async (value: unknown) => value,
      meterWorkspace: async () => {},
      requireRecentStepUp: async () => {},
      resolveSpendCeiling: async () => null,
      assertSpendCeilingAllowed: async () => {},
      modelsForUser: async () => [],
      idempotent: async (_a: unknown, _b: unknown, _c: unknown, fn: () => unknown) => fn()
    } as unknown as RouteContext;
    registerCodingMissionRoutes(context);
    registerTaskRoutes(context);
    registerWorkspaceRoutes(context);
    return { user, parent, mission, runner, app, workspace };
  };
  it('keeps mission bodies owner-scoped and records an inspectable native review', async () => {
    const f = await fixture();
    expect(
      (
        await f.app.inject({
          url: `/v1/tasks/${f.parent.id}/coding-missions`,
          headers: { 'x-test-other': 'yes' }
        })
      ).statusCode
    ).not.toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/v1/coding-missions/${f.mission.id}/review`,
          headers: { 'x-test-other': 'yes' }
        })
      ).statusCode
    ).not.toBe(200);
    expect(f.runner.request).not.toHaveBeenCalled();
    const response = await f.app.inject({
      method: 'POST',
      url: `/v1/coding-missions/${f.mission.id}/review`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      canIntegrate: false,
      changes: [{ diff: '-old\n+new' }]
    });
    expect((await store.getCodingMission(f.user.id, f.mission.id))?.reviewDigest).toBe(digest);
  });
  it('requires idle completed parent review and reconciles a lost integration reply exactly once', async () => {
    const f = await fixture();
    await store.updateTask({ id: f.mission.childTaskId, status: 'completed' });
    await f.app.inject({ method: 'POST', url: `/v1/coding-missions/${f.mission.id}/review` });
    const payload = { generation: 1, digest };
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/v1/coding-missions/${f.mission.id}/integrate`,
          payload
        })
      ).statusCode
    ).not.toBe(200);
    expect(
      f.runner.request.mock.calls.filter(([call]) => call.path.endsWith('/integrate'))
    ).toHaveLength(0);
    await store.updateTask({ id: f.parent.id, status: 'completed' });
    f.runner.request.mockImplementation(async ({ path }) => {
      if (path.endsWith('/integrate')) throw new Error('Reply lost');
      return { phase: 'integrated', generation: 1, digest };
    });
    const result = await f.app.inject({
      method: 'POST',
      url: `/v1/coding-missions/${f.mission.id}/integrate`,
      payload
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ mission: { state: 'integrated' } });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/v1/coding-missions/${f.mission.id}/integrate`,
          payload
        })
      ).statusCode
    ).toBe(200);
    expect(
      f.runner.request.mock.calls.filter(([call]) => call.path.endsWith('/integrate'))
    ).toHaveLength(1);
  });
  it('holds deletion until native child cleanup succeeds and rejects independent child deletion', async () => {
    const f = await fixture();
    await store.updateTask({ id: f.parent.id, status: 'paused' });
    await store.updateTask({ id: f.mission.childTaskId, status: 'paused' });
    expect(
      (await f.app.inject({ method: 'DELETE', url: `/v1/tasks/${f.mission.childTaskId}` }))
        .statusCode
    ).not.toBe(200);
    f.runner.request.mockImplementation(async () => {
      throw new Error('Runner unavailable');
    });
    expect(
      (await f.app.inject({ method: 'DELETE', url: `/v1/tasks/${f.parent.id}` })).statusCode
    ).not.toBe(200);
    expect(await store.getTask(f.user.id, f.parent.id)).not.toBeNull();
    f.runner.request.mockImplementation(async () => ({ cancelled: true, removed: true }));
    expect(
      (await f.app.inject({ method: 'DELETE', url: `/v1/tasks/${f.parent.id}` })).statusCode
    ).toBe(200);
    expect(f.runner.request.mock.calls.some(([call]) => call.path.endsWith('/remove'))).toBe(true);
    expect(await store.getTask(f.user.id, f.mission.childTaskId)).toBeNull();
    expect(await store.getWorkspace(f.user.id, f.mission.childWorkspaceId)).toBeNull();
  });
  it('accepts only a question reply without new budget, model, attachment or scope fields', async () => {
    const f = await fixture(),
      aad = `task-state:${f.mission.childTaskId}`;
    await store.updateTask({
      id: f.mission.childTaskId,
      status: 'awaiting_user',
      agentStateCiphertext: encryptJson(
        {
          messages: [{ role: 'user', content: 'Implement parser' }],
          credits: 0.1,
          question: { question: 'Which encoding?', askedAtStep: 4 },
          step: 4
        },
        key,
        aad
      )
    });
    const url = `/v1/tasks/${f.mission.childTaskId}/messages`;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          payload: { prompt: 'Use UTF8', modelId: 'other' }
        })
      ).statusCode
    ).not.toBe(200);
    expect(
      (await f.app.inject({ method: 'POST', url, payload: { prompt: 'Use UTF8' } })).statusCode
    ).toBe(200);
    const child = (await store.getTask(f.user.id, f.mission.childTaskId))!;
    expect(child).toMatchObject({
      status: 'queued',
      modelId: 'model',
      maxComputeCredits: 0.4,
      queuedMessageCount: 0
    });
    expect(decryptJson(child.agentStateCiphertext!, key)).not.toHaveProperty('question');
    expect(decryptJson(child.agentStateCiphertext!, key)).toMatchObject({
      credits: 0.1,
      step: 4,
      messages: [
        { role: 'user', content: 'Implement parser' },
        { role: 'user', content: 'Use UTF8' }
      ]
    });
    expect(
      (await f.app.inject({ method: 'POST', url, payload: { prompt: 'And new work' } })).statusCode
    ).not.toBe(200);
  });
  it('withdraws the parent and all child runtimes before a workspace deletion cascades', async () => {
    const f = await fixture();
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/v1/workspaces/${f.mission.childWorkspaceId}`,
          payload: { confirmName: 'Child' }
        })
      ).statusCode
    ).not.toBe(200);
    const response = await f.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${f.workspace.id}`,
      payload: { confirmName: 'Parent' }
    });
    expect(response.statusCode).toBe(200);
    const paths = f.runner.request.mock.calls.map(([call]) => call.path);
    expect(paths.findIndex((path) => path.endsWith('/remove'))).toBeGreaterThanOrEqual(0);
    expect(paths.findIndex((path) => path === `/v1/workspaces/${f.workspace.id}`)).toBeGreaterThan(
      paths.findIndex((path) => path.endsWith('/remove'))
    );
    expect(await store.getTask(f.user.id, f.mission.childTaskId)).toBeNull();
  });
});
