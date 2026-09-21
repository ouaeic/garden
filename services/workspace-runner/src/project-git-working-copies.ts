import { chmod, chown, lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ProjectGitWorkingCopy, type ProjectRepository } from '@athanor/contracts';
import { withWorkspaceDirectory, workspacePath } from './files.js';
import { durableJson, durableMkdir, syncDirectory } from './project-version-files.js';
import { moveVersionDirectory } from './project-retention-move.js';
import { projectGitCommand as command } from './project-git-command.js';
import type { ProjectGit } from './project-git.js';

/** Workspace Git metadata is independently writable; it cannot modify the managed history store. */
export class ProjectGitWorkingCopies {
  readonly running = new Map<string, Promise<void>>();
  constructor(
    readonly root: string,
    readonly directory: string,
    readonly git: ProjectGit,
    readonly configure: (copy: ProjectGitWorkingCopy) => Promise<void>
  ) {}
  private key(workspaceId: string, repositoryId: string) {
    return `${workspaceId}_${repositoryId}`;
  }
  private file(copy: Pick<ProjectGitWorkingCopy, 'workspaceId' | 'repositoryId'>) {
    return path.join(this.directory, this.key(copy.workspaceId, copy.repositoryId) + '.json');
  }
  private stage(copy: ProjectGitWorkingCopy) {
    return path.join(
      workspacePath(this.root, copy.workspaceId),
      '.athanor',
      'git-copies',
      copy.repositoryId
    );
  }
  private async read(file: string) {
    try {
      return ProjectGitWorkingCopy.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async list(): Promise<ProjectGitWorkingCopy[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const results: ProjectGitWorkingCopy[] = [];
    for (const name of names.sort()) {
      if (!/^[a-f0-9-]{36}_[a-f0-9-]{36}\.json$/.test(name)) continue;
      const copy = await this.read(path.join(this.directory, name));
      if (copy) results.push(copy);
    }
    return results;
  }
  async start(
    repository: ProjectRepository,
    input: Pick<ProjectGitWorkingCopy, 'taskId' | 'workspaceId' | 'revisionId' | 'base'>
  ) {
    const candidate = ProjectGitWorkingCopy.parse({
      ...input,
      repositoryId: repository.id,
      path: repository.path,
      branch: `garden/conversations/${input.taskId}`,
      state: 'preparing',
      createdAt: new Date().toISOString(),
      detail: null
    });
    const old = await this.read(this.file(candidate));
    if (old) {
      if (old.taskId !== candidate.taskId || old.path !== candidate.path)
        throw Error('Conversation Git working-copy identity changed');
      if (old.state === 'failed') {
        old.state = old.identity ? 'installing' : 'preparing';
        old.detail = null;
        await durableJson(this.file(old), old);
      }
      if (old.state === 'preparing' || old.state === 'installing') this.launch(old);
      return old;
    }
    await durableJson(this.file(candidate), candidate);
    this.launch(candidate);
    return structuredClone(candidate);
  }
  async restore() {
    for (const copy of await this.list())
      if (copy.state === 'preparing' || copy.state === 'installing') this.launch(copy);
  }
  private launch(copy: ProjectGitWorkingCopy) {
    const key = this.key(copy.workspaceId, copy.repositoryId);
    if (this.running.has(key)) return;
    const work = this.prepare(copy).catch(async (error: unknown) => {
      copy.state = 'failed';
      copy.detail = String(error);
      await durableJson(this.file(copy), copy);
    });
    this.running.set(key, work);
    void work.finally(() => this.running.delete(key)).catch(() => undefined);
  }
  private async destination(copy: ProjectGitWorkingCopy) {
    const root = workspacePath(this.root, copy.workspaceId);
    return withWorkspaceDirectory(
      root,
      path.join('workspace', copy.path),
      false,
      async (directory) =>
        lstat(path.join(directory, '.git')).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        })
    );
  }
  private async prepare(copy: ProjectGitWorkingCopy) {
    const root = workspacePath(this.root, copy.workspaceId),
      stage = this.stage(copy);
    const destination = await this.destination(copy);
    if (destination) {
      if (
        copy.state === 'installing' &&
        destination.isDirectory() &&
        destination.dev === copy.identity?.dev &&
        destination.ino === copy.identity.ino
      ) {
        await this.configure(copy);
        copy.state = 'ready';
        copy.detail = null;
      } else {
        copy.state = 'blocked';
        copy.detail = 'An existing repository was kept. Garden did not replace its Git metadata.';
      }
      await durableJson(this.file(copy), copy);
      if (copy.state === 'ready') await rm(stage, { recursive: true, force: true });
      return;
    }
    if (copy.state === 'preparing') {
      await rm(stage, { recursive: true, force: true });
      await durableMkdir(stage, 0o700);
      const repository = await this.git.get(copy.repositoryId);
      await this.git.exportBundle(copy.repositoryId, copy.base, path.join(stage, 'export'));
      const git = path.join(stage, 'metadata');
      await command(stage, [
        'init',
        '--bare',
        '--template=',
        `--object-format=${repository.format}`,
        git
      ]);
      await command(git, [
        '-c',
        'protocol.file.allow=always',
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        path.join(stage, 'export/workspace/repository.bundle'),
        `refs/heads/${repository.branch}:refs/heads/${copy.branch}`
      ]);
      await command(git, ['symbolic-ref', 'HEAD', `refs/heads/${copy.branch}`]);
      await command(git, ['read-tree', copy.base]);
      await command(git, ['config', 'core.bare', 'false']);
      await command(git, ['config', 'core.hooksPath', '/dev/null']);
      await command(git, ['config', 'core.fsmonitor', 'false']);
      await command(git, ['config', 'gc.auto', '0']);
      await command(git, ['config', 'user.name', 'Garden']);
      await command(git, ['config', 'user.email', 'garden@localhost']);
      const gid = await withWorkspaceDirectory(
        root,
        'workspace',
        false,
        async (directory) => (await lstat(directory + '/.')).gid
      );
      const share = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const filename = path.join(directory, entry.name);
          if (entry.isDirectory()) await share(filename);
          else {
            if (!entry.isFile()) throw Error('Prepared Git metadata contains an unsupported file');
            await chown(filename, -1, gid);
            await chmod(filename, 0o660);
          }
        }
        await chown(directory, -1, gid);
        await chmod(directory, 0o770);
        await syncDirectory(directory);
      };
      await share(git);
      const identity = await lstat(git);
      copy.identity = { dev: identity.dev, ino: identity.ino };
      copy.state = 'installing';
      await durableJson(this.file(copy), copy);
    }
    const metadata = path.join(stage, 'metadata'),
      identity = await lstat(metadata);
    if (
      !identity.isDirectory() ||
      identity.dev !== copy.identity?.dev ||
      identity.ino !== copy.identity.ino
    )
      throw Error('Prepared Git metadata changed before installation');
    await moveVersionDirectory(
      this.root,
      path.relative(this.root, metadata),
      path.relative(this.root, path.join(root, 'workspace', copy.path, '.git'))
    );
    await withWorkspaceDirectory(
      root,
      path.join('workspace', copy.path),
      false,
      async (directory, held) => {
        if (held) await held.sync();
        else await syncDirectory(directory);
      }
    );
    await this.configure(copy);
    copy.state = 'ready';
    copy.detail = null;
    await durableJson(this.file(copy), copy);
    await rm(stage, { recursive: true, force: true });
  }
  async close() {
    await Promise.allSettled(this.running.values());
  }
  async cancelWorkspace(workspaceId: string) {
    await Promise.allSettled(
      [...this.running].filter(([key]) => key.startsWith(workspaceId + '_')).map(([, run]) => run)
    );
    for (const copy of await this.list())
      if (copy.workspaceId === workspaceId) {
        copy.state = 'cancelled';
        copy.detail = 'This conversation working area was removed.';
        await durableJson(this.file(copy), copy);
        await rm(this.stage(copy), { recursive: true, force: true });
      }
  }
}
