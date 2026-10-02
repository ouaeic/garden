import { z } from 'zod';

export const WorkDirection = z.object({
  eventId: z.string(),
  messageId: z.string().max(240).optional(),
  sequence: z.number().int(),
  text: z.string(),
  truncated: z.boolean(),
  queued: z.boolean()
});
export const WorkSurfaceView = z.object({
  direction: WorkDirection.nullable(),
  directions: z.array(WorkDirection),
  currentResultIds: z.array(z.string()),
  sources: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      eventId: z.string(),
      sequence: z.number().int(),
      state: z.enum(['discovered', 'read'])
    })
  )
});
export type WorkSurfaceView = z.infer<typeof WorkSurfaceView>;
