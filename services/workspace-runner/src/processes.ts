import { jobIdentity } from './job-identity.js';
import { discardMissionInvocation, trackMissionInvocation } from './mission-processes.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { scheduleDeadline } from './deadline.js';
import { ProcessResources, processScanner, PROCESS_SAMPLE_MS } from './process-resources.js';
import path from 'node:path';
import { z } from 'zod';
import {
  boundedCollector,
  DISK_FLOOR_POLL_MS,
  HOST_DISK_FLOOR_NOTE,
  prepareInvocation,
  refuseUnreachableTimeout,
  stopProcessTree,
  timedOutNote,
  unclaimedStopNote,
  type ExecutionGuards
} from './execution.js';
import { ensureWorkspace } from './files.js';
import { belowHostStorageFloor, hostStorage as probeHostStorage } from './host-storage.js';
import { isCodingMissionWorkspace, type AgentSandbox } from './sandbox.js';
import {
  DEFAULT_SERVICE_POLICY,
  givenUp,
  newServiceRecord,
  nextFailureCount,
  reclaimOrphan,
  restartDelayMs,
  serviceView,
  ServiceRegistry,
  SERVICE_LIMIT_PER_WORKSPACE,
  JOB_HISTORY_LIMIT,
  JOB_LOG_BYTES,
  JOB_CHECKPOINT_MS,
  ServiceLaunchSchema,
  workspaceDirectories,
  type ServiceLaunch,
  type ServicePolicy,
  type ServiceRecord
} from './services.js';
import { agentAccountUid, agentListeningSockets, listeningSocketsOfGroup } from './listeners.js';
import { reachOfBindAddress } from '@athanor/core';
import { awaitChildExit, DEFAULT_FLUSH_GRACE_MS } from './subprocess.js';

const BackgroundRequest = z
  .object({
    executable: z.string().min(1).max(4096),
    /** 8,192 for the reason `ExecRequest` states: a per-contig scatter is thousands of arguments. */
    args: z.array(z.string().max(100_000)).max(8_192).default([]),
    cwd: z.string().default('workspace'),
    env: z.record(z.string(), z.string()).default({}),
    timeoutSeconds: z.number().int().positive().optional(),
    stdin: z.string().max(10_000_000).optional(),
    network: z.boolean().default(false),
    maxOutputBytes: z
      .number()
      .int()
      .min(4_096)
      .max(20 * 1024 * 1024)
      .default(1024 * 1024),
    /*
     * Naming the service is what turns a background session into one the computer keeps running: the
     * name is the record the owner reads, so there is no way to declare a service without saying what
     * it is. A service ignores `timeoutSeconds` entirely - the hour was the bug.
     */
    service: z.string().min(1).max(120).optional(),
    job: z.string().min(1).max(120).optional(),
    requestId: z.string().min(1).max(256).optional(),
    yieldAfterMs: z.number().int().min(0).max(5000).optional(),
    checkpointResume: ServiceLaunchSchema.optional()
  })
  .refine((request) => !(request.service && request.job), 'Choose a service or a finite job')
  .refine(
    (request) => !request.checkpointResume || Boolean(request.job),
    'A checkpoint resume command requires a finite job'
  );

type Status = 'running' | 'completed' | 'failed' | 'timed_out' | 'stopped';

interface Session {
  id: string;
  workspaceId: string;
  owner: string;
  command: string[];
  child: ChildProcessWithoutNullStreams;
  status: Status;
  /**
   * Head, tail and a byte count, the same collector the foreground path uses. These were plain
   * Buffers holding only the tail, which is the shape a long job is worst served by.
   */
  stdout: OutputCollector;
  stderr: OutputCollector;
  startedAt: string;
  /**
   * When this session will be killed, if nothing else ends it first. Absent on a service, which
   * has no deadline. Stored rather than derived because `allowedSeconds` is the minimum of what the
   * caller asked for and what this box allows, and only `#launch` sees both.
   */
  deadlineAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  timeout?: ReturnType<typeof scheduleDeadline>;
  /** The host-disk floor watch, cleared the moment the process is no longer writing to it. */
  diskFloor?: NodeJS.Timeout;
  settled?: Promise<void>;
}

/** Everything needed to put a service's process back, held once per supervised service. */
interface Supervised {
  record: ServiceRecord;
  registry: ServiceRegistry;
  root: string;
  isolateNetwork: boolean;
  guards: Guards;
  restart?: NodeJS.Timeout;
  /** Set before a deliberate kill so the exit that follows is not read as a death to recover from. */
  retiring: boolean;
  outputOffset?: number;
  settledSession?: Session;
  /**
   * What the kernel says this service is listening on, or undefined for not yet observed.
   *
   * UNDEFINED IS NOT "NOTHING". A host with no `/proc`, a service that has not bound yet, a walk
   * that lost a race with an exiting pid: all three arrive here as undefined, and a reader that
   * treats them as "listening on nothing" would report a public port as private.
   */
  listening?: { address: string; port: number }[];
  /** Set once the note below has been written, so a five-second sweep does not repeat it. */
  saidItIsReachable?: boolean;
}

/**
 * The same guards the foreground path carries, plus the sandbox this path installs itself.
 *
 * They were two declarations, and the background copy was the one missing the host-disk floor -
 * which is the guard that matters most here, because this is the path with no deadline. A
 * background command runs for up to an hour and a service runs for ever, and the only disk check
 * either of them had was the pre-flight in the route, which proves the disk was healthy at the
 * moment the command started and says nothing about the command that is filling it.
 */
export interface Guards extends ExecutionGuards {
  superviseProcessTree?: boolean;
  sandbox?: AgentSandbox | undefined;
  /**
   * Where the root-owned system-package helper lives, so this path can refuse a command that names
   * it. Not so this path can use it: an install is refused here outright. The field exists because
   * the refusal is a check against a list of helper names, and for as long as this list was built
   * only from the arm of the policy that rewrites onto the helper, the background path did not know
   * the name to refuse. On a host with no sandbox helper - a laptop, which config.ts documents as
   * supported - the list was empty and `POST /processes/start` would happily run the helper, which
   * install-native.sh grants NOPASSWD sudo. Root, from a background start, with no capability scope
   * and no approval. The foreground path had refused exactly this since the helper existed.
   */
  systemPackageHelper?: string | undefined;
}

const StopOwnerRequest = z.object({ owner: z.string().min(1).max(256).optional() });

/**
 * Written into the stopped session's own log, because `process(poll)` is the only place an agent
 * ever finds out why a job it started is no longer running - the same reason the disk-floor stop
 * above states itself there. A process that simply dies on a signal reads to a model as a crash
 * worth retrying, and this one must not be retried: whoever it was working for has gone.
 */
export const OWNER_STOPPED_NOTE =
  'stopped: the task that started this background command is no longer running';

/**
 * What a cancellation confirmation says about the background work it just ended.
 *
 * The sentence belongs here rather than in the caller because the exemption is this file's rule. A
 * service is declared precisely so it outlives the turn, so cancelling a task deliberately leaves
 * it serving - and an owner who is told only "cancelled" reads that as everything having stopped.
 * They then close the tab on a dashboard that is still up, or wonder why a port they thought they
 * had freed is busy. Naming the services that are still running is the difference between an
 * exemption and a surprise.
 */
export const ownerStopNote = (stopped: number, services: string[]): string => {
  const ended =
    stopped === 0
      ? 'No background commands were running for this task.'
      : `Stopped ${stopped} background command${stopped === 1 ? '' : 's'}.`;
  if (services.length === 0) return ended;
  const named = services.map((name) => `"${name}"`).join(', ');
  return `${ended} The declared service${services.length === 1 ? '' : 's'} ${named} ${services.length === 1 ? 'is' : 'are'} still running: a service is meant to outlive the task that started it, so stopping one is its own action.`;
};

type OutputCollector = ReturnType<typeof boundedCollector>;

/** A runner-written sentence about why this session stopped, on the session's own stderr. */
/**
 * How often the listening sockets of every service are re-read.
 *
 * Slow on purpose. A bind happens once, within a second or two of the process starting, and the
 * answer then holds for the life of the service - so this is a safety net for the late binder and
 * for a service that opens a second port, not a health check. Five seconds costs one read of
 * `/proc/net/tcp` and one walk of `/proc` per interval, whatever number of services are up.
 */
const DEFAULT_LISTENER_SWEEP_MS = 5_000;

const noteOnStderr = (session: Session, note: string): void => {
  session.stderr.push(Buffer.from(`\n${note}`));
};

export class ProcessManager {
  #closing = false;

  prepareForRestart(): boolean {
    if (
      this.#declarations.size ||
      this.#recoveries.size ||
      [...this.#sessions.values()].some((session) => session.status === 'running')
    )
      return false;
    this.#closing = true;
    return true;
  }
  readonly #quiesced = new Set<string>();
  readonly #sessions = new Map<string, Session>();
  readonly #supervised = new Map<string, Supervised>();
  readonly #jobs = new Map<string, Supervised>();
  readonly #recoveries = new Map<string, Promise<boolean>>();
  #jobCheckpoint: NodeJS.Timeout | undefined;
  #resources = new ProcessResources();
  #resourceSweep: NodeJS.Timeout | undefined;
  readonly #registries = new Map<string, ServiceRegistry>();
  readonly #declarations = new Map<string, Promise<unknown>>();
  #declarationTail: Promise<unknown> = Promise.resolve();
  readonly #flushGraceMs: number;
  readonly #policy: ServicePolicy;
  /**
   * One sweep for every service on the box rather than a timer each, because the expensive part -
   * reading `/proc/net/tcp` and walking `/proc` - is paid once however many services are up.
   * Started when the first service is supervised and stopped when the last one goes.
   */
  #listenerSweep: NodeJS.Timeout | undefined;
  readonly #listenerSweepMs: number;
  readonly #observeListeners: (pid: number) => Promise<{ address: string; port: number }[]>;
  /** Resolved once. The account is fixed, so the answer cannot change while the runner is up. */
  #agentUid: number | undefined;
  #agentListeners: { address: string; port: number }[] | undefined;

  /**
   * How long a session that has exited waits for output still in its pipes before it reports a
   * terminal status. Defaulted, because the bound is a property of this rule rather than something
   * an operator tunes; it is a parameter only so a test can assert against a deadline it owns. The
   * service policy is a parameter for the same reason: five failures at the shipped backoff take a
   * minute of wall clock, and a test cannot own that.
   */
  constructor(
    flushGraceMs: number = DEFAULT_FLUSH_GRACE_MS,
    policy: ServicePolicy = DEFAULT_SERVICE_POLICY,
    listenerSweepMs: number = DEFAULT_LISTENER_SWEEP_MS,
    /*
     * The kernel read, as a parameter, so the behaviour built on it can be tested off Linux. The
     * walk itself is held to a fixture `/proc` in listeners.test.ts; what this lets a test reach is
     * the half that matters to a reader - the note a service gets when it turns out to be open.
     */
    observeListeners: (
      pid: number
    ) => Promise<{ address: string; port: number }[]> = listeningSocketsOfGroup
  ) {
    this.#flushGraceMs = flushGraceMs;
    this.#policy = policy;
    this.#listenerSweepMs = listenerSweepMs;
    this.#observeListeners = observeListeners;
  }

  async start(
    workspaceRoot: string,
    workspaceId: string,
    owner: string,
    value: unknown,
    maximumSeconds: number,
    isolateNetwork: boolean,
    guards: Guards = {}
  ) {
    if (this.#closing) throw new Error('Process supervisor is restarting; retry the request.');
    if (this.#quiesced.has(workspaceId))
      throw new Error('The coding mission execution scope is closed');
    const request = BackgroundRequest.parse(value);
    const name = request.service;
    if (name !== undefined)
      return this.#declareInOrder(workspaceId, () =>
        this.#declareService(workspaceRoot, workspaceId, owner, name, request, {
          isolateNetwork,
          guards
        })
      );
    if (request.job) {
      const launched = await this.#declareInOrder(workspaceId, () =>
        this.#declareJob(workspaceRoot, workspaceId, owner, request, { isolateNetwork, guards })
      );
      if (request.yieldAfterMs === undefined) return launched;
      const session = this.#sessions.get(launched.sessionId);
      if (!session) return this.action(workspaceId, owner, launched.sessionId, { action: 'poll' });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          session.settled,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, request.yieldAfterMs);
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return {
        ...this.#view(session, true),
        ...(session.status === 'running'
          ? {
              yielded: true,
              instruction:
                'This command is still running under the returned sessionId. Do not launch it again. Do independent work, then use process action=wait to resume automatically when it stops.'
            }
          : {})
      };
    }
    refuseUnreachableTimeout(value, maximumSeconds, true);
    const session = await this.#launch(workspaceRoot, workspaceId, owner, request, {
      maximumSeconds,
      isolateNetwork,
      guards
    });
    return this.#view(session, false);
  }

  #declareInOrder<T>(workspaceId: string, declare: () => Promise<T>): Promise<T> {
    // Admission is shared by every execution root on this computer; namespace creation cannot multiply the cap.
    const previous = this.#declarationTail;
    const next = previous
      .catch(() => undefined)
      .then(() => {
        if (this.#quiesced.has(workspaceId))
          throw new Error('The coding mission execution scope is closed');
        return declare();
      });
    this.#declarations.set(workspaceId, next);
    this.#declarationTail = next;
    void next
      .finally(() => {
        if (this.#declarations.get(workspaceId) === next) this.#declarations.delete(workspaceId);
      })
      .catch(() => undefined);
    return next;
  }

  /**
   * Spawns one run. Shared by an ordinary background session and by every start and restart of a
   * service, so a service is subject to exactly the same refusals, sandbox, resource limits and
   * environment rules as the command an agent runs in front of you - there is no second, laxer path
   * onto this box for the things that outlive a turn.
   */
  async #launch(
    workspaceRoot: string,
    workspaceId: string,
    owner: string,
    request: z.infer<typeof BackgroundRequest>,
    options: {
      maximumSeconds?: number;
      isolateNetwork: boolean;
      guards: Guards;
      id?: string;
      onSettled?: (session: Session) => void;
      finite?: boolean;
      deadlineAt?: string;
    }
  ): Promise<Session> {
    const supervised = options.onSettled !== undefined;
    const requestedSeconds = options.finite
      ? request.timeoutSeconds
      : (request.timeoutSeconds ?? 3_600);
    const allowedSeconds =
      supervised && !options.finite
        ? undefined
        : requestedSeconds === undefined
          ? undefined
          : Math.min(requestedSeconds, options.maximumSeconds ?? requestedSeconds);
    const deadlineAt =
      options.deadlineAt ??
      (allowedSeconds === undefined
        ? undefined
        : new Date(Date.now() + allowedSeconds * 1_000).toISOString());
    if (deadlineAt && !Number.isFinite(Date.parse(deadlineAt)))
      throw new Error('The requested deadline is outside the supported date range');
    const guards = options.guards;
    // The refusals, the sandbox and the resource limiter, shared with the foreground path so a
    // service is subject to the same rules as a command an agent runs in front of you. The one
    // difference is stated in the policy rather than left implicit in a second copy of the checks:
    // a package manager is refused here, not rewritten onto the approved helper.
    const prepared = await prepareInvocation(
      workspaceRoot,
      { ...request, superviseProcessTree: guards.superviseProcessTree === true },
      {
        isolateNetwork: options.isolateNetwork,
        sandbox: guards.sandbox,
        limits: guards.limits,
        limiter: guards.limiter,
        // Refused, and named: refusing an install is not the same statement as refusing to be the
        // helper, and this path owes both.
        systemPackages: { mode: 'refused', helper: guards.systemPackageHelper }
      }
    );
    if (this.#quiesced.has(workspaceId)) {
      await discardMissionInvocation(prepared);
      throw new Error('The coding mission execution scope is closed');
    }
    const child = spawn(prepared.executable, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Leads its own process group so stopping the session reaches grandchildren too.
      detached: true,
      shell: false
    });
    trackMissionInvocation(workspaceRoot, prepared, child);
    const id = options.id ?? `proc_${randomUUID()}`;
    const timeout =
      deadlineAt === undefined
        ? undefined
        : scheduleDeadline(Date.parse(deadlineAt), () => {
            const session = this.#sessions.get(id);
            if (!session || session.status !== 'running') return;
            session.status = 'timed_out';
            noteOnStderr(
              session,
              timedOutNote(allowedSeconds ?? 0, options.maximumSeconds ?? allowedSeconds ?? 0, true)
            );
            stopProcessTree(child);
          });
    const session: Session = {
      id,
      workspaceId,
      owner,
      command: [request.executable, ...request.args],
      child,
      status: 'running',
      stdout: boundedCollector(request.maxOutputBytes),
      stderr: boundedCollector(request.maxOutputBytes),
      startedAt: new Date().toISOString(),
      ...(timeout && deadlineAt ? { timeout, deadlineAt } : {})
    };
    this.#sessions.set(id, session);
    if (!this.#resourceSweep) {
      this.#resources = new ProcessResources(processScanner('/proc', guards.sandbox));
      this.#resourceSweep = setInterval(() => {
        void this.refreshResources();
      }, PROCESS_SAMPLE_MS);
      this.#resourceSweep.unref();
    }
    void this.refreshResources();
    /*
     * The floor, watched for as long as this process can write to the disk.
     *
     * The foreground path has polled free space since a `dd` took the box down; this path had the
     * pre-flight check in the route and nothing else, which only ever proved the disk was healthy
     * at the moment the command started - and the command is what fills it. A background `dd`, a
     * service that logs to a file, an `npm ci` in a service wrapper: each of them runs for up to an
     * hour, and a service runs with no deadline at all, with nothing watching. PostgreSQL shares
     * this filesystem, so reaching the last free byte stops the database, the interface and every
     * other task on the computer, not just the command that caused it.
     */
    const storageProbe = guards.hostStorage ?? probeHostStorage;
    let probing = false;
    const diskFloor = setInterval(() => {
      const current = this.#sessions.get(id);
      if (probing || !current || current.status !== 'running') return;
      probing = true;
      void storageProbe(workspaceRoot)
        .then((storage) => {
          if (!belowHostStorageFloor(storage) || current.status !== 'running') return;
          this.#stopOnDiskFloor(id, current);
        })
        .catch(() => undefined)
        .finally(() => {
          probing = false;
        });
    }, guards.hostStoragePollMs ?? DISK_FLOOR_POLL_MS);
    diskFloor.unref();
    session.diskFloor = diskFloor;
    child.stdout.on('data', (chunk: Buffer) => session.stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => session.stderr.push(chunk));
    // Settled on the drained exit rather than on 'exit' itself. The poll that reads a terminal
    // status is also the poll that reads the log, and whatever was still sitting in the pipes when
    // the process ended is exactly the tail a job's result is in - so reporting `completed` before
    // the flush hands the agent a truncated log and calls it the whole thing. The foreground path
    // has always waited for the drain; this is the same rule for a background session.
    const settle = (status: Status, exitCode: number | null, signal: NodeJS.Signals | null) => {
      timeout?.cancel();
      clearInterval(diskFloor);
      // The two endings this class does not perform - the kernel's kill and the ruleset's refusal -
      // asked of the same function the foreground path asks, so the two paths cannot drift again.
      // This was a hand-written copy of the SIGKILL branch alone, so a background command refused
      // by Landlock got a bare "Permission denied" while an identical foreground one was told the
      // sandbox had refused it. `claimed` is the status rather than a flag, because the three stops
      // this class performs all set it away from 'running' before they kill, and all three of them
      // kill with SIGKILL; there is no separate cancel here for the same reason.
      const unclaimed = unclaimedStopNote(
        {
          stderr: () => session.stderr.text('stderr'),
          exitCode,
          signal,
          claimed: session.status !== 'running',
          cancelled: false
        },
        workspaceRoot,
        Boolean(guards.sandbox?.confineFilesystem)
      );
      if (unclaimed) noteOnStderr(session, unclaimed);
      session.exitCode = exitCode;
      session.signal = signal;
      session.finishedAt = new Date().toISOString();
      if (session.status === 'running') session.status = status;
      if (options.onSettled) {
        // A service's row must not be swept: it is the record the owner reads while the backoff
        // counts, and the next run replaces this entry under the same id.
        options.onSettled(session);
        return;
      }
      setTimeout(() => this.#sessions.delete(id), 60 * 60 * 1_000).unref();
    };
    session.settled = awaitChildExit(child, this.#flushGraceMs).then(
      ({ exitCode, signal }) => settle(exitCode === 0 ? 'completed' : 'failed', exitCode, signal),
      // A command that never started - a missing executable, an unexecutable file - emits 'error'
      // and no 'exit'. Without this the session would sit at `running` until its timeout killed a
      // process that was never there, and the agent would poll a job that could not finish.
      () => settle('failed', null, null)
    );
    if (request.stdin) child.stdin.write(request.stdin);
    if (request.yieldAfterMs !== undefined) child.stdin.end();
    return session;
  }

  /**
   * What the runner does about a background process that is taking the last of the host disk.
   *
   * The session is stopped and the reason is appended to its own stderr, because `process(poll)` is
   * the only place the agent ever finds out why a job it started is no longer running - a process
   * that simply dies on a signal reads to the model as an unexplained crash it should retry, and
   * retrying is the one thing that must not happen while the disk is still full.
   *
   * A supervised service is retired first. Otherwise the death goes round the ordinary backoff and
   * the supervisor puts the thing that filled the disk straight back into the disk it filled,
   * every second or two, for as long as the owner takes to notice. The record stays on disk in
   * `crash_looped`, which is the state that means supervision has stopped and is telling the owner
   * so: they see what it was and how it ended, and the service comes back when the runner is next
   * restarted with room on the disk, rather than never.
   */
  #stopOnDiskFloor(id: string, session: Session): void {
    const supervised = this.#supervised.get(id);
    if (supervised) {
      supervised.retiring = true;
      if (supervised.restart) clearTimeout(supervised.restart);
      delete supervised.restart;
      const record = supervised.record;
      record.state = 'crash_looped';
      record.pid = undefined;
      record.lastExit = {
        at: new Date().toISOString(),
        exitCode: null,
        signal: null,
        reason: 'stopped: the host disk was down to its last free bytes'
      };
      void supervised.registry.put(record);
    }
    session.status = 'stopped';
    noteOnStderr(session, HOST_DISK_FLOOR_NOTE);
    this.#stop(session);
  }

  // ---------------------------------------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------------------------------------

  #registry(root: string, workspaceId: string): ServiceRegistry {
    const existing = this.#registries.get(workspaceId);
    if (existing) return existing;
    const registry = new ServiceRegistry(root);
    this.#registries.set(workspaceId, registry);
    return registry;
  }

  #activePersistentCount(): number {
    return [...this.#registries.values()].reduce(
      (count, registry) =>
        count +
        registry
          .list()
          .filter(
            (record) => record.kind !== 'job' || ['running', 'interrupted'].includes(record.state)
          ).length,
      0
    );
  }

  async #declareJob(
    root: string,
    workspaceId: string,
    owner: string,
    request: z.infer<typeof BackgroundRequest>,
    options: { isolateNetwork: boolean; guards: Guards }
  ) {
    const registry = this.#registry(root, workspaceId);
    if (registry.list().length === 0) await registry.load();
    const id = request.requestId ? jobIdentity(workspaceId, owner, request.requestId) : undefined;
    const launch = ServiceLaunchSchema.parse(request);
    const existing = id ? registry.list().find((record) => record.id === id) : undefined;
    if (existing) {
      if (JSON.stringify(existing.launch) !== JSON.stringify(launch))
        throw new Error('Command request identity was already used for different arguments');
      return this.action(workspaceId, owner, existing.id, { action: 'poll' });
    }
    if (this.#activePersistentCount() >= SERVICE_LIMIT_PER_WORKSPACE)
      throw new Error(
        'This computer has reached its limit of active persistent processes. Stop one before starting another.'
      );
    const record = newServiceRecord({
      workspaceId,
      owner,
      name: request.job!,
      kind: 'job',
      launch,
      ...(request.checkpointResume ? { checkpointResume: request.checkpointResume } : {}),
      ...(request.timeoutSeconds === undefined
        ? {}
        : {
            deadlineAt: new Date(Date.now() + request.timeoutSeconds * 1_000).toISOString()
          })
    });
    if (id) record.id = id;
    // Journal before executing: an uncertain launch may require attention, but may never become
    // an unrecorded command that a restart blindly executes again.
    await registry.put(record, true);
    const job: Supervised = {
      record,
      registry,
      root,
      isolateNetwork: options.isolateNetwork,
      guards: options.guards,
      retiring: false
    };
    this.#jobs.set(record.id, job);
    this.#startJobCheckpoint();
    try {
      const session = await this.#launch(root, workspaceId, owner, request, {
        ...options,
        id: record.id,
        finite: true,
        ...(record.deadlineAt ? { deadlineAt: record.deadlineAt } : {}),
        onSettled: () => this.#jobDied(record.id)
      });
      record.startedAt = session.startedAt;
      record.pid = session.status === 'running' ? session.child.pid : undefined;
      record.deadlineAt = session.deadlineAt;
      this.#captureJob(job, session, true);
      await registry.flush();
      await this.#pruneJobHistory(workspaceId);
      return this.#view(session, false);
    } catch (cause) {
      record.state = 'failed';
      record.lastExit = {
        at: new Date().toISOString(),
        exitCode: null,
        signal: null,
        reason: cause instanceof Error ? cause.message.slice(0, 200) : 'Could not start'
      };
      await registry.put(record);
      throw cause;
    }
  }

  #startJobCheckpoint(): void {
    if (this.#jobCheckpoint) return;
    this.#jobCheckpoint = setInterval(() => {
      for (const [id, job] of this.#jobs) {
        const session = this.#sessions.get(id);
        if (session?.status === 'running' && !job.retiring) this.#captureJob(job, session);
      }
    }, JOB_CHECKPOINT_MS);
    this.#jobCheckpoint.unref();
  }

  #captureJob(job: Supervised, session: Session, force = false): void {
    const bytes = session.stdout.bytes + session.stderr.bytes + (job.outputOffset ?? 0);
    if (!force && job.record.output?.bytes === bytes) return;
    const bounded = (text: string, stream: 'stdout' | 'stderr') => {
      const collector = boundedCollector(JOB_LOG_BYTES);
      collector.push(Buffer.from(text));
      return collector.text(stream);
    };
    job.record.output = {
      stdout: bounded(session.stdout.text('stdout'), 'stdout'),
      stderr: bounded(session.stderr.text('stderr'), 'stderr'),
      bytes,
      savedAt: new Date().toISOString()
    };
    if (!job.retiring) job.record.state = session.status;
    if (session.finishedAt) {
      job.record.pid = undefined;
      job.record.lastExit = {
        at: session.finishedAt,
        exitCode: session.exitCode ?? null,
        signal: session.signal ?? null,
        reason: session.status
      };
    }
    void job.registry.put(job.record);
  }

  #jobDied(id: string): void {
    const job = this.#jobs.get(id);
    const session = this.#sessions.get(id);
    if (!job || !session || job.retiring) return;
    if (!session.child.pid && this.#recoveries.has(id)) return;
    this.#captureJob(job, session, true);
    void this.#pruneJobHistory(job.record.workspaceId);
  }

  async #pruneJobHistory(workspaceId: string): Promise<void> {
    const terminal = [...this.#jobs.values()]
      .filter(
        (job) =>
          job.record.workspaceId === workspaceId &&
          !['running', 'interrupted'].includes(job.record.state)
      )
      .sort(
        (a, b) =>
          Date.parse(a.record.lastExit?.at ?? a.record.createdAt) -
          Date.parse(b.record.lastExit?.at ?? b.record.createdAt)
      );
    for (const job of terminal.slice(0, Math.max(0, terminal.length - JOB_HISTORY_LIMIT))) {
      this.#jobs.delete(job.record.id);
      this.#sessions.delete(job.record.id);
      await job.registry.remove(job.record.id);
    }
  }

  #resumeJob(job: Supervised): Promise<boolean> {
    const pending = this.#recoveries.get(job.record.id);
    if (pending) return pending;
    const next = Promise.resolve().then(() => this.#recoverJob(job));
    this.#recoveries.set(job.record.id, next);
    void next
      .finally(() => {
        if (this.#recoveries.get(job.record.id) === next) this.#recoveries.delete(job.record.id);
      })
      .catch(() => undefined);
    return next;
  }

  async #recoverJob(job: Supervised): Promise<boolean> {
    const record = job.record;
    if (!['running', 'interrupted'].includes(record.state)) return false;
    await reclaimOrphan(record);
    record.pid = undefined;
    record.state = 'interrupted';
    record.lastExit = {
      at: new Date().toISOString(),
      exitCode: null,
      signal: null,
      reason: 'Runner stopped before a terminal result was recorded'
    };
    await job.registry.put(record, true);
    if (!record.checkpointResume) return false;
    const remaining = record.deadlineAt
      ? Math.ceil((Date.parse(record.deadlineAt) - Date.now()) / 1_000)
      : undefined;
    if (remaining !== undefined && remaining <= 0) {
      record.state = 'timed_out';
      record.lastExit.reason = 'The declared job deadline has passed';
      await job.registry.put(record);
      return false;
    }
    try {
      const session = await this.#launch(
        job.root,
        record.workspaceId,
        record.owner,
        {
          ...record.checkpointResume,
          ...(remaining === undefined ? {} : { timeoutSeconds: remaining })
        },
        {
          isolateNetwork: job.isolateNetwork,
          guards: job.guards,
          id: record.id,
          finite: true,
          ...(record.deadlineAt ? { deadlineAt: record.deadlineAt } : {}),
          onSettled: () => this.#jobDied(record.id)
        }
      );
      if (!session.child.pid) {
        await session.settled;
        record.state = 'interrupted';
        record.lastExit = {
          at: new Date().toISOString(),
          exitCode: null,
          signal: null,
          reason: 'Checkpoint program could not start; check its executable and working directory'
        };
        this.#sessions.delete(record.id);
        await job.registry.put(record);
        return false;
      }
      if (record.output) {
        session.stdout.push(Buffer.from(record.output.stdout));
        session.stderr.push(Buffer.from(record.output.stderr));
        job.outputOffset = Math.max(
          0,
          record.output.bytes - session.stdout.bytes - session.stderr.bytes
        );
      }
      record.restarts += 1;
      record.startedAt = session.startedAt;
      record.pid = session.status === 'running' ? session.child.pid : undefined;
      this.#captureJob(job, session, true);
      await job.registry.flush();
      return true;
    } catch (cause) {
      record.state = 'interrupted';
      record.lastExit.reason =
        cause instanceof Error ? cause.message.slice(0, 200) : 'Checkpoint resume could not start';
      await job.registry.put(record);
      return false;
    }
  }

  recoveryPlan(workspaceId: string, owner: string | null, id: string) {
    const job = this.#jobs.get(id);
    if (
      !job ||
      job.record.workspaceId !== workspaceId ||
      (owner !== null && job.record.owner !== owner)
    )
      throw new Error('Finite job not found');
    const record = job.record;
    if (record.state !== 'interrupted')
      throw new Error('Only an interrupted finite job can resume');
    if (!record.checkpointResume)
      throw new Error('This job has no declared checkpoint recovery command');
    const { executable, args, cwd, network } = record.checkpointResume;
    return {
      jobId: id,
      name: record.name,
      deadlineAt: record.deadlineAt,
      checkpointResume: { executable, args, cwd, network }
    };
  }

  async resumeJob(workspaceId: string, owner: string | null, id: string) {
    if (this.#closing) throw new Error('Process supervisor is restarting; retry the request.');
    this.recoveryPlan(workspaceId, owner, id);
    const job = this.#jobs.get(id)!;
    await this.#resumeJob(job);
    const session = this.#sessions.get(id);
    return session ? this.#view(session, false) : this.#jobView(job, false);
  }

  #jobView(job: Supervised, includeLogs: boolean) {
    const record = job.record;
    const finished = record.state !== 'running';
    return {
      sessionId: record.id,
      ownerTaskId: record.owner,
      workspaceId: record.workspaceId,
      status: record.state,
      command: [record.launch.executable, ...record.launch.args],
      startedAt: record.startedAt,
      ranForMs: Math.max(
        0,
        Date.parse(
          finished ? (record.lastExit?.at ?? record.startedAt) : new Date().toISOString()
        ) - Date.parse(record.startedAt)
      ),
      outputBytes: record.output?.bytes ?? 0,
      service: undefined,
      ...(!finished && record.deadlineAt
        ? { remainingMs: Math.max(0, Date.parse(record.deadlineAt) - Date.now()) }
        : {}),
      ...(record.deadlineAt ? { deadlineAt: record.deadlineAt } : {}),
      ...(finished && record.lastExit
        ? {
            finishedAt: record.lastExit.at,
            exitCode: record.lastExit.exitCode,
            signal: record.lastExit.signal
          }
        : {}),
      lifetime: 'job' as const,
      job: {
        jobId: record.id,
        name: record.name,
        state: record.state,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        restarts: record.restarts,
        checkpointResumable: Boolean(record.checkpointResume),
        ...(record.lastExit ? { lastExit: record.lastExit } : {})
      },
      ...(includeLogs
        ? { stdout: record.output?.stdout ?? '', stderr: record.output?.stderr ?? '' }
        : {})
    };
  }

  async #declareService(
    root: string,
    workspaceId: string,
    owner: string,
    name: string,
    request: z.infer<typeof BackgroundRequest>,
    options: { isolateNetwork: boolean; guards: Guards }
  ) {
    const registry = this.#registry(root, workspaceId);
    if (registry.list().length === 0) await registry.load();
    if (this.#activePersistentCount() >= SERVICE_LIMIT_PER_WORKSPACE)
      throw new Error(
        `This computer already keeps ${SERVICE_LIMIT_PER_WORKSPACE} persistent processes. Stop one before starting another.`
      );
    const launch: ServiceLaunch = {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      network: request.network,
      maxOutputBytes: request.maxOutputBytes
    };
    const record = newServiceRecord({ workspaceId, owner, name, launch });
    // Launched before it is written down, so a command this runner refuses outright - a privilege
    // escalation, a package manager, a cwd outside the workspace - throws here and never becomes a
    // record that every later boot tries five times. A binary that simply is not there cannot be
    // caught this way: spawn reports that asynchronously, on the 'error' event, so it is written
    // down first and then dies its way to `crash_looped`, which is the record the owner reads to
    // find out why the thing they asked for is not answering.
    const session = await this.#launch(root, workspaceId, owner, request, {
      isolateNetwork: options.isolateNetwork,
      guards: options.guards,
      id: record.id,
      onSettled: () => this.#serviceDied(record.id)
    });
    record.pid = session.child.pid;
    // The pid and the moment it was handed out, written together: `reclaimOrphan` reads them as one
    // fact, because a pid on its own stops meaning anything the instant the host reboots.
    record.startedAt = session.startedAt;
    this.#supervise(record.id, {
      record,
      registry,
      root,
      isolateNetwork: options.isolateNetwork,
      guards: options.guards,
      retiring: false
    });
    await registry.put(record);
    if (session.status !== 'running') this.#serviceDied(record.id);
    return this.#view(session, false);
  }

  /**
   * Which addresses each service is actually listening on, measured rather than parsed.
   *
   * The approval card is answered from the command, before the process exists - and the commonest
   * way to open a public port states no address at all: `python3 -m http.server 8099` binds every
   * interface, and so do a good many servers whose default arrived with a container image. This is
   * the half that catches those, and it is the only half that can.
   *
   * Best effort by construction. `listeningSocketsOfGroup` swallows every read failure, so a host
   * without `/proc` sweeps to no answer at all rather than to an empty one, and the view below
   * omits the field instead of claiming the service is private.
   */
  /**
   * The one door into supervision, so that everything owed to a supervised service is owed once.
   *
   * There are two ways a service comes under supervision - `startService` when an agent declares
   * one, and `resumeWorkspace` when the runner comes back up and finds records on disk - and the
   * listener sweep was started from only the first. Every deploy restarts the runner, so on the
   * box every service arrived by the second path and the sweep never ran at all: the observation
   * was live, correct, and unreachable. Two entry points, one of them wired.
   */
  #supervise(id: string, entry: Supervised): void {
    this.#supervised.set(id, entry);
    this.#startListenerSweep();
  }

  #startListenerSweep(): void {
    if (this.#listenerSweep) return;
    const sweep = () => {
      void (async () => {
        /*
         * TWO READERS, because neither works in both places athanor runs.
         *
         * The per-service walk needs `/proc/<pid>/fd`, which is exactly what the shipped
         * `ProtectProc=invisible` takes away from the runner - measured on a live box, where the
         * service and its root `sudo` wrapper were both hidden. It still answers on a developer's
         * laptop, where the runner owns the processes and there is no second account, and that is
         * the only place it answers.
         *
         * The uid reader needs only `/proc/net/tcp`, which stays readable, and answers on the box.
         * What it gives up is WHICH service opened a port; what it keeps is the fact the owner was
         * never told, which is that one is open and on what address.
         */
        this.#agentUid ??= await agentAccountUid();
        const box = await agentListeningSockets(this.#agentUid);
        if (box.length > 0 || this.#agentListeners !== undefined) this.#agentListeners = box;
        await Promise.all(
          [...this.#supervised.values()].map(async (supervised) => {
            const pid = supervised.record.pid;
            if (pid === undefined) return;
            const observed = await this.#observeListeners(pid);
            // An empty answer on a host that cannot be read is indistinguishable from an empty
            // answer on a service that binds nothing, so neither overwrites a previous observation
            // with silence: a port seen open stays reported until the service is gone.
            if (observed.length > 0 || supervised.listening !== undefined)
              supervised.listening = observed;
            this.#sayIfReachable(supervised, observed);
          })
        );
      })();
    };
    this.#listenerSweep = setInterval(sweep, this.#listenerSweepMs);
    this.#listenerSweep.unref?.();
    sweep();
  }

  /**
   * Every port an agent-owned process has open on this computer, or undefined for not observed.
   *
   * Box-level rather than per-service, and named for what it actually is. Where the runner cannot
   * read `/proc/<pid>`, the uid on a socket is the only attribution there is, so this cannot say
   * which service opened a port - and a field that claimed to would be inventing the half it could
   * not measure. The caller that needs the distinction is the owner, who is looking at one list.
   */
  observedAgentListeners(): { address: string; port: number }[] | undefined {
    return this.#agentListeners;
  }

  /**
   * Says out loud, once, that a service turned out to be reachable from off this computer.
   *
   * The approval card is answered before the process exists, from the command - and the commonest
   * way to open a public port states no address at all. `python3 -m http.server 8099` binds every
   * interface, so the card the owner read described a service that outlives its task and said
   * nothing about who could reach it, which was true of the words and wrong about the effect.
   *
   * This is the correction, on the evidence, in the one channel that reaches the agent that started
   * it: the session's own error output, which is what a `poll` returns. It names the address, says
   * what it means in the owner's terms, and says what to do instead - because the agent reading it
   * is the one that can fix it, and the fix is a flag.
   *
   * Once per run. A five-second sweep that repeated this would bury the log it is written into.
   */
  #sayIfReachable(
    supervised: Supervised,
    observed: readonly { address: string; port: number }[]
  ): void {
    if (supervised.saidItIsReachable) return;
    const reachable = observed.filter((socket) => reachOfBindAddress(socket.address) !== 'self');
    if (reachable.length === 0) return;
    supervised.saidItIsReachable = true;
    const session = this.#sessions.get(supervised.record.id);
    if (!session) return;
    const where = reachable.map((socket) => `${socket.address}:${socket.port}`).join(', ');
    noteOnStderr(
      session,
      `athanor: "${supervised.record.name}" is listening on ${where}, which is not this computer only - anyone who can reach this computer on that port can reach what it serves. If it was meant to be private, bind 127.0.0.1 and use publish_preview, which proxies to loopback.`
    );
  }

  #stopListenerSweepIfIdle(): void {
    if (this.#supervised.size > 0 || !this.#listenerSweep) return;
    clearInterval(this.#listenerSweep);
    this.#listenerSweep = undefined;
  }

  #serviceDied(id: string): void {
    const supervised = this.#supervised.get(id);
    const session = this.#sessions.get(id);
    if (!supervised || !session) return;
    // A deliberate stop, a workspace-wide stop, or a shutdown. The process ending is the intended
    // outcome, not something to recover from.
    if (supervised.retiring) return;
    if (supervised.settledSession === session) return;
    supervised.settledSession = session;
    const record = supervised.record;
    const ranForMs = Math.max(0, Date.now() - Date.parse(record.startedAt));
    record.lastExit = {
      at: session.finishedAt ?? new Date().toISOString(),
      exitCode: session.exitCode ?? null,
      signal: session.signal ?? null,
      reason: session.status
    };
    record.consecutiveFailures = nextFailureCount(
      ranForMs,
      record.consecutiveFailures,
      this.#policy
    );
    record.pid = undefined;
    if (givenUp(record.consecutiveFailures, this.#policy)) {
      // Stated rather than retried: the record stays so the owner can see what it was and how it
      // ended, and nothing restarts it until they say so.
      record.state = 'crash_looped';
      void supervised.registry.put(record);
      return;
    }
    record.state = 'restarting';
    void supervised.registry.put(record);
    const wait = setTimeout(
      () => void this.#relaunchService(id),
      restartDelayMs(record.consecutiveFailures, this.#policy)
    );
    wait.unref();
    supervised.restart = wait;
  }

  async #relaunchService(id: string): Promise<void> {
    const supervised = this.#supervised.get(id);
    if (!supervised || supervised.retiring) return;
    const record = supervised.record;
    delete supervised.restart;
    try {
      const session = await this.#launch(
        supervised.root,
        record.workspaceId,
        record.owner,
        { ...record.launch, timeoutSeconds: 3_600 },
        {
          isolateNetwork: supervised.isolateNetwork,
          guards: supervised.guards,
          id: record.id,
          onSettled: () => this.#serviceDied(record.id)
        }
      );
      record.restarts += 1;
      record.state = 'running';
      record.startedAt = session.startedAt;
      record.pid = session.child.pid;
      await supervised.registry.put(record);
    } catch (cause) {
      // A start that throws - the executable has gone, the workspace is unwritable - counts as a
      // death, so the same backoff and the same give-up cover it instead of ending supervision
      // silently on an exception nobody is waiting for.
      record.lastExit = {
        at: new Date().toISOString(),
        exitCode: null,
        signal: null,
        reason: cause instanceof Error ? cause.message.slice(0, 200) : 'could not start'
      };
      record.consecutiveFailures = nextFailureCount(0, record.consecutiveFailures, this.#policy);
      if (givenUp(record.consecutiveFailures, this.#policy)) {
        record.state = 'crash_looped';
        await supervised.registry.put(record);
        return;
      }
      record.state = 'restarting';
      await supervised.registry.put(record);
      const wait = setTimeout(
        () => void this.#relaunchService(id),
        restartDelayMs(record.consecutiveFailures, this.#policy)
      );
      wait.unref();
      supervised.restart = wait;
    }
  }

  /**
   * Everything this box was keeping running, put back. Called once as the runner comes up.
   *
   * What happens where:
   * - **Runner asked to stop** (`onClose`): every service is signalled on the way out, so nothing
   *   is left behind and this finds pids that are gone.
   * - **Runner crashed**: the children were detached and survive, reparented to init. `reclaimOrphan`
   *   recognises them by pid and command line, stops them, and this starts them again - because a
   *   process whose pipes died with the last runner cannot be adopted, only replaced.
   * - **Host rebooted**: the records are on disk and the pids are meaningless. Every recorded pid
   *   is either dead or a stranger's, `reclaimOrphan` leaves strangers alone, and each service is
   *   started fresh.
   * - **Workspace deleted**: the tree, and the record inside `.athanor` with it, is gone before
   *   this ever runs.
   */
  async resume(
    workspaceRoot: string,
    isolateNetwork: boolean,
    guards: Guards = {}
  ): Promise<number> {
    const root = path.resolve(workspaceRoot);
    const workspaces = await workspaceDirectories(root);
    const resumed = await Promise.all(
      workspaces.map((workspaceId) =>
        this.resumeWorkspace(path.join(root, workspaceId), workspaceId, isolateNetwork, guards)
      )
    );
    return resumed.reduce((sum, count) => sum + count, 0);
  }

  /**
   * The same restore for one workspace. Also used after a snapshot or checkpoint restore, which
   * stop long-running commands so nothing writes into the tree mid-rewind: without this, making a
   * recovery point would quietly take the owner's dashboard down for good.
   *
   * Returns how many services it took back under supervision, which is not the same as how many are
   * up: one whose binary has since been removed is counted here and then goes round its own backoff.
   */
  async resumeWorkspace(
    root: string,
    workspaceId: string,
    isolateNetwork: boolean,
    guards: Guards = {}
  ): Promise<number> {
    const registry = this.#registry(root, workspaceId);
    const records = await registry.load();
    if (await isCodingMissionWorkspace(root)) {
      this.#quiesced.add(workspaceId);
      return 0;
    }
    if (records.length === 0) return 0;
    await ensureWorkspace(root);
    let started = 0;
    for (const record of records) {
      if (record.kind === 'job') {
        if (this.#jobs.has(record.id)) continue;
        const job: Supervised = { record, registry, root, isolateNetwork, guards, retiring: false };
        this.#jobs.set(record.id, job);
        this.#startJobCheckpoint();
        if (await this.#resumeJob(job)) started += 1;
        continue;
      }
      if (this.#supervised.has(record.id)) continue;
      await reclaimOrphan(record);
      // A give-up is not permanent across a restart: the runner coming back is a different
      // machine state, and five more attempts over a minute is a cheap way to be wrong about it.
      record.consecutiveFailures = 0;
      record.state = 'restarting';
      record.pid = undefined;
      this.#supervise(record.id, {
        record,
        registry,
        root,
        isolateNetwork,
        guards,
        retiring: false
      });
      await this.#relaunchService(record.id);
      started += 1;
    }
    await this.#pruneJobHistory(workspaceId);
    return started;
  }

  /** Stopping a service forgets it. A service the owner stopped must not return with the runner. */
  #retireService(supervised: Supervised): void {
    supervised.retiring = true;
    if (supervised.restart) clearTimeout(supervised.restart);
    delete supervised.restart;
    this.#supervised.delete(supervised.record.id);
    this.#stopListenerSweepIfIdle();
    void supervised.registry.remove(supervised.record.id);
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * How much unfinished background work stopping this runner would destroy, across every workspace.
   *
   * WHAT IT IS FOR. `athanor update` - by hand, and weekly at a randomised hour, which on the
   * production box measured as 03:34 UTC next Monday - stops athanor.target for the backup and the
   * rebuild. That SIGTERMs this runner, `close()` stops every session, and a session that is not a
   * declared service has no record anywhere on disk: it does not come back, and the next poll of
   * its id answers "Background process not found" rather than anything about an update. A
   * twenty-hour alignment started by an agent is simply gone, at three in the morning, with nobody
   * awake. The gate that is supposed to prevent this reads `athanor_worker_active` from the
   * worker's /metrics, which counts TURNS in flight; a background job outlives the turn that
   * started it by design, so the gate is structurally blind to exactly the work this box exists
   * for. This process is the only one on the machine that knows, which is why the answer lives
   * here.
   *
   * A SERVICE IS NOT COUNTED, deliberately. Its record is in `.athanor/services.json`, `resume`
   * puts it back when the runner comes up, and `hibernate.test.ts` holds that pair. Counting it
   * would stand the weekly update down for the one kind of work a restart does not harm, and a box
   * that stands down every week is a box that quietly stops receiving fixes.
   *
   * `longestRemainingMs` is null when nothing is running, and is what a caller says out loud: "six
   * hours left" is the sentence that makes an operator wait, where a bare count is not.
   *
   * ITS ONE CALLER IS `/healthz` in server.ts, which publishes this as `backgroundCommands` and
   * `backgroundLongestRemainingMs`; `runner_background_work` in scripts/athanor greps that body for
   * those two literals, and both update arms stand down on a positive count. Nothing else calls it.
   * Those field names are therefore part of this method's contract even though no compiler checks
   * them: rename one and the update silently goes back to saying it could not tell and proceeding.
   * The end-to-end case in long-work.test.ts is what holds that shut - it runs the real shell
   * functions, cut out of scripts/athanor at test time, against the real body of the real route.
   */
  backgroundWork(): { commands: number; longestRemainingMs: number | null } {
    let commands = 0;
    let longestRemainingMs: number | null = null;
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (session.status !== 'running' || this.#supervised.has(id)) continue;
      commands += 1;
      if (!session.deadlineAt) continue;
      const remaining = Math.max(0, Date.parse(session.deadlineAt) - now);
      if (longestRemainingMs === null || remaining > longestRemainingMs)
        longestRemainingMs = remaining;
    }
    return { commands, longestRemainingMs };
  }

  /**
   * What this task started, PLUS every declared service in the workspace.
   *
   * The owner filter is right for an ordinary background command: it belongs to one turn, it dies
   * with that turn's hour, and no other turn has business polling or killing it. A DECLARED SERVICE
   * is the opposite thing by definition - naming it is what asks the computer to keep it past the
   * task - and applying the same filter to it meant that the moment the declaring task ended, no
   * agent could ever see it again.
   *
   * Measured: a service was left listening on a public port, and the next turn asked to stop it
   * listed the processes, got an empty array, and reported that nothing was running. The service
   * was in `.athanor/services.json` and in the owner's own panel the whole time. A thing the
   * product will restart across reboots, that no agent can name, cannot be turned off by asking.
   */
  taskWriters(workspaceId: string, owner: string): Array<{ id: string; kind: string }> {
    const writers = [...this.#sessions.values()]
      .filter(
        (session) =>
          session.workspaceId === workspaceId &&
          session.owner === owner &&
          session.status === 'running' &&
          !this.#supervised.has(session.id)
      )
      .map((session) => ({ id: session.id, kind: this.#jobs.has(session.id) ? 'job' : 'process' }));
    for (const job of this.#jobs.values())
      if (
        job.record.workspaceId === workspaceId &&
        job.record.owner === owner &&
        job.record.state === 'running' &&
        !writers.some((writer) => writer.id === job.record.id)
      )
        writers.push({ id: job.record.id, kind: 'job' });
    return writers;
  }

  async refreshResources(): Promise<void> {
    await this.#resources.refresh(
      [...this.#sessions.values()]
        .filter(
          (session) =>
            session.status === 'running' &&
            session.child.pid !== undefined &&
            session.child.exitCode === null &&
            session.child.signalCode === null
        )
        .map((session) => ({
          id: session.id,
          pid: session.child.pid!,
          generation: session.startedAt
        }))
    );
  }

  resourcesAvailable(): boolean {
    return this.#resources.available;
  }

  list(workspaceId: string, owner: string) {
    return [
      ...[...this.#sessions.values()]
        .filter(
          (session) =>
            session.workspaceId === workspaceId &&
            (session.owner === owner ||
              this.#supervised.has(session.id) ||
              this.#jobs.has(session.id))
        )
        .map((session) => this.#view(session, false)),
      ...[...this.#jobs.values()]
        .filter(
          (job) => job.record.workspaceId === workspaceId && !this.#sessions.has(job.record.id)
        )
        .map((job) => this.#jobView(job, false))
    ];
  }

  /**
   * Every background process on this computer, whoever started it.
   *
   * `list` above is narrowed to one owner because an agent's capability is subject to its own task:
   * it must not poll, write to or kill a session belonging to a turn it is not running. The person
   * who owns the computer is in the opposite position, and the owner filter silently denied them
   * everything - the agent starts these sessions under its task id as the subject, so an
   * owner-scoped list handed the panel an empty array for a box with three servers running on it,
   * and "what is my computer doing" had no answer anywhere in the product. The workspace is the
   * boundary that matters here, and the capability token already carries it.
   */
  listWorkspace(workspaceId: string) {
    return [
      ...[...this.#sessions.values()]
        .filter((session) => session.workspaceId === workspaceId)
        .map((session) => this.#view(session, false)),
      ...[...this.#jobs.values()]
        .filter(
          (job) => job.record.workspaceId === workspaceId && !this.#sessions.has(job.record.id)
        )
        .map((job) => this.#jobView(job, false))
    ];
  }

  /**
   * `owner` is the task a capability is subject to, or null for the person who owns the box - the
   * same split `listWorkspace` makes above, for the same reason. Without the null case the owner
   * could see a service in their panel and had no way to stop it, because every service on the
   * machine is subject to whichever task happened to start it.
   *
   * The null case is narrowed to reading and stopping. `write` puts chosen bytes on the stdin of a
   * process belonging to some other task, which is the one thing here that could be turned into
   * cross-task influence; stopping and reading are what the owner's panel was widened for, and
   * neither can be aimed at another turn's reasoning.
   */
  action(workspaceId: string, owner: string | null, id: string, value: unknown) {
    const request = z
      .object({
        action: z.enum(['poll', 'log', 'kill', 'write']),
        data: z.string().max(1_000_000).optional()
      })
      .parse(value);
    const session = this.#sessions.get(id);
    const job = this.#jobs.get(id);
    if (!session && job?.record.workspaceId === workspaceId && request.action !== 'write') {
      if (request.action === 'kill' && ['running', 'interrupted'].includes(job.record.state)) {
        job.retiring = true;
        job.record.state = 'stopped';
        job.record.lastExit = {
          at: new Date().toISOString(),
          exitCode: null,
          signal: null,
          reason: 'Stopped by owner or task'
        };
        void job.registry.put(job.record);
      }
      return this.#jobView(job, request.action === 'log' || request.action === 'poll');
    }
    /*
     * A declared service is reachable by any task in its workspace, for exactly the two verbs the
     * owner's own null case was widened to, and for the same stated reason: stopping and reading
     * cannot be aimed at another turn's reasoning, and `write` - chosen bytes onto the stdin of
     * somebody else's process - can. So a later turn can list a service, read it and stop it, and
     * still cannot speak into one.
     *
     * Without this, `list` above would have been a worse defect than the one it fixed: a service
     * the agent can finally see and still cannot act on is a row that reads as a bug in the tool.
     */
    const durable =
      (this.#supervised.has(id) || this.#jobs.has(id)) && session?.workspaceId === workspaceId;
    const mayReach =
      owner === null || session?.owner === owner || (durable && request.action !== 'write');
    if (
      !session ||
      session.workspaceId !== workspaceId ||
      !mayReach ||
      (owner === null && request.action === 'write')
    )
      throw new Error('Background process not found');
    if (request.action === 'kill') {
      const supervised = this.#supervised.get(id);
      if (supervised) this.#retireService(supervised);
      if (session.status === 'running') {
        session.status = 'stopped';
        if (job) this.#captureJob(job, session, true);
        this.#stop(session);
      }
    }
    if (request.action === 'write') {
      if (session.status !== 'running') throw new Error('Background process is not running');
      session.child.stdin.write(request.data ?? '');
    }
    return this.#view(session, request.action === 'log' || request.action === 'poll');
  }

  /**
   * Shutdown. Every child is signalled, including services: they are detached process-group
   * leaders, so a runner that exits without this leaves them running with nobody holding their
   * pipes, and the next boot has to hunt them down by pid. The records stay on disk untouched -
   * that is what brings the services back.
   */
  close() {
    clearInterval(this.#resourceSweep);
    this.#resourceSweep = undefined;
    const endings: Promise<void>[] = [];
    if (this.#jobCheckpoint) clearInterval(this.#jobCheckpoint);
    this.#jobCheckpoint = undefined;
    for (const [id, job] of this.#jobs) {
      const session = this.#sessions.get(id);
      if (session?.status === 'running') {
        job.record.state = 'interrupted';
        job.retiring = true;
        this.#captureJob(job, session, true);
      }
    }
    for (const supervised of this.#supervised.values()) {
      supervised.retiring = true;
      if (supervised.restart) clearTimeout(supervised.restart);
    }
    this.#supervised.clear();
    this.#stopListenerSweepIfIdle();
    for (const session of this.#sessions.values()) {
      if (session.settled) endings.push(session.settled);
      session.timeout?.cancel();
      if (session.diskFloor) clearInterval(session.diskFloor);
      if (session.status === 'running') this.#stop(session);
    }
    this.#sessions.clear();
    this.#jobs.clear();
    return Promise.all(endings).then(() => this.flush());
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#registries.values()].map((registry) => registry.flush()));
  }

  /**
   * Stop everything this workspace is running now. `forget` is for a workspace being deleted, where
   * the services should not come back either; a snapshot or a checkpoint restore passes it off and
   * calls `resumeWorkspace` once the tree is settled.
   */
  isWorkspaceBusy(workspaceId: string): boolean {
    return (
      this.#declarations.has(workspaceId) ||
      [...this.#sessions.values()].some(
        (session) => session.workspaceId === workspaceId && session.status === 'running'
      ) ||
      [...this.#supervised.values()].some(
        (entry) => entry.record.workspaceId === workspaceId && !entry.retiring
      ) ||
      [...this.#jobs.values()].some(
        (entry) => entry.record.workspaceId === workspaceId && entry.record.state === 'running'
      )
    );
  }

  async quiesceWorkspace(workspaceId: string): Promise<void> {
    this.#quiesced.add(workspaceId);
    const registries = new Set<ServiceRegistry>();
    const drain = () => {
      const registry = this.#registries.get(workspaceId);
      if (registry) registries.add(registry);
      const endings = [...this.#sessions.values()]
        .filter((session) => session.workspaceId === workspaceId)
        .map((session) => session.settled ?? Promise.resolve());
      this.stopWorkspace(workspaceId);
      if (registry) for (const record of registry.list()) void registry.remove(record.id);
      return endings;
    };
    const recoveries = [...this.#jobs.values()]
      .filter((job) => job.record.workspaceId === workspaceId)
      .map((job) => this.#recoveries.get(job.record.id));
    const endings = drain();
    await Promise.allSettled([this.#declarations.get(workspaceId), ...recoveries]);
    endings.push(...drain());
    await Promise.all(endings);
    await Promise.all([...registries].map((registry) => registry.flush(true)));
    this.#registries.delete(workspaceId);
  }

  stopWorkspace(workspaceId: string, options: { forget?: boolean } = {}) {
    for (const [id, job] of this.#jobs) {
      if (job.record.workspaceId !== workspaceId) continue;
      const session = this.#sessions.get(id);
      if (session?.status === 'running') {
        job.record.state = 'interrupted';
        job.retiring = true;
        this.#captureJob(job, session, true);
      }
      this.#jobs.delete(id);
      if (options.forget) void job.registry.remove(id);
    }
    for (const [id, supervised] of this.#supervised) {
      if (supervised.record.workspaceId !== workspaceId) continue;
      supervised.retiring = true;
      if (supervised.restart) clearTimeout(supervised.restart);
      this.#supervised.delete(id);
      if (options.forget) void supervised.registry.remove(id);
    }
    this.#stopListenerSweepIfIdle();
    if (options.forget) this.#registries.delete(workspaceId);
    for (const [id, session] of this.#sessions) {
      if (session.workspaceId !== workspaceId) continue;
      session.timeout?.cancel();
      if (session.diskFloor) clearInterval(session.diskFloor);
      if (session.status === 'running') this.#stop(session);
      this.#sessions.delete(id);
    }
  }

  /**
   * Everything one task left running in the background, stopped - and everything it declared to
   * outlive itself, left alone and named.
   *
   * Cancelling a task aborts whatever runner request is in flight, which covers `/exec` completely
   * and covers this path not at all: `processes/start` answers in milliseconds, so by the time the
   * owner presses Stop there is no request left to abort. The scraper the model started ran on for
   * the rest of its hour, writing into the workspace and making outbound requests attributed to
   * this computer, with the interface saying the task was cancelled. `coding_agent` had to poll
   * the task row and issue its own kill, which is the proof this general mechanism was missing.
   *
   * `subject` is the task a capability is subject to, or null for the person who owns the box - the
   * same split `list`/`listWorkspace` and `action` make. A task may only ever name itself: this
   * route would otherwise be the way round the boundary those two hold, letting one turn stop
   * another turn's work by asking. The owner is subject to no task and so must say which one they
   * mean, rather than having "everything" quietly assumed.
   *
   * Sessions are stopped where they stand rather than forgotten, unlike `stopWorkspace`: the row
   * stays so a poll reads `stopped` with the reason in its log, instead of the session vanishing.
   */
  stopOwner(workspaceId: string, subject: string | null, value: unknown) {
    const request = StopOwnerRequest.parse(value ?? {});
    if (subject !== null && request.owner !== undefined && request.owner !== subject)
      throw new Error('A task can only stop the background processes it started');
    const owner = subject ?? request.owner;
    if (owner === undefined)
      throw new Error('Stopping background processes requires which task they belong to');
    /*
     * Read from the supervision map rather than from the sessions, so a service counts as exempt
     * even in the window where it has no live session at all - between a death and its restart, or
     * after a resumed record whose first launch threw. Those are exactly the moments an owner is
     * most likely to be pressing Stop, and reporting nothing there would say the service was
     * stopped when supervision is still holding it.
     */
    const services = [...this.#supervised.values()]
      .filter(
        (supervised) =>
          supervised.record.workspaceId === workspaceId && supervised.record.owner === owner
      )
      .map((supervised) => supervised.record.name);
    const stopped: string[] = [];
    for (const [id, job] of this.#jobs) {
      if (
        job.record.workspaceId !== workspaceId ||
        job.record.owner !== owner ||
        this.#sessions.has(id) ||
        job.record.state !== 'interrupted'
      )
        continue;
      job.retiring = true;
      job.record.state = 'stopped';
      job.record.lastExit = {
        at: new Date().toISOString(),
        exitCode: null,
        signal: null,
        reason: OWNER_STOPPED_NOTE
      };
      void job.registry.put(job.record);
      stopped.push(id);
    }
    for (const [id, session] of this.#sessions) {
      if (session.workspaceId !== workspaceId || session.owner !== owner) continue;
      if (this.#supervised.has(id)) continue;
      if (session.status !== 'running') continue;
      session.timeout?.cancel();
      if (session.diskFloor) clearInterval(session.diskFloor);
      session.status = 'stopped';
      noteOnStderr(session, OWNER_STOPPED_NOTE);
      const job = this.#jobs.get(id);
      if (job) this.#captureJob(job, session, true);
      this.#stop(session);
      stopped.push(id);
    }
    return { stopped, services, note: ownerStopNote(stopped.length, services) };
  }

  #stop(session: Session): void {
    stopProcessTree(session.child);
  }

  /**
   * What a poll of this session says, and why two of these fields exist.
   *
   * `ranForMs` and `outputBytes` are here because a supervision loop was impossible without them.
   * Every field above them is fixed for the life of the session, so polling a job that is quietly
   * working - an alignment, a build, anything that writes to a file rather than to a terminal -
   * returned a byte-identical answer every time. The turn guard reads repeated identical tool
   * results as a model going in circles, and measured against the production expression it pushed
   * back at the fourth poll and stopped the turn at the eighth: the agent was stopped for watching
   * a six-hour job correctly, which is the one thing this primitive exists to let it do.
   *
   * Both advance, and they answer different questions. `ranForMs` says the job is still there;
   * `outputBytes` counts everything the job has ever produced, including what the collector has
   * dropped, so it distinguishes a job that is working silently from one that is progressing. They
   * are measured, not stored: elapsed comes from the timestamps this session already carried, and
   * the count from the collectors that already had it.
   *
   * `deadlineAt` and `remainingMs` are here so a job that is going to be killed says so BEFORE it
   * is killed rather than after. Measured on this branch before they existed: a background session
   * one second from its deadline answered a poll with `status: "running"` and `ranForMs: 1009` and
   * nothing else, and the only sentence naming the deadline was `timedOutNote`, appended once the
   * work was already gone. An agent could not have known, and neither could the owner's panel. Both
   * are on the START response too, because that is the same `#view`: the answer to "run this for
   * twenty hours" now carries the wall-clock moment it will be stopped, which is the earliest any
   * warning can possibly arrive.
   *
   * Two fields for what looks like one fact, and they are read by different things. `remainingMs`
   * is the only one a model can use, because a model has no reliable clock and cannot subtract an
   * ISO timestamp from now; `deadlineAt` is fixed for the life of the session, which is what a
   * panel renders and what survives being written into a log. Both absent on a service, which has
   * no deadline - the absence is the statement, and a zero would be a lie.
   *
   * `remainingMs` stops at the end rather than going negative: a finished session's remaining time
   * is not a number anyone should reason with, so it is simply not offered.
   */
  #view(session: Session, includeLogs: boolean) {
    const supervised = this.#supervised.get(session.id);
    const job = this.#jobs.get(session.id);
    const ranToMs = session.finishedAt ? Date.parse(session.finishedAt) : Date.now();
    return {
      sessionId: session.id,
      ownerTaskId: session.owner,
      resourceState: this.#resources.state(session.id),
      workspaceId: session.workspaceId,
      ...(this.#resources.sample(session.id)
        ? { resources: this.#resources.sample(session.id)! }
        : {}),
      status: session.status,
      command: session.command,
      startedAt: session.startedAt,
      ranForMs: Math.max(0, ranToMs - Date.parse(session.startedAt)),
      outputBytes: session.stdout.bytes + session.stderr.bytes + (job?.outputOffset ?? 0),
      lifetime: job ? ('job' as const) : supervised ? ('service' as const) : ('task' as const),
      ...(job ? { job: this.#jobView(job, false).job } : {}),
      ...(session.deadlineAt ? { deadlineAt: session.deadlineAt } : {}),
      ...(session.deadlineAt && !session.finishedAt
        ? { remainingMs: Math.max(0, Date.parse(session.deadlineAt) - Date.now()) }
        : {}),
      ...(session.finishedAt ? { finishedAt: session.finishedAt } : {}),
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
      // The session's own status stays the truth about the process - a service in its backoff
      // reads `failed`, not `running`, because a row that claims a dead thing is alive is the bug
      // this primitive exists to end. `service` is the durable record beside it.
      ...(supervised
        ? {
            service: {
              ...serviceView(supervised.record),
              /*
               * Omitted rather than empty when nothing has been observed, because the two are
               * different claims and only one of them is safe to make. An absent field says "not
               * measured here"; `listening: []` would say "this service is reachable from nowhere",
               * which is exactly the sentence a host without `/proc` must never produce.
               */
              ...(supervised.listening === undefined
                ? {}
                : {
                    listening: supervised.listening.map(
                      (socket) => `${socket.address}:${socket.port}`
                    )
                  })
            }
          }
        : {}),
      ...(includeLogs
        ? { stdout: session.stdout.text('stdout'), stderr: session.stderr.text('stderr') }
        : {})
    };
  }
}
