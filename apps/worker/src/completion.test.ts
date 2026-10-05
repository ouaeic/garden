import { describe, expect, it } from 'vitest';
import type { AcceptanceCheck } from './acceptance.js';
import { acceptanceAlreadyObserved } from './acceptance.js';
import type { AgentState } from './agent-state.js';
import {
  MAX_EVIDENCE_SOURCE_CHARS,
  askOutcome,
  normalisedSpan,
  observedCommands,
  parseDelegateReport,
  quotedSpanMatchesSource,
  shellObservation,
  startTurnState,
  validateDelegateReport
} from './completion.js';
import type { ModelToolCall } from '@garden/model-gateway';
import { MAX_QUESTIONS_PER_TURN } from './turn-bounds.js';

describe('what a new turn keeps and what it drops', () => {
  /**
   * There are two doors into a new turn and they had drifted apart. The worker's door - a message
   * that arrived while the agent was still running - cleared eleven fields and deleted three. The
   * API's door, which is the one an ordinary reply comes through, cleared four. So the common case
   * was the broken one, and it broke in ways that look like the model behaving strangely.
   */
  const previous = {
    messages: [{ role: 'user', content: 'first' }],
    step: 17,
    turn: 3,
    reservationKey: 'old',
    // Per-turn state, all of which the API path was carrying forward.
    turnToolResults: { 'call-a': { name: 'shell', success: true, mutating: true } },
    truncatedReplies: 4,
    notices: 3,
    turnNoveltyBytes: 900,
    mutatedBeyondProse: true,
    answered: true,
    acceptanceFailures: 1,
    reasoningFloor: 'high',
    compactedAtStep: 12,
    pending: { approvalId: 'a1' },
    questionsAsked: 2,
    question: { question: 'Which mailbox?', askedAtStep: 9 },
    // Conversation state, none of which may be dropped.
    taint: { sources: ['web pages'] },
    webToolMode: 'in_house',
    toolOutputFloor: 400,
    acceptance: { checks: [{ command: 'pnpm test' }] },
    checkpoint: { turn: 3, id: 'c1' }
  };

  const next = startTurnState(previous, { prompt: 'second', turn: 4, reservationKey: 'new' });

  it('drops everything that was about the turn that ended', () => {
    expect(next.step).toBe(0);
    expect(next.turn).toBe(4);
    expect(next.reservationKey).toBe('new');
    expect(next.turnToolResults).toEqual({});
    expect(next.truncatedReplies).toBe(0);
    // A monitor that spoke three times last turn was told it had used its whole allowance.
    expect(next.notices).toBe(0);
    // Carried forward, this is the one that would hold a pure-answer turn to an acceptance record
    // on the strength of code the turn before it touched.
    expect(next.mutatedBeyondProse).toBe(false);
    expect(next.answered).toBe(false);
    expect(next.acceptanceFailures).toBe(0);
    expect(next).not.toHaveProperty('reasoningFloor');
    expect(next).not.toHaveProperty('compactedAtStep');
    expect(next).not.toHaveProperty('pending');
    /*
     * The question park goes the same way as the approval park, and for a sharper reason.
     *
     * An answer to a parked question is taken back into the turn that asked it, by `run`, before
     * any of this. Anything that reaches this door with a question still outstanding has had that
     * turn ended out from under it - the owner cancelled, or a sweep moved it - so the park is
     * stale, and left behind it would make the next turn wait for an answer to a question nobody is
     * still looking at. The count resets with it because the tool tells the model "twice in a turn".
     */
    expect(next).not.toHaveProperty('question');
    expect(next.questionsAsked).toBe(0);
    /*
     * The egress budget goes with them, and it is the one where keeping it would have been the
     * quieter mistake: the taint it is charged under is never cleared, so a budget that carried
     * would have been per conversation despite being named, bounded and explained to the owner as
     * per turn - and once spent, every web read for the rest of the thread raises a card.
     */
    expect(next.turnNoveltyBytes).toBe(0);
  });

  it('keeps everything that was about the conversation', () => {
    // The taint above all: a follow-up message is not a laundering step. The owner saying "carry
    // on" does not turn a hostile page they never saw into their own instruction.
    expect(next.taint).toEqual({ sources: ['web pages'] });
    expect(next.webToolMode).toBe('in_house');
    // The window is the same window; raising the floor back would rewrite cached bytes.
    expect(next.toolOutputFloor).toBe(400);
    // A follow-up must not quietly drop the checks the last turn was held to.
    expect(next.acceptance).toEqual({ checks: [{ command: 'pnpm test' }] });
    expect(next.checkpoint).toEqual({ turn: 3, id: 'c1' });
    expect(next.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' }
    ]);
  });
});

describe('when the agent is allowed to stop and ask', () => {
  /**
   * The tool exists because the operating contract told the model to ask when a missing choice
   * materially changes the result and gave it nowhere to ask - a blocker came back as a finish with
   * a not_applicable verification and read to the owner exactly like finished work. The failure it
   * creates is the opposite one, an agent that asks instead of working, and these are the four
   * places that failure is caught before the conversation is parked and a device is rung.
   */
  const looked = { turnToolResults: { 'call-1': { name: 'file_read', success: true } } };

  it('takes a real question with a reason and trims it to one line', () => {
    const outcome = askOutcome(looked, {
      question: '  Which  mailbox\n  should the invoice go from? ',
      why: 'Two are connected and the reply address changes what the client sees.',
      options: ['work@', 'billing@', '', 'work@ but bcc billing@']
    });
    expect(outcome).toMatchObject({
      ok: true,
      question: 'Which mailbox should the invoice go from?',
      options: ['work@', 'billing@', 'work@ but bcc billing@']
    });
  });

  it('keeps a default only with the time it will wait, so the user knows how long they have', () => {
    expect(
      askOutcome(looked, { question: 'Apply anyway?', default: 'Skip it', waitHours: 36 })
    ).toMatchObject({ ok: true, fallback: { choice: 'Skip it', waitHours: 36 } });
    const unbounded = askOutcome(looked, { question: 'Apply anyway?', default: 'Skip it' });
    expect(unbounded.ok ? '' : unbounded.refusal).toContain('waitHours');
  });

  it('refuses a single option, because one option is not a choice', () => {
    const outcome = askOutcome(looked, { question: 'A4?', why: 'Page size', options: ['A4'] });
    expect(outcome.ok ? '' : outcome.refusal).toContain('at least two');
  });

  it('stops a dialogue at the bound, and tells the model to assume and carry on', () => {
    const outcome = askOutcome(
      { ...looked, questionsAsked: MAX_QUESTIONS_PER_TURN },
      { question: 'And the margins?', why: 'Layout' }
    );
    expect(outcome.ok ? '' : outcome.refusal).toContain('what you assumed');
  });

  it('bounds a turn well inside a conversation the owner is not watching', () => {
    // The answer rejoins the same turn, so this one number covers the whole exchange rather than
    // one question - which is why it is small.
    expect(MAX_QUESTIONS_PER_TURN).toBeLessThanOrEqual(2);
  });
});

describe('what a long task remembers of its early work', () => {
  it('keeps a path touched before a compaction, and does not carry it into the next turn', () => {
    // The episode's `Touched:` list is read out of state.messages when the turn ends, and a
    // compaction genuinely deletes the messages it condensed - so everything before the last
    // compaction was missing from the record of a long unattended run, which is exactly the kind
    // worth recalling later. These are the only mechanical identifiers an episode carries; the rest
    // of the body is the model's own prose about itself.
    const carried = ['files_list workspace/early-notes', 'shell rg TODO'];
    const state = { messages: [], carriedArtifacts: carried } as Record<string, unknown>;

    // What #completeTurn does: union the carried paths with the ones still in the window.
    const stillInWindow = ['file_write workspace/report.md'];
    const touched = [...new Set([...(state.carriedArtifacts as string[]), ...stillInWindow])];
    expect(touched).toEqual([
      'files_list workspace/early-notes',
      'shell rg TODO',
      'file_write workspace/report.md'
    ]);

    // And the next turn starts empty: carrying these forward would put work in the Touched list of
    // a turn that predates it, which is worse than the absence this exists to fix.
    const next = startTurnState(state, {
      prompt: 'now do the other thing',
      turn: 2,
      reservationKey: 'r'
    });
    expect(next.carriedArtifacts).toEqual([]);
  });
});

/**
 * §4.5 #78: the declared output schema the specialist is told up front, read back by the parent.
 *
 * The errors are the load-bearing half - they are interpolated into the one correction message the
 * mission loop may send, so a wrong or vague one costs a model call and buys nothing.
 */
describe('reading a specialist report against its contract', () => {
  it('reads a well-formed report and finds nothing to say about it', () => {
    const checked = validateDelegateReport(
      JSON.stringify({
        answer: 'Three tiers.',
        evidence: [{ claim: 'tiers', source: 'notes.md', quotedSpan: 'three tiers' }],
        couldNotEstablish: ['when they take effect']
      })
    );

    expect(checked.errors).toEqual([]);
    expect(checked.report?.answer).toBe('Three tiers.');
    expect(checked.report?.evidence).toHaveLength(1);
  });

  it('names prose as prose rather than as a parse failure', () => {
    const checked = validateDelegateReport('The notes say three tiers, I am fairly sure.');

    expect(checked.report).toBeNull();
    expect(checked.errors).toEqual(['the report is prose: there is no JSON object in it at all']);
  });

  it('says which field is missing when the object is there and the answer is not', () => {
    const checked = validateDelegateReport(JSON.stringify({ evidence: [] }));

    expect(checked.report).toBeNull();
    expect(checked.errors[0]).toContain('"answer" is missing');
  });

  it('quotes the parser when the object is nearly JSON', () => {
    const checked = validateDelegateReport('{"answer": "Three tiers.",}');

    expect(checked.report).toBeNull();
    expect(checked.errors[0]).toContain('does not parse');
  });

  it('keeps a readable report that dropped an item, and counts what it dropped', () => {
    const checked = validateDelegateReport(
      JSON.stringify({
        answer: 'Three tiers.',
        evidence: [
          { claim: 'tiers', source: 'notes.md', quotedSpan: 'three tiers' },
          { claim: 'tiers', source: 'notes.md' }
        ]
      })
    );

    expect(checked.report?.evidence).toHaveLength(1);
    expect(checked.errors).toEqual([
      '1 of 2 evidence items were dropped: each needs "claim", "source" and "quotedSpan" as non-empty strings, with a "source" of at most 2048 characters and a quote that remains non-empty after text normalization'
    ]);
  });

  it.each(['\u00ad', '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', ' \u00ad\u200b\u00a0\n'])(
    'rejects a quote with no text after normalization: %j',
    (quotedSpan) => {
      const valid = { claim: 'tiers', source: 'notes.md', quotedSpan: 'the ﬁrst tier' };
      const checked = validateDelegateReport(
        JSON.stringify({
          answer: 'The first tier exists.',
          evidence: [{ ...valid, quotedSpan }, valid]
        })
      );

      expect(checked.report?.evidence).toEqual([valid]);
      expect(checked.errors).toHaveLength(1);
      expect(checked.errors[0]).toContain('1 of 2 evidence items were dropped');
      expect(checked.errors[0]).toContain('quote that remains non-empty after text normalization');
    }
  );

  it('says so when evidence arrived as something the harness cannot re-read', () => {
    const checked = validateDelegateReport(
      JSON.stringify({ answer: 'Three tiers.', evidence: 'notes.md' })
    );

    expect(checked.report?.evidence).toEqual([]);
    expect(checked.errors[0]).toContain('is not an array');
  });

  /**
   * The forgiving half of the contract, which is the shipped guidance the whole corpus agrees on:
   * require only the fields you will actually read. Nothing in the harness reads
   * `couldNotEstablish`, so a report without it is not a report that missed anything.
   */
  it('asks for nothing the harness does not read', () => {
    const checked = validateDelegateReport(JSON.stringify({ answer: 'Three tiers.' }));

    expect(checked.errors).toEqual([]);
    expect(checked.report).toEqual({ answer: 'Three tiers.', evidence: [] });
  });

  it('keeps the yes-or-no spelling agreeing with the reasons', () => {
    expect(parseDelegateReport('not json')).toBeNull();
    expect(parseDelegateReport(JSON.stringify({ answer: 'a' }))).toEqual({
      answer: 'a',
      evidence: []
    });
  });
});

/**
 * A check the harness reports as already passed, for a command that never ran.
 *
 * `acceptanceAlreadyObserved` answers a finish-time check from a run garden already made, which is
 * the one path where a check can be reported as passed without anything executing at that moment. So
 * the question worth pinning is whether a `shell` the harness ANSWERED rather than ran can put a
 * fingerprint into `observedCommands` - a duplicate call inside one turn, a payload that would not
 * parse, a plan that changed underneath it. Every one of those is recorded as
 * `{skipped: true, reason}` with no exit code (apps/worker/src/turn/dispatch.ts:221, 266, 291), and
 * `tool-recording.ts:542` spreads `shellObservation(call, result) ?? {}` into the stored result, so
 * the whole of the defence is that `shellObservation` declines a result with no integer exit.
 *
 * Written at the acceptance seam and not at the helper, deliberately. A helper-level row goes red
 * for mutants that change nothing an acceptance check can see - `Number(undefined)` is `NaN`, and a
 * `NaN` exit still fails the `!==` in `acceptanceAlreadyObserved`. The mutant that matters is the
 * plausible one, treating a missing exit code as a zero, and only the pair of functions catches it.
 */
describe('a command the harness answered instead of running', () => {
  const shellCall = (id: string): ModelToolCall =>
    ({
      id,
      name: 'shell',
      arguments: { executable: 'pytest', args: ['-q'], cwd: 'workspace' }
    }) as unknown as ModelToolCall;

  /** One entry recorded exactly the way `recordToolResult` records it, harness answer or not. */
  const recorded = (call: ModelToolCall, result: unknown, skipped: boolean) => ({
    name: call.name,
    success: !skipped,
    ...(skipped ? { skipped: true } : {}),
    mutating: false,
    ...(shellObservation(call, result) ?? {})
  });

  const check: AcceptanceCheck = {
    id: 'check-1',
    kind: 'command',
    label: 'the tests pass',
    executable: 'pytest',
    args: ['-q'],
    cwd: 'workspace',
    expectExit: 0,
    timeoutSeconds: 900
  };

  const answered = (result: unknown, skipped: boolean) =>
    acceptanceAlreadyObserved(
      check,
      observedCommands({
        turnToolResults: { 'call-1': recorded(shellCall('call-1'), result, skipped) }
      } as unknown as AgentState)
    );

  it('is never reported as a check that already passed', () => {
    for (const reason of [
      'This is the same shell call as call-0, which already ran this turn.',
      'The arguments for shell were not valid JSON, so it was not run and nothing changed.',
      'The user changed the active plan after this tool call was proposed. Replan before acting.'
    ])
      expect(answered({ skipped: true, reason }, true), reason).toBeNull();
    // The other two shapes `shellObservation` declines, held here for the same reason: a command the
    // runner stopped and a command that reported a session rather than an exit answered nothing
    // either, and an acceptance check must not be able to cite them.
    expect(answered({ exitCode: 0, stdout: '', stderr: '', timedOut: true }, false)).toBeNull();
  });

  it('is reported as passed when it really ran, so the row above is about the answer and not the wiring', () => {
    expect(answered({ exitCode: 0, stdout: '', stderr: '', timedOut: false }, false)).toEqual({
      id: 'check-1',
      label: 'the tests pass',
      passed: true,
      detail: 'exit 0, from garden running this same command after the last change',
      // The command travels with the answer, so the record the owner reads says what was run and
      // not only what the model called it.
      command: 'pytest -q'
    });
  });
});

/**
 * The matcher behind the one sentence this harness says about a specialist's honesty.
 *
 * `normalisedSpan` decides whether a quoted span is really in the page, and a false negative on the
 * only two citations checked fires "Nothing in this report stood up" - the strongest thing garden
 * says about a report. Collapse-and-lowercase failed five of six realistic variants of a span that
 * was genuinely copied, because a page is typeset and a model retyping a span from it is not: the
 * publisher's apostrophe is curly, the ligature is one character, the hyphen is soft, the dash is
 * an en dash. Every one of those was garden calling honest work fabricated.
 *
 * The production matcher receives a complete page and the quoted span, so these cases exercise
 * that boundary rather than reimplementing the comparison in the test.
 */
describe('a quoted span and the page it was copied from', () => {
  const found = quotedSpanMatchesSource;

  it.each(['', ' \n\t', '\u00ad', '\u200b\u200c\u200d\u2060\ufeff', '\u00a0\u3000'])(
    'never finds an empty normalized quote: %j',
    (span) => {
      expect(found('', span)).toBe(false);
      expect(found('A source about a different subject.', span)).toBe(false);
    }
  );

  const PAGE =
    'Statement of accounts\n\nThe team’s ﬁrst quarter — the 2024–2025 review — closed\n' +
    'with the “three tiers” of cover intact, and the quar­terly résumé was filed.';

  /*
   * The six the audit measured, as they were measured: the page as a publisher typeset it, and the
   * span as a model hands it back. Five of these were reported as fabrications.
   */
  it.each([
    ['a curly apostrophe straightened', 'The team’s first quarter', "the team's first quarter"],
    [
      'a curly double quote straightened',
      'the “three tiers” of cover',
      'the "three tiers" of cover'
    ],
    ['an fi ligature typed as two letters', 'the ﬁrst quarter', 'the first quarter'],
    ['a soft hyphen dropped', 'the quar­terly return', 'the quarterly return'],
    ['an en dash typed as a hyphen', 'the 2024–2025 review', 'the 2024-2025 review'],
    ['a line break closed up', 'closed\nwith the three tiers', 'closed with the three tiers']
  ])('finds a span the specialist really copied when %s', (_case, page, span) => {
    expect(found(page, span)).toBe(true);
  });

  /** All six against the one page, which is the shape the production caller actually reads. */
  it('finds every one of them in a whole page rather than in its own fragment', () => {
    expect(found(PAGE, "the team's first quarter")).toBe(true);
    expect(found(PAGE, 'the "three tiers" of cover')).toBe(true);
    expect(found(PAGE, 'the 2024-2025 review')).toBe(true);
    expect(found(PAGE, 'the quarterly resume')).toBe(false);
  });

  /*
   * The other direction, which is the whole reason the fold is a list of families rather than a
   * strip of everything that is not a letter. A matcher lenient enough to pass these is a matcher
   * that cannot report a fabrication at all, and the mechanism would be worth nothing.
   */
  it('still refuses a span that is simply not in the source', () => {
    expect(found(PAGE, 'the four tiers of cover')).toBe(false);
    expect(found(PAGE, 'the board approved the merger')).toBe(false);
  });

  it('refuses a span whose digits differ, however it is punctuated', () => {
    expect(found(PAGE, 'the 2024–2026 review')).toBe(false);
    expect(found(PAGE, 'the 2024-2026 review')).toBe(false);
  });

  it('keeps diacritics, so a different word in another language is a different word', () => {
    expect(found('the résumé was filed', 'the resume was filed')).toBe(false);
    expect(found('Müller GmbH', 'Muller GmbH')).toBe(false);
  });

  it('folds punctuation rather than dropping it, so a spliced span does not match', () => {
    expect(found('three tiers, and nothing else', 'three tiers and nothing else')).toBe(false);
  });

  it('collapses runs of space without removing the boundaries between words', () => {
    expect(found('three   tiers', 'three tiers')).toBe(true);
    expect(found('threetiers', 'three tiers')).toBe(false);
  });

  /** Pure, and symmetric: what it removes from the span it removes from the page as well. */
  it('reads the same string the same way whichever side of the comparison it is on', () => {
    const value = 'The team’s ﬁrst — quar­ter';
    expect(normalisedSpan(value)).toBe(normalisedSpan(normalisedSpan(value)));
    expect(found(value, value)).toBe(true);
  });
});

/**
 * The one string in a specialist's report that is an address, given a length.
 *
 * It is classified as a destination, handed to the runner, and copied into the `evidenceChecks` the
 * lead reads - which are not cut by the report's own bound. Untrimmed, two citations could put a
 * specialist's whole 8,192-token output into the lead's window through a field labelled "source".
 */
describe('how long a cited source may be', () => {
  const reportWith = (source: string): string =>
    JSON.stringify({
      answer: 'Three tiers.',
      evidence: [{ claim: 'tiers', source, quotedSpan: 'three tiers' }]
    });

  it('keeps a citation at the bound', () => {
    const source = `https://example.test/${'a'.repeat(MAX_EVIDENCE_SOURCE_CHARS - 21)}`;
    expect(source).toHaveLength(MAX_EVIDENCE_SOURCE_CHARS);
    const checked = validateDelegateReport(reportWith(source));

    expect(checked.report?.evidence).toHaveLength(1);
    expect(checked.errors).toEqual([]);
  });

  it('drops one a character past it, and says why rather than losing it silently', () => {
    const source = `https://example.test/${'a'.repeat(MAX_EVIDENCE_SOURCE_CHARS - 20)}`;
    expect(source).toHaveLength(MAX_EVIDENCE_SOURCE_CHARS + 1);
    const checked = validateDelegateReport(reportWith(source));

    expect(checked.report?.evidence).toEqual([]);
    expect(checked.errors[0]).toContain('1 of 1 evidence items were dropped');
    expect(checked.errors[0]).toContain(`at most ${MAX_EVIDENCE_SOURCE_CHARS} characters`);
    // And the report itself is still readable: an over-long source is a dropped item, not a
    // correction pass.
    expect(checked.report?.answer).toBe('Three tiers.');
  });
});
