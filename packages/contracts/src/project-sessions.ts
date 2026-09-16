import { z } from 'zod';
import type { BrowserTabState } from './browser-lifecycle.js';

/** One completed human gesture; never part of the agent action catalogue. */
export const OwnerStroke = z
  .object({
    points: z
      .array(
        z
          .object({
            x: z.number().finite().min(0).max(32768),
            y: z.number().finite().min(0).max(32768)
          })
          .strict()
      )
      .min(2)
      .max(2048),
    generation: z.number().int().nonnegative().optional(),
    tabId: z.string().max(64).optional()
  })
  .strict();
export type OwnerStroke = z.infer<typeof OwnerStroke>;
export interface ComputerSessions {
  browser: { holder: string; tabs: BrowserTabState[] } | null;
  desktop: {
    holder: string;
    windows: Array<{ id: string; name: string; role: string }>;
    activeApplication: string;
  } | null;
}
export interface ProjectSessions {
  sessions: Array<ComputerSessions & { workspaceId: string; taskId: string; title: string }>;
  unavailableWorkspaces: number;
  observedAt: string;
}
