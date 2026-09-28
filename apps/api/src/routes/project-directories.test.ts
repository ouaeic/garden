import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectDirectory } from '@garden/contracts';
import type { RouteContext } from '../http/server-context.js';
import { registerProjectDirectoryRoutes } from './project-directories.js';

function fixture() {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = request.headers['x-owner']
      ? ({ id: request.headers['x-owner'] } as never)
      : null;
  });
  const raw = vi.fn(
    async () =>
      new Response('streamed bytes', {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="project.zip"'
        }
      })
  );
  registerProjectDirectoryRoutes({
    app,
    store: {
      projectExecutionMembers: async (user: string, task: string) =>
        user === 'owner' && task === 'branch'
          ? [
              { taskId: 'root', workspaceId: 'one' },
              { taskId: 'branch', workspaceId: 'two' },
              { taskId: 'continuation', workspaceId: 'two' }
            ]
          : [],
      getWorkspace: async (user: string, id: string) =>
        user === 'owner' && ['one', 'two'].includes(id) ? { id, name: `Computer ${id}` } : null
    },
    runner: { raw }
  } as unknown as RouteContext);
  return { app, raw };
}

describe('project directory access', () => {
  it('lists unique owned execution roots, with the current branch first', async () => {
    const { app } = fixture();
    try {
      const result = await app.inject({
        url: '/v1/tasks/branch/directories',
        headers: { 'x-owner': 'owner' }
      });
      expect(result.statusCode).toBe(200);
      expect(result.json<{ directories: ProjectDirectory[] }>().directories).toEqual([
        { workspaceId: 'two', name: 'Computer two', path: 'workspace', current: true },
        { workspaceId: 'one', name: 'Computer one', path: 'workspace', current: false }
      ]);
      expect(
        (await app.inject({ url: '/v1/tasks/branch/directories', headers: { 'x-owner': 'other' } }))
          .statusCode
      ).toBe(404);
      expect((await app.inject({ url: '/v1/tasks/branch/directories' })).statusCode).not.toBe(200);
    } finally {
      await app.close();
    }
  });
  it('forwards table cursors and stale-file errors only for the owning user', async () => {
    const { app, raw } = fixture();
    try {
      const url = '/v1/workspaces/two/table?path=workspace%2Fresults.csv&cursor=signed.cursor';
      raw.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Table changed' } }), {
          status: 409,
          headers: { 'content-type': 'application/json' }
        })
      );
      const result = await app.inject({ url, headers: { 'x-owner': 'owner' } });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toEqual({ error: { message: 'Table changed' } });
      expect(raw).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'two',
          userId: 'owner',
          role: 'user',
          scopes: ['files.read'],
          path: url
        })
      );
      expect((await app.inject({ url, headers: { 'x-owner': 'other' } })).statusCode).toBe(404);
      expect((await app.inject({ url })).statusCode).not.toBe(200);
      expect(raw).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('streams ZIP responses through a files-read capability, forwards errors and excludes unrelated roots', async () => {
    const { app, raw } = fixture();
    try {
      const result = await app.inject({
        url: '/v1/workspaces/two/directory.zip?path=workspace%2Fresults',
        headers: { 'x-owner': 'owner' }
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('streamed bytes');
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.headers['content-disposition']).toContain('project.zip');
      expect(raw).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'two',
          userId: 'owner',
          role: 'user',
          scopes: ['files.read'],
          path: '/v1/workspaces/two/directory.zip?path=workspace%2Fresults',
          acceptAnyStatus: true
        })
      );
      expect(
        (
          await app.inject({
            url: '/v1/workspaces/other/directory.zip',
            headers: { 'x-owner': 'owner' }
          })
        ).statusCode
      ).toBe(404);
      expect(raw).toHaveBeenCalledTimes(1);
      raw.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Directory changed' } }), {
          status: 409,
          headers: { 'content-type': 'application/json' }
        })
      );
      const stale = await app.inject({
        url: '/v1/workspaces/two/directory?path=workspace&cursor=next',
        headers: { 'x-owner': 'owner' }
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.body).toContain('Directory changed');
      expect(raw).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: '/v1/workspaces/two/directory?path=workspace&cursor=next' })
      );
    } finally {
      await app.close();
    }
  });
});
