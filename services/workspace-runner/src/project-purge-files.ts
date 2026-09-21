import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { PURGE_FILESYSTEM } from './project-purge-native.js';
import type { ProjectReferenceLock } from './project-reference-lock.js';

const Identity = z.object({ path: z.string(), device: z.string(), inode: z.string() }).strict();
export const PurgeManifest = z
  .object({
    entries: z
      .array(
        Identity.extend({
          kind: z.enum(['directory', 'file', 'link']),
          mode: z.number().int(),
          size: z.number().int().nonnegative(),
          modified: z.string(),
          blocks: z.number().int().nonnegative(),
          links: z.number().int().positive()
        })
      )
      .max(100_000),
    anchors: z.array(Identity).max(100_000)
  })
  .strict();
export type PurgeManifest = z.infer<typeof PurgeManifest>;

export async function purgeFilesystem<T>(
  root: string,
  request: Record<string, unknown>,
  schema: z.ZodType<T>,
  lock?: ProjectReferenceLock
): Promise<T> {
  const descriptor = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    return await new Promise<T>((resolve, reject) => {
      const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', PURGE_FILESYSTEM], {
        env: {},
        stdio: ['pipe', 'pipe', 'pipe', descriptor.fd, ...(lock ? [lock.descriptor] : [])]
      });
      const chunks: Buffer[] = [];
      let bytes = 0,
        error = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) child.kill('SIGKILL');
        else chunks.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        error = (error + chunk.toString('utf8')).slice(-4096);
      });
      child.stdin!.on('error', () => undefined);
      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) {
          const reason = error
            .split('\n')
            .reverse()
            .find((line) => line.startsWith('ValueError: '));
          reject(
            new Error(
              reason?.slice('ValueError: '.length) ??
                'History cleanup could not complete. The saved selection can be resumed.'
            )
          );
          return;
        }
        try {
          resolve(schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        } catch (cause) {
          reject(new Error('History cleanup returned an invalid receipt.', { cause }));
        }
      });
      child.stdin!.end(JSON.stringify(request));
    });
  } finally {
    await descriptor.close();
  }
}

/** Hard-linked paths share allocated blocks; an unselected link prevents a release estimate. */
export function purgeCapacity(manifest: PurgeManifest) {
  const inodes = new Map<string, { selected: number; links: number; blocks: number }>();
  let logicalBytes = 0;
  for (const item of manifest.entries) {
    if (item.kind === 'file') logicalBytes += item.size;
    if (item.kind === 'directory') continue;
    const key = `${item.device}:${item.inode}`,
      value = inodes.get(key) ?? { selected: 0, links: item.links, blocks: item.blocks };
    value.selected++;
    value.links = Math.max(value.links, item.links);
    value.blocks = Math.min(value.blocks, item.blocks);
    inodes.set(key, value);
  }
  return {
    logicalBytes,
    estimatedFreedBytes: [...inodes.values()].reduce(
      (sum, item) => sum + (item.selected === item.links ? item.blocks * 512 : 0),
      0
    )
  };
}
