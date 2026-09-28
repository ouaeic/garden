import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  statfs
} from 'node:fs/promises';
import path from 'node:path';
import { workspaceUsage } from './files.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_CONTENT = ['workspace', '.garden/browser', '.garden/artifacts'] as const;
const MAX_ERROR_BYTES = 16 * 1024;
const MINIMUM_CONFIGURED_RESERVE_BYTES = 64 * 1024 ** 2;
const MAXIMUM_CONFIGURED_RESERVE_BYTES = 1024 ** 4;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';

const safeId = (value: string, label: string): string => {
  if (!UUID.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
};

const snapshotPath = (workspaceRoot: string, workspaceId: string, snapshotId: string): string => {
  const workspace = safeId(workspaceId, 'workspace ID');
  const snapshot = safeId(snapshotId, 'snapshot ID');
  return path.join(
    path.resolve(workspaceRoot),
    '.garden-snapshots',
    workspace,
    `${snapshot}.tar.gz`
  );
};

const run = async (executable: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let error = Buffer.alloc(0);
    child.stderr.on('data', (chunk: Buffer) => {
      error = Buffer.concat([error, chunk]);
      if (error.length > MAX_ERROR_BYTES) error = error.subarray(error.length - MAX_ERROR_BYTES);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${path.basename(executable)} failed${signal ? ` with ${signal}` : ` with exit ${String(code)}`}: ${error.toString('utf8').trim()}`
          )
        );
    });
  });

const validateArchive = async (snapshotExecutable: string, archive: string): Promise<void> =>
  run(snapshotExecutable, ['validate', archive]);

const localSnapshotBytes = async (root: string): Promise<number> =>
  (
    await Promise.all(
      SNAPSHOT_CONTENT.map((relative) =>
        workspaceUsage(path.join(root, relative)).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
          throw error;
        })
      )
    )
  ).reduce((total, bytes) => total + bytes, 0);

export const snapshotReserveBytes = (
  totalBytes: number,
  configured = process.env.GARDEN_SNAPSHOT_RESERVE_BYTES
): number => {
  if (configured === undefined || configured === '') {
    return Math.min(20 * 1024 ** 3, Math.max(2 * 1024 ** 3, totalBytes * 0.02));
  }
  if (!/^[0-9]+$/.test(configured)) {
    throw new Error('GARDEN_SNAPSHOT_RESERVE_BYTES must be a whole number of bytes');
  }
  const bytes = Number(configured);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < MINIMUM_CONFIGURED_RESERVE_BYTES ||
    bytes > MAXIMUM_CONFIGURED_RESERVE_BYTES
  ) {
    throw new Error(
      `GARDEN_SNAPSHOT_RESERVE_BYTES must be between ${MINIMUM_CONFIGURED_RESERVE_BYTES} and ${MAXIMUM_CONFIGURED_RESERVE_BYTES}`
    );
  }
  return bytes;
};

const assertSnapshotHeadroom = async (root: string): Promise<void> => {
  const [filesystem, sourceBytes] = await Promise.all([statfs(root), localSnapshotBytes(root)]);
  const totalBytes = filesystem.blocks * filesystem.bsize;
  const availableBytes = filesystem.bavail * filesystem.bsize;
  const reserveBytes = snapshotReserveBytes(totalBytes);
  if (availableBytes - sourceBytes < reserveBytes) {
    throw new Error(
      'Host disk does not have enough headroom for a full recovery point; free space or use an off-host backup'
    );
  }
};

const assertRealSnapshotRoots = async (root: string): Promise<void> => {
  for (const relative of SNAPSHOT_CONTENT) {
    const details = await lstat(path.join(root, relative));
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`Recovery-point source ${relative} must be a real directory`);
    }
  }
};

const assertSafeExtractedTree = async (extracted: string): Promise<void> => {
  const base = path.resolve(extracted);
  const pending = [...SNAPSHOT_CONTENT.map((relative) => path.join(base, relative))];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      const linked = await readlink(current);
      const resolved = path.resolve(path.dirname(current), linked);
      const relative = path.relative(base, resolved);
      if (path.isAbsolute(linked) || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Snapshot contains a symbolic link outside the recovered computer state');
      }
      continue;
    }
    if (details.isDirectory()) {
      const children = await readdir(current);
      entries += children.length;
      if (entries > 2_000_000) throw new Error('Snapshot contains too many filesystem entries');
      pending.push(...children.map((name) => path.join(current, name)));
      continue;
    }
    if (!details.isFile()) {
      throw new Error('Snapshot contains an unsupported special filesystem entry');
    }
  }
};

export const createSnapshot = async (input: {
  snapshotExecutable: string;
  workspaceRoot: string;
  root: string;
  workspaceId: string;
  snapshotId: string;
}): Promise<{ sizeBytes: number }> => {
  await assertRealSnapshotRoots(input.root);
  await assertSnapshotHeadroom(input.root);
  const target = snapshotPath(input.workspaceRoot, input.workspaceId, input.snapshotId);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.creating`;
  await rm(temporary, { force: true });
  try {
    await run(input.snapshotExecutable, ['create', temporary, input.root]);
    await validateArchive(input.snapshotExecutable, temporary);
    await chmod(temporary, 0o600);
    const handle = await open(temporary, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    return { sizeBytes: (await stat(target)).size };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

export const deleteSnapshot = async (input: {
  workspaceRoot: string;
  workspaceId: string;
  snapshotId: string;
}): Promise<void> => {
  const target = snapshotPath(input.workspaceRoot, input.workspaceId, input.snapshotId);
  const details = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!details) return;
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error('Snapshot path is not a regular archive');
  await rm(target);
};

export const deleteAllSnapshots = async (
  workspaceRoot: string,
  workspaceId: string
): Promise<void> => {
  const workspace = safeId(workspaceId, 'workspace ID');
  await rm(path.join(path.resolve(workspaceRoot), '.garden-snapshots', workspace), {
    recursive: true,
    force: true
  });
};

export const restoreSnapshot = async (input: {
  snapshotExecutable: string;
  workspaceRoot: string;
  root: string;
  workspaceId: string;
  snapshotId: string;
}): Promise<void> => {
  const archive = snapshotPath(input.workspaceRoot, input.workspaceId, input.snapshotId);
  const details = await lstat(archive);
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error('Snapshot path is not a regular archive');
  await validateArchive(input.snapshotExecutable, archive);

  const staging = path.join(
    path.resolve(input.workspaceRoot),
    `.garden-restore-${safeId(input.workspaceId, 'workspace ID')}-${safeId(input.snapshotId, 'snapshot ID')}`
  );
  const extracted = path.join(staging, 'extracted');
  const previous = path.join(staging, 'previous');
  await rm(staging, { recursive: true, force: true });
  await mkdir(previous, { recursive: true, mode: 0o700 });
  let preserveStaging = false;
  try {
    await run(input.snapshotExecutable, ['extract', archive, extracted]);
    for (const relative of SNAPSHOT_CONTENT) {
      const restored = path.join(extracted, relative);
      const restoredDetails = await lstat(restored);
      if (!restoredDetails.isDirectory() || restoredDetails.isSymbolicLink())
        throw new Error(`Snapshot is missing ${relative}`);
    }
    await assertSafeExtractedTree(extracted);

    const moved: string[] = [];
    const activated: string[] = [];
    try {
      for (const relative of SNAPSHOT_CONTENT) {
        const current = path.join(input.root, relative);
        const backup = path.join(previous, relative);
        await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
        await rename(current, backup);
        moved.push(relative);
        await mkdir(path.dirname(current), { recursive: true, mode: 0o700 });
        await rename(path.join(extracted, relative), current);
        activated.push(relative);
      }
    } catch (error) {
      let rollbackError: unknown;
      for (const relative of [...activated].reverse()) {
        try {
          await rm(path.join(input.root, relative), { recursive: true, force: true });
        } catch (cause) {
          rollbackError ??= cause;
        }
      }
      for (const relative of [...moved].reverse()) {
        try {
          await mkdir(path.dirname(path.join(input.root, relative)), {
            recursive: true,
            mode: 0o700
          });
          await rename(path.join(previous, relative), path.join(input.root, relative));
        } catch (cause) {
          rollbackError ??= cause;
        }
      }
      if (rollbackError) {
        preserveStaging = true;
        throw new Error(
          `Recovery-point activation failed and automatic rollback was incomplete. Preserved recovery data at ${staging}. Original error: ${errorMessage(error)}. Rollback error: ${errorMessage(rollbackError)}`
        );
      }
      throw error;
    }
  } finally {
    if (!preserveStaging) await rm(staging, { recursive: true, force: true });
  }
};
