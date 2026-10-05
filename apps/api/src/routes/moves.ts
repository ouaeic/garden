import { TaskApprovalOffer, TaskDeal, describeApprovalScope } from '@garden/contracts';
import type { OwnerMove, RecordEntry } from '@garden/contracts';
import { decryptJson, unwrapDataKey, type EncryptedEnvelope } from '@garden/core';
import type { TaskRecord, WorkspaceRecord } from '@garden/data';
import { z } from 'zod';
import { textValue } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

/** A connected-service operation that changed something rather than read it. */
const CONNECTOR_WRITE = /send|create|update|delete|remove|write|move|upload|post|patch|put|reply/i;

/**
 * The two lists a returning owner reads first: what is waiting on them, and what left the computer.
 *
 * Both are assembled from records that already exist - parked questions, approvals, spend pauses,
 * connector audit - rather than from a second store, so neither can disagree with the conversation
 * it came from.
 */
export const registerMoveRoutes = (context: RouteContext): void => {
  const { app, store, database, masterKey, privateTaskResponse } = context;

  const opener = (userId: string) => {
    const tasks = new Map<
      string,
      Promise<{
        task: TaskRecord;
        workspace: WorkspaceRecord;
        key: Uint8Array;
        title: string;
      } | null>
    >();
    return (taskId: string) => {
      let found = tasks.get(taskId);
      if (!found) {
        found = (async () => {
          const task = await store.getTask(userId, taskId);
          const workspace = task ? await store.getWorkspace(userId, task.workspaceId) : null;
          if (!task || !workspace?.wrappedKey) return null;
          const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
          const view = (await privateTaskResponse(task, workspace)) as { title?: string };
          return { task, workspace, key, title: view.title ?? 'Conversation' };
        })();
        tasks.set(taskId, found);
      }
      return found;
    };
  };

  const approvalPreview = (
    approval: Record<string, unknown>,
    key: Uint8Array
  ): Record<string, unknown> => {
    try {
      return decryptJson<Record<string, unknown>>(
        approval.previewCiphertext as EncryptedEnvelope,
        key,
        `approval:${String(approval.taskId)}`
      );
    } catch {
      return {};
    }
  };

  app.get('/v1/moves', async (request): Promise<OwnerMove[]> => {
    const user = requireUser(request.user);
    const open = opener(user.id);
    const moves: OwnerMove[] = [];
    const waiting = await database.query(
      `SELECT t.id FROM tasks t
       WHERE t.user_id = $1 AND t.archived_at IS NULL
         AND (t.status = 'awaiting_user' OR t.spend_paused_at IS NOT NULL)
       ORDER BY t.updated_at DESC LIMIT 100`,
      [user.id]
    );
    for (const row of waiting.rows) {
      const opened = await open(String(row.id));
      if (!opened) continue;
      const { task, key, title } = opened;
      const at = new Date(task.updatedAt).toISOString();
      if (task.spendPausedAt)
        moves.push({
          kind: 'spend',
          taskId: task.id,
          taskTitle: title,
          at: new Date(task.spendPausedAt).toISOString(),
          spentUsd: task.spentUsd ?? 0,
          maxSpendUsd: task.maxSpendUsd ?? null
        });
      if (task.status !== 'awaiting_user' || !task.agentStateCiphertext) continue;
      const state = decryptJson<{
        question?: {
          id?: string;
          question: string;
          why?: string;
          deal?: boolean;
          handoff?: { url?: string };
        };
      }>(task.agentStateCiphertext, key);
      const asked = state.question;
      if (!asked?.id) continue;
      const event = (
        await database.query(
          "SELECT payload_ciphertext, created_at FROM task_events WHERE task_id=$1 AND id=$2 AND kind='question_asked'",
          [task.id, asked.id]
        )
      ).rows[0];
      const payload = event
        ? (decryptJson<{ payload?: Record<string, unknown> }>(
            event.payload_ciphertext as EncryptedEnvelope,
            key
          ).payload ?? {})
        : {};
      const base = {
        taskId: task.id,
        taskTitle: title,
        at: event ? new Date(event.created_at as string).toISOString() : at,
        questionId: asked.id
      };
      const deal = asked.deal ? TaskDeal.safeParse(payload.deal) : null;
      if (deal?.success) moves.push({ ...base, kind: 'deal', deal: deal.data });
      else if (asked.handoff)
        moves.push({
          ...base,
          kind: 'handoff',
          question: asked.question,
          ...(asked.handoff.url ? { url: asked.handoff.url } : {})
        });
      else
        moves.push({
          ...base,
          kind: 'question',
          question: asked.question,
          ...(asked.why ? { why: asked.why } : {}),
          options: Array.isArray(payload.options) ? payload.options.map(String) : []
        });
    }
    for (const approval of await store.listApprovals(user.id, 'pending', { limit: 100 })) {
      const opened = await open(String(approval.taskId));
      if (!opened || Date.parse(String(approval.expiresAt)) <= Date.now()) continue;
      const preview = approvalPreview(approval, opened.key);
      const offer = TaskApprovalOffer.safeParse(preview.taskGrant);
      moves.push({
        kind: 'approval',
        taskId: opened.task.id,
        taskTitle: opened.title,
        at: String(approval.createdAt),
        approvalId: String(approval.id),
        action: textValue(preview.action, textValue(approval.action)),
        detail: textValue(preview.preview),
        tool: textValue(preview.tool, textValue(approval.action)),
        sideEffect: approval.sideEffect as Extract<OwnerMove, { kind: 'approval' }>['sideEffect'],
        expiresAt: String(approval.expiresAt),
        ...(approval.sideEffect !== 'external_consequential' &&
        offer.success &&
        offer.data.scope.tool === preview.tool &&
        offer.data.securityMode === opened.task.securityMode &&
        !opened.task.parentMissionId
          ? { runGrant: describeApprovalScope(offer.data.scope) }
          : {})
      });
    }
    return moves.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  });

  app.get<{ Querystring: { limit?: string; taskId?: string } }>('/v1/record', async (request) => {
    const user = requireUser(request.user);
    const limit = z.coerce.number().int().min(1).max(200).default(100).parse(request.query.limit);
    const only = z.uuid().optional().parse(request.query.taskId);
    const open = opener(user.id);
    const entries: RecordEntry[] = [];
    for (const approval of await store.listApprovals(user.id, null, {
      limit,
      taskId: only ?? null
    })) {
      const opened = await open(String(approval.taskId));
      const preview = opened ? approvalPreview(approval, opened.key) : {};
      const status = String(approval.status);
      entries.push({
        id: String(approval.id),
        at: String(approval.createdAt),
        taskId: String(approval.taskId),
        taskTitle: opened?.title ?? null,
        action: textValue(preview.action, textValue(approval.action)),
        detail: textValue(preview.preview),
        tool: textValue(preview.tool, textValue(approval.action)),
        source: approval.decisionScope === 'key' ? 'key' : 'card',
        verdict: status === 'pending' ? 'waiting' : (status as 'approved' | 'denied' | 'expired'),
        sideEffect: approval.sideEffect as RecordEntry['sideEffect']
      });
    }
    for (const audit of await store.listConnectorAudit(user.id, limit, only ?? null)) {
      if (!CONNECTOR_WRITE.test(audit.operation)) continue;
      const opened = audit.taskId ? await open(audit.taskId) : null;
      entries.push({
        id: audit.id,
        at: audit.createdAt,
        taskId: audit.taskId,
        taskTitle: opened?.title ?? null,
        action: audit.operation,
        // The verdict already says it went through; a status code only explains a refusal.
        detail:
          audit.outcome === 'failed' && audit.statusCode
            ? `The service refused it (${audit.statusCode}).`
            : '',
        tool: 'connector_action',
        source: 'connector',
        verdict: audit.outcome === 'denied' ? 'refused' : audit.outcome
      });
    }
    return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
  });
};
