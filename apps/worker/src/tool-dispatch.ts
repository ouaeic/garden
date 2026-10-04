import { executeProjectUpdate } from './project-updates.js';
import { enableToolGroups, rememberToolGroup } from './tool-groups.js';
import { CODING_CHILD_TOOLS } from './coding-missions.js';
import type { ModelRelease, WebToolPlan } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import type { ModelGateway, ModelToolCall } from '@garden/model-gateway';
import type { AgentState, AgentWorkerConfig, InferenceCredential } from './agent-state.js';
import { executeDelegateTool } from './delegate.js';
import type { DestinationContext } from './egress.js';
import type { WebSearchAnswer } from './provider-search.js';
import type { AgentRunnerClient } from './runner-client.js';
import { executeConnectorTool } from './tools/connectors.js';
import { executeDocumentTool } from './tools/documents.js';
import { executeKnowledgeTool } from './tools/knowledge.js';
import { executePlanTool } from './tools/plan.js';
import { executePublishingTool } from './tools/publishing.js';
import { executeRepositoryTool } from './tools/repository.js';
import { executeSchedulingTool } from './tools/scheduling.js';
import { executeSurfaceTool } from './tools/web.js';
import { executeWorkspaceTool } from './tools/workspace.js';

/**
 * The tool dispatch table: what each of the agent's tools actually does.
 *
 * This was a 2,110-line `#execute` switch inside `AgentWorker`, one method holding every arm of
 * every tool the model can call. Nothing about the arms needs the loop class - they need a store, a
 * runner, a workspace key and the turn they belong to - and holding them there meant the loop and
 * the catalogue could only ever be read together. The arms moved out verbatim; what each one asks
 * the runner for is unchanged, which `tool-dispatch.test.ts` asserts on the wire for all of them.
 *
 * `webPlan` and `state` are **required** here, where the method's parameters had them optional.
 * Without state, a delegated specialist's provider-side web search would write its credits to the
 * ledger and charge them to nothing the turn could see; a required parameter makes the fact arrive
 * rather than relying on someone remembering to pass it.
 */
export interface ToolContext {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  readonly runner: AgentRunnerClient;
  readonly masterKey: Buffer;
  /** The task this call belongs to, and the workspace key its records are written under. */
  readonly task: TaskRecord;
  readonly key: Uint8Array;
  /** Whether the owner has already approved the consequential form of this call. */
  readonly consequentialApproved: boolean;
  /** The run's pinned web route, for the tools whose answerer it decides. */
  readonly webPlan: WebToolPlan;
  /** The turn's state, for the tools that have to remember something across calls. */
  readonly state: AgentState;
  /**
   * The context window whose evidence this call's reads are, when it is not the task's own.
   *
   * The worker's read record - what has been shown, which lines, the outstanding remainder of a
   * partly-read file - is a fact about one window, and it was keyed by task id alone. A delegated
   * specialist reads through the same arms with the same task, so its `file_read` of a whole
   * file landed on the lead's record and lifted the lead's own floor: a lead shown fifty lines of
   * a four-hundred-line file could delegate "read it and summarise", then replace the file whole
   * from the shell with nothing refusing. The runner's ledger already told the two windows apart
   * by the signed subject; this is the worker's side of the same distinction. Absent for the
   * lead, whose window is the task.
   */
  readonly reader?: string;
  /*
   * The four things an arm needs that are still the worker's: a provider credential, the
   * provider-side search route, the toolchain probe cache, and the run's destination corpus. Each
   * closes over per-worker state (the master key, the gateway, the binary cache) that has no
   * business being copied per call, so they arrive as bound functions rather than as data.
   */
  readonly connectedModels: (
    task: TaskRecord,
    catalog: readonly ModelRelease[]
  ) => Promise<ModelRelease[]>;
  readonly inferenceCredential: (
    task: TaskRecord,
    resolveMedia?: boolean
  ) => Promise<InferenceCredential>;
  /*
   * `state` is required here for the same reason it is required on the context above, and it was
   * the last place in this file still saying otherwise.
   *
   * The optional parameter is what let a delegated specialist's provider-side search arrive with
   * no state, so the credits it spent were written to the ledger and charged to nothing the turn
   * could see. That defect is closed - the only caller now always passes one - but the signature
   * still read as permission to omit, which is exactly the shape that produced it. A parameter
   * whose absence is a bug is not an optional parameter.
   */
  readonly providerWebSearch: (
    task: TaskRecord,
    call: ModelToolCall,
    webPlan: WebToolPlan,
    state: AgentState
  ) => Promise<WebSearchAnswer>;
  readonly missingBinaries: (task: TaskRecord, binaries: readonly string[]) => Promise<string[]>;
  readonly destinationContext: (state?: AgentState) => DestinationContext;
  /*
   * And two more that only `delegate` reaches for, because only `delegate` runs a model turn of its
   * own. They sit on the one context every arm is given rather than on a second one the delegate
   * arm would have to be handed separately: a table whose entries take different context types is a
   * table that cannot be indexed by tool name, which is the whole shape being bought here.
   */
  /*
   * The dispatcher itself, so the one arm that re-enters it does not have to import it.
   *
   * `delegate` runs a model turn of its own, and every tool call that turn makes goes back
   * through `executeToolCall`. Reaching for it by import made `delegate.ts` and this file a
   * two-module runtime import cycle - the last one in the tree once `agent.ts`'s re-export shim
   * stopped holding the other ten modules open. Handing it over at the construction site instead
   * is the same recursion written so that the dependency runs one way: this file imports the arm,
   * the arm does not import this file. A specialist's sub-context is `{...context, …}`, so it
   * carries the dispatcher without anything having to remember to pass it.
   */
  readonly dispatch: (context: ToolContext, call: ModelToolCall) => Promise<unknown>;
  readonly gateway: (
    task: TaskRecord,
    model: ModelRelease
  ) => Promise<{
    gateway: ModelGateway;
    provider: string;
    credential: { provider: string; enforceZeroDataRetention: boolean };
  }>;
  readonly assertProviderConfigured: (task: TaskRecord) => Promise<void>;
}

/** What answers one tool call. Every domain module exports exactly one of these. */
type ToolDomain = (context: ToolContext, call: ModelToolCall) => Promise<unknown>;

/**
 * Which module answers each tool.
 *
 * A table rather than a chain of `if`s or a switch that fans out: the tool names are the product's
 * public surface - they are what the catalogue advertises and what the model sends - and one place
 * that lists all of them against their answerers is the only artefact in which "is this tool
 * wired up" is a question you can answer by looking. The arms live in the nine domain modules
 * imported above, plus `delegate.ts`.
 *
 * The one thing a table can be that a switch cannot is incomplete: a tool in the catalogue with
 * no row here reaches `Unknown tool` instead of an arm. `tool-dispatch.test.ts` drives every name
 * in the catalogue through this function, which is what makes that failure impossible to land.
 *
 * Nothing falls through. Every arm returns or throws, so grouping them across modules cannot
 * change which one runs - and a name that is not here reaches `Unknown tool`.
 */
const DOMAIN_OF: Readonly<Record<string, ToolDomain>> = {
  load_tools: async (context, call) => enableToolGroups(context.state, call.arguments),
  set_plan: executePlanTool,
  project_update: executeProjectUpdate,
  shell: executeWorkspaceTool,
  process: executeWorkspaceTool,
  files_list: executeWorkspaceTool,
  file_read: executeWorkspaceTool,
  file_patch: executeWorkspaceTool,
  image_read: executeWorkspaceTool,
  file_write: executeWorkspaceTool,
  code_search: executeRepositoryTool,
  repo_overview: executeRepositoryTool,
  code_diagnostics: executeRepositoryTool,
  coding_agent: executeRepositoryTool,
  document_read: executeDocumentTool,
  audio_read: executeDocumentTool,
  document_search: executeDocumentTool,
  generate_media: executeDocumentTool,
  browser_snapshot: executeSurfaceTool,
  read_elements: executeSurfaceTool,
  print_pdf: executeSurfaceTool,
  web_search: executeSurfaceTool,
  parallel_web_read: executeSurfaceTool,
  browser_action: executeSurfaceTool,
  desktop_observe: executeSurfaceTool,
  desktop_launch: executeSurfaceTool,
  desktop_action: executeSurfaceTool,
  publish_artifact: executePublishingTool,
  publish_preview: executePublishingTool,
  session_search: executeKnowledgeTool,
  memory_recall: executeKnowledgeTool,
  memory: executeKnowledgeTool,
  skill: executeKnowledgeTool,
  schedule: executeSchedulingTool,
  connector_list: executeConnectorTool,
  connector_action: executeConnectorTool,
  delegate: executeDelegateTool
};

/**
 * Runs one tool call and returns what the model is handed back.
 *
 * The message on the unknown-tool throw is the switch's own, word for word: it reaches the model as
 * a tool failure and a model that has just been told a different sentence than the one it was told
 * last week is a model that retries differently.
 */
export async function executeToolCall(context: ToolContext, call: ModelToolCall): Promise<unknown> {
  if (context.task.parentMissionId && !CODING_CHILD_TOOLS.has(call.name))
    throw new Error('This capability is outside the coding specialist workspace');
  const domain = DOMAIN_OF[call.name];
  if (!domain) throw new Error(`Unknown tool ${call.name}`);
  rememberToolGroup(context.state, call.name);
  return domain(context, call);
}
