/** Search the owner's sealed names and source-linked history without reading full transcripts. */
import {
  conversationNamePrefixTokens,
  decryptJson,
  memoryExcerpt,
  memoryIndexKey,
  planMemoryQuery,
  unwrapDataKey
} from '@garden/core';
import { searchOwnerHistory, type TaskRecord } from '@garden/data';
import { z } from 'zod';
import { SEARCH_EXCERPT_CHARS } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerSearchRoutes = (context: RouteContext): void => {
  const { app, store, database, masterKey, openPrompt, openName } = context;
  app.get<{
    Querystring: { q?: string; workspaceId?: string; limit?: string };
  }>('/v1/search', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        q: z.string().trim().min(2).max(500),
        workspaceId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20)
      })
      .parse(request.query);
    const workspaces = (await store.listWorkspaceMetadata(user.id)).filter((w) => w.wrappedKey);
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    const selected = input.workspaceId ? byId.get(input.workspaceId) : undefined;
    if (input.workspaceId && !selected) return [];
    const ancestors = (id: string): string[] => {
      const ids = new Set<string>();
      let current: string | undefined = id;
      while (current && byId.has(current) && !ids.has(current)) {
        ids.add(current);
        current = byId.get(current)?.parentWorkspaceId;
      }
      return [...ids];
    };
    const targets = workspaces.filter((w) =>
      !selected
        ? true
        : selected.parentWorkspaceId
          ? w.id === selected.id
          : ancestors(w.id).includes(selected.id)
    );
    const workspaceIds = targets.map((w) => w.id);
    const sourceIds = new Set(workspaceIds.flatMap(ancestors));
    const keys = new Map<string, Uint8Array>();
    const groups = new Map<string, { key: Uint8Array; sourceWorkspaceIds: string[] }>();
    for (const id of sourceIds) {
      const key = unwrapDataKey(byId.get(id)!.wrappedKey!, masterKey, id);
      keys.set(id, key);
      // Project roots share their parent's data key. Group by the key, never by an assumed lineage.
      const fingerprint = Buffer.from(memoryIndexKey(key)).toString('hex');
      const group: { key: Uint8Array; sourceWorkspaceIds: string[] } = groups.get(fingerprint) ?? {
        key,
        sourceWorkspaceIds: []
      };
      group.sourceWorkspaceIds.push(id);
      groups.set(fingerprint, group);
    }
    const pages = await Promise.all(
      [...groups.values()].map(({ key, sourceWorkspaceIds }) => {
        const indexKey = memoryIndexKey(key);
        return searchOwnerHistory(database, {
          userId: user.id,
          workspaceIds,
          sourceWorkspaceIds,
          plan: planMemoryQuery(input.q, indexKey),
          prefixes: conversationNamePrefixTokens(input.q, indexKey),
          limit: input.limit
        });
      })
    );
    type Found = {
      workspaceId: string;
      title: string;
      updatedAt: string;
      named: number;
      said: { excerpt: string; score: number } | null;
      opening: string | null;
    };
    const found = new Map<string, Found>();
    const openTask = (
      task: Pick<
        TaskRecord,
        'workspaceId' | 'titleCiphertext' | 'legacyTitle' | 'promptCiphertext'
      >,
      key: Uint8Array
    ) => ({ title: openName(task, key) || 'Private task', prompt: openPrompt(task, key) });
    // Only the bounded page is decrypted; name and passage scores are ordered, never added.
    const namedHits = pages
      .flatMap((page) => page.names)
      .sort(
        (left, right) =>
          Number(right.wholeName) - Number(left.wholeName) ||
          Number(right.inName) - Number(left.inName) ||
          Number(right.namePrefix) - Number(left.namePrefix) ||
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )
      .slice(0, input.limit);
    for (const hit of namedHits) {
      const key = keys.get(hit.workspaceId);
      if (!key) continue;
      const { title, prompt } = openTask(hit, key);
      found.set(hit.id, {
        workspaceId: hit.workspaceId,
        title,
        updatedAt: hit.updatedAt,
        named: (hit.wholeName ? 4 : 0) + (hit.inName ? 2 : 0) + (hit.namePrefix ? 1 : 0) + 1,
        said: null,
        opening: memoryExcerpt(prompt || title, input.q, { maxChars: SEARCH_EXCERPT_CHARS })
      });
    }
    // A source retains its original sealing scope while its task can move into a project root.
    const bestPassages = new Map<string, (typeof pages)[number]['passages'][number]>();
    for (const hit of pages.flatMap((page) => page.passages)) {
      const previous = bestPassages.get(hit.task.id);
      if (!previous || previous.score < hit.score) bestPassages.set(hit.task.id, hit);
    }
    const hits = [...bestPassages.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit);
    for (const hit of hits) {
      const sourceKey = keys.get(hit.workspaceId);
      const taskKey = keys.get(hit.task.workspaceId);
      if (!sourceKey || !taskKey || hit.bodyCiphertext.aad !== `memory-source:${hit.workspaceId}`)
        continue;
      let body: string;
      try {
        body = decryptJson<{ body: string }>(hit.bodyCiphertext, sourceKey).body;
      } catch {
        continue;
      }
      const said = {
        excerpt: memoryExcerpt(body, input.q, { maxChars: SEARCH_EXCERPT_CHARS }),
        score: hit.score
      };
      const held = found.get(hit.task.id);
      if (held) held.said = said;
      else
        found.set(hit.task.id, {
          workspaceId: hit.task.workspaceId,
          title: openTask(hit.task, taskKey).title,
          updatedAt: hit.task.updatedAt,
          named: 0,
          said,
          opening: null
        });
    }
    return [...found]
      .sort(
        ([, left], [, right]) =>
          right.named - left.named ||
          (right.said?.score ?? 0) - (left.said?.score ?? 0) ||
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )
      .slice(0, input.limit)
      .map(([taskId, result]) => ({
        taskId,
        workspaceId: selected?.parentWorkspaceId
          ? selected.id
          : (ancestors(result.workspaceId).at(-1) ?? result.workspaceId),
        executionWorkspaceId: result.workspaceId,
        title: result.title,
        excerpt: result.said?.excerpt ?? result.opening ?? result.title,
        updatedAt: result.updatedAt
      }));
  });
};
