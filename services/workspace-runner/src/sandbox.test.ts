import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveAgentSandbox,
  sandboxSpecDirectory,
  sandboxedInvocation,
  sandboxedShell
} from './sandbox.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const helperPath = '/usr/local/lib/garden/garden-sandbox';
let workspace: string;
let workingDirectory: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'garden-invocation-workspace-'));
  temporaryRoots.push(workspace);
  workingDirectory = path.join(workspace, 'workspace');
});

/** A sandbox whose spec directory is a fresh temporary tree, removed after the test. */
const sandboxIn = async (confineFilesystem: boolean) => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-sandbox-'));
  temporaryRoots.push(root);
  return {
    elevate: '/usr/bin/sudo',
    helper: helperPath,
    specDirectory: path.join(root, 'specs'),
    confineFilesystem
  };
};

/** The spec file the invocation wrote, as the helper will read it: the header, then the words. */
const specWords = async (invocation: { args: string[] }): Promise<string[]> => {
  const specPath = invocation.args[invocation.args.indexOf('--spec') + 1];
  expect(specPath).toBeDefined();
  const bytes = await readFile(specPath as string);
  expect(bytes.at(-1)).toBe(0);
  return bytes.subarray(0, -1).toString('utf8').split('\0');
};

describe('agent sandbox invocation', () => {
  it('hands the helper the modes and a spec path, and the command and environment through the spec', async () => {
    const sandbox = await sandboxIn(false);
    const invocation = await sandboxedInvocation(
      { executable: '/usr/bin/python3', args: ['build.py', '--fast'] },
      { PATH: '/usr/bin', HOME: '/home/garden/ws', LANG: 'C.UTF-8' },
      sandbox,
      false,
      workspace,
      workingDirectory
    );
    expect(invocation.executable).toBe('/usr/bin/sudo');
    expect(invocation.args.slice(0, 7)).toEqual([
      '-n',
      helperPath,
      'run',
      'network',
      // A root was offered and this box cannot enforce one, so the helper is asked for nothing and
      // the root word is the placeholder rather than the workspace. The placeholder is there
      // because the grammar is positional: without it `--spec` would land in its slot.
      'open',
      '-',
      '--spec'
    ]);
    expect(invocation.args).toHaveLength(8);
    expect(path.dirname(invocation.args[7] as string)).toBe(sandbox.specDirectory);
    // The order the helper reads: the directory to run in, then what `env -i` needs - assignments
    // first, then the executable, then its arguments.
    expect(await specWords(invocation)).toEqual([
      'garden-sandbox-spec 2',
      workingDirectory,
      'PATH=/usr/bin',
      'HOME=/home/garden/ws',
      'LANG=C.UTF-8',
      '/usr/bin/python3',
      'build.py',
      '--fast'
    ]);
  });

  it('keeps the command text and every environment value off the argument list', async () => {
    // What sudo writes to the system journal is the argument list, in full, for every privileged
    // invocation - persistent, root-owned, outside every checkpoint. A heredoc body, a filename,
    // a value the agent asked to have in its environment: none of it may stand there. Asserted
    // against the joined list rather than any one slot, so a future word added anywhere fails it.
    const sandbox = await sandboxIn(true);
    const invocation = await sandboxedInvocation(
      { executable: '/bin/bash', args: ['-c', "cat >> notes.md <<'EOF'\nCANARY-12345\nEOF"] },
      { PATH: '/usr/bin', HOME: `${workspace}/.home`, LANG: 'C.UTF-8' },
      sandbox,
      false,
      workspace,
      workingDirectory
    );
    const argumentText = invocation.args.join('\n');
    expect(argumentText).not.toContain('CANARY-12345');
    expect(argumentText).not.toContain('notes.md');
    expect(argumentText).not.toContain('/bin/bash');
    expect(argumentText).not.toContain('C.UTF-8');
    expect(argumentText).not.toContain('/usr/bin');
    expect(argumentText).not.toContain('.home');
    // And they all reached the file, byte for byte, the heredoc's newlines included.
    expect(await specWords(invocation)).toEqual([
      'garden-sandbox-spec 2',
      workingDirectory,
      'PATH=/usr/bin',
      `HOME=${workspace}/.home`,
      'LANG=C.UTF-8',
      '/bin/bash',
      '-c',
      "cat >> notes.md <<'EOF'\nCANARY-12345\nEOF"
    ]);
  });

  it('carries the directory the command runs in through the spec, off the argument list', async () => {
    // sudo's journal line records the directory it was started from as well as its arguments,
    // and the directory an agent chooses for a command is a name used inside the task -
    // `workspace/acme-lawsuit-discovery` is a fact about the work. So the helper is told where
    // to run from the spec, and the caller starts sudo from the container root instead.
    const chosen = `${workingDirectory}/acme-lawsuit-discovery`;
    const invocation = await sandboxedInvocation(
      { executable: '/bin/sh', args: ['-c', 'ls'] },
      {},
      await sandboxIn(true),
      false,
      workspace,
      chosen
    );
    expect(invocation.args.join('\n')).not.toContain('acme-lawsuit-discovery');
    expect((await specWords(invocation)).slice(0, 2)).toEqual(['garden-sandbox-spec 2', chosen]);
  });

  it('refuses a directory the helper could not enter as written', async () => {
    // The helper enters the directory with no environment and no notion of a current directory
    // but its own, so a relative name would be resolved against wherever sudo happened to start.
    const sandbox = await sandboxIn(true);
    await expect(
      sandboxedInvocation(
        { executable: '/bin/sh', args: ['-c', 'ls'] },
        {},
        sandbox,
        false,
        workspace,
        'workspace/acme-lawsuit-discovery'
      )
    ).rejects.toThrow('absolute');
    await expect(readdir(sandbox.specDirectory)).rejects.toThrow();
  });

  it('refuses a word the spec cannot carry, rather than reshaping it', async () => {
    // NUL is the word delimiter, and the one byte an argument cannot hold. Written as-is, an
    // argument holding one arrives as two arguments, and an environment value holding one
    // arrives as a value and a second assignment that was never asked for - a way past the
    // filter on which variables a command may be given. Node's own spawn refuses the same byte
    // loudly; the file must not be quieter than the argument list was.
    const sandbox = await sandboxIn(true);
    await expect(
      sandboxedInvocation(
        { executable: '/bin/sh', args: ['-c', 'echo one\0second-word'] },
        {},
        sandbox,
        false,
        workspace,
        workingDirectory
      )
    ).rejects.toThrow('NUL');
    await expect(
      sandboxedInvocation(
        { executable: '/bin/sh', args: ['-c', ':'] },
        { TERM: 'xterm\0LD_PRELOAD=/x' },
        sandbox,
        false,
        workspace,
        workingDirectory
      )
    ).rejects.toThrow('NUL');
    await expect(
      sandboxedInvocation(
        { executable: '/bin/sh\0', args: [] },
        {},
        sandbox,
        false,
        workspace,
        workingDirectory
      )
    ).rejects.toThrow('NUL');
    await expect(
      sandboxedInvocation(
        { executable: '/bin/sh', args: [] },
        {},
        sandbox,
        false,
        workspace,
        `${workingDirectory}\0`
      )
    ).rejects.toThrow('NUL');
    // The owner's shell carries its words on the argument list, where the kernel would refuse the
    // byte; refused here for the same reason, before anything is spawned.
    expect(() =>
      sandboxedShell({ executable: '/bin/bash', args: [] }, { TERM: 'xterm\0X=1' }, sandbox)
    ).toThrow('NUL');
    // Nothing was written for any of them: a spec for a command that will not run is text on
    // disk for nothing.
    await expect(readdir(sandbox.specDirectory)).rejects.toThrow();
  });

  it('writes each spec owner-only, in an owner-only directory, under a name nothing can guess', async () => {
    // The file is the one place the command exists outside the runner's memory. The runner shares
    // a group with the agent account, so a group-readable file or directory would hand every
    // command's text to the account that runs it - and, on a box without Landlock, to any other
    // task's command as well.
    const sandbox = await sandboxIn(true);
    const first = await sandboxedInvocation(
      { executable: '/bin/sh', args: ['-c', ':'] },
      {},
      sandbox,
      false,
      workspace,
      workingDirectory
    );
    const second = await sandboxedInvocation(
      { executable: '/bin/sh', args: ['-c', ':'] },
      {},
      sandbox,
      false,
      workspace,
      workingDirectory
    );
    const specPath = first.args[7] as string;
    expect((await stat(specPath)).mode & 0o777).toBe(0o600);
    expect((await stat(sandbox.specDirectory)).mode & 0o777).toBe(0o700);
    expect(second.args[7]).not.toBe(specPath);
    expect(await readdir(sandbox.specDirectory)).toHaveLength(2);
    // The name is the shape the helper accepts and nothing else: hexadecimal digits and the
    // suffix, no further path. The helper refuses any other, because it removes what it reads
    // as root and a name it did not expect is a path a caller chose.
    expect(path.basename(specPath)).toMatch(/^[0-9a-f]{24}\.spec$/);
  });

  it('names the workspace the command may write in when the box can enforce it', async () => {
    const invocation = await sandboxedInvocation(
      { executable: '/usr/bin/python3', args: ['build.py'] },
      { HOME: `${workspace}/.home` },
      await sandboxIn(true),
      false,
      workspace,
      workingDirectory
    );
    expect(invocation.args.slice(0, 6)).toEqual([
      '-n',
      helperPath,
      'run',
      'network',
      'confine',
      workspace
    ]);
  });

  it('leaves the workspace delete unconfined, because it is the thing that removes the tree', async () => {
    // The one null in the runner. A ruleset admitting `workspace/` and nothing above it would let
    // this empty the tree and then refuse to remove it, which is a half-finished delete reported
    // as a failure with no cause the reader can see.
    const invocation = await sandboxedInvocation(
      { executable: '/bin/rm', args: ['-rf', '--', workspace] },
      { PATH: '/usr/bin:/bin' },
      await sandboxIn(true),
      false,
      null,
      '/'
    );
    expect(invocation.args.slice(0, 6)).toEqual(['-n', helperPath, 'run', 'network', 'open', '-']);
  });

  it('asks for a network namespace when the command was not granted the network', async () => {
    const invocation = await sandboxedInvocation(
      { executable: '/bin/sh', args: ['-c', 'curl example.invalid'] },
      {},
      await sandboxIn(true),
      true,
      workspace,
      workingDirectory
    );
    expect(invocation.args.slice(0, 6)).toEqual([
      '-n',
      helperPath,
      'run',
      'isolated',
      'confine',
      workspace
    ]);
  });

  it('asks for the terminal mode so the owner shell keeps a controlling terminal', async () => {
    // The sudoers policy gives this mode a pseudo-terminal and the command mode none: a shell
    // without a controlling terminal loses job control, and a command with one has its standard
    // output and error merged into a single stream the model then cannot tell apart.
    const invocation = sandboxedShell(
      { executable: '/bin/bash', args: [] },
      { TERM: 'xterm-256color' },
      await sandboxIn(false)
    );
    expect(invocation.args).toEqual([
      '-n',
      helperPath,
      'shell',
      'TERM=xterm-256color',
      '/bin/bash'
    ]);
  });

  it('never confines the owner terminal, on a box that confines everything else', async () => {
    // Not an omission. The owner is at their own computer, and a ruleset here would refuse them
    // their own files from their own terminal while the file browser hands over the same files.
    const invocation = sandboxedShell(
      { executable: '/bin/bash', args: [] },
      {},
      await sandboxIn(true)
    );
    expect(invocation.args).not.toContain('confine');
    expect(invocation.args).toEqual(['-n', helperPath, 'shell', '/bin/bash']);
  });

  it('refuses an executable that would be read as an environment assignment', async () => {
    // `env -i` takes leading NAME=VALUE arguments as assignments, so a path with an equals sign
    // would be swallowed and the command silently replaced by the one after it.
    const sandbox = await sandboxIn(false);
    await expect(
      sandboxedInvocation(
        { executable: '/home/garden/a=b/tool', args: [] },
        {},
        sandbox,
        false,
        workspace,
        workingDirectory
      )
    ).rejects.toThrow('equals sign');
    // Refused before anything was written: a spec for a command that will not run is text on
    // disk for nothing.
    await expect(readdir(sandbox.specDirectory)).rejects.toThrow();
  });

  it('puts the spec directory beside the workspaces, in the runner-only state directory', () => {
    // Not inside any one workspace, because the workspace delete needs a spec too and its own
    // container is what is going; not under /tmp, which the agent account may write in. The
    // helper has this path hard-coded beside its workspace parent and reads a spec from nowhere
    // else, so the two have to agree.
    expect(sandboxSpecDirectory('/home/garden')).toBe('/home/garden/.garden/sandbox');
  });

  it('refuses to start rather than run agent commands as the runner when the helper is missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-sandbox-'));
    temporaryRoots.push(root);
    await expect(
      resolveAgentSandbox('/usr/local/lib/garden/absent', path.join(root, 'specs'))
    ).rejects.toThrow('will not start');
  });

  it('leaves the sandbox unconfigured where there is no second account to drop to', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-sandbox-'));
    temporaryRoots.push(root);
    await expect(resolveAgentSandbox(undefined, path.join(root, 'specs'))).resolves.toBeUndefined();
  });

  it('accepts a helper the runner can execute', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-sandbox-'));
    temporaryRoots.push(root);
    const helper = path.join(root, 'garden-sandbox');
    await writeFile(helper, '#!/bin/sh\nexit 0\n');
    await chmod(helper, 0o755);
    const specDirectory = path.join(root, 'specs');
    await expect(resolveAgentSandbox(helper, specDirectory)).resolves.toEqual({
      elevate: '/usr/bin/sudo',
      helper,
      specDirectory,
      confineFilesystem: false
    });
  });

  it('carries the measured filesystem rung onto the sandbox every caller then reads', async () => {
    // `confineFilesystem` is optional on the interface, so the assertion that matters is not that
    // an object can lack it but that the one constructor production uses always sets it. Absence
    // means unconfined, and a resolver that forgot to pass this through would be unconfined
    // everywhere while runner.env said otherwise - a silence, not a failure.
    const root = await mkdtemp(path.join(tmpdir(), 'garden-sandbox-'));
    temporaryRoots.push(root);
    const helper = path.join(root, 'garden-sandbox');
    await writeFile(helper, '#!/bin/sh\nexit 0\n');
    await chmod(helper, 0o755);
    const specDirectory = path.join(root, 'specs');
    await expect(resolveAgentSandbox(helper, specDirectory, true)).resolves.toEqual({
      elevate: '/usr/bin/sudo',
      helper,
      specDirectory,
      confineFilesystem: true
    });
  });

  it('sweeps the spec directory at startup, because a spec still there is one the helper never read', async () => {
    // The helper unlinks every spec it reads and every spec it refuses once it has vouched for
    // the file as the runner's own. One that survives is one sudo itself turned away, one the
    // runner died holding, or one the helper would not vouch for - and nothing is in flight when
    // the runner starts, so nothing there is still wanted, and the command text it holds should
    // not outlive the process that wrote it.
    const root = await mkdtemp(path.join(tmpdir(), 'garden-sandbox-'));
    temporaryRoots.push(root);
    const helper = path.join(root, 'garden-sandbox');
    await writeFile(helper, '#!/bin/sh\nexit 0\n');
    await chmod(helper, 0o755);
    const stale = await sandboxIn(false);
    await sandboxedInvocation(
      { executable: '/bin/sh', args: [] },
      {},
      stale,
      false,
      workspace,
      workingDirectory
    );
    expect(await readdir(stale.specDirectory)).toHaveLength(1);
    await resolveAgentSandbox(helper, stale.specDirectory);
    expect(await readdir(stale.specDirectory)).toHaveLength(0);
    expect((await stat(stale.specDirectory)).mode & 0o777).toBe(0o700);
  });
});
