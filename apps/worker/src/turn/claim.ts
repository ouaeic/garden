import { runtimeNow } from '@athanor/core';
import { CODING_CHILD_TOOLS } from '../coding-missions.js';
import { codingMissionView } from '@athanor/data';
/**
 * Everything a turn needs before it can say a word, gathered in one place.
 *
 * This was the first hundred and five lines of `AgentWorker.run()`: a straight run of loads and
 * one-time decisions - the workspace key, the prompt, the model and its gateway, the owner's time
 * zone, the saved trajectory, whether anybody is watching, where this run's web searches go, which
 * tools this box can honestly describe, and what every request will carry before a word of
 * conversation. None of it loops, none of it can be reached twice, and all of it is fixed for the
 * life of the run. It is the *claim* phase, and it was only ever inline because the loop it feeds
 * was written in the same function.
 *
 * What it returns is deliberately two things rather than one. `TurnRun` is frozen for the run;
 * `state` is the trajectory, and the caller mutates it from the next line onward. Handing back one
 * object that mixed them would make the read-only half look editable.
 */
import { ownerMessageContent, type OwnerMessage, decryptJson, unwrapDataKey } from '@athanor/core';
import {
  resolveWebToolPlan,
  type ConnectorKind,
  type ModelRelease,
  type WebToolPlan,
  type WorkspaceSurfaces
} from '@athanor/contracts';
import type { DataStore, TaskRecord, WorkspaceRecord } from '@athanor/data';
import type { ModelGateway, ModelTool } from '@athanor/model-gateway';
import type { AgentState, AgentWorkerConfig } from '../agent-state.js';
import { BASE_SYSTEM_PROMPT, COMPACT_CONTEXT_TOOL } from '../context.js';
import { agentToolsFor } from '../tools.js';
import { requestToolsFor } from '../request-tools.js';
import { applyProjectMainModel } from '../purpose-model.js';
import { routingForTurn } from '../routing-policy.js';
import type { ProviderPreferences } from '@athanor/core';

/** What claiming a turn needs from the worker that owns it. */
export interface TurnClaimDeps {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  readonly masterKey: Buffer;
  connectedModels(task: TaskRecord, catalog: readonly ModelRelease[]): Promise<ModelRelease[]>;
  gateway(
    task: TaskRecord,
    model: ModelRelease
  ): Promise<{
    gateway: ModelGateway;
    provider: string;
    credential: { provider: string; enforceZeroDataRetention: boolean };
  }>;
  startedBySchedule(task: TaskRecord, key: Uint8Array): Promise<boolean>;
  toolchainSummary(task: TaskRecord): Promise<string>;
  /** What this box can give one job. Never rejects; a probe that fails answers ''. */
  machineSummary(task: TaskRecord): Promise<string>;
  /** Whether this box has a browser and a screen. Never rejects; not knowing is `unknown`. */
  workspaceSurfaces(task: TaskRecord): Promise<WorkspaceSurfaces>;
}

/** What the turn is, once it has been claimed. Every field is fixed for the life of the run. */
export interface TurnRun {
  /** When this worker picked the turn up, which is what the wall-clock ceiling is measured from. */
  readonly turnStartedAt: number;
  readonly workspace: WorkspaceRecord;
  readonly key: Uint8Array;
  readonly prompt: string;
  readonly catalog: ModelRelease[];
  readonly model: ModelRelease;
  readonly gateway: ModelGateway;
  readonly provider: string;
  readonly timeZone: string;
  readonly unattended: boolean;
  readonly webPlan: WebToolPlan;
  /**
   * How this turn's requests choose between the companies serving the model, or absent where there
   * is nothing to choose between. @see providerPreferences - resolved once here because it costs a
   * store read and nothing it depends on changes inside a turn.
   */
  readonly providerPreferences: ProviderPreferences | undefined;
  /**
   * Whether this turn is the one that measures how fast the model's quickest company runs.
   *
   * The rule needs a ceiling to take its share of, and the aggregator publishes none - so a turn
   * with no fresh ceiling is routed to the quickest company it has and its generation is read
   * afterwards for the figure. The turn loses nothing by it: it is on the fastest route there is.
   */
  readonly measuringThroughput: boolean;
  /** Capabilities this box does not currently have, which are not described to the model. */
  readonly withdrawnTools: Set<string>;
  readonly requestTools: ModelTool[];
  readonly reservedTokens: number;
  readonly toolchainSummary: string;
  /**
   * Cores, memory and free disk, in the runner's words, frozen for the run.
   *
   * A property of the machine rather than of the step, so it is read once here beside the
   * toolchain probe and re-rendered from the frozen string on every step. It could not be read per
   * step even if it were free to: the runtime block is rewritten at the tail on every step, and a
   * disk figure that moved while a command wrote would make those bytes differ every time.
   */
  readonly machineSummary: string;
  /**
   * The surfaces this box has, frozen for the run.
   *
   * Carried on the run rather than re-probed, because the request is re-derived from it: the send
   * path in `turn/generate.ts` rebuilds `agentToolsFor` from the same two facts this used, and
   * `requestDerivationBreach` fails the turn if the two arrays differ. One field read twice is what
   * makes that comparison meaningful; two probes would make it a race.
   */
  readonly surfaces: WorkspaceSurfaces;
  /**
   * Which kinds of service the owner has connected, frozen for the run for the same reason as
   * `surfaces` and used the same way: the send path re-derives the catalogue from this list rather
   * than from a second read of the connector table.
   *
   * It has to be the frozen list and not a fresh query, and this is the field that made
   * `requestDerivationBreach` compare tool definitions rather than only tool names. A connector
   * enabled between the claim and the fourth step would re-derive a catalogue carrying the same
   * forty-one names and a different `connector_action` - so the name check that guarded every
   * other tool would have called it derivable, and the run would have sent a request its own
   * record did not account for.
   */
  readonly connectorKinds: readonly ConnectorKind[];
}

export const claimTurn = async (
  deps: TurnClaimDeps,
  task: TaskRecord
): Promise<{ run: TurnRun; state: AgentState }> => {
  /*
   * When this worker picked the turn up, which is what the wall-clock ceiling is measured from.
   *
   * A local rather than a field on the agent state, and the difference is the promise being made:
   * this bounds how long one worker may hold one lease without saying anything to the owner, so a
   * resumed turn gets a fresh allowance exactly as a new turn does. Persisting it would bound the
   * conversation instead, which the API's own resume contract does not.
   */
  const turnStartedAt = runtimeNow();
  const workspace = await deps.store.getWorkspaceById(task.workspaceId);
  if (!workspace?.wrappedKey) throw new Error('Workspace key not found');
  const key = unwrapDataKey(workspace.wrappedKey, deps.masterKey, workspace.id);
  const prompt = decryptJson<OwnerMessage>(task.promptCiphertext, key);
  const catalog = (await deps.store.listModels()) as unknown as ModelRelease[];
  const savedState = task.agentStateCiphertext
    ? decryptJson<AgentState>(task.agentStateCiphertext, key)
    : null;
  const state: AgentState = savedState ?? {
    messages: [
      { role: 'system', content: BASE_SYSTEM_PROMPT },
      { role: 'user', content: ownerMessageContent(prompt) }
    ],
    step: 0,
    credits: 0,
    turnToolResults: {},
    finishRejections: 0,
    completionNags: 0
  };
  await applyProjectMainModel(deps, task, state, catalog, key, deps.config.WORKER_ID);
  const model = catalog.find((entry) => entry.id === task.modelId);
  if (!model) throw new Error(`Model ${task.modelId} is no longer in the registry`);
  const { gateway, provider, credential } = await deps.gateway(task, model);
  // The owner's own day, taken from the spend limits that already store it rather than from a
  // second copy nobody keeps in step. Without it nothing in the prompt says what time it is, and
  // "by Friday", "last month" and a daily 8am brief are all guesses.
  const timeZone = await deps.store
    .effectiveSpendLimits(task.userId)
    .then((limits) => limits.timeZone)
    .catch(() => 'UTC');
  // Whether anyone is watching changes what the run should say, so it has to be known before the
  // runtime block is written. Probed only when the saved state does not already carry the answer:
  // a task that ran before this field existed pays one indexed row read, once, and then persists.
  const unattended = savedState?.unattended ?? (await deps.startedBySchedule(task, key));
  /**
   * Where this run's web searches go, decided once and then pinned.
   *
   * One call answers both parts of it - the route and the provider tool that implements it -
   * because asking separately would mean resolving twice against facts the owner can edit between
   * the two reads, and a run whose disclosure says one thing while its searches go somewhere else
   * is the failure the contract exists to prevent.
   *
   * `startedMode` carries the mode from the saved state, and it can only ever refuse: a run that
   * started in house finishes in house even if the credential is replaced mid-run with one whose
   * provider does answer searches. The other direction is deliberately not pinned - a fact that
   * has just made this task more private takes effect on the next step, and protecting a cache
   * prefix is not a reason to withhold it.
   *
   * What the route no longer decides is the catalogue. `web_search` and `parallel_web_read` are
   * offered under their own names on both routes and only the `web_search` arm in `tools/web.ts`
   * knows the difference, so the mode cannot leave the model looking for a tool that is not there
   * - which is precisely what it did, and what a research question then got answered out of
   * memory because of.
   *
   * Resolved here, ahead of the runtime block, because the block has to say which route is in
   * force: on the provider's route the query itself leaves this computer, and that is the one
   * fact about the web the model cannot work out from its tool schemas.
   */
  const webPlan = resolveWebToolPlan({
    provider: credential.provider,
    forceInHouse: deps.config.AI_FORCE_INHOUSE_WEB,
    ...(savedState?.webToolMode ? { startedMode: savedState.webToolMode } : {})
  });
  /*
   * Which of the companies serving this model should get the work.
   *
   * The aggregator serves one model from several at different prices and wildly different speeds,
   * and given no preference it picks among the cheapest weighted by the inverse square of price.
   * For an agent that is the wrong objective: a turn is dozens of sequential calls, so throughput
   * is the wall-clock cost of the whole task, and the cheapest operator of a model is routinely the
   * slowest by a large factor.
   *
   * Both halves of the rule are applied by the aggregator: it compares each company's throughput
   * against the floor, using figures taken across every request it has ever served, and orders what
   * clears it by price. What this side supplies is the floor, as a share of how fast the model's
   * quickest company actually runs. @see providerPreferences.
   */
  const routing =
    credential.provider === 'openrouter'
      ? await routingForTurn({ store: deps.store, model, userId: task.userId }).catch(() => ({
          preferences: undefined,
          measuring: false
        }))
      : { preferences: undefined, measuring: false };
  const withdrawnTools = new Set<string>();
  // Keep discovery available without advertising actions for disconnected services.
  /**
   * And when something *is* connected, only the actions that connection can actually run.
   *
   * The withdrawal above is all-or-nothing and the enum underneath it was too: twenty-four actions
   * across mail, calendar, GitHub, WebDAV and MCP, sent whole to a box that had connected one of
   * the five. `executeConnectorAction` in @athanor/core refuses any action whose `kind` is not the
   * connector's - "Action does not match this connector", thrown before a scope is checked or a
   * credential is opened - so those were not unlikely calls, they were impossible ones, described
   * at the head of the cached prefix on every request of every task. Measured through
   * `agentToolsFor`: 1,293 bytes on a mailbox-and-calendar box, 2,511 on a mailbox alone, 5,069
   * where the one connection is an MCP server, and 0 where all five are connected - which is the
   * property that makes it honest, because nothing is withdrawn from a box that has the thing.
   *
   * Frozen here with the rest, for the reason the whole file exists: this decides the head of the
   * cached prefix, and a set re-read at step four would move every byte behind it. A connection
   * made mid-turn therefore arrives on the next turn, exactly as the withdrawal above already
   * behaves.
   *
   * Narrowed by kind and deliberately not by granted scope, though `executeConnectorAction`
   * refuses on scope two lines later and just as hard. The difference is where the model finds out
   * what it is missing: `connector_list`'s own resident description names all five kinds, so a
   * kind that is absent from the enum is still a kind the model can read about and ask the owner
   * to connect. There is no equivalent resident line for a scope, and how often an owner grants a
   * read-only mailbox is not measured anywhere in this repository. It is worth 2,094 further bytes
   * on a read-only mailbox and calendar, and it should be taken by whoever measures that, not
   * before.
   */
  const connectorKinds = [
    ...new Set(
      (await deps.store.listConnectors(task.userId))
        .filter((connector) => connector.enabled)
        .map((connector) => connector.kind)
    )
  ];
  if (!connectorKinds.length) withdrawnTools.add('connector_action');
  // Hardware and connected accounts are frozen; enabled groups grow only at settled tool boundaries.
  const surfaces = await deps.workspaceSurfaces(task);
  if (task.parentMissionId)
    for (const tool of [...agentToolsFor('lead', surfaces, connectorKinds), COMPACT_CONTEXT_TOOL])
      if (!CODING_CHILD_TOOLS.has(tool.name)) withdrawnTools.add(tool.name);
  const requestTools = () =>
    requestToolsFor(surfaces, connectorKinds, state.enabledToolGroups ?? [], withdrawnTools);
  const [toolchainSummary, machineSummary] = await Promise.all([
    deps.toolchainSummary(task),
    deps.machineSummary(task)
  ]);
  if (state.codingMissionWaiting) {
    const missions = await deps.store.listCodingMissions(task.userId, task.id);
    state.messages.push({
      role: 'system',
      content: JSON.stringify({
        codingMissionStatus: missions.map((m) => codingMissionView(m, key)),
        instruction:
          'Inspect completed specialist changes using coding_agent review before integrating. Failed or cancelled missions do not imply completed work.'
      })
    });
    delete state.codingMissionWaiting;
  }
  state.unattended = unattended;
  state.ownerReasoningEffort = task.reasoningEffort ?? state.ownerReasoningEffort ?? 'auto';
  state.turnToolResults ??= {};

  return {
    run: {
      turnStartedAt,
      workspace,
      key,
      prompt: prompt.prompt,
      catalog,
      model,
      gateway,
      provider,
      timeZone,
      unattended,
      webPlan,
      providerPreferences: routing.preferences,
      measuringThroughput: routing.measuring,
      withdrawnTools,
      get requestTools() {
        return requestTools();
      },
      get reservedTokens() {
        return Math.ceil(JSON.stringify(requestTools()).length / 4);
      },
      toolchainSummary,
      machineSummary,
      surfaces,
      connectorKinds
    },
    state
  };
};
