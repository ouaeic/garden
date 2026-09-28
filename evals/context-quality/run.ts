/**
 * The entry point.
 *
 *   NODE_OPTIONS=--conditions=development pnpm exec tsx evals/context-quality/run.ts
 *
 * Usage:
 *   (no flags)              every trajectory against every configuration, deterministic, no model
 *   --config detail-2,...   only these configurations
 *   --trajectory 131k       only trajectories whose id contains this
 *   --ci                    check the committed baseline and exit non-zero on a regression
 *   --judge                 also run the graded half; needs OPENROUTER_API_KEY (see judge.ts)
 *   --yes                   confirm the judged half's estimated spend
 *   --accept                rewrite the committed baseline from this run
 *   --json out.json         also write the raw measurements
 *
 * Not part of `pnpm check`, for the reason `evals/run.ts` gives about itself: a behavioural suite
 * that blocks every commit is one somebody deletes the first week it is wrong about something, and
 * these numbers are meant to be argued with. `--ci` exits non-zero, so it is usable as a gate on
 * its own schedule.
 *
 * The deterministic run needs no key, no network and no model. That is the point: the half of this
 * that can gate is the half that always runs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIGURATIONS, FIDELITY, SHIPPED, degenerateConfigurations } from './configurations.js';
import {
  DEFAULT_ANSWER_MODEL,
  DEFAULT_JUDGE_MODEL,
  answerProbe,
  gradeBlind,
  resolveKey,
  type BlindAnswer
} from './judge.js';
import { meanCeiling, measure, tokensPerTask, type Measurement } from './measure.js';
import { PROBE_KINDS, readableWindow } from './probes.js';
import {
  availabilityOf,
  baselineFrom,
  check,
  render,
  rowKey,
  type Baseline,
  type JudgedScore
} from './report.js';
import { TRAJECTORIES } from './trajectories.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const trajectoryFilter = argument('trajectory');
const trajectories = trajectoryFilter
  ? TRAJECTORIES.filter((trajectory) => trajectory.id.includes(trajectoryFilter))
  : TRAJECTORIES;
const configurationFilter = argument('config')?.split(',');
const configurations = configurationFilter
  ? CONFIGURATIONS.filter((configuration) => configurationFilter.includes(configuration.id))
  : CONFIGURATIONS;

if (!trajectories.length || !configurations.length) {
  process.stderr.write('Nothing selected: check --trajectory and --config.\n');
  process.exit(2);
}

let baseline: Baseline | undefined;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  // A first run, or one after the baseline was deliberately removed. Every row reads as new.
}

const measurements: Measurement[] = [];
for (const trajectory of trajectories)
  for (const configuration of configurations)
    measurements.push(await measure(trajectory, configuration));

/**
 * The rig checking itself before it is allowed to report on anything else.
 *
 * `configuration-fidelity` is the shipped constants written back explicitly, so it goes through the
 * whole patch-and-reimport path and must land on the same numbers as `shipped`, which imports the
 * module directly. A rename upstream, a regex that stops matching, a scratch copy that resolves a
 * different `@garden/model-gateway` - each of those makes every configuration secretly identical,
 * and every row in the table below would then agree with every other row, which reads like a
 * finding. This is the only thing standing between that and a confident wrong report.
 */
const fidelityFailures: string[] = [];
for (const trajectory of trajectories) {
  const shipped = measurements.find(
    (row) => row.trajectoryId === trajectory.id && row.configurationId === SHIPPED
  );
  const patched = measurements.find(
    (row) => row.trajectoryId === trajectory.id && row.configurationId === FIDELITY
  );
  if (!shipped || !patched) continue;
  if (availabilityOf(shipped) !== availabilityOf(patched))
    fidelityFailures.push(
      `${trajectory.id}: the patch path scores ${availabilityOf(patched)} where the direct import scores ${availabilityOf(shipped)}`
    );
  if (tokensPerTask(shipped) !== tokensPerTask(patched))
    fidelityFailures.push(
      `${trajectory.id}: the patch path spends ${tokensPerTask(patched)} tokens where the direct import spends ${tokensPerTask(shipped)}`
    );
  if (
    Math.abs(shipped.meanCacheReadShare - patched.meanCacheReadShare) > 1e-9 ||
    shipped.newestReasoningSteps !== patched.newestReasoningSteps
  )
    fidelityFailures.push(
      `${trajectory.id}: the patch path and the direct import disagree on cache`
    );
}

/**
 * The two controls. `recall-owner-constraint` is the owner's own goal message, protected by name in
 * every pass in `prepareModelContext`; if a configuration ever loses it, the rig is measuring a
 * broken driver rather than a design decision and nothing else in the run can be believed.
 */
const controlFailures: string[] = [];
for (const measurement of measurements) {
  const control = measurement.probes.find(
    (outcome) => outcome.probe.id === 'recall-owner-constraint'
  );
  if (control && control.atAsk.retained < 1)
    controlFailures.push(
      `${rowKey(measurement)}: the owner's own goal is not in the window at step ${control.probe.askedAtStep}`
    );
}

/**
 * The two ways this rig can go quiet without going wrong, both found by reading its own output
 * rather than by anything failing. Checked only on the full matrix, because both are statements
 * about the set of configurations and a `--config` run has deliberately taken most of them away.
 *
 * The first: a control that has become a copy of `shipped`. See `degenerateConfigurations`.
 *
 * The second: a probe kind that reads the same number in every row of every trajectory. Such a
 * probe is not evidence that the material survived - it is a constant, and it would keep printing
 * 5.00 if it had stopped looking at the window altogether. `starved` exists so that each kind has
 * at least one configuration in the matrix that genuinely takes its material away; if a kind stops
 * moving even there, either the probe or the configuration has drifted and the column is furniture.
 */
const rigFailures: string[] = [];
if (!configurationFilter) {
  rigFailures.push(...degenerateConfigurations());
  for (const kind of PROBE_KINDS) {
    const moved = trajectories.some((trajectory) => {
      const rows = measurements.filter((row) => row.trajectoryId === trajectory.id);
      const shipped = rows.find((row) => row.configurationId === SHIPPED);
      if (!shipped) return false;
      const reference = meanCeiling(shipped, kind);
      // NaN when this trajectory plants no probe of this kind, which is a gap in the fixture rather
      // than a frozen column: say nothing about the kind here and let another trajectory answer.
      if (Number.isNaN(reference)) return false;
      return rows.some((row) => {
        const score = meanCeiling(row, kind);
        return row.configurationId !== FIDELITY && !Number.isNaN(score) && score !== reference;
      });
    });
    if (!moved)
      rigFailures.push(
        `the ${kind} probes score the same in every configuration of every trajectory, so that column is measuring nothing that a context change can move`
      );
  }
}

const judged = new Map<string, JudgedScore[]>();
const key = resolveKey(flag('judge'));
process.stdout.write(`${key.note}\n`);
if (key.apiKey) {
  const options = {
    apiKey: key.apiKey,
    answerModel: argument('answer-model') ?? DEFAULT_ANSWER_MODEL,
    judgeModel: argument('judge-model') ?? DEFAULT_JUDGE_MODEL
  };
  const calls = measurements.reduce((sum, row) => sum + row.probes.length, 0);
  const promptTokens = measurements.reduce(
    (sum, row) =>
      sum +
      row.probes.reduce(
        (inner, outcome) => inner + Math.ceil(readableWindow(outcome.windowAtAsk).length / 4),
        0
      ),
    0
  );
  process.stdout.write(
    `judged run: ${calls} answer calls carrying about ${promptTokens.toLocaleString('en-GB')} prompt tokens, plus one grading call per probe per trajectory. This spends real money.\n`
  );
  if (!flag('yes')) {
    process.stdout.write('judged run: not started. Re-run with --yes to confirm the spend.\n');
  } else {
    for (const trajectory of trajectories) {
      const rows = measurements.filter((row) => row.trajectoryId === trajectory.id);
      for (const probe of trajectory.probes) {
        const answers: BlindAnswer[] = [];
        for (const row of rows) {
          const outcome = row.probes.find((candidate) => candidate.probe.id === probe.id);
          if (!outcome) continue;
          answers.push({
            configurationId: row.configurationId,
            answer: await answerProbe(options, readableWindow(outcome.windowAtAsk), probe.question)
          });
        }
        for (const verdict of await gradeBlind(options, probe, answers)) {
          const list = judged.get(`${trajectory.id}/${verdict.configurationId}`) ?? [];
          list.push({ probeId: probe.id, score: verdict.score });
          judged.set(`${trajectory.id}/${verdict.configurationId}`, list);
        }
      }
    }
  }
}

process.stdout.write(render(measurements, baseline, judged));

for (const failure of fidelityFailures) process.stderr.write(`FIDELITY: ${failure}\n`);
for (const failure of controlFailures) process.stderr.write(`CONTROL: ${failure}\n`);
for (const failure of rigFailures) process.stderr.write(`RIG: ${failure}\n`);

const json = argument('json');
if (json)
  writeFileSync(
    json,
    `${JSON.stringify(
      measurements.map((measurement) => ({
        ...measurement,
        // The prepared windows are hundreds of kilobytes each and only judged mode reads them.
        probes: measurement.probes.map(({ windowAtAsk: _window, ...rest }) => rest)
      })),
      null,
      2
    )}\n`
  );

if (flag('accept')) {
  if (trajectoryFilter || configurationFilter) {
    process.stderr.write('--accept needs the whole matrix; drop --trajectory and --config.\n');
    process.exit(2);
  }
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(measurements), null, 2)}\n`);
  process.stdout.write(`Baseline rewritten: ${baselinePath}\n`);
}

const regressions = flag('ci')
  ? measurements.flatMap((measurement) => check(measurement, baseline))
  : [];
// Printed, every one. A regression that only moved the exit code sent a reader to the JSON and
// the report module to learn which row had moved - an exit 1 with nothing beside it is a rig that
// knows the answer and keeps it.
for (const regression of regressions) process.stderr.write(`REGRESSION: ${regression}\n`);
// `rigFailures` counts on every run, not only under `--ci`: a baseline regression is a decision
// about garden, but a degenerate control or a frozen probe column means the numbers printed above
// are not measurements at all, and that is not something a flag should be able to hide.
const failed =
  fidelityFailures.length + controlFailures.length + rigFailures.length + regressions.length;
if (key.fatal) {
  process.stderr.write('judged run: asked for on a CI runner with no key.\n');
  process.exit(1);
}
process.exit(failed ? 1 : 0);
