import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerProjectUpdateRoutes } from './project-updates.js';
import type { RouteContext } from '../http/server-context.js';

it('owns the project before sampling visible conversations and signs a read-only request', async () => {
  const app = Fastify(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    workspaceId = randomUUID();
  const runner = { request: vi.fn(async () => []) };
  const store = {
    getProject: async (user: string, id: string) =>
      user === 'owner' && id === projectId ? { id, workspaceId } : null,
    listProjectConversations: async () => ({
      tasks: [{ id: taskId, workspaceId }],
      nextCursor: null
    })
  };
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = request.headers['x-owner']
      ? ({ id: request.headers['x-owner'] } as never)
      : null;
  });
  registerProjectUpdateRoutes({ app, runner, store } as unknown as RouteContext);
  try {
    const route = `/v1/projects/${projectId}/changes?tasks=${taskId}`;
    for (const owner of ['', 'unrelated']) {
      expect(
        (await app.inject({ url: route, headers: { 'x-owner': owner } })).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(runner.request).not.toHaveBeenCalled();
    }
    const response = await app.inject({ url: route, headers: { 'x-owner': 'owner' } });
    expect(response.statusCode).toBe(200);
    expect(runner.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: 'user',
        userId: 'owner',
        workspaceId,
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspaceId}/projects/${projectId}/changes`,
        body: JSON.stringify([taskId])
      })
    );
    runner.request.mockClear();
    for (const tasks of [
      '',
      'not-a-uuid',
      Array.from({ length: 101 }, () => randomUUID()).join(',')
    ]) {
      expect(
        (
          await app.inject({
            url: `/v1/projects/${projectId}/changes?tasks=${tasks}`,
            headers: { 'x-owner': 'owner' }
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(runner.request).not.toHaveBeenCalled();
    }
  } finally {
    await app.close();
  }
});
