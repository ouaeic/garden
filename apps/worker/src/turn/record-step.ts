/**
 * What the step said, put into the window and, when it is a new answer, onto the owner's timeline.
 *
 * Three things, and the order of the first two is a shape constraint rather than a preference. The
 * provenance notice for what the provider fetched on the model's behalf goes in **ahead** of the
 * assistant message: content fetched that way arrives inside the response rather than through a
 * tool result and would otherwise cross the boundary unlabelled, and an assistant message carrying
 * tool calls has to be followed immediately by their results - so the only position that is
 * shape-safe on every step is in front of the turn the content arrived in.
 *
 * The third is the one that saves tokens. A step the harness asked for is not a new answer: five
 * paths refuse a finish and send the model round again - the finish rejection, the plan hold, the
 * acceptance hold, an acceptance check that failed, and the completion nag - and its natural reply
 * to "finish rejected, cite something newer" is to restate the answer with an apology. Every one of
 * those restatements used to become another bubble, which is why one answer arrived in pieces, and
 * eleven of those rounds in the worst case is most of where a small task's tokens went. The prose
 * still goes into the window, because the model needs its own words back; it simply is not
 * published as a fresh reply.
 *
 * Lifted out of `AgentWorker.run()` unchanged.
 */
import type { DataStore, TaskRecord } from '@athanor/data';
import type { ModelResponse } from '@athanor/model-gateway';
import type { AgentState } from '../agent-state.js';
import { rememberOrigin } from '../egress.js';
import { providerWebProvenance } from '../provenance.js';
import { normalizeAssistantText } from '../streaming.js';
import { event } from '../tool-recording.js';

/** What recording a step needs from the worker that owns it. */
export interface TurnRecordStepDeps {
  readonly store: DataStore;
  /** The provenance notice, or `null` when this origin is already declared in the window. */
  raiseTaint(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    origin: string | null,
    tool: string
  ): Promise<string | null>;
}

/**
 * Records one step's words. Returns the normalised text, which is what the finish gate and the
 * answer holds each read - both of them ask about the words rather than about the response.
 */
export const recordAssistantStep = async (
  deps: TurnRecordStepDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  response: ModelResponse
): Promise<string> => {
  // What the provider fetched on the model's behalf, which arrives inside the response rather
  // than through a tool result and would otherwise cross the boundary unlabelled. The notice
  // goes in ahead of the assistant message rather than after it: an assistant message carrying
  // tool calls has to be followed immediately by their results, so the only position that is
  // shape-safe on every step is in front of the turn the content arrived in.
  const providerWeb = providerWebProvenance(response);
  for (const url of providerWeb.urls)
    state.knownOrigins = rememberOrigin(state.knownOrigins ?? [], url);
  const providerWebNotice = await deps.raiseTaint(
    task,
    key,
    state,
    providerWeb.origin,
    'provider_web'
  );
  if (providerWebNotice) state.messages.push({ role: 'system', content: providerWebNotice });
  const assistantText = normalizeAssistantText(response.text);
  state.messages.push({
    role: 'assistant',
    content: assistantText,
    ...(response.reasoning ? { reasoning: response.reasoning } : {}),
    ...(response.reasoningDetails?.length ? { reasoningDetails: response.reasoningDetails } : {}),
    ...(response.nativeContinuation ? { nativeContinuation: response.nativeContinuation } : {}),
    ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {})
  });
  /*
   * A step the harness asked for is not a new answer to the owner.
   *
   * Five paths refuse a finish and send the model round again - the finish rejection, the plan
   * hold, the acceptance hold, an acceptance check that failed, and the completion nag. Its
   * natural reply to "finish rejected, cite something newer" is to restate the answer with an
   * apology, and every one of those restatements used to become another bubble. That is why one
   * answer arrived in pieces, and eleven of those rounds in the worst case is most of where a
   * small task's tokens went. The prose still goes into the window - the model needs its own
   * words back - it simply is not published as a fresh reply.
   */
  if (assistantText && !state.repairStep) {
    state.answered = true;
    await event(deps.store, task, key, 'assistant_message', assistantText.slice(0, 500), {
      markdown: assistantText
    });
  }
  // Cleared as soon as the model does something other than ask to finish again, so an ordinary
  // step following a repair speaks normally.
  if (state.repairStep && response.toolCalls.some((call) => call.name !== 'finish'))
    state.repairStep = false;
  return assistantText;
};
