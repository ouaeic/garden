import { z } from 'zod';
import {
  DecisionInput,
  DecisionQuestion,
  validateDecisionInput,
  type DecisionInput as Input
} from '@athanor/model-gateway';
import type { AgentState } from './agent-state.js';

/** References only reach text already present in this conversation's model-visible window. */
export const DecisionToolInput = z
  .object({
    sources: z
      .array(z.string().min(1).max(160))
      .min(1)
      .max(8)
      .optional()
      .describe(
        'Evidence references; defaults to ["$request"]. Use tool-call IDs for prior results.'
      ),
    choices: DecisionQuestion.options[0].shape.criteria
      .optional()
      .describe('Shared choice meanings for questions written as strings.'),
    questions: z.record(
      z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
      z.union([z.string().min(1).max(6000), DecisionQuestion])
    ),
    context: DecisionInput.shape.state
      .optional()
      .describe('New context only. Existing evidence belongs in sources; do not copy it here.')
  })
  .strict();

export function resolveDecisionInput(state: AgentState, value: unknown): Input {
  const input = DecisionToolInput.parse(value);
  const sources = input.sources ?? ['$request'];
  const evidence = sources.map((id) => {
    const message = [...state.messages]
      .reverse()
      .find((entry) =>
        id === '$request' ? entry.role === 'user' : entry.role === 'tool' && entry.toolCallId === id
      );
    if (!message?.content)
      throw new Error(
        `Decision evidence ${id} is no longer in the working context. Read the relevant evidence again or supply a concise state.`
      );
    return { id, text: message.content };
  });
  const questions: Input['questions'] = {};
  for (const [id, question] of Object.entries(input.questions)) {
    if (typeof question === 'string') {
      if (!input.choices) throw new Error('String questions need shared choices.');
      questions[id] = { type: 'choice', instructions: question, criteria: input.choices };
    } else questions[id] = question;
  }
  const text = JSON.stringify({ evidence, ...(input.context ? { context: input.context } : {}) });
  return validateDecisionInput({ state: text, questions });
}
