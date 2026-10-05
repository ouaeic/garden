import { randomUUID } from 'node:crypto';
import { GardenError } from '@garden/core';
import type { EncryptedEnvelope } from '@garden/core';
import type { Database } from '../database.js';
import { TaskSignals, TASK_QUEUE_CHANNEL, TASK_EVENT_CHANNEL } from './tasks.js';
import { COMMITTED_TASK_STATUSES } from './sql/tasks.js';
import type {
  ConnectorAuditRecord,
  ConnectorOAuthAttemptRecord,
  ConnectorRecord,
  ManagedProviderCredentialRecord
} from '../types.js';
import {
  iso,
  json,
  mapConnector,
  mapConnectorAudit,
  mapConnectorOAuthAttempt,
  optionalText
} from './rows.js';

/**
 * One page of approvals, and the same bargain: the newest are the ones an owner is looking at, and
 * the cursor reaches everything behind them.
 *
 * Smaller than a page of events because each row costs far more than a row: the route that reads
 * this issues two further queries, a key unwrap and a decrypt for every approval it is handed.
 */
export const MAX_APPROVAL_PAGE = 200;

export type ConnectorAuthorization<T> = (connector: ConnectorRecord) => Promise<{
  value: T;
  secretCiphertext?: EncryptedEnvelope;
}>;

interface TaskApprovalGrantInput {
  turn: number;
  securityMode: string;
  scopeHash: string;
  scopeCiphertext: EncryptedEnvelope;
}

interface ApprovalInput {
  userId: string;
  taskId: string;
  action: string;
  origin?: string;
  sideEffect: string;
  previewCiphertext: EncryptedEnvelope;
  previewHash: string;
  expiresAt: Date;
}

const insertApproval = async (database: Database, id: string, input: ApprovalInput) => {
  await database.query(
    `INSERT INTO approvals(id,user_id,task_id,action,origin,side_effect,preview_ciphertext,preview_hash,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [
      id,
      input.userId,
      input.taskId,
      input.action,
      input.origin ?? null,
      input.sideEffect,
      JSON.stringify(input.previewCiphertext),
      input.previewHash,
      input.expiresAt.toISOString()
    ]
  );
};

/**
 * The same position-is-a-row trick for approvals, and it is needed here for the same reason and
 * then some: a single turn can raise several approvals inside one millisecond, so a cursor that
 * carried only a timestamp would skip every approval that shared the last one on the page.
 *
 * The timestamp travels as the database's own text rather than as a re-serialised `Date`, because
 * `toISOString()` rounds a `timestamptz` to milliseconds and the comparison would then land on the
 * wrong side of any row written in between.
 */
const encodeApprovalCursor = (row: Record<string, unknown>): string =>
  Buffer.from(`${String(row.cursor_at)}|${String(row.id)}`, 'utf8').toString('base64url');

const decodeApprovalCursor = (cursor: string): { createdAt: string; id: string } => {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const [createdAt, id] = parts;
  const at = new Date(String(createdAt));
  if (parts.length !== 2 || Number.isNaN(at.getTime()) || !id)
    throw new GardenError('invalid_cursor', 'That approval list position is not valid');
  return { createdAt: String(createdAt), id };
};

/**
 * The two things standing between the agent and something outside this box: an approval, which is
 * permission asked for one action before it happens, and a connector, which is permission already
 * granted for a whole class of them - its stored credential, the OAuth attempt that obtained it,
 * and the audit line every use of it writes.
 *
 * They are one domain rather than two neighbours: the audit trail is what makes a standing grant
 * answerable after the fact, in the same way an approval makes a single action answerable before
 * it.
 */
export class ConnectorStore {
  constructor(
    private readonly database: Database,
    private readonly taskSignals = new TaskSignals(database)
  ) {}

  async createApproval(input: ApprovalInput): Promise<string> {
    const id = randomUUID();
    await insertApproval(this.database, id, input);
    return id;
  }

  /** A visible decision and its sealed continuation must become durable together. */
  async parkTaskForApproval(
    input: ApprovalInput & {
      id: string;
      workerId: string;
      agentStateCiphertext: EncryptedEnvelope;
      actualComputeCredits: number;
    }
  ): Promise<boolean> {
    const parked = await this.database.transaction(async (tx) => {
      const changed = await tx.query(
        `UPDATE tasks SET status='awaiting_user',agent_state_ciphertext=$4::jsonb,
           actual_compute_credits=$5,lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
         WHERE id=$1 AND user_id=$2 AND lease_owner=$3 AND lease_expires_at > NOW()
           AND status IN ${COMMITTED_TASK_STATUSES}
         RETURNING id`,
        [
          input.taskId,
          input.userId,
          input.workerId,
          JSON.stringify(input.agentStateCiphertext),
          input.actualComputeCredits
        ]
      );
      if (changed.rowCount !== 1) return false;
      await insertApproval(tx, input.id, input);
      return true;
    });
    if (parked) this.taskSignals.signal(TASK_QUEUE_CHANNEL, input.taskId);
    return parked;
  }

  /**
   * One page of approvals, newest first.
   *
   * It reads a page rather than the table because nothing here is ever deleted: a box run in
   * Balanced mode answers approvals all day and keeps every answer, so `status='approved'` on a
   * months-old box was the whole history - and the route that asks for it spends two queries, a key
   * unwrap and a decrypt on each row it is handed, all fired at the pool at once.
   *
   * `cursor` is the `cursor` field of the last row of the previous page, so a position in this list
   * is a row and not a count: approvals raised by one turn share a timestamp, and a cursor made of
   * the timestamp alone would skip every one of them that tied with the last row shown.
   */
  async listApprovals(
    userId: string,
    status: string | null = 'pending',
    options: { limit?: number; cursor?: string | null; taskId?: string | null } = {}
  ): Promise<Array<Record<string, unknown>>> {
    const limit = Math.max(
      1,
      Math.min(Math.trunc(options.limit ?? MAX_APPROVAL_PAGE), MAX_APPROVAL_PAGE)
    );
    const position = options.cursor ? decodeApprovalCursor(options.cursor) : null;
    const result = await this.database.query(
      // The ordering key is selected as the database's own text as well as ordered on, so the
      // cursor for the last row of this page is the exact value the next page compares against.
      `SELECT *, created_at::text AS cursor_at FROM approvals
       WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
         AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
         AND ($6::uuid IS NULL OR task_id = $6)
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [
        userId,
        status,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit,
        options.taskId ?? null
      ]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      taskId: String(row.task_id),
      action: String(row.action),
      origin: optionalText(row.origin),
      sideEffect: String(row.side_effect),
      previewCiphertext: json<EncryptedEnvelope>(row.preview_ciphertext),
      previewHash: String(row.preview_hash),
      status: String(row.status),
      decisionScope: String(row.decision_scope),
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
      cursor: encodeApprovalCursor(row)
    }));
  }

  /**
   * Records an outward action that ran on a lent key rather than on a card: approved at once, by
   * the key, so the record lists it beside the ones the owner approved by hand.
   */
  async recordKeyAuthorizedAction(input: Omit<ApprovalInput, 'expiresAt'>): Promise<void> {
    await this.database.query(
      `INSERT INTO approvals(id,user_id,task_id,action,origin,side_effect,preview_ciphertext,
         preview_hash,status,decision_scope,expires_at,resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'approved','key',NOW(),NOW())`,
      [
        randomUUID(),
        input.userId,
        input.taskId,
        input.action,
        input.origin ?? null,
        input.sideEffect,
        JSON.stringify(input.previewCiphertext),
        input.previewHash
      ]
    );
  }

  /** The follow-up path needs an existence answer, independent of approval-list pagination. */
  async hasPendingApproval(userId: string, taskId: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM approvals
       WHERE user_id = $1 AND task_id = $2 AND status = 'pending' LIMIT 1`,
      [userId, taskId]
    );
    return result.rows.length > 0;
  }

  async resolveApproval(
    userId: string,
    id: string,
    decision: 'approved' | 'denied',
    correction?: { promptCiphertext: EncryptedEnvelope; queuedEventCiphertext: EncryptedEnvelope },
    grant?: TaskApprovalGrantInput
  ): Promise<boolean> {
    if (correction && decision !== 'denied')
      throw new GardenError('approval_correction_invalid', 'Only a denial may carry a correction');
    if (grant && decision !== 'approved')
      throw new GardenError('approval_grant_invalid', 'Only an approval may create a permission');
    const resolved = await this.database.transaction(async (tx) => {
      // Cancellation locks the task before its decisions. Keep that order and hold the task
      // through settlement so a later pause or cancellation cannot be overwritten by queuing.
      const owned = await tx.query<{ task_id: string; status: string; security_mode: string }>(
        `SELECT t.id AS task_id,t.status,t.security_mode FROM tasks t
         JOIN approvals a ON a.task_id=t.id
         WHERE a.id=$1 AND a.user_id=$2 AND t.user_id=$2 FOR UPDATE OF t`,
        [id, userId]
      );
      const task = owned.rows[0];
      if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return null;
      if (
        grant &&
        (grant.securityMode !== task.security_mode ||
          grant.scopeCiphertext.aad !== `task-approval:${task.task_id}:${id}`)
      )
        throw new GardenError('approval_grant_invalid', 'Permission no longer matches this task');
      if (
        decision === 'approved' &&
        (
          await tx.query(
            "SELECT 1 FROM project_executions WHERE task_id=$1 AND status='preparing'",
            [task.task_id]
          )
        ).rows.length
      )
        return null;
      if (
        correction &&
        (correction.promptCiphertext.aad !== `task-message:${task.task_id}` ||
          correction.queuedEventCiphertext.aad !== `task-event:${task.task_id}`)
      )
        throw new GardenError(
          'approval_correction_invalid',
          'Correction encryption context does not match the task'
        );
      const changed = await tx.query(
        `UPDATE approvals SET status=$3,resolved_at=NOW(),decision_scope=$4
         WHERE id=$1 AND user_id=$2 AND status='pending' AND expires_at > NOW()`,
        [id, userId, decision, grant ? 'run' : 'once']
      );
      if (changed.rowCount !== 1) return null;
      if (grant) {
        await tx.query(
          `INSERT INTO task_approval_grants(id,user_id,task_id,turn,security_mode,scope_hash,scope_ciphertext)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            id,
            userId,
            task.task_id,
            grant.turn,
            grant.securityMode,
            grant.scopeHash,
            JSON.stringify(grant.scopeCiphertext)
          ]
        );
      }
      if (correction) {
        const messageId = randomUUID();
        await tx.query(
          `INSERT INTO task_message_queue(
             id,task_id,user_id,prompt_ciphertext,model_id,privacy_route,max_compute_credits,
             resource_class,reservation_key,max_spend_usd,interrupt,reasoning_effort,approval_id
           ) SELECT $1,id,user_id,$2::jsonb,model_id,privacy_route,0,
             'task_compute',$3,NULL,TRUE,reasoning_effort,$4 FROM tasks WHERE id=$5`,
          [
            messageId,
            JSON.stringify(correction.promptCiphertext),
            `approval:${id}:denial`,
            id,
            task.task_id
          ]
        );
        await tx.query(
          `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
           SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'queued_message','Approval correction queued',$3::jsonb
           FROM task_events WHERE task_id=$2`,
          [messageId, task.task_id, JSON.stringify(correction.queuedEventCiphertext)]
        );
      }
      const queued = await tx.query(
        `UPDATE tasks SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
           spend_paused_at=NULL,attempt=0,updated_at=NOW()
         WHERE id=$1 AND status='awaiting_user' RETURNING id`,
        [task.task_id]
      );
      return { taskId: task.task_id, queued: queued.rowCount === 1 };
    });
    if (resolved?.queued) this.taskSignals.signal(TASK_QUEUE_CHANNEL, resolved.taskId);
    if (resolved && correction) this.taskSignals.signal(TASK_EVENT_CHANNEL, resolved.taskId);
    return resolved !== null;
  }

  async getApproval(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.database.query('SELECT * FROM approvals WHERE id = $1', [id]);
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          userId: String(row.user_id),
          taskId: String(row.task_id),
          action: String(row.action),
          status: String(row.status),
          decisionScope: String(row.decision_scope),
          sideEffect: String(row.side_effect),
          previewCiphertext: json<EncryptedEnvelope>(row.preview_ciphertext),
          previewHash: String(row.preview_hash),
          expiresAt: iso(row.expires_at)
        }
      : null;
  }

  async hasTaskApprovalGrant(
    userId: string,
    taskId: string,
    turn: number,
    securityMode: string,
    scopeHash: string
  ): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM task_approval_grants g JOIN tasks t ON t.id=g.task_id
       WHERE g.user_id=$1 AND g.task_id=$2 AND g.turn=$3 AND g.security_mode=$4 AND g.scope_hash=$5
         AND g.revoked_at IS NULL AND t.user_id=$1 AND t.security_mode=$4
         AND t.status NOT IN ('completed','failed','cancelled') LIMIT 1`,
      [userId, taskId, turn, securityMode, scopeHash]
    );
    return result.rows.length > 0;
  }

  async listTaskApprovalGrants(userId: string, taskId: string, turn: number, before?: string) {
    const result = await this.database.query(
      `SELECT g.* FROM task_approval_grants g JOIN tasks t ON t.id=g.task_id
       WHERE g.user_id=$1 AND g.task_id=$2 AND g.turn=$3 AND g.revoked_at IS NULL
         AND t.user_id=$1 AND t.security_mode=g.security_mode AND t.status NOT IN ('completed','failed','cancelled')
         AND ($4::uuid IS NULL OR (g.created_at,g.id) <
           (SELECT created_at,id FROM task_approval_grants WHERE id=$4 AND user_id=$1 AND task_id=$2))
       ORDER BY g.created_at DESC,g.id DESC LIMIT 200`,
      [userId, taskId, turn, before ?? null]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      createdAt: iso(row.created_at),
      scopeCiphertext: json<EncryptedEnvelope>(row.scope_ciphertext)
    }));
  }

  async revokeTaskApprovalGrant(userId: string, taskId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE task_approval_grants SET revoked_at=COALESCE(revoked_at,NOW())
       WHERE user_id=$1 AND task_id=$2 AND id=$3 RETURNING id`,
      [userId, taskId, id]
    );
    return result.rows.length === 1;
  }

  async getManagedProviderCredential(
    userId: string,
    provider: string
  ): Promise<ManagedProviderCredentialRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM managed_provider_credentials WHERE user_id=$1 AND provider=$2',
      [userId, provider]
    );
    const row = result.rows[0];
    return row
      ? {
          userId: String(row.user_id),
          provider: String(row.provider),
          secretCiphertext: json<EncryptedEnvelope>(row.secret_ciphertext),
          externalRef: String(row.external_ref),
          monthlyLimitUsd: Number(row.monthly_limit_usd),
          status: String(row.status) as ManagedProviderCredentialRecord['status'],
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        }
      : null;
  }

  /**
   * Every inference connection an account holds, newest first.
   *
   * One credential per account was the whole reason a box could reach one provider at a time: the
   * key was the role, `'inference'`, so saving OpenRouter overwrote Ollama Cloud rather than
   * joining it. The key is now the connection - `inference:openrouter`, `inference:ollama-cloud` -
   * and this is what turns that into a list the picker and the worker can both read.
   *
   * The legacy single-connection rows are returned alongside, under the keys they were written
   * with, because an install that has not saved a provider since is still holding its credential
   * in one of them and must keep working untouched.
   */
  async listManagedProviderCredentials(
    userId: string,
    prefix = 'inference'
  ): Promise<ManagedProviderCredentialRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM managed_provider_credentials
       WHERE user_id=$1 AND (provider=$2 OR provider LIKE $2 || ':%' OR provider='openrouter')
       ORDER BY updated_at DESC`,
      [userId, prefix]
    );
    return result.rows.map((row) => ({
      userId: String(row.user_id),
      provider: String(row.provider),
      secretCiphertext: json<EncryptedEnvelope>(row.secret_ciphertext),
      externalRef: String(row.external_ref),
      monthlyLimitUsd: Number(row.monthly_limit_usd),
      status: String(row.status) as ManagedProviderCredentialRecord['status'],
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    }));
  }

  /**
   * The account's primary inference credential, whatever key it happens to live under.
   *
   * There are three: `inference:<vendor>` for a connection saved since an account could hold more
   * than one, `inference` for the single-connection era, and `openrouter` from before that. Callers
   * that want "this account's provider" - the media picker, the bootstrap's `configured` flag -
   * were all written against the literal `'inference'` and stopped finding anything the moment
   * saves moved to the vendor-keyed form.
   *
   * The record is returned whole, `provider` key included, because the callers that read it also
   * write it back: a media choice belongs in the row it was read from, and a writer that guessed
   * the key would strand the choice under a name nothing reads.
   *
   * Primary is most recently updated, which is the connection the owner last touched.
   */
  async primaryInferenceCredential(
    userId: string
  ): Promise<ManagedProviderCredentialRecord | null> {
    const rows = await this.listManagedProviderCredentials(userId);
    return rows.find((row) => row.status === 'active') ?? null;
  }

  /** Removes one connection. The catalogue rows it wrote are pruned by the caller that knows them. */
  async removeManagedProviderCredential(userId: string, provider: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM managed_provider_credentials WHERE user_id=$1 AND provider=$2 RETURNING provider',
      [userId, provider]
    );
    return result.rows.length > 0;
  }

  /** A settings save cannot restore a key rotated or removed while discovery was in flight. */
  async replaceManagedProviderCredentialSecret(input: {
    userId: string;
    provider: string;
    expected: EncryptedEnvelope;
    replacement: EncryptedEnvelope;
  }): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE managed_provider_credentials SET secret_ciphertext=$4::jsonb, updated_at=NOW()
       WHERE user_id=$1 AND provider=$2 AND status='active' AND secret_ciphertext=$3::jsonb
       RETURNING provider`,
      [
        input.userId,
        input.provider,
        JSON.stringify(input.expected),
        JSON.stringify(input.replacement)
      ]
    );
    return result.rows.length === 1;
  }

  async upsertManagedProviderCredential(input: {
    userId: string;
    provider: string;
    secretCiphertext: EncryptedEnvelope;
    externalRef: string;
    monthlyLimitUsd: number;
    status?: ManagedProviderCredentialRecord['status'];
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO managed_provider_credentials(
         user_id,provider,secret_ciphertext,external_ref,monthly_limit_usd,status
       ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
       ON CONFLICT(user_id,provider) DO UPDATE SET
         secret_ciphertext=EXCLUDED.secret_ciphertext,
         external_ref=EXCLUDED.external_ref,
         monthly_limit_usd=EXCLUDED.monthly_limit_usd,
         status=EXCLUDED.status,
         updated_at=NOW()`,
      [
        input.userId,
        input.provider,
        JSON.stringify(input.secretCiphertext),
        input.externalRef,
        input.monthlyLimitUsd,
        input.status ?? 'active'
      ]
    );
  }

  async deleteManagedProviderCredential(userId: string, provider: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM managed_provider_credentials WHERE user_id=$1 AND provider=$2',
      [userId, provider]
    );
    return result.rowCount === 1;
  }

  async createConnector(input: {
    id: string;
    userId: string;
    kind: ConnectorRecord['kind'];
    authMode: ConnectorRecord['authMode'];
    label: string;
    baseUrl: string;
    scopes: ConnectorRecord['scopes'];
    secretCiphertext: EncryptedEnvelope;
  }): Promise<ConnectorRecord> {
    const result = await this.database.query(
      `INSERT INTO connectors(id,user_id,kind,auth_mode,label,base_url,scopes,secret_ciphertext)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
       RETURNING *`,
      [
        input.id,
        input.userId,
        input.kind,
        input.authMode,
        input.label,
        input.baseUrl,
        JSON.stringify(input.scopes),
        JSON.stringify(input.secretCiphertext)
      ]
    );
    return mapConnector(result.rows[0]!);
  }

  async listConnectors(userId: string): Promise<ConnectorRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM connectors WHERE user_id=$1 ORDER BY enabled DESC, created_at DESC`,
      [userId]
    );
    return result.rows.map(mapConnector);
  }

  async getConnector(userId: string, id: string): Promise<ConnectorRecord | null> {
    const result = await this.database.query(
      `SELECT * FROM connectors WHERE id=$1 AND user_id=$2 AND enabled=TRUE`,
      [id, userId]
    );
    return result.rows[0] ? mapConnector(result.rows[0]) : null;
  }

  async revokeConnector(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE connectors SET enabled=FALSE,updated_at=NOW(),
         secret_ciphertext=jsonb_build_object('v',1,'iv','','tag','','ciphertext','','aad','connector:' || user_id::text || ':' || id::text)
       WHERE id=$1 AND user_id=$2 AND enabled=TRUE`,
      [id, userId]
    );
    return result.rowCount === 1;
  }

  async updateConnectorSecret(
    userId: string,
    id: string,
    secretCiphertext: EncryptedEnvelope
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE connectors SET secret_ciphertext=$3::jsonb,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND enabled=TRUE`,
      [id, userId, JSON.stringify(secretCiphertext)]
    );
    return result.rowCount === 1;
  }

  /** Serialize credential rotation across API and worker processes, before using the new token. */
  async withConnectorAuthorization<T>(
    userId: string,
    id: string,
    authorize: ConnectorAuthorization<T>
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      const selected = await tx.query(
        `SELECT * FROM connectors WHERE id=$1 AND user_id=$2 AND enabled=TRUE FOR UPDATE`,
        [id, userId]
      );
      if (!selected.rows[0])
        throw new GardenError('connector_not_found', 'Connected service is unavailable', 404);
      const connector = mapConnector(selected.rows[0]);
      const authorization = await authorize(connector);
      if (authorization.secretCiphertext) {
        if (authorization.secretCiphertext.aad !== `connector:${userId}:${id}`)
          throw new GardenError('connector_secret_context', 'Connector secret context is invalid');
        await tx.query(
          `UPDATE connectors SET secret_ciphertext=$3::jsonb,updated_at=NOW() WHERE id=$1 AND user_id=$2`,
          [id, userId, JSON.stringify(authorization.secretCiphertext)]
        );
      }
      return authorization.value;
    });
  }

  async createConnectorOAuthAttempt(input: {
    id: string;
    userId: string;
    label: string;
    baseUrl: string;
    scopes: ConnectorOAuthAttemptRecord['scopes'];
    stateHash: string;
    secretCiphertext: EncryptedEnvelope;
    expiresAt: Date;
  }): Promise<ConnectorOAuthAttemptRecord> {
    const result = await this.database.query(
      `INSERT INTO connector_oauth_attempts(
         id,user_id,label,base_url,scopes,state_hash,secret_ciphertext,expires_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)
       RETURNING *`,
      [
        input.id,
        input.userId,
        input.label,
        input.baseUrl,
        JSON.stringify(input.scopes),
        input.stateHash,
        JSON.stringify(input.secretCiphertext),
        input.expiresAt.toISOString()
      ]
    );
    return mapConnectorOAuthAttempt(result.rows[0]!);
  }

  async consumeConnectorOAuthAttempt(
    stateHash: string
  ): Promise<ConnectorOAuthAttemptRecord | null> {
    const result = await this.database.query(
      `DELETE FROM connector_oauth_attempts
       WHERE state_hash=$1 AND expires_at>NOW()
       RETURNING *`,
      [stateHash]
    );
    return result.rows[0] ? mapConnectorOAuthAttempt(result.rows[0]) : null;
  }

  async recordConnectorAudit(input: {
    connectorId: string;
    userId: string;
    taskId?: string;
    operation: string;
    outcome: ConnectorAuditRecord['outcome'];
    statusCode?: number;
    requestBytes?: number;
    responseBytes?: number;
    durationMs?: number;
  }): Promise<ConnectorAuditRecord> {
    const result = await this.database.query(
      `WITH inserted AS (
         INSERT INTO connector_audit_events(
           id,connector_id,user_id,task_id,operation,outcome,status_code,
           request_bytes,response_bytes,duration_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *
       ), touched AS (
         UPDATE connectors SET last_used_at=NOW(),updated_at=NOW()
         WHERE id=$2 AND user_id=$3
       ) SELECT * FROM inserted`,
      [
        randomUUID(),
        input.connectorId,
        input.userId,
        input.taskId ?? null,
        input.operation,
        input.outcome,
        input.statusCode ?? null,
        input.requestBytes ?? 0,
        input.responseBytes ?? 0,
        input.durationMs ?? 0
      ]
    );
    return mapConnectorAudit(result.rows[0]!);
  }

  async listConnectorAudit(
    userId: string,
    limit = 100,
    taskId: string | null = null
  ): Promise<ConnectorAuditRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM connector_audit_events WHERE user_id=$1 AND ($3::uuid IS NULL OR task_id=$3)
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, Math.max(1, Math.min(500, limit)), taskId]
    );
    return result.rows.map(mapConnectorAudit);
  }
}
