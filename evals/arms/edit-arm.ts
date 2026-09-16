/**
 * The one thing no offline rig measured and none could: whether a model emits the dialect.
 *
 * ── Why this file exists ───────────────────────────────────────────────────────────────────────
 *
 * A line-addressed edit format was priced at 61% fewer output characters over fourteen of fourteen
 * tasks where both formats behave, and the ruling in `docs/design/exec3/L2.md` held it anyway,
 * because every one of those numbers is an upper bound available only to a model that gets the
 * spelling right every time. The reference implementation the format was measured from ships a
 * hand-maintained deny-list of four models that miscount anchors or drop the tag header - which is
 * a statement that emission failure is a real, per-model, routing-level fact rather than an
 * implementation bug somebody could fix. athanor runs on whatever model the owner points it at, so
 * athanor cannot route around it.
 *
 * The ruling named the gate: one arm whose single difference is the edit tool, over the same
 * sample, reporting edit-success and mean output tokens on the same row. This is that arm.
 *
 * ── What changed under this file, and why the arm is now a rollback ────────────────────────────
 *
 * The format landed. `apps/worker/src/tools/workspace.ts` is the line-addressed applier now, and
 * the quoted editor it replaced exists in no file of the working tree. So the arm called `shipped`
 * is the one this rig has to reconstruct, and `wire.ts` reconstructs its catalogue entry from the
 * last revision that declared it rather than from a transcription. Its APPLIER is reconstructed
 * here, in `quotedPatch` below, out of the same revision - and that is the one place in this
 * directory where a rig models something instead of importing it. It is called out where it
 * happens and the checks that hold it honest are in `selftest.ts`.
 *
 * Nothing about the candidate side is modelled: `applyEdit`, `parseEdit`, `renderNumbered` and the
 * snapshot ledger are imported from `apps/worker/src/edit/` and used exactly as `workspace.ts`
 * uses them, in the same order, including the re-record after a write that lets a second edit
 * follow the first with no read between them.
 *
 * ── Why the sample is the corpus and not the fixtures ──────────────────────────────────────────
 *
 * `tasks.ts` takes the general sample from `evals/fixtures.ts` and gives the reason: a second
 * corpus is a corpus written by somebody who already has a hypothesis. The same reasoning points
 * here at `evals/edit/corpus.ts` rather than at anything written in this file. That corpus was
 * written before the arm existed, by a wave arguing the other side of the question, and it already
 * contains the two shapes where the incumbent should win outright. Its tasks are declared as
 * changes to lines, so the request the model sees, the text a correct edit produces, and the
 * offline character bound are all derived from one declaration - and no dialect is written by hand
 * on either side.
 *
 * ── How the request is built, and which way it is biased ───────────────────────────────────────
 *
 * A request quotes the lines as they read now and the lines they should read afterwards. That is
 * deliberately generous to the quoted editor, whose argument is exactly "the text now" and "the
 * text after": half of its call is sitting in the prompt. It is NOT generous by accident and it is
 * not a hidden thumb on the scale - it is the same choice `evals/edit/encode.ts` made when it
 * handed the incumbent the smallest unique quote it could possibly need. The candidate is the
 * thing that has to justify itself, so the incumbent gets its best case.
 *
 * The quote is the TARGET region only, never the minimal unique one. The quoted editor still has
 * to grow its quote until it is unique - which is its real cost and the whole reason the 61%
 * exists - and that work is left where it belongs, in the model.
 *
 * ── What is left out of the sample, and why that is also the safe direction ─────────────────────
 *
 * Three corpus tasks need something this world cannot do honestly: two drift the file between the
 * read and the edit, and one addresses a line outside the window the model was shown. They are the
 * rows where the CANDIDATE wins - it recovers or refuses them, and the quoted editor lands one of
 * them wrongly - so dropping them costs the candidate, not the incumbent. They are settled
 * offline, by `apps/worker/src/edit/edit.test.ts`, and a live run is not where a refusal is
 * proved.
 *
 * ── Why the reads differ between the two arms, when nothing else may ───────────────────────────
 *
 * `world.ts` rule 1 says a result is a function of the call alone, never of the arm. This world
 * breaks that rule in exactly one place and it is the only place the format allows: the candidate
 * addresses lines by number, so its `file_read` answers `N:TEXT` and its answers are recorded as
 * seen. Reading plain and editing by number is not the candidate measured badly, it is a format
 * that cannot work at all, and every row would refuse for a reason that has nothing to do with the
 * model. The read side is part of the format - `workspace.ts` changed both in one commit - so it
 * is configured once from the arm's settings before the run rather than sniffed per call.
 *
 * It is not free either: numbering is INPUT and is paid whether or not an edit follows. The live
 * table prints input tokens beside output tokens for that reason. Netting the two silently would
 * be arguing for a conclusion.
 */
import { applyEdit } from '../../apps/worker/src/edit/apply.js';
import { blockAt } from '../../apps/worker/src/edit/block.js';
import { renderNumbered, toLines } from '../../apps/worker/src/edit/format.js';
import { parseEdit } from '../../apps/worker/src/edit/parse.js';
import {
  forgetPath,
  readsOf,
  recordRead,
  recordWrite
} from '../../apps/worker/src/edit/snapshots.js';
import { patchFailure } from '../../apps/worker/src/patch-failure.js';
import { countOccurrences } from '../../apps/worker/src/values.js';
import { FILES, TASKS as CORPUS, fileText, type Change, type EditTask } from '../edit/corpus.js';
import { minimalUnique, region } from '../edit/encode.js';
import { settingsFor } from './arms.js';
import { openRouterTransport, runOne, type RunRow, type Transport } from './live.js';
import type { LineChange } from '../../apps/worker/src/edit/snapshots.js';
import type { ArmTask } from './tasks.js';
import type { Oracle, OracleResult } from './world.js';

/* ------------------------------------------------------------------------------- the sample */

export interface EditArmTask extends ArmTask {
  /** The corpus row this was derived from, so a reader can check the derivation. */
  readonly corpusId: string;
  readonly path: string;
  /** Where a correct edit leaves the text, computed by the corpus own `intended`. */
  readonly wanted: string;
  /** Set only for a rename: the path the file must end up at. */
  readonly renamedTo?: string;
}

const lines = (text: string): readonly string[] => text.split('\n');

/** A one-based inclusive region of a file, as a block of text with no added indentation. */
const regionOf = (text: string, from: number, to: number): string =>
  lines(text)
    .slice(from - 1, to)
    .join('\n');

const lineAt = (text: string, at: number): string => lines(text)[at - 1] ?? '';

const block = (text: string, at: number): { from: number; to: number } => {
  const found = blockAt([...lines(text)], at - 1);
  return { from: found.from + 1, to: found.to + 1 };
};

const fence = (label: string, text: string): string => `BEGIN ${label}\n${text}\nEND ${label}`;

/**
 * One declared change, in the owner's words rather than in either dialect.
 *
 * Mechanical on purpose. Prose written per task is prose an author tunes, one sentence at a time,
 * until the arm they expected to win does; this renders from the corpus declaration and the file,
 * so a task cannot be worded in a way that suits one format. Both arms receive the identical bytes,
 * which `selftest.ts` checks rather than trusting.
 */
const describe = (change: Change, path: string, before: string): string => {
  switch (change.kind) {
    case 'replace':
      return `In ${path}, replace the lines that read exactly\n\n${fence('CURRENT', regionOf(before, change.from, change.to))}\n\nso that they read\n\n${fence('WANTED', change.lines.join('\n'))}`;
    case 'block': {
      const span = block(before, change.at);
      return `In ${path}, replace the whole block that begins with the line \`${lineAt(before, change.at)}\` - all of it, down to and including its last line - so that it reads\n\n${fence('WANTED', change.lines.join('\n'))}\n\nThe block as it stands is\n\n${fence('CURRENT', regionOf(before, span.from, span.to))}`;
    }
    case 'insert':
      return `In ${path}, insert the following, immediately ${change.side} the line that reads \`${lineAt(before, change.at)}\`, changing nothing else\n\n${fence('WANTED', change.lines.join('\n'))}`;
    case 'move':
      return `In ${path}, move the following lines, unchanged, so that they sit immediately ${change.after === 0 ? 'at the top of the file' : `after the line that reads \`${lineAt(before, change.after)}\``}\n\n${fence('MOVING', regionOf(before, change.from, change.to))}`;
    case 'rename':
      return `Rename ${path} to ${change.to}, leaving its contents exactly as they are.`;
  }
};

const requestFor = (task: EditTask, before: string): string => {
  const parts = task.changes.map((change) => describe(change, task.path, before));
  const body =
    parts.length === 1
      ? (parts[0] as string)
      : parts.map((part, index) => `(${index + 1}) ${part}`).join('\n\n');
  return `${body}\n\nRead the file before you edit it. Make this change and no other: afterwards the file must differ from the file as it is now only by what is described above. Then finish.`;
};

/**
 * Where a correct edit leaves the file: the declared changes applied to the text they name.
 *
 * Ported into this rig rather than imported, along with the quoted encoding below, because the
 * module that held both was rewritten around a different question while this lane was writing
 * against it - which is the ordinary hazard of two rigs sharing a derivation and is exactly why
 * `world.ts` will not share its loop either. What is still imported from `evals/edit` is the
 * corpus itself, which is DATA and which this rig must not fork (a second corpus is a corpus
 * written by somebody who already has a hypothesis), and `minimalUnique`, which is the arithmetic
 * of the quote and is documented there as kept for this purpose.
 *
 * Splices are collected against the ORIGINAL numbering and applied from the end of the file
 * backwards, so a task with three changes means what it says rather than what its own first change
 * would leave. That is the same rule `applyEdit` follows, and it has to be, or the target text this
 * rig scores against would be a different edit from the one it asked for.
 */
export const intended = (task: EditTask, read: string): string => {
  const start = read.split('\n');
  const splices: Array<{ start: number; remove: number; insert: string[]; order: number }> = [];
  let order = 0;
  for (const change of task.changes) {
    order += 1;
    switch (change.kind) {
      case 'replace':
        splices.push({
          start: change.from - 1,
          remove: change.to - change.from + 1,
          insert: [...change.lines],
          order
        });
        break;
      case 'block': {
        const span = block(read, change.at);
        splices.push({
          start: span.from - 1,
          remove: span.to - span.from + 1,
          insert: [...change.lines],
          order
        });
        break;
      }
      case 'insert':
        splices.push({
          start: change.side === 'after' ? change.at : change.at - 1,
          remove: 0,
          insert: [...change.lines],
          order
        });
        break;
      case 'move': {
        const moved = start.slice(change.from - 1, change.to);
        splices.push({
          start: change.from - 1,
          remove: change.to - change.from + 1,
          insert: [],
          order
        });
        order += 1;
        splices.push({ start: change.after, remove: 0, insert: moved, order });
        break;
      }
      case 'rename':
        return read;
    }
  }
  const out = [...start];
  for (const splice of [...splices].sort((left, right) =>
    left.start === right.start ? right.order - left.order : right.start - left.start
  ))
    out.splice(splice.start, splice.remove, ...splice.insert);
  return out.join('\n');
};

/**
 * The corpus rows a live run can score, and the reason the others are not here.
 *
 * `drift` needs the file to change underneath the model between its read and its edit, which this
 * world does not do; `refuse` needs an edit the harness must decline, which is a property of the
 * applier and is already proved by unit test. Both classes are the candidate's wins, so their
 * absence understates it.
 */
export const EXCLUDED_CORPUS_IDS: readonly string[] = CORPUS.filter(
  (task) => task.drift || task.outcome === 'refuse'
).map((task) => task.id);

export const EDIT_TASKS: readonly EditArmTask[] = CORPUS.filter(
  (task) => !task.drift && task.outcome === 'land'
).map((task) => {
  const before = fileText(task.path);
  const rename = task.changes.find((change) => change.kind === 'rename');
  return {
    id: `edit:${task.id}`,
    corpusId: task.id,
    shape: task.changes.length > 1 ? 'multi' : (task.changes[0]?.kind ?? 'replace'),
    request: requestFor(task, before),
    path: task.path,
    wanted: intended(task, before),
    ...(rename && rename.kind === 'rename' ? { renamedTo: rename.to } : {})
  };
});

/* --------------------------------------------------------------- both dialects, encoded perfectly */

/**
 * A tool call as a model that made no mistake would emit it, in one dialect or the other.
 *
 * Loose in `args` on purpose: the two dialects do not share an argument shape, and a union that
 * described both would have to be edited every time either one moves - which is a rig editing its
 * own definition of the thing it measures.
 */
export type EncodedCall =
  | { readonly tool: 'file_patch'; readonly args: Record<string, unknown> }
  | { readonly tool: 'shell'; readonly args: { readonly command: string } };

/**
 * Characters of the JSON arguments the model has to emit - the unit a provider bills on.
 *
 * The same expression `evals/edit/encode.ts` bills at, deliberately: two rigs disagreeing about
 * the size of one call is two rigs one of which is wrong, and a reader has no way to tell which.
 */
export const emittedChars = (call: EncodedCall): number => JSON.stringify(call.args).length;

/**
 * The candidate's encoding of a corpus task, in the shipped spelling and no other.
 *
 * Written here rather than imported because the encoder in `evals/edit` predates the format that
 * shipped: it emits a `[path#tag]` header, an `MV` and a tool called `file_edit`, none of which
 * the shipped parser is written against. An encoder that produced a dialect nothing runs would
 * report a saving nobody can spend.
 *
 * It cannot silently drift again, because `selftest.ts` puts every one of these through the real
 * `applyEdit` and checks the file afterwards byte for byte. An encoder that stopped matching the
 * parser refuses instead of quietly encoding a different edit.
 */
export const encodeCandidate = (task: EditTask): EncodedCall => {
  if (task.changes.length === 1 && task.changes[0]?.kind === 'rename')
    return { tool: 'shell', args: { command: `mv ${task.path} ${task.changes[0].to}` } };
  const rows: string[] = [];
  for (const change of task.changes) {
    switch (change.kind) {
      case 'replace':
        rows.push(
          change.from === change.to ? `PUT ${change.from}:` : `PUT ${change.from}.=${change.to}:`
        );
        rows.push(...change.lines.map((line) => `+${line}`));
        break;
      case 'block':
        rows.push(`PUT ${change.at}*:`);
        rows.push(...change.lines.map((line) => `+${line}`));
        break;
      case 'insert':
        rows.push(`PUT ${change.side === 'after' ? '>' : '<'}${change.at}:`);
        rows.push(...change.lines.map((line) => `+${line}`));
        break;
      case 'move':
        rows.push(`CUT ${change.from}.=${change.to} @m`);
        rows.push(`PUT >${change.after} @m`);
        break;
      case 'rename':
        // Not in the shipped dialect at all: the worker's runner client has no rename route, so
        // declaring one would be an operation on every request wired to nothing. Both arms reach
        // for the shell, which makes this row a tie and is the honest answer rather than a
        // capability invented for a rig.
        rows.push(`# rename ${task.path} to ${change.to} with shell`);
        break;
    }
  }
  return { tool: 'file_patch', args: { patches: [{ path: task.path, edit: rows.join('\n') }] } };
};

/**
 * The incumbent's encoding of a corpus task, at its best.
 *
 * `encodeReplace` finds the smallest unique quote that contains the target, which is the incumbent
 * measured generously and on purpose. A move is special-cased onto `moveAfter`, the fourth patch
 * shape the quoted editor gained precisely so a moved block crossed the wire once instead of
 * twice: without it the incumbent would be measured on the shape it had before its own last
 * improvement, and a rig that compares a candidate against a stale incumbent is arguing rather
 * than measuring.
 */
export const encodeIncumbent = (task: EditTask, read: string): EncodedCall => {
  if (task.changes.length === 1 && task.changes[0]?.kind === 'rename')
    return { tool: 'shell', args: { command: `mv ${task.path} ${task.changes[0].to}` } };

  const move = task.changes.length === 1 ? task.changes[0] : undefined;
  if (move?.kind === 'move') {
    const source = lines(read);
    const oldText = region(source, move.from, move.to);
    const cut = read.replace(oldText, '');
    const anchor = move.after === 0 ? '' : uniqueEndingAt(cut, source, move.after);
    return {
      tool: 'file_patch',
      args: { patches: [{ path: task.path, oldText, moveAfter: anchor }] }
    };
  }

  const patches: Array<Record<string, string>> = [];
  let live = read;
  /*
   * One patch per change, each addressed against the text the previous patches in the same call
   * left behind - which is how the quoted editor walked its own patch list. The quote is the
   * SMALLEST unique block containing the target, which is the incumbent at its best and is the
   * whole source of its cost: on a repetitive file that block grows until it is unique and then
   * has to be typed back with one word different.
   */
  const push = (from: number, to: number, replacement: readonly string[]): void => {
    const source = lines(live);
    const found = minimalUnique(source, live, from, to);
    if (!found) throw new Error(`${task.id}: no unique oldText exists for lines ${from}-${to}`);
    const oldText = region(source, found.from, found.to);
    const newText =
      region(source, found.from, from - 1) +
      replacement.map((line) => `${line}\n`).join('') +
      region(source, to + 1, found.to);
    patches.push({ path: task.path, oldText, newText });
    live = live.replace(oldText, newText);
  };

  for (const change of task.changes) {
    switch (change.kind) {
      case 'replace':
        push(change.from, change.to, change.lines);
        break;
      case 'block': {
        const span = block(live, change.at);
        push(span.from, span.to, change.lines);
        break;
      }
      case 'insert': {
        const source = lines(live);
        const found = minimalUnique(source, live, change.at, change.at);
        if (!found) throw new Error(`${task.id}: no unique anchor for an insert at ${change.at}`);
        const oldText = region(source, found.from, found.to);
        const added = change.lines.map((line) => `${line}\n`).join('');
        const newText =
          change.side === 'after'
            ? region(source, found.from, change.at) +
              added +
              region(source, change.at + 1, found.to)
            : region(source, found.from, change.at - 1) +
              added +
              region(source, change.at, found.to);
        patches.push({ path: task.path, oldText, newText });
        live = live.replace(oldText, newText);
        break;
      }
      case 'move':
      case 'rename':
        throw new Error(
          `${task.id}: a ${change.kind} cannot share a quoted call with text edits; the corpus has none and this is here so a new one fails loudly rather than being priced wrong`
        );
    }
  }
  return { tool: 'file_patch', args: { patches } };
};

/** The smallest run of whole lines ending at `at` that occurs exactly once in `within`. */
const uniqueEndingAt = (within: string, source: readonly string[], at: number): string => {
  for (let grow = 0; at - grow >= 1; grow += 1) {
    const quote = region(source, at - grow, at);
    if (countOccurrences(within, quote) === 1) return quote;
  }
  throw new Error(`no unique moveAfter anchor ends at line ${at}`);
};

/* -------------------------------------------------------------------------------- the world */

/** Why an edit call did not land, in the applier's own vocabulary. */
export interface EditRefusal {
  readonly tool: string;
  readonly kind: string;
}

/**
 * One edit call, and everything the ship criterion needs to read out of it.
 *
 * The criterion is two numbers and the second is the awkward one: "no more than one edit call in
 * twenty is refused for a dialect error the model does not then recover from". That cannot be
 * derived from a per-row success flag - a row can be correct after two refusals and a retry, and a
 * row can be wrong having never been refused at all - so every call is recorded in order, and the
 * recovery question is answered by looking at what came after it in the same turn.
 *
 * `forgiven` is the other half of the same thesis and it is the number the offline attack lane
 * could only prove was AVAILABLE. A malformed emission the harness absorbs costs nothing: no round
 * trip, no re-read, no refusal to recover from. Counting the two separately is what tells "the
 * model spells it correctly" apart from "the model spells it badly and the harness does not care",
 * which are very different findings that a refusal count alone reports identically.
 */
export interface EditCall {
  readonly applied: boolean;
  /** Refusal kind in the applier's own vocabulary; absent when the call applied. */
  readonly refusedAs?: string;
  /** Leniencies the applier reported, verbatim. Non-empty means a malformed emission that landed. */
  readonly notes: readonly string[];
  /** The call carried at least one `-` row anchor - the taught form. */
  readonly anchored?: boolean;
  /** The call applied with an anchor and left the file other than the task asked: an echo miss. */
  readonly echoMiss?: boolean;
}

/** What the applier's notes say, in the words it uses, so a count here cannot drift from them. */
const CORRECTED = /the number was off by/;
const PREFIX_STRIPPED = /leaked line-number prefix/;
/**
 * Notes that report something about a well-formed patch rather than forgive a malformed one: the
 * nudge on a patch with no anchor, and a body that already read that way. Neither is the harness
 * absorbing a mistake, so neither counts as forgiveness - a clean call carrying the nudge is still
 * a clean call.
 */
const NOT_FORGIVENESS = [/already read that way/];
const forgave = (note: string): boolean =>
  !NOT_FORGIVENESS.some((plain) => (typeof plain === 'string' ? note === plain : plain.test(note)));

/**
 * Refused calls with no later applied call in the same turn.
 *
 * The definition is deliberately the loose one, and loose in the direction that flatters the
 * candidate is exactly what a ship criterion must not be - so read which way it errs: a refusal
 * followed by ANY later applied edit counts as recovered even if the turn still ends wrong. That
 * is generous, and it is safe only because `correct` sits on the same row: an arm that recovers
 * every refusal into a wrong file shows up as 100% recovered and a collapsed success column, which
 * is a louder failure than a refusal count.
 */
export const unrecoveredIn = (calls: readonly EditCall[]): number => {
  let lastApplied = -1;
  for (const [index, call] of calls.entries()) if (call.applied) lastApplied = index;
  return calls.filter((call, index) => !call.applied && index > lastApplied).length;
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const ok = (content: string): OracleResult => ({ content, terminal: false });

interface QuotedPatch {
  readonly path: string;
  readonly oldText: string;
  readonly newText?: string;
  readonly moveAfter?: string;
}

let worlds = 0;

/**
 * The corpus files, one editable filesystem, and both editors.
 *
 * The candidate is `applyEdit` and the snapshot ledger, imported and driven the way `workspace.ts`
 * drives them. The incumbent is reconstructed here from the revision `wire.ts` reads its catalogue
 * entry out of, because it exists in no file of the working tree any more - the exactly-once
 * guard, the single replace, the fourth `moveAfter` shape, and `patchFailure` as the explainer,
 * which is still in `apps/worker/src/` and is now imported by nothing else in the repository.
 */
export class EditWorld implements Oracle {
  private files = new Map<string, string>();
  private taskId = '';
  /** Where a correct turn leaves each file, so an applied-but-wrong anchored edit can be counted. */
  private wanted = new Map<string, string>();
  /** Every call to the edit tool, in order, whether or not it landed. */
  calls: EditCall[] = [];
  refusals: EditRefusal[] = [];

  constructor(private readonly dialect: 'patch' | 'lines') {
    this.reset();
  }

  get editCalls(): number {
    return this.calls.length;
  }

  get editApplied(): number {
    return this.calls.filter((call) => call.applied).length;
  }

  /** Applied calls the harness had to forgive a malformed spelling to accept. */
  get editForgiven(): number {
    return this.calls.filter((call) => call.applied && call.notes.some(forgave)).length;
  }

  get unrecovered(): number {
    return unrecoveredIn(this.calls);
  }

  /*
   * The five numbers the anchored form is measured by, per model, which nothing offline can give:
   * how often a model writes the `-` row at all, how often the row corrected a number, how often
   * it refused as ambiguous or absent, how often an anchored edit still left the wrong file, and
   * how often a display prefix had to be taken off a row. Every one is read from the applier's
   * own notes and refusal kinds, never inferred from the file.
   */
  get anchorPresent(): number {
    return this.calls.filter((call) => call.anchored).length;
  }

  get corrected(): number {
    return this.calls.filter((call) => call.notes.some((note) => CORRECTED.test(note))).length;
  }

  get refusedAmbiguous(): number {
    return this.calls.filter((call) => !call.applied && call.refusedAs === 'evidence').length;
  }

  get echoMiss(): number {
    return this.calls.filter((call) => call.echoMiss).length;
  }

  get prefixStripped(): number {
    return this.calls.filter((call) => call.notes.some((note) => PREFIX_STRIPPED.test(note)))
      .length;
  }

  /** What the task wants `path` to read afterwards. Set before the run, read by `lineEdit`. */
  expect(path: string, text: string): void {
    this.wanted.set(path, text);
  }

  reset(): void {
    for (const path of this.files.keys()) forgetPath(this.taskId, path);
    this.files = new Map(FILES.map((file) => [file.path, file.text]));
    // A fresh id per run rather than a clear: the snapshot store is a module-level cache keyed by
    // task, and a rig that reset it by emptying it would also empty whatever else in this process
    // was mid-turn. The store's own LRU bounds the ids this leaves behind.
    worlds += 1;
    this.taskId = `arms-edit-${worlds}`;
    this.calls = [];
    this.refusals = [];
    this.wanted = new Map();
  }

  /** The file as the turn left it, for scoring. `null` where the turn deleted or renamed it. */
  textAt(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  private paths(): readonly string[] {
    return [...this.files.keys()].sort();
  }

  private grep(needle: string): readonly string[] {
    const hits: string[] = [];
    for (const path of this.paths())
      for (const [index, line] of (this.files.get(path) ?? '').split('\n').entries())
        if (line.toLowerCase().includes(needle.toLowerCase()))
          hits.push(`${path}:${index + 1}: ${line}`);
    return hits;
  }

  /**
   * A read, in the dialect the arm's edit tool requires.
   *
   * The whole-file branch of `workspace.ts:file_read`, both halves of it: the numbering the model
   * is shown, and the record of exactly what was shown. The record is kept on the numbered path
   * only - the quoted editor proves freshness with the quoted text and never asks this ledger a
   * question.
   */
  private read(path: string): string {
    const body = this.files.get(path);
    if (body === undefined) return `No such file: ${path}`;
    if (this.dialect === 'patch') return body;
    recordRead(this.taskId, path, 1, body);
    return renderNumbered(toLines(body), 1);
  }

  private note(
    applied: boolean,
    tool: string,
    kind?: string,
    notes: readonly string[] = [],
    anchored?: boolean,
    echoMiss?: boolean
  ): void {
    this.calls.push({
      applied,
      notes,
      ...(kind ? { refusedAs: kind } : {}),
      ...(anchored ? { anchored } : {}),
      ...(echoMiss ? { echoMiss } : {})
    });
    if (!applied) this.refusals.push({ tool, kind: kind ?? 'refused' });
  }

  /**
   * The quoted editor, as `apps/worker/src/tools/workspace.ts` ran it before the format landed.
   *
   * Faithful to the four things that made it what it was: the quote must occur exactly once, the
   * replace is a single `String.replace`, `moveAfter` cuts and re-pastes without a second copy of
   * the text, and a call whose patches partly match applies the ones that did. That last one is
   * not tidiness - it is the incumbent's real retry story, and a curt "nothing applied" would make
   * it look worse than it was.
   */
  private quotedPatch(raw: unknown): OracleResult {
    const patches = Array.isArray(raw)
      ? (raw as QuotedPatch[])
      : raw && typeof raw === 'object'
        ? [raw as QuotedPatch]
        : [];
    if (!patches.length) {
      this.note(false, 'file_patch', 'no_patches');
      return ok(
        'file_patch takes a `patches` array of {path, oldText, newText}. Nothing was applied.'
      );
    }
    const staged = new Map<string, string>();
    const problems: string[] = [];
    for (const one of patches) {
      const path = text(one?.path);
      const oldText = text(one?.oldText);
      const moving = one?.moveAfter !== undefined && one?.moveAfter !== null;
      const before = staged.get(path) ?? this.files.get(path);
      if (before === undefined) {
        problems.push(
          `${path} could not be read. Check the path with files_list before patching it.`
        );
        continue;
      }
      if (!path || !oldText) {
        problems.push('Every patch requires a path and non-empty oldText.');
        continue;
      }
      if (moving && one?.newText !== undefined) {
        problems.push(
          'A patch carries newText or moveAfter, never both. Move the text in one patch and rewrite it in another.'
        );
        continue;
      }
      if (!moving && one?.newText === undefined) {
        problems.push(
          'Every patch requires newText to replace oldText, an empty newText to delete it, or moveAfter to move it'
        );
        continue;
      }
      if (countOccurrences(before, oldText) !== 1) {
        problems.push(patchFailure(path, before, oldText).reason);
        continue;
      }
      if (!moving) {
        staged.set(path, before.replace(oldText, text(one?.newText)));
        continue;
      }
      const after = before.replace(oldText, '');
      const moveAfter = text(one?.moveAfter);
      if (moveAfter && countOccurrences(after, moveAfter) !== 1) {
        const found = patchFailure(path, after, moveAfter);
        problems.push(
          found.occurrences > 1
            ? `moveAfter appears ${found.occurrences} times in ${path} once oldText is cut out of it, so there is nowhere unambiguous to put it. Extend moveAfter with enough surrounding lines to make it unique.`
            : `moveAfter is not in ${path} once oldText is cut out of it, so there is nowhere to put it. Quote it exactly as the file reads now - or send an empty moveAfter to move the text to the top of the file.`
        );
        continue;
      }
      staged.set(path, moveAfter ? after.replace(moveAfter, moveAfter + oldText) : oldText + after);
    }
    if (!staged.size) {
      this.note(false, 'file_patch', 'no_unique_match');
      return ok(problems.join(' ') || 'No patch could be applied.');
    }
    for (const [path, after] of staged) this.files.set(path, after);
    this.note(true, 'file_patch');
    return ok(
      `Patched ${[...staged.keys()].join(', ')}.${problems.length ? ` ${problems.length} patch(es) did not apply: ${problems.join(' ')}` : ''}`
    );
  }

  /**
   * The candidate, which is `applyEdit` and the snapshot ledger and nothing this file wrote.
   *
   * Atomic per file, the way `workspace.ts` is atomic per file, and the write is re-recorded as
   * seen afterwards so a second edit in the same turn can address the numbers the first one
   * returned. Dropping that re-record would make the format one edit deep per file and would show
   * up in the table as a refusal rate the model did not cause.
   */
  private lineEdit(raw: unknown): OracleResult {
    const patches = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    if (!patches.length) {
      this.note(false, 'file_patch', 'no_patches');
      return ok(
        'file_patch takes a `patches` array of {path, edit}, where edit addresses the line numbers file_read returned. Nothing was applied.'
      );
    }
    const staged = new Map<string, { text: string; changed: LineChange[] }>();
    const problems: string[] = [];
    const notes: string[] = [];
    let anchored = false;
    for (const one of patches) {
      const path = text(one.path);
      const edit = text(one.edit);
      const before = staged.get(path)?.text ?? this.files.get(path);
      if (before === undefined) {
        problems.push(
          `${path} could not be read. Check the path with files_list before patching it.`
        );
        continue;
      }
      if (!path || !edit) {
        problems.push('Every patch requires a path and a non-empty edit.');
        continue;
      }
      // Read off the parser rather than off the notes: an anchor that holds at its line leaves no
      // note at all, and that silent case is the one the anchor-present rate is mostly made of.
      const parsed = parseEdit(edit);
      if (parsed.ok && parsed.ops.some((op) => 'anchor' in op && op.anchor !== undefined))
        anchored = true;
      const result = applyEdit(path, edit, before, readsOf(this.taskId, path));
      if (!result.ok) {
        problems.push(`${result.refusal.kind}: ${result.refusal.message}`);
        continue;
      }
      notes.push(...result.notes);
      staged.set(path, { text: result.text, changed: [...result.changed] });
    }
    if (!staged.size) {
      const kind = /^([a-z_]+):/.exec(problems[0] ?? '')?.[1] ?? 'refused';
      this.note(false, 'file_patch', kind, [], anchored);
      return ok(problems.join('\n\n') || 'No patch could be applied.');
    }
    let echoMiss = false;
    for (const [path, after] of staged) {
      this.files.set(path, after.text);
      recordWrite(this.taskId, path, after.text, after.changed);
      const wanted = this.wanted.get(path);
      if (anchored && wanted !== undefined && after.text !== wanted) echoMiss = true;
    }
    this.note(true, 'file_patch', undefined, notes, anchored, echoMiss);
    return ok(
      `Patched ${[...staged.keys()].join(', ')}.${notes.length ? `\n${notes.join('\n')}` : ''}${
        problems.length ? ` ${problems.length} patch(es) did not apply: ${problems.join(' ')}` : ''
      }`
    );
  }

  /**
   * The four shell verbs the general world answers, plus `mv`.
   *
   * `mv` is here because a rename is a row neither editor can express - the worker's runner client
   * has no rename route, so the shipped dialect declares none and the quoted one never could - and
   * a world that could not perform one would have deleted a tie from the sample and called the
   * deletion a result.
   */
  private shell(command: string): string {
    const trimmed = command
      .replace(/^bash\s+-lc\s+/, '')
      .replace(/^['"]|['"]$/g, '')
      .trim();
    const move = /^mv\s+(\S+)\s+(\S+)$/.exec(trimmed);
    if (move) {
      const from = move[1] as string;
      const to = move[2] as string;
      const body = this.files.get(from);
      if (body === undefined) return `mv: ${from}: No such file or directory`;
      this.files.delete(from);
      forgetPath(this.taskId, from);
      this.files.set(to, body);
      return '';
    }
    if (/^ls\b/.test(trimmed) || /^find\b/.test(trimmed)) return this.paths().join('\n');
    const cat = /^cat\s+(\S+)$/.exec(trimmed);
    if (cat) {
      const body = this.files.get(cat[1] as string);
      return body ?? `cat: ${cat[1]}: No such file or directory`;
    }
    const grep = /^grep\s+(?:-\w+\s+)*['"]?([^'"]+?)['"]?(\s+\S+)?$/.exec(trimmed);
    if (grep) return this.grep(grep[1] as string).join('\n');
    return `athanor-eval: this rig's shell understands ls, cat, grep, find and mv over the workspace, and was given: ${trimmed}`;
  }

  answer(name: string, args: Record<string, unknown>): OracleResult {
    switch (name) {
      case 'finish':
        return { content: 'Turn ended.', terminal: true };
      case 'set_plan':
      case 'set_acceptance':
        return ok('Recorded.');
      case 'shell':
        return ok(this.shell(text(args.command)));
      case 'files_list':
      case 'repo_overview':
        return ok(this.paths().join('\n'));
      case 'file_read':
      case 'document_read':
        return ok(this.read(text(args.path) || text(args.documentId)));
      case 'file_write': {
        // A whole-file rewrite is a real way to make this edit and both arms hold it. Scoring is
        // on the file afterwards, so an arm that reaches for it is neither rewarded nor punished
        // for the choice - which is the only treatment that does not decide the result in advance.
        const path = text(args.path);
        this.files.set(path, text(args.content));
        if (this.dialect === 'lines') recordWrite(this.taskId, path, text(args.content));
        return ok(`Wrote ${path}.`);
      }
      case 'file_patch': {
        const patches = args.patches ?? args;
        return this.dialect === 'patch' ? this.quotedPatch(patches) : this.lineEdit(patches);
      }
      case 'code_search':
      case 'session_search':
      case 'document_search': {
        const hits = this.grep(text(args.query) || text(args.pattern));
        return ok(hits.length ? hits.join('\n') : 'No matches.');
      }
      case 'web_search':
        return ok('This rig has no network. Work from what is on the computer.');
      default:
        return ok(
          `athanor-eval: ${name} is not modelled by this rig. Reach the same fact another way, or finish with what you have.`
        );
    }
  }
}

/**
 * Whether the turn left the file the way the task asked for.
 *
 * Byte-exact, because the request quotes the wanted lines verbatim and there is nothing to guess.
 * `nearly` is the same comparison with trailing whitespace normalised the way the format's own
 * `normaliseLine` does, and it exists so a run can tell "the model cannot spell the dialect" from
 * "the model added a trailing space", which are different findings and would otherwise print the
 * same.
 */
export const scoreEdit = (
  world: EditWorld,
  task: EditArmTask
): { readonly correct: boolean; readonly nearly: boolean } => {
  const wantedPath = task.renamedTo ?? task.path;
  const after = world.textAt(wantedPath);
  if (after === null) return { correct: false, nearly: false };
  if (task.renamedTo && world.textAt(task.path) !== null) return { correct: false, nearly: false };
  const detrail = (value: string): string =>
    value
      .split('\n')
      .map((line) => line.replace(/[ \t\r]+$/, ''))
      .join('\n');
  return {
    correct: after === task.wanted,
    nearly: detrail(after) === detrail(task.wanted)
  };
};

/* ------------------------------------------------------------------------------- the live run */

/**
 * A row of the live edit table.
 *
 * `correct` is the only success column, and it is the file afterwards rather than the tool's own
 * word for what it did. A format that applies something confidently and gets it wrong scores zero
 * here: "the tool returned success" is the claim under test, not the evidence for it.
 *
 * `editCalls`, `editApplied`, `editForgiven` and `unrecovered` are the deny-list question stated
 * in numbers, and the last of them is the one the ship criterion is written against. They are
 * counted per call rather than inferred from whether the row ended up correct, because a row can
 * be correct after two refusals and wrong after none.
 */
export interface EditRow extends RunRow {
  readonly correct: boolean;
  readonly nearly: boolean;
  readonly editCalls: number;
  readonly editApplied: number;
  readonly editForgiven: number;
  readonly unrecovered: number;
  /** Edit calls that carried a `-` row anchor. The rate at which a model writes the taught form. */
  readonly anchorPresent: number;
  /** Applied calls where the anchor corrected a miscounted number. */
  readonly corrected: number;
  /** Calls refused because the anchor was ambiguous or absent - the `evidence` kind. */
  readonly refusedAmbiguous: number;
  /** Anchored calls that applied and still left the file other than the task asked. */
  readonly echoMiss: number;
  /** Calls where a display prefix was taken off a row. */
  readonly prefixStripped: number;
  readonly refusals: readonly EditRefusal[];
}

/**
 * The fewest round trips a correct row can take: read the file, edit it, finish.
 *
 * The floor of the cost estimate, and a floor rather than an expectation on purpose. A model that
 * has to retry a refused edit pays a fourth, which is the thing being measured; quoting an
 * expectation here would be quoting the answer before the run.
 */
export const MIN_CALLS_PER_EDIT = 3;

export const runEditOne = async (
  apiKey: string,
  model: string,
  armId: string,
  task: EditArmTask,
  seed: number,
  transport: Transport = openRouterTransport
): Promise<EditRow> => {
  const world = new EditWorld(settingsFor(armId).edit);
  // `runOne` resets the world before the first call, so what the task wants is handed over
  // through a hook the reset does not clear rather than set once here and lost.
  const wanting = world.reset.bind(world);
  world.reset = (): void => {
    wanting();
    world.expect(task.renamedTo ?? task.path, task.wanted);
  };
  const row = await runOne(apiKey, model, armId, task, seed, {}, world, transport);
  const score = scoreEdit(world, task);
  return {
    ...row,
    correct: score.correct && !row.error,
    nearly: score.nearly && !row.error,
    editCalls: world.editCalls,
    editApplied: world.editApplied,
    editForgiven: world.editForgiven,
    unrecovered: world.unrecovered,
    anchorPresent: world.anchorPresent,
    corrected: world.corrected,
    refusedAmbiguous: world.refusedAmbiguous,
    echoMiss: world.echoMiss,
    prefixStripped: world.prefixStripped,
    refusals: world.refusals
  };
};

export const runEditLive = async (
  apiKey: string,
  armIds: readonly string[],
  tasks: readonly EditArmTask[],
  tiers: readonly string[],
  seeds: number,
  onRow: (row: EditRow) => void = () => {},
  transport: Transport = openRouterTransport
): Promise<readonly EditRow[]> => {
  const rows: EditRow[] = [];
  for (const tier of tiers)
    for (const armId of armIds)
      for (const task of tasks)
        for (let seed = 0; seed < seeds; seed += 1) {
          const row = await runEditOne(apiKey, tier, armId, task, seed, transport);
          rows.push(row);
          onRow(row);
        }
  return rows;
};

/**
 * The offline character bound, over this sample, through both encoders.
 *
 * It is what the dialect costs a model that spells it correctly every time, which is the whole
 * reason the live half exists: the bound has been quoted in four documents and no model has ever
 * been asked to earn it. Printed as a bound, never as a saving.
 */
export interface BoundRow {
  readonly id: string;
  readonly quoted: number;
  readonly lineAddressed: number;
}

export const characterBound = (): readonly BoundRow[] =>
  EDIT_TASKS.map((task) => {
    const corpus = CORPUS.find((one) => one.id === task.corpusId) as EditTask;
    const read = fileText(corpus.path);
    return {
      id: task.corpusId,
      quoted: emittedChars(encodeIncumbent(corpus, read)),
      lineAddressed: emittedChars(encodeCandidate(corpus))
    };
  });

/** Plain against numbered, one whole-file read per row of the sample. The surcharge is INPUT. */
export const readSurcharge = (): { readonly plain: number; readonly numbered: number } => {
  let plain = 0;
  let numbered = 0;
  for (const path of new Set(EDIT_TASKS.map((task) => task.path))) {
    const body = fileText(path);
    plain += body.length;
    numbered += renderNumbered(toLines(body), 1).length;
  }
  return { plain, numbered };
};
