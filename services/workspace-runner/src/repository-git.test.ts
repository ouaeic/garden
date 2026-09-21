import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_ONLY_GIT, readRepositoryGit } from './repository-git.js';
import type { execute, ExecutionOptions } from './execution.js';

describe('read-only repository metadata', () => {
  let root: string;
  const options: ExecutionOptions = {
    maximumSeconds: 60,
    sandbox: {
      elevate: '/usr/bin/sudo',
      helper: '/trusted/helper',
      specDirectory: '/trusted/spec',
      confineFilesystem: true,
      networkIsolation: true
    }
  };
  const observation = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'git-metadata-'));
    await mkdir(path.join(root, 'workspace'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('preserves status and NUL filenames through an isolated, bounded reader', async () => {
    const run = vi
      .fn<typeof execute>()
      .mockResolvedValueOnce({ ...observation, stdout: '## main\n M one.ts\n' })
      .mockResolvedValueOnce({ ...observation, stdout: 'one.ts\0new\nline.ts\0' });
    const result = await readRepositoryGit(root, { path: 'workspace' }, options, run);
    expect(result).toEqual({
      status: '## main\n M one.ts\n',
      files: 'one.ts\0new\nline.ts\0',
      limited: false
    });
    expect(run).toHaveBeenCalledTimes(2);
    for (const call of run.mock.calls) {
      expect(call[1]).toMatchObject({
        executable: '/usr/bin/python3',
        cwd: 'workspace',
        network: false,
        timeoutSeconds: 30
      });
      expect(call[2]).toMatchObject({
        isolateNetwork: true,
        allowSystemPackages: false,
        sandbox: options.sandbox
      });
    }
  });
  it('does not execute metadata at all without both measured isolation properties', async () => {
    const run = vi.fn<typeof execute>();
    for (const sandbox of [
      undefined,
      { ...options.sandbox!, confineFilesystem: false },
      { ...options.sandbox!, networkIsolation: false }
    ]) {
      expect(
        await readRepositoryGit(root, { path: 'workspace' }, { ...options, sandbox }, run)
      ).toMatchObject({ limited: true, status: '', files: '' });
    }
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps helper failures explicit while retaining independent tracked-file evidence', async () => {
    const run = vi
      .fn<typeof execute>()
      .mockResolvedValueOnce({ ...observation, exitCode: 128, stderr: 'filter forbidden' })
      .mockResolvedValueOnce({ ...observation, stdout: 'one.ts\0' });
    expect(await readRepositoryGit(root, { path: 'workspace' }, options, run)).toMatchObject({
      limited: true,
      status: '',
      files: 'one.ts\0'
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it.each([{ path: '../outside' }, { path: '.home' }, { path: 'workspace', command: 'arbitrary' }])(
    'refuses an unrelated path or caller-controlled command: %j',
    async (input) => {
      const run = vi.fn<typeof execute>();
      await expect(readRepositoryGit(root, input, options, run)).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    }
  );
  it.skipIf(process.platform !== 'linux')(
    'uses kernel restrictions to preserve reads and reject configured programs',
    async () => {
      const cwd = path.join(root, 'workspace');
      const env = {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1'
      };
      const git = (...args: string[]) =>
        execFileSync('/usr/bin/git', args, { cwd, env, encoding: 'utf8' });
      const read = (action: string) =>
        spawnSync('/usr/bin/python3', ['-I', '-c', READ_ONLY_GIT, action], {
          cwd,
          env,
          encoding: 'utf8'
        });
      git('init', '-q');
      git('config', 'user.name', 'Synthetic proof');
      git('config', 'user.email', 'proof@example.invalid');
      await writeFile(path.join(cwd, 'input.txt'), 'before\n');
      git('add', 'input.txt');
      git('commit', '-qm', 'Fixture');
      const ordinary = read('status');
      expect(ordinary.status, ordinary.stderr).toBe(0);
      expect(read('files').stdout).toBe('input.txt\0');
      const marker = path.join(cwd, 'callback'),
        hook = path.join(cwd, 'hook.py');
      await writeFile(
        hook,
        `#!/usr/bin/python3\nfrom pathlib import Path\nimport sys\nPath(${JSON.stringify(marker)}).write_text('callback')\nprint('CALLBACK_EXECUTED', file=sys.stderr)\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n`
      );
      await chmod(hook, 0o700);
      git('config', 'filter.proof.clean', "'" + hook.replaceAll("'", "'\\''") + "'");
      git('config', 'filter.proof.required', 'true');
      await writeFile(path.join(cwd, '.gitattributes'), 'input.txt filter=proof\n');
      git('add', '.gitattributes', 'input.txt');
      git('commit', '-qm', 'Attributes');
      expect(await readFile(marker, 'utf8')).toBe('callback');
      await rm(marker);
      await writeFile(path.join(cwd, 'input.txt'), 'after!\n');
      await utimes(path.join(cwd, 'input.txt'), 1700000000, 1700000000);
      const index = await readFile(path.join(cwd, '.git/index'));
      const filtered = read('status');
      expect(filtered.status).not.toBe(0);
      expect(filtered.stderr).not.toContain('CALLBACK_EXECUTED');
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(cwd, '.git/index'))).toEqual(index);
    }
  );
});
