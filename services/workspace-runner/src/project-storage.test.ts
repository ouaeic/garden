import {
  mkdtemp,
  mkdir,
  link,
  lstat,
  open,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProjectStorageUsage } from '@garden/contracts';
import { scanProjectStorage } from './project-storage.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-storage-'));
  roots.push(root);
  const directory = path.join(root, 'history');
  await mkdir(directory);
  return { root, directory };
};

it('counts shared hard links once in allocation and preserves every stored byte', async () => {
  const { root, directory } = await fixture();
  const file = path.join(directory, 'content');
  await writeFile(file, Buffer.alloc(8192, 7));
  await mkdir(path.join(directory, 'version'));
  await link(file, path.join(directory, 'version', 'result'));
  const before = await lstat(file, { bigint: true });
  const usage = ProjectStorageUsage.parse(await scanProjectStorage(root, directory));
  expect(usage).toMatchObject({
    complete: true,
    fileReferences: 2,
    uniqueFiles: 1,
    sharedCopies: 1,
    logicalBytes: 16384,
    allocatedBytes: Number(before.blocks * 512n),
    reclaimableBytes: null
  });
  expect(usage.scannedEntries).toBe(3);
  expect((await lstat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  expect(await readFile(path.join(directory, 'version', 'result'))).toEqual(Buffer.alloc(8192, 7));
});

it('uses allocated blocks for sparse files and does not infer reclaimable capacity from a link', async () => {
  const { root, directory } = await fixture();
  const file = path.join(directory, 'sparse');
  const handle = await open(file, 'w');
  try {
    await handle.truncate(32 * 1024 * 1024);
  } finally {
    await handle.close();
  }
  await link(file, path.join(root, 'live-job-input'));
  const info = await lstat(file, { bigint: true });
  const usage = await scanProjectStorage(root, directory);
  expect(usage.logicalBytes).toBe(32 * 1024 * 1024);
  expect(usage.allocatedBytes).toBe(Number(info.blocks * 512n));
  expect(usage.fileReferences).toBe(1);
  expect(usage.reclaimableBytes).toBeNull();
  expect((await lstat(path.join(root, 'live-job-input'))).size).toBe(usage.logicalBytes);
});

it('never traverses symlinks and reports skipped content instead of an exact total', async () => {
  const { root, directory } = await fixture();
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private'), Buffer.alloc(10000));
  await symlink(outside, path.join(directory, 'redirected-directory'));
  await symlink(path.join(outside, 'private'), path.join(directory, 'redirected-file'));
  await writeFile(path.join(directory, 'own'), 'ours');
  const usage = await scanProjectStorage(root, directory);
  expect(usage).toMatchObject({
    complete: false,
    skippedEntries: 2,
    fileReferences: 1,
    logicalBytes: 4
  });
  await expect(
    scanProjectStorage(root, path.join(directory, 'redirected-directory'))
  ).rejects.toThrow();
});

it('bounds broad and deep walks and labels partial measurements', async () => {
  const { root, directory } = await fixture();
  await mkdir(path.join(directory, 'a', 'b'), { recursive: true });
  await writeFile(path.join(directory, 'a', 'b', 'value'), 'unvisited');
  const depth = await scanProjectStorage(root, directory, {
    entries: 100,
    milliseconds: 10000,
    depth: 0
  });
  expect(depth).toMatchObject({ complete: false, limited: true, logicalBytes: 0 });
  const broad = await scanProjectStorage(root, directory, {
    entries: 1,
    milliseconds: 10000,
    depth: 64
  });
  expect(broad).toMatchObject({ complete: false, limited: true, scannedEntries: 1 });
  const timed = await scanProjectStorage(root, directory, {
    entries: 100,
    milliseconds: 0,
    depth: 64
  });
  expect(timed).toMatchObject({ complete: false, limited: true, scannedEntries: 0 });
});
