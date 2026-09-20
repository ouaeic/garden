import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputationRequest, ComputationSession } from '@athanor/contracts';
import type { input } from 'zod';
import { capabilityAudience, signCapabilityToken } from '@athanor/core';
import type * as Execution from './execution.js';

vi.mock('./execution.js', async (original) => ({
  ...(await original<typeof Execution>()),
  prepareInvocation: vi.fn(
    async (
      root: string,
      request: {
        executable: string;
        args: string[];
        cwd: string;
      }
    ) => ({
      executable: request.executable,
      args: request.args,
      cwd: path.join(root, request.cwd),
      env: process.env
    })
  )
}));

import { ComputationManager } from './computation.js';
import { connectComputationSupervisor } from './computation-service.js';
import { ProcessManager } from './processes.js';
import {
  buildProcessSupervisor,
  connectProcessSupervisor,
  prepareSupervisorRestart
} from './process-supervisor.js';
import { loadConfig } from './config.js';
import { ensureWorkspace } from './files.js';
import { buildServer } from './server.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const policy = {
  isolateNetwork: false,
  sandbox: {
    elevate: '/usr/bin/sudo',
    helper: '/fixture/helper',
    specDirectory: '/fixture/spec',
    confineFilesystem: true,
    networkIsolation: true
  },
  systemPackages: { mode: 'refused' as const, helper: undefined }
};

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'garden-analysis-controller-')));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const workspace = randomUUID(),
    other = randomUUID(),
    owner = randomUUID();
  await ensureWorkspace(path.join(base, workspace));
  await ensureWorkspace(path.join(base, other));
  const secret = 'computation-controller-fixture-secret-thirty-two-characters';
  vi.stubEnv('WORKSPACE_ROOT', base);
  vi.stubEnv('RUNNER_SHARED_SECRET', secret);
  vi.stubEnv('JOB_SUPERVISOR_SOCKET', path.join(base, 'control.sock'));
  vi.stubEnv('ISOLATE_AGENT_NETWORK', 'false');
  vi.stubEnv('CONFINE_AGENT_FILESYSTEM', 'false');
  vi.stubEnv('BROWSER_USE_DESKTOP_DISPLAY', 'false');
  const config = loadConfig(),
    manager = new ComputationManager(base, policy);
  const supervisor = await buildProcessSupervisor(config, new ProcessManager(), manager);
  await supervisor.listen({ path: config.JOB_SUPERVISOR_SOCKET! });
  cleanup.push(() => supervisor.close());
  const client = connectComputationSupervisor(config.JOB_SUPERVISOR_SOCKET!, secret);
  return { base, workspace, other, owner, secret, config, manager, supervisor, client };
}

describe('scientific state owned by the independent controller', () => {
  it.each(['javascript', 'python'] as const)(
    'retains a real %s interpreter and busy cell through runner replacement',
    async (language) => {
      const f = await fixture();
      let runner = await buildServer(f.config);
      cleanup.push(() => runner.close());
      const url = `/v1/workspaces/${f.workspace}/computation`;
      const act = async (payload: input<typeof ComputationRequest>) => {
        const response = await runner.inject({
          method: 'POST',
          url,
          payload,
          headers: {
            authorization: `Bearer ${signCapabilityToken(
              {
                sub: f.owner,
                workspaceId: f.workspace,
                role: 'agent',
                scopes: ['exec', 'files.read'],
                nonce: randomUUID(),
                aud: capabilityAudience('POST', url)
              },
              f.secret
            )}`
          }
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<ComputationSession>();
      };
      const started = await act({ action: 'start', language, lifetimeSeconds: 3600 });
      const initial = await act({
        action: 'cell',
        sessionId: started.sessionId,
        cellId: 'initialize',
        code:
          language === 'javascript'
            ? 'var total = 40; var executions = 0; process.pid'
            : 'total = 40\nexecutions = 0\nimport os\nos.getpid()'
      });
      const pid = (initial.latestCell?.result as { value: number }).value;
      expect(pid).toBeGreaterThan(0);
      const extended = await act({
        action: 'extend',
        sessionId: started.sessionId,
        lifetimeSeconds: 3 * 24 * 60 * 60
      });
      expect(Date.parse(extended.deadlineAt) - Date.parse(started.createdAt)).toBe(
        3 * 24 * 60 * 60 * 1000
      );
      const request: input<typeof ComputationRequest> = {
        action: 'cell',
        sessionId: started.sessionId,
        cellId: 'running-once',
        timeoutSeconds: 30,
        code:
          language === 'javascript'
            ? "executions += 1; console.log('waiting'); while (!require('node:fs').existsSync('release.txt')) { await new Promise(resolve => setTimeout(resolve, 10)); } total += 2; total"
            : "import time\nexecutions += 1\nprint('waiting')\nwhile not os.path.exists('release.txt'):\n    time.sleep(0.01)\ntotal += 2\ntotal"
      };
      expect(await act(request)).toMatchObject({ state: 'busy', stateRetained: true });
      expect(prepareSupervisorRestart(f.supervisor)).toBe(false);
      const health = (await runner.inject({ url: '/healthz' })).json<Record<string, unknown>>();
      expect(health).toMatchObject({
        computationSupervisor: 'independent',
        backgroundCommands: 1,
        runnerRestartUnsafeCommands: 0
      });
      await runner.close();
      runner = await buildServer(f.config);
      expect(await act({ action: 'status', sessionId: started.sessionId })).toMatchObject({
        state: 'busy',
        stateRetained: true,
        deadlineAt: extended.deadlineAt,
        latestCell: { cellId: 'running-once', state: 'running', stdout: 'waiting\n' }
      });
      await writeFile(path.join(f.base, f.workspace, 'workspace/release.txt'), 'continue');
      await expect
        .poll(async () => (await act({ action: 'status', sessionId: started.sessionId })).state)
        .toBe('idle');
      const finished = await act(request);
      expect(finished.latestCell).toMatchObject({
        cellId: 'running-once',
        state: 'completed',
        result: { value: 42 }
      });
      const values = await act({
        action: 'cell',
        sessionId: started.sessionId,
        cellId: 'verify-memory',
        code:
          language === 'javascript'
            ? 'JSON.stringify([total, executions, process.pid])'
            : 'import json\njson.dumps([total, executions, os.getpid()])'
      });
      expect(JSON.parse((values.latestCell?.result as { value: string }).value)).toEqual([
        42,
        1,
        pid
      ]);
      expect((await act(request)).latestCell).toEqual(finished.latestCell);
      expect(prepareSupervisorRestart(f.supervisor)).toBe(false);
      await expect(
        f.client.act(f.other, f.owner, { action: 'stop', sessionId: started.sessionId })
      ).rejects.toThrow('not found');
      await expect(
        f.client.act(f.workspace, 'another-owner', { action: 'stop', sessionId: started.sessionId })
      ).rejects.toThrow('not found');
      expect(await f.client.list(f.workspace, 'another-owner')).toEqual([]);
      const listing = await runner.inject({
        url,
        headers: {
          authorization: `Bearer ${signCapabilityToken(
            {
              sub: f.owner,
              workspaceId: f.workspace,
              role: 'agent',
              scopes: ['files.read'],
              nonce: randomUUID(),
              aud: capabilityAudience('GET', url)
            },
            f.secret
          )}`
        }
      });
      expect(listing.statusCode, listing.body).toBe(200);
      expect(listing.json<{ sessions: ComputationSession[] }>().sessions).toMatchObject([
        { sessionId: started.sessionId, state: 'idle' }
      ]);
      expect(await act({ action: 'stop', sessionId: started.sessionId })).toMatchObject({
        state: 'stopped',
        stateRetained: false
      });
      expect(prepareSupervisorRestart(f.supervisor)).toBe(true);
      await expect(
        f.client.act(f.workspace, f.owner, { action: 'start', language })
      ).rejects.toThrow('restarting');
    },
    30_000
  );

  it('defers reload during admission without closing unrelated job admission', async () => {
    const f = await fixture();
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actual = f.manager.act.bind(f.manager);
    vi.spyOn(f.manager, 'act').mockImplementationOnce(async (...args) => {
      enter();
      await released;
      return actual(...args);
    });
    const admission = Promise.resolve(
      f.client.act(f.workspace, f.owner, { action: 'start', language: 'javascript' })
    );
    try {
      await entered;
      expect(prepareSupervisorRestart(f.supervisor)).toBe(false);
      const jobs = connectProcessSupervisor(f.config.JOB_SUPERVISOR_SOCKET!, f.secret);
      const job = await jobs.start(
        path.join(f.base, f.other),
        f.other,
        f.owner,
        { executable: process.execPath, args: ['-e', 'console.log(42)'], job: 'Independent work' },
        60,
        false
      );
      expect(job.sessionId).toBeTruthy();
      await expect
        .poll(
          async () =>
            (await jobs.action(f.other, f.owner, job.sessionId, { action: 'poll' })).status
        )
        .toBe('completed');
    } finally {
      release();
    }
    const session = (await admission) as ComputationSession;
    expect(session.state).toBe('idle');
    expect(prepareSupervisorRestart(f.supervisor)).toBe(false);
    await f.client.stopOwner(f.workspace, f.owner);
    expect(await f.client.backgroundWork()).toMatchObject({ commands: 0 });
    expect(prepareSupervisorRestart(f.supervisor)).toBe(true);
  });

  it('keeps owner stops and workspace quiescence scoped through the controller', async () => {
    const f = await fixture();
    const first = (await f.client.act(f.workspace, f.owner, {
      action: 'start',
      language: 'javascript'
    })) as ComputationSession;
    const second = (await f.client.act(f.other, 'other-owner', {
      action: 'start',
      language: 'javascript'
    })) as ComputationSession;
    await f.client.stopOwner(f.workspace, 'other-owner');
    expect(await f.client.isWorkspaceBusy(f.workspace)).toBe(true);
    await f.client.quiesceWorkspace(f.workspace);
    expect(await f.client.isWorkspaceBusy(f.workspace)).toBe(false);
    expect(
      await f.client.act(f.workspace, f.owner, { action: 'status', sessionId: first.sessionId })
    ).toMatchObject({ state: 'stopped' });
    expect(
      await f.client.act(f.other, 'other-owner', { action: 'status', sessionId: second.sessionId })
    ).toMatchObject({ state: 'idle', stateRetained: true });
    await f.client.stopWorkspace(f.other);
    expect(await f.client.backgroundWork()).toMatchObject({ commands: 0 });
    expect(await f.client.history(f.workspace, [f.owner])).toMatchObject({
      entries: [],
      nextCursor: null
    });
  });

  it('refuses unauthenticated or malformed private requests before dispatch', async () => {
    const f = await fixture();
    await expect(
      connectComputationSupervisor(f.config.JOB_SUPERVISOR_SOCKET!, 'wrong').backgroundWork()
    ).rejects.toThrow('Unauthorized');
    const act = vi.spyOn(f.manager, 'act');
    const bad = [
      { version: 1, method: 'restore', args: [] },
      {
        version: 1,
        method: 'act',
        args: ['../outside', f.owner, { action: 'start', language: 'javascript' }]
      },
      {
        version: 2,
        method: 'act',
        args: [f.workspace, f.owner, { action: 'start', language: 'javascript' }]
      },
      {
        version: 1,
        method: 'act',
        args: [f.workspace, f.owner, { action: 'start', language: 'javascript' }],
        policy: { sandbox: false }
      }
    ];
    expect(bad.length).toBeGreaterThan(0);
    for (const payload of bad) {
      const result = await f.supervisor.inject({
        method: 'POST',
        url: '/computation',
        headers: { authorization: `Bearer ${f.secret}` },
        payload
      });
      expect(result.statusCode, result.body).toBe(400);
    }
    expect(act).not.toHaveBeenCalled();
  });

  it('honors a declared lifetime after the observing client disconnects', async () => {
    const f = await fixture();
    const started = (await f.client.act(f.workspace, f.owner, {
      action: 'start',
      language: 'javascript',
      lifetimeSeconds: 2
    })) as ComputationSession;
    expect(started.state).toBe('idle');
    await f.client.close();
    const reconnected = connectComputationSupervisor(f.config.JOB_SUPERVISOR_SOCKET!, f.secret);
    await expect
      .poll(
        () =>
          reconnected.act(f.workspace, f.owner, {
            action: 'status',
            sessionId: started.sessionId
          }),
        { timeout: 5000 }
      )
      .toMatchObject({ state: 'expired', stateRetained: false });
    await expect
      .poll(() => reconnected.backgroundWork())
      .toMatchObject({ commands: 0, longestRemainingMs: null });
    expect(prepareSupervisorRestart(f.supervisor)).toBe(true);
  });

  it('preserves an unreadable journal when controller startup fails', async () => {
    const f = await fixture();
    await f.supervisor.close();
    const filename = path.join(f.base, '.athanor/computation.json'),
      corrupt = '{incomplete';
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, corrupt);
    await expect(buildProcessSupervisor(f.config)).rejects.toThrow();
    expect(await readFile(filename, 'utf8')).toBe(corrupt);
  });
});
