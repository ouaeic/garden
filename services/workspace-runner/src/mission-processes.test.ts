import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as FileSystem from 'node:fs/promises';
const gateWrite = vi.hoisted(() => ({
  file: '',
  before: undefined as (() => Promise<void>) | undefined
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FileSystem>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (args[0] === gateWrite.file && args[1] === 'stop' && gateWrite.before) {
        const before = gateWrite.before;
        gateWrite.before = undefined;
        await before();
      }
      return actual.writeFile(...args);
    }
  };
});
import {
  createMissionLease,
  discardMissionInvocation,
  freezeMissionWorkspace,
  managedWorkspaceBusy,
  missionWorkspaceBusy,
  quiesceManagedChildren,
  trackMissionInvocation
} from './mission-processes.js';
import {
  agentSandbox,
  resolveAgentSandbox,
  sandboxedInvocation,
  sandboxSpecDirectory
} from './sandbox.js';
import { ProcessManager } from './processes.js';
import { ensureWorkspace } from './files.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  gateWrite.before = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('reuses confirmed teardown when wrapper exit settles during a pending gate closure', async () => {
  const { root, file, sandbox } = await fixture();
  await createMissionLease(root, file, sandbox);
  const lease = JSON.parse(await readFile(file, 'utf8')) as object;
  const child = spawn(
    process.execPath,
    ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
    {
      detached: true,
      stdio: 'pipe'
    }
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const closing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stopping: { promise?: Promise<void> } = {};
  cleanups.push(async () => {
    release();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    // A failing control still receives its fixture's terminal receipt and leaves no polling task.
    await writeFile(file, JSON.stringify({ ...lease, phase: 'reaped' }));
    if (stopping.promise) await stopping.promise.catch(() => undefined);
    await quiesceManagedChildren(root);
  });
  trackMissionInvocation(root, { processTreeLease: file }, child);
  await once(child.stdout, 'data');
  gateWrite.file = file.replace('.lease', '.gate');
  gateWrite.before = async () => {
    entered();
    await held;
  };
  const stopped = quiesceManagedChildren(root);
  stopping.promise = stopped;
  await closing;
  await writeFile(file, JSON.stringify({ ...lease, phase: 'reaped' }));
  await vi.waitFor(() => expect(missionWorkspaceBusy(root)).toBe(false));
  release();
  await expect(stopped).resolves.toBeUndefined();
  expect(await readdir(sandbox.specDirectory)).toEqual([]);
});
const fixture = async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'garden-mission-process-'));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, randomUUID());
  await ensureWorkspace(root);
  const specDirectory = sandboxSpecDirectory(parent);
  await mkdir(specDirectory, { recursive: true });
  const helper = path.join(parent, 'elevate');
  await writeFile(
    helper,
    '#!/bin/sh\nprintf \'{"namespaceAlive":true,"supervisorAlive":true,"groupAlive":false}\\n\'\n'
  );
  await chmod(helper, 0o755);
  const sandbox = {
    ...agentSandbox(helper, true, specDirectory),
    elevate: helper,
    processIsolation: true,
    networkIsolation: true
  };
  return { root, parent, sandbox, file: path.join(specDirectory, '123abc.lease') };
};

it('requires measured process isolation for child missions and preserves ordinary invocation modes', async () => {
  const { root, sandbox } = await fixture();
  await writeFile(
    path.join(root, '.athanor', 'coding-parent.json'),
    JSON.stringify({ parent: randomUUID(), id: randomUUID() })
  );
  await expect(
    sandboxedInvocation(
      { executable: '/bin/sh', args: [] },
      {},
      { ...sandbox, processIsolation: false },
      true,
      root,
      path.join(root, 'workspace')
    )
  ).rejects.toThrow('measured native');
  const prepared = await sandboxedInvocation(
    { executable: '/bin/sh', args: [] },
    {},
    sandbox,
    true,
    root,
    path.join(root, 'workspace')
  );
  expect(prepared.args).toContain('mission');
  expect(prepared.processTreeLease).toBeTruthy();
  expect(await readFile(prepared.processTreeLease!.replace('.lease', '.gate'), 'utf8')).toBe('');
  expect(missionWorkspaceBusy(root)).toBe(true);
  await discardMissionInvocation(prepared);
  expect(missionWorkspaceBusy(root)).toBe(false);
});

it('preserves process leases when clearing stale command specs on startup', async () => {
  const { sandbox, file } = await fixture();
  await writeFile(file, '{"retained":true}');
  await writeFile(file.replace('.lease', '.spec'), 'command');
  await writeFile(file.replace('.lease', '.gate'), 'stop');
  await resolveAgentSandbox(sandbox.helper, sandbox.specDirectory);
  expect(await readdir(sandbox.specDirectory)).toEqual(
    expect.arrayContaining(['123abc.lease', '123abc.gate'])
  );
  expect(await readFile(file, 'utf8')).toBe('{"retained":true}');
  expect((await readdir(sandbox.specDirectory)).some((name) => name.endsWith('.spec'))).toBe(false);
});

it('retains ordinary managed descendants only with measured support, while strict commands keep their teardown lifetime', async () => {
  const { root, sandbox } = await fixture();
  const prepare = (strict: boolean, retainedProcessTrees: boolean) =>
    sandboxedInvocation(
      { executable: '/bin/sh', args: [] },
      {},
      { ...sandbox, retainedProcessTrees },
      false,
      root,
      path.join(root, 'workspace'),
      strict,
      true
    );
  await expect(prepare(false, false)).rejects.toThrow('measured native retained');
  expect(await readdir(sandbox.specDirectory)).toEqual([]);
  for (const strict of [false, true]) {
    const command = await prepare(strict, !strict);
    expect(command.processTreeLease).toBeTruthy();
    const lease = JSON.parse(await readFile(command.processTreeLease!, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(lease.purpose).toBe('session');
    expect(lease.retainDescendants).toBe(strict ? undefined : true);
    await discardMissionInvocation(command);
  }
});

it('waits past wrapper exit until the supervisor confirms namespace teardown', async () => {
  const { root, file, sandbox } = await fixture();
  await createMissionLease(root, file, sandbox);
  const child = spawn(
    process.execPath,
    ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
    { detached: true, stdio: 'pipe' }
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const record = await readFile(file, 'utf8')
      .then((text) => JSON.parse(text) as object)
      .catch(() => null);
    if (record) await writeFile(file, JSON.stringify({ ...record, phase: 'reaped' }));
    await quiesceManagedChildren(root);
  });
  trackMissionInvocation(root, { processTreeLease: file }, child);
  await once(child.stdout, 'data');
  const lease = JSON.parse(await readFile(file, 'utf8')) as object;
  const stopped = quiesceManagedChildren(root);
  let returned = false;
  void stopped.then(() => {
    returned = true;
  });
  await once(child, 'exit');
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(returned).toBe(false);
  expect(await readFile(file.replace('.lease', '.gate'), 'utf8')).toBe('stop');
  expect(missionWorkspaceBusy(root)).toBe(true);
  await writeFile(file, JSON.stringify({ ...lease, phase: 'reaped' }));
  await stopped;
  expect(managedWorkspaceBusy(root)).toBe(false);
  expect(await readdir(sandbox.specDirectory)).toEqual([]);
});

it('closes unstarted gates and refuses later preparation once the mission is frozen', async () => {
  const { root, file, sandbox } = await fixture();
  freezeMissionWorkspace(root);
  await expect(createMissionLease(root, file, sandbox)).rejects.toThrow('scope is closed');
  await expect(
    sandboxedInvocation(
      { executable: '/bin/sh', args: [] },
      {},
      sandbox,
      false,
      root,
      path.join(root, 'workspace')
    )
  ).rejects.toThrow('scope is closed');
  expect(await readdir(sandbox.specDirectory)).toEqual([]);
});

it('quiesces declared services, persists retirement and refuses new launches while preserving another workspace', async () => {
  const { root, parent } = await fixture();
  const other = path.join(parent, randomUUID());
  await ensureWorkspace(other);
  const manager = new ProcessManager();
  cleanups.push(() => manager.close());
  const request = {
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    service: 'keeper'
  };
  await manager.start(root, path.basename(root), 'task', request, 60, false);
  await manager.start(other, path.basename(other), 'task', request, 60, false);
  expect(manager.isWorkspaceBusy(path.basename(root))).toBe(true);
  await manager.quiesceWorkspace(path.basename(root));
  expect(manager.isWorkspaceBusy(path.basename(root))).toBe(false);
  expect(manager.listWorkspace(path.basename(root))).toEqual([]);
  expect(manager.isWorkspaceBusy(path.basename(other))).toBe(true);
  await expect(
    manager.start(root, path.basename(root), 'task', request, 60, false)
  ).rejects.toThrow('scope is closed');
  const registry = JSON.parse(
    await readFile(path.join(root, '.athanor', 'services.json'), 'utf8')
  ) as unknown[];
  expect(registry).toEqual([]);
});

it('never restarts durable commands inside a child mission after runner recovery', async () => {
  const { root } = await fixture();
  const manager = new ProcessManager();
  await manager.start(
    root,
    path.basename(root),
    'task',
    {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      service: 'child-server'
    },
    60,
    false
  );
  await manager.close();
  await writeFile(
    path.join(root, '.athanor', 'coding-parent.json'),
    JSON.stringify({ parent: randomUUID(), id: randomUUID() })
  );
  const recovered = new ProcessManager();
  cleanups.push(() => recovered.close());
  expect(await recovered.resumeWorkspace(root, path.basename(root), false)).toBe(0);
  expect(recovered.isWorkspaceBusy(path.basename(root))).toBe(false);
  await expect(
    recovered.start(
      root,
      path.basename(root),
      'task',
      { executable: '/bin/sh', args: [] },
      60,
      false
    )
  ).rejects.toThrow('scope is closed');
});

it('refuses quiescence success until retired declarations are durably persisted', async () => {
  const { root } = await fixture();
  const manager = new ProcessManager();
  cleanups.push(() => manager.close());
  await manager.start(
    root,
    path.basename(root),
    'task',
    {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      service: 'child-server'
    },
    60,
    false
  );
  await rm(path.join(root, '.athanor', 'services.json'));
  await mkdir(path.join(root, '.athanor', 'services.json'));
  await expect(manager.quiesceWorkspace(path.basename(root))).rejects.toThrow();
  await rm(path.join(root, '.athanor', 'services.json'), { recursive: true });
  await manager.quiesceWorkspace(path.basename(root));
  expect(JSON.parse(await readFile(path.join(root, '.athanor', 'services.json'), 'utf8'))).toEqual(
    []
  );
});

it('does not open a prepared launch gate after its workspace was frozen', async () => {
  const { root, file, sandbox } = await fixture();
  await createMissionLease(root, file, sandbox);
  const lease = JSON.parse(await readFile(file, 'utf8')) as object;
  freezeMissionWorkspace(root);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'pipe'
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const record = await readFile(file, 'utf8')
      .then((text) => JSON.parse(text) as object)
      .catch(() => null);
    if (record) await writeFile(file, JSON.stringify({ ...record, phase: 'reaped' }));
    await quiesceManagedChildren(root);
  });
  trackMissionInvocation(root, { processTreeLease: file }, child);
  expect(await readFile(file.replace('.lease', '.gate'), 'utf8')).toBe('stop');
  await writeFile(file, JSON.stringify({ ...lease, phase: 'reaped' }));
  await quiesceManagedChildren(root);
  expect(missionWorkspaceBusy(root)).toBe(false);
});

it('keeps failed teardown closed but allows a later terminal receipt to be retried', async () => {
  const { root, file, sandbox } = await fixture();
  await createMissionLease(root, file, sandbox);
  const lease = JSON.parse(await readFile(file, 'utf8')) as object;
  let elapsed = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => (elapsed += 16_000));
  try {
    await expect(quiesceManagedChildren(root)).rejects.toThrow('has not confirmed teardown');
  } finally {
    clock.mockRestore();
  }
  expect(missionWorkspaceBusy(root)).toBe(true);
  expect(await readFile(file.replace('.lease', '.gate'), 'utf8')).toBe('stop');
  await writeFile(file, JSON.stringify({ ...lease, phase: 'reaped' }));
  await quiesceManagedChildren(root);
  expect(missionWorkspaceBusy(root)).toBe(false);
  expect(await readdir(sandbox.specDirectory)).toEqual([]);
});
