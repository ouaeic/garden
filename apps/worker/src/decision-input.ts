import { z } from 'zod';
import {
  DecisionInput,
  validateDecisionInput,
  type DecisionInput as Input
} from '@athanor/model-gateway';
import type { AgentState } from './agent-state.js';

/** References only reach text already present in this conversation's model-visible window. */
export const DecisionToolInput = z
  .object({
    state: DecisionInput.shape.state.optional(),
    sources: z.array(z.string().min(1).max(160)).min(1).max(8).optional(),
    questions: DecisionInput.shape.questions
  })
  .strict();

export function resolveDecisionInput(state: AgentState, value: unknown): Input {
  const input = DecisionToolInput.parse(value);
  const sources = input.sources ?? (input.state ? [] : ['$request']);
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
  const text = evidence.length
    ? JSON.stringify({ evidence, ...(input.state ? { context: input.state } : {}) })
    : input.state!;
  return validateDecisionInput({ state: text, questions: input.questions });
}
