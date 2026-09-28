import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  buildConversationNameIndex,
  buildMemorySourceIndex,
  decryptJson,
  encryptJson,
  memoryIndexKey,
  wrapDataKey
} from '@garden/core';
import { createDatabase, DataStore, migrateDatabase, type TaskRecord } from '@garden/data';
import type { RouteContext } from '../http/server-context.js';
import { registerSearchRoutes } from './search.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const app = Fastify();
const masterKey = Buffer.alloc(32, 5);
const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 9);
let ownerId = '',
  outsiderId = '',
  parentId = '',
  foreignId = '';
const projects: Array<{ id: string; workspaceId: string }> = [];
let otherTaskId = '';

beforeAll(async () => {
  await migrateDatabase(database);
  const owner = await store.createUser({ username: 'search-owner', displayName: 'Owner' });
  const outsider = await store.createUser({ username: 'search-outsider', displayName: 'Other' });
  ownerId = owner.id;
  outsiderId = outsider.id;
  const workspace = async (userId: string, dataKey: Uint8Array) => {
    const id = randomUUID();
    await store.createWorkspace({
      id,
      userId,
      name: 'Computer',
      storageLimitBytes: 100_000_000,
      imageRevision: 'test',
      region: 'local',
      securityMode: 'balanced',
      wrappedKey: wrapDataKey(dataKey, masterKey, id)
    });
    await store.updateWorkspaceStatus(id, 'running');
    return id;
  };
  parentId = await workspace(ownerId, key);
  foreignId = await workspace(outsiderId, key);
  const task = (userId: string, workspaceId: string, dataKey: Uint8Array, title: string) =>
    store.createTask({
      userId,
      workspaceId,
      titleCiphertext: encryptJson({ title }, dataKey, `task-title:${workspaceId}`),
      promptCiphertext: encryptJson({ prompt: title }, dataKey, `task-prompt:${workspaceId}`),
      nameIndex: buildConversationNameIndex(title, title, memoryIndexKey(dataKey)),
      modelId: 'test/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      securityMode: 'balanced'
    });
  const capture = async (t: TaskRecord, dataKey: Uint8Array, body: string) => {
    const index = buildMemorySourceIndex(body, memoryIndexKey(dataKey));
    await store.createMemorySource({
      userId: t.userId,
      workspaceId: t.workspaceId,
      taskId: t.id,
      channel: 'chat',
      bodyCiphertext: encryptJson({ body }, dataKey, `memory-source:${t.workspaceId}`),
      ...index
    });
  };
  // Real migration leaves the original source in its public sealing scope.
  for (const title of ['Orchid report', 'Orchid comparison']) {
    const t = await task(ownerId, parentId, key, title);
    await capture(t, key, `The heliotrope observation belongs to ${title}.`);
    const id = randomUUID();
    expect(
      await store.beginProjectExecution({
        userId: ownerId,
        taskId: t.id,
        workspaceId: id,
        wrappedKey: wrapDataKey(key, masterKey, id),
        seedKind: 'legacy',
        sourceManifestCiphertext: encryptJson({ paths: [] }, key)
      })
    ).toMatchObject({ status: 'preparing' });
    expect(
      await store.finishProjectExecution({
        userId: ownerId,
        taskId: t.id,
        workspaceId: id,
        receiptCiphertext: encryptJson({ copied: [] }, key),
        rewrite: () => ({
          titleCiphertext: encryptJson({ title }, key, `task-title:${id}`),
          promptCiphertext: encryptJson({ prompt: title }, key, `task-prompt:${id}`)
        })
      })
    ).toBe(true);
    projects.push({ id: t.id, workspaceId: id });
    await capture(
      (await store.getTask(ownerId, t.id))!,
      key,
      `Heliotrope now also grows in ${title}.`
    );
  }
  const foreign = await task(outsiderId, foreignId, key, 'Orchid forbidden');
  await capture(foreign, key, 'Heliotrope forbidden history.');
  const otherId = await workspace(ownerId, otherKey);
  const other = await task(ownerId, otherId, otherKey, 'Orchid independent');
  otherTaskId = other.id;
  await capture(other, otherKey, 'Heliotrope uses an independently sealed workspace.');
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = request.headers['x-other-owner'] ? outsider : owner;
  });
  registerSearchRoutes({
    app,
    store,
    database,
    masterKey,
    openName: (t: Pick<TaskRecord, 'workspaceId' | 'titleCiphertext'>, dataKey: Uint8Array) => {
      expect(t.titleCiphertext?.aad).toBe(`task-title:${t.workspaceId}`);
      return decryptJson<{ title: string }>(t.titleCiphertext!, dataKey).title;
    },
    openPrompt: (t: Pick<TaskRecord, 'workspaceId' | 'promptCiphertext'>, dataKey: Uint8Array) => {
      expect(t.promptCiphertext.aad).toBe(`task-prompt:${t.workspaceId}`);
      return decryptJson<{ prompt: string }>(t.promptCiphertext, dataKey).prompt;
    }
  } as unknown as RouteContext);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await database.close();
});

it('groups shared-key projects, retains inherited history, and enforces exact scope and owner boundaries', async () => {
  type Hit = {
    taskId: string;
    workspaceId: string;
    executionWorkspaceId: string;
    title: string;
    excerpt: string;
  };
  const search = async (q: string, workspaceId?: string, limit = 20, otherOwner = false) => {
    const query = new URLSearchParams({ q, limit: String(limit) });
    if (workspaceId) query.set('workspaceId', workspaceId);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/search?${query}`,
      headers: otherOwner ? { 'x-other-owner': 'yes' } : {}
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Hit[]>();
  };
  const queries = vi.spyOn(database, 'query');
  const names = await search('Orchid', parentId);
  expect(names).toHaveLength(2);
  expect(new Set(names.map((hit) => hit.taskId))).toEqual(new Set(projects.map((t) => t.id)));
  expect(names.every((hit) => hit.workspaceId === parentId)).toBe(true);
  expect(new Set(names.map((hit) => hit.executionWorkspaceId))).toEqual(
    new Set(projects.map((t) => t.workspaceId))
  );
  // Metadata plus two SQL probes for the shared key, regardless of the number of project roots.
  expect(queries).toHaveBeenCalledTimes(3);
  queries.mockRestore();

  const current = projects[0]!;
  const exact = await search('heliotrope', current.workspaceId);
  expect(exact).toHaveLength(1);
  expect(exact[0]).toMatchObject({
    taskId: current.id,
    workspaceId: current.workspaceId,
    title: 'Orchid report'
  });
  expect(exact[0]!.excerpt.toLowerCase()).toContain('heliotrope');
  const inherited = await search('observation', current.workspaceId);
  expect(inherited).toHaveLength(1);
  expect(inherited[0]).toMatchObject({ taskId: current.id, title: 'Orchid report' });
  expect(inherited[0]!.excerpt).toContain('observation');
  const all = await search('heliotrope');
  expect(new Set(all.map((hit) => hit.taskId))).toEqual(
    new Set([...projects.map((t) => t.id), otherTaskId])
  );
  expect(await search('Orchid', parentId, 1)).toHaveLength(1);
  expect(await search('Orchid', foreignId)).toEqual([]);
  expect(await search('heliotrope', current.workspaceId, 20, true)).toEqual([]);
  expect(ownerId).not.toBe(outsiderId);
});
