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
  ProjectUpdates
} from '@athanor/contracts';
import { PrepareProjectUpdate } from '@athanor/contracts';
import { ensureWorkspace, workspacePath, withWorkspaceDirectory } from './files.js';
import { ProjectLiveChanges } from './project-live-changes.js';
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
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #operations = new Map<string, Promise<void>>();
  readonly #cancelled = new Set<string>();
  readonly #live = new Map<string, StoredUpdate>();
  readonly #preparations = new Map<string, NonNullable<ProjectCheck['preparation']>>();
  readonly #watching = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #observing = false;
  #closed = false;
  constructor(
    readonly root: string,
    readonly execution: ProjectCheckExecution
  ) {}
  async restore(report: (error: unknown) => void = () => undefined): Promise<void> {
    const projects = await readdir(path.join(this.root, '.project-store')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    for (const projectId of projects.filter((id) => /^[a-f0-9-]{36}$/.test(id))) {
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
  backgroundPreparations(): number {
    return this.#operations.size;
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#changes.close();
    await Promise.allSettled([...this.#operations.values()]);
  }
  directory(projectId: string): string {
    return path.join(this.root, '.project-store', uuid(projectId));
  }
  publicDirectory(projectId: string): string {
    return path.join(this.directory(projectId), 'public');
  }
  private file(projectId: string, name: string): string {
    return path.join(this.directory(projectId), 'state', name);
  }
  private files(projectId: string) {
    return new ProjectVersionFiles(this.file(projectId, 'content'));
  }
  private locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const run = (this.#locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
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
    await this.locked(projectId, async () => {
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
      await durableMkdir(this.publicDirectory(projectId), 0o755);
      registry.members[taskId] = workspaceId;
      await durableJson(this.file(projectId, 'registry.json'), registry);
      const baseline = this.file(projectId, `baselines/${workspaceId}.json`);
      if (!(await readJson(baseline))) {
        await durableJson(baseline, { revision: registry.head, files: {} });
      }
    });
  }
  async checkRoot(projectId: string, updateId: string, checkId: string): Promise<string> {
    const update = await this.update(projectId, updateId);
    if (!update.checks.some((check) => check.id === checkId && check.sessionId))
      throw new Error('Check files are not available');
    return workspacePath(this.root, checkId);
  }
  async revisionRoot(projectId: string, revisionId: string): Promise<string> {
    return path.dirname((await this.revision(projectId, revisionId)).path);
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
  async update(projectId: string, id: string): Promise<StoredUpdate> {
    const live = this.#live.get(id);
    if (live?.projectId === projectId) return live;
    const update = await readJson<StoredUpdate>(this.file(projectId, `updates/${uuid(id)}.json`));
    if (!update) throw new Error('Project update not found');
    return update;
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
      ...view
    } = update;
    const start = after ? update.changes.findIndex((change) => change.path === after) + 1 : 0;
    if (after && !start) throw new Error('Changed file cursor not found');
    const changes = update.changes.slice(start, start + 100);
    return {
      ...view,
      checks: view.checks.map((check) => ({
        ...check,
        ...(this.#preparations.has(check.id)
          ? { preparation: this.#preparations.get(check.id)! }
          : {})
      })),
      changes,
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
  private launch(id: string, action: () => Promise<void>) {
    if (this.#operations.has(id)) return;
    const operation = action();
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
    return this.locked(`prepare:${id}`, async () => {
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
      this.launch(id, () => this.capture(update));
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
    update.state = conflicted ? 'conflicted' : 'ready';
    update.progress.stage = conflicted
      ? 'Resolve conflicting files'
      : changes.length
        ? 'Ready for checks'
        : 'No changed files';
    if (!changes.length)
      update.detail =
        'The selected files do not change the published project. There is nothing to publish.';
    await this.save(update);
  }
  async rebase(
    projectId: string,
    id: string,
    requestId: string = randomUUID()
  ): Promise<ProjectUpdate> {
    return this.locked(`prepare:${uuid(requestId)}`, async () => {
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
      if (['preparing', 'checking', 'published', 'cancelled'].includes(previous.state))
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
      this.launch(update.id, async () => {
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
    revisionId?: string
  ): Promise<{ revisionId: string; files: string[] }> {
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
    return this.locked(`checkout:${workspaceId}`, async () => {
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
      return { revisionId: id, files };
    });
  }

  async startCheck(
    projectId: string,
    id: string,
    checkId: string,
    expectedDigest: string
  ): Promise<ProjectUpdate> {
    return this.locked(`update:${id}`, async () => {
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
      this.launch(check.id, async () => {
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
          await this.locked(`update:${id}`, async () => {
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
          await this.locked(`update:${id}`, async () => {
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
    if (['published', 'cancelled', 'failed'].includes(update.state)) return update;
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
        this.launch(check.id, async () => {
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
          await this.locked(`update:${update.id}`, async () => {
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
    return this.locked(`update:${id}`, async () => {
      const update = await this.refresh(await this.update(projectId, id));
      const view = this.view(update, changesAfter);
      if (
        !['preparing', 'published', 'failed', 'cancelled'].includes(view.state) &&
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
    return this.locked(`update:${id}`, async () => {
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
    return this.locked(`update:${id}`, async () => {
      const update = await this.update(projectId, id);
      if (update.state === 'published')
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
  async publish(
    projectId: string,
    id: string,
    expectedDigest: string,
    uncheckedReason?: string
  ): Promise<ProjectRevision> {
    return this.locked(projectId, () =>
      this.locked(`update:${id}`, async () => {
        const registry = await this.registry(projectId);
        const head = registry.head ? await this.revision(projectId, registry.head) : null;
        const update = await this.refresh(await this.update(projectId, id));
        if (head?.updateId === id || update.publishedRevision) {
          const revision =
            head?.updateId === id
              ? head
              : await this.revision(projectId, update.publishedRevision!);
          update.state = 'published';
          update.publishedRevision = revision.id;
          await this.save(update);
          await this.advanceBaseline(projectId, registry, update, revision.id);
          return this.revisionView(revision);
        }
        if (update.candidateDigest !== expectedDigest || update.parentRevision !== registry.head)
          throw new Error('The project version changed. Rebuild and check the combined update.');
        if (
          this.#operations.has(id) ||
          update.state !== 'ready' ||
          update.changes.length === 0 ||
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
          checks: structuredClone(update.checks),
          uncheckedReason: update.checks.length ? null : uncheckedReason!.trim()
        };
        await durableJson(this.file(projectId, `revisions/${revisionId}.json`), revision);
        await durableJson(
          this.file(projectId, `revision-summaries/${revisionId}.json`),
          this.revisionView(revision)
        );
        registry.head = revisionId;
        await durableJson(this.file(projectId, 'registry.json'), registry);
        update.state = 'published';
        update.publishedRevision = revisionId;
        update.uncheckedReason = revision.uncheckedReason;
        await this.save(update);
        await this.advanceBaseline(projectId, registry, update, revisionId);
        return this.revisionView(revision);
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
        const value = live
          ? this.view(live)
          : ['preparing', 'checking'].includes(summary.state)
            ? await this.inspect(projectId, summary.id)
            : summary;
        if (
          !['preparing', 'published', 'failed', 'cancelled'].includes(value.state) &&
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
    const revisionSummary = async (id: string): Promise<ProjectRevision> =>
      (await readJson<ProjectRevision>(
        this.file(projectId, `revision-summaries/${uuid(id)}.json`)
      )) ?? this.revisionView(await this.revision(projectId, id));
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
      updates: all,
      revisions,
      nextCursor: names.length > cursorIndex + 41 ? visible.at(-1)!.id : null,
      nextRevisionCursor: revisionId ? revisions.at(-1)!.id : null,
      observedAt: now()
    };
  }
}
