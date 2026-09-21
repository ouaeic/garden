export * from './project-git.js';
export * from './diagnostic-capture.js';
export * from './table-preview.js';
export * from './json-proof.js';
export * from './browser-action-receipts.js';
export * from './projects.js';
import { ConversationSource } from './projects.js';
import { z } from 'zod';
import { TaskOutputIntents } from './output-intent.js';
import { WorkSurfaceReport } from './work-surface.js';
export * from './work-surface.js';
export * from './output-intent.js';
export * from './delivery-state.js';
import { ReasoningOptions, TaskReasoningEffort } from './reasoning.js';
export * from './reasoning.js';
import { MediaCapabilities, MediaPriceLine } from './media.js';
export * from './media.js';
export * from './presentation.js';
export * from './browser-lifecycle.js';
export * from './code-intelligence.js';
export * from './computation.js';
export * from './coding-missions.js';
export * from './native-authorization.js';
export * from './approval-grants.js';

/**
 * Which computer answers a web search, and what that discloses to whom. It lives in its own file
 * because the API, the worker, the gateway and the web client all have to reach the same verdict
 * from the same facts, and a second opinion anywhere is a privacy failure rather than a bug.
 */
export * from './web-tools.js';

export const Id = z.string().uuid();
export const IsoDate = z.string().datetime();

export const WORKSPACE_STORAGE_GB_BYTES = 1_000_000_000;
export const MIN_WORKSPACE_STORAGE_BYTES = 10 * WORKSPACE_STORAGE_GB_BYTES;
export const MAX_WORKSPACE_STORAGE_BYTES = 100_000 * WORKSPACE_STORAGE_GB_BYTES;

export const WorkspaceStatus = z.enum([
  'provisioning',
  'running',
  'hibernated',
  'resizing',
  'failed',
  'deleting'
]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

export const PrivacyRoute = z.enum(['provider_zdr', 'external']);
export type PrivacyRoute = z.infer<typeof PrivacyRoute>;

export const SecurityMode = z.enum(['review', 'balanced', 'autonomous']);
export type SecurityMode = z.infer<typeof SecurityMode>;

/**
 * Whether this conversation is allowed to change anything yet.
 *
 * `act` is every task athanor has ever run, and it is the default everywhere by absence: a state
 * written before this field existed, and every caller that never names it, is `act` and behaves
 * exactly as it did. `plan` is the owner saying "work the approach out and show me before you touch
 * anything", and it is a different question from `SecurityMode` beside it - that one decides what
 * the owner is ASKED about, this one decides what may run at all.
 *
 * It is enforced in `apps/worker/src/turn/dispatch.ts` and is deliberately not described to the
 * model: the tool catalogue is byte-identical in both modes, so entering plan mode moves no byte at
 * the head of the cached prefix, and the model cannot leave a mode it is never told the name of.
 * What it gets instead is a refusal, per call, saying what to do with the step instead.
 *
 * Two words rather than a boolean because both readings have to be sayable out loud on a control
 * the owner presses: `planOnly: false` reads as "nothing is restricted", where `act` reads as what
 * the conversation is actually doing.
 */
export const TaskMode = z.enum(['plan', 'act']);
export type TaskMode = z.infer<typeof TaskMode>;

/** Where the soft spend threshold sits when the owner has never moved it. */
export const DEFAULT_SPEND_WARN_PERCENT = 80;
export const MAX_SPEND_CAP_USD = 1_000_000;
export const MAX_TASK_SPEND_USD = 10_000;

/**
 * The largest per-million-token rate an owner may name as their price ceiling.
 *
 * It is a different scale from the spend caps above, which are dollars per window: this is the
 * published rate of a route, and the dearest routes on the catalogue are tens of dollars per
 * million. A hundred is comfortably above every one of them and still refuses a typo that meant
 * dollars per task.
 */
export const MAX_PRICE_CEILING_USD_PER_MILLION = 100;

/**
 * How much one task may spend generating media before every further generation asks.
 *
 * The owner's spend caps are the ceiling on a runaway, and they are optional - an owner who has set
 * none has nothing between the agent and the provider's bill. This is the second brake, and it is
 * cumulative deliberately: a reviewed image is one and a half cents, so a per-call threshold at any
 * amount worth reading could never fire, while the run that re-rolls a logo forty times is exactly
 * what the owner would have stopped. A quarter of a dollar is roughly eighteen images.
 *
 * Here rather than beside the approval card because Settings has to print it. The media model is
 * the owner's to choose now, and a choice whose cost is stated next to a threshold the same screen
 * cannot see is how the two numbers drift apart.
 */
export const MEDIA_APPROVAL_USD = 0.25;

/**
 * The most of a recording one reading will take in, and the reason the tool has a resume parameter.
 *
 * Ninety minutes is a meeting, a lecture or a long interview - the shapes an owner actually points
 * at - and it is about eleven megabytes once it is cut down to mono speech, which crosses a wire
 * comfortably. Beyond it the transcript alone would fill a large part of the model's window, so the
 * useful answer to a three-hour recording is the first stretch of it plus the offset the next
 * reading starts at, not a refusal and not a silent truncation.
 *
 * Here because three layers need the same number: the runner cuts to it, the approval card prices
 * against it, and the tool tells the model about it. It has been two numbers in two files before
 * elsewhere in this project, and it was the stale one that won.
 */
export const AUDIO_READ_MAX_SECONDS = 5_400;

const CapUsd = z.number().nonnegative().max(MAX_SPEND_CAP_USD);
const TaskSpendUsd = z.number().positive().max(MAX_TASK_SPEND_USD);
/** Zero is a ceiling, not the absence of one: it admits only a route that publishes no charge. */
const PriceCeilingUsd = z.number().nonnegative().max(MAX_PRICE_CEILING_USD_PER_MILLION);

export const Workspace = z.object({
  parentWorkspaceId: Id.optional(),
  projectTaskId: Id.optional(),
  id: Id,
  name: z.string().min(1).max(80),
  status: WorkspaceStatus,
  storageBytes: z.number().int().nonnegative(),
  storageLimitBytes: z.number().int().positive(),
  hostStorageTotalBytes: z.number().int().positive().optional(),
  hostStorageAvailableBytes: z.number().int().nonnegative().optional(),
  imageRevision: z.string(),
  region: z.string(),
  /**
   * How the workspace data key is held. One value, because one mechanism exists: the key is
   * unwrapped by this server with the master key on its own disk. An 'attested' arm was declared
   * alongside a hardware key-release receipt table that has since been dropped, and nothing ever
   * produced it - a second value here would be a promise about where a key lives that no code keeps.
   */
  keyProtection: z.literal('hosted').default('hosted'),
  securityMode: SecurityMode.default('balanced'),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type Workspace = z.infer<typeof Workspace>;

export const WorkspaceSnapshotStatus = z.enum(['creating', 'ready', 'failed', 'deleting']);
export const WorkspaceSnapshot = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string().min(1).max(80),
  status: WorkspaceSnapshotStatus,
  sizeBytes: z.number().int().nonnegative(),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>;

/**
 * How a turn checkpoint was taken. `content` is the portable one and works on any filesystem; the
 * other two are instant because the filesystem itself does the work. The owner never picks this -
 * the runner establishes what the host can do by doing it - but a restore preview says which was
 * used, because it is the difference between "this is exact" and "this is what was covered".
 */
export const WorkspaceCheckpointMechanism = z.enum(['btrfs', 'zfs', 'content']);
export type WorkspaceCheckpointMechanism = z.infer<typeof WorkspaceCheckpointMechanism>;

/**
 * A point the computer can be put back to, taken automatically before the first turn of work that
 * could change anything. Distinct from a WorkspaceSnapshot: those are named recovery points the
 * owner asks for and keeps, these are cheap, numerous and pruned.
 */
export const WorkspaceCheckpoint = z.object({
  id: Id,
  workspaceId: Id,
  taskId: Id.nullable(),
  /** Which turn of that task this checkpoint sits in front of. */
  turn: z.number().int().nonnegative(),
  /**
   * The timeline position this checkpoint sits at: the highest event sequence the task had reached
   * when it was taken. This is what lets "rewind to here" in the transcript find the right one.
   */
  eventSequence: z.number().int().nonnegative().nullable(),
  mechanism: WorkspaceCheckpointMechanism,
  /** Null for a filesystem snapshot, which is instant precisely because it counts nothing. */
  fileCount: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  /** What this checkpoint cost on disk. Zero when the turn changed nothing. */
  storedBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  createdAt: IsoDate
});
export type WorkspaceCheckpoint = z.infer<typeof WorkspaceCheckpoint>;

export const CheckpointFileChange = z.object({
  path: z.string(),
  /** The size this file would have after a restore. */
  sizeBytes: z.number().int().nonnegative(),
  /** Its size right now, when it exists in both and differs. */
  currentSizeBytes: z.number().int().nonnegative().optional()
});
export type CheckpointFileChange = z.infer<typeof CheckpointFileChange>;

export const CheckpointPackageChange = z.object({
  name: z.string(),
  version: z.string(),
  previousVersion: z.string().optional()
});
export type CheckpointPackageChange = z.infer<typeof CheckpointPackageChange>;

/**
 * What rewinding the computer to a checkpoint would do, before it does it.
 *
 * `added` disappears, `modified` goes back, `deleted` returns. `packagesInstalled` is the honest
 * part: a rewind does not uninstall anything, so those stay, and the owner should be told rather
 * than left to discover it. Lists are capped; the counts are always the true totals.
 */
export const CheckpointRestorePreview = z.object({
  id: Id,
  mechanism: WorkspaceCheckpointMechanism,
  createdAt: IsoDate,
  added: z.array(CheckpointFileChange),
  modified: z.array(CheckpointFileChange),
  deleted: z.array(CheckpointFileChange),
  addedCount: z.number().int().nonnegative(),
  modifiedCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  restoredBytes: z.number().int().nonnegative(),
  removedBytes: z.number().int().nonnegative(),
  packagesInstalled: z.array(CheckpointPackageChange),
  packagesRemoved: z.array(CheckpointPackageChange),
  /** Files too large for a checkpoint to hold, which a rewind therefore leaves exactly as they are. */
  uncovered: z.array(CheckpointFileChange),
  truncated: z.boolean()
});
export type CheckpointRestorePreview = z.infer<typeof CheckpointRestorePreview>;

/**
 * How far back a rewind reaches.
 *
 * The conversation and the computer are two different things and always have been: editing a
 * message has never restored a file. Naming the choice is what stops an owner believing they undid
 * something they did not.
 */
export const RewindScope = z.enum(['conversation', 'computer', 'both']);
export type RewindScope = z.infer<typeof RewindScope>;

export const TaskStatus = z.enum([
  'draft',
  'queued',
  'planning',
  'running',
  'awaiting_user',
  'awaiting_resource',
  'paused',
  'completed',
  'failed',
  'cancelled'
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const SideEffectLevel = z.enum([
  'read',
  'workspace_write',
  'external_reversible',
  'external_consequential'
]);
export type SideEffectLevel = z.infer<typeof SideEffectLevel>;

export const ConnectorKind = z.enum([
  'github',
  'webdav',
  'mcp_http',
  'imap',
  'caldav',
  'google',
  'microsoft'
]);
export type ConnectorKind = z.infer<typeof ConnectorKind>;

export const ConnectorScope = z.enum([
  'github:profile.read',
  'github:repository.read',
  'github:repository.write',
  'github:issues.read',
  'github:issues.write',
  'github:pull_requests.write',
  'webdav:files.read',
  'webdav:files.write',
  'webdav:files.delete',
  'mcp:tools.read',
  'mcp:tools.execute',
  'mail:mailbox.read',
  'mail:message.write',
  'mail:message.send',
  'calendar:calendars.read',
  'calendar:events.write'
]);
export type ConnectorScope = z.infer<typeof ConnectorScope>;

export const Connector = z.object({
  id: Id,
  kind: ConnectorKind,
  authMode: z.enum(['secret', 'none', 'bearer', 'oauth']),
  label: z.string().min(1).max(80),
  baseUrl: z.string().url(),
  scopes: z.array(ConnectorScope),
  enabled: z.boolean(),
  lastUsedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type Connector = z.infer<typeof Connector>;

export const ConnectorAuditEvent = z.object({
  id: Id,
  connectorId: Id,
  taskId: Id.nullable(),
  operation: z.string(),
  outcome: z.enum(['succeeded', 'failed', 'denied']),
  statusCode: z.number().int().nullable(),
  requestBytes: z.number().int().nonnegative(),
  responseBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  createdAt: IsoDate
});
export type ConnectorAuditEvent = z.infer<typeof ConnectorAuditEvent>;

/**
 * What POST /v1/connectors/:id/test found when it asked the account whether it still works.
 *
 * A credential is verified once, when the account is added, and then trusted until something uses
 * it. Passwords change, servers move and authorizations expire, so this is the answer to "is this
 * still good", asked deliberately rather than discovered by a task that failed.
 *
 * `ok: false` is a successful reply to that question, not a failed request, so it arrives with the
 * reason attached: the code names it for a client, the message is what the far end actually said.
 */
export const ConnectorTestResult = z.object({
  connectorId: Id,
  ok: z.boolean(),
  /** What the account called itself: a mail address, a GitHub login, an MCP server name. */
  accountLabel: z.string().nullable(),
  checkedAt: IsoDate,
  failure: z.object({ code: z.string(), message: z.string() }).nullable()
});
export type ConnectorTestResult = z.infer<typeof ConnectorTestResult>;

export const CreateConnectorRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github'),
    label: z.string().min(1).max(80),
    token: z.string().min(1).max(4096),
    scopes: z.array(ConnectorScope).min(1)
  }),
  z.object({
    kind: z.literal('webdav'),
    label: z.string().min(1).max(80),
    baseUrl: z.string().url().max(2048),
    username: z.string().min(1).max(512),
    password: z.string().min(1).max(4096),
    scopes: z.array(ConnectorScope).min(1)
  }),
  z.object({
    kind: z.literal('mcp_http'),
    label: z.string().min(1).max(80),
    baseUrl: z.string().url().max(2048),
    token: z.string().max(4096).optional(),
    scopes: z.array(ConnectorScope).min(1)
  }),
  /**
   * A mailbox is two endpoints, not one: mail arrives over IMAP and leaves over SMTP submission,
   * and on most providers they are different hosts. `baseUrl` carries the reading half as
   * `imaps://mail.example.com:993` - a URL rather than a bare host so it goes through the same
   * parsing every other connector address does - and the sending half is named separately because
   * there is nowhere in a URL to put a second host and port honestly.
   *
   * `fromAddress` is the address mail is sent as, which is also the identity matched against an
   * invitation's attendee list; it is asked for rather than derived from the username because a
   * username is frequently not an address.
   */
  z.object({
    kind: z.literal('imap'),
    label: z.string().min(1).max(80),
    baseUrl: z.string().url().max(2048),
    username: z.string().min(1).max(512),
    password: z.string().min(1).max(4096),
    fromAddress: z.string().email().max(320),
    fromName: z.string().min(1).max(200).optional(),
    smtpHost: z.string().min(1).max(255),
    smtpPort: z.number().int().min(1).max(65_535).default(465),
    scopes: z.array(ConnectorScope).min(1)
  }),
  /**
   * `address` is the address other people invite the owner by. It is what tells athanor which
   * attendee on an event is the owner, so answering an invitation changes the right line.
   */
  z.object({
    kind: z.literal('caldav'),
    label: z.string().min(1).max(80),
    baseUrl: z.string().url().max(2048),
    username: z.string().min(1).max(512),
    password: z.string().min(1).max(4096),
    address: z.string().email().max(320),
    scopes: z.array(ConnectorScope).min(1)
  })
]);
export type CreateConnectorRequest = z.input<typeof CreateConnectorRequest>;

export const StartAccountOAuthRequest = z.object({
  provider: z.enum(['google', 'microsoft']),
  label: z.string().trim().min(1).max(80),
  clientId: z.string().trim().min(1).max(1024),
  clientSecret: z.string().min(1).max(8192),
  scopes: z.array(ConnectorScope).min(1).max(5)
});
export type StartAccountOAuthRequest = z.infer<typeof StartAccountOAuthRequest>;

const McpOAuthBase = z.object({
  label: z.string().min(1).max(80),
  baseUrl: z.string().url().max(2048),
  scopes: z.array(ConnectorScope).min(1),
  oauthScopes: z
    .array(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9:._/-]+$/)
    )
    .max(32)
    .default([])
});

export const StartMcpOAuthRequest = z.discriminatedUnion('registration', [
  McpOAuthBase.extend({
    registration: z.literal('dynamic')
  }),
  McpOAuthBase.extend({
    registration: z.literal('static'),
    clientId: z.string().min(1).max(2048),
    clientSecret: z.string().min(1).max(4096).optional()
  })
]);
export type StartMcpOAuthRequest = z.infer<typeof StartMcpOAuthRequest>;

export const StartConnectorOAuthResponse = z.object({
  connectorId: Id,
  authorizationUrl: z.string().url(),
  authorizationHost: z.string().min(1),
  expiresAt: IsoDate
});
export type StartConnectorOAuthResponse = z.infer<typeof StartConnectorOAuthResponse>;

/**
 * How long a private preview survives without being opened.
 *
 * A private preview does not expire on a clock: the owner's own app on the owner's own computer
 * should still answer their phone next month, and a link that dies overnight forces the choice
 * between re-publishing every day and putting the app on the public internet. What bounds it
 * instead is use. The access token travels in a URL, so a link nobody has opened in a month is a
 * bearer credential sitting in a chat history for no reason; every visit pushes the deadline back
 * out to this window, so a preview the owner actually uses never lapses and one they have
 * forgotten closes itself.
 */
export const PREVIEW_IDLE_EXPIRY_DAYS = 30;

/** How many live previews one computer may hold at once, so a loop cannot exhaust its ports. */
export const MAX_WORKSPACE_PREVIEWS = 100;

export const WorkspacePreview = z.object({
  id: Id,
  workspaceId: Id,
  label: z.string().min(1).max(80),
  port: z.number().int().min(1024).max(65_535),
  visibility: z.enum(['private', 'public']),
  status: z.enum(['active', 'revoked', 'expired']),
  url: z.string().url(),
  /**
   * When this link stops answering if nothing opens it before then, refreshed by every visit.
   * Null for a published public site, which stays up until it is unpublished or revoked.
   */
  expiresAt: IsoDate.nullable(),
  lastAccessedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type WorkspacePreview = z.infer<typeof WorkspacePreview>;

export const CreateWorkspacePreviewRequest = z.object({
  label: z.string().min(1).max(80),
  port: z
    .number()
    .int()
    .min(1024)
    .max(65_535)
    .refine((port) => port !== 4300),
  /*
   * Where inside the served port the owner lands.
   *
   * Absolute and relative to the port, never to a host: a value carrying a scheme, a host or a
   * `..` segment is refused rather than cleaned up, because the only thing it could be doing is
   * pointing the link somewhere the preview is not.
   */
  entryPath: z
    .string()
    .max(300)
    .transform((value) => value.trim())
    .refine(
      (value) =>
        value === '' ||
        (!/^[a-z][a-z0-9+.-]*:/i.test(value) &&
          !value.startsWith('//') &&
          !value.split(/[/\\]/).includes('..')),
      'entryPath cannot leave the preview'
    )
    .optional()
});
export type CreateWorkspacePreviewRequest = z.input<typeof CreateWorkspacePreviewRequest>;

/**
 * Publishing is a one-way door, not a lease: the owner asked for an address other people can
 * reach, and a public site that vanished on its own schedule would be a broken link to everyone
 * they gave it to. It stays up until they unpublish or revoke it, which is also the only pair of
 * actions that can end it.
 */
export const PublishWorkspacePreviewRequest = z.object({
  confirmPublic: z.literal(true)
});
export type PublishWorkspacePreviewRequest = z.input<typeof PublishWorkspacePreviewRequest>;

/**
 * Which of the two audiences above a publishing call is asking for - the same word the preview it
 * creates is then stored under, `WorkspacePreview.visibility`.
 *
 * It exists as a value the agent passes because the alternative, which shipped for several waves,
 * was two tools with identical required parameters whose only difference was their names:
 * `publish_preview` for the private link and `publish_site` for the public one. That difference was
 * invisible to the approval floor, which judges a call by what it reaches and had to read the name
 * to guess at it.
 */
export const PublishReach = z.enum(['private', 'public']);
export type PublishReach = z.infer<typeof PublishReach>;

/**
 * Whether a publishing call puts something on the public internet, from the call's own argument.
 *
 * ONE exported reader, and the approval floor and the arm that publishes both call it, because the
 * failure this merge could have shipped is precisely the two of them disagreeing: a floor reading
 * "private" on a call the arm publishes publicly is a public deployment with no approval card, in
 * the default security mode, silently. Measured before the floor moved, `publish_preview` with a
 * reach argument raised NOTHING in balanced or autonomous on a clean turn.
 *
 * Anything that is not the literal `public` is private, on both sides. That is the same expression
 * in both places rather than two readings that agree today, so a value neither of them recognises -
 * a misspelling, a null, an object - is the narrow reach for the floor and for the arm alike, and
 * the two cannot come apart. The schema refuses such a value before either sees it; this is what
 * holds if it ever stops.
 */
export const publishesPublicly = (reach: unknown): boolean => reach === PublishReach.enum.public;

/*
 * There is no `SetWorkspacePreviewDomainRequest`, and there is deliberately no note here about one
 * arriving. A schema of that name stood here validating a hostname for a route that was never
 * written, against three columns on `workspace_previews` that no statement ever wrote, mapped onto
 * a record that served `customDomain: null` on every preview response. Migration 69 dropped the
 * columns; this went with them, because a published request schema is the loudest way this package
 * says a capability exists, and it was the last thing still saying it.
 *
 * `PublishWorkspacePreviewRequest` above is what publishing actually is here: a preview is reached
 * on its own slug under the box's own hostname, and that is the whole of the addressing story.
 */

export const TASK_TITLE_MAX_LENGTH = 1024;

export const Task = z.object({
  activity: z
    .object({
      currentStep: z.string().nullable(),
      stepsCompleted: z.number(),
      stepsTotal: z.number(),
      latest: z.string(),
      eventId: z.string().nullable(),
      observedAt: IsoDate.nullable()
    })
    .optional(),
  id: Id,
  projectId: Id.optional(),
  modelOverride: z.boolean().optional(),
  workspaceId: Id,
  parentWorkspaceId: Id.optional(),
  parentTaskId: Id.nullable().optional(),
  parentMissionId: Id.nullable().optional(),
  branchedFromEventId: Id.nullable().optional(),
  forkKind: z.enum(['branch', 'edit', 'retry']).nullable().optional(),
  /**
   * The schedule that minted this conversation, or null for one the owner started.
   *
   * Nothing on a materialised run recorded where it came from, so a watcher firing every fifteen
   * minutes put ninety-six conversations a day into the same recency order as the owner's own work
   * and buried it. This is the fact that lets a client collapse them: it is provenance, not a live
   * reference, and it stays true after the schedule itself is deleted.
   */
  scheduleId: Id.nullable().default(null),
  title: z.string().min(1).max(TASK_TITLE_MAX_LENGTH),
  status: TaskStatus,
  /** Latest failure behind a held run, independent of the visible activity page. */
  resourceWait: z.object({ code: z.string(), summary: z.string() }).nullable().optional(),
  modelId: z.string(),
  reasoningEffort: TaskReasoningEffort.optional(),
  deliveryStatus: z.enum(['pending', 'ready', 'incomplete']).nullable().optional(),
  pendingDeliveryCount: z.number().int().nonnegative().optional(),
  privacyRoute: PrivacyRoute,
  securityMode: SecurityMode.default('balanced'),
  maxComputeCredits: z.number().nonnegative(),
  actualComputeCredits: z.number().nonnegative(),
  /** The task's own ceiling in real currency. Null when only the account-level caps apply. */
  maxSpendUsd: z.number().positive().nullable().default(null),
  /** Settled provider cost for this task so far. */
  spentUsd: z.number().nonnegative().default(0),
  /**
   * When a spending ceiling stopped this run, or null for every other kind of stop.
   *
   * A paused task said nothing about why it stopped, so a run a ceiling halted was indistinguishable
   * from one the owner paused - and pressing Resume re-queued it into the same ceiling, which
   * stopped it again a step later and read as a Resume button that does nothing. A client that can
   * see this can say what happened and offer the only thing that actually changes the outcome.
   */
  spendPausedAt: IsoDate.nullable().default(null),
  /** When this run stopped. Null while it can still do work; cleared again by a follow-up. */
  completedAt: IsoDate.nullable().default(null),
  queuedMessageCount: z.number().int().nonnegative().default(0),
  hasOpenQuestion: z.boolean().optional(),
  /**
   * How many links to a snapshot of this conversation are live - neither revoked nor expired. The
   * count is all a client needs to draw the badge; the links themselves are read on demand.
   */
  shareCount: z.number().int().nonnegative().default(0),
  /** How far the fork that created this task reached back. Null for a task nobody rewound into. */
  rewind: RewindScope.nullable().default(null),
  /** The checkpoint the computer was put back to, when this fork rewound it. */
  restoredCheckpointId: Id.nullable().default(null),
  /** Held above the recency buckets in the sidebar. */
  pinned: z.boolean().default(false),
  /** When the owner filed this conversation away. Null for one still in the sidebar. */
  archivedAt: IsoDate.nullable().default(null),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type Task = z.infer<typeof Task>;

/**
 * One page of the conversation list, newest activity first with pinned conversations above it.
 *
 * `nextCursor` is opaque and encodes a position in that order rather than a row count, so a
 * conversation answered while the owner is reading page three neither duplicates nor disappears.
 */
export const TaskPage = z.object({
  tasks: z.array(Task),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  /**
   * For every schedule with a run on this page, how many runs it has in the list being read.
   *
   * Not how many of them the page is carrying: a page holds at most a handful of any one
   * schedule's runs, on purpose, so that a watcher firing every fifteen minutes cannot bury the
   * owner's own work. This is what lets a folded line say four hundred while holding five, and it
   * is the only number on the client that knows the difference.
   */
  scheduleRunCounts: z.record(z.string(), z.number().int().nonnegative()).default({})
});
export type TaskPage = z.infer<typeof TaskPage>;

export const TaskPageQuery = z.object({
  workspaceId: Id.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  /** Archived conversations are out of the way by default, and reachable by asking for them. */
  include: z.enum(['active', 'archived', 'all']).default('active')
});
export type TaskPageQuery = z.input<typeof TaskPageQuery>;

/**
 * Renaming, pinning and archiving a conversation. Every field is optional and at least one is
 * required, so a request that would change nothing is refused rather than silently accepted.
 */
export const UpdateTaskRequest = z
  .object({
    title: z.string().trim().min(1).max(TASK_TITLE_MAX_LENGTH).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional()
  })
  .refine(
    (input) =>
      input.title !== undefined || input.pinned !== undefined || input.archived !== undefined,
    { message: 'Name, pin or archive the conversation' }
  );
export type UpdateTaskRequest = z.input<typeof UpdateTaskRequest>;

export const BranchTaskRequest = z.object({
  eventId: Id.optional()
});
export type BranchTaskRequest = z.input<typeof BranchTaskRequest>;

/**
 * Rewinding the computer as well as the conversation.
 *
 * `conversation` is the historical behaviour and stays the default: a new path through the chat,
 * with the machine exactly as the agent left it. `computer` and `both` put the workspace back to a
 * checkpoint - named explicitly, because an implicit "nearest" would be a rewind the owner did not
 * choose. Omitting it with scope `computer` or `both` means the caller wants the checkpoint that
 * covers the chosen event, which the server resolves and reports back.
 */
const RewindChoice = {
  rewind: RewindScope.default('conversation'),
  checkpointId: Id.optional()
};

/**
 * Which model the new path runs on. Omitted means the one the source task used, which is what a
 * fork has always done - naming one is how "that answer was weak, try the stronger model" happens
 * without retyping the request. The privacy route travels with it because a model belongs to a
 * route, and a route the account does not allow is refused rather than quietly downgraded.
 */
const TrajectoryModelChoice = {
  modelId: z.string().min(1).max(200).optional(),
  privacyRoute: PrivacyRoute.optional()
};

export const TaskTrajectoryRequest = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('branch'),
    eventId: Id,
    ...RewindChoice,
    ...TrajectoryModelChoice
  }),
  z.object({
    operation: z.literal('edit'),
    eventId: Id,
    prompt: z.string().trim().min(1).max(200_000),
    maxComputeCredits: z.number().min(0.01).max(10_000).default(5),
    maxSpendUsd: TaskSpendUsd.optional(),
    stopSource: z.boolean().default(true),
    ...RewindChoice,
    ...TrajectoryModelChoice
  }),
  z.object({
    operation: z.literal('retry'),
    eventId: Id,
    maxComputeCredits: z.number().min(0.01).max(10_000).default(5),
    maxSpendUsd: TaskSpendUsd.optional(),
    stopSource: z.boolean().default(true),
    ...RewindChoice,
    ...TrajectoryModelChoice
  })
]);
export type TaskTrajectoryRequest = z.input<typeof TaskTrajectoryRequest>;

/**
 * Everything the owner needs to see before confirming a rewind: how much conversation goes, which
 * checkpoint the computer would go back to, and what that would do to their files.
 *
 * `checkpoint` is null when no checkpoint covers the chosen point - a turn that only read, or one
 * old enough to have been pruned. That is not an error; it is the answer, and it is the difference
 * between offering a three-way choice and offering a choice that would quietly do nothing.
 */
export const TaskRewindPreview = z.object({
  taskId: Id,
  eventId: Id,
  /** Conversation events after the chosen one, which a conversation rewind leaves behind. */
  droppedEventCount: z.number().int().nonnegative(),
  checkpoint: WorkspaceCheckpoint.nullable(),
  computer: CheckpointRestorePreview.nullable()
});
export type TaskRewindPreview = z.infer<typeof TaskRewindPreview>;

export const UpdateSecurityModeRequest = z.object({ securityMode: SecurityMode });
export type UpdateSecurityModeRequest = z.input<typeof UpdateSecurityModeRequest>;

export const TaskEventKind = z.enum([
  'task_created',
  'user_message',
  'queued_message',
  'plan',
  'status',
  'assistant_delta',
  /**
   * The model's reasoning as it arrives, when the route produces any.
   *
   * Separate from `assistant_delta` because it is a different thing to read: it is how the answer
   * was reached rather than the answer, it is often much longer, and it should be foldable. On a
   * long step the alternative is a spinner - the model has been thinking for forty seconds and the
   * owner has been given no reason to believe anything is happening.
   */
  'assistant_reasoning',
  'assistant_message',
  'tool_started',
  'tool_result',
  'preview',
  'artifact',
  'approval_requested',
  'approval_resolved',
  /**
   * The agent stopped and put a question to the owner.
   *
   * Its own kind rather than an approval, because the two are different acts and were being drawn
   * as one: a blocker used to come back as a `finish` with a `not_applicable` verification, which
   * lands as a completion card indistinguishable from finished work. An approval asks permission for
   * something the agent is about to do and is answered yes or no; this asks for a decision the agent
   * cannot make and is answered in words, or by picking one of the options it listed.
   */
  'question_asked',
  'cost',
  /** Something the agent decided the owner should be told at that moment, not on their next visit. */
  /**
   * One delegated specialist's standing, so a mission the lead sent away is on the timeline as
   * something spinning up, working and being checked rather than one opaque tool call. The
   * payload is a `SubagentLane`; same lane, same `laneId`.
   */
  'subagent',
  'notice',
  'warning',
  'provenance',
  'error',
  'completed'
]);
export type TaskEventKind = z.infer<typeof TaskEventKind>;

/**
 * The latest event for a `laneId` describes that lane's current work. `elapsedMs` is the
 * mission's clock, frozen at a terminal status. Quotation matches and independent claim
 * assessments have separate coverage; neither turns the lane into whole-report verification.
 */
export const SubagentLane = z.object({
  laneId: z.string().min(1).max(64),
  lane: z.enum(['research', 'coding', 'review']),
  name: z.string().min(1).max(80),
  status: z.enum(['started', 'working', 'waiting', 'completed', 'failed', 'verified']),
  detail: z.string().max(500).optional(),
  elapsedMs: z.number().nonnegative().optional(),
  usedCredits: z.number().nonnegative().optional(),
  allocatedCredits: z.number().nonnegative().optional(),
  steps: z.number().int().nonnegative().optional(),
  citations: z
    .object({
      checked: z.number().int().nonnegative(),
      matched: z.number().int().nonnegative(),
      cited: z.number().int().nonnegative()
    })
    .optional(),
  claimReview: z
    .object({
      checked: z.number().int().nonnegative(),
      supported: z.number().int().nonnegative(),
      contradicted: z.number().int().nonnegative()
    })
    .optional(),
  verified: z
    .object({ checked: z.number().int().nonnegative(), held: z.number().int().nonnegative() })
    .optional()
});
export type SubagentLane = z.infer<typeof SubagentLane>;

export const TaskEvent = z.object({
  id: Id,
  taskId: Id,
  sequence: z.number().int().positive(),
  kind: TaskEventKind,
  summary: z.string().max(500),
  payload: z.unknown().optional(),
  createdAt: IsoDate
});
export type TaskEvent = z.infer<typeof TaskEvent>;

/**
 * How much of a trajectory to read. Naming nothing still means the whole of it, which is what an
 * export needs; a reader opening a long conversation names a limit and gets the newest page.
 */
export const TaskEventWindowQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional()
});
export type TaskEventWindowQuery = z.input<typeof TaskEventWindowQuery>;

export const TaskPlanStepBase = z.object({
  id: Id,
  title: z.string().trim().min(1).max(240),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped']).default('pending'),
  startedAt: IsoDate.optional(),
  completedAt: IsoDate.optional()
});
export const TaskPlanSubstep = TaskPlanStepBase;
export const TaskPlanStep = TaskPlanStepBase.extend({
  /** One level deep, deliberately: a milestone that needs its own milestones is a task. */
  substeps: z.array(TaskPlanSubstep).max(30).optional()
});
export type TaskPlanStep = z.infer<typeof TaskPlanStep>;

export const TaskPlan = z.object({
  id: Id,
  taskId: Id,
  version: z.number().int().positive(),
  parentVersion: z.number().int().positive().nullable(),
  branchName: z.string().min(1).max(80),
  steps: z.array(TaskPlanStep).min(1).max(30),
  outputs: TaskOutputIntents.optional(),
  presentation: WorkSurfaceReport.optional(),
  directionEventId: z.string().optional(),
  createdBy: z.enum(['agent', 'user']),
  createdAt: IsoDate
});
export type TaskPlan = z.infer<typeof TaskPlan>;

export const UpdateTaskPlanRequest = z.object({
  outputs: TaskOutputIntents.optional(),
  expectedVersion: z.number().int().nonnegative(),
  parentVersion: z.number().int().positive().optional(),
  branchName: z.string().trim().min(1).max(80).default('Main'),
  steps: z
    .array(
      TaskPlanStepBase.extend({
        id: Id.optional(),
        // Optional on the parts for the same reason it is optional on the steps: a part the owner
        // has just typed has no id yet, and refusing the write over one would make adding a part
        // through the editor impossible while adding a step stayed fine.
        substeps: z
          .array(TaskPlanSubstep.extend({ id: Id.optional() }))
          .max(30)
          .optional()
      })
    )
    .min(1)
    .max(30)
});
export type UpdateTaskPlanRequest = z.input<typeof UpdateTaskPlanRequest>;

export const Artifact = z.object({
  id: Id,
  workspaceId: Id,
  taskId: Id.nullable(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  sha256: z.string(),
  createdAt: IsoDate
});
export type Artifact = z.infer<typeof Artifact>;

/*
 * Share links: a frozen, encrypted copy of one conversation that anyone holding the link can read.
 *
 * The link is `/v1/shares/<id>#1.<key>`. The path id is 16 random bytes in base64url - 22
 * characters, 128 bits - and the box stores only its SHA-256, so a stolen table names nothing. The
 * key after `#` is 32 random bytes the browser never sends: a fragment is not part of an HTTP
 * request, so it reaches no log, no proxy and no link-preview bot. The box encrypts the snapshot
 * under that key once, hands the link back once, and forgets the key. What it keeps is ciphertext
 * it cannot open.
 */

/** The path segment a share is looked up by. Exactly this shape, or nothing is looked up at all. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** How long a link lives, in days. `null` is the deliberate choice of never. */
export const ShareExpiryDays = z.union([z.literal(1), z.literal(7), z.literal(30), z.null()]);
export type ShareExpiryDays = z.infer<typeof ShareExpiryDays>;

export const SHARE_LIMITS = {
  /** The snapshot as JSON, before compression. */
  snapshotBytes: 8 * 1024 * 1024,
  /** One artifact's bytes. */
  artifactBytes: 64 * 1024 * 1024,
  /** Everything one link carries, snapshot and artifacts together. */
  totalBytes: 256 * 1024 * 1024,
  /** How many artifacts one link may carry. */
  artifacts: 50
} as const;

/**
 * What the owner asked for. Every switch is off by default, so a link made without reading the
 * form carries the least: the owner's messages, the assistant's replies, the plan, and one line per
 * tool step. Reasoning and raw tool output are opted into, never out of.
 */
export const CreateShareRequest = z.object({
  expiresInDays: ShareExpiryDays.default(30),
  includeReasoning: z.boolean().default(false),
  includeToolResults: z.boolean().default(false),
  /** The artifacts the owner ticked. Each must belong to the task being shared. */
  artifactIds: z.array(Id).max(SHARE_LIMITS.artifacts).default([]),
  /** A name for the viewer's page, sealed inside the snapshot with everything else. */
  publicTitle: z.string().trim().min(1).max(160).optional(),
  /** Binds creation to the content the owner reviewed, including artifact bytes. */
  expectedPreviewDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
});
export type CreateShareRequest = z.input<typeof CreateShareRequest>;

/** One link as the owner sees it. The lookup hash and the key are never on this record. */
export const ShareRecord = z.object({
  id: Id,
  taskId: Id,
  createdAt: IsoDate,
  expiresAt: IsoDate.nullable(),
  viewCount: z.number().int().nonnegative(),
  lastViewedAt: IsoDate.nullable(),
  revokedAt: IsoDate.nullable(),
  version: z.number().int().positive()
});
export type ShareRecord = z.infer<typeof ShareRecord>;

/** The link, served once. `url` is path and fragment; the client prefixes its own origin. */
export const CreateShareResponse = z.object({ share: ShareRecord, url: z.string() });
export type CreateShareResponse = z.infer<typeof CreateShareResponse>;

/**
 * The kinds a viewer can be shown. A subset of `TaskEventKind` by design: the kinds that carry
 * tokenised URLs, cost, queued text or raw tool output are not on it and cannot be added by a
 * switch - `tool_result` here is the one-line summary, and the payload text only rides in the
 * `text` of that same line when the owner asked for it.
 */
export const ShareSnapshotEventKind = z.enum([
  'user_message',
  'assistant_message',
  'assistant_reasoning',
  'plan',
  'status',
  'tool_started',
  'tool_result',
  'question_asked',
  'approval_requested',
  'approval_resolved',
  'notice',
  'warning',
  'error',
  'completed'
]);
export type ShareSnapshotEventKind = z.infer<typeof ShareSnapshotEventKind>;

/**
 * What the viewer decrypts. No id of any kind: not the task's, not the workspace's, not an
 * event's, not the owner's. `n` on an artifact is its index in this list and nothing else.
 */
export const ShareSnapshot = z.object({
  v: z.literal(1),
  title: z.string(),
  createdAt: IsoDate,
  events: z.array(
    z.object({
      kind: ShareSnapshotEventKind,
      at: IsoDate,
      text: z.string()
    })
  ),
  artifacts: z.array(
    z.object({
      n: z.number().int().nonnegative(),
      name: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      sha256: z.string()
    })
  )
});
export type ShareSnapshot = z.infer<typeof ShareSnapshot>;

export const SharePreviewResponse = ShareSnapshot.extend({
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/)
});
export type SharePreviewResponse = z.infer<typeof SharePreviewResponse>;

/**
 * What the public blob route answers with: the sealed snapshot, and for each artifact the public
 * half of its envelope so the viewer can open the bytes it fetches separately.
 */
export interface ShareBlob {
  version: number;
  envelope: { v: number; iv: string; tag: string; ciphertext: string; aad?: string };
  manifest: Array<{
    n: number;
    sizeBytes: number;
    envelope: { v: number; iv: string; tag: string; aad?: string };
  }>;
}

export const ModelAvailability = z.enum(['available', 'degraded', 'unavailable', 'review']);
export const ModelOpenness = z.enum([
  'osaid_open_source',
  'permissive_open_weight',
  'restricted_open_weight',
  'remote_proprietary'
]);

export const ModelRelease = z.object({
  id: z.string(),
  /** The saved connection that serves this exact model route. */
  connectionId: z.string().min(1).optional(),
  connectionLabel: z.string().max(80).optional(),
  providerModelId: z.string(),
  displayName: z.string(),
  provider: z.string(),
  revision: z.string(),
  availability: ModelAvailability,
  openness: ModelOpenness,
  license: z.string(),
  commercialUse: z.boolean(),
  privacyRoute: PrivacyRoute,
  contextTokens: z.number().int().positive(),
  modalities: z.array(z.enum(['text', 'image', 'audio', 'video'])),
  capabilities: z.array(z.enum(['chat', 'vision', 'tools', 'reasoning', 'embedding', 'decisions'])),
  reasoning: ReasoningOptions.optional(),
  nativeInputPricing: z
    .object({
      audioUsdPerMillionTokens: z.number().nonnegative().nullable(),
      videoUsdPerMillionTokens: z.number().nonnegative().nullable()
    })
    .optional(),
  usageClass: z.enum(['light', 'medium', 'high', 'extra_high']),
  recommendationTags: z.array(z.string()),
  measuredQuality: z.number().min(0).max(1).nullable(),
  agenticQuality: z.number().min(0).max(1).nullable().optional(),
  codingQuality: z.number().min(0).max(1).nullable().optional(),
  intelligenceQuality: z.number().min(0).max(1).nullable().optional(),
  measuredLatencyMs: z.number().nonnegative().nullable(),
  inputUsdPerMillionTokens: z.number().nonnegative().nullable().optional(),
  outputUsdPerMillionTokens: z.number().nonnegative().nullable().optional(),
  benchmarkRank: z.number().positive().nullable().optional(),
  benchmarkSource: z.string().nullable().optional(),
  benchmarkUpdatedAt: IsoDate.nullable().optional(),
  /** Whether at least one live provider endpoint currently serves this reviewed model. */
  providerAvailable: z.boolean().optional(),
  /** Whether at least one live endpoint also satisfies the provider's zero-retention contract. */
  zeroDataRetentionAvailable: z.boolean().optional(),
  updatedAt: IsoDate
});
export type ModelRelease = z.infer<typeof ModelRelease>;

/** Provider-discovered media modalities supported by the gateway. */
export const MediaModality = z.enum(['image', 'audio', 'transcription', 'video']);
export type MediaModality = z.infer<typeof MediaModality>;

/** Guidance for a video request without an owner-selected route. */
export const MEDIA_VIDEO_UNAVAILABLE_REASON =
  'Choose a video model in Settings. Each video job requires approval for temporary provider retention.';

/**
 * One media model the owner may choose, with what it costs stated in the unit its provider bills.
 *
 * Every price is nullable and paired with `priceSource`, because a media price is the one number
 * this software genuinely may not know. The chat catalogue reads per-token prices straight out of
 * the provider feed; the media feed carries no field this repository can point at for "dollars per
 * image", so a model whose price was not published says so rather than borrowing the default's.
 * `mediaPriceKnown` in the worker turns that admission into an approval that always asks.
 */
export const MediaModelOption = z.object({
  /** Catalogue id, the same `provider/slug` shape the chat catalogue uses. */
  id: z.string(),
  providerModelId: z.string(),
  displayName: z.string(),
  provider: z.string(),
  modality: MediaModality,
  /** Charged per generated image, where the provider prices by the image. */
  usdPerImage: z.number().nonnegative().nullable(),
  /** Charged per million characters of input text, which is how speech is billed. */
  usdPerMillionCharacters: z.number().nonnegative().nullable(),
  /** Charged per minute of recording, which is how transcription is billed. */
  usdPerMinute: z.number().nonnegative().nullable().default(null),
  usdPerSecond: z.number().nonnegative().nullable().optional(),
  capabilities: MediaCapabilities.optional(),
  pricing: z.array(MediaPriceLine).max(128).optional(),
  apiProtocol: z.enum(['openrouter', 'openai']).optional(),
  providerEndpointTag: z.string().min(1).max(200).optional(),
  /** A persisted endpoint pin must match its live capability and price metadata. */
  metadataVerifiedAt: IsoDate.optional(),
  requiresRetentionApproval: z.boolean().optional(),
  retirementAt: IsoDate.optional(),
  /**
   * `provider` when the figure came off the provider's own feed, `measured` when it is a price
   * athanor recorded from real generations on this route, `unknown` when nobody has said.
   */
  priceSource: z.enum(['provider', 'measured', 'unknown']),
  /** The voice name to send for speech, when this route names its voices and one was chosen. */
  defaultVoice: z.string().nullable().optional(),
  /** Whether a zero-retention endpoint serves this model, on the providers that publish that. */
  zeroDataRetentionAvailable: z.boolean().optional(),
  /** Why this one cannot be chosen right now, in the owner's terms. Empty when it can. */
  unavailableReason: z.string().nullable().optional(),
  recommendationTags: z.array(z.string()),
  updatedAt: IsoDate
});
export type MediaModelOption = z.infer<typeof MediaModelOption>;

/**
 * The owner's choice for one modality, in the vocabulary the chat model picker already uses.
 *
 * Deliberately the same three automatic modes and the same `automatic`/`modelId` pair as
 * `OwnerPreferences.model`: an owner who has learned that Recommended, Faster and Higher quality
 * mean something in the composer should not have to learn a second set of words in Settings.
 */
export const MediaModelChoice = z.object({
  automatic: z.boolean(),
  preference: z.enum(['fast', 'balanced', 'best']),
  modelId: z.string().max(300).default('')
});
export type MediaModelChoice = z.infer<typeof MediaModelChoice>;

/** What the owner chose per modality. An absent modality is one they have never touched. */
export const MediaModelSelection = z.object({
  image: MediaModelChoice.optional(),
  audio: MediaModelChoice.optional(),
  transcription: MediaModelChoice.optional(),
  video: MediaModelChoice.optional()
});
export type MediaModelSelection = z.infer<typeof MediaModelSelection>;

/**
 * One modality as Settings draws it: what is on offer, what is chosen, and what that will cost.
 *
 * `effective` is resolved on the server rather than in the browser, so the price the owner reads
 * beside the control is produced by the same resolver the worker prices the approval card with.
 * Two answers to "which model does this use" is exactly the state this whole change exists to end.
 */
export const MediaModalityState = z.object({
  modality: MediaModality,
  available: z.boolean(),
  /** Present when `available` is false: the reason there is nothing to choose. */
  reason: z.string().nullable(),
  options: z.array(MediaModelOption),
  choice: MediaModelChoice,
  effective: MediaModelOption.nullable()
});
export type MediaModalityState = z.infer<typeof MediaModalityState>;

export const MediaSettings = z.object({
  modalities: z.array(MediaModalityState),
  /** The running total, per conversation, above which every further generation asks. */
  approvalThresholdUsd: z.number().nonnegative()
});
export type MediaSettings = z.infer<typeof MediaSettings>;

/**
 * The jobs an owner may point at a particular model.
 *
 * The first three drive a conversation, the four media ones make a file, and the last two are the
 * auxiliary calls a long task makes on its own account. Those two were routed automatically and
 * were not choosable, which is the gap: `summarise` in particular is not a small number - the
 * context rig records around a million summariser tokens per configuration, spent on a task's
 * longest and most expensive turns, and an owner who wants that on a specific cheap model had no
 * way to say so.
 *
 * Automatic remains the default for both and keeps exactly the behaviour they had: `compactionModel`
 * already picks the cheapest capable route on the task's own provider and privacy route, which is
 * the right answer when nobody has an opinion. What is new is being able to hold one.
 */
export const ModelPurpose = z.enum([
  'main',
  'specialist',
  'coding',
  'decisions',
  'image',
  'audio',
  'transcription',
  'video',
  'summarise',
  'title'
]);
export type ModelPurpose = z.infer<typeof ModelPurpose>;
export const PurposeModelChoice = MediaModelChoice.refine(
  (choice) => choice.automatic || choice.modelId.trim().length > 0,
  'Choose a model or automatic selection'
);
export type PurposeModelChoice = z.infer<typeof PurposeModelChoice>;
export const ProjectModelChoices = z
  .object({
    main: PurposeModelChoice.optional(),
    specialist: PurposeModelChoice.optional(),
    coding: PurposeModelChoice.optional(),
    decisions: PurposeModelChoice.optional(),
    image: PurposeModelChoice.optional(),
    audio: PurposeModelChoice.optional(),
    transcription: PurposeModelChoice.optional(),
    video: PurposeModelChoice.optional(),
    summarise: PurposeModelChoice.optional(),
    title: PurposeModelChoice.optional()
  })
  .strict();
export type ProjectModelChoices = z.infer<typeof ProjectModelChoices>;
export const UpdateProjectModelPreferences = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    choices: ProjectModelChoices
  })
  .strict();
export const ProjectModelPreferences = z.object({
  projectTaskId: z.union([Id, z.literal('')]),
  revision: z.number().int().nonnegative(),
  choices: ProjectModelChoices,
  purposes: z.array(
    z.object({
      purpose: ModelPurpose,
      source: z.enum(['project', 'global', 'automatic']),
      choice: PurposeModelChoice,
      available: z.boolean(),
      reason: z.string().nullable(),
      effective: z.union([MediaModelOption, ModelRelease]).nullable(),
      options: z.array(
        z.union([
          MediaModelOption,
          ModelRelease.extend({ unavailableReason: z.string().nullable().optional() })
        ])
      )
    })
  )
});
export type ProjectModelPreferences = z.infer<typeof ProjectModelPreferences>;

export const Approval = z.object({
  id: Id,
  taskId: Id,
  action: z.string(),
  origin: z.string().nullable(),
  sideEffect: SideEffectLevel,
  preview: z.string(),
  previewHash: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  expiresAt: IsoDate,
  createdAt: IsoDate
});
export type Approval = z.infer<typeof Approval>;

/**
 * How much of the owner's reason for a refusal travels with it.
 *
 * The same order as the model's own wording on the card (`agentWording`, 600), because the two are
 * read against each other: the agent gets a paragraph to say what it wants and the owner gets a
 * paragraph to say no to it. Longer is a conversation rather than a reason, and the channel this
 * rides on is the one that carries conversations anyway - so nothing is lost by keeping the box
 * the size of the thought it is for.
 */
export const APPROVAL_NOTE_MAX_CHARS = 600;

/**
 * Characters that let a note say one thing to the owner typing it and another to the model reading
 * it back: bidirectional overrides, zero-width marks, and the C0 controls that are not layout.
 *
 * The same class `approval-facts.ts` strips before it puts a hostile string in front of the owner,
 * pointed the other way. Tab and newline survive because a reason may reasonably be a short list.
 */
const APPROVAL_NOTE_UNSAFE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * The owner's reason, made safe to hand to a model, bounded, or empty if there was not one.
 *
 * Empty and absent are the same answer on purpose: a note of four spaces has to leave the denial
 * exactly as it was before this field existed, byte for byte and request for request, or every
 * owner who tabs through the card pays for a feature they did not use.
 */
export const approvalNoteText = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';
  const clean = value
    .replace(APPROVAL_NOTE_UNSAFE, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.length > APPROVAL_NOTE_MAX_CHARS
    ? `${clean.slice(0, APPROVAL_NOTE_MAX_CHARS)}…`
    : clean;
};

/**
 * A tool name, kept to the shape a tool name has, before it is put in a sentence.
 *
 * The name comes off the approval preview, which the worker writes - but the preview is the half
 * of the card the model's own `purpose` also lands in, and the one rule this whole card is built
 * on is that nothing model-authored gets to write owner-attributed prose. A name that is not a
 * name simply does not appear.
 */
const approvalToolWord = (value: string | null | undefined): string =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : '';

/**
 * The message a refusal sends back, said once, in the one place every layer reads it from.
 *
 * The refusal the model saw used to be four words - "The user denied this action" - and that was
 * the whole of what it learned. It could not tell "not that file" from "not right now" from "not
 * ever", so the next thing it did was try a neighbouring version of the thing that had just been
 * refused, and the owner answered the same question again wearing a slightly different costume. A
 * refusal with a reason on it is steering; a refusal without one is a wall to walk along.
 *
 * This is deliberately the owner's own sentence and not a harness notice about the owner. It is
 * carried on the channel that already exists for owner speech - a message to the conversation,
 * marked as a correction so the paused turn takes it at its next step boundary rather than after
 * it has already tried the neighbouring thing. That channel is encrypted with the workspace key,
 * lands in the transcript where the owner can see what they said, and is treated as owner speech
 * by the taint model and by the compaction rule that never paraphrases the user. A field bolted
 * onto the approval row would have had to earn all four of those again.
 *
 * So nothing is appended after the note. In a tool result the harness gets the last word because
 * the harness is speaking; here the owner is speaking, and putting instructions in their mouth is
 * how a product ends up disagreeing with its own user in their own voice.
 *
 * Empty when there is no reason, and callers send nothing at all in that case: a denial with no
 * note must cost exactly the requests a denial cost before this existed.
 *
 * One string in `contracts` rather than one in a client and one in the worker, for the reason
 * `MEDIA_VIDEO_UNAVAILABLE_REASON` above gives - which is itself the audit's own finding about
 * approvals: when a policy is written twice it is the stale copy that ends up winning.
 */
export const approvalDenialMessage = (input: {
  /** The tool the refused call was bound to, when the card knew it. */
  tool?: string | null;
  note?: string | null;
}): string => {
  const note = approvalNoteText(input.note);
  if (!note) return '';
  const tool = approvalToolWord(input.tool);
  return `I did not approve that ${tool ? `${tool} ` : ''}request. Here is why:\n\n${note}`;
};

/**
 * What a push to the owner's devices is about.
 *
 * The first three are derived by the server from state it can already see: an approval is pending,
 * a conversation reached a terminal status, a task stopped at a spending ceiling. Nothing decides
 * to send them, which is why a fifteen-minute watcher used to push "finished" ninety-six times a
 * day without ever saying whether anything had changed.
 *
 * The last two are raised by the agent, and they are the two moments only the agent knows about.
 * `agent_message` is the one it chose to send - the page moved, the build went red, the thing the
 * owner asked to be told about happened. `takeover_needed` is the agent stopped at something no
 * amount of retrying will clear, a bot check being the case that matters, where the work resumes
 * the moment a person takes the screen.
 */
export const NotificationKind = z.enum([
  'approval_required',
  'task_finished',
  'spend_paused',
  'agent_message',
  'takeover_needed'
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** The kinds the agent raises for itself. Nothing else may write a row of these. */
export const AgentNotificationKind = z.enum(['agent_message', 'takeover_needed']);
export type AgentNotificationKind = z.infer<typeof AgentNotificationKind>;

/**
 * One thing the agent chose to tell the owner, read back later.
 *
 * A push is a moment: it fires once, on whichever devices were subscribed, and is gone. This is
 * the record of what was said, across every conversation, for the owner who was asleep or whose
 * phone was off - which is the only place several days of a watcher's findings sit together.
 *
 * `message` always carries a sentence. When the workspace key cannot unwrap the one the agent
 * wrote, the server says so in the field rather than serving null: a null message is a row that
 * means nothing, and a client with nothing to render drops it - so the one row that says a
 * conversation has become unreadable is the row that would disappear. `taskTitle` is null in the
 * same case, because there is no honest stand-in for a name.
 */
export const AgentNotification = z.object({
  id: Id,
  taskId: Id,
  taskTitle: z.string().nullable(),
  kind: AgentNotificationKind,
  message: z.string().min(1),
  createdAt: IsoDate
});
export type AgentNotification = z.infer<typeof AgentNotification>;

/**
 * How many notifications one conversation may raise. A scheduled watcher gets a fresh task per
 * run, so this is generous for honest use and still bounds a loop that decides everything is
 * urgent - the failure the derived `task_finished` push had no way to stop.
 */
export const MAX_AGENT_NOTIFICATIONS_PER_TASK = 10;

export const ProviderSpendWindow = z.object({
  /** Settled provider cost inside the window, in the currency the provider bills. */
  used: z.number().nonnegative(),
  resetsAt: IsoDate
});

/**
 * What the owner's provider has actually charged, over the three periods the usage pane draws.
 *
 * There is no allowance here and no ceiling: the owner holds the account and pays the provider
 * directly, so the only limits that exist are the ones they set themselves, and those live on the
 * spend summary next to the caps they are measured against.
 */
export const ProviderSpend = z.object({
  windows: z.object({
    daily: ProviderSpendWindow,
    weekly: ProviderSpendWindow,
    monthly: ProviderSpendWindow
  })
});
export type ProviderSpend = z.infer<typeof ProviderSpend>;

/**
 * What this box has spent and stored so far this month.
 *
 * Credits are a scheduling unit: they price one task against another on the same machine. They
 * carried an "included" allowance and an overage limit until the last of the hosted shape came
 * out - both were fixed sentinels standing in for a plan nobody sells, and a ceiling that cannot
 * be reached is worse than no ceiling, because it reads like one. What actually stops a runaway is
 * the owner's own spend cap, in the currency the provider bills, on the spend summary.
 */
export const UsageSummary = z.object({
  periodStart: IsoDate,
  periodEnd: IsoDate,
  consumedCredits: z.number().nonnegative(),
  reservedCredits: z.number().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  storageLimitBytes: z.number().int().positive(),
  providerSpend: ProviderSpend
});
export type UsageSummary = z.infer<typeof UsageSummary>;

/**
 * Every ceiling below is denominated in the currency the provider actually bills. A compute credit
 * is a scheduling unit whose dollar value moves with the model class, so it can never answer "stop
 * before this costs me more than X"; these fields exist so that question has one answer.
 */
export const SpendWindowName = z.enum(['task', 'daily', 'monthly']);
export type SpendWindowName = z.infer<typeof SpendWindowName>;

export const SpendWindowState = z.enum(['ok', 'warning', 'exceeded']);
export type SpendWindowState = z.infer<typeof SpendWindowState>;

export const SpendWindow = z.object({
  name: SpendWindowName,
  /** Money the provider has already billed. Never inflated by anything still in flight. */
  spentUsd: z.number().nonnegative(),
  /** Unspent headroom already promised to work that is open but not finished. */
  pendingUsd: z.number().nonnegative(),
  /** Null means the owner has set no ceiling of this kind, so the window can only ever report. */
  capUsd: z.number().nonnegative().nullable(),
  /** The soft threshold as an amount rather than a percentage, so a client never re-derives it. */
  warnAtUsd: z.number().nonnegative().nullable(),
  /** spent + pending + the estimate this decision was asked about. */
  projectedUsd: z.number().nonnegative(),
  state: SpendWindowState,
  /** Null on the task window, which is bounded by the task rather than by wall-clock time. */
  startsAt: IsoDate.nullable(),
  endsAt: IsoDate.nullable()
});
export type SpendWindow = z.infer<typeof SpendWindow>;

export const SpendDecision = z.object({
  outcome: z.enum(['allow', 'warn', 'deny']),
  estimateUsd: z.number().nonnegative(),
  blockedBy: SpendWindowName.nullable(),
  warnedBy: z.array(SpendWindowName),
  reason: z.string().nullable(),
  windows: z.array(SpendWindow)
});
export type SpendDecision = z.infer<typeof SpendDecision>;

/** Current spending windows, checked with the paused request estimate when available. */
export const TaskSpendBlock = z.object({
  taskId: Id,
  /** When a ceiling stopped this run. Null for a task no ceiling stopped. */
  spendPausedAt: IsoDate.nullable(),
  estimateSource: z.enum(['paused_step', 'current_spend']),
  /** Whether the current windows can cover the estimate in this decision. */
  blocked: z.boolean(),
  decision: SpendDecision,
  /** The sentence the owner reads, built by the same function the halt itself used. */
  summary: z.string(),
  /**
   * True when what is blocking is a ceiling this box supplied because nobody had been asked, not
   * one the owner chose. The card says so, because "your limit" is not true of a default and an
   * owner who never set a limit should not be told they set one.
   */
  unchosen: z.boolean()
});
export type TaskSpendBlock = z.infer<typeof TaskSpendBlock>;

/**
 * Moving one run's own ceiling up. Only up: the route this reaches raises and never lowers, so a
 * stale card cannot tighten a limit somebody else has already moved.
 */
export const RaiseTaskSpendCeilingRequest = z.object({ maxSpendUsd: TaskSpendUsd });
export type RaiseTaskSpendCeilingRequest = z.infer<typeof RaiseTaskSpendCeilingRequest>;

export const SpendLimits = z.object({
  dailyCapUsd: CapUsd.nullable(),
  monthlyCapUsd: CapUsd.nullable(),
  /** Applied to a task that does not name its own ceiling, including every scheduled run. */
  defaultTaskCapUsd: TaskSpendUsd.nullable(),
  warnAtPercent: z.number().int().min(1).max(99),
  /** The IANA zone the daily and monthly windows roll over in, so "today" means the owner's day. */
  timeZone: z.string().min(1).max(100),
  /**
   * The owner's price ceiling, as two published rates, and the pre-flight half of the brake the
   * caps above are the running half of. A cap stops a task that is already spending; this stops an
   * over-priced route being chosen in the first place, which is the only one of the two that works
   * while the owner is asleep. `@athanor/core`'s `priceCeilingFields` turns these into the
   * `ModelRequest` fields `selectModel` reads; either may be null on its own.
   *
   * Still optional, and the reason is written down here because it looks like an oversight and is
   * not. Making them required is what sends the compiler round every producer of this shape, and
   * that was done: the only producer that omits them is `apps/web/src/usage-model.test.ts`, at its
   * two `SpendLimits` fixtures (around lines 61 and 400). The server's producer -
   * `effectiveSpendLimits` - has answered with both, as `number | null` and never `undefined`,
   * since the migration that added the columns. So the `.optional()` here now costs nothing at
   * runtime and buys one thing: `pnpm check` stays green in a wave where no lane may write under
   * `apps/web`. Drop it in the wave that owns that file, in the same commit that fills in the two
   * fixtures - it is a one-line change and this comment is the whole of the work.
   */
  maxInputUsdPerMillionTokens: PriceCeilingUsd.nullable().optional(),
  maxOutputUsdPerMillionTokens: PriceCeilingUsd.nullable().optional(),
  updatedAt: IsoDate
});
export type SpendLimits = z.infer<typeof SpendLimits>;

export const UpdateSpendLimitsRequest = z.object({
  dailyCapUsd: CapUsd.nullable().optional(),
  monthlyCapUsd: CapUsd.nullable().optional(),
  defaultTaskCapUsd: TaskSpendUsd.nullable().optional(),
  warnAtPercent: z.number().int().min(1).max(99).optional(),
  timeZone: z.string().min(1).max(100).optional(),
  maxInputUsdPerMillionTokens: PriceCeilingUsd.nullable().optional(),
  maxOutputUsdPerMillionTokens: PriceCeilingUsd.nullable().optional()
});
export type UpdateSpendLimitsRequest = z.input<typeof UpdateSpendLimitsRequest>;

export const SpendBucket = z.object({
  key: z.string(),
  costUsd: z.number().nonnegative(),
  calls: z.number().int().nonnegative()
});
export type SpendBucket = z.infer<typeof SpendBucket>;

export const SpendSummary = z.object({
  limits: SpendLimits,
  windows: z.array(SpendWindow),
  /** One entry per calendar day in the owner's zone, oldest first, gaps omitted. */
  byDay: z.array(SpendBucket),
  /** Keyed by the model the provider actually billed for, heaviest first. */
  byModel: z.array(SpendBucket),
  /** Keyed by task id, heaviest first: the answer to "what burned the money". */
  byTask: z.array(SpendBucket)
});
export type SpendSummary = z.infer<typeof SpendSummary>;

export const CreateWorkspaceRequest = z.object({
  name: z.string().min(1).max(80),
  storageLimitBytes: z
    .number()
    .int()
    .min(MIN_WORKSPACE_STORAGE_BYTES)
    .max(MAX_WORKSPACE_STORAGE_BYTES)
    .default(50 * WORKSPACE_STORAGE_GB_BYTES),
  region: z.string().default('local'),
  securityMode: SecurityMode.default('balanced')
});
export type CreateWorkspaceRequest = z.input<typeof CreateWorkspaceRequest>;

/**
 * Workspace-relative paths of files the owner attached to this message.
 *
 * They are carried beside the sentence rather than appended to it: an attachment is context for
 * the turn, not something the owner wrote, and a transcript that says what they typed is the only
 * one that can be read back to them honestly.
 */
export const MessageAttachments = z.array(z.string().trim().min(1).max(400)).max(20);
export type MessageAttachments = z.infer<typeof MessageAttachments>;

export const CreateTaskRequest = z.object({
  workspaceId: Id,
  projectId: Id.optional(),
  execution: z.enum(['independent', 'shared']).optional(),
  source: ConversationSource.optional(),
  prompt: z.string().min(1).max(200_000),
  title: z.string().min(1).max(TASK_TITLE_MAX_LENGTH).optional(),
  modelId: z.string().optional(),
  modelChoices: ProjectModelChoices.optional(),
  reasoningEffort: TaskReasoningEffort.optional(),
  privacyRoute: PrivacyRoute.default('provider_zdr'),
  securityMode: SecurityMode.optional(),
  maxComputeCredits: z.number().min(0.01).max(10_000).default(1),
  /** Omitted means "use the account default", not "unlimited". */
  maxSpendUsd: TaskSpendUsd.optional(),
  attachments: MessageAttachments.optional()
});
export type CreateTaskRequest = z.input<typeof CreateTaskRequest>;

export const ContinueTaskRequest = z.object({
  securityMode: SecurityMode.optional(),
  prompt: z.string().trim().min(1).max(200_000),
  modelId: z.string().optional(),
  reasoningEffort: TaskReasoningEffort.optional(),
  privacyRoute: PrivacyRoute.optional(),
  maxComputeCredits: z.number().min(0.01).max(10_000).default(1),
  maxSpendUsd: TaskSpendUsd.optional(),
  attachments: MessageAttachments.optional(),
  /**
   * Apply this to the turn already running instead of the one after it. Off by default: a
   * follow-up and a correction are different intentions, and deciding between them from the fact
   * that the task happens to be busy would get it wrong in one direction or the other.
   */
  interrupt: z.boolean().optional()
});
export type ContinueTaskRequest = z.input<typeof ContinueTaskRequest>;

export const TaskScheduleSpec = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    runAt: IsoDate
  }),
  z.object({
    kind: z.literal('interval'),
    everyMinutes: z.number().int().min(15).max(10_080)
  }),
  z.object({
    kind: z.literal('daily'),
    timeZone: z.string().min(1).max(100),
    localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  }),
  z.object({
    kind: z.literal('weekly'),
    timeZone: z.string().min(1).max(100),
    localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7)
  }),
  z.object({
    kind: z.literal('cron'),
    timeZone: z.string().min(1).max(100),
    expression: z
      .string()
      .trim()
      .min(9)
      .max(100)
      .regex(/^[A-Za-z0-9*/,\-\s]+$/)
  })
]);
export type TaskScheduleSpec = z.infer<typeof TaskScheduleSpec>;

/**
 * The one way work starts here that is neither the owner typing nor a clock.
 *
 * Verified before this existed: `TaskScheduleSpec` above was the whole answer to "what can begin a
 * turn", and every one of its five kinds is a clock. There was no webhook route, no signature
 * verification, no mail arrival, no file watch and no repository event anywhere in the tree - so an
 * owner who wanted "when my build fails, look at it" had to buy it with a poller, which pays a full
 * model turn on every occurrence to discover that nothing happened. That collides with the spend
 * ceiling this software is proudest of.
 *
 * DELIBERATELY NOT A SIXTH `kind`. That was the first design and it cannot be built from one place:
 * `nextScheduleRun` in @athanor/core reads `spec.timeZone` after narrowing away `once` and
 * `interval`, and `scheduleDescription` and `specKey` in the web client both fall through to
 * `spec.weekdays`. A sixth member makes all three stop compiling, and there is no shape for a
 * webhook that satisfies them without lying about what it is. So the trigger is orthogonal to the
 * timing rather than a case of it, which is also the truer statement: a schedule can have a clock,
 * a trigger, or both, and "both" is the case a kind could not have expressed at all.
 *
 * What it does NOT do: there is no trigger-only schedule. A schedule still carries a real clock
 * spec, so a purely inbound watcher costs one clock run at whatever cadence its spec names - set it
 * weekly and that is one run a week. Removing that needs the union member above and the three
 * call sites it breaks.
 *
 * ONE endpoint, one secret, one template, and no filter language: the payload is written to a file
 * and the standing instruction reads it. Per-vendor integrations are not here and are not planned.
 */
export const TaskScheduleTrigger = z.object({
  kind: z.literal('webhook'),
  /**
   * The shortest gap between two runs this trigger will start, in minutes.
   *
   * An inbound URL is a door onto the owner's provider account, so the thing that has to be bounded
   * is model turns per hour and not requests per hour. Fifteen is the floor `interval` already
   * uses - the same number, chosen for the same reason, so a trigger cannot start work more often
   * than the fastest clock this software offers. A burst of a thousand deliveries inside one gap
   * produces exactly one run, which reads all of them.
   */
  minGapMinutes: z.number().int().min(15).max(10_080).default(15)
});
export type TaskScheduleTrigger = z.infer<typeof TaskScheduleTrigger>;

/**
 * The prefix every inbound trigger URL sits under, and the directory every payload lands in.
 *
 * `INBOUND_QUARANTINE_DIRECTORY` is under `workspace/downloads/` on purpose and that is the whole
 * security argument for the payload: `DOWNLOAD_QUARANTINE_PREFIXES` in the worker's
 * `command-classification.ts` lists `'workspace/downloads/'`, and it is the one list `file_read`,
 * `document_read`, `image_read` and `shell` all consult - so a delivery read back from here taints
 * the turn exactly as a downloaded page does, with no new rule and no second list to drift. Move
 * this out from under that prefix and a stranger's bytes become the owner's own.
 */
export const INBOUND_TRIGGER_PATH_PREFIX = '/v1/hooks';
export const INBOUND_QUARANTINE_DIRECTORY = 'workspace/downloads/inbound';

export const TaskSchedule = z.object({
  id: Id,
  workspaceId: Id,
  title: z.string().min(1).max(160),
  /**
   * The standing instruction this box will carry out unattended.
   *
   * It was written at creation, sealed under the workspace key, and never answered with again - so
   * the one thing an owner most needs to read about a watcher that runs at three in the morning was
   * the one thing no client could show them. The title is a nine-word slug of it, which is a label
   * and not the instruction. A schedule whose prompt this server cannot decrypt answers with an
   * empty string rather than disappearing, for the same reason an unreadable notice is still listed.
   */
  prompt: z.string().max(200_000),
  modelId: z.string(),
  privacyRoute: PrivacyRoute,
  maxComputeCredits: z.number().positive(),
  maxSpendUsd: z.number().positive().nullable().default(null),
  spec: TaskScheduleSpec,
  /**
   * The inbound trigger attached to this schedule, or that there is none.
   *
   * Nullable with a null default so every client that has never heard of a trigger keeps parsing
   * every schedule it already parsed. `triggerUrlPath` is the path half of the URL a sender posts
   * to - the random part is 256 bits, so the URL is itself a bearer secret and is served only to
   * the owner. The SIGNING secret is not on this object at all: it is shown once, in the reply to
   * the request that created it, and this server keeps only a copy sealed under the workspace key.
   */
  /*
   * `.optional()` and not `.default(null)`, which reads like the same promise and is not: a default
   * makes the key optional going in and REQUIRED coming out, and `TaskSchedule` is `z.infer`, so
   * `scheduleResponseFields` in the API's `context.ts` - which does not know these fields exist -
   * would stop compiling. Optional keeps every existing producer of a `TaskSchedule` correct.
   */
  trigger: TaskScheduleTrigger.nullable().optional(),
  triggerUrlPath: z.string().nullable().optional(),
  enabled: z.boolean(),
  nextRunAt: IsoDate.nullable(),
  lastRunAt: IsoDate.nullable(),
  lastTaskId: Id.nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type TaskSchedule = z.infer<typeof TaskSchedule>;

export const CreateTaskScheduleRequest = z.object({
  workspaceId: Id,
  prompt: z.string().min(1).max(200_000),
  title: z.string().min(1).max(160).optional(),
  modelId: z.string().optional(),
  privacyRoute: PrivacyRoute.default('provider_zdr'),
  maxComputeCredits: z.number().min(0.01).max(10_000).default(1),
  maxSpendUsd: TaskSpendUsd.optional(),
  spec: TaskScheduleSpec,
  /**
   * Ask for an inbound URL as well as a clock. Omitted means the schedule has no door on it, which
   * is what every schedule that already exists has, so this changes nothing for a client that does
   * not send it.
   */
  trigger: TaskScheduleTrigger.optional()
});
export type CreateTaskScheduleRequest = z.input<typeof CreateTaskScheduleRequest>;

/**
 * Editing a schedule that already exists, which the README has promised since before this schema.
 *
 * Every key is optional and an omitted one is left exactly as it was: this is the only way to move
 * a watcher from nine o'clock to seven without retyping the instruction, and retyping it is how the
 * prompt gets shortened by accident. `modelId` and `privacyRoute` are declared and refused rather
 * than quietly dropped - `updateTaskSchedule` does not write those columns, and a request that says
 * "run this on the bigger model" and answers 200 having changed nothing is the defect this whole
 * pass exists to remove. They become editable when the store learns to write them.
 */
export const UpdateTaskScheduleRequest = z.object({
  title: z.string().min(1).max(160).optional(),
  prompt: z.string().min(1).max(200_000).optional(),
  spec: TaskScheduleSpec.optional(),
  maxComputeCredits: z.number().min(0.01).max(10_000).optional(),
  maxSpendUsd: TaskSpendUsd.nullable().optional(),
  modelId: z.string().min(1).max(200).optional(),
  privacyRoute: PrivacyRoute.optional()
});
export type UpdateTaskScheduleRequest = z.input<typeof UpdateTaskScheduleRequest>;

/**
 * A tab identity handed out by the runner. It is bound to the page itself, so it survives
 * navigation, reordering and other tabs closing — none of which is true of a strip position.
 */
export const BrowserTabId = z.string().min(1).max(32);
export type BrowserTabId = z.infer<typeof BrowserTabId>;

/**
 * Every page-directed action may name the tab it applies to. Omitting it means the active tab,
 * which is what a single-tab flow wants; naming one lets the agent work in a background tab
 * without bringing it to the front and disturbing what the user is watching.
 */
const tabScoped = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ ...shape, tabId: BrowserTabId.optional() });

/** Actions that can appear inside a batch: everything except a batch itself. */
export const BrowserPrimitiveAction = z.discriminatedUnion('type', [
  tabScoped({ type: z.literal('navigate'), url: z.string().url() }),
  tabScoped({ type: z.literal('click'), selector: z.string().min(1) }),
  tabScoped({ type: z.literal('double_click'), selector: z.string().min(1) }),
  tabScoped({ type: z.literal('hover'), selector: z.string().min(1) }),
  tabScoped({
    type: z.literal('click_at'),
    x: z.number().min(0).max(1440),
    y: z.number().min(0).max(900)
  }),
  tabScoped({
    type: z.literal('type'),
    selector: z.string().min(1),
    text: z.string().max(20_000),
    // `fill` sets the value in one shot; `keys` sends real keystrokes at human pace, which is
    // the only thing that wakes a typeahead, a masked input or a keydown validator. `auto`
    // lets the runner pick from what the control actually is.
    mode: z.enum(['auto', 'fill', 'keys']).default('auto')
  }),
  tabScoped({
    type: z.literal('select_option'),
    selector: z.string().min(1),
    // A multiple-select needs every chosen option in one call; one value is the common case.
    values: z.array(z.string().max(1_000)).min(1).max(50)
  }),
  tabScoped({
    type: z.literal('upload'),
    selector: z.string().min(1),
    // Workspace-relative paths only. The runner re-validates them against the same user-data
    // boundary as the file API, so this can never become a host-filesystem read primitive.
    paths: z.array(z.string().min(1).max(1_024)).min(1).max(10)
  }),
  tabScoped({ type: z.literal('text_input'), text: z.string().max(20_000) }),
  tabScoped({ type: z.literal('press'), key: z.string().min(1) }),
  tabScoped({
    type: z.literal('scroll'),
    // Without a target the wheel lands wherever the pointer happens to be; a ref scrolls the
    // container the agent actually means, such as a modal body or a virtualised list.
    selector: z.string().min(1).optional(),
    deltaX: z.number().min(-5_000).max(5_000).default(0),
    deltaY: z.number().min(-5_000).max(5_000)
  }),
  tabScoped({
    // Condition-based waiting. A fixed sleep is either a flake or dead time; every one of
    // these resolves the moment the page actually reaches the state the agent is waiting for.
    type: z.literal('wait_for'),
    selector: z.string().min(1).optional(),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible'),
    text: z.string().min(1).max(400).optional(),
    urlIncludes: z.string().min(1).max(2_000).optional(),
    timeoutMs: z.number().int().min(100).max(60_000).default(15_000)
  }),
  tabScoped({ type: z.literal('back') }),
  tabScoped({ type: z.literal('reload') }),
  z.object({
    type: z.literal('new_tab'),
    url: z.string().url().optional(),
    // A background tab lets the agent open a reference page without losing its place.
    activate: z.boolean().default(true)
  }),
  z.object({ type: z.literal('select_tab'), tabId: BrowserTabId }),
  z.object({ type: z.literal('close_tab'), tabId: BrowserTabId }),
  // Reads a named tab in place: no bring-to-front, no change of active tab.
  z.object({ type: z.literal('inspect_tab'), tabId: BrowserTabId }),
  // The page as a PNG, kept in the workspace. Workspace-relative like an upload path, and for the
  // same reason: the runner judges the name against a concrete root and refuses what leaves it.
  tabScoped({ type: z.literal('screenshot'), path: z.string().min(1).max(1_024) }),
  z.object({
    type: z.literal('dialog'),
    response: z.enum(['accept', 'dismiss']),
    promptText: z.string().max(4_000).optional()
  })
]);
export type BrowserPrimitiveAction = z.infer<typeof BrowserPrimitiveAction>;

export const BrowserAction = z.discriminatedUnion('type', [
  ...BrowserPrimitiveAction.options,
  z.object({
    // One round trip for a whole form. Steps run in order, stop at the first failure, and
    // report individually, so a batch is never less legible than the calls it replaces.
    type: z.literal('batch'),
    actions: z.array(BrowserPrimitiveAction).min(1).max(24)
  })
]);
export type BrowserAction = z.infer<typeof BrowserAction>;

/**
 * Public pages read as documents, in throwaway browsers of their own.
 *
 * One URL or a batch, because the same capability is called both ways and must present the same
 * name either way. A provider-side fetch takes one URL per call and is called several times within
 * a turn; athanor's own route takes the batch and opens up to twelve browsers at once. If those
 * were two differently named tools the model would be choosing between two descriptions of one
 * thing, and the name would change under it whenever the privacy route did - so the schema accepts
 * both shapes and the difference stops at this boundary.
 */
export const WebFetchRequest = z
  .object({
    url: z.string().url().optional(),
    urls: z.array(z.string().url()).max(12).default([]),
    maxCharactersPerPage: z.number().int().min(1_000).max(20_000).default(12_000)
  })
  .transform((value) => ({
    urls: [...(value.url === undefined ? [] : [value.url]), ...value.urls].slice(0, 12),
    maxCharactersPerPage: value.maxCharactersPerPage
  }))
  .refine((value) => value.urls.length > 0, {
    message: 'A web fetch needs at least one URL'
  });
export type WebFetchRequest = z.input<typeof WebFetchRequest>;

export const DesktopHolder = z.enum(['agent', 'user', 'secure_input']);
export type DesktopHolder = z.infer<typeof DesktopHolder>;

export const DesktopAction = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('invoke'),
    nodeId: z.string().min(1).max(512),
    actionIndex: z.number().int().nonnegative().max(100).default(0)
  }),
  z.object({ type: z.literal('focus'), nodeId: z.string().min(1).max(512) }),
  z.object({
    type: z.literal('set_text'),
    nodeId: z.string().min(1).max(512),
    text: z.string().max(200_000)
  }),
  z.object({
    type: z.literal('click_at'),
    x: z.number().min(0).max(1440),
    y: z.number().min(0).max(900),
    button: z.enum(['left', 'middle', 'right']).default('left'),
    clicks: z.number().int().min(1).max(3).default(1)
  }),
  z.object({
    type: z.literal('drag'),
    fromX: z.number().min(0).max(1440),
    fromY: z.number().min(0).max(900),
    toX: z.number().min(0).max(1440),
    toY: z.number().min(0).max(900),
    durationMs: z.number().int().min(50).max(10_000).default(500)
  }),
  z.object({ type: z.literal('press'), key: z.string().min(1).max(100) }),
  z.object({ type: z.literal('text_input'), text: z.string().max(200_000) }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(100).default(3)
  }),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(50).max(30_000) }),
  /**
   * A closer look at one rectangle of the screen, in the same coordinates every other action uses.
   *
   * The agent's still is reduced to fit a bounded image, so a checkbox or a small toolbar button
   * arrives a few pixels across and clicking it is a guess. This returns those pixels at their own
   * size instead of the whole screen shrunk, which is the largest single accuracy gain available on
   * this surface and costs one more screenshot.
   *
   * The maxima below are the coordinate box, not a promise about the answer: a rectangle asking
   * for more pixels than a whole screenshot carries is reduced back into that box before it is
   * sent (`stillCaptureArguments`), because a closer look larger than the picture it is a closer
   * look at buys no detail and is resampled at the far end anyway. What nothing says is that it
   * happened - a model that zooms the whole screen gets what it would have got from observing,
   * and is not told the rectangle was too big to be a zoom.
   */
  z.object({
    type: z.literal('zoom'),
    x: z.number().min(0).max(1440),
    y: z.number().min(0).max(900),
    width: z.number().min(16).max(1440),
    height: z.number().min(16).max(900)
  })
]);
export type DesktopAction = z.infer<typeof DesktopAction>;

export const DesktopLaunchRequest = z.object({
  executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(100_000)).max(256).default([]),
  cwd: z.string().default('workspace'),
  env: z.record(z.string(), z.string()).default({})
});
export type DesktopLaunchRequest = z.infer<typeof DesktopLaunchRequest>;

/**
 * Whether this box actually has the two surfaces the largest tool schemas describe.
 *
 * Three states, not two, and the third is the whole point. `absent` is a probe that ran and found
 * nothing; `unknown` is a probe that could not be run or could not be believed - an unreachable
 * runner, a malformed body, a route an older runner does not serve. Only `absent` is ever allowed
 * to withdraw a schema, because the two directions of being wrong are not the same size: withdrawing
 * wrongly hides a capability the box has and the model then cannot see it at all, while describing
 * wrongly costs bytes on a request and one honest failure the model can read. @see surfaceDescribable.
 */
export const SurfacePresence = z.enum(['available', 'absent', 'unknown']);
export type SurfacePresence = z.infer<typeof SurfacePresence>;

/**
 * The runner's answer, and the worker's copy of it. One shape on both sides of the wire so a field
 * added here cannot be read under a different name at the other end.
 */
export const WorkspaceSurfaces = z.object({
  /** A Chromium the browser manager could actually launch. */
  browser: SurfacePresence,
  /** The Xvfb/Openbox session and its accessibility bridge, both present and executable. */
  desktop: SurfacePresence
});
export type WorkspaceSurfaces = z.infer<typeof WorkspaceSurfaces>;

/**
 * What a caller that could not ask, or could not understand the answer, must use.
 *
 * A constant rather than a literal at each catch site: this is the fail-safe direction, and a
 * second spelling of it somewhere is how one call site ends up failing the other way.
 */
export const UNKNOWN_SURFACES: WorkspaceSurfaces = { browser: 'unknown', desktop: 'unknown' };

/**
 * Whether a surface may still be described to the model. The single place the safe direction is
 * decided, so "unknown means send everything" is one function both call sites read rather than two
 * conditions that have to agree.
 */
export const surfaceDescribable = (presence: SurfacePresence): boolean => presence !== 'absent';

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional()
  })
});

/**
 * Choices that follow the owner from device to device.
 *
 * Open at the top level on purpose - the set grows, and an older build reading a newer row should
 * ignore what it does not know rather than refuse the whole object - but each key it does know is
 * validated, so a device cannot write a shape another device will choke on.
 */
/**
 * How this account picks between the companies serving one model on an aggregator.
 *
 * It lists several for most models at different prices and wildly different speeds, and its own
 * default picks among the cheapest weighted by the inverse square of price - the wrong objective
 * for an agent, whose turn is dozens of sequential calls.
 *
 * Both halves of the rule are applied by the aggregator: it compares each company's throughput
 * against the floor using figures taken across every request it has ever served, then orders what
 * clears it by price. This account supplies the floor, as a share rather than a rate.
 */
export const ProviderRouting = z.object({
  /**
   * - `cheapest_fast_enough` is the default and the only one of the three that trades: of the
   *   companies fast enough to be worth using, take the cheapest.
   * - `fastest` ignores price. Worth it on work whose cost is the owner's attention.
   * - `cheapest` ignores speed, and is the aggregator's own default made explicit.
   */
  objective: z
    .enum(['cheapest_fast_enough', 'fastest', 'cheapest'])
    .default('cheapest_fast_enough'),
  /**
   * How slow a company may be, as a percentage of the fastest one serving that model, and still be
   * worth its lower price.
   *
   * A share and never a rate. Models differ by more than an order of magnitude in what their
   * quickest company achieves, so a fixed tokens-per-second floor would deprioritise every endpoint
   * of a model whose best is below it - and a price sort over a wholly deprioritised field returns
   * the cheapest, which is the aggregator's own default and the exact behaviour this replaces. A
   * fixed floor fails silently into the old defect; a share cannot.
   */
  throughputFloorPercent: z.number().int().min(0).max(100).default(40),
  /** Companies this account will not be served by, whatever they charge. */
  ignoredProviders: z.array(z.string().trim().min(1).max(60)).max(30).default([])
});
export type ProviderRouting = z.infer<typeof ProviderRouting>;

export const OwnerPreferences = z.object({
  /** @see ProviderRouting - absent means the defaults, which is the owner's rule unchanged. */
  providerRouting: ProviderRouting.optional(),
  modelPurposes: z
    .object({
      specialist: PurposeModelChoice.optional(),
      coding: PurposeModelChoice.optional(),
      decisions: PurposeModelChoice.optional(),
      summarise: PurposeModelChoice.optional(),
      title: PurposeModelChoice.optional()
    })
    .optional(),
  model: z
    .object({
      automatic: z.boolean(),
      preference: z.enum(['fast', 'balanced', 'best']),
      modelId: z.string().max(300)
    })
    .optional(),
  /**
   * Which conversation, on which computer, the owner had open.
   *
   * Held here rather than in the address bar, because the address bar is the one place a second
   * device cannot see. Installed to a home screen the app launches at `/` with no query at all, so
   * every launch landed on a blank new conversation however long the owner had spent in an old one
   * - the opposite of picking up where they left off, on the device most likely to be picked up.
   *
   * Nullable rather than absent when there is no conversation: a new conversation is a real place to
   * be, and the owner who deliberately left one should not be returned to it by the next device.
   */
  place: z
    .object({
      taskId: Id.nullish(),
      workspaceId: Id.nullish()
    })
    .optional(),
  /**
   * Whether the computer panel is open, and on which tab.
   *
   * A device-local choice until now, which made it one of the few things about this software that
   * was a fact about a browser rather than about its owner: open the files on the laptop, pick the
   * phone up, and the phone had its own idea. On a computer whose whole point is being the same
   * computer from anywhere, a panel that does not travel is not a setting.
   */
  inspector: z
    .object({
      open: z.boolean(),
      tab: z.enum(['files', 'computer', 'terminal', 'preview'])
    })
    .optional()
});
export type OwnerPreferences = z.infer<typeof OwnerPreferences>;

export const DirectionContext = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selection'), text: z.string().min(1).max(12_000) }),
  z.object({
    kind: z.literal('analysis'),
    workspaceId: Id,
    manifestPath: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (path) =>
          path.startsWith('workspace/') &&
          !path.includes('\\') &&
          !Array.from(path).some((character) => character.charCodeAt(0) < 32) &&
          !path.split('/').some((part) => part === '..' || part === '.' || part === '')
      ),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    runId: Id,
    name: z.string().max(200)
  })
]);
export type DirectionContext = z.infer<typeof DirectionContext>;

/** A half-typed message, saved against the conversation it belongs to, or none for a new one. */
export const SaveDraftRequest = z.object({
  workspaceId: Id,
  expectedRevision: z.number().int().nonnegative().default(0),
  taskId: Id.nullish(),
  body: z.string().max(200_000),
  controls: z
    .object({
      modelId: z.string().max(300),
      context: DirectionContext.optional(),
      conversation: z
        .object({
          projectId: Id,
          execution: z.enum(['independent', 'shared']),
          source: ConversationSource.optional()
        })
        .optional(),
      modelChoices: ProjectModelChoices.optional(),
      reasoningEffort: TaskReasoningEffort,
      securityMode: SecurityMode.optional(),
      privacyRoute: PrivacyRoute,
      spendCap: z.string().max(32)
    })
    .optional(),
  /**
   * The files already uploaded against this half-written message.
   *
   * They were held in the composer's own memory and nowhere else, so a message that was mostly its
   * attachments synced as an empty draft: the other device saw the sentence and none of the files,
   * and switching conversation on the first device dropped them there too while leaving the
   * uploaded bytes on the agent computer with nothing referring to them.
   *
   * Only the durable facts travel. Upload progress and a locally-made thumbnail belong to the
   * device that did the uploading.
   */
  attachments: z
    .array(
      z.object({
        path: z.string().min(1).max(1_024),
        name: z.string().min(1).max(240),
        sizeBytes: z.number().int().nonnegative(),
        mimeType: z.string().max(255)
      })
    )
    .max(50)
    .optional()
});
export type SaveDraftRequest = z.input<typeof SaveDraftRequest>;

export const ApiTokenScope = z.enum([
  'workspaces:read',
  'workspaces:write',
  'tasks:read',
  'tasks:write',
  'files:read',
  'files:write',
  'approvals:read',
  'approvals:write',
  'models:read',
  'usage:read',
  'connectors:read'
]);
export type ApiTokenScope = z.infer<typeof ApiTokenScope>;

export const ApiToken = z.object({
  id: Id,
  label: z.string().min(1).max(80),
  prefix: z.string(),
  scopes: z.array(ApiTokenScope),
  lastUsedAt: IsoDate.nullable(),
  expiresAt: IsoDate,
  createdAt: IsoDate
});
export type ApiToken = z.infer<typeof ApiToken>;

export const CreateApiTokenRequest = z.object({
  label: z.string().trim().min(1).max(80),
  scopes: z.array(ApiTokenScope).min(1).max(ApiTokenScope.options.length),
  expiresInDays: z.number().int().min(1).max(365).default(90)
});
export type CreateApiTokenRequest = z.input<typeof CreateApiTokenRequest>;

/**
 * What the runner answers a parallel web read with.
 *
 * Declared here because it is a wire shape between two packages that were each guessing at it
 * separately. The runner sent `sources`; all three readers in the worker asked for `pages` and got
 * nothing, silently - a turn never learnt the hosts it had just read and asked the owner to approve
 * the same one again, the untrusted-content label lost its host names, and an acceptance check
 * comparing a quoted span against a web source compared it against an empty string. A shape both
 * sides name from one place turns that into a build failure.
 */
export interface ResearchReadSource {
  requestedUrl: string;
  /** The address actually read, after redirects. Absent when the source could not be read. */
  url?: string;
  title?: string;
  text?: string;
  /** Set only on the retry, so a source that needed scripting is legible as such in the answer. */
  renderedWithScripts?: true;
  error?: string;
}

export interface ParallelWebReadResult {
  sources: ResearchReadSource[];
  requested: number;
  read: number;
}

/**
 * Which build of athanor is running.
 *
 * Both halves are needed and neither is enough. The version is the number a person can say out
 * loud, the one the install command pins and the one a release is cut at - but it does not move
 * between releases, so two boxes that are weeks apart on `main` both call themselves 0.1.1 and an
 * owner asking whether `athanor update` changed anything gets the same answer either way. The
 * revision moves with every commit and settles that, and on its own it means nothing to anybody
 * who is not holding the repository.
 *
 * The revision is nullable because it can honestly be unknown - a tree without its git metadata is
 * still a running box - and saying so is the point. A field that fell back to a plausible-looking
 * value would be a build identity that lies, which is worse than none at all.
 */
export const BuildIdentity = z.object({
  version: z.string(),
  commit: z.string().nullable()
});
export type BuildIdentity = z.infer<typeof BuildIdentity>;

/** The two halves said in one breath, so the journal, the API and Settings word it the same way. */
export const buildLabel = (build: BuildIdentity): string =>
  build.commit ? `${build.version} (${build.commit})` : build.version;

/**
 * The whole of one thing the computer wrote down about its owner.
 *
 * The review queue and the remembered list both show `memoryExcerpt(body, '', {maxChars: 200})`,
 * and both said on screen that an opening is all they had — honest, and not the same promise as
 * "read the whole of what was remembered about you". The rest was on the owner's own disk,
 * decryptable with a key the same request already derives, and no route reached it.
 *
 * Declared here rather than in either half because both halves have to agree on what a row that
 * cannot be decrypted looks like. `body` is what the route could read; `readable` is false when the
 * key would not open the record, and then `body` carries the same standing sentence the lists use
 * rather than an empty string, because a blank expander reads as "nothing was remembered" — the
 * opposite of what is true.
 */
export const MemoryItemBody = z.object({
  id: Id,
  title: z.string().nullable(),
  body: z.string(),
  readable: z.boolean()
});
export type MemoryItemBody = z.infer<typeof MemoryItemBody>;

export * from './debugger.js';
export * from './dictation.js';
export * from './voice.js';
export * from './processes.js';
export type * from './directories.js';
export * from './project-updates.js';

export * from './project-sessions.js';

export * from './workflows.js';
export { ProjectStorageUsage } from './project-storage.js';
export { ProjectRetentionSelection, ProjectRetentionApply } from './project-retention.js';
export type {
  ProjectRetentionPreview,
  ProjectVersionArchive,
  ProjectRetentionResult
} from './project-retention.js';

export * from './project-purge.js';

export * from './project-git-remote.js';
