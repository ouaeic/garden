import { runnerLogger, failureCode } from './log.js';
import { TerminalHistory } from './terminal-history.js';
import {
  discardMissionInvocation,
  trackMissionInvocation,
  processTreeObservation
} from './mission-processes.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ComputationRequest,
  ComputationSessionSchema,
  ComputationRuntimeSchema,
  type ComputationCell,
  type ComputationInput,
  type ComputationSession
} from '@athanor/contracts';
import { boundedCollector, prepareInvocation, type InvocationPolicy } from './execution.js';
import {
  assertUserDataPath,
  readWorkspaceFile,
  resolveCommandDirectory,
  createWorkspaceFile
} from './files.js';
import { killProcessTree } from './subprocess.js';
import { belowHostStorageFloor, hostStorage } from './host-storage.js';
import { computationLaunch } from './computation-launch.js';
import { ComputationWire } from './computation-wire.js';
import { saveComputationArtifacts } from './computation-artifacts.js';
import { computationInputs } from './computation-inputs.js';
import { ComputationLedger } from './computation-ledger.js';
import { ProcessResources, processScanner } from './process-resources.js';
import { computationDeadline, scheduleComputationDeadline } from './computation-deadline.js';

export const COMPUTATION_LIMIT = 8;
export const COMPUTATION_OUTPUT_BYTES = 16_384;
const Packet = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), runtime: ComputationRuntimeSchema }),
  z.object({ kind: z.literal('fatal'), message: z.string().max(8000) }),
  z.object({
    kind: z.literal('output'),
    cellId: z.string(),
    stream: z.enum(['stdout', 'stderr']),
    text: z.string().max(32_768)
  }),
  z.object({
    kind: z.literal('done'),
    cellId: z.string(),
    result: z.unknown().optional(),
    error: z.object({ message: z.string().max(8000), interrupted: z.boolean() }).nullable(),
    variables: z
      .array(
        z.object({
          name: z.string().max(200),
          type: z.string().max(200),
          preview: z.string().max(300).optional()
        })
      )
      .max(100),
    artifacts: z.array(z.unknown()).max(4)
  })
]);
type RecordState = {
  view: ComputationSession;
  pid?: number | undefined;
  identity?: string | undefined;
};
type Live = {
  record: RecordState;
  root: string;
  child: ChildProcessWithoutNullStreams;
  processTreeLease?: string;
  token: string;
  wire?: ComputationWire;
  ready: () => void;
  failReady: (error: Error) => void;
  readyPromise: Promise<void>;
  stdout: ReturnType<typeof boundedCollector>;
  stderr: ReturnType<typeof boundedCollector>;
  settle?: () => void;
  deadline?: () => void;
  cellTimer?: () => void;
  forceTimer?: NodeJS.Timeout;
  finishing: boolean;
  request?: ComputationRequest;
};
const active = (state: ComputationSession['state']) =>
  ['starting', 'idle', 'busy', 'interrupted'].includes(state);
const identity = async (pid: number): Promise<string | undefined> => {
  try {
    const [boot, stat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8')
    ]);
    return `${boot.trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  } catch {
    return undefined;
  }
};

export class ComputationManager {
  #restorationFailed = false;
  #records = new Map<string, RecordState>();
  #live = new Map<string, Live>();
  #stopping = new Map<string, Promise<void>>();
  #flush: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout;
  #resources: ProcessResources;
  readonly #ledger: ComputationLedger;
  readonly #history = new Map<string, TerminalHistory<ComputationSession>>();
  constructor(
    private readonly workspaceRoot: string,
    private readonly policy: InvocationPolicy,
    private readonly now: () => number = Date.now
  ) {
    this.#resources = new ProcessResources(processScanner('/proc', policy.sandbox), now);
    this.#ledger = new ComputationLedger(
      path.join(workspaceRoot, '.athanor', 'computation-receipts')
    );
    this.#timer = setInterval(() => {
      void this.#sweep();
    }, 5000);
    this.#timer.unref();
  }
  get #journal() {
    return path.join(this.workspaceRoot, '.athanor', 'computation.json');
  }
  async restore(): Promise<void> {
    try {
      await this.#restoreJournal();
    } catch (cause) {
      // A failed startup must preserve the journal for diagnosis and recovery.
      this.#restorationFailed = true;
      clearInterval(this.#timer);
      throw cause;
    }
  }
  async #restoreJournal(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#journal, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
      throw Error('Computation journal exceeds limit');
    const records = z
      .array(
        z.object({
          view: ComputationSessionSchema,
          receipts: z
            .array(
              z.object({
                cellId: z.string().max(120),
                hash: z.string(),
                state: z.enum(['running', 'completed', 'failed', 'interrupted'])
              })
            )
            .max(256)
            .default([]),
          pid: z.number().int().positive().optional(),
          identity: z.string().optional()
        })
      )
      .max(128)
      .parse(JSON.parse(text));
    for (const entry of records) {
      const { receipts, ...record }: typeof entry = entry;
      if (active(record.view.state)) {
        if (record.pid && record.identity && (await identity(record.pid)) === record.identity) {
          try {
            process.kill(-record.pid, 'SIGKILL');
          } catch {
            /* The process may have exited between identity and signal. */
          }
        }
        record.view.finishedAt = new Date(this.now()).toISOString();
        record.view.state = 'lost';
        record.view.stateRetained = false;
        record.view.note =
          'Analysis runtime restarted. In-memory values were lost; no cell was replayed. Restore an explicit JSON checkpoint in a new session if available.';
        if (record.view.latestCell?.state === 'running')
          record.view.latestCell.state = 'interrupted';
      }
      for (const receipt of receipts) {
        const state = receipt.state === 'running' ? 'interrupted' : receipt.state;
        const cell =
          record.view.latestCell?.cellId === receipt.cellId
            ? { ...record.view.latestCell, state }
            : undefined;
        await this.#ledger.put(record.view.sessionId, {
          ...receipt,
          state,
          ...(cell ? { cell } : {})
        });
      }
      this.#records.set(record.view.sessionId, record);
    }
    await this.#persist();
  }
  list(workspaceId: string, owner: string | null): ComputationSession[] {
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.view.workspaceId === workspaceId && (!owner || record.view.taskId === owner)
      )
      .map((record) => this.#view(record));
  }
  status(workspaceId: string, owner: string | null, id: string): ComputationSession {
    return this.#view(this.#owned(workspaceId, owner, id));
  }
  backgroundWork(): { commands: number; longestRemainingMs: number | null } {
    const values = [...this.#live.values()];
    return {
      commands: values.length,
      longestRemainingMs: values.length
        ? Math.max(
            ...values.map((value) =>
              Math.max(0, Date.parse(value.record.view.deadlineAt) - this.now())
            )
          )
        : null
    };
  }
  async act(workspaceId: string, owner: string | null, value: unknown): Promise<unknown> {
    if (this.#restorationFailed) throw Error('Analysis history could not be restored.');
    const request = ComputationRequest.parse(value);
    if (request.rLibraryPaths && (request.action !== 'start' || request.language !== 'r'))
      throw Error('R libraries apply to starting R sessions only');
    if (request.inputs && request.action !== 'cell')
      throw Error('Declared inputs apply to code cells only');
    if (request.action === 'list') return { sessions: this.list(workspaceId, owner) };
    if (request.action === 'start') {
      if (!owner) throw Error('Computation start requires a task');
      return this.#start(workspaceId, owner, request);
    }
    if (!request.sessionId) throw Error('Computation action requires sessionId');
    const record = this.#records.has(request.sessionId)
      ? this.#owned(workspaceId, owner, request.sessionId)
      : await this.#archive(workspaceId)
          .get(request.sessionId, owner)
          .then((view) => {
            if (!view || view.workspaceId !== workspaceId)
              throw Error('Computation session not found');
            return { view: { ...view, archived: true } } satisfies RecordState;
          });
    if (record.view.archived && ['stop', 'interrupt', 'extend'].includes(request.action))
      throw Error('An archived analysis session cannot be controlled');
    if (request.action === 'status') return this.#view(record);
    if (request.action === 'stop') {
      await this.#stop(
        record,
        'stopped',
        'Stopped explicitly. In-memory values are no longer retained.'
      );
      return this.#view(record);
    }
    if (request.action === 'interrupt') {
      await this.#interrupt(record);
      return this.#view(record);
    }
    if (!owner) throw Error('Computation execution and extension require their owning task');
    if (request.action === 'extend') {
      const live = this.#live.get(record.view.sessionId);
      if (!live || !record.view.stateRetained || !active(record.view.state))
        throw Error('Only a retained session can be extended');
      if (request.lifetimeSeconds === undefined)
        throw Error('Extension requires total lifetimeSeconds from session creation');
      const deadline = computationDeadline(
        Date.parse(record.view.createdAt),
        request.lifetimeSeconds
      );
      if (
        deadline < Date.parse(record.view.deadlineAt) ||
        Date.parse(record.view.deadlineAt) <= this.now()
      )
        throw Error('Extension cannot shorten or revive an expired session');
      record.view.deadlineAt = new Date(deadline).toISOString();
      this.#scheduleLifetime(live);
      await this.#persist();
      return this.#view(record);
    }
    return this.#cell(record, request);
  }
  async stopOwner(workspaceId: string, owner: string): Promise<void> {
    await this.#stopAll(
      [...this.#records.values()].filter(
        (record) => record.view.workspaceId === workspaceId && record.view.taskId === owner
      ),
      'stopped',
      'The owning task was cancelled.'
    );
  }
  isWorkspaceBusy(workspaceId: string): boolean {
    return [...this.#records.values()].some(
      (record) => record.view.workspaceId === workspaceId && active(record.view.state)
    );
  }
  async quiesceWorkspace(workspaceId: string): Promise<void> {
    await this.stopWorkspace(workspaceId);
    await this.#flush;
  }
  async stopWorkspace(workspaceId: string): Promise<void> {
    await this.#stopAll(
      [...this.#records.values()].filter((record) => record.view.workspaceId === workspaceId),
      'stopped',
      'Workspace state is being replaced.'
    );
  }
  async close(): Promise<void> {
    clearInterval(this.#timer);
    if (this.#restorationFailed) return;
    await this.#stopAll(
      [...this.#records.values()],
      'lost',
      'Analysis runtime stopped. In-memory state was lost; no cell will replay.'
    );
    await this.#flush;
  }
  async #stopAll(records: RecordState[], state: 'stopped' | 'lost', note: string): Promise<void> {
    const results = await Promise.allSettled(
      records.map((record) => this.#stop(record, state, note))
    );
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (errors.length)
      throw new AggregateError(
        errors,
        'Computation processes stopped, but their receipts could not all be saved'
      );
  }
  #owned(workspaceId: string, owner: string | null, id: string): RecordState {
    const record = this.#records.get(id);
    if (
      !record ||
      record.view.workspaceId !== workspaceId ||
      (owner && record.view.taskId !== owner)
    )
      throw Error('Computation session not found');
    return record;
  }
  async refreshResources(): Promise<void> {
    await this.#resources.refresh(
      [...this.#live.values()].flatMap((live) =>
        live.child.pid
          ? [
              {
                id: live.record.view.sessionId,
                pid: live.child.pid,
                generation: live.record.view.createdAt,
                ...(live.processTreeLease
                  ? { namespace: () => processTreeObservation(live.processTreeLease!) }
                  : {})
              }
            ]
          : []
      )
    );
  }
  #view(record: RecordState): ComputationSession {
    const live = this.#live.get(record.view.sessionId);
    if (live) {
      const sample = this.#resources.sample(record.view.sessionId);
      if (sample) record.view.resources = sample;
      record.view.resourceState = this.#resources.state(record.view.sessionId);
    }
    if (live && record.view.latestCell?.state === 'running') {
      record.view.latestCell.stdout = live.stdout.text('stdout');
      record.view.latestCell.stderr = live.stderr.text('stderr');
    }
    return structuredClone(record.view);
  }
  #archive(workspaceId: string): TerminalHistory<ComputationSession> {
    z.string().uuid().parse(workspaceId);
    let history = this.#history.get(workspaceId);
    if (!history) {
      history = new TerminalHistory(
        path.join(this.workspaceRoot, '.athanor', 'computation-history', workspaceId),
        ComputationSessionSchema.refine(
          (view) => !active(view.state) && !view.stateRetained,
          'Only ended analysis sessions can enter saved history'
        )
      );
      this.#history.set(workspaceId, history);
    }
    return history;
  }
  async history(workspaceId: string, owners: string[] | null, query: unknown = {}) {
    await this.#flush;
    const page = await this.#archive(workspaceId).page(owners, query);
    return {
      ...page,
      entries: page.entries.map(({ cursor, value }) => ({
        cursor,
        value: { ...value, archived: true }
      }))
    };
  }
  async #persist(): Promise<void> {
    const write = this.#flush
      .catch(() => undefined)
      .then(async () => {
        const finished = [...this.#records.values()].filter(
          (record) => !active(record.view.state) && !this.#stopping.has(record.view.sessionId)
        );
        const evicted = new Set<string>();
        while (this.#records.size - evicted.size > 128 && finished.length) {
          const entry = finished.shift()!;
          await this.#archive(entry.view.workspaceId).put(
            entry.view.sessionId,
            entry.view.taskId,
            entry.view
          );
          evicted.add(entry.view.sessionId);
        }
        const data = JSON.stringify(
          [...this.#records.values()].filter((entry) => !evicted.has(entry.view.sessionId))
        );
        if (Buffer.byteLength(data) > 16 * 1024 * 1024)
          throw Error('Computation journal exceeds limit');
        const directory = path.dirname(this.#journal);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.#journal}.${randomUUID()}.tmp`;
        await writeFile(temporary, data, { mode: 0o600, flush: true });
        await rename(temporary, this.#journal);
        for (const id of evicted) this.#records.delete(id);
      });
    this.#flush = write;
    await write;
  }

  #scheduleLifetime(live: Live): void {
    live.deadline?.();
    live.deadline = scheduleComputationDeadline(
      Date.parse(live.record.view.deadlineAt),
      () => {
        this.#stopLater(live.record, 'expired', 'Declared computation lifetime elapsed.');
      },
      this.now
    );
  }
  async #start(
    workspaceId: string,
    owner: string,
    request: ComputationRequest
  ): Promise<ComputationSession> {
    if (this.policy.sandbox?.networkIsolation !== true || !this.policy.sandbox?.confineFilesystem)
      throw Error(
        'Persistent computation requires the configured native filesystem and network sandbox'
      );
    if (!request.language) throw Error('Computation start requires language');
    if (
      this.#live.size >= COMPUTATION_LIMIT ||
      [...this.#records.values()].filter((record) => active(record.view.state)).length >=
        COMPUTATION_LIMIT
    )
      throw Error('Computation session capacity reached');
    const seconds = request.lifetimeSeconds ?? 3600;
    const root = path.join(this.workspaceRoot, workspaceId);
    const cwd = resolveCommandDirectory(root, request.cwd);
    if ((await realpath(cwd)) !== cwd) throw Error('Computation cwd cannot traverse symlinks');
    if (belowHostStorageFloor(await hostStorage(root))) throw Error('Host storage floor reached');
    const id = `kernel-${randomUUID()}`;
    const token = `garden:${randomBytes(24).toString('hex')}:`;
    const createdAt = this.now();
    const record: RecordState = {
      view: {
        sessionId: id,
        workspaceId,
        taskId: owner,
        language: request.language,
        name: request.name ?? `${request.language} computation`,
        cwd: path.relative(root, cwd),
        state: 'starting',
        createdAt: new Date(createdAt).toISOString(),
        deadlineAt: new Date(computationDeadline(createdAt, seconds)).toISOString(),
        stateRetained: false,
        variables: []
      }
    };
    if (
      [...this.#records.values()].filter((record) => active(record.view.state)).length >=
      COMPUTATION_LIMIT
    )
      throw Error('Computation session capacity reached');
    this.#records.set(id, record);
    await this.#persist();
    let disposeBootstrap: (() => Promise<void>) | undefined;
    try {
      const launch = await computationLaunch(root, request, token);
      disposeBootstrap = launch.dispose;
      const invocation = await prepareInvocation(
        root,
        {
          executable: launch.executable,
          args: launch.args,
          cwd: record.view.cwd,
          env: {},
          network: false,
          requireNetworkIsolation: true
        },
        this.policy
      );
      if (record.view.state !== 'starting') {
        await discardMissionInvocation(invocation);
        throw Error('Computation start was stopped');
      }
      const child = spawn(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        detached: true,
        stdio: 'pipe'
      });
      trackMissionInvocation(root, invocation, child);
      let ready!: () => void, failReady!: (error: Error) => void;
      const readyPromise = new Promise<void>((resolve, reject) => {
        ready = resolve;
        failReady = reject;
      });
      void readyPromise.catch(() => undefined);
      const live: Live = {
        record,
        root,
        child,
        ...(invocation.processTreeLease ? { processTreeLease: invocation.processTreeLease } : {}),
        token,
        ready,
        failReady,
        readyPromise,
        stdout: boundedCollector(COMPUTATION_OUTPUT_BYTES),
        stderr: boundedCollector(COMPUTATION_OUTPUT_BYTES),
        finishing: false
      };
      this.#live.set(id, live);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.#receive(live, chunk));
      child.stderr.on('data', (chunk: Buffer) => live.stderr.push(chunk));
      child.stdin.on('error', () => {
        this.#stopLater(record, 'lost', 'Computation input closed.');
      });
      child.once('error', (error) => {
        failReady(error);
        this.#stopLater(record, 'lost', error.message);
      });
      child.once('exit', () => {
        failReady(Error('Computation exited before initialization'));
        this.#stopLater(record, 'lost', 'Interpreter exited; its in-memory state was lost.');
      });
      this.#scheduleLifetime(live);
      record.pid = child.pid;
      record.identity = child.pid ? await identity(child.pid) : undefined;
      await this.#persist();
      const initialization = setTimeout(
        () => failReady(Error('Computation initialization timed out')),
        10_000
      );
      try {
        await readyPromise;
      } finally {
        clearTimeout(initialization);
      }
      record.view.state = 'idle';
      record.view.stateRetained = true;
      await this.#persist();
      return this.#view(record);
    } catch (error) {
      await this.#stop(record, 'lost', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      await disposeBootstrap?.().catch(() => undefined);
    }
  }
  async #cell(record: RecordState, request: ComputationRequest): Promise<unknown> {
    if (request.path && ['checkpoint', 'restore'].includes(request.action))
      request = {
        ...request,
        path: assertUserDataPath(
          path.join(this.workspaceRoot, record.view.workspaceId),
          request.path
        )
      };
    const id = request.cellId;
    if (!id) throw Error('Cell/checkpoint/restore requires a stable cellId for idempotency');
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing = await this.#ledger.get(record.view.sessionId, id);
    if (existing) {
      if (existing.hash !== hash)
        throw Error('This cellId already names different code or options');
      if (existing.state === 'running' && this.#live.has(record.view.sessionId))
        return this.#view(record);
      if (existing.cell) {
        const cell =
          existing.state === 'running' && !this.#live.has(record.view.sessionId)
            ? { ...existing.cell, state: 'interrupted' as const }
            : existing.cell;
        return { ...this.#view(record), latestCell: cell };
      }
      return {
        sessionId: record.view.sessionId,
        cellId: id,
        state: existing.state === 'running' ? 'interrupted' : existing.state,
        outputRetained: false
      };
    }
    const live = this.#live.get(record.view.sessionId);
    if (!live || record.view.state !== 'idle')
      throw Error('Computation session must be idle with retained state');
    if (request.action === 'cell' && !request.code) throw Error('Cell requires code');
    const seconds =
      request.timeoutSeconds ??
      Math.min(300, Math.floor((Date.parse(record.view.deadlineAt) - this.now()) / 1000));
    if (seconds < 1) throw Error('Computation lifetime has elapsed');
    if (seconds * 1000 > Date.parse(record.view.deadlineAt) - this.now())
      throw Error('Cell timeout exceeds remaining session lifetime');
    const capturedAt = new Date(this.now()).toISOString();
    let values: unknown;
    let restoredInput: ComputationInput | undefined;
    if (request.action === 'restore') {
      if (!request.path) throw Error('Restore requires a JSON checkpoint path');
      const content = await readWorkspaceFile(
        live.root,
        assertUserDataPath(live.root, request.path),
        1024 * 1024
      );
      const checkpoint = z
        .object({
          format: z.literal('garden-computation-json-1'),
          language: z.literal(record.view.language),
          values: z.record(z.string().regex(/^[A-Za-z$][\w$.]*$/), z.unknown())
        })
        .strict()
        .parse(JSON.parse(content.content.toString('utf8')));
      values = checkpoint.values;
      restoredInput = {
        path: assertUserDataPath(live.root, request.path),
        status: 'hashed',
        sha256: content.sha256,
        bytes: content.content.length
      };
    }
    if (request.action === 'checkpoint') {
      if (!request.path || !request.variables?.length)
        throw Error('Checkpoint requires a new path and selected variables');
      assertUserDataPath(live.root, request.path);
    }
    const inputs = restoredInput
      ? [restoredInput]
      : await computationInputs(live.root, request.inputs ?? []);
    if (this.#live.get(record.view.sessionId) !== live || record.view.state !== 'idle')
      throw Error('Computation session changed while preparing the cell');
    const predecessorCellId = record.view.latestCell?.cellId;
    record.view.latestCell = {
      cellId: id,
      state: 'running',
      startedAt: new Date(this.now()).toISOString(),
      stdout: '',
      stderr: '',
      artifacts: [],
      manifest: {
        format: 'garden-computation-manifest-1',
        capturedAt,
        requestSha256: hash,
        ...(request.code !== undefined
          ? { sourceSha256: createHash('sha256').update(request.code).digest('hex') }
          : {}),
        ...(predecessorCellId ? { predecessorCellId } : {}),
        ...(record.view.runtime ? { runtime: record.view.runtime } : {}),
        inputs,
        coverage: 'declared_inputs_before_execution'
      }
    };
    record.view.state = 'busy';
    live.request = request;
    live.stdout = boundedCollector(COMPUTATION_OUTPUT_BYTES);
    live.stderr = boundedCollector(COMPUTATION_OUTPUT_BYTES);
    try {
      await this.#ledger.put(record.view.sessionId, {
        cellId: id,
        hash,
        state: 'running',
        cell: record.view.latestCell
      });
      await this.#persist();
    } catch (error) {
      await this.#stop(record, 'lost', 'Cannot persist computation request').catch(() => undefined);
      throw error;
    }
    if (this.#live.get(record.view.sessionId) !== live)
      throw Error('Computation session stopped before cell submission');
    const completion = new Promise<void>((resolve) => {
      live.settle = resolve;
    });
    live.cellTimer = scheduleComputationDeadline(
      computationDeadline(this.now(), seconds),
      () => {
        void this.#interrupt(record);
      },
      this.now
    );
    live.child.stdin.write(
      JSON.stringify({
        action: request.action,
        cellId: id,
        code: request.code,
        variables: request.variables,
        values
      }) + '\n'
    );
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      completion,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      })
    ]);
    if (timer) clearTimeout(timer);
    return this.#view(record);
  }
  #receive(live: Live, chunk: string): void {
    live.wire ??= new ComputationWire(
      live.token,
      (output) => live.stdout.push(Buffer.from(output)),
      (value) => {
        const packet = Packet.parse(JSON.parse(value));
        if (packet.kind === 'ready') {
          if (live.record.view.state !== 'starting') return;
          live.record.view.runtime = packet.runtime;
          live.ready();
          return;
        }
        if (packet.kind === 'fatal') {
          this.#stopLater(live.record, 'lost', packet.message);
          return;
        }
        if (packet.cellId !== live.record.view.latestCell?.cellId || live.finishing) return;
        if (packet.kind === 'output') live[packet.stream].push(Buffer.from(packet.text));
        else {
          live.finishing = true;
          void this.#finish(live, packet);
        }
      }
    );
    try {
      live.wire.push(chunk);
    } catch (error) {
      this.#stopLater(
        live.record,
        'lost',
        error instanceof Error ? error.message : 'Invalid computation protocol packet'
      );
    }
  }
  async #finish(live: Live, packet: z.infer<typeof Packet> & { kind: 'done' }): Promise<void> {
    const cell = live.record.view.latestCell!;
    const settle = live.settle;
    live.cellTimer?.();
    clearTimeout(live.forceTimer);
    try {
      if (!this.#live.has(live.record.view.sessionId)) return;
      cell.stdout = live.stdout.text('stdout');
      cell.stderr = live.stderr.text('stderr');
      if (
        live.request?.action !== 'checkpoint' &&
        Buffer.byteLength(JSON.stringify(packet.result) ?? '') > 32768
      )
        throw Error('Computation result exceeds display limit');
      cell.result = packet.result;
      if (packet.error) {
        cell.error = packet.error.message;
        cell.state = packet.error.interrupted ? 'interrupted' : 'failed';
      } else {
        if (live.request?.action === 'checkpoint') {
          const data = Buffer.from(
            JSON.stringify({
              format: 'garden-computation-json-1',
              language: live.record.view.language,
              values: z
                .object({ checkpoint: z.record(z.string(), z.unknown()) })
                .parse(packet.result).checkpoint
            })
          );
          await createWorkspaceFile(live.root, live.request.path!, data, 1024 * 1024);
          cell.artifacts = [
            { path: live.request.path!, mimeType: 'application/json', bytes: data.length }
          ];
          cell.result = { checkpoint: live.request.path };
        } else cell.artifacts = await saveComputationArtifacts(live.root, packet.artifacts);
        cell.state = 'completed';
      }
      if (this.#live.get(live.record.view.sessionId) === live) {
        live.record.view.variables = packet.variables;
      }
    } catch (error) {
      cell.state = 'failed';
      cell.error = error instanceof Error ? error.message : String(error);
    } finally {
      cell.finishedAt = new Date(this.now()).toISOString();
      try {
        await this.#persistCell(live.record.view.sessionId, cell);
        if (this.#live.get(live.record.view.sessionId) === live) {
          live.finishing = false;
          live.record.view.state = 'idle';
        }
        await this.#persist();
      } catch {
        await this.#stop(live.record, 'lost', 'Cannot persist computation receipt').catch(
          () => undefined
        );
      } finally {
        if (live.record.view.latestCell === cell) live.finishing = false;
        settle?.();
      }
    }
  }
  async #persistCell(sessionId: string, cell: ComputationCell): Promise<void> {
    const hash =
      cell.manifest?.requestSha256 ?? (await this.#ledger.get(sessionId, cell.cellId))?.hash;
    if (!hash) throw Error('Computation request identity is missing');
    await this.#ledger.put(sessionId, { cellId: cell.cellId, hash, state: cell.state, cell });
  }
  async #interrupt(record: RecordState): Promise<void> {
    const live = this.#live.get(record.view.sessionId);
    if (!live || record.view.state !== 'busy') return;
    record.view.state = 'interrupted';
    killProcessTree(live.child, 'SIGINT');
    live.forceTimer = setTimeout(() => {
      this.#stopLater(
        record,
        'lost',
        'Interpreter did not acknowledge interrupt; its process group was stopped and state was lost.'
      );
    }, 1500);
    live.forceTimer.unref();
    await this.#persist();
  }
  #stopLater(record: RecordState, state: 'stopped' | 'expired' | 'lost', note: string): void {
    void this.#stop(record, state, note).catch((cause: unknown) => {
      runnerLogger.warn('computation.record_write_failed', {
        workspaceId: record.view.workspaceId,
        code: failureCode(cause)
      });
    });
  }
  #stop(record: RecordState, state: 'stopped' | 'expired' | 'lost', note: string): Promise<void> {
    const pending = this.#stopping.get(record.view.sessionId);
    if (pending) return pending;
    if (!this.#live.has(record.view.sessionId) && !active(record.view.state))
      return Promise.resolve();
    const ending = this.#finishStop(record, state, note);
    this.#stopping.set(record.view.sessionId, ending);
    void ending
      .finally(() => {
        if (this.#stopping.get(record.view.sessionId) === ending)
          this.#stopping.delete(record.view.sessionId);
      })
      .catch(() => undefined);
    return ending;
  }
  async #finishStop(
    record: RecordState,
    state: 'stopped' | 'expired' | 'lost',
    note: string
  ): Promise<void> {
    const live = this.#live.get(record.view.sessionId);
    if (!live && !active(record.view.state)) return;
    if (live) {
      this.#view(record);
      this.#live.delete(record.view.sessionId);
      live.deadline?.();
      live.cellTimer?.();
      clearTimeout(live.forceTimer);
      killProcessTree(live.child, 'SIGKILL');
      live.failReady(Error(note));
      live.settle?.();
    }
    record.view.finishedAt = new Date(this.now()).toISOString();
    record.view.state = state;
    record.view.stateRetained = false;
    record.view.note = note;
    if (record.view.latestCell?.state === 'running') {
      record.view.latestCell.state = 'interrupted';
      record.view.latestCell.finishedAt = new Date(this.now()).toISOString();
      if (live) {
        record.view.latestCell.stdout = live.stdout.text('stdout');
        record.view.latestCell.stderr = live.stderr.text('stderr');
      }
    }
    try {
      if (record.view.latestCell)
        await this.#persistCell(record.view.sessionId, record.view.latestCell);
    } finally {
      await this.#persist();
    }
  }
  async #sweep(): Promise<void> {
    await this.refreshResources();
    for (const live of this.#live.values())
      try {
        if (Date.parse(live.record.view.deadlineAt) <= this.now())
          await this.#stop(live.record, 'expired', 'Declared computation lifetime elapsed.');
        else if (belowHostStorageFloor(await hostStorage(live.root)))
          await this.#stop(live.record, 'lost', 'Host storage floor reached.');
      } catch {
        /* The next sweep rechecks storage availability. */
      }
  }
}
