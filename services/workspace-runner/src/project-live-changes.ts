import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationChanges, ProjectFileVersion } from '@athanor/contracts';
import { openDownloadFile } from './file-downloads.js';
import { withWorkspaceDirectory } from './files.js';
import { ProjectVersionFiles, projectPath, type VersionTree } from './project-version-files.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
type Counts = { added: number; removed: number; changed: number; unmeasured: number };
type CachedFile = { signature: string; counts: Counts };
type Entry = {
  root: string;
  state: string;
  taskId: string;
  value: ConversationChanges;
  files: Map<string, CachedFile>;
  touched: number;
  completed: number;
  work?: Promise<void>;
};
const empty = (): Counts => ({ added: 0, removed: 0, changed: 0, unmeasured: 0 });
const signature = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(':');
const text = (bytes: Buffer) => !bytes.includes(0) && !bytes.toString('utf8').includes('\ufffd');
const lines = (bytes: Buffer) => {
  let count = bytes.length && bytes.at(-1) !== 10 ? 1 : 0;
  for (const byte of bytes) if (byte === 10) count++;
  return count;
};

async function boundedRead(file: FileHandle): Promise<Buffer | null> {
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
    if (!bytesRead) return buffer.subarray(0, total);
    total += bytesRead;
  }
  return null;
}

async function diffLines(before: FileHandle, after: FileHandle, signal: AbortSignal) {
  return new Promise<{ added: number; removed: number } | null>((resolve) => {
    const descriptors = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
    const child = spawn(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '--',
        `${descriptors}/3`,
        `${descriptors}/4`
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore', before.fd, after.fd],
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        signal,
        timeout: 2000,
        killSignal: 'SIGKILL'
      }
    );
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 8192) child.kill('SIGKILL');
    });
    child.once('error', () => resolve(null));
    child.once('close', (code) => {
      const match = /^(\d+)\t(\d+)\t/.exec(output);
      resolve(
        (code === 0 || code === 1) && match && output.length <= 8192
          ? { added: Number(match[1]), removed: Number(match[2]) }
          : code === 0 && !output
            ? { added: 0, removed: 0 }
            : null
      );
    });
  });
}

/** Read-only telemetry never creates version objects or scans dependency environments. */
export class ProjectLiveChanges {
  readonly #entries = new Map<string, Entry>();
  readonly #abort = new AbortController();
  #active = 0;
  constructor(
    readonly freshForMs = 30_000,
    readonly clock: () => number = Date.now
  ) {}

  request(root: string, state: string, taskId: string): ConversationChanges {
    const key = `${state}:${taskId}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= 64) {
        const oldest = [...this.#entries.entries()]
          .filter(([, value]) => !value.work && value.value.status !== 'queued')
          .sort((a, b) => a[1].touched - b[1].touched)[0];
        if (oldest) this.#entries.delete(oldest[0]);
        else return { taskId, status: 'queued', measurement: null };
      }
      entry = {
        root,
        state,
        taskId,
        value: { taskId, status: 'queued', measurement: null },
        files: new Map(),
        touched: this.clock(),
        completed: 0
      };
      this.#entries.set(key, entry);
    }
    entry.touched = this.clock();
    if (!entry.work && this.clock() - entry.completed >= this.freshForMs)
      entry.value = { ...entry.value, status: 'queued' };
    this.#pump();
    return structuredClone(entry.value);
  }

  #pump() {
    if (this.#abort.signal.aborted) return;
    for (const entry of this.#entries.values()) {
      if (this.#active >= 2) break;
      if (entry.work || entry.value.status !== 'queued') continue;
      this.#active++;
      entry.value = { ...entry.value, status: 'measuring' };
      entry.work = this.#scan(entry)
        .then((measurement) => {
          entry.value = { taskId: entry.taskId, status: 'ready', measurement };
        })
        .catch(() => {
          entry.value = { ...entry.value, status: 'unavailable' };
        })
        .finally(() => {
          entry.completed = this.clock();
          delete entry.work;
          this.#active--;
          this.#pump();
        });
    }
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await Promise.allSettled(
      [...this.#entries.values()].flatMap((entry) => (entry.work ? [entry.work] : []))
    );
    this.#entries.clear();
  }

  async #scan(entry: Entry): Promise<NonNullable<ConversationChanges['measurement']>> {
    const workspaceId = path.basename(entry.root);
    const baseline = JSON.parse(
      await readFile(path.join(entry.state, 'baselines', `${workspaceId}.json`), 'utf8')
    ) as { revision: string | null; files: VersionTree };
    const versions = new ProjectVersionFiles(path.join(entry.state, 'content'));
    const totals = empty(),
      seen = new Set<string>(),
      nextCache = new Map<string, CachedFile>();
    let bytesRead = 0,
      visited = 0,
      scannedFiles = 0,
      truncated = false;
    const add = (counts: Counts) => {
      for (const key of ['added', 'removed', 'changed', 'unmeasured'] as const)
        totals[key] += counts[key];
    };
    const unmeasured = (changed = 0): Counts => ({ ...empty(), unmeasured: 1, changed });
    const permitted = (relative: string) => {
      try {
        return projectPath(`workspace/${relative}`) === relative;
      } catch {
        return false;
      }
    };
    const measure = async (
      relative: string,
      before: ProjectFileVersion | undefined
    ): Promise<Counts> => {
      const source = await openDownloadFile(entry.root, `workspace/${relative}`);
      let base: FileHandle | undefined;
      try {
        const stat = await source.handle.stat({ bigint: true });
        const stamp = `${signature(stat)}:${before?.sha256 ?? ''}:${before?.executable ?? ''}`;
        const cached = entry.files.get(relative);
        if (cached?.signature === stamp) {
          if (nextCache.size < 4096) nextCache.set(relative, cached);
          return cached.counts;
        }
        if (
          stat.size > MAX_FILE_BYTES ||
          (before?.bytes ?? 0) > MAX_FILE_BYTES ||
          bytesRead >= MAX_READ_BYTES
        )
          return unmeasured(before ? 0 : 1);
        const bytes = await boundedRead(source.handle);
        bytesRead += bytes?.length ?? MAX_FILE_BYTES;
        if (!bytes) return unmeasured();
        const identical = before?.sha256 === createHash('sha256').update(bytes).digest('hex');
        let counts: Counts;
        if (identical)
          counts = {
            ...empty(),
            changed: before.executable === Boolean(stat.mode & 0o111n) ? 0 : 1
          };
        else if (!text(bytes)) counts = unmeasured(1);
        else if (!before) counts = { ...empty(), added: lines(bytes), changed: 1 };
        else {
          base = await open(versions.object(before), constants.O_RDONLY | constants.O_NOFOLLOW);
          const difference = await diffLines(base, source.handle, this.#abort.signal);
          counts = difference ? { ...difference, changed: 1, unmeasured: 0 } : unmeasured(1);
        }
        // The descriptor stays anchored across comparison. A file still being written is sampled later.
        if (signature(stat) !== signature(await source.handle.stat({ bigint: true })))
          return unmeasured();
        if (nextCache.size < 4096) nextCache.set(relative, { signature: stamp, counts });
        return counts;
      } finally {
        await source.handle.close();
        await base?.close();
      }
    };
    const visit = async (relative: string, depth: number): Promise<void> => {
      this.#abort.signal.throwIfAborted();
      if (depth > 64 || visited >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      await withWorkspaceDirectory(
        entry.root,
        path.posix.join('workspace', relative),
        false,
        async (anchored) => {
          for await (const item of await opendir(anchored)) {
            this.#abort.signal.throwIfAborted();
            if (++visited > MAX_ENTRIES) {
              truncated = true;
              break;
            }
            const name = path.posix.join(relative, item.name);
            if (!permitted(name)) continue;
            if (item.isDirectory()) await visit(name, depth + 1);
            else {
              seen.add(name);
              scannedFiles++;
              if (item.isFile())
                add(await measure(name, baseline.files[name]).catch(() => unmeasured()));
              else add(unmeasured());
            }
            if (visited % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      );
    };
    await visit('', 0);
    if (!truncated)
      for (const [relative, fact] of Object.entries(baseline.files)) {
        this.#abort.signal.throwIfAborted();
        if (seen.has(relative) || !permitted(relative)) continue;
        if (++visited > MAX_ENTRIES) {
          truncated = true;
          break;
        }
        // A directory created during traversal must not turn unseen children into deletions.
        const exists = await lstat(path.join(entry.root, 'workspace', relative)).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          }
        );
        if (exists) {
          add(unmeasured());
          continue;
        }
        scannedFiles++;
        if (fact.bytes > MAX_FILE_BYTES || bytesRead >= MAX_READ_BYTES) {
          add(unmeasured(1));
          continue;
        }
        const bytes = await versions.read(fact, MAX_FILE_BYTES);
        bytesRead += fact.bytes;
        add(
          bytes && text(bytes) ? { ...empty(), removed: lines(bytes), changed: 1 } : unmeasured(1)
        );
      }
    entry.files = nextCache;
    return {
      observedAt: new Date().toISOString(),
      baselineRevision: baseline.revision,
      added: totals.added,
      removed: totals.removed,
      changedFiles: totals.changed,
      unmeasuredFiles: totals.unmeasured,
      scannedFiles,
      truncated
    };
  }
}
