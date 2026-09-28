/**
 * Going back: what an undo point would cost, and taking it.
 *
 * A trajectory operation can replace the filesystem as well as the transcript, which is why it is
 * refused to API tokens at its own route rather than by the scope table - the table is read from
 * `onRequest`, before there is a body to tell `conversation` from `both`.
 */

import { randomUUID } from 'node:crypto';
import { TaskTrajectoryRequest } from '@garden/contracts';
import type {
  CheckpointRestorePreview,
  PrivacyRoute,
  RewindScope,
  TaskRewindPreview,
  ModelRelease
} from '@garden/contracts';
import {
  GardenError,
  decryptJson,
  encryptJson,
  unwrapDataKey,
  ownerMessageContent
} from '@garden/core';
import type { UserRecord, WorkspaceCheckpointRecord } from '@garden/data';
import type { z } from 'zod';
import { checkpointResponse, ownerPriceCeiling } from '../context.js';
import { requireMainModel } from '../main-model-selection.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { errorFields } from '../log.js';

export const registerTrajectoryRoutes = (context: RouteContext): void => {
  const {
    log,
    app,
    store,
    masterKey,
    runner,
    taskTitle,
    privateTaskResponse,
    nameIndexFor,
    resolveSpendCeiling,
    assertSpendCeilingAllowed,
    modelsForUser,
    EXECUTING_STATUSES,
    assertWorkspaceHasNoActiveWork,
    idempotent
  } = context;
  const createTaskTrajectory = async (
    user: UserRecord,
    parentId: string,
    input: z.infer<typeof TaskTrajectoryRequest>
  ) => {
    const parent = await store.getTask(user.id, parentId);
    if (!parent) throw new GardenError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, parent.workspaceId);
    if (!workspace?.wrappedKey) throw new GardenError('workspace_not_found', 'Workspace not found');
    const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    const events = await store.listTaskEvents(parent.id);
    const conversational = events.filter((event) =>
      ['user_message', 'assistant_message'].includes(event.kind)
    );
    const target = conversational.find((event) => event.id === input.eventId);
    if (!target)
      throw new GardenError(
        'trajectory_point_not_found',
        'Choose a user or assistant message from this task',
        404
      );
    if (input.operation === 'edit' && target.kind !== 'user_message')
      throw new GardenError('trajectory_point_invalid', 'Only a user message can be edited', 409);
    if (input.operation === 'retry' && target.kind !== 'assistant_message')
      throw new GardenError(
        'trajectory_point_invalid',
        'Choose an assistant response to retry',
        409
      );

    /**
     * Which of the two the owner asked to rewind.
     *
     * A named checkpoint is honoured as given; omitting it means "whichever one covers this point",
     * which the server resolves and reports back. No checkpoint is a refusal rather than a silent
     * downgrade to a conversation-only fork: an undo that quietly did half of what was asked is
     * the thing this whole mechanism exists to stop.
     */
    const rewindScope: RewindScope = input.rewind ?? 'conversation';
    let restoredCheckpoint: WorkspaceCheckpointRecord | null = null;
    if (rewindScope !== 'conversation') {
      restoredCheckpoint = input.checkpointId
        ? await store.getWorkspaceCheckpoint(user.id, input.checkpointId)
        : await store.checkpointForTaskEvent(user.id, parent.id, target.id);
      if (!restoredCheckpoint || restoredCheckpoint.workspaceId !== workspace.id)
        throw new GardenError(
          'checkpoint_unavailable',
          'The computer cannot be put back to this point: that turn changed nothing, or its undo point has been cleared',
          409
        );
      if (workspace.status !== 'running')
        throw new GardenError('workspace_unavailable', 'Workspace is not running');
    }
    /**
     * Restoring is what makes the rewind true, so it happens before anything is written: a failed
     * restore must leave no task claiming a rewind that did not happen.
     */
    let safetySnapshotId: string | null = null;
    const restoreComputer = async (): Promise<void> => {
      if (!restoredCheckpoint) return;
      /*
       * Two things restoring a snapshot has always done, and rewinding the computer never did.
       *
       * The first is refusing while the agent is working. This deletes and rewrites the filesystem
       * under whatever is running: a file being written mid-call lands in a tree that is about to
       * be replaced, and the step continues against a machine that silently became a different one.
       *
       * The second is a way back. Every other destructive act in the product takes a point first;
       * this one asked the owner to choose a past state and then made the present unreachable by
       * any route in the product. The id goes into the transcript note, so the sentence saying what
       * happened also says how to undo it.
       */
      await assertWorkspaceHasNoActiveWork(user.id, workspace.id, {
        refusal:
          'The agent is working on this computer. Stop or pause it before putting its files back.',
        busyStatuses: EXECUTING_STATUSES
      });
      const safety = await store.createWorkspaceSnapshot({
        userId: user.id,
        workspaceId: workspace.id,
        name: `Safety before rewind · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        sizeBytes: 0
      });
      const archived = await runner.request<{ sizeBytes: number }>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'control',
        scopes: ['workspace.manage'],
        path: `/v1/workspaces/${workspace.id}/snapshots`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ snapshotId: safety.id })
      });
      await store.completeWorkspaceSnapshot(String(safety.id), archived.sizeBytes);
      safetySnapshotId = String(safety.id);
      await runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'control',
        scopes: ['workspace.manage'],
        path: `/v1/workspaces/${workspace.id}/checkpoints/${restoredCheckpoint.id}/restore`,
        method: 'POST',
        contentType: 'application/json',
        body: '{}'
      });
    };
    /**
     * `computer` alone is the machine going back while the conversation carries on forward, so it
     * forks nothing: the transcript the owner is reading stays the transcript they are reading,
     * with a note in it saying what happened to the files underneath.
     */
    if (rewindScope === 'computer') {
      await restoreComputer();
      await store.appendTaskEvent({
        taskId: parent.id,
        kind: 'status',
        summary: 'Computer rewound',
        payloadCiphertext: encryptJson(
          {
            filesystemRestored: true,
            restoredCheckpointId: restoredCheckpoint!.id,
            rewoundToEventId: target.id,
            // How to undo the undo. Named in the transcript because that is where somebody looks
            // when they realise the state they just left was the one they wanted.
            safetySnapshotId
          },
          dataKey,
          `task-event:${parent.id}`
        )
      });
      return privateTaskResponse((await store.getTask(user.id, parent.id))!, workspace);
    }

    const copiedEvents = conversational.filter((event) =>
      input.operation === 'branch'
        ? event.sequence <= target.sequence
        : event.sequence < target.sequence
    );
    type MessagePayload = { markdown?: string; attachments?: string[] };
    const messagePayloads = new Map<string, MessagePayload>();
    const eventPayload = (event: (typeof conversational)[number]): MessagePayload => {
      const cached = messagePayloads.get(event.id);
      if (cached) return cached;
      if (!event.payloadCiphertext) return {};
      if (event.payloadCiphertext.aad !== `task-event:${parent.id}`)
        throw new GardenError(
          'encrypted_event_context',
          'Task event encryption context is invalid'
        );
      const payload = decryptJson<MessagePayload>(event.payloadCiphertext, dataKey);
      messagePayloads.set(event.id, payload);
      return payload;
    };
    const eventMarkdown = (event: (typeof conversational)[number]): string =>
      eventPayload(event).markdown ?? '';
    const eventModelContent = (event: (typeof conversational)[number]): string => {
      const payload = eventPayload(event);
      return event.kind === 'user_message' && payload.markdown
        ? ownerMessageContent({ prompt: payload.markdown, attachments: payload.attachments })
        : (payload.markdown ?? '');
    };
    let inheritedMessages: Array<Record<string, unknown> & { role: string; content: string }> =
      copiedEvents.flatMap((event) => {
        const markdown = eventModelContent(event);
        return markdown
          ? [
              {
                role: event.kind === 'user_message' ? 'user' : 'assistant',
                content: markdown
              }
            ]
          : [];
      });

    let systemMessages: Array<{ role: string; content: string }> = [];
    if (parent.agentStateCiphertext) {
      if (parent.agentStateCiphertext.aad !== `task-state:${parent.id}`)
        throw new GardenError('task_context_invalid', 'Task checkpoint context is invalid', 409);
      const parentState = decryptJson<{
        messages?: Array<Record<string, unknown> & { role: string; content: string }>;
      }>(parent.agentStateCiphertext, dataKey);
      systemMessages = Array.isArray(parentState.messages)
        ? parentState.messages.filter(
            (message) =>
              message.role === 'system' &&
              !message.content.startsWith('ACTIVE USER-VISIBLE PLAN') &&
              !message.content.startsWith('CONVERSATION TRAJECTORY')
          )
        : [];
      if (Array.isArray(parentState.messages)) {
        const eventIndexes = new Map<string, number>();
        let nextEvent = 0;
        for (const [messageIndex, message] of parentState.messages.entries()) {
          const expected = conversational[nextEvent];
          if (!expected) break;
          const expectedRole = expected.kind === 'user_message' ? 'user' : 'assistant';
          if (message.role !== expectedRole || message.content !== eventModelContent(expected))
            continue;
          eventIndexes.set(expected.id, messageIndex);
          nextEvent += 1;
        }
        const targetMessageIndex = eventIndexes.get(target.id);
        const firstMessageIndex = eventIndexes.get(conversational[0]?.id ?? '');
        if (targetMessageIndex !== undefined && firstMessageIndex !== undefined) {
          const end = input.operation === 'branch' ? targetMessageIndex + 1 : targetMessageIndex;
          inheritedMessages = parentState.messages
            .slice(firstMessageIndex, end)
            .filter((message) => message.role !== 'system');
        }
      }
    }
    /*
     * The owner rewrote the FIRST message, so there is nothing behind it to inherit.
     *
     * Named here and used twice below: it is what makes `agentStateCiphertext` null, and it is why
     * the fork's opening window is the new request alone. It is also the reason `cachePrefixTaskId`
     * in `apps/worker/src/window.ts` admits `retry` and NOT `edit` - a fork with no inherited
     * trajectory that ranked its knowledge block and packed its memory against the parent's prompt
     * would be answering the question its owner had just thrown away.
     *
     * It is computed and not stored, which is the whole of what stops the worker distinguishing the
     * two kinds of edit: `tasks.fork_kind` is 'edit' for both, and an edit of a LATER message does
     * keep a full inherited trajectory and is the case where inheriting the parent's prefix pays.
     * Reinstating `edit` there wants a column this route can write with this value.
     */
    const editingInitialPrompt =
      input.operation === 'edit' && copiedEvents.length === 0 && target === conversational[0];
    if (!editingInitialPrompt && systemMessages.length === 0)
      throw new GardenError(
        'task_context_unavailable',
        'This point is available after the task saves its first conversation checkpoint',
        409
      );

    const runsImmediately = input.operation !== 'branch';
    if (runsImmediately && workspace.status !== 'running')
      throw new GardenError('workspace_unavailable', 'Workspace is not running');
    const maxComputeCredits = runsImmediately ? input.maxComputeCredits : 0;
    let selected: z.infer<typeof ModelRelease> | undefined;
    let reservedCredits = 0;
    // A branch is a copy that does not run, so it commits no money and is not measured against the
    // caps; an edit or a retry starts work immediately and is.
    let spendCeilingUsd: number | null = null;
    /*
     * Which model the new path runs on.
     *
     * The contract has carried `modelId` and `privacyRoute` on all three trajectory operations since
     * they were written, with the comment explaining that naming one is how "that answer was weak,
     * try the stronger model" happens without retyping the request - and this handler read neither,
     * so every fork silently ran on the parent's model and the two fields were parsed and dropped.
     *
     * The route-match refusal is the one `/messages` gives, and it is applied only when the caller
     * names something. A plain retry keeps the exact check it has always had: the parent's own model
     * being re-validated against a privacy route that may have moved under it since the task started
     * would refuse work that has nothing wrong with it.
     */
    const forkPrivacyRoute = (input.privacyRoute ?? parent.privacyRoute) as PrivacyRoute;
    const namesModel = input.modelId !== undefined || input.privacyRoute !== undefined;
    if (runsImmediately || namesModel) {
      const catalog = await modelsForUser(user);
      selected = namesModel
        ? requireMainModel({
            modelId: input.modelId ?? parent.modelId,
            catalog,
            privacyRoute: forkPrivacyRoute,
            ceiling: ownerPriceCeiling(await store.effectiveSpendLimits(user.id))
          })
        : catalog.find((model) => model.id === parent.modelId);
      if (!selected || selected.availability !== 'available')
        throw new GardenError('model_unavailable', 'The selected model is not available');
      if (namesModel && selected.privacyRoute !== forkPrivacyRoute)
        throw new GardenError(
          'model_unavailable',
          'The selected model is not available for this privacy route'
        );
    }
    if (runsImmediately) {
      spendCeilingUsd = await resolveSpendCeiling(
        user.id,
        'maxSpendUsd' in input ? input.maxSpendUsd : undefined
      );
      await assertSpendCeilingAllowed({ userId: user.id, ceilingUsd: spendCeilingUsd });
      reservedCredits = maxComputeCredits;
    }

    const parentTitle = await taskTitle(parent, workspace);
    const editedPrompt = input.operation === 'edit' ? input.prompt : undefined;
    const editedAttachments = editedPrompt ? eventPayload(target).attachments : undefined;
    const lastOwnerEvent = [...copiedEvents]
      .reverse()
      .find((event) => event.kind === 'user_message');
    const retriedMessage = lastOwnerEvent ? eventPayload(lastOwnerEvent) : {};
    const promptAttachments = editedPrompt
      ? editedAttachments
      : input.operation === 'retry'
        ? retriedMessage.attachments
        : undefined;
    const title = (
      input.operation === 'edit'
        ? `${editedPrompt!.split(/\s+/).slice(0, 9).join(' ')} · edited`
        : `${parentTitle.replace(/\s+· (?:branch|retry|edited)$/, '')} · ${input.operation}`
    ).slice(0, 160);
    const forkId = randomUUID();
    const trajectoryInstruction = {
      role: 'system',
      content:
        rewindScope === 'both'
          ? 'CONVERSATION TRAJECTORY: This is a new, independent path through the conversation. Do not assume that later messages or decisions from the source path still apply. The machine has been put back to how it was at this point, so any file, install or process state you remember from after it no longer exists; work from what is there now.'
          : 'CONVERSATION TRAJECTORY: This is a new, independent path through the conversation. Do not assume that later messages or decisions from the source path still apply. The machine is shared with the source and was not rewound, so inspect current files and application state before changing them; rolling the chat back does not restore the filesystem.'
    };
    const trajectoryMessages = [
      ...systemMessages,
      ...inheritedMessages,
      ...(editedPrompt
        ? [
            {
              role: 'user',
              content: ownerMessageContent({ prompt: editedPrompt, attachments: editedAttachments })
            }
          ]
        : []),
      trajectoryInstruction
    ];
    const agentStateCiphertext = editingInitialPrompt
      ? null
      : encryptJson(
          { messages: trajectoryMessages, step: 0, credits: 0, turn: 0 },
          dataKey,
          `task-state:${forkId}`
        );
    const prompt =
      editedPrompt ??
      (input.operation === 'retry'
        ? (retriedMessage.markdown ??
          [...inheritedMessages].reverse().find((message) => message.role === 'user')?.content ??
          'Retry the preceding user request.')
        : 'Continue from this conversation branch.');
    await restoreComputer();
    const fork = await store.createTaskBranch({
      id: forkId,
      userId: user.id,
      workspaceId: workspace.id,
      parentTaskId: parent.id,
      branchedFromEventId: target.id,
      forkKind: input.operation,
      titleCiphertext: encryptJson({ title }, dataKey, `task-title:${workspace.id}`),
      nameIndex: nameIndexFor(title, prompt, dataKey),
      modelId: selected?.id ?? parent.modelId,
      privacyRoute: namesModel ? forkPrivacyRoute : parent.privacyRoute,
      securityMode: parent.securityMode,
      status: runsImmediately ? 'queued' : 'completed',
      maxComputeCredits: reservedCredits,
      maxSpendUsd: spendCeilingUsd,
      promptCiphertext: encryptJson(
        { prompt, attachments: promptAttachments },
        dataKey,
        `task-prompt:${workspace.id}`
      ),
      agentStateCiphertext,
      rewindScope,
      restoredCheckpointId: restoredCheckpoint?.id ?? null
    });
    if (runsImmediately && selected) {
      await store.recordUsage({
        userId: user.id,
        workspaceId: workspace.id,
        taskId: fork.id,
        kind: 'task_compute',
        resourceClass: selected.usageClass,
        quantity: reservedCredits,
        unit: 'credits',
        credits: reservedCredits,
        state: 'reserved',
        idempotencyKey: `task:${fork.id}:reservation`
      });
    }
    await store.appendTaskEvent({
      taskId: fork.id,
      kind: 'task_created',
      summary:
        input.operation === 'branch'
          ? 'Conversation branch ready'
          : input.operation === 'edit'
            ? 'Edited path queued'
            : 'Response retry queued',
      payloadCiphertext: encryptJson(
        {
          parentTaskId: parent.id,
          branchedFromEventId: target.id,
          forkKind: input.operation,
          filesystemRestored: Boolean(restoredCheckpoint),
          restoredCheckpointId: restoredCheckpoint?.id ?? null
        },
        dataKey,
        `task-event:${fork.id}`
      )
    });
    for (const event of copiedEvents) {
      const markdown = eventMarkdown(event);
      if (!markdown) continue;
      await store.appendTaskEvent({
        taskId: fork.id,
        kind: event.kind,
        summary: event.summary,
        payloadCiphertext: encryptJson(
          {
            markdown,
            ...(event.kind === 'user_message'
              ? { attachments: eventPayload(event).attachments }
              : {})
          },
          dataKey,
          `task-event:${fork.id}`
        )
      });
    }
    if (editedPrompt) {
      await store.appendTaskEvent({
        taskId: fork.id,
        kind: 'user_message',
        summary: 'Edited user message',
        payloadCiphertext: encryptJson(
          { markdown: editedPrompt, attachments: editedAttachments, editedFromEventId: target.id },
          dataKey,
          `task-event:${fork.id}`
        )
      });
    }
    if (
      runsImmediately &&
      input.stopSource &&
      !['completed', 'failed', 'cancelled'].includes(parent.status) &&
      (await store.cancelTaskAndReleaseReservations(user.id, parent.id))
    )
      await store.appendTaskEvent({
        taskId: parent.id,
        kind: 'status',
        summary: 'Source path stopped',
        payloadCiphertext: encryptJson(
          { alternateTaskId: fork.id, forkKind: input.operation },
          dataKey,
          `task-event:${parent.id}`
        )
      });
    return context.privateTaskResponse(fork);
  };

  app.post<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/trajectory',
    async (request, reply) => {
      const user = requireUser(request.user);
      const input = TaskTrajectoryRequest.parse(request.body);
      /**
       * A `computer` or `both` rewind deletes and rewrites the workspace tree. The other door to
       * that same act - `POST /v1/workspaces/:id/snapshots/:sid/restore` - is closed to bearer
       * tokens by `requiredApiTokenScope` returning `workspaces:write`, which a `tasks:write`
       * automation token does not hold; this door was open to one, because the scope table keys on
       * the route and every `/v1/tasks` write is `tasks:write`. `tasks:write` reads as "may create
       * and modify conversations", which is the same reasoning the `*-token` routes are refused
       * on at the top of this file.
       *
       * It is refused here rather than in `requiredApiTokenScope` because the scope table is
       * consulted from the `onRequest` hook, which runs before Fastify has parsed a body - the
       * distinction this refusal turns on does not exist yet at that point in the lifecycle.
       */
      if (request.apiToken && input.rewind !== 'conversation')
        throw new GardenError(
          'api_token_scope_required',
          // Says the whole thing, because a bearer token meeting this has no other way to find
          // out: which scope is missing is not the point - no scope grants it - and the door that
          // IS open is a different one from the one being knocked on.
          'API tokens cannot put the computer back. A rewind that restores the workspace tree is signed in from the interface only; rewind: "conversation" is available here and forks the transcript without touching the files.',
          403
        );
      return idempotent(request, reply, user, async () =>
        createTaskTrajectory(user, request.params.taskId, input)
      );
    }
  );

  /**
   * What rewinding to one point in the transcript would do, asked one point at a time.
   *
   * There is deliberately no second route listing a conversation's checkpoints. It would answer a
   * coarser version of the same question - a checkpoint may be pruned between the listing and the
   * restore, and a listing cannot say what a restore would change - and the dialog that asks this
   * one is the only thing that ever needed an answer.
   */
  app.get<{ Params: { taskId: string }; Querystring: { eventId?: string } }>(
    '/v1/tasks/:taskId/rewind-preview',
    async (request) => {
      const user = requireUser(request.user);
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new GardenError('task_not_found', 'Task not found');
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      const events = await store.listTaskEvents(task.id);
      const eventId =
        request.query.eventId ??
        events.filter((event) => ['user_message', 'assistant_message'].includes(event.kind)).at(-1)
          ?.id;
      const target = events.find((event) => event.id === eventId);
      if (!target)
        throw new GardenError(
          'trajectory_point_not_found',
          'Choose a user or assistant message from this task',
          404
        );
      const checkpoint = await store.checkpointForTaskEvent(user.id, task.id, target.id);
      let computer: CheckpointRestorePreview | null = null;
      if (checkpoint) {
        // A preview that cannot be produced is not a failed request: the owner is told the
        // computer cannot be rewound to that point, which is a real answer to what they asked.
        computer = await runner
          .request<CheckpointRestorePreview>({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'control',
            scopes: ['workspace.manage'],
            path: `/v1/workspaces/${workspace.id}/checkpoints/${checkpoint.id}/preview`
          })
          .catch((error: unknown) => {
            log.warn('checkpoint.preview_failed', {
              checkpointId: checkpoint.id,
              ...errorFields(error)
            });
            return null;
          });
      }
      const preview: TaskRewindPreview = {
        taskId: task.id,
        eventId: target.id,
        droppedEventCount: events.filter((event) => event.sequence > target.sequence).length,
        checkpoint: checkpoint ? checkpointResponse(checkpoint) : null,
        computer
      };
      return preview;
    }
  );
};
