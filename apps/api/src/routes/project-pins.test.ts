import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../http/server-context.js';
import { registerProjectUpdateRoutes } from './project-updates.js';

describe('project-owner version pin controls', () => {
  it('checks ownership before forwarding, validates inputs and uses the mutation receipt boundary', async () => {
    const app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      request.user = { id: request.headers['x-owner'] ?? 'owner' } as never;
    });
    const project = '00000000-0000-4000-8000-000000000001';
    const revision = '00000000-0000-4000-8000-000000000002';
    const invoke = vi.fn(async () => ({ id: revision, pin: { label: 'Analysis' } }));
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
    const url = `/v1/projects/${project}/versions/${revision}/pin`;
    try {
      expect(
        (await app.inject({ method: 'PUT', url, payload: { label: ' Analysis ' } })).statusCode
      ).toBe(200);
      expect(idempotent).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspaceId: 'execution',
          userId: 'owner',
          role: 'user',
          scopes: ['project.updates.write'],
          method: 'PUT',
          path: `/v1/workspaces/execution/projects/${project}/versions/${revision}/pin`,
          body: JSON.stringify({ label: 'Analysis' })
        })
      );
      expect((await app.inject({ method: 'PUT', url, payload: { label: null } })).statusCode).toBe(
        200
      );
      expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ body: '{"label":null}' }));
      const cursor = `0000000000000041_${revision}.json`;
      expect(
        (await app.inject({ url: `/v1/projects/${project}/pinned-versions?before=${cursor}` }))
          .statusCode
      ).toBe(200);
      expect(invoke).toHaveBeenLastCalledWith(
        expect.objectContaining({
          role: 'user',
          scopes: ['project.updates.read'],
          path: `/v1/workspaces/execution/projects/${project}/pinned-versions?before=${cursor}`
        })
      );
      const calls = invoke.mock.calls.length;
      expect(
        (
          await app.inject({
            method: 'PUT',
            url,
            headers: { 'x-owner': 'other' },
            payload: { label: 'No' }
          })
        ).statusCode
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: `/v1/projects/${project}/pinned-versions`,
            headers: { 'x-owner': 'other' }
          })
        ).statusCode
      ).toBe(404);
      expect(
        (await app.inject({ method: 'PUT', url, payload: { label: 'x'.repeat(121) } })).statusCode
      ).not.toBe(200);
      expect(
        (await app.inject({ method: 'PUT', url, payload: { label: 'No', deleteFiles: true } }))
          .statusCode
      ).not.toBe(200);
      expect(
        (await app.inject({ url: `/v1/projects/${project}/pinned-versions?before=..%2Fother` }))
          .statusCode
      ).not.toBe(200);
      expect(invoke).toHaveBeenCalledTimes(calls);
    } finally {
      await app.close();
    }
  });
});
