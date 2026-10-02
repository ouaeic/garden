import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { belowHostStorageFloor, hostStorage, type HostStorage } from './host-storage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OUTPUT_BYTES = 8 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
/** How many pruned checkpoints may pile up before their content is collected. */
const GC_DEBT_THRESHOLD = 8;

/**
 * What a turn checkpoint covers: the agent's project tree and anything it published.
 *
 * `.garden/browser` and `.garden/desktop` are deliberately absent. Those are the Chromium profile
 * and the live desktop session - the cookie jar for every site the owner has ever signed into - and
 * rolling them back to yesterday morning signs the owner out of all of them. A rewind undoes what
 * the agent did to the work; it is not meant to undo the owner's own logins.
 *
 * The agent's `$HOME` is absent for the same kind of reason and a second one. It is `.home` at the
 * container root, beside `workspace/` rather than inside it (execution.ts), so a rewind does not
 * sign the agent out of its own coding-CLI sessions - and a toolchain cache under it is enormous:
 * a Rust toolchain is 88,021 files counted on a development machine (`~/.rustup` 66,157 plus
 * `~/.cargo` 21,864), and a conda environment is routinely another 30-60k. Those would be walked
 * and hashed every turn and counted against `maxFiles` below, so putting HOME in here would spend
 * the very undo point it was meant to strengthen.
 *
 * THIS LIST IS THE SET OF TREES A CHECKPOINT WALKS, NOT WHAT IT HOLDS, and it is read as if it
 * were both. The worker's approval floor keeps a copy of it and drops the card on a delete strictly
 * inside it, on the grounds that a rewind puts the file back (`apps/worker/src/approval-policy.ts`,
 * the location test in `destructiveCommand`). Two ceilings below separate walking from holding:
 * `maxFiles` refuses the checkpoint outright and the turn then has no undo point at all, and
 * `maxFileBytes` records a larger file as uncovered and walks past it. Both are now carried to the
 * floor on `ApprovalContext.undoPoint`: the first as a missing checkpoint id, the second as
 * `CheckpointSummary.uncoveredPaths`, which cards a delete naming one of those files and leaves
 * every other delete on the turn free. Anyone widening or narrowing this list is moving that rule
 * too.
 */
export const CHECKPOINT_CONTENT = ['workspace', '.garden/artifacts'] as const;
export const CHECKPOINT_BROWSER_PROFILE = '.garden/browser';

export type CheckpointMechanism = 'btrfs' | 'zfs' | 'content';

export interface CheckpointConfig {
  workspaceRoot: string;
  btrfsExecutable: string;
  zfsExecutable: string;
  /** Where the host records installed packages. Absent on a non-Debian host, which is fine. */
  packageManifestPath: string;
  includeBrowserProfile: boolean;
  retainTurns: number;
  retainDailyDays: number;
  maxFiles: number;
  maxFileBytes: number;
  /**
   * How free space on the host is measured, overridable for the same reason `ExecutionGuards`
   * makes it overridable (`execution.ts:181`): so the floor can be exercised without filling a
   * real filesystem.
   *
   * It is also what makes this file's own suite hermetic. Reading the real disk here would fail
   * sixteen checkpoint tests on any machine under two per cent free, with a sentence about a full
   * disk indistinguishable from genuine breakage. A build whose verdict depends on the free space of the machine
   * running it is not evidence either way.
   */
  hostStorage?: ((root: string) => Promise<HostStorage>) | undefined;
}

/**
 * Why an automatic checkpoint could not be taken, said in a way a program can read.
 *
 * The worker decides whether a turn that lost its undo point mentions it to the owner or leaves
 * it in the work log, and it decided by matching a regular expression against this file's prose
 * (`apps/worker/src/agent.ts:639`). That regex knows the disk sentence and nothing else, so the
 * over-ceiling refusal below - which the owner absolutely can act on, by taking a named recovery
 * point or clearing the tree - reached them as silence, every turn, once a workspace grew past
 * `maxFiles`. Prose belongs to whoever is reading it; this reader is a program, so it gets a code.
 */
export type CheckpointRefusalCode = 'checkpoint_host_disk_full' | 'checkpoint_workspace_too_large';

export class CheckpointRefusedError extends Error {
  constructor(
    readonly code: CheckpointRefusalCode,
    message: string
  ) {
    super(message);
    this.name = 'CheckpointRefusedError';
  }
}

export interface CheckpointSummary {
  id: string;
  mechanism: CheckpointMechanism;
  createdAt: string;
  /** Null under btrfs and ZFS: a filesystem snapshot is instant precisely because nothing counts. */
  fileCount: number | null;
  totalBytes: number | null;
  /** Bytes this checkpoint had to write. Zero when nothing changed since the last one. */
  storedBytes: number;
  changedFileCount: number;
  uncoveredFileCount: number;
  /**
   * WHICH files those were, root-relative, so the worker's approval floor can card a delete that
   * names one of them and go on freeing every other delete on the turn.
   *
   * The count alone cannot do that. A workspace built for model weights or sequencing reads holds
   * an oversize file more or less permanently, so a floor reading only the count would keep the
   * card on `rm -rf dist` for the whole life of that workspace - which is the friction the location
   * rule was written to remove, reintroduced on exactly the machines this ceiling exists for.
   *
   * Empty under btrfs and ZFS, and truthfully so: those mechanisms snapshot the subvolume and hold
   * everything in it, and this branch is the only one with a ceiling.
   */
  uncoveredPaths: string[];
  /**
   * Whether the list above was cut off at `UNCOVERED_PATHS_ON_THE_WIRE`, in which case it names
   * some of the uncovered files and not all of them. The worker reads a truncated list as no list
   * at all and keeps the card on every delete, which is why this is a separate flag rather than a
   * short array nothing distinguishes from a complete one.
   */
  uncoveredPathsTruncated: boolean;
  durationMs: number;
}

/**
 * How many uncovered paths ride back to the worker on the checkpoint response.
 *
 * Sixty-four. Every one of these files is over `maxFileBytes` - 2 GiB by default - so sixty-four of
 * them is 128 GiB of oversize content in one workspace, more than any workspace on this box has
 * held. The number is a bound on the WORKER's state row rather than on this response: the worker
 * records the list in `AgentState.checkpoint` and rewrites that row on every step of the turn, and
 * sixty-four paths is about four kilobytes there.
 *
 * The one way past it that costs nothing is sparse files, which are over the ceiling by size and
 * take no disk at all - so passing it is a real possibility rather than a theoretical one, and it
 * is reported as truncation rather than quietly trimmed. A truncated list keeps every card.
 */
const UNCOVERED_PATHS_ON_THE_WIRE = 64;

export interface CheckpointChange {
  path: string;
  /** Size after a restore. */
  sizeBytes: number;
  /** Size right now, when the file exists in both and differs. */
  currentSizeBytes?: number;
}

export interface CheckpointPackageChange {
  name: string;
  version: string;
  previousVersion?: string;
}

export interface CheckpointPreview {
  id: string;
  mechanism: CheckpointMechanism;
  createdAt: string;
  /** Files that exist now and did not then: a restore deletes these. */
  added: CheckpointChange[];
  /** Files in both that differ: a restore puts the checkpointed content back. */
  modified: CheckpointChange[];
  /** Files that existed then and are gone now: a restore brings these back. */
  deleted: CheckpointChange[];
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  restoredBytes: number;
  removedBytes: number;
  /** Packages the host gained since the checkpoint. A restore does not uninstall them. */
  packagesInstalled: CheckpointPackageChange[];
  packagesRemoved: CheckpointPackageChange[];
  /** Files too large for a checkpoint to hold, which a restore therefore leaves as they are. */
  uncovered: CheckpointChange[];
  truncated: boolean;
}

export interface CheckpointRestoreResult {
  id: string;
  restoredFileCount: number;
  removedFileCount: number;
  restoredBytes: number;
}

export interface CheckpointRecord {
  id: string;
  mechanism: CheckpointMechanism;
  createdAt: string;
  taskId: string | null;
  turn: number;
  fileCount: number | null;
  totalBytes: number | null;
  storedBytes: number;
}

type PackageList = Array<[string, string]>;

interface CheckpointMeta {
  version: 1;
  id: string;
  mechanism: CheckpointMechanism;
  createdAt: string;
  taskId: string | null;
  turn: number;
  fileCount: number | null;
  totalBytes: number | null;
  storedBytes: number;
  durationMs: number;
  packages: PackageList;
  /** Identity of the host package database when it was read, so an unchanged one is not reparsed. */
  packageStat: { size: number; mtimeMs: number } | null;
  /** btrfs snapshot directory or ZFS `dataset@snapshot`, for the mechanisms that have one. */
  source: string | null;
}

interface CheckpointManifest {
  version: 1;
  /** [path, mode, size, mtimeMs, contentHash] */
  files: Array<[string, number, number, number, string]>;
  /** [path, mode] - carried so an empty directory survives a rewind. */
  directories: Array<[string, number]>;
  /** [path, target] */
  links: Array<[string, string]>;
  /** [path, size] - over the per-file ceiling, recorded rather than silently dropped. */
  uncovered: Array<[string, number]>;
}

interface ScannedFile {
  mode: number;
  size: number;
  mtimeMs: number;
}

interface TreeScan {
  files: Map<string, ScannedFile>;
  directories: Map<string, number>;
  links: Map<string, string>;
  uncovered: Map<string, number>;
}

export type CheckpointRunner = (executable: string, args: string[]) => Promise<string>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';

const isMissing = (error: unknown): boolean =>
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

const safeId = (value: string, label: string): string => {
  if (!UUID.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
};

/** Refuses anything a manifest could carry that would read or write outside the workspace. */
const safeRelative = (value: string): string => {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.includes('\0') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new Error('Checkpoint entry is not a workspace-relative path');
  return value;
};

export const runCheckpointCommand: CheckpointRunner = async (executable, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
    let out = '';
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      error = (error + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
    });
    child.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else
        reject(
          new Error(
            `${path.basename(executable)} ${args[0] ?? ''} failed${
              signal ? ` with ${signal}` : ` with exit ${String(code)}`
            }: ${error.trim()}`
          )
        );
    });
  });

/**
 * Reads the host's installed-package list.
 *
 * A rewind cannot uninstall a package: dpkg's own state lives outside the workspace and rolling that
 * back would be a system restore, not an undo. So the honest thing is to know which packages arrived
 * after a checkpoint and say so in the preview, rather than let the owner find out later.
 */
export const parseInstalledPackages = (statusFile: string): PackageList => {
  const packages: PackageList = [];
  let name = '';
  let version = '';
  let installed = false;
  const flush = (): void => {
    if (name && installed) packages.push([name, version]);
    name = '';
    version = '';
    installed = false;
  };
  for (const line of statusFile.split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('Package: ')) name = line.slice(9).trim();
    else if (line.startsWith('Version: ')) version = line.slice(9).trim();
    else if (line.startsWith('Status: ')) installed = line.slice(8).trim().endsWith('ok installed');
  }
  flush();
  return packages;
};

const readPackages = async (
  manifestPath: string,
  previous: { packages: PackageList; packageStat: CheckpointMeta['packageStat'] } | null
): Promise<{ packages: PackageList; packageStat: CheckpointMeta['packageStat'] }> => {
  const details = await lstat(manifestPath).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!details) return { packages: [], packageStat: null };
  const stamp = { size: details.size, mtimeMs: details.mtimeMs };
  // The package database changes a few times a month and is several megabytes. Re-parsing it every
  // turn to learn nothing is exactly the sort of cost this feature cannot afford.
  if (
    previous?.packageStat &&
    previous.packageStat.size === stamp.size &&
    previous.packageStat.mtimeMs === stamp.mtimeMs
  )
    return { packages: previous.packages, packageStat: stamp };
  return {
    packages: parseInstalledPackages(await readFile(manifestPath, 'utf8')),
    packageStat: stamp
  };
};

/**
 * How many times a file that moves under the hash is re-read before its last reading is taken.
 *
 * A file being appended to on every tick cannot be captured exactly by anything short of stopping
 * the workspace, and failing the checkpoint over one busy log would cost the turn its whole undo.
 * Three is enough for a build that rewrites a file once.
 */
const HASH_ATTEMPTS = 3;

/**
 * The content hash and the stat recorded beside it, taken from one descriptor.
 *
 * A checkpoint create deliberately does not stop the workspace - a turn cannot afford to pause a
 * watch build - so the walk's stat and this pass are hundreds of milliseconds apart on a large
 * tree. Recording the walk's size and mtime against these bytes was a durable lie: a restore wrote
 * back content produced *after* the moment the owner asked to return to and then set the older
 * timestamp, so the next checkpoint saw the file as unchanged and kept the wrong pairing for good.
 * Statting the descriptor that was just read closes that window; bracketing the read closes the
 * narrower one where the file moves during the read itself, which would otherwise pin the hash of
 * a torn read against a stat that matches it perfectly.
 */
const hashFile = async (
  target: string
): Promise<{ hash: string; size: number; mtimeMs: number }> => {
  const handle = await open(target, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let attempt = 1; ; attempt += 1) {
      const opened = await handle.stat();
      const hash = createHash('sha256');
      // Positional reads rather than the descriptor's own cursor, so a re-read starts at the top.
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const settled = await handle.stat();
      if (
        attempt < HASH_ATTEMPTS &&
        (settled.size !== opened.size || settled.mtimeMs !== opened.mtimeMs)
      )
        continue;
      return {
        hash: hash.digest('hex'),
        size: settled.size,
        // Whole milliseconds for the reason scanTree floors: it is the finest a restore puts back.
        mtimeMs: Math.floor(settled.mtimeMs)
      };
    }
  } finally {
    await handle.close();
  }
};

/**
 * Runs `work` over `values` a few at a time.
 *
 * Every phase here is one syscall per file with nothing between them, so the whole thing sits idle
 * waiting on libuv's thread pool if it is written as a plain loop. A walk of a 30 000-file tree
 * measured 593 ms sequentially and 184 ms at this width, on the same tree.
 */
const CONCURRENCY = 16;
const inParallel = async <T>(values: T[], work: (value: T) => Promise<void>): Promise<void> => {
  for (let index = 0; index < values.length; index += CONCURRENCY)
    await Promise.all(values.slice(index, index + CONCURRENCY).map(work));
};

const scanTree = async (
  base: string,
  roots: readonly string[],
  limits: { maxFiles: number; maxFileBytes: number }
): Promise<TreeScan> => {
  const scan: TreeScan = {
    files: new Map(),
    directories: new Map(),
    links: new Map(),
    uncovered: new Map()
  };
  let level = roots.map((relative) => ({ relative, mode: 0o770 }));
  while (level.length) {
    const next: Array<{ relative: string; mode: number }> = [];
    await inParallel(level, async (current) => {
      const entries = await readdir(path.join(base, current.relative), {
        withFileTypes: true
      }).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (!entries) return;
      scan.directories.set(current.relative, current.mode);
      await Promise.all(
        entries.map(async (entry) => {
          const child = `${current.relative}/${entry.name}`;
          if (entry.isSymbolicLink()) {
            scan.links.set(child, await readlink(path.join(base, child)));
            return;
          }
          // Sockets, FIFOs and device nodes are runtime objects, not content: copying one is
          // meaningless and recreating it on restore would be worse.
          if (!entry.isDirectory() && !entry.isFile()) return;
          const details = await lstat(path.join(base, child)).catch((error: unknown) => {
            if (isMissing(error)) return null;
            throw error;
          });
          if (!details) return;
          if (details.isDirectory()) {
            next.push({ relative: child, mode: details.mode & 0o7777 });
            return;
          }
          // Recorded rather than held, and recorded rather than dropped: the preview tells the
          // owner a restore leaves this file as it is, and the paths ride back to the worker on
          // `CheckpointSummary.uncoveredPaths` so its approval floor cards a delete that names one.
          // It is the one place a tree this checkpoint WALKS contains something it does not HOLD -
          // @see the CHECKPOINT_CONTENT declaration above.
          if (details.size > limits.maxFileBytes) {
            scan.uncovered.set(child, details.size);
            return;
          }
          scan.files.set(child, {
            mode: details.mode & 0o7777,
            size: details.size,
            // Whole milliseconds, because that is the finest a restore can put back: a checkpoint
            // taken right after a restore has to see the file it just wrote as unchanged, or every
            // rewind would leave the next turn re-hashing the whole tree.
            mtimeMs: Math.floor(details.mtimeMs)
          });
        })
      );
      // A refusal, not a partial checkpoint: the worker catches it, tells the owner this turn has
      // no undo point and lets the work carry on. That is right for the work and it is why
      // `ApprovalContext.undoPoint` exists - on this turn a rewind is not an answer for anything,
      // so the floor must keep the card on every delete inside these same trees.
      if (scan.files.size > limits.maxFiles)
        throw new CheckpointRefusedError(
          'checkpoint_workspace_too_large',
          `This workspace holds more than ${limits.maxFiles} files, which is more than automatic checkpoints cover. Take a named recovery point instead.`
        );
    });
    level = next;
  }
  // The content roots themselves are made by workspace setup and are never restored or removed.
  for (const relative of roots) scan.directories.delete(relative);
  return scan;
};

const manifestScan = (manifest: CheckpointManifest): TreeScan => ({
  files: new Map(
    manifest.files.map(([relative, mode, size, mtimeMs]) => [
      safeRelative(relative),
      { mode, size, mtimeMs }
    ])
  ),
  directories: new Map(
    manifest.directories.map(([relative, mode]) => [safeRelative(relative), mode])
  ),
  links: new Map(manifest.links.map(([relative, target]) => [safeRelative(relative), target])),
  uncovered: new Map(manifest.uncovered.map(([relative, size]) => [safeRelative(relative), size]))
});

const hashesOf = (manifest: CheckpointManifest): Map<string, string> =>
  new Map(manifest.files.map(([relative, , , , hash]) => [safeRelative(relative), hash]));

/**
 * The previous checkpoint keyed by path, in one pass and without path validation: every key is
 * looked up using a path that came from walking the live tree, so nothing here reaches the
 * filesystem. This is the hot structure - it is consulted once per file in the workspace.
 */
const priorIndex = (
  manifest: CheckpointManifest | null
): Map<string, { size: number; mtimeMs: number; hash: string }> => {
  const index = new Map<string, { size: number; mtimeMs: number; hash: string }>();
  for (const [relative, , size, mtimeMs, hash] of manifest?.files ?? [])
    index.set(relative, { size, mtimeMs, hash });
  return index;
};

const blobPath = (directory: string, hash: string): string => {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Checkpoint content address is malformed');
  return path.join(directory, 'blobs', hash.slice(0, 2), hash);
};

/**
 * Same content, one copy on disk - and a clone rather than a copy where the filesystem can do it.
 * `COPYFILE_FICLONE` is a reflink on btrfs and XFS, which costs no data blocks at all; everywhere
 * else the kernel falls back to a plain copy, so this is never worse than copying.
 *
 * The scratch name carries a nonce because the destination does not identify the writer: blobs are
 * addressed by content, the copies run in parallel, and two changed files that happen to hold the
 * same bytes - an empty file, a duplicated asset, a dependency vendored twice - arrive here at the
 * same moment for the same blob. Sharing one `.partial` meant the second writer deleted the first
 * one's finished copy out from under it, and the first one's rename failed with ENOENT and took
 * the whole checkpoint down: the turn ran with no undo point because the workspace contained two
 * identical files. Each writer now renames its own copy into place, and last writer wins on
 * identical bytes.
 */
const cloneFile = async (from: string, to: string): Promise<void> => {
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  const temporary = `${to}.${randomUUID()}.partial`;
  try {
    await copyFile(from, temporary, constants.COPYFILE_FICLONE);
    await rename(temporary, to);
  } catch (error) {
    // A rename that never happened leaves the copy behind. Blob collection would sweep it, but
    // that only runs after a prune has fallen due, so this cleans up after itself instead of
    // leaving the store carrying a dead copy of a file until then.
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const byPath = (left: CheckpointChange, right: CheckpointChange): number =>
  left.path < right.path ? -1 : 1;
const byName = (left: CheckpointPackageChange, right: CheckpointPackageChange): number =>
  left.name < right.name ? -1 : 1;

/**
 * Cheap per-turn checkpoints of the workspace.
 *
 * The mechanism is whatever the host can actually do, found out by trying it: a btrfs or ZFS
 * snapshot where one is available, and otherwise a content-addressed store where an unchanged file
 * costs one `lstat` and no bytes at all. Nothing here copies a workspace per turn - that would make
 * the feature more expensive than the work it protects.
 */
export class WorkspaceCheckpoints {
  readonly #config: CheckpointConfig;
  readonly #run: CheckpointRunner;
  readonly #mechanisms = new Map<
    string,
    Promise<{ mechanism: CheckpointMechanism; dataset: string | null }>
  >();
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(config: CheckpointConfig, run: CheckpointRunner = runCheckpointCommand) {
    this.#config = config;
    this.#run = run;
  }

  /**
   * One checkpoint operation at a time per workspace.
   *
   * Two tasks can run in the same workspace at once, and collecting content while another turn is
   * mid-checkpoint would delete blobs whose manifest has not landed yet - a checkpoint that looks
   * fine and cannot be restored. One runner process owns a workspace, so an in-process queue is
   * the whole of the answer.
   */
  async #serialize<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const key = safeId(workspaceId, 'workspace ID');
    const queued = (this.#queues.get(key) ?? Promise.resolve()).then(operation, operation);
    this.#queues.set(
      key,
      queued.catch(() => undefined)
    );
    return queued;
  }

  #directory(workspaceId: string): string {
    return path.join(
      path.resolve(this.#config.workspaceRoot),
      '.garden-checkpoints',
      safeId(workspaceId, 'workspace ID')
    );
  }

  #roots(): readonly string[] {
    return this.#config.includeBrowserProfile
      ? [...CHECKPOINT_CONTENT, CHECKPOINT_BROWSER_PROFILE]
      : CHECKPOINT_CONTENT;
  }

  /**
   * The scan bounds, and the one place the two callers differ.
   *
   * `maxFiles` bounds *taking* a checkpoint: past it the walk costs more than the checkpoint is
   * worth, so the owner is told to take a named recovery point instead. It never bounded *using*
   * one, and applying it to the preview and the restore closed the only way back out of the state
   * that crossed it. A workspace over the ceiling is the ordinary shape of a workspace that has
   * just had an `npm install` unpack forty thousand files into it - which is exactly the turn an
   * owner wants to rewind - and every checkpoint taken before that moment was under the ceiling
   * and perfectly restorable. Refusing to restore it left them holding a valid checkpoint they
   * were not allowed to use, with the only remedy being to delete by hand the very files the
   * rewind was going to remove for them.
   *
   * `maxFileBytes` still applies on every path, because it is not a refusal: a file larger than it
   * was never in the checkpoint, so the scan records it as uncovered and carries on.
   */
  #limits(purpose: 'create' | 'use'): { maxFiles: number; maxFileBytes: number } {
    return {
      maxFiles: purpose === 'create' ? this.#config.maxFiles : Number.POSITIVE_INFINITY,
      maxFileBytes: this.#config.maxFileBytes
    };
  }

  /**
   * Which snapshot mechanism this host actually has, established by performing one - never assumed
   * from a mount table.
   *
   * The probe runs the whole lifecycle, create and delete, because a host can permit a btrfs
   * snapshot and refuse to delete it, and a mechanism that cannot prune is worse than not having
   * one: it fills the disk one turn at a time. Anything that fails, for any reason, falls through
   * to the content store, which asks nothing of the filesystem and works on plain ext4.
   *
   * Private, and it stays private. There was a public `mechanism(root)` in front of this whose only
   * callers were the tests that asserted the probe's answer; nothing in the product ever asked the
   * host what it could do, because everything that needs to know is already told by the checkpoint
   * it just took. Those tests now read `create(...).mechanism`, which is the same answer taken from
   * the operation that actually used it rather than from a probe run for the question's own sake.
   */
  async #resolve(
    root: string
  ): Promise<{ mechanism: CheckpointMechanism; dataset: string | null }> {
    const key = path.resolve(root);
    const existing = this.#mechanisms.get(key);
    if (existing) return existing;
    const probe = this.#probe(key).catch(() => ({
      mechanism: 'content' as const,
      dataset: null
    }));
    this.#mechanisms.set(key, probe);
    return probe;
  }

  async #probe(root: string): Promise<{ mechanism: CheckpointMechanism; dataset: string | null }> {
    const probeId = `garden-probe-${Date.now().toString(36)}`;
    const directory = path.join(path.dirname(root), '.garden-checkpoints');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, probeId);
    try {
      await this.#run(this.#config.btrfsExecutable, ['subvolume', 'show', root]);
      await this.#run(this.#config.btrfsExecutable, ['subvolume', 'snapshot', '-r', root, target]);
      try {
        await this.#run(this.#config.btrfsExecutable, ['subvolume', 'delete', target]);
        return { mechanism: 'btrfs', dataset: null };
      } catch (error) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    } catch {
      // Not btrfs, or btrfs without the privilege to snapshot. Either way, try the next one.
    }
    try {
      const listed = await this.#run(this.#config.zfsExecutable, [
        'list',
        '-H',
        '-o',
        'name,mountpoint',
        root
      ]);
      const [dataset, mountpoint] = listed.trim().split('\t');
      // A dataset mounted above the workspace would snapshot the whole box, not this workspace.
      if (!dataset || !mountpoint || path.resolve(mountpoint) !== root)
        throw new Error('workspace is not its own dataset');
      const snapshot = `${dataset}@${probeId}`;
      await this.#run(this.#config.zfsExecutable, ['snapshot', snapshot]);
      try {
        await this.#run(this.#config.zfsExecutable, ['destroy', snapshot]);
        return { mechanism: 'zfs', dataset };
      } catch (error) {
        await this.#run(this.#config.zfsExecutable, ['destroy', snapshot]).catch(() => undefined);
        throw error;
      }
    } catch {
      // Neither. The content store below is the portable answer and needs no privilege at all.
    }
    return { mechanism: 'content', dataset: null };
  }

  async create(
    workspaceId: string,
    root: string,
    input: { checkpointId: string; taskId?: string | null; turn?: number }
  ): Promise<CheckpointSummary> {
    return this.#serialize(workspaceId, () => this.#create(workspaceId, root, input));
  }

  async #create(
    workspaceId: string,
    root: string,
    input: { checkpointId: string; taskId?: string | null; turn?: number }
  ): Promise<CheckpointSummary> {
    const startedAt = Date.now();
    const id = safeId(input.checkpointId, 'checkpoint ID');
    const directory = this.#directory(workspaceId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (belowHostStorageFloor(await (this.#config.hostStorage ?? hostStorage)(root)))
      throw new CheckpointRefusedError(
        'checkpoint_host_disk_full',
        'Host disk is too full to take an automatic checkpoint, so this turn cannot be rewound.'
      );

    const previous = await this.#latestMeta(directory);
    const resolved = await this.#resolve(root);
    const { packages, packageStat } = await readPackages(
      this.#config.packageManifestPath,
      previous ? { packages: previous.packages, packageStat: previous.packageStat } : null
    );
    const meta: CheckpointMeta = {
      version: 1,
      id,
      mechanism: resolved.mechanism,
      createdAt: new Date().toISOString(),
      taskId: input.taskId ?? null,
      turn: input.turn ?? 0,
      fileCount: null,
      totalBytes: null,
      storedBytes: 0,
      durationMs: 0,
      packages,
      packageStat,
      source: null
    };
    let changedFileCount = 0;
    let uncoveredFileCount = 0;
    let uncoveredPaths: string[] = [];
    let uncoveredPathsTruncated = false;

    if (resolved.mechanism === 'btrfs') {
      const target = path.join(directory, id);
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      await this.#run(this.#config.btrfsExecutable, ['subvolume', 'snapshot', '-r', root, target]);
      meta.source = target;
    } else if (resolved.mechanism === 'zfs') {
      const snapshot = `${resolved.dataset ?? ''}@garden-${id}`;
      await this.#run(this.#config.zfsExecutable, ['snapshot', snapshot]);
      meta.source = snapshot;
    } else {
      const scan = await scanTree(root, this.#roots(), this.#limits('create'));
      const priorManifest =
        previous?.mechanism === 'content'
          ? await readManifest(directory, previous.id).catch(() => null)
          : null;
      const prior = priorIndex(priorManifest);
      const files: CheckpointManifest['files'] = [];
      const changed: Array<[string, ScannedFile]> = [];
      let totalBytes = 0;
      for (const [relative, details] of scan.files) {
        // An unchanged file costs one lstat and nothing else: no read, no hash, no copy. That is
        // what makes a per-turn checkpoint of a tree with a node_modules in it affordable.
        const known = prior.get(relative);
        if (known && known.size === details.size && known.mtimeMs === details.mtimeMs) {
          totalBytes += details.size;
          files.push([relative, details.mode, details.size, details.mtimeMs, known.hash]);
        } else changed.push([relative, details]);
      }
      changedFileCount = changed.length;
      await inParallel(changed, async ([relative, details]) => {
        // The stat recorded here is the one `hashFile` took from the descriptor it hashed, not the
        // walk's: those are two different instants and the workspace keeps running between them.
        const hashed = await hashFile(path.join(root, relative));
        totalBytes += hashed.size;
        const blob = blobPath(directory, hashed.hash);
        // The store holds one copy per distinct content, so a file the agent rewrote back to a
        // version it already had - or a dependency reinstalled unchanged - costs nothing.
        if (!(await lstat(blob).catch(() => null))) {
          await cloneFile(path.join(root, relative), blob);
          // Read-only, because a blob is shared by every checkpoint that names that content.
          await chmod(blob, 0o400).catch(() => undefined);
          meta.storedBytes += hashed.size;
        }
        files.push([relative, details.mode, hashed.size, hashed.mtimeMs, hashed.hash]);
      });
      uncoveredFileCount = scan.uncovered.size;
      // Sorted before it is cut, so a truncated list is the same list twice running rather than
      // whichever sixty-four the parallel walk happened to reach first - the floor's answer would
      // otherwise move between two checkpoints of an unchanged tree.
      const walked = [...scan.uncovered.keys()].sort();
      uncoveredPathsTruncated = walked.length > UNCOVERED_PATHS_ON_THE_WIRE;
      uncoveredPaths = walked.slice(0, UNCOVERED_PATHS_ON_THE_WIRE);
      const manifest: CheckpointManifest = {
        version: 1,
        files: files.sort((left, right) => (left[0] < right[0] ? -1 : 1)),
        directories: [...scan.directories],
        links: [...scan.links],
        uncovered: [...scan.uncovered]
      };
      meta.fileCount = files.length;
      meta.totalBytes = totalBytes;
      await this.#writeAtomic(
        path.join(directory, `${id}.manifest.json.gz`),
        // Level 1: a manifest of 30 000 files compresses from 4.3 MB to 395 KB in 16 ms here, where
        // the default level spends 44 ms to reach 335 KB. This is written once a turn.
        gzipSync(Buffer.from(JSON.stringify(manifest)), { level: 1 })
      );
    }

    meta.durationMs = Date.now() - startedAt;
    await this.#writeAtomic(path.join(directory, `${id}.json`), Buffer.from(JSON.stringify(meta)));
    return {
      id,
      mechanism: meta.mechanism,
      createdAt: meta.createdAt,
      fileCount: meta.fileCount,
      totalBytes: meta.totalBytes,
      storedBytes: meta.storedBytes,
      changedFileCount,
      uncoveredFileCount,
      uncoveredPaths,
      uncoveredPathsTruncated,
      durationMs: meta.durationMs
    };
  }

  async #writeAtomic(target: string, content: Buffer): Promise<void> {
    await writeFile(`${target}.partial`, content, { mode: 0o600 });
    await rename(`${target}.partial`, target);
  }

  async list(workspaceId: string): Promise<CheckpointRecord[]> {
    return (await this.#metas(this.#directory(workspaceId))).map((meta) => ({
      id: meta.id,
      mechanism: meta.mechanism,
      createdAt: meta.createdAt,
      taskId: meta.taskId,
      turn: meta.turn,
      fileCount: meta.fileCount,
      totalBytes: meta.totalBytes,
      storedBytes: meta.storedBytes
    }));
  }

  async #metas(directory: string): Promise<CheckpointMeta[]> {
    const entries = await readdir(directory).catch((error: unknown) => {
      if (isMissing(error)) return [] as string[];
      throw error;
    });
    const metas: CheckpointMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (!UUID.test(id)) continue;
      const meta = await readMeta(directory, id).catch(() => null);
      if (meta) metas.push(meta);
    }
    return metas.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  }

  async #latestMeta(directory: string): Promise<CheckpointMeta | null> {
    return (await this.#metas(directory))[0] ?? null;
  }

  /** The checkpoint's own view of the tree, however that mechanism happens to keep it. */
  async #source(
    directory: string,
    meta: CheckpointMeta,
    root: string
  ): Promise<{ scan: TreeScan; content: (relative: string) => string }> {
    if (meta.mechanism === 'content') {
      const manifest = await readManifest(directory, meta.id);
      const hashes = hashesOf(manifest);
      return {
        scan: manifestScan(manifest),
        content: (relative) => {
          const hash = hashes.get(relative);
          if (!hash) throw new Error(`Checkpoint has no content for ${relative}`);
          return blobPath(directory, hash);
        }
      };
    }
    // A filesystem snapshot is a whole second copy of the workspace, browser profile included. The
    // excluded roots are dropped here on the way out, so a rewind still leaves the profile alone.
    const base =
      meta.mechanism === 'btrfs'
        ? (meta.source ?? path.join(directory, meta.id))
        : path.join(root, '.zfs', 'snapshot', `garden-${meta.id}`);
    return {
      scan: await scanTree(base, this.#roots(), this.#limits('use')),
      content: (relative) => path.join(base, safeRelative(relative))
    };
  }

  /**
   * What a restore would do, before it does it.
   *
   * The rest of this product asks the owner to trust a rewind. That is only reasonable if they can
   * read the list first: which files come back, which ones disappear, and which packages the agent
   * installed that no rewind is going to remove.
   */
  async preview(
    workspaceId: string,
    root: string,
    checkpointId: string,
    limit = 200
  ): Promise<CheckpointPreview> {
    return this.#serialize(workspaceId, () =>
      this.#preview(workspaceId, root, checkpointId, limit)
    );
  }

  async #preview(
    workspaceId: string,
    root: string,
    checkpointId: string,
    limit: number
  ): Promise<CheckpointPreview> {
    const directory = this.#directory(workspaceId);
    const meta = await readMeta(directory, safeId(checkpointId, 'checkpoint ID'));
    const source = await this.#source(directory, meta, root);
    const before = source.scan;
    const now = await scanTree(root, this.#roots(), this.#limits('use'));
    const added: CheckpointChange[] = [];
    const modified: CheckpointChange[] = [];
    const deleted: CheckpointChange[] = [];
    let restoredBytes = 0;
    let removedBytes = 0;
    for (const [relative, details] of now.files) {
      const prior = before.files.get(relative);
      if (!prior) {
        added.push({ path: relative, sizeBytes: details.size });
        removedBytes += details.size;
        continue;
      }
      if (prior.size !== details.size || prior.mtimeMs !== details.mtimeMs) {
        modified.push({
          path: relative,
          sizeBytes: prior.size,
          currentSizeBytes: details.size
        });
        restoredBytes += prior.size;
      }
    }
    for (const [relative, details] of before.files) {
      if (now.files.has(relative)) continue;
      deleted.push({ path: relative, sizeBytes: details.size });
      restoredBytes += details.size;
    }
    for (const [relative] of now.links)
      if (!before.links.has(relative)) added.push({ path: relative, sizeBytes: 0 });
    for (const [relative] of before.links)
      if (!now.links.has(relative)) deleted.push({ path: relative, sizeBytes: 0 });

    const current = await readPackages(this.#config.packageManifestPath, null);
    const priorPackages = new Map(meta.packages);
    const currentPackages = new Map(current.packages);
    const packagesInstalled: CheckpointPackageChange[] = [];
    const packagesRemoved: CheckpointPackageChange[] = [];
    for (const [name, version] of currentPackages) {
      const was = priorPackages.get(name);
      if (was === undefined) packagesInstalled.push({ name, version });
      else if (was !== version) packagesInstalled.push({ name, version, previousVersion: was });
    }
    for (const [name, version] of priorPackages)
      if (!currentPackages.has(name)) packagesRemoved.push({ name, version });

    return {
      id: meta.id,
      mechanism: meta.mechanism,
      createdAt: meta.createdAt,
      added: added.sort(byPath).slice(0, limit),
      modified: modified.sort(byPath).slice(0, limit),
      deleted: deleted.sort(byPath).slice(0, limit),
      addedCount: added.length,
      modifiedCount: modified.length,
      deletedCount: deleted.length,
      restoredBytes,
      removedBytes,
      packagesInstalled: packagesInstalled.sort(byName).slice(0, limit),
      packagesRemoved: packagesRemoved.sort(byName).slice(0, limit),
      uncovered: [...before.uncovered]
        .map(([relative, size]) => ({ path: relative, sizeBytes: size }))
        .sort(byPath)
        .slice(0, limit),
      truncated:
        added.length > limit ||
        modified.length > limit ||
        deleted.length > limit ||
        packagesInstalled.length > limit
    };
  }

  async restore(
    workspaceId: string,
    root: string,
    checkpointId: string
  ): Promise<CheckpointRestoreResult> {
    return this.#serialize(workspaceId, () => this.#restore(workspaceId, root, checkpointId));
  }

  async #restore(
    workspaceId: string,
    root: string,
    checkpointId: string
  ): Promise<CheckpointRestoreResult> {
    const directory = this.#directory(workspaceId);
    const meta = await readMeta(directory, safeId(checkpointId, 'checkpoint ID'));
    const source = await this.#source(directory, meta, root);
    const before = source.scan;
    const now = await scanTree(root, this.#roots(), this.#limits('use'));
    let restoredFileCount = 0;
    let removedFileCount = 0;
    let restoredBytes = 0;

    const outdated = [...before.files].filter(([relative, details]) => {
      const current = now.files.get(relative);
      return !current || current.size !== details.size || current.mtimeMs !== details.mtimeMs;
    });
    // Everything this restore is going to read, proven to be there before anything is destroyed.
    // The removal pass used to run first, and the blob store can be short an object - a collection
    // that skipped a manifest it could not read, an interrupted delete between the manifest and
    // the metadata. The clone then threw ENOENT into a tree that had already lost every file made
    // since the checkpoint, the route answered a bare failure, and the services were restarted
    // against the mixture. `restoreSnapshot` next door does the rename-aside dance; this is the
    // cheaper half of it, and it is what turns that loss into a refusal.
    //
    // Only the outdated set, because those are exactly the files a restore opens. Refusing a
    // rewind over content it was never going to read would cost the owner an undo they could have
    // had - the file is already correct on disk.
    const missing: string[] = [];
    await inParallel(outdated, async ([relative]) => {
      const held = await Promise.resolve()
        .then(() => lstat(source.content(relative)))
        .catch(() => null);
      if (!held) missing.push(relative);
    });
    if (missing.length) {
      const [first] = missing.sort();
      const others =
        missing.length > 1 ? ` and ${missing.length - 1} other file(s) from that turn` : '';
      throw new Error(
        `This checkpoint can no longer produce ${first}${others}. Nothing has been rewound. Choose another recovery point.`
      );
    }

    await inParallel(
      [...now.files.keys()].filter((relative) => !before.files.has(relative)),
      async (relative) => {
        await rm(path.join(root, safeRelative(relative)), { force: true });
        removedFileCount += 1;
      }
    );
    await inParallel(
      [...now.links.keys()].filter((relative) => !before.links.has(relative)),
      (relative) => rm(path.join(root, safeRelative(relative)), { force: true })
    );

    // Shallowest first, so a file's parent exists before the file arrives.
    for (const relative of [...before.directories.keys()].sort())
      await mkdir(path.join(root, safeRelative(relative)), { recursive: true, mode: 0o770 });

    await inParallel(outdated, async ([relative, details]) => {
      const target = path.join(root, safeRelative(relative));
      // A directory or a symlink where the checkpoint holds a file: replaced outright rather than
      // written through, which for a symlink would land outside the workspace.
      const existing = await lstat(target).catch(() => null);
      if (existing && !existing.isFile()) await rm(target, { recursive: true, force: true });
      await cloneFile(source.content(relative), target);
      // The mode is the workspace's own - group-writable for the agent account - and the timestamp
      // is the checkpoint's, which is also what lets the next checkpoint see the file as unchanged.
      await chmod(target, details.mode).catch(() => undefined);
      await utimes(target, new Date(details.mtimeMs), new Date(details.mtimeMs)).catch(
        () => undefined
      );
      restoredFileCount += 1;
      restoredBytes += details.size;
    });
    for (const [relative, target] of before.links) {
      if (now.links.get(relative) === target) continue;
      const linkPath = path.join(root, safeRelative(relative));
      await rm(linkPath, { recursive: true, force: true });
      await symlink(target, linkPath);
    }
    return { id: meta.id, restoredFileCount, removedFileCount, restoredBytes };
  }

  /**
   * Keeps the last N turns plus one checkpoint a day beyond them, and deletes the rest.
   *
   * Without this the cheap thing becomes the expensive thing: a checkpoint pins the version of every
   * file it names, so an unpruned store grows by the size of everything the agent has ever rewritten.
   */
  async prune(workspaceId: string): Promise<{ deleted: string[] }> {
    return this.#serialize(workspaceId, () => this.#prune(workspaceId));
  }

  async #prune(workspaceId: string): Promise<{ deleted: string[] }> {
    const directory = this.#directory(workspaceId);
    const metas = await this.#metas(directory);
    const keep = new Set(metas.slice(0, this.#config.retainTurns).map((meta) => meta.id));
    const dailyCutoff = Date.now() - this.#config.retainDailyDays * 24 * 60 * 60 * 1000;
    const dayKeepers = new Map<string, string>();
    for (const meta of metas) {
      const at = Date.parse(meta.createdAt);
      if (!Number.isFinite(at) || at < dailyCutoff) continue;
      // Newest first, so the first one seen for a day is the one that day keeps.
      const day = meta.createdAt.slice(0, 10);
      if (!dayKeepers.has(day)) dayKeepers.set(day, meta.id);
    }
    for (const id of dayKeepers.values()) keep.add(id);

    const deleted: string[] = [];
    for (const meta of metas) {
      if (keep.has(meta.id)) continue;
      // One checkpoint that will not release - a stuck subvolume, a file held open - must not fail
      // the turn that was only tidying up after itself. It stays, and the next prune tries again.
      try {
        await this.#deleteCheckpoint(directory, meta);
        deleted.push(meta.id);
      } catch {
        continue;
      }
    }
    if (!deleted.length) return { deleted };
    // Collecting means reading every surviving manifest, and at a steady state this prunes one
    // checkpoint per turn - so doing it every time would put the cost of the whole store back into
    // each turn. Blobs whose last checkpoint has gone are dead but harmless until then.
    const pending = (await this.#pendingCollections(directory)) + deleted.length;
    // A collection that could not account for every manifest is abandoned rather than allowed to
    // delete blobs it failed to see. The debt is kept instead of cleared, so the next prune tries
    // again, and pruning itself still succeeds - the old checkpoints are gone either way.
    const collected =
      pending >= GC_DEBT_THRESHOLD &&
      (await this.#collectBlobs(directory).then(
        () => true,
        () => false
      ));
    await this.#writeAtomic(
      path.join(directory, 'gc.json'),
      Buffer.from(JSON.stringify({ pending: collected ? 0 : pending }))
    );
    return { deleted };
  }

  async #pendingCollections(directory: string): Promise<number> {
    const raw = await readFile(path.join(directory, 'gc.json'), 'utf8').catch(() => '');
    const parsed = raw ? (JSON.parse(raw) as { pending?: unknown }) : {};
    return typeof parsed.pending === 'number' && Number.isFinite(parsed.pending)
      ? Math.max(0, parsed.pending)
      : 0;
  }

  async #deleteCheckpoint(directory: string, meta: CheckpointMeta): Promise<void> {
    if (meta.source && meta.mechanism !== 'content') {
      const release =
        meta.mechanism === 'btrfs'
          ? this.#run(this.#config.btrfsExecutable, ['subvolume', 'delete', meta.source])
          : this.#run(this.#config.zfsExecutable, ['destroy', meta.source]);
      await release.catch((error: unknown) => {
        throw new Error(`Checkpoint ${meta.id} could not be released: ${errorMessage(error)}`);
      });
    }
    await rm(path.join(directory, `${meta.id}.manifest.json.gz`), { force: true });
    await rm(path.join(directory, `${meta.id}.json`), { force: true });
  }

  /**
   * Drops blobs no surviving manifest names. Only ever runs after something was deleted.
   *
   * A manifest that cannot be read stops the collection rather than being passed over. Skipping it
   * says "this checkpoint references nothing", and the sweep below then deletes every blob it
   * alone was holding - while its `.json` survives, so the checkpoint stays in the list and is
   * still offered to the owner. They find out when a restore they are relying on cannot find its
   * content. Keeping unreferenced blobs costs disk; deleting referenced ones costs the owner the
   * undo this whole system exists to provide, so the sweep fails closed.
   *
   * A manifest that is simply absent is different: that checkpoint was already incomplete, and it
   * has no content to protect.
   */
  async #collectBlobs(directory: string): Promise<void> {
    const live = new Set<string>();
    for (const meta of await this.#metas(directory)) {
      if (meta.mechanism !== 'content') continue;
      const manifest = await readManifest(directory, meta.id).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw new Error(
          `Checkpoint ${meta.id} manifest could not be read, so unused blobs were left in place: ${errorMessage(error)}`
        );
      });
      if (!manifest) continue;
      for (const [, , , , hash] of manifest.files) live.add(hash);
    }
    const blobs = path.join(directory, 'blobs');
    const shards = await readdir(blobs).catch((error: unknown) => {
      if (isMissing(error)) return [] as string[];
      throw error;
    });
    for (const shard of shards) {
      const shardPath = path.join(blobs, shard);
      for (const name of await readdir(shardPath).catch(() => [] as string[]))
        if (!live.has(name)) await rm(path.join(shardPath, name), { force: true });
    }
  }

  async deleteAll(workspaceId: string): Promise<void> {
    return this.#serialize(workspaceId, async () => {
      const directory = this.#directory(workspaceId);
      for (const meta of await this.#metas(directory))
        await this.#deleteCheckpoint(directory, meta).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    });
  }
}

const readMeta = async (directory: string, id: string): Promise<CheckpointMeta> => {
  const meta = JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8')) as
    | CheckpointMeta
    | undefined;
  if (!meta || meta.version !== 1) throw new Error('Checkpoint metadata is unreadable');
  return meta;
};

const readManifest = async (directory: string, id: string): Promise<CheckpointManifest> => {
  const raw = gunzipSync(await readFile(path.join(directory, `${id}.manifest.json.gz`)));
  const manifest = JSON.parse(raw.toString('utf8')) as CheckpointManifest | undefined;
  if (!manifest || manifest.version !== 1) throw new Error('Checkpoint manifest is unreadable');
  return manifest;
};
