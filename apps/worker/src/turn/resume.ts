/**
 * What a turn has to settle before it can take another step: everything the last one left behind.
 *
 * Three shapes arrive here, and only here:
 *
 *   - a **restart** mid-batch, so a call is in flight or a batch was dropped part-way;
 *   - a **parked approval**, waiting on the owner to answer a card;
 *   - a **parked question**, waiting on the owner to reply to `ask`.
 *
 * All three are the same kind of thing - the world moved while this turn was not running - and all
 * three end the same two ways: the turn carries on, or it goes back to waiting exactly as it was.
 * That is what makes a re-lease from any direction safe, whether it comes from a worker restart, a
 * sweep, or the owner resuming, and it is why they are one phase rather than three.
 *
 * Lifted out of `AgentWorker.run()` unchanged: two hundred and eighteen lines that ran once, before
 * the loop, and had nothing to do with the loop.
 */
import { ownerMessageContent, type OwnerMessage, decryptJson, encryptJson } from '@athanor/core';
import type { BrowserActionReceipt, ModelRelease, WebToolPlan } from '@athanor/contracts';
import type { TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentState } from '../agent-state.js';
import { approvalArgumentsMatch, approvalOutcome } from '../approval-state.js';
import { event, type ToolRecordingDeps } from '../tool-recording.js';
import { sealUnansweredToolCalls, unansweredToolCallIds } from '../turn-lifecycle.js';
import { drainCorrection } from '../turn-control.js';
import { textValue } from '../values.js';
import { recoverPatchReceipts } from '../edit/receipts.js';
import { PLAN_MODE_PERMITTED } from './dispatch.js';

/**
 * What settling a parked turn needs from the worker that owns it.
 *
 * Everything the approved-call arm needs is already `ToolRecordingDeps` - it is the same dispatch
 * the loop's own batch goes through, watched the same way - plus the failure recorder, which the
 * loop reaches directly and that interface therefore never had to name.
 */
export interface TurnResumeDeps extends ToolRecordingDeps {
  browserActionReceipt(
    task: TaskRecord,
    state: AgentState,
    callId: string
  ): Promise<BrowserActionReceipt | null>;
  recordToolFailure(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall,
    error: unknown
  ): Promise<void>;
}

/**
 * Settles whatever the last run left parked.
 *
 * @returns true when the turn is parked again - awaiting the owner, stopped, or taken over - and
 * the caller must return without stepping.
 */
export const resumeParkedTurn = async (
  deps: TurnResumeDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  run: { model: ModelRelease; catalog: ModelRelease[]; webPlan: WebToolPlan },
  /** The stop/cancel/takeover question, asked with this turn's own state. */
  honorUserControl: () => Promise<boolean>
): Promise<boolean> => {
  const { model, catalog, webPlan } = run;
  delete state.jobWaitId;
  // A state saved partway through a tool batch is the one shape that can arrive here with calls
  // still unanswered. An awaiting-approval state is not: its own call is answered by the approval
  // outcome below, and the calls behind it were deferred in writing when it was saved.
  const interrupted = state.inFlight;
  const browserReceipt =
    interrupted?.tool === 'browser_action'
      ? await deps.browserActionReceipt(task, state, interrupted.toolCallId).catch(() => null)
      : null;
  delete state.inFlight;
  let restoredBrowserResult = false;
  if (
    browserReceipt?.status === 'completed' &&
    interrupted &&
    unansweredToolCallIds(state.messages).includes(interrupted.toolCallId)
  ) {
    const original = state.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.id === interrupted.toolCallId);
    if (original) {
      await deps.recordToolResult(
        task,
        key,
        state,
        original,
        browserReceipt.result,
        model,
        catalog
      );
      restoredBrowserResult = true;
    }
  }
  const patchReceipts =
    interrupted?.tool === 'file_patch'
      ? await recoverPatchReceipts(deps.store, task.id, key, interrupted.toolCallId).catch(() => [])
      : [];
  if (
    interrupted &&
    !restoredBrowserResult &&
    unansweredToolCallIds(state.messages).includes(interrupted.toolCallId)
  )
    // Whether that call reached the outside world cannot be known from here: the process died
    // between the action and its result. Re-running it is how one restart becomes two emails, so
    // the doubt goes to the model as the call's own result and the model has to check first.
    state.messages.push({
      role: 'tool',
      toolCallId: interrupted.toolCallId,
      content: `Interrupted: this ${interrupted.tool} call was still running when the worker restarted, so it may have taken effect and it may not have. Do not run it again until you have established which - read the file back, list the connected service's own record, or re-observe the page - and state what you found before you act.${browserReceipt ? ` Browser receipt: ${browserReceipt.status}; ${browserReceipt.steps.filter((step) => step.status === 'completed').length} actions acknowledged. This is execution history, not proof of a successful submission.` : ''}${patchReceipts.length ? ` Durable per-file receipts: ${JSON.stringify(patchReceipts)}. Applied entries landed; uncertain entries must be read and compared with their expected hash.` : ''}`
    });
  const stranded = state.pending
    ? []
    : sealUnansweredToolCalls(state.messages, 'the worker restarted before this call ran');
  if (interrupted || stranded.length) {
    // The next model call is a fresh step. Counting it keeps a worker that dies at the same call
    // every time bounded by the step budget instead of resuming into it forever.
    state.step += 1;
    await event(
      deps.store,
      task,
      key,
      restoredBrowserResult ? 'status' : 'warning',
      restoredBrowserResult
        ? 'Recovered the browser action receipt without repeating the action'
        : interrupted
          ? `${interrupted.tool} was interrupted by a restart and was not repeated automatically`
          : 'A restart interrupted this step, so the calls that had not started were dropped',
      {
        ...(interrupted
          ? {
              toolCallId: interrupted.toolCallId,
              tool: interrupted.tool,
              startedAt: interrupted.startedAt
            }
          : {}),
        dropped: stranded
      }
    );
  }

  if (state.pending) {
    const approval = await deps.store.getApproval(state.pending.approvalId);
    const outcome = approvalOutcome(approval);
    if (outcome === 'waiting') {
      await deps.store.updateTask({
        id: task.id,
        workerId: deps.config.WORKER_ID,
        status: 'awaiting_user',
        clearLease: true
      });
      return true;
    }
    const { approvalId, toolCall: call, handoffOnly } = state.pending;
    // Dropped before the pause check below so a paused resume seals this call once instead of
    // executing it a second time when the task is picked back up.
    delete state.pending;
    // This response has already been billed; the next generation must consume a fresh step.
    state.step += 1;
    const approvalCoversCall =
      outcome === 'approved' &&
      approvalArgumentsMatch(textValue(approval?.previewHash), key, call.name, call.arguments);
    if (outcome === 'approved' && !approvalCoversCall) {
      // The user approved a specific action, so a different one must not inherit that decision.
      await event(
        deps.store,
        task,
        key,
        'warning',
        'Refused: this action no longer matches what was approved',
        // Addressed to the owner: they answered a question about one action and a different one
        // was attempted under that answer. Nothing else in the conversation says so.
        { owner: true, approvalId, tool: call.name }
      );
      state.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: `Refused: the arguments for ${call.name} no longer match the ones the user approved, so the approval does not cover this call. Request approval again for the exact action you intend to run.`
      });
      state.turnToolResults ??= {};
      state.turnToolResults[call.id] = { name: call.name, success: false };
    } else if (
      approvalCoversCall &&
      !handoffOnly &&
      state.mode === 'plan' &&
      !PLAN_MODE_PERMITTED.has(call.name)
    ) {
      /*
       * The door beside the one plan mode closes, and it is open in exactly one direction.
       *
       * Not a handoff, and that conjunct is the difference between a refusal and a lie. A
       * `handoffOnly` resumption executes nothing here in either mode - the owner already did the
       * thing themselves, on their own screen, and this branch's whole job is to tell the model to
       * look at what changed. Refusing it would send "it was not run and nothing changed" over an
       * action that was run, by the owner, possibly a sign-in or a private value typed into the
       * page - so the model would then plan against a computer in a state it has been told does not
       * exist. There is nothing for plan mode to stop in that case, because nothing is about to run.
       *
       * A plan-mode turn can still park on a card, and never on one this branch would refuse.
       * Measured through `approvalRequirement`: `parallel_web_read` is on the permitted set and
       * raises `external_reversible` for a novel destination on a turn that has read untrusted
       * content, in all three security modes. So the wider claim - that plan mode answers
       * everything the floor would card - is false; what is true is that it answers everything
       * this branch refuses, because the batch loop's gate runs long before the floor is asked. A
       * card raised inside plan mode therefore always names a permitted tool, and a permitted tool
       * resumes below rather than here.
       *
       * What reaches this branch is a card raised in act mode: the owner approves it and THEN puts
       * the conversation into plan mode, or does both in the other order. The card is answered by
       * id, the turn resumes here, and this branch runs the approved call without ever passing
       * through the batch loop's gate.
       *
       * The later owner action wins. Approving a card says "yes, do that one thing"; entering plan
       * mode says "stop changing things until I have seen the approach", and it is the more recent
       * of the two. Refused rather than deferred, in the same shape as the arguments-no-longer-match
       * refusal above and for the same reason: the model re-proposes the call, and it will be
       * carded again, when the owner has taken the conversation back out of plan mode.
       *
       * `PLAN_MODE_PERMITTED` is imported from the batch loop rather than restated, because a second
       * copy of that set is a second answer to the same question. There is no import cycle: the
       * batch loop names this module only as a type.
       */
      await event(
        deps.store,
        task,
        key,
        'warning',
        'Refused: the conversation moved into plan mode after this action was approved',
        // Addressed to the owner: they approved something and it did not run, and nothing else in
        // the conversation would say why.
        { owner: true, approvalId, tool: call.name }
      );
      state.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: `Refused: ${call.name} was approved, but the user has since put this conversation in plan mode, so it was not run and nothing changed. Fold it into the plan instead and propose it again once they take the conversation out of plan mode.`
      });
      state.turnToolResults ??= {};
      state.turnToolResults[call.id] = { name: call.name, success: false };
    } else if (approvalCoversCall) {
      await event(deps.store, task, key, 'approval_resolved', 'Approved action resumed', {
        approvalId,
        decision: 'approved'
      });
      if (handoffOnly) {
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `The user completed or reviewed the secure ${call.name === 'desktop_action' ? 'computer' : 'browser'} handoff. Observe the current state before continuing. Never request or replay the private value.`
        });
      } else if (await honorUserControl()) {
        return true;
      } else {
        // An approved call can be the first thing this turn that touches the computer - the turn
        // paused before it ran - so the undo point is taken here too, not only in the loop below.
        await deps.ensureTurnUndoPoint(task, key, state, call.name);
        // This is the one call the owner explicitly authorised, so it is also the one a restart
        // must never run twice. Persisting the intent here is what drops the now-answered
        // `pending` record as well: without it a worker killed here resumed with the approval
        // still pending and executed the approved action a second time.
        state.inFlight = {
          toolCallId: call.id,
          tool: call.name,
          startedAt: new Date().toISOString()
        };
        await deps.checkpoint(task, key, state);
        try {
          // Watched exactly as the loop's own dispatch is. This is the one call the owner was
          // asked about by name, so it is the one where Stop has most reason to work - and it was
          // the one path without a watch: an approved `shell` runs to the runner's own ceiling,
          // `startStopWatch` only guards model calls, and `honorUserControl` is checked at step
          // boundaries this resume happens before. The interface said stopped while the approved
          // command kept running.
          const result = await deps.withLeaseRenewal(task, () =>
            deps.withCancellationWatch(task, () =>
              deps.execute(task, call, key, true, webPlan, state)
            )
          );
          await deps.recordToolResult(task, key, state, call, result, model, catalog);
        } catch (error) {
          await deps.recordToolFailure(task, key, state, call, error);
        }
        delete state.inFlight;
        await deps.checkpoint(task, key, state);
      }
    } else if (outcome === 'expired') {
      // An unanswered request is a denial once it times out. Resuming the task is what releases
      // its compute reservation, so leaving it in awaiting_user would hold that reservation for
      // as long as the row lives.
      await event(
        deps.store,
        task,
        key,
        'approval_resolved',
        'Approval request expired without an answer, so the action was not run',
        { approvalId, decision: 'expired', tool: call.name }
      );
      state.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: `This ${call.name} request expired before the user answered it and was not run. Treat it as denied: continue with what you can do safely without it, and finish by stating clearly what still needs the user's decision.`
      });
      state.turnToolResults ??= {};
      state.turnToolResults[call.id] = { name: call.name, success: false };
    } else {
      await event(deps.store, task, key, 'approval_resolved', 'Action was not approved', {
        approvalId,
        decision: textValue(approval?.status, 'denied')
      });
      state.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: `The user ${textValue(approval?.status, 'denied')} this action. Continue safely without it.`
      });
    }
  }

  /*
   * The answer to a parked question, taken back into the turn that asked it.
   *
   * A question is answered by the owner writing, and a message sent to a conversation the agent
   * still holds is queued rather than started - so this is the same move `drainCorrection` makes
   * mid-turn, at the one point where waiting for it is the whole state of the machine. Keeping the
   * turn is the point: everything the agent had already established is still in the window, and
   * the alternative - ending the turn and starting a fresh one on the reply - throws away the
   * context that made the question worth asking.
   *
   * `interrupt` is not required here, as it is for a correction. There the distinction earns its
   * keep, because "do this next" and "no, not that" are different intentions and timing alone
   * cannot tell them apart; here the agent has stopped and said what it is waiting for, so the
   * next thing the owner writes is the answer by construction.
   *
   * With nothing queued the conversation is parked again exactly as it was, mirroring the pending
   * approval that is still waiting above. That is what makes a re-lease from any direction - a
   * worker restart, a sweep, an owner resuming - safe: the machine returns to waiting rather than
   * carrying on as though it had been answered.
   */
  if (state.question) {
    const asked = state.question;
    let waiting = await deps.store.getNextQueuedTaskMessage(task.id);
    // A refusal explains a decision; it does not consume the answer to a separate question.
    while (waiting?.approvalId) {
      await drainCorrection(deps, task, key, state);
      if (await honorUserControl()) return true;
      waiting = await deps.store.getNextQueuedTaskMessage(task.id);
    }
    const message = waiting ? decryptJson<OwnerMessage>(waiting.promptCiphertext, key) : null;
    const answer = message?.prompt.trim() ?? '';
    const answeredState = waiting && answer ? structuredClone(state) : null;
    if (answeredState) {
      answeredState.ownerReasoningEffort =
        waiting?.reasoningEffort ?? task.reasoningEffort ?? 'auto';
      delete answeredState.question;
      answeredState.questionsAsked = 0;
      answeredState.messages.push({
        role: 'user',
        content: ownerMessageContent({ prompt: answer, attachments: message?.attachments })
      });
    }
    const consumed =
      waiting && answeredState
        ? await deps.store.consumeQueuedTaskMessageInTurn({
            taskId: task.id,
            messageId: waiting.id,
            workerId: deps.config.WORKER_ID,
            // The reply reserved credits of its own, and the turn it is rejoining was budgeted
            // before they existed - without this the loop trips its own ceiling immediately.
            additionalComputeCredits: waiting.maxComputeCredits,
            ...(waiting.maxSpendUsd === null ? {} : { additionalSpendUsd: waiting.maxSpendUsd }),
            userMessageCiphertext: encryptJson(
              { markdown: answer, attachments: message?.attachments, messageId: waiting.id },
              key,
              `task-event:${task.id}`
            ),
            agentStateCiphertext: encryptJson(answeredState, key, `task-state:${task.id}`),
            actualComputeCredits: answeredState.credits
          })
        : false;
    if (!consumed) {
      await deps.store.updateTask({
        id: task.id,
        workerId: deps.config.WORKER_ID,
        status: 'awaiting_user',
        clearLease: true
      });
      return true;
    }
    Object.assign(state, answeredState);
    delete state.question;
    if (!waiting?.approvalId && waiting?.securityMode) task.securityMode = waiting.securityMode;
    task.reasoningEffort = state.ownerReasoningEffort ?? 'auto';
    await event(deps.store, task, key, 'status', 'Answered - carrying on', {
      question: asked.question
    });
  }

  return false;
};
