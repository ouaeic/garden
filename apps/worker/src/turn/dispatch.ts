import { parkProcessWait } from '../job-waits.js';
import { parkCodingMissionWait } from '../coding-missions.js';
import { ZodError } from 'zod';
/**
 * The batch of calls the model proposed, and the nine gates each one passes before it runs.
 *
 * The gates are ordered by what a call that is answered instead of run leaves behind, and every one
 * of the nine is here because the alternative was observed:
 *
 *   1. **the owner**, re-asked before *every* call rather than once before the batch. A model
 *      routinely proposes several actions at a time, and a single check meant a cancel landing
 *      after the first one still sent the email, published the artifact and fired the POST -
 *      minutes after the interface said the task had stopped;
 *   2. **plan mode**, which answers anything outside the derived read-only fence with a sentence
 *      saying what to do with the step instead. It is second because everything below it can start
 *      a tool, the run at gate 3 included;
 *   3. **the parallel run**, which is the only thing here that overlaps. Reads proposed together
 *      stop queueing behind each other; every decision around them stays exactly where it was, and
 *      the results are recorded strictly in the order the model declared them;
 *   4. **the repeat**, for the eight tools whose answer is a pure function of their arguments;
 *   5. **arguments that would not parse**, told apart from arguments cut off at the output cap,
 *      because what to do about it differs and they used to be told apart by guesswork;
 *   6. **a plan the owner moved** under a call that was already proposed;
 *   7. the tools the harness answers itself - `compact_context`, `notify`, `ask` - plus
 *      `set_acceptance`;
 *   8. **the approval floor**, memoised per model response;
 *   9. and then the call runs.
 *
 * The idempotency key is registered at gate 6 and not at gate 4, which is two gates later than it
 * used to be and is the whole of one repair: the owner edits the plan mid-step, three `file_read`s
 * are answered "replan before acting" - none of them ran - the agent replans and re-issues exactly
 * those three, which is what it was just told to do, and each comes back "which already ran this
 * turn". There is no result to read, only the skip notice, and those three files were unreadable
 * for the rest of the turn.
 *
 * Lifted out of `AgentWorker.run()` unchanged; the three `return`s became `'returned'`, and the
 * approval memo is created here rather than one line above the loop. That is the whole of the edit.
 */
import type { ModelResponse, ModelToolCall } from '@garden/model-gateway';
import type { ModelRelease, WebToolPlan } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import type { AgentState, AgentWorkerConfig } from '../agent-state.js';
import type { AgentApprovalRequirement } from '../approval-state.js';
import { createApprovalFloorMemo, type ApprovalFloorMemo } from '../approval-floor.js';
import { event } from '../tool-recording.js';
import {
  CHECKPOINT_EXEMPT_TOOLS,
  IDEMPOTENT_WITHIN_TURN,
  MAX_ARGUMENT_TRUNCATIONS,
  idempotentCallKey,
  parallelToolRun,
  tombstoneMalformedCall
} from '../turn-bounds.js';
import { textValue } from '../values.js';
import { isMutatingToolCall } from '../write-classification.js';
import { declareAcceptance, type AcceptanceDeclarationDeps } from './acceptance-declaration.js';
import { parkForApproval } from './approval-park.js';
import { recoverApprovalProposal } from './approval-recovery.js';
import type { TurnRun } from './claim.js';
import { recordKeyAuthorized } from './key-ledger.js';
import { executeApprovedCall } from './execute-call.js';
import type { CompactContext, TurnLoopControl, TurnStepBudget } from './loop-context.js';
import type { TurnResumeDeps } from './resume.js';

/**
 * What a turn may still do while the owner has not yet approved the approach.
 *
 * DERIVED, NOT LISTED, and that is the whole of why this set is trustworthy. The obvious shape is a
 * blocklist of the tools that change things, and a blocklist protects the names somebody thought
 * of: the quarantined specialist's read-only fence was a four-name blocklist for years, and
 * `file_patch` - the one tool whose entire purpose is changing a file the specialist is told it
 * cannot change - went straight through it with the whole worker suite green. A mode whose promise
 * is "nothing changes" cannot be defended by a list that admits every tool added after it was
 * written.
 *
 * So the basis is the same conjunction the specialist fence is derived from, of the two sets that
 * containment property actually rests on, and both are consulted here rather than restated:
 *
 *  - `CHECKPOINT_EXEMPT_TOOLS`, which the harness already maintains under exactly the sentence this
 *    mode needs - "tools that cannot change the computer, so a turn made only of these needs no undo
 *    point" - and which already subtracts `REPEATABLE_TOOLS_THAT_WRITE`, because `make -s` and
 *    `cargo check` were measured leaving `Cargo.lock`, `target/` and `tsconfig.tsbuildinfo` behind.
 *    That subtraction is why `code_diagnostics` is refused here: a compiler writes.
 *  - `isMutatingToolCall`, which takes out the one member of that set the checkpoint rule does not:
 *    `set_acceptance` needs no undo point of its own, and declaring a record runs the harness's red
 *    baseline, which executes the owner's build or test command on the owner's computer. Two
 *    derivations disagreed about one name and the stricter one wins, which is the whole reason both
 *    are read. dispatch.test.ts drove that disagreement out; nobody spotted it.
 *
 * A tool added to the catalogue tomorrow is refused here until somebody puts it in both, which is
 * the fail-closed direction; the cost of being wrong the other way is one refused read and a
 * sentence telling the model to plan instead.
 *
 * TWO ARE ADDED BY NAME, and each is added on a proof rather than on a judgement:
 *
 *  - `ask` is on neither set, because it is neither repeatable - a second buzz is a second buzz -
 *    nor something a checkpoint could hold. It changes nothing on the computer (`NON_MUTATING_TOOLS`
 *    in write-classification.ts says so and says why: "A question changes nothing on the computer or
 *    outside it"), and it is the channel the mode exists to end at. A plan mode the agent cannot ask
 *    a question from is a plan mode that guesses.
 *  - `delegate` is admitted on a third proof, not on these two: every tool a specialist can reach is
 *    itself inside the fence, and tool-catalogue.test.ts derives that from `isMutatingToolCall` and
 *    `REPEATABLE_TOOLS` rather than asserting it. So a delegated mission is reading, done in another
 *    window. The test below fails if that stops being true, which is the only thing keeping this
 *    third proof honest.
 *
 * WHAT THIS REFUSES THAT A READER MIGHT NOT EXPECT, said plainly because a mode is judged on what it
 * stops rather than on what it allows:
 *
 *  - EVERY `shell` call, `ls` included. `shell` is on neither set, deliberately - the catalogue test
 *    records why - and the asymmetry in `isMutatingToolCall` runs the wrong way for this mode: it
 *    treats an unrecognised executable with no script as a check, so a bare `deploy.sh` would be
 *    read as reading. That asymmetry is right for the completion clock, where a mislabelled write
 *    costs a second check; here it would let plan mode deploy. `files_list`, `file_read`,
 *    `code_search` and `repo_overview` are the reads that stay.
 *  - EVERY `browser_action`, navigation included. The approval floor already separates the harmless
 *    verbs from the rest, and reusing that list would mean a second copy of it drifting from the
 *    floor's. `read_elements` goes with it and not with the reads, which is the derivation being
 *    taken at its word rather than a judgement. The two bases disagree about it and the set is
 *    their conjunction, so the one that refuses decides: `isMutatingToolCall` does call it a read,
 *    and the checkpoint rule never admitted it at all, because it is absent from
 *    `REPEATABLE_TOOLS`. It is not added back by name either.
 *    `browser_snapshot` is the page read that stays, on the page the browser is already on, and
 *    `web_search` and `parallel_web_read` are how a plan-mode turn reads the web.
 *  - `audio_read`, because it is billed by the minute and writes its transcript beside the recording;
 *    `code_diagnostics`, because a compiler writes; and `set_acceptance`, because declaring a record
 *    runs the red baseline. All three are caught by the two sets without anybody naming them, which
 *    is the property this whole shape was chosen for.
 *
 * WHAT THIS DOES NOT DO. It does not stop the model spending the owner's money: `web_search`,
 * `parallel_web_read`, `image_read`, `document_read` and `delegate` all cost tokens or requests, and
 * a plan-mode turn burns its step budget like any other. Plan mode is a promise about the computer
 * and about what leaves it, not a promise about the bill - the spend ceiling is the bound for that,
 * and it is unchanged in both modes.
 */
export const PLAN_MODE_PERMITTED: ReadonlySet<string> = new Set([
  ...[...CHECKPOINT_EXEMPT_TOOLS].filter((name) => !isMutatingToolCall(name)),
  'ask',
  'propose_deal',
  'delegate'
]);

/**
 * What the model is told when plan mode answers a call instead of running it.
 *
 * It says what to do with the step instead of only saying no, which is the difference between a
 * refusal a model can act on and one it re-proposes: every other answered call in this file is
 * worded that way, and the two that were not were measured costing a turn its whole step budget.
 *
 * It also says, in as many words, that leaving the mode is not the model's to do. That sentence is
 * not the enforcement - the enforcement is that no tool on the wire writes `state.mode`, and
 * dispatch.test.ts drives every name in the lead catalogue to show it - but a model that is refused
 * without being told who can lift the refusal spends its steps looking for the lever.
 *
 * It says what the mode stops and NOT one word more, which is a correction rather than a style. It
 * used to end "nothing that reaches outside", and four permitted tools reach outside:
 * `web_search` and `parallel_web_read` read the web, `delegate` opens another window on it, and
 * `notify` reaches the owner's phone. The cost of the wider claim is not pedantry - `notify` and
 * `ask` are the two channels this mode leaves the model, and a model told that nothing reaches
 * outside will not try the one of them that is not a hard stop.
 */
const planModeRefusal = (tool: string): string =>
  `Plan mode: ${tool} was not run and nothing changed. The user has this conversation in plan mode, so only reading, searching and delegated research run - no commands, no writes, no browser or desktop actions, nothing that reaches out of this computer except reading the web and messaging the user. Work the approach out from what you can read, record it with set_plan, and reply with the plan and anything you need from the user before starting. You cannot leave plan mode; only the user can, and they do it from the conversation.`;

/** What dispatching a batch needs from the worker that owns it. */
export interface TurnDispatchDeps {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  /** @see declareAcceptance in `turn/acceptance-declaration.ts`. */
  readonly acceptance: AcceptanceDeclarationDeps;
  /** @see executeApprovedCall in `turn/execute-call.ts`, which asks for exactly this set. */
  readonly resume: TurnResumeDeps;
  /** One verdict per call per state of the world; the memo throws its verdicts away when a tool starts. */
  approvalForCallOnce(
    memo: ApprovalFloorMemo,
    task: TaskRecord,
    call: ModelToolCall,
    state?: AgentState
  ): Promise<AgentApprovalRequirement | null>;
  /** The parallel read run. Only execution overlaps; every decision stays where it was. */
  runToolCallsTogether(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    calls: readonly ModelToolCall[],
    context: {
      model: ModelRelease;
      catalog: ModelRelease[];
      webPlan: WebToolPlan;
      refreshActivePlan: () => Promise<boolean>;
    }
  ): Promise<void>;
  recordToolResult(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall,
    result: unknown,
    leadModel: ModelRelease,
    catalog: ModelRelease[]
  ): Promise<void>;
  /** Reached here only when the model itself calls `compact_context`. */
  readonly compactContext: CompactContext;
  sendNotice(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall
  ): Promise<void>;
  askUser(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall,
    deferred: readonly ModelToolCall[]
  ): Promise<boolean>;
  proposeDeal(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall
  ): Promise<boolean>;
}

/**
 * Runs the batch.
 *
 * `'returned'` means the turn is over - completed, parked on a question, parked on an approval, or
 * stood down by the owner - and everything owed has already been written; the caller returns
 * without touching the window. `'done'` means the batch was answered and the step may close.
 */
export const dispatchToolCalls = async (
  deps: TurnDispatchDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  response: ModelResponse,
  /**
   * Named `turnRun` rather than `run` because the batch loop below binds `run` to the parallel
   * read run it is assembling, and that name is the one the loop has always read it by.
   */
  turnRun: TurnRun,
  budget: TurnStepBudget,
  control: Pick<TurnLoopControl, 'honorUserControl' | 'refreshActivePlan'>
): Promise<'returned' | 'done'> => {
  const { model, catalog, webPlan, reservedTokens } = turnRun;
  const { maxOutputTokens, turn } = budget;
  const { honorUserControl, refreshActivePlan } = control;
  /*
   * One evaluation of the approval floor per call, per state of the world.
   *
   * The first call of every candidate parallel run was asked about twice: once while the run is
   * chosen, and again on the sequential path the run falls through to when it collapses to a single
   * call. Nothing between the two asks starts a tool - every gate in between either answers the call
   * and continues or registers an idempotency key - so the second ask could only ever repeat the
   * first, at the price of a destination context built out of forty thousand characters of the
   * owner's own words. Held per model response, and the memo throws its own verdicts away the moment
   * `toolsStarted` moves.
   */
  const approvalMemo = createApprovalFloorMemo();
  // The last index a concurrent run has already answered. Those calls have their results in the
  // window and their events on the timeline; walking into them again would run them twice.
  let answeredByRun = -1;
  for (const [callIndex, call] of response.toolCalls.entries()) {
    if (callIndex <= answeredByRun) continue;
    if (state.browserHandoff) break;
    // Re-checked before every call in the batch, not once before it. A model routinely proposes
    // several actions at a time, and the earlier single check meant a cancel landing after the
    // first one still sent the email, published the artifact and fired the POST - minutes after
    // the interface said the task had stopped. honorUserControl seals the calls that never ran,
    // so the transcript stays answerable if the task is later resumed.
    if (await honorUserControl()) return 'returned';
    if (
      call.name === 'coding_agent' &&
      call.arguments.agent === 'garden' &&
      call.arguments.action === 'wait' &&
      (await parkCodingMissionWait(
        deps,
        task,
        key,
        state,
        call,
        response.toolCalls.slice(callIndex + 1)
      ))
    )
      return 'returned';
    /*
     * Plan mode, in front of everything that can start a tool rather than in front of the floor.
     *
     * In front of the parallel run and not behind it, which is a placement and not a formality. The
     * run below starts tools; a gate sitting after it would be relying on `PARALLEL_SAFE_TOOLS`
     * being a subset of the permitted set to hold the promise, and that subset relation is true
     * today, incidental, and written down nowhere either set can see. dispatch.test.ts asserts it
     * anyway, so the redundancy is real rather than assumed - but the gate does not lean on it.
     *
     * Answered, not skipped silently: a tool call with no tool result is a malformed window the
     * provider refuses on the next step, so this takes the same shape as every other gate that
     * answers instead of running. It deliberately does NOT register an idempotency key - the key is
     * registered four gates below, past everything that answers a call, and the repair that put it
     * there is the one this refusal would otherwise re-break: a model told to replan and re-issue
     * its reads must not find those reads retired for the turn.
     *
     * Absent mode is `act`, so an ordinary turn pays one comparison per call and nothing else.
     */
    if (state.mode === 'plan' && !PLAN_MODE_PERMITTED.has(call.name)) {
      await deps.recordToolResult(
        task,
        key,
        state,
        call,
        { skipped: true, reason: planModeRefusal(call.name) },
        model,
        catalog
      );
      continue;
    }
    /*
     * Reads that were proposed together stop queueing behind each other.
     *
     * A frontier model opens a task with four `file_read`s, or a `code_search` beside a
     * `repo_overview`, and each of those is an HTTP round trip to the runner that the next one
     * waited on for no reason - the product had already paid for this parallelism three times
     * over as per-tool workarounds (`parallel_web_read`, the browser_action batch, `delegate`),
     * which is the strongest argument that the loop itself should have it.
     *
     * Only the run's execution overlaps. Every decision around it stays exactly where it was:
     * the stop check above has already run, the floor is asked about each call separately just
     * below, and the results are recorded strictly in the order the model declared them, so the
     * window this produces is the same window the sequential path produced.
     */
    const runLength = parallelToolRun(response.toolCalls, callIndex, state.seenCalls ?? {});
    if (runLength > 1) {
      const run: ModelToolCall[] = [];
      for (const candidate of response.toolCalls.slice(callIndex, callIndex + runLength)) {
        // Per call, never once for the run. A call the floor wants a card for ends the run in
        // front of itself and is left to the sequential path below, which raises the card and
        // defers everything behind it in writing - so the approval order the owner sees is the
        // order the model declared. Every tool in the run is one whose verdict is a pure
        // function of arguments and turn state, so asking early cannot change the answer.
        try {
          if (await deps.approvalForCallOnce(approvalMemo, task, candidate, state)) break;
        } catch (error) {
          // Invalid input belongs to the sequential repair path; it cannot authorize execution.
          if (error instanceof ZodError) break;
          throw error;
        }
        run.push(candidate);
      }
      if (run.length > 1) {
        await deps.runToolCallsTogether(task, key, state, run, {
          model,
          catalog,
          refreshActivePlan,
          webPlan
        });
        answeredByRun = callIndex + run.length - 1;
        continue;
      }
    }
    // Arguments that did not parse mean the response was cut off mid-JSON at the output cap.
    // Running the call anyway sent an empty object into a tool that then failed on a validation
    // error naming neither the truncation nor the way out of it, and the turn spent its
    // remaining steps re-proposing the same oversized call. It is answered instead, because a
    // tool call with no tool result is a malformed turn the provider will refuse next step.
    // An exact repeat of a read that already answered this turn. Re-running it returns the
    // same bytes and teaches the model nothing, which is how a stuck agent spends a whole step
    // budget looking for something in the same place. It is answered rather than refused: the
    // call still gets a tool result, because a call without one is a malformed window, and the
    // result names the earlier id so the model can cite or re-read that instead.
    if (IDEMPOTENT_WITHIN_TURN.has(call.name)) {
      const callKey = idempotentCallKey(call);
      const earlier = state.seenCalls?.[callKey];
      if (earlier) {
        await deps.recordToolResult(
          task,
          key,
          state,
          call,
          {
            skipped: true,
            reason: `This is the same ${call.name} call as ${earlier}, which already ran this turn and would return the same result. Read that result again, or change the arguments - a different path, different words, a wider search - if it did not answer the question.`
          },
          model,
          catalog
        );
        continue;
      }
    }
    if (call.parseFailed) {
      const truncations = (state.argumentTruncations ?? 0) + 1;
      state.argumentTruncations = truncations;
      const cutOff = call.argumentsTruncated === true;
      /*
       * The payload that would not parse, taken back out of the window the moment it is
       * answered. @see tombstoneMalformedCall in `turn-bounds.ts` for what keeping it cost -
       * the short version is that the estimator sizes the window from bytes the adapter never
       * sends, so one cut-off write made the turn compact away real history to make room for a
       * payload that does not exist on the wire.
       *
       * Before the result rather than after it only so the warning below can report how much
       * was removed; the call itself stands either way, because a tool call with no tool result
       * is the malformed turn this whole branch exists to avoid producing.
       */
      const tombstoned = tombstoneMalformedCall(state.messages, call.id);
      await event(
        deps.store,
        task,
        key,
        'warning',
        cutOff
          ? `${call.name} was cut off mid-argument`
          : `${call.name} arrived with arguments that would not parse`,
        {
          tool: call.name,
          attempt: truncations,
          bytes: tombstoned
        }
      );
      await deps.recordToolResult(
        task,
        key,
        state,
        call,
        {
          skipped: true,
          /*
           * Which of the two it was decides what to do about it, and they used to be told
           * apart by guesswork - every unparseable call was reported as truncation, so a model
           * that had simply written bad JSON was advised to send less of it.
           */
          reason: cutOff
            ? truncations >= MAX_ARGUMENT_TRUNCATIONS
              ? `The arguments for ${call.name} were cut off at the model's output limit for the ${truncations}th time, so it was not run. Stop retrying this call: do the work in smaller pieces, or reply and say what could not be written.`
              : `The arguments for ${call.name} were cut off at the model's output limit, so it was not run and nothing changed. Re-issue it with a smaller payload - write the file in parts with file_write then file_patch, or shorten the content.`
            : `The arguments for ${call.name} were not valid JSON, so it was not run and nothing changed. Send the call again with well-formed arguments - the payload was ${call.rawArguments?.length ?? 0} characters, so length was not the problem.`
        },
        model,
        catalog
      );
      continue;
    }
    const planChanged = await refreshActivePlan();
    if (planChanged && call.name !== 'set_plan') {
      await deps.recordToolResult(
        task,
        key,
        state,
        call,
        {
          skipped: true,
          reason:
            'The user changed the active plan after this tool call was proposed. Replan before acting.'
        },
        model,
        catalog
      );
      continue;
    }
    /*
     * Registered here, past every gate that answers a call instead of running it.
     *
     * It used to be registered at the repeat check above, which is two gates too early. The
     * owner edits the plan mid-step, three `file_read`s are answered "replan before acting" -
     * none of them ran - the agent replans and re-issues exactly those three, which is what it
     * was just told to do, and each one comes back "which already ran this turn and would
     * return the same result. Read that result again": there is no result to read, only the
     * skip notice, and those three files are unreadable for the rest of the turn. Truncation
     * has the same shape and a sharper edge, because `repo_overview` has no required
     * parameters, so a valid minimal call and a call cut off mid-JSON are both `{}` - one
     * truncated `repo_overview` retired the tool for the whole turn.
     *
     * Nothing between here and `#execute` answers one of these eight without running it. An
     * approval can park one, and that is deliberate: the parked call is resumed by id rather
     * than re-proposed, so the key belongs to the call the owner was asked about.
     */
    if (IDEMPOTENT_WITHIN_TURN.has(call.name))
      state.seenCalls = {
        ...(state.seenCalls ?? {}),
        [idempotentCallKey(call)]: call.id
      };
    if (call.name === 'compact_context') {
      // Compaction runs while this call is still unanswered, which is precisely what keeps the
      // assistant message that made it - and every result already pushed for its batch - out of
      // the condensed span; the result below would otherwise have no call to attach to.
      const outcome = await deps.compactContext(task, key, state, {
        model,
        catalog,
        maxOutputTokens,
        // The same count the budget check above used, not a second one worked out here: the
        // catalogue this step sent is the catalogue the next step sends, and two ways of
        // measuring it is exactly how the trigger and the target came apart.
        reservedTokens,
        trigger: 'agent',
        turn,
        note: textValue(call.arguments.finishedPhase).trim().slice(0, 2_000)
      });
      state.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: outcome
          ? JSON.stringify({
              compacted: true,
              condensedMessages: outcome.condensedMessages,
              briefParts: outcome.brief.sections.length,
              estimatedInputTokens: outcome.estimatedTokensAfter,
              note: 'The condensed turns are now recorded in the running brief above your recent messages. Re-read files or re-run checks for exact detail.'
            })
          : JSON.stringify({
              compacted: false,
              reason:
                'There is not enough superseded conversation to condense yet. Keep working; the harness compacts on its own as the window fills.'
            })
      });
      state.turnToolResults ??= {};
      state.turnToolResults[call.id] = { name: call.name, success: outcome !== null };
      // Republished after the result, matching set_plan, so a tool call is never separated from
      // its own result by an unrelated system message.
      if (outcome) await refreshActivePlan();
      continue;
    }
    if (call.name === 'notify') {
      await deps.sendNotice(task, key, state, call);
      continue;
    }
    if (call.name === 'ask') {
      // The same shape as the approval park below: everything the model proposed behind the
      // question is answered in writing before the turn is saved, so the window it resumes into
      // is well formed and nothing behind a decision runs before the decision is made.
      if (await deps.askUser(task, key, state, call, response.toolCalls.slice(callIndex + 1)))
        return 'returned';
      continue;
    }
    if (call.name === 'propose_deal') {
      if (await deps.proposeDeal(task, key, state, call)) return 'returned';
      continue;
    }
    if (call.name === 'set_acceptance') {
      // @see declareAcceptance in `turn/acceptance-declaration.ts`, where the ninety-three
      // lines that ran here now live - including the red baseline, which is the only part of
      // this mechanism the model cannot satisfy by deciding its own work is good.
      await declareAcceptance(deps.acceptance, task, key, state, call, turn);
      continue;
    }
    /*
     * The undo point, in front of the floor rather than behind it.
     *
     * It used to be taken inside `executeApprovedCall`, one gate later, and that put the floor in
     * the position of answering a question about a fact that did not exist yet. The destructive
     * rule frees a delete strictly inside `CHECKPOINT_CONTENT` because a rewind puts it back, and
     * it reads `ApprovalContext.undoPoint` to know there is a rewind; absent keeps the card. So a
     * turn whose FIRST non-exempt call was itself a recoverable delete paid a card, and the same
     * `rm -rf dist` two calls later did not. Nothing about the delete decided that - only where it
     * happened to fall in the batch, which is not a bound, and no rig row could see it.
     *
     * Moving it here answers the question the rule is actually asking. `#ensureTurnUndoPoint` is
     * unconditional for a non-exempt tool and returns immediately for an exempt one, so this costs
     * an exempt call nothing; and it records `{ turn, id: null }` when the runner REFUSES - a
     * workspace over `CHECKPOINT_MAX_FILES`, a full host disk - which the floor reads as no rewind
     * and cards. The fail-closed direction is not traded away by the move, it is made exact: before
     * it, "the checkpoint has not been taken yet" and "the checkpoint could not be taken" were the
     * same absent fact.
     *
     * What it costs, said plainly: a call the floor CARDS now takes a checkpoint it did not take
     * before, and if the owner declines it, that walk bought nothing. An approved one pays it
     * either way - `turn/resume.ts` takes the undo point before running the approved call - so the
     * new cost is exactly one workspace walk per declined or unanswered card. A turn that only
     * reads still costs nothing, because every tool in it is exempt.
     */
    await deps.resume.ensureTurnUndoPoint(task, key, state, call.name);
    let approval: AgentApprovalRequirement | null;
    try {
      approval = await deps.approvalForCallOnce(approvalMemo, task, call, state);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      if (IDEMPOTENT_WITHIN_TURN.has(call.name) && state.seenCalls)
        delete state.seenCalls[idempotentCallKey(call)];
      await deps.resume.recordToolFailure(task, key, state, call, error);
      continue;
    }
    if (approval) {
      if (recoverApprovalProposal(task, state, call, approval)) {
        if (IDEMPOTENT_WITHIN_TURN.has(call.name) && state.seenCalls)
          delete state.seenCalls[idempotentCallKey(call)];
        await event(deps.store, task, key, 'status', 'Checking another way to complete this step', {
          toolCallId: call.id,
          tool: call.name,
          executed: false,
          reason: approval.recovery
        });
        continue;
      }
      // The card, the calls behind it, and the saved state, in that order and together.
      // @see parkForApproval in `turn/approval-park.ts`.
      await parkForApproval(
        { store: deps.store, config: deps.config },
        task,
        key,
        state,
        call,
        approval,
        response.toolCalls.slice(callIndex + 1)
      );
      return 'returned';
    }
    if (call.name === 'process' && call.arguments.action === 'wait') {
      try {
        if (
          await parkProcessWait(
            deps,
            task,
            key,
            state,
            call,
            response.toolCalls.slice(callIndex + 1),
            { model, catalog, webPlan }
          )
        )
          return 'returned';
      } catch (cause) {
        await deps.resume.recordToolFailure(task, key, state, call, cause);
      }
      continue;
    }
    await recordKeyAuthorized(deps.store, task, key, call);
    // Run it, record it, and leave behind whatever a worker that died mid-call would need.
    // @see executeApprovedCall in `turn/execute-call.ts`.
    await executeApprovedCall(
      deps.resume,
      task,
      key,
      state,
      call,
      { model, catalog, webPlan },
      refreshActivePlan
    );
  }
  return 'done';
};
