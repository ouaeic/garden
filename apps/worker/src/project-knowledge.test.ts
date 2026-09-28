import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, DataStore, type Database } from '@garden/data';
import { encryptJson, buildMemoryItemIndex, memoryIndexKey, planMemoryQuery } from '@garden/core';
import { memoryItemAad, memoryPackEntries, recallMemory } from './memory-runtime.js';
const databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});
describe('project shared knowledge reads', () => {
  it('recalls the parent library with its original seal while sibling writes stay private and budgets stay bounded', async () => {
    const db = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    databases.push(db);
    await migrateDatabase(db);
    const store = new DataStore(db),
      key = Buffer.alloc(32, 6);
    const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
    const create = () =>
      store.createWorkspace({
        userId: user.id,
        name: 'Workspace',
        storageLimitBytes: 1024 ** 3,
        imageRevision: 'fixture',
        region: 'auto',
        wrappedKey: 'fixture'
      });
    const parent = await create(),
      child = await create(),
      sibling = await create();
    await db.query('UPDATE workspaces SET parent_workspace_id=$1 WHERE id=ANY($2::uuid[])', [
      parent.id,
      [child.id, sibling.id]
    ]);
    const note = async (workspaceId: string, body: string) =>
      store.createMemoryItem({
        userId: user.id,
        workspaceId,
        kind: 'episode',
        trust: 'stated',
        documentCiphertext: encryptJson({ body }, key, memoryItemAad(workspaceId)),
        index: buildMemoryItemIndex({ body }, memoryIndexKey(key)),
        observedAt: new Date()
      } as Parameters<DataStore['createMemoryItem']>[0]);
    const shared = await note(parent.id, 'The analysis uses amber reference genome.');
    const privateNote = await note(sibling.id, 'The analysis uses secret violet reference genome.');
    await store.rebuildMemoryCorpusStats(parent.id);
    await store.rebuildMemoryCorpusStats(sibling.id);
    const candidates = await store.recallMemoryCandidates({
      workspaceId: child.id,
      plan: planMemoryQuery('reference genome', memoryIndexKey(key)),
      budgetTokens: 512,
      now: new Date()
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((candidate) => candidate.id === shared.id)).toBe(true);
    expect(candidates.some((candidate) => candidate.id === privateNote.id)).toBe(false);
    const entries = memoryPackEntries(candidates, child.id, key);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.body.includes('amber'))).toBe(true);
    expect(candidates.reduce((sum, candidate) => sum + candidate.tokensEst, 0)).toBeLessThanOrEqual(
      512
    );
    const task = await store.createTask({
      userId: user.id,
      workspaceId: child.id,
      titleCiphertext: encryptJson({ title: 'Analysis' }, key, `task-title:${child.id}`),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'chosen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson({ prompt: 'Reference genome' }, key, `task-prompt:${child.id}`)
    });
    const recalled = await recallMemory({
      store,
      workspaceId: child.id,
      dataKey: key,
      taskId: task.id,
      query: 'reference genome'
    });
    expect(recalled.entries.some((entry) => entry.id === shared.id)).toBe(true);
    expect(await store.retractMemoryItem(child.id, shared.id)).toBe(false);
    expect((await store.getMemoryItem(parent.id, shared.id))?.status).toBe('active');
    const memory = await store.createWorkspaceMemory({
      userId: user.id,
      workspaceId: parent.id,
      target: 'workspace',
      contentCiphertext: encryptJson(
        { content: 'Shared library' },
        key,
        `workspace-memory:${parent.id}`
      )
    });
    const skill = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: parent.id,
      nameHash: 'shared',
      documentCiphertext: encryptJson(
        { name: 'Shared skill', description: 'Read the shared source', content: 'Use sources' },
        key,
        `workspace-skill:${parent.id}`
      )
    });
    expect(
      (await store.listWorkspaceMemories(user.id, child.id)).some(
        (row) => row.id === memory.id && row.workspaceId === parent.id
      )
    ).toBe(true);
    expect(
      (await store.listWorkspaceSkills(user.id, child.id)).some(
        (row) => row.id === skill.id && row.workspaceId === parent.id
      )
    ).toBe(true);
    expect(await store.deleteWorkspaceMemory(user.id, child.id, memory.id)).toBe(false);
    expect(await store.deleteWorkspaceSkill(user.id, child.id, skill.id)).toBe(false);
  });
});
