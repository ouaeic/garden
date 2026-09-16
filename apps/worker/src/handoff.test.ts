import { describe, expect, it, vi } from 'vitest';
import { decryptJson, generateDataKey } from '@athanor/core';
import type { TaskRecord } from '@athanor/data';
import type { AgentState } from './agent-state.js';
import type { ModelRelease } from '@athanor/contracts';
import type { ModelGateway } from '@athanor/model-gateway';
import {
  handOffAtStepLimit,
  renewStepBudget,
  TURN_WALL_CLOCK_MS,
  turnWallClockReached,
  type HandoffDeps
} from './handoff.js';
import { buildIdentity } from './build-identity.js';
import { LATE_STEP_EFFORT_FLOOR, reasoningEffortForStep } from './turn-bounds.js';
import { MODEL_REQUEST_TIMEOUT_MS } from './turn-lifecycle.js';

/**
 * There was no clock ceiling anywhere in the product.
 *
 * `TASK_MAX_STEPS`, `TASK_MAX_SELF_CONTINUATIONS`, `maxComputeCredits` and the owner's spend caps
 * were the whole of what bounded a turn, and the per-unit ceilings compose rather than cap: six
 * idle steps at ten minutes of generation each is an hour of billed deliberation, five completion
 * nags is fifty minutes, and a hundred and twenty steps of tool time is days in principle. The
 * credit ceiling is what bites first on a frontier model, and it is a proxy for time rather than a
 * bound on it - on a cheap local route credits accumulate slowly and the clock does not.
 */
describe('the turn wall clock', () => {
  it('holds a turn that is inside the allowance', () => {
    const startedAt = Date.now();
    expect(turnWallClockReached(startedAt, startedAt)).toBe(false);
    expect(turnWallClockReached(startedAt, startedAt + TURN_WALL_CLOCK_MS - 1)).toBe(false);
  });

  it('ends a turn that reaches it', () => {
    const startedAt = Date.now();
    expect(turnWallClockReached(startedAt, startedAt + TURN_WALL_CLOCK_MS)).toBe(true);
  });

  /*
   * The composition the bound exists for, in the product's own figures: the step ceiling is 120
   * and every one of those steps may spend a whole `MODEL_REQUEST_TIMEOUT_MS` generating, before a
   * second of tool time is counted. Thirty hours of model time was inside every bound the loop had.
   */
  it('is shorter than the ceilings that compose underneath it', () => {
    const stepsTimesTheRequestDeadline = 120 * MODEL_REQUEST_TIMEOUT_MS;
    expect(stepsTimesTheRequestDeadline).toBeGreaterThan(TURN_WALL_CLOCK_MS);
    // And it is not so tight that a healthy turn could reach it: the measured record in this file
    // is that a frontier model reaches the credit ceiling around step 22 to 39.
    expect(TURN_WALL_CLOCK_MS).toBeGreaterThan(39 * MODEL_REQUEST_TIMEOUT_MS * 0.1);
  });

  it('reads the clock rather than a monotonic counter, so a paused process still ages', () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      vi.setSystemTime(startedAt + TURN_WALL_CLOCK_MS);
      expect(turnWallClockReached(startedAt)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The ownership refusal inside the renewal, at the only level that can still reach it.
 *
 * Wave 7.2 gave `honorUserControl` an arm for #140, and that arm stands a disowned run down at the
 * step boundary in silence. It runs first, so the whole-loop case in `agent-run.test.ts` - a turn
 * whose lease was foreign before it ever started - no longer arrives at the step ceiling, and the
 * refusal this describes stopped being reachable from there.
 *
 * It is not dead. `renewStepBudget` is evaluated at the top of the loop condition, and the last
 * `honorUserControl` before it is a whole model call and a whole tool batch earlier: a lease lost
 * inside that window reaches here and nowhere else. That is the narrower race this guards, and it
 * is worth guarding for the reason the arm above it exists - a renewal announces a continuation on
 * a conversation another worker is running, then saves this run's stale trajectory over theirs.
 */
describe('the renewal asks who holds the task', () => {
  const taskId = '33333333-3333-4333-8333-333333333333';
  const key = generateDataKey();

  const renewableState = (): AgentState =>
    ({
      step: 12,
      turn: 0,
      credits: 10,
      messages: [],
      selfContinuations: 0,
      acceptanceTurn: 0,
      // One successful mutating call, which is the progress bar `mayRenewStepBudget` measures.
      turnToolResults: { 'call-0': { name: 'file_write', success: true, mutating: true } },
      acceptance: {
        checks: [
          {
            id: 'check-1',
            kind: 'command',
            label: 'the suite passes',
            executable: 'pytest',
            args: ['-q'],
            cwd: 'workspace',
            expectExit: 0,
            timeoutSeconds: 900
          }
        ],
        revisions: 1,
        declaredAtStep: 0
      }
    }) as unknown as AgentState;

  it('refuses a renewal when the lease moved since the last step boundary, and runs no checks', async () => {
    const summaries: string[] = [];
    const task = {
      id: taskId,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      maxComputeCredits: 1_000
    } as unknown as TaskRecord;
    const deps = {
      config: { TASK_MAX_SELF_CONTINUATIONS: 2, WORKER_ID: 'worker-self' },
      store: {
        // The fresh read the renewal makes immediately before deciding: still running, but held by
        // somebody else now.
        getTask: async () => ({ ...task, status: 'running', leaseOwner: 'worker-other' }),
        // Allowed deliberately: the spend caps are asked *after* the ownership question, so leaving
        // this permissive is what makes the check below a statement about the lease rather than
        // about a budget that would have stopped the renewal anyway.
        spendGuard: async () => ({ outcome: 'allow' }),
        appendTaskEvent: async (input: {
          payloadCiphertext: Parameters<typeof decryptJson>[0];
        }) => {
          summaries.push(decryptJson<{ summary: string }>(input.payloadCiphertext, key).summary);
          return { id: 'event', sequence: summaries.length };
        }
      },
      // The checks are a full build and a full test run on the owner's computer. Who holds the task
      // is a free read and it comes first, so this must never be reached.
      runAcceptanceChecks: async () => {
        throw new Error('the acceptance suite must not run for a task this worker does not hold');
      }
    } as unknown as HandoffDeps;

    const renewed = await renewStepBudget(deps, task, key, renewableState());

    expect(renewed).toBe(false);
    expect(summaries).toContain('Stopping at the step limit: another worker holds the task');
  });

  it('does not refuse on ownership when this worker still holds the lease', async () => {
    // The same state one field apart, so the case above is about the lease and not about a state
    // that could never have renewed anyway.
    const summaries: string[] = [];
    const task = {
      id: taskId,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      maxComputeCredits: 1_000
    } as unknown as TaskRecord;
    const deps = {
      config: { TASK_MAX_SELF_CONTINUATIONS: 2, WORKER_ID: 'worker-self' },
      store: {
        getTask: async () => ({ ...task, status: 'running', leaseOwner: 'worker-self' }),
        spendGuard: async () => ({ outcome: 'allow' }),
        appendTaskEvent: async (input: {
          payloadCiphertext: Parameters<typeof decryptJson>[0];
        }) => {
          summaries.push(decryptJson<{ summary: string }>(input.payloadCiphertext, key).summary);
          return { id: 'event', sequence: summaries.length };
        }
      },
      // Reached this time, and every check still fails - so the renewal is granted rather than
      // refused, which is what makes the ownership arm above the thing that stopped it.
      runAcceptanceChecks: async () => [
        { id: 'check-1', label: 'the suite passes', passed: false, detail: 'one test still fails' }
      ],
      withLeaseRenewal: async <T>(_task: TaskRecord, operation: () => Promise<T>) => operation(),
      checkpoint: async () => undefined
    } as unknown as HandoffDeps;

    const renewed = await renewStepBudget(deps, task, key, renewableState());

    expect(renewed).toBe(true);
    expect(summaries).not.toContain('Stopping at the step limit: another worker holds the task');
  });
});

/**
 * The one request field the step loop goes out of its way not to flip, flipped on the largest
 * request the turn sends.
 *
 * `reasoningEffortForStep` ratchets in one direction and pins itself, and the comment at its call
 * site in `agent.ts` says why in as many words: `reasoning` becoming a byte-stable request field
 * instead of flipping ten times in twenty-three steps is what keeps the provider's cached trajectory
 * from being discarded below the system prefix on every flip. The closing handoff sent the literal
 * 'medium' - twice, once on the request and once on the cost event - on the whole window plus the
 * whole catalogue, at the end of a turn that had by definition run long enough to have latched
 * 'high'.
 */
describe('the effort the closing call thinks at', () => {
  const taskId = '33333333-3333-4333-8333-333333333333';
  const key = generateDataKey();
  const model = {
    id: 'model-1',
    providerModelId: 'vendor/model-1',
    displayName: 'Model One',
    contextTokens: 128_000,
    usageClass: 'light'
  } as unknown as ModelRelease;

  /** A turn at its step ceiling, which is the only way this call is ever reached. */
  const exhausted = (): AgentState =>
    ({
      step: LATE_STEP_EFFORT_FLOOR + 4,
      turn: 0,
      credits: 40,
      messages: [
        { role: 'system', content: 'ATHANOR RUNTIME CONTEXT (dynamic)' },
        { role: 'user', content: 'fix the importer' },
        {
          role: 'assistant',
          content: 'still working',
          toolCalls: [{ id: 'call-1', name: 'shell', arguments: { command: 'pytest' } }]
        },
        { role: 'tool', content: 'exit 0', toolCallId: 'call-1' }
      ],
      turnToolResults: {}
    }) as unknown as AgentState;

  const drive = async (): Promise<{
    requests: Array<Record<string, unknown>>;
    costs: Array<Record<string, unknown>>;
    state: AgentState;
  }> => {
    const requests: Array<Record<string, unknown>> = [];
    const costs: Array<Record<string, unknown>> = [];
    const state = exhausted();
    const task = {
      id: taskId,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      maxComputeCredits: 1_000
    } as unknown as TaskRecord;
    const gateway = {
      chat: async (_provider: string, input: Record<string, unknown>) => {
        requests.push(input);
        return {
          text: 'Here is where it got to.',
          toolCalls: [],
          usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 },
          metadata: { provider: 'custom', model: 'vendor/model-1' }
        };
      }
    } as unknown as ModelGateway;
    const deps = {
      config: { TASK_MAX_SELF_CONTINUATIONS: 0, WORKER_ID: 'worker-self' },
      store: {
        appendTaskEvent: async (input: {
          payloadCiphertext: Parameters<typeof decryptJson>[0];
        }) => {
          const payload = decryptJson<{ summary: string; payload?: Record<string, unknown> }>(
            input.payloadCiphertext,
            key
          );
          if (payload.summary === 'Handoff completed') costs.push(payload.payload ?? {});
          return { id: 'event', sequence: costs.length };
        },
        recordUsage: async () => undefined
      },
      withLeaseRenewal: async <T>(_task: TaskRecord, operation: () => Promise<T>) => operation(),
      outstandingPlanSteps: async () => ['Finish the importer'],
      completeTurn: async () => undefined
    } as unknown as HandoffDeps;

    await handOffAtStepLimit(deps, task, key, state, {
      gateway,
      provider: 'custom',
      model,
      catalog: [model],
      turn: 0,
      maxOutputTokens: 16_384,
      tools: [{ name: 'set_plan', description: 'plan', parameters: {} }],
      webPlan: { mode: 'inhouse' } as never
    });
    return { requests, costs, state };
  };

  it('sends the effort the turn had earned, not a literal', async () => {
    const { requests } = await drive();

    // The turn is at its ceiling, so `effortFloorEarned` is true on the step count alone.
    expect(reasoningEffortForStep(exhausted())).toBe('high');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.reasoningEffort).toBe('high');
  });

  it('reports on the cost line the effort it actually sent', async () => {
    const { requests, costs } = await drive();

    expect(costs).toHaveLength(1);
    // Two literals in one file that nothing held together is how a cost line comes to report an
    // effort the request never used.
    expect(costs[0]?.reasoningEffort).toBe(requests[0]?.reasoningEffort);
  });

  /** And it names the build that priced it, on both cost paths or on neither. */
  it('stamps the build that priced the closing call', async () => {
    const { costs } = await drive();

    const build = costs[0]?.build as { version?: string; commit?: string | null } | undefined;
    expect(build?.version).toBeTruthy();
    expect(build).toEqual(buildIdentity());
  });
});
