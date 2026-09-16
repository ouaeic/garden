import { registerBrowserActionRoutes } from './browser-action-routes.js';
import { connectProcessSupervisor } from './process-supervisor.js';
import { OwnerStroke } from '@athanor/contracts';
import { ProjectUpdatesManager } from './project-updates.js';
import { registerProjectUpdateRoutes } from './project-update-routes.js';
import { DebuggerManager } from './debugger.js';
import { registerDebuggerRoutes } from './debugger-routes.js';
import { NativeCodingMissions, registerCodingMissionRoutes } from './coding-missions.js';
import { ProjectWorkspaces, registerProjectWorkspaceRoutes } from './project-workspaces.js';
import {
  freezeMissionWorkspace,
  managedWorkspaceBusy,
  quiesceManagedChildren,
  recoverMissionProcesses
} from './mission-processes.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { PROCESS_SAMPLE_MS } from './process-resources.js';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import pty from '@homebridge/node-pty-prebuilt-multiarch';
import { z } from 'zod';
import {
  BrowserAction,
  BrowserTabRetentionRequest,
  DesktopAction,
  DesktopHolder,
  DesktopLaunchRequest,
  WebFetchRequest
} from '@athanor/contracts';
import {
  deriveCapabilityNonce,
  reachOfBindAddress,
  reservedPreviewPorts,
  verifyCapabilityToken,
  type CapabilityTokenClaims
} from '@athanor/core';
import { inspectAudioSource, prepareAudio } from './audio.js';
import { authenticateRunnerRequest, requireScope } from './auth.js';
import { BotWallError, BrowserManager, type BrowserStreamState } from './browser.js';
import { dampenBrowserCpu, linuxBrowserCpuDeps } from './browser-cpu.js';
import { TAB_IDLE_MS, TAB_SWEEP_MS } from './browser-tabs.js';
import { registerFileDownloadRoutes } from './file-downloads.js';
import { ComputationManager } from './computation.js';
import { registerComputationRoutes } from './computation-routes.js';
import { CodeIntelligenceManager } from './code-intelligence.js';
import { registerCodeIntelligenceRoutes } from './code-intelligence-routes.js';
import { CheckpointRefusedError, WorkspaceCheckpoints } from './checkpoints.js';
import type { RunnerConfig } from './config.js';
import { DesktopManager, type DesktopStreamState } from './desktop.js';
import { agentHome, agentSearchPath, execute } from './execution.js';
import { assertHostStorageWrite, hostStorage, type HostStorage } from './host-storage.js';
import {
  conversionTargetFor,
  convertImageForModel,
  IMAGE_CONTENT_TYPES,
  IMAGE_SOURCE_MAX_BYTES
} from './images.js';
import { commandLimits, resolveCommandLimiter } from './limits.js';
import { machineReport, type CgroupReading } from './machine.js';
import { failureCode, runnerLogger } from './log.js';
import { ProcessManager } from './processes.js';
import { findRenderTools, proveRender, RENDER_SOURCE_MAX_BYTES } from './render-proof.js';
import {
  probeNativeIsolation,
  resolveAgentSandbox,
  sandboxSpecDirectory,
  sandboxedInvocation,
  sandboxedShell
} from './sandbox.js';
import {
  assertUserDataPath,
  createWorkspaceFolder,
  ensureWorkspace,
  deleteWorkspaceFile,
  listFiles,
  readWorkspaceFile,
  readWorkspaceFileLines,
  renameWorkspaceEntry,
  workspacePath,
  workspaceUsage,
  writeWorkspaceFile,
  WorkspaceFileError
} from './files.js';
import { readerFor } from './seen-lines.js';
import { probeBinaries, toolchainReport } from './toolchain.js';
import { workspaceSurfaces } from './surfaces.js';
import {
  checkPreviewPort,
  previewPort,
  previewRequestHeaders,
  previewResponseHeaders,
  previewTarget
} from './preview.js';
import { SEARCH_RESULT_LIMIT } from './search.js';
import {
  createSnapshot,
  deleteAllSnapshots,
  deleteSnapshot,
  restoreSnapshot
} from './snapshots.js';

/**
 * What was wrong with a request, in a sentence somebody can act on.
 *
 * Zod's own `message` is the issue array pretty-printed as JSON, and that string travelled all the
 * way to the conversation, where the owner read it. This says the same thing in the form the model
 * needs to correct itself and the owner needs to understand: which field, and what it should have
 * been. Bounded, because a malformed body can raise a hundred issues and the first few are the ones
 * that matter.
 */
export const sayWhatIsWrong = (error: z.ZodError): string => {
  const shown = error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message.toLowerCase()}`);
  const rest = error.issues.length - shown.length;
  return `Invalid request - ${shown.join('; ')}${rest > 0 ? ` (and ${rest} more)` : ''}`;
};

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * The size a shell starts at when the client has not said one.
 *
 * It used to be 120x32, chosen for nothing and wrong everywhere: the pane it renders into measures
 * about 70 columns on a desktop and fewer on a phone, so every full-screen program drew past the
 * edge. 80x24 is the size every terminal has defaulted to for forty years, so a client that says
 * nothing at least gets the size programs assume when they cannot ask.
 */
export const TERMINAL_DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

/**
 * What a `resize` frame means, clamped.
 *
 * The floor is the old one: a pane briefly reporting 2x1 - which a hidden tab really does report -
 * must not reflow a running pager to two columns. The ceiling is new and is about this being an
 * allocation: the numbers come off a socket, and a pty is real memory, so a frame asking for
 * 100000 columns is answered with the largest honest screen instead. A value that is not a finite
 * number keeps the size the session already had rather than resetting it.
 */
export const terminalSize = (cols: unknown, rows: unknown, current: TerminalSize): TerminalSize => {
  const clamp = (value: unknown, low: number, high: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(high, Math.max(low, Math.trunc(value)))
      : fallback;
  return {
    cols: clamp(cols, 20, 500, current.cols),
    rows: clamp(rows, 5, 200, current.rows)
  };
};

/**
 * Whether a renewal capability may extend the session a given capability opened.
 *
 * Exported because a copy of it in the test proved nothing about this branch. `terminal-renewal.
 * test.ts` used to restate these four comparisons by hand, so its four cases measured a
 * reimplementation: drop a clause here and every one of them stayed green.
 *
 * It cannot widen anything. Same owner, same workspace, same role, still carrying `terminal` - and
 * the audience is checked before this is reached, by the verifier. The most a renewal can do is
 * move out a deadline on a connection that is already this owner's.
 */
export const renewalExtendsSession = (
  renewed: Pick<CapabilityTokenClaims, 'workspaceId' | 'sub' | 'role' | 'scopes'>,
  opened: Pick<CapabilityTokenClaims, 'workspaceId' | 'sub' | 'role'>
): boolean =>
  renewed.workspaceId === opened.workspaceId &&
  renewed.sub === opened.sub &&
  renewed.role === opened.role &&
  renewed.scopes.includes('terminal');

const WorkspaceRelativePath = z.string().min(1).max(1_024);

const FolderRequest = z.object({ path: WorkspaceRelativePath });
const RenameRequest = z.object({ from: WorkspaceRelativePath, to: WorkspaceRelativePath });
const BinaryProbeRequest = z.object({
  binaries: z.array(z.string().min(1).max(120)).min(1).max(64)
});
/**
 * What the harness wants proved about a rendered document. Both measurements are optional in
 * different senses: a page count is only checked when the job asked for one, and a margin only
 * moves the boundary the text has to stay inside, which is the page edge by default.
 */
const RenderProofRequest = z.object({
  path: WorkspaceRelativePath,
  deadlineAt: z.number().int().positive().optional(),
  expectPages: z.number().int().min(1).max(5_000).optional(),
  marginPoints: z.number().min(0).max(200).optional()
});
/**
 * A window of a recording, in seconds from its start. The ceiling is a day, which no owner's voice
 * memo reaches and which stops a nonsense offset from becoming a nonsense encode; how much is
 * actually prepared is decided against the file's own length and the window limit in `audio.ts`.
 */
const PrepareAudioRequest = z.object({
  path: WorkspaceRelativePath,
  startSeconds: z.number().min(0).max(86_400).optional(),
  endSeconds: z.number().min(0).max(86_400).optional(),
  expectedSourceSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
});
const ReadElementsRequest = z.object({
  /** Scopes the read to one form or panel; omitted, it reads the whole page as a snapshot would. */
  selector: z.string().min(1).max(1_024).optional(),
  tabId: z.string().min(1).max(32).optional()
});
const WebSearchRequest = z.object({
  query: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(SEARCH_RESULT_LIMIT).default(SEARCH_RESULT_LIMIT)
});
const PrintPdfRequest = z.object({
  path: WorkspaceRelativePath,
  format: z.enum(['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid']).default('A4'),
  landscape: z.boolean().default(false),
  printBackground: z.boolean().default(true),
  tabId: z.string().min(1).max(32).optional()
});

/** A query value that has to be a count. Anything else is treated as if it had not been sent. */
const positiveQueryInteger = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  return value !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const contentTypeFor = (requestedPath: string): string =>
  ({
    ...IMAGE_CONTENT_TYPES,
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
  })[path.extname(requestedPath).toLowerCase()] ?? 'application/octet-stream';

/**
 * The two things a desktop viewer says about itself, rather than about the machine.
 *
 * They live here rather than in `@athanor/contracts` because nothing but this socket sends them:
 * they are the client half of a transport negotiation, not part of the tool surface the model or
 * the control plane sees. `DisplayViewport`'s own shape is `desktop-stream.ts:341`; this is that
 * shape with the bounds a stranger's message needs.
 */
const DesktopHello = z.object({
  type: z.literal('hello'),
  /** False on a client with no `VideoDecoder`, which is what the JPEG transport exists for. */
  canDecodeVideo: z.boolean().default(true)
});

const DesktopViewport = z.object({
  cssWidth: z.number().finite().min(1).max(20_000),
  cssHeight: z.number().finite().min(1).max(20_000),
  devicePixelRatio: z.number().finite().min(0.5).max(8).default(1),
  mode: z.enum(['native', 'css']).default('css')
});

/**
 * The seams a test needs and production never sets.
 *
 * Both exist for the same reason `ExecutionGuards` has one (`execution.ts:181`): the two things
 * below are the runner's contact with the machine underneath it, and a suite that has to own a
 * real disk or a real X server to say anything is a suite that reports the state of the build
 * machine rather than the state of the code.
 */
export interface RunnerServerOptions {
  /** Free-space probe. Injected so the disk floor can be exercised without filling a filesystem. */
  hostStorage?: ((root: string) => Promise<HostStorage>) | undefined;
  /**
   * Control-group ceilings. The runner's other contact with the kernel, and injected for the same
   * reason as the one above: what a job may actually have is set by `cpu.max`, `memory.max` and
   * `cpuset.cpus.effective`, and a suite that can only read the build machine's own cgroup can
   * never prove the case that matters - a box whose hardware and whose allowance disagree.
   */
  cgroup?: (() => Promise<CgroupReading>) | undefined;
  /** The desktop, so the stream route can be driven without an Xvfb and an ffmpeg on the box. */
  desktop?: DesktopManager | undefined;
}

export const buildServer = async (config: RunnerConfig, options: RunnerServerOptions = {}) => {
  const app = Fastify({ logger: false, bodyLimit: config.MAX_FILE_BYTES });
  const sandbox = await resolveAgentSandbox(
    config.AGENT_SANDBOX_HELPER,
    sandboxSpecDirectory(config.WORKSPACE_ROOT),
    config.CONFINE_AGENT_FILESYSTEM
  );
  if (sandbox) {
    Object.assign(sandbox, await probeNativeIsolation(sandbox));
    if (!(await recoverMissionProcesses(sandbox))) sandbox.processIsolation = false;
  }
  const terminals = new Map<object, string>();
  const privilegedHelpers = [config.SYSTEM_PACKAGE_HELPER, sandbox?.helper];
  const probeHostStorage = options.hostStorage ?? hostStorage;
  const desktop =
    options.desktop ??
    new DesktopManager(
      config.DESKTOP_BRIDGE_EXECUTABLE,
      config.DESKTOP_SESSION_EXECUTABLE,
      privilegedHelpers
    );
  // The browser runs on the workspace's own X server when there is one, so a page sees an
  // ordinary desktop and a person taking over finds the browser on the screen they are watching.
  const browser = new BrowserManager({
    executablePath: config.BROWSER_EXECUTABLE_PATH,
    /*
     * The session browser yields to the work it is meant to be serving.
     *
     * A host with no GPU renders through SwiftShader, and any animated page pins it - measured on
     * one installation at about thirteen of sixteen cores, held for as long as the page stayed
     * open. A weight rather than a cap, for the reason this service's own unit file gives about
     * `CPUWeight`: the browser still gets the whole processor when nothing else wants it.
     */
    browserCpuNice: config.BROWSER_CPU_NICE,
    dampenBrowserCpu: (profileDir, niceness) =>
      dampenBrowserCpu(linuxBrowserCpuDeps, profileDir, niceness),
    desktopDisplay: config.BROWSER_USE_DESKTOP_DISPLAY
      ? (workspaceId, root) => desktop.displayEnvironment(workspaceId, root)
      : undefined,
    // Same screen, same arbiter. Wired with the display and not separately: a browser drawn on the
    // workspace's own X server must answer the Computer pane's Take over button, and before this
    // the two surfaces each kept their own holder and neither knew about the other's.
    desktopControl: config.BROWSER_USE_DESKTOP_DISPLAY
      ? (workspaceId, root) => desktop.controlFor(workspaceId, root)
      : undefined,
    maxFileBytes: config.MAX_FILE_BYTES
  });
  const processes = config.JOB_SUPERVISOR_SOCKET
    ? connectProcessSupervisor(config.JOB_SUPERVISOR_SOCKET, config.RUNNER_SHARED_SECRET)
    : new ProcessManager();
  let processCapacity: { at: number; value: ReturnType<typeof machineReport> } | undefined;
  const checkpoints = new WorkspaceCheckpoints({
    workspaceRoot: config.WORKSPACE_ROOT,
    btrfsExecutable: config.CHECKPOINT_BTRFS_EXECUTABLE,
    zfsExecutable: config.CHECKPOINT_ZFS_EXECUTABLE,
    packageManifestPath: config.CHECKPOINT_PACKAGE_MANIFEST,
    includeBrowserProfile: config.CHECKPOINT_INCLUDE_BROWSER_PROFILE,
    retainTurns: config.CHECKPOINT_RETAIN_TURNS,
    retainDailyDays: config.CHECKPOINT_RETAIN_DAILY_DAYS,
    maxFiles: config.CHECKPOINT_MAX_FILES,
    maxFileBytes: config.CHECKPOINT_MAX_FILE_BYTES,
    hostStorage: probeHostStorage
  });
  const authenticate = authenticateRunnerRequest(config.RUNNER_SHARED_SECRET);
  /*
   * The renewal frames this runner has already spent.
   *
   * SECURITY.md says a capability is single-use, and on the HTTP path it is: every verified request
   * leaves its nonce in `authenticateRunnerRequest`'s ledger. A terminal renewal arrives inside an
   * already-open socket, so it never goes through that hook - and so one renewal frame, captured
   * off the wire, could be replayed for its whole lifetime, to that socket and to every other
   * terminal the same owner had open. This is the ledger for that path.
   *
   * Server-wide rather than per-socket on purpose: a per-socket set would still let one captured
   * frame re-arm every open terminal exactly once each. Keyed through `deriveCapabilityNonce` so
   * each entry is 43 characters whatever the token said - the nonce is arbitrary text inside a
   * signed blob, so a ledger bounded only by entry count is not bounded in bytes - and so the
   * ledger holds a name for the credential rather than the credential's own nonce.
   */
  const spentRenewals = new Map<string, number>();
  const spendRenewal = (nonce: string, exp: number): boolean => {
    const key = deriveCapabilityNonce(nonce, config.RUNNER_SHARED_SECRET);
    if (spentRenewals.has(key)) return false;
    if (spentRenewals.size >= 10_000) {
      const now = Math.floor(Date.now() / 1000);
      for (const [spent, expiry] of spentRenewals) if (expiry <= now) spentRenewals.delete(spent);
      if (spentRenewals.size >= 10_000) return false;
    }
    spentRenewals.set(key, exp);
    return true;
  };
  const limits = commandLimits(config, totalmem());
  const limiter = await resolveCommandLimiter(config.RESOURCE_LIMIT_EXECUTABLE);
  // The package helper travels with the guards so the background path can refuse a command that
  // names it. It used to be handed to `execute()` alone, at the exec route, which meant the value
  // existed here and never reached `processes.start`.
  /*
   * `hostStorage` is here because it was not, and the field it fills is the one guard this runner
   * now leans on hardest. `RunnerServerOptions.hostStorage` says it is injected so the disk floor
   * can be exercised without filling a filesystem; it reached the pre-flight write check and the
   * checkpoints, and it did not reach the floor that polls WHILE a command runs on either
   * execution path - so that floor had tests against `execute` and `ProcessManager` directly and
   * no case at all through the routes that call them. Production was never wrong: both paths
   * default to the real probe. What was missing was any way to prove it from the outside, and with
   * the per-file rlimit gone this floor is the whole of what stops a runaway write.
   */
  const guards = {
    limits,
    limiter,
    sandbox,
    systemPackageHelper: config.SYSTEM_PACKAGE_HELPER,
    hostStorage: probeHostStorage
  };
  const codeIntelligence = new CodeIntelligenceManager({
    isolateNetwork: config.ISOLATE_AGENT_NETWORK,
    sandbox,
    limits,
    limiter,
    systemPackages: { mode: 'refused', helper: config.SYSTEM_PACKAGE_HELPER }
  });
  const computations = new ComputationManager(
    config.WORKSPACE_ROOT,
    {
      isolateNetwork: config.ISOLATE_AGENT_NETWORK,
      sandbox,
      limits,
      limiter,
      systemPackages: { mode: 'refused', helper: config.SYSTEM_PACKAGE_HELPER }
    },
    config.MAX_BACKGROUND_SECONDS
  );
  await computations.restore();
  const debuggers = new DebuggerManager(config.WORKSPACE_ROOT, {
    isolateNetwork: config.ISOLATE_AGENT_NETWORK,
    sandbox,
    limits,
    limiter,
    systemPackages: { mode: 'refused', helper: config.SYSTEM_PACKAGE_HELPER }
  });
  await debuggers.restore();
  const missions = new NativeCodingMissions(
    config.WORKSPACE_ROOT,
    Boolean(sandbox?.confineFilesystem && sandbox.processIsolation && sandbox.networkIsolation),
    {
      quiesceWorkspace: async (id) => {
        const root = workspacePath(config.WORKSPACE_ROOT, id);
        freezeMissionWorkspace(root);
        await Promise.all([
          processes.quiesceWorkspace(id),
          computations.quiesceWorkspace(id),
          debuggers.quiesceWorkspace(root),
          codeIntelligence.quiesceWorkspace(root)
        ]);
        await quiesceManagedChildren(root);
      },
      isWorkspaceBusy: async (id) => {
        const root = workspacePath(config.WORKSPACE_ROOT, id);
        return (
          [...terminals.values()].includes(id) ||
          (await processes.isWorkspaceBusy(id)) ||
          computations.isWorkspaceBusy(id) ||
          debuggers.isWorkspaceBusy(root) ||
          codeIntelligence.isWorkspaceBusy(root) ||
          managedWorkspaceBusy(root)
        );
      }
    }
  );
  const reservedPorts = reservedPreviewPorts({
    ports: [config.RUNNER_PORT, ...config.RESERVED_PREVIEW_PORTS]
  });
  if (!limiter && process.platform === 'linux') {
    // Worth saying out loud: on Linux the limiter is expected to exist, and without it a single
    // command can take the memory and the process table the rest of the computer needs.
    runnerLogger.warn('command.limits_unavailable', {
      executable: config.RESOURCE_LIMIT_EXECUTABLE
    });
  }

  /*
   * The services this computer was keeping running, put back before it answers anything.
   *
   * Every other thing the runner holds is per-turn state a restart is allowed to lose. A service is
   * the one thing whose whole promise is that it does not - the unit is `Restart=always`, so a
   * crash used to take every server the agent had started with it and leave the link it handed the
   * owner answering nothing. Awaited rather than fired off: a crashed runner has to stop its own
   * orphans before it starts their replacements, or two copies end up fighting over one port.
   * Services are only ever started by an agent capability, so they resume under the agent's own
   * network isolation setting.
   */
  const resumed = await processes.resume(
    config.WORKSPACE_ROOT,
    config.ISOLATE_AGENT_NETWORK,
    guards
  );
  if (resumed > 0)
    console.info(
      `athanor runner: resumed ${resumed} service(s) this computer was keeping running.`
    );

  /*
   * Snapshots and checkpoints stop long-running commands so nothing writes into the tree while it
   * is being rewritten, and services are commands. Without putting them back, "make a recovery
   * point" would silently take the owner's dashboard down for good - which is the same broken
   * promise as the hour-long timeout, arriving by a different route. The record survives a rewind
   * on purpose: it lives in `.athanor/services.json`, outside both `CHECKPOINT_CONTENT` and the
   * snapshot archive, so restoring yesterday's files cannot un-declare today's service.
   */
  const restoreServices = async (root: string, workspaceId: string): Promise<void> => {
    await processes.resumeWorkspace(root, workspaceId, config.ISOLATE_AGENT_NETWORK, guards);
  };

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(websocket);
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body)
  );
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id ?? randomUUID());
    const message = error instanceof Error ? error.message : 'Workspace runtime request failed';
    // A challenge is the one failure whose answer is a person, so it crosses the wire as data: the
    // worker needs the vendor, the site and the tab to raise it with the owner and to offer them
    // the takeover, and none of that survives being read back out of a sentence.
    if (error instanceof BotWallError) {
      void reply.status(409).send({
        error: { code: 'browser_bot_wall', message, requestId, botWall: error.wall }
      });
      return;
    }
    // A checkpoint refusal carries its reason as a code, because the reader is the worker rather
    // than a person: it decides whether a turn that lost its undo point says so in the
    // conversation, and it used to decide by pattern-matching this service's prose. The two
    // statuses are unchanged - a full disk is 507, an oversized tree is a 400 the caller can act
    // on - so only the name of the failure is new.
    if (error instanceof CheckpointRefusedError) {
      void reply.status(error.code === 'checkpoint_host_disk_full' ? 507 : 400).send({
        error: { code: error.code, message, requestId }
      });
      return;
    }
    // A schema failure, said as a sentence.
    //
    // `ZodError.message` is a getter that returns `JSON.stringify(issues, null, 2)`. That message
    // was forwarded verbatim, rebuilt into the worker's error, written to the task event and
    // rendered in the conversation - so a model that passed `args` as a string put a page of issue
    // objects in front of the owner. This sits ahead of the generic branch so it covers every
    // `.parse()` in the runner rather than the one that was noticed.
    if (error instanceof z.ZodError) {
      void reply.status(400).send({
        error: { code: 'runner_invalid_request', message: sayWhatIsWrong(error), requestId }
      });
      return;
    }
    void reply
      .status(
        error instanceof WorkspaceFileError
          ? error.status
          : message.includes('Capability')
            ? 403
            : message.includes('Storage quota') || message.includes('Host disk')
              ? 507
              : 400
      )
      .send({
        error: { code: 'runner_request_failed', message, requestId }
      });
  });

  /**
   * What the workspace's storage figure counts, and the one directory it deliberately does not.
   *
   * `.home` - the agent's `$HOME` (execution.ts `agentHome`) - is NOT on this list, and that is a
   * decision rather than an omission left over from the move. It is the same answer the released
   * tree gave, where `$HOME` was the container root and `~/.cargo` was `$ROOT/.cargo`, equally
   * uncounted; naming it here is what makes it a decision.
   *
   * WHY NOT: this figure is a walk of every file under each entry, it runs behind the API's
   * five-second metering timeout, and the API's own comment already puts a coding tree at hundreds
   * of milliseconds. A `$HOME` holds toolchain caches - a Rust toolchain alone is 88,021 files, a
   * conda environment routinely 30,000-60,000 - so counting it would add that walk to every
   * metering pass. When such a pass crosses the timeout the whole figure stops updating, including
   * the owner's own files: a cache would cost the owner the number it was added to make accurate.
   * The quota this feeds is also the wrong instrument for it. It gates the owner's uploads, and its
   * remedy is deleting files - but `.home` is in files.ts's `CONTAINER_ONLY`, so the file browser
   * cannot show it and the file routes cannot delete it. The owner would be told to free space in a
   * directory this API gives them no way to reach.
   *
   * WHAT IT COSTS, said plainly: a per-workspace storage limit does not bound what a task writes
   * into its `$HOME`. An agent that fills the disk through `~/.cache` is stopped by the host-disk
   * floor - which counts every byte on the filesystem and is what actually protects the box - and
   * not by this number. `.athanor/browser` IS counted and is also a machine-written cache the owner
   * cannot browse, which is the inconsistency in this list; it stays counted because a browser
   * profile is bounded at tens of megabytes and does not move the walk.
   *
   * WHAT WOULD CHANGE IT: a cheaper measurement. If this becomes a figure the runner keeps as
   * commands write rather than a tree walk per request, the timeout argument goes away and `.home`
   * should be counted - at which point the file routes owe the owner a way to clear it.
   */
  const storageUsage = async (root: string): Promise<number> =>
    (
      await Promise.all(
        ['workspace', '.athanor/artifacts', '.athanor/browser'].map((relative) =>
          workspaceUsage(path.join(root, relative))
        )
      )
    ).reduce((sum, bytes) => sum + bytes, 0);
  // Loopback only, and deliberately says what the sandbox is actually doing: an operator - and a
  // control plane that tells the owner an agent shell is confined - has to be able to check.
  app.get('/healthz', async () => {
    const backgroundWork = await processes.backgroundWork();
    const computationWork = computations.backgroundWork();
    const debuggerWork = debuggers.backgroundWork();
    const projectPreparations = projectUpdates.backgroundPreparations();
    return {
      ok: true,
      service: 'workspace-runner',
      processSupervisor: config.JOB_SUPERVISOR_SOCKET ? 'independent' : 'in_process',
      runnerRestartUnsafeCommands:
        (config.JOB_SUPERVISOR_SOCKET ? 0 : backgroundWork.commands) +
        computationWork.commands +
        debuggerWork.commands +
        projectPreparations,
      agentSandbox: Boolean(sandbox),
      agentNetworkIsolated: config.ISOLATE_AGENT_NETWORK,
      // The rung this box is actually on, not the one its configuration asked for: with no helper
      // there is nothing to apply a ruleset with, and the setting alone would be a claim rather
      // than a fact. `athanor-sandbox check` is where the claim was measured, at install time.
      agentFilesystemConfined: Boolean(sandbox?.confineFilesystem),
      /*
       * What stopping this runner would destroy, published where the update path already reads.
       *
       * `athanor update` - by hand, and unattended in a weekly window - stops athanor.target, which
       * SIGTERMs this runner and ends every background command it holds. Nothing brings one back
       * and nothing records that it existed. The gate that was meant to prevent that reads
       * `athanor_worker_active` from the worker's /metrics, which counts TURNS in flight, and a
       * background command outlives the turn that started it by design - so that gate is
       * structurally blind to exactly the work this box exists for. This process is the only one
       * on the machine that knows, and `/healthz` is the route the update path can already reach:
       * loopback-only, unauthenticated, and curled by scripts/athanor before an update runs, so
       * this adds no surface and needs no credential.
       *
       * THE TWO NAMES ARE LOAD-BEARING. `runner_background_work` in scripts/athanor greps this
       * body for the literals `"backgroundCommands"` and `"backgroundLongestRemainingMs"`, and
       * treats a missing field as "could not tell" rather than as zero. Renaming either one breaks
       * no compile anywhere; it silently turns the stand-down back into a line saying the update
       * cannot tell, and proceeds. That is why the end-to-end case in long-work.test.ts runs the
       * real shell functions, cut out of scripts/athanor at test time, against the real body of
       * this route - a test that called `backgroundWork()` directly would pass either way.
       *
       * A declared service is deliberately not counted, because `resume` brings one back: this
       * number is only the work a restart destroys. `backgroundLongestRemainingMs` is null when
       * nothing is running, and is what lets an update say "the longest has about 6 hours left",
       * which is the sentence that makes an operator wait where a bare count does not.
       */
      missionProcessIsolation: sandbox?.processIsolation === true,
      nativeNetworkIsolation: sandbox?.networkIsolation === true,
      backgroundCommands:
        backgroundWork.commands +
        computationWork.commands +
        debuggerWork.commands +
        projectPreparations,
      projectPreparations,
      backgroundLongestRemainingMs: projectPreparations
        ? null
        : backgroundWork.longestRemainingMs === null &&
            computationWork.longestRemainingMs === null &&
            debuggerWork.longestRemainingMs === null
          ? null
          : Math.max(
              backgroundWork.longestRemainingMs ?? 0,
              computationWork.longestRemainingMs ?? 0,
              debuggerWork.longestRemainingMs ?? 0
            )
    };
  });

  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.url === '/healthz') return;
    await authenticate(request);
  });
  registerCodingMissionRoutes(app, missions);
  const projectWorkspaces = new ProjectWorkspaces(config.WORKSPACE_ROOT, {
    ownedWriters: async (id, taskId) => [
      ...(await processes.taskWriters(id, taskId)),
      ...computations
        .list(id, taskId)
        .filter((session) => ['starting', 'busy'].includes(session.state))
        .map((session) => ({ id: session.sessionId, kind: 'computation' })),
      ...debuggers
        .list(id, taskId)
        .filter((session) =>
          ['initializing', 'configuring', 'running', 'stopped', 'stopping'].includes(session.state)
        )
        .map((session) => ({ id: session.sessionId, kind: 'debugger' }))
    ]
  });
  registerProjectWorkspaceRoutes(app, projectWorkspaces);
  const projectUpdates = new ProjectUpdatesManager(config.WORKSPACE_ROOT, {
    start: async (workspaceId, taskId, command, job) => {
      if (!sandbox?.confineFilesystem || !sandbox.processIsolation || !sandbox.networkIsolation)
        throw new Error(
          'Project checks require measured filesystem, network and process-tree isolation'
        );
      const root = workspacePath(config.WORKSPACE_ROOT, workspaceId);
      await assertHostStorageWrite(root, 0, probeHostStorage);
      return processes.start(
        root,
        workspaceId,
        taskId,
        { executable: command.executable, args: command.args, cwd: command.cwd, job },
        config.MAX_BACKGROUND_SECONDS,
        config.ISOLATE_AGENT_NETWORK,
        { ...guards, superviseProcessTree: true }
      );
    },
    poll: (workspaceId, taskId, sessionId, logs) =>
      processes.action(workspaceId, taskId, sessionId, { action: logs ? 'log' : 'poll' }),
    stop: async (workspaceId, taskId, sessionId) => {
      await processes.action(workspaceId, taskId, sessionId, { action: 'kill' });
    }
  });
  await projectUpdates.restore((error) =>
    app.log.warn({ err: error }, 'Project check status could not be refreshed')
  );
  registerProjectUpdateRoutes(app, projectUpdates);

  app.put<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId', async (request) => {
    requireScope(request, 'workspace.manage');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    await ensureWorkspace(root);
    return { id: request.params.workspaceId, state: 'running', root };
  });

  /**
   * Deleting a workspace takes both accounts, because the tree is split between them on purpose.
   * The runner owns `.athanor` at a mode the agent cannot traverse, which is what keeps an agent
   * away from its own checkpoints; the agent in turn owns whatever its programs left under its
   * home, some of it at modes the runner cannot traverse. `~/.cache` is the everyday case - GLib
   * creates it with an explicit 0700, so neither a umask nor a pre-created parent changes it, and
   * a workspace that had ever opened a GUI program could not be deleted at all.
   *
   * So the agent clears what it owns and the runner finishes. This grants nothing new: the agent
   * could always delete its own files. It is best-effort by design - the pass ends on the first
   * thing the agent may not touch, and the runner's own removal below is what actually decides
   * whether the workspace is gone, and what reports the failure if it is not.
   */
  const clearAgentOwnedFiles = async (root: string): Promise<void> => {
    if (!sandbox) return;
    const invocation = await sandboxedInvocation(
      { executable: '/bin/rm', args: ['-rf', '--', root] },
      { PATH: '/usr/bin:/bin' },
      sandbox,
      false,
      // Deliberately unconfined, and the only `null` in the runner. This command exists to delete
      // the workspace, and a ruleset that admits `workspace/` and nothing above it would let it
      // empty the tree and then refuse to remove the tree - leaving the delete half done and the
      // runner's own `rm` below to report a failure with no cause a reader could see.
      null,
      // Run from the root of the filesystem: the tree it removes is named in full, and the one
      // directory it must not be started in is the one that is going.
      '/'
    );
    await new Promise<void>((resolve) => {
      const child = spawn(invocation.executable, invocation.args, {
        shell: false,
        stdio: 'ignore'
      });
      child.once('error', () => resolve());
      child.once('exit', () => resolve());
    });
  };

  app.delete<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId',
    async (request, reply) => {
      requireScope(request, 'workspace.manage');
      await projectWorkspaces.cancelWorkspace(request.params.workspaceId);
      await browser.close(request.params.workspaceId);
      await desktop.close(request.params.workspaceId);
      // `forget` because the workspace is going: a service must not be restarted into a tree that
      // no longer exists, and the record itself goes with the `.athanor` directory below.
      await computations.stopWorkspace(request.params.workspaceId);
      await debuggers.stopWorkspace(
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId)
      );
      await codeIntelligence.stopWorkspace(
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId)
      );
      await processes.stopWorkspace(request.params.workspaceId, { forget: true });
      await processes.flush();
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await clearAgentOwnedFiles(root);
      await rm(root, { recursive: true, force: true });
      await deleteAllSnapshots(config.WORKSPACE_ROOT, request.params.workspaceId);
      await checkpoints.deleteAll(request.params.workspaceId);
      return reply.status(204).send();
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { snapshotId: string } }>(
    '/v1/workspaces/:workspaceId/snapshots',
    async (request) => {
      requireScope(request, 'workspace.manage');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      await computations.stopWorkspace(request.params.workspaceId);
      await debuggers.stopWorkspace(
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId)
      );
      await codeIntelligence.stopWorkspace(
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId)
      );
      await processes.stopWorkspace(request.params.workspaceId);
      await processes.flush();
      await browser.close(request.params.workspaceId);
      await desktop.close(request.params.workspaceId);
      try {
        return await createSnapshot({
          snapshotExecutable: config.SNAPSHOT_EXECUTABLE,
          workspaceRoot: config.WORKSPACE_ROOT,
          root,
          workspaceId: request.params.workspaceId,
          snapshotId: request.body.snapshotId
        });
      } finally {
        await restoreServices(root, request.params.workspaceId);
      }
    }
  );

  app.delete<{ Params: { workspaceId: string; snapshotId: string } }>(
    '/v1/workspaces/:workspaceId/snapshots/:snapshotId',
    async (request, reply) => {
      requireScope(request, 'workspace.manage');
      await deleteSnapshot({
        workspaceRoot: config.WORKSPACE_ROOT,
        workspaceId: request.params.workspaceId,
        snapshotId: request.params.snapshotId
      });
      return reply.status(204).send();
    }
  );

  app.post<{ Params: { workspaceId: string; snapshotId: string } }>(
    '/v1/workspaces/:workspaceId/snapshots/:snapshotId/restore',
    async (request) => {
      requireScope(request, 'workspace.manage');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      await computations.stopWorkspace(request.params.workspaceId);
      await debuggers.stopWorkspace(
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId)
      );
      await codeIntelligence.stopWorkspace(
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId)
      );
      await processes.stopWorkspace(request.params.workspaceId);
      await processes.flush();
      await browser.close(request.params.workspaceId);
      await desktop.close(request.params.workspaceId);
      // In a `finally`, like the snapshot and checkpoint routes above and below: a restore that
      // throws has still stopped the services, and leaving them down is the worse half of the
      // failure - the owner loses their dashboard as well as their rewind, and nothing brings it
      // back until the runner next restarts.
      try {
        await restoreSnapshot({
          snapshotExecutable: config.SNAPSHOT_EXECUTABLE,
          workspaceRoot: config.WORKSPACE_ROOT,
          root,
          workspaceId: request.params.workspaceId,
          snapshotId: request.params.snapshotId
        });
      } finally {
        await restoreServices(root, request.params.workspaceId);
      }
      return { restored: true };
    }
  );

  // Turn checkpoints are a different, cheaper thing than the named recovery points above: no
  // archive, no headroom for a second copy of the workspace, and one per turn rather than one when
  // the owner asks. They share nothing but the workspace they protect.
  app.post<{
    Params: { workspaceId: string };
    Body: { checkpointId: string; taskId?: string; turn?: number };
  }>('/v1/workspaces/:workspaceId/checkpoints', async (request) => {
    requireScope(request, 'workspace.manage');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    await ensureWorkspace(root);
    const created = await checkpoints.create(request.params.workspaceId, root, {
      checkpointId: request.body.checkpointId,
      taskId: request.body.taskId ?? null,
      turn: request.body.turn ?? 0
    });
    const { deleted } = await checkpoints.prune(request.params.workspaceId);
    return { ...created, pruned: deleted };
  });

  app.get<{ Params: { workspaceId: string; checkpointId: string } }>(
    '/v1/workspaces/:workspaceId/checkpoints/:checkpointId/preview',
    async (request) => {
      requireScope(request, 'workspace.manage');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return checkpoints.preview(request.params.workspaceId, root, request.params.checkpointId);
    }
  );

  app.post<{ Params: { workspaceId: string; checkpointId: string } }>(
    '/v1/workspaces/:workspaceId/checkpoints/:checkpointId/restore',
    async (request) => {
      requireScope(request, 'workspace.manage');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      // Long-running commands are stopped because a build writing into the tree mid-restore would
      // leave a mixture of both states. The browser and the desktop are deliberately left running:
      // their profiles are outside what a checkpoint covers, so a rewind cannot disturb them.
      await computations.stopWorkspace(request.params.workspaceId);
      await debuggers.stopWorkspace(
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId)
      );
      await codeIntelligence.stopWorkspace(
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId)
      );
      await processes.stopWorkspace(request.params.workspaceId);
      await processes.flush();
      try {
        return await checkpoints.restore(
          request.params.workspaceId,
          root,
          request.params.checkpointId
        );
      } finally {
        await restoreServices(root, request.params.workspaceId);
      }
    }
  );

  /*
   * There is no `GET /checkpoints` and no `DELETE /checkpoints/:id`, and that is deliberate.
   *
   * Both were written, tested here, and never called. The worker reads the checkpoint rows from
   * the database, which is where the rewind dialog gets its list; the runner's own view of the
   * same set never left this file. Deletion is not a thing anyone asks for one at a time either:
   * `create` prunes on the retention policy, and deleting the workspace takes the rest through
   * `deleteAll`. Two authenticated routes that reached the checkpoint store on behalf of nobody
   * are two more ways in than this computer needs.
   */

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/exec',
    async (request, reply) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      // Every byte a command writes used to bypass the disk guard, which only covered the file
      // upload route. Refusing to start is the cheap half; execute() also watches the floor while
      // the command runs, because a command that fills the disk does it after this check.
      await assertHostStorageWrite(root, 0, probeHostStorage);
      const deferred = z
        .object({
          yieldAfterMs: z.number().int().min(0).max(5000).optional(),
          service: z.unknown().optional()
        })
        .passthrough()
        .parse(request.body);
      if (
        deferred.yieldAfterMs !== undefined &&
        request.capability.role === 'agent' &&
        !request.capability.scopes.includes('system.packages')
      ) {
        if (deferred.service !== undefined) throw new Error('A service requires background=true');
        return processes.start(
          root,
          request.params.workspaceId,
          request.capability.sub,
          { ...deferred, job: 'Command' },
          config.MAX_BACKGROUND_SECONDS,
          config.ISOLATE_AGENT_NETWORK,
          guards
        );
      }
      // A worker that abandons the request has been cancelled or has died. Either way nobody will
      // ever read this command's result, so it must not keep running - and keep acting on the box.
      const disconnected = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) disconnected.abort();
      });
      return execute(root, request.body, {
        maximumSeconds: config.MAX_EXECUTION_SECONDS,
        isolateNetwork: request.capability.role === 'agent' && config.ISOLATE_AGENT_NETWORK,
        allowSystemPackages: request.capability.scopes.includes('system.packages'),
        systemPackageHelper: config.SYSTEM_PACKAGE_HELPER,
        sandbox,
        abortSignal: disconnected.signal,
        guards
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/processes/start',
    async (request) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      await assertHostStorageWrite(root, 0, probeHostStorage);
      return processes.start(
        root,
        request.params.workspaceId,
        request.capability.sub,
        request.body,
        // The background ceiling, not the foreground one. This route held an HTTP request open for
        // no part of the command's run and was capped at the same hour as the route that does.
        config.MAX_BACKGROUND_SECONDS,
        request.capability.role === 'agent' && config.ISOLATE_AGENT_NETWORK,
        guards
      );
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/processes',
    async (request) => {
      requireScope(request, 'exec');
      // Who is asking decides how wide the answer is. An agent is subject to its own task and sees
      // the sessions that task started plus every DECLARED SERVICE in the workspace, because a
      // service is named precisely so it outlives the task - narrowing those to the declaring task
      // made a service invisible to every later turn the moment it became durable. Ordinary
      // background commands stay task-private, which is what keeps one turn out of another's. A
      // person driving their own computer - or the API asking on their behalf - is asking what the
      // machine is doing, and every background process on it is part of that answer.
      /*
       * WHICH PORTS ARE OPEN, beside what is running.
       *
       * The approval card for a service is answered from the command, before the process exists,
       * and the commonest way to open a public port states no address at all: `python3 -m
       * http.server 8096` binds every interface with no flag. So the list of what is running was
       * never the whole answer to "what is my computer doing" - a service could be reachable from
       * the internet and every field here would look identical to one reachable only by this box.
       *
       * Box-level and named for it. Where `/proc/<pid>` is hidden from the runner, which is how
       * athanor ships, the uid on a socket is the only attribution available, so this says that an
       * agent-owned process holds the port and not which one. Omitted entirely when nothing could
       * be read, because an empty list would claim the machine has nothing open.
       */
      await processes.refreshResources();
      if (!processCapacity || Date.now() - processCapacity.at >= PROCESS_SAMPLE_MS)
        processCapacity = {
          at: Date.now(),
          value: machineReport({
            root: config.WORKSPACE_ROOT,
            commandMemoryBytes: limits.memoryBytes,
            readCgroupLimits: options.cgroup
          })
        };
      const capacity = await processCapacity.value;
      const listeners = await processes.observedAgentListeners();
      const reachable = (listeners ?? []).filter(
        (socket) => reachOfBindAddress(socket.address) !== 'self'
      );
      return {
        observedAt: new Date().toISOString(),
        refreshAfterMs: PROCESS_SAMPLE_MS,
        resourcesAvailable: await processes.resourcesAvailable(),
        host: {
          logicalCpus: capacity.cores,
          memoryBytes: totalmem(),
          commandMemoryLimitBytes: limiter ? capacity.memoryBytes : null
        },
        processes:
          request.capability.role === 'agent'
            ? await processes.list(request.params.workspaceId, request.capability.sub)
            : await processes.listWorkspace(request.params.workspaceId),
        ...(listeners === undefined
          ? {}
          : { agentListeners: listeners.map((socket) => `${socket.address}:${socket.port}`) }),
        ...(reachable.length === 0
          ? {}
          : {
              reachableFromOutsideThisComputer: reachable.map(
                (socket) => `${socket.address}:${socket.port}`
              ),
              note: `Anyone who can reach this computer on ${reachable
                .map((socket) => String(socket.port))
                .join(
                  ', '
                )} can reach what is served there. A port meant to stay private binds 127.0.0.1, which is what publish_preview proxies to.`
            })
      };
    }
  );

  /*
   * The Stop button reaching the background.
   *
   * Cancelling a task aborts the runner request in flight, and `processes/start` has none: it
   * answered in milliseconds and left its child running for the rest of its hour. Nothing in the
   * worker, the API or this runner ended those sessions, so a cancelled task went on writing into
   * the workspace and making requests attributed to this computer while the interface said it had
   * stopped. Declared services are exempt on purpose - that is what declaring one means - and the
   * answer names them so the confirmation the owner reads can say which things are still up.
   *
   * A static segment outranks `:sessionId` below in the router whichever order they are declared
   * in, and no session id can collide with it in any case: they are minted as `proc_`/`svc_` plus
   * a uuid.
   */
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/processes/stop-owner',
    async (request) => {
      requireScope(request, 'exec');
      const computationOwner =
        request.capability.role === 'agent'
          ? request.capability.sub
          : z.object({ owner: z.string().min(1) }).parse(request.body).owner;
      await computations.stopOwner(request.params.workspaceId, computationOwner);
      await debuggers.stopOwner(request.params.workspaceId, computationOwner);
      return processes.stopOwner(
        request.params.workspaceId,
        // The same split the list and action routes make: an agent may only ever stop what its own
        // task started, and the person driving the computer names the task they mean.
        request.capability.role === 'agent' ? request.capability.sub : null,
        request.body
      );
    }
  );

  app.get<{ Params: { workspaceId: string; sessionId: string } }>(
    '/v1/workspaces/:workspaceId/processes/:sessionId/recovery',
    async (request) => {
      requireScope(request, 'exec');
      return processes.recoveryPlan(
        request.params.workspaceId,
        request.capability.role === 'agent' ? request.capability.sub : null,
        request.params.sessionId
      );
    }
  );

  app.post<{ Params: { workspaceId: string; sessionId: string } }>(
    '/v1/workspaces/:workspaceId/processes/:sessionId/resume',
    async (request) => {
      requireScope(request, 'exec');
      return processes.resumeJob(
        request.params.workspaceId,
        request.capability.role === 'agent' ? request.capability.sub : null,
        request.params.sessionId
      );
    }
  );

  app.post<{ Params: { workspaceId: string; sessionId: string } }>(
    '/v1/workspaces/:workspaceId/processes/:sessionId',
    async (request) => {
      requireScope(request, 'exec');
      return processes.action(
        request.params.workspaceId,
        // The same split the list above makes, for the same reason - and it matters more here.
        // A service outlives the task that started it, so a subject-scoped kill meant the owner
        // could see a service in their panel with no way on this computer to stop it.
        request.capability.role === 'agent' ? request.capability.sub : null,
        request.params.sessionId,
        request.body
      );
    }
  );

  registerFileDownloadRoutes(app, config);
  registerCodeIntelligenceRoutes(app, config.WORKSPACE_ROOT, codeIntelligence);
  registerComputationRoutes(app, computations);
  registerDebuggerRoutes(app, debuggers);

  app.get<{ Params: { workspaceId: string }; Querystring: { path?: string } }>(
    '/v1/workspaces/:workspaceId/files',
    async (request) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return { entries: await listFiles(root, assertUserDataPath(root, request.query.path)) };
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/usage',
    async (request) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      const storageBytes = await storageUsage(root);
      return { storageBytes, ...(await probeHostStorage(root)) };
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/export',
    async (request, reply) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      const archive = spawn(
        config.TAR_EXECUTABLE,
        [
          '--create',
          '--gzip',
          '--file=-',
          '--format=pax',
          '--numeric-owner',
          '--directory',
          root,
          'workspace',
          '.athanor/artifacts'
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], shell: false }
      );
      archive.once('error', (error) => archive.stdout.destroy(error));
      archive.once('exit', (code) => {
        if (code !== 0) archive.stdout.destroy(new Error('Workspace archive process failed'));
      });
      reply.raw.once('close', () => {
        if (!archive.killed) archive.kill('SIGTERM');
      });
      return reply
        .type('application/gzip')
        .header('cache-control', 'private, no-store')
        .header(
          'content-disposition',
          `attachment; filename="athanor-workspace-${request.params.workspaceId}.tar.gz"`
        )
        .send(archive.stdout);
    }
  );

  app.get<{
    Params: { workspaceId: string };
    Querystring: {
      path: string;
      startLine?: string;
      endLine?: string;
      maxBytes?: string;
      displayBytes?: string;
      displayLines?: string;
    };
  }>('/v1/workspaces/:workspaceId/file', async (request, reply) => {
    requireScope(request, 'files.read');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    const requestedPath = assertUserDataPath(root, request.query.path);
    // A caller that names a budget is asking for a window rather than the file, and gets it without
    // the file being read. The ceiling is the same one an unbounded read has, so asking for a
    // window can never cost the runner more than asking for everything already could.
    const maxBytes = positiveQueryInteger(request.query.maxBytes);
    /*
     * A caller that names a DISPLAY budget is saying the bytes it gets back are going in front of a
     * model, which is the one thing that makes a read count as having shown anything. It gets the
     * prefix that fits and the whole file's hash, and that prefix is recorded as seen - so the two
     * records of what the model has been shown, this one and the worker's, are the same bytes rather
     * than two computations that agree until one of them changes.
     */
    const displayBytes = positiveQueryInteger(request.query.displayBytes);
    const displayLines = positiveQueryInteger(request.query.displayLines);
    /*
     * WHO is being shown this, taken off the signed capability rather than from anything the caller
     * chose to send. A record is about one task's context window, so a read is only evidence for the
     * task that made it; `sub` is the task the worker minted the token for, and the code running
     * inside that task cannot set it.
     *
     * `undefined` for the owner in the Files pane and for `control`, which means no record at all -
     * see `readerFor`. Neither is ever held to what it was shown, so a record filed under either
     * could never be read back by anybody, and would only crowd out the ones that are load-bearing.
     */
    const shownTo = readerFor(request.capability);
    try {
      if (maxBytes !== undefined) {
        const window = await readWorkspaceFileLines(root, requestedPath, {
          startLine: positiveQueryInteger(request.query.startLine) ?? 1,
          endLine: positiveQueryInteger(request.query.endLine) ?? Number.MAX_SAFE_INTEGER,
          maxBytes: Math.min(maxBytes, config.MAX_FILE_BYTES),
          shownTo
        });
        reply.headers({
          'x-start-line': String(window.startLine),
          'x-end-line': String(window.endLine),
          'x-file-bytes': String(window.sizeBytes),
          'x-truncated': String(window.truncated),
          // Whether the last row of the body is half a line. `x-truncated` says the window ended
          // early and does not say which of the two ways, and the caller's record of what it
          // displayed turns on exactly that.
          'x-partial-line': String(window.partialLine),
          ...(window.totalLines === undefined
            ? {}
            : { 'x-total-lines': String(window.totalLines) }),
          ...(window.nextStartLine === undefined
            ? {}
            : { 'x-next-start-line': String(window.nextStartLine) })
        });
        return reply.type(contentTypeFor(requestedPath)).send(window.content);
      }
      const file = await readWorkspaceFile(
        root,
        requestedPath,
        config.MAX_FILE_BYTES,
        displayBytes !== undefined && displayLines !== undefined
          ? {
              maxBytes: Math.min(displayBytes, config.MAX_FILE_BYTES),
              maxLines: displayLines,
              shownTo
            }
          : undefined
      );
      reply.header('x-content-sha256', file.sha256);
      if (file.totalLines !== undefined)
        reply.headers({
          'x-total-lines': String(file.totalLines),
          'x-display-lines': String(file.displayedLines ?? 0),
          'x-partial-line': String(file.partialLine === true)
        });
      return reply.type(contentTypeFor(requestedPath)).send(file.content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return reply.status(404).send({
          error: { code: 'file_not_found', message: 'Workspace file not found' }
        });
      throw error;
    }
  });

  /**
   * One picture, in a form a model will take.
   *
   * This is not the file endpoint with a filter on it. The file endpoint answers with what is on
   * disk, which is the right answer for a download and the wrong one for a request that is about to
   * be built: a phone photograph is HEIC, and every route the gateway can reach refuses HEIC. The
   * conversion belongs here because this is the process with the image toolchain and the file, and
   * because doing it anywhere else means sending a picture in order to learn it was not accepted -
   * a failure that arrives from a provider, minutes later, naming a coder rather than the photo the
   * owner attached.
   *
   * Every picture goes through it, including the four a model would have taken as they are. That
   * pass is also the only thing that takes the camera's own notes off a photograph, and a picture
   * shown to a model is a picture leaving this computer, so the one exit is the one place the
   * coordinates come off.
   */
  app.get<{ Params: { workspaceId: string }; Querystring: { path: string } }>(
    '/v1/workspaces/:workspaceId/image',
    async (request, reply) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      const requestedPath = assertUserDataPath(root, request.query.path);
      const declared = contentTypeFor(requestedPath);
      if (conversionTargetFor(declared) === undefined)
        throw new WorkspaceFileError(
          `${path.basename(requestedPath)} is not a picture. Read it with file_read or document_read instead.`,
          415
        );
      let source;
      try {
        source = await readWorkspaceFile(
          root,
          requestedPath,
          Math.min(config.MAX_FILE_BYTES, IMAGE_SOURCE_MAX_BYTES)
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return reply
            .status(404)
            .send({ error: { code: 'file_not_found', message: 'Workspace file not found' } });
        throw error;
      }
      const picture = await convertImageForModel(
        config.IMAGE_CONVERT_EXECUTABLE,
        declared,
        source.content
      );
      // Said on the wire rather than inferred from the type, because the two facts differ: a JPEG
      // answered as a JPEG has still been re-encoded, and the turn that looks at it is entitled to
      // know it is not seeing the pixels the file holds.
      return reply
        .type(picture.mimeType)
        .header('x-image-source-type', declared)
        .send(picture.content);
    }
  );

  app.put<{
    Params: { workspaceId: string };
    Querystring: { path: string; expectSha256?: string };
  }>('/v1/workspaces/:workspaceId/file', async (request) => {
    requireScope(request, 'files.write');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    await ensureWorkspace(root);
    const requestedPath = assertUserDataPath(root, request.query.path);
    const body = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
    await assertHostStorageWrite(root, body.length, probeHostStorage);
    // The caller's claim about what it is replacing, checked under the write's own descriptor.
    const expected = (request.query.expectSha256 ?? '').trim();
    /*
     * WHICH agent is held to what IT has been shown, taken off the signed capability rather than
     * from the body or a query parameter, so it is not something a caller can decide about itself.
     * The same value the read arm above records under: one task, one record, and a token minted for
     * task A cannot ask about task B's reads because `sub` is what it is signed over.
     *
     * The role alone used to be the whole of it, which said held-or-not and never said who - so with
     * two tasks in one workspace the guard held the second one to the first one's reads. The agent's
     * windowed read also has no whole-file digest to claim, so before that the guard was skipped on
     * exactly the shape that needed it most; the owner's save from the Files pane and an upload
     * landing on a name still arrive unclaimed and stay unguarded, because neither of them said it
     * had read anything.
     */
    return writeWorkspaceFile(
      root,
      requestedPath,
      body,
      config.MAX_FILE_BYTES,
      expected || undefined,
      readerFor(request.capability)
    );
  });

  app.delete<{ Params: { workspaceId: string }; Querystring: { path: string } }>(
    '/v1/workspaces/:workspaceId/file',
    async (request, reply) => {
      requireScope(request, 'files.write');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await deleteWorkspaceFile(root, assertUserDataPath(root, request.query.path));
      return reply.status(204).send();
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { path?: unknown } }>(
    '/v1/workspaces/:workspaceId/files/folder',
    async (request) => {
      requireScope(request, 'files.write');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      const requested = FolderRequest.parse(request.body);
      return createWorkspaceFolder(root, assertUserDataPath(root, requested.path));
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { from?: unknown; to?: unknown } }>(
    '/v1/workspaces/:workspaceId/files/rename',
    async (request) => {
      requireScope(request, 'files.write');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      const requested = RenameRequest.parse(request.body);
      return renameWorkspaceEntry(
        root,
        assertUserDataPath(root, requested.from),
        assertUserDataPath(root, requested.to)
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/audio/source',
    async (request, reply) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      const asked = z.object({ path: WorkspaceRelativePath }).strict().parse(request.body);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const closed = () => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', closed);
      if (request.raw.aborted || reply.raw.destroyed) abort();
      try {
        return await inspectAudioSource(
          root,
          assertUserDataPath(root, asked.path),
          controller.signal
        );
      } finally {
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', closed);
      }
    }
  );

  /**
   * One window of a recording, measured and re-encoded small enough to be transcribed.
   *
   * The bytes come back as the body and everything the caller needs to price and describe the job
   * comes back as headers, for the same reason the windowed file read above answers that way: the
   * audio is the payload and the measurements are about it. `files.read` is the right scope because
   * that is all this does - it reads a file the owner already has and writes nothing.
   */
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/audio/prepare',
    async (request, reply) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      const asked = PrepareAudioRequest.parse(request.body);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const closed = () => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', closed);
      if (request.raw.aborted || reply.raw.destroyed) abort();
      try {
        const prepared = await prepareAudio(
          root,
          assertUserDataPath(root, asked.path),
          asked,
          undefined,
          controller.signal
        );
        reply.headers({
          'x-audio-format': prepared.format,
          ...(prepared.sourceReceipt
            ? {
                'x-audio-source-sha256': prepared.sourceReceipt.sourceSha256,
                'x-audio-source-bytes': String(prepared.sourceReceipt.sourceBytes)
              }
            : {}),
          'x-audio-start-seconds': String(prepared.startSeconds),
          'x-audio-prepared-seconds': String(Math.round(prepared.preparedSeconds)),
          'x-audio-more': String(prepared.more),
          ...(prepared.source.durationSeconds === null
            ? {}
            : { 'x-audio-duration-seconds': String(Math.round(prepared.source.durationSeconds)) }),
          ...(prepared.source.container ? { 'x-audio-container': prepared.source.container } : {}),
          ...(prepared.source.codec ? { 'x-audio-codec': prepared.source.codec } : {})
        });
        return reply.type('audio/ogg').send(prepared.bytes);
      } finally {
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', closed);
      }
    }
  );

  // What this computer can actually do with documents, probed rather than assumed. A procedure
  // that names a binary the box does not have is worse than no procedure at all, so this is the
  // route that lets the agent find out before it starts instead of one failed call at a time.
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/toolchain',
    async (request) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return toolchainReport(root);
    }
  );

  /**
   * What machine this is, in the three numbers that decide how a job is sized.
   *
   * Same shape and same failure story as the two probes below it - a property of the machine that
   * the process on the other end of the wire cannot see - and the same trade: a runner that cannot
   * answer costs the runtime block one line and nothing else.
   *
   * It is answered HERE, in the process the control group actually holds, and that is the whole
   * reason it is a route rather than an `os` call in the worker. The worker is a different unit
   * with a different cgroup; `apps/worker` reading `availableParallelism()` would describe its own
   * allowance and label it the agent's. @see machineReport, which reads the ceilings this unit is
   * under and never the hardware beneath them.
   */
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/machine',
    async (request) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return machineReport({
        root,
        // The rlimit this runner actually applies to every agent command, not a second derivation
        // of it: `guards.limits` is the object `commandLimitArguments` builds `--data=` from.
        commandMemoryBytes: limits.memoryBytes,
        // Passed straight through, `undefined` and all. There is no `?? readCgroup` here on
        // purpose: `machineReport` already defaults this to the kernel, and a second default in
        // this file would be a second place the production join could be wrong with no case able
        // to see it - which is what it was. One default, in the module that owns the kernel.
        readCgroupLimits: options.cgroup,
        storage: probeHostStorage
      });
    }
  );

  /**
   * What surfaces this box has, beside what it can do with documents.
   *
   * Same shape, same scope and same failure story as the toolchain route above, because it answers
   * the same kind of question: a property of the machine that the process on the other end of the
   * wire cannot see. The difference is what it buys. The toolchain report changes a paragraph of
   * prose; this one decides whether seven tool schemas - the two largest bags in the catalogue -
   * are described to the model on every request of every turn. @see workspaceSurfaces.
   */
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/surfaces',
    async (request) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return workspaceSurfaces({
        root,
        browserExecutablePath: config.BROWSER_EXECUTABLE_PATH,
        desktopBridgeExecutable: config.DESKTOP_BRIDGE_EXECUTABLE,
        desktopSessionExecutable: config.DESKTOP_SESSION_EXECUTABLE
      });
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { binaries?: unknown } }>(
    '/v1/workspaces/:workspaceId/toolchain/probe',
    async (request) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      const requested = BinaryProbeRequest.parse(request.body);
      const present = await probeBinaries(root, requested.binaries);
      return {
        present: requested.binaries.filter((name) => present.has(name)),
        missing: requested.binaries.filter((name) => !present.has(name))
      };
    }
  );

  /**
   * How a generated document actually renders, for an acceptance check the harness runs itself.
   *
   * This is the one measurement of a visual deliverable that the model does not make about its own
   * work. It renders the file as it stands - not a proof PDF left over from earlier in the turn -
   * counts its pages and reports every word the render had to cut at an edge, and it refuses rather
   * than reassures when the toolchain to do that is not on this computer.
   */
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/document/render-proof',
    async (request, reply) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      const requested = RenderProofRequest.parse(request.body);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const closed = () => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.once('aborted', abort);
      reply.raw.once('close', closed);
      if (request.raw.aborted || reply.raw.destroyed) abort();
      try {
        return await proveRender(
          root,
          {
            path: assertUserDataPath(root, requested.path),
            deadlineAt: requested.deadlineAt,
            expectPages: requested.expectPages,
            marginPoints: requested.marginPoints
          },
          await findRenderTools(root),
          Math.min(config.MAX_FILE_BYTES, RENDER_SOURCE_MAX_BYTES),
          controller.signal
        );
      } finally {
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', closed);
      }
    }
  );

  const previewRoute = '/v1/workspaces/:workspaceId/preview/:port/*';
  app.get<{ Params: { workspaceId: string; port: string } }>(
    '/v1/workspaces/:workspaceId/preview-check/:port',
    async (request) => {
      const port = previewPort(request.params.port, reservedPorts);
      requireScope(request, `preview:${port}`);
      return { port, available: await checkPreviewPort(port, reservedPorts) };
    }
  );
  const proxyPreview = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { workspaceId: string; port: string; '*': string };
    const port = previewPort(params.port, reservedPorts);
    requireScope(request, `preview:${port}`);
    const target = previewTarget(port, params['*'], request.raw.url ?? '/', reservedPorts);
    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : Buffer.isBuffer(request.body)
        ? request.body
        : request.body === undefined
          ? undefined
          : Buffer.from(
              typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
            );
    let response: Response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers: previewRequestHeaders(request.headers),
        ...(body ? { body: Uint8Array.from(body).buffer } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000)
      });
    } catch {
      /*
       * A page, because a person is looking at it.
       *
       * Everything else this service answers is read by the worker, so JSON is right for it - but
       * these bytes go through the preview gateway to a browser, unchanged. The owner opened the
       * link they were given and got `{"error":{"code":"preview_unavailable",…}}` rendered as text.
       * The gateway's own two failure pages are HTML for exactly this reason; this one was the odd
       * one out because it is raised a layer further down.
       */
      return reply
        .status(502)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><title>Nothing is listening</title><h1>Nothing is listening</h1><p>The app on port ${port} is not answering. It may have stopped, or never started - ask athanor to start it again.</p>`
        );
    }
    reply.status(response.status);
    const cookies: string[] = [];
    /*
     * `fetch` hands back a *decoded* body while leaving the upstream's own `content-encoding` in
     * the headers - measured, not assumed: an upstream answering `content-encoding: gzip` with 53
     * bytes yields a 6 000-byte body here and a header still saying gzip. Forwarding that pair
     * tells the browser to inflate plaintext, which is `ERR_CONTENT_DECODING_FAILED` on every
     * preview of a dev server that compresses. The header is dropped here rather than in
     * `previewResponseHeaders` because the decoding is done by this file, so the header that
     * describes it is this file's to withdraw.
     */
    const encoding = response.headers.get('content-encoding');
    for (const [name, value] of previewResponseHeaders(response.headers)) {
      if (name.toLowerCase() === 'set-cookie') cookies.push(value);
      else if (name.toLowerCase() !== 'content-encoding') reply.header(name, value);
    }
    if (cookies.length) reply.header('set-cookie', cookies);
    if (request.method === 'HEAD' || !response.body) return reply.send();
    /*
     * Streamed, not buffered. `Buffer.from(await response.arrayBuffer())` held the entire response
     * in the runner's heap before a byte of it moved: a preview of a dev server serving a 400 MB
     * video, or an artifact download, was a 400 MB allocation in the process that also runs every
     * agent's tools, and the owner saw nothing until the last byte had arrived.
     *
     * `content-length` is only forwarded when there was nothing to decode, because that is the one
     * case where the upstream's count still describes the bytes leaving here; `previewResponseHeaders`
     * strips it unconditionally, which is right for the request direction and too blunt for this one.
     */
    if (!encoding) {
      const length = response.headers.get('content-length');
      if (length) reply.header('content-length', length);
    }
    // `fetch`'s body is typed as the DOM `ReadableStream`; `Readable.fromWeb` wants the
    // `node:stream/web` one. They are the same object at run time - Node's fetch returns exactly
    // this - and the two declarations differ only in whether they carry the async iterator.
    return reply.send(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>));
  };
  const proxyPreviewSocket = (socket: WebSocket, request: FastifyRequest) => {
    const params = request.params as { workspaceId: string; port: string; '*': string };
    let port: number;
    try {
      port = previewPort(params.port, reservedPorts);
      requireScope(request, `preview:${port}`);
    } catch {
      socket.close(1008, 'Preview capability required');
      return;
    }
    const target = previewTarget(port, params['*'], request.raw.url ?? '/', reservedPorts);
    target.protocol = 'ws:';
    const protocols =
      request.headers['sec-websocket-protocol']
        ?.split(',')
        .map((value) => value.trim())
        .filter((value) => value && value !== 'athanor-capability') ?? [];
    const headers = previewRequestHeaders(request.headers);
    const upstream = protocols.length
      ? new WebSocket(target, protocols, { headers })
      : new WebSocket(target, { headers });
    upstream.on('message', (data, binary) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
    });
    upstream.on('close', (code, reason) => socket.close(code, reason.toString()));
    upstream.on('error', () => socket.close(1011, 'Preview service unavailable'));
    socket.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    });
    socket.on('close', () => upstream.close());
  };
  app.route({
    method: 'GET',
    url: previewRoute,
    handler: proxyPreview,
    wsHandler: proxyPreviewSocket
  });
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: previewRoute,
    handler: proxyPreview
  });

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/snapshot',
    async (request) => {
      requireScope(request, 'browser.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return browser.snapshot(
        request.params.workspaceId,
        root,
        request.capability.role === 'user' ? 'user' : 'agent',
        z
          .object({
            offset: z.number().int().nonnegative().optional(),
            sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional()
          })
          .parse(request.body ?? {})
      );
    }
  );

  // Reading the controls of one form without a screenshot, so checking that thirty fields hold
  // what was typed costs thirty cheap reads rather than thirty full snapshots.
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/elements',
    async (request) => {
      requireScope(request, 'browser.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return browser.readElements(
        request.params.workspaceId,
        root,
        ReadElementsRequest.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/print-pdf',
    async (request) => {
      requireScope(request, 'browser.read');
      requireScope(request, 'files.write');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      const input = PrintPdfRequest.parse(request.body);
      await assertHostStorageWrite(root, 0, probeHostStorage);
      return browser.printPdf(
        request.params.workspaceId,
        root,
        input,
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/read-many',
    async (request) => {
      requireScope(request, 'browser.read');
      const input = WebFetchRequest.parse(request.body);
      return browser.readMany(input.urls, input.maxCharactersPerPage);
    }
  );

  // Search as a call rather than as a browsing procedure: the engine's own results page, read on
  // this side, so the model gets ten titles, links and snippets instead of a screenshot of them.
  // It answers from a browser of its own, so unlike every other route here it neither needs the
  // workspace's session browser nor a runtime workspace on disk to have been prepared for it.
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/search',
    async (request) => {
      requireScope(request, 'browser.read');
      return browser.search(
        request.params.workspaceId,
        WebSearchRequest.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/preflight',
    async (request) => {
      requireScope(request, 'browser.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return browser.preflight(
        request.params.workspaceId,
        root,
        BrowserAction.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  registerBrowserActionRoutes(
    app,
    config.WORKSPACE_ROOT,
    browser,
    config.RUNNER_SHARED_SECRET,
    probeHostStorage
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/computer-sessions',
    async (request) => {
      requireScope(request, 'browser.read');
      requireScope(request, 'desktop.read');
      if (request.capability.role !== 'user') throw new Error('Owner session required');
      return {
        browser: browser.sessions(request.params.workspaceId),
        desktop: await desktop.sessions(request.params.workspaceId)
      };
    }
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/handoff-complete',
    async (request) => {
      requireScope(request, 'browser.takeover');
      if (request.capability.role !== 'user') throw new Error('Owner session required');
      const body = z
        .object({ tabId: z.string().max(64).optional(), expectedUrl: z.url().optional() })
        .strict()
        .parse(request.body);
      await browser.completeHandoff(
        request.params.workspaceId,
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId),
        body.tabId,
        body.expectedUrl
      );
      return { ok: true };
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { holder: 'agent' | 'user' | 'secure_input' };
  }>('/v1/workspaces/:workspaceId/browser/holder', async (request) => {
    requireScope(request, 'browser.takeover');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    return browser.setHolder(request.params.workspaceId, root, request.body.holder);
  });

  app.post<{ Params: { workspaceId: string; tabId: string } }>(
    '/v1/workspaces/:workspaceId/browser/tabs/:tabId/retention',
    async (request) => {
      requireScope(request, 'browser.control');
      if (request.capability.role !== 'user')
        throw new Error('Only the owner can retain browser tabs');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      const input = BrowserTabRetentionRequest.parse(request.body);
      return {
        tabs: await browser.retainTab(
          request.params.workspaceId,
          root,
          request.params.tabId,
          input.pinned
        )
      };
    }
  );

  app.get('/v1/workspaces/:workspaceId/browser/stream', { websocket: true }, (socket, request) => {
    requireScope(request, 'browser.read');
    const { workspaceId } = request.params as { workspaceId: string };
    const root = workspacePath(config.WORKSPACE_ROOT, workspaceId);
    let unsubscribe: (() => Promise<void>) | undefined;
    const sendState = (state: BrowserStreamState) => {
      if (socket.readyState === socket.OPEN)
        socket.send(JSON.stringify({ type: 'state', state, protocol: 'chromium-screencast-v1' }));
    };
    const sendError = (requestId: string | undefined, cause: unknown) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: 'control_error',
          ...(requestId ? { requestId } : {}),
          message: cause instanceof Error ? cause.message : 'Browser control failed'
        })
      );
    };
    const expiresIn = Math.max(1, request.capability.exp * 1000 - Date.now());
    const expiry = setTimeout(() => socket.close(1008, 'Capability expired'), expiresIn);
    void ensureWorkspace(root)
      .then(() =>
        browser.subscribeStream(workspaceId, root, {
          state: sendState,
          frame: (frame, state) => {
            if (socket.readyState !== socket.OPEN || socket.bufferedAmount >= 2 * 1024 * 1024)
              return;
            sendState(state);
            socket.send(frame, { binary: true });
          }
        })
      )
      .then((stop) => {
        unsubscribe = stop;
      })
      .catch(() => socket.close(1011, 'Workspace unavailable'));
    socket.on('message', (raw, binary) => {
      if (binary) return;
      void (async () => {
        let message: {
          type?: string;
          requestId?: string;
          holder?: 'agent' | 'user' | 'secure_input';
          action?: unknown;
        } = {};
        try {
          const serialized = Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : raw instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(raw)).toString('utf8')
              : raw.toString('utf8');
          message = JSON.parse(serialized) as typeof message;
          if (message.type === 'holder') {
            requireScope(request, 'browser.takeover');
            if (!['agent', 'user', 'secure_input'].includes(message.holder ?? ''))
              throw new Error('Invalid browser holder');
            await browser.setHolder(workspaceId, root, message.holder!);
          } else if (message.type === 'stroke') {
            requireScope(request, 'browser.control');
            if (request.capability.role !== 'user') throw new Error('Owner session required');
            await browser.ownerStroke(workspaceId, root, OwnerStroke.parse(message.action));
          } else if (message.type === 'action') {
            requireScope(request, 'browser.control');
            await browser.act(workspaceId, root, BrowserAction.parse(message.action), 'user');
          } else throw new Error('Unsupported browser control message');
          if (socket.readyState === socket.OPEN)
            socket.send(JSON.stringify({ type: 'control_ack', requestId: message.requestId }));
        } catch (cause) {
          sendError(message?.requestId, cause);
        }
      })();
    });
    socket.on('close', () => {
      clearTimeout(expiry);
      void unsubscribe?.();
    });
  });

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/snapshot',
    async (request) => {
      requireScope(request, 'desktop.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return desktop.snapshot(
        request.params.workspaceId,
        root,
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/launch',
    async (request) => {
      requireScope(request, 'desktop.control');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return desktop.launch(
        request.params.workspaceId,
        root,
        DesktopLaunchRequest.parse(request.body)
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/preflight',
    async (request) => {
      requireScope(request, 'desktop.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return desktop.preflight(
        request.params.workspaceId,
        root,
        DesktopAction.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/action',
    async (request) => {
      requireScope(request, 'desktop.control');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      return desktop.act(
        request.params.workspaceId,
        root,
        DesktopAction.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent',
        request.capability.scopes.includes('desktop.consequential')
      );
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { holder: 'agent' | 'user' | 'secure_input' };
  }>('/v1/workspaces/:workspaceId/desktop/holder', async (request) => {
    requireScope(request, 'desktop.takeover');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    return desktop.setHolder(
      request.params.workspaceId,
      root,
      DesktopHolder.parse(request.body.holder)
    );
  });

  app.get('/v1/workspaces/:workspaceId/desktop/stream', { websocket: true }, (socket, request) => {
    requireScope(request, 'desktop.read');
    const { workspaceId } = request.params as { workspaceId: string };
    const root = workspacePath(config.WORKSPACE_ROOT, workspaceId);
    let unsubscribe: (() => Promise<void>) | undefined;
    const sendState = (state: DesktopStreamState) => {
      if (socket.readyState === socket.OPEN)
        socket.send(JSON.stringify({ type: 'state', state, protocol: 'desktop-jpeg-v1' }));
    };
    const sendError = (requestId: string | undefined, cause: unknown) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: 'control_error',
          ...(requestId ? { requestId } : {}),
          message: cause instanceof Error ? cause.message : 'Desktop control failed'
        })
      );
    };
    const expiresIn = Math.max(1, request.capability.exp * 1000 - Date.now());
    const expiry = setTimeout(() => socket.close(1008, 'Capability expired'), expiresIn);
    /*
     * What this client can take, which it says in its `hello`. Until it does, it is assumed to
     * have a `VideoDecoder`, because every shipped pane does and the alternative - opening every
     * session in JPEG and upgrading - spends bandwidth on a case that is rare.
     */
    let canDecodeVideo = true;
    void ensureWorkspace(root)
      .then(() =>
        desktop.subscribeStream(workspaceId, root, {
          state: sendState,
          frame: (frame, state) => {
            if (socket.readyState !== socket.OPEN) return;
            sendState(state);
            socket.send(frame, { binary: true });
          },
          /*
           * The congestion signal, which this route used to keep to itself.
           *
           * It had its own rule instead - drop the frame above 2 MiB buffered and tell nobody -
           * and because the runner never saw `bufferedBytes`, `session.congested`, the bounded
           * queue's `starved` flag, the high/low watermark hysteresis and `requestKeyframe()`
           * were all unreachable. The encoder runs an infinite GOP on purpose, so keyframes come
           * only on demand; a dropped delta stranded the client's decoder and no keyframe ever
           * followed. The owner watched a still photograph of the agent's screen, with a healthy
           * socket, no error and no spinner, until they reloaded. Handing the depth over makes
           * the queue and the keyframe request the mechanism, which is what they were written to
           * be - and having two mechanisms is how the drop stayed invisible for so long.
           */
          bufferedBytes: () => socket.bufferedAmount,
          canDecodeVideo: () => canDecodeVideo
        })
      )
      .then((stop) => {
        unsubscribe = stop;
      })
      .catch(() => socket.close(1011, 'Desktop unavailable'));
    socket.on('message', (raw, binary) => {
      if (binary) return;
      void (async () => {
        let message: {
          type?: string;
          requestId?: string;
          holder?: 'agent' | 'user' | 'secure_input';
          action?: unknown;
          canDecodeVideo?: unknown;
          viewport?: unknown;
        } = {};
        try {
          const serialized = Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : raw instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(raw)).toString('utf8')
              : raw.toString('utf8');
          message = JSON.parse(serialized) as typeof message;
          if (message.type === 'holder') {
            requireScope(request, 'desktop.takeover');
            await desktop.setHolder(workspaceId, root, DesktopHolder.parse(message.holder));
          } else if (message.type === 'stroke') {
            requireScope(request, 'desktop.control');
            if (request.capability.role !== 'user') throw new Error('Owner session required');
            await desktop.ownerStroke(workspaceId, root, OwnerStroke.parse(message.action));
          } else if (message.type === 'action') {
            requireScope(request, 'desktop.control');
            await desktop.act(workspaceId, root, DesktopAction.parse(message.action), 'user');
          } else if (message.type === 'hello') {
            // Reading the stream is all this says anything about, so `desktop.read` is the whole
            // gate: a viewer declaring what it can decode is not asking to touch the machine.
            canDecodeVideo = DesktopHello.parse(message).canDecodeVideo;
            await desktop.refreshStream(workspaceId, root);
          } else if (message.type === 'viewport') {
            // The display has been stuck at ATHANOR_BOOT_RES since it was written: `resize` had
            // exactly one caller, `subscribeStream`'s optional viewport, which no route ever set.
            // A pane that is not 1280x800 was therefore either letterboxed or scaled, and a human
            // being asked to click accurately on a scaled image is the one case the geometry code
            // says out loud it will not accept.
            await desktop.resize(workspaceId, root, DesktopViewport.parse(message.viewport));
          } else throw new Error('Unsupported desktop control message');
          if (socket.readyState === socket.OPEN)
            socket.send(JSON.stringify({ type: 'control_ack', requestId: message.requestId }));
        } catch (cause) {
          sendError(message?.requestId, cause);
        }
      })();
    });
    socket.on('close', () => {
      clearTimeout(expiry);
      void unsubscribe?.();
    });
  });

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/hibernate',
    async (request) => {
      requireScope(request, 'workspace.manage');
      // Including the background work, which this used to leave running. A hibernated computer that
      // still holds a build and three servers is not asleep in any sense the owner would recognise,
      // and the panel that reports what is running was reading the control plane's word for it - so
      // the box carried on serving while every screen said nothing was there. Without `forget`: the
      // records stay on disk, and `/resume` below puts them back.
      await computations.stopWorkspace(request.params.workspaceId);
      await debuggers.stopWorkspace(
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId)
      );
      await codeIntelligence.stopWorkspace(
        workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId)
      );
      await processes.stopWorkspace(request.params.workspaceId);
      await processes.flush();
      await browser.close(request.params.workspaceId);
      await desktop.close(request.params.workspaceId);
      return { id: request.params.workspaceId, state: 'hibernated' };
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/resume',
    async (request) => {
      requireScope(request, 'workspace.manage');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureWorkspace(root);
      // The other half of hibernate, and the same call a snapshot or a checkpoint restore makes:
      // waking the computer has to bring back the services the owner left running on it.
      await restoreServices(root, request.params.workspaceId);
      return { id: request.params.workspaceId, state: 'running' };
    }
  );

  // Nothing to do, and nothing that could be done: there is one computer and it is this host, so
  // its capacity is the host's disk and its limits are the host's limits. The stored figure the
  // control plane is bookkeeping here reaches no allocator. Kept because the control plane still
  // calls it; it used to answer with a note calling this the development runner, which on a
  // packaged install is the production one.
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/resize',
    async (request) => {
      requireScope(request, 'workspace.manage');
      return { id: request.params.workspaceId, state: 'running' };
    }
  );

  app.get('/v1/workspaces/:workspaceId/terminal', { websocket: true }, (socket, request) => {
    requireScope(request, 'terminal');
    const { workspaceId } = request.params as { workspaceId: string };
    const root = workspacePath(config.WORKSPACE_ROOT, workspaceId);
    terminals.set(socket, workspaceId);
    // A terminal is a shell on the box, so it may not outlive the capability that opened it. The
    // browser and desktop streams have always closed on expiry; without the same timer here a
    // sixty-second token bought a session that ran until one side hung up, with nothing able to
    // revoke it in between.
    /*
     * Re-armable, so a shell is not cut off mid-command.
     *
     * The timer stays - a shell on the box must remain revocable - but the capability that opened
     * it lives fifteen minutes at most, and a terminal is used for longer than that. Without a way
     * to renew, "may not outlive its capability" meant "dies on a timer while you are typing". The
     * client refreshes shortly before expiry and this re-arms against the new claim.
     */
    const opened = request.capability;
    let expiry: NodeJS.Timeout;
    const armExpiry = (exp: number): void => {
      clearTimeout(expiry);
      expiry = setTimeout(
        () => socket.close(1008, 'Capability expired'),
        Math.max(1, exp * 1000 - Date.now())
      );
    };
    armExpiry(opened.exp);
    /*
     * The shell is born the size the client says its pane is, and nothing sent before it exists is
     * lost.
     *
     * `ensureWorkspace` is a filesystem round trip, and the message handler used to be
     * registered inside its `.then`, so every frame that arrived first was dropped on the floor -
     * including the opening `resize` the client now sends. The pty was therefore always born the
     * hardcoded 120x32 whatever the pane measured; against the ~70 columns a desktop pane actually
     * has, `less`, `vim` and readline redrew in the wrong place for the whole session. Handling
     * messages from here closes that window on the server side: the size is known before the spawn
     * rather than corrected after it, and a keystroke typed into a terminal that has just appeared
     * reaches the shell instead of vanishing.
     */
    let terminal: ReturnType<typeof pty.spawn> | undefined;
    let size = TERMINAL_DEFAULT_SIZE;
    let hungUp = false;
    /*
     * Bounded, because this buffer exists before any shell does. A workspace that is slow to
     * become ready must not let a connected owner - or a stuck client retrying its keystrokes -
     * grow an unbounded string in the runner. Past the cap the oldest input is dropped; a shell
     * that has not started yet has nothing to be mid-command about.
     */
    let typedEarly = '';
    const EARLY_INPUT_LIMIT = 8 * 1024;
    socket.on('message', (raw: unknown) => {
      let message:
        | { type: 'input'; data: string }
        | { type: 'resize'; cols: number; rows: number }
        | { type: 'renew'; token: string };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        // A frame that is not JSON is not a session-ending event; the shell carries on.
        return;
      }
      if (message.type === 'renew') {
        /*
         * A fresh capability for the socket that is already open.
         *
         * Checked against what opened it rather than merely being well-signed: same owner, same
         * workspace, same role, same scope, same audience - `renewalExtendsSession`, which the
         * renewal test now imports instead of restating. A renewal cannot widen anything, and a bad
         * one is ignored, so the session simply closes on the deadline it already had.
         *
         * And spent once. Everything above says what a renewal may be; without the ledger nothing
         * said how many times it may be one, so a single captured frame re-armed this shell - and
         * every other terminal this owner had open - for as long as it lived.
         */
        try {
          const renewed = verifyCapabilityToken(message.token, config.RUNNER_SHARED_SECRET, {
            method: request.method,
            path: request.url
          });
          if (!renewalExtendsSession(renewed, opened))
            throw new Error('Renewal does not match the session it would extend');
          if (!spendRenewal(renewed.nonce, renewed.exp))
            throw new Error('Renewal capability has already been spent');
          armExpiry(renewed.exp);
          socket.send(JSON.stringify({ type: 'renewed', exp: renewed.exp }));
        } catch {
          // Ignored on purpose: the deadline already set stands.
        }
        return;
      }
      if (message.type === 'resize') {
        size = terminalSize(message.cols, message.rows, size);
        terminal?.resize(size.cols, size.rows);
        return;
      }
      // Named rather than assumed: this used to be the `else` of the resize branch, so a frame of
      // any other type reached `resize` with two undefined numbers. Falling through to `write`
      // instead would be worse - a frame the protocol does not define would become keystrokes in
      // the owner's shell - so only a frame that says it is input is ever typed.
      if (message.type !== 'input' || typeof message.data !== 'string') return;
      if (terminal) terminal.write(message.data);
      else typedEarly = (typedEarly + message.data).slice(-EARLY_INPUT_LIMIT);
    });
    // Registered here for the same reason: a socket that hangs up while the workspace is still
    // being prepared used to leave its expiry timer armed and then spawn a shell that nothing held
    // a handle to, so the pty outlived the connection with no way to reach it.
    socket.on('close', () => {
      hungUp = true;
      clearTimeout(expiry);
      terminal?.kill();
      if (!terminal) terminals.delete(socket);
    });
    void ensureWorkspace(root)
      .then(() => {
        if (hungUp) return;
        const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
        const environment = {
          PATH: `${agentSearchPath(root)}${path.delimiter}${process.env.PATH ?? ''}`,
          // The same home the agent's own commands get. Two homes per workspace would mean the
          // owner's terminal and the agent read different `.bashrc` files and different coding-CLI
          // credentials, so signing a CLI in from the terminal would not sign it in for the task.
          HOME: agentHome(root),
          TERM: 'xterm-256color',
          LANG: 'C.UTF-8'
        };
        // The same account and the same one-way privilege drop as every other agent command: a
        // shell here would otherwise be the way around the whole sandbox. Interactive use keeps
        // the network, which is what an owner opening a terminal expects.
        const invocation = sandbox
          ? sandboxedShell({ executable: shell, args: [] }, environment, sandbox)
          : { executable: shell, args: [] };
        terminal = pty.spawn(invocation.executable, invocation.args, {
          name: 'xterm-256color',
          cols: size.cols,
          rows: size.rows,
          cwd: path.join(root, 'workspace'),
          env: sandbox ? {} : environment
        });
        terminal.onData((data) => socket.send(JSON.stringify({ type: 'data', data })));
        terminal.onExit(({ exitCode, signal }) => {
          terminals.delete(socket);
          socket.send(JSON.stringify({ type: 'exit', exitCode, signal }));
          socket.close();
        });
        if (typedEarly) {
          terminal.write(typedEarly);
          typedEarly = '';
        }
      })
      .catch(() => {
        // The workspace could not be prepared, so there will be no shell. Said out loud rather
        // than left as a socket that is open, accepting keystrokes and answering nothing: the
        // pane turns this into its closed state with a way back.
        terminals.delete(socket);
        socket.close(1011, 'Workspace unavailable');
      });
  });

  let sessionSweep: Promise<void> | null = null;
  const sessionTimer = setInterval(() => {
    if (sessionSweep) return;
    sessionSweep = (async () => {
      await browser.retireIdle(
        (id) => config.BROWSER_USE_DESKTOP_DISPLAY && desktop.hasSubscribers(id)
      );
      await desktop.retireIdle((id) => browser.hasSession(id), TAB_IDLE_MS);
    })()
      .catch((error: unknown) => {
        runnerLogger.warn('sessions.retirement_failed', { code: failureCode(error) });
      })
      .finally(() => {
        sessionSweep = null;
      });
  }, TAB_SWEEP_MS);
  sessionTimer.unref();
  app.addHook('onClose', async () => {
    await projectUpdates.close();
    clearInterval(sessionTimer);
    await sessionSweep;
    await computations.close();
    await debuggers.close();
    await codeIntelligence.close();
    await processes.close();
  });
  return app;
};
