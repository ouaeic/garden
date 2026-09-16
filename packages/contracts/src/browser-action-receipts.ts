import { z } from 'zod';

export const BrowserActionReceipt = z.object({
  requestId: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['started', 'completed', 'uncertain']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  steps: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      type: z.string(),
      status: z.enum(['started', 'completed'])
    })
  ),
  result: z.unknown().optional()
});
export type BrowserActionReceipt = z.infer<typeof BrowserActionReceipt>;
