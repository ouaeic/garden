import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { capabilityAudience, signCapabilityToken } from '@athanor/core';
import { authenticateRunnerRequest } from './auth.js';
import { registerProjectUpdateRoutes } from './project-update-routes.js';
import { ensureWorkspace } from './files.js';
import { ProjectUpdatesManager } from './project-updates.js';
import { acquireProjectReference } from './project-reference-lock.js';
import { moveVersionDirectory } from './project-retention-move.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
it('atomically refuses replacing an empty destination directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-retention-move-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'),
    target = path.join(root, 'target');
  await mkdir(source);
  await mkdir(target);
  await writeFile(path.join(source, 'result.txt'), 'retained');
  await expect(moveVersionDirectory(root, source, target)).rejects.toMatchObject({ status: 409 });
  expect(await readFile(path.join(source, 'result.txt'), 'utf8')).toBe('retained');
  await rm(target, { recursive: true });
  await moveVersionDirectory(root, source, target);
  expect(await readFile(path.join(target, 'result.txt'), 'utf8')).toBe('retained');
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-retention-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const project = randomUUID(),
    workspace = randomUUID(),
    task = randomUUID();
  const area = path.join(root, workspace);
  await ensureWorkspace(area);
  let busy = false;
  const execution = {
    start: async () => {
      throw new Error('No fixture check should start');
    },
    poll: () => ({ status: 'completed', ranForMs: 1, exitCode: 0 }),
    stop: async () => undefined
  };
  const idle = async () => {
    if (busy) throw new Error('A native reader is still running.');
  };
  const manager = new ProjectUpdatesManager(root, execution, idle);
  cleanups.push(() => manager.close());
  await manager.bind(project, workspace, task, workspace);
  await writeFile(path.join(area, 'workspace/shared.txt'), 'unchanged across all versions');
  const publish = async (content: string) => {
    await writeFile(path.join(area, 'workspace/result.txt'), content);
    const update = await manager.prepare(project, task, { title: content, paths: ['workspace'] });
    await manager.settle(update.id);
    const ready = await manager.inspect(project, update.id);
    return manager.publish(project, ready.id, ready.candidateDigest!, 'Fixture publication');
  };
  const first = await publish('first result'),
    second = await publish('second result'),
    head = await publish('current result');
  const retention = manager.retention(project);
  const request = async (versions = [first.id]) => ({
    versions,
    digest: (await retention.preview({ versions })).digest,
    requestId: randomUUID()
  });
  const state = (relative: string) => path.join(root, '.project-store', project, 'state', relative);
  return {
    root,
    project,
    workspace,
    task,
    area,
    manager,
    execution,
    idle,
    retention,
    first,
    second,
    head,
    publish,
    request,
    state,
    busy: (value: boolean) => {
      busy = value;
    }
  };
}

it('requires owner capabilities for archive routes and returns durable history state after restore', async () => {
  const f = await fixture(),
    app = Fastify();
  cleanups.push(() => app.close());
  const secret = 'retention-route-test-secret-at-least-32-characters';
  app.addHook('preHandler', authenticateRunnerRequest(secret));
  registerProjectUpdateRoutes(app, f.manager);
  const input = await f.request();
  const invoke = (
    action: string,
    body: Record<string, unknown>,
    role: 'user' | 'agent' | 'control' = 'user',
    workspaceId = f.workspace,
    scope = 'project.updates.write'
  ) => {
    const url = `/v1/workspaces/${workspaceId}/projects/${f.project}/retention/${action}`;
    const token = signCapabilityToken(
      {
        sub: f.task,
        workspaceId,
        role,
        scopes: [scope],
        nonce: randomUUID(),
        aud: capabilityAudience('POST', url)
      },
      secret
    );
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: body
    });
  };
  const cases = [
    { action: 'preview', body: { versions: input.versions } },
    { action: 'archive', body: input },
    { action: 'restore', body: { revisionId: f.first.id, requestId: input.requestId } }
  ];
  expect(cases.length).toBeGreaterThan(0);
  for (const test of cases) {
    expect((await invoke(test.action, test.body, 'agent')).statusCode).not.toBe(200);
    expect((await invoke(test.action, test.body, 'control')).statusCode).not.toBe(200);
    expect((await invoke(test.action, test.body, 'user', randomUUID())).statusCode).not.toBe(200);
    expect(
      (await invoke(test.action, test.body, 'user', f.workspace, 'files.read')).statusCode
    ).not.toBe(200);
  }
  expect(
    (
      await invoke(
        'preview',
        { versions: input.versions },
        'user',
        f.workspace,
        'project.updates.read'
      )
    ).statusCode
  ).toBe(200);
  const archived = await invoke('archive', input);
  expect(archived.statusCode, archived.body).toBe(200);
  expect(
    archived.json<{ revisions: Array<{ archive: { state: string } }> }>().revisions[0]!.archive
      .state
  ).toBe('archived');
  const restored = await invoke('restore', { revisionId: f.first.id, requestId: input.requestId });
  expect(restored.statusCode, restored.body).toBe(200);
  expect(restored.json<{ revision: { archive: unknown } }>().revision.archive).toBeNull();
});

it('archives exact immutable versions, keeps shared bytes and lineage, and restores across manager restart', async () => {
  const f = await fixture();
  const shared = await stat(path.join(f.first.path, 'shared.txt'));
  expect((await stat(path.join(f.head.path, 'shared.txt'))).ino).toBe(shared.ino);
  const input = await f.request([f.first.id, f.second.id]);
  const preview = await f.retention.preview({ versions: input.versions });
  expect(preview.versions).toHaveLength(2);
  expect(preview.versions.every((version) => version.reasons.length === 0)).toBe(true);
  expect(preview.reclaimedBytes).toBe(0);
  const result = await f.retention.archive(input);
  expect(result).toMatchObject({ completed: true, reclaimedBytes: 0 });
  await expect(f.manager.revisionRoot(f.project, f.first.id)).rejects.toMatchObject({
    status: 410
  });
  await expect(readFile(path.join(f.first.path, 'result.txt'))).rejects.toMatchObject({
    code: 'ENOENT'
  });
  expect(await readFile(path.join(f.head.path, 'shared.txt'), 'utf8')).toBe(
    'unchanged across all versions'
  );
  expect((await f.manager.list(f.project)).revisions.map((version) => version.id)).toEqual([
    f.head.id,
    f.second.id,
    f.first.id
  ]);
  const restarted = new ProjectUpdatesManager(f.root, f.execution, f.idle);
  cleanups.push(() => restarted.close());
  expect((await restarted.list(f.project)).revisions[2]!.archive?.state).toBe('archived');
  await restarted.retention(f.project).restore(f.first.id, input.requestId);
  await restarted.retention(f.project).restore(f.first.id, input.requestId);
  expect(await readFile(path.join(f.first.path, 'result.txt'), 'utf8')).toBe('first result');
  expect((await stat(path.join(f.first.path, 'shared.txt'))).ino).toBe(shared.ino);
  expect(await f.retention.archive(input)).toEqual(result);
  expect(await f.retention.status(f.first.id)).toBeNull();
});

it('requires a fresh preview after pin or publication changes and never archives the head', async () => {
  const f = await fixture();
  const input = await f.request();
  await f.manager.pinVersion(f.project, f.first.id, 'Keep');
  await expect(f.retention.archive(input)).rejects.toThrow('changed');
  const pinned = await f.request();
  await expect(f.retention.archive(pinned)).rejects.toThrow('still in use or pinned');
  await f.manager.pinVersion(f.project, f.first.id, null);
  const stale = await f.request();
  await f.publish('another version');
  await expect(f.retention.archive(stale)).rejects.toThrow('changed');
  const current = (await f.manager.list(f.project)).head!;
  const headPreview = await f.retention.preview({ versions: [current.id] });
  expect(headPreview.versions[0]!.reasons).toContain('Current published version');
  expect(headPreview.versions[0]!.reasons).toContain('Used by a working-area baseline');
  await expect(f.retention.archive(await f.request([current.id]))).rejects.toThrow('still in use');
  expect(await readFile(path.join(f.first.path, 'result.txt'), 'utf8')).toBe('first result');
});

it('retains older working-area baselines and the parent of an unfinished proposal', async () => {
  const f = await fixture(),
    otherWorkspace = randomUUID(),
    otherTask = randomUUID();
  await ensureWorkspace(path.join(f.root, otherWorkspace));
  await f.manager.bind(f.project, f.workspace, otherTask, otherWorkspace);
  await f.manager.checkout(f.project, otherTask, ['workspace'], f.first.id);
  const pending = await f.manager.prepare(f.project, f.task, {
    title: 'Pending decision',
    paths: ['workspace']
  });
  await f.manager.settle(pending.id);
  await f.publish('fourth result');
  const preview = await f.retention.preview({ versions: [f.first.id, f.second.id, f.head.id] });
  expect(preview.versions).toHaveLength(3);
  expect(preview.versions.find((version) => version.id === f.first.id)!.reasons).toContain(
    'Used by a working-area baseline'
  );
  expect(preview.versions.find((version) => version.id === f.head.id)!.reasons).toContain(
    'Used by an unfinished project update'
  );
  expect(preview.versions.find((version) => version.id === f.second.id)!.reasons).toEqual([]);
  await expect(
    f.retention.archive({
      versions: preview.versions.map((version) => version.id),
      digest: preview.digest,
      requestId: randomUUID()
    })
  ).rejects.toThrow('still in use');
  expect(await readFile(path.join(f.second.path, 'result.txt'), 'utf8')).toBe('second result');
});

it('refuses live references and mutations cannot race an exclusive maintenance lease', async () => {
  const f = await fixture(),
    input = await f.request();
  f.busy(true);
  expect((await f.retention.preview({ versions: input.versions })).versions[0]!.reasons).toContain(
    'A native reader is still running.'
  );
  await expect(f.retention.archive(input)).rejects.toThrow('reader');
  f.busy(false);
  const download = await f.manager.openFiles(f.project, () =>
    f.manager.revisionRoot(f.project, f.first.id)
  );
  await expect(f.retention.archive(input)).rejects.toMatchObject({ status: 409 });
  await download.release();
  const maintenance = await acquireProjectReference(f.root, f.project, 'write');
  try {
    await expect(f.manager.pinVersion(f.project, f.first.id, 'Keep')).rejects.toMatchObject({
      status: 409
    });
    await expect(
      f.manager.prepare(f.project, f.task, { title: 'During maintenance', paths: ['workspace'] })
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    await maintenance.release();
  }
  await f.retention.archive(input);
  await expect(f.manager.pinVersion(f.project, f.first.id, 'Archived')).rejects.toMatchObject({
    status: 410
  });
  await expect(
    f.manager.checkout(f.project, f.task, ['workspace'], f.first.id)
  ).rejects.toMatchObject({ status: 410 });
  const reader = await acquireProjectReference(f.root, f.project, 'read');
  f.busy(true);
  try {
    await f.retention.restore(f.first.id, input.requestId);
    expect(await readFile(path.join(f.first.path, 'result.txt'), 'utf8')).toBe('first result');
    await expect(acquireProjectReference(f.root, f.project, 'write')).rejects.toMatchObject({
      status: 409
    });
  } finally {
    await reader.release();
  }
});

it.each(['before_move', 'after_move'] as const)(
  'resumes an interrupted archive %s with the original identity',
  async (position) => {
    const f = await fixture(),
      input = await f.request();
    await f.retention.archive(input);
    const transactionFile = f.state(`retention/transactions/${input.requestId}.json`);
    const transaction = JSON.parse(await readFile(transactionFile, 'utf8')) as Record<
      string,
      unknown
    >;
    transaction.completed = false;
    await writeFile(transactionFile, JSON.stringify(transaction));
    const recordFile = f.state(`retention/records/${f.first.id}.json`);
    const record = JSON.parse(await readFile(recordFile, 'utf8')) as Record<string, unknown>;
    record.state = 'archiving';
    await writeFile(recordFile, JSON.stringify(record));
    if (position === 'before_move')
      await rename(f.state(`retention/content/${f.first.id}`), path.dirname(f.first.path));
    const restarted = new ProjectUpdatesManager(f.root, f.execution, f.idle);
    cleanups.push(() => restarted.close());
    expect((await restarted.retention(f.project).archive(input)).completed).toBe(true);
    await expect(f.retention.archive({ ...input, versions: [f.second.id] })).rejects.toThrow(
      'identity changed'
    );
    await f.retention.restore(f.first.id, input.requestId);
    expect(await readFile(path.join(f.first.path, 'result.txt'), 'utf8')).toBe('first result');
  }
);

it('recovers a restore whose move completed before the durable acknowledgement', async () => {
  const f = await fixture(),
    input = await f.request();
  await f.retention.archive(input);
  const recordFile = f.state(`retention/records/${f.first.id}.json`);
  const record = JSON.parse(await readFile(recordFile, 'utf8')) as Record<string, unknown>;
  record.state = 'restoring';
  await writeFile(recordFile, JSON.stringify(record));
  await rename(f.state(`retention/content/${f.first.id}`), path.dirname(f.first.path));
  await f.retention.restore(f.first.id, input.requestId);
  expect(await f.retention.status(f.first.id)).toBeNull();
  const newer = await f.request();
  await f.retention.archive(newer);
  await expect(f.retention.restore(f.first.id, input.requestId)).rejects.toThrow('changed');
  expect((await f.retention.status(f.first.id))?.requestId).toBe(newer.requestId);
  await f.retention.restore(f.first.id, newer.requestId);
  const transactionFile = f.state(`retention/transactions/${input.requestId}.json`);
  const interrupted = JSON.parse(await readFile(transactionFile, 'utf8')) as Record<
    string,
    unknown
  >;
  interrupted.completed = false;
  await writeFile(transactionFile, JSON.stringify(interrupted));
  await expect(f.retention.archive(input)).rejects.toThrow('different archive operation');
  expect(await readFile(path.join(f.first.path, 'result.txt'), 'utf8')).toBe('first result');
});

it('refuses occupied destinations, altered content, symlinks and malformed reference metadata', async () => {
  const f = await fixture(),
    input = await f.request();
  await f.retention.archive(input);
  await mkdir(f.first.path, { recursive: true });
  await writeFile(path.join(f.first.path, 'keep.txt'), 'must survive');
  await expect(f.retention.restore(f.first.id, input.requestId)).rejects.toThrow('occupied');
  expect(await readFile(path.join(f.first.path, 'keep.txt'), 'utf8')).toBe('must survive');
  await rm(path.dirname(f.first.path), { recursive: true });
  const content = f.state(`retention/content/${f.first.id}/workspace/result.txt`);
  await chmod(content, 0o644);
  await writeFile(content, 'wrong result');
  await expect(f.retention.restore(f.first.id, input.requestId)).rejects.toThrow(
    'failed verification'
  );
  const baseline = f.state(`baselines/${f.workspace}.json`);
  await writeFile(baseline, '{}');
  await expect(f.retention.preview({ versions: [f.second.id] })).rejects.toThrow();
  await rm(baseline);
  await symlink(path.join(f.area, 'workspace/result.txt'), baseline);
  await expect(f.request([f.second.id])).rejects.toThrow();
});
