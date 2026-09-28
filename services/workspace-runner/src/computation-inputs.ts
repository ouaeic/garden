import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { ComputationInput } from '@garden/contracts';
import { assertOpenedInPlace, assertUserDataPath } from './files.js';

const FILE_BYTES = 16 * 1024 * 1024;
const TOTAL_BYTES = 64 * 1024 * 1024;
const DEADLINE_MS = 10_000;

/** Declared input snapshots are bounded and never imply a lock or a complete dependency graph. */
export async function computationInputs(
  root: string,
  requested: readonly string[]
): Promise<ComputationInput[]> {
  if (requested.length > 32) throw new Error('Too many declared computation inputs');
  const result: ComputationInput[] = [];
  const seen = new Set<string>();
  let remaining = TOTAL_BYTES;
  const deadline = performance.now() + DEADLINE_MS;
  for (const given of requested) {
    let relative = given;
    const unavailable = (
      reason: Extract<ComputationInput, { status: 'unavailable' }>['reason']
    ) => {
      result.push({ path: relative, status: 'unavailable', reason });
    };
    try {
      relative = assertUserDataPath(root, given);
      if (seen.has(relative)) continue;
      seen.add(relative);
      if (remaining <= 0 || performance.now() >= deadline) {
        unavailable('budget_exhausted');
        continue;
      }
      const target = path.resolve(root, relative);
      // Nonblocking open prevents a FIFO from holding the runner before the regular-file check.
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        await assertOpenedInPlace(root, target, handle);
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) {
          unavailable('not_readable');
          continue;
        }
        if (before.size > BigInt(FILE_BYTES)) {
          unavailable('too_large');
          continue;
        }
        if (before.size > BigInt(remaining)) {
          unavailable('budget_exhausted');
          continue;
        }
        const buffer = Buffer.alloc(64 * 1024);
        const hash = createHash('sha256');
        let bytes = 0;
        let refusal: 'changed_during_read' | 'budget_exhausted' | undefined;
        while (true) {
          if (performance.now() >= deadline) {
            refusal = 'budget_exhausted';
            break;
          }
          // One extra byte detects growth without allocating or hashing an unbounded file.
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, Number(before.size) - bytes + 1),
            bytes
          );
          if (!bytesRead) break;
          remaining -= bytesRead;
          bytes += bytesRead;
          if (bytes > Number(before.size)) {
            refusal = 'changed_during_read';
            break;
          }
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (refusal) {
          unavailable(refusal);
          continue;
        }
        const after = await handle.stat({ bigint: true });
        await assertOpenedInPlace(root, target, handle);
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          BigInt(bytes) !== after.size
        ) {
          unavailable('changed_during_read');
          continue;
        }
        result.push({ path: relative, status: 'hashed', bytes, sha256: hash.digest('hex') });
      } finally {
        await handle.close();
      }
    } catch {
      unavailable('not_readable');
    }
  }
  return result;
}
