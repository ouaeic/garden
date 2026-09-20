import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ComputationRequest } from '@athanor/contracts';
import { computationLaunch } from './computation-launch.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('launches R with only existing workspace libraries and refuses symlink escapes', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'garden-r-launch-')));
  roots.push(root);
  await mkdir(path.join(root, 'workspace', 'library'), { recursive: true });
  const request = (libraries: string[]) =>
    ComputationRequest.parse({ action: 'start', language: 'r', rLibraryPaths: libraries });
  const launch = await computationLaunch(root, request(['workspace/library']), 'token');
  expect(launch.executable).toBe('Rscript');
  expect(launch.args[0]).toBe('--vanilla');
  expect(await readFile(launch.args[1]!, 'utf8')).toContain('kind="ready"');
  expect(launch.args.slice(-2)).toEqual(['token', path.join(root, 'workspace/library')]);
  await launch.dispose!();
  await expect(stat(launch.args[1]!)).rejects.toMatchObject({ code: 'ENOENT' });
  await symlink(os.tmpdir(), path.join(root, 'workspace/escape'));
  await expect(computationLaunch(root, request(['workspace/escape']), 'token')).rejects.toThrow(
    'real directories'
  );
  await expect(computationLaunch(root, request(['../foreign']), 'token')).rejects.toThrow();
  await writeFile(path.join(root, 'workspace/file'), 'not a library');
  await expect(computationLaunch(root, request(['workspace/file']), 'token')).rejects.toThrow(
    'real directories'
  );
  await expect(
    computationLaunch(
      root,
      ComputationRequest.parse({
        action: 'start',
        language: 'python',
        rLibraryPaths: ['workspace/library']
      }),
      'token'
    )
  ).rejects.toThrow('R session');
});
