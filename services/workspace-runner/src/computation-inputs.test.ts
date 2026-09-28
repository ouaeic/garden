import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  truncate,
  open,
  appendFile
} from 'node:fs/promises';
import type * as Filesystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof Filesystem>();
  return { ...original, open: vi.fn(original.open) };
});
import { computationInputs } from './computation-inputs.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'garden-input-record-'));
  await mkdir(path.join(root, 'workspace'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('bounded computation input records', () => {
  it('hashes exact binary bytes, includes empty files and deduplicates normalized paths', async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 4]);
    await writeFile(path.join(root, 'workspace/data.bin'), bytes);
    await writeFile(path.join(root, 'workspace/empty.csv'), '');
    const rows = await computationInputs(root, ['data.bin', 'workspace/data.bin', 'empty.csv']);
    expect(rows).toEqual([
      {
        path: 'workspace/data.bin',
        status: 'hashed',
        bytes: 5,
        sha256: createHash('sha256').update(bytes).digest('hex')
      },
      {
        path: 'workspace/empty.csv',
        status: 'hashed',
        bytes: 0,
        sha256: createHash('sha256').update('').digest('hex')
      }
    ]);
  });
  it('does not read protected state, escaping paths, symbolic links, directories or missing files', async () => {
    await mkdir(path.join(root, '.garden'));
    await writeFile(path.join(root, '.garden/canary'), 'PROTECTED_INPUT_CANARY');
    await symlink('../.garden', path.join(root, 'workspace/linked'));
    await symlink('../.garden/canary', path.join(root, 'workspace/link'));
    const rows = await computationInputs(root, [
      '.garden/canary',
      '../outside',
      'linked/canary',
      'link',
      'workspace',
      'missing.csv'
    ]);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.status === 'unavailable' && row.reason === 'not_readable')).toBe(
      true
    );
    expect(JSON.stringify(rows)).not.toContain(
      createHash('sha256').update('PROTECTED_INPUT_CANARY').digest('hex')
    );
  });
  it('reports oversized inputs without blocking an otherwise readable input', async () => {
    await writeFile(path.join(root, 'workspace/large'), '');
    await truncate(path.join(root, 'workspace/large'), 17 * 1024 * 1024);
    await writeFile(path.join(root, 'workspace/small'), '7');
    const rows = await computationInputs(root, ['large', 'small']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'unavailable', reason: 'too_large' });
    expect(rows[1]).toMatchObject({ status: 'hashed', bytes: 1 });
  });
  it('refuses a file that grows after its size check instead of reporting a prefix hash', async () => {
    const target = path.join(root, 'workspace/changing');
    await writeFile(target, Buffer.alloc(128 * 1024, 7));
    const original = await vi.importActual<typeof Filesystem>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args);
      const read = handle.read.bind(handle);
      let changed = false;
      handle.read = (async (
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number
      ) => {
        const result = await read(buffer, offset, length, position);
        if (!changed) {
          changed = true;
          await appendFile(target, 'extra bytes');
        }
        return result;
      }) as typeof handle.read;
      return handle;
    });
    expect(await computationInputs(root, ['changing'])).toEqual([
      { path: 'workspace/changing', status: 'unavailable', reason: 'changed_during_read' }
    ]);
  });
  it('bounds total hashing independently of the per-file limit', async () => {
    const names = Array.from({ length: 5 }, (_, i) => `part-${i}`);
    for (const name of names) {
      await writeFile(path.join(root, 'workspace', name), '');
      await truncate(path.join(root, 'workspace', name), 16 * 1024 * 1024);
    }
    const rows = await computationInputs(root, names);
    expect(rows).toHaveLength(5);
    expect(rows.slice(0, 4).every((row) => row.status === 'hashed')).toBe(true);
    expect(rows[4]).toMatchObject({ status: 'unavailable', reason: 'budget_exhausted' });
  });
});
