import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentHome } from './execution.js';
import { ProcessManager } from './processes.js';

/**
 * Stands in for garden-sandbox: consumes `run <network mode> <filesystem mode> <root> --spec
 * <path>` the way the real helper does, reads the directory, the environment and the command out
 * of the spec file - the header word, the directory, then NUL-terminated words - unlinks it,
 * enters the directory, and execs as `env -i` does.
 */
const SANDBOX_STAND_IN = `#!/bin/sh
shift 4
[ "$1" = --spec ] || exit 125
exec /usr/bin/python3 -I -S -c 'import os, sys, json, subprocess
data = open(sys.argv[1], "rb").read()
os.unlink(sys.argv[1])
words = data.split(b"\\0")[1:-1]
os.chdir(words[0])
lease = sys.argv[1][:-5] + ".lease"
if os.path.exists(lease):
    result = subprocess.run([b"env", b"-i"] + words[1:])
    record = json.load(open(lease))
    record["phase"] = "reaped"
    with open(lease, "w") as output:
        json.dump(record, output)
    sys.exit(result.returncode)
os.execv("/usr/bin/env", [b"env", b"-i"] + words[1:])' "$2"
`;

const roots: string[] = [];

/**
 * Long enough that a loaded machine cannot fail it, short enough to still fail.
 *
 * A session reaches a terminal status the moment its process ends and its pipes drain, so these
 * polls normally return in a few milliseconds. The ceiling exists only so a hang reports as one.
 */
const SETTLE_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 20_000;

/**
 * A flush grace the drain test cannot reach: it outlives the test's own timeout, so the only way
 * to reach the assertion is the pipe actually closing, and the only way to fail is a hang, which
 * the timeout reports as one.
 *
 * Against the shipped 1s bound with a fixture that slept 200ms, this test would be a race between
 * the machine's fork latency and a production constant rather than a statement about the manager,
 * and losing that race under a full parallel run reads as an empty log rather than as the timing
 * accident it is.
 */
const UNREACHABLE_FLUSH_GRACE_MS = TEST_TIMEOUT_MS * 10;

const settledStatus = async (
  manager: ProcessManager,
  sessionId: string
): Promise<{
  status: string;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}> => {
  await expect
    .poll(() => manager.action('workspace-1', 'task-1', sessionId, { action: 'poll' }).status, {
      interval: 10,
      timeout: SETTLE_TIMEOUT_MS
    })
    .not.toBe('running');
  return manager.action('workspace-1', 'task-1', sessionId, { action: 'poll' });
};

/*
 * Retried, because `close()` is synchronous and the service records behind it are not: a supervisor
 * can still be writing `.garden/services.json` while the tree is being removed, and the removal
 * fails ENOTEMPTY on a file that appeared mid-walk. services.test.ts met this first and answers it
 * the same way.
 */
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  );
});

describe('background process manager', () => {
  it(
    'keeps a long command observable without blocking the agent turn',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: process.execPath,
          args: ['-e', "setTimeout(() => process.stdout.write('finished'), 25)"],
          timeoutSeconds: 5
        },
        5,
        false
      );
      expect(started.status).toBe('running');
      expect(manager.list('workspace-1', 'another-task')).toEqual([]);
      expect(await settledStatus(manager, started.sessionId)).toMatchObject({
        status: 'completed',
        exitCode: 0,
        stdout: 'finished'
      });
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'reports completed only once the log is complete',
    async () => {
      // The direct child exits immediately and a grandchild writes to the inherited pipe afterwards.
      // A session that flipped to `completed` on the child's exit would hand the agent an empty log
      // and call it the whole output, which is the one thing a background job's result is read from.
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager(UNREACHABLE_FLUSH_GRACE_MS);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', '{ sleep 0.2; echo LATE; } & exit 0'],
          timeoutSeconds: 5
        },
        5,
        false
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      expect(finished.stdout).toContain('LATE');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'settles a session whose grandchild never releases the pipe',
    async () => {
      // The other half of the same rule. A grandchild that outlives its parent holds the inherited
      // pipes open, so the drain signal never arrives at all; without a bound on the wait, the
      // session would stay `running` for as long as that process lived and the agent would poll a
      // job that had already finished. Truncating the log is the price of that bound, and this is
      // where it is stated: the grandchild's write lands far outside a grace it cannot reach.
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager(50);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', '{ sleep 1; echo LATE; } & exit 0'],
          timeoutSeconds: 5
        },
        5,
        false
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      expect(finished.stdout).not.toContain('LATE');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'settles a command that never starts instead of leaving it running',
    async () => {
      // No 'exit' is ever emitted for a spawn that failed, so a session waiting for one sat at
      // `running` until its own timeout killed a process that had never existed.
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: path.join(root, 'workspace', 'not-an-executable'), timeoutSeconds: 5 },
        5,
        false
      );
      expect(await settledStatus(manager, started.sessionId)).toMatchObject({ status: 'failed' });
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'runs a background command under the same resource limits as a foreground one',
    async () => {
      // A long-running background session is the easier way to exhaust the box, not the harder one:
      // nothing is waiting on it, so it has hours rather than minutes to do the damage.
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const limiter = path.join(root, 'limiter');
      await writeFile(
        limiter,
        '#!/bin/sh\nargs=""\nwhile [ "$1" != "--" ]; do args="$args $1"; shift; done\nshift\nprintf \'%s\' "$args"\nexec "$@"\n'
      );
      await chmod(limiter, 0o700);
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: process.execPath,
          args: ['-e', "process.stdout.write('|done')"],
          timeoutSeconds: 5
        },
        5,
        false,
        {
          limiter,
          limits: {
            memoryBytes: 1024 ** 3,
            processes: 512,
            openFiles: 2048
          }
        }
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      expect(finished.stdout).toContain(`--data=${1024 ** 3}`);
      expect(finished.stdout).not.toContain('--fsize');
      expect(finished.stdout).toContain('--nproc=512');
      expect(finished.stdout).toContain('|done');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'starts sudo from the container root for a background command, as the foreground path does',
    async () => {
      // The background path is the one that runs longest, and the directory sudo is started from
      // is on its journal line beside the arguments. A session started in
      // `workspace/acme-lawsuit-discovery` must not put that name there; the helper enters the
      // directory from the spec instead, and the command still runs where it asked to.
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      const chosen = path.join(root, 'workspace', 'acme-lawsuit-discovery');
      await mkdir(chosen, { recursive: true });
      const record = path.join(root, 'elevated');
      const elevate = path.join(root, 'elevate');
      await writeFile(
        elevate,
        `#!/bin/sh\nif [ "$3" = run ]; then\nprintf '%s\\n' "$*" >"${record}"\nprintf '%s' "$PWD" >"${record}.pwd"\nfi\nshift\nexec "$@"\n`
      );
      await chmod(elevate, 0o700);
      const helper = path.join(root, 'sandbox');
      await writeFile(helper, SANDBOX_STAND_IN);
      await chmod(helper, 0o700);
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'pwd -P'],
          cwd: 'acme-lawsuit-discovery',
          timeoutSeconds: 5
        },
        5,
        true,
        { sandbox: { elevate, helper, specDirectory: path.join(root, 'specs') } }
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      expect(await realpath((finished.stdout ?? '').trim())).toBe(await realpath(chosen));
      expect(await realpath(await readFile(`${record}.pwd`, 'utf8'))).toBe(await realpath(root));
      expect(await readFile(record, 'utf8')).not.toContain('acme-lawsuit-discovery');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'runs a background command through the agent sandbox, as a foreground one is',
    async () => {
      /*
       * The one guard on this path that had no test of its own.
       *
       * The limiter above was covered and the sandbox was not, and the sandbox is the guard that
       * decides which Unix account a command runs as - so a background session and a service, the
       * two things on this box that outlive the turn that asked for them, could have been running
       * as the runner's own account with nothing saying so. Written here because both routes now
       * compute their invocation in one place: a unification that quietly dropped the sandbox from
       * this side would otherwise have passed every test in the package.
       */
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      // Stands in for sudo: records what it was asked to run, then runs it.
      const record = path.join(root, 'elevated');
      const elevate = path.join(root, 'elevate');
      await writeFile(
        elevate,
        `#!/bin/sh\nif [ "$3" = run ]; then printf '%s\\n' "$*" >"${record}"; fi\nshift\nexec "$@"\n`
      );
      await chmod(elevate, 0o700);
      // Stands in for garden-sandbox: drops its own four leading arguments the way the real helper
      // consumes `run <network mode> <filesystem mode> <root>`, then applies the environment and
      // execs, as `env -i` does.
      const helper = path.join(root, 'sandbox');
      await writeFile(helper, SANDBOX_STAND_IN);
      await chmod(helper, 0o700);
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'printf "%s" "$HOME"'], timeoutSeconds: 5 },
        5,
        true,
        { sandbox: { elevate, helper, specDirectory: path.join(root, 'specs') } }
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      // The environment reached the process, which is only true if the helper was handed it as
      // arguments - the spawn itself passes an empty one, because sudo resets it anyway.
      expect(finished.stdout).toBe(agentHome(root));
      const elevated = await readFile(record, 'utf8');
      expect(elevated).toContain(`-n ${helper} run isolated`);
      // And it reached the process through the spec file, not through sudo's argument list: the
      // background path is the one that runs longest, and its command text belongs in the
      // journal no more than a foreground command's does.
      expect(elevated).not.toContain('HOME=');
      // WHERE that home is, spelled without `agentHome` on both sides. The two assertions above
      // compare the background path's answer against the same function the background path calls,
      // so they hold whatever that function returns: with `agentHome` reverted to the bare
      // workspace root - the value this wave moved away from - all 21 tests in this file stayed
      // green. `.home` at the container root, written out, is what actually pins the move: outside
      // `workspace/`, so a Rust toolchain's 88,021 files are not walked by every checkpoint, and
      // outside `.garden`, which is the runner's alone.
      expect(path.relative(root, finished.stdout ?? '')).toBe('.home');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'carries the coding CLI permission policy into the background process',
    async () => {
      // The deny-list and the auto-share opt-out only exist as environment variables, and the
      // coding agent is a background session rather than a foreground command - so an allow-list
      // that dropped them here left the owner believing a policy was in force that the process
      // never saw.
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager();
      const permission = JSON.stringify({ bash: { 'sudo *': 'deny' } });
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: process.execPath,
          args: [
            '-e',
            'process.stdout.write(`${process.env.OPENCODE_AUTO_SHARE}|${process.env.OPENCODE_PERMISSION}`)'
          ],
          env: { OPENCODE_AUTO_SHARE: 'false', OPENCODE_PERMISSION: permission },
          timeoutSeconds: 5
        },
        5,
        false
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      expect(finished.stdout).toBe(`false|${permission}`);
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it('refuses an environment variable it will not pass on rather than dropping it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    await expect(
      manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: process.execPath, args: ['-e', ''], env: { PATH: '/tmp', SECRET: 'x' } },
        5,
        false
      )
    ).rejects.toThrow('does not accept PATH, SECRET');
    await manager.close();
  });

  /*
   * The list the owner's panel reads, as opposed to the list a turn reads.
   *
   * Every background session is started by an agent, whose capability subject is the task it is
   * running - never the person. So the owner-scoped list, asked on the owner's behalf, matched
   * nothing at all: a computer with two servers on it reported an empty table, which is why the
   * panel could never say what the machine was doing. The workspace filter still holds.
   */
  it('shows the whole workspace to the person who owns it, whichever task started it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    const args = ['-e', 'setTimeout(() => undefined, 400)'];
    const first = await manager.start(
      root,
      'workspace-1',
      'task-1',
      { executable: process.execPath, args, timeoutSeconds: 5 },
      5,
      false
    );
    const second = await manager.start(
      root,
      'workspace-1',
      'task-2',
      { executable: process.execPath, args, timeoutSeconds: 5 },
      5,
      false
    );
    const elsewhere = await manager.start(
      root,
      'workspace-2',
      'task-3',
      { executable: process.execPath, args, timeoutSeconds: 5 },
      5,
      false
    );
    expect(manager.list('workspace-1', 'task-1').map((view) => view.sessionId)).toEqual([
      first.sessionId
    ]);
    expect(manager.listWorkspace('workspace-1').map((view) => view.sessionId)).toEqual([
      first.sessionId,
      second.sessionId
    ]);
    expect(manager.listWorkspace('workspace-2').map((view) => view.sessionId)).toEqual([
      elsewhere.sessionId
    ]);
    // What the row is drawn from: the command as started, when it started, and how it is going.
    expect(manager.listWorkspace('workspace-1')[0]).toMatchObject({
      status: 'running',
      command: [process.execPath, ...args]
    });
    expect(manager.listWorkspace('workspace-1')[0]?.startedAt).toEqual(expect.any(String));
    await manager.close();
  });

  /*
   * What the Stop button reaches.
   *
   * Cancelling a task aborted whatever runner request was in flight, which is the whole of the
   * foreground story and none of the background one: `processes/start` returns in milliseconds, so
   * by the time the owner presses Stop there is no request left to abort and the scraper the model
   * started runs on for the rest of its hour, writing into the workspace and making outbound
   * requests attributed to this box. A service is the deliberate exception - it was declared to
   * outlive the turn - and the two must be told apart here, because a confirmation that says
   * "stopped" about a service nobody stopped is the failure this route was added to end.
   */
  it(
    "a cancelled task's background sessions are stopped and its declared services are not",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      await mkdir(path.join(root, '.garden'), { recursive: true });
      const manager = new ProcessManager();
      const sleeping = { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 };
      const scraper = await manager.start(root, 'workspace-1', 'task-1', sleeping, 30, false);
      const dashboard = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { ...sleeping, service: 'invoice dashboard' },
        30,
        false
      );
      const otherTask = await manager.start(root, 'workspace-1', 'task-2', sleeping, 30, false);

      const outcome = manager.stopOwner('workspace-1', 'task-1', {});
      expect(outcome.stopped).toEqual([scraper.sessionId]);
      expect(outcome.services).toEqual(['invoice dashboard']);
      // The sentence the cancel confirmation carries: naming the service is the whole point, since
      // the owner is being told the task ended while something it declared is still serving.
      expect(outcome.note).toContain('invoice dashboard');

      expect(await settledStatus(manager, scraper.sessionId)).toMatchObject({ status: 'stopped' });
      // Declared to outlive the turn, so it does.
      expect(
        manager.action('workspace-1', 'task-1', dashboard.sessionId, { action: 'poll' })
      ).toMatchObject({ status: 'running', service: { name: 'invoice dashboard' } });
      // Another turn's session is not this cancellation's business.
      expect(
        manager.action('workspace-1', 'task-2', otherTask.sessionId, { action: 'poll' }).status
      ).toBe('running');

      // Nothing to stop is not an error: cancel runs on every task, and most have no background
      // work at all.
      expect(manager.stopOwner('workspace-1', 'task-3', {})).toMatchObject({
        stopped: [],
        services: []
      });
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  /*
   * A capability subject cannot name somebody else's.
   *
   * `list` and `action` narrow an agent to the sessions its own task started, and this route would
   * be the way round that if the owner in the body were believed: one turn could stop another
   * turn's work by asking. The person driving the box passes `null` and names the task, which is
   * the same split those two make.
   */
  it('refuses to let one task stop the background work of another', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    const sleeping = { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 };
    const victim = await manager.start(root, 'workspace-1', 'task-2', sleeping, 30, false);
    expect(() => manager.stopOwner('workspace-1', 'task-1', { owner: 'task-2' })).toThrow(
      'only stop the background processes it started'
    );
    expect(
      manager.action('workspace-1', 'task-2', victim.sessionId, { action: 'poll' }).status
    ).toBe('running');
    // The owner of the computer is not subject to a task, and says which one they mean.
    expect(manager.stopOwner('workspace-1', null, { owner: 'task-2' }).stopped).toEqual([
      victim.sessionId
    ]);
    expect(() => manager.stopOwner('workspace-1', null, {})).toThrow('which task');
    await manager.close();
  });

  it('does not allow background privilege or package operations in host-native mode', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    await expect(
      manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: 'apt-get', args: ['install', '-y', 'inkscape'] },
        30,
        false
      )
    ).rejects.toThrow('cannot run as background processes');
    await expect(
      manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: 'bash',
          args: ['-lc', 'apt-get install -y librsvg2-bin 2>&1 | tail -8'],
          yieldAfterMs: 5000
        },
        30,
        false
      )
    ).rejects.toThrow(
      'package manager as executable, its supported update/install arguments, and no wrapper, PTY or background'
    );
    await manager.close();
  });

  it('refuses a background command that names a privileged helper directly', async () => {
    /*
     * The background counterpart of execution.test.ts's "refuses a command that names a privileged
     * helper directly", which had no counterpart here for as long as the helper has existed.
     *
     * The refusal is one check reading one list, and the list is built from the two root-owned
     * helpers this computer has: the system-package helper and the sandbox's elevator. Only the
     * foreground path ever knew where the package helper was, so on this path the list held the
     * sandbox helper alone - and with AGENT_SANDBOX_HELPER unset, which config.ts documents as the
     * supported shape of a host with no second account to drop to, it held nothing at all and the
     * check had nothing to match against. The package helper reaches root through NOPASSWD sudo,
     * so a background start naming it got there with no capability scope and no approval, which is
     * precisely what the foreground refusal exists to prevent.
     *
     * Both spellings, because a wrapper hides the executable in its arguments; and the service
     * spelling too, because a service is the one background job that never stops on its own.
     */
    const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const packageHelper = path.join(root, 'package-helper');
    await writeFile(packageHelper, '#!/bin/sh\nexit 0\n');
    await chmod(packageHelper, 0o755);
    const manager = new ProcessManager();
    const attempts = [
      { executable: packageHelper, args: ['install', 'openssh-server'] },
      { executable: 'sh', args: ['-c', `${packageHelper} install openssh-server`] },
      { executable: packageHelper, args: ['install', 'openssh-server'], service: 'installer' }
    ];
    for (const attempt of attempts)
      await expect(
        // No sandbox: the laptop-shaped configuration, and the one this was reachable on.
        manager.start(root, 'workspace-1', 'task-1', attempt, 30, false, {
          systemPackageHelper: packageHelper
        })
      ).rejects.toThrow('cannot run as background processes');
    await manager.close();
  });
});

/*
 * The one execution path that had no disk guard was the one defined as running unattended.
 *
 * `execute()` has polled free space while a foreground command ran ever since a `dd` took the box
 * down; the background path got the pre-flight check and nothing else, and the pre-flight check
 * only proves the disk was healthy at the moment the command started. A background `dd`, a service
 * that logs to a file, an `npm ci` in a service wrapper: each runs for up to an hour - and a
 * service has no deadline at all - with nothing watching. The last free byte stops PostgreSQL,
 * which stops the interface and every other task on the computer.
 */
describe('the host disk floor on the background path', () => {
  const failingDisk = (healthyPolls: number) => {
    let reads = 0;
    return async () => ({
      hostStorageTotalBytes: 100 * 1024 ** 3,
      hostStorageAvailableBytes: ++reads > healthyPolls ? 64 * 1024 ** 2 : 50 * 1024 ** 3
    });
  };

  it(
    'stops a background session that is consuming the last of the host disk',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 },
        30,
        false,
        { hostStoragePollMs: 25, hostStorage: failingDisk(2) }
      );
      const settled = await settledStatus(manager, started.sessionId);
      expect(settled.status).toBe('stopped');
      // Said on the session's own stderr, because `poll` is the only place the agent ever finds
      // out why a background job it started is no longer running.
      expect(settled.stderr).toContain('last of the host disk');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  /*
   * The same fifth stop as on the foreground path, and it matters more here: a background session
   * is the one that runs long enough and large enough to be the thing the cgroup picks. Guarded on
   * the status rather than on a flag, because the timeout, the disk floor and the owner's stop all
   * move it away from 'running' before they kill, and all three of them kill with SIGKILL.
   */
  it('says so when a background session is killed outright', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    const started = await manager.start(
      root,
      'workspace-1',
      'task-1',
      { executable: '/bin/sh', args: ['-c', 'kill -9 $$'], timeoutSeconds: 30 },
      30,
      false,
      {}
    );
    const settled = await settledStatus(manager, started.sessionId);
    expect(settled.status).toBe('failed');
    expect(settled.signal).toBe('SIGKILL');
    expect(settled.stderr).toContain('killed outright by the computer');
    await manager.close();
  });

  /*
   * The sixth stop, on the path that had five.
   *
   * A ruleset refusal arrives as nothing but the word "denied" in the command's own stderr, and the
   * foreground path has explained it since the boundary shipped while this one did not - so the same
   * command, refused the same way, was diagnosable in front of the agent and mute when it ran for an
   * hour in the background. That is the wrong way round: a background job is where a boundary is
   * most likely to be met and least likely to be found by rerunning.
   *
   * Pinned at `start` rather than at the note, because the note was never the missing part - it was
   * exported and correct while nothing on this path called it. There is no kernel here, so the
   * denial's own words are what the fixture prints, which is honest about what the production code
   * reads: it reads the command's stderr and nothing else.
   */
  const deniedInBackground = async (
    message: string,
    confineFilesystem: boolean
  ): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const elevate = path.join(root, 'elevate');
    await writeFile(elevate, '#!/bin/sh\nshift\nexec "$@"\n');
    await chmod(elevate, 0o700);
    const helper = path.join(root, 'sandbox');
    await writeFile(helper, SANDBOX_STAND_IN);
    await chmod(helper, 0o700);
    const manager = new ProcessManager();
    const started = await manager.start(
      root,
      'workspace-1',
      'task-1',
      {
        executable: '/bin/sh',
        args: ['-c', `printf '%s\\n' "${message}" >&2; exit 1`],
        timeoutSeconds: 30
      },
      30,
      false,
      {
        sandbox: {
          elevate,
          helper,
          specDirectory: path.join(root, 'specs'),
          confineFilesystem,
          processIsolation: true,
          retainedProcessTrees: true
        }
      }
    );
    const settled = await settledStatus(manager, started.sessionId);
    expect(settled.status).toBe('failed');
    expect(settled.exitCode).toBe(1);
    await manager.close();
    return settled.stderr ?? '';
  };

  it(
    'tells a background command the sandbox refused it, as the foreground path does',
    async () => {
      // Written as an installed-host path rather than built from this test's root, because a
      // temporary root here lives under `/var`, which the ruleset grants for reading - so a
      // root-derived path would be silenced by the read list and would pin nothing.
      const stderr = await deniedInBackground(
        'cat: /home/garden/00000000-0000-4000-8000-00000000000a/workspace/notes.md: Permission denied',
        true
      );
      expect(stderr).toContain('the sandbox on this computer probably refused that');
      // Which path, because a job that touched several files needs to know which one of them met
      // the boundary.
      expect(stderr).toContain(
        '/home/garden/00000000-0000-4000-8000-00000000000a/workspace/notes.md'
      );
      // The command's own message survives ahead of it: the note is added to the log, not put in
      // place of it.
      expect(stderr).toContain('Permission denied');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'stays silent in the background on a denial the ruleset did not cause',
    async () => {
      // The direction that decides whether this can ship at all. `/etc` is granted for reading, so
      // this is an ordinary mode bit, and answering it with "the sandbox refused that" would be a
      // false explanation of a real problem - worse than the silence it replaced.
      expect(await deniedInBackground('cat: /etc/shadow: Permission denied', true)).not.toContain(
        'the sandbox on this computer'
      );
      // And nothing at all on a box that never applied a ruleset, where the sentence would be a
      // plain fabrication.
      expect(
        await deniedInBackground(
          'cat: /home/garden/00000000-0000-4000-8000-00000000000a/workspace/notes.md: Permission denied',
          false
        )
      ).not.toContain('the sandbox on this computer');
    },
    TEST_TIMEOUT_MS
  );

  it('leaves a background session on a healthy disk alone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    const started = await manager.start(
      root,
      'workspace-1',
      'task-1',
      { executable: process.execPath, args: ['-e', "process.stdout.write('fine')"] },
      30,
      false,
      {
        hostStoragePollMs: 25,
        hostStorage: async () => ({
          hostStorageTotalBytes: 100 * 1024 ** 3,
          hostStorageAvailableBytes: 60 * 1024 ** 3
        })
      }
    );
    expect(await settledStatus(manager, started.sessionId)).toMatchObject({
      status: 'completed',
      stdout: 'fine'
    });
    await manager.close();
  });

  it(
    'does not put a service straight back into the disk it just filled',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'garden-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      await mkdir(path.join(root, '.garden'), { recursive: true });
      const manager = new ProcessManager(undefined, {
        baseDelayMs: 10,
        ceilingDelayMs: 40,
        healthyAfterMs: 2_000,
        maxRapidFailures: 3
      });
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], service: 'log writer' },
        30,
        false,
        { hostStoragePollMs: 25, hostStorage: failingDisk(2) }
      );
      const settled = await settledStatus(manager, started.sessionId);
      expect(settled.status).toBe('stopped');
      const view = manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' });
      expect(view.service).toMatchObject({
        name: 'log writer',
        state: 'crash_looped',
        restarts: 0
      });
      // The backoff is the thing under test: it must not count, and the record must not gain a
      // restart while the disk is still full.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' }).service
      ).toMatchObject({ state: 'crash_looped', restarts: 0 });
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );
});

/**
 * What an agent can find out about a job it started, which is the difference between supervising
 * six hours of work and starting it again.
 */
describe('watching a long background job', () => {
  const managerRoot = async (): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-longwork-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    return root;
  };

  it(
    'says which bound stopped it, in its own log',
    async () => {
      // `status: "timed_out"` beside an empty stderr was the whole report. This is the sentence the
      // disk floor and the owner's stop have always written, for the stop that had none.
      const root = await managerRoot();
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 1 },
        1,
        false
      );
      const settled = await settledStatus(manager, started.sessionId);
      expect(settled.status).toBe('timed_out');
      expect(settled.stderr).toContain('1s timeout');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'does not also tell a job that hit its deadline that the computer killed it for memory',
    async () => {
      /*
       * The guard on the shared seam, which nothing else in this file reaches.
       *
       * All three stops this class performs kill with SIGKILL, so the branch that explains a
       * SIGKILL has to ask first whether one of them already spoke - that is what `claimed:
       * session.status !== 'running'` is for, and it is the whole reason the seam takes a `claimed`
       * at all. The deadline test above cannot see it, twice over: `settledStatus` returns the
       * moment the status leaves 'running', which the deadline does BEFORE it signals anything, and
       * a `sleep` dies on the SIGTERM so the escalation to SIGKILL never happens. Measured: with
       * `claimed` forced to `false`, all 23 tests in this file stayed green while a timed-out job
       * was being handed, in one log, both the sentence saying it hit its 1s deadline and the
       * sentence saying the computer killed it outright and it should ask for less memory - two
       * different endings for one stop, and the second one an invention.
       *
       * So this command ignores SIGTERM, the way a build harness that installs its own handler
       * does, and this test waits for the settle itself rather than for the status.
       */
      const root = await managerRoot();
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: process.execPath,
          args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
          timeoutSeconds: 1
        },
        1,
        false
      );
      const poll = () =>
        manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' });
      await expect
        .poll(() => poll().finishedAt, { interval: 20, timeout: SETTLE_TIMEOUT_MS })
        .toBeDefined();
      const settled = poll();
      // The escalation was reached, so the branch this test is about really ran.
      expect(settled.signal).toBe('SIGKILL');
      expect(settled.status).toBe('timed_out');
      expect(settled.stderr).toContain('1s timeout');
      expect(settled.stderr).not.toContain('killed outright by the computer');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses a deadline this path could never honour rather than killing it part-way',
    async () => {
      const root = await managerRoot();
      const manager = new ProcessManager();
      await expect(
        manager.start(
          root,
          'workspace-1',
          'task-1',
          { executable: process.execPath, args: ['-e', ''], timeoutSeconds: 200 },
          30,
          false
        )
      ).rejects.toThrow(/200s/);
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'answers a poll with something that has moved since the last one',
    async () => {
      /*
       * Every other field a poll returns is fixed for the life of the session, so without one that
       * moves, polling a job that is quietly working - an alignment, a build, anything writing to a
       * file rather than to a terminal - would return a byte-identical answer every time. The turn
       * guard reads repeated identical results as a model going in circles, and would stop the
       * agent for supervising a long job correctly, which is the one thing this primitive is for.
       */
      const root = await managerRoot();
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 },
        30,
        false
      );
      const first = manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' });
      await expect
        .poll(
          () =>
            manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' }).ranForMs,
          { interval: 10, timeout: 5_000 }
        )
        .toBeGreaterThan(first.ranForMs);
      manager.action('workspace-1', 'task-1', started.sessionId, { action: 'kill' });
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'keeps the beginning of a long log as well as its end, and says what it dropped',
    async () => {
      /*
       * This path kept the last N bytes and said nothing. The beginning of a six-hour run's log is
       * where it states what it is about to do - the command line, the version banner, the first
       * warning - so a single poll of a chatty job silently returned a log whose head the runner
       * had already discarded, with no marker to say any of it was ever there. The foreground path
       * has kept head, tail and a byte count since it was written; this is the same collector.
       */
      const root = await managerRoot();
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: process.execPath,
          args: ['-e', "process.stdout.write('BEGIN' + 'x'.repeat(12000) + 'END')"],
          maxOutputBytes: 4096,
          timeoutSeconds: 5
        },
        5,
        false
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.stdout?.startsWith('BEGIN')).toBe(true);
      expect(finished.stdout?.endsWith('END')).toBe(true);
      expect(finished.stdout).toContain('bytes omitted from stdout');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );
});

/**
 * What this computer would destroy by restarting, counted where it is known.
 *
 * `garden update` stops garden.target for its backup and rebuild, which SIGTERMs the runner and
 * takes every background session with it. A declared service comes back - its record is on disk and
 * `resume` relaunches it - and an ordinary background command does not: nothing anywhere records
 * it, so a twenty-hour alignment dies and the next poll of its id answers "Background process not
 * found". The gate meant to stop that reads the worker's count of TURNS in flight, and a background
 * job outlives its turn by design, so the gate cannot see it. This is the number that gate needs.
 *
 * The service exclusion is the half most likely to be got wrong in the safe-looking direction:
 * counting services would stand the weekly update down for work a restart does not harm, every
 * week, on any box with a dashboard on it - and a box that never updates is the failure this whole
 * mechanism exists inside.
 */
describe('what a restart would destroy', () => {
  it(
    'counts a background command and not a service, with how long the longest has left',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'garden-restart-cost-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager();
      expect(manager.backgroundWork()).toEqual({ commands: 0, longestRemainingMs: null });

      const short = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 60'], timeoutSeconds: 30 },
        120,
        false
      );
      const long = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 60'], timeoutSeconds: 90 },
        120,
        false
      );
      await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 60'],
          service: 'invoice dashboard',
          maxOutputBytes: 4_096
        },
        120,
        false
      );

      const cost = manager.backgroundWork();
      // Two commands, not three: the service is the one thing here a restart puts back.
      expect(cost.commands).toBe(2);
      // The longer of the two deadlines, which is the number an operator is told to wait for.
      expect(cost.longestRemainingMs).toBeGreaterThan(85_000);
      expect(cost.longestRemainingMs).toBeLessThanOrEqual(90_000);

      // A session that has stopped is no longer work a restart could destroy.
      manager.action('workspace-1', 'task-1', long.sessionId, { action: 'kill' });
      const afterKill = manager.backgroundWork();
      expect(afterKill.commands).toBe(1);
      expect(afterKill.longestRemainingMs).toBeLessThanOrEqual(30_000);

      manager.action('workspace-1', 'task-1', short.sessionId, { action: 'kill' });
      expect(manager.backgroundWork()).toEqual({ commands: 0, longestRemainingMs: null });
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );
});

/*
 * A declared service outlives the task that declared it, so every later task has to be able to
 * find it.
 *
 * Measured on a live box: a service was left listening on a public port. The next turn was asked
 * to stop it, listed the processes, was handed an empty array because `list` filtered on the
 * declaring task, and reported that nothing was running. The service was in the owner's own panel
 * and in `.garden/services.json` the whole time, and the runner brings it back across reboots.
 */
describe('reaching a service the declaring task has finished with', () => {
  const startService = async (manager: ProcessManager, owner: string, name: string) => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-service-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    return {
      root,
      started: await manager.start(
        root,
        'workspace-1',
        owner,
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], service: name },
        30,
        false
      )
    };
  };

  it(
    'shows a later task the service, and still hides an ordinary background command',
    async () => {
      const manager = new ProcessManager();
      const { root, started } = await startService(manager, 'task-1', 'files');
      const ephemeral = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 },
        30,
        false
      );

      const seenByLaterTask = manager.list('workspace-1', 'task-2').map((view) => view.sessionId);
      expect(seenByLaterTask).toContain(started.sessionId);
      expect(seenByLaterTask).not.toContain(ephemeral.sessionId);
      expect(manager.list('workspace-1', 'task-1').map((view) => view.sessionId)).toContain(
        ephemeral.sessionId
      );
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'lets a later task read and stop the service it can now see',
    async () => {
      const manager = new ProcessManager();
      const { started } = await startService(manager, 'task-1', 'files');

      expect(
        manager.action('workspace-1', 'task-2', started.sessionId, { action: 'poll' }).service
      ).toMatchObject({ name: 'files' });
      // The kill's own answer is the evidence, because stopping a service RETIRES it: it is no
      // longer durable, so the task that stopped it is no longer the task it is durable for. The
      // declaring task still holds the session, and the owner still sees it in the workspace list.
      expect(
        manager.action('workspace-1', 'task-2', started.sessionId, { action: 'kill' }).status
      ).toBe('stopped');
      expect(manager.listWorkspace('workspace-1').map((view) => view.status)).toEqual(['stopped']);
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  /*
   * The counter-direction, and the reason `write` is excluded by name. Reading and stopping cannot
   * be aimed at another turn's reasoning; chosen bytes on the stdin of somebody else's process can,
   * which is the same line the owner's own widened access was drawn along.
   */
  it(
    "refuses to let one task speak into another task's service",
    async () => {
      const manager = new ProcessManager();
      const { started } = await startService(manager, 'task-1', 'files');

      expect(() =>
        manager.action('workspace-1', 'task-2', started.sessionId, { action: 'write', data: 'x' })
      ).toThrow('Background process not found');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    "still hides another task's ordinary background command entirely",
    async () => {
      const manager = new ProcessManager();
      const root = await mkdtemp(path.join(tmpdir(), 'garden-service-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const ephemeral = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 },
        30,
        false
      );

      expect(() =>
        manager.action('workspace-1', 'task-2', ephemeral.sessionId, { action: 'poll' })
      ).toThrow('Background process not found');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );
});

/*
 * A service that turns out to be reachable from off this computer, said out loud on the evidence.
 *
 * The approval card is answered from the command before the process exists, and the commonest way
 * to open a public port states no address at all: `python3 -m http.server 8099` binds every
 * interface. So the card the owner read was true of the words and wrong about the effect, and this
 * is the correction - measured from the kernel, delivered into the one channel the agent that
 * started the service actually reads back.
 */
describe('saying that a service is reachable from outside this computer', () => {
  const startService = async (manager: ProcessManager, name: string) => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-listen-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    return manager.start(
      root,
      'workspace-1',
      'task-1',
      { executable: '/bin/sh', args: ['-c', 'sleep 30'], service: name },
      30,
      false
    );
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  it(
    'names the address, reports it on the service, and says it exactly once',
    async () => {
      const manager = new ProcessManager(undefined, undefined, 20, async () => [
        { address: '0.0.0.0', port: 8099 }
      ]);
      const started = await startService(manager, 'files');
      await settle();

      const view = manager.action('workspace-1', 'task-1', started.sessionId, { action: 'log' });
      expect(view.service).toMatchObject({ name: 'files', listening: ['0.0.0.0:8099'] });
      expect(view.stderr).toContain('0.0.0.0:8099');
      expect(view.stderr).toContain('anyone who can reach this computer');
      // Written once, however many times the sweep runs: at 20ms it has run several times by now.
      expect(view.stderr?.match(/is listening on/g)?.length).toBe(1);
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  /*
   * THE COUNTER-DIRECTION. Loopback is the ordinary, correct way to run an app here - the preview
   * proxy connects to 127.0.0.1 - so it is reported as observed and says nothing at all.
   */
  it(
    'reports a loopback service without warning about it',
    async () => {
      const manager = new ProcessManager(undefined, undefined, 20, async () => [
        { address: '127.0.0.1', port: 8097 }
      ]);
      const started = await startService(manager, 'files');
      await settle();

      const view = manager.action('workspace-1', 'task-1', started.sessionId, { action: 'log' });
      expect(view.service).toMatchObject({ listening: ['127.0.0.1:8097'] });
      expect(view.stderr ?? '').not.toContain('anyone who can reach this computer');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  /*
   * THE PATH THAT ACTUALLY RUNS ON THE BOX.
   *
   * A service comes under supervision two ways: an agent declares one, and the runner comes back
   * up and finds records on disk. The sweep was started from the first only - so on a real install,
   * where every deploy restarts the runner and every service therefore arrives by the second, the
   * observation was live, correct and never once executed. Measured that way: a service was up on
   * 127.0.0.1:8096 and every row reported nothing.
   */
  it(
    'observes a service that came back with the runner, not only one just declared',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'garden-resume-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const first = new ProcessManager(undefined, undefined, 20, async () => []);
      await first.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], service: 'files' },
        30,
        false
      );
      await first.close();

      const rebooted = new ProcessManager(undefined, undefined, 20, async () => [
        { address: '0.0.0.0', port: 8096 }
      ]);
      expect(await rebooted.resumeWorkspace(root, 'workspace-1', false)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 80));

      const [row] = rebooted.listWorkspace('workspace-1');
      expect(row?.service).toMatchObject({ name: 'files', listening: ['0.0.0.0:8096'] });
      await rebooted.close();
    },
    TEST_TIMEOUT_MS
  );

  /*
   * A host with no `/proc` answers exactly as a service binding nothing does, so the field is
   * OMITTED rather than empty. `listening: []` would be a claim that the service is reachable from
   * nowhere, which is the one sentence this must never produce on a machine it could not read.
   */
  it(
    'omits the field entirely when nothing could be observed',
    async () => {
      const manager = new ProcessManager(undefined, undefined, 20, async () => []);
      const started = await startService(manager, 'files');
      await settle();

      const view = manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' });
      expect(view.service).toMatchObject({ name: 'files' });
      expect(view.service).not.toHaveProperty('listening');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );
});
