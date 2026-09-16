import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtures } from './fixtures.js';
import { runFixture } from './harness.js';
import {
  baselineFrom,
  brokenPromise,
  check,
  pendingHeld,
  render,
  type Baseline,
  type Result
} from './report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const filter = argument('filter');
const selected = filter
  ? fixtures.filter(
      (fixture) => fixture.id.includes(filter) || String(fixture.shape).includes(filter)
    )
  : fixtures;

if (!selected.length) {
  process.stderr.write(`No fixture matches "${filter ?? ''}".\n`);
  process.exit(2);
}

const duplicates = selected
  .map((fixture) => fixture.id)
  .filter((id, index, all) => all.indexOf(id) !== index);
if (duplicates.length) {
  // Two fixtures under one id would silently share a baseline row and hide each other's drift.
  process.stderr.write(`Duplicate fixture ids: ${[...new Set(duplicates)].join(', ')}\n`);
  process.exit(2);
}

let baseline: Baseline = {};
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  // A first run, or a run after the baseline was deliberately removed. Every row reads as new.
}

const results: Result[] = [];
/**
 * The same rows with the committed baseline withheld, which leaves only what each fixture claims
 * about itself. See the header: this is the list `--gate` exits on, and the difference between the
 * two lists is exactly the set of numbers a wave is allowed to move by saying so.
 *
 * Recomputed rather than filtered out of `failures` by matching on the message text. A gate that
 * decided what to ignore by string-matching "against the committed baseline" would let a future
 * rewording of that sentence silently turn a claim into drift, which is a gate quietly switching
 * itself off.
 */
const claims: Result[] = [];
for (const fixture of selected) {
  // Sequentially, and never in parallel: the loop is being measured, and a shared event loop under
  // twenty concurrent runs measures the machine instead.
  const outcome = await runFixture(fixture);
  results.push({
    fixture,
    outcome,
    // The committed row is handed in, so the baseline is a gate rather than a column to read past.
    failures: check(fixture.expect, outcome, baseline[fixture.id])
  });
  claims.push({ fixture, outcome, failures: check(fixture.expect, outcome) });
}

process.stdout.write(render(results, baseline));

if (flag('trace'))
  for (const result of results) {
    // What the loop actually said back, which is the only way to tell a hold that fired for the
    // reason a fixture expects from one that fired for another.
    process.stdout.write(`\n${result.fixture.id}\n`);
    process.stdout.write(`  tools    ${result.outcome.tools.join(', ') || '-'}\n`);
    process.stdout.write(`  asked for ${result.outcome.proposed.join(', ') || '-'}\n`);
    for (const message of result.outcome.pushback)
      process.stdout.write(`  > ${message.replace(/\n/g, '\n    ').slice(0, 600)}\n`);
  }

const json = argument('json');
if (json) writeFileSync(json, `${JSON.stringify(results, null, 2)}\n`);

// Named loudly rather than left to do nothing. `--update` used to be this flag, and a rename that
// leaves the old spelling unrecognised means the one command whose whole purpose is to write a file
// silently writes nothing - which reads exactly like a run that had nothing to accept.
if (flag('update')) {
  process.stderr.write('--update is now --accept: the baseline is a gate, not a report.\n');
  process.exit(2);
}

if (flag('accept')) {
  // Only ever a whole-suite baseline: writing one from a filtered run would drop every row it did
  // not execute and report the rest of the suite as new on the next pass.
  if (filter) {
    process.stderr.write('--accept needs the whole suite; drop --filter.\n');
    process.exit(2);
  }
  if (
    claims.some(
      (result) => (result.failures.length > 0 && !pendingHeld(result)) || brokenPromise(result)
    )
  ) {
    process.stderr.write('Cannot accept a baseline while behavioral contracts fail.\n');
    process.exit(1);
  }
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(results), null, 2)}\n`);
  process.stdout.write(`Baseline accepted: ${baselinePath}\n`);
}

// A pending row's failures are what it was written to measure, so they do not fail the run; a
// pending row with nothing left to measure does, because the marker is now a lie about the loop.
//
// Under `--gate` the pending marker is judged on the claims too, and it has to be: a pending row
// whose stated target is met is a stale marker whatever its token count did, and one held up only
// by baseline drift is not being held up by the thing it is waiting for.
const judged = flag('gate') || flag('accept') ? claims : results;
const failed = judged.some(
  (result) => (result.failures.length > 0 && !pendingHeld(result)) || brokenPromise(result)
);
if (flag('gate') && !failed)
  process.stdout.write(
    'Gate: every fixture ran and every stated claim holds. Committed numbers are not gated here; run `pnpm eval`.\n'
  );
process.exit(failed ? 1 : 0);
