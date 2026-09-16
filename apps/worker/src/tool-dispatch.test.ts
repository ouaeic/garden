import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptJson,
  encryptJson,
  generateDataKey,
  inferenceCredentialAad,
  userMemoryAad,
  userMemoryKey,
  verifyCapabilityToken,
  wrapDataKey
} from '@athanor/core';
import type { DataStore, TaskEventRecord, TaskRecord, WorkspaceRecord } from '@athanor/data';
import type { ModelRelease } from '@athanor/contracts';
import { AgentWorker, approvalPreviewHash } from './agent.js';
import { fixtureMediaRouting } from './media-fixture.js';
import type { WorkerConfig } from './config.js';
import type { InferenceCredential } from './agent-state.js';
import { forgetReads, recordRead } from './edit/index.js';

/**
 * The dispatch table, arm by arm: what each tool asks the workspace runner for.
 *
 * `#execute` is a 2,100-line switch in the middle of the loop class, and the only coverage it has
 * is whole-task fixtures written to prove something else - so an arm that reached for the wrong
 * scope, posted to the wrong route, or dropped a field out of a request body would pass every
 * existing test and the type-checker with it. That is precisely the failure a decomposition into a
 * dispatch table produces: the arms are moved by hand, they compile, and nothing looks at the wire.
 *
 * So this file asserts the wire. For every arm it drives the real loop through one tool call and
 * checks the whole sequence of runner requests it produced - the capability scopes minted for each
 * one (read back out of the signed token, which is where the runner reads them from), the method,
 * the path with its query string, and the request body - plus the result the model is handed back.
 * Arms that reach the store rather than the runner are asserted on the store call instead, because
 * for those the store call is the wire.
 *
 * It must pass unchanged against the current, unmoved `#execute` and against whatever it becomes.
 * That is the whole point: the same assertions run on both sides of the move, so a mis-copied arm
 * is caught by a diff in this file's output rather than by an owner six weeks later.
 *
 * Every one of the thirty-seven `case` labels is exercised, and so is the `default` that names an
 * unknown tool: `set_plan`, `shell`, `process`, `files_list`, `file_read`, `document_read`,
 * `audio_read`, `document_search`, `code_search`, `repo_overview`, `code_diagnostics`,
 * `coding_agent`, `file_patch`, `session_search`, `memory_recall`, `schedule`, `memory`, `skill`,
 * `delegate`, `image_read`, `file_write`, `generate_media`, `publish_artifact`, `publish_preview`
 * at both reaches, `browser_snapshot`, `read_elements`, `print_pdf`, `web_search` on both routes,
 * `parallel_web_read`, `browser_action`, `desktop_observe`, `desktop_launch`, `desktop_action`,
 * `connector_list`, `connector_action`. The arms that branch again inside themselves - `schedule`,
 * `memory`, `skill`, `coding_agent`, `process` - carry a case per branch, because a sub-branch is
 * exactly as easy to drop in a move as a whole arm and rather harder to notice.
 *
 * The fixtures below - the workspace, the model release, the worker config, the store probe, the
 * SSE frame builders - are `agent-run.test.ts`'s, kept in step with it deliberately: that file's
 * machinery is not exported and importing a test file would run its suite twice. Anything that
 * changes there in a way that matters here will fail here too, which is the intended coupling.
 *
 * Nothing here modifies production code.
 */

const masterKey = Buffer.alloc(32, 5);
const runnerSecret = 'r'.repeat(48);
const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const dataKey = generateDataKey();

const PROVIDER_URL = 'https://provider.test/v1';
const RUNNER_URL = 'http://127.0.0.1:4300';
/** Every workspace route hangs off this, exactly as `#execute`'s own `root` does. */
const root = `/v1/workspaces/${workspaceId}`;

const workspace: WorkspaceRecord = {
  id: workspaceId,
  userId,
  name: 'Study',
  status: 'running',
  storageBytes: 1_000,
  storageLimitBytes: 1_000_000,
  imageRevision: 'r1',
  region: 'self-hosted',
  keyProtection: 'hosted',
  securityMode: 'balanced',
  runnerRef: null,
  computeMeteredAt: null,
  wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId),
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
};

const model: ModelRelease = {
  id: 'model-1',
  providerModelId: 'vendor/model-1',
  displayName: 'Model One',
  provider: 'custom',
  revision: 'r1',
  availability: 'available',
  openness: 'permissive_open_weight',
  license: 'apache-2.0',
  commercialUse: true,
  privacyRoute: 'provider_zdr',
  contextTokens: 128_000,
  modalities: ['text'],
  capabilities: ['chat', 'tools', 'reasoning'],
  usageClass: 'light',
  recommendationTags: [],
  measuredQuality: 0.8,
  measuredLatencyMs: 100,
  updatedAt: '2026-07-01T00:00:00.000Z'
};

type TestConfig = Omit<WorkerConfig, 'WORKER_HEALTH_PORT' | 'WORKER_HEALTH_HOST'>;

const config = (overrides: Partial<WorkerConfig> = {}): TestConfig => ({
  WORKER_ID: 'worker-test',
  DATABASE_DRIVER: 'pglite',
  DATABASE_URL: 'postgres://localhost/athanor',
  PGLITE_PATH: ':memory:',
  DATA_MASTER_KEY: masterKey.toString('base64'),
  RUNNER_SHARED_SECRET: 'x'.repeat(48),
  WORKSPACE_RUNNER_URL: RUNNER_URL,
  PREVIEW_BASE_URL: 'http://preview.localhost:4400',
  OPENROUTER_BASE_URL: PROVIDER_URL,
  AI_PROVIDER: 'openai-compatible',
  AI_BASE_URL: PROVIDER_URL,
  AI_API_KEY: 'provider-key',
  AI_REQUIRE_ZDR: false,
  AI_FORCE_INHOUSE_WEB: false,
  ALLOW_INSECURE_PROVIDER_URLS: true,
  PUBLIC_APP_URL: 'http://localhost:5173',
  CONNECTOR_ALLOWED_HOST_SUFFIXES: '',
  WORKER_CONCURRENCY: 2,
  WORKER_POLL_MS: 1_000,
  // One step, so the turn dispatches the call under test and then hands off. Self-continuation off
  // for the same reason every other suite here keeps it off: it would add a second turn nobody is
  // asserting about.
  TASK_MAX_STEPS: 1,
  TASK_MAX_SELF_CONTINUATIONS: 0,
  ...overrides
});

interface StoreCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

interface StoreProbe {
  readonly store: DataStore;
  readonly calls: StoreCall[];
  readonly events: Array<{ kind: string; summary: string; payload: unknown }>;
}

/**
 * Records the store method and its arguments, then answers. Arms that never reach the runner -
 * `set_plan`, `memory`, `schedule`, `session_search` - are entirely store calls, so the recording
 * is what stands in for the wire for those.
 */
const spy =
  (calls: StoreCall[], method: string, answer: (...args: never[]) => unknown) =>
  async (...args: unknown[]): Promise<unknown> => {
    calls.push({ method, args });
    return (answer as (...input: unknown[]) => unknown)(...args);
  };

const probeStore = (task: () => TaskRecord): StoreProbe => {
  const calls: StoreCall[] = [];
  const events: StoreProbe['events'] = [];
  const initial = task();
  const storedEvents: TaskEventRecord[] = [
    {
      id: '44444444-4444-4444-8444-000000000001',
      taskId: initial.id,
      sequence: 1,
      kind: 'user_message',
      summary: 'Owner direction',
      createdAt: initial.createdAt,
      payloadCiphertext: encryptJson(
        { markdown: decryptJson<{ prompt: string }>(initial.promptCiphertext, dataKey).prompt },
        dataKey,
        `task-event:${initial.id}`
      )
    }
  ];
  const store: Record<string, unknown> = {
    // The turn's own scaffolding: everything the loop needs before and after the one call under
    // test. Kept minimal on purpose - a probe that answers more than the loop asks for hides the
    // question of what it asked.
    getWorkspaceById: async () => workspace,
    listConnectors: spy(calls, 'listConnectors', () => []),
    listModels: async () => [model],
    getManagedProviderCredential: async () => null,
    // The environment carries the credential in this fixture, as it does on a self-hosted box that
    // has never opened Settings; a double without this method fails every turn on the store call
    // that looks for saved connections rather than on what the case is about.
    listManagedProviderCredentials: async () => [],
    rerouteTaskModel: async () => false,
    recordModelThroughputCeiling: async () => undefined,
    modelThroughputCeiling: async () => null,
    listWorkspaceMemories: spy(calls, 'listWorkspaceMemories', () => []),
    curateWorkspaceSkills: spy(calls, 'curateWorkspaceSkills', () => undefined),
    listWorkspaceSkills: spy(calls, 'listWorkspaceSkills', () => []),
    getLatestTaskPlan: async () => null,
    listTaskEvents: async (
      id: string,
      after = 0,
      selection?: { kind: TaskEventRecord['kind']; limit: number }
    ) => {
      const rows = storedEvents.filter(
        (row) =>
          row.taskId === id && row.sequence > after && (!selection || row.kind === selection.kind)
      );
      return selection
        ? rows.slice(-Math.max(1, Math.min(1_000, Math.trunc(selection.limit))))
        : rows;
    },
    createTaskPlan: async () => {
      throw new Error('plan_version_conflict');
    },
    listTaskEventPage: async () => ({
      events: [],
      hasMore: false,
      oldestSequence: null,
      nextCursor: 0
    }),
    getTask: async () => task(),
    taskClaim: async () => {
      const current = task();
      return { status: current.status, leaseOwner: current.leaseOwner ?? null };
    },
    updateTask: async () => task(),
    renewTaskLease: async () => true,
    recordWorkspaceCheckpoint: async (input: Record<string, unknown>) => input,
    deleteWorkspaceCheckpoints: async (_workspaceId: string, ids: string[]) => ids.length,
    appendTaskEvent: async (input: {
      kind: TaskEventRecord['kind'];
      payloadCiphertext: Parameters<typeof decryptJson>[0];
    }) => {
      const body = decryptJson<{ summary: string; payload: unknown }>(
        input.payloadCiphertext,
        dataKey
      );
      events.push({ kind: input.kind, summary: body.summary, payload: body.payload });
      const sequence = storedEvents.length + 1;
      const row: TaskEventRecord = {
        id: `44444444-4444-4444-8444-${String(sequence).padStart(12, '0')}`,
        taskId: initial.id,
        sequence,
        kind: input.kind,
        summary: body.summary,
        payloadCiphertext: input.payloadCiphertext,
        createdAt: initial.createdAt
      };
      storedEvents.push(row);
      return row;
    },
    createAgentNotification: async () => ({ id: 'notification' }),
    recordUsage: spy(calls, 'recordUsage', () => undefined),
    spendGuard: spy(calls, 'spendGuard', () => ({
      outcome: 'allow' as const,
      estimateUsd: 0,
      blockedBy: null,
      warnedBy: [],
      reason: null,
      windows: []
    })),
    effectiveSpendLimits: async () => ({ timeZone: 'Europe/London' }),
    setWorkspaceStorage: spy(calls, 'setWorkspaceStorage', () => undefined),
    // Read by the media approval floor before `generate_media` and `audio_read` are dispatched at
    // all. Absent, both arms fail inside the floor rather than reaching the wire.
    getProjectModelPreferences: async () => ({
      projectTaskId: taskId,
      workspaceId,
      wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId),
      revision: 0,
      choicesCiphertext: null
    }),
    getUserById: async () => ({ preferences: {} }),
    mediaSpendForTask: async () => 0,
    transitionUsage: async () => undefined,
    getNextQueuedTaskMessage: async () => null,
    requeueTaskForQueuedMessage: async () => null,
    strandQueuedTaskMessages: async () => [],
    createMemoryItem: async () => ({ id: 'item' }),
    recordMemoryDeadEnds: async () => ({ recorded: [], retired: [] }),
    createMemorySource: async () => ({ id: 'source' }),
    attachMemoryEvidence: async () => undefined,
    observeMemoryFactCandidate: async () => undefined,
    promoteMemoryFactCandidates: async () => [],
    getMemoryPack: async () => null,
    recordMemoryUse: spy(calls, 'recordMemoryUse', () => 0),
    completeTaskIfNoQueued: async () => true,
    consolidateMemory: async () => undefined,
    // The store side of the arms under test.
    searchMemorySources: spy(calls, 'searchMemorySources', () => []),
    listMemorySourceWindow: spy(calls, 'listMemorySourceWindow', () => []),
    oldestMemorySourceAt: spy(calls, 'oldestMemorySourceAt', () => null),
    recallMemoryCandidates: spy(calls, 'recallMemoryCandidates', () => []),
    listTaskSchedules: spy(calls, 'listTaskSchedules', () => []),
    createTaskSchedule: spy(calls, 'createTaskSchedule', () => undefined),
    updateTaskSchedule: spy(calls, 'updateTaskSchedule', () => undefined),
    setTaskScheduleEnabled: spy(calls, 'setTaskScheduleEnabled', () => undefined),
    deleteTaskSchedule: spy(calls, 'deleteTaskSchedule', () => true),
    createWorkspaceMemory: spy(calls, 'createWorkspaceMemory', () => undefined),
    updateWorkspaceMemory: spy(calls, 'updateWorkspaceMemory', () => undefined),
    deleteWorkspaceMemory: spy(calls, 'deleteWorkspaceMemory', () => true),
    markWorkspaceSkillUsed: spy(calls, 'markWorkspaceSkillUsed', () => undefined),
    upsertWorkspaceSkill: spy(calls, 'upsertWorkspaceSkill', () => undefined),
    deleteWorkspaceSkill: spy(calls, 'deleteWorkspaceSkill', () => true),
    createArtifact: spy(calls, 'createArtifact', () => ({
      id: 'artifact-1',
      version: 3
    })),
    createWorkspacePreview: spy(calls, 'createWorkspacePreview', () => ({
      id: 'preview-1',
      slug: 'slug-1',
      expiresAt: '2026-07-02T00:00:00.000Z'
    })),
    publishWorkspacePreview: spy(calls, 'publishWorkspacePreview', () => ({
      id: 'preview-1',
      slug: 'slug-1'
    })),
    getConnector: spy(calls, 'getConnector', () => null),
    recordConnectorAudit: spy(calls, 'recordConnectorAudit', () => undefined)
  };
  return { store: store as unknown as DataStore, calls, events };
};

const makeTask = (agentState?: unknown): TaskRecord => ({
  id: taskId,
  userId,
  workspaceId,
  parentTaskId: null,
  branchedFromEventId: null,
  forkKind: null,
  scheduleId: null,
  rewindScope: null,
  restoredCheckpointId: null,
  titleCiphertext: null,
  legacyTitle: null,
  titleSource: 'prompt',
  pinned: false,
  archivedAt: null,
  status: 'running',
  modelId: model.id,
  privacyRoute: 'provider_zdr',
  securityMode: 'balanced',
  maxComputeCredits: 5,
  actualComputeCredits: 0,
  maxSpendUsd: null,
  spentUsd: 0,
  queuedMessageCount: 0,
  promptCiphertext: encryptJson({ prompt: 'Tidy the notes' }, dataKey, `task-prompt:${taskId}`),
  agentStateCiphertext: agentState
    ? encryptJson(agentState, dataKey, `task-state:${taskId}`)
    : null,
  leaseOwner: 'worker-test',
  leaseExpiresAt: '2026-07-01T00:02:00.000Z',
  attempt: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
});

const textFrame = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: { content } }] })}\n\ndata: [DONE]\n\n`;

const toolFrame = (id: string, name: string, args: Record<string, unknown>): string =>
  `data: ${JSON.stringify({
    choices: [
      {
        finish_reason: 'tool_calls',
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }]
        }
      }
    ]
  })}\n\ndata: [DONE]\n\n`;

/** One request the worker made of the workspace runner, in the terms the runner reads it in. */
interface RunnerCall {
  readonly method: string;
  /** Path and query, relative to the runner's base URL. */
  readonly path: string;
  /** Read back out of the signed capability token, which is where the runner gets them from. */
  readonly scopes: readonly string[];
  readonly body: unknown;
}

/**
 * The runner calls a turn makes for itself, whatever tool it runs.
 *
 * Matched by exact path rather than by prefix so that anything new shows up in the assertions
 * instead of disappearing into a pattern: the toolchain summary and the workspace brief are read
 * once per run before the step loop, and the undo point is taken immediately before any tool that
 * can change the computer.
 */
const isTurnScaffolding = (call: RunnerCall): boolean =>
  call.path === `${root}/toolchain` ||
  // Beside the toolchain summary and read at the same moment for the same reason: a property of
  // the machine, asked once before the step loop. It decides whether the browser and desktop
  // schemas are described at all. @see workspaceSurfaces in services/workspace-runner.
  call.path === `${root}/surfaces` ||
  // The third of the three probes read once before the step loop, and read there for the same
  // reason: cores, memory and free disk are properties of the machine the commands run on, and the
  // process that can see them is the runner rather than this one. @see machineReport.
  call.path === `${root}/machine` ||
  call.path === `${root}/checkpoints` ||
  call.path === `${root}/file?path=workspace%2FGARDEN.md` ||
  call.path === `${root}/file?path=workspace%2FATHANOR.md` ||
  call.path === `${root}/file?path=workspace%2FOPEN_CLOUD.md` ||
  call.path === `${root}/file?path=workspace%2FAGENTS.md`;

const json = (value: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json', ...headers }
  });

const bytes = (content: string, headers: Record<string, string> = {}): Response =>
  new Response(content, {
    headers: { 'content-type': 'application/octet-stream', ...headers }
  });

/** What `${root}/exec` answers with: the runner's own observation shape. */
const observation = (fields: Record<string, unknown> = {}): Response =>
  json({
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 4,
    timedOut: false,
    ...fields
  });

interface DispatchOptions {
  /**
   * Drive the call through the approved-resumption path instead of the ordinary step loop, which
   * is the only way to reach an arm the approval floor stops - and the only way to reach the two
   * arms whose scope set widens once the owner has said yes.
   */
  readonly approved?: boolean;
  readonly route?: (url: string, init?: RequestInit) => Response | undefined;
  readonly store?: Record<string, unknown>;
  readonly task?: Partial<TaskRecord>;
  readonly config?: Partial<WorkerConfig>;
  /** Provider bodies after the one that carries the tool call, for arms that spend a second call. */
  readonly provider?: string[];
  readonly providerBaseUrl?: string;
}

/** A selected, priced recording route, sealed exactly as the owner's provider configuration is. */
const NATIVE_PROVIDER_URL = 'https://api.openai.com/v1';

const transcriptionStore = (
  providerModelId: string,
  nativePrivate = false
): Record<string, unknown> => {
  const credential: InferenceCredential = {
    provider: 'openai-compatible',
    baseUrl: nativePrivate ? NATIVE_PROVIDER_URL : PROVIDER_URL,
    apiKey: 'provider-key',
    enforceZeroDataRetention: nativePrivate,
    mediaRoutes: {
      transcription: {
        id: `fixture/${providerModelId}`,
        providerModelId,
        displayName: 'Recording fixture',
        provider: nativePrivate ? 'openai' : 'fixture',
        apiProtocol: 'openai',
        modality: 'transcription',
        usdPerImage: null,
        usdPerMillionCharacters: null,
        usdPerMinute: 0.006,
        pricing: [{ billable: 'input_audio', unit: 'minute', costUsd: 0.006 }],
        priceSource: 'provider',
        zeroDataRetentionAvailable: nativePrivate,
        recommendationTags: [],
        updatedAt: model.updatedAt
      }
    }
  };
  return {
    listManagedProviderCredentials: async () => [
      {
        provider: 'inference',
        status: 'active',
        secretCiphertext: encryptJson(credential, masterKey, inferenceCredentialAad(userId))
      }
    ]
  };
};

interface Dispatched {
  /** The arm's own runner calls, in order, with the turn's scaffolding removed. */
  readonly calls: RunnerCall[];
  /** Every runner call including the scaffolding, for the assertions that care that it is absent. */
  readonly everyCall: RunnerCall[];
  readonly result: unknown;
  readonly failure: { message: string; code?: string } | undefined;
  readonly events: Array<{ kind: string; summary: string; payload: unknown }>;
  readonly storeCalls: StoreCall[];
  /**
   * The arguments of the last call to a store method, which is the arm's own: the turn writes its
   * own rows around the call - a memory pack before it, a usage row for the step's inference after
   * it - so the first call to a name is rarely the one under test.
   */
  readonly asked: (method: string) => readonly unknown[] | undefined;
  /** Every call to a store method, for the arms whose row has to be picked out of several. */
  readonly askedAll: (method: string) => Array<readonly unknown[]>;
  readonly modelRequests: Array<Record<string, unknown>>;
  readonly providerPaths: string[];
}

const requestBody = (init?: RequestInit): unknown => {
  const body = init?.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return body;
};

/**
 * The scopes the client actually asked for, read the way the runner reads them - which since the
 * audience became mandatory means naming the request, so this doubles as a check that every one of
 * the client's signing sites binds the path it is about to call. A token minted for another route
 * throws here rather than reporting its scopes.
 */
const scopesOf = (method: string, path: string, init?: RequestInit): string[] => {
  const authorization = new Headers(init?.headers).get('authorization') ?? '';
  const token = authorization.replace(/^Bearer /, '');
  return token ? [...verifyCapabilityToken(token, runnerSecret, { method, path }).scopes] : [];
};

/**
 * One tool call, dispatched by the real loop, with everything it touched written down.
 *
 * The stub answers the provider and the runner from one place so ordering stays observable, and it
 * refuses anything the test did not deliberately answer: an unrouted runner path 404s rather than
 * returning a cheerful `{ok:true}`, because a default that succeeds is how an arm calling the
 * wrong route goes unnoticed.
 */
const dispatch = async (
  call: { id?: string; name: string; arguments: Record<string, unknown> },
  options: DispatchOptions = {}
): Promise<Dispatched> => {
  const id = call.id ?? 'call-1';
  const toolCall = { id, name: call.name, arguments: call.arguments };
  const pendingState = options.approved
    ? {
        messages: [
          { role: 'user', content: 'Tidy the notes' },
          { role: 'assistant', content: '', toolCalls: [toolCall] }
        ],
        step: 1,
        credits: 0,
        pending: { approvalId: 'approval-1', toolCall }
      }
    : undefined;
  const task: TaskRecord = { ...makeTask(pendingState), ...options.task };
  const probe = probeStore(() => task);
  if (options.approved)
    Object.assign(probe.store, {
      getApproval: async () => ({
        id: 'approval-1',
        status: 'approved',
        previewHash: approvalPreviewHash(dataKey, call.name, call.arguments),
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    });
  // Wrapped rather than assigned, so a method a test answers for itself is still recorded: the
  // store call is the wire for every arm that never reaches the runner.
  if (options.store)
    for (const [method, answer] of Object.entries(options.store))
      (probe.store as unknown as Record<string, unknown>)[method] =
        typeof answer === 'function'
          ? spy(probe.calls, method, answer as (...args: never[]) => unknown)
          : answer;

  const runnerCalls: RunnerCall[] = [];
  const modelRequests: Array<Record<string, unknown>> = [];
  const providerPaths: string[] = [];
  const bodies = [
    ...(options.approved ? [] : [toolFrame(id, call.name, call.arguments)]),
    ...(options.provider ?? []),
    textFrame('Out of steps.')
  ];
  let served = 0;

  vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const providerBaseUrl = options.providerBaseUrl ?? PROVIDER_URL;
    if (url.startsWith(providerBaseUrl)) {
      providerPaths.push(url.slice(providerBaseUrl.length));
      const routed = options.route?.(url, init);
      if (routed) return routed;
      /*
       * The catalogue route naming the companies that serve a model and what they charge, which a
       * turn reads to work out the price cap it will accept. Metadata rather than generation, and
       * answered as such: served from `bodies` it would eat the frames of the step behind it and
       * shift every model response in the case by one.
       */
      if (url.includes('/endpoints')) return json({ data: { endpoints: [] } });
      if (typeof init?.body === 'string')
        modelRequests.push(JSON.parse(init.body) as Record<string, unknown>);
      const next = bodies[Math.min(served, bodies.length - 1)] ?? '';
      served += 1;
      return new Response(next, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.startsWith(RUNNER_URL))
      runnerCalls.push({
        method: init?.method ?? 'GET',
        path: url.slice(RUNNER_URL.length),
        scopes: scopesOf(init?.method ?? 'GET', url.slice(RUNNER_URL.length), init),
        body: requestBody(init)
      });
    const routed = options.route?.(url, init);
    if (routed) return routed;
    if (url.endsWith(`${root}/checkpoints`))
      return json({
        id: 'checkpoint',
        mechanism: 'content',
        createdAt: '2026-07-01T00:00:00.000Z',
        fileCount: 12,
        totalBytes: 4_096,
        storedBytes: 128,
        changedFileCount: 2,
        uncoveredFileCount: 0,
        durationMs: 21,
        pruned: []
      });
    if (url.endsWith(`${root}/usage`)) return json({ storageBytes: 2_048 });
    if (init?.method === 'PUT') return json({ ok: true, sha256: 'written-hash' });
    // Deliberately a refusal: an arm that reaches a route this test did not answer should say so.
    return new Response(JSON.stringify({ error: { code: 'not_stubbed', message: url } }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch);

  await new AgentWorker(
    probe.store,
    config(options.config ?? {}),
    masterKey,
    runnerSecret,
    undefined,
    fixtureMediaRouting
  )
    .run(task)
    .catch(() => undefined);

  const success = probe.events.find(
    (entry) =>
      entry.kind === 'tool_result' && (entry.payload as { toolCallId?: string }).toolCallId === id
  );
  const failed = probe.events.find(
    (entry) =>
      entry.kind === 'error' && (entry.payload as { toolCallId?: string }).toolCallId === id
  );
  /*
   * `publish_artifact` is the one success in the loop that does not go through
   * `#recordToolResult`: the batch writes an `artifact` event carrying the result itself, so that
   * the pane can render the file. Read here rather than in the one test, because an arm that
   * stopped taking that path would otherwise look like an arm that returned nothing.
   */
  const published = probe.events.find((entry) => entry.kind === 'artifact');
  return {
    calls: runnerCalls.filter((entry) => !isTurnScaffolding(entry)),
    everyCall: runnerCalls,
    result: (success?.payload as { result?: unknown } | undefined)?.result ?? published?.payload,
    failure: failed?.payload as { message: string; code?: string } | undefined,
    events: probe.events,
    storeCalls: probe.calls,
    asked: (method: string) =>
      [...probe.calls].reverse().find((entry) => entry.method === method)?.args,
    askedAll: (method: string) =>
      probe.calls.filter((entry) => entry.method === method).map((entry) => entry.args),
    modelRequests,
    providerPaths
  };
};

/**
 * A skill body with the four headings the upsert insists on, which is the shape a saved procedure
 * has to have before it is worth anything to a later turn.
 */
const SKILL_BODY = [
  '# Weekly report',
  '',
  '## When to use',
  'Every Monday morning.',
  '',
  '## Procedure',
  '1. Read the week.',
  '',
  '## Pitfalls',
  'Do not invent numbers.',
  '',
  '## Verification',
  'The totals reconcile.'
].join('\n');

/**
 * The ledger row the arm wrote, picked out of the ones the turn writes around it: every step's
 * inference is recorded too, and both land through the same method.
 */
const mediaUsage = (executed: Dispatched): Record<string, unknown> | undefined =>
  executed
    .askedAll('recordUsage')
    .map((args) => args[0] as Record<string, unknown>)
    .find((row) => String(row.resourceClass).startsWith('media:') && row.state === 'settled');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('what a turn asks the runner for on its own account', () => {
  /*
   * Written down because every other case in this file subtracts it. If the loop starts making a
   * call of its own that is not here, this is the case that says so, rather than that call quietly
   * becoming an arm's - and if one of these disappears, the turn has stopped reading something it
   * reads today.
   *
   * Brief names are tried in preference order and stop at the first available file. GARDEN.md
   * is preferred, followed by compatible ATHANOR.md and OPEN_CLOUD.md names and then AGENTS.md.
   * A workspace carrying none pays the complete lookup chain once per run; the exact sequence
   * below prevents these automatic reads from hiding an unrelated dispatch request.
   */
  it('reads the surfaces, the machine, the toolchain and each brief name once, and takes one undo point before a write', async () => {
    const executed = await dispatch(
      { name: 'file_write', arguments: { path: 'workspace/new.md', content: 'hello' } },
      { route: (_url, init) => (init?.method === 'PUT' ? json({ ok: true }) : undefined) }
    );

    expect(
      executed.everyCall
        .filter((call) => !executed.calls.includes(call))
        .map((call) => `${call.method} ${call.path} ${call.scopes.join('+')}`)
    ).toEqual([
      // First, and ahead of the toolchain, because it is the one read that decides what the
      // request carries rather than what it says: a box with no browser and no screen is not sent
      // the seven schemas describing them. It is one GET per run, on the same `exec` scope as the
      // toolchain summary beside it. If this line disappears, the catalogue has gone back to being
      // the unconditional constant on every box.
      `GET ${root}/surfaces exec`,
      `GET ${root}/toolchain exec`,
      // Issued together with the toolchain rather than after it - one `Promise.all`, two round
      // trips in flight at once - because both are properties of the machine, both are frozen for
      // the run, and neither decides anything about the other. Sequencing them would put a second
      // runner latency in front of every turn's first token for nothing.
      `GET ${root}/machine exec`,
      `GET ${root}/file?path=workspace%2FGARDEN.md files.read`,
      `GET ${root}/file?path=workspace%2FATHANOR.md files.read`,
      `GET ${root}/file?path=workspace%2FOPEN_CLOUD.md files.read`,
      `GET ${root}/file?path=workspace%2FAGENTS.md files.read`,
      `POST ${root}/checkpoints workspace.manage`
    ]);
  });

  it('takes no undo point at all for a call that cannot change the computer', async () => {
    const executed = await dispatch(
      { name: 'files_list', arguments: {} },
      { route: (url) => (url.includes('/files?path=') ? json({ entries: [] }) : undefined) }
    );

    expect(executed.everyCall.some((call) => call.path.endsWith('/checkpoints'))).toBe(false);
  });
});

describe('the plan arm', () => {
  it('encrypts the plan under the task key and publishes the version it created', async () => {
    const created: Array<Record<string, unknown>> = [];
    const executed = await dispatch(
      {
        name: 'set_plan',
        arguments: { steps: ['Read the brief', 'Write the notes'], branchName: 'Notes' }
      },
      {
        store: {
          createTaskPlan: async (input: Record<string, unknown>) => {
            created.push(input);
            return { id: 'plan-1', version: 4 };
          }
        }
      }
    );

    expect(executed.calls).toEqual([]);
    expect(created[0]).toMatchObject({ taskId, expectedVersion: 0, branchName: 'Notes' });
    expect(
      decryptJson<{ steps: Array<{ title: string }>; branchName: string }>(
        created[0]?.stepsCiphertext as Parameters<typeof decryptJson>[0],
        dataKey,
        `task-plan:${taskId}`
      ).steps.map((step) => step.title)
    ).toEqual(['Read the brief', 'Write the notes']);
    expect(executed.result).toMatchObject({ version: 4 });
    expect(executed.events.find((entry) => entry.kind === 'plan')?.payload).toMatchObject({
      directionEventId: '44444444-4444-4444-8444-000000000001',
      version: 4,
      branchName: 'Notes'
    });
  });

  it('reports a plan the user edited underneath it rather than failing the call', async () => {
    // The probe's default `createTaskPlan` throws `plan_version_conflict`, which is the shape the
    // store raises when a newer plan exists.
    const executed = await dispatch({ name: 'set_plan', arguments: { steps: ['Read the brief'] } });

    expect(executed.result).toEqual({
      changedByUser: true,
      instruction: 'Reload and follow the newer user-edited plan before continuing.'
    });
  });

  it('refuses a plan with no usable step, naming the shape that would have worked', async () => {
    const executed = await dispatch({ name: 'set_plan', arguments: { steps: [] } });

    expect(executed.failure?.code).toBe('invalid_plan');
    expect(executed.failure?.message).toContain('at least one step with a title');
  });
});

describe('the workspace arms', () => {
  it('runs a command on the exec route and re-reads the workspace size after it', async () => {
    const executed = await dispatch(
      {
        name: 'shell',
        arguments: { executable: 'ls', args: ['-la'], cwd: 'workspace', timeoutSeconds: 30 }
      },
      {
        route: (url) =>
          url.endsWith(`${root}/exec`) ? observation({ stdout: 'notes.md' }) : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/exec`,
        scopes: ['exec'],
        body: {
          executable: 'ls',
          args: ['-la'],
          cwd: 'workspace',
          timeoutSeconds: 30,
          yieldAfterMs: 5000,
          requestId: expect.any(String) as unknown
        }
      },
      { method: 'GET', path: `${root}/usage`, scopes: ['files.read'], body: undefined }
    ]);
    expect(executed.asked('setWorkspaceStorage')).toEqual([userId, workspaceId, 2_048]);
    expect(executed.result).toMatchObject({ exitCode: 0, stdout: 'notes.md' });
  });

  /*
   * The one sentence the runner cannot say and the model cannot see: that its shell already runs in
   * workspace/. A command naming `workspace/probe` from there reaches `workspace/workspace/probe`,
   * and the only word it gets back is the kernel's ENOENT - which reads as "the file is not there"
   * and sends the model into `find /`. Measured live in six of ten tasks. The note is appended only
   * when the missing path the command's own stderr names begins with that prefix; an ENOENT for any
   * other path says nothing, because nothing here knows why that one is missing.
   */
  it('says the shell is already in workspace/ when a workspace/ path comes back missing', async () => {
    const executed = await dispatch(
      {
        name: 'shell',
        arguments: {
          executable: 'bash',
          args: ['-lc', 'cd workspace/probe-2026-09-03 && python3 -m pytest -q']
        }
      },
      {
        route: (url) =>
          url.endsWith(`${root}/exec`)
            ? observation({
                exitCode: 1,
                stderr: 'bash: line 1: cd: workspace/probe-2026-09-03: No such file or directory\n'
              })
            : undefined
      }
    );
    expect(executed.result).toMatchObject({ exitCode: 1 });
    expect((executed.result as { note?: string }).note).toBe(
      'The shell already runs inside workspace/, so write that path without the prefix: workspace/probe-2026-09-03 is probe-2026-09-03 here.'
    );

    const elsewhere = await dispatch(
      { name: 'shell', arguments: { executable: 'cat', args: ['/etc/missing'] } },
      {
        route: (url) =>
          url.endsWith(`${root}/exec`)
            ? observation({
                exitCode: 1,
                stderr: 'cat: /etc/missing: No such file or directory\n'
              })
            : undefined
      }
    );
    expect(elsewhere.result).toMatchObject({ exitCode: 1 });
    expect(elsewhere.result).not.toHaveProperty('note');
  });

  it('asks for the package-manager capability only when the command is one', async () => {
    const executed = await dispatch(
      { name: 'shell', arguments: { executable: '/usr/bin/apt-get', args: ['update'] } },
      {
        approved: true,
        route: (url) => (url.endsWith(`${root}/exec`) ? observation() : undefined)
      }
    );

    expect(executed.calls[0]).toMatchObject({
      path: `${root}/exec`,
      scopes: ['exec', 'system.packages']
    });
  });

  it('starts a background command as a process, without the flag that said so', async () => {
    const executed = await dispatch(
      {
        name: 'shell',
        arguments: { executable: 'node', args: ['server.js'], background: true }
      },
      {
        route: (url) =>
          url.endsWith(`${root}/processes/start`)
            ? json({ sessionId: 'proc_1', status: 'running' })
            : undefined
      }
    );

    expect(executed.calls[0]).toEqual({
      method: 'POST',
      path: `${root}/processes/start`,
      scopes: ['exec'],
      body: { executable: 'node', args: ['server.js'] }
    });
  });

  it('lists processes with no body at all, and drives one by its session id', async () => {
    const listed = await dispatch(
      { name: 'process', arguments: { action: 'list' } },
      { route: (url) => (url.endsWith(`${root}/processes`) ? json({ processes: [] }) : undefined) }
    );
    expect(listed.calls).toEqual([
      { method: 'GET', path: `${root}/processes`, scopes: ['exec'], body: undefined }
    ]);

    const driven = await dispatch(
      { name: 'process', arguments: { action: 'input', sessionId: 'proc 1', data: 'y\n' } },
      {
        route: (url) =>
          url.includes(`${root}/processes/proc%201`) ? json({ status: 'running' }) : undefined
      }
    );
    expect(driven.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/processes/proc%201`,
        scopes: ['exec'],
        body: { action: 'input', data: 'y\n' }
      }
    ]);
  });

  it('refuses to drive a process without saying which one', async () => {
    const executed = await dispatch({ name: 'process', arguments: { action: 'kill' } });

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.message).toBe('process requires sessionId for this action');
  });

  it('lists files under the path it was given, with the path encoded into the query', async () => {
    const executed = await dispatch(
      { name: 'files_list', arguments: { path: 'workspace/notes dir' } },
      {
        route: (url) =>
          url.includes('/files?path=') ? json({ entries: [{ name: 'a.md' }] }) : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'GET',
        path: `${root}/files?path=workspace%2Fnotes%20dir`,
        scopes: ['files.read'],
        body: undefined
      }
    ]);
  });

  it('defaults a listing to the workspace root', async () => {
    const executed = await dispatch(
      { name: 'files_list', arguments: {} },
      { route: (url) => (url.includes('/files?path=') ? json({ entries: [] }) : undefined) }
    );

    expect(executed.calls[0]?.path).toBe(`${root}/files?path=workspace`);
  });

  /*
   * The display budget rides on the query, which is what turns an unbounded read into a statement
   * about what is going in front of the model - and what makes the runner record it as shown. This
   * runner answers with no display headers at all, which is what a runner one release behind this
   * worker does, so the fallback is under test here too: the whole body arrived, so the whole body
   * was displayed.
   */
  it('reads a whole file through the hashed read, and remembers the hash for a later write', async () => {
    const executed = await dispatch(
      { name: 'file_read', arguments: { path: 'workspace/notes.md' } },
      {
        route: (url) =>
          url.includes('path=workspace%2Fnotes.md')
            ? bytes('one\ntwo', { 'x-content-sha256': 'read-hash' })
            : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'GET',
        path: `${root}/file?path=workspace%2Fnotes.md&displayBytes=18000&displayLines=800`,
        scopes: ['files.read'],
        body: undefined
      }
    ]);
    expect(executed.result).toEqual({
      path: 'workspace/notes.md',
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      truncated: false,
      // Numbered, because a line-addressed patch has nothing to address without it. This is the
      // whole read-side cost of the edit format and it is asserted on the wire rather than argued
      // about: `docs/design/edit/EDIT-GATE.md` prices it at ~4 bytes a line.
      content: '1:one\n2:two'
    });
  });

  it('reads a window as a window, with its own byte budget on the query', async () => {
    const executed = await dispatch(
      { name: 'file_read', arguments: { path: 'workspace/log.txt', startLine: 900, endLine: 920 } },
      {
        route: (url) =>
          url.includes('startLine=900')
            ? bytes('line 900', {
                'x-start-line': '900',
                'x-end-line': '920',
                'x-total-lines': '4000',
                'x-next-start-line': '921',
                'x-truncated': 'true',
                'x-file-bytes': '90000'
              })
            : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'GET',
        path: `${root}/file?path=workspace%2Flog.txt&startLine=900&endLine=920&maxBytes=18000`,
        scopes: ['files.read'],
        body: undefined
      }
    ]);
    expect(executed.result).toEqual({
      path: 'workspace/log.txt',
      startLine: 900,
      endLine: 920,
      totalLines: 4_000,
      nextStartLine: 921,
      truncated: true,
      // From the window's own start line: a window numbered from 1 would address the wrong file.
      content: '900:line 900'
    });
  });

  it('writes a file, claims the hash this turn read, and re-reads the workspace size', async () => {
    const executed = await dispatch(
      { name: 'file_write', arguments: { path: 'workspace/new.md', content: 'hello' } },
      {
        route: (url, init) =>
          init?.method === 'PUT' ? json({ ok: true, sha256: 'after-write' }) : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'PUT',
        path: `${root}/file?path=workspace%2Fnew.md`,
        scopes: ['files.write'],
        body: 'hello'
      },
      { method: 'GET', path: `${root}/usage`, scopes: ['files.read'], body: undefined }
    ]);
    expect(executed.result).toEqual({ ok: true, sha256: 'after-write' });
  });

  it('reads the patched file once, writes what it composed, and re-reads the size', async () => {
    // Two operations in ONE patch, because a second patch on the same path is refused outright:
    // both would address the numbers of the same read while the first had already moved them.
    forgetReads();
    recordRead(taskId, 'workspace/a.md', 1, 'one\ntwo\n');
    const executed = await dispatch(
      {
        name: 'file_patch',
        arguments: {
          patches: [{ path: 'workspace/a.md', edit: 'PUT 1:\n-one\n+ONE\nPUT 2:\n-two\n+TWO\n' }]
        }
      },
      {
        route: (url, init) =>
          init?.method !== 'PUT' && url.includes('path=workspace%2Fa.md')
            ? bytes('one\ntwo\n')
            : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'GET',
        path: `${root}/file?path=workspace%2Fa.md`,
        scopes: ['files.read'],
        body: undefined
      },
      {
        method: 'PUT',
        path: `${root}/file?path=workspace%2Fa.md`,
        scopes: ['files.write'],
        body: 'ONE\nTWO\n'
      },
      { method: 'GET', path: `${root}/usage`, scopes: ['files.read'], body: undefined }
    ]);
    expect(executed.result).toMatchObject({
      patchCount: 1,
      filesChanged: [{ path: 'workspace/a.md', lines: 3 }]
    });
    // The numbers the file has NOW, so the next edit in this turn needs no read between them.
    expect(String((executed.result as { wrote: unknown }).wrote)).toContain('1:ONE');
  });

  it('applies the patches that match and reports the ones that did not', async () => {
    // `a.md` was read this turn and `b.md` was not, so the second patch is addressed at numbers
    // nothing has shown - the one failure a line-addressed dialect has that a quoted one does not.
    forgetReads();
    recordRead(taskId, 'workspace/a.md', 1, 'one\ntwo\n');
    const executed = await dispatch(
      {
        name: 'file_patch',
        arguments: {
          patches: [
            { path: 'workspace/a.md', edit: 'PUT 1:\n-one\n+ONE\n' },
            { path: 'workspace/b.md', edit: 'PUT 1:\n+x\n' }
          ]
        }
      },
      {
        route: (url, init) =>
          init?.method !== 'PUT' && url.includes('path=workspace%2F')
            ? bytes('one\ntwo\n')
            : undefined
      }
    );

    const result = executed.result as {
      patchCount: number;
      failed: Array<{ path: string; reason: string }>;
    };
    expect(result.patchCount).toBe(1);
    expect(result.failed.map((failure) => failure.path)).toEqual(['workspace/b.md']);
    // The refusal carries the file's own numbered text, so the retry is a re-emit and not a read.
    // That is the property the whole format is bought on; asserting the path alone would not see it.
    expect(result.failed[0]?.reason).toMatch(/1:one/);
  });

  it('reads a picture through the image route rather than the file one', async () => {
    const executed = await dispatch(
      { name: 'image_read', arguments: { path: 'workspace/shot.png' } },
      {
        route: (url) =>
          url.includes('/image?path=')
            ? new Response(Buffer.from('pixels'), {
                headers: { 'content-type': 'image/png', 'x-image-source-type': 'image/heic' }
              })
            : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'GET',
        path: `${root}/image?path=workspace%2Fshot.png`,
        scopes: ['files.read'],
        body: undefined
      }
    ]);
    // The event carries the summary rather than the base64, which is what keeps a picture out of
    // the timeline row - the picture itself goes to the model as an image message.
    expect(executed.result).toMatchObject({
      mimeType: 'image/png',
      path: 'workspace/shot.png',
      convertedFrom: 'image/heic'
    });
  });
});

describe('the document arms', () => {
  it('reads a document through the wrapper, with the page window on the command line', async () => {
    const executed = await dispatch(
      {
        name: 'document_read',
        arguments: { path: 'workspace/report.pdf', startPage: 3, endPage: 5, maxCharacters: 9_000 }
      },
      {
        route: (url) =>
          url.endsWith(`${root}/exec`)
            ? observation({ stdout: JSON.stringify({ pages: [{ page: 3, text: 'hello' }] }) })
            : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/exec`,
        scopes: ['exec'],
        body: {
          executable: '/usr/local/lib/athanor/athanor-document',
          args: [
            'read',
            '--path',
            'workspace/report.pdf',
            '--start-page',
            '3',
            '--end-page',
            '5',
            '--max-chars',
            '9000'
          ],
          cwd: '.',
          timeoutSeconds: 300,
          maxOutputBytes: 1_048_576
        }
      }
    ]);
    expect(executed.result).toEqual({ pages: [{ page: 3, text: 'hello' }] });
  });

  it('defaults a document read to twenty pages and eighty thousand characters', async () => {
    const executed = await dispatch(
      { name: 'document_read', arguments: { path: 'workspace/report.pdf' } },
      { route: (url) => (url.endsWith(`${root}/exec`) ? observation({ stdout: '{}' }) : undefined) }
    );

    expect((executed.calls[0]?.body as { args: string[] }).args).toEqual([
      'read',
      '--path',
      'workspace/report.pdf',
      '--start-page',
      '1',
      '--end-page',
      '20',
      '--max-chars',
      '80000'
    ]);
  });

  it("reports the extractor's own reason when it fails", async () => {
    const executed = await dispatch(
      { name: 'document_read', arguments: { path: 'workspace/broken.pdf' } },
      {
        route: (url) =>
          url.endsWith(`${root}/exec`)
            ? observation({ exitCode: 2, stderr: 'Encrypted PDF: password required' })
            : undefined
      }
    );

    expect(executed.failure).toMatchObject({
      code: 'document_read_failed',
      message: 'Encrypted PDF: password required'
    });
  });

  it('searches documents through the same wrapper with its own bounds', async () => {
    const executed = await dispatch(
      {
        name: 'document_search',
        arguments: { query: 'turnover', path: 'workspace/filings', maxResults: 4 }
      },
      {
        route: (url) =>
          url.endsWith(`${root}/exec`) ? observation({ stdout: '{"matches":[]}' }) : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/exec`,
        scopes: ['exec'],
        body: {
          executable: '/usr/local/lib/athanor/athanor-document',
          args: [
            'search',
            '--path',
            'workspace/filings',
            '--query',
            'turnover',
            '--max-files',
            '500',
            '--max-results',
            '4',
            '--max-pages',
            '500'
          ],
          cwd: '.',
          timeoutSeconds: 300,
          maxOutputBytes: 1_048_576
        }
      }
    ]);
  });

  it('passes deduplicated terminology variants as literal arguments in one document scan', async () => {
    const executed = await dispatch(
      {
        name: 'document_search',
        arguments: {
          query: 'heart attack',
          alternatives: ['myocardial infarction', 'myocardial infarction', '-ECG', 'heart attack'],
          fileOffset: 10
        }
      },
      {
        route: (url) =>
          url.endsWith(`${root}/exec`) ? observation({ stdout: '{"results":[]}' }) : undefined
      }
    );
    expect(executed.failure).toBeUndefined();
    expect(executed.calls).toHaveLength(1);
    expect((executed.calls[0]?.body as { args: string[] }).args).toEqual([
      'search',
      '--path',
      'workspace',
      '--query',
      'heart attack',
      '--max-files',
      '500',
      '--max-results',
      '12',
      '--max-pages',
      '500',
      '--alternative=myocardial infarction',
      '--alternative=-ECG',
      '--file-offset',
      '10'
    ]);
  });
  it.each([
    { alternatives: ['', 'valid'] },
    { alternatives: ['x'.repeat(501)] },
    { alternatives: Array(5).fill('valid') },
    { alternatives: 'not-an-array' },
    { alternatives: [42] },
    { alternatives: null }
  ])(
    'refuses invalid search alternatives before invoking a reader: $alternatives',
    async ({ alternatives }) => {
      const executed = await dispatch({
        name: 'document_search',
        arguments: { query: 'heart attack', alternatives }
      });
      expect(executed.calls).toEqual([]);
      expect(executed.failure?.code).toBe('document_alternatives_invalid');
    }
  );

  it('refuses a document search with nothing to look for', async () => {
    const executed = await dispatch({ name: 'document_search', arguments: { query: '  ' } });

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe('document_query_empty');
  });
});

describe('the repository arms', () => {
  it('searches code with ripgrep, in the directory it was pointed at', async () => {
    const executed = await dispatch(
      {
        name: 'code_search',
        arguments: { query: 'startTurn', path: 'workspace/app', glob: '*.ts' }
      },
      {
        route: (url) =>
          url.endsWith(`${root}/exec`)
            ? observation({ stdout: 'src/a.ts:3:1:startTurn()' })
            : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/exec`,
        scopes: ['exec'],
        body: {
          executable: 'rg',
          args: [
            '--line-number',
            '--column',
            '--no-heading',
            // The runner caps a command's output at 1 MiB and keeps the ends, and this arm slices
            // to `maxResults` on top of that, so without a settled order both cuts fall wherever
            // ripgrep's threads happened to finish. `repository.test.ts` pins the consequence.
            '--sort',
            'path',
            '--color',
            'never',
            '--smart-case',
            '--glob',
            '*.ts',
            '--',
            'startTurn',
            '.'
          ],
          cwd: 'workspace/app',
          timeoutSeconds: 60
        }
      }
    ]);
    expect(executed.result).toMatchObject({
      query: 'startTurn',
      path: 'workspace/app',
      literal: false,
      matches: ['src/a.ts:3:1:startTurn()'],
      totalReturned: 1,
      truncated: false
    });
  });

  it('takes a whole-word search literally, and drops a glob a model wrote as "none"', async () => {
    const executed = await dispatch(
      { name: 'code_search', arguments: { query: 'total', wholeWord: true, glob: 'none' } },
      { route: (url) => (url.endsWith(`${root}/exec`) ? observation({ exitCode: 1 }) : undefined) }
    );

    expect((executed.calls[0]?.body as { args: string[] }).args).toEqual([
      '--line-number',
      '--column',
      '--no-heading',
      '--sort',
      'path',
      '--color',
      'never',
      '--smart-case',
      '--fixed-strings',
      '--word-regexp',
      '--',
      'total',
      '.'
    ]);
  });

  /*
   * The flag that makes the overview an overview rather than a race.
   *
   * ripgrep searches in parallel and emits in completion order, so without this the three hundred
   * symbols the tool keeps are whichever three hundred finished first - measured on this repository,
   * a different forty-four files on each of three consecutive runs, while `IDEMPOTENT_WITHIN_TURN`
   * called the answer a pure function of the workspace. Removing `--sort path` turned no test red
   * until this one, which is why it is here rather than in a comment.
   */
  it('asks ripgrep for the symbols in a settled order, because the budget keeps a prefix of them', async () => {
    const executed = await dispatch(
      { name: 'repo_overview', arguments: { path: 'workspace/app' } },
      {
        route: (url, init) => {
          if (!url.endsWith(`${root}/exec`)) return undefined;
          const body = requestBody(init) as { executable: string; args: string[] };
          if (body.executable === 'git') return observation({ stdout: 'a.ts\n' });
          return observation({ stdout: 'a.ts:1:export const one = 1\n' });
        }
      }
    );
    const symbols = executed.calls
      .map((entry) => entry.body as { executable: string; args: string[] })
      .find((body) => body.executable === 'rg' && !body.args.includes('--files'));
    expect(symbols?.args.join(' ')).toContain('--sort path');
  });

  it('reads a repository with five commands at once and answers from all of them', async () => {
    const executed = await dispatch(
      { name: 'repo_overview', arguments: { path: 'workspace/app' } },
      {
        route: (url, init) => {
          if (!url.endsWith(`${root}/exec`)) return undefined;
          const body = requestBody(init) as { executable: string; args: string[] };
          if (body.executable === 'git' && body.args[0] === 'status')
            return observation({ stdout: '## main\n M a.ts\n' });
          if (body.executable === 'git') return observation({ stdout: 'a.ts\nb.ts\n' });
          if (body.args.includes('--files')) return observation({ stdout: 'README.md\n' });
          return observation({ stdout: 'a.ts:1:export const one = 1\n' });
        }
      }
    );

    // Five: the working-tree state, the tracked files, the symbol sweep, the import sweep the
    // symbols are ranked by, and the instruction files. They go out together, so what the fifth
    // adds to a call bounded at 90 seconds is the difference between the slowest two of them -
    // measured on this repository, 36 ms for the import sweep against 57 ms for the symbols.
    expect(executed.calls).toHaveLength(5);
    expect(
      executed.calls.map((entry) => (entry.body as { executable: string }).executable)
    ).toEqual(['git', 'git', 'rg', 'rg', 'rg']);
    expect(executed.calls.every((entry) => entry.path === `${root}/exec`)).toBe(true);
    expect(executed.calls.every((entry) => entry.scopes.join() === 'exec')).toBe(true);
    expect(executed.calls[0]?.body).toEqual({
      executable: 'git',
      args: ['status', '--short', '--branch'],
      cwd: 'workspace/app',
      timeoutSeconds: 90
    });
    expect(executed.calls[1]?.body).toMatchObject({ args: ['ls-files'] });
    expect(executed.result).toMatchObject({
      path: 'workspace/app',
      versionControl: '## main\n M a.ts',
      files: ['a.ts', 'b.ts'],
      fileCount: 2,
      filesTruncated: false,
      importantSymbols: ['a.ts:1:export const one = 1'],
      instructionFiles: ['README.md']
    });
  });

  it('chooses the diagnostic command from what the directory listing holds', async () => {
    const executed = await dispatch(
      { name: 'code_diagnostics', arguments: { path: 'workspace/app' } },
      {
        route: (url) => {
          if (url.includes('/files?path='))
            return json({ entries: [{ name: 'package.json' }, { name: 'tsconfig.json' }] });
          if (url.endsWith(`${root}/exec`)) return observation({ stdout: 'no errors' });
          return undefined;
        }
      }
    );

    /*
     * ONE listing, and it was two.
     *
     * `language` defaults to `auto`, so which command runs is decided by what the directory holds,
     * and this arm has always had to read it. The approval floor read it too, from the same
     * endpoint with the same path, so that the removed `code_diagnostics` card could tell
     * `tsc --noEmit` from `make -s` before asking about it. That card is gone - the same nine
     * recipes run through `shell` without asking, so it was a toll on the phrasing - and the round
     * trip went with it. The bound that replaced it needs no lookup at all: the turn takes its undo
     * point for every diagnostic, whatever the listing would have said.
     *
     * Asserted as the exact call list rather than as a `find`, because a saving of one runner call
     * per diagnostic is invisible in every other shape this test could take.
     */
    expect(executed.calls).toEqual([
      {
        method: 'GET',
        path: `${root}/files?path=workspace%2Fapp`,
        scopes: ['files.read'],
        body: undefined
      },
      {
        method: 'POST',
        path: `${root}/exec`,
        scopes: ['exec'],
        body: {
          executable: 'npx',
          args: ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'],
          cwd: 'workspace/app',
          timeoutSeconds: 300,
          maxOutputBytes: 4_000_000
        }
      }
    ]);
    expect(executed.result).toMatchObject({
      available: true,
      language: 'typescript',
      passed: true
    });
  });

  /**
   * The other direction, at the arm that executes rather than at the table that answers.
   *
   * The listing above holds a `tsconfig.json`, and it did not have to: this test read
   * `[{ name: 'package.json' }]` and passed, while the arm sent `tsc --noEmit` to a directory with
   * no project for it to read. Driven on this machine, `pnpm exec tsc --noEmit --pretty false` at
   * this repository's own root - a `package.json`, no `tsconfig.json`, and the default `path` of
   * `workspace` names exactly that shape - exits 1 with 4,994 bytes of the compiler's usage on
   * stdout and nothing on stderr. The arm returned `passed: false` carrying those 4,994 bytes,
   * which is indistinguishable from a wall of type errors and contains no fact about the code.
   *
   * Asserted as the exact call list, because the whole repair is that the second call is not made.
   * A sentence and no exec, and no approval: an unrunnable command is not a decision for an owner.
   */
  it('says which project file is missing, and runs nothing, rather than returning a usage page', async () => {
    const executed = await dispatch(
      { name: 'code_diagnostics', arguments: { path: 'workspace/app' } },
      {
        route: (url) => {
          if (url.includes('/files?path=')) return json({ entries: [{ name: 'package.json' }] });
          if (url.endsWith(`${root}/exec`)) return observation({ stdout: 'no errors' });
          return undefined;
        }
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'GET',
        path: `${root}/files?path=workspace%2Fapp`,
        scopes: ['files.read'],
        body: undefined
      }
    ]);
    expect(executed.result).toMatchObject({ available: false, language: 'typescript' });
    expect((executed.result as { reason: string }).reason).toContain('no tsconfig.json');
  });

  /**
   * A timeout the model spelled wrong must not delete the floor it was clamped by.
   *
   * `Math.min(1_800, Math.max(10, Number('a while')))` is `NaN`, and `JSON.stringify` writes `NaN`
   * as `null`. So the request that reached the runner carried `timeoutSeconds: null` - not the
   * ten-second floor, not the three-hundred-second default, but the absence of the field, decided
   * by whatever the runner does with a missing one. A clamp whose failure mode is "no bound at
   * all" is the same shape as the credit ceiling two files away, arriving through JSON rather than
   * through arithmetic.
   */
  it('falls back to the default timeout rather than sending the runner a null one', async () => {
    const executed = await dispatch(
      { name: 'code_diagnostics', arguments: { path: 'workspace/app', timeoutSeconds: 'a while' } },
      {
        route: (url) => {
          if (url.includes('/files?path='))
            return json({ entries: [{ name: 'package.json' }, { name: 'tsconfig.json' }] });
          if (url.endsWith(`${root}/exec`)) return observation({ stdout: 'no errors' });
          return undefined;
        }
      }
    );

    // Found by route rather than by index. It was written that way when the approval floor took a
    // listing of its own ahead of this call; the floor no longer does, and finding the exec by its
    // path is still the right shape - what is being asserted is the clamp, not the call order.
    const exec = executed.calls.find((entry) => entry.path === `${root}/exec`);
    expect(exec?.body).toMatchObject({ timeoutSeconds: 300 });
  });

  it('says so, and runs nothing, when no project marker is there to recognise', async () => {
    const executed = await dispatch(
      { name: 'code_diagnostics', arguments: {} },
      {
        route: (url) =>
          url.includes('/files?path=') ? json({ entries: [{ name: 'notes.md' }] }) : undefined
      }
    );

    // One listing and no exec at all: a directory holding no project marker resolves to no command,
    // so nothing is run and nothing is asked. It was two listings while the approval floor took one
    // of its own to decide a card that no longer exists.
    expect(executed.calls.map((entry) => entry.path)).toEqual([`${root}/files?path=workspace`]);
    expect(executed.result).toMatchObject({ available: false });
  });

  it('asks a coding CLI for its version and its login state before anything else', async () => {
    const executed = await dispatch(
      { name: 'coding_agent', arguments: { action: 'status', agent: 'codex' } },
      {
        route: (url, init) => {
          if (!url.endsWith(`${root}/exec`)) return undefined;
          const body = requestBody(init) as { args: string[] };
          return body.args[0] === '--version'
            ? observation({ stdout: 'codex 1.2.3' })
            : observation({ stdout: 'Logged in as owner' });
        }
      }
    );

    expect(executed.calls).toHaveLength(2);
    expect(executed.calls[0]).toMatchObject({
      path: `${root}/exec`,
      scopes: ['exec'],
      body: { executable: 'codex', args: ['--version'], cwd: 'workspace', timeoutSeconds: 30 }
    });
    expect(executed.result).toMatchObject({ agent: 'codex', installed: true, authenticated: true });
  });

  it('refuses an agent that is not one of the three', async () => {
    const executed = await dispatch({
      name: 'coding_agent',
      arguments: { action: 'status', agent: 'someone-else' }
    });

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe('coding_agent_invalid');
  });

  it('refuses a coding-agent action it has no branch for', async () => {
    const executed = await dispatch({
      name: 'coding_agent',
      arguments: { action: 'restart', agent: 'codex' }
    });

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe('coding_agent_action_invalid');
  });

  it('hands an approved mission to the CLI as a networked process, with its sandbox policy', async () => {
    const executed = await dispatch(
      {
        name: 'coding_agent',
        arguments: {
          action: 'run',
          agent: 'opencode',
          prompt: 'Fix the failing test',
          cwd: 'workspace'
        }
      },
      {
        approved: true,
        // Zero-retention refuses the hand-over outright, which is a different branch entirely.
        task: { privacyRoute: 'external' },
        route: (url) =>
          url.endsWith(`${root}/processes/start`)
            ? json({
                sessionId: 'proc_1',
                status: 'exited',
                exitCode: 0,
                stdout: '{"type":"text","part":{"text":"done","sessionID":"ses_1"}}',
                stderr: ''
              })
            : undefined
      }
    );

    expect(executed.calls).toHaveLength(1);
    const started = executed.calls[0];
    expect(started).toMatchObject({
      method: 'POST',
      path: `${root}/processes/start`,
      scopes: ['exec']
    });
    expect(started?.body).toMatchObject({
      executable: 'opencode',
      cwd: 'workspace',
      network: true,
      timeoutSeconds: 900,
      maxOutputBytes: 4_000_000
    });
    expect(executed.result).toMatchObject({ agent: 'opencode', completed: true, summary: 'done' });
  });

  it('refuses to hand a zero-retention task to a subscription CLI', async () => {
    const executed = await dispatch(
      {
        name: 'coding_agent',
        arguments: { action: 'run', agent: 'claude', prompt: 'Fix it' }
      },
      { approved: true }
    );

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe('coding_agent_privacy_conflict');
  });

  it('installs a CLI into the workspace tool prefix when the owner approves the setup', async () => {
    const executed = await dispatch(
      { name: 'coding_agent', arguments: { action: 'setup', agent: 'codex' } },
      {
        approved: true,
        route: (url, init) => {
          if (!url.endsWith(`${root}/exec`)) return undefined;
          const body = requestBody(init) as { executable: string };
          return body.executable === 'npm'
            ? observation({ stdout: 'added 1 package' })
            : observation({ stdout: 'codex 1.2.3' });
        }
      }
    );

    expect(executed.calls[0]?.body).toMatchObject({
      executable: 'npm',
      cwd: 'workspace',
      network: true,
      timeoutSeconds: 900
    });
    expect((executed.calls[0]?.body as { args: string[] }).args.slice(0, 3)).toEqual([
      'install',
      '--prefix',
      '.athanor/tools'
    ]);
    expect(executed.result).toMatchObject({ agent: 'codex', installed: true });
  });
});

describe('the knowledge arms', () => {
  it('asks the session index for the query it was given, bounded and scoped to the workspace', async () => {
    const executed = await dispatch({
      name: 'session_search',
      arguments: { query: 'the regulator letter', maxResults: 4, taskId: 'task-9' }
    });

    expect(executed.calls).toEqual([]);
    expect(executed.asked('searchMemorySources')?.[0]).toMatchObject({
      workspaceId,
      limit: 4,
      taskId: 'task-9'
    });
  });

  it('recalls memory with the filters the call named and nothing it did not', async () => {
    const executed = await dispatch({
      name: 'memory_recall',
      arguments: {
        query: 'deployment',
        kinds: ['fact'],
        scope: 'archive',
        asOf: '2026-06-01T00:00:00.000Z',
        includeSuperseded: true,
        maxItems: 3
      }
    });

    expect(executed.calls).toEqual([]);
    expect(executed.asked('recallMemoryCandidates')?.[0]).toMatchObject({
      workspaceId,
      kinds: ['fact'],
      scope: 'archive',
      asOf: '2026-06-01T00:00:00.000Z',
      includeSuperseded: true,
      maxItems: 3,
      order: 'relevance'
    });
  });

  it('lists long-term memory without asking anyone for permission', async () => {
    const executed = await dispatch({ name: 'memory', arguments: { action: 'list' } });

    expect(executed.calls).toEqual([]);
    expect(executed.asked('listWorkspaceMemories')).toEqual([userId, workspaceId]);
    expect(executed.result).toEqual({ entries: [] });
  });

  it("seals an approved memory under the workspace context, stamped as the agent's", async () => {
    const executed = await dispatch(
      {
        name: 'memory',
        arguments: { action: 'add', target: 'workspace', content: 'The build runs on Node 24.' }
      },
      {
        approved: true,
        store: {
          createWorkspaceMemory: async (input: Record<string, unknown>) => ({
            id: 'memory-1',
            target: 'workspace',
            contentCiphertext: input.contentCiphertext,
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z'
          })
        }
      }
    );

    expect(executed.calls).toEqual([]);
    expect(executed.result).toMatchObject({
      id: 'memory-1',
      target: 'workspace',
      content: 'The build runs on Node 24.',
      source: 'agent',
      sourceTaskId: taskId
    });
  });

  it('replaces a memory entry in place, carrying the version it replaced', async () => {
    const stored = {
      id: 'memory-1',
      target: 'workspace',
      contentCiphertext: encryptJson(
        { content: 'The build runs on Node 20.', source: 'agent' },
        dataKey,
        `workspace-memory:${workspaceId}`
      ),
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z'
    };
    const executed = await dispatch(
      {
        name: 'memory',
        arguments: { action: 'replace', id: 'memory-1', content: 'The build runs on Node 24.' }
      },
      {
        approved: true,
        store: {
          listWorkspaceMemories: async () => [stored],
          updateWorkspaceMemory: async (input: Record<string, unknown>) => ({
            ...stored,
            contentCiphertext: input.contentCiphertext,
            updatedAt: '2026-07-01T00:00:00.000Z'
          })
        }
      }
    );

    const asked = executed.asked('updateWorkspaceMemory')?.[0] as Record<string, unknown>;
    expect(asked).toMatchObject({ id: 'memory-1', userId, workspaceId });
    expect(
      decryptJson<{ content: string; previousUpdatedAt: string }>(
        asked.contentCiphertext as Parameters<typeof decryptJson>[0],
        dataKey,
        `workspace-memory:${workspaceId}`
      )
    ).toMatchObject({
      content: 'The build runs on Node 24.',
      previousUpdatedAt: '2026-06-02T00:00:00.000Z'
    });
  });

  /*
   * The gate on the tier that leaves this workspace, at the call site that would cross it.
   *
   * This is the production path: `tools/knowledge.ts` calls the store directly rather than going
   * through the API, so a rule enforced only in a route would not be enforced here at all. Two
   * refusals, because there are two ways in. The first reads the argument; the second reads the
   * row, and it is the one that matters more - `replace` and `remove` reach a row by id, and the
   * list they search now includes the owner tier, so a call that simply omitted `target` could
   * have rewritten or deleted a fact the owner typed about themselves.
   */
  it('refuses to write the owner tier, whether it is named or reached by id', async () => {
    const named = await dispatch(
      {
        name: 'memory',
        arguments: { action: 'add', target: 'user', content: 'They prefer to be left to work.' }
      },
      { approved: true }
    );
    expect(named.failure?.code).toBe('memory_scope_refused');
    expect(named.failure?.message).toMatch(/only the owner can write it/i);
    expect(named.asked('createWorkspaceMemory')).toBeUndefined();

    const ownerRow = {
      id: 'memory-owner',
      target: 'user',
      keyScope: 'user',
      contentCiphertext: encryptJson(
        { content: 'Take the lead.', source: 'owner' },
        userMemoryKey(masterKey, userId),
        userMemoryAad(userId)
      ),
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z'
    };
    for (const call of [
      { action: 'replace', id: 'memory-owner', content: 'Do not take the lead.' },
      { action: 'remove', id: 'memory-owner' }
    ]) {
      const reached = await dispatch(
        { name: 'memory', arguments: call },
        { approved: true, store: { listWorkspaceMemories: async () => [ownerRow] } }
      );
      expect(reached.failure?.code).toBe('memory_scope_refused');
      expect(reached.failure?.message).toMatch(/only the owner can change or remove it/i);
      expect(reached.asked('updateWorkspaceMemory')).toBeUndefined();
      expect(reached.asked('deleteWorkspaceMemory')).toBeUndefined();
    }
  });

  it('refuses to change a memory entry that is not there', async () => {
    const executed = await dispatch(
      { name: 'memory', arguments: { action: 'remove', id: 'memory-9' } },
      { approved: true }
    );

    expect(executed.failure?.code).toBe('memory_not_found');
  });

  it("lists skills as the workspace's own plus the built-in library behind them", async () => {
    const executed = await dispatch({ name: 'skill', arguments: { action: 'list' } });

    expect(executed.calls).toEqual([]);
    expect(executed.asked('curateWorkspaceSkills')).toEqual([workspaceId]);
    const result = executed.result as { skills: unknown[]; builtinSkills: Array<{ name: string }> };
    expect(result.skills).toEqual([]);
    expect(result.builtinSkills.map((entry) => entry.name)).toContain('pdf-extraction');
  });

  it('probes the binaries a built-in skill declares before handing over the procedure', async () => {
    const executed = await dispatch(
      { name: 'skill', arguments: { action: 'view', id: 'pdf-extraction' } },
      {
        route: (url) =>
          url.endsWith(`${root}/toolchain/probe`)
            ? json({ present: ['pdftotext'], missing: ['ocrmypdf'] })
            : undefined
      }
    );

    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0]).toMatchObject({
      method: 'POST',
      path: `${root}/toolchain/probe`,
      scopes: ['exec']
    });
    expect((executed.calls[0]?.body as { binaries: string[] }).binaries).toContain('ocrmypdf');
    expect(executed.result).toMatchObject({
      id: 'pdf-extraction',
      origin: 'builtin',
      missingBinaries: ['ocrmypdf']
    });
  });

  it('removes a workspace skill by name as readily as by id, and says which one went', async () => {
    const saved = {
      id: 'skill-1',
      version: 1,
      enabled: true,
      status: 'active',
      pinned: false,
      useCount: 0,
      lastUsedAt: null,
      nameHash: 'unused',
      documentCiphertext: encryptJson(
        { name: 'weekly-report', description: 'The weekly report', content: SKILL_BODY },
        dataKey,
        `workspace-skill:${workspaceId}`
      ),
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z'
    };
    const executed = await dispatch(
      { name: 'skill', arguments: { action: 'remove', id: 'weekly-report' } },
      { approved: true, store: { listWorkspaceSkills: async () => [saved] } }
    );

    expect(executed.asked('deleteWorkspaceSkill')).toEqual([userId, workspaceId, 'skill-1']);
    expect(executed.result).toEqual({ removed: true, name: 'weekly-report' });
  });

  it('refuses a skill action it has no branch for', async () => {
    const executed = await dispatch({ name: 'skill', arguments: { action: 'publish' } });

    expect(executed.failure?.code).toBe('skill_action_invalid');
  });

  it('refuses to save a procedure with none of the headings that make it followable', async () => {
    const executed = await dispatch(
      {
        name: 'skill',
        arguments: {
          action: 'upsert',
          name: 'weekly-report',
          description: 'How the weekly report is assembled',
          content: '# Weekly report\n\nDo the thing.'
        }
      },
      { approved: true }
    );

    expect(executed.failure?.code).toBe('skill_structure_invalid');
  });

  it('refuses to open a skill that is in neither the workspace nor the library', async () => {
    const executed = await dispatch({
      name: 'skill',
      arguments: { action: 'view', id: 'no-such-skill' }
    });

    expect(executed.failure?.code).toBe('skill_not_found');
  });

  it('keys an approved skill save by an HMAC of its name under the workspace key', async () => {
    const executed = await dispatch(
      {
        name: 'skill',
        arguments: {
          action: 'upsert',
          name: 'weekly-report',
          description: 'How the weekly report is assembled',
          content: SKILL_BODY
        }
      },
      {
        approved: true,
        store: {
          upsertWorkspaceSkill: async (input: Record<string, unknown>) => ({
            id: 'skill-1',
            version: 2,
            enabled: true,
            status: 'active',
            pinned: false,
            useCount: 0,
            lastUsedAt: null,
            documentCiphertext: input.documentCiphertext,
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z'
          })
        }
      }
    );

    expect(executed.calls).toEqual([]);
    const saved = executed.asked('upsertWorkspaceSkill')?.[0] as {
      nameHash: string;
      workspaceId: string;
    };
    expect(saved.workspaceId).toBe(workspaceId);
    expect(saved.nameHash).toMatch(/^[0-9a-f]{64}$/);
    expect(executed.result).toMatchObject({ id: 'skill-1', name: 'weekly-report', version: 2 });
  });
});

describe('the scheduling arm', () => {
  it("lists only this workspace's schedules, opened with the workspace key", async () => {
    const executed = await dispatch(
      { name: 'schedule', arguments: { action: 'list' } },
      {
        store: {
          listTaskSchedules: async () => [
            {
              id: 'schedule-1',
              workspaceId,
              titleCiphertext: encryptJson(
                { title: 'Monday review' },
                dataKey,
                `task-title:${workspaceId}`
              ),
              promptCiphertext: encryptJson(
                { prompt: 'Summarise the week' },
                dataKey,
                `task-prompt:${workspaceId}`
              ),
              modelId: model.id,
              maxComputeCredits: 5,
              spec: { kind: 'weekly' },
              enabled: true,
              nextRunAt: '2026-07-06T09:00:00.000Z',
              lastRunAt: null,
              lastTaskId: null,
              lastErrorCode: null
            },
            {
              id: 'schedule-2',
              workspaceId: 'another-workspace',
              titleCiphertext: encryptJson({ title: 'Elsewhere' }, dataKey, 'task-title:other'),
              promptCiphertext: encryptJson({ prompt: 'Elsewhere' }, dataKey, 'task-prompt:other'),
              modelId: model.id,
              maxComputeCredits: 5,
              spec: { kind: 'weekly' },
              enabled: true,
              nextRunAt: null,
              lastRunAt: null,
              lastTaskId: null,
              lastErrorCode: null
            }
          ]
        }
      }
    );

    expect(executed.calls).toEqual([]);
    const result = executed.result as { schedules: Array<{ id: string; title: string }> };
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]).toMatchObject({ id: 'schedule-1', title: 'Monday review' });
  });

  it('refuses to touch a schedule id this workspace does not own', async () => {
    const executed = await dispatch(
      { name: 'schedule', arguments: { action: 'pause', id: 'schedule-9' } },
      { approved: true }
    );

    expect(executed.failure?.code).toBe('schedule_not_found');
  });

  it('refuses a one-time schedule whose moment has already passed', async () => {
    const executed = await dispatch(
      {
        name: 'schedule',
        arguments: {
          action: 'create',
          prompt: 'Summarise the week',
          spec: { kind: 'once', runAt: '2020-01-01T00:00:00.000Z' }
        }
      },
      { approved: true }
    );

    expect(executed.failure?.code).toBe('schedule_in_past');
  });

  it('pauses and removes an existing schedule by id, once the owner has approved it', async () => {
    const existing = {
      id: 'schedule-1',
      workspaceId,
      titleCiphertext: encryptJson(
        { title: 'Monday review' },
        dataKey,
        `task-title:${workspaceId}`
      ),
      promptCiphertext: encryptJson({ prompt: 'Summarise' }, dataKey, `task-prompt:${workspaceId}`),
      modelId: model.id,
      maxComputeCredits: 5,
      spec: { kind: 'weekly', timeZone: 'Europe/London', localTime: '09:00', weekdays: [1] },
      enabled: true,
      nextRunAt: '2026-07-06T09:00:00.000Z',
      lastRunAt: null,
      lastTaskId: null,
      lastErrorCode: null
    };
    const holding = {
      listTaskSchedules: async () => [existing],
      setTaskScheduleEnabled: async () => ({ ...existing, enabled: false, nextRunAt: null })
    };

    const paused = await dispatch(
      { name: 'schedule', arguments: { action: 'pause', id: 'schedule-1' } },
      { approved: true, store: holding }
    );
    expect(paused.asked('setTaskScheduleEnabled')).toEqual([userId, 'schedule-1', false, null]);
    expect(paused.result).toMatchObject({ id: 'schedule-1', enabled: false });

    const removed = await dispatch(
      { name: 'schedule', arguments: { action: 'remove', id: 'schedule-1' } },
      { approved: true, store: holding }
    );
    expect(removed.asked('deleteTaskSchedule')).toEqual([userId, 'schedule-1']);
    expect(removed.result).toEqual({ removed: true, id: 'schedule-1' });
  });

  it('refuses a schedule action it has no branch for', async () => {
    const executed = await dispatch(
      { name: 'schedule', arguments: { action: 'reschedule', id: 'schedule-1' } },
      {
        approved: true,
        store: {
          listTaskSchedules: async () => [
            {
              id: 'schedule-1',
              workspaceId,
              titleCiphertext: encryptJson(
                { title: 'Monday review' },
                dataKey,
                `task-title:${workspaceId}`
              ),
              promptCiphertext: encryptJson(
                { prompt: 'Summarise' },
                dataKey,
                `task-prompt:${workspaceId}`
              ),
              modelId: model.id,
              maxComputeCredits: 5,
              spec: { kind: 'interval', everyMinutes: 60 },
              enabled: true,
              nextRunAt: null,
              lastRunAt: null,
              lastTaskId: null,
              lastErrorCode: null
            }
          ]
        }
      }
    );

    expect(executed.failure?.code).toBe('schedule_action_invalid');
  });

  it('seals an approved new schedule under the workspace context and prices its ceiling', async () => {
    const executed = await dispatch(
      {
        name: 'schedule',
        arguments: {
          action: 'create',
          title: 'Monday review',
          prompt: 'Summarise the week',
          spec: {
            kind: 'weekly',
            timeZone: 'Europe/London',
            localTime: '09:00',
            weekdays: [1]
          },
          maxComputeCredits: 3
        }
      },
      {
        approved: true,
        store: {
          createTaskSchedule: async (input: Record<string, unknown>) => ({
            ...input,
            id: 'schedule-1',
            enabled: true,
            lastRunAt: null,
            lastTaskId: null,
            lastErrorCode: null
          })
        }
      }
    );

    expect(executed.calls).toEqual([]);
    const created = executed.asked('createTaskSchedule')?.[0] as Record<string, unknown>;
    expect(created).toMatchObject({
      userId,
      workspaceId,
      modelId: model.id,
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 3
    });
    expect(
      decryptJson<{ prompt: string }>(
        created.promptCiphertext as Parameters<typeof decryptJson>[0],
        dataKey,
        `task-prompt:${workspaceId}`
      ).prompt
    ).toBe('Summarise the week');
  });

  /**
   * The money ceiling on a watcher survives the agent rewording it.
   *
   * `updateTaskSchedule` writes `max_spend_usd` on every call from `input.maxSpendUsd ?? null`, so
   * a caller that leaves the field out does not leave the column alone - it clears it. This arm is
   * the agent editing a schedule, which happens on unattended runs, so the owner's ceiling on their
   * own watcher was being removed by an edit to its title with nobody awake to see it.
   *
   * The API half of exactly this bug is fixed and pinned at `PATCH /v1/schedules/:scheduleId`; this
   * is the worker half, and it is the same one line. The tool takes no `maxSpendUsd` argument at
   * all, so there is nothing here to prefer over the stored value: the agent may retime and reword
   * a schedule, and may not touch what it is allowed to spend.
   */
  it('leaves the owner’s spending ceiling alone on a schedule it only reworded', async () => {
    const existing = {
      id: 'schedule-1',
      workspaceId,
      titleCiphertext: encryptJson(
        { title: 'Monday review' },
        dataKey,
        `task-title:${workspaceId}`
      ),
      promptCiphertext: encryptJson(
        { prompt: 'Summarise the week' },
        dataKey,
        `task-prompt:${workspaceId}`
      ),
      modelId: model.id,
      maxComputeCredits: 5,
      maxSpendUsd: 4,
      spec: { kind: 'weekly', timeZone: 'Europe/London', localTime: '09:00', weekdays: [1] },
      enabled: true,
      nextRunAt: '2026-07-06T09:00:00.000Z',
      lastRunAt: null,
      lastTaskId: null,
      lastErrorCode: null
    };

    const executed = await dispatch(
      {
        name: 'schedule',
        arguments: { action: 'update', id: 'schedule-1', title: 'Tuesday review' }
      },
      {
        approved: true,
        store: {
          listTaskSchedules: async () => [existing],
          updateTaskSchedule: async (
            _userId: string,
            _id: string,
            input: Record<string, unknown>
          ) => ({ ...existing, ...input })
        }
      }
    );

    const patch = executed.asked('updateTaskSchedule')?.[2] as Record<string, unknown>;
    // The assertion is on the write, not on the record that comes back: the record is this test's
    // own stub, and a stub that spreads the patch over the stored row would answer 4 either way.
    expect(patch.maxSpendUsd).toBe(4);
    // And the edit the agent was actually asked for still happened, so this is a carry-forward and
    // not an update that quietly did nothing.
    expect(
      decryptJson<{ title: string }>(
        patch.titleCiphertext as Parameters<typeof decryptJson>[0],
        dataKey,
        `task-title:${workspaceId}`
      ).title
    ).toBe('Tuesday review');
  });

  /**
   * The ceiling on an unattended run has to be a number the ceiling test can be false against.
   *
   * `Math.max(0.01, Number('abc'))` is `NaN`, and `Math.min(100, NaN)` is `NaN` again: the clamp
   * that reads as a floor and a cap is transparent to the one value that has neither. The schedule
   * store validates nothing, the dispatcher copies `max_compute_credits` onto every task the
   * schedule creates, and the loop's ceiling is `state.credits >= task.maxComputeCredits` - which
   * is false for every value of credits when the right-hand side is `NaN`. So a schedule created
   * with a ceiling the model spelled wrong runs, at 3am, until the step budget stops it.
   *
   * Each of the three spellings of "the model did not give me a number" is asserted, because they
   * arrive by different routes: a word, a JSON null from a model filling in a field it was told
   * was optional, and the field left out altogether.
   */
  it.each([
    ['a word', 'abc'],
    ['a JSON null', null],
    ['nothing at all', undefined]
  ])('gives a schedule created with %s a ceiling that can still fire', async (_name, credits) => {
    const executed = await dispatch(
      {
        name: 'schedule',
        arguments: {
          action: 'create',
          title: 'Monday review',
          prompt: 'Summarise the week',
          spec: { kind: 'weekly', timeZone: 'Europe/London', localTime: '09:00', weekdays: [1] },
          ...(credits === undefined ? {} : { maxComputeCredits: credits })
        }
      },
      {
        approved: true,
        store: {
          createTaskSchedule: async (input: Record<string, unknown>) => ({
            ...input,
            id: 'schedule-1',
            enabled: true,
            lastRunAt: null,
            lastTaskId: null,
            lastErrorCode: null
          })
        }
      }
    );

    const created = executed.asked('createTaskSchedule')?.[0] as Record<string, unknown>;
    // The tool's own default, not the floor: an unreadable number is an absent number, and an
    // absent number is what the `?? 5` beside it was always meant to answer.
    expect(created.maxComputeCredits).toBe(5);
    // Stated separately from the value, because this is the property that actually matters and it
    // is the one `toBe(5)` would still report as passing if the fallback ever changed.
    expect(Number.isFinite(created.maxComputeCredits)).toBe(true);
  });

  /** The same hole on the other branch: an edit may not turn a live ceiling into `NaN` either. */
  it('will not reword a schedule’s ceiling into one that never fires', async () => {
    const existing = {
      id: 'schedule-1',
      workspaceId,
      titleCiphertext: encryptJson(
        { title: 'Monday review' },
        dataKey,
        `task-title:${workspaceId}`
      ),
      promptCiphertext: encryptJson(
        { prompt: 'Summarise the week' },
        dataKey,
        `task-prompt:${workspaceId}`
      ),
      modelId: model.id,
      maxComputeCredits: 7,
      maxSpendUsd: 4,
      spec: { kind: 'weekly', timeZone: 'Europe/London', localTime: '09:00', weekdays: [1] },
      enabled: true,
      nextRunAt: '2026-07-06T09:00:00.000Z',
      lastRunAt: null,
      lastTaskId: null,
      lastErrorCode: null
    };

    const executed = await dispatch(
      {
        name: 'schedule',
        arguments: { action: 'update', id: 'schedule-1', maxComputeCredits: 'lots' }
      },
      {
        approved: true,
        store: {
          listTaskSchedules: async () => [existing],
          updateTaskSchedule: async (
            _userId: string,
            _id: string,
            input: Record<string, unknown>
          ) => ({ ...existing, ...input })
        }
      }
    );

    const patch = executed.asked('updateTaskSchedule')?.[2] as Record<string, unknown>;
    expect(patch.maxComputeCredits).toBe(7);
    expect(Number.isFinite(patch.maxComputeCredits)).toBe(true);
  });

  /**
   * The money ceiling reaches a schedule the agent creates, not only one it rewords.
   *
   * `updateTaskSchedule` already carries `maxSpendUsd` forward - that fix has a test above it. The
   * create branch passed no `maxSpendUsd` at all, so `createTaskSchedule` wrote `NULL`; the
   * dispatcher copies that null onto the task, and `spendGuardIn` does not read a null ceiling as
   * a low one, it drops the task window from the guard entirely. Composed with the `NaN` above,
   * the two together were a run nobody is watching with **neither** money bound in force.
   *
   * The tool has no `maxSpendUsd` argument, so the value carried is the one the run the agent is
   * already inside is held to: the agent may commit the owner to later work, and may not commit
   * them to more per run than they are being held to now.
   */
  it('holds a schedule it creates to the same money ceiling as the run that created it', async () => {
    const executed = await dispatch(
      {
        name: 'schedule',
        arguments: {
          action: 'create',
          title: 'Monday review',
          prompt: 'Summarise the week',
          spec: { kind: 'weekly', timeZone: 'Europe/London', localTime: '09:00', weekdays: [1] },
          maxComputeCredits: 3
        }
      },
      {
        approved: true,
        task: { maxSpendUsd: 4 },
        store: {
          createTaskSchedule: async (input: Record<string, unknown>) => ({
            ...input,
            id: 'schedule-1',
            enabled: true,
            lastRunAt: null,
            lastTaskId: null,
            lastErrorCode: null
          })
        }
      }
    );

    const created = executed.asked('createTaskSchedule')?.[0] as Record<string, unknown>;
    expect(created.maxSpendUsd).toBe(4);
  });

  /** And a run with no ceiling of its own does not invent one for the schedule. */
  it('leaves a created schedule uncapped when the run that created it is uncapped', async () => {
    const executed = await dispatch(
      {
        name: 'schedule',
        arguments: {
          action: 'create',
          title: 'Monday review',
          prompt: 'Summarise the week',
          spec: { kind: 'weekly', timeZone: 'Europe/London', localTime: '09:00', weekdays: [1] }
        }
      },
      {
        approved: true,
        store: {
          createTaskSchedule: async (input: Record<string, unknown>) => ({
            ...input,
            id: 'schedule-1',
            enabled: true,
            lastRunAt: null,
            lastTaskId: null,
            lastErrorCode: null
          })
        }
      }
    );

    const created = executed.asked('createTaskSchedule')?.[0] as Record<string, unknown>;
    expect(created.maxSpendUsd).toBeNull();
  });
});

describe('the web arms', () => {
  it('takes a browser snapshot as a read, with an empty body', async () => {
    const executed = await dispatch(
      { name: 'browser_snapshot', arguments: {} },
      {
        route: (url) =>
          url.endsWith(`${root}/browser/snapshot`)
            ? json({ url: 'https://example.com' })
            : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/browser/snapshot`,
        scopes: ['browser.read'],
        body: {}
      }
    ]);
  });

  it('reads elements with only the fields the call actually named', async () => {
    const executed = await dispatch(
      { name: 'read_elements', arguments: { selector: '#results a' } },
      {
        route: (url) =>
          url.endsWith(`${root}/browser/elements`) ? json({ elements: [] }) : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/browser/elements`,
        scopes: ['browser.read'],
        body: { selector: '#results a' }
      }
    ]);
  });

  it('prints a page to a workspace PDF under both capabilities it needs', async () => {
    const executed = await dispatch(
      { name: 'print_pdf', arguments: { path: 'workspace/page.pdf', tabId: 'tab-2' } },
      {
        route: (url) =>
          url.endsWith(`${root}/browser/print-pdf`)
            ? json({ path: 'workspace/page.pdf' })
            : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/browser/print-pdf`,
        scopes: ['browser.read', 'files.write'],
        body: {
          path: 'workspace/page.pdf',
          format: 'A4',
          landscape: false,
          printBackground: true,
          tabId: 'tab-2'
        }
      }
    ]);
  });

  it('searches in house on the in-house route, bounded to ten results', async () => {
    const executed = await dispatch(
      { name: 'web_search', arguments: { query: 'regulator guidance 2026', limit: 40 } },
      {
        route: (url) => (url.endsWith(`${root}/browser/search`) ? json({ results: [] }) : undefined)
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/browser/search`,
        scopes: ['browser.read'],
        body: { query: 'regulator guidance 2026', limit: 10 }
      }
    ]);
  });

  it("spends the provider's own search instead when the run is pinned to that route", async () => {
    const executed = await dispatch(
      { name: 'web_search', arguments: { query: 'regulator guidance 2026' } },
      {
        config: { AI_PROVIDER: 'openrouter' },
        task: { privacyRoute: 'external' },
        // The gateway refuses a model from one provider on another's credential, so the catalogue
        // entry has to belong to the route the run is pinned to.
        store: { listModels: async () => [{ ...model, provider: 'openrouter' }] },
        provider: [
          `data: ${JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                delta: { content: '[{"title":"Guidance","url":"https://example.com/g"}]' }
              }
            ]
          })}\n\ndata: [DONE]\n\n`
        ]
      }
    );

    // Nothing crossed to the runner: the query left this computer on the provider's own request.
    expect(executed.calls).toEqual([]);
    // The provider-side tool travels alone: a request carrying it and the function tool of the
    // same name would be asking the question twice, of two different answerers, in one breath.
    const searchRequest = executed.modelRequests.find((request) =>
      JSON.stringify(request.tools ?? []).includes('openrouter:web_search')
    );
    expect(searchRequest?.tools).toEqual([
      { engine: 'auto', max_results: 10, max_uses: 2, type: 'openrouter:web_search' }
    ]);
  });

  it("reads pages in parallel, cut to each page's share of one tool result", async () => {
    const executed = await dispatch(
      {
        name: 'parallel_web_read',
        arguments: {
          urls: Array.from({ length: 12 }, (_, index) => `https://example.com/${index}`),
          maxCharactersPerPage: 20_000
        }
      },
      {
        route: (url) =>
          url.endsWith(`${root}/browser/read-many`)
            ? json({ sources: [], requested: 12, read: 0 })
            : undefined
      }
    );

    expect(executed.calls).toHaveLength(1);
    const asked = executed.calls[0];
    expect(asked).toMatchObject({
      method: 'POST',
      path: `${root}/browser/read-many`,
      scopes: ['browser.read']
    });
    const body = asked?.body as { urls: string[]; maxCharactersPerPage: number };
    expect(body.urls).toHaveLength(12);
    expect(body.maxCharactersPerPage).toBeLessThan(20_000);
    expect(executed.result).toMatchObject({ charactersPerPage: body.maxCharactersPerPage });
  });

  it('leaves a single-page read at what it asked for, with no note about a cut', async () => {
    const executed = await dispatch(
      {
        name: 'parallel_web_read',
        arguments: { urls: ['https://example.com/one'], maxCharactersPerPage: 12_000 }
      },
      {
        route: (url) =>
          url.endsWith(`${root}/browser/read-many`)
            ? json({ sources: [], requested: 1, read: 0 })
            : undefined
      }
    );

    expect(executed.calls[0]?.body).toEqual({
      urls: ['https://example.com/one'],
      maxCharactersPerPage: 12_000
    });
    expect(executed.result).toEqual({ sources: [], requested: 1, read: 0 });
  });

  it('carries the write scope on a screenshot, which is the one action that lands a file', async () => {
    const executed = await dispatch(
      {
        name: 'browser_action',
        arguments: { action: 'screenshot', path: 'workspace/proofs/checkout.png' }
      },
      {
        route: (url) =>
          url.endsWith(`${root}/browser/action`)
            ? json({ path: 'workspace/proofs/checkout.png', url: 'https://example.com' })
            : undefined
      }
    );
    expect(executed.calls.at(-1)).toEqual({
      method: 'POST',
      path: `${root}/browser/action`,
      scopes: ['browser.control', 'files.write'],
      body: { type: 'screenshot', path: 'workspace/proofs/checkout.png' }
    });
    expect(executed.result).toMatchObject({ path: 'workspace/proofs/checkout.png' });

    // Inside a batch as well, because a step is judged as the action it is.
    const batched = await dispatch(
      {
        name: 'browser_action',
        arguments: {
          action: 'batch',
          actions: [
            { action: 'hover', selector: '#menu' },
            { action: 'screenshot', path: 'menu.png' }
          ]
        }
      },
      {
        route: (url) => (url.endsWith(`${root}/browser/action`) ? json({ steps: [] }) : undefined)
      }
    );
    expect(batched.calls.at(-1)).toMatchObject({
      path: `${root}/browser/action`,
      scopes: ['browser.control', 'files.write']
    });
  });

  it('drives the browser under control alone, with the purpose kept off the request', async () => {
    const executed = await dispatch(
      {
        name: 'browser_action',
        arguments: { action: 'hover', selector: '#menu', purpose: 'Open the menu' }
      },
      {
        route: (url) => (url.endsWith(`${root}/browser/action`) ? json({ ok: true }) : undefined)
      }
    );

    // The preflight route is deliberately unanswered, which is the shape of a broker that cannot
    // judge the action: the declared requirement stands, and for a hover there is none.
    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/browser/preflight`,
        scopes: ['browser.read'],
        body: { type: 'hover', selector: '#menu' }
      },
      {
        method: 'POST',
        path: `${root}/browser/action`,
        scopes: ['browser.control'],
        body: { type: 'hover', selector: '#menu' }
      }
    ]);
  });

  it('carries the consequential capability once the owner has approved the click', async () => {
    const executed = await dispatch(
      {
        name: 'browser_action',
        arguments: { action: 'click_at', x: 820, y: 410, purpose: 'Confirm the order' }
      },
      {
        approved: true,
        route: (url) => (url.endsWith(`${root}/browser/action`) ? json({ ok: true }) : undefined)
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/browser/action`,
        scopes: ['browser.control', 'browser.consequential'],
        body: { type: 'click_at', x: 820, y: 410 }
      }
    ]);
  });

  it.each(['browser', 'desktop'])(
    'mints the %s capability from the saved Autonomous mode without a card',
    async (surface) => {
      const executed = await dispatch(
        { name: `${surface}_action`, arguments: { action: 'click_at', x: 20, y: 30 } },
        {
          task: { securityMode: 'autonomous' },
          route: (url) =>
            url.endsWith(`/${surface}/preflight`)
              ? json({ consequential: true, sensitiveInput: false, preview: 'Submit application' })
              : url.endsWith(`/${surface}/action`)
                ? json({ ok: true })
                : undefined
        }
      );
      expect(executed.calls.at(-1)).toMatchObject({
        path: `${root}/${surface}/action`,
        scopes: [`${surface}.control`, `${surface}.consequential`],
        body: { type: 'click_at', x: 20, y: 30 }
      });
      expect(executed.storeCalls.some((call) => call.method === 'createApproval')).toBe(false);
    }
  );

  it('does not let model-supplied autonomy grant execution permission', async () => {
    const executed = await dispatch(
      {
        name: 'browser_action',
        arguments: {
          action: 'click_at',
          x: 20,
          y: 30,
          securityMode: 'autonomous',
          consequentialApproved: true
        }
      },
      {
        task: { securityMode: 'balanced' },
        route: (url) =>
          url.endsWith('/browser/preflight')
            ? json({ consequential: true, sensitiveInput: false, preview: 'Submit application' })
            : url.endsWith('/browser/action')
              ? json({ ok: true })
              : undefined
      }
    );
    expect(executed.calls.some((call) => call.path.endsWith('/browser/action'))).toBe(false);
  });

  it('rebuilds a batch step by step, discriminated the way the runner reads it', async () => {
    const executed = await dispatch(
      {
        name: 'browser_action',
        arguments: {
          action: 'batch',
          tabId: 'tab-1',
          purpose: 'Fill the form',
          actions: [
            { action: 'fill', selector: '#name', value: 'Ada' },
            { action: 'click', selector: '#next' }
          ]
        }
      },
      {
        approved: true,
        route: (url) => (url.endsWith(`${root}/browser/action`) ? json({ steps: [] }) : undefined)
      }
    );

    expect(executed.calls[0]?.body).toEqual({
      type: 'batch',
      tabId: 'tab-1',
      actions: [
        { type: 'fill', selector: '#name', value: 'Ada' },
        { type: 'click', selector: '#next' }
      ]
    });
  });

  it('observes the desktop as a read', async () => {
    const executed = await dispatch(
      { name: 'desktop_observe', arguments: {} },
      {
        route: (url) =>
          url.endsWith(`${root}/desktop/snapshot`) ? json({ windows: [] }) : undefined
      }
    );

    expect(executed.calls).toEqual([
      { method: 'POST', path: `${root}/desktop/snapshot`, scopes: ['desktop.read'], body: {} }
    ]);
  });

  it('launches a desktop application with the arguments exactly as written', async () => {
    const executed = await dispatch(
      { name: 'desktop_launch', arguments: { executable: 'libreoffice', args: ['--writer'] } },
      { route: (url) => (url.endsWith(`${root}/desktop/launch`) ? json({ ok: true }) : undefined) }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/desktop/launch`,
        scopes: ['desktop.control'],
        body: { executable: 'libreoffice', args: ['--writer'] }
      }
    ]);
  });

  it('drives the desktop under control alone for an ordinary action', async () => {
    const executed = await dispatch(
      { name: 'desktop_action', arguments: { action: 'scroll', dy: 400, purpose: 'Read on' } },
      { route: (url) => (url.endsWith(`${root}/desktop/action`) ? json({ ok: true }) : undefined) }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/desktop/preflight`,
        scopes: ['desktop.read'],
        body: { type: 'scroll', dy: 400 }
      },
      {
        method: 'POST',
        path: `${root}/desktop/action`,
        scopes: ['desktop.control'],
        body: { type: 'scroll', dy: 400 }
      }
    ]);
  });

  it('carries the consequential capability on an approved desktop click', async () => {
    const executed = await dispatch(
      {
        name: 'desktop_action',
        arguments: { action: 'click_at', x: 100, y: 200, purpose: 'Press Save' }
      },
      {
        approved: true,
        route: (url) => (url.endsWith(`${root}/desktop/action`) ? json({ ok: true }) : undefined)
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/desktop/action`,
        scopes: ['desktop.control', 'desktop.consequential'],
        body: { type: 'click_at', x: 100, y: 200 }
      }
    ]);
  });
});

describe('the publishing arms', () => {
  it('stores an artifact from the workspace copy it just read, then re-reads the size', async () => {
    const executed = await dispatch(
      {
        name: 'publish_artifact',
        arguments: { path: 'workspace/report.md', name: 'Report', mimeType: 'text/markdown' }
      },
      {
        route: (url, init) =>
          init?.method !== 'PUT' && url.includes('path=workspace%2Freport.md')
            ? new Response('# Report', { headers: { 'content-type': 'text/markdown' } })
            : undefined
      }
    );

    expect(executed.calls.map((entry) => `${entry.method} ${entry.path.split('?')[0]}`)).toEqual([
      `GET ${root}/file`,
      `PUT ${root}/file`,
      `GET ${root}/usage`
    ]);
    expect(executed.calls[1]?.path).toMatch(/path=\.athanor%2Fartifacts%2F/);
    expect(executed.calls[1]?.scopes).toEqual(['files.write']);
    expect(String(executed.calls[1]?.body)).toBe('# Report');
    const stored = executed.asked('createArtifact')?.[0] as Record<string, unknown>;
    expect(stored).toMatchObject({
      userId,
      workspaceId,
      taskId,
      mimeType: 'text/markdown',
      sizeBytes: 8
    });
    expect(executed.result).toMatchObject({ artifactId: 'artifact-1', name: 'Report', version: 3 });
  });

  it('refuses to record a scriptable type the model asked for', async () => {
    const executed = await dispatch(
      {
        name: 'publish_artifact',
        arguments: { path: 'workspace/page.txt', mimeType: 'text/html' }
      },
      {
        route: (url, init) =>
          init?.method !== 'PUT' && url.includes('path=workspace%2Fpage.txt')
            ? new Response('<p>hi</p>', { headers: { 'content-type': 'text/plain' } })
            : undefined
      }
    );

    expect(executed.asked('createArtifact')?.[0]).toMatchObject({ mimeType: 'text/plain' });
  });

  it('checks the port is listening before it hands the owner a private preview link', async () => {
    const executed = await dispatch(
      { name: 'publish_preview', arguments: { port: 5173, label: 'App', path: 'dashboard' } },
      {
        route: (url) =>
          url.endsWith(`${root}/preview-check/5173`) ? json({ available: true }) : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'GET',
        path: `${root}/preview-check/5173`,
        scopes: ['preview:5173'],
        body: undefined
      }
    ]);
    expect(executed.asked('createWorkspacePreview')?.[0]).toMatchObject({
      userId,
      workspaceId,
      label: 'App',
      port: 5173,
      entryPath: 'dashboard'
    });
    expect(executed.result).toMatchObject({ previewId: 'preview-1', visibility: 'private' });
  });

  it('says which port is silent rather than publishing a link to nothing', async () => {
    const executed = await dispatch(
      { name: 'publish_preview', arguments: { port: 5173 } },
      {
        route: (url) =>
          url.endsWith(`${root}/preview-check/5173`) ? json({ available: false }) : undefined
      }
    );

    expect(executed.failure?.code).toBe('preview_port_unavailable');
  });

  it('refuses the port the workspace runtime holds for itself', async () => {
    const executed = await dispatch({ name: 'publish_preview', arguments: { port: 4300 } });

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe('preview_port_reserved');
  });

  /**
   * The reserved-port refusal has to survive the model spelling the port badly.
   *
   * `Math.max(1024, Math.min(65_535, Number('4300ish')))` is `NaN`, and `NaN === 4300` is false -
   * so the one port this computer keeps for itself was reachable by asking for it in a way the
   * clamp could not read. What came out the other side was worse than a wrong port: the arm mints
   * its capability scope from the value, so the runner was handed a token scoped `preview:NaN` and
   * asked for `/preview-check/NaN`. A fractional port lands in exactly the same place: `4300.5`
   * is not `4300` either, and the schema says integer.
   *
   * Refused rather than defaulted, because there is no port to fall back to - the parameter is
   * required, and quietly publishing 1024 instead would hand the owner a link to something they
   * did not ask about.
   */
  it.each([
    ['a number with a word stuck to it', '4300ish'],
    ['a fraction that is not the reserved port on the nose', 4300.5],
    ['no number at all', 'the dev server']
  ])('refuses a preview port given as %s', async (_name, port) => {
    const executed = await dispatch({ name: 'publish_preview', arguments: { port } });

    // Nothing reached the runner, so nothing was minted: no `preview:NaN`, no check on a path
    // built out of one.
    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe(
      port === 4300.5 ? 'preview_port_reserved' : 'preview_port_invalid'
    );
  });

  /**
   * The same on the public half, which is now the same arm reached through `reach: 'public'` and
   * therefore the same clamp by construction rather than by two copies agreeing.
   */
  it('refuses an unreadable port on a public deployment too', async () => {
    const executed = await dispatch(
      { name: 'publish_preview', arguments: { port: '80 80', label: 'Docs', reach: 'public' } },
      { approved: true }
    );

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe('preview_port_invalid');
  });

  it('publishes an approved site publicly, on demand, from the same port check', async () => {
    const executed = await dispatch(
      { name: 'publish_preview', arguments: { port: 8080, label: 'Docs', reach: 'public' } },
      {
        approved: true,
        route: (url) =>
          url.endsWith(`${root}/preview-check/8080`) ? json({ available: true }) : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'GET',
        path: `${root}/preview-check/8080`,
        scopes: ['preview:8080'],
        body: undefined
      }
    ]);
    expect(executed.asked('publishWorkspacePreview')?.slice(0, 3)).toEqual([
      userId,
      'preview-1',
      'public'
    ]);
    expect(executed.result).toMatchObject({ visibility: 'public', expiresAt: null });
  });

  /*
   * `path` has to keep working at the public reach, and this is the row that says it does.
   *
   * The tool `reach: 'public'` replaced had no `path` parameter at all, so a public deployment of a
   * folder landed the visitor on a file index - which is the exact failure the private half's
   * `path` was written for after an owner received it, and it is worse in public. One arm serves
   * both reaches now, so the entry path is stored on the row either way; what this pins is that the
   * URL handed back to the model carries it too, because apps/api applies `entryPath` to every
   * address it hands out for both visibilities and a model told a different address from the one in
   * the owner's Preview tab is two readers disagreeing about one link.
   */
  it('lands a public visitor on the entry path, not on a file index', async () => {
    const executed = await dispatch(
      {
        name: 'publish_preview',
        arguments: { port: 8080, label: 'Docs', reach: 'public', path: 'dashboard' }
      },
      {
        approved: true,
        route: (url) =>
          url.endsWith(`${root}/preview-check/8080`) ? json({ available: true }) : undefined
      }
    );

    expect(executed.asked('createWorkspacePreview')?.[0]).toMatchObject({
      entryPath: 'dashboard'
    });
    const { url } = executed.result as { url: string };
    expect(url).toContain('/dashboard');
    // And no bearer token on an address anyone may hold, which is the whole difference between the
    // two reaches: the private link's `access` parameter IS the credential.
    expect(url).not.toContain('access=');
  });

  /*
   * The reach decides what is created, and a reach nothing recognises creates the PRIVATE one.
   *
   * Both halves of this used to be their own tool name, so there was no third answer to give. There
   * is now, and it has to fall the same way the approval floor falls: `publishesPublicly` in
   * @athanor/contracts is one exported equality against the literal `public`, called here and in
   * `approval-policy.ts`, so a value neither recognises is private for the card AND private for the
   * thing that gets made. The other pairing - a floor reading private on a call this arm publishes
   * publicly - is the defect that blocked this merge for a wave.
   */
  it.each([['omitted', undefined] as const, ['a reach nothing recognises', 'PUBLIC'] as const])(
    'creates a private preview when the reach is %s',
    async (_name, reach) => {
      const executed = await dispatch(
        {
          name: 'publish_preview',
          arguments: { port: 8080, label: 'Docs', ...(reach ? { reach } : {}) }
        },
        {
          approved: true,
          route: (url) =>
            url.endsWith(`${root}/preview-check/8080`) ? json({ available: true }) : undefined
        }
      );

      expect(executed.asked('publishWorkspacePreview')).toBeUndefined();
      expect(executed.result).toMatchObject({ visibility: 'private' });
    }
  );

  it('generates a picture, records the charge, and writes it where it resolved the path to', async () => {
    const executed = await dispatch(
      {
        name: 'generate_media',
        arguments: { kind: 'image', prompt: 'A quiet room', path: 'logo.png' }
      },
      {
        task: { privacyRoute: 'external' },
        route: (url, init) =>
          url.endsWith('/images') || url.endsWith('/images/generations')
            ? json({
                data: [
                  {
                    b64_json:
                      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bQAAAABJRU5ErkJggg=='
                  }
                ],
                usage: { cost: 0.0102 }
              })
            : init?.method === 'PUT'
              ? json({ ok: true })
              : undefined
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'PUT',
        path: `${root}/file?path=workspace%2Flogo.png`,
        scopes: ['files.write'],
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bQAAAABJRU5ErkJggg==',
          'base64'
        )
      },
      { method: 'GET', path: `${root}/usage`, scopes: ['files.read'], body: undefined }
    ]);
    expect(mediaUsage(executed)).toMatchObject({
      kind: 'model_inference',
      resourceClass: 'media:image',
      unit: 'generation',
      state: 'settled',
      costUsd: 0.0102
    });
    expect(executed.result).toMatchObject({
      kind: 'image',
      paths: ['workspace/logo.png'],
      costUsd: 0.0102
    });
  });

  it('refuses a generated path that climbs out of the workspace, before spending anything', async () => {
    const executed = await dispatch(
      {
        name: 'generate_media',
        arguments: { kind: 'image', prompt: 'A quiet room', path: '../escape.png' }
      },
      { task: { privacyRoute: 'external' } }
    );

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe('media_path_invalid');
  });

  it('reads a recording once, prices it from what was cut, and files the whole transcript', async () => {
    const executed = await dispatch(
      // 20 characters is below the tool's own floor of 1,000, so the cut lands there - which is
      // what makes this transcript long enough to be cut at all.
      {
        name: 'audio_read',
        arguments: {
          path: 'workspace/call.m4a',
          endSeconds: 60,
          maxCharacters: 20,
          options: { maxCostUsd: 0.05 }
        }
      },
      {
        providerBaseUrl: NATIVE_PROVIDER_URL,
        store: transcriptionStore('whisper-1', true),
        route: (url, init) => {
          if (url.endsWith('/audio/transcriptions'))
            return json({
              text: `The regulator published guidance in March. ${'It applies from June. '.repeat(60)}`,
              usage: { seconds: 60, cost: 0.006 }
            });
          if (url.endsWith(`${root}/audio/prepare`))
            return new Response(Buffer.from('audio-bytes'), {
              headers: {
                'content-type': 'application/octet-stream',
                'x-audio-start-seconds': '0',
                'x-audio-prepared-seconds': '60',
                'x-audio-duration-seconds': '900',
                'x-audio-more': 'true'
              }
            });
          if (init?.method === 'PUT') return json({ ok: true });
          return undefined;
        }
      }
    );

    expect(executed.calls).toEqual([
      {
        method: 'POST',
        path: `${root}/audio/prepare`,
        scopes: ['files.read'],
        // The explicit one-minute window is admitted using the selected route’s published price.
        body: { path: 'workspace/call.m4a', startSeconds: 0, endSeconds: 60 }
      },
      {
        method: 'PUT',
        path: `${root}/file?path=workspace%2Fcall.m4a.transcript.txt`,
        scopes: ['files.write'],
        // The whole transcript, before any of it is cut for the window: what was paid for is filed.
        body: `The regulator published guidance in March. ${'It applies from June. '.repeat(60)}`.trim()
      }
    ]);
    expect(mediaUsage(executed)).toMatchObject({
      resourceClass: 'media:transcription',
      unit: 'second',
      quantity: 60,
      costUsd: 0.006
    });
    expect(executed.result).toMatchObject({
      path: 'workspace/call.m4a',
      transcriptPath: 'workspace/call.m4a.transcript.txt',
      secondsRead: 60,
      truncated: true,
      modelId: 'whisper-1'
    });
  });

  /** Each paid reading keeps its own ledger identity, including a route switch on one window. */
  it('bills a second reading of the same window down a different route', async () => {
    const readOn = async (transcriptionModel: string): Promise<string> => {
      const executed = await dispatch(
        {
          name: 'audio_read',
          arguments: { path: 'workspace/call.m4a', endSeconds: 60, options: { maxCostUsd: 0.05 } }
        },
        {
          providerBaseUrl: NATIVE_PROVIDER_URL,
          store: transcriptionStore(transcriptionModel, true),
          route: (url, init) => {
            if (url.endsWith('/audio/transcriptions'))
              return json({ text: 'A short reading.', usage: { seconds: 60, cost: 0.006 } });
            if (url.endsWith(`${root}/audio/prepare`))
              return new Response(Buffer.from('audio-bytes'), {
                headers: {
                  'content-type': 'application/octet-stream',
                  'x-audio-start-seconds': '0',
                  'x-audio-prepared-seconds': '60',
                  'x-audio-duration-seconds': '900',
                  'x-audio-more': 'true'
                }
              });
            if (init?.method === 'PUT') return json({ ok: true });
            return undefined;
          }
        }
      );
      const usage = mediaUsage(executed);
      expect(usage).toMatchObject({ resourceClass: 'media:transcription' });
      return String(usage?.idempotencyKey);
    };

    // Same task, same file, same window - only the route changed, which is exactly the case the
    // key has to be able to tell apart.
    expect(await readOn('whisper-1')).not.toBe(await readOn('gpt-transcribe'));
  });

  it('will not send a private recording down a route with no zero-retention endpoint', async () => {
    const executed = await dispatch(
      { name: 'audio_read', arguments: { path: 'workspace/call.m4a' } },
      {
        approved: true,
        store: transcriptionStore('vendor/listener')
      }
    );

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe('transcription_external_consent_required');
  });
});

describe('the connector arms', () => {
  it('lists the connectors the owner enabled and nothing about the ones they did not', async () => {
    const executed = await dispatch(
      { name: 'connector_list', arguments: {} },
      {
        store: {
          listConnectors: async () => [
            {
              id: 'connector-1',
              kind: 'imap',
              label: 'Mailbox',
              scopes: ['mail:mailbox.read'],
              lastUsedAt: '2026-06-30T00:00:00.000Z',
              enabled: true
            },
            {
              id: 'connector-2',
              kind: 'caldav',
              label: 'Calendar',
              scopes: [],
              lastUsedAt: null,
              enabled: false
            }
          ]
        }
      }
    );

    expect(executed.calls).toEqual([]);
    expect(executed.result).toEqual([
      {
        id: 'connector-1',
        kind: 'imap',
        label: 'Mailbox',
        scopes: ['mail:mailbox.read'],
        lastUsedAt: '2026-06-30T00:00:00.000Z'
      }
    ]);
  });

  it('refuses an action against a connector that is not there', async () => {
    const executed = await dispatch({
      name: 'connector_action',
      arguments: { connectorId: 'connector-9', action: 'mail_list_mailboxes' }
    });

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe('connector_not_found');
  });

  it('refuses a connector secret sealed under some other context', async () => {
    const executed = await dispatch(
      {
        name: 'connector_action',
        arguments: { connectorId: 'connector-1', action: 'mail_list_mailboxes' }
      },
      {
        store: {
          getConnector: async () => ({
            id: 'connector-1',
            kind: 'imap',
            baseUrl: 'imaps://mail.example.com',
            scopes: ['mail:mailbox.read'],
            enabled: true,
            // Sealed for a different connector, which is what a swapped row looks like.
            secretCiphertext: encryptJson(
              { username: 'owner' },
              masterKey,
              `connector:${userId}:connector-2`
            )
          })
        }
      }
    );

    expect(executed.failure?.code).toBe('connector_secret_context');
  });

  it('writes an audit row for an action that failed, naming the operation it tried', async () => {
    const executed = await dispatch(
      {
        name: 'connector_action',
        arguments: { connectorId: 'connector-1', action: 'mail_list_mailboxes' }
      },
      {
        store: {
          getConnector: async () => ({
            id: 'connector-1',
            kind: 'imap',
            baseUrl: 'imaps://mail.example.com:993',
            scopes: [],
            enabled: true,
            secretCiphertext: encryptJson(
              { username: 'owner', password: 'app-password' },
              masterKey,
              `connector:${userId}:connector-1`
            )
          })
        }
      }
    );

    expect(executed.asked('recordConnectorAudit')?.[0]).toMatchObject({
      connectorId: 'connector-1',
      userId,
      taskId,
      operation: 'mail_list_mailboxes'
    });
  });

  it('answers an action this connector cannot run by naming the ones it can', async () => {
    /*
     * The other half of narrowing the catalogue by connected kind.
     *
     * `agentToolsFor` now sends a box only the actions its own connections reach, so a model that
     * has not called `connector_list` yet can ask for one that is not on its wire - and the answer
     * it used to get, "Action does not match this connector", named no alternative and cost it a
     * whole further round trip to find out what it may ask for instead. Being wrong has to be
     * cheap: the reachable set travels back with the refusal, in the same result.
     *
     * Nothing about the enforcement moved. `executeConnectorAction` in @athanor/core still refuses
     * this action on this connector; what is asserted here is that the refusal is answerable.
     */
    const executed = await dispatch(
      {
        name: 'connector_action',
        arguments: { connectorId: 'connector-1', action: 'github_read_file', input: {} }
      },
      {
        store: {
          getConnector: async () => ({
            id: 'connector-1',
            kind: 'imap',
            label: 'Work mail',
            baseUrl: 'imaps://mail.example.com:993',
            scopes: ['mail:mailbox.read'],
            enabled: true,
            secretCiphertext: encryptJson(
              { username: 'owner', password: 'app-password' },
              masterKey,
              `connector:${userId}:connector-1`
            )
          })
        }
      }
    );

    expect(executed.failure?.code).toBe('connector_action_invalid');
    // The reason, the connector it was aimed at, and every action that connector does run - so the
    // retry is the next call rather than the call after a connector_list.
    expect(executed.failure?.message).toContain('github_read_file is a github action');
    expect(executed.failure?.message).toContain('Work mail is a imap connection');
    for (const reachable of ['mail_search', 'mail_read_message', 'mail_send'])
      expect(executed.failure?.message, reachable).toContain(reachable);
    // And nothing was spent finding out: the mailbox was never opened.
    expect(executed.calls).toEqual([]);
  });

  it.todo(
    'executes a connector action end to end - needs a live IMAP or CalDAV server, so the executed half is covered by packages/core/src/mail-connectors.test.ts rather than here'
  );
});

describe('the arm that is not there', () => {
  it('names the tool it was asked for rather than failing silently', async () => {
    const executed = await dispatch({ name: 'teleport', arguments: { destination: 'Mars' } });

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.message).toBe('Unknown tool teleport');
  });
});

describe('the delegate arm', () => {
  it('runs the missions it was given and hands back one report each', async () => {
    const executed = await dispatch(
      {
        name: 'delegate',
        arguments: {
          missions: [{ name: 'sources', instruction: 'Find what the regulator published.' }]
        }
      },
      {
        provider: [
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'The regulator published guidance in March.'
                }
              }
            ],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
          })
        ]
      }
    );

    expect(executed.calls).toEqual([]);
    const result = executed.result as {
      reports: Array<{ name: string; report?: string }>;
      isolation: string;
    };
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.name).toBe('sources');
    expect(result.isolation).toContain('Read-only specialist contexts');
  });

  it('refuses a delegation with no mission in it', async () => {
    const executed = await dispatch({ name: 'delegate', arguments: { missions: [] } });

    expect(executed.calls).toEqual([]);
    expect(executed.failure?.code).toBe('delegate_invalid');
  });
});
