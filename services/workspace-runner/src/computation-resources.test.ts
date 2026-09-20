import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComputationSession } from '@athanor/contracts';
import type * as Execution from './execution.js';
import type * as Resources from './process-resources.js';
import type * as Missions from './mission-processes.js';

const observation = vi.hoisted(() => ({ now: 1000, available: true }));
vi.mock('./execution.js', async (original) => ({
  ...(await original<typeof Execution>()),
  prepareInvocation: async (
    root: string,
    request: { executable: string; args: string[]; cwd: string }
  ) => ({
    executable: request.executable,
    args: request.args,
    cwd: path.join(root, request.cwd),
    env: process.env,
    processTreeLease: '/fixture/interpreter.lease'
  })
}));
vi.mock('./mission-processes.js', async (original) => ({
  ...(await original<typeof Missions>()),
  trackMissionInvocation: () => undefined,
  processTreeObservation: async () => {
    if (!observation.available) return null;
    const columns = Array.from({ length: 22 }, () => '0');
    columns[0] = 'S';
    columns[1] = columns[2] = columns[3] = '69';
    columns[11] = '100';
    columns[17] = '1';
    columns[19] = '100';
    return { id: '555', stat: `70 (namespace init) ${columns.join(' ')}` };
  }
}));
vi.mock('./process-resources.js', async (original) => ({
  ...(await original<typeof Resources>()),
  processScanner: () => async () => ({
    at: observation.now,
    ticksPerSecond: 100,
    pageBytes: 4096,
    accountScoped: true,
    processes: [
      { pid: 70, namespace: '555', residentPages: 16 },
      { pid: 101, namespace: '555', residentPages: 32 },
      { pid: 102, namespace: '555', residentPages: 64 },
      { pid: 202, namespace: '777', residentPages: 128 }
    ].map((value) => ({
      ...value,
      parent: 1,
      group: value.pid,
      session: value.pid,
      name: 'analysis',
      state: 'S',
      ticks: observation.now,
      started: 100,
      threads: 1
    }))
  })
}));

import { ComputationManager } from './computation.js';
import { ensureWorkspace } from './files.js';
import { PROCESS_SAMPLE_MS } from './process-resources.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

it('samples an interpreter namespace across detached groups and never counts another project', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'garden-kernel-resources-')));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const workspace = randomUUID(),
    owner = randomUUID();
  await ensureWorkspace(path.join(base, workspace));
  const manager = new ComputationManager(
    base,
    {
      isolateNetwork: true,
      sandbox: {
        elevate: '/usr/bin/sudo',
        helper: '/fixture/helper',
        specDirectory: '/fixture/spec',
        confineFilesystem: true,
        networkIsolation: true
      },
      systemPackages: { mode: 'refused', helper: undefined }
    },
    () => observation.now
  );
  cleanups.push(() => manager.close());
  const session = (await manager.act(workspace, owner, {
    action: 'start',
    language: 'javascript',
    lifetimeSeconds: 3600
  })) as ComputationSession;
  await manager.refreshResources();
  const first = manager.status(workspace, owner, session.sessionId);
  expect(first.resourceState).toBe('available');
  expect(first.resources).toMatchObject({
    processCount: 3,
    threadCount: 3,
    residentBytes: (16 + 32 + 64) * 4096,
    cpuPercent: null
  });
  expect(first.resources!.children.map((child) => child.pid)).toEqual([70, 101, 102]);
  observation.now += PROCESS_SAMPLE_MS;
  await manager.refreshResources();
  const sampled = manager.status(workspace, owner, session.sessionId);
  expect(sampled.resources!.cpuPercent).toBeGreaterThan(0);
  expect(sampled.resources!.sampledAt).not.toBe(first.resources!.sampledAt);
  observation.available = false;
  observation.now += PROCESS_SAMPLE_MS;
  await manager.refreshResources();
  const unavailable = manager.status(workspace, owner, session.sessionId);
  expect(unavailable.resourceState).toBe('unavailable');
  expect(unavailable.resources).toEqual(sampled.resources);
});
