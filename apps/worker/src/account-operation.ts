import { createHmac } from 'node:crypto';
import { decryptJson, encryptJson, type AccountOperation } from '@athanor/core';
import { connectorOperationAad, type DataStore } from '@athanor/data';
import { canonicalJson } from './values.js';

/** Identical retries in a turn share intent even if the model gives the tool call a new ID. */
export async function withAccountOperation<T>(input: {
  store: DataStore;
  key: Uint8Array;
  userId: string;
  connectorId: string;
  taskId: string;
  turn: number;
  action: string;
  parameters: unknown;
  execute: (operation: AccountOperation) => Promise<T>;
}): Promise<T> {
  const intent = {
    task: input.taskId,
    connector: input.connectorId,
    action: input.action,
    parameters: input.parameters
  };
  const hash = (value: unknown) =>
    createHmac('sha256', input.key).update(canonicalJson(value)).digest('hex');
  const intentKey = hash(intent);
  const operationKey = hash({ ...intent, turn: input.turn });
  return input.store.withConnectorOperation(
    {
      userId: input.userId,
      connectorId: input.connectorId,
      taskId: input.taskId,
      action: input.action,
      operationKey,
      intentKey
    },
    async ({ operation, signal, saveRecovery, complete }) => {
      const open = (field: 'recovery' | 'result') => {
        const envelope =
          field === 'recovery' ? operation.recoveryCiphertext : operation.resultCiphertext;
        if (!envelope) return null;
        if (envelope.aad !== connectorOperationAad(operation, field))
          throw new Error('The account operation has the wrong encryption context');
        return decryptJson<unknown>(envelope, input.key);
      };
      let recovery = open('recovery'),
        result = open('result'),
        completed = operation.state === 'completed';
      return input.execute({
        id: operation.id,
        get recovery() {
          return recovery;
        },
        get result() {
          return result;
        },
        get completed() {
          return completed;
        },
        signal,
        checkpoint: async (value) => {
          const envelope = encryptJson(
            value,
            input.key,
            connectorOperationAad(operation, 'recovery')
          );
          await saveRecovery(envelope);
          recovery = decryptJson<unknown>(envelope, input.key);
        },
        complete: async (value) => {
          const envelope = encryptJson(
            value,
            input.key,
            connectorOperationAad(operation, 'result')
          );
          await complete(envelope);
          result = decryptJson<unknown>(envelope, input.key);
          completed = true;
        }
      });
    }
  );
}
