import { z } from 'zod';
import { TaskDeal } from './deal.js';

const Id = z.uuid();
const IsoDate = z.iso.datetime();
const SideEffect = z.enum([
  'read',
  'workspace_write',
  'external_reversible',
  'external_consequential'
]);
const Waiting = { taskId: Id, taskTitle: z.string(), at: IsoDate };

/**
 * Everything waiting on the owner, across every conversation, as one typed list.
 *
 * Typed so any surface - the desk, a lock screen, a chat - can render and answer each one in a
 * tap: a deal is planted with `/deal`, a question or a handoff is answered with `/answer`, an
 * approval with `/approvals/:id/approve|deny`, and a spend pause by raising the conversation's
 * ceiling and resuming it.
 */
export const OwnerMove = z.discriminatedUnion('kind', [
  z.object({ ...Waiting, kind: z.literal('deal'), questionId: Id, deal: TaskDeal }),
  z.object({
    ...Waiting,
    kind: z.literal('question'),
    questionId: Id,
    question: z.string(),
    why: z.string().optional(),
    options: z.array(z.string())
  }),
  z.object({
    ...Waiting,
    kind: z.literal('handoff'),
    questionId: Id,
    question: z.string(),
    url: z.string().optional()
  }),
  z.object({
    ...Waiting,
    kind: z.literal('approval'),
    approvalId: Id,
    action: z.string(),
    detail: z.string(),
    tool: z.string(),
    sideEffect: SideEffect,
    expiresAt: IsoDate,
    /** Present when approving can also cover the rest of this run, described in words. */
    runGrant: z.string().optional()
  }),
  z.object({
    ...Waiting,
    kind: z.literal('spend'),
    spentUsd: z.number().nonnegative(),
    maxSpendUsd: z.number().nonnegative().nullable()
  })
]);
export type OwnerMove = z.infer<typeof OwnerMove>;

/**
 * One thing that left this computer, or was asked to: a card the owner answered, an action a lent
 * key allowed, or a connected service's write.
 */
export const RecordEntry = z.object({
  id: z.string(),
  at: IsoDate,
  taskId: Id.nullable(),
  taskTitle: z.string().nullable(),
  action: z.string(),
  detail: z.string(),
  tool: z.string(),
  source: z.enum(['card', 'key', 'connector']),
  verdict: z.enum(['waiting', 'approved', 'denied', 'expired', 'succeeded', 'failed', 'refused']),
  sideEffect: SideEffect.optional()
});
export type RecordEntry = z.infer<typeof RecordEntry>;
