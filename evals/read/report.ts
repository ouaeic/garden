/**
 * The table, the gates, and the committed baseline.
 *
 * The shape is `evals/context-quality/report.ts`'s, deliberately and almost line for line: a
 * provenance pair on every run, a stamp under `$stamp` carrying the garden and the rig digest that
 * accepted the numbers, exact gates on integer-derived columns and a band on nothing, and a set of
 * checks that fail SEPARATELY from the baseline because each of them exists for a defect that
 * produces a plausible number rather than an error. Inventing a second reporting shape for a second
 * read-side rig would mean two formats to keep honest and one of them going stale.
 *
 * ── The gate that makes this an instrument ────────────────────────────────────────────────────
 *
 * `separation` asserts, by name, that the trajectory which reads narrowly and edits often scores at
 * least a tenth of the one that reads everything for one edit. A counter that has stopped reading
 * its input satisfies a baseline perfectly - it prints the accepted number for ever - and fails
 * this. It is the same defect `evals/context-quality` calls a frozen column and answers with
 * `starved`, and it is the reason the two trajectories exist at all: an instrument never seen to
 * move is not an instrument.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { buildIdentity } from '../../apps/worker/src/build-identity.js';
import { largestCorpusFileLines, pool, type Measurement, type Pooled } from './measure.js';

/* ------------------------------------------------------------- what produced a number, exactly */

export interface BaselineStamp {
  readonly acceptedAt: string;
  readonly version: string;
  readonly commit: string | null;
  readonly rig: string;
}

export const BASELINE_STAMP_KEY = '$stamp';

/**
 * The files that decide every number this directory prints.
 *
 * `harness.ts` is in the list and is not in this directory, which is the one difference from
 * `evals/context-quality`'s digest and is deliberate: the ledger itself lives there, so a change to
 * how a displayed line is counted has to move this digest or the stamp would vouch for an
 * instrument that had been rebuilt underneath it.
 */
const RIG_SOURCES: readonly URL[] = [
  new URL('measure.ts', import.meta.url),
  new URL('report.ts', import.meta.url),
  new URL('trajectories.ts', import.meta.url),
  new URL('../harness.ts', import.meta.url)
];

const rigDigest = (): string => {
  try {
    const hash = createHash('sha256');
    // A separator that cannot occur in TypeScript source, so text shifted across the boundary
    // between two files does not hash the same as text that never moved.
    for (const file of RIG_SOURCES) hash.update(`${readFileSync(file, 'utf8')}\0`);
    return hash.digest('hex').slice(0, 12);
  } catch {
    // Named as the absence it is. A plausible-looking digest that means nothing is worse.
    return 'unreadable';
  }
};

let stamped: Omit<BaselineStamp, 'acceptedAt'> | null = null;

export const rigIdentity = (): Omit<BaselineStamp, 'acceptedAt'> =>
  (stamped ??= { ...buildIdentity(), rig: rigDigest() });

export const identityLabel = (identity: Omit<BaselineStamp, 'acceptedAt'>): string =>
  `garden ${identity.version} at ${identity.commit ?? 'an uncommitted tree'}, rig ${identity.rig}`;

export const stampOf = (baseline: Baseline | undefined): BaselineStamp | null => {
  const row = (baseline as Record<string, unknown> | undefined)?.[BASELINE_STAMP_KEY];
  if (typeof row !== 'object' || row === null) return null;
  const { acceptedAt, version, commit, rig } = row as Record<string, unknown>;
  if (typeof acceptedAt !== 'string' || typeof version !== 'string' || typeof rig !== 'string')
    return null;
  if (commit !== null && typeof commit !== 'string') return null;
  return { acceptedAt, version, commit, rig };
};

/* ---------------------------------------------------------------------------- the committed row */

export interface BaselineRow {
  readonly displayedLines: number;
  readonly landedEdits: number;
  /** Null is a committed fact: this row landed no edit and has no quotient. */
  readonly linesPerEdit: number | null;
}

export type Baseline = Record<string, BaselineRow>;

/**
 * The committed rows, and why the general fixture corpus is not among them.
 *
 * DECLARED TRAJECTORIES ONLY. The corpus rows are printed, pooled and argued with, and they are
 * already gated one-sidedly by `evals/report.ts` inside `pnpm eval` - which CONTRIBUTING keeps out
 * of `pnpm check` on purpose, because "a change to a step count is a decision to make, not a build
 * to fix". Committing them here too would put the same rows behind two gates, one of them a build
 * gate, and would let this rig become the back door that quietly moved `pnpm eval` into `pnpm
 * check`. What this rig commits is what this rig constructs: six trajectories over files it owns,
 * at sizes chosen so the bounds have something to bind.
 */
export const baselineFrom = (measurements: readonly Measurement[]): Baseline => {
  const baseline: Baseline = {
    ...({
      [BASELINE_STAMP_KEY]: { acceptedAt: new Date().toISOString(), ...rigIdentity() }
    } as unknown as Baseline)
  };
  for (const row of measurements.filter((row) => row.source === 'trajectory'))
    baseline[row.id] = {
      displayedLines: row.displayedLines,
      landedEdits: row.landedEdits,
      linesPerEdit: row.linesPerEdit === null ? null : Math.round(row.linesPerEdit * 100) / 100
    };
  return baseline;
};

/**
 * What counts as a regression, and why nothing here gets a band.
 *
 * Every column is a count of lines or of calls. Nothing in this measurement is a function of the
 * clock, of the catalogue, or of anything else that drifts under unrelated work - which is what the
 * two-per-cent band in `evals/report.ts` is calibrated to and why it does not belong here. A row
 * that moves by one line moved because something changed what garden displays, and that is a
 * decision somebody should have to re-accept.
 *
 * One-sided where the direction has a meaning: displaying MORE per landed edit is the regression.
 * Fewer displayed lines for the same edits is the improvement this whole lane is about, and a gate
 * that failed on it would be a gate against the work.
 */
export const check = (row: Measurement, baseline: Baseline | undefined): readonly string[] => {
  const failures: string[] = [];
  if (row.error) failures.push(`the run threw: ${row.error}`);
  if (row.claimMismatches)
    failures.push(
      `${row.claimMismatches} read(s) displayed a different number of rows than the range they reported, so one of the two is not describing what was shown`
    );
  // The declaration, checked before the baseline and independently of it. A committed baseline can
  // only say what happened last time; this says what the row was designed to do.
  if (row.declaredDisplayedLines !== null && row.displayedLines !== row.declaredDisplayedLines)
    failures.push(
      `displayed ${row.displayedLines} lines, and this trajectory declares ${row.declaredDisplayedLines}`
    );
  if (row.declaredLandedEdits !== null && row.landedEdits !== row.declaredLandedEdits)
    failures.push(
      `landed ${row.landedEdits} edit(s), and this trajectory declares ${row.declaredLandedEdits}`
    );
  /*
   * The bounded row's declaration, which is a BOUND and not a count: the read was cut short, and it
   * showed some of the file and not all of it. Written this way rather than as `shows: 800` so that
   * lowering the display cap - fewer lines per edit, the improvement this rig is for - passes, and
   * only the baseline below, which is one-sided, catches a cap that rises.
   */
  if (row.boundedReadCeiling !== null) {
    if (row.truncatedReads < 1)
      failures.push(
        `reads a ${row.boundedReadCeiling}-line file and no read came back cut short, so the display bound did not fire and this row measures nothing about it`
      );
    if (row.displayedLines >= row.boundedReadCeiling)
      failures.push(
        `displayed ${row.displayedLines} lines of a ${row.boundedReadCeiling}-line file, so the whole file reached the model and the display bound bound nothing`
      );
    if (row.displayedLines < 1)
      failures.push(
        'displayed no lines at all, which is a dead end rather than a bound: the read has to show something for the edit after it to rest on anything'
      );
  }
  const expected = baseline?.[row.id];
  if (!expected) return failures;
  if (row.landedEdits < expected.landedEdits)
    failures.push(
      `landed ${row.landedEdits} edit(s), accepted ${expected.landedEdits}: this turn lands less than it did`
    );
  if (row.displayedLines > expected.displayedLines)
    failures.push(
      `displayed ${row.displayedLines} lines, accepted ${expected.displayedLines}: this turn shows the model more than it did`
    );
  if (
    row.linesPerEdit !== null &&
    expected.linesPerEdit !== null &&
    row.linesPerEdit > expected.linesPerEdit
  )
    failures.push(
      `${row.linesPerEdit.toFixed(2)} displayed lines per landed edit, accepted ${expected.linesPerEdit.toFixed(2)}`
    );
  return failures;
};

/* ------------------------------------------------------------------- the gates on the rig itself */

/** The two rows the whole falsifiability claim rests on, named here rather than found by index. */
export const NARROW_ROW = 'narrow-reads-and-an-edit-each-time';
export const WIDE_ROW = 'a-whole-file-read-for-a-one-line-edit';

/**
 * At least this much apart, or the instrument is not one.
 *
 * Ten rather than the forty the two rows are designed to produce, so that a real change to the
 * display bound - which would move both rows - is a re-accepted baseline rather than a failure
 * here, while a counter that has gone flat still fails. The two are 40x apart today, which the
 * table prints.
 */
export const REQUIRED_SEPARATION = 10;

export const rigFailures = (measurements: readonly Measurement[]): readonly string[] => {
  const failures: string[] = [];
  const trajectories = measurements.filter((row) => row.source === 'trajectory');
  const narrow = trajectories.find((row) => row.id === NARROW_ROW);
  const wide = trajectories.find((row) => row.id === WIDE_ROW);
  if (!narrow || !wide)
    failures.push(
      `the two rows this rig's separation check is written against (${NARROW_ROW}, ${WIDE_ROW}) were not both run, so nothing here has shown the instrument can move`
    );
  else if (narrow.linesPerEdit === null || wide.linesPerEdit === null)
    failures.push('one of the two separation rows landed no edit, so the two cannot be compared');
  else if (wide.linesPerEdit < narrow.linesPerEdit * REQUIRED_SEPARATION)
    failures.push(
      `${wide.id} scores ${wide.linesPerEdit.toFixed(2)} and ${narrow.id} scores ${narrow.linesPerEdit.toFixed(2)}, which is ${(wide.linesPerEdit / Math.max(narrow.linesPerEdit, 1e-9)).toFixed(1)}x rather than the ${REQUIRED_SEPARATION}x this rig requires. A number that cannot separate reading everything from reading a window is not measuring the read side.`
    );
  const scored = trajectories.flatMap((row) =>
    row.linesPerEdit === null ? [] : [row.linesPerEdit]
  );
  if (scored.length > 1 && new Set(scored).size === 1)
    failures.push(
      `every trajectory scored ${scored[0]?.toFixed(2)}. A column nothing can move is indistinguishable from a column nothing is reading.`
    );
  if (trajectories.length && !trajectories.some((row) => row.windowedReads > 0))
    failures.push(
      'no trajectory took the windowed read path, so this run says nothing about the arm that makes a narrow read possible'
    );
  if (trajectories.length && !trajectories.some((row) => row.truncatedReads > 0))
    failures.push(
      'no trajectory reached the display bound, so this run says nothing about what an unwindowed read of a large file actually shows'
    );
  return failures;
};

/* ------------------------------------------------------------------------------- the printing */

const pad = (value: string, width: number): string => value.padEnd(width);
const padStart = (value: string, width: number): string => value.padStart(width);
const quotient = (value: number | null): string => (value === null ? 'no edit' : value.toFixed(2));

const table = (
  title: string,
  rows: readonly Measurement[],
  baseline: Baseline | undefined
): string[] => {
  const lines: string[] = ['', title, '='.repeat(title.length)];
  const width = Math.max(24, ...rows.map((row) => row.id.length));
  const header = [
    pad('row', width),
    padStart('reads', 6),
    padStart('windowed', 9),
    padStart('cut', 4),
    padStart('displayed', 10),
    padStart('edits', 6),
    padStart('lines/edit', 11),
    padStart('echo', 5),
    padStart('calls', 6)
  ].join(' ');
  lines.push(header, '-'.repeat(header.length));
  for (const row of rows)
    lines.push(
      [
        pad(row.id, width),
        padStart(String(row.reads), 6),
        padStart(String(row.windowedReads), 9),
        padStart(String(row.truncatedReads), 4),
        padStart(row.displayedLines.toLocaleString('en-GB'), 10),
        padStart(String(row.landedEdits), 6),
        padStart(quotient(row.linesPerEdit), 11),
        padStart(String(row.echoLines), 5),
        padStart(String(row.modelCalls), 6)
      ].join(' ')
    );
  for (const row of rows)
    for (const failure of check(row, baseline)) lines.push(`  ! ${row.id}: ${failure}`);
  return lines;
};

const poolLines = (label: string, figures: Pooled): string[] => [
  `${label}: ${quotient(figures.pooled)} displayed lines per landed edit, pooled over n=${figures.turnsWithEdits} turns that landed one (${figures.displayedLines.toLocaleString('en-GB')} lines / ${figures.landedEdits} edits).`,
  `  Mean of the per-turn quotients over the same n: ${quotient(figures.meanOfTurns)}. Turns that displayed lines and landed nothing, excluded from both: ${figures.turnsReadingWithoutEditing}.`
];

export const render = (
  measurements: readonly Measurement[],
  baseline: Baseline | undefined
): string => {
  const lines: string[] = [];
  const identity = rigIdentity();
  const stamp = stampOf(baseline);
  lines.push(`This run: ${identityLabel(identity)}.`);
  lines.push(
    stamp
      ? `Baseline: accepted ${stamp.acceptedAt.slice(0, 10)} by ${identityLabel(stamp)}.`
      : 'Baseline: unstamped - accept it once to record what measured it.'
  );
  if (stamp && (stamp.commit !== identity.commit || stamp.rig !== identity.rig))
    lines.push(
      'Note: the committed numbers were measured by a different revision of garden or of this rig. A row that moved may have moved for that reason.'
    );

  const trajectories = measurements.filter((row) => row.source === 'trajectory');
  const corpus = measurements.filter((row) => row.source === 'corpus');

  if (trajectories.length) {
    lines.push(
      ...table(
        'Declared trajectories: what a read costs per edit, by shape',
        trajectories,
        baseline
      )
    );
    const narrow = trajectories.find((row) => row.id === NARROW_ROW)?.linesPerEdit ?? null;
    const wide = trajectories.find((row) => row.id === WIDE_ROW)?.linesPerEdit ?? null;
    lines.push('');
    lines.push(
      narrow !== null && wide !== null && narrow > 0
        ? `Separation: reading everything for one edit costs ${(wide / narrow).toFixed(1)}x what reading a window for each edit costs, on the same file, the same loop and the same tools. The gate requires ${REQUIRED_SEPARATION}x.`
        : 'Separation: not measurable on this run - see the failures above.'
    );
    lines.push(...poolLines('Trajectories pooled', pool(trajectories)));
  }

  if (corpus.length) {
    const touched = corpus.filter((row) => row.reads > 0 || row.landedEdits > 0);
    lines.push(
      ...table(
        `The general fixture corpus (${corpus.length} fixtures, ${touched.length} of them touching a file)`,
        touched,
        baseline
      )
    );
    lines.push('');
    lines.push(...poolLines('Corpus', pool(corpus)));
    const largest = largestCorpusFileLines();
    const patches = corpus.reduce((total, row) => total + row.patchEdits, 0);
    const landed = corpus.reduce((total, row) => total + row.landedEdits, 0);
    lines.push(
      `  What that figure is about: the largest file any of these ${corpus.length} fixtures puts in a workspace is ${largest.path} at ${largest.lines} lines, and of the ${corpus.reduce((total, row) => total + row.reads, 0)} reads that returned, ${corpus.reduce((total, row) => total + row.windowedReads, 0)} took the windowed path. This corpus cannot reach the display bound and cannot tell a narrow reader from a wide one, so its number is a fact about the corpus and not about garden on real files. The trajectories above are where this axis is actually measured, and they are the only rows this rig commits a baseline for.`
    );
    lines.push(
      `  And what the denominator is made of: ${patches} of the ${landed} landed edits are file_patch, ${landed - patches} are whole-file file_write. A denominator of writes describes a corpus that CREATES files; the edit format is priced on one that CHANGES them.`
    );
  }

  const failures = rigFailures(measurements);
  if (failures.length) {
    lines.push('', 'THE RIG ITSELF', '==============');
    for (const failure of failures) lines.push(`  ! ${failure}`);
  }

  return `${lines.join('\n')}\n`;
};
