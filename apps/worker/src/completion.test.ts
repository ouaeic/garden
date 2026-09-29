import { describe, expect, it } from 'vitest';
import type { AcceptanceCheck, AcceptanceResult } from './acceptance.js';
import { acceptanceAlreadyObserved } from './acceptance.js';
import { agentTools } from './tools.js';
import type { AgentState } from './agent-state.js';
import {
  MAX_EVIDENCE_SOURCE_CHARS,
  MODEL_DECLARED_VERIFICATION_STATUSES,
  askOutcome,
  citableEvidence,
  completionReference,
  completionVerification,
  evidenceFloor,
  harnessEvidence,
  harnessVerificationStatus,
  normalisedSpan,
  observedCommands,
  parseDelegateReport,
  quotedSpanMatchesSource,
  shellObservation,
  startTurnState,
  validateDelegateReport
} from './completion.js';
import type { ModelToolCall } from '@garden/model-gateway';
import { MAX_FINISH_REJECTIONS, MAX_QUESTIONS_PER_TURN } from './turn-bounds.js';

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
    finishRejections: 2,
    completionNags: 4,
    truncatedReplies: 4,
    notices: 3,
    turnNoveltyBytes: 900,
    mutated: true,
    mutatedBeyondProse: true,
    answered: true,
    acceptanceFailures: 1,
    acceptanceNagged: true,
    acceptanceBaselineRefusals: 2,
    planCoverageNagged: true,
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
    // The sharpest one: a tool result from the previous turn could otherwise be cited as evidence
    // for work it predates, which is the exact thing completionVerification exists to refuse.
    expect(next.turnToolResults).toEqual({});
    expect(next.finishRejections).toBe(0);
    expect(next.completionNags).toBe(0);
    expect(next.truncatedReplies).toBe(0);
    // A monitor that spoke three times last turn was told it had used its whole allowance.
    expect(next.notices).toBe(0);
    // A fresh turn believing it had already changed something reorders its own evidence rules.
    expect(next.mutated).toBe(false);
    // Carried forward, this is the one that would hold a pure-answer turn to an acceptance record
    // on the strength of code the turn before it touched.
    expect(next.mutatedBeyondProse).toBe(false);
    // Every turn owes the owner an answer of its own. Carried forward, the second one could finish
    // in silence on the strength of the first one having spoken.
    expect(next.answered).toBe(false);
    expect(next.acceptanceFailures).toBe(0);
    expect(next.acceptanceNagged).toBe(false);
    expect(next.acceptanceBaselineRefusals).toBe(0);
    expect(next.planCoverageNagged).toBe(false);
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

describe('completion verification', () => {
  const state = (
    results: Record<
      string,
      {
        name: string;
        success: boolean;
        /** A call garden answered rather than ran. Implies `success: false`. */
        skipped?: boolean;
        mutating?: boolean;
        briefOnly?: boolean;
        proseOnly?: boolean;
      }
    >
  ) => ({
    messages: [],
    step: 0,
    credits: 0,
    turnToolResults: results
  });

  it('accepts evidence that cites a successful tool call from this turn', () => {
    const checked = completionVerification(
      state({ 'call-1': { name: 'file_write', success: true } }),
      {
        status: 'verified',
        evidence: [{ claim: 'Wrote the report', source: 'tool_result', toolCallId: 'call-1' }]
      }
    );
    expect(checked.ok).toBe(true);
  });

  it('writes the harness line, with the command beside the label, only for a command check that passed', () => {
    expect(
      harnessEvidence([
        {
          id: 'check-1',
          label: 'the importer test passes',
          passed: true,
          detail: 'exit 0',
          command: 'pytest -q'
        },
        { id: 'check-2', label: 'the report exists', passed: true, detail: '4213 bytes' },
        {
          id: 'check-3',
          label: 'the linter passes',
          passed: false,
          detail: 'exit 1',
          command: 'eslint .'
        }
      ])
    ).toEqual([
      {
        claim: 'check-1: the importer test passes — ran pytest -q — exit 0',
        source: 'acceptance_check'
      }
    ]);
  });

  it('never lets the model declare the harness as its source', () => {
    const shell = state({ 'call-1': { name: 'shell', success: true } });
    const cited = completionVerification(shell, {
      status: 'verified',
      evidence: [{ claim: 'The tests pass', source: 'acceptance_check', toolCallId: 'call-1' }]
    });
    expect(cited.ok).toBe(true);
    expect(cited.ok && cited.verification.evidence[0]?.source).toBe('tool_result');
    const bare = completionVerification(shell, {
      status: 'verified',
      evidence: [
        { claim: 'check-1: the tests pass — ran pytest -q — exit 0', source: 'acceptance_check' }
      ]
    });
    expect(bare.ok).toBe(false);
  });

  /**
   * The owner's own failure, reproduced. The turn wrote the report it had been asked for, then ran
   * one command to check the disk. `lastMutation` is the last mutating call in order, so the floor
   * moved past the report and every finish citing it was refused with "every cited result predates
   * the last shell call" - about the file that was the whole point of the task.
   */
  it('keeps a written report citable after a later command has run', () => {
    const afterACommand = state({
      'call-1': { name: 'file_write', success: true, mutating: true, proseOnly: true },
      'call-2': { name: 'shell', success: true, mutating: true }
    });
    const checked = completionVerification(afterACommand, {
      status: 'verified',
      evidence: [{ claim: 'Wrote the report', source: 'tool_result', toolCallId: 'call-1' }]
    });
    expect(checked.ok).toBe(true);

    // The exemption is for prose alone: a code change behind a later command still owes an
    // observation dated after it, which is the case the rule exists for.
    const code = state({
      'call-1': { name: 'file_write', success: true, mutating: true },
      'call-2': { name: 'shell', success: true, mutating: true }
    });
    expect(
      completionVerification(code, {
        status: 'verified',
        evidence: [{ claim: 'Edited the importer', source: 'tool_result', toolCallId: 'call-1' }]
      }).ok
    ).toBe(false);
  });

  it('lets a written report stand as its own evidence, but not a code change', () => {
    /*
     * The rule wants an observation dated after the last change. For code and commands there is one
     * to make - run it, read the exit code. For a research report there is not: the only check
     * available is reading back a file the agent has just written, which proves that a file it
     * wrote says what it wrote. That ceremony cost one research task about ten model turns after
     * its answer was already on screen.
     */
    const prose = state({
      'call-1': { name: 'file_write', success: true, mutating: true, proseOnly: true }
    });
    expect(
      completionVerification(prose, { status: 'verified', evidence: ['call-1'] })
    ).toMatchObject({ ok: true });
    // Code is unchanged: there the check is real, so something has to come after the change.
    const code = state({
      'call-1': { name: 'file_write', success: true, mutating: true }
    });
    expect(
      completionVerification(code, { status: 'verified', evidence: ['call-1'] })
    ).toMatchObject({ ok: false });
  });

  it('takes an id as evidence, and still refuses a claim that cites nothing', () => {
    /*
     * The shape used to demand three levels of nesting - a status, an array of objects each with a
     * claim and a source enum, and a second array - at the end of a long turn, while every other
     * tool takes flat scalars. A small model fumbles it: measured on one research task, a correct
     * answer was followed by about ten turns of rejected finishes and prose. The id is the part
     * that carries the guarantee, so the id alone is enough and a full item still works.
     */
    const turn = state({ 'call-1': { name: 'file_write', success: true } });
    expect(
      completionVerification(turn, { status: 'verified', evidence: ['call-1'] })
    ).toMatchObject({ ok: true });
    // A source it did not bother to name is read off what it cited, which can only ever be stricter.
    expect(
      completionVerification(turn, {
        status: 'verified',
        evidence: [{ claim: 'Wrote the report', toolCallId: 'call-1' }]
      })
    ).toMatchObject({ ok: true });
    // But `user_visible_result` is the one source that skips the ordering check, so it is never
    // guessed at. A claim citing nothing is not verification.
    expect(
      completionVerification(turn, { status: 'verified', evidence: [{ claim: 'I did it' }] })
    ).toMatchObject({ ok: false });
    expect(
      completionVerification(turn, { status: 'verified', evidence: ['no-such-call'] })
    ).toMatchObject({ ok: false });
  });

  it('does not let writing the running brief invalidate the evidence already gathered', () => {
    // Observed live: a turn did the work, checked it, cited the check, then recorded the outcome in
    // workspace/GARDEN.md - and that write became the new last change, so its own record-keeping
    // invalidated evidence it had already gathered. The way out was to read the brief back, which
    // proves only that a file it just wrote says what it wrote. Bookkeeping is not the work.
    const checked = completionVerification(
      state({
        'call-1': { name: 'shell', success: true, mutating: true },
        'call-2': { name: 'shell', success: true, mutating: true },
        'call-3': { name: 'file_write', success: true, mutating: true, briefOnly: true }
      }),
      {
        status: 'verified',
        evidence: [{ claim: 'The tests pass', source: 'tool_result', toolCallId: 'call-2' }]
      }
    );
    expect(checked.ok).toBe(true);
  });

  it('still demands evidence after a write that touched anything but the brief', () => {
    // The exemption is narrow on purpose: a call that wrote the brief AND a source file is a change
    // to the source file, and briefOnly is only set when every written path is a durable one.
    const checked = completionVerification(
      state({
        'call-1': { name: 'shell', success: true, mutating: true },
        'call-2': { name: 'file_write', success: true, mutating: true }
      }),
      {
        status: 'verified',
        evidence: [{ claim: 'The tests pass', source: 'tool_result', toolCallId: 'call-1' }]
      }
    );
    expect(checked).toMatchObject({ ok: false });
  });

  it('lets a shell attest the change it made, since checking through a shell is a change', () => {
    // The live failure this locks out: an agent built a deck with a script, checked the result with
    // another `bash -lc`, and cited that check. Every inline shell counts as a change - nothing
    // reads the script to find out otherwise - so the check was itself the last change, nothing
    // could come after it, and a finished job failed three times on its own verification. A shell
    // result carries what the command printed, so it is an observation made after the change; a
    // write result is only an acknowledgement, so it still needs something after it.
    const built = completionVerification(
      state({
        'call-1': { name: 'file_write', success: true, mutating: true },
        'call-2': { name: 'shell', success: true, mutating: true }
      }),
      {
        status: 'verified',
        evidence: [
          { claim: 'The deck has six slides', source: 'tool_result', toolCallId: 'call-2' }
        ]
      }
    );
    expect(built.ok).toBe(true);

    // The original defect stays closed: a write cannot be its own witness...
    const wroteOnly = completionVerification(
      state({
        'call-1': { name: 'shell', success: true, mutating: true },
        'call-2': { name: 'file_write', success: true, mutating: true }
      }),
      {
        status: 'verified',
        evidence: [{ claim: 'Wrote the deck', source: 'tool_result', toolCallId: 'call-2' }]
      }
    );
    expect(wroteOnly).toMatchObject({ ok: false });

    // ...and neither can something observed before the change.
    const stale = completionVerification(
      state({
        'call-1': { name: 'code_search', success: true },
        'call-2': { name: 'file_write', success: true, mutating: true }
      }),
      {
        status: 'verified',
        evidence: [{ claim: 'The tests pass', source: 'tool_result', toolCallId: 'call-1' }]
      }
    );
    expect(stale).toMatchObject({ ok: false });
  });

  it('rejects a completion that cites a tool call which failed', () => {
    const checked = completionVerification(state({ 'call-1': { name: 'shell', success: false } }), {
      status: 'verified',
      evidence: [{ claim: 'Ran the build', source: 'tool_result', toolCallId: 'call-1' }]
    });
    expect(checked).toMatchObject({ ok: false });
  });

  it('refuses not_applicable once the turn has actually used tools', () => {
    const checked = completionVerification(state({ 'call-1': { name: 'shell', success: true } }), {
      status: 'not_applicable',
      evidence: []
    });
    expect(checked).toMatchObject({ ok: false });
  });

  it('allows not_applicable when nothing but planning happened', () => {
    const checked = completionVerification(
      state({ 'call-1': { name: 'set_plan', success: true } }),
      {
        status: 'not_applicable',
        evidence: []
      }
    );
    expect(checked.ok).toBe(true);
  });

  it('rejects a completion whose evidence is something the turn said rather than saw', () => {
    // set_acceptance succeeds by being well-formed, so it is the cheapest successful call in any
    // turn that declares one - and citing it would make the completion contract close a loop on
    // itself: the promise offered as the proof it was kept.
    const checked = completionVerification(
      state({ 'call-1': { name: 'set_acceptance', success: true } }),
      {
        status: 'verified',
        evidence: [{ claim: 'The notes are tidy', source: 'tool_result', toolCallId: 'call-1' }]
      }
    );
    expect(checked).toMatchObject({ ok: false });
    if (!checked.ok) expect(checked.reason).toContain('rather than something you observed');
  });

  it('counts a delivered notice as something the turn said, not something it saw', () => {
    // The gate read `DECLARATION_TOOLS` while the set that answers this exact question -
    // `AGENT_SPEECH`, which is that set plus `notify` - sat two hundred lines above it, used once.
    // A notice is a sentence the model composed, delivered; it carries nothing back about the
    // world, and citing one proved only that garden has a lock screen.
    const cited = completionVerification(state({ 'call-1': { name: 'notify', success: true } }), {
      status: 'verified',
      evidence: [{ claim: 'The report is ready', source: 'tool_result', toolCallId: 'call-1' }]
    });
    expect(cited).toMatchObject({ ok: false });
    if (!cited.ok) expect(cited.reason).toContain('rather than something you observed');
    // The same reading from the front: a turn whose only call was a notice has still observed
    // nothing, so it may close conversationally.
    expect(
      completionVerification(state({ 'call-1': { name: 'notify', success: true } }), {
        status: 'not_applicable',
        evidence: []
      }).ok
    ).toBe(true);
    expect(citableEvidence(state({ 'call-1': { name: 'notify', success: true } }))).toContain(
      'No successful tool call this turn can be cited'
    );
  });

  it('refuses a citation of a call garden answered instead of running, and says which it was', () => {
    const answered = state({
      'call-1': { name: 'file_read', success: false, skipped: true }
    });
    const checked = completionVerification(answered, {
      status: 'verified',
      evidence: [{ claim: 'The report is written', source: 'tool_result', toolCallId: 'call-1' }]
    });
    expect(checked).toMatchObject({ ok: false });
    // Distinguished from an ordinary failure on purpose: a model told a call "did not complete
    // successfully" cites a neighbour, and a model told nothing ran runs the call.
    if (!checked.ok) expect(checked.reason).toContain('never ran');
  });

  it('does not let a write that never ran move the floor the evidence sits behind', () => {
    // `file_write` is classified as a change by its arguments, whether or not it was executed - and
    // the evidence floor is the one reader that asks about `mutating` without asking whether the
    // call ran. A skipped write used to invalidate reading the agent had honestly done before it.
    const turn = state({
      'call-1': { name: 'shell', success: true },
      'call-2': { name: 'file_write', success: false, skipped: true, mutating: true }
    });
    expect(evidenceFloor(turn).lastMutation).toBe(-1);
    expect(
      completionVerification(turn, {
        status: 'verified',
        evidence: [{ claim: 'The suite passes', source: 'tool_result', toolCallId: 'call-1' }]
      }).ok
    ).toBe(true);
  });

  it('still needs one observed result when the turn also declared its checks', () => {
    const checked = completionVerification(
      state({
        'call-1': { name: 'set_acceptance', success: true },
        'call-2': { name: 'shell', success: true }
      }),
      {
        status: 'verified',
        evidence: [{ claim: 'The suite passes', source: 'tool_result', toolCallId: 'call-2' }]
      }
    );
    expect(checked.ok).toBe(true);
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

  it('refuses a question from a turn that has not looked at anything', () => {
    // The sharp one. A computer that can go and read the two files is not entitled to ask which of
    // them differs, and this is the same judgement the completion nag and the finish gate already
    // make about a turn that did nothing - taken from the front instead of the back.
    const outcome = askOutcome(
      { turnToolResults: {} },
      { question: 'Which file?', why: 'Blocked' }
    );
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok ? '' : outcome.refusal).toContain('has not looked at anything yet');
  });

  it('does not count its own declarations as having looked', () => {
    // set_plan and set_acceptance are the model speaking, so a turn that published a plan and then
    // asked a question has still observed nothing - the same set citableEvidence refuses to cite.
    const outcome = askOutcome(
      { turnToolResults: { 'call-1': { name: 'set_plan', success: true } } },
      { question: 'Which file?', why: 'Blocked' }
    );
    expect(outcome.ok).toBe(false);
  });

  it('does not count telling the owner something as having looked', () => {
    // The cheapest way round the guard, if a notice counted: notify then ask is two calls that
    // between them observed nothing, and both of them are the agent talking. A notice is not in the
    // citable set for the same reason, but by a different route - see AGENT_SPEECH.
    const outcome = askOutcome(
      { turnToolResults: { 'call-1': { name: 'notify', success: true } } },
      { question: 'Which file?', why: 'Blocked' }
    );
    expect(outcome.ok ? '' : outcome.refusal).toContain('has not looked at anything yet');
  });

  it('refuses a question with no reason it could not be assumed instead', () => {
    const outcome = askOutcome(looked, { question: 'Which font?', why: '  ' });
    expect(outcome.ok ? '' : outcome.refusal).toContain('state the assumption');
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

  it('is not something a finish may cite as having verified anything', () => {
    // A question is what the model said, not what it observed. Citing it would be the completion
    // contract closing a loop on itself one step wider than set_plan already could.
    const guidance = citableEvidence({
      messages: [],
      step: 0,
      credits: 0,
      turnToolResults: { 'call-1': { name: 'ask', success: true } }
    });
    expect(guidance).toContain('not_applicable');
  });
});

describe('finish rejection guidance', () => {
  it('places fresh evidence before supporting history without changing the verification gate', () => {
    const current: AgentState = {
      messages: [],
      step: 0,
      credits: 0,
      turnToolResults: {
        old: { name: 'file_read', success: true },
        write: { name: 'file_write', success: true, mutating: true },
        check: {
          name: 'shell',
          success: true,
          mutating: true,
          command: { fingerprint: 'check', exitCode: 0 }
        },
        skipped: { name: 'file_read', success: true, skipped: true },
        failed: { name: 'file_read', success: false }
      }
    };
    const guidance = citableEvidence(current);
    expect(guidance).toContain('Current-state toolCallIds, newest first: check (shell) [exit 0]');
    expect(guidance.indexOf('check (shell)')).toBeLessThan(guidance.indexOf('old (file_read)'));
    expect(guidance).not.toContain('skipped (');
    expect(guidance).not.toContain('failed (');
    const verification = (id: string) =>
      completionVerification(current, {
        status: 'verified',
        evidence: [{ claim: 'The check passed', source: 'tool_result', toolCallId: id }]
      });
    expect(verification('old').ok).toBe(false);
    expect(verification('check').ok).toBe(true);
  });

  it('bounds large guidance while retaining the most recent evidence and durable prose', () => {
    const current: AgentState = {
      messages: [],
      step: 0,
      credits: 0,
      turnToolResults: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `read-${index}`,
          { name: 'file_read', success: true }
        ])
      )
    };
    current.turnToolResults!.report = {
      name: 'file_write',
      success: true,
      proseOnly: true,
      mutating: true
    };
    current.turnToolResults!.change = { name: 'file_patch', success: true, mutating: true };
    current.turnToolResults!.latest = { name: 'file_read', success: true };
    const guidance = citableEvidence(current);
    expect(guidance).toContain('latest (file_read), report (file_write)');
    expect(guidance.match(/\((?:file_read|file_write|file_patch)\)/g)).toHaveLength(16);
    expect(guidance).not.toContain('read-0 (');
    expect(guidance).toContain('Older successful results remain citable');
    expect(guidance).toContain('do not run another command just to repair a citation');
  });

  it('shows evidence IDs before the first finish attempt, without promoting failed checks', () => {
    const current: AgentState = {
      messages: [],
      step: 0,
      credits: 0,
      turnToolResults: {
        check: { name: 'shell', success: true, command: { fingerprint: 'check', exitCode: 2 } }
      }
    };
    expect(completionReference(current, 'check')).toContain('check (shell) [exit 2]');
    expect(completionReference(current, 'missing')).toBe('');
    current.turnToolResults!.check!.skipped = true;
    expect(completionReference(current, 'check')).toBe('');
  });

  it('names the ids a retry is allowed to cite', () => {
    // A rejected finish that is only told it was wrong tends to resend the same shape, which is
    // what turned one malformed completion into a whole step budget of retries.
    const guidance = citableEvidence({
      messages: [],
      step: 0,
      credits: 0,
      turnToolResults: {
        'call-1': { name: 'set_plan', success: true },
        'call-2': { name: 'file_write', success: true },
        'call-3': { name: 'shell', success: false }
      }
    });
    expect(guidance).toContain('call-2 (file_write)');
    expect(guidance).not.toContain('call-1');
    expect(guidance).not.toContain('call-3');
  });

  it('points at not_applicable when there is nothing citable', () => {
    const guidance = citableEvidence({ messages: [], step: 0, credits: 0, turnToolResults: {} });
    expect(guidance).toContain('not_applicable');
  });

  it('bounds retries well inside the step budget', () => {
    expect(MAX_FINISH_REJECTIONS).toBeLessThanOrEqual(3);
  });
});

describe('completion verification after a change', () => {
  const turn = (
    results: Record<
      string,
      { name: string; success: boolean; mutating?: boolean; briefOnly?: boolean }
    >
  ) => ({
    messages: [],
    step: 4,
    credits: 0,
    turnToolResults: results
  });

  it('rejects evidence gathered before the last change', () => {
    // The shape check passed happily on exactly this: search, write, then "the tests now pass"
    // citing the search. Every rule was an identity check; none of them looked at ordering.
    const checked = completionVerification(
      turn({
        'call-1': { name: 'code_search', success: true },
        'call-2': { name: 'file_write', success: true, mutating: true }
      }),
      {
        status: 'verified',
        evidence: [{ claim: 'The tests now pass', source: 'tool_result', toolCallId: 'call-1' }]
      }
    );
    expect(checked).toMatchObject({ ok: false });
    if (checked.ok) return;
    expect(checked.reason).toContain('file_write');
    expect(checked.reason).toContain('call-2');
  });

  it('accepts a check that ran after the change', () => {
    const checked = completionVerification(
      turn({
        'call-1': { name: 'code_search', success: true },
        'call-2': { name: 'file_write', success: true, mutating: true },
        'call-3': { name: 'code_diagnostics', success: true }
      }),
      {
        status: 'verified',
        evidence: [{ claim: 'Diagnostics are clean', source: 'tool_result', toolCallId: 'call-3' }]
      }
    );
    expect(checked.ok).toBe(true);
  });

  it('leaves a read-only turn exactly as it was', () => {
    const checked = completionVerification(
      turn({ 'call-1': { name: 'document_read', success: true } }),
      {
        status: 'verified',
        evidence: [{ claim: 'The contract says so', source: 'tool_result', toolCallId: 'call-1' }]
      }
    );
    expect(checked.ok).toBe(true);
  });

  it('does not apply the rule to a state saved before it existed', () => {
    // turnToolResults persists across a pause and a worker handover, and older rows carry no
    // mutating flag; a resumed task must not become uncompletable because of that.
    const checked = completionVerification(
      turn({
        'call-1': { name: 'code_search', success: true },
        'call-2': { name: 'file_write', success: true }
      }),
      {
        status: 'verified',
        evidence: [{ claim: 'Wrote the file', source: 'tool_result', toolCallId: 'call-1' }]
      }
    );
    expect(checked.ok).toBe(true);
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

describe('what the user can see, and what merely says so', () => {
  const state = (
    results: Record<string, { name: string; success: boolean; skipped?: boolean }>
  ) => ({
    messages: [],
    step: 0,
    credits: 0,
    turnToolResults: results
  });

  it('refuses a user-visible claim pinned to a call garden answered without running', () => {
    const checked = completionVerification(
      state({
        'call-1': { name: 'file_write', success: true },
        'call-2': { name: 'publish_artifact', success: false, skipped: true }
      }),
      {
        status: 'verified',
        evidence: [
          { claim: 'Wrote it', source: 'tool_result', toolCallId: 'call-1' },
          { claim: 'The page is up', source: 'user_visible_result', toolCallId: 'call-2' }
        ]
      }
    );

    expect(checked).toMatchObject({ ok: false });
    expect(checked.ok === false && checked.reason).toContain('never ran');
  });

  it('refuses a user-visible claim pinned to a call the computer failed', () => {
    const checked = completionVerification(
      state({
        'call-1': { name: 'file_write', success: true },
        'call-2': { name: 'publish_artifact', success: false }
      }),
      {
        status: 'verified',
        evidence: [
          { claim: 'Wrote it', source: 'tool_result', toolCallId: 'call-1' },
          { claim: 'The page is up', source: 'user_visible_result', toolCallId: 'call-2' }
        ]
      }
    );

    expect(checked).toMatchObject({ ok: false });
    expect(checked.ok === false && checked.reason).toContain('did not complete successfully');
  });

  it('still lets a user-visible claim stand on nothing at all, which is what it is for', () => {
    const checked = completionVerification(state({ 'call-1': { name: 'shell', success: true } }), {
      status: 'verified',
      evidence: [
        { claim: 'Ran it', source: 'tool_result', toolCallId: 'call-1' },
        { claim: 'The answer is in the reply', source: 'user_visible_result' }
      ]
    });

    expect(checked).toMatchObject({ ok: true });
  });

  it('still lets it cite a delivered notice, which the user genuinely can see', () => {
    const checked = completionVerification(
      state({
        'call-1': { name: 'shell', success: true },
        'call-2': { name: 'notify', success: true }
      }),
      {
        status: 'verified',
        evidence: [
          { claim: 'Ran it', source: 'tool_result', toolCallId: 'call-1' },
          { claim: 'They were told', source: 'user_visible_result', toolCallId: 'call-2' }
        ]
      }
    );

    expect(checked).toMatchObject({ ok: true });
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
 * The status the harness computes, and the wall that keeps the model on the other side of it.
 *
 * `CompletionVerification.status` now has four values and only two of them are the model's. The
 * split is the whole point: a downgrade the model could declare is a downgrade the model could
 * decline to declare, and it would then be one more thing the model says about itself rather than
 * evidence about what the checks did. It is also what makes the third and fourth values free on the
 * wire - neither appears in the finish schema, so the tool catalogue does not grow by a byte.
 */
describe('a status the harness writes and the model cannot', () => {
  const result = (passed: boolean, detail: string): AcceptanceResult => ({
    id: 'c1',
    label: 'the suite passes',
    passed,
    detail
  });
  const passing = result(true, 'exit 0');
  const failing = result(false, 'exit 1 (expected 0): 3 tests failed');
  const unrun = result(false, 'the check could not run: runner refused (503)');

  it('offers the model exactly two values, and they are the two the catalogue publishes', () => {
    expect([...MODEL_DECLARED_VERIFICATION_STATUSES]).toEqual(['verified', 'not_applicable']);
    const finish = agentTools.find((tool) => tool.name === 'finish');
    const status = (
      finish?.parameters as {
        properties: { verification: { properties: { status: { enum: string[] } } } };
      }
    ).properties.verification.properties.status;
    // The wire and this file, held together: the 27 bytes of catalogue headroom are only safe
    // while the harness's own values stay out of the schema the model is sent.
    expect(status.enum).toEqual([...MODEL_DECLARED_VERIFICATION_STATUSES]);
  });

  it('refuses a finish that tries to declare one of the harness’s own statuses', () => {
    for (const status of ['unverified', 'checks_failed', 'checks_did_not_run']) {
      const checked = completionVerification(
        { messages: [], turnToolResults: {} } as unknown as AgentState,
        { status, evidence: [] }
      );
      expect(checked, status).toMatchObject({ ok: false });
      expect(!checked.ok && checked.reason).toContain('verified or not_applicable');
    }
  });

  it('leaves a turn whose checks all passed saying exactly what it said', () => {
    expect(harnessVerificationStatus('verified', [passing, passing])).toBe('verified');
  });

  /**
   * A turn with no acceptance record never reaches this function at all - `turn/finish.ts` calls it
   * only inside `if (state.acceptance)` and only past the failure ceiling - and the empty list is
   * the same fact spelled here, so `not_applicable` still means what it means.
   */
  it('leaves a turn with no checks alone', () => {
    expect(harnessVerificationStatus('not_applicable', [])).toBe('not_applicable');
    expect(harnessVerificationStatus('verified', [])).toBe('verified');
  });

  it('withdraws the claim when a check the harness ran said no', () => {
    expect(harnessVerificationStatus('verified', [passing, failing])).toBe('checks_failed');
  });

  it('says silence, not health and not a verdict, when a check could not run', () => {
    expect(harnessVerificationStatus('verified', [passing, unrun])).toBe('checks_did_not_run');
    // The one that would be the same defect wearing a different hat: folded into `verified`, an
    // unrunnable check reads as a proof; folded into `checks_failed`, it reads as a disproof.
    expect(harnessVerificationStatus('verified', [unrun])).not.toBe('verified');
    expect(harnessVerificationStatus('verified', [unrun])).not.toBe('checks_failed');
  });

  /**
   * An observed failure outranks an unobserved check, because a failure is evidence and an absence
   * is not. Nothing is lost by the ordering: both lines are in `remainingRisks` either way.
   */
  it('reports the failure when one check said no and another never ran', () => {
    expect(harnessVerificationStatus('verified', [unrun, failing])).toBe('checks_failed');
    expect(harnessVerificationStatus('verified', [failing, unrun])).toBe('checks_failed');
  });

  it('never promotes: a claim the model did not make is not the harness’s to make', () => {
    expect(harnessVerificationStatus('not_applicable', [passing])).toBe('not_applicable');
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
