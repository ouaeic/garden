import { OwnerPreferences, type ModelRelease } from '@athanor/contracts';
import { AthanorError, encryptJson, selectPurposeModel } from '@athanor/core';
import {
  readTaskModelPreferences,
  resolvePurposeChoice,
  type DataStore,
  type TaskRecord
} from '@athanor/data';
import type { AgentState } from './agent-state.js';

type PurposeContext = {
  store: DataStore;
  masterKey: Buffer;
  connectedModels(task: TaskRecord, catalog: readonly ModelRelease[]): Promise<ModelRelease[]>;
};

async function preferences(
  context: PurposeContext,
  task: TaskRecord,
  existing?: Awaited<ReturnType<typeof readTaskModelPreferences>>
) {
  const [project, user, limits] = await Promise.all([
    existing ?? readTaskModelPreferences(context.store, context.masterKey, task),
    context.store.getUserById(task.userId),
    context.store.effectiveSpendLimits(task.userId)
  ]);
  if (!user) throw new AthanorError('owner_not_found', 'Project owner is unavailable');
  const owner = OwnerPreferences.parse(user.preferences);
  return {
    project,
    decisionsEnabled: owner.decisionModelsEnabled !== false,
    global: { ...owner.modelPurposes, ...(owner.model ? { main: owner.model } : {}) },
    limits: {
      maxInputUsdPerMillionTokens: limits.maxInputUsdPerMillionTokens ?? null,
      maxOutputUsdPerMillionTokens: limits.maxOutputUsdPerMillionTokens ?? null
    }
  };
}

export async function mainPurposeChoice(context: PurposeContext, task: TaskRecord) {
  const { project, global, limits } = await preferences(context, task);
  return { ...resolvePurposeChoice('main', project.choices, global), limits };
}

export async function resolveTaskPurposeModel(
  context: PurposeContext,
  task: TaskRecord,
  purpose: 'specialist' | 'coding' | 'summarise' | 'title' | 'decisions',
  catalog: readonly ModelRelease[]
): Promise<ModelRelease> {
  const { project, global, limits, decisionsEnabled } = await preferences(context, task);
  if (purpose === 'decisions' && !decisionsEnabled)
    throw new AthanorError(
      'decision_models_disabled',
      'Decision models are turned off in Settings.',
      409
    );
  const { choice } = resolvePurposeChoice(purpose, project.choices, global);
  const connected = await context.connectedModels(task, catalog);
  const main = catalog.find((model) => model.id === task.modelId);
  const eligible =
    purpose === 'decisions'
      ? connected.filter(
          (model) =>
            main &&
            model.provider === 'openrouter' &&
            (model.connectionId ?? model.provider) === (main.connectionId ?? main.provider)
        )
      : connected;
  const result = selectPurposeModel({
    purpose,
    choice,
    catalog: eligible,
    privacyRoute: task.privacyRoute === 'provider_zdr' ? 'provider_zdr' : 'external',
    ceiling: limits
  });
  if (!result.model) throw new AthanorError('purpose_model_unavailable', result.reason!, 409);
  return result.model;
}

/** A null choice means automatic; unreadable preferences and unavailable pins fail closed. */
export async function pinnedPurposeModel(
  context: PurposeContext,
  task: TaskRecord,
  purpose: 'summarise' | 'title',
  catalog: readonly ModelRelease[]
): Promise<ModelRelease | null> {
  const { project, global } = await preferences(context, task);
  const { choice } = resolvePurposeChoice(purpose, project.choices, global);
  if (choice.automatic) return null;
  return resolveTaskPurposeModel(context, task, purpose, catalog);
}

export async function applyProjectMainModel(
  context: PurposeContext,
  task: TaskRecord,
  state: AgentState,
  catalog: readonly ModelRelease[],
  key: Uint8Array,
  workerId: string
): Promise<void> {
  if (task.parentMissionId || task.modelOverride) return;
  const project = await readTaskModelPreferences(context.store, context.masterKey, task);
  const main = project.choices.main;
  if (!main && state.mainModelPreference === undefined && !project.conversationRevision) return;
  const fingerprint = JSON.stringify([
    project.conversationRevision,
    main ? [main.automatic, main.preference, main.modelId] : null
  ]);
  if (state.mainModelPreference === fingerprint) return;
  const { global, limits } = await preferences(context, task, project);
  const { choice } = resolvePurposeChoice('main', project.choices, global);
  const connected = await context.connectedModels(task, catalog);
  const result = selectPurposeModel({
    purpose: 'main',
    choice,
    catalog: connected,
    privacyRoute: task.privacyRoute === 'provider_zdr' ? 'provider_zdr' : 'external',
    ceiling: limits
  });
  if (!result.model) throw new AthanorError('purpose_model_unavailable', result.reason!, 409);
  const effort = result.model.id === task.modelId ? (task.reasoningEffort ?? 'auto') : 'auto';
  const nextState = { ...state, mainModelPreference: fingerprint, ownerReasoningEffort: effort };
  await context.store.applyProjectMainModel({
    userId: task.userId,
    taskId: task.id,
    workerId,
    previousModelId: task.modelId,
    modelId: result.model.id,
    reasoningEffort: effort,
    stateCiphertext: encryptJson(nextState, key, `task-state:${task.id}`)
  });
  task.modelId = result.model.id;
  task.reasoningEffort = effort;
  Object.assign(state, nextState);
}

/**
 * What jobs on this computer are answered by a model other than the one reading this.
 *
 * The owner has been able to route each job to its own model for a while, and the lead was never
 * told: it chose between doing a piece of research itself and handing it to `delegate` without
 * knowing whether the specialist behind that call was a stronger reasoner or a cheaper one. The
 * decision is different in the two cases, and it is not a decision the model can work out by
 * trying - nothing in any tool result names the route that answered it.
 *
 * Only the routes that actually differ from the lead. On a box where one model does everything -
 * which is every box until somebody opens the settings - this returns nothing and costs nothing,
 * which is the point: the line exists to describe a choice the owner made, not to describe the
 * default back to itself.
 *
 * Failure is silence. A roster that cannot be resolved is a sentence the model does not get; it is
 * never a reason to fail a turn, because the turn's actual work does not depend on it.
 */
export async function taskModelRoster(
  context: PurposeContext,
  task: TaskRecord,
  catalog: readonly ModelRelease[],
  leadModelId: string
): Promise<Array<{ purpose: string; job: string; model: string }>> {
  const jobs = [
    { purpose: 'specialist', job: 'research and review specialists (delegate)' },
    { purpose: 'coding', job: 'repository changes (coding_agent)' }
  ] as const;
  const roster: Array<{ purpose: string; job: string; model: string }> = [];
  for (const entry of jobs) {
    try {
      const model = await resolveTaskPurposeModel(context, task, entry.purpose, catalog);
      if (model.id !== leadModelId)
        roster.push({ purpose: entry.purpose, job: entry.job, model: model.displayName });
    } catch {
      // A job whose route will not resolve is a job the model should not be told it has.
    }
  }
  return roster;
}
