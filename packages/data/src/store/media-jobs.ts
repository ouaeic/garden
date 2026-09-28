import { randomUUID } from 'node:crypto';
import { GardenError } from '@garden/core';
import type { EncryptedEnvelope } from '@garden/core';
import type { MediaJobStatus } from '@garden/contracts';
import type { Database } from '../database.js';
import type { BillingStore } from './billing.js';
import { iso, json, optionalText } from './rows.js';

export interface MediaJobRecord {
  id: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  requestKey: string;
  requestHash: string;
  requestCiphertext: EncryptedEnvelope;
  modelId: string;
  operation: 'generate' | 'edit' | 'extend';
  sourceJobId: string | null;
  batchId: string | null;
  durationSeconds: number | null;
  extensionCount: number;
  status: MediaJobStatus;
  providerJobId: string | null;
  progress: number | null;
  reservationUsd: number;
  costUsd: number | null;
  costSource: 'provider' | 'quote' | 'unresolved';
  watching: boolean;
  retentionApprovedAt: string;
  outputPath: string | null;
  artifactId: string | null;
  errorCiphertext: EncryptedEnvelope | null;
  attempts: number;
  nextPollAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
const mapJob = (row: Record<string, unknown>): MediaJobRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  taskId: String(row.task_id),
  requestKey: String(row.request_key),
  requestHash: String(row.request_hash),
  requestCiphertext: json(row.request_ciphertext),
  modelId: String(row.model_id),
  operation: row.operation as MediaJobRecord['operation'],
  sourceJobId: optionalText(row.source_job_id),
  batchId: optionalText(row.batch_id),
  durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
  extensionCount: Number(row.extension_count),
  status: row.status as MediaJobStatus,
  providerJobId: optionalText(row.provider_job_id),
  progress: row.progress === null ? null : Number(row.progress),
  reservationUsd: Number(row.reservation_usd),
  costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
  costSource: row.cost_source as MediaJobRecord['costSource'],
  watching: Boolean(row.watching),
  retentionApprovedAt: iso(row.retention_approved_at),
  outputPath: optionalText(row.output_path),
  artifactId: optionalText(row.artifact_id),
  errorCiphertext: row.error_ciphertext ? json(row.error_ciphertext) : null,
  attempts: Number(row.attempts),
  nextPollAt: iso(row.next_poll_at),
  leaseOwner: optionalText(row.lease_owner),
  leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});
const reservationKey = (id: string) => `provider-media:${id}`;

/** A submission intent is committed before the provider sees it. An interrupted POST is never retried. */
export class MediaJobStore {
  constructor(
    private readonly database: Database,
    private readonly billing: BillingStore
  ) {}

  async createMediaJob(input: {
    id: string;
    userId: string;
    workspaceId: string;
    taskId: string;
    requestKey: string;
    requestHash: string;
    requestCiphertext: EncryptedEnvelope;
    modelId: string;
    operation?: 'generate' | 'edit' | 'extend';
    sourceJobId?: string;
    batchId?: string;
    durationSeconds?: number;
    extensionCount?: number;
    reservationUsd: number;
    privacyRoute: 'external';
    retentionApproved: boolean;
    outputPath: string;
  }): Promise<MediaJobRecord> {
    if (input.privacyRoute !== 'external' || input.retentionApproved !== true)
      throw new GardenError(
        'media_retention_approval_required',
        'Approve provider retention for this video job before submission',
        409
      );
    if (
      !Number.isFinite(input.reservationUsd) ||
      input.reservationUsd <= 0 ||
      input.reservationUsd > 10_000
    )
      throw new GardenError(
        'media_reservation_invalid',
        'Choose a bounded positive video reservation',
        400
      );
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const existing = await tx.query('SELECT * FROM provider_media_jobs WHERE request_key=$1', [
        input.requestKey
      ]);
      if (existing.rows[0]) {
        const job = mapJob(existing.rows[0]);
        if (
          job.userId !== input.userId ||
          job.taskId !== input.taskId ||
          job.requestHash !== input.requestHash
        )
          throw new GardenError(
            'media_request_conflict',
            'This submission key belongs to a different request',
            409
          );
        return job;
      }
      const task = await tx.query(
        'SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3',
        [input.taskId, input.userId, input.workspaceId]
      );
      if (!task.rows.length) throw new GardenError('not_found', 'Task not found', 404);
      if ((input.operation ?? 'generate') !== 'generate') {
        const source = input.sourceJobId
          ? await tx.query(
              'SELECT * FROM provider_media_jobs WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE',
              [input.sourceJobId, input.userId, input.workspaceId]
            )
          : null;
        const original = source?.rows[0];
        if (
          !original ||
          original.status !== 'completed' ||
          original.model_id !== input.modelId ||
          !original.provider_job_id
        )
          throw new GardenError(
            'media_source_invalid',
            'Choose a completed video from this workspace and provider model',
            409
          );
        const count = Number(original.extension_count) + (input.operation === 'extend' ? 1 : 0);
        if (
          input.extensionCount !== count ||
          count > 6 ||
          !input.durationSeconds ||
          input.durationSeconds > 120 ||
          (input.operation === 'edit' &&
            input.durationSeconds !== Number(original.duration_seconds)) ||
          (input.operation === 'extend' &&
            (input.durationSeconds <= Number(original.duration_seconds) ||
              input.durationSeconds > Number(original.duration_seconds) + 20))
        )
          throw new GardenError(
            'media_lineage_invalid',
            'The requested video exceeds its source duration or extension limits',
            400
          );
      } else if (input.sourceJobId || input.extensionCount)
        throw new GardenError(
          'media_lineage_invalid',
          'A new generation cannot claim an existing source lineage',
          400
        );
      const decision = await this.billing.spendGuardIn(tx, {
        userId: input.userId,
        taskId: input.taskId,
        estimateUsd: input.reservationUsd,
        includeOpenCommitments: true
      });
      if (decision.outcome === 'deny')
        throw new GardenError(
          'spend_cap_reached',
          'The video reservation exceeds the remaining spend allowance',
          402
        );
      const result = await tx.query(
        `INSERT INTO provider_media_jobs(id,user_id,workspace_id,task_id,request_key,request_hash,request_ciphertext,model_id,status,reservation_usd,retention_approved_at,output_path,operation,source_job_id,duration_seconds,extension_count,batch_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,NOW(),$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          input.id,
          input.userId,
          input.workspaceId,
          input.taskId,
          input.requestKey,
          input.requestHash,
          JSON.stringify(input.requestCiphertext),
          input.modelId,
          input.reservationUsd,
          input.outputPath,
          input.operation ?? 'generate',
          input.sourceJobId ?? null,
          input.durationSeconds ?? null,
          input.extensionCount ?? 0,
          input.batchId ?? null
        ]
      );
      await tx.query(
        `INSERT INTO usage_entries(id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,idempotency_key,cost_usd,model_id)
        VALUES($1,$2,$3,$4,'model_inference','media:video',1,'generation',0,'reserved',$5,$6,$7)`,
        [
          randomUUID(),
          input.userId,
          input.workspaceId,
          input.taskId,
          reservationKey(input.id),
          input.reservationUsd,
          input.modelId
        ]
      );
      return mapJob(result.rows[0]!);
    });
  }

  async getMediaJob(userId: string, id: string): Promise<MediaJobRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM provider_media_jobs WHERE user_id=$1 AND id=$2',
      [userId, id]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }
  async listMediaJobs(userId: string, taskId: string, limit = 40): Promise<MediaJobRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM provider_media_jobs WHERE user_id=$1 AND task_id=$2 AND
      (status NOT IN ('completed','failed','cancelled','expired') OR id IN
        (SELECT id FROM provider_media_jobs WHERE user_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT $3))
      ORDER BY created_at DESC`,
      [userId, taskId, Math.max(1, Math.min(100, limit))]
    );
    return result.rows.map(mapJob);
  }
  async listMediaBatchJobs(userId: string, batchId: string): Promise<MediaJobRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM provider_media_jobs WHERE user_id=$1 AND batch_id=$2 ORDER BY created_at,id',
      [userId, batchId]
    );
    return result.rows.map(mapJob);
  }
  async leaseMediaJob(owner: string): Promise<MediaJobRecord | null> {
    return this.database.transaction(async (tx) => {
      // No request ID means a dead submitter may have charged the account. Preserve that uncertainty.
      await tx.query(`UPDATE provider_media_jobs SET status='submission_uncertain',lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
        WHERE status='submitting' AND lease_expires_at<NOW()`);
      const result = await tx.query(
        `UPDATE provider_media_jobs SET lease_owner=$1,lease_expires_at=NOW()+INTERVAL '5 minutes',
          status=CASE WHEN status='queued' THEN 'submitting' ELSE status END,attempts=attempts+1,updated_at=NOW()
        WHERE id=(SELECT id FROM provider_media_jobs WHERE watching AND next_poll_at<=NOW()
          AND (batch_id IS NULL OR provider_job_id IS NOT NULL) AND status IN ('queued','pending','in_progress','delivering') AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
          ORDER BY next_poll_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
        [owner]
      );
      return result.rows[0] ? mapJob(result.rows[0]) : null;
    });
  }
  async updateMediaJob(input: {
    id: string;
    leaseOwner: string;
    status: MediaJobStatus;
    providerJobId?: string;
    progress?: number;
    costUsd?: number;
    costSource?: 'provider' | 'quote';
    errorCiphertext?: EncryptedEnvelope | null;
    artifactId?: string;
    nextPollSeconds?: number;
  }): Promise<boolean> {
    if (input.costUsd !== undefined && (!Number.isFinite(input.costUsd) || input.costUsd < 0))
      throw new Error('Invalid media settlement');
    return this.database.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE provider_media_jobs SET status=$3,provider_job_id=COALESCE($4,provider_job_id),progress=COALESCE($5,progress),
        cost_usd=COALESCE($6,cost_usd),cost_source=COALESCE($7,cost_source),error_ciphertext=$8,
        artifact_id=COALESCE($9,artifact_id),next_poll_at=NOW()+($10::double precision*INTERVAL '1 second'),
        lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
        WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>NOW() RETURNING *`,
        [
          input.id,
          input.leaseOwner,
          input.status,
          input.providerJobId ?? null,
          input.progress ?? null,
          input.costUsd ?? null,
          input.costSource ?? null,
          input.errorCiphertext ? JSON.stringify(input.errorCiphertext) : null,
          input.artifactId ?? null,
          Math.max(1, Math.min(3600, input.nextPollSeconds ?? 15))
        ]
      );
      const row = result.rows[0];
      if (!row) return false;
      if (input.costUsd !== undefined)
        await tx.query(
          `UPDATE usage_entries SET state='settled',cost_usd=$2,provider_ref=$3 WHERE idempotency_key=$1`,
          [reservationKey(input.id), input.costUsd, String(row.model_id)]
        );
      return true;
    });
  }
  async setMediaJobWatching(
    userId: string,
    id: string,
    watching: boolean
  ): Promise<MediaJobRecord | null> {
    const result = await this.database.query(
      `UPDATE provider_media_jobs SET watching=$3,
      status=CASE WHEN $3 AND status='delivery_failed' THEN 'delivering' ELSE status END,next_poll_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, watching]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }
  async completeMediaJob(input: {
    id: string;
    leaseOwner: string;
    nameCiphertext: EncryptedEnvelope;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
  }): Promise<MediaJobRecord | null> {
    return this.database.transaction(async (tx) => {
      const current = await tx.query(
        `SELECT * FROM provider_media_jobs WHERE id=$1 AND lease_owner=$2
        AND lease_expires_at>NOW() AND status='delivering' FOR UPDATE`,
        [input.id, input.leaseOwner]
      );
      const row = current.rows[0];
      if (!row) return null;
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [row.workspace_id]);
      const artifactId = randomUUID();
      await tx.query(
        `INSERT INTO artifacts(id,user_id,workspace_id,task_id,name_ciphertext,mime_type,size_bytes,version,sha256,storage_key,logical_key)
        VALUES($1,$2,$3,$4,$5,'video/mp4',$6,1,$7,$8,$9)`,
        [
          artifactId,
          row.user_id,
          row.workspace_id,
          row.task_id,
          JSON.stringify(input.nameCiphertext),
          input.sizeBytes,
          input.sha256,
          input.storageKey,
          `media-job:${input.id}`
        ]
      );
      const updated = await tx.query(
        `UPDATE provider_media_jobs SET status='completed',progress=100,artifact_id=$2,
        error_ciphertext=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING *`,
        [input.id, artifactId]
      );
      await tx.query(
        'INSERT INTO provider_media_delivery_outbox(job_id) VALUES($1) ON CONFLICT(job_id) DO NOTHING',
        [input.id]
      );
      return mapJob(updated.rows[0]!);
    });
  }
  async reconcileMediaJob(
    userId: string,
    id: string,
    providerJobId: string
  ): Promise<MediaJobRecord | null> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(providerJobId))
      throw new Error('Invalid provider job ID');
    const result = await this.database.query(
      `UPDATE provider_media_jobs SET provider_job_id=$3,status='pending',watching=TRUE,next_poll_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND user_id=$2 AND status='submission_uncertain' RETURNING *`,
      [id, userId, providerJobId]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }
}
