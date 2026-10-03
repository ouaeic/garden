import type * as fsPromises from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CheckpointRefusedError,
  WorkspaceCheckpoints,
  parseInstalledPackages,
  type CheckpointConfig,
  type CheckpointRunner
} from './checkpoints.js';

/**
 * The one seam this file needs that the module does not otherwise offer: a way to change a file
 * *between* the walk that stats it and the pass that hashes it.
 *
 * A checkpoint create deliberately does not stop the workspace, so that window is real on any box
 * running a watch build - but it is hundreds of milliseconds wide and nothing about it is
 * deterministic, so reproducing it by timing would be a test that fails one run in fifty and
 * proves nothing on the other forty-nine. Module-level rather than hoisted, following
 * `desktop-perform.test.ts`: the factory only dereferences it when an lstat actually happens,
 * which is inside a test and long after this module has evaluated.
 */
const midScan: {
  /** The workspace-relative path whose stat is the trigger, or null for the pass-through. */
  path: string | null;
  /** Runs once, after the walk has stat'd that path and before anything else can read it. */
  write: (() => Promise<void>) | null;
} = { path: null, write: null };

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    lstat: async (target: string) => {
      const details = await actual.lstat(target);
      const write = midScan.path && target.endsWith(midScan.path) ? midScan.write : null;
      if (write) {
        midScan.path = null;
        midScan.write = null;
        await write();
      }
      return details;
    }
  };
});

const temporary: string[] = [];
afterEach(async () => {
  midScan.path = null;
  midScan.write = null;
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const WORKSPACE_ID = '018f3dd3-899f-7e3d-8d92-8fdbf65f8301';

const workspace = async (): Promise<{ workspaceRoot: string; root: string }> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-checkpoints-'));
  temporary.push(workspaceRoot);
  const root = path.join(workspaceRoot, WORKSPACE_ID);
  for (const relative of ['workspace', '.garden/artifacts', '.garden/browser'])
    await mkdir(path.join(root, relative), { recursive: true });
  return { workspaceRoot, root };
};

/**
 * A host with room on it, stated rather than measured.
 *
 * The floor is `min(20 GiB, max(2 GiB, total x 0.02))`, so on a nearly full laptop the refusal
 * fires and the failure reads exactly like broken code. A build whose result depends on the free
 * space of the machine running it cannot be trusted in either direction, so the probe is injected
 * here and the number below is the only disk these tests ever see.
 */
const ROOMY_HOST = async () => ({
  hostStorageTotalBytes: 100 * 1024 ** 3,
  hostStorageAvailableBytes: 50 * 1024 ** 3
});

/** The refusal a create raised, insisting it is the typed one rather than any old failure. */
const refusalFrom = async (work: Promise<unknown>): Promise<CheckpointRefusedError> => {
  const cause = await work.then(
    () => null,
    (error: unknown) => error
  );
  if (!(cause instanceof CheckpointRefusedError))
    throw new Error(`expected a checkpoint refusal, got ${String(cause)}`);
  return cause;
};

const config = (
  workspaceRoot: string,
  overrides: Partial<CheckpointConfig> = {}
): CheckpointConfig => ({
  workspaceRoot,
  btrfsExecutable: '/nonexistent/btrfs',
  zfsExecutable: '/nonexistent/zfs',
  packageManifestPath: path.join(workspaceRoot, 'dpkg-status'),
  includeBrowserProfile: false,
  retainTurns: 3,
  retainDailyDays: 14,
  maxFiles: 250_000,
  maxFileBytes: 2 * 1024 ** 3,
  hostStorage: ROOMY_HOST,
  ...overrides
});

const storeSize = async (workspaceRoot: string): Promise<number> => {
  let total = 0;
  const pending = [path.join(workspaceRoot, '.garden-checkpoints', WORKSPACE_ID, 'blobs')];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else total += (await stat(child)).size;
    }
  }
  return total;
};

/** What the checkpoint actually wrote down, which is the only thing a restore has to go on. */
const manifestFiles = async (
  workspaceRoot: string,
  id: string
): Promise<Array<[string, number, number, number, string]>> => {
  const raw = gunzipSync(
    await readFile(
      path.join(workspaceRoot, '.garden-checkpoints', WORKSPACE_ID, `${id}.manifest.json.gz`)
    )
  );
  return (
    JSON.parse(raw.toString('utf8')) as {
      files: Array<[string, number, number, number, string]>;
    }
  ).files;
};

const blobPath = (workspaceRoot: string, hash: string): string =>
  path.join(workspaceRoot, '.garden-checkpoints', WORKSPACE_ID, 'blobs', hash.slice(0, 2), hash);

const blobCount = async (workspaceRoot: string): Promise<number> => {
  let count = 0;
  const blobs = path.join(workspaceRoot, '.garden-checkpoints', WORKSPACE_ID, 'blobs');
  for (const shard of await readdir(blobs).catch(() => []))
    count += (await readdir(path.join(blobs, shard))).length;
  return count;
};

describe('turn checkpoints', () => {
  it('previews exactly what a restore would change, then changes exactly that', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, 'workspace', 'report.md'), 'first draft\n');
    await writeFile(path.join(root, 'workspace', 'keep.txt'), 'untouched\n');
    await mkdir(path.join(root, 'workspace', 'src'), { recursive: true });
    await writeFile(path.join(root, 'workspace', 'src', 'old.ts'), 'export const a = 1;\n');

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(created.mechanism).toBe('content');
    expect(created.fileCount).toBe(3);

    await writeFile(path.join(root, 'workspace', 'report.md'), 'rewritten by the agent\n');
    await writeFile(path.join(root, 'workspace', 'stray.log'), 'created by the agent\n');
    await rm(path.join(root, 'workspace', 'src', 'old.ts'));

    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.added.map((change) => change.path)).toEqual(['workspace/stray.log']);
    expect(preview.modified.map((change) => change.path)).toEqual(['workspace/report.md']);
    expect(preview.deleted.map((change) => change.path)).toEqual(['workspace/src/old.ts']);
    expect(preview.modifiedCount).toBe(1);

    const restored = await checkpoints.restore(WORKSPACE_ID, root, created.id);
    expect(restored.restoredFileCount).toBe(2);
    expect(restored.removedFileCount).toBe(1);
    await expect(readFile(path.join(root, 'workspace', 'report.md'), 'utf8')).resolves.toBe(
      'first draft\n'
    );
    await expect(readFile(path.join(root, 'workspace', 'src', 'old.ts'), 'utf8')).resolves.toBe(
      'export const a = 1;\n'
    );
    await expect(readFile(path.join(root, 'workspace', 'keep.txt'), 'utf8')).resolves.toBe(
      'untouched\n'
    );
    await expect(stat(path.join(root, 'workspace', 'stray.log'))).rejects.toThrow();

    // Nothing left to differ, and a checkpoint taken straight after a restore stores no bytes.
    const after = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect([after.addedCount, after.modifiedCount, after.deletedCount]).toEqual([0, 0, 0]);
  });

  it('leaves the browser profile alone, so a rewind does not sign the owner out', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'session=before\n');
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'before\n');
    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });

    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'session=after-login\n');
    await writeFile(path.join(root, '.garden', 'browser', 'Login Data'), 'signed in\n');
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'after\n');

    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.added.concat(preview.modified, preview.deleted).map((c) => c.path)).toEqual([
      'workspace/note.txt'
    ]);

    await checkpoints.restore(WORKSPACE_ID, root, created.id);
    await expect(readFile(path.join(root, '.garden', 'browser', 'Cookies'), 'utf8')).resolves.toBe(
      'session=after-login\n'
    );
    await expect(
      readFile(path.join(root, '.garden', 'browser', 'Login Data'), 'utf8')
    ).resolves.toBe('signed in\n');
    await expect(readFile(path.join(root, 'workspace', 'note.txt'), 'utf8')).resolves.toBe(
      'before\n'
    );
  });

  it('includes the browser profile only when the host is configured to', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(
      config(workspaceRoot, { includeBrowserProfile: true })
    );
    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'session=before\n');
    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'session=after\n');

    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.modified.map((change) => change.path)).toEqual(['.garden/browser/Cookies']);
  });

  it('costs no bytes for an unchanged turn and stores one copy of repeated content', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    const body = randomBytes(256 * 1024);
    await writeFile(path.join(root, 'workspace', 'dataset.bin'), body);

    const first = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(first.changedFileCount).toBe(1);
    expect(first.storedBytes).toBe(body.length);

    const second = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(second.changedFileCount).toBe(0);
    expect(second.storedBytes).toBe(0);

    // A second file with content the store already holds is deduplicated, not copied again.
    await writeFile(path.join(root, 'workspace', 'copy.bin'), body);
    const third = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(third.changedFileCount).toBe(1);
    expect(third.storedBytes).toBe(0);
    expect(await storeSize(workspaceRoot)).toBe(body.length);
  });

  it('records the size and mtime of the bytes it hashed, not of an earlier instant', async () => {
    // The walk stats the tree and a second pass hashes what changed, and between the two the
    // workspace is still running: a checkpoint create does not stop the services, because a turn
    // cannot afford to pause a watch build. If a build rewrote a file in that window and the
    // manifest carried the *old* size and mtime against the *new* content's hash, a restore would
    // write back bytes produced after the moment the owner asked to return to, and set the mtime
    // to the older stamp - so the next checkpoint would see the file as unchanged and the wrong
    // content would be pinned for good.
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    const target = path.join(root, 'workspace', 'app.js');
    await writeFile(target, 'the bytes the walk saw\n');
    const rewritten = 'the bytes the build wrote while the walk was still going\n';
    midScan.path = path.join('workspace', 'app.js');
    midScan.write = () => writeFile(target, rewritten);

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(midScan.write).toBeNull();

    const entry = (await manifestFiles(workspaceRoot, created.id)).find(
      ([relative]) => relative === 'workspace/app.js'
    )!;
    const onDisk = await stat(target);
    expect(entry[2]).toBe(Buffer.byteLength(rewritten));
    expect(entry[3]).toBe(Math.floor(onDisk.mtimeMs));
    expect(entry[4]).toBe(createHash('sha256').update(rewritten).digest('hex'));
    await expect(readFile(blobPath(workspaceRoot, entry[4]), 'utf8')).resolves.toBe(rewritten);
    expect(created.totalBytes).toBe(Buffer.byteLength(rewritten));
    // And the manifest agrees with the tree it was taken from, so the next turn hashes nothing.
    const after = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect([after.addedCount, after.modifiedCount, after.deletedCount]).toEqual([0, 0, 0]);
  });

  it('refuses a restore whose stored content has gone, before it deletes anything', async () => {
    // The blob store can be short an object - a collection that skipped a manifest it could not
    // read, an interrupted delete between the manifest and the metadata. A restore that unlinked
    // everything made since the checkpoint before cloning content back would throw ENOENT into a
    // tree that had already lost the work of the last turn, and the only way back would be a
    // recovery point the owner was never told about. Nothing is destroyed until every blob the
    // restore will read is there.
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, 'workspace', 'report.md'), 'first draft\n');
    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });

    await writeFile(path.join(root, 'workspace', 'report.md'), 'rewritten by the agent\n');
    await writeFile(path.join(root, 'workspace', 'stray.log'), 'an hour of work since\n');
    const [, , , , hash] = (await manifestFiles(workspaceRoot, created.id)).find(
      ([relative]) => relative === 'workspace/report.md'
    )!;
    await rm(blobPath(workspaceRoot, hash));

    await expect(checkpoints.restore(WORKSPACE_ID, root, created.id)).rejects.toThrow(
      'Nothing has been rewound'
    );
    await expect(readFile(path.join(root, 'workspace', 'stray.log'), 'utf8')).resolves.toBe(
      'an hour of work since\n'
    );
    await expect(readFile(path.join(root, 'workspace', 'report.md'), 'utf8')).resolves.toBe(
      'rewritten by the agent\n'
    );
  });

  it('survives a turn whose new files hold identical content, which share one blob', async () => {
    // The copies run in parallel and a blob is named by its content, so duplicates that are new in
    // the same turn all reach for the one destination at once. If they shared a scratch name too,
    // the second writer would delete the first one's finished copy, the first one's rename would
    // fail, and the turn would run with no undo point because the workspace happened to contain
    // two identical files. Sixteen of them, which is the width of the copy pass.
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    const body = randomBytes(64 * 1024);
    for (let index = 0; index < 16; index += 1)
      await writeFile(path.join(root, 'workspace', `copy-${index}.bin`), body);

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(created.changedFileCount).toBe(16);
    expect(await blobCount(workspaceRoot)).toBe(1);
    expect(await storeSize(workspaceRoot)).toBe(body.length);
    // The point of the checkpoint: it can still put the workspace back.
    await rm(path.join(root, 'workspace', 'copy-7.bin'));
    await expect(checkpoints.restore(WORKSPACE_ID, root, created.id)).resolves.toMatchObject({
      restoredFileCount: 1
    });
  });

  it('runs one at a time per workspace, so two concurrent turns cannot tear a checkpoint', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, 'workspace', 'dataset.bin'), randomBytes(128 * 1024));

    // Two tasks can share a workspace. Interleaved, the second would find no manifest to compare
    // against and re-hash the whole tree - and its content collection could delete blobs the first
    // had written but not yet named. Sequenced, the second sees a settled store and hashes nothing.
    const [first, second] = await Promise.all([
      checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID(), turn: 0 }),
      checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID(), turn: 1 })
    ]);
    expect(first.changedFileCount).toBe(1);
    expect(second.changedFileCount).toBe(0);
    expect(await blobCount(workspaceRoot)).toBe(1);
    await expect(checkpoints.restore(WORKSPACE_ID, root, first.id)).resolves.toMatchObject({
      restoredFileCount: 0
    });
  });

  it('names the packages a rewind will not uninstall', async () => {
    const { workspaceRoot, root } = await workspace();
    const status = path.join(workspaceRoot, 'dpkg-status');
    await writeFile(
      status,
      'Package: curl\nStatus: install ok installed\nVersion: 8.5.0\n\nPackage: ripgrep\nStatus: deinstall ok config-files\nVersion: 14.0.0\n\n'
    );
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'before\n');
    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });

    await writeFile(
      status,
      'Package: curl\nStatus: install ok installed\nVersion: 8.6.0\n\nPackage: postgresql\nStatus: install ok installed\nVersion: 16.2\n\n'
    );
    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.packagesInstalled).toEqual([
      { name: 'curl', version: '8.6.0', previousVersion: '8.5.0' },
      { name: 'postgresql', version: '16.2' }
    ]);
    expect(preview.packagesRemoved).toEqual([]);
  });

  it('reads a package database once and reuses it while it is unchanged', () => {
    const packages = parseInstalledPackages(
      'Package: curl\nStatus: install ok installed\nVersion: 8.5.0\n\n' +
        'Package: half-installed\nStatus: install ok half-configured\nVersion: 1.0\n\n' +
        'Package: last\nStatus: install ok installed\nVersion: 2.0'
    );
    expect(packages).toEqual([
      ['curl', '8.5.0'],
      ['last', '2.0']
    ]);
  });

  it('records a file too large to hold instead of pretending it is covered', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot, { maxFileBytes: 1024 }));
    await writeFile(path.join(root, 'workspace', 'disk.img'), randomBytes(4096));
    await writeFile(path.join(root, 'workspace', 'small.txt'), 'covered\n');

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(created.uncoveredFileCount).toBe(1);
    /*
     * And WHICH file, because the count alone cannot be spent. The worker's approval floor frees a
     * delete strictly inside `CHECKPOINT_CONTENT` on the grounds that a rewind puts it back, which
     * is untrue of exactly this file; with only a count it would have to card every delete on the
     * turn, and a workspace built for weights or sequencing reads holds a file like this
     * permanently. `small.txt` is here to be absent from the list.
     */
    expect(created.uncoveredPaths).toEqual(['workspace/disk.img']);
    expect(created.uncoveredPathsTruncated).toBe(false);
    await writeFile(path.join(root, 'workspace', 'disk.img'), randomBytes(4096));

    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.uncovered.map((change) => change.path)).toEqual(['workspace/disk.img']);
    expect(preview.added).toEqual([]);
    expect(preview.modified).toEqual([]);

    const before = await readFile(path.join(root, 'workspace', 'disk.img'));
    await checkpoints.restore(WORKSPACE_ID, root, created.id);
    await expect(readFile(path.join(root, 'workspace', 'disk.img'))).resolves.toEqual(before);
  });

  /*
   * The bound on the list, and the reason it is signalled rather than silently short.
   *
   * Sixty-four paths is 128 GiB of oversize content at the shipped 2 GiB ceiling, more than any
   * workspace on this box has held - but a sparse file is over the ceiling by size and costs no
   * disk at all, so passing it is reachable rather than theoretical. A short list that did not say
   * it was short would tell the worker's floor that a workspace holds sixty-four oversize files
   * when it holds two hundred, and a delete naming the sixty-fifth would be freed by a list that
   * does not mention it. The worker reads the flag as "no list at all" and keeps every card.
   */
  it('says so when there are more uncovered files than it can name', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot, { maxFileBytes: 16 }));
    for (let index = 0; index < 70; index += 1)
      await writeFile(path.join(root, 'workspace', `big-${index}.img`), randomBytes(64));

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });

    expect(created.uncoveredFileCount).toBe(70);
    expect(created.uncoveredPathsTruncated).toBe(true);
    expect(created.uncoveredPaths).toHaveLength(64);
    // Sorted before it is cut, so two checkpoints of an unchanged tree name the same sixty-four
    // rather than whichever the parallel walk reached first.
    expect(created.uncoveredPaths).toEqual([...created.uncoveredPaths].sort());
  });

  it('keeps the recent turns and collects the content nothing names any more', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot, { retainTurns: 2 }));
    const ids: string[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      await writeFile(path.join(root, 'workspace', 'draft.md'), `revision ${turn}\n`);
      const created = await checkpoints.create(WORKSPACE_ID, root, {
        checkpointId: randomUUID(),
        turn
      });
      ids.push(created.id);
      await checkpoints.prune(WORKSPACE_ID);
    }
    const kept = (await checkpoints.list(WORKSPACE_ID)).map((entry) => entry.id);
    expect(kept).toEqual([ids[9], ids[8]]);
    // Ten revisions were written; only what the survivors name is still on disk.
    expect(await blobCount(workspaceRoot)).toBe(2);
  });

  it('leaves blobs alone when a manifest cannot be read, rather than deleting what it cannot see', async () => {
    // The silent loss this locks out: skipping an unreadable manifest says "this checkpoint names
    // no content", and the sweep would then delete every blob only it was holding. Its .json
    // survives, so the checkpoint stays in the list and is still offered - and the owner finds out
    // when the restore they were relying on cannot find its content. Keeping unreferenced blobs
    // costs disk. Deleting referenced ones costs them the undo.
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot, { retainTurns: 2 }));
    const directory = path.join(workspaceRoot, '.garden-checkpoints', WORKSPACE_ID);
    const ids: string[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      await writeFile(path.join(root, 'workspace', 'draft.md'), `revision ${turn}\n`);
      const created = await checkpoints.create(WORKSPACE_ID, root, {
        checkpointId: randomUUID(),
        turn
      });
      ids.push(created.id);
      // Corrupt a survivor's manifest just before the sweep that would collect: not absent, which
      // means an already-incomplete checkpoint, but present and unreadable - a truncated write, a
      // bad read, a half-flushed file.
      if (turn === 9)
        await writeFile(path.join(directory, `${ids[8]!}.manifest.json.gz`), 'not gzip');
      await checkpoints.prune(WORKSPACE_ID);
    }
    // The surviving checkpoint's content is still there. Without the fix the sweep kept only what
    // the one readable manifest named.
    expect(await blobCount(workspaceRoot)).toBeGreaterThan(1);
    // And pruning still did its job rather than failing outright.
    expect((await checkpoints.list(WORKSPACE_ID)).map((entry) => entry.id)).toEqual([
      ids[9],
      ids[8]
    ]);
  });

  it('keeps one checkpoint a day once the recent turns have rolled past', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(
      config(workspaceRoot, { retainTurns: 2, retainDailyDays: 30 })
    );
    const directory = path.join(workspaceRoot, '.garden-checkpoints', WORKSPACE_ID);
    const made: string[] = [];
    const day = 24 * 60 * 60 * 1000;
    for (let index = 0; index < 8; index += 1) {
      await writeFile(path.join(root, 'workspace', 'draft.md'), `revision ${index}\n`);
      const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
      // Two checkpoints a day over the last four days, aged in place: the only way to exercise a
      // rule whose whole point is what happens once a day has passed. Anchored at midday UTC
      // because the rule buckets by UTC date - measured from Date.now(), the second checkpoint of
      // each pair lands in the next bucket whenever the suite runs near a UTC midnight.
      const noon = new Date();
      noon.setUTCHours(12, 0, 0, 0);
      const at = new Date(
        noon.getTime() - (3 - Math.floor(index / 2)) * day + (index % 2) * 60 * 60 * 1000
      ).toISOString();
      const metaPath = path.join(directory, `${created.id}.json`);
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { createdAt: string };
      await writeFile(metaPath, JSON.stringify({ ...meta, createdAt: at }));
      made.push(created.id);
    }
    await checkpoints.prune(WORKSPACE_ID);

    const kept = await checkpoints.list(WORKSPACE_ID);
    // The two most recent, and then the newest of each earlier day.
    expect(kept.map((entry) => entry.id)).toEqual([made[7], made[6], made[5], made[3], made[1]]);
  });

  it('uses a btrfs snapshot when the host proves it can create and delete one', async () => {
    const { workspaceRoot, root } = await workspace();
    const calls: string[][] = [];
    const run: CheckpointRunner = async (executable, args) => {
      calls.push([executable, ...args]);
      if (executable !== '/usr/bin/btrfs') throw new Error('not installed');
      if (args[0] === 'subvolume' && args[1] === 'show') return '';
      if (args[0] === 'subvolume' && args[1] === 'snapshot') {
        await cp(args[3]!, args[4]!, { recursive: true });
        return '';
      }
      if (args[0] === 'subvolume' && args[1] === 'delete') {
        await rm(args[2]!, { recursive: true, force: true });
        return '';
      }
      throw new Error(`unexpected btrfs call ${args.join(' ')}`);
    };
    const checkpoints = new WorkspaceCheckpoints(
      config(workspaceRoot, { btrfsExecutable: '/usr/bin/btrfs' }),
      run
    );
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'before\n');
    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'session=before\n');

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    // Read off the checkpoint that was taken rather than off a probe run for its own sake: this is
    // the mechanism that actually stored these bytes, which is the thing worth asserting.
    expect(created.mechanism).toBe('btrfs');
    // A filesystem snapshot does not walk the tree, which is the whole reason it is instant.
    expect(created.fileCount).toBeNull();
    expect(calls.some((call) => call.includes('snapshot') && call.includes('-r'))).toBe(true);

    await writeFile(path.join(root, 'workspace', 'note.txt'), 'after\n');
    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'session=after\n');
    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    // The snapshot holds the profile too; the exclusion still keeps it out of the rewind.
    expect(preview.modified.map((change) => change.path)).toEqual(['workspace/note.txt']);

    await checkpoints.restore(WORKSPACE_ID, root, created.id);
    await expect(readFile(path.join(root, 'workspace', 'note.txt'), 'utf8')).resolves.toBe(
      'before\n'
    );
    await expect(readFile(path.join(root, '.garden', 'browser', 'Cookies'), 'utf8')).resolves.toBe(
      'session=after\n'
    );
  });

  it('refuses a snapshot mechanism it cannot also delete', async () => {
    const { workspaceRoot, root } = await workspace();
    const run: CheckpointRunner = async (executable, args) => {
      if (executable !== '/usr/bin/btrfs') throw new Error('not installed');
      if (args[0] === 'subvolume' && args[1] === 'show') return '';
      if (args[0] === 'subvolume' && args[1] === 'snapshot') {
        await mkdir(args[4]!, { recursive: true });
        return '';
      }
      // Exactly what a btrfs mounted without user_subvol_rm_allowed does to an unprivileged user.
      throw new Error('ERROR: Could not destroy subvolume: Operation not permitted');
    };
    const checkpoints = new WorkspaceCheckpoints(
      config(workspaceRoot, { btrfsExecutable: '/usr/bin/btrfs' }),
      run
    );
    // Falls all the way through to the content store, which asks nothing of the filesystem.
    expect(
      (await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() })).mechanism
    ).toBe('content');
  });

  it('uses a ZFS snapshot only when the workspace is the dataset itself', async () => {
    const { workspaceRoot, root } = await workspace();
    const higher: CheckpointRunner = async (executable, args) => {
      if (executable !== '/usr/sbin/zfs') throw new Error('not installed');
      if (args[0] === 'list') return `tank/garden\t${workspaceRoot}\n`;
      throw new Error('unexpected');
    };
    expect(
      (
        await new WorkspaceCheckpoints(
          config(workspaceRoot, { zfsExecutable: '/usr/sbin/zfs' }),
          higher
        ).create(WORKSPACE_ID, root, { checkpointId: randomUUID() })
      ).mechanism
    ).toBe('content');

    const exact: CheckpointRunner = async (executable, args) => {
      if (executable !== '/usr/sbin/zfs') throw new Error('not installed');
      if (args[0] === 'list') return `tank/garden/workspace\t${root}\n`;
      if (args[0] === 'snapshot' || args[0] === 'destroy') return '';
      throw new Error('unexpected');
    };
    expect(
      (
        await new WorkspaceCheckpoints(
          config(workspaceRoot, { zfsExecutable: '/usr/sbin/zfs' }),
          exact
        ).create(WORKSPACE_ID, root, { checkpointId: randomUUID() })
      ).mechanism
    ).toBe('zfs');
  });

  it('rejects identifiers and manifest paths that would leave the workspace', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await expect(
      checkpoints.create(WORKSPACE_ID, root, { checkpointId: '../escape' })
    ).rejects.toThrow('Invalid checkpoint ID');
    await expect(checkpoints.list('../outside')).rejects.toThrow('Invalid workspace ID');

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    const manifest = path.join(
      workspaceRoot,
      '.garden-checkpoints',
      WORKSPACE_ID,
      `${created.id}.manifest.json.gz`
    );
    await writeFile(
      manifest,
      gzipSync(
        Buffer.from(
          JSON.stringify({
            version: 1,
            files: [['../../../etc/passwd', 0o644, 3, 1, 'a'.repeat(64)]],
            directories: [],
            links: [],
            uncovered: []
          })
        )
      )
    );
    await expect(checkpoints.restore(WORKSPACE_ID, root, created.id)).rejects.toThrow(
      'workspace-relative'
    );
  });

  /**
   * The disk floor, exercised without filling a disk - and the pair of refusals said in a way
   * something other than a person can read.
   *
   * `apps/worker/src/agent.ts ownerFixableCheckpointFailure` decides whether a turn that lost its
   * undo point says so in the conversation or only in the work log. It keys on these codes rather
   * than the runner's prose, because a pattern over the prose can match one refusal and miss the
   * other - and a workspace over the file ceiling (two `node_modules` trees is enough) would then
   * lose every automatic checkpoint silently. This is the end of the wire that produces the codes;
   * `agent-run.test.ts` holds the other end.
   *
   * The ceiling is reached with `maxFiles: 2` rather than by writing a thousand files. A thousand
   * writes to a temporary directory to prove a comparison bought nothing but seconds on every run,
   * and the comparison does not know how large the number is.
   */
  it('refuses on a full host and on an oversized tree, each with a code a program can read', async () => {
    const { workspaceRoot, root } = await workspace();
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'content\n');

    const full = new WorkspaceCheckpoints(
      config(workspaceRoot, {
        hostStorage: async () => ({
          hostStorageTotalBytes: 100 * 1024 ** 3,
          hostStorageAvailableBytes: 1024 ** 3
        })
      })
    );
    const starved = await refusalFrom(
      full.create(WORKSPACE_ID, root, { checkpointId: randomUUID() })
    );
    expect(starved.code).toBe('checkpoint_host_disk_full');
    expect(starved.message).toContain('too full');

    const crowded = new WorkspaceCheckpoints(config(workspaceRoot, { maxFiles: 2 }));
    for (const name of ['a.js', 'b.js', 'c.js'])
      await writeFile(path.join(root, 'workspace', name), 'x');
    const oversized = await refusalFrom(
      crowded.create(WORKSPACE_ID, root, { checkpointId: randomUUID() })
    );
    expect(oversized.code).toBe('checkpoint_workspace_too_large');
    expect(oversized.message).toContain('more than 2 files');

    // And the same tree, on the same host, with the ceiling where it ships: no refusal at all.
    const ordinary = new WorkspaceCheckpoints(config(workspaceRoot));
    expect(
      (await ordinary.create(WORKSPACE_ID, root, { checkpointId: randomUUID() })).mechanism
    ).toBe('content');
  });

  /**
   * The ceiling bounds taking a checkpoint. It must not bound using one. (#136)
   *
   * The file count is a bound on the cost of the walk, and the walk is what taking a checkpoint
   * does. Preview and restore walked the tree with the same limit, so the moment a workspace grew
   * past the ceiling every checkpoint it already held - every one of them taken under the ceiling,
   * complete, and perfectly restorable - became unreachable. That is the exact turn an owner wants
   * to rewind: something unpacked a dependency tree into the workspace, and the way back out is the
   * checkpoint from before it did. Refusing the restore left them holding the remedy and told them
   * to apply it by hand first.
   */
  it('restores a checkpoint into a workspace that has since crossed the file ceiling', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot, { maxFiles: 2 }));
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'the good version\n');
    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });

    // What an install does: the tree is now over the ceiling, and the note is wrong as well.
    await mkdir(path.join(root, 'workspace', 'node_modules'), { recursive: true });
    for (const name of ['a.js', 'b.js', 'c.js'])
      await writeFile(path.join(root, 'workspace', 'node_modules', name), 'x');
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'the bad version\n');

    // Taking a new one is still refused, which is the ceiling doing its job.
    expect(
      (await refusalFrom(checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() })))
        .code
    ).toBe('checkpoint_workspace_too_large');

    // Using the one already taken is not.
    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.addedCount).toBe(3);
    const restored = await checkpoints.restore(WORKSPACE_ID, root, created.id);
    expect(restored.removedFileCount).toBe(3);
    await expect(readFile(path.join(root, 'workspace', 'note.txt'), 'utf8')).resolves.toBe(
      'the good version\n'
    );
    await expect(stat(path.join(root, 'workspace', 'node_modules', 'a.js'))).rejects.toThrow();
  });

  it('forgets a workspace completely when it is deleted', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'content\n');
    await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    await checkpoints.deleteAll(WORKSPACE_ID);
    expect(await checkpoints.list(WORKSPACE_ID)).toEqual([]);
    await expect(
      stat(path.join(workspaceRoot, '.garden-checkpoints', WORKSPACE_ID))
    ).rejects.toThrow();
  });
});
