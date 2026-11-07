import { z } from 'zod';

/**
 * The two labels a delivered reply closes with.
 *
 * Owned here because two packages are held to them at once: the worker's operating contract asks
 * the model to end with them, and the API reads them back off the reply to build the cover note.
 * Reworded on one side only, every reply would keep its verdict inside its answer and nothing would
 * fail to say so.
 */
export const VERDICT_LABELS = { checked: 'Checked', yourCall: 'Your call' } as const;

/** How many conversations one outcomes read may name. */
export const MAX_OUTCOME_IDS = 24;
export const OUTCOME_ANSWER_CHARS = 4_000;
export const OUTCOME_HEADLINE_CHARS = 200;
export const OUTCOME_ITEM_CHARS = 240;
export const OUTCOME_ITEMS = 8;
export const OUTCOME_FILES = 6;
export const OUTCOME_PREVIEWS = 6;

const Item = z.string().max(OUTCOME_ITEM_CHARS);

/**
 * A finished goal as its result and the note that travels with it, for judging at a glance.
 *
 * Every field is read from what the run already recorded - its last reply, the completion that
 * closed it, what it published - so nothing here costs a model call or can disagree with the
 * conversation it came from. A reply from an earlier direction than the one being worked now is
 * not this run's result, so a follow-up still in progress has no reply yet; what the goal published
 * along the way is listed either way.
 */
export const TaskOutcome = z.object({
  taskId: z.string(),
  /** The final reply with its closing Checked / Your call block taken out. */
  answer: z.string().max(OUTCOME_ANSWER_CHARS).nullable(),
  /** The reply's first sentence, as plain text. */
  headline: z.string().max(OUTCOME_HEADLINE_CHARS).nullable(),
  checked: z.array(Item).max(OUTCOME_ITEMS),
  yourCall: z.array(Item).max(OUTCOME_ITEMS),
  /** The status the completion that closed this reply recorded; null while nothing has closed it. */
  verification: z.string().nullable(),
  risks: z.array(Item).max(OUTCOME_ITEMS),
  files: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        mimeType: z.string(),
        sizeBytes: z.number().int().nonnegative(),
        version: z.number().int().positive(),
        createdAt: z.string()
      })
    )
    .max(OUTCOME_FILES),
  previews: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        port: z.number().int().optional(),
        createdAt: z.string().optional()
      })
    )
    .max(OUTCOME_PREVIEWS),
  /** When the reply used was recorded. */
  at: z.string().nullable()
});
export type TaskOutcome = z.infer<typeof TaskOutcome>;

export const TaskOutcomes = z.object({ outcomes: z.array(TaskOutcome).max(MAX_OUTCOME_IDS) });
export type TaskOutcomes = z.infer<typeof TaskOutcomes>;
