/**
 * The half of an expired approval that `cleanupExpired` does not do.
 *
 * Marking the approval `expired` leaves the task in `awaiting_user`, which nothing re-leases: it
 * waited forever, held its credit reservation against the monthly allowance, and had lost the
 * card that was the only way to answer it. This is the pass that releases the money and moves the
 * task somewhere the owner can restart it.
 */

import { encryptJson, unwrapDataKey } from '@garden/core';
import type { SupportedContext } from '../http/server-context.js';

export const createApprovalSweep = (context: SupportedContext) => {
  const { log, database, store, masterKey } = context;
  /**
   * `cleanupExpired` marks a lapsed approval 'expired' and stops there, and nothing re-leases
   * `awaiting_user`: left alone, the task would wait forever, hold its credit reservation against
   * the monthly allowance, and lose the approval card that was the only way to answer it. Releasing
   * the reservation comes first - a crash in between then leaves the row still `awaiting_user` for
   * the next sweep, where the opposite order would strand the credits for good. `paused` is the
   * destination because it is the one waiting state every client already offers a way out of.
   */
  const sweepExpiredApprovals = async (): Promise<number> => {
    const stranded = await database.query<{
      approval_id: string;
      task_id: string;
      user_id: string;
      workspace_id: string;
    }>(
      `SELECT DISTINCT ON (a.task_id)
         a.id AS approval_id, a.task_id, t.user_id, t.workspace_id
       FROM approvals a
       JOIN tasks t ON t.id = a.task_id
       WHERE a.status = 'expired' AND t.status = 'awaiting_user'
         AND NOT EXISTS (
           SELECT 1 FROM approvals live
           WHERE live.task_id = a.task_id AND live.status = 'pending' AND live.expires_at > NOW()
         )
       ORDER BY a.task_id, a.expires_at DESC, a.id DESC
       LIMIT 100`
    );
    let swept = 0;
    for (const row of stranded.rows) {
      const taskId = String(row.task_id);
      const userId = String(row.user_id);
      const released = await database.query(
        `UPDATE usage_entries SET state='released' WHERE task_id=$1 AND state='reserved'`,
        [taskId]
      );
      if (!(await store.setTaskStatusForUser(userId, taskId, 'paused'))) continue;
      const workspace = await store.getWorkspaceById(String(row.workspace_id));
      if (workspace?.wrappedKey) {
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        await store.appendTaskEvent({
          taskId,
          kind: 'warning',
          summary: 'Encrypted approval expiry event',
          payloadCiphertext: encryptJson(
            {
              __gardenEventVersion: 1,
              summary:
                'The approval this task was waiting for expired unanswered, so the task is paused and its reserved credits are back. Resume it to ask again.',
              // Owner-facing by construction: the task is stopped and only their reply starts it.
              payload: {
                owner: true,
                code: 'approval_expired',
                approvalId: String(row.approval_id)
              }
            },
            key,
            `task-event:${taskId}`
          )
        });
      }
      swept += 1;
      log.info('approval.expired_swept', {
        taskId,
        approvalId: String(row.approval_id),
        count: released.rowCount ?? 0
      });
    }
    return swept;
  };

  return sweepExpiredApprovals;
};
