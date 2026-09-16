import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ProjectUpdate } from '@athanor/contracts';
import { ensureWorkspace, workspacePath } from './files.js';
import { ProjectUpdatesManager, type ProjectCheckExecution } from './project-updates.js';
import { ProjectVersionFiles } from './project-version-files.js';

const roots: string[] = [];
it('finalizes the root working area without changing versions or admitting an unrelated area', async () => {
  const f = await fixture();
  await f.manager.bind(f.project, f.main, f.project, f.wa);
  const before = await f.seed();
  const wrong = randomUUID();
  await expect(f.manager.bind(f.project, wrong, f.project, wrong)).rejects.toThrow(
    'identity changed'
  );
  await expect(f.manager.bind(f.project, f.wa, f.a, f.wa)).rejects.toThrow('identity changed');
  await f.manager.bind(f.project, f.wa, f.project, f.wa);
  expect(await f.manager.projectWorkspace(f.project)).toBe(f.wa);
  expect(await f.manager.member(f.project, f.b)).toBe(f.wb);
  expect((await f.manager.list(f.project)).head?.id).toBe(before.id);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garden-updates-'));
  roots.push(root);
  const project = randomUUID(),
    main = randomUUID(),
    a = randomUUID(),
    b = randomUUID(),
    wa = randomUUID(),
    wb = randomUUID();
  await Promise.all([main, wa, wb].map((id) => ensureWorkspace(workspacePath(root, id))));
  const jobs = new Map<
    string,
    {
      status: string;
      ranForMs: number;
      exitCode: number | null;
      workspaceId: string;
      taskId: string;
    }
  >();
  const stopped: string[] = [];
  const execution: ProjectCheckExecution = {
    async start(workspaceId, taskId) {
      const sessionId = randomUUID();
      jobs.set(sessionId, { status: 'running', ranForMs: 1, exitCode: null, workspaceId, taskId });
      return { sessionId };
    },
    poll(workspaceId, taskId, sessionId) {
      const job = jobs.get(sessionId);
      if (!job || job.workspaceId !== workspaceId || job.taskId !== taskId)
        throw new Error('Missing job');
      return job;
    },
    stop(_workspace, _task, sessionId) {
      stopped.push(sessionId);
      const job = jobs.get(sessionId);
      if (job) job.status = 'stopped';
    }
  };
  const manager = new ProjectUpdatesManager(root, execution);
  await manager.bind(project, main, a, wa);
  const write = async (workspace: string, name: string, content: string | Buffer) => {
    const target = path.join(root, workspace, 'workspace', name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  const prepare = async (
    task: string,
    paths: string[],
    checks = false,
    deletePaths: string[] = []
  ): Promise<ProjectUpdate> => {
    const update = await manager.prepare(project, task, {
      title: 'Project update',
      paths,
      deletePaths,
      checks: checks ? [{ name: 'Tests', executable: 'node', args: ['test.js'] }] : []
    });
    await manager.settle(update.id);
    return manager.inspect(project, update.id);
  };
  const publish = (update: ProjectUpdate) =>
    manager.publish(
      project,
      update.id,
      update.candidateDigest!,
      'Owner chose to publish this fixture without automated checks'
    );
  const seed = async () => {
    await write(wa, 'analysis.txt', 'first\nsecond\nthird\nfourth\nfifth\n');
    const initial = await publish(await prepare(a, ['analysis.txt']));
    await manager.bind(project, main, b, wb);
    await manager.checkout(project, b, ['analysis.txt']);
    return initial;
  };
  const complete = async (update: ProjectUpdate, code = 0) => {
    expect(update.checks.length).toBeGreaterThan(0);
    const check = update.checks[0]!;
    await manager.startCheck(project, update.id, check.id, update.candidateDigest!);
    await manager.settle(check.id);
    const running = await manager.inspect(project, update.id),
      job = jobs.get(running.checks[0]!.sessionId!)!;
    expect(job.status).toBe('running');
    job.status = code === 0 ? 'completed' : 'failed';
    job.exitCode = code;
    job.ranForMs = 1234;
    await manager.inspect(project, update.id);
    await manager.settle(check.id);
    return manager.inspect(project, update.id);
  };
  return {
    root,
    project,
    main,
    a,
    b,
    wa,
    wb,
    manager,
    execution,
    jobs,
    stopped,
    write,
    prepare,
    publish,
    seed,
    complete
  };
}

it('publishes immutable files without rewriting a working directory and replays publication once', async () => {
  const f = await fixture();
  await f.write(f.wa, 'model.py', 'print(1)\n');
  const update = await f.prepare(f.a, ['model.py']);
  expect(update.state).toBe('ready');
  await expect(f.manager.publish(f.project, update.id, update.candidateDigest!)).rejects.toThrow(
    'explicit owner'
  );
  const revision = await f.publish(update);
  await f.write(f.wa, 'model.py', 'print(2)\n');
  expect(await readFile(path.join(revision.path, 'model.py'), 'utf8')).toBe('print(1)\n');
  expect(await f.publish(update)).toEqual(revision);
  expect((await f.manager.list(f.project)).revisions).toHaveLength(1);
  expect(f.stopped).toEqual([]);
});
it('combines disjoint files and keeps stale-head checks from authorizing publication', async () => {
  const f = await fixture();
  await f.seed();
  await f.write(f.wa, 'report.md', 'Report A');
  await f.write(f.wb, 'plot.py', 'print("B")');
  const a = await f.prepare(f.a, ['report.md'], true),
    b = await f.prepare(f.b, ['plot.py'], true);
  const checkedA = await f.complete(a),
    checkedB = await f.complete(b);
  expect(checkedA.checks[0]!.status).toBe('passed');
  expect(checkedB.checks[0]!.status).toBe('passed');
  await f.manager.publish(f.project, a.id, a.candidateDigest!);
  expect((await f.manager.inspect(f.project, b.id)).state).toBe('outdated');
  await expect(f.manager.publish(f.project, b.id, b.candidateDigest!)).rejects.toThrow(
    'version changed'
  );
  const rebuilt = await f.manager.rebase(f.project, b.id);
  await f.manager.settle(rebuilt.id);
  const candidate = await f.manager.inspect(f.project, rebuilt.id);
  expect(candidate.checks[0]!.status).toBe('pending');
  await f.complete(candidate);
  const published = await f.manager.publish(f.project, candidate.id, candidate.candidateDigest!);
  expect(await readFile(path.join(published.path, 'report.md'), 'utf8')).toBe('Report A');
  expect(await readFile(path.join(published.path, 'plot.py'), 'utf8')).toContain('B');
});
it('merges compatible edits within one text file and exposes overlapping edits as conflicts', async () => {
  const f = await fixture();
  await f.seed();
  await f.write(f.wa, 'analysis.txt', 'FIRST\nsecond\nthird\nfourth\nfifth\n');
  await f.write(f.wb, 'analysis.txt', 'first\nsecond\nthird\nfourth\nFIFTH\n');
  await f.publish(await f.prepare(f.a, ['analysis.txt']));
  const b = await f.prepare(f.b, ['analysis.txt']);
  expect(b.changes[0]!.merged).toBe(true);
  const revision = await f.publish(b);
  expect(await readFile(path.join(revision.path, 'analysis.txt'), 'utf8')).toBe(
    'FIRST\nsecond\nthird\nfourth\nFIFTH\n'
  );
  const c = randomUUID(),
    wc = randomUUID();
  await ensureWorkspace(workspacePath(f.root, wc));
  await f.manager.bind(f.project, f.main, c, wc);
  await f.manager.checkout(f.project, c, ['analysis.txt']);
  await f.write(f.wa, 'analysis.txt', 'OTHER\nsecond\nthird\nfourth\nfifth\n');
  await f.publish(await f.prepare(f.a, ['analysis.txt']));
  await f.write(wc, 'analysis.txt', 'DIFFERENT\nsecond\nthird\nfourth\nFIFTH\n');
  const conflict = await f.prepare(c, ['analysis.txt']);
  expect(conflict.state).toBe('conflicted');
  expect(conflict.changes[0]!.conflict).toBe(true);
  await expect(f.publish(conflict)).rejects.toThrow('not ready');
});
it('does not interpret missing files as deletions and requires explicit deletions to match their base', async () => {
  const f = await fixture();
  await f.seed();
  await f.write(f.wb, 'new.txt', 'new');
  const published = await f.publish(await f.prepare(f.b, ['new.txt']));
  expect(await readFile(path.join(published.path, 'analysis.txt'), 'utf8')).toContain('first');
  const deletion = await f.prepare(f.b, ['new.txt'], false, ['analysis.txt']);
  expect(
    deletion.changes.some((change) => change.path === 'analysis.txt' && change.kind === 'deleted')
  ).toBe(true);
  const deleted = await f.publish(deletion);
  await expect(readFile(path.join(deleted.path, 'analysis.txt'))).rejects.toThrow();
});
it('invalidates checks that edit their source and records failures without a passing badge', async () => {
  const f = await fixture();
  await f.write(f.wa, 'test.js', 'process.exit(0)');
  const update = await f.prepare(f.a, ['test.js'], true),
    check = update.checks[0]!;
  await f.manager.startCheck(f.project, update.id, check.id, update.candidateDigest!);
  await f.manager.settle(check.id);
  const running = await f.manager.inspect(f.project, update.id);
  await f.write(check.id, 'test.js', 'changed test');
  const job = f.jobs.get(running.checks[0]!.sessionId!)!;
  job.status = 'completed';
  job.exitCode = 0;
  await f.manager.inspect(f.project, update.id);
  await f.manager.settle(check.id);
  const invalid = await f.manager.inspect(f.project, update.id);
  expect(invalid.checks[0]!.status).toBe('invalidated');
  await expect(f.publish(invalid)).rejects.toThrow('not ready');
  expect(await readFile(path.join(update.path!, 'test.js'), 'utf8')).toBe('process.exit(0)');
  const retry = await f.manager.rebase(f.project, update.id);
  await f.manager.settle(retry.id);
  const failed = await f.complete(await f.manager.inspect(f.project, retry.id), 1);
  expect(failed.checks[0]!.status).toBe('failed');
});
it('runs independent checks concurrently and stops only the requested check', async () => {
  const f = await fixture();
  await f.seed();
  await f.write(f.wa, 'test.js', 'A');
  await f.write(f.wb, 'test.js', 'B');
  const updates = await Promise.all([
    f.prepare(f.a, ['test.js'], true),
    f.prepare(f.b, ['test.js'], true)
  ]);
  expect(updates).toHaveLength(2);
  for (const update of updates) {
    await f.manager.startCheck(f.project, update.id, update.checks[0]!.id, update.candidateDigest!);
    await f.manager.settle(update.checks[0]!.id);
  }
  const views = await Promise.all(updates.map((update) => f.manager.inspect(f.project, update.id)));
  expect(views.every((view) => view.checks[0]!.status === 'running')).toBe(true);
  await f.manager.checkOutput(f.project, views[0]!.id, views[0]!.checks[0]!.id, true);
  expect(f.stopped).toEqual([views[0]!.checks[0]!.sessionId]);
  expect((await f.manager.inspect(f.project, views[1]!.id)).checks[0]!.status).toBe('running');
});
it('accepts only one publication against the same head and retains both proposals', async () => {
  const f = await fixture();
  await f.seed();
  await f.write(f.wa, 'a.txt', 'A');
  await f.write(f.wb, 'b.txt', 'B');
  const a = await f.prepare(f.a, ['a.txt']),
    b = await f.prepare(f.b, ['b.txt']);
  const results = await Promise.allSettled([f.publish(a), f.publish(b)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect((await f.manager.list(f.project)).updates).toHaveLength(3);
});
it('refuses symlinks, traversal, foreign membership, and silently changing request identity', async () => {
  const f = await fixture();
  await f.write(f.wa, 'safe.txt', 'safe');
  await symlink('/etc/passwd', path.join(f.root, f.wa, 'workspace', 'link'));
  expect((await f.prepare(f.a, ['link'])).state).toBe('failed');
  await expect(f.prepare(f.a, ['../private'])).rejects.toThrow();
  await expect(f.prepare(randomUUID(), ['safe.txt'])).rejects.toThrow('not registered');
  const request = randomUUID();
  await f.manager.prepare(f.project, f.a, { title: 'A', paths: ['safe.txt'] }, f.a, request);
  await f.manager.settle(request);
  await expect(
    f.manager.prepare(f.project, f.a, { title: 'B', paths: ['safe.txt'] }, f.a, request)
  ).rejects.toThrow('identity changed');
});
it('detects source writes during capture rather than publishing a mixed version', async () => {
  const f = await fixture();
  await f.write(f.wa, 'data.txt', Buffer.alloc(300_000, 65));
  const versions = new ProjectVersionFiles(path.join(f.root, 'objects'));
  let changed: Promise<void> | undefined;
  await expect(
    versions.capture(
      workspacePath(f.root, f.wa),
      ['data.txt'],
      () => {
        changed ??= f.write(f.wa, 'data.txt', 'changed');
      },
      () => undefined
    )
  ).rejects.toThrow('Source changed');
  await changed;
});
it('keeps published content and successful checks after restart without rerunning them', async () => {
  const f = await fixture();
  await f.write(f.wa, 'test.js', 'process.exit(0)');
  const ready = await f.complete(await f.prepare(f.a, ['test.js'], true));
  const published = await f.manager.publish(f.project, ready.id, ready.candidateDigest!);
  const restarted = new ProjectUpdatesManager(f.root, f.execution);
  expect((await restarted.list(f.project)).head?.id).toBe(published.id);
  expect((await restarted.inspect(f.project, ready.id)).checks[0]!.status).toBe('passed');
  expect(f.jobs.size).toBe(1);
});
it('keeps checked-out files independent and supports large inputs without a source-size ceiling', async () => {
  const f = await fixture();
  await f.write(f.wa, 'data.bin', Buffer.alloc(3 * 1024 * 1024, 65));
  const revision = await f.publish(await f.prepare(f.a, ['data.bin']));
  await f.manager.bind(f.project, f.main, f.b, f.wb);
  await f.manager.checkout(f.project, f.b, ['data.bin']);
  await f.write(f.wb, 'data.bin', 'modified');
  expect((await stat(path.join(revision.path, 'data.bin'))).size).toBe(3 * 1024 * 1024);
  await expect(f.manager.checkout(f.project, f.b, ['data.bin'])).rejects.toThrow();
});

it('records an explicit conflict resolution against the named version and rejects stale resolutions', async () => {
  const f = await fixture();
  await f.seed();
  await f.write(f.wa, 'analysis.txt', 'first proposal');
  const head = await f.publish(await f.prepare(f.a, ['analysis.txt']));
  await f.write(f.wb, 'analysis.txt', 'resolved proposal');
  expect((await f.prepare(f.b, ['analysis.txt'])).state).toBe('conflicted');
  const resolved = await f.manager.prepare(f.project, f.b, {
    title: 'Resolved analysis',
    paths: ['analysis.txt'],
    resolvedPaths: ['analysis.txt'],
    expectedRevision: head.id
  });
  await f.manager.settle(resolved.id);
  const version = await f.publish(await f.manager.inspect(f.project, resolved.id));
  expect(await readFile(path.join(version.path, 'analysis.txt'), 'utf8')).toBe('resolved proposal');
  await expect(
    f.manager.prepare(f.project, f.a, {
      title: 'Stale resolution',
      paths: ['analysis.txt'],
      resolvedPaths: ['analysis.txt'],
      expectedRevision: head.id
    })
  ).rejects.toThrow('version changed');
});
it('bounds file previews while preserving a complete, stable cursor and full published tree', async () => {
  const f = await fixture();
  for (let index = 0; index < 105; index++)
    await f.write(f.wa, `part-${String(index).padStart(3, '0')}.txt`, 'content');
  const update = await f.prepare(f.a, ['workspace']);
  expect(update.changeCount).toBe(105);
  expect(update.changes).toHaveLength(100);
  expect(update.nextChange).toBeTruthy();
  const tail = await f.manager.inspect(f.project, update.id, update.nextChange!);
  expect(tail.changes).toHaveLength(5);
  expect(tail.nextChange).toBeNull();
  expect(new Set([...update.changes, ...tail.changes].map((change) => change.path)).size).toBe(105);
  expect((await f.publish(update)).fileCount).toBe(105);
  expect((await f.manager.list(f.project)).updates[0]!.changes).toEqual([]);
});
it('serializes retries of preparation and rebuilding without duplicating files or checks', async () => {
  const f = await fixture();
  await f.write(f.wa, 'a.txt', 'A');
  const id = randomUUID();
  const calls = await Promise.all(
    Array.from({ length: 3 }, () =>
      f.manager.prepare(f.project, f.a, { title: 'A', paths: ['a.txt'] }, f.a, id)
    )
  );
  expect(new Set(calls.map((update) => update.id)).size).toBe(1);
  await f.manager.settle(id);
  const retry = randomUUID();
  const rebuilt = await Promise.all(
    Array.from({ length: 3 }, () => f.manager.rebase(f.project, id, retry))
  );
  await f.manager.settle(retry);
  expect(new Set(rebuilt.map((update) => update.id)).size).toBe(1);
  expect((await f.manager.list(f.project)).updates).toHaveLength(2);
});
it('rejects binary overlaps and restores a recoverable publication without rolling newer history backward', async () => {
  const f = await fixture();
  await f.write(f.wa, 'data.bin', Buffer.from([0, 1]));
  const first = await f.publish(await f.prepare(f.a, ['data.bin']));
  await f.manager.bind(f.project, f.main, f.b, f.wb);
  await f.manager.checkout(f.project, f.b, ['data.bin']);
  await f.write(f.wa, 'data.bin', Buffer.from([0, 2]));
  await f.publish(await f.prepare(f.a, ['data.bin']));
  await f.write(f.wb, 'data.bin', Buffer.from([0, 3]));
  expect((await f.prepare(f.b, ['data.bin'])).state).toBe('conflicted');
  const initial = await f.manager.inspect(f.project, first.updateId);
  await f.publish(initial);
  expect((await f.manager.list(f.project)).head?.number).toBe(2);
  expect(await readFile(path.join(first.path, 'data.bin'))).toEqual(Buffer.from([0, 1]));
});

it('does not infer a file baseline from project membership alone', async () => {
  const f = await fixture();
  await f.seed();
  const task = randomUUID(),
    workspace = randomUUID();
  await ensureWorkspace(workspacePath(f.root, workspace));
  await f.manager.bind(f.project, f.main, task, workspace);
  await f.write(workspace, 'analysis.txt', 'independently created file');
  const update = await f.prepare(task, ['analysis.txt']);
  expect(update.state).toBe('conflicted');
  expect(update.changes[0]!.base).toBeNull();
});
it('cancels a preparing check without stopping another job or changing source files', async () => {
  const f = await fixture();
  await f.write(f.wa, 'test.js', 'process.exit(0)');
  const update = await f.prepare(f.a, ['test.js'], true);
  await f.manager.startCheck(f.project, update.id, update.checks[0]!.id, update.candidateDigest!);
  await f.manager.cancel(f.project, update.id);
  await f.manager.settle(update.checks[0]!.id);
  const cancelled = await f.manager.inspect(f.project, update.id);
  expect(cancelled.state).toBe('cancelled');
  expect(cancelled.checks[0]!.status).toBe('cancelled');
  expect(await readFile(path.join(f.root, f.wa, 'workspace/test.js'), 'utf8')).toBe(
    'process.exit(0)'
  );
  expect(f.stopped).toEqual([...f.jobs.keys()]);
});
it('recovers completed check evidence through the background observer without a browser or another model call', async () => {
  const f = await fixture();
  await f.write(f.wa, 'test.js', 'process.exit(0)');
  const update = await f.prepare(f.a, ['test.js'], true),
    checkId = update.checks[0]!.id;
  await f.manager.startCheck(f.project, update.id, checkId, update.candidateDigest!);
  await f.manager.settle(checkId);
  const running = await f.manager.inspect(f.project, update.id),
    job = f.jobs.get(running.checks[0]!.sessionId!)!;
  job.status = 'completed';
  job.exitCode = 0;
  const recovered = new ProjectUpdatesManager(f.root, f.execution);
  try {
    await recovered.restore();
    await recovered.settle(checkId);
    expect((await recovered.inspect(f.project, update.id)).checks[0]!.status).toBe('passed');
    expect(f.jobs.size).toBe(1);
  } finally {
    await recovered.close();
  }
});

it('keeps an old running check visible when newer updates fill the history page', async () => {
  const f = await fixture();
  await f.write(f.wa, 'test.js', 'process.exit(0)');
  const running = await f.prepare(f.a, ['test.js'], true);
  await f.manager.startCheck(
    f.project,
    running.id,
    running.checks[0]!.id,
    running.candidateDigest!
  );
  await f.manager.settle(running.checks[0]!.id);
  for (let index = 0; index < 41; index++) await f.prepare(f.a, ['test.js']);
  const page = await f.manager.list(f.project);
  expect(page.updates[0]!.id).toBe(running.id);
  expect(page.updates[0]!.checks[0]!.status).toBe('running');
  expect(page.nextCursor).not.toBeNull();
  expect(page.nextCursor).not.toBe(running.id);
  const older = await f.manager.list(f.project, page.nextCursor!);
  expect(older.updates.some((update) => update.id === running.id)).toBe(true);
});

it('keeps file versus directory collisions explicit until the published file is deliberately removed', async () => {
  const f = await fixture();
  await f.write(f.wa, 'results', 'summary');
  await f.publish(await f.prepare(f.a, ['results']));
  await f.manager.bind(f.project, f.main, f.b, f.wb);
  await f.write(f.wb, 'results/table.tsv', 'sample\tcount');
  const collision = await f.prepare(f.b, ['results']);
  expect(collision.state).toBe('conflicted');
  expect(
    collision.changes.some((change) => change.path === 'results/table.tsv' && change.conflict)
  ).toBe(true);
  await expect(f.publish(collision)).rejects.toThrow('not ready');
  await rm(path.join(f.root, f.wa, 'workspace/results'));
  await f.write(f.wa, 'results/table.tsv', 'sample\tcount');
  const resolved = await f.prepare(f.a, ['results'], false, ['results']);
  expect(resolved.state).toBe('ready');
  const published = await f.publish(resolved);
  expect(await readFile(path.join(published.path, 'results/table.tsv'), 'utf8')).toBe(
    'sample\tcount'
  );
});
it('reuses captured content and refuses a new data copy when the host storage reserve would be consumed', async () => {
  const f = await fixture();
  await f.write(f.wa, 'cohort.bin', Buffer.alloc(1024 * 1024, 7));
  let available = 8 * 1024 ** 3;
  const files = new ProjectVersionFiles(path.join(f.root, 'storage-fixture'), async () => ({
    hostStorageTotalBytes: 100 * 1024 ** 3,
    hostStorageAvailableBytes: available
  }));
  const tree = await files.capture(
    workspacePath(f.root, f.wa),
    ['cohort.bin'],
    () => undefined,
    () => undefined
  );
  expect(Object.keys(tree)).toEqual(['cohort.bin']);
  const fact = tree['cohort.bin']!;
  const inode = (await stat(files.object(fact))).ino;
  available = 2 * 1024 ** 3;
  expect(
    await files.capture(
      workspacePath(f.root, f.wa),
      ['cohort.bin'],
      () => undefined,
      () => undefined
    )
  ).toEqual(tree);
  expect((await stat(files.object(fact))).ino).toBe(inode);
  await f.write(f.wa, 'cohort.bin', Buffer.alloc(1024 * 1024, 8));
  await expect(
    files.capture(
      workspacePath(f.root, f.wa),
      ['cohort.bin'],
      () => undefined,
      () => undefined
    )
  ).rejects.toThrow('Host disk is too full');
  available = 0;
  const destination = path.join(f.root, 'check-copy.bin');
  await expect(files.copy(fact, destination)).rejects.toThrow('Host disk is too full');
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('pages all published versions while preserving the current head', async () => {
  const f = await fixture();
  const expected: string[] = [];
  for (let version = 1; version <= 43; version++) {
    await f.write(f.wa, 'revision.txt', `version ${version}\n`);
    const published = await f.publish(await f.prepare(f.a, ['revision.txt']));
    expected.unshift(published.id);
  }
  const first = await f.manager.list(f.project);
  expect(first.revisions).toHaveLength(40);
  expect(first.head?.id).toBe(expected[0]);
  expect(first.nextRevisionCursor).toBe(expected[39]);
  const second = await f.manager.list(f.project, undefined, first.nextRevisionCursor!);
  expect(second.head?.id).toBe(expected[0]);
  expect(second.revisions).toHaveLength(3);
  expect(second.nextRevisionCursor).toBeNull();
  expect([...first.revisions, ...second.revisions].map((item) => item.id)).toEqual(expected);
  await expect(f.manager.list(f.project, undefined, randomUUID())).rejects.toThrow('not found');
});
