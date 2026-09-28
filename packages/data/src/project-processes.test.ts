import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptJson, wrapDataKey } from '@garden/core';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore } from './store.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database),
  key = Buffer.alloc(32, 9),
  master = Buffer.alloc(32, 7);
beforeAll(() => migrateDatabase(database));
afterAll(() => database.close());
async function fixture() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspace = async () => {
    const id = randomUUID();
    return store.createWorkspace({
      id,
      userId: user.id,
      name: 'Project',
      imageRevision: 'fixture',
      region: 'auto',
      storageLimitBytes: 1_000_000,
      wrappedKey: wrapDataKey(key, master, id)
    });
  };
  const first = await workspace(),
    second = await workspace();
  const task = (workspaceId: string, projectId?: string) =>
    store.createTask({
      userId: user.id,
      workspaceId,
      ...(projectId ? { projectId } : {}),
      titleCiphertext: encryptJson({ title: 'Analysis' }, key),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'fixture',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson({ prompt: 'Analysis' }, key)
    });
  const root = await task(first.id),
    sibling = await task(first.id),
    branch = await task(second.id, root.projectId);
  await database.query('UPDATE tasks SET parent_task_id=$1 WHERE id=$2', [root.id, branch.id]);
  return { user, first, second, root, sibling, branch };
}
describe('owned project execution membership', () => {
  it('resolves a branch to its project while excluding another project on the same workspace', async () => {
    const { user, first, second, root, branch } = await fixture();
    const result = await store.projectExecutionMembers(user.id, branch.id);
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { taskId: root.id, workspaceId: first.id },
        { taskId: branch.id, workspaceId: second.id }
      ])
    );
    expect(await store.projectExecutionMembers(randomUUID(), root.id)).toEqual([]);
    expect(await store.projectExecutionMembers(user.id, randomUUID())).toEqual([]);
  });
  it('uses explicit membership even when ancestry is cyclic', async () => {
    const { user, root, branch } = await fixture();
    await database.query('UPDATE tasks SET parent_task_id=$1 WHERE id=$2', [branch.id, root.id]);
    expect(await store.projectExecutionMembers(user.id, branch.id)).toHaveLength(2);
  });
});
