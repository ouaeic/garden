import { registerQuestionRoutes } from './questions.js';
import { continueTaskOperation } from '../task-continuation.js';
import {
  beginProjectExecution,
  completeProjectExecution,
  ensureProjectExecution
} from '../project-execution.js';
import { stopCodingMissionFamily, removeCodingMissionFamily } from '../coding-mission-cleanup.js';
/**
 * Conversations: starting one, sending to it, reading it back, and the plan it is working to.
 *
 * The two writes that cost money - creating a conversation and sending it a message - resolve a
 * ceiling and assert it before a single token is bought, and they do it against the same helpers
 * the scheduler uses, so a run costs the same whoever started it.
 */

import { randomUUID } from 'node:crypto';
import {
  CreateTaskRequest,
  RaiseTaskSpendCeilingRequest,
  TaskPageQuery,
  UpdateSecurityModeRequest,
  UpdateTaskPlanRequest,
  UpdateTaskRequest
} from '@athanor/contracts';
import type { TaskPage, TaskPlanStep } from '@athanor/contracts';
import {
  AthanorError,
  encryptJson,
  inferModelTask,
  modelFit,
  priceCeilingFields,
  selectPurposeModel,
  spendHalt,
  unwrapDataKey
} from '@athanor/core';
import type { RoutableModel } from '@athanor/core';
import { writeProjectModelPreferences, readProjectModelPreferences } from '@athanor/data';
import { ownerPriceCeiling, resumableTaskStatuses } from '../context.js';
import { withTaskDeliveryStatus } from '../task-delivery-status.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { errorFields } from '../log.js';
import { provisionalTaskTitle } from '../task-titles.js';
import { validateTaskReasoning } from '../task-reasoning.js';
import { recordSecurityEvent } from '../security-events.js';

export const registerTaskRoutes = (context: RouteContext): void => {
  registerQuestionRoutes(context);
  const {
    log,
    app,
    store,
    database,
    masterKey,
    privateTaskResponse,
    privateTaskPlanResponse,
    nameIndexFor,
    openPrompt,
    computeAllowanceFor,
    resolveSpendCeiling,
    assertSpendCeilingAllowed,
    pickModelUnderPriceCeiling,
    modelsForUser,
    config,
    idempotent
  } = context;
  /**
   * The sidebar, a page at a time. `cursor` is the opaque position returned with the previous
   * page - and with the bootstrap, so reaching page two never costs a re-read of page one.
   */
  app.get<{
    Querystring: { workspaceId?: string; cursor?: string; limit?: string; include?: string };
  }>('/v1/tasks', async (request): Promise<TaskPage> => {
    const user = requireUser(request.user);
    const query = TaskPageQuery.parse(request.query);
    const [page, workspaces] = await Promise.all([
      store.listTaskPage(user.id, {
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        include: query.include
      }),
      store.listWorkspaceMetadata(user.id)
    ]);
    const metadata = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    return {
      tasks: await Promise.all(
        (await withTaskDeliveryStatus(database, user.id, page.tasks)).map((task) =>
          privateTaskResponse(task, metadata.get(task.workspaceId))
        )
      ),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      // The page deliberately carries only the newest few runs of any one schedule, so the number
      // of runs on it is not the number of runs there are. Without this the folded line in the
      // sidebar could only count what it was holding, and a watcher that had fired four hundred
      // times said five.
      scheduleRunCounts: page.scheduleRunCounts
    };
  });

  /**
   * Start work now, answer for it later, and refuse in the order the checks were written in.
   *
   * The two writes that cost money each ran a chain of independent reads one after another - the
   * computer, the ceiling, the spend guard, the catalogue, the ranking - so the owner waited for
   * the sum of five round trips to four different tables, none of which was waiting on any of the
   * others. Started together they cost the longest one.
   *
   * Which refusal the owner sees must not change with that, and this is what holds it: the reads
   * are started at once, and the value or the failure of each is unwrapped at the point in the
   * body where the serial version would have reached it. A request that names a missing computer
   * and is also over the cap still answers `workspace_not_found`. Attaching the handler here, on
   * the line that starts the work, is also what keeps a refusal that is thrown early from becoming
   * an unhandled rejection while a check further up is still deciding.
   */
  const started = <T>(work: Promise<T>): Promise<() => T> =>
    work.then(
      (value) => () => value,
      (error: unknown) => () => {
        throw error;
      }
    );

  /** Extensions the router treats as pictures, which is the one attachment kind that changes it. */
  const IMAGE_ATTACHMENT = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i;

  /**
   * Says once, at the top of a conversation, that the model about to answer is behind for the work
   * being asked of it.
   *
   * The web client picks a model before a word is typed - it ranks the catalogue on sign-in for
   * generic work in a 16K window and pins the winner - so by the time the request exists the route
   * has already been decided against something that is not this request. Every automatic pick then
   * arrives here as an explicit `modelId`, which `rankModels` honours without comparison. This is
   * the one place the two facts are in the same scope, and it costs a ranking over a catalogue
   * already in memory: no model call, no tokens, no round trip.
   *
   * At the top of the conversation and nowhere else. The same line on every follow-up would be the
   * narration this interface exists to be losing, and a model the owner kept after reading it once
   * is a decision, not an oversight.
   */
  const noteModelFit = async (input: {
    taskId: string;
    /**
     * Whose ceiling to compare against, so the comparison is over routes they would actually let
     * this box take. Without it the line reads "the router would have reached for X" naming a
     * route the ceiling forbids - advice that cannot be followed, about money, from the one
     * component that knows the limit.
     *
     * The account rather than the limits, because reading the limits is a database round trip and
     * an argument is evaluated before the call it is an argument to. Passed as a value, the read
     * sat in front of every first message on the box - the whole point of not awaiting this - and
     * the `void` in front of the call bought nothing. Inside, it is paid after the owner has their
     * answer.
     */
    userId: string;
    dataKey: Uint8Array;
    catalog: RoutableModel[];
    chosen: RoutableModel;
    privacyRoute: 'provider_zdr' | 'external';
    prompt: string;
    attachments: string[];
  }): Promise<void> => {
    const fit = modelFit({
      models: input.catalog,
      chosen: input.chosen,
      request: {
        privacyRoute: input.privacyRoute,
        requiredCapabilities: ['chat', 'tools'],
        requiredModalities: ['text'],
        minContextTokens: 16_000,
        preference: 'balanced',
        ...priceCeilingFields(ownerPriceCeiling(await store.effectiveSpendLimits(input.userId)))
      },
      signals: {
        prompt: input.prompt,
        // Legacy clients may include image paths in text beside separate attachment metadata.
        hasImages: input.attachments.some((path) => IMAGE_ATTACHMENT.test(path))
      }
    });
    if (!fit.headline) return;
    await store.appendTaskEvent({
      taskId: input.taskId,
      kind: 'notice',
      summary: fit.headline.slice(0, 500),
      payloadCiphertext: encryptJson(
        { headline: fit.headline, detail: fit.detail },
        input.dataKey,
        `task-event:${input.taskId}`
      )
    });
  };

  app.post('/v1/tasks', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = CreateTaskRequest.parse(request.body);
      const project = input.projectId ? await store.getProject(user.id, input.projectId) : null;
      if (input.projectId && !project)
        throw new AthanorError('project_not_found', 'Project not found', 404);
      if (project && input.workspaceId !== project.workspaceId)
        throw new AthanorError(
          'project_workspace_changed',
          'Reload this project before starting a conversation.',
          409
        );
      if (input.source) {
        const source = await store.getTask(user.id, input.source.taskId);
        if (!project || source?.projectId !== project.id)
          throw new AthanorError(
            'project_source_unavailable',
            'The selected context is not in this project.',
            404
          );
        if (
          input.source.eventId &&
          !(
            await database.query('SELECT id FROM task_events WHERE task_id=$1 AND id=$2', [
              source.id,
              input.source.eventId
            ])
          ).rows.length
        )
          throw new AthanorError(
            'project_source_unavailable',
            'The selected message is unavailable.',
            404
          );
      }
      const conversationChoices = project ? input.modelChoices : undefined;
      const conversationOverride = Boolean(project && input.modelId && !input.modelChoices?.main);
      if (project && !input.modelId && !input.modelChoices?.main) {
        const defaults = await readProjectModelPreferences(store, masterKey, {
          id: project.id,
          userId: user.id
        });
        if (defaults.choices.main)
          input.modelChoices = { ...input.modelChoices, main: defaults.choices.main };
      }
      // Three chains, none of which reads anything another one writes: the computer this runs on,
      // the money it may spend, and the model that will answer. See `started` above for why the
      // refusals still arrive in this order.
      const workspaceRead = started(store.getWorkspace(user.id, input.workspaceId));
      const guarded = started(
        resolveSpendCeiling(user.id, input.maxSpendUsd).then(async (ceilingUsd) => {
          await assertSpendCeilingAllowed({ userId: user.id, ceilingUsd });
          return ceilingUsd;
        })
      );
      const routed = started(
        modelsForUser(user).then(async (catalog) => {
          const main = input.modelChoices?.main;
          if (main || input.modelId) {
            const resolved = selectPurposeModel({
              purpose: 'main',
              choice: main ?? { automatic: false, preference: 'balanced', modelId: input.modelId! },
              catalog,
              privacyRoute: input.privacyRoute,
              taskKind: inferModelTask(input.prompt),
              ceiling: ownerPriceCeiling(await store.effectiveSpendLimits(user.id))
            });
            if (!resolved.model)
              throw new AthanorError(
                'model_unavailable',
                resolved.reason ?? 'No model is available for this project'
              );
            if (input.modelId && input.modelId !== resolved.model.id)
              throw new AthanorError(
                'model_choice_conflict',
                'The prompt and project must choose the same main model'
              );
            return { catalog, chosen: { model: resolved.model, message: null } };
          }
          return {
            catalog,
            chosen: await pickModelUnderPriceCeiling(user.id, catalog, {
              privacyRoute: input.privacyRoute,
              taskKind: inferModelTask(input.prompt)
            })
          };
        })
      );
      const workspace = (await workspaceRead)();
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (workspace.status !== 'running')
        throw new AthanorError('workspace_unavailable', 'Workspace is not running');
      const spendCeilingUsd = (await guarded)();
      const { catalog, chosen } = (await routed)();
      const selected = chosen?.model;
      if (
        !selected ||
        selected.availability !== 'available' ||
        selected.privacyRoute !== input.privacyRoute
      ) {
        throw new AthanorError(
          'model_unavailable',
          'The selected model is not available for this privacy route'
        );
      }
      const reasoningEffort = validateTaskReasoning(input.reasoningEffort ?? 'auto', selected);
      const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const title = input.title ?? provisionalTaskTitle(input.prompt);
      const prepared = await database.transaction(async () => {
        const created = await store.createTask({
          userId: user.id,
          workspaceId: workspace.id,
          ...(project ? { projectId: project.id, modelOverride: conversationOverride } : {}),
          ...(conversationChoices
            ? {
                modelChoicesCiphertext: encryptJson(
                  conversationChoices,
                  dataKey,
                  `conversation-models:${project!.id}`
                )
              }
            : {}),
          ...(input.source
            ? {
                conversationSourceCiphertext: encryptJson(
                  input.source,
                  dataKey,
                  `conversation-source:${project!.id}`
                )
              }
            : {}),
          titleCiphertext: encryptJson({ title }, dataKey, `task-title:${workspace.id}`),
          nameIndex: nameIndexFor(title, input.prompt, dataKey),
          modelId: selected.id,
          reasoningEffort,
          privacyRoute: input.privacyRoute,
          maxComputeCredits: Math.max(
            input.maxComputeCredits,
            computeAllowanceFor(selected, config.TASK_MAX_STEPS)
          ),
          maxSpendUsd: spendCeilingUsd,
          securityMode: input.securityMode ?? project?.securityMode ?? workspace.securityMode,
          promptCiphertext: encryptJson(
            {
              prompt: input.prompt,
              attachments: input.attachments?.length ? input.attachments : undefined
            },
            dataKey,
            `task-prompt:${workspace.id}`
          )
        });
        const titled = input.title
          ? await store.renameTask(
              user.id,
              created.id,
              encryptJson({ title }, dataKey, `task-title:${workspace.id}`),
              nameIndexFor(title, input.prompt, dataKey)
            )
          : created;
        if (!titled) throw new AthanorError('task_unavailable', 'The task could not be named', 409);
        if (!project && input.modelChoices && Object.keys(input.modelChoices).length)
          await writeProjectModelPreferences(store, masterKey, titled, {
            expectedRevision: 0,
            choices: input.modelChoices
          });
        return {
          task: titled,
          execution: await beginProjectExecution(
            context,
            titled,
            input.attachments ?? [],
            Boolean(project)
          )
        };
      });
      let task = prepared.task;
      /*
       * The reservation beside the timeline, not behind it.
       *
       * The two events stay in their own order and cannot be run together: `appendTaskEvent` takes
       * the row lock that hands out the sequence number, so racing them is how "Task queued" comes
       * second in the conversation the owner is reading. The usage row is in another table with no
       * ordering to keep, so it no longer waits for either of them.
       */
      await Promise.all([
        store.recordUsage({
          userId: user.id,
          workspaceId: workspace.id,
          taskId: task.id,
          kind: 'task_compute',
          resourceClass: selected.usageClass,
          quantity: input.maxComputeCredits,
          unit: 'credits',
          credits: input.maxComputeCredits,
          state: 'reserved',
          idempotencyKey: `task:${task.id}:reservation`
        }),
        store
          .appendTaskEvent({
            taskId: task.id,
            kind: 'task_created',
            summary: 'Task queued',
            payloadCiphertext: encryptJson(
              {
                model: selected.displayName,
                privacyRoute: selected.privacyRoute,
                budget: input.maxComputeCredits
              },
              dataKey,
              `task-event:${task.id}`
            )
          })
          .then(() =>
            store.appendTaskEvent({
              taskId: task.id,
              kind: 'user_message',
              summary: 'User message',
              payloadCiphertext: encryptJson(
                {
                  markdown: input.prompt,
                  attachments: input.attachments?.length ? input.attachments : undefined
                },
                dataKey,
                `task-event:${task.id}`
              )
            })
          )
      ]);
      /*
       * After the request it is about, so the owner reads what they asked for and then what will be
       * answering it. Started rather than awaited into the response: the task exists and is queued
       * by this point, and neither a ranking over the whole catalogue nor the insert that records
       * it is worth holding a send the owner is watching.
       *
       * The comment here said "caught rather than awaited" while the call was awaited, which is how
       * a synchronous pass over a few hundred models and a round trip to the database stayed in
       * front of every first message on the box without anybody meaning them to be. The `.catch` is
       * attached on this line and not later, so nothing about this can become an unhandled
       * rejection, and the notice still lands ahead of the worker's first frame - it is one insert
       * against a task that has yet to be leased, let alone answered.
       *
       * The round trip came back the same way a second time, as `await store.effectiveSpendLimits`
       * inside the argument list: arguments are evaluated before the call, so the read was in
       * front of `void` and not behind it. The account id goes in instead and the read happens
       * inside.
       */
      void noteModelFit({
        taskId: task.id,
        userId: user.id,
        dataKey,
        catalog,
        chosen: selected,
        privacyRoute: input.privacyRoute,
        prompt: input.prompt,
        attachments: input.attachments ?? []
      }).catch((error: unknown) => log.warn('models.fit_note_failed', errorFields(error)));
      /*
       * What the ceiling did to this pick, when it did something worth saying.
       *
       * `selectModel`'s `relaxed_unbenchmarked` arm is the case: every measured model that could do
       * the work is above the ceiling, so an unmeasured one is answering. That is a fact about the
       * quality of this reply and the owner is the only person who can act on it - by raising the
       * ceiling or accepting the route - and until now it was computed and dropped on the floor. The
       * `blocked` arm never reaches here; it refused the request above.
       */
      if (chosen?.message)
        await store.appendTaskEvent({
          taskId: task.id,
          kind: 'notice',
          summary: chosen.message.slice(0, 500),
          payloadCiphertext: encryptJson(
            { headline: chosen.message, detail: '' },
            dataKey,
            `task-event:${task.id}`
          )
        });
      try {
        task = await completeProjectExecution(context, task, prepared.execution);
      } catch (error) {
        task = (await store.getTask(user.id, task.id)) ?? task;
        await store.appendTaskEvent({
          taskId: task.id,
          kind: 'notice',
          summary: 'Project preparation needs attention',
          payloadCiphertext: encryptJson(
            {
              headline: 'Project preparation needs attention',
              detail:
                error instanceof Error
                  ? error.message
                  : 'The project could not be prepared. Send the message again to retry preparation.'
            },
            dataKey,
            `task-event:${task.id}`
          )
        });
      }
      return privateTaskResponse(task);
    });
  });

  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/messages', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      return continueTaskOperation(context, user, request.params.taskId, request.body);
    });
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    return privateTaskResponse((await withTaskDeliveryStatus(database, user.id, [task]))[0]!);
  });

  app.patch<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(
      request,
      reply,
      user,
      async () => {
        const input = UpdateTaskRequest.parse(request.body ?? {});
        const task = await store.getTask(user.id, request.params.taskId);
        if (!task) throw new AthanorError('task_not_found', 'Task not found');
        const workspace = await store.getWorkspace(user.id, task.workspaceId);
        if (!workspace?.wrappedKey)
          throw new AthanorError('workspace_not_found', 'Workspace not found');
        let current = task;
        if (input.pinned !== undefined || input.archived !== undefined) {
          const filed = await store.updateTaskFiling(user.id, task.id, {
            ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
            ...(input.archived === undefined ? {} : { archived: input.archived })
          });
          if (!filed) throw new AthanorError('task_not_found', 'Task not found');
          current = filed;
        }
        if (input.title === undefined) return privateTaskResponse(current, workspace);
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        const renamed = await store.renameTask(
          user.id,
          task.id,
          encryptJson({ title: input.title }, key, `task-title:${workspace.id}`),
          // The request has not changed, but the vector holds both surfaces and a tsvector cannot be
          // half-rewritten, so the opening is re-tokenized from the task's own ciphertext.
          nameIndexFor(input.title, openPrompt(task, key), key)
        );
        if (!renamed) throw new AthanorError('task_not_found', 'Task not found');
        return privateTaskResponse(renamed, workspace);
      },
      { databaseOnly: true }
    );
  });

  app.delete<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      if (['queued', 'planning', 'running'].includes(task.status))
        throw new AthanorError('task_active', 'Stop this task before deleting it', 409);
      if (task.parentMissionId)
        throw new AthanorError(
          'coding_mission_scoped',
          'Remove isolated specialist work through its parent task',
          409
        );
      if (task.hasCodingFamily) {
        await store.cancelTaskAndReleaseReservations(user.id, task.id);
        await removeCodingMissionFamily(context, task);
      }
      return { deleted: await store.deleteTask(user.id, task.id) };
    });
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/plan', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    const plan = await store.getLatestTaskPlan(task.id);
    return plan ? privateTaskPlanResponse(plan, workspace) : null;
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/plans', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    return Promise.all(
      (await store.listTaskPlans(task.id)).map((plan) => privateTaskPlanResponse(plan, workspace))
    );
  });

  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/plan', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    if (['completed', 'failed', 'cancelled'].includes(task.status))
      throw new AthanorError(
        'invalid_task_state',
        'A finished task plan is immutable; branch by starting a new task',
        409
      );
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    const input = UpdateTaskPlanRequest.parse(request.body);
    const previousPlan =
      input.outputs === undefined ? await store.getLatestTaskPlan(task.id) : null;
    const previousContent = previousPlan
      ? await privateTaskPlanResponse(previousPlan, workspace)
      : null;
    const previousOutputs = previousContent?.outputs;
    const outputs = input.outputs ?? previousOutputs;
    /*
     * The parts come through with the step that owns them.
     *
     * `substeps` reached the wire when sub-milestones did, and this mapping did not move with it -
     * so a plan the model had broken into parts lost every one of them the moment an owner opened
     * the editor and pressed Save. Nothing said so: the write succeeded, the version incremented,
     * and the detail was simply gone from the version that replaced it.
     *
     * Ids are minted here for the parts as well as the steps, because a part the owner has just
     * typed has none and the presentation folds timing onto a step by its id.
     */
    const steps: TaskPlanStep[] = input.steps.map((step) => ({
      id: step.id ?? randomUUID(),
      title: step.title,
      status: step.status ?? 'pending',
      ...(step.substeps
        ? {
            substeps: step.substeps.map((sub) => ({
              id: sub.id ?? randomUUID(),
              title: sub.title,
              status: sub.status ?? 'pending'
            }))
          }
        : {})
    }));
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    let created;
    try {
      created = await store.createTaskPlan({
        taskId: task.id,
        expectedVersion: input.expectedVersion,
        ...(input.parentVersion ? { parentVersion: input.parentVersion } : {}),
        branchName: input.branchName,
        stepsCiphertext: encryptJson(
          {
            steps,
            branchName: input.branchName,
            ...(outputs === undefined ? {} : { outputs }),
            ...(previousContent?.presentation
              ? { presentation: previousContent.presentation }
              : {}),
            ...(previousContent?.directionEventId
              ? { directionEventId: previousContent.directionEventId }
              : {})
          },
          key,
          `task-plan:${task.id}`
        ),
        createdBy: 'user'
      });
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'plan_version_conflict')
        throw new AthanorError(
          'plan_version_conflict',
          'The plan changed on another device; reload before saving',
          409
        );
      throw cause;
    }
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'plan',
      summary: 'Encrypted user plan event',
      payloadCiphertext: encryptJson(
        {
          __athanorEventVersion: 1,
          summary: `Plan updated to version ${created.version}`,
          payload: {
            planId: created.id,
            version: created.version,
            branchName: input.branchName,
            steps,
            ...(outputs === undefined ? {} : { outputs })
          }
        },
        key,
        `task-event:${task.id}`
      )
    });
    return privateTaskPlanResponse(created, workspace);
  });

  /**
   * Why this run is stopped on money, and whether it would still be stopped if it started now.
   *
   * A halt writes one sentence into the task's events and sets `spend_paused_at`, and that was the
   * whole account of it: no figures the owner could act on, and nothing that said whether the
   * ceiling in question was one they had chosen or one this box supplied because nobody had asked
   * them. The card that offers to raise it reads this.
   *
   * The verdict is recomputed rather than replayed from the halt, because it does not keep: a daily
   * window rolls over and stops blocking, an open commitment settles for less than it reserved, and
   * a card quoting last night's arithmetic would send the owner to raise a ceiling that is no longer
   * in the way. `estimateUsd: 0` asks "where does this stand right now" rather than pricing a step
   * nobody has decided to take.
   */
  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/spend-block', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    const decision = await store.spendGuard({
      userId: user.id,
      taskId: task.id,
      estimateUsd: 0,
      includeOpenCommitments: true
    });
    /*
     * The same test the caps route uses to decide a loosening needs a passkey: an epoch `updatedAt`
     * is a box whose owner has never answered the ceiling question, so the monthly ceiling stopping
     * them is this box's own default. Saying "your limit" of a number the owner never chose is the
     * one thing the card must not do.
     */
    const limits = await store.effectiveSpendLimits(user.id);
    const unchosen = decision.blockedBy === 'monthly' && !(Date.parse(limits.updatedAt) > 0);
    return {
      taskId: task.id,
      spendPausedAt: task.spendPausedAt ?? null,
      blocked: decision.outcome === 'deny',
      decision,
      summary: spendHalt(decision),
      unchosen
    };
  });

  /**
   * Raises this run's own money ceiling, for the card that offers to lift the thing that stopped it.
   *
   * No second factor, and the reason is arithmetic rather than trust: every window is checked on the
   * way to every step, so a run's own ceiling can only ever be the tightest of the three. Raising it
   * cannot buy a dollar the owner's account-wide ceilings would not already have allowed - those are
   * the limits that need a passkey to loosen, and they still do. What this moves is where a single
   * run stops inside them.
   */
  app.post<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/spend-ceiling',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(
        request,
        reply,
        user,
        async () => {
          const input = RaiseTaskSpendCeilingRequest.parse(request.body);
          const task = await store.getTask(user.id, request.params.taskId);
          if (!task) throw new AthanorError('task_not_found', 'Task not found');
          await store.raiseTaskSpendCeiling(user.id, task.id, input.maxSpendUsd);
          return privateTaskResponse((await store.getTask(user.id, task.id))!);
        },
        { databaseOnly: true }
      );
    }
  );

  app.post<{ Params: { taskId: string; action: string } }>(
    '/v1/tasks/:taskId/:action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(
        request,
        reply,
        user,
        async () => {
          const action = request.params.action;
          if (!['pause', 'resume', 'cancel'].includes(action))
            throw new AthanorError('invalid_action', 'Unsupported task action');
          const task = await store.getTask(user.id, request.params.taskId);
          if (!task) throw new AthanorError('task_not_found', 'Task not found');
          if (['completed', 'failed', 'cancelled'].includes(task.status))
            throw new AthanorError('invalid_task_state', 'A finished task cannot be changed', 409);
          if (
            action === 'resume' &&
            !(resumableTaskStatuses as readonly string[]).includes(task.status)
          )
            throw new AthanorError(
              'invalid_task_state',
              'Only paused or resource-waiting tasks can be resumed',
              409
            );
          const status = action === 'pause' ? 'paused' : 'queued';
          if (action === 'cancel') {
            await store.cancelTaskAndReleaseReservations(user.id, task.id);
            await stopCodingMissionFamily(context, task);
          } else {
            if (action === 'resume') {
              /*
               * Resume used to re-queue a run a ceiling had stopped, straight back into the same
               * ceiling: the worker asks the guard again before its first step, gets the same denial,
               * and pauses. From the outside that is a Resume button that does nothing - press it,
               * watch the status flick to queued and back to paused, with no more explanation the
               * second time than the first.
               *
               * The guard is therefore asked here, before anything is re-queued. It is asked and not
               * assumed because the answer moves on its own: a daily window rolls over at midnight, so
               * the run that could not resume last night resumes this morning with nothing changed.
               * Only a ceiling that would still stop it refuses, and it refuses saying which one and
               * with what figures, so the next thing the owner does can be the thing that works.
               */
              const verdict = await store.spendGuard({
                userId: user.id,
                taskId: task.id,
                estimateUsd: 0,
                includeOpenCommitments: true
              });
              if (verdict.outcome === 'deny')
                throw new AthanorError('spend_cap_reached', spendHalt(verdict));
              await ensureProjectExecution(context, task);
            }
            await store.setTaskStatusForUser(user.id, task.id, status);
          }
          log.info('task.action', { taskId: task.id, userId: user.id, kind: action, status });
          return privateTaskResponse((await store.getTask(user.id, task.id))!);
        },
        { databaseOnly: true }
      );
    }
  );

  app.patch<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/security-mode',
    async (request, reply) => {
      const user = requireUser(request.user);
      const input = UpdateSecurityModeRequest.parse(request.body);
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      if (task.userId !== user.id)
        throw new AthanorError(
          'task_owner_required',
          'Only the task owner can change its security mode',
          403
        );
      /*
       * No second factor for choosing how much this run asks.
       *
       * Loosening used to demand a passkey inside the last five minutes, so in practice moving a
       * conversation to Autonomous meant a fingerprint every single time - on the setting whose
       * entire purpose is to be interrupted less. The session is already bound to a passkey; asking
       * again buys almost nothing here, because an attacker holding it can send tasks anyway, and
       * it costs the owner the one control they reach for most.
       *
       * Step-up stays where it protects something that cannot be undone by changing a setting
       * back: the provider credential, and raising a spending ceiling.
       */
      return idempotent(request, reply, user, async () => {
        const updated = await store.updateTaskSecurityMode(user.id, task.id, input.securityMode);
        if (!updated) throw new AthanorError('task_not_found', 'Task not found');
        const workspace = await store.getWorkspace(user.id, task.workspaceId);
        if (workspace?.wrappedKey) {
          const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
          await store.appendTaskEvent({
            taskId: task.id,
            kind: 'status',
            summary: 'Security mode changed',
            payloadCiphertext: encryptJson(
              { securityMode: input.securityMode },
              key,
              `task-event:${task.id}`
            )
          });
        }
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'task_security_mode_changed',
          outcome: 'succeeded',
          metadata: { taskId: task.id, securityMode: input.securityMode }
        });
        return privateTaskResponse(updated, workspace ?? undefined);
      });
    }
  );
};
