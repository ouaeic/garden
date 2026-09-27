import { runtimeDate } from '@athanor/core';
/**
 * Running one tool call the floor let through, and recording what it did.
 *
 * Everything here is ordered by what a worker that dies mid-call would leave behind, which is the
 * only reason it is not four straight lines:
 *
 *   - the **undo point** used to be taken here, first, and is now taken one gate earlier, in
 *     `turn/dispatch.ts` in front of the approval floor. The floor's destructive rule reads whether
 *     this turn has a rewind, so taking it after the floor was asked meant a turn whose first
 *     non-exempt call was a recoverable delete paid a card that the identical delete two calls
 *     later did not. It is still at most once a turn and still never at all for a turn that only
 *     reads; it is simply taken before the decision that spends it rather than after;
 *   - **intent** is written before the **action**, so a worker killed between sending an email and
 *     recording that it sent one resumes saying "this was running" instead of silently sending it
 *     again. State used to be written once per step, after the whole batch;
 *   - the call is watched by both the lease renewal and the cancellation watch, so a long call
 *     neither loses its lease nor outlives the owner pressing Stop;
 *   - `publish_artifact` is the one success in the loop that does not go through `recordToolResult`,
 *     which is why it has to zero the repeated-failure count for itself. Without that, a publish
 *     that fails, works, and fails the same way again carries its old count forward, and a call the
 *     turn is genuinely completing can reach a bound meant for one that never completes.
 *
 * Lifted out of `AgentWorker.run()`'s batch loop unchanged.
 */
import type { ModelRelease, WebToolPlan } from '@athanor/contracts';
import type { TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentState } from '../agent-state.js';
import { event } from '../tool-recording.js';
import { REPEATABLE_TOOLS, failingCallKey, repeatedFailuresAfter } from '../turn-bounds.js';
import { isMutatingToolCall, requiresAcceptanceChecks } from '../write-classification.js';
import type { TurnResumeDeps } from './resume.js';

/**
 * Runs the call and records it.
 *
 * It asks for `TurnResumeDeps` because that is exactly the set an approved call needs, and a
 * resumed approval is the same dispatch through the same watches - one interface for one thing.
 */
export const executeApprovedCall = async (
  deps: TurnResumeDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall,
  run: {
    model: ModelRelease;
    catalog: ModelRelease[];
    webPlan: WebToolPlan;
  },
  /** Republishes the plan when this call moved it; the loop owns that closure. */
  refreshActivePlan: () => Promise<boolean>
): Promise<void> => {
  const { model, catalog, webPlan } = run;
  // Recorded on intent rather than on success, because a write that failed is still a turn
  // doing material work, and that is what the user-visible plan is for.
  if (isMutatingToolCall(call.name, call.arguments)) {
    state.mutated = true;
    if (requiresAcceptanceChecks(call.name, call.arguments)) state.mutatedBeyondProse = true;
  }
  state.toolsStarted = (state.toolsStarted ?? 0) + 1;
  await event(deps.store, task, key, 'tool_started', `Running ${call.name}`, {
    toolCallId: call.id,
    tool: call.name,
    arguments: call.arguments
  });
  // Intent first, action second. State used to be written once per step, after the whole
  // batch, so a worker killed between sending an email and recording that it had sent one
  // resumed from before the batch and sent it again. The record below is what lets the resume
  // say "this was running" instead of silently repeating it.
  const repeatable = REPEATABLE_TOOLS.has(call.name);
  if (!repeatable) {
    state.inFlight = {
      toolCallId: call.id,
      tool: call.name,
      startedAt: runtimeDate().toISOString()
    };
    await deps.checkpoint(task, key, state);
  }
  try {
    const result = await deps.withLeaseRenewal(task, () =>
      deps.withCancellationWatch(task, () => deps.execute(task, call, key, false, webPlan, state))
    );
    if (call.name === 'publish_artifact') {
      const artifact = result as {
        artifactId: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
        version: number;
        preview?: {
          artifactId: string;
          name: string;
          mimeType: string;
          sizeBytes: number;
          version: number;
        };
      };
      await event(
        deps.store,
        task,
        key,
        'artifact',
        `${artifact.name} · version ${artifact.version}`,
        artifact
      );
      if (artifact.preview)
        await event(
          deps.store,
          task,
          key,
          'artifact',
          `${artifact.preview.name} · review copy · version ${artifact.preview.version}`,
          artifact.preview
        );
      state.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(artifact)
      });
      state.turnToolResults ??= {};
      state.turnToolResults[call.id] = { name: call.name, success: true, mutating: false };
      // Said here as well as in `#recordToolResult`, because this is the one success in the
      // loop that does not go through it. Without it a publish that fails, works, and fails
      // the same way again carries its old count forward, and a call the turn is genuinely
      // completing can reach a bound meant for one that never completes.
      state.repeatedFailures = repeatedFailuresAfter(state.repeatedFailures, {
        call: failingCallKey(call),
        failure: null
      });
    } else {
      await deps.recordToolResult(task, key, state, call, result, model, catalog);
    }
    // Adopt the version this call just wrote. Without it the plan the agent itself published
    // looks like a user edit to the next call in the same batch, which then gets skipped -
    // and marking a step in_progress before acting would skip the very action it describes.
    if (
      call.name === 'set_plan' &&
      Number.isFinite(Number((result as { version?: unknown } | null)?.version))
    )
      await refreshActivePlan();
  } catch (error) {
    await deps.recordToolFailure(task, key, state, call, error);
  }
  if (!repeatable) {
    delete state.inFlight;
    await deps.checkpoint(task, key, state);
  }
};
