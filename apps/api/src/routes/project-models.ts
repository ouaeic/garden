import {
  ModelPurpose,
  OwnerPreferences,
  UpdateProjectModelPreferences,
  type ProjectModelPreferences,
  type ProjectModelChoices
} from '@athanor/contracts';
import { AthanorError, selectPurposeModel } from '@athanor/core';
import {
  readProjectModelPreferences,
  readTaskModelPreferences,
  writeConversationModelPreferences,
  writeProjectModelPreferences,
  resolvePurposeChoice,
  mergeProjectModelChoices,
  type UserRecord
} from '@athanor/data';
import { ownerPriceCeiling } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

/**
 * The purpose surface the two model choosers read: what each purpose offers, what it resolves to
 * right now, and why it might not. Served against a task (whose project choices override the
 * global ones) and against a bare workspace (global only - the state a first prompt starts from).
 */
const purposeSurface = async (
  context: RouteContext,
  user: UserRecord,
  projectChoices: ProjectModelChoices,
  global: ProjectModelChoices,
  privacyRoute: 'provider_zdr' | 'external',
  taskModelId?: string
): Promise<ProjectModelPreferences['purposes']> => {
  const decisionsEnabled = OwnerPreferences.parse(user.preferences).decisionModelsEnabled !== false;
  const selection = mergeProjectModelChoices(global, projectChoices);
  const [media, models, limits] = await Promise.all([
    context.mediaSettings(user.id, selection),
    context.modelsForUser(user),
    context.store.effectiveSpendLimits(user.id)
  ]);
  const main =
    models.find((model) => model.id === taskModelId) ??
    selectPurposeModel({
      purpose: 'main',
      choice: resolvePurposeChoice('main', projectChoices, global).choice,
      catalog: models,
      privacyRoute,
      ceiling: ownerPriceCeiling(limits)
    }).model;
  const compatibleDecision = (model: (typeof models)[number]) =>
    Boolean(
      main &&
      model.provider === 'openrouter' &&
      (model.connectionId ?? model.provider) === (main.connectionId ?? main.provider)
    );
  return ModelPurpose.options.map((purpose) => {
    const resolved = resolvePurposeChoice(purpose, projectChoices, global);
    if (purpose === 'decisions' && !decisionsEnabled)
      return {
        purpose,
        ...resolved,
        disabled: true,
        effective: null,
        options: [],
        available: false,
        reason: 'Decision models are turned off in Settings → Models.'
      };
    const modality = media.modalities.find((item) => item.modality === purpose);
    if (modality)
      return {
        purpose,
        ...resolved,
        effective: modality.effective,
        options: modality.options,
        available: Boolean(modality.effective && !modality.effective.unavailableReason),
        reason:
          modality.effective?.unavailableReason ??
          (modality.effective ? null : (modality.reason ?? 'The selected model is unavailable.'))
      };
    // The text purposes the selector knows how to answer for. Anything else at this point is a
    // media modality the connected provider did not offer, which the branch below says plainly.
    if (
      purpose !== 'main' &&
      purpose !== 'specialist' &&
      purpose !== 'coding' &&
      purpose !== 'decisions' &&
      purpose !== 'summarise' &&
      purpose !== 'title'
    )
      return {
        purpose,
        ...resolved,
        effective: null,
        options: [],
        available: false,
        reason: 'The connected provider does not offer this purpose.'
      };
    const result = selectPurposeModel({
      purpose,
      choice: resolved.choice,
      catalog: purpose === 'decisions' ? models.filter(compatibleDecision) : models,
      privacyRoute,
      ceiling: ownerPriceCeiling(limits)
    });
    return {
      purpose,
      ...resolved,
      effective: result.model,
      options: models
        .filter((model) =>
          purpose === 'decisions'
            ? model.capabilities.includes('decisions')
            : model.capabilities.includes('chat')
        )
        .map((model) => ({
          ...model,
          unavailableReason:
            purpose === 'decisions' && !compatibleDecision(model)
              ? 'Decisions use the same OpenRouter connection as the main model.'
              : selectPurposeModel({
                  purpose,
                  choice: {
                    automatic: false,
                    preference: resolved.choice.preference,
                    modelId: model.id
                  },
                  catalog: [model],
                  privacyRoute,
                  ceiling: ownerPriceCeiling(limits)
                }).reason
        })),
      available: Boolean(result.model),
      reason: result.reason
    };
  });
};

export const projectModelSettings = async (
  context: RouteContext,
  user: UserRecord,
  taskId: string,
  scope: 'project' | 'conversation' = 'project'
): Promise<ProjectModelPreferences> => {
  const task = await context.store.getTask(user.id, taskId);
  if (!task && !(await context.store.getProject(user.id, taskId)))
    throw new AthanorError('project_not_found', 'Project not found', 404);
  if (scope === 'conversation' && !task)
    throw new AthanorError('task_not_found', 'Conversation not found', 404);
  const local =
    scope === 'conversation' && task
      ? await readTaskModelPreferences(context.store, context.masterKey, task)
      : null;
  const preferences = local
    ? {
        projectTaskId: taskId,
        revision: local.conversationRevision,
        choices: {
          ...local.conversationChoices,
          ...(task?.modelOverride
            ? { main: { automatic: false, preference: 'balanced' as const, modelId: task.modelId } }
            : {})
        }
      }
    : await readProjectModelPreferences(context.store, context.masterKey, {
        userId: user.id,
        id: taskId
      });
  const owner = OwnerPreferences.parse(user.preferences);
  const { secret } = await context.inferenceCredential(user.id);
  const global: ProjectModelChoices = {
    ...secret.mediaModels,
    ...(owner.model ? { main: owner.model } : {}),
    ...('modelPurposes' in owner ? (owner.modelPurposes as ProjectModelChoices) : {})
  };
  const purposes = await purposeSurface(
    context,
    user,
    preferences.choices,
    local ? mergeProjectModelChoices(global, local.projectChoices) : global,
    (task?.privacyRoute ?? (secret.enforceZeroDataRetention ? 'provider_zdr' : 'external')) ===
      'provider_zdr'
      ? 'provider_zdr'
      : 'external',
    task?.modelId
  );
  return {
    ...preferences,
    decisionModelsEnabled: owner.decisionModelsEnabled !== false,
    purposes
  };
};

/** The same surface, global-only, for the composer of a prompt that does not exist yet. */
const workspaceModelSettings = async (
  context: RouteContext,
  user: UserRecord,
  privacyRoute: 'provider_zdr' | 'external'
): Promise<ProjectModelPreferences> => {
  const owner = OwnerPreferences.parse(user.preferences);
  const { secret } = await context.inferenceCredential(user.id);
  const global: ProjectModelChoices = {
    ...secret.mediaModels,
    ...(owner.model ? { main: owner.model } : {}),
    ...('modelPurposes' in owner ? (owner.modelPurposes as ProjectModelChoices) : {})
  };
  const purposes = await purposeSurface(context, user, {}, global, privacyRoute);
  return {
    projectTaskId: '',
    decisionModelsEnabled: owner.decisionModelsEnabled !== false,
    revision: 0,
    choices: global,
    purposes
  };
};

export const registerProjectModelRoutes = (context: RouteContext): void => {
  context.app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/model-preferences',
    (request) => projectModelSettings(context, requireUser(request.user), request.params.projectId)
  );
  context.app.put<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/model-preferences',
    async (request, reply) => {
      const user = requireUser(request.user);
      return context.idempotent(request, reply, user, async () => {
        const input = UpdateProjectModelPreferences.parse(request.body);
        if (!(await context.store.getProject(user.id, request.params.projectId)))
          throw new AthanorError('project_not_found', 'Project not found', 404);
        await writeProjectModelPreferences(
          context.store,
          context.masterKey,
          { id: request.params.projectId, userId: user.id },
          input
        );
        return projectModelSettings(context, user, request.params.projectId);
      });
    }
  );
  context.app.get<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/model-preferences',
    (request) =>
      projectModelSettings(
        context,
        requireUser(request.user),
        request.params.taskId,
        'conversation'
      )
  );
  context.app.get<{ Querystring: { privacyRoute?: string } }>(
    '/v1/workspace-model-preferences',
    async (request) => {
      const user = requireUser(request.user);
      const { secret } = await context.inferenceCredential(user.id);
      return workspaceModelSettings(
        context,
        user,
        request.query.privacyRoute === 'external' ||
          (!request.query.privacyRoute && !secret.enforceZeroDataRetention)
          ? 'external'
          : 'provider_zdr'
      );
    }
  );
  context.app.put<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/model-preferences',
    async (request, reply) => {
      const user = requireUser(request.user);
      return context.idempotent(request, reply, user, async () => {
        const input = UpdateProjectModelPreferences.parse(request.body);
        const task = await context.store.getTask(user.id, request.params.taskId);
        if (!task) throw new AthanorError('task_not_found', 'Task not found', 404);
        await writeConversationModelPreferences(context.store, context.masterKey, task, input);
        return projectModelSettings(context, user, task.id, 'conversation');
      });
    }
  );
};
