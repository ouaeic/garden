import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertOpenedInPlace, withWorkspaceDirectory, WorkspaceFileError } from './files.js';

// flock belongs to the open file description. The runner keeps that description after this
// short-lived helper exits, so a long download holds one descriptor, not another interpreter.
const LOCK = `import fcntl, os, stat, sys
info = os.fstat(3)
if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
    sys.exit(76)
mode = {"read": fcntl.LOCK_SH, "write": fcntl.LOCK_EX}[sys.argv[1]]
try:
    fcntl.flock(3, mode | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(75)
`;

export interface ProjectReferenceLock {
  release(): Promise<void>;
}

/** Overlapping readers share an open description without shortening any reader's lifetime. */
export class ProjectReferences {
  readonly #readers = new Map<string, { users: number; lock: Promise<ProjectReferenceLock> }>();
  constructor(readonly root: string) {}

  async acquire(projectId: string): Promise<ProjectReferenceLock> {
    let entry = this.#readers.get(projectId);
    if (!entry) {
      entry = { users: 0, lock: acquireProjectReference(this.root, projectId, 'read') };
      this.#readers.set(projectId, entry);
    }
    entry.users++;
    const current = entry;
    let released: Promise<void> | undefined;
    const release = () =>
      (released ??= (async () => {
        if (--current.users === 0) {
          if (this.#readers.get(projectId) === current) this.#readers.delete(projectId);
          await (await current.lock).release();
        }
      })());
    try {
      await current.lock;
      return { release };
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
  }

  async run<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const lock = await this.acquire(projectId);
    try {
      return await work();
    } finally {
      await lock.release();
    }
  }
}

/** Cooperates with native execution against the same protected public-directory inode. */
export async function acquireProjectReference(
  root: string,
  projectId: string,
  mode: 'read' | 'write'
): Promise<ProjectReferenceLock> {
  const directory = path.join(root, '.project-store', z.uuid().parse(projectId), 'public');
  return acquireDirectoryReference(root, directory, mode);
}

/** Protected private directories also coordinate metadata-only recovery between runner instances. */
export async function acquireDirectoryReference(
  root: string,
  directory: string,
  mode: 'read' | 'write',
  busyMessage?: string
): Promise<ProjectReferenceLock> {
  const held = await withWorkspaceDirectory(root, directory, false, async (anchored) => {
    const descriptor = await open(
      `${anchored}/.`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      await assertOpenedInPlace(root, directory, descriptor);
      return descriptor;
    } catch (error) {
      await descriptor.close();
      throw error;
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', LOCK, mode], {
        stdio: ['ignore', 'ignore', 'ignore', held.fd],
        env: {}
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('error', (cause) => {
        clearTimeout(timeout);
        reject(new Error('Project history locking is unavailable.', { cause }));
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else if (code === 75)
          reject(
            new WorkspaceFileError(
              busyMessage ??
                (mode === 'write'
                  ? 'Project history is in use by running work or an open download. Try again after it finishes.'
                  : 'Project history maintenance is in progress. Try again shortly.'),
              409
            )
          );
        else reject(new Error('Project history locking could not be verified.'));
      });
    });
    await assertOpenedInPlace(root, directory, held);
    let released: Promise<void> | undefined;
    return { release: () => (released ??= held.close()) };
  } catch (error) {
    await held.close();
    throw error;
  }
}

export async function withProjectReference<T>(
  root: string,
  projectId: string,
  mode: 'read' | 'write',
  work: () => Promise<T>
): Promise<T> {
  const lease = await acquireProjectReference(root, projectId, mode);
  try {
    return await work();
  } finally {
    await lease.release();
  }
}
