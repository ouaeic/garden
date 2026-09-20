import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RouteContext } from '../http/server-context.js';
import { registerProjectUpdateRoutes } from './project-updates.js';

it('binds storage reads to the authenticated owner and canonical project working area', async () => {
  const app = Fastify(),
    ownerId = randomUUID(),
    projectId = randomUUID(),
    workspaceId = randomUUID();
  const request = vi.fn(async () => ({
    logicalBytes: 100,
    allocatedBytes: 4096,
    reclaimableBytes: null
  }));
  const getProject = vi.fn(async (owner: string, id: string) =>
    owner === ownerId && id === projectId ? { id, workspaceId } : null
  );
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = { id: ownerId } as typeof request.user;
  });
  registerProjectUpdateRoutes({
    app,
    store: { getProject, listProjectConversations: async () => ({ tasks: [], nextCursor: null }) },
    runner: { request }
  } as unknown as RouteContext);
  try {
    const response = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/storage` });
    expect(response.statusCode).toBe(200);
    expect(request).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      userId: ownerId,
      role: 'user',
      scopes: ['project.updates.read'],
      path: `/v1/workspaces/${workspaceId}/projects/${projectId}/storage`
    });
    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/projects/${randomUUID()}/storage`
    });
    expect(foreign.statusCode).not.toBe(200);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
