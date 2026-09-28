import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveExecutable } from './command-policy.js';
import { readWorkspaceFileLines } from './files.js';
import { forgetDisplayedLines, readerFor } from './seen-lines.js';
import {
  agentHome,
  agentSearchPath,
  execute,
  hostSearchPath,
  unclaimedStopNote
} from './execution.js';

/**
 * Stands in for garden-sandbox: consumes `run <network mode> <filesystem mode> <root> --spec
 * <path>` the way the real helper does, reads the directory, the environment and the command out
 * of the spec file - the header word, the directory, then NUL-terminated words - unlinks it,
 * enters the directory, and execs as `env -i` does.
 */
const SANDBOX_STAND_IN = `#!/bin/sh
shift 4
[ "$1" = --spec ] || exit 125
exec /usr/bin/python3 -I -S -c 'import os, sys
data = open(sys.argv[1], "rb").read()
os.unlink(sys.argv[1])
words = data.split(b"\\0")[1:-1]
os.chdir(words[0])
os.execv("/usr/bin/env", [b"env", b"-i"] + words[1:])' "$2"
`;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const workspaceRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-execution-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'workspace'));
  return root;
};

describe('bounded execution output', () => {
  it('preserves the beginning and end of oversized streams', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      {
        executable: process.execPath,
        args: ['-e', "process.stdout.write('BEGIN' + 'x'.repeat(12000) + 'END')"],
        maxOutputBytes: 4096
      },
      { maximumSeconds: 30 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BEGIN');
    expect(result.stdout).toContain('END');
    expect(result.stdout).toContain('bytes omitted from stdout');
    expect(result.stdout.length).toBeLessThan(5_000);
  });

  it('returns small streams exactly', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: process.execPath, args: ['-e', "process.stdout.write('complete')"] },
      { maximumSeconds: 30 }
    );
    expect(result.stdout).toBe('complete');
    expect(result.stderr).toBe('');
  });

  it('runs package names as literal status text without invoking the package helper', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: 'sh', args: ['-c', "echo '== apt r-base-dev =='"] },
      { maximumSeconds: 30, allowSystemPackages: false }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('== apt r-base-dev ==');
  });

  it('routes approved host package installs through the fixed helper', async () => {
    const root = await workspaceRoot();
    const helper = path.join(root, 'package-helper');
    await writeFile(helper, '#!/bin/sh\nprintf "%s" "$*"\n');
    await chmod(helper, 0o700);
    const result = await execute(
      root,
      {
        executable: 'apt-get',
        args: ['install', '-y', 'inkscape'],
        network: true
      },
      { maximumSeconds: 30, allowSystemPackages: true, systemPackageHelper: helper }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('install inkscape');
  });

  /*
   * This computer runs on four distribution families and the reader of a package command knew one
   * of them. `dnf install -y nmap` yielded `install` and was rewritten onto a helper that ran
   * apt-get, so the owner approved a dnf install and got ENOENT; `pacman -S nmap` yielded `nmap`
   * as its operation and was refused one step earlier with a sentence about apt. Two families,
   * two different wrong answers, both after the owner had said yes.
   */
  it("reads each family's own spelling of update and install, not only apt's", async () => {
    const root = await workspaceRoot();
    const helper = path.join(root, 'package-helper');
    await writeFile(helper, '#!/bin/sh\nprintf "%s" "$*"\n');
    await chmod(helper, 0o700);
    const asked = async (executable: string, args: string[]): Promise<string> =>
      (
        await execute(
          root,
          { executable, args, network: true },
          { maximumSeconds: 30, allowSystemPackages: true, systemPackageHelper: helper }
        )
      ).stdout;

    expect(await asked('dnf', ['install', '-y', 'nmap'])).toBe('install nmap');
    expect(await asked('dnf5', ['install', 'nmap', 'jq'])).toBe('install nmap jq');
    expect(await asked('zypper', ['--non-interactive', 'install', 'nmap'])).toBe('install nmap');
    expect(await asked('apk', ['add', 'nmap'])).toBe('install nmap');
    expect(await asked('pacman', ['-S', '--noconfirm', 'nmap'])).toBe('install nmap');
    expect(await asked('pacman', ['-Sy'])).toBe('update');
    expect(await asked('dnf', ['makecache'])).toBe('update');
    expect(await asked('apt-get', ['update'])).toBe('update');
  });

  /*
   * The helper does two things. An operation that is not one of them is refused rather than being
   * quietly rounded down to the nearest one that is: `dnf upgrade` and `pacman -Syu` rewrite every
   * package on the machine, and answering them with an index refresh would report success for
   * something the owner asked for and did not get.
   */
  it('refuses a package operation the approved helper cannot perform, and says so once', async () => {
    const root = await workspaceRoot();
    const refusals = [
      { executable: 'dnf', args: ['upgrade', '-y'] },
      { executable: 'pacman', args: ['-Syu', '--noconfirm'] },
      { executable: 'apt-get', args: ['upgrade'] },
      { executable: 'emerge', args: ['nmap'] },
      { executable: 'rpm', args: ['-i', 'nmap.rpm'] },
      // An install with nothing to install: the helper would refuse it a layer further down, as
      // root, which is the wrong place to discover that an argument list was empty.
      { executable: 'dnf', args: ['install', '-y'] },
      // An index refresh does not take operands; one here means the model meant something else.
      { executable: 'apt-get', args: ['update', 'nmap'] }
    ];
    for (const attempt of refusals)
      await expect(
        execute(root, attempt, {
          maximumSeconds: 30,
          allowSystemPackages: true,
          systemPackageHelper: '/usr/local/sbin/garden-system-packages'
        })
      ).rejects.toThrow('Host-native package management supports approved update and install only');
  });

  it('rejects escalation spelled with a path or hidden behind a wrapper', async () => {
    const root = await workspaceRoot();
    const attempts = [
      { executable: '/usr/bin/sudo', args: ['id'] },
      { executable: 'env', args: ['sudo', 'id'] },
      { executable: 'sh', args: ['-c', 'sudo id'] },
      { executable: 'xargs', args: ['sudo', 'id'] },
      { executable: 'nohup', args: ['sudo', 'id'] },
      { executable: 'setsid', args: ['sudo', 'id'] },
      { executable: 'nice', args: ['sudo', 'id'] },
      { executable: 'timeout', args: ['5', 'sudo', 'id'] },
      { executable: 'stdbuf', args: ['-o0', 'sudo', 'id'] },
      { executable: 'sh', args: ['-c', 'echo $(/usr/bin/su -c id)'] }
    ];
    for (const attempt of attempts)
      await expect(execute(root, attempt, { maximumSeconds: 30 })).rejects.toThrow(
        'Direct privilege escalation is disabled'
      );
  });

  it('refuses to run apt through a wrapper that would skip the approval gate', async () => {
    const root = await workspaceRoot();
    await expect(
      execute(
        root,
        { executable: 'env', args: ['apt-get', 'install', '-y', 'inkscape'] },
        {
          maximumSeconds: 30,
          allowSystemPackages: true,
          systemPackageHelper: '/usr/local/sbin/garden-system-packages'
        }
      )
    ).rejects.toThrow('Host-native package management supports approved update and install only');
  });

  it('captures output a grandchild writes after the direct child exits', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', '{ sleep 0.2; echo LATE; } & exit 0'] },
      { maximumSeconds: 30 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('LATE');
  });

  it('kills orphaned grandchildren when the command times out', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'sleep 30 & echo $!; wait'], timeoutSeconds: 1 },
      { maximumSeconds: 30 }
    );
    expect(result.timedOut).toBe(true);
    const grandchild = Number(result.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    await expect
      .poll(
        () => {
          try {
            process.kill(grandchild, 0);
            return true;
          } catch {
            return false;
          }
        },
        { interval: 25, timeout: 3_000 }
      )
      .toBe(false);
  });

  it('rejects unapproved escalation and apt option injection on the host', async () => {
    const root = await workspaceRoot();
    await expect(
      execute(root, { executable: 'sudo', args: ['id'] }, { maximumSeconds: 30 })
    ).rejects.toThrow('Direct privilege escalation is disabled');
    await expect(
      execute(
        root,
        {
          executable: 'apt-get',
          args: ['install', '-y', '-o', 'APT::Update::Pre-Invoke::=id', 'inkscape']
        },
        {
          maximumSeconds: 30,
          allowSystemPackages: true,
          systemPackageHelper: '/usr/local/sbin/garden-system-packages'
        }
      )
    ).rejects.toThrow('Package names may not contain');
  });
});

describe('command environment', () => {
  it('passes the coding CLI permission policy through and refuses anything else', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      {
        executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.OPENCODE_PERMISSION ?? "absent")'],
        env: { OPENCODE_PERMISSION: '{"bash":{"sudo *":"deny"}}' }
      },
      { maximumSeconds: 30 }
    );
    expect(result.stdout).toBe('{"bash":{"sudo *":"deny"}}');

    await expect(
      execute(
        root,
        { executable: process.execPath, args: ['-e', ''], env: { LD_PRELOAD: '/tmp/evil.so' } },
        { maximumSeconds: 30 }
      )
    ).rejects.toThrow('does not accept LD_PRELOAD');
  });
});

describe("what the agent's own search path reaches", () => {
  /** A tool where `pip install --user` puts one, made runnable the way pip makes one runnable. */
  const installUnderHome = async (root: string, directory: string, name: string): Promise<void> => {
    const bin = path.join(agentHome(root), ...directory.split('/'));
    await mkdir(bin, { recursive: true });
    const tool = path.join(bin, name);
    await writeFile(tool, `#!/bin/sh\nprintf %s ${name}\n`);
    await chmod(tool, 0o755);
  };

  /*
   * Asserted through `execute` rather than through `resolveExecutable`, because the two answer
   * different questions and only one of them is the defect. `resolveExecutable` finding the file
   * proves the runner can name it; what failed before was the child process, whose PATH comes from
   * `agentEnvironment`. A test that stopped at resolution would stay green with the environment
   * still wrong, which is exactly how an install that succeeds and a command that is then not
   * found can both be true at once.
   */
  it('runs a tool installed into $HOME/.local/bin or $HOME/bin by its bare name', async () => {
    const root = await workspaceRoot();
    await installUnderHome(root, '.local/bin', 'garden-user-installed');
    await installUnderHome(root, 'bin', 'garden-home-installed');

    for (const name of ['garden-user-installed', 'garden-home-installed']) {
      const result = await execute(root, { executable: name, args: [] }, { maximumSeconds: 30 });
      expect(result.exitCode, `${name} did not run`).toBe(0);
      expect(result.stdout).toBe(name);
    }
  });

  /*
   * The order is the content here, not decoration: an owner who installs a newer copy of a system
   * tool expects it to win, which is what every login shell does with these two directories. The
   * workspace's own node_modules/.bin stays first because it was first before this.
   */
  it('puts both home directories ahead of the system ones and behind the workspace tools', () => {
    const root = '/srv/garden/workspaces/one';
    const entries = agentSearchPath(root).split(path.delimiter);
    expect(entries[0]).toBe(
      path.join(root, 'workspace', '.garden', 'tools', 'node_modules', '.bin')
    );
    expect(entries.indexOf(path.join(agentHome(root), '.local', 'bin'))).toBe(1);
    expect(entries.indexOf(path.join(agentHome(root), 'bin'))).toBe(2);
    expect(entries.indexOf('/usr/local/sbin')).toBe(3);
    expect(entries.at(-1)).toBe('/bin');
  });

  /*
   * The split, stated as the difference between the two lists rather than as a copy of one of them.
   * Every entry `agentSearchPath` has that this does not is a directory `scripts/garden-sandbox`
   * grants the agent write on, and every entry they share is a system one. That is the whole claim
   * the helpers in audio.ts, render-proof.ts and toolchain.ts now rest on, so it is asserted as a
   * set difference: a fourth agent-writable entry added to that list later fails here.
   */
  it('leaves every directory the agent can write off the list the runner spawns from', () => {
    const root = '/srv/garden/workspaces/one';
    const host = hostSearchPath.split(path.delimiter);
    expect(host).toEqual([
      '/usr/local/sbin',
      '/usr/local/bin',
      '/usr/sbin',
      '/usr/bin',
      '/sbin',
      '/bin'
    ]);
    expect(
      agentSearchPath(root)
        .split(path.delimiter)
        .filter((entry) => !host.includes(entry))
    ).toEqual([
      path.join(root, 'workspace', '.garden', 'tools', 'node_modules', '.bin'),
      path.join(agentHome(root), '.local', 'bin'),
      path.join(agentHome(root), 'bin')
    ]);
    for (const entry of host) {
      expect(entry.startsWith(path.join(root, 'workspace'))).toBe(false);
      expect(entry.startsWith(agentHome(root))).toBe(false);
    }
  });

  /*
   * The counter-direction, in one case so the two cannot drift apart: the reason `$HOME/.local/bin`
   * is on the agent's list at all is that a `pip install --user` or a symlinked venv entry point
   * has to be runnable by name afterwards, and that has to survive the split. Asserted through
   * `execute` for the reason above, and against `hostSearchPath` by resolution, because resolution
   * is the whole of what the runner's helpers ask of a list.
   */
  it('still runs what the agent installed under $HOME, and hides it from the runner', async () => {
    const root = await workspaceRoot();
    await installUnderHome(root, '.local/bin', 'garden-user-installed');

    const result = await execute(
      root,
      { executable: 'garden-user-installed', args: [] },
      { maximumSeconds: 30 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('garden-user-installed');
    expect(await resolveExecutable('garden-user-installed', hostSearchPath, root)).toBe(undefined);
  });
});

describe('agent sandbox', () => {
  /**
   * Stands in for sudo: records what it was asked to run, and beside it the directory it was
   * started from - the two things the real one writes to the journal - then runs it.
   */
  const recordingElevator = async (root: string, record: string): Promise<string> => {
    const elevate = path.join(root, 'elevate');
    await writeFile(
      elevate,
      `#!/bin/sh\nprintf '%s\\n' "$*" >"${record}"\nprintf '%s' "$PWD" >"${record}.pwd"\nshift\nexec "$@"\n`
    );
    await chmod(elevate, 0o700);
    return elevate;
  };

  it('runs an ordinary command through the privileged helper', async () => {
    const root = await workspaceRoot();
    const record = path.join(root, 'elevated');
    const elevate = await recordingElevator(root, record);
    const helper = path.join(root, 'sandbox');
    // Stands in for garden-sandbox: drops its own four leading arguments the way the real helper
    // consumes `run <network mode> <filesystem mode> <root>`, then applies the environment and
    // execs, as `env -i` does.
    await writeFile(helper, SANDBOX_STAND_IN);
    await chmod(helper, 0o700);

    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'printf "%s" "$HOME"'] },
      { maximumSeconds: 30, sandbox: { elevate, helper, specDirectory: path.join(root, 'specs') } }
    );

    expect(result.exitCode).toBe(0);
    // `.home` at the container root: beside `workspace/` rather than inside it, so a toolchain's
    // caches are not walked by the checkpoint, and named in the Landlock write grant of its own
    // accord. It used to be the container root itself. server.test.ts is where the location is
    // pinned; this asserts only that the command is given the home the runner made.
    expect(result.stdout).toBe(agentHome(root));
    const elevated = await readFile(record, 'utf8');
    expect(elevated).toContain(`-n ${helper} run network open -`);
    // The home reached the command - the stdout assertion above is what says so - without ever
    // standing on sudo's argument list, which is what the system journal records of every
    // privileged invocation. sandbox.test.ts pins the whole absence; this is the production path.
    expect(elevated).not.toContain('HOME=');
    expect(elevated).not.toContain('/bin/sh');
  });

  it('starts sudo from the container root and enters the chosen directory inside the helper', async () => {
    // sudo's journal line carries the directory it was started from, and the runner started it
    // from the directory the agent chose - so a name used inside a task, which the privacy
    // document says the box's logs hold none of, was written there for every command. The
    // command still runs where it asked to: the helper enters that directory from the spec, after
    // sudo has written its line.
    const root = await workspaceRoot();
    const chosen = path.join(root, 'workspace', 'acme-lawsuit-discovery');
    await mkdir(chosen);
    const record = path.join(root, 'elevated');
    const elevate = await recordingElevator(root, record);
    const helper = path.join(root, 'sandbox');
    await writeFile(helper, SANDBOX_STAND_IN);
    await chmod(helper, 0o700);

    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'pwd -P'], cwd: 'acme-lawsuit-discovery' },
      { maximumSeconds: 30, sandbox: { elevate, helper, specDirectory: path.join(root, 'specs') } }
    );

    expect(result.exitCode).toBe(0);
    expect(await realpath(result.stdout.trim())).toBe(await realpath(chosen));
    expect(await realpath(await readFile(`${record}.pwd`, 'utf8'))).toBe(await realpath(root));
    expect(await readFile(record, 'utf8')).not.toContain('acme-lawsuit-discovery');
  });

  it('confines the command to its own workspace when the box says it can', async () => {
    // The production call site, and the reason this assertion is here rather than only in
    // sandbox.test.ts: the confinement root is not a caller's argument, it is the workspace
    // `execute` was invoked for, and a helper test that passed one in by hand would pass while
    // this path handed the helper the wrong tree or none at all.
    const root = await workspaceRoot();
    const record = path.join(root, 'elevated');
    const elevate = await recordingElevator(root, record);
    const helper = path.join(root, 'sandbox');
    await writeFile(helper, SANDBOX_STAND_IN);
    await chmod(helper, 0o700);

    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'true'] },
      {
        maximumSeconds: 30,
        sandbox: {
          elevate,
          helper,
          specDirectory: path.join(root, 'specs'),
          confineFilesystem: true
        }
      }
    );

    expect(result.exitCode).toBe(0);
    expect(await readFile(record, 'utf8')).toContain(`run network confine ${root}`);
  });

  it('asks for no confinement on a box whose installer found no way to enforce one', async () => {
    // The other direction, and the one that decides whether this ships. A kernel without Landlock
    // makes setpriv exit before the command runs, so the helper must be asked for `open` there -
    // an unenforceable boundary has to become no boundary rather than no commands.
    const root = await workspaceRoot();
    const record = path.join(root, 'elevated');
    const elevate = await recordingElevator(root, record);
    const helper = path.join(root, 'sandbox');
    await writeFile(helper, SANDBOX_STAND_IN);
    await chmod(helper, 0o700);

    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'printf ran'] },
      {
        maximumSeconds: 30,
        sandbox: {
          elevate,
          helper,
          specDirectory: path.join(root, 'specs'),
          confineFilesystem: false
        }
      }
    );

    expect(result.stdout).toBe('ran');
    const elevated = await readFile(record, 'utf8');
    expect(elevated).toContain(`run network open -`);
    expect(elevated).not.toContain('confine');
  });

  /*
   * The ease-of-use half of the filesystem boundary, at the production call site rather than at the
   * helper: `execute` is what has the workspace root and the resolved sandbox in hand, and a helper
   * test would pass while nothing ever called it.
   *
   * There is no kernel here to produce a real EACCES, so the denial's own words are what the fake
   * command prints - which is honest about what the production code reads, because it reads the
   * command's stderr and nothing else. What is being pinned is the decision: which denials get the
   * sentence and which get silence.
   */
  const denyingCommand = (message: string) => ({
    executable: '/bin/sh',
    args: ['-c', `printf '%s\\n' "${message}" >&2; exit 1`]
  });
  const sandboxedRun = async (
    message: string,
    confineFilesystem: boolean
  ): Promise<{ root: string; stderr: string }> => {
    const root = await workspaceRoot();
    const record = path.join(root, 'elevated');
    const elevate = await recordingElevator(root, record);
    const helper = path.join(root, 'sandbox');
    await writeFile(helper, SANDBOX_STAND_IN);
    await chmod(helper, 0o700);
    const result = await execute(root, denyingCommand(message), {
      maximumSeconds: 30,
      sandbox: { elevate, helper, specDirectory: path.join(root, 'specs'), confineFilesystem }
    });
    expect(result.exitCode).toBe(1);
    return { root, stderr: result.stderr };
  };

  it('says a refusal came from the sandbox when the path it names is outside the grant', async () => {
    const { stderr } = await sandboxedRun(
      'cat: /home/garden/00000000-0000-4000-8000-00000000000a/workspace/notes.md: Permission denied',
      true
    );
    expect(stderr).toContain('the sandbox on this computer probably refused that');
    // The path is quoted back, because a command that touched several files needs to know which
    // one, and the sentence is otherwise indistinguishable from a general note about the box.
    expect(stderr).toContain(
      '/home/garden/00000000-0000-4000-8000-00000000000a/workspace/notes.md'
    );
    // The command's own message survives ahead of it: the note is added to the stream, not put in
    // place of it.
    expect(stderr).toContain('Permission denied');

    // The other load-bearing true case, and the reason the grant list may not simply grow until
    // everything is silent: `.garden` is the checkpoints and the browser profile's parent, it sits
    // at the container root beside the two directories that ARE granted, and a command that meets
    // it has met the boundary rather than a mode bit. Written as an installed-host path rather than
    // built from this test's root, because a temporary root here lives under `/var`, which the
    // ruleset grants for reading - so a root-derived path would be silenced by the read list and
    // would pin nothing.
    const own = await sandboxedRun(
      'tar: /home/garden/00000000-0000-4000-8000-00000000000a/.garden/checkpoints: Cannot open: Permission denied',
      true
    );
    expect(own.stderr).toContain('the sandbox on this computer probably refused that');
  });

  it('stays silent on a denial inside the grant, and on a box that confines nothing', async () => {
    // The direction that decides whether this can ship. A mode bit inside the workspace, a file the
    // owner made root-owned, a directory the agent account genuinely may not write - all of those
    // print exactly the same words, and telling their reader "the sandbox refused that" would be a
    // false explanation of a real problem, which is worse than the silence it replaced.
    const inside = await sandboxedRun('DENIED_INSIDE Permission denied', true);
    const stderr = (
      await execute(
        inside.root,
        denyingCommand(
          `cat: ${path.join(inside.root, 'workspace', 'notes.md')}: Permission denied`
        ),
        {
          maximumSeconds: 30,
          sandbox: {
            elevate: path.join(inside.root, 'elevate'),
            helper: path.join(inside.root, 'sandbox'),
            specDirectory: path.join(inside.root, 'specs'),
            confineFilesystem: true
          }
        }
      )
    ).stderr;
    expect(stderr).not.toContain('the sandbox on this computer');
    // A denial naming no path at all is a silence too, rather than a guess.
    expect(inside.stderr).not.toContain('the sandbox on this computer');
    // And nothing is said on a box that never applied a ruleset, where the sentence would be a
    // plain fabrication.
    //
    // THE PATH HAS TO BE ONE THAT WOULD OTHERWISE EARN THE SENTENCE, which is why it is a
    // neighbouring workspace and not `/etc/shadow`. This assertion was written with `/etc/shadow`
    // and pinned nothing: `/etc` is in the grant list, so that message is silent on a confined box
    // too, and the assertion held with the `confined` question deleted from both places that ask
    // it - measured, with the whole of this file still green while the same case at
    // `ProcessManager.start` went red. A silence test whose message is silent for a second reason
    // is a silence test about the second reason.
    const unconfined = await sandboxedRun(
      'cat: /home/garden/00000000-0000-4000-8000-00000000000a/workspace/notes.md: Permission denied',
      false
    );
    expect(unconfined.stderr).not.toContain('the sandbox on this computer');
  });

  it('stays silent on a denial in a directory the ruleset grants for reading', async () => {
    // The saturation the test above leaves standing. It asks about `/etc/shadow` only on a box that
    // confines nothing, so it holds while the same message on a CONFINED box gets the sentence -
    // and the ruleset grants `/etc` for reading, so that denial is a mode bit and the sentence is a
    // lie. It is a lie that contradicts itself in its own second clause, which offers "may read the
    // system directories" as the reason `/etc/shadow` is out of reach.
    const shadow = await sandboxedRun('cat: /etc/shadow: Permission denied', true);
    expect(shadow.stderr).not.toContain('the sandbox on this computer');

    // The same defect in the shape it will actually arrive in. An interpreter names its own path
    // ahead of the file it could not open, so the first absolute token on the line is the
    // interpreter's - and the file itself is inside the workspace, which is the case the test above
    // requires silence for. Whichever token the note quotes, the answer here is nothing.
    const interpreter = await workspaceRoot();
    const record = path.join(interpreter, 'elevated');
    const elevate = await recordingElevator(interpreter, record);
    const helper = path.join(interpreter, 'sandbox');
    await writeFile(helper, SANDBOX_STAND_IN);
    await chmod(helper, 0o700);
    const result = await execute(
      interpreter,
      denyingCommand(
        `/usr/bin/python3: can't open file ${path.join(interpreter, 'workspace', 'build.py')}: [Errno 13] Permission denied`
      ),
      {
        maximumSeconds: 30,
        sandbox: {
          elevate,
          helper,
          specDirectory: path.join(interpreter, 'specs'),
          confineFilesystem: true
        }
      }
    );
    expect(result.stderr).not.toContain('the sandbox on this computer');
  });

  it('asks for a network namespace when the command did not ask for the network', async () => {
    const root = await workspaceRoot();
    const record = path.join(root, 'elevated');
    const elevate = await recordingElevator(root, record);
    const helper = path.join(root, 'sandbox');
    await writeFile(helper, SANDBOX_STAND_IN);
    await chmod(helper, 0o700);

    await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'true'] },
      {
        maximumSeconds: 30,
        isolateNetwork: true,
        sandbox: {
          elevate,
          helper,
          specDirectory: path.join(root, 'specs'),
          confineFilesystem: true
        }
      }
    );
    // Both boundaries on one exec line, which is the whole shape of this helper: the namespace and
    // the ruleset are asked for together or a command gets whichever one the caller remembered.
    expect(await readFile(record, 'utf8')).toContain(`-n ${helper} run isolated confine ${root}`);
  });

  it('keeps the approved package install on the runner account, which is the only way it works', async () => {
    // The install reaches root through sudo, which the sandbox deliberately makes impossible,
    // so this one command has to keep the runner's own identity.
    const root = await workspaceRoot();
    const record = path.join(root, 'elevated');
    const elevate = await recordingElevator(root, record);
    const packageHelper = path.join(root, 'package-helper');
    await writeFile(packageHelper, '#!/bin/sh\nprintf "%s" "$*"\n');
    await chmod(packageHelper, 0o700);

    const result = await execute(
      root,
      { executable: 'apt-get', args: ['install', '-y', 'inkscape'] },
      {
        maximumSeconds: 30,
        allowSystemPackages: true,
        systemPackageHelper: packageHelper,
        sandbox: {
          elevate,
          helper: path.join(root, 'sandbox'),
          specDirectory: path.join(root, 'specs')
        }
      }
    );

    expect(result.stdout).toBe('install inkscape');
    await expect(readFile(record, 'utf8')).rejects.toThrow();
  });

  it('refuses a command that names a privileged helper directly', async () => {
    // The package helper reaches root with no capability scope and no approval of its own. It is
    // reached by the runner, after both, or not at all.
    const root = await workspaceRoot();
    const packageHelper = path.join(root, 'package-helper');
    await writeFile(packageHelper, '#!/bin/sh\nexit 0\n');
    await chmod(packageHelper, 0o755);
    const attempts = [
      { executable: packageHelper, args: ['install', 'openssh-server'] },
      { executable: 'sh', args: ['-c', `${packageHelper} install openssh-server`] }
    ];
    for (const attempt of attempts)
      await expect(
        execute(root, attempt, { maximumSeconds: 30, systemPackageHelper: packageHelper })
      ).rejects.toThrow('privileged helpers are reached by the runner');
  });

  it('follows a symbolic link before deciding a command is harmless', async () => {
    const root = await workspaceRoot();
    const impostor = path.join(root, 'workspace', 'sudo');
    await writeFile(impostor, '#!/bin/sh\nexit 0\n');
    await chmod(impostor, 0o755);
    await symlink(impostor, path.join(root, 'workspace', 's'));
    await expect(
      execute(root, { executable: './s', args: ['id'] }, { maximumSeconds: 30 })
    ).rejects.toThrow('Direct privilege escalation is disabled');
  });
});

/*
 * The half of the confinement note's grant list that no test above can reach, and why this one is
 * not written at a production call site the way every other assertion in this file is.
 *
 * The note asks whether the path a denial names lies outside EVERY hierarchy the ruleset grants,
 * and two of those are derived from the workspace the command was run for: `<root>/workspace` and
 * `<root>/.home`. Every test in this file builds its root with `mkdtemp(tmpdir())`, which is
 * `/tmp` on Linux and `/var/folders/...` on macOS - and `/tmp` and `/var` are each in the grant
 * list in their own right. So on both hosts this suite runs on, a root-derived path is silenced by
 * the SYSTEM half of the list no matter what the workspace half says. Measured rather than
 * supposed: deleting both workspace-derived entries left all 152 tests in this package green,
 * while on the installed host - root `/home/garden/<id>`, `/home` granted nowhere - their absence
 * would put the sentence on every ordinary mode bit inside a task's own `workspace/`, which is the
 * exact lie the grant list was widened to stop telling.
 *
 * There is no writable directory on either host that lies outside those granted hierarchies, so a
 * root shaped like an installed one cannot be a real directory here, and `execute` needs a real
 * one. `unclaimedStopNote` is the seam both production paths call, and each path's call is pinned
 * by its own test - this file's `agent sandbox` block and processes.test.ts's background pair, both
 * watched going red with the call removed. What is left is the answer, for the root shape only the
 * installed host has.
 *
 * The first assertion of each pair is the guard that keeps this from being another silence that
 * proves nothing: the same root, one level above `workspace/`, still speaks. So a silence below it
 * is attributable to the two workspace-derived entries and not to a system hierarchy that happened
 * to cover the path.
 */
describe('the workspace half of the confinement grant list', () => {
  const installedRoot = '/home/garden/00000000-0000-4000-8000-00000000000a';
  const denialOf = (file: string) => ({
    stderr: () => `cat: ${file}: Permission denied`,
    exitCode: 1,
    signal: null,
    claimed: false,
    cancelled: false
  });
  const noteFor = (file: string): string | undefined =>
    unclaimedStopNote(denialOf(file), installedRoot, true);

  it('speaks for the container root that holds the undo point', () => {
    expect(noteFor(`${installedRoot}/notes.md`)).toContain('the sandbox on this computer');
    expect(noteFor(`${installedRoot}/.garden/checkpoints/turn-4`)).toContain(
      'the sandbox on this computer'
    );
    expect(noteFor('/home/garden/00000000-0000-4000-8000-00000000000b/workspace/x')).toContain(
      'the sandbox on this computer'
    );
  });

  it('stays silent inside the two directories that command may write', () => {
    // A mode bit on a file the owner uploaded read-only, an npm cache directory the last run left
    // owned by another account: real problems, inside the grant, and answering them with "the
    // sandbox refused that" sends the reader to look for a boundary that is not involved.
    expect(noteFor(`${installedRoot}/workspace/notes.md`)).toBeUndefined();
    expect(noteFor(`${installedRoot}/.home/.cargo/registry/index`)).toBeUndefined();
  });
});

describe('resource limits', () => {
  it('runs the command under the host limiter with every cap applied', async () => {
    const root = await workspaceRoot();
    const limiter = path.join(root, 'limiter');
    const record = path.join(root, 'limiter-args');
    // Stands in for prlimit: records the limits it was handed, then execs the real command the
    // same way prlimit does, so the wrapping is proven end to end rather than by inspection.
    await writeFile(
      limiter,
      `#!/bin/sh\nargs=""\nwhile [ "$1" != "--" ]; do args="$args $1"; shift; done\nshift\nprintf '%s' "$args" >"${record}"\nexec "$@"\n`
    );
    await chmod(limiter, 0o700);

    const result = await execute(
      root,
      { executable: process.execPath, args: ['-e', "process.stdout.write('ran')"] },
      {
        maximumSeconds: 30,
        guards: {
          limiter,
          limits: {
            memoryBytes: 1024 ** 3,
            processes: 512,
            openFiles: 2048
          }
        }
      }
    );

    expect(result.stdout).toBe('ran');
    const applied = await readFile(record, 'utf8');
    expect(applied).toContain(`--data=${1024 ** 3}`);
    // No `--fsize`, pinned at the production call site rather than only on the helper that builds
    // the argument list: this is where a per-file ceiling would actually reach a command.
    expect(applied).not.toContain('--fsize');
    expect(applied).toContain('--nproc=512');
    expect(applied).toContain('--nofile=2048');
    expect(applied).toContain('--core=0');
  });

  it('runs unwrapped when the host has no limiter, rather than failing the command', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: process.execPath, args: ['-e', "process.stdout.write('ran')"] },
      {
        maximumSeconds: 30,
        guards: { limits: { memoryBytes: 1, processes: 1, openFiles: 1 } }
      }
    );
    expect(result.stdout).toBe('ran');
  });

  it('stops a command that is consuming the last of the host disk', async () => {
    // The pre-flight check cannot catch this: the disk was healthy when the command started and
    // the command is what fills it. Left alone it takes PostgreSQL and the interface down too.
    const root = await workspaceRoot();
    let reads = 0;
    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 },
      {
        maximumSeconds: 30,
        guards: {
          hostStoragePollMs: 25,
          hostStorage: async () => ({
            hostStorageTotalBytes: 100 * 1024 ** 3,
            // Healthy for the first few polls, then past the floor.
            hostStorageAvailableBytes: ++reads > 2 ? 64 * 1024 ** 2 : 50 * 1024 ** 3
          })
        }
      }
    );

    expect(result.stoppedReason).toBe('host_disk_floor');
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain('last of the host disk');
  });

  /*
   * The fifth stop, which nothing in this process performs and which the memory ceiling made the
   * likely one. A cgroup out-of-memory kill arrives as `exitCode: null`, `signal: "SIGKILL"` and
   * two empty streams - byte-for-byte a segfault, and the two want opposite responses. Driven with
   * a command that kills itself, because that is the same delivery the kernel uses and the only
   * one reproducible without a cgroup.
   */
  it('says so when a command is killed outright rather than exiting', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'kill -9 $$'], timeoutSeconds: 30 },
      { maximumSeconds: 30 }
    );

    expect(result.signal).toBe('SIGKILL');
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain('killed outright by the computer');
    // The move that follows, which is the whole reason the sentence exists: the wrong one is to
    // run the identical 64-way job again and be killed at the same point.
    expect(result.stderr).toContain('fewer threads');
  });

  /*
   * And not when this process was the one that killed it. All three stops it performs - the
   * timeout, the owner's cancel and the disk floor - end in SIGKILL by way of `stopProcessTree`,
   * so a note keyed on the signal alone would overwrite every one of their sentences with a guess
   * about memory. This is the cancel, which is the one with no flag in the result to rule it out.
   */
  it('does not blame memory for a command the owner cancelled', async () => {
    const root = await workspaceRoot();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 },
      { maximumSeconds: 30, abortSignal: controller.signal }
    );

    expect(result.stderr).not.toContain('killed outright by the computer');
  });

  it('leaves a healthy disk alone', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: process.execPath, args: ['-e', "process.stdout.write('fine')"] },
      {
        maximumSeconds: 30,
        guards: {
          hostStoragePollMs: 25,
          hostStorage: async () => ({
            hostStorageTotalBytes: 100 * 1024 ** 3,
            hostStorageAvailableBytes: 60 * 1024 ** 3
          })
        }
      }
    );
    expect(result.stoppedReason).toBeUndefined();
    expect(result.stdout).toBe('fine');
  });
});

describe('cancellation', () => {
  it('kills a running command when the caller aborts', async () => {
    // Before this, Cancel only stopped the worker waiting for the result. The command itself ran
    // to completion on the box - still writing files, still reaching the network - long after the
    // interface said the task had stopped.
    const root = await workspaceRoot();
    const controller = new AbortController();
    const started = Date.now();
    const running = execute(
      root,
      {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        timeoutSeconds: 60
      },
      { maximumSeconds: 120, abortSignal: controller.signal }
    );
    setTimeout(() => controller.abort(), 250);
    const result = await running;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  /*
   * The assertion above only proves the wrapper stopped. What a cancelled turn has to leave behind
   * is nothing at all, and a shell's background job is the ordinary case - `npm run dev &`, a
   * scraper, a `tail -f`. Commands are spawned detached so that the whole group can be signalled;
   * this is the test that says the group, and not only the leader, actually goes.
   */
  it('takes the whole process group with it, not only the command it started', async () => {
    const root = await workspaceRoot();
    const controller = new AbortController();
    const running = execute(
      root,
      {
        executable: '/bin/sh',
        args: ['-c', 'sleep 30 & echo $!; sleep 30'],
        timeoutSeconds: 60
      },
      { maximumSeconds: 120, abortSignal: controller.signal }
    );
    setTimeout(() => controller.abort(), 400);
    const result = await running;
    expect(result.timedOut).toBe(false);
    const grandchild = Number(result.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    await expect
      .poll(
        () => {
          try {
            process.kill(grandchild, 0);
            return true;
          } catch {
            return false;
          }
        },
        { interval: 25, timeout: 5_000 }
      )
      .toBe(false);
  });

  it('does not start a command that was already cancelled before it ran', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        timeoutSeconds: 60
      },
      { maximumSeconds: 120, abortSignal: AbortSignal.abort() }
    );
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });
});

describe('a service declared without a background', () => {
  /*
   * `shell(service: 'dev server')` without `background: true` used to run in the foreground for
   * five minutes and return an ordinary exec result. The key was not in the schema, so it was
   * stripped: no error, no service, no record, and a model that believed it had declared one.
   */
  it('is refused rather than run as an ordinary command', async () => {
    const root = await workspaceRoot();
    await expect(
      execute(
        root,
        { executable: process.execPath, args: ['-e', ''], service: 'dev server' },
        { maximumSeconds: 30 }
      )
    ).rejects.toThrow(/background/);
  });
});

/**
 * The wall clock, which was the bound that stopped the work this computer is for.
 *
 * Two ceilings rather than one, because the two paths cost different things: a foreground command
 * holds the turn and an HTTP request in the worker open for its whole run, and a background one
 * holds neither. The hour they used to share was a property of the first written onto the second.
 */
describe('the foreground time ceiling', () => {
  it('says which bound stopped the command, on the command’s own stderr', async () => {
    /*
     * It said nothing. A run killed at its deadline came back as `timedOut: true` beside an empty
     * stderr and a null exit code, which names neither the bound nor its size nor the fact that a
     * longer run has somewhere else to go - so a model reading it cannot tell a deadline from a
     * crash, and the cheapest wrong move is to start the whole six hours again. The disk floor and
     * the owner's cancel have always said their piece here; this is the same sentence for the stop
     * that had none.
     */
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 1 },
      { maximumSeconds: 1 }
    );

    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain('1s timeout');
    // The way out, named: this is the field that turns an hour into a day.
    expect(result.stderr).toContain('background: true');
  });

  it('refuses a run it could never finish rather than killing it part-way', async () => {
    // The enforcement is `Math.min(request.timeoutSeconds, maximumSeconds)`, and a clamp is silent
    // by construction: asking for six hours and being killed at one reports exactly as asking for
    // one. Refusing costs a round trip and names the field to change; clamping costs the hour.
    const root = await workspaceRoot();
    await expect(
      execute(
        root,
        { executable: process.execPath, args: ['-e', ''], timeoutSeconds: 21_600 },
        { maximumSeconds: 3_600 }
      )
    ).rejects.toThrow(/background: true/);
  });

  it('answers only for a timeout somebody actually asked for', async () => {
    /*
     * The other direction, and the one that would have broken every caller on this repository. The
     * schema defaults `timeoutSeconds` to 300 and a host may be configured below that - every
     * runner test here runs at 30 - so a refusal read from the PARSED request would refuse
     * commands whose caller never named a timeout at all. Only a number somebody wrote is answered
     * for; everything else is clamped to the ceiling and runs.
     */
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: process.execPath, args: ['-e', "process.stdout.write('ran')"] },
      { maximumSeconds: 30 }
    );
    expect(result.stdout).toBe('ran');
  });
});

describe('the argument list', () => {
  /*
   * It was capped at 256, undeclared in the catalogue and refused with a raw schema failure. A
   * `samtools merge` over three thousand per-contig shards is 3,002 arguments and an ordinary
   * shape in the work this box exists for, so the cap refused a routine command and explained
   * itself in machine noise. Nothing was protected by it: the real bound on an argument list is
   * the kernel's ARG_MAX, and the body carrying it is bounded before this by Fastify's bodyLimit.
   */
  it('carries a scatter-gather’s worth of arguments', async () => {
    const root = await workspaceRoot();
    const args = ['-e', 'process.stdout.write(String(process.argv.length - 1))'];
    for (let index = 0; index < 2_000; index += 1) args.push(`shard-${index}.bam`);
    const result = await execute(
      root,
      { executable: process.execPath, args },
      {
        maximumSeconds: 30
      }
    );
    expect(result.stdout).toBe('2000');
  });

  it('still has a ceiling, so an unbounded list is refused rather than handed to the kernel', async () => {
    const root = await workspaceRoot();
    const args = Array.from({ length: 8_193 }, (_, index) => `shard-${index}.bam`);
    await expect(
      execute(root, { executable: process.execPath, args }, { maximumSeconds: 30 })
    ).rejects.toThrow();
  });
});

/**
 * WHAT THIS ROUTE DELIBERATELY DOES NOT CONSULT, as a case that fails the day it starts to.
 *
 * The seen-line ledger holds an agent's whole-file write to what that agent has been shown, and a
 * redirect reaches the disk without passing through the write route the ledger guards. This route
 * has no shell parser and is not given one: the worker already reads every command through one
 * (`effectiveCommands`), and a second reading of the same script in a second process is two things
 * to keep in agreement, which is the defect shape this repository names most often. So the worker
 * is where a shell command is held to the read record, before it is sent, and this route runs what
 * it is sent. The case below is the measurement that says so; a runner that grows an opinion here
 * turns it red, and the lane that does it then has to say why the worker's floor stopped being
 * enough.
 */
describe('what execution does not consult', () => {
  it('runs a redirect over a file the caller has been shown only part of', async () => {
    forgetDisplayedLines();
    const root = await workspaceRoot();
    const target = path.join(root, 'workspace', 'app.ts');
    await writeFile(
      target,
      `${Array.from({ length: 400 }, (_, at) => `line ${at + 1}`).join('\n')}\n`
    );
    const reader = readerFor({ role: 'agent', sub: 'task-shell' });
    const window = await readWorkspaceFileLines(root, 'workspace/app.ts', {
      startLine: 1,
      endLine: 50,
      maxBytes: 100_000,
      shownTo: reader
    });
    expect(window.endLine).toBe(50);

    const result = await execute(
      root,
      { executable: 'bash', args: ['-c', 'echo x > app.ts'], cwd: 'workspace' },
      { maximumSeconds: 30 }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(await readFile(target, 'utf8')).toBe('x\n');
  });
});

/**
 * WHERE A COMMAND'S `cwd` IS READ FROM, held to the same answer the file tools give.
 *
 * A bare file name means `workspace/<name>` to `file_write`, because commands run in `workspace/`
 * and that is where an agent that has just listed its own directory means. Read against the
 * container root - the obvious resolution, and the one every other path here gets - a bare `cwd`
 * is one level up from that, where nothing of the agent's lives, so `probe` and `workspace/probe`
 * would name one file to the file tools and two directories to the shell. Measured on a live box:
 * six of ten tasks spent a third of their tool calls on exactly that, and a shadow
 * `workspace/workspace/` tree had stood for weeks. So both spellings land in one directory, while
 * `.garden`, the agent's own home and every absolute path resolve as written and the escape
 * refusal stands.
 */
describe('the directory a command runs in', () => {
  const printCwd = { executable: process.execPath, args: ['-p', 'process.cwd()'] };

  it('reads a bare cwd from workspace/, where the file tools read a bare name', async () => {
    const root = await workspaceRoot();
    await mkdir(path.join(root, 'workspace', 'probe'));
    const bare = await execute(root, { ...printCwd, cwd: 'probe' }, { maximumSeconds: 30 });
    const spelled = await execute(
      root,
      { ...printCwd, cwd: 'workspace/probe' },
      { maximumSeconds: 30 }
    );
    expect(bare.exitCode).toBe(0);
    expect(spelled.exitCode).toBe(0);
    expect(bare.stdout.trim()).toBe(spelled.stdout.trim());
    expect(await realpath(bare.stdout.trim())).toBe(
      await realpath(path.join(root, 'workspace', 'probe'))
    );
  });

  it('leaves the container-only directories and the default where they were', async () => {
    const root = await workspaceRoot();
    await mkdir(path.join(root, '.garden', 'artifacts'), { recursive: true });
    for (const [cwd, expected] of [
      ['workspace', ['workspace']],
      ['.', []],
      ['./', []],
      ['.garden/artifacts', ['.garden', 'artifacts']],
      [path.join(root, 'workspace'), ['workspace']]
    ] as const) {
      const result = await execute(root, { ...printCwd, cwd }, { maximumSeconds: 30 });
      expect(result.exitCode, cwd).toBe(0);
      expect(await realpath(result.stdout.trim()), cwd).toBe(
        await realpath(path.join(root, ...expected))
      );
    }
  });

  /*
   * `.` is the container root and not a bare name. The document reader and the office converter
   * are both run from `.` with a `workspace/…` path on their command line, and each resolves that
   * path against its own working directory and refuses anything outside it - so a `.` read as
   * `workspace/` makes `document_search` with its default path, and every `document_read` written
   * the way the catalogue spells paths, fail with "not a regular file" on a file that is there.
   */
  it('keeps . at the container root, where the document reader resolves workspace/ paths', async () => {
    const root = await workspaceRoot();
    await writeFile(path.join(root, 'workspace', 'notes.txt'), 'hello\n');
    const seen = await execute(
      root,
      {
        executable: process.execPath,
        args: [
          '-p',
          "require('node:fs').existsSync(require('node:path').resolve('workspace/notes.txt'))"
        ],
        cwd: '.'
      },
      { maximumSeconds: 30 }
    );
    expect(seen.exitCode).toBe(0);
    expect(seen.stdout.trim()).toBe('true');
  });

  it('still refuses a cwd that steps out of the container', async () => {
    const root = await workspaceRoot();
    await expect(
      execute(root, { ...printCwd, cwd: '../x' }, { maximumSeconds: 30 })
    ).rejects.toThrow('escapes workspace');
    await expect(
      execute(root, { ...printCwd, cwd: 'workspace/../../x' }, { maximumSeconds: 30 })
    ).rejects.toThrow('escapes workspace');
  });
});
