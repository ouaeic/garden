import { appendMemoryOwnerInput } from './memory-owner-input.js';
/**
 * Whether a turn has actually done what it said it did.
 *
 * The model announces completion; this file decides whether the announcement is supported. It reads
 * the turn's own transcript for evidence - commands that were really run, files that were really
 * written, results the turn really cited - and refuses a finish whose evidence is absent, stale or
 * belongs to an earlier turn.
 *
 * `startTurnState` is here because it is the other half of the same question: what a new turn is
 * allowed to inherit from the last one is exactly what the completion check will later be entitled
 * to count as evidence. `apps/api` imports it through `@garden/worker` to seed a resumed turn.
 */
import { ownerMessageContent, type OwnerMessage } from '@garden/core';
import type { ModelToolCall } from '@garden/model-gateway';
import {
  acceptanceObservation,
  acceptancePassedEvidence,
  commandFingerprint,
  type AcceptanceResult
} from './acceptance.js';
import type { AgentState } from './agent-state.js';
import { MAX_QUESTIONS_PER_TURN } from './turn-bounds.js';
import { asRecord, textValue } from './values.js';

/**
 * What garden is willing to say about a completion.
 *
 * The first two are the model's own word for it. The second two are the harness's, computed in
 * `turn/finish.ts` from what the declared acceptance checks actually did, and reachable no other
 * way - see `MODEL_DECLARED_VERIFICATION_STATUSES` above.
 *
 * They exist because `verified` is a claim about evidence and there was a path that wrote it with
 * none. MEASURED by driving a real turn against a real box: a task whose answer was WRONG reported
 * `status=completed verification=verified`, byte-identical in both top-line fields to the correct
 * run. The turn had declared acceptance checks, they ran in the box, and they failed four times -
 * `MAX_ACCEPTANCE_FAILURES` - after which `turn/finish.ts` appended the failures to
 * `remainingRisks` and left the status the model had declared. Only the external verifier told the
 * two runs apart (evals/bench/selftest.ts, and the note at evals/bench/score.ts:159 that both
 * fields "read EXACTLY as they do on the honest run").
 *
 * What ending the turn there gets right is not touched by any of this: past the ceiling the turn
 * stops rather than spending the rest of the budget on the same failure, and the failures still
 * travel in the risks. What changes is only the word in the field an owner or a script reads first.
 */
export type CompletionVerificationStatus =
  | 'verified'
  | 'not_applicable'
  | 'unverified'
  | 'checks_failed'
  | 'checks_did_not_run'
  | 'delivery_incomplete'
  | 'delivery_pending';

export interface CompletionVerification {
  status: CompletionVerificationStatus;
  evidence: Array<{
    claim: string;
    /**
     * The first three are the model's, and `completionVerification` reads only those. The fourth
     * is written by the harness alone, in `harnessEvidence`, for a command check it ran and saw
     * pass: it is not in the finish schema and a model that declares it is read as citing a tool
     * result or refused, so its presence in a record means the computer wrote the line.
     */
    source: 'tool_result' | 'published_artifact' | 'user_visible_result' | 'acceptance_check';
    toolCallId?: string;
  }>;
  remainingRisks: string[];
}

/**
 * The state a new turn starts from, which is the previous turn's minus everything that was about
 * the previous turn.
 *
 * Extracted because there are two doors into a new turn and only one of them was doing this. The
 * worker's door handles a message that arrived while the agent was still running; the API's door
 * handles the ordinary case - the owner replying to a task that has finished - and it reset four
 * fields where this resets the rest. So the common path carried the last turn's tool results
 * forward, carried `mutatedBeyondProse` so a fresh turn was held to checks for code it never
 * touched, and carried the notice count so a monitor that had spoken three times last turn was
 * silent for the rest of the conversation.
 *
 * What is deliberately NOT reset is as load-bearing as what is:
 *
 * - the taint. The untrusted content the last turn read is still in this window, and a follow-up
 *   message is not a laundering step: the owner saying "carry on" does not turn a hostile page they
 *   never saw into their own instruction.
 * - the web tool mode, for the same reason - the pin only ever refuses, so a conversation that has
 *   been searching in house keeps doing so, while a credential that has just turned zero retention
 *   on takes effect on the very next step.
 * - the tool-output floor. The window it applies to is the same window, and raising it back would
 *   rewrite bytes the provider has already cached.
 * - the acceptance record. A follow-up must not quietly drop the checks the last turn was held to,
 *   and the caveat, if there is one, is part of how it was made.
 */
export const startTurnState = <T extends Record<string, unknown>>(
  previous: T,
  input: OwnerMessage & { turn: number; reservationKey: string }
): T => {
  const messages: unknown[] = Array.isArray(previous.messages) ? previous.messages : [];
  const next = {
    ...previous,
    messages: [...messages, { role: 'user', content: ownerMessageContent(input) }],
    memoryOwnerRequest: appendMemoryOwnerInput(undefined, input.prompt),
    step: 0,
    turn: input.turn,
    reservationKey: input.reservationKey,
    turnToolResults: {},
    truncatedReplies: 0,
    // Both per turn, like every counter around them: what the last turn started is not evidence
    // that this one has, and a turn that opens by thinking must not inherit a stalled count.
    toolsStarted: 0,
    idleSteps: 0,
    // Per turn as well, and this one has a second reason on top of theirs: the count means "nothing
    // in between changed what is failing", and the owner replying is something changing. A patch
    // that would not apply because they had the file open is a patch worth trying again.
    repeatedFailures: {},
    // The bound is per turn - the tool says so, the constant is named for it, and the refusal tells
    // the model "this turn". Carrying it through made it per conversation instead.
    notices: 0,
    // Per turn as well, and for the same reason - the tool tells the model "twice in a turn". This
    // door is the one a message the agent was still running comes through, so a turn that ends
    // while a question is outstanding must not carry the park into the next: the answer to a parked
    // question is taken back into its own turn by `run`, and anything that gets here instead has
    // already had that turn ended out from under it.
    questionsAsked: 0,
    /*
     * The egress budget, for exactly the reason above it.
     *
     * `MAX_TURN_NOVEL_BYTES` is named for a turn and its card tells the owner "this turn", but the
     * taint it is charged under is deliberately never cleared - so carried forward it was a budget
     * per conversation: a research thread that had spent nine hundred bytes over ten turns would
     * have raised a card on every web read it made from then on, for ever, and a card that fires on
     * everything is a card nobody reads. It is safe to clear here and only here, because the one
     * thing that starts a turn is the owner writing or a schedule they set firing, and neither is
     * something a hostile page can bring about. The taint itself still carries, so the next turn is
     * still judged - it just gets its own kilobyte rather than the remains of the last one's.
     */
    turnNoveltyBytes: 0,
    /*
     * The reach budget, and it is per turn for the same reason the egress budget above it is.
     *
     * The tool says "this turn" when it refuses, and a bound whose refusal names a turn while the
     * counter it reads spans a conversation is a bound the model cannot obey: a thread that had
     * spent four reaches an hour ago would refuse the first reach of every turn afterwards, for
     * ever. Safe to clear here and only here, because the one thing that starts a turn is the owner
     * writing or a schedule they set firing - neither of which anything the last turn read can
     * bring about. What is deliberately NOT cleared is the taint the reach may have raised, which
     * carries with everything else above.
     */
    memoryReaches: 0,
    // A new turn has changed nothing yet.
    mutatedBeyondProse: false,
    answered: false,
    repairStep: false,
    acceptanceFailures: 0,
    // The self-continuation bound, per turn like the rest. The owner replying is the thing that
    // starts a turn, so a conversation where they keep replying is a conversation they are watching
    // - it is the turn nobody replied to that is allowed to renew itself.
    selfContinuations: 0,
    // Per turn, like the counters above: the workspace may well have changed between turns, so a
    // read that was uninformative to repeat inside one turn is an ordinary read in the next.
    seenCalls: {},
    // Also per turn. A carried artifact is a path this turn touched before a compaction removed the
    // step that touched it; carrying it into the next turn would put work in the `Touched:` list of
    // a turn that predates it, which is worse than the absence it exists to fix.
    carriedArtifacts: []
  } as unknown as T & {
    reasoningFloor?: unknown;
    frameLossNoted?: unknown;
    continuedAnswer?: unknown;
    compactedAtStep?: unknown;
    pending?: unknown;
    question?: unknown;
    browserHandoff?: unknown;
    continuationMark?: unknown;
    artifactLedger?: unknown;
    jobWaitId?: unknown;
    codingMissionWaiting?: unknown;
    codingMissionReviews?: unknown;
    pendingNativeInputs?: unknown;
    nativeInputApprovals?: unknown;
    transcriptionApprovals?: unknown;
    mediaApprovals?: unknown;
    decisionFloorBindings?: unknown;
    decisionRouting?: unknown;
    decisionReceipts?: unknown;
  };
  delete next.jobWaitId;
  delete next.codingMissionWaiting;
  delete next.codingMissionReviews;
  delete next.pendingNativeInputs;
  delete next.nativeInputApprovals;
  delete next.transcriptionApprovals;
  delete next.mediaApprovals;
  delete next.decisionFloorBindings;
  delete next.decisionRouting;
  delete next.decisionReceipts;
  delete next.reasoningFloor;
  delete next.compactedAtStep;
  // Per turn, like the counters above: a transcript write that failed while the last turn was
  // streaming says nothing about this one, and left behind it would silence the first turn that
  // genuinely started losing frames.
  delete next.frameLossNoted;
  delete next.continuedAnswer;
  delete next.pending;
  delete next.question;
  delete next.browserHandoff;
  // What the last turn had changed by its last ceiling says nothing about this one, and left behind
  // it would be the bar a fresh turn has to clear before it may renew its own budget.
  delete next.continuationMark;
  /*
   * The ledger of files changed, dropped for the plainest reason there is: the block is headed
   * "this turn", and a turn that inherited the last one's rows would state, in the harness's own
   * voice and at the tail of every request, that it had written files it has not touched. Dropped
   * rather than emptied because an absent ledger and an empty one render the same block - none -
   * and the smaller state is the one that gets encrypted onto the task on every step.
   */
  delete next.artifactLedger;
  return next;
};

/**
 * How the window's copy of the acceptance record is recognised, so a compaction that removed it can
 * be noticed and the record put back rather than silently lost.
 */
export const ACCEPTANCE_MARKER = 'ACTIVE ACCEPTANCE CHECKS';

/** What a question has to be before the conversation is parked on it. */
export const askOutcome = (
  state: Pick<AgentState, 'turnToolResults' | 'questionsAsked'>,
  args: Record<string, unknown>
):
  | { ok: true; question: string; options: string[]; why: string }
  | { ok: false; refusal: string } => {
  const question = textValue(args.question).trim().replace(/\s+/g, ' ').slice(0, 200);
  const why = textValue(args.why).trim().replace(/\s+/g, ' ').slice(0, 240);
  const options = (Array.isArray(args.options) ? args.options : [])
    .map((option) => textValue(option).trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 5);
  if (!question)
    return {
      ok: false,
      refusal: 'Refused: a question needs one line the user can answer from a lock screen.'
    };
  if (options.length === 1)
    return {
      ok: false,
      refusal:
        'Refused: one option is not a choice. Send at least two, or leave options out and take any reply.'
    };
  if ((state.questionsAsked ?? 0) >= MAX_QUESTIONS_PER_TURN)
    return {
      ok: false,
      refusal: `Refused: this turn has already asked ${MAX_QUESTIONS_PER_TURN} questions, which is the limit. Make the most reasonable assumption, carry on, and say plainly in your reply what you assumed and what would change it.`
    };
  return { ok: true, question, options, why };
};

/**
 * What garden observed by running this call, when the call was a command it can be held to later.
 *
 * Only a foreground `shell` with no stdin: a background start reports a session rather than an exit
 * code, and a command fed input is not the command an acceptance check can name, since the check
 * schema has no stdin to give it.
 */
export const shellObservation = (
  call: ModelToolCall,
  result: unknown
): { command: { fingerprint: string; exitCode: number } } | null => {
  if (call.name !== 'shell' || call.arguments.background === true) return null;
  if (textValue(call.arguments.stdin)) return null;
  const observation = asRecord(result);
  // A command the runner stopped answered nothing, whatever it left in the exit code.
  if (observation?.timedOut === true) return null;
  const exitCode = Number(observation?.exitCode);
  if (!Number.isInteger(exitCode)) return null;
  return {
    command: {
      fingerprint: commandFingerprint({
        executable: textValue(call.arguments.executable),
        args: (Array.isArray(call.arguments.args) ? call.arguments.args : []).map((argument) =>
          textValue(argument)
        ),
        cwd: textValue(call.arguments.cwd, 'workspace')
      }),
      exitCode
    }
  };
};

/**
 * Where in this turn's tool results the evidence about the last change begins.
 *
 * One reading of "after the last change", shared by the two places that need it: the completion
 * contract, which asks whether the cited result can show the change worked, and the acceptance run,
 * which asks whether a command garden already executed still speaks for the computer as it stands.
 * They were the same question written twice, and two copies of this rule would drift.
 */
export const evidenceFloor = (
  state: Pick<AgentState, 'turnToolResults'>
): { order: string[]; lastMutation: number; floor: number; observedItsOwnChange: boolean } => {
  const order = Object.keys(state.turnToolResults ?? {});
  // Writing the running brief is bookkeeping, not the work being proved. Counted, an agent that
  // cited what it had observed and then recorded the outcome in workspace/GARDEN.md would have made
  // a new last change, so its own record-keeping would invalidate evidence it had already gathered,
  // and the way out would be to read the brief back, which proves only that a file it just wrote
  // says what it wrote. It stays `mutating` everywhere else; it is only not the change the evidence
  // is about.
  //
  // `skipped` is read here rather than `success`, because this reduce is the one consumer that asks
  // about `mutating` without asking whether the call ran: a `file_write` the harness answered
  // without running is still classified as a write by its arguments, and counted it would move the
  // floor past evidence the turn had honestly gathered.
  const lastMutation = order.reduce(
    (found, id, index) =>
      state.turnToolResults?.[id]?.mutating &&
      !state.turnToolResults[id]?.briefOnly &&
      !state.turnToolResults[id]?.skipped
        ? index
        : found,
    -1
  );
  /*
   * A change is its own evidence when observing it separately could show nothing more.
   *
   * A shell result carries what the command printed and what it exited with. Every inline `bash -lc`
   * counts as a change whatever it actually ran - the classifier cannot read a script and errs
   * towards calling it one - so without this an agent that checked its work through the shell, which
   * is how most of them check anything, made a new last change every time it looked: nothing could
   * come after it and a completed job failed its own verification.
   *
   * A write to a file nothing executes - a report, a note, a CSV - carries the same weight for the
   * same reason: the only check available is reading back a file the agent has just written, which
   * proves that a file it wrote says what it wrote. Demanding it cost a research task about ten
   * model turns after its answer was already on screen.
   *
   * A generation is the third case. `generate_media` does not ask the workspace to make a file;
   * garden makes it, and the result carries the paths it wrote and the provider's own charge.
   * Speech has no reader at all in the catalogue, so a turn that recorded a clip had no citable
   * observation to make: measured on `media-one-generation-is-not-re-rolled`, it spent two model
   * calls being refused before finishing on the same evidence anyway. Whether the picture is any
   * good is a different question, and it is the one `image_read` and the acceptance record answer.
   *
   * Code and commands are unchanged: there the check is real, and it is still required.
   */
  const lastResult = state.turnToolResults?.[order[lastMutation] ?? ''];
  const observedItsOwnChange =
    lastResult?.name === 'shell' ||
    lastResult?.name === 'generate_media' ||
    lastResult?.proseOnly === true;
  return {
    order,
    lastMutation,
    floor: observedItsOwnChange ? lastMutation : lastMutation + 1,
    observedItsOwnChange
  };
};

/**
 * Every command garden itself ran this turn that still speaks for the computer as it stands.
 *
 * Keyed by what the command was, so an acceptance check naming one of them is answered by the run
 * garden already made rather than by a second one. Anything before the floor is dropped: the
 * computer changed after it, so what it saw is no longer what is there.
 */
export const observedCommands = (
  state: Pick<AgentState, 'turnToolResults'>
): Map<string, number> => {
  const { order, floor } = evidenceFloor(state);
  const observed = new Map<string, number>();
  for (const [index, id] of order.entries()) {
    if (index < floor) continue;
    const command = state.turnToolResults?.[id]?.command;
    if (command) observed.set(command.fingerprint, command.exitCode);
  }
  return observed;
};

/**
 * The status after the harness has read what the declared checks actually did.
 *
 * The other half of `completionVerification` above, and deliberately the opposite kind of function:
 * that one judges what the model wrote, this one overrides it. Called from `turn/finish.ts` on the
 * one path where a completion is written despite the record not passing - past
 * `MAX_ACCEPTANCE_FAILURES`, where the turn stops rather than spending the rest of its budget on
 * the same failure.
 *
 * Three rules, and the order of the first two is the judgement:
 *
 * - A check the harness watched fail outranks everything, including a check it could not run. A
 *   failure is evidence against the work; a check that never started is the absence of evidence,
 *   and the stronger fact wins the one word the field can hold. Nothing is lost by that ordering -
 *   both lines are in `remainingRisks` either way, and the card prints each one verbatim.
 * - A check that could not run is its own answer and is never folded into either neighbour. It is
 *   not `verified`, because nothing was verified; it is not `checks_failed`, because nothing
 *   failed. It reads as silence, which is what it is.
 * - An empty record, or one where every check passed, returns what the model declared untouched.
 *   A turn with no acceptance checks never reaches here at all, so `not_applicable` still means
 *   exactly what it meant.
 *
 * It does NOT promote: a model that declared `not_applicable` and whose checks all passed is left
 * saying `not_applicable`. The harness is entitled to withdraw a claim about evidence it can see
 * was not made good; it is not entitled to make a claim on the model's behalf.
 */
export const harnessVerificationStatus = (
  declared: CompletionVerificationStatus,
  results: readonly AcceptanceResult[]
): CompletionVerificationStatus => {
  const observations = results.map(acceptanceObservation);
  if (observations.includes('failed')) return 'checks_failed';
  if (observations.includes('did_not_run')) return 'checks_did_not_run';
  return declared;
};

/**
 * The evidence the harness writes into the completion for itself: one item per command check it
 * ran and saw pass, with the command beside the label.
 *
 * `verification.evidence` is the field a script reads first - the headless outcome copies it whole
 * - and holding only the model's own claims, it would leave an owner reading "54 data rows (30
 * months x 3 products)" there no way to tell which half the computer tested. The line is the
 * same one the completion's `acceptance` list carries, under a source the model cannot write, and
 * only for a pass: a failure is already a remaining risk, and a check that did not run proved
 * nothing. Artifact checks carry no command and are left to that list.
 */
export const harnessEvidence = (
  results: readonly AcceptanceResult[]
): CompletionVerification['evidence'] =>
  results
    .filter((result) => result.passed && result.command)
    .map((result) => ({
      claim: acceptancePassedEvidence([result])[0] ?? '',
      source: 'acceptance_check' as const
    }));

/** Source provenance only. Claim support is assessed separately. */
export interface DelegateEvidenceCheck {
  readonly claim: string;
  readonly source: string;
  readonly quoteMatched: boolean;
  readonly reread: boolean;
  readonly detail: string;
}

/*
 * The characters that carry no width, and are therefore not part of what anybody quoted.
 *
 * A soft hyphen is a hyphenation hint the renderer may or may not use; the zero-width family and
 * the byte-order mark are line-breaking and joining hints. None of them is visible in the page a
 * specialist read, so none of them can be part of what it copied - a model that retypes a span it
 * saw drops them, and the span it hands back is the same span.
 */
const SPAN_INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
/*
 * The quotation and dash families, folded to the one ASCII spelling of each.
 *
 * These are the substitutions models actually make. Measured over six realistic variants of a
 * genuinely copied span, five failed the old collapse-and-lowercase matcher: a curly apostrophe, a
 * curly double quote, an `fi` ligature, a soft hyphen and an en dash. Typography is what a
 * publisher applied to the page, not what the specialist claimed, so a report that straightened it
 * on the way back is an honest report and was being told it had fabricated its evidence - the
 * strongest sentence this harness says about a specialist, on the strength of one apostrophe.
 *
 * Guillemets are included because they are quotation marks in French and German and a model
 * quoting such a page into English prose straightens them the same way. The primes are included
 * because a page writes 5′ 10″ and a model retypes 5' 10".
 */
const SPAN_SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032\u2035\u02bc]/g;
const SPAN_DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033\u2036\u00ab\u00bb]/g;
const SPAN_DASHES = /[\u2010-\u2015\u2212]/g;

/**
 * A quoted span and the page it came from, compared the way a reader would compare them - and not
 * one character looser than that.
 *
 * Pure, and both sides go through it, so the fold is symmetric: whatever this removes it removes
 * from the source as well, and a span can only match by being the same words in the same order.
 *
 * WHAT IS NORMALISED: NFKC, which resolves ligatures (`ﬁ` to `fi`), full-width forms and the
 * no-break space, and expands `…` to three dots; the invisible characters above, removed; the
 * quotation and dash families above, folded to ASCII; then whitespace collapsed and case dropped,
 * which is what this function already did and which is why a span copied across a line break
 * matched at all.
 *
 * WHAT IS DELIBERATELY NOT, because each of these is how a fabricated span would get in:
 *
 * - **Diacritics stay.** `resume` is not `résumé` and `Muller` is not `Müller`. NFKD plus mark
 *   stripping would match every honest variant this does and would also match a span whose words
 *   are different words in French, German or Turkish.
 * - **Punctuation is folded, never dropped.** A comma still has to be a comma. Dropping punctuation
 *   would let a span that reorders or splices the source's clauses match the source.
 * - **Spaces are collapsed, never removed.** Word boundaries still have to line up, so two words
 *   the source runs together are not the same as two the specialist ran together.
 * - **Nothing is stemmed, reordered or truncated.** This is a substring test on the whole span.
 *
 * So the failure it can still produce is a specialist that paraphrased rather than copied, which is
 * a report the lead should be told about, and the failure it cannot produce is a specialist
 * that copied exactly and had its typography straightened on the way.
 */
export const normalisedSpan = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(SPAN_INVISIBLE, '')
    .replace(SPAN_SINGLE_QUOTES, "'")
    .replace(SPAN_DOUBLE_QUOTES, '"')
    .replace(SPAN_DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** An empty normalized quote carries no evidence, even though every string contains it. */
export const quotedSpanMatchesSource = (source: string, quote: string): boolean => {
  const span = normalisedSpan(quote);
  return span.length > 0 && normalisedSpan(source).includes(span);
};

/**
 * The longest a cited `source` may be before the whole evidence item is dropped.
 *
 * This field was the one string in the report with no bound on it at all, and it is not a string
 * that stays inside this file: it is classified as a destination, it is handed to the runner as a
 * URL or a workspace path, and - the reason a bound is owed rather than merely tidy - it is copied
 * verbatim into the `evidenceChecks` the lead reads, which are not cut by the report's own
 * `truncateMiddle`. A specialist may write 8,192 output tokens, so two citations could put its
 * entire output into the lead's window through a field the lead is told is an address.
 *
 * Two kilobytes because that is well past any real one and well short of that. `MAX_ADDRESS_CHARS`
 * in `egress.ts` is 512, measured over 136 recorded addresses of which one exceeds 256 and none
 * exceeds 512, and a workspace path is far shorter than a URL; this is four times that, so an
 * unusual deep link still fits and nothing that fits is worth truncating.
 *
 * Dropped rather than truncated, on `egress.ts`'s own reasoning: a clipped address is a different
 * address, and re-reading a different address to check a span proves nothing about the citation.
 * The drop is counted and named in `errors` like every other malformed item, so the specialist is
 * told what happened rather than watching a citation disappear.
 */
export const MAX_EVIDENCE_SOURCE_CHARS = 2_048;

/** A specialist's report, as the two fields the lead actually reads. */
export interface DelegateReport {
  answer: string;
  evidence: Array<{ claim: string; source: string; quotedSpan: string }>;
}

/**
 * The same report weighed against the contract the specialist was given, with the reasons it missed.
 *
 * §4.5 #78 is a declared output schema the child is told up front, validated by the parent, with
 * exactly one bounded correction retry. garden had the first half and not the second: the shape is
 * in the specialist's system prompt, `parseDelegateReport` below judged it, and the caller then did
 * nothing at all with the verdict - the comment there said so outright. A report that arrived as
 * prose was adopted by the lead exactly as a report that met the contract was, and nothing anywhere
 * told the lead which it had.
 *
 * The schema stays forgiving, which is the shipped guidance the corpus is unanimous on: require
 * only the fields you will actually read. `couldNotEstablish` is asked for in the prompt and is not
 * checked here, because nothing in the harness reads it - holding a specialist to a field the
 * parent ignores buys a retry and no information. Only `answer`, which is the report, and
 * `evidence`, which is the half the harness re-reads, are contract.
 *
 * Two thresholds, deliberately different, and the caller reads both: `report === null` is "the lead
 * has nothing structured to work with", which is what a correction pass is worth a model call for,
 * and a non-empty `errors` on a readable report is a soft miss the lead should be told about for
 * free. Collapsing them either spends a call on a cosmetic slip or hides one.
 */
export interface DelegateReportValidation {
  readonly report: DelegateReport | null;
  readonly errors: string[];
}

/**
 * Reads a specialist's report as the structured object it was asked for, and says what it missed.
 *
 * Every error string here is addressed to the specialist rather than to the owner: it is
 * interpolated into the one correction message the mission loop is allowed to send, so it has to
 * name the field and the fix rather than describe a parse.
 */
export const validateDelegateReport = (text: string): DelegateReportValidation => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start)
    return {
      report: null,
      errors: ['the report is prose: there is no JSON object in it at all']
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return {
      report: null,
      errors: [
        `the JSON object in the report does not parse: ${
          error instanceof Error ? error.message : 'unknown error'
        }`.slice(0, 200)
      ]
    };
  }
  const record = asRecord(parsed);
  if (!record)
    return { report: null, errors: ['the report parses as JSON but is not a JSON object'] };
  if (typeof record.answer !== 'string')
    return { report: null, errors: ['"answer" is missing, or is not a string'] };
  const errors: string[] = [];
  // Absent is fine and wrong-typed is not: a report with no evidence has cited nothing, which the
  // `unverified` notice in the mission loop is what says out loud. A report whose `evidence` is a
  // string is one the harness could not re-read a single span from while looking like it could.
  if (record.evidence !== undefined && !Array.isArray(record.evidence))
    errors.push('"evidence" is present but is not an array, so no citation in it could be re-read');
  const rawEvidence = Array.isArray(record.evidence) ? record.evidence : [];
  const evidence = rawEvidence.flatMap((item) => {
    const entry = asRecord(item);
    const claim = textValue(entry?.claim).trim();
    const source = textValue(entry?.source).trim();
    const quotedSpan = textValue(entry?.quotedSpan).trim();
    return claim &&
      source &&
      source.length <= MAX_EVIDENCE_SOURCE_CHARS &&
      normalisedSpan(quotedSpan).length > 0
      ? [{ claim, source, quotedSpan }]
      : [];
  });
  if (evidence.length !== rawEvidence.length)
    errors.push(
      `${rawEvidence.length - evidence.length} of ${rawEvidence.length} evidence items were dropped: each needs "claim", "source" and "quotedSpan" as non-empty strings, with a "source" of at most ${MAX_EVIDENCE_SOURCE_CHARS} characters and a quote that remains non-empty after text normalization`
    );
  return { report: { answer: record.answer, evidence }, errors };
};

/**
 * The same question asked for a yes or a no.
 *
 * Kept as its own export because `agent.ts` re-exports it and because most callers only want the
 * object: nothing fails on a report that is prose, and a specialist that answered in sentences has
 * still done the work. What changed is that the mission loop now reads the reasons as well, and
 * gets one chance to have them fixed.
 */
export const parseDelegateReport = (text: string): DelegateReport | null =>
  validateDelegateReport(text).report;
