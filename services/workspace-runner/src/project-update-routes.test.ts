import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@athanor/core';
import { ProjectStorageUsage } from '@athanor/contracts';
import { authenticateRunnerRequest } from './auth.js';
import { ensureWorkspace } from './files.js';
import { ProjectUpdatesManager } from './project-updates.js';
import { registerProjectUpdateRoutes } from './project-update-routes.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
it('binds project reads and mutations to signed membership and keeps unchecked publication owner-only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'project-route-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = randomUUID(),
    main = randomUUID(),
    a = randomUUID(),
    b = randomUUID(),
    wa = randomUUID(),
    wb = randomUUID();
  await ensureWorkspace(path.join(root, wa));
  await ensureWorkspace(path.join(root, wb));
  await writeFile(path.join(root, wa, 'workspace/result.txt'), 'versioned result');
  await writeFile(path.join(root, wa, 'workspace/results.csv'), 'sample,value\nA,7\n');
  const manager = new ProjectUpdatesManager(root, {
    start: async () => ({ sessionId: 'unused' }),
    poll: () => {
      throw Error('No job');
    },
    stop: () => {}
  });
  await manager.bind(project, main, a, wa);
  await manager.bind(project, main, b, wb);
  const update = await manager.prepare(project, a, {
    title: 'Result',
    paths: ['result.txt', 'results.csv']
  });
  await manager.settle(update.id);
  const prepared = await manager.inspect(project, update.id);
  const app = Fastify();
  cleanup.unshift(() => app.close());
  const secret = 's'.repeat(32);
  app.addHook('preHandler', authenticateRunnerRequest(secret));
  registerProjectUpdateRoutes(app, manager);
  cleanup.unshift(() => manager.close());
  const changeCounts = async (
    role: 'agent' | 'user',
    workspaceId: string,
    scope: string,
    ids: string[]
  ) => {
    const url = `/v1/workspaces/${workspaceId}/projects/${project}/changes`;
    const token = signCapabilityToken(
      {
        workspaceId,
        sub: a,
        role,
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
      payload: ids
    });
  };
  expect((await changeCounts('user', main, 'files.read', [a, b])).statusCode).toBe(200);
  expect((await changeCounts('user', wa, 'files.read', [a])).statusCode).not.toBe(200);
  expect((await changeCounts('agent', wa, 'files.read', [a])).statusCode).not.toBe(200);
  expect((await changeCounts('user', main, 'project.updates.read', [a])).statusCode).not.toBe(200);
  expect((await changeCounts('user', main, 'files.read', [randomUUID()])).statusCode).not.toBe(200);
  const invoke = (
    role: 'agent' | 'user' | 'control',
    workspaceId: string,
    sub: string,
    scope: string,
    operation: unknown
  ) => {
    const url = `/v1/workspaces/${workspaceId}/projects/${project}/updates`;
    const token = signCapabilityToken(
      {
        workspaceId,
        sub,
        role,
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
      payload: { operation }
    });
  };
  expect(
    (await invoke('agent', wa, a, 'project.updates.read', { action: 'status' })).statusCode
  ).toBe(200);
  expect(
    (await invoke('agent', wa, b, 'project.updates.read', { action: 'status' })).statusCode
  ).not.toBe(200);
  expect(
    (
      await invoke('agent', wb, b, 'project.updates.write', {
        action: 'cancel',
        updateId: update.id
      })
    ).statusCode
  ).not.toBe(200);
  expect(
    (
      await invoke('agent', wa, a, 'project.updates.read', {
        action: 'cancel',
        updateId: update.id
      })
    ).statusCode
  ).not.toBe(200);
  const publish = {
    action: 'publish',
    updateId: update.id,
    digest: prepared.candidateDigest,
    uncheckedReason: 'Owner reviewed the output'
  };
  expect((await invoke('agent', wa, a, 'project.updates.write', publish)).statusCode).not.toBe(200);
  expect((await invoke('user', wb, a, 'project.updates.write', publish)).statusCode).not.toBe(200);
  const published = await invoke('user', main, a, 'project.updates.write', publish);
  expect(published.statusCode).toBe(200);
  const storage = async (role: 'user' | 'agent', workspaceId: string, scope: string) => {
    const url = `/v1/workspaces/${workspaceId}/projects/${project}/storage`;
    const token = signCapabilityToken(
      {
        workspaceId,
        sub: a,
        role,
        scopes: [scope],
        nonce: randomUUID(),
        aud: capabilityAudience('GET', url)
      },
      secret,
      60
    );
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  };
  const usage = await storage('user', main, 'project.updates.read');
  expect(usage.statusCode).toBe(200);
  const measured = ProjectStorageUsage.parse(usage.json());
  expect(measured.fileReferences).toBeGreaterThan(0);
  expect(measured.sharedCopies).toBeGreaterThan(0);
  expect(measured.reclaimableBytes).toBeNull();
  expect((await storage('agent', wa, 'project.updates.read')).statusCode).not.toBe(200);
  expect((await storage('user', wa, 'project.updates.read')).statusCode).not.toBe(200);
  expect((await storage('user', main, 'files.read')).statusCode).not.toBe(200);
  const revision = published.json<{ id: string }>();
  const pin = (
    role: 'agent' | 'user',
    workspaceId: string,
    scope: string,
    label: string | null
  ) => {
    const pinUrl = `/v1/workspaces/${workspaceId}/projects/${project}/versions/${revision.id}/pin`;
    const token = signCapabilityToken(
      {
        workspaceId,
        sub: a,
        role,
        scopes: [scope],
        nonce: randomUUID(),
        aud: capabilityAudience('PUT', pinUrl)
      },
      secret,
      60
    );
    return app.inject({
      method: 'PUT',
      url: pinUrl,
      headers: { authorization: `Bearer ${token}` },
      payload: { label }
    });
  };
  expect((await pin('agent', wa, 'project.updates.write', 'No')).statusCode).not.toBe(200);
  expect((await pin('user', wb, 'project.updates.write', 'No')).statusCode).not.toBe(200);
  expect((await pin('user', main, 'project.updates.read', 'No')).statusCode).not.toBe(200);
  expect((await manager.pinnedVersions(project)).revisions).toEqual([]);
  const pinned = await pin('user', main, 'project.updates.write', 'Protected result');
  expect(pinned.statusCode).toBe(200);
  expect(pinned.json()).toMatchObject({ id: revision.id, pin: { label: 'Protected result' } });
  const pinsUrl = `/v1/workspaces/${main}/projects/${project}/pinned-versions`;
  const pinRead = signCapabilityToken(
    {
      workspaceId: main,
      sub: a,
      role: 'user',
      scopes: ['project.updates.read'],
      nonce: randomUUID(),
      aud: capabilityAudience('GET', pinsUrl)
    },
    secret,
    60
  );
  const listing = await app.inject({
    url: pinsUrl,
    headers: { authorization: `Bearer ${pinRead}` }
  });
  expect(listing.statusCode).toBe(200);
  expect(listing.json<{ revisions: unknown[] }>().revisions).toHaveLength(1);
  expect((await pin('user', main, 'project.updates.write', null)).statusCode).toBe(200);
  expect((await manager.pinnedVersions(project)).revisions).toEqual([]);
  const url = `/v1/workspaces/${main}/projects/${project}/versions/${revision.id}/download?path=workspace/result.txt`;
  const token = signCapabilityToken(
    {
      workspaceId: main,
      sub: a,
      role: 'user',
      scopes: ['files.read'],
      nonce: randomUUID(),
      aud: capabilityAudience('GET', url)
    },
    secret,
    60
  );
  const download = await app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}`, range: 'bytes=0-8' }
  });
  expect(download.statusCode).toBe(206);
  expect(download.body).toBe('versioned');
  const tableUrl = `/v1/workspaces/${main}/projects/${project}/versions/${revision.id}/table?path=workspace/results.csv`;
  const tableToken = signCapabilityToken(
    {
      workspaceId: main,
      sub: a,
      role: 'user',
      scopes: ['files.read'],
      nonce: randomUUID(),
      aud: capabilityAudience('GET', tableUrl)
    },
    secret,
    60
  );
  const table = await app.inject({
    url: tableUrl,
    headers: { authorization: `Bearer ${tableToken}` }
  });
  expect(table.statusCode).toBe(200);
  expect(table.json()).toMatchObject({
    columns: [{ name: 'sample' }, { name: 'value' }],
    rows: [[{ text: 'A' }, { text: '7' }]],
    nextCursor: null
  });
  const wrongUrl = tableUrl.replace(`/workspaces/${main}/`, `/workspaces/${wb}/`);
  const wrongToken = signCapabilityToken(
    {
      workspaceId: wb,
      sub: b,
      role: 'user',
      scopes: ['files.read'],
      nonce: randomUUID(),
      aud: capabilityAudience('GET', wrongUrl)
    },
    secret,
    60
  );
  expect(
    (await app.inject({ url: wrongUrl, headers: { authorization: `Bearer ${wrongToken}` } }))
      .statusCode
  ).not.toBe(200);
});
