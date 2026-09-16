import type { ProcessHandle } from './subprocess.js';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSandbox } from './sandbox.js';
import { killProcessTree } from './subprocess.js';

interface Identity {
  pid: number;
  identity: string;
}
interface Lease {
  purpose?: 'mission' | 'session';
  controller?: Identity;
  workspaceRoot: string;
  launchExpiresAt: number;
  phase: 'prepared' | 'supervising' | 'running' | 'reaped';
  namespaceInit?: Identity;
  supervisor?: Identity;
  group?: Identity;
}
interface Entry {
  purpose: 'mission' | 'session';
  root: string;
  file: string;
  sandbox: AgentSandbox;
  child?: ProcessHandle;
  ended?: Promise<void>;
  settlement?: Promise<void>;
}
const entries = new Map<string, Entry>();
const frozen = new Set<string>();
let unknownLease = false;
const children = new Map<ProcessHandle, { root: string; ended: Promise<void> }>();
const gatePath = (file: string) => file.replace(/\.lease$/, '.gate');
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const assertMissionWorkspaceOpen = (root: string): void => {
  if (frozen.has(root)) throw new Error('The coding mission execution scope is closed');
};
export const freezeMissionWorkspace = (root: string): void => {
  frozen.add(root);
};
export const missionWorkspaceBusy = (root: string): boolean =>
  [...entries.values()].some((entry) => entry.root === root);

const processIdentity = async (pid: number): Promise<string | undefined> => {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
};

export const createMissionLease = async (
  root: string,
  file: string,
  sandbox: AgentSandbox,
  purpose: 'mission' | 'session' = 'mission'
): Promise<void> => {
  assertMissionWorkspaceOpen(root);
  const entry = { root, file, sandbox, purpose };
  entries.set(file, entry);
  try {
    const identity = await processIdentity(process.pid);
    await writeFile(
      file,
      JSON.stringify({
        workspaceRoot: root,
        purpose,
        ...(identity ? { controller: { pid: process.pid, identity } } : {}),
        phase: 'prepared',
        launchExpiresAt: Date.now() + 10_000
      } satisfies Lease),
      { mode: 0o600, flag: 'wx' }
    );
    await writeFile(gatePath(file), '', { mode: 0o600, flag: 'wx' });
    assertMissionWorkspaceOpen(root);
  } catch (error) {
    await discardMissionInvocation({ processTreeLease: file });
    throw error;
  }
};

/** Closing an unlaunched gate cannot authorize a command, even if its helper starts late. */
export const discardMissionInvocation = async (prepared: {
  processTreeLease?: string;
}): Promise<void> => {
  if (!prepared.processTreeLease) return;
  const entry = entries.get(prepared.processTreeLease);
  if (entry?.child) throw new Error('A launched mission must prove namespace teardown');
  await writeFile(gatePath(prepared.processTreeLease), 'stop', { mode: 0o600 });
  entries.delete(prepared.processTreeLease);
  await Promise.all([
    rm(prepared.processTreeLease, { force: true }),
    rm(gatePath(prepared.processTreeLease), { force: true }),
    rm(prepared.processTreeLease.replace(/\.lease$/, '.spec'), { force: true })
  ]);
};

export const trackMissionInvocation = (
  root: string,
  prepared: { processTreeLease?: string },
  child: ProcessHandle
): void => {
  const ended = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  children.set(child, { root, ended });
  void ended.then(() => children.delete(child));
  if (!prepared.processTreeLease) {
    if (frozen.has(root)) killProcessTree(child, 'SIGKILL');
    return;
  }
  const entry = entries.get(prepared.processTreeLease);
  if (!entry) {
    killProcessTree(child, 'SIGKILL');
    throw new Error('Missing mission process lease');
  }
  entry.child = child;
  entry.ended = ended;
  void entry.ended.then(() => settle(entry)).catch(() => undefined);
  try {
    if (frozen.has(entry.root)) {
      writeFileSync(gatePath(entry.file), 'stop');
      killProcessTree(child, 'SIGTERM');
    } else writeFileSync(gatePath(entry.file), 'go');
  } catch (error) {
    killProcessTree(child, 'SIGKILL');
    throw error;
  }
};

const readLease = async (file: string): Promise<Lease> => {
  const raw = await readFile(file, 'utf8');
  if (raw.length > 8192) throw new Error('Mission lease exceeds its storage bound');
  const record = JSON.parse(raw) as Lease;
  if (
    (record.purpose !== undefined && !['mission', 'session'].includes(record.purpose)) ||
    !path.isAbsolute(record.workspaceRoot) ||
    !Number.isFinite(record.launchExpiresAt) ||
    !['prepared', 'supervising', 'running', 'reaped'].includes(record.phase)
  )
    throw new Error('Invalid mission process lease');
  return record;
};
const nativeStatus = (
  entry: Entry
): Promise<{ namespaceAlive: boolean; supervisorAlive: boolean; groupAlive: boolean }> =>
  new Promise((resolve, reject) => {
    execFile(
      entry.sandbox.elevate,
      ['-n', entry.sandbox.helper, 'mission-status', entry.file],
      { timeout: 3000, maxBuffer: 8192 },
      (error, output) => {
        if (error) {
          reject(new Error('Native mission status probe failed', { cause: error }));
          return;
        }
        try {
          const value = JSON.parse(output) as Record<string, unknown>;
          if (
            ['namespaceAlive', 'supervisorAlive', 'groupAlive'].some(
              (key) => typeof value[key] !== 'boolean'
            )
          )
            throw new Error('Invalid native mission status');
          resolve(
            value as { namespaceAlive: boolean; supervisorAlive: boolean; groupAlive: boolean }
          );
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error('Invalid native mission status'));
        }
      }
    );
  });
const forget = async (entry: Entry): Promise<void> => {
  await Promise.all([
    rm(entry.file, { force: true }),
    rm(gatePath(entry.file), { force: true }),
    rm(entry.file.replace(/\.lease$/, '.spec'), { force: true })
  ]);
  entries.delete(entry.file);
};
const settle = (entry: Entry): Promise<void> => {
  const previous = entry.settlement;
  if (previous) return previous;
  const result = (async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const record = await readLease(entry.file);
        if (record.phase === 'reaped') {
          await forget(entry);
          return;
        }
        const status = await nativeStatus(entry);
        // Only the privileged observer can see root namespace init under ProtectProc.
        if (
          !status.namespaceAlive &&
          !status.supervisorAlive &&
          (record.namespaceInit || Date.now() >= record.launchExpiresAt)
        ) {
          await forget(entry);
          return;
        }
      } catch {
        /* A partial fsynced update or unavailable observer is not a teardown proof. */
      }
      await pause(100);
    }
    throw new Error(
      'The coding mission namespace has not confirmed teardown; integration remains closed'
    );
  })();
  // A caller can retain this entry across the final unlink. Its confirmed result remains valid
  // after removal from the registry; only failed observations need a fresh attempt.
  entry.settlement = result;
  void result.catch(() => {
    if (entry.settlement === result) delete entry.settlement;
  });
  return result;
};

const closeExistingGate = async (entry: Entry): Promise<void> => {
  try {
    await writeFile(gatePath(entry.file), 'stop', { mode: 0o600, flag: 'r+' });
  } catch (error) {
    // Concurrent verified settlement can remove the gate while a stop is pending. Never recreate
    // it; the caller must still join settlement rather than treating absence as teardown proof.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

export const recoverMissionProcesses = async (sandbox: AgentSandbox): Promise<boolean> => {
  for (const name of await readdir(sandbox.specDirectory)) {
    if (!/^[a-f0-9]+\.lease$/.test(name)) continue;
    const file = path.join(sandbox.specDirectory, name);
    let record: Lease;
    try {
      record = await readLease(file);
      if (path.dirname(record.workspaceRoot) !== path.dirname(path.dirname(sandbox.specDirectory)))
        throw new Error('Mission lease points outside the workspace root');
    } catch {
      unknownLease = true;
      continue;
    }
    // A different live supervisor owns its own leases. Restarting the runner cannot reap its jobs.
    if (
      record.controller &&
      record.controller.pid !== process.pid &&
      (await processIdentity(record.controller.pid)) === record.controller.identity
    )
      continue;
    const root = record.workspaceRoot;
    entries.set(file, { root, file, sandbox, purpose: record.purpose ?? 'mission' });
    frozen.add(root);
  }
  const sessionOnly = new Set(
    [...entries.values()]
      .filter(
        (entry) =>
          entry.purpose === 'session' &&
          ![...entries.values()].some(
            (other) => other.root === entry.root && other.purpose === 'mission'
          )
      )
      .map((entry) => entry.root)
  );
  await Promise.all(
    [
      ...new Set(
        [...entries.values()]
          .filter((entry) => entry.sandbox === sandbox)
          .map((entry) => entry.root)
      )
    ].map(async (root) => {
      try {
        await quiesceMissionProcesses(root);
        if (sessionOnly.has(root)) frozen.delete(root);
      } catch {
        /* Unverified recovery remains closed. */
      }
    })
  );
  return !unknownLease;
};

/** Stops only one registered finite invocation, retaining unrelated workspace authority. */
export const stopSupervisedInvocation = async (prepared: {
  processTreeLease?: string;
}): Promise<void> => {
  if (!prepared.processTreeLease) return;
  const entry = entries.get(prepared.processTreeLease);
  if (!entry) {
    try {
      await readFile(prepared.processTreeLease);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new Error('Unregistered process lease prevents verified teardown');
  }
  await closeExistingGate(entry);
  if (entry.child) killProcessTree(entry.child, 'SIGTERM');
  await settle(entry);
};

export const quiesceMissionProcesses = async (root: string): Promise<void> => {
  freezeMissionWorkspace(root);
  if (unknownLease)
    throw new Error('An unreadable mission process lease prevents verified integration');
  const owned = [...entries.values()].filter((entry) => entry.root === root);
  for (const entry of owned) {
    await closeExistingGate(entry);
    if (entry.child) killProcessTree(entry.child, 'SIGTERM');
    else if (!entry.settlement) {
      const record = await readLease(entry.file);
      const status = await nativeStatus(entry);
      if (status.groupAlive && record.group) {
        try {
          process.kill(-record.group.pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
  }
  await Promise.all(owned.map((entry) => settle(entry)));
};

export const managedWorkspaceBusy = (root: string): boolean =>
  unknownLease ||
  [...children.values()].some((entry) => entry.root === root) ||
  missionWorkspaceBusy(root);

export const quiesceManagedChildren = async (root: string): Promise<void> => {
  freezeMissionWorkspace(root);
  const owned = [...children].filter(([, entry]) => entry.root === root);
  for (const [child] of owned) killProcessTree(child, 'SIGTERM');
  const force = setTimeout(() => {
    for (const [child] of owned) if (children.has(child)) killProcessTree(child, 'SIGKILL');
  }, 1000);
  try {
    await Promise.all(owned.map(([, entry]) => entry.ended));
    await quiesceMissionProcesses(root);
  } finally {
    clearTimeout(force);
  }
};
