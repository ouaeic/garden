import type { ProjectSessions } from '@athanor/contracts';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerProjectSessionRoutes } from './project-sessions.js';
import type { RouteContext } from '../http/server-context.js';

it('lists only owned isolated project computers, tolerates an unavailable runner, and never starts one', async () => {
  const app = Fastify();
  const members = [
    { taskId: 'a', workspaceId: 'one' },
    { taskId: 'b', workspaceId: 'shared' },
    { taskId: 'c', workspaceId: 'offline' }
  ];
  const runner = {
    request: vi.fn(async ({ workspaceId, path }: { workspaceId: string; path: string }) => {
      expect(path).toBe(`/v1/workspaces/${workspaceId}/computer-sessions`);
      if (workspaceId === 'offline') throw new Error('offline');
      return {
        browser: { holder: 'agent', tabs: [{ tabId: 'tab-1', title: 'Project A' }] },
        desktop: null
      };
    })
  };
  const context = {
    app,
    runner,
    store: {
      getProject: async (owner: string, id: string) =>
        owner === 'owner' && id === 'project-a' ? { id } : null,
      projectExecutionMembers: async () => members,
      getTask: async (_owner: string, id: string) => ({
        id,
        workspaceId: members.find((m) => m.taskId === id)?.workspaceId
      }),
      getWorkspace: async () => ({ id: 'one' })
    },
    database: {
      query: async (_sql: string, values: string[]) => ({
        rows: values[0] === 'shared' ? [{ found: 1 }] : []
      })
    },
    privateTaskResponse: async () => ({ title: 'Project A conversation' })
  } as unknown as RouteContext;
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = { id: 'owner' } as never;
  });
  registerProjectSessionRoutes(context);
  try {
    const result = await app.inject('/v1/projects/project-a/sessions');
    expect(result.statusCode).toBe(200);
    expect(result.json<ProjectSessions>().sessions).toHaveLength(1);
    expect(result.json<ProjectSessions>().sessions[0]).toMatchObject({
      workspaceId: 'one',
      taskId: 'a',
      browser: { tabs: [{ title: 'Project A' }] }
    });
    expect(result.json<ProjectSessions>().unavailableWorkspaces).toBe(2);
    expect(runner.request).toHaveBeenCalledTimes(2);
    expect(runner.request.mock.calls.some(([input]) => input.workspaceId === 'shared')).toBe(false);
    runner.request.mockClear();
    expect((await app.inject('/v1/projects/project-b/sessions')).statusCode).toBe(404);
    expect(runner.request).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
