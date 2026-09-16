import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ProjectVersionFiles } from './project-version-files.js';

it('measures captured text edits including additions and deletions without counting binary datasets as code', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-lines-'));
  const versions = new ProjectVersionFiles(root);
  try {
    await mkdir(path.join(root, 'objects'));
    const file = async (content: string) => {
      const fact = {
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: Buffer.byteLength(content),
        executable: false
      };
      await writeFile(versions.object(fact), content);
      return fact;
    };
    const base = await file('unchanged\nbefore\nlast\n');
    const next = await file('unchanged\nafter\nlast\nextra\n');
    expect(await versions.lineChanges(base, next)).toEqual({ added: 2, removed: 1 });
    expect(await versions.lineChanges(null, next)).toEqual({ added: 4, removed: 0 });
    expect(await versions.lineChanges(base, null)).toEqual({ added: 0, removed: 3 });
    expect(await versions.lineChanges(base, base)).toEqual({ added: 0, removed: 0 });
    expect(await versions.lineChanges(null, await file('a\0b'))).toBeNull();
    expect(await versions.lineChanges(null, { ...next, bytes: 3 * 1024 * 1024 })).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
