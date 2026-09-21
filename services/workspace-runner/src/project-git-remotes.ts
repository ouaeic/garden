import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, copyFile, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { GitObjectId, ProjectGitRemoteInput, ProjectGitRemoteOperation } from '@athanor/contracts';
import { z } from 'zod';
import { withWorkspaceDirectory, workspacePath } from './files.js';
import { durableJson, syncDirectory } from './project-version-files.js';
import { assertHostStorageWrite } from './host-storage.js';
import { projectGitCommand as command, projectGitIsAncestor } from './project-git-command.js';
import { githubGitTransport, type GitRemoteTransport } from './project-git-transport.js';
import type { ProjectGit } from './project-git.js';

const stamp = () => new Date().toISOString();
type Actor = { taskId: string | null; workspaceId: string | null };
type Transport = (
  directory: string,
  input: ProjectGitRemoteInput,
  credential: string,
  signal: AbortSignal
) => GitRemoteTransport;

/** Remote writes have durable intent and explicit reconciliation; restart never repeats a push. */
export class ProjectGitRemotes {
  readonly running = new Map<string, Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #locks = new Map<string, Promise<unknown>>();
  #closed = false;
  readonly #removedWorkspaces = new Set<string>();
  constructor(
    readonly root: string,
    readonly directory: string,
    readonly git: ProjectGit,
    readonly checkPublication: (
      input: Extract<ProjectGitRemoteInput, { action: 'push' }>
    ) => Promise<void>,
    readonly protect: <T>(operation: () => Promise<T>) => Promise<T>,
    readonly transport: Transport = githubGitTransport
  ) {}
  private file(requestId: string) {
    return path.join(this.directory, z.uuid().parse(requestId) + '.json');
  }
  private async save(record: ProjectGitRemoteOperation) {
    record.updatedAt = stamp();
    await durableJson(this.file(record.input.requestId), record);
  }
  async get(requestId: string) {
    return ProjectGitRemoteOperation.parse(
      JSON.parse(await readFile(this.file(requestId), 'utf8'))
    );
  }
  async list() {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const records: ProjectGitRemoteOperation[] = [];
    for (const name of names)
      if (/^[a-f0-9-]{36}\.json$/.test(name)) records.push(await this.get(name.slice(0, -5)));
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }
  private locked<T>(requestId: string, action: () => Promise<T>): Promise<T> {
    const run = (this.#locks.get(requestId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.#locks.set(requestId, run);
    void run
      .finally(() => {
        if (this.#locks.get(requestId) === run) this.#locks.delete(requestId);
      })
      .catch(() => {});
    return run;
  }
  async start(raw: unknown, actor: Actor, credential: string) {
    const input = ProjectGitRemoteInput.parse(raw);
    return this.locked(input.requestId, async () => {
      if (this.#closed) throw Error('Repository transfers are stopping');
      if (actor.workspaceId && this.#removedWorkspaces.has(actor.workspaceId))
        throw Error('This conversation working area is being removed');
      let previous: ProjectGitRemoteOperation | undefined;
      try {
        previous = await this.get(input.requestId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (previous) {
        if (
          JSON.stringify(previous.input) !== JSON.stringify(input) ||
          previous.taskId !== actor.taskId ||
          previous.workspaceId !== actor.workspaceId
        )
          throw Error('Remote operation identity changed');
        return previous;
      }
      const directory = await this.git.nativeDirectory(input.repositoryId);
      await command(directory, ['check-ref-format', `refs/heads/${input.branch}`]);
      if (input.action === 'push') await this.checkPublication(input);
      const record: ProjectGitRemoteOperation = {
        input,
        ...actor,
        state: 'running',
        phase: input.action === 'fetch' ? 'fetching' : 'checking',
        createdAt: stamp(),
        updatedAt: stamp(),
        commit: null,
        bundlePath: null,
        detail: null
      };
      await this.save(record);
      const response = structuredClone(record);
      this.launch(record, credential, false);
      return response;
    });
  }
  async reconcile(requestId: string, connectorId: string, credential: string) {
    return this.locked(requestId, async () => {
      if (this.#closed) throw Error('Repository transfers are stopping');
      const record = await this.get(requestId);
      if (record.workspaceId && this.#removedWorkspaces.has(record.workspaceId))
        throw Error('This conversation working area is being removed');
      if (record.input.connectorId !== connectorId)
        throw Error('Use the original connected account to inspect this transfer');
      if (this.running.has(requestId) || ['succeeded', 'rejected'].includes(record.state))
        return record;
      record.state = 'running';
      record.phase = record.input.action === 'push' ? 'verifying' : 'fetching';
      await this.save(record);
      const response = structuredClone(record);
      this.launch(record, credential, true);
      return response;
    });
  }
  private launch(record: ProjectGitRemoteOperation, credential: string, reconcile: boolean) {
    const id = record.input.requestId;
    if (this.running.has(id)) return;
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    const run = this.protect(async () => {
      controller.signal.throwIfAborted();
      await assertHostStorageWrite(this.root);
      let probing = false;
      const monitor = setInterval(() => {
        if (probing) return;
        probing = true;
        void assertHostStorageWrite(this.root)
          .catch(() => controller.abort())
          .finally(() => {
            probing = false;
          });
      }, 2_000);
      monitor.unref();
      try {
        const directory = await this.git.nativeDirectory(record.input.repositoryId);
        const transport = this.transport(directory, record.input, credential, controller.signal);
        if (reconcile) await this.recover(record, transport, directory, controller.signal);
        else if (record.input.action === 'fetch')
          await this.fetch(record, transport, directory, controller.signal);
        else await this.push(record, transport, directory, controller.signal);
      } finally {
        clearInterval(monitor);
      }
    }).catch(async () => {
      record.state =
        record.phase === 'pushing' || record.phase === 'verifying' ? 'uncertain' : 'interrupted';
      record.detail =
        record.state === 'uncertain'
          ? 'The remote outcome is unknown. Inspect the remote before starting another publication.'
          : 'The transfer stopped before completion. Its captured data and working files are retained.';
      await this.save(record);
    });
    this.running.set(id, run);
    void run
      .finally(() => {
        this.running.delete(id);
        this.#controllers.delete(id);
      })
      .catch(() => {});
  }
  private ref(record: ProjectGitRemoteOperation) {
    return `refs/garden/remotes/${record.input.requestId}`;
  }
  private async captured(record: ProjectGitRemoteOperation, directory: string) {
    return GitObjectId.parse(
      (await command(directory, ['rev-parse', '--verify', `${this.ref(record)}^{commit}`])).trim()
    );
  }
  private async deliver(record: ProjectGitRemoteOperation, signal: AbortSignal) {
    signal.throwIfAborted();
    if (record.commit && record.workspaceId && record.taskId) {
      const stage = path.join(this.directory, record.input.requestId);
      await this.git.exportRemoteBundle(
        record.input.repositoryId,
        record.input.requestId,
        record.input.branch,
        stage,
        signal
      );
      await assertHostStorageWrite(
        this.root,
        (await stat(path.join(stage, 'workspace/repository.bundle'))).size
      );
      // Share only the private prepared copy; never chmod a path a workspace can replace.
      await chmod(path.join(stage, 'workspace/repository.bundle'), 0o640);
      const root = workspacePath(this.root, record.workspaceId);
      const relative = `workspace/.garden/remotes/${record.input.repositoryId}`;
      await withWorkspaceDirectory(root, relative, true, async (directory, heldDirectory) => {
        const target = path.join(directory, record.input.requestId + '.bundle');
        try {
          await copyFile(
            path.join(stage, 'workspace/repository.bundle'),
            target,
            constants.COPYFILE_EXCL
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const handle = await open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
          if (!(await handle.stat()).isFile())
            throw Error('The captured branch destination changed');
          const digest = async (filename: string) => {
            const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const hash = createHash('sha256');
              for await (const chunk of file.createReadStream({ autoClose: false }))
                hash.update(chunk as Buffer);
              return hash.digest('hex');
            } finally {
              await file.close();
            }
          };
          const before = await handle.stat({ bigint: true });
          const expected = await digest(path.join(stage, 'workspace/repository.bundle'));
          const actual = createHash('sha256');
          for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 }))
            actual.update(chunk as Buffer);
          const after = await handle.stat({ bigint: true });
          if (
            actual.digest('hex') !== expected ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs
          )
            throw Error('The captured branch destination changed');
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (heldDirectory) await heldDirectory.sync();
        else await syncDirectory(directory);
      });
      record.bundlePath = `${relative}/${record.input.requestId}.bundle`;
      await rm(stage, { recursive: true, force: true });
    }
    signal.throwIfAborted();
    record.state = 'succeeded';
    record.phase = 'finished';
    record.detail = null;
    await this.save(record);
  }
  private async fetch(
    record: ProjectGitRemoteOperation,
    transport: GitRemoteTransport,
    directory: string,
    signal: AbortSignal
  ) {
    if ((await transport.head()) === null) {
      record.commit = null;
      await this.deliver(record, signal);
      return;
    }
    await transport.fetch(this.ref(record));
    record.commit = await this.captured(record, directory);
    await this.save(record);
    await this.deliver(record, signal);
  }
  private async push(
    record: ProjectGitRemoteOperation,
    transport: GitRemoteTransport,
    directory: string,
    signal: AbortSignal
  ) {
    const input = record.input;
    if (input.action !== 'push') throw Error('Invalid publication intent');
    const current = await transport.head();
    if (current === input.commit) {
      record.commit = current;
      record.state = 'succeeded';
      record.phase = 'finished';
      record.detail = 'The remote already contains the selected commit.';
      await this.save(record);
      return;
    }
    if (current !== input.expectedHead) {
      record.state = 'rejected';
      record.phase = 'finished';
      record.detail =
        'The remote branch changed. Fetch and integrate its current history before publishing.';
      await this.save(record);
      return;
    }
    if (current) {
      await transport.fetch(this.ref(record));
      if ((await this.captured(record, directory)) !== current) {
        record.state = 'rejected';
        record.phase = 'finished';
        record.detail = 'The remote changed during inspection. Fetch it again before publishing.';
        await this.save(record);
        return;
      }
    }
    if (current && !(await projectGitIsAncestor(directory, current, input.commit))) {
      record.state = 'rejected';
      record.phase = 'finished';
      record.detail =
        'Integrate and check the remote changes before publishing. History replacement is not permitted.';
      await this.save(record);
      return;
    }
    record.phase = 'pushing';
    await this.save(record);
    try {
      await transport.push(input.commit, input.expectedHead);
    } catch {
      record.phase = 'verifying';
      await this.save(record);
      await this.recover(record, transport, directory, signal);
      return;
    }
    record.phase = 'verifying';
    await this.save(record);
    await this.recover(record, transport, directory, signal);
  }
  private async recover(
    record: ProjectGitRemoteOperation,
    transport: GitRemoteTransport,
    directory: string,
    signal: AbortSignal
  ) {
    if (record.input.action === 'fetch') {
      try {
        record.commit = await this.captured(record, directory);
      } catch {
        await this.fetch(record, transport, directory, signal);
        return;
      }
      await this.deliver(record, signal);
      return;
    }
    const current = await transport.head();
    record.commit = current;
    record.state = current === record.input.commit ? 'succeeded' : 'uncertain';
    record.phase = 'finished';
    record.detail =
      record.state === 'succeeded'
        ? 'The selected commit is present on the remote.'
        : 'The selected commit is not the current remote head. No push was repeated.';
    await this.save(record);
  }
  async restore() {
    // Inspect every durable intent, including records outside the display page.
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names)
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const record = await this.get(name.slice(0, -5));
        if (record.state === 'running') {
          record.state =
            record.phase === 'pushing' || record.phase === 'verifying'
              ? 'uncertain'
              : 'interrupted';
          record.detail = 'The service restarted. Inspect this operation before continuing.';
          await this.save(record);
        }
      }
  }
  async cancel(requestId: string) {
    await this.#locks.get(requestId)?.catch(() => {});
    this.#controllers.get(requestId)?.abort();
    await this.running.get(requestId);
    return this.get(requestId);
  }
  async cancelWorkspace(workspaceId: string) {
    this.#removedWorkspaces.add(workspaceId);
    await Promise.allSettled(this.#locks.values());
    for (const requestId of [...this.running.keys()]) {
      if ((await this.get(requestId)).workspaceId === workspaceId) await this.cancel(requestId);
    }
  }
  async close() {
    this.#closed = true;
    await Promise.allSettled(this.#locks.values());
    for (const controller of this.#controllers.values()) controller.abort();
    await Promise.allSettled(this.running.values());
  }
}
