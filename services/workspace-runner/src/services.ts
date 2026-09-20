import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { TerminalHistory } from './terminal-history.js';
import { ProcessResourceSampleSchema } from '@athanor/contracts';
import { failureCode, runnerLogger } from './log.js';

/**
 * A service is one background process the owner's computer keeps running.
 *
 * Everything else the runner starts is scoped to a turn: a foreground command ends when the agent
 * reads its result, and a background session was capped at an hour and lived in a `Map`, so
 * "build me a dashboard and give me a link" produced a link that stopped answering by dinner while
 * the Running row still listed it as alive. This is the one primitive that fixes that, and it is
 * deliberately only that: a thing the agent started that should still be there tomorrow. No units,
 * no dependencies, no ordering, no second daemon - the runner is already the long-lived process on
 * this box, so it is the supervisor.
 */

/** Nothing about a service is per-workspace tunable, so the ceiling lives here rather than in config. */
export const SERVICE_LIMIT_PER_WORKSPACE = 16;
export const JOB_HISTORY_LIMIT = 64;
export const JOB_LOG_BYTES = 128 * 1024;
export const JOB_CHECKPOINT_MS = 5_000;

export interface ServicePolicy {
  /** The first wait after a death; each further consecutive death doubles it. */
  readonly baseDelayMs: number;
  /** The wait stops doubling here, so a service that is down comes back within half a minute. */
  readonly ceilingDelayMs: number;
  /** A run that lasted at least this long counts as having worked, and clears the failure streak. */
  readonly healthyAfterMs: number;
  /** Consecutive too-short runs before supervision gives up. A crash loop is not a service. */
  readonly maxRapidFailures: number;
}

/**
 * Defaulted, because these are properties of the rule rather than knobs an operator tunes. They are
 * a parameter only so a test can assert the backoff and the give-up against deadlines it owns -
 * five failures at the shipped delays take a minute of wall clock, which is not a test.
 */
export const DEFAULT_SERVICE_POLICY: ServicePolicy = {
  baseDelayMs: 1_000,
  ceilingDelayMs: 30_000,
  healthyAfterMs: 10_000,
  maxRapidFailures: 5
};

/** 1s, 2s, 4s, 8s, 16s, then 30s forever. Doubling from the first failure, not the zeroth. */
export const restartDelayMs = (
  consecutiveFailures: number,
  policy: ServicePolicy = DEFAULT_SERVICE_POLICY
): number =>
  Math.min(
    policy.ceilingDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, Math.min(30, consecutiveFailures - 1))
  );

/** A process that dies immediately and repeatedly is misconfigured; restarting it forever is noise. */
export const givenUp = (
  consecutiveFailures: number,
  policy: ServicePolicy = DEFAULT_SERVICE_POLICY
): boolean => consecutiveFailures >= policy.maxRapidFailures;

/**
 * The streak counts *rapid* deaths only. A service that ran all afternoon and then fell over starts
 * its next streak at one, so it gets the full five attempts again rather than inheriting a count
 * from a bad patch last week.
 */
export const nextFailureCount = (
  ranForMs: number,
  consecutiveFailures: number,
  policy: ServicePolicy = DEFAULT_SERVICE_POLICY
): number => (ranForMs >= policy.healthyAfterMs ? 1 : consecutiveFailures + 1);

export const ServiceLaunchSchema = z.object({
  pty: z.boolean().optional(),
  executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(100_000)).max(8_192).default([]),
  cwd: z.string().default('workspace'),
  env: z.record(z.string(), z.string()).default({}),
  network: z.boolean().default(false),
  maxOutputBytes: z
    .number()
    .int()
    .min(4_096)
    .max(20 * 1024 * 1024)
    .default(1024 * 1024)
});

export type ServiceLaunch = z.infer<typeof ServiceLaunchSchema>;

const ServiceExitSchema = z.object({
  at: z.string(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  reason: z.string().max(200)
});

/**
 * `running` means a process is up. `restarting` means it died and the backoff is counting.
 * `crash_looped` means supervision gave up and is telling the owner so. A `stopped` declaration
 * is terminal and is archived before removal; it must never restart during recovery.
 */
export const ServiceRecordSchema = z.object({
  id: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  owner: z.string().min(1).max(256),
  name: z.string().min(1).max(120),
  kind: z.enum(['service', 'job']).default('service'),
  launch: ServiceLaunchSchema,
  checkpointResume: ServiceLaunchSchema.optional(),
  deadlineAt: z.string().optional(),
  resources: ProcessResourceSampleSchema.optional(),
  output: z
    .object({
      stdout: z.string().max(JOB_LOG_BYTES * 2),
      stderr: z.string().max(JOB_LOG_BYTES * 2),
      bytes: z.number().nonnegative(),
      savedAt: z.string()
    })
    .optional(),
  createdAt: z.string(),
  startedAt: z.string(),
  restarts: z.number().int().min(0).default(0),
  consecutiveFailures: z.number().int().min(0).default(0),
  state: z
    .enum([
      'running',
      'restarting',
      'crash_looped',
      'completed',
      'failed',
      'timed_out',
      'stopped',
      'interrupted'
    ])
    .default('running'),
  /*
   * The process group leader of the current run. Written down because `Restart=always` on the
   * runner unit means a runner that is killed rather than asked to stop leaves every detached child
   * reparented to init - and a resumed runner that started a second copy would put two servers on
   * one port. Read with `startedAt`, which is what says the pid still means what it meant: see
   * `reclaimOrphan`.
   */
  pid: z.number().int().positive().optional(),
  lastExit: ServiceExitSchema.optional()
});

export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;
export const ProcessHistoryRecordSchema = ServiceRecordSchema.extend({
  kind: z.enum(['service', 'job', 'task'])
});
export type ProcessHistoryRecord = z.infer<typeof ProcessHistoryRecordSchema>;

export const newServiceRecord = (input: {
  workspaceId: string;
  owner: string;
  name: string;
  launch: ServiceLaunch;
  kind?: 'service' | 'job';
  checkpointResume?: ServiceLaunch;
  deadlineAt?: string;
  at?: string;
}): ServiceRecord => {
  const at = input.at ?? new Date().toISOString();
  return {
    id: `${input.kind === 'job' ? 'job' : 'svc'}_${randomUUID()}`,
    workspaceId: input.workspaceId,
    owner: input.owner,
    name: input.name,
    kind: input.kind ?? 'service',
    launch: input.launch,
    ...(input.checkpointResume ? { checkpointResume: input.checkpointResume } : {}),
    ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
    createdAt: at,
    startedAt: at,
    restarts: 0,
    consecutiveFailures: 0,
    state: 'running'
  };
};

/** What it is, its command, when it started, how often it has come back, and how it last ended. */
export const serviceView = (record: ProcessHistoryRecord) => ({
  serviceId: record.id,
  name: record.name,
  state: record.state,
  command: [record.launch.executable, ...record.launch.args],
  createdAt: record.createdAt,
  startedAt: record.startedAt,
  restarts: record.restarts,
  ...(record.lastExit ? { lastExit: record.lastExit } : {})
});

/**
 * The durable half. One small JSON file per workspace, inside `.athanor`, which `ensureWorkspace`
 * already creates at a mode the agent cannot traverse - which matters, because the record carries
 * the environment the service was started with. It sits deliberately outside what a rewind covers:
 * `CHECKPOINT_CONTENT` and the snapshot archive are `workspace` plus `.athanor/artifacts` and the
 * browser profile, so restoring yesterday's files does not silently un-declare today's service.
 * Deleting the workspace removes the tree and takes this with it.
 */
export class ServiceRegistry {
  readonly #file: string;
  readonly history: TerminalHistory<ProcessHistoryRecord>;
  readonly #records = new Map<string, ServiceRecord>();
  #writes: Promise<void> = Promise.resolve();
  #revision = 0;
  #writtenRevision = 0;

  constructor(workspaceRoot: string) {
    this.#file = path.join(workspaceRoot, '.athanor', 'services.json');
    this.history = new TerminalHistory(
      path.join(workspaceRoot, '.athanor', 'process-history'),
      ProcessHistoryRecordSchema,
      32 * 1024 * 1024
    );
  }

  /**
   * Reads the file back, and treats anything it cannot understand as no services at all rather
   * than as a reason to fail. This runs during boot on a single-owner box: a truncated write or a
   * hand-edit must cost the owner their services, not their computer.
   */
  async load(): Promise<ServiceRecord[]> {
    await this.#writes;
    let contents: string;
    try {
      contents = await readFile(this.#file, 'utf8');
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return [];
    }
    const records = z.array(ServiceRecordSchema).safeParse(parsed);
    if (!records.success) return [];
    this.#records.clear();
    for (const record of records.data) this.#records.set(record.id, record);
    return [...this.#records.values()];
  }

  list(): ServiceRecord[] {
    return [...this.#records.values()];
  }

  async put(record: ServiceRecord, strict = false): Promise<void> {
    const previous = this.#records.get(record.id);
    this.#records.set(record.id, structuredClone(record));
    try {
      await this.#flush(strict);
    } catch (cause) {
      if (previous) this.#records.set(record.id, previous);
      else this.#records.delete(record.id);
      throw cause;
    }
  }

  flush(strict = false): Promise<void> {
    return strict ? this.#flush(true) : this.#writes;
  }

  async remove(id: string, strict = false): Promise<void> {
    const previous = this.#records.get(id);
    if (!this.#records.delete(id)) return;
    try {
      await this.#flush(strict);
    } catch (cause) {
      if (previous) this.#records.set(id, previous);
      throw cause;
    }
  }

  async archive(record: ServiceRecord): Promise<void> {
    if (['running', 'restarting', 'interrupted', 'crash_looped'].includes(record.state))
      throw Error('Only terminal processes can enter saved history');
    await this.history.put(record.id, record.owner, record);
    await this.remove(record.id, true);
  }

  /**
   * Serialised and coalesced: concurrent updates cannot publish an older snapshot over a newer
   * one. Only live declarations and bounded recent receipts stay in this journal.
   */
  #flush(strict = false): Promise<void> {
    const requested = ++this.#revision;
    const write = this.#writes.then(async () => {
      if (this.#writtenRevision >= requested) return;
      const revision = this.#revision;
      await this.#write(JSON.stringify([...this.#records.values()], null, 2));
      this.#writtenRevision = revision;
    });
    this.#writes = write.catch(() => undefined);
    return strict ? write : write.catch(() => undefined);
  }

  async #write(contents: string): Promise<void> {
    const staging = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      // 0600 and a rename: the record holds the service's environment, and a half-written file
      // read at the next boot is the one failure that would lose every service on the box at once.
      await writeFile(staging, contents, { mode: 0o600, flush: true });
      await rename(staging, this.#file);
    } catch (cause) {
      await unlink(staging).catch(() => undefined);
      // Which workspace, because the prose this replaced named the file by its absolute path and
      // that path was the only thing saying whose services had just stopped being durable. Read off
      // the records rather than held on the registry: every one of them belongs to this workspace,
      // and a flush that emptied the set has no workspace left to name.
      runnerLogger.warn('services.record_write_failed', {
        workspaceId: [...this.#records.values()][0]?.workspaceId,
        code: failureCode(cause)
      });
      throw cause;
    }
  }
}

/**
 * Which workspaces exist on this box, so a boot can ask each of them what it was running. The
 * runner is told a workspace root and nothing else; `.athanor-snapshots`, `.athanor-checkpoints`
 * and restore staging all live beside the workspaces, hence the dot filter.
 */
export const workspaceDirectories = async (workspaceRoot: string): Promise<string[]> => {
  try {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
};

export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * When this host last booted, from its own uptime.
 *
 * Both halves are read off the clock as it is now, so a clock that has been stepped moves the boot
 * and the present together and the difference between them stays the machine's own elapsed time.
 */
export const hostBootedAt = (): number => Date.now() - uptime() * 1_000;

export type Reclaim = 'gone' | 'killed' | 'foreign';

/**
 * What to do about the process the last runner left behind.
 *
 * A runner that is asked to stop kills its services on the way out, so the usual answer is `gone`.
 * A runner that was killed - OOM, a segfault, `Restart=always` doing its job - did not, and the
 * service is still up with nobody holding its pipes. It cannot be adopted: the log and the exit are
 * read through the child handle, which died with the process that spawned it. So it is stopped and
 * started again, which is the only way the record and the machine agree.
 *
 * The pid alone is not an identity, and the question this has to answer is which of the two ways a
 * runner can come back it is looking at. Against a host reboot every recorded pid has been handed
 * out again from one, and some of them now belong to the box's own system services; signalling one
 * of those process groups on the strength of a stale number is the worst thing this file could do.
 * Against a runner crash, the pid is either dead or still our own child.
 *
 * So the record is compared with the host's boot rather than with the process. A run that began
 * before this boot cannot still be running, whatever holds its number now, and is left strictly
 * alone; a run that began after it is ours, because within one boot Linux hands pids out in
 * ascending order to `pid_max` before reusing any, and `Restart=always` brings the runner back in
 * seconds rather than in the four million forks that would take.
 *
 * This deliberately does not look at the process's command line, which is what it used to do. A
 * command line is not durable: `sh -c 'sleep 30'` execs the inner command and answers `ps` with
 * `sleep 30`, and every wrapper in the chain this runner builds - prlimit, the sudo helper - execs
 * in place too. Measured on the shipped path, a service declared as `/bin/sh -c ...` was
 * unrecognisable within milliseconds of starting, so its own runner read it as a stranger, left it
 * holding the port and started a second copy beside it - which is precisely the failure the pid is
 * written down to prevent.
 */
export const reclaimOrphan = async (
  record: ServiceRecord,
  probes: {
    alive?: (pid: number) => boolean;
    bootedAt?: () => number;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    settleMs?: number;
  } = {}
): Promise<Reclaim> => {
  const pid = record.pid;
  if (pid === undefined) return 'gone';
  const alive = probes.alive ?? processAlive;
  if (!alive(pid)) return 'gone';
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt) || startedAt < (probes.bootedAt ?? hostBootedAt)())
    return 'foreign';
  const kill = probes.kill ?? signalGroup;
  const settleMs = probes.settleMs ?? 2_000;
  kill(pid, 'SIGTERM');
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise((resolve) => {
      const wait = setTimeout(resolve, 50);
      wait.unref();
    });
  }
  if (alive(pid)) kill(pid, 'SIGKILL');
  return 'killed';
};
