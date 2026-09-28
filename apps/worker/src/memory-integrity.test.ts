import { appendMemoryOwnerInput } from './memory-owner-input.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, DataStore, type Database } from '@garden/data';
import {
  encryptJson,
  buildMemoryItemIndex,
  memoryIndexKey,
  estimateMemoryTokens,
  renderMemoryPack
} from '@garden/core';
import {
  buildTaskMemoryPack,
  recallMemory,
  memoryItemAad,
  recordTurnEpisode,
  observedMemoryFacts,
  renderResidentMemory,
  memoryPackMessage
} from './memory-runtime.js';

const key = Buffer.alloc(32, 6);
let db: Database;
let store: DataStore;
let userId: string;
beforeAll(async () => {
  db = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  await migrateDatabase(db);
  store = new DataStore(db);
  await store.syncMemoryPredicates();
  userId = (await store.createUser({ username: randomUUID(), displayName: 'Owner' })).id;
}, 120_000);
afterAll(async () => {
  await db.close();
});
const workspace = async (parent?: string) => {
  const w = await store.createWorkspace({
    userId,
    name: 'Fixture',
    storageLimitBytes: 1024,
    imageRevision: 'fixture',
    region: 'local',
    wrappedKey: 'fixture'
  });
  if (parent)
    await db.query('UPDATE workspaces SET parent_workspace_id=$1 WHERE id=$2', [parent, w.id]);
  return w.id;
};
const task = async (workspaceId: string) =>
  store.createTask({
    userId,
    workspaceId,
    titleCiphertext: encryptJson({ title: 'Fixture' }, key, `task-title:${workspaceId}`),
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'fixture',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    promptCiphertext: encryptJson(
      { prompt: 'quartz deployment' },
      key,
      `task-prompt:${workspaceId}`
    )
  });
const fact = async (workspaceId: string, body: string, validTo?: Date) =>
  store.recordMemoryFact({
    userId,
    workspaceId,
    trust: 'stated',
    predicate: 'project_status',
    pin: true,
    documentCiphertext: encryptJson({ body }, key, memoryItemAad(workspaceId)),
    index: buildMemoryItemIndex({ body, subject: body, object: 'pending' }, memoryIndexKey(key)),
    observedAt: new Date('2026-07-01'),
    validFrom: new Date('2026-07-01'),
    ...(validTo ? { validTo } : {})
  });

describe('memory integrity across lifecycle boundaries', () => {
  it('bounds owner evidence without slicing a quotation into an apparent assertion', () => {
    const next = 'Translate the following:\nI prefer jasmine tea.';
    expect(appendMemoryOwnerInput('x'.repeat(64_000), next)).toBe(next);
    expect(appendMemoryOwnerInput(undefined, 'x'.repeat(64_001))).toBe('');
    expect(
      appendMemoryOwnerInput('I use fish as my shell.', 'I prefer concise answers.')
    ).toContain('I use fish as my shell.');
  });
  it('does not learn quoted, hypothetical or transformation-target preferences', () => {
    const cases = [
      'Translate this sentence into French: "I prefer jasmine tea."',
      'Translate the following:\nI prefer jasmine tea.',
      'Here is another exercise.\nTranslate the following:\nI prefer jasmine tea.',
      '> I prefer jasmine tea.',
      '    I prefer jasmine tea.',
      'I prefer brief answers, except when explaining methods.',
      '```text\nI prefer jasmine tea.\n```',
      'If I prefer jasmine tea, what should I order?',
      'I would prefer jasmine tea if I drank tea.',
      'She said I prefer jasmine tea.'
    ];
    expect(cases.length).toBeGreaterThan(0);
    for (const text of cases) expect(observedMemoryFacts(text), text).toEqual([]);
    expect(observedMemoryFacts('I live in St. Petersburg.')).toEqual([
      { subject: 'owner', predicate: 'lives_in', object: 'St. Petersburg' }
    ]);
    expect(observedMemoryFacts('I prefer concise answers.')).toEqual([
      { subject: 'owner', predicate: 'prefers', object: 'concise answers' }
    ]);
  });
  it('learns direct owner evidence after tools without learning from tool text or synthetic requests', async () => {
    const workspaceId = await workspace();
    for (const day of ['2026-09-01', '2026-09-03']) {
      const t = await task(workspaceId);
      const result = await recordTurnEpisode({
        store,
        userId,
        workspaceId,
        dataKey: key,
        taskId: t.id,
        request: 'I prefer invented external claims.',
        ownerRequest: 'I prefer concise answers.',
        summary: 'A web page says I prefer unsupported guesses.',
        outcome: 'ok',
        tainted: true,
        taintOrigin: 'https://example.test',
        occurredAt: new Date(day)
      });
      expect(result?.factCandidates).toBe(1);
    }
    const facts = await store.listMemoryItems(workspaceId, { kind: 'fact' });
    expect(facts).toHaveLength(1);
    const noOwner = await recordTurnEpisode({
      store,
      userId,
      workspaceId,
      dataKey: key,
      taskId: (await task(workspaceId)).id,
      request: 'I prefer an automated schedule.',
      ownerRequest: '',
      summary: 'Finished.',
      outcome: 'ok',
      tainted: false,
      occurredAt: new Date('2026-09-05')
    });
    expect(noOwner?.factCandidates).toBe(0);
  });
  it('excludes expired facts by default while allowing explicit historical recall', async () => {
    const workspaceId = await workspace();
    const expired = await fact(
      workspaceId,
      'quartz deployment approval is pending',
      new Date('2026-07-15')
    );
    await store.rebuildMemoryCorpusStats(workspaceId);
    const t = await task(workspaceId);
    const input = {
      store,
      workspaceId,
      dataKey: key,
      taskId: t.id,
      query: 'quartz deployment approval',
      now: new Date('2026-09-28')
    };
    expect((await recallMemory(input)).entries.some((e) => e.id === expired.item.id)).toBe(false);
    expect(
      (await recallMemory({ ...input, asOf: '2026-07-10T00:00:00.000Z' })).entries.some(
        (e) => e.id === expired.item.id
      )
    ).toBe(true);
  });
  it('retraction invalidates shared child packs without granting child mutation rights', async () => {
    const parent = await workspace();
    const child = await workspace(parent);
    const item = (await fact(parent, 'quartz deployment requires blue packaging')).item;
    await store.rebuildMemoryCorpusStats(parent);
    const t = await task(child);
    const input = {
      store,
      workspaceId: child,
      dataKey: key,
      taskId: t.id,
      query: 'quartz deployment packaging',
      clockAnchor: new Date('2026-09-28')
    };
    const before = await buildTaskMemoryPack(input);
    expect(before.itemIds).toContain(item.id);
    expect(await store.retractMemoryItem(child, item.id)).toBe(false);
    expect(await store.getMemoryPack(t.id)).not.toBeNull();
    expect(await store.retractMemoryItem(parent, item.id)).toBe(true);
    expect(await store.getMemoryPack(t.id)).toBeNull();
    expect((await buildTaskMemoryPack(input)).itemIds).not.toContain(item.id);
  });
  it('keeps unrelated packs and refuses foreign deletion before touching links', async () => {
    const own = await workspace();
    const foreign = await workspace();
    const item = (await fact(own, 'quartz deployment uses amber packaging')).item;
    const other = (await fact(own, 'quartz deployment uses violet packaging')).item;
    await db.query("INSERT INTO mem.link(src_id,dst_id,rel) VALUES ($1,$2,'supports')", [
      item.id,
      other.id
    ]);
    expect(await store.forgetMemoryItem(foreign, item.id)).toBe(false);
    expect((await db.query('SELECT * FROM mem.link WHERE src_id=$1', [item.id])).rows).toHaveLength(
      1
    );
  });
  it('refuses a pack built before a correction and refreshes cached packs when the model budget shrinks', async () => {
    const workspaceId = await workspace();
    const item = (await fact(workspaceId, 'quartz deployment uses green packaging')).item;
    await store.rebuildMemoryCorpusStats(workspaceId);
    const t = await task(workspaceId);
    const input = {
      store,
      workspaceId,
      dataKey: key,
      taskId: t.id,
      query: 'quartz deployment',
      clockAnchor: new Date('2026-09-28')
    };
    const initial = await buildTaskMemoryPack(input);
    expect(initial.itemIds).toContain(item.id);
    const small = await buildTaskMemoryPack({ ...input, budgetTokens: 256 });
    expect(small.itemIds).toHaveLength(0);
    const restored = await buildTaskMemoryPack(input);
    expect(restored.itemIds).toContain(item.id);
    const pending = await store.getMemoryPack(t.id);
    expect(pending).not.toBeNull();
    await store.retractMemoryItem(workspaceId, item.id);
    await expect(store.saveMemoryPack(pending!)).rejects.toMatchObject({
      code: 'memory_evidence_changed'
    });
    expect(await store.getMemoryPack(t.id)).toBeNull();
  });
  it('keeps previews bounded including framing while retaining relevant detail from a long history', () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      id: randomUUID(),
      kind: 'episode' as const,
      trust: 'derived' as const,
      observedAt: '2026-09-01T00:00:00.000Z',
      validFrom: '2026-09-01T00:00:00.000Z',
      validTo: null,
      title: `Deployment ${index}`,
      tags: [],
      body:
        'Routine preparation and checks completed. '.repeat(120) +
        `Quartz deployment rollback uses snapshot violet-${index}.` +
        ' Routine cleanup.'.repeat(60)
    }));
    const rendered = renderResidentMemory(entries, 'quartz deployment rollback snapshot', 1500);
    expect(rendered.itemIds.length).toBeGreaterThan(0);
    expect(rendered.body).toContain('snapshot violet-0');
    expect(rendered.body).toContain('session_search');
    expect(estimateMemoryTokens(memoryPackMessage(rendered.body).content)).toBeLessThanOrEqual(
      1500
    );
    const full = renderMemoryPack(entries);
    expect(estimateMemoryTokens(memoryPackMessage(rendered.body).content)).toBeLessThan(
      estimateMemoryTokens(memoryPackMessage(full.body).content) / 2
    );
    expect(renderResidentMemory(entries, 'quartz', 256).itemIds).toHaveLength(0);
  });
  it('pages through all owner project memory without widening agent recall to sibling projects', async () => {
    const root = await workspace(),
      child = await workspace(root),
      sibling = await workspace(root);
    const own = (await fact(root, 'shared quartz settings')).item;
    const a = (await fact(child, 'quartz private project A')).item;
    const b = (await fact(sibling, 'quartz private project B')).item;
    const first = await store.listOwnerMemoryItems(userId, root, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const last = first.items.at(-1)!;
    const second = await store.listOwnerMemoryItems(userId, root, {
      limit: 2,
      cursor: { at: last.observedAt, id: last.id }
    });
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map((i) => i.id))).toEqual(
      new Set([own.id, a.id, b.id])
    );
    expect(
      (await store.listOwnerMemoryItems(userId, root, { scope: child })).items.map((i) => i.id)
    ).toEqual([a.id]);
    expect((await store.listMemoryItems(child)).map((i) => i.id)).not.toContain(b.id);
    const stranger = (
      await store.createUser({ username: randomUUID(), displayName: 'Other owner' })
    ).id;
    expect((await store.listOwnerMemoryItems(stranger, root)).items).toHaveLength(0);
  });
  it('drops an expired cached belief when a long-running conversation resumes', async () => {
    const workspaceId = await workspace();
    const item = (
      await fact(workspaceId, 'quartz approval expires in July', new Date('2026-07-15'))
    ).item;
    await store.rebuildMemoryCorpusStats(workspaceId);
    const t = await task(workspaceId);
    const input = {
      store,
      workspaceId,
      dataKey: key,
      taskId: t.id,
      query: 'quartz approval',
      clockAnchor: new Date('2026-07-10')
    };
    expect((await buildTaskMemoryPack(input)).itemIds).toContain(item.id);
    expect(
      (await buildTaskMemoryPack({ ...input, validAt: new Date('2026-09-28') })).itemIds
    ).not.toContain(item.id);
  });
  it('invalidates disputed shared facts and refuses to mark another workspace disputed', async () => {
    const parent = await workspace(),
      child = await workspace(parent);
    const item = (await fact(parent, 'quartz packaging conflict')).item;
    await store.rebuildMemoryCorpusStats(parent);
    const t = await task(child);
    const input = {
      store,
      workspaceId: child,
      dataKey: key,
      taskId: t.id,
      query: 'quartz packaging',
      clockAnchor: new Date('2026-09-28')
    };
    expect((await buildTaskMemoryPack(input)).itemIds).toContain(item.id);
    expect(await store.markMemoryFactsDisputed(child, [item.id])).toBe(0);
    expect(await store.getMemoryPack(t.id)).not.toBeNull();
    expect(await store.markMemoryFactsDisputed(parent, [item.id])).toBe(1);
    expect(await store.getMemoryPack(t.id)).toBeNull();
  });
});
