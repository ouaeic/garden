/**
 * What one compaction sends, and what it is structurally unable to send.
 *
 * The two facts pinned here are the two an argument about compaction turns on - what the
 * summarising model is shown, and how many model calls a compaction costs.
 *
 * ── The asymmetry these tests exist to hold still ──────────────────────────────────────────────
 *
 * The two paths out of a compaction treat the reasoning channel differently, on purpose, and the
 * two cases below are the two sides of that.
 *
 * `transcriptLine` in `context.ts` - the transcript handed to the summarising model - CARRIES it.
 * The summariser is asked for "decisions taken and the reason for them, including approaches that
 * were tried and rejected", and that working-out lives in the reasoning channel. A transcript built
 * from content and tool calls alone would withhold the one channel the answer is in, and then ask
 * for the answer.
 *
 * `trajectorySummary` - the deterministic brief used when the summariser call fails - DOES NOT
 * carry it, and that is decided rather than left over. Its output goes straight into the window
 * under a 12,000-character cap with no model in between, so a byte of reasoning admitted there
 * displaces a byte of prose or an identifier one for one, in the brief every later step re-reads.
 * On the summariser path the same bytes are input to a call whose output is bounded separately.
 *
 * Measured cost of the admission, in evals/context-quality/README.md and re-derivable from its
 * baseline: summariser input +10.3% to +47.0% across the five trajectories, which is +0.06 to
 * +0.43 percentage points of a task's prompt tokens.
 *
 * What these tests do NOT establish: that a real summarising model keeps the material now that it
 * can see it. Both halves of evals/context-quality compact with an extractive summariser, so the
 * rig can price this and cannot score it, and it says so of itself.
 */
import { describe, expect, it } from 'vitest';
import { generateDataKey } from '@garden/core';
import type { ModelRelease } from '@garden/contracts';
import type { TaskRecord } from '@garden/data';
import type { ModelMessage } from '@garden/model-gateway';
import type { AgentState } from './agent-state.js';
import { compactTurnContext, type CompactionDeps } from './compaction.js';

/**
 * Sentinels planted in pairs on the SAME assistant message, which is what makes the negative
 * assertion two-sided. `PROSE` proves the message really was condensed and really did reach the
 * transcript; `REASONED` is then absent for one reason only, since a message that never reached the
 * transcript could not have carried either. A single-sided "reasoning is absent" would pass just as
 * happily on a fixture that compacted nothing at all.
 */
const PROSE = 'ZPROSEZ-listen-notify-was-rejected';
const REASONED = 'ZREASONEDZ-because-transaction-pooling-drops-the-listener-session';
const ARGUMENT = 'ZARGUMENTZ-workspace/infra/pooler.ini';
const RESULT = 'ZRESULTZ-SQLSTATE-53300-too-many-connections';
const GOAL = 'ZGOALZ-never-exceed-40-pooled-connections';

/** Filler that makes a message big enough to be worth condensing, and carries no sentinel. */
const filler = (label: string, characters: number): string =>
  `${label} `.repeat(Math.ceil(characters / (label.length + 1))).slice(0, characters);

/**
 * A window past the compaction trigger, shaped the way the step loop leaves one: a preamble, the
 * owner's goal, then assistant turns carrying prose, reasoning and a tool call, each answered by a
 * tool result.
 *
 * Twenty-six pairs at these sizes is 14,828 estimated tokens - measured through
 * `estimatedContextTokens`, not chosen - against the 20,000-token input budget a 32k lead with a
 * 4k output reservation gets. That is over the 0.7 trigger share by 6% and well over the 0.35
 * target share, so 28 of the 54 messages are condensed and the window lands at 7,239: comfortably
 * past `MIN_CONDENSED_MESSAGES` (6) and `MIN_CONDENSED_TOKENS`. The margin over the trigger is the
 * thin one, and it is deliberate: a fixture that has to be enormous to compact is a fixture that
 * has stopped resembling a turn. If a change to the shares moves it under, every test here fails
 * loudly on `expect(outcome).not.toBeNull()` rather than passing on a window nothing condensed.
 * The sentinel step is early enough to be condensed rather than retained:
 * `MIN_PROTECTED_TAIL_MESSAGES` is 8 and the tail is measured backwards in tokens.
 */
const windowPastTheTrigger = (): ModelMessage[] => {
  const messages: ModelMessage[] = [
    { role: 'system', content: `You are garden. ${filler('preamble', 600)}` },
    { role: 'user', content: `${GOAL}. ${filler('goal', 400)}` }
  ];
  for (let step = 0; step < 26; step += 1) {
    const sentinel = step === 3;
    messages.push({
      role: 'assistant',
      content: sentinel ? `${PROSE}. ${filler(`said-${step}`, 400)}` : filler(`said-${step}`, 400),
      reasoning: sentinel
        ? `${REASONED}. ${filler(`thought-${step}`, 800)}`
        : filler(`thought-${step}`, 800),
      toolCalls: [
        {
          id: `call-${step}`,
          name: 'file_read',
          arguments: { path: sentinel ? ARGUMENT : `workspace/src/step-${step}.ts` }
        }
      ]
    });
    messages.push({
      role: 'tool',
      toolCallId: `call-${step}`,
      content: sentinel
        ? `${RESULT}. ${filler(`result-${step}`, 900)}`
        : filler(`result-${step}`, 900)
    });
  }
  return messages;
};

const SUMMARISER: ModelRelease = {
  id: 'test-summariser',
  providerModelId: 'test/summariser',
  displayName: 'Test Summariser',
  provider: 'test-provider',
  revision: '1',
  availability: 'available',
  openness: 'remote_proprietary',
  license: 'proprietary',
  commercialUse: true,
  // `PrivacyRoute` is 'provider_zdr' | 'external' and nothing else; 'in_house' was a type error the
  // package typecheck catches and vitest does not, because vitest strips types rather than checking
  // them. 'external' rather than 'provider_zdr' because `usableCapabilities` gates only the
  // zero-retention route on the model's own route, so this keeps `compactionModel`'s filter resting
  // on availability alone - which is what this fixture is about, and the summariser it selects is
  // the same one either way.
  privacyRoute: 'external',
  contextTokens: 200_000,
  modalities: ['text'],
  capabilities: ['chat'],
  usageClass: 'light',
  recommendationTags: [],
  measuredQuality: null,
  measuredLatencyMs: null,
  inputUsdPerMillionTokens: 0.1,
  outputUsdPerMillionTokens: 0.4,
  updatedAt: '2026-09-01T00:00:00.000Z'
} as ModelRelease;

/** The lead model, deliberately small so the budget puts the fixture over the trigger. */
const LEAD: ModelRelease = {
  ...SUMMARISER,
  id: 'test-lead',
  contextTokens: 32_000
} as ModelRelease;

interface Harness {
  readonly deps: CompactionDeps;
  readonly state: AgentState;
  readonly task: TaskRecord;
  readonly key: Uint8Array;
  /** Every request the summariser stage sent, in order. One per compaction is the shipped cost. */
  readonly requests: ModelMessage[][];
  readonly usageRows: Array<Record<string, unknown>>;
}

const harness = (options: { refuse?: boolean } = {}): Harness => {
  const requests: ModelMessage[][] = [];
  const usageRows: Array<Record<string, unknown>> = [];
  const task = {
    id: '55555555-5555-4555-8555-555555555555',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    // Same enum as the model's above. The `as unknown as` cast means the compiler would not have
    // said so here, which is why it is written out rather than left as whatever the other one was.
    privacyRoute: 'external'
  } as unknown as TaskRecord;
  const state = {
    step: 30,
    turn: 0,
    credits: 0,
    compactions: 0,
    messages: windowPastTheTrigger(),
    turnToolResults: { 'call-3': { name: 'file_read', success: true, mutating: false } }
  } as unknown as AgentState;
  const deps = {
    store: {
      recordUsage: async (row: Record<string, unknown>) => {
        usageRows.push(row);
      },
      appendTaskEvent: async () => ({ id: 'event', sequence: 1 })
    },
    assertProviderConfigured: async () => undefined,
    gateway: async () => ({
      gateway: {
        chat: async (_provider: string, request: { messages: ModelMessage[] }) => {
          requests.push(request.messages);
          if (options.refuse) throw new Error('the summariser endpoint is unreachable');
          return {
            text: 'Brief: the pool work continued.',
            usage: { inputTokens: 9_000, outputTokens: 300, totalTokens: 9_300 },
            metadata: { provider: 'test-provider', model: 'test/summariser' }
          };
        }
      },
      provider: 'test-provider'
    }),
    withLeaseRenewal: async <T>(_task: TaskRecord, operation: () => Promise<T>) => operation(),
    currentCatalog: async () => [SUMMARISER]
  } as unknown as CompactionDeps;
  return { deps, state, task, key: generateDataKey(), requests, usageRows };
};

const compact = (held: Harness) =>
  compactTurnContext(held.deps, held.task, held.key, held.state, {
    model: LEAD,
    catalog: [SUMMARISER],
    maxOutputTokens: 4_000,
    reservedTokens: 0,
    trigger: 'budget',
    turn: 0
  });

/** The whole of what the summarising model is shown: the system prompt plus the built request. */
const shown = (request: ModelMessage[]): string =>
  request.map((message) => message.content).join('\n');

describe('the transcript a compaction hands its summariser', () => {
  it('carries the prose, the tool-call arguments and the tool results of the span it drops', async () => {
    const held = harness();

    const outcome = await compact(held);

    expect(outcome).not.toBeNull();
    expect(held.requests).toHaveLength(1);
    const transcript = shown(held.requests[0] ?? []);
    // Four positive controls, so an absence below cannot be explained by the search, by the
    // fixture failing to compact, or by the sentinel step landing in the retained tail.
    expect(transcript).toContain(GOAL);
    expect(transcript).toContain(PROSE);
    expect(transcript).toContain(ARGUMENT);
    expect(transcript).toContain(RESULT);
  });

  /**
   * `PROSE` and `REASONED` are on the SAME assistant message, and the test above has already shown
   * that message reaches the summariser - so this is a statement about the reasoning channel and
   * not about the fixture.
   *
   * It used to assert the opposite, and the opposite was the defect: `compactionRequest` asks the
   * summariser to preserve the reasons behind decisions, the preamble tells the model to put those
   * reasons in the reasoning channel or nowhere, and `transcriptLine` then built the transcript
   * from content and tool calls alone. The harness was hiding the answer and asking for it.
   */
  it('carries the reasoning that produced them, which is the channel the summariser is told to keep', async () => {
    const held = harness();

    const outcome = await compact(held);

    expect(outcome).not.toBeNull();
    const transcript = shown(held.requests[0] ?? []);
    expect(transcript).toContain(PROSE);
    expect(transcript).toContain(REASONED);
    // What still leaves: the raw message goes out of the window, so the reasoning survives only
    // through whatever the summariser chose to write down. This asserts the transcript reached the
    // model, not that the model kept it - the extractive summariser here cannot answer that, and
    // evals/context-quality says the same of itself.
    expect(held.state.contextBrief).toBeDefined();
    expect(JSON.stringify(held.state.messages)).not.toContain(REASONED);
  });

  /**
   * The other carrier, on the path a summariser outage takes, and the difference is now decided
   * rather than accidental. `compactContext` swallows the failure and writes `trajectorySummary`
   * instead, which reads `content` and tool NAMES only.
   *
   * WHY IT IS NOT GIVEN THE REASONING THE SUMMARISER PATH NOW GETS: `trajectorySummary`'s output
   * goes STRAIGHT INTO THE WINDOW under a 12,000-character cap, with no model in between to
   * compress it. Every byte of reasoning admitted there displaces a byte of prose or an identifier
   * one for one, in the brief that is the only thing every later step re-reads. On the summariser
   * path the same bytes are input to a call whose output is bounded separately, so they cost
   * summariser input and not window. The tool-call ARGUMENTS this path also drops are recovered
   * through the anchor index; nothing recovers the reasoning, and that is the stated residue.
   */
  it('leaves it out of the deterministic path, where a brief goes straight into the window', async () => {
    const held = harness({ refuse: true });

    const outcome = await compact(held);

    expect(outcome).not.toBeNull();
    expect(outcome?.section.source).toBe('deterministic');
    expect(outcome?.section.text).toContain(PROSE);
    expect(outcome?.section.text).not.toContain(REASONED);
  });
});

describe('what a compaction costs', () => {
  /**
   * One compaction is one model call. This is the number an interrogation pass would change.
   *
   * Terminus 2 runs three at a context boundary - a summariser, a fresh-context questioner, and an
   * answerer holding the full history - and the third of those carries the transcript a second
   * time. Measured on the five trajectories in evals/context-quality at the shipped configuration,
   * the summariser stage is 0.26-2.24% of a task's prompt tokens, so the pass roughly doubles a
   * cost that is small; what it certainly does is put three sequential requests on the critical
   * path of a blocked turn, each with its own `COMPACTION_REQUEST_TIMEOUT_MS`.
   *
   * Pinned here because it is invisible everywhere else: the usage rows are keyed
   * `compact:<task>:<turn>:<n>` and a second call inside one compaction would either collide on
   * that key or bill silently.
   */
  it('bills exactly one summariser call, with the usage row that pays for it', async () => {
    const held = harness();

    await compact(held);

    expect(held.requests).toHaveLength(1);
    expect(held.usageRows).toHaveLength(1);
    expect(held.usageRows[0]).toMatchObject({
      kind: 'model_inference',
      quantity: 9_300,
      unit: 'tokens',
      idempotencyKey: `compact:${held.task.id}:0:1`
    });
    expect(held.state.compactions).toBe(1);
    expect(held.state.credits).toBeGreaterThan(0);
  });

  /**
   * A summariser outage costs a call and bills nothing, because the throw happens before the usage
   * row is written. Worth pinning rather than reasoning about: `summariseForCompaction` records
   * usage after the response returns, so a failure is free, and a design that added two more calls
   * would have two more places to fail after the first one had already been paid for.
   */
  it('bills nothing when the summariser fails, and still bounds the window', async () => {
    const held = harness({ refuse: true });
    const before = held.state.messages.length;

    const outcome = await compact(held);

    expect(held.requests).toHaveLength(1);
    expect(held.usageRows).toHaveLength(0);
    expect(outcome).not.toBeNull();
    expect(held.state.messages.length).toBeLessThan(before);
    expect(outcome?.estimatedTokensAfter).toBeLessThan(outcome?.estimatedTokensBefore ?? 0);
  });
});

/**
 * Whose model does the summarising.
 *
 * `compactionModel` takes the cheapest capable route on the task's own provider, and that is the
 * right answer when nobody has said otherwise - it is what every run did before an owner could
 * hold an opinion. What it could not do is be overruled, and this is not a small number: the
 * context rig records around a million summariser tokens per configuration, spent on a task's
 * longest and most expensive turns.
 */
describe('the model a compaction runs on', () => {
  const pinned: ModelRelease = {
    ...SUMMARISER,
    id: 'pinned-summariser',
    providerModelId: 'test/pinned'
  };

  /** Runs one compaction and reports the model handed to the gateway to do it. */
  const summariserUsed = async (
    pinnedSummariser: (() => Promise<ModelRelease | null>) | undefined
  ): Promise<string | undefined> => {
    const held = harness();
    let chosen: ModelRelease | undefined;
    const deps = {
      ...held.deps,
      ...(pinnedSummariser ? { pinnedSummariser } : {}),
      gateway: async (task: TaskRecord, model: ModelRelease) => {
        chosen = model;
        return (held.deps as unknown as { gateway: CompactionDeps['gateway'] }).gateway(
          task,
          model
        );
      }
    } as unknown as CompactionDeps;
    await compactTurnContext(deps, held.task, held.key, held.state, {
      model: LEAD,
      catalog: [SUMMARISER],
      maxOutputTokens: 4_000,
      reservedTokens: 0,
      trigger: 'budget',
      turn: 0
    });
    return chosen?.id;
  };

  it('uses the owner`s pin over the automatic pick', async () => {
    expect(await summariserUsed(async () => pinned)).toBe(pinned.id);
  });

  it('uses the automatic pick when the owner left this purpose automatic', async () => {
    expect(await summariserUsed(async () => null)).toBe(SUMMARISER.id);
  });

  it('leaves a caller that knows nothing about pins exactly as it was', async () => {
    expect(await summariserUsed(undefined)).toBe(SUMMARISER.id);
  });
});
