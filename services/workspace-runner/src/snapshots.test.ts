import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createSnapshot,
  deleteSnapshot,
  restoreSnapshot,
  snapshotReserveBytes
} from './snapshots.js';

const temporary: string[] = [];
const originalReserve = process.env.GARDEN_SNAPSHOT_RESERVE_BYTES;
beforeAll(() => {
  process.env.GARDEN_SNAPSHOT_RESERVE_BYTES = String(64 * 1024 ** 2);
});
afterAll(() => {
  if (originalReserve === undefined) delete process.env.GARDEN_SNAPSHOT_RESERVE_BYTES;
  else process.env.GARDEN_SNAPSHOT_RESERVE_BYTES = originalReserve;
});
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('native recovery points', () => {
  it('keeps the production reserve default and validates administrator overrides', () => {
    expect(snapshotReserveBytes(500 * 1024 ** 3, '')).toBe(10 * 1024 ** 3);
    expect(snapshotReserveBytes(500 * 1024 ** 3, String(128 * 1024 ** 2))).toBe(128 * 1024 ** 2);
    expect(() => snapshotReserveBytes(500 * 1024 ** 3, '0')).toThrow('must be between');
    expect(() => snapshotReserveBytes(500 * 1024 ** 3, '1GB')).toThrow('whole number');
  });

  it('creates, restores, and deletes a real bounded archive', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-snapshots-'));
    temporary.push(workspaceRoot);
    const workspaceId = '018f3dd3-899f-7e3d-8d92-8fdbf65f8301';
    const snapshotId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bed';
    const root = path.join(workspaceRoot, workspaceId);
    await Promise.all(
      ['workspace', '.garden/browser', '.garden/artifacts'].map((relative) =>
        mkdir(path.join(root, relative), { recursive: true })
      )
    );
    await writeFile(path.join(root, 'workspace', 'analysis.txt'), 'known good\n');
    await writeFile(path.join(root, '.garden', 'browser', 'state.json'), '{"session":1}\n');

    const created = await createSnapshot({
      snapshotExecutable: path.resolve('../../scripts/garden-snapshot'),
      workspaceRoot,
      root,
      workspaceId,
      snapshotId
    });
    expect(created.sizeBytes).toBeGreaterThan(0);
    await writeFile(path.join(root, 'workspace', 'analysis.txt'), 'broken\n');
    await writeFile(path.join(root, 'workspace', 'new.txt'), 'remove me\n');

    await restoreSnapshot({
      snapshotExecutable: path.resolve('../../scripts/garden-snapshot'),
      workspaceRoot,
      root,
      workspaceId,
      snapshotId
    });
    await expect(readFile(path.join(root, 'workspace', 'analysis.txt'), 'utf8')).resolves.toBe(
      'known good\n'
    );
    await expect(access(path.join(root, 'workspace', 'new.txt'))).rejects.toThrow();

    await deleteSnapshot({ workspaceRoot, workspaceId, snapshotId });
    await expect(
      access(path.join(workspaceRoot, '.garden-snapshots', workspaceId, `${snapshotId}.tar.gz`))
    ).rejects.toThrow();
  });

  it('rejects path-shaped identifiers before touching disk', async () => {
    await expect(
      deleteSnapshot({
        workspaceRoot: tmpdir(),
        workspaceId: '../outside',
        snapshotId: '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bed'
      })
    ).rejects.toThrow('Invalid workspace ID');
  });

  it('refuses a recovery point when a protected top-level directory is a symlink', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-snapshots-'));
    temporary.push(workspaceRoot);
    const workspaceId = '018f3dd3-899f-7e3d-8d92-8fdbf65f8301';
    const snapshotId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bed';
    const root = path.join(workspaceRoot, workspaceId);
    await mkdir(path.join(root, '.garden', 'browser'), { recursive: true });
    await mkdir(path.join(root, '.garden', 'artifacts'), { recursive: true });
    await symlink(tmpdir(), path.join(root, 'workspace'));

    await expect(
      createSnapshot({
        snapshotExecutable: path.resolve('../../scripts/garden-snapshot'),
        workspaceRoot,
        root,
        workspaceId,
        snapshotId
      })
    ).rejects.toThrow('must be a real directory');
  });

  it('refuses links that would leave the recovered computer state', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-snapshots-'));
    temporary.push(workspaceRoot);
    const workspaceId = '018f3dd3-899f-7e3d-8d92-8fdbf65f8301';
    const snapshotId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bed';
    const root = path.join(workspaceRoot, workspaceId);
    await Promise.all(
      ['workspace', '.garden/browser', '.garden/artifacts'].map((relative) =>
        mkdir(path.join(root, relative), { recursive: true })
      )
    );
    await symlink(tmpdir(), path.join(root, 'workspace', 'escape'));

    await expect(
      createSnapshot({
        snapshotExecutable: path.resolve('../../scripts/garden-snapshot'),
        workspaceRoot,
        root,
        workspaceId,
        snapshotId
      })
    ).rejects.toThrow('archive contains an absolute link');
  });
});
