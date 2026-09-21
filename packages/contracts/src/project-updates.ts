import type { ProjectContentRemoval } from './project-purge.js';
import type { ProcessResourceSample } from './processes.js';
import type { ProjectVersionArchive } from './project-retention.js';
import { z } from 'zod';

const ProjectPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.split('/').includes('..'),
    'Use a relative project path'
  );
export const ProjectCheckCommand = z
  .object({
    name: z.string().trim().min(1).max(120),
    executable: z.string().min(1).max(4096),
    args: z.array(z.string().max(100_000)).max(8192).default([]),
    cwd: ProjectPath.default('workspace')
  })
  .strict();
export type ProjectCheckCommand = z.infer<typeof ProjectCheckCommand>;

export const PrepareProjectUpdate = z
  .object({
    title: z.string().trim().min(1).max(160),
    paths: z.array(ProjectPath).min(1).max(1024),
    deletePaths: z.array(ProjectPath).max(1024).default([]),
    checks: z.array(ProjectCheckCommand).max(32).default([]),
    resolvedPaths: z.array(ProjectPath).max(1024).default([]),
    expectedRevision: z.uuid().optional()
  })
  .strict()
  .refine(
    (value) => !value.resolvedPaths.length || Boolean(value.expectedRevision),
    'Conflict resolutions must name the published version they were resolved against'
  );
export type PrepareProjectUpdate = z.infer<typeof PrepareProjectUpdate>;

const Identity = z.object({ updateId: z.uuid() });
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ProjectUpdateAction = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('status'),
      updateId: z.uuid().optional(),
      before: z.uuid().optional(),
      revisionsBefore: z.uuid().optional(),
      changesAfter: ProjectPath.optional(),
      includeDiff: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('prepare'),
      requestId: z.uuid(),
      sourceTaskId: z.uuid().optional(),
      update: PrepareProjectUpdate
    })
    .strict(),
  Identity.extend({ action: z.literal('rebase'), requestId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal('checkout'),
      paths: z.array(ProjectPath).min(1).max(1024),
      revisionId: z.uuid().optional()
    })
    .strict(),
  Identity.extend({ action: z.literal('check'), checkId: z.uuid(), digest: Digest }).strict(),
  Identity.extend({ action: z.literal('log'), checkId: z.uuid() }).strict(),
  Identity.extend({ action: z.literal('stop'), checkId: z.uuid() }).strict(),
  Identity.extend({ action: z.literal('cancel') }).strict(),
  Identity.extend({
    action: z.literal('publish'),
    digest: Digest,
    uncheckedReason: z.string().trim().min(1).max(600).optional()
  }).strict()
]);
export type ProjectUpdateAction = z.infer<typeof ProjectUpdateAction>;

export const ProjectVersionPinInput = z
  .object({ label: z.string().trim().max(120).nullable() })
  .strict();
export type ProjectVersionPinInput = z.infer<typeof ProjectVersionPinInput>;
export const PinnedProjectVersionCursor = z
  .string()
  .regex(
    /^[0-9]{16}_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i
  );
export interface ProjectVersionPin {
  label: string;
  createdAt: string;
}
export interface PinnedProjectVersions {
  revisions: ProjectRevision[];
  nextCursor: string | null;
}

export interface ProjectFileVersion {
  sha256: string;
  bytes: number;
  executable: boolean;
}
export interface ProjectFileChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  base: ProjectFileVersion | null;
  current: ProjectFileVersion | null;
  proposed: ProjectFileVersion | null;
  result: ProjectFileVersion | null;
  conflict: boolean;
  merged: boolean;
  detail: string | null;
  diff: string | null;
  lines?: { added: number; removed: number } | null;
}
export interface ProjectCheck extends ProjectCheckCommand {
  contentRemoval?: ProjectContentRemoval | null;
  id: string;
  status:
    | 'pending'
    | 'preparing'
    | 'running'
    | 'verifying'
    | 'passed'
    | 'failed'
    | 'interrupted'
    | 'invalidated'
    | 'cancelled';
  startedAt: string | null;
  finishedAt: string | null;
  ranForMs: number;
  exitCode: number | null;
  detail: string | null;
  candidateDigest: string;
  sessionId: string | null;
  resources?: ProcessResourceSample;
  preparation?: { files: number; bytes: number; totalFiles: number; totalBytes: number };
}
export interface ProjectUpdate {
  contentRemoval?: ProjectContentRemoval | null;
  id: string;
  projectId: string;
  taskId: string;
  sourceWorkspaceId: string;
  title: string;
  state:
    | 'preparing'
    | 'ready'
    | 'conflicted'
    | 'checking'
    | 'checks_failed'
    | 'outdated'
    | 'published'
    | 'failed'
    | 'cancelled';
  parentRevision: string | null;
  candidateDigest: string | null;
  path: string | null;
  changes: ProjectFileChange[];
  changeCount: number;
  lineChanges?: { added: number; removed: number; unmeasuredFiles: number };
  nextChange: string | null;
  checks: ProjectCheck[];
  progress: { files: number; bytes: number; stage: string };
  createdAt: string;
  updatedAt: string;
  publishedRevision: string | null;
  detail: string | null;
  uncheckedReason: string | null;
}
export interface ProjectRevision {
  contentRemoval?: ProjectContentRemoval | null;
  id: string;
  number: number;
  parentId: string | null;
  updateId: string;
  taskId: string;
  title: string;
  digest: string;
  fileCount: number;
  bytes: number;
  createdAt: string;
  path: string;
  checks: ProjectCheck[];
  uncheckedReason: string | null;
  pin?: ProjectVersionPin | null;
  archive?: ProjectVersionArchive | null;
}
export interface ProjectUpdates {
  head: ProjectRevision | null;
  updates: ProjectUpdate[];
  revisions: ProjectRevision[];
  nextCursor: string | null;
  nextRevisionCursor: string | null;
  observedAt: string;
}

export interface ConversationChanges {
  taskId: string;
  status: 'queued' | 'measuring' | 'ready' | 'unavailable';
  measurement: {
    observedAt: string;
    baselineRevision: string | null;
    added: number;
    removed: number;
    changedFiles: number;
    unmeasuredFiles: number;
    scannedFiles: number;
    truncated: boolean;
  } | null;
}
