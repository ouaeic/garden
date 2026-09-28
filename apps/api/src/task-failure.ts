import { decryptJson, type EncryptedEnvelope } from '@garden/core';
import type { DataStore } from '@garden/data';

export async function taskFailure(
  store: DataStore,
  taskId: string,
  key: Uint8Array,
  stateCiphertext?: EncryptedEnvelope | null
) {
  try {
    if (
      stateCiphertext &&
      decryptJson<{ jobWaitId?: string }>(stateCiphertext, key, `task-state:${taskId}`).jobWaitId
    )
      return {
        code: 'background_jobs',
        summary:
          'Background work is running on this computer. Work resumes automatically when the awaited jobs or analysis cells finish; no model calls are made while waiting.'
      };
  } catch {
    // A corrupt checkpoint cannot supply a trustworthy waiting state.
    return null;
  }
  const failure = await store.taskResourceFailure(taskId);
  if (!failure?.payloadCiphertext) return null;
  try {
    const decoded = decryptJson<{ summary?: unknown; payload?: { code?: unknown } }>(
      failure.payloadCiphertext,
      key,
      `task-event:${taskId}`
    );
    return typeof decoded.payload?.code === 'string' && typeof decoded.summary === 'string'
      ? { code: decoded.payload.code, summary: decoded.summary }
      : null;
  } catch {
    // An unreadable record cannot authorize a retry or supply a trustworthy explanation.
    return null;
  }
}
