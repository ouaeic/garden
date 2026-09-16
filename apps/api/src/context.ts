import type { ModelRelease } from '@athanor/contracts';
/**
 * The API server's context: everything a route needs that is not the route.
 *
 * `server.ts` was one 9,200-line function whose every helper was a closure, which meant a route
 * could not be moved out of it without dragging the whole file along. This module is the seam that
 * makes that move possible: `createApiContext` builds the stores, keys, caches and response
 * builders exactly once, in exactly the order `buildServer` used to build them, and hands back one
 * object. A route group is then a function of that object and nothing else.
 *
 * Two rules keep it honest, and both are why the Wave 5 decomposition was allowed to touch this
 * file at all:
 *
 * - Every body here is the one it replaced, moved and not rewritten. Three edits ride along and
 *   there are no others: the `export` keyword, the three diagnostics helpers taking the state path
 *   they used to close over instead of reading it off the config, and the event-stream counter
 *   becoming a function so it can cross a return boundary. Prettier then rewrapped five lines that
 *   the shallower indentation or the added keyword changed the width of.
 * - Nothing in here decides anything. Policy - who may call, what is refused, what is charged -
 *   stays in the routes, so a reader looking for a rule never has to look here first.
 *
 * The whole surface travels as `ApiContext`, derived from the factory rather than declared beside
 * it. A hand-written interface is a second place to state the same thirty signatures, and this
 * repository has spent four waves removing pairs of facts that drifted apart.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import { sealLegacyOperationResponses } from './http/operation-receipts.js';
import { taskFailure } from './task-failure.js';
import { z } from 'zod';
import type {
  ApiToken,
  Connector,
  MediaModelOption,
  MediaModelSelection,
  SpendLimits,
  TaskPage,
  TaskPlan,
  TaskPlanStep,
  TaskSchedule,
  TaskStatus,
  Workspace,
  WorkspaceCheckpoint,
  WorkspacePreview
} from '@athanor/contracts';
import {
  AthanorError,
  buildConversationNameIndex,
  decryptJson,
  deriveServiceSecret,
  memoryIndexKey,
  reservedPreviewPorts,
  resolveDataMasterKey,
  sha256,
  unwrapDataKey,
  userMemoryKey,
  type ConnectorTransport,
  type MailSocketFactory,
  type OwnerPriceCeiling
} from '@athanor/core';
import {
  assertMasterKeyOpensDatabase,
  createDatabase,
  DataStore,
  migrateDatabase,
  type ApiTokenRecord,
  type ConnectorRecord,
  type TaskRecord,
  type TaskScheduleRecord,
  type WorkspaceCheckpointRecord,
  type WorkspacePreviewRecord,
  type WorkspaceRecord
} from '@athanor/data';
import { connectorHostAllowance } from '@athanor/worker';
import type { ApiConfig } from './config.js';
import { createLogger, errorFields, type Logger } from './log.js';
import { buildPreviewGateway } from './preview-gateway.js';
import { RelaySupervisor } from './relay.js';
import { RunnerClient } from './runner-client.js';

/**
 * A task waits for the user in two different ways and only one of them looks like a pause. A
 * provider quota, a disconnected provider or an unreachable model park the task in
 * `awaiting_resource`, which resumes exactly like `paused` does - so the server states the rule
 * once, here, rather than leaving each client to infer it from the status name.
 */
export const resumableTaskStatuses = ['paused', 'awaiting_resource'] as const;

/**
 * What the standing notice log says in place of a sentence it cannot decrypt.
 *
 * Only reachable when a workspace key will not unwrap - a master key that has been replaced, or a
 * key row lost with its workspace - so it is worded as the fact it is rather than as an apology.
 */
/**
 * The stored spending record as the two published rates, and nothing else.
 *
 * `SpendLimits` still declares the pair optional - see the comment on the schema - while
 * `effectiveSpendLimits` has answered with both since the migration that added the columns. This is
 * the one place that reconciles the two, so no call site has to decide what an absent ceiling means.
 * `??` and not `||`: zero is a ceiling of zero, which admits only a route that publishes no charge,
 * and it is a thing an owner may legitimately want on a box that must never bill.
 */
export const ownerPriceCeiling = (limits: SpendLimits): Required<OwnerPriceCeiling> => ({
  maxInputUsdPerMillionTokens: limits.maxInputUsdPerMillionTokens ?? null,
  maxOutputUsdPerMillionTokens: limits.maxOutputUsdPerMillionTokens ?? null
});

export const UNREADABLE_AGENT_MESSAGE =
  'This notice cannot be read: the workspace key that sealed it no longer opens on this server.';

/** The same fact about a row of the agent's own memory, which is listed rather than skipped. */
export const UNREADABLE_MEMORY_ITEM =
  'This cannot be read: the workspace key that sealed it no longer opens on this server.';

/** Long enough to show the sentence around the match, short enough that twenty are a list. */
export const SEARCH_EXCERPT_CHARS = 280;

export const taskResponse = (
  task: Awaited<ReturnType<DataStore['getTask']>> extends infer T ? NonNullable<T> : never,
  title: string
) => ({
  id: task.id,
  projectId: task.projectId,
  modelOverride: task.modelOverride ?? false,
  workspaceId: task.workspaceId,
  parentTaskId: task.parentTaskId,
  parentMissionId: task.parentMissionId ?? null,
  branchedFromEventId: task.branchedFromEventId,
  forkKind: task.forkKind,
  // What lets a client fold ninety-six watcher runs into one line instead of listing them beside
  // the owner's own conversations in the same recency order.
  scheduleId: task.scheduleId,
  title,
  // The store keeps these as text so a migration can add a value without a type change; the API is
  // the boundary where they become the contract's unions, and every value written comes from one.
  status: task.status as TaskStatus,
  resumable: (resumableTaskStatuses as readonly string[]).includes(task.status),
  modelId: task.modelId,
  reasoningEffort: task.reasoningEffort ?? 'auto',
  ...(task.deliveryStatus === undefined ? {} : { deliveryStatus: task.deliveryStatus }),
  ...(task.pendingDeliveryCount === undefined
    ? {}
    : { pendingDeliveryCount: task.pendingDeliveryCount }),
  privacyRoute: task.privacyRoute as TaskPage['tasks'][number]['privacyRoute'],
  securityMode: task.securityMode,
  maxComputeCredits: task.maxComputeCredits,
  actualComputeCredits: task.actualComputeCredits,
  maxSpendUsd: task.maxSpendUsd,
  spentUsd: task.spentUsd,
  // What tells a money stop from a Pause the owner pressed. Absent on records built by a write
  // that did not select the column, which is not the same claim as "no ceiling stopped this".
  spendPausedAt: task.spendPausedAt ?? null,
  // The end of the run, as opposed to the last time anything about it was written.
  completedAt: task.completedAt ?? null,
  queuedMessageCount: task.queuedMessageCount,
  hasOpenQuestion: task.hasOpenQuestion ?? false,
  shareCount: task.shareCount ?? 0,
  rewind: task.rewindScope ?? null,
  restoredCheckpointId: task.restoredCheckpointId ?? null,
  pinned: task.pinned,
  archivedAt: task.archivedAt,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt
});

/**
 * A scalar rendered as a string, or the fallback when it is not one.
 *
 * Lives beside the response builders because that is what it is for: an encrypted payload that has
 * been opened is `unknown`, and what leaves this process has to be a string whatever came back.
 */
export const textValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : fallback;

/**
 * One work-log line as a client should see it.
 *
 * Event payloads are sealed, so the summary column is a label - `Encrypted status event` - and the
 * sentence a person reads is inside the envelope. Version 1 envelopes carry their own summary and
 * an optional payload; anything else is handed back as it arrived, which is what keeps a
 * conversation written before the envelope existed readable.
 */
export const revealedTaskEvent = (
  summary: string,
  encryptedPayload: unknown
): { summary: string; payload?: unknown } => {
  if (
    encryptedPayload &&
    typeof encryptedPayload === 'object' &&
    (encryptedPayload as { __athanorEventVersion?: unknown }).__athanorEventVersion === 1
  ) {
    const content = encryptedPayload as { summary?: unknown; payload?: unknown };
    return {
      summary: textValue(content.summary, summary),
      ...(content.payload === undefined ? {} : { payload: content.payload })
    };
  }
  return encryptedPayload === undefined ? { summary } : { summary, payload: encryptedPayload };
};

export type HostStorage = {
  hostStorageTotalBytes: number;
  hostStorageAvailableBytes: number;
};

export const checkpointResponse = (checkpoint: WorkspaceCheckpointRecord): WorkspaceCheckpoint => ({
  id: checkpoint.id,
  workspaceId: checkpoint.workspaceId,
  taskId: checkpoint.taskId,
  turn: checkpoint.turn,
  eventSequence: checkpoint.eventSequence,
  mechanism: checkpoint.mechanism,
  fileCount: checkpoint.fileCount,
  totalBytes: checkpoint.totalBytes,
  storedBytes: checkpoint.storedBytes,
  durationMs: checkpoint.durationMs,
  createdAt: checkpoint.createdAt
});

export const workspaceResponse = (
  workspace: WorkspaceRecord,
  hostStorage?: HostStorage | null
): Workspace => ({
  ...(workspace.parentWorkspaceId ? { parentWorkspaceId: workspace.parentWorkspaceId } : {}),
  ...(workspace.projectTaskId ? { projectTaskId: workspace.projectTaskId } : {}),
  id: workspace.id,
  name: workspace.name,
  status: workspace.status as Workspace['status'],
  storageBytes: workspace.storageBytes,
  storageLimitBytes: workspace.storageLimitBytes,
  ...(hostStorage ?? {}),
  imageRevision: workspace.imageRevision,
  region: workspace.region,
  keyProtection: workspace.keyProtection,
  securityMode: workspace.securityMode,
  createdAt: workspace.createdAt,
  updatedAt: workspace.updatedAt
});

/**
 * Every open event stream holds a connection and a safety-net timer, so one account keeps at most
 * this many. Reaching the limit closes the longest-standing one rather than refusing the new one:
 * the newest connection is the device the owner is actually looking at.
 */
export const maxEventStreamsPerUser = 5;

/**
 * How often an open stream re-asks whether the bearer token that opened it is still good.
 *
 * It used to ask on every batch of frames, which is once per timeline write: a streamed reply
 * writes `assistant_delta` in the hundreds, and each of those questions is a query. The window a
 * revoked token keeps reading for goes from one frame to half a minute, against the hours it kept
 * reading for before this connection re-checked at all - the stream is opened once and then lives
 * as long as the task does, so before the check existed, cutting a token off did nothing to the
 * connections already using it.
 */
const execFileAsync = promisify(execFile);

export const STREAM_TOKEN_RECHECK_MS = 30_000;

/**
 * What the runner says about a windowed file read, beyond the bytes.
 *
 * Where the window starts and ends, how big the file is, whether it was cut short and where to
 * resume - plus the digest a whole-file read carries. Declared once because it is needed twice, at
 * two ends of this file that must not drift: the route re-emits them, and CORS has to expose them or
 * a browser cannot read one of them.
 */
export const FILE_WINDOW_HEADERS = [
  'x-start-line',
  'x-end-line',
  'x-file-bytes',
  'x-truncated',
  'x-total-lines',
  'x-next-start-line',
  'x-content-sha256'
] as const;

/**
 * How long a shutdown gives the embedded worker's current turn to land before closing the database
 * anyway. Long enough for the writes that close out a turn, short enough that a restart is a
 * restart rather than a wait for whatever the agent happens to be doing.
 */
export const embeddedWorkerShutdownGraceMs = 5_000;

/** The containers `POST /v1/audio/transcriptions` accepts a voice note in. */
export const TRANSCRIPTION_FORMATS = ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac'] as const;
export type TranscriptionFormat = (typeof TRANSCRIPTION_FORMATS)[number];

/**
 * Binary uploads reach here as a Buffer of up to the 50 MB body limit; serialising one through
 * `JSON.stringify` would expand it into a multi-hundred-megabyte string on every request, so raw
 * bytes are digested directly and tagged so they cannot collide with a JSON body.
 */
export interface ConnectionManifest {
  endpoints: string[];
  identity: string;
  discovery?: { mdnsService?: string; mdnsPort?: number };
}

/**
 * The connection ticket every client knows how to read, and the discovery details it insists on.
 *
 * A client refuses a ticket whose version it does not recognise and one carrying a field it has
 * never heard of, which is what makes this a number rather than a preference: an installer and a
 * server that print different tickets produce a device that cannot be added. The installer writes
 * the same three values - `scripts/athanor` where it prints the first-device ticket, and
 * `scripts/athanor-network-refresh` where it writes the manifest this reads.
 */
/**
 * The provider connection one account's model calls go through, as it is sealed in the database.
 * `modelId` is only meaningful for an endpoint that serves a single model.
 */
export interface InferenceSecret {
  connectionId?: string;
  label?: string;
  catalogDefaults?: {
    contextTokens: number;
    capabilities: ModelRelease['capabilities'];
    modalities: ModelRelease['modalities'];
  };
  provider: 'openrouter' | 'ollama-cloud' | 'openai-compatible';
  baseUrl: string;
  apiKey?: string;
  modelId?: string;
  enforceZeroDataRetention: boolean;
  /**
   * Which model makes an image and which speaks, when the owner has said.
   *
   * Kept in the credential rather than in `OwnerPreferences` because it is a fact about the
   * provider account: the ids only mean anything against the endpoint that lists them, and moving
   * providers should not leave a picker pointing at a model the new account has never heard of.
   * The credential is already re-verified on every provider save, which is the moment that
   * mismatch is caught.
   */
  mediaModels?: MediaModelSelection;
  /**
   * The choice above, already resolved into the concrete route it names, with its price and voice.
   *
   * The worker has no media catalogue and no way to build one: it never talks to a provider except
   * to run the request in front of it, and adding a catalogue fetch to a tool call would put two
   * provider round trips in front of every generated image. So the resolution happens here, where
   * the catalogue already exists, at the moment the owner chooses - and the worker reads a model
   * id, a price and a voice rather than a preference it would have to interpret.
   *
   * It also means an automatic mode settles when it is chosen rather than drifting under the owner
   * between one generation and the next.
   */
  mediaRoutes?: {
    image?: MediaModelOption;
    audio?: MediaModelOption;
    transcription?: MediaModelOption;
    video?: MediaModelOption;
  };
}

export const CONNECTION_TICKET_VERSION = 2;
export const MDNS_SERVICE = '_athanor._tcp.local';
export const MDNS_PORT = 443;

/**
 * Reads the manifest the network watcher maintains on disk. It is regenerated whenever the host's
 * addresses change, so it is read per request rather than cached: a stale endpoint set would send
 * a newly enrolled device to an address the server no longer answers on.
 */
const readConnectionManifest = async (path: string): Promise<ConnectionManifest> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    const endpoints = Array.isArray(record.endpoints)
      ? record.endpoints.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (!endpoints.length || typeof record.identity !== 'string')
      throw new Error('incomplete manifest');
    return {
      endpoints,
      identity: record.identity,
      ...(record.discovery && typeof record.discovery === 'object'
        ? { discovery: record.discovery as NonNullable<ConnectionManifest['discovery']> }
        : {})
    };
  } catch {
    throw new AthanorError(
      'connection_manifest_unavailable',
      'The server connection details are not available yet; run sudo athanor connect on the server',
      503
    );
  }
};

/**
 * True for a bare IPv4 or IPv6 address. Used to detect a WebAuthn RP ID that can never work,
 * rather than discovering it when the first sign-in silently fails.
 */
export const isAddressLiteral = (host: string): boolean => {
  const value = host.trim().replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  return value.includes(':');
};

export const idempotencyRequestHash = (method: string, url: string, body: unknown): string => {
  // `bytes:` tags the binary form so a Buffer can never collide with a JSON body that happens to
  // serialise to the same digest string.
  const fingerprint = ArrayBuffer.isView(body)
    ? `bytes:${sha256(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))}`
    : JSON.stringify(body ?? null);
  return sha256(`${method}\n${url}\n${fingerprint}`);
};

export interface ApiServices {
  app: FastifyInstance;
  previewApp: FastifyInstance;
  store: DataStore;
  database: ReturnType<typeof createDatabase>;
  /** The box's relay: its settings, and the single connection they turn on or off. */
  relay: RelaySupervisor;
  /**
   * The same sweep the five-minute timer runs - releasing lapsed approvals, finishing interrupted
   * scheduled dispatches, metering. Exposed so it can be driven on demand rather than waited for.
   */
  runMaintenance: () => Promise<void>;
  /**
   * One scheduler poll, driven rather than waited for - the same seam `runMaintenance` is, and for
   * the same reason: `SCHEDULER_POLL_MS` is fifteen seconds in production and a minute in the
   * tests, so nothing could assert what one tick dispatches without sleeping through it.
   */
  runScheduler: () => Promise<void>;
}

export interface ApiOverrides {
  connectorTransport?: ConnectorTransport;
  /**
   * The mail connectors speak TLS sockets rather than HTTPS requests, so verifying one cannot go
   * through `connectorTransport`. This is the same seam for that half.
   */
  mailSocketFactory?: MailSocketFactory;
  masterKey?: Uint8Array;
  modelCatalogFetch?: typeof fetch;
  logger?: Logger;
  /** Replaces the relay supervisor, so a test can drive the settings without dialling out. */
  relay?: RelaySupervisor;
}

/**
 * How wide the passkey throttle's window is and how many ceremonies fit in one. Not exported:
 * `checkAuthRate` below is the only reader, and `authRateLimitedPaths` - which decides where the
 * throttle applies - stays in `server.ts` with the request hook that consults it.
 */
const authRateLimitWindowMs = 15 * 60_000;
const authRateLimitAttempts = 20;

/**
 * The share viewer's per-address budget: this many requests a minute across its public routes
 * together - the page, its two assets, the ciphertext and the artifacts. Sized for a reader, not
 * for a ceremony: one open of the largest link the product makes is fifty-four requests (a page,
 * two assets, the ciphertext, `SHARE_LIMITS.artifacts` files), and an office behind one address
 * opens more pages in a minute than a passkey would ever be tried. `checkShareRate` reads it; the
 * box-wide ceiling on ciphertext reads in `routes/shares.ts` bounds every address together.
 */
export const SHARE_REQUESTS_PER_MINUTE = 120;
const shareRateLimitWindowMs = 60_000;

/**
 * Quiet hours travel as "HH:MM" and are stored as minutes past local midnight, because the owner
 * thinks in a clock and the notifier thinks in a comparison. Both directions live here so the read
 * route and the write route cannot disagree about the boundary.
 */
export const clockToMinutes = (value: string): number => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new AthanorError('invalid_quiet_hours', 'Quiet hours need a time like 22:00');
  return Number(match[1]) * 60 + Number(match[2]);
};
export const minutesToClock = (value: number): string =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

/** The preferred standing brief and supported compatibility names, in precedence order. */
export const workspaceBriefPath = 'workspace/GARDEN.md';
export const legacyWorkspaceBriefPaths = [
  'workspace/ATHANOR.md',
  'workspace/OPEN_CLOUD.md',
  'workspace/AGENTS.md'
] as const;

/**
 * The three files `GET /v1/instance/diagnostics` reads off the box, as functions of the state
 * directory rather than closures over the config. Nothing here is a decision: each answers with the
 * healthy value when the file is absent, because a box that has not yet reached its first window is
 * not a box in trouble.
 */
export const readStateFailure = async (
  statePath: string,
  name: string
): Promise<{ failedAt: string; reason: string } | null> => {
  try {
    const [failedAt, ...rest] = (await readFile(join(statePath, name), 'utf8')).split('\n');
    const reason = rest.join('\n').trim();
    return failedAt?.trim() ? { failedAt: failedAt.trim(), reason } : null;
  } catch {
    // Absent is the healthy answer: both helpers delete their file on the next success.
    return null;
  }
};
/**
 * The last backup, which unlike the two files above is reported whatever it says.
 *
 * Settings asserted that a backup is taken daily. Two paths made that false without a word
 * anywhere: a run that stands down because the worker is busy exits zero, and a run that fails
 * leaves no directory behind, because a copy with no checksum manifest cannot restore anything.
 * `at` and `outcome` describe the last run, `copyAt` and `copyBytes` the newest copy that
 * actually exists, and the case worth showing is the one where they disagree.
 */
export const readBackupStatus = async (
  statePath: string
): Promise<{
  at: string;
  outcome: 'ok' | 'skipped' | 'failed' | 'running';
  reason: string;
  copyAt: string | null;
  copyBytes: number | null;
} | null> => {
  try {
    const fields = new Map<string, string>();
    for (const line of (await readFile(join(statePath, 'backup.status'), 'utf8')).split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
    const parsed = z
      .object({
        at: z.string().min(1),
        outcome: z.enum(['ok', 'skipped', 'failed', 'running']),
        reason: z.string().max(500).default(''),
        copy_at: z.string().min(1).optional(),
        copy_bytes: z.coerce.number().int().nonnegative().optional()
      })
      .safeParse(Object.fromEntries(fields));
    if (!parsed.success) return null;
    return {
      at: parsed.data.at,
      outcome: parsed.data.outcome,
      reason: parsed.data.reason,
      copyAt: parsed.data.copy_at ?? null,
      copyBytes: parsed.data.copy_bytes ?? null
    };
  } catch {
    // Nothing written is a box that has not reached its first window, not a box in trouble.
    return null;
  }
};
/**
 * Whether the two things that are supposed to happen on their own are switched on.
 *
 * `backup` above reports the last *run*; it cannot say whether a next one is coming. So an owner
 * whose timer was never installed - which happened to every box updated across the release that
 * added it - saw a healthy last backup from before the gap and no sign that backups had stopped.
 * The Updates row had the mirror-image fault: static copy telling an owner who enabled weekly
 * updates a year ago to go and enable them.
 *
 * `systemctl is-enabled`, which is what `athanor check` already asks, with the same three
 * answers. `unknown` is the honest one for a box that is not systemd-managed - a development
 * checkout, a container - and for a `systemctl` that does not answer inside the budget: the
 * screen says it cannot tell rather than reporting `off` and sending the owner to switch on a
 * timer that is already running.
 */
export const timerState = async (unit: string): Promise<'on' | 'off' | 'unknown'> => {
  if (process.platform !== 'linux') return 'unknown';
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-enabled', unit], {
      timeout: 2_000
    });
    return ['enabled', 'enabled-runtime'].includes(stdout.trim()) ? 'on' : 'off';
  } catch (error) {
    // A non-zero exit is the answer, not a failure: `is-enabled` exits 1 saying `disabled`, and
    // `not-found` for a unit that was never installed. Anything with no readable verdict -
    // `systemctl` missing, the call timing out - is genuinely unknown.
    const raw = (error as { stdout?: unknown }).stdout;
    const stdout = (typeof raw === 'string' ? raw : '').trim();
    if (['disabled', 'masked', 'not-found', 'static', 'indirect'].includes(stdout)) return 'off';
    return 'unknown';
  }
};

/**
 * Build one server's context.
 *
 * The order is the order `buildServer` used to run in and must stay that way: the database is
 * migrated before the master key is checked against it, the key is resolved before the two service
 * secrets are derived from it, and the relay reads its saved settings before anything can ask what
 * they are.
 */
export const createApiContext = async (config: ApiConfig, overrides: ApiOverrides = {}) => {
  /**
   * Fastify's own logger is left off because its request lines carry raw URLs and headers. Every
   * line this server writes goes through the allowlisting logger instead, which cannot print
   * content even by accident.
   */
  const log = overrides.logger ?? createLogger({ level: config.LOG_LEVEL, service: 'api' });
  /**
   * nginx terminates TLS and forwards `X-Forwarded-For`; without trusting it every per-address rate
   * limit keys on 127.0.0.1, which collapses every caller into one bucket - simultaneously useless
   * against an attacker and a denial of service against everyone else. Only a loopback hop is
   * trusted, so the header counts for something exactly when it came from this machine's own
   * reverse proxy and for nothing when the API is reached directly.
   */
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024, trustProxy: 'loopback' });
  const database = createDatabase({
    driver: config.DATABASE_DRIVER,
    ...(config.DATABASE_DRIVER === 'postgres'
      ? { url: config.DATABASE_URL }
      : { pglitePath: config.PGLITE_PATH })
  });
  await migrateDatabase(database);
  const store = new DataStore(database);
  const keyRelease = overrides.masterKey
    ? { key: Buffer.from(overrides.masterKey), mode: 'hosted' as const }
    : await resolveDataMasterKey(config);
  const masterKey = keyRelease.key;
  await assertMasterKeyOpensDatabase(database, masterKey);
  await sealLegacyOperationResponses(database, masterKey);
  const runnerSharedSecret =
    config.RUNNER_SHARED_SECRET ?? deriveServiceSecret(masterKey, 'runner-capabilities');
  const sessionSigningKey =
    config.SESSION_SIGNING_KEY ?? deriveServiceSecret(masterKey, 'session-signing');
  const runner = new RunnerClient(config.WORKSPACE_RUNNER_URL, runnerSharedSecret);
  const previewApp = await buildPreviewGateway(store, config, runner);
  const secure = config.PUBLIC_APP_URL.startsWith('https://');
  const pushEndpointSuffixes = config.PUSH_ENDPOINT_HOST_SUFFIXES.split(',').filter(Boolean);
  /**
   * The hosts one connector may be reached on, decided the same way here and in the worker.
   *
   * A connector verified against one list and then executed against another is a connector that
   * connects and then fails the first time it is asked to do anything, so both processes read the
   * single rule in @athanor/worker: the deployment list plus the connector's own hostname, except
   * for mail and calendar, where the deployment list stands alone because a mailbox's submission
   * host is routinely a different name from the one it is read on.
   */
  const connectorAllowedHosts = (kind: Connector['kind'], baseUrl: string): string[] =>
    connectorHostAllowance(config.CONNECTOR_ALLOWED_HOST_SUFFIXES, { kind, baseUrl });
  /**
   * Publishing a preview points the internet at a loopback port of the agent computer, and every
   * athanor service is on loopback: the API, this preview gateway, the runner, PostgreSQL and the
   * sibling health endpoints. Refusing our own ports is what keeps "publish my demo on 3000" from
   * becoming "publish the database on 5432".
   */
  const reservedPreviewPortSet = reservedPreviewPorts({
    ports: [config.API_PORT, config.PREVIEW_GATEWAY_PORT],
    urls: [config.WORKSPACE_RUNNER_URL, config.PUBLIC_RUNNER_URL, config.DATABASE_URL],
    additional: config.RESERVED_PREVIEW_PORTS
  });
  const requestStarted = new WeakMap<object, number>();
  const requestMetrics = new Map<string, { count: number; durationMs: number }>();
  const connectionManifest = (): Promise<ConnectionManifest> =>
    readConnectionManifest(config.CONNECTION_MANIFEST_PATH);
  const relay =
    overrides.relay ??
    new RelaySupervisor({
      directory: config.RELAY_STATE_DIR,
      localHost: config.RELAY_LOCAL_HOST,
      localPort: config.RELAY_LOCAL_PORT,
      localHttpPort: config.RELAY_LOCAL_HTTP_PORT,
      localPreviewPort: config.RELAY_LOCAL_PREVIEW_PORT,
      log
    });
  // Reading the file is what makes the relay survive a restart; a box whose owner turned it on
  // should not need to be told again after every update.
  await relay.start();
  /**
   * Every open activity stream, oldest first, per account. Insertion order is what lets a sixth
   * device take the place of the stalest connection rather than be refused: a single owner
   * reaching for their laptop should never be the one who loses.
   */
  const openEventStreams = new Map<string, Map<number, () => void>>();
  let lastEventStreamId = 0;
  /**
   * The handle the next stream is filed under. A counter and not a random id because it is only
   * ever a key into the map above, and which connection the limit closes is decided by insertion
   * order rather than by the number.
   */
  const nextEventStreamId = (): number => (lastEventStreamId += 1);
  /**
   * A fixed-window counter per key. The map is bounded: past ten thousand live keys the expired
   * ones are swept, and if that frees nothing the request is refused rather than remembered, so a
   * flood of distinct addresses cannot grow the process without limit. Each surface gets its own
   * counter with its own window and its own words, because a reader refused on a share link
   * should not be told about sign-in.
   */
  const rateLimiter = (
    windowMs: number,
    limit: number,
    code: string,
    exhausted: string,
    busy: string
  ): ((key: string) => void) => {
    const attempts = new Map<string, { count: number; resetAt: number }>();
    return (key: string): void => {
      const now = Date.now();
      const current = attempts.get(key);
      if (!current || current.resetAt <= now) {
        if (attempts.size >= 10_000) {
          for (const [candidate, attempt] of attempts) {
            if (attempt.resetAt <= now) attempts.delete(candidate);
          }
          if (attempts.size >= 10_000) throw new AthanorError(code, busy, 429);
        }
        attempts.set(key, { count: 1, resetAt: now + windowMs });
        return;
      }
      current.count += 1;
      if (current.count > limit) throw new AthanorError(code, exhausted, 429);
    };
  };
  const checkAuthRate = rateLimiter(
    authRateLimitWindowMs,
    authRateLimitAttempts,
    'auth_rate_limited',
    'Too many sign-in attempts; try again later',
    'Sign-in is temporarily busy; try again later'
  );
  const checkShareRate = rateLimiter(
    shareRateLimitWindowMs,
    SHARE_REQUESTS_PER_MINUTE,
    'share_rate_limited',
    'Too many requests from this address; try again in a minute',
    'Shared links are temporarily busy; try again later'
  );
  /**
   * Metering walks the whole agent disk, so it is never on a path a person is waiting behind.
   *
   * The figure it produces is a display number and a maintenance input - the quota decision that
   * follows a send reads `store.usageTotals`, which is a database query - so a send, a follow-up
   * and a first paint are served from this cache and the walk happens behind the response. A
   * coding tree makes that walk hundreds of milliseconds, every time, on the single most common
   * action in the product.
   */
  const hostStorageTtlMs = 60_000;
  const hostStorageCache = new Map<
    string,
    { usage: HostStorage & { storageBytes: number }; at: number }
  >();
  const meteringInFlight = new Map<
    string,
    Promise<(HostStorage & { storageBytes: number }) | null>
  >();
  const meterWorkspace = async (
    workspace: WorkspaceRecord
  ): Promise<(HostStorage & { storageBytes: number }) | null> => {
    if (workspace.status !== 'running') return null;
    const existing = meteringInFlight.get(workspace.id);
    if (existing) return existing;
    const attempt = (async () => {
      try {
        const usage = await runner.request<HostStorage & { storageBytes: number }>({
          workspaceId: workspace.id,
          userId: workspace.userId,
          role: 'control',
          scopes: ['files.read'],
          path: `/v1/workspaces/${workspace.id}/usage`,
          // A hung runner otherwise holds the caller for undici's five-minute header timeout.
          timeoutMs: 5_000
        });
        await store.setWorkspaceStorage(workspace.userId, workspace.id, usage.storageBytes);
        const aggregated = await store.getWorkspace(workspace.userId, workspace.id);
        if (aggregated) usage.storageBytes = aggregated.storageBytes;
        hostStorageCache.set(workspace.id, { usage, at: Date.now() });
        return usage;
      } catch (error) {
        // Metering is best-effort, but a runner that has stopped answering shows up here first and
        // explains every storage figure that later looks frozen.
        log.warn('workspace.metering_failed', {
          workspaceId: workspace.id,
          ...errorFields(error)
        });
        return null;
      } finally {
        meteringInFlight.delete(workspace.id);
      }
    })();
    meteringInFlight.set(workspace.id, attempt);
    return attempt;
  };

  /**
   * The last figure read from the machine, refreshing it behind the response when it has aged out.
   * A workspace nothing has metered yet reports its stored total and no host figures until the
   * first refresh lands, which is one background walk rather than one per request.
   */
  const cachedHostStorage = (
    workspace: WorkspaceRecord
  ): (HostStorage & { storageBytes: number }) | null => {
    const cached = hostStorageCache.get(workspace.id);
    if (!cached || Date.now() - cached.at > hostStorageTtlMs) void meterWorkspace(workspace);
    return cached?.usage ?? null;
  };
  const taskTitle = async (
    task: NonNullable<Awaited<ReturnType<DataStore['getTask']>>>,
    knownWorkspace?: WorkspaceRecord
  ): Promise<string> => {
    if (!task.titleCiphertext) return task.legacyTitle ?? 'Private task';
    const workspace = knownWorkspace ?? (await store.getWorkspaceById(task.workspaceId));
    if (!workspace?.wrappedKey) return 'Private task';
    if (task.titleCiphertext.aad !== `task-title:${workspace.id}`) {
      throw new AthanorError('encrypted_title_context', 'Task title encryption context is invalid');
    }
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    return decryptJson<{ title: string }>(task.titleCiphertext, key).title;
  };

  const privateTaskResponse = async (
    task: NonNullable<Awaited<ReturnType<DataStore['getTask']>>>,
    knownWorkspace?: WorkspaceRecord
  ) => {
    const workspace = knownWorkspace ?? (await store.getWorkspaceById(task.workspaceId));
    return {
      ...taskResponse(task, await taskTitle(task, workspace ?? undefined)),
      resourceWait:
        task.status === 'awaiting_resource' && workspace?.wrappedKey
          ? await taskFailure(
              store,
              task.id,
              unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id),
              task.agentStateCiphertext
            )
          : null,
      ...(workspace?.parentWorkspaceId ? { parentWorkspaceId: workspace.parentWorkspaceId } : {})
    };
  };

  const scheduleTitle = async (
    schedule: TaskScheduleRecord,
    knownWorkspace?: WorkspaceRecord
  ): Promise<string> => {
    const workspace = knownWorkspace ?? (await store.getWorkspaceById(schedule.workspaceId));
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    if (schedule.titleCiphertext.aad !== `task-title:${workspace.id}`) {
      throw new AthanorError(
        'encrypted_title_context',
        'Schedule title encryption context is invalid'
      );
    }
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    return decryptJson<{ title: string }>(schedule.titleCiphertext, key).title;
  };

  /**
   * The standing instruction, or an empty string when this box cannot read it.
   *
   * Forgiving where `scheduleTitle` refuses, and deliberately: the title is what names the row in
   * every list, so a wrong context there means the row is not what it claims to be. The prompt is
   * one field of that row, and an unreadable one must not take the whole schedule - its timing, its
   * last error, the pause button - out of the owner's reach. Same reasoning as the notice log, which
   * lists a sentence it cannot decrypt rather than dropping the entry.
   */
  const schedulePrompt = (schedule: TaskScheduleRecord, workspace: WorkspaceRecord): string => {
    if (!workspace.wrappedKey || schedule.promptCiphertext.aad !== `task-prompt:${workspace.id}`)
      return '';
    try {
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      return decryptJson<{ prompt: string }>(schedule.promptCiphertext, key).prompt;
    } catch {
      return '';
    }
  };

  const privateScheduleResponse = async (
    schedule: TaskScheduleRecord,
    knownWorkspace?: WorkspaceRecord
  ): Promise<TaskSchedule> => {
    // Resolved once here rather than inside each reader: this is called per row over a list that
    // `serverLimits.maxSchedules` puts at a thousand, and two lookups per row is the shape the
    // sidebar spent a release paying for.
    const workspace = knownWorkspace ?? (await store.getWorkspaceById(schedule.workspaceId));
    if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
    return scheduleResponseFields(schedule, workspace);
  };

  const scheduleResponseFields = async (
    schedule: TaskScheduleRecord,
    workspace: WorkspaceRecord
  ): Promise<TaskSchedule> => ({
    id: schedule.id,
    workspaceId: schedule.workspaceId,
    title: await scheduleTitle(schedule, workspace),
    prompt: schedulePrompt(schedule, workspace),
    modelId: schedule.modelId,
    privacyRoute: schedule.privacyRoute as TaskSchedule['privacyRoute'],
    maxComputeCredits: schedule.maxComputeCredits,
    maxSpendUsd: schedule.maxSpendUsd ?? null,
    spec: schedule.spec,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    lastTaskId: schedule.lastTaskId,
    lastErrorCode: schedule.lastErrorCode,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt
  });

  const privateTaskPlanResponse = async (
    plan: NonNullable<Awaited<ReturnType<DataStore['getLatestTaskPlan']>>>,
    workspace: WorkspaceRecord
  ): Promise<TaskPlan> => {
    if (plan.stepsCiphertext.aad !== `task-plan:${plan.taskId}`)
      throw new AthanorError('encrypted_plan_context', 'Task plan encryption context is invalid');
    const key = unwrapDataKey(workspace.wrappedKey!, masterKey, workspace.id);
    const content = decryptJson<{
      steps: TaskPlanStep[];
      branchName?: string;
      outputs?: TaskPlan['outputs'];
      presentation?: TaskPlan['presentation'];
      directionEventId?: string;
    }>(plan.stepsCiphertext, key);
    return {
      id: plan.id,
      taskId: plan.taskId,
      version: plan.version,
      parentVersion: plan.parentVersion,
      branchName: content.branchName ?? plan.branchName,
      steps: content.steps,
      ...(content.outputs === undefined ? {} : { outputs: content.outputs }),
      ...(content.presentation ? { presentation: content.presentation } : {}),
      ...(content.directionEventId ? { directionEventId: content.directionEventId } : {}),
      createdBy: plan.createdBy,
      createdAt: plan.createdAt
    };
  };

  const connectorResponse = (connector: ConnectorRecord): Connector => ({
    id: connector.id,
    kind: connector.kind,
    authMode: connector.authMode,
    label: connector.label,
    baseUrl: connector.baseUrl,
    scopes: connector.scopes,
    enabled: connector.enabled,
    lastUsedAt: connector.lastUsedAt,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt
  });
  const previewBase = new URL(config.PREVIEW_BASE_URL);
  const workspacePreviewUrl = (slug: string): string => {
    const url = new URL(previewBase);
    const basePath = previewBase.pathname.replace(/\/+$/, '');
    if (basePath) {
      url.pathname = `${basePath}/${slug}/`;
    } else {
      url.hostname = `${slug}.${previewBase.hostname}`;
      url.pathname = '/';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  };
  const workspacePreviewResponse = (
    preview: WorkspacePreviewRecord,
    accessToken?: string
  ): WorkspacePreview => {
    // Always the slug. A preview used to be able to report a custom domain as its address once a
    // TXT record verified, but nothing ever routed such a host here: there is one nginx server
    // block, it matches any name, and only the preview path regex reaches the gateway - so the
    // owner was handed a link that answered with a certificate warning and then with athanor's own
    // sign-in page. The feature is gone rather than half-present; the columns behind it are left in
    // place for now so a rollback to the previous release still reads its own rows.
    const url = new URL(workspacePreviewUrl(preview.slug));
    /*
     * The entry path rides on every address handed out, not only on the one minted at publish
     * time: the Preview tab asks for a fresh address whenever it opens one, and a link that
     * forgot where to land would be the same file index all over again.
     */
    if (preview.entryPath)
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/${preview.entryPath.replace(/^\/+/, '')}`;
    if (accessToken && preview.visibility === 'private')
      url.searchParams.set('access', accessToken);
    return {
      id: preview.id,
      workspaceId: preview.workspaceId,
      label: preview.label,
      port: preview.port,
      visibility: preview.visibility,
      status:
        preview.status === 'active' &&
        preview.expiresAt !== null &&
        new Date(preview.expiresAt).getTime() <= Date.now()
          ? 'expired'
          : preview.status,
      url: url.toString(),
      expiresAt: preview.expiresAt,
      lastAccessedAt: preview.lastAccessedAt,
      createdAt: preview.createdAt,
      updatedAt: preview.updatedAt
    };
  };
  const apiTokenResponse = (token: ApiTokenRecord): ApiToken => ({
    id: token.id,
    label: token.label,
    prefix: token.prefix,
    scopes: token.scopes,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt
  });
  const workspaceKnowledgeKey = async (
    userId: string,
    workspaceId: string
  ): Promise<{ workspace: WorkspaceRecord; key: Buffer }> => {
    const workspace = await store.getWorkspace(userId, workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found', 404);
    return {
      workspace,
      key: unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id)
    };
  };

  /**
   * The key an owner-tier memory is sealed under.
   *
   * Derived from the master key and the user id rather than unwrapped from a row, so there is no
   * workspace to fetch first and nothing for `deleteWorkspace` to cascade over. @see userMemoryKey
   * for why the owner tier is keyed to the person and what that deliberately does not survive.
   */
  const ownerKnowledgeKey = (userId: string): Buffer => userMemoryKey(masterKey, userId);

  /**
   * The keyed tokens a conversation is findable by. Derived from the workspace data key rather
   * than being it, so the search surface and the stored ciphertext are separate secrets - which is
   * the same derivation every other blind index on this box goes through.
   */
  const nameIndexFor = (name: string, opening: string, dataKey: Uint8Array) =>
    buildConversationNameIndex(name, opening, memoryIndexKey(dataKey));

  /**
   * What a conversation was asked to do, or an empty string when this server cannot read it.
   *
   * A stored envelope that will not open is a state this box already models rather than an
   * accident - the passage pass of the search route skips such a row instead of reporting it - so
   * it costs this one conversation its opening surface and costs nothing else. Letting it throw
   * instead would take down whatever pass is walking the history: the rename it is called from,
   * the legacy-title sweep this file runs before the server listens, or the boot drain, which
   * reads oldest first and would stop at the first unreadable row with every conversation newer
   * than it still unindexed.
   */
  const openPrompt = (
    task: Pick<TaskRecord, 'workspaceId' | 'promptCiphertext'>,
    dataKey: Uint8Array
  ): string => {
    if (task.promptCiphertext.aad !== `task-prompt:${task.workspaceId}`) return '';
    try {
      return decryptJson<{ prompt: string }>(task.promptCiphertext, dataKey).prompt;
    } catch {
      return '';
    }
  };

  /** What a conversation is called, on the same terms. */
  const openName = (
    task: Pick<TaskRecord, 'workspaceId' | 'titleCiphertext' | 'legacyTitle'>,
    dataKey: Uint8Array
  ): string => {
    if (task.titleCiphertext?.aad !== `task-title:${task.workspaceId}`)
      return task.legacyTitle ?? '';
    try {
      return decryptJson<{ title: string }>(task.titleCiphertext, dataKey).title;
    } catch {
      return '';
    }
  };

  return {
    config,
    overrides,
    log,
    app,
    previewApp,
    database,
    store,
    keyRelease,
    masterKey,
    runnerSharedSecret,
    sessionSigningKey,
    runner,
    relay,
    secure,
    pushEndpointSuffixes,
    connectorAllowedHosts,
    reservedPreviewPortSet,
    requestStarted,
    requestMetrics,
    connectionManifest,
    checkAuthRate,
    checkShareRate,
    openEventStreams,
    nextEventStreamId,
    hostStorageCache,
    meterWorkspace,
    cachedHostStorage,
    taskTitle,
    privateTaskResponse,
    scheduleTitle,
    schedulePrompt,
    privateScheduleResponse,
    privateTaskPlanResponse,
    connectorResponse,
    workspacePreviewResponse,
    apiTokenResponse,
    workspaceKnowledgeKey,
    ownerKnowledgeKey,
    nameIndexFor,
    openPrompt,
    openName
  };
};

/**
 * What a route group receives. Derived from the factory so the two cannot drift; Wave 6 may narrow
 * it per route group once the groups exist and their real needs are visible.
 */
export type ApiContext = Awaited<ReturnType<typeof createApiContext>>;
