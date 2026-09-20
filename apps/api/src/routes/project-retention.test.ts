import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { RouteContext } from '../http/server-context.js';
import { registerProjectUpdateRoutes } from './project-updates.js';

it('binds archive previews and mutations to the owner and preserves exact retry identity', async () => {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = { id: request.headers['x-owner'] ?? 'owner' } as never;
  });
  const project = '00000000-0000-4000-8000-000000000001';
  const version = '00000000-0000-4000-8000-000000000002';
  const requestId = '00000000-0000-4000-8000-000000000003';
  const invoke = vi.fn(async () => ({ completed: true }));
  const idempotent = vi.fn(
    async (_request: unknown, _reply: unknown, _user: unknown, action: () => Promise<unknown>) =>
      action()
  );
  registerProjectUpdateRoutes({
    app,
    store: {
      getProject: async (owner: string, id: string) =>
        owner === 'owner' && id === project ? { id, workspaceId: 'execution' } : null,
      listProjectConversations: async () => ({ tasks: [], nextCursor: null })
    },
    runner: { request: invoke },
    idempotent
  } as unknown as RouteContext);
  const input = { versions: [version], digest: 'a'.repeat(64), requestId };
  try {
    const cases = [
      { action: 'preview', payload: { versions: [version] }, scope: 'project.updates.read' },
      { action: 'archive', payload: input, scope: 'project.updates.write' },
      {
        action: 'restore',
        payload: { revisionId: version, requestId },
        scope: 'project.updates.write'
      }
    ];
    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) {
      const url = `/v1/projects/${project}/retention/${item.action}`;
      expect((await app.inject({ method: 'POST', url, payload: item.payload })).statusCode).toBe(
        200
      );
      expect(invoke).toHaveBeenLastCalledWith(
        expect.objectContaining({
          role: 'user',
          scopes: [item.scope],
          body: JSON.stringify(item.payload),
          path: `/v1/workspaces/execution/projects/${project}/retention/${item.action}`
        })
      );
      const calls = invoke.mock.calls.length;
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: item.payload,
            headers: { 'x-owner': 'foreign' }
          })
        ).statusCode
      ).toBe(404);
      expect(
        (await app.inject({ method: 'POST', url, payload: { ...item.payload, deleteAll: true } }))
          .statusCode
      ).not.toBe(200);
      expect(invoke).toHaveBeenCalledTimes(calls);
    }
    expect(idempotent).toHaveBeenCalledTimes(2);
    const url = `/v1/projects/${project}/retention/archive`;
    expect(
      (await app.inject({ method: 'POST', url, payload: { ...input, digest: 'wrong' } })).statusCode
    ).not.toBe(200);
  } finally {
    await app.close();
  }
});
