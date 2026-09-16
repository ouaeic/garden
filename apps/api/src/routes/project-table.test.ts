import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { RouteContext } from '../http/server-context.js';
import { registerProjectUpdateRoutes } from './project-updates.js';

it('binds version and check table views to their owned project and forwards cursors', async () => {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = { id: request.headers['x-owner'] ?? 'owner' } as never;
  });
  const id = '00000000-0000-4000-8000-000000000001';
  const raw = vi.fn(async () => Response.json({ rows: [], nextCursor: null }));
  registerProjectUpdateRoutes({
    app,
    store: {
      getProject: async (user: string, project: string) =>
        user === 'owner' && project === id ? { id, workspaceId: 'execution' } : null,
      listProjectConversations: async () => ({ tasks: [], nextCursor: null })
    },
    runner: { raw }
  } as unknown as RouteContext);
  try {
    for (const source of [`versions/${id}`, `checks/${id}/${id}`]) {
      const query = '?path=workspace%2Fresults.csv&cursor=signed.cursor';
      const url = `/v1/projects/${id}/${source}/table${query}`;
      expect((await app.inject({ url })).statusCode).toBe(200);
      expect(raw).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaceId: 'execution',
          userId: 'owner',
          role: 'user',
          scopes: ['files.read'],
          path: `/v1/workspaces/execution/projects/${id}/${source}/table${query}`
        })
      );
      expect((await app.inject({ url, headers: { 'x-owner': 'other' } })).statusCode).toBe(404);
    }
    expect(raw).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
  }
});
