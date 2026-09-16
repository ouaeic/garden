/**
 * The same malformed intents, put through the editor this format replaced, and priced the same way.
 *
 * ── Why this comparison and not the character count ────────────────────────────────────────────
 *
 * The line-addressed format was bought on a measured 61% saving in output characters. That number
 * is an upper bound available only to a model that emits the dialect perfectly, and the ruling that
 * held the format for two waves held it on exactly that objection. `conformance.ts` answers half of
 * it by pricing the candidate's failures. This file answers the other half, which nobody had run:
 * THE INCUMBENT HAS FAILURE MODES TOO, and if they are more expensive then the argument for the
 * format does not depend on the model being perfect at all.
 *
 * ── What the incumbent was ─────────────────────────────────────────────────────────────────────
 *
 * `{ path, oldText, newText | moveAfter }`, one patch per hunk, with two lines of load-bearing
 * behaviour that this file reimplements and `assertIncumbentRetired` pins against the repository:
 *
 *   if (countOccurrences(before, oldText) !== 1) { ... }      the uniqueness guard
 *   const after = before.replace(oldText, newText);           the replace
 *
 * and one batch rule that matters more than either of them: EVERY PATCH THAT MATCHES IS APPLIED.
 * A call whose second hunk is stale writes the first and the third and reports the second, so the
 * file on disk is a state the model never asked for and its numbers for everything after the first
 * hunk are wrong. The candidate is atomic per file and writes nothing at all.
 *
 * ── Why this models it rather than importing it ────────────────────────────────────────────────
 *
 * It cannot import it: the arm was replaced, and the two lines above are no longer in
 * `apps/worker/src/tools/workspace.ts`. A rig holding a private copy of a program that still ships
 * eventually measures a program that no longer exists; a rig holding a copy of one that has been
 * RETIRED is a different thing, and the pin below is written the other way round to say so - it
 * fails if the incumbent ever comes back, because then this file would be describing the shipped
 * editor in the past tense. The explainer, `apps/worker/src/patch-failure.ts`, is still in the
 * repository and is imported rather than copied, so the refusals priced here are the real ones.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyEdit } from '../../apps/worker/src/edit/apply.js';
import { forgetReads, readsOf, recordRead } from '../../apps/worker/src/edit/snapshots.js';
import { patchFailure, type PatchFailure } from '../../apps/worker/src/patch-failure.js';
import { countOccurrences } from '../../apps/worker/src/values.js';
import { carriesLiveText, namesAShape, type Cost } from './conformance.js';
import { fileText } from './corpus.js';
import { minimalUnique, region, type ReplacePatch } from './encode.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceSource = path.resolve(here, '../../apps/worker/src/tools/workspace.ts');

/** The two lines this file models, and the check that they are gone rather than present. */
export const INCUMBENT_LINES = [
  'if (countOccurrences(before, oldText) !== 1) {',
  'const after = before.replace(oldText, newText);'
] as const;

/**
 * The pin, inverted.
 *
 * The version of this rig that shipped before the format did asserted these lines were STILL in
 * `workspace.ts`, so that it could not go on measuring a program that had changed. They are gone,
 * and the same discipline now points the other way: if they come back, something has re-shipped the
 * quoted editor and every sentence in this file about "the editor this replaced" is false.
 */
export const assertIncumbentRetired = (): string => {
  const source = readFileSync(workspaceSource, 'utf8');
  const present = INCUMBENT_LINES.filter((line) => source.includes(line));
  if (present.length)
    throw new Error(
      `apps/worker/src/tools/workspace.ts carries ${present.join(' and ')} again. This rig prices the quoted editor as the one that was REPLACED; if it ships, rewrite the prose before trusting the table.`
    );
  return INCUMBENT_LINES.join(' / ');
};

/* -------------------------------------------------------------------------- the batch applier */

export interface IncumbentOutcome {
  /** What is on disk afterwards. Equal to `before` only when nothing applied. */
  readonly text: string;
  readonly applied: number;
  readonly failures: readonly PatchFailure[];
  /** Some hunks landed and some did not, so the file is a state nobody asked for. */
  readonly partial: boolean;
  /** Nothing landed; the arm threw `patch_conflict` and the file was not written. */
  readonly refused: boolean;
}

/**
 * A patch as the shipped arm accepted one: a replacement, or a move that names where its text goes.
 *
 * `moveAfter` is modelled because leaving it out would overcharge the incumbent by a whole copy of
 * the block on the one row it was built to win - and a comparison that quietly hands the loser a
 * worse encoding than it had is not a comparison.
 */
export interface QuotedPatch extends ReplacePatch {
  readonly moveAfter?: string;
}

/**
 * `file_patch`'s loop, faithful to the arm that shipped: chained through one text per path, the
 * uniqueness guard per hunk, the move counted against the text with the block already cut out, and
 * a write of whatever accumulated unless nothing did.
 */
export const applyIncumbent = (
  patches: readonly QuotedPatch[],
  before: string
): IncumbentOutcome => {
  let text = before;
  let applied = 0;
  const failures: PatchFailure[] = [];
  for (const patch of patches) {
    if (countOccurrences(text, patch.oldText) !== 1) {
      failures.push(patchFailure(patch.path, text, patch.oldText));
      continue;
    }
    const after = text.replace(patch.oldText, patch.newText);
    if (patch.moveAfter !== undefined) {
      // Counted after the cut, deliberately: an anchor inside the block being moved reads as unique
      // against the original text and lands the paste inside text that is no longer there.
      if (patch.moveAfter && countOccurrences(after, patch.moveAfter) !== 1) {
        const found = patchFailure(patch.path, after, patch.moveAfter);
        failures.push({
          ...found,
          reason: found.occurrences
            ? `moveAfter appears ${found.occurrences} times in ${patch.path} once oldText is cut out of it, so there is nowhere unambiguous to put it. Extend moveAfter with enough surrounding lines to make it unique.`
            : `moveAfter is not in ${patch.path} once oldText is cut out of it, so there is nowhere to put it. Quote it exactly as the file reads now - or send an empty moveAfter to move the text to the top of the file. It cannot be text inside the block being moved.`
        });
        continue;
      }
      text = patch.moveAfter
        ? after.replace(patch.moveAfter, patch.moveAfter + patch.oldText)
        : patch.oldText + after;
      applied += 1;
      continue;
    }
    text = after;
    applied += 1;
  }
  return {
    text: applied ? text : before,
    applied,
    failures,
    partial: applied > 0 && failures.length > 0,
    refused: applied === 0
  };
};

/** Everything a failed call puts in front of the model: the sentences and the quoted regions. */
export const incumbentMessage = (outcome: IncumbentOutcome): string =>
  outcome.failures
    .map((failure) => `${failure.reason}\n${failure.nearestMatch?.text ?? ''}`)
    .join('\n');

/* ------------------------------------------------------------------------------ the intents */

export interface PairedIntent {
  readonly id: string;
  /** The task, in terms neither format's vocabulary can express. */
  readonly what: string;
  /** Why THIS emission is the one to model, so neither format is being set up. */
  readonly why: string;
  readonly path: string;
  readonly file: string;
  /** The file as the edit meets it, when another writer got there first. */
  readonly live?: string;
  /** The result the task asked for, computed here and read by neither encoder. */
  readonly after: string;
  /** What a model with this mistake emits as `file_patch` arguments. */
  readonly patches: readonly QuotedPatch[];
  /** What the same model with the same mistake emits into the line-addressed `edit` field. */
  readonly edit: string;
  /** The lines the task is aimed at, for the recovery-quote measurement. */
  readonly target?: { readonly from: number; readonly to: number };
}

export interface SideRow {
  readonly cost: Cost;
  readonly verdict: 'landed' | 'refused' | 'partial-write' | 'landed-wrong';
  /** Characters of JSON arguments the emission cost. */
  readonly chars: number;
  /**
   * Whether this format's argument can be BUILT from the read the model was shown.
   *
   * The question a round-trip count cannot ask, and the one that decides whether a refusal is a
   * cost or a loop. A line number is in the display by construction. A byte-exact quote is not,
   * whenever the file differs from its display in a way the display cannot show - a trailing space,
   * a CRLF, a tab rendered as spaces - and a model that cannot see what it got wrong re-derives
   * the same call from the same display and re-earns the same refusal.
   */
  readonly emittable: boolean;
  /** The bytes on disk afterwards, for the file-state column. */
  readonly wrote: 'nothing' | 'the whole edit' | 'part of the edit' | 'the wrong edit';
}

export interface PairRow {
  readonly id: string;
  readonly what: string;
  readonly why: string;
  readonly quoted: SideRow;
  readonly byLine: SideRow;
}

const priceIncumbent = (intent: PairedIntent): SideRow => {
  const live = intent.live ?? intent.file;
  const outcome = applyIncumbent(intent.patches, live);
  const chars = JSON.stringify({ patches: intent.patches }).length;
  const emittable = intent.patches.every((patch) => live.includes(patch.oldText));
  if (outcome.refused)
    return {
      cost: carriesLiveText(incumbentMessage(outcome), live.split('\n')) ? 1 : 2,
      verdict: 'refused',
      chars,
      emittable,
      wrote: 'nothing'
    };
  if (outcome.partial)
    return {
      /*
       * A partial write is never one round trip, whatever the message says.
       *
       * The hunks that landed moved everything after them, so the model's quotes for the rest of
       * the file were derived against a text that is no longer on disk - and the arm's own
       * instruction, "the rest are already written. Fix only the failures below", is an instruction
       * to patch a file it has not seen. That is a read, and the read puts back into the window
       * exactly the region the failed hunk's own evidence was supposed to save.
       */
      cost: 2,
      verdict: 'partial-write',
      chars,
      emittable,
      wrote: 'part of the edit'
    };
  const right = outcome.text === intent.after;
  return {
    cost: right ? 0 : 'X',
    verdict: right ? 'landed' : 'landed-wrong',
    chars,
    emittable,
    /*
     * A wrong file, and nothing in this arm's result shows it.
     *
     * `file_patch` answered with `filesChanged: [{ path, sha256, replacements }]` and a count. A
     * hash is not evidence a model can read, so an edit that replaced the wrong unique line comes
     * back looking exactly like one that replaced the right one. The line-addressed arm echoes the
     * lines it wrote, which is why the same mistake scores `X-echo` there and `X` here.
     */
    wrote: right ? 'the whole edit' : 'the wrong edit'
  };
};

const priceByLine = (intent: PairedIntent): SideRow => {
  forgetReads();
  const taskId = `pair-${intent.id}`;
  recordRead(taskId, intent.path, 1, intent.file);
  const live = intent.live ?? intent.file;
  const outcome = applyEdit(intent.path, intent.edit, live, readsOf(taskId, intent.path));
  const chars = JSON.stringify({ path: intent.path, edit: intent.edit }).length;
  // Always true, and that is the claim: every number this format addresses with is a number the
  // read put on the screen, so there is no version of the file the model cannot address.
  const emittable = true;
  if (!outcome.ok) {
    const message = outcome.refusal.message;
    return {
      cost: carriesLiveText(message, live.split('\n')) || namesAShape(message) ? 1 : 2,
      verdict: 'refused',
      chars,
      emittable,
      wrote: 'nothing'
    };
  }
  const right = outcome.text === intent.after;
  const wrong: number[] = [];
  const produced = outcome.text.split('\n');
  const wanted = intent.after.split('\n');
  for (let index = 0; index < Math.max(produced.length, wanted.length); index += 1)
    if (produced[index] !== wanted[index]) wrong.push(index + 1);
  const echoed =
    wrong.length > 0 &&
    wrong.every((line) =>
      outcome.wrote.some((span) => line >= span.from - 1 && line <= span.to + 1)
    );
  return {
    cost: right ? 0 : echoed ? 'X-echo' : 'X',
    verdict: right ? 'landed' : 'landed-wrong',
    chars,
    emittable,
    wrote: right ? 'the whole edit' : 'the wrong edit'
  };
};

export const pricePair = (intent: PairedIntent): PairRow => ({
  id: intent.id,
  what: intent.what,
  why: intent.why,
  quoted: priceIncumbent(intent),
  byLine: priceByLine(intent)
});

/**
 * The smallest quote the incumbent could have got away with, in lines and characters.
 *
 * Reported beside a uniqueness refusal because "grow oldText until it is unique" is the recovery
 * the arm actually asks for, and the size of that quote is what the recovery costs. Where the
 * target sits inside a run of byte-identical stanzas the answer reaches to the nearest thing that
 * distinguishes them, which is the row the format was bought on.
 */
export const recoveryQuote = (
  text: string,
  from: number,
  to: number
): { lines: number; chars: number } | undefined => {
  const split = text.split('\n');
  const found = minimalUnique(split, text, from, to);
  if (!found) return undefined;
  return {
    lines: found.to - found.from + 1,
    chars: region(split, found.from, found.to).length
  };
};

/* ------------------------------------------------------------------ the paired intents */

const QUEUE = 'src/queue.ts';
const YAML = 'infra/services.yml';

/** Replace one-based lines `from..to`, which is how every intended result here is written. */
const splice = (text: string, from: number, to: number, lines: readonly string[]): string => {
  const out = text.split('\n');
  out.splice(from - 1, to - from + 1, ...lines);
  return out.join('\n');
};

const queue = fileText(QUEUE);
const yaml = fileText(YAML);
const line = (text: string, at: number): string => `${text.split('\n')[at - 1] as string}\n`;

/** Every non-empty line grows two trailing spaces - a difference no display the model sees shows. */
const withTrailingSpaces = (text: string): string =>
  text
    .split('\n')
    .map((row) => (row ? `${row}  ` : row))
    .join('\n');

export const PAIRED: readonly PairedIntent[] = [
  {
    id: 'repeated-line',
    what: 'change one of six identical `return null;` lines',
    why: 'the model quotes the line it is changing, which is what a quote-addressed format asks for and what makes it ambiguous on a repetitive file',
    path: QUEUE,
    file: queue,
    after: splice(queue, 11, 11, ['    return undefined;']),
    patches: [{ path: QUEUE, oldText: line(queue, 11), newText: '    return undefined;\n' }],
    edit: 'PUT 11:\n-    return null;\n+    return undefined;',
    target: { from: 11, to: 11 }
  },
  {
    id: 'deep-stanza',
    what: 'change one line inside the second of three byte-identical YAML stanzas',
    why: 'the same quote, on the file shape that has no unique neighbourhood at all until the quote reaches the stanza name three lines above',
    path: YAML,
    file: yaml,
    after: splice(yaml, 23, 23, ['      interval: 15s']),
    patches: [{ path: YAML, oldText: line(yaml, 23), newText: '      interval: 15s\n' }],
    edit: 'PUT 23:\n-      interval: 30s\n+      interval: 15s',
    target: { from: 23, to: 23 }
  },
  {
    id: 'trailing-spaces',
    what: 'change a line in a file whose lines carry trailing spaces',
    why: 'the model quotes what the read displayed, and the read cannot display a trailing space. This is the failure whose retry is the same call',
    path: QUEUE,
    file: queue,
    live: withTrailingSpaces(queue),
    after: splice(withTrailingSpaces(queue), 14, 14, [
      "    logger.error('job expired', { id: job.id });"
    ]),
    patches: [
      {
        path: QUEUE,
        oldText: line(queue, 14),
        newText: "    logger.error('job expired', { id: job.id });\n"
      }
    ],
    edit: "PUT 14:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    target: { from: 14, to: 14 }
  },
  {
    id: 'crlf-file',
    what: 'change a line in a file written with CRLF endings',
    why: 'the same invisible difference, in the form the explainer has a name for - so this is the incumbent at its best on this class',
    path: QUEUE,
    file: queue,
    live: queue.replace(/\n/g, '\r\n'),
    // The new line ends the way every line of this file ends.
    after: splice(queue.replace(/\n/g, '\r\n'), 14, 14, [
      "    logger.error('job expired', { id: job.id });\r"
    ]),
    patches: [
      {
        path: QUEUE,
        oldText: line(queue, 14),
        newText: "    logger.error('job expired', { id: job.id });\n"
      }
    ],
    edit: "PUT 14:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    target: { from: 14, to: 14 }
  },
  {
    id: 'stale-middle-hunk',
    what: 'three hunks in one call, the middle one aimed at a region another writer has rewritten',
    why: 'the shape that separates a batch that applies what matches from one that is atomic per file - and the only row where the two formats leave the disk in different states',
    path: QUEUE,
    file: queue,
    live: splice(queue, 22, 22, ['  const job = queue.at(0);']),
    after: splice(
      splice(splice(queue, 22, 22, ['  const job = queue.at(0);']), 45, 45, ['  let total = 0;']),
      14,
      14,
      ["    logger.error('job expired', { id: job.id });"]
    ),
    patches: [
      {
        path: QUEUE,
        oldText: line(queue, 14),
        newText: "    logger.error('job expired', { id: job.id });\n"
      },
      { path: QUEUE, oldText: line(queue, 22), newText: '  const job = queue.shift();\n' },
      { path: QUEUE, oldText: line(queue, 45), newText: '  let total = 0;\n' }
    ],
    edit: "PUT 14:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });\nPUT 22:\n-  const job = queue[0];\n+  const job = queue.shift();\nPUT 45:\n-  let count = 0;\n+  let total = 0;"
  },
  {
    id: 'self-invalidating-hunks',
    what: 'two hunks in one call where the first one destroys the text the second one quotes',
    why: 'the model wrote both hunks against the file it read, which is what both formats tell it to do; only one of them checks that they do not collide',
    path: QUEUE,
    file: queue,
    after: splice(queue, 13, 16, ['  if (job.expiresAt < Date.now()) return undefined;']),
    patches: [
      {
        path: QUEUE,
        oldText: region(queue.split('\n'), 13, 16),
        newText: '  if (job.expiresAt < Date.now()) return undefined;\n'
      },
      {
        path: QUEUE,
        oldText: line(queue, 14),
        newText: "    logger.error('job expired', { id: job.id });\n"
      }
    ],
    edit: "PUT 13.=16:\n-  if (job.expiresAt < Date.now()) {\n+  if (job.expiresAt < Date.now()) return undefined;\nPUT 14:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });"
  },
  {
    id: 'unified-diff-fallback',
    what: 'the model falls back to the diff format it knows best',
    why: 'the emission every harness that has published a deny-list reports; here it is put through both arms unchanged',
    path: QUEUE,
    file: queue,
    after: splice(queue, 11, 11, ['    return undefined;']),
    patches: [
      {
        path: QUEUE,
        oldText: `-${line(queue, 11)}`,
        newText: '+    return undefined;\n'
      }
    ],
    edit: '@@ -10,3 +10,3 @@\n   if (!job.ready) {\n-    return null;\n+    return undefined;\n   }'
  },
  {
    id: 'wrong-line-confidently',
    what: 'the model aims one line high - at the signature above the line it meant to change',
    why: 'the closest thing the two formats have to the same mistake: a quote of the wrong unique line, and an anchor one number out. Both land, both land wrong, and only one of the two results shows it',
    path: QUEUE,
    file: queue,
    after: splice(queue, 45, 45, ['  let total = 0;']),
    patches: [{ path: QUEUE, oldText: line(queue, 44), newText: '  let total = 0;\n' }],
    edit: 'PUT 44:\n+  let total = 0;'
  },
  {
    id: 'move-a-block',
    what: 'move a ten-line function to the top of the file',
    why: 'the row the format was bought on, and the one place the incumbent grew an operation of its own rather than a bigger quote',
    path: QUEUE,
    file: queue,
    after: (() => {
      const lines = queue.split('\n');
      const moved = lines.slice(31, 41);
      const out = [...lines];
      out.splice(31, 10);
      out.splice(2, 0, ...moved);
      return out.join('\n');
    })(),
    patches: [
      {
        path: QUEUE,
        oldText: region(queue.split('\n'), 32, 41),
        newText: '',
        moveAfter: line(queue, 2)
      }
    ],
    edit: "CUT 32.=41 @block\n-/** Every job that will never run, so a caller can report them and drop them. */\nPUT >2 @block\n-import { logger } from '../log.js';"
  },
  {
    id: 'move-anchored-inside-itself',
    what: 'the same move, with the destination anchor quoted from inside the block being moved',
    why: 'the incumbent’s own characteristic move failure, kept in so its refusals are not represented only by the class the candidate is best against',
    path: QUEUE,
    file: queue,
    after: (() => {
      const lines = queue.split('\n');
      const moved = lines.slice(31, 41);
      const out = [...lines];
      out.splice(31, 10);
      out.splice(2, 0, ...moved);
      return out.join('\n');
    })(),
    patches: [
      {
        path: QUEUE,
        oldText: region(queue.split('\n'), 32, 41),
        newText: '',
        moveAfter: line(queue, 34)
      }
    ],
    edit: 'CUT 32.=41 @block\n-/** Every job that will never run, so a caller can report them and drop them. */\nPUT >34 @block\n-  const found: Job[] = [];'
  }
];

export const runPairs = (): readonly PairRow[] => PAIRED.map(pricePair);
