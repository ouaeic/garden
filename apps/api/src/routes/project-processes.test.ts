import Fastify from 'fastify';
import type { ProcessList } from '@athanor/contracts';
import { describe, expect, it, vi } from 'vitest';
import { registerProjectProcessRoutes } from './project-processes.js';
import type { RouteContext } from '../http/server-context.js';

async function fixture() {
  const app = Fastify();
  const members = [
    { taskId: 'root', workspaceId: 'one' },
    { taskId: 'branch', workspaceId: 'two' }
  ];
  const store = {
    getWorkspace: vi.fn(async (user: string, id: string) =>
      user === 'owner' && id === 'one' ? { id } : null
    ),
    projectExecutionMembers: vi.fn(async (user: string, task: string) =>
      user === 'owner' && ['root', 'branch'].includes(task) ? members : []
    )
  };
  const runner = {
    request: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
      processes: [
        { sessionId: `job-${workspaceId}`, ownerTaskId: workspaceId === 'one' ? 'root' : 'branch' },
        { sessionId: 'unrelated', ownerTaskId: 'other-task' }
      ],
      refreshAfterMs: 120_000,
      resourcesAvailable: true
    }))
  };
  app.decorateRequest('user', null);
  app.decorateRequest('apiToken', null);
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-api-token']) request.apiToken = {} as never;
    request.user = request.headers['x-owner']
      ? ({ id: request.headers['x-owner'] } as never)
      : null;
  });
  registerProjectProcessRoutes({ app, store, runner } as unknown as RouteContext);
  return { app, store, runner };
}

describe('project process scope', () => {
  it('collects owned branches across execution roots and excludes unrelated tasks sharing a workspace', async () => {
    const { app, store, runner } = await fixture();
    try {
      const response = await app.inject({
        url: '/v1/tasks/branch/processes',
        headers: { 'x-owner': 'owner' }
      });
      expect(response.statusCode).toBe(200);
      expect(store.projectExecutionMembers).toHaveBeenCalledWith('owner', 'branch', 'task');
      expect(response.json<ProcessList>().processes).toEqual(
        expect.arrayContaining([
          { sessionId: 'job-one', ownerTaskId: 'root', workspaceId: 'one' },
          { sessionId: 'job-two', ownerTaskId: 'branch', workspaceId: 'two' }
        ])
      );
      expect(response.json<ProcessList>().processes).toHaveLength(2);
      expect(runner.request).toHaveBeenCalledTimes(2);
      expect(runner.request).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          userId: 'owner',
          scopes: ['exec'],
          path: '/v1/workspaces/one/processes'
        })
      );
    } finally {
      await app.close();
    }
  });
  it.each([
    { user: '', task: 'root' },
    { user: 'other', task: 'root' },
    { user: 'owner', task: 'missing' }
  ])(
    'refuses an unowned or unknown project before contacting the runner (%s)',
    async ({ user, task }) => {
      const { app, runner } = await fixture();
      try {
        const response = await app.inject({
          url: `/v1/tasks/${task}/processes`,
          headers: { 'x-owner': user }
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(runner.request).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );
  it('retains reachable results and explicitly reports a partial list', async () => {
    const { app, runner } = await fixture();
    runner.request.mockRejectedValueOnce(new Error('offline'));
    try {
      const response = await app.inject({
        url: '/v1/tasks/root/processes',
        headers: { 'x-owner': 'owner' }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<ProcessList>().unavailableWorkspaces).toBe(1);
      expect(response.json<ProcessList>().note).toContain('incomplete');
      expect(response.json<ProcessList>().processes).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
  it('does not turn an unavailable runner into an empty successful list', async () => {
    const { app, runner } = await fixture();
    runner.request.mockRejectedValue(new Error('offline'));
    try {
      const response = await app.inject({
        url: '/v1/tasks/root/processes',
        headers: { 'x-owner': 'owner' }
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.json<ProcessList>()).not.toHaveProperty('processes');
    } finally {
      await app.close();
    }
  });
  it('resumes only owned workflows from signed-in devices and preserves the displayed attempt', async () => {
    const { app, runner } = await fixture(),
      workflowId = '10000000-0000-4000-8000-000000000001';
    try {
      for (const headers of [
        {},
        { 'x-owner': 'other' },
        { 'x-owner': 'owner', 'x-api-token': 'token' }
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/workspaces/one/workflows/${workflowId}/resume`,
          headers,
          payload: { attempt: 2 }
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(runner.request).not.toHaveBeenCalled();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/one/workflows/${workflowId}/resume`,
        headers: { 'x-owner': 'owner' },
        payload: { attempt: 2 }
      });
      expect(response.statusCode).toBe(200);
      expect(runner.request).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'one',
          role: 'user',
          path: `/v1/workspaces/one/workflows/${workflowId}/resume`,
          body: '{"attempt":2}'
        })
      );
      const forged = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/one/workflows/${workflowId}/resume`,
        headers: { 'x-owner': 'owner' },
        payload: { attempt: 2, parameters: { other: true } }
      });
      expect(forged.statusCode).toBeGreaterThanOrEqual(400);
      expect(runner.request).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
