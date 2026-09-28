import { GardenError, type EncryptedEnvelope } from '@garden/core';
import type { DictationReceipt } from '@garden/contracts';
import type { Database } from '../database.js';
import { IdentityStore } from './identity.js';
import { iso, optionalText } from './rows.js';

const receipt = (row: Record<string, unknown>): DictationReceipt => ({
  id: String(row.id),
  modelId: optionalText(row.model_id),
  providerRef: optionalText(row.provider_ref),
  state: row.state as DictationReceipt['state'],
  quantitySeconds: Number(row.quantity),
  reservationUsd: row.state === 'reserved' ? Number(row.cost_usd) : 0,
  costUsd: row.state === 'reserved' ? null : Number(row.cost_usd),
  createdAt: iso(row.created_at)
});

export class DictationStore {
  constructor(private readonly database: Database) {}
  async listDictationReceipts(userId: string): Promise<DictationReceipt[]> {
    const result = await this.database.query(
      `SELECT * FROM usage_entries WHERE user_id=$1
      AND task_id IS NULL AND resource_class='media:transcription' AND kind='model_inference'
      AND idempotency_key LIKE $2 AND state IN ('reserved','settled','released')
      ORDER BY (state='reserved') DESC,created_at DESC,id DESC LIMIT 100`,
      [userId, `dictation:${userId}:%`]
    );
    return result.rows.map(receipt);
  }
  async reconcileDictationReceipt(input: {
    userId: string;
    id: string;
    costUsd: number;
    receiptCiphertext: EncryptedEnvelope;
  }): Promise<DictationReceipt> {
    if (!Number.isFinite(input.costUsd) || input.costUsd < 0 || input.costUsd > 1_000_000)
      throw new GardenError('dictation_receipt_invalid', 'Enter the actual provider charge', 400);
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const updated = await tx.query(
        `UPDATE usage_entries SET state='settled',cost_usd=$3
        WHERE id=$1 AND user_id=$2 AND task_id IS NULL AND resource_class='media:transcription'
        AND kind='model_inference' AND idempotency_key LIKE $4 AND state='reserved' RETURNING *`,
        [input.id, input.userId, input.costUsd, `dictation:${input.userId}:%`]
      );
      if (updated.rows.length !== 1)
        throw new GardenError(
          'dictation_receipt_unavailable',
          'This held dictation charge is no longer available',
          409
        );
      await new IdentityStore(tx).recordSecurityEvent({
        userId: input.userId,
        kind: 'dictation_receipt_reconciled',
        outcome: 'allowed',
        metadata: { usageId: input.id, costUsd: input.costUsd, receipt: input.receiptCiphertext }
      });
      return receipt(updated.rows[0]!);
    });
  }
}
