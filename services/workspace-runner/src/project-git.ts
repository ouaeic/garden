import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  GitObjectId,
  ProjectRepositoryInput,
  ProjectRepositoryRemoval,
  ProjectRepositoryRemovalInput,
  type ProjectGitVersion,
  type ProjectRepository,
  type ProjectRepositoryHistory
} from '@athanor/contracts';
import {
  type ProjectVersionFiles,
  durableJson,
  durableMkdir,
  projectPath,
  syncDirectory,
  type VersionTree
} from './project-version-files.js';
import { projectGitCommand as command } from './project-git-command.js';
import { projectGitTree } from './project-git-tree.js';
import { assertHostStorageWrite } from './host-storage.js';

const id = (value: string) => z.uuid().parse(value);
const object = (value: string) => GitObjectId.parse(value.trim());
const read = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};
type Connection = Omit<ProjectRepository, 'head'>;

/** Git identities accompany immutable project versions; a moving ref never identifies a test. */
export class ProjectGit {
  constructor(
    readonly directory: string,
    readonly files: ProjectVersionFiles
  ) {}
  private location(repositoryId: string) {
    return path.join(this.directory, id(repositoryId));
  }
  private git(repositoryId: string) {
    return path.join(this.location(repositoryId), 'repository.git');
  }
  private async connection(repositoryId: string): Promise<Connection> {
    const result = await read<Connection>(
      path.join(this.location(repositoryId), 'connection.json')
    );
    if (!result) throw Error('Repository connection not found');
    return result;
  }
  private async head(repositoryId: string, branch: string): Promise<string> {
    return object(
      await command(this.git(repositoryId), [
        'rev-parse',
        '--verify',
        `refs/heads/${branch}^{commit}`
      ])
    );
  }
  async get(repositoryId: string): Promise<ProjectRepository> {
    if (await read(path.join(this.location(repositoryId), 'removal.json')))
      throw Error('This managed repository has been removed');
    const connection = await this.connection(repositoryId);
    return { ...connection, head: await this.head(repositoryId, connection.branch) };
  }
  async list(): Promise<ProjectRepository[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const values: ProjectRepository[] = [];
    for (const name of names.sort()) {
      if (!z.uuid().safeParse(name).success) continue;
      if (
        !(await read(path.join(this.location(name), 'removal.json'))) &&
        (await read(path.join(this.location(name), 'connection.json')))
      )
        values.push(await this.get(name));
    }
    return values;
  }
  async removals(): Promise<ProjectRepositoryRemoval[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const records: ProjectRepositoryRemoval[] = [];
    for (const name of names.sort())
      if (z.uuid().safeParse(name).success) {
        const receipt = await read(path.join(this.location(name), 'removal.json'));
        if (receipt) records.push(ProjectRepositoryRemoval.parse(receipt));
      }
    return records;
  }
  async markRemoval(repositoryId: string, raw: unknown): Promise<ProjectRepositoryRemoval> {
    const input = ProjectRepositoryRemovalInput.parse(raw);
    const file = path.join(this.location(repositoryId), 'removal.json');
    const previous = await read<ProjectRepositoryRemoval>(file);
    if (previous) {
      if (previous.requestId !== input.requestId || previous.head !== input.head)
        throw Error('Repository removal identity changed');
      return previous;
    }
    const repository = await this.get(repositoryId);
    if (repository.head !== input.head)
      throw Error('The repository changed. Review its current history before removing it.');
    const receipt: ProjectRepositoryRemoval = {
      ...input,
      repositoryId,
      name: repository.name,
      createdAt: new Date().toISOString(),
      state: 'removing',
      detail: null
    };
    await durableJson(file, receipt);
    return receipt;
  }
  async finishRemoval(receipt: ProjectRepositoryRemoval): Promise<void> {
    if (receipt.state === 'removed') return;
    const directory = this.location(receipt.repositoryId),
      file = path.join(directory, 'removal.json');
    receipt.state = 'removing';
    receipt.detail = null;
    await durableJson(file, receipt);
    try {
      for (const name of ['repository.git', 'object-cache', 'blobs'])
        await rm(path.join(directory, name), { recursive: true, force: true });
      for (const name of await readdir(directory))
        if (/^[a-f0-9-]{36}\.marks$/.test(name)) await rm(path.join(directory, name));
      await syncDirectory(directory);
      receipt.state = 'removed';
    } catch (error) {
      receipt.state = 'failed';
      receipt.detail = String(error);
    }
    await durableJson(file, receipt);
  }
  async create(
    raw: unknown,
    files: VersionTree,
    progress: (files: number, bytes: number) => Promise<void> = async () => {}
  ): Promise<ProjectRepository> {
    const input = ProjectRepositoryInput.parse(raw);
    if (await read(path.join(this.location(input.requestId), 'removal.json')))
      throw Error('This repository request has been removed. Start a new repository instead.');
    const prefix = projectPath(input.path ? `workspace/${input.path}` : 'workspace');
    const request = { ...input, path: prefix };
    const directory = this.location(input.requestId);
    const previous = await read<{ request: typeof request; createdAt: string }>(
      path.join(directory, 'creation.json')
    );
    if (previous && JSON.stringify(previous.request) !== JSON.stringify(request))
      throw Error('Repository request identity changed');
    if (await read(path.join(directory, 'connection.json'))) return this.get(input.requestId);
    const others = await this.list();
    if (
      others.some(
        (item) =>
          item.path === prefix ||
          !item.path ||
          !prefix ||
          item.path.startsWith(prefix + '/') ||
          prefix.startsWith(item.path + '/')
      )
    )
      throw Error('Repository source directories must not overlap');
    if (!Object.keys(files).some((name) => !prefix || name.startsWith(prefix + '/')))
      throw Error('Publish source files in this directory before connecting Git');
    await durableMkdir(directory, 0o700);
    const createdAt = previous?.createdAt ?? new Date().toISOString();
    await durableJson(path.join(directory, 'creation.json'), { request, createdAt });
    await command(directory, ['check-ref-format', `refs/heads/${input.branch}`]);
    await command(directory, [
      'init',
      '--bare',
      '--template=',
      `--initial-branch=${input.branch}`,
      `--object-format=${input.format}`,
      this.git(input.requestId)
    ]);
    const imported = input.historyPath
      ? await this.importHistory(input.requestId, input.historyPath, input.branch, files)
      : null;
    const tree = await this.tree(input.requestId, prefix, files, progress);
    const inheritedTree = imported
      ? object(
          await command(this.git(input.requestId), ['rev-parse', '--verify', `${imported}^{tree}`])
        )
      : null;
    const commit =
      inheritedTree === tree
        ? imported!
        : await this.commit(
            input.requestId,
            tree,
            imported ? [imported] : [],
            `Start ${input.name}`,
            createdAt
          );
    const ref = `refs/heads/${input.branch}`;
    const old = await command(this.git(input.requestId), ['show-ref', '--hash', '--verify', ref])
      .then((v) => object(v))
      .catch(() => null);
    if (old && old !== commit) throw Error('Repository initialization identity changed');
    if (!old)
      await command(this.git(input.requestId), [
        'update-ref',
        '--no-deref',
        ref,
        commit,
        '0'.repeat(commit.length)
      ]);
    await durableJson(path.join(directory, 'connection.json'), {
      id: input.requestId,
      name: input.name,
      path: prefix,
      branch: input.branch,
      format: input.format,
      createdAt
    } satisfies Connection);
    return this.get(input.requestId);
  }
  private async importHistory(
    repositoryId: string,
    selected: string,
    branch: string,
    files: VersionTree
  ): Promise<string> {
    const filename = projectPath(`workspace/${selected}`);
    const fact = files[filename];
    if (!fact) throw Error('Choose a complete Git bundle from this published version');
    const handle = await open(this.files.object(fact), constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256');
    let size = 0;
    try {
      const chunks: AsyncIterable<unknown> = handle.createReadStream({ autoClose: false });
      for await (const chunk of chunks) {
        if (!Buffer.isBuffer(chunk)) throw Error('Invalid history bundle bytes');
        hash.update(chunk);
        size += chunk.length;
      }
    } finally {
      await handle.close();
    }
    if (size !== fact.bytes || hash.digest('hex') !== fact.sha256)
      throw Error('The history bundle changed');
    await assertHostStorageWrite(this.directory, fact.bytes + 4096);
    const bundle = this.files.object(fact);
    await command(this.git(repositoryId), ['bundle', 'verify', bundle]);
    const raw = await command(this.git(repositoryId), ['bundle', 'unbundle', bundle]);
    const refs = raw
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const split = line.indexOf(' ');
        return { commit: object(line.slice(0, split)), name: line.slice(split + 1) };
      });
    const target = refs.find((ref) => ref.name === `refs/heads/${branch}`);
    if (!target) throw Error('The selected branch is not present in the history bundle');
    await command(this.git(repositoryId), ['fsck', '--strict', '--no-reflogs', '--no-dangling']);
    for (const ref of refs) {
      if (ref.name === 'HEAD') continue;
      if (!ref.name.startsWith('refs/')) throw Error('Invalid history reference');
      await command(this.git(repositoryId), ['check-ref-format', ref.name]);
      const preserved = `refs/garden/imported/${ref.name.slice(5)}`;
      const existing = await command(this.git(repositoryId), [
        'show-ref',
        '--hash',
        '--verify',
        preserved
      ])
        .then(object)
        .catch(() => null);
      if (existing && existing !== ref.commit) throw Error('Imported history identity changed');
      if (!existing)
        await command(this.git(repositoryId), [
          'update-ref',
          '--no-deref',
          preserved,
          ref.commit,
          '0'.repeat(ref.commit.length)
        ]);
    }
    return object(
      await command(this.git(repositoryId), ['rev-parse', '--verify', `${target.commit}^{commit}`])
    );
  }
  private tree(
    repositoryId: string,
    prefix: string,
    files: VersionTree,
    progress: (files: number, bytes: number) => Promise<void> = async () => {}
  ) {
    return projectGitTree(this.location(repositoryId), this.files, prefix, files, progress);
  }
  private commit(
    repositoryId: string,
    tree: string,
    parents: string[],
    title: string,
    date: string
  ): Promise<string> {
    const stamp = `${Math.floor(Date.parse(date) / 1000)} +0000`;
    return command(
      this.git(repositoryId),
      [
        'commit-tree',
        object(tree),
        ...[...new Set(parents)].flatMap((parent) => ['-p', object(parent)]),
        '-F',
        '-'
      ],
      title + '\n',
      {
        env: {
          GIT_AUTHOR_NAME: 'Garden',
          GIT_AUTHOR_EMAIL: 'garden@localhost',
          GIT_COMMITTER_NAME: 'Garden',
          GIT_COMMITTER_EMAIL: 'garden@localhost',
          GIT_AUTHOR_DATE: stamp,
          GIT_COMMITTER_DATE: stamp
        }
      }
    ).then(object);
  }
  async prepare(
    update: { id: string; taskId: string; title: string; createdAt: string },
    files: VersionTree,
    previous: ProjectGitVersion[] = []
  ): Promise<ProjectGitVersion[]> {
    const results: ProjectGitVersion[] = [];
    for (const repository of await this.list()) {
      const tree = await this.tree(repository.id, repository.path, files);
      const commit = await this.commit(
        repository.id,
        tree,
        [
          repository.head,
          ...previous
            .filter((item) => item.repositoryId === repository.id)
            .map((item) => item.commit)
        ],
        update.title,
        update.createdAt
      );
      const proposalRef = `refs/garden/proposals/${id(update.taskId)}/${id(update.id)}/${commit}`;
      const existing = await command(this.git(repository.id), [
        'show-ref',
        '--hash',
        '--verify',
        proposalRef
      ])
        .then(object)
        .catch(() => null);
      if (existing && existing !== commit) throw Error('Proposal reference identity changed');
      if (!existing)
        await command(this.git(repository.id), [
          'update-ref',
          '--no-deref',
          proposalRef,
          commit,
          '0'.repeat(commit.length)
        ]);
      results.push({
        repositoryId: repository.id,
        branch: repository.branch,
        base: repository.head,
        commit,
        tree,
        proposalRef
      });
    }
    return results;
  }
  async assertCurrent(versions: ProjectGitVersion[]): Promise<void> {
    const repositories = await this.list();
    if (
      repositories.length !== versions.length ||
      repositories.some((item) => !versions.some((v) => v.repositoryId === item.id))
    )
      throw Error('Repository connections changed. Rebuild and check the combined update.');
    for (const version of versions) {
      const repository = await this.get(version.repositoryId);
      if (
        repository.branch !== version.branch ||
        (repository.head !== version.base && repository.head !== version.commit)
      )
        throw Error('The repository branch changed. Rebuild and check the combined update.');
      const tree = object(
        await command(this.git(repository.id), [
          'rev-parse',
          '--verify',
          `${object(version.commit)}^{tree}`
        ])
      );
      if (tree !== version.tree) throw Error('Repository commit identity changed');
    }
  }
  async publish(versions: ProjectGitVersion[]): Promise<void> {
    await this.assertCurrent(versions);
    for (const version of versions) {
      if ((await this.get(version.repositoryId)).head === version.commit) continue;
      await command(this.git(version.repositoryId), [
        'update-ref',
        '--no-deref',
        `refs/heads/${version.branch}`,
        object(version.commit),
        object(version.base)
      ]);
    }
  }
  async exportBundle(repositoryId: string, commit: string, destination: string): Promise<number> {
    const repository = await this.get(repositoryId);
    await command(this.git(repositoryId), [
      'merge-base',
      '--is-ancestor',
      object(commit),
      repository.head
    ]);
    const usage = await command(this.git(repositoryId), ['count-objects', '-v']);
    const sizes = usage.split('\n').flatMap((line) => {
      const match = /^(?:size|size-pack): ([0-9]+)$/.exec(line);
      return match ? [Number(match[1]) * 1024] : [];
    });
    if (sizes.length !== 2 || sizes.some((size) => !Number.isSafeInteger(size)))
      throw Error('Repository storage could not be measured');
    await assertHostStorageWrite(
      this.directory,
      sizes.reduce((sum, size) => sum + size, 0)
    );
    await durableMkdir(destination, 0o700);
    const staging = path.join(destination, 'staging.git');
    await rm(staging, { recursive: true, force: true });
    await command(destination, [
      'init',
      '--bare',
      '--template=',
      `--object-format=${repository.format}`,
      staging
    ]);
    await writeFile(
      path.join(staging, 'objects/info/alternates'),
      this.git(repositoryId) + '/objects\n',
      { mode: 0o600 }
    );
    await command(staging, [
      'update-ref',
      '--no-deref',
      `refs/heads/${repository.branch}`,
      object(commit),
      '0'.repeat(commit.length)
    ]);
    const output = path.join(destination, 'workspace');
    await durableMkdir(output, 0o700);
    const partial = path.join(output, 'repository.bundle.partial');
    await rm(partial, { force: true });
    await rm(partial + '.lock', { force: true });
    await command(staging, ['bundle', 'create', partial, `refs/heads/${repository.branch}`]);
    const handle = await open(partial, constants.O_RDONLY | constants.O_NOFOLLOW);
    let size: number;
    try {
      size = (await handle.stat()).size;
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(partial, path.join(output, 'repository.bundle'));
    await syncDirectory(output);
    await rm(staging, { recursive: true, force: true });
    return size;
  }
  async history(repositoryId: string, before?: string): Promise<ProjectRepositoryHistory> {
    const repository = await this.get(repositoryId);
    const start = before ? object(before) : repository.head;
    await command(this.git(repositoryId), ['merge-base', '--is-ancestor', start, repository.head]);
    const raw = await command(this.git(repositoryId), [
      'log',
      '--first-parent',
      '--max-count=51',
      '--format=%H%x00%P%x00%aI%x00%s',
      '-z',
      start,
      '--'
    ]);
    const fields = raw.split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 4) throw Error('Repository history could not be decoded');
    const commits = [];
    for (let i = 0; i < fields.length; i += 4)
      commits.push({
        id: object(fields[i]!),
        parents: fields[i + 1] ? fields[i + 1]!.split(' ').map(object) : [],
        date: fields[i + 2]!,
        subject: fields[i + 3]!
      });
    const refs = await command(this.git(repositoryId), [
      'for-each-ref',
      '--count=201',
      '--format=%(refname)%00%(objectname)',
      'refs/heads/',
      'refs/garden/proposals/',
      'refs/garden/imported/'
    ]);
    const branches = refs
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, commit] = line.split('\0');
        if (!name?.startsWith('refs/')) throw Error('Invalid reference');
        return {
          name: name.startsWith('refs/heads/') ? name.slice(11) : name,
          commit: object(commit!)
        };
      });
    return {
      repository,
      commits: commits.slice(0, 50),
      next: commits[50]?.id ?? null,
      branches: branches.slice(0, 200),
      branchesTruncated: branches.length > 200
    };
  }
}
