import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type {
  ProjectFileVersion,
  ProjectPurgePreview,
  ProjectPurgeSelection
} from '@athanor/contracts';
import {
  type ProjectHistoryMetadata,
  HistoryDigest,
  HistoryTree
} from './project-history-metadata.js';
import { contentRemoval } from './project-content-state.js';
import { ProjectVersionPins } from './project-version-pins.js';
import { ProjectVersionFiles, projectPath, treeDigest } from './project-version-files.js';

const FileFact = HistoryTree.valueType;
const Check = z
  .object({
    id: z.uuid(),
    status: z.enum([
      'pending',
      'preparing',
      'running',
      'verifying',
      'passed',
      'failed',
      'interrupted',
      'invalidated',
      'cancelled'
    ]),
    candidateDigest: z.string(),
    sessionId: z.string().nullable()
  })
  .passthrough();
const Update = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    sourceWorkspaceId: z.uuid(),
    taskId: z.uuid(),
    title: z.string(),
    parentRevision: z.uuid().nullable(),
    state: z.enum([
      'preparing',
      'ready',
      'conflicted',
      'checking',
      'checks_failed',
      'outdated',
      'published',
      'failed',
      'cancelled'
    ]),
    proposed: HistoryTree,
    candidate: HistoryTree,
    baseline: HistoryTree,
    candidateDigest: HistoryDigest.nullable(),
    checks: z.array(Check).max(1024),
    changes: z
      .array(
        z.object({
          base: FileFact.nullable(),
          current: FileFact.nullable(),
          proposed: FileFact.nullable(),
          result: FileFact.nullable()
        })
      )
      .max(100_000)
  })
  .passthrough();
const Archive = z
  .object({
    revisionId: z.uuid(),
    requestId: z.uuid(),
    state: z.enum(['archiving', 'archived', 'restoring', 'restored']),
    revisionDigest: HistoryDigest,
    identity: z.object({ device: z.string(), inode: z.string(), tree: HistoryDigest }).strict()
  })
  .passthrough();
const activeCheck = (state: string) => ['preparing', 'running', 'verifying'].includes(state);
const terminalUpdate = (state: string) => ['published', 'failed', 'cancelled'].includes(state);
const objectKey = (fact: ProjectFileVersion) => `${fact.sha256}.${fact.executable ? 'x' : 'r'}`;
export const historyHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const normalizePurgeSelection = (
  selection: ProjectPurgeSelection
): ProjectPurgeSelection => ({
  versions: [...new Set(selection.versions)].sort(),
  updates: [...new Set(selection.updates)].sort(),
  checks: [...new Set(selection.checks)].sort()
});

export interface PurgeGraph {
  digest: string;
  selectionDigest: string;
  items: ProjectPurgePreview['items'];
  directories: Array<{
    path: string;
    kind: 'version' | 'update' | 'check';
    id: string;
    identity?: { device: string; inode: string; tree: string };
  }>;
  objects: Array<{ path: string; fact: ProjectFileVersion }>;
  retainedObjects: Array<{ path: string; fact: ProjectFileVersion }>;
  sharedObjectsRetained: number;
}

/** All reconstruction references are retained, including facts no longer present in a public tree. */
export async function projectPurgeGraph(
  metadata: ProjectHistoryMetadata,
  selection: ProjectPurgeSelection,
  resuming?: string
): Promise<PurgeGraph> {
  const registry = await metadata.read(
    metadata.state('registry.json'),
    z.object({
      workspaceId: z.uuid(),
      head: z.uuid().nullable(),
      members: z.record(z.uuid(), z.uuid())
    })
  );
  if (!registry) throw Error('Project reference metadata is unavailable.');
  const selected = {
    version: new Set(selection.versions),
    update: new Set(selection.updates),
    check: new Set(selection.checks)
  };
  const found = { version: new Set<string>(), update: new Set<string>(), check: new Set<string>() };
  const retained = new Map<string, ProjectFileVersion>(),
    discarded = new Map<string, ProjectFileVersion>();
  const reasons = new Map<string, Set<string>>();
  let uniqueFacts = 0;
  const snapshots: unknown[] = [registry];
  const selectedFacts: unknown[] = [];
  const items: PurgeGraph['items'] = [],
    directories: PurgeGraph['directories'] = [];
  const retainVersion = (id: string | null, reason: string) => {
    if (!id) return;
    const list = reasons.get(id) ?? new Set<string>();
    list.add(reason);
    reasons.set(id, list);
  };
  const fact = (value: ProjectFileVersion, target: Map<string, ProjectFileVersion>) => {
    const key = objectKey(value),
      prior = retained.get(key) ?? discarded.get(key);
    if (prior && prior.bytes !== value.bytes)
      throw Error('Stored content has conflicting reference metadata.');
    target.set(key, value);
    if (!prior) uniqueFacts++;
    if (uniqueFacts > 100_000)
      throw Error('Content references exceed the maintenance inspection limit.');
  };
  const tree = (values: z.infer<typeof HistoryTree>, target: Map<string, ProjectFileVersion>) => {
    for (const [name, value] of Object.entries(values)) {
      if (!name || projectPath(`workspace/${name}`) !== name)
        throw Error('A stored file reference is invalid.');
      fact(value, target);
    }
  };
  const removal = async (kind: 'version' | 'update' | 'check', id: string) => {
    const value = await contentRemoval(metadata, kind, id);
    snapshots.push([kind, id, value?.requestId === resuming ? null : value]);
    if (value?.state === 'removing' && value.requestId !== resuming)
      throw Error('Finish the saved history cleanup before starting another.');
    if (value && selected[kind].has(id) && value.requestId !== resuming)
      throw Error('Selected content has already been removed. Refresh project history.');
    return value;
  };
  retainVersion(registry.head, 'Current published version');
  for (const name of await metadata.names('baselines')) {
    const value = await metadata.read(
      metadata.state(`baselines/${name}`),
      z.object({ revision: z.uuid().nullable(), files: HistoryTree })
    );
    if (!value) throw Error('A working-area baseline disappeared.');
    snapshots.push(['baseline', name, value]);
    tree(value.files, retained);
    retainVersion(value.revision, 'Used by a working-area baseline');
  }
  const pins = new ProjectVersionPins(metadata.state('pins'));
  let cursor: string | undefined,
    count = 0;
  do {
    const page = await pins.page(cursor);
    for (const pin of page.pins) {
      snapshots.push(['pin', pin]);
      retainVersion(pin.revisionId, 'Pinned by you');
      if (++count > 10_000) throw Error('Pins exceed the maintenance inspection limit.');
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  for (const name of await metadata.names('updates')) {
    const update = await metadata.read(metadata.state(`updates/${name}`), Update);
    if (!update || update.projectId !== metadata.projectId || `${update.id}.json` !== name)
      throw Error('A project update reference is invalid.');
    if (update.candidateDigest && treeDigest(update.candidate) !== update.candidateDigest)
      throw Error('Candidate content metadata failed verification.');
    snapshots.push(['update', update]);
    found.update.add(update.id);
    const removed = await removal('update', update.id);
    const picked = selected.update.has(update.id);
    if (!removed || picked) {
      const target = picked ? discarded : retained;
      for (const values of [update.baseline, update.proposed, update.candidate])
        tree(values, target);
      for (const change of update.changes)
        for (const value of [change.base, change.current, change.proposed, change.result])
          if (value) fact(value, target);
    }
    if (!terminalUpdate(update.state) || update.checks.some((check) => activeCheck(check.status)))
      retainVersion(update.parentRevision, 'Used by an unfinished project update');
    if (picked) {
      selectedFacts.push([
        'update',
        update.id,
        update.taskId,
        update.sourceWorkspaceId,
        update.baseline,
        update.proposed,
        update.candidate
      ]);
      const blocked =
        terminalUpdate(update.state) && !update.checks.some((check) => activeCheck(check.status))
          ? []
          : ['This project update is unfinished or still has running checks'];
      items.push({
        kind: 'update',
        id: update.id,
        title: update.title,
        logicalBytes: 0,
        reasons: blocked
      });
      directories.push({
        path: path.join(metadata.directory, 'public', 'candidates', update.id),
        kind: 'update',
        id: update.id
      });
    }
    for (const check of update.checks) {
      if (found.check.has(check.id))
        throw Error('A check identity belongs to more than one update.');
      found.check.add(check.id);
      await removal('check', check.id);
      if (!selected.check.has(check.id)) continue;
      selectedFacts.push(['check', update.id, check.id, check.candidateDigest, check.sessionId]);
      const blocked: string[] = [];
      if (['pending', 'preparing', 'running', 'verifying'].includes(check.status))
        blocked.push('This check has not settled');
      if (check.id === registry.workspaceId || Object.values(registry.members).includes(check.id))
        throw Error('A check directory overlaps a working area.');
      const marker = await metadata.read(
        path.join(metadata.root, check.id, '.athanor/project-check.json'),
        z.object({
          projectId: z.uuid(),
          updateId: z.uuid(),
          checkId: z.uuid(),
          candidateDigest: HistoryDigest
        })
      );
      const directoryExists = await lstat(path.join(metadata.root, check.id)).then(
        () => true,
        (error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      );
      if (
        (!marker && !resuming && directoryExists) ||
        (marker &&
          (marker.projectId !== metadata.projectId ||
            marker.updateId !== update.id ||
            marker.checkId !== check.id ||
            marker.candidateDigest !== check.candidateDigest))
      )
        throw Error('Check directory ownership cannot be verified.');
      items.push({
        kind: 'check',
        id: check.id,
        title: typeof check.name === 'string' ? check.name : 'Saved check',
        logicalBytes: 0,
        reasons: blocked
      });
      directories.push({ path: path.join(metadata.root, check.id), kind: 'check', id: check.id });
    }
  }
  for (const name of await metadata.names('revisions')) {
    const id = name.slice(0, -5),
      revision = await metadata.revision(id);
    found.version.add(id);
    snapshots.push(['revision', revision]);
    const removed = await removal('version', id),
      picked = selected.version.has(id);
    if (removed && reasons.has(id))
      throw Error('Required version content was removed; resolve its references before cleanup.');
    if (!removed || picked) tree(revision.files, picked ? discarded : retained);
    if (!picked) continue;
    const archive = await metadata.read(metadata.state(`retention/records/${id}.json`), Archive);
    if (archive && (archive.revisionId !== id || archive.revisionDigest !== revision.digest))
      throw Error('Archived version identity changed.');
    snapshots.push(['archive', id, archive]);
    selectedFacts.push(['version', id, revision.digest, archive]);
    const blocked = [...(reasons.get(id) ?? [])];
    if (archive?.state !== 'archived')
      blocked.push('Archive this version before permanently removing its files');
    items.push({
      kind: 'version',
      id,
      title: `Version ${revision.number} · ${revision.title}`,
      logicalBytes: 0,
      reasons: blocked
    });
    directories.push({
      path: metadata.state(`retention/content/${id}`),
      kind: 'version',
      id,
      ...(archive?.state === 'archived' ? { identity: archive.identity } : {})
    });
  }
  for (const kind of ['version', 'update', 'check'] as const)
    for (const id of selected[kind])
      if (!found[kind].has(id)) throw Error('A selected history item no longer exists.');
  for (const id of reasons.keys())
    if (!found.version.has(id)) throw Error('A required version reference is missing.');
  const files = new ProjectVersionFiles(metadata.state('content'));
  return {
    digest: historyHash(snapshots),
    selectionDigest: historyHash(selectedFacts),
    items,
    directories,
    objects: [...discarded]
      .filter(([key]) => !retained.has(key))
      .map(([, value]) => ({ path: files.object(value), fact: value })),
    retainedObjects: [...retained.values()].map((value) => ({
      path: files.object(value),
      fact: value
    })),
    sharedObjectsRetained: [...discarded.keys()].filter((key) => retained.has(key)).length
  };
}
