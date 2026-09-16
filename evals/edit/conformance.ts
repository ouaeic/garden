/**
 * Every way a model can get the line-addressed edit format wrong, and what each way COSTS.
 *
 * ── Why cost and not pass/fail ─────────────────────────────────────────────────────────────────
 *
 * The format shipped on the argument that its measured saving survives an imperfect model: the
 * harness forgives what it can recognise, and refuses the rest with the file's real text inside the
 * refusal, so a malformed emission is re-emitted rather than re-derived from a second read. That is
 * a claim about PRICE, not about correctness, and "the applier returned an error" says nothing
 * about it. So every case here is scored in the currency the ship decision is priced in:
 *
 *   0  the edit landed and the file is byte-identical to what the model asked for. Nothing extra.
 *   1  refused, and the refusal is SELF-SUFFICIENT: the model's very next call can be the corrected
 *      patch. One extra generation, no extra tool call, and nothing new in the window.
 *   2  refused, and the model has to read the file again before it can retry. One extra generation
 *      AND one extra tool call, and the read puts the whole region back into the window - which is
 *      the failure the incumbent's `oldText` misses were made of and the whole reason this format
 *      exists.
 *   X  the tool reported success and the bytes on disk are not what the model asked for. This is
 *      not a round trip, it is a wrong file, and it is the only outcome that cannot be priced.
 *
 *   X-echo  the same, EXCEPT that the result's `wrote` echo displays the lines that came out wrong,
 *      so a model reading its own tool result sees the damage on the turn it did it. Still wrong
 *      bytes; still counted as a defect; separated because the recovery is one more edit rather
 *      than a test failure a week later, and pretending those are the same thing would be dishonest
 *      in the direction that flatters the format.
 *
 * ── Why "self-sufficient" is decided by a program and not by reading the message ────────────────
 *
 * "The refusal is actionable" is exactly the kind of claim a lane grades itself on and passes. So
 * it is mechanical here, and each case declares which of the two tests it must satisfy BEFORE the
 * run - `content` for a fault about what is in the file, `shape` for a fault about how the patch is
 * spelt:
 *
 *   content - the message must quote the live file back under its real line numbers, at least three
 *             consecutive rows of it (or the whole file, when the file is shorter than that), and
 *             every quoted row must match the file as it actually reads. One number is a coincidence;
 *             three consecutive correct rows is a window.
 *   shape   - the message must name a legal spelling or the argument the model must change, so the
 *             model can fix the patch out of what it already has.
 *
 * The same two tests are applied to the incumbent in `incumbent.ts`, with only the shape vocabulary
 * changed, so neither format is graded on a scale written for it.
 *
 * ── What this corpus is NOT ────────────────────────────────────────────────────────────────────
 *
 * It runs no model. Every emission here is one a model plausibly produces - a dropped marker, a
 * unified diff, an anchor counted off a header - but the RATE at which models produce them is not
 * measured anywhere in athanor and is not measured here. This bounds the cost of each failure; it
 * does not weight them.
 */
import { applyEdit } from '../../apps/worker/src/edit/apply.js';
import { normaliseLine, toLines } from '../../apps/worker/src/edit/format.js';
import { boundRepeatedRefusal, forgetRefusals } from '../../apps/worker/src/edit/refusals.js';
import {
  forgetReads,
  readsOf,
  recordRead,
  recordWrite
} from '../../apps/worker/src/edit/snapshots.js';
import { fileText } from './corpus.js';

/* ------------------------------------------------------------------------------- the currency */

/** `X` is a wrong file; `X-echo` is a wrong file the tool result displays on the same turn. */
export type Cost = 0 | 1 | 2 | 'X' | 'X-echo';

export const isDefect = (cost: Cost): boolean => cost === 'X' || cost === 'X-echo';

/** Round trips, for arithmetic. A wrong file is not a round trip and is counted separately. */
export const roundTrips = (cost: Cost): number => (typeof cost === 'number' ? cost : 0);

/* --------------------------------------------------------------------------------- the tests */

/**
 * Line numbers the message quotes back that the live file really reads that way.
 *
 * Both spellings are accepted - `N:TEXT`, which this format's refusals use, and `N| TEXT`, which
 * the incumbent's explainer uses - because the same function has to price both formats or the
 * comparison is graded on a scale written for one of them.
 */
export const quotedRows = (message: string, live: readonly string[]): number[] => {
  const found: number[] = [];
  for (const row of message.split('\n')) {
    // `[\s\S]` rather than `.`, because `.` does not match a carriage return and every row of a
    // window quoted out of a CRLF file ends in one - which made this scorer report that the
    // incumbent's refusal carried no file text at all on exactly the file where it does.
    const match = /^\s*(\d+)(?::|\| ?)([\s\S]*)$/.exec(row);
    if (!match) continue;
    const number = Number(match[1]);
    const actual = live[number - 1];
    if (actual === undefined) continue;
    if (normaliseLine(actual) === normaliseLine(match[2] as string)) found.push(number);
  }
  return found;
};

/** Three consecutive true rows, or the whole file when the file is shorter than three lines. */
export const carriesLiveText = (message: string, live: readonly string[]): boolean => {
  const rows = quotedRows(message, live);
  const wanted = Math.min(3, live.length);
  if (rows.length < wanted) return false;
  let run = 1;
  for (let index = 1; index < rows.length; index += 1) {
    run = (rows[index] as number) === (rows[index - 1] as number) + 1 ? run + 1 : 1;
    if (run >= wanted) return true;
  }
  return wanted <= 1;
};

/** The message names a legal spelling of this dialect, or the rule the offending row broke. */
export const namesAShape = (message: string): boolean =>
  /PUT\s*[<>N\d]|CUT\s*[N\d]|Body rows begin with \+|Use shell/.test(message);

/* --------------------------------------------------------------------------------- the cases */

export type Group =
  | 'anchor'
  | 'anchored'
  | 'header'
  | 'body'
  | 'whitespace'
  | 'register'
  | 'encoding'
  | 'scale'
  | 'dialect';

export interface ConformanceCase {
  readonly id: string;
  readonly group: Group;
  /** What the model did, in the words a reader of the table needs. */
  readonly what: string;
  readonly path?: string;
  /** The file, when it is not one of the corpus files. */
  readonly file?: string;
  /** The windows a read displayed, oldest first. Absent means one whole-file read. */
  readonly reads?: ReadonlyArray<{ readonly from: number; readonly to: number }>;
  /** No read at all - a cold snapshot store, or an anchor invented from nothing. */
  readonly noRead?: boolean;
  /** What another writer did to the file between the read and the edit. */
  readonly drift?: (text: string) => string;
  /** Exactly what the model emitted, byte for byte. */
  readonly edit: string;
  /**
   * A second patch, sent after the first one landed and was recorded, addressed in the numbers the
   * first one left. `want.after` describes the file after BOTH.
   */
  readonly then?: string;
  /**
   * The same emission sent again after its refusal, byte for byte, through the repeated-patch
   * bound the arm applies. The row scores the SECOND refusal, which must differ from the first
   * and match this pattern - the fix, or the whole-file way out - or it costs a read.
   */
  readonly retry?: RegExp;
  /**
   * What a forgiving harness must do, declared before the run.
   *
   * `apply` carries the file the model asked for, computed here and never by the applier, and may
   * name a note the result has to carry. `refuse` carries which of the two message tests the
   * refusal has to pass.
   */
  readonly want:
    | { readonly kind: 'apply'; readonly after: (live: string) => string; readonly note?: RegExp }
    | { readonly kind: 'refuse'; readonly fixableFrom: 'content' | 'shape' };
  /** Where this lane disagrees with what the applier does. Printed beside the row. */
  readonly finding?: string;
}

export interface ConformanceRow {
  readonly id: string;
  readonly group: Group;
  readonly what: string;
  readonly cost: Cost;
  /**
   * What happened, against what a forgiving harness had to do.
   *
   * `over-refused` is its own verdict and it is the one this lane exists to count: the harness
   * refused an emission it had the evidence to recover, so the round trip is real and avoidable.
   * A cost of 1 on an over-refusal is still a cost of 1 that nobody had to pay.
   */
  readonly verdict: 'landed' | 'landed-silent' | 'refused' | 'over-refused' | 'landed-wrong';
  /** The refusal kind, or the notes the applier reported on a landing. */
  readonly detail: string;
  readonly finding?: string;
}

/** Replace one-based lines `from..to` with `lines`, which is how every expectation is written. */
const splice = (text: string, from: number, to: number, lines: readonly string[]): string => {
  const out = toLines(text);
  out.splice(from - 1, to - from + 1, ...lines);
  return out.join('\n');
};

const QUEUE = 'src/queue.ts';
const YAML = 'infra/services.yml';

const SMALL = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].join('\n');
/** Fifty thousand lines, so the applier is asked to do this at a size a real repository reaches. */
const HUGE = Array.from({ length: 50_000 }, (_, index) => `line ${index + 1} of the file`).join(
  '\n'
);

export const CASES: readonly ConformanceCase[] = [
  /* ------------------------------------------------------------------------- anchor errors */
  {
    id: 'anchor-off-by-one-unique-evidence',
    group: 'anchor',
    what: 'anchor one line late, quoting a line that occurs once in the file',
    edit: "PUT 15:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchor-off-by-one-repeated-evidence',
    group: 'anchor',
    what: 'anchor one line late, and TWO identical `return null;` lines inside the correction window',
    edit: 'PUT 12:\n-    return null;\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'THIS CASE EXPECTED THE WRONG ANSWER, and its own finding said why in a sentence that is not true. It read: "Searching the three lines the correction radius already allows would resolve it: within that window the text occurs once." Measured on the corpus file: `return null;` stands at lines 8, 11, 15, 24 and 27, and the window `placeWithEvidence` actually searches for `PUT 12` is lines 9 to 15 - which holds TWO of them, 11 and 15, both within the radius. There is no unambiguous answer to pick, and picking the nearer one would be the guess the applier says by name is the one failure that corrupts code rather than wasting a round trip. The window search the finding asked for was implemented, and the case kept failing because the case was wrong, not the code. `anchor-off-by-one-repeated-resolvable` below is the case that actually exercises it'
  },
  {
    /*
     * What the window is FOR, which the case above was mistaken for.
     *
     * Five identical `return null;` lines in the file, so a whole-file uniqueness search refuses.
     * Exactly one of them inside the window this anchor is allowed to reach, so the correction is
     * not a guess: it is the only reading the radius admits.
     */
    id: 'anchor-off-by-one-repeated-resolvable',
    group: 'anchor',
    what: 'anchor one line late on a repetitive file, with ONE match inside the correction window',
    edit: 'PUT 16:\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 15, 15, ['    return undefined;']) }
  },
  {
    id: 'anchor-off-by-one-backwards',
    group: 'anchor',
    what: 'anchor one line early, quoting a unique line',
    edit: "PUT 13:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchor-off-by-one-no-evidence',
    group: 'anchor',
    what: 'a valid but unintended line address without an anchor must not write',
    edit: 'PUT 12:\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-off-by-three-with-evidence',
    group: 'anchor',
    what: 'anchor three lines out - the far edge of what is corrected',
    edit: "PUT 17:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchor-off-by-many-with-evidence',
    group: 'anchor',
    what: 'anchor nine lines from the text it quoted',
    edit: "PUT 23:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-past-eof',
    group: 'anchor',
    what: 'PUT 900: on a 57-line file',
    edit: 'PUT 900:\n+  return job.payload ?? undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-zero',
    group: 'anchor',
    what: 'PUT 0: - counted from zero, the way an array is',
    edit: 'PUT 0:\n+// header',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-negative',
    group: 'anchor',
    what: 'PUT -3: - a negative line number',
    edit: 'PUT -3:\n+// header',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'anchor-reversed-range',
    group: 'anchor',
    what: 'PUT 12.=10: - the range written back to front',
    edit: 'PUT 12.=10:\n-  if (!job.ready) {\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, ['    return undefined;']) }
  },
  {
    id: 'anchor-overlapping-ranges',
    group: 'anchor',
    what: 'two operations in one patch covering the same lines',
    edit: 'PUT 10.=12:\n+    return undefined;\nPUT 12.=13:\n+  if (job.expiresAt < Date.now()) {',
    want: { kind: 'refuse', fixableFrom: 'shape' },
    finding:
      'the right refusal, and it names the merged spelling `PUT a.=b:` for the two ranges it saw, so the retry is a re-emit: "write one operation covering both" on its own is advice a person acts on and a mechanical test cannot separate from "read the file again"'
  },
  {
    id: 'anchor-outside-the-window',
    group: 'anchor',
    what: 'a window read of lines 1-20, then an edit at 44',
    reads: [{ from: 1, to: 20 }],
    edit: 'PUT 44:\n+export const readyCount = (queue: Job[]): number | undefined => {',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-window-counted-from-one',
    group: 'anchor',
    what: 'a window read of lines 20-30, and the model counts inside the window instead of the file',
    reads: [{ from: 20, to: 30 }],
    edit: 'PUT 3:\n+  const job = queue.at(0);',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-never-read',
    group: 'anchor',
    what: 'an edit to a file no read of this task has shown',
    noRead: true,
    edit: 'PUT 11:\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'shape' },
    finding:
      'the only refusal in the corpus that carries NO text of the file - the store has no record, so it has nothing to quote. It names the file’s length and says to read it, which is a genuine second round trip and the price of a cold cache'
  },
  {
    id: 'anchor-evicted-by-five-reads',
    group: 'anchor',
    what: 'five reads of one file, then an edit against the numbers of the first',
    reads: [
      { from: 1, to: 10 },
      { from: 11, to: 20 },
      { from: 21, to: 30 },
      { from: 31, to: 40 },
      { from: 41, to: 50 }
    ],
    edit: 'PUT 5:\n+export const drain = (queue: Job[]): Payload | undefined => {',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  /*
   * THE TWO RELOCATION CASES BELOW ARE A PAIR AND ONLY MEAN ANYTHING TOGETHER.
   *
   * `placeRange` has a recovery nothing else in this corpus reaches: when the addressed lines no
   * longer hold the text the read recorded, it looks for that text elsewhere in the live file and
   * follows it. The recovery is guarded by `hits.length !== 1`, because text that now stands in two
   * places has no unambiguous home and picking one writes into a region the model never saw.
   *
   * Every case here drove the guard in one direction only. `scale-fifty-thousand-lines-shifted`
   * relocates uniquely and lands, so it passes whether the guard counts matches or not; nothing
   * made the recorded text ambiguous. Relaxing `!== 1` to `< 1` therefore changed no row of this
   * rig, and the applier silently wrote into the FIRST of two matches while reporting a note that
   * said it had followed the text.
   *
   * The pair fixes that. Both cases apply the identical drift - two lines prepended, so the numbers
   * shift by two and the direct match fails in both. The only difference is the addressed range.
   * 10-12 is the `if (!job.ready) { return null; }` stanza, which `src/queue.ts` also holds at
   * 26-28, so after the shift it stands twice: refuse. 13-15 holds the one `logger.warn` line and
   * stands once: land, and report the shift. A change that breaks the guard fails the first; a
   * change that makes it refuse ordinary drift fails the second.
   */
  {
    id: 'anchor-relocation-ambiguous',
    group: 'anchor',
    what: 'the file shifted under the read and the recorded lines now stand in two places',
    drift: (text) => `// added\n// by somebody else\n${text}`,
    edit: 'PUT 10.=12:\n+  if (job.ready === false) {',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-relocation-unique',
    group: 'anchor',
    what: 'the same shift, where the recorded lines still stand in exactly one place',
    drift: (text) => `// added\n// by somebody else\n${text}`,
    edit: 'PUT 13.=15:\n-  if (job.expiresAt < Date.now()) {\n+  if (job.expiresAt < Date.now()) {',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 15, 17, ['  if (job.expiresAt < Date.now()) {'])
    }
  },

  /* --------------------------------------------------------------- the content anchor */
  /*
   * THE TAUGHT FORM. One `-` row first, quoting the start of the first addressed line; a prefix of
   * eight non-space characters is enough. It closes the format's one hole - the off-by-one with
   * nothing in the patch saying what the model believed was at the line - and every row here
   * prices one way of writing it, or one way of attacking the recovery it enables. The attack rows
   * are the ones that matter: each is a patch whose anchor could be made to land somewhere the
   * patch did not name, and each must be refused with nothing written.
   */
  {
    id: 'anchored-at-n',
    group: 'anchored',
    what: 'the anchor holds at the addressed line',
    edit: "PUT 14:\n-    logger.warn('job expired'\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchored-off-by-one',
    group: 'anchored',
    what: 'the anchor is one line from the number',
    edit: "PUT 15:\n-    logger.warn('job expired'\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchored-off-by-five',
    group: 'anchored',
    what: 'the anchor is five lines from the number - the outer ring',
    edit: "PUT 19:\n-    logger.warn('job expired'\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchored-prefix-eight-chars',
    group: 'anchored',
    what: 'an anchor of exactly eight non-space characters',
    edit: "PUT 15:\n-    logger.w\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchored-weak-brace-neighbour-resolves',
    group: 'anchored',
    what: 'a lone brace as anchor, one line out, whose neighbours read as recorded',
    file: 'function a() {\n  x();\n}\n\n// a\n// b\n// c\nfunction b() {\n  y();\n}\n',
    edit: 'PUT 4:\n-}\n+}  // end a',
    want: { kind: 'apply', after: (live) => splice(live, 3, 3, ['}  // end a']) }
  },
  {
    id: 'anchored-leaked-prefix-same-number',
    group: 'anchored',
    what: 'the anchor row copied with its display number, `-11:    return null;`',
    edit: 'PUT 11:\n-11:    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) }
  },
  {
    id: 'anchored-curly-quotes',
    group: 'anchored',
    what: 'the anchor came back through a surface that curled its quotes',
    edit: "PUT 14:\n-    logger.warn(‘job expired’\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchored-crlf-patch',
    group: 'anchored',
    what: 'every row of the patch ends CRLF',
    edit: 'PUT 11:\r\n-    return null;\r\n+    return undefined;\r\n',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) }
  },
  {
    id: 'anchored-on-cut',
    group: 'anchored',
    what: 'a CUT with an anchor on its first line',
    edit: 'CUT 13.=15\n-  if (job.expiresAt',
    want: { kind: 'apply', after: (live) => splice(live, 13, 15, []) }
  },
  {
    id: 'anchored-on-insert',
    group: 'anchored',
    what: 'an insert before line N, anchored on line N',
    edit: 'PUT <13:\n-  if (job.expiresAt\n+  // expiry',
    want: {
      kind: 'apply',
      after: (live) => {
        const out = toLines(live);
        out.splice(12, 0, '  // expiry');
        return out.join('\n');
      }
    }
  },
  {
    id: 'anchored-on-insert-after',
    group: 'anchored',
    what: 'an insert after line N, anchored on line N',
    edit: 'PUT >13:\n-  if (job.expiresAt\n+    // expiry',
    want: {
      kind: 'apply',
      after: (live) => {
        const out = toLines(live);
        out.splice(13, 0, '    // expiry');
        return out.join('\n');
      }
    }
  },
  {
    id: 'anchored-on-block',
    group: 'anchored',
    what: 'a block replacement anchored on its opening line',
    edit: 'PUT 21*:\n-export const peek\n+export const peek = (queue: Job[]): Payload | null => queue[0]?.payload ?? null;',
    want: {
      kind: 'apply',
      after: (live) =>
        splice(live, 21, 30, [
          'export const peek = (queue: Job[]): Payload | null => queue[0]?.payload ?? null;'
        ])
    }
  },
  {
    /*
     * The two-patch turn, which is where a line-addressed dialect is one edit deep unless the
     * ledger moves with the file. The first patch adds two lines at the top of `drain`; the second
     * addresses the `logger.warn` line at its NEW number, 16, with an anchor, and no read between.
     * The ledger has moved by the same +2 the first result reported, so nothing is corrected.
     */
    id: 'anchored-renumbered-after-own-patch',
    group: 'anchored',
    what: 'a second patch addressed in the numbering the first one reported, with no read between',
    edit: 'PUT <5:\n-export const drain = (queue: Job[]): Payload | null => {\n+// added\n+// added',
    then: "PUT 16:\n-    logger.warn('job expired'\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => {
        const out = toLines(live);
        out[13] = "    logger.error('job expired', { id: job.id });";
        out.splice(4, 0, '// added', '// added');
        return out.join('\n');
      }
    }
  },
  {
    id: 'anchored-body-identical-no-op',
    group: 'anchored',
    what: 'one operation whose body already reads that way, beside one that changes something',
    edit: "PUT 11:\n-    return null;\n+    return null;\nPUT 14:\n-    logger.warn\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"]),
      note: /11 already read that way/
    }
  },
  {
    id: 'anchored-file-shifted-under-read',
    group: 'anchored',
    what: 'two lines prepended since the read; the anchor quotes exactly the line the model read at 13',
    drift: (text) => `// added\n// by somebody else\n${text}`,
    edit: 'PUT 13.=15:\n-  if (job.expiresAt\n+  if (job.expiresAt < Date.now()) {',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 15, 17, ['  if (job.expiresAt < Date.now()) {'])
    }
  },
  {
    id: 'anchored-insert-after-shifted-weak-anchor',
    group: 'anchored',
    what: 'one line prepended since the read; an insert after a lone `  }`, anchored on it',
    drift: (text) => `// added\n${text}`,
    edit: 'PUT >12:\n-  }\n+  // ready',
    want: {
      kind: 'apply',
      after: (live) => {
        const out = toLines(live);
        out.splice(13, 0, '  // ready');
        return out.join('\n');
      }
    }
  },
  {
    id: 'anchored-same-prefix-line-inserted-above',
    group: 'anchored',
    what: 'a line starting the same way was inserted directly above the target since the read',
    drift: (text) => {
      const out = toLines(text);
      out.splice(13, 0, "    logger.warn('job nearly expired', { id: job.id });");
      return out.join('\n');
    },
    edit: "PUT 14:\n-    logger.warn('job expired'\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 15, 15, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchored-en-dash',
    group: 'anchored',
    what: 'the anchor came back with an en dash where the file has a hyphen; the body has one too, and it lands as sent',
    file: 'export const run = () => {\n  const label = "a - b";\n  return label;\n};\n',
    edit: 'PUT 2:\n-  const label = "a – b"\n+  const label = "a – b – c";',
    want: { kind: 'apply', after: (live) => splice(live, 2, 2, ['  const label = "a – b – c";']) }
  },
  {
    id: 'anchored-no-break-space',
    group: 'anchored',
    what: 'the anchor came back with a no-break space where the file has a space; the body keeps its own',
    file: 'export const run = () => {\n  const label = "a - b";\n  return label;\n};\n',
    edit: 'PUT 2:\n-  const label = "a - b"\n+  const label = "a - b";',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 2, 2, ['  const label = "a\u00A0-\u00A0b";'])
    }
  },
  {
    id: 'body-row-leaked-prefix-same-number',
    group: 'body',
    what: 'body rows copied with their display numbers, each the number the row will stand at',
    edit: 'PUT 10.=12:\n-  if (!job.ready) {\n+10:  if (job.ready === false) {\n+11:    return null;\n+12:  }',
    want: {
      kind: 'apply',
      after: (live) =>
        splice(live, 10, 12, ['  if (job.ready === false) {', '    return null;', '  }'])
    }
  },
  {
    id: 'body-row-genuine-digit-colon-content',
    group: 'body',
    what: 'a schedule whose line 4 begins `4:` - the anchor and the body both begin `4:` and neither is a display prefix',
    file: '1:00 open\n2:00 standup\n3:00 review\n4:00 lunch\n5:00 close\n',
    edit: 'PUT 4:\n-4:00 lunch\n+4:15 lunch',
    want: { kind: 'apply', after: (live) => splice(live, 4, 4, ['4:15 lunch']) }
  },
  {
    id: 'body-row-genuine-digit-bar-grid',
    group: 'body',
    what: 'a grid whose rows begin `N|`, replaced with a row that begins the same way',
    file: '1|a|b\n2|c|d\n3|e|f\n',
    edit: 'PUT 2:\n-2|c|d\n+2|C|D',
    want: { kind: 'apply', after: (live) => splice(live, 2, 2, ['2|C|D']) }
  },
  {
    id: 'plain-range-requires-an-anchor',
    group: 'anchored',
    what: 'a plain range without a content anchor must be refused before writing',
    edit: 'PUT 11:\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchored-off-by-six-unique-elsewhere',
    group: 'anchored',
    what: 'the anchor is six lines from the number, past both rings, and unique in the file',
    edit: "PUT 20:\n-    logger.warn('job expired'\n+    logger.error('job expired', { id: job.id });",
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchored-two-candidates-in-window',
    group: 'anchored',
    what: 'the anchor starts two lines inside the ring, at distances one and two',
    edit: 'PUT 26:\n-    return null;\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchored-nowhere',
    group: 'anchored',
    what: 'an anchor that is nowhere in the file',
    edit: "PUT 14:\n-    logger.info('never')\n+    logger.error('job expired', { id: job.id });",
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchored-weak-brace-ambiguous',
    group: 'anchored',
    what: 'a lone brace as anchor with two candidates whose neighbours both read as recorded',
    edit: 'PUT 13:\n-  }\n+  } // end',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchored-leaked-prefix-other-number',
    group: 'anchored',
    what: 'the anchor row carries a display number that is not the addressed line',
    edit: 'PUT 11:\n-10:    return null;\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'retry-identical-after-refusal',
    group: 'anchored',
    what: 'the same refused patch sent again, byte for byte',
    edit: "PUT 14:\n-    logger.info('never')\n+    logger.error('job expired', { id: job.id });",
    retry: /The one change that fixes it: drop the - row/,
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'retry-identical-small-file-names-file_write',
    group: 'anchored',
    what: 'the same refused patch sent again, on a six-line file the model has seen all of',
    file: SMALL,
    edit: 'PUT 3:\n-nothing here at all\n+GAMMA',
    retry: /send the whole 6-line file with file_write/,
    want: { kind: 'refuse', fixableFrom: 'content' }
  },

  /* ------------------------------------------------------------------ the attack rows */
  {
    id: 'attack-anchor-matches-live-not-ledger',
    group: 'anchored',
    what: 'somebody wrote the anchor text onto line 13 after the read; PUT 14 with that anchor',
    drift: (text) => splice(text, 13, 13, ["    logger.error('never here', { id: job.id });"]),
    edit: "PUT 14:\n-    logger.error('never here'\n+    changed;",
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'THE INVARIANT. Line 13 carries the anchor in the live file and not in the ledger, so it is not a candidate whatever the file says now; the one line that starts that way is named as changed since the read, and nothing is written'
  },
  {
    id: 'attack-anchor-hit-outside-shown-window',
    group: 'anchored',
    what: 'a window read of 10-30, and an anchor whose only match is line 5',
    reads: [{ from: 10, to: 30 }],
    edit: 'PUT 12:\n-export const drain\n+export const drain = () => undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'attack-two-hits-nearest-not-chosen',
    group: 'anchored',
    what: 'two candidates in the ring at distances one and two; the nearer one is not taken',
    edit: 'PUT 10:\n-    return null;\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'attack-weak-anchor-neighbour-mismatch',
    group: 'anchored',
    what: 'a lone brace as anchor, one candidate in the ring, and the line beside it changed since the read',
    drift: (text) => splice(text, 15, 15, ['    return 0;']),
    edit: 'PUT 17:\n-  }\n+  } // end',
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'the one brace within reach, 16, carries the anchor in both records, and the line above it does not read as the ledger recorded it - a row this short cannot say which brace it is, so it counts only where its neighbours vouch for it, and nothing is written'
  },
  {
    id: 'attack-ledger-relocates-anchor-disagrees',
    group: 'anchored',
    what: 'three lines added at the top; the ledger follows 14 to 17, and the anchor quotes line 16',
    drift: (text) => `// one\n// two\n// three\n${text}`,
    edit: 'PUT 14:\n-  return job.payload;\n+  changed;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'attack-prefix-strip-cannot-move',
    group: 'anchored',
    what: 'an anchor row `-13:  if (job.expiresAt` under PUT 14 - the number is not the addressed line',
    edit: "PUT 14:\n-13:  if (job.expiresAt\n+    logger.error('job expired', { id: job.id });",
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'a prefix that disagrees with the addressed line is left byte for byte, so the row reads `13:  if (job.expiresAt` and is nowhere in the file; taken off, it would be the start of line 13 and would move the edit there'
  },
  {
    id: 'attack-cut-relocation-past-shown-end',
    group: 'anchored',
    what: 'a window read of 1-20, and a CUT whose anchor would shift it onto line 21',
    reads: [{ from: 1, to: 20 }],
    edit: 'CUT 19.=20\n-/** The next job',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'attack-weak-anchor-stale-neighbour-is-ambiguity',
    group: 'anchored',
    what: 'a lone brace as anchor; the brace meant has a changed neighbour, and a further brace has intact ones',
    file: 'function a() {\n  if (x) {\n    y();\n    z();\n  }\n  if (w) {\n    v();\n  }\n}\n',
    drift: (text) => splice(text, 4, 4, ['    z(1);']),
    edit: 'PUT 6:\n-  }\n+  } // end if x',
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'line 5 carries the brace in both records and its neighbour has changed; line 8 carries it with its neighbours intact and closes a different block. A row this short cannot tell them apart, so both are named and nothing is written - a stale neighbour is evidence the region moved, not evidence that the further brace is the one meant'
  },
  {
    id: 'attack-whole-quote-past-shown-end',
    group: 'anchored',
    what: 'a window read of 1-20, and two `-` rows quoting lines 20 and 21 under PUT 19.=20',
    reads: [{ from: 1, to: 20 }],
    edit: 'PUT 19.=20:\n-/** The next job without taking it, or nothing if the queue is empty. */\n-export const peek = (queue: Job[]): Payload | null => {\n+REPLACED',
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'the whole-quote path corrects a miscount by one, and the corrected range would end on line 21, which no read has shown; the ledger cannot vouch for it, so the refusal names the read and nothing is written'
  },
  {
    id: 'attack-whole-quote-matches-live-not-ledger',
    group: 'anchored',
    what: 'somebody rewrote line 17 after the read; two `-` rows quote lines 16-17 as they read NOW, under PUT 14.=15',
    drift: (text) => splice(text, 17, 17, ['  return cached;']),
    edit: 'PUT 14.=15:\n-  }\n-  return cached;\n+  return cached ?? job.payload;',
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'the quoted lines stand at 16-17 in the live file, two lines from the address, but the ledger recorded different text at 17 - the quote is of a line no read displayed, and a correction onto it would put bytes where nothing the model was shown had stood'
  },
  {
    id: 'attack-body-never-folded',
    group: 'anchored',
    what: 'curly quotes in the anchor fold to find the line; curly quotes in the body land verbatim',
    edit: 'PUT 14:\n-    logger.warn(‘job expired’\n+    logger.warn(“job expired”, { id: job.id });',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ['    logger.warn(“job expired”, { id: job.id });'])
    }
  },

  /* ------------------------------------------------------------------------- header errors */
  {
    id: 'header-from-another-dialect',
    group: 'header',
    what: 'a `[path#tag]` section header this format has no use for',
    edit: '[src/queue.ts#3f9a]\nPUT 11:\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) }
  },
  {
    id: 'header-names-another-file',
    group: 'header',
    what: 'a section header naming a DIFFERENT file from the one the call addresses',
    edit: '[src/somewhere-else.ts]\nPUT 11:\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) },
    finding:
      'the header is dropped and the edit lands in the path the JSON field names, which is the contract - but the note says only "dropped a [path] section header" and never echoes the path it dropped, so a model that believed the header chose the file gets no signal that it edited a different one'
  },
  {
    id: 'header-only',
    group: 'header',
    what: 'a header and nothing else - the operations did not survive generation',
    edit: '[src/queue.ts]',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'header-git-diff-preamble',
    group: 'header',
    what: 'a whole `git diff`, `diff --git` line and all',
    edit: 'diff --git a/src/queue.ts b/src/queue.ts\n--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -11 +11 @@\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) },
    finding:
      'THE LARGEST HOLE IN THE FORGIVENESS. A bare `@@` hunk is recovered; the same hunk with the `diff --git` and `---`/`+++` headers a model actually emits around it is refused, and the message never mentions the lines that caused it. Three more lines in the parser’s skip list closes it'
  },
  {
    id: 'header-unified-diff-file-rows',
    group: 'header',
    what: 'the `---`/`+++` rows without the `diff --git` line',
    edit: '--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -11 +11 @@\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) },
    finding:
      'refused as "a body row with no operation above it", because `--- a/...` begins with a minus - a message about bodies for a fault about headers'
  },

  /* --------------------------------------------------------------------------- body errors */
  {
    id: 'body-minus-rows-carried-over',
    group: 'body',
    what: '`-` rows from the unified diff the model was thinking in',
    edit: 'PUT 11:\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) }
  },
  {
    id: 'body-whole-hunk-with-context',
    group: 'body',
    what: 'a whole `@@` hunk, space-prefixed context rows included',
    edit: '@@ -10,3 +10,3 @@\n   if (!job.ready) {\n-    return null;\n+    return undefined;\n   }',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) }
  },
  {
    id: 'body-zero-context-hunk-insert',
    group: 'body',
    what: 'a zero-context insertion has no content anchor and must not write',
    edit: '@@ -11,0 +12,1 @@\n+    logger.debug({ id: job.id });',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'body-dropped-plus-marker',
    group: 'body',
    what: 'one body row whose `+` did not survive generation',
    edit: 'PUT 10.=12:\n+  if (!job.ready) {\n    return undefined;\n+  }',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  /*
   * THE CASE ABOVE DOES NOT TEST THE GUARD IT LOOKS LIKE IT TESTS, AND THIS ONE DOES.
   *
   * `parse.ts` refuses a space-prefixed body row in a body with no `-` rows, because the row is
   * either context or a `+` that was dropped and the two put different text in the file. Disabling
   * that refusal leaves the case above still refused - measured, `kind` goes from `parse` to
   * `evidence` - because its space row reads `   return undefined;`, text that is nowhere in the
   * file, so `placeWithEvidence` throws it out for an unrelated reason. The baseline records cost
   * and verdict, both of which stay where they were, so the row cannot see the guard go.
   *
   * Here the space row is `   if (!job.ready) {`, which after the marker is stripped is exactly
   * what line 10 holds. The evidence check is then satisfied and stops covering for the parser.
   * Measured with the guard disabled: `ok: true`, the 10-12 range collapses onto line 10 alone
   * because the one quoted line becomes the anchor evidence, the three body rows are spliced in
   * over it, and the file grows from 57 lines to 59 with `    return null;` and `  }` orphaned
   * below the replacement. The result carries a note reading "the quoted lines are what was
   * replaced", which is a false sentence about a file the tool has just corrupted while reporting
   * success.
   */
  {
    id: 'body-dropped-plus-that-matches-the-file',
    group: 'body',
    what: 'a dropped `+` on a row whose text really is what the addressed line holds',
    edit: 'PUT 10.=12:\n   if (!job.ready) {\n+    return undefined;\n+  }',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'body-unmarked-content',
    group: 'body',
    what: 'no markers at all - the new lines written straight under the range',
    edit: 'PUT 11:\n    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    /*
     * Watched live, three times in one turn from a cheap model: a body row that lost its `+` in the
     * MIDDLE of a body, with more `+` rows under it. It begins with none of `+ - space`, so it is
     * not the space-row ambiguity above - a row like this followed by another `+` row has exactly
     * one reading, a dropped marker, and taking it changes nothing about which lines are touched.
     * Refusing it costs a round trip that the next two rows show is not needed.
     */
    id: 'body-dropped-plus-mid-body-more-plus-rows-follow',
    group: 'body',
    what: 'a body row whose `+` was dropped, in the middle of the body, with `+` rows after it',
    edit: 'PUT >34:\n-  const found: Job[] = [];\n+\n+\ndef nth_prime(n):\n+    """Return the n-th prime."""',
    want: {
      kind: 'apply',
      after: (live) => {
        const out = toLines(live);
        out.splice(34, 0, '', '', 'def nth_prime(n):', '    """Return the n-th prime."""');
        return out.join('\n');
      },
      note: /dropped/
    }
  },
  {
    /*
     * The same unmarked row at the END of a body has a second reading - prose the model wrote after
     * the patch - and nothing in the patch chooses between them. Still refused, naming the row.
     */
    id: 'body-unmarked-trailing-prose',
    group: 'body',
    what: 'an unmarked row after the last `+` row - prose written after the patch',
    edit: 'PUT 11:\n+    return undefined;\nThat replaces the null return with undefined.',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    /*
     * An unmarked row in the middle of a body that IS an operation is the next operation, not a
     * body row: two PUTs written back to back with no blank row between them. The dropped-marker
     * reading must never swallow it, or the second edit would land as text inside the first.
     */
    id: 'body-unmarked-mid-row-is-the-next-operation',
    group: 'body',
    what: 'a second PUT directly under the first body, with `+` rows after it',
    edit: 'PUT 11:\n-    return null;\n+    return undefined;\nPUT 15:\n-    return null;\n+    return undefined;',
    want: {
      kind: 'apply',
      after: (live) =>
        splice(splice(live, 11, 11, ['    return undefined;']), 15, 15, ['    return undefined;'])
    }
  },
  {
    /*
     * The row above with the second operation misspelt. `PUT line 15:` is an operation the model
     * reached for and got wrong, and a body that swallowed it would land the words as text on
     * line 12, leave line 15 untouched and report success. Refused by name at that row instead.
     */
    id: 'body-unmarked-mid-row-is-a-malformed-operation',
    group: 'body',
    what: 'a second PUT directly under the first body, written with a word where the number goes',
    edit: 'PUT 11:\n+    return undefined;\nPUT line 15:\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    /*
     * Watched on the box, twice in one turn. The model put the body on the operation's own line -
     * `PUT 3:+from ivl.intervals import merge` - so the operation row did not parse and the next
     * real body row was then read as an operation. Two refusals from one habit, and neither of the
     * two `body-unmarked-*` rows above has it: those put the body on its own line and drop only the
     * marker.
     */
    id: 'body-on-the-operation-row',
    group: 'body',
    what: 'the body written after the colon on the operation row itself',
    edit: 'PUT 11:-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) },
    finding:
      'the text after the colon is read as the first body row, with a note saying where the body belongs. A refusal here is worse than one refusal: the next real body row is then read as an operation, so the one habit costs two in the same turn. Watched on the box twice in one turn'
  },
  {
    id: 'body-unmarked-content-that-reads-as-a-verb',
    group: 'body',
    what: 'an unmarked body row that happens to begin `delete `',
    edit: 'PUT 11:\ndelete job.payload;',
    want: { kind: 'refuse', fixableFrom: 'shape' },
    finding:
      'refused with "this tool edits inside a file and cannot delete one. Use shell for that." - a message about deleting FILES for a JavaScript statement that deletes a property. Still one round trip, and still the wrong sentence'
  },
  {
    id: 'body-blank-row-inside',
    group: 'body',
    what: 'a blank line in the new content emitted bare instead of as `+`',
    edit: 'PUT 10.=12:\n+  if (!job.ready) {\n\n+  }',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'body-empty-on-replace',
    group: 'body',
    what: 'a replace with no body at all',
    edit: 'PUT 10.=12:\n-  if (!job.ready) {',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, []) }
  },
  {
    id: 'body-carries-the-dialect',
    group: 'body',
    what: 'new content that is itself made of this format’s own operations',
    edit: 'PUT 11:\n-    return null;\n+// PUT 9: and CUT 1.=2 @x are not operations here\n+@@ -1 +1 @@',
    want: {
      kind: 'apply',
      after: (live) =>
        splice(live, 11, 11, ['// PUT 9: and CUT 1.=2 @x are not operations here', '@@ -1 +1 @@'])
    }
  },
  {
    id: 'body-plus-rows-under-a-cut',
    group: 'body',
    what: 'a CUT with `+` rows under it',
    edit: 'CUT 10.=12\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'body-minus-rows-under-an-insert',
    group: 'body',
    what: 'an insert with one `-` row under it, quoting the line it hangs off',
    edit: 'PUT >11:\n-    return null;\n+    logger.debug({ id: job.id });',
    want: {
      kind: 'apply',
      after: (live) => {
        const out = toLines(live);
        out.splice(11, 0, '    logger.debug({ id: job.id });');
        return out.join('\n');
      }
    },
    finding:
      'one `-` row under an insert is the anchor for line N, which is what the spec now teaches, so this lands after line 11. Two or more `-` rows under an insert are still the deletion nobody asked for, and still refused by name'
  },
  {
    id: 'body-evidence-does-not-match',
    group: 'body',
    what: 'a correct number whose `-` row the model typed from memory, without the semicolon',
    edit: 'PUT 11:\n-    return null\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) },
    finding:
      'the number was RIGHT and the row is a prefix of the line, which is all the spec asks of an anchor. Holding a `-` row to the whole line turns an edit that would have landed into a round trip, paid only by the model that volunteers evidence'
  },

  /* ---------------------------------------------------------------------------- whitespace */
  {
    id: 'ws-crlf-file',
    group: 'whitespace',
    what: 'every line of the file ends CRLF; the read displayed LF, and the new line must end CRLF too',
    drift: (text) => text.replace(/\n/g, '\r\n'),
    edit: 'PUT 11:\n-    return null;\n+    return undefined;',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 11, 11, ['    return undefined;\r'])
    }
  },
  {
    id: 'ws-crlf-file-anchored-two-rows',
    group: 'whitespace',
    what: 'a CRLF file, an anchored replacement of one line with two, and a file that does not end in a newline',
    file: 'alpha\r\nbeta\r\ngamma\r\ndelta',
    edit: 'PUT 2:\n-beta\n+BETA\n+beta and a half',
    want: { kind: 'apply', after: () => 'alpha\r\nBETA\r\nbeta and a half\r\ngamma\r\ndelta' }
  },
  {
    id: 'ws-crlf-file-edited-on-its-last-line',
    group: 'whitespace',
    what: 'a CRLF file with no trailing newline, replaced on its last line: the new last line gets no CR',
    file: 'alpha\r\nbeta\r\ngamma',
    edit: 'PUT 3:\n-gamma\n+GAMMA',
    want: { kind: 'apply', after: () => 'alpha\r\nbeta\r\nGAMMA' }
  },
  {
    id: 'ws-trailing-spaces',
    group: 'whitespace',
    what: 'the file carries trailing spaces the display could not show',
    drift: (text) =>
      toLines(text)
        .map((line) => (line ? `${line}  ` : line))
        .join('\n'),
    edit: 'PUT 11:\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) }
  },
  {
    id: 'ws-tabs-in-evidence',
    group: 'whitespace',
    what: 'the file is tab-indented and the `-` row was retyped with spaces',
    file: 'export const run = () => {\n\tconst value = 1;\n\treturn value;\n};\n',
    edit: 'PUT 2:\n-  const value = 1;\n+  const value = 2;',
    want: { kind: 'apply', after: (live) => splice(live, 2, 2, ['  const value = 2;']) },
    finding:
      'the anchor is compared with its leading whitespace folded, so a `-` row retyped with spaces finds the tab-indented line; the body is written exactly as sent, spaces and all, because leading whitespace is content everywhere but in a row whose only job is to say which line is meant. The model cannot SEE the difference, so a refusal here is one whose retry is likely the same emission'
  },
  {
    id: 'ws-no-trailing-newline',
    group: 'whitespace',
    what: 'a file that does not end in a newline, edited on its last line',
    file: 'alpha\nbeta\ngamma',
    edit: 'PUT 3:\n-gamma\n+GAMMA',
    want: { kind: 'apply', after: () => 'alpha\nbeta\nGAMMA' }
  },
  {
    id: 'ws-blank-line-anchor',
    group: 'whitespace',
    what: 'an insert hung off a blank line, in a file that has since shifted',
    file: SMALL,
    drift: (text) => `prepended\n${text}`,
    edit: 'PUT >3:\n-gamma\n+inserted',
    want: {
      kind: 'apply',
      after: (live) => {
        const out = toLines(live);
        out.splice(4, 0, 'inserted');
        return out.join('\n');
      }
    }
  },

  /* ------------------------------------------------------------------------ register errors */
  {
    id: 'register-never-cut',
    group: 'register',
    what: 'pasting a register nothing filled',
    edit: 'PUT >20 @block',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'register-filled-twice',
    group: 'register',
    what: 'two CUTs into the same register and one paste',
    edit: 'CUT 1.=2 @m\nCUT 43.=56 @m\nPUT >20 @m',
    want: { kind: 'refuse', fixableFrom: 'shape' },
    finding:
      'SILENT DATA LOSS. The second CUT overwrites the register, both blocks are deleted, and only the second is pasted back - so lines 1-2 vanish, the tool reports success, and nothing in the notes mentions it. Refusing a second fill of a live register is one comparison'
  },
  {
    id: 'register-pasted-into-its-own-cut',
    group: 'register',
    what: 'a block cut and pasted back inside the hole it left',
    edit: 'CUT 5.=18 @drain\nPUT >10 @drain',
    want: { kind: 'refuse', fixableFrom: 'shape' },
    finding:
      'refused by the overlap check rather than by anything that knows about registers, so the message talks about ranges that must not overlap and never mentions @drain. It names the merged spelling `PUT 5.=18:` for the two ranges it saw, which is why the retry is a re-emit and the row is priced at 1 - but that spelling replaces the block and pastes nothing back, so the right answer is still carried by the wrong sentence'
  },
  {
    id: 'register-pasted-twice',
    group: 'register',
    what: 'one CUT and two PUTs of the same register - a copy the format never declared',
    edit: "CUT 1.=2 @head\n-import type { Job, Payload } from './types.js';\nPUT >20 @head\n-/** The next job without taking it, or nothing if the queue is empty. */\nPUT >40 @head\n-  return found;",
    want: {
      kind: 'apply',
      after: (live) => {
        const lines = toLines(live);
        const moved = lines.slice(0, 2);
        const out = [...lines];
        out.splice(40, 0, ...moved);
        out.splice(20, 0, ...moved);
        out.splice(0, 2);
        return out.join('\n');
      }
    },
    finding:
      'a register pasted twice duplicates the block. Nothing declares that and nothing refuses it, so it is a capability the model can only find by accident - harmless, but undocumented behaviour is behaviour nobody can rely on or delete'
  },
  {
    id: 'register-name-with-a-dot',
    group: 'register',
    what: 'a register named `@job.block`',
    edit: 'CUT 1.=2 @job.block\nPUT >20 @job.block',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },

  /* -------------------------------------------------------------------------- encoding */
  {
    id: 'encoding-non-ascii',
    group: 'encoding',
    what: 'a line of non-ASCII text replaced by another',
    file: 'const greeting = "こんにちは";\nconst farewell = "さようなら";\n',
    edit: 'PUT 1:\n-const greeting = "こんにちは";\n+const greeting = "你好";',
    want: { kind: 'apply', after: (live) => splice(live, 1, 1, ['const greeting = "你好";']) }
  },
  {
    id: 'encoding-combining-characters',
    group: 'encoding',
    what: 'the file holds `e` + U+0301 and the `-` row was retyped as the precomposed `é`',
    file: 'const label = "café";\nconst other = 1;\n',
    edit: 'PUT 1:\n-const label = "café";\n+const label = "coffee";',
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'normalisation is whitespace-only, not Unicode. Two strings that render identically compare different, and the refusal quotes back a line that LOOKS like the one the model sent - the same invisible-difference trap the format closed for CRLF, still open for NFC. It costs nothing when the model sends no evidence, which is the format’s own cheapest form'
  },
  {
    id: 'encoding-lone-surrogate',
    group: 'encoding',
    what: 'a lone surrogate in the line above the edit',
    file: 'const broken = "\ud800";\nconst other = 1;\n',
    edit: 'PUT 2:\n-const other = 1;\n+const other = 2;',
    want: { kind: 'apply', after: (live) => splice(live, 2, 2, ['const other = 2;']) }
  },
  {
    id: 'encoding-very-long-line',
    group: 'encoding',
    what: 'a 200,000-character single line beside the edit',
    file: `const data = '${'x'.repeat(200_000)}';\nconst other = 1;\n`,
    edit: 'PUT 2:\n-const other = 1;\n+const other = 2;',
    want: { kind: 'apply', after: (live) => splice(live, 2, 2, ['const other = 2;']) }
  },

  /* ----------------------------------------------------------------------------- scale */
  {
    id: 'scale-first-line',
    group: 'scale',
    what: 'an edit at line 1',
    edit: "PUT 1:\n-import type { Job, Payload } from './types.js';\n+import type { Job, Payload } from './job.js';",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 1, 1, ["import type { Job, Payload } from './job.js';"])
    }
  },
  {
    id: 'scale-last-line',
    group: 'scale',
    what: 'an edit at the last line of the file',
    file: SMALL,
    edit: 'PUT 6:\n-zeta\n+ZETA',
    want: { kind: 'apply', after: (live) => splice(live, 6, 6, ['ZETA']) }
  },
  {
    id: 'scale-append-past-last-line',
    group: 'scale',
    what: 'an insert after the last line',
    file: SMALL,
    edit: 'PUT >6:\n-zeta\n+eta',
    want: { kind: 'apply', after: (live) => `${live}\neta` }
  },
  {
    id: 'scale-one-line-file',
    group: 'scale',
    what: 'the whole file is one line',
    file: 'only',
    edit: 'PUT 1:\n-only\n+ONLY',
    want: { kind: 'apply', after: () => 'ONLY' }
  },
  {
    id: 'scale-empty-file',
    group: 'scale',
    what: 'the file is empty',
    file: '',
    edit: 'PUT 1:\n-\n+first line',
    want: { kind: 'apply', after: () => 'first line' }
  },
  {
    id: 'scale-empty-file-insert',
    group: 'scale',
    what: 'the file is empty and the model inserts after its one empty line',
    file: '',
    edit: 'PUT >1:\n-\n+first line',
    want: { kind: 'apply', after: () => '\nfirst line' },
    finding:
      'an empty file reads as one empty line, so inserting after it leaves a leading blank. That is the numbering being consistent rather than a bug, and it is the shape a model will get wrong on a new file'
  },
  {
    id: 'scale-fifty-thousand-lines',
    group: 'scale',
    what: 'an edit near the end of a 50,000-line file',
    file: HUGE,
    edit: 'PUT 49999:\n-line 49999 of the file\n+line 49999 of the file, changed',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 49_999, 49_999, ['line 49999 of the file, changed'])
    }
  },
  {
    id: 'scale-fifty-thousand-lines-shifted',
    group: 'scale',
    what: 'the same, after another writer prepended two lines',
    file: HUGE,
    drift: (text) => `// added\n// by somebody else\n${text}`,
    edit: 'PUT 49999:\n-line 49999 of the file\n+line 49999 of the file, changed',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 50_001, 50_001, ['line 49999 of the file, changed'])
    }
  },

  /* --------------------------------------------------------------------------- dialect */
  {
    id: 'dialect-space-separated-range',
    group: 'dialect',
    what: 'PUT 10 12: - the separator the parser’s own comment says is forgiven',
    edit: 'PUT 10 12:\n-  if (!job.ready) {\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, ['    return undefined;']) },
    finding:
      '`parse.ts` lists `PUT 40 42:` among the spellings it forgives and the regex has no bare-space separator, so it does not. The refusal is cheap and the comment is wrong; one of the two has to change'
  },
  {
    id: 'dialect-dash-range-lowercase',
    group: 'dialect',
    what: 'put 10-12 - lower case, dash separator, no colon',
    edit: 'put 10-12\n-  if (!job.ready) {\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, ['    return undefined;']) }
  },
  {
    id: 'dialect-double-dot-range',
    group: 'dialect',
    what: 'PUT 10..12:',
    edit: 'PUT 10..12:\n-  if (!job.ready) {\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, ['    return undefined;']) }
  },
  {
    /*
     * Watched on the box. A turn wrote `PUT 40.:=42:` and was refused with "unexpected `.:=` after
     * the range" - it had blended the two spellings this parser already accepted separately. The
     * three dialect rows above are each ONE separator; none of them is a mixture, which is what the
     * gap in the list was.
     */
    id: 'dialect-blended-range-separator',
    group: 'dialect',
    what: 'PUT 10.:=12: - two accepted separators run together',
    edit: 'PUT 10.:=12:\n-  if (!job.ready) {\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, ['    return undefined;']) }
  },
  {
    id: 'dialect-prose-instruction',
    group: 'dialect',
    what: 'REPLACE LINE 11 WITH ... - no dialect at all',
    edit: 'REPLACE LINE 11 WITH "    return undefined;"',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'dialect-rem-a-file',
    group: 'dialect',
    what: 'REM - an operation the reference dialect has and this one does not declare',
    edit: 'REM',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'dialect-mv-a-file',
    group: 'dialect',
    what: 'MV src/queue.ts src/jobs.ts',
    edit: 'MV src/queue.ts src/jobs.ts',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'dialect-block-never-closes',
    group: 'dialect',
    what: 'PUT N*: on a block that runs past the window the model was shown',
    reads: [{ from: 1, to: 8 }],
    edit: 'PUT 5*:\n+export const drain = () => undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'dialect-block-above-the-window',
    group: 'dialect',
    what: 'PUT N*: addressed above the window the model was shown',
    reads: [{ from: 20, to: 40 }],
    edit: 'PUT 5*:\n+export const drain = () => undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'dialect-repeated-stanza',
    group: 'dialect',
    what: 'a line changed inside the second of three byte-identical YAML stanzas',
    path: YAML,
    edit: 'PUT 23:\n-      interval: 30s\n+      interval: 15s',
    want: { kind: 'apply', after: (live) => splice(live, 23, 23, ['      interval: 15s']) }
  },
  {
    id: 'dialect-renumbered-after-own-hunk',
    group: 'dialect',
    what: 'two hunks, the second addressed in the numbering the FIRST one would leave',
    edit: "PUT 7.=9:\n-  if (!job) {\n+  if (!job) return undefined;\nPUT 12:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) =>
        splice(splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"]), 7, 9, [
          '  if (!job) return undefined;'
        ])
    },
    finding:
      'the classic multi-hunk miscount, and the case that justifies accepting `-` rows at all: with one the anchor is pulled back to the original numbering the spec asks for, without one it lands two lines out and nothing in the harness can tell'
  }
];

/* ------------------------------------------------------------------------------- the runner */

let sequence = 0;

/** The file as the read showed it, and as the edit meets it. One definition, used by both runners. */
export const sourceOf = (item: ConformanceCase): { read: string; live: string } => {
  const read = item.file ?? fileText(item.path ?? QUEUE);
  return { read, live: item.drift ? item.drift(read) : read };
};

/**
 * One case, driven through the real applier with the real snapshot store.
 *
 * `forgetReads()` between cases, because the store is process-global and a record left behind by an
 * earlier case would make a later one pass for the wrong reason - which is the failure mode of every
 * shared fixture and the reason this is not a `beforeEach` somebody can forget.
 */
export const runCase = (item: ConformanceCase): ConformanceRow => {
  forgetReads();
  forgetRefusals();
  sequence += 1;
  const taskId = `conformance-${sequence}`;
  const path = item.path ?? QUEUE;
  const { read, live } = sourceOf(item);
  const lines = toLines(read);
  if (!item.noRead)
    for (const window of item.reads ?? [{ from: 1, to: lines.length }])
      recordRead(taskId, path, window.from, lines.slice(window.from - 1, window.to).join('\n'));
  if (item.drift && live === read)
    throw new Error(`${item.id}: drift() changed nothing, so the stale case is not being tested`);
  const fullyShown = !item.noRead && !item.reads;

  let outcome = applyEdit(path, item.edit, live, readsOf(taskId, path));
  let notes: readonly string[] = outcome.ok ? outcome.notes : [];
  /*
   * A second patch rides on the record the first one left, exactly as `workspace.ts` leaves it:
   * the new text and the spans it changed, so the ledger moves by what the result reported.
   */
  if (outcome.ok && item.then !== undefined) {
    recordWrite(taskId, path, outcome.text, outcome.changed);
    outcome = applyEdit(path, item.then, outcome.text, readsOf(taskId, path));
    if (outcome.ok) notes = [...notes, ...outcome.notes];
  }
  if (!outcome.ok) {
    /*
     * Through the repeated-patch bound the arm applies, both times, because the bound is part of
     * what a refusal costs: the second identical patch has to get a different sentence that names
     * the fix, or the loop the bound exists to stop is not stopped here either.
     */
    const first = boundRepeatedRefusal(
      taskId,
      path,
      item.edit,
      outcome.refusal,
      toLines(live),
      fullyShown
    );
    let message = first.message;
    let retried = true;
    if (item.retry) {
      const again = applyEdit(path, item.edit, live, readsOf(taskId, path));
      if (again.ok) throw new Error(`${item.id}: the retried patch applied the second time`);
      const second = boundRepeatedRefusal(
        taskId,
        path,
        item.edit,
        again.refusal,
        toLines(live),
        fullyShown
      );
      message = second.message;
      retried = second.message !== first.message && item.retry.test(second.message);
    }
    const sufficient =
      retried &&
      (item.want.kind === 'refuse' && item.want.fixableFrom === 'content'
        ? carriesLiveText(message, toLines(live))
        : carriesLiveText(message, toLines(live)) || namesAShape(message));
    return {
      id: item.id,
      group: item.group,
      what: item.what,
      cost: sufficient ? 1 : 2,
      verdict: item.want.kind === 'apply' ? 'over-refused' : 'refused',
      detail: outcome.refusal.kind,
      ...(item.finding ? { finding: item.finding } : {})
    };
  }
  if (item.want.kind === 'refuse')
    return {
      id: item.id,
      group: item.group,
      what: item.what,
      cost: 'X',
      verdict: 'landed-wrong',
      detail: 'applied a patch that had to be refused',
      ...(item.finding ? { finding: item.finding } : {})
    };
  const wanted = item.want.after(live);
  if (outcome.text === wanted) {
    // A landing the case said must carry a note, and did not, is a landing the model was told
    // nothing about: the bytes are right and the result is not, and the row says so by name.
    const silent =
      item.want.note !== undefined &&
      !notes.some((note) => item.want.kind === 'apply' && item.want.note?.test(note));
    return {
      id: item.id,
      group: item.group,
      what: item.what,
      cost: 0,
      verdict: silent ? 'landed-silent' : 'landed',
      detail: notes.length ? `${notes.length} note(s)` : 'no notes',
      ...(item.finding ? { finding: item.finding } : {})
    };
  }

  /*
   * A wrong file, and the one question left is whether the model can SEE it.
   *
   * The result carries the line ranges it wrote, and the arm echoes them back numbered. If every
   * line that came out wrong is inside one of those ranges, the damage is on the same turn's tool
   * result and the recovery is one more edit. If it is not, the first thing that notices is a test.
   */
  const before = toLines(live);
  const after = toLines(outcome.text);
  const intended = toLines(wanted);
  const wrong: number[] = [];
  for (let index = 0; index < Math.max(after.length, intended.length); index += 1)
    if (after[index] !== intended[index]) wrong.push(index + 1);
  const echoed = wrong.every((line) =>
    outcome.wrote.some((region) => line >= region.from - 1 && line <= region.to + 1)
  );
  return {
    id: item.id,
    group: item.group,
    what: item.what,
    cost: echoed && wrong.length ? 'X-echo' : 'X',
    verdict: 'landed-wrong',
    detail: `${wrong.length} line(s) wrong, file was ${before.length} lines`,
    ...(item.finding ? { finding: item.finding } : {})
  };
};

export const runConformance = (): readonly ConformanceRow[] => CASES.map(runCase);
