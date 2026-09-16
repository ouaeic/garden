/**
 * Every `row -> record` mapping the store does, in one place.
 *
 * Lifted out of `store.ts` unchanged. They were never the interesting part of that file and they
 * are what most of it is made of: twenty-nine small total functions with no state, no database
 * handle and no policy in them, sitting between the statements they belong to and pushing
 * everything else apart. The reason to separate them is the reason this whole decomposition is
 * happening: every defect this program has removed sat at a seam between two things that were far
 * apart in one very large file, and a mapper is exactly the kind of code that acquires a seam
 * quietly - three callers fill a record from the same row and a fourth fills it by hand, one field
 * short.
 *
 * `mapSpendLimits` carries the scar. Nothing here decrypts, and nothing here reads a clock or a
 * connection, so a caller can only get a wrong answer out of these by handing them a wrong row.
 */

import { TaskEventKind } from '@athanor/contracts';
import type { EncryptedEnvelope, MemoryKind, MemoryStatus, MemoryTrust } from '@athanor/core';
import type {
  ApiTokenRecord,
  ConnectorAuditRecord,
  ConnectorOAuthAttemptRecord,
  ConnectorRecord,
  SpendLimitsRecord,
  TaskEventRecord,
  TaskMessageQueueRecord,
  TaskPlanRecord,
  TaskRecord,
  TaskScheduleRecord,
  UserRecord,
  WorkspaceCheckpointRecord,
  WorkspaceMemoryRecord,
  WorkspacePreviewRecord,
  WorkspaceRecord,
  WorkspaceSkillRecord
} from '../types.js';
// Type-only, so it is erased and there is no cycle at run time. The memory record shapes are still
// declared in store.ts beside the rest of the memory domain contract; Wave 6 moves that domain out
// as a unit and these travel with it, at which point this import points at the new module instead.
import type {
  MemoryCandidateRecord,
  MemoryFactCandidateRecord,
  MemoryItemRecord,
  MemoryPackRecord,
  MemorySourceChannel,
  MemorySourceRecord,
  OwnerBlockRecord
} from '../store.js';

export const iso = (value: unknown): string => new Date(String(value)).toISOString();
export const json = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;

export const optionalText = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? String(value)
    : null;

/** A nullable numeric column. Zero is a real ceiling, so only NULL may collapse to null. */
export const numericOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * One shape for the owner's spend limits, because there were two.
 *
 * `spendLimitsIn` and `setSpendLimits` each built the record by hand from the same row, so adding
 * the price ceilings to one and not the other would have produced a `PUT` that stored the value and
 * then answered without it - the exact half-filled-record defect `TASK_LIVE_COUNTS` was written to
 * end one screen up.
 */
export const mapSpendLimits = (row: Record<string, unknown>): SpendLimitsRecord => ({
  userId: String(row.user_id),
  dailyCapUsd: numericOrNull(row.daily_cap_usd),
  monthlyCapUsd: numericOrNull(row.monthly_cap_usd),
  defaultTaskCapUsd: numericOrNull(row.default_task_cap_usd),
  warnAtPercent: Number(row.warn_at_percent),
  timeZone: String(row.time_zone),
  maxInputUsdPerMillionTokens: numericOrNull(row.max_input_usd_per_million_tokens),
  maxOutputUsdPerMillionTokens: numericOrNull(row.max_output_usd_per_million_tokens),
  updatedAt: iso(row.updated_at)
});

export const encryptedText = (
  value: unknown
): { ciphertext: EncryptedEnvelope | null; legacy: string | null } => {
  try {
    const parsed = json<Partial<EncryptedEnvelope>>(value);
    if (
      parsed.v === 1 &&
      typeof parsed.iv === 'string' &&
      typeof parsed.tag === 'string' &&
      typeof parsed.ciphertext === 'string'
    ) {
      return { ciphertext: parsed as EncryptedEnvelope, legacy: null };
    }
  } catch {
    // Rows created before encrypted titles remain readable during migration.
  }
  return { ciphertext: null, legacy: optionalText(value) };
};

export const mapUser = (row: Record<string, unknown>): UserRecord => ({
  id: String(row.id),
  username: String(row.username),
  displayName: String(row.display_name),
  recoveryHash: optionalText(row.recovery_hash),
  preferences:
    row.preferences && typeof row.preferences === 'object'
      ? (row.preferences as Record<string, unknown>)
      : {},
  createdAt: iso(row.created_at)
});

export const mapWorkspace = (row: Record<string, unknown>): WorkspaceRecord => ({
  ...(typeof row.parent_workspace_id === 'string'
    ? { parentWorkspaceId: row.parent_workspace_id }
    : {}),
  ...(typeof row.project_task_id === 'string' ? { projectTaskId: row.project_task_id } : {}),
  id: String(row.id),
  userId: String(row.user_id),
  name: String(row.name),
  status: String(row.status),
  storageBytes: Number(row.storage_bytes),
  storageLimitBytes: Number(row.storage_limit_bytes),
  imageRevision: String(row.image_revision),
  region: String(row.region),
  keyProtection: (optionalText(row.wrapping_mode) ?? 'hosted') as WorkspaceRecord['keyProtection'],
  securityMode: (optionalText(row.security_mode) ?? 'balanced') as WorkspaceRecord['securityMode'],
  runnerRef: optionalText(row.runner_ref),
  computeMeteredAt: row.compute_metered_at ? iso(row.compute_metered_at) : null,
  ...(optionalText(row.wrapped_key) ? { wrappedKey: optionalText(row.wrapped_key)! } : {}),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

export const mapTask = (row: Record<string, unknown>): TaskRecord => {
  const title = encryptedText(row.title);
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    ...(typeof row.project_id === 'string' ? { projectId: row.project_id } : {}),
    modelOverride: Boolean(row.model_override),
    modelPreferencesRevision: Number(row.model_preferences_revision ?? 0),
    modelChoicesCiphertext: row.model_choices_ciphertext
      ? json(row.model_choices_ciphertext)
      : null,
    conversationSourceCiphertext: row.conversation_source_ciphertext
      ? json(row.conversation_source_ciphertext)
      : null,
    parentTaskId: optionalText(row.parent_task_id),
    parentMissionId: optionalText(row.parent_mission_id),
    hasCodingFamily: Boolean(row.has_coding_family),
    branchedFromEventId: optionalText(row.branched_from_event_id),
    forkKind: optionalText(row.fork_kind) as TaskRecord['forkKind'],
    scheduleId: optionalText(row.schedule_id),
    rewindScope: optionalText(row.rewind_scope) as TaskRecord['rewindScope'],
    restoredCheckpointId: optionalText(row.restored_checkpoint_id),
    titleCiphertext: title.ciphertext,
    legacyTitle: title.legacy,
    titleSource: (optionalText(row.title_source) ?? 'prompt') as TaskRecord['titleSource'],
    pinned: Boolean(row.pinned),
    archivedAt: row.archived_at ? iso(row.archived_at) : null,
    status: String(row.status),
    modelId: String(row.model_id),
    reasoningEffort: (optionalText(row.reasoning_effort) ?? 'auto') as NonNullable<
      TaskRecord['reasoningEffort']
    >,
    privacyRoute: String(row.privacy_route),
    securityMode: (optionalText(row.security_mode) ?? 'balanced') as TaskRecord['securityMode'],
    maxComputeCredits: Number(row.max_compute_credits),
    actualComputeCredits: Number(row.actual_compute_credits),
    maxSpendUsd: numericOrNull(row.max_spend_usd),
    spentUsd: Number(row.spent_usd ?? 0),
    // Only present on statements that select it; absent is not the same as "no spend pause", so a
    // row that never asked for the column reports undefined rather than null.
    ...(row.spend_paused_at === undefined
      ? {}
      : { spendPausedAt: row.spend_paused_at ? iso(row.spend_paused_at) : null }),
    ...(row.completed_at === undefined
      ? {}
      : { completedAt: row.completed_at ? iso(row.completed_at) : null }),
    // `optionalText` rather than `String`: the column is text and nullable, and stringifying an
    // unexpected shape would put "[object Object]" into a field the worker branches on.
    queuedMessageCount: Number(row.queued_message_count ?? 0),
    ...(row.pending_delivery_count !== undefined
      ? {
          deliveryStatus: optionalText(row.delivery_status) as Exclude<
            TaskRecord['deliveryStatus'],
            undefined
          >,
          pendingDeliveryCount: Number(row.pending_delivery_count)
        }
      : {}),
    shareCount: Number(row.share_count ?? 0),
    promptCiphertext: json<EncryptedEnvelope>(row.prompt_ciphertext),
    agentStateCiphertext: row.agent_state_ciphertext
      ? json<EncryptedEnvelope>(row.agent_state_ciphertext)
      : null,
    leaseOwner: optionalText(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
    attempt: Number(row.attempt),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
};

export const mapWorkspaceCheckpoint = (
  row: Record<string, unknown>
): WorkspaceCheckpointRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  taskId: optionalText(row.task_id),
  turn: Number(row.turn),
  eventSequence: numericOrNull(row.event_sequence),
  mechanism: String(row.mechanism) as WorkspaceCheckpointRecord['mechanism'],
  fileCount: numericOrNull(row.file_count),
  totalBytes: numericOrNull(row.total_bytes),
  storedBytes: Number(row.stored_bytes),
  durationMs: Number(row.duration_ms),
  createdAt: iso(row.created_at)
});

export const mapTaskMessage = (row: Record<string, unknown>): TaskMessageQueueRecord => ({
  ...(typeof row.security_mode === 'string'
    ? { securityMode: row.security_mode as TaskRecord['securityMode'] }
    : {}),
  id: String(row.id),
  ...(typeof row.approval_id === 'string' ? { approvalId: row.approval_id } : {}),
  taskId: String(row.task_id),
  userId: String(row.user_id),
  promptCiphertext: json<EncryptedEnvelope>(row.prompt_ciphertext),
  modelId: String(row.model_id),
  reasoningEffort: (optionalText(row.reasoning_effort) ?? 'auto') as NonNullable<
    TaskRecord['reasoningEffort']
  >,
  privacyRoute: String(row.privacy_route),
  maxComputeCredits: Number(row.max_compute_credits),
  maxSpendUsd: numericOrNull(row.max_spend_usd),
  resourceClass: String(row.resource_class),
  reservationKey: String(row.reservation_key),
  status: String(row.status) as TaskMessageQueueRecord['status'],
  interrupt: row.interrupt === true,
  createdAt: iso(row.created_at),
  promotedAt: row.promoted_at ? iso(row.promoted_at) : null
});

export const mapTaskSchedule = (row: Record<string, unknown>): TaskScheduleRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  titleCiphertext: json<EncryptedEnvelope>(row.title_ciphertext),
  promptCiphertext: json<EncryptedEnvelope>(row.prompt_ciphertext),
  modelId: String(row.model_id),
  privacyRoute: String(row.privacy_route),
  maxComputeCredits: Number(row.max_compute_credits),
  maxSpendUsd: numericOrNull(row.max_spend_usd),
  spec: json<TaskScheduleRecord['spec']>(row.spec),
  enabled: Boolean(row.enabled),
  nextRunAt: row.next_run_at ? iso(row.next_run_at) : null,
  lastRunAt: row.last_run_at ? iso(row.last_run_at) : null,
  lastTaskId: optionalText(row.last_task_id),
  lastErrorCode: optionalText(row.last_error_code),
  leaseOwner: optionalText(row.lease_owner),
  leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

export const mapTaskEvent = (row: Record<string, unknown>): TaskEventRecord => ({
  id: String(row.id),
  taskId: String(row.task_id),
  sequence: Number(row.sequence),
  kind: TaskEventKind.parse(row.kind),
  summary: String(row.summary),
  payloadCiphertext: row.payload_ciphertext
    ? json<EncryptedEnvelope>(row.payload_ciphertext)
    : null,
  createdAt: iso(row.created_at)
});

export const mapTaskPlan = (row: Record<string, unknown>): TaskPlanRecord => ({
  id: String(row.id),
  taskId: String(row.task_id),
  version: Number(row.version),
  parentVersion: row.parent_version === null ? null : Number(row.parent_version),
  branchName: String(row.branch_name),
  stepsCiphertext: json<EncryptedEnvelope>(row.steps_ciphertext),
  createdBy: String(row.created_by) as TaskPlanRecord['createdBy'],
  createdAt: iso(row.created_at)
});

export const mapWorkspaceMemory = (row: Record<string, unknown>): WorkspaceMemoryRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: optionalText(row.workspace_id),
  target: String(row.target) as WorkspaceMemoryRecord['target'],
  keyScope: row.key_scope === 'user' ? 'user' : 'workspace',
  contentCiphertext: json<EncryptedEnvelope>(row.content_ciphertext),
  validUntil: row.valid_until ? iso(row.valid_until) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const workspaceSkillStatus = (value: unknown): WorkspaceSkillRecord['status'] =>
  value === 'stale' || value === 'archived' ? value : 'active';

export const mapWorkspaceSkill = (row: Record<string, unknown>): WorkspaceSkillRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  nameHash: String(row.name_hash),
  documentCiphertext: json<EncryptedEnvelope>(row.document_ciphertext),
  version: Number(row.version),
  enabled: Boolean(row.enabled),
  status: workspaceSkillStatus(row.status),
  pinned: Boolean(row.pinned),
  useCount: Number(row.use_count ?? 0),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

export const mapConnector = (row: Record<string, unknown>): ConnectorRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  kind: String(row.kind) as ConnectorRecord['kind'],
  authMode:
    row.auth_mode === 'none' || row.auth_mode === 'bearer' || row.auth_mode === 'oauth'
      ? row.auth_mode
      : 'secret',
  label: String(row.label),
  baseUrl: String(row.base_url),
  scopes: json<ConnectorRecord['scopes']>(row.scopes),
  secretCiphertext: json<EncryptedEnvelope>(row.secret_ciphertext),
  enabled: Boolean(row.enabled),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

export const mapConnectorOAuthAttempt = (
  row: Record<string, unknown>
): ConnectorOAuthAttemptRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  label: String(row.label),
  baseUrl: String(row.base_url),
  scopes: json<ConnectorOAuthAttemptRecord['scopes']>(row.scopes),
  stateHash: String(row.state_hash),
  secretCiphertext: json<EncryptedEnvelope>(row.secret_ciphertext),
  expiresAt: iso(row.expires_at),
  createdAt: iso(row.created_at)
});

export const mapApiToken = (row: Record<string, unknown>): ApiTokenRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  label: String(row.label),
  prefix: String(row.token_prefix),
  scopes: json<ApiTokenRecord['scopes']>(row.scopes),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  expiresAt: iso(row.expires_at),
  createdAt: iso(row.created_at)
});

export const mapConnectorAudit = (row: Record<string, unknown>): ConnectorAuditRecord => ({
  id: String(row.id),
  connectorId: String(row.connector_id),
  taskId: optionalText(row.task_id),
  operation: String(row.operation),
  outcome: String(row.outcome) as ConnectorAuditRecord['outcome'],
  statusCode:
    row.status_code === null || row.status_code === undefined ? null : Number(row.status_code),
  requestBytes: Number(row.request_bytes),
  responseBytes: Number(row.response_bytes),
  durationMs: Number(row.duration_ms),
  createdAt: iso(row.created_at)
});

export const mapWorkspacePreview = (row: Record<string, unknown>): WorkspacePreviewRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  label: String(row.label),
  port: Number(row.port),
  slug: String(row.slug),
  accessTokenHash: String(row.access_token_hash),
  entryPath: optionalText(row.entry_path),
  visibility: String(row.visibility) as WorkspacePreviewRecord['visibility'],
  status: String(row.status) as WorkspacePreviewRecord['status'],
  expiresAt: row.expires_at ? iso(row.expires_at) : null,
  lastAccessedAt: row.last_accessed_at ? iso(row.last_accessed_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

/** Provenance defaults to an empty object, which is not a seal; only a real envelope is returned. */
const optionalEnvelope = (value: unknown): EncryptedEnvelope | null => {
  if (!value) return null;
  const parsed = json<Partial<EncryptedEnvelope>>(value);
  return parsed.v === 1 && typeof parsed.ciphertext === 'string'
    ? (parsed as EncryptedEnvelope)
    : null;
};

const memoryKind = (value: unknown): MemoryKind => String(value) as MemoryKind;

export const mapMemoryItem = (row: Record<string, unknown>): MemoryItemRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  kind: memoryKind(row.kind),
  status: String(row.status) as MemoryStatus,
  trust: String(row.trust) as MemoryTrust,
  documentCiphertext: json<EncryptedEnvelope>(row.document_ciphertext),
  observedAt: iso(row.observed_at),
  retiredAt: row.retired_at ? iso(row.retired_at) : null,
  validFrom: iso(row.valid_from),
  validTo: row.valid_to ? iso(row.valid_to) : null,
  subjectKey: optionalText(row.subject_key),
  predicate: optionalText(row.predicate),
  predFunctional: Boolean(row.pred_functional),
  objectKey: optionalText(row.object_key),
  episodeId: optionalText(row.episode_id),
  taskId: optionalText(row.task_id),
  lastVerified: row.last_verified ? iso(row.last_verified) : null,
  okCount: Number(row.ok_count),
  failCount: Number(row.fail_count),
  pin: Boolean(row.pin),
  useCount: Number(row.use_count),
  citedCount: Number(row.cited_count),
  negCount: Number(row.neg_count),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  // Three-valued on purpose: `null` is an episode written before the column existed, and means
  // nobody recorded whether that turn read somebody else's words. Never collapsed to `false`.
  tainted: row.tainted === null || row.tainted === undefined ? null : Boolean(row.tainted),
  taintOrigin: optionalText(row.taint_origin),
  salience: Number(row.salience),
  tokensEst: Number(row.tokens_est),
  indexed: Boolean(row.indexed),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

export const mapMemorySource = (row: Record<string, unknown>): MemorySourceRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  occurredAt: iso(row.occurred_at),
  channel: String(row.channel) as MemorySourceChannel,
  role: optionalText(row.role),
  taskId: optionalText(row.task_id),
  episodeId: optionalText(row.episode_id),
  originCiphertext: optionalEnvelope(row.origin_ciphertext),
  originKey: optionalText(row.origin_key),
  bodyCiphertext: json<EncryptedEnvelope>(row.body_ciphertext),
  chunkIndex: Number(row.chunk_ix),
  chunkOf: optionalText(row.chunk_of),
  tokensEst: Number(row.tokens_est),
  indexed: Boolean(row.indexed),
  createdAt: iso(row.created_at)
});

export const mapMemoryCandidate = (row: Record<string, unknown>): MemoryCandidateRecord => ({
  id: String(row.id),
  layer: row.layer === 'source' ? 'source' : 'item',
  kind: memoryKind(row.kind),
  trust: String(row.trust) as MemoryTrust,
  status: String(row.status) as MemoryStatus,
  observedAt: iso(row.observed_at),
  validFrom: iso(row.valid_from),
  validTo: row.valid_to ? iso(row.valid_to) : null,
  subjectKey: optionalText(row.subject_key),
  predicate: optionalText(row.predicate),
  tokensEst: Number(row.tokens_est),
  score: Number(row.score),
  documentCiphertext: json<EncryptedEnvelope>(row.document_ciphertext)
});

export const mapMemoryPack = (row: Record<string, unknown>): MemoryPackRecord => ({
  taskId: String(row.task_id),
  workspaceId: String(row.workspace_id),
  briefVersion: optionalText(row.brief_version),
  bodyCiphertext: json<EncryptedEnvelope>(row.body_ciphertext),
  sha256: String(row.sha256),
  itemIds: (row.item_ids as string[] | null) ?? [],
  tokensEst: Number(row.tokens_est),
  createdAt: iso(row.created_at)
});

export const mapMemoryFactCandidate = (
  row: Record<string, unknown>
): MemoryFactCandidateRecord => ({
  workspaceId: String(row.workspace_id),
  subjectKey: String(row.subject_key),
  predicate: String(row.predicate),
  objectKey: String(row.object_key),
  episodeCount: Number(row.n_episodes),
  firstSeen: iso(row.first_seen),
  lastSeen: iso(row.last_seen),
  episodeIds: (row.episode_ids as string[] | null) ?? [],
  draftCiphertext: row.draft_ciphertext ? json<EncryptedEnvelope>(row.draft_ciphertext) : null,
  // Read through the same narrowing every other enum column here uses. A row from before
  // migration 71 has the column's default, so this is never absent.
  origin: row.origin === 'proposed' ? 'proposed' : 'observed',
  dismissedAt: row.dismissed_at ? iso(row.dismissed_at) : null
});

/**
 * The owner block.
 *
 * `content_bytes` is computed by the statement rather than stored, so this mapper is the one place
 * that would have to be wrong for the number the settings screen prints and the number the database
 * refuses on to part company - and it cannot be, because it copies a column it did not compute.
 */
export const mapOwnerBlock = (row: Record<string, unknown>): OwnerBlockRecord => ({
  userId: String(row.user_id),
  ciphertext: json<EncryptedEnvelope>(row.ciphertext),
  contentBytes: Number(row.content_bytes),
  version: Number(row.version),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});
