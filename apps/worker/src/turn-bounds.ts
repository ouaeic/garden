/**
 * Every ceiling a turn runs into, and the sentence the owner reads when it does.
 *
 * A turn ends because it finished or because it hit one of these. Each constant here is a number
 * somebody chose after watching a turn fail without one, and each is paired in the same file with
 * the wording that explains the stop - because a bound whose message lives elsewhere is a bound
 * that gets raised without anyone rereading what it says.
 *
 * They are together rather than beside their call sites because they are read against each other:
 * `IDLE_STEPS_BEFORE_STOP` is twice `MAX_IDLE_STEPS` and `REPEATED_FAILURES_BEFORE_STOP` is twice
 * `MAX_REPEATED_FAILURES`, and that relation is only legible when both halves are on screen.
 */
import { GardenError, sha256, spendHalt, spendWarning } from '@garden/core';

/*
 * The two owner-facing spending sentences now live in `@garden/core`, because the API builds the
 * same card the worker's halt writes and the two must quote one set of numbers. They are re-exported
 * here so the worker's own callers - and the tests that cover the wording - keep the import they
 * had; nothing about what they say has changed.
 */
export { spendHalt, spendWarning };
import type { ModelMessage, ModelToolCall } from '@garden/model-gateway';
import type { AgentState } from './agent-state.js';
import { canonicalJson } from './values.js';

/**
 * Tools whose second run cannot surprise anyone: they only read, so repeating one after a restart
 * costs nothing and tells the owner nothing new. Everything else is assumed to have reached the
 * workspace, the outside world, or the owner's provider bill by the time it was interrupted, and is
 * never replayed on its own. `set_plan` is here because a repeated publish of the same steps is
 * version-guarded and idempotent in effect.
 */
export const REPEATABLE_TOOLS = new Set([
  'load_tools',
  'browser_snapshot',
  'code_diagnostics',
  'code_search',
  'connector_list',
  'desktop_observe',
  'document_read',
  'document_search',
  'file_read',
  'files_list',
  'image_read',
  'memory_recall',
  'parallel_web_read',
  'repo_overview',
  'session_search',
  'set_acceptance',
  'set_plan',
  'web_search'
]);

/**
 * The members of the set above that are safe to run twice and still leave something behind.
 *
 * Two properties were being read off one list, and only one of them is what that list says. A tool
 * whose second run cannot surprise anyone is a tool that is safe to REPLAY; it is not necessarily a
 * tool that changed nothing. `code_diagnostics` is exactly that gap and it is the only member: a
 * repeated `make -s` tells the owner nothing new, which is what earns it a place above, and it
 * writes to the tree while doing it, which is what takes it out of the two sets derived below.
 *
 * Measured on this machine rather than argued, and measured on both halves of the tool - because the
 * point is that the split the removed approval card drew is not this one:
 *
 *   - `make -s` on a Makefile whose default target writes a file wrote it. 1 new file, exit 0.
 *   - `cargo check --message-format short` on a crate with a `build.rs` that writes a file left 50
 *     new paths: `Cargo.lock`, the build script's own file, and 48 under `target/`.
 *   - `cargo check` on a crate with NO `build.rs` at all still left 16: `Cargo.lock` and 15 under
 *     `target/`. Nothing a stranger wrote had to run for that.
 *   - `python3 -I -m compileall -q .` wrote `__pycache__/app.cpython-310.pyc`, and `tsc --noEmit`
 *     under `incremental: true` wrote `tsconfig.tsbuildinfo`. Those are two of the SIX languages the
 *     old card called safe.
 *
 * So the whole tool writes, not nine fifteenths of it, and the bound is unconditional. That is also
 * why this is a set of tool names and not a per-language question: the only thing that could answer
 * per language is a directory listing taken before the call, which is the runner round trip the
 * approval floor was doing and no longer does.
 *
 * The ordinary call lands under `workspace`, which is `CHECKPOINT_CONTENT[0]`, so the undo point
 * below covers what these commands write. It is a default and not a guarantee - the runner's
 * `resolveInside` confines an exec cwd to the container home rather than to `workspace` - and a
 * checkpoint that covers the common case is still the difference between a rewind and none.
 *
 * And the set this one is NOT about, because the obvious next move after reading the above is to
 * finish the job and it would be wrong: `code_diagnostics` stays on `NON_MUTATING_TOOLS` in
 * `write-classification.ts`. That set asks a third question - is the result a check, or a change
 * whose evidence `finish` must see re-cited afterwards - and a compiler is the verification, not the
 * thing to verify. Its own comment says so. Reading "left nothing behind" off "safe to replay" is
 * the defect this constant exists for; reading "not a check" off "it writes" is the same mistake
 * pointed the other way, and it would leave a model unable to ground its own completion.
 */
export const REPEATABLE_TOOLS_THAT_WRITE: ReadonlySet<string> = new Set(['code_diagnostics']);

/** Exact read repeats are suppressed until an observed write or job update invalidates their inputs. */
export const IDEMPOTENT_WITHIN_TURN = new Set([
  // The only member that costs money to repeat. Transcription is billed by the minute, so a second
  // identical reading of the same window of the same recording buys the same text twice.
  'audio_read',
  'code_search',
  'document_read',
  'document_search',
  'file_read',
  'memory_recall',
  'repo_overview',
  'session_search'
]);

/** How a repeat is recognised: the tool and the exact arguments, which is what makes it a repeat. */
export const idempotentCallKey = (call: ModelToolCall): string =>
  `${call.name}:${JSON.stringify(call.arguments)}`;

/**
 * Tools whose calls may be in flight at the same time as each other.
 *
 * `REPEATABLE_TOOLS` minus its two writers is the obvious basis and it is very nearly right, but it
 * is not the property being asked for, and it should not be inherited without saying so: its own
 * comment defines it as a replay-safety set - a tool whose second run after a restart cannot
 * surprise anyone - and surviving a replay says nothing about two calls overlapping. Three things
 * have to hold, and the third costs the set a third member:
 *
 * - The call cannot change the computer, so no order between it and a sibling is observable at all.
 *   `set_plan` and `set_acceptance` are the two members that write, and both are out: a plan
 *   published while the read that decides its next step is still running is a plan nobody chose.
 *   `REPEATABLE_TOOLS_THAT_WRITE` is out for the same clause and was in for years: two `make -s`
 *   runs over one tree race for the targets they both build, and two `cargo check`s block on the
 *   same `target/` lock. Subtracting it costs a batch containing a diagnostic one round trip, which
 *   is what this bullet has always been willing to pay.
 * - Its answer does not depend on when a sibling's answer lands. Everything left reads the
 *   workspace, the memory store, or a search index.
 * - The approval floor's verdict on it cannot move while the run is in flight. This is what puts
 *   `parallel_web_read` out, and it is not a technicality. While the turn is tainted, a web read is
 *   judged against `turnNoveltyBytes` - a per-turn budget of bytes that appear nowhere in the
 *   owner's request - and that budget is only charged when a result is recorded. Two reads judged
 *   concurrently are both judged against the same spent total, so a pair that run one after the
 *   other would card on the second can both go out with no card at all. That is the exfiltration
 *   floor, and it is not being traded for a round trip. `parallel_web_read` is also the member that
 *   wants this least: it already fetches up to twelve pages at once inside itself.
 */
export const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set(
  [...REPEATABLE_TOOLS].filter(
    (name) =>
      !['set_plan', 'set_acceptance', 'parallel_web_read'].includes(name) &&
      !REPEATABLE_TOOLS_THAT_WRITE.has(name)
  )
);

/**
 * How many of them run together.
 *
 * Four. It is the shape the batches actually have - a task opens with three or four `file_read`s,
 * or a `code_search` beside a `repo_overview` - so a higher cap would buy almost nothing real, and
 * every one of these calls crosses to a single workspace runner serving one container and holds a
 * whole file body in this process while it does. Four whole files is the most of the owner's memory
 * this loop is willing to hold to save a round trip. A longer batch is not refused: it runs as
 * consecutive runs of four, which is still four times fewer waits than before.
 */
export const MAX_PARALLEL_TOOL_CALLS = 4;

/**
 * How many calls from `from` may run as one concurrent run: the maximal run of consecutive
 * parallel-safe calls, capped, and stopped in front of anything the loop answers instead of running.
 *
 * A run of one is not a run - the caller reads anything below two as "take the ordinary path" - so
 * the guards that end a run early cost nothing but the parallelism they were going to save. A call
 * whose arguments were cut off mid-JSON is one of those, and so is an exact repeat of a read this
 * turn has already answered: both are answered with a message rather than executed, and that
 * message has to keep its place in the declared order, so the run ends in front of it.
 */
export const parallelToolRun = (
  calls: readonly ModelToolCall[],
  from: number,
  seenCalls: Readonly<Record<string, string>> = {}
): number => {
  const seen = new Set(Object.keys(seenCalls));
  let length = 0;
  while (from + length < calls.length && length < MAX_PARALLEL_TOOL_CALLS) {
    const call = calls[from + length];
    if (!call || !PARALLEL_SAFE_TOOLS.has(call.name) || call.parseFailed) break;
    if (IDEMPOTENT_WITHIN_TURN.has(call.name)) {
      const repeat = idempotentCallKey(call);
      if (seen.has(repeat)) break;
      seen.add(repeat);
    }
    length += 1;
  }
  return length;
};

/**
 * Tools that cannot change the computer, so a turn made only of these needs no undo point.
 *
 * The read-only set above is very nearly the right basis and the inference it invites is the one
 * defect this constant has ever had: a tool that is safe to run twice after a restart is NOT
 * therefore a tool that left nothing behind to undo. `finish` and `compact_context` are added
 * because they are harness bookkeeping and never touch the workspace, and `notify` because the only
 * thing it reaches is the owner's own lock screen - it is not repeatable, since a second send is a
 * second buzz, but there is nothing on the computer for a checkpoint to hold. Everything else counts
 * as mutating, deliberately - a checkpoint taken before a call that turns out to change nothing
 * costs a walk of the tree and no bytes at all, and missing one costs the owner their undo.
 *
 * `REPEATABLE_TOOLS_THAT_WRITE` is subtracted, and that subtraction is the bound that replaced the
 * `code_diagnostics` approval card. The card asked the owner whether to run a build recipe somebody
 * else wrote; it asked in a place a `shell` call one line over does not ask, it charged the owner's
 * own Rust project for their own code, and it sat on this very set claiming there was nothing to
 * undo while the repository next door recorded `make -s` and `cargo check` writing files. So a turn
 * of nothing but diagnostics took no undo point at all - the one shape where a rewind is most
 * plainly wanted, because a build is the thing an owner runs on a tree they have not read.
 *
 * A bound beats a question. This costs one lazy tree walk on the first diagnostic of a turn that
 * would otherwise have taken none, it cannot be tapped through, and it is right in every language
 * rather than in nine of fifteen - which matters, because two of the six the card called safe were
 * measured writing too (see above). What the card asked, this answers.
 */
export const CHECKPOINT_EXEMPT_TOOLS = new Set([
  'decide',
  // Versions are immutable and checkout only creates missing files. No existing source is overwritten.
  'project_update',
  ...[...REPEATABLE_TOOLS].filter((name) => !REPEATABLE_TOOLS_THAT_WRITE.has(name)),
  'finish',
  'compact_context',
  'notify'
]);

/**
 * Whether a turn that lost its undo point lost it for a reason the owner can do something about.
 *
 * Measured: writing a two-line haiku produced a transcript whose loudest card was "This turn has no
 * undo point for the computer", raised because the runner could not take a checkpoint - a fact
 * about the machine, not about the verse. There is exactly one cause of it the owner can clear, and
 * the runner says so in as many words when it refuses: the host disk is too full. That one reaches
 * the conversation; every other cause stays in the work log, where the record still exists for
 * anyone who goes looking for why a rewind is not on offer.
 */
/**
 * Where an approval was raised from, for the row the owner can look back through.
 *
 * `approvals.origin` has been a column since the table was created, `createApproval` has taken it
 * as an optional parameter, `listApprovals` has projected it and `GET /v1/approvals` has served it
 * - and nothing has ever passed one, so every row on every box carries NULL. The reason to write it
 * is the one stated beside `#raiseTaint` below: a repeat origin across tasks is the strongest
 * residual attack in this design, buying the ranking for a query the owner will plausibly run, and
 * a repeat is only visible if each occurrence is on a row somebody can go back to. The warning
 * event records the transition; this records which card the owner was standing in front of.
 *
 * The newest source rather than the first, for the same reason the taint keeps the newest eight: it
 * is the arrival that raised the floor this card is standing on, not the eight ordinary pages read
 * before it.
 *
 * Deliberately absent rather than a placeholder on a clean turn. "Raised while untrusted content
 * was in the room" and "raised on the owner's own work" are different facts, and a column where
 * every row says something makes them indistinguishable.
 */
export const approvalOrigin = (state?: Pick<AgentState, 'taint'>): string | undefined =>
  state?.taint?.sources.at(-1);

/**
 * What the owner is told when they stop a conversation, and what became of its background work.
 *
 * The second sentence is the runner's, used exactly as it was given. A declared service is meant to
 * outlive the task that started it, so cancelling deliberately leaves it serving - and the runner
 * writes that exemption out itself precisely so this side cannot phrase it wrongly. An owner told
 * only "cancelled" reads it as everything having stopped, closes the tab on a dashboard that is
 * still up, and wonders why a port they thought they had freed is busy.
 *
 * Nothing is added when the runner did not answer: a computer that is not talking is one of the
 * reasons somebody presses Stop, and a guess about what is still running is worse than silence.
 */
export const cancelConfirmation = (note?: string): string =>
  `Task cancelled by user${note ? `. ${note}` : ''}`;

export const HOST_DISK_FULL_CHECKPOINT_CODE = 'checkpoint_host_disk_full';

/**
 * The workspace the runner will not checkpoint automatically because it holds too many files.
 *
 * The second of the two, and the one the prose fallback below never matched: an owner with two
 * `node_modules` trees crossed the runner's file ceiling, lost every automatic undo point from then
 * on, and was told by the rewind dialog that the turn "changed nothing on the computer" about turns
 * that changed a great deal. It is owner-fixable in the plainest way - delete something, or take a
 * named recovery point - which is exactly why it has to reach them.
 *
 * It now decides cards as well as dialogs. A turn refused a checkpoint has no undo point, so the
 * approval floor's location rule - which frees a delete strictly inside `CHECKPOINT_CONTENT`
 * because a rewind puts it back - must keep the card for the whole of that turn. The fact travels
 * as `ApprovalContext.undoPoint`, written from `state.checkpoint` by `approval-floor.ts`.
 */
export const WORKSPACE_TOO_LARGE_CHECKPOINT_CODE = 'checkpoint_workspace_too_large';

/**
 * The refusal codes above that name something the owner can clear.
 *
 * A set rather than a comparison because the runner has more than one such refusal, and will have
 * more again. `runner_request_failed` is deliberately not here - it is the code every refusal that
 * is not specially named carries, so treating it as owner-fixable would put the loudest card in the
 * transcript in front of somebody who can do nothing about it.
 */
const OWNER_FIXABLE_CHECKPOINT_CODES = new Set([
  HOST_DISK_FULL_CHECKPOINT_CODE,
  WORKSPACE_TOO_LARGE_CHECKPOINT_CODE
]);

/**
 * The runner's code, dug out of the sentence it was flattened into.
 *
 * `AgentRunnerClient.checkpoint` used to be the one runner call in this package that did not build
 * its error through `runnerFailure` - it threw `Checkpoint failed (<status>): <body>` with the
 * runner's own `{error:{code,message,…}}` envelope flattened into the sentence, so the code was
 * present on the wire and thrown away by the client rather than by the runner. That half is now
 * fixed and the code arrives as an `GardenError` field.
 *
 * This stays as the fallback, for the same reason the prose regex below does: a worker is routinely
 * a release ahead of the box it talks to, and a runner that still flattens is still readable.
 */
const checkpointRefusalCode = (message: string): string | undefined => {
  const start = message.indexOf('{');
  if (start < 0) return undefined;
  try {
    const envelope = JSON.parse(message.slice(start)) as { error?: { code?: unknown } };
    const code = envelope.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
};

export const ownerFixableCheckpointFailure = (
  message: string,
  failure?: { code?: string }
): boolean =>
  OWNER_FIXABLE_CHECKPOINT_CODES.has(failure?.code ?? checkpointRefusalCode(message) ?? '') ||
  // The fallback, and it stays. The code only exists in the runner from this release on, a worker
  // is routinely a version ahead of the box it talks to, and reading a sentence is the wrong way
  // round only while there is a better way round available.
  /disk is too full|no space left|ENOSPC|storage is full|quota exceeded/i.test(message);

/**
 * How many times failing acceptance checks send the answer back. Past it the turn completes with the
 * failures stated, which is a truthful unfinished job rather than an endless loop.
 */
export const MAX_ACCEPTANCE_FAILURES = 4;

/** What the owner reads when the checks failed, and when they could not run at all. */
export const ACCEPTANCE_FAILED_CAVEAT =
  'garden ran the checks this turn declared and they did not pass, so nothing here is verified - read the failures below before relying on it.';
export const ACCEPTANCE_COULD_NOT_RUN_CAVEAT =
  'garden could not run the checks this turn declared, so this result is unchecked - neither proved nor disproved.';

/**
 * Tools the loop answers out of its own state, ahead of the line that records a tool as started.
 *
 * None of these reaches the workspace, the network or the model provider, so none of them is
 * evidence that a step did anything - and every one of them already carries its own bound:
 * `notify` has `MAX_NOTICES_PER_TURN`, `ask` parks the turn, `compact_context` rewrites the window
 * it is called from. A step whose whole output is one of these is therefore left alone by the guard
 * below rather than counted twice by two bounds that would then race each other.
 */
const LOOP_ANSWERED_TOOLS: ReadonlySet<string> = new Set([
  'compact_context',
  'notify',
  'ask',
  'propose_deal',
  'set_acceptance'
]);

/**
 * How many steps in a row may start no tool before the loop says so in as many words.
 *
 * The completion nag above is the same failure seen from one side only: it counts replies that
 * carried *no tool call at all*, and it is reset by any call in the response - including the ones
 * the loop answers instead of running. That reset is the hole. Measured on the owner's box: a
 * fourteen-minute, twelve-call turn on a cheap route that produced a thousand streamed frames, five
 * consolidated replies and no progress, re-deciding one question in fresh words each time. The
 * repetition watch could not see it, because nothing was repeated verbatim; the nag could not see
 * it, because every second step proposed something and zeroed the counter.
 *
 * So the count here is of steps that *started* something, which is the only fact in the loop that
 * cannot be produced by talking. Three. Two consecutive steps with nothing running is an ordinary
 * correction - a read answered from an earlier one, a call re-issued after its arguments were cut
 * off - and the third is the point at which the turn is no longer converging on anything.
 *
 * What it must never do is interrupt a turn that is thinking hard and still moving. It cannot: a
 * single tool starting anywhere in a step resets it to zero, so the length of the reasoning, the
 * effort level, the size of the window and the number of steps are all irrelevant to it. Nor does a
 * step that asked for nothing move it - that is the nag's, and counting it here as well made two
 * steps of ordinary reasoning into two thirds of a break. See the branch that used to.
 */
export const MAX_IDLE_STEPS = 3;

/**
 * How many before the turn is ended rather than pushed back on. Twice the first number, deliberately:
 * the model is told, told again with the count risen, and told a third time before anything stops -
 * so a turn only ends here having been given the two exits three times and taken neither.
 */
export const IDLE_STEPS_BEFORE_STOP = MAX_IDLE_STEPS * 2;

/**
 * What this step did, in the only two terms the guard reads, and what the count becomes.
 *
 * `undefined` means leave the count where it is: the step asked for nothing the loop could have
 * started, so it is the nag's business or a bookkeeping tool's own bound, not this one's.
 */
export const idleStepsAfter = (
  previous: number,
  step: { proposed: readonly string[]; started: number }
): number | undefined => {
  if (!step.proposed.some((name) => !LOOP_ANSWERED_TOOLS.has(name))) return undefined;
  return step.started > 0 ? 0 : previous + 1;
};

/**
 * What the model is told when the count runs out. Not a scolding and not a stop: it names the
 * number, says which of the two exits to take, and rules out the third thing it has been doing.
 */
export const idleStepBreak = (steps: number): string =>
  `NOTHING HAS RUN FOR ${steps} STEPS. Every tool you asked for in that time was answered from what this turn already has - a repeat of a call already made, or a call that could not be run - so the work has not moved since. Deciding again in different words will not move it either. Do one of two things now: take the next concrete action, with arguments that differ from anything already tried, or call finish and say plainly what you are stuck on and what you would need to get past it.`;

/**
 * How many times one call may fail in exactly the same way before the loop says so.
 *
 * The last shape in this file that nothing counted. A tool that fails is written to the timeline,
 * answered into the window and charged for its addresses, and then forgotten: nothing accumulates,
 * so a tool failing the same way twenty times running is twenty separate surprises, each one
 * answered, paid for and dropped. Neither of the two watches that exist can see it. The repetition
 * watch reads the model's own text, and the text around a retry is different every time - often
 * better every time, which is what a model does when it is sure the next attempt will work. The
 * idle guard reads whether a tool started, and a call that starts, runs and throws has started one,
 * which is precisely what resets it.
 *
 * Three, matching the idle guard, and for the same reason. Two identical failures is an ordinary
 * correction - a command re-run after the service it needs was started, a patch re-sent after the
 * file was re-read - and the third is the point at which the retry has stopped being a correction
 * and become the plan. Every attempt past it costs a full step and a full model call, which is what
 * makes this the most expensive failure shape there is.
 *
 * What it would not have caught, said plainly, because it was the turn that prompted it: the
 * seventy-two-call turn on the owner's box that spent $3.78 while ignoring an instruction to stop
 * was making progress by every measure the loop has. Its calls succeeded. Nothing below would have
 * touched it, and a bound that claimed otherwise would be garden asserting something it cannot
 * see. That turn needs a different bound; this one is for the retry that cannot work.
 */
export const MAX_REPEATED_FAILURES = 3;

/**
 * How many before the turn is ended rather than pushed back on. Twice the first number, exactly as
 * the idle guard does it: told, told again with the count risen, told a third time, and only then
 * stopped - so nothing ends here without the model having been given both exits three times.
 */
export const REPEATED_FAILURES_BEFORE_STOP = MAX_REPEATED_FAILURES * 2;

/**
 * How many separate failing calls one turn keeps a count for.
 *
 * The counts live in the encrypted task state, which is written on every step, so this is a size
 * bound on that write rather than a judgement: sixteen distinct calls each failing in their own way
 * is already a turn in trouble, and the ones dropped are the ones the turn has stopped returning
 * to.
 */
const TRACKED_FAILING_CALLS = 16;

/**
 * The failure as its kind rather than its wording, for deciding whether two of them are one.
 *
 * The wording carries the parts that legitimately move between two attempts at the same thing - a
 * duration, a byte count, a request id - and two attempts differing only in those are the same
 * attempt. `GardenError` already publishes the kind as its code, which is the runner's own reason
 * for refusing; everything else is reduced to its shape.
 *
 * Not `failureClass` in failure-record.ts, which answers a different question for the journal: that
 * one is about what may be written to an unencrypted line on the owner's box, and it deliberately
 * drops the message entirely. This one needs the message, because on a plain `Error` the message is
 * the only thing that distinguishes one failure from another - and it never leaves the encrypted
 * state.
 */
export const failureSignature = (error: unknown): string =>
  error instanceof GardenError
    ? error.code
    : (error instanceof Error ? error.message : 'tool failed')
        .toLowerCase()
        .replace(/[0-9a-f]{8,}/g, '#')
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);

/**
 * The call a repeat is counted against: the tool and its exact arguments.
 *
 * Hashed, and this is the reason. The arguments to a `file_write` are a whole file of the owner's
 * writing and the arguments to a `shell` are their command line, and the count outlives the call by
 * design - so what is kept is sixteen bytes that prove two calls were identical and say nothing
 * whatever about what they were.
 */
export const failingCallKey = (call: {
  name: string;
  arguments: Record<string, unknown>;
}): string => `${call.name}:${sha256(canonicalJson(call.arguments)).slice(0, 16)}`;

/**
 * That call failing that way, which is the thing counted, and the whole decision of this guard.
 *
 * The arguments are in the key and the error is not enough on its own, which is the opposite of the
 * obvious reading, so here is the case against it. Same error across *different* arguments is what
 * a search looks like from outside: four candidate paths for a config file, three mirrors of a
 * package index, a walk down a list of ports. Every one of those misses rules something out, so a
 * guard keyed on the error alone interrupts work that is converging - and being wrong in that
 * direction costs the owner a turn that was going to succeed. Same arguments *and* same error is
 * the opposite kind of fact: the call produced the identical bytes it produced last time, so
 * whatever happened in between - a read, a fix, an install, a whole step of reasoning - provably
 * did not touch the thing that is failing. It is the one statement here that a model cannot talk
 * its way out of, and it is why the reset needs no cleverness at all: an attempt that succeeds, or
 * that fails differently, clears the count by being different.
 *
 * It also settles the case the owner's own work is made of. A test that fails, is fixed and passes
 * is never seen by any of this: a command with a non-zero exit is a tool *result*, the call ran and
 * returned what the runner said, and only a call that threw reaches the counter at all.
 */
export const repeatedFailureKey = (
  call: { name: string; arguments: Record<string, unknown> },
  error: unknown
): string => `${failingCallKey(call)}:${sha256(failureSignature(error)).slice(0, 16)}`;

/**
 * The counts after one call was answered: `failure` is its key when it threw, and null when it
 * returned anything at all.
 *
 * Everything already counted for this call is dropped whichever way it went, so a success clears
 * it and a different error replaces it rather than adding to it.
 */
export const repeatedFailuresAfter = (
  previous: Readonly<Record<string, number>> | undefined,
  outcome: { call: string; failure: string | null }
): Record<string, number> => {
  const others = Object.entries(previous ?? {}).filter(
    ([key]) => !key.startsWith(`${outcome.call}:`)
  );
  if (!outcome.failure) return Object.fromEntries(others);
  // Appended rather than left in place, so the cap drops the calls the turn stopped retrying
  // longest ago rather than whichever happened to be inserted first.
  return Object.fromEntries(
    [...others, [outcome.failure, (previous?.[outcome.failure] ?? 0) + 1] as const].slice(
      -TRACKED_FAILING_CALLS
    )
  );
};

/**
 * The worst count this step actually moved, and which tool it belongs to.
 *
 * Read as a difference across the step rather than as the highest count standing, because a call
 * that failed three times and was then left alone still has its three: judged on the standing
 * maximum the loop would push the same sentence back on every step afterwards, about something the
 * model has already stopped doing.
 */
export const repeatedFailureRise = (
  before: Readonly<Record<string, number>> | undefined,
  after: Readonly<Record<string, number>> | undefined
): { tool: string; count: number } | null => {
  let worst: { tool: string; count: number } | null = null;
  for (const [key, count] of Object.entries(after ?? {})) {
    if (count <= (before?.[key] ?? 0) || count <= (worst?.count ?? 0)) continue;
    worst = { tool: key.split(':')[0] ?? 'that call', count };
  }
  return worst;
};

/**
 * What the model is told when the count runs out. The idle guard's shape: the number it has
 * reached, the fact underneath it, and the two ways out named before anything ends.
 */
export const repeatedFailureBreak = (count: number, tool: string): string =>
  `THE SAME CALL HAS FAILED ${count} TIMES RUNNING. Each of those was ${tool} with byte-identical arguments, and each came back with the same error, so nothing that happened in between changed what is failing - asking again will cost another step and return that error again. Do one of two things now: take a different action - different arguments, a look at why it is failing, or starting whatever it depends on first - or call finish and say plainly what is broken and what you would need to get past it.`;

/**
 * Tools whose result is the harness's own receipt rather than a fact about the world.
 *
 * The distinction the stationarity guard below is built on, and the reason it needs two tiers.
 * `LOOP_ANSWERED_TOOLS` is already this set minus its one writer: those are answered by the loop
 * itself, so their result is written a few lines from where the call was read. `set_plan` is added
 * because it writes only garden's account of what it is doing - the plan document, versioned
 * against the owner's own edits - and never the computer, the outside world, or the owner's bill.
 *
 * Derived rather than listed, so a tool the loop learns to answer joins both sets in one edit, with
 * one addition and one subtraction and both are named. `set_plan` is added for the reason above.
 * `finish`, `ask` and `notify` are taken out because each already carries a per-turn ceiling of its
 * own at or below this guard's - `MAX_FINISH_REJECTIONS` is three, `MAX_QUESTIONS_PER_TURN` is two
 * and parks the turn, `MAX_NOTICES_PER_TURN` is three - so counting them here would only ever
 * restate a sentence the model has already been given, one step later and in worse words. They are
 * still *seen* by the guard; they simply fall to the acting tier, where a run of them breaks on the
 * first differing result, which is what those three ceilings produce on the attempt that trips them.
 */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(
  [...LOOP_ANSWERED_TOOLS, 'set_plan', 'load_tools'].filter(
    (name) => !['finish', 'ask', 'propose_deal', 'notify'].includes(name)
  )
);

/**
 * How many steps in a row may take the identical action before the loop says so.
 *
 * The case none of the three guards above can see, and it is the incident this watch was written
 * for: a byte-identical `set_plan` twelve times running. It is not idle - `set_plan` is not a tool
 * the loop answers, so every one of those steps started something and zeroed the idle count. It is
 * not a repeated failure - every one of them succeeded, and only a call that *threw* reaches that
 * counter. And it is not a degenerate generation - the prose around each call was different, often
 * better each time, because that is what a model writes when it is sure this attempt is the one
 * that lands. Only the step budget stopped it, at up to a hundred and twenty steps.
 *
 * Three, matching the idle guard and the failure guard, and for the third time the same reason: two
 * identical actions is an ordinary correction - a plan republished after a step was marked, a
 * declaration re-sent after an edit - and the third is the point at which repeating it *is* the
 * plan.
 */
export const MAX_STATIONARY_STEPS = 3;

/**
 * The same count for a step that actually touched something, which is allowed one more.
 *
 * Two tiers, split on what the step's result is evidence *about*, because one number cannot be
 * right for both. A bookkeeping call's result is a receipt this process wrote, so an identical call
 * is stationary whatever came back. An acting call's result is a report from the workspace or the
 * outside world, so it is only stationary when the report is identical too - and `stationaryStepRun`
 * below folds the result into the signature for exactly this tier and only this tier.
 *
 * That difference is not a refinement, it is the whole safety property. It is what lets this watch
 * cover every tool in the catalogue rather than an allowlist of eight: polling a build, re-observing
 * a page and re-reading a growing log all produce a different report each time, so none of them is
 * ever seen here at all. It is also why the bookkeeping tier must NOT read the result - `set_plan`
 * answers with the version it just created, so its receipt differs by construction, and keying on it
 * would have made the one incident this guard exists for invisible to it.
 *
 * Four rather than three because an acting result can legitimately be identical for a reason a
 * bookkeeping one cannot - a build that has not finished changing, a page mid-load - and one extra
 * step is cheap against being wrong in the direction that interrupts work about to converge. It is
 * also the one thing that finally counts the shape `MAX_REPEATED_FAILURES` says outright that it
 * cannot see: a command with a non-zero exit is a tool *result*, so a `shell` re-running the same
 * failing suite twenty times reaches no counter in this file. Its report is identical every time,
 * and identical reports are what this tier counts.
 */
export const MAX_STATIONARY_ACTING_STEPS = 4;

/**
 * How many before the turn is ended rather than pushed back on. Twice the tier's own number, as the
 * idle and failure guards do it, so nothing ends here without having been told and given both exits
 * three times over.
 */
export const stationaryStepsBeforeStop = (limit: number): number => limit * 2;

/**
 * The two separators the rendering below uses, and the sentinel for a call nothing answered.
 *
 * Unit and record separators rather than a colon or a newline, because one half of a rendered pair
 * is attacker-influenced in the general case - a `shell` command line, a page body, a file the
 * model was told to read - and a separator that can occur inside a field is a boundary a crafted
 * argument can forge. Neither of these can appear unescaped in JSON text at all, so two steps can
 * only collide here by genuinely being the same step.
 */
const FIELD = '\u001f';
const RECORD = '\u001e';

/**
 * One step's action, as the thing that decides whether two steps did the same thing.
 *
 * Canonical and order-insensitive over the whole call set, which is three separate claims and each
 * of them is load-bearing:
 *
 * - `canonicalJson` sorts object keys recursively, so a model emitting the same arguments with its
 *   keys in a different order the second time is emitting the same arguments. Array order is
 *   preserved by that function and must be: the order of `steps` in a plan and of `patches` in an
 *   edit is the meaning, not the spelling.
 * - The rendered set is sorted, so two `file_read`s proposed in the other order are the same step.
 *   A model asking for the same four files is not making progress by shuffling them.
 * - The result is folded in only when the caller passes one, which is the acting tier's business
 *   and is argued at `MAX_STATIONARY_ACTING_STEPS`.
 *
 * Hashed, and for `failingCallKey`'s reason rather than for cheapness: the arguments to a
 * `file_write` are a whole file of the owner's writing and the arguments to a `shell` are their
 * command line, and this value goes in the payload of the event that reports the stop. Sixteen
 * bytes prove two steps were identical and say nothing whatever about what they were.
 */
export const stepSignature = (
  calls: readonly { name: string; arguments: Record<string, unknown>; result?: string }[]
): string =>
  sha256(
    calls
      .map(
        (call) =>
          `${call.name}${FIELD}${canonicalJson(call.arguments)}${
            call.result === undefined ? '' : `${FIELD}${call.result}`
          }`
      )
      .sort()
      .join(RECORD)
  ).slice(0, 16);

/**
 * The steps this window records, oldest first, each one a model turn that started something.
 *
 * Read out of `state.messages` rather than accumulated in a counter, and that is deliberate: the
 * window is the part of a turn that is persisted, encrypted and carried across a compaction, an
 * approval pause and a worker handover, so a bound derived from it survives all three. A counter in
 * the loop frame would not, and this file's own rule is that a bound a restart clears is not one.
 *
 * A reply that carried no tool call neither ends a run nor starts one. That is what makes this
 * *action* stationarity: a model that says something new between two identical actions has still
 * taken the identical action twice, and the guards that judge what it said - the completion nag and
 * the idle break - are the two directly above.
 *
 * Nor does a step where nothing actually ran, and that clause was bought by the eval rig rather than
 * reasoned out: without it this guard fired a second time on the two fixtures that belong to the
 * guards beside it - `deliberation-that-ignores-the-break-is-stopped` and
 * `the-same-call-failing-the-same-way-is-stopped` - and cost each of them two extra model calls
 * restating, one step later and in worse words, a sentence the model had already been given. A call
 * the harness answered without running is the idle guard's, at three; a call that threw is the
 * failure guard's, also at three. `turnToolResults` already records which of the three happened,
 * per call id, in the persisted state, so this asks the record rather than reading the tool result's
 * text back out of the window.
 */
const actionSteps = (
  messages: readonly ModelMessage[],
  ran: (callId: string) => boolean,
  wanted: number
): Array<{ calls: readonly ModelToolCall[]; results: Map<string, string> }> => {
  const steps: Array<{ calls: readonly ModelToolCall[]; results: Map<string, string> }> = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      steps.push({ calls: message.toolCalls ?? [], results: new Map() });
      continue;
    }
    // Matched inside the step that proposed it rather than through one map over the whole window: a
    // route may reuse a tool call id across steps, and a global map would then answer every one of
    // them with the newest result - which reads as a changing report and breaks the run.
    if (message.role === 'tool' && message.toolCallId)
      steps.at(-1)?.results.set(message.toolCallId, message.content);
  }
  return steps.filter((step) => step.calls.some((call) => ran(call.id))).slice(-wanted);
};

/**
 * The run of most recent steps that all did the same thing, and the ceiling that run is judged
 * against.
 *
 * Null when the newest step started nothing - there is no action to be stationary about, and that
 * step is the idle guard's - and null when the run is one, which is every healthy step.
 *
 * The tier is the *loosest* any call in the step earns: a step that read a file alongside its
 * `set_plan` touched the computer, so it is judged as an acting step and its report has to match
 * too. Being wrong in that direction costs a step; being wrong the other way stops a turn that was
 * working.
 */
export const stationaryStepRun = (
  messages: readonly ModelMessage[],
  turnToolResults: Readonly<Record<string, { success?: boolean }>> | undefined
): { signature: string; steps: number; limit: number; tools: string[] } | null => {
  // `success` is true only where the tool itself ran and returned: `recordToolFailure` writes false
  // for a call that threw, and `recordToolResult` writes false for every harness answer.
  const ran = (callId: string): boolean => turnToolResults?.[callId]?.success === true;
  const limitFor = (calls: readonly ModelToolCall[]): number =>
    calls.every((call) => BOOKKEEPING_TOOLS.has(call.name))
      ? MAX_STATIONARY_STEPS
      : MAX_STATIONARY_ACTING_STEPS;
  const window = actionSteps(
    messages,
    ran,
    stationaryStepsBeforeStop(MAX_STATIONARY_ACTING_STEPS) + 1
  );
  const newest = window.at(-1);
  if (!newest) return null;
  const limit = limitFor(newest.calls);
  const signatureOf = (step: {
    calls: readonly ModelToolCall[];
    results: Map<string, string>;
  }): string =>
    stepSignature(
      step.calls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
        ...(limit === MAX_STATIONARY_STEPS
          ? {}
          : // A call whose result is not in the window is not the same as one answered with the
            // empty string, and a sentinel that cannot be a tool result is what keeps them apart.
            { result: step.results.get(call.id) ?? RECORD })
      }))
    );
  const signature = signatureOf(newest);
  let steps = 1;
  for (let index = window.length - 2; index >= 0; index -= 1) {
    const earlier = window[index];
    // Judged at the newest step's tier throughout, so a run cannot be broken by re-tiering a step
    // that is byte-identical to the one beside it.
    if (!earlier || limitFor(earlier.calls) !== limit || signatureOf(earlier) !== signature) break;
    steps += 1;
  }
  if (steps < 2) return null;
  return {
    signature,
    steps,
    limit,
    tools: [...new Set(newest.calls.map((call) => call.name))].sort()
  };
};

/**
 * What the model is told when the run runs out. The idle guard's shape - the number it has reached,
 * the fact underneath it, and both ways out named before anything ends - and the fact here is one a
 * model cannot talk its way past: it is not being told that it looks stuck, it is being told the
 * exact call it has now made identically N times.
 */
export const stationaryStepBreak = (steps: number, tools: readonly string[]): string =>
  `NOTHING HAS CHANGED FOR ${steps} STEPS. Every one of them made the same call - ${tools.join(', ')} - with byte-identical arguments${
    tools.every((tool) => BOOKKEEPING_TOOLS.has(tool)) ? '' : ' and got back the identical result'
  }, so the work is exactly where it was ${steps} steps ago and doing it again will leave it there. Do one of two things now: take the next concrete action, with arguments that differ from anything already tried, or call finish and say plainly what is blocking you and what you would need to get past it.`;

/**
 * How many cut-off tool calls one turn answers before it tells the model to stop trying.
 *
 * A truncated call is the model asking for more output than the cap allows, so the same call
 * re-proposed is the same length: without a bound the turn burns its whole step budget on one
 * oversized write. Three is enough to let a model that shortens its payload succeed.
 */
export const MAX_ARGUMENT_TRUNCATIONS = 3;

/**
 * Takes the unparseable payload back out of the window, leaving the call itself standing.
 *
 * The malformed turn is *answered* in the real history - a tool call with no tool result is a
 * malformed window the provider refuses on the next step, so the call cannot simply be dropped -
 * and until this existed the bytes that would not parse were answered and then kept. What is kept
 * is the whole of `rawArguments`: a `file_write` cut off at a 16,384-token output cap carries tens
 * of kilobytes of half-written file, on the assistant message, for the rest of the conversation.
 *
 * Three things that costs, and only the first is the one the floor names:
 *
 * - The record says the model called a tool with arguments nobody can read, so every later step is
 *   reasoning from a turn that never happened. The remedy is a tombstone: the call stands, its
 *   payload does not, and the error result beside it - which keeps its own three error-specific
 *   sentences, they are the good half - is the whole account of what took place.
 * - The window is *measured* from it. `estimatedTokens` in context.ts sizes an assistant message
 *   with `JSON.stringify(message.toolCalls).length`, and that walks `rawArguments`. The adapter
 *   sends none of it - `openai-compatible.ts` serialises `id`, `name` and `JSON.stringify(arguments)`
 *   and `arguments` is `{}` on this path - so a truncated write charged the turn several thousand
 *   tokens of window that no provider would ever see, and the compaction trigger reads that number.
 *   A cut-off call therefore made the turn condense away real history to make room for bytes that do
 *   not exist.
 * - It is persisted. `state.messages` is encrypted into the task row on every step and carried into
 *   every later turn of the conversation, so the garbage outlives the turn that produced it.
 *
 * The declared type is already right, and that is the sharpest way to say what went wrong here.
 * `ModelMessage.toolCalls` in `protocol.ts` is `{id, name, arguments}` and nothing else - a stored
 * tool call is those three fields by definition. The object actually pushed onto `state.messages` is
 * the adapter's `ModelToolCall`, which carries three more, and nothing between the push and the
 * encrypted write ever parses the message back through the schema that would have dropped them. So
 * the extra fields were invisible to the compiler and present in every byte the box wrote to disk.
 *
 * Returns how many bytes were taken out, for the warning event that already reports the truncation:
 * a number is the only part of that payload it is safe to publish, and it is what makes this
 * visible in a transcript at all.
 */
export const tombstoneMalformedCall = (messages: ModelMessage[], callId: string): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !message.toolCalls?.length) continue;
    const at = message.toolCalls.findIndex((call) => call.id === callId);
    if (at < 0) continue;
    const call = message.toolCalls[at];
    if (!call) return 0;
    // Read through a cast because the declared type does not admit it, which is the whole finding.
    const dropped = (call as { rawArguments?: string }).rawArguments?.length ?? 0;
    // Rebuilt rather than mutated in place, and rebuilt down to the three fields the wire format
    // has: anything else the adapter carried is by definition something the request did not send,
    // which is the whole class this is removing. `arguments` is already `{}` on this path and is
    // kept so the call still pairs with the result the caller pushes next.
    message.toolCalls = [
      ...message.toolCalls.slice(0, at),
      { id: call.id, name: call.name, arguments: call.arguments },
      ...message.toolCalls.slice(at + 1)
    ];
    return dropped;
  }
  return 0;
};

/**
 * How many times one turn may interrupt the owner.
 *
 * A notice is an interruption on a device the owner is not looking at, so the bound is on the
 * harness rather than on the model's judgement: three is enough for the honest case - the thing
 * happened, and then it turned out to be worse than it looked - and past that it is a stream, which
 * belongs in the conversation the owner opens rather than on their lock screen.
 */
export const MAX_NOTICES_PER_TURN = 3;

/**
 * How many times one turn may stop and ask the owner something.
 *
 * The bound is on the harness rather than on the model's judgement, for the same reason the notice
 * bound is: a question parks the conversation and rings a device, and the failure mode this tool
 * creates is an agent that asks instead of working. Two, not one, because the answer to a question
 * is consumed back into the *same* turn - so a single budget covers the whole exchange, and one
 * genuine second blocker uncovered by the first answer is a real thing that happens. Past that it is
 * a dialogue, and a dialogue belongs in the reply the owner reads when they open the conversation.
 * A reply from the owner that ends the turn starts the count again from zero, like every other
 * per-turn ceiling in this file.
 */
export const MAX_QUESTIONS_PER_TURN = 2;

/**
 * Automatic continuations allowed after a provider-limited reply. This allowance ends separately
 * from completion reminders, so a spent continuation budget cannot start another repair loop.
 */
export const MAX_TRUNCATED_CONTINUATIONS = 3;

/**
 * The most one reply may write, reasoning included, on a model whose window allows it. A fifth of
 * the window still bounds a small model; this bounds a large one. @see `maxOutputTokens` in
 * `agent.ts` for why it has to hold a long thought and a whole file together.
 */
export const MAX_OUTPUT_TOKENS = 65_536;

/**
 * How many times a turn may condense itself because the route refused its window as too large.
 *
 * Two, because the first repair is aimed at a number this side had never been told before - the
 * ceiling the endpoint that answered actually enforces, which is not the one the catalogue
 * published for the model - and one further attempt covers a window that was so far over that a
 * single condensation still left it too big. A third would be condensing away the owner's
 * transcript to make room for a request that is failing for some other reason, and the honest
 * answer at that point is to say so and stop rather than to keep spending.
 */
export const MAX_CONTEXT_OVERFLOW_REPAIRS = 2;

/**
 * The smallest window a vision specialist may have.
 *
 * One system line, one instruction and one image: the ask is tiny, and the ranker needs a number
 * rather than a zero because `minContextTokens` is also what the price tiers are evaluated at.
 * Small enough that it excludes nothing a provider still serves.
 */
export const VISION_SPECIALIST_MIN_CONTEXT_TOKENS = 8_000;

/**
 * How many vision specialists an image is offered to before the model is told to work from the
 * text. Two: the second covers a route that has gone bad without spending a third billed call on a
 * catalogue that is evidently not describing this box any more.
 */
export const VISION_SPECIALIST_ATTEMPTS = 2;

/**
 * The host package managers garden's privileged helper can carry out an operation for.
 *
 * `PACKAGE_MANAGERS` in `services/workspace-runner/src/command-policy.ts` is the full list - what
 * counts as installing software on the host, for the approval card and for the desktop refusal -
 * and `PACKAGE_OPERATIONS` in `execution.ts` is the subset the helper has a spelling for. This is
 * exactly that subset's keys. It read "that subset, plus pacman" while pacman's parse lived in a
 * branch of its own and it had no row; it has a row now, so membership is one fact rather than a
 * table and an exception. It is a copy because the worker cannot import the runner, and
 * `scripts/check-repository.mjs` holds the two lists against each other.
 */
export const HELPER_PACKAGE_MANAGERS = new Set([
  'apk',
  'apt',
  'apt-get',
  'aptitude',
  'dnf',
  'dnf5',
  'microdnf',
  'pacman',
  'yum',
  'zypper'
]);

/**
 * Every verb any of those managers spells an update or an install with, in one set.
 *
 * A union rather than a per-manager table, and deliberately: this gate only has to be no narrower
 * than the runner's parse, and a fourteen-way table copied across a package boundary is a fourteen-
 * way opportunity for the two to disagree in the direction that silently withholds a capability.
 */
export const PACKAGE_VERBS = new Set([
  'add',
  'in',
  'install',
  'makecache',
  'ref',
  'refresh',
  'update'
]);

/**
 * When a turn starts being told how much of its step budget is left.
 *
 * A turn that works for hours is bounded by steps long before it is bounded by credits, and until
 * now nothing in the window said so: the model planned as though the budget were endless, then the
 * turn died at the limit with "Task reached the maximum number of agent steps". Two notices fix
 * that - one while there is still time to change course, one when only a handoff still fits.
 *
 * They are appended to the tail rather than inserted into the preamble, so they cost a cached prefix
 * nothing, and they are keyed on the exact step that crosses each line so a step is never billed for
 * a notice it already carries. A compaction that condenses one away is the case where re-emitting it
 * is right, which is why this asks the window rather than a counter.
 */
export const STEP_BUDGET_NOTICE_SHARE = 0.7;
export const STEP_BUDGET_HANDOFF_STEPS = 4;
export const STEP_BUDGET_MARKER = 'STEP BUDGET';
export const STEP_HANDOFF_MARKER = 'FINAL STEPS';

/**
 * The header of the workspace brief block, named because two places have to agree on it: the splice
 * that installs it, and anything measuring where the preamble's one volatile block sits.
 */
export const WORKSPACE_BRIEF_MARKER = 'WORKSPACE BRIEF (user-visible persistent project context)';

/** Every message this loop pushes back for the model to act on, by name. */
export type PushbackName =
  | 'acceptance_failed'
  | 'repetition_stopped'
  | 'output_limit_continued'
  | 'step_budget'
  | 'compute_budget'
  | 'idle_break'
  | 'stationary_stop'
  | 'vision_routed'
  | 'resumed_turn';

/**
 * The string each pushback is recognised by, published from the file that writes them.
 *
 * The eval harness had its own copy of this table, with the comment that it was "the one place this
 * harness is coupled to wording" - so every one of these sentences was a string literal in two
 * files that nothing made agree, and the failure mode of a disagreement is a fixture asserting a
 * hold that silently stopped being observed. Published here so the wording and the watch cannot
 * drift: change a sentence below and the row that matches it is the same edit.
 *
 * A matcher must try the longest marker first; `holdsIn` in the harness sorts by length.
 */
export const PUSHBACK_MARKERS: ReadonlyArray<readonly [PushbackName, string]> = [
  // `acceptanceFailureMessage`, in acceptance.ts.
  ['acceptance_failed', 'ACCEPTANCE CHECKS FAILED ('],
  // Generation repairs that send another request: repetition abort and output-limit continuation.
  ['repetition_stopped', 'began repeating'],
  ['output_limit_continued', 'CONTINUE ('],
  // The two ceilings, from the same template in `#runHandoffCall`, and `stepLimitCarryOver`.
  ['step_budget', 'STEP BUDGET EXHAUSTED'],
  ['compute_budget', 'COMPUTE BUDGET EXHAUSTED'],
  ['resumed_turn', 'PREVIOUS TURN STOPPED AT ITS STEP LIMIT'],
  ['idle_break', 'NOTHING HAS RUN FOR'],
  // The action watch beside it. Deliberately not a prefix of the line above and not prefixed by it:
  // `holdsIn` matches longest-marker-first, and two guards that fire on different evidence must
  // never be able to be read as each other.
  ['stationary_stop', 'NOTHING HAS CHANGED FOR'],
  // The lead's window being handed an observation it could not make itself. The failure notice
  // beside it ("VISION ROUTING NOTICE") is deliberately not here: it says routing was attempted and
  // did not happen, which is the opposite of what a fixture asserting this would mean by it.
  ['vision_routed', 'VISION SPECIALIST HANDOFF']
];

/**
 * What the turn that resumes a step-limited one is told, written into the saved window because that
 * is the one place the next turn is guaranteed to read. Without it the next turn arrived knowing
 * only that there was a conversation, so it re-read - and sometimes re-did - work already finished.
 */
export const stepLimitCarryOver = (steps: number, stillOpen: readonly string[]): string =>
  `PREVIOUS TURN STOPPED AT ITS STEP LIMIT after ${steps} steps, with work still outstanding. Nothing it produced was rolled back. Before acting, read the newest plan and the running brief, establish what is already done, and continue from the first step that is not complete - do not restart finished work.${
    stillOpen.length ? `\nStill open: ${stillOpen.slice(0, 10).join('; ')}` : ''
  }`;

export const stepBudgetNotice = (step: number, maxSteps: number): string | null => {
  const remaining = maxSteps - step;
  // A budget too small for two distinct notices gets the one that matters.
  if (remaining <= STEP_BUDGET_HANDOFF_STEPS)
    return `${STEP_HANDOFF_MARKER}: ${remaining} of this turn's ${maxSteps} steps remain (a step is one model call). Stop starting new work: save what is unfinished, publish what is finished, keep the plan honest, and reply with what is done and what is not. Nothing is lost; the user's reply continues the work with a fresh budget.`;
  if (remaining === maxSteps - Math.floor(maxSteps * STEP_BUDGET_NOTICE_SHARE))
    return `${STEP_BUDGET_MARKER}: ${step} of this turn's ${maxSteps} steps are used and ${remaining} remain. If the rest does not fit, finish the most valuable part properly and say what remains.`;
  return null;
};

/**
 * How hard the model should think about this particular step.
 *
 * This used to key off `REPEATABLE_TOOLS`, and that set is documented in its own comment as a
 * replay-safety set: tools whose second run after a restart cannot surprise anyone. Replay safety
 * and cognitive difficulty are unrelated, and for the read tools they are close to inverted. The
 * set contains file_read, document_read, image_read, parallel_web_read, web_search, code_search
 * and repo_overview - every one of which returns material the model then has to reason hard about,
 * and every one of which dropped the next step to 'low'. The step after an 18,000-character CSV
 * landed in the window was the cheapest step in the task.
 *
 * It now ratchets in one direction only. A turn opens at 'high' because that is where the request
 * is read and the approach chosen, settles to 'medium' for ordinary progress, and rises back to
 * 'high' - permanently, for the rest of the turn - on evidence that this turn has become hard: a
 * check failed, or the window was just compacted. Two consequences, both wanted. The model thinks
 * most where the measured failures are. And `reasoning` becomes a nearly byte-stable request field
 * instead of flipping ten times in twenty-three steps, each flip discarding the provider's cached
 * trajectory below the system prefix.
 *
 * A turn's length and the size of its window are deliberately not evidence. Raising the thinking
 * budget late is the published mitigation for accuracy falling with step count, and measured on
 * live Terminal-Bench runs it bought nothing here: with it, 'high' was 42% of a reasoning route's
 * calls and 58% of what it wrote, and the same dev set without it passed every task it had passed
 * and cost 39% less - less thinking written is also less appended to every later request.
 */
interface EffortState {
  step: number;
  messages: ModelMessage[];
  planVersion?: number;
  acceptanceFailures?: number;
  reasoningFloor?: 'medium' | 'high';
  compactedAtStep?: number;
}

/**
 * Whether this step's `high` is evidence about the *work* rather than about one call going wrong.
 *
 * Only these conditions may pin the floor for the rest of the turn. The distinction was missing and
 * it is expensive: `Tool failed:` is written when a tool *threw* - the runner briefly unreachable,
 * a socket closed - and on a measured run one such shell call on step 4 pinned every one of the
 * sixteen remaining steps to maximum reasoning on a task whose entire output was two lines of
 * verse. That is a fact about the network. The step after it is still worth thinking about, and it
 * still gets `high` below; what it no longer does is decide that the turn is hard for ever.
 *
 * The conditions kept here are all statements about the turn itself: the harness refused a finish or
 * an acceptance check failed, or the window was just compacted and the model is working from a
 * summary of its own work.
 */
export const effortFloorEarned = (state: EffortState): boolean =>
  Boolean(state.acceptanceFailures) ||
  // The step immediately after a compaction is the one most likely to make a wrong call: the model
  // has just lost the detail it was working from and is holding a summary of its own work instead.
  (state.compactedAtStep !== undefined && state.step - state.compactedAtStep <= 1);

export const reasoningEffortForStep = (state: EffortState): 'medium' | 'high' => {
  if (state.step === 0) return 'high';
  if (state.reasoningFloor === 'high') return 'high';
  if (effortFloorEarned(state)) return 'high';
  let lastAssistant = -1;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    if (state.messages[index]?.role === 'assistant') {
      lastAssistant = index;
      break;
    }
  }
  const results = state.messages
    .slice(lastAssistant + 1)
    .filter((message) => message.role === 'tool');
  if (
    results.some((result) =>
      /^(Tool failed|Refused|Interrupted|Finish rejected|Skipped)/.test(result.content)
    )
  )
    return 'high';
  return 'medium';
};

/**
 * Two decimals for money anyone recognises, four for the sub-cent step a cheap route bills.
 *
 * Zero is special-cased into the two-decimal arm and it is not cosmetic: a cap of zero is a real
 * setting - "only a route that publishes no charge" - and it is now quotable, so `$0.0000 of the
 * $0.0000 limit` is a sentence this can actually produce.
 */
/**
 * How many steps an isolated specialist gets.
 *
 * Six is a lookup, not a research pass: a specialist that has to search, read four primary sources
 * and reconcile them spends its whole budget on the search. Sixteen is what "read these fifteen
 * sources and tell me where they disagree" actually costs, and it is still bounded by the credit
 * share above, which is the bound that matters to the owner's bill.
 */
export const DELEGATE_MAX_STEPS = 16;
