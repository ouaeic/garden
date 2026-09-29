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
 *
 * Lifted out of `agent.ts` unchanged by Wave 7.1.
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
 * The only two statuses the MODEL may write, and the list the validator below is held to.
 *
 * A constant rather than a literal in one `if`, because the type has since grown values the model
 * must never be able to send and the difference between "what this field may hold" and "what a
 * finish call may contain" is now load-bearing in two directions:
 *
 * - The wire. `tool-catalogue.ts` publishes `enum: ['verified','not_applicable']` on the finish
 *   schema, and the catalogue has 27 bytes of headroom against the ceiling
 *   `tool-catalogue.test.ts` enforces. A third enum value costs real bytes on every request of
 *   every turn; a value only the harness ever writes costs nothing at all, because it is never in
 *   anything the model is sent or the model returns.
 * - The claim. A downgrade the model could declare is a downgrade the model could decline to
 *   declare, and then it is not evidence about the checks - it is one more thing the model says
 *   about itself, which is what this whole file exists not to believe.
 */
export const MODEL_DECLARED_VERIFICATION_STATUSES = ['verified', 'not_applicable'] as const;

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
  | (typeof MODEL_DECLARED_VERIFICATION_STATUSES)[number]
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
 * Calls that say what the turn intends rather than what it observed.
 *
 * Neither can be evidence for anything: publishing a plan and declaring what would prove the job
 * done are both the model speaking, and citing one as the result that verifies a claim is the
 * completion contract closing a loop on itself. `set_acceptance` in particular succeeds by being
 * well-formed, so without this the cheapest citation in any turn would be the promise it made.
 */
const DECLARATION_TOOLS = new Set([
  'load_tools',
  'set_plan',
  'set_acceptance',
  // Asking is the same kind of act: it is something the model said, not something it observed, and
  // a finish that cited its own question as the result verifying a claim would be the loop above
  // closed one step wider. It also keeps a turn whose only successful call was a question eligible
  // for a not_applicable verification, which is exactly what such a turn is.
  'ask'
]);

/**
 * Names the tool calls a finish is actually allowed to cite. Without this a rejected finish only
 * learns that its evidence was wrong, not what would have been right, so it tends to re-send the
 * same shape - which is how one bad completion turned into a full step budget of retries.
 */
/**
 * The state a new turn starts from, which is the previous turn's minus everything that was about
 * the previous turn.
 *
 * Extracted because there are two doors into a new turn and only one of them was doing this. The
 * worker's door handles a message that arrived while the agent was still running; the API's door
 * handles the ordinary case - the owner replying to a task that has finished - and it reset four
 * fields where this resets eleven and deletes three. So the common path carried the last turn's
 * tool results forward as citable evidence for work they predate, carried its nag counters so a
 * turn could fail on its first refusal, carried `mutated` so a fresh turn believed it had already
 * changed something, and carried the notice count so a monitor that had spoken three times last
 * turn was silent for the rest of the conversation.
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
    finishRejections: 0,
    deliveryNagged: false,
    completionNags: 0,
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
    // A new turn has changed nothing yet, so its evidence ordering and its plan both start over.
    mutated: false,
    mutatedBeyondProse: false,
    answered: false,
    repairStep: false,
    answerNagged: false,
    // The effort ladder and the two finish gates are per turn, like the counters above.
    acceptanceFailures: 0,
    acceptanceNagged: false,
    acceptanceBaselineRefusals: 0,
    // The self-continuation bound, per turn like the rest. The owner replying is the thing that
    // starts a turn, so a conversation where they keep replying is a conversation they are watching
    // - it is the turn nobody replied to that is allowed to renew itself.
    selfContinuations: 0,
    planCoverageNagged: false,
    planIsFallback: false,
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

/**
 * Every tool whose successful result is the agent talking rather than the agent looking.
 *
 * `DECLARATION_TOOLS` plus `notify`, and deliberately a second set rather than an addition to that
 * one: `DECLARATION_TOOLS` is what a *plan* is made of and is read in several places that have
 * nothing to do with evidence. This set is the question "has anything been observed", and by that
 * question a notice is exactly what a plan is - something the model composed, carrying nothing back
 * about the world. Without it, `notify` then `ask` cleared the first-act guard below on two calls
 * that between them observed nothing at all.
 *
 * It is also what a finish may not cite. That was written the other way round, on
 * `DECLARATION_TOOLS`, with a comment saying the reason was that widening it "changes a shipped
 * gate and has a price the fixtures in `evals/` would move" - a price, not a reason. The gate it
 * left open was a real one: `file_write` then `notify` then a finish citing the notify passed
 * `completionVerification` on the strength of garden having delivered a sentence the model wrote.
 * Every "cite something that read the outcome back" refusal in this file was one `notify` call away
 * from being satisfied.
 */
const AGENT_SPEECH = new Set([...DECLARATION_TOOLS, 'notify']);

/**
 * What a question has to be before the conversation is parked on it.
 *
 * Pure, and separate from the method that parks, because every clause here is a judgement about the
 * failure this tool creates rather than about plumbing: an agent that asks instead of working. Two
 * of the four are that judgement made mechanical.
 *
 * The one worth explaining is the last. `finish` already lets a turn that used no tools complete
 * conversationally, and the completion nag already bounds a turn that keeps replying without acting
 * - both are garden deciding what to do about a turn that did nothing. A question asked before the
 * turn has observed anything is the same shape from the front: the computer exists to go and look,
 * and the choice between "which of these two files" and "I read both and they differ like this,
 * which do you want" is the whole difference between a machine and a form. So the first act of a
 * turn may not be a question - it has to have looked at something first, and nothing the agent
 * itself said counts as looking, which is what `AGENT_SPEECH` above is.
 */
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
  if (!why)
    return {
      ok: false,
      refusal:
        'Refused: say in why what you cannot do until this is answered. If you can say what you would do either way, do that instead and state the assumption in your reply.'
    };
  if (options.length === 1)
    return {
      ok: false,
      refusal:
        'Refused: one option is not a choice. Send at least two, or leave options out and take any reply.'
    };
  const observed = Object.values(state.turnToolResults ?? {}).some(
    (result) => result.success && !AGENT_SPEECH.has(result.name)
  );
  if (!observed)
    return {
      ok: false,
      refusal:
        'Refused: this turn has not looked at anything yet, so it has not earned a question. Go and find out - read the files, list what is connected, try the thing - and ask only about what is still genuinely undecidable afterwards.'
    };
  if ((state.questionsAsked ?? 0) >= MAX_QUESTIONS_PER_TURN)
    return {
      ok: false,
      refusal: `Refused: this turn has already asked ${MAX_QUESTIONS_PER_TURN} questions, which is the limit. Make the most reasonable assumption, carry on, and say plainly in your reply what you assumed and what would change it.`
    };
  return { ok: true, question, options, why };
};

export const citableEvidence = (state: AgentState): string => {
  const { floor } = evidenceFloor(state);
  const citable = Object.entries(state.turnToolResults ?? {})
    .map(([id, result], index) => ({ id, result, current: index >= floor || result.proseOnly }))
    .filter(({ result }) => result.success && !result.skipped && !AGENT_SPEECH.has(result.name))
    .reverse();
  if (!citable.length)
    return 'No successful tool call this turn can be cited. If the answer came from your own reasoning alone, use {"status":"not_applicable","evidence":[]}.';
  const current = citable.filter((item) => item.current);
  const earlier = citable.filter((item) => !item.current);
  // Bound repair context while keeping the observations that can prove the current state first.
  const shown = [...current, ...earlier].slice(0, 16);
  const list = (fresh: boolean) =>
    shown
      .filter((item) => Boolean(item.current) === fresh)
      .map(
        ({ id, result }) =>
          `${id} (${result.name})${result.command ? ` [exit ${result.command.exitCode}]` : ''}`
      )
      .join(', ');
  return [
    current.length
      ? `Current-state toolCallIds, newest first: ${list(true)}.`
      : 'No result yet establishes the state after the last change; check that outcome before finishing.',
    list(false) ? `Earlier toolCallIds (supporting evidence only): ${list(false)}.` : '',
    shown.length < citable.length
      ? 'Older successful results remain citable when relevant; only the most recent references are listed here.'
      : '',
    'Cite only claims the actual output supports. If the work is already checked, correct the references and call finish directly; do not run another command just to repair a citation.'
  ]
    .filter(Boolean)
    .join('\n');
};

/** Providers do not all expose protocol IDs to the model, so evidence names travel in the result. */
export const completionReference = (state: AgentState, id: string): string => {
  const result = state.turnToolResults?.[id];
  if (!(result?.success && !result.skipped)) return '';
  if (AGENT_SPEECH.has(result.name)) return '';
  return `Result reference: ${id} (${result.name})${result.command ? ` [exit ${result.command.exitCode}]` : ''}.\n`;
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
  // Writing the running brief is bookkeeping, not the work being proved. An agent that finished,
  // cited what it had observed and then recorded the outcome in workspace/GARDEN.md had made a new
  // last change, so its own record-keeping invalidated evidence it had already gathered - and the
  // way out was to read the brief back, which proves only that a file it just wrote says what it
  // wrote. It stays `mutating` everywhere else; it is only not the change the evidence is about.
  //
  // `skipped` is read here rather than `success`, because this reduce is the one consumer that asks
  // about `mutating` without asking whether the call ran: a `file_write` the harness answered
  // without running is still classified as a write by its arguments, and it used to move the floor
  // past evidence the turn had honestly gathered.
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

/** A process reference is citable only through its latest successful completion observation. */
const evidenceCallId = (state: AgentState, reference: string): string => {
  if (state.turnToolResults?.[reference]) return reference;
  const latest = Object.entries(state.turnToolResults ?? {})
    .reverse()
    .find(([, result]) => result.process?.id === reference);
  return latest?.[1].success && !latest[1].skipped && latest[1].process?.completed
    ? latest[0]
    : reference;
};

export const processObservation = (
  task: { id: string; workspaceId: string },
  call: ModelToolCall,
  result: unknown
): { process: { id: string; completed: boolean } } | null => {
  if (call.name !== 'shell' && call.name !== 'process') return null;
  const row = asRecord(result);
  if (
    !row ||
    row.ownerTaskId !== task.id ||
    row.workspaceId !== task.workspaceId ||
    typeof row.sessionId !== 'string' ||
    !/^job_[a-f0-9]{64}$/.test(row.sessionId)
  )
    return null;
  return {
    process: {
      id: row.sessionId,
      completed: row.status === 'completed' && row.exitCode === 0 && row.timedOut !== true
    }
  };
};

export const completionVerification = (
  state: AgentState,
  value: unknown
): { ok: true; verification: CompletionVerification } | { ok: false; reason: string } => {
  if (!value || typeof value !== 'object')
    return { ok: false, reason: 'Finish requires a verification object.' };
  const input = value as Record<string, unknown>;
  // The model's two, and only the model's two. A finish that tries to declare one of the harness's
  // own downgrades is refused here exactly as `{"status":"done"}` is: those values are what the
  // harness concluded about the checks, and a model that could write them could write `verified`
  // over a failure by choosing not to.
  if (
    !(MODEL_DECLARED_VERIFICATION_STATUSES as readonly string[]).includes(textValue(input.status))
  )
    return { ok: false, reason: 'Verification status must be verified or not_applicable.' };
  const status = textValue(input.status) as CompletionVerification['status'];
  const rawEvidence = Array.isArray(input.evidence) ? input.evidence : [];
  /*
   * An id on its own is enough, and a full item is still accepted.
   *
   * This asked for three levels of nesting at the end of a long turn - a status enum, an array of
   * objects each needing a claim and an enum of its own, and a second array - while every other
   * tool in the catalogue takes flat scalars. A small fast model fumbles it: measured on one
   * research task, the agent wrote a correct answer and then spent about ten more turns being
   * refused for unparseable arguments and answering in prose instead. Nothing about the guarantee
   * needed that shape. The id is the part that carries it; the claim is a line for the card, and
   * defaults to the summary when the model did not write one; the source is inferable from the id.
   */
  const evidence = rawEvidence.flatMap((item) => {
    if (typeof item === 'string') {
      const toolCallId = evidenceCallId(state, item.trim());
      return toolCallId ? [{ claim: '', source: 'tool_result' as const, toolCallId }] : [];
    }
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const claim = textValue(record.claim).trim().slice(0, 2_000);
    const toolCallId = evidenceCallId(state, textValue(record.toolCallId).trim());
    // Named when the model named it; otherwise read off what it cited, which is the only thing
    // these three values were ever distinguishing.
    const declared = textValue(record.source);
    /*
     * Inferred only towards the strict reading. `user_visible_result` is the one source that skips
     * the ordering check, so it is never guessed at: an item that cites a call is a tool result,
     * and an item that cites nothing is invalid unless the model said user_visible_result itself.
     * Guessing it here would have turned `{claim:"I did it"}` into a passing verification, which is
     * the confident false completion this whole mechanism exists to refuse.
     */
    const source = ['tool_result', 'published_artifact', 'user_visible_result'].includes(declared)
      ? (declared as CompletionVerification['evidence'][number]['source'])
      : toolCallId
        ? ('tool_result' as const)
        : undefined;
    if (!source) return [];
    return [{ claim, source, ...(toolCallId ? { toolCallId } : {}) }];
  });
  if (evidence.length !== rawEvidence.length)
    return {
      ok: false,
      reason:
        'Every verification item needs either the id of a tool call from this turn, or a claim saying what the user can see.'
    };
  const successful = Object.entries(state.turnToolResults ?? {}).filter(
    ([, result]) => result.success && !AGENT_SPEECH.has(result.name)
  );
  if (status === 'not_applicable' && successful.length)
    return {
      ok: false,
      reason:
        'This turn used tools, so finish with verified evidence from a successful tool result.'
    };
  if (status === 'verified' && !evidence.length)
    return { ok: false, reason: 'Verified completion needs at least one evidence item.' };
  for (const item of evidence) {
    if (item.source === 'user_visible_result') {
      /*
       * The exemption this source carries is from the ordering rule, not from the existence one.
       *
       * `user_visible_result` is the one item that may stand on a claim alone - "the user can see
       * the answer in the reply" cites no call because no call produced it - and it was written as
       * a bare `continue`, so an item of this source skipped every check in this loop including
       * the ones about the call it did cite. A finish could therefore name a call garden answered
       * without running, or one the computer failed, and have it rendered beside the tick as
       * something the user can see. That is §4.5 #73's shape exactly: evidence that was claimed
       * and never produced, counted as satisfied.
       *
       * Deliberately narrow. Citing nothing is still allowed, because that is what the source is
       * for; citing a `notify` is still allowed, because a delivered notice genuinely is something
       * the user can see even though it is not an observation; and the ordering rule is still
       * skipped. Only a call that produced nothing at all is refused, and for a call that produced
       * nothing there is nothing to see.
       */
      const cited = item.toolCallId ? state.turnToolResults?.[item.toolCallId] : undefined;
      if (cited && (cited.skipped || !cited.success))
        return {
          ok: false,
          reason: `Verification cites ${item.toolCallId} as something the user can see, but that ${cited.name} ${
            cited.skipped
              ? 'never ran - garden answered it without starting it'
              : 'did not complete successfully this turn'
          }, so it produced nothing to see. Cite the call that did produce it, or describe what the user can see without citing a call.`
        };
      continue;
    }
    if (!item.toolCallId)
      return {
        ok: false,
        reason: `${item.source} evidence must cite its toolCallId.`
      };
    const result = state.turnToolResults?.[item.toolCallId];
    // Said apart from the failure below, because they are different facts about the world and the
    // way out of them is different: a call that failed was attempted and the computer answered, a
    // call garden answered itself was never attempted at all. Told it "did not complete
    // successfully", a model re-cites a neighbour; told nothing ran, it runs the call.
    if (result?.skipped)
      return {
        ok: false,
        reason: `Verification cites ${item.toolCallId}, but that ${result.name} never ran - garden answered it without starting it. Run it, then cite the result.`
      };
    if (!result?.success)
      return {
        ok: false,
        reason: `Verification cites ${item.toolCallId}, but that tool did not complete successfully this turn.`
      };
    if (AGENT_SPEECH.has(result.name))
      return {
        ok: false,
        reason: `Verification cites ${item.toolCallId}, which is ${result.name} - something you said rather than something you observed. Cite the call that read the outcome back.`
      };
    if (item.source === 'published_artifact' && result.name !== 'publish_artifact')
      return {
        ok: false,
        reason: `Published artifact evidence must cite a successful publish_artifact call.`
      };
  }
  const citableIds = new Set(successful.map(([id]) => id));
  if (
    successful.length &&
    !evidence.some((item) => item.toolCallId && citableIds.has(item.toolCallId))
  )
    return {
      ok: false,
      reason: 'Verification must cite at least one successful tool result from this turn.'
    };
  // Evidence has to come from after the last change, not before it.
  //
  // Every rule above tests identity: that the cited id exists, succeeded, and is of the right
  // kind. None of them tested ordering, so a turn that ran code_search, wrote a file and then
  // claimed "the tests now pass" citing the search was accepted - which made citing whatever
  // succeeded most recently the cheapest way to satisfy the gate. turnToolResults is
  // insertion-ordered, so the ordering this needs is already recorded.
  const { order, lastMutation, floor, observedItsOwnChange } = evidenceFloor(state);
  if (status === 'verified' && lastMutation >= 0) {
    /*
     * A written report stays citable wherever it sits in the turn.
     *
     * `lastMutation` is the last mutating call in order, so a turn that wrote the report and then
     * ran one command - `df -h` through a shell, say - moved the floor past the report and refused
     * every finish that cited it. The owner's turn hit exactly that: "every cited result predates
     * the last shell call", about the file it had been asked to produce. Prose is its own evidence
     * by the reasoning just above; that does not stop being true because something read-only ran
     * afterwards.
     */
    const grounded = evidence.some((item) => {
      if (!item.toolCallId) return false;
      const index = order.indexOf(item.toolCallId);
      if (index < 0) return false;
      return index >= floor || state.turnToolResults?.[item.toolCallId]?.proseOnly === true;
    });
    if (!grounded) {
      const mutation = order[lastMutation] ?? '';
      const name = state.turnToolResults?.[mutation]?.name ?? 'the last change';
      return {
        ok: false,
        reason: observedItsOwnChange
          ? `Every cited result predates ${name} (${mutation}), so none of it can show that change worked. Cite ${mutation} itself if its output shows the outcome, or check the result - read the file back, run the tests, re-observe the page - and cite that call.`
          : `Every cited result predates ${name} (${mutation}), so none of it can show that change worked. Check the result - read the file back, run the tests, re-observe the page - and cite that call instead.`
      };
    }
  }
  return {
    ok: true,
    verification: {
      status,
      evidence,
      remainingRisks: Array.isArray(input.remainingRisks)
        ? input.remainingRisks
            .map((risk) => textValue(risk).trim())
            .filter(Boolean)
            .slice(0, 20)
        : []
    }
  };
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
 * - and until this it held only the model's own claims, so an owner reading "54 data rows (30
 * months x 3 products)" there had no way to tell which half the computer tested. The line is the
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
 * a report the lead should be told about, and the failure it can no longer produce is a specialist
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
