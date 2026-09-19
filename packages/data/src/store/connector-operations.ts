import { createHash, randomUUID } from 'node:crypto';
import { AthanorError, type EncryptedEnvelope } from '@athanor/core';
import type { Database } from '../database.js';
import { json, iso } from './rows.js';

export interface ConnectorOperationRecord {
  id: string;
  userId: string;
  connectorId: string;
  taskId: string;
  action: string;
  state: 'pending' | 'completed';
  recoveryCiphertext: EncryptedEnvelope | null;
  resultCiphertext: EncryptedEnvelope | null;
  createdAt: string;
}
export interface ConnectorOperationIdentity {
  userId: string;
  connectorId: string;
  taskId: string;
  action: string;
  operationKey: string;
}
const record = (row: Record<string, unknown>): ConnectorOperationRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  connectorId: String(row.connector_id),
  taskId: String(row.task_id),
  action: String(row.action),
  state: row.state as 'pending' | 'completed',
  recoveryCiphertext: row.recovery_ciphertext
    ? json<EncryptedEnvelope>(row.recovery_ciphertext)
    : null,
  resultCiphertext: row.result_ciphertext ? json<EncryptedEnvelope>(row.result_ciphertext) : null,
  createdAt: iso(row.created_at)
});
export const connectorOperationAad = (
  operation: Pick<ConnectorOperationRecord, 'id' | 'userId' | 'connectorId'>,
  field: 'recovery' | 'result'
) => `connector-operation:${operation.userId}:${operation.connectorId}:${operation.id}:${field}`;

/** Checkpoints commit before external effects; the session lock survives those individual commits. */
export class ConnectorOperationStore {
  constructor(private readonly database: Database) {}

  async withOperation<T>(
    identity: ConnectorOperationIdentity,
    execute: (input: {
      operation: ConnectorOperationRecord;
      fresh: boolean;
      signal: AbortSignal;
      saveRecovery: (envelope: EncryptedEnvelope) => Promise<void>;
      complete: (envelope: EncryptedEnvelope) => Promise<void>;
    }) => Promise<T>
  ): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(identity.operationKey) || !/^[a-z_]{1,80}$/.test(identity.action))
      throw new AthanorError(
        'connector_operation_invalid',
        'Invalid connected-service operation identity.'
      );
    const lock = createHash('sha256')
      .update(
        JSON.stringify([
          'connector-operation',
          identity.userId,
          identity.connectorId,
          identity.operationKey
        ])
      )
      .digest()
      .readUInt32BE(0);
    return this.database.withAdvisoryLock(
      lock,
      async (connection) => {
        if (!connection) throw new Error('Durable operations need an autocommit lock session');
        const database = connection;
        const created = await database.query(
          `INSERT INTO connector_operations(id,user_id,connector_id,task_id,action,operation_key)
         SELECT $1,c.user_id,c.id,t.id,$5,$6 FROM connectors c JOIN tasks t ON t.user_id=c.user_id
         WHERE c.id=$3 AND c.user_id=$2 AND c.enabled=TRUE AND t.id=$4
         ON CONFLICT(user_id,connector_id,operation_key) DO NOTHING RETURNING *`,
          [
            randomUUID(),
            identity.userId,
            identity.connectorId,
            identity.taskId,
            identity.action,
            identity.operationKey
          ]
        );
        const existing =
          created.rows[0] ??
          (
            await database.query(
              `SELECT o.* FROM connector_operations o JOIN connectors c ON c.id=o.connector_id
         WHERE o.user_id=$1 AND o.connector_id=$2 AND o.operation_key=$3 AND c.enabled=TRUE`,
              [identity.userId, identity.connectorId, identity.operationKey]
            )
          ).rows[0];
        if (!existing)
          throw new AthanorError('connector_not_found', 'The account or task is unavailable.');
        const operation = record(existing);
        if (operation.action !== identity.action || operation.taskId !== identity.taskId)
          throw new AthanorError(
            'connector_operation_conflict',
            'The operation key belongs to different work.'
          );
        let complete = operation.state === 'completed';
        let active = true;
        const save = async (field: 'recovery' | 'result', envelope: EncryptedEnvelope) => {
          if (!active || connection.signal.aborted)
            throw new AthanorError('connector_operation_lost', 'The operation lock was released.');
          if (complete)
            throw new AthanorError(
              'connector_operation_completed',
              'The operation already has a final receipt.'
            );
          if (
            envelope.aad !== connectorOperationAad(operation, field) ||
            Buffer.byteLength(JSON.stringify(envelope)) > 100_000
          )
            throw new AthanorError(
              'connector_operation_context',
              'The operation receipt has the wrong context or exceeds its size limit.'
            );
          const sql =
            field === 'recovery'
              ? `UPDATE connector_operations SET recovery_ciphertext=$3::jsonb,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND state='pending'`
              : `UPDATE connector_operations SET result_ciphertext=$3::jsonb,state='completed',updated_at=NOW() WHERE id=$1 AND user_id=$2 AND state='pending'`;
          const changed = await database.query(sql, [
            operation.id,
            operation.userId,
            JSON.stringify(envelope)
          ]);
          if (changed.rowCount !== 1)
            throw new AthanorError(
              'connector_operation_lost',
              'The operation receipt could not be saved.'
            );
          if (field === 'result') complete = true;
        };
        try {
          return await execute({
            operation,
            signal: connection.signal,
            fresh: created.rowCount === 1,
            saveRecovery: (envelope) => save('recovery', envelope),
            complete: (envelope) => save('result', envelope)
          });
        } finally {
          active = false;
        }
      },
      { autocommit: true }
    );
  }
}
