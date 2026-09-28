import { ProjectModelChoices, type ModelPurpose, type PurposeModelChoice } from '@garden/contracts';
import {
  GardenError,
  decryptJson,
  encryptJson,
  unwrapDataKey,
  type EncryptedEnvelope
} from '@garden/core';
import type { Database } from './database.js';
import { json } from './store/rows.js';

export interface ProjectModelPreferenceRecord {
  projectTaskId: string;
  workspaceId: string;
  wrappedKey: string;
  revision: number;
  choicesCiphertext: EncryptedEnvelope | null;
}
const lineage = `SELECT p.id,p.workspace_id FROM projects p WHERE p.user_id=$2
 AND (p.id=$1 OR p.id=(SELECT project_id FROM tasks WHERE id=$1 AND user_id=$2))`;

export class ProjectModelPreferenceStore {
  constructor(private readonly database: Database) {}
  async putConversationModelPreferences(input: {
    userId: string;
    taskId: string;
    expectedRevision: number;
    choicesCiphertext: EncryptedEnvelope;
  }): Promise<void> {
    const result = await this.database.query(
      `UPDATE tasks SET model_choices_ciphertext=$3::jsonb,model_preferences_revision=model_preferences_revision+1,
        model_override=FALSE,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND model_preferences_revision=$4
        AND parent_mission_id IS NULL RETURNING id`,
      [input.taskId, input.userId, JSON.stringify(input.choicesCiphertext), input.expectedRevision]
    );
    if (!result.rows.length)
      throw new GardenError(
        'conversation_preferences_changed',
        'Conversation choices changed; reload and try again',
        409
      );
  }
  async applyProjectMainModel(input: {
    userId: string;
    taskId: string;
    workerId: string;
    previousModelId: string;
    modelId: string;
    reasoningEffort: string;
    stateCiphertext: EncryptedEnvelope;
  }): Promise<void> {
    const result = await this.database.query(
      `UPDATE tasks SET model_id=$5,reasoning_effort=$6,
      agent_state_ciphertext=$7::jsonb,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND lease_owner=$3
      AND lease_expires_at>NOW() AND model_id=$4 AND status IN ('planning','running') RETURNING id`,
      [
        input.taskId,
        input.userId,
        input.workerId,
        input.previousModelId,
        input.modelId,
        input.reasoningEffort,
        JSON.stringify(input.stateCiphertext)
      ]
    );
    if (!result.rows.length)
      throw new GardenError(
        'task_changed',
        'The project changed before its model setting could be applied',
        409
      );
  }
  async getProjectModelPreferences(
    userId: string,
    taskId: string
  ): Promise<ProjectModelPreferenceRecord> {
    const result = await this.database.query(
      `WITH root AS (${lineage})
      SELECT root.id,root.workspace_id,k.wrapped_key,p.revision,p.choices_ciphertext
      FROM root JOIN workspaces w ON w.id=root.workspace_id AND w.user_id=$2 JOIN workspace_keys k ON k.workspace_id=w.id
      LEFT JOIN project_model_preferences p ON p.project_task_id=root.id AND p.user_id=$2`,
      [taskId, userId]
    );
    const row = result.rows[0];
    if (typeof row?.wrapped_key !== 'string')
      throw new GardenError('project_not_found', 'Project not found', 404);
    return {
      projectTaskId: String(row.id),
      workspaceId: String(row.workspace_id),
      wrappedKey: row.wrapped_key,
      revision: Number(row.revision ?? 0),
      choicesCiphertext: row.choices_ciphertext ? json(row.choices_ciphertext) : null
    };
  }
  async putProjectModelPreferences(input: {
    userId: string;
    taskId: string;
    projectTaskId: string;
    expectedRevision: number;
    choicesCiphertext: EncryptedEnvelope;
  }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const root = await tx.query(lineage, [input.taskId, input.userId]);
      if (root.rows[0]?.id !== input.projectTaskId)
        throw new GardenError('project_changed', 'Project changed; reload its model choices', 409);
      await tx.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        input.projectTaskId,
        input.userId
      ]);
      const result =
        input.expectedRevision === 0
          ? await tx.query(
              `INSERT INTO project_model_preferences(project_task_id,user_id,revision,choices_ciphertext) VALUES($1,$2,1,$3::jsonb) ON CONFLICT(project_task_id) DO NOTHING RETURNING revision`,
              [input.projectTaskId, input.userId, JSON.stringify(input.choicesCiphertext)]
            )
          : await tx.query(
              'UPDATE project_model_preferences SET revision=revision+1,choices_ciphertext=$3::jsonb,updated_at=NOW() WHERE project_task_id=$1 AND user_id=$2 AND revision=$4 RETURNING revision',
              [
                input.projectTaskId,
                input.userId,
                JSON.stringify(input.choicesCiphertext),
                input.expectedRevision
              ]
            );
      if (!result.rows.length)
        throw new GardenError(
          'project_preferences_changed',
          'Model choices changed on another device; reload and try again',
          409
        );
    });
  }
}

type PreferenceStore = Pick<
  ProjectModelPreferenceStore,
  'getProjectModelPreferences' | 'putProjectModelPreferences'
>;
export const projectModelPreferencesAad = (projectTaskId: string) =>
  `project-model-preferences:${projectTaskId}`;
export const readProjectModelPreferences = async (
  store: Pick<PreferenceStore, 'getProjectModelPreferences'>,
  masterKey: Uint8Array,
  task: { userId: string; id: string }
) => {
  const record = await store.getProjectModelPreferences(task.userId, task.id);
  const key = unwrapDataKey(record.wrappedKey, masterKey, record.workspaceId);
  const choices = record.choicesCiphertext
    ? ProjectModelChoices.parse(
        decryptJson(record.choicesCiphertext, key, projectModelPreferencesAad(record.projectTaskId))
      )
    : {};
  return { projectTaskId: record.projectTaskId, revision: record.revision, choices };
};
export const writeProjectModelPreferences = async (
  store: PreferenceStore,
  masterKey: Uint8Array,
  task: { userId: string; id: string },
  input: { expectedRevision: number; choices: ProjectModelChoices }
) => {
  const record = await store.getProjectModelPreferences(task.userId, task.id);
  const key = unwrapDataKey(record.wrappedKey, masterKey, record.workspaceId);
  const choices = ProjectModelChoices.parse(input.choices);
  await store.putProjectModelPreferences({
    userId: task.userId,
    taskId: task.id,
    projectTaskId: record.projectTaskId,
    expectedRevision: input.expectedRevision,
    choicesCiphertext: encryptJson(choices, key, projectModelPreferencesAad(record.projectTaskId))
  });
};
export const resolvePurposeChoice = (
  purpose: ModelPurpose,
  project: ProjectModelChoices,
  global: ProjectModelChoices
): { source: 'project' | 'global' | 'automatic'; choice: PurposeModelChoice } =>
  project[purpose]
    ? { source: 'project', choice: project[purpose] }
    : global[purpose]
      ? { source: 'global', choice: global[purpose] }
      : { source: 'automatic', choice: { automatic: true, preference: 'balanced', modelId: '' } };
export const mergeProjectModelChoices = (
  global: ProjectModelChoices,
  project: ProjectModelChoices
): ProjectModelChoices => ({ ...global, ...project });

/** Conversation choices override project defaults without mutating sibling conversations. */
export const readTaskModelPreferences = async (
  store: Pick<PreferenceStore, 'getProjectModelPreferences'>,
  masterKey: Uint8Array,
  task: {
    userId: string;
    id: string;
    projectId?: string;
    modelChoicesCiphertext?: EncryptedEnvelope | null;
    modelPreferencesRevision?: number;
  }
) => {
  const record = await store.getProjectModelPreferences(task.userId, task.id);
  const key = unwrapDataKey(record.wrappedKey, masterKey, record.workspaceId);
  const project = record.choicesCiphertext
    ? ProjectModelChoices.parse(
        decryptJson(record.choicesCiphertext, key, projectModelPreferencesAad(record.projectTaskId))
      )
    : {};
  const conversation = task.modelChoicesCiphertext
    ? ProjectModelChoices.parse(
        decryptJson(task.modelChoicesCiphertext, key, `conversation-models:${record.projectTaskId}`)
      )
    : {};
  return {
    projectTaskId: record.projectTaskId,
    revision: record.revision,
    conversationRevision: task.modelPreferencesRevision ?? 0,
    projectChoices: project,
    conversationChoices: conversation,
    choices: { ...project, ...conversation }
  };
};

export const writeConversationModelPreferences = async (
  store: Pick<
    ProjectModelPreferenceStore,
    'getProjectModelPreferences' | 'putConversationModelPreferences'
  >,
  masterKey: Uint8Array,
  task: { userId: string; id: string },
  input: { expectedRevision: number; choices: ProjectModelChoices }
) => {
  const record = await store.getProjectModelPreferences(task.userId, task.id);
  const key = unwrapDataKey(record.wrappedKey, masterKey, record.workspaceId);
  await store.putConversationModelPreferences({
    userId: task.userId,
    taskId: task.id,
    expectedRevision: input.expectedRevision,
    choicesCiphertext: encryptJson(
      ProjectModelChoices.parse(input.choices),
      key,
      `conversation-models:${record.projectTaskId}`
    )
  });
};
