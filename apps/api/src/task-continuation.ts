import { randomUUID } from 'node:crypto';
import { ensureProjectExecution, configureConversationInputs } from './project-execution.js';
import { z } from 'zod';
import { ContinueTaskRequest } from '@garden/contracts';
import {
  GardenError,
  assertSpendAllowed,
  decryptJson,
  encryptJson,
  unwrapDataKey
} from '@garden/core';
import type { EncryptedEnvelope } from '@garden/core';
import type { TaskRecord, UserRecord } from '@garden/data';
import { startTurnState } from '@garden/worker';
import type { RouteContext } from './http/server-context.js';
import { validateTaskReasoning } from './task-reasoning.js';
import { replyToCodingMission } from './coding-mission-reply.js';
import { ownerPriceCeiling } from './context.js';
import { requireMainModel } from './main-model-selection.js';

export type TaskContinuationSnapshot = Pick<
  TaskRecord,
  | 'id'
  | 'userId'
  | 'workspaceId'
  | 'modelId'
  | 'privacyRoute'
  | 'reasoningEffort'
  | 'securityMode'
  | 'maxComputeCredits'
  | 'maxSpendUsd'
>;
export const taskContinuationSnapshot = (task: TaskRecord): TaskContinuationSnapshot => ({
  id: task.id,
  userId: task.userId,
  workspaceId: task.workspaceId,
  modelId: task.modelId,
  privacyRoute: task.privacyRoute,
  reasoningEffort: task.reasoningEffort ?? 'auto',
  securityMode: task.securityMode,
  maxComputeCredits: task.maxComputeCredits,
  maxSpendUsd: task.maxSpendUsd
});
export interface RetainedTaskContinuation {
  expected: TaskContinuationSnapshot;
  messageId: string;
  questionId?: string;
  previewStartId?: string;
}
const started = <T>(work: Promise<T>): Promise<() => T> =>
  work.then(
    (value) => () => value,
    (error: unknown) => () => {
      throw error;
    }
  );

/** Retained continuations share the original task authority and never allocate another allowance. */
export async function continueTaskOperation(
  context: RouteContext,
  user: UserRecord,
  taskId: string,
  body: unknown,
  options: { retainBudget?: RetainedTaskContinuation } = {}
) {
  const retained = options.retainBudget;
  if (retained) {
    z.object({ prompt: z.string().trim().min(1).max(200_000) })
      .strict()
      .parse(body);
    z.string().uuid().parse(retained.messageId);
    return context.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      await tx.query('SELECT id FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        taskId,
        user.id
      ]);
      return performContinuation(context, user, taskId, body, retained);
    });
  }
  return performContinuation(context, user, taskId, body);
}

async function performContinuation(
  context: RouteContext,
  user: UserRecord,
  taskId: string,
  body: unknown,
  retained?: RetainedTaskContinuation
) {
  const {
    store,
    masterKey,
    privateTaskResponse,
    resolveSpendCeiling,
    assertSpendCeilingAllowed,
    modelsForUser,
    computeAllowanceFor,
    config
  } = context;
  const input = ContinueTaskRequest.parse(body);
  const taskRead = started(store.getTask(user.id, taskId));
  const guarded = started(
    retained
      ? Promise.resolve(null)
      : resolveSpendCeiling(user.id, input.maxSpendUsd).then(async (ceilingUsd) => {
          await assertSpendCeilingAllowed({ userId: user.id, ceilingUsd, taskId });
          return ceilingUsd;
        })
  );
  const catalogRead = started(retained?.questionId ? Promise.resolve([]) : modelsForUser(user));
  let task = (await taskRead)();
  if (!task) throw new GardenError('task_not_found', 'Task not found');
  if (task.userId !== user.id)
    throw new GardenError(
      'task_owner_required',
      'Start a new task to continue work created by another team member',
      403
    );
  if (retained) {
    const current = taskContinuationSnapshot(task);
    if (
      Object.keys(current).some(
        (field) =>
          current[field as keyof TaskContinuationSnapshot] !==
          retained.expected[field as keyof TaskContinuationSnapshot]
      )
    )
      throw new GardenError(
        'task_proposal_changed',
        'This task’s model, privacy, effort, security, or spending allowance changed. Review a new work proposal.',
        409
      );
    if (task.parentMissionId)
      throw new GardenError(
        'coding_mission_scoped',
        'Send this work proposal to the parent task',
        409
      );
  }
  const activeTask = ['queued', 'planning', 'running', 'awaiting_user', 'paused'].includes(
    task.status
  );
  if (
    !activeTask &&
    !['completed', 'failed', 'awaiting_resource', 'cancelled'].includes(task.status)
  )
    throw new GardenError(
      'task_not_continuable',
      'This task cannot accept another message; branch it or start a new task',
      409
    );
  if (task.parentMissionId) return replyToCodingMission(context, task, body);
  let workspace = await store.getWorkspace(user.id, task.workspaceId);
  if (!workspace?.wrappedKey) throw new GardenError('workspace_not_found', 'Workspace not found');
  if (workspace.status !== 'running')
    throw new GardenError('workspace_unavailable', 'Workspace is not running');
  const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
  if (retained) {
    const prior = (
      await context.database.query(
        `SELECT payload_ciphertext FROM task_events WHERE id=$1 AND task_id=$2 AND kind IN ('queued_message','user_message')`,
        [retained.messageId, task.id]
      )
    ).rows[0];
    if (prior) {
      const payload = decryptJson<{ markdown: string }>(
        prior.payload_ciphertext as EncryptedEnvelope,
        dataKey
      );
      if (payload.markdown !== input.prompt)
        throw new GardenError(
          'task_message_identity_conflict',
          'This message identity already belongs to different work',
          409
        );
      return privateTaskResponse(task, workspace);
    }
    if (retained.questionId) {
      z.string().uuid().parse(retained.questionId);
      const queued = await store.enqueueTaskMessage({
        id: retained.messageId,
        taskId: task.id,
        userId: user.id,
        modelId: task.modelId,
        reasoningEffort: task.reasoningEffort ?? 'auto',
        privacyRoute: task.privacyRoute,
        maxComputeCredits: 0,
        maxSpendUsd: null,
        resourceClass: 'light',
        reservationKey: `task:${task.id}:message:${retained.messageId}:reservation`,
        interrupt: true,
        queuedEventId: retained.messageId,
        questionId: retained.questionId,
        promptCiphertext: encryptJson(
          { prompt: input.prompt, questionId: retained.questionId },
          dataKey,
          `task-message:${task.id}`
        ),
        queuedEventCiphertext: encryptJson(
          {
            markdown: input.prompt,
            questionId: retained.questionId,
            messageId: retained.messageId,
            position: task.queuedMessageCount + 1
          },
          dataKey,
          `task-event:${task.id}`
        )
      });
      if (!queued)
        throw new GardenError(
          'question_changed',
          'The task changed before its answer could be saved.',
          409
        );
      const unparked =
        task.status === 'awaiting_user' &&
        !(await store.hasPendingApproval(user.id, task.id)) &&
        (await store.setTaskStatusForUser(user.id, task.id, 'queued'));
      return privateTaskResponse(
        unparked ? ((await store.getTask(user.id, task.id)) ?? queued) : queued,
        workspace
      );
    }
    assertSpendAllowed(
      await store.spendGuard({
        userId: user.id,
        taskId: task.id,
        estimateUsd: 0,
        includeOpenCommitments: true
      })
    );
  }
  const privacyRoute = retained ? task.privacyRoute : (input.privacyRoute ?? task.privacyRoute);
  const spendCeilingUsd = (await guarded)();
  const catalog = (await catalogRead)();
  const selectedModelId = retained ? task.modelId : (input.modelId ?? task.modelId);
  const selected =
    !retained && (input.modelId !== undefined || input.privacyRoute !== undefined)
      ? requireMainModel({
          modelId: selectedModelId,
          catalog,
          privacyRoute: privacyRoute === 'provider_zdr' ? 'provider_zdr' : 'external',
          ceiling: ownerPriceCeiling(await store.effectiveSpendLimits(user.id))
        })
      : catalog.find((model) => model.id === selectedModelId);
  if (!selected || selected.availability !== 'available' || selected.privacyRoute !== privacyRoute)
    throw new GardenError(
      'model_unavailable',
      'The selected model is not available for this privacy route'
    );
  const reasoningEffort = validateTaskReasoning(
    retained
      ? (task.reasoningEffort ?? 'auto')
      : (input.reasoningEffort ?? task.reasoningEffort ?? 'auto'),
    selected
  );
  if (!retained && !task.parentMissionId) {
    if (workspace.parentWorkspaceId) await configureConversationInputs(context, task);
    else {
      task = await ensureProjectExecution(context, task);
      workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found');
    }
  }
  if (activeTask) {
    const messageId = retained?.messageId ?? randomUUID();
    const queued = await store.enqueueTaskMessage({
      id: messageId,
      taskId: task.id,
      userId: user.id,
      modelId: selected.id,
      modelOverride: !retained && input.modelId !== undefined,
      reasoningEffort,
      ...(!retained && input.securityMode ? { securityMode: input.securityMode } : {}),
      privacyRoute,
      maxComputeCredits: retained
        ? 0
        : Math.max(input.maxComputeCredits, computeAllowanceFor(selected, config.TASK_MAX_STEPS)),
      maxSpendUsd: spendCeilingUsd,
      resourceClass: selected.usageClass,
      reservationKey: `task:${task.id}:message:${messageId}:reservation`,
      ...(!retained && input.interrupt ? { interrupt: true } : {}),
      ...(retained ? { queuedEventId: messageId } : {}),
      promptCiphertext: encryptJson(
        {
          prompt: input.prompt,
          attachments: input.attachments?.length ? input.attachments : undefined
        },
        dataKey,
        `task-message:${task.id}`
      ),
      queuedEventCiphertext: encryptJson(
        {
          markdown: input.prompt,
          attachments: input.attachments?.length ? input.attachments : undefined,
          messageId,
          position: task.queuedMessageCount + 1
        },
        dataKey,
        `task-event:${task.id}`
      )
    });
    if (!queued)
      throw new GardenError(
        'task_message_queue_conflict',
        'The task changed while this message was being queued; send it again',
        409
      );
    const unparked =
      task.status === 'awaiting_user' &&
      !(await store.hasPendingApproval(user.id, task.id)) &&
      (await store.setTaskStatusForUser(user.id, task.id, 'queued'));
    return privateTaskResponse(
      unparked ? ((await store.getTask(user.id, task.id)) ?? queued) : queued,
      workspace
    );
  }
  if (!task.agentStateCiphertext || task.agentStateCiphertext.aad !== `task-state:${task.id}`)
    throw new GardenError(
      'task_context_unavailable',
      'This task stopped before a resumable conversation checkpoint was saved',
      409
    );
  const previousState = decryptJson<
    Record<string, unknown> & { messages: Array<Record<string, unknown>>; turn?: number }
  >(task.agentStateCiphertext, dataKey);
  if (!Array.isArray(previousState.messages))
    throw new GardenError('task_context_invalid', 'Task conversation state is invalid');
  const nextTurn = Math.max(0, Number(previousState.turn ?? 0)) + 1;
  const reservationKey = retained
    ? `task:${task.id}:message:${retained.messageId}:reservation`
    : `task:${task.id}:turn:${nextTurn}:reservation`;
  const nextState = startTurnState(previousState, {
    prompt: input.prompt,
    attachments: input.attachments,
    turn: nextTurn,
    reservationKey
  });
  const updated = await store.continueTask({
    id: task.id,
    userId: user.id,
    modelId: selected.id,
    modelOverride: !retained && input.modelId !== undefined,
    reasoningEffort,
    ...(!retained && input.securityMode ? { securityMode: input.securityMode } : {}),
    privacyRoute,
    additionalComputeCredits: retained ? 0 : input.maxComputeCredits,
    additionalSpendUsd: spendCeilingUsd,
    agentStateCiphertext: encryptJson(nextState, dataKey, `task-state:${task.id}`),
    reservationKey,
    resourceClass: selected.usageClass,
    userMessageCiphertext: encryptJson(
      {
        markdown: input.prompt,
        ...(retained?.previewStartId ? { previewStartId: retained.previewStartId } : {}),
        attachments: input.attachments?.length ? input.attachments : undefined
      },
      dataKey,
      `task-event:${task.id}`
    ),
    ...(retained ? { userMessageId: retained.messageId } : {})
  });
  if (!updated)
    throw new GardenError(
      'task_continue_conflict',
      'This task changed before the follow-up could be queued',
      409
    );
  return privateTaskResponse(updated, workspace);
}
