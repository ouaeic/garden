import type { Readable, Writable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DebuggerRequest, DebugSessionSchema, type DebugSession } from '@garden/contracts';
import { prepareInvocation, type InvocationPolicy } from './execution.js';
import {
  discardMissionInvocation,
  trackMissionInvocation,
  stopSupervisedInvocation
} from './mission-processes.js';
import { assertUserDataPath, resolveInside, workspacePath, readWorkspaceFile } from './files.js';
import { killProcessTree } from './subprocess.js';
import { DapConnection } from './dap-protocol.js';

export const DEBUG_SESSION_LIMIT = 4;
export const nativeDebugAdapters = {
  python: '/usr/local/lib/garden/python/bin/python3',
  javascript: '/usr/local/lib/garden/js-debug/src/dapDebugServer.js'
};
type AdapterPaths = typeof nativeDebugAdapters;
type RecordState = {
  view: DebugSession;
  pid?: number | undefined;
  identity?: string | undefined;
  processTreeLease?: string | undefined;
};
type Live = {
  record: RecordState;
  root: string;
  child: ChildProcessWithoutNullStreams;
  processTreeLease?: string;
  connections: DapConnection[];
  sockets: Socket[];
  socketPath?: string;
  connection?: DapConnection;
  threadId?: number;
  refs: Set<number>;
  frameIds: Set<number>;
  tail: Promise<unknown>;
  pending: number;
  stopping: boolean;
  stopped?: Promise<void>;
  initialized: Map<DapConnection, { resolve: () => void; promise: Promise<void> }>;
  pendingTargets: Set<string>;
  breakpoints: Map<string, NonNullable<DebuggerRequest['breakpoints']>>;
  deadline: NodeJS.Timeout;
};
const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value ?? {});
const active = (state: DebugSession['state']) => !['terminated', 'lost'].includes(state);
const processIdentity = async (pid: number): Promise<string | undefined> => {
  try {
    const [boot, proc] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8')
    ]);
    return `${boot.trim()}:${proc.slice(proc.lastIndexOf(')') + 2).split(' ')[19]}`;
  } catch {
    return undefined;
  }
};

export class DebuggerManager {
  #records = new Map<string, RecordState>();
  #live = new Map<string, Live>();
  #flush: Promise<void> = Promise.resolve();
  #launching = 0;
  #launches = new Map<string, Set<Promise<DebugSession>>>();
  constructor(
    private readonly workspaceRoot: string,
    private readonly policy: InvocationPolicy,
    private readonly adapters: AdapterPaths = nativeDebugAdapters,
    private readonly journalDirectory: string = path.join(workspaceRoot, '.garden')
  ) {}
  get #journal() {
    return path.join(this.journalDirectory, 'debugger.json');
  }
  async restore(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#journal, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (Buffer.byteLength(text) > 4 * 1024 * 1024)
      throw Error('Debug session journal exceeds limit');
    const records = z
      .array(
        z.object({
          view: DebugSessionSchema,
          pid: z.number().int().positive().optional(),
          identity: z.string().optional(),
          processTreeLease: z.string().optional()
        })
      )
      .max(128)
      .parse(JSON.parse(text));
    for (const record of records) {
      if (active(record.view.state) || record.view.cleanupPending) {
        if (record.processTreeLease) {
          try {
            await stopSupervisedInvocation({ processTreeLease: record.processTreeLease });
            delete record.view.cleanupPending;
          } catch {
            record.view.cleanupPending = true;
          }
        }
        if (
          record.pid &&
          record.identity &&
          (await processIdentity(record.pid)) === record.identity
        ) {
          try {
            process.kill(-record.pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }
        record.view.state = 'lost';
        record.view.note = record.view.cleanupPending
          ? 'Runner restarted; process teardown remains unverified and the workspace is held.'
          : 'Runner restarted; this debug session was not reattached or replayed.';
        record.view.frames = [];
        record.view.variables = [];
        record.view.stopEpoch++;
      }
      this.#records.set(record.view.sessionId, record);
    }
    await this.#persist();
  }
  list(workspaceId: string, owner: string | null): DebugSession[] {
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.view.workspaceId === workspaceId && (!owner || record.view.taskId === owner)
      )
      .map((record) => structuredClone(record.view));
  }
  async availability(): Promise<Record<string, boolean>> {
    if (
      this.policy.sandbox?.networkIsolation !== true ||
      !this.policy.sandbox?.confineFilesystem ||
      !this.policy.sandbox.processIsolation
    )
      return { python: false, javascript: false };
    const [python, javascript] = await Promise.all(
      Object.values(this.adapters).map((file) =>
        access(file).then(
          () => true,
          () => false
        )
      )
    );
    return { python: Boolean(python), javascript: Boolean(javascript) };
  }
  #owned(workspaceId: string, owner: string | null, id: string | undefined): RecordState {
    const record = id ? this.#records.get(id) : undefined;
    if (
      !record ||
      record.view.workspaceId !== workspaceId ||
      (owner && record.view.taskId !== owner)
    )
      throw Error('Debug session not found');
    return record;
  }
  async act(workspaceId: string, owner: string | null, value: unknown): Promise<unknown> {
    const request = DebuggerRequest.parse(value);
    if (request.action === 'list')
      return { sessions: this.list(workspaceId, owner), available: await this.availability() };
    if (request.action === 'launch') {
      if (!owner) throw Error('Debug launch requires an owning task');
      const root = workspacePath(this.workspaceRoot, workspaceId);
      const pending = this.#launch(workspaceId, owner, request);
      const launches = this.#launches.get(root) ?? new Set<Promise<DebugSession>>();
      launches.add(pending);
      this.#launches.set(root, launches);
      try {
        return await pending;
      } finally {
        launches.delete(pending);
        if (!launches.size) this.#launches.delete(root);
      }
    }
    const record = this.#owned(workspaceId, owner, request.sessionId);
    if (request.action === 'status') return structuredClone(record.view);
    const live = this.#live.get(record.view.sessionId);
    if (request.action === 'stop') {
      if (live) await this.#stop(live, 'terminated', 'Stopped explicitly.');
      else if (record.view.cleanupPending && record.processTreeLease) {
        await stopSupervisedInvocation({ processTreeLease: record.processTreeLease });
        delete record.view.cleanupPending;
        record.view.note = 'Process teardown confirmed; runtime state was lost.';
        await this.#persist();
      }
      return structuredClone(record.view);
    }
    if (!owner) throw Error('Live debug operations require an owning task');
    if (!live || live.stopping)
      throw Error('Debug session is no longer active; launch a new approved session');
    if (live.pending >= 4) throw Error('Debug session request queue is full');
    live.pending++;
    const operation = live.tail
      .catch(() => undefined)
      .then(async () => {
        if (live.stopping) throw Error('Debug session stopped');
        const result = await this.#action(live, request);
        await this.#persist();
        return result;
      });
    live.tail = operation;
    try {
      return await operation;
    } finally {
      live.pending--;
    }
  }
  isWorkspaceBusy(root: string): boolean {
    return (
      Boolean(this.#launches.get(root)?.size) ||
      [...this.#live.values()].some((live) => live.root === root) ||
      [...this.#records.values()].some(
        (record) =>
          record.view.cleanupPending &&
          workspacePath(this.workspaceRoot, record.view.workspaceId) === root
      )
    );
  }
  async quiesceWorkspace(root: string): Promise<void> {
    for (const record of this.#records.values())
      if (
        record.view.cleanupPending &&
        !this.#live.has(record.view.sessionId) &&
        workspacePath(this.workspaceRoot, record.view.workspaceId) === root
      )
        await this.act(record.view.workspaceId, null, {
          action: 'stop',
          sessionId: record.view.sessionId
        });
    await Promise.allSettled([...(this.#launches.get(root) ?? [])]);
    await Promise.all(
      [...this.#live.values()]
        .filter((live) => live.root === root)
        .map((live) => this.#stop(live, 'terminated', 'Workspace quiesced.'))
    );
  }
  async stopWorkspace(root: string): Promise<void> {
    await this.quiesceWorkspace(root);
  }
  async stopOwner(workspaceId: string, owner: string): Promise<void> {
    await Promise.allSettled([
      ...(this.#launches.get(workspacePath(this.workspaceRoot, workspaceId)) ?? [])
    ]);
    await Promise.all(
      [...this.#live.values()]
        .filter(
          (live) =>
            live.record.view.workspaceId === workspaceId && live.record.view.taskId === owner
        )
        .map((live) => this.#stop(live, 'terminated', 'Owning task stopped.'))
    );
  }
  backgroundWork(): { commands: number; longestRemainingMs: number | null } {
    const live = [...this.#live.values()];
    const pending = [...this.#records.values()].filter(
      (record) => record.view.cleanupPending && !this.#live.has(record.view.sessionId)
    ).length;
    return {
      commands: live.length + this.#launching + pending,
      longestRemainingMs: live.length
        ? Math.max(
            0,
            ...live.map((session) => Date.parse(session.record.view.deadlineAt) - Date.now())
          )
        : this.#launching || pending
          ? 3600_000
          : null
    };
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.#launches.values()].flatMap((entries) => [...entries]));
    await Promise.all(
      [...this.#live.values()].map((live) => this.#stop(live, 'terminated', 'Runner stopped.'))
    );
    await this.#flush;
  }
  async #source(
    root: string,
    requested: string
  ): Promise<{ absolute: string; relative: string; hash: string }> {
    const relative = assertUserDataPath(root, requested);
    const absolute = resolveInside(path.join(root, 'workspace'), path.join(root, relative));
    if ((await realpath(absolute)) !== absolute || !(await stat(absolute)).isFile())
      throw Error('Debugger requires a real source file inside workspace');
    const file = await readWorkspaceFile(root, relative, 2 * 1024 * 1024);
    return { absolute, relative, hash: createHash('sha256').update(file.content).digest('hex') };
  }
  async #launch(
    workspaceId: string,
    owner: string,
    request: DebuggerRequest
  ): Promise<DebugSession> {
    if (
      this.policy.sandbox?.networkIsolation !== true ||
      !this.policy.sandbox?.confineFilesystem ||
      this.policy.sandbox.processIsolation !== true
    )
      throw Error('Debugging requires the configured native filesystem and network sandbox');
    if (this.#live.size + this.#launching >= DEBUG_SESSION_LIMIT)
      throw Error('Debug session capacity reached; stop an unused session');
    this.#launching++;
    let live: Live | undefined;
    let reserved = true;
    try {
      const root = workspacePath(this.workspaceRoot, workspaceId);
      const source = await this.#source(root, request.program!);
      const cwd = resolveInside(
        path.join(root, 'workspace'),
        path.join(root, assertUserDataPath(root, request.cwd))
      );
      if ((await realpath(cwd)) !== cwd || !(await stat(cwd)).isDirectory())
        throw Error('Debugger cwd must be a real workspace directory');
      const language = request.language!;
      if (!(await this.availability())[language])
        throw Error(`The bundled ${language} debugger is not installed on this computer`);
      const sessionId = `debug-${randomUUID()}`;
      const socketPath = path.join(root, 'workspace', `.dap-${randomUUID().slice(0, 8)}.sock`);
      if (language === 'javascript' && Buffer.byteLength(socketPath) > 100)
        throw Error('Workspace path is too long for the native debugger socket');
      const invocation = await prepareInvocation(
        root,
        {
          executable: language === 'python' ? this.adapters.python : process.execPath,
          args:
            language === 'python'
              ? ['-I', '-m', 'debugpy.adapter']
              : [this.adapters.javascript, socketPath],
          cwd: path.relative(root, cwd),
          env: {},
          network: false,
          requireNetworkIsolation: true,
          superviseProcessTree: true
        },
        this.policy
      );
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(invocation.executable, invocation.args, {
          cwd: invocation.cwd,
          env: invocation.env,
          detached: true,
          stdio: 'pipe'
        });
      } catch (error) {
        await discardMissionInvocation(invocation);
        throw error;
      }
      let spawnError: Error | undefined;
      child.on('error', (error) => {
        spawnError = error;
      });
      trackMissionInvocation(root, invocation, child);
      const now = new Date();
      const view: DebugSession = {
        sessionId,
        workspaceId,
        taskId: owner,
        language,
        program: source.relative,
        cwd: path.relative(root, cwd),
        state: 'initializing',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        deadlineAt: new Date(now.getTime() + request.lifetimeSeconds * 1000).toISOString(),
        stopEpoch: 0,
        reason: null,
        frames: [],
        variables: [],
        excludedFrames: 0,
        output: '',
        note: null
      };
      const record: RecordState = {
        view,
        pid: child.pid,
        identity: child.pid ? await processIdentity(child.pid) : undefined,
        ...('processTreeLease' in invocation
          ? { processTreeLease: invocation.processTreeLease }
          : {})
      };
      const deadline = setTimeout(() => {
        if (live) void this.#stop(live, 'terminated', 'Declared debug session lifetime expired.');
      }, request.lifetimeSeconds * 1000);
      deadline.unref();
      live = {
        record,
        root,
        child,
        ...('processTreeLease' in invocation
          ? { processTreeLease: invocation.processTreeLease }
          : {}),
        connections: [],
        sockets: [],
        refs: new Set(),
        frameIds: new Set(),
        tail: Promise.resolve(),
        pending: 0,
        stopping: false,
        initialized: new Map(),
        pendingTargets: new Set(),
        breakpoints: new Map(request.breakpoints ? [[source.absolute, request.breakpoints]] : []),
        deadline,
        ...(language === 'javascript' ? { socketPath } : {})
      };
      const current = live;
      this.#records.set(sessionId, record);
      this.#live.set(sessionId, live);
      this.#launching--;
      reserved = false;
      if (spawnError) throw spawnError;
      if (language === 'javascript') child.stdout.on('data', () => undefined);
      child.stderr.on('data', (chunk: Buffer) => {
        view.output = (view.output + chunk.toString('utf8')).slice(-16_384);
      });
      child.on('error', (error) => {
        void this.#stop(current, 'lost', error.message);
      });
      child.on('exit', () => {
        if (!current.stopping) void this.#stop(current, 'lost', 'Debug adapter exited.');
      });
      await this.#persist();
      const connection =
        language === 'python'
          ? this.#connection(live, child.stdout, child.stdin)
          : await this.#socket(live);
      live.connection = connection;
      await this.#initialize(live, connection);
      const launch = connection.request(
        'launch',
        language === 'python'
          ? {
              program: source.absolute,
              cwd,
              args: request.args,
              python: this.adapters.python,
              console: 'internalConsole',
              redirectOutput: true,
              justMyCode: true,
              stopOnEntry: false,
              subprocess: false
            }
          : {
              type: 'pwa-node',
              name: path.basename(source.absolute),
              request: 'launch',
              program: source.absolute,
              cwd,
              args: request.args,
              runtimeExecutable: process.execPath,
              console: 'internalConsole',
              autoAttachChildProcesses: false,
              sourceMaps: false,
              stopOnEntry: false
            }
      );
      // Launch replies are deferred until configurationDone in both curated adapters.
      void launch.catch(() => undefined);
      await this.#waitInitialized(live, connection);
      view.state = 'configuring';
      if (request.breakpoints?.length)
        await connection.request('setBreakpoints', {
          source: { path: source.absolute },
          breakpoints: request.breakpoints
        });
      await connection.request('setExceptionBreakpoints', { filters: [] });
      await connection.request('configurationDone', {});
      await launch;
      if (view.state === 'configuring') view.state = 'running';
      await this.#persist();
      return structuredClone(view);
    } catch (error) {
      if (live)
        await this.#stop(live, 'lost', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (reserved) this.#launching--;
    }
  }
  #connection(
    live: Live,
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream
  ): DapConnection {
    const connection: DapConnection = new DapConnection(
      input as Readable,
      output as Writable,
      (event, body) => this.#event(live, connection, event, body),
      (command, args) => this.#reverse(live, command, args),
      (error) => {
        if (!live.stopping) void this.#stop(live, 'lost', error.message);
      }
    );
    live.connections.push(connection);
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    live.initialized.set(connection, { resolve, promise });
    return connection;
  }
  async #socket(live: Live): Promise<DapConnection> {
    if (!live.socketPath) throw Error('Missing curated adapter socket');
    const deadline = Date.now() + 10_000;
    while (!live.stopping) {
      const socket = connect(live.socketPath);
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
        live.sockets.push(socket);
        return this.#connection(live, socket, socket);
      } catch (error) {
        socket.destroy();
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw Error('Debug session stopped while connecting');
  }
  async #initialize(live: Live, connection: DapConnection): Promise<void> {
    await connection.request('initialize', {
      clientID: 'garden',
      adapterID: live.record.view.language === 'python' ? 'debugpy' : 'pwa-node',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true,
      supportsMemoryReferences: false
    });
  }
  async #waitInitialized(live: Live, connection: DapConnection): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        live.initialized.get(connection)!.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('Debug adapter initialization timed out')), 15_000);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async #reverse(live: Live, command: string, args: unknown): Promise<unknown> {
    if (
      live.record.view.language !== 'javascript' ||
      command !== 'startDebugging' ||
      live.stopping ||
      live.connections.length >= 4
    )
      throw Error('Reverse debug request refused');
    const request = z
      .object({
        request: z.enum(['launch', 'attach']),
        configuration: z
          .object({
            type: z.enum(['pwa-node', 'node']),
            name: z.string().max(1024),
            __pendingTargetId: z.string().min(1).max(256)
          })
          .strict()
      })
      .strict()
      .parse(args);
    const id = request.configuration.__pendingTargetId;
    if (live.pendingTargets.has(id)) throw Error('Duplicate internal debugger target');
    live.pendingTargets.add(id);
    const connection = await this.#socket(live);
    await this.#initialize(live, connection);
    const launching = connection.request(request.request, { __pendingTargetId: id });
    void launching.catch(() => undefined);
    await this.#waitInitialized(live, connection);
    for (const [source, breakpoints] of live.breakpoints)
      await connection.request('setBreakpoints', { source: { path: source }, breakpoints });
    await connection.request('setExceptionBreakpoints', { filters: [] });
    await connection.request('configurationDone', {});
    await launching;
    live.connection = connection;
    return {};
  }
  #event(live: Live, connection: DapConnection, event: string, value: unknown): void {
    const body = object(value);
    const view = live.record.view;
    if (event === 'initialized') live.initialized.get(connection)?.resolve();
    if (event === 'thread' && body.reason === 'started' && typeof body.threadId === 'number')
      live.threadId = body.threadId;
    if (event === 'output' && body.category !== 'telemetry' && typeof body.output === 'string')
      view.output = (view.output + body.output).slice(-16_384);
    if (event === 'stopped') {
      const threadId = z.number().int().nonnegative().parse(body.threadId);
      this.#invalidate(live);
      live.threadId = threadId;
      live.connection = connection;
      view.state = 'stopped';
      view.reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : 'paused';
    }
    if (event === 'continued') {
      this.#invalidate(live);
      view.state = 'running';
    }
    if (event === 'terminated') {
      void this.#stop(live, 'terminated', 'Program finished.');
      return;
    }
    view.updatedAt = new Date().toISOString();
    if (['stopped', 'continued'].includes(event))
      void this.#persist()
        .catch(() => this.#stop(live, 'lost', 'Debug session receipt could not be persisted.'))
        .catch(() => undefined);
  }
  #invalidate(live: Live): void {
    live.record.view.stopEpoch++;
    live.record.view.frames = [];
    live.record.view.variables = [];
    live.record.view.excludedFrames = 0;
    live.frameIds.clear();
    live.refs.clear();
  }
  #epoch(live: Live, request: DebuggerRequest): void {
    if (live.record.view.state !== 'stopped' || request.epoch !== live.record.view.stopEpoch)
      throw Error(
        'Stale debug stop epoch; read current session status before inspecting or resuming'
      );
  }
  async #action(live: Live, request: DebuggerRequest): Promise<unknown> {
    const connection = live.connection;
    if (!connection || connection.closed) throw Error('Debug adapter unavailable');
    const view = live.record.view;
    if (request.action === 'breakpoints') {
      const source = await this.#source(live.root, request.path!);
      live.breakpoints.set(source.absolute, request.breakpoints!);
      const result = await connection.request('setBreakpoints', {
        source: { path: source.absolute },
        breakpoints: request.breakpoints
      });
      return { epoch: view.stopEpoch, source: source.relative, sourceHash: source.hash, result };
    }
    if (request.action === 'pause') {
      if (view.state !== 'running' || live.threadId === undefined)
        throw Error('No known running debug thread');
      await connection.request('pause', { threadId: live.threadId });
      return structuredClone(view);
    }
    this.#epoch(live, request);
    const epoch = view.stopEpoch;
    if (['continue', 'next', 'stepIn', 'stepOut'].includes(request.action)) {
      this.#invalidate(live);
      view.state = 'running';
      try {
        await connection.request(request.action, { threadId: live.threadId, singleThread: false });
      } catch (error) {
        await this.#stop(
          live,
          'lost',
          'Resume outcome is uncertain; session ended without replay.'
        );
        throw error;
      }
      return structuredClone(view);
    }
    if (request.action === 'stack') {
      const result = z
        .object({
          stackFrames: z
            .array(
              z.object({
                id: z.number().int().nonnegative(),
                name: z.string(),
                line: z.number().int().nonnegative(),
                column: z.number().int().nonnegative(),
                source: z.object({ path: z.string().optional() }).optional()
              })
            )
            .max(1000)
        })
        .parse(
          await connection.request('stackTrace', {
            threadId: live.threadId,
            startFrame: 0,
            levels: 32
          })
        );
      this.#epoch(live, request);
      const frames: DebugSession['frames'] = [];
      let excluded = 0;
      for (const frame of result.stackFrames.slice(0, 32)) {
        try {
          if (!frame.source?.path) throw Error('No file source');
          const source = await this.#source(live.root, frame.source.path);
          frames.push({
            id: frame.id,
            name: frame.name.slice(0, 300),
            path: source.relative,
            line: frame.line,
            column: frame.column,
            sourceHash: source.hash
          });
        } catch {
          excluded++;
        }
      }
      this.#epoch(live, request);
      view.frames = frames;
      view.excludedFrames = excluded;
      live.frameIds = new Set(frames.map((frame) => frame.id));
      return { epoch, frames, excludedFrames: excluded };
    }
    if (request.action === 'scopes') {
      if (!live.frameIds.has(request.frameId!))
        throw Error('Frame is not from the current workspace stack');
      const result = z
        .object({
          scopes: z
            .array(
              z.object({
                name: z.string(),
                variablesReference: z.number().int().nonnegative(),
                expensive: z.boolean()
              })
            )
            .max(100)
        })
        .parse(await connection.request('scopes', { frameId: request.frameId }));
      this.#epoch(live, request);
      for (const scope of result.scopes)
        if (scope.variablesReference) live.refs.add(scope.variablesReference);
      return { epoch, scopes: result.scopes };
    }
    if (request.action === 'variables') {
      if (!live.refs.has(request.variablesReference!))
        throw Error('Variable reference is not from this stop epoch');
      const result = z
        .object({
          variables: z
            .array(
              z.object({
                name: z.string(),
                value: z.string(),
                type: z.string().optional(),
                variablesReference: z.number().int().nonnegative()
              })
            )
            .max(10_000)
        })
        .parse(
          await connection.request('variables', {
            variablesReference: request.variablesReference,
            start: 0,
            count: 100
          })
        );
      this.#epoch(live, request);
      const variables = result.variables.slice(0, 100).map((variable) => ({
        ...variable,
        name: variable.name.slice(0, 300),
        value: variable.value.slice(0, 2000)
      }));
      for (const variable of variables)
        if (variable.variablesReference) live.refs.add(variable.variablesReference);
      view.variables = variables;
      return { epoch, variables, truncated: result.variables.length > 100 };
    }
    if (request.action === 'evaluate') {
      if (!live.frameIds.has(request.frameId!))
        throw Error('Frame is not from the current workspace stack');
      const result = z
        .object({
          result: z.string(),
          type: z.string().optional(),
          variablesReference: z.number().int().nonnegative().optional()
        })
        .parse(
          await connection.request('evaluate', {
            expression: request.expression,
            frameId: request.frameId,
            context: 'repl'
          })
        );
      this.#epoch(live, request);
      if (result.variablesReference) live.refs.add(result.variablesReference);
      return { epoch, ...result, result: result.result.slice(0, 8000) };
    }
    throw Error('Unsupported debug operation');
  }
  #stop(live: Live, state: 'terminated' | 'lost', note: string): Promise<void> {
    live.stopped ??= this.#end(live, state, note);
    void live.stopped.catch(() => {
      live.record.view.state = 'lost';
      live.record.view.cleanupPending = true;
      live.record.view.note =
        'Process teardown could not be confirmed. This workspace remains busy; retry End session.';
      delete live.stopped;
    });
    return live.stopped;
  }
  async #end(live: Live, state: 'terminated' | 'lost', note: string): Promise<void> {
    live.stopping = true;
    clearTimeout(live.deadline);
    const view = live.record.view;
    view.state = 'stopping';
    view.cleanupPending = true;
    view.note = 'Stopping the program and confirming process teardown.';
    view.updatedAt = new Date().toISOString();
    this.#invalidate(live);
    let disconnectTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(
          live.connections
            .filter((connection) => !connection.closed)
            .map((connection) => connection.request('disconnect', { terminateDebuggee: true }))
        ),
        new Promise<void>((resolve) => {
          disconnectTimer = setTimeout(resolve, 2000);
        })
      ]);
    } finally {
      if (disconnectTimer) clearTimeout(disconnectTimer);
    }
    killProcessTree(live.child, 'SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killProcessTree(live.child, 'SIGKILL');
        resolve();
      }, 500);
      live.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    for (const connection of live.connections) connection.close();
    for (const socket of live.sockets) socket.destroy();
    if (live.processTreeLease)
      await stopSupervisedInvocation({ processTreeLease: live.processTreeLease });
    if (live.socketPath) await rm(live.socketPath, { force: true }).catch(() => undefined);
    view.state = state;
    view.note = note.slice(0, 2000);
    delete view.cleanupPending;
    await this.#persist();
    this.#live.delete(view.sessionId);
  }
  async #persist(): Promise<void> {
    if (this.#records.size > 128)
      for (const [id, record] of this.#records) {
        if (this.#records.size <= 128) break;
        if (!active(record.view.state) && !record.view.cleanupPending) this.#records.delete(id);
      }
    const text = JSON.stringify([...this.#records.values()]);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024)
      throw Error('Debug session journal exceeds limit');
    const write = this.#flush
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.#journal), { recursive: true, mode: 0o700 });
        const temporary = `${this.#journal}.${randomUUID()}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, this.#journal);
      });
    this.#flush = write;
    await write;
  }
}
