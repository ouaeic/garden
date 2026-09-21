import { ProjectRepositoryOperation } from '@athanor/contracts';
import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ProjectRetentionApply,
  ProjectRetentionSelection,
  type ProjectRetentionPreview,
  type ProjectRetentionResult,
  type ProjectVersionArchive
} from '@athanor/contracts';
import { withWorkspaceDirectory, WorkspaceFileError } from './files.js';
import { acquireDirectoryReference, withProjectReference } from './project-reference-lock.js';
import {
  ProjectHistoryMetadata,
  HistoryDigest as Digest,
  HistoryTree as Tree
} from './project-history-metadata.js';
import { assertHistoryContentAvailable } from './project-content-state.js';
import { ProjectVersionPins } from './project-version-pins.js';
import { moveVersionDirectory } from './project-retention-move.js';
import {
  durableJson,
  durableMkdir,
  syncDirectory,
  ProjectVersionFiles
} from './project-version-files.js';

const Identity = z
  .object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), tree: Digest })
  .strict();
const Record = z
  .object({
    version: z.literal(1),
    revisionId: z.uuid(),
    requestId: z.uuid(),
    archivedAt: z.iso.datetime(),
    state: z.enum(['archiving', 'archived', 'restoring', 'restored']),
    identity: Identity,
    revisionDigest: Digest
  })
  .strict();
type ArchiveRecord = z.infer<typeof Record>;
const Transaction = z
  .object({
    version: z.literal(1),
    requestId: z.uuid(),
    digest: Digest,
    completed: z.boolean(),
    versions: z
      .array(
        z
          .object({
            id: z.uuid(),
            identity: Identity,
            digest: Digest,
            previousRequestId: z.uuid().nullable()
          })
          .strict()
      )
      .min(1)
      .max(40)
  })
  .strict();
type ArchiveTransaction = z.infer<typeof Transaction>;
function conflict(message: string): never {
  throw new WorkspaceFileError(message, 409);
}
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const selection = (raw: unknown): string[] =>
  [...new Set(ProjectRetentionSelection.parse(raw).versions)].sort();

/** Keeps lineage metadata in place; only immutable version trees enter recoverable storage. */
export class ProjectRetention extends ProjectHistoryMetadata {
  constructor(
    root: string,
    projectId: string,
    readonly assertIdle: () => Promise<void>
  ) {
    super(root, projectId);
  }
  private recordFile(id: string) {
    return this.state(`retention/records/${z.uuid().parse(id)}.json`);
  }
  private source(id: string) {
    return path.join(this.directory, 'public', 'versions', z.uuid().parse(id));
  }
  private archived(id: string) {
    return this.state(`retention/content/${z.uuid().parse(id)}`);
  }
  private transactionFile(id: string) {
    return this.state(`retention/transactions/${z.uuid().parse(id)}.json`);
  }

  private async record(id: string) {
    const value = await this.read(this.recordFile(id), Record);
    if (value && value.revisionId !== id) throw new Error('Archived version identity changed.');
    return value;
  }
  async status(id: string): Promise<ProjectVersionArchive | null> {
    const record = await this.record(id);
    return record && record.state !== 'restored'
      ? {
          requestId: record.requestId,
          archivedAt: record.archivedAt,
          state: record.state
        }
      : null;
  }
  async assertAvailable(id: string): Promise<void> {
    await assertHistoryContentAvailable(this, 'version', id);
    if (await this.status(id))
      throw new WorkspaceFileError(
        'This version is archived. Restore it from project history to open its files.',
        410
      );
  }

  private async references() {
    const registry = await this.read(
      this.state('registry.json'),
      z.object({
        workspaceId: z.uuid(),
        members: z.record(z.uuid(), z.uuid()),
        head: z.uuid().nullable()
      })
    );
    if (!registry) throw new Error('Project references are unavailable.');
    const reasons = new Map<string, Set<string>>();
    const retain = (id: string | null, reason: string) => {
      if (!id) return;
      if (!reasons.has(id)) reasons.set(id, new Set());
      reasons.get(id)!.add(reason);
    };
    const facts: unknown[] = [registry];
    retain(registry.head, 'Current published version');
    const publishing = await this.read(
      this.state('publishing.json'),
      z.object({ updateId: z.uuid(), revisionId: z.uuid() })
    );
    facts.push(['publishing', publishing]);
    if (publishing) retain(publishing.revisionId, 'Publication recovery');
    for (const name of await this.names('repository-operations')) {
      const operation = await this.read(
        this.state(`repository-operations/${name}`),
        ProjectRepositoryOperation
      );
      if (!operation) throw new Error('A repository preparation reference changed.');
      facts.push(['repository', operation]);
      if (operation.state === 'preparing')
        retain(operation.input.revisionId, 'Repository preparation');
    }
    for (const name of await this.names('baselines')) {
      const baseline = await this.read(
        this.state(`baselines/${name}`),
        z.object({ revision: z.uuid().nullable(), files: Tree })
      );
      if (!baseline) throw new Error('A working-area baseline changed during inspection.');
      facts.push([name, baseline]);
      retain(baseline.revision, 'Used by a working-area baseline');
    }
    for (const name of await this.names('updates')) {
      const update = await this.read(
        this.state(`updates/${name}`),
        z.object({
          id: z.uuid(),
          projectId: z.uuid(),
          parentRevision: z.uuid().nullable(),
          state: z.enum([
            'preparing',
            'ready',
            'conflicted',
            'checking',
            'checks_failed',
            'outdated',
            'publishing',
            'published',
            'failed',
            'cancelled'
          ]),
          checks: z.array(
            z.object({
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
              ])
            })
          )
        })
      );
      if (!update || update.projectId !== this.projectId || `${update.id}.json` !== name)
        throw new Error('A project update reference cannot be verified.');
      facts.push(update);
      if (
        !['published', 'failed', 'cancelled'].includes(update.state) ||
        update.checks.some((check) => ['preparing', 'running', 'verifying'].includes(check.status))
      )
        retain(update.parentRevision, 'Used by an unfinished project update');
    }
    const pins = new ProjectVersionPins(this.state('pins'));
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await pins.page(cursor);
      for (const pin of page.pins) {
        facts.push(pin);
        retain(pin.revisionId, 'Pinned by you');
        if (++count > 10_000)
          throw new Error('Project pins exceed the maintenance inspection limit.');
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { reasons, digest: hash(facts) };
  }

  private async identity(directory: string): Promise<z.infer<typeof Identity> | null> {
    try {
      const info = await lstat(directory, { bigint: true });
      if (!info.isDirectory()) throw new Error('Version content is not a regular directory.');
      const entries: Array<[string, ...string[]]> = [];
      const visit = async (relative: string, depth: number): Promise<void> => {
        if (depth > 128 || entries.length > 100_000)
          throw new Error('Version tree exceeds the maintenance inspection limit.');
        await withWorkspaceDirectory(
          this.root,
          path.join(directory, relative),
          false,
          async (anchored) => {
            for await (const entry of await opendir(anchored)) {
              const name = path.posix.join(relative, entry.name);
              const stat = await lstat(path.join(anchored, entry.name), { bigint: true });
              if (
                (!stat.isFile() && !stat.isDirectory()) ||
                stat.uid !== BigInt(process.getuid!()) ||
                stat.mode & 0o022n
              )
                throw new Error('Version tree contains unprotected or unsupported files.');
              entries.push([
                name,
                String(stat.dev),
                String(stat.ino),
                String(stat.size),
                String(stat.mode),
                String(stat.mtimeNs)
              ]);
              if (entries.length > 100_000)
                throw new Error('Version tree exceeds the maintenance inspection limit.');
              if (stat.isDirectory()) await visit(name, depth + 1);
            }
          }
        );
      };
      await visit('', 0);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return { device: String(info.dev), inode: String(info.ino), tree: hash(entries) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async inspect(ids: string[]) {
    const references = await this.references();
    const versions: ProjectRetentionPreview['versions'] = [];
    const identities: Array<{
      id: string;
      identity: z.infer<typeof Identity> | null;
      digest: string;
      previousRequestId: string | null;
    }> = [];
    for (const id of ids) {
      const revision = await this.revision(id);
      await assertHistoryContentAvailable(this, 'version', id);
      const record = await this.record(id);
      const reasons = [...(references.reasons.get(id) ?? [])];
      if (record && record.state !== 'restored')
        reasons.push('Already archived or awaiting recovery');
      const identity = await this.identity(this.source(id));
      if (!identity && !record) throw new Error('Published version content is missing.');
      identities.push({
        id,
        identity,
        digest: revision.digest,
        previousRequestId: record?.requestId ?? null
      });
      versions.push({
        id,
        number: revision.number,
        title: revision.title,
        logicalBytes: revision.bytes,
        reasons
      });
    }
    versions.sort((a, b) => b.number - a.number || a.id.localeCompare(b.id));
    const preview: ProjectRetentionPreview = {
      digest: hash({
        projectId: this.projectId,
        references: references.digest,
        versions,
        identities
      }),
      observedAt: new Date().toISOString(),
      versions,
      logicalBytes: versions.reduce((sum, version) => sum + version.logicalBytes, 0),
      reclaimedBytes: 0
    };
    return { preview, identities };
  }
  async preview(raw: unknown): Promise<ProjectRetentionPreview> {
    const ids = selection(raw);
    return withProjectReference(this.root, this.projectId, 'read', async () => {
      const { preview } = await this.inspect(ids);
      try {
        await this.assertIdle();
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'Running-work protection cannot be verified.';
        for (const version of preview.versions) version.reasons.push(reason);
      }
      return preview;
    });
  }
  private result(transaction: ArchiveTransaction): ProjectRetentionResult {
    return {
      requestId: transaction.requestId,
      versions: transaction.versions.map((version) => version.id),
      completed: transaction.completed,
      reclaimedBytes: 0
    };
  }
  async archive(raw: unknown): Promise<ProjectRetentionResult> {
    const input = ProjectRetentionApply.parse(raw),
      ids = selection({ versions: input.versions });
    const filename = this.transactionFile(input.requestId);
    const verifyRequest = (transaction: ArchiveTransaction) => {
      if (
        transaction.requestId !== input.requestId ||
        transaction.digest !== input.digest ||
        hash(transaction.versions.map((version) => version.id)) !== hash(ids)
      )
        conflict('Archive request identity changed. Review a new preview.');
    };
    // A completed receipt is immutable. Reading it must not interrupt work admitted afterward.
    const recorded = await this.read(filename, Transaction);
    if (recorded) {
      verifyRequest(recorded);
      if (recorded.completed) return this.result(recorded);
    }
    return withProjectReference(this.root, this.projectId, 'write', async () => {
      let transaction = await this.read(filename, Transaction);
      if (transaction) {
        verifyRequest(transaction);
        if (transaction.completed) return this.result(transaction);
      }
      await this.assertIdle();
      if (!transaction) {
        const inspected = await this.inspect(ids);
        if (inspected.preview.digest !== input.digest)
          conflict('Project history changed. Review a fresh archive preview.');
        if (inspected.preview.versions.some((version) => version.reasons.length))
          conflict('Selected versions are still in use or pinned.');
        transaction = Transaction.parse({
          version: 1,
          requestId: input.requestId,
          digest: input.digest,
          completed: false,
          versions: inspected.identities
        });
        await durableJson(filename, transaction);
      }
      const references = await this.references();
      for (const version of transaction.versions) {
        if (references.reasons.has(version.id))
          conflict(
            'Selected history acquired a new reference. Restore or review it before retrying.'
          );
        const existing = await this.record(version.id);
        if (
          (existing &&
            existing.requestId !== input.requestId &&
            (existing.state !== 'restored' || existing.requestId !== version.previousRequestId)) ||
          (!existing && version.previousRequestId !== null)
        )
          conflict('A different archive operation owns this version. Review a new preview.');
        if (
          existing?.requestId === input.requestId &&
          ['restoring', 'restored'].includes(existing.state)
        )
          conflict('This archive was restored. Review a new preview to archive it again.');
        if ((await this.revision(version.id)).digest !== version.digest)
          conflict('Version metadata changed after the archive preview.');
      }
      for (const version of transaction.versions) {
        let record = await this.record(version.id);
        if (!record || record.requestId !== input.requestId) {
          record = {
            version: 1,
            revisionId: version.id,
            requestId: input.requestId,
            archivedAt: new Date().toISOString(),
            state: 'archiving',
            identity: version.identity,
            revisionDigest: version.digest
          };
          await durableJson(this.recordFile(version.id), record);
        }
        await this.move(record, 'archive');
      }
      transaction.completed = true;
      await durableJson(filename, transaction);
      return this.result(transaction);
    });
  }
  private async move(record: ArchiveRecord, direction: 'archive' | 'restore') {
    const source =
      direction === 'archive' ? this.source(record.revisionId) : this.archived(record.revisionId);
    const target =
      direction === 'archive' ? this.archived(record.revisionId) : this.source(record.revisionId);
    const [before, after] = await Promise.all([this.identity(source), this.identity(target)]);
    if ((before && after) || (!before && !after) || hash(before ?? after) !== hash(record.identity))
      conflict(
        'Version content changed or its destination is occupied. No files were overwritten.'
      );
    if (before) {
      await durableMkdir(path.dirname(target), direction === 'archive' ? 0o700 : 0o755);
      await moveVersionDirectory(this.root, source, target);
      await syncDirectory(path.dirname(source));
      await syncDirectory(path.dirname(target));
    }
    record.state = direction === 'archive' ? 'archived' : 'restored';
    await durableJson(this.recordFile(record.revisionId), record);
  }
  async restore(revisionId: string, requestId: string): Promise<void> {
    z.uuid().parse(requestId);
    return withProjectReference(this.root, this.projectId, 'read', async () => {
      // Restoring only adds an absent public tree. Keep destructive maintenance out while
      // allowing existing input readers, and serialize recovery on private metadata instead.
      const directory = this.state('retention');
      await durableMkdir(directory, 0o700);
      const recovery = await acquireDirectoryReference(
        this.root,
        directory,
        'write',
        'Another version is being restored. Try again shortly.'
      );
      try {
        await assertHistoryContentAvailable(this, 'version', revisionId);
        const record = await this.record(revisionId);
        if (!record || record.requestId !== requestId)
          conflict('The archived version changed. Refresh project history.');
        if (record.state === 'restored') return;
        const revision = await this.revision(revisionId);
        if (revision.digest !== record.revisionDigest)
          conflict('Archived version metadata changed.');
        const source = (await this.identity(this.archived(revisionId)))
          ? this.archived(revisionId)
          : this.source(revisionId);
        if (!(await new ProjectVersionFiles(this.state('content')).matches(source, revision.files)))
          conflict('Archived file contents failed verification. No files were restored.');
        record.state = 'restoring';
        await durableJson(this.recordFile(revisionId), record);
        await this.move(record, 'restore');
      } finally {
        await recovery.release();
      }
    });
  }
}
