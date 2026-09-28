import { constants, type Stats } from 'node:fs';
import { MAX_CAPABILITY_TTL_SECONDS } from '@garden/core';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, opendir, readFile, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireScope } from './auth.js';
import {
  assertOpenedInPlace,
  assertUserDataPath,
  ensureWorkspace,
  resolveInside,
  workspacePath
} from './files.js';
import { openDownloadFile } from './file-downloads.js';
import { assertHostStorageWrite } from './host-storage.js';

const Request = z
  .object({
    taskId: z.uuid(),
    workspaceId: z.uuid(),
    paths: z.array(z.string().min(1).max(1024)).max(128),
    kind: z.enum(['new', 'legacy'])
  })
  .strict();
const EXCLUDED = new Set([
  '.garden',
  '.garden',
  '.home',
  '.git',
  'node_modules',
  '.venv',
  '__pycache__'
]);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Fact = { sha256: string; bytes: number; mode: number };
export interface ProjectWorkspaceReceipt {
  taskId: string;
  sourceWorkspaceId: string;
  workspaceId: string;
  requestHash: string;
  directories?: Record<string, { ino: number; dev: number; mtimeMs: number; ctimeMs: number }>;
  files: Record<string, Fact>;
  excluded: string[];
  missing: string[];
  bytes: number;
  status: 'ready' | 'shared';
  handles?: Array<{ id: string; kind: string }>;
}
type Dependencies = {
  ownedWriters: (
    workspaceId: string,
    taskId: string
  ) => Array<{ id: string; kind: string }> | Promise<Array<{ id: string; kind: string }>>;
};

/** Copy only selected project sources. Unrelated work on the same computer keeps running. */
export class ProjectWorkspaces {
  readonly #running = new Map<string, Promise<ProjectWorkspaceReceipt>>();
  readonly #sources = new Map<string, string>();
  readonly #cancelled = new Set<string>();
  #assertActive(source: string, target: string): void {
    if (this.#cancelled.has(source) || this.#cancelled.has(target))
      throw Error('Project preparation was cancelled');
  }
  async cancelWorkspace(id: string): Promise<void> {
    z.uuid().parse(id);
    this.#cancelled.add(id);
    setTimeout(() => this.#cancelled.delete(id), (MAX_CAPABILITY_TTL_SECONDS + 60) * 1000).unref();
    await Promise.all(
      [...this.#running]
        .filter(([target]) => target === id || this.#sources.get(target) === id)
        .map(([, work]) => work.catch(() => undefined))
    );
    await this.#cleanupStages(id);
  }
  async #cleanupStages(id: string): Promise<void> {
    for await (const entry of await opendir(this.root, { bufferSize: 32 })) {
      if (
        !entry.name.startsWith(`.project-${id}-`) ||
        !entry.isDirectory() ||
        !z.uuid().safeParse(entry.name.slice(`.project-${id}-`.length)).success
      )
        continue;
      const stage = path.join(this.root, entry.name);
      try {
        const held = await open(
          path.join(stage, 'project-stage.json'),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
          const stat = await held.stat();
          if (!stat.isFile() || stat.size > 4096) continue;
          const marker = JSON.parse(await held.readFile('utf8')) as { workspaceId?: string };
          if (marker.workspaceId !== id) continue;
        } finally {
          await held.close();
        }
        await rm(stage, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  constructor(
    private readonly root: string,
    private readonly dependencies: Dependencies
  ) {}
  async inputs(workspaceId: string) {
    const target = workspacePath(this.root, workspaceId);
    try {
      const file = await open(
        path.join(target, '.garden', 'project-inputs.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      try {
        await assertOpenedInPlace(
          target,
          path.join(target, '.garden', 'project-inputs.json'),
          file
        );
        const info = await file.stat();
        if (info.size > 262144 || !info.isFile()) throw Error('Invalid project input metadata');
        const data = z
          .object({
            sources: z.array(z.uuid()).max(4096),
            projects: z.array(z.uuid()).max(64).default([])
          })
          .parse(JSON.parse(await file.readFile('utf8')));
        return {
          projects: data.projects.map((projectId) => ({
            projectId,
            path: path.join(this.root, '.project-store', projectId, 'public')
          })),
          sources: data.sources.map((id) => ({
            workspaceId: id,
            path: path.join(this.root, id, 'workspace')
          }))
        };
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sources: [], projects: [] };
      throw error;
    }
  }
  async setInputs(workspaceId: string, raw: unknown) {
    const input = z
      .object({
        sources: z.array(z.uuid()).max(4096),
        projects: z.array(z.uuid()).max(64).default([])
      })
      .strict()
      .parse(raw);
    const target = workspacePath(this.root, workspaceId);
    await ensureWorkspace(target);
    const sources = [...new Set(input.sources)].filter((id) => id !== workspaceId).sort();
    for (const id of sources) {
      const source = workspacePath(this.root, id);
      const directory = await open(
        path.join(source, 'workspace'),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        await assertOpenedInPlace(this.root, path.join(source, 'workspace'), directory);
      } finally {
        await directory.close();
      }
    }
    const metadata = path.join(target, '.garden');
    const directory = await open(
      metadata,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const temporary = path.join(metadata, `project-inputs-${randomUUID()}.json`);
    try {
      await assertOpenedInPlace(target, metadata, directory);
      const output = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await output.writeFile(JSON.stringify({ sources, projects: input.projects }));
        await output.sync();
      } finally {
        await output.close();
      }
      await assertOpenedInPlace(target, metadata, directory);
      await rename(temporary, path.join(metadata, 'project-inputs.json'));
    } finally {
      await directory.close();
      await rm(temporary, { force: true });
    }
    return {
      projects: input.projects.map((projectId) => ({
        projectId,
        path: path.join(this.root, '.project-store', projectId, 'public')
      })),
      sources: sources.map((workspaceId) => ({
        workspaceId,
        path: path.join(this.root, workspaceId, 'workspace')
      }))
    };
  }
  prepare(sourceWorkspaceId: string, raw: unknown): Promise<ProjectWorkspaceReceipt> {
    const input = Request.parse(raw);
    this.#assertActive(sourceWorkspaceId, input.workspaceId);
    if (sourceWorkspaceId === input.workspaceId)
      throw Error('Project execution needs a separate workspace');
    const existing = this.#running.get(input.workspaceId);
    if (existing)
      return existing.then((receipt) => {
        if (receipt.requestHash !== digest({ sourceWorkspaceId, ...input }))
          throw Error('Project preparation identity changed');
        return receipt;
      });
    const run = this.#prepare(sourceWorkspaceId, input);
    this.#running.set(input.workspaceId, run);
    this.#sources.set(input.workspaceId, sourceWorkspaceId);
    void run
      .finally(() => {
        this.#running.delete(input.workspaceId);
        this.#sources.delete(input.workspaceId);
      })
      .catch(() => undefined);
    return run;
  }
  async #prepare(
    sourceWorkspaceId: string,
    input: z.infer<typeof Request>
  ): Promise<ProjectWorkspaceReceipt> {
    const requestHash = digest({ sourceWorkspaceId, ...input });
    const source = workspacePath(this.root, sourceWorkspaceId),
      target = workspacePath(this.root, input.workspaceId);
    const marker = path.join(target, '.garden', 'project-source.json');
    try {
      const prior = JSON.parse(await readFile(marker, 'utf8')) as ProjectWorkspaceReceipt;
      if (
        prior.requestHash !== requestHash ||
        prior.workspaceId !== input.workspaceId ||
        prior.taskId !== input.taskId ||
        prior.sourceWorkspaceId !== sourceWorkspaceId ||
        prior.status !== 'ready'
      )
        throw Error('Project preparation identity changed');
      // An atomically published receipt identifies an already independent snapshot. Re-reading
      // its source would make a lost acknowledgement depend on later edits in another workspace.
      this.#assertActive(sourceWorkspaceId, input.workspaceId);
      return prior;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const handles = await this.dependencies.ownedWriters(sourceWorkspaceId, input.taskId);
    if (handles.length)
      return {
        taskId: input.taskId,
        sourceWorkspaceId,
        workspaceId: input.workspaceId,
        requestHash,
        files: {},
        excluded: [],
        missing: [],
        bytes: 0,
        status: 'shared',
        handles
      };
    // Never replace an existing execution root, even when a previous reply was lost.
    try {
      await lstat(target);
      throw Error('Project destination already exists without its preparation receipt');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.#cleanupStages(input.workspaceId);
    const staging = path.join(this.root, `.project-${input.workspaceId}-${randomUUID()}`);
    const receipt: ProjectWorkspaceReceipt = {
      taskId: input.taskId,
      sourceWorkspaceId,
      workspaceId: input.workspaceId,
      requestHash,
      files: {},
      excluded: [],
      missing: [],
      bytes: 0,
      status: 'ready'
    };
    const directories: Array<{ target: string; stat: Stats }> = [];
    let entries = 0;
    const deadline = Date.now() + 60_000;
    const bound = () => {
      this.#assertActive(sourceWorkspaceId, input.workspaceId);
      if (Date.now() > deadline || ++entries > 40_000)
        throw Error('Project snapshot traversal bound exceeded');
    };
    const selected = [
      ...new Set(input.paths.map((value) => assertUserDataPath(source, value)))
    ].sort();
    for (const selectedPath of selected)
      if (!selectedPath.startsWith(`workspace${path.sep}`))
        throw Error('Project sources must be inside workspace');
    await mkdir(staging, { mode: 0o750 });
    const stageMarker = await open(path.join(staging, 'project-stage.json'), 'wx', 0o600);
    try {
      await stageMarker.writeFile(
        JSON.stringify({ workspaceId: input.workspaceId, taskId: input.taskId, requestHash })
      );
      await stageMarker.sync();
    } finally {
      await stageMarker.close();
    }
    try {
      await ensureWorkspace(staging);
      const visit = async (relative: string, depth = 0): Promise<void> => {
        bound();
        if (depth > 64 || relative.length > 1024) throw Error('Project snapshot depth exceeded');
        if (relative.split(path.sep).some((part) => EXCLUDED.has(part))) {
          receipt.excluded.push(relative);
          return;
        }
        const filename = resolveInside(source, relative);
        const held = await open(
          filename,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
          await assertOpenedInPlace(source, filename, held);
          const stat = await held.stat();
          if (stat.isDirectory()) {
            directories.push({ target: filename, stat });
            // The native parent supplies setgid inheritance; requesting that bit is
            // rejected by the runner's RestrictSUIDSGID syscall policy.
            await mkdir(resolveInside(staging, relative), { recursive: true, mode: 0o770 });
            for await (const entry of await opendir(filename, { bufferSize: 32 }))
              await visit(path.join(relative, entry.name), depth + 1);
            await assertOpenedInPlace(source, filename, held);
          } else if (stat.isFile()) {
            if (receipt.files[relative]) return;
            if (
              Object.keys(receipt.files).length >= 10_000 ||
              receipt.bytes + stat.size > 1_073_741_824
            )
              throw Error('Project snapshot exceeds its file or byte bound');
            await assertHostStorageWrite(staging, stat.size);
            await mkdir(path.dirname(resolveInside(staging, relative)), {
              recursive: true,
              mode: 0o770
            });
            const destination = await open(
              resolveInside(staging, relative),
              'wx',
              stat.mode & 0o111 ? 0o770 : 0o660
            );
            const hash = createHash('sha256');
            try {
              for await (const chunk of held.createReadStream({ autoClose: false })) {
                bound();
                const bytes = Buffer.from(chunk as Buffer);
                hash.update(bytes);
                let offset = 0;
                while (offset < bytes.length) {
                  const write = await destination.write(bytes, offset, bytes.length - offset);
                  if (!write.bytesWritten) throw Error('Project copy stopped');
                  offset += write.bytesWritten;
                }
              }
              await destination.sync();
            } finally {
              await destination.close();
            }
            const after = await held.stat();
            if (
              after.size !== stat.size ||
              after.mtimeMs !== stat.mtimeMs ||
              after.ctimeMs !== stat.ctimeMs
            )
              throw Error('A selected project source changed during preparation');
            receipt.files[relative] = {
              sha256: hash.digest('hex'),
              bytes: stat.size,
              mode: stat.mode & 0o111 ? 0o770 : 0o660
            };
            receipt.bytes += stat.size;
          } else throw Error('Project sources must be regular files and directories');
        } finally {
          await held.close();
        }
      };
      for (const relative of selected) {
        if (
          selected.some((other) => other !== relative && relative.startsWith(`${other}${path.sep}`))
        )
          continue;
        try {
          await visit(relative);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') receipt.missing.push(relative);
          else throw error;
        }
      }
      // Earlier files must still match after the final file was copied.
      for (const [relative, fact] of Object.entries(receipt.files)) {
        bound();
        const opened = await openDownloadFile(source, relative);
        try {
          const hash = createHash('sha256');
          for await (const chunk of opened.handle.createReadStream({ autoClose: false })) {
            bound();
            hash.update(chunk as Buffer);
          }
          if (opened.stat.size !== fact.bytes || hash.digest('hex') !== fact.sha256)
            throw Error('A selected project source changed during preparation');
        } finally {
          await opened.handle.close();
        }
      }
      for (const directory of directories) {
        const now = await lstat(directory.target);
        if (
          now.ino !== directory.stat.ino ||
          now.dev !== directory.stat.dev ||
          now.mtimeMs !== directory.stat.mtimeMs ||
          now.ctimeMs !== directory.stat.ctimeMs
        )
          throw Error('A selected project directory changed during preparation');
      }
      const finalHandles = await this.dependencies.ownedWriters(sourceWorkspaceId, input.taskId);
      if (finalHandles.length)
        throw Error('This project started a managed writer during preparation');
      receipt.directories = Object.fromEntries(
        directories.map(({ target, stat }) => [
          path.relative(source, target),
          { ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
        ])
      );
      const output = await open(path.join(staging, '.garden', 'project-source.json'), 'wx', 0o600);
      try {
        await output.writeFile(JSON.stringify(receipt));
        await output.sync();
      } finally {
        await output.close();
      }
      this.#assertActive(sourceWorkspaceId, input.workspaceId);
      await rename(staging, target);
      return receipt;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export function registerProjectWorkspaceRoutes(
  app: FastifyInstance,
  manager: ProjectWorkspaces
): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/project-inputs',
    async (request) => {
      requireScope(request, 'files.read');
      return manager.inputs(request.params.workspaceId);
    }
  );
  app.put<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/project-inputs',
    async (request) => {
      requireScope(request, 'workspace.manage');
      if (request.capability.role !== 'control')
        throw Error('Project input access requires the control plane');
      return manager.setInputs(request.params.workspaceId, request.body);
    }
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/project-execution',
    async (request) => {
      requireScope(request, 'workspace.manage');
      if (request.capability.role !== 'control')
        throw Error('Project preparation requires the control plane');
      return manager.prepare(request.params.workspaceId, request.body);
    }
  );
}
