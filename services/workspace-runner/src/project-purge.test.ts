import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, expect, it } from 'vitest';
import { ProjectUpdatesManager } from './project-updates.js';
import { ProjectPurge } from './project-purge.js';
import { purgeCapacity, purgeFilesystem, PurgeManifest } from './project-purge-files.js';
import { ensureWorkspace } from './files.js';
import { acquireProjectReference } from './project-reference-lock.js';
import Fastify from 'fastify';
import { capabilityAudience, signCapabilityToken } from '@athanor/core';
import { authenticateRunnerRequest } from './auth.js';
import { registerProjectUpdateRoutes } from './project-update-routes.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-purge-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const project = randomUUID(),
    workspace = randomUUID(),
    task = randomUUID();
  await ensureWorkspace(path.join(root, workspace));
  const manager = new ProjectUpdatesManager(
    root,
    {
      start: async () => {
        throw Error('No check expected');
      },
      poll: () => ({ status: 'completed', ranForMs: 1, exitCode: 0 }),
      stop: async () => undefined
    },
    async () => undefined
  );
  cleanups.push(() => manager.close());
  await manager.bind(project, workspace, task, workspace);
  const area = path.join(root, workspace, 'workspace');
  await writeFile(path.join(area, 'shared.txt'), 'retain this file');
  const publish = async (text: string) => {
    await writeFile(path.join(area, 'result.txt'), text);
    const update = await manager.prepare(project, task, { title: text, paths: ['workspace'] });
    await manager.settle(update.id);
    const ready = await manager.inspect(project, update.id);
    return manager.publish(
      project,
      ready.id,
      ready.candidateDigest!,
      'Filesystem acceptance fixture'
    );
  };
  const first = await publish('first'),
    second = await publish('second'),
    head = await publish('current');
  const versions = [first.id],
    archive = await manager.retention(project).preview({ versions });
  const archived = await manager
    .retention(project)
    .archive({ versions, digest: archive.digest, requestId: randomUUID() });
  const selection = { versions, updates: [first.updateId, second.updateId], checks: [] };
  return {
    root,
    project,
    workspace,
    task,
    manager,
    first,
    second,
    head,
    selection,
    archived,
    purge: manager.purge(project),
    state: (name: string) => path.join(root, '.project-store', project, 'state', name)
  };
}

it('reclaims only selected unreferenced content and keeps history, baselines, shared files and later checkout usable', async () => {
  const f = await fixture(),
    preview = await f.purge.preview(f.selection);
  expect(preview.items).toHaveLength(3);
  expect(preview.items.every((item) => !item.reasons.length)).toBe(true);
  expect(preview.sharedObjectsRemoved).toBe(1);
  expect(preview.sharedObjectsRetained).toBeGreaterThan(0);
  const first = z
    .object({ files: z.record(z.string(), z.object({ sha256: z.string() })) })
    .parse(JSON.parse(await readFile(f.state(`revisions/${f.first.id}.json`), 'utf8')));
  const unique = f.state(`content/objects/${first.files['result.txt']!.sha256}.r`);
  const shared = f.state(`content/objects/${first.files['shared.txt']!.sha256}.r`);
  const input = { selection: f.selection, digest: preview.digest, requestId: randomUUID() };
  expect((await f.purge.apply(input)).state).toBe('removing');
  expect(f.manager.backgroundPreparations()).toBe(1);
  await f.purge.close();
  expect(f.manager.backgroundPreparations()).toBe(0);
  const receipt = await f.purge.status(input.requestId);
  expect(receipt).toMatchObject({ state: 'removed', running: false, detail: null });
  expect(receipt.removedPaths).toBeGreaterThan(0);
  expect(receipt.estimatedFreedBytes).toBeGreaterThan(0);
  await expect(lstat(unique)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(shared, 'utf8')).toBe('retain this file');
  expect((await f.manager.version(f.project, f.first.id)).contentRemoval?.state).toBe('removed');
  expect((await f.manager.inspect(f.project, f.first.updateId)).contentRemoval?.state).toBe(
    'removed'
  );
  expect(await f.manager.publish(f.project, f.first.updateId, f.first.digest)).toMatchObject({
    id: f.first.id,
    contentRemoval: { state: 'removed' }
  });
  await expect(
    f.manager.retention(f.project).restore(f.first.id, f.archived.requestId)
  ).rejects.toMatchObject({ status: 410 });
  await expect(f.manager.rebase(f.project, f.second.updateId)).rejects.toMatchObject({
    status: 410
  });
  await expect(f.manager.revisionRoot(f.project, f.first.id)).rejects.toMatchObject({
    status: 410
  });
  expect(await f.purge.apply(input)).toEqual(receipt);
  await f.manager.checkout(f.project, f.task, ['workspace'], f.head.id);
  expect(await readFile(path.join(f.root, f.workspace, 'workspace/result.txt'), 'utf8')).toBe(
    'current'
  );
});

it('refuses changed previews, current versions, active readers and conflicting request identities before deletion', async () => {
  const f = await fixture(),
    blocked = await f.purge.preview({ versions: [f.head.id], updates: [], checks: [] });
  expect(blocked.items[0]!.reasons).toContain('Current published version');
  const preview = await f.purge.preview(f.selection),
    input = { selection: f.selection, digest: preview.digest, requestId: randomUUID() };
  const reader = await acquireProjectReference(f.root, f.project, 'read');
  try {
    await expect(f.purge.apply(input)).rejects.toMatchObject({ status: 409 });
  } finally {
    await reader.release();
  }
  const added = path.join(
    f.root,
    '.project-store',
    f.project,
    'public/candidates',
    f.first.updateId,
    'unreviewed.txt'
  );
  await writeFile(added, 'not in preview');
  await expect(f.purge.apply(input)).rejects.toMatchObject({ status: 409 });
  expect(await readFile(added, 'utf8')).toBe('not in preview');
  await rm(added);
  input.digest = (await f.purge.preview(f.selection)).digest;
  await f.purge.apply(input);
  await f.purge.close();
  await expect(
    f.purge.apply({ ...input, selection: { ...f.selection, updates: [] } })
  ).rejects.toMatchObject({ status: 409 });
});

it('resumes a recorded partial unlink and never admits a replacement inode into the saved manifest', async () => {
  const f = await fixture();
  let failed = false;
  let removed = '';
  const executor: typeof purgeFilesystem = async (root, request, schema, lock) => {
    if (request.mode === 'remove' && !failed) {
      failed = true;
      const manifest = PurgeManifest.parse(request.manifest);
      removed = path.join(root, manifest.entries.find((item) => item.kind === 'file')!.path);
      await rm(removed);
      throw Error('Simulated executor interruption after unlink');
    }
    return purgeFilesystem(root, request, schema, lock);
  };
  const purge = new ProjectPurge(f.root, f.project, async () => undefined, executor);
  const preview = await purge.preview(f.selection),
    input = { selection: f.selection, digest: preview.digest, requestId: randomUUID() };
  await purge.apply(input);
  await purge.close();
  expect(await purge.status(input.requestId)).toMatchObject({ state: 'removing', running: false });
  await writeFile(removed, 'replacement must survive');
  await purge.apply(input);
  await purge.close();
  expect((await purge.status(input.requestId)).detail).toContain('Selected content changed');
  expect(await readFile(removed, 'utf8')).toBe('replacement must survive');
  await rm(removed);
  await purge.apply(input);
  await purge.close();
  expect(await purge.status(input.requestId)).toMatchObject({ state: 'removed', detail: null });
});

it('counts allocated blocks once, preserves unselected links and unlinks a selected symlink without following it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-purge-capacity-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const project = randomUUID(),
    check = randomUUID(),
    directory = path.join(root, check);
  await mkdir(directory);
  await mkdir(path.join(root, '.project-store', project, 'public'), { recursive: true });
  const sparse = path.join(directory, 'sparse');
  await writeFile(sparse, 'data');
  await truncate(sparse, 16 * 1024 * 1024);
  await link(sparse, path.join(root, 'kept'));
  await writeFile(path.join(root, 'outside'), 'keep outside');
  await symlink('../outside', path.join(directory, 'linked'));
  const request = { projectId: project, mode: 'scan', roots: [check], retained: [] };
  const manifest = await purgeFilesystem(root, request, PurgeManifest),
    capacity = purgeCapacity(manifest);
  expect(capacity.logicalBytes).toBe(16 * 1024 * 1024);
  expect(capacity.estimatedFreedBytes).toBeLessThan(capacity.logicalBytes);
  const lock = await acquireProjectReference(root, project, 'write');
  try {
    await purgeFilesystem(
      root,
      { ...request, mode: 'remove', manifest },
      z.object({ removed: z.number() }),
      lock
    );
  } finally {
    await lock.release();
  }
  expect(await readFile(path.join(root, 'outside'), 'utf8')).toBe('keep outside');
  expect((await lstat(path.join(root, 'kept'))).nlink).toBe(1);
  await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('narrows an interrupted cleanup when later work gains a content reference and preserves its ability to publish', async () => {
  const f = await fixture();
  let failed = false;
  const executor: typeof purgeFilesystem = async (root, request, schema, lock) => {
    if (request.mode === 'remove' && !failed) {
      failed = true;
      throw Error('Interrupted before unlink');
    }
    return purgeFilesystem(root, request, schema, lock);
  };
  const purge = new ProjectPurge(f.root, f.project, async () => undefined, executor);
  const preview = await purge.preview(f.selection),
    input = { selection: f.selection, digest: preview.digest, requestId: randomUUID() };
  await purge.apply(input);
  await purge.close();
  await writeFile(path.join(f.root, f.workspace, 'workspace/result.txt'), 'first');
  const rescue = await f.manager.prepare(f.project, f.task, {
    title: 'Keep selected result in a new update',
    paths: ['workspace']
  });
  await f.manager.settle(rescue.id);
  await purge.apply(input);
  await purge.close();
  expect(await purge.status(input.requestId)).toMatchObject({ state: 'removed', detail: null });
  const ready = await f.manager.inspect(f.project, rescue.id);
  const published = await f.manager.publish(
    f.project,
    rescue.id,
    ready.candidateDigest!,
    'Reference lifetime acceptance'
  );
  expect(await readFile(path.join(published.path, 'result.txt'), 'utf8')).toBe('first');
  const transaction = z
    .object({ retainedAfterInterruption: z.array(z.string()) })
    .parse(
      JSON.parse(await readFile(f.state(`purge/transactions/${input.requestId}.json`), 'utf8'))
    );
  expect(transaction.retainedAfterInterruption).toHaveLength(1);
});

it('keeps cleanup owner-only and binds every preview, receipt and mutation to its project workspace', async () => {
  const f = await fixture(),
    app = Fastify();
  cleanups.push(() => app.close());
  const secret = 'project-cleanup-test-secret-at-least-32-characters';
  app.addHook('preHandler', authenticateRunnerRequest(secret));
  registerProjectUpdateRoutes(app, f.manager);
  const preview = await f.purge.preview(f.selection),
    requestId = randomUUID();
  const cases = [
    { action: 'preview', body: f.selection, scope: 'project.updates.read' },
    {
      action: 'apply',
      body: { selection: f.selection, digest: preview.digest, requestId },
      scope: 'project.updates.write'
    },
    { action: 'status', body: { requestId }, scope: 'project.updates.read' },
    { action: 'pending', body: {}, scope: 'project.updates.read' }
  ];
  expect(cases.length).toBeGreaterThan(0);
  for (const item of cases) {
    for (const denial of [
      { role: 'agent', workspace: f.workspace, scope: item.scope },
      { role: 'control', workspace: f.workspace, scope: item.scope },
      { role: 'user', workspace: randomUUID(), scope: item.scope },
      { role: 'user', workspace: f.workspace, scope: 'files.read' }
    ] as const) {
      const url = `/v1/workspaces/${denial.workspace}/projects/${f.project}/cleanup/${item.action}`;
      const token = signCapabilityToken(
        {
          sub: f.task,
          workspaceId: denial.workspace,
          role: denial.role,
          scopes: [denial.scope],
          nonce: randomUUID(),
          aud: capabilityAudience('POST', url)
        },
        secret
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: `Bearer ${token}` },
            payload: item.body
          })
        ).statusCode
      ).not.toBe(200);
    }
  }
  expect(await f.purge.pendingRequests()).toEqual([]);
  const url = `/v1/workspaces/${f.workspace}/projects/${f.project}/cleanup/apply`;
  const token = signCapabilityToken(
    {
      sub: f.task,
      workspaceId: f.workspace,
      role: 'user',
      scopes: ['project.updates.write'],
      nonce: randomUUID(),
      aud: capabilityAudience('POST', url)
    },
    secret
  );
  const reply = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: cases[1]!.body
  });
  expect(reply.statusCode, reply.body).toBe(200);
  await f.purge.close();
  expect((await f.purge.status(requestId)).state).toBe('removed');
});

it('keeps a settled check receipt while permanently removing its isolated files and output', async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, f.workspace, 'workspace/result.txt'), 'candidate with a check');
  const update = await f.manager.prepare(f.project, f.task, {
    title: 'Check cleanup',
    paths: ['workspace'],
    checks: [{ name: 'Fixture check', executable: 'bash', args: ['-lc', 'true'], cwd: 'workspace' }]
  });
  await f.manager.settle(update.id);
  const ready = await f.manager.inspect(f.project, update.id),
    check = ready.checks[0]!;
  await f.manager.startCheck(f.project, update.id, check.id, ready.candidateDigest!);
  await f.manager.settle(check.id);
  const settled = await f.manager.inspect(f.project, update.id);
  expect(settled.checks[0]!.status).toBe('failed');
  const selection = { versions: [], updates: [], checks: [check.id] },
    preview = await f.purge.preview(selection);
  expect(preview.items[0]!.reasons).toEqual([]);
  expect(preview.logicalBytes).toBeGreaterThan(0);
  const input = { selection, digest: preview.digest, requestId: randomUUID() };
  await f.purge.apply(input);
  await f.purge.close();
  expect((await f.purge.status(input.requestId)).state).toBe('removed');
  const after = await f.manager.inspect(f.project, update.id);
  expect(after.checks[0]).toMatchObject({
    id: check.id,
    status: 'failed',
    contentRemoval: { state: 'removed' }
  });
  await expect(f.manager.checkOutput(f.project, update.id, check.id)).rejects.toMatchObject({
    status: 410
  });
  await expect(f.manager.checkRoot(f.project, update.id, check.id)).rejects.toMatchObject({
    status: 410
  });
  expect(after.candidateDigest).toBe(ready.candidateDigest);
  await expect(lstat(path.join(f.root, check.id))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('recovers when all files were unlinked but the executor acknowledgement was lost', async () => {
  const f = await fixture();
  let failed = false;
  const executor: typeof purgeFilesystem = async (root, request, schema, lock) => {
    const result = await purgeFilesystem(root, request, schema, lock);
    if (request.mode === 'remove' && !failed) {
      failed = true;
      throw Error('Lost executor acknowledgement');
    }
    return result;
  };
  const purge = new ProjectPurge(f.root, f.project, async () => undefined, executor);
  const preview = await purge.preview(f.selection),
    input = { selection: f.selection, digest: preview.digest, requestId: randomUUID() };
  await purge.apply(input);
  await purge.close();
  expect(await purge.pendingRequests()).toHaveLength(1);
  await expect(
    f.manager.retention(f.project).restore(f.first.id, f.archived.requestId)
  ).rejects.toMatchObject({ status: 410 });
  await purge.apply(input);
  await purge.close();
  expect(await purge.status(input.requestId)).toMatchObject({ state: 'removed', detail: null });
  expect(await purge.pendingRequests()).toEqual([]);
});
