import { executeWorkflowTool } from './workflow.js';
import { recordPatchReceipt, type PatchReceipt } from '../edit/receipts.js';
import { applyReplacements, type TextReplacement } from '../edit/replace.js';
import { executeDebuggerTool } from './debugger.js';
import { sha256, GardenError } from '@garden/core';
import { type ModelToolCall } from '@garden/model-gateway';
import {
  checkSyntax,
  displayedRanges,
  firstUnshownLine,
  numberedWindow,
  recordRead,
  recordWrite,
  renderNumbered,
  toLines
} from '../edit/index.js';
import { RECENT_TOOL_OUTPUT_CHARS, recordArtifactWrite } from '../context.js';
import { type ExecObservation } from '../agent-state.js';
import { HELPER_PACKAGE_MANAGERS, PACKAGE_VERBS } from '../turn-bounds.js';
import { textValue } from '../values.js';
import { type ToolContext } from '../tool-dispatch.js';
import {
  type NearestProject,
  type PostEditDiagnostic,
  nearestProject,
  postEditDiagnostics
} from './diagnostics.js';
import { finiteNumber } from './numbers.js';
import { withWorkspacePrefixNote } from './shell-frame.js';
import { refuseShellReplacementOfUnread } from './shell-writes.js';
import { executeComputationTool } from './computation.js';
import { shellJobExecution } from '../shell-job.js';

/**
 * What the file weighs now, taken from the workspace's own answer to the write.
 *
 * `writeWorkspaceFile` returns `{sha256, sizeBytes}` and `sizeBytes` is the length of the buffer it
 * actually wrote, which is the only number here that is a measurement rather than an intention.
 * `AgentRunnerClient.writeFile` types that answer as `unknown` because it is JSON from a separate
 * service across a version boundary - the worker and the runner are deployed separately, and
 * `garden update` can leave one ahead of the other - so the field is read defensively and the
 * bytes this call handed over stand in when it is absent. Both are true; only one is measured, and
 * the measured one is preferred wherever it is there.
 */
const landedBytes = (response: unknown, content: string): number => {
  const reported = finiteNumber(
    (response as { sizeBytes?: unknown } | null | undefined)?.sizeBytes
  );
  return reported !== null && reported >= 0 ? reported : Buffer.byteLength(content, 'utf8');
};

/**
 * How much of a file one `file_read` puts in front of the model, on either arm.
 *
 * THIS IS NOT AN ECONOMY. The economy already exists and is uniform: `recordToolResult` bounds the
 * serialised form of EVERY tool result at `RECENT_TOOL_OUTPUT_CHARS` before pushing it into the
 * window, so an unbounded read of this repository's largest test file arrives at exactly 24,000
 * characters whatever this arm does. Measured through the shipped path: 354,014 bytes on disk,
 * 403,252 characters serialised, 24,000 delivered - 5.95%. A second bound in front of that one
 * would save no tokens, and the first draft of this change was proposed on the belief that it
 * would.
 *
 * What it is for is the gap that bound OPENS. The cut happens two layers downstream, after this arm
 * has already answered `truncated: false, totalLines: 8332` and already called `recordRead` over all
 * 8,332 lines - so the harness's record of what the model was shown was wrong by 7,800 lines, and
 * that record is the only evidence a line-addressed `file_patch` rests on. An edit to line 8,000
 * of a file the model had seen 500 lines of was accepted, by name, because of this. So this bound
 * exists to make the read's own report true: what is displayed, what is claimed, and what is
 * recorded as seen become the same set of lines, and the downstream cut never has a file_read to
 * make a decision about.
 *
 * That is why the byte budget is DERIVED from the window bound rather than chosen. It is the
 * agreement condition between the two layers, and if someone moves the window bound the read has to
 * follow it or the gap reopens. Three quarters leaves room for the line-number gutter, the JSON
 * escaping and the envelope: measured over all 830 tracked text files in this repository, the worst
 * serialised result is 21,793 characters, 2,207 inside the bound, and no file exceeds it.
 *
 * It is now the delivery budget rather than a cut made after delivery, and it binds both arms. The
 * runner is handed these two numbers and answers with the prefix that fits them, so what crosses the
 * wire, what the model is shown, and what both seen-line ledgers vouch for are one set of bytes
 * instead of three computations that have to keep agreeing.
 */
const FILE_READ_DISPLAY_BYTES = Math.floor(RECENT_TOOL_OUTPUT_CHARS * 0.75);

/**
 * The line cap, and it is a CATASTROPHE FLOOR rather than an economy or a working limit.
 *
 * On real source the budget above is what binds and this is never reached: at 18,000 bytes, moving
 * this number from 600 to 2,000 changes what is delivered for 0 of 830 tracked files, because a
 * line of code averages 43.4 characters and 18,000 bytes is 415 of them. What it is here for is the
 * file the byte budget cannot bound - 18,000 bytes of two-character lines is 9,000 lines, and 9,000
 * lines recorded as seen is the same defect this change exists to remove, reached from the other
 * side. A column of numbers is not a licence to edit 9,000 anchors blind.
 *
 * 800 because it is above what an unbounded read has any business vouching for and below what
 * anyone reads: p75 of this repository's tracked files is 339 lines and p90 is 715, and across
 * 12,347 real windowed reads measured on this machine p90 displayed is 360 lines. It costs a second
 * call on the narrow-line minority and nothing on the rest.
 */
const FILE_READ_DISPLAY_LINES = 800;

/**
 * Notes, or forgets, that the reads of this path have not been shown to reach the end of it.
 *
 * A number rather than a flag, because what `firstUnshown` needs is a line the reads have to
 * cover, and the two arms know that line to different precision. An unwindowed read has the whole
 * file's length exactly. A windowed read that stopped before the end knows only that the file goes
 * at least one line further than what it delivered whole - the ranged reader deliberately does not
 * walk to the end of a two-gigabyte log to count. So the number is a floor, never an overstatement,
 * and it is only ever raised: a later, narrower read learning less about the file must not lower the
 * bar a wider one set.
 *
 * Written as a fresh object for the same reason every other field of `AgentState` is - the state is
 * snapshotted between steps and a mutated map would edit history.
 */
const withPartialRead = (
  existing: Record<string, number> | undefined,
  path: string,
  atLeastLines: number | undefined
): Record<string, number> => {
  const next = { ...(existing ?? {}) };
  if (atLeastLines === undefined) delete next[path];
  else next[path] = Math.max(next[path] ?? 0, atLeastLines);
  return next;
};

/**
 * Moves that floor by what an edit changed the file's length by, because the file it is a floor on
 * is now one line-count longer or shorter.
 *
 * A patch used to DELETE the entry outright, on the reasoning that the version the read was about
 * no longer exists. The version does not; the unread remainder does. Measured on the shipped arm:
 * `file_read` of lines 1-200 of an 8,332-line file, then one `PUT 10:`, and the outstanding floor
 * went from 201 to nothing - after which a whole-file `file_write` destroyed 576,512 bytes without
 * being asked a question. An edit to line 10 says nothing about line 8,000, and clearing the floor
 * claimed it did.
 *
 * "At least N lines" survives the shift exactly: a file that had at least N lines and gained
 * `delta` of them has at least N + delta, and the floor stays a floor whichever way the edit went.
 */
const shiftPartialRead = (
  existing: Record<string, number> | undefined,
  path: string,
  delta: number
): Record<string, number> => {
  const outstanding = existing?.[path];
  if (outstanding === undefined) return { ...(existing ?? {}) };
  return { ...existing, [path]: Math.max(1, outstanding + delta) };
};

/**
 * The first line of this file the turn has not been shown, or `undefined` when it has been shown
 * all of them up to `reachTo`.
 *
 * Asked of the COVERAGE record rather than of the snapshots. Two reads of lines 1-400 and 300-900
 * have shown lines 1-900 and this has to say so - a model that read the rest in a second call has
 * genuinely seen the file and should not be refused for the shape of how it got there. Asking the
 * snapshots was how that promise was broken: they are capped at four per file because they carry
 * text, so a file paged through in twenty windows kept the last four of them and the answer was no.
 * Measured on this repository at the time: 37 of 946 tracked files were long enough that no
 * sequence of reads could ever make a whole-file write of them legal - and the refusal named
 * reading the remainder, which is what the model had just finished doing.
 */
const firstUnshown = (taskId: string, path: string, reachTo: number): number | undefined =>
  firstUnshownLine(displayedRanges(taskId, path), reachTo);

/*
 * ── The post-edit check: deferred, version-guarded, and silent unless it has something ─────────
 *
 * `file_patch` computes exactly the input a trigger needs and nothing consulted it. What follows
 * runs the project's own type-checker over the files a patch just wrote and puts what it said in
 * front of the model. `tools/diagnostics.ts` owns which languages may be triggered this way and
 * how their output is read; this owns when it runs, whether it is still worth reporting when it
 * finishes, and how much of it the model is charged for.
 *
 * IT IS DEFERRED, and that is a measurement rather than a preference. `npx --no-install tsc
 * --noEmit` over `apps/worker` on this machine took 4.17 s wall on 2026-09-01, and the range
 * across this repository's packages is 0.98 s to 5.70 s. Blocking every edit on that is a worse
 * harness than no check at all: the model's own next thought costs less than the checker, so the
 * check overlaps it for free and costs the patch nothing. The patch arms the run and returns
 * without awaiting it; whatever has finished is attached to the NEXT workspace call, and a run
 * that never finishes before the turn ends is never reported. That is the trade, stated: this
 * trigger can be late or absent, and it can never be wrong about a file being clean.
 *
 * WHAT IT DOES NOT COVER. Only `file_patch` arms it. `file_write` writes code too and one line
 * here would arm it as well; it is left alone in this cut because the proof burden is per call
 * site and this one had the evidence. Only the workspace tools can carry a report, because
 * `executeWorkspaceTool` is where the drain sits - a patch followed immediately by
 * `code_diagnostics` or `delegate` holds its report until the next file or shell call. Widening
 * that is a hook in `tool-dispatch.ts`, which is not this file's to write.
 */

/** One armed check: what will run, where, and which writes it was armed for. */
interface PostEditCheck {
  readonly project: NearestProject;
  /**
   * The stamp each written path stood at when this was armed. A path patched again while this was
   * in flight has a higher stamp by the time it lands, and the whole run is dropped: the checker
   * read the file between the two writes and its answer is about neither of them.
   */
  readonly versions: ReadonlyMap<string, number>;
  /** Set exactly once, by the run itself. `undefined` means still in flight. */
  found?: readonly PostEditDiagnostic[];
}

interface PostEditLedger {
  /**
   * The stamp each path was last written under, which is the whole staleness guard.
   *
   * A STAMP AND NOT A WRITE COUNT, and the difference is what makes the prune below safe. The
   * number is `stamp` at the moment of the arm, so it only ever climbs, and a path whose entry the
   * prune dropped cannot be patched back onto a number an older check is still holding. With a
   * per-path count it could: a path written once, dropped, then written again would read 1 both
   * times, and a dead check holding 1 would pass `superseded` as fresh.
   */
  readonly versions: Map<string, number>;
  /** The last stamp handed out. One per arm, not one per path. */
  stamp: number;
  checks: PostEditCheck[];
}

/**
 * The armed checks of every live task.
 *
 * Module state keyed by task id, the same shape and for the same reason as the read snapshots in
 * `edit/snapshots.ts`: this is a working set that a worker restart is free to lose. Losing it
 * costs a check nobody asked for; putting it on `AgentState` would put an in-flight promise into
 * something that is serialised and handed across a turn boundary.
 *
 * CHOSEN at 64 tasks, 8 checks each, and 320 path stamps each. 8 is more armed runs than a single
 * turn can plausibly outrun - one patch arms one run per project it touched - and the point of the
 * cap is not the number but that an entry nobody ever drains is dropped rather than held: a turn
 * that patches and then does nothing but talk would otherwise keep its checks for the life of the
 * process.
 *
 * The third bound is the one that was missing, and it was the only field here with no bound at
 * all: `versions` grew one entry per distinct path a task ever patched and nothing deleted from
 * it, so a long autonomous run over a large tree held a path string per file for the life of the
 * worker while this comment reasoned carefully about the other two. It is DERIVED rather than
 * chosen, from the size of the set eight live checks can name between them: `MAX_ARMED_CHECKS`
 * checks, each armed by one `file_patch`, which caps at `MAX_PATCH_FILES` paths.
 *
 * WHAT IT KEEPS IS THE 320 MOST RECENTLY PATCHED PATHS, which is that set only while nothing else
 * is patched in between - so this is not a window of eight arms, and the gap is reachable rather
 * than theoretical. An arm whose files have no project marker above them arms no check, so it
 * spends stamps without spending one of the eight check slots. Measured through the shipped arm:
 * one check held in flight, then eight 40-path patches into a directory with no marker, and the
 * held check's own path was pruned - the checker had run and had something to say, and its answer
 * was dropped. That is the direction this fails in and the reason it is left here: a check whose
 * stamp has gone missing reads as superseded and is discarded, so an over-eager prune costs a
 * report nobody was promised and can never produce one about a file that has moved on. Making it
 * exact means pruning against the paths the live checks name rather than against a count, which
 * is more machinery than that failure is worth.
 */
const MAX_TRACKED_TASKS = 64;
const MAX_ARMED_CHECKS = 8;
const MAX_PATCH_FILES = 40;
const MAX_TRACKED_PATHS = MAX_ARMED_CHECKS * MAX_PATCH_FILES;
const armed = new Map<string, PostEditLedger>();

const ledgerFor = (taskId: string): PostEditLedger => {
  const existing = armed.get(taskId);
  if (existing) {
    // Insertion order is recency order, so re-setting the key is what makes the eviction below
    // drop the least recently armed task rather than the first one this process ever saw.
    armed.delete(taskId);
    armed.set(taskId, existing);
    return existing;
  }
  const fresh: PostEditLedger = { versions: new Map(), stamp: 0, checks: [] };
  armed.set(taskId, fresh);
  while (armed.size > MAX_TRACKED_TASKS) {
    const oldest = armed.keys().next();
    if (oldest.done) break;
    armed.delete(oldest.value);
  }
  return fresh;
};

/** Drops every armed check. Only a test that wants a cold store has any business calling it. */
export const forgetPostEditChecks = (): void => armed.clear();

/**
 * How many path stamps one task is holding. Only a test that has to watch the bound hold has any
 * business calling it; nothing in the product asks, and the answer is not part of any result.
 */
export const countPostEditPaths = (taskId: string): number => armed.get(taskId)?.versions.size ?? 0;

/**
 * Drops the oldest path stamps once a task is holding more than any check can ask about.
 *
 * Least recently patched first, the same eviction as the task map above and for the same reason:
 * `armPostEditChecks` re-sets each path through a delete, so insertion order is recency order.
 * Run from the arm, which is the only place this map grows.
 *
 * The number it prunes to is derived where `MAX_TRACKED_PATHS` is declared. What matters here is
 * the direction of the error: because the stamp only climbs, a check holding a stamp for a path
 * that has been pruned finds no entry, `superseded` reads `0`, and the check is dropped. An
 * over-eager prune therefore loses a report the model might have wanted; it cannot produce one
 * about a file that has moved on.
 */
const pruneVersions = (ledger: PostEditLedger): void => {
  while (ledger.versions.size > MAX_TRACKED_PATHS) {
    const oldest = ledger.versions.keys().next();
    if (oldest.done) break;
    ledger.versions.delete(oldest.value);
  }
};

/**
 * Whether the answer this run came back with is still about the file that is on disk.
 *
 * Compared against the live stamp rather than against a timestamp, because the question is not how
 * old the answer is but whether anything has happened to the files since. Two patches to the same
 * path with the first check outstanding is the shape this exists for, and it is the shape a model
 * produces constantly: patch, notice a typo in the echo, patch again.
 *
 * A path the prune has dropped reads `0`, which no stamp ever is, so a check about it is
 * superseded. That is the direction this has to fail in: an answer nobody can date is an answer
 * that does not go in front of the model.
 */
const superseded = (ledger: PostEditLedger, check: PostEditCheck): boolean =>
  [...check.versions].some(([path, version]) => (ledger.versions.get(path) ?? 0) !== version);

/**
 * How much of what the checker said the model is charged for.
 *
 * CHOSEN at 12 diagnostics and 1,600 bytes, against `RECENT_TOOL_OUTPUT_CHARS` of 24,000: this is
 * an uninvited block on somebody else's tool result, so it may take a fifteenth of the window a
 * requested result gets and no more. Twelve is chosen from the failure it is for - one bad edit in
 * a TypeScript package produces a handful of errors and a badly bad one produces a cascade, and the
 * twelfth line of a cascade has already said what the first line said. Both bounds are real
 * because either alone is not: twelve lines of a minified file's `tsc` output is not 1,600 bytes,
 * and 1,600 bytes of short lines is not twelve of them.
 *
 * THE BYTE BOUND IS THE WHOLE BLOCK'S, ACROSS EVERY CHECK, and it says so here because it was
 * once per check and the difference is a factor of eight. A check is one project, and one
 * `file_patch` may span eight of them - which is what this repository is - so eight blocks were
 * joined onto one result with nothing counting the total. Measured through the shipped arm, eight
 * packages patched in one call with one over-long `tsc` line each: 14,246 bytes delivered under a
 * cap that reads 1,600, three fifths of the window the requested result was supposed to get. The
 * count bound stays per check, because twelve is about how much of one cascade is worth reading
 * and that does not get smaller when a second project also has something to say.
 */
const POST_EDIT_MAX_DIAGNOSTICS = 12;
const POST_EDIT_MAX_BYTES = 1_600;

/**
 * One diagnostic cut to fit, because the byte bound has to hold for a block of ONE.
 *
 * The loop below admits the first diagnostic whatever its length, so that a block is never a
 * header with nothing under it, and that exemption was the whole byte bound's hole: `tsc --noEmit
 * --pretty false` prints the inferred type inline, so one mismatch between two large object types
 * is a single line of several kilobytes. Measured through the shipped arm against a 60,000-byte
 * type: a block that declares 1,600 bytes delivered 60,198 - past `RECENT_TOOL_OUTPUT_CHARS` of
 * 24,000, so the uninvited block would have evicted the result the model actually asked for.
 *
 * Cutting rather than dropping, because the head of a `tsc` line is the part that identifies the
 * error - path, position, code, and the beginning of the offending type - and the recovery named
 * is one the model can perform: `code_diagnostics` on that directory prints the whole thing.
 *
 * The budget is what is LEFT of the block's, not the block's whole allowance, so the exemption
 * cannot be spent twice by two checks on one result.
 *
 * THE MARKER IS SPENT FROM THE BUDGET, not added after the cut. Slicing to the budget and then
 * appending returned `budget + 68` bytes, which is how a block declaring 1,600 delivered 1,669 -
 * the same residue-outside-the-bound this file has now been caught with three times, at the
 * innermost of the three levels. The caller guarantees `budget >= POST_EDIT_MIN_DIAGNOSTIC` on the
 * only path that can reach this branch; the `Math.max` is what a future caller that forgets gets,
 * and it returns the marker alone rather than a cut line that reads as a whole one.
 */
const CUT_MARKER = ' [cut here; run code_diagnostics on this directory to read the rest]';

const clipDiagnostic = (text: string, budget: number): string =>
  text.length <= budget
    ? text
    : `${text.slice(0, Math.max(0, budget - CUT_MARKER.length))}${CUT_MARKER}`;

/**
 * The smallest first line worth writing a header above.
 *
 * The cut marker plus 40 bytes, and the 40 is the length of the part of a `tsc` line that
 * identifies the error rather than describes it - `workspace/pkg/src/a.ts(3,7): error TS2322:` is
 * 42 - so a block that cannot carry that much is a header, a truncation notice and nothing the
 * model can act on. Refusing it counts the project in the tail instead, which names the same
 * recovery in a tenth of the bytes.
 */
const POST_EDIT_MIN_DIAGNOSTIC = CUT_MARKER.length + 40;

/** The remainder line inside one block, as a function so the reservation is derived from it. */
const moreDiagnosticsLine = (remaining: number): string => `and ${remaining} more.`;

/**
 * One project's block, inside whatever the budget has left, or nothing.
 *
 * The written files come first and everything else in the project follows, because a pre-existing
 * error four packages away is true and is not what the model is about to act on. The remainder is
 * counted rather than dropped silently - "and N more" is the difference between a short list and a
 * short list the reader believes is the whole list.
 *
 * A clean tree costs zero bytes, and that is guarded three times over rather than once: the parser
 * returns an empty array for anything it did not recognise, `readyPostEditChecks` keeps a check
 * with nothing in it out of the drain, and the empty return below refuses to write a header with
 * no lines under it. Measured while proving it - deleting any ONE of those three leaves the
 * property intact, so the test that pins it had to delete all three before it went red. The
 * redundancy is deliberate: an empty block is the harness telling the model a file is fine, which
 * is the one thing this trigger has no standing to say.
 */
const renderPostEditCheck = (check: PostEditCheck, budget: number): string | undefined => {
  const found = check.found ?? [];
  if (!found.length) return undefined;
  const ran = [check.project.command.executable, ...check.project.command.args].join(' ');
  const header = `${ran} in ${check.project.dir}, run over the files patched earlier in this turn:`;
  const written = new Set(check.versions.keys());
  const ordered = [
    ...found.filter((one) => written.has(one.path)),
    ...found.filter((one) => !written.has(one.path))
  ];
  // Room held back for the remainder line, which is written after the loop and used to be counted
  // by nobody. Reserved at the largest count that can reach it - every diagnostic unshown - so the
  // reservation cannot be smaller than the line it pays for. A block with one diagnostic in it
  // reserves nothing, because the loop admits the first whatever its length and there is then no
  // remainder to name.
  const room = budget - (ordered.length > 1 ? moreDiagnosticsLine(ordered.length).length + 1 : 0);
  // The header is spent from the budget rather than added on top of it, and a header with no room
  // for a usable line under it is not written at all: a block that says a checker ran and says
  // nothing the model can act on is the empty-block failure the drain already refuses.
  if (header.length + 1 + POST_EDIT_MIN_DIAGNOSTIC > room) return undefined;
  const shown: string[] = [];
  let bytes = header.length;
  for (const one of ordered) {
    if (shown.length >= POST_EDIT_MAX_DIAGNOSTICS) break;
    // `+ 1` for the newline that joins it on, which is the third thing that was outside the count.
    if (bytes + 1 + one.text.length > room && shown.length) break;
    const text = clipDiagnostic(one.text, room - bytes - 1);
    shown.push(text);
    bytes += text.length + 1;
  }
  const remaining = ordered.length - shown.length;
  return [header, ...shown, ...(remaining ? [moreDiagnosticsLine(remaining)] : [])].join('\n');
};

/** The tail line, as a function so the reservation below is derived from it and not typed twice. */
const droppedProjectsLine = (dropped: number): string =>
  `and ${dropped} more project${dropped === 1 ? '' : 's'} the checker had something to say about; run code_diagnostics there to read it.`;

/**
 * What the tail line costs at its longest, held back from the block budget before the loop starts.
 *
 * Derived from the sentence itself at the largest count that can reach it rather than written down
 * as a number, so editing the wording moves the reservation with it. `MAX_ARMED_CHECKS` is that
 * count: a task holds at most eight checks and the tail can name every one of them. The `+ 2` is
 * the `\n\n` that joins it on.
 */
const POST_EDIT_TAIL_BYTES = droppedProjectsLine(MAX_ARMED_CHECKS).length + 2;

/**
 * Every landed check on one result, under ONE budget rather than one budget each.
 *
 * Oldest first, which is arm order, because that is the run the model has been waiting on longest.
 * A project that finds no room left is COUNTED rather than dropped silently, for the same reason
 * the diagnostics inside a block are: a short list a reader believes is the whole list is worse
 * than a short list that says what it left out. The recovery named is one the model can perform.
 *
 * EVERY BYTE DELIVERED IS INSIDE THE BUDGET, including the two the joins add and the tail line,
 * which used to sit outside it and made the real worst case about 1,790 against a cap that reads
 * 1,600. A budget with things outside it stops being a budget, so the separator is spent with the
 * block it precedes and the tail is reserved before the first block is measured.
 *
 * The reservation is taken only when more than one check landed, and that is exact rather than
 * thrifty: the tail is written only when a block was emitted AND another was refused, which needs
 * two checks. With one check there is nothing to hold back and the single block gets the whole
 * 1,600. What the reservation costs when two or more land and none is dropped is about 110 bytes
 * of diagnostics that would have fitted - paid so that the stated number is the delivered number.
 */
const renderPostEditChecks = (checks: readonly PostEditCheck[]): string | undefined => {
  const blocks: string[] = [];
  let budget = POST_EDIT_MAX_BYTES - (checks.length > 1 ? POST_EDIT_TAIL_BYTES : 0);
  let dropped = 0;
  for (const check of checks) {
    const separator = blocks.length ? 2 : 0;
    const block = renderPostEditCheck(check, budget - separator);
    if (block) {
      blocks.push(block);
      budget -= block.length + separator;
    } else if (check.found?.length) dropped += 1;
  }
  if (!blocks.length) return undefined;
  return [...blocks, ...(dropped ? [droppedProjectsLine(dropped)] : [])].join('\n\n');
};

/**
 * The checks that have landed and are still about the tree as it stands.
 *
 * Read before the arm runs and consumed after it, which is what makes "the NEXT tool result"
 * literal: a patch cannot be handed its own check, because at the moment this is called the run it
 * is about to arm does not exist. Superseded checks are dropped here rather than at landing time,
 * since the write that superseded them may not have happened yet when they land.
 */
const readyPostEditChecks = (taskId: string): readonly PostEditCheck[] => {
  const ledger = armed.get(taskId);
  if (!ledger) return [];
  ledger.checks = ledger.checks.filter((check) => !(check.found && superseded(ledger, check)));
  return ledger.checks.filter((check) => check.found?.length);
};

/**
 * The same question asked a second time, after the arm has run, because the arm may have been the
 * write that invalidated the answer.
 *
 * Reading the drain BEFORE the arm is what stops a patch being handed its own check, and it was
 * also a hole: a check that had already landed was fresh at the moment it was read and stale by
 * the time it was rendered, because the call it was about to ride on was another patch of the same
 * file. Measured through the shipped arm - patch, let the checker land, patch the same path again,
 * and the second patch's result carried the first run's error about a line that no longer existed.
 * That is the exact shape the version counter is for, "patch, read the echo, notice the typo,
 * patch again", and it is worse in this form than in the one the counter already caught: the
 * report rides on the result of the very write that repaired it.
 *
 * The dead ones are still consumed by the caller rather than left armed. There is nothing to wait
 * for - a newer run for the same path is already in flight, and holding this one would only offer
 * it to the call after next, by which time it is no less wrong.
 *
 * A LEDGER THAT HAS GONE RETURNS NOTHING, which is the same direction `superseded` chooses and the
 * opposite of what this line did: it returned every captured check unfiltered, so the one shape
 * that empties the store between the two reads - 64 other tasks arming inside the awaited tool
 * call, or a test clearing it - delivered a block nothing could date. An answer nobody can date is
 * an answer that does not go in front of the model, and the stamps are only comparable inside the
 * ledger that issued them, so a ledger that has been evicted and recreated cannot date them
 * either. The cost of the refusal is a report nobody was promised; the cost of the old line was a
 * stale block rendered as fresh, which is the one thing this feature may not do.
 */
const stillAboutTheTree = (
  taskId: string,
  checks: readonly PostEditCheck[]
): readonly PostEditCheck[] => {
  const ledger = armed.get(taskId);
  if (!ledger) return [];
  return checks.filter((check) => !superseded(ledger, check));
};

const consumePostEditChecks = (taskId: string, taken: readonly PostEditCheck[]): void => {
  const ledger = armed.get(taskId);
  if (ledger) ledger.checks = ledger.checks.filter((check) => !taken.includes(check));
};

/**
 * Arms one check per project the patch touched, and returns without waiting for any of them.
 *
 * The stamp bump is SYNCHRONOUS and everything after the first `await` is not, which is the whole
 * of the deferral and the whole of the staleness guard in one shape. A second patch to the same
 * path entering this function one line later takes a higher stamp, so the first run is already
 * dead by the time it lands even though its own walk has not finished. Doing the walk before
 * returning would have put four runner round trips on the patch's wall clock for a check the patch
 * does not report.
 *
 * Nothing in here may throw into the caller and nothing in here may reject: this is a detached
 * promise on a path whose work has already succeeded and been reported, and an unhandled rejection
 * from a type-checker would take the worker down over a file nobody asked about.
 */
const armPostEditChecks = (context: ToolContext, paths: readonly string[]): void => {
  const { task } = context;
  const ledger = ledgerFor(task.id);
  ledger.stamp += 1;
  const versions = new Map<string, number>();
  for (const path of paths) {
    // Re-set through a delete because `Map.set` on a key that is already there leaves it where it
    // was, and the prune below reads insertion order as recency order.
    ledger.versions.delete(path);
    ledger.versions.set(path, ledger.stamp);
    versions.set(path, ledger.stamp);
  }
  pruneVersions(ledger);
  void (async () => {
    const listings = new Map<string, Promise<ReadonlySet<string>>>();
    const listing = (dir: string): Promise<ReadonlySet<string>> => {
      const already = listings.get(dir);
      if (already) return already;
      const asked = context.runner
        .call<{
          entries: Array<{ name: string }>;
        }>(
          task.workspaceId,
          task.id,
          'files.read',
          `/v1/workspaces/${task.workspaceId}/files?path=${encodeURIComponent(dir)}`
        )
        .then(
          (answer) => new Set(answer.entries.map((entry) => entry.name)) as ReadonlySet<string>
        );
      listings.set(dir, asked);
      return asked;
    };
    // One run per project, not one per file: four files in one package are one `tsc --noEmit`,
    // and the checker reads the whole project whichever of them asked for it.
    const byProject = new Map<string, { project: NearestProject; paths: string[] }>();
    for (const path of paths) {
      const project = await nearestProject(path, listing).catch(() => undefined);
      if (!project) continue;
      const group = byProject.get(project.dir);
      if (group) group.paths.push(path);
      else byProject.set(project.dir, { project, paths: [path] });
    }
    for (const { project, paths: grouped } of byProject.values()) {
      const check: PostEditCheck = {
        project,
        versions: new Map(grouped.map((path) => [path, versions.get(path) ?? 0]))
      };
      // The SAME ledger, by identity, and not merely a ledger under this task id. Stamps are only
      // comparable inside the ledger that issued them, so a check armed against one that has since
      // been evicted and recreated - 64 other tasks arming during this walk, or a test clearing the
      // store - would be comparing its stamps against a counter that restarted at zero. Dropping
      // the check is the same silence a task that ended mid-walk already gets.
      const live = armed.get(task.id);
      if (live !== ledger) return;
      // Oldest first, so a turn that arms faster than it drains loses the report it is least
      // likely to still want.
      live.checks = [...live.checks, check].slice(-MAX_ARMED_CHECKS);
      const observed = await context.runner
        .call<ExecObservation>(
          task.workspaceId,
          task.id,
          'exec',
          `/v1/workspaces/${task.workspaceId}/exec`,
          {
            ...project.command,
            cwd: project.dir,
            /*
             * CHOSEN at 120 s against the 300 s default of `code_diagnostics`, because the two
             * are answering different questions. A checker the model asked for by name may take
             * as long as the project takes; one nobody asked for is only worth reporting while
             * the answer is still about work the model remembers doing, and the slowest package
             * measured on this repository is 5.70 s. A run that hits this ceiling reports
             * nothing, which is the same silence as a checker that is not installed.
             */
            timeoutSeconds: 120,
            maxOutputBytes: 4_000_000
          }
        )
        .catch(() => undefined);
      const output = observed ? `${observed.stdout ?? ''}\n${observed.stderr ?? ''}` : '';
      // Assigned even when empty: `found` is what distinguishes a run still in flight from a run
      // that landed with nothing to say, and both of them report nothing.
      check.found = observed?.timedOut
        ? []
        : postEditDiagnostics(project.language, project.dir, output);
    }
  })().catch(() => undefined);
};

/**
 * The workspace tools, with whatever a previous patch's checker found attached.
 *
 * The wrapper is where the deferred report lands, and it is a wrapper rather than a line in each
 * arm so that there is exactly one place to read the answer to "can this tool carry a report".
 * A result that is not a plain object carries nothing and CONSUMES nothing - the check stays armed
 * for the next call rather than being thrown away against a shape it could not ride on - and a
 * result that already has a `diagnostics` key is left exactly as the arm wrote it.
 */
export async function executeWorkspaceTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const ready = readyPostEditChecks(context.task.id);
  const result = await runWorkspaceTool(context, call);
  if (!ready.length) return result;
  // Every early return here leaves the checks ARMED rather than dropping them: a result that could
  // not carry the report is a reason to wait for the next call, not a reason to throw the answer
  // away. Only the line below, which has somewhere to put it, consumes.
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  if ('diagnostics' in result) return result;
  const rendered = renderPostEditChecks(stillAboutTheTree(context.task.id, ready));
  consumePostEditChecks(context.task.id, ready);
  if (rendered === undefined) return result;
  return { ...(result as Record<string, unknown>), diagnostics: rendered };
}

/**
 * The workspace tools: commands, processes and files on the owner's own computer.
 *
 * These are the arms that can change the machine, and three of them carry state the turn has to
 * remember across calls - the SHA the file was read at, which is what makes a blind overwrite
 * refusable rather than merely regrettable.
 */
async function runWorkspaceTool(context: ToolContext, call: ModelToolCall): Promise<unknown> {
  const { task, state } = context;
  // Whose evidence a read here is. The lead's window is the task; a specialist's is named on the
  // context, and its reads must not vouch for lines the lead has never been shown.
  const reader = context.reader ?? task.id;
  const root = `/v1/workspaces/${task.workspaceId}`;
  switch (call.name) {
    case 'shell': {
      if (typeof call.arguments.executable !== 'string' || !call.arguments.executable.trim())
        throw new GardenError(
          'shell_invalid',
          'shell requires executable. For a script use {executable:"bash",args:["-lc",script]}.'
        );
      const background = call.arguments.background === true;
      const execution = shellJobExecution(call.arguments);
      // A redirect or a `tee` over a file this turn has read part of is the whole-file write the
      // arm below refuses, spelled through the shell - and the runner's ledger cannot see a
      // redirect. Asked here, of the same record, before anything is sent.
      refuseShellReplacementOfUnread(reader, state, execution);
      if (execution.checkpointResume)
        refuseShellReplacementOfUnread(
          reader,
          state,
          execution.checkpointResume as Record<string, unknown>
        );
      const executable = textValue(execution.executable).split('/').pop()?.toLowerCase();
      /*
       * Whether this invocation is asking the computer to install software on itself.
       *
       * It decides one thing: whether the request carries the `system.packages` capability, which
       * is what lets the runner rewrite the command onto the privileged helper. The runner does
       * the real parse - `packageOperation` in `services/workspace-runner/src/execution.ts` is the
       * authority on which manager and which verb it can carry out, and it refuses anything else
       * by name.
       *
       * This gate used to name apt and apt-get and the verbs `install` and `update`, which is one
       * of the four families this box runs on and one of the spellings those families use. On
       * Fedora, Rocky, Arch, Alpine and openSUSE the capability was never requested, so `dnf
       * install` reached the runner without it and was refused with "an approved system-packages
       * capability is required" - a message about a permission, for a command that would have
       * been allowed. The runner-side repair for the other families landed and could not be
       * reached from here.
       *
       * Deliberately a superset of what the helper carries out rather than a copy of it. A gate
       * narrower than the parse behind it is exactly the defect above; a gate wider than it costs
       * a capability on a command the runner then declines by name, which is the better message
       * of the two. The four managers `PACKAGE_OPERATIONS` leaves out - emerge, rpm, rpm-ostree
       * and yay - are omitted here too: they are package management as far as the approval card
       * is concerned and not something this helper can carry out.
       */
      const systemPackageCommand =
        !background &&
        HELPER_PACKAGE_MANAGERS.has(executable ?? '') &&
        Array.isArray(execution.args) &&
        execution.args.some((argument) => {
          const value = String(argument).toLowerCase();
          // pacman says what it is doing with a flag rather than a verb: `-S` with names is an
          // install and `-Sy` with none is an index refresh.
          return (
            PACKAGE_VERBS.has(value) || (executable === 'pacman' && /^-[a-z]*s[a-z]*$/.test(value))
          );
        });
      const result = await context.runner.call(
        task.workspaceId,
        task.id,
        systemPackageCommand ? ['exec', 'system.packages'] : 'exec',
        background ? `${root}/processes/start` : `${root}/exec`,
        !background && !systemPackageCommand
          ? { ...execution, yieldAfterMs: 5000, requestId: call.id }
          : execution
      );
      try {
        const usage = await context.runner.call<{ storageBytes: number }>(
          task.workspaceId,
          task.id,
          'files.read',
          `${root}/usage`
        );
        await context.store.setWorkspaceStorage(task.userId, task.workspaceId, usage.storageBytes);
      } catch {
        /* The command receipt remains authoritative if metering is unavailable. */
      }
      // The runner reports a missing file; only this side knows the command was written against
      // the wrong frame. One sentence, appended only where it is true - @see shell-frame.ts.
      return withWorkspacePrefixNote(execution, result);
    }
    case 'process': {
      if (call.arguments.action === 'workflow') return executeWorkflowTool(context, call);
      if (call.arguments.action === 'debug') return executeDebuggerTool(context, call);
      if (call.arguments.action === 'describe' || call.arguments.action === 'compute')
        return executeComputationTool(context, call);
      const action = textValue(call.arguments.action, 'list');
      if (action === 'list')
        return context.runner.call(task.workspaceId, task.id, 'exec', `${root}/processes`);
      const sessionId = textValue(call.arguments.sessionId);
      if (!sessionId) throw new Error('process requires sessionId for this action');
      if (action === 'resume')
        return context.runner.call(
          task.workspaceId,
          task.id,
          'exec',
          `${root}/processes/${encodeURIComponent(sessionId)}/resume`,
          {}
        );
      return context.runner.call(
        task.workspaceId,
        task.id,
        'exec',
        `${root}/processes/${encodeURIComponent(sessionId)}`,
        {
          action,
          ...(call.arguments.data === undefined ? {} : { data: call.arguments.data }),
          ...(['write', 'resize'].includes(action) &&
          call.arguments.options &&
          typeof call.arguments.options === 'object'
            ? Object.fromEntries(
                Object.entries(call.arguments.options).filter(([key]) =>
                  (action === 'write'
                    ? ['inputRevision', 'inputGeneration']
                    : ['columns', 'rows']
                  ).includes(key)
                )
              )
            : {})
        }
      );
    }
    case 'files_list':
      return context.runner.call(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/files?path=${encodeURIComponent(textValue(call.arguments.path, 'workspace'))}`
      );
    case 'file_read': {
      const path = textValue(call.arguments.path);
      /*
       * A window is read as a window.
       *
       * Asking for lines 900-920 used to pull the entire file across the runner boundary and into
       * this process, decode it, split it, and throw all but twenty lines away. On a log or a
       * dataset that is the difference between a small request and one that can exhaust the
       * worker - and the runner has always had a ranged reader, which nothing called.
       *
       * The whole-file path stays for the unbounded case, because it is the only one that
       * returns the hash `file_write` needs: a whole-file write does not fail on a concurrent
       * change, it silently discards it, and this tree has at least three other writers - the
       * agent's own shell, a second worker slot, and the owner in the file browser.
       */
      // The second of the three clamps that already defended against `NaN`, and the defence was
      // the implicit one: `NaN > 0` is false, so an unreadable line number fell through to the
      // whole-file read. Said out loud now, in the words the other arms use.
      const requestedStart = finiteNumber(call.arguments.startLine) ?? 0;
      const requestedEnd = finiteNumber(call.arguments.endLine) ?? 0;
      const windowed = requestedStart > 0 || requestedEnd > 0;
      if (windowed) {
        const startLine = Math.max(1, requestedStart || 1);
        const wanted = Math.max(startLine, requestedEnd || startLine + 200);
        /*
         * The same two budgets the unwindowed arm below is held to, and for the same reason rather
         * than for symmetry.
         *
         * This arm used to fetch 400,000 bytes and record every line of them as displayed, while
         * `recordToolResult` cut the result to 24,000 characters two layers downstream. On this
         * repository's largest test file `file_read {startLine: 1, endLine: 8332}` delivered all
         * 354,014 bytes, vouched for all 8,332 lines, and put 5.95% of them in front of the model -
         * the identical defect the unwindowed bound was shipped to close, still open on the arm that
         * is 47.4% of the read traffic on this machine. It also made the write guard below trivially
         * walkable: one wide window and the record claimed the whole file had been seen.
         *
         * It binds on very little real traffic. Across 12,347 windowed reads measured on this
         * machine p90 displayed is 360 lines, and 360 lines of this repository's average 43.4
         * characters is 15,600 bytes - inside both budgets.
         */
        const endLine = Math.min(wanted, startLine + FILE_READ_DISPLAY_LINES - 1);
        const read = await context.runner.readFileLines(task.workspaceId, task.id, path, {
          startLine,
          endLine,
          maxBytes: FILE_READ_DISPLAY_BYTES
        });
        /*
         * A read that stopped MID-LINE displayed half a line, and half a line is not displayed. It
         * is still returned - the model asked for it - but it is not recorded as seen, because a
         * record that vouched for the half that never arrived is exactly the blind anchor the
         * record exists to refuse. The runner's own seen-line ledger draws the same line in the
         * same place, deliberately, off the same field.
         *
         * `truncated` is not that question and answering it with `truncated` cost a line per
         * window. A window whose budget ran out exactly as a line ended delivered that line whole
         * and is reported truncated because it could not start the next one; cutting the last row
         * off then discards a line the model is looking at. Measured through this arm over 947
         * tracked text files, nine of them page end to end into coverage with a hole in it -
         * `evals/report.ts` delivers line 337 and recorded 1-336 - and the whole-file write the
         * paging had earned was refused, naming a line the model had already been shown.
         */
        const shownLines = toLines(read.content);
        const whole = read.partialLine ? shownLines.slice(0, -1) : shownLines;
        if (whole.length) recordRead(reader, path, read.startLine, whole.join('\n'));
        /*
         * What this window leaves outstanding, so the whole-file write below can be asked about it.
         *
         * Nothing did this before, and that was the severe hole: a window read set no length and
         * claimed no hash, so the worker's guard had nothing to consult and the runner's ran behind
         * a hash this arm cannot produce. Measured through the shipped tool, `file_read` of lines
         * 1-200 followed by a whole-file `file_write` was accepted and destroyed 8,132 lines.
         *
         * `totalLines` only arrives when the reader actually reached the end of the file; when it
         * did not, all that is known is that the file goes further than what came back whole, and
         * that is enough to refuse a write claiming to replace all of it.
         */
        /*
         * `read.endLine` is a line this window reached; the floor has to be a line it did not show,
         * and which of those two `endLine` is depends on how the window ended.
         *
         * Cut mid-line, `endLine` IS the unshown line - half of it arrived, so naming it is exact.
         * Cut between lines, `endLine` was delivered whole and the file is known to go at least one
         * further, because the reader stopped only when it found another line to start. Carrying
         * the mid-line answer into the between-lines case understates the floor by one, and that
         * one line is the difference between refusing a whole-file write after a single window of a
         * 901-line file and accepting it: measured with the record fixed and this left alone, the
         * worker's floor stopped firing and only the runner's own guard still refused.
         */
        const reachTo =
          read.totalLines ??
          (read.partialLine ? read.endLine : Math.max(read.endLine + 1, startLine));
        state.partialReads = withPartialRead(
          state.partialReads,
          path,
          read.totalLines !== undefined && firstUnshown(reader, path, read.totalLines) === undefined
            ? undefined
            : reachTo
        );
        return {
          path,
          startLine: read.startLine,
          endLine: read.endLine,
          ...(read.totalLines === undefined ? {} : { totalLines: read.totalLines }),
          // Where to carry on from, when the window was cut short by its own byte budget rather
          // than by reaching the end. Without it a truncated read is a dead end.
          ...(read.nextStartLine === undefined ? {} : { nextStartLine: read.nextStartLine }),
          // True when the window the model asked for is not the window it got, whichever budget
          // stopped it: saying `false` because no line was cut in half, on a request for 8,332
          // lines answered with 800, is the report being wrong in the direction that costs most.
          truncated: read.truncated || read.endLine < wanted,
          content: renderNumbered(shownLines, read.startLine)
        };
      }
      /*
       * The budget travels with the request, and what comes back is what was recorded as shown.
       *
       * This arm used to fetch the whole file and cut it here. The cut was right and the place was
       * wrong: the runner is where the seen-line ledger lives, so a prefix chosen after the fact was
       * a prefix that ledger never heard about, and the two records of what the model had been shown
       * disagreed. Measured on a 659-line file, an unwindowed read displaying lines 1-397 followed
       * by a window over the remainder left the runner holding 398-659 only - and a patch to line
       * 50, a line the model HAD been shown, was refused by name. Asking for the prefix instead of
       * making one means the arm cannot display what it was not sent, so the two ledgers hold the
       * same lines by construction.
       */
      const read = await context.runner.readFileForDisplay(task.workspaceId, task.id, path, {
        maxBytes: FILE_READ_DISPLAY_BYTES,
        maxLines: FILE_READ_DISPLAY_LINES
      });
      const shown = toLines(read.content);
      // The same rule the windowed arm above draws: a line cut short by the byte budget is shown,
      // because an answer of no lines is a dead end, and is not recorded, because it did not arrive.
      const whole = read.partialLine ? shown.slice(0, -1) : shown;
      const complete = read.displayedLines >= read.totalLines;
      /*
       * The hash is still recorded, and deliberately, because it answers a different question.
       *
       * `expectSha256` asks "is this still the file you read", and the runner hashed the whole file
       * whatever it sent back - the bound is about what is DISPLAYED, not about what was hashed - so
       * the claim is as true as it ever was and the concurrency guard keeps working. What a partial
       * read must not do is authorise replacing the part it did not show, and that is a second
       * question with a second answer below. Conflating them by dropping the hash would refuse the
       * blind write by removing a guard, which is the wrong mechanism for the right refusal: it
       * would also switch the runner's own 409 off for the same file.
       */
      if (read.sha256)
        state.readFileHashes = { ...(state.readFileHashes ?? {}), [path]: read.sha256 };
      /*
       * What a read that did not show the whole file leaves behind: the file's real length, so a
       * later whole-file write can be asked whether anything has since shown the rest.
       *
       * Cleared on a complete read, because a read that showed everything has nothing outstanding
       * and a stale entry would refuse a write that is now perfectly well evidenced.
       */
      state.partialReads = withPartialRead(
        state.partialReads,
        path,
        complete ? undefined : read.totalLines
      );
      // Only what was displayed whole is recorded as displayed.
      if (whole.length) recordRead(reader, path, 1, whole.join('\n'));
      return {
        path,
        startLine: 1,
        endLine: shown.length,
        totalLines: read.totalLines,
        /*
         * Where to carry on from, in the same words the windowed path above uses, so a read cut
         * short here is continued exactly as one cut short there is - and absent when there is
         * nowhere to carry on TO. A file of one line longer than the whole budget is the case that
         * proves this bound is about delivered bytes rather than delivered lines: it is reported
         * truncated, because it is, and it is offered no continuation, because there is no second
         * line and resuming at the first would hand back the same half forever.
         */
        ...(!complete && shown.length < read.totalLines ? { nextStartLine: shown.length + 1 } : {}),
        truncated: !complete,
        content: renderNumbered(shown, 1)
      };
    }
    case 'file_patch': {
      const patches = Array.isArray(call.arguments.patches)
        ? (call.arguments.patches as Array<Record<string, unknown>>)
        : [];
      if (!patches.length || patches.length > MAX_PATCH_FILES)
        throw new GardenError(
          'patch_invalid',
          `Use {patches:[{path,oldText,newText}]} with between 1 and ${MAX_PATCH_FILES} entries.`
        );
      const applied: Array<{ path: string; sha256: string; lines: number; notes: string[] }> = [];
      const failures: Array<{ path: string; reason: string }> = [];
      const uncertain: Array<{ path: string; reason: string; expectedSha256: string }> = [];
      const warnings: string[] = [];
      const grouped = new Map<string, { path: string; replacements: TextReplacement[] }>();
      // Every replacement for one file applies to one read and lands as one atomic write.
      for (const patch of patches) {
        const path = textValue(patch?.path);
        if (!path || typeof patch.oldText !== 'string' || typeof patch.newText !== 'string')
          throw new GardenError(
            'patch_invalid',
            'Every entry needs path, oldText and newText strings.'
          );
        if (path.includes('\0') || path.split('/').includes('..'))
          throw new GardenError(
            'patch_invalid',
            'Patch paths must not contain traversal or null bytes.'
          );
        const identity = path
          .replace(/^workspace\//, '')
          .split('/')
          .filter((part) => part !== '.' && part !== '')
          .join('/');
        const replacement: TextReplacement = {
          oldText: patch.oldText,
          newText: patch.newText,
          ...(patch.replaceAll === true ? { replaceAll: true } : {})
        };
        const previous = grouped.get(identity);
        if (previous) previous.replacements.push(replacement);
        else grouped.set(identity, { path, replacements: [replacement] });
      }
      for (const { path, replacements } of grouped.values()) {
        let readHash: string | undefined;
        let before: string;
        try {
          const read = await context.runner.readFileWithHash(task.workspaceId, task.id, path);
          before = read.content;
          readHash = read.sha256 ?? undefined;
        } catch (cause) {
          failures.push({
            path,
            reason: `${path} could not be read: ${cause instanceof Error ? cause.message : 'read failed'}.`
          });
          continue;
        }
        const result = applyReplacements(path, replacements, before);
        if (!result.ok) {
          failures.push({ path, reason: result.reason });
          continue;
        }
        const receipt: PatchReceipt = {
          path,
          expectedSha256: sha256(result.text),
          beforeSha256: sha256(before),
          status: 'uncertain'
        };
        try {
          await recordPatchReceipt(context.store, task.id, context.key, call.id, receipt);
        } catch {
          failures.push({
            path,
            reason: 'Could not persist the edit intent. No write was attempted.'
          });
          continue;
        }
        let written: unknown;
        try {
          written = await context.runner.writeFile(
            task.workspaceId,
            task.id,
            path,
            result.text,
            readHash
          );
        } catch (cause) {
          // A lost response does not prove a write failed. Reconcile without replay or rollback.
          const reason = cause instanceof Error ? cause.message : 'Write failed';
          try {
            const observed = await context.runner.readFileWithHash(task.workspaceId, task.id, path);
            if (observed.content === result.text) {
              written = { sha256: sha256(result.text) };
              warnings.push(`${path}: the write response was lost; the bytes were verified.`);
            } else if (observed.content === before) {
              failures.push({ path, reason });
              await recordPatchReceipt(context.store, task.id, context.key, call.id, {
                ...receipt,
                status: 'failed',
                reason
              }).catch(() => undefined);
              continue;
            } else {
              uncertain.push({
                path,
                reason: `${reason}; the file now has different bytes. Read it before editing again.`,
                expectedSha256: sha256(result.text)
              });
              continue;
            }
          } catch {
            uncertain.push({
              path,
              reason: `${reason}; the current file could not be read. Reconcile it before retrying.`,
              expectedSha256: sha256(result.text)
            });
            continue;
          }
        }
        await recordPatchReceipt(context.store, task.id, context.key, call.id, {
          ...receipt,
          status: 'applied'
        }).catch(() => {
          warnings.push(`${path}: the edit receipt could not be stored; it reconciles by hash.`);
        });
        const hash = (written as { sha256?: unknown })?.sha256;
        if (typeof hash === 'string')
          state.readFileHashes = { ...(state.readFileHashes ?? {}), [path]: hash };
        const after = toLines(result.text);
        // A replacement authorises the span it wrote; the rest of the file is as unread as it was.
        state.partialReads = shiftPartialRead(
          state.partialReads,
          path,
          after.length - toLines(before).length
        );
        recordWrite(reader, path, result.text, result.changed);
        state.artifactLedger = recordArtifactWrite(state.artifactLedger, {
          path,
          mode: 'edited',
          bytes: landedBytes(written, result.text),
          step: state.step
        });
        // A parse failure is a note, never a refusal: a multi-step change may pass through one.
        const fault = await checkSyntax(path, result.text).catch(() => null);
        applied.push({
          path,
          sha256: sha256(result.text),
          lines: after.length,
          notes: fault
            ? [
                `syntax ${path} line ${fault.line}: ${fault.message}\n${numberedWindow(after, { from: fault.line, to: fault.line }, 1)}`
              ]
            : []
        });
      }
      if (!applied.length && !uncertain.length)
        throw new GardenError(
          'patch_conflict',
          failures.map((failure) => failure.reason).join('\n') || 'No replacement could be applied'
        );
      try {
        const usage = await context.runner.call<{ storageBytes: number }>(
          task.workspaceId,
          task.id,
          'files.read',
          `${root}/usage`
        );
        await context.store.setWorkspaceStorage(task.userId, task.workspaceId, usage.storageBytes);
      } catch {
        warnings.push('Storage accounting could not refresh; the file receipts below still apply.');
      }
      // Detached checks run after the turn's undo point; see `armPostEditChecks`.
      armPostEditChecks(
        context,
        applied.map(({ path }) => path)
      );
      return {
        filesChanged: applied.map(({ path, sha256: digest, lines }) => ({
          path,
          sha256: digest,
          lines
        })),
        ...(uncertain.length ? { uncertain } : {}),
        ...(warnings.length ? { warnings } : {}),
        ...(applied.some(({ notes }) => notes.length)
          ? { notes: applied.flatMap(({ notes }) => notes) }
          : {}),
        ...(failures.length ? { failed: failures } : {})
      };
    }
    case 'image_read':
      return context.runner.readImage(task.workspaceId, task.id, textValue(call.arguments.path));
    case 'file_write': {
      const writePath = textValue(call.arguments.path);
      /*
       * A whole-file write may not be the way a model discards the part of a file it was never
       * shown.
       *
       * This is the other half of the display bound above, and without it that bound would have
       * made things worse rather than better: capping the display while leaving this alone means a
       * model that saw 415 lines of 2,000 still holds a hash over all 2,000, the runner's
       * concurrency check passes because the file really has not changed, and 1,585 lines are
       * destroyed by a call that looked entirely well-formed.
       *
       * This comment used to claim the WINDOWED read was the safe one - that the same write after a
       * window "is refused by name one layer down". It was not. Measured through this arm against
       * the real runner on an 8,332-line file: after `file_read {startLine: 1, endLine: 200}` the
       * whole-file write was ACCEPTED and destroyed 8,330 of 8,332 lines, 354,002 of 354,014 bytes.
       * The runner's guard is correct and fires by name when it runs; it simply never ran, because
       * the windowed arm claims no hash and the guard was opened only for callers that do. Both
       * ends of that are now closed - every read arm records what it left outstanding here, and the
       * runner holds an agent's write to its record whether or not a hash came with it - and the
       * lesson is the one this repository already has a rule about: a comment is not a measurement.
       *
       * It is a coverage question, not a freshness one, so it is asked of the read record rather
       * than of the hash - and it lifts the moment the record covers the file, which is what makes
       * the refusal below performable rather than a wall. Reading the rest with startLine and
       * endLine is a thing the model can actually do, and doing it clears this.
       */
      const outstanding = state.partialReads?.[writePath];
      const unshownFrom =
        outstanding === undefined ? undefined : firstUnshown(reader, writePath, outstanding);
      if (unshownFrom !== undefined)
        throw new GardenError(
          'write_unread',
          /*
           * One outstanding line is the file with no newlines in it, and it needs a different
           * sentence because the usual two recoveries are both closed to it: there is no further
           * range to read, and a line-addressed edit needs a line that has been shown whole. Naming
           * a recovery the model cannot perform is a failure this repository has already paid for
           * once, in a truncation marker that said "run the tool again".
           */
          outstanding === 1
            ? `${writePath} is a single line too long to be delivered in one read, so you have been shown only the start of it and writing the whole file would discard the rest. A line-addressed edit cannot reach it either, because its one line has never been shown whole. Transform it with a program from the shell instead - read the file, change it, write it back - so nothing depends on you having seen all of it.`
            : `${writePath} has at least ${outstanding} lines and line ${unshownFrom} onwards has never been shown to you, so writing the whole file would discard the part you have not read. Either use file_patch, which changes the lines you were shown and leaves the rest of the file exactly as it is, or read from line ${unshownFrom} with file_read using startLine and endLine and then send this write again.`
        );
      // Only claimed when this turn actually read the file. A first write, or a write to
      // something never read, claims nothing and proceeds - demanding a hash everywhere would
      // refuse every file this computer creates.
      const expected = state.readFileHashes?.[writePath];
      const result = await context.runner.writeFile(
        task.workspaceId,
        task.id,
        writePath,
        textValue(call.arguments.content),
        expected
      );
      // What is on disk now is what this turn just wrote, so a second write in the same turn
      // claims that rather than the version read before it.
      if (typeof (result as { sha256?: unknown })?.sha256 === 'string')
        state.readFileHashes = {
          ...(state.readFileHashes ?? {}),
          [writePath]: (result as { sha256: string }).sha256
        };
      // The content is what this call supplied, so there is no unread remainder left to protect -
      // and the record of what has been shown becomes that content, whole. This is the one write
      // where "text a caller authored is text it has been shown" is true of the whole file, and
      // saying so replaces a record whose line numbers describe a version that is now gone.
      state.partialReads = withPartialRead(state.partialReads, writePath, undefined);
      recordWrite(reader, writePath, textValue(call.arguments.content));
      // Behind the await, so a write the runner refused - a stale hash, an edit over lines nobody
      // has been shown, a file past the size limit - has thrown out of this arm with nothing
      // recorded. @see ARTIFACT_LEDGER_MARKER in context.ts for why that ordering is the whole
      // value of the block.
      state.artifactLedger = recordArtifactWrite(state.artifactLedger, {
        path: writePath,
        mode: 'wrote',
        bytes: landedBytes(result, textValue(call.arguments.content)),
        step: state.step
      });
      const usage = await context.runner.call<{ storageBytes: number }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/usage`
      );
      await context.store.setWorkspaceStorage(task.userId, task.workspaceId, usage.storageBytes);
      return result;
    }
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
