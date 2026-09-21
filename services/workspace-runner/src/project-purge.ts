import path from 'node:path';
import { z } from 'zod';
import {
  ProjectPurgeApply,
  ProjectPurgeSelection,
  type ProjectPurgePreview,
  type ProjectPurgeResult
} from '@athanor/contracts';
import { ProjectHistoryMetadata, HistoryDigest } from './project-history-metadata.js';
import { contentRemovalFile } from './project-content-state.js';
import {
  acquireProjectReference,
  withProjectReference,
  type ProjectReferenceLock
} from './project-reference-lock.js';
import { historyHash, normalizePurgeSelection, projectPurgeGraph } from './project-purge-graph.js';
import { purgeFilesystem, purgeCapacity, PurgeManifest } from './project-purge-files.js';
import { durableJson } from './project-version-files.js';
import { WorkspaceFileError } from './files.js';

const Transaction = z
  .object({
    version: z.literal(1),
    requestId: z.uuid(),
    digest: HistoryDigest,
    graph: HistoryDigest,
    selection: ProjectPurgeSelection,
    retainedAfterInterruption: z.array(z.string()).max(100_000),
    roots: z.array(z.string()).max(100_040),
    manifest: PurgeManifest,
    filesRemoved: z.boolean(),
    state: z.enum(['removing', 'removed']),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    logicalBytes: z.number().nonnegative(),
    estimatedFreedBytes: z.number().nonnegative(),
    sharedObjectsRetained: z.number().int().nonnegative(),
    detail: z.string().nullable()
  })
  .strict();
type Transaction = z.infer<typeof Transaction>;
function conflict(message: string): never {
  throw new WorkspaceFileError(message, 409);
}

/** An immutable reviewed manifest is the only deletion authority, including after a crash. */
export class ProjectPurge extends ProjectHistoryMetadata {
  readonly #running = new Map<string, Promise<void>>();
  runningCount(): number {
    return this.#running.size;
  }
  constructor(
    root: string,
    projectId: string,
    readonly assertIdle: () => Promise<void>,
    readonly filesystem = purgeFilesystem
  ) {
    super(root, projectId);
  }
  private file(id: string) {
    return this.state(`purge/transactions/${z.uuid().parse(id)}.json`);
  }
  private relative(filename: string) {
    const relative = path.relative(this.root, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw Error('History path is outside storage.');
    return relative.split(path.sep).join('/');
  }
  private async pending(resuming?: string) {
    for (const name of await this.names('purge/transactions')) {
      const value = await this.read(this.state(`purge/transactions/${name}`), Transaction);
      if (!value || name !== `${value.requestId}.json`)
        throw Error('Cleanup transaction identity changed.');
      if (value.state === 'removing' && value.requestId !== resuming)
        conflict('Resume the saved history cleanup before starting another.');
    }
  }
  private async inspect(selection: ProjectPurgeSelection) {
    await this.pending();
    const graph = await projectPurgeGraph(this, selection);
    const roots = [
      ...graph.directories.map((item) => item.path),
      ...graph.objects.map((item) => item.path)
    ]
      .map((name) => this.relative(name))
      .sort();
    const manifest = await this.filesystem(
      this.root,
      {
        projectId: this.projectId,
        mode: 'scan',
        roots,
        retained: [...graph.retainedObjects, ...graph.objects].map((item) => ({
          path: this.relative(item.path),
          ...item.fact
        }))
      },
      PurgeManifest
    );
    for (const directory of graph.directories) {
      if (!directory.identity) continue;
      const relative = this.relative(directory.path),
        root = manifest.entries.find((item) => item.path === relative);
      const entries = manifest.entries
        .filter((item) => item.path.startsWith(relative + '/'))
        .map((item) => [
          item.path.slice(relative.length + 1),
          item.device,
          item.inode,
          String(item.size),
          String(item.mode),
          item.modified
        ])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
      if (
        !root ||
        root.device !== directory.identity.device ||
        root.inode !== directory.identity.inode ||
        historyHash(entries) !== directory.identity.tree
      )
        conflict('Archived files changed. Their saved identity cannot be verified.');
    }
    const capacity = purgeCapacity(manifest);
    const preview: ProjectPurgePreview = {
      digest: historyHash({ selection, graph: graph.digest, roots, manifest }),
      observedAt: new Date().toISOString(),
      items: graph.items.map((item) => {
        const directory = graph.directories.find(
          (value) => value.kind === item.kind && value.id === item.id
        )!;
        const relative = this.relative(directory.path);
        return {
          ...item,
          logicalBytes: manifest.entries.reduce(
            (sum, entry) =>
              sum +
              (entry.kind === 'file' &&
              (entry.path === relative || entry.path.startsWith(relative + '/'))
                ? entry.size
                : 0),
            0
          )
        };
      }),
      ...capacity,
      sharedObjectsRemoved: graph.objects.length,
      sharedObjectsRetained: graph.sharedObjectsRetained
    };
    return { preview, manifest, graph: graph.selectionDigest, roots };
  }
  async preview(raw: unknown): Promise<ProjectPurgePreview> {
    const selection = normalizePurgeSelection(ProjectPurgeSelection.parse(raw));
    return withProjectReference(this.root, this.projectId, 'read', async () => {
      const { preview } = await this.inspect(selection);
      try {
        await this.assertIdle();
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'Running-work protection cannot be verified.';
        for (const item of preview.items) item.reasons.push(reason);
      }
      return preview;
    });
  }
  private result(value: Transaction): ProjectPurgeResult {
    return {
      requestId: value.requestId,
      digest: value.digest,
      state: value.state,
      startedAt: value.startedAt,
      completedAt: value.completedAt,
      selection: value.selection,
      logicalBytes: value.logicalBytes,
      estimatedFreedBytes: value.estimatedFreedBytes,
      removedPaths:
        value.state === 'removed'
          ? value.manifest.entries.length - value.retainedAfterInterruption.length
          : 0,
      running: this.#running.has(value.requestId),
      detail: value.detail
    };
  }
  async pendingRequests(): Promise<ProjectPurgeResult[]> {
    const results: ProjectPurgeResult[] = [];
    for (const name of await this.names('purge/transactions')) {
      const value = await this.read(this.state(`purge/transactions/${name}`), Transaction);
      if (!value || name !== `${value.requestId}.json`)
        throw Error('Cleanup transaction identity changed.');
      if (value.state === 'removing') results.push(this.result(value));
    }
    return results;
  }
  async status(id: string): Promise<ProjectPurgeResult> {
    const value = await this.read(this.file(id), Transaction);
    if (!value || value.requestId !== id)
      throw new WorkspaceFileError('History cleanup receipt not found.', 404);
    return this.result(value);
  }
  private async mark(value: Transaction) {
    for (const [kind, ids] of [
      ['version', value.selection.versions],
      ['update', value.selection.updates],
      ['check', value.selection.checks]
    ] as const)
      for (const id of ids)
        await durableJson(contentRemovalFile(this, kind, id), {
          version: 1,
          kind,
          id,
          requestId: value.requestId,
          state: value.state,
          startedAt: value.startedAt,
          completedAt: value.completedAt
        });
  }
  async apply(raw: unknown): Promise<ProjectPurgeResult> {
    const input = ProjectPurgeApply.parse(raw),
      selection = normalizePurgeSelection(input.selection);
    const verify = (value: Transaction) => {
      if (
        value.requestId !== input.requestId ||
        value.digest !== input.digest ||
        historyHash(value.selection) !== historyHash(selection)
      )
        conflict('Cleanup request identity changed. Review a new preview.');
    };
    const recorded = await this.read(this.file(input.requestId), Transaction);
    if (recorded) {
      verify(recorded);
      if (recorded.state === 'removed' || this.#running.has(input.requestId))
        return this.result(recorded);
    }
    const lock = await acquireProjectReference(this.root, this.projectId, 'write');
    let transferred = false;
    try {
      let value = await this.read(this.file(input.requestId), Transaction);
      if (value) {
        verify(value);
        if (value.state === 'removed') return this.result(value);
      }
      await this.assertIdle();
      await this.pending(input.requestId);
      if (!value) {
        const inspected = await this.inspect(selection);
        if (inspected.preview.digest !== input.digest)
          conflict('History changed. Review a fresh cleanup preview.');
        if (inspected.preview.items.some((item) => item.reasons.length))
          conflict('Selected history is still needed. Review its references before cleanup.');
        value = Transaction.parse({
          version: 1,
          requestId: input.requestId,
          digest: input.digest,
          selection,
          retainedAfterInterruption: [],
          graph: inspected.graph,
          roots: inspected.roots,
          manifest: inspected.manifest,
          filesRemoved: false,
          state: 'removing',
          startedAt: new Date().toISOString(),
          completedAt: null,
          logicalBytes: inspected.preview.logicalBytes,
          estimatedFreedBytes: inspected.preview.estimatedFreedBytes,
          sharedObjectsRetained: inspected.preview.sharedObjectsRetained,
          detail: null
        });
        await durableJson(this.file(value.requestId), value);
      } else if (!value.filesRemoved) {
        const graph = await projectPurgeGraph(this, selection, value.requestId);
        if (
          graph.selectionDigest !== value.graph ||
          graph.items.some((item) => item.reasons.length)
        )
          conflict(
            'Selected history changed during interrupted cleanup. Its reviewed selection has been preserved.'
          );
        const retained = new Set([
          ...value.retainedAfterInterruption,
          ...graph.retainedObjects.map((item) => this.relative(item.path))
        ]);
        value.retainedAfterInterruption = value.manifest.entries
          .filter((item) => retained.has(item.path))
          .map((item) => item.path);
        const remaining = {
          ...value.manifest,
          entries: value.manifest.entries.filter((item) => !retained.has(item.path))
        };
        const capacity = purgeCapacity(remaining);
        value.logicalBytes = capacity.logicalBytes;
        value.estimatedFreedBytes = capacity.estimatedFreedBytes;
        await this.filesystem(
          this.root,
          {
            projectId: this.projectId,
            mode: 'scan',
            roots: value.roots,
            retained: graph.retainedObjects.map((item) => ({
              path: this.relative(item.path),
              ...item.fact
            }))
          },
          PurgeManifest
        );
      }
      await this.mark(value);
      value.detail = null;
      await durableJson(this.file(value.requestId), value);
      const transaction = value;
      const run = this.execute(transaction, lock);
      this.#running.set(value.requestId, run);
      transferred = true;
      void run.finally(() => this.#running.delete(transaction.requestId)).catch(() => undefined);
      return this.result(value);
    } finally {
      if (!transferred) await lock.release();
    }
  }
  private async execute(value: Transaction, lock: ProjectReferenceLock): Promise<void> {
    try {
      if (!value.filesRemoved) {
        const retained = new Set(value.retainedAfterInterruption);
        await this.filesystem(
          this.root,
          {
            projectId: this.projectId,
            mode: 'remove',
            roots: value.roots,
            manifest: {
              ...value.manifest,
              entries: value.manifest.entries.filter((item) => !retained.has(item.path))
            }
          },
          z.object({ removed: z.number().int().nonnegative() }).strict(),
          lock
        );
        value.filesRemoved = true;
        await durableJson(this.file(value.requestId), value);
      }
      // The content hashes and line-count receipts remain; removed candidate bodies do not.
      for (const id of value.selection.updates) {
        const filename = this.state(`updates/${id}.json`);
        const update = await this.read(
          filename,
          z
            .object({ id: z.uuid(), changes: z.array(z.record(z.string(), z.unknown())) })
            .passthrough()
        );
        if (!update || update.id !== id) throw Error('Removed update receipt identity changed.');
        for (const change of update.changes) delete change.diff;
        await durableJson(filename, update);
      }
      const completed: Transaction = {
        ...value,
        state: 'removed',
        completedAt: new Date().toISOString()
      };
      await this.mark(completed);
      await durableJson(this.file(value.requestId), completed);
    } catch (error) {
      value.detail = error instanceof Error ? error.message : 'History cleanup was interrupted.';
      await durableJson(this.file(value.requestId), value);
    } finally {
      await lock.release();
    }
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.#running.values()]);
  }
}
