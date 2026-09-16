import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ensureWorkspace } from './files.js';
import { ProjectLiveChanges } from './project-live-changes.js';
import { ProjectVersionFiles, durableJson, type VersionTree } from './project-version-files.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'live-changes-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const workspaceId = randomUUID(),
    taskId = randomUUID();
  const root = path.join(directory, workspaceId),
    state = path.join(directory, 'state');
  await ensureWorkspace(root);
  const versions = new ProjectVersionFiles(path.join(state, 'content'));
  const baseline: VersionTree = {};
  let revision: string | null = null;
  const save = () =>
    durableJson(path.join(state, 'baselines', `${workspaceId}.json`), {
      revision,
      files: baseline
    });
  await save();
  let clock = Date.now();
  const monitor = new ProjectLiveChanges(30_000, () => clock);
  cleanup.push(() => monitor.close());
  const put = async (relative: string, body: string) => {
    await mkdir(path.dirname(path.join(root, 'workspace', relative)), { recursive: true });
    await writeFile(path.join(root, 'workspace', relative), body);
  };
  const base = async (relative: string, body: string) => {
    baseline[relative] = await versions.put(Buffer.from(body));
    await put(relative, body);
    await save();
  };
  const measure = async () => {
    clock += 30_001;
    let value = monitor.request(root, state, taskId);
    expect(['queued', 'measuring']).toContain(value.status);
    await expect
      .poll(() => {
        value = monitor.request(root, state, taskId);
        return value.status;
      })
      .toBe('ready');
    expect(value.measurement).not.toBeNull();
    return value.measurement!;
  };
  return {
    directory,
    root,
    state,
    taskId,
    monitor,
    put,
    base,
    baseline,
    measure,
    save,
    published: async () => {
      revision = randomUUID();
      await save();
      return revision;
    }
  };
}

it('measures additions, deletions and replacements before any prepared update exists', async () => {
  const f = await fixture();
  await f.base('script.py', 'one\ntwo\nthree\n');
  await f.base('old.R', 'old\nlast without newline');
  await f.base('unchanged.txt', 'unchanged\n');
  await f.put('script.py', 'one\nreplacement\nthree\nextra\n');
  await f.put('nested/new.ts', 'first\nsecond');
  await rm(path.join(f.root, 'workspace/old.R'));
  expect(await f.measure()).toMatchObject({
    added: 4,
    removed: 3,
    changedFiles: 3,
    unmeasuredFiles: 0,
    scannedFiles: 4,
    truncated: false
  });
  expect((await readdir(f.state)).sort()).toEqual(['baselines', 'content']);
});

it('refreshes counts after atomic saves and after the conversation baseline advances', async () => {
  const f = await fixture();
  await f.base('code.ts', 'const n = 1;\n');
  await f.put('code.ts', 'const n = 2;\n');
  expect(await f.measure()).toMatchObject({ added: 1, removed: 1 });
  await f.put('replacement', 'const n = 2;\nconst m = 3;\n');
  await rename(path.join(f.root, 'workspace/replacement'), path.join(f.root, 'workspace/code.ts'));
  expect(await f.measure()).toMatchObject({ added: 2, removed: 1, changedFiles: 1 });
  await f.base('code.ts', 'const n = 2;\nconst m = 3;\n');
  const revision = await f.published();
  expect(await f.measure()).toMatchObject({
    added: 0,
    removed: 0,
    changedFiles: 0,
    baselineRevision: revision
  });
  await chmod(path.join(f.root, 'workspace/code.ts'), 0o700);
  expect(await f.measure()).toMatchObject({ added: 0, removed: 0, changedFiles: 1 });
});

it('reports unmeasured data without reading large files or following links and excludes environments', async () => {
  const f = await fixture();
  await f.put('code.py', 'print(1)\n');
  await f.put('image.bin', '\0binary');
  await f.put('.env', 'TOKEN=not-a-source-file\n');
  await f.put('node_modules/package/code.js', 'excluded\n');
  await f.put('nested/.venv/code.py', 'excluded\n');
  const large = await open(path.join(f.root, 'workspace/data.bam'), 'w');
  await large.truncate(20 * 1024 * 1024 * 1024);
  await large.close();
  await writeFile(path.join(f.directory, 'outside'), 'must not be included\n');
  await symlink(path.join(f.directory, 'outside'), path.join(f.root, 'workspace/link'));
  expect(await f.measure()).toMatchObject({
    added: 1,
    removed: 0,
    changedFiles: 3,
    unmeasuredFiles: 3,
    scannedFiles: 4
  });
  await expect(readdir(path.join(f.state, 'content'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps measurements separate even when conversations edit the same filename', async () => {
  const a = await fixture(),
    b = await fixture();
  await a.put('analysis.R', 'a\nb\n');
  await b.put('analysis.R', 'c\n');
  const [left, right] = await Promise.all([a.measure(), b.measure()]);
  expect(left.added).toBe(2);
  expect(right.added).toBe(1);
});

it('reports an unavailable workspace without inventing deleted-file counts', async () => {
  const f = await fixture();
  await f.base('keep.py', 'keep\n');
  await rm(path.join(f.root, 'workspace'), { recursive: true });
  f.monitor.request(f.root, f.state, f.taskId);
  await expect.poll(() => f.monitor.request(f.root, f.state, f.taskId).status).toBe('unavailable');
  expect(f.monitor.request(f.root, f.state, f.taskId).measurement).toBeNull();
});
