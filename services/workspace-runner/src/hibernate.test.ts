import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type { RunnerConfig } from './config.js';
import { ensureWorkspace } from './files.js';
import { buildServer } from './server.js';

/**
 * Putting the computer to sleep and waking it up, over the two routes the control plane calls.
 *
 * The pair was written late and rested on review. Both halves are about services - the one thing on
 * this box whose whole promise is that it outlives the turn that started it - and they fail in
 * opposite, silent directions: a hibernate that leaves them running means the panel says the
 * machine is asleep while it is still serving pages and holding ports, and a resume that does not
 * put them back means the link the agent handed the owner answers nothing forever, with nothing on
 * screen to say why. Neither shows up as an error anywhere, which is exactly why it needs a test.
 *
 * Written against the real server rather than against `ProcessManager`, because what is being
 * asserted is that these two routes call it: the manager's own stop/resume behaviour is already
 * covered in `services.test.ts`, and the bug this guards against is a route that forgot to.
 */
const disposers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
});

const SETTLE_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

const runnerConfig = (workspaceRoot: string, secret: string): RunnerConfig => ({
  RUNNER_HOST: '127.0.0.1',
  RUNNER_PORT: 4300,
  RUNNER_SHARED_SECRET: secret,
  WORKSPACE_ROOT: workspaceRoot,
  TAR_EXECUTABLE: '/usr/bin/tar',
  SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
  BROWSER_USE_DESKTOP_DISPLAY: false,
  BROWSER_CPU_NICE: 0,
  MAX_EXECUTION_SECONDS: 30,
  RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
  IMAGE_CONVERT_EXECUTABLE: 'magick',
  MAX_BACKGROUND_SECONDS: 120,
  COMMAND_PROCESS_LIMIT: 1024,
  COMMAND_OPEN_FILE_LIMIT: 4096,
  MAX_FILE_BYTES: 1024 * 1024,
  RESERVED_PREVIEW_PORTS: [],
  CHECKPOINT_BTRFS_EXECUTABLE: '/nonexistent/btrfs',
  CHECKPOINT_ZFS_EXECUTABLE: '/nonexistent/zfs',
  CHECKPOINT_PACKAGE_MANIFEST: '/nonexistent/status',
  CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
  CHECKPOINT_RETAIN_TURNS: 20,
  CHECKPOINT_RETAIN_DAILY_DAYS: 14,
  CHECKPOINT_MAX_FILES: 250_000,
  CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
  ISOLATE_AGENT_NETWORK: false
});

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface ServiceView {
  sessionId: string;
  status: string;
  service?: { name: string; state: string; restarts: number };
}

describe('hibernating the computer and waking it again', () => {
  const harness = async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-hibernate-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-hibernate-test-secret-at-least-32-chars';
    const app = await buildServer(runnerConfig(workspaceRoot, secret), {
      // Stated, not measured. Writing `.garden/services.json` passes the host disk floor, so on
      // any machine under two per cent free this test would answer 507 where it expects 200 -
      // a failure about the build machine wearing the costume of a failure about the code.
      // `checkpoints.test.ts` says the rest of it.
      hostStorage: async () => ({
        hostStorageTotalBytes: 100 * 1024 ** 3,
        hostStorageAvailableBytes: 50 * 1024 ** 3
      })
    });
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-0000000000b1';
    const root = path.join(workspaceRoot, id);
    await ensureWorkspace(root);
    // A nonce is spent on first use, so every request in a test needs its own.
    let issued = 0;
    // A capability names the one request it is for, so the route is part of minting one.
    const token = (scopes: string[], method: string, route: string): string =>
      signCapabilityToken(
        {
          sub: 'user',
          workspaceId: id,
          role: 'user',
          scopes,
          aud: capabilityAudience(method, route),
          nonce: `hibernate-${(issued += 1)}`
        },
        secret
      );
    const services = async (): Promise<ServiceView[]> => {
      const listed = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${id}/processes`,
        headers: {
          authorization: `Bearer ${token(['exec'], 'GET', `/v1/workspaces/${id}/processes`)}`
        }
      });
      return listed.json<{ processes: ServiceView[] }>().processes;
    };
    const records = async (): Promise<Array<{ pid?: number; name: string }>> =>
      JSON.parse(await readFile(path.join(root, '.garden', 'services.json'), 'utf8')) as Array<{
        pid?: number;
        name: string;
      }>;
    return { app, id, root, token, services, records };
  };

  it(
    'stops the services it was keeping running, and starts them again on resume',
    async () => {
      const { app, id, root, token, services, records } = await harness();
      // Appends a line every time it starts, so the file counts runs across the pair: the record
      // and the machine have to agree, and only the file can say the process really came back.
      const marks = path.join(root, 'workspace', 'starts');
      const started = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${id}/processes/start`,
        headers: {
          authorization: `Bearer ${token(['exec'], 'POST', `/v1/workspaces/${id}/processes/start`)}`
        },
        payload: {
          executable: '/bin/sh',
          args: ['-c', `echo up >> ${marks}; sleep 30`],
          service: 'invoice dashboard',
          maxOutputBytes: 4_096
        }
      });
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({
        status: 'running',
        service: { name: 'invoice dashboard', state: 'running', restarts: 0 }
      });
      const firstPid = (await records())[0]?.pid;
      expect(firstPid).toBeGreaterThan(0);
      await expect
        .poll(() => readFile(marks, 'utf8').catch(() => ''), {
          interval: 20,
          timeout: SETTLE_TIMEOUT_MS
        })
        .toContain('up');

      const hibernated = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${id}/hibernate`,
        headers: {
          authorization: `Bearer ${token(['workspace.manage'], 'POST', `/v1/workspaces/${id}/hibernate`)}`
        }
      });
      expect(hibernated.json()).toEqual({ id, state: 'hibernated' });

      // Asleep means the process is gone, not merely unlisted: a hibernated computer that still
      // holds a server is not asleep in any sense the owner would recognise, and the panel reads
      // the control plane's word for it rather than the box.
      await expect
        .poll(() => processAlive(firstPid!), { interval: 20, timeout: SETTLE_TIMEOUT_MS })
        .toBe(false);
      expect(await services()).toEqual([]);
      // ...and the record stays on disk, because that is the only thing that can bring it back.
      expect(await records()).toMatchObject([{ name: 'invoice dashboard' }]);

      const resumed = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${id}/resume`,
        headers: {
          authorization: `Bearer ${token(['workspace.manage'], 'POST', `/v1/workspaces/${id}/resume`)}`
        }
      });
      expect(resumed.json()).toEqual({ id, state: 'running' });

      // Back under supervision by the time the route answers, so the panel the owner is looking at
      // when the computer wakes shows the service rather than an empty machine.
      const awake = await services();
      expect(awake).toHaveLength(1);
      expect(awake[0]?.service).toMatchObject({
        name: 'invoice dashboard',
        state: 'running',
        // A resume is a restart, and the record says so rather than pretending it never stopped.
        restarts: 1
      });
      const secondPid = (await records())[0]?.pid;
      expect(secondPid).toBeGreaterThan(0);
      expect(secondPid).not.toBe(firstPid);
      expect(processAlive(secondPid!)).toBe(true);
      // The process itself ran a second time, which is the only claim the file can make for it.
      await expect
        .poll(() => readFile(marks, 'utf8').then((text) => text.trim().split('\n').length), {
          interval: 20,
          timeout: SETTLE_TIMEOUT_MS
        })
        .toBe(2);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses both halves to a capability without workspace.manage',
    async () => {
      // Hibernate stops every process on the computer and resume starts them again; neither is
      // something an `exec` capability - which is what an agent's own shell carries - may do.
      const { app, id, token } = await harness();
      for (const action of ['hibernate', 'resume']) {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/workspaces/${id}/${action}`,
          headers: {
            authorization: `Bearer ${token(['exec'], 'POST', `/v1/workspaces/${id}/${action}`)}`
          }
        });
        expect(response.statusCode).toBe(403);
      }
    },
    TEST_TIMEOUT_MS
  );
});
