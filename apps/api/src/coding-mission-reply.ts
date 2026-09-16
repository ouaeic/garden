import { z } from 'zod';
import { AthanorError, decryptJson, encryptJson, unwrapDataKey } from '@athanor/core';
import type { TaskRecord } from '@athanor/data';
import type { RouteContext } from './http/server-context.js';

/** A clarification resumes the same bounded mission; it never creates a new spending allocation. */
export async function replyToCodingMission(
  context: RouteContext,
  task: TaskRecord,
  value: unknown,
  messageId?: string
) {
  const { prompt } = z
    .object({ prompt: z.string().trim().min(1).max(200_000) })
    .strict()
    .parse(value);
  if (
    task.status !== 'awaiting_user' ||
    !task.agentStateCiphertext ||
    (await context.store.hasPendingApproval(task.userId, task.id))
  )
    throw new AthanorError(
      'coding_mission_scoped',
      'Send new work to the parent task; a specialist accepts replies only to its pending question',
      409
    );
  const workspace = await context.store.getWorkspace(task.userId, task.workspaceId);
  if (!workspace?.wrappedKey)
    throw new AthanorError('workspace_not_found', 'Workspace not found', 404);
  const key = unwrapDataKey(workspace.wrappedKey, context.masterKey, workspace.id);
  if (task.agentStateCiphertext.aad !== `task-state:${task.id}`)
    throw new AthanorError(
      'task_context_unavailable',
      'The specialist checkpoint is unavailable',
      409
    );
  const state = decryptJson<Record<string, unknown> & { messages: Array<Record<string, unknown>> }>(
    task.agentStateCiphertext,
    key
  );
  if (
    !Array.isArray(state.messages) ||
    !state.question ||
    typeof state.question !== 'object' ||
    state.pending
  )
    throw new AthanorError(
      'task_context_unavailable',
      'The specialist checkpoint is unavailable',
      409
    );
  state.messages.push({ role: 'user', content: prompt });
  delete state.question;
  state.questionsAsked = 0;
  const saved = await context.store.replyToCodingMission({
    ...(messageId ? { messageId } : {}),
    userId: task.userId,
    taskId: task.id,
    expectedState: task.agentStateCiphertext,
    agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
    messageCiphertext: encryptJson({ markdown: prompt }, key, `task-event:${task.id}`)
  });
  if (!saved)
    throw new AthanorError(
      'coding_mission_scoped',
      'This specialist no longer has that pending question; refresh its current state',
      409
    );
  return context.privateTaskResponse(
    (await context.store.getTask(task.userId, task.id))!,
    workspace
  );
}
