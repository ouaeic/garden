import { waitForQuestion } from '../questions.js';
/** Validate completion evidence, plan coverage, acceptance and delivery before ending the turn. */
import type { ModelToolCall } from '@athanor/model-gateway';
import type { TaskRecord } from '@athanor/data';
import { deliveryFilePath, mediaDeliveryState } from '@athanor/contracts';
import type { MemoryDeadEndCheck } from '@athanor/core';
import {
  acceptanceFailureMessage,
  acceptanceObservation,
  acceptancePassedEvidence,
  type AcceptanceCommandCheck,
  type AcceptanceRecord,
  type AcceptanceResult
} from '../acceptance.js';
import type { AgentState, AgentWorkerConfig } from '../agent-state.js';
import {
  citableEvidence,
  completionVerification,
  harnessEvidence,
  harnessVerificationStatus,
  observedCommands,
  type CompletionVerification
} from '../completion.js';
import type { DataStore } from '@athanor/data';
import { event } from '../tool-recording.js';
import {
  ACCEPTANCE_COULD_NOT_RUN_CAVEAT,
  ACCEPTANCE_EARLIER_TURN_CAVEAT,
  ACCEPTANCE_FAILED_CAVEAT,
  CAVEAT_BESIDE_THE_TICK,
  MAX_ACCEPTANCE_FAILURES,
  MAX_FINISH_REJECTIONS
} from '../turn-bounds.js';
import { textValue } from '../values.js';
import { declaredTaskOutputs, resolveDelivery } from '../delivery.js';
import type { AgentRunnerClient } from '../runner-client.js';
import { applyPresentationTitle } from '../presentation-title.js';

/** What completing a turn needs from the worker that owns it. */
export interface TurnFinishDeps {
  readonly runner: AgentRunnerClient;
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  outstandingPlanSteps(task: TaskRecord, key: Uint8Array): Promise<string[]>;
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
  completeTurn(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    completion: {
      summary: string;
      answer?: string;
      deliverables?: unknown[];
      verification: CompletionVerification;
      interrupted?: boolean;
      outstanding?: string[];
      acceptance?: string[];
      verifiedCommands?: readonly AcceptanceCommandCheck[];
    },
    options?: { label?: string; deadEnds?: readonly MemoryDeadEndCheck[] }
  ): Promise<void>;
}

/**
 * `held` means the model was told why and the batch loop must move to the next call; `completed`
 * means the turn is over and the caller must return.
 */
export type FinishOutcome = 'held' | 'completed' | 'parked';

export const handleFinishCall = async (
  deps: TurnFinishDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall,
  /** The turn this step belongs to, and the prose the model wrote alongside the call. */
  step: { turn: number; assistantText: string }
): Promise<FinishOutcome> => {
  if (state.question) {
    await waitForQuestion(deps, task, key, state, call);
    return 'parked';
  }
  const { turn, assistantText } = step;
  const summary = textValue(call.arguments.summary, assistantText || 'Task complete');
  const checked = completionVerification(state, call.arguments.verification);
  /*
   * Past the ceiling the turn ends honestly, exactly as a failed acceptance check does
   * below, rather than being thrown away.
   *
   * This used to raise `completion_unverified`, which marks the task FAILED. Observed: an
   * agent built the page it was asked for, served it, published a working preview and
   * wrote a correct summary - and the run was binned, because each time it curled its own
   * server to check the result, that shell call became the newest change and made the
   * evidence it had just cited stale. Thirty-one turns and a live deliverable, reported to
   * the owner as a failure. Verification failing is not the work failing, and a harness
   * that cannot tell the difference must not be the one deciding.
   *
   * So the completion stands and the doubt travels with it: the turn finishes, and what
   * could not be established is carried into `remainingRisks`, where the completion card
   * already shows it. The owner sees what was made and is told plainly that athanor could
   * not prove it.
   */
  // Later plan, acceptance and delivery holds share this budget across persisted retries.
  state.finishRejections = checked.ok
    ? 0
    : Math.min((state.finishRejections ?? 0) + 1, MAX_FINISH_REJECTIONS);
  const unverifiable = !checked.ok && state.finishRejections >= MAX_FINISH_REJECTIONS;
  if (!checked.ok && !unverifiable) {
    const rejections = state.finishRejections;
    state.repairStep = true;
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: [
        `Finish rejected (attempt ${rejections} of ${MAX_FINISH_REJECTIONS}): ${checked.reason}`,
        citableEvidence(state),
        'Either keep working, or call finish again with verification shaped exactly as {"status":"verified","evidence":[{"claim":"<what you are asserting>","source":"tool_result","toolCallId":"<id from the list above>"}],"remainingRisks":[]}.'
      ].join('\n')
    });
    await event(deps.store, task, key, 'status', 'Completion needs verification', {
      reason: checked.reason,
      attempt: rejections
    });
    return 'held';
  }
  // The plan is the one artefact the owner watches while long work runs, and until now the
  // harness force-marked every outstanding step completed on the way out - so a turn that
  // did four of nine steps and gave up left a panel reading nine of nine. Asked once, with
  // the titles named; a turn that has genuinely finished answers it in one line.
  const outstanding = await deps.outstandingPlanSteps(task, key).catch(() => []);
  /*
   * Only against a plan somebody chose to write.
   *
   * The hold exists because a turn that did four of nine steps and gave up used to leave a
   * panel reading nine of nine - the owner watches those statuses. But when no plan was
   * declared the harness writes one for itself, three boilerplate lines beginning "Inspect
   * the request, inputs, and current workspace state", and then held the finish against its
   * own boilerplate. Measured on one research task: the answer was written, and six of the
   * ten model turns came after it, this hold among them. Nothing is lost by dropping it -
   * the outstanding steps still travel into the completion for the turn that resumes.
   *
   * And not in plan mode at all, where a plan of open steps is the deliverable rather than the
   * shortfall. The hold's premise is that open steps mean unfinished work; in plan mode the owner
   * asked for exactly the steps and for none of them to have been taken, so every plan-mode finish
   * would pay one whole round trip to be told to say so. It is one round trip and not a
   * correctness matter, which is why it is a separate clause from the acceptance one below rather
   * than folded into it.
   */
  if (
    outstanding.length &&
    !state.planCoverageNagged &&
    !state.planIsFallback &&
    state.mode !== 'plan'
  ) {
    state.planCoverageNagged = true;
    state.repairStep = true;
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: `Finish held: ${outstanding.length} plan step${outstanding.length === 1 ? ' is' : 's are'} still open - ${outstanding.slice(0, 8).join('; ')}. Either finish them, mark them skipped with set_plan, or say in your reply that they are outstanding and finish again. The user is looking at those statuses.`
    });
    await event(deps.store, task, key, 'status', 'Plan steps are still open', {
      outstanding
    });
    return 'held';
  }
  // Nothing in athanor ever ran a check that could fail on the work itself. A finish cited a
  // successful call ordered after the last change, which any read of the file just written
  // satisfies. If this turn changed something, it has to say what would prove it - once.
  //
  // A record the last turn declared does not answer this. It is kept, because a follow-up
  // must not be able to break what the previous turn was held to, but it passed before this
  // turn started: whatever this turn just did, that record is not evidence of it.
  const inheritedAcceptance = (state.acceptanceTurn ?? 0) !== turn;
  if (
    state.mutatedBeyondProse &&
    (!state.acceptance || inheritedAcceptance) &&
    !state.acceptanceNagged
  ) {
    state.acceptanceNagged = true;
    state.repairStep = true;
    /*
     * Both calls in one step, said in as many words.
     *
     * The loop has always answered a batch in order, so `set_acceptance` followed by
     * `finish` in the same reply is declared, run and completed in a single model call -
     * but nothing said so, and every model answered "then finish again" with one call and
     * then another. Measured on `media-logo-set-holds-for-acceptance`: eight model calls
     * against seven for the same job declared up front, and the whole difference was the
     * round trip. This does not soften the hold; the record is still declared before the
     * checks are run, and a turn that ignores the invitation is held exactly as before.
     */
    const inOneStep =
      ' Send both calls in the same step - set_acceptance and then finish - and this costs you nothing.';
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content:
        (state.acceptance
          ? 'Finish held: this turn changed something, and the only acceptance checks on record are the ones an earlier turn declared - they were already passing before this turn began, so they show nothing about what you just did. Call set_acceptance with checks for this turn’s work, keeping the earlier ones alongside if they still guard something, then finish again.'
          : 'Finish held: this turn changed something and never said what would prove it worked. Call set_acceptance with the checks the harness should run - the command that builds or tests it, the extraction that shows the document says what it should, the file that has to exist - then finish again. If the work genuinely has no executable proof, say so in your reply and declare the artifact checks that do apply.') +
        inOneStep
    });
    await event(deps.store, task, key, 'status', 'Asked for an acceptance record', {});
    return 'held';
  }
  /*
   * An unverifiable finish still completes, and says so in the one sentence the owner can
   * do something with.
   *
   * It used to carry `checked.reason` and the attempt count: "athanor could not confirm
   * this completion after 3 attempts: Every cited result predates file_write (call-2)...
   * Cite call-2 itself if its output shows the outcome". That is the harness talking to the
   * model, printed at somebody who cannot cite anything, in the place that should say what
   * to do about the work. The reason is not lost - the warning event above carries it,
   * which is where a diagnostic belongs.
   */
  let verification: CompletionVerification = checked.ok
    ? checked.verification
    : {
        status: 'not_applicable',
        evidence: [],
        remainingRisks: [
          'athanor could not tie this result to anything it did, so check it before relying on it.'
        ]
      };
  let acceptanceEvidence: string[] = [];
  // Held outside the block so the finish below can keep the commands that passed. Only the
  // commands: an artifact check says a file exists, which is about this afternoon, where a
  // command that exits zero is about the machine.
  let verifiedCommands: AcceptanceCommandCheck[] = [];
  /*
   * And the other half, which reaching this line is most of what makes it worth keeping.
   *
   * A check that fails sends the model round again, up to `MAX_ACCEPTANCE_FAILURES` times,
   * and only the last of those runs is ever read here - so a command that failed and was
   * then fixed leaves nothing behind, and a command that arrives here failed after the
   * model had four goes at it. That is the difference between a bad afternoon and a route
   * worth remembering was closed.
   */
  let deadEnds: MemoryDeadEndCheck[] = [];
  /*
   * And not in plan mode, which is the one place in this file where the run itself is the defect.
   *
   * An acceptance suite is the owner's own build and test commands, executed by the harness through
   * a direct exec on the owner's computer. `finish` is on the plan-mode permitted set - it is not
   * mutating and it is checkpoint-exempt, so both basis sets admit it, and refusing the model any
   * way to end a plan-mode turn would be worse than the run. So the tool stays permitted and the
   * run is what stops here.
   *
   * The record reaches this line without a plan-mode turn declaring anything: `set_acceptance` is
   * refused in plan mode, but `startTurnState` deliberately does not launder `acceptance`,
   * `acceptanceTurn` or `acceptanceCaveat`, so a record an earlier act-mode turn declared is still
   * on the state when the owner switches the conversation to plan and the model calls finish. None
   * of the three holds ahead of this one stops it: the verification hold is bounded by
   * MAX_FINISH_REJECTIONS, the plan-coverage hold above fires once and now not at all in plan mode,
   * and the acceptance-declared hold needs `mutatedBeyondProse`, which a plan-mode turn never sets.
   *
   * This is dispatch.ts's own argument applied where it lands: `set_acceptance` is refused there
   * because "declaring a record runs the harness's red baseline, which executes the owner's build
   * or test command on the owner's computer", and this is where the same commands run without it.
   *
   * `acceptanceEvidence`, `verifiedCommands` and `deadEnds` are left at their empty initialisers on
   * purpose rather than carried over from the earlier turn: a plan-mode turn changed nothing, so
   * there is nothing for a check to have verified about it and no route for a dead end to record.
   * The completion therefore carries no acceptance list and no verified commands, which is the
   * honest report of a turn that ran no checks.
   */
  if (state.acceptance && state.mode !== 'plan') {
    // Carrying what athanor has already run, so a check naming a command it executed
    // itself after the last change is answered by that run rather than by a second build.
    const results = await deps.runAcceptanceChecks(
      task,
      key,
      state.acceptance,
      { purpose: 'finish', observed: observedCommands(state) },
      // The turn, so the answer hold below - which is free, runs after this, and sends the
      // same finish round again - cannot buy a second build with it.
      state
    );
    verifiedCommands = state.acceptance.checks.filter(
      (check): check is AcceptanceCommandCheck =>
        check.kind === 'command' &&
        results.some((result) => result.id === check.id && result.passed)
    );
    deadEnds = state.acceptance.checks.flatMap((check) => {
      if (check.kind !== 'command') return [];
      const result = results.find((entry) => entry.id === check.id && !entry.passed);
      // Only a run that ended. "timed out after 900s" and "the check could not run" are the
      // harness failing to observe the command rather than the command failing, and a
      // caution written out of either would outlive a wedged network or a runner restart.
      //
      // Asked through `acceptanceObservation` rather than through the `detail.startsWith('exit ')`
      // this line used to spell inline: it is the same question the status below now asks, and two
      // copies of one rule drift. The two readings agree exactly here because the guard above has
      // already dropped every check that is not a command, which is the only kind whose detail
      // opens with an exit code - see that function's comment for what goes wrong when the rule is
      // let out of this narrow spot.
      if (!result || acceptanceObservation(result) !== 'failed') return [];
      return [
        {
          label: check.label,
          command: [check.executable, ...check.args].join(' '),
          cwd: check.cwd,
          detail: result.detail
        }
      ];
    });
    acceptanceEvidence = acceptancePassedEvidence(results);
    // And the same lines in the field a script reads first, under a source only the harness
    // writes, so the label the model chose never travels there without the command beside it.
    verification = {
      ...verification,
      evidence: [...verification.evidence, ...harnessEvidence(results)]
    };
    const failed = results.filter((result) => !result.passed);
    if (failed.length) {
      const attempt = (state.acceptanceFailures ?? 0) + 1;
      state.acceptanceFailures = attempt;
      state.repairStep = true;
      if (attempt < MAX_ACCEPTANCE_FAILURES) {
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: acceptanceFailureMessage(results, attempt, MAX_ACCEPTANCE_FAILURES)
        });
        // A status, not a warning. This refusal is transient by construction: the model is
        // told what failed and gets to fix it, and the turn that recovers used to carry a
        // standing red line contradicting the "all passed" on its own completion card. A
        // failure that is never recovered from is not lost - it reaches the owner as a
        // remaining risk below, which is where a finished task's problems belong.
        //
        // The summary says which check, because the old one said only that "a check" failed
        // and the payload naming it was never rendered anywhere.
        await event(
          deps.store,
          task,
          key,
          'status',
          `Finish refused: ${failed.length} of ${results.length} acceptance ${results.length === 1 ? 'check' : 'checks'} failed — ${failed
            .map((result) => result.label)
            .join('; ')
            .slice(0, 160)}`,
          { acceptance: results }
        );
        return 'held';
      }
      /*
       * Bounded like every other refusal in this loop: past the ceiling the turn ends honestly
       * rather than spending the rest of the budget on the same failure. That half was right and
       * is untouched - the turn stops, and the failures travel in the risks where the card already
       * prints them.
       *
       * What was wrong was the word. `verified` is a claim about evidence, and here there is none:
       * the turn declared its own checks, the harness ran them, and they failed four times. Left
       * as the model wrote it, the field an owner or a script reads first said `verified` over
       * that - MEASURED against a real box, byte-identical in `status` and `verification` to the
       * run that got the answer right, with only the external verifier able to tell them apart.
       *
       * So the harness withdraws the claim rather than the completion. It is a value the model
       * cannot write - it is not in the finish schema and `completionVerification` refuses it -
       * which is what makes it evidence about the checks rather than one more thing the model says
       * about itself, and which is why it costs the tool catalogue nothing.
       */
      const downgraded = harnessVerificationStatus(verification.status, results);
      /*
       * And the same fact in the words the owner reads, sent both ways.
       *
       * A line written into both the acceptance list and the risks is shown beside the tick; a line
       * written only into the risks sits behind the disclosure with the rest of the detail. This one
       * has to be beside the tick, on that protocol's own rule: the card is headed "Result" with a
       * tick on it, and a reader who never opens the receipt would otherwise take it at its word.
       *
       * First in the list rather than appended, so the twenty-line cap cannot drop the sentence
       * that says what the other nineteen mean.
       */
      const caveat =
        downgraded === 'checks_did_not_run'
          ? ACCEPTANCE_COULD_NOT_RUN_CAVEAT
          : ACCEPTANCE_FAILED_CAVEAT;
      acceptanceEvidence = [caveat, ...acceptanceEvidence];
      verification = {
        ...verification,
        status: downgraded,
        remainingRisks: [
          caveat,
          ...verification.remainingRisks,
          ...failed.map((result) => `${result.label} — ${result.detail}`)
        ].slice(0, 20)
      };
    } else {
      state.acceptanceFailures = 0;
    }
    /*
     * A green tick that means less than the last one did has to say so where the owner
     * reads it, not only in the timeline entry for the step that declared the checks. Where
     * exactly is the card's decision: a line written into both the acceptance list and the
     * risks is shown beside the tick, and a line written only into the risks is shown with
     * the rest of the detail, behind the disclosure. Only the caveat that would leave a
     * reader who never opens it believing something untrue goes in both.
     *
     * Both of these sentences are about a tick that is worth less than it looks, and neither of
     * them is true when there is no tick. Reaching this line with failures means the branch above
     * has just run: the status is downgraded and the completion already carries athanor's own
     * sentence saying the checks did not pass. Written beside that, "These checks were already
     * passing before this job started, so passing them says nothing about it" describes a passing
     * run that did not happen, and "they show nothing broke" says the opposite of the four
     * failures listed under it. Neither qualifies a failure; both contradict one.
     *
     * So they are for the run whose checks passed. The failure keeps its own sentence, which
     * withdraws more than either of these does - nothing here is verified, rather than this tick
     * proves less than you think.
     */
    const caveat = failed.length
      ? undefined
      : (state.acceptanceCaveat ??
        ((state.acceptanceTurn ?? 0) === turn ? undefined : ACCEPTANCE_EARLIER_TURN_CAVEAT));
    if (caveat) {
      if (CAVEAT_BESIDE_THE_TICK.has(caveat)) acceptanceEvidence = [caveat, ...acceptanceEvidence];
      verification = {
        ...verification,
        remainingRisks: [...verification.remainingRisks, caveat].slice(0, 20)
      };
    }
  }
  /*
   * A turn that did the work and never said a word.
   *
   * The model can do everything through tools and call finish without writing prose once,
   * and the owner is left with a card describing the work instead of the answer they asked
   * for - "wrote a note to notes-check.md" in reply to "tell me what it says". The finish
   * schema already tells it the answer belongs in the reply; nothing ever checked.
   *
   * Asked once, and only when literally nothing was said, so a turn that answered normally
   * never sees it. Deliberately not a `repairStep`: those suppress publishing because they
   * are bookkeeping, and this is the opposite - it exists to get an answer published, so it
   * clears the flag a refusal may have left set.
   */
  if (!state.answered && !state.answerNagged && !textValue(call.arguments.answer)) {
    state.answerNagged = true;
    state.repairStep = false;
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content:
        'Finish held: this turn has not said anything to the user. The card carries a description of the work, not the answer - if they asked what a file says, what you found, or what you concluded, that belongs in your reply. Write it, then call finish again.'
    });
    await event(deps.store, task, key, 'status', 'Asked for the answer itself', {});
    return 'held';
  }
  const outputs = state.mode === 'plan' ? [] : await declaredTaskOutputs(deps.store, task.id, key);
  const mediaJobs = await deps.store.listMediaJobs(task.userId, task.id, 100);
  const mediaDelivery = mediaDeliveryState(mediaJobs);
  const delivery = await resolveDelivery(deps, task, key, state, call.arguments.deliverables, {
    outputs,
    passedCheckIds: new Set(verifiedCommands.map((check) => check.id)),
    deferredFiles: new Set(
      [...mediaDelivery.pending, ...mediaDelivery.failed]
        .map((job) => deliveryFilePath(job.outputPath))
        .filter((path): path is string => path !== null)
    )
  });
  if (delivery.unavailable.length && !state.deliveryNagged) {
    state.deliveryNagged = true;
    state.repairStep = true;
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: `Finish held: these declared outputs are not accessible: ${delivery.unavailable.slice(0, 8).join('; ')}. Repair the file or published preview, use a recorded artifact name, or remove an incorrect reference and explain the missing output. Then finish again.`
    });
    await event(deps.store, task, key, 'status', 'Declared outputs need delivery', {
      unavailable: delivery.unavailable
    });
    return 'held';
  }
  if (mediaDelivery.failed.length)
    delivery.unavailable.push(
      'A requested media output failed or its provider submission is unresolved. Inspect its recorded job status.'
    );
  if (delivery.unavailable.length) {
    const caveat = 'Some declared outputs could not be opened. The result needs review.';
    acceptanceEvidence = [caveat, ...acceptanceEvidence];
    verification = {
      ...verification,
      status: 'delivery_incomplete',
      remainingRisks: [
        caveat,
        ...delivery.unavailable.map((value) => `Unavailable output: ${value}`),
        ...verification.remainingRisks
      ].slice(0, 20)
    };
  } else if (mediaDelivery.pending.length) {
    const caveat =
      'Media delivery is pending. The recorded provider jobs continue independently and their files will appear when ready.';
    verification = {
      ...verification,
      status:
        verification.status === 'verified' || verification.status === 'not_applicable'
          ? 'delivery_pending'
          : verification.status,
      remainingRisks: [caveat, ...verification.remainingRisks].slice(0, 20)
    };
  }
  if (unverifiable)
    await event(deps.store, task, key, 'warning', 'Completion evidence could not be verified', {
      reason: checked.ok ? '' : checked.reason,
      attempts: MAX_FINISH_REJECTIONS
    });
  state.finishRejections = 0;
  state.messages.push({
    role: 'tool',
    toolCallId: call.id,
    content: JSON.stringify({
      completed: true,
      summary,
      verification
    })
  });
  await deps.completeTurn(
    task,
    key,
    state,
    {
      summary,
      answer: textValue(call.arguments.answer, summary),
      deliverables: delivery.deliverables,
      verification,
      ...(acceptanceEvidence.length ? { acceptance: acceptanceEvidence } : {}),
      ...(verifiedCommands.length ? { verifiedCommands } : {})
    },
    // Carried beside the completion rather than inside it: the card already prints each of
    // these as a remaining risk, and this copy exists only for the memory write.
    deadEnds.length ? { deadEnds } : {}
  );
  const title = textValue(call.arguments.title);
  // Naming is optional; the background titler can retry a transient database failure.
  if (title)
    await applyPresentationTitle({ store: deps.store, task, key }, title).catch(() => false);
  return 'completed';
};
