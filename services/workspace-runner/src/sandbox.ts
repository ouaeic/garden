import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Invocation } from './limits.js';
import { assertMissionWorkspaceOpen, createMissionLease } from './mission-processes.js';

/**
 * The privileged half of the agent sandbox. Running a command as a different Unix account needs
 * privilege the runner deliberately does not have, so it asks a root-owned helper for it through
 * sudo. The helper only ever removes privilege, which is why it can accept a command line the
 * agent influenced.
 */
export interface AgentSandbox {
  /** The set-user-ID binary that reaches the helper. Only the runner's account may use it. */
  elevate: string;
  /** Absolute path of the root-owned helper, outside every directory on the agent's PATH. */
  helper: string;
  /**
   * Where each command's spec file is written: the file that carries the command and its
   * environment to the helper, so that neither stands on the argument list. See
   * `sandboxedInvocation` for why the argument list is the wrong place for them.
   *
   * `sandboxSpecDirectory` says where this is on a box; it is a field rather than a call so that
   * every test can point it at a directory of its own.
   */
  specDirectory: string;
  /**
   * Whether this box draws a filesystem boundary as well as an identity one.
   *
   * It lives on the sandbox rather than in each caller's options because it is a fact about the
   * host - the kernel has Landlock and the installer measured it - and not about any one command.
   * That is also what makes it reach both execution paths: the foreground route and the background
   * one each hand `prepareInvocation` this same object, and a boolean threaded through their two
   * separate option bags would have had to be added twice and would have been added once.
   *
   * Optional, and absent means unconfined. That is the safe direction for the omission to point
   * and the only direction it can point: nothing here can turn a boundary on by accident, and a
   * sandbox built without this field behaves exactly as every sandbox did before it existed. The
   * two constructors below always set it, and `resolveAgentSandbox` is the only one production
   * uses.
   */
  confineFilesystem?: boolean;
  /** Measured helper support for supervised PID namespace teardown. */
  processIsolation?: boolean;
  /** Measured helper support for waiting until detached descendants finish. */
  retainedProcessTrees?: boolean;
  /** Native project read grants remain held until namespace teardown is proven. */
  projectInputLocks?: boolean;
  /** Measured helper support for a private network namespace. */
  networkIsolation?: boolean;
}

export const probeNativeIsolation = (
  sandbox: AgentSandbox
): Promise<{
  processIsolation: boolean;
  networkIsolation: boolean;
  retainedProcessTrees: boolean;
  projectInputLocks: boolean;
}> =>
  new Promise((resolve) => {
    execFile(
      sandbox.elevate,
      ['-n', sandbox.helper, 'check'],
      { timeout: 5000, maxBuffer: 8192 },
      (error, output) =>
        resolve({
          processIsolation: !error && /^process-isolation=yes$/m.test(output),
          retainedProcessTrees:
            !error &&
            /^process-isolation=yes$/m.test(output) &&
            /^retained-process-trees=yes$/m.test(output),
          projectInputLocks:
            !error &&
            /^process-isolation=yes$/m.test(output) &&
            /^project-input-locks=yes$/m.test(output),
          networkIsolation: !error && /^network-isolation=yes$/m.test(output)
        })
    );
  });

export const probeMissionProcessIsolation = async (sandbox: AgentSandbox): Promise<boolean> =>
  (await probeNativeIsolation(sandbox)).processIsolation;

export const isCodingMissionWorkspace = async (root: string): Promise<boolean> => {
  try {
    const marker = await lstat(path.join(root, '.garden', 'coding-parent.json'));
    if (!marker.isFile() || marker.isSymbolicLink())
      throw new Error('Invalid private coding mission marker');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const SUDO_EXECUTABLE = '/usr/bin/sudo';

/**
 * The spec files live beside the workspaces, in the directory that already holds the runner's own
 * private state - `services.json` is written there - rather than in any one workspace or in /tmp.
 * Every caller has this directory, including the workspace delete, whose own container is the
 * thing going away; it is created 0700 by the runner, so the agent account - which shares a group
 * with the runner and would read a 0770 directory - cannot open it even on a box with no Landlock;
 * and under Landlock its whole parent is granted nowhere. /tmp would have had to defend the file
 * against the account that owns every other file there, and a workspace's `.garden` is not there
 * when the command is the one that deletes the workspace.
 *
 * The helper has this same path hard-coded beside its workspace parent and reads a spec from
 * nowhere else: it removes the file as root, and a path the caller was free to choose would have
 * been a root-level delete of any file on the box. The two have to agree, and the name has to be
 * the shape the helper accepts - hexadecimal digits and `.spec`, no further path.
 */
export const sandboxSpecDirectory = (workspaceRoot: string): string =>
  path.resolve(workspaceRoot, '.garden', 'sandbox');

const SPEC_DIRECTORY_MODE = 0o700;
const SPEC_FILE_MODE = 0o600;

/**
 * The first word of every spec file, so the helper can tell a file it should read from a file
 * that merely has a command in it - a runner and a helper out of step, or a stray file. The number
 * is the layout: it moved when the working directory became the word after the header.
 */
const SPEC_HEADER = 'garden-sandbox-spec 2';

/**
 * The environment is handed over in the spec file because sudo resets it, and reconstructing it
 * through sudoers `env_keep` would put the same values in a file the runner does not own. None
 * of them is secret: the runner sets PATH, HOME and LANG, and everything else has already been
 * filtered down to locale and terminal settings the agent asked for.
 */
const environmentArguments = (env: Record<string, string>): string[] =>
  Object.entries(env).map(([key, value]) => `${key}=${value}`);

/**
 * What the helper reads: the header, then every word NUL-terminated - the directory to run in,
 * the environment, then the executable and its arguments, the last three being exactly the list
 * `env -i` receives. NUL is the delimiter, so the encoding is byte-exact in both directions for
 * every word that holds none: an argument that ends in a newline, as every heredoc body does, ends
 * in a newline on the far side. The helper's own harness, scripts/test-sandbox.sh, drives one
 * through and compares the bytes. A word holding a NUL is refused by `assertSandboxableCommand`
 * before this is reached, because the file cannot carry it and reshaping it is not an option.
 */
const specContents = (words: string[]): Buffer =>
  Buffer.concat([SPEC_HEADER, ...words].map((word) => Buffer.from(`${word}\0`, 'utf8')));

export const agentSandbox = (
  helper: string,
  confineFilesystem: boolean,
  specDirectory: string
): AgentSandbox => ({
  elevate: SUDO_EXECUTABLE,
  helper,
  specDirectory,
  confineFilesystem
});

/**
 * Resolves the configured helper, refusing to start rather than silently running agent commands
 * as the runner's own account. A box that cannot sandbox has to say so.
 *
 * Unconsumed command specifications may be discarded at startup. Mission leases remain until
 * their native namespace supervisor proves that no child can still write to a workspace.
 */
export const resolveAgentSandbox = async (
  helper: string | undefined,
  specDirectory: string,
  confineFilesystem = false
): Promise<AgentSandbox | undefined> => {
  if (!helper) return undefined;
  try {
    await access(helper, constants.X_OK);
  } catch {
    throw new Error(
      `AGENT_SANDBOX_HELPER points at ${helper}, which is not executable. Agent commands would run as the runner's own account, so the runner will not start.`
    );
  }
  await mkdir(specDirectory, { recursive: true, mode: SPEC_DIRECTORY_MODE });
  const info = await lstat(specDirectory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Sandbox specifications require a private real directory');
  await chmod(specDirectory, SPEC_DIRECTORY_MODE);
  for (const name of await readdir(specDirectory))
    if (/^[a-f0-9]+\.spec$/.test(name)) await rm(path.join(specDirectory, name), { force: true });
  return agentSandbox(helper, confineFilesystem, specDirectory);
};

/**
 * Two things the helper's input cannot hold, refused rather than reshaped.
 *
 * `env -i` reads leading `NAME=VALUE` arguments as assignments and stops at the first argument
 * without an equals sign, so an executable path containing one would be swallowed as an
 * assignment. No real program path has one, and refusing is cheaper than a second delimiter.
 *
 * NUL is the spec file's word delimiter and the one byte no argument can hold. Written as-is, an
 * argument holding one arrives as two arguments, and an environment value holding one arrives as
 * a value and a second assignment nobody filtered - `TERM=xterm\0LD_PRELOAD=/x` installs a
 * preload past the list of variables a command may be given. Measured: before the file existed,
 * the kernel refused the same byte on the argument list, loudly, and the file must not be quieter
 * than the argument list was. The request schema admits the byte from JSON, so it is checked here,
 * on every word, before anything is written.
 */
export const assertSandboxableCommand = (
  invocation: Invocation,
  env: Record<string, string>
): void => {
  if (invocation.executable.includes('='))
    throw new Error('An executable path may not contain an equals sign');
  const words = [invocation.executable, ...invocation.args, ...environmentArguments(env)];
  if (words.some((word) => word.includes('\0')))
    throw new Error('A command, its arguments and its environment may not contain a NUL byte');
};

/**
 * The word the helper reads where a root would go when there is no confinement to ask for. A word
 * rather than an omission because the helper's grammar is positional: were the root left out, the
 * `--spec` word would land in its place and be read as one.
 */
const NO_CONFINEMENT_ROOT = '-';

/**
 * Writes one command's spec and returns its path. A fresh random name under an exclusive create,
 * mode 0600, in a directory only the runner and root can open: the file exists for the few
 * milliseconds between this write and the helper's read, and the helper unlinks it before the
 * command starts. The directory is made here as well as at startup, because a startup that found
 * no helper made none and a test hands over a directory of its own.
 */
const writeSpec = async (specDirectory: string, words: string[]): Promise<string> => {
  await mkdir(specDirectory, { recursive: true, mode: SPEC_DIRECTORY_MODE });
  const specPath = path.join(specDirectory, `${randomBytes(12).toString('hex')}.spec`);
  await writeFile(specPath, specContents(words), { mode: SPEC_FILE_MODE, flag: 'wx' });
  return specPath;
};

/**
 * `confinementRoot` is the workspace the command may write in, or `null` for a command that must
 * not be confined at all. It is required rather than optional on purpose: this tree has four times
 * shipped a bound that a production call site walked straight past, and an optional argument is how
 * that happens. The only `null` in the runner is the workspace delete, which exists to remove the
 * very directory a ruleset would protect.
 *
 * Passing a root is a request, not a guarantee. A box whose installer found no Landlock says so on
 * the sandbox, and the helper is then asked for `open` and the command runs exactly as it did
 * before - which is the difference between a ladder and an outage.
 *
 * THE COMMAND AND ITS ENVIRONMENT ARE NOT ON THE ARGUMENT LIST, and that is the point of the spec
 * file. sudo writes every argument of every privileged invocation to the system journal -
 * persistent, root-owned, outside the workspace and outside every checkpoint - and the sudo the box
 * ships cannot be told not to (scripts/install-native.sh says which directives it lacks). With the
 * command there, that journal held every heredoc body, every filename and everything typed at a
 * terminal, on a box whose privacy document says its own logs hold none of those. So the argument
 * list carries the helper, the modes, the root and a path, and the text goes through a file the
 * helper reads and unlinks. What the journal records is that a command ran, in which modes and in
 * which workspace, and not what it was. sandbox.test.ts asserts the absence directly.
 *
 * NEITHER IS THE DIRECTORY THE COMMAND RUNS IN, and `cwd` is required for the same reason the
 * root is. The journal line records the directory sudo was started from beside its arguments, and
 * the directory an agent chooses for a command - `workspace/acme-lawsuit-discovery` - is a name
 * used inside the task. So the caller starts sudo from the container root, which the line already
 * names as the workspace, and the helper enters the real directory from the spec after the line
 * is written. It has to be absolute: the helper has no directory of its own to resolve against but
 * wherever sudo started, which is exactly the fact this keeps out of the journal.
 */
export const sandboxedInvocation = async (
  invocation: Invocation,
  env: Record<string, string>,
  sandbox: AgentSandbox,
  isolateNetwork: boolean,
  confinementRoot: string | null,
  cwd: string,
  superviseProcessTree = false,
  retainProcessTree = false
): Promise<Invocation & { processTreeLease?: string }> => {
  if (confinementRoot) assertMissionWorkspaceOpen(confinementRoot);
  assertSandboxableCommand(invocation, env);
  if (cwd.includes('\0'))
    throw new Error('A command, its arguments and its environment may not contain a NUL byte');
  if (!path.isAbsolute(cwd))
    throw new Error('The directory a sandboxed command runs in must be an absolute path');
  const confined = sandbox.confineFilesystem === true && confinementRoot !== null;
  const mission = confinementRoot !== null && (await isCodingMissionWorkspace(confinementRoot));
  if (mission && sandbox.networkIsolation !== true)
    throw new Error('Coding missions require measured native network isolation');
  const networkIsolated = mission || isolateNetwork;
  const retained = retainProcessTree && !mission && !superviseProcessTree;
  if (retained && sandbox.retainedProcessTrees !== true)
    throw new Error('Managed jobs require measured native retained process-tree support');
  const supervised =
    mission || superviseProcessTree || retained || (confined && sandbox.projectInputLocks === true);
  if (supervised && (!confined || sandbox.processIsolation !== true))
    throw new Error(
      'Managed commands require measured native filesystem and process-tree isolation'
    );
  const specPath = await writeSpec(sandbox.specDirectory, [
    cwd,
    ...environmentArguments(env),
    invocation.executable,
    ...invocation.args
  ]);
  const processTreeLease = supervised ? specPath.replace(/\.spec$/, '.lease') : undefined;
  if (processTreeLease)
    await createMissionLease(
      confinementRoot!,
      processTreeLease,
      sandbox,
      mission ? 'mission' : 'session',
      retained
    );
  return {
    ...(processTreeLease ? { processTreeLease } : {}),
    executable: sandbox.elevate,
    args: [
      '-n',
      sandbox.helper,
      'run',
      networkIsolated ? 'isolated' : 'network',
      supervised ? 'mission' : confined ? 'confine' : 'open',
      confined ? confinementRoot : NO_CONFINEMENT_ROOT,
      '--spec',
      specPath
    ]
  };
};

/**
 * The owner's interactive terminal takes a different helper mode for one reason: the sudoers
 * policy gives that mode a pseudo-terminal. Without one the shell has no controlling terminal of
 * its own and loses job control, so ^Z and ^C stop behaving like a terminal.
 *
 * It takes no confinement root and never will. This is the owner at their own computer, and a
 * ruleset here would stop them reading their own files from their own terminal while the file
 * browser hands them the same files two clicks away - a boundary paid for in ease of use and
 * bought nothing with. The helper's `shell` mode has no confine word for the same reason.
 *
 * Its command stays on the argument list, and that is a different case from `sandboxedInvocation`:
 * what stands there is the shell's own path and the terminal's TERM and locale words, none of
 * which is content. What the owner then types goes down the pseudo-terminal, which sudo does not
 * record.
 */
export const sandboxedShell = (
  invocation: Invocation,
  env: Record<string, string>,
  sandbox: AgentSandbox
): Invocation => {
  assertSandboxableCommand(invocation, env);
  return {
    executable: sandbox.elevate,
    args: [
      '-n',
      sandbox.helper,
      'shell',
      ...environmentArguments(env),
      invocation.executable,
      ...invocation.args
    ]
  };
};
