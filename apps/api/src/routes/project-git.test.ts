import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { AthanorError, encryptJson } from '@athanor/core';
import type { ConnectorScope } from '@athanor/contracts';
import type { RouteContext } from '../http/server-context.js';
import { registerProjectGitRoutes } from './project-git.js';

it('keeps owner Git requests scoped to enabled grants and sends credentials only to the runner', async () => {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = { id: request.headers['x-owner'] ?? 'owner' } as never;
  });
  const projectId = randomUUID(),
    connectorId = randomUUID(),
    masterKey = Buffer.alloc(32, 7);
  let enabled = true,
    scopes: ConnectorScope[] = ['github:repository.read'];
  const forward = vi.fn(async () => ({ state: 'running' })),
    audit = vi.fn(async () => {});
  registerProjectGitRoutes(
    {
      app,
      masterKey,
      store: {
        getConnector: async (owner: string, id: string) =>
          owner === 'owner' && id === connectorId
            ? {
                id,
                enabled,
                scopes,
                kind: 'github',
                baseUrl: 'https://api.github.com',
                secretCiphertext: encryptJson(
                  { token: 'credential-canary' },
                  masterKey,
                  `connector:${owner}:${id}`
                )
              }
            : null,
        recordConnectorAudit: audit
      },
      runner: { request: forward },
      connectorAllowedHosts: () => [],
      idempotent: async (
        _request: unknown,
        _reply: unknown,
        _user: unknown,
        action: () => Promise<unknown>
      ) => action()
    } as unknown as RouteContext,
    async (owner, id) => {
      if (owner !== 'owner' || id !== projectId)
        throw new AthanorError('project_not_found', 'Project not found', 404);
      return { id, workspaceId: randomUUID() };
    }
  );
  const operation = {
    action: 'github_git_push',
    repositoryId: randomUUID(),
    revisionId: randomUUID(),
    requestId: randomUUID(),
    owner: 'fixture',
    repository: 'source',
    branch: 'main',
    commit: 'a'.repeat(40),
    expectedHead: null
  };
  const request = {
    method: 'POST' as const,
    url: `/v1/projects/${projectId}/git-remote`,
    payload: { connectorId, operation }
  };
  try {
    expect((await app.inject(request)).statusCode).not.toBe(200);
    scopes = ['github:repository.read', 'github:repository.write'];
    enabled = false;
    expect((await app.inject(request)).statusCode).toBe(404);
    enabled = true;
    expect((await app.inject({ ...request, headers: { 'x-owner': 'other' } })).statusCode).toBe(
      404
    );
    expect(forward).not.toHaveBeenCalled();
    const response = await app.inject(request);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain('credential-canary');
    expect(forward).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        scopes: ['project.git.push'],
        body: expect.stringContaining('credential-canary') as unknown
      })
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('credential-canary');
  } finally {
    await app.close();
  }
});
