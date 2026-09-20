/**
 * Claim before an external effect: a missing receipt cannot prove the effect did not happen.
 * Database-only operations can instead commit the claim, mutation and receipt atomically.
 */

import { AthanorError } from '@athanor/core';
import type { UserRecord } from '@athanor/data';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { idempotencyRequestHash } from '../context.js';
import type { ServerBase } from './server-context.js';
import { operationReceipts } from './operation-receipts.js';

interface OperationOptions<T> {
  /** Only use when the callback has no effects outside this database. */
  databaseOnly?: boolean;
  /** Only for an operation with its own durable, identity-bound journal and safe retry protocol. */
  reconcile?: () => Promise<T>;
}

/** The wrapper a route puts round the work it does not want done twice. */
export type IdempotentOperation = <T>(
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRecord,
  operation: () => Promise<T>,
  options?: OperationOptions<T>
) => Promise<T>;

export const createIdempotentOperation = (
  context: Pick<ServerBase, 'store' | 'database' | 'masterKey'>
): IdempotentOperation => {
  const { store } = context;
  const receipts = operationReceipts(context.masterKey);
  const idempotent = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    user: UserRecord,
    operation: () => Promise<T>,
    options: OperationOptions<T> = {}
  ): Promise<T> => {
    const rawKey = request.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key || !/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) {
      throw new AthanorError(
        'idempotency_key_required',
        'A valid Idempotency-Key header is required'
      );
    }
    const operationPath = request.routeOptions.url ?? request.url.split('?')[0]!;
    const requestHash = idempotencyRequestHash(request.method, request.url, request.body);
    const identity = {
      userId: user.id,
      idempotencyKey: key,
      method: request.method,
      path: operationPath,
      requestHash
    };
    const execute = async (): Promise<T> => {
      const replayHeader = request.headers['idempotency-replay-only'];
      if (replayHeader !== undefined && replayHeader !== 'true')
        throw new AthanorError(
          'invalid_operation_replay',
          'Idempotency-Replay-Only accepts true or must be omitted.'
        );
      const replayOnly = replayHeader === 'true';
      const existing = await store.beginOperation({ ...identity, replayOnly });
      let work = operation;
      if (existing) {
        if (
          existing.method !== request.method ||
          existing.path !== operationPath ||
          existing.requestHash !== requestHash
        ) {
          throw new AthanorError(
            'idempotency_conflict',
            'This key was already used for a different operation'
          );
        }
        if (existing.state === 'completed' && existing.responseStatus !== null) {
          if (!existing.responseCiphertext)
            throw new AthanorError(
              'operation_outcome_unknown',
              'The saved response needs reconciliation before retrying.',
              409
            );
          reply.status(existing.responseStatus).header('idempotency-replayed', 'true');
          return receipts.open<T>(identity, existing.responseStatus, existing.responseCiphertext);
        }
        if (options.reconcile && !replayOnly) work = options.reconcile;
        else
          throw new AthanorError(
            existing.state === 'failed' ? 'operation_outcome_unknown' : 'operation_in_progress',
            'The original request may have taken effect. Check its outcome before trying again.',
            409
          );
      }
      if (replayOnly)
        throw new AthanorError(
          'operation_receipt_unavailable',
          'The previous send has no saved receipt. Check your work before starting a new request.',
          409
        );
      try {
        const result = await work();
        await store.completeOperation(
          user.id,
          key,
          reply.statusCode,
          receipts.seal(identity, reply.statusCode, result)
        );
        if (options.reconcile) {
          // Concurrent journal reconciliation must return the same first committed API receipt.
          const saved = await store.beginOperation({ ...identity, replayOnly: true });
          if (
            saved?.state !== 'completed' ||
            saved.responseStatus === null ||
            !saved.responseCiphertext
          )
            throw new AthanorError(
              'operation_outcome_unknown',
              'The saved response needs reconciliation before retrying.',
              409
            );
          reply.status(saved.responseStatus);
          return receipts.open<T>(identity, saved.responseStatus, saved.responseCiphertext);
        }
        return result;
      } catch (error) {
        // A rollback is safe only when every effect belongs to this transaction.
        if (!options.databaseOnly) await store.failOperation(user.id, key).catch(() => undefined);
        throw error;
      }
    };
    return options.databaseOnly ? context.database.transaction(execute) : execute();
  };

  return idempotent;
};
