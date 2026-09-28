import {
  decryptJson,
  deriveServiceSecret,
  encryptJson,
  type EncryptedEnvelope
} from '@garden/core';
import type { Database } from '@garden/data';

export interface OperationIdentity {
  userId: string;
  idempotencyKey: string;
  method: string;
  path: string;
  requestHash: string;
}

export const operationReceipts = (masterKey: Uint8Array) => {
  const key = Buffer.from(deriveServiceSecret(masterKey, 'api-operation-receipts'), 'base64url');
  const aad = (identity: OperationIdentity, status: number) =>
    JSON.stringify([
      'api-operation:v1',
      identity.userId,
      identity.idempotencyKey,
      identity.method,
      identity.path,
      identity.requestHash,
      status
    ]);
  return {
    seal: (identity: OperationIdentity, status: number, value: unknown) =>
      encryptJson({ value }, key, aad(identity, status)),
    open: <T>(identity: OperationIdentity, status: number, envelope: EncryptedEnvelope): T => {
      const expected = aad(identity, status);
      if (envelope.aad !== expected) throw new Error('Operation receipt context mismatch');
      return decryptJson<{ value: T }>(envelope, key, expected).value;
    }
  };
};

/** Seal existing receipts before the API accepts writes, retaining their replay identity. */
export const sealLegacyOperationResponses = async (
  database: Database,
  masterKey: Uint8Array
): Promise<void> => {
  const receipts = operationReceipts(masterKey);
  while (true) {
    const count = await database.transaction(async (transaction) => {
      const result = await transaction.query(
        `SELECT user_id,idempotency_key,method,path,request_hash,response_status,response_body
         FROM api_operations WHERE response_body IS NOT NULL
         ORDER BY user_id,idempotency_key LIMIT 100 FOR UPDATE`
      );
      for (const row of result.rows) {
        const identity = {
          userId: String(row.user_id),
          idempotencyKey: String(row.idempotency_key),
          method: String(row.method),
          path: String(row.path),
          requestHash: String(row.request_hash)
        };
        const encrypted = receipts.seal(identity, Number(row.response_status), row.response_body);
        await transaction.query(
          `UPDATE api_operations SET response_ciphertext=$3::jsonb,response_body=NULL
           WHERE user_id=$1 AND idempotency_key=$2`,
          [identity.userId, identity.idempotencyKey, JSON.stringify(encrypted)]
        );
      }
      return result.rowCount;
    });
    if (count === 0) return;
  }
};
