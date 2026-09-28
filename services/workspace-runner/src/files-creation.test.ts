import type * as FileSystem from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceFile, createWorkspaceFolder } from './files.js';

const hooks = vi.hoisted(() => ({
  open: null as ((filename: string) => Promise<void>) | null,
  mkdir: null as ((filename: string) => Promise<void>) | null
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (typeof args[0] === 'string') await hooks.open?.(args[0]);
      return fs.open(...args);
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      if (typeof args[0] === 'string') await hooks.mkdir?.(args[0]);
      return fs.mkdir(...args);
    }
  };
});

// The deployment kernel provides directory-relative traversal through /proc/self/fd.
describe.skipIf(process.platform !== 'linux')('creation under a held workspace directory', () => {
  let root: string;
  let outside: string;
  let parent: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-creation-root-'));
    outside = await mkdtemp(path.join(tmpdir(), 'garden-creation-outside-'));
    parent = path.join(root, 'workspace', 'exports');
    await mkdir(parent, { recursive: true });
  });
  afterEach(async () => {
    hooks.open = null;
    hooks.mkdir = null;
    await Promise.all(
      [root, outside].map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });
  const swapParent = async () => {
    await rename(parent, `${parent}-held`);
    await symlink(outside, parent);
  };

  it('does not create an outside file when an ancestor swaps immediately before O_CREAT', async () => {
    let swapped = false;
    hooks.open = async (filename) => {
      if (path.basename(filename) !== 'report.txt') return;
      hooks.open = null;
      swapped = true;
      await swapParent();
    };
    const [result] = await Promise.allSettled([
      createWorkspaceFile(root, 'workspace/exports/report.txt', Buffer.from('report'), 100)
    ]);
    expect(swapped).toBe(true);
    expect({ status: result.status, outsideEntries: await readdir(outside) }).toEqual({
      status: 'rejected',
      outsideEntries: []
    });
  });

  it.each(['file', 'folder'] as const)(
    'does not create outside parent folders when recursive %s creation races an ancestor swap',
    async (kind) => {
      let swapped = false;
      hooks.mkdir = async (filename) => {
        if (!['reports', 'nested'].includes(path.basename(filename))) return;
        hooks.mkdir = null;
        swapped = true;
        await swapParent();
      };
      const [result] = await Promise.allSettled([
        kind === 'file'
          ? createWorkspaceFile(
              root,
              'workspace/exports/reports/nested/report.txt',
              Buffer.from('report'),
              100
            )
          : createWorkspaceFolder(root, 'workspace/exports/reports/nested')
      ]);
      expect(swapped).toBe(true);
      expect({ status: result.status, outsideEntries: await readdir(outside) }).toEqual({
        status: 'rejected',
        outsideEntries: []
      });
    }
  );
});
