import { z } from 'zod';

/**
 * The deal: what the agent proposes before substantial work, and what the owner plants.
 *
 * It travels as a parked question (`question_asked` with a `deal` payload) so every surface that
 * can answer a question can answer a deal, and a scheduled run, which has nobody to ask, never
 * proposes one. Planting it lends the keys, sets each goal's cap and answers the question with the
 * agreed terms in words, which is how the model reads them.
 */
export const DEAL_MAX_GOALS = 4;
export const DEAL_MAX_QUESTIONS = 6;

/** The first words of every prompt that carries agreed terms; the worker refuses a second deal. */
export const AGREED_DEAL_MARKER = 'Deal agreed.';

const Line = (max: number) => z.string().trim().min(1).max(max);

export const DealGoal = z
  .object({
    title: Line(80),
    outcome: Line(240),
    doneWhen: Line(240),
    /** The model's honest estimate in the owner's words, e.g. "about 2 days". */
    estimate: Line(60).optional(),
    /** Present when the goal recurs, e.g. "Mondays and Thursdays until an offer is accepted". */
    rhythm: Line(100).optional(),
    capUsd: z.number().positive().max(1_000)
  })
  .strict();
export type DealGoal = z.infer<typeof DealGoal>;

export const DealQuestion = z
  .object({
    question: Line(160),
    options: z.array(Line(60)).min(2).max(4)
  })
  .strict();
export type DealQuestion = z.infer<typeof DealQuestion>;

export const TaskDeal = z
  .object({
    summary: Line(200),
    goals: z.array(DealGoal).min(1).max(DEAL_MAX_GOALS),
    questions: z.array(DealQuestion).max(DEAL_MAX_QUESTIONS),
    /** Whether the work needs to send, submit or book as the owner. */
    actAsYou: z.boolean()
  })
  .strict();
export type TaskDeal = z.infer<typeof TaskDeal>;

export const PlantDealRequest = z
  .object({
    questionId: z.uuid(),
    /** One per question, in order; an empty answer means "take the safe choice". */
    answers: z.array(z.string().trim().max(200)).max(DEAL_MAX_QUESTIONS),
    /** Which proposed goals to plant, by index. The first one continues in this conversation. */
    goals: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(DEAL_MAX_GOALS - 1)
      )
      .min(1)
      .max(DEAL_MAX_GOALS),
    actAsYou: z.boolean(),
    /** The keys beyond acting as you that the planted goals may use; absent keeps the standing set. */
    keys: z
      .array(z.enum(['spend', 'publish', 'remove', 'rules']))
      .max(4)
      .optional(),
    /** Per planted goal, in the order of `goals`. */
    capsUsd: z.array(z.number().positive().max(1_000)).min(1).max(DEAL_MAX_GOALS),
    note: z.string().trim().max(2_000).optional()
  })
  .strict()
  .refine((input) => input.capsUsd.length === input.goals.length, {
    message: 'Give one cap per planted goal'
  })
  .refine((input) => new Set(input.goals).size === input.goals.length, {
    message: 'Plant each goal once'
  });
export type PlantDealRequest = z.infer<typeof PlantDealRequest>;

export const PlantDealResponse = z.object({ taskIds: z.array(z.uuid()).min(1) }).strict();
export type PlantDealResponse = z.infer<typeof PlantDealResponse>;

const KEY_WORDS: Record<string, string> = {
  spend: 'paid media and other spending within the cap',
  publish: 'publishing and deploying',
  remove: 'deleting outside an undo point',
  rules: 'schedules, memory, skills and services'
};

const answered = (question: DealQuestion, answer: string | undefined) =>
  `- ${question.question} ${answer?.trim() || 'No answer: take the safe choice.'}`;

/** The agreed terms for one goal, in the words the model reads. */
export const agreedDealText = (input: {
  deal: TaskDeal;
  goal: DealGoal;
  answers: readonly string[];
  actAsYou: boolean;
  capUsd: number;
  keys?: readonly string[];
  alongside?: readonly string[];
  plantedFrom?: string;
  request?: string;
  note?: string;
}): string =>
  [
    AGREED_DEAL_MARKER,
    `Goal: ${input.goal.title}. ${input.goal.outcome}`,
    `Done when: ${input.goal.doneWhen}`,
    ...(input.goal.rhythm ? [`Rhythm: ${input.goal.rhythm}`] : []),
    ...(input.deal.questions.length
      ? ['Answers:', ...input.deal.questions.map((q, i) => answered(q, input.answers[i]))]
      : []),
    `Keys: ${input.actAsYou ? 'act as me (send, submit, book) within this goal' : 'do not send, submit or book as me; ask first'}. Spend up to $${input.capUsd.toFixed(2)} on this goal.`,
    ...(input.keys?.length
      ? [`Also lent without asking: ${input.keys.map((key) => KEY_WORDS[key] ?? key).join('; ')}.`]
      : []),
    ...(input.alongside?.length
      ? [`Planted alongside as separate goals, not yours to do: ${input.alongside.join('; ')}.`]
      : []),
    ...(input.plantedFrom ? [`Planted from the conversation "${input.plantedFrom}".`] : []),
    ...(input.note ? [`Owner's note: ${input.note}`] : []),
    ...(input.request ? ['', 'The original request:', input.request] : [])
  ].join('\n');
