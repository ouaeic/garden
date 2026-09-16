/**
 * The entry point.
 *
 *   pnpm eval:edit
 *   pnpm eval:edit -- --ci        also check the committed baseline; non-zero on any change
 *   pnpm eval:edit -- --accept    rewrite the committed baseline from this run
 *   pnpm eval:edit -- --json out  also write the raw rows
 *
 * It runs no model, needs no key, touches no network and takes about a second. `--ci` is on
 * `pnpm eval:rigs` and therefore on `pnpm check`, which is a change from the rig that stood here
 * before: that one measured a format that did not ship, and a gate on unshipped code is a gate
 * somebody deletes. This one measures the editor that IS shipped, on the failures it will meet
 * every day, and the numbers in `docs/design/edit/ATTACK.md` are the ones it prints.
 *
 * The self-test runs first and is not optional. Its checks are aimed at this rig rather than at the
 * applier, because a corpus of failures written by somebody who wants the format to look forgiving
 * is a corpus of failures the format happens to forgive.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runConformance } from './conformance.js';
import { assertIncumbentRetired, runPairs } from './incumbent.js';
import {
  baselineFrom,
  check,
  renderConformance,
  renderPairs,
  renderQuestions,
  renderTotals,
  type Baseline
} from './report.js';
import { selfTest } from './selftest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};

const problems = selfTest();
if (problems.length) {
  process.stdout.write(
    `\n  THE RIG IS NOT HONEST - ${problems.length} problem(s), and no table is printed:\n${problems
      .map((line) => `    ${line}\n`)
      .join('')}\n`
  );
  process.exit(1);
}

const conformance = runConformance();
const pairs = runPairs();

process.stdout.write(renderQuestions());
process.stdout.write(renderConformance(conformance));
process.stdout.write(renderTotals(conformance));
process.stdout.write(renderPairs(pairs, assertIncumbentRetired()));

const jsonOut = argument('json');
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ conformance, pairs }, null, 2)}\n`);

const failed = conformance.filter((row) => row.verdict !== 'landed' && row.verdict !== 'refused');
const wrong = pairs.filter(
  (row) => row.byLine.wrote === 'the wrong edit' || row.byLine.wrote === 'part of the edit'
);
if (failed.length || wrong.length) {
  process.stderr.write(
    `Edit outcomes failed: ${[...failed, ...wrong].map((row) => row.id).join(', ')}. Baseline acceptance is disabled.\n`
  );
  process.exit(1);
}

if (flag('accept')) {
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(conformance, pairs), null, 2)}\n`);
  process.stdout.write(`  baseline written to ${baselinePath}\n\n`);
  process.exit(0);
}

if (flag('ci')) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  const changed = check(conformance, pairs, baseline);
  if (changed.length) {
    process.stdout.write(
      `  BASELINE CHANGED\n${changed.map((line) => `    ${line}\n`).join('')}\n` +
        '    A row that got worse is a regression. A row that got better is a fix that has to be\n' +
        '    accepted on purpose, with --accept, so it shows up in the diff.\n\n'
    );
    process.exit(1);
  }
  process.stdout.write('  baseline unchanged\n\n');
}
