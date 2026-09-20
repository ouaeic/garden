import { cp, mkdtemp, rm, readFile, readdir, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalHistory } from './terminal-history.js';
const roots: string[] = [];
const schema = z.object({ status: z.literal('done'), output: z.string() });
const value = (output: string) => ({ status: 'done' as const, output });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-history-'));
  roots.push(root);
  const directory = path.join(root, 'history');
  return { root, directory, archive: new TerminalHistory(directory, schema) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('immutable terminal history', () => {
  it('pages a stable scoped history while new records arrive, with no duplicate identities after reopening', async () => {
    const { directory, archive } = await fixture();
    await Promise.all(
      Array.from({ length: 137 }, (_, id) =>
        archive.put(`job-${id}`, id % 2 ? 'one' : 'two', value(String(id)))
      )
    );
    const first = await archive.page(['one'], { limit: 7 });
    expect(first.entries).toHaveLength(7);
    expect(first.nextCursor).not.toBeNull();
    await archive.put('newest', 'one', value('newest'));
    const restored = new TerminalHistory(directory, schema);
    const outputs = first.entries.map((entry) => entry.value.output);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await restored.page(['one'], { limit: 7, cursor });
      outputs.push(...page.entries.map((entry) => entry.value.output));
      cursor = page.nextCursor;
    }
    expect(outputs).toEqual(Array.from({ length: 68 }, (_, index) => String(135 - index * 2)));
    await restored.put('job-1', 'one', value('1'));
    expect(await restored.get('job-1', 'one')).toEqual(value('1'));
    expect(await restored.get('job-1', 'two')).toBeUndefined();
    await expect(restored.put('job-1', 'one', value('changed'))).rejects.toThrow('different data');
    await expect(restored.page(null, { cursor: '../../secret' })).rejects.toThrow();
    expect((await restored.page(['absent'])).entries).toEqual([]);
  });
  it('ignores unfinished temporary files and fails visibly on corrupt published records', async () => {
    const { directory, archive } = await fixture();
    await archive.put('job', 'owner', value('result'));
    const [shard] = await readdir(directory);
    expect(shard).toBeTruthy();
    const folder = path.join(directory, shard!);
    const [filename] = await readdir(folder);
    expect(filename).toBeTruthy();
    await writeFile(path.join(folder, 'unfinished.tmp'), '{');
    expect((await archive.page(null)).entries).toHaveLength(1);
    const saved = await readFile(path.join(folder, filename!), 'utf8');
    await writeFile(path.join(folder, filename!), '{');
    await expect(archive.page(null)).rejects.toThrow();
    await expect(archive.get('job', null)).rejects.toThrow();
    await expect(archive.put('job', 'owner', value('result'))).rejects.toThrow();
    await writeFile(path.join(folder, filename!), saved);
    expect(await archive.get('job', null)).toEqual(value('result'));
  });
  it('does not follow directory or record symlinks or overwrite an existing receipt on failure', async () => {
    const { root, directory, archive } = await fixture();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, directory);
    await expect(archive.put('job', 'owner', value('secret'))).rejects.toThrow('symlink');
    expect(await readdir(outside)).toEqual([]);
    await rm(directory);
    await archive.put('job', 'owner', value('receipt'));
    const [shard] = await readdir(directory);
    const [filename] = await readdir(path.join(directory, shard!));
    const record = path.join(directory, shard!, filename!);
    await rm(record);
    await writeFile(path.join(outside, 'record'), 'secret');
    await symlink(path.join(outside, 'record'), record);
    await expect(archive.get('job', null)).rejects.toThrow('invalid entry');
    expect(await readFile(path.join(outside, 'record'), 'utf8')).toBe('secret');
  });
  it('restores a filesystem copy using only published immutable records', async () => {
    const { root, directory, archive } = await fixture();
    await archive.put('analysis-one', 'owner', value('finished output'));
    await archive.put('analysis-two', 'owner', value('another result'));
    const backup = path.join(root, 'backup');
    await cp(directory, backup, { recursive: true });
    await archive.put('after-copy', 'owner', value('new result'));
    const restored = new TerminalHistory(backup, schema);
    expect((await restored.page(null)).entries.map((entry) => entry.value.output)).toEqual([
      'another result',
      'finished output'
    ]);
    expect(await restored.get('analysis-one', 'owner')).toEqual(value('finished output'));
    expect(await restored.get('after-copy', 'owner')).toBeUndefined();
  });
});
