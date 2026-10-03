/** What a step with no tool calls means: an answer, a reply cut off, or one to continue. */
import type { ModelResponse } from '@garden/model-gateway';
import type { TaskRecord } from '@garden/data';
import type { AgentState } from '../agent-state.js';
import { event } from '../tool-recording.js';
import { MAX_TRUNCATED_CONTINUATIONS } from '../turn-bounds.js';
import { completeAnswer, type TurnCompleteDeps } from './complete.js';

/**
 * `continue` sends the model round again, `completed` ends the turn (answered, parked or stopped),
 * `proceed` means the step has tool calls to run.
 */
export type AnswerHold = 'continue' | 'completed' | 'proceed';

export const resolveAnswerHolds = async (
  deps: TurnCompleteDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  step: { response: ModelResponse; assistantText: string }
): Promise<AnswerHold> => {
  const { response, assistantText } = step;
  if (response.toolCalls.length) {
    state.truncatedReplies = 0;
    return 'proceed';
  }
  if (response.finishReason === 'length') {
    const truncations = (state.truncatedReplies ?? 0) + 1;
    state.truncatedReplies = truncations;
    const capped = truncations > MAX_TRUNCATED_CONTINUATIONS;
    await event(
      deps.store,
      task,
      key,
      'warning',
      capped
        ? 'The reply reached the model’s output limit again, so it was not continued automatically'
        : 'The reply reached the model’s output limit and is being continued',
      {
        ...(capped ? { owner: true } : {}),
        truncated: true,
        characters: assistantText.length,
        continuation: truncations,
        continued: !capped
      }
    );
    const sofar = `${state.continuedAnswer ?? ''}${assistantText}`;
    if (capped) {
      delete state.continuedAnswer;
      await deps.completeTurn(task, key, state, {
        summary: sofar.slice(0, 400) || 'Stopped at the model’s output limit.',
        ...(sofar ? { answer: sofar } : {}),
        interrupted: true,
        verification: {
          status: 'not_applicable',
          evidence: [],
          remainingRisks: [
            'The model repeatedly reached its output limit, so this answer may be incomplete. Reply to continue or choose another model.'
          ]
        }
      });
      return 'completed';
    }
    if (sofar) state.continuedAnswer = sofar;
    state.messages.push({
      role: 'system',
      content: assistantText
        ? `CONTINUE (${truncations} of ${MAX_TRUNCATED_CONTINUATIONS}): your reply stopped at the output limit. Carry straight on from where it stopped without repeating it.`
        : `CONTINUE (${truncations} of ${MAX_TRUNCATED_CONTINUATIONS}): the output limit was reached before any answer or tool call. Reply concisely or take the next action.`
    });
    return 'continue';
  }
  state.truncatedReplies = 0;
  if (response.truncated)
    await event(deps.store, task, key, 'warning', 'The answer was cut off before it finished', {
      owner: true,
      reason: response.truncated.reason,
      detail: response.truncated.detail,
      characters: assistantText.length
    });
  const answer = `${state.continuedAnswer ?? ''}${assistantText}`;
  delete state.continuedAnswer;
  const outcome = await completeAnswer(deps, task, key, state, answer);
  return outcome === 'continue' ? 'continue' : 'completed';
};
