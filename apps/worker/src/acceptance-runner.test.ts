/**
 * The suite bound, at the seam rather than through a whole turn.
 *
 * #22 has two mechanisms and only one of them was ever watched. The early return - "the suite ran
 * out of time" - is asserted by one case in `agent-run.test.ts`, which drives a real `AgentWorker`
 * over eight wedged checks. The other half is the per-check clamp: `Math.min(..., remainingSeconds)`
 * on the timeout handed to the runner. Replacing `remainingSeconds` in that expression with
 * `Number.MAX_SAFE_INTEGER` left the entire worker suite green, twice, in two different hands - so
 * the half of the bound that stops a check *starting* inside the deadline and *finishing* outside it
 * was carried by nothing at all.
 *
 * That is the case this file is for, and it is why the tests are written against `acceptanceChecks`
 * directly. The number the clamp decides is an argument in a request body; a turn-level test can
 * only see it by reaching into the runner traffic, and the arithmetic that produces it - one clock
 * for the suite, read from the wall - is worth being able to interrogate a second at a time.
 */
import type { DataStore, TaskRecord } from '@garden/data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcceptanceCheck, AcceptanceRecord } from './acceptance.js';
import { commandFingerprint } from './acceptance.js';
import {
  ACCEPTANCE_SUITE_DEADLINE_SECONDS,
  acceptanceChecks,
  runAcceptanceChecks,
  type AcceptanceRunnerDeps
} from './acceptance-runner.js';
import type { AgentState } from './agent-state.js';
import type { AgentRunnerClient } from './runner-client.js';

const key = new Uint8Array(32).fill(7);
const task = {
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '33333333-3333-4333-8333-333333333333'
} as unknown as TaskRecord;

/** One `exec` request as the runner received it, in order. */
interface RunnerCall {
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
  /** The wall clock when the request was made, which is when the check starts running. */
  readonly startedAt: number;
}

interface Probe {
  readonly deps: AcceptanceRunnerDeps;
  readonly calls: RunnerCall[];
  readonly events: Array<{ kind: string }>;
  /** How far the clock moves while each `exec` is being served, in seconds. */
  spend: number;
}

/**
 * The runner, the store and the two wrappers, with a clock that only moves when a command runs.
 *
 * `spend` is what makes the arithmetic legible: the suite's deadline is read from the wall clock, so
 * a test that wants a check to start one second before it has to be able to say so exactly. Fake
 * timers rather than a stub clock because `acceptance-runner.ts` reads `Date.now()` itself, which is
 * the reading the bound is made of - a test that injected its own clock would be measuring a
 * different program.
 */
const probe = (
  exec: (body: Record<string, unknown>) => unknown = () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false
  })
): Probe => {
  const calls: RunnerCall[] = [];
  const events: Array<{ kind: string }> = [];
  const state: Probe = {
    calls,
    events,
    spend: 0,
    deps: {
      store: {
        appendTaskEvent: async (input: { kind: string }) => {
          events.push({ kind: input.kind });
          return { id: 'event' };
        }
      } as unknown as DataStore,
      runner: {
        call: async (
          _workspaceId: string,
          _taskId: string,
          _scope: string | string[],
          path: string,
          body?: unknown
        ) => {
          calls.push({
            path,
            body: body as Record<string, unknown> | undefined,
            startedAt: Date.now()
          });
          if (state.spend > 0) vi.setSystemTime(Date.now() + state.spend * 1_000);
          return exec((body ?? {}) as Record<string, unknown>);
        }
      } as unknown as AgentRunnerClient,
      withLeaseRenewal: async (_task, operation) => operation(),
      withCancellationWatch: async (_task, operation) => operation()
    }
  };
  return state;
};

const command = (
  id: string,
  overrides: Partial<Extract<AcceptanceCheck, { kind: 'command' }>> = {}
): AcceptanceCheck => ({
  id,
  kind: 'command',
  label: `suite part ${id}`,
  executable: 'pytest',
  args: [`--shard=${id}`],
  cwd: 'workspace',
  expectExit: 0,
  timeoutSeconds: 900,
  ...overrides
});

const record = (...checks: AcceptanceCheck[]): AcceptanceRecord => ({
  checks,
  revisions: 1,
  declaredAtStep: 0
});

/** The `timeoutSeconds` each `exec` was actually asked for, in order. */
const timeouts = (probed: Probe): unknown[] =>
  probed.calls
    .filter((call) => call.path.endsWith('/exec'))
    .map((call) => call.body?.timeoutSeconds);

/**
 * The latest instant each check could still be running, as seconds from when the suite opened.
 *
 * This is the whole of what the clamp decides, and it is the only reading that catches the mutant:
 * a check granted more seconds than the suite has left is a check that starts inside the deadline
 * and finishes outside it, which is exactly the 1,799 seconds #22 exists to refuse.
 */
const worstCaseFinishSeconds = (probed: Probe, openedAt: number): number[] =>
  probed.calls
    .filter((call) => call.path.endsWith('/exec'))
    .map((call) => (call.startedAt - openedAt) / 1_000 + Number(call.body?.timeoutSeconds));

afterEach(() => {
  vi.useRealTimers();
});

describe('the acceptance suite deadline', () => {
  /**
   * The clamp, measured on the check that starts inside the deadline and would end outside it.
   *
   * This is the shape the mutant survives: the suite has one second left, the last check declares
   * the full per-check ceiling, and the early return does not fire because the suite is not out of
   * time - it has a second. Without the clamp that check is handed 900 seconds, so the suite spends
   * 899 + 900 = 1,799 seconds, which is most of the way back to the two hours #22 exists to prevent.
   */
  it('hands the last check only the seconds the suite has left, not the seconds it asked for', async () => {
    vi.useFakeTimers();
    const probed = probe();
    probed.spend = ACCEPTANCE_SUITE_DEADLINE_SECONDS - 1;
    const started = Date.now();

    const results = await acceptanceChecks(
      probed.deps,
      task,
      key,
      record(command('a'), command('b')),
      {
        purpose: 'finish'
      }
    );

    // Both checks ran: the second one started with a second to spare, so the early-return arm is
    // deliberately not what is being measured here.
    expect(timeouts(probed)).toHaveLength(2);
    expect(timeouts(probed)[0]).toBe(900);
    // One second left, so one second is what the check may have - however long it asked for.
    expect(timeouts(probed)[1]).toBe(1);
    // Stated as the bound rather than as the number, because the number is only interesting for
    // what it prevents: 899 + 1, not 899 + 900.
    expect(worstCaseFinishSeconds(probed, started)).toEqual([900, 900]);
    for (const finish of worstCaseFinishSeconds(probed, started))
      expect(finish).toBeLessThanOrEqual(ACCEPTANCE_SUITE_DEADLINE_SECONDS);
    expect(results).toHaveLength(2);
  });

  /**
   * The clamp is a ceiling and not a floor: it must never lengthen a check.
   *
   * Written because the cheapest wrong fix is a `Math.max`, and because a clamp that raised a
   * 30-second smoke test to 900 because the suite had the room would be the composition #22 is
   * about, arriving from the other direction.
   */
  it('leaves a check that asked for less than the suite has alone', async () => {
    vi.useFakeTimers();
    const probed = probe();

    await acceptanceChecks(probed.deps, task, key, record(command('a', { timeoutSeconds: 30 })), {
      purpose: 'finish'
    });

    expect(timeouts(probed)).toEqual([30]);
  });

  /**
   * The other half of #22, held here beside the half it composes with.
   *
   * `agent-run.test.ts` proves this through a whole turn, which is the right place to prove that
   * the loop reaches it. This is the same statement at the seam, and it is what makes the two arms
   * comparable: out of time refuses, nearly out of time clamps.
   */
  it('refuses a check that starts after the deadline instead of clamping it to nothing', async () => {
    vi.useFakeTimers();
    const probed = probe();
    probed.spend = ACCEPTANCE_SUITE_DEADLINE_SECONDS;

    const results = await acceptanceChecks(
      probed.deps,
      task,
      key,
      record(command('a'), command('b')),
      { purpose: 'finish' }
    );

    expect(timeouts(probed)).toEqual([900]);
    expect(results[1]?.passed).toBe(false);
    expect(results[1]?.detail).toContain('the acceptance suite ran out of time');
    expect(results[1]?.detail).toContain(`${ACCEPTANCE_SUITE_DEADLINE_SECONDS}s`);
  });

  /**
   * A suite that is out of time can still say what it already knows.
   *
   * The free answer is asked before the deadline, deliberately, and the comment in the file says so.
   * Without this test the two could be reordered - which would cost nothing at runtime and turn a
   * command garden already watched pass into "the suite ran out of time".
   */
  it('still answers from what garden already ran after the deadline has passed', async () => {
    vi.useFakeTimers();
    const probed = probe();
    probed.spend = ACCEPTANCE_SUITE_DEADLINE_SECONDS;
    const check = command('b');
    const observed = new Map([
      [commandFingerprint({ executable: 'pytest', args: ['--shard=b'], cwd: 'workspace' }), 0]
    ]);

    const results = await acceptanceChecks(probed.deps, task, key, record(command('a'), check), {
      purpose: 'finish',
      observed
    });

    expect(results[1]?.passed).toBe(true);
    expect(results[1]?.detail).toContain('after the last change');
    // And nothing was run for it: the answer cost no command at all.
    expect(timeouts(probed)).toEqual([900]);
  });

  /**
   * The deadline is one clock for the suite, not one per check.
   *
   * Eight checks at the per-check ceiling is what composed into two hours. Measured at the seam the
   * statement is arithmetic rather than a wait: whatever the record declares, the timeouts the
   * runner is handed sum to no more than the suite deadline plus the first check's own ceiling -
   * the one check that is entitled to spend the whole budget.
   */
  it('cannot hand out more than the deadline across a full-sized record', async () => {
    vi.useFakeTimers();
    const probed = probe();
    // Each check burns a slice: eight of them at 200 seconds is 1,600, well past the deadline.
    probed.spend = 200;
    const checks = Array.from({ length: 8 }, (_, index) => command(String(index)));
    const started = Date.now();

    const results = await acceptanceChecks(probed.deps, task, key, record(...checks), {
      purpose: 'finish'
    });

    expect(results).toHaveLength(8);
    const granted = timeouts(probed).map((value) => Number(value));
    expect(granted.every((value) => Number.isSafeInteger(value) && value > 0)).toBe(true);
    // Not one of them, at any point in the suite, may be still running after the deadline.
    expect(worstCaseFinishSeconds(probed, started)).toEqual([900, 900, 900, 900, 900]);
    // Eight checks were declared; the ones that could not start inside the deadline are refused
    // rather than run, which is the arm this one composes with.
    expect(granted).toHaveLength(5);
    expect(results.filter((result) => !result.passed).length).toBeGreaterThan(0);
    expect(results.at(-1)?.detail).toContain('the acceptance suite ran out of time');
  });
});

describe('one run of the suite per state of the workspace', () => {
  const state = (overrides: Partial<AgentState> = {}): AgentState =>
    ({ messages: [], step: 3, credits: 0, ...overrides }) as AgentState;

  it('answers the second ask from the first run when nothing has changed', async () => {
    const probed = probe();
    const turn = state();

    const first = await runAcceptanceChecks(
      probed.deps,
      task,
      key,
      record(command('a')),
      { purpose: 'finish' },
      turn
    );
    const second = await runAcceptanceChecks(
      probed.deps,
      task,
      key,
      record(command('a')),
      { purpose: 'finish' },
      turn
    );

    expect(second).toBe(first);
    expect(timeouts(probed)).toHaveLength(1);
  });

  /**
   * A failing suite is re-run every time. The memo covers "passed, asked again, nothing happened in
   * between"; the point of the next finish after a failure is to find out whether it was fixed.
   */
  it('re-runs a suite that failed', async () => {
    const probed = probe(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'one test failed',
      durationMs: 1,
      timedOut: false
    }));
    const turn = state();

    await runAcceptanceChecks(
      probed.deps,
      task,
      key,
      record(command('a')),
      { purpose: 'finish' },
      turn
    );
    await runAcceptanceChecks(
      probed.deps,
      task,
      key,
      record(command('a')),
      { purpose: 'finish' },
      turn
    );

    expect(timeouts(probed)).toHaveLength(2);
  });

  /**
   * A tool call landing in the window throws the memo away, whatever it was.
   *
   * Stricter than the evidence floor on purpose: a non-mutating command can change what
   * `observedCommands` is able to answer without moving the floor at all.
   */
  it('re-runs once anything at all has been called in between', async () => {
    const probed = probe();
    const turn = state();

    await runAcceptanceChecks(
      probed.deps,
      task,
      key,
      record(command('a')),
      { purpose: 'finish' },
      turn
    );
    turn.turnToolResults = { 'call-1': { name: 'shell', success: true } };
    await runAcceptanceChecks(
      probed.deps,
      task,
      key,
      record(command('a')),
      { purpose: 'finish' },
      turn
    );

    expect(timeouts(probed)).toHaveLength(2);
  });
});

/**
 * Two facts about this suite that are open, held as tests so they cannot close in silence.
 *
 * Neither row asks for a behaviour. Each one pins a sentence written in `acceptance-runner.ts` that
 * says plainly what the harness does NOT do, so that the day somebody makes the sentence wrong the
 * row goes red and the comment is corrected rather than left lying. This programme has now found
 * seven saturated assertions; a comment nothing watches is the same failure one layer up.
 */
describe('what the acceptance suite openly does not do', () => {
  /**
   * The verifier runs in the agent's own box, and a check can be written by the turn that runs it.
   *
   * Not an aspiration: the suite posts to the identical endpoint, workspace id and `exec` scope that
   * the model's own `shell` tool reaches (apps/worker/src/tools/workspace.ts:743, `${root}/exec`
   * over `/v1/workspaces/${task.workspaceId}`), with nothing snapshotting the tree in between. So
   * `bash workspace/rename-scans.sh` - a declaration `acceptance.ts` pins as accepted - runs a
   * script this turn wrote. Isolation would mean a different endpoint against a copy the agent never
   * held, which is a wave of work nobody has done; until then this row is the evidence for the no.
   */
  it('runs the checks through the same exec endpoint the agent itself reaches', async () => {
    const probed = probe();

    await acceptanceChecks(probed.deps, task, key, record(command('a')), { purpose: 'finish' });

    expect(probed.calls.map((call) => call.path)).toEqual([
      `/v1/workspaces/${task.workspaceId}/exec`
    ]);
  });

  it('passes the absolute suite deadline to render verification', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const probed = probe((body) =>
      'executable' in body
        ? { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }
        : 'marginPoints' in body
          ? { passed: true, detail: 'renders as exactly 2 pages' }
          : { entries: [{ name: 'deck.pptx', type: 'file', sizeBytes: 40_000 }] }
    );
    const artifact = {
      id: 'art-1',
      kind: 'artifact',
      label: 'the deck is two slides',
      path: 'workspace/deck.pptx',
      minBytes: 20_000,
      render: { expectPages: 2, marginPoints: 0 }
    } as const satisfies AcceptanceCheck;

    const results = await acceptanceChecks(probed.deps, task, key, record(artifact), {
      purpose: 'finish'
    });

    expect(results[0]?.passed).toBe(true);
    const proof = probed.calls.find((call) => call.path.endsWith('/document/render-proof'));
    expect(proof, 'the render proof was asked for at all').toBeTruthy();
    expect(proof?.body).toMatchObject({
      deadlineAt: 1000 + ACCEPTANCE_SUITE_DEADLINE_SECONDS * 1000
    });
    clock.mockRestore();
  });
});
