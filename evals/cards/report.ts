/**
 * The table: how many times this computer stops and asks, per task, per security mode.
 *
 * Ordered clean-then-tainted on the same row, always, and neither printed alone. A count that
 * falls is not automatically a win and a count that rises is not automatically a loss - the whole
 * argument is which calls moved, so the `--detail` arm prints them by name. What the committed
 * baseline holds is the count, because that is the figure that can be diffed across a wave without
 * anybody having to read a transcript.
 *
 * The baseline is a tripwire, not a specification. A change that moves a number here is a decision
 * about how often garden interrupts its owner, and the intended way to make it is `--accept` in
 * the commit that moves it, with the new figure in the message. The two directions that are NOT
 * decisions - a genuine write that stopped carding, a read that started - are assertions in
 * `guards.ts` and fail on every run, flag or no flag.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { buildIdentity } from '../../apps/worker/src/build-identity.js';
import { MODES, SCENARIOS, type Mode } from './scenarios.js';
import type { ScenarioMeasurement } from './measure.js';

/* ------------------------------------------------------------- what produced a number, exactly */

/**
 * Which garden, and which rig, a committed row was measured by. The twin of the block in
 * `evals/context-quality/report.ts`, and a twin rather than a shared import for the reason given
 * there: the file lists differ, because what decides a number differs.
 */
export interface BaselineStamp {
  readonly acceptedAt: string;
  readonly version: string;
  readonly commit: string | null;
  readonly rig: string;
}

export const BASELINE_STAMP_KEY = '$stamp';

const RIG_SOURCES: readonly string[] = ['guards.ts', 'measure.ts', 'report.ts', 'scenarios.ts'];

const rigDigest = (): string => {
  try {
    const hash = createHash('sha256');
    // A separator that cannot occur in TypeScript source, so text moved from one rig file to
    // another does not hash the same as text that never moved.
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

export const stampOf = (baseline: Baseline | undefined): BaselineStamp | null => {
  const row = (baseline as Record<string, unknown> | undefined)?.[BASELINE_STAMP_KEY];
  if (typeof row !== 'object' || row === null) return null;
  const { acceptedAt, version, commit, rig } = row as Record<string, unknown>;
  if (typeof acceptedAt !== 'string' || typeof version !== 'string' || typeof rig !== 'string')
    return null;
  if (commit !== null && typeof commit !== 'string') return null;
  return { acceptedAt, version, commit, rig };
};

/* ------------------------------------------------------------------------------- the baseline */

export interface BaselineRow {
  readonly calls: number;
  readonly clean: number;
  readonly tainted: number;
}

export type Baseline = Record<string, BaselineRow>;

export const rowKey = (measurement: ScenarioMeasurement): string =>
  `${measurement.scenarioId}/${measurement.mode}`;

export const baselineFrom = (measurements: readonly ScenarioMeasurement[]): Baseline => {
  // First, so a reader opening the file sees what produced it before the numbers. The cast is the
  // one place the stamp and the rows share a map; `check` looks rows up by `rowKey`, which is
  // always `scenario/mode` and can never be this key.
  const baseline: Baseline = {
    ...({
      [BASELINE_STAMP_KEY]: { acceptedAt: new Date().toISOString(), ...rigIdentity() }
    } as unknown as Baseline)
  };
  for (const measurement of measurements)
    baseline[rowKey(measurement)] = {
      calls: measurement.calls,
      clean: measurement.clean.length,
      tainted: measurement.tainted.length
    };
  return baseline;
};

export const check = (
  measurements: readonly ScenarioMeasurement[],
  baseline: Baseline | undefined
): string[] => {
  if (!baseline) return ['no committed baseline; run with --accept once you have read the table'];
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const measurement of measurements) {
    const key = rowKey(measurement);
    seen.add(key);
    const was = baseline[key];
    if (!was) {
      failures.push(`${key}: new row, not in the baseline`);
      continue;
    }
    if (was.calls !== measurement.calls)
      failures.push(
        `${key}: the scenario itself changed, ${was.calls} calls -> ${measurement.calls}`
      );
    if (was.clean !== measurement.clean.length)
      failures.push(
        `${key}: cards on a clean turn ${was.clean} -> ${measurement.clean.length} (${measurement.clean.map((card) => card.action).join('; ') || 'none'})`
      );
    if (was.tainted !== measurement.tainted.length)
      failures.push(
        `${key}: cards after reading untrusted content ${was.tainted} -> ${measurement.tainted.length} (${measurement.tainted.map((card) => card.action).join('; ') || 'none'})`
      );
  }
  for (const key of Object.keys(baseline))
    if (key !== BASELINE_STAMP_KEY && !seen.has(key))
      failures.push(`${key}: row has gone from the table`);
  return failures;
};

/* ---------------------------------------------------------------------------------- the table */

const pad = (value: string | number, width: number): string => String(value).padStart(width);
const padEnd = (value: string, width: number): string => value.padEnd(width);
const RULE = '-'.repeat(84);

const askOf = (scenarioId: string): string =>
  SCENARIOS.find((scenario) => scenario.id === scenarioId)?.ask ?? '';

export const totals = (
  measurements: readonly ScenarioMeasurement[],
  mode: Mode
): { calls: number; clean: number; tainted: number } => {
  const rows = measurements.filter((measurement) => measurement.mode === mode);
  return {
    calls: rows.reduce((sum, row) => sum + row.calls, 0),
    clean: rows.reduce((sum, row) => sum + row.clean.length, 0),
    tainted: rows.reduce((sum, row) => sum + row.tainted.length, 0)
  };
};

/**
 * What provenance costs, counted rather than asserted.
 *
 * Reported per mode rather than only in total, because a total can be zero while one scenario
 * gained a card and another lost one. The assertion that decides the exit code lives in
 * `measure.ts`: a delta is only allowed where a declared sink produced it, and this is the figure
 * a reader wants beside the table.
 */
export const taintDeltas = (
  measurements: readonly ScenarioMeasurement[]
): { readonly key: string; readonly delta: number }[] =>
  measurements
    .map((measurement) => ({
      key: rowKey(measurement),
      delta: measurement.tainted.length - measurement.clean.length
    }))
    .filter((row) => row.delta !== 0);

/** Calls in the whole matrix, and how many of them are declared provenance sinks. */
export const sinkShare = (): { calls: number; sinks: number } => ({
  calls: SCENARIOS.reduce((sum, scenario) => sum + scenario.calls.length, 0),
  sinks: SCENARIOS.reduce(
    (sum, scenario) => sum + scenario.calls.filter((entry) => entry.sink).length,
    0
  )
});

export const render = (
  measurements: readonly ScenarioMeasurement[],
  baseline: Baseline | undefined,
  detail: boolean
): string => {
  const stamp = stampOf(baseline);
  const now = rigIdentity();
  const lines: string[] = [
    '',
    `how often this computer stops and asks ${RULE}`,
    '',
    `  measured now against garden ${now.version} at ${now.commit ?? 'an uncommitted tree'}, rig ${now.rig}`,
    stamp
      ? `  baseline accepted ${stamp.acceptedAt} against garden ${stamp.version} at ${stamp.commit ?? 'an uncommitted tree'}, rig ${stamp.rig}${stamp.rig === now.rig ? '' : ' (the rig has changed since; --accept in the commit that changed it)'}`
      : '  no committed baseline',
    ''
  ];
  for (const mode of MODES) {
    // A `--mode` run has deliberately taken the other two away, and an empty section under a
    // heading with a TOTAL of zero beneath it reads as "this mode raises no cards", which is the
    // opposite of true. Say nothing about a mode that was not measured.
    if (!measurements.some((row) => row.mode === mode)) continue;
    lines.push(
      `  ${mode} ${'-'.repeat(80 - mode.length)}`,
      '',
      `  ${padEnd('scenario', 20)} ${pad('calls', 5)} ${pad('cards', 5)} ${pad('tainted', 7)} ${pad('was', 5)}   ${'the ask'}`
    );
    for (const measurement of measurements.filter((row) => row.mode === mode)) {
      const was = baseline?.[rowKey(measurement)];
      const moved = was && was.clean !== measurement.clean.length;
      lines.push(
        `  ${padEnd(measurement.scenarioId, 20)} ${pad(measurement.calls, 5)} ${pad(measurement.clean.length, 5)} ${pad(measurement.tainted.length, 7)} ${pad(was ? (moved ? `${was.clean}!` : '=') : 'new', 5)}   ${askOf(measurement.scenarioId)}`
      );
      if (detail)
        for (const card of measurement.clean)
          lines.push(`      ${padEnd(card.sideEffect, 24)} ${card.step} -> ${card.action}`);
    }
    const total = totals(measurements, mode);
    lines.push(
      '',
      `  ${padEnd('TOTAL', 20)} ${pad(total.calls, 5)} ${pad(total.clean, 5)} ${pad(total.tainted, 7)}         ${((total.clean / Math.max(1, total.calls)) * 100).toFixed(0)}% of calls stop the turn`,
      ''
    );
  }
  const deltas = taintDeltas(measurements);
  const share = sinkShare();
  /*
   * The claim is about the whole matrix, so it is only made when the whole matrix was measured.
   * A filtered run that still printed "in any of the three modes" would be a rig overstating its
   * own result under a flag, which is the one thing a measurement may never do.
   */
  const whole = measurements.length === SCENARIOS.length * MODES.length;
  lines.push(`  what provenance costs ${'-'.repeat(62)}`, '');
  if (whole)
    lines.push(
      `  ${share.calls - share.sinks} of the ${share.calls} calls in these ten tasks are unaffected by it: reading untrusted`,
      '  content adds exactly zero cards to any of them, in any of the three modes. The other',
      `  ${share.sinks} are declared sinks - a command asking for the network, a preview link, a memory`,
      '  write - and they are where the whole tainted column comes from:',
      ''
    );
  else
    lines.push(
      '  This is a filtered run and the claim above it is about the whole matrix, so it is not made',
      '  here. What this selection cost:',
      ''
    );
  for (const row of deltas)
    lines.push(`    ${padEnd(row.key, 34)} ${row.delta > 0 ? '+' : ''}${row.delta}`);
  lines.push(
    deltas.length ? '' : '    nothing, in this selection',
    '  A provenance system that costs an owner nothing on an ordinary day is the best-earned',
    '  extensiveness in this product. guards.ts holds the other half, and it is the half that keeps',
    '  this from being an argument for no floor: the sinks that must still card once something',
    '  hostile has been read.',
    ''
  );
  return `${lines.join('\n')}\n`;
};
