import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type { RunnerConfig } from './config.js';
import { ensureWorkspace } from './files.js';
import { buildServer } from './server.js';

/**
 * The two time ceilings, measured where they are actually applied.
 *
 * There were four numbers spelling one hour and only one of them enforced anything. The tool
 * catalogue said 3,600 and is advice to a model - nothing in the worker validates a tool call
 * against it. The runner's two request schemas said 86,400 and no caller could ever reach it.
 * `TOOL_REQUEST_TIMEOUT_MS` in the worker bounds a held-open HTTP request and not a command. What
 * actually stopped work was `MAX_EXECUTION_SECONDS`, clamped in with `Math.min` on both paths, and
 * a six-hour alignment therefore died at the one-hour mark with nothing in the result naming
 * either number.
 *
 * These two cases are the whole change, and they have to be routed rather than unit tests: the
 * distinction is which config value each ROUTE hands to which executor, and a bound proved on the
 * executor while its caller passed the other number is a defect this repository has shipped twice.
 * Same command, same seconds, same workspace, same token shape - refused in the foreground and
 * accepted in the background.
 */
const runnerConfig = (workspaceRoot: string, secret: string): RunnerConfig =>
  ({
    RUNNER_HOST: '127.0.0.1',
    RUNNER_PORT: 4300,
    RUNNER_SHARED_SECRET: secret,
    WORKSPACE_ROOT: workspaceRoot,
    TAR_EXECUTABLE: '/usr/bin/tar',
    SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
    BROWSER_USE_DESKTOP_DISPLAY: false,
    BROWSER_CPU_NICE: 0,
    // Deliberately different from each other, which is the property under test. On the shipped
    // configuration they are an hour and a day.
    MAX_EXECUTION_SECONDS: 30,
    MAX_BACKGROUND_SECONDS: 120,
    RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
    IMAGE_CONVERT_EXECUTABLE: 'magick',
    COMMAND_PROCESS_LIMIT: 1024,
    COMMAND_OPEN_FILE_LIMIT: 4096,
    MAX_FILE_BYTES: 1024 * 1024,
    RESERVED_PREVIEW_PORTS: [],
    CHECKPOINT_BTRFS_EXECUTABLE: '/usr/bin/btrfs',
    CHECKPOINT_ZFS_EXECUTABLE: '/usr/sbin/zfs',
    CHECKPOINT_PACKAGE_MANIFEST: '/nonexistent/status',
    CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
    CHECKPOINT_RETAIN_TURNS: 20,
    CHECKPOINT_RETAIN_DAILY_DAYS: 14,
    CHECKPOINT_MAX_FILES: 250_000,
    CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
    ISOLATE_AGENT_NETWORK: false
  }) as RunnerConfig;

describe('a long job is bounded by the path it runs on', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  const harness = async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-longwork-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-longwork-test-secret-at-least-32-characters';
    const app = await buildServer(runnerConfig(workspaceRoot, secret));
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-0000000000c1';
    await ensureWorkspace(path.join(workspaceRoot, id));
    let issued = 0;
    // A nonce is spent on first use, so every request in a test needs its own.
    const token = (method: string, route: string): string =>
      signCapabilityToken(
        {
          sub: 'task-1',
          workspaceId: id,
          role: 'agent',
          scopes: ['exec'],
          aud: capabilityAudience(method, `/v1/workspaces/${id}${route}`),
          nonce: `longwork-${(issued += 1)}`
        },
        secret
      );
    return { app, id, token };
  };

  it('refuses in the foreground, naming the field that would carry it', async () => {
    const { app, id, token } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/exec`,
      headers: {
        authorization: `Bearer ${token('POST', '/exec')}`,
        'content-type': 'application/json'
      },
      payload: { executable: '/bin/sh', args: ['-c', 'sleep 60'], timeoutSeconds: 60 }
    });

    expect(response.statusCode).toBe(400);
    const { message } = response.json<{ error: { message: string } }>().error;
    // Both numbers, because they are different facts: what was asked for, and what is allowed.
    expect(message).toContain('30s');
    expect(message).toContain('60s');
    expect(message).toContain('background: true');
  });

  /*
   * The same sixty seconds, accepted. Nothing holds a request open on this route - it returns a
   * session id in milliseconds - so the foreground's hour is not about a resource this process
   * spends, and applied here it would make a six-hour alignment or a variant-calling run impossible
   * to ask for on the one path built to outlive a turn.
   */
  it('accepts the identical command in the background', async () => {
    const { app, id, token } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/processes/start`,
      headers: {
        authorization: `Bearer ${token('POST', '/processes/start')}`,
        'content-type': 'application/json'
      },
      payload: { executable: '/bin/sh', args: ['-c', 'sleep 60'], timeoutSeconds: 60 }
    });

    expect(response.statusCode).toBe(200);
    const started = response.json<{ status: string; sessionId: string; ranForMs: number }>();
    expect(started.status).toBe('running');
    // The field that makes supervising this job possible at all: every other thing a poll returns
    // is fixed for the life of the session, so a silent job's polls were byte-identical and the
    // turn guard stopped the agent for repeating itself.
    expect(typeof started.ranForMs).toBe('number');

    const killed = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/processes/${started.sessionId}`,
      headers: {
        authorization: `Bearer ${token('POST', `/processes/${started.sessionId}`)}`,
        'content-type': 'application/json'
      },
      payload: { action: 'kill' }
    });
    expect(killed.statusCode).toBe(200);
  });
});

/**
 * The guard the removed per-file rlimit handed its job to, proved where the command actually runs.
 *
 * RLIMIT_FSIZE is gone because of how it failed - SIGXFSZ, an empty stderr and a truncated file
 * that `ls` reports as present, or exit 0 and a truncated file when the writer is not the last
 * stage of a pipeline - and the argument for removing rather than raising it is that the host-disk
 * floor already covers a runaway write, on both paths, and covers what an rlimit cannot see at all.
 * That makes this floor load-bearing in a way it was not before.
 *
 * It had no case through a route. `RunnerServerOptions.hostStorage` says it is injected so the
 * disk floor can be exercised without filling a filesystem, and it reached the pre-flight write
 * check and the checkpoints but not the floor that polls while a command runs - `buildServer` did
 * not put it in `guards`. So the floor was proved on `execute` and on `ProcessManager` with the
 * probe passed in by hand, and the callers those tests stand in for had no case at all. That is
 * the shape this repository has shipped twice, and it is the reason this test is routed.
 */
describe('the host-disk floor reaches a command started through the route', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it('stops it, and says so on the command own stderr', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-longwork-floor-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-longwork-test-secret-at-least-32-characters';
    let reads = 0;
    const app = await buildServer(runnerConfig(workspaceRoot, secret), {
      // Healthy when the command starts, past the floor once it is running: the pre-flight cannot
      // catch this by construction, because the command is what fills the disk.
      hostStorage: async () => ({
        hostStorageTotalBytes: 100 * 1024 ** 3,
        hostStorageAvailableBytes: (reads += 1) > 1 ? 64 * 1024 ** 2 : 50 * 1024 ** 3
      })
    });
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-0000000000c2';
    await ensureWorkspace(path.join(workspaceRoot, id));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/exec`,
      headers: {
        authorization: `Bearer ${signCapabilityToken(
          {
            sub: 'task-1',
            workspaceId: id,
            role: 'agent',
            scopes: ['exec'],
            aud: capabilityAudience('POST', `/v1/workspaces/${id}/exec`),
            nonce: 'longwork-floor-1'
          },
          secret
        )}`,
        'content-type': 'application/json'
      },
      // A spin rather than a write: what is under test is that the probe reaches the poll, and a
      // process wedged in uninterruptible write I/O measures the kernel's signal delivery instead.
      payload: { executable: '/bin/sh', args: ['-c', 'while true; do :; done'], timeoutSeconds: 25 }
    });

    const body = response.json<{ stderr: string; stoppedReason?: string; timedOut: boolean }>();
    expect(body.stoppedReason).toBe('host_disk_floor');
    expect(body.timedOut).toBe(false);
    expect(body.stderr).toContain('last of the host disk');
  }, 30_000);
});

/**
 * The deadline, said before the work is gone rather than after.
 *
 * Measured on this branch before these fields existed: a background session one second from its
 * deadline answered a poll with `status: "running"`, `ranForMs: 1009`, its command and its start
 * time, and nothing else. The only sentence that ever named the deadline was `timedOutNote`,
 * appended to stderr at the moment the process was killed - so the whole of this computer's warning
 * about a twenty-hour job arrived after the twenty hours had been spent. An agent had no way to
 * know, and neither did the owner's panel, which reads the same view.
 *
 * Routed rather than unit, and against the START response as well as the poll, because the earliest
 * possible warning is the answer to the request that starts the job: `apps/worker/src/tools/
 * workspace.ts` returns the runner's body to the model verbatim on both the `shell` and the
 * `process` arms, so a field here is a field the model reads.
 */
describe('a background job says when it will be killed', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  const harness = async (
    workspaceId: string,
    overrides: Partial<RunnerConfig> = {},
    nonceTag = 'deadline'
  ) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-deadline-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-longwork-test-secret-at-least-32-characters';
    const app = await buildServer({
      ...runnerConfig(workspaceRoot, secret),
      ...overrides
    } as RunnerConfig);
    disposers.push(() => app.close());
    await ensureWorkspace(path.join(workspaceRoot, workspaceId));
    let issued = 0;
    const token = (method: string, route: string): string =>
      signCapabilityToken(
        {
          sub: 'task-1',
          workspaceId,
          role: 'agent',
          scopes: ['exec'],
          aud: capabilityAudience(method, `/v1/workspaces/${workspaceId}${route}`),
          nonce: `${nonceTag}-${(issued += 1)}`
        },
        secret
      );
    return { app, token };
  };

  interface Started {
    sessionId: string;
    status: string;
    deadlineAt?: string;
    remainingMs?: number;
  }

  it('on the answer that starts it, and on every poll after', async () => {
    const id = '00000000-0000-4000-8000-0000000000e1';
    const { app, token } = await harness(id);
    const before = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/processes/start`,
      headers: {
        authorization: `Bearer ${token('POST', '/processes/start')}`,
        'content-type': 'application/json'
      },
      payload: { executable: '/bin/sh', args: ['-c', 'sleep 90'], timeoutSeconds: 90 }
    });
    expect(response.statusCode).toBe(200);
    const started = response.json<Started>();
    expect(started.status).toBe('running');
    // The wall-clock moment, within the second this request took, of ninety seconds from now.
    const deadline = Date.parse(started.deadlineAt ?? '');
    expect(deadline).toBeGreaterThanOrEqual(before + 90_000);
    expect(deadline).toBeLessThan(before + 95_000);
    // And the number a model can actually use, having no clock of its own to subtract from.
    expect(started.remainingMs).toBeGreaterThan(85_000);
    expect(started.remainingMs).toBeLessThanOrEqual(90_000);

    const polled = (
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${id}/processes/${started.sessionId}`,
        headers: {
          authorization: `Bearer ${token('POST', `/processes/${started.sessionId}`)}`,
          'content-type': 'application/json'
        },
        payload: { action: 'poll' }
      })
    ).json<Started>();
    // Fixed across polls, which is what a panel renders; the countdown is what moves.
    expect(polled.deadlineAt).toBe(started.deadlineAt);
    expect(polled.remainingMs).toBeLessThanOrEqual(started.remainingMs!);
  });

  /*
   * The absence is the statement. A service has no deadline at all - that is what declaring one
   * buys - so a zero or a far-future timestamp here would be a lie about the one thing on this box
   * whose promise is that it does not stop.
   */
  it('and says nothing of the kind about a service, which has no deadline', async () => {
    const id = '00000000-0000-4000-8000-0000000000e2';
    const { app, token } = await harness(id, {}, 'deadline-service');
    const started = (
      await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${id}/processes/start`,
        headers: {
          authorization: `Bearer ${token('POST', '/processes/start')}`,
          'content-type': 'application/json'
        },
        payload: {
          executable: '/bin/sh',
          args: ['-c', 'sleep 90'],
          service: 'invoice dashboard',
          maxOutputBytes: 4_096
        }
      })
    ).json<Started & { service?: { name: string } }>();
    expect(started.service?.name).toBe('invoice dashboard');
    expect(started.deadlineAt).toBeUndefined();
    expect(started.remainingMs).toBeUndefined();
    const killed = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/processes/${started.sessionId}`,
      headers: {
        authorization: `Bearer ${token('POST', `/processes/${started.sessionId}`)}`,
        'content-type': 'application/json'
      },
      payload: { action: 'kill' }
    });
    expect(killed.statusCode).toBe(200);
  });
});

/**
 * `MAX_BACKGROUND_SECONDS` is the ceiling, and raising it raises what the box will run.
 *
 * It is documented as the ceiling and an owner can set it, and until the `.max(86_400)` came off
 * `BackgroundRequest` raising it above a day did nothing whatsoever. Measured on this branch with
 * the ceiling at 172,800 and 129,600s asked for: HTTP 400, `runner_invalid_request - timeoutSeconds:
 * too big: expected number to be <=86400`. A zod sentence naming a number that was not this box's
 * limit, refusing a run this box was configured to allow - the declaration strictly stricter than
 * the enforcement, which is the shape a commit on this branch already fixed once in the other
 * direction and reintroduced here. The owner with a forty-hour genome assembly, which is the work
 * this computer exists for, had no configuration that would run it.
 *
 * Both directions, because a ceiling that refuses nothing is the opposite defect and just as easy
 * to ship: the same server, above and below its own number.
 */
describe('the ceiling an owner configures is the ceiling the box enforces', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  const harness = async (workspaceId: string, ceilingSeconds: number, nonceTag: string) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-ceiling-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-longwork-test-secret-at-least-32-characters';
    const app = await buildServer({
      ...runnerConfig(workspaceRoot, secret),
      MAX_BACKGROUND_SECONDS: ceilingSeconds
    } as RunnerConfig);
    disposers.push(() => app.close());
    await ensureWorkspace(path.join(workspaceRoot, workspaceId));
    let issued = 0;
    const start = (timeoutSeconds: number) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/processes/start`,
        headers: {
          authorization: `Bearer ${signCapabilityToken(
            {
              sub: 'task-1',
              workspaceId,
              role: 'agent',
              scopes: ['exec'],
              aud: capabilityAudience('POST', `/v1/workspaces/${workspaceId}/processes/start`),
              nonce: `${nonceTag}-${(issued += 1)}`
            },
            secret
          )}`,
          'content-type': 'application/json'
        },
        payload: { executable: '/bin/sh', args: ['-c', 'sleep 5'], timeoutSeconds }
      });
    return { app, start };
  };

  // Two days of ceiling, thirty-six hours asked for: past a day and inside what this box was told
  // to allow.
  it('runs a thirty-six hour job on a box whose owner allowed two days', async () => {
    const { start } = await harness('00000000-0000-4000-8000-0000000000e3', 172_800, 'ceiling-up');
    const response = await start(129_600);
    expect(response.statusCode).toBe(200);
    const started = response.json<{ status: string; deadlineAt?: string }>();
    expect(started.status).toBe('running');
    // The deadline the caller asked for, not a day imposed by the schema.
    const hoursAway = (Date.parse(started.deadlineAt ?? '') - Date.now()) / 3_600_000;
    expect(hoursAway).toBeGreaterThan(35.9);
    expect(hoursAway).toBeLessThan(36.1);
  });

  /*
   * And the other direction, in the runner's own sentence rather than the schema's. What the caller
   * asked for and what the box allows are different facts and both are named, which is the whole
   * difference between this refusal and the zod one it replaces: the number here is the number in
   * this box's runner.env, so an owner reading it over a model's shoulder knows which line to edit.
   */
  it('refuses past its own ceiling, naming the ceiling this box actually has', async () => {
    const { start } = await harness('00000000-0000-4000-8000-0000000000e4', 120, 'ceiling-down');
    const response = await start(86_400);
    expect(response.statusCode).toBe(400);
    const { message } = response.json<{ error: { message: string } }>().error;
    expect(message).toContain('120s');
    expect(message).toContain('86400s');
    // The zod cap's wording, which named a constant instead of this box.
    expect(message).not.toContain('expected number to be');
  });
});

/**
 * The update gate, driven from where the update actually runs.
 *
 * `ProcessManager.backgroundWork()` was computed and had no caller, so `/healthz` said nothing
 * about running work and both arms of `garden update` took their "could not tell" branch and went
 * ahead - while docs/OPERATIONS.md and docs/AGENT_RUNTIME.md told the owner the stand-down already
 * happened. The route now publishes it, and this is the case that holds the whole chain shut.
 *
 * WHY IT IS WRITTEN THIS WAY. The link between the runner and the update is not a call: it is two
 * field names, `backgroundCommands` and `backgroundLongestRemainingMs`, that a `sed` pattern in
 * scripts/garden looks for in the response body. No compiler checks that, and a helper-level test
 * - one that calls `backgroundWork()` and asserts on its return - passes identically whether or not
 * the route emits anything, which is the pin this repository has shipped four times and the reason
 * the defect kept coming back. So this test starts a real background job through the real route,
 * takes the real bytes `/healthz` answers, and runs the REAL shell: `runner_background_work`,
 * `background_work_summary` and both gate blocks are cut out of scripts/garden at test time by
 * their own first and last lines, never copied here. If the script is edited so those anchors move,
 * the cut throws by name rather than silently testing a stale copy of the shell.
 *
 * The only thing stubbed is `curl`, because the shell asks 127.0.0.1:4300 and this process serves
 * through `inject`. What it prints is the response body verbatim.
 */
describe('an update stands down for the background work this runner reports', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  const scriptPath = path.resolve('../../scripts/garden');

  /**
   * The `occurrence`-th run of lines from `first` to `last`, inclusive. Both gate blocks begin with
   * the same call, which is why this counts rather than taking the first.
   */
  const cut = (source: string, first: string, last: string, occurrence = 1): string => {
    const lines = source.split('\n');
    let from = -1;
    for (let seen = 0; seen < occurrence; seen += 1) {
      from = lines.indexOf(first, from + 1);
      if (from === -1)
        throw new Error(`scripts/garden no longer has ${occurrence} occurrence(s) of ${first}`);
    }
    const to = lines.indexOf(last, from + 1);
    if (to === -1) throw new Error(`scripts/garden: no ${last} after ${first}`);
    return lines.slice(from, to + 1).join('\n');
  };

  /** Runs a program under /bin/sh with a `curl` on PATH that answers `body`, or fails if null. */
  const runShell = async (
    program: string,
    body: string | null
  ): Promise<{ status: number | null; stdout: string; stderr: string }> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'garden-gate-'));
    disposers.push(() => rm(dir, { recursive: true, force: true }));
    const bodyFile = path.join(dir, 'healthz.json');
    if (body !== null) await writeFile(bodyFile, body);
    const curl = path.join(dir, 'curl');
    // Exit 7 is curl's "failed to connect", which is what a stopped runner looks like here.
    await writeFile(curl, body === null ? '#!/bin/sh\nexit 7\n' : `#!/bin/sh\ncat ${bodyFile}\n`);
    await chmod(curl, 0o755);
    const programFile = path.join(dir, 'gate.sh');
    await writeFile(programFile, program);
    const run = spawnSync('/bin/sh', [programFile], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };

  const gates = async () => {
    const source = await readFile(scriptPath, 'utf8');
    const helpers = [
      cut(source, 'fail() {', '}'),
      cut(source, 'runner_background_work() {', '}'),
      cut(source, 'background_work_summary() {', '}'),
      // The unattended arm records why it stood down; `doctor` reads that line. Stubbed to print,
      // because what the state file looks like is not what this case is about.
      'record_update_status() { printf \'RECORDED %s: %s\\n\' "$1" "$2"; }'
    ].join('\n');
    // Wrapped in a function of their own because the unattended block ends in `return 0`, which is
    // an error at the top level of a script. `UPDATE PROCEEDED` is the line that only prints when
    // the gate let the update through, and it is the assertion that matters in both directions.
    const wrap = (block: string, name: string): string =>
      `set -eu\n${helpers}\n${name}() {\n${block}\n  printf 'UPDATE PROCEEDED\\n'\n}\n${name}\n`;
    return {
      byHand: wrap(cut(source, '  runner_background_work', '  esac', 1), 'update_gate'),
      unattended: wrap(cut(source, '  runner_background_work', '  esac', 2), 'auto_gate')
    };
  };

  const harness = async (workspaceId: string, nonceTag: string) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-gate-runner-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-longwork-test-secret-at-least-32-characters';
    const app = await buildServer(runnerConfig(workspaceRoot, secret));
    disposers.push(() => app.close());
    await ensureWorkspace(path.join(workspaceRoot, workspaceId));
    let issued = 0;
    const start = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/processes/start`,
        headers: {
          authorization: `Bearer ${signCapabilityToken(
            {
              sub: 'task-1',
              workspaceId,
              role: 'agent',
              scopes: ['exec'],
              aud: capabilityAudience('POST', `/v1/workspaces/${workspaceId}/processes/start`),
              nonce: `${nonceTag}-${(issued += 1)}`
            },
            secret
          )}`,
          'content-type': 'application/json'
        },
        payload
      });
    const health = async () => (await app.inject({ method: 'GET', url: '/healthz' })).body;
    return { app, start, health };
  };

  it('refuses by hand, and names what is running and how long it has left', async () => {
    const { start, health } = await harness('00000000-0000-4000-8000-0000000000f1', 'gate-hand');
    expect(
      (await start({ executable: '/bin/sh', args: ['-c', 'sleep 90'], timeoutSeconds: 90 }))
        .statusCode
    ).toBe(200);
    const body = await health();
    const { byHand } = await gates();
    const run = await runShell(byHand, body);

    // `fail` exits 1, so the update never reaches the line that stops the server.
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('UPDATE PROCEEDED');
    expect(run.stderr).toContain('1 background command(s) are still running');
    // 90s of deadline, rounded the way the shell rounds it. The count alone is not what makes an
    // operator wait; this is.
    expect(run.stderr).toContain('the longest has about 2 minutes left');
    expect(run.stderr).toContain('GARDEN_UPDATE_OVER_BACKGROUND_WORK=1');
    // The branch this route existed to close. Reaching it would mean the field never arrived.
    expect(run.stdout).not.toContain('cannot tell');
  });

  it('stands down unattended on the same body, and records why', async () => {
    const { start, health } = await harness('00000000-0000-4000-8000-0000000000f2', 'gate-auto');
    expect(
      (await start({ executable: '/bin/sh', args: ['-c', 'sleep 90'], timeoutSeconds: 90 }))
        .statusCode
    ).toBe(200);
    const body = await health();
    const { unattended } = await gates();
    const run = await runShell(unattended, body);

    // Standing down is not a failure: the timer's unit must exit clean or the box files an alert
    // for a night on which nothing went wrong.
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('UPDATE PROCEEDED');
    expect(run.stdout).toContain('the next weekly window will retry');
    // Silence here is how a box quietly stops updating for ever; `doctor` reads this line.
    expect(run.stdout).toContain('RECORDED skipped: 1 background command(s)');
  });

  /*
   * The other direction, which is the half that makes the gate a gate rather than a brake. A box
   * with nothing running must update, and so must a box whose only long-lived process is a DECLARED
   * SERVICE - a service is written down in .garden/services.json and `resume` brings it back, so
   * standing down for one would mean a box that runs a dashboard never updates again.
   */
  it('goes ahead with nothing running, and goes ahead for a declared service', async () => {
    const { start, health } = await harness('00000000-0000-4000-8000-0000000000f3', 'gate-idle');
    const { byHand } = await gates();
    const idle = await runShell(byHand, await health());
    expect(idle.status).toBe(0);
    expect(idle.stdout).toContain('UPDATE PROCEEDED');
    expect(idle.stdout).not.toContain('background command(s) are still running');

    const service = await start({
      executable: '/bin/sh',
      args: ['-c', 'sleep 90'],
      service: 'invoice dashboard',
      maxOutputBytes: 4_096
    });
    expect(service.statusCode).toBe(200);
    const withService = await runShell(byHand, await health());
    expect(withService.status).toBe(0);
    expect(withService.stdout).toContain('UPDATE PROCEEDED');
  });

  /*
   * A runner OLDER than this change, and a runner that is not answering at all. `garden update`
   * runs the previous release's copy of this script against whatever is on the disk, so the shell
   * always has to cope with a runner that predates the field - and the two absences mean opposite
   * things. A missing field is "could not tell": the update says so out loud and proceeds, because
   * refusing to update a box that cannot answer a question makes that box unfixable. A runner that
   * is not serving is a true zero: there is nothing running for a restart to destroy.
   *
   * The old body is the one measured on the production VPS, which runs f02ca24.
   */
  it('says it could not tell against a runner from before this field, and treats a dead runner as idle', async () => {
    const { byHand } = await gates();
    const old = await runShell(
      byHand,
      '{"ok":true,"service":"workspace-runner","agentSandbox":true,"agentNetworkIsolated":false}'
    );
    expect(old.status).toBe(0);
    expect(old.stdout).toContain('does not report background commands');
    expect(old.stdout).toContain('UPDATE PROCEEDED');

    const down = await runShell(byHand, null);
    expect(down.status).toBe(0);
    expect(down.stdout).not.toContain('does not report background commands');
    expect(down.stdout).toContain('UPDATE PROCEEDED');
  });
});
