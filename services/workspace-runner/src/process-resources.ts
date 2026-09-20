import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProcessResourceSample } from '@athanor/contracts';
import { z } from 'zod';
import { sandboxedShell, type AgentSandbox } from './sandbox.js';

export const PROCESS_SAMPLE_MS = 120_000;
const execute = promisify(execFile);

export interface ProcessStat {
  pid: number;
  parent: number;
  group: number;
  session: number;
  name: string;
  state: string;
  ticks: number;
  started: number;
  residentPages: number;
  threads: number;
  namespace?: string;
}

/** Field offsets follow proc_pid_stat(5); the parenthesized name may itself contain parentheses. */
export const parseProcessStat = (line: string): ProcessStat | null => {
  const open = line.indexOf('('),
    close = line.lastIndexOf(')');
  if (open < 1 || close <= open) return null;
  const columns = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (columns.length < 22) return null;
  const value = {
    pid: Number(line.slice(0, open).trim()),
    parent: Number(columns[1]),
    group: Number(columns[2]),
    session: Number(columns[3]),
    name: line.slice(open + 1, close),
    state: columns[0]!,
    // Reaped children move into their parent's counters, preserving completed batch work.
    ticks: [11, 12, 13, 14].reduce((sum, index) => sum + Number(columns[index]), 0),
    started: Number(columns[19]),
    residentPages: Number(columns[21]),
    threads: Number(columns[17])
  };
  return Object.values(value).every(
    (item) => typeof item !== 'number' || (Number.isSafeInteger(item) && item >= 0)
  ) &&
    value.pid > 0 &&
    /^[A-Za-z]$/.test(value.state)
    ? value
    : null;
};

export interface ProcessScan {
  at: number;
  ticksPerSecond: number;
  pageBytes: number;
  processes: ProcessStat[];
  uptimeSeconds?: number;
  accountScoped?: boolean;
}

// Fixed observer code runs as the existing unprivileged analysis account. It reads only that
// account's kernel counters; sudoers, ProtectProc and workspace confinement are unchanged.
export const ACCOUNT_PROCESS_SCAN = `
import json, os, pathlib, time
root = pathlib.Path("/proc")
uid = os.geteuid()
if uid == 0:
    raise RuntimeError("Process observer requires an unprivileged account")
stats = []
namespaces = {}
for entry in root.iterdir():
    if not entry.name.isdigit():
        continue
    try:
        if entry.stat().st_uid == uid:
            stats.append((entry / "stat").read_text())
            try:
                namespaces[entry.name] = str((entry / "ns/pid").stat().st_ino)
            except OSError:
                pass
    except (OSError, UnicodeError):
        continue
print(json.dumps({"at": int(time.time() * 1000), "uid": uid,
    "ticksPerSecond": os.sysconf("SC_CLK_TCK"), "pageBytes": os.sysconf("SC_PAGE_SIZE"),
    "uptimeSeconds": float((root / "uptime").read_text().split()[0]), "stats": stats, "namespaces": namespaces}))
`;

const KernelScan = z.object({
  at: z.number().finite().nonnegative(),
  uid: z.number().int().positive(),
  ticksPerSecond: z.number().int().positive(),
  pageBytes: z.number().int().positive(),
  uptimeSeconds: z.number().finite().nonnegative(),
  stats: z.array(z.string()),
  namespaces: z.record(z.string(), z.string().regex(/^\d+$/)).default({})
});

export const parseAccountScan = (value: unknown): ProcessScan => {
  const { stats, namespaces, uid: _uid, ...scan } = KernelScan.parse(value);
  return {
    ...scan,
    accountScoped: true,
    processes: stats
      .map(parseProcessStat)
      .filter((item): item is ProcessStat => item !== null)
      .map((item) => ({
        ...item,
        ...(namespaces[String(item.pid)] ? { namespace: namespaces[String(item.pid)] } : {})
      }))
  };
};

/** Read only kernel accounting metadata. No command arguments, environment or workspace contents. */
export const processScanner = (
  root = '/proc',
  sandbox?: AgentSandbox
): (() => Promise<ProcessScan | null>) => {
  let units: Promise<[number, number]> | undefined;
  return async () => {
    try {
      if (sandbox) {
        const command = sandboxedShell(
          { executable: '/usr/bin/python3', args: ['-I', '-S', '-c', ACCOUNT_PROCESS_SCAN] },
          {},
          sandbox
        );
        const { stdout } = await execute(command.executable, command.args, {
          timeout: 5_000,
          maxBuffer: 16 * 1024 * 1024,
          cwd: '/'
        });
        return parseAccountScan(JSON.parse(stdout));
      }
      const entries = await readdir(root);
      units ??= Promise.all(
        ['CLK_TCK', 'PAGESIZE'].map(async (name) => {
          const { stdout } = await execute('/usr/bin/getconf', [name], {
            timeout: 2_000,
            maxBuffer: 1024
          });
          const value = Number(stdout.trim());
          if (!Number.isSafeInteger(value) || value <= 0)
            throw new Error('Kernel accounting units unavailable');
          return value;
        })
      ) as Promise<[number, number]>;
      const [ticksPerSecond, pageBytes] = await units;
      const uptimeSeconds = Number(
        (await readFile(path.join(root, 'uptime'), 'utf8')).split(/\s+/)[0]
      );
      if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return null;
      const processes: ProcessStat[] = [];
      const pids = entries.filter((entry) => /^\d+$/.test(entry));
      // Bound concurrent file descriptors even on a machine running thousands of workers.
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(16, pids.length) }, async () => {
          while (next < pids.length) {
            const pid = pids[next++]!;
            try {
              const stat = parseProcessStat(await readFile(path.join(root, pid, 'stat'), 'utf8'));
              if (stat && stat.pid === Number(pid)) processes.push(stat);
            } catch {
              /* A process can exit during the scan or be hidden by the host. */
            }
          }
        })
      );
      return { at: Date.now(), ticksPerSecond, pageBytes, processes, uptimeSeconds };
    } catch {
      return null;
    }
  };
};

interface Target {
  id: string;
  pid: number;
  generation: string;
  namespace?: () => Promise<{ id: string; stat: string } | null>;
}
interface Previous {
  generation: string;
  pid: number;
  started: number | null;
  at: number;
  ticks: number;
  namespace?: string;
}

export class ProcessResources {
  readonly #samples = new Map<string, ProcessResourceSample>();
  readonly #previous = new Map<string, Previous>();
  readonly #states = new Map<string, 'pending' | 'available' | 'unavailable'>();
  #nextAt = 0;
  #pending: Promise<void> | undefined;
  available = false;
  constructor(
    private readonly scan = processScanner(),
    private readonly now = Date.now
  ) {}

  sample(id: string): ProcessResourceSample | undefined {
    return this.#samples.get(id);
  }

  state(id: string): 'pending' | 'available' | 'unavailable' {
    return this.#states.get(id) ?? 'pending';
  }

  async refresh(targets: Target[]): Promise<void> {
    if (this.#pending) return this.#pending;
    if (this.now() < this.#nextAt) return;
    this.#nextAt = this.now() + PROCESS_SAMPLE_MS;
    this.#pending = this.#refresh(targets).finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #refresh(targets: Target[]): Promise<void> {
    const ids = new Set(targets.map((target) => target.id));
    for (const id of this.#previous.keys()) if (!ids.has(id)) this.#previous.delete(id);
    for (const id of this.#samples.keys()) if (!ids.has(id)) this.#samples.delete(id);
    for (const id of this.#states.keys()) if (!ids.has(id)) this.#states.delete(id);
    if (!targets.length) return;
    for (const target of targets) this.#states.set(target.id, 'unavailable');
    const namespaces = new Map<string, { id: string; stat: string } | null>();
    const pending = targets.filter((target) => target.namespace);
    let next = 0;
    // Native status uses a privileged read-only probe; bound concurrent observer processes.
    await Promise.all(
      Array.from({ length: Math.min(8, pending.length) }, async () => {
        while (next < pending.length) {
          const target = pending[next++]!;
          namespaces.set(target.id, await target.namespace!().catch(() => null));
        }
      })
    );
    const observation = await this.scan().catch(() => null);
    this.available = observation !== null;
    if (!observation) return;
    const byPid = new Map(observation.processes.map((item) => [item.pid, item]));
    const parents = new Map<number, ProcessStat[]>();
    for (const item of observation.processes) {
      const children = parents.get(item.parent) ?? [];
      children.push(item);
      parents.set(item.parent, children);
    }
    for (const target of targets) {
      const namespace = namespaces.get(target.id);
      const root = target.namespace
        ? namespace
          ? parseProcessStat(namespace.stat)
          : null
        : byPid.get(target.pid);
      if (target.namespace && (!namespace || !root)) continue;
      const accountMembers = observation.accountScoped
        ? observation.processes.filter(
            (item) => item.group === target.pid || item.session === target.pid
          )
        : [];
      if (
        !namespace &&
        (root ? root.group !== target.pid || root.session !== target.pid : !accountMembers.length)
      )
        continue;
      const prior = this.#previous.get(target.id);
      const before = prior?.generation === target.generation ? prior : undefined;
      if (
        before &&
        (before.pid !== target.pid ||
          (root && before.started !== null && before.started !== root.started) ||
          before.namespace !== namespace?.id)
      ) {
        this.#samples.delete(target.id);
        continue;
      }
      const members = new Map<number, ProcessStat>();
      // A hidden sudo wrapper is still held by the live ChildProcess supplied by ProcessManager.
      // Its group cannot be reused while that process exists; count the visible analysis members.
      const queue = namespace
        ? observation.processes.filter(
            (item) => item.namespace === namespace.id && item.pid !== root!.pid
          )
        : root
          ? observation.processes.filter((item) => item.session === root.session)
          : accountMembers;
      // Include children that create a new session while their parent is still present.
      for (let index = 0; index < queue.length; index++) {
        const item = queue[index]!;
        if (members.has(item.pid)) continue;
        members.set(item.pid, item);
        if (!namespace) queue.push(...(parents.get(item.pid) ?? []));
      }
      const ticks = [...members.values()].reduce(
        (sum, item) => sum + item.ticks,
        namespace ? root!.ticks : 0
      );
      const interval = before ? observation.at - before.at : 0;
      const cpu =
        before && interval > 0 && ticks >= before.ticks
          ? ((ticks - before.ticks) / observation.ticksPerSecond / (interval / 1000)) * 100
          : null;
      const children = [...members.values()]
        .sort((a, b) => a.pid - b.pid)
        .map((item) => ({
          pid: item.pid,
          name: item.name,
          state: item.state,
          residentBytes: item.residentPages * observation.pageBytes,
          threads: item.threads,
          ...(observation.uptimeSeconds === undefined
            ? {}
            : {
                ranForMs: Math.max(
                  0,
                  (observation.uptimeSeconds - item.started / observation.ticksPerSecond) * 1000
                )
              })
        }));
      this.#states.set(target.id, 'available');
      this.#samples.set(target.id, {
        sampledAt: new Date(observation.at).toISOString(),
        intervalMs: interval > 0 ? interval : null,
        cpuPercent: cpu,
        residentBytes: children.reduce((sum, item) => sum + item.residentBytes, 0),
        processCount: children.length,
        threadCount: children.reduce((sum, item) => sum + item.threads, 0),
        children
      });
      this.#previous.set(target.id, {
        generation: target.generation,
        pid: target.pid,
        started: root?.started ?? before?.started ?? null,
        at: observation.at,
        ticks,
        ...(namespace ? { namespace: namespace.id } : {})
      });
    }
  }
}
