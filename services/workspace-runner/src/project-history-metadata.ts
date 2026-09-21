import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { withWorkspaceDirectory } from './files.js';
import { treeDigest } from './project-version-files.js';

export const HistoryDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const HistoryTree = z.record(
  z.string(),
  z
    .object({
      sha256: HistoryDigest,
      bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      executable: z.boolean()
    })
    .strict()
);
export const HistoryRevision = z.object({
  id: z.uuid(),
  number: z.number().int().positive(),
  title: z.string(),
  digest: HistoryDigest,
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  files: HistoryTree
});

/** Protected metadata is shared by archive and permanent reclamation; file bodies stay separate. */
export class ProjectHistoryMetadata {
  readonly directory: string;
  constructor(
    readonly root: string,
    readonly projectId: string
  ) {
    this.directory = path.join(root, '.project-store', z.uuid().parse(projectId));
  }
  state(relative: string): string {
    return path.join(this.directory, 'state', relative);
  }
  async read<T>(filename: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      return await withWorkspaceDirectory(
        this.root,
        path.dirname(filename),
        false,
        async (directory) => {
          const handle = await open(
            path.join(directory, path.basename(filename)),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          );
          try {
            const info = await handle.stat();
            if (
              !info.isFile() ||
              info.uid !== process.getuid!() ||
              info.mode & 0o022 ||
              info.size > 64 * 1024 * 1024
            )
              throw new Error('Project retention metadata cannot be verified.');
            const data = await handle.readFile('utf8');
            if (Buffer.byteLength(data) > 64 * 1024 * 1024)
              throw new Error('Project retention metadata exceeds the inspection limit.');
            return schema.parse(JSON.parse(data));
          } finally {
            await handle.close();
          }
        }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async names(relative: string): Promise<string[]> {
    try {
      return await withWorkspaceDirectory(
        this.root,
        this.state(relative),
        false,
        async (directory) => {
          const names: string[] = [];
          for await (const entry of await opendir(directory)) {
            if (entry.name.endsWith('.tmp')) continue;
            if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/i.test(entry.name))
              throw new Error('Project references contain unknown metadata.');
            z.uuid().parse(entry.name.slice(0, -5));
            names.push(entry.name);
            if (names.length > 10_000)
              throw new Error('Project references exceed the maintenance inspection limit.');
          }
          return names.sort();
        }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async revision(id: string) {
    const revision = await this.read(
      this.state(`revisions/${z.uuid().parse(id)}.json`),
      HistoryRevision
    );
    if (
      !revision ||
      revision.id !== id ||
      treeDigest(revision.files) !== revision.digest ||
      Object.keys(revision.files).length !== revision.fileCount ||
      Object.values(revision.files).reduce((sum, file) => sum + file.bytes, 0) !== revision.bytes
    )
      throw new Error('Published version metadata cannot be verified.');
    return revision;
  }
}
