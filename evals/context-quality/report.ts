/**
 * The table this whole step exists to produce: cache gain and quality cost, on the same rows.
 *
 * Every previous argument about `context.ts` has been settled on one axis. The plan quotes cache
 * percentages; the eval suite counts steps and tokens; nothing anywhere has been able to say what a
 * narrower window costs the model, so "49/49 still pass" has been standing in for an answer to a
 * question it cannot reach. A row here carries both, measured on the same sixty requests, and the
 * columns are deliberately ordered cost-first so the gain is read against something.
 *
 * The committed baseline is a tripwire, not a specification. A change that moves a number here is
 * a decision about what garden's agent can still remember, and the intended way to make it is to
 * re-accept the baseline in the commit that moves it, with the new figure quoted in the message.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { buildIdentity } from '../../apps/worker/src/build-identity.js';
import { judgeCeiling } from './probes.js';
import { meanCeiling, tokensPerTask, type Measurement } from './measure.js';
import { PROBE_KINDS } from './probes.js';

/* ------------------------------------------------------------- what produced a number, exactly */

/**
 * Which garden, and which rig, a committed row was measured by.
 *
 * The twin of the block in `evals/report.ts`, and deliberately a twin rather than a shared import:
 * `evals/harness.ts` rewrites the built-in skill library at module load, so importing anything from
 * it into this rig would mutate global state a context measurement reads. They share a shape and
 * nothing else - the file lists differ, because what decides a number differs.
 *
 * `version` and `commit` come from `buildIdentity()`, the same pair the box reports to its owner,
 * so a row here names a revision somebody can check out. `rig` is a digest of the six files that
 * decide every number this directory prints; it has to be derived rather than declared, because a
 * hand-maintained version is a control wired to nothing the first time somebody edits a probe and
 * forgets it. A stamp that disagrees with the current run is a note and never a failure: adding a
 * probe legitimately moves the digest, and the answer is `--accept` in the same commit.
 */
export interface BaselineStamp {
  readonly acceptedAt: string;
  readonly version: string;
  readonly commit: string | null;
  readonly rig: string;
}

export const BASELINE_STAMP_KEY = '$stamp';

const RIG_SOURCES: readonly string[] = [
  'configurations.ts',
  'judge.ts',
  'measure.ts',
  'probes.ts',
  'report.ts',
  'trajectories.ts'
];

const rigDigest = (): string => {
  try {
    const hash = createHash('sha256');
    // A separator that cannot occur in TypeScript source, so text shifted across the boundary
    // between two files does not hash the same as text that never moved.
    for (const file of RIG_SOURCES)
      hash.update(`${readFileSync(new URL(file, import.meta.url), 'utf8')}\0`);
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

/**
 * The stamp out of a parsed baseline, or null.
 *
 * Validated field by field rather than cast, because it arrives from a file: a stamp half-written
 * by an interrupted `--accept` would otherwise print as a revision that never existed, which is
 * worse than printing nothing because somebody would try to check it out.
 */
export const stampOf = (baseline: Baseline | undefined): BaselineStamp | null => {
  const row = (baseline as Record<string, unknown> | undefined)?.[BASELINE_STAMP_KEY];
  if (typeof row !== 'object' || row === null) return null;
  const { acceptedAt, version, commit, rig } = row as Record<string, unknown>;
  if (typeof acceptedAt !== 'string' || typeof version !== 'string' || typeof rig !== 'string')
    return null;
  if (commit !== null && typeof commit !== 'string') return null;
  return { acceptedAt, version, commit, rig };
};

export interface BaselineRow {
  readonly availability: number;
  readonly tokensPerTask: number;
  readonly cacheReadShare: number;
  readonly newestReasoningSteps: number;
  readonly unrecoverableLosses: number;
  /** Compactions attempted that freed nothing. @see Measurement.compactionRefusals. */
  readonly compactionRefusals: number;
  /** What the compactions handed a summarising model. @see Measurement.summariserTokens. */
  readonly summariserTokens: number;
}

export type Baseline = Record<string, BaselineRow>;

export const rowKey = (measurement: Measurement): string =>
  `${measurement.trajectoryId}/${measurement.configurationId}`;

/** Mean availability across every probe, on the judge's 0-5 scale. */
export const availabilityOf = (measurement: Measurement): number => meanCeiling(measurement);

export const baselineFrom = (measurements: readonly Measurement[]): Baseline => {
  // First, so a reader opening the file sees what produced it before the numbers. The cast is the
  // one place the stamp and the rows share a map: `check` looks the file up by `rowKey`, which is
  // always `trajectory/configuration` and can never be this key.
  const baseline: Baseline = {
    ...({
      [BASELINE_STAMP_KEY]: { acceptedAt: new Date().toISOString(), ...rigIdentity() }
    } as unknown as Baseline)
  };
  for (const measurement of measurements)
    baseline[rowKey(measurement)] = {
      availability: availabilityOf(measurement),
      tokensPerTask: tokensPerTask(measurement),
      cacheReadShare: Math.round(measurement.meanCacheReadShare * 1_000) / 1_000,
      newestReasoningSteps: measurement.newestReasoningSteps,
      unrecoverableLosses: measurement.unrecoverableLosses,
      compactionRefusals: measurement.compactionRefusals,
      summariserTokens: measurement.summariserTokens
    };
  return baseline;
};

/**
 * What counts as a regression.
 *
 * Availability, the reasoning-window count and the refusal count are exact: they are
 * integer-derived and nothing but a real change to what the model can read, or to whether
 * compaction still works, moves them - so a band would only hide the thing this file is for.
 * Tokens per task gets 2%, the same band `evals/report.ts` gives its own token columns, because
 * the catalogue and the operating contract drift with unrelated work.
 */
export const check = (
  measurement: Measurement,
  baseline: Baseline | undefined
): readonly string[] => {
  const expected = baseline?.[rowKey(measurement)];
  if (!expected) return [];
  const failures: string[] = [];
  const availability = availabilityOf(measurement);
  if (availability < expected.availability)
    failures.push(
      `probe availability ${availability.toFixed(2)} is below the accepted ${expected.availability.toFixed(2)}: the model can read less than it could`
    );
  if (measurement.newestReasoningSteps < expected.newestReasoningSteps)
    failures.push(
      `the current turn's own reasoning survived ${measurement.newestReasoningSteps} steps, accepted ${expected.newestReasoningSteps}`
    );
  if (measurement.unrecoverableLosses > expected.unrecoverableLosses)
    failures.push(
      `${measurement.unrecoverableLosses} unrecoverable losses, accepted ${expected.unrecoverableLosses}: no tool call brings these back`
    );
  // Exact, and a ceiling: a compaction that frees nothing is never progress, and a change that
  // starts refusing where the accepted numbers did not has broken the mechanism whatever the
  // availability column says. `?? 0` so a baseline accepted before this column existed reads as
  // "none accepted" rather than silently disabling the check.
  if (measurement.compactionRefusals > (expected.compactionRefusals ?? 0))
    failures.push(
      `${measurement.compactionRefusals} compaction${measurement.compactionRefusals === 1 ? '' : 's'} attempted and freed nothing, accepted ${expected.compactionRefusals ?? 0}: the window is being held up by the deterministic passes instead`
    );
  const tokens = tokensPerTask(measurement);
  if (tokens > expected.tokensPerTask * 1.02)
    failures.push(
      `tokens per task ${tokens.toLocaleString('en-GB')} is over the accepted ${expected.tokensPerTask.toLocaleString('en-GB')} by more than 2%`
    );
  /*
   * The summariser's own spend, on the same 2% band as the step loop's and for the same reason: the
   * system prompt is edited by unrelated work and the transcript follows the operating contract.
   *
   * A ceiling and never a floor. Compaction is the one stage here that spends a model call the
   * caller did not ask for, and a change that quietly doubles it - a second pass at the boundary, a
   * transcript that carries a channel it did not carry before, a summariser given more history -
   * would otherwise land with nothing to say so.
   *
   * Absence is asked about rather than defaulted, and for the opposite reason to the check above.
   * `?? 0` reads an absent `compactionRefusals` as "none accepted", which TIGHTENS that check. A
   * ceiling defaulted to zero is not the lax reading of the same move: it fires on every row whose
   * accepted figure is absent and whose compactions spent anything at all - which, on a baseline
   * accepted before this column existed, is every compacting row - and the message it then builds
   * reads that absent figure and throws `Cannot read properties of undefined`. Both directions were
   * run against this tree: with the figure deleted from one baseline row the arm below skips and
   * the run is clean, and with the arm rewritten to `?? 0` the same deletion crashes `check` on the
   * `expected.summariserTokens.toLocaleString` in the message below. So a baseline accepted before
   * this column existed is left unchecked on it, and the run's provenance line already says which
   * rig accepted its numbers.
   */
  if (
    expected.summariserTokens !== undefined &&
    measurement.summariserTokens > expected.summariserTokens * 1.02
  )
    failures.push(
      `the summariser was handed ${measurement.summariserTokens.toLocaleString('en-GB')} tokens, over the accepted ${expected.summariserTokens.toLocaleString('en-GB')} by more than 2%`
    );
  return failures;
};

const pad = (value: string, width: number): string => value.padEnd(width);
const padStart = (value: string, width: number): string => value.padStart(width);

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

export interface JudgedScore {
  readonly probeId: string;
  readonly score: number;
}

export const render = (
  measurements: readonly Measurement[],
  baseline: Baseline | undefined,
  judged: ReadonlyMap<string, readonly JudgedScore[]> = new Map()
): string => {
  const lines: string[] = [];
  /*
   * Who is asking, and who the committed numbers belong to.
   *
   * Printed on every run rather than only on a mismatch, because the value of a provenance line is
   * that it sits in the scrollback of the run somebody later has questions about. The mismatch
   * underneath is a note: a wave that adds a probe moves the digest by design.
   */
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

  const byTrajectory = new Map<string, Measurement[]>();
  for (const measurement of measurements) {
    const list = byTrajectory.get(measurement.trajectoryId) ?? [];
    list.push(measurement);
    byTrajectory.set(measurement.trajectoryId, list);
  }

  for (const [trajectoryId, rows] of byTrajectory) {
    lines.push('', trajectoryId, '='.repeat(trajectoryId.length));
    const header = [
      pad('configuration', 30),
      padStart('avail', 6),
      ...PROBE_KINDS.map((kind) => padStart(kind.slice(0, 5), 6)),
      padStart('judged', 7),
      padStart('tokens/task', 12),
      // Beside the task's own tokens and never inside them: a different model on a different route.
      padStart('summ-in', 9),
      padStart('rework', 8),
      padStart('unrec', 6),
      padStart('refuse', 7),
      padStart('cache', 7),
      padStart('prefix', 7),
      padStart('own-think', 10)
    ].join(' ');
    lines.push(header, '-'.repeat(header.length));
    // The shipped row leads and every other row is printed as a delta against it, because the
    // question is never "is 3.7 good" but "is this change worth what it costs".
    const shipped = rows.find((row) => row.configurationId === 'shipped');
    for (const row of rows) {
      const scores = judged.get(rowKey(row));
      const judgedMean = scores?.length
        ? (scores.reduce((sum, score) => sum + score.score, 0) / scores.length).toFixed(2)
        : '-';
      const delta =
        shipped && row !== shipped
          ? ` (${(availabilityOf(row) - availabilityOf(shipped) >= 0 ? '+' : '') + (availabilityOf(row) - availabilityOf(shipped)).toFixed(2)})`
          : '';
      lines.push(
        [
          pad(row.configurationId, 30),
          padStart(availabilityOf(row).toFixed(2), 6),
          ...PROBE_KINDS.map((kind) => padStart(meanCeiling(row, kind).toFixed(2), 6)),
          padStart(judgedMean, 7),
          padStart(tokensPerTask(row).toLocaleString('en-GB'), 12),
          padStart(row.summariserTokens.toLocaleString('en-GB'), 9),
          padStart(row.reworkTokens.toLocaleString('en-GB'), 8),
          padStart(String(row.unrecoverableLosses), 6),
          padStart(`${row.compactionRefusals}/${row.compactions + row.compactionRefusals}`, 7),
          padStart(percent(row.meanCacheReadShare), 7),
          padStart(percent(row.meanPrefixShare), 7),
          padStart(`${row.newestReasoningSteps}/${row.steps.length}`, 10)
        ].join(' ') + delta
      );
    }

    for (const row of rows) {
      const failures = check(row, baseline);
      for (const failure of failures) lines.push(`  ! ${row.configurationId}: ${failure}`);
    }
  }

  lines.push('', 'Per-probe availability at the step the task needed it (0-5 ceiling)', '');
  // Read off the trajectory's own first row rather than the run's, because a trajectory may carry
  // probes the others do not: taking the ids from `measurements[0]` silently dropped every probe
  // that only one trajectory plants, and the column it belongs in read as if it were not there.
  const width = Math.max(
    24,
    ...measurements.flatMap((row) => row.probes.map((outcome) => outcome.probe.id.length))
  );
  for (const [trajectoryId, rows] of byTrajectory) {
    const probeIds = rows[0]?.probes.map((outcome) => outcome.probe.id) ?? [];
    lines.push(trajectoryId);
    lines.push(
      [
        pad('probe', width),
        ...rows.map((row) => padStart(row.configurationId.slice(0, 12), 13))
      ].join(' ')
    );
    for (const id of probeIds) {
      const cells = rows.map((row) => {
        const outcome = row.probes.find((candidate) => candidate.probe.id === id);
        return padStart(outcome ? judgeCeiling(outcome.atAsk.retained).toFixed(1) : '-', 13);
      });
      lines.push([pad(id, width), ...cells].join(' '));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};
