import { GardenError, type EncryptedEnvelope } from '@garden/core';
import type { Database } from '../database.js';
import { BillingStore } from './billing.js';
import { MediaJobStore } from './media-jobs.js';
import { iso, json, optionalText } from './rows.js';
export type MediaBatchStatus =
  | 'queued'
  | 'uploading'
  | 'file_uploaded'
  | 'submitting'
  | 'submission_uncertain'
  | 'pending'
  | 'delivering'
  | 'completed'
  | 'failed'
  | 'cancelled';
export interface MediaBatchRecord {
  id: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  requestKey: string;
  requestHash: string;
  requestCiphertext: EncryptedEnvelope;
  status: MediaBatchStatus;
  inputFileId: string | null;
  providerBatchId: string | null;
  errorCiphertext: EncryptedEnvelope | null;
  total: number;
  completed: number;
  failed: number;
  reservationUsd: number;
  watching: boolean;
  cancelRequested: boolean;
  cancelSent: boolean;
  providerStatus: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  nextPollAt: string;
  createdAt: string;
  updatedAt: string;
}
const mapBatch = (row: Record<string, unknown>): MediaBatchRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  taskId: String(row.task_id),
  requestKey: String(row.request_key),
  requestHash: String(row.request_hash),
  requestCiphertext: json(row.request_ciphertext),
  status: row.status as MediaBatchStatus,
  inputFileId: optionalText(row.input_file_id),
  providerBatchId: optionalText(row.provider_batch_id),
  errorCiphertext: row.error_ciphertext ? json(row.error_ciphertext) : null,
  total: Number(row.total),
  completed: Number(row.completed),
  failed: Number(row.failed),
  reservationUsd: Number(row.reservation_usd),
  watching: Boolean(row.watching),
  cancelRequested: Boolean(row.cancel_requested),
  cancelSent: Boolean(row.cancel_sent),
  providerStatus: optionalText(row.provider_status),
  leaseOwner: optionalText(row.lease_owner),
  leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
  nextPollAt: iso(row.next_poll_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});
export class MediaBatchStore {
  constructor(private readonly database: Database) {}
  async createMediaBatch(input: {
    id: string;
    userId: string;
    workspaceId: string;
    taskId: string;
    requestKey: string;
    requestHash: string;
    requestCiphertext: EncryptedEnvelope;
    retentionApproved: boolean;
    shots: Array<Parameters<MediaJobStore['createMediaJob']>[0]>;
  }): Promise<MediaBatchRecord> {
    if (
      !input.retentionApproved ||
      !input.shots.length ||
      input.shots.length > 100 ||
      new Set(input.shots.map((shot) => shot.id)).size !== input.shots.length ||
      input.shots.some(
        (shot) =>
          shot.userId !== input.userId ||
          shot.workspaceId !== input.workspaceId ||
          shot.taskId !== input.taskId ||
          shot.operation !== 'generate'
      )
    )
      throw new GardenError(
        'media_batch_invalid',
        'Approve a bounded batch of new videos belonging to this task',
        400
      );
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const existing = await tx.query(
        "SELECT * FROM provider_media_batches WHERE request_key=$1 OR (user_id=$2 AND task_id=$3 AND request_hash=$4 AND status IN ('uploading','submitting','submission_uncertain'))",
        [input.requestKey, input.userId, input.taskId, input.requestHash]
      );
      if (existing.rows[0]) {
        const row = mapBatch(existing.rows[0]);
        if (
          row.userId !== input.userId ||
          row.taskId !== input.taskId ||
          row.requestHash !== input.requestHash
        )
          throw new GardenError(
            'media_batch_conflict',
            'This batch submission key already belongs to another request',
            409
          );
        return row;
      }
      const result = await tx.query(
        `INSERT INTO provider_media_batches(id,user_id,workspace_id,task_id,request_key,request_hash,request_ciphertext,total,reservation_usd) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
        [
          input.id,
          input.userId,
          input.workspaceId,
          input.taskId,
          input.requestKey,
          input.requestHash,
          JSON.stringify(input.requestCiphertext),
          input.shots.length,
          input.shots.reduce((sum, shot) => sum + shot.reservationUsd, 0)
        ]
      );
      const jobs = new MediaJobStore(tx, new BillingStore(tx));
      for (const shot of input.shots) await jobs.createMediaJob({ ...shot, batchId: input.id });
      return mapBatch(result.rows[0]!);
    });
  }
  async getMediaBatch(userId: string, id: string): Promise<MediaBatchRecord | null> {
    const rows = await this.database.query(
      'SELECT * FROM provider_media_batches WHERE user_id=$1 AND id=$2',
      [userId, id]
    );
    return rows.rows[0] ? mapBatch(rows.rows[0]) : null;
  }
  async listMediaBatches(userId: string, taskId: string): Promise<MediaBatchRecord[]> {
    const rows = await this.database.query(
      `SELECT * FROM provider_media_batches WHERE user_id=$1 AND task_id=$2 AND (status NOT IN ('completed','failed','cancelled') OR id IN (SELECT id FROM provider_media_batches WHERE user_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 100)) ORDER BY created_at DESC`,
      [userId, taskId]
    );
    return rows.rows.map(mapBatch);
  }
  async leaseMediaBatch(owner: string): Promise<MediaBatchRecord | null> {
    return this.database.transaction(async (tx) => {
      await tx.query(
        "UPDATE provider_media_batches SET status='submission_uncertain',lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE status IN ('uploading','submitting') AND lease_expires_at<NOW()"
      );
      const result = await tx.query(
        `UPDATE provider_media_batches SET lease_owner=$1,lease_expires_at=NOW()+INTERVAL '5 minutes',updated_at=NOW(),status=CASE WHEN status='queued' THEN 'uploading' WHEN status='file_uploaded' THEN 'submitting' ELSE status END
        WHERE id=(SELECT id FROM provider_media_batches WHERE watching AND next_poll_at<=NOW() AND status IN ('queued','file_uploaded','pending','delivering') AND (lease_expires_at IS NULL OR lease_expires_at<NOW()) ORDER BY next_poll_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
        [owner]
      );
      return result.rows[0] ? mapBatch(result.rows[0]) : null;
    });
  }
  async updateMediaBatch(input: {
    id: string;
    leaseOwner: string;
    status: MediaBatchStatus;
    inputFileId?: string;
    providerBatchId?: string;
    completed?: number;
    failed?: number;
    errorCiphertext?: EncryptedEnvelope;
    nextPollSeconds?: number;
    releaseUnsubmitted?: boolean;
    providerStatus?: string;
  }): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE provider_media_batches SET status=$3,input_file_id=COALESCE($4,input_file_id),provider_batch_id=COALESCE($5,provider_batch_id),completed=COALESCE($6,completed),failed=COALESCE($7,failed),error_ciphertext=$8::jsonb,provider_status=COALESCE($10,provider_status),next_poll_at=NOW()+($9::double precision*INTERVAL '1 second'),lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>NOW() RETURNING *`,
        [
          input.id,
          input.leaseOwner,
          input.status,
          input.inputFileId ?? null,
          input.providerBatchId ?? null,
          input.completed ?? null,
          input.failed ?? null,
          input.errorCiphertext ? JSON.stringify(input.errorCiphertext) : null,
          Math.max(1, Math.min(600, input.nextPollSeconds ?? 15)),
          input.providerStatus ?? null
        ]
      );
      if (!result.rows[0]) return false;
      if (input.status === 'failed' || input.status === 'cancelled') {
        const jobs = await tx.query(
          "UPDATE provider_media_jobs SET status=$2,error_ciphertext=NULL,cost_usd=CASE WHEN $3 THEN 0 ELSE cost_usd END,cost_source=CASE WHEN $3 THEN 'quote' ELSE cost_source END,updated_at=NOW() WHERE batch_id=$1 AND status='queued' AND provider_job_id IS NULL RETURNING id",
          [input.id, input.status, Boolean(input.releaseUnsubmitted)]
        );
        if (input.releaseUnsubmitted)
          for (const job of jobs.rows)
            await tx.query(
              "UPDATE usage_entries SET state='released',cost_usd=0 WHERE idempotency_key=$1 AND state='reserved'",
              [`provider-media:${String(job.id)}`]
            );
      }
      return true;
    });
  }
  async assignMediaBatchResults(input: {
    providerStatus?: string;
    id: string;
    leaseOwner: string;
    results: Array<{
      jobId: string;
      providerJobId?: string;
      costUsd?: number;
      costSource?: 'provider' | 'quote';
      errorCiphertext?: EncryptedEnvelope;
    }>;
  }): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const found = await tx.query(
        "SELECT * FROM provider_media_batches WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>NOW() AND status='pending' FOR UPDATE",
        [input.id, input.leaseOwner]
      );
      if (!found.rows[0]) return false;
      const children = await tx.query('SELECT id FROM provider_media_jobs WHERE batch_id=$1', [
        input.id
      ]);
      const wanted = new Set(children.rows.map((row) => String(row.id)));
      if (
        !wanted.size ||
        input.results.length !== wanted.size ||
        new Set(input.results.map((row) => row.jobId)).size !== wanted.size ||
        input.results.some((row) => !wanted.has(row.jobId))
      )
        throw new Error('Batch result IDs do not match the reserved shots');
      for (const result of input.results) {
        if (
          result.costUsd !== undefined &&
          (!Number.isFinite(result.costUsd) || result.costUsd < 0)
        )
          throw new Error('Invalid batch settlement');
        if (result.providerJobId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(result.providerJobId))
          throw new Error('Invalid batch video ID');
        const row = await tx.query(
          `UPDATE provider_media_jobs SET provider_job_id=$2,status=$3,cost_usd=$4,cost_source=$5,error_ciphertext=$6::jsonb,next_poll_at=NOW(),updated_at=NOW() WHERE id=$1 AND batch_id=$7 AND status='queued' RETURNING model_id`,
          [
            result.jobId,
            result.providerJobId ?? null,
            result.providerJobId ? 'delivering' : 'failed',
            result.costUsd ?? null,
            result.costSource ?? 'unresolved',
            result.errorCiphertext ? JSON.stringify(result.errorCiphertext) : null,
            input.id
          ]
        );
        if (!row.rows[0]) throw new Error('The batch shot changed before delivery assignment');
        if (result.costUsd !== undefined)
          await tx.query(
            "UPDATE usage_entries SET state='settled',cost_usd=$2,provider_ref=$3 WHERE idempotency_key=$1 AND state='reserved'",
            [`provider-media:${result.jobId}`, result.costUsd, String(row.rows[0].model_id)]
          );
      }
      await tx.query(
        "UPDATE provider_media_batches SET status='delivering',completed=0,failed=$3,provider_status=$2,lease_owner=NULL,lease_expires_at=NULL,next_poll_at=NOW(),updated_at=NOW() WHERE id=$1",
        [
          input.id,
          input.providerStatus ?? null,
          input.results.filter((result) => !result.providerJobId).length
        ]
      );
      return true;
    });
  }
  async reconcileMediaBatch(
    userId: string,
    id: string,
    input: { inputFileId?: string; providerBatchId?: string }
  ): Promise<MediaBatchRecord | null> {
    if (
      (!input.inputFileId && !input.providerBatchId) ||
      Object.values(input).some((value) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value))
    )
      throw new Error('Choose a valid provider batch or uploaded input file ID');
    const result = await this.database.query(
      `UPDATE provider_media_batches SET input_file_id=COALESCE($3,input_file_id),provider_batch_id=COALESCE($4,provider_batch_id),status=CASE WHEN $4::text IS NOT NULL THEN 'pending' ELSE 'file_uploaded' END,watching=TRUE,next_poll_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND id=$2 AND status='submission_uncertain' AND ($4::text IS NOT NULL OR input_file_id IS NULL) RETURNING *`,
      [userId, id, input.inputFileId ?? null, input.providerBatchId ?? null]
    );
    return result.rows[0] ? mapBatch(result.rows[0]) : null;
  }
  async requestMediaBatchCancel(userId: string, id: string): Promise<MediaBatchRecord | null> {
    const result = await this.database.query(
      "UPDATE provider_media_batches SET cancel_requested=TRUE,cancel_sent=FALSE,watching=TRUE,next_poll_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND id=$2 AND status IN ('queued','file_uploaded','pending','uploading','submitting') RETURNING *",
      [userId, id]
    );
    return result.rows[0] ? mapBatch(result.rows[0]) : null;
  }
  async markMediaBatchCancelSent(id: string, leaseOwner: string): Promise<boolean> {
    const result = await this.database.query(
      'UPDATE provider_media_batches SET cancel_sent=TRUE,updated_at=NOW() WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>NOW() AND cancel_requested AND NOT cancel_sent',
      [id, leaseOwner]
    );
    return result.rowCount === 1;
  }
  async setMediaBatchWatching(
    userId: string,
    id: string,
    watching: boolean
  ): Promise<MediaBatchRecord | null> {
    const result = await this.database.query(
      'UPDATE provider_media_batches SET watching=$3,next_poll_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND id=$2 RETURNING *',
      [userId, id, watching]
    );
    return result.rows[0] ? mapBatch(result.rows[0]) : null;
  }
}
