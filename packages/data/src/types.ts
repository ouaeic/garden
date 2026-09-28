import type { EncryptedEnvelope } from '@garden/core';
import type {
  AgentNotificationKind,
  ApiTokenScope,
  ConnectorKind,
  ConnectorScope,
  NotificationKind,
  TaskEventKind,
  TaskReasoningEffort,
  TaskScheduleSpec
} from '@garden/contracts';
import type { SecurityMode } from '@garden/contracts';

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  recoveryHash: string | null;
  /**
   * Choices that belong to the owner rather than to whichever browser they are sitting at. Stored
   * as an open object because the set grows; every reader validates the shape it wants and ignores
   * the rest, so a row written by a newer build is readable by an older one.
   */
  preferences: Record<string, unknown>;
  createdAt: string;
}

export interface ManagedProviderCredentialRecord {
  userId: string;
  provider: string;
  secretCiphertext: EncryptedEnvelope;
  externalRef: string;
  monthlyLimitUsd: number;
  status: 'active' | 'disabled' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface PasskeyRecord {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
}

export interface ApiTokenRecord {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  scopes: ApiTokenScope[];
  lastUsedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface WorkspaceRecord {
  parentWorkspaceId?: string;
  projectTaskId?: string;
  id: string;
  userId: string;
  name: string;
  status: string;
  storageBytes: number;
  storageLimitBytes: number;
  imageRevision: string;
  region: string;
  keyProtection: 'hosted';
  securityMode: SecurityMode;
  runnerRef: string | null;
  computeMeteredAt: string | null;
  wrappedKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  projectId?: string;
  modelOverride?: boolean;
  modelPreferencesRevision?: number;
  modelChoicesCiphertext?: EncryptedEnvelope | null;
  conversationSourceCiphertext?: EncryptedEnvelope | null;
  /** Current delivery read model, populated in one aggregate for a requested task page. */
  deliveryStatus?: 'pending' | 'ready' | 'incomplete' | null;
  pendingDeliveryCount?: number;
  id: string;
  userId: string;
  workspaceId: string;
  parentTaskId: string | null;
  parentMissionId?: string | null;
  hasCodingFamily?: boolean;
  branchedFromEventId: string | null;
  forkKind: 'branch' | 'edit' | 'retry' | null;
  /**
   * The schedule that minted this task, or null for one the owner started. Provenance rather than a
   * live reference: it outlives the schedule row, because the runs it names are conversations the
   * owner keeps after they turn the schedule off.
   */
  scheduleId: string | null;
  /** How far the fork that created this task reached back. Null for a task nobody rewound into. */
  rewindScope: 'conversation' | 'computer' | 'both' | null;
  restoredCheckpointId: string | null;
  titleCiphertext: EncryptedEnvelope | null;
  legacyTitle: string | null;
  /**
   * Who named this conversation. `prompt` is a temporary name awaiting a generated title and is
   * the only value the titler is allowed to replace.
   */
  titleSource: 'prompt' | 'generated' | 'owner';
  /** Held above the recency buckets in the sidebar. */
  pinned: boolean;
  /** When the owner filed this conversation away. Null for one still in the sidebar. */
  archivedAt: string | null;
  status: string;
  modelId: string;
  reasoningEffort?: TaskReasoningEffort;
  privacyRoute: string;
  securityMode: SecurityMode;
  maxComputeCredits: number;
  actualComputeCredits: number;
  /** Ceiling in real currency. Null means only the account-level caps bound this task. */
  maxSpendUsd: number | null;
  /**
   * Settled provider cost for this task. The owner-facing reads carry it; a row returned by a
   * write or a lease reports zero rather than a number nobody computed.
   */
  spentUsd: number;
  /**
   * When a spending ceiling stopped this task, or null for a task nobody's ceiling stopped.
   *
   * The column has always existed and only the notification query ever read it, so every
   * owner-facing read handed back a `paused` with no way to tell a money stop from a Pause the
   * owner pressed - which is how a run stopped on a ceiling looked like it had stopped for no
   * reason, and how Resume looked broken when it re-queued into the same ceiling a step later.
   */
  spendPausedAt?: string | null;
  /**
   * When this run reached a terminal state, cleared when a follow-up re-queues it.
   *
   * The column has been written by every terminal transition for as long as it has existed and read
   * by nothing outside the store, so the only end-time a client could reach for was `updatedAt` -
   * which moves when a conversation is renamed, pinned or shared. A run's duration measured that way
   * grows every time the owner touches it.
   */
  completedAt?: string | null;
  queuedMessageCount: number;
  hasOpenQuestion?: boolean;
  /**
   * Live share links - neither revoked nor expired. Optional on the record rather than zero,
   * because the worker builds task records by hand in its own tests and a field it has no reason
   * to know about must not be a field it has to name; every reader treats absent as none.
   */
  shareCount?: number;
  promptCiphertext: EncryptedEnvelope;
  agentStateCiphertext: EncryptedEnvelope | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCheckpointRecord {
  id: string;
  userId: string;
  workspaceId: string;
  taskId: string | null;
  turn: number;
  /** Highest task-event sequence reached when this was taken; null for a checkpoint outside a task. */
  eventSequence: number | null;
  mechanism: 'btrfs' | 'zfs' | 'content';
  /** Null for a filesystem snapshot, which counts nothing - that is why it is instant. */
  fileCount: number | null;
  totalBytes: number | null;
  storedBytes: number;
  durationMs: number;
  createdAt: string;
}

export interface TaskMessageQueueRecord {
  securityMode?: TaskRecord['securityMode'];
  id: string;
  /** A denial correction retains the active task's settings and allocation. */
  approvalId?: string;
  taskId: string;
  userId: string;
  promptCiphertext: EncryptedEnvelope;
  modelId: string;
  reasoningEffort?: TaskReasoningEffort;
  privacyRoute: string;
  maxComputeCredits: number;
  maxSpendUsd: number | null;
  resourceClass: string;
  reservationKey: string;
  /** `undelivered` is a message the conversation stopped for good before it could be started. */
  status: 'queued' | 'promoted' | 'cancelled' | 'undelivered';
  /** The owner wants this applied to the turn already running, not the one after it. */
  interrupt: boolean;
  createdAt: string;
  promotedAt: string | null;
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  sequence: number;
  kind: TaskEventKind;
  summary: string;
  payloadCiphertext: EncryptedEnvelope | null;
  createdAt: string;
}

export interface TaskPlanRecord {
  id: string;
  taskId: string;
  version: number;
  parentVersion: number | null;
  branchName: string;
  stepsCiphertext: EncryptedEnvelope;
  createdBy: 'agent' | 'user';
  createdAt: string;
}

export interface WorkspaceMemoryRecord {
  id: string;
  userId: string;
  /** NULL on an owner-tier row, which belongs to the person and to no workspace. */
  workspaceId: string | null;
  target: 'workspace' | 'user';
  /**
   * Which key sealed `contentCiphertext`, in the clear because the reader has to choose a key
   * before it can open anything. `'workspace'` is the workspace data key under
   * `workspace-memory:${workspaceId}`; `'user'` is `userMemoryKey(master, userId)` under
   * `userMemoryAad(userId)`. Rows written before migration 70 are all `'workspace'`, including
   * `target: 'user'` ones, because a migration cannot re-encrypt.
   */
  keyScope: 'workspace' | 'user';
  contentCiphertext: EncryptedEnvelope;
  /**
   * Mirrors the expiry inside the encrypted document. Kept in the clear because retention has to
   * find expired rows without the workspace key, which only a signed-in owner ever holds.
   */
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSkillRecord {
  id: string;
  userId: string;
  workspaceId: string;
  nameHash: string;
  documentCiphertext: EncryptedEnvelope;
  version: number;
  enabled: boolean;
  status: 'active' | 'stale' | 'archived';
  pinned: boolean;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskScheduleRecord {
  id: string;
  userId: string;
  workspaceId: string;
  titleCiphertext: EncryptedEnvelope;
  promptCiphertext: EncryptedEnvelope;
  modelId: string;
  privacyRoute: string;
  maxComputeCredits: number;
  maxSpendUsd: number | null;
  spec: TaskScheduleSpec;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: string | null;
  lastErrorCode: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorRecord {
  id: string;
  userId: string;
  kind: ConnectorKind;
  authMode: 'secret' | 'none' | 'bearer' | 'oauth';
  label: string;
  baseUrl: string;
  scopes: ConnectorScope[];
  secretCiphertext: EncryptedEnvelope;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorOAuthAttemptRecord {
  id: string;
  userId: string;
  label: string;
  baseUrl: string;
  scopes: ConnectorScope[];
  stateHash: string;
  secretCiphertext: EncryptedEnvelope;
  expiresAt: string;
  createdAt: string;
}

export interface ConnectorAuditRecord {
  id: string;
  connectorId: string;
  taskId: string | null;
  operation: string;
  outcome: 'succeeded' | 'failed' | 'denied';
  statusCode: number | null;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  createdAt: string;
}

export interface WorkspacePreviewRecord {
  id: string;
  userId: string;
  workspaceId: string;
  label: string;
  port: number;
  slug: string;
  accessTokenHash: string;
  /** Where inside the served port the owner should land; null when its root is the app. */
  entryPath: string | null;
  visibility: 'private' | 'public';
  /*
   * There is no `customDomain` here, and there are no `domainStatus` or `domainVerificationHash`
   * beside it. All three were columns on `workspace_previews` from migration 25 that no statement
   * in this repository ever wrote, lifted onto this record and served on every preview response as
   * a null - which reads as "no custom domain is configured" rather than as "this build does not do
   * custom domains". Migration 69 drops the columns, the same way migration 51 dropped
   * `hosting_mode` from this table for the same reason. If custom domains are built, they arrive
   * with a writer, a route and a contract field, not with three fields that were already here.
   */
  status: 'active' | 'revoked';
  expiresAt: string | null;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One link to a frozen, encrypted copy of a conversation.
 *
 * `lookupHash` is the SHA-256 of the link's path segment and is the only thing the box holds that
 * relates to the link; the key that opens `envelope` is in the link's fragment and nowhere here.
 * `manifest` says how many artifacts ride with it and how large each is - names and types are
 * inside the envelope.
 */
export interface TaskShareRecord {
  id: string;
  userId: string;
  taskId: string;
  workspaceId: string;
  lookupHash: string;
  envelope: EncryptedEnvelope;
  manifest: Array<{ n: number; sizeBytes: number }>;
  snapshotBytes: number;
  version: number;
  expiresAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The sealed bytes of one shared artifact, and the public half of the envelope that seals them. */
export interface TaskShareArtifactRecord {
  shareId: string;
  n: number;
  envelopeMeta: Omit<EncryptedEnvelope, 'ciphertext'>;
  ciphertext: Buffer;
  sizeBytes: number;
}

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentNotificationRecord {
  id: string;
  userId: string;
  taskId: string;
  kind: AgentNotificationKind;
  messageCiphertext: EncryptedEnvelope;
  createdAt: string;
}

/**
 * What a pending row says about the event, whichever way it is about to travel. The two row shapes
 * below share this and differ only in the target: a device's push subscription, or a destination
 * the owner paired.
 */
export interface PendingNotificationEvent {
  kind: NotificationKind;
  resourceId: string;
  taskId: string;
  taskStatus: string | null;
  /**
   * When the thing being reported happened - the approval was raised, the task reached its final
   * status, the agent asked for the owner. The staleness horizon is measured from this, so it is
   * carried rather than re-derived from whichever row the sender happens to be able to read.
   */
  eventAt: string;
  /**
   * The conversation's own name, decrypted by the data layer because it is the only place holding
   * both the envelope and the workspace key. Null when the caller asked for pending work without
   * supplying a master key, or when this particular title could not be read.
   */
  taskTitle: string | null;
  /**
   * What the agent asked to have said, decrypted alongside the title and for the same reason. Null
   * for every kind the server derives rather than the agent raising, which carry no sentence of
   * their own.
   */
  message: string | null;
}

/** A pending row addressed to one device, carrying what Web Push needs to reach it. */
export interface PendingPushRow extends PushSubscriptionRecord, PendingNotificationEvent {
  transport: 'push';
}

/**
 * What the API seals into a destination row: the bot token the notifier sends with, the bot's
 * username for the pairing link, and the loopback API token an answer typed on the phone is
 * posted with, so a reply reaches the same route the web client uses and inherits its checks.
 */
export interface NotificationDestinationConfig {
  botToken: string;
  botUsername: string;
  apiToken?: string;
  apiTokenId?: string;
}

/** A pending row addressed to a paired destination rather than a device. */
export interface PendingDestinationRow extends PendingNotificationEvent {
  transport: 'telegram';
  /** The destination's id, which is what its ledger and its retry state are keyed by. */
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The numeric sender the owner paired with, which is also the private chat to send to. Sealed
   * at rest like the token: null without a master key, and null when it will not open.
   */
  senderId: string | null;
  /** Title and link only. The default, because the service in between is not end-to-end encrypted. */
  redact: boolean;
  /** Null without a master key, and null when the row will not decrypt - never sent then. */
  config: NotificationDestinationConfig | null;
}

export type PendingNotificationRecord = PendingPushRow | PendingDestinationRow;

export interface NotificationDestinationRecord {
  id: string;
  userId: string;
  kind: 'telegram';
  /** Decrypted only when the caller passed a master key and the envelope opened; null otherwise. */
  config: NotificationDestinationConfig | null;
  /** The bot's username, read from the sealed config; null when it could not be. */
  botUsername: string | null;
  /** The paired sender, opened only for a caller holding the master key; null otherwise. */
  senderId: string | null;
  /** Internal: the SHA-256 of the one-time pairing secret. Never served by a route. */
  pairingHash: string | null;
  pairingExpiresAt: string | null;
  /** True while a minted pairing secret is still inside its window and unused. */
  pairingPending: boolean;
  lastUpdateId: number | null;
  redact: boolean;
  createdAt: string;
  verifiedAt: string | null;
  disabledAt: string | null;
  updatedAt: string;
}

/** One row of the destination ledger, decorated with what the outcome sweep needs. */
export interface DestinationDeliveryRecord {
  destinationId: string;
  kind: NotificationKind;
  resourceId: string;
  externalRef: string | null;
  nonce: string | null;
  deliveredAt: string;
  outcomeAt: string | null;
  /** The conversation the resource belongs to, when the join could find it. */
  taskId: string | null;
  /** For an approval row: its current status. Null for every other kind. */
  approvalStatus: string | null;
  /** The owner of the destination, so a handler can bind the outcome to them. */
  userId: string;
  senderId: string | null;
}

export interface SpendLimitsRecord {
  userId: string;
  dailyCapUsd: number | null;
  monthlyCapUsd: number | null;
  defaultTaskCapUsd: number | null;
  warnAtPercent: number;
  timeZone: string;
  /**
   * The owner's price ceiling, as two published rates. The caps above stop a task that is already
   * spending; these stop an over-priced route being chosen at all. Null is "no ceiling" and zero is
   * "only a route that publishes no charge", and they are different states.
   */
  maxInputUsdPerMillionTokens: number | null;
  maxOutputUsdPerMillionTokens: number | null;
  updatedAt: string;
}

export interface SpendAlertRecord {
  userId: string;
  windowName: 'daily' | 'monthly';
  windowStart: string;
  level: 'warning' | 'exceeded';
  spentUsd: number;
  capUsd: number;
  createdAt: string;
}

/**
 * A creative-media job as the API reads it back: what was asked for, what came of it, and - when
 * the workspace key was unavailable at the moment it failed - the code that is all the reason there
 * is. The prompt and the generated paths arrive sealed, because only the caller holding the
 * workspace key can open them, and the owner's list is the one place a generation the agent started
 * on its own is ever described.
 */
