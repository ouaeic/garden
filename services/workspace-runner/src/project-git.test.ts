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
  const captures = new Map<string, string>();
  const execution: ProjectCheckExecution = {
    captureGit: async (copy, output) => {
      const source = path.join(root, copy.workspaceId, 'workspace', copy.path);
      const head = (await command(source, ['rev-parse', 'HEAD'])).trim();
      if (head !== copy.base)
        await command(source, ['bundle', 'create', output, 'HEAD', '^' + copy.base]);
      const sessionId = randomUUID();
      captures.set(sessionId, JSON.stringify({ head, unchanged: head === copy.base }));
      return { sessionId };
    },
    start: async () => ({ sessionId: randomUUID() }),
    poll: (_workspace, _task, sessionId) => ({
      status: 'completed',
      ranForMs: 1,
      exitCode: 0,
      ...(captures.has(sessionId) ? { stdout: captures.get(sessionId)! } : {})
    }),
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
  expect(seed.state, seed.detail ?? '').toBe('ready');
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
    expect(update.state, update.detail ?? '').toBe('ready');
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
  expect(update.state, update.detail ?? '').toBe('ready');
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
  expect(update.state, update.detail ?? '').toBe('ready');
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

it.each(['sha1', 'sha256'] as const)(
  'prepares independent native %s conversation branches with isolated indexes and objects',
  async (format) => {
    const f = await fixture(),
      repository = await f.connect(format);
    const left = await f.manager.checkout(f.project, f.a, ['src']);
    const right = await f.manager.checkout(f.project, f.b, ['src']);
    expect(left.workingCopies).toHaveLength(1);
    expect(right.workingCopies).toHaveLength(1);
    await f.manager.gitWorkingCopies(f.project).close();
    const copies = await f.manager.gitWorkingCopies(f.project).list();
    expect(copies).toHaveLength(2);
    expect(copies.every((copy) => copy.state === 'ready')).toBe(true);
    const roots = [f.wa, f.wb].map((id) => path.join(f.root, id, 'workspace/src'));
    for (const [index, root] of roots.entries()) {
      expect((await command(root, ['rev-parse', 'HEAD'])).trim()).toBe(repository.head);
      expect((await command(root, ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe(
        `garden/conversations/${index === 0 ? f.a : f.b}`
      );
      expect(await command(root, ['status', '--porcelain'])).toBe('');
      await expect(readFile(path.join(root, '.git/objects/info/alternates'))).rejects.toMatchObject(
        { code: 'ENOENT' }
      );
    }
    await f.write(f.wa, 'src/one.ts', 'export const one = 8;\n');
    await command(roots[0]!, ['add', '--', 'one.ts']);
    await command(roots[0]!, ['commit', '-m', 'Isolated conversation commit']);
    expect((await command(roots[0]!, ['rev-parse', 'HEAD'])).trim()).not.toBe(repository.head);
    expect((await command(roots[1]!, ['rev-parse', 'HEAD'])).trim()).toBe(repository.head);
    expect(await command(roots[1]!, ['status', '--porcelain'])).toBe('');
    expect((await f.manager.repositories(f.project).get(repository.id)).head).toBe(repository.head);
    const proposed = await f.prepare(f.a, ['src'], true);
    expect(proposed.changeCount, proposed.detail ?? '').toBe(1);
    expect(proposed.repositories?.[0]?.tree).not.toBe(repository.head);
    expect(proposed.changes.every((change) => !change.path.includes('.git'))).toBe(true);
  }
);

it('keeps an existing repository and does not prepare Git for a partial directory selection', async () => {
  const f = await fixture();
  await f.connect();
  expect((await f.manager.checkout(f.project, f.b, ['src/one.ts'])).workingCopies).toEqual([]);
  const git = path.join(f.root, f.wb, 'workspace/src/.git');
  await writeFile(git, 'gitdir: /not-a-Garden-repository\n');
  await f.manager.checkout(f.project, f.b, ['src']);
  await f.manager.gitWorkingCopies(f.project).close();
  const copies = await f.manager.gitWorkingCopies(f.project).list();
  expect(copies).toHaveLength(1);
  expect(copies[0]?.state).toBe('blocked');
  expect(await readFile(git, 'utf8')).toBe('gitdir: /not-a-Garden-repository\n');
});

it('recovers an installed Git directory after a lost final acknowledgement without resetting owner commits', async () => {
  const f = await fixture(),
    repository = await f.connect();
  await f.manager.checkout(f.project, f.b, ['src']);
  await f.manager.gitWorkingCopies(f.project).close();
  const copy = (await f.manager.gitWorkingCopies(f.project).list())[0]!;
  expect(copy.state).toBe('ready');
  const root = path.join(f.root, f.wb, 'workspace/src');
  await f.write(f.wb, 'src/one.ts', 'owner commit\n');
  await command(root, ['add', '--', 'one.ts']);
  await command(root, ['commit', '-m', 'Keep this commit']);
  const commit = (await command(root, ['rev-parse', 'HEAD'])).trim();
  const record = path.join(
    f.manager.directory(f.project),
    'state/git-working-copies',
    `${f.wb}_${repository.id}.json`
  );
  await writeFile(record, JSON.stringify({ ...copy, state: 'installing' }));
  const restarted = new ProjectUpdatesManager(f.root, f.execution, async () => {});
  dispose.push(() => restarted.close());
  await restarted.restore();
  await restarted.gitWorkingCopies(f.project).close();
  expect((await restarted.gitWorkingCopies(f.project).list())[0]?.state).toBe('ready');
  expect((await command(root, ['rev-parse', 'HEAD'])).trim()).toBe(commit);
  expect(await readFile(path.join(root, 'one.ts'), 'utf8')).toBe('owner commit\n');
});

it('keeps a prepared working copy usable after managed repository history is removed', async () => {
  const f = await fixture(),
    repository = await f.connect();
  await f.manager.checkout(f.project, f.b, ['src']);
  await f.manager.gitWorkingCopies(f.project).close();
  const root = path.join(f.root, f.wb, 'workspace/src');
  const git = f.manager.repositories(f.project);
  await git.finishRemoval(
    await git.markRemoval(repository.id, { requestId: randomUUID(), head: repository.head })
  );
  expect((await command(root, ['rev-parse', 'HEAD'])).trim()).toBe(repository.head);
  expect(await command(root, ['show', 'HEAD:one.ts'])).toBe('export const one = 1;\n');
});

it('drains preparation before a working-area removal and does not recreate cancelled metadata', async () => {
  const f = await fixture();
  await f.connect();
  let proceed!: () => void, started!: () => void;
  const hold = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const observed = new Promise<void>((resolve) => {
    started = resolve;
  });
  const real = ProjectGit.prototype.exportBundle.bind(f.manager.repositories(f.project));
  vi.spyOn(ProjectGit.prototype, 'exportBundle').mockImplementation(async (...args) => {
    started();
    await hold;
    return real(...args);
  });
  await f.manager.checkout(f.project, f.b, ['src']);
  await observed;
  let deleted = false;
  const remove = f.manager.cancelWorkspace(f.wb).then(async () => {
    await rm(path.join(f.root, f.wb), { recursive: true, force: true });
    deleted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(deleted).toBe(false);
  proceed();
  await remove;
  expect((await f.manager.gitWorkingCopies(f.project).list())[0]?.state).toBe('cancelled');
  await f.manager.gitWorkingCopies(f.project).restore();
  await f.manager.gitWorkingCopies(f.project).close();
  await expect(f.manager.checkout(f.project, f.b, ['src'])).rejects.toThrow(/being removed/);
  await expect(readFile(path.join(f.root, f.wb, 'workspace/src/.git/HEAD'))).rejects.toMatchObject({
    code: 'ENOENT'
  });
});

it('retries failed configuration without copying sources or resetting edits made after setup', async () => {
  const f = await fixture();
  await f.connect();
  vi.spyOn(f.execution, 'start').mockRejectedValueOnce(
    Error('Synthetic command-controller interruption')
  );
  await f.manager.checkout(f.project, f.b, ['src']);
  await f.manager.gitWorkingCopies(f.project).close();
  expect((await f.manager.gitWorkingCopies(f.project).list())[0]?.state).toBe('failed');
  await f.write(f.wb, 'src/one.ts', 'keep the new local edit\n');
  const retried = await f.manager.checkout(f.project, f.b, ['src'], undefined, true);
  expect(retried.files).toEqual([]);
  await f.manager.gitWorkingCopies(f.project).close();
  expect((await f.manager.gitWorkingCopies(f.project).list())[0]?.state).toBe('ready');
  expect(await readFile(path.join(f.root, f.wb, 'workspace/src/one.ts'), 'utf8')).toBe(
    'keep the new local edit\n'
  );
  expect((await f.prepare(f.b, ['src/one.ts'])).changes[0]?.kind).toBe('modified');
});

it.each(['sha1', 'sha256'] as const)(
  'retains conversation %s commits without substituting their tree for the checked candidate',
  async (format) => {
    const f = await fixture(),
      repository = await f.connect(format);
    await f.manager.checkout(f.project, f.a, ['src']);
    await f.manager.gitWorkingCopies(f.project).close();
    const copy = (await f.manager.gitWorkingCopies(f.project).list())[0]!;
    expect(copy).toMatchObject({ state: 'ready', taskId: f.a });
    const source = path.join(f.root, f.wa, 'workspace/src');
    await command(source, ['commit', '--allow-empty', '-m', 'Preserve intermediate reasoning']);
    const head = (await command(source, ['rev-parse', 'HEAD'])).trim();
    expect(head).not.toBe(repository.head);
    const captured = new Map<string, string>();
    f.execution.captureGit = async (working, output) => {
      expect(working.taskId).toBe(f.a);
      await command(source, ['bundle', 'create', output, 'HEAD', '^' + working.base]);
      const sessionId = randomUUID();
      captured.set(sessionId, JSON.stringify({ head, unchanged: false }));
      return { sessionId };
    };
    const poll = f.execution.poll.bind(f.execution);
    f.execution.poll = (workspace, task, session, logs) =>
      captured.has(session)
        ? { status: 'completed', exitCode: 0, ranForMs: 1, stdout: captured.get(session)! }
        : poll(workspace, task, session, logs);
    await f.write(f.wa, 'src/one.ts', 'export const one = 21;\n');
    const update = await f.prepare(f.a, ['src/one.ts'], true);
    expect(update.state, update.detail ?? '').toBe('ready');
    const version = update.repositories![0]!;
    expect(version.sourceCommit).toBe(head);
    const managed = path.join(
      f.manager.directory(f.project),
      'state/repositories',
      repository.id,
      'repository.git'
    );
    expect(
      (await command(managed, ['rev-list', '--parents', '-n', '1', version.commit]))
        .trim()
        .split(' ')
    ).toEqual([version.commit, repository.head, head]);
    expect(await command(managed, ['show', `${version.commit}:one.ts`])).toBe(
      'export const one = 21;\n'
    );
    expect(await command(managed, ['show', `${head}:one.ts`])).toBe('export const one = 1;\n');
    const resumed = await f.manager.rebase(f.project, update.id, randomUUID());
    await f.manager.settle(resumed.id);
    expect((await f.manager.inspect(f.project, resumed.id)).repositories![0]!.sourceCommit).toBe(
      head
    );
    expect(captured.size).toBe(1);
    const { readdir } = await import('node:fs/promises');
    expect(
      (await readdir(path.join(f.root, f.wa, 'workspace/.garden'))).filter((name) =>
        name.startsWith('.garden-history-')
      )
    ).toEqual([]);
  }
);

it('fails preparation explicitly when an installed conversation cannot safely capture its history', async () => {
  const f = await fixture();
  delete f.execution.captureGit;
  await f.connect();
  await f.manager.checkout(f.project, f.a, ['src']);
  await f.manager.gitWorkingCopies(f.project).close();
  await f.write(f.wa, 'src/one.ts', 'export const one = 22;\n');
  const update = await f.prepare(f.a, ['src/one.ts']);
  expect(update.state).toBe('failed');
  expect(update.detail).toContain('Safe conversation Git capture is unavailable');
  expect(await readFile(path.join(f.root, f.wa, 'workspace/src/one.ts'), 'utf8')).toBe(
    'export const one = 22;\n'
  );
});

it('can publish captured history with unchanged source files and refuses a second empty update', async () => {
  const f = await fixture(),
    repository = await f.connect();
  await f.manager.checkout(f.project, f.a, ['src']);
  await f.manager.gitWorkingCopies(f.project).close();
  const source = path.join(f.root, f.wa, 'workspace/src');
  await command(source, ['commit', '--allow-empty', '-m', 'Keep a reviewed checkpoint']);
  const update = await f.prepare(f.a, ['src']);
  expect(update.state, update.detail ?? '').toBe('ready');
  expect(update.changeCount).toBe(0);
  expect(update.repositories).toHaveLength(1);
  expect(update.repositories![0]!.historyChanged).toBe(true);
  const first = await f.manager.publish(
    f.project,
    update.id,
    update.candidateDigest!,
    'Synthetic history-only fixture'
  );
  expect(first.repositories![0]!.commit).not.toBe(repository.head);
  expect(await readFile(path.join(first.path, 'src/one.ts'), 'utf8')).toBe(
    'export const one = 1;\n'
  );
  const repeated = await f.prepare(f.a, ['src']);
  expect(repeated.repositories![0]!.historyChanged).toBe(false);
  await expect(
    f.manager.publish(f.project, repeated.id, repeated.candidateDigest!, 'Duplicate')
  ).rejects.toThrow('not ready');
});
