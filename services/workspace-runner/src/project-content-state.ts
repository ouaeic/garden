import { z } from 'zod';
import type { ProjectContentKind } from '@garden/contracts';
import { WorkspaceFileError } from './files.js';
import type { ProjectHistoryMetadata } from './project-history-metadata.js';

export const ContentRemovalRecord = z
  .object({
    version: z.literal(1),
    kind: z.enum(['version', 'update', 'check']),
    id: z.uuid(),
    requestId: z.uuid(),
    state: z.enum(['removing', 'removed']),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable()
  })
  .strict();
export type ContentRemovalRecord = z.infer<typeof ContentRemovalRecord>;
export const contentRemovalFile = (
  metadata: ProjectHistoryMetadata,
  kind: ProjectContentKind,
  id: string
) => metadata.state(`purge/records/${kind}/${z.uuid().parse(id)}.json`);
export async function contentRemoval(
  metadata: ProjectHistoryMetadata,
  kind: ProjectContentKind,
  id: string
) {
  const record = await metadata.read(contentRemovalFile(metadata, kind, id), ContentRemovalRecord);
  if (record && (record.id !== id || record.kind !== kind))
    throw Error('History removal identity changed.');
  return record;
}
export async function assertHistoryContentAvailable(
  metadata: ProjectHistoryMetadata,
  kind: ProjectContentKind,
  id: string
) {
  const record = await contentRemoval(metadata, kind, id);
  if (record)
    throw new WorkspaceFileError(
      record.state === 'removed'
        ? 'These history files were permanently removed. Their receipt remains available.'
        : 'These history files are being removed. Resume the saved cleanup to finish.',
      410
    );
}
