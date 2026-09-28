/**
 * Condensing a turn's window into the durable brief, and the one cheap model call that writes it.
 *
 * Lifted out of `AgentWorker` in Wave 7.2 unchanged. It is a state transition over `state.messages`
 * with its own summariser, its own billing and its own event, and it was reachable only by driving
 * a whole task through the step loop.
 */
import type { ModelRelease } from '@garden/contracts';
import { sha256 } from '@garden/core';
import type { DataStore, TaskRecord } from '@garden/data';
import type { ModelGateway } from '@garden/model-gateway';
import { acceptanceAcceptedResult } from './acceptance.js';
import type { AgentState } from './agent-state.js';
import { estimatedInferenceCostUsd, usageCredit } from './billing.js';
import { ACCEPTANCE_MARKER } from './completion.js';
import {
  compactContext,
  compactionRequest,
  compactionTargetTail,
  declaredCompactionTargetTail,
  estimatedContextTokens,
  modelInputBudget,
  type CompactionOutcome
} from './context.js';
import { extractTurn } from './memory-runtime.js';
import {
  COMPACTION_REQUEST_TIMEOUT_MS,
  compactionEventSummary,
  compactionModel,
  routeTo
} from './routing.js';
import { event } from './tool-recording.js';
import { withRequestDeadline } from './turn-lifecycle.js';

/** What compaction needs from the worker that owns the turn. */
export interface CompactionDeps {
  readonly store: DataStore;
  assertProviderConfigured(task: TaskRecord): Promise<void>;
  /**
   * The model the owner pinned for summarising, when they pinned one. Optional on the deps because
   * every caller that does not care about the choice - the tests among them - keeps working
   * without it, and its absence means exactly what an unset preference means.
   */
  pinnedSummariser?: (
    task: TaskRecord,
    catalog: readonly ModelRelease[]
  ) => Promise<ModelRelease | null>;
  gateway(
    task: TaskRecord,
    model: ModelRelease
  ): Promise<{ gateway: ModelGateway; provider: string }>;
  withLeaseRenewal<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T>;
  currentCatalog(fallback: ModelRelease[]): Promise<ModelRelease[]>;
}

/**
 * One cheap, tool-free call that writes the next part of the running brief. Every failure mode -
 * an unconfigured provider, a quota wall, a stalled endpoint, a refusal - is allowed to throw:
 * `compactContext` turns it into the deterministic summary, so the window is still bounded and
 * the task still runs.
 */
export const summariseForCompaction = async (
  deps: CompactionDeps,
  task: TaskRecord,
  state: AgentState,
  summariser: ModelRelease,
  request: { goal: string; brief: string; transcript: string; note?: string },
  turn: number
): Promise<string> => {
  await deps.assertProviderConfigured(task);
  const { gateway, provider } = await deps.gateway(task, summariser);
  const maxTokens = Math.min(2_048, Math.max(1_024, Math.floor(summariser.contextTokens * 0.05)));
  // Counted rather than keyed on the step, because a step can compact twice - once on the budget
  // trigger and once because the agent asked - and a repeated key silently drops the second row.
  state.compactions = (state.compactions ?? 0) + 1;
  const response = await deps.withLeaseRenewal(task, () =>
    withRequestDeadline(
      (signal) =>
        gateway.chat(provider, {
          ...routeTo(summariser),
          messages: compactionRequest(request),
          tools: [],
          temperature: 0.1,
          maxTokens,
          // The one call whose output every later step re-reads. It used to send no effort at
          // all, which on a reasoning route is the least thinking of anything in the run.
          reasoningEffort: 'medium',
          // The task's OWN id even on a retry, unlike the step and handoff requests, which present
          // the parent's. @see cachePrefixTaskId in `window.ts`. This is a different prefix, not a
          // different key for the same one: a summariser request to a different model carrying the
          // transcript rather than the window. Inheriting a parent's key would point a route at a
          // prefix that was never sent under it, and the `:compaction` suffix keeps it off the
          // main conversation's prefix for the same reason.
          sessionId: sha256(`garden-task:${task.id}:compaction`).slice(0, 64),
          signal
        }),
      COMPACTION_REQUEST_TIMEOUT_MS
    )
  );
  const credit = usageCredit(summariser, response.usage.inputTokens, response.usage.outputTokens);
  state.credits += credit;
  await deps.store.recordUsage({
    userId: task.userId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    kind: 'model_inference',
    resourceClass: summariser.usageClass,
    quantity: response.usage.totalTokens,
    unit: 'tokens',
    credits: credit,
    costUsd:
      response.usage.costUsd ??
      estimatedInferenceCostUsd(
        summariser,
        response.usage.inputTokens,
        response.usage.outputTokens,
        response.usage
      ),
    state: 'settled',
    idempotencyKey: `compact:${task.id}:${turn}:${state.compactions}`,
    providerRef: `${response.metadata.provider}:${response.metadata.model}`
  });
  return response.text;
};

/**
 * Condenses superseded turns into the durable brief and publishes what happened.
 *
 * This is a state transition, not a per-request view: `state.messages` really loses the condensed
 * turns and gains the brief, so every later step appends to a window whose prefix is unchanged.
 * Preparing a smaller view per request instead - which is what the previous truncation did - moves
 * bytes on every step and cannot be cached at all.
 */
export const compactTurnContext = async (
  deps: CompactionDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  input: {
    model: ModelRelease;
    catalog: ModelRelease[];
    maxOutputTokens: number;
    /**
     * What the tool catalogue costs before a word of conversation, which the caller has already
     * counted for its own budget check. It is here because the size the trigger measures and the
     * size this target aims for have to be the same size: the check that decides to compact
     * subtracted the catalogue and this did not, so the target was a share of a budget nobody was
     * working to, and on a small window it landed close enough to the trigger that the next step
     * compacted again. Threading it through is the fix - one number, computed once, used at both
     * ends, so the two cannot drift apart again.
     */
    reservedTokens: number;
    trigger: 'budget' | 'agent';
    turn: number;
    note?: string;
    /**
     * The window the route will actually take, when it has just said so by refusing one.
     *
     * The catalogue's number is what the provider published for the model; this is what the
     * endpoint that answered enforces, and they differ - which is the whole of why a request the
     * pre-flight check passed came back refused. Condensing against the published number would
     * aim the repair at the size that was already too big.
     */
    contextTokensLimit?: number;
  }
): Promise<CompactionOutcome | null> => {
  const budget = modelInputBudget(
    Math.min(input.contextTokensLimit ?? input.model.contextTokens, input.model.contextTokens),
    input.maxOutputTokens,
    input.reservedTokens
  );
  // Resolve preferences before changing context; an unreadable pin must not choose a different route.
  const catalogue = await deps.currentCatalog(input.catalog);
  const summariser =
    (await deps.pinnedSummariser?.(task, catalogue)) ??
    compactionModel(catalogue, input.model, task.privacyRoute);
  // `finish` demands ids that live only on the raw tool messages this compaction is about to
  // drop, so they are carried forward deterministically rather than left to a summariser that is
  // asked for prose. Without this every long task ends on a rejected completion.
  const citable = Object.entries(state.turnToolResults ?? {}).filter(
    ([, result]) => result.success && result.name !== 'set_plan'
  );
  const citableFooter = citable.length
    ? `Citable toolCallIds from this turn, for finish: ${citable
        .map(([id, result]) => `${id} (${result.name})`)
        .join(', ')}.`
    : '';
  // Read before the messages go, because after it there is nothing left to read them from. Here
  // rather than at the budget caller, which is where it used to live: an agent-declared compaction
  // drops messages exactly as durably, so on a turn that condensed because the agent said a phase
  // was over, the episode's `Touched:` list lost every path and command from before it.
  state.carriedArtifacts = [
    ...new Set([...(state.carriedArtifacts ?? []), ...extractTurn(state.messages).artifacts])
  ].slice(-64);
  const outcome = await compactContext({
    messages: state.messages,
    ...(state.contextBrief ? { brief: state.contextBrief } : {}),
    // A declaration is answered against the window in front of it; the budget trigger fires at a
    // window it already knows the size of, so its own target is the one derived from the budget.
    targetTailTokens:
      input.trigger === 'agent'
        ? declaredCompactionTargetTail(budget, estimatedContextTokens(state.messages))
        : compactionTargetTail(budget),
    transcriptChars: Math.min(80_000, Math.max(8_000, summariser.contextTokens * 2)),
    ...(input.note ? { note: input.note } : {}),
    ...(citableFooter ? { citableFooter } : {}),
    summarise: (request) =>
      summariseForCompaction(deps, task, state, summariser, request, input.turn)
  });
  if (!outcome) return null;
  state.messages = outcome.messages;
  state.contextBrief = outcome.brief;
  // The step after a compaction is the one most likely to make a wrong call, so it is recorded
  // for the effort ladder rather than inferred from the window afterwards.
  state.compactedAtStep = state.step;
  // The active plan is pushed onto the tail like any other message, so a compaction can condense
  // it away. Forgetting the version is what makes the caller's next plan refresh re-publish it;
  // without this the model would work on for the rest of the task with no plan in its window.
  if (
    !state.messages.some(
      (message) =>
        message.role === 'system' && message.content.startsWith('ACTIVE USER-VISIBLE PLAN')
    )
  )
    delete state.planVersion;
  /**
   * The acceptance record reaches the window only as a `set_acceptance` tool result, and a tool
   * result is exactly what a compaction condenses. So the model went on working against a
   * contract it could no longer read - and it is a contract with teeth: `finish` is refused while
   * any check fails, so the one thing it most needed to remember was the first thing to go.
   *
   * Re-pushed rather than re-declared, which is the same move the plan above makes: the record is
   * the harness's, `acceptanceAcceptedResult` already renders exactly the right text, and a model
   * asked to declare its checks again would be free to declare easier ones.
   */
  if (
    state.acceptance &&
    !state.messages.some(
      (message) => message.role === 'system' && message.content.startsWith(ACCEPTANCE_MARKER)
    )
  )
    state.messages.push({
      role: 'system',
      content: `${ACCEPTANCE_MARKER}\n${acceptanceAcceptedResult(state.acceptance)}`
    });
  await event(
    deps.store,
    task,
    key,
    'status',
    compactionEventSummary({
      trigger: input.trigger,
      condensedMessages: outcome.condensedMessages,
      source: outcome.section.source
    }),
    {
      compaction: {
        trigger: input.trigger,
        condensedMessages: outcome.condensedMessages,
        condensedCharacters: outcome.condensedCharacters,
        source: outcome.section.source,
        summarisedBy: outcome.section.source === 'model' ? summariser.displayName : null,
        // What was condensed, so the interface can show the record rather than only its size.
        brief: outcome.section.text,
        briefParts: outcome.brief.sections.length,
        totalCondensedMessages: outcome.brief.condensedMessages,
        estimatedTokensBefore: outcome.estimatedTokensBefore,
        estimatedTokensAfter: outcome.estimatedTokensAfter,
        contextWindowTokens: input.model.contextTokens
      }
    }
  );
  return outcome;
};
