import { z } from 'zod';

export const ProjectPurgeSelection = z
  .object({
    versions: z.array(z.uuid()).max(40).default([]),
    updates: z.array(z.uuid()).max(40).default([]),
    checks: z.array(z.uuid()).max(40).default([])
  })
  .strict()
  .refine((value) => {
    const count = value.versions.length + value.updates.length + value.checks.length;
    return count > 0 && count <= 40;
  }, 'Select one to forty history items');
export type ProjectPurgeSelection = z.infer<typeof ProjectPurgeSelection>;
export const ProjectPurgeApply = z
  .object({
    selection: ProjectPurgeSelection,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.uuid()
  })
  .strict();
export type ProjectPurgeApply = z.infer<typeof ProjectPurgeApply>;
export type ProjectContentKind = 'version' | 'update' | 'check';
export interface ProjectContentRemoval {
  requestId: string;
  state: 'removing' | 'removed';
  startedAt: string;
  completedAt: string | null;
}
export interface ProjectPurgePreview {
  digest: string;
  observedAt: string;
  items: Array<{
    kind: ProjectContentKind;
    id: string;
    title: string;
    logicalBytes: number;
    reasons: string[];
  }>;
  logicalBytes: number;
  estimatedFreedBytes: number;
  sharedObjectsRemoved: number;
  sharedObjectsRetained: number;
}
export interface ProjectPurgeResult extends ProjectContentRemoval {
  digest: string;
  running: boolean;
  detail: string | null;
  selection: ProjectPurgeSelection;
  logicalBytes: number;
  estimatedFreedBytes: number;
  removedPaths: number;
}
