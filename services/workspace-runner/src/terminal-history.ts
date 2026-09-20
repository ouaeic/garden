import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, opendir, lstat, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const Key = z.string().regex(/^\d{16}-[a-f0-9]{64}-[a-f0-9]{64}\.json$/);
export const HistoryQuery = z.object({
  cursor: Key.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});
const MAX_BYTES = 2 * 1024 * 1024;

/** Immutable terminal receipts. Paging scans filenames, holding only one bounded page in memory.
 * No mutable index is required for recovery or a filesystem backup. Temporary files are never read.
 * A namespace has one writer: the job supervisor or the computation manager, never both.
 */
export class TerminalHistory<T> {
  #writes: Promise<void> = Promise.resolve();
  #lastStamp: number | undefined;
  constructor(
    private readonly directory: string,
    private readonly schema: z.ZodType<T>,
    private readonly maximumBytes = MAX_BYTES
  ) {}

  async *#names(shard?: string): AsyncGenerator<string> {
    const directory = shard ? path.join(this.directory, shard) : this.directory;
    let entries;
    try {
      if (!(await lstat(this.directory)).isDirectory() || !(await lstat(directory)).isDirectory())
        throw Error('History directory cannot be a symlink');
      entries = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for await (const entry of entries) {
      if (shard) {
        if (entry.name.endsWith('.tmp')) continue;
        if (
          !Key.safeParse(entry.name).success ||
          entry.name.slice(82, 84) !== shard ||
          !entry.isFile()
        )
          throw Error('Saved history contains an invalid entry');
        yield entry.name;
      } else {
        if (!/^[a-f0-9]{2}$/.test(entry.name) || !entry.isDirectory())
          throw Error('Saved history contains an invalid directory');
        yield* this.#names(entry.name);
      }
    }
  }

  #file(key: string): string {
    return path.join(this.directory, key.slice(82, 84), key);
  }

  async #read(key: string): Promise<{ id: string; owner: string; value: T }> {
    Key.parse(key);
    const file = await open(
      this.#file(key),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > this.maximumBytes)
        throw Error('Saved history record exceeds its limit');
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw Error('Saved history changed while reading');
      const envelope = z
        .object({
          version: z.literal(1),
          id: z.string().min(1).max(256),
          owner: z.string().min(1).max(256),
          value: this.schema
        })
        .strict()
        .parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
      if (!key.endsWith(`-${digest(envelope.owner)}-${digest(envelope.id)}.json`))
        throw Error('Saved history identity does not match its filename');
      return envelope;
    } finally {
      await file.close();
    }
  }

  async #find(
    id: string
  ): Promise<{ key: string; id: string; owner: string; value: T } | undefined> {
    const suffix = `-${digest(id)}.json`;
    let found: string | undefined;
    for await (const key of this.#names(digest(id).slice(0, 2))) {
      if (!key.endsWith(suffix)) continue;
      if (found) throw Error('Saved history contains duplicate identities');
      found = key;
    }
    return found ? { key: found, ...(await this.#read(found)) } : undefined;
  }

  async get(id: string, owner: string | null): Promise<T | undefined> {
    await this.#writes;
    const found = await this.#find(id);
    return found && (owner === null || found.owner === owner) ? found.value : undefined;
  }

  async #syncParents(directoryPath: string): Promise<void> {
    if (process.platform !== 'linux') return;
    for (const directory of [
      directoryPath,
      this.directory,
      path.dirname(this.directory),
      path.dirname(path.dirname(this.directory))
    ]) {
      const handle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  put(id: string, owner: string, value: T): Promise<void> {
    // Capture before joining the write queue: live state must not change an archived receipt.
    const parsed = this.schema.parse(structuredClone(value));
    const contents = JSON.stringify({ version: 1, id, owner, value: parsed });
    if (Buffer.byteLength(contents) > this.maximumBytes)
      return Promise.reject(Error('Saved history record exceeds its limit'));
    const write = this.#writes.then(async () => {
      const existing = await this.#find(id);
      if (existing) {
        if (existing.owner !== owner || JSON.stringify(existing.value) !== JSON.stringify(parsed))
          throw Error('Saved history identity was reused for different data');
        await this.#syncParents(path.dirname(this.#file(existing.key)));
        return;
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(this.directory)).isDirectory())
        throw Error('History directory cannot be a symlink');
      if (this.#lastStamp === undefined) {
        this.#lastStamp = 0;
        for await (const key of this.#names())
          this.#lastStamp = Math.max(this.#lastStamp, Number(key.slice(0, 16)));
      }
      const stamp = Math.max(Date.now(), this.#lastStamp + 1);
      const key = `${String(stamp).padStart(16, '0')}-${digest(owner)}-${digest(id)}.json`;
      const directoryPath = path.dirname(this.#file(key));
      await mkdir(directoryPath, { recursive: true, mode: 0o700 });
      if (!(await lstat(directoryPath)).isDirectory())
        throw Error('History directory cannot be a symlink');
      const temporary = path.join(directoryPath, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, contents, { mode: 0o600, flag: 'wx', flush: true });
        await rename(temporary, this.#file(key));
        this.#lastStamp = stamp;
        await this.#syncParents(directoryPath);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    });
    this.#writes = write.catch(() => undefined);
    return write;
  }

  async page(
    owners: string[] | null,
    input?: unknown
  ): Promise<{ entries: { cursor: string; value: T }[]; nextCursor: string | null }>;
  async page<U>(
    owners: string[] | null,
    input: unknown,
    project: (value: T) => U
  ): Promise<{ entries: { cursor: string; value: U }[]; nextCursor: string | null }>;
  async page(
    owners: string[] | null,
    input: unknown = {},
    project: (value: T) => unknown = (value) => value
  ): Promise<{ entries: { cursor: string; value: unknown }[]; nextCursor: string | null }> {
    const { cursor, limit } = HistoryQuery.parse(input);
    await this.#writes;
    const hashes = owners === null ? null : new Set(owners.map(digest));
    const keys: string[] = [];
    for await (const key of this.#names()) {
      if ((cursor && key >= cursor) || (hashes && !hashes.has(key.slice(17, 81)))) continue;
      const at = keys.findIndex((other) => other < key);
      keys.splice(at === -1 ? keys.length : at, 0, key);
      if (keys.length > limit + 1) keys.pop();
    }
    const selected = keys.slice(0, limit);
    const entries = [];
    for (const key of selected)
      entries.push({ cursor: key, value: project((await this.#read(key)).value) });
    return { entries, nextCursor: keys.length > limit ? selected.at(-1)! : null };
  }
}
