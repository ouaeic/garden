import { appendMemoryOwnerInput } from './memory-owner-input.js';
/**
 * The three questions a turn asks between steps: has the owner said something, is this run still the
 * one in charge, and is the request about to go out the one this turn's own log accounts for?
 *
 * `honorUserControl` asks about ownership as well as status, because status alone sees a Stop and
 * cannot see a task resumed out from under this worker. It runs at every step boundary and inside
 * the per-tool-call loop, which is where the gap between two model calls lives. A worker that has
 * lost its lease and carries on executing a tool batch writes nothing through its lease-guarded
 * writes, but its timeline events are not lease-guarded, so the conversation would gain a second
 * copy of the batch.
 */
import {
  privateDiagnostics,
  recordPrivateDiagnostic,
  ownerMessageContent,
  type OwnerMessage,
  GardenError,
  decryptJson,
  encryptJson
} from '@garden/core';
import type { DataStore, TaskRecord } from '@garden/data';
import type { ModelMessage, ModelTool } from '@garden/model-gateway';
import type { AgentState, AgentWorkerConfig } from './agent-state.js';
import type { Logger } from './log.js';
import type { AgentRunnerClient } from './runner-client.js';
import { event } from './tool-recording.js';
import { cancelConfirmation } from './turn-bounds.js';
import { haltReason, sealUnansweredToolCalls } from './turn-lifecycle.js';

/** What the between-steps questions need from the worker that owns the turn. */
export interface TurnControlDeps {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  readonly runner: AgentRunnerClient;
  readonly logger: Logger;
  checkpoint(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<void>;
}

/**
 * Takes a correction the owner sent while this turn was running, at a step boundary.
 *
 * Until this existed a message sent to a working task could only wait for it to stop: if the
 * agent had misread the request or was heading somewhere visibly wrong, the choice was to watch
 * it finish or cancel and lose the work. The turn is kept deliberately - everything already
 * done stays in the window, which is the whole point of steering rather than restarting.
 *
 * Only messages the owner marked as a correction are taken this way. An ordinary follow-up
 * still waits, because "do this next" and "no, not that" are different intentions and reading
 * one as the other from timing alone would be wrong half the time.
 */
export const drainCorrection = async (
  deps: Pick<TurnControlDeps, 'store'> & { config: Pick<AgentWorkerConfig, 'WORKER_ID'> },
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState
): Promise<boolean> => {
  const queued = await deps.store.getNextQueuedTaskMessage(task.id, { interruptOnly: true });
  if (!queued?.interrupt) return false;
  const message = decryptJson<OwnerMessage>(queued.promptCiphertext, key);
  const correction = message.prompt;
  if (!correction.trim()) return false;
  const nextState = structuredClone(state);
  const answersQuestion = Boolean(message.questionId && message.questionId === state.question?.id);
  if (answersQuestion) {
    delete nextState.question;
    nextState.questionsAsked = 0;
  }
  if (!queued.approvalId)
    nextState.ownerReasoningEffort = queued.reasoningEffort ?? task.reasoningEffort ?? 'auto';
  sealUnansweredToolCalls(nextState.messages, 'the user redirected the task before this call ran');
  nextState.messages.push({ role: 'user', content: ownerMessageContent(message) });
  if (!queued.approvalId)
    nextState.memoryOwnerRequest = appendMemoryOwnerInput(nextState.memoryOwnerRequest, correction);
  const consumed = await deps.store.consumeQueuedTaskMessageInTurn({
    taskId: task.id,
    messageId: queued.id,
    workerId: deps.config.WORKER_ID,
    additionalComputeCredits: queued.maxComputeCredits,
    ...(queued.maxSpendUsd === null ? {} : { additionalSpendUsd: queued.maxSpendUsd }),
    userMessageCiphertext: encryptJson(
      {
        markdown: correction,
        attachments: message.attachments,
        messageId: queued.id,
        ...(message.questionId ? { questionId: message.questionId } : {})
      },
      key,
      `task-event:${task.id}`
    ),
    // The queue row and the words in the saved trajectory commit together, including on restart.
    agentStateCiphertext: encryptJson(nextState, key, `task-state:${task.id}`),
    actualComputeCredits: nextState.credits
  });
  if (!consumed) {
    if (queued.approvalId)
      throw new GardenError(
        'approval_correction_conflict',
        'The task changed before its denial correction could be saved'
      );
    return false;
  }
  Object.assign(state, nextState);
  if (answersQuestion) delete state.question;
  if (!queued.approvalId && queued.securityMode) task.securityMode = queued.securityMode;
  if (!queued.approvalId) task.reasoningEffort = nextState.ownerReasoningEffort ?? 'auto';
  await event(
    deps.store,
    task,
    key,
    'status',
    answersQuestion
      ? 'Answer received — continuing the task'
      : 'Applying your correction to the running task'
  );
  return true;
};

export const honorUserControl = async (
  deps: TurnControlDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState
): Promise<boolean> => {
  /*
   * Two columns, read three or four times a step, against the whole encrypted trajectory.
   *
   * `status` and `leaseOwner` are precisely and only what `taskClaim` returns, and one of these
   * calls sits inside the per-tool-call loop - so a sixty-step turn made about 210 of them and
   * read roughly 200 MB to answer a question about two strings.
   *
   * The narrow read stayed narrow when the cost was fixed, and the wider question `haltReason`
   * asks was deferred to the work that could change when a turn ends rather than only what it
   * costs to ask. That work is this one, and the arm is directly below.
   */
  const claim = await deps.store.taskClaim(task.id);
  /*
   * The other half, closed.
   *
   * `haltReason` answers the wider question - is this run still the one in charge? - and it was
   * reached only through `startStopWatch`, which is to say only while a model call was in flight.
   * Between the end of one model call and the next, a worker that had lost the task went on
   * executing the whole tool batch against a workspace another worker was now also running: this
   * function returned `false` for it, because status alone cannot see a task that was resumed out
   * from under this run. The pre-condition is cheap - `withPeriodicRenewal` swallows every renewal
   * error, so a few minutes of database trouble during a long `shell` call silently drops a
   * two-minute lease.
   *
   * `disowned` stands the run down in silence, exactly as `stopWatch.halt === 'disowned'` does
   * mid-call: no event, no state write, no lease clear. Every one of those would be this worker
   * writing over the trajectory whoever holds the task is writing now - and timeline events carry
   * no lease guard at all, so the conversation would gain a second copy of the batch.
   */
  if (haltReason(claim, deps.config.WORKER_ID) === 'disowned') return true;
  if (!claim || !['paused', 'cancelled'].includes(claim.status)) return false;
  /*
   * Stopped, but not by this worker's owner-facing run any more.
   *
   * Checked before the notice and before the write, not folded into the guard above, because
   * everything below this line assumes the trajectory in hand is the one on disk. A worker that
   * has lost the task to another claimant would otherwise announce a pause on a conversation
   * somebody else is actively running, save its own stale state over theirs, and - because the
   * write below is deliberately unguarded - clear their lease on the way out, leaving them
   * generating into a task every later write of theirs silently misses.
   */
  if (claim.leaseOwner !== null && claim.leaseOwner !== deps.config.WORKER_ID) return true;
  const latest = claim;
  /*
   * The Stop button reaching the background, which is the other half of ATH-052.
   *
   * Cancelling aborts the runner request in flight. `processes/start` has none - it answered in
   * milliseconds and left its child running for the rest of its hour - so a cancelled task went
   * on writing into the workspace and making requests attributed to this computer while the
   * interface said it had stopped. Nothing in the worker, the API or the runner ended them.
   *
   * Four things about this call are load-bearing:
   *
   * - **The body is `{}` and not omitted.** `AgentRunnerClient.call` picks GET when there is no
   *   body, and this route is a POST.
   * - **It is outside `withRunnerAbort`.** That scope's signal is the one cancellation has just
   *   aborted, and a request made inside it would be killed before it left. Every
   *   `honorUserControl` call site is at a step or tool-batch boundary, outside the scope
   *   `#withCancellationWatch` opens, which is what makes this true - so this must stay here
   *   rather than move inside a watched operation.
   * - **Only on `cancelled`.** A paused task resumes and polls its own sessions; killing them
   *   would turn a pause into a silent loss of the work that was running.
   * - **It cannot fail the cancellation.** A runner that is down is one of the reasons an owner
   *   presses Stop, so the failure is swallowed and the confirmation says only what it knows.
   *
   * The note is the runner's own sentence, used verbatim. A declared service deliberately
   * outlives the task that started it, and the runner writes that exemption out precisely so
   * this side cannot phrase it wrongly - an owner told only "cancelled" reads it as everything
   * having stopped, then wonders why a port they thought they had freed is still busy.
   */
  const stopped =
    latest.status === 'cancelled'
      ? await deps.runner
          .call<{
            stopped: string[];
            services: string[];
            note: string;
          }>(
            task.workspaceId,
            task.id,
            'exec',
            `/v1/workspaces/${task.workspaceId}/processes/stop-owner`,
            {}
          )
          .catch((error: unknown) => {
            deps.logger.warn('task.cancel_background_stop_failed', {
              taskId: task.id,
              class: error instanceof Error ? error.name : 'unknown'
            });
            return null;
          })
      : null;
  await event(
    deps.store,
    task,
    key,
    'status',
    latest.status === 'paused' ? 'Task paused by user' : cancelConfirmation(stopped?.note),
    stopped ? { stoppedProcesses: stopped.stopped.length, services: stopped.services } : undefined
  );
  sealUnansweredToolCalls(
    state.messages,
    latest.status === 'paused'
      ? 'the user paused the task before this call ran'
      : 'the user cancelled the task before this call ran'
  );
  /*
   * Deliberately without `workerId`.
   *
   * Every other write from this worker is guarded by `lease_owner = workerId`, which is right:
   * it stops a worker that lost its lease from writing over whoever holds it now. This one is
   * different. Pausing and cancelling already cleared the lease in the same statement that set
   * the status (`setTaskStatusForUser`, `cancelTaskAndReleaseReservations`), so by the time we
   * get here the guard can never match - and this write is the one that saves the agent state.
   * It matched zero rows every single time, so a paused task quietly lost the work it had done
   * and resumed from the beginning, and nothing said so because `updateTask` returns void.
   *
   * Unguarded is correct here rather than merely convenient: we are reconciling to a status the
   * owner has already set, not competing for the task.
   */
  await deps.store.updateTask({
    id: task.id,
    status: latest.status,
    actualComputeCredits: state.credits,
    agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
    clearLease: true
  });
  return true;
};

/**
 * The third question, asked once per step and answered against the log rather than against a flag:
 * is the request about to go out the one this turn's own record says it should be?
 *
 * This repository's named signature defect is a control wired to nothing - a gate that computes the
 * right verdict and is never consulted, a set that is built and never read, a withdrawal that is
 * decided and then not applied. Without this, that shape is found only by a human reading two files
 * against each other, because nothing else in the product re-derives what it is about to do from
 * what it has recorded.
 *
 * The model request is the largest such control in garden: it is the whole of what the model sees,
 * it is assembled from four independent inputs at three different points in the loop, and a
 * divergence in it is silent - the provider answers a wrong window exactly as readily as a right
 * one, and the answer looks like an ordinary reply. So it is re-derived immediately before the send
 * and the turn is failed on any disagreement. Three live classes this closes, each of which is a
 * defect that has actually existed in a loop of this shape:
 *
 * - `messages` no longer being a function of `state.messages`. `prepareModelContext` copies rather
 *   than mutates, so its output is derivable from its inputs; anything that edits `state.messages`
 *   between the preparation and the send - a taint notice, a pushback, a compaction re-entered on a
 *   retry path - produces a request the persisted trajectory cannot account for, and a resume then
 *   replays a different conversation than the one that was billed.
 * - The tools sent diverging from the catalogue minus this run's withdrawals. The withdrawal set is
 *   built once for the whole run precisely so the catalogue stays byte-identical across steps; a
 *   later rebuild that forgets a withdrawal restores a tool the box cannot honour, and moves the
 *   head of the cached prefix while doing it. Compared by content and not only by name, and that
 *   is not belt-and-braces: `connector_action` is shaped by which kinds of service the owner
 *   has connected, so a rebuild that read the connector table again instead of the fact frozen on
 *   the run would produce the same forty-one names carrying a different request. A name check
 *   would call that derivable.
 * - `reservedTokens` diverging from the array actually sent. Three places compute it independently
 *   from three arrays, and it is the number the input budget, the compaction trigger and the
 *   handoff's own floor are all derived from. A drift there is a window sized against a request
 *   nobody is sending.
 *
 * It returns the sentence rather than throwing so the caller decides what a breach costs; the loop
 * raises it, which is right - a request this side cannot account for must not be paid for.
 */
const deriveRequestBreach = (request: {
  /** The window as prepared, and the window as re-derived from the log at send time. */
  prepared: readonly ModelMessage[];
  rederived: readonly ModelMessage[];
  /** The tools on the request, and the catalogue this run is entitled to send. */
  sent: readonly ModelTool[];
  entitled: readonly ModelTool[];
  /** What the budget was computed against, and the array that is going out. */
  reservedTokens: number;
  reservedTokensOfSent: number;
}): string | null => {
  const sent = request.sent.map((tool) => tool.name);
  const entitled = request.entitled.map((tool) => tool.name);
  if (sent.length !== entitled.length || sent.some((name, at) => name !== entitled[at]))
    return `the tools on this request are not the catalogue this run withdrew from: sending ${sent.length} (${sent.slice(0, 6).join(', ')}) against ${entitled.length} entitled`;
  // And the same tools, not merely the same names. Both sides are built by one pure function from
  // facts frozen on the run, so they are equal or something re-derived from a different answer.
  const differing = request.sent.findIndex(
    (tool, at) => JSON.stringify(tool) !== JSON.stringify(request.entitled[at])
  );
  if (differing >= 0)
    return `the ${sent[differing]} definition on this request is not the one this run is entitled to send: ${JSON.stringify(request.sent[differing]).length} characters against ${JSON.stringify(request.entitled[differing]).length}`;
  if (request.reservedTokens !== request.reservedTokensOfSent)
    return `the input budget was computed against ${request.reservedTokens} reserved tokens and the tools actually being sent weigh ${request.reservedTokensOfSent}`;
  if (request.prepared.length !== request.rederived.length)
    return `the window being sent has ${request.prepared.length} messages and the same window re-derived from the saved trajectory has ${request.rederived.length}`;
  for (const [at, message] of request.prepared.entries()) {
    const again = request.rederived[at];
    // Role, addressee and content, which is the whole of what a provider is told. Compared field by
    // field rather than by serialising both sides: a message carries reasoning details whose key
    // order is not this side's to guarantee, and a mismatch reported as "these two JSON blobs
    // differ" is a mismatch nobody can act on.
    if (!again || again.role !== message.role || again.toolCallId !== message.toolCallId)
      return `message ${at} of this request is a ${message.role} the saved trajectory does not derive`;
    if (again.content !== message.content)
      return `message ${at} (${message.role}) differs from the same message re-derived from the saved trajectory: ${message.content.length} characters against ${again.content.length}`;
    if ((again.toolCalls?.length ?? 0) !== (message.toolCalls?.length ?? 0))
      return `message ${at} (${message.role}) carries ${message.toolCalls?.length ?? 0} tool calls and the re-derived one carries ${again.toolCalls?.length ?? 0}`;
  }
  return null;
};

export const requestDerivationBreach = (request: Parameters<typeof deriveRequestBreach>[0]) => {
  const result = deriveRequestBreach(request);
  if (privateDiagnostics())
    void recordPrivateDiagnostic('request_derivation', { input: request, result });
  return result;
};
