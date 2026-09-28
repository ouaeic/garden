import { decryptJson, encryptJson } from '@garden/core';
import type { DataStore } from '@garden/data';

export interface PatchReceipt {
  path: string;
  expectedSha256: string;
  status: 'uncertain' | 'applied' | 'failed';
  beforeSha256?: string;
  reason?: string;
}

/** Intent is durable before writing; a missing acknowledgement always remains uncertain. */
export async function recordPatchReceipt(
  store: DataStore,
  taskId: string,
  key: Uint8Array,
  toolCallId: string,
  receipt: PatchReceipt
): Promise<void> {
  await store.appendTaskEvent({
    taskId,
    kind: 'status',
    summary: 'Encrypted edit receipt',
    payloadCiphertext: encryptJson(
      {
        __gardenEventVersion: 1,
        summary: receipt.status === 'applied' ? 'File edit applied' : 'File edit receipt',
        payload: { patchReceipt: { toolCallId, ...receipt } }
      },
      key,
      `task-event:${taskId}`
    )
  });
}

export async function recoverPatchReceipts(
  store: DataStore,
  taskId: string,
  key: Uint8Array,
  toolCallId: string
): Promise<PatchReceipt[]> {
  const events = await store.listTaskEvents(taskId, 0, { kind: 'status', limit: 1000 });
  const receipts = new Map<string, PatchReceipt>();
  for (const event of events) {
    if (!event.payloadCiphertext) continue;
    const value = decryptJson<{
      payload?: { patchReceipt?: PatchReceipt & { toolCallId: string } };
    }>(event.payloadCiphertext, key);
    const receipt = value.payload?.patchReceipt;
    if (receipt?.toolCallId === toolCallId) receipts.set(receipt.path, receipt);
  }
  return [...receipts.values()];
}
