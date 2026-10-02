import { describe, expect, it, vi } from 'vitest';
import type { DataStore, TaskRecord } from '@garden/data';
import type { AcceptanceRecord, AcceptanceResult } from '../acceptance.js';
import type { AgentState } from '../agent-state.js';
import type { AgentRunnerClient } from '../runner-client.js';
import { answerSummary, completeAnswer, type TurnCompleteDeps } from './complete.js';

const key = new Uint8Array(32).fill(3);
const task = { id: 'task-1', workspaceId: 'ws-1', userId: 'user-1' } as TaskRecord;
const record: AcceptanceRecord = {
  checks: [
    {
      id: 'check-1',
      kind: 'command',
      label: 'the tests pass',
      executable: 'pytest',
      args: ['-q'],
      cwd: 'workspace',
      expectExit: 0,
      timeoutSeconds: 300
    }
  ],
  revisions: 1,
  declaredAtStep: 0
};
const result = (passed: boolean): AcceptanceResult => ({
  id: 'check-1',
  label: 'the tests pass',
  passed,
  detail: passed ? 'exit 0' : 'exit 1: 2 failed',
  command: 'pytest -q'
});

const rig = (outcomes: boolean[] = []) => {
  const runs = [...outcomes];
  const deps = {
    runner: {} as AgentRunnerClient,
    store: {
      appendTaskEvent: vi.fn(async () => ({ id: 'event' })),
      listMediaJobs: vi.fn(async () => []),
      getLatestTaskPlan: vi.fn(async () => null),
      listCodingMissions: vi.fn(async () => [])
    } as unknown as DataStore,
    config: { PREVIEW_BASE_URL: 'https://garden.test/preview', WORKER_ID: 'worker' },
    outstandingPlanSteps: async () => [],
    runAcceptanceChecks: vi.fn<TurnCompleteDeps['runAcceptanceChecks']>(async () => [
      result(runs.shift() ?? true)
    ]),
    completeTurn: vi.fn<TurnCompleteDeps['completeTurn']>(async () => undefined)
  };
  return deps as unknown as TurnCompleteDeps & typeof deps;
};
const state = (over: Partial<AgentState> = {}): AgentState => ({
  messages: [],
  step: 2,
  credits: 0,
  ...over
});

describe('a reply without tool calls is the answer', () => {
  it('completes a plain answer with nothing to verify, quoting it whole', async () => {
    const deps = rig();
    const answer = 'A mutex has an owner. A semaphore has a count.';
    expect(await completeAnswer(deps, task, key, state(), answer)).toBe('completed');
    expect(deps.runAcceptanceChecks).not.toHaveBeenCalled();
    expect(deps.completeTurn.mock.calls[0]?.[3]).toMatchObject({
      summary: 'A mutex has an owner.',
      answer,
      verification: { status: 'not_applicable', evidence: [], remainingRisks: [] }
    });
  });

  it('sends a failing check back once, then completes verified when it passes', async () => {
    const deps = rig([false, true]);
    const working = state({ acceptance: record, mutatedBeyondProse: true });
    expect(await completeAnswer(deps, task, key, working, 'Fixed.')).toBe('continue');
    expect(working.messages.at(-1)?.content).toContain('ACCEPTANCE CHECKS FAILED (1 of 4)');
    expect(deps.completeTurn).not.toHaveBeenCalled();
    expect(await completeAnswer(deps, task, key, working, 'Fixed properly.')).toBe('completed');
    expect(deps.completeTurn.mock.calls[0]?.[3]).toMatchObject({
      answer: 'Fixed properly.',
      verification: { status: 'verified' }
    });
    expect(working.acceptanceFailures).toBe(0);
  });

  it('completes with the failure stated once the allowance is spent', async () => {
    const deps = rig([false]);
    const working = state({ acceptance: record, mutatedBeyondProse: true, acceptanceFailures: 3 });
    expect(await completeAnswer(deps, task, key, working, 'Done.')).toBe('completed');
    const verification = deps.completeTurn.mock.calls[0]?.[3].verification;
    expect(verification?.status).toBe('checks_failed');
    expect(verification?.remainingRisks.some((risk) => risk.includes('2 failed'))).toBe(true);
  });

  it('runs no checks for a turn that changed nothing, or one in plan mode', async () => {
    const deps = rig([false]);
    await completeAnswer(deps, task, key, state({ acceptance: record }), 'It reads all three.');
    await completeAnswer(
      deps,
      task,
      key,
      state({ acceptance: record, mutatedBeyondProse: true, mode: 'plan' }),
      'Here is the plan.'
    );
    expect(deps.runAcceptanceChecks).not.toHaveBeenCalled();
    expect(deps.completeTurn).toHaveBeenCalledTimes(2);
  });
});

describe('the summary carried beside the answer', () => {
  it('is the first sentence, without markdown, and never empty', () => {
    expect(answerSummary('## Result\n**Done.** More detail follows.')).toBe('Result\nDone.');
    expect(answerSummary('One line with no stop')).toBe('One line with no stop');
    expect(answerSummary('')).toBe('Done.');
    expect(answerSummary('x'.repeat(900))).toHaveLength(400);
  });
});
