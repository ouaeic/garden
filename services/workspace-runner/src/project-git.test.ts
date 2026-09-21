import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureWorkspace } from './files.js';
import { ProjectUpdatesManager, type ProjectCheckExecution } from './project-updates.js';
import { ProjectGit } from './project-git.js';
import { projectGitCommand as command } from './project-git-command.js';

const dispose: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of dispose.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-project-git-'));
  dispose.push(() => rm(root, { recursive: true, force: true }));
  const project = randomUUID(),
    main = randomUUID(),
    a = randomUUID(),
    b = randomUUID();
  const wa = randomUUID(),
    wb = randomUUID();
  const execution: ProjectCheckExecution = {
    start: async () => ({ sessionId: randomUUID() }),
    poll: () => ({ status: 'completed', ranForMs: 1, exitCode: 0 }),
    stop: () => {}
  };
  const manager = new ProjectUpdatesManager(root, execution, async () => {});
  dispose.push(() => manager.close());
  for (const [task, workspace] of [
    [a, wa],
    [b, wb]
  ] as const) {
    await ensureWorkspace(path.join(root, workspace));
    await manager.bind(project, main, task, workspace);
  }
  const write = async (workspace: string, name: string, content: string) => {
    const file = path.join(root, workspace, 'workspace', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  const prepare = async (task: string, paths: string[], checks = false) => {
    const result = await manager.prepare(project, task, {
      title: 'Change source',
      paths,
      checks: checks ? [{ name: 'Source checks', executable: '/usr/bin/true' }] : []
    });
    await manager.settle(result.id);
    return manager.inspect(project, result.id);
  };
  await write(wa, 'src/one.ts', 'export const one = 1;\n');
  await write(wa, 'src/two.ts', 'export const two = 2;\n');
  const seed = await prepare(a, ['src']);
  expect(seed.state).toBe('ready');
  const first = await manager.publish(
    project,
    seed.id,
    seed.candidateDigest!,
    'Synthetic source fixture'
  );
  await manager.checkout(project, b, ['src']);
  const connect = (format: 'sha1' | 'sha256' = 'sha1') =>
    manager.createRepository(project, {
      requestId: randomUUID(),
      revisionId: first.id,
      name: 'Sources',
      path: 'src',
      branch: 'main',
      format
    });
  return { root, project, a, b, wa, wb, manager, execution, first, write, prepare, connect };
}

it.each(['sha1', 'sha256'] as const)(
  'records the exact checked candidate as a native %s Git commit',
  async (format) => {
    const f = await fixture(),
      repository = await f.connect(format);
    await f.write(f.wa, 'src/one.ts', 'export const one = 3;\n');
    const update = await f.prepare(f.a, ['src/one.ts'], true);
    expect(update.state).toBe('ready');
    expect(update.repositories).toHaveLength(1);
    const version = update.repositories![0]!;
    expect(version.base).toBe(repository.head);
    expect(version.commit).toHaveLength(format === 'sha1' ? 40 : 64);
    const git = path.join(
      f.manager.directory(f.project),
      'state',
      'repositories',
      repository.id,
      'repository.git'
    );
    expect(await command(git, ['show', `${version.commit}:one.ts`])).toBe(
      'export const one = 3;\n'
    );
    expect(await command(git, ['show', `${version.commit}:two.ts`])).toBe(
      'export const two = 2;\n'
    );
    await expect(f.manager.publish(f.project, update.id, update.candidateDigest!)).rejects.toThrow(
      'Every configured check'
    );
    const check = update.checks[0]!;
    await f.manager.startCheck(f.project, update.id, check.id, update.candidateDigest!);
    await f.manager.settle(check.id);
    await f.manager.inspect(f.project, update.id);
    await f.manager.settle(check.id);
    const published = await f.manager.publish(f.project, update.id, update.candidateDigest!);
    expect(published.repositories).toEqual(update.repositories);
    expect((await f.manager.repositories(f.project).get(repository.id)).head).toBe(version.commit);
    const history = await f.manager.repositories(f.project).history(repository.id);
    expect(history.commits.map((commit) => commit.id)).toEqual([version.commit, repository.head]);
    expect(
      history.branches.some(
        (branch) => branch.name === version.proposalRef && branch.commit === version.commit
      )
    ).toBe(true);
    expect(await readFile(path.join(published.path, 'src/one.ts'), 'utf8')).toBe(
      'export const one = 3;\n'
    );
  }
);

it('preserves simultaneous proposals and adds the previous proposal as a merge parent after rebuilding', async () => {
  const f = await fixture(),
    repository = await f.connect();
  await f.write(f.wa, 'src/one.ts', 'export const one = 3;\n');
  await f.write(f.wb, 'src/two.ts', 'export const two = 4;\n');
  const [a, b] = await Promise.all([
    f.prepare(f.a, ['src/one.ts']),
    f.prepare(f.b, ['src/two.ts'])
  ]);
  expect(a.repositories).toHaveLength(1);
  expect(b.repositories).toHaveLength(1);
  const published = await f.manager.publish(
    f.project,
    a.id,
    a.candidateDigest!,
    'Synthetic source fixture'
  );
  await expect(
    f.manager.publish(f.project, b.id, b.candidateDigest!, 'Synthetic source fixture')
  ).rejects.toThrow('version changed');
  const rebuilt = await f.manager.rebase(f.project, b.id, randomUUID());
  await f.manager.settle(rebuilt.id);
  const ready = await f.manager.inspect(f.project, rebuilt.id);
  expect(ready.state).toBe('ready');
  const next = await f.manager.publish(
    f.project,
    ready.id,
    ready.candidateDigest!,
    'Synthetic source fixture'
  );
  const history = await f.manager.repositories(f.project).history(repository.id);
  expect(history.commits[0]!.parents).toEqual([
    published.repositories![0]!.commit,
    b.repositories![0]!.commit
  ]);
  expect(await readFile(path.join(next.path, 'src/one.ts'), 'utf8')).toBe(
    'export const one = 3;\n'
  );
  expect(await readFile(path.join(next.path, 'src/two.ts'), 'utf8')).toBe(
    'export const two = 4;\n'
  );
  expect(await readFile(path.join(f.first.path, 'src/one.ts'), 'utf8')).toBe(
    'export const one = 1;\n'
  );
});

it('recovers an interrupted ref update from the recorded publication without making a second version', async () => {
  const f = await fixture(),
    repository = await f.connect();
  await f.write(f.wa, 'src/one.ts', 'export const one = 9;\n');
  const update = await f.prepare(f.a, ['src/one.ts']);
  // The wrapper deliberately invokes this implementation with the intercepted receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = ProjectGit.prototype.publish;
  const injected = vi.spyOn(ProjectGit.prototype, 'publish').mockImplementationOnce(async function (
    this: ProjectGit,
    versions
  ) {
    await original.call(this, versions);
    throw Error('Lost publication acknowledgement');
  });
  await expect(
    f.manager.publish(f.project, update.id, update.candidateDigest!, 'Synthetic source fixture')
  ).rejects.toThrow('Lost publication');
  expect((await f.manager.inspect(f.project, update.id)).state).toBe('publishing');
  await expect(f.manager.cancel(f.project, update.id)).rejects.toThrow('Published versions');
  expect((await f.manager.list(f.project)).head!.id).toBe(f.first.id);
  const pending = JSON.parse(
    await readFile(path.join(f.manager.directory(f.project), 'state', 'publishing.json'), 'utf8')
  ) as { revisionId: string };
  const preview = await f.manager.retention(f.project).preview({ versions: [pending.revisionId] });
  expect(preview.versions).toHaveLength(1);
  expect(preview.versions[0]!.reasons).toContain('Publication recovery');
  injected.mockRestore();
  const restored = new ProjectUpdatesManager(f.root, f.execution, async () => {});
  dispose.push(() => restored.close());
  const failures: unknown[] = [];
  await restored.restore((error) => failures.push(error));
  expect(failures).toEqual([]);
  const head = (await restored.list(f.project)).head!;
  expect(head.id).toBe(pending.revisionId);
  expect(head.number).toBe(f.first.number + 1);
  expect((await restored.repositories(f.project).get(repository.id)).head).toBe(
    update.repositories![0]!.commit
  );
  expect((await restored.publish(f.project, update.id, update.candidateDigest!)).id).toBe(head.id);
  await expect(
    readFile(path.join(restored.directory(f.project), 'state', 'publishing.json'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects unsafe branch/path inputs and changed connection identities without running repository callbacks', async () => {
  const f = await fixture();
  const input = {
    requestId: randomUUID(),
    revisionId: f.first.id,
    name: 'Sources',
    path: 'src',
    branch: 'main',
    format: 'sha1'
  };
  await expect(
    f.manager.createRepository(f.project, { ...input, branch: 'main\nupdate refs/heads/other' })
  ).rejects.toThrow();
  await expect(
    f.manager.createRepository(f.project, { ...input, path: '../outside' })
  ).rejects.toThrow();
  const repository = await f.manager.createRepository(f.project, {
    ...input,
    requestId: randomUUID()
  });
  const git = path.join(
    f.manager.directory(f.project),
    'state',
    'repositories',
    repository.id,
    'repository.git'
  );
  const sentinel = path.join(f.root, 'callback');
  await mkdir(path.join(git, 'hooks'), { recursive: true });
  await writeFile(
    path.join(git, 'hooks/reference-transaction'),
    `#!/bin/sh\nprintf callback > '${sentinel}'\n`,
    { mode: 0o700 }
  );
  await f.write(f.wa, 'src/one.ts', 'export const one = 5;\n');
  const update = await f.prepare(f.a, ['src/one.ts']);
  expect(update.state).toBe('ready');
  await f.manager.publish(
    f.project,
    update.id,
    update.candidateDigest!,
    'Synthetic source fixture'
  );
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    f.manager
      .repositories(f.project)
      .create({ ...input, requestId: repository.id, name: 'Different' }, {})
  ).rejects.toThrow('identity changed');
});

it('imports real bundled history without executing source configuration and resumes background setup', async () => {
  const f = await fixture();
  const original = await f.connect();
  const originalGit = path.join(
    f.manager.directory(f.project),
    'state',
    'repositories',
    original.id,
    'repository.git'
  );
  await f.write(f.wa, 'src/one.ts', 'export const one = 7;\n');
  const proposal = await f.prepare(f.a, ['src/one.ts']);
  await f.manager.publish(
    f.project,
    proposal.id,
    proposal.candidateDigest!,
    'Synthetic source fixture'
  );
  const archive = path.join(f.root, f.wa, 'workspace', 'history.bundle');
  await command(originalGit, ['bundle', 'create', archive, '--all']);
  const other = await fixture();
  await other.write(other.wa, 'src/one.ts', 'export const one = 7;\n');
  await writeFile(
    path.join(other.root, other.wa, 'workspace', 'history.bundle'),
    await readFile(archive)
  );
  const importedFiles = await other.prepare(other.a, ['src', 'history.bundle']);
  const version = await other.manager.publish(
    other.project,
    importedFiles.id,
    importedFiles.candidateDigest!,
    'Synthetic source fixture'
  );
  const input = {
    requestId: randomUUID(),
    revisionId: version.id,
    name: 'Imported sources',
    path: 'src',
    branch: 'main',
    format: 'sha1' as const,
    historyPath: 'history.bundle'
  };
  const operation = await other.manager.beginRepository(other.project, input);
  expect(operation.state).toBe('preparing');
  await other.manager.settle(input.requestId);
  const records = await other.manager.repositoryOperations(other.project);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ state: 'ready', files: 2, detail: null });
  const history = await other.manager.repositories(other.project).history(input.requestId);
  expect(history.repository.head).toBe(proposal.repositories![0]!.commit);
  expect(history.commits.map((item) => item.id)).toEqual([
    proposal.repositories![0]!.commit,
    original.head
  ]);
  expect((await other.manager.beginRepository(other.project, input)).state).toBe('ready');
  const resumed = new ProjectUpdatesManager(other.root, other.execution, async () => {});
  dispose.push(() => resumed.close());
  const file = path.join(
    other.manager.directory(other.project),
    'state',
    'repository-operations',
    `${input.requestId}.json`
  );
  await writeFile(file, JSON.stringify({ ...records[0], state: 'preparing' }));
  await resumed.restore();
  await resumed.settle(input.requestId);
  expect((await resumed.repositoryOperations(other.project))[0]!.state).toBe('ready');
  expect((await resumed.repositories(other.project).get(input.requestId)).head).toBe(
    proposal.repositories![0]!.commit
  );
});

it('retains conflicts without publishing either proposal or reusing old check success', async () => {
  const f = await fixture();
  await f.connect();
  await f.write(f.wa, 'src/one.ts', 'export const one = 11;\n');
  await f.write(f.wb, 'src/one.ts', 'export const one = 12;\n');
  const a = await f.prepare(f.a, ['src/one.ts']);
  const b = await f.prepare(f.b, ['src/one.ts'], true);
  await f.manager.publish(f.project, a.id, a.candidateDigest!, 'Synthetic source fixture');
  const next = await f.manager.rebase(f.project, b.id, randomUUID());
  await f.manager.settle(next.id);
  const conflict = await f.manager.inspect(f.project, next.id);
  expect(conflict.state).toBe('conflicted');
  expect(conflict.changes).toHaveLength(1);
  expect(conflict.changes[0]!.conflict).toBe(true);
  expect(conflict.checks).toHaveLength(1);
  expect(conflict.checks[0]!.status).toBe('pending');
  await expect(f.manager.publish(f.project, next.id, conflict.candidateDigest!)).rejects.toThrow(
    'not ready'
  );
  const repository = b.repositories![0]!;
  const git = path.join(
    f.manager.directory(f.project),
    'state',
    'repositories',
    repository.repositoryId,
    'repository.git'
  );
  expect(
    (await command(git, ['show-ref', '--verify', '--hash', repository.proposalRef])).trim()
  ).toBe(repository.commit);
});

it('exports an immutable branch tip and retains an active download until its owner releases it', async () => {
  const f = await fixture(),
    repository = await f.connect();
  const exports = f.manager.gitExports(f.project);
  const input = { requestId: randomUUID(), commit: repository.head };
  const [left, right] = await Promise.all([
    exports.start(repository.id, input),
    exports.start(repository.id, input)
  ]);
  expect(left.requestId).toBe(right.requestId);
  await exports.close();
  const records = await exports.list();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ state: 'ready', commit: repository.head, detail: null });
  expect(records[0]!.bytes).toBeGreaterThan(0);
  await f.write(f.wa, 'src/one.ts', 'export const one = 13;\n');
  const update = await f.prepare(f.a, ['src/one.ts']);
  await f.manager.publish(
    f.project,
    update.id,
    update.candidateDigest!,
    'Synthetic source fixture'
  );
  const opened = await exports.open(input.requestId);
  const archive = path.join(opened.root, 'workspace/repository.bundle');
  const git = path.join(
    f.manager.directory(f.project),
    'state',
    'repositories',
    repository.id,
    'repository.git'
  );
  expect((await command(git, ['bundle', 'list-heads', archive])).trim()).toBe(
    `${repository.head} refs/heads/main`
  );
  await expect(exports.remove(input.requestId)).rejects.toThrow('being downloaded');
  await opened.release();
  await exports.remove(input.requestId);
  expect(await exports.list()).toEqual([]);
  expect((await f.manager.repositories(f.project).get(repository.id)).head).toBe(
    update.repositories![0]!.commit
  );
});

it('keeps Unicode, newline and leading-dash source names as exact Git paths', async () => {
  const f = await fixture();
  await f.connect();
  const name = 'src/-測定\nresult.txt';
  await f.write(f.wa, name, 'result\n');
  const update = await f.prepare(f.a, [name]);
  expect(update.state).toBe('ready');
  expect(update.repositories).toHaveLength(1);
  const version = update.repositories![0]!;
  const git = path.join(
    f.manager.directory(f.project),
    'state',
    'repositories',
    version.repositoryId,
    'repository.git'
  );
  expect(await command(git, ['show', `${version.commit}:${name.slice(4)}`])).toBe('result\n');
});

it('resumes publication after only one repository branch advanced', async () => {
  const f = await fixture();
  await f.write(f.wa, 'analysis/script.py', 'print(1)\n');
  const seed = await f.prepare(f.a, ['analysis']);
  const base = await f.manager.publish(
    f.project,
    seed.id,
    seed.candidateDigest!,
    'Synthetic source fixture'
  );
  const repositories = [];
  for (const source of ['src', 'analysis'])
    repositories.push(
      await f.manager.createRepository(f.project, {
        requestId: randomUUID(),
        revisionId: base.id,
        name: source,
        path: source,
        branch: 'main'
      })
    );
  await f.write(f.wa, 'src/one.ts', 'export const one = 14;\n');
  await f.write(f.wa, 'analysis/script.py', 'print(2)\n');
  const update = await f.prepare(f.a, ['src', 'analysis']);
  expect(update.repositories).toHaveLength(2);
  const last = update.repositories![1]!;
  const module = await import('./project-git-command.js');
  const real = module.projectGitCommand;
  let interrupted = false;
  const fault = vi
    .spyOn(module, 'projectGitCommand')
    .mockImplementation(async (directory, args, input, options) => {
      if (
        !interrupted &&
        directory.includes(last.repositoryId) &&
        args[0] === 'update-ref' &&
        args[2] === 'refs/heads/main'
      ) {
        interrupted = true;
        throw Error('Interrupted between repositories');
      }
      return real(directory, args, input, options);
    });
  await expect(
    f.manager.publish(f.project, update.id, update.candidateDigest!, 'Synthetic source fixture')
  ).rejects.toThrow('Interrupted between repositories');
  const versions = update.repositories!;
  expect((await f.manager.repositories(f.project).get(versions[0]!.repositoryId)).head).toBe(
    versions[0]!.commit
  );
  expect((await f.manager.repositories(f.project).get(last.repositoryId)).head).toBe(last.base);
  expect((await f.manager.list(f.project)).head!.id).toBe(base.id);
  fault.mockRestore();
  const published = await f.manager.publish(f.project, update.id, update.candidateDigest!);
  expect(published.number).toBe(base.number + 1);
  expect(published.repositories).toHaveLength(2);
  for (const version of published.repositories!)
    expect((await f.manager.repositories(f.project).get(version.repositoryId)).head).toBe(
      version.commit
    );
});

it('requires the current branch identity for removal and preserves project files and exported history', async () => {
  const f = await fixture(),
    repository = await f.connect();
  const exports = f.manager.gitExports(f.project);
  const exported = await exports.start(repository.id, {
    requestId: randomUUID(),
    commit: repository.head
  });
  await exports.close();
  const requestId = randomUUID();
  await expect(
    f.manager.removeRepository(f.project, repository.id, { requestId, head: 'f'.repeat(40) })
  ).rejects.toThrow('repository changed');
  expect(await f.manager.repositories(f.project).list()).toHaveLength(1);
  const removed = await f.manager.removeRepository(f.project, repository.id, {
    requestId,
    head: repository.head
  });
  expect(removed.state).toBe('removing');
  await f.manager.settle(requestId);
  expect(await f.manager.repositories(f.project).list()).toEqual([]);
  const receipts = await f.manager.repositories(f.project).removals();
  expect(receipts).toHaveLength(1);
  expect(receipts[0]!.state).toBe('removed');
  expect(
    (
      await f.manager.removeRepository(f.project, repository.id, {
        requestId,
        head: repository.head
      })
    ).state
  ).toBe('removed');
  expect(await readFile(path.join(f.first.path, 'src/one.ts'), 'utf8')).toBe(
    'export const one = 1;\n'
  );
  const downloaded = await exports.open(exported.requestId);
  await downloaded.release();
  await expect(
    readFile(
      path.join(
        f.manager.directory(f.project),
        'state',
        'repositories',
        repository.id,
        'repository.git',
        'HEAD'
      )
    )
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
