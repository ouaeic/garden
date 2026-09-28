/**
 * The measurement: displayed lines per landed edit, off garden's own loop, per turn.
 *
 * ── What the number is ────────────────────────────────────────────────────────────────────────
 *
 * Numerator: rows of file text a `file_read` rendered into a tool result. Not the file's length,
 * not the window that was asked for - what `renderNumbered` produced and the model was sent.
 * Denominator: edits that reached disk. A `file_patch` hunk that applied, or a `file_write` that
 * returned. A refused patch lands nothing and is not in the denominator; it also displays nothing
 * and is not in the numerator, so a turn that fights its editor scores worse, which is correct.
 *
 * ── Why it is the number the edit-format case turns on ────────────────────────────────────────
 *
 * The line dialect buys OUTPUT characters per edit and pays for them in INPUT: numbering is charged
 * on every request after a read for as long as the file stays in the window. `evals/arms/price.ts`
 * computes the break-even as a number of EDITS PER TURN and has to assume how many lines a turn
 * reads to land one - `MIN_CALLS_PER_EDIT = 3`, read then edit then finish, one whole file per
 * edit. That assumption has never been measured anywhere in this repository. This is the
 * measurement, and it can be handed to `breakEven` instead of the assumption.
 *
 * ── Why it is measured off the event stream ───────────────────────────────────────────────────
 *
 * `harness.readLedgerOf` reads `tool_result` events, which carry what the tool returned before the
 * context layer decides how much of it to keep. So this counts what garden CHOSE TO DISPLAY, not
 * what survived a later squeeze. Both are worth knowing; the second is `evals/context-quality`'s
 * question and measuring it here would silently answer a different one.
 */
import { forgetReads } from '../../apps/worker/src/edit/snapshots.js';
import { linesPerEdit, runFixture, type ReadLedger } from '../harness.js';
import { fixtures } from '../fixtures.js';
import {
  boundedReadCeiling,
  declaredDisplayedLines,
  declaredLandedEdits,
  fixtureFor,
  type Trajectory
} from './trajectories.js';

export interface Measurement {
  readonly id: string;
  /** A row this rig declared, or a row from the general fixture corpus. */
  readonly source: 'trajectory' | 'corpus';
  readonly reads: number;
  /** Of those, the ones that named a range - the arm `workspace.ts:257` takes. */
  readonly windowedReads: number;
  /** Reads the display bound cut short. */
  readonly truncatedReads: number;
  readonly displayedLines: number;
  /** Rows the patch echoes displayed. Beside the number, never inside it. */
  readonly echoLines: number;
  readonly landedEdits: number;
  /**
   * Of those, the ones that were `file_patch` rather than `file_write`.
   *
   * Split because the two are priced completely differently and a total hides it: a patch sends
   * only the lines it changes and needs the file to have been displayed first, and a whole-file
   * write sends the file and can be made with no read at all. A denominator made entirely of writes
   * describes a corpus that creates files, not one that edits them.
   */
  readonly patchEdits: number;
  /** The number. Null where the turn landed no edit; see `harness.linesPerEdit`. */
  readonly linesPerEdit: number | null;
  /** What the trajectory said it would display and land, before it ran. Null for a corpus row. */
  readonly declaredDisplayedLines: number | null;
  readonly declaredLandedEdits: number | null;
  /**
   * For a row whose read is cut short by the display bound: the lines the file has.
   *
   * The declaration that stands in for an exact count on that row. Null everywhere else, including
   * on every corpus row. See `trajectories.boundedReadCeiling`.
   */
  readonly boundedReadCeiling: number | null;
  readonly modelCalls: number;
  /** Reads whose content and whose stated range disagreed. Must be zero; see `ReadLedger`. */
  readonly claimMismatches: number;
  readonly error: string | null;
}

const from = (
  id: string,
  source: Measurement['source'],
  ledger: ReadLedger,
  modelCalls: number,
  error: string | null,
  declared: { displayed: number | null; landed: number | null; boundedCeiling: number | null }
): Measurement => ({
  id,
  source,
  reads: ledger.reads.length,
  windowedReads: ledger.reads.filter((read) => read.windowed).length,
  truncatedReads: ledger.reads.filter((read) => read.truncated).length,
  displayedLines: ledger.displayedLines,
  echoLines: ledger.echoLines,
  landedEdits: ledger.landedEdits,
  patchEdits: ledger.edits.filter((edit) => edit.tool === 'file_patch').length,
  linesPerEdit: linesPerEdit(ledger),
  declaredDisplayedLines: declared.displayed,
  declaredLandedEdits: declared.landed,
  boundedReadCeiling: declared.boundedCeiling,
  modelCalls,
  claimMismatches: ledger.claimMismatches,
  error
});

/**
 * A cold snapshot store before every row, which is what production has and this harness does not.
 *
 * `apps/worker/src/edit/snapshots.ts` keys its record by task id and every fixture in this rig
 * shares one - `harness.ts:168` - so without this a patch could land on lines a PREVIOUS row's read
 * put in front of the model, and the row would report an edit it had no evidence for. In production
 * every task has its own id and that cannot happen. `selftest.ts` measures the store's influence by
 * running the whole set again in reverse; this removes it.
 */
const cold = <T>(run: () => Promise<T>): Promise<T> => {
  forgetReads();
  return run();
};

export const measureTrajectory = async (trajectory: Trajectory): Promise<Measurement> => {
  const outcome = await cold(() => runFixture(fixtureFor(trajectory)));
  return from(trajectory.id, 'trajectory', outcome.readLedger, outcome.modelCalls, outcome.error, {
    displayed: declaredDisplayedLines(trajectory),
    landed: declaredLandedEdits(trajectory),
    boundedCeiling: boundedReadCeiling(trajectory)
  });
};

/**
 * The general fixture corpus, run for its read ledger alone.
 *
 * Every row, including the ones that touch no file: a corpus number computed over the subset that
 * happens to read something would be a number about a subset somebody chose. Rows with no read and
 * no edit contribute nothing to either total and are dropped from the printed table only.
 */
export const measureCorpus = async (): Promise<readonly Measurement[]> => {
  const rows: Measurement[] = [];
  for (const fixture of fixtures) {
    // Sequentially, like `evals/run.ts`: the loop is what is being measured.
    const outcome = await cold(() => runFixture(fixture));
    rows.push(
      from(fixture.id, 'corpus', outcome.readLedger, outcome.modelCalls, outcome.error, {
        displayed: null,
        landed: null,
        boundedCeiling: null
      })
    );
  }
  return rows;
};

/* ------------------------------------------------------------------------------ the roll-up */

export interface Pooled {
  /** Turns that landed at least one edit. The `n` of the headline figure. */
  readonly turnsWithEdits: number;
  /** Turns that displayed lines and landed nothing. Counted, never averaged in. */
  readonly turnsReadingWithoutEditing: number;
  readonly displayedLines: number;
  readonly landedEdits: number;
  /**
   * Total displayed over total landed, across every turn that landed an edit.
   *
   * The headline, because it is the quantity a bill is made of: a turn that landed eight edits
   * after one read and a turn that landed one after eight reads are not two equally weighted
   * opinions, they are different amounts of work.
   */
  readonly pooled: number | null;
  /**
   * The mean of the per-turn quotients over the same turns.
   *
   * Printed beside `pooled` and never instead of it. Where the two disagree, the sample is
   * dominated by turns of very different sizes and both numbers are worth having.
   */
  readonly meanOfTurns: number | null;
}

/**
 * The roll-up over a set of turns.
 *
 * Turns with no landed edit are excluded from BOTH figures and counted in their own field. There is
 * no honest quotient for them: the reads were not free, and there is no edit to charge them to.
 */
export const pool = (measurements: readonly Measurement[]): Pooled => {
  const withEdits = measurements.filter((row) => row.landedEdits > 0);
  const readingOnly = measurements.filter((row) => row.landedEdits === 0 && row.displayedLines > 0);
  const displayedLines = withEdits.reduce((total, row) => total + row.displayedLines, 0);
  const landedEdits = withEdits.reduce((total, row) => total + row.landedEdits, 0);
  return {
    turnsWithEdits: withEdits.length,
    turnsReadingWithoutEditing: readingOnly.length,
    displayedLines,
    landedEdits,
    pooled: landedEdits === 0 ? null : displayedLines / landedEdits,
    meanOfTurns: withEdits.length
      ? withEdits.reduce((total, row) => total + (row.linesPerEdit ?? 0), 0) / withEdits.length
      : null
  };
};

/**
 * The largest file any fixture puts in a workspace, in lines.
 *
 * Read off the fixture declarations rather than asserted, because it is the whole reason the corpus
 * figure below cannot be quoted as garden's read cost on real work. A corpus whose largest file is
 * three lines cannot reach the 800-line display cap, cannot make a windowed read cheaper than a
 * whole one, and cannot tell a narrow reader from a wide one.
 */
export const largestCorpusFileLines = (): { readonly path: string; readonly lines: number } => {
  let largest = { path: '-', lines: 0 };
  for (const fixture of fixtures)
    for (const [path, content] of Object.entries(fixture.runner?.files ?? {})) {
      const lines = content.split('\n').length;
      if (lines > largest.lines) largest = { path, lines };
    }
  return largest;
};
