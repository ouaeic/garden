import { z } from 'zod';

export const ProjectStorageUsage = z.object({
  observedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  complete: z.boolean(),
  scannedEntries: z.number().int().nonnegative(),
  fileReferences: z.number().int().nonnegative(),
  uniqueFiles: z.number().int().nonnegative(),
  logicalBytes: z.number().int().nonnegative().safe(),
  allocatedBytes: z.number().int().nonnegative().safe(),
  sharedCopies: z.number().int().nonnegative(),
  skippedEntries: z.number().int().nonnegative(),
  limited: z.boolean(),
  changedDuringScan: z.boolean(),
  reclaimableBytes: z.null()
});
export type ProjectStorageUsage = z.infer<typeof ProjectStorageUsage>;
