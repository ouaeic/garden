import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DirectoryPage } from '@garden/contracts';
import { assertUserDataPath, withWorkspaceDirectory, WorkspaceFileError } from './files.js';

const Cursor = z.object({
  path: z.string(),
  offset: z.number().int().nonnegative().safe(),
  identity: z.string()
});

export const listDirectory = async (
  root: string,
  requested = 'workspace',
  cursor?: string,
  limit = 100
): Promise<DirectoryPage> => {
  const relative = assertUserDataPath(root, requested);
  const pageSize = z.number().int().min(1).max(200).parse(limit);
  const after = cursor
    ? Cursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()))
    : null;
  return withWorkspaceDirectory(root, relative, false, async (anchored, held) => {
    const stat = held ? await held.stat() : await lstat(anchored);
    const identity = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (after && (after.path !== relative || after.identity !== identity))
      throw new WorkspaceFileError('This directory changed. Refresh its file list.', 409);
    const entries: DirectoryPage['entries'] = [];
    let offset = 0,
      more = false;
    for await (const entry of await opendir(anchored, { bufferSize: 32 })) {
      if (offset++ < (after?.offset ?? 0)) continue;
      if (entries.length === pageSize) {
        more = true;
        break;
      }
      const details = await lstat(path.join(anchored, entry.name));
      entries.push({
        name: entry.name,
        path: path.join(relative, entry.name),
        type: details.isDirectory()
          ? 'directory'
          : details.isFile()
            ? 'file'
            : details.isSymbolicLink()
              ? 'symlink'
              : 'special',
        sizeBytes: details.size,
        modifiedAt: details.mtime.toISOString()
      });
    }
    const current = held ? await held.stat() : await lstat(anchored);
    if (stat.mtimeMs !== current.mtimeMs || stat.ctimeMs !== current.ctimeMs)
      throw new WorkspaceFileError('This directory changed. Refresh its file list.', 409);
    return {
      path: relative,
      entries,
      nextCursor: more
        ? Buffer.from(JSON.stringify({ path: relative, offset: offset - 1, identity })).toString(
            'base64url'
          )
        : null
    };
  });
};
