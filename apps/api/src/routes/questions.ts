import { replyToCodingMission } from '../coding-mission-reply.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GardenError, decryptJson, unwrapDataKey, type EncryptedEnvelope } from '@garden/core';
import { continueTaskOperation, taskContinuationSnapshot } from '../task-continuation.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

const Answer = z
  .object({
    questionId: z.uuid(),
    prompt: z.string().trim().min(1).max(200_000),
    tabId: z.string().max(64).optional()
  })
  .strict();
export function questionAnswerId(taskId: string, questionId: string): string {
  const bytes = createHash('sha256')
    .update(`question-answer:${taskId}:${questionId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x40;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function registerQuestionRoutes(context: RouteContext): void {
  context.app.get<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/intervention',
    async (request) => {
      const user = requireUser(request.user);
      const task = await context.store.getTask(user.id, request.params.taskId);
      if (!task) throw new GardenError('task_not_found', 'Conversation not found', 404);
      const workspace = await context.store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey || !task.agentStateCiphertext || task.status !== 'awaiting_user')
        return null;
      const key = unwrapDataKey(workspace.wrappedKey, context.masterKey, workspace.id);
      const state = decryptJson<{
        question?: {
          question: string;
          handoff?: { kind: string; surface: string; tabId?: string; url?: string };
        };
        pending?: { approvalId: string; handoffOnly?: boolean };
      }>(task.agentStateCiphertext, key);
      if (state.question?.handoff) {
        const row = (
          await context.database.query(
            "SELECT id FROM task_events WHERE task_id=$1 AND kind='question_asked' ORDER BY sequence DESC LIMIT 1",
            [task.id]
          )
        ).rows[0];
        return row
          ? {
              id: row.id,
              ...state.question.handoff,
              title: state.question.question,
              route: 'answer'
            }
          : null;
      }
      if (!state.pending?.handoffOnly) return null;
      const approval = await context.store.getApproval(state.pending.approvalId);
      if (
        !approval ||
        approval.status !== 'pending' ||
        Date.parse(String(approval.expiresAt)) <= Date.now()
      )
        return null;
      const preview = decryptJson<{
        action: string;
        tool: string;
        handoff?: { kind: string; tabId?: string };
      }>(approval.previewCiphertext as EncryptedEnvelope, key);
      return {
        id: state.pending.approvalId,
        kind: preview.handoff?.kind ?? 'private_input',
        tabId: preview.handoff?.tabId,
        surface: preview.tool === 'desktop_action' ? 'desktop' : 'browser',
        title: preview.action,
        route: 'approval'
      };
    }
  );
  context.app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/answer', async (request) => {
    const user = requireUser(request.user);
    const input = Answer.parse(request.body);
    return context.database.transaction(async (tx) => {
      // Match the continuation lock order, including concurrent replies from another device.
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const initial = await context.store.getTask(user.id, request.params.taskId);
      if (initial?.parentMissionId && initial.parentTaskId)
        await tx.query('SELECT id FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE', [
          initial.parentTaskId,
          user.id
        ]);
      await tx.query('SELECT id FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        request.params.taskId,
        user.id
      ]);
      const task = await context.store.getTask(user.id, request.params.taskId);
      if (!task) throw new GardenError('task_not_found', 'Conversation not found', 404);
      const workspace = await context.store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found', 404);
      const key = unwrapDataKey(workspace.wrappedKey, context.masterKey, workspace.id);
      const messageId = questionAnswerId(task.id, input.questionId);
      const prior = (
        await tx.query(
          "SELECT payload_ciphertext FROM task_events WHERE task_id=$1 AND id=$2 AND kind IN ('queued_message','user_message')",
          [task.id, messageId]
        )
      ).rows[0];
      if (prior) {
        const payload = decryptJson<{ markdown: string }>(
          prior.payload_ciphertext as EncryptedEnvelope,
          key
        );
        if (payload.markdown !== input.prompt)
          throw new GardenError(
            'question_already_answered',
            'This question already has an answer. Refresh the conversation.',
            409
          );
        return context.privateTaskResponse(task, workspace);
      }
      const latest = (
        await tx.query(
          "SELECT id FROM task_events WHERE task_id=$1 AND kind='question_asked' ORDER BY sequence DESC LIMIT 1",
          [task.id]
        )
      ).rows[0];
      const state = task.agentStateCiphertext
        ? decryptJson<{
            question?: {
              id?: string;
              continueWith?: string;
              handoff?: { kind: string; tabId?: string; url?: string };
            };
          }>(task.agentStateCiphertext, key)
        : null;
      if (
        !(
          task.status === 'awaiting_user' ||
          (state?.question?.continueWith &&
            ['queued', 'planning', 'running', 'paused', 'awaiting_resource'].includes(task.status))
        ) ||
        !state?.question ||
        (state.question.id ?? latest?.id) !== input.questionId
      )
        throw new GardenError(
          'question_changed',
          'This question is no longer waiting for an answer. Refresh the conversation.',
          409
        );
      if (state.question.handoff?.kind === 'challenge') {
        if (request.apiToken)
          throw new GardenError(
            'session_required',
            'Complete the handoff from a signed-in device',
            403
          );
        const completion = await context.runner
          .request<{ ok?: boolean; error?: { code?: string } }>({
            workspaceId: task.workspaceId,
            userId: user.id,
            role: 'user',
            scopes: ['browser.takeover'],
            path: `/v1/workspaces/${task.workspaceId}/browser/handoff-complete`,
            method: 'POST',
            body: JSON.stringify({
              ...((input.tabId ?? state.question.handoff.tabId)
                ? { tabId: input.tabId ?? state.question.handoff.tabId }
                : {}),
              ...(state.question.handoff.url ? { expectedUrl: state.question.handoff.url } : {})
            }),
            contentType: 'application/json',
            acceptAnyStatus: true,
            timeoutMs: 10000
          })
          .catch(() => null);
        if (!completion?.ok) {
          const blocked = completion?.error?.code === 'browser_bot_wall';
          throw new GardenError(
            blocked ? 'human_verification_incomplete' : 'handoff_unavailable',
            blocked
              ? 'The page still needs human verification. Complete it in the browser, then choose Done and continue.'
              : 'Garden could not check the browser. Reconnect to it and try Done and continue again.',
            blocked ? 409 : 503
          );
        }
      }
      if (task.parentMissionId)
        return replyToCodingMission(context, task, { prompt: input.prompt }, messageId);
      return continueTaskOperation(
        context,
        user,
        task.id,
        { prompt: input.prompt },
        {
          retainBudget: {
            expected: taskContinuationSnapshot(task),
            messageId,
            ...(state.question.id ? { questionId: state.question.id } : {})
          }
        }
      );
    });
  });
}
