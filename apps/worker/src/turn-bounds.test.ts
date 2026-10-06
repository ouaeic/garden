import { GardenError } from '@garden/core';
import type { ModelMessage, ModelToolCall } from '@garden/model-gateway';
import { describe, expect, it } from 'vitest';
import {
  BOOKKEEPING_TOOLS,
  HOST_DISK_FULL_CHECKPOINT_CODE,
  IDLE_STEPS_BEFORE_STOP,
  MAX_IDLE_STEPS,
  MAX_NOTICES_PER_TURN,
  MAX_PARALLEL_TOOL_CALLS,
  MAX_QUESTIONS_PER_TURN,
  MAX_REPEATED_FAILURES,
  MAX_STATIONARY_ACTING_STEPS,
  MAX_STATIONARY_STEPS,
  CHECKPOINT_EXEMPT_TOOLS,
  PARALLEL_SAFE_TOOLS,
  REPEATABLE_TOOLS,
  REPEATABLE_TOOLS_THAT_WRITE,
  PUSHBACK_MARKERS,
  REPEATED_FAILURES_BEFORE_STOP,
  STEP_BUDGET_HANDOFF_STEPS,
  STEP_BUDGET_MARKER,
  STEP_HANDOFF_MARKER,
  WORKSPACE_TOO_LARGE_CHECKPOINT_CODE,
  approvalOrigin,
  cancelConfirmation,
  effortFloorEarned,
  failingCallKey,
  failureSignature,
  idleStepsAfter,
  ownerFixableCheckpointFailure,
  parallelToolRun,
  reasoningEffortForStep,
  repeatedFailureBreak,
  repeatedFailureKey,
  repeatedFailureRise,
  repeatedFailuresAfter,
  spendHalt,
  spendWarning,
  stationaryStepBreak,
  stationaryStepRun,
  stationaryStepsBeforeStop,
  stepBudgetNotice,
  stepSignature,
  tombstoneMalformedCall
} from './turn-bounds.js';
import { degenerateRepeat } from './streaming.js';

describe('a failure that keeps happening', () => {
  type Call = { name: string; arguments: Record<string, unknown> };
  /** The observed shape: the same hunk sent again against a file it does not match. */
  const patch = (oldText: string, path = 'workspace/importer.py'): Call => ({
    name: 'file_patch',
    arguments: { patches: [{ path, oldText, newText: 'return rows or []' }] }
  });
  const conflict = (): unknown =>
    new GardenError('patch_conflict', 'oldText appears 0 times in workspace/importer.py');
  const threw = (call: Call, error: unknown): { call: string; failure: string } => ({
    call: failingCallKey(call),
    failure: repeatedFailureKey(call, error)
  });
  const answered = (call: Call): { call: string; failure: null } => ({
    call: failingCallKey(call),
    failure: null
  });
  const counted = (
    call: Call,
    error: unknown,
    times: number,
    from: Record<string, number> = {}
  ): Record<string, number> => {
    let counts = from;
    for (let attempt = 0; attempt < times; attempt += 1)
      counts = repeatedFailuresAfter(counts, threw(call, error));
    return counts;
  };

  it('counts one call failing one way, and only when it is the same both times', () => {
    const call = patch('def load(rows):');
    expect(Object.values(counted(call, conflict(), 1))).toEqual([1]);
    expect(Object.values(counted(call, conflict(), MAX_REPEATED_FAILURES))).toEqual([
      MAX_REPEATED_FAILURES
    ]);
    // The wording of the error moves and the failure does not: the same conflict reported with a
    // different line number, a different byte count or a different request id is the same refusal.
    const noisy = new GardenError('patch_conflict', 'oldText appears 0 times, request 4f9c2a1b8e');
    expect(Object.values(counted(call, noisy, 1, counted(call, conflict(), 2)))).toEqual([3]);
  });

  it('leaves a search that misses in four different places alone', () => {
    /*
     * The hardest honest case, and the one that decides what "the same failure" means.
     *
     * An agent looking for where a project keeps its config reads four candidate paths and gets the
     * same "no such file" four times. Keyed on the error alone that is a pattern and the turn gets
     * interrupted; keyed on the call it is what a search looks like from outside - every miss rules
     * a path out, and the next call is the one that finds it. Nothing here may reach even the first
     * pushback, let alone the stop.
     */
    const missing = new GardenError('not_found', 'File not found');
    let counts: Record<string, number> = {};
    for (const path of ['.eslintrc', '.eslintrc.json', 'config/eslint.json', 'eslint.config.js'])
      counts = repeatedFailuresAfter(counts, threw(patch('module.exports', path), missing));
    expect(Object.values(counts)).toEqual([1, 1, 1, 1]);
    expect(repeatedFailureRise({}, counts)).toEqual({ tool: 'file_patch', count: 1 });
  });

  it('treats a retry that works, or that breaks differently, as the correction it is', () => {
    /*
     * The ordinary rhythm this must never fire on. A command fails because the thing it needs is
     * not up yet, the agent starts it, and the same command succeeds - the count for it is gone,
     * because the count only ever meant "this produced identical bytes to last time".
     *
     * Note what is not tested here, because it cannot happen: a suite that fails, is fixed and
     * passes never reaches any of this. A non-zero exit is a tool result, not a thrown call, and
     * only a thrown call is counted. `evals/fixtures.ts` runs that end to end.
     */
    const call = patch('def load(rows):');
    expect(repeatedFailuresAfter(counted(call, conflict(), 2), answered(call))).toEqual({});
    // A second attempt that fails for a new reason is new information, so the old count goes with
    // the old reason rather than being added to.
    const unreachable = new Error('The workspace runner could not be reached');
    expect(
      Object.values(repeatedFailuresAfter(counted(call, conflict(), 2), threw(call, unreachable)))
    ).toEqual([1]);
    // And the same file patched with a different hunk is a different call, whatever it fails with.
    expect(
      Object.values(
        repeatedFailuresAfter(
          counted(call, conflict(), 2),
          threw(patch('    return rows'), conflict())
        )
      )
    ).toEqual([2, 1]);
  });

  it('reads what this step did rather than what the counts stand at', () => {
    // A call that failed three times and was then left alone keeps its three. Judged on the
    // standing maximum, the loop would push the same sentence back on every step afterwards, about
    // something the model had already stopped doing.
    const abandoned = counted(patch('def load(rows):'), conflict(), 3);
    expect(repeatedFailureRise(abandoned, abandoned)).toBeNull();
    const other = repeatedFailuresAfter(abandoned, threw(patch('    return rows'), conflict()));
    expect(repeatedFailureRise(abandoned, other)).toEqual({ tool: 'file_patch', count: 1 });
  });

  it('keeps no arguments and no error text in what it stores', () => {
    // The counts outlive the call and are written to task state on every step. The owner's file
    // body goes into a file_patch and their own code comes back in the conflict, so what is kept
    // has to prove only that two attempts were the same attempt.
    const secret = patch('const apiToken = "the owner private value";');
    const key = repeatedFailureKey(
      secret,
      new GardenError('patch_conflict', 'the owner private value')
    );
    expect(key.startsWith('file_patch:')).toBe(true);
    expect(key).not.toContain('owner');
    expect(key.split(':').slice(1).join('')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('says the number, the tool and the two ways out, three times before it ends anything', () => {
    const said = repeatedFailureBreak(MAX_REPEATED_FAILURES, 'file_patch');
    expect(said).toContain(`FAILED ${MAX_REPEATED_FAILURES} TIMES`);
    expect(said).toContain('file_patch');
    expect(said).toContain('take a different action');
    expect(said).toContain('finish');
    // The stop is the half that costs the owner a turn, so it is never the first thing the model
    // hears - the same three-warnings shape the idle guard was given.
    expect(REPEATED_FAILURES_BEFORE_STOP - MAX_REPEATED_FAILURES).toBe(3);
  });

  it('keeps a bounded number of failing calls', () => {
    let counts: Record<string, number> = {};
    for (let index = 0; index < 40; index += 1)
      counts = repeatedFailuresAfter(counts, threw(patch(`hunk ${index}`), conflict()));
    expect(Object.keys(counts)).toHaveLength(16);
    // What survives is what the turn is still failing at, not what it failed at first.
    expect(counts[repeatedFailureKey(patch('hunk 39'), conflict())]).toBe(1);
  });

  it('reads a plain error by its shape and an garden error by its code', () => {
    expect(failureSignature(new GardenError('patch_conflict', 'anything at all'))).toBe(
      'patch_conflict'
    );
    expect(failureSignature(new Error('Workspace tool failed (503): upstream 8f2c91ab0d'))).toBe(
      failureSignature(new Error('Workspace tool failed (500): upstream 41bd77e9c3'))
    );
    expect(failureSignature(new Error('Connection refused'))).not.toBe(
      failureSignature(new Error('Permission denied'))
    );
  });
});

describe('knowing how far through a long turn it is', () => {
  const notices = (maxSteps: number): Array<[number, string]> =>
    Array.from({ length: maxSteps }, (_, step) => [step, stepBudgetNotice(step, maxSteps)] as const)
      .filter((entry): entry is [number, string] => entry[1] !== null)
      .map(([step, notice]) => [step, notice.split(':')[0] ?? '']);

  it('says nothing while there is plenty of budget left', () => {
    expect(stepBudgetNotice(0, 60)).toBeNull();
    expect(stepBudgetNotice(20, 60)).toBeNull();
  });

  it('warns once with time to change course, then once when only a handoff fits', () => {
    expect(notices(60)).toEqual([
      [42, STEP_BUDGET_MARKER],
      [56, STEP_HANDOFF_MARKER],
      [57, STEP_HANDOFF_MARKER],
      [58, STEP_HANDOFF_MARKER],
      [59, STEP_HANDOFF_MARKER]
    ]);
  });

  it('names the steps that are left rather than saying the budget is nearly gone', () => {
    expect(stepBudgetNotice(42, 60)).toContain("42 of this turn's 60 steps");
    expect(stepBudgetNotice(42, 60)).toContain('18 remain');
    expect(stepBudgetNotice(58, 60)).toContain('2 of this turn');
  });

  it('tells a turn that is out of steps that the work carries over rather than ending', () => {
    const notice = stepBudgetNotice(59, 60) ?? '';
    expect(notice).toContain('reply with what is done');
    expect(notice).toContain('fresh budget');
  });

  it('still gives the handoff notice on a budget too small for two', () => {
    const marks = notices(STEP_BUDGET_HANDOFF_STEPS).map(([, marker]) => marker);
    expect(marks).not.toContain(STEP_BUDGET_MARKER);
    expect(marks).toContain(STEP_HANDOFF_MARKER);
  });
});

describe('spending limits the owner can read', () => {
  const window = (name: 'task' | 'daily' | 'monthly', spentUsd: number, capUsd: number | null) => ({
    name,
    spentUsd,
    pendingUsd: 0,
    capUsd,
    warnAtUsd: capUsd === null ? null : capUsd * 0.8,
    projectedUsd: spentUsd,
    state: 'ok' as const,
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: '2026-08-02T00:00:00.000Z'
  });

  it('names the amount, the limit and the window it belongs to', () => {
    // A ceiling the owner cannot see themselves approaching reads as a random interruption, so the
    // halt has to carry the numbers rather than say "budget exceeded".
    const message = spendHalt({
      outcome: 'deny',
      estimateUsd: 0.5,
      blockedBy: 'daily',
      warnedBy: [],
      reason: null,
      windows: [window('task', 1, 4), window('daily', 9.9, 10)]
    });
    expect(message).toContain('$9.90');
    expect(message).toContain('$10.00');
    expect(message).toContain('today');
    expect(message).toContain('Raise the limit');
  });

  it('still says something useful when the blocking window has no cap to quote', () => {
    expect(
      spendHalt({
        outcome: 'deny',
        estimateUsd: 0.5,
        blockedBy: 'monthly',
        warnedBy: [],
        reason: 'The monthly limit is already spent.',
        windows: [window('monthly', 20, null)]
      })
    ).toContain('The monthly limit is already spent.');
  });

  /**
   * The sentence has to reach the cap it says was reached.
   *
   * `spentUsd` is money that changed hands; a queued or running task holds its whole ceiling as
   * `pendingUsd` from the moment it is queued, and the decision blocks on the sum. So a month with
   * $40 billed and $65 promised blocks against a $100 cap while the line the owner reads says
   * "$40.00 of the $100.00 limit" - arithmetic that argues the run should still be going. This is
   * the same complaint the function's own comment makes about a ceiling nobody can see themselves
   * approaching, one level further in.
   */
  it('accounts for money promised to open work, not only money already billed', () => {
    const message = spendHalt({
      outcome: 'deny',
      estimateUsd: 0.5,
      blockedBy: 'monthly',
      warnedBy: [],
      reason: null,
      windows: [{ ...window('monthly', 40, 100), pendingUsd: 65, projectedUsd: 105.5 }]
    });
    expect(message).toContain('$40.00');
    expect(message).toContain('$65.00');
    expect(message).toContain('$100.00');
  });

  it('says nothing about promised work when none is open', () => {
    // The clause is conditional for a reason: on the ordinary stop there is nothing held, and a
    // sentence that says "with $0.00 more promised" is narration about the absence of a thing.
    expect(
      spendWarning({
        outcome: 'warn',
        estimateUsd: 0.5,
        blockedBy: null,
        warnedBy: ['daily'],
        reason: null,
        windows: [window('daily', 8, 10)]
      })
    ).not.toContain('promised');
  });

  /**
   * Zero is a ceiling, not the absence of one - "only a route that publishes no charge", in the
   * caps route's own words - and `!capUsd` could not tell the two apart, so the one stop whose
   * whole explanation is the number fell through to the sentence without any numbers in it.
   */
  it('quotes a ceiling of zero rather than falling through to the wordless refusal', () => {
    const message = spendHalt({
      outcome: 'deny',
      estimateUsd: 0.01,
      blockedBy: 'monthly',
      warnedBy: [],
      reason: 'Spending on this month would reach $0.01, past the $0.00 cap.',
      windows: [{ ...window('monthly', 0, 0), projectedUsd: 0.01 }]
    });
    expect(message).toContain('$0.00 of the $0.00 limit for this month');
    expect(message).not.toContain('$0.0000');
  });

  it('reports sub-cent spend without rounding it away to zero', () => {
    // A cheap model can run a long way below a cent a step; "$0.00 of $5.00" reads as a bug.
    expect(
      spendWarning({
        outcome: 'warn',
        estimateUsd: 0.001,
        blockedBy: null,
        warnedBy: ['task'],
        reason: null,
        windows: [window('task', 0.0042, 5)]
      })
    ).toContain('$0.0042');
  });
});

describe('how hard the model thinks about a step', () => {
  const step = (over: Partial<Parameters<typeof reasoningEffortForStep>[0]>) =>
    reasoningEffortForStep({ step: 3, messages: [], planVersion: 2, ...over });

  const after = (name: string, result = 'ok'): ModelMessage[] => [
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name, arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', content: result }
  ];

  it('spends the full budget on the opening step', () => {
    expect(step({ step: 0 })).toBe('high');
  });

  it('does not let a call that threw decide the whole turn is hard', () => {
    const threw = { step: 3, messages: after('shell', 'Tool failed: runner unreachable') };
    // Worth thinking about on the step that recovers from it...
    expect(reasoningEffortForStep(threw)).toBe('high');
    // ...but `Tool failed:` is written when a tool threw, which is a fact about the network. One
    // such shell call on step 4 of a measured run pinned all sixteen remaining steps to maximum
    // reasoning on a task whose entire output was two lines of verse.
    expect(effortFloorEarned(threw)).toBe(false);
  });

  it('lets evidence about the work itself pin the floor', () => {
    for (const hard of [{ acceptanceFailures: 1 }, { compactedAtStep: 3 }]) {
      const state = { step: 3, messages: [], planVersion: 2, ...hard };
      expect(effortFloorEarned(state)).toBe(true);
      expect(reasoningEffortForStep(state)).toBe('high');
    }
  });

  it('spends it again when the last step went wrong', () => {
    expect(step({ messages: after('shell', 'Tool failed: no such file') })).toBe('high');
    expect(step({ acceptanceFailures: 1, messages: after('code_search') })).toBe('high');
  });

  it('does not spend less on the step that has to interpret what it just read', () => {
    // This is the inversion the effort rule used to have. `REPEATABLE_TOOLS` is a replay-safety
    // set - tools whose second run after a restart cannot surprise anyone - and effort was taken
    // from it, so the step after a file_read, an image_read or a parallel_web_read ran at 'low':
    // the cheapest thinking in the task landed on the step holding the material it had just
    // fetched.
    expect(step({ messages: after('code_search') })).toBe('medium');
    expect(step({ messages: after('file_read') })).toBe('medium');
    expect(step({ messages: after('parallel_web_read') })).toBe('medium');
    expect(step({ messages: after('set_plan') })).toBe('medium');
  });

  it('settles at medium once work is underway', () => {
    expect(step({ messages: after('file_write') })).toBe('medium');
    expect(reasoningEffortForStep({ step: 3, messages: after('file_write') })).toBe('medium');
  });

  it('does not raise the floor for a long turn or a full window on their own', () => {
    // Length and size are not evidence that the work is hard: measured, the floor they raised was
    // most of what a reasoning route wrote and bought nothing the dev set could find.
    expect(step({ step: 40, messages: after('file_write') })).toBe('medium');
    expect(effortFloorEarned({ step: 40, messages: [], planVersion: 2 })).toBe(false);
  });

  it('raises the floor where the evidence about the work puts the failures, and keeps it there', () => {
    expect(step({ compactedAtStep: 3 })).toBe('high');
    expect(step({ step: 9, compactedAtStep: 8 })).toBe('high');
    expect(step({ acceptanceFailures: 1 })).toBe('high');
    // Ratcheted rather than recomputed: a turn that has become hard does not stop being hard, and
    // a reasoning field that flips ten times in twenty-three steps discards the cached trajectory
    // under it on every flip.
    expect(step({ reasoningFloor: 'high', messages: after('file_write') })).toBe('high');
  });

  it('stops spending on a compaction two steps after it happened', () => {
    expect(step({ step: 12, compactedAtStep: 8 })).toBe('medium');
  });

  /**
   * The second half of why the ratchet exists, and the half a per-step assertion cannot see.
   *
   * Replayed over a trajectory shaped like a real research task, the rule this replaced changed the
   * `reasoning` field six times in seventeen steps - every change discarding the provider's cached
   * trajectory below the system prefix, on a window that only grows. The field now moves at most
   * twice: down once when the opening step is over, and up if the turn becomes hard.
   */
  it('keeps the request field steady across a whole trajectory', () => {
    const trajectory = [
      'set_plan',
      'web_search',
      'parallel_web_read',
      'document_read',
      'file_write',
      'shell',
      'image_read',
      'file_write',
      'publish_file',
      'finish'
    ];
    const messages: ModelMessage[] = [{ role: 'user', content: 'Write me the report' }];
    let floor: 'medium' | 'high' | undefined;
    const efforts = trajectory.map((tool, index) => {
      const effort = reasoningEffortForStep({
        step: index,
        messages,
        planVersion: 1,
        ...(floor ? { reasoningFloor: floor } : {})
      });
      if (index > 0 && effort === 'high') floor = 'high';
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${index}`, name: tool, arguments: {} }]
      });
      messages.push({ role: 'tool', toolCallId: `c${index}`, content: `${tool} ok` });
      return effort;
    });
    const changes = efforts.filter((effort, index) => index > 0 && effort !== efforts[index - 1]);
    expect(changes).toHaveLength(1);
    expect(efforts[0]).toBe('high');
    expect(efforts.filter((effort) => effort === 'medium')).toHaveLength(trajectory.length - 1);
  });
});

/*
 * The Stop button reaching the background.
 *
 * `processes/start` answers in milliseconds and leaves its child running for the rest of its hour,
 * so a cancelled task went on writing into the workspace and making requests attributed to this
 * computer while the interface said it had stopped. The runner has always had the route to end
 * them; nothing called it.
 */
describe('what the owner is told when they stop a conversation', () => {
  // Verbatim, because the exemption is the runner's rule to state. Rewording it here is how a
  // service that is still up comes to be described by a side that does not know the rule.
  it('repeats the runner’s own account of what is still running', () => {
    expect(
      cancelConfirmation(
        'Stopped 2 background commands. The declared service "web" is still running: a service is meant to outlive the task that started it, so stopping one is its own action.'
      )
    ).toBe(
      'Task cancelled by user. Stopped 2 background commands. The declared service "web" is still running: a service is meant to outlive the task that started it, so stopping one is its own action.'
    );
  });

  // A computer that is not answering is one of the reasons somebody presses Stop. Cancelling still
  // has to complete, and a guess about what is still running is worse than saying nothing.
  it('says only what it knows when the computer did not answer', () => {
    expect(cancelConfirmation()).toBe('Task cancelled by user');
    expect(cancelConfirmation('')).toBe('Task cancelled by user');
  });
});

/*
 * The one field on an approval row that outlives the turn.
 *
 * `approvals.origin` has been a column, a store parameter and a projection in the route since the
 * table was created, and nothing has ever written it: every row on every box carries NULL. The
 * reason to write it is stated in this file beside the taint transition - a repeat origin across
 * tasks is the strongest residual attack in this design, buying the ranking for a query the owner
 * will plausibly run - and a repeat is only visible if the origin is on the row somebody can look
 * back through.
 */
describe('where an approval was raised from', () => {
  const tainted = (...sources: string[]) => ({
    taint: { level: 'untrusted' as const, sources, sinceStep: 0 }
  });

  it('names the untrusted source that was in the turn when the card went up', () => {
    expect(approvalOrigin(tainted('https://evil.example'))).toBe('https://evil.example');
  });

  // The newest, not the first. The turn read eight ordinary sources and then the attacker's page,
  // and it is the arrival that raised the floor this card is standing on.
  it('names the newest source when the turn has read several', () => {
    expect(approvalOrigin(tainted('https://a.example', 'https://b.example'))).toBe(
      'https://b.example'
    );
  });

  // A clean turn has no origin, and saying so as an absence rather than as a string is what lets a
  // reader tell "raised while untrusted content was in the room" from "raised on the owner's own
  // work". A placeholder would make every row look equally suspicious, which is the same as making
  // none of them look suspicious.
  it('says nothing at all when nothing untrusted has entered the turn', () => {
    expect(approvalOrigin(undefined)).toBeUndefined();
    expect(approvalOrigin({})).toBeUndefined();
    expect(approvalOrigin(tainted())).toBeUndefined();
  });
});

describe('a turn that lost its undo point', () => {
  it('tells the owner only when the reason is theirs to clear', () => {
    // The runner's own refusal, verbatim, is what reaches the worker through the checkpoint call.
    expect(
      ownerFixableCheckpointFailure(
        'Checkpoint failed (507): {"error":{"message":"Host disk is too full to take an automatic checkpoint, so this turn cannot be rewound."}}'
      )
    ).toBe(true);
    expect(ownerFixableCheckpointFailure('EACCES: permission denied, mkdir')).toBe(false);
    expect(ownerFixableCheckpointFailure('workspace is not its own dataset')).toBe(false);
  });

  // The prose belongs to the runner and the runner may reword it whenever it likes. The code does
  // not, which is the whole reason it exists: a refusal that says so in a field survives being
  // rephrased, translated or shortened, and the sentence-matching below survives only by luck.
  it('reads the refusal code the runner sends rather than the sentence around it', () => {
    expect(
      ownerFixableCheckpointFailure('Something the runner will reword next release', {
        code: HOST_DISK_FULL_CHECKPOINT_CODE
      })
    ).toBe(true);
    expect(
      ownerFixableCheckpointFailure(
        `Checkpoint failed (507): {"error":{"code":"${HOST_DISK_FULL_CHECKPOINT_CODE}","message":"There is not enough room."}}`
      )
    ).toBe(true);
  });

  // `runner_request_failed` is the runner's generic code, carried by every refusal that is not one
  // of the two it names specially. Treating a generic code as owner-fixable would put the loudest
  // card in the transcript in front of somebody who can do nothing at all about it.
  it('does not read the runner’s generic failure code as something the owner can clear', () => {
    expect(
      ownerFixableCheckpointFailure(
        'Checkpoint failed (400): {"error":{"code":"runner_request_failed","message":"workspace is not its own dataset"}}',
        { code: 'runner_request_failed' }
      )
    ).toBe(false);
  });

  // The regex stays underneath, because the code only exists in the runner from this release on and
  // a worker is routinely a version ahead of the box it is talking to.
  it('still reads the sentence when the refusal carries no code at all', () => {
    expect(ownerFixableCheckpointFailure('No space left on device')).toBe(true);
  });

  /*
   * The second owner-fixable refusal, and the one the sentence-matching never reached.
   *
   * A workspace over the runner's file ceiling - two `node_modules` trees is enough - loses every
   * automatic undo point from then on, and the refusal names no disk, no space and no quota, so
   * nothing in the regex above can see it. Until this code was in the set, the rewind dialog told
   * the owner the turn "changed nothing on the computer" about turns that changed a great deal.
   *
   * Asserted from both directions on purpose: the code is admitted, and the sentence on its own
   * still is not - which is what says the code is doing the work rather than a lucky word.
   */
  it('raises the workspace the runner will not checkpoint, on the code and not on the prose', () => {
    const refusal =
      'This workspace holds more than 250000 files, which is more than automatic checkpoints cover. Take a named recovery point instead.';
    expect(
      ownerFixableCheckpointFailure(refusal, { code: WORKSPACE_TOO_LARGE_CHECKPOINT_CODE })
    ).toBe(true);
    expect(
      ownerFixableCheckpointFailure(
        `Checkpoint failed (413): {"error":{"code":"${WORKSPACE_TOO_LARGE_CHECKPOINT_CODE}","message":"${refusal}"}}`
      )
    ).toBe(true);
    expect(ownerFixableCheckpointFailure(refusal)).toBe(false);
  });
});

/*
 * Replay-safe is not the same as left-nothing-behind, and reading one off the other is the defect
 * this block exists for.
 *
 * `code_diagnostics` is on `REPEATABLE_TOOLS` because a second `make -s` after a restart tells the
 * owner nothing new - which is true, and is why it stays there. `CHECKPOINT_EXEMPT_TOOLS` was
 * derived from that set wholesale, so the tool that runs a project's build and test recipe was
 * also the tool the turn took no undo point for. A turn of nothing but diagnostics could not be
 * rewound at all.
 *
 * Measured on this machine, not inferred: `make -s` on a Makefile whose default target writes a
 * file wrote it; `cargo check --message-format short` left 50 new paths on a crate with a writing
 * `build.rs`, and still left 16 - `Cargo.lock` and `target/` - on a crate with no `build.rs` at
 * all. Two of the six languages the removed approval card called safe write too: `python3 -I -m
 * compileall` leaves `__pycache__`, and `tsc --noEmit` under `incremental` leaves a
 * `.tsbuildinfo`. So the bound is the tool, in every language, and not a list of nine.
 *
 * This is the bound that replaced that card. An approval card is a question the owner can tap
 * through and a rephrasing can walk around - the same nine recipes through `shell` never asked at
 * all. An undo point is neither.
 */
describe('the undo point a diagnostic no longer escapes', () => {
  it('is taken for a tool that is safe to replay and still writes to the tree', () => {
    expect(REPEATABLE_TOOLS.has('code_diagnostics')).toBe(true);
    expect(REPEATABLE_TOOLS_THAT_WRITE.has('code_diagnostics')).toBe(true);
    expect(CHECKPOINT_EXEMPT_TOOLS.has('code_diagnostics')).toBe(false);
  });

  /*
   * The other direction, and the reason this is not simply "exempt fewer things". The exempt set
   * has to keep covering the reads, or every `file_read` starts walking the tree for a checkpoint
   * of nothing - which is how a bound stops being free and starts being a cost somebody removes.
   */
  it('still costs an ordinary read nothing at all', () => {
    for (const name of ['file_read', 'code_search', 'repo_overview', 'web_search', 'files_list'])
      expect(CHECKPOINT_EXEMPT_TOOLS.has(name), name).toBe(true);
    for (const name of ['finish', 'compact_context', 'notify', 'project_update'])
      expect(CHECKPOINT_EXEMPT_TOOLS.has(name), name).toBe(true);
  });

  /*
   * And the direction that matters most: the writers were never exempt and must not become so.
   */
  it('was already taken for everything that obviously changes the computer', () => {
    for (const name of ['shell', 'file_write', 'file_patch', 'browser_action', 'desktop_launch'])
      expect(CHECKPOINT_EXEMPT_TOOLS.has(name), name).toBe(false);
  });
});

describe('the reads a batch may run at the same time', () => {
  const read = (id: string, path: string): ModelToolCall => ({
    id,
    name: 'file_read',
    arguments: { path }
  });

  it('leaves out the members that write, and the one whose approval verdict moves', () => {
    for (const name of ['file_read', 'code_search', 'repo_overview', 'web_search'])
      expect(PARALLEL_SAFE_TOOLS.has(name)).toBe(true);
    // The two writers. A plan published beside the read that decides its next step is a plan
    // nobody chose.
    expect(PARALLEL_SAFE_TOOLS.has('set_plan')).toBe(false);
    expect(PARALLEL_SAFE_TOOLS.has('set_acceptance')).toBe(false);
    // The third writer, and the one that hid in here for years because it only ever reads back.
    // Two `make -s` runs over one tree race for the targets they both build.
    expect(PARALLEL_SAFE_TOOLS.has('code_diagnostics')).toBe(false);
    // The exfiltration floor's per-turn novelty budget is charged when a result is recorded, so two
    // web reads judged against the same spent total can jointly pass a bound that would have
    // carded the second. Replay safety does not imply that, which is why this set is not simply
    // inherited from the replay-safety one.
    expect(PARALLEL_SAFE_TOOLS.has('parallel_web_read')).toBe(false);
    // And nothing that changes the computer ever gets in.
    for (const name of ['shell', 'file_write', 'browser_action', 'publish_artifact', 'finish'])
      expect(PARALLEL_SAFE_TOOLS.has(name)).toBe(false);
  });

  it('takes the maximal run and stops at the first call that is not one of them', () => {
    const calls = [
      read('a', 'workspace/a.txt'),
      { id: 'b', name: 'code_search', arguments: { query: 'handler' } },
      { id: 'c', name: 'file_write', arguments: { path: 'workspace/c.txt', content: 'x' } },
      read('d', 'workspace/d.txt')
    ];
    expect(parallelToolRun(calls, 0)).toBe(2);
    // The writer itself is never a run, so the caller falls through to the ordinary path.
    expect(parallelToolRun(calls, 2)).toBe(0);
    expect(parallelToolRun(calls, 3)).toBe(1);
  });

  it('never runs more than the cap at once, and runs the rest behind them', () => {
    const calls = Array.from({ length: MAX_PARALLEL_TOOL_CALLS + 3 }, (_, index) =>
      read(`call-${index}`, `workspace/${index}.txt`)
    );
    expect(parallelToolRun(calls, 0)).toBe(MAX_PARALLEL_TOOL_CALLS);
    expect(parallelToolRun(calls, MAX_PARALLEL_TOOL_CALLS)).toBe(3);
  });

  it('ends in front of a call the loop answers instead of running', () => {
    // Cut off mid-JSON at the output cap: it is answered with the message that says so, and that
    // message has to keep its place in the declared order.
    expect(
      parallelToolRun([read('a', 'workspace/a.txt'), { ...read('b', ''), parseFailed: true }], 0)
    ).toBe(1);
    // An exact repeat of a read this turn already answered, whether the earlier one was in a
    // previous batch or in this one.
    expect(
      parallelToolRun([read('a', 'workspace/a.txt'), read('b', 'workspace/b.txt')], 0, {
        'file_read:{"path":"workspace/b.txt"}': 'call-earlier'
      })
    ).toBe(1);
    expect(
      parallelToolRun(
        [read('a', 'workspace/a.txt'), read('b', 'workspace/a.txt'), read('c', 'workspace/c.txt')],
        0
      )
    ).toBe(1);
  });
});

/**
 * The turn that started this whole watch, and the three guards that could all see it happening and
 * none of which could say so.
 *
 * Measured on the owner's box: a byte-identical `set_plan` twelve times running. `set_plan` is not
 * in `LOOP_ANSWERED_TOOLS`, so every one of those steps started a tool and zeroed the idle count.
 * Every one of them succeeded, so the failure counter never saw one. And the prose around each call
 * was different every time, so the repetition watch in `streaming.ts` had nothing to match. Only the
 * step budget stopped it, at up to a hundred and twenty steps.
 *
 * The first three tests below are the negative controls, and they are the reason this describe block
 * is worth its length: each one asserts that an existing guard does *not* fire on the incident. If
 * one of them ever starts failing, the guard it names has grown teeth and this one may be able to
 * shrink.
 */
describe('a turn that stopped changing', () => {
  /**
   * The record the loop keeps of what actually ran, as `recordToolResult` writes it. The guard reads
   * it rather than sniffing the tool result's text, because `success` is the one field that already
   * tells a tool that ran apart from a call the harness answered and a call that threw.
   */
  const ran = (messages: readonly ModelMessage[]): Record<string, { success: boolean }> =>
    Object.fromEntries(
      messages
        .flatMap((message) => message.toolCalls ?? [])
        .map((call) => [call.id, { success: true }] as const)
    );

  const planArgs = {
    branchName: 'Main',
    steps: [
      { title: 'Read the brief', status: 'completed' },
      { title: 'Draft the importer', status: 'in_progress' }
    ]
  };

  /**
   * The window the incident wrote, at `repeats` steps.
   *
   * The result is the real one: `executePlanTool` answers `set_plan` with `{version, steps}` and the
   * version rises on every publish. That detail is the trap this guard had to be built around, and
   * the test below named for it holds the shape in place.
   */
  const planSpiral = (
    repeats: number,
    prose = (at: number): string => `Refining the plan (${at}).`
  ) =>
    Array.from({ length: repeats }, (_, at) => at).flatMap((at): ModelMessage[] => [
      {
        role: 'assistant',
        content: prose(at),
        toolCalls: [{ id: `call-${at}`, name: 'set_plan', arguments: planArgs }]
      },
      {
        role: 'tool',
        toolCallId: `call-${at}`,
        content: JSON.stringify({ version: at + 1, steps: planArgs.steps })
      }
    ]);

  it('is invisible to the idle guard, because every one of those steps started a tool', () => {
    let idle = 0;
    for (let step = 0; step < 12; step += 1) {
      const next = idleStepsAfter(idle, { proposed: ['set_plan'], started: 1 });
      idle = next ?? idle;
    }
    expect(idle).toBe(0);
    expect(idle).toBeLessThan(MAX_IDLE_STEPS);
  });

  it('is invisible to the failure guard, because every one of those calls succeeded', () => {
    let failures: Record<string, number> | undefined;
    for (let step = 0; step < 12; step += 1)
      failures = repeatedFailuresAfter(failures, {
        call: failingCallKey({ name: 'set_plan', arguments: planArgs }),
        failure: null
      });
    expect(repeatedFailureRise(undefined, failures)).toBeNull();
  });

  it('is invisible to the repetition watch, because the prose differs every time', () => {
    const spoken = planSpiral(12)
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
      .join('\n\n');
    expect(degenerateRepeat(spoken)).toBe('');
  });

  it('sees the incident, and reaches the stop', () => {
    const run = stationaryStepRun(planSpiral(12), ran(planSpiral(12)));
    expect(run?.tools).toEqual(['set_plan']);
    expect(run?.limit).toBe(MAX_STATIONARY_STEPS);
    expect(run?.steps).toBeGreaterThanOrEqual(stationaryStepsBeforeStop(MAX_STATIONARY_STEPS));
  });

  /**
   * The trap, held open on purpose.
   *
   * The obvious build of this guard hashes the *(call, result)* pair for every tool, which is §4.4
   * #53 read on its own. `set_plan` answers with the version it just created, so on the one incident
   * the guard exists for the pairs are all different and the guard is silent. That is why the
   * bookkeeping tier ignores the result, and this test is what stops somebody restoring the
   * "obvious" version later: it asserts that the pairs really do differ, so the reader can see that
   * the tier is load-bearing rather than decorative.
   */
  it('does not key the bookkeeping tier on the result, because the receipt differs every time', () => {
    const withReceipts = [1, 2].map((version) =>
      stepSignature([
        {
          name: 'set_plan',
          arguments: planArgs,
          result: JSON.stringify({ version, steps: planArgs.steps })
        }
      ])
    );
    expect(withReceipts[0]).not.toBe(withReceipts[1]);
    // And the signature the guard actually uses, which does not read the receipt, is the same one.
    expect(stepSignature([{ name: 'set_plan', arguments: planArgs }])).toBe(
      stepSignature([{ name: 'set_plan', arguments: planArgs }])
    );
  });

  it('holds a run open across a step that only spoke', () => {
    const spiral = planSpiral(3);
    const withAnAside: ModelMessage[] = [
      ...spiral.slice(0, 4),
      { role: 'assistant', content: 'Let me reconsider the second step before I go on.' },
      ...spiral.slice(4)
    ];
    expect(stationaryStepRun(withAnAside, ran(withAnAside))?.steps).toBe(3);
  });

  it('breaks the run on the step that finally does something else', () => {
    const moved: ModelMessage[] = [
      ...planSpiral(5),
      {
        role: 'assistant',
        content: 'Writing it.',
        toolCalls: [{ id: 'call-w', name: 'file_write', arguments: { path: 'a.ts', content: 'x' } }]
      },
      { role: 'tool', toolCallId: 'call-w', content: '{"ok":true}' }
    ];
    expect(stationaryStepRun(moved, ran(moved))).toBeNull();
  });

  it('says nothing about a healthy turn, or about a step that started nothing', () => {
    expect(stationaryStepRun(planSpiral(1), ran(planSpiral(1)))).toBeNull();
    expect(
      stationaryStepRun(
        [
          { role: 'user', content: 'tidy the notes' },
          { role: 'assistant', content: 'Here is what I found.' }
        ],
        {}
      )
    ).toBeNull();
  });

  /**
   * The acting tier's whole safety property, stated as the pair of cases it has to tell apart.
   *
   * `process` and `shell` are how the model is told to watch a build, and `browser_snapshot` and
   * `desktop_observe` take no arguments at all so every call looks identical. Every one of those is
   * a legitimate repeat, and every one of them produces a different report - which is why the acting
   * tier folds the report in and therefore never sees them.
   */
  const shellRun = (outputs: readonly string[]): ModelMessage[] =>
    outputs.flatMap((output, at) => [
      {
        role: 'assistant' as const,
        content: 'Checking.',
        toolCalls: [{ id: `sh-${at}`, name: 'shell', arguments: { command: 'pnpm test' } }]
      },
      { role: 'tool' as const, toolCallId: `sh-${at}`, content: output }
    ]);

  it('permits a poll whose report keeps changing', () => {
    const polled = shellRun(['12 passed', '13 passed', '14 passed', '15 passed']);
    expect(stationaryStepRun(polled, ran(polled))).toBeNull();
  });

  /**
   * And counts the shape `MAX_REPEATED_FAILURES` says outright that it cannot see: a command with a
   * non-zero exit is a tool *result*, not a throw, so a suite re-run twenty times reaches no counter
   * in that file at all.
   */
  it('counts a command that keeps returning the identical failure', () => {
    const stuck = shellRun(Array.from({ length: 8 }, () => 'exit 1: 3 tests failed'));
    const run = stationaryStepRun(stuck, ran(stuck));
    expect(run?.limit).toBe(MAX_STATIONARY_ACTING_STEPS);
    expect(run?.steps).toBeGreaterThanOrEqual(
      stationaryStepsBeforeStop(MAX_STATIONARY_ACTING_STEPS)
    );
    // Which is a count no other guard in this file reaches on that window.
    expect(repeatedFailureRise(undefined, undefined)).toBeNull();
  });

  it('gives a step that touched the computer the looser tier, even beside a bookkeeping call', () => {
    const mixed = Array.from({ length: 3 }, (_, at) => at).flatMap((at): ModelMessage[] => [
      {
        role: 'assistant',
        content: 'Both.',
        toolCalls: [
          { id: `p-${at}`, name: 'set_plan', arguments: planArgs },
          { id: `r-${at}`, name: 'file_read', arguments: { path: 'a.ts' } }
        ]
      },
      { role: 'tool', toolCallId: `p-${at}`, content: JSON.stringify({ version: at + 1 }) },
      { role: 'tool', toolCallId: `r-${at}`, content: 'export const a = 1;' }
    ]);
    // Three identical acting steps is under the acting tier's limit, and the plan receipt that rises
    // each time is what keeps them apart at all - so this is below the bar rather than at it.
    expect(stationaryStepRun(mixed, ran(mixed))).toBeNull();
  });

  it('matches a result to the step that asked for it, even when ids repeat across steps', () => {
    // A scripted route that reuses one id: a single map over the window would answer every step with
    // the newest result and make four identical steps look like four different ones.
    const reused: ModelMessage[] = Array.from({ length: 8 }, (_, at) => at).flatMap(() => [
      {
        role: 'assistant' as const,
        content: 'again',
        toolCalls: [{ id: 'call-1', name: 'shell', arguments: { command: 'ls' } }]
      },
      { role: 'tool' as const, toolCallId: 'call-1', content: 'a.ts\nb.ts' }
    ]);
    expect(stationaryStepRun(reused, ran(reused))?.steps).toBeGreaterThanOrEqual(
      stationaryStepsBeforeStop(MAX_STATIONARY_ACTING_STEPS)
    );
  });

  /**
   * The clause the eval rig bought, and the two guards it hands those runs back to.
   *
   * Without it this fired a second time on the two fixtures that belong to the guards beside it -
   * `deliberation-that-ignores-the-break-is-stopped` and
   * `the-same-call-failing-the-same-way-is-stopped` - and cost each of them two extra model calls
   * restating a sentence the model had already been given, one step later and in worse words.
   */
  it('leaves a run of calls that threw to the failure guard', () => {
    const threw = shellRun(Array.from({ length: 8 }, () => 'Tool failed: connection refused'));
    const nothingRan = Object.fromEntries(
      threw
        .flatMap((message) => message.toolCalls ?? [])
        .map((call) => [call.id, { success: false }] as const)
    );
    expect(stationaryStepRun(threw, nothingRan)).toBeNull();
    // And the failure guard does see it, which is what makes handing it over rather than
    // double-reporting it the right thing to do.
    let failures: Record<string, number> | undefined;
    const call = { name: 'shell', arguments: { command: 'pnpm test' } };
    for (let attempt = 0; attempt < 8; attempt += 1)
      failures = repeatedFailuresAfter(failures, {
        call: failingCallKey(call),
        failure: repeatedFailureKey(call, new Error('connection refused'))
      });
    expect(repeatedFailureRise(undefined, failures)?.count).toBeGreaterThanOrEqual(
      REPEATED_FAILURES_BEFORE_STOP
    );
  });

  it('leaves a run the harness answered without running to the idle guard', () => {
    const answered = shellRun(
      Array.from({ length: 8 }, () => '{"skipped":true,"reason":"the same call as call-0"}')
    );
    const nothingRan = Object.fromEntries(
      answered
        .flatMap((message) => message.toolCalls ?? [])
        .map((call) => [call.id, { success: false }] as const)
    );
    expect(stationaryStepRun(answered, nothingRan)).toBeNull();
    // The idle guard does see it: a call the loop answers instead of running starts nothing.
    let idle = 0;
    for (let step = 0; step < 8; step += 1)
      idle = idleStepsAfter(idle, { proposed: ['shell'], started: 0 }) ?? idle;
    expect(idle).toBeGreaterThanOrEqual(IDLE_STEPS_BEFORE_STOP);
  });

  it('reads the same action through a different spelling of it', () => {
    const one = stepSignature([
      { name: 'file_read', arguments: { path: 'a.ts', lines: 40 } },
      { name: 'file_read', arguments: { path: 'b.ts', lines: 40 } }
    ]);
    // The same two reads proposed in the other order, with the argument keys in the other order.
    const other = stepSignature([
      { name: 'file_read', arguments: { lines: 40, path: 'b.ts' } },
      { name: 'file_read', arguments: { lines: 40, path: 'a.ts' } }
    ]);
    expect(other).toBe(one);
  });

  it('keeps array order, because the order of a plan is the plan', () => {
    const forwards = stepSignature([{ name: 'set_plan', arguments: { steps: ['read', 'write'] } }]);
    const backwards = stepSignature([
      { name: 'set_plan', arguments: { steps: ['write', 'read'] } }
    ]);
    expect(backwards).not.toBe(forwards);
  });

  it('cannot have its field boundary forged by an argument', () => {
    // Two steps that are only the same step if the rendering lets a value spill across a separator.
    expect(
      stepSignature([{ name: 'shell', arguments: { command: 'ls' }, result: 'out' }])
    ).not.toBe(stepSignature([{ name: 'shell', arguments: { command: 'ls', x: 'out' } }]));
  });

  it('names the repeated call in the sentence the model is given, and says which tier it is', () => {
    expect(stationaryStepBreak(6, ['set_plan'])).toContain('NOTHING HAS CHANGED FOR 6 STEPS');
    expect(stationaryStepBreak(6, ['set_plan'])).toContain('set_plan');
    expect(stationaryStepBreak(6, ['set_plan'])).not.toContain('identical result');
    expect(stationaryStepBreak(8, ['shell'])).toContain('identical result');
  });

  /** Published so the eval harness and the loop cannot start meaning different things by it. */
  it('publishes its marker, and it is neither a prefix of the idle break nor prefixed by it', () => {
    const marker = PUSHBACK_MARKERS.find(([name]) => name === 'stationary_stop')?.[1];
    expect(marker).toBeTruthy();
    expect(stationaryStepBreak(6, ['set_plan']).startsWith(marker ?? 'x')).toBe(true);
    const idle = PUSHBACK_MARKERS.find(([name]) => name === 'idle_break')?.[1] ?? '';
    expect(marker?.startsWith(idle)).toBe(false);
    expect(idle.startsWith(marker ?? 'x')).toBe(false);
  });

  /**
   * The three tools taken out of the bookkeeping tier, and why the subtraction is not arbitrary:
   * each already carries a per-turn ceiling at or below this guard's, so counting them here would
   * only restate a sentence the model already has, one step later and in worse words.
   */
  it('leaves the tools that already have a ceiling of their own to those ceilings', () => {
    expect(BOOKKEEPING_TOOLS.has('set_plan')).toBe(true);
    expect(BOOKKEEPING_TOOLS.has('set_acceptance')).toBe(true);
    for (const owned of ['ask', 'notify']) expect(BOOKKEEPING_TOOLS.has(owned)).toBe(false);
    expect(Math.min(MAX_QUESTIONS_PER_TURN, MAX_NOTICES_PER_TURN)).toBeLessThan(
      MAX_STATIONARY_STEPS
    );
  });
});

/**
 * The payload that would not parse, and the three costs of answering it in the real history.
 *
 * A response cut off mid-JSON at the output cap is answered rather than dropped, because a tool call
 * with no tool result is a malformed turn the provider refuses on the next step. What was never
 * done was taking the unparseable bytes back out: `rawArguments` carries the whole of a half-written
 * file, and it is undeclared on `ModelMessage.toolCalls`, so the compiler could not see it and
 * nothing between the push and the encrypted write ever dropped it.
 */
describe('the payload that would not parse', () => {
  /** The shape the adapter actually pushes: three declared fields and three undeclared ones. */
  const truncated = (bytes: number): ModelMessage[] => [
    { role: 'user', content: 'write the importer' },
    {
      role: 'assistant',
      content: 'Writing it now.',
      toolCalls: [
        {
          id: 'call-1',
          name: 'file_write',
          arguments: {},
          parseFailed: true,
          argumentsTruncated: true,
          rawArguments: `{"path":"workspace/importer.py","content":"${'x'.repeat(bytes)}`
        } as ModelMessage['toolCalls'] extends (infer T)[] | undefined ? T : never
      ]
    },
    {
      role: 'tool',
      toolCallId: 'call-1',
      content: 'The arguments for file_write were cut off at the model output limit.'
    }
  ];

  it('takes the unparseable bytes out and reports how many there were', () => {
    const messages = truncated(40_000);
    const dropped = tombstoneMalformedCall(messages, 'call-1');
    expect(dropped).toBeGreaterThan(40_000);
    expect(JSON.stringify(messages)).not.toContain('xxxxxxxxxx');
    expect(JSON.stringify(messages)).not.toContain('rawArguments');
    expect(JSON.stringify(messages)).not.toContain('parseFailed');
  });

  it('leaves the call standing, so the turn is still a shape a provider will take', () => {
    const messages = truncated(2_000);
    tombstoneMalformedCall(messages, 'call-1');
    const call = messages.find((message) => message.role === 'assistant')?.toolCalls?.[0];
    expect(call).toEqual({ id: 'call-1', name: 'file_write', arguments: {} });
    // Every tool call in the window still has a result, which is the property the whole branch
    // exists to preserve.
    const answered = new Set(
      messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId)
    );
    for (const message of messages)
      for (const proposed of message.toolCalls ?? []) expect(answered.has(proposed.id)).toBe(true);
  });

  /**
   * The cost nobody had named, and the reason this is worth doing rather than merely tidy.
   *
   * `estimatedTokens` in context.ts sizes an assistant message with
   * `JSON.stringify(message.toolCalls).length`, and that walks `rawArguments`. The adapter sends
   * none of it - `openai-compatible.ts` serialises `id`, `name` and `JSON.stringify(arguments)`, and
   * `arguments` is `{}` on this path - so one cut-off write charged the window thousands of tokens
   * that no provider would ever see, and the compaction trigger is derived from that number. The
   * turn condensed away real history to make room for bytes that do not exist on the wire.
   */
  it('stops the window being sized from bytes the wire never carries', () => {
    const messages = truncated(40_000);
    const assistant = messages.find((message) => message.role === 'assistant');
    const measured = (): number => JSON.stringify(assistant?.toolCalls).length;
    const before = measured();
    // Four thousand tokens on the estimator's own characters-over-four, against a request that
    // carries the two-character string "{}".
    expect(Math.ceil(before / 4)).toBeGreaterThan(4_000);
    tombstoneMalformedCall(messages, 'call-1');
    expect(measured()).toBeLessThan(before / 100);
  });

  it('changes nothing when the id belongs to no call in the window', () => {
    const messages = truncated(100);
    const before = JSON.stringify(messages);
    expect(tombstoneMalformedCall(messages, 'call-elsewhere')).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
