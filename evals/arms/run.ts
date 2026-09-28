/**
 * The entry point: `pnpm eval:arms`.
 *
 * Usage:
 *   pnpm eval:arms                          the offline half; no key, no network, no model
 *   pnpm eval:arms -- --ci                  also check the committed baseline; non-zero on a change
 *   pnpm eval:arms -- --accept              rewrite the committed baseline from this run
 *   pnpm eval:arms -- --json out.json       also write the raw rows
 *   pnpm eval:arms -- --arm no-method,core  only these arms (shipped is always included)
 *   pnpm eval:arms -- --contract-section f  measure this text as the method axis, not the section
 *   pnpm eval:arms -- --live                the judged half; needs OPENROUTER_API_KEY
 *   pnpm eval:arms -- --live --yes          confirm the spend the live half estimates
 *   pnpm eval:arms -- --live --sample 12    a shape-balanced subset, for a run somebody pays for
 *   pnpm eval:arms -- --live --strong <id>  add the installation's own model as a second tier
 *   pnpm eval:arms -- --edit                the edit axis: its sample, its bound, and what a run costs
 *   pnpm eval:arms -- --edit --live         and the price at the provider's own current rates
 *   pnpm eval:arms -- --edit --live --yes   and the only half that can settle it, which costs money
 *   pnpm eval:arms -- --edit --live --yes --model <release id>   one tier of the owner's choosing
 *
 * Deliberately not part of `pnpm check`, for the reason `evals/run.ts` gives about itself: a
 * behavioural suite that blocks every commit is one somebody deletes the first week it is wrong
 * about something. `--ci` exits non-zero, so it gates on its own schedule.
 *
 * Read the offline table first and the pre-registration before either. The offline half is exact
 * and free and it is where the residency argument is actually settled; the live half is the only
 * thing that can say whether a saving costs anything, and it costs money to ask.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARMS, EDIT_ARM, ROOT_ARM } from './arms.js';
import { EDIT_TASKS, runEditLive } from './edit-arm.js';
import { gatewayTransport } from './edit-live.js';
import { estimateCalls, resolveKey, runLive, WEAK_TIER } from './live.js';
import { measureAll } from './measure.js';
import {
  baselineFrom,
  check,
  renderEditBound,
  renderEditLive,
  renderEditPrice,
  renderEditSample,
  renderEditVerdict,
  renderLive,
  renderQuestions,
  renderResident,
  scoreArms,
  scoreEditArms,
  type Baseline
} from './report.js';
import { ratesFor, type Rates } from './price.js';
import { PROVIDER_KEY_VARIABLES, providerCredential } from '../bench/provider.js';
import { TASKS, sampleOf } from './tasks.js';
import { cutSizes, incumbentEntry, readCut } from './wire.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');
/** The route the price catalogue is about; a run sent anywhere else is priced by a stranger. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const wanted = argument('arm')?.split(',');
// The root arm is always in, whatever was asked for: every delta in either table is measured
// against it, and a table of candidates with nothing to compare them to is a list of numbers.
const armIds = [
  ROOT_ARM,
  ...ARMS.map((arm) => arm.id).filter((id) => id !== ROOT_ARM && (!wanted || wanted.includes(id)))
];

const cutFile = argument('contract-section');
const cut = cutFile ? { replacement: readCut(cutFile) } : {};

process.stdout.write(renderQuestions());

const sizes = cutSizes(cut.replacement);
process.stdout.write(
  `  The method axis is ${sizes.method} bytes, read from ${sizes.source}, and this run measures it\n` +
    `  by ${sizes.direction === 'cut' ? 'REMOVING it from the shipped contract: the cut has not landed yet' : 'RESTORING it to the shipped contract: the cut has already landed, so the arm measures it from the other side'}.\n` +
    `  The skills bullet that points at the index is ${sizes.skillBullet} bytes.\n`
);

const resident = measureAll(armIds, cut);
process.stdout.write(renderResident(resident));

const jsonOut = argument('json');
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ resident }, null, 2)}\n`);

let baseline: Baseline | undefined;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  // A first run, or one after the baseline was deliberately removed. Every arm reads as new.
}

if (flag('accept')) {
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(resident), null, 2)}\n`);
  process.stdout.write(`Baseline accepted: ${baselinePath}\n`);
}

/**
 * The edit axis, on its own sample and its own table.
 *
 * Separate from the general run because a task that does not edit a file cannot tell `file_patch`
 * from the candidate, and a rig that ran the edit arm over the general sample would print a tie
 * for the same reason the offline half prints one: the instrument is blind there. A tie that means
 * "blind" and a tie that means "free" look identical on the page, and this programme has already
 * shipped one decision made on the second reading of the first kind of tie.
 *
 * The offline part runs unconditionally under `--edit` and costs nothing: the sample, the bound
 * `evals/edit` already measured over these rows, and what the live half would cost before anybody
 * spends it. The live part needs the key and the same `--yes` the general half needs.
 */
if (flag('edit')) {
  const editArms = [ROOT_ARM, EDIT_ARM];
  /*
   * Two tiers, and the second one is the installation's own rather than one invented here.
   *
   * The pre-registration says an arm ships on BOTH tiers and it says so because the strongest
   * finding in the study behind this whole programme is that a strong model masks bad ergonomics
   * by paying for them - the same change was worth a fraction of a point of accuracy and 61% of
   * the output tokens. So the weak tier is where a correctness risk shows and the strong tier is
   * where the saving does, and a run on one of them settles neither. `AI_DEFAULT_MODEL` is what an
   * installation actually points garden at, which is the honest strong tier; `--strong` overrides
   * it. Neither is invented, and where there is no second tier this refuses to spend rather than
   * printing half a decision.
   */
  /*
   * `--model` names the weak tier, and names it as a release id - `openrouter/z-ai/glm-5.3-flash`
   * - because that is what the gateway seam takes. Given explicitly, one tier is allowed to run:
   * a run the owner chose the model for is a run they are reading as one row, and the verdict
   * below still says which half of the rule it can and cannot settle.
   */
  const chosen = argument('model');
  const weak = chosen ?? WEAK_TIER;
  const strong = argument('strong') ?? process.env.AI_DEFAULT_MODEL;
  const tiers = [weak, ...(strong && strong !== weak ? [strong] : [])];
  const seeds = Number(argument('seeds') ?? 1);
  const incumbent = incumbentEntry();
  process.stdout.write(
    `\n  The edit axis is a ROLLBACK: the line-addressed dialect is what the working tree ships, so\n` +
      `  the arm called "${ROOT_ARM}" is the quoted editor put back, read from ${incumbent.source}.\n`
  );
  process.stdout.write(renderEditSample());
  process.stdout.write(renderEditBound());
  // The same two variables, in the same order, as the transport below reads them.
  const key = resolveKey(flag('live'), process.env, PROVIDER_KEY_VARIABLES);
  /*
   * The rate is fetched whether or not anybody is about to spend, because the decision this rig
   * exists to inform is taken BEFORE the spend and there is no point pricing a run only for
   * somebody who has already committed to it. It is a public catalogue, no credential is sent, and
   * a failure prints the tokens and says there is no price. `--no-price` skips the call entirely
   * for a run that must touch no network at all.
   */
  const rates: Rates | null = flag('no-price') ? null : await ratesFor(tiers);
  process.stdout.write(renderEditPrice(measureAll(editArms, cut), editArms, tiers, seeds, rates));
  process.stdout.write(`  ${key.note}\n`);
  const credential = flag('live') ? providerCredential(process.env) : null;
  if (rates && credential && credential.baseUrl !== OPENROUTER_BASE_URL)
    process.stdout.write(
      `  The price above is read from the OpenRouter catalogue; this run is routed to ${credential.baseUrl} through ${credential.variable}, whose rates that catalogue does not carry.\n`
    );
  if (flag('live') && key.apiKey) {
    if (tiers.length < 2 && !chosen)
      process.stdout.write(
        '\n  ONE TIER. The pre-registered rule says both, so this run cannot settle the question and\n' +
          '  nothing here will spend money on half of it. Set AI_DEFAULT_MODEL to the model this\n' +
          '  installation actually runs, pass --strong <model id>, or name the one tier you want\n' +
          '  with --model <release id> to run it as one row.\n'
      );
    else if (!flag('yes'))
      process.stdout.write(
        '\n  Re-run with --yes to spend it. Nothing above cost anything; everything below does.\n'
      );
    else {
      // Rows are printed as they land rather than at the end. A run of this size is minutes long,
      // and a rig that prints nothing until it finishes is a rig somebody kills at the four-minute
      // mark and pays for twice.
      let done = 0;
      const total = editArms.length * EDIT_TASKS.length * tiers.length * seeds;
      if (tiers.length < 2)
        process.stdout.write(
          `\n  ONE TIER, by request: ${weak}. The rule needs both; this run informs and does not settle.\n`
        );
      // Through garden's own gateway - the worker's client, retry policy and usage parsing - so
      // the row carries the same request the worker would have sent. @see `edit-live.ts`.
      const transport = gatewayTransport(process.env);
      const rows = await runEditLive(
        key.apiKey,
        editArms,
        EDIT_TASKS,
        tiers,
        seeds,
        (row) => {
          done += 1;
          process.stderr.write(
            `  [${done}/${total}] ${row.armId} ${row.tier} ${row.taskId} ${row.correct ? 'correct' : 'wrong'} ${row.editApplied}/${row.editCalls} applied${row.unrecovered ? `, ${row.unrecovered} unrecovered` : ''}${row.anchorPresent ? `, ${row.anchorPresent} anchored` : ''}\n`
          );
        },
        transport
      );
      const scores = scoreEditArms(rows);
      process.stdout.write(renderEditLive(scores));
      process.stdout.write(renderEditVerdict(scores));
      const editJson = argument('edit-json');
      if (editJson) writeFileSync(editJson, `${JSON.stringify(rows, null, 2)}\n`);
    }
  } else if (key.fatal) {
    process.exit(1);
  }
}

if (flag('live') && !flag('edit')) {
  const key = resolveKey(true, process.env);
  process.stdout.write(`\n${key.note}\n`);
  if (key.apiKey) {
    const size = Number(argument('sample') ?? TASKS.length);
    const tasks = sampleOf(Number.isFinite(size) ? size : TASKS.length);
    // The edit arm is not run here, and paying for it here would be worse than not running it: the
    // general sample does not edit files, so every row would tie, and a tie printed beside a real
    // difference reads as evidence that the dialect is free. `--edit` is where it is readable.
    const liveArms = armIds.filter((id) => id !== EDIT_ARM);
    if (liveArms.length !== armIds.length)
      process.stdout.write(
        `  ${EDIT_ARM} is not in this run. Its axis is only readable on a sample that edits files; pass --edit.\n`
      );
    const strong = argument('strong');
    const tiers = [WEAK_TIER, ...(strong ? [strong] : [])];
    const seeds = Number(argument('seeds') ?? 1);
    if (!strong)
      process.stdout.write(
        '  One tier only. The difference between what a weak model pays for a harness decision and\n' +
          '  what a strong one pays is the finding; pass --strong <model id> to get it. There is no\n' +
          '  default here on purpose - the shipped model is whatever AI_DEFAULT_MODEL is set to.\n'
      );
    if (!flag('yes')) {
      process.stdout.write(
        `The live half is at most ${estimateCalls(liveArms, tasks, tiers, seeds)} model calls ` +
          `(${liveArms.length} arms x ${tasks.length} tasks x ${tiers.length} tier(s) x ${seeds} seed(s), ` +
          `bounded by the step ceiling). Re-run with --yes to spend them.\n`
      );
    } else {
      const rows = await runLive(key.apiKey, liveArms, tasks, tiers, seeds, cut);
      process.stdout.write(renderLive(scoreArms(rows)));
      const liveJson = argument('live-json');
      if (liveJson) writeFileSync(liveJson, `${JSON.stringify(rows, null, 2)}\n`);
    }
  } else if (key.fatal) {
    process.exit(1);
  }
}

if (flag('ci')) {
  const failures = check(resident, baseline);
  if (failures.length) {
    process.stderr.write('\nThe committed baseline disagrees with this run:\n');
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.stderr.write(
      '\nA number that moved is a decision, not a failure - but it has to be an accepted one. Re-run with --accept once you have read why.\n'
    );
    process.exit(1);
  }
  process.stdout.write('Baseline holds.\n');
}
