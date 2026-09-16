import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  open,
  mkdir,
  opendir,
  readFile,
  writeFile,
  rename,
  rm,
  chmod,
  lstat,
  unlink,
  type FileHandle
} from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CodingMissionChange } from '@athanor/contracts';
import {
  assertOpenedInPlace,
  assertUserDataPath,
  ensureWorkspace,
  resolveInside,
  workspacePath,
  withWorkspaceDirectory
} from './files.js';
import { openDownloadFile } from './file-downloads.js';
import { requireScope } from './auth.js';

const MAX_FILES = 10_000,
  MAX_BYTES = 1_073_741_824,
  MAX_CHANGED_FILES = 500,
  MAX_DIFF_BYTES = 1_048_576;
const EXCLUDED = new Set([
  '.git',
  '.athanor',
  '.garden',
  '.home',
  'node_modules',
  '.venv',
  '__pycache__'
]);
const excludes = (name: string) =>
  EXCLUDED.has(name) ||
  ['.npmrc', '.pypirc', '.netrc'].includes(name) ||
  (name.startsWith('.env') && !['.env.example', '.env.sample', '.env.template'].includes(name));
const Start = z.object({
  childWorkspaceId: z.uuid(),
  childTaskId: z.uuid(),
  sourceRoot: z.string().min(1).max(1024),
  outputPaths: z.array(z.string().min(1).max(1024)).min(1).max(20),
  generation: z.number().int().positive()
});
interface FileFact {
  hash: string;
  bytes: number;
  mode: number;
}
interface Manifest {
  id: string;
  parentWorkspaceId: string;
  parentTaskId: string;
  childWorkspaceId: string;
  childTaskId: string;
  sourceRoot: string;
  outputPaths: string[];
  generation: number;
  phase: 'preparing' | 'active' | 'ready' | 'cancelled' | 'integrating' | 'integrated' | 'failed';
  base: Record<string, FileFact>;
  excluded: string[];
  createdAt: string;
  sealed?: boolean;
  integration?: { digest: string; applied: string[]; changes: CodingMissionChange[] };
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const relativePath = (value: string): string => {
  const normalized = assertUserDataPath('/garden-scope', value);
  if (!normalized.startsWith(`workspace${path.sep}`))
    throw new Error('Name a relative project path');
  return normalized.slice('workspace/'.length).replaceAll(path.sep, '/');
};
const inScope = (file: string, roots: readonly string[]) =>
  roots.some((root) => file === root || file.startsWith(`${root}/`));
const syncDirectory = async (directory: string, held?: FileHandle): Promise<void> => {
  // A Linux anchored path names a kernel descriptor link. Sync its verified open directory directly.
  if (held) {
    await held.sync();
    return;
  }
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const removeJournal = async (filename: string): Promise<void> => {
  await rm(filename, { force: true });
  await syncDirectory(path.dirname(filename));
};
const jsonWrite = async (filename: string, value: unknown) => {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await rm(temp, { force: true });
  }
};
const runGit = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.fsmonitor=false',
        ...args
      ],
      {
        cwd,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: cwd,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let output = '',
      error = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Isolated Git operation timed out'));
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < MAX_DIFF_BYTES) output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (error.length < 4_000) error += chunk.toString();
    });
    child.on('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`Isolated Git operation failed: ${error}`));
    });
  });

/** Walk through verified directory handles; never follow a source link into another project. */
async function scan(
  root: string,
  source: string,
  copyTo?: string
): Promise<{ files: Record<string, FileFact>; excluded: string[] }> {
  const files: Record<string, FileFact> = {},
    excluded: string[] = [];
  let bytes = 0,
    entries = 0,
    count = 0;
  const visit = async (relative: string, depth = 0): Promise<void> => {
    if (depth > 64 || relative.length > 1024)
      throw new Error('Coding snapshot directory depth exceeded');
    const target = resolveInside(root, path.join(source, relative));
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      await assertOpenedInPlace(root, target, handle);
      if (!(await handle.stat()).isDirectory())
        throw new Error('Coding source root is not a directory');
      if (copyTo) await mkdir(resolveInside(copyTo, relative), { recursive: true, mode: 0o2770 });
      for await (const entry of await opendir(target, { bufferSize: 32 })) {
        if (++entries > MAX_FILES * 4) throw new Error('Coding snapshot traversal limit exceeded');
        const nested = path.join(relative, entry.name),
          key = nested.replaceAll(path.sep, '/');
        if (excludes(entry.name)) {
          excluded.push(key);
          continue;
        }
        if (entry.isSymbolicLink())
          throw new Error(`Coding source contains a symbolic link: ${key}`);
        if (entry.isDirectory()) {
          await visit(nested, depth + 1);
          continue;
        }
        if (!entry.isFile()) throw new Error(`Coding source contains a special file: ${key}`);
        if (++count > MAX_FILES) throw new Error('Coding snapshot file count limit exceeded');
        const opened = await openDownloadFile(root, path.join(source, nested));
        try {
          bytes += opened.stat.size;
          if (bytes > MAX_BYTES) throw new Error('Coding snapshot exceeds its byte limit');
          const hash = createHash('sha256');
          const destination = copyTo
            ? await open(
                resolveInside(copyTo, nested),
                'wx',
                opened.stat.mode & 0o111 ? 0o770 : 0o660
              )
            : null;
          try {
            for await (const chunk of opened.handle.createReadStream({ autoClose: false })) {
              hash.update(chunk as Buffer);
              if (destination) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                let written = 0;
                while (written < buffer.length) {
                  const next = await destination.write(buffer, written, buffer.length - written);
                  if (next.bytesWritten <= 0)
                    throw new Error('The snapshot could not be copied in full');
                  written += next.bytesWritten;
                }
              }
            }
            await destination?.sync();
          } finally {
            await destination?.close();
          }
          const after = await opened.handle.stat();
          if (
            after.size !== opened.stat.size ||
            after.mtimeMs !== opened.stat.mtimeMs ||
            after.ctimeMs !== opened.stat.ctimeMs
          )
            throw new Error('A source file changed during the coding snapshot');
          files[key] = {
            hash: hash.digest('hex'),
            bytes: after.size,
            mode: after.mode & 0o111 ? 0o770 : 0o660
          };
        } finally {
          await opened.handle.close();
        }
      }
      if (copyTo) await syncDirectory(resolveInside(copyTo, relative));
      await assertOpenedInPlace(root, target, handle);
    } finally {
      await handle.close();
    }
  };
  await visit('');
  return {
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    excluded: excluded.sort()
  };
}

async function readFact(
  root: string,
  file: string,
  fact: FileFact,
  limit: number
): Promise<Buffer> {
  const target = resolveInside(root, file);
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    await assertOpenedInPlace(root, target, handle);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== fact.bytes || stat.size > limit)
      throw new Error('The file changed after its review began');
    const content = await handle.readFile();
    if (createHash('sha256').update(content).digest('hex') !== fact.hash)
      throw new Error('The file changed after its review began');
    return content;
  } finally {
    await handle.close();
  }
}

export class NativeCodingMissions {
  private readonly live = new Map<string, Manifest>();
  private readonly runningRequests = new Map<string, Set<FastifyReply>>();
  private readonly activeWriters = new Map<string, Set<FastifyReply>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly frozen = new Set<string>();
  private readonly recovered = new Set<string>();
  constructor(
    private readonly root: string,
    private readonly confined: boolean,
    private readonly execution: {
      quiesceWorkspace: (id: string) => Promise<void>;
      isWorkspaceBusy: (id: string) => boolean | Promise<boolean>;
    }
  ) {}
  capabilities() {
    return {
      available: this.confined,
      reason: this.confined
        ? null
        : 'Coding specialists require native workspace and process isolation',
      maxFiles: MAX_FILES,
      maxBytes: MAX_BYTES
    };
  }
  private manifestFile(parent: string, id: string) {
    z.uuid().parse(id);
    return path.join(
      workspacePath(this.root, parent),
      '.athanor',
      'coding-missions',
      id,
      'manifest.json'
    );
  }
  private async load(parent: string, id: string): Promise<Manifest> {
    return JSON.parse(await readFile(this.manifestFile(parent, id), 'utf8')) as Manifest;
  }
  private async save(manifest: Manifest) {
    await jsonWrite(this.manifestFile(manifest.parentWorkspaceId, manifest.id), manifest);
    if (this.live.size >= 256) this.live.delete(this.live.keys().next().value!);
    this.live.set(manifest.childWorkspaceId, manifest);
  }
  private async locked<T>(parent: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(parent) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.locks.set(parent, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(parent) === next) this.locks.delete(parent);
    }
  }
  async guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.capability) return;
    const workspaceId = request.capability.workspaceId;
    const control = /\/coding-missions\/[^/]+\/(cancel|status|remove)$/.test(request.url);
    if (this.frozen.has(workspaceId)) {
      if (!control) throw new Error('This workspace is applying a reviewed coding integration');
      await this.locked(workspaceId, async () => undefined);
    }
    await this.recover(workspaceId);
    if (
      !request.url.includes('/coding-missions/') &&
      request.capability.scopes.some((scope) => !scope.endsWith('.read'))
    ) {
      const writers = this.activeWriters.get(workspaceId) ?? new Set<FastifyReply>();
      writers.add(reply);
      this.activeWriters.set(workspaceId, writers);
      reply.raw.once('close', () => {
        writers.delete(reply);
        if (!writers.size) this.activeWriters.delete(workspaceId);
      });
    }
    let mission = this.live.get(workspaceId);
    if (!mission) {
      try {
        const ref = JSON.parse(
          await readFile(
            path.join(workspacePath(this.root, workspaceId), '.athanor', 'coding-parent.json'),
            'utf8'
          )
        ) as { parent: string; id: string };
        mission = await this.load(ref.parent, ref.id);
        if (this.live.size >= 256) this.live.delete(this.live.keys().next().value!);
        this.live.set(workspaceId, mission);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
    if (request.capability.role !== 'agent') {
      if (!request.capability.scopes.every((scope) => scope.endsWith('.read')))
        throw new Error(
          'Use the parent mission controls; isolated specialist workspaces do not accept owner terminals or independent writers'
        );
      return;
    }
    if (
      mission.phase !== 'active' ||
      !(
        request.capability.sub === mission.childTaskId ||
        request.capability.sub.startsWith(`${mission.childTaskId}:specialist-`)
      )
    )
      throw new Error('This coding mission no longer has execution authority');
    const requests = this.runningRequests.get(workspaceId) ?? new Set();
    requests.add(reply);
    this.runningRequests.set(workspaceId, requests);
    reply.raw.once('close', () => {
      requests.delete(reply);
      if (!requests.size) this.runningRequests.delete(workspaceId);
    });
  }
  async start(
    parentWorkspaceId: string,
    parentTaskId: string,
    id: string,
    value: unknown
  ): Promise<{ generation: number; fileCount: number; excluded: string[]; isolation: string }> {
    if (!this.confined)
      throw new Error('Coding specialists require native workspace and process isolation');
    const input = Start.parse(value);
    z.uuid().parse(id);
    z.uuid().parse(parentTaskId);
    if (input.childWorkspaceId === parentWorkspaceId)
      throw new Error('A coding specialist needs a separate workspace');
    return this.locked(parentWorkspaceId, async () => {
      try {
        const held = await this.load(parentWorkspaceId, id);
        if (
          held.childWorkspaceId !== input.childWorkspaceId ||
          held.parentTaskId !== parentTaskId ||
          held.generation !== input.generation
        )
          throw new Error('Coding mission identity conflict');
        if (held.phase === 'active')
          return {
            generation: held.generation,
            fileCount: Object.keys(held.base).length,
            excluded: held.excluded,
            isolation: 'kernel-confined detached worktree'
          };
        throw new Error('Coding snapshot is incomplete or no longer active');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = workspacePath(this.root, parentWorkspaceId),
        child = workspacePath(this.root, input.childWorkspaceId);
      const source = assertUserDataPath(parent, input.sourceRoot);
      if (source !== 'workspace' && !source.startsWith('workspace/'))
        throw new Error('Coding source must be inside workspace');
      const outputPaths = input.outputPaths.map(relativePath);
      const manifest: Manifest = {
        id,
        parentWorkspaceId,
        parentTaskId,
        childWorkspaceId: input.childWorkspaceId,
        childTaskId: input.childTaskId,
        sourceRoot: source,
        outputPaths,
        generation: input.generation,
        phase: 'preparing',
        base: {},
        excluded: [],
        createdAt: new Date().toISOString()
      };
      await mkdir(child, { recursive: false, mode: 0o750 });
      await ensureWorkspace(child);
      await chmod(child, 0o750);
      await this.save(manifest);
      await jsonWrite(path.join(child, '.athanor', 'coding-parent.json'), {
        parent: parentWorkspaceId,
        id
      });
      try {
        const base = path.join(child, '.athanor', 'coding-base');
        await mkdir(base, { mode: 0o700 });
        const snapshot = await scan(parent, source, base);
        manifest.base = snapshot.files;
        manifest.excluded = snapshot.excluded;
        const repo = path.join(child, '.home', 'garden.git');
        await runGit(['init', '--bare', repo], child);
        // Runner-owned highest-priority attributes keep the snapshot byte-for-byte faithful.
        await writeFile(
          path.join(repo, 'info', 'attributes'),
          '* -text -filter -ident -working-tree-encoding\n'
        );
        await runGit(
          [`--git-dir=${repo}`, `--work-tree=${base}`, 'add', '--all', '--force', '--'],
          child
        );
        await runGit(
          [
            `--git-dir=${repo}`,
            `--work-tree=${base}`,
            '-c',
            'user.name=garden',
            '-c',
            'user.email=local@garden.invalid',
            'commit',
            '--allow-empty',
            '-m',
            'Coding mission base'
          ],
          child
        );
        await rm(path.join(child, 'workspace'), { recursive: true });
        await runGit(
          [
            `--git-dir=${repo}`,
            'worktree',
            'add',
            '--detach',
            path.join(child, 'workspace'),
            'HEAD'
          ],
          child
        );
        // Writable only inside this child's two kernel-granted roots; the base remains runner-private.
        const permissions = async (dir: string): Promise<void> => {
          await chmod(dir, 0o2770);
          for await (const entry of await opendir(dir)) {
            const item = path.join(dir, entry.name);
            if (entry.isDirectory()) await permissions(item);
            else if (entry.isFile())
              await chmod(item, (await lstat(item)).mode & 0o111 ? 0o770 : 0o660);
            else throw new Error('Unexpected link in isolated Git working copy');
          }
        };
        await permissions(path.join(child, 'workspace'));
        await permissions(repo);
        manifest.phase = 'active';
        await this.save(manifest);
        return {
          generation: manifest.generation,
          fileCount: Object.keys(manifest.base).length,
          excluded: manifest.excluded,
          isolation: 'kernel-confined detached worktree'
        };
      } catch (error) {
        manifest.phase = 'failed';
        await this.save(manifest);
        throw error;
      }
    });
  }
  private async absentChild(parent: string, child: string | undefined): Promise<boolean> {
    if (!child || child === parent) return false;
    z.uuid().parse(child);
    try {
      await lstat(workspacePath(this.root, child));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  private async assertChildIdentity(mission: Manifest): Promise<void> {
    const marker = JSON.parse(
      await readFile(
        path.join(
          workspacePath(this.root, mission.childWorkspaceId),
          '.athanor',
          'coding-parent.json'
        ),
        'utf8'
      )
    ) as { parent: string; id: string };
    if (marker.parent !== mission.parentWorkspaceId || marker.id !== mission.id)
      throw new Error('The isolated workspace identity does not match this coding mission');
  }
  async remove(parent: string, id: string, generation: number, childWorkspaceId: string) {
    await this.recover(parent);
    return this.locked(parent, async () => {
      let mission: Manifest;
      try {
        mission = await this.load(parent, id);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' &&
          (await this.absentChild(parent, childWorkspaceId))
        )
          return { removed: true };
        throw error;
      }
      if (
        mission.childWorkspaceId !== childWorkspaceId ||
        mission.generation !== generation ||
        !['cancelled', 'failed', 'integrated'].includes(mission.phase)
      )
        throw new Error('Stop this exact coding mission before removing its isolated workspace');
      if (!(await this.absentChild(parent, childWorkspaceId))) {
        await this.assertChildIdentity(mission);
        await this.execution.quiesceWorkspace(childWorkspaceId);
        await rm(workspacePath(this.root, childWorkspaceId), { recursive: true });
        await syncDirectory(this.root);
      }
      await rm(path.dirname(this.manifestFile(parent, id)), { recursive: true });
      await syncDirectory(path.dirname(path.dirname(this.manifestFile(parent, id))));
      this.live.delete(childWorkspaceId);
      this.recovered.delete(childWorkspaceId);
      return { removed: true };
    });
  }
  async cancel(parent: string, id: string, generation: number, childWorkspaceId?: string) {
    await this.recover(parent);
    return this.locked(parent, async () => {
      let mission: Manifest;
      try {
        mission = await this.load(parent, id);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' &&
          (await this.absentChild(parent, childWorkspaceId))
        )
          return { cancelled: true };
        throw error;
      }
      if (childWorkspaceId && mission.childWorkspaceId !== childWorkspaceId)
        throw new Error('Coding mission child identity mismatch');
      if (generation < mission.generation) throw new Error('Stale coding mission generation');
      if (mission.phase === 'integrated')
        throw new Error('The coding mission is already integrated');
      await this.assertChildIdentity(mission);
      mission.generation = generation;
      mission.phase = 'cancelled';
      await this.save(mission);
      for (const reply of this.runningRequests.get(mission.childWorkspaceId) ?? [])
        reply.raw.destroy();
      await this.execution.quiesceWorkspace(mission.childWorkspaceId);
      return { cancelled: true };
    });
  }
  private journalFile(parent: string) {
    return path.join(workspacePath(this.root, parent), '.athanor', 'coding-integration.json');
  }
  /** A crash during application rolls back before the first request can observe the workspace. */
  async recover(parent: string): Promise<void> {
    if (this.recovered.has(parent)) return;
    await this.locked(parent, async () => {
      if (this.recovered.has(parent)) return;
      if (this.recovered.size >= 256) this.recovered.delete(this.recovered.values().next().value!);
      let ref: { id: string };
      try {
        ref = JSON.parse(await readFile(this.journalFile(parent), 'utf8')) as { id: string };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.recovered.add(parent);
          return;
        }
        throw error;
      }
      this.frozen.add(parent);
      try {
        const mission = await this.load(parent, ref.id);
        await this.execution.quiesceWorkspace(mission.childWorkspaceId);
        if (
          mission.phase !== 'integrated' &&
          (mission.integration || !['active', 'ready'].includes(mission.phase))
        )
          await this.rollback(mission);
        await removeJournal(this.journalFile(parent));
        this.recovered.add(parent);
        this.frozen.delete(parent);
      } catch (error) {
        throw new Error('Coding integration recovery is incomplete; the workspace remains held', {
          cause: error
        });
      }
    });
  }
  private async install(
    mission: Manifest,
    change: CodingMissionChange,
    reverse = false
  ): Promise<void> {
    const parent = workspacePath(this.root, mission.parentWorkspaceId),
      child = workspacePath(this.root, mission.childWorkspaceId);
    const expected = reverse ? change.resultHash : change.baseHash,
      replacement = reverse ? change.baseHash : change.resultHash;
    const expectedExecutable = reverse ? change.resultExecutable : change.baseExecutable,
      replacementExecutable = reverse ? change.baseExecutable : change.resultExecutable;
    const relative = path.join(mission.sourceRoot, change.path),
      target = resolveInside(parent, relative);
    try {
      await withWorkspaceDirectory(
        parent,
        path.dirname(target),
        replacement !== null,
        async (directory, directoryHandle) => {
          const anchored = path.join(directory, path.basename(target));
          let current: string | null = null,
            executable: boolean | null = null;
          try {
            const opened = await open(
              anchored,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            );
            try {
              await assertOpenedInPlace(parent, target, opened);
              const stat = await opened.stat();
              if (!stat.isFile()) throw new Error('Integration target is not a regular file');
              executable = Boolean(stat.mode & 0o111);
              const hash = createHash('sha256');
              for await (const chunk of opened.createReadStream({ autoClose: false }))
                hash.update(chunk as Buffer);
              current = hash.digest('hex');
            } finally {
              await opened.close();
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          // Recovery is idempotent even if the process died between a file rename and its receipt.
          if (
            current === replacement &&
            (replacementExecutable === undefined || executable === replacementExecutable)
          )
            return;
          if (
            current !== expected ||
            (expectedExecutable !== undefined && executable !== expectedExecutable)
          )
            throw new Error('A parent file changed after its integration review');
          if (replacement === null) {
            await unlink(anchored);
            await syncDirectory(directory, directoryHandle);
            return;
          }
          const source = reverse
            ? path.join(child, '.athanor', 'coding-base', change.path)
            : path.join(child, 'workspace', change.path);
          const sourceRoot = reverse
            ? path.join(child, '.athanor', 'coding-base')
            : path.join(child, 'workspace');
          const sourceHandle = await open(
            source,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          );
          const temporary = path.join(directory, `.garden-integration-${randomUUID()}`);
          try {
            await assertOpenedInPlace(sourceRoot, source, sourceHandle);
            const stat = await sourceHandle.stat();
            if (
              !stat.isFile() ||
              stat.size > MAX_BYTES ||
              (replacementExecutable !== undefined &&
                Boolean(stat.mode & 0o111) !== replacementExecutable)
            )
              throw new Error('Integration source is not a bounded regular file');
            const destination = await open(temporary, 'wx', stat.mode & 0o111 ? 0o770 : 0o660);
            try {
              const hash = createHash('sha256');
              let bytes = 0;
              for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += buffer.length;
                if (bytes > MAX_BYTES) throw new Error('Integration file grew beyond its bound');
                hash.update(buffer);
                let written = 0;
                while (written < buffer.length) {
                  const out = await destination.write(buffer, written, buffer.length - written);
                  if (out.bytesWritten <= 0) throw new Error('Integration write was incomplete');
                  written += out.bytesWritten;
                }
              }
              if (hash.digest('hex') !== replacement)
                throw new Error('A specialist file changed after its integration review');
              await destination.sync();
            } finally {
              await destination.close();
            }
            await rename(temporary, anchored);
            await syncDirectory(directory, directoryHandle);
          } finally {
            await sourceHandle.close();
            await rm(temporary, { force: true });
          }
        }
      );
    } catch (error) {
      if (!(reverse && replacement === null && (error as NodeJS.ErrnoException).code === 'ENOENT'))
        throw error;
    }
  }
  private async rollback(mission: Manifest) {
    if (!mission.integration) throw new Error('The integration journal is missing');
    // A persisted intent precedes each file mutation, so the last entry may or may not have landed.
    for (const file of [...mission.integration.applied].reverse()) {
      const change = mission.integration.changes.find((c) => c.path === file);
      if (!change) throw new Error('The integration journal is invalid');
      await this.install(mission, change, true);
    }
    mission.phase = mission.sealed ? 'ready' : 'active';
    delete mission.integration;
    await this.save(mission);
  }
  async integrate(parent: string, id: string, generation: number, reviewDigest: string) {
    await this.recover(parent);
    return this.locked(parent, async () => {
      const mission = await this.load(parent, id);
      if (
        mission.phase === 'integrated' &&
        mission.generation === generation &&
        mission.integration?.digest === reviewDigest
      )
        return {
          integrated: true,
          digest: reviewDigest,
          changedFiles: mission.integration.changes.length,
          generation
        };
      if (!['active', 'ready'].includes(mission.phase) || mission.generation !== generation)
        throw new Error('The coding mission no longer permits integration');
      if ((await this.execution.isWorkspaceBusy(parent)) || this.activeWriters.get(parent)?.size)
        throw new Error('Wait for active work in the parent workspace before integrating');
      this.frozen.add(parent);
      let release = true;
      try {
        mission.phase = 'integrating';
        await this.save(mission);
        for (const reply of this.runningRequests.get(mission.childWorkspaceId) ?? [])
          reply.raw.destroy();
        await this.execution.quiesceWorkspace(mission.childWorkspaceId);
        const review = await this.review(parent, id, generation);
        if (!review.canIntegrate || review.digest !== reviewDigest)
          throw new Error('Review these changed files again before integrating');
        mission.integration = { digest: reviewDigest, changes: review.changes, applied: [] };
        await this.save(mission);
        await jsonWrite(this.journalFile(parent), { id });
        for (const change of review.changes) {
          mission.integration.applied.push(change.path);
          await this.save(mission);
          await this.install(mission, change);
        }
        mission.phase = 'integrated';
        await this.save(mission);
        await removeJournal(this.journalFile(parent));
        this.recovered.add(parent);
        return {
          integrated: true,
          digest: reviewDigest,
          changedFiles: review.changes.length,
          generation
        };
      } catch (error) {
        if (mission.phase !== 'integrated') {
          if (mission.integration) {
            try {
              await this.rollback(mission);
            } catch (recoveryError) {
              release = false;
              this.recovered.delete(parent);
              throw new Error('Integration recovery is incomplete; workspace remains held', {
                cause: recoveryError
              });
            }
          } else {
            mission.phase = mission.sealed ? 'ready' : 'active';
            await this.save(mission);
          }
          await removeJournal(this.journalFile(parent));
        }
        throw error;
      } finally {
        if (release) this.frozen.delete(parent);
      }
    });
  }
  async seal(parent: string, id: string, generation: number) {
    return this.locked(parent, async () => {
      const mission = await this.load(parent, id);
      if (
        mission.generation !== generation ||
        !['active', 'ready', 'integrated'].includes(mission.phase)
      )
        throw new Error('The mission cannot be sealed in this generation');
      if (mission.phase === 'integrated') return { sealed: true };
      mission.phase = 'ready';
      mission.sealed = true;
      await this.save(mission);
      for (const reply of this.runningRequests.get(mission.childWorkspaceId) ?? [])
        reply.raw.destroy();
      await this.execution.quiesceWorkspace(mission.childWorkspaceId);
      return { sealed: true };
    });
  }
  async status(parent: string, id: string) {
    await this.recover(parent);
    const mission = await this.load(parent, id);
    return {
      phase: mission.phase,
      generation: mission.generation,
      digest: mission.integration?.digest ?? null
    };
  }
  async review(
    parent: string,
    id: string,
    generation: number
  ): Promise<{
    digest: string;
    changes: CodingMissionChange[];
    canIntegrate: boolean;
    detail: string;
  }> {
    const mission = await this.load(parent, id);
    if (
      mission.generation !== generation ||
      !['active', 'ready', 'integrating'].includes(mission.phase)
    )
      throw new Error('This coding mission is not reviewable');
    const child = workspacePath(this.root, mission.childWorkspaceId),
      parentRoot = workspacePath(this.root, parent);
    const [result, current] = await Promise.all([
      scan(child, 'workspace'),
      scan(parentRoot, mission.sourceRoot)
    ]);
    const keys = [...new Set([...Object.keys(mission.base), ...Object.keys(result.files)])].sort();
    const changed = keys.filter(
      (key) =>
        mission.base[key]?.hash !== result.files[key]?.hash ||
        mission.base[key]?.mode !== result.files[key]?.mode
    );
    if (changed.length > MAX_CHANGED_FILES)
      throw new Error('Too many changed files for one reviewable integration');
    let remaining = MAX_DIFF_BYTES;
    const changes: CodingMissionChange[] = [];
    for (const file of changed) {
      const before = mission.base[file],
        after = result.files[file],
        parentNow = current.files[file];
      const binary = (buffer: Buffer) =>
        buffer.includes(0) || buffer.toString('utf8').includes('\ufffd');
      const bounded = (before?.bytes ?? 0) + (after?.bytes ?? 0) <= Math.min(remaining, 128_000);
      let diff: string | null = null,
        isBinary = false,
        omitted = !bounded;
      if (bounded) {
        const original = before
          ? await readFact(path.join(child, '.athanor'), `coding-base/${file}`, before, 128_000)
          : Buffer.alloc(0);
        const modified = after
          ? await readFact(child, `workspace/${file}`, after, 128_000)
          : Buffer.alloc(0);
        isBinary = binary(original) || binary(modified);
        if (!isBinary) {
          diff = `${before?.mode !== after?.mode ? `old mode ${before ? (before.mode & 0o111 ? '100755' : '100644') : 'absent'}\nnew mode ${after ? (after.mode & 0o111 ? '100755' : '100644') : 'absent'}\n` : ''}--- a/${file}\n+++ b/${file}\n@@ -1,${original.toString().split('\n').length} +1,${modified.toString().split('\n').length} @@\n${original
            .toString()
            .split('\n')
            .map((line) => '-' + line)
            .join('\n')}\n${modified
            .toString()
            .split('\n')
            .map((line) => '+' + line)
            .join('\n')}`;
          remaining -= Buffer.byteLength(diff);
          if (remaining < 0) {
            diff = null;
            omitted = true;
          }
        }
      }
      changes.push({
        path: file,
        kind: !before ? 'added' : !after ? 'deleted' : 'modified',
        bytes: after?.bytes ?? 0,
        baseHash: before?.hash ?? null,
        resultHash: after?.hash ?? null,
        baseExecutable: before ? Boolean(before.mode & 0o111) : null,
        resultExecutable: after ? Boolean(after.mode & 0o111) : null,
        conflict:
          (before?.hash ?? null) !== (parentNow?.hash ?? null) || before?.mode !== parentNow?.mode,
        permitted: inScope(file, mission.outputPaths),
        diff,
        binary: isBinary,
        diffOmitted: omitted
      });
    }
    const canIntegrate =
      changes.length > 0 && changes.every((change) => change.permitted && !change.conflict);
    const reviewDigest = digest({
      generation,
      base: mission.base,
      changes: changes.map(
        ({
          path,
          baseHash,
          resultHash,
          baseExecutable,
          resultExecutable,
          conflict,
          permitted
        }) => ({
          path,
          baseHash,
          resultHash,
          baseExecutable,
          resultExecutable,
          conflict,
          permitted
        })
      ),
      parent: changed.map((key) => current.files[key] ?? null)
    });
    return {
      digest: reviewDigest,
      changes,
      canIntegrate,
      detail: canIntegrate
        ? 'These scoped changes can be integrated after the working copies are quiescent.'
        : changes.length
          ? 'Resolve conflicts and changes outside the declared output scope before integrating.'
          : 'The specialist made no source changes.'
    };
  }
}

export const registerCodingMissionRoutes = (
  app: FastifyInstance,
  missions: NativeCodingMissions
) => {
  app.addHook('preHandler', (request, reply) => missions.guard(request, reply));
  app.get('/v1/coding-missions/capabilities', async (request) => {
    requireScope(request, 'coding.missions.read');
    return missions.capabilities();
  });
  app.post<{ Params: { workspaceId: string; missionId: string } }>(
    '/v1/workspaces/:workspaceId/coding-missions/:missionId/start',
    async (request) => {
      requireScope(request, 'coding.missions.write');
      return missions.start(
        request.params.workspaceId,
        request.capability.sub,
        request.params.missionId,
        request.body
      );
    }
  );
  app.post<{ Params: { workspaceId: string; missionId: string }; Body: { generation: number } }>(
    '/v1/workspaces/:workspaceId/coding-missions/:missionId/review',
    async (request) => {
      requireScope(request, 'coding.missions.read');
      return missions.review(
        request.params.workspaceId,
        request.params.missionId,
        z.number().int().positive().parse(request.body.generation)
      );
    }
  );
  app.post<{ Params: { workspaceId: string; missionId: string }; Body: { generation: number } }>(
    '/v1/workspaces/:workspaceId/coding-missions/:missionId/cancel',
    async (request) => {
      requireScope(request, 'coding.missions.write');
      return missions.cancel(
        request.params.workspaceId,
        request.params.missionId,
        z.number().int().positive().parse(request.body.generation),
        z
          .uuid()
          .optional()
          .parse((request.body as { childWorkspaceId?: string }).childWorkspaceId)
      );
    }
  );
  app.post<{
    Params: { workspaceId: string; missionId: string };
    Body: { generation: number; digest: string };
  }>('/v1/workspaces/:workspaceId/coding-missions/:missionId/integrate', async (request) => {
    requireScope(request, 'coding.missions.integrate');
    return missions.integrate(
      request.params.workspaceId,
      request.params.missionId,
      z.number().int().positive().parse(request.body.generation),
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(request.body.digest)
    );
  });

  app.get<{ Params: { workspaceId: string; missionId: string } }>(
    '/v1/workspaces/:workspaceId/coding-missions/:missionId/status',
    async (request) => {
      requireScope(request, 'coding.missions.read');
      return missions.status(request.params.workspaceId, request.params.missionId);
    }
  );

  app.post<{ Params: { workspaceId: string; missionId: string }; Body: { generation: number } }>(
    '/v1/workspaces/:workspaceId/coding-missions/:missionId/seal',
    async (request) => {
      requireScope(request, 'coding.missions.write');
      return missions.seal(
        request.params.workspaceId,
        request.params.missionId,
        z.number().int().positive().parse(request.body.generation)
      );
    }
  );
  app.post<{
    Params: { workspaceId: string; missionId: string };
    Body: { generation: number; childWorkspaceId: string };
  }>('/v1/workspaces/:workspaceId/coding-missions/:missionId/remove', async (request) => {
    requireScope(request, 'coding.missions.write');
    return missions.remove(
      request.params.workspaceId,
      request.params.missionId,
      z.number().int().positive().parse(request.body.generation),
      z.uuid().parse(request.body.childWorkspaceId)
    );
  });
};
