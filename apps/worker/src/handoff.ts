import { taskReasoningEffort } from './reasoning.js';
/**
 * The three ceilings a turn can reach, and the one closing call it is given when it does.
 *
 * Lifted out of `AgentWorker` in Wave 7.2 carrying #78 (loop F9 / rel F9): there was no clock
 * ceiling anywhere in the product. `TASK_MAX_STEPS`, `TASK_MAX_SELF_CONTINUATIONS`,
 * `maxComputeCredits` and the owner's spend caps were the only turn-level bounds, and the per-unit
 * ceilings compose badly - six idle steps at ten minutes of generation each is an hour of billed
 * deliberation, five completion nags is fifty minutes, and a hundred and twenty steps of tool time
 * is days in principle. The credit ceiling bites first on a frontier model and is a proxy for time
 * rather than a bound on it: on a cheap local route credits accumulate slowly and the wall clock
 * does not.
 *
 * The exit already existed - this is the file that writes the owner a handoff when a ceiling is
 * reached - so the clock is a third `reason` beside `steps` and `credits` rather than a new
 * mechanism.
 */
import type { ModelRelease, WebToolPlan } from '@athanor/contracts';
import { sha256 } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { ModelGateway, ModelTool, ModelToolCall } from '@athanor/model-gateway';
import {
  mayRenewStepBudget,
  stepBudgetRenewedNote,
  turnWriteCount,
  type AcceptanceRecord,
  type AcceptanceResult
} from './acceptance.js';
import type { AgentState, AgentWorkerConfig } from './agent-state.js';
import { buildIdentity } from './build-identity.js';
import { estimatedInferenceCostUsd, stepUsageKey, usageCredit } from './billing.js';
import { modelInputBudget, prepareModelContext } from './context.js';
import type { CompletionVerification } from './completion.js';
import { routeTo } from './routing.js';
import { createStreamFlusher, normalizeAssistantText } from './streaming.js';
import { event } from './tool-recording.js';
import {
  MAX_ACCEPTANCE_FAILURES,
  MAX_FINISH_REJECTIONS,
  reasoningEffortForStep,
  spendHalt,
  STEP_BUDGET_MARKER,
  STEP_HANDOFF_MARKER,
  stepBudgetNotice,
  stepLimitCarryOver
} from './turn-bounds.js';
import { withRequestDeadline } from './turn-lifecycle.js';
import { textValue } from './values.js';
import { turnRoutingTaskId } from './window.js';

/**
 * How long one leased execution of a turn may run before the harness writes the handoff.
 *
 * Two hours, and it costs a healthy turn nothing: the measured record in this file is that a
 * frontier model reaches the credit ceiling somewhere around step 22 to 39, long before this. What
 * it bounds is the shape the incident had - a turn that is cheap per step and never stops - which
 * no other ceiling in the product can see.
 *
 * Measured from the moment this worker picked the turn up rather than from a field on the state,
 * and the difference is deliberate rather than incidental: a resumed turn gets a fresh allowance,
 * exactly as a new turn does, because what is being bounded is how long one worker may hold one
 * lease without saying anything to the owner. Persisting it would bound the conversation instead,
 * which is a different promise and one the API's own resume contract does not make.
 */
export const TURN_WALL_CLOCK_MS = 2 * 60 * 60 * 1_000;

/** Whether this leased execution has been running longer than the harness will hold it. */
export const turnWallClockReached = (startedAt: number, now = Date.now()): boolean =>
  now - startedAt >= TURN_WALL_CLOCK_MS;

/** What the ceilings need from the worker that owns the turn. */
export interface HandoffDeps {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  runAcceptanceChecks(
    task: TaskRecord,
    key: Uint8Array,
    record: AcceptanceRecord,
    options?: {
      purpose: 'finish' | 'baseline' | 'continuation';
      observed?: ReadonlyMap<string, number>;
    },
    state?: AgentState
  ): Promise<AcceptanceResult[]>;
  checkpoint(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<void>;
  withLeaseRenewal<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T>;
  outstandingPlanSteps(task: TaskRecord, key: Uint8Array): Promise<string[]>;
  execute(
    task: TaskRecord,
    call: ModelToolCall,
    key: Uint8Array,
    approved: boolean,
    webPlan: WebToolPlan,
    state: AgentState
  ): Promise<unknown>;
  recordToolResult(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall,
    result: unknown,
    leadModel: ModelRelease,
    catalog: ModelRelease[]
  ): Promise<void>;
  completeTurn(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    completion: {
      summary: string;
      deliverables: unknown[];
      verification: CompletionVerification;
      interrupted?: boolean;
      outstanding?: string[];
    },
    options?: { label?: string }
  ): Promise<void>;
}

/**
 * Appends the step-budget notice this step crosses, if the window is not already carrying it.
 *
 * Against the ceiling in force rather than the configured one: a turn that has renewed its budget
 * is genuinely working to a later ceiling, and warning it at the old one would tell it to wrap up
 * a hundred and twenty steps before anything ends. A renewal clears these notices back out of the
 * window for the same reason, so each budget gets its own wind-down.
 */
export const noteStepBudget = async (
  deps: HandoffDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  maxSteps: number
): Promise<void> => {
  const notice = stepBudgetNotice(state.step, maxSteps);
  if (!notice) return;
  const marker = notice.split(':')[0] ?? '';
  if (
    state.messages.some(
      (message) => message.role === 'system' && message.content.startsWith(marker)
    )
  )
    return;
  state.messages.push({ role: 'system', content: notice });
  await event(
    deps.store,
    task,
    key,
    'status',
    marker === STEP_HANDOFF_MARKER
      ? 'Wrapping up: this turn is nearly out of steps'
      : 'Most of this turn’s step budget is used',
    { step: state.step, maxSteps }
  ).catch(() => undefined);
};

/** The step ceiling in force, which a turn that has renewed its own budget has moved. */
export const stepCeiling = (deps: HandoffDeps, state: AgentState): number => {
  return deps.config.TASK_MAX_STEPS * (1 + (state.selfContinuations ?? 0));
};

/**
 * A turn that has used its step budget, has not finished the job, and is still working.
 *
 * Everything this box does is meant to survive the owner not being there, and this was the one
 * place where it did not: the ceiling ended the turn, the handoff wrote "the user can reply and
 * you continue on this same computer with a fresh budget", and on a run started by a schedule at
 * three in the morning there is nobody to send that reply for eight hours. Nothing about the job
 * was finished; the interaction model had simply run out.
 *
 * What makes continuing safe is not that the model has no say - it chooses which check to declare
 * and it makes the changes that count as progress - but that it cannot mark its own homework and
 * cannot outspend the owner. The acceptance record is executed by the harness, so "is this done?"
 * is answered by running it rather than by a self-assessment, on the same run and the same
 * timeouts the finish gate is held to; and the ceiling that actually bounds a determined turn is
 * money, checked every step against the task's own allowance with a tenth of it kept back. What
 * remains gameable is wall clock: a turn willing to declare a check it will not satisfy and write
 * one file per budget can reach the configured continuation ceiling.
 *
 * Every other condition is checked in front of it, in the order they cost:
 * the free reads first, then one indexed row for the task's status and one for the spend guard,
 * and only then the checks themselves, which can be a full build.
 *
 * The bounds, all of them:
 *
 * - the record must exist, and the harness must have just watched it fail;
 * - the turn must have changed something since the last ceiling it was let past;
 * - the harness must not already have spent its refusals arguing with this turn;
 * - the task must still be running, still leased here, and not parked on an approval;
 * - the compute allowance and the owner's spend caps must both still allow it;
 * - and it may happen at most `TASK_MAX_SELF_CONTINUATIONS` times.
 *
 * What bounds the money is not on that list, because a continuation does not touch it. It buys
 * steps and only steps: `maxComputeCredits` is unchanged, the per-step spend guard runs before
 * every step of a renewed budget exactly as it does now, and a turn that reaches either ceiling
 * hands off in the ordinary way. Three budgets therefore cannot cost more than one - they spend
 * the allowance a stopped turn would have left behind.
 */
export const renewStepBudget = async (
  deps: HandoffDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState
): Promise<boolean> => {
  const ceiling = deps.config.TASK_MAX_SELF_CONTINUATIONS;
  const used = state.selfContinuations ?? 0;
  const writes = turnWriteCount(state.turnToolResults);
  const record = state.acceptance;
  const refused = async (reason: string): Promise<boolean> => {
    // The work log, not the conversation: a turn that stopped at its ceiling already raises the
    // owner-facing warning immediately below this, and saying twice over that it stopped would
    // bury the sentence that tells them where the work got to. This line is for the reader who
    // goes looking for why it did not carry on.
    await event(deps.store, task, key, 'status', `Stopping at the step limit: ${reason}`, {
      step: state.step,
      continuations: used,
      writes
    }).catch(() => undefined);
    return false;
  };
  const verdict = mayRenewStepBudget({
    hasAcceptance: Boolean(record),
    // The same test the finish gate makes on `inheritedAcceptance`, for the same stated reason:
    // a record an earlier turn declared was passing before this turn began, so it is not evidence
    // about anything this turn did.
    acceptanceIsThisTurn: (state.acceptanceTurn ?? 0) === (state.turn ?? 0),
    continuationsUsed: used,
    continuationCeiling: ceiling,
    writes,
    mark: state.continuationMark,
    credits: state.credits,
    maxCredits: task.maxComputeCredits,
    // The two ceilings that mean the harness has already given up on this turn. A model that
    // cannot ground a finish, or cannot pass its own checks, four times running is not one budget
    // short of passing them - it is stuck, and another budget is the runaway rather than the fix.
    refusalsExhausted:
      (state.acceptanceFailures ?? 0) >= MAX_ACCEPTANCE_FAILURES ||
      (state.finishRejections ?? 0) >= MAX_FINISH_REJECTIONS,
    awaitingApproval: Boolean(state.pending)
  });
  // Silent when the feature is off: an operator who set the ceiling to zero does not want a line
  // about it on every task that reaches its step limit.
  if (ceiling <= 0) return false;
  if (!verdict.ok) return refused(verdict.reason);
  if (!record) return false;
  /*
   * The owner's word, read fresh, immediately before the decision.
   *
   * Read rather than reconciled: `honorUserControl` writes the paused state and clears the lease,
   * and it is already called on the far side of this loop before the closing handoff is billed, so
   * doing it here as well would write the same state twice. What matters is that a Stop pressed at
   * any point during the last budget is seen here, and that a task some other worker has taken is
   * never continued by this one.
   */
  const latest = await deps.store.getTask(task.userId, task.id).catch(() => null);
  if (!latest || latest.status !== 'running')
    return refused(`the task is ${latest?.status ?? 'no longer readable'}`);
  if (latest.leaseOwner !== deps.config.WORKER_ID) return refused('another worker holds the task');
  /*
   * The spend caps, asked without acting on the answer.
   *
   * `#haltIfOutOfMoney` pauses the task when a cap is reached, which is the right thing to do at a
   * step boundary and the wrong thing here - the turn is ending either way, and the handoff below
   * is what leaves the owner something to act on. So the guard is consulted read-only: a cap that
   * is already blocking is a reason not to start another budget, and nothing more.
   */
  const decision = await deps.store
    .spendGuard({
      userId: task.userId,
      taskId: task.id,
      estimateUsd: Math.max(0.01, state.lastStepUsd ?? 0.01),
      includeOpenCommitments: true
    })
    .catch(() => null);
  if (!decision) return refused('the spending guard did not answer');
  if (decision.outcome === 'deny')
    return refused(spendHalt(decision) || 'a spending cap has been reached');

  const results = await deps.runAcceptanceChecks(
    task,
    key,
    record,
    { purpose: 'continuation' },
    state
  );
  const failed = results.filter((result) => !result.passed);
  if (!failed.length)
    // Every check the model wrote before the work now passes. That is the strongest evidence this
    // box has that the job is done, so the turn ends and spends its closing call saying so.
    return refused('every acceptance check now passes');

  const continuation = used + 1;
  state.selfContinuations = continuation;
  state.continuationMark = { atStep: state.step, writes };
  /*
   * The wind-down notice, taken back out of the window.
   *
   * `stepBudgetNotice` is pushed once and recognised by its marker, so without this the renewed
   * budget would get no warning of its own end while carrying a standing instruction to stop
   * starting work - which is now false, and which the model would read as the most recent thing
   * the harness said about the budget. It costs the cached prefix from that point on, twice a turn
   * at most, which is the same price a compaction pays for the same kind of correction.
   */
  state.messages = state.messages.filter(
    (message) =>
      !(
        message.role === 'system' &&
        (message.content.startsWith(STEP_BUDGET_MARKER) ||
          message.content.startsWith(STEP_HANDOFF_MARKER))
      )
  );
  state.messages.push({
    role: 'system',
    content: stepBudgetRenewedNote({
      results,
      continuation,
      ceiling,
      steps: state.step
    })
  });
  await event(
    deps.store,
    task,
    key,
    'status',
    `Continuing on its own (${continuation} of ${ceiling}): ${failed.length} of ${results.length} acceptance ${results.length === 1 ? 'check' : 'checks'} still ${failed.length === 1 ? 'fails' : 'fail'} after ${state.step} steps`,
    {
      continuation,
      maxContinuations: ceiling,
      step: state.step,
      maxSteps: deps.config.TASK_MAX_STEPS * (1 + continuation),
      writes,
      acceptance: results
    }
  ).catch(() => undefined);
  // Durable before the next step runs. A worker that dies here must resume into the renewed budget
  // it already announced rather than into a turn that reaches its ceiling and announces it again.
  // Swallowed, because this runs inside the loop's own condition: a store hiccup here must cost the
  // durability of one renewal, not the whole turn and the handoff it has not written yet.
  await deps.checkpoint(task, key, state).catch(() => undefined);
  return true;
};

/**
 * The end of a turn that ran out of steps rather than out of work.
 *
 * This used to be the one exit that ended in nothing. The loop threw, the task landed `failed`,
 * and the owner came back to a red error halfway through a form with no summary, no statement of
 * which fields were already filled, and no hint that replying resumes it - which the API has
 * always allowed. Everything the turn produced was durable the whole time; what was missing was
 * anyone saying so.
 *
 * So the ceiling buys one more model call, allowed nothing but `set_plan` and `finish`. It cannot
 * start new work - that is the point, and the loop below enforces it by answering every other
 * call with a denial - and it can do the two things that are worth more than another tool call:
 * leave the plan honest about where the work stopped, and write the handoff the owner reads. The
 * call is billed like any other step but deliberately not counted
 * against the budget: the budget bounds the work, and taking a working step away to pay for the
 * harness closing the turn would make one number mean two things.
 *
 * It lands `completed` rather than `awaiting_user`, which is not a claim that the job is done -
 * the summary and the preserved plan both say otherwise. It is the only terminal status a reply
 * can resume: `continueTask` accepts completed, failed, awaiting_resource and cancelled, while a
 * task parked in `awaiting_user` is waiting on an approval decision and nothing would ever lease
 * it again.
 */
export const handOffAtStepLimit = async (
  deps: HandoffDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  context: {
    gateway: ModelGateway;
    provider: string;
    model: ModelRelease;
    catalog: ModelRelease[];
    turn: number;
    maxOutputTokens: number;
    /**
     * The tools the turn has been sending all along, so the closing call sends them too.
     *
     * The catalogue is the head of the cached prefix. Handing this call a two-tool list replaced
     * some forty thousand tokens of it with a few hundred, on the largest request the turn makes -
     * every byte behind the change re-billed at the write price, for a call that is about to end
     * the turn anyway. Nothing was bought by it either: the restriction is enforced below, where
     * every call that is not set_plan or finish is answered with a denial, so the model cannot
     * start new work whatever the catalogue says. Passing the caller's own array rather than
     * rebuilding one keeps this byte-identical to the request before it, which is the whole point.
     */
    tools: ModelTool[];
    /**
     * The run's pinned web route, carried in only so the closing call's `set_plan` can reach the
     * dispatch table with the same two facts every other tool call reaches it with. Nothing on
     * this path searches the web; the parameter exists because the table refuses to be entered
     * without a route, which is the property that stopped `set_plan` arriving here stateless.
     */
    webPlan: WebToolPlan;
    /**
     * Which ceiling was reached. Both end the turn with work outstanding and both want the same
     * closing call - a plan the owner can read and a finish that says where it stopped - but the
     * step ceiling was the only one that got it. The credit ceiling threw, so the turn ended on a
     * red error with no summary, no plan correction and no word that a reply resumes it. On the
     * measured formula a frontier model reaches the credit ceiling around step 22 to 39, which is
     * far short of the 120 steps the other ceiling allows, so the exit that actually fires in
     * practice was the one with nothing in it.
     */
    reason?: 'steps' | 'credits' | 'time';
  }
): Promise<void> => {
  const { gateway, provider, model, catalog, turn, maxOutputTokens, tools } = context;
  const ranOutOf = context.reason ?? 'steps';
  const exhausted =
    ranOutOf === 'credits' ? 'COMPUTE BUDGET' : ranOutOf === 'time' ? 'TIME BUDGET' : 'STEP BUDGET';
  const outstanding = await deps.outstandingPlanSteps(task, key);
  await event(
    deps.store,
    task,
    key,
    'warning',
    ranOutOf === 'credits'
      ? 'This turn used its whole compute budget before the work was finished'
      : ranOutOf === 'time'
        ? 'This turn ran for its whole time budget before the work was finished'
        : 'This turn used its whole step budget before the work was finished',
    {
      // The turn stopped short of the work the owner asked for and only they can start it again,
      // so this is one of the few warnings that belongs in the transcript rather than the log.
      owner: true,
      steps: state.step,
      // The ceiling this turn actually worked to, and how it got there. A turn that renewed its
      // own budget twice and still ran out is a different thing to be told about than one that
      // stopped at the first ceiling, and the number in the payload has to say which happened.
      maxSteps: stepCeiling(deps, state),
      ...(state.selfContinuations ? { continuations: state.selfContinuations } : {}),
      ...(ranOutOf === 'credits'
        ? { credits: state.credits, maxCredits: task.maxComputeCredits }
        : {}),
      outstanding: outstanding.slice(0, 10)
    }
  ).catch(() => undefined);
  state.messages.push({
    role: 'system',
    content: `${exhausted} EXHAUSTED after ${state.step} steps. This is your last call of this turn and no other tool is available to you: only set_plan and finish. Do not attempt any further work.

Spend it on the handoff. First, if the plan no longer matches reality, publish a corrected one with set_plan so the open steps say exactly where the work stopped. Then write your reply - it is what the user reads - covering what is now done and where it is, what is not done and how far it got, anything they need to decide, and the exact words they can send back to carry on. Be concrete: name files, URLs, the field you had reached, the command that was still running. Finally call finish with a summary of the same thing.

Nothing you produced was rolled back and none of it is lost. This same task continues on this same computer, with a fresh budget, the moment the user replies.`
  });
  // The catalogue is counted here for the same reason the step loop counts it: it is part of the
  // request and the budget is what is left after it. Omitting the two figures told this call it
  // had the whole window for conversation on the one request of the turn that carries the most,
  // and the floor it picked was measured against a budget nobody was sending to.
  const reservedTokens = Math.ceil(JSON.stringify(tools).length / 4);
  const preparedContext = prepareModelContext(
    state.messages,
    model.contextTokens,
    maxOutputTokens,
    {
      precedingTokens: reservedTokens,
      reservedTokens,
      ...(state.toolOutputFloor === undefined ? {} : { toolOutputFloor: state.toolOutputFloor })
    }
  );
  /*
   * The effort this turn has been thinking at, carried onto the call that closes it.
   *
   * It was the literal 'medium', twice - once on the request and once on the cost event - and that
   * is the one request field the step loop goes out of its way not to flip. `reasoningEffortForStep`
   * ratchets in one direction and pins itself, and the comment at its call site says why in as many
   * words: a field that changes throws away the provider's cached trajectory below the system
   * prefix. This is the largest request a step-limited turn sends - the whole window plus the
   * catalogue - so it was the one place the flip cost the most, on a turn that had by definition
   * been running long enough to have latched 'high'.
   *
   * Recomputed here rather than threaded in from the caller, and that is the deliberate half: this
   * exit has three call sites, two of which are at the top of a loop iteration where the step's own
   * effort has not been computed yet. Asking the same function the same question with the same state
   * is the only version of this that cannot drift from what the step before it sent.
   *
   * Reasoning effort buys output tokens, and this call's output is bounded by `maxOutputTokens`;
   * changing it re-bills the entire prefix at the write price. Keeping it is the cheaper of the two
   * even on the arm where the turn is ending because the money ran out.
   */
  const automaticEffort = reasoningEffortForStep({
    ...state,
    estimatedInputTokens: preparedContext.estimatedInputTokens,
    inputBudgetTokens: modelInputBudget(model.contextTokens, maxOutputTokens, reservedTokens)
  });
  const reasoningEffort = taskReasoningEffort(
    state.ownerReasoningEffort,
    automaticEffort,
    model.reasoning
  );
  const flusher = createStreamFlusher();
  let streamEvents = Promise.resolve();
  // Swallowed for the reason the loop's own frame writer swallows it: this is the call that
  // writes the owner's handoff, and losing the turn's closing message over one failed delta row -
  // a row the closing message itself supersedes - is the failure this exists to prevent.
  const emitStreamFrame = (frame: string): void => {
    streamEvents = streamEvents.then(async () => {
      await event(deps.store, task, key, 'assistant_delta', 'Agent response', {
        markdown: frame,
        append: true
      }).catch(() => undefined);
    });
  };
  /*
   * The SAME routing key the step requests of this turn presented, from the same call that decided
   * the preamble. @see turnRoutingTaskId in `window.ts`.
   *
   * This is the same window and the same preamble the loop has been sending all turn - by the
   * comment above, the largest request the turn sends - so a key derived differently from the one
   * `turn/generate.ts` derives would present that prefix under a name nothing was cached under, on
   * the closing call, after the steps had just paid to write it. The two are pinned against each
   * OTHER in `turn/generate-session.test.ts` rather than each against a literal, because the
   * property that matters here is that they agree.
   *
   * Free by the time it is reached: the anchor was resolved for this task record by the preamble
   * and again by the first step, and the answer is memoised on the record itself.
   */
  const sessionId = sha256(`athanor-task:${await turnRoutingTaskId(deps, task, key)}`).slice(0, 64);
  const response = await deps.withLeaseRenewal(task, () =>
    withRequestDeadline((signal) =>
      gateway.chat(provider, {
        ...routeTo(model),
        messages: preparedContext.messages,
        tools,
        temperature: 0.2,
        maxTokens: maxOutputTokens,
        reasoningEffort,
        ...(model.reasoning ? { reasoningOptions: model.reasoning } : {}),
        sessionId,
        signal,
        onTextDelta: (delta) => {
          const frame = flusher.push(delta);
          if (frame !== null) emitStreamFrame(frame);
        }
      })
    )
  );
  const finalFrame = flusher.drain();
  if (finalFrame !== null) emitStreamFrame(finalFrame);
  await streamEvents;
  /*
   * What a cut-off handoff owes for its prompt, on the same rule the main step has had.
   *
   * This is the streamed call that carries the most of any step-limited turn - the whole window,
   * plus the catalogue - and it was billed straight off `response.usage.inputTokens` with no
   * fallback at all. Usage arrives in the last frame of a stream and a stream that was cut never
   * reaches it, so a handoff that was interrupted billed ZERO input for the largest request of
   * the turn, and the day's spending was computed from it. This side assembled the request a few
   * lines above and knows its size; the catalogue is added back because the estimate covers the
   * messages alone while a provider bills the whole request.
   */
  const billedInputTokens =
    response.usage.estimated && response.usage.inputTokens === 0
      ? preparedContext.estimatedInputTokens + reservedTokens
      : response.usage.inputTokens;
  const credit = usageCredit(model, billedInputTokens, response.usage.outputTokens);
  const costUsd =
    response.usage.costUsd ??
    estimatedInferenceCostUsd(
      model,
      billedInputTokens,
      response.usage.outputTokens,
      response.usage
    );
  state.credits += credit;
  // Not swallowed. This is the one billed call in the product whose ledger write was allowed to
  // fail quietly: the provider had already charged for it, so the money was gone while the box's
  // own total said otherwise, and every spending decision for the rest of that day was computed
  // from a number known to be wrong. There is no route in the product to add an entry by hand.
  // The cost *event* below may still fail without taking the turn down - it is the transcript's
  // account of the charge, not the charge itself.
  await deps.store.recordUsage({
    userId: task.userId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    kind: 'model_inference',
    resourceClass: model.usageClass,
    // The provider's own total, except where there is no provider total: a stream that was cut
    // carries a sum of a reported output and an input nobody reported, and billing the ledger
    // from it would file the same zero the credit line above has just stopped charging.
    quantity: response.usage.estimated
      ? billedInputTokens + response.usage.outputTokens
      : response.usage.totalTokens,
    unit: 'tokens',
    credits: credit,
    costUsd,
    state: 'settled',
    idempotencyKey: stepUsageKey(task.id, turn, state.step),
    providerRef: `${response.metadata.provider}:${response.metadata.model}`
  });
  await event(deps.store, task, key, 'cost', 'Handoff completed', {
    credits: credit,
    costUsd,
    cumulativeCredits: state.credits,
    usage: response.usage,
    metadata: response.metadata,
    // Stamped on both cost paths or on neither: a baseline that carries the build on ordinary steps
    // and drops it on the closing call of every step-limited turn is a baseline with a hole in the
    // one row that is largest.
    build: buildIdentity(),
    // The same value the request carried, from the same variable. Two literals in one file that
    // nothing held together is how a cost line comes to report an effort the request never used.
    reasoningEffort
  }).catch(() => undefined);
  const assistantText = normalizeAssistantText(response.text);
  state.messages.push({
    role: 'assistant',
    content: assistantText,
    ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {})
  });
  /*
   * The verdict on an exhausted turn's own words, reconciled with the line beneath it.
   *
   * The comment here said "deliberately without setting `answered`" and the next line set it,
   * which left a maintainer with two contradictory accounts of a branch that decides whether the
   * owner reads one reply or two. The code is the correct half and this is why: `#completeTurn`
   * publishes the summary as an `assistant_message` only when the turn has not spoken, so setting
   * `answered` here is what makes these words the single reply. Without it the same sentence would
   * arrive twice - once as the bubble published below and once as the summary on the card.
   *
   * The `repairStep` guard is the main loop's rule, unchanged: a turn that ran out of steps while
   * arguing with the harness is restating an answer rather than giving a new one, so its words are
   * not published and the completion summary speaks for it instead.
   */
  if (assistantText && !state.repairStep) {
    state.answered = true;
    await event(deps.store, task, key, 'assistant_message', assistantText.slice(0, 500), {
      markdown: assistantText
    });
  }

  let summary = '';
  let deliverables: unknown[] = [];
  for (const call of response.toolCalls) {
    if (call.name === 'set_plan') {
      try {
        /*
         * With the turn's state, which this call did not use to have.
         *
         * `set_plan` clears `planIsFallback` - the flag that tells the finish hold the plan on
         * screen is the model's rather than the harness's opening guess - and it can only clear
         * it on a state it was given. The handoff is the one call in the loop that ran without
         * one, so the closing plan a step-limited or credit-limited turn writes, the plan the
         * owner is actually left looking at, was the only plan in the product that could not
         * retire that flag. The turn then finished against a hold arguing about a fallback that
         * had been replaced two lines earlier.
         */
        const result = await deps.execute(task, call, key, false, context.webPlan, state);
        await deps.recordToolResult(task, key, state, call, result, model, catalog);
      } catch (error) {
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `Tool failed: ${error instanceof Error ? error.message : 'Tool failed'}`
        });
      }
      continue;
    }
    if (call.name === 'finish') {
      summary = textValue(call.arguments.summary);
      deliverables = Array.isArray(call.arguments.deliverables) ? call.arguments.deliverables : [];
      state.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify({ handedOff: true })
      });
      continue;
    }
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: 'Denied: only set_plan and finish are available on a handoff turn.'
    });
  }
  // Re-read after the handoff turn's own set_plan, so the note the next turn reads describes the
  // corrected plan rather than the stale one this turn was just told to fix.
  const stillOpen = await deps.outstandingPlanSteps(task, key);
  state.messages.push({ role: 'system', content: stepLimitCarryOver(state.step, stillOpen) });
  await deps.completeTurn(
    task,
    key,
    state,
    {
      summary:
        summary ||
        assistantText.slice(0, 400) ||
        `Stopped after ${state.step} steps with work outstanding. Everything produced so far is saved - reply to carry on from here.`,
      deliverables,
      // Deliberately not `verified`. A handoff asserts the opposite of a verified completion: it
      // says the requested outcome was not reached, and the caveats below are the honest record
      // of what is missing. Grounding rules exist to stop an unfinished turn claiming success,
      // and there is no success here to claim.
      verification: {
        status: 'not_applicable',
        evidence: [],
        remainingRisks: stillOpen.slice(0, 20)
      },
      interrupted: true,
      outstanding: stillOpen.slice(0, 20)
    },
    { label: 'Stopped at the step limit with work outstanding' }
  );
};
