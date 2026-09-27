import { randomUUID } from 'node:crypto';
import { AthanorError, type EncryptedEnvelope } from '@athanor/core';
import type { VoicePendingReceipt, VoiceSession, VoiceWorkProposal } from '@athanor/contracts';
import type { Database } from '../database.js';
import { BillingStore } from './billing.js';
import { iso, json, optionalText } from './rows.js';
export interface VoiceSessionRecord {
  session: VoiceSession;
  userId: string;
  liveTaskId: string | null;
  authHash: string;
  configuration: EncryptedEnvelope;
  connection: EncryptedEnvelope;
  controllerId: string | null;
}
export interface VoiceProposalRecord {
  id: string;
  sessionId: string;
  userId: string;
  digest: string;
  ciphertext: EncryptedEnvelope;
  status: VoiceWorkProposal['status'];
  createdAt: string;
  expiresAt: string;
  messageId: string | null;
}
const map = (row: Record<string, unknown>): VoiceSessionRecord => ({
  session: {
    ...json<VoiceSession>(row.details),
    status: row.status as VoiceSession['status'],
    connectedAt: row.connected_at ? iso(row.connected_at) : null,
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    settledUsd: Number(row.settled_usd),
    pendingUsd: Number(row.pending_usd),
    inputSeconds: Number(row.input_seconds),
    outputSeconds: Number(row.output_seconds),
    currentResponseId: optionalText(row.current_response_id),
    cleanupPending: Boolean(row.cleanup_pending),
    errorCode: optionalText(row.error_code),
    note: optionalText(row.note)
  },
  userId: String(row.user_id),
  liveTaskId: optionalText(row.task_id),
  authHash: String(row.auth_hash),
  configuration: json(row.configuration),
  connection: json(row.connection),
  controllerId: optionalText(row.controller_id)
});
const proposal = (row: Record<string, unknown>): VoiceProposalRecord => ({
  id: String(row.id),
  sessionId: String(row.session_id),
  userId: String(row.user_id),
  digest: String(row.digest),
  ciphertext: json(row.ciphertext),
  status: row.status as VoiceWorkProposal['status'],
  createdAt: iso(row.created_at),
  expiresAt: iso(row.expires_at),
  messageId: optionalText(row.message_id)
});
const unavailable = () =>
  new AthanorError('voice_session_unavailable', 'This voice session is no longer available', 409);
const active = ['preparing', 'connecting', 'listening', 'responding', 'stopping'];
export class VoiceStore {
  constructor(readonly database: Database) {}
  async discussion(userId: string, taskId: string) {
    const row = (
      await this.database.query(
        `SELECT n.* FROM voice_discussion_notes n JOIN tasks t ON t.id=n.task_id
       WHERE n.user_id=$1 AND n.task_id=$2 AND t.user_id=$1 AND t.workspace_id=n.workspace_id`,
        [userId, taskId]
      )
    ).rows[0];
    return row
      ? {
          ciphertext: json<EncryptedEnvelope>(row.ciphertext),
          updatedAt: iso(row.updated_at),
          workspaceId: String(row.workspace_id)
        }
      : null;
  }
  async saveDiscussion(
    userId: string,
    sessionId: string,
    controllerId: string,
    ciphertext: EncryptedEnvelope
  ) {
    const result = await this.database.query(
      `INSERT INTO voice_discussion_notes(task_id,user_id,workspace_id,session_id,ciphertext)
       SELECT s.task_id,s.user_id,s.workspace_id,s.id,$4 FROM voice_sessions s JOIN tasks t ON t.id=s.task_id
       WHERE s.id=$1 AND s.user_id=$2 AND s.controller_id=$3 AND s.status IN ('listening','responding')
       AND s.lease_expires_at>NOW() AND s.deadline_at>NOW() AND s.details->>'shareTaskContext'='true'
       AND t.user_id=$2 AND t.workspace_id=s.workspace_id
       ON CONFLICT(task_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,session_id=EXCLUDED.session_id,updated_at=NOW()`,
      [sessionId, userId, controllerId, JSON.stringify(ciphertext)]
    );
    if (result.rowCount !== 1) throw unavailable();
  }
  async clearDiscussion(userId: string, taskId: string) {
    await this.database.query(
      'DELETE FROM voice_discussion_notes WHERE user_id=$1 AND task_id=$2',
      [userId, taskId]
    );
  }
  async #assertAffordable(
    tx: Database,
    userId: string,
    session: VoiceSession,
    minimumReservationUsd: number
  ): Promise<void> {
    if (!Number.isFinite(minimumReservationUsd) || minimumReservationUsd <= 0)
      throw new Error('Invalid voice admission bound');
    if (session.maxSpendUsd < minimumReservationUsd)
      throw new AthanorError(
        'voice_reservation_required',
        `Live voice needs $${minimumReservationUsd.toFixed(4)} of held capacity for one bounded response. Review the session allowance before starting; this is not an actual charge.`,
        402
      );
    const family = await tx.query(
      `SELECT root.id FROM tasks requested JOIN tasks root ON root.id=CASE
        WHEN requested.parent_mission_id IS NULL THEN requested.id ELSE requested.parent_task_id END
      WHERE requested.id=$1 AND requested.user_id=$2 AND requested.workspace_id=$3
        AND root.user_id=$2 FOR UPDATE OF requested,root`,
      [session.taskId, userId, session.workspaceId]
    );
    if (!family.rows.length) throw unavailable();
    // Admission observes the same family and account commitments as the later atomic reservation.
    const decision = await new BillingStore(tx).spendGuardIn(tx, {
      userId,
      taskId: session.taskId,
      estimateUsd: minimumReservationUsd,
      includeOpenCommitments: true
    });
    if (decision.outcome === 'deny') {
      const window = decision.windows.find((entry) => entry.name === decision.blockedBy),
        availableUsd =
          window?.capUsd === null || !window
            ? 0
            : Math.max(0, window.capUsd - window.spentUsd - window.pendingUsd),
        scope =
          decision.blockedBy === 'task'
            ? 'task and its related work'
            : `${decision.blockedBy ?? 'account'} account window`;
      throw new AthanorError(
        'voice_budget_unavailable',
        `Voice needs $${minimumReservationUsd.toFixed(4)} of held capacity for one response; $${availableUsd.toFixed(4)} is available for the ${scope}. Capacity is not an actual charge. Choose a cheaper model, reconcile held charges, or review the budget.`,
        402,
        { minimumReservationUsd, availableUsd, blockedBy: decision.blockedBy }
      );
    }
  }
  async create(input: {
    userId: string;
    requestKey: string;
    requestHash: string;
    authHash: string;
    ticketHash: string;
    ticketExpiresAt: string;
    session: VoiceSession;
    minimumReservationUsd: number;
    configuration: EncryptedEnvelope;
    connection: EncryptedEnvelope;
  }): Promise<VoiceSessionRecord> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const existing = (
        await tx.query('SELECT * FROM voice_sessions WHERE user_id=$1 AND request_key=$2', [
          input.userId,
          input.requestKey
        ])
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash || existing.auth_hash !== input.authHash)
          throw new AthanorError(
            'voice_request_conflict',
            'This voice request belongs to a different selection or browser session',
            409
          );
        if (existing.status === 'preparing')
          await this.#assertAffordable(
            tx,
            input.userId,
            map(existing).session,
            input.minimumReservationUsd
          );
        return map(existing);
      }
      const task = (
        await tx.query(
          'SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE',
          [input.session.taskId, input.userId, input.session.workspaceId]
        )
      ).rows[0];
      if (!task) throw unavailable();
      if (
        (
          await tx.query(
            'SELECT id FROM voice_sessions WHERE user_id=$1 AND status=ANY($2::text[])',
            [input.userId, active]
          )
        ).rows.length
      )
        throw new AthanorError(
          'voice_already_active',
          'End the current voice session before starting another',
          409
        );
      const held = (
        await tx.query(
          'SELECT COUNT(*) AS n FROM voice_sessions WHERE user_id=$1 AND pending_usd>0',
          [input.userId]
        )
      ).rows[0];
      if (Number(held?.n) >= 100)
        throw new AthanorError(
          'voice_receipt_limit',
          'Reconcile held voice charges before starting another session',
          409
        );
      await this.#assertAffordable(tx, input.userId, input.session, input.minimumReservationUsd);
      const result = await tx.query(
        `INSERT INTO voice_sessions(id,user_id,task_id,original_task_id,workspace_id,request_key,request_hash,auth_hash,ticket_hash,ticket_expires_at,deadline_at,details,configuration,connection)
        VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          input.session.id,
          input.userId,
          input.session.taskId,
          input.session.workspaceId,
          input.requestKey,
          input.requestHash,
          input.authHash,
          input.ticketHash,
          input.ticketExpiresAt,
          input.session.deadlineAt,
          JSON.stringify(input.session),
          JSON.stringify(input.configuration),
          JSON.stringify(input.connection)
        ]
      );
      return map(result.rows[0]!);
    });
  }
  async existing(
    userId: string,
    requestKey: string,
    requestHash: string,
    authHash: string
  ): Promise<VoiceSessionRecord | null> {
    const row = (
      await this.database.query(
        'SELECT * FROM voice_sessions WHERE user_id=$1 AND request_key=$2',
        [userId, requestKey]
      )
    ).rows[0];
    if (!row) return null;
    if (row.request_hash !== requestHash || row.auth_hash !== authHash)
      throw new AthanorError(
        'voice_request_conflict',
        'This voice request belongs to a different selection or browser session',
        409
      );
    return map(row);
  }
  async replayAdmission(
    userId: string,
    id: string,
    minimumReservationUsd: number
  ): Promise<VoiceSessionRecord> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const row = (
        await tx.query('SELECT * FROM voice_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE', [
          userId,
          id
        ])
      ).rows[0];
      if (!row) throw unavailable();
      if (row.status === 'preparing')
        await this.#assertAffordable(tx, userId, map(row).session, minimumReservationUsd);
      return map(row);
    });
  }
  async get(userId: string, id: string): Promise<VoiceSessionRecord | null> {
    const row = (
      await this.database.query('SELECT * FROM voice_sessions WHERE id=$1 AND user_id=$2', [
        id,
        userId
      ])
    ).rows[0];
    return row ? map(row) : null;
  }
  async list(userId: string, taskId: string): Promise<VoiceSession[]> {
    return (
      await this.database.query(
        'SELECT * FROM voice_sessions WHERE user_id=$1 AND original_task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',
        [userId, taskId]
      )
    ).rows.map((row) => map(row).session);
  }
  async listOwner(userId: string): Promise<VoiceSession[]> {
    return (
      await this.database.query(
        `SELECT * FROM voice_sessions WHERE user_id=$1 AND (pending_usd>0 OR id IN(SELECT id FROM voice_sessions WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100)) ORDER BY (pending_usd>0) DESC,created_at DESC,id DESC LIMIT 200`,
        [userId]
      )
    ).rows.map((row) => map(row).session);
  }
  async claim(
    userId: string,
    id: string,
    authHash: string,
    ticketHash: string,
    controllerId: string,
    minimumReservationUsd: number
  ): Promise<VoiceSessionRecord> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const candidate = (
        await tx.query(
          `SELECT * FROM voice_sessions WHERE id=$1 AND user_id=$2 AND auth_hash=$3
          AND ticket_hash=$4 AND ticket_expires_at>NOW() AND deadline_at>NOW()
          AND status='preparing' AND task_id IS NOT NULL FOR UPDATE`,
          [id, userId, authHash, ticketHash]
        )
      ).rows[0];
      if (!candidate) throw unavailable();
      await this.#assertAffordable(tx, userId, map(candidate).session, minimumReservationUsd);
      const row = (
        await tx.query(
          `UPDATE voice_sessions SET status='connecting',ticket_hash=NULL,controller_id=$5,lease_expires_at=NOW()+INTERVAL '30 seconds',cleanup_pending=TRUE
      WHERE id=$1 AND user_id=$2 AND auth_hash=$3 AND ticket_hash=$4 AND ticket_expires_at>NOW() AND deadline_at>NOW() AND status='preparing' AND task_id IS NOT NULL RETURNING *`,
          [id, userId, authHash, ticketHash, controllerId]
        )
      ).rows[0];
      if (!row) throw unavailable();
      return map(row);
    });
  }
  async reconnectTicket(input: {
    userId: string;
    id: string;
    authHash: string;
    controllerId: string;
    ticketHash: string;
    expiresAt: string;
  }): Promise<VoiceSessionRecord> {
    const row = (
      await this.database.query(
        `UPDATE voice_sessions SET ticket_hash=$5,ticket_expires_at=$6
       WHERE id=$1 AND user_id=$2 AND auth_hash=$3 AND controller_id=$4
       AND status IN ('listening','responding') AND lease_expires_at>NOW()
       AND deadline_at>NOW() AND task_id IS NOT NULL RETURNING *`,
        [
          input.id,
          input.userId,
          input.authHash,
          input.controllerId,
          input.ticketHash,
          input.expiresAt
        ]
      )
    ).rows[0];
    if (!row) throw unavailable();
    return map(row);
  }
  async recoveryTicket(input: {
    userId: string;
    id: string;
    authHash: string;
    ticketHash: string;
    expiresAt: string;
    minimumReservationUsd: number;
  }): Promise<VoiceSessionRecord> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const candidate = (
        await tx.query(
          `SELECT * FROM voice_sessions WHERE id=$1 AND user_id=$2 AND auth_hash=$3 AND deadline_at>NOW()
         AND task_id IS NOT NULL AND details->>'shareTaskContext'='true' FOR UPDATE`,
          [input.id, input.userId, input.authHash]
        )
      ).rows[0];
      if (!candidate) throw unavailable();
      const session = map(candidate).session;
      if (session.status === 'preparing' && (session.providerGeneration ?? 0) > 0) {
        const row = (
          await tx.query(
            'UPDATE voice_sessions SET ticket_hash=$2,ticket_expires_at=$3 WHERE id=$1 RETURNING *',
            [input.id, input.ticketHash, input.expiresAt]
          )
        ).rows[0]!;
        return map(row);
      }
      const stale =
        ['connecting', 'listening', 'responding'].includes(session.status) &&
        candidate.lease_expires_at &&
        Date.parse(iso(candidate.lease_expires_at)) <= Date.now();
      const lost =
        ['lost', 'usage_uncertain'].includes(session.status) &&
        [
          'voice_provider_connection_lost',
          'voice_connection_lost',
          'voice_server_restart'
        ].includes(session.errorCode ?? '');
      if (!stale && !lost) {
        if (['connecting', 'listening', 'responding'].includes(session.status))
          throw new AthanorError(
            'voice_recovery_wait',
            'Waiting for the previous voice connection to release its lease.',
            503
          );
        throw unavailable();
      }
      if ((session.providerGeneration ?? 0) >= 2) throw unavailable();
      if (
        (
          await tx.query(
            'SELECT id FROM voice_sessions WHERE user_id=$1 AND id<>$2 AND status=ANY($3::text[])',
            [input.userId, input.id, active]
          )
        ).rowCount
      )
        throw unavailable();
      if (
        session.settledUsd + session.pendingUsd + input.minimumReservationUsd >
        session.maxSpendUsd
      )
        throw new AthanorError(
          'voice_budget_unavailable',
          'Unconfirmed usage remains held. Review the session allowance before continuing.',
          402
        );
      await this.#assertAffordable(tx, input.userId, session, input.minimumReservationUsd);
      const row = (
        await tx.query(
          `UPDATE voice_sessions SET status='preparing',ticket_hash=$2,ticket_expires_at=$3,controller_id=NULL,
         cleanup_pending=FALSE,lease_expires_at=NULL,current_response_id=NULL,ended_at=NULL,error_code=NULL,
         details=jsonb_set(details,'{providerGeneration}',to_jsonb($4::integer)),
         note='Voice recovered from saved conversation context. The last unsaved exchange may need repeating; unconfirmed usage remains held.'
         WHERE id=$1 RETURNING *`,
          [input.id, input.ticketHash, input.expiresAt, (session.providerGeneration ?? 0) + 1]
        )
      ).rows[0]!;
      return map(row);
    });
  }
  async reconnect(input: {
    userId: string;
    id: string;
    authHash: string;
    controllerId: string;
    ticketHash: string;
  }): Promise<VoiceSessionRecord> {
    const row = (
      await this.database.query(
        `UPDATE voice_sessions SET ticket_hash=NULL
       WHERE id=$1 AND user_id=$2 AND auth_hash=$3 AND controller_id=$4 AND ticket_hash=$5
       AND ticket_expires_at>NOW() AND lease_expires_at>NOW() AND deadline_at>NOW()
       AND status IN ('listening','responding') AND task_id IS NOT NULL RETURNING *`,
        [input.id, input.userId, input.authHash, input.controllerId, input.ticketHash]
      )
    ).rows[0];
    if (!row) throw unavailable();
    return map(row);
  }
  async heartbeat(
    userId: string,
    id: string,
    controllerId: string,
    inputSeconds: number,
    outputSeconds: number
  ): Promise<boolean> {
    const row = await this.database.query(
      `UPDATE voice_sessions SET lease_expires_at=NOW()+INTERVAL '30 seconds',input_seconds=$4,output_seconds=$5
      WHERE id=$1 AND user_id=$2 AND controller_id=$3 AND status IN ('connecting','listening','responding') AND deadline_at>NOW() AND task_id IS NOT NULL`,
      [id, userId, controllerId, inputSeconds, outputSeconds]
    );
    return row.rowCount === 1;
  }
  async connected(userId: string, id: string, controllerId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE voice_sessions SET status='listening',connected_at=COALESCE(connected_at,NOW()) WHERE id=$1 AND user_id=$2 AND controller_id=$3 AND status='connecting' AND deadline_at>NOW()`,
      [id, userId, controllerId]
    );
    if (result.rowCount !== 1) throw unavailable();
  }
  async reserve(
    userId: string,
    id: string,
    controllerId: string,
    costUsd: number
  ): Promise<string> {
    if (!Number.isFinite(costUsd) || costUsd <= 0) throw new Error('Invalid voice reservation');
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const row = (
        await tx.query(
          `SELECT * FROM voice_sessions WHERE id=$1 AND user_id=$2 AND controller_id=$3 AND status='listening' AND deadline_at>NOW() AND task_id IS NOT NULL FOR UPDATE`,
          [id, userId, controllerId]
        )
      ).rows[0];
      if (!row) throw unavailable();
      const session = map(row).session;
      if (Number(row.pending_usd) + Number(row.settled_usd) + costUsd > session.maxSpendUsd + 1e-10)
        throw new AthanorError(
          'voice_spend_cap_reached',
          'This voice session has reached its spending limit',
          402
        );
      const responseId = randomUUID(),
        key = `voice:${id}:${responseId}`;
      await new BillingStore(tx).recordUsage({
        userId,
        taskId: String(row.task_id),
        workspaceId: session.workspaceId,
        kind: 'model_inference',
        resourceClass: 'media:voice',
        quantity: 0,
        unit: 'token',
        credits: 0,
        state: 'reserved',
        idempotencyKey: key,
        costUsd,
        modelId: session.providerModelId,
        reserveAgainstCaps: true
      });
      await tx.query(
        `INSERT INTO voice_responses(id,session_id,user_id,reservation_key,reserved_usd) VALUES($1,$2,$3,$4,$5)`,
        [responseId, id, userId, key, costUsd]
      );
      await tx.query(
        `UPDATE voice_sessions SET status='responding',current_response_id=$2,pending_usd=pending_usd+$3 WHERE id=$1`,
        [id, responseId, costUsd]
      );
      return responseId;
    });
  }
  async bindResponse(
    userId: string,
    id: string,
    responseId: string,
    providerResponseId: string
  ): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(providerResponseId))
      throw new Error('Invalid provider response identity');
    const result = await this.database.query(
      `UPDATE voice_responses SET provider_response_id=$4 WHERE id=$1 AND session_id=$2 AND user_id=$3 AND state='reserved' AND provider_response_id IS NULL`,
      [responseId, id, userId, providerResponseId]
    );
    if (result.rowCount !== 1) throw unavailable();
  }
  async settle(
    userId: string,
    id: string,
    responseId: string,
    input: {
      costUsd: number;
      quantity: number;
      providerResponseId: string | null;
      receipt?: EncryptedEnvelope;
      released?: boolean;
    }
  ): Promise<void> {
    if (
      !Number.isFinite(input.costUsd) ||
      input.costUsd < 0 ||
      !Number.isSafeInteger(input.quantity) ||
      input.quantity < 0
    )
      throw new Error('Invalid voice receipt');
    await this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const row = (
        await tx.query(
          `SELECT r.* FROM voice_responses r JOIN voice_sessions s ON s.id=r.session_id WHERE r.id=$1 AND r.session_id=$2 AND r.user_id=$3 AND r.state='reserved' FOR UPDATE OF r,s`,
          [responseId, id, userId]
        )
      ).rows[0];
      if (!row || (!input.receipt && row.provider_response_id !== input.providerResponseId))
        throw unavailable();
      const update = await tx.query(
        `UPDATE usage_entries SET state=$4,cost_usd=$3,quantity=$5,provider_ref=$6 WHERE idempotency_key=$1 AND user_id=$2 AND resource_class='media:voice' AND kind='model_inference' AND state='reserved'`,
        [
          row.reservation_key,
          userId,
          input.costUsd,
          input.released ? 'released' : 'settled',
          input.quantity,
          input.providerResponseId
        ]
      );
      if (update.rowCount !== 1) throw unavailable();
      await tx.query(`UPDATE voice_responses SET state=$2,cost_usd=$3,receipt=$4 WHERE id=$1`, [
        responseId,
        input.released ? 'released' : 'settled',
        input.costUsd,
        input.receipt ? JSON.stringify(input.receipt) : null
      ]);
      await tx.query(
        `UPDATE voice_sessions SET settled_usd=settled_usd+$3,pending_usd=GREATEST(0,pending_usd-$4),current_response_id=CASE WHEN current_response_id=$2 THEN NULL ELSE current_response_id END,
        status=CASE WHEN status='responding' THEN 'listening' WHEN status='usage_uncertain' AND pending_usd-$4<0.000000001 THEN 'ended' ELSE status END WHERE id=$1`,
        [id, responseId, input.costUsd, Number(row.reserved_usd)]
      );
    });
  }
  async pending(userId: string, id: string): Promise<VoicePendingReceipt[]> {
    return (
      await this.database.query(
        `SELECT * FROM voice_responses WHERE session_id=$1 AND user_id=$2 AND state='reserved' ORDER BY created_at,id LIMIT 1000`,
        [id, userId]
      )
    ).rows.map((row) => ({
      id: String(row.id),
      providerResponseId: optionalText(row.provider_response_id),
      reservedUsd: Number(row.reserved_usd),
      createdAt: iso(row.created_at)
    }));
  }
  async stopping(userId: string, id: string): Promise<void> {
    await this.database.query(
      `UPDATE voice_sessions SET status='stopping' WHERE id=$1 AND user_id=$2 AND status IN ('preparing','connecting','listening','responding')`,
      [id, userId]
    );
  }
  async finish(
    userId: string,
    id: string,
    controllerId: string | null,
    reason: 'ended' | 'expired' | 'lost',
    errorCode: string | null = null,
    metrics?: { inputSeconds: number; outputSeconds: number }
  ): Promise<void> {
    if (metrics && Object.values(metrics).some((value) => !Number.isFinite(value) || value < 0))
      throw new Error('Invalid voice duration');
    await this.database.query(
      `UPDATE voice_sessions SET status=CASE WHEN pending_usd>0 THEN 'usage_uncertain' ELSE $4 END,ended_at=COALESCE(ended_at,NOW()),cleanup_pending=FALSE,current_response_id=NULL,lease_expires_at=NULL,error_code=$5,ticket_hash=NULL,input_seconds=COALESCE($6,input_seconds),output_seconds=COALESCE($7,output_seconds)
      WHERE id=$1 AND user_id=$2 AND controller_id IS NOT DISTINCT FROM $3`,
      [
        id,
        userId,
        controllerId,
        reason,
        errorCode,
        metrics?.inputSeconds ?? null,
        metrics?.outputSeconds ?? null
      ]
    );
  }
  async recover(): Promise<number> {
    const result = await this.database
      .query(`UPDATE voice_sessions SET status=CASE WHEN pending_usd>0 THEN 'usage_uncertain' ELSE CASE WHEN deadline_at<=NOW() OR status='preparing' THEN 'expired' ELSE 'lost' END END,
      ended_at=NOW(),cleanup_pending=FALSE,ticket_hash=NULL,current_response_id=NULL,lease_expires_at=NULL,error_code='voice_connection_lost'
      WHERE status IN ('preparing','connecting','listening','responding','stopping') AND ((status='preparing' AND ticket_expires_at<=NOW()) OR (status<>'preparing' AND lease_expires_at<NOW()))`);
    return result.rowCount;
  }
  async addProposal(input: {
    id: string;
    sessionId: string;
    userId: string;
    callId: string;
    digest: string;
    ciphertext: EncryptedEnvelope;
    expiresAt: string;
  }): Promise<VoiceProposalRecord> {
    return this.database.transaction(async (tx) => {
      const session = (
        await tx.query(
          `SELECT id FROM voice_sessions WHERE id=$1 AND user_id=$2 AND status IN ('listening','responding') AND deadline_at>NOW() FOR UPDATE`,
          [input.sessionId, input.userId]
        )
      ).rows[0];
      if (!session) throw unavailable();
      const count = (
        await tx.query(`SELECT COUNT(*) AS n FROM voice_proposals WHERE session_id=$1`, [
          input.sessionId
        ])
      ).rows[0];
      if (Number(count?.n) >= 20)
        throw new AthanorError(
          'voice_proposal_limit',
          'Review existing voice proposals before proposing more work',
          409
        );
      const row = (
        await tx.query(
          `INSERT INTO voice_proposals(id,session_id,user_id,provider_call_id,digest,ciphertext,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id,provider_call_id) DO NOTHING RETURNING *`,
          [
            input.id,
            input.sessionId,
            input.userId,
            input.callId,
            input.digest,
            JSON.stringify(input.ciphertext),
            input.expiresAt
          ]
        )
      ).rows[0];
      if (!row) throw unavailable();
      return proposal(row);
    });
  }
  async proposals(userId: string, sessionId: string): Promise<VoiceProposalRecord[]> {
    return (
      await this.database.query(
        `SELECT * FROM voice_proposals WHERE session_id=$1 AND user_id=$2 ORDER BY created_at,id LIMIT 20`,
        [sessionId, userId]
      )
    ).rows.map(proposal);
  }
  async proposal(
    userId: string,
    sessionId: string,
    id: string,
    lock = false
  ): Promise<VoiceProposalRecord | null> {
    const row = (
      await this.database.query(
        `SELECT * FROM voice_proposals WHERE id=$1 AND session_id=$2 AND user_id=$3${lock ? ' FOR UPDATE' : ''}`,
        [id, sessionId, userId]
      )
    ).rows[0];
    return row ? proposal(row) : null;
  }
  async decideProposal(
    userId: string,
    id: string,
    digest: string,
    status: 'confirmed' | 'rejected',
    messageId: string | null
  ): Promise<void> {
    const result = await this.database.query(
      `UPDATE voice_proposals SET status=$4,message_id=$5 WHERE id=$1 AND user_id=$2 AND digest=$3 AND status='pending' AND expires_at>NOW()`,
      [id, userId, digest, status, messageId]
    );
    if (result.rowCount !== 1)
      throw new AthanorError(
        'voice_proposal_changed',
        'This voice proposal is no longer awaiting confirmation',
        409
      );
  }
}
