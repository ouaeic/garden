import { captureConversationHistory } from './project-git-capture.js';
import { ProjectGitRemotes } from './project-git-remotes.js';
import { ProjectGitExports } from './project-git-exports.js';
import { ProjectGitWorkingCopies } from './project-git-working-copies.js';
import { MAX_CAPABILITY_TTL_SECONDS } from '@athanor/core';
import { ProjectGit } from './project-git.js';
import {
  ProjectRepositoryInput,
  ProjectRepositoryOperation,
  ProjectRepositoryRemovalInput
} from '@athanor/contracts';
import { ProjectPurge } from './project-purge.js';
import { contentRemoval, assertHistoryContentAvailable } from './project-content-state.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  ProjectCheck,
  ProcessResourceSample,
  ProjectCheckCommand,
  ProjectFileChange,
  ProjectRevision,
  ProjectUpdate,
  ProjectUpdates,
  ProjectGitWorkingCopy
} from '@athanor/contracts';
import { PrepareProjectUpdate } from '@athanor/contracts';
import { ensureWorkspace, workspacePath, withWorkspaceDirectory } from './files.js';
import { ProjectLiveChanges } from './project-live-changes.js';
import { ProjectVersionPins } from './project-version-pins.js';
import { scanProjectStorage } from './project-storage.js';
import { ProjectReferences } from './project-reference-lock.js';
import { ProjectRetention } from './project-retention.js';
import {
  ProjectVersionFiles,
  durableJson,
  durableMkdir,
  syncDirectory,
  projectPath,
  sameFile,
  treeDigest,
  type VersionTree
} from './project-version-files.js';

const uuid = (id: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new Error('Invalid project identity');
  return id;
};
const now = () => new Date().toISOString();
const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};
type StoredUpdate = Omit<ProjectUpdate, 'changeCount' | 'nextChange'> & {
  proposed: VersionTree;
  candidate: VersionTree;
  deleted: string[];
  selections: string[];
  baseline: VersionTree;
  sourceTaskId: string;
  requestDigest: string;
  sourceHeads?: Record<string, string>;
};
type StoredRevision = ProjectRevision & { files: VersionTree };
type Registry = { workspaceId: string; members: Record<string, string>; head: string | null };
type CheckProcess = {
  status: string;
  ranForMs: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  sessionId?: string;
  finishedAt?: string;
  resources?: ProcessResourceSample;
};
export interface ProjectCheckExecution {
  captureGit?(copy: ProjectGitWorkingCopy, output: string): Promise<{ sessionId: string }>;
  start(
    workspaceId: string,
    taskId: string,
    command: ProjectCheckCommand,
    job: string
  ): Promise<{ sessionId: string }>;
  poll(
    workspaceId: string,
    taskId: string,
    sessionId: string,
    logs: boolean
  ): CheckProcess | Promise<CheckProcess>;
  stop(workspaceId: string, taskId: string, sessionId: string): void | Promise<void>;
}

/** The only mutable shared file is a durable head reference; working processes never use it as a pathname. */
export class ProjectUpdatesManager {
  readonly #changes = new ProjectLiveChanges();
  readonly references: ProjectReferences;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #operations = new Map<string, Promise<void>>();
  readonly #cancelled = new Set<string>();
  readonly #removedWorkspaces = new Set<string>();
  readonly #live = new Map<string, StoredUpdate>();
  readonly #preparations = new Map<string, NonNullable<ProjectCheck['preparation']>>();
  readonly #watching = new Map<string, string>();
  readonly #storageScans = new Map<string, ReturnType<typeof scanProjectStorage>>();
  #timer: NodeJS.Timeout | undefined;
  #observing = false;
  #closed = false;
  constructor(
    readonly root: string,
    readonly execution: ProjectCheckExecution,
    readonly assertRetentionIdle: (projectId: string) => Promise<void> = async () => {
      throw new Error('Project archive requires verified running-work protection.');
    }
  ) {
    this.references = new ProjectReferences(root);
  }
  async restore(report: (error: unknown) => void = () => undefined): Promise<void> {
    const projects = await readdir(path.join(this.root, '.project-store')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    for (const projectId of projects.filter((id) => /^[a-f0-9-]{36}$/.test(id))) {
      const publishing = await readJson<{ updateId: string; revisionId: string }>(
        this.file(projectId, 'publishing.json')
      );
      if (publishing) {
        try {
          await this.locked(projectId, projectId, () =>
            this.completePublication(projectId, publishing)
          );
        } catch (error) {
          report(error);
        }
      }
      const git = this.repositories(projectId);
      for (const receipt of await git.removals()) {
        if (receipt.state === 'removing') await git.finishRemoval(receipt);
      }
      await this.gitRemotes(projectId).restore();
      await this.gitExports(projectId).restore();
      await this.gitWorkingCopies(projectId).restore();
      for (const operation of await this.repositoryOperations(projectId)) {
        if (operation.state === 'preparing') await this.beginRepository(projectId, operation.input);
      }
      const summaries = await readdir(this.file(projectId, 'summaries')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        }
      );
      for (const name of summaries.filter((name) => name.endsWith('.json'))) {
        const summary = await readJson<ProjectUpdate>(this.file(projectId, `summaries/${name}`));
        if (summary && ['checking', 'preparing'].includes(summary.state))
          this.#watching.set(summary.id, projectId);
      }
    }
    const observe = async () => {
      if (this.#observing || this.#closed) return;
      this.#observing = true;
      try {
        for (const [id, projectId] of this.#watching) {
          if (this.#closed) break;
          try {
            const update = await this.inspect(projectId, id);
            if (
              !update.checks.some((check) =>
                ['preparing', 'running', 'verifying'].includes(check.status)
              )
            )
              this.#watching.delete(id);
          } catch (error) {
            report(error);
          }
        }
      } finally {
        this.#observing = false;
      }
    };
    await observe();
    this.#timer = setInterval(() => void observe(), 15_000);
    this.#timer.unref();
  }
  async startGitRemote(
    projectId: string,
    input: unknown,
    actor: { taskId: string | null; workspaceId: string | null },
    credential: string
  ) {
    return this.locked(projectId, projectId, async () => {
      if (this.#closed || (actor.workspaceId && this.#removedWorkspaces.has(actor.workspaceId)))
        throw Error('This conversation is stopping');
      return this.gitRemotes(projectId).start(input, actor, credential);
    });
  }
  readonly #remotes = new Map<string, ProjectGitRemotes>();
  gitRemotes(projectId: string): ProjectGitRemotes {
    let remotes = this.#remotes.get(projectId);
    if (!remotes) {
      remotes = new ProjectGitRemotes(
        this.root,
        this.file(projectId, 'repository-remotes'),
        this.repositories(projectId),
        async (input) => {
          const revision = await this.version(projectId, input.revisionId);
          const repository = await this.repositories(projectId).get(input.repositoryId);
          const registered =
            revision.repositories?.some(
              (item) => item.repositoryId === input.repositoryId && item.commit === input.commit
            ) ||
            (repository.initialPublication?.revisionId === revision.id &&
              repository.initialPublication.commit === input.commit);
          if (!registered)
            throw Error('Choose the exact commit recorded in a published project version');
          if (
            revision.checks.some(
              (check) => check.status !== 'passed' || check.candidateDigest !== revision.digest
            ) ||
            (!revision.checks.length && !revision.uncheckedReason)
          )
            throw Error(
              'The published version needs passing checks or an explicit owner publication decision'
            );
        },
        (run) => this.references.run(projectId, run)
      );
      this.#remotes.set(projectId, remotes);
    }
    return remotes;
  }
  readonly #exports = new Map<string, ProjectGitExports>();
  readonly #workingCopies = new Map<string, ProjectGitWorkingCopies>();
  gitWorkingCopies(projectId: string): ProjectGitWorkingCopies {
    let copies = this.#workingCopies.get(projectId);
    if (!copies) {
      copies = new ProjectGitWorkingCopies(
        this.root,
        this.file(projectId, 'git-working-copies'),
        this.repositories(projectId),
        async (copy) => {
          const directory = path.join(
            workspacePath(this.root, copy.workspaceId),
            'workspace',
            copy.path
          );
          // Git's ownership check otherwise rejects runner-created files for the command account.
          const process = await this.execution.start(
            copy.workspaceId,
            copy.taskId,
            {
              name: 'Configure conversation Git',
              executable: '/usr/bin/git',
              cwd: 'workspace',
              args: [
                'config',
                '--global',
                '--fixed-value',
                '--replace-all',
                'safe.directory',
                directory,
                directory
              ]
            },
            'Configure conversation Git'
          );
          const deadline = Date.now() + 30_000;
          for (;;) {
            const result = await this.execution.poll(
              copy.workspaceId,
              copy.taskId,
              process.sessionId,
              false
            );
            if (result.status === 'completed' && result.exitCode === 0) return;
            if (result.status !== 'running' || Date.now() >= deadline) {
              if (result.status === 'running')
                await this.execution.stop(copy.workspaceId, copy.taskId, process.sessionId);
              throw Error(
                'The Git working copy is installed, but its conversation configuration did not finish. Retry checkout.'
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      );
      this.#workingCopies.set(projectId, copies);
    }
    return copies;
  }
  gitExports(projectId: string): ProjectGitExports {
    let exports = this.#exports.get(projectId);
    if (!exports) {
      exports = new ProjectGitExports(
        this.root,
        this.file(projectId, 'repository-exports'),
        this.repositories(projectId)
      );
      this.#exports.set(projectId, exports);
    }
    return exports;
  }
  readonly #purges = new Map<string, ProjectPurge>();
  purge(projectId: string): ProjectPurge {
    let purge = this.#purges.get(projectId);
    if (!purge) {
      purge = new ProjectPurge(this.root, projectId, () => this.assertRetentionIdle(projectId));
      this.#purges.set(projectId, purge);
    }
    return purge;
  }
  backgroundPreparations(): number {
    return (
      this.#operations.size +
      [...this.#remotes.values()].reduce((sum, remotes) => sum + remotes.running.size, 0) +
      [...this.#workingCopies.values()].reduce((sum, copies) => sum + copies.running.size, 0) +
      [...this.#exports.values()].reduce((sum, exports) => sum + exports.running.size, 0) +
      [...this.#purges.values()].reduce((sum, purge) => sum + purge.runningCount(), 0)
    );
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#changes.close();
    await Promise.allSettled([...this.#remotes.values()].map((remotes) => remotes.close()));
    await Promise.allSettled([...this.#workingCopies.values()].map((copies) => copies.close()));
    await Promise.allSettled([...this.#exports.values()].map((exports) => exports.close()));
    await Promise.allSettled([...this.#purges.values()].map((purge) => purge.close()));
    await Promise.allSettled([...this.#operations.values()]);
  }
  async cancelWorkspace(workspaceId: string): Promise<void> {
    uuid(workspaceId);
    this.#removedWorkspaces.add(workspaceId);
    setTimeout(
      () => this.#removedWorkspaces.delete(workspaceId),
      (MAX_CAPABILITY_TTL_SECONDS + 60) * 1000
    ).unref();
    await this.#locks.get(`checkout:${workspaceId}`)?.catch(() => undefined);
    await Promise.all(
      [...this.#remotes.values()].map((remotes) => remotes.cancelWorkspace(workspaceId))
    );
    await Promise.all(
      [...this.#workingCopies.values()].map((copies) => copies.cancelWorkspace(workspaceId))
    );
  }
  directory(projectId: string): string {
    return path.join(this.root, '.project-store', uuid(projectId));
  }
  publicDirectory(projectId: string): string {
    return path.join(this.directory(projectId), 'public');
  }
  retention(projectId: string): ProjectRetention {
    return new ProjectRetention(this.root, projectId, () => this.assertRetentionIdle(projectId));
  }
  repositories(projectId: string): ProjectGit {
    return new ProjectGit(this.file(projectId, 'repositories'), this.files(projectId));
  }
  async removeRepository(projectId: string, repositoryId: string, raw: unknown) {
    return this.locked(projectId, projectId, async () => {
      if (await readJson(this.file(projectId, 'publishing.json')))
        throw new Error('Finish the pending publication before removing a repository');
      const input = ProjectRepositoryRemovalInput.parse(raw);
      const git = this.repositories(projectId);
      const previous = (await git.removals()).find((item) => item.repositoryId === repositoryId);
      if (previous && (previous.requestId !== input.requestId || previous.head !== input.head))
        throw new Error('Repository removal identity changed');
      if (previous && (previous.state === 'removed' || this.#operations.has(previous.requestId)))
        return previous;
      if (
        this.#operations.size ||
        this.gitRemotes(projectId).running.size ||
        this.gitExports(projectId).running.size ||
        this.gitWorkingCopies(projectId).running.size
      )
        throw new Error(
          'Wait for source preparation and Git exports to finish before removing a repository'
        );
      const receipt = await git.markRemoval(repositoryId, raw);
      if (receipt.state !== 'removed')
        this.launch(projectId, receipt.requestId, () => git.finishRemoval(receipt));
      return structuredClone(receipt);
    });
  }
  async repositoryOperations(projectId: string): Promise<ProjectRepositoryOperation[]> {
    const names = await readdir(this.file(projectId, 'repository-operations')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    return Promise.all(
      names
        .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
        .sort()
        .map(async (name) =>
          ProjectRepositoryOperation.parse(
            await readJson(this.file(projectId, `repository-operations/${name}`))
          )
        )
    );
  }
  async beginRepository(projectId: string, raw: unknown): Promise<ProjectRepositoryOperation> {
    const input = ProjectRepositoryInput.parse(raw);
    return this.locked(projectId, `repository:${input.requestId}`, async () => {
      await this.registry(projectId);
      const file = this.file(projectId, `repository-operations/${input.requestId}.json`);
      const previous = await readJson<ProjectRepositoryOperation>(file);
      if (previous && JSON.stringify(previous.input) !== JSON.stringify(input))
        throw new Error('Repository request identity changed');
      if (previous?.state === 'ready' || this.#operations.has(input.requestId)) return previous!;
      const operation: ProjectRepositoryOperation = previous ?? {
        input,
        state: 'preparing',
        createdAt: now(),
        updatedAt: now(),
        files: 0,
        bytes: 0,
        detail: null
      };
      operation.state = 'preparing';
      operation.detail = null;
      operation.updatedAt = now();
      await durableJson(file, operation);
      this.launch(projectId, input.requestId, async () => {
        try {
          await this.createRepository(projectId, input, async (files, bytes) => {
            operation.files = files;
            operation.bytes = bytes;
            operation.updatedAt = now();
            await durableJson(file, operation);
          });
          operation.state = 'ready';
        } catch (error) {
          operation.state = 'failed';
          operation.detail = String(error);
        }
        operation.updatedAt = now();
        await durableJson(file, operation);
      });
      return structuredClone(operation);
    });
  }
  async createRepository(
    projectId: string,
    raw: unknown,
    progress?: (files: number, bytes: number) => Promise<void>
  ) {
    const input = ProjectRepositoryInput.parse(raw);
    return this.locked(projectId, projectId, async () => {
      const registry = await this.registry(projectId);
      const existing = (await this.repositories(projectId).list()).find(
        (item) => item.id === input.requestId
      );
      if (existing) return this.repositories(projectId).create(input, {}, progress);
      if (await readJson(this.file(projectId, 'publishing.json')))
        throw new Error('Finish the pending publication before changing repository connections');
      if (registry.head !== input.revisionId)
        throw new Error('The project version changed. Refresh before connecting a repository.');
      const revision = await this.revision(projectId, input.revisionId);
      await this.retention(projectId).assertAvailable(revision.id);
      return this.repositories(projectId).create(input, revision.files, progress);
    });
  }
  async storage(projectId: string) {
    await this.registry(projectId);
    const existing = this.#storageScans.get(projectId);
    if (existing) return existing;
    if (this.#storageScans.size >= 2) throw new Error('Storage inspection is busy; retry shortly.');
    const scan = scanProjectStorage(this.root, this.directory(projectId));
    this.#storageScans.set(projectId, scan);
    try {
      return await scan;
    } finally {
      if (this.#storageScans.get(projectId) === scan) this.#storageScans.delete(projectId);
    }
  }
  private file(projectId: string, name: string): string {
    return path.join(this.directory(projectId), 'state', name);
  }
  private files(projectId: string) {
    return new ProjectVersionFiles(this.file(projectId, 'content'));
  }
  private locked<T>(projectId: string, id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const run = this.references.run(projectId, () => previous.catch(() => undefined).then(action));
    this.#locks.set(id, run);
    void run
      .finally(() => {
        if (this.#locks.get(id) === run) this.#locks.delete(id);
      })
      .catch(() => undefined);
    return run;
  }
  private async registry(projectId: string): Promise<Registry> {
    const result = await readJson<Registry>(this.file(projectId, 'registry.json'));
    if (!result) throw new Error('This project has no registered working areas');
    return result;
  }
  async bind(
    projectId: string,
    projectWorkspaceId: string,
    taskId: string,
    workspaceId: string
  ): Promise<void> {
    uuid(projectWorkspaceId);
    uuid(taskId);
    uuid(workspaceId);
    await durableMkdir(this.publicDirectory(projectId), 0o755);
    await this.locked(projectId, projectId, async () => {
      const registry = (await readJson<Registry>(this.file(projectId, 'registry.json'))) ?? {
        workspaceId: projectWorkspaceId,
        members: {},
        head: null
      };
      if (registry.workspaceId !== projectWorkspaceId) {
        // The control plane can finalize the root's move only to its already registered area.
        // Published versions live under the project identity and do not move with this handle.
        if (
          taskId !== projectId ||
          workspaceId !== projectWorkspaceId ||
          registry.members[taskId] !== projectWorkspaceId
        )
          throw new Error('Project working-area identity changed');
        registry.workspaceId = projectWorkspaceId;
      }
      registry.members[taskId] = workspaceId;
      await durableJson(this.file(projectId, 'registry.json'), registry);
      const baseline = this.file(projectId, `baselines/${workspaceId}.json`);
      if (!(await readJson(baseline))) {
        await durableJson(baseline, { revision: registry.head, files: {} });
      }
    });
  }
  async checkRoot(projectId: string, updateId: string, checkId: string): Promise<string> {
    await assertHistoryContentAvailable(this.retention(projectId), 'check', checkId);
    const update = await this.update(projectId, updateId);
    if (!update.checks.some((check) => check.id === checkId && check.sessionId))
      throw new Error('Check files are not available');
    return workspacePath(this.root, checkId);
  }
  async revisionRoot(projectId: string, revisionId: string): Promise<string> {
    await this.retention(projectId).assertAvailable(revisionId);
    return path.dirname((await this.revision(projectId, revisionId)).path);
  }
  async openFiles(projectId: string, resolve: () => Promise<string>) {
    const reference = await this.references.acquire(projectId);
    try {
      return { root: await resolve(), release: () => reference.release() };
    } catch (error) {
      await reference.release();
      throw error;
    }
  }
  private async revisionSummary(projectId: string, id: string): Promise<ProjectRevision> {
    const revision =
      (await readJson<ProjectRevision>(
        this.file(projectId, `revision-summaries/${uuid(id)}.json`)
      )) ?? this.revisionView(await this.revision(projectId, id));
    return {
      ...revision,
      contentRemoval: await contentRemoval(this.retention(projectId), 'version', id),
      checks: await this.contentChecks(projectId, revision.checks),
      archive: await this.retention(projectId).status(id),
      pin: await new ProjectVersionPins(this.file(projectId, 'pins')).get(
        revision.number,
        revision.id
      )
    };
  }
  async version(projectId: string, id: string): Promise<ProjectRevision> {
    return this.revisionSummary(projectId, id);
  }
  async pinVersion(
    projectId: string,
    revisionId: string,
    label: string | null
  ): Promise<ProjectRevision> {
    return this.locked(projectId, projectId, async () => {
      await this.registry(projectId);
      const revision = await this.revision(projectId, revisionId);
      if (label !== null) await this.retention(projectId).assertAvailable(revisionId);
      const pin = await new ProjectVersionPins(this.file(projectId, 'pins')).set(
        revision.number,
        revision.id,
        label
      );
      return {
        ...this.revisionView(revision),
        pin,
        archive: await this.retention(projectId).status(revisionId)
      };
    });
  }
  async pinnedVersions(projectId: string, before?: string) {
    await this.registry(projectId);
    const page = await new ProjectVersionPins(this.file(projectId, 'pins')).page(before);
    const revisions = await Promise.all(
      page.pins.map(async (pin) => {
        const revision = await this.revisionSummary(projectId, pin.revisionId);
        if (revision.number !== pin.number)
          throw new Error('Pinned version identity does not match the published version.');
        return revision;
      })
    );
    return { revisions, nextCursor: page.nextCursor };
  }
  async projectWorkspace(projectId: string): Promise<string> {
    return (await this.registry(projectId)).workspaceId;
  }
  async member(projectId: string, taskId: string): Promise<string> {
    const workspace = (await this.registry(projectId)).members[uuid(taskId)];
    if (!workspace) throw new Error('Conversation is not registered in this project');
    return workspace;
  }
  async liveChanges(projectId: string, taskIds: string[]) {
    const registry = await this.registry(projectId);
    const members = taskIds.map((taskId) => {
      const workspaceId = registry.members[uuid(taskId)];
      if (!workspaceId) throw new Error('Conversation is not registered in this project');
      return { taskId, workspaceId };
    });
    return members.map(({ taskId, workspaceId }) =>
      this.#changes.request(workspacePath(this.root, workspaceId), this.file(projectId, ''), taskId)
    );
  }
  private async revision(projectId: string, id: string): Promise<StoredRevision> {
    const revision = await readJson<StoredRevision>(
      this.file(projectId, `revisions/${uuid(id)}.json`)
    );
    if (!revision) throw new Error('Published project version not found');
    return revision;
  }
  private async contentChecks(projectId: string, checks: ProjectCheck[]) {
    return Promise.all(
      checks.map(async (check) => ({
        ...check,
        contentRemoval: await contentRemoval(this.retention(projectId), 'check', check.id)
      }))
    );
  }
  private async contentView<T extends Pick<ProjectUpdate, 'id' | 'projectId' | 'checks'>>(
    update: T
  ): Promise<T> {
    return {
      ...update,
      contentRemoval: await contentRemoval(this.retention(update.projectId), 'update', update.id),
      checks: await this.contentChecks(update.projectId, update.checks)
    };
  }
  async update(projectId: string, id: string): Promise<StoredUpdate> {
    const live = this.#live.get(id);
    if (live?.projectId === projectId) return live;
    const update = await readJson<StoredUpdate>(this.file(projectId, `updates/${uuid(id)}.json`));
    if (!update) throw new Error('Project update not found');
    return this.contentView(update);
  }
  private async save(update: StoredUpdate) {
    update.updatedAt = now();
    await durableJson(this.file(update.projectId, `updates/${update.id}.json`), update);
    await durableJson(
      this.file(
        update.projectId,
        `summaries/${update.createdAt.replaceAll(':', '-')}_${update.id}.json`
      ),
      { ...this.view(update), changes: [] }
    );
  }
  private view(update: StoredUpdate, after?: string): ProjectUpdate {
    const {
      proposed: _proposed,
      candidate: _candidate,
      deleted: _deleted,
      selections: _selections,
      baseline: _baseline,
      sourceTaskId: _sourceTask,
      requestDigest: _requestDigest,
      sourceHeads: _sourceHeads,
      ...view
    } = update;
    const start = after ? update.changes.findIndex((change) => change.path === after) + 1 : 0;
    if (after && !start) throw new Error('Changed file cursor not found');
    const changes = update.changes.slice(start, start + 100);
    return {
      ...view,
      ...(view.contentRemoval ? { path: null } : {}),
      checks: view.checks.map((check) => ({
        ...check,
        ...(this.#preparations.has(check.id)
          ? { preparation: this.#preparations.get(check.id)! }
          : {})
      })),
      changes: view.contentRemoval ? changes.map((change) => ({ ...change, diff: null })) : changes,
      changeCount: update.changes.length,
      lineChanges: update.changes.reduce(
        (total, change) => ({
          added: total.added + (change.lines?.added ?? 0),
          removed: total.removed + (change.lines?.removed ?? 0),
          unmeasuredFiles: total.unmeasuredFiles + (change.lines ? 0 : 1)
        }),
        { added: 0, removed: 0, unmeasuredFiles: 0 }
      ),
      nextChange: start + 100 < update.changes.length ? changes.at(-1)!.path : null
    };
  }
  private revisionView(revision: StoredRevision): ProjectRevision {
    const { files: _files, ...view } = revision;
    return view;
  }
  private launch(projectId: string, id: string, action: () => Promise<void>) {
    if (this.#operations.has(id)) return;
    const operation = this.references.run(projectId, action);
    this.#operations.set(id, operation);
    void operation
      .finally(() => {
        this.#operations.delete(id);
        this.#live.delete(id);
      })
      .catch(() => undefined);
  }
  async settle(id: string): Promise<void> {
    await this.#operations.get(id);
  }
  private active(id: string) {
    if (this.#closed) throw new Error('Project preparation interrupted by service shutdown');
    if (this.#cancelled.has(id)) throw new Error('Project operation cancelled');
  }
  async prepare(
    projectId: string,
    taskId: string,
    raw: unknown,
    sourceTaskId = taskId,
    requestId: string = randomUUID()
  ): Promise<ProjectUpdate> {
    const input = PrepareProjectUpdate.parse(raw);
    const sourceWorkspaceId = await this.member(projectId, sourceTaskId);
    const actorWorkspaceId = await this.member(projectId, taskId);
    const id = uuid(requestId);
    const requestDigest = createHash('sha256')
      .update(JSON.stringify({ taskId, sourceTaskId, input }))
      .digest('hex');
    return this.locked(projectId, `prepare:${id}`, async () => {
      const existing = await readJson<StoredUpdate>(this.file(projectId, `updates/${id}.json`));
      if (existing) {
        if (existing.requestDigest !== requestDigest)
          throw new Error('Project update request identity changed');
        return this.view(existing);
      }
      const registry = await this.registry(projectId);
      const baseline = await readJson<{ files: VersionTree }>(
        this.file(projectId, `baselines/${actorWorkspaceId}.json`)
      );
      const baselineFiles = baseline?.files ?? {};
      if (input.resolvedPaths.length) {
        if (input.expectedRevision !== registry.head)
          throw new Error('The published version changed before this conflict resolution');
        const resolved = await this.revision(projectId, input.expectedRevision);
        for (const selection of input.resolvedPaths.map(projectPath)) {
          if (!selection) throw new Error('Resolve named files, not the whole project');
          if (resolved.files[selection]) baselineFiles[selection] = resolved.files[selection];
          else delete baselineFiles[selection];
        }
      }
      const timestamp = now();
      const update: StoredUpdate = {
        id,
        projectId,
        taskId,
        sourceTaskId,
        sourceWorkspaceId,
        title: input.title,
        state: 'preparing',
        parentRevision: registry.head,
        candidateDigest: null,
        path: null,
        changes: [],
        checks: input.checks.map((check) => ({
          ...check,
          id: randomUUID(),
          status: 'pending',
          startedAt: null,
          finishedAt: null,
          ranForMs: 0,
          exitCode: null,
          detail: null,
          candidateDigest: '',
          sessionId: null
        })),
        progress: { files: 0, bytes: 0, stage: 'Capturing selected files' },
        createdAt: timestamp,
        updatedAt: timestamp,
        publishedRevision: null,
        detail: null,
        uncheckedReason: null,
        proposed: {},
        candidate: {},
        baseline: baselineFiles,
        deleted: input.deletePaths.map(projectPath),
        selections: input.paths,
        requestDigest
      };
      if (update.deleted.some((name) => !name))
        throw new Error('Delete individual paths, not the whole project');
      await this.save(update);
      this.#live.set(id, update);
      this.launch(projectId, id, () => this.capture(update));
      return this.view(update);
    });
  }
  private async capture(update: StoredUpdate): Promise<void> {
    try {
      const versions = this.files(update.projectId);
      update.proposed = await versions.capture(
        workspacePath(this.root, update.sourceWorkspaceId),
        update.selections,
        (files, bytes) => {
          update.progress.files = files;
          update.progress.bytes = bytes;
        },
        () => this.active(update.id)
      );
      if (
        update.deleted.some((name) =>
          Object.keys(update.proposed).some(
            (file) => file === name || (!update.baseline[name] && file.startsWith(`${name}/`))
          )
        )
      )
        throw new Error('A path cannot be both included and deleted');
      update.sourceHeads ??= {};
      const selected = [...update.selections.map(projectPath), ...update.deleted];
      for (const copy of await this.gitWorkingCopies(update.projectId).list()) {
        if (
          copy.taskId !== update.sourceTaskId ||
          copy.workspaceId !== update.sourceWorkspaceId ||
          copy.state === 'cancelled' ||
          !selected.some(
            (name) =>
              !name ||
              !copy.path ||
              name === copy.path ||
              name.startsWith(copy.path + '/') ||
              copy.path.startsWith(name + '/')
          )
        )
          continue;
        if (copy.state !== 'ready' && copy.state !== 'blocked')
          throw Error('Wait for conversation Git setup before preparing this update');
        update.progress.stage = 'Preserving conversation commits';
        update.sourceHeads[copy.repositoryId] = await captureConversationHistory({
          root: this.root,
          git: this.repositories(update.projectId),
          copy,
          updateId: update.id,
          execution: this.execution,
          active: () => this.active(update.id)
        });
        await this.save(update);
      }
      await this.assemble(update);
    } catch (error) {
      update.state = this.#cancelled.has(update.id) ? 'cancelled' : 'failed';
      update.detail =
        error instanceof Error ? error.message : 'The project update could not be prepared';
      update.progress.stage = update.state === 'cancelled' ? 'Cancelled' : 'Preparation failed';
      await this.save(update);
    }
  }
  private async assemble(update: StoredUpdate): Promise<void> {
    const registry = await this.registry(update.projectId);
    const head = registry.head ? await this.revision(update.projectId, registry.head) : null;
    const current = head?.files ?? {},
      candidate = { ...current };
    update.parentRevision = registry.head;
    const versions = this.files(update.projectId);
    const removed = Object.keys(update.baseline).filter((name) =>
      update.deleted.some((deleted) => name === deleted || name.startsWith(`${deleted}/`))
    );
    for (const deleted of update.deleted)
      if (!removed.some((name) => name === deleted || name.startsWith(`${deleted}/`)))
        throw new Error(
          `No recorded file baseline for deletion: ${deleted}. Checkout the file or record an explicit resolution against the published version.`
        );
    const changes: ProjectFileChange[] = [];
    let diffBudget = 128_000;
    for (const name of [...new Set([...Object.keys(update.proposed), ...removed])].sort()) {
      this.active(update.id);
      const base = update.baseline[name] ?? null,
        theirs = current[name] ?? null,
        ours = update.proposed[name] ?? null;
      if (sameFile(base, ours) || sameFile(theirs, ours)) continue;
      let result = ours,
        conflict = false,
        merged = false;
      if (!sameFile(theirs, base) && !sameFile(theirs, ours)) {
        if (base && theirs && ours) {
          result = await versions.merge(base, theirs, ours);
          merged = Boolean(result);
        } else result = null;
        conflict = !merged;
      }
      if (!conflict) {
        if (result) candidate[name] = result;
        else delete candidate[name];
      }
      const original = base
        ? await versions.read(base, Math.min(32_768, diffBudget))
        : Buffer.alloc(0);
      const modified = ours
        ? await versions.read(ours, Math.min(32_768, diffBudget))
        : Buffer.alloc(0);
      const text =
        original &&
        modified &&
        !original.includes(0) &&
        !modified.includes(0) &&
        !original.toString().includes('\ufffd') &&
        !modified.toString().includes('\ufffd');
      if (text) diffBudget = Math.max(0, diffBudget - original.length - modified.length);
      changes.push({
        path: name,
        kind: !base ? 'added' : !ours ? 'deleted' : 'modified',
        base,
        current: theirs,
        proposed: ours,
        result,
        conflict,
        merged,
        lines: await versions.lineChanges(base, ours),
        detail: conflict
          ? 'The published file and this proposal both changed. Resolve against the current version.'
          : merged
            ? 'Compatible text changes were combined; checks must run on this combined candidate.'
            : null,
        diff: text
          ? `--- Before\n${original.toString()}\n+++ Proposed\n${modified.toString()}`
          : null
      });
    }
    const byPath = new Map(changes.map((change) => [change.path, change]));
    let ancestor: string | undefined;
    for (const name of Object.keys(candidate).sort()) {
      if (ancestor && name.startsWith(`${ancestor}/`)) {
        for (const collision of [ancestor, name]) {
          const change = byPath.get(collision);
          if (change) {
            change.conflict = true;
            change.detail =
              'One proposal uses this path as a file and another as a directory. Resolve the conflicting paths explicitly.';
          }
        }
      } else ancestor = name;
    }
    update.candidate = candidate;
    update.changes = changes;
    update.candidateDigest = treeDigest(candidate);
    for (const check of update.checks) check.candidateDigest = update.candidateDigest;
    const conflicted = changes.some((change) => change.conflict);
    update.progress.stage = conflicted ? 'Resolve conflicting files' : 'Preparing combined files';
    if (!conflicted) {
      const directory = path.join(this.publicDirectory(update.projectId), 'candidates', update.id);
      const staging = `${directory}.preparing`;
      await rm(staging, { recursive: true, force: true });
      await versions.materialize(candidate, path.join(staging, 'workspace'), false, () =>
        this.active(update.id)
      );
      await mkdir(path.dirname(directory), { recursive: true, mode: 0o755 });
      await rename(staging, directory);
      await syncDirectory(path.dirname(directory));
      update.path = path.join(directory, 'workspace');
    }
    update.repositories = conflicted
      ? []
      : await this.repositories(update.projectId).prepare(
          update,
          candidate,
          update.repositories ?? [],
          update.sourceHeads ?? {}
        );
    update.state = conflicted ? 'conflicted' : 'ready';
    update.progress.stage = conflicted
      ? 'Resolve conflicting files'
      : changes.length || update.repositories?.some((repository) => repository.historyChanged)
        ? 'Ready for checks'
        : 'No changed files';
    if (!changes.length && !update.repositories?.some((repository) => repository.historyChanged))
      update.detail =
        'The selected files do not change the published project. There is nothing to publish.';
    await this.save(update);
  }
  async rebase(
    projectId: string,
    id: string,
    requestId: string = randomUUID()
  ): Promise<ProjectUpdate> {
    return this.locked(projectId, `prepare:${uuid(requestId)}`, async () => {
      await assertHistoryContentAvailable(this.retention(projectId), 'update', id);
      const requestDigest = createHash('sha256').update(`rebase:${projectId}:${id}`).digest('hex');
      const existing = await readJson<StoredUpdate>(
        this.file(projectId, `updates/${requestId}.json`)
      );
      if (existing) {
        if (existing.requestDigest !== requestDigest)
          throw new Error('Project update request identity changed');
        return this.view(existing);
      }
      const previous = await this.update(projectId, id);
      if (
        ['preparing', 'checking', 'publishing', 'published', 'cancelled'].includes(previous.state)
      )
        throw new Error('Wait for this update to settle before rebuilding it');
      const update: StoredUpdate = {
        ...previous,
        requestDigest,
        id: uuid(requestId),
        state: 'preparing',
        path: null,
        candidateDigest: null,
        changes: [],
        createdAt: now(),
        updatedAt: now(),
        detail: null,
        checks: previous.checks.map((check) => ({
          ...check,
          id: randomUUID(),
          status: 'pending',
          startedAt: null,
          finishedAt: null,
          ranForMs: 0,
          exitCode: null,
          sessionId: null,
          detail: null,
          candidateDigest: ''
        }))
      };
      await this.save(update);
      this.#live.set(update.id, update);
      this.launch(projectId, update.id, async () => {
        try {
          if (previous.state === 'failed') await this.capture(update);
          else await this.assemble(update);
        } catch (error) {
          update.state = this.#cancelled.has(update.id) ? 'cancelled' : 'failed';
          update.detail = String(error);
          await this.save(update);
        }
      });
      return this.view(update);
    });
  }
  async checkout(
    projectId: string,
    taskId: string,
    paths: string[],
    revisionId?: string,
    gitOnly = false
  ): Promise<{ revisionId: string; files: string[]; workingCopies: ProjectGitWorkingCopy[] }> {
    const workspaceId = await this.member(projectId, taskId);
    const id = revisionId ?? (await this.registry(projectId)).head;
    if (!id) throw new Error('Publish an initial project version before checking out files');
    const revision = await this.revision(projectId, id),
      root = workspacePath(this.root, workspaceId);
    const selected = paths.map(projectPath);
    const files = Object.keys(revision.files).filter((name) =>
      selected.some((prefix) => !prefix || name === prefix || name.startsWith(`${prefix}/`))
    );
    if (!files.length) throw new Error('No published files match those paths');
    const baselineFile = this.file(projectId, `baselines/${workspaceId}.json`);
    return this.locked(projectId, `checkout:${workspaceId}`, async () => {
      if (this.#removedWorkspaces.has(workspaceId))
        throw Error('This working area is being removed');
      if (gitOnly) {
        const existing = (await this.gitWorkingCopies(projectId).list()).filter(
          (copy) =>
            copy.workspaceId === workspaceId &&
            copy.taskId === taskId &&
            selected.some(
              (prefix) => !prefix || copy.path === prefix || copy.path.startsWith(prefix + '/')
            )
        );
        if (!existing.length) throw Error('No prepared conversation Git copy matches those paths');
        const workingCopies: ProjectGitWorkingCopy[] = [];
        for (const copy of existing)
          workingCopies.push(
            await this.gitWorkingCopies(projectId).start(
              await this.repositories(projectId).get(copy.repositoryId),
              copy
            )
          );
        return { revisionId: id, files: [], workingCopies };
      }
      await this.retention(projectId).assertAvailable(id);
      const baseline = (await readJson<{ revision: string | null; files: VersionTree }>(
        baselineFile
      )) ?? { revision: null, files: {} };
      for (const name of files) {
        const fact = revision.files[name]!;
        // Existing working files are never overwritten by an input refresh.
        await withWorkspaceDirectory(
          root,
          path.posix.dirname(`workspace/${name}`),
          true,
          async (directory) => {
            const destination = path.join(directory, path.posix.basename(name));
            try {
              await this.files(projectId).copy(fact, destination);
            } catch (error) {
              if (
                (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
                !(await this.files(projectId).matches(root, { [name]: fact }))
              )
                throw error;
            }
          }
        );
        baseline.files[name] = fact;
        await durableJson(baselineFile, baseline);
      }
      baseline.revision = id;
      await durableJson(baselineFile, baseline);
      const workingCopies: ProjectGitWorkingCopy[] = [];
      const git = this.repositories(projectId);
      for (const repository of await git.list()) {
        if (
          !selected.some(
            (prefix) =>
              !prefix || repository.path === prefix || repository.path.startsWith(prefix + '/')
          )
        )
          continue;
        const base = await git.checkoutBase(
          repository.id,
          revision.files,
          revision.repositories?.find((item) => item.repositoryId === repository.id)?.commit
        );
        if (base)
          workingCopies.push(
            await this.gitWorkingCopies(projectId).start(repository, {
              taskId,
              workspaceId,
              revisionId: id,
              base
            })
          );
      }
      return { revisionId: id, files, workingCopies };
    });
  }

  async startCheck(
    projectId: string,
    id: string,
    checkId: string,
    expectedDigest: string
  ): Promise<ProjectUpdate> {
    return this.locked(projectId, `update:${id}`, async () => {
      await assertHistoryContentAvailable(this.retention(projectId), 'update', id);
      await assertHistoryContentAvailable(this.retention(projectId), 'check', checkId);
      const update = await this.update(projectId, id);
      const check = update.checks.find((item) => item.id === checkId);
      if (!check || !update.candidateDigest || update.candidateDigest !== expectedDigest)
        throw new Error('The check belongs to a different candidate');
      if (
        this.#operations.has(id) ||
        ['preparing', 'conflicted', 'cancelled', 'published', 'failed'].includes(update.state)
      )
        throw new Error('This update is not ready for checks');
      if ((await this.registry(projectId)).head !== update.parentRevision)
        throw new Error(
          'A newer project version is available. Rebuild this update before running checks.'
        );
      if (check.status !== 'pending') return this.view(update);
      check.status = 'preparing';
      check.startedAt = now();
      update.state = 'checking';
      this.#watching.set(id, projectId);
      await this.save(update);
      this.launch(projectId, check.id, async () => {
        const progress = {
          files: 0,
          bytes: 0,
          totalFiles: Object.keys(update.candidate).length,
          totalBytes: Object.values(update.candidate).reduce((sum, file) => sum + file.bytes, 0)
        };
        this.#preparations.set(check.id, progress);
        try {
          const checkRoot = workspacePath(this.root, check.id);
          await ensureWorkspace(checkRoot);
          await durableJson(path.join(checkRoot, '.athanor', 'project-inputs.json'), {
            sources: [],
            projects: [projectId]
          });
          await durableJson(path.join(checkRoot, '.athanor', 'project-check.json'), {
            projectId,
            updateId: id,
            checkId: check.id,
            candidateDigest: expectedDigest
          });
          await durableJson(path.join(checkRoot, '.athanor', 'project-source.json'), {
            sourceWorkspaceId: (await this.registry(projectId)).workspaceId,
            taskId: update.taskId
          });
          await this.files(projectId).materialize(
            update.candidate,
            path.join(checkRoot, 'workspace'),
            true,
            () => this.active(check.id),
            (files, bytes) => {
              progress.files = files;
              progress.bytes = bytes;
            }
          );
          this.active(check.id);
          const process = await this.execution.start(
            check.id,
            update.taskId,
            check,
            `check-${check.id}`
          );
          await this.locked(projectId, `update:${id}`, async () => {
            const current = await this.update(projectId, id),
              saved = current.checks.find((item) => item.id === check.id)!;
            this.#preparations.delete(check.id);
            saved.sessionId = process.sessionId;
            saved.status = 'running';
            if (this.#cancelled.has(check.id)) {
              await this.execution.stop(check.id, update.taskId, process.sessionId);
              saved.status = 'cancelled';
            }
            await this.save(current);
          });
        } catch (error) {
          await this.locked(projectId, `update:${id}`, async () => {
            const current = await this.update(projectId, id),
              saved = current.checks.find((item) => item.id === check.id)!;
            this.#preparations.delete(check.id);
            saved.status = this.#cancelled.has(check.id) ? 'cancelled' : 'failed';
            saved.finishedAt = now();
            saved.detail = String(error);
            if (current.state !== 'cancelled') current.state = 'checks_failed';
            await this.save(current);
          });
        }
      });
      return this.view(update);
    });
  }
  private async refresh(update: StoredUpdate): Promise<StoredUpdate> {
    if (['published', 'publishing', 'cancelled', 'failed'].includes(update.state)) return update;
    if (update.state === 'preparing' && !this.#operations.has(update.id)) {
      update.state = 'failed';
      update.detail =
        'Preparation was interrupted. Prepare the update again; published files are unchanged.';
      await this.save(update);
      return update;
    }
    let changed = false;
    for (const check of update.checks) {
      if (['preparing', 'verifying'].includes(check.status) && !this.#operations.has(check.id)) {
        check.status = 'interrupted';
        check.detail = 'Check preparation was interrupted. Rebuild this update to try again.';
        check.finishedAt = now();
        changed = true;
      }
      if (check.status !== 'running' || !check.sessionId) continue;
      let process: CheckProcess;
      try {
        process = await this.execution.poll(check.id, update.taskId, check.sessionId, false);
      } catch {
        check.status = 'interrupted';
        check.detail = 'The check process is unavailable; it is not a passing result.';
        check.finishedAt = now();
        changed = true;
        continue;
      }
      check.ranForMs = process.ranForMs;
      if (process.resources) check.resources = process.resources;
      if (process.status === 'running') continue;
      check.exitCode = process.exitCode ?? null;
      check.finishedAt = process.finishedAt ?? now();
      changed = true;
      if (process.status === 'completed' && process.exitCode === 0) {
        check.status = 'verifying';
        check.detail = 'Command exited successfully. Verifying the captured source files.';
        this.launch(update.projectId, check.id, async () => {
          let status: 'passed' | 'invalidated' | 'failed' = 'failed';
          let detail: string | null = null;
          try {
            status = (await this.files(update.projectId).matches(
              workspacePath(this.root, check.id),
              update.candidate,
              () => this.active(check.id)
            ))
              ? 'passed'
              : 'invalidated';
            if (status === 'invalidated')
              detail =
                'The command changed candidate source files. This result does not verify the prepared version.';
          } catch (error) {
            detail = String(error);
          }
          await this.locked(update.projectId, `update:${update.id}`, async () => {
            const current = await this.update(update.projectId, update.id),
              saved = current.checks.find((item) => item.id === check.id)!;
            if (current.state === 'cancelled' || this.#cancelled.has(check.id)) return;
            saved.status = status;
            saved.detail = detail;
            current.state = current.checks.some((item) =>
              ['preparing', 'running', 'verifying'].includes(item.status)
            )
              ? 'checking'
              : current.checks.every((item) => ['passed', 'pending'].includes(item.status))
                ? 'ready'
                : 'checks_failed';
            await this.save(current);
          });
        });
      } else {
        check.status =
          process.status === 'stopped'
            ? 'cancelled'
            : process.status === 'interrupted'
              ? 'interrupted'
              : 'failed';
        check.detail = `Check ended with ${process.status}${process.exitCode == null ? '' : ` (exit ${process.exitCode})`}.`;
      }
    }
    if (
      changed ||
      (update.state === 'checking' &&
        !update.checks.some((check) =>
          ['preparing', 'running', 'verifying'].includes(check.status)
        ))
    ) {
      update.state = update.checks.some((check) =>
        ['running', 'preparing', 'verifying'].includes(check.status)
      )
        ? 'checking'
        : update.checks.some((check) =>
              ['failed', 'interrupted', 'invalidated', 'cancelled'].includes(check.status)
            )
          ? 'checks_failed'
          : update.changes.some((change) => change.conflict)
            ? 'conflicted'
            : 'ready';
      await this.save(update);
    }
    return update;
  }
  async inspect(projectId: string, id: string, changesAfter?: string): Promise<ProjectUpdate> {
    return this.locked(projectId, `update:${id}`, async () => {
      const update = await this.refresh(await this.update(projectId, id));
      const view = this.view(update, changesAfter);
      if (
        !['preparing', 'publishing', 'published', 'failed', 'cancelled'].includes(view.state) &&
        (await this.registry(projectId)).head !== view.parentRevision
      ) {
        view.state = 'outdated';
        view.detail =
          'A newer version was published. Rebuild and check the combined update before publishing.';
      }
      return view;
    });
  }
  async checkOutput(
    projectId: string,
    id: string,
    checkId: string,
    stop = false
  ): Promise<CheckProcess | { status: string }> {
    return this.locked(projectId, `update:${id}`, async () => {
      await assertHistoryContentAvailable(this.retention(projectId), 'check', checkId);
      const update = await this.update(projectId, id),
        check = update.checks.find((item) => item.id === checkId);
      if (!check) throw new Error('Project check not found');
      if (stop) {
        this.#cancelled.add(check.id);
        if (check.sessionId && ['preparing', 'running'].includes(check.status))
          await this.execution.stop(check.id, update.taskId, check.sessionId);
        if (['pending', 'preparing', 'running', 'verifying'].includes(check.status)) {
          check.status = 'cancelled';
          check.finishedAt = now();
          await this.save(update);
        }
      }
      return check.sessionId
        ? this.execution.poll(check.id, update.taskId, check.sessionId, true)
        : { status: check.status };
    });
  }
  async cancel(projectId: string, id: string): Promise<ProjectUpdate> {
    return this.locked(projectId, `update:${id}`, async () => {
      const update = await this.update(projectId, id);
      if (['published', 'publishing'].includes(update.state))
        throw new Error('Published versions stay available to running work');
      this.#cancelled.add(id);
      for (const check of update.checks) {
        this.#cancelled.add(check.id);
        if (check.sessionId && check.status === 'running')
          await this.execution.stop(check.id, update.taskId, check.sessionId);
        if (['pending', 'preparing', 'running', 'verifying'].includes(check.status)) {
          check.status = 'cancelled';
          check.finishedAt = now();
        }
      }
      update.state = 'cancelled';
      await this.save(update);
      return this.view(update);
    });
  }
  private async completePublication(
    projectId: string,
    pending: { updateId: string; revisionId: string }
  ): Promise<ProjectRevision> {
    const registry = await this.registry(projectId);
    const revision = await this.revision(projectId, pending.revisionId);
    const update = await this.update(projectId, pending.updateId);
    if (
      revision.updateId !== update.id ||
      revision.digest !== update.candidateDigest ||
      (registry.head !== revision.parentId && registry.head !== revision.id)
    )
      throw new Error('Pending publication no longer matches the project version');
    await this.repositories(projectId).publish(revision.repositories ?? []);
    registry.head = revision.id;
    await durableJson(this.file(projectId, 'registry.json'), registry);
    update.state = 'published';
    update.publishedRevision = revision.id;
    update.uncheckedReason = revision.uncheckedReason;
    await this.save(update);
    await this.advanceBaseline(projectId, registry, update, revision.id);
    await rm(this.file(projectId, 'publishing.json'));
    await syncDirectory(this.file(projectId, ''));
    return this.revisionView(revision);
  }
  async publish(
    projectId: string,
    id: string,
    expectedDigest: string,
    uncheckedReason?: string
  ): Promise<ProjectRevision> {
    return this.locked(projectId, projectId, () =>
      this.locked(projectId, `update:${id}`, async () => {
        const pending = await readJson<{ updateId: string; revisionId: string }>(
          this.file(projectId, 'publishing.json')
        );
        if (pending) {
          if (pending.updateId !== id)
            throw new Error(
              'A project publication is awaiting recovery. Resume that publication first.'
            );
          const revision = await this.revision(projectId, pending.revisionId);
          if (revision.digest !== expectedDigest) throw new Error('Publication digest changed');
          return this.completePublication(projectId, pending);
        }
        const registry = await this.registry(projectId);
        const head = registry.head ? await this.revision(projectId, registry.head) : null;
        const update = await this.refresh(await this.update(projectId, id));
        if (head?.updateId === id || update.publishedRevision) {
          const revision =
            head?.updateId === id
              ? head
              : await this.revision(projectId, update.publishedRevision!);
          if (update.contentRemoval) return this.revisionSummary(projectId, revision.id);
          update.state = 'published';
          update.publishedRevision = revision.id;
          await this.save(update);
          const archive = await this.retention(projectId).status(revision.id);
          if (!archive) await this.advanceBaseline(projectId, registry, update, revision.id);
          return { ...this.revisionView(revision), ...(archive ? { archive } : {}) };
        }
        await assertHistoryContentAvailable(this.retention(projectId), 'update', id);
        if (update.candidateDigest !== expectedDigest || update.parentRevision !== registry.head)
          throw new Error('The project version changed. Rebuild and check the combined update.');
        if (
          this.#operations.has(id) ||
          update.state !== 'ready' ||
          (update.changes.length === 0 &&
            !update.repositories?.some((repository) => repository.historyChanged)) ||
          update.changes.some((change) => change.conflict)
        )
          throw new Error('This update is not ready to publish');
        if (
          update.checks.some(
            (check) => check.status !== 'passed' || check.candidateDigest !== expectedDigest
          )
        )
          throw new Error(
            'Every configured check must pass on this candidate before it can be published'
          );
        if (!update.checks.length && !uncheckedReason?.trim())
          throw new Error(
            'No checks were run. Publishing requires an explicit owner decision and reason.'
          );
        await this.repositories(projectId).assertCurrent(update.repositories ?? []);
        const revisionId = randomUUID(),
          publicRoot = path.join(this.publicDirectory(projectId), 'versions', revisionId);
        await this.files(projectId).materialize(
          update.candidate,
          path.join(publicRoot, 'workspace'),
          false
        );
        const revision: StoredRevision = {
          id: revisionId,
          number: (head?.number ?? 0) + 1,
          parentId: registry.head,
          updateId: id,
          taskId: update.taskId,
          title: update.title,
          digest: expectedDigest,
          fileCount: Object.keys(update.candidate).length,
          bytes: Object.values(update.candidate).reduce((sum, file) => sum + file.bytes, 0),
          createdAt: now(),
          path: path.join(publicRoot, 'workspace'),
          files: update.candidate,
          repositories: update.repositories ?? [],
          checks: structuredClone(update.checks),
          uncheckedReason: update.checks.length ? null : uncheckedReason!.trim()
        };
        await durableJson(this.file(projectId, `revisions/${revisionId}.json`), revision);
        await durableJson(
          this.file(projectId, `revision-summaries/${revisionId}.json`),
          this.revisionView(revision)
        );
        const publication = { updateId: id, revisionId };
        await durableJson(this.file(projectId, 'publishing.json'), publication);
        update.state = 'publishing';
        await this.save(update);
        return this.completePublication(projectId, publication);
      })
    );
  }
  private async advanceBaseline(
    projectId: string,
    registry: Registry,
    update: StoredUpdate,
    revisionId: string
  ): Promise<void> {
    const actorWorkspaceId = registry.members[update.taskId];
    if (actorWorkspaceId) {
      const baselineFile = this.file(projectId, `baselines/${actorWorkspaceId}.json`);
      const baseline = (await readJson<{ revision: string | null; files: VersionTree }>(
        baselineFile
      )) ?? { revision: null, files: {} };
      if (
        baseline.revision &&
        baseline.revision !== revisionId &&
        (await this.revision(projectId, baseline.revision)).number >
          (await this.revision(projectId, revisionId)).number
      )
        return;
      for (const change of update.changes) {
        if (change.proposed) baseline.files[change.path] = change.proposed;
        else delete baseline.files[change.path];
      }
      baseline.revision = revisionId;
      await durableJson(baselineFile, baseline);
    }
  }
  async list(
    projectId: string,
    before?: string,
    revisionsBefore?: string
  ): Promise<ProjectUpdates> {
    const registry = await this.registry(projectId);
    const names = (
      await readdir(this.file(projectId, 'summaries')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })
    )
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse();
    const cursorIndex = before
      ? names.findIndex((name) => name.endsWith(`_${uuid(before)}.json`))
      : -1;
    if (before && cursorIndex < 0) throw new Error('Project update cursor not found');
    const page = names.slice(cursorIndex + 1, cursorIndex + 41);
    const visible = await Promise.all(
      page.map(async (name) => {
        const summary = (await readJson<ProjectUpdate>(this.file(projectId, `summaries/${name}`)))!;
        const live = this.#live.get(summary.id);
        const value = await this.contentView(
          live
            ? this.view(live)
            : ['preparing', 'checking'].includes(summary.state)
              ? await this.inspect(projectId, summary.id)
              : summary
        );
        if (
          !['preparing', 'publishing', 'published', 'failed', 'cancelled'].includes(value.state) &&
          registry.head !== value.parentRevision
        )
          value.state = 'outdated';
        return {
          ...value,
          changes: value.changes.map(({ diff: _diff, ...change }) => ({ ...change, diff: null }))
        };
      })
    );
    const visibleIds = new Set(visible.map((update) => update.id));
    const activeIds = new Set([
      ...[...this.#watching].filter(([, project]) => project === projectId).map(([id]) => id),
      ...[...this.#live.values()]
        .filter((update) => update.projectId === projectId)
        .map((update) => update.id)
    ]);
    const additional = await Promise.all(
      [...activeIds]
        .filter((id) => !visibleIds.has(id))
        .map(async (id) => ({ ...(await this.inspect(projectId, id)), changes: [] }))
    );
    const running = (update: ProjectUpdate) =>
      update.state === 'preparing' ||
      update.checks.some((check) => ['preparing', 'running', 'verifying'].includes(check.status));
    const all = [...additional, ...visible].sort(
      (a, b) =>
        Number(running(b)) - Number(running(a)) ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id)
    );
    const revisions: ProjectRevision[] = [];
    const summaries = new Map<string, Promise<ProjectRevision>>();
    const revisionSummary = (id: string): Promise<ProjectRevision> => {
      let summary = summaries.get(id);
      if (!summary) {
        summary = this.revisionSummary(projectId, id);
        summaries.set(id, summary);
      }
      return summary;
    };
    const head = registry.head ? await revisionSummary(registry.head) : null;
    let revisionId = revisionsBefore
      ? (await revisionSummary(revisionsBefore)).parentId
      : registry.head;
    const visited = new Set<string>();
    while (revisionId && revisions.length < 40) {
      if (visited.has(revisionId)) throw new Error('Project version history contains a cycle');
      visited.add(revisionId);
      const revision = await revisionSummary(revisionId);
      revisions.push(revision);
      revisionId = revision.parentId;
    }
    return {
      head,
      workingCopies: await this.gitWorkingCopies(projectId).list(),
      updates: all,
      revisions,
      nextCursor: names.length > cursorIndex + 41 ? visible.at(-1)!.id : null,
      nextRevisionCursor: revisionId ? revisions.at(-1)!.id : null,
      observedAt: now()
    };
  }
}
