/**
 * The routing key on the one request that spends the owner's money, and on the one that closes it.
 *
 * `session_id` is what a route uses to find the prefix it has already cached, and a fork sent a
 * fresh one on the first request of the one action an owner takes when something went wrong. Now
 * that a retry's whole preamble is the parent's byte for byte - the two frozen blocks built from
 * the family's request and instant, the memory pack copied rather than re-ranked - a fresh key here
 * would offer a matching prefix under a name the route has never seen.
 *
 * A turn derives that key in TWO files: `generate.ts` for every step, and `handoff.ts` for the
 * closing call, which sends the same window and the same preamble and is the largest request a
 * step-limited turn makes. Both now ask `turnRoutingTaskId`, which is the same call the preamble
 * makes, so the last case here is about a third way the two could disagree: the AGE CEILING, which
 * the key was not subject to and the preamble was. They were derived independently and drifted apart the moment one of them
 * learned about forks, so on every retry the handoff presented a key nothing had been written
 * under - a regression on exactly the action the rule exists to make cheaper. The last case in this
 * file therefore asserts the two AGAINST EACH OTHER rather than each against a literal: agreement is
 * the property that broke, so agreement is what is pinned.
 *
 * Driven through `generateModelStep` and `handOffAtStepLimit` rather than by re-deriving the hash
 * beside the production one: two literals in two files is how a request comes to carry a key nobody
 * chose. The gateway is made to throw once it has captured the body, so each case ends at the send
 * and never reaches billing.
 */
import { UNKNOWN_SURFACES } from '@garden/contracts';
import type { ModelRelease } from '@garden/contracts';
import { encryptJson, sha256 } from '@garden/core';
import type { DataStore, TaskRecord } from '@garden/data';
import type { ModelGateway, ModelTool } from '@garden/model-gateway';
import { describe, expect, it } from 'vitest';
import type { AgentState, AgentWorkerConfig } from '../agent-state.js';
import { COMPACT_CONTEXT_TOOL, prepareModelContext } from '../context.js';
import { handOffAtStepLimit, type HandoffDeps } from '../handoff.js';
import { agentToolsFor } from '../tools.js';
import type { TurnRun } from './claim.js';
import { generateModelStep, type TurnGenerateDeps } from './generate.js';

const key = new Uint8Array(32).fill(9);
const rootId = '44444444-4444-4444-8444-444444444444';
const forkId = '55555555-5555-4555-8555-555555555555';
/** A family root far enough back that the preamble refuses to inherit from it. */
const staleRootId = '66666666-6666-4666-8666-666666666666';
const workspaceId = 'workspace-1';
/** Every fork below is created here; the two roots are placed against it. */
const FORK_CREATED_AT = '2026-09-01T12:00:00.000Z';

const model = {
  id: 'model-1',
  providerModelId: 'vendor/model-1',
  displayName: 'Model One',
  contextTokens: 128_000,
  usageClass: 'light'
} as unknown as ModelRelease;

/**
 * The rows the key now depends on, and the fixture is heavier than it was for exactly that reason.
 *
 * The key asks the same question the preamble asks - is there an ancestor this fork may present as
 * its own - and that question reads the ancestor's row, checks how old it is and opens its prompt.
 * So a retry here has to have a real ancestor, sealed for this workspace under this key, or it is
 * not a retry the product would inherit for either.
 */
const task = (input: {
  id: string;
  parentTaskId?: string;
  forkKind?: TaskRecord['forkKind'];
  createdAt?: string;
}): TaskRecord =>
  ({
    id: input.id,
    userId: 'user-1',
    workspaceId,
    parentTaskId: input.parentTaskId ?? null,
    forkKind: input.forkKind ?? null,
    createdAt: input.createdAt ?? FORK_CREATED_AT,
    promptCiphertext: encryptJson(
      { prompt: 'fix the importer' },
      key,
      `task-prompt:${workspaceId}`
    ),
    maxComputeCredits: 1_000
  }) as unknown as TaskRecord;

/**
 * The two ancestors the store answers with: one twenty-five minutes back, inside the anchor's hour,
 * and one thirty-three hours back, well past it.
 */
const ancestors = new Map<string, TaskRecord>([
  [rootId, task({ id: rootId, createdAt: '2026-09-01T11:35:00.000Z' })],
  [staleRootId, task({ id: staleRootId, createdAt: '2026-08-31T03:00:00.000Z' })]
]);
const getTask = async (_userId: string, id: string): Promise<TaskRecord | null> =>
  ancestors.get(id) ?? null;

/**
 * The whole entitled catalogue withdrawn, so this request carries no tools at all.
 *
 * `requestDerivationBreach` runs immediately before the send and fails the turn unless the tools on
 * the request are exactly the ones the run is entitled to. Withdrawing the catalogue rather than
 * reproducing it keeps this file out of the business of the tool catalogue, whose byte ceiling is
 * asserted elsewhere and has 27 bytes of headroom.
 */
const withdrawnTools = new Set(
  [...agentToolsFor('lead', UNKNOWN_SURFACES, []), COMPACT_CONTEXT_TOOL].map((tool) => tool.name)
);
const requestTools: ModelTool[] = [];
const reservedTokens = Math.ceil(JSON.stringify(requestTools).length / 4);

const openingState = (): AgentState =>
  ({
    messages: [
      { role: 'system', content: 'GARDEN RUNTIME CONTEXT (dynamic)' },
      { role: 'user', content: 'fix the importer' }
    ],
    step: 0,
    turn: 0,
    credits: 0,
    turnToolResults: {}
  }) as unknown as AgentState;

/** What the route was handed. Rejected at the door so nothing after the send has to be stubbed. */
class Captured extends Error {}

const sessionIdSent = async (record: TaskRecord): Promise<string> => {
  const state = openingState();
  const maxOutputTokens = 16_384;
  const windowOptions = { precedingTokens: 0, reservedTokens };
  const preparedContext = prepareModelContext(
    state.messages,
    model.contextTokens,
    maxOutputTokens,
    windowOptions
  );
  let sent: string | undefined;
  const gateway = {
    chat: async (_provider: string, input: { sessionId?: string }) => {
      sent = input.sessionId;
      throw new Captured('captured');
    }
  } as unknown as ModelGateway;
  const deps = {
    config: { WORKER_ID: 'worker-self' } as unknown as AgentWorkerConfig,
    store: {
      taskClaim: async () => ({ id: record.id, status: 'running', leaseOwner: 'worker-self' }),
      appendTaskEvent: async () => ({ id: 'event', sequence: 1 }),
      getTask
    } as unknown as DataStore,
    withLeaseRenewal: async <T>(_task: TaskRecord, operation: () => Promise<T>) => operation(),
    billModelStep: async () => undefined,
    compactContext: async () => false,
    noteRepeatingAnswer: async () => undefined
  } as unknown as TurnGenerateDeps;
  const run = {
    model,
    catalog: [model],
    gateway,
    provider: 'custom',
    requestTools,
    withdrawnTools,
    reservedTokens,
    surfaces: UNKNOWN_SURFACES,
    connectorKinds: []
  } as unknown as TurnRun;

  await expect(
    generateModelStep(
      deps,
      record,
      key,
      state,
      run,
      { maxOutputTokens, turn: 0 },
      { preparedContext, reasoningEffort: 'medium', windowOptions },
      { honorUserControl: async () => false, refreshActivePlan: async () => false }
    )
  ).rejects.toBeInstanceOf(Captured);
  expect(sent).toBeDefined();
  return sent!;
};

/**
 * The same question asked of the call that closes a step-limited turn.
 *
 * Built beside `sessionIdSent` rather than shared with it because the two production paths are
 * genuinely different call sites with different arguments, and a helper that fed them both would
 * hide the very drift this file exists to catch.
 */
const handoffSessionIdSent = async (record: TaskRecord): Promise<string> => {
  const state = {
    ...openingState(),
    // A turn at its step ceiling, which is the only way this call is ever reached.
    step: 120,
    selfContinuations: 0
  } as unknown as AgentState;
  let sent: string | undefined;
  const gateway = {
    chat: async (_provider: string, input: { sessionId?: string }) => {
      sent = input.sessionId;
      throw new Captured('captured');
    }
  } as unknown as ModelGateway;
  const deps = {
    config: { TASK_MAX_SELF_CONTINUATIONS: 0, WORKER_ID: 'worker-self' },
    store: {
      appendTaskEvent: async () => ({ id: 'event', sequence: 1 }),
      recordUsage: async () => undefined,
      getTask
    },
    withLeaseRenewal: async <T>(_task: TaskRecord, operation: () => Promise<T>) => operation(),
    outstandingPlanSteps: async () => ['Finish the importer'],
    completeTurn: async () => undefined
  } as unknown as HandoffDeps;

  await expect(
    handOffAtStepLimit(deps, record, key, state, {
      gateway,
      provider: 'custom',
      model,
      catalog: [model],
      turn: 0,
      maxOutputTokens: 16_384,
      tools: [{ name: 'set_plan', description: 'plan', parameters: {} }],
      webPlan: { mode: 'inhouse' } as never
    })
  ).rejects.toBeInstanceOf(Captured);
  expect(sent).toBeDefined();
  return sent!;
};

describe('the session key a request carries', () => {
  it('sends the parent key on a retry, so the copied prefix is found', async () => {
    const parent = await sessionIdSent(task({ id: rootId }));

    await expect(
      sessionIdSent(task({ id: forkId, parentTaskId: rootId, forkKind: 'retry' }))
    ).resolves.toBe(parent);
    // The key is the hash and not the id: nothing about which conversation this is leaves the box.
    expect(parent).toBe(sha256(`garden-task:${rootId}`).slice(0, 64));
    expect(parent).not.toContain(rootId);
  });

  /**
   * The other direction, and it is the half that stops this being an outage: a task nobody forked
   * keeps its own key, a branch - whose preamble is deliberately its own - keeps its own too, and
   * so does an EDIT.
   *
   * The edit is the one that changed. It inherited briefly and was taken back out, because an edit
   * of the first message carries no inherited trajectory and ranks its preamble against the request
   * the owner deliberately replaced. Its preamble is therefore its own, and a preamble of its own
   * must not be offered under the parent's key: this assertion is what keeps the key following the
   * preamble rather than the other way round. @see cachePrefixTaskId in `window.ts`.
   */
  it('leaves a plain task, a branch and an edit on their own keys', async () => {
    const parent = await sessionIdSent(task({ id: rootId }));
    const plain = await sessionIdSent(task({ id: forkId }));
    const branch = await sessionIdSent(
      task({ id: forkId, parentTaskId: rootId, forkKind: 'branch' })
    );
    const edited = await sessionIdSent(
      task({ id: forkId, parentTaskId: rootId, forkKind: 'edit' })
    );

    expect(plain).not.toBe(parent);
    expect(branch).not.toBe(parent);
    expect(edited).not.toBe(parent);
    expect(branch).toBe(plain);
    expect(edited).toBe(plain);
  });

  /**
   * THE AGREEMENT, which is the property that broke rather than either value on its own.
   *
   * The step requests and the closing handoff of one turn address the same prefix - the same window,
   * the same preamble - so whatever rule one applies, the other must apply too. Asserting each
   * against its own expected literal would have stayed green through the whole regression: the two
   * were individually correct and jointly wrong. So the retry is compared to the retry and the
   * plain task to the plain task, across the two files, in one case.
   */
  it('derives the same key in the step loop and in the closing handoff', async () => {
    const retry = task({ id: forkId, parentTaskId: rootId, forkKind: 'retry' });

    expect(await handoffSessionIdSent(retry)).toBe(await sessionIdSent(retry));
    // And the retry is genuinely presenting the parent's key on both, not agreeing on its own.
    expect(await handoffSessionIdSent(retry)).toBe(await sessionIdSent(task({ id: rootId })));
    // The other direction on both call sites at once: an unforked task still gets its own.
    const plain = task({ id: forkId });
    expect(await handoffSessionIdSent(plain)).toBe(await sessionIdSent(plain));
    expect(await handoffSessionIdSent(plain)).not.toBe(await handoffSessionIdSent(retry));
  });

  /**
   * THE KEY FOLLOWS THE PREAMBLE PAST THE AGE CEILING TOO, which is where the two used to part.
   *
   * A retry inherits its parent's preamble only while the family root is inside
   * `FORK_ANCHOR_MAX_AGE_MS`; past it the fork ranks and clocks against its own text. The key knew
   * nothing about that ceiling, so a retry of a day-old task presented the parent's name over a
   * preamble that was its own. The harm is not a miss: a route asked to match a name it holds a
   * different prefix under writes the new one there, so the stale fork EVICTS the bytes the
   * family's next retry inside the hour would have hit.
   *
   * Both directions in one case, on both call sites, because either alone is saturated: a rule that
   * refused every retry would pass the first half and a rule that ignored the ceiling would pass
   * the second.
   */
  it('leaves a retry past the anchor age ceiling on its own key, on both call sites', async () => {
    const plain = await sessionIdSent(task({ id: forkId }));
    const staleParent = await sessionIdSent(task({ id: staleRootId }));
    const stale = task({ id: forkId, parentTaskId: staleRootId, forkKind: 'retry' });

    // Its preamble is its own, so its name is its own: exactly a task nobody forked.
    expect(await sessionIdSent(stale)).toBe(plain);
    expect(await sessionIdSent(stale)).not.toBe(staleParent);
    expect(await handoffSessionIdSent(stale)).toBe(await sessionIdSent(stale));

    // And the ceiling has not simply refused everything: a root twenty-five minutes back still
    // hands its name down, which is the case the whole rule exists for.
    const fresh = task({ id: forkId, parentTaskId: rootId, forkKind: 'retry' });
    expect(await sessionIdSent(fresh)).toBe(await sessionIdSent(task({ id: rootId })));
    expect(await handoffSessionIdSent(fresh)).toBe(await sessionIdSent(fresh));
  });
});
