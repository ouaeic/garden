import { appendFile, mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import type * as Filesystem from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof Filesystem>();
  return { ...original, open: vi.fn(original.open) };
});
import { readWorkspaceFile, readWorkspaceFileLines } from './files.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'garden-bounded-read-'));
  await mkdir(path.join(root, 'workspace'));
});

describe('complete window identity', () => {
  const window = {
    startLine: 1,
    endLine: Number.MAX_SAFE_INTEGER,
    maxBytes: 262144,
    shownTo: undefined
  };

  it.each(['', 'one', 'one\n', 'α\r\nβ\r\n', '\u0000\u00ff'])(
    'hashes every exact byte in a complete window: %j',
    async (text) => {
      const bytes = Buffer.from(text);
      await writeFile(path.join(root, 'workspace/result'), bytes);
      const result = await readWorkspaceFileLines(root, 'workspace/result', {
        ...window,
        maxBytes: Math.max(1, bytes.length)
      });
      expect(result.content).toEqual(bytes);
      expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(result.truncated).toBe(false);
    }
  );

  it('never assigns whole-file identity to a byte prefix, line window or suffix', async () => {
    await writeFile(path.join(root, 'workspace/result'), 'one\ntwo\nthree\n');
    for (const limits of [{ maxBytes: 5 }, { endLine: 1 }, { startLine: 2 }]) {
      const result = await readWorkspaceFileLines(root, 'workspace/result', {
        ...window,
        ...limits
      });
      expect(result.sha256, JSON.stringify(limits)).toBeUndefined();
    }
  });

  it('refuses changed content instead of issuing an identity for an unstable file', async () => {
    const target = path.join(root, 'workspace/result');
    await writeFile(target, 'small');
    const original = await vi.importActual<typeof Filesystem>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args);
      const stat = handle.stat.bind(handle);
      let reads = 0;
      handle.stat = (async (...statArgs: Parameters<typeof stat>) => {
        const details = await stat(...statArgs);
        if (++reads === 2) await appendFile(target, ' changed');
        return details;
      }) as typeof handle.stat;
      return handle;
    });
    await expect(readWorkspaceFileLines(root, 'workspace/result', window)).rejects.toThrow(
      'changed'
    );
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('whole-file read bounds', () => {
  it('rejects growth after the size check instead of returning bytes beyond the limit', async () => {
    const target = path.join(root, 'workspace/growing');
    await writeFile(target, 'small');
    const original = await vi.importActual<typeof Filesystem>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args);
      const stat = handle.stat.bind(handle);
      let statCalls = 0;
      handle.stat = (async (...statArgs: Parameters<typeof stat>) => {
        const details = await stat(...statArgs);
        if (++statCalls === 2) await appendFile(target, Buffer.alloc(128 * 1024, 7));
        return details;
      }) as typeof handle.stat;
      return handle;
    });
    await expect(readWorkspaceFile(root, 'workspace/growing', 64)).rejects.toThrow(
      /read limit|changed/
    );
  });

  it('returns complete exact-limit binary files and their complete hashes', async () => {
    const bytes = Buffer.alloc(131072, 255);
    await writeFile(path.join(root, 'workspace/binary'), bytes);
    const result = await readWorkspaceFile(root, 'workspace/binary', bytes.length);
    expect(result.content).toEqual(bytes);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('allows an empty file at a zero-byte limit', async () => {
    await writeFile(path.join(root, 'workspace/empty'), '');
    expect((await readWorkspaceFile(root, 'workspace/empty', 0)).content).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a named pipe without waiting for a writer',
    async () => {
      await promisify(execFile)('mkfifo', [path.join(root, 'workspace/pipe')]);
      await expect(readWorkspaceFile(root, 'workspace/pipe', 64)).rejects.toThrow(
        'not a regular file'
      );
      await expect(
        readWorkspaceFileLines(root, 'workspace/pipe', {
          startLine: 1,
          endLine: 10,
          maxBytes: 64,
          shownTo: undefined
        })
      ).rejects.toThrow('not a regular file');
    }
  );
});
