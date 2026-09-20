import { z } from 'zod';

export const ProjectRetentionSelection = z
  .object({ versions: z.array(z.uuid()).min(1).max(40) })
  .strict();
export type ProjectRetentionSelection = z.infer<typeof ProjectRetentionSelection>;
export const ProjectRetentionApply = ProjectRetentionSelection.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.uuid()
}).strict();
export type ProjectRetentionApply = z.infer<typeof ProjectRetentionApply>;

export interface ProjectRetentionPreview {
  digest: string;
  observedAt: string;
  versions: Array<{
    id: string;
    number: number;
    title: string;
    logicalBytes: number;
    reasons: string[];
  }>;
  logicalBytes: number;
  reclaimedBytes: 0;
}

export interface ProjectVersionArchive {
  requestId: string;
  archivedAt: string;
  state: 'archiving' | 'archived' | 'restoring';
}

export interface ProjectRetentionResult {
  requestId: string;
  versions: string[];
  completed: boolean;
  reclaimedBytes: 0;
}
