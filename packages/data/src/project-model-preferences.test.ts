import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encryptJson, wrapDataKey } from '@garden/core';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore } from './store.js';
import {
  readProjectModelPreferences,
  readTaskModelPreferences,
  writeConversationModelPreferences,
  writeProjectModelPreferences,
  resolvePurposeChoice
} from './project-model-preferences.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database),
  masterKey = Buffer.alloc(32, 7),
  key = Buffer.alloc(32, 9);
beforeAll(() => migrateDatabase(database));
afterAll(() => database.close());
const fixture = async () => {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const id = randomUUID();
  const workspace = await store.createWorkspace({
    id,
    userId: user.id,
    name: 'Project',
    imageRevision: 'fixture',
    region: 'auto',
    storageLimitBytes: 1_000_000,
    wrappedKey: wrapDataKey(key, masterKey, id)
  });
  const input = {
    userId: user.id,
    workspaceId: workspace.id,
    titleCiphertext: encryptJson({ title: 'Test' }, key),
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'fixture',
    privacyRoute: 'provider_zdr' as const,
    maxComputeCredits: 1,
    promptCiphertext: encryptJson({ prompt: 'Test' }, key)
  };
  const root = await store.createTask(input),
    child = await store.createTask({ ...input, projectId: root.projectId! });
  await database.query('UPDATE tasks SET parent_task_id=$1 WHERE id=$2', [root.id, child.id]);
  return { user, root, child };
};
it('seals choices for the primary project, inherits through child work and preserves explicit automatic', async () => {
  const { root, child } = await fixture();
  expect(await readProjectModelPreferences(store, masterKey, child)).toEqual({
    projectTaskId: root.id,
    revision: 0,
    choices: {}
  });
  const choice = {
    automatic: false,
    preference: 'balanced' as const,
    modelId: 'owner-private-choice'
  };
  await writeProjectModelPreferences(store, masterKey, child, {
    expectedRevision: 0,
    choices: { image: choice }
  });
  expect(await readProjectModelPreferences(store, masterKey, root)).toMatchObject({
    revision: 1,
    choices: { image: choice }
  });
  const rows = await database.query(
    'SELECT choices_ciphertext FROM project_model_preferences WHERE project_task_id=$1',
    [root.id]
  );
  expect(rows.rows).toHaveLength(1);
  expect(JSON.stringify(rows.rows)).not.toContain(choice.modelId);
  expect(resolvePurposeChoice('image', {}, { image: choice })).toEqual({
    source: 'global',
    choice
  });
  const automatic = { automatic: true, preference: 'fast' as const, modelId: '' };
  expect(resolvePurposeChoice('image', { image: automatic }, { image: choice })).toEqual({
    source: 'project',
    choice: automatic
  });
});
it('refuses another owner and stale concurrent writes without overwriting current choices', async () => {
  const { root } = await fixture();
  const request = {
    expectedRevision: 0,
    choices: { audio: { automatic: true, preference: 'best' as const, modelId: '' } }
  };
  const outcomes = await Promise.allSettled([
    writeProjectModelPreferences(store, masterKey, root, request),
    writeProjectModelPreferences(store, masterKey, root, request)
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  await expect(
    readProjectModelPreferences(store, masterKey, { id: root.id, userId: randomUUID() })
  ).rejects.toMatchObject({ code: 'project_not_found' });
  expect((await readProjectModelPreferences(store, masterKey, root)).revision).toBe(1);
  await writeProjectModelPreferences(store, masterKey, root, { expectedRevision: 1, choices: {} });
  expect(await readProjectModelPreferences(store, masterKey, root)).toMatchObject({
    revision: 2,
    choices: {}
  });
});

it('isolates conversation choices, retains them in a branch, and resets to project inheritance with revision checks', async () => {
  const { root, child } = await fixture();
  const pin = (modelId: string) => ({ automatic: false, preference: 'balanced' as const, modelId });
  await writeProjectModelPreferences(store, masterKey, root, {
    expectedRevision: 0,
    choices: { main: pin('project'), image: pin('image') }
  });
  await writeConversationModelPreferences(store, masterKey, child, {
    expectedRevision: 0,
    choices: { main: pin('conversation') }
  });
  const current = (await store.getTask(child.userId, child.id))!;
  expect(await readTaskModelPreferences(store, masterKey, current)).toMatchObject({
    conversationRevision: 1,
    choices: { main: pin('conversation'), image: pin('image') }
  });
  expect((await readTaskModelPreferences(store, masterKey, root)).choices.main).toEqual(
    pin('project')
  );
  await expect(
    writeConversationModelPreferences(store, masterKey, child, { expectedRevision: 0, choices: {} })
  ).rejects.toMatchObject({ code: 'conversation_preferences_changed' });
  const branch = await store.createTaskBranch({
    userId: child.userId,
    workspaceId: child.workspaceId,
    parentTaskId: child.id,
    titleCiphertext: child.titleCiphertext!,
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: child.modelId,
    privacyRoute: child.privacyRoute,
    promptCiphertext: child.promptCiphertext,
    agentStateCiphertext: null
  });
  expect(branch.projectId).toBe(root.projectId);
  expect((await readTaskModelPreferences(store, masterKey, branch)).choices.main).toEqual(
    pin('conversation')
  );
  await database.query('UPDATE tasks SET model_override=TRUE WHERE id=$1', [child.id]);
  await writeConversationModelPreferences(store, masterKey, child, {
    expectedRevision: 1,
    choices: {}
  });
  const reset = (await store.getTask(child.userId, child.id))!;
  expect(reset.modelOverride).toBe(false);
  expect(await readTaskModelPreferences(store, masterKey, reset)).toMatchObject({
    conversationRevision: 2,
    conversationChoices: {},
    choices: { main: pin('project') }
  });
  await expect(
    writeConversationModelPreferences(
      store,
      masterKey,
      { ...child, userId: randomUUID() },
      { expectedRevision: 2, choices: {} }
    )
  ).rejects.toMatchObject({ code: 'project_not_found' });
});
