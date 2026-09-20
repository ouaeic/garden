import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assertProjectReferencesIdle,
  managedWorkspaceBusy,
  missionWorkspaceBusy,
  quiesceMissionProcesses,
  recoverMissionProcesses
} from './mission-processes.js';
import { agentSandbox, sandboxSpecDirectory } from './sandbox.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'garden-mission-recovery-'));
  roots.push(parent);
  const root = path.join(parent, randomUUID()),
    directory = sandboxSpecDirectory(parent),
    file = path.join(directory, '12abcd.lease');
  await mkdir(directory, { recursive: true });
  const helper = path.join(parent, 'observer');
  await writeFile(
    helper,
    '#!/bin/sh\nprintf \'{"namespaceAlive":false,"supervisorAlive":false,"groupAlive":false}\\n\'\n'
  );
  await chmod(helper, 0o755);
  const sandbox = {
    ...agentSandbox(helper, true, directory),
    elevate: helper,
    processIsolation: true
  };
  return { root, file, directory, helper, sandbox };
};

it('protects a recorded project until native teardown and refuses unknown input lifetime evidence', async () => {
  const { root, file, helper, sandbox } = await fixture();
  const project = randomUUID(),
    other = randomUUID();
  const policy = { ...sandbox, projectInputLocks: true };
  const record = {
    workspaceRoot: root,
    purpose: 'session',
    phase: 'running',
    launchExpiresAt: Date.now() - 1000,
    namespaceInit: { pid: 100, identity: 'fixture' },
    projectInputLockProtocol: 1,
    projectInputs: [{ projectId: project, device: '1', inode: '2' }]
  };
  await writeFile(file, JSON.stringify(record));
  await writeFile(
    helper,
    '#!/bin/sh\nprintf \'{"namespaceAlive":true,"supervisorAlive":false,"groupAlive":false}\\n\'\n'
  );
  await expect(assertProjectReferencesIdle(policy, project)).rejects.toThrow('still protects');
  await expect(assertProjectReferencesIdle(policy, other)).resolves.toBeUndefined();
  await writeFile(
    helper,
    '#!/bin/sh\nprintf \'{"namespaceAlive":false,"supervisorAlive":false,"groupAlive":false}\\n\'\n'
  );
  await expect(assertProjectReferencesIdle(policy, project)).resolves.toBeUndefined();
  await writeFile(helper, '#!/bin/sh\nexit 1\n');
  await expect(assertProjectReferencesIdle(policy, project)).rejects.toThrow('probe failed');
  await expect(assertProjectReferencesIdle(policy, other)).resolves.toBeUndefined();
  await writeFile(file, JSON.stringify({ ...record, projectInputs: undefined }));
  await expect(assertProjectReferencesIdle(policy, other)).rejects.toThrow('must wait');
  await writeFile(file, '{partial');
  await expect(assertProjectReferencesIdle(policy, project)).rejects.toThrow('unreadable');
});
it('reclaims an expired unopened launch without executing or restarting its command', async () => {
  const { root, file, directory, sandbox } = await fixture();
  await writeFile(
    file,
    JSON.stringify({ workspaceRoot: root, phase: 'prepared', launchExpiresAt: Date.now() - 1000 })
  );
  expect(await recoverMissionProcesses(sandbox)).toBe(true);
  expect(missionWorkspaceBusy(root)).toBe(false);
  expect(await readdir(directory)).toEqual([]);
});
it('retains an uncertain lease if its privileged observer is unavailable', async () => {
  const { root, file, helper, sandbox } = await fixture();
  await writeFile(
    file,
    JSON.stringify({
      workspaceRoot: root,
      phase: 'running',
      launchExpiresAt: Date.now() - 1000,
      namespaceInit: { pid: 100, identity: 'canary' }
    })
  );
  await writeFile(helper, '#!/bin/sh\nexit 1\n');
  expect(await recoverMissionProcesses(sandbox)).toBe(true);
  expect(missionWorkspaceBusy(root)).toBe(true);
  expect((JSON.parse(await readFile(file, 'utf8')) as { phase: string }).phase).toBe('running');
  await writeFile(
    helper,
    '#!/bin/sh\nprintf \'{"namespaceAlive":false,"supervisorAlive":false,"groupAlive":false}\\n\'\n'
  );
  await quiesceMissionProcesses(root);
  expect(missionWorkspaceBusy(root)).toBe(false);
});
it('disables mission integration on unreadable recovery evidence without rejecting runner startup', async () => {
  const { root, file, sandbox } = await fixture();
  await writeFile(file, '{partial');
  expect(await recoverMissionProcesses(sandbox)).toBe(false);
  expect(managedWorkspaceBusy(root)).toBe(true);
  await expect(quiesceMissionProcesses(root)).rejects.toThrow('unreadable mission');
  expect(await readFile(file, 'utf8')).toBe('{partial');
});
