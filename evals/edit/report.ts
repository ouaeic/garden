/**
 * The tables, the questions they answer, and the baseline gate.
 *
 * The questions are printed ABOVE the numbers and are fixed before the run, for the reason every
 * rig in `evals/` gives about itself: a rule chosen after seeing the table is not a rule. The one
 * that matters most here is the last, because it is the one this lane could get wrong in its own
 * favour - a corpus of failures written by somebody who wants the format to look forgiving is a
 * corpus of failures the format happens to forgive.
 */
import { isDefect, roundTrips, type ConformanceRow, type Cost, type Group } from './conformance.js';
import { type PairRow } from './incumbent.js';

export interface Baseline {
  readonly conformance: Record<string, { cost: Cost; verdict: string }>;
  readonly pairs: Record<
    string,
    { quoted: { cost: Cost; chars: number }; byLine: { cost: Cost; chars: number } }
  >;
  readonly totals: {
    cases: number;
    free: number;
    oneTrip: number;
    twoTrips: number;
    overRefused: number;
    defects: number;
  };
}

export const renderQuestions = (): string =>
  [
    '',
    '  THE QUESTIONS, fixed before the run',
    '',
    '  1. Of the ways a model can emit this format wrongly, how many cost NOTHING - recovered in',
    '     the same turn, with no extra tool call and no re-read?',
    '  2. Of the ones that are refused, how many refusals are SELF-SUFFICIENT: can the model send a',
    '     corrected patch as its very next call, or must it read the file again first?',
    '  3. Which emissions leave the wrong bytes on disk while the tool reports success? That is not',
    '     a round trip and cannot be priced as one.',
    '  4. Put the SAME malformed intents through the editor this replaced. If its failures are more',
    '     expensive, the argument for the format does not depend on the model being perfect.',
    '',
    '  THE RULES, fixed before the run',
    '',
    '  1. "Self-sufficient" is decided by a program, not by reading the message. A refusal about',
    '     the file must quote the file back under its real line numbers, three consecutive rows of',
    '     it, each matching the file as it really reads. A refusal about spelling must name a legal',
    '     spelling. Both tests are applied to both formats.',
    '  2. Every case declares what a forgiving harness must do BEFORE it is run. A refusal of an',
    '     emission the harness had the evidence to recover is `over-refused` and is counted even',
    '     though it costs only one trip - it is a trip nobody had to pay.',
    '  3. A wrong file is never scored as a round trip. It is scored `X`, or `X-echo` where the',
    '     tool result displays the damaged lines on the same turn.',
    '  4. THIS RIG RUNS NO MODEL. It bounds the cost of each failure; it does not weight them,',
    '     because nothing in garden measures how often a model makes each mistake.',
    ''
  ].join('\n');

const pad = (value: string | number, width: number): string => String(value).padStart(width);

const GROUPS: readonly Group[] = [
  'anchor',
  'anchored',
  'header',
  'body',
  'whitespace',
  'register',
  'encoding',
  'scale',
  'dialect'
];

export const renderConformance = (rows: readonly ConformanceRow[]): string => {
  const out: string[] = [
    '',
    '  EVERY WAY A MODEL CAN GET THIS WRONG, AND WHAT IT COSTS',
    '',
    '  cost  0 nothing · 1 refused, retry is a re-emit · 2 refused, retry needs a read',
    '        X wrong bytes on disk · X-echo wrong bytes the result displays on the same turn',
    ''
  ];
  for (const group of GROUPS) {
    const inGroup = rows.filter((row) => row.group === group);
    if (!inGroup.length) continue;
    out.push(`  ${group}`);
    for (const row of inGroup)
      out.push(`    ${pad(row.cost, 6)}  ${row.verdict.padEnd(13)}${row.id.padEnd(44)}${row.what}`);
    out.push('');
  }
  return out.join('\n');
};

export const renderTotals = (rows: readonly ConformanceRow[]): string => {
  const free = rows.filter((row) => row.cost === 0).length;
  const one = rows.filter((row) => row.cost === 1).length;
  const two = rows.filter((row) => row.cost === 2).length;
  const defects = rows.filter((row) => isDefect(row.cost));
  const over = rows.filter((row) => row.verdict === 'over-refused');
  const trips = rows.reduce((sum, row) => sum + roundTrips(row.cost), 0);
  return [
    '',
    '  WHAT THE WHOLE CORPUS COSTS',
    '',
    `    ${pad(rows.length, 4)} emissions driven through the real applier and the real snapshot store`,
    `    ${pad(free, 4)} cost nothing - recovered in the turn that made the mistake`,
    `    ${pad(one, 4)} refused with the correction inside the refusal - one generation, no read`,
    `    ${pad(two, 4)} refused with neither the file's text nor a legal spelling - a read first`,
    `    ${pad(defects.length, 4)} left the wrong bytes on disk while reporting success`,
    `    ${pad(over.length, 4)} were refused although the harness had what it needed to recover them`,
    '',
    `    ${pad(trips, 4)} extra round trips over the whole corpus, ${(trips / rows.length).toFixed(2)} per malformed emission`,
    '',
    ...(defects.length
      ? [
          '  THE DEFECTS - a wrong file is not a round trip and cannot be priced as one',
          '',
          ...defects.flatMap((row) => [
            `    ${row.cost}  ${row.id}`,
            ...wrap(row.finding ?? row.what, 6)
          ]),
          ''
        ]
      : ['  No emission in the corpus left the wrong bytes on disk.', '']),
    ...(over.length
      ? [
          '  THE AVOIDABLE ROUND TRIPS - refused although the evidence to recover was in the patch',
          '',
          ...over.flatMap((row) => [`    ${row.id}`, ...wrap(row.finding ?? row.what, 6)]),
          ''
        ]
      : [])
  ].join('\n');
};

/** Findings are prose and the table is columns; this is the one place prose is allowed to run. */
const wrap = (text: string, indent: number): string[] => {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > 96 - indent) {
      lines.push(`${' '.repeat(indent)}${line}`);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(`${' '.repeat(indent)}${line}`);
  return lines;
};

export const renderPairs = (rows: readonly PairRow[], incumbent: string): string => {
  const out: string[] = [
    '',
    '  THE SAME INTENTS THROUGH THE EDITOR THIS REPLACED',
    '',
    `  file_patch was: ${incumbent}`,
    '  ...and it is no longer in apps/worker/src/tools/workspace.ts, which is what the pin checks.',
    '',
    '  intent                        quoted                        by line                       ',
    '  --------------------------------------------------------------------------------------------'
  ];
  for (const row of rows)
    out.push(
      `  ${row.id.padEnd(28)}${pad(row.quoted.cost, 3)} ${row.quoted.verdict.padEnd(13)}${pad(row.quoted.chars, 5)}c   ` +
        `${pad(row.byLine.cost, 6)} ${row.byLine.verdict.padEnd(13)}${pad(row.byLine.chars, 5)}c`
    );

  const quotedTrips = rows.reduce((sum, row) => sum + roundTrips(row.quoted.cost), 0);
  const lineTrips = rows.reduce((sum, row) => sum + roundTrips(row.byLine.cost), 0);
  const quotedChars = rows.reduce((sum, row) => sum + row.quoted.chars, 0);
  const lineChars = rows.reduce((sum, row) => sum + row.byLine.chars, 0);
  const unemittable = rows.filter((row) => !row.quoted.emittable);
  const partial = rows.filter((row) => row.quoted.verdict === 'partial-write');

  out.push(
    '',
    `  extra round trips over ${rows.length} intents:  quoted ${quotedTrips}   by line ${lineTrips}`,
    `  characters of arguments:            quoted ${quotedChars}   by line ${lineChars}` +
      `   (${(100 * (1 - lineChars / quotedChars)).toFixed(0)}% fewer)`,
    '',
    `  ${unemittable.length} of ${rows.length} intents cannot be EMITTED by the quoted format from the read the model was`,
    '  shown: the byte-exact text it needs is not in the live file, and nothing the model can see',
    '  says so - a trailing space, a CRLF, a region another writer has rewritten. The retry is then',
    '  the same call, and the refusal is not one round trip but a loop. A line number is in the',
    '  display by construction, so the line-addressed column has no row of this kind to have:',
    ...unemittable.map((row) => `    ${row.id}`),
    '',
    `  ${partial.length} of ${rows.length} left the file PART edited on disk. Nothing the line-addressed arm does can`,
    '  leave a file part edited: it is atomic per file, and every refusal above wrote nothing:',
    ...partial.map((row) => `    ${row.id}`),
    ''
  );
  return out.join('\n');
};

export const baselineFrom = (
  conformance: readonly ConformanceRow[],
  pairs: readonly PairRow[]
): Baseline => ({
  conformance: Object.fromEntries(
    conformance.map((row) => [row.id, { cost: row.cost, verdict: row.verdict }])
  ),
  pairs: Object.fromEntries(
    pairs.map((row) => [
      row.id,
      {
        quoted: { cost: row.quoted.cost, chars: row.quoted.chars },
        byLine: { cost: row.byLine.cost, chars: row.byLine.chars }
      }
    ])
  ),
  totals: {
    cases: conformance.length,
    free: conformance.filter((row) => row.cost === 0).length,
    oneTrip: conformance.filter((row) => row.cost === 1).length,
    twoTrips: conformance.filter((row) => row.cost === 2).length,
    overRefused: conformance.filter((row) => row.verdict === 'over-refused').length,
    defects: conformance.filter((row) => isDefect(row.cost)).length
  }
});

/**
 * What changed against the committed baseline, in the words a reader needs.
 *
 * Every difference fails, in both directions, and the reason is the same one that put this rig on
 * `pnpm check`: a corpus that only fails when things get worse cannot be trusted to notice when
 * they get better either, and a defect that is quietly fixed without the baseline moving is a
 * defect nobody wrote down. A row that becomes cheaper is a good change that has to be accepted
 * on purpose, with `--accept`, and shows up in the diff.
 */
export const check = (
  conformance: readonly ConformanceRow[],
  pairs: readonly PairRow[],
  baseline: Baseline
): string[] => {
  const problems: string[] = [];
  const fresh = baselineFrom(conformance, pairs);
  for (const [id, was] of Object.entries(baseline.conformance)) {
    const now = fresh.conformance[id];
    if (!now) {
      problems.push(`${id} is no longer in the corpus (was cost ${was.cost}, ${was.verdict})`);
      continue;
    }
    if (now.cost !== was.cost || now.verdict !== was.verdict)
      problems.push(
        `${id}: was ${was.verdict} at cost ${was.cost}, is now ${now.verdict} at cost ${now.cost}`
      );
  }
  for (const id of Object.keys(fresh.conformance))
    if (!baseline.conformance[id])
      problems.push(
        `${id} is a new case with cost ${fresh.conformance[id]?.cost}; accept the baseline to record it`
      );
  for (const [id, was] of Object.entries(baseline.pairs)) {
    const now = fresh.pairs[id];
    if (!now) {
      problems.push(`paired intent ${id} is gone`);
      continue;
    }
    if (now.quoted.cost !== was.quoted.cost || now.byLine.cost !== was.byLine.cost)
      problems.push(
        `${id}: quoted ${was.quoted.cost} -> ${now.quoted.cost}, by line ${was.byLine.cost} -> ${now.byLine.cost}`
      );
    if (now.quoted.chars !== was.quoted.chars || now.byLine.chars !== was.byLine.chars)
      problems.push(
        `${id}: characters quoted ${was.quoted.chars} -> ${now.quoted.chars}, by line ${was.byLine.chars} -> ${now.byLine.chars}`
      );
  }
  for (const [key, value] of Object.entries(baseline.totals)) {
    const now = fresh.totals[key as keyof Baseline['totals']];
    if (now !== value) problems.push(`total ${key}: ${value} -> ${now}`);
  }
  return problems;
};
