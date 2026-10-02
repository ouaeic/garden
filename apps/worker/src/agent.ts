import { OwnerPreferences } from '@garden/contracts';
import {
  runtimeClearTimer,
  runtimeDate,
  runtimeSetInterval,
  runtimeSleep,
  runtimeUUID
} from '@garden/core';
import {
  withPrivateDiagnostics,
  observedObject,
  runtimeObservations,
  runtimeCall,
  runtimeValue
} from '@garden/core';
import { TaskDiagnosticCapture } from './diagnostic-capture.js';
import { askUser, parkBrowserHandoff, saveQuestion } from './questions.js';
import { BrowserActionReceipt } from '@garden/contracts';
import { browserActionRequestId } from './browser-action-receipts.js';
import { codingMissionAdapter } from './coding-mission-gateway.js';
import type { ReasoningEffort } from '@garden/contracts';

import {
  MAX_AGENT_NOTIFICATIONS_PER_TASK,
  UNKNOWN_SURFACES,
  WorkspaceSurfaces,
  type ModelRelease,
  type SpendDecision,
  type TaskPlanStep,
  type WebToolPlan
} from '@garden/contracts';
import {
  type OwnerMessage,
  decryptJson,
  encryptJson,
  readInferenceConnections,
  modelConnectionId,
  GardenError,
  selectModel,
  sha256,
  unwrapDataKey,
  type MemoryDeadEndCheck
} from '@garden/core';
import {
  agentNotificationAad,
  TASK_MAX_ATTEMPTS,
  readTaskModelPreferences,
  mergeProjectModelChoices
} from '@garden/data';
import type { DataStore, TaskRecord, WorkspaceRecord } from '@garden/data';
import {
  fetchGenerationThroughput,
  isProviderWall,
  ModelGateway,
  MediaRouteResolver,
  createModelAdapter,
  OpenRouterDecisionAdapter,
  type ModelResponse,
  type ModelToolCall
} from '@garden/model-gateway';
import {
  type AcceptanceCommandCheck,
  type AcceptanceRecord,
  type AcceptanceResult
} from './acceptance.js';
import type { AgentState, AgentWorkerConfig, InferenceCredential } from './agent-state.js';
import { type AgentApprovalRequirement } from './approval-state.js';
import {
  estimatedInferenceCostUsd,
  reservationUsageKey,
  stepUsageKey,
  usageCredit
} from './billing.js';
import { startTurnState, type CompletionVerification } from './completion.js';
import { originOf, type DestinationContext } from './egress.js';
import {
  dropLegacyGuidance,
  ensureBasePrompt,
  type CompactionOutcome,
  type PreparedContext
} from './context.js';
import { taskFailureRecord } from './failure-record.js';
import { pinnedPurposeModel, taskModelRoster } from './purpose-model.js';
import { workerLogger, type Logger } from './log.js';
import {
  botWallSite,
  originsFromOwnerMessages,
  takeoverNotice,
  type BotWall
} from './provenance.js';
import { providerWebSearch, type WebSearchAnswer } from './provider-search.js';
import { WEB_SEARCH_MAX_OUTPUT_TOKENS, WEB_SEARCH_REQUEST_TIMEOUT_MS, routeTo } from './routing.js';
import { executeToolCall } from './tool-dispatch.js';
import { AgentRunnerClient, withRunnerAbort } from './runner-client.js';
import { buildIdentity } from './build-identity.js';
import {
  CHECKPOINT_EXEMPT_TOOLS,
  MAX_NOTICES_PER_TURN,
  ownerFixableCheckpointFailure,
  spendHalt,
  spendWarning
} from './turn-bounds.js';
import {
  CANCELLATION_POLL_INTERVAL_MS,
  TASK_LEASE_SECONDS,
  haltReason,
  retryTurnHandoff,
  sealUnansweredToolCalls,
  withPeriodicRenewal,
  withRequestDeadline
} from './turn-lifecycle.js';
import { runAcceptanceChecks, type AcceptanceRunnerDeps } from './acceptance-runner.js';
import {
  approvalForCallOnce,
  type ApprovalFloorDeps,
  type ApprovalFloorMemo
} from './approval-floor.js';
import { compactTurnContext, type CompactionDeps } from './compaction.js';
import {
  drainCorrection as drainCorrection_,
  honorUserControl as honorUserControl_,
  type TurnControlDeps
} from './turn-control.js';
import {
  assemblePreamble,
  refreshActivePlan as refreshActivePlan_,
  refreshRuntimeContext as refreshRuntimeContext_,
  type WindowDeps
} from './window.js';
import { renewStepBudget, stepCeiling, type HandoffDeps } from './handoff.js';
import { captureMemory, type MemoryCaptureDeps } from './memory-capture.js';
import {
  event,
  recordToolFailure,
  recordToolResult,
  raiseTaint,
  runToolCallsTogether,
  type ToolRecordingDeps
} from './tool-recording.js';
import { closeTurnAtCeiling, type TurnCloseContext } from './turn/close.js';
import { claimTurn, type TurnClaimDeps } from './turn/claim.js';
import { type AcceptanceDeclarationDeps } from './turn/acceptance-declaration.js';
import { resolveAnswerHolds } from './turn/answer-holds.js';
import type { TurnCompleteDeps } from './turn/complete.js';
import { resumeParkedTurn, type TurnResumeDeps } from './turn/resume.js';
import { enforceStepBounds, type StepBoundsDeps } from './turn/step-bounds.js';
import { dispatchToolCalls, type TurnDispatchDeps } from './turn/dispatch.js';
import { generateModelStep, type TurnGenerateDeps } from './turn/generate.js';
import { nativeInputAdapter } from './native-input-gateway.js';
import { nativeCredentialBinding } from './native-input.js';
import { recordModelStepUsage } from './billing.js';
import type { TurnLoopControl, TurnStepBudget } from './turn/loop-context.js';
import { recordAssistantStep, type TurnRecordStepDeps } from './turn/record-step.js';
import { prepareStepRequest, type TurnRequestDeps } from './turn/request.js';
import { openStep, type TurnStepOpenDeps } from './turn/step-open.js';
import { textValue } from './values.js';
import {
  currentCatalog,
  routeImageObservation,
  type CatalogCache,
  type VisionDeps
} from './vision.js';

/**
 * The provider walls this box can actually park a task behind.
 *
 * Must stay equal to the keys of `providerWalls` in `apps/api/src/maintenance/provider-walls.ts`.
 * The recovery sweep there reads the code off the task's own failure event, looks it up in that
 * table, and skips a task whose code it does not recognise - so parking work under a name the sweep
 * has never heard of leaves it in `awaiting_resource` with nothing left that would ever pick it up.
 * `isProviderWall` is the wider question, asked first; this is the narrower one about what recovery
 * exists.
 *
 * The file reference above read `apps/api/src/server.ts` and had been wrong since Wave 6 moved the
 * table; `server.ts` is 297 lines and has not held it since. Both halves of that are now closed:
 * the path is right, and this pair is the ninth entry in `scripts/check-repository.mjs`'s copied-
 * constant table, so the two lists agree because something checks rather than because somebody did.
 */
const PARKABLE_PROVIDER_WALLS = new Set([
  'provider_quota_exhausted',
  'provider_not_connected',
  'provider_unavailable'
]);

/**
 * What something outside `apps/worker/src` reaches for, and nothing else.
 *
 * `@garden/worker`'s package `exports` map names one entry - this file - so a name another
 * package needs has to be re-exported here or it cannot be imported at all. That is the whole
 * justification for this block, and it is the only one.
 *
 * It used to carry 154 names. Two decompositions (Wave 5's three leaves, Wave 7.1's twelve
 * siblings) each re-exported their entire moved surface from here so that no importer had to move
 * on the same commit, and both blocks said in their own comments that they went once the importers
 * named the sibling directly. Ninety-nine of the 154 had no importer anywhere by the time anyone
 * counted, and the fifty-five that did were mostly `apps/worker`'s own files reaching sideways
 * through the package root - which is what made this file the sole cause of a twelve-module runtime
 * import cycle: every `tools/*.ts` arm and `delegate.ts` imported `agent.js`, and `agent.ts`
 * imports the dispatcher that imports them back.
 *
 * The rule that keeps it from growing again: **a name goes in this block only when a file outside
 * `apps/worker/src` imports it.** Anything inside the package names its sibling. `scripts/
 * check-repository.mjs` has no check for this, so the guard is that every line below names its
 * importer.
 */
export { buildIdentity } from './build-identity.js'; // apps/api/src/routes/relay.ts
export { failureFields, taskFailureRecord } from './failure-record.js'; // apps/worker/src/agent.test.ts
export { connectorHostAllowance } from './connector-call.js'; // apps/api/src/context.ts
export { ACCEPTANCE_MARKER, startTurnState } from './completion.js'; // apps/api/src/routes/tasks.ts, apps/worker/src/context.test.ts
export { approvalPreviewHash } from './approval-state.js'; // apps/worker/src/tool-dispatch.test.ts
export { MAX_NOTICES_PER_TURN, PUSHBACK_MARKERS, type PushbackName } from './turn-bounds.js'; // evals/harness.ts, apps/worker/src/tool-catalogue.test.ts
export {
  createLogger,
  journalLevelPrefix,
  silentLogger,
  type Logger,
  type LoggerOptions,
  type LogFields,
  type LogLevel,
  type LogThreshold,
  type LogValue
} from './log.js'; // apps/api/src/log.ts re-exports the whole set to services that cannot depend on the worker

export class AgentWorker {
  readonly #masterKey: Buffer;
  readonly #runner: AgentRunnerClient;
  /**
   * When each workspace's memory was last consolidated. Held in the worker rather than the store
   * because the cadence is an optimisation, not a guarantee: a restart costs one extra run of an
   * idempotent maintenance pass, which is cheaper than a table and a lock to avoid it.
   */
  readonly #memoryConsolidatedAt = new Map<string, number>();
  /**
   * Binaries this process has seen present on a workspace, so a skill opened twice costs one probe.
   *
   * Only presence is cached. A binary that was missing is exactly the one the owner may have just
   * approved an install for, and a cached "still missing" would then argue the agent out of a
   * procedure that now works - so an absence is re-probed, which is one cheap runner call in the
   * only case where the answer can have changed.
   */
  readonly #presentBinaries = new Map<string, Set<string>>();
  /**
   * Stacks this process has already written to the journal. Held per worker rather than per task
   * because the failure that repeats is rarely one task's: a provider that is refusing everything
   * fails every task in the queue with the same trace, and a restart is what clears the memory.
   */
  readonly #loggedFailureStacks = new Set<string>();

  /**
   * The registry rows this worker last read, and when. One slot per worker rather than one per
   * module: a catalogue is per-installation state, and a module-level memo would be shared by every
   * worker in the process and by every test in a file.
   */
  readonly #catalogCache: { current: CatalogCache | null } = { current: null };

  /**
   * What the sub-machines lifted in Wave 7.2 are handed instead of `this`.
   *
   * Built once in the constructor and frozen by construction - every member is either a store, a
   * config or a bound method - so the cost of the split is one object per worker rather than one
   * per call. Methods are wrapped in arrow functions rather than passed by reference because a
   * private method detached from its receiver cannot reach `#` fields.
   */
  readonly #toolRecording: ToolRecordingDeps;

  readonly #vision: VisionDeps;

  readonly #compaction: CompactionDeps;

  readonly #memoryCapture: MemoryCaptureDeps;

  readonly #approvalFloor: ApprovalFloorDeps;

  readonly #acceptanceRunner: AcceptanceRunnerDeps;

  readonly #handoff: HandoffDeps;

  readonly #window: WindowDeps;

  readonly #turnControl: TurnControlDeps;

  /** @see enforceStepBounds in `turn/step-bounds.ts`. */
  readonly #stepBounds: StepBoundsDeps;

  /** @see claimTurn in `turn/claim.ts`. */
  readonly #claim: TurnClaimDeps;

  /** @see resumeParkedTurn in `turn/resume.ts`. */
  readonly #resume: TurnResumeDeps;

  /** @see completeAnswer in `turn/complete.ts`. */
  readonly #finish: TurnCompleteDeps;

  /** @see declareAcceptance in `turn/acceptance-declaration.ts`. */
  readonly #acceptance: AcceptanceDeclarationDeps;

  /** @see openStep in `turn/step-open.ts`. */
  readonly #stepOpen: TurnStepOpenDeps;

  /** @see prepareStepRequest in `turn/request.ts`. */
  readonly #request: TurnRequestDeps;

  /** @see generateModelStep in `turn/generate.ts`. */
  readonly #generate: TurnGenerateDeps;

  /** @see dispatchToolCalls in `turn/dispatch.ts`. */
  readonly #dispatch: TurnDispatchDeps;

  /** @see recordAssistantStep in `turn/record-step.ts`. */
  readonly #recordStep: TurnRecordStepDeps;

  constructor(
    private readonly store: DataStore,
    private readonly config: AgentWorkerConfig,
    masterKey: Uint8Array,
    runnerSharedSecret: string,
    /**
     * Where this worker's own records go. The API runs one of these inside its own process, and a
     * failure there belongs in the API's journal at the API's threshold rather than in a second
     * stream nobody configured.
     */
    private readonly logger: Logger = workerLogger,
    private readonly mediaRouting: Pick<MediaRouteResolver, 'resolve'> = new MediaRouteResolver()
  ) {
    if (masterKey.byteLength !== 32) throw new Error('Agent worker master key must be 32 bytes');
    this.#masterKey = Buffer.from(masterKey);
    store = observedObject(store, 'store');
    this.store = store;
    this.mediaRouting = observedObject(mediaRouting, 'mediaRouting');
    this.#runner = observedObject(
      new AgentRunnerClient(config.WORKSPACE_RUNNER_URL, runnerSharedSecret),
      'runner'
    );
    this.#claim = {
      store,
      config,
      masterKey: this.#masterKey,
      gateway: (task, model) => this.#gateway(task, model),
      connectedModels: (task, catalog) => this.#connectedModels(task, catalog),
      startedBySchedule: (task, key) => this.#startedBySchedule(task, key),
      toolchainSummary: (task) => this.#toolchainSummary(task),
      machineSummary: (task) => this.#machineSummary(task),
      workspaceSurfaces: (task) => this.#workspaceSurfaces(task)
    };
    this.#stepBounds = {
      store,
      outstandingPlanSteps: (task, key) => this.#outstandingPlanSteps(task, key),
      completeTurn: (task, key, state, completion) =>
        this.#completeTurn(task, key, state, completion)
    };
    this.#toolRecording = {
      store,
      config,
      raiseTakeover: (task, key, state, wall) => this.#raiseTakeover(task, key, state, wall),
      ensureTurnUndoPoint: (task, key, state, tool) =>
        this.#ensureTurnUndoPoint(task, key, state, tool),
      checkpoint: (task, key, state) => this.#checkpoint(task, key, state),
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation),
      withCancellationWatch: (task, operation) => this.#withCancellationWatch(task, operation),
      execute: (task, call, key, approved, webPlan, state) =>
        this.#execute(task, call, key, approved, webPlan, state),
      destinationContext: (state) => this.#destinationContext(state),
      recordToolResult: (task, key, state, call, result, leadModel, catalog) =>
        this.#recordToolResult(task, key, state, call, result, leadModel, catalog)
    };
    this.#resume = {
      ...this.#toolRecording,
      browserActionReceipt: async (task, state, callId) => {
        const id = browserActionRequestId(task.id, state, callId);
        const result = await this.#runner.call<{ receipt: unknown }>(
          task.workspaceId,
          task.id,
          'browser.read',
          `/v1/workspaces/${task.workspaceId}/browser/receipts/${id}`
        );
        return result.receipt ? BrowserActionReceipt.parse(result.receipt) : null;
      },
      recordToolFailure: (task, key, state, call, error) =>
        this.#recordToolFailure(task, key, state, call, error)
    };
    this.#acceptance = {
      store,
      runner: this.#runner,
      runAcceptanceChecks: (task, key, record, options, state) =>
        this.#runAcceptanceChecks(task, key, record, options, state)
    };
    this.#finish = {
      store,
      runner: this.#runner,
      config,
      outstandingPlanSteps: (task, key) => this.#outstandingPlanSteps(task, key),
      runAcceptanceChecks: (task, key, record, options, state) =>
        this.#runAcceptanceChecks(task, key, record, options, state),
      completeTurn: (task, key, state, completion, options) =>
        this.#completeTurn(task, key, state, completion, options)
    };
    this.#vision = {
      store,
      catalogCache: this.#catalogCache,
      assertProviderConfigured: (task) => this.#assertProviderConfigured(task),
      gateway: (task, model) => this.#gateway(task, model),
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation)
    };
    this.#compaction = {
      store,
      assertProviderConfigured: (task) => this.#assertProviderConfigured(task),
      gateway: (task, model) => this.#gateway(task, model),
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation),
      currentCatalog: (fallback) => this.#currentCatalog(fallback),
      /*
       * The context the purpose resolver needs, assembled rather than passing `this`: it wants a
       * store, the master key and a way to read this task's credential, and the worker holds all
       * three privately.
       */
      pinnedSummariser: (task, catalog) =>
        pinnedPurposeModel(
          {
            store,
            masterKey: this.#masterKey,
            connectedModels: (forTask, catalog) => this.#connectedModels(forTask, catalog)
          },
          task,
          'summarise',
          catalog
        )
    };
    this.#memoryCapture = {
      store,
      memoryConsolidatedAt: this.#memoryConsolidatedAt
    };
    this.#approvalFloor = {
      store,
      masterKey: this.#masterKey,
      runner: this.#runner,
      inferenceCredential: (task, resolveMedia) => this.#inferenceCredential(task, resolveMedia),
      destinationContext: (state) => this.#destinationContext(state)
    };
    this.#acceptanceRunner = {
      store,
      runner: this.#runner,
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation),
      withCancellationWatch: (task, operation) => this.#withCancellationWatch(task, operation)
    };
    this.#handoff = {
      store,
      config,
      runAcceptanceChecks: (task, key, record, options, state) =>
        this.#runAcceptanceChecks(task, key, record, options, state),
      checkpoint: (task, key, state) => this.#checkpoint(task, key, state),
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation),
      outstandingPlanSteps: (task, key) => this.#outstandingPlanSteps(task, key),
      execute: (task, call, key, approved, webPlan, state) =>
        this.#execute(task, call, key, approved, webPlan, state),
      recordToolResult: (task, key, state, call, result, leadModel, catalog) =>
        this.#recordToolResult(task, key, state, call, result, leadModel, catalog),
      completeTurn: (task, key, state, completion, options) =>
        this.#completeTurn(task, key, state, completion, options)
    };
    this.#window = { store, config, runner: this.#runner, masterKey: this.#masterKey };
    this.#turnControl = {
      store,
      config,
      runner: this.#runner,
      logger: this.logger,
      checkpoint: (task, key, state) => this.#checkpoint(task, key, state)
    };
    /*
     * The four phases of one step, in the order the loop runs them. Assembled last because three of
     * the four name a set assembled above - the handoff, the finish, the acceptance and the resume
     * sets - and a field read before its own assignment is `undefined` at the one moment it matters.
     */
    this.#stepOpen = {
      handoff: this.#handoff,
      haltIfOutOfMoney: (task, key, state) => this.#haltIfOutOfMoney(task, key, state)
    };
    this.#recordStep = {
      store,
      raiseTaint: (task, key, state, origin, tool) =>
        this.#raiseTaint(task, key, state, origin, tool)
    };
    this.#request = {
      compactContext: (task, key, state, input) => this.#compactContext(task, key, state, input),
      assertProviderConfigured: (task) => this.#assertProviderConfigured(task)
    };
    this.#generate = {
      runner: this.#runner,
      store,
      config,
      checkpoint: (task, key, state) => this.#checkpoint(task, key, state),
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation),
      billModelStep: (task, key, state, input) => this.#billModelStep(task, key, state, input),
      compactContext: (task, key, state, input) => this.#compactContext(task, key, state, input),
      noteRepeatingAnswer: (task, key, state, repeated) =>
        this.#noteRepeatingAnswer(task, key, state, repeated)
    };
    this.#dispatch = {
      store,
      config,
      acceptance: this.#acceptance,
      resume: this.#resume,
      approvalForCallOnce: (memo, task, call, state) =>
        this.#approvalForCallOnce(memo, task, call, state),
      runToolCallsTogether: (task, key, state, calls, context) =>
        this.#runToolCallsTogether(task, key, state, calls, context),
      recordToolResult: (task, key, state, call, result, leadModel, catalog) =>
        this.#recordToolResult(task, key, state, call, result, leadModel, catalog),
      compactContext: (task, key, state, input) => this.#compactContext(task, key, state, input),
      sendNotice: (task, key, state, call) => this.#sendNotice(task, key, state, call),
      askUser: (task, key, state, call) => askUser(this.#turnControl, task, key, state, call)
    };
  }

  async #inferenceConnections(task: TaskRecord): Promise<Map<string, InferenceCredential>> {
    const connections = readInferenceConnections<InferenceCredential>({
      rows: await this.store.listManagedProviderCredentials(task.userId),
      userId: task.userId,
      masterKey: this.#masterKey,
      environment: this.config
    });
    return new Map([...connections].map(([id, connection]) => [id, connection.secret]));
  }

  async #connectedModels(
    task: TaskRecord,
    catalog: readonly ModelRelease[]
  ): Promise<ModelRelease[]> {
    const connections = await this.#inferenceConnections(task);
    return catalog.filter((model) => modelConnectionId(model, connections.keys()) !== null);
  }

  async #credentialForModel(task: TaskRecord, model: ModelRelease): Promise<InferenceCredential> {
    const connections = await this.#inferenceConnections(task);
    const id = modelConnectionId(model, connections.keys());
    const secret = id ? connections.get(id) : undefined;
    if (!secret)
      throw new GardenError(
        'provider_model_mismatch',
        'The selected model has no available connection. Check its provider in Settings.',
        409
      );
    return secret;
  }

  async #inferenceCredential(task: TaskRecord, resolveMedia = false): Promise<InferenceCredential> {
    const connections = await this.#inferenceConnections(task);
    const model = resolveMedia
      ? undefined
      : ((await this.store.listModels()).find((entry) => entry.id === task.modelId) as
          | ModelRelease
          | undefined);
    const id = model
      ? modelConnectionId(model, connections.keys())
      : connections.keys().next().value;
    const secret = id ? connections.get(id) : undefined;
    if (!secret)
      throw new GardenError(
        // The name three things already listen for. `provider_setup_required` was thrown here and
        // recognised nowhere: the API's wall table, the title sweep's cooldown and this worker's own
        // `waiting` test all key on `provider_not_connected`, so the missing-credential wall was
        // unreachable and every one of them ran its failure branch instead. A code with three
        // consumers and no producer is a control wired to nothing.
        'provider_not_connected',
        'Add a model provider in Settings before starting agent work',
        503
      );
    if (!resolveMedia) return secret;
    const project = await readTaskModelPreferences(this.store, this.#masterKey, task);
    const mediaModels = mergeProjectModelChoices(secret.mediaModels ?? {}, project.choices);
    return {
      ...secret,
      mediaModels,
      mediaRoutes: (await this.mediaRouting.resolve(secret, mediaModels)).routes
    };
  }

  async #gateway(
    task: TaskRecord,
    model: ModelRelease
  ): Promise<{
    gateway: ModelGateway;
    provider: string;
    credential: { provider: string; enforceZeroDataRetention: boolean };
  }> {
    const gateway = new ModelGateway();
    const secret = await this.#credentialForModel(task, model);
    if (
      model.capabilities.includes('decisions') &&
      secret.provider === 'openrouter' &&
      secret.apiKey
    ) {
      const privateRoute = task.privacyRoute === 'provider_zdr' || secret.enforceZeroDataRetention;
      gateway.registerDecisions(
        model.provider,
        observedObject(
          new OpenRouterDecisionAdapter({
            baseUrl: secret.baseUrl,
            apiKey: secret.apiKey,
            enforceZeroDataRetention: privateRoute
          }),
          'decision'
        )
      );
      return {
        gateway,
        provider: model.provider,
        credential: { provider: secret.provider, enforceZeroDataRetention: privateRoute }
      };
    }
    gateway.register(
      model.provider,
      nativeInputAdapter(
        codingMissionAdapter(
          observedObject(
            createModelAdapter({
              baseUrl: secret.baseUrl,
              ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
              provider: model.provider,
              privacyRoute: model.privacyRoute,
              appUrl: this.config.PUBLIC_APP_URL,
              appTitle: 'garden',
              enforceZeroDataRetention:
                secret.provider === 'openrouter' && secret.enforceZeroDataRetention
            }),
            'model'
          ),
          this.store,
          task,
          model,
          this.config.WORKER_ID
        ),
        this.store,
        task,
        model,
        runtimeValue('nativeCredentialBinding', () => nativeCredentialBinding(secret)),
        async () => this.#observedCredentialBinding(task, model),
        this.config.WORKER_ID
      )
    );
    return {
      gateway,
      provider: model.provider,
      credential: {
        provider: secret.provider,
        enforceZeroDataRetention: secret.enforceZeroDataRetention
      }
    };
  }

  async #observedCredentialBinding(task: TaskRecord, model: ModelRelease) {
    const secret = await this.#credentialForModel(task, model);
    return runtimeValue('nativeCredentialBinding', () =>
      nativeCredentialBinding(secret, task.privacyRoute)
    );
  }

  async #withLeaseRenewal<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T> {
    return withPeriodicRenewal(operation, () =>
      this.store.renewTaskLease(task.id, this.config.WORKER_ID, TASK_LEASE_SECONDS)
    );
  }

  /**
   * Persists the trajectory mid-step. The per-step checkpoint alone cannot record that a particular
   * tool call was already under way, which is what a resume needs in order to avoid running an
   * external action a second time.
   */
  async #checkpoint(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<void> {
    await this.store.updateTask({
      id: task.id,
      workerId: this.config.WORKER_ID,
      status: 'running',
      actualComputeCredits: state.credits,
      agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
    });
  }

  /**
   * Takes this turn's undo point for the computer, once, before the first call that could change it.
   *
   * Lazily, because a turn that only reads has nothing to undo and should cost nothing. Once,
   * because the point of the checkpoint is the state the turn started from, not the state before
   * each of its calls. And never fatally: an owner losing the ability to rewind one turn is bad,
   * but stopping the work they asked for because the undo point could not be taken is worse - so a
   * failure is written into the timeline where they can see it, and the turn carries on.
   */
  async #ensureTurnUndoPoint(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    tool: string
  ): Promise<void> {
    const turn = state.turn ?? 0;
    if (CHECKPOINT_EXEMPT_TOOLS.has(tool) || state.checkpoint?.turn === turn) return;
    const checkpointId = runtimeUUID();
    try {
      const created = await this.#withLeaseRenewal(task, () =>
        this.#runner.checkpoint(task.workspaceId, task.id, { checkpointId, turn })
      );
      // Spread rather than assigned, and never `?? []`: `exactOptionalPropertyTypes` refuses the
      // bare assignment of a nullable field to an optional one, and an empty array would tell the
      // approval floor this walk held everything when what the runner actually said was that it
      // could not say. Absent keeps the card on every delete for the turn, which is the direction
      // to fail in.
      state.checkpoint = {
        turn,
        id: checkpointId,
        ...(created.uncovered ? { uncovered: created.uncovered } : {})
      };
      await this.store.recordWorkspaceCheckpoint({
        id: checkpointId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        turn,
        mechanism: created.mechanism,
        fileCount: created.fileCount,
        totalBytes: created.totalBytes,
        storedBytes: created.storedBytes,
        durationMs: created.durationMs
      });
      // The runner has already removed these from disk, so the rows would otherwise offer the
      // owner a rewind to a checkpoint that is not there any more.
      if (created.pruned.length)
        await this.store.deleteWorkspaceCheckpoints(task.workspaceId, created.pruned);
    } catch (error) {
      state.checkpoint = { turn, id: null };
      const message = error instanceof Error ? error.message : 'The checkpoint could not be taken';
      await event(
        this.store,
        task,
        key,
        'warning',
        'This turn has no undo point for the computer',
        {
          // The code first, where there is one to read. An `GardenError` carries it as a field
          // already; everything else has it flattened into the message and is dug back out there.
          ...(ownerFixableCheckpointFailure(
            message,
            error instanceof GardenError ? { code: error.code } : undefined
          )
            ? { owner: true }
            : {}),
          tool,
          message
        }
      );
    }
  }

  /**
   * Stops a task before the step that would take it over a money ceiling.
   *
   * The compute-credit check above is not a money check: a credit is worth cents on one model and
   * dollars on another, so a task can sit well inside its credit budget and still run up a bill the
   * owner never agreed to. This is the ceiling denominated in the thing they actually pay.
   *
   * It pauses rather than fails, and it pauses *before* the call rather than after the one that
   * crossed - the work so far is intact, the transcript is intact, and raising the ceiling and
   * resuming carries on from here. Failing would throw away a long task over its last dollar, and
   * checking afterwards would always overshoot by one step.
   */
  /**
   * Tells the owner's devices, once per window, that their ceiling is in play.
   *
   * "Warn me at 80% of my daily cap" only ever appeared inside whichever task happened to cross it,
   * which for unattended work - the point of the machine - is a 3am scheduled run nobody opens for
   * hours. The threshold was decorative. `claimSpendAlert` is the deduplication: it inserts on a
   * unique window and returns false if this box has already said this about this window, so a long
   * task that keeps stepping does not keep ringing a phone.
   */
  async #raiseSpendAlert(
    task: TaskRecord,
    key: Uint8Array,
    decision: SpendDecision,
    level: 'warning' | 'exceeded'
  ): Promise<void> {
    const names =
      level === 'warning' ? decision.warnedBy : decision.blockedBy ? [decision.blockedBy] : [];
    for (const name of names) {
      if (name !== 'daily' && name !== 'monthly') continue;
      const window = decision.windows.find((candidate) => candidate.name === name);
      if (!window?.startsAt || window.capUsd === null) continue;
      const claimed = await this.store
        .claimSpendAlert({
          userId: task.userId,
          windowName: name,
          windowStart: new Date(window.startsAt),
          level,
          spentUsd: window.spentUsd,
          capUsd: window.capUsd
        })
        .catch(() => false);
      if (!claimed) continue;
      /*
       * A cap that has been reached is not an agent message.
       *
       * The pause raises `spend_paused`, which is its own notification kind with its own switch in
       * Settings, and this used to raise an `agent_message` beside it for the same event. That made
       * both switches lie: turning agent messages off silenced spend-cap alerts, and the spending
       * switch governed nothing the owner could see. The warning at eighty per cent keeps this
       * channel because there is no pause behind it - nothing else would say anything at all.
       */
      if (level === 'exceeded') continue;
      const headline = `Spending has passed the warning point of your ${name} cap: $${window.spentUsd.toFixed(2)} of $${window.capUsd.toFixed(2)}.`;
      await this.store
        .createAgentNotification({
          userId: task.userId,
          taskId: task.id,
          kind: 'agent_message',
          messageCiphertext: encryptJson({ message: headline }, key, agentNotificationAad(task.id))
        })
        .catch(() => undefined);
    }
  }

  /**
   * What one model call cost, on the ledger, in the credit total and on the timeline.
   *
   * Lifted out of the step loop because three paths through that loop need it and only one of them
   * used to reach it. A generation aborted for looping took a `continue` from above the block and a
   * generation the owner stopped returned from above it, so the two calls the box ends on purpose -
   * the two most expensive things a runaway model does - were the two nobody was ever charged for.
   * The block itself is unchanged; what changed is how many ways there are to arrive at it.
   */
  async #billModelStep(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    input: {
      response: ModelResponse;
      model: ModelRelease;
      preparedContext: PreparedContext;
      reservedTokens: number;
      turn: number;
      reasoningEffort: ReasoningEffort | undefined;
      /** @see TurnRun.measuringThroughput - true on the turn that reads the model's ceiling. */
      measuringThroughput?: boolean;
    }
  ): Promise<void> {
    const {
      response,
      model,
      preparedContext,
      reservedTokens,
      turn,
      reasoningEffort,
      measuringThroughput
    } = input;
    // What the request that just went out actually weighed, replacing this side's estimate of it.
    // Compaction was decided from characters-divided-by-four while this exact number arrived on
    // every response and was spent only on billing; the estimate cannot see a tokeniser's real
    // behaviour on code, JSON or non-Latin text, so the window was compacted early on some tasks
    // and overrun on others. It is converted to the unit the trigger compares against:
    // prompt_tokens includes the tool catalogue, and modelInputBudget has already set that aside
    // as reservedTokens, so charging it here as well would count it twice. A route that reports
    // no usage leaves the estimate in charge rather than claiming an empty window.
    if (response.usage.inputTokens > 0)
      state.preparedInputTokens = Math.max(0, response.usage.inputTokens - reservedTokens);
    /*
     * What a call that was cut off owes for its prompt.
     *
     * The gateway can count the output it watched go past, and does. It cannot count the input:
     * usage arrives in the last frame of the stream and a stream that was cut never reaches it,
     * and the prompt is not something the reading side ever saw. This side did see it - it
     * assembled the request a few lines above and priced it there - so the one number missing
     * from a cut-off call is the one number here is certain of. The catalogue is added back
     * because the estimate covers the messages alone while what a provider bills is the whole
     * request. Left at zero, a quarter of an hour of generation settled at a few tenths of a
     * cent, which is the spinner-and-a-price-that-never-moves the owner asked about, one layer up.
     */
    const billedInputTokens =
      response.usage.estimated && response.usage.inputTokens === 0
        ? preparedContext.estimatedInputTokens + reservedTokens
        : response.usage.inputTokens;
    const credit = usageCredit(model, billedInputTokens, response.usage.outputTokens);
    const costUsd =
      response.usage.costUsd ??
      estimatedInferenceCostUsd(
        model,
        billedInputTokens,
        response.usage.outputTokens,
        response.usage
      );
    state.credits += credit;
    // Added to rather than replaced. A step is not one model call: a vision handoff, a compaction
    // summary and a provider search all bill inside the same step, and each of them used to
    // overwrite this - so the guard that prices the next step from it was quoted whichever of them
    // happened to run last, which on an image-heavy turn is a light specialist standing in for a
    // full-window lead call. The loop clears it once, before the call the step is named for.
    state.lastStepUsd = (state.lastStepUsd ?? 0) + costUsd;
    await recordModelStepUsage(this.store, response, {
      userId: task.userId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: model.usageClass,
      // The total is the provider's own, except where there is no provider total: a stream that
      // was cut carries a sum of a reported output and an input nobody reported, and billing the
      // ledger from it would file the same zero the credit line has just stopped charging.
      quantity: response.usage.estimated
        ? billedInputTokens + response.usage.outputTokens
        : response.usage.totalTokens,
      unit: 'tokens',
      credits: credit,
      costUsd,
      state: 'settled',
      idempotencyKey: stepUsageKey(task.id, turn, state.step),
      ...(response.codingReservationId
        ? { codingReservationId: response.codingReservationId }
        : {}),
      providerRef: `${response.metadata.provider}:${response.metadata.model}`
    });
    /*
     * How fast the quickest company serving this model actually runs, asked of the aggregator about
     * the request it has just served.
     *
     * Only on a turn routed by throughput for want of a ceiling, which is the one turn where the
     * company that answered IS the aggregator's own quickest. Every figure comes back from them -
     * the generation time, the completion tokens and the company's name - so this is their
     * measurement of their own choice, not a stopwatch held on this side.
     *
     * After the answer the owner is waiting for has been delivered, and never able to fail the
     * turn: its only purpose is to make the next turn's routing better informed.
     */
    if (measuringThroughput && response.metadata.generationId)
      await this.#recordThroughputCeiling(task, model, response.metadata.generationId);
    await event(
      this.store,
      task,
      key,
      'cost',
      `Step ${state.step + 1} ${response.finishReason === 'error' ? 'interrupted' : 'completed'}`,
      {
        credits: credit,
        costUsd,
        cumulativeCredits: state.credits,
        usage: response.usage,
        metadata: response.metadata,
        // Which garden priced this. A cost line is the most-compared number the product emits - a
        // baseline read back a year later, a regression argued from two transcripts - and until now
        // nothing on it said which build produced it, so two figures that disagree could not be told
        // apart from two builds that disagree. `buildIdentity()` is derived once from the checkout and
        // is a constant for the process, so it costs the row a few bytes and no work.
        build: buildIdentity(),
        reasoningEffort,
        context: {
          estimatedInputTokens: preparedContext.estimatedInputTokens,
          contextWindowTokens: model.contextTokens,
          compacted: preparedContext.compacted,
          cacheBreakpoints: preparedContext.cacheBreakpoints,
          olderToolOutputChars: preparedContext.olderToolOutputChars
        }
      }
    );
  }

  /**
   * What the owner and the model are each told about a reply that was stopped for looping.
   *
   * Written once and called from both arms of the abort - the one that generated something and the
   * one that did not - because the sentence the model is given is the correction it acts on, and
   * two copies of it is two chances for the arms to start saying different things.
   */
  async #noteRepeatingAnswer(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    repeated: string
  ): Promise<void> {
    await event(this.store, task, key, 'warning', 'Stopped a repeating answer', {
      repeated: repeated.slice(0, 200)
    });
    state.messages.push({
      role: 'system',
      content: `Your last reply began repeating "${repeated.slice(0, 120)}" and was stopped. Do not restate it. Say the next thing that is actually new, or call finish if the work is done.`
    });
  }

  async #haltIfOutOfMoney(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<boolean> {
    // The next step usually costs about what the last one did. A first step has nothing to go on,
    // so it is priced at a token amount: the point is to catch a runaway, not to predict precisely.
    const estimateUsd = Math.max(0.01, state.lastStepUsd ?? 0.01);
    let guardFailure = '';
    const decision = await this.store
      .spendGuard({
        userId: task.userId,
        taskId: task.id,
        estimateUsd,
        includeOpenCommitments: true
      })
      .catch((cause: unknown) => {
        guardFailure = cause instanceof Error ? cause.message : 'the spending guard did not answer';
        return null;
      });
    /*
     * A brake that cannot answer stops the car.
     *
     * This used to swallow the failure and return "do not halt", so one transient database error
     * removed the owner's daily ceiling for that step, silently and with nothing written anywhere.
     * The cap exists precisely so an unattended run cannot get away from the person who is asleep,
     * and the only thing left underneath it is the compute-credit backstop, which sits far above
     * where anyone sets a daily limit. Pausing costs a resumable task; failing open costs money
     * that is already gone by the time it is noticed.
     */
    if (!decision) {
      const reason = guardFailure || 'the spending guard did not answer';
      await event(
        this.store,
        task,
        key,
        'status',
        'Paused: garden could not check this against your spending caps, so it stopped rather than spend past them.',
        { blockedBy: 'spend_guard_unavailable', reason, estimateUsd }
      );
      await this.store.updateTask({
        id: task.id,
        workerId: this.config.WORKER_ID,
        status: 'paused',
        actualComputeCredits: state.credits,
        // What makes this a spend pause rather than an ordinary one. The whole `spend_paused`
        // notification kind - its query, its switch, its consumer - was built and reachable by
        // nothing, because the only two writes that should set this column never set it. An
        // ordinary Pause deliberately leaves it null; a resume clears it in the same statement that
        // re-queues the task, so nothing here has to.
        spendPausedAt: runtimeDate(),
        agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
        clearLease: true
      });
      return true;
    }
    if (decision.outcome === 'allow') return false;

    if (decision.outcome === 'warn') {
      // Warn once per window, or a long task narrates the same sentence every step.
      const warned = new Set(state.spendWarnings ?? []);
      const fresh = decision.warnedBy.filter((window) => !warned.has(window));
      if (fresh.length) {
        state.spendWarnings = [...warned, ...fresh];
        await event(this.store, task, key, 'warning', spendWarning(decision), {
          windows: decision.windows,
          estimateUsd
        });
        await this.#raiseSpendAlert(task, key, decision, 'warning');
      }
      return false;
    }

    await event(this.store, task, key, 'status', spendHalt(decision), {
      blockedBy: decision.blockedBy,
      windows: decision.windows,
      estimateUsd
    });
    await this.#raiseSpendAlert(task, key, decision, 'exceeded');
    await this.store.updateTask({
      id: task.id,
      workerId: this.config.WORKER_ID,
      status: 'paused',
      actualComputeCredits: state.credits,
      // The column that tells a pause the owner asked for from one the ceiling imposed. Everything
      // downstream of `spend_paused` reads it and nothing used to write it.
      spendPausedAt: runtimeDate(),
      agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
      clearLease: true
    });
    return true;
  }

  /**
   * Makes Cancel stop the tool that is already running, not just the ones queued behind it.
   *
   * A single call can hold the worker for an hour, so without this a cancel is only honoured once
   * the long shell command or browser action has finished on its own. The poll is deliberately
   * cheap and read-only; when it sees a stop it aborts the runner request, which surfaces as a
   * failed tool result and lets the loop's own cancellation check take the task down cleanly.
   */
  async #withCancellationWatch<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    /*
     * The two columns this asks about, and not the whole row.
     *
     * `getTask` returns the task with its encrypted trajectory attached, so a poll every three
     * seconds for the life of a ten-minute tool call read about 190 MB to look at one string -
     * and the cost rises with the length of the conversation, so the longest turns, the ones this
     * watch exists to protect, paid the most. `taskClaim` is the narrow read written for exactly
     * this, and the model call's own stop watch beside it already used it.
     *
     * Read through `haltReason` as that watch is, which also closes the case this poll could not
     * see: a task re-queued or re-leased under a running tool call is no longer this run's to
     * finish, and carrying on with it means writing over whoever holds it now.
     */
    const poll = runtimeSetInterval(() => {
      void this.store
        .taskClaim(task.id)
        .then((claim) => {
          if (haltReason(claim, this.config.WORKER_ID)) controller.abort();
        })
        .catch(() => undefined);
    }, CANCELLATION_POLL_INTERVAL_MS);
    poll.unref();
    try {
      return await withRunnerAbort(controller.signal, operation);
    } finally {
      runtimeClearTimer(poll);
    }
  }

  /**
   * @see currentCatalog in `vision.ts`, where this moved in Wave 7.2 and gained the memo. It was a
   * whole-table read of `model_releases` per image-bearing tool result - one per step on a browsing
   * turn - to follow a registry that refreshes hourly.
   */
  async #currentCatalog(fallback: ModelRelease[]): Promise<ModelRelease[]> {
    return currentCatalog(this.#vision, fallback);
  }

  /**
   * The addresses that are this installation rather than somewhere it could send anything.
   *
   * Read from configuration rather than from anything the model wrote, for the same reason the
   * host and byte count on the approval card are: a destination the agent can name is a
   * destination the agent can lie about.
   */
  #selfOrigins(): string[] {
    return [originOf(this.config.PUBLIC_APP_URL)].filter(Boolean);
  }

  /**
   * Where this run is allowed to send data, assembled once for everything that asks.
   *
   * The lead's approval floor, a delegated specialist's refusal and the turn's novelty budget are
   * three questions about the same fact, and three hand-built copies of it are three chances for
   * one of them to be measuring against a different corpus than the one the owner would recognise.
   */
  #destinationContext(state?: AgentState): DestinationContext {
    return {
      knownOrigins: [
        ...(state?.knownOrigins ?? []),
        ...originsFromOwnerMessages(state?.messages ?? [])
          .map(originOf)
          .filter(Boolean)
      ],
      // Only what the harness read out of a tool result. An address the owner typed is already in
      // their own words below, so repeating it here would say nothing.
      knownAddresses: state?.knownAddresses ?? [],
      // The owner's own words, and only those: what the agent wrote about the page is not evidence
      // that the owner asked for the page.
      ownerText: (state?.messages ?? [])
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n')
        .slice(0, 40_000),
      selfOrigins: this.#selfOrigins(),
      spentNoveltyBytes: state?.turnNoveltyBytes ?? 0
    };
  }

  async #assertProviderConfigured(task: TaskRecord): Promise<void> {
    if (!(await this.#inferenceConnections(task)).size)
      throw new GardenError(
        'provider_not_connected',
        'Add a model provider in Settings before starting agent work',
        503
      );
  }

  /**
   * One notice the owner asked for, written to the conversation and queued for their devices.
   *
   * Nothing else in the product lets the agent decide to say something: the only push was derived
   * from a task reaching a terminal status, so a fifteen-minute page monitor announced itself
   * ninety-six times a day whether or not the page had changed, and the owner's only remedy
   * silenced every other conversation too. A notice is the opposite - it exists because the agent
   * judged there was something to say, and a run that judges otherwise leaves no row behind at all.
   *
   * The queued row comes first. It is the half that can be refused - the box bounds how many one
   * turn may raise, and the count starts again on the turn after the user replies - and a refusal
   * the model can read is worth more than an event written for a push that will never leave the
   * machine.
   */
  async #sendNotice(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall
  ): Promise<void> {
    const headline = textValue(call.arguments.headline).trim().replace(/\s+/g, ' ').slice(0, 140);
    const detail = textValue(call.arguments.detail).trim().slice(0, 2_000);
    const sent = state.notices ?? 0;
    const refusal = !headline
      ? 'Refused: a notice needs a headline the user can act on from a lock screen.'
      : sent >= MAX_NOTICES_PER_TURN
        ? `Refused: this turn has already sent ${sent} notices, which is the limit. Past that it is a stream rather than news - put the rest in your reply, which the user reads when they open the conversation.`
        : null;
    if (refusal) {
      state.messages.push({ role: 'tool', toolCallId: call.id, content: refusal });
      state.turnToolResults ??= {};
      state.turnToolResults[call.id] = { name: call.name, success: false };
      return;
    }
    // The headline alone, because that is what a lock screen shows; the detail is waiting in the
    // conversation the notification opens.
    const queued = await this.store
      .createAgentNotification({
        userId: task.userId,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: encryptJson({ message: headline }, key, agentNotificationAad(task.id))
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : 'unavailable'));
    if (typeof queued === 'string') {
      state.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: `Refused: the notice could not be queued for the user's devices. ${queued}`
      });
      state.turnToolResults ??= {};
      state.turnToolResults[call.id] = { name: call.name, success: false };
      return;
    }
    state.notices = sent + 1;
    await event(this.store, task, key, 'notice', headline, {
      headline,
      ...(detail ? { detail } : {}),
      unattended: state.unattended === true
    });
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify({
        notified: true,
        headline,
        note: 'The user has been told. Do not repeat this in another notice; your reply is where the rest of it belongs.'
      })
    });
    state.turnToolResults ??= {};
    state.turnToolResults[call.id] = { name: call.name, success: true };
  }

  /**
   * Tells the owner about a challenge only a person can clear.
   *
   * The runner detects the wall, scopes it and hands it over as data, and the conversation shows it
   * - but none of that reaches a phone, and an unattended run that walks into a check at 03:00 has
   * nobody to tell. This is where it becomes a notification, because raising one needs the task's
   * user and the workspace key, and the runner has neither.
   *
   * Failure is swallowed on purpose. The wall is already in the transcript and in the tool result;
   * a notification row that could not be written is not a reason to fail the call that hit it.
   */
  async #raiseTakeover(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    wall: BotWall
  ): Promise<void> {
    state.browserHandoff = wall;
    const site = botWallSite(wall.url);
    const raised = state.takeoversRaised ?? [];
    if (raised.includes(site)) return;
    // Bounded by the same number of notifications one conversation may raise at all, so a task that
    // walks into a wall on twenty sites cannot grow this list without bound either.
    state.takeoversRaised = [...raised, site].slice(-MAX_AGENT_NOTIFICATIONS_PER_TASK);
    await this.store
      .createAgentNotification({
        userId: task.userId,
        taskId: task.id,
        kind: 'takeover_needed',
        messageCiphertext: encryptJson(
          { message: takeoverNotice(wall) },
          key,
          agentNotificationAad(task.id)
        )
      })
      .catch(() => undefined);
  }

  /** @see recordToolFailure in `tool-recording.ts`, where this moved in Wave 7.2. */
  async #recordToolFailure(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall,
    error: unknown
  ): Promise<void> {
    await recordToolFailure(this.#toolRecording, task, key, state, call, error);
  }

  /** @see runToolCallsTogether in `tool-recording.ts`, where this moved in Wave 7.2. */
  async #runToolCallsTogether(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    calls: readonly ModelToolCall[],
    context: {
      model: ModelRelease;
      catalog: ModelRelease[];
      webPlan: WebToolPlan;
      refreshActivePlan: () => Promise<boolean>;
    }
  ): Promise<void> {
    await runToolCallsTogether(this.#toolRecording, task, key, state, calls, context);
  }

  /** The plan steps this task has not finished, newest plan version, in order. */
  async #outstandingPlanSteps(task: TaskRecord, key: Uint8Array): Promise<string[]> {
    const plan = await this.store.getLatestTaskPlan(task.id).catch(() => null);
    if (!plan || plan.stepsCiphertext.aad !== `task-plan:${task.id}`) return [];
    return decryptJson<{ steps: TaskPlanStep[] }>(plan.stepsCiphertext, key)
      .steps.filter((step) => step.status !== 'completed' && step.status !== 'skipped')
      .map((step) => step.title);
  }

  /** @see stepCeiling in `handoff.ts`, where this moved in Wave 7.2. */
  #stepCeiling(state: AgentState): number {
    return stepCeiling(this.#handoff, state);
  }

  /** @see renewStepBudget in `handoff.ts`, where this moved in Wave 7.2. */
  async #renewStepBudget(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<boolean> {
    return renewStepBudget(this.#handoff, task, key, state);
  }

  /**
   * Whether a schedule started this task rather than the owner.
   *
   * The scheduler stamps its own id into the payload of the run's opening event, which is the only
   * durable marker there is - the task row itself does not say where it came from. Read once per
   * task and then carried in the agent state, so a long conversation does not re-ask.
   */
  async #startedBySchedule(task: TaskRecord, key: Uint8Array): Promise<boolean> {
    const page = await this.store
      .listTaskEventPage(task.id, { after: 0, limit: 1 })
      .catch(() => null);
    const opening = page?.events[0];
    if (!opening?.payloadCiphertext || opening.payloadCiphertext.aad !== `task-event:${task.id}`)
      return false;
    try {
      const body = decryptJson<{ payload?: { scheduleId?: unknown } }>(
        opening.payloadCiphertext,
        key
      );
      return typeof body.payload?.scheduleId === 'string';
    } catch {
      // An opening event this key cannot read says nothing about the origin, and guessing
      // "unattended" would silence a conversation the owner is sitting in front of.
      return false;
    }
  }

  /**
   * What this computer can do with documents, in the runner's own words.
   *
   * Read once at the start of a run and folded into the frozen runtime block, because the answer
   * is a property of the machine rather than of the step. A runner that cannot answer costs the
   * agent this line and nothing else: a task that will not start would be a far worse trade than
   * one that has to check a binary itself.
   */
  async #toolchainSummary(task: TaskRecord): Promise<string> {
    const report = await this.#runner
      .call<{
        summary?: unknown;
      }>(task.workspaceId, task.id, 'exec', `/v1/workspaces/${task.workspaceId}/toolchain`)
      .catch(() => null);
    return textValue(report?.summary).trim();
  }

  /**
   * What machine this run is on, in the runner's own words.
   *
   * Read from the runner rather than from `node:os` here, and the difference is not cosmetic: the
   * worker is its own systemd unit under its own control group, so every number `os` would answer
   * with describes the wrong process. The runner is the unit an agent command is a child of, so
   * `cpu.max`, `memory.max` and the RLIMIT_DATA it applies are all read there, by the process they
   * bind. @see machineReport in `services/workspace-runner/src/machine.ts`.
   *
   * A runner that cannot answer costs this line and nothing else, exactly as the toolchain probe
   * above does - and the runner's own report is already empty rather than approximate when it
   * cannot establish a field, so an absent line here and a partial line there are the same
   * decision made once, on the side that can actually see the machine.
   */
  async #machineSummary(task: TaskRecord): Promise<string> {
    const report = await this.#runner
      .call<{
        summary?: unknown;
      }>(task.workspaceId, task.id, 'exec', `/v1/workspaces/${task.workspaceId}/machine`)
      .catch(() => null);
    return textValue(report?.summary).trim();
  }

  /**
   * Whether this computer has a browser and a screen, in the runner's own words.
   *
   * Read once at the start of a run and frozen onto `TurnRun` beside `toolchainSummary`, for the
   * same reason and by the same route: it is a property of the machine rather than of the step,
   * and the catalogue it decides is the head of the cached prefix, so an answer that could change
   * between steps would move every byte behind it.
   *
   * Every way of not getting an answer lands on `UNKNOWN_SURFACES`, and unknown describes
   * everything. An unreachable runner, a timeout, an older runner with no such route, a body that
   * is not the shape the contract declares - all of them mean the same thing here, which is "this
   * side does not know", and the only safe reading of that is the full catalogue. The two ways of
   * being wrong are not the same size: describing a surface the box lacks costs bytes and one
   * honest failure the model can read, while withdrawing a surface the box has hides a capability
   * the owner paid for and leaves nothing behind to say it existed.
   */
  async #workspaceSurfaces(task: TaskRecord): Promise<WorkspaceSurfaces> {
    const report = await this.#runner
      .call<unknown>(
        task.workspaceId,
        task.id,
        'exec',
        `/v1/workspaces/${task.workspaceId}/surfaces`
      )
      .catch(() => null);
    const parsed = WorkspaceSurfaces.safeParse(report);
    return parsed.success ? parsed.data : UNKNOWN_SURFACES;
  }

  /** Which of a skill's declared binaries this workspace does not have, probed through the runner. */
  async #missingBinaries(task: TaskRecord, binaries: readonly string[]): Promise<string[]> {
    const known = this.#presentBinaries.get(task.workspaceId) ?? new Set<string>();
    const unknown = [...new Set(binaries)].filter((binary) => !known.has(binary));
    if (!unknown.length) return [];
    const probed = await this.#runner
      .call<{
        present?: unknown;
        missing?: unknown;
      }>(task.workspaceId, task.id, 'exec', `/v1/workspaces/${task.workspaceId}/toolchain/probe`, {
        binaries: unknown
      })
      .catch(() => null);
    // A probe that could not run must not invent an absence: claiming a present binary is missing
    // sends the agent to ask for an install the owner does not need.
    if (!probed) return [];
    for (const binary of Array.isArray(probed.present) ? probed.present.map(String) : [])
      known.add(binary);
    this.#presentBinaries.set(task.workspaceId, known);
    return Array.isArray(probed.missing) ? probed.missing.map(String) : [];
  }

  /**
   * `web_search`, answered by the provider instead of by the workspace's browser.
   *
   * The tool is the same tool on both routes - same name, same parameters, same description, same
   * result shape - because a model that has to know where its searches are answered in order to know
   * what to call is a model that will get it wrong. What differs is entirely behind this method.
   *
   * It is a second model request, and that is not a workaround for a missing API but the shape of
   * the thing: a provider-side tool has no name a model can call, so the only way to spend one
   * deliberately is to build a request whose whole purpose is to spend it. It carries no function
   * tools at all, which the gateway checks one line before the wire.
   *
   * The task's own model runs it rather than a cheaper one chosen from the catalogue. The request is
   * two sentences and a query, so the model's rate barely registers against the search itself, and
   * picking a different model would mean re-checking that it belongs to the configured provider and
   * to this task's privacy route - two ways to be wrong about where the query goes, bought for
   * fractions of a cent.
   */
  async #providerWebSearch(
    task: TaskRecord,
    call: ModelToolCall,
    webPlan: WebToolPlan,
    state?: AgentState
  ): Promise<WebSearchAnswer> {
    await this.#assertProviderConfigured(task);
    const catalog = (await this.store.listModels()) as unknown as ModelRelease[];
    const model = catalog.find((entry) => entry.id === task.modelId);
    if (!model)
      throw new GardenError(
        'model_unavailable',
        `Model ${task.modelId} is no longer in the registry`
      );
    const { gateway, provider } = await this.#gateway(task, model);
    return providerWebSearch({
      query: textValue(call.arguments.query),
      limit: Math.max(1, Math.min(10, Math.trunc(Number(call.arguments.limit ?? 10)) || 10)),
      engine: webPlan.serverTools.map((tool) => tool.type).join(', '),
      ask: async (messages) => {
        const response = await this.#withLeaseRenewal(task, () =>
          withRequestDeadline(
            (signal) =>
              gateway.chat(provider, {
                ...routeTo(model),
                messages,
                tools: [],
                serverTools: webPlan.serverTools,
                temperature: 0,
                maxTokens: WEB_SEARCH_MAX_OUTPUT_TOKENS,
                // The judgement in this call is the search engine's, not the model's. Thinking
                // harder about which words to retrieve is the caller's job and it already did it.
                reasoningEffort: 'low',
                // Distinct per call, so two searches in one turn are two requests to the provider
                // rather than one request it believes it has already answered.
                sessionId: sha256(`garden-task:${task.id}:search:${call.id}`).slice(0, 64),
                signal
              }),
            WEB_SEARCH_REQUEST_TIMEOUT_MS
          )
        );
        // Billed to the task like any other inference, because it is: a search the owner pays for
        // through their model provider should appear against their spend rather than arriving as an
        // unexplained line on the provider's own bill. The ledger row is written wherever this runs;
        // the turn's own credit counter is charged where there is a turn, which a specialist's
        // searches are not - their bound is the sixteen steps a mission gets, not a credit total.
        const credit = usageCredit(model, response.usage.inputTokens, response.usage.outputTokens);
        if (state) state.credits += credit;
        await this.store
          .recordUsage({
            userId: task.userId,
            workspaceId: task.workspaceId,
            taskId: task.id,
            kind: 'model_inference',
            resourceClass: model.usageClass,
            quantity: response.usage.totalTokens,
            unit: 'tokens',
            credits: credit,
            costUsd:
              response.usage.costUsd ??
              estimatedInferenceCostUsd(
                model,
                response.usage.inputTokens,
                response.usage.outputTokens,
                response.usage
              ),
            state: 'settled',
            idempotencyKey: `web-search:${task.id}:${call.id}`,
            ...(response.codingReservationId
              ? { codingReservationId: response.codingReservationId }
              : {}),
            providerRef: `${response.metadata.provider}:${response.metadata.model}`
          })
          // The results are already retrieved and the owner asked for them. Losing the ledger row is
          // worth telling the timeline about, not worth throwing the search away over.
          .catch(() => undefined);
        return response;
      }
    });
  }

  /**
   * One tool call, run through the dispatch table in `tool-dispatch.ts`.
   *
   * Kept as a three-line method rather than dissolved into its five call sites so that the loop
   * still reads the way it read before the arms moved out, and so that the context is assembled in
   * one place instead of five. Everything it does is name what an arm may reach for: the four bound
   * functions are the only things left in this class that an arm still needs.
   */
  #execute(
    task: TaskRecord,
    call: ModelToolCall,
    key: Uint8Array,
    consequentialApproved: boolean,
    webPlan: WebToolPlan,
    state: AgentState
  ): Promise<unknown> {
    if (runtimeObservations()) {
      const before = structuredClone(state);
      return runtimeCall(
        'tool.execute',
        [call, consequentialApproved, webPlan, before],
        async () => {
          let result: unknown;
          let failed = false;
          try {
            result = await this.#executeUnobserved(
              task,
              call,
              key,
              consequentialApproved,
              webPlan,
              state
            );
          } catch (error) {
            result = error;
            failed = true;
          }
          const changed = Object.fromEntries(
            Object.entries(state).filter(
              ([name, value]) => JSON.stringify(value) !== JSON.stringify(Reflect.get(before, name))
            )
          );
          const removed = Object.keys(before).filter((name) => !Object.hasOwn(state, name));
          return { result, failed, changed, removed };
        }
      ).then(({ result, failed, changed, removed }) => {
        if (runtimeObservations()?.mode === 'replay') {
          Object.assign(state, changed);
          for (const name of removed) Reflect.deleteProperty(state, name);
        }
        if (failed) throw result;
        return result;
      });
    }
    return this.#executeUnobserved(task, call, key, consequentialApproved, webPlan, state);
  }

  #executeUnobserved(
    task: TaskRecord,
    call: ModelToolCall,
    key: Uint8Array,
    consequentialApproved: boolean,
    webPlan: WebToolPlan,
    state: AgentState
  ): Promise<unknown> {
    return executeToolCall(
      {
        store: this.store,
        config: this.config,
        runner: this.#runner,
        masterKey: this.#masterKey,
        task,
        key,
        consequentialApproved,
        webPlan,
        state,
        inferenceCredential: (forTask, resolveMedia) =>
          this.#inferenceCredential(forTask, resolveMedia),
        connectedModels: (forTask, catalog) => this.#connectedModels(forTask, catalog),
        providerWebSearch: (forTask, forCall, plan, forState) =>
          this.#providerWebSearch(forTask, forCall, plan, forState),
        missingBinaries: (forTask, binaries) => this.#missingBinaries(forTask, binaries),
        destinationContext: (forState) => this.#destinationContext(forState),
        dispatch: executeToolCall,
        gateway: (forTask, forModel) => this.#gateway(forTask, forModel),
        assertProviderConfigured: (forTask) => this.#assertProviderConfigured(forTask)
      },
      call
    );
  }

  /**
   * One evaluation per call per state of the world. @see approvalForCallOnce in
   * `approval-floor.ts`, where the floor and its memo moved in Wave 7.2.
   *
   * Every site in the loop asks through here rather than through `approvalForCall` directly, which
   * is what #80's repair amounts to: the first call of a candidate parallel run used to be put to
   * the floor twice - once while deciding whether the batch could run together and once while
   * running it - and a floor that reads the task's spend and the turn's taint is not free to ask
   * twice. `approvalForCall` is still exported for the sibling that owns it and for its own tests;
   * nothing in this class reaches it any more, so the class no longer keeps a wrapper for it.
   */
  async #approvalForCallOnce(
    memo: ApprovalFloorMemo,
    task: TaskRecord,
    call: ModelToolCall,
    state?: AgentState
  ): Promise<AgentApprovalRequirement | null> {
    return approvalForCallOnce(this.#approvalFloor, memo, task, call, state);
  }

  /** @see compactTurnContext in `compaction.ts`, where this moved in Wave 7.2. */
  async #compactContext(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    input: {
      model: ModelRelease;
      catalog: ModelRelease[];
      maxOutputTokens: number;
      reservedTokens: number;
      trigger: 'budget' | 'agent';
      turn: number;
      note?: string;
      contextTokensLimit?: number;
    }
  ): Promise<CompactionOutcome | null> {
    return compactTurnContext(this.#compaction, task, key, state, input);
  }

  /**
   * @see runAcceptanceChecks in `acceptance-runner.ts`, where this moved in Wave 7.2 with the
   * memo that stops the suite running twice on a completing turn and the deadline that stops eight
   * checks composing into two hours.
   */
  async #runAcceptanceChecks(
    task: TaskRecord,
    key: Uint8Array,
    record: AcceptanceRecord,
    options: {
      purpose: 'finish' | 'continuation';
      observed?: ReadonlyMap<string, number>;
    } = { purpose: 'finish' },
    state?: AgentState
  ): Promise<AcceptanceResult[]> {
    return runAcceptanceChecks(this.#acceptanceRunner, task, key, record, options, state);
  }

  /** @see raiseTaint in `tool-recording.ts`, where this moved in Wave 7.2. */
  async #raiseTaint(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    origin: string | null,
    tool: string
  ): Promise<string | null> {
    return raiseTaint(this.#toolRecording, task, key, state, origin, tool);
  }

  /**
   * Recording and, when the result carried a picture, the routing that decides who reads it.
   *
   * Both halves moved out in Wave 7.2 and are sequenced here rather than nested, so `vision.ts` can
   * import `event` from `tool-recording.ts` without the two files importing each other.
   */
  async #recordToolResult(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall,
    result: unknown,
    leadModel: ModelRelease,
    catalog: ModelRelease[]
  ): Promise<void> {
    const image = await recordToolResult(this.#toolRecording, task, key, state, call, result);
    if (!image) return;
    await routeImageObservation(this.#vision, task, key, state, call, image, leadModel, catalog);
  }

  /** @see captureMemory in `memory-capture.ts`, where this moved in Wave 7.2. */
  async #captureMemory(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    completion: {
      summary: string;
      verification: CompletionVerification;
      interrupted?: boolean;
      verifiedCommands?: readonly AcceptanceCommandCheck[];
    },
    deadEnds: readonly MemoryDeadEndCheck[] = []
  ): Promise<void> {
    await captureMemory(this.#memoryCapture, task, key, state, completion, deadEnds);
  }

  async #completeTurn(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    completion: {
      summary: string;
      answer?: string;
      deliverables?: unknown[];
      verification: CompletionVerification;
      /** Present, and true, only on a turn the harness stopped rather than the model. */
      interrupted?: boolean;
      /** What is still open, for the turn that resumes this one. */
      outstanding?: string[];
      /** What the harness itself ran and observed, when the turn declared an acceptance record. */
      acceptance?: string[];
      /** The commands among those that passed, which the memory keeps as procedures. */
      verifiedCommands?: readonly AcceptanceCommandCheck[];
    },
    options: {
      label?: string;
      /**
       * The commands the harness watched fail on the run that finished this turn. Kept out of
       * `completion` because that object is the completed event's payload, and every one of these
       * is already in it as a remaining risk.
       */
      deadEnds?: readonly MemoryDeadEndCheck[];
    } = {}
  ): Promise<void> {
    sealUnansweredToolCalls(state.messages, 'the agent finished the turn before this call ran');
    if (await parkBrowserHandoff(this.#turnControl, task, key, state)) return;
    if (state.question) {
      state.question.waiting = true;
      await saveQuestion(this.#turnControl, task, key, state, true);
      return;
    }
    // The completion carries the answer identity; ordinary messages remain progress.
    if (!state.answered && (completion.answer ?? completion.summary).trim())
      await event(this.store, task, key, 'assistant_message', completion.summary.slice(0, 500), {
        markdown: completion.answer ?? completion.summary,
        channel: 'final'
      });
    await event(this.store, task, key, 'completed', options.label ?? 'Task completed', {
      ...completion,
      answer: completion.answer ?? completion.summary,
      answerChannel: 'final'
    });
    await this.#captureMemory(task, key, state, completion, options.deadEnds ?? []);
    const turn = state.turn ?? 0;
    await this.store.transitionUsage(
      state.reservationKey ?? reservationUsageKey(task.id, turn),
      'reserved',
      'released'
    );

    await retryTurnHandoff({
      attempt: async () => {
        const queued = await this.store.getNextQueuedTaskMessage(task.id);
        if (!queued)
          return this.store.completeTaskIfNoQueued({
            id: task.id,
            workerId: this.config.WORKER_ID,
            actualComputeCredits: state.credits,
            agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
          });
        if (queued.promptCiphertext.aad !== `task-message:${task.id}`)
          throw new GardenError(
            'queued_message_context',
            'Queued message encryption context is invalid'
          );
        const message = decryptJson<OwnerMessage>(queued.promptCiphertext, key);
        const nextTurn = turn + 1;
        const nextState = startTurnState(state as unknown as Record<string, unknown>, {
          ...message,
          turn: nextTurn,
          reservationKey: queued.reservationKey
        }) as unknown as AgentState;
        const promoted = await this.store.promoteQueuedTaskMessage({
          taskId: task.id,
          messageId: queued.id,
          workerId: this.config.WORKER_ID,
          modelId: queued.modelId,
          privacyRoute: queued.privacyRoute,
          additionalComputeCredits: queued.maxComputeCredits,
          ...(queued.maxSpendUsd === null ? {} : { additionalSpendUsd: queued.maxSpendUsd }),
          agentStateCiphertext: encryptJson(nextState, key, `task-state:${task.id}`),
          userMessageCiphertext: encryptJson(
            { markdown: message.prompt, attachments: message.attachments, messageId: queued.id },
            key,
            `task-event:${task.id}`
          ),
          statusEventCiphertext: encryptJson(
            { messageId: queued.id, turn: nextTurn },
            key,
            `task-event:${task.id}`
          )
        });
        return promoted !== null;
      },
      stillOwned: async () => {
        const latest = await this.store.getTask(task.userId, task.id);
        if (!latest || ['paused', 'cancelled', 'completed'].includes(latest.status)) return false;
        return this.store.renewTaskLease(task.id, this.config.WORKER_ID, TASK_LEASE_SECONDS);
      },
      sleep: (milliseconds) => runtimeSleep(milliseconds)
    });
  }

  async run(task: TaskRecord): Promise<void> {
    if (runtimeObservations()?.mode === 'replay') return this.#run(task);
    const capture = await TaskDiagnosticCapture.open(
      this.store,
      task,
      this.config.WORKER_ID,
      this.#masterKey
    );
    return capture
      ? capture.run(() => this.#run(task), {
          config: this.config,
          masterKey: this.#masterKey,
          caches: this.replayCaches(task.workspaceId)
        })
      : withPrivateDiagnostics(undefined, () => this.#run(task));
  }

  replayCaches(workspaceId: string) {
    return {
      catalog: this.#catalogCache.current,
      binaries: this.#presentBinaries.get(workspaceId),
      memoryAt: this.#memoryConsolidatedAt.get(workspaceId)
    };
  }

  restoreReplayCaches(workspaceId: string, caches: ReturnType<AgentWorker['replayCaches']>) {
    if (runtimeObservations()?.mode !== 'replay')
      throw new Error('Replay state requires an offline runtime');
    this.#catalogCache.current = caches.catalog;
    if (caches.binaries) this.#presentBinaries.set(workspaceId, caches.binaries);
    if (caches.memoryAt !== undefined) this.#memoryConsolidatedAt.set(workspaceId, caches.memoryAt);
  }

  async #run(task: TaskRecord): Promise<void> {
    /*
     * Everything this turn needs before it can say a word. @see claimTurn in `turn/claim.ts`,
     * where the hundred and five lines that gathered it now live - the workspace key, the model
     * and its gateway, the saved trajectory, the web route, the tools this box can honestly
     * describe, and what every request carries before a word of conversation.
     *
     * Destructured rather than carried as `run.`: every one of these is fixed for the life of the
     * turn, and the loop below reads them by the names it has always read them by.
     */
    const { run, state } = await claimTurn(this.#claim, task);
    const {
      turnStartedAt,
      workspace,
      key,
      prompt,
      catalog,
      model,
      gateway,
      provider,
      timeZone,
      unattended,
      webPlan,
      toolchainSummary,
      machineSummary
    } = run;
    /*
     * Asked before anything is said, which is the whole point of the silent arm.
     *
     * `honorUserControl`'s `disowned` arm stands the run down without narrating it, because two
     * workers explaining themselves on one timeline is worse than one of them leaving quietly. Every
     * other call site sits at a step or tool-batch boundary, so the question was first asked well
     * below here - and the two `event(...)` writes underneath this line went onto the owner's
     * conversation first. A worker whose task had already been resumed by another worker put the
     * web-route disclosure, and on a stale window a warning about the saved context, into a
     * conversation that was not its own any more, and only then discovered it had nothing to do.
     *
     * The named import is used directly because the `honorUserControl` closure below is defined
     * after the preamble is assembled; hoisting the closure instead would move a large block for a
     * one-line question. Same arguments, same three arms, and `state` is the trajectory as loaded -
     * nothing below has touched it yet, so the `paused` arm saves exactly what is on disk.
     *
     * @see preamble-ownership.test.ts, which measures this set from the source and expects it empty.
     */
    if (await honorUserControl_(this.#turnControl, task, key, state)) return;
    // Written down whenever it moves, and only then: the disclosure is what the owner is owed, and
    // repeating it on every resumed turn would bury the step where it actually changed.
    if (state.webToolMode !== webPlan.mode)
      await event(this.store, task, key, 'status', webPlan.disclosure, {
        webSearch: { mode: webPlan.mode, reason: webPlan.reason }
      }).catch(() => undefined);
    state.webToolMode = webPlan.mode;
    // Before the contract is installed, so a window saved when guidance was a separate keyword-
    // selected message does not arrive carrying both it and the contract that now contains it. The
    // set of playbooks that message was chosen from was persisted too, and is re-encrypted with the
    // state on every step until something drops it.
    dropLegacyGuidance(state.messages);
    delete (state as { playbooks?: unknown }).playbooks;
    const { removedDuplicates } = ensureBasePrompt(state.messages, {
      toolchainSummary,
      views: await this.store
        .getUserById(task.userId)
        .then((user) => OwnerPreferences.parse(user?.preferences ?? {}).resultViews !== false)
        .catch(() => true)
    });
    if (removedDuplicates)
      // Worth saying out loud: this ran for as long as the marker was stale, and every duplicate
      // sat at the head of the window where it moved the bytes of everything cached behind it.
      await event(
        this.store,
        task,
        key,
        'warning',
        'Removed a duplicated operating contract from this task’s saved context',
        { removedDuplicates }
      ).catch(() => undefined);
    /**
     * The one block in the window that is meant to change, moved to the one place where changing
     * it is free.
     *
     * It used to sit at index 1, immediately behind the operating contract and ahead of the entire
     * trajectory, and it carries the clock. Turns are minutes apart, so the first byte that
     * differed between two consecutive turns' requests was inside this message - and every cache
     * breakpoint the request carries sits behind it. The cached prefix across turns was therefore
     * not merely degraded but zero: a measured 84% cache rate is exactly what a cache that works
     * only within a turn produces. Re-billing one whole window per turn at the 1.25x write tier
     * instead of the 0.1x read tier is roughly half the input bill of a long conversation.
     *
     * At the tail it costs nothing, because the tail is rewritten by the next step anyway - which
     * is why the active plan and the step-budget notice are already pushed here. It has to be
     * re-pushed every STEP, not once per turn: pushed once per turn it would be buried under that
     * turn's tool results, and removing it on the next turn would rewrite everything behind it -
     * the same disease at a new address. Recency also makes it more salient, not less, so the
     * clock can now be fresher than it was and still free.
     */
    /*
     * Resolved once for the turn, not once per step.
     *
     * The runtime block is rewritten on every step because its tail position makes rewriting free
     * in cache terms - but "free to write" is not "free to compute": the roster reads stored
     * preferences and selects models. Its choices stay fixed inside a turn. It is read here and
     * captured, so the per-step rewrite is a string interpolation.
     */
    const modelRoster = await taskModelRoster(
      {
        store: this.store,
        masterKey: this.#masterKey,
        connectedModels: (forTask, catalog) => this.#connectedModels(forTask, catalog)
      },
      task,
      catalog,
      model.id
    ).catch(() => []);
    const refreshRuntimeContext = (): void => {
      refreshRuntimeContext_(this.#window, {
        workspace,
        task,
        state,
        timeZone,
        toolchainSummary,
        machineSummary,
        unattended,
        webPlan,
        modelRoster
      });
    };
    // Called here as well as in the step loop so a window saved when this block lived at index 1
    // is migrated before the preamble blocks below choose where they go.
    refreshRuntimeContext();
    // The preamble: the two frozen blocks, the recalled pack and the workspace brief, in the order
    // a provider's cache charges for. @see assemblePreamble in `window.ts`.
    await assemblePreamble(this.#window, {
      task,
      key,
      state,
      goal: prompt,
      contextTokens: model.contextTokens
    });
    const turn = state.turn ?? 0;
    /*
     * The output ceiling every request this turn makes is written against, worked out once.
     *
     * It is a pure function of the chosen model's window and nothing in the loop can move it, and
     * it was recomputed - identically, from the same two constants - in five places: once per step
     * and once in each of the three closing handoffs.
     */
    const maxOutputTokens = Math.min(
      16_384,
      Math.max(2_048, Math.floor(model.contextTokens * 0.2))
    );
    /**
     * What a closing handoff is built from, fixed for the life of the run.
     *
     * @see closeTurnAtCeiling in `turn/close.ts`, which is the whole of what the wall-clock, the
     * credit and the step ceilings each used to write out for themselves.
     */
    const closeContext: TurnCloseContext = {
      gateway,
      provider,
      model,
      catalog,
      turn,
      maxOutputTokens,
      get tools() {
        return run.requestTools;
      },
      webPlan
    };
    /**
     * The same two numbers as a pair, because four of the five phases below read both and neither
     * moves for the life of the turn. @see TurnStepBudget in `turn/loop-context.ts`.
     */
    const budget: TurnStepBudget = { maxOutputTokens, turn };

    /** @see refreshActivePlan in `window.ts`, where this moved in Wave 7.2. */
    const refreshActivePlan = async (createFallback = false): Promise<boolean> =>
      refreshActivePlan_(this.#window, task, key, state, createFallback);

    // Repairs and read-only queries need no synthetic plan. The model can plan substantive work
    // explicitly; changes without a plan still receive a visible verification checklist.
    await refreshActivePlan(state.mutated === true);

    /** @see drainCorrection in `turn-control.ts`, where this moved in Wave 7.2. */
    const drainCorrection = async (): Promise<boolean> =>
      drainCorrection_(this.#turnControl, task, key, state);

    /**
     * @see honorUserControl in `turn-control.ts`, where this moved in Wave 7.2 and gained the
     * ownership arm: it can now see a task that was resumed out from under this worker, which is
     * the half of the question that only `haltReason` was asking.
     */
    const honorUserControl = async (): Promise<boolean> =>
      honorUserControl_(this.#turnControl, task, key, state);

    /**
     * The four closures, as one argument.
     *
     * Every phase lifted out of the loop below is a closure over this turn's own scope in exactly
     * these four places, and each asks for the subset it uses. Bundled rather than passed one at a
     * time because a phase taking three of the four as positional arguments is a signature nobody
     * can read, and because all four have to mean the same thing in every phase or the ordering
     * each phase's own comments claim stops being true. @see `turn/loop-context.ts`.
     */
    const control: TurnLoopControl = {
      honorUserControl,
      drainCorrection,
      refreshActivePlan,
      refreshRuntimeContext
    };

    /*
     * Everything the last run left parked: a call interrupted by a restart, an approval the owner
     * has since answered or ignored, a question they have since replied to.
     *
     * @see resumeParkedTurn in `turn/resume.ts`. All three end the same two ways - the turn
     * carries on, or it goes back to waiting exactly as it was - which is what makes a re-lease
     * from any direction safe.
     */
    if (
      await resumeParkedTurn(
        this.#resume,
        task,
        key,
        state,
        { model, catalog, webPlan },
        honorUserControl
      )
    )
      return;

    if (await honorUserControl()) return;
    if (await parkBrowserHandoff(this.#turnControl, task, key, state)) return;
    await this.store.updateTask({
      id: task.id,
      workerId: this.config.WORKER_ID,
      status: 'running'
    });
    if (state.step === 0)
      await event(this.store, task, key, 'status', 'Agent started work', {
        model: model.displayName,
        provider,
        maxSteps: this.config.TASK_MAX_STEPS,
        contextPolicy: 'one operating contract, bounded tool output, and a condensed running brief',
        contextWindowTokens: model.contextTokens
      });

    /*
     * The step ceiling, asked rather than fixed.
     *
     * The first clause is the budget as it has always been. The second is the only thing that can
     * move it: at the ceiling, and nowhere else, the harness runs the acceptance record the model
     * declared before the work and grants another budget when the job is demonstrably unfinished and
     * demonstrably still moving. It raises `selfContinuations`, which raises the first clause, so the
     * loop cannot spin here - each renewal is one whole budget of progress and there are at most
     * `TASK_MAX_SELF_CONTINUATIONS` of them.
     */
    for (
      ;
      state.step < this.#stepCeiling(state) || (await this.#renewStepBudget(task, key, state));
      state.step += 1
    ) {
      /*
       * The owner, a correction, the plan, the dormant rules, the clock, the credits and the spend
       * caps. @see openStep in `turn/step-open.ts`, where the sixty-two lines that asked all of
       * that - including two of the three closing handoffs - now live.
       */
      if (
        (await openStep(this.#stepOpen, task, key, state, closeContext, turnStartedAt, control)) ===
        'closed'
      )
        return;
      /*
       * Everything that has to be true, and everything that has to be measured, before a request is
       * sent: the spend counter cleared, the window checked against the model, compaction, and the
       * window and effort this step is written against. @see prepareStepRequest in `turn/request.ts`.
       */
      const request = await prepareStepRequest(
        this.#request,
        task,
        key,
        state,
        run,
        budget,
        control
      );
      /*
       * The one call in the turn that spends the owner's money, and the four watches around it.
       *
       * @see generateModelStep in `turn/generate.ts`, where the two hundred and seventy-four lines
       * between assembling the request and having an answer in hand now live - the stream channel,
       * the repetition watch, the stop watch, the route's refusal of an oversized window, and the
       * billing block every one of those abort paths has to reach.
       */
      const generated = await generateModelStep(
        this.#generate,
        task,
        key,
        state,
        run,
        budget,
        request,
        control
      );
      if (generated.outcome === 'halted') return;
      if (generated.outcome === 'retry') continue;
      const { response } = generated;
      /*
       * A provider that has just answered is not walled any more, whatever it was doing an hour ago.
       *
       * The list exists to stop a task rotating between two providers inside one bad afternoon, and
       * a billed response is proof the afternoon is over. Left uncleared it would only ever grow:
       * three walls across a week-long task would exhaust the re-route budget for the rest of its
       * life and put it back to parking on the first wall after that.
       */
      if (state.walledProviders?.length) delete state.walledProviders;
      if (state.walledModels?.length) delete state.walledModels;
      /*
       * What the step said: the provenance notice for anything the provider fetched itself, the
       * assistant message into the window, and - only when this is a new answer rather than a round
       * the harness asked for - the reply onto the owner's timeline. @see recordAssistantStep in
       * `turn/record-step.ts`.
       */
      const assistantText = await recordAssistantStep(this.#recordStep, task, key, state, response);
      if (await honorUserControl()) return;

      // A step without tool calls is the answer, a reply cut off, or a continuation.
      const hold = await resolveAnswerHolds(this.#finish, task, key, state, {
        response,
        assistantText
      });
      if (hold === 'completed') return;
      if (hold === 'continue') continue;
      // Read before the batch and again after it. Anything in between that starts a tool moves it,
      // and nothing else in the loop can - which is what makes the difference the guard's evidence.
      const startedBeforeBatch = state.toolsStarted ?? 0;
      // Read the same way and for the same reason: what this step did to the counts is the
      // evidence, not what they stood at when it began.
      const failuresBeforeBatch = state.repeatedFailures;

      /*
       * The batch the model proposed, and the nine gates each call passes before it runs.
       *
       * @see dispatchToolCalls in `turn/dispatch.ts`, where the two hundred and seventy-two lines
       * that ran it - at nesting depth nine, inside the step loop inside `run()` - now live.
       * `'returned'` is the turn ending inside the batch: completed, parked on a question, parked
       * on an approval, or stood down by the owner, and everything owed already written.
       */
      if (
        (await dispatchToolCalls(
          this.#dispatch,
          task,
          key,
          state,
          response,
          run,
          budget,
          control
        )) === 'returned'
      )
        return;
      sealUnansweredToolCalls(state.messages, 'the step ended before this call ran');
      if (await parkBrowserHandoff(this.#turnControl, task, key, state)) return;

      /*
       * The three questions asked at the end of every step: did anything happen in it, did any of
       * it fail the way it failed last time, and is it still doing anything different from what it
       * did last step. @see enforceStepBounds in `turn/step-bounds.ts`, where the hundred and
       * seventy lines that asked them - and the three copies of the way a turn ends when one is
       * answered badly - now live.
       */
      if (
        await enforceStepBounds(this.#stepBounds, task, key, state, {
          proposed: response.toolCalls.map((call) => call.name),
          startedBeforeBatch,
          failuresBeforeBatch
        })
      )
        return;
      await this.store.updateTask({
        id: task.id,
        workerId: this.config.WORKER_ID,
        status: 'running',
        actualComputeCredits: state.credits,
        agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
      });
      await this.store.renewTaskLease(task.id, this.config.WORKER_ID, TASK_LEASE_SECONDS);
    }
    // Asked once more before the closing call is billed: a Stop pressed during the final step has
    // already said what the owner wants to happen next, and a handoff is not it.
    if (await honorUserControl()) return;
    await closeTurnAtCeiling(this.#handoff, task, key, state, closeContext, {
      code: 'step_limit_reached',
      spent: `used all ${this.#stepCeiling(state)} of its steps`
    });
  }

  /**
   * How many providers one task will try before it accepts that waiting is the answer.
   *
   * Three, because the bound is about not thrashing rather than about exhausting the catalogue: an
   * account with three providers all refusing inside one turn is having an outage, not a rate
   * limit, and parking is the right response to an outage.
   */
  static readonly #MAX_WALL_REROUTES = 3;

  /**
   * Moves a walled task onto a provider that is answering, or reports that there is none.
   *
   * Returns true when the task has been re-queued on a new route and the caller must not also park
   * it. Everything here is allowed to fail into `false`: a re-route is an improvement on waiting,
   * never a replacement for it, and a task that cannot be moved must still reach the parking path
   * with its wall intact.
   */
  async #rerouteAroundWall(
    task: TaskRecord,
    workspace: WorkspaceRecord,
    error: GardenError
  ): Promise<boolean> {
    try {
      const key = unwrapDataKey(workspace.wrappedKey!, this.#masterKey, workspace.id);
      const current = await this.store.getTask(task.userId, task.id);
      if (!current?.agentStateCiphertext) return false;
      const state = decryptJson<AgentState>(current.agentStateCiphertext, key);
      const catalog = (await this.store.listModels()) as unknown as ModelRelease[];
      const walledModel = catalog.find((entry) => entry.id === task.modelId);
      /*
       * Usually the provider that refused, not the model: a quota is spent per account per
       * provider, and moving to that provider's next model would meet the same wall a moment later.
       * Unless the provider said the limit was this model's own host - then the account is fine and
       * only this model is set aside.
       */
      const modelOnly = error.details?.limitScope === 'model';
      const walled = [
        ...new Set(
          [...(state.walledProviders ?? []), modelOnly ? '' : (walledModel?.provider ?? '')].filter(
            Boolean
          )
        )
      ];
      const walledModels = [
        ...new Set([...(state.walledModels ?? []), ...(modelOnly ? [task.modelId] : [])])
      ];
      if (walled.length + walledModels.length > AgentWorker.#MAX_WALL_REROUTES) return false;
      /*
       * Only routes this account can actually reach. Without this the selector would happily hand
       * back a model from a provider the owner has never connected, and the next turn would fail
       * on `provider_model_mismatch` - a worse failure than the wall, because it does not lift.
       */
      const connections = await this.#inferenceConnections(task);
      const reachable = catalog.filter((entry) => {
        const id = modelConnectionId(entry, connections.keys());
        return id !== null && !walled.includes(entry.provider) && !walledModels.includes(entry.id);
      });
      if (reachable.length === 0) return false;
      const chosen = selectModel(reachable, {
        privacyRoute: task.privacyRoute === 'provider_zdr' ? 'provider_zdr' : 'external',
        requiredCapabilities: ['chat', 'tools'],
        requiredModalities: ['text'],
        minContextTokens: 16_000,
        preference: 'balanced',
        taskKind: 'general'
      }).choice?.model;
      if (!chosen || chosen.id === task.modelId) return false;
      state.walledProviders = walled;
      if (walledModels.length) state.walledModels = walledModels;
      const moved = await this.store.rerouteTaskModel({
        id: task.id,
        workerId: this.config.WORKER_ID,
        modelId: chosen.id,
        actualComputeCredits: state.credits,
        agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
      });
      if (!moved) return false;
      await event(
        this.store,
        task,
        key,
        'status',
        modelOnly
          ? `${walledModel?.displayName ?? 'The chosen model'} is rate-limited at its host right now, so this moved to ${chosen.displayName} and carried on`
          : `${walledModel?.displayName ?? 'The chosen model'} is not answering, so this moved to ${chosen.displayName} and carried on`,
        { owner: true, code: error.code, from: task.modelId, to: chosen.id }
      ).catch(() => undefined);
      return true;
    } catch {
      // A re-route that cannot be worked out is not a failure of its own: the wall below is still
      // the truth about this task, and parking is still a correct answer to it.
      return false;
    }
  }

  /**
   * Reads the aggregator's own account of a generation and keeps it as the model's speed ceiling.
   *
   * The credential is fetched rather than passed because this runs after the turn's own work is
   * done, on a path where failing is free. Everything about it degrades to silence: no credential,
   * no answer, a short generation not worth timing - the ceiling simply stays unmeasured and the
   * next turn routes by throughput and tries again.
   */
  async #recordThroughputCeiling(
    task: TaskRecord,
    model: ModelRelease,
    generationId: string
  ): Promise<void> {
    try {
      const credential = await this.#credentialForModel(task, model);
      if (credential.provider !== 'openrouter' || !credential.apiKey) return;
      const apiKey = credential.apiKey;
      const measured = await runtimeCall(
        'provider.throughput',
        [{ baseUrl: this.config.OPENROUTER_BASE_URL, generationId }],
        () =>
          fetchGenerationThroughput({
            baseUrl: this.config.OPENROUTER_BASE_URL,
            apiKey,
            generationId
          })
      );
      if (!measured) return;
      await this.store.recordModelThroughputCeiling({
        modelId: model.id,
        tokensPerSecond: measured.tokensPerSecond,
        providerName: measured.provider
      });
    } catch {
      // An unmeasured ceiling is the state this started in, and the next turn asks again.
    }
  }

  async fail(task: TaskRecord, error: unknown, durationMs?: number): Promise<void> {
    if (runtimeObservations()?.mode === 'replay') return this.#fail(task, error, durationMs);
    const capture = await TaskDiagnosticCapture.open(
      this.store,
      task,
      this.config.WORKER_ID,
      this.#masterKey
    );
    return capture
      ? capture.run(() => this.#fail(task, error, durationMs), {
          config: this.config,
          masterKey: this.#masterKey,
          caches: this.replayCaches(task.workspaceId),
          entry: 'fail',
          error,
          durationMs
        })
      : withPrivateDiagnostics(undefined, () => this.#fail(task, error, durationMs));
  }

  async #fail(task: TaskRecord, error: unknown, durationMs?: number): Promise<void> {
    const workspace = await this.store.getWorkspaceById(task.workspaceId).catch(() => null);
    if (
      task.hasCodingFamily &&
      !task.parentMissionId &&
      error instanceof GardenError &&
      ['coding_family_budget', 'coding_family_spend'].includes(error.code) &&
      workspace?.wrappedKey
    ) {
      const key = unwrapDataKey(workspace.wrappedKey, this.#masterKey, workspace.id);
      const current = await this.store.getTask(task.userId, task.id);
      if (current?.agentStateCiphertext) {
        const state = decryptJson<AgentState>(current.agentStateCiphertext, key);
        state.codingMissionWaiting = true;
        state.messages.push({
          role: 'system',
          content:
            'The parent is waiting for its coding specialists to release shared budget capacity. Continue from their recorded state when resumed.'
        });
        if (
          await this.store.parkForCodingMissions({
            taskId: task.id,
            workerId: this.config.WORKER_ID,
            agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
            actualComputeCredits: state.credits
          })
        ) {
          await event(this.store, task, key, 'status', 'Waiting for coding specialist capacity', {
            codingMissions: { waiting: true }
          });
          return;
        }
      }
      await this.store.updateTask({
        id: task.id,
        workerId: this.config.WORKER_ID,
        status: 'paused',
        clearLease: true
      });
      await event(this.store, task, key, 'warning', error.message, {
        owner: true,
        code: error.code
      });
      return;
    }
    /*
     * A wall on one provider is not a reason to stop when the owner has another.
     *
     * Parking behind the provider that refused, and waiting up to a day for it to lift, was the
     * only possible answer while an account could hold one credential: there was nowhere else to
     * go. An account can now hold a connection per provider, so a rate limit or an outage on one is
     * a reason to re-point this task at a route that is answering and let it carry on.
     *
     * Between turns rather than inside one, deliberately. `TurnRun` freezes the model for the run
     * and `requestDerivationBreach` fails the turn if the request stops matching what the run says
     * - a guarantee worth more than the few seconds a mid-turn swap would save. The task is
     * re-queued on the new route and picks up from its own saved state.
     *
     * Bounded by the providers already tried, which is what stops two providers having a bad
     * afternoon from bouncing a task between them; when every reachable one has walled, this falls
     * through to the parking below and behaves exactly as it did before.
     */
    if (
      error instanceof GardenError &&
      isProviderWall(error) &&
      PARKABLE_PROVIDER_WALLS.has(error.code) &&
      workspace?.wrappedKey &&
      (await this.#rerouteAroundWall(task, workspace, error))
    )
      return;
    const message = error instanceof Error ? error.message : 'Task failed';
    // Both halves have to hold. `isProviderWall` answers whether waiting is any use, and
    // `PARKABLE_PROVIDER_WALLS` answers whether anything on this box would ever ask again: a code
    // named here and missing from the API's own table parks the work for ever with nothing left to
    // wake it, which is strictly worse than failing, because failing at least tells the owner.
    const waiting =
      error instanceof GardenError &&
      isProviderWall(error) &&
      PARKABLE_PROVIDER_WALLS.has(error.code);
    let turn = 0;
    let step = 0;
    if (workspace?.wrappedKey && task.agentStateCiphertext) {
      try {
        const key = unwrapDataKey(workspace.wrappedKey, this.#masterKey, workspace.id);
        const saved = decryptJson<Pick<AgentState, 'turn' | 'step'>>(
          task.agentStateCiphertext,
          key
        );
        turn = saved.turn ?? 0;
        step = saved.step ?? 0;
      } catch {
        turn = 0;
        step = 0;
      }
    }
    // Before the writes below, all of which need the database - which is one of the things that
    // fails here. The journal record is the one that survives the store being the problem.
    const record = taskFailureRecord(
      {
        taskId: task.id,
        attempt: task.attempt,
        turn,
        step,
        modelId: task.modelId,
        ...(durationMs === undefined ? {} : { durationMs }),
        error,
        waiting
      },
      this.#loggedFailureStacks
    );
    this.logger[record.level](record.event, record.fields);
    if (workspace?.wrappedKey) {
      const key = unwrapDataKey(workspace.wrappedKey, this.#masterKey, workspace.id);
      await event(
        this.store,
        task,
        key,
        error instanceof GardenError && error.code.includes('provider') ? 'warning' : 'error',
        message.slice(0, 500),
        // The task stopped and did not do what was asked. Whatever else is folded away, the reason
        // the work is not there has to be in the conversation.
        { owner: true, code: error instanceof GardenError ? error.code : 'agent_failed' }
      );
    }
    /*
     * A message the owner sent while this turn was running outlives the turn.
     *
     * Nothing here used to look at the queue at all. A correction typed into a turn that was going
     * wrong - which is the moment the queue exists for - was answered with "the agent picks it up
     * at its next step", and if the turn then died there was no next step, ever: the row stayed
     * queued on a task nothing would lease again, and the header went on counting it.
     *
     * `awaiting_resource` is deliberately not in here. A provider wall is already resumed by the
     * sweep in the API, on a widening interval and with a line of its own when it gives up asking,
     * and the message really is still waiting on that path - so the count is telling the truth and
     * requeueing underneath the sweep would only take the pacing away from it.
     */
    const carried = waiting
      ? null
      : await this.store
          .requeueTaskForQueuedMessage({ id: task.id, workerId: this.config.WORKER_ID })
          .catch(() => null);
    if (carried) {
      this.logger.info('task.retried_for_queued_message', {
        taskId: task.id,
        attempt: carried.attempt,
        attempts: TASK_MAX_ATTEMPTS
      });
      // Said after the requeue rather than before it, so nothing is announced that did not happen.
      // The cost is that a worker may lease the task back before this line lands; an event arriving
      // a moment into the next attempt is a smaller wrong than a promise the write did not keep.
      if (workspace?.wrappedKey)
        await event(
          this.store,
          task,
          unwrapDataKey(workspace.wrappedKey, this.#masterKey, workspace.id),
          'warning',
          `This turn stopped before the message you sent could be started. It is still queued and this conversation is going back in the queue to carry on from where it stopped - start ${carried.attempt + 1} of ${TASK_MAX_ATTEMPTS}.`,
          { owner: true, code: 'queued_message_retried', attempt: carried.attempt + 1 }
        ).catch(() => undefined);
      // The reservation stays reserved and the status stays leasable, exactly as on the provider
      // wall above: this task is going to run again, and releasing the credits it is about to spend
      // would leave the next attempt budgeted for nothing.
      return;
    }
    if (!waiting)
      await this.store.transitionUsage(reservationUsageKey(task.id, turn), 'reserved', 'released');
    await this.store.updateTask({
      id: task.id,
      workerId: this.config.WORKER_ID,
      status: waiting ? 'awaiting_resource' : 'failed',
      clearLease: true
    });
    if (!waiting) await this.#refuseUndeliveredMessages(task, workspace);
  }

  /**
   * Says out loud that the owner's message is not going to run, and gives them back their words.
   *
   * Reached when the conversation has stopped for good with something still queued - which after
   * the retry above means the attempt ceiling, or a task the owner cancelled while it was dying.
   * Cancelling already empties this queue, so in practice that second door finds nothing, which is
   * the intended shape: a conversation the owner stopped stays stopped and says nothing further.
   *
   * A correction that is quietly dropped is worse than one that is refused, so the refusal carries
   * the message back verbatim. The row is moved out of 'queued' either way - that is what stops the
   * header counting a message that cannot arrive - but the sentence is what the owner is actually
   * owed, and the text in the payload is what a re-send can be built on without asking them to
   * retype anything.
   */
  async #refuseUndeliveredMessages(
    task: TaskRecord,
    workspace: { id: string; wrappedKey?: string } | null
  ): Promise<void> {
    const stranded = await this.store.strandQueuedTaskMessages(task.id).catch(() => []);
    if (!stranded.length) return;
    this.logger.warn('task.queued_messages_undelivered', {
      taskId: task.id,
      attempt: task.attempt,
      count: stranded.length
    });
    if (!workspace?.wrappedKey) return;
    const key = unwrapDataKey(workspace.wrappedKey, this.#masterKey, workspace.id);
    // Said only where it is known to be true. The ceiling is the reason nearly every time, but this
    // is also where a conversation the owner stopped mid-failure arrives, and telling them their
    // work was tried six times when they cancelled it after one is the kind of confident wrong
    // sentence the whole of this file is meant to stop writing.
    const exhausted =
      task.attempt >= TASK_MAX_ATTEMPTS
        ? ` This conversation was started ${task.attempt} times without finishing.`
        : '';
    for (const queued of stranded) {
      // A message whose envelope will not open is still a message that did not arrive, so the
      // refusal is written either way and only the quotation is missing from it. Reading it must
      // not be able to throw: this is the last thing said about a conversation that has already
      // failed once, and losing the refusal to a bad envelope would leave the owner with silence.
      let markdown = '';
      let attachments: string[] | undefined;
      try {
        if (queued.promptCiphertext.aad === `task-message:${task.id}`) {
          const message = decryptJson<OwnerMessage>(queued.promptCiphertext, key);
          markdown = message.prompt.trim();
          attachments = message.attachments;
        }
      } catch {
        markdown = '';
      }
      await event(
        this.store,
        task,
        key,
        'warning',
        `Your message was not started, and garden is not going to start it on its own.${exhausted}${markdown ? ` What you sent was: "${markdown.slice(0, 240)}"` : ''} Send it again to try.`,
        {
          owner: true,
          code: 'queued_message_undelivered',
          ...(markdown ? { markdown, attachments } : {})
        }
      ).catch(() => undefined);
    }
  }
}

export { runCodingMissionLoop } from './coding-mission-loop.js';
