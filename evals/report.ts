/**
 * What the run is worth reading for: what passed, what regressed, and what each shape of request
 * costs in steps and prompt tokens.
 *
 * The cost half is the point of the exercise. Every consequential decision in the loop is currently
 * defended by one remembered incident, and none of them can be argued about because nobody can say
 * what removing one would cost. A number per fixture, held against a committed baseline, turns that
 * into an ordinary engineering question: delete the hold, run this, read the difference.
 */
import {
  HOLD_ORDER,
  identityLabel,
  runIdentity,
  type Expectation,
  type Fixture,
  type HoldName,
  type RunOutcome
} from './harness.js';

/**
 * What the committed numbers were measured by, written into the file beside them.
 *
 * Kept under a key no fixture id can collide with - ids are lower-case words and hyphens, and
 * `evals/run.ts` reads the file only by fixture id, so this row is invisible to every lookup that
 * matters. That is deliberate: a separate provenance file is a file that goes stale on its own, and
 * a nested `{stamp, rows}` shape would be a format change in a file another lane owns the reader
 * of.
 *
 * What it buys is the question a baseline diff could never answer. "435 model calls became 441" is
 * unreadable a year later without knowing which athanor and which rig produced each half; with this
 * both are a `git checkout` away. `harness` is the digest of the three files that decide every
 * number in this file, so a baseline accepted under a different digest was accepted by a different
 * instrument - reported as a note, never as a failure, because adding a fixture legitimately moves
 * it and a gate that fires on every commit is one somebody deletes.
 */
export const BASELINE_STAMP_KEY = '$stamp';

export interface BaselineStamp {
  /** When `--accept` was run. Prose, for a reader; nothing compares it. */
  readonly acceptedAt: string;
  readonly version: string;
  readonly commit: string | null;
  readonly harness: string;
}

export interface Baseline {
  readonly [id: string]: {
    readonly modelCalls: number;
    readonly promptTokens: number;
    /**
     * Of those tokens, the ones that were tool schema.
     *
     * Committed as its own row because it is the largest single term in a request and the one the
     * residency work moves, and because a total is unreadable without it: a turn that took one step
     * fewer and a turn whose catalogue shrank by a third are the same number in a sum. Optional so
     * a baseline accepted before this column existed still gates the two rows it does have, rather
     * than reading as a suite-wide regression on the first run after the upgrade.
     */
    readonly catalogueTokens?: number;
    readonly cachePrefix?: number;
    readonly displayedLines?: number;
  };
}

/**
 * The stamp out of a parsed baseline, or null.
 *
 * Validated field by field rather than cast, because it arrives from a file: a stamp half-written
 * by an interrupted `--accept`, or hand-edited, would otherwise print as a revision that never
 * existed - which is worse than printing nothing, because somebody would try to check it out.
 */
export const stampOf = (baseline: Baseline): BaselineStamp | null => {
  const row = (baseline as Record<string, unknown>)[BASELINE_STAMP_KEY];
  if (typeof row !== 'object' || row === null) return null;
  const { acceptedAt, version, commit, harness } = row as Record<string, unknown>;
  if (typeof acceptedAt !== 'string' || typeof version !== 'string') return null;
  if (typeof harness !== 'string') return null;
  if (commit !== null && typeof commit !== 'string') return null;
  return { acceptedAt, version, commit, harness };
};

export interface Result {
  readonly fixture: Fixture;
  readonly outcome: RunOutcome;
  /** Every expectation that did not hold, already phrased as expected-versus-actual. */
  readonly failures: readonly string[];
}

/**
 * Whether a row's failures are the ones it was written to have.
 *
 * A pending fixture states the target rather than the present, so its failures are the measurement
 * and not the problem; the run reports them and stays green. A pending fixture with NO failures is
 * a failure of its own, because it means the thing it was waiting for arrived and nobody noticed -
 * and the marker, once stale, turns the next real regression on that row into a pending row.
 */
export const pendingHeld = (result: Result): boolean =>
  result.fixture.pending !== undefined && result.failures.length > 0;

export const brokenPromise = (result: Result): boolean =>
  result.fixture.pending !== undefined && result.failures.length === 0;

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const TOKEN_BAND = 0.02;
const CACHE_PREFIX_BAND = 3;

export const check = (
  expect: Expectation,
  outcome: RunOutcome,
  /** The committed row for this fixture, when it has one. A new fixture has none and is not banded. */
  before?: Baseline[string]
): string[] => {
  const failures: string[] = [];
  const compare = <T>(label: string, wanted: T | undefined, got: T): void => {
    if (wanted !== undefined && wanted !== got)
      failures.push(`${label}: expected ${String(wanted)}, got ${String(got)}`);
  };
  if (outcome.error) failures.push(`the run threw: ${outcome.error}`);
  // Asserted for every fixture and never declarable, because a fixture cannot consent to this: a
  // route the stub does not model is answered 404, and whatever number this row reports about the
  // mechanism behind that route was produced by its failure branch.
  for (const route of outcome.unstubbedRoutes)
    failures.push(`the runner stub does not model ${route}, so this run measured a 404`);
  // Also never declarable. A request carrying the directory this checkout happens to sit in makes
  // the row a measurement of this machine, and hands a model provider somebody's home directory.
  if (outcome.checkoutPathLeaks)
    failures.push(
      `${outcome.checkoutPathLeaks} request(s) carried this machine's checkout path, so this row is not reproducible anywhere else`
    );
  // A tool is recorded as started before it runs, so `tools` is green whether the call worked or
  // threw. This is the difference, and it defaults on: a fixture has to say when one of its own
  // calls was meant to fail.
  if (expect.noFailedTools !== false && outcome.failedTools.length)
    failures.push(`tools that threw rather than returning: [${outcome.failedTools.join(', ')}]`);
  // Likewise the empty list is the default. A warning is the loop surviving something it should not
  // have had to survive, and one that fires on every run is the shape a broken subsystem takes in a
  // suite that reports green.
  if (!same(expect.warnings ?? [], outcome.warnings))
    failures.push(
      `warnings raised: expected [${(expect.warnings ?? []).join(' | ')}], got [${outcome.warnings.join(' | ')}]`
    );
  compare('model calls', expect.modelCalls, outcome.modelCalls);
  compare('model calls spent inside specialists', expect.delegatedCalls, outcome.delegatedCalls);
  compare('status', expect.status, outcome.status);
  compare('verification', expect.verification, outcome.verification);
  compare('asked the owner', expect.askedOwner, outcome.askedOwner);
  compare('fallback plan written', expect.fallbackPlan, outcome.fallbackPlan);
  compare('untrusted content recorded', expect.untrusted, outcome.untrusted);
  compare('replies to the owner', expect.replies, outcome.replies);
  compare('commands run in the workspace', expect.commandsRun, outcome.commandsRun);
  compare('compactions performed', expect.compactions, outcome.compactions);
  compare('media generations charged for', expect.mediaGenerated, outcome.mediaGenerated);
  compare(
    'the closing request offered the same catalogue as the step before it',
    expect.finalCatalogueUnchanged,
    outcome.finalCatalogueUnchanged
  );
  compare(
    'every step was offered the same catalogue',
    expect.catalogueStableThroughout,
    outcome.catalogueStableThroughout
  );
  compare('compute credits spent', expect.creditsSpent, outcome.creditsSpent);
  if (expect.minOutputTokens !== undefined && outcome.outputTokens < expect.minOutputTokens)
    failures.push(
      `output tokens the ledger recorded: expected at least ${expect.minOutputTokens}, got ${outcome.outputTokens}`
    );
  compare('the owner’s own words survived', expect.ownerMessageIntact, outcome.ownerMessageIntact);
  compare(
    'memory uses this turn recorded as cited in the answer',
    expect.memoryCitations,
    outcome.memoryCitations
  );
  // Phrased so the -1 reading says what it is. A fixture asserting 0 here is asserting that a halt
  // happened AND that nothing followed it; a run where the guard never denied has not met that.
  if (expect.modelCallsAfterSpendHalt !== undefined)
    failures.push(
      ...(outcome.modelCallsAfterSpendHalt < 0
        ? ['the spending guard never refused a call, so there was no halt to send nothing after']
        : outcome.modelCallsAfterSpendHalt === expect.modelCallsAfterSpendHalt
          ? []
          : [
              `provider calls sent after the spending halt: expected ${expect.modelCallsAfterSpendHalt}, got ${outcome.modelCallsAfterSpendHalt}`
            ])
    );
  compare('the pause was stamped as a spending pause', expect.spendPaused, outcome.spendPaused);
  if (expect.spendNotices && !same(expect.spendNotices, outcome.spendNotices))
    failures.push(
      `spending sentences shown to the owner: expected [${expect.spendNotices.join(' | ')}], got [${outcome.spendNotices.join(' | ')}]`
    );
  if (expect.mediaModels && !same(expect.mediaModels, outcome.mediaModels))
    failures.push(
      `media models asked of the provider: expected [${expect.mediaModels.join(', ')}], got [${outcome.mediaModels.join(', ')}]`
    );
  if (expect.minCachePrefix !== undefined && outcome.cachePrefix < expect.minCachePrefix)
    failures.push(
      `cached prefix: expected at least ${expect.minCachePrefix}% of each request to repeat the one before it, got ${outcome.cachePrefix}%`
    );
  if (expect.minCompactions !== undefined && outcome.compactions < expect.minCompactions)
    failures.push(
      `compactions: expected at least ${expect.minCompactions}, got ${outcome.compactions}`
    );
  if (expect.minBriefSections !== undefined && outcome.briefSections < expect.minBriefSections)
    failures.push(
      `sections in the running brief: expected at least ${expect.minBriefSections}, got ${outcome.briefSections}`
    );
  if (
    expect.minModelWrittenBriefs !== undefined &&
    outcome.modelWrittenBriefs < expect.minModelWrittenBriefs
  )
    failures.push(
      `compactions whose brief a model wrote rather than the deterministic fallback: expected at least ${expect.minModelWrittenBriefs}, got ${outcome.modelWrittenBriefs}`
    );
  if (expect.skillsNamedInBrief && !same(expect.skillsNamedInBrief, outcome.skillsNamedInBrief))
    failures.push(
      `procedures the brief says are no longer in the window: expected [${expect.skillsNamedInBrief.join(', ')}], got [${outcome.skillsNamedInBrief.join(', ')}]`
    );
  // No `> 0` escape any more. The floor is now read off the number the context layer chose rather
  // than reconstructed from the last window, and a turn that squeezed nothing reports the floor it
  // started at - so "nothing to cut" satisfies this on its own terms instead of by being excused.
  if (
    expect.minToolResultFloor !== undefined &&
    outcome.toolResultFloor < expect.minToolResultFloor
  )
    failures.push(
      `the older-tool-output floor: expected it never to fall below ${expect.minToolResultFloor} characters, got ${outcome.toolResultFloor}`
    );
  if (
    expect.minDelegatedCachePrefix !== undefined &&
    outcome.delegatedCachePrefix < expect.minDelegatedCachePrefix
  )
    failures.push(
      `cached prefix inside the specialist: expected at least ${expect.minDelegatedCachePrefix}% of each of its requests to repeat the one before it, got ${outcome.delegatedCachePrefix}%`
    );
  if (
    expect.maxPeakPromptTokens !== undefined &&
    outcome.peakPromptTokens > expect.maxPeakPromptTokens
  )
    failures.push(
      `the largest single prompt: expected no more than ${expect.maxPeakPromptTokens} tokens, got ${outcome.peakPromptTokens}`
    );
  if (
    expect.minCacheBreakpoints !== undefined &&
    outcome.cacheBreakpoints < expect.minCacheBreakpoints
  )
    failures.push(
      `cache breakpoints: expected every request to carry at least ${expect.minCacheBreakpoints}, and one carried ${outcome.cacheBreakpoints}`
    );
  if (expect.compactionTriggers && !same(expect.compactionTriggers, outcome.compactionTriggers))
    failures.push(
      `what set the compactions off: expected [${expect.compactionTriggers.join(', ')}], got [${outcome.compactionTriggers.join(', ')}]`
    );
  compare('requests carrying a soft-pass summary', expect.softPassWindows, outcome.softPassWindows);
  compare('the leading preamble stood still', expect.anchorHeld, outcome.anchorHeld);
  if (expect.tools && !same(expect.tools, outcome.tools))
    failures.push(
      `tools: expected [${expect.tools.join(', ')}], got [${outcome.tools.join(', ')}]`
    );
  if (expect.proposed && !same(expect.proposed, outcome.proposed))
    failures.push(
      `tools asked for: expected [${expect.proposed.join(', ')}], got [${outcome.proposed.join(', ')}]`
    );
  if (expect.finalCatalogue && !same(expect.finalCatalogue, outcome.finalCatalogue))
    failures.push(
      `catalogue on the last request: expected [${expect.finalCatalogue.join(', ')}], got [${outcome.finalCatalogue.join(', ')}]`
    );
  if (expect.holds && !same(expect.holds, outcome.holds))
    failures.push(
      `holds: expected [${expect.holds.join(', ')}], got [${outcome.holds.join(', ')}]`
    );
  /*
   * What the workspace holds when the turn is over, which is the only claim here a broken editor
   * cannot satisfy by accident.
   *
   * Quoted through `JSON.stringify` on purpose. The failures this exists to catch are an anchor off
   * by one, a trailing newline that went missing and a block pasted back with its indentation
   * changed, and every one of them is invisible in a message that prints the two texts raw.
   */
  for (const [file, wanted] of Object.entries(expect.filesAfter ?? {})) {
    const got = outcome.filesAfter[file];
    if (got === undefined)
      failures.push(
        `${file} is not in the workspace at the end of the turn; it holds [${Object.keys(outcome.filesAfter).join(', ')}]`
      );
    else if (got !== wanted)
      failures.push(
        `${file} after the turn:\n        expected ${JSON.stringify(wanted)}\n        got      ${JSON.stringify(got)}`
      );
  }
  compare('edits that reached disk', expect.landedEdits, outcome.readLedger.landedEdits);
  /*
   * And why each failure was a failure, which `noFailedTools: false` cannot say.
   *
   * `code:substring`, positionally. The code alone would be satisfied by the wrong refusal with the
   * right code, and the whole message would pin the live file text into a fixture; the pair is the
   * narrowest claim that still names the mechanism.
   */
  if (expect.toolFailures) {
    const got = outcome.toolFailures.map((failure) => `${failure.code}:${failure.message}`);
    if (
      got.length !== expect.toolFailures.length ||
      !expect.toolFailures.every((wanted, index) => {
        const at = wanted.indexOf(':');
        const [code, fragment] = [wanted.slice(0, at), wanted.slice(at + 1)];
        const failure = outcome.toolFailures[index];
        return failure !== undefined && failure.code === code && failure.message.includes(fragment);
      })
    )
      failures.push(
        `why the calls failed: expected [${expect.toolFailures.join(' | ')}], got [${got
          .map((line) => line.slice(0, 120))
          .join(' | ')}]`
      );
  }
  for (const tool of expect.toolsInclude ?? [])
    if (!outcome.tools.includes(tool))
      failures.push(`${tool} never ran; the run used [${outcome.tools.join(', ')}]`);
  for (const tool of expect.toolsExclude ?? [])
    if (outcome.tools.includes(tool)) failures.push(`${tool} ran, and nothing should have let it`);
  /*
   * And the committed row, which until now was a column in the report and nothing else.
   *
   * Everything above is a claim a fixture makes about itself. This is the claim the suite makes
   * about the product: that what it costs today is what it cost when somebody last looked at it and
   * said so. A drift nobody has to answer for is how forty-nine green rows come to be measuring a
   * loop that has quietly become dearer - the four cache regressions this rig was built after were
   * every one of them inside a run that reported 49/49 and a column of small positive numbers.
   *
   * Accepting a move is one command and it rewrites the file, which is the point: the movement
   * becomes a diff somebody reviewed rather than a number nobody read.
   */
  if (before) {
    if (outcome.modelCalls !== before.modelCalls)
      failures.push(
        `model calls against the committed baseline: was ${before.modelCalls}, now ${outcome.modelCalls} - accept it with \`pnpm eval --accept\` if it is meant`
      );
    const drift = Math.abs(outcome.promptTokens - before.promptTokens);
    if (before.promptTokens > 0 && drift > before.promptTokens * TOKEN_BAND)
      failures.push(
        `prompt tokens against the committed baseline: was ${before.promptTokens}, now ${outcome.promptTokens}, which is ${(
          (drift / before.promptTokens) *
          100
        ).toFixed(2)}% and the band is ${TOKEN_BAND * 100}%`
      );
    /*
     * And the catalogue on its own line.
     *
     * Banded exactly like the total and gated separately, which is the whole point of splitting it
     * out: the residency work is meant to move this number and nothing else, so a wave that lowers
     * it has to say so with `--accept` and a wave that raises it by adding a tool cannot hide
     * inside a total that a shorter turn happened to lower by the same amount.
     */
    const catalogueDrift = Math.abs(outcome.catalogueTokens - (before.catalogueTokens ?? 0));
    if (
      before.catalogueTokens !== undefined &&
      before.catalogueTokens > 0 &&
      catalogueDrift > before.catalogueTokens * TOKEN_BAND
    )
      failures.push(
        `tool-catalogue tokens against the committed baseline: was ${before.catalogueTokens}, now ${outcome.catalogueTokens}, which is ${(
          (catalogueDrift / before.catalogueTokens) *
          100
        ).toFixed(2)}% and the band is ${TOKEN_BAND * 100}%`
      );
    if (
      before.cachePrefix !== undefined &&
      outcome.modelCalls > 1 &&
      outcome.cachePrefix < before.cachePrefix - CACHE_PREFIX_BAND
    )
      failures.push(
        `cached prefix against the committed baseline: was ${before.cachePrefix}%, now ${outcome.cachePrefix}%, and this row may not lose more than ${CACHE_PREFIX_BAND} points`
      );
    // Exact and one-sided. A count of displayed lines drifts under nothing - not the clock, not the
    // catalogue - so a row that moved moved because something changed what a read shows.
    if (
      before.displayedLines !== undefined &&
      outcome.readLedger.displayedLines > before.displayedLines
    )
      failures.push(
        `lines displayed by this turn's reads: was ${before.displayedLines}, now ${outcome.readLedger.displayedLines}. Every one of them is charged on every later request of the turn.`
      );
  }
  return failures;
};

const pad = (value: string, width: number): string => value.padEnd(width, ' ');
const padStart = (value: string, width: number): string => value.padStart(width, ' ');

const drift = (now: number, before: number | undefined): string => {
  if (before === undefined) return 'new';
  const change = now - before;
  return change === 0 ? '' : `${change > 0 ? '+' : ''}${change}`;
};

/** The one line an owner reads per fixture. */
const row = (result: Result, baseline: Baseline, width: number): string => {
  const before = baseline[result.fixture.id];
  const state = brokenPromise(result)
    ? 'PASS'
    : pendingHeld(result)
      ? 'pend'
      : result.failures.length
        ? 'FAIL'
        : ' ok ';
  const steps = drift(result.outcome.modelCalls, before?.modelCalls);
  const tokens = drift(result.outcome.promptTokens, before?.promptTokens);
  const catalogue = drift(result.outcome.catalogueTokens, before?.catalogueTokens);
  const cached = drift(result.outcome.cachePrefix, before?.cachePrefix);
  return [
    state,
    pad(result.fixture.id, width),
    pad(result.fixture.shape, 10),
    padStart(String(result.outcome.modelCalls), 5),
    padStart(steps, 5),
    padStart(String(result.outcome.promptTokens), 8),
    padStart(tokens, 8),
    // What of that was tool schema, beside the total it is part of. Two columns rather than one
    // because the question every row of this table is now asked - did the work get cheaper, or did
    // the turn just get shorter - cannot be answered from a sum, and the term this programme is
    // trying to move is precisely the one the sum used to omit entirely.
    padStart(String(result.outcome.catalogueTokens), 8),
    padStart(catalogue, 7),
    // The largest single request, beside the sum of them. The sum says what a turn cost; this says
    // whether it fitted, and the two move independently - condensing a long turn raises the total
    // by a summarising call and lowers this by whatever it condensed. A row whose peak approaches
    // its window is a row about to start refusing requests, and nothing in this table could see it.
    padStart(String(result.outcome.peakPromptTokens), 8),
    // A single-call turn has no previous request, so there is nothing a cache could have read back
    // and no share to report - which is not the same statement as nought per cent.
    padStart(result.outcome.modelCalls > 1 ? `${result.outcome.cachePrefix}%` : '-', 6),
    padStart(result.outcome.modelCalls > 1 ? cached : '', 5),
    /*
     * What the turn's reads displayed, and what each landed edit cost in displayed lines.
     *
     * Two columns and not one, for the reason the catalogue gets two: the quotient alone cannot say
     * which half moved, and the halves move for completely different reasons - a display bound
     * moves the numerator, an editor that lands more of what it is asked to moves the denominator.
     *
     * `-` in the second column is a turn that landed no edit. It is not zero and it is not
     * infinity: the reads were not free and there is no edit to charge them to, and `evals/read`
     * counts those rows in a column of their own rather than averaging over them.
     */
    padStart(String(result.outcome.readLedger.displayedLines), 5),
    padStart(
      result.outcome.readLedger.landedEdits
        ? (
            result.outcome.readLedger.displayedLines / result.outcome.readLedger.landedEdits
          ).toFixed(1)
        : '-',
      7
    ),
    result.outcome.holds.join(' ')
  ].join(' ');
};

export const render = (results: readonly Result[], baseline: Baseline): string => {
  const lines: string[] = [];
  const pending = results.filter(pendingHeld);
  const failed = results.filter(
    (result) => (result.failures.length > 0 || brokenPromise(result)) && !pendingHeld(result)
  );
  const steps = results.reduce((total, result) => total + result.outcome.modelCalls, 0);
  const tokens = results.reduce((total, result) => total + result.outcome.promptTokens, 0);
  const catalogue = results.reduce((total, result) => total + result.outcome.catalogueTokens, 0);
  const windows = results.reduce((total, result) => total + result.outcome.windowTokens, 0);
  // The catalogue as ONE request carries it, which is the number a residency change moves and the
  // only one comparable with the catalogue's own byte ceiling. Read off the widest row that offered
  // a catalogue at all: a schema fixture runs no turn and a compaction-only row would report zero,
  // and a mean over those would say the floor is lower than any request ever saw.
  const resident = results.reduce(
    (most, result) => Math.max(most, result.outcome.residentCatalogueBytes),
    0
  );
  const beforeSteps = results.reduce(
    (total, result) => total + (baseline[result.fixture.id]?.modelCalls ?? 0),
    0
  );
  const peak = results.reduce((most, result) => Math.max(most, result.outcome.peakPromptTokens), 0);
  // Sized to the longest id rather than to a guess: a column that a fixture name overflows shifts
  // every number on that row and makes the table unreadable exactly when something has gone wrong.
  const width = results.reduce((widest, result) => Math.max(widest, result.fixture.id.length), 7);

  /*
   * Who is asking, and who the committed numbers belong to.
   *
   * Printed at the top of every run rather than only when they differ, because the value of a
   * provenance line is that it is in the scrollback of the run somebody later has questions about.
   * The mismatch note underneath is a note: a wave that adds a fixture moves the rig digest by
   * design, and the intended answer is `--accept` in the same commit, not a red run.
   */
  const identity = runIdentity();
  const stamp = stampOf(baseline);
  lines.push('');
  lines.push(`This run: ${identityLabel(identity)}.`);
  lines.push(
    stamp
      ? `Baseline: accepted ${stamp.acceptedAt.slice(0, 10)} by ${identityLabel(stamp)}.`
      : 'Baseline: unstamped - accept it once to record what measured it.'
  );
  if (stamp && (stamp.commit !== identity.commit || stamp.harness !== identity.harness))
    lines.push(
      'Note: the committed numbers were measured by a different revision of athanor or of this rig. A row that moved may have moved for that reason.'
    );

  lines.push('');
  lines.push(
    `     ${pad('fixture', width)} ${pad('shape', 10)} ${padStart('steps', 5)} ${padStart('Δ', 5)} ${padStart('tokens', 8)} ${padStart('Δ', 8)} ${padStart('cat', 8)} ${padStart('Δ', 7)} ${padStart('peak', 8)} ${padStart('cached', 6)} ${padStart('Δ', 5)} ${padStart('shown', 5)} ${padStart('l/edit', 7)} holds`
  );
  lines.push(
    `     ${'-'.repeat(width)} ${'-'.repeat(10)} ${'-'.repeat(5)} ${'-'.repeat(5)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(7)} ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(5)} ${'-'.repeat(5)} ${'-'.repeat(7)} -----`
  );
  for (const result of results) lines.push(row(result, baseline, width));

  if (failed.length) {
    lines.push('');
    lines.push('WHAT FAILED');
    for (const result of failed) {
      lines.push(`  ${result.fixture.id}`);
      lines.push(`    protects: ${result.fixture.why}`);
      if (brokenPromise(result))
        lines.push(
          `    - this fixture is marked pending and every expectation in it now holds. Delete the marker: ${result.fixture.pending}`
        );
      for (const failure of result.failures) lines.push(`    - ${failure}`);
    }
  }

  // Reported in full and separately, because a pending row is a measurement rather than a mishap
  // and burying it under the passes is how it stops being read.
  if (pending.length) {
    lines.push('');
    lines.push('WHAT IS PENDING - stated targets the loop does not meet yet, not regressions');
    for (const result of pending) {
      lines.push(`  ${result.fixture.id}`);
      lines.push(`    waiting on: ${result.fixture.pending}`);
      for (const failure of result.failures) lines.push(`    - ${failure}`);
    }
  }

  // What each hold actually costs, across the whole suite. A hold that fires on three fixtures and
  // adds three steps is a different proposition from one that fires once and adds five.
  const cost = new Map<HoldName, { fixtures: number; steps: number }>();
  for (const result of results)
    for (const hold of new Set(result.outcome.holds)) {
      const entry = cost.get(hold) ?? { fixtures: 0, steps: 0 };
      cost.set(hold, {
        fixtures: entry.fixtures + 1,
        steps: entry.steps + result.outcome.holds.filter((each) => each === hold).length
      });
    }
  lines.push('');
  lines.push('WHAT THE HOLDS COST');
  for (const hold of HOLD_ORDER) {
    const entry = cost.get(hold);
    lines.push(
      `  ${pad(hold, 24)} ${
        entry
          ? `fired on ${entry.fixtures} fixture${entry.fixtures === 1 ? '' : 's'}, ${entry.steps} extra model call${entry.steps === 1 ? '' : 's'}`
          : 'never fired - no fixture covers it, or nothing triggers it any more'
      }`
    );
  }

  lines.push('');
  lines.push(
    `${results.length - failed.length - pending.length}/${results.length - pending.length} fixtures pass${
      pending.length ? `, ${pending.length} pending` : ''
    }. ${steps} model calls in total${
      beforeSteps ? ` (baseline ${beforeSteps})` : ''
    }, ${tokens} estimated serialized prompt tokens (offline; no provider calls), the largest single prepared window ${peak}.`
  );
  /*
   * Where the money went, in the one line an owner reads.
   *
   * Printed on every run rather than behind a flag, because the fact this sentence states is the
   * reason the column above was rebuilt: on this athanor the tool catalogue is the largest term in
   * the bill, it is resident on every request whether or not the turn could use it, and until this
   * wave the number beside `tokens` could not see one byte of it. A share that falls is the whole
   * object of the residency work; a share that rises is a tool somebody added without saying so.
   */
  lines.push(
    `Of those, ${catalogue} tokens (${((catalogue / Math.max(1, tokens)) * 100).toFixed(1)}%) were the tool catalogue, with a largest resident catalogue of ${resident} bytes. athanor's own window estimate, which is what the compaction trigger is compared against and which counts none of the catalogue, saw ${windows}.`
  );
  // Averaged over the turns that had a previous request to repeat, because a one-call turn has no
  // opinion about caching and averaging its nought in would make the suite look worse the more
  // cheap fixtures it grew.
  const repeatable = results.filter((result) => result.outcome.modelCalls > 1);
  if (repeatable.length)
    lines.push(
      `Across the ${repeatable.length} turns of more than one call, a mean ${Math.round(
        repeatable.reduce((total, result) => total + result.outcome.cachePrefix, 0) /
          repeatable.length
      )}% of each request repeated the one before it byte for byte, which is the ceiling on what a prefix cache could read back.`
    );
  /*
   * The read side, in the same one line, and with its own n.
   *
   * Pooled over the turns that landed an edit and never over the whole suite: a turn that landed
   * nothing has a real read cost and no edit to charge it to, and folding it in either direction
   * would make the figure a function of how many conversational fixtures the suite happens to hold.
   * `evals/read` is where this number is measured properly, on files large enough for the answer to
   * differ; this line exists so that a change to the read side cannot land without moving something
   * in the report every wave already reads.
   */
  const landing = results.filter((result) => result.outcome.readLedger.landedEdits > 0);
  const displayed = landing.reduce(
    (total, result) => total + result.outcome.readLedger.displayedLines,
    0
  );
  const landed = landing.reduce(
    (total, result) => total + result.outcome.readLedger.landedEdits,
    0
  );
  if (landed)
    lines.push(
      `Reads displayed ${results.reduce((total, result) => total + result.outcome.readLedger.displayedLines, 0)} lines of file text across the suite, and ${(displayed / landed).toFixed(2)} of them per landed edit over the n=${landing.length} turns that landed one. Every displayed line is charged again on every later request of its turn.`
    );
  if (failed.length)
    lines.push(`${failed.length} fixture${failed.length === 1 ? '' : 's'} failed.`);
  lines.push('');
  return lines.join('\n');
};

export const baselineFrom = (results: readonly Result[]): Baseline => {
  const identity = runIdentity();
  const stamp: BaselineStamp = { acceptedAt: new Date().toISOString(), ...identity };
  return {
    // First, so a reader opening the file sees what produced it before the numbers. The cast is
    // the one place the stamp and the rows share a map: `Baseline`'s index signature describes a
    // row, and widening it to a union would push a narrow onto `evals/run.ts`, whose reader this
    // lane does not own. Nothing reads this key back except `stampOf`, which validates it.
    ...({ [BASELINE_STAMP_KEY]: stamp } as unknown as Baseline),
    ...Object.fromEntries(
      [...results]
        .sort((left, right) => left.fixture.id.localeCompare(right.fixture.id))
        .map((result) => [
          result.fixture.id,
          {
            modelCalls: result.outcome.modelCalls,
            promptTokens: result.outcome.promptTokens,
            catalogueTokens: result.outcome.catalogueTokens,
            cachePrefix: result.outcome.cachePrefix,
            displayedLines: result.outcome.readLedger.displayedLines
          }
        ])
    )
  };
};
