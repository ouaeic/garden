import { packageNamesAreData } from './shell-package-data.js';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface CommandShape {
  executable: string;
  args: string[];
}

const PRIVILEGE_ESCALATION = new Set(['sudo', 'su', 'doas', 'pkexec', 'runuser']);

/**
 * The system package managers, not only the one Ubuntu happens to use.
 *
 * This decides what counts as installing software on the host, which is what the desktop route
 * refuses outright and what the shell route sends through the privileged helper. Listing only apt
 * meant that on a Fedora, Rocky or Arch box `dnf install` and `pacman -S` were not package
 * management at all - so the one class of command that is supposed to be impossible to start from
 * a window, and to be impossible to run without the owner seeing it, was neither.
 */
const PACKAGE_MANAGERS = new Set([
  'apk',
  'apt',
  'apt-get',
  'aptitude',
  'dnf',
  'dnf5',
  'emerge',
  'microdnf',
  'pacman',
  'rpm',
  'rpm-ostree',
  'yay',
  'yum',
  'zypper'
]);

// Binaries whose whole purpose is to run another command taken from their arguments.
// Without this list `env sudo id` or `sh -c "sudo id"` walks straight past a check that
// only looks at the executable.
const COMMAND_WRAPPERS = new Set([
  'bash',
  'busybox',
  'chroot',
  'dash',
  'doas',
  'env',
  'fish',
  'flock',
  'ionice',
  'ksh',
  'nice',
  'nohup',
  'proot',
  'runuser',
  'script',
  'setsid',
  'sh',
  'stdbuf',
  'su',
  'sudo',
  'time',
  'timeout',
  'unshare',
  'watch',
  'xargs',
  'zsh'
]);

// Shell operators and quoting that separate one command from the next inside a single
// argument, so `sh -c "cd /tmp && sudo id"` still yields a `sudo` token.
const SHELL_SEPARATORS = /[\s;&|(){}<>`"'\\]+/;

export const binaryName = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return path.basename(trimmed);
};

const argumentTokens = (args: string[]): string[] =>
  args.flatMap((argument) => argument.split(SHELL_SEPARATORS));

const firstMatch = (command: CommandShape, names: ReadonlySet<string>): string | undefined => {
  const direct = binaryName(command.executable);
  if (names.has(direct)) return direct;
  if (!COMMAND_WRAPPERS.has(direct)) return undefined;
  for (const token of argumentTokens(command.args)) {
    const name = binaryName(token);
    if (names.has(name)) return name;
  }
  return undefined;
};

/** The privilege-escalation binary this command would run, directly or via a wrapper. */
export const privilegeEscalationBinary = (command: CommandShape): string | undefined =>
  firstMatch(command, PRIVILEGE_ESCALATION);

/**
 * The root-owned helpers the runner reaches itself, after checking a capability and applying the
 * approval policy. Named directly they would run with neither, so a command may not name one.
 * Matching is by basename for the same reason the sets above are: a wrapper can hide the real
 * executable in its arguments.
 */
export const privilegedHelperInvocation = (
  command: CommandShape,
  helpers: readonly (string | undefined)[]
): string | undefined => {
  const names = new Set(
    helpers
      .filter((helper): helper is string => Boolean(helper))
      .map((helper) => binaryName(helper))
  );
  return names.size ? firstMatch(command, names) : undefined;
};

/**
 * The executable as the kernel will resolve it: a PATH search when the command is a bare name,
 * then every symbolic link followed. Without this the checks above see only the string they were
 * handed, and `ln -s /usr/bin/sudo ./s` presents a basename of `s`. Returns undefined when
 * nothing matches, which leaves the caller checking the literal spelling on its own.
 */
export const resolveExecutable = async (
  executable: string,
  searchPath: string,
  cwd: string
): Promise<string | undefined> => {
  const candidates = executable.includes(path.sep)
    ? [path.resolve(cwd, executable)]
    : searchPath
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.resolve(cwd, directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
};

/**
 * How this command reaches apt. `wrapped` invocations cannot be rewritten onto the
 * approved helper, so callers must reject them rather than execute them unchecked.
 */
export const packageManagerInvocation = async (
  command: CommandShape
): Promise<'direct' | 'wrapped' | undefined> => {
  const name = binaryName(command.executable);
  if (PACKAGE_MANAGERS.has(name)) return 'direct';
  if (!COMMAND_WRAPPERS.has(name)) return undefined;
  const candidates = {
    ...command,
    args: argumentTokens(command.args).map((token) => token.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, ''))
  };
  if (!firstMatch(command, PACKAGE_MANAGERS) && !firstMatch(candidates, PACKAGE_MANAGERS))
    return undefined;
  if (['bash', 'sh', 'dash'].includes(name)) {
    const index = command.args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
    const source = command.args[index + 1];
    if (
      index >= 0 &&
      source !== undefined &&
      command.args.slice(0, index).every((arg) => /^-[a-zA-Z]+$/.test(arg)) &&
      (await packageNamesAreData(source))
    )
      return undefined;
  }
  return 'wrapped';
};
