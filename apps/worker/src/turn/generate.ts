import type { ReasoningEffort } from '@garden/contracts';
/**
 * The one call in the turn that spends the owner's money, and the four watches around it.
 *
 * This is the centre of `run()` and the last part of it to be lifted out. It sends one request and
 * comes back with one of four answers, and every one of the four exists because the alternative was
 * observed:
 *
 *   - **halted** - the owner pressed Stop, or another claimant took the task. Read off the watch's
 *     own record and never off the response: the gateway hands back what a stopped generation had
 *     produced rather than throwing, so a Stop landing after the first token arrives here *with* a
 *     response, and a branch gated on `response === null` stopped firing for exactly the stops it
 *     was written for. On the `stopped` arm the tokens are still billed - the provider generated
 *     them, whoever ended the generation; on `disowned` nothing at all is written, because every
 *     row would land in the middle of somebody else's trajectory;
 *   - **retry** - the route refused the window as too large and it has been condensed, or the
 *     repetition watch fired. Three different roads to the same `continue`;
 *   - **generated** - a response, already billed, with its frames flushed and settled;
 *   - or it throws, when the request could not be derived from the log it is supposed to be a
 *     function of.
 *
 * The ordering that matters most is billing against the aborts. A generation stopped for repetition
 * once took a `continue` from *above* the billing block, so the one generation the box stops on
 * purpose was the one generation that cost $0.00 on the ledger and left `lastStepUsd` at the
 * previous step's figure - the number the spend guard prices the next step from. Every abort path
 * here reaches billing, or is one where nothing was generated to bill.
 *
 * Lifted out of `AgentWorker.run()` unchanged; one `return` became `'halted'`, three `continue`s
 * became `'retry'`, and the fall-through became `'generated'`. That is the whole of the edit.
 */
import { GardenError, sha256 } from '@garden/core';
import type { ModelRelease } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import {
  interruptedResponseOf,
  type ModelResponse,
  type ModelToolCall
} from '@garden/model-gateway';
import type { AgentState, AgentWorkerConfig } from '../agent-state.js';
import type { AgentRunnerClient } from '../runner-client.js';
import { materializeNativeInputs } from '../native-input.js';
import { estimatedContextTokens, prepareModelContext, type PreparedContext } from '../context.js';
import { routeTo } from '../routing.js';
import { degenerateRepeat, normalizeAssistantText } from '../streaming.js';
import { event } from '../tool-recording.js';
import { requestToolsFor } from '../request-tools.js';
import { MAX_CONTEXT_OVERFLOW_REPAIRS } from '../turn-bounds.js';
import { requestDerivationBreach } from '../turn-control.js';
import { startStopWatch, withRequestDeadline } from '../turn-lifecycle.js';
import { turnRoutingTaskId } from '../window.js';
import type { TurnRun } from './claim.js';
import type { CompactContext, TurnLoopControl, TurnStepBudget } from './loop-context.js';
import type { PreparedStepRequest } from './request.js';
import { createStreamChannel } from './stream-channel.js';

/** What generating one step needs from the worker that owns it. */
export interface TurnGenerateDeps {
  readonly runner: AgentRunnerClient;
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  /** Keeps the lease alive across a generation that outruns it, which a full window routinely does. */
  withLeaseRenewal<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T>;
  checkpoint(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<void>;
  /** The ledger row. Every abort path that generated a token reaches this. */
  billModelStep(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    input: {
      response: ModelResponse;
      model: ModelRelease;
      preparedContext: PreparedContext;
      reservedTokens: number;
      turn: number;
      reasoningEffort: ReasoningEffort | undefined;
      /** @see TurnRun.measuringThroughput - true on the turn that reads the model's ceiling. */
      measuringThroughput?: boolean;
    }
  ): Promise<void>;
  /** Reached here only to repair a window the route refused as too large. */
  readonly compactContext: CompactContext;
  /** Tells the model what it just did, which is a correction it can act on rather than a dead turn. */
  noteRepeatingAnswer(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    repeated: string
  ): Promise<void>;
}

/** One of four, and the caller branches on nothing else. */
export type GeneratedStep =
  /** The owner's Stop, or another claimant. Everything owed has been written; return. */
  | { readonly outcome: 'halted' }
  /** A refused window repaired, or a repetition stopped. Send the step round again. */
  | { readonly outcome: 'retry' }
  /** Billed, flushed and settled. */
  | { readonly outcome: 'generated'; readonly response: ModelResponse };

/** Sends one step's request and settles everything the answer owes the owner. */
export const generateModelStep = async (
  deps: TurnGenerateDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  run: TurnRun,
  budget: TurnStepBudget,
  request: PreparedStepRequest,
  control: Pick<TurnLoopControl, 'honorUserControl' | 'refreshActivePlan'>
): Promise<GeneratedStep> => {
  const { model, catalog, gateway, provider, requestTools, withdrawnTools, reservedTokens } = run;
  const { maxOutputTokens, turn } = budget;
  const { preparedContext, reasoningEffort, windowOptions } = request;
  const { honorUserControl, refreshActivePlan } = control;
  /*
   * The three channels this generation writes to the owner's timeline while it is still being
   * generated. @see createStreamChannel in `turn/stream-channel.ts`, where the hundred and nine
   * lines that used to sit here - between assembling the request and sending it - now live.
   *
   * The ownership question travels as an accessor because the watch that answers it is created
   * with the request, below: `disowned` means another claimant is already running this task,
   * and every row this run writes from that moment lands in the middle of *their* trajectory.
   * The halt branch below already refuses to bill or to write closing state on that arm for
   * exactly this reason; the frame channel is the loudest of the three and did not.
   *
   * `stopped` is the opposite case and is deliberately left alone: that is the owner's own
   * Stop, on their own conversation, and the words they watched being written are theirs to
   * keep.
   */
  const channel = createStreamChannel(
    { store: deps.store },
    task,
    key,
    state,
    () => stopWatch.halt === 'disowned'
  );
  // Renewed for the same reason a long tool call is: the lease is two minutes and a
  // high-reasoning turn on a full window routinely runs longer, at which point any other worker
  // polling for work can lease this task and run the identical trajectory a second time.
  /*
   * Stopped the moment it starts looping rather than at the provider's ceiling.
   *
   * A model that answers and then repeats one sentence spends the whole output budget on it -
   * seventeen thousand tokens and a quarter of an hour, twice in one evening, ending in a
   * timeout the owner is shown as a failure. Nothing here was watching the text itself. The
   * check runs on the accumulating tail and aborts this request; the loop below then tells the
   * model what it did, which is a correction it can act on rather than a dead turn.
   */
  let loopedOn = '';
  let thought = '';
  /**
   * The route's refusal of an oversized window, held for the repair below rather than thrown.
   * A holder rather than a bare `let` for the reason `firstToken` above is one: the assignment
   * happens inside a callback, which the compiler's flow analysis does not follow.
   */
  const refusedWindow: { error?: GardenError } = {};
  const interruptedFailure: { error?: Error } = {};
  const looping = new AbortController();
  let streamed = '';
  /*
   * The request, checked against the log it is supposed to be a function of, immediately before
   * it is sent - and the turn failed rather than billed if it is not.
   *
   * @see requestDerivationBreach in `turn-control.ts` for the three classes and why the largest
   * control in the product is the one that gets this. It is asked here, past every branch that
   * can still edit the window - the taint notice, the overflow repair, the compaction - and in
   * front of the one call that spends the owner's money on it.
   */
  const derivationBreach = requestDerivationBreach({
    prepared: preparedContext.messages,
    rederived: prepareModelContext(
      state.messages,
      model.contextTokens,
      maxOutputTokens,
      windowOptions
    ).messages,
    sent: requestTools,
    // Re-derive from the frozen capabilities and the persisted activation order.
    entitled: requestToolsFor(
      run.surfaces,
      run.connectorKinds,
      state.enabledToolGroups ?? [],
      withdrawnTools
    ),
    reservedTokens,
    reservedTokensOfSent: Math.ceil(JSON.stringify(requestTools).length / 4)
  });
  if (derivationBreach)
    throw new GardenError(
      'request_not_derivable',
      `This turn stopped before sending a request it could not account for: ${derivationBreach}. Nothing it produced was rolled back - reply to carry on.`
    );
  /*
   * The routing key the cached prefix was written under, which on a recent enough retry is the
   * parent's and not this fork's.
   *
   * Such a retry's whole preamble is the parent's byte for byte - the two frozen blocks are built
   * from the family's request and instant, and the memory pack is the parent's row copied - so
   * presenting a fresh key here would hand a matching prefix to a route that had been told it
   * belongs to a conversation it has never seen. "Recent enough" is not this line's judgement to
   * make: the same call the preamble makes is what answers it, so a fork whose inheritance was
   * refused for age, for a foreign encryption context or for a deleted ancestor cannot be offered
   * under a name it does not match. @see turnRoutingTaskId in `window.ts`.
   *
   * Derived before the request rather than inside it because it is now awaited. It costs one
   * primary-key read per TURN on a fork and none at all otherwise - `assemblePreamble` has already
   * resolved the same anchor for this same task record before the first step runs, and the answer
   * is memoised on it - which is what makes a per-step derivation affordable where the previous
   * comment here said it was not.
   *
   * `handoff.ts` derives the same key from the same call: the closing handoff of this turn sends
   * the same window, so the two must agree, and they are pinned against each OTHER rather than
   * against a literal in `generate-session.test.ts`.
   */
  const sessionId = sha256(`garden-task:${await turnRoutingTaskId(deps, task, key)}`).slice(0, 64);
  const nativeRequest = await materializeNativeInputs(
    deps.runner,
    task,
    state,
    preparedContext.messages,
    model
  );
  const stopWatch = startStopWatch(() => deps.store.taskClaim(task.id), deps.config.WORKER_ID);
  const response = await deps
    .withLeaseRenewal(task, () =>
      withRequestDeadline((signal) =>
        gateway.chat(provider, {
          ...routeTo(model),
          ...nativeRequest,
          // How to choose between the companies serving this model. Absent on a route where there
          // is only ever one of them. @see providerPreferences.
          ...(run.providerPreferences ? { providerPreferences: run.providerPreferences } : {}),
          // No provider-side tools ride here, on any route. The agent's request offers the model
          // the tools the model calls; the provider's search is spent by `#providerWebSearch`, on
          // a request built for it, when the model calls `web_search`. Sending it alongside would
          // mean the same capability twice - once under a name the model can use and once under a
          // name only the provider can - and which one answered would depend on the model's mood.
          tools: requestTools,
          reasoningEffort,
          ...(model.reasoning ? { reasoningOptions: model.reasoning } : {}),
          sessionId,
          signal: AbortSignal.any([signal, looping.signal, stopWatch.signal]),
          onTextDelta: (delta) => {
            const frame = channel.streamFlusher.push(delta);
            if (frame !== null) channel.emitStreamFrame(frame);
            if (loopedOn) return;
            streamed = (streamed + delta).slice(-4_000);
            const repeat = degenerateRepeat(streamed);
            if (repeat) {
              loopedOn = repeat;
              looping.abort();
            }
          },
          onReasoningDelta: (delta) => {
            const frame = channel.reasoningFlusher.push(delta);
            if (frame !== null) channel.emitReasoningFrame(frame);
            // The same watch over the thinking. A reasoning route loops there as surely as in the
            // answer, and there nobody sees it: measured on live runs, one reply thought "Let me
            // write." 13,438 times - 63,000 tokens and six minutes - before it made its call.
            if (loopedOn) return;
            thought = (thought + delta).slice(-4_000);
            const repeat = degenerateRepeat(thought);
            if (repeat) {
              loopedOn = repeat;
              looping.abort();
            }
          }
        })
      )
    )
    .catch((error: unknown) => {
      const partial = interruptedResponseOf(error);
      if (partial && error instanceof Error) {
        interruptedFailure.error = error;
        return partial;
      }
      /*
       * A window the route will not take, which is the one refusal at this status a caller can
       * do something about. It is repaired below rather than here so the repair happens with
       * the turn's own state in hand, and it is bounded in that state rather than in a local
       * so a resume cannot hand the same refusal a fresh allowance.
       */
      if (
        error instanceof GardenError &&
        error.code === 'provider_context_overflow' &&
        (state.contextOverflowRepairs ?? 0) < MAX_CONTEXT_OVERFLOW_REPAIRS
      ) {
        refusedWindow.error = error;
        return null;
      }
      // Only the aborts this turn raised itself. Everything else - a deadline, a provider fault
      // - is still the caller's to handle, and is rethrown untouched. The stop is recognised by
      // the watch's own record rather than by the error, because a stop that lands before the
      // response headers reaches here as `provider_unavailable` and would be failed as one.
      if (!loopedOn && !stopWatch.halt) throw error;
      return null;
    })
    .finally(() => stopWatch.stop());
  if (response && state.pendingNativeInputs?.length) delete state.pendingNativeInputs;
  /*
   * Read off the watch and not off the response, deliberately.
   *
   * The gateway now hands back what a stopped generation had produced rather than throwing, so
   * a Stop that lands after the first token arrives here with a response in hand - and gated on
   * `response === null` this branch stopped firing for exactly the stops it was written for.
   * That is the shape of the last defect this file learnt: a repair to one arm of a branch
   * quietly changed what reached the other.
   */
  if (stopWatch.halt) {
    // The words that had arrived are the owner's - they watched them being written - so the
    // partial frames are flushed rather than dropped. Nothing is added to the window: half a
    // sentence with its tool calls cut off is not a turn a resumed task can carry. On the
    // `disowned` arm they are not the owner's and not this run's to write, and `channel.emitStreamFrame`
    // refuses them; the drains still run so the flushers are left empty either way.
    const stoppedFrame = channel.streamFlusher.drain();
    if (stoppedFrame !== null) channel.emitStreamFrame(stoppedFrame);
    const stoppedReasoning = channel.reasoningFlusher.drain();
    if (stoppedReasoning !== null) channel.emitReasoningFrame(stoppedReasoning);
    await channel.settle().catch(() => undefined);
    // `stopped` is the owner, and honorUserControl is what records the trajectory and says so on
    // the timeline. `disowned` is another claimant already running this task, and there this run
    // ends without writing or saying anything at all - every write it could make would land on
    // somebody else's trajectory, and the unguarded closing write would take their lease with it.
    if (stopWatch.halt === 'stopped') {
      // The tokens were generated and the provider billed them, whoever ended the generation.
      // Only on this arm: a disowned run writing a ledger row would be writing it against a
      // trajectory another claimant is in the middle of.
      if (response)
        await deps
          .billModelStep(task, key, state, {
            response,
            model,
            preparedContext,
            reservedTokens,
            turn,
            reasoningEffort,
            measuringThroughput: run.measuringThroughput
          })
          .catch(() => undefined);
      await honorUserControl();
    }
    return { outcome: 'halted' };
  }
  /*
   * The window was refused as too large, so it is condensed to the size the route named and the
   * step is sent again.
   *
   * The same property the signed-reasoning refusal has: the identical bytes are refused
   * identically for ever, and a refused request appends nothing, so the window never advances
   * past the message that overflowed it. Before this, a resumed task rebuilt the same window,
   * sent the same request and died at the same step for as long as the owner kept replying.
   */
  if (refusedWindow.error) {
    state.contextOverflowRepairs = (state.contextOverflowRepairs ?? 0) + 1;
    await channel.settle().catch(() => undefined);
    const limit = Number(refusedWindow.error.details?.contextLimitTokens);
    await event(
      deps.store,
      task,
      key,
      'warning',
      `${model.displayName} refused this conversation as too large for it, so earlier work was condensed and the step was sent again`,
      {
        code: refusedWindow.error.code,
        ...(Number.isFinite(limit) ? { contextLimitTokens: limit } : {}),
        attempt: state.contextOverflowRepairs
      }
    );
    const compacted = await deps.compactContext(task, key, state, {
      model,
      catalog,
      maxOutputTokens,
      reservedTokens,
      trigger: 'budget',
      turn,
      ...(Number.isFinite(limit) && limit > 0 ? { contextTokensLimit: limit } : {})
    });
    if (compacted) await refreshActivePlan();
    // The estimate the next iteration's compaction trigger reads. Left at the number that was
    // just refused, the trigger would fire again immediately on a window that has already been
    // condensed; left at the pre-compaction estimate it would not fire when it should.
    state.preparedInputTokens = estimatedContextTokens(state.messages);
    return { outcome: 'retry' };
  }
  // The repetition watch fired before a single character came back - a repeat detected in the
  // reasoning channel, or an abort that landed before the response headers. There is nothing to
  // bill and nothing to supersede; the model is told what it did and the turn carries on. The
  // ordinary case, where the repeat is exactly what was generated, arrives with a response and
  // is handled after the billing block, because those tokens were spent.
  if (response === null) {
    const finalLoopFrame = channel.streamFlusher.drain();
    if (finalLoopFrame !== null) channel.emitStreamFrame(finalLoopFrame);
    await channel.settle();
    await channel.noteDroppedFrames();
    await deps.noteRepeatingAnswer(task, key, state, loopedOn);
    return { outcome: 'retry' };
  }
  const finalFrame = channel.streamFlusher.drain();
  if (finalFrame !== null) channel.emitStreamFrame(finalFrame);
  const finalReasoning = channel.reasoningFlusher.drain();
  // A route that streamed thinking but reports none back keeps the frame path, because dropping
  // the tail there would lose the last of the thinking rather than consolidate it.
  if (response.reasoning) channel.emitWholeReasoning(response.reasoning);
  else if (finalReasoning !== null) channel.emitReasoningFrame(finalReasoning);
  await channel.settle();
  await channel.noteDroppedFrames();
  await deps.billModelStep(task, key, state, {
    response,
    model,
    preparedContext,
    reservedTokens,
    turn,
    reasoningEffort,
    measuringThroughput: run.measuringThroughput
  });
  /*
   * The repeat, now that it has been paid for.
   *
   * This sits after the billing block and not before it, which is the whole of the repair: the
   * abort used to `continue` from above the block, so the one generation the box stops on
   * purpose was the one generation that cost $0.00 on the ledger and left `lastStepUsd` at the
   * previous step's figure - the number the spend guard prices the next step from.
   *
   * The words are not added to the window. Half a reply and four hundred copies of one sentence
   * is not a turn a later request can carry, and the model is told what it did instead. They are
   * published once, as the row that supersedes the delta frames the owner watched arrive: those
   * frames are otherwise kept and decrypted again on every reopen of the conversation, because
   * nothing else in this path ever writes the assistant message that replaces them.
   */
  if (loopedOn) {
    const repeated = normalizeAssistantText(response.text);
    if (repeated)
      await event(
        deps.store,
        task,
        key,
        'assistant_message',
        repeated.slice(0, 500),
        { markdown: repeated },
        { replacesEarlierFrames: true }
      ).catch(() => undefined);
    await deps.noteRepeatingAnswer(task, key, state, loopedOn);
    return { outcome: 'retry' };
  }
  // Settle generated tokens before normal provider recovery parks this turn; never dispatch its tools.
  if (interruptedFailure.error) {
    state.step += 1;
    await deps.checkpoint(task, key, state);
    throw interruptedFailure.error;
  }
  return {
    outcome: 'generated',
    response: {
      ...response,
      toolCalls: response.toolCalls
        .map(knownToolCall(requestTools.map((tool) => tool.name)))
        .map(shellCommandCall)
        .map(filePatchCall)
    }
  };
};

/**
 * A call whose tool name a model wrote with stray characters after it - `file_patch活了` - is the
 * offered tool it starts with, when what follows could not be part of a name. Answered as unknown,
 * the model spends a whole step sending the same call again.
 */
export const knownToolCall =
  (names: readonly string[]) =>
  (call: ModelToolCall): ModelToolCall => {
    if (names.includes(call.name)) return call;
    const match = names
      .filter((name) => call.name.startsWith(name) && !/^[\w-]/.test(call.name.slice(name.length)))
      .sort((a, b) => b.length - a.length)[0];
    return match ? { ...call, name: match } : call;
  };

/**
 * A shell call written as a command line, in the executable-and-arguments shape every later reader
 * of a call expects - the approval floor, the write classifier, the checkpoint set - so none of
 * them meets a second spelling. Models write a command line; asked for an argv, they wrapped every
 * command in bash -lc themselves, or left the executable out and were refused.
 */
/** An argument list a model sent as the JSON text of a list rather than as the list itself. */
const listedArgs = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((part) => typeof part === 'string')
      ? parsed
      : value;
  } catch {
    return value;
  }
};

export const shellCommandCall = (call: ModelToolCall): ModelToolCall => {
  if (call.name !== 'shell') return call;
  const listed = listedArgs(call.arguments.args);
  if (listed !== call.arguments.args)
    call = { ...call, arguments: { ...call.arguments, args: listed } };
  const { command, ...rest } = call.arguments;
  if (typeof rest.executable === 'string') return call;
  if (typeof command === 'string')
    return { ...call, arguments: { ...rest, executable: 'bash', args: ['-lc', command] } };
  // A script with its interpreter left out: `args: ["-lc", script]` can only mean bash.
  const args = Array.isArray(rest.args) ? rest.args : [];
  if (args[0] === '-lc' || args[0] === '-c')
    return { ...call, arguments: { ...rest, executable: 'bash' } };
  return call;
};

/**
 * A patch written with its path once at the top, or as one edit with no list, in the per-entry
 * shape every later reader of the call expects.
 */
export const filePatchCall = (call: ModelToolCall): ModelToolCall => {
  if (call.name !== 'file_patch') return call;
  const { path, oldText, newText, replaceAll, patches, ...rest } = call.arguments;
  const listed = Array.isArray(patches) ? (patches as Array<Record<string, unknown>>) : [];
  const entries = listed.length
    ? listed.map((entry) =>
        entry.path === undefined && path !== undefined ? { path, ...entry } : entry
      )
    : typeof oldText === 'string'
      ? [{ path, oldText, newText, ...(replaceAll === undefined ? {} : { replaceAll }) }]
      : listed;
  return { ...call, arguments: { ...rest, patches: entries } };
};
