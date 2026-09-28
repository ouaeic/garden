import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import { authenticateRunnerRequest } from './auth.js';
import { ensureWorkspace } from './files.js';
import { ProjectUpdatesManager } from './project-updates.js';
import { registerProjectGitRemoteRoutes } from './project-git-remote-routes.js';

it('binds transport access to the signed project, actor, action and published commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-git-route-'));
  const manager = new ProjectUpdatesManager(root, {
    start: async () => ({ sessionId: 'unused' }),
    poll: () => {
      throw Error('No process');
    },
    stop: () => {}
  });
  const project = randomUUID(),
    main = randomUUID(),
    task = randomUUID(),
    workspace = randomUUID(),
    sibling = randomUUID(),
    siblingWorkspace = randomUUID();
  const app = Fastify(),
    secret = 's'.repeat(32);
  app.addHook('preHandler', authenticateRunnerRequest(secret));
  registerProjectGitRemoteRoutes(app, manager);
  try {
    await ensureWorkspace(path.join(root, workspace));
    await manager.bind(project, main, task, workspace);
    await manager.bind(project, main, sibling, siblingWorkspace);
    await writeFile(path.join(root, workspace, 'workspace/source.txt'), 'published source');
    const proposed = await manager.prepare(project, task, {
      title: 'Source',
      paths: ['source.txt']
    });
    await manager.settle(proposed.id);
    const ready = await manager.inspect(project, proposed.id);
    const version = await manager.publish(
      project,
      ready.id,
      ready.candidateDigest!,
      'Owner inspected this fixture'
    );
    const repository = await manager.createRepository(project, {
      requestId: randomUUID(),
      revisionId: version.id,
      name: 'Source',
      path: ''
    });
    const service = manager.gitRemotes(project);
    let remoteHead: string | null = null;
    const push = vi.fn(async (commit: string) => {
      remoteHead = commit;
    });
    vi.spyOn(service, 'transport').mockReturnValue({
      head: async () => remoteHead,
      fetch: async () => {},
      push
    });
    const invoke = (
      role: 'agent' | 'user' | 'control',
      workspaceId: string,
      sub: string,
      scope: string,
      payload: Record<string, unknown>
    ) => {
      const url = `/v1/workspaces/${workspaceId}/projects/${project}/git-remote`;
      const token = signCapabilityToken(
        {
          role,
          workspaceId,
          sub,
          scopes: [scope],
          nonce: randomUUID(),
          aud: capabilityAudience('POST', url)
        },
        secret,
        60
      );
      return app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token}` },
        payload
      });
    };
    const input = {
      action: 'push',
      requestId: randomUUID(),
      repositoryId: repository.id,
      revisionId: version.id,
      connectorId: randomUUID(),
      owner: 'fixture',
      repository: 'source',
      branch: 'main',
      commit: repository.head,
      expectedHead: null
    };
    const body = { action: 'start', input, credential: 'fixture-token' };
    expect((await invoke('agent', workspace, task, 'project.git.read', body)).statusCode).not.toBe(
      200
    );
    expect(
      (await invoke('agent', siblingWorkspace, task, 'project.git.push', body)).statusCode
    ).not.toBe(200);
    expect((await invoke('control', main, task, 'project.git.push', body)).statusCode).not.toBe(
      200
    );
    expect(
      (await invoke('agent', workspace, task, 'project.git.push', { ...body, taskId: sibling }))
        .statusCode
    ).not.toBe(200);
    expect(
      (
        await invoke('agent', workspace, task, 'project.git.push', {
          ...body,
          input: { ...input, commit: 'a'.repeat(40) }
        })
      ).statusCode
    ).not.toBe(200);
    expect(push).not.toHaveBeenCalled();
    const result = await invoke('agent', workspace, task, 'project.git.push', body);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ taskId: task, workspaceId: workspace, input });
    expect(result.body).not.toContain('fixture-token');
    await Promise.all(service.running.values());
    expect(push).toHaveBeenCalledExactlyOnceWith(repository.head, null);
    const status = {
      action: 'status',
      requestId: input.requestId,
      connectorId: input.connectorId,
      credential: 'fixture-token'
    };
    expect(
      (await invoke('agent', siblingWorkspace, sibling, 'project.git.read', status)).statusCode
    ).not.toBe(200);
    expect((await invoke('user', main, task, 'project.git.read', status)).json()).toMatchObject({
      state: 'succeeded'
    });
    expect(push).toHaveBeenCalledOnce();
  } finally {
    await app.close();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
