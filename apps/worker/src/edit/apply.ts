import { blockAt } from './block.js';
import {
  anchorPrefixes,
  isWeakAnchor,
  looksNumbered,
  normaliseLine,
  numberedWindow,
  sameLine,
  sameLines,
  sayRange,
  toLines
} from './format.js';
import { parseEdit, type EditOp, type ParseFailure } from './parse.js';
import { type LineChange, type Snapshot } from './snapshots.js';

/** Every way the applier refuses a patch it could parse. */
export type RefusalKind =
  | 'unseen'
  | 'out_of_range'
  | 'moved'
  | 'evidence'
  | 'block_open'
  | 'overlap'
  | 'register';

/** A refusal about the file, carrying the one change that would make the same patch land. */
interface Refused {
  readonly message: string;
  /** Named so a patch sent again byte for byte can be answered with the fix and not the reason. */
  readonly fix: string;
  /** Set where the placement knows better than its caller which refusal this is. */
  readonly kind?: RefusalKind;
}

export type EditRefusal = ParseFailure | ({ readonly kind: RefusalKind } & Refused);

export type EditResult =
  | {
      readonly ok: true;
      /** The file afterwards. */
      readonly text: string;
      /** Line ranges of the new file the patch wrote, for the echo the result carries back. */
      readonly wrote: ReadonlyArray<{ from: number; to: number }>;

      readonly changed: readonly LineChange[];
      /**
       * How the numbers the model read map onto the numbers the file has now, one line per change
       * that moved anything: `lines after 42 are now +3`. It is what lets the next patch to this
       * file be addressed without a read, because the ledger has already moved by the same
       * amounts - see `snapshots.ts recordWrite`.
       */
      readonly renumbered: readonly string[];
      /** Spellings forgiven and anchors corrected, in the words the model gets back. */
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly refusal: EditRefusal };

/** How much of the live file a refusal hands back on each side of the anchor. */
const CONTEXT_LINES = 8;

/**
 * How far a whole quote may be corrected when the model supplied two or more rows of it.
 *
 * Three lines, because an off-by-one is what this is for and an off-by-three is the outside edge of
 * a miscount a model makes while counting a header or a blank line. Beyond that, "I found your text
 * somewhere else in the file" stops being a correction and becomes a guess about intent, and a
 * guess about intent is how a format like this corrupts code.
 */
const CORRECTION_RADIUS = 3;

/**
 * How far a one-row anchor may be corrected, in two rings.
 *
 * The inner ring is the same three lines a whole quote gets. The outer ring reaches five, because
 * an anchor is the taught form and a miscount of four or five - a blank line, a comment and a
 * wrapped signature counted wrong together - is still a miscount rather than a different intent.
 * Two rings and not one, because a single wide window refuses what the narrow one recovers: on a
 * file that says `return null;` every fourth line, an anchor one line out has exactly one match
 * within three lines and two within five, and the second copy at distance four is not a candidate
 * the model could have meant while off by one. So the narrow ring is asked first, and only when it
 * is empty is the wide one asked. Ambiguity in whichever ring answers is a refusal that names both
 * lines; nearest is never chosen.
 */
const ANCHOR_RINGS: readonly number[] = [CORRECTION_RADIUS, 5];

interface Placement {
  readonly from: number;
  readonly to: number;
  readonly note?: string;
}

/** Every one-based inclusive window of `live` whose lines equal `wanted`, up to two of them. */
const occurrences = (live: readonly string[], wanted: readonly string[]): number[] => {
  const hits: number[] = [];
  if (!wanted.length) return hits;
  for (let index = 0; index + wanted.length <= live.length; index += 1) {
    let same = true;
    for (let offset = 0; offset < wanted.length; offset += 1)
      if (!sameLine(live[index + offset] ?? '', wanted[offset] ?? '')) {
        same = false;
        break;
      }
    if (same) {
      hits.push(index + 1);
      if (hits.length > 1) return hits;
    }
  }
  return hits;
};

/** The recorded text of file lines `from..to`, or undefined when this read never showed them. */
const shown = (snapshot: Snapshot, from: number, to: number): readonly string[] | undefined => {
  const first = from - snapshot.startLine;
  const last = to - snapshot.startLine;
  if (first < 0 || last >= snapshot.lines.length || last < first) return undefined;
  return snapshot.lines.slice(first, last + 1);
};

/** What one read recorded at line `at`, or undefined when it never showed that line. */
const recordedAt = (snapshot: Snapshot, at: number): string | undefined =>
  shown(snapshot, at, at)?.[0];

/**
 * Where an addressed range actually is in the live file, and why.
 *
 * Tried in this order, because each step is a weaker claim than the one before it:
 *
 *   1. THE NUMBERS ARE LIVE. What the read showed at those lines is still what is there. Nothing to
 *      recover; this is the overwhelmingly common case and it costs one comparison.
 *   2. THE FILE SHIFTED. The recorded text is somewhere else in the live file, exactly once. The
 *      model is not wrong; the file moved under it, and refusing would send it back to read a file
 *      whose contents it already knows. Applied, and the shift is reported.
 *   3. NOTHING, and that is a refusal - the recorded text is gone (somebody rewrote that region) or
 *      duplicated (there is no unambiguous answer). Guessing here is the one failure that corrupts
 *      code rather than wasting a round trip.
 */
const placeRange = (
  live: readonly string[],
  snapshot: Snapshot,
  from: number,
  to: number
): Placement | undefined => {
  const wanted = shown(snapshot, from, to);
  if (!wanted) return undefined;
  const here = live.slice(from - 1, to);
  if (sameLines(here, wanted)) return { from, to };
  const hits = occurrences(live, wanted);
  if (hits.length !== 1) return undefined;
  const at = hits[0] as number;
  return {
    from: at,
    to: at + wanted.length - 1,
    note: `${sayRange(from, to)} had moved to ${sayRange(at, at + wanted.length - 1)} since you read it; the edit followed the text and landed there`
  };
};

/**
 * The deliberate answer to a whole quote that does not match where it was addressed.
 *
 * WITH EVIDENCE - the model wrote two or more `-` rows, or a whole unified-diff hunk, saying what it
 * believes it is replacing. That is not noise to be stripped: it is a statement of intent the
 * harness can check. If the claimed text is not at the addressed lines but IS within a few lines of
 * them, exactly once, then the model's numbers are off and its intent is not in doubt. The anchor
 * is corrected, the edit lands, and the correction is reported in the result. Refusing here would
 * be refusing an edit whose meaning is written out in the patch itself.
 *
 * The claimed text is also allowed to be a different LENGTH from the addressed range - a model that
 * writes four `-` rows under `PUT 40.=42:` has miscounted the range, not the text, and the text is
 * the better evidence of the two.
 */
const placeWithEvidence = (
  path: string,
  live: readonly string[],
  against: Snapshot,
  placed: Placement,
  claimed: readonly string[]
): Placement | Refused => {
  if (!claimed.length) return placed;
  const here = live.slice(placed.from - 1, placed.to);
  if (sameLines(here, claimed)) return placed;
  /*
   * The ledger followed the addressed lines somewhere else, and the quote disagrees with what it
   * found there. A search around the relocated number would be a search in a numbering the read
   * never used, against a ledger that cannot vouch for it, so the two claims are simply reported
   * as the disagreement they are - the same answer the one-row anchor gives in this position.
   */
  if (placed.note)
    return {
      message: `${path} has changed since you read it: the lines you addressed had moved to ${sayRange(placed.from, placed.to)}, and the lines you quoted are not what stands there now, so there is no line this edit can be said to mean. Nothing was written. The file now reads:\n\n${numberedWindow(live, placed, CONTEXT_LINES)}`,
      fix: 'drop the - rows and address the numbers shown below'
    };

  const low = Math.max(1, placed.from - CORRECTION_RADIUS);
  const high = Math.min(live.length, placed.from + CORRECTION_RADIUS + claimed.length - 1);
  const near = occurrences(live.slice(low - 1, high), claimed).map((at) => at + low - 1);
  const hits = near.length === 1 ? near : occurrences(live, claimed);
  if (hits.length === 1) {
    const at = hits[0] as number;
    const distance = Math.abs(at - placed.from);
    if (distance <= CORRECTION_RADIUS) {
      const to = at + claimed.length - 1;
      /*
       * THE INVARIANT HOLDS HERE TOO. A corrected range is a range the read has to have shown,
       * with the text the quote claims: the live file alone would let a quote written from what
       * another writer put there since the read carry the edit onto lines nobody displayed.
       */
      const recorded = shown(against, at, to);
      if (recorded === undefined)
        return {
          kind: 'unseen',
          message: `The lines you quoted are at ${sayRange(at, to)}, not ${sayRange(placed.from, placed.to)}, but ${sayRange(at, to)} runs past the lines you have been shown of ${path}, so nothing was written. Read from line ${at} with file_read, using startLine and endLine, and address what it shows. The file reads:\n\n${numberedWindow(live, placed, CONTEXT_LINES)}`,
          fix: `file_read ${path} startLine ${at} endLine ${to + CONTEXT_LINES}`
        };
      if (!sameLines(recorded, claimed))
        return {
          kind: 'moved',
          message: `The lines you quoted are at ${sayRange(at, to)}, not ${sayRange(placed.from, placed.to)}, but ${sayRange(at, to)} did not read that way when you read it - the file has changed there since. Nothing was written. The file now reads:\n\n${numberedWindow(live, { from: Math.min(at, placed.from), to: Math.max(to, placed.to) }, CONTEXT_LINES)}`,
          fix: 'drop the - rows and address the numbers shown below'
        };
      return {
        from: at,
        to,
        note:
          distance === 0
            ? `the lines you quoted run ${sayRange(at, to)}, one line ${claimed.length > here.length ? 'longer' : 'shorter'} than the range you wrote; the quoted lines are what was replaced`
            : `the lines you quoted are at ${sayRange(at, to)}, not ${sayRange(placed.from, placed.to)} - your anchor was off by ${distance}. The quoted lines are what was replaced; count from the numbers in the read`
      };
    }
    return {
      message: `The lines you quoted are at ${sayRange(at, at + claimed.length - 1)}, but you addressed ${sayRange(placed.from, placed.to)} - ${distance} lines away, which is too far to correct without guessing at what you meant. Send the same body against ${sayRange(at, at + claimed.length - 1)}. The file now reads:\n\n${numberedWindow(live, { from: Math.min(at, placed.from), to: Math.max(at + claimed.length - 1, placed.to) }, CONTEXT_LINES)}`,
      fix: `send the same body against ${sayRange(at, at + claimed.length - 1)}`
    };
  }
  return {
    message: `You quoted ${hits.length ? 'text that appears more than once' : 'text that is not in the file'}, and ${sayRange(placed.from, placed.to)} does not hold it either, so nothing was written. Here is what is actually at those lines:\n\n${numberedWindow(live, placed, CONTEXT_LINES)}`,
    fix: 'drop the - rows and address the numbers shown below'
  };
};

/**
 * The taught form: one `-` row quoting the start of the first addressed line, checked and, when the
 * number is off, corrected.
 *
 * The invariant this rests on is the one in the header. A line is a candidate only when the live
 * file AND the read the model was shown both begin with the anchor at that number. The live file
 * alone is not enough - text the model has never seen may have arrived there since the read - and
 * the read alone is not enough - it may have gone since. Both, or nothing.
 *
 * In order, because each ring is a weaker claim than the one before it:
 *
 *   1. The anchor holds at the addressed line: nothing to do.
 *   2. The addressed lines had MOVED and the ledger followed them (`placeRange` said so). The
 *      anchor is checked where they went and nowhere else: a scan around the old number would be a
 *      scan around a number nobody means any more. The ledger's half of that check is the row at
 *      the number the model ADDRESSED - `asked` - because that is the row the ledger just followed
 *      to the new place; the ledger's row at the new number is whatever happened to be there
 *      before the file moved. Disagreement is a refusal that shows the window.
 *   3. The inner ring, then the outer. Exactly one candidate lands the edit there, with the whole
 *      shifted span re-checked against the read; two or more is a refusal naming both, because the
 *      nearest one is a guess. A weak anchor - fewer than eight non-space characters - needs the
 *      lines beside it to read as the ledger recorded them before it can be chosen; a line that
 *      carries such an anchor in both records but whose neighbours have drifted is not dropped, it
 *      is REPORTED, because a stale neighbour is evidence that the region moved and not evidence
 *      that a further brace is the one meant.
 *   4. Nowhere in either ring. If the anchor stands exactly once in the whole file it is named,
 *      with the same body to send against it - unless that line was never displayed, which is an
 *      `unseen` refusal naming the line, or displayed with different text, which is a `moved` one.
 *      Nowhere at all is a refusal with the window: the quote is from memory, or the region was
 *      rewritten since the read.
 *
 * The span is shifted by the anchor's distance and NEVER widened or narrowed: an anchor says which
 * line the first one is, and the range says how many follow.
 */
const placeWithAnchor = (
  path: string,
  live: readonly string[],
  against: Snapshot,
  reads: readonly Snapshot[],
  asked: number,
  placed: Placement,
  anchor: string
): Placement | Refused => {
  const at = placed.from;
  const length = placed.to - placed.from + 1;
  /** Whether the live line at `line` and the ledger's row at `recordedLine` both start this way. */
  const carriesAcross = (line: number, recordedLine: number): boolean => {
    const recorded = recordedAt(against, recordedLine);
    return (
      recorded !== undefined &&
      anchorPrefixes(anchor, live[line - 1] ?? '') &&
      anchorPrefixes(anchor, recorded)
    );
  };
  const carries = (line: number): boolean => carriesAcross(line, line);
  const shortAnchor = anchor.trim().slice(0, 48);

  if (placed.note)
    return carriesAcross(at, asked)
      ? placed
      : {
          message: `${path} has changed since you read it: the lines you addressed had moved to ${sayRange(placed.from, placed.to)}, and your - row "${shortAnchor}" is not what stands there now, so there is no line this edit can be said to mean. Nothing was written. The file now reads:\n\n${numberedWindow(live, placed, CONTEXT_LINES)}`,
          fix: 'drop the - row and address the numbers shown below'
        };
  if (carries(at)) return placed;

  const weak = isWeakAnchor(anchor);
  const rings = weak ? ANCHOR_RINGS.slice(0, 1) : ANCHOR_RINGS;
  const reach = rings[rings.length - 1] as number;
  const neighboursHold = (line: number): boolean => {
    let checked = 0;
    for (const beside of [line - 1, line + 1]) {
      const recorded = recordedAt(against, beside);
      if (recorded === undefined) continue;
      checked += 1;
      if (!sameLine(live[beside - 1] ?? '', recorded)) return false;
    }
    return checked > 0;
  };
  const candidates = (radius: number): { found: number[]; drifted: number[] } => {
    const found: number[] = [];
    const drifted: number[] = [];
    for (
      let line = Math.max(1, at - radius);
      line <= Math.min(live.length, at + radius);
      line += 1
    ) {
      if (line === at || !carries(line)) continue;
      if (weak && !neighboursHold(line)) drifted.push(line);
      else found.push(line);
    }
    return { found, drifted };
  };

  for (const radius of rings) {
    const { found, drifted } = candidates(radius);
    if (!found.length && !drifted.length) continue;
    if (drifted.length) {
      /*
       * A brace the ledger and the file agree on, beside a line they do not. That is exactly the
       * shape a region the model meant takes after somebody else edited next to it, and the one
       * shape a short row must never be allowed to look past: on the rig's own attack case, the
       * brace two lines further on had intact neighbours and took the edit meant for this one.
       */
      const all = [...found, ...drifted].sort((left, right) => left - right);
      const first = all[0] as number;
      const last = all[all.length - 1] as number;
      return {
        message: `Your - row "${shortAnchor}" is not at ${at}, and a row this short can only be told apart by the lines beside it: it starts ${all.length === 1 ? 'line' : 'lines'} ${all.join(' and ')} near ${at}, and beside ${drifted.join(' and ')} the file has changed since you read it, so nothing was written - there is no one line this edit can be said to mean. Address the one you mean; the file reads:\n\n${numberedWindow(live, { from: first, to: last }, CONTEXT_LINES)}`,
        fix: `drop the - row and address the one line you mean, ${all.join(' or ')}`
      };
    }
    if (found.length > 1) {
      const first = found[0] as number;
      const last = found[found.length - 1] as number;
      return {
        message: `Your - row "${shortAnchor}" is not at ${at}, and it starts ${found.length} lines near it - ${found.join(' and ')} - so there is no one line this edit can be said to mean. Nothing was written. Address the one you mean; the file reads:\n\n${numberedWindow(live, { from: first, to: last }, CONTEXT_LINES)}`,
        fix: `drop the - row and address the one line you mean, ${found.join(' or ')}`
      };
    }
    const target = found[0] as number;
    const to = target + length - 1;
    const recorded = shown(against, target, to);
    if (recorded === undefined)
      return {
        message: `Your - row "${shortAnchor}" is at ${target}, not ${at}, but the range corrected to ${sayRange(target, to)} runs past the lines you have been shown of ${path}, so nothing was written. Read from line ${target} with file_read, using startLine and endLine, and address what it shows. The file reads:\n\n${numberedWindow(live, { from: at, to: placed.to }, CONTEXT_LINES)}`,
        fix: `file_read ${path} startLine ${target} endLine ${to + CONTEXT_LINES}`
      };
    if (!sameLines(live.slice(target - 1, to), recorded))
      return {
        message: `Your - row "${shortAnchor}" is at ${target}, not ${at}, but ${sayRange(target, to)} no longer reads as it did when you read it, so nothing was written. The file now reads:\n\n${numberedWindow(live, { from: target, to }, CONTEXT_LINES)}`,
        fix: 'drop the - row and address the numbers shown below'
      };
    const distance = Math.abs(target - at);
    return {
      from: target,
      to,
      note: `your - row is at ${target}, not ${at} - the number was off by ${distance}; the edit was applied at ${sayRange(target, to)}. Count from the numbers in the read`
    };
  }

  const elsewhere: number[] = [];
  for (let line = 1; line <= live.length && elsewhere.length < 2; line += 1)
    if (line !== at && anchorPrefixes(anchor, live[line - 1] ?? '')) elsewhere.push(line);
  if (elsewhere.length === 1) {
    const there = elsewhere[0] as number;
    const displayed = reads
      .map((read) => recordedAt(read, there))
      .find((text) => text !== undefined);
    if (displayed === undefined)
      return {
        message: `Your - row "${shortAnchor}" is not at ${at}, and the one line of ${path} that starts that way, ${there}, has never been shown to you, so nothing was written. Read it with file_read, using startLine and endLine, before addressing it. What you addressed reads:\n\n${numberedWindow(live, placed, CONTEXT_LINES)}`,
        fix: `file_read ${path} startLine ${Math.max(1, there - CONTEXT_LINES)} endLine ${there + CONTEXT_LINES}`
      };
    if (!anchorPrefixes(anchor, displayed))
      return {
        message: `Your - row "${shortAnchor}" is not at ${at}, and the one line of ${path} that starts that way now, ${there}, did not when you read it - the file has changed there since. Nothing was written. The file now reads:\n\n${numberedWindow(live, { from: Math.min(at, there), to: Math.max(placed.to, there) }, CONTEXT_LINES)}`,
        fix: 'drop the - row and address the numbers shown below'
      };
    const distance = Math.abs(there - at);
    return {
      message: `The line you quoted is at ${there}, but you addressed ${sayRange(placed.from, placed.to)} - ${distance} lines away, which is too far to correct without guessing at what you meant. Send the same body against ${there}. The file now reads:\n\n${numberedWindow(live, { from: Math.min(at, there), to: Math.max(placed.to, there) }, CONTEXT_LINES)}`,
      fix: `send the same body against ${there}`
    };
  }
  return {
    message: `Your - row "${shortAnchor}" is not at ${at} and ${elsewhere.length ? `stands on more than one other line of ${path}, none ${weak ? 'that a row this short can be matched to ' : ''}within ${reach} lines of ${at}` : `is not in ${path} at all`}, so nothing was written: the line has changed since you read it, or the quote is from memory. Here is what is actually there:\n\n${numberedWindow(live, placed, CONTEXT_LINES)}`,
    fix: 'drop the - row and address the numbers shown below'
  };
};

interface Splice {
  readonly start: number;
  readonly remove: number;
  readonly insert: readonly string[];
  readonly order: number;
  readonly kind: EditOp['kind'];
}

/** The lines an operation rests on, in the numbering the model addressed it with. */
const spanOf = (
  op: EditOp,
  snapshot: Snapshot,
  at = op.kind === 'block' ? op.at : 0
): { from: number; to: number; closed?: boolean } | undefined => {
  switch (op.kind) {
    case 'replace':
    case 'cut':
      return { from: op.from, to: op.to };
    case 'block': {
      const found = blockAt(snapshot.lines, at - snapshot.startLine);
      return {
        from: found.from + snapshot.startLine,
        to: found.to + snapshot.startLine,
        closed: found.closed
      };
    }
    case 'insert':
    case 'paste':
      return { from: op.at, to: op.at };
    default:
      return undefined;
  }
};

/**
 * Where the new numbers stand against the old ones, one line per change that moved anything.
 *
 * Derived from `changed` rather than from the texts, because `changed` is what this function knows
 * it moved. The figure after each change is CUMULATIVE - the shift a line below it has suffered
 * from everything above - which is the number a model needs to renumber the rest of its head
 * without a read.
 */
const renumberingOf = (changed: readonly LineChange[]): string[] => {
  const out: string[] = [];
  let moved = 0;
  let lastOldTo = 0;
  for (const change of changed) {
    const delta = change.newTo - change.newFrom - (change.oldTo - change.oldFrom);
    if (!delta) continue;
    moved += delta;
    lastOldTo = change.oldTo;
    out.push(`lines after ${change.oldTo} are now ${moved > 0 ? '+' : ''}${moved}`);
  }
  if (out.length > 1)
    out.push(`net: lines after ${lastOldTo} are now ${moved > 0 ? '+' : ''}${moved}`);
  return out;
};

const refuse = (kind: RefusalKind, refused: Refused): EditResult => ({
  ok: false,
  refusal: { kind, ...refused }
});

/**
 * Applies one file's patch.
 *
 * `reads` is every read of this file this task remembers, newest last. Each operation is resolved
 * against the newest read that actually displayed the lines it addresses, so a turn that read a
 * file twice can still edit against either set of numbers without saying which.
 */
export const applyEdit = (
  path: string,
  patch: string,
  liveText: string,
  reads: readonly Snapshot[]
): EditResult => {
  const live = toLines(liveText);
  const parsed = parseEdit(patch, {
    // A row's leading digits are the file's own where the file, or any read of it, already
    // begins that line with digits - a schedule, a verse table, a numbered grid.
    lineAt: (line) =>
      [live[line - 1], ...reads.map((read) => recordedAt(read, line))].find(
        (text) => text !== undefined && looksNumbered(text)
      )
  });
  if (!parsed.ok) return { ok: false, refusal: parsed.failure };
  const notes = [...parsed.forgave];
  const ops = parsed.ops;

  const lineOps = ops;
  const newest = [...reads].sort((left, right) => right.at - left.at);
  const splices: Splice[] = [];
  const registers = new Map<string, readonly string[]>();

  // Registers are filled from the live file before anything moves, so a CUT and the PUT that pastes
  // it can be written in either order and mean the same thing.
  const placements = new Map<EditOp, Placement>();

  for (const op of lineOps) {
    const anySnapshot = newest[0];
    if (!anySnapshot) {
      const asked =
        op.kind === 'replace' || op.kind === 'cut'
          ? { from: op.from, to: op.to }
          : { from: op.at, to: op.at };
      return refuse('unseen', {
        message: `No read of ${path} is on record for this task, so the line numbers in this patch are not from anything you have been shown here. The file has ${live.length} lines. Read the lines you are aiming at with file_read, using startLine and endLine - that is what puts them on record here - and send the patch again. This is what is actually at the lines you addressed:\n\n${numberedWindow(live, asked, CONTEXT_LINES)}`,
        fix: `file_read ${path} startLine ${Math.max(1, asked.from - CONTEXT_LINES)} endLine ${asked.to + CONTEXT_LINES}`
      });
    }

    // The block operation needs the file's own shape, so it is resolved against the read rather
    // than against the addressed numbers alone.
    let span: { from: number; to: number; closed?: boolean } | undefined;
    let against: Snapshot | undefined;
    for (const snapshot of newest) {
      const candidate = spanOf(op, snapshot);
      if (!candidate) continue;
      if (shown(snapshot, candidate.from, candidate.to) === undefined) continue;
      span = candidate;
      against = snapshot;
      break;
    }
    if (!span || !against) {
      const asked = spanOf(op, anySnapshot) ?? { from: 0, to: 0 };
      const at = op.kind === 'insert' || op.kind === 'paste' ? op.at : asked.from;
      if (at > live.length + 1 || at < 1)
        return refuse('out_of_range', {
          message: `${path} has ${live.length} lines, and this patch addresses line ${at}. The last lines of the file are:\n\n${numberedWindow(live, { from: live.length, to: live.length }, CONTEXT_LINES)}`,
          fix: `address a line between 1 and ${live.length}`
        });
      return refuse('unseen', {
        message: `No read has shown you ${path} at ${sayRange(asked.from, asked.to)}, so editing there would land on whatever happens to be at those numbers. Read that range with file_read, using startLine and endLine - that is what puts it on record here, and sending this patch again without doing so is refused again. Here is what is actually there, to check your edit against:\n\n${numberedWindow(live, asked, CONTEXT_LINES)}`,
        fix: `file_read ${path} startLine ${Math.max(1, asked.from - CONTEXT_LINES)} endLine ${asked.to + CONTEXT_LINES}`
      });
    }
    if (op.kind === 'block' && span.closed === false)
      return refuse('block_open', {
        message: `The block opening at ${path} line ${op.at} does not close within the lines you have been shown, so replacing it would either stop short or run past its end. Read further, or replace an explicit range with PUT ${op.at}.=M:. What was read there:\n\n${numberedWindow(against.lines, { from: op.at - against.startLine + 1, to: op.at - against.startLine + 1 }, CONTEXT_LINES)}`,
        fix: `read past line ${against.startLine + against.lines.length - 1} with file_read, or replace an explicit range with PUT ${op.at}.=M:`
      });

    /*
     * An insert hangs off ONE line, and one line is very often `}` or a blank - not unique enough
     * to find again if the file has shifted. So the anchor for an insert is widened to the lines
     * around it before it is relocated, and the insertion point is derived back from wherever that
     * run landed. Without this, an insert is the one operation a shifted file cannot recover.
     */
    let placed: Placement | undefined;
    if (op.kind === 'insert' || op.kind === 'paste') {
      const direct = placeRange(live, against, op.at, op.at);
      if (direct && !direct.note) placed = direct;
      else {
        const low = Math.max(against.startLine, op.at - 2);
        const high = Math.min(against.startLine + against.lines.length - 1, op.at + 2);
        const wide = placeRange(live, against, low, high);
        if (wide)
          placed = {
            from: wide.from + (op.at - low),
            to: wide.from + (op.at - low),
            ...(wide.note ? { note: wide.note } : {})
          };
        else placed = direct;
      }
    } else placed = placeRange(live, against, span.from, span.to);

    if (!placed)
      return refuse('moved', {
        message: `${path} has changed since you read it, and the lines you read at ${sayRange(span.from, span.to)} are no longer there - that text is gone or now appears more than once, so there is no unambiguous place for this edit. Nothing was written. The file now reads:\n\n${numberedWindow(live, span, CONTEXT_LINES)}`,
        fix: `file_read ${path} startLine ${Math.max(1, span.from - CONTEXT_LINES)} endLine ${span.to + CONTEXT_LINES}, and address what it shows`
      });
    if (placed.note) notes.push(placed.note);

    if (op.anchor !== undefined) {
      const checked = placeWithAnchor(path, live, against, newest, span.from, placed, op.anchor);
      if ('message' in checked) return refuse(placed.note ? 'moved' : 'evidence', checked);
      if (checked.note) notes.push(checked.note);
      if (op.kind === 'block' && checked.from !== placed.from) {
        /*
         * A block that opens somewhere else is a DIFFERENT block: its closing line is wherever the
         * brackets balance from the corrected opening, not the old span shifted. So the span is
         * derived again from the read at the corrected line and placed again, and a shape that does
         * not close or does not match there is a refusal, never a shorter replacement.
         */
        const found = spanOf(op, against, checked.from);
        if (!found || found.closed === false)
          return refuse('block_open', {
            message: `Your - row is at ${checked.from}, not ${op.at}, and the block opening at ${checked.from} does not close within the lines you have been shown of ${path}, so nothing was written. Read further, or replace an explicit range with PUT ${checked.from}.=M:. The file reads:\n\n${numberedWindow(live, { from: checked.from, to: checked.from }, CONTEXT_LINES)}`,
            fix: `replace an explicit range with PUT ${checked.from}.=M:`
          });
        const moved = placeRange(live, against, found.from, found.to);
        if (!moved || moved.note)
          return refuse('moved', {
            message: `Your - row is at ${checked.from}, not ${op.at}, but the block opening there no longer reads as it did when you read it, so nothing was written. The file now reads:\n\n${numberedWindow(live, found, CONTEXT_LINES)}`,
            fix: 'drop the - row and address the numbers shown below'
          });
        placed = moved;
      } else placed = checked;
    } else if (op.kind === 'replace' || op.kind === 'cut') {
      const checked = placeWithEvidence(path, live, against, placed, op.old);
      if ('message' in checked) return refuse(placed.note ? 'moved' : 'evidence', checked);
      if (checked.note) notes.push(checked.note);
      placed = checked;
    }
    if (op.kind === 'replace' && sameLines(live.slice(placed.from - 1, placed.to), op.body))
      notes.push(
        `${sayRange(placed.from, placed.to)} already read that way; the patch changed nothing there`
      );
    placements.set(op, placed);
    if (op.kind === 'cut' && op.register) {
      if (registers.has(op.register))
        return refuse('register', {
          message: `Two CUTs in this patch both hold their lines as @${op.register}, so the first block would be deleted and never pasted back. Give them different names - CUT ... @${op.register}1 and CUT ... @${op.register}2 - and paste each one. Nothing was written. The second block reads:\n\n${numberedWindow(live, placed, 0)}`,
          fix: `name the two registers apart, @${op.register}1 and @${op.register}2, and paste each`
        });
      registers.set(op.register, live.slice(placed.from - 1, placed.to));
    }
  }

  for (const [order, op] of lineOps.entries()) {
    const placed = placements.get(op);
    if (!placed) continue;
    switch (op.kind) {
      case 'replace':
      case 'block':
        splices.push({
          start: placed.from - 1,
          remove: placed.to - placed.from + 1,
          insert: op.body,
          order,
          kind: op.kind
        });
        break;
      case 'cut':
        splices.push({
          start: placed.from - 1,
          remove: placed.to - placed.from + 1,
          insert: [],
          order,
          kind: op.kind
        });
        break;
      case 'insert':
        splices.push({
          start: op.side === 'before' ? placed.from - 1 : placed.from,
          remove: 0,
          insert: op.body,
          order,
          kind: op.kind
        });
        break;
      case 'paste': {
        const value = registers.get(op.register);
        if (!value)
          return refuse('register', {
            message: [
              `@${op.register} was never filled: a PUT that pastes a register needs a CUT N.=M @${op.register} in the same patch. Nothing was written.`,
              'To write NEW lines, leave the register off and give the lines in the body:',
              `  PUT ${op.side === 'before' ? '<' : '>'}${op.at}:`,
              '  <the lines you want written>',
              `To MOVE lines you have already read, cut them first and paste in the same patch:`,
              `  CUT 40.=52 @${op.register}`,
              `  PUT ${op.side === 'before' ? '<' : '>'}${op.at} @${op.register}`
            ].join('\n'),
            fix: `to write new lines, PUT ${op.side === 'before' ? '<' : '>'}${op.at}: with the lines in the body and no @${op.register}; to move lines, CUT N.=M @${op.register} in the same patch as PUT ${op.side === 'before' ? '<' : '>'}${op.at} @${op.register}`
          });
        splices.push({
          start: op.side === 'before' ? placed.from - 1 : placed.from,
          remove: 0,
          insert: value,
          order,
          kind: op.kind
        });
        break;
      }
    }
  }

  /*
   * Applied from the end of the file backwards, so every range still names the line it named when
   * the model wrote it. Ranges address the file as it was READ, never the file as the patch's own
   * earlier operations left it - which is the counting error this format exists to remove, and
   * which a front-to-back applier would silently reintroduce on every multi-hunk patch.
   */
  const sorted = [...splices].sort((left, right) =>
    left.start === right.start ? right.order - left.order : right.start - left.start
  );
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const later = sorted[index] as Splice;
    const earlier = sorted[index + 1] as Splice;
    if (earlier.start + earlier.remove > later.start) {
      const low = earlier.start + 1;
      const high = Math.max(earlier.start + earlier.remove, later.start + later.remove, low);
      return refuse('overlap', {
        message: `Two operations in this patch touch the same lines of ${path} (${earlier.start + 1} and ${later.start + 1}). Ranges name the lines of the file you read and must not overlap; write one operation PUT ${low}.=${high}: covering both, where ${low} is the lower start and ${high} the higher end, with the body of both. Nothing was written.`,
        fix: `write one operation PUT ${low}.=${high}: with the body of both`
      });
    }
  }

  for (const op of lineOps) {
    if (op.anchor !== undefined || ((op.kind === 'replace' || op.kind === 'cut') && op.old.length))
      continue;
    const at = op.kind === 'replace' || op.kind === 'cut' ? op.from : op.at;
    return refuse('evidence', {
      message: `The operation at patch row ${op.row} has no content anchor. Nothing was written. Add one - row quoting the start of line ${at} from your read (8+ non-space characters, or the whole line if shorter). This checks which content you intended to edit. The file currently reads:\n\n${numberedWindow(live, { from: at, to: at }, CONTEXT_LINES)}`,
      fix: `add a - row quoting the intended line ${at} below the operation, before any + rows`
    });
  }

  /*
   * A file whose every line ends CRLF keeps ending that way. The parser takes the CR off every
   * patch row and the display never showed one, so a body row arrives bare and would land as the
   * one LF line in a CRLF file - invisible in the read, wrong on disk, and reported as a clean
   * write. The split keeps the CR on each line, so an inserted row gets one wherever a newline
   * will follow it; the last element of the split has no newline after it and gets none. A file
   * that already mixes its endings is left to mix them.
   */
  const newlines = (liveText.match(/\n/g) ?? []).length;
  const crlf = newlines > 0 && (liveText.match(/\r\n/g) ?? []).length === newlines;
  const out = [...live];
  const wrote: Array<{ from: number; to: number }> = [];
  let tailInserted = false;
  for (const [index, splice] of sorted.entries()) {
    out.splice(
      splice.start,
      splice.remove,
      ...(crlf ? splice.insert.map((row) => `${row}\r`) : splice.insert)
    );
    // The first splice is the lowest in the file, so it is the only one that can reach the end.
    if (index === 0)
      tailInserted = splice.insert.length > 0 && splice.start + splice.insert.length === out.length;
    // The echo below reports the NEW numbering, and splices run back to front, so everything
    // already recorded sits after this one and shifts by exactly this operation's delta.
    const delta = splice.insert.length - splice.remove;
    for (const region of wrote) {
      region.from += delta;
      region.to += delta;
    }
    if (splice.insert.length)
      wrote.unshift({ from: splice.start + 1, to: splice.start + splice.insert.length });
    else wrote.unshift({ from: Math.max(1, splice.start), to: Math.max(1, splice.start + 1) });
  }
  // Nothing follows the last element of the split, so a row this patch put there gets no CR; a
  // last line the file already ended with a bare CR keeps it, because that is the file's own.
  if (crlf && tailInserted) out[out.length - 1] = (out[out.length - 1] as string).slice(0, -1);
  /*
   * The same splices again, front to back, in the two numberings the ledger needs.
   *
   * This is what the record is carried across, and it is derived here rather than diffed back out
   * of the two texts because this function is the one place that knows exactly what it moved. A
   * splice that inserts and removes nothing at line N reports `oldTo = oldFrom - 1`, which is the
   * shape an insertion has everywhere in this vertical.
   */
  const changed: LineChange[] = [];
  let moved = 0;
  for (const splice of [...splices].sort((left, right) =>
    left.start === right.start ? left.order - right.order : left.start - right.start
  )) {
    const oldFrom = splice.start + 1;
    const newFrom = oldFrom + moved;
    changed.push({
      oldFrom,
      oldTo: splice.start + splice.remove,
      newFrom,
      newTo: newFrom + splice.insert.length - 1
    });
    moved += splice.insert.length - splice.remove;
  }
  // De-duplicated because one operation can be forgiven twice for the same reason - a relocation
  // reported once by the placement and once again by the evidence check that passed it through -
  // and a result that says the same sentence twice reads as two different findings.
  return {
    ok: true,
    text: out.join('\n'),
    wrote,
    changed,
    renumbered: renumberingOf(changed),
    notes: [...new Set(notes)]
  };
};

export { normaliseLine, numberedWindow };
