import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import type { ProjectGitRemoteInput } from '@athanor/contracts';
import { ensureWorkspace } from './files.js';
import { ProjectVersionFiles } from './project-version-files.js';
import { ProjectGit } from './project-git.js';
import { ProjectGitRemotes } from './project-git-remotes.js';
import { githubGitTransport, type GitRemoteTransport } from './project-git-transport.js';
import { projectGitCommand as command } from './project-git-command.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const token = 'private-github-token-canary';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-git-remote-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const files = new ProjectVersionFiles(path.join(root, 'files'));
  const git = new ProjectGit(path.join(root, 'managed'), files);
  const repository = await git.create(
    { requestId: randomUUID(), revisionId: randomUUID(), name: 'Source', path: '', branch: 'main' },
    { 'one.txt': await files.put(Buffer.from('one\n')) }
  );
  const remote = path.join(root, 'remote.git');
  await command(root, ['init', '--bare', '--template=', remote]);
  let pushes = 0;
  const transport = (
    directory: string,
    input: ProjectGitRemoteInput,
    credential: string,
    signal: AbortSignal
  ): GitRemoteTransport => {
    const native = githubGitTransport(
      directory,
      input,
      credential,
      signal,
      async (dir, args, stdin, options) => {
        expect(options?.env?.GIT_CONFIG_VALUE_0).toContain(
          Buffer.from('x-access-token:' + token).toString('base64')
        );
        expect(args.join(' ')).not.toContain(token);
        if (args.includes('push')) pushes++;
        return command(
          dir,
          [
            '-c',
            'protocol.file.allow=always',
            ...args.map((arg) =>
              arg === `https://github.com/${input.owner}/${input.repository}.git` ? remote : arg
            )
          ],
          stdin,
          options
        );
      }
    );
    return native;
  };
  const revisionId = randomUUID();
  let checked = 0;
  const check = async (input: Extract<ProjectGitRemoteInput, { action: 'push' }>) => {
    expect(input.revisionId).toBe(revisionId);
    expect(input.commit).toBe((await git.get(repository.id)).head);
    checked++;
  };
  const create = (factory = transport) => {
    const service = new ProjectGitRemotes(
      root,
      path.join(root, 'operations'),
      git,
      check,
      (run) => run(),
      factory
    );
    cleanup.push(() => service.close());
    return service;
  };
  const input = (action: 'fetch' | 'push', extra: Record<string, unknown> = {}) => ({
    action,
    requestId: randomUUID(),
    repositoryId: repository.id,
    connectorId: randomUUID(),
    owner: 'fixture',
    repository: 'private',
    branch: 'main',
    ...(action === 'push' ? { revisionId, commit: repository.head, expectedHead: null } : {}),
    ...extra
  });
  const settle = async (service: ProjectGitRemotes) => {
    expect(service.running.size).toBeGreaterThan(0);
    await Promise.all(service.running.values());
  };
  return {
    root,
    files,
    git,
    repository,
    remote,
    create,
    transport,
    input,
    settle,
    pushes: () => pushes,
    checked: () => checked
  };
}
const actor = { taskId: null, workspaceId: null };
it('publishes a bound commit once through native Git and retains no credentials in its journal', async () => {
  const f = await fixture(),
    service = f.create(),
    input = f.input('push');
  const started = await service.start(input, actor, token);
  expect(started.state).toBe('running');
  await f.settle(service);
  expect((await service.get(String(input.requestId))).state).toBe('succeeded');
  expect((await command(f.remote, ['rev-parse', 'refs/heads/main'])).trim()).toBe(
    f.repository.head
  );
  await service.start(input, actor, token);
  expect(f.pushes()).toBe(1);
  expect(f.checked()).toBe(1);
  const journal = await readFile(
    path.join(f.root, 'operations', String(input.requestId) + '.json'),
    'utf8'
  );
  expect(journal).not.toContain(token);
  expect(journal).not.toContain(Buffer.from('x-access-token:' + token).toString('base64'));
  await expect(service.start({ ...input, branch: 'different' }, actor, token)).rejects.toThrow(
    'identity changed'
  );
});
it('reconciles a lost publication acknowledgement without repeating its write', async () => {
  const f = await fixture();
  let refuseRead = false;
  const service = f.create((...args) => {
    const native = f.transport(...args);
    return {
      ...native,
      head: async () => {
        if (refuseRead) throw Error('offline');
        return native.head();
      },
      push: async (commit, expected) => {
        await native.push(commit, expected);
        refuseRead = true;
        throw Error('reply lost');
      }
    };
  });
  const input = f.input('push');
  await service.start(input, actor, token);
  await f.settle(service);
  expect((await service.get(String(input.requestId))).state).toBe('uncertain');
  await service.close();
  const restored = f.create();
  await restored.restore();
  expect(f.pushes()).toBe(1);
  await restored.reconcile(String(input.requestId), String(input.connectorId), token);
  await f.settle(restored);
  expect((await restored.get(String(input.requestId))).state).toBe('succeeded');
  expect(f.pushes()).toBe(1);
});
it('fetches a captured branch without moving the managed published branch', async () => {
  const f = await fixture(),
    service = f.create();
  const pushed = f.input('push');
  await service.start(pushed, actor, token);
  await f.settle(service);
  const tree = (
    await command(f.remote, ['rev-parse', 'HEAD^{tree}']).catch(() =>
      command(f.remote, ['rev-parse', 'refs/heads/main^{tree}'])
    )
  ).trim();
  const next = (
    await command(
      f.remote,
      ['commit-tree', tree, '-p', f.repository.head, '-m', 'Remote change'],
      undefined,
      {
        env: {
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@localhost',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@localhost'
        }
      }
    )
  ).trim();
  await command(f.remote, ['update-ref', 'refs/heads/main', next, f.repository.head]);
  const input = f.input('fetch');
  await service.start(input, actor, token);
  await f.settle(service);
  expect(await service.get(String(input.requestId))).toMatchObject({
    state: 'succeeded',
    commit: next
  });
  expect((await f.git.get(f.repository.id)).head).toBe(f.repository.head);
  const rejected = f.input('push', { expectedHead: next });
  await service.start(rejected, actor, token);
  await f.settle(service);
  expect((await service.get(String(rejected.requestId))).state).toBe('rejected');
  expect(f.pushes()).toBe(1);
  expect((await command(f.remote, ['rev-parse', 'refs/heads/main'])).trim()).toBe(next);
});

it('keeps a concurrent remote update when its head changes after inspection', async () => {
  const f = await fixture();
  let concurrent = '';
  const service = f.create((...args) => {
    const native = f.transport(...args);
    return {
      ...native,
      push: async (commit, expected) => {
        await command(f.remote, [
          '-c',
          'protocol.file.allow=always',
          'fetch',
          '--',
          await f.git.nativeDirectory(f.repository.id),
          `${commit}:refs/heads/main`
        ]);
        const tree = (await command(f.remote, ['rev-parse', 'refs/heads/main^{tree}'])).trim();
        concurrent = (
          await command(
            f.remote,
            ['commit-tree', tree, '-p', commit, '-m', 'Concurrent change'],
            undefined,
            {
              env: {
                GIT_AUTHOR_NAME: 'Fixture',
                GIT_AUTHOR_EMAIL: 'fixture@localhost',
                GIT_COMMITTER_NAME: 'Fixture',
                GIT_COMMITTER_EMAIL: 'fixture@localhost'
              }
            }
          )
        ).trim();
        await command(f.remote, ['update-ref', 'refs/heads/main', concurrent, commit]);
        await native.push(commit, expected);
      }
    };
  });
  const input = f.input('push');
  await service.start(input, actor, token);
  await f.settle(service);
  expect(concurrent).not.toBe('');
  expect((await command(f.remote, ['rev-parse', 'refs/heads/main'])).trim()).toBe(concurrent);
  expect(await service.get(String(input.requestId))).toMatchObject({
    state: 'uncertain',
    commit: concurrent
  });
  expect(f.pushes()).toBe(1);
});

it('delivers a complete captured bundle only to its conversation and preserves existing files', async () => {
  const f = await fixture(),
    service = f.create();
  await service.start(f.input('push'), actor, token);
  await f.settle(service);
  const participant = { taskId: randomUUID(), workspaceId: randomUUID() };
  await ensureWorkspace(path.join(f.root, participant.workspaceId));
  const input = f.input('fetch');
  await service.start(input, participant, token);
  await f.settle(service);
  const record = await service.get(String(input.requestId));
  expect(record.state).toBe('succeeded');
  expect(record.bundlePath).toBeTruthy();
  const bundle = path.join(f.root, participant.workspaceId, record.bundlePath!);
  expect((await stat(bundle)).mode & 0o777).toBe(0o640);
  expect(
    await command(await f.git.nativeDirectory(f.repository.id), ['bundle', 'list-heads', bundle])
  ).toContain(f.repository.head + ' refs/heads/main');
  await expect(
    service.start(input, { ...participant, workspaceId: randomUUID() }, token)
  ).rejects.toThrow('identity changed');
  await expect(service.reconcile(String(input.requestId), randomUUID(), token)).rejects.toThrow(
    'original connected account'
  );
  const before = await readFile(bundle);
  await service.cancelWorkspace(participant.workspaceId);
  await expect(service.start(f.input('fetch'), participant, token)).rejects.toThrow(
    'being removed'
  );
  expect(await readFile(bundle)).toEqual(before);
});

it('reports a missing remote branch without creating or publishing anything', async () => {
  const f = await fixture(),
    service = f.create(),
    input = f.input('fetch');
  await service.start(input, actor, token);
  await f.settle(service);
  expect(await service.get(String(input.requestId))).toMatchObject({
    state: 'succeeded',
    commit: null,
    bundlePath: null
  });
  expect(f.pushes()).toBe(0);
  expect((await command(f.remote, ['for-each-ref'])).trim()).toBe('');
});
