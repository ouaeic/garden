/**
 * Where the middle of an over-long tool result goes, so that cutting it stops destroying it.
 *
 * `truncateMiddle` has always said how many characters it removed and never where they went. The
 * marker it replaced named the encrypted task event as the recovery, and that comment records why
 * it was retired: no tool reads a task event, so the omitted span was in practice unrecoverable,
 * and a 200 kB `shell` result reached the model as 24,000 characters with 176,000 gone for good.
 * This is the recovery that is real - the whole serialised result is written once, named by its
 * own sha256, and the marker interpolates that path and the point at which the cut began.
 *
 * **Trust decides the directory, and nothing else does.** A result that came from outside goes
 * under `workspace/downloads/`, which `DOWNLOAD_QUARANTINE_PREFIXES` in `command-classification.ts`
 * already declares to be bytes somebody else wrote sitting in the owner's own workspace - so a
 * later `file_read` of a spilled page is classified untrusted, sanitised and fenced exactly as the
 * original read was. Parking it anywhere else would be a laundering channel and would undo the
 * repair wave 1 made: the fence is put on the string in the WINDOW, and the same bytes read back
 * off a clean path arrive with no fence at all, in the harness's own voice.
 *
 * The sha256 name is free deduplication. A poll loop that reads the same 200 kB log on ten
 * consecutive steps writes one file, and the second through tenth cuts point at the file the first
 * one left; within a turn the repeat does not even reach the runner.
 *
 * The runner client is registered per turn rather than threaded through `ToolRecordingDeps`,
 * which is a closed interface five call sites share and of which this is the only member that
 * needs to write a file. It is held in a `WeakMap` keyed by the turn's own `AgentState`, so two
 * tasks running in one worker cannot see each other's writer, nothing is a module-level copy of
 * the worker's own state, and the entry dies with the state it belongs to.
 */
import { createHash } from 'node:crypto';
import type { TaskRecord } from '@garden/data';
import type { AgentState } from './agent-state.js';
import type { AgentRunnerClient } from './runner-client.js';
import { UNTRUSTED_ENVELOPE_OPENING } from './sanitise.js';

/**
 * Where a result the owner's own computer produced parks its overflow.
 *
 * Under `workspace/` rather than beside it: the runner owns the sibling `.garden` at a mode the
 * agent cannot traverse, and a path the agent cannot read is the same useless recovery as the task
 * event. `publishing.ts` writes `workspace/.garden/renders/` for the same reason.
 */
export const SPILL_DIRECTORY = 'workspace/.garden/output';

/**
 * And where a result from outside parks its overflow: inside the download quarantine, so that the
 * existing prefix list is what taints a read of it and there is no second list to keep in step.
 */
export const UNTRUSTED_SPILL_DIRECTORY = 'workspace/downloads/garden-output';

/**
 * The largest result this will park, and the point past which it says nothing at all.
 *
 * A tool result is already bounded by the runner's own output ceilings, so this is the floor under
 * a route that stops honouring them rather than an expected case. Silence is the right failure:
 * the alternative is a marker naming a path holding a fraction of what it claims, which is the
 * exact fault - a recovery that cannot be performed - this file exists to close.
 */
export const MAX_SPILL_CHARS = 8_000_000;

/** The one runner client this turn writes through, keyed by the turn's own state. */
const writers = new WeakMap<AgentState, AgentRunnerClient>();
/** Paths this turn has already put on the disk, so identical bytes cost one round trip. */
const written = new WeakMap<AgentState, Set<string>>();

/**
 * Names the runner this turn's overflow is written through. Called once per turn from
 * `assemblePreamble`, which is the one place that holds both the worker's runner client and the
 * state object every later step mutates.
 */
export const useOutputSpill = (state: AgentState, runner: AgentRunnerClient): void => {
  writers.set(state, runner);
};

/** The path a given body would be parked at. Pure, so a test can name it without writing it. */
export const spillPathFor = (text: string, untrusted: boolean): string =>
  `${untrusted ? UNTRUSTED_SPILL_DIRECTORY : SPILL_DIRECTORY}/${createHash('sha256')
    .update(text)
    .digest('hex')}.txt`;

/**
 * Parks the whole of an over-long result and answers with the path, or with null when no claim can
 * honestly be made about it.
 *
 * Null on three counts, and all three are the same rule: nothing may be named that is not there.
 * No writer registered (a delegated specialist's window, which never runs a preamble), a body past
 * the ceiling, or a runner that refused the write - a full disk, a wedged service, a workspace
 * being deleted underneath the turn. A failed spill costs the model the pointer it never had
 * before this file existed; a spill claimed and not made would cost it a step reading a file that
 * is not there, and cost the harness the only thing its markers have ever been good for.
 */
export const spillOverflow = async (
  task: TaskRecord,
  state: AgentState,
  text: string,
  untrusted: boolean
): Promise<string | null> => {
  const runner = writers.get(state);
  if (!runner || text.length > MAX_SPILL_CHARS) return null;
  const path = spillPathFor(text, untrusted);
  const already = written.get(state) ?? new Set<string>();
  written.set(state, already);
  if (already.has(path)) return path;
  try {
    await runner.writeFile(task.workspaceId, task.id, path, text);
  } catch {
    return null;
  }
  already.add(path);
  return path;
};

/**
 * The words every marker naming a parked file opens with, so that a later pass can find one.
 *
 * A bare path is not enough to look for. The window is full of paths, a transcript can contain any
 * string, and what a later pass has to recognise is specifically a claim THIS file made - so the
 * pattern below is anchored on the sentence rather than on the shape of the name. Shared by both
 * markers for the same reason: one phrase, written once, or the reader stops finding the second
 * one the day somebody rewords it.
 */
const SPILL_SENTENCE_OPENING = 'the whole result is at ';

/**
 * What the model is told in place of the bytes that were cut.
 *
 * Two clauses doing two jobs. The first is the pointer, and it leads on the CHARACTER rather than
 * the line because of what a spilled tool result actually is: `JSON.stringify` writes a newline as
 * `\n`, so the file is one enormous line and a line number is a true fact that addresses nothing.
 * `cut -c` is named because it is the one ordinary command that takes a span out of a single line,
 * and a recovery that cannot be performed is the precise fault this whole file exists to close.
 * The line is still given when the body genuinely has more than one, since the same marker serves
 * anything `truncateMiddle` is asked to park.
 *
 * The second clause is the one that changes the NEXT call rather than this one: a model that has
 * just lost 176,000 characters is about to ask for them again exactly the same way, and telling it
 * to bound the output where the output is made costs nothing and saves a round trip. It is
 * deliberately not an apology for the cut - the cut is correct, and what was wrong was asking a
 * command to print a hundred times more than any window can hold.
 */
export const spillRecovery =
  (path: string) =>
  (cut: { character: number; line: number }): string =>
    `${SPILL_SENTENCE_OPENING}${path} and the cut begins at character ${cut.character}${
      cut.line > 1 ? ` (line ${cut.line})` : ''
    } - read that span back with \`cut -c\` or a bounded file_read instead of running this again, and next time bound long output where it is made, with head, tail or grep, or send it to a file and read the file in pieces`;

/**
 * The one shape a parked path has, built from the two directories above rather than spelled again.
 *
 * Spelling it again is how a pattern and the writer it is meant to track come apart: the reader
 * keeps matching, on nothing, and the failure is silent in exactly the direction that costs the
 * model the pointer. Bounded by construction - the hash length is fixed - so there is no
 * backtracking to price here.
 */
const SPILL_MARKER = new RegExp(
  `${SPILL_SENTENCE_OPENING}((?:${[SPILL_DIRECTORY, UNTRUSTED_SPILL_DIRECTORY]
    .map((directory) => directory.replace(/\./g, '\\.'))
    .join('|')})/[0-9a-f]{64}\\.txt)`,
  'g'
);

/**
 * The path a piece of window text names, when it names one this file actually wrote.
 *
 * Three questions now, and the first one was added at the gate because the guard below had been
 * checked in one direction only.
 *
 * THE FIRST is whether the text names one path or several. The marker sits at 62% of the bound it
 * was written under, so the 38% in front of it is the tool's own output, and a result whose bytes
 * quote this sentence puts a second marker BEFORE the harness's own. Taking the first match then
 * let the content choose, and what it chose was restated in the harness's own voice - in the
 * durable brief under "Cut results kept whole on disk", in both stub tiers, and at every later
 * cut. Demonstrated on the strings `recordToolResult` actually produces, in both directions: a
 * trusted result forging a clean-directory marker, and a fenced page forging a QUARANTINE-
 * directory one, which agrees with its own fence and so walks through the trust check below. The
 * harness never writes two: `truncateMiddle` emits one marker, `parkedPointer` appends one
 * sentence, and a message cut twice names the same file both times. So more than one DISTINCT
 * path is a claim this file cannot honour, and the honest answer is none - the attacker gets the
 * pointer suppressed, which is exactly what every window did before this mechanism existed, and
 * does not get a path of their choosing spoken back by the harness.
 *
 * THE SECOND is whether the directory the path names agrees with where the text came from, and it
 * is asked because trust is the only thing that chooses the directory: a result from outside is
 * parked in the quarantine and fenced, a result from the owner's own computer is parked on a clean
 * path and is not. So the two always agree when the harness wrote the marker, and a
 * `.garden/output` path quoted inside a fenced result is a path the harness did not write for
 * that result - it is a string that arrived from outside naming a clean address, which is the
 * laundering channel this whole file was arranged to avoid. Refused, in that one direction.
 *
 * The other direction is refused too, and is only ever a mistake rather than an attack: a
 * quarantine path in an unfenced result cannot have been written for it either.
 *
 * Null is the answer to all four of "no marker", "more than one", "not a path this wrote" and "the
 * two disagree", because everything downstream of here is a claim the harness makes in its own
 * voice, and the one fault this file exists to close is a claim that cannot be honoured.
 *
 * What is left open, and is left open deliberately rather than papered over: a result that carries
 * a forged marker and no genuine one - a page short enough never to have been cut, or one whose
 * spill the runner refused - is still answered with the forged path. The bound on that is the
 * pattern itself, which admits nothing but a 64-character hex name inside one of two directories
 * this file owns, so the worst of it is one wasted read of a file that is not there; it cannot
 * name an arbitrary path and it cannot get quarantined bytes read back unfenced, because a
 * quarantine path read back is tainted by `DOWNLOAD_QUARANTINE_PREFIXES` exactly as the original
 * fetch was. Closing it properly means carrying the path beside the message instead of inside it,
 * which is state this mechanism deliberately does not keep, and which should be bought by whoever
 * measures how often a result quotes this sentence at all.
 */
export const spillPathIn = (content: string): string | null => {
  // Fresh matches each call: the pattern is global so that every marker is seen rather than the
  // first, and `matchAll` does not carry `lastIndex` between calls the way `exec` would.
  const named = new Set([...content.matchAll(SPILL_MARKER)].map((match) => match[1] ?? ''));
  if (named.size !== 1) return null;
  const [path = ''] = named;
  const quarantined = path.startsWith(`${UNTRUSTED_SPILL_DIRECTORY}/`);
  // Only the outer harness reference may precede the envelope. A reference quoted inside the
  // fenced body cannot change its trust class.
  const body = content.replace(/^Result reference: [^\r\n]+\.\n/, '');
  return body.startsWith(UNTRUSTED_ENVELOPE_OPENING) === quarantined ? path : null;
};

/**
 * The same pointer, restated by a later cut that can no longer say where the first one fell.
 *
 * A tool result is written into the window once and bounded again on every step after it: the
 * older-output floor descends as the window fills, and each descent cuts the middle out of every
 * older result at once. The marker is IN that middle - it sits at 62% of the first bound and every
 * later bound is smaller - so the pointer is the first thing a squeeze takes, and it goes long
 * before any compaction runs. Measured on the shipped `prepareModelContext` at a 131,072-token
 * window: gone at step 37, when the floor first moved from 24,000 to 18,000, thirty steps before
 * compaction would have fired at all.
 *
 * What it does NOT say is where the cut fell, and that omission is the whole point of it being a
 * second sentence. The offset `spillRecovery` names is an offset into the result; a later cut is
 * an offset into what the earlier cut left, and restating the first number against the second cut
 * would be a marker that is precise, confident and wrong. `spillRecovery`'s own advice about
 * bounding output where it is made is dropped for the opposite reason: it did its work when the
 * result arrived, and the call it was meant to change has long since been made.
 */
export const spillCarriedRecovery = (path: string): string =>
  `${SPILL_SENTENCE_OPENING}${path} - read the span you need with \`cut -c\` or a bounded file_read`;
