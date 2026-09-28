import { GardenError, type EncryptedEnvelope } from '@garden/core';
import type { Database } from '../database.js';
import { BillingStore } from './billing.js';
import { iso, json } from './rows.js';
export interface MediaAssetRecord {
  id: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  providerHash: string;
  requestKey: string;
  requestHash: string;
  status: 'submitting' | 'completed' | 'submission_uncertain' | 'failed';
  requestCiphertext: EncryptedEnvelope;
  resultCiphertext: EncryptedEnvelope | null;
  reservationUsd: number;
  costUsd: number | null;
  createdAt: string;
  updatedAt: string;
}
const asset = (row: Record<string, unknown>): MediaAssetRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  taskId: String(row.task_id),
  providerHash: String(row.provider_hash),
  requestKey: String(row.request_key),
  requestHash: String(row.request_hash),
  status: row.status as MediaAssetRecord['status'],
  requestCiphertext: json(row.request_ciphertext),
  resultCiphertext: row.result_ciphertext ? json(row.result_ciphertext) : null,
  reservationUsd: Number(row.reservation_usd),
  costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});
export class MediaAssetStore {
  constructor(private readonly database: Database) {}
  async createMediaAsset(
    input: Omit<
      MediaAssetRecord,
      'status' | 'resultCiphertext' | 'createdAt' | 'updatedAt' | 'costUsd'
    > & {
      retentionApproved: boolean;
    }
  ): Promise<MediaAssetRecord> {
    if (
      !input.retentionApproved ||
      !Number.isFinite(input.reservationUsd) ||
      input.reservationUsd <= 0 ||
      input.reservationUsd > 10_000
    )
      throw new GardenError(
        'media_asset_approval_required',
        'Approve temporary provider retention and a positive asset reservation',
        409
      );
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const task = await tx.query(
        'SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND workspace_id=$3',
        [input.taskId, input.userId, input.workspaceId]
      );
      if (!task.rows.length) throw new GardenError('task_not_found', 'Task not found', 404);
      const previous = await tx.query(
        "SELECT id FROM provider_media_assets WHERE request_key=$1 OR (user_id=$2 AND task_id=$3 AND request_hash=$4 AND status IN ('submitting','submission_uncertain'))",
        [input.requestKey, input.userId, input.taskId, input.requestHash]
      );
      if (previous.rows.length)
        throw new GardenError(
          'media_asset_submission_exists',
          'This asset upload already has a submission intent; reconcile it instead of uploading again',
          409
        );
      await new BillingStore(tx).recordUsage({
        userId: input.userId,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        kind: 'model_inference',
        resourceClass: 'media:character',
        quantity: 1,
        unit: 'asset',
        credits: 0,
        state: 'reserved',
        costUsd: input.reservationUsd,
        idempotencyKey: `provider-media-asset:${input.id}`,
        reserveAgainstCaps: true
      });
      const result = await tx.query(
        `INSERT INTO provider_media_assets(id,user_id,workspace_id,task_id,provider_hash,request_key,request_hash,request_ciphertext,reservation_usd)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
        [
          input.id,
          input.userId,
          input.workspaceId,
          input.taskId,
          input.providerHash,
          input.requestKey,
          input.requestHash,
          JSON.stringify(input.requestCiphertext),
          input.reservationUsd
        ]
      );
      return asset(result.rows[0]!);
    });
  }
  async getMediaAsset(userId: string, id: string): Promise<MediaAssetRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM provider_media_assets WHERE id=$1 AND user_id=$2',
      [id, userId]
    );
    return result.rows[0] ? asset(result.rows[0]) : null;
  }
  async listMediaAssets(
    userId: string,
    workspaceId: string,
    providerHash: string
  ): Promise<MediaAssetRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM provider_media_assets WHERE user_id=$1 AND workspace_id=$2 AND provider_hash=$3 ORDER BY created_at DESC LIMIT 100',
      [userId, workspaceId, providerHash]
    );
    return result.rows.map(asset);
  }

  async listTaskMediaAssets(userId: string, taskId: string): Promise<MediaAssetRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM provider_media_assets WHERE user_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 100',
      [userId, taskId]
    );
    return result.rows.map(asset);
  }
  async reconcileMediaAsset(input: {
    id: string;
    userId: string;
    resultCiphertext: EncryptedEnvelope;
    costUsd: number;
  }): Promise<MediaAssetRecord | null> {
    if (!Number.isFinite(input.costUsd) || input.costUsd < 0 || input.costUsd > 10_000)
      throw new GardenError('media_cost_invalid', 'Choose a valid provider invoice cost', 400);
    return this.database.transaction(async (tx) => {
      const changed = await tx.query(
        "UPDATE provider_media_assets SET status='completed',cost_usd=$3,result_ciphertext=$4::jsonb,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN ('completed','submission_uncertain','submitting') AND cost_usd IS NULL RETURNING *",
        [input.id, input.userId, input.costUsd, JSON.stringify(input.resultCiphertext)]
      );
      if (!changed.rows[0]) return null;
      const row = asset(changed.rows[0]);
      await new BillingStore(tx).recordUsage({
        userId: row.userId,
        workspaceId: row.workspaceId,
        taskId: row.taskId,
        kind: 'model_inference',
        resourceClass: 'media:character',
        quantity: 1,
        unit: 'asset',
        credits: 0,
        state: 'settled',
        costUsd: input.costUsd,
        idempotencyKey: `provider-media-asset:${row.id}`,
        settleReservation: true
      });
      return row;
    });
  }
  async finishMediaAsset(input: {
    id: string;
    userId: string;
    status: Exclude<MediaAssetRecord['status'], 'submitting'>;
    resultCiphertext: EncryptedEnvelope;
    refused?: boolean;
  }): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const result = await tx.query(
        "UPDATE provider_media_assets SET status=$3,result_ciphertext=$4::jsonb,cost_usd=CASE WHEN $5 THEN 0 ELSE cost_usd END,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='submitting' RETURNING *",
        [
          input.id,
          input.userId,
          input.status,
          JSON.stringify(input.resultCiphertext),
          Boolean(input.refused && input.status === 'failed')
        ]
      );
      if (!result.rows.length) return false;
      const row = asset(result.rows[0]!);
      if (input.refused && input.status === 'failed')
        await new BillingStore(tx).recordUsage({
          userId: row.userId,
          workspaceId: row.workspaceId,
          taskId: row.taskId,
          kind: 'model_inference',
          resourceClass: 'media:character',
          quantity: 1,
          unit: 'asset',
          credits: 0,
          state: 'released',
          costUsd: 0,
          idempotencyKey: `provider-media-asset:${row.id}`,
          settleReservation: true
        });
      return true;
    });
  }
}
