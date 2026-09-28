/** Bounded recovery for responses that contain no tool calls. */
import type { ModelResponse } from '@garden/model-gateway';
import type { TaskRecord } from '@garden/data';
import type { AgentState } from '../agent-state.js';
import { event } from '../tool-recording.js';
import { MAX_COMPLETION_NAGS, MAX_TRUNCATED_CONTINUATIONS } from '../turn-bounds.js';
import type { StepBoundsDeps } from './step-bounds.js';

/**
 * `continue` sends the model round again, `completed` ends the turn, `proceed` means the step has
 * tool calls to run.
 */
export type AnswerHold = 'continue' | 'completed' | 'proceed';

/** A stopped answer retains its transcript and reports unchecked work explicitly. */
const endIncompleteAnswer = async (
  deps: StepBoundsDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  summary: string,
  risk: string
): Promise<void> => {
  const stillOpen = await deps.outstandingPlanSteps(task, key).catch(() => []);
  await deps.completeTurn(task, key, state, {
    summary,
    interrupted: true,
    ...(stillOpen.length ? { outstanding: stillOpen } : {}),
    verification: { status: 'not_applicable', evidence: [], remainingRisks: [risk] }
  });
};

export const resolveAnswerHolds = async (
  deps: StepBoundsDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  step: { response: ModelResponse; assistantText: string }
): Promise<AnswerHold> => {
  const { response, assistantText } = step;
  // A tool call must be followed by its result before another system message can be added.
  if (response.truncated && response.finishReason !== 'length' && !response.toolCalls.length) {
    await event(deps.store, task, key, 'warning', 'The answer was cut off before it finished', {
      owner: true,
      reason: response.truncated.reason,
      detail: response.truncated.detail,
      characters: assistantText.length
    });
    state.messages.push({
      role: 'system',
      content: `YOUR REPLY WAS CUT OFF: ${response.truncated.detail}. The user has already read what you wrote, so do not repeat or summarise it. Either do one concrete thing that moves the work on, or close in a sentence and call finish.`
    });
  }

  if (response.finishReason === 'length' && !response.toolCalls.length) {
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
        : assistantText
          ? 'The reply reached the model’s output limit and is being continued'
          : 'The model reached its output limit without returning an answer; retrying',
      {
        // Only the cap. A reply being continued is the harness doing its job and the owner
        // sees the finished answer either way; a reply that will not be continued any further
        // is an answer they have been handed incomplete.
        ...(capped ? { owner: true } : {}),
        truncated: true,
        characters: assistantText.length,
        continuation: truncations,
        continued: !capped
      }
    );
    if (capped) {
      await endIncompleteAnswer(
        deps,
        task,
        key,
        state,
        assistantText.slice(0, 400) ||
          'Stopped after repeated output limits without a complete answer.',
        'The model repeatedly reached its output limit. Automatic continuation has stopped; any answer above may be incomplete and has not been checked against the request. Reply to continue or choose another model.'
      );
      return 'completed';
    }
    state.messages.push({
      role: 'system',
      content: assistantText
        ? `CONTINUE THE ANSWER (${truncations} of ${MAX_TRUNCATED_CONTINUATIONS}): your previous reply stopped at the model's output limit, mid-sentence, and the user is looking at it. Carry straight on from where it stopped - do not repeat, restart or summarise what you already wrote. Call finish once the answer is complete.`
        : `CONTINUE THE ANSWER (${truncations} of ${MAX_TRUNCATED_CONTINUATIONS}): the previous generation reached the output limit without returning an answer or a tool call. Produce a concise answer or the next concrete tool call without repeating internal analysis. Call finish when the work is complete.`
    });
    return 'continue';
  } else state.truncatedReplies = 0;

  if (!response.toolCalls.length) {
    // Tool inactivity has its own bound. Prose neither proves a tool ran nor consumes that bound.
    const nags = (state.completionNags ?? 0) + 1;
    state.completionNags = nags;
    state.repairStep = true;
    if (nags >= MAX_COMPLETION_NAGS) {
      await event(deps.store, task, key, 'warning', 'Answered without calling finish', {
        attempts: nags
      });
      await endIncompleteAnswer(
        deps,
        task,
        key,
        state,
        assistantText.slice(0, 400) || `Answered after ${state.step} steps without calling finish.`,
        `The agent answered ${nags} times without calling finish, so garden never checked this against the request. Read the answer before relying on it, or reply to carry on.`
      );
      return 'completed';
    }
    state.messages.push({
      role: 'system',
      content: `COMPLETION CHECK (${nags} of ${MAX_COMPLETION_NAGS}): A response without the finish tool does not complete the task. Verify the outcome, update any work that is still incomplete, then call finish with evidence. If this was only a conversational answer and no tools were used, use verification status not_applicable.`
    });
    await event(deps.store, task, key, 'status', 'Checking the result before completion', {
      attempt: nags
    });
    return 'continue';
  }
  state.completionNags = 0;
  return 'proceed';
};
