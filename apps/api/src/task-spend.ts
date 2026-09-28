import { z } from 'zod';
import { SpendWindow } from '@garden/contracts';
import { decryptJson, unwrapDataKey } from '@garden/core';
import type { DataStore, TaskRecord } from '@garden/data';
import { revealedTaskEvent } from './context.js';

const PausedRequest = z.object({
  blockedBy: z.enum(['task', 'daily', 'monthly']),
  windows: z.array(SpendWindow).min(1),
  estimateUsd: z.number().finite().nonnegative()
});

/** Reprice the recorded paused request against current limits and commitments. */
export async function taskResumeSpend(store: DataStore, task: TaskRecord, masterKey: Uint8Array) {
  let estimateUsd = 0;
  let estimateSource: 'paused_step' | 'current_spend' = 'current_spend';
  if (task.spendPausedAt) {
    const [rows, workspace] = await Promise.all([
      store.listTaskEvents(task.id, 0, { kind: 'status', limit: 1 }),
      store.getWorkspace(task.userId, task.workspaceId)
    ]);
    const row = rows[0];
    if (row?.payloadCiphertext && workspace?.wrappedKey && row.createdAt <= task.spendPausedAt) {
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const content = revealedTaskEvent(
        row.summary,
        decryptJson(row.payloadCiphertext, key, `task-event:${task.id}`)
      );
      const paused = PausedRequest.safeParse(content.payload);
      if (paused.success) {
        estimateUsd = paused.data.estimateUsd;
        estimateSource = 'paused_step';
      }
    }
  }
  return {
    estimateSource,
    decision: await store.spendGuard({
      userId: task.userId,
      taskId: task.id,
      estimateUsd,
      includeOpenCommitments: true
    })
  };
}
