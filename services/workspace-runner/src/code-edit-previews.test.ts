import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Files from './files.js';
let writes = 0;
let failWrite = 0;
vi.mock('./files.js', async (original) => {
  const real = await original<typeof Files>();
  return {
    ...real,
    writeWorkspaceFile: async (...args: Parameters<typeof real.writeWorkspaceFile>) => {
      if (++writes === failWrite) throw new Error('Injected write failure');
      return real.writeWorkspaceFile(...args);
    }
  };
});
import { ensureWorkspace } from './files.js';
import { applyCodeEditPreview, saveCodeEditPreview } from './code-edit-previews.js';

const roots: string[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(async () => {
  writes = failWrite = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'code-preview-'));
  roots.push(root);
  await ensureWorkspace(root);
  const paths = ['workspace/a.ts', 'workspace/b.ts'];
  for (const file of paths) await writeFile(path.join(root, file), 'const old = 1;\n');
  const project = path.join(root, 'workspace');
  const id = await saveCodeEditPreview(
    root,
    'task',
    project,
    paths.map((file) => ({
      path: file,
      sha256: hash('const old = 1;\n'),
      content: 'const renamed = 1;\n'
    }))
  );
  return {
    root,
    paths,
    project,
    id,
    apply: () => applyCodeEditPreview(root, 'task', project, id, paths)
  };
}

describe('checked native code edits', () => {
  it('applies the exact preview once and retains compact receipts after a lost response', async () => {
    const f = await fixture();
    const first = await f.apply();
    expect(first.applied).toBe(true);
    expect(first.files).toHaveLength(2);
    expect(first.files.every((file) => file.status === 'applied')).toBe(true);
    expect(await f.apply()).toEqual(first);
    expect(writes).toBe(2);
    for (const file of f.paths)
      expect(await readFile(path.join(f.root, file), 'utf8')).toBe('const renamed = 1;\n');
    const persisted = await readFile(
      path.join(f.root, '.athanor/code-edits', f.id + '.json'),
      'utf8'
    );
    expect(persisted).not.toContain('const renamed');
  });
  it('checks every file before writing and preserves an owner edit', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, f.paths[1]!), 'owner edit\n');
    const result = await f.apply();
    expect(result.applied).toBe(false);
    expect(writes).toBe(0);
    expect(await readFile(path.join(f.root, f.paths[0]!), 'utf8')).toBe('const old = 1;\n');
    expect(await readFile(path.join(f.root, f.paths[1]!), 'utf8')).toBe('owner edit\n');
  });
  it('retains a landed file when the next write fails and never silently retries', async () => {
    const f = await fixture();
    failWrite = 2;
    const result = await f.apply();
    expect(result.files.map((file) => file.status)).toEqual(['applied', 'failed']);
    expect(await f.apply()).toEqual(result);
    expect(writes).toBe(2);
  });
  it('reconciles a crash after a write from the durable intent', async () => {
    const f = await fixture();
    const file = path.join(f.root, '.athanor/code-edits', f.id + '.json');
    const record = JSON.parse(await readFile(file, 'utf8')) as {
      state: string;
      files: Array<{ status: string }>;
    };
    record.state = 'applying';
    record.files[0]!.status = 'intent';
    await writeFile(file, JSON.stringify(record));
    await writeFile(path.join(f.root, f.paths[0]!), 'const renamed = 1;\n');
    const result = await f.apply();
    expect(result.applied).toBe(true);
    expect(writes).toBe(1);
  });
  it('binds the preview to its owner, root and approval-visible paths', async () => {
    const f = await fixture();
    await expect(applyCodeEditPreview(f.root, 'other', f.project, f.id, f.paths)).rejects.toThrow(
      'different task'
    );
    await expect(
      applyCodeEditPreview(f.root, 'task', f.project + '/elsewhere', f.id, f.paths)
    ).rejects.toThrow('different task');
    await expect(
      applyCodeEditPreview(f.root, 'task', f.project, f.id, [f.paths[0]!])
    ).rejects.toThrow('Approved paths');
    expect(writes).toBe(0);
  });
});
