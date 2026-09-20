import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectStorageUsage } from '@athanor/contracts';
import { assertOpenedInPlace, withWorkspaceDirectory } from './files.js';

/** Metadata only: no project file, hook or executable is read or run. */
export async function scanProjectStorage(
  root: string,
  directory: string,
  limits = { entries: 100_000, milliseconds: 10_000, depth: 64 }
): Promise<ProjectStorageUsage> {
  const started = performance.now();
  const result: ProjectStorageUsage = {
    observedAt: new Date().toISOString(),
    durationMs: 0,
    complete: true,
    scannedEntries: 0,
    fileReferences: 0,
    uniqueFiles: 0,
    logicalBytes: 0,
    allocatedBytes: 0,
    sharedCopies: 0,
    skippedEntries: 0,
    limited: false,
    changedDuringScan: false,
    reclaimableBytes: null
  };
  const inodes = new Set<string>();
  let logical = 0n,
    allocated = 0n;
  const bounded = (depth: number) => {
    if (
      result.scannedEntries >= limits.entries ||
      performance.now() - started >= limits.milliseconds ||
      depth > limits.depth
    ) {
      result.limited = true;
      result.complete = false;
      return true;
    }
    return false;
  };
  const changed = () => {
    result.changedDuringScan = true;
    result.complete = false;
  };
  const walk = async (anchored: string, original: string, depth: number): Promise<void> => {
    if (bounded(depth)) return;
    const before = await lstat(original, { bigint: true });
    const entries = await opendir(anchored);
    for await (const entry of entries) {
      if (bounded(depth)) break;
      result.scannedEntries++;
      const child = path.join(anchored, entry.name),
        source = path.join(original, entry.name);
      try {
        const info = await lstat(child, { bigint: true });
        if (info.isDirectory()) {
          if (process.platform === 'linux') {
            const handle = await open(
              child,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
            );
            try {
              await assertOpenedInPlace(root, source, handle);
              await walk(`/proc/self/fd/${handle.fd}`, source, depth + 1);
              await assertOpenedInPlace(root, source, handle);
            } finally {
              await handle.close();
            }
          } else {
            await withWorkspaceDirectory(root, source, false, (held) =>
              walk(held, source, depth + 1)
            );
          }
        } else if (info.isFile()) {
          result.fileReferences++;
          logical += info.size;
          const identity = `${info.dev}:${info.ino}`;
          if (!inodes.has(identity)) {
            inodes.add(identity);
            result.uniqueFiles++;
            allocated += info.blocks * 512n;
          } else result.sharedCopies++;
        } else {
          result.skippedEntries++;
          result.complete = false;
        }
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? ''))
          changed();
        else result.complete = false;
        result.skippedEntries++;
      }
    }
    const after = await lstat(original, { bigint: true });
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      changed();
  };
  await withWorkspaceDirectory(root, directory, false, async (anchored, held) => {
    await walk(anchored, directory, 0);
    if (held) await assertOpenedInPlace(root, directory, held);
  });
  const safeBytes = (value: bigint) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      result.limited = true;
      result.complete = false;
      return Number.MAX_SAFE_INTEGER;
    }
    return Number(value);
  };
  result.logicalBytes = safeBytes(logical);
  result.allocatedBytes = safeBytes(allocated);
  result.durationMs = performance.now() - started;
  return result;
}
