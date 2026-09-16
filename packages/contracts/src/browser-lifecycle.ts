import { z } from 'zod';

export const BrowserTabState = z.object({
  tabId: z.string(),
  title: z.string(),
  url: z.string(),
  active: z.boolean(),
  owner: z.enum(['agent', 'user']),
  taskId: z.string().nullable(),
  pinned: z.boolean(),
  lastUsedAt: z.string(),
  protectedReason: z.enum(['active', 'owner', 'pinned', 'download', 'dialog', 'control']).nullable()
});
export type BrowserTabState = z.infer<typeof BrowserTabState>;

export const BrowserTabCleanup = z.object({
  closed: z.number().int().nonnegative(),
  lastClosedAt: z.string().nullable()
});
export type BrowserTabCleanup = z.infer<typeof BrowserTabCleanup>;

export const BrowserTabRetentionRequest = z.object({ pinned: z.boolean() });
export type BrowserTabRetentionRequest = z.infer<typeof BrowserTabRetentionRequest>;

export const BrowserRecoveredTab = z.object({
  tabId: z.string().max(100),
  url: z.string().max(2000),
  title: z.string().max(500),
  lastSeenAt: z.string().datetime()
});
export type BrowserRecoveredTab = z.infer<typeof BrowserRecoveredTab>;
export interface BrowserRecovery {
  tabs: BrowserRecoveredTab[];
  omitted: number;
  unavailable?: boolean;
  note: string;
}
