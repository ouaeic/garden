/**
 * What a completion says about itself once the harness has run the checks the turn declared.
 *
 * Written against `handleFinishCall` rather than through a whole `AgentWorker`, because the thing
 * in doubt is one branch of one function: the path past `MAX_ACCEPTANCE_FAILURES`, where the turn
 * ends rather than spending the rest of its budget on the same failure. That half was right and is
 * pinned here too - the failures still reach `remainingRisks`, the turn still completes rather than
 * being binned - and the half that was wrong is the word in the status field.
 *
 * MEASURED against a real box before this file existed: a task whose answer was WRONG reported
 * `status=completed verification=verified`, byte-identical in both top-line fields to the correct
 * run, with its own acceptance check having run in the box and failed four times. See
 * `evals/bench/selftest.ts` and the note at `evals/bench/score.ts:159`.
 */
import type { TaskRecord } from '@athanor/data';
import { decryptJson } from '@athanor/core';
import type { ModelToolCall } from '@athanor/model-gateway';
import { describe, expect, it } from 'vitest';
import type { AcceptanceRecord, AcceptanceResult } from '../acceptance.js';
import type { AgentState } from '../agent-state.js';
import type { CompletionVerification } from '../completion.js';
import {
  ACCEPTANCE_ALREADY_PASSED_CAVEAT,
  ACCEPTANCE_COULD_NOT_RUN_CAVEAT,
  ACCEPTANCE_EARLIER_TURN_CAVEAT,
  ACCEPTANCE_FAILED_CAVEAT,
  CAVEAT_BESIDE_THE_TICK,
  MAX_ACCEPTANCE_FAILURES,
  MAX_FINISH_REJECTIONS
} from '../turn-bounds.js';
import { handleFinishCall, type TurnFinishDeps } from './finish.js';

const task = { id: 'task-1', workspaceId: 'ws-1' } as TaskRecord;
const key = new Uint8Array(32);

const record: AcceptanceRecord = {
  checks: [
    {
      id: 'c1',
      kind: 'command',
      label: 'the sum is right',
      executable: 'bash',
      args: ['-lc', 'test "$(cat total.txt)" = 1260'],
      cwd: 'workspace',
      expectExit: 0,
      timeoutSeconds: 900
    }
  ],
  revisions: 1,
  declaredAtStep: 2
};

const passed: AcceptanceResult = {
  id: 'c1',
  label: 'the sum is right',
  passed: true,
  detail: 'exit 0'
};
const failed: AcceptanceResult = {
  id: 'c1',
  label: 'the sum is right',
  passed: false,
  detail: 'exit 1 (expected 0): no output'
};
const neverRan: AcceptanceResult = {
  id: 'c1',
  label: 'the sum is right',
  passed: false,
  detail: 'the check could not run: runner request failed (503)'
};

/** The completion `completeTurn` was handed, which is the payload of the `completed` event. */
interface Completed {
  readonly verification: CompletionVerification;
  readonly answer?: string | undefined;
  /** Absent when the turn declared no checks, which is a case this file asserts on. */
  readonly acceptance: string[] | undefined;
}

interface Run {
  readonly state: AgentState;
  readonly events: Array<{ kind: string; summary: string }>;
  readonly outcome: 'held' | 'completed' | 'parked';
  readonly completed: Completed | null;
  /** What the model was told, when it was told anything, which is the hold's own half. */
  readonly toldTheModel: string[];
  /**
   * One entry per time the harness actually executed the acceptance record.
   *
   * The stub above returns results whether or not it was called, so "the completion says nothing
   * about acceptance" is not evidence that nothing ran - it is equally what a run whose results
   * were discarded would look like. This is the only field that separates the two, and the
   * plan-mode case below is entirely about it: an acceptance run is the owner's build and test
   * commands executing on the owner's computer, so it is the call and not the report that matters.
   */
  readonly ran: string[];
}

/**
 * One `finish` call through the real branch.
 *
 * The turn is set up as the shape this file is about and nothing else: it has spoken, it changed
 * something beyond prose, its acceptance record is this turn's, and it cites a successful shell
 * call ordered after the last change - so the four holds ahead of the acceptance run all pass and
 * the run is the only thing left to decide the completion.
 */
const finish = async (
  results: readonly AcceptanceResult[] | null,
  state: Partial<AgentState> = {},
  /** What the plan says is still open, which only the plan-coverage hold reads. Empty by default. */
  outstanding: readonly string[] = [],
  answer?: string
): Promise<Run> => {
  let completed: Completed | null = null;
  const ran: string[] = [];
  const events: Run['events'] = [];
  const agentState = {
    messages: [],
    turn: 4,
    answered: true,
    mutated: true,
    mutatedBeyondProse: true,
    turnToolResults: {
      'call-1': { name: 'shell', success: true, mutating: true }
    },
    ...(results ? { acceptance: record, acceptanceTurn: 4 } : {}),
    ...state
  } as unknown as AgentState;
  const deps = {
    // The timeline is not what this file is about, but the holds await their own event write
    // without catching it, so the stub has to answer.
    store: {
      appendTaskEvent: async (row: Parameters<TurnFinishDeps['store']['appendTaskEvent']>[0]) => {
        const value = decryptJson<{ summary: string }>(
          row.payloadCiphertext!,
          key,
          `task-event:${task.id}`
        );
        events.push({ kind: row.kind, summary: value.summary });
        return { id: 'event-1' };
      },
      getLatestTaskPlan: async () => null,
      listMediaJobs: async () => []
    } as unknown as TurnFinishDeps['store'],
    config: {} as TurnFinishDeps['config'],
    outstandingPlanSteps: async () => [...outstanding],
    runAcceptanceChecks: async (
      _task: TaskRecord,
      _key: Uint8Array,
      declared: AcceptanceRecord
    ) => {
      ran.push(...declared.checks.map((check) => check.id));
      return [...(results ?? [])];
    },
    completeTurn: async (
      _task: TaskRecord,
      _key: Uint8Array,
      _state: AgentState,
      completion: { verification: CompletionVerification; acceptance?: string[]; answer?: string }
    ) => {
      completed = {
        verification: completion.verification,
        acceptance: completion.acceptance,
        answer: completion.answer
      };
    }
  } as unknown as TurnFinishDeps;
  const call = {
    id: 'call-finish',
    name: 'finish',
    arguments: {
      summary: 'Totalled the column and wrote it to total.txt.',
      ...(answer ? { answer } : {}),
      verification: {
        status: 'verified',
        evidence: [
          { claim: 'The file holds the total', source: 'tool_result', toolCallId: 'call-1' }
        ]
      }
    }
  } as unknown as ModelToolCall;
  const outcome = await handleFinishCall(deps, task, key, agentState, call, {
    turn: 4,
    assistantText: 'The total is 1260.'
  });
  return {
    state: agentState,
    events,
    outcome,
    completed,
    toldTheModel: agentState.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.content),
    ran
  };
};

describe('completion verification budget across later holds', () => {
  it.each(['plan', 'acceptance', 'answer'] as const)(
    'does not replenish verification attempts after a persisted %s hold',
    async (hold) => {
      const first = await finish(
        hold === 'acceptance' ? null : [passed],
        {
          finishRejections: MAX_FINISH_REJECTIONS - 1,
          turnToolResults: {},
          answered: hold !== 'answer'
        },
        hold === 'plan' ? ['Publish the result'] : []
      );
      expect(first.outcome).toBe('held');
      expect(first.completed).toBeNull();
      expect(first.state.finishRejections).toBe(MAX_FINISH_REJECTIONS);
      expect(first.events.length).toBeGreaterThan(0);
      expect(first.events.some((event) => event.kind === 'warning')).toBe(false);
      const resumed = JSON.parse(JSON.stringify(first.state)) as AgentState;
      resumed.acceptance = record;
      resumed.acceptanceTurn = 4;
      const second = await finish([passed], resumed, [], 'The total is 1260.');
      expect(second.outcome).toBe('completed');
      expect(second.completed?.verification.status).toBe('not_applicable');
      expect(second.completed?.verification.remainingRisks.length).toBeGreaterThan(0);
      expect(second.ran).toEqual(['c1']);
      expect(second.events.filter((event) => event.kind === 'warning')).toEqual([
        { kind: 'warning', summary: 'Completion evidence could not be verified' }
      ]);
      expect(second.events.some((event) => event.summary === 'Completion needs verification')).toBe(
        false
      );
    }
  );

  it('accepts newly valid evidence after a held finish without carrying an unverified warning', async () => {
    const held = await finish(
      [passed],
      { finishRejections: MAX_FINISH_REJECTIONS - 1, turnToolResults: {} },
      ['Publish the result']
    );
    expect(held.outcome).toBe('held');
    const completed = await finish([passed], {
      ...held.state,
      turnToolResults: { 'call-1': { name: 'shell', success: true, mutating: true } }
    });
    expect(completed.outcome).toBe('completed');
    expect(completed.completed?.verification.status).toBe('verified');
    expect(completed.events.some((event) => event.kind === 'warning')).toBe(false);
  });
});

describe('a turn that failed its own machine checks', () => {
  /**
   * The control. Everything below is a claim about a downgrade, and a downgrade that also fired on
   * the healthy path would be worse than none: `verified` would stop meaning anything at all.
   */
  it('still says verified when the harness ran the checks and they passed', async () => {
    const run = await finish([passed]);

    expect(run.outcome).toBe('completed');
    expect(run.completed?.verification.status).toBe('verified');
    expect(run.completed?.verification.remainingRisks).toEqual([]);
    // And nothing new beside the tick, which is where a caveat that fired on a clean run would show.
    expect(run.completed?.acceptance).toEqual(['c1: the sum is right — exit 0']);
  });

  /**
   * A turn with no acceptance record at all is untouched, which is most of what the box does: the
   * whole downgrade lives inside `if (state.acceptance)`, so `not_applicable` and `verified` on a
   * turn that declared nothing still mean exactly what they meant.
   */
  it('leaves a turn that declared no checks exactly as it was', async () => {
    const run = await finish(null, { mutatedBeyondProse: false });

    expect(run.outcome).toBe('completed');
    expect(run.completed?.verification.status).toBe('verified');
    expect(run.completed?.acceptance).toBeUndefined();
  });

  /** Below the ceiling nothing is written at all: the model is told what failed and goes round. */
  it('holds rather than completing while the model still has attempts left', async () => {
    const run = await finish([failed], { acceptanceFailures: 0 });

    expect(run.outcome).toBe('held');
    expect(run.completed).toBeNull();
    expect(run.toldTheModel.join('\n')).toContain(
      `Finish refused (acceptance 1 of ${MAX_ACCEPTANCE_FAILURES})`
    );
  });

  /**
   * The defect, and the two halves of the answer to it. The turn still ENDS - it is not binned, and
   * it does not spend the rest of the budget on the same failure - and the failures still travel in
   * the risks. What changed is the one field an owner or a script reads first.
   */
  it('reports the harness’s own status past the ceiling, and keeps the failures', async () => {
    const run = await finish([failed], { acceptanceFailures: MAX_ACCEPTANCE_FAILURES - 1 });

    expect(run.outcome).toBe('completed');
    expect(run.completed?.verification.status).toBe('checks_failed');
    // The half that was already right.
    expect(run.completed?.verification.remainingRisks).toContain(
      'the sum is right — exit 1 (expected 0): no output'
    );
  });

  /**
   * A check that could not run is its own answer. Folded into the passed one it reads as a proof;
   * folded into the failed one it reads as a disproof; it is neither, and the post-edit diagnostics
   * work in this tree already settled that such a check must read as silence.
   */
  it('does not fold a check that could not run into either neighbour', async () => {
    const run = await finish([neverRan], { acceptanceFailures: MAX_ACCEPTANCE_FAILURES - 1 });

    expect(run.outcome).toBe('completed');
    expect(run.completed?.verification.status).toBe('checks_did_not_run');
    expect(run.completed?.verification.remainingRisks).toContain(
      'the sum is right — the check could not run: runner request failed (503)'
    );
  });

  it('reports the failure when one check said no and another never ran', async () => {
    const run = await finish([{ ...neverRan, id: 'c2' }, failed], {
      acceptanceFailures: MAX_ACCEPTANCE_FAILURES - 1
    });

    expect(run.completed?.verification.status).toBe('checks_failed');
    // Both, because the ordering decides one word and loses nothing: the owner reads both lines.
    expect(run.completed?.verification.remainingRisks.join('\n')).toContain('could not run');
    expect(run.completed?.verification.remainingRisks.join('\n')).toContain('exit 1');
  });
});

/**
 * The other half of the requirement, and the one a type alone would not have met: what the owner
 * actually reads. A new status value that nothing renders is the computed-and-unwired shape.
 *
 * The card's protocol is the mechanism: a line written into BOTH the acceptance list and
 * `remainingRisks` is shown beside the tick, and a line written only into the risks sits behind the
 * disclosure with the rest of the detail (`apps/web/src/completion-card.ts`, `harnessCaveats`).
 * These sentences have to be in both, because the card is headed "Result" with a tick on it.
 */
describe('what the owner reads, in the words they read', () => {
  const beside = (run: Run): string[] =>
    (run.completed?.acceptance ?? []).filter((line) =>
      run.completed?.verification.remainingRisks.includes(line)
    );

  it('puts the failure sentence beside the tick, not behind the disclosure', async () => {
    const run = await finish([failed], { acceptanceFailures: MAX_ACCEPTANCE_FAILURES - 1 });

    expect(beside(run)).toEqual([ACCEPTANCE_FAILED_CAVEAT]);
    expect(ACCEPTANCE_FAILED_CAVEAT).toBe(
      'athanor ran the checks this turn declared and they did not pass, so nothing here is verified - read the failures below before relying on it.'
    );
  });

  it('says the unchecked case differently, because the owner’s next move differs', async () => {
    const run = await finish([neverRan], { acceptanceFailures: MAX_ACCEPTANCE_FAILURES - 1 });

    expect(beside(run)).toEqual([ACCEPTANCE_COULD_NOT_RUN_CAVEAT]);
    expect(ACCEPTANCE_COULD_NOT_RUN_CAVEAT).toBe(
      'athanor could not run the checks this turn declared, so this result is unchecked - neither proved nor disproved.'
    );
    // The sentence a reader must not be given here: nothing failed, and saying so would be athanor
    // claiming an observation it never made.
    expect(beside(run)).not.toContain(ACCEPTANCE_FAILED_CAVEAT);
  });

  /**
   * The register the web card reads to decide placement. A sentence written both ways but absent
   * from this set would be a line the two files disagree about, which is how the placement protocol
   * rots.
   */
  it('registers both sentences as ones that belong beside the tick', () => {
    expect(CAVEAT_BESIDE_THE_TICK.has(ACCEPTANCE_FAILED_CAVEAT)).toBe(true);
    expect(CAVEAT_BESIDE_THE_TICK.has(ACCEPTANCE_COULD_NOT_RUN_CAVEAT)).toBe(true);
  });

  /**
   * Twenty is the cap on `remainingRisks`, and the sentence that says what the other nineteen mean
   * has to survive it - so it is prepended rather than appended.
   */
  it('keeps the sentence when the failures alone would fill the risk list', async () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      ...failed,
      id: `c${index}`,
      label: `check ${index}`
    }));
    const run = await finish(many, { acceptanceFailures: MAX_ACCEPTANCE_FAILURES - 1 });

    expect(run.completed?.verification.remainingRisks).toHaveLength(20);
    expect(run.completed?.verification.remainingRisks[0]).toBe(ACCEPTANCE_FAILED_CAVEAT);
  });

  /**
   * The two sentences about a tick that is worth less than it looks, on a completion that has no
   * tick left.
   *
   * Both are written after the failure branch and, until the condition that guards them existed,
   * unconditionally: a run whose checks failed `MAX_ACCEPTANCE_FAILURES` times carried
   * ACCEPTANCE_FAILED_CAVEAT beside the tick and, on the same card behind the disclosure, a line
   * saying the checks show nothing broke - or that they were already passing. The owner reads both.
   *
   * `acceptanceNagged` is set because a turn that mutated and holds a record from an earlier turn
   * is sent round once to declare its own; this file is about what a completion says, not about
   * that hold, so the nag is spent before the call.
   */
  it('does not tell the owner nothing broke over checks that failed', async () => {
    const run = await finish([failed], {
      acceptanceFailures: MAX_ACCEPTANCE_FAILURES - 1,
      acceptanceTurn: 1,
      acceptanceNagged: true
    });

    expect(run.completed?.verification.remainingRisks).toContain(ACCEPTANCE_FAILED_CAVEAT);
    expect(run.completed?.verification.remainingRisks).not.toContain(
      ACCEPTANCE_EARLIER_TURN_CAVEAT
    );
  });

  it('does not say they were already passing over a run in which they failed', async () => {
    const run = await finish([failed], {
      acceptanceFailures: MAX_ACCEPTANCE_FAILURES - 1,
      acceptanceCaveat: ACCEPTANCE_ALREADY_PASSED_CAVEAT
    });

    expect(run.completed?.verification.remainingRisks).toContain(ACCEPTANCE_FAILED_CAVEAT);
    expect(run.completed?.verification.remainingRisks).not.toContain(
      ACCEPTANCE_ALREADY_PASSED_CAVEAT
    );
  });

  /**
   * The other direction, which is the whole reason these sentences exist. A tick over checks an
   * earlier turn wrote is worth less than a tick over checks this turn wrote, and the owner is
   * still told so.
   */
  it('still qualifies a tick earned by an earlier turn’s checks', async () => {
    const run = await finish([passed], { acceptanceTurn: 1, acceptanceNagged: true });

    expect(run.completed?.verification.remainingRisks).toContain(ACCEPTANCE_EARLIER_TURN_CAVEAT);
  });

  it('still says the checks were green before anybody started, when they were', async () => {
    const run = await finish([passed], { acceptanceCaveat: ACCEPTANCE_ALREADY_PASSED_CAVEAT });

    expect(beside(run)).toContain(ACCEPTANCE_ALREADY_PASSED_CAVEAT);
  });
});

/**
 * The mode's central claim, asked of the one tool that could break it.
 *
 * Plan mode's own headline test is titled "answers every act that would change this computer, and
 * runs none of them", and `finish` is on its permitted set: it is not mutating and it is
 * checkpoint-exempt, so both basis sets admit it without anybody naming it. What `finish` does at
 * hold 4 is execute the acceptance record, and acceptance-runner.ts says what that is - "An
 * acceptance suite is a build and a test run: the two longest things a turn does after the model
 * call" - through what acceptance.ts calls "a direct exec".
 *
 * The record gets into a plan-mode turn without a plan-mode turn declaring one. `set_acceptance` is
 * refused by the batch loop, but `startTurnState` does not launder `acceptance`, so a record an
 * earlier act-mode turn wrote is still on the state after the owner switches the conversation to
 * plan. That is the path these cases drive, and it is the reason the fixture below carries
 * `acceptanceTurn: 1` against a turn numbered 4.
 *
 * Driven against `ran` rather than against the completion, because the completion looks the same
 * either way: the results are discarded in both readings and only the call separates them.
 */
describe('a finish call made while the conversation is in plan mode', () => {
  /** The turn the owner switched to plan after an earlier act-mode turn declared the checks. */
  const carried: Partial<AgentState> = {
    mode: 'plan',
    // A plan-mode turn cannot set this: every tool that could is answered before it runs. Written
    // out rather than left to the default, because it is what makes hold 3 fall through to hold 4.
    mutatedBeyondProse: false,
    acceptanceTurn: 1
  };

  it('does not run the owner’s build and test commands', async () => {
    const run = await finish([passed], carried);

    expect(run.ran).toEqual([]);
    expect(run.outcome).toBe('completed');
    // And says nothing about checks it did not run. Left at the empty initialiser rather than
    // carried over from the turn that declared them: a plan-mode turn changed nothing, so there is
    // nothing an earlier green could be evidence of here.
    expect(run.completed?.acceptance).toBeUndefined();
  });

  /**
   * The control, and the only thing keeping the case above about the mode rather than about the
   * fixture: the same state in act mode runs the same record.
   */
  it('runs them exactly as before when the conversation is not in plan mode', async () => {
    const run = await finish([passed], { ...carried, mode: 'act' });

    expect(run.ran).toEqual(['c1']);
    expect(run.completed?.acceptance).toEqual(['c1: the sum is right — exit 0']);
  });

  /**
   * And the round trip the mode should not pay. A plan whose steps are all open is the deliverable
   * in plan mode, so holding the finish to be told so costs one model call and changes nothing.
   */
  it('completes rather than asking about plan steps that are open on purpose', async () => {
    const run = await finish(null, { mode: 'plan', mutatedBeyondProse: false }, [
      'Read the migration',
      'Draft the column'
    ]);

    expect(run.outcome).toBe('completed');
    expect(run.toldTheModel.join('\n')).not.toContain('plan steps are still open');
  });

  it('still asks about open plan steps in act mode', async () => {
    const run = await finish(null, { mutatedBeyondProse: false }, [
      'Read the migration',
      'Draft the column'
    ]);

    expect(run.outcome).toBe('held');
    expect(run.toldTheModel.join('\n')).toContain('2 plan steps are still open');
  });
});

it('carries the full final answer independently of progress and the short receipt', async () => {
  const run = await finish(
    null,
    { mutated: false, mutatedBeyondProse: false, answered: false },
    [],
    'The total is **1260**, from the source column.'
  );
  expect(run.outcome).toBe('completed');
  expect(run.completed?.answer).toBe('The total is **1260**, from the source column.');
});

it('uses a completion title without another model call and keeps naming failures separate from the result', async () => {
  const { encryptJson, decryptJson } = await import('@athanor/core');
  const writes: unknown[] = [],
    completions: unknown[] = [];
  const titledTask = {
    ...task,
    promptCiphertext: encryptJson(
      { prompt: 'Inspect a heading' },
      key,
      `task-prompt:${task.workspaceId}`
    )
  };
  const deps = {
    store: {
      getLatestTaskPlan: async () => null,
      listMediaJobs: async () => [],
      setGeneratedTaskTitle: async (_id: string, envelope: Parameters<typeof decryptJson>[0]) => {
        writes.push(decryptJson(envelope, key, `task-title:${task.workspaceId}`));
        throw new Error('Temporary title store failure');
      }
    },
    outstandingPlanSteps: async () => [],
    completeTurn: async (...args: unknown[]) => {
      completions.push(args);
    }
  } as unknown as TurnFinishDeps;
  const outcome = await handleFinishCall(
    deps,
    titledTask,
    key,
    { messages: [] } as unknown as AgentState,
    {
      id: 'finish',
      name: 'finish',
      arguments: {
        title: 'Example page heading',
        answer: 'Example Domain',
        summary: 'Example Domain',
        verification: { status: 'not_applicable', evidence: [] }
      }
    },
    { turn: 1, assistantText: '' }
  );
  expect(outcome).toBe('completed');
  expect(completions).toHaveLength(1);
  expect(writes).toEqual([{ title: 'Example page heading' }]);
});
