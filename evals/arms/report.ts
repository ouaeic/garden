/**
 * The table, and the two rules that keep it from flattering whoever built it.
 *
 * First: success rate and mean output tokens are printed on the same row, always, and neither is
 * ever printed alone. An arm that ties on success and costs 60% fewer output tokens and an arm
 * that ties on success and costs 60% more are the same row on a success-only table, and they are
 * opposite decisions. The token column is the one that is still true after the next model release.
 *
 * Second: the primary columns are computed over rows the provider actually ran and metered.
 * Ghosts and unmetered rows are counted and printed in their own diagnostic column, never folded
 * into a mean. That is not tidiness - the arms differ in how much of the request is tool schema,
 * so any estimate substituted for a missing count would be wrong by a different factor per arm,
 * which is a fabricated difference with a decimal point on it.
 *
 * The baseline covers the offline half only. The live half is not deterministic and must never
 * gate: a rig that fails a build because a provider had a slow afternoon is a rig somebody deletes.
 */
import { ARMS, EDIT_ARM, PRE_REGISTRATION, ROOT_ARM, armById, settingsFor } from './arms.js';
import {
  EDIT_TASKS,
  EXCLUDED_CORPUS_IDS,
  MIN_CALLS_PER_EDIT,
  characterBound,
  readSurcharge,
  type EditRow
} from './edit-arm.js';
import type { Resident } from './measure.js';
import { MAX_OUTPUT_TOKENS, MAX_STEPS, type RunRow } from './live.js';
import { breakEven, cost, dollars, estimateArm, type Rates } from './price.js';

const pad = (value: string | number, width: number): string => String(value).padStart(width);
const padEnd = (value: string, width: number): string => value.padEnd(width);
const RULE = '-'.repeat(86);

/* -------------------------------------------------------------------------- the offline table */

export const renderResident = (rows: readonly Resident[]): string => {
  const root = rows.find((row) => row.armId === ROOT_ARM);
  const lines: string[] = [
    '',
    `what each arm carries on every request ${RULE}`,
    '',
    `  ${padEnd('arm', 12)} ${pad('tools', 5)} ${pad('catalogue', 10)} ${pad('contract', 9)} ${pad('index', 6)} ${pad('resident', 9)} ${pad('tokens', 7)} ${pad('vs shipped', 11)}`
  ];
  for (const row of rows) {
    const delta = root ? row.residentTokens - root.residentTokens : 0;
    lines.push(
      `  ${padEnd(row.armId, 12)} ${pad(row.toolCount, 5)} ${pad(row.catalogueBytes, 10)} ${pad(row.contractBytes, 9)} ${pad(row.knowledgeBytes, 6)} ${pad(row.residentBytes, 9)} ${pad(row.residentTokens, 7)} ${pad(delta === 0 ? '-' : `${delta > 0 ? '+' : ''}${delta}`, 11)}`
    );
  }
  lines.push(
    '',
    '  Bytes, not opinions: every figure above is garden own output measured, and the tokens',
    '  column is bytes/4, the same conversion evals/harness.ts bills a request at.',
    ''
  );
  for (const row of rows)
    if (row.dangling.length)
      lines.push(
        `  ! ${row.armId}: the contract still names ${row.dangling.length} tool${row.dangling.length === 1 ? '' : 's'} this arm does not send - ${row.dangling.join(', ')}`
      );
  if (rows.some((row) => row.dangling.length))
    lines.push(
      '    A prompt with a hole in it is not a smaller prompt. A diagnostic, not a verdict: a',
      '    candidate that leaves holes is unfinished, and the repair is prose, not a smaller arm.'
    );
  lines.push('');
  return `${lines.join('\n')}\n`;
};

/* ----------------------------------------------------------------------------- the live table */

export interface ArmScore {
  readonly armId: string;
  readonly tier: string;
  /** Rows that ran and are not ghosts. */
  readonly counted: number;
  readonly completed: number;
  readonly successRate: number;
  readonly meanModelCalls: number;
  /** The half that is still true in a year. Metered rows only. */
  readonly meanTokensOut: number;
  readonly meanTokensIn: number;
  /** Completed, but in more turns than the root arm needed for the same task and seed. */
  readonly recovered: number;
  readonly ghosts: number;
  readonly unmetered: number;
  readonly errors: number;
  readonly ranOut: number;
}

const mean = (values: readonly number[]): number =>
  values.length
    ? Math.round((values.reduce((total, one) => total + one, 0) / values.length) * 10) / 10
    : Number.NaN;

export const scoreArms = (rows: readonly RunRow[]): readonly ArmScore[] => {
  const rootCalls = new Map<string, number>();
  for (const row of rows)
    if (row.armId === ROOT_ARM && row.completed)
      rootCalls.set(`${row.tier} ${row.taskId} ${row.seed}`, row.modelCalls);
  const keys = [...new Set(rows.map((row) => `${row.armId}\u0000${row.tier}`))];
  return keys.map((key) => {
    const [armId = '', tier = ''] = key.split('\u0000');
    const all = rows.filter((row) => row.armId === armId && row.tier === tier);
    const errors = all.filter((row) => row.error).length;
    const ghosts = all.filter((row) => row.ghost).length;
    const counted = all.filter((row) => !row.error && !row.ghost);
    const metered = counted.filter((row) => row.metered);
    const completed = counted.filter((row) => row.completed);
    const recovered = completed.filter((row) => {
      const baseline = rootCalls.get(`${row.tier} ${row.taskId} ${row.seed}`);
      return baseline !== undefined && row.modelCalls > baseline;
    }).length;
    return {
      armId,
      tier,
      counted: counted.length,
      completed: completed.length,
      successRate: counted.length
        ? Math.round((1000 * completed.length) / counted.length) / 10
        : Number.NaN,
      meanModelCalls: mean(counted.map((row) => row.modelCalls)),
      meanTokensOut: mean(metered.map((row) => row.tokensOut)),
      meanTokensIn: mean(metered.map((row) => row.tokensIn)),
      recovered,
      ghosts,
      unmetered: counted.length - metered.length,
      errors,
      ranOut: counted.filter((row) => row.ranOut).length
    };
  });
};

const figure = (value: number, suffix = ''): string =>
  Number.isNaN(value) ? '-' : `${value}${suffix}`;

export const renderLive = (scores: readonly ArmScore[]): string => {
  const lines: string[] = [
    '',
    `what each arm did with it ${RULE}`,
    '',
    `  ${padEnd('arm', 12)} ${padEnd('tier', 28)} ${pad('n', 4)} ${pad('success', 8)} ${pad('calls', 6)} ${pad('out tok', 8)} ${pad('in tok', 8)} ${pad('recovered', 10)}   diagnostics`
  ];
  for (const score of scores) {
    const diagnostics = [
      score.ghosts ? `${score.ghosts} ghost` : '',
      score.unmetered ? `${score.unmetered} unmetered` : '',
      score.errors ? `${score.errors} error` : '',
      score.ranOut ? `${score.ranOut} hit the step ceiling` : ''
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `  ${padEnd(score.armId, 12)} ${padEnd(score.tier, 28)} ${pad(score.counted, 4)} ${pad(figure(score.successRate, '%'), 8)} ${pad(figure(score.meanModelCalls), 6)} ${pad(figure(score.meanTokensOut), 8)} ${pad(figure(score.meanTokensIn), 8)} ${pad(score.recovered, 10)}   ${diagnostics || '-'}`
    );
  }
  lines.push(
    '',
    '  "recovered" is completed, in more turns than the shipped arm needed for the same task and',
    '  seed. It is the distinction the whole programme turns on: could not do it, versus did it the',
    '  long way. A strong model hides a bad harness by paying turns for it, and this is the column',
    '  where that payment shows up.',
    ''
  );
  return `${lines.join('\n')}\n`;
};

export const renderQuestions = (): string => {
  const lines = ['', `what each arm asks, and what would let it ship ${RULE}`, ''];
  for (const arm of ARMS) {
    lines.push(`  ${arm.id}`);
    lines.push(`    asks:  ${arm.asks}`);
    lines.push(`    ships: ${armById(arm.id).ships}`);
    lines.push('');
  }
  lines.push(PRE_REGISTRATION, '');
  return `${lines.join('\n')}\n`;
};

/* ------------------------------------------------------------------------------- the baseline */

export interface Baseline {
  readonly resident: Record<string, { readonly residentBytes: number; readonly toolCount: number }>;
}

export const baselineFrom = (rows: readonly Resident[]): Baseline => ({
  resident: Object.fromEntries(
    rows.map((row) => [row.armId, { residentBytes: row.residentBytes, toolCount: row.toolCount }])
  )
});

/**
 * A number that moved is a decision somebody took, not a failure - but it has to be an accepted one.
 *
 * The shipped arm's resident bytes moving means the contract, the catalogue or the skill index
 * changed, which is worth a moment every time it happens. A candidate arm's bytes moving means the
 * saving being argued for is no longer the saving that was argued for, and the argument has to be
 * re-made against the new number rather than inheriting the old one's conclusion.
 */
export const check = (rows: readonly Resident[], baseline: Baseline | undefined): string[] => {
  if (!baseline) return ['no committed baseline; run with --accept once you have read the table'];
  const failures: string[] = [];
  for (const row of rows) {
    const was = baseline.resident[row.armId];
    if (!was) {
      failures.push(`${row.armId}: new arm, not in the baseline`);
      continue;
    }
    if (was.residentBytes !== row.residentBytes)
      failures.push(
        `${row.armId}: resident bytes ${was.residentBytes} -> ${row.residentBytes} (${row.residentBytes > was.residentBytes ? '+' : ''}${row.residentBytes - was.residentBytes})`
      );
    if (was.toolCount !== row.toolCount)
      failures.push(`${row.armId}: tools ${was.toolCount} -> ${row.toolCount}`);
  }
  for (const armId of Object.keys(baseline.resident))
    if (!rows.some((row) => row.armId === armId))
      failures.push(`${armId}: arm has gone from the table`);
  return failures;
};

/* ------------------------------------------------------------------------------ the edit axis */

/**
 * The edit axis prints three things, in this order, and the order is the argument.
 *
 * First the sample and what is not in it. Second what is knowable for nothing - the residency of
 * the dialect, the character bound `evals/edit` already measured over these same rows, and the
 * read-side surcharge that bound does not include. Third, what a live run would cost, before
 * anybody spends it.
 *
 * The bound is printed as a bound. It is what the dialect costs a model that gets it right every
 * time, it is the number that has been quoted in three documents, and the whole reason this arm
 * exists is that nothing offline can say whether any model earns it.
 */
export const renderEditSample = (): string => {
  const lines: string[] = [
    '',
    `the edit axis: the sample ${RULE}`,
    '',
    `  ${EDIT_TASKS.length} tasks, derived from evals/edit/corpus.ts - the corpus a previous wave wrote to`,
    '  argue the other side of this question, before this arm existed.',
    ''
  ];
  for (const task of EDIT_TASKS)
    lines.push(
      `  ${padEnd(task.corpusId, 24)} ${padEnd(task.shape, 8)} ${task.request.length} chars of request`
    );
  lines.push(
    '',
    `  Not in the sample: ${EXCLUDED_CORPUS_IDS.join(', ')}. Two drift the file between the read and`,
    '  the edit and one addresses a line the model was never shown; this world does neither, and both',
    '  classes are rows the CANDIDATE wins - it refuses them and the incumbent lands one of them',
    '  wrongly. Their absence understates the candidate, which is the safe direction for a rig whose',
    '  job is to stop something shipping on a number nobody has tested.',
    '',
    '  Every arm receives byte-identical requests. The request quotes the lines as they read now and',
    '  the lines they should read afterwards, which hands file_patch half of its own call and is',
    '  deliberate: the incumbent is measured at its best, the way evals/edit measured it too.',
    ''
  );
  return `${lines.join('\n')}\n`;
};

export const renderEditBound = (): string => {
  const rows = characterBound();
  const quoted = rows.reduce((sum, row) => sum + row.quoted, 0);
  const addressed = rows.reduce((sum, row) => sum + row.lineAddressed, 0);
  const read = readSurcharge();
  const lines: string[] = [
    '',
    `the edit axis: what is knowable without a model ${RULE}`,
    '',
    `  ${padEnd('task', 24)} ${pad('quoted', 11)} ${pad('by line', 10)} ${pad('saved', 7)}`
  ];
  for (const row of rows)
    lines.push(
      `  ${padEnd(row.id, 24)} ${pad(row.quoted, 11)} ${pad(row.lineAddressed, 10)} ${pad(`${Math.round(((row.quoted - row.lineAddressed) / row.quoted) * 100)}%`, 7)}`
    );
  lines.push(
    `  ${padEnd(`over ${rows.length} tasks`, 24)} ${pad(quoted, 11)} ${pad(addressed, 10)} ${pad(`${Math.round(((quoted - addressed) / quoted) * 100)}%`, 7)}`,
    '',
    '  Characters of tool arguments, both sides encoded by a model that makes no mistake, both put',
    '  through the shipped appliers and scored on the file afterwards - so a row that appears here',
    '  is a row where both dialects really do the work. It is an UPPER BOUND on the saving and it is',
    '  the whole reason this arm exists: it is what the dialect costs a model that spells it',
    '  correctly every time, and no offline rig can say whether one does.',
    '',
    '  It is also SMALLER than the 61% this format has been quoted at, and the difference is not',
    '  noise. That figure was measured before the quoted editor gained its fourth patch shape and',
    '  over fifteen rows rather than these twelve. Here the incumbent moves a block with one copy of',
    '  the text rather than two, which is its own last improvement and its best case, and the rename',
    '  row is a tie because neither dialect can express one - the runner client has no rename route,',
    '  so both arms reach for the shell. Measuring the incumbent at its best is what a candidate has',
    '  to beat.',
    '',
    `  The read side, which is INPUT and is paid whether or not an edit follows: ${read.plain} characters`,
    `  plain against ${read.numbered} numbered over one whole-file read of each file in the sample, +${Math.round(((read.numbered - read.plain) / read.plain) * 100)}%.`,
    '  The dialect needs the numbers, so this surcharge belongs to it and is not netted off the',
    '  saving above; they are different currencies and the ruling is where they get weighed. Worse',
    '  than it looks, too: the file is carried into every later request of the same turn, so the',
    '  surcharge is paid once per remaining call rather than once. The price table below charges it',
    '  that way.',
    ''
  );
  return `${lines.join('\n')}\n`;
};

/**
 * What a live run costs, in the two units somebody paying for it can act on.
 *
 * The token figures are arithmetic over bytes this rig already measures - `price.ts` says which -
 * and the rate is read from the provider's own catalogue rather than from a constant in this
 * repository. Where the rate could not be read, the tokens print and the money does not, and the
 * reason is on the page. A price nobody can check is worse than no price.
 */
export const renderEditPrice = (
  resident: readonly Resident[],
  armIds: readonly string[],
  tiers: readonly string[],
  seeds: number,
  rates: Rates | null
): string => {
  const arms = resident.filter((row) => armIds.includes(row.armId));
  const line = arms.find((row) => settingsFor(row.armId).edit === 'lines');
  const quoted = arms.find((row) => settingsFor(row.armId).edit === 'patch');
  const lines: string[] = [
    '',
    `the edit axis: what a live run costs ${RULE}`,
    '',
    `  ${padEnd('tier', 28)} ${padEnd('arm', 12)} ${pad('calls', 10)} ${pad('prompt tok', 20)} ${pad('output tok', 16)} ${pad('USD', 17)}`
  ];
  let floorTotal = 0;
  let ceilingTotal = 0;
  let priced = true;
  const perTier = new Map<string, { line: number; quoted: number }>();
  for (const tier of tiers) {
    const rate = rates?.rates.find((one) => one.model === tier) ?? null;
    if (!rate) priced = false;
    for (const arm of arms) {
      const estimate = estimateArm(arm, seeds);
      const low = rate
        ? dollars(estimate.promptTokensFloor, estimate.outputTokensFloor, rate)
        : Number.NaN;
      const high = rate
        ? dollars(estimate.promptTokensCeiling, estimate.outputTokensCeiling, rate)
        : Number.NaN;
      if (rate) {
        floorTotal += low;
        ceilingTotal += high;
        const seen = perTier.get(tier) ?? { line: 0, quoted: 0 };
        if (arm.armId === line?.armId) seen.line = low;
        if (arm.armId === quoted?.armId) seen.quoted = low;
        perTier.set(tier, seen);
      }
      lines.push(
        `  ${padEnd(tier, 28)} ${padEnd(arm.armId, 12)} ${pad(`${estimate.callsFloor}-${estimate.callsCeiling}`, 10)} ${pad(`${estimate.promptTokensFloor.toLocaleString('en-GB')} - ${estimate.promptTokensCeiling.toLocaleString('en-GB')}`, 20)} ${pad(`${estimate.outputTokensFloor.toLocaleString('en-GB')} - ${estimate.outputTokensCeiling.toLocaleString('en-GB')}`, 16)} ${pad(rate ? `$${low.toFixed(2)} - $${high.toFixed(2)}` : '-', 17)}`
      );
    }
  }
  lines.push('');
  if (rates && priced)
    lines.push(
      `  THE WHOLE RUN: $${floorTotal.toFixed(2)} if every row is perfect, $${ceilingTotal.toFixed(2)} if every row walks into the`,
      `  ${MAX_STEPS}-step ceiling with the ${MAX_OUTPUT_TOKENS}-token output cap bound on every call. The true figure is`,
      '  between them and much closer to the first: the ceiling assumes every row of both arms fails',
      '  in the most expensive way available to it.'
    );
  else
    lines.push(
      '  NO PRICE. The token figures above are measured; the money is not shown because the rate',
      '  could not be read, and no constant in this repository stands in for it.'
    );
  lines.push(
    '',
    `  ${rates?.note ?? 'rates were not asked for: the price is read from the provider when --live is.'}`,
    '',
    `  ${EDIT_TASKS.length} tasks x ${tiers.length} tier(s) x ${seeds} seed(s) x ${arms.length} arms. A row is between ${MIN_CALLS_PER_EDIT} calls - read, edit,`,
    `  finish - and the ${MAX_STEPS}-step ceiling. The floor is not a guess: the resident block, the request, the`,
    '  file as each dialect shows it and the edit call itself are all exact, and every one of them is',
    '  carried into every later request of the same turn, which is where a numbered read is actually',
    '  paid for.',
    ''
  );

  /*
   * And the question this rig exists downstream of: not what the run costs, but what the DIALECT
   * costs once it is running. Printed here rather than in a document because it is arithmetic over
   * the two rows immediately above it, and because every report on this format so far has left it
   * open on the grounds that output characters and input characters are different currencies. They
   * are, and the provider publishes the exchange rate.
   */
  if (line && quoted && rates?.rates.length) {
    lines.push(`  what the DIALECT costs, once it is running ${'-'.repeat(46)}`, '');
    for (const tier of tiers) {
      const rate = rates.rates.find((one) => one.model === tier);
      if (!rate) continue;
      const even = breakEven(line, quoted, rate);
      const lineRun = estimateArm(line, seeds);
      const quotedRun = estimateArm(quoted, seeds);
      const lineCost = cost(lineRun.promptTokensFloor, lineRun.outputTokensFloor, rate);
      const quotedCost = cost(quotedRun.promptTokensFloor, quotedRun.outputTokensFloor, rate);
      // Percent and tokens rather than dollars. Over twelve small tasks the difference is a
      // fraction of a cent, and a table that rounds it to $0.00 reports "free" for the thing it
      // was built to price. The ratio is what carries over to a run of any size.
      const share = quotedCost ? ((lineCost - quotedCost) / quotedCost) * 100 : Number.NaN;
      const tokenDelta =
        lineRun.promptTokensFloor +
        lineRun.outputTokensFloor -
        (quotedRun.promptTokensFloor + quotedRun.outputTokensFloor);
      lines.push(
        `  ${tier}: $${rate.inPerMillion}/M in, $${rate.outPerMillion}/M out.`,
        `    A perfect run of this sample costs ${share >= 0 ? '+' : ''}${share.toFixed(1)}% ${share >= 0 ? 'MORE' : 'less'} through the line dialect than through`,
        `    the quoted editor - ${tokenDelta >= 0 ? '+' : ''}${tokenDelta.toLocaleString('en-GB')} tokens over ${EDIT_TASKS.length} tasks - because it spends ${even.residentDeltaTokens} resident tokens on`,
        `    every one of the ${even.callsPerTurn} requests a turn makes and ${even.numberingTokensPerRead} more on every request after a read,`,
        `    to save ${even.savedOutputTokensPerEdit} output tokens per landed edit.`,
        even.editsPerTurn === Number.POSITIVE_INFINITY
          ? '    At this rate the saving cannot repay the spec at any number of edits.'
          : `    BREAK-EVEN: ${even.editsPerTurn.toFixed(1)} landed edits per turn, at this sample's mean edit size and`,
        even.editsPerTurn === Number.POSITIVE_INFINITY
          ? ''
          : `    ${even.callsPerTurn} requests per turn. A turn that makes more requests pays the spec more times and`,
        even.editsPerTurn === Number.POSITIVE_INFINITY ? '' : '    needs more edits to clear it.',
        ''
      );
    }
    lines.push(
      '  Read that as a shape rather than a threshold. The resident cost is fixed and the saving',
      '  grows with the size of an edit, so a turn that lands one three-line change pays for the',
      '  dialect and a turn that rewrites four functions is paid by it. This sample is deliberately',
      "  made of small edits, which is the dialect's worst case and the honest place to measure it:",
      '  it is the shape of edit an agent makes most often.',
      ''
    );
  }
  return `${lines.join('\n')}\n`;
};

export interface EditScore {
  readonly armId: string;
  readonly tier: string;
  readonly counted: number;
  readonly correct: number;
  readonly nearly: number;
  readonly editCalls: number;
  readonly editApplied: number;
  /** Applied calls the harness had to forgive a malformed spelling to accept. */
  readonly editForgiven: number;
  /** Refused calls with no later applied call in the same turn. The ship criterion reads this. */
  readonly unrecovered: number;
  /** The anchored form, per model: present, corrected, refused as ambiguous, echo misses, prefixes. */
  readonly anchorPresent: number;
  readonly corrected: number;
  readonly refusedAmbiguous: number;
  readonly echoMiss: number;
  readonly prefixStripped: number;
  readonly meanTokensOut: number;
  readonly meanTokensIn: number;
  readonly meanModelCalls: number;
  readonly refusals: readonly string[];
  readonly ghosts: number;
  readonly unmetered: number;
  readonly errors: number;
}

export const scoreEditArms = (rows: readonly EditRow[]): readonly EditScore[] => {
  // The same NUL separator `scoreArms` above uses, and for the same reason: a provider id is
  // arbitrary text, and a key joined on a space is a key that splits wrong the first time somebody
  // points this at a model whose name has one in it. Two functions in one file splitting the same
  // composite key two different ways is how that gets found in a table rather than in a test.
  const keys = [...new Set(rows.map((row) => `${row.armId}\u0000${row.tier}`))];
  return keys.map((key) => {
    const [armId = '', tier = ''] = key.split('\u0000');
    const all = rows.filter((row) => row.armId === armId && row.tier === tier);
    const counted = all.filter((row) => !row.error && !row.ghost);
    const metered = counted.filter((row) => row.metered);
    const total = (pick: (row: EditRow) => number): number =>
      counted.reduce((sum, row) => sum + pick(row), 0);
    return {
      armId,
      tier,
      counted: counted.length,
      correct: counted.filter((row) => row.correct).length,
      nearly: counted.filter((row) => row.nearly && !row.correct).length,
      editCalls: total((row) => row.editCalls),
      editApplied: total((row) => row.editApplied),
      editForgiven: total((row) => row.editForgiven),
      unrecovered: total((row) => row.unrecovered),
      anchorPresent: total((row) => row.anchorPresent),
      corrected: total((row) => row.corrected),
      refusedAmbiguous: total((row) => row.refusedAmbiguous),
      echoMiss: total((row) => row.echoMiss),
      prefixStripped: total((row) => row.prefixStripped),
      meanTokensOut: mean(metered.map((row) => row.tokensOut)),
      meanTokensIn: mean(metered.map((row) => row.tokensIn)),
      meanModelCalls: mean(counted.map((row) => row.modelCalls)),
      refusals: counted.flatMap((row) => row.refusals.map((refusal) => refusal.kind)),
      ghosts: all.filter((row) => row.ghost).length,
      unmetered: counted.length - metered.length,
      errors: all.filter((row) => row.error).length
    };
  });
};

/**
 * Edit-success, output tokens, and the criterion's own number, on the same row.
 *
 * That third column is what this whole lane is for. The pre-registered rule is not "the dialect is
 * cheaper" and not "the model spells it correctly" - it is "no more than one edit call in twenty
 * is refused for a dialect error the model does not then recover from", and until this table
 * existed there was nowhere that number could come from. It is deliberately printed beside
 * `forgiven`, which is its twin: a malformed emission the harness absorbed cost nothing at all,
 * and an arm whose forgiven count is high and whose unrecovered count is zero is an arm where the
 * model spells the dialect badly and it does not matter. Those are opposite findings that a
 * refusal count alone reports as the same number.
 */
export const renderEditLive = (scores: readonly EditScore[]): string => {
  const lines: string[] = [
    '',
    `the edit axis: what each arm did with it ${RULE}`,
    '',
    `  ${padEnd('arm', 12)} ${padEnd('tier', 28)} ${pad('n', 4)} ${pad('correct', 8)} ${pad('applied', 9)} ${pad('forgiven', 9)} ${pad('unrecov', 8)} ${pad('calls', 6)} ${pad('out tok', 8)} ${pad('in tok', 8)}`
  ];
  for (const score of scores)
    lines.push(
      `  ${padEnd(score.armId, 12)} ${padEnd(score.tier, 28)} ${pad(score.counted, 4)} ${pad(`${score.correct}/${score.counted}`, 8)} ${pad(score.editCalls ? `${score.editApplied}/${score.editCalls}` : '-', 9)} ${pad(score.editForgiven, 9)} ${pad(score.unrecovered, 8)} ${pad(figure(score.meanModelCalls), 6)} ${pad(figure(score.meanTokensOut), 8)} ${pad(figure(score.meanTokensIn), 8)}`
    );
  lines.push('');
  for (const score of scores) {
    const kinds = [...new Set(score.refusals)].sort();
    const diagnostics = [
      score.nearly ? `${score.nearly} right but for trailing whitespace` : '',
      kinds.length ? `refused: ${kinds.join(', ')}` : '',
      score.ghosts ? `${score.ghosts} ghost` : '',
      score.unmetered ? `${score.unmetered} unmetered` : '',
      score.errors ? `${score.errors} error` : ''
    ]
      .filter(Boolean)
      .join(', ');
    if (diagnostics) lines.push(`  ${score.armId} on ${score.tier}: ${diagnostics}`);
    if (score.editCalls)
      lines.push(
        `  ${score.armId} on ${score.tier}: anchors present ${score.anchorPresent}/${score.editCalls}, corrected ${score.corrected}, refused ambiguous ${score.refusedAmbiguous}, echo misses ${score.echoMiss}, prefixes stripped ${score.prefixStripped}`
      );
  }
  lines.push(
    '',
    '  "anchors present" is edit calls carrying the one - row the spec teaches; "corrected" is calls',
    '  where that row moved a miscounted number; "refused ambiguous" is calls the row could not',
    '  place; "echo misses" is anchored calls that applied and still left the wrong file.',
    '',
    '  "correct" is the file afterwards, byte for byte against what the task asked for - never the',
    '  tool own word for what it did. "applied" is edit calls the harness accepted out of edit calls',
    '  made. "forgiven" is applied calls that were malformed and were absorbed without a round trip.',
    '  "unrecov" is refused calls with no later applied call in the same turn, which is the quantity',
    '  the ship criterion is written against and the only one that costs a whole generation.',
    ''
  );
  return `${lines.join('\n')}\n`;
};

/**
 * The pre-registered rule, applied to the numbers, before anybody gets to read them selectively.
 *
 * Written as arithmetic rather than as a paragraph because a criterion a human applies after
 * seeing the table is not a criterion. Three outcomes, and the third is the one that matters most:
 * a run can fail to RESOLVE the question, and a run that cannot resolve it must not be reported as
 * a pass. One in twenty cannot be observed on twelve edit calls - the smallest non-zero rate that
 * sample can produce is one in twelve, which already fails - so the resolution check comes first
 * and says how many seeds would be needed.
 */
export const renderEditVerdict = (scores: readonly EditScore[]): string => {
  const rule = 1 / 20;
  const tiers = [...new Set(scores.map((score) => score.tier))];
  const lines: string[] = ['', `the edit axis: the pre-registered rule, applied ${RULE}`, ''];
  lines.push(`  ${armById(EDIT_ARM).ships}`, '');
  let verdict: 'ships' | 'does not ship' | 'unresolved' = 'ships';
  const say = (line: string): void => {
    lines.push(`  ${line}`);
  };
  /*
   * Which arm is which is read off the settings, never off the id.
   *
   * The rule is written about the line-addressed dialect and the quoted one, and which of those
   * two the ROOT arm holds flipped the day the dialect landed. A verdict that hard-coded
   * `line-edit` against `shipped` would have gone on printing a confident answer to the mirror
   * image of the question. `arms.ts` records the direction; this reads it.
   */
  const armWith = (dialect: 'lines' | 'patch', tier: string): EditScore | undefined =>
    scores.find(
      (score) =>
        score.tier === tier &&
        [ROOT_ARM, EDIT_ARM].includes(score.armId) &&
        settingsFor(score.armId).edit === dialect
    );
  for (const tier of tiers) {
    const candidate = armWith('lines', tier);
    const shipped = armWith('patch', tier);
    if (!candidate || !shipped) {
      say(`${tier}: only one arm ran, so this tier decides nothing.`);
      verdict = 'unresolved';
      continue;
    }
    const withinOne = candidate.correct >= shipped.correct - 1;
    const rate = candidate.editCalls ? candidate.unrecovered / candidate.editCalls : Number.NaN;
    const resolvable = candidate.editCalls >= 20;
    say(
      `${tier}: the line dialect (${candidate.armId}) is correct ${candidate.correct}/${candidate.counted} against the quoted editor's`
    );
    say(
      `${' '.repeat(tier.length)}  ${shipped.correct}/${shipped.counted} (${shipped.armId}) - ${withinOne ? 'within one task' : 'MORE than one task behind'}.`
    );
    say(
      `${' '.repeat(tier.length)}  unrecovered ${candidate.unrecovered} of ${candidate.editCalls} edit calls = ${Number.isNaN(rate) ? 'no edit calls at all' : `${(rate * 100).toFixed(1)}%`}, against a ceiling of 5.0%.`
    );
    if (!resolvable) {
      say(
        `${' '.repeat(tier.length)}  THIS SAMPLE CANNOT RESOLVE THAT: ${candidate.editCalls} edit calls means the smallest rate it can`
      );
      say(
        `${' '.repeat(tier.length)}  print other than zero is ${((1 / Math.max(1, candidate.editCalls)) * 100).toFixed(1)}%, which already fails. Zero refusals here is`
      );
      say(
        `${' '.repeat(tier.length)}  consistent with a true rate above one in twenty. Re-run with --seeds ${Math.ceil(20 / Math.max(1, candidate.editCalls))} or more.`
      );
      verdict = 'unresolved';
    }
    if (!withinOne || (resolvable && rate > rule)) verdict = 'does not ship';
  }
  if (!tiers.length) {
    say('nothing ran.');
    verdict = 'unresolved';
  } else if (tiers.length < 2) {
    say('');
    say('ONE TIER ONLY. The rule says both, and it says both for a reason: a strong model hides a');
    say(
      'bad harness by paying turns for it, so the weak tier is where a correctness risk shows and'
    );
    say('the strong tier is where the saving does. A run on one of them settles neither.');
    verdict = 'unresolved';
  }
  lines.push(
    '',
    `  VERDICT: ${verdict === 'ships' ? 'the rule is met on every tier that ran.' : verdict === 'does not ship' ? 'the rule is NOT met. The candidate does not ship on this run.' : 'the rule is NOT SETTLED by this run. Nothing ships and nothing is refuted.'}`,
    ''
  );
  return `${lines.join('\n')}\n`;
};
