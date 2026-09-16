/**
 * The trajectories the instrument is read on, and the two that prove it can move.
 *
 * ── Why these are declared as steps rather than written as scripts ─────────────────────────────
 *
 * Every row here has to state, before it runs, the number it is designed to produce. A trajectory
 * written directly as a `ModelScript` can only be checked against a committed baseline, and a
 * baseline says "this is what it did last time" - which is exactly the check that cannot tell a
 * working instrument from one that has stopped reading its input. So a trajectory is a list of
 * declared reads and edits, the script is GENERATED from that list, and the number it must produce
 * is DERIVED from the same list by arithmetic that never touches the loop. If the loop displays a
 * line the trajectory did not ask for, or lands an edit it did not declare, the row fails with the
 * difference named - and it fails whether or not anybody has re-accepted a baseline.
 *
 * ── The two rows the brief is actually about ──────────────────────────────────────────────────
 *
 * `narrow-reads-and-an-edit-each-time` reads four ten-line windows and lands four edits: 10.0.
 * `a-whole-file-read-for-a-one-line-edit` reads four hundred lines and lands one: 400.0.
 *
 * Those are the same agent, the same loop, the same tools and the same file. Forty times apart.
 * `report.ts` asserts the ordering between them by name, so an instrument that has stopped reading
 * its input fails the run rather than printing a reassuring constant - the same defect
 * `evals/context-quality` calls a frozen column, and the reason its `starved` configuration exists.
 *
 * ── The files ─────────────────────────────────────────────────────────────────────────────────
 *
 * Real sizes, because this axis has none of its interesting behaviour at the sizes the general
 * fixture corpus uses. The largest workspace file any fixture in `evals/fixtures.ts` puts in front
 * of the model is measured rather than asserted - `measure.largestCorpusFileLines`, printed under
 * the corpus table on every run - and it is a handful of lines. Nothing in that corpus can reach
 * the display bound, distinguish a windowed read from a whole one, or make the difference between
 * reading narrowly and reading everything cost anything at all.
 *
 * That is not a decoration. Until this directory ran, the eval harness's own runner stub answered
 * the display read by handing back the whole file and no display headers - the shape a runner one
 * release behind the worker produces, and one the shipped runner cannot - and all 72 fixtures
 * stayed green over it because not one of them owns a file big enough for the difference to show.
 * `a-file-past-the-display-bound-shows-only-what-the-bound-allows` is the row that found it.
 */
import { evidence, type Fixture, type ModelTurn, type ScriptedCall } from '../harness.js';

/* ------------------------------------------------------------------------------- the workspace */

/**
 * A four-hundred-line source file, the size this repository's own median is not far from.
 *
 * 400 lines at 28 bytes is 11,200 - inside the 18,000-byte display budget and inside the 800-line
 * cap, so a whole-file read of it displays all four hundred lines. That is deliberate: this row is
 * about a model reading everything it was allowed to, not about a bound cutting it off. The bound
 * gets its own row below.
 */
export const LEDGER_LINES = 400;

const ledgerSource = (): string =>
  Array.from(
    { length: LEDGER_LINES },
    (_, index) => `const row${index + 1} = ${index + 1} * 7;`
  ).join('\n');

/**
 * Nine thousand lines of two characters, which is the file the byte budget cannot bound.
 *
 * 27 kB, so the 18,000-byte budget would allow about 6,000 of these rows; the line cap is what
 * stops it, and that is the point of the row. `apps/worker/src/tools/workspace.ts:63-84` calls that
 * cap a catastrophe floor and says it is never reached on real source - this is the shape it exists
 * for, and until this trajectory nothing in any rig had ever reached it.
 *
 * The row declares that the bound FIRES, not what the bound is. Writing 800 here would pin a
 * constant that lives in `workspace.ts`, and pin it two-sidedly: lowering the cap - which displays
 * fewer lines per edit, the improvement this whole lane is for - would fail a rig whose own
 * baseline gate is one-sided precisely so it never does that. See `Step`'s `shows`.
 */
export const COUNTER_LINES = 9_000;

const counterFile = (): string =>
  Array.from({ length: COUNTER_LINES }, (_, index) => String(index % 90).padStart(2, '0')).join(
    '\n'
  );

export const FILES: Readonly<Record<string, string>> = {
  'workspace/ledger.ts': ledgerSource(),
  'workspace/counters.txt': counterFile()
};

/** Lines in a workspace file, by the one rule the whole vertical splits on: separated, not ended. */
export const lineCount = (path: string): number => (FILES[path] ?? '').split('\n').length;

/* ------------------------------------------------------------------------------- the steps */

/**
 * One declared step of a trajectory.
 *
 * `read` with no window is the unwindowed arm of `workspace.ts:287`; with one it is the windowed
 * arm at `:257`. `shows` is what that step is expected to DISPLAY, and it is stated per step rather
 * than summed at the end so a row that moves says which step moved.
 */
export type Step =
  | {
      readonly kind: 'read';
      readonly path: string;
      readonly from?: number;
      readonly to?: number;
      /**
       * Lines this read is designed to display, with the derivation in the trajectory's prose - or
       * `'bounded'`, meaning the display bound cuts this read short and what it shows is whatever
       * the bound allows.
       *
       * The second is not vagueness, it is the only honest declaration available. The bound is a
       * constant in `apps/worker/src/tools/workspace.ts` that this directory cannot import, and a
       * number copied here would be a second copy of it - failing exactly when somebody LOWERS the
       * cap, which is the direction this rig exists to encourage. So a bounded read declares the
       * property instead: the read was cut short, and it showed fewer lines than the file has and
       * more than none. `report.check` holds it to that, and the committed baseline holds the
       * number it produced one-sidedly, so a cap that RISES still fails.
       */
      readonly shows: number | 'bounded';
    }
  | {
      readonly kind: 'patch';
      readonly path: string;
      /** The line this patch replaces. One line in, one line out, so later numbers do not move. */
      readonly at: number;
      readonly text: string;
    }
  | { readonly kind: 'write'; readonly path: string; readonly content: string };

export interface Trajectory {
  readonly id: string;
  /** What this row is for, and why its declared numbers are the numbers they are. */
  readonly why: string;
  readonly request: string;
  readonly steps: readonly Step[];
  /**
   * A command check declared before the work, so a turn that edits code is not held at the finish.
   *
   * The acceptance hold is real and correct and has nothing to do with this measurement; a row that
   * paid for it would be reporting the hold's extra model call in a table about reads.
   */
  readonly acceptance?: boolean;
}

/**
 * Displayed lines this trajectory declares, before anything runs - or null where it cannot.
 *
 * Null exactly when a step is `'bounded'`: the row has no exact declaration to be held to, and
 * `boundedReadCeiling` below is what stands in its place. Summing a bounded step as zero would be
 * worse than declaring nothing, because it would be a declaration that is wrong on purpose.
 */
export const declaredDisplayedLines = (trajectory: Trajectory): number | null =>
  trajectory.steps.some((step) => step.kind === 'read' && step.shows === 'bounded')
    ? null
    : trajectory.steps.reduce(
        (total, step) =>
          total + (step.kind === 'read' && step.shows !== 'bounded' ? step.shows : 0),
        0
      );

/**
 * For a trajectory with a bounded read: the lines the file HAS, which the bound must cut into.
 *
 * The declaration a bounded row is held to, in place of an exact count. A read that displayed this
 * many lines displayed the whole file and no bound fired; a read that displayed none displayed
 * nothing at all. Anything strictly between the two is the bound doing its job, at whatever number
 * the constant currently sits at.
 */
export const boundedReadCeiling = (trajectory: Trajectory): number | null => {
  const bounded = trajectory.steps.find(
    (step) => step.kind === 'read' && step.shows === 'bounded'
  ) as Extract<Step, { kind: 'read' }> | undefined;
  return bounded === undefined ? null : lineCount(bounded.path);
};

/** Landed edits this trajectory declares. Every declared edit is one this world can land. */
export const declaredLandedEdits = (trajectory: Trajectory): number =>
  trajectory.steps.filter((step) => step.kind !== 'read').length;

/** The declared quotient, or null where there is no edit or no exact declaration to divide. */
export const declaredLinesPerEdit = (trajectory: Trajectory): number | null => {
  const displayed = declaredDisplayedLines(trajectory);
  const edits = declaredLandedEdits(trajectory);
  return displayed === null || edits === 0 ? null : displayed / edits;
};

/* ------------------------------------------------------------------------------- the rows */

const patchText = (at: number): string => `const row${at} = ${at} * 7; // audited`;

export const TRAJECTORIES: readonly Trajectory[] = [
  {
    id: 'a-whole-file-read-for-a-one-line-edit',
    why: 'The expensive shape, and the one an unwindowed read makes free to choose. Four hundred lines cross into the window to change one of them, and they stay there: the file is re-sent on every later request of the turn, so this is not four hundred lines once, it is four hundred lines times however many steps follow. 400.0.',
    request: 'Line 200 of workspace/ledger.ts needs a note on it. Read the file and add one.',
    acceptance: true,
    steps: [
      // 400 lines, all displayed: inside both bounds, so `displayableLines` returns the file.
      { kind: 'read', path: 'workspace/ledger.ts', shows: LEDGER_LINES },
      { kind: 'patch', path: 'workspace/ledger.ts', at: 200, text: patchText(200) }
    ]
  },
  {
    id: 'narrow-reads-and-an-edit-each-time',
    why: 'The cheap shape, and the one the windowed arm of file_read exists to make available. The same file, the same tools, the same loop, four edits - and a fortieth of the display. If the instrument cannot separate this from the row above it is not measuring anything.',
    request:
      'Add an audit note to lines 10, 110, 210 and 310 of workspace/ledger.ts. Read each one before you change it.',
    acceptance: true,
    steps: [
      // Ten lines each, wholly inside the file, so the window is what is displayed.
      { kind: 'read', path: 'workspace/ledger.ts', from: 6, to: 15, shows: 10 },
      { kind: 'patch', path: 'workspace/ledger.ts', at: 10, text: patchText(10) },
      { kind: 'read', path: 'workspace/ledger.ts', from: 106, to: 115, shows: 10 },
      { kind: 'patch', path: 'workspace/ledger.ts', at: 110, text: patchText(110) },
      { kind: 'read', path: 'workspace/ledger.ts', from: 206, to: 215, shows: 10 },
      { kind: 'patch', path: 'workspace/ledger.ts', at: 210, text: patchText(210) },
      { kind: 'read', path: 'workspace/ledger.ts', from: 306, to: 315, shows: 10 },
      { kind: 'patch', path: 'workspace/ledger.ts', at: 310, text: patchText(310) }
    ]
  },
  {
    id: 'a-second-edit-after-one-read-needs-no-second-read',
    why: 'The denominator moving on its own, with the numerator held still. One read covered both lines, so the second edit needs no second read and the display is charged once for two edits - which halves this number without a single line of display being saved. 200.0. Its two edits rest on the READ, not on each other: `recordWrite` records only the span a patch authored (`edit/snapshots.ts:265`), so the second patch lands because line 300 was displayed, and this row would still be honest if a patch recorded nothing at all.',
    request: 'Read workspace/ledger.ts and put an audit note on lines 200 and 300, one call each.',
    acceptance: true,
    steps: [
      { kind: 'read', path: 'workspace/ledger.ts', shows: LEDGER_LINES },
      { kind: 'patch', path: 'workspace/ledger.ts', at: 200, text: patchText(200) },
      { kind: 'patch', path: 'workspace/ledger.ts', at: 300, text: patchText(300) }
    ]
  },
  {
    id: 'a-file-written-from-nothing-displays-no-lines',
    why: 'The floor, and a real one rather than a degenerate one: a turn that creates a file reads nothing and lands an edit, so it scores 0.0. It is here because a quotient with a zero numerator and a zero denominator are two different things and a rig that printed them the same way could not be trusted with either.',
    request: 'Write workspace/notes.md with a one-line summary of what the ledger does.',
    steps: [
      {
        kind: 'write',
        path: 'workspace/notes.md',
        content: '# Ledger\n\nFour hundred rows, each seven times its index.\n'
      }
    ]
  },
  {
    id: 'a-file-past-the-display-bound-shows-only-what-the-bound-allows',
    why: 'The display bound, reached - the only row in any rig that reaches it. 9,000 lines of two characters is 27 kB, so the 18,000-byte budget would still allow about six thousand rows and the line cap is what binds. The read comes back truncated, only the displayed prefix is recorded as seen, and the edit that follows is inside it. What that costs is the number in the table; that it is far short of 9,000 is the declaration. This row is why the harness stub answering an unwindowed read with the WHOLE file, and no display headers, was found at all: at the sizes the general corpus uses, a stub that ignores the bound and a runner that honours it return the same bytes.',
    request: 'Line 400 of workspace/counters.txt is wrong. Read the file and fix it.',
    steps: [
      // Whatever the bound allows. Not a number: see `Step.shows`.
      { kind: 'read', path: 'workspace/counters.txt', shows: 'bounded' },
      { kind: 'patch', path: 'workspace/counters.txt', at: 400, text: '99' }
    ]
  },
  {
    id: 'a-read-that-lands-no-edit-is-not-averaged-in',
    why: 'The row that has no quotient. Four hundred lines displayed and nothing landed: the reads were not free and there is no edit to charge them to. Printed in its own column and never as `Infinity`, because a mean over `Infinity` is `Infinity` and a mean over a silently-dropped row is a lie about the sample.',
    request: 'What does line 200 of workspace/ledger.ts do? Read the file and tell me.',
    steps: [{ kind: 'read', path: 'workspace/ledger.ts', shows: LEDGER_LINES }]
  }
];

/* ------------------------------------------------------------------------------- the script */

const callFor = (step: Step, id: string): ScriptedCall => {
  if (step.kind === 'read')
    return {
      id,
      name: 'file_read',
      args: {
        path: step.path,
        // Spread, so an unwindowed read sends neither field - which is the whole of what decides
        // which arm of `workspace.ts:256` runs.
        ...(step.from === undefined ? {} : { startLine: step.from }),
        ...(step.to === undefined ? {} : { endLine: step.to })
      }
    };
  if (step.kind === 'write')
    return { id, name: 'file_write', args: { path: step.path, content: step.content } };
  return {
    id,
    name: 'file_patch',
    args: {
      // `PUT n.=n:` with a single `+` body row: the canonical spelling of a one-line replacement in
      // `apps/worker/src/edit/parse.ts`. One line out, one line in, so no later number moves.
      patches: [
        {
          path: step.path,
          edit: `PUT ${step.at}.=${step.at}:\n-${FILES[step.path]!.split('\n')[step.at - 1]}\n+${step.text}`
        }
      ]
    }
  };
};

const ACCEPTANCE: ScriptedCall = {
  id: 'call-acceptance',
  name: 'set_acceptance',
  args: {
    checks: [
      { kind: 'command', label: 'the ledger still parses', executable: 'pytest', args: ['-q'] }
    ]
  }
};

const CHECK: ScriptedCall = {
  id: 'call-check',
  name: 'shell',
  args: { executable: 'pytest', args: ['-q'] }
};

/**
 * The fixture a trajectory becomes: the declared checks, the declared steps in order, the run that
 * shows them passing, and a finish that cites it.
 *
 * Every step is its own model call, deliberately. Batching the reads would measure the loop's
 * parallel-call path rather than the read cost, and the two trajectories this rig turns on differ
 * in how many calls they make - so a script that quietly batched one of them would be comparing two
 * different things and printing one number.
 *
 * The frame around the steps is `files-code-declares-acceptance-first`'s, copied because it is the
 * shape that finishes with no hold: the checks are declared before the work, the exec stub fails
 * the first run and passes afterwards, and the finish cites the run rather than claiming the turn
 * was conversation. None of it touches the ledger - a hold costs model calls and displays no lines -
 * but a row carrying four holds is a row a reader has to discount before they can read the number,
 * and this table is meant to be read.
 */
export const fixtureFor = (trajectory: Trajectory): Fixture => {
  const steps = trajectory.steps;
  const changes = steps.some((step) => step.kind !== 'read');
  const turns: ModelTurn[] = [
    ...(trajectory.acceptance ? [{ calls: [ACCEPTANCE] }] : []),
    ...steps.map((step, index) => ({ calls: [callFor(step, `call-${index + 1}`)] })),
    ...(trajectory.acceptance ? [{ calls: [CHECK] }] : []),
    {
      text: 'Done.',
      calls: [
        {
          id: 'call-finish',
          name: 'finish',
          args: {
            summary: 'Read what was needed and changed what was asked for.',
            verification: evidence(
              trajectory.acceptance ? CHECK.id : `call-${steps.length}`,
              changes ? 'The change is on disk' : 'The file says so at that line'
            )
          }
        }
      ]
    }
  ];
  return {
    id: trajectory.id,
    shape: 'files',
    request: trajectory.request,
    why: trajectory.why,
    // The first run fails, before the work; every run after it passes. A check that already passes
    // when it is declared is refused by name, which is a hold about acceptance and not about reads.
    runner: { files: FILES, exec: [1, 0, 0, 0] },
    // Thirty rather than the rig's default twelve. The narrow row makes eleven calls by design -
    // that is what reading narrowly costs - and a ceiling it can brush against would make this
    // table a measurement of the ceiling. Production's own default is 120.
    maxSteps: 30,
    model: ({ index }) => turns[Math.min(index, turns.length - 1)] ?? {},
    expect: {}
  };
};
