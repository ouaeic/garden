import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessManager } from './processes.js';
import {
  DEFAULT_SERVICE_POLICY,
  givenUp,
  hostBootedAt,
  newServiceRecord,
  nextFailureCount,
  reclaimOrphan,
  restartDelayMs,
  ServiceRegistry,
  serviceView,
  workspaceDirectories,
  type ServicePolicy
} from './services.js';

const roots: string[] = [];

const TEST_TIMEOUT_MS = 20_000;

/**
 * The shipped backoff gives up after five deaths spread over about a minute, which is not something
 * a test can wait for. This is the same rule at a scale the test owns: still five failures, still
 * doubling, but in tens of milliseconds.
 */
const FAST_POLICY: ServicePolicy = {
  baseDelayMs: 10,
  ceilingDelayMs: 40,
  healthyAfterMs: 2_000,
  maxRapidFailures: 3
};

/**
 * The same rule with the healthy threshold below the fixture's own lifetime, so every run counts as
 * having worked and the streak never reaches the give-up. That is the ordinary case - a server that
 * runs for a week and falls over is not a crash loop - and it is the only way to watch a service
 * come back more than twice without waiting out the shipped minute.
 */
const HEALTHY_POLICY: ServicePolicy = { ...FAST_POLICY, healthyAfterMs: 20 };

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-service-'));
  roots.push(root);
  await mkdir(path.join(root, 'workspace'), { recursive: true });
  await mkdir(path.join(root, '.garden'), { recursive: true });
  return root;
};

const registryFile = (root: string): string => path.join(root, '.garden', 'services.json');

const readRecords = async (root: string): Promise<Record<string, unknown>[]> => {
  const contents = await readFile(registryFile(root), 'utf8');
  return JSON.parse(contents) as Record<string, unknown>[];
};

/*
 * `maxRetries` because a supervised service can still be writing the registry while this runs, and
 * a recursive delete that meets a file appearing between its readdir and its rmdir fails with
 * ENOTEMPTY. `close()` is synchronous - it marks the supervisor retiring and clears the timers -
 * so a write already dispatched lands after it returns, which is right for a runner shutting down
 * and only wrong for a test that deletes the directory in the same tick. Seen once in a full gate
 * run and not reproduced in three targeted runs of this file, which is the shape of flake that
 * teaches people to re-run a gate rather than trust it.
 */
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  );
});

describe('service restart policy', () => {
  it('doubles the wait from the first death and stops doubling at the ceiling', () => {
    expect(restartDelayMs(1)).toBe(1_000);
    expect(restartDelayMs(2)).toBe(2_000);
    expect(restartDelayMs(3)).toBe(4_000);
    expect(restartDelayMs(5)).toBe(16_000);
    expect(restartDelayMs(9)).toBe(DEFAULT_SERVICE_POLICY.ceilingDelayMs);
    // Guards the shift: a very large streak must not overflow into a negative or infinite wait.
    expect(restartDelayMs(400)).toBe(DEFAULT_SERVICE_POLICY.ceilingDelayMs);
  });

  it('gives up only on consecutive deaths, and a run that worked clears the streak', () => {
    expect(givenUp(4)).toBe(false);
    expect(givenUp(5)).toBe(true);
    // Died after a fortnight of uptime: this is the first failure of a new streak, not the fifth.
    expect(nextFailureCount(14 * 24 * 3_600_000, 4)).toBe(1);
    // Died in a second: the streak continues, which is what a crash loop looks like.
    expect(nextFailureCount(1_000, 4)).toBe(5);
  });
});

describe('service registry', () => {
  it('survives a restart and refuses to hand back a file it cannot understand', async () => {
    const root = await workspace();
    const record = newServiceRecord({
      workspaceId: 'workspace-1',
      owner: 'task-1',
      name: 'invoice dashboard',
      launch: {
        executable: '/bin/sh',
        args: ['-c', 'sleep 1'],
        cwd: 'workspace',
        env: {},
        network: false,
        maxOutputBytes: 4_096
      }
    });
    await new ServiceRegistry(root).put(record);
    // A different process, reading the same box back: this is the whole point of the file.
    expect(await new ServiceRegistry(root).load()).toEqual([record]);

    // A truncated write or a hand-edit costs the owner their services, never their computer.
    await writeFile(registryFile(root), '[{"id":');
    expect(await new ServiceRegistry(root).load()).toEqual([]);
    await writeFile(registryFile(root), '[{"id":"svc_x"}]');
    expect(await new ServiceRegistry(root).load()).toEqual([]);
  });

  /**
   * The one promise a service makes is that it is still there tomorrow, so a record that could not
   * be written is the moment that promise quietly stops being true. It said so in prose for months
   * and journald filed every one of them at the default priority, where nobody looking for a
   * problem would ever pass.
   */
  it('files a record it could not write where a priority filter will find it', async () => {
    vi.stubEnv('JOURNAL_STREAM', '8:1234567');
    const root = await workspace();
    // A regular file where the registry needs a directory. ENOTDIR stands in for the real causes -
    // a full disk, a read-only mount - none of which a test can arrange on the machine running it.
    const blocked = path.join(root, 'blocked');
    await writeFile(blocked, '');
    const record = newServiceRecord({
      workspaceId: 'workspace-1',
      owner: 'task-1',
      name: 'invoice dashboard',
      launch: {
        executable: '/bin/sh',
        args: ['-c', 'sleep 1'],
        cwd: 'workspace',
        env: {},
        network: false,
        maxOutputBytes: 4_096
      }
    });
    const lines: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      // Every service the owner ever starts comes through here, so a line raised on the ordinary
      // path would bury the one raised on this one in its own noise.
      await new ServiceRegistry(root).put(record);
      expect(lines).toEqual([]);
      await new ServiceRegistry(blocked).put(record);
    } finally {
      stdout.mockRestore();
    }
    expect(lines[0]!.startsWith('<4>')).toBe(true);
    expect(JSON.parse(lines[0]!.slice(3))).toMatchObject({
      level: 'warn',
      service: 'runner',
      event: 'services.record_write_failed',
      detail:
        'could not record services in .garden/services.json - services will not survive a restart',
      // Whose services these were. The sentence names the file relative to a workspace it does not
      // name, so without this the owner of a box with several workspaces is told that some
      // services somewhere will not come back.
      workspaceId: 'workspace-1',
      code: 'ENOTDIR'
    });
  });

  it('lists only real workspaces beside the snapshot and checkpoint directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-service-root-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace-1'));
    await mkdir(path.join(root, '.garden-snapshots'));
    await mkdir(path.join(root, '.garden-checkpoints'));
    await writeFile(path.join(root, 'stray-file'), '');
    expect(await workspaceDirectories(root)).toEqual(['workspace-1']);
    expect(await workspaceDirectories(path.join(root, 'not-here'))).toEqual([]);
  });
});

describe('reclaiming what a crashed runner left behind', () => {
  const record = newServiceRecord({
    workspaceId: 'workspace-1',
    owner: 'task-1',
    name: 'site',
    launch: {
      executable: '/usr/bin/python3',
      args: ['-m', 'http.server'],
      cwd: 'workspace',
      env: {},
      network: false,
      maxOutputBytes: 4_096
    }
  });

  /** The host came up long before this service did, which is what a runner crash looks like. */
  const bootedLongAgo = () => Date.parse(record.startedAt) - 3_600_000;

  it('stops the orphan a crashed runner left holding the port', async () => {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const outcome = await reclaimOrphan(
      { ...record, pid: 4242 },
      {
        alive: () => alive,
        bootedAt: bootedLongAgo,
        kill: (_pid, signal) => {
          signals.push(signal);
          alive = false;
        },
        settleMs: 500
      }
    );
    expect(outcome).toBe('killed');
    // SIGTERM only: it went away when asked, so nothing was killed outright.
    expect(signals).toEqual(['SIGTERM']);
  });

  /*
   * After a host reboot every recorded pid has been handed out again from one, and some of them now
   * belong to the box's own system services. Signalling one of those process groups on the strength
   * of a stale number is the worst thing this file could do, so a run that began before this boot is
   * left strictly alone however alive its old number looks.
   *
   * The command line is deliberately not consulted: it cannot do this job, because `sh -c` and
   * every wrapper in the chain exec in place and answer `ps` with something the record never wrote
   * down.
   */
  it('leaves a stranger holding a pid from before the last boot completely alone', async () => {
    const signals: NodeJS.Signals[] = [];
    const outcome = await reclaimOrphan(
      { ...record, pid: 4242 },
      {
        alive: () => true,
        bootedAt: () => Date.parse(record.startedAt) + 1_000,
        kill: (_pid, signal) => signals.push(signal)
      }
    );
    expect(outcome).toBe('foreign');
    expect(signals).toEqual([]);
  });

  it('has nothing to do when the last runner stopped its own services', async () => {
    expect(await reclaimOrphan({ ...record, pid: 4242 }, { alive: () => false })).toBe('gone');
    expect(await reclaimOrphan(record, {})).toBe('gone');
  });
});

describe('a service the computer keeps running', () => {
  it(
    'restarts a service that dies, counts it, and survives a runner restart',
    async () => {
      const root = await workspace();
      // Writes a line every time it starts, so the file is the count of runs across restarts of
      // both the process and the manager - which is the property the record has to agree with.
      const marks = path.join(root, 'workspace', 'starts');
      const manager = new ProcessManager(50, HEALTHY_POLICY);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', `echo start >> ${marks}; sleep 0.05`],
          service: 'mark writer',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      expect(started.sessionId).toMatch(/^svc_/);
      expect(started.service).toMatchObject({
        name: 'mark writer',
        command: ['/bin/sh', '-c', expect.any(String)]
      });

      // It keeps coming back on its own.
      await expect
        .poll(() => manager.list('workspace-1', 'task-1')[0]?.service?.restarts ?? 0, {
          interval: 20,
          timeout: 10_000
        })
        .toBeGreaterThanOrEqual(2);
      const live = manager.list('workspace-1', 'task-1')[0];
      expect(live?.service?.lastExit).toMatchObject({ exitCode: 0 });
      expect(live?.service?.startedAt).not.toEqual(live?.service?.createdAt);

      // The record is on disk, not in a Map, so the next runner can read it.
      const [persisted] = await readRecords(root);
      expect(persisted).toMatchObject({ name: 'mark writer', workspaceId: 'workspace-1' });

      // A runner restart: this manager stops everything, and a fresh one resumes from the file.
      await manager.close();
      const resumedManager = new ProcessManager(50, HEALTHY_POLICY);
      const resumed = await resumedManager.resumeWorkspace(root, 'workspace-1', false);
      expect(resumed).toBe(1);
      expect(resumedManager.listWorkspace('workspace-1')[0]?.service).toMatchObject({
        name: 'mark writer'
      });
      await expect
        .poll(() => readFile(marks, 'utf8').then((text) => text.trim().split('\n').length), {
          interval: 20,
          timeout: 10_000
        })
        .toBeGreaterThanOrEqual(4);
      await resumedManager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'stops restarting something that dies instantly and repeatedly',
    async () => {
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'echo broken >&2; exit 3'],
          service: 'broken service',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      await expect
        .poll(() => manager.list('workspace-1', 'task-1')[0]?.service?.state, {
          interval: 20,
          timeout: 10_000
        })
        .toBe('crash_looped');
      const view = manager.list('workspace-1', 'task-1')[0];
      // It gave up, and it says how it ended rather than disappearing.
      expect(view?.service).toMatchObject({ name: 'broken service', state: 'crash_looped' });
      expect(view?.service?.lastExit).toMatchObject({ exitCode: 3 });
      expect(view?.service?.restarts).toBe(FAST_POLICY.maxRapidFailures - 1);
      // Still readable: the log is how the owner finds out why.
      expect(
        manager.action('workspace-1', 'task-1', started.sessionId, { action: 'log' }).stderr
      ).toContain('broken');
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'stops a service for good when it is killed, and does not bring it back',
    async () => {
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          service: 'long sleeper',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      expect(started.service).toMatchObject({
        name: 'long sleeper',
        state: 'running',
        restarts: 0
      });
      // The owner's own capability is not subject to the task that started it, and must still work.
      const killed = manager.action('workspace-1', null, started.sessionId, { action: 'kill' });
      expect(killed.status).toBe('stopped');
      await expect.poll(() => readRecords(root), { interval: 20, timeout: 5_000 }).toEqual([]);
      const resumedManager = new ProcessManager(50, FAST_POLICY);
      expect(await resumedManager.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
      await manager.close();
      await resumedManager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'never writes down a command that could not start even once',
    async () => {
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      await expect(
        manager.start(
          root,
          'workspace-1',
          'task-1',
          { executable: 'apt-get', args: ['install', '-y', 'nginx'], service: 'web server' },
          5,
          false
        )
      ).rejects.toThrow('cannot run as background processes');
      await expect(readRecords(root)).rejects.toThrow();
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'recognises a real orphan of its own against the real machine',
    async () => {
      /*
       * The one assertion here that a fixture cannot make: a record this manager actually wrote,
       * a process actually running, and the live probes - `processAlive` and this host's own boot
       * time - deciding between them.
       *
       * It is here because the first version of this was written against a fixture and was wrong
       * on every real box. Identity was "the recorded executable appears in what `ps` prints",
       * and a service declared exactly like this one - `/bin/sh -c ...`, which is most of them -
       * execs the inner command and answers `ps` with `sleep 30` within milliseconds. Its own
       * runner read it as a stranger, left it holding the port, and started a second copy beside
       * it.
       */
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          service: 'identifiable',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      const [record] = await new ServiceRegistry(root).load();
      expect(record?.pid).toBeGreaterThan(0);
      expect(Date.parse(record!.startedAt)).toBeGreaterThan(hostBootedAt());

      // The signals are collected rather than sent, so this asserts recognition without racing the
      // manager's own restart of what it would otherwise have just killed.
      const signals: NodeJS.Signals[] = [];
      const outcome = await reclaimOrphan(record!, {
        kill: (_pid, signal) => {
          signals.push(signal);
        },
        settleMs: 20
      });
      expect(outcome).toBe('killed');
      // Still alive after the SIGTERM, because nothing was really signalled - so the escalation the
      // record promises is the one that runs.
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'leaves nothing running and nothing forgotten when the runner shuts down',
    async () => {
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          service: 'long sleeper',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      const pid = (await readRecords(root))[0]?.pid as number;
      expect(pid).toBeGreaterThan(0);
      await manager.close();
      // The record stays - that is what brings it back - but the process does not.
      expect(await readRecords(root)).toHaveLength(1);
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          },
          { interval: 20, timeout: 10_000 }
        )
        .toBe(false);
      expect(() =>
        manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' })
      ).toThrow('not found');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'forgets a workspace being deleted rather than restarting into a tree that is gone',
    async () => {
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          service: 'long sleeper',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      manager.stopWorkspace('workspace-1', { forget: true });
      await expect.poll(() => readRecords(root), { interval: 20, timeout: 5_000 }).toEqual([]);
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'finds every workspace on the box at boot without being told which ones have services',
    async () => {
      // What the runner actually does on startup: it is handed a workspace root and nothing else.
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-service-boot-'));
      roots.push(workspaceRoot);
      const root = path.join(workspaceRoot, 'workspace-1');
      await mkdir(path.join(root, 'workspace'), { recursive: true });
      await mkdir(path.join(workspaceRoot, '.garden-snapshots'), { recursive: true });
      const manager = new ProcessManager(50, HEALTHY_POLICY);
      await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          service: 'long sleeper',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      await manager.close();

      const booted = new ProcessManager(50, HEALTHY_POLICY);
      expect(await booted.resume(workspaceRoot, false)).toBe(1);
      expect(booted.listWorkspace('workspace-1')[0]?.service).toMatchObject({
        name: 'long sleeper',
        // A resume is a restart, and the record says so rather than pretending it never stopped.
        restarts: 1
      });
      await booted.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'has no deadline, whatever deadline the call that declared it asked for',
    async () => {
      /*
       * A service ignores `timeoutSeconds` entirely. Every other thing this manager starts is
       * scoped to a turn, and a capped service would turn "build me a dashboard and give me a link"
       * into a link that stops answering by dinner while the Running row still calls it alive. The
       * ceiling is applied in the same `#launch` both paths share, one ternary away from covering
       * services too.
       */
      const root = await workspace();
      const manager = new ProcessManager(50, HEALTHY_POLICY);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          // A deadline the test can outlive, against a process that lives well past it.
          args: ['-c', 'sleep 30'],
          timeoutSeconds: 1,
          service: 'patient server',
          maxOutputBytes: 4_096
        },
        // The route's own ceiling, which is the other bound that must not reach a service.
        1,
        false
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const view = manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' });
      expect(view.status).toBe('running');
      expect(view.service).toMatchObject({ state: 'running', restarts: 0 });
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'lets the owner read and stop a service without letting anyone write to it',
    async () => {
      /*
       * `owner` is the task a capability is subject to, or null for the person who owns the box.
       * The null case was widened so the owner could stop a service some task started - without it
       * a service was visible in their panel and unstoppable from this computer - and it is
       * deliberately narrowed to reading and stopping. `write` puts chosen bytes on the stdin of a
       * process belonging to another turn, which is the one thing here that could be turned into
       * cross-task influence, and nothing held that line.
       */
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'cat > /dev/null'],
          service: 'reads its stdin',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      // Reading is the whole reason the null case exists, and it still answers.
      expect(
        manager.action('workspace-1', null, started.sessionId, { action: 'poll' }).sessionId
      ).toBe(started.sessionId);
      expect(() =>
        manager.action('workspace-1', null, started.sessionId, { action: 'write', data: 'x' })
      ).toThrow('not found');
      // The task that started it may still write: this is a narrowing of the owner's capability,
      // not a change to what a turn can do with its own session.
      expect(() =>
        manager.action('workspace-1', 'task-1', started.sessionId, {
          action: 'write',
          data: 'x',
          ...manager.inputPlan('workspace-1', 'task-1', started.sessionId, 'x')
        })
      ).not.toThrow();
      await manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'gives a service that had been given up on five more attempts when the runner comes back',
    async () => {
      /*
       * A give-up is not permanent across a restart. The runner coming back is a different machine
       * state - a package installed, a disk mounted, a port released - and five more attempts over
       * a minute is a cheap way to be wrong about it. The alternative is a box that reboots and
       * silently never brings back a service whose dependency happened to be missing at the moment
       * supervision gave up, which is precisely the failure the record on disk exists to prevent.
       */
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'exit 3'],
          service: 'broken service',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      await expect
        .poll(() => manager.list('workspace-1', 'task-1')[0]?.service?.state, {
          interval: 20,
          timeout: 10_000
        })
        .toBe('crash_looped');
      const abandoned = manager.list('workspace-1', 'task-1')[0]?.service?.restarts ?? 0;
      expect(abandoned).toBe(FAST_POLICY.maxRapidFailures - 1);
      await manager.close();

      const booted = new ProcessManager(50, FAST_POLICY);
      // Counted as taken back under supervision, which is not the same as up: it goes round its
      // own backoff from a clean streak and this one is genuinely broken, so it ends where it was.
      expect(await booted.resumeWorkspace(root, 'workspace-1', false)).toBe(1);
      await expect
        .poll(() => booted.listWorkspace('workspace-1')[0]?.service?.state, {
          interval: 20,
          timeout: 10_000
        })
        .toBe('crash_looped');
      // The point: it was actually tried again rather than left where the last runner abandoned it.
      expect(booted.listWorkspace('workspace-1')[0]?.service?.restarts).toBeGreaterThan(abandoned);
      await booted.close();
    },
    TEST_TIMEOUT_MS
  );

  it('renders the owner-facing record from what is on disk', () => {
    const record = newServiceRecord({
      workspaceId: 'workspace-1',
      owner: 'task-1',
      name: 'invoice dashboard',
      launch: {
        executable: 'python3',
        args: ['-m', 'http.server', '8080'],
        cwd: 'workspace',
        env: {},
        network: false,
        maxOutputBytes: 4_096
      },
      at: '2026-08-11T09:00:00.000Z'
    });
    expect(serviceView({ ...record, restarts: 3 })).toEqual({
      serviceId: record.id,
      name: 'invoice dashboard',
      state: 'running',
      command: ['python3', '-m', 'http.server', '8080'],
      createdAt: '2026-08-11T09:00:00.000Z',
      startedAt: '2026-08-11T09:00:00.000Z',
      restarts: 3
    });
  });
});
