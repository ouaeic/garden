import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DIAGNOSTIC_CAPTURE_BYTES } from '@garden/contracts';
import { CapturedRuntimeReplay, replayRuntime, type RuntimeSegment } from './runtime-replay.js';
import {
  diagnosticPlainHash,
  diagnosticCipherHash,
  DIAGNOSTIC_EMPTY_HASH,
  type PrivateDiagnosticBody
} from '@garden/core';
import type { AgentState } from './agent-state.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GardenError,
  connectorActions,
  decryptJson,
  encryptJson,
  generateDataKey,
  wrapDataKey
} from '@garden/core';
import type { DataStore, TaskEventRecord, TaskRecord, WorkspaceRecord } from '@garden/data';
import type { ModelRelease } from '@garden/contracts';
import { MIN_TOKEN_BYTES } from './egress.js';
import { AgentWorker } from './agent.js';
import { approvalPreviewHash } from './approval-state.js';
import { buildIdentity } from './build-identity.js';
import { startTurnState } from './completion.js';
import { createLogger, silentLogger, type Logger } from './log.js';
import { UNTRUSTED_NOTICE_MARKER } from './provenance.js';
import {
  ACCEPTANCE_EARLIER_TURN_CAVEAT,
  DELEGATE_MAX_STEPS,
  MAX_NOTICES_PER_TURN,
  MAX_TRUNCATED_CONTINUATIONS,
  WORKSPACE_BRIEF_MARKER
} from './turn-bounds.js';
import {
  baseSystemPrompt,
  BASE_PROMPT_MARKER,
  compactionTargetTail,
  modelInputBudget,
  RUNTIME_CONTEXT_MARKER
} from './context.js';
import {
  MAX_STATIONARY_STEPS,
  PUSHBACK_MARKERS,
  stationaryStepsBeforeStop,
  type PushbackName
} from './turn-bounds.js';
import { TURN_WALL_CLOCK_MS } from './handoff.js';
import { managedMediaCatalog } from './media.js';
import { fixtureMediaRouting } from './media-fixture.js';
import { memoryItemAad, MEMORY_PACK_MARKER } from './memory-runtime.js';
import { agentTools } from './tools.js';
import { TOOL_GROUPS } from './tool-groups.js';
import type { WorkerConfig } from './config.js';

const masterKey = Buffer.alloc(32, 5);
const runnerSecret = 'r'.repeat(48);
const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const dataKey = generateDataKey();

const PROVIDER_URL = 'https://provider.test/v1';
const RUNNER_URL = 'http://127.0.0.1:4300';

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

const config = (
  overrides: Partial<WorkerConfig> = {}
): Omit<WorkerConfig, 'WORKER_HEALTH_PORT' | 'WORKER_HEALTH_HOST'> => ({
  WORKER_ID: 'worker-test',
  DATABASE_DRIVER: 'pglite',
  DATABASE_URL: 'postgres://localhost/garden',
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
  TASK_MAX_STEPS: 1,
  // Off unless a test asks for it, so every existing expectation about what happens at the step
  // ceiling still describes a turn that stops there.
  TASK_MAX_SELF_CONTINUATIONS: 0,
  ...overrides
});

interface StoreProbe {
  readonly store: DataStore;
  readonly checkpoints: Array<Record<string, unknown>>;
  readonly renewals: number[];
  readonly events: Array<{
    kind: string;
    summary: string;
    payload: unknown;
    /** Whether the write also asked the store to drop the frames this row carries the whole of. */
    replacesEarlierFrames?: boolean;
  }>;
  /** What was queued for the owner's devices, as opposed to written into the conversation. */
  readonly notifications: Array<{ kind: string; message: string }>;
  /** Turn checkpoints recorded against the workspace, as opposed to persisted agent state. */
  readonly undoPoints: Array<Record<string, unknown>>;
  readonly forgottenUndoPoints: string[][];
  /** Episode bodies the finished turn deposited, which is what a later task recalls it as. */
  readonly episodes: string[];
  /** The grade each injected item was given, which is what procedure health is computed from. */
  readonly memoryUses: Array<{ itemIds: string[]; outcome: string }>;
  /**
   * What the turn asked the store to do about the acceptance commands the harness watched: the
   * bodies of the cautions it wrote, and the keyed commands whose cautions it retired.
   */
  readonly deadEnds: Array<{ wrote: string[]; retired: string[] }>;
  /** Seeds the pack this task recalled, so the grade the turn writes on it is observable. */
  readonly recallPack: (itemIds: string[]) => void;
}

interface AgentStateShape {
  question?: { handoff?: { kind: string; tabId?: string } };
  messages: Array<{ role: string; content: string; toolCallId?: string }>;
  inFlight?: { toolCallId: string; tool: string; startedAt: string };
  step: number;
  checkpoint?: { turn: number; id: string | null; uncovered?: readonly string[] };
}

const probeStore = (task: () => TaskRecord): StoreProbe => {
  const checkpoints: Array<Record<string, unknown>> = [];
  const renewals: number[] = [];
  const events: StoreProbe['events'] = [];
  const initial = task();
  const storedEvents: TaskEventRecord[] = [];
  const openingEvent = (): TaskEventRecord => ({
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
  });
  const notifications: Array<{ kind: string; message: string }> = [];
  const undoPoints: Array<Record<string, unknown>> = [];
  const forgottenUndoPoints: string[][] = [];
  const episodes: string[] = [];
  const memoryUses: Array<{ itemIds: string[]; outcome: string }> = [];
  const deadEnds: StoreProbe['deadEnds'] = [];
  let memoryPack: Record<string, unknown> | null = null;
  let sources = 0;
  const store = {
    getUserById: async () => ({ preferences: {} }),
    getProjectModelPreferences: async () => ({
      projectTaskId: task().id,
      workspaceId: workspace.id,
      wrappedKey: workspace.wrappedKey,
      revision: 0,
      choicesCiphertext: null
    }),
    recordWorkspaceCheckpoint: async (input: Record<string, unknown>) => {
      undoPoints.push(input);
      return input;
    },
    deleteWorkspaceCheckpoints: async (_workspaceId: string, ids: string[]) => {
      forgottenUndoPoints.push(ids);
      return ids.length;
    },
    getWorkspaceById: async () => workspace,
    // Nothing connected, which is what a fresh box looks like: connector_action is left out of the
    // catalogue rather than described and unusable.
    listConnectors: async () => [],
    listModels: async () => [model],
    getManagedProviderCredential: async () => null,
    // Nothing saved, which is the shape a box configured from its environment has: the credential
    // comes from `AI_API_KEY`, not from a row, and a double that omitted this method would make
    // every turn in this file fail on a store call rather than on anything it means to test.
    listManagedProviderCredentials: async () => [],
    rerouteTaskModel: async () => false,
    recordModelThroughputCeiling: async () => undefined,
    modelThroughputCeiling: async () => null,
    listWorkspaceMemories: async () => [],
    curateWorkspaceSkills: async () => undefined,
    listWorkspaceSkills: async () => [],
    listMediaJobs: async () => [],
    getLatestTaskPlan: async () => null,
    listTaskEvents: async (
      id: string,
      after = 0,
      selection?: { kind: TaskEventRecord['kind']; limit: number }
    ) => {
      const rows = [openingEvent(), ...storedEvents].filter(
        (row) =>
          row.taskId === id && row.sequence > after && (!selection || row.kind === selection.kind)
      );
      return selection
        ? rows.slice(-Math.max(1, Math.min(1_000, Math.trunc(selection.limit))))
        : rows;
    },
    // The worker treats a version conflict as "a newer plan exists", which keeps this probe out of
    // the plan-encryption path without changing any branch the tests care about.
    createTaskPlan: async () => {
      throw new Error('plan_version_conflict');
    },
    // The run asks the opening event where the task came from, because a scheduled run and a run
    // the owner is watching are told different things about staying quiet.
    listTaskEventPage: async () => ({
      events: [],
      hasMore: false,
      oldestSequence: null,
      nextCursor: 0
    }),
    getTask: async () => task(),
    // The narrow read the stop watch polls while a model request streams. It answers from the same
    // task the run is built on, so a test that pauses the task stops the request too.
    taskClaim: async () => {
      const current = task();
      return { status: current.status, leaseOwner: current.leaseOwner ?? null };
    },
    yieldTaskLease: async (input: Record<string, unknown>) => {
      checkpoints.push({ ...input, status: 'queued', clearLease: true, yielded: true });
      return true;
    },
    saveTaskQuestion: async (
      input: Parameters<DataStore['saveTaskQuestion']>[0]
    ): Promise<boolean> => {
      await store.updateTask({
        id: input.taskId,
        workerId: input.workerId,
        status: input.park ? 'awaiting_user' : 'running',
        agentStateCiphertext: input.agentStateCiphertext,
        actualComputeCredits: input.actualComputeCredits,
        clearLease: input.park
      });
      if (input.event)
        await store.appendTaskEvent({
          kind: 'question_asked',
          payloadCiphertext: input.event.payloadCiphertext
        });
      return true;
    },
    updateTask: async (input: Record<string, unknown>) => {
      checkpoints.push(input);
      return task();
    },
    renewTaskLease: async (_id: string, _worker: string, seconds: number) => {
      renewals.push(seconds);
      return true;
    },
    appendTaskEvent: async (input: {
      kind: TaskEventRecord['kind'];
      payloadCiphertext: Parameters<typeof decryptJson>[0];
      replacesEarlierFrames?: boolean;
    }) => {
      const body = decryptJson<{ summary: string; payload: unknown }>(
        input.payloadCiphertext,
        dataKey
      );
      events.push({
        kind: input.kind,
        summary: body.summary,
        payload: body.payload,
        ...(input.replacesEarlierFrames ? { replacesEarlierFrames: true } : {})
      });
      const sequence = storedEvents.length + 2;
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
    // The other end of a notice: the row the notifier reads to reach a phone. The conversation
    // event and this are written together, and a test that only saw the event could not tell the
    // difference between a notice the owner receives and one that never leaves the machine.
    createAgentNotification: async (input: {
      userId: string;
      taskId: string;
      kind: string;
      messageCiphertext: Parameters<typeof decryptJson>[0];
    }) => {
      const body = decryptJson<{ message: string }>(input.messageCiphertext, dataKey);
      notifications.push({ kind: input.kind, message: body.message });
      return {
        id: `notification-${notifications.length}`,
        userId: input.userId,
        taskId: input.taskId,
        kind: input.kind,
        messageCiphertext: input.messageCiphertext,
        createdAt: new Date().toISOString()
      };
    },
    recordUsage: async () => undefined,
    // The money ceiling is consulted before every step, so a probe that omits it fails every test
    // here with a type error rather than the behaviour under test.
    spendGuard: async () => ({
      outcome: 'allow' as const,
      estimateUsd: 0,
      blockedBy: null,
      warnedBy: [],
      reason: null,
      windows: []
    }),
    // The owner's time zone reaches the prompt through the spend limits that already store it, so
    // a probe without it starts every task in UTC rather than in the owner's day.
    effectiveSpendLimits: async () => ({ timeZone: 'Europe/London' }),
    setWorkspaceStorage: async () => undefined,
    transitionUsage: async () => undefined,
    getNextQueuedTaskMessage: async () => null,
    // What a turn that died does about a message the owner sent to it. The default is the ordinary
    // failure: nothing was queued, so nothing is carried and nothing is refused.
    requeueTaskForQueuedMessage: async () => null,
    strandQueuedTaskMessages: async () => [],
    // What the turn deposits in memory. Capture has its own try/catch inside the agent, so a probe
    // missing these methods logs one warning and records nothing - which is why the label a turn
    // files itself under went unwatched for so long.
    createMemoryItem: async (input: {
      kind: string;
      documentCiphertext: Parameters<typeof decryptJson>[0];
    }) => {
      if (input.kind === 'episode')
        episodes.push(
          decryptJson<{ body: string }>(
            input.documentCiphertext,
            dataKey,
            `memory-item:${workspaceId}`
          ).body
        );
      return { id: 'item' };
    },
    // The failing half of the same lesson. Both lists are captured, because "wrote nothing" and
    // "was never asked" are different results and only one of them is the guard working.
    recordMemoryDeadEnds: async (input: {
      passed?: readonly string[];
      failed?: readonly { documentCiphertext: Parameters<typeof decryptJson>[0] }[];
    }) => {
      deadEnds.push({
        wrote: (input.failed ?? []).map(
          (item) =>
            decryptJson<{ body: string }>(
              item.documentCiphertext,
              dataKey,
              `memory-item:${workspaceId}`
            ).body
        ),
        retired: [...(input.passed ?? [])]
      });
      return { recorded: [], retired: [] };
    },
    createMemorySource: async () => {
      sources += 1;
      return { id: `source-${sources}` };
    },
    attachMemoryEvidence: async () => undefined,
    observeMemoryFactCandidate: async () => undefined,
    promoteMemoryFactCandidates: async () => [],
    getMemoryPack: async () => memoryPack,
    recordMemoryUse: async (input: { itemIds: readonly string[]; outcome: string }) => {
      memoryUses.push({ itemIds: [...input.itemIds], outcome: input.outcome });
      return input.itemIds.length;
    },
    // It carries the closing agent state, which is the copy the next turn resumes from - so a probe
    // that dropped it could not see what a finished turn actually left behind.
    completeTaskIfNoQueued: async (input: Record<string, unknown>) => {
      checkpoints.push(input);
      return true;
    },
    consolidateMemory: async () => undefined
  };
  return {
    store: store as unknown as DataStore,
    checkpoints,
    renewals,
    events,
    notifications,
    undoPoints,
    forgottenUndoPoints,
    episodes,
    memoryUses,
    deadEnds,
    recallPack: (itemIds: string[]) => {
      memoryPack = {
        taskId,
        workspaceId,
        briefVersion: null,
        bodyCiphertext: encryptJson(
          { body: '# MEMORY PACK\n- `make notes` tidies the notes directory' },
          dataKey,
          `memory-pack:${taskId}`
        ),
        sha256: 'pack',
        itemIds,
        tokensEst: 12,
        createdAt: '2026-07-01T00:00:00.000Z'
      };
    }
  };
};

const decryptCheckpoints = (checkpoints: Array<Record<string, unknown>>): AgentStateShape[] =>
  checkpoints.flatMap((input) =>
    input.agentStateCiphertext
      ? [
          decryptJson<AgentStateShape>(
            input.agentStateCiphertext as Parameters<typeof decryptJson>[0],
            dataKey
          )
        ]
      : []
  );

/** A pushback's published opening, so a test asserting a hold and the loop cannot drift apart. */
const marker = (name: PushbackName): string =>
  PUSHBACK_MARKERS.find(([published]) => published === name)?.[1] ??
  `no marker published for ${name}`;

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const textFrame = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: { content } }] })}\n\ndata: [DONE]\n\n`;

/** The thinking arriving on its own channel ahead of the answer, as a reasoning route sends it. */
const thoughtsThenTextFrame = (thoughts: string[], content: string): string =>
  [
    ...thoughts.map(
      (reasoning) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning } }] })}\n\n`
    ),
    textFrame(content)
  ].join('');

/** A completion that was never streamed, which is what a delegated specialist's own calls read. */
const completion = (message: Record<string, unknown>): string =>
  JSON.stringify({
    choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
  });

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

/** Several calls in one reply, which is how every gate below is actually reached. */
const batchFrame = (
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>
): string =>
  `data: ${JSON.stringify({
    choices: [
      {
        finish_reason: 'tool_calls',
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            function: { name: call.name, arguments: JSON.stringify(call.args) }
          }))
        }
      }
    ]
  })}\n\ndata: [DONE]\n\n`;

const readPath = (url: string): string =>
  decodeURIComponent(new URL(url).searchParams.get('path') ?? '');

/** A runner response whose body arrives only when `until` settles, and dies if torn down first. */
const heldBody = (body: string, until: Promise<void>, signal?: AbortSignal | null): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let settled = false;
        const tearDown = (): void => {
          if (settled) return;
          settled = true;
          controller.error(new Error('the connection was torn down'));
        };
        if (signal?.aborted) {
          tearDown();
          return;
        }
        signal?.addEventListener('abort', tearDown, { once: true });
        void until.then(() => {
          if (settled) return;
          settled = true;
          controller.enqueue(encode(body));
          controller.close();
        });
      }
    }),
    { headers: { 'content-type': 'application/json' } }
  );

const toolMessages = (probe: StoreProbe): Array<{ toolCallId?: string; content: string }> => {
  const state = decryptCheckpoints(probe.checkpoints).at(-1);
  return (state?.messages ?? []).filter((message) => message.role === 'tool');
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const makeTask = (agentState?: unknown): TaskRecord => ({
  id: taskId,
  userId,
  workspaceId,
  parentTaskId: null,
  branchedFromEventId: null,
  forkKind: null,
  // A conversation the owner started, which is what every test in this file is about. The worker
  // never reads this - it is provenance the sidebar folds runs of one schedule by - but the record
  // declares it, so the fixture has to say which kind of conversation it is standing in for.
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

interface FetchLog {
  readonly calls: string[];
  readonly modelRequests: Array<Record<string, unknown>>;
  readonly modelAuthorizations?: Array<string | null>;
  /** Bodies sent to the workspace runner, for the tests that care what a tool actually asked for. */
  readonly runnerRequests?: Array<{ url: string; body: unknown }>;
  /** Generation requests, which reach the same host as inference but a different route. */
  readonly mediaRequests?: Array<Record<string, unknown>>;
}

const checkpointResponse = (
  pruned: string[] = [],
  oversize?: { uncoveredPaths?: unknown; uncoveredPathsTruncated?: boolean }
): Response =>
  new Response(
    JSON.stringify({
      id: 'checkpoint',
      mechanism: 'content',
      createdAt: '2026-07-01T00:00:00.000Z',
      fileCount: 12,
      totalBytes: 4_096,
      storedBytes: 128,
      changedFileCount: 2,
      uncoveredFileCount: 0,
      durationMs: 21,
      pruned,
      ...(oversize ?? {})
    }),
    { headers: { 'content-type': 'application/json' } }
  );

/** Serves the provider and the workspace runner from one stub so call ordering stays observable. */
const installFetch = (
  // A body factory is handed the request init so a stub can behave like a real connection does:
  // undici errors an in-flight response stream when the request's signal aborts, and a test that
  // ignores the signal cannot tell a request that was torn down from one that ran to completion.
  providerBodies: Array<BodyInit | ((init?: RequestInit) => BodyInit)>,
  log: FetchLog,
  runner: {
    checkpoint?: () => Response;
    // Handed the request init for the same reason the provider bodies are: a runner call that is
    // torn down mid-flight - by a Stop, by a cancel - errors its response stream, and a stub that
    // never sees the signal cannot tell that apart from a call that ran to completion.
    route?: (url: string, init?: RequestInit) => Response | undefined;
    media?: () => Response;
  } = {}
): void => {
  let served = 0;
  vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    log.calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.startsWith(PROVIDER_URL)) {
      /*
       * The catalogue route that says which companies serve a model and what they charge, which a
       * turn reads to work out the price cap it will accept. It is metadata rather than generation
       * and must be answered as such: served from `providerBodies` it would eat the frames of the
       * step that follows it and shift every model response in the test by one.
       */
      if (url.includes('/endpoints'))
        return new Response(JSON.stringify({ data: { endpoints: [] } }), {
          headers: { 'content-type': 'application/json' }
        });
      // Generation is an ordinary request to the configured provider, so it arrives here too. It
      // is answered from its own stub: routing it to the inference frames would hand a media call
      // an SSE body and make the next model step read someone else's turn.
      if (
        url.endsWith('/images') ||
        url.endsWith('/images/generations') ||
        url.endsWith('/audio/speech')
      ) {
        if (typeof init?.body === 'string')
          log.mediaRequests?.push(JSON.parse(init.body) as Record<string, unknown>);
        return (
          runner.media ??
          (() =>
            url.endsWith('/audio/speech')
              ? new Response(Buffer.from('ID3speech'), {
                  headers: { 'content-type': 'audio/mpeg' }
                })
              : new Response(
                  JSON.stringify({
                    data: [
                      {
                        b64_json:
                          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bQAAAABJRU5ErkJggg=='
                      }
                    ],
                    usage: { cost: 0.0102 }
                  }),
                  { headers: { 'content-type': 'application/json' } }
                ))
        )();
      }
      if (typeof init?.body === 'string') {
        log.modelRequests.push(JSON.parse(init.body) as Record<string, unknown>);
        log.modelAuthorizations?.push(new Headers(init.headers).get('authorization'));
      }
      const next = providerBodies[Math.min(served, providerBodies.length - 1)];
      served += 1;
      return new Response(typeof next === 'function' ? next(init) : (next ?? ''), {
        headers: { 'content-type': 'text/event-stream' }
      });
    }
    if (log.runnerRequests && typeof init?.body === 'string')
      log.runnerRequests.push({ url, body: JSON.parse(init.body) as unknown });
    const routed = runner.route?.(url, init);
    if (routed) return routed;
    if (url.includes('/checkpoints')) return (runner.checkpoint ?? checkpointResponse)();
    if (url.includes('/file'))
      return init?.method === 'PUT'
        ? new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' }
          })
        : new Response('', { status: 404 });
    /*
     * Everything else is 404, and the list above it is the whole of what this stub will answer
     * blind.
     *
     * It used to answer *any* unmatched runner URL with `{ok:true, storageBytes:2048}`, and that is
     * how the worst live defect in this file's subject stayed invisible: a `/browser/preflight`
     * answered that way comes back `consequential: undefined, sensitiveInput: undefined`, which is
     * the benign verdict, and the branch that turned a benign verdict into an approval card was
     * never once executed by a green suite. A stub that says yes to a route nobody modelled is a
     * stub that tests the harness instead of the code - the same lesson `evals/harness.ts` learnt
     * when its unstubbed routes started 404ing. The three below are answered because a real turn
     * asks for them on the way past and no test here is about them; a new route has to be declared
     * by the test that needs it.
     */
    const { pathname } = new URL(url);
    if (
      pathname.endsWith('/toolchain') ||
      pathname.endsWith('/toolchain/probe') ||
      pathname.endsWith('/usage')
    )
      return new Response(JSON.stringify({ ok: true, storageBytes: 2_048 }), {
        headers: { 'content-type': 'application/json' }
      });
    return new Response(JSON.stringify({ error: `no stub for ${pathname}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('curated tool discovery', () => {
  it('loads schemas on the next real model request and persists them through a worker lease', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'I will load the coding tools and read the project note.' } }] })}\n\n` +
          toolFrame('load-code', 'load_tools', { groups: ['code'] }),
        toolFrame('read-note', 'file_read', { path: 'workspace/notes.txt' }),
        toolFrame('finish-discovery', 'finish', {
          summary: 'The coding tools are ready and the note was read.',
          verification: {
            status: 'verified',
            evidence: [{ claim: 'Read the note', source: 'tool_result', toolCallId: 'read-note' }]
          }
        })
      ],
      log,
      {
        route: (url) =>
          url.includes('/file?')
            ? new Response(JSON.stringify({ content: 'The coding work starts from this note.' }), {
                headers: { 'content-type': 'application/json' }
              })
            : undefined
      }
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 8 }), masterKey, runnerSecret).run(
      task
    );
    expect(log.modelRequests, JSON.stringify(probe.events)).toHaveLength(3);
    const catalogue = (request: Record<string, unknown>) =>
      request.tools as Array<{ function: { name: string } }>;
    const first = catalogue(log.modelRequests[0]!),
      second = catalogue(log.modelRequests[1]!);
    expect(first.map((tool) => tool.function.name)).toContain('load_tools');
    expect(first.map((tool) => tool.function.name)).not.toContain('code_search');
    expect(second.map((tool) => tool.function.name)).toContain('code_search');
    expect(second.slice(0, first.length)).toEqual(first);
    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(true);
    const saved = probe.checkpoints.filter((entry) => entry.agentStateCiphertext).at(-1);
    expect(saved).toBeDefined();
    const state = decryptJson<{ enabledToolGroups: string[] }>(
      saved!.agentStateCiphertext as Parameters<typeof decryptJson>[0],
      dataKey
    );
    expect(state.enabledToolGroups).toEqual(['code']);
    const resumed = makeTask(state),
      resumedProbe = probeStore(() => resumed);
    const resumedLog: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('finish-resumed', 'finish', {
          summary: 'Ready.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      resumedLog
    );
    await new AgentWorker(
      resumedProbe.store,
      config({ TASK_MAX_STEPS: 8 }),
      masterKey,
      runnerSecret
    ).run(resumed);
    expect(resumedLog.modelRequests.length).toBeGreaterThan(0);
    expect(catalogue(resumedLog.modelRequests[0]!).map((tool) => tool.function.name)).toContain(
      'code_search'
    );
    expect(log.calls.some((url) => url.includes('/exec'))).toBe(false);
  });
});

describe('owner message attachments', () => {
  it('delivers sealed attachment references in the first owner message sent to the model', async () => {
    const task = makeTask();
    const prompt = 'Read the attached note.';
    task.promptCiphertext = encryptJson(
      { prompt, attachments: ['workspace/note.txt'] },
      dataKey,
      `task-prompt:${workspaceId}`
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('I can inspect the note.')], log);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret).run(task);
    expect(log.modelRequests.length).toBeGreaterThan(0);
    const messages = log.modelRequests[0]!.messages as Array<{ role: string; content: string }>;
    const owner = messages.find((message) => message.role === 'user');
    expect(owner).toBeDefined();
    expect(owner!.content).toContain(prompt);
    expect(owner!.content).toContain('workspace/note.txt');
  });
});

describe('the turn wall clock', () => {
  it('yields a long execution without a model call or resetting its budget', async () => {
    vi.useFakeTimers();
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        () => {
          vi.setSystemTime(Date.now() + TURN_WALL_CLOCK_MS);
          return toolFrame('call-1', 'files_list', { path: 'workspace' });
        }
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 40 }), masterKey, runnerSecret).run(
      task
    );
    expect(log.modelRequests).toHaveLength(1);
    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(false);
    expect(
      probe.events.some(
        (entry) => (entry.payload as { code?: string } | undefined)?.code === 'task_budget_reached'
      )
    ).toBe(false);
    const saved = probe.checkpoints.find((entry) => entry.yielded === true);
    expect(saved).toBeDefined();
    expect(saved?.status).toBe('queued');
    const state = decryptJson<AgentStateShape>(
      saved!.agentStateCiphertext as Parameters<typeof decryptJson>[0],
      dataKey
    );
    expect(state.step).toBe(1);
    expect(state.inFlight).toBeUndefined();
    expect(state.messages.some((entry) => entry.toolCallId === 'call-1')).toBe(true);
  });

  /**
   * Its sibling, which nothing was driving.
   *
   * The compute-credit ceiling sits two lines below the clock in the same block and ends the turn
   * the same way, and until this test it had no end-to-end proof at all: the whole of apps/worker
   * stayed green with the credit arm reporting the step as open after it had already handed the
   * turn over, which is a turn that carries on spending past the budget the owner set. The hole was
   * found by attack during the Wave 8 phase decomposition - `return 'closed'` changed to
   * `return 'open'`, 1,177 tests, none of them red - and it is the reason this file's `openStep`
   * arm is now driven rather than read.
   *
   * The budget is set to a thousandth of a credit because that is `usageCredit`'s own floor, so one
   * step of any size is guaranteed to reach it and the test does not depend on token counts.
   */
  it('writes the owner the same handoff when the turn has spent its whole compute budget', async () => {
    const task = { ...makeTask(), maxComputeCredits: 0.001 };
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        // One step that does something cheap, which is enough to reach the floor of one credit
        // charge, and then the closing handoff call the ceiling makes on the next iteration.
        toolFrame('call-1', 'files_list', { path: 'workspace' }),
        textFrame('Out of budget - the listing is done, the tidy-up is not.')
      ],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 40 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const warning = probe.events.find(
      (entry) =>
        entry.kind === 'warning' &&
        entry.summary === 'This turn used its whole compute budget before the work was finished'
    );
    expect(warning).toBeDefined();
    expect((warning?.payload as { owner?: boolean }).owner).toBe(true);
    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(true);
    // And it stopped: two model calls, the step and the handoff, and not a third.
    expect(log.modelRequests).toHaveLength(2);
    const spoken = probe.events.filter((entry) => entry.kind === 'assistant_message');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.summary).toContain('Out of budget');
  });
});

describe('the model call and the task lease', () => {
  it('renews the lease while the provider is still answering', async () => {
    vi.useFakeTimers();
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let release = (): void => undefined;
    let requested = (): void => undefined;
    const modelRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    installFetch(
      [
        () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              requested();
              release = (): void => {
                controller.enqueue(encode(textFrame('still here')));
                controller.close();
              };
            }
          }),
        // The closing handoff call. Without a body of its own it would reuse the stream above,
        // which is deliberately held open, and the run would never settle.
        textFrame('Out of steps.')
      ],
      log
    );
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    const running = worker.run(task).catch((error: unknown) => error);
    await modelRequested;
    expect(probe.renewals).toHaveLength(0);

    // Longer than the 45 s renewal interval and far shorter than the 15-minute request deadline:
    // the lease is 120 s, so without this the task is stealable while the model is still talking.
    await vi.advanceTimersByTimeAsync(46_000);
    expect(probe.renewals.length).toBeGreaterThanOrEqual(1);
    expect(probe.renewals[0]).toBe(120);

    release();
    await running;
  });

  it('marks the cacheable prefix on the wire, on the route the catalogue described', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Done.')], log);
    /*
     * The routing fields are deliberately kept off the owner-facing model shape and carried
     * alongside it, which is exactly how `store.listModels` returns them and how the worker
     * receives them - so the catalogue entry is built the same way here.
     */
    const cachingRoute = { ...model, promptCacheStyle: 'explicit' as const };

    await new AgentWorker(
      { ...probe.store, listModels: async () => [cachingRoute] } as unknown as typeof probe.store,
      config(),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    const sent = (log.modelRequests[0]?.messages ?? []) as Array<{ content: unknown }>;
    const marked = sent.filter(
      (message) =>
        Array.isArray(message.content) &&
        (message.content as Array<Record<string, unknown>>).some((block) => block.cache_control)
    );
    /*
     * The whole breakpoint apparatus in context.ts was computed on every step, counted into the
     * cost event, and then dropped on the floor: nothing carried the route's cache style from the
     * catalogue entry onto the request, so the adapter fell back to a two-vendor slug list and
     * marked nothing. Measured on one twenty-step task, thirteen steps cached nothing at all and
     * 187,014 of 289,514 input tokens were billed at full rate against a fixed head of about
     * 12,000 that only ever needed paying for once. Asserted on the request body rather than on
     * the helper, because the helper was never what was broken.
     */
    expect(marked.length).toBeGreaterThan(0);
  });

  it('tears down the request in flight when the owner stops the task', async () => {
    vi.useFakeTimers();
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let requested = (): void => undefined;
    const modelRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    let torn = false;
    installFetch(
      [
        (init) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Part of an answer arrives, and then the provider keeps writing - which is the whole
              // shape of the complaint: Stop said the task had stopped and the text kept coming.
              controller.enqueue(
                encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: 'Half a sen' } }] })}\n\n`
                )
              );
              requested();
              init?.signal?.addEventListener('abort', () => {
                torn = true;
                controller.error(new Error('aborted'));
              });
            }
          })
      ],
      log
    );
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    const running = worker.run(task);
    await modelRequested;
    task.status = 'cancelled';
    task.leaseOwner = null;

    // Longer than the stop poll, far shorter than the 15-minute request deadline.
    await vi.advanceTimersByTimeAsync(4_000);
    await running;

    expect(torn).toBe(true);
    // One request. The turn ends here rather than looping into another step on the owner's money.
    expect(log.modelRequests).toHaveLength(1);
    // The words the owner watched being written are kept; no reply is published after the stop.
    expect(probe.events.some((event) => event.kind === 'assistant_delta')).toBe(true);
    expect(probe.events.some((event) => event.kind === 'assistant_message')).toBe(false);
    expect(probe.events.at(-1)).toMatchObject({
      kind: 'status',
      summary: 'Task cancelled by user'
    });
    // ...and the trajectory is saved, unguarded, because the cancel already cleared the lease.
    const closing = probe.checkpoints.at(-1);
    expect(closing).toMatchObject({ status: 'cancelled', clearLease: true });
    expect(closing?.agentStateCiphertext).toBeDefined();
    expect(closing?.workerId).toBeUndefined();
  });

  it('bills what a stopped generation had already produced', async () => {
    /*
     * The other half of the same defect the repetition watch had: the tokens were generated and the
     * provider billed them, whoever ended the generation. The abort used to escape as an exception
     * and the handler for it returned from above the whole billing block, so a Stop pressed on a
     * long answer settled at $0.00 - and `lastStepUsd`, which is what the spending guard prices the
     * next step from, kept the figure from the step before.
     */
    vi.useFakeTimers();
    const task = makeTask();
    const probe = probeStore(() => task);
    const billed: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      recordUsage: async (input: Record<string, unknown>) => {
        if (input.kind === 'model_inference') billed.push(input);
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    let requested = (): void => undefined;
    const modelRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    installFetch(
      [
        (init) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encode(
                  `data: ${JSON.stringify({
                    choices: [{ delta: { content: 'A long answer the owner stopped reading. ' } }]
                  })}\n\n`
                )
              );
              requested();
              // As undici tears one down: the read rejects with an AbortError rather than with an
              // anonymous fault, which is the only thing that tells a cancel from a dead socket.
              init?.signal?.addEventListener('abort', () =>
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
              );
            }
          })
      ],
      log
    );
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    const running = worker.run(task);
    await modelRequested;
    task.status = 'paused';
    task.leaseOwner = null;
    await vi.advanceTimersByTimeAsync(4_000);
    await running;

    const row = billed.find((entry) => entry.idempotencyKey === `task:${taskId}:step:0`);
    expect(row, 'the stopped generation left no ledger row at all').toBeDefined();
    expect(Number(row?.costUsd)).toBeGreaterThan(0);
    // And the owner is still told the turn stopped, in the same words, last.
    expect(probe.events.at(-1)).toMatchObject({ kind: 'status', summary: 'Task paused by user' });
    expect(log.modelRequests).toHaveLength(1);
  });

  it('writes nothing at all, ledger included, when another claimant holds the task', async () => {
    // The counterpart to the row above, and the reason billing is on the `stopped` arm only: every
    // write a disowned run makes lands on a trajectory somebody else is in the middle of.
    vi.useFakeTimers();
    const task = makeTask();
    const probe = probeStore(() => task);
    const billed: unknown[] = [];
    Object.assign(probe.store, {
      recordUsage: async (input: Record<string, unknown>) => {
        if (input.kind === 'model_inference') billed.push(input);
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    let requested = (): void => undefined;
    const modelRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    installFetch(
      [
        (init) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encode(
                  `data: ${JSON.stringify({
                    choices: [{ delta: { content: "Half of somebody else's answer. " } }]
                  })}\n\n`
                )
              );
              requested();
              init?.signal?.addEventListener('abort', () =>
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
              );
            }
          })
      ],
      log
    );
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    const running = worker.run(task);
    await modelRequested;
    task.leaseOwner = 'another-worker';
    await vi.advanceTimersByTimeAsync(4_000);
    await running;

    expect(billed).toHaveLength(0);
    expect(probe.events.some((entry) => entry.kind === 'cost')).toBe(false);
    expect(probe.checkpoints.some((entry) => entry.status === 'paused')).toBe(false);
    expect(log.modelRequests).toHaveLength(1);
  });

  it('stands down in silence when another worker has taken the task', async () => {
    vi.useFakeTimers();
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let requested = (): void => undefined;
    const modelRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    installFetch(
      [
        (init) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              requested();
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            }
          })
      ],
      log
    );
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    const running = worker.run(task);
    await modelRequested;
    const before = probe.events.length;
    // A pause that was resumed inside the poll window: the resume cleared the lease and set the
    // status back to queued, and a second worker took it while this one was still generating. It is
    // then stopped again, so this worker reads the owner's own stop on a task that is no longer its
    // to record - the one case where honouring it would write over somebody else's trajectory.
    task.status = 'cancelled';
    task.leaseOwner = 'another-worker';

    await vi.advanceTimersByTimeAsync(4_000);
    await running;

    // Not a word and not a write. Everything this run could say now would land on the trajectory
    // the other claimant is building, and the closing write is unguarded - it would take their
    // lease with it and leave them generating into a task nothing they write can reach.
    expect(probe.events).toHaveLength(before);
    expect(probe.checkpoints.every((checkpoint) => checkpoint.status !== 'cancelled')).toBe(true);
    expect(log.modelRequests).toHaveLength(1);
  });

  it('closes the streamed thinking with one row carrying the whole of it', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [thoughtsThenTextFrame(['Let me ', 'check the notes ', 'first.'], 'Tidied.')],
      log
    );

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // Nothing ever superseded these the way the closing message supersedes the answer's frames, so
    // a step that thought for the better part of a minute left a few hundred encrypted rows behind
    // for good - and had them read back and decrypted on every reopen of the conversation.
    const thinking = probe.events.filter((event) => event.kind === 'assistant_reasoning');
    expect(thinking.at(-1)).toMatchObject({
      payload: { markdown: 'Let me check the notes first.', replace: true },
      replacesEarlierFrames: true
    });
    expect(thinking.slice(0, -1).every((event) => !event.replacesEarlierFrames)).toBe(true);
  });
});

describe('a tool call interrupted by a restart', () => {
  it('records the intent durably before the tool runs', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-1', 'shell', { executable: 'ls', args: ['-la'] })], log);
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    const beforeExec = probe.checkpoints.findIndex((input) => {
      if (!input.agentStateCiphertext) return false;
      const state = decryptJson<AgentStateShape>(
        input.agentStateCiphertext as Parameters<typeof decryptJson>[0],
        dataKey
      );
      return state.inFlight?.toolCallId === 'call-1';
    });
    expect(beforeExec).toBeGreaterThanOrEqual(0);
    const states = decryptCheckpoints(probe.checkpoints);
    // Written, and cleared again, around the call - so a worker that dies inside it leaves the
    // record set and one that survives leaves no stale claim behind.
    expect(states.some((state) => state.inFlight?.tool === 'shell')).toBe(true);
    expect(states.at(-1)?.inFlight).toBeUndefined();
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(true);
  });

  it('leaves a read-only tool unmarked, so a restart raises no doubt about it', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-2', 'files_list', { path: 'workspace' })], log);
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    expect(decryptCheckpoints(probe.checkpoints).every((state) => !state.inFlight)).toBe(true);
  });

  it('does not repeat a shell tool that was already in flight, and tells the model why', async () => {
    const interruptedState = {
      messages: [
        { role: 'user', content: 'Publish the report' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-9', name: 'shell', arguments: { executable: 'curl', args: ['-d', 'x'] } },
            { id: 'call-10', name: 'files_list', arguments: {} }
          ]
        }
      ],
      step: 0,
      credits: 0,
      turnToolResults: {},
      inFlight: { toolCallId: 'call-9', tool: 'shell', startedAt: '2026-07-01T00:01:00.000Z' }
    };
    const task = makeTask(interruptedState);
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Let me check whether that already happened.')], log);
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 3 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
    const messages = (log.modelRequests[0]?.messages ?? []) as Array<{
      role: string;
      content: string;
      tool_call_id?: string;
    }>;
    const answer = messages.find((message) => message.tool_call_id === 'call-9');
    expect(answer?.content).toContain('Interrupted');
    expect(answer?.content).toContain('may not have');
    // The calls behind it never ran at all, and say so rather than being left dangling.
    expect(messages.find((message) => message.tool_call_id === 'call-10')?.content).toContain(
      'Not executed'
    );
    expect(
      probe.events.some(
        (entry) => entry.kind === 'warning' && entry.summary.includes('interrupted by a restart')
      )
    ).toBe(true);
  });

  it.each(['completed', 'uncertain', 'missing'] as const)(
    'recovers a %s browser receipt without repeating the action',
    async (status) => {
      const task = makeTask({
        messages: [
          { role: 'user', content: 'Submit the test application.' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'browser-call',
                name: 'browser_action',
                arguments: { action: 'click', selector: '#submit' }
              }
            ]
          }
        ],
        step: 0,
        credits: 0,
        turnToolResults: {},
        inFlight: {
          toolCallId: 'browser-call',
          tool: 'browser_action',
          startedAt: '2026-09-16T00:00:00.000Z'
        }
      });
      const probe = probeStore(() => task);
      const log: FetchLog = { calls: [], modelRequests: [] };
      installFetch([textFrame('I will check the receipt page.')], log, {
        route: (url) =>
          url.includes('/browser/receipts/')
            ? new Response(
                JSON.stringify({
                  receipt:
                    status === 'missing'
                      ? null
                      : {
                          requestId: url.split('/').at(-1),
                          status,
                          startedAt: '2026-09-16T00:00:00.000Z',
                          steps: [{ index: 0, type: 'click', status: 'completed' }],
                          ...(status === 'completed'
                            ? {
                                result: {
                                  url: 'https://forms.invalid/receipt',
                                  title: 'Application received',
                                  tabId: 'tab-stable'
                                }
                              }
                            : {})
                        }
                }),
                { headers: { 'content-type': 'application/json' } }
              )
            : undefined
      });
      await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
        .run(task)
        .catch(() => undefined);
      expect(log.calls.filter((url) => url.includes('/browser/receipts/'))).toHaveLength(1);
      expect(log.calls.some((url) => url.endsWith('/browser/action'))).toBe(false);
      const messages = (log.modelRequests[0]?.messages ?? []) as Array<{
        content: string;
        tool_call_id?: string;
      }>;
      const answer = messages.find((message) => message.tool_call_id === 'browser-call');
      expect(answer).toBeDefined();
      if (status === 'completed') {
        expect(answer!.content).toContain('Application received');
        expect(answer!.content).not.toContain('Interrupted:');
        expect(
          probe.events.some((entry) =>
            entry.summary.includes('Recovered the browser action receipt')
          )
        ).toBe(true);
      } else {
        expect(answer!.content).toContain('Interrupted:');
        if (status === 'uncertain') expect(answer!.content).toContain('1 actions acknowledged');
      }
    }
  );

  it('answers calls a mid-batch restart left dangling, so the next request is still valid', async () => {
    const task = makeTask({
      messages: [
        { role: 'user', content: 'Tidy the notes' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-3', name: 'files_list', arguments: {} },
            { id: 'call-4', name: 'file_read', arguments: { path: 'workspace/a.md' } }
          ]
        },
        { role: 'tool', toolCallId: 'call-3', content: '{"entries":[]}' }
      ],
      step: 0,
      credits: 0,
      turnToolResults: {}
    });
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Picking up where that left off.')], log);
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 3 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const messages = (log.modelRequests[0]?.messages ?? []) as Array<{
      content: string;
      tool_call_id?: string;
    }>;
    // A provider rejects any history whose tool_calls block has an unanswered call, so leaving one
    // behind would strand the task rather than resume it.
    expect(messages.find((message) => message.tool_call_id === 'call-4')?.content).toContain(
      'Not executed'
    );
    expect(messages.find((message) => message.tool_call_id === 'call-3')?.content).toContain(
      'entries'
    );
  });
});

describe('the undo point a turn leaves behind', () => {
  const twoToolFrame = (): string =>
    `data: ${JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-a',
                function: { name: 'shell', arguments: JSON.stringify({ executable: 'ls' }) }
              },
              {
                index: 1,
                id: 'call-b',
                function: {
                  name: 'file_write',
                  arguments: JSON.stringify({ path: 'workspace/a.txt', content: 'x' })
                }
              }
            ]
          }
        }
      ]
    })}\n\ndata: [DONE]\n\n`;

  it('checkpoints the computer once, before the first call that could change it', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([twoToolFrame()], log);
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const checkpointCalls = log.calls.filter((call) => call.includes('/checkpoints'));
    expect(checkpointCalls).toHaveLength(1);
    // In front of the work, not behind it: a checkpoint taken after the shell call would hold the
    // state the owner is trying to get away from.
    expect(log.calls.indexOf(checkpointCalls[0]!)).toBeLessThan(
      log.calls.findIndex((call) => call.includes('/exec'))
    );
    expect(probe.undoPoints).toHaveLength(1);
    expect(probe.undoPoints[0]).toMatchObject({
      workspaceId,
      taskId,
      turn: 0,
      mechanism: 'content',
      fileCount: 12,
      storedBytes: 128
    });
  });

  it('costs a turn that only reads nothing at all', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-r', 'files_list', { path: 'workspace' })], log);
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    expect(log.calls.some((call) => call.includes('/checkpoints'))).toBe(false);
    expect(probe.undoPoints).toEqual([]);
  });

  it('forgets the checkpoints the runner pruned in the same breath', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-p', 'shell', { executable: 'ls' })], log, {
      checkpoint: () => checkpointResponse(['old-checkpoint-1', 'old-checkpoint-2'])
    });
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    expect(probe.forgottenUndoPoints).toEqual([['old-checkpoint-1', 'old-checkpoint-2']]);
  });

  /*
   * The join between the scan that knows which files it walked past and the floor that spends the
   * answer. Everything either side of it - the runner's `uncoveredPaths`, the client's collapse to
   * `uncovered`, `undoPointFor`, the location test - was built and proved in isolation, and the
   * whole chain still did nothing, because the one line that records the field on the state was
   * never written. Pinned HERE, at the only writer, rather than beside any of the halves: a test
   * that builds the state by hand cannot tell a wired chain from an unwired one.
   */
  it('carries the files the undo point walked past into the state the floor reads', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-u', 'shell', { executable: 'ls' })], log, {
      checkpoint: () => checkpointResponse([], { uncoveredPaths: ['workspace/model.gguf'] })
    });
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    const state = decryptCheckpoints(probe.checkpoints).find((entry) => entry.checkpoint?.id);
    expect(state?.checkpoint?.uncovered).toEqual(['workspace/model.gguf']);
  });

  it.each([
    // Cut off at the runner's cap, so the list names some of the oversize files and not all of
    // them. Recording it would free a delete of the one it omits.
    ['a list the runner had to cut off', { uncoveredPaths: ['a'], uncoveredPathsTruncated: true }],
    // A runner one release behind this worker sends no list at all, which is not the same fact as
    // a walk that held everything.
    ['a runner that does not send the field', {}]
  ])('records nothing about oversize files for %s', async (_name, oversize) => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-u', 'shell', { executable: 'ls' })], log, {
      checkpoint: () => checkpointResponse([], oversize)
    });
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    const state = decryptCheckpoints(probe.checkpoints).find((entry) => entry.checkpoint?.id);
    // Absent, not empty: empty would tell the floor this walk held everything, and the floor frees
    // a delete on that. Absent keeps the card, which is the direction to fail in.
    expect(state?.checkpoint?.id).toBeTruthy();
    expect(state?.checkpoint).not.toHaveProperty('uncovered');
  });

  it('carries on when the computer cannot be checkpointed, and says so where it shows', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-f', 'shell', { executable: 'ls' })], log, {
      checkpoint: () =>
        new Response(JSON.stringify({ error: { message: 'Host disk is too full' } }), {
          status: 507,
          headers: { 'content-type': 'application/json' }
        })
    });
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    // The work the owner asked for still happens; what they lose is the ability to rewind it, and
    // that has to be visible rather than inferred from a missing entry.
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(true);
    expect(probe.undoPoints).toEqual([]);
    const warning = probe.events.find(
      (entry) => entry.summary === 'This turn has no undo point for the computer'
    );
    expect(warning?.kind).toBe('warning');
    expect(String((warning?.payload as { message?: string })?.message)).toContain('507');
    // A full disk is the one cause of this the owner can clear, so it is raised to them.
    expect((warning?.payload as { owner?: boolean })?.owner).toBe(true);
  });

  it('files the same loss quietly when the reason is not the owner’s to fix', async () => {
    // Measured: writing a two-line haiku put this card at the top of the transcript, above the
    // verse, because the runner could not take a checkpoint. Nothing about that is the owner's
    // business unless they are the one who can clear it.
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-f', 'shell', { executable: 'ls' })], log, {
      checkpoint: () =>
        new Response(JSON.stringify({ error: { message: 'workspace is not its own dataset' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        })
    });

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const warning = probe.events.find(
      (entry) => entry.summary === 'This turn has no undo point for the computer'
    );
    // Still recorded - the work log holds it, and a rewind that is not on offer still has a reason.
    expect(warning?.kind).toBe('warning');
    expect((warning?.payload as { owner?: boolean })?.owner).toBeUndefined();
  });

  /**
   * The other refusal the owner can clear, and the one prose never reached.
   *
   * A workspace over the runner's file ceiling - two `node_modules` trees is enough - loses every
   * automatic undo point from then on. The disk refusal above was already caught by the sentence
   * regex; this one never was, so the rewind dialog told the owner the turn "changed nothing on the
   * computer" about turns that changed a great deal. Nothing in the message says disk, or space, or
   * quota, which is the whole point: prose belongs to whoever is reading it, and this reader is a
   * program.
   *
   * Both halves of that path are under this one test. `AgentRunnerClient.checkpoint` used to be the
   * one runner call that flattened the runner's `{error:{code,message}}` envelope into a sentence
   * of its own instead of going through `runnerFailure`, so the code arrived only as text inside a
   * string; and `OWNER_FIXABLE_CHECKPOINT_CODES` then rejected it even once it was dug back out.
   */
  it('raises an over-ceiling workspace to the owner, in the runner’s own words', async () => {
    const refusal =
      'This workspace holds more than 250000 files, which is more than automatic checkpoints cover. Take a named recovery point instead.';
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-f', 'shell', { executable: 'ls' })], log, {
      checkpoint: () =>
        new Response(
          JSON.stringify({
            error: { code: 'checkpoint_workspace_too_large', message: refusal }
          }),
          { status: 413, headers: { 'content-type': 'application/json' } }
        )
    });

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const warning = probe.events.find(
      (entry) => entry.summary === 'This turn has no undo point for the computer'
    );
    expect(warning?.kind).toBe('warning');
    // Theirs to fix: delete something, or take a named recovery point. Neither happens if nobody
    // is told, and the code is the only thing here that says so - the sentence matches no pattern.
    expect((warning?.payload as { owner?: boolean })?.owner).toBe(true);
    // And what they are shown is the runner's sentence, which names the remedy, rather than this
    // package's own `Checkpoint failed (413): {"error":{…}}` wrapped around a JSON blob.
    expect((warning?.payload as { message?: string })?.message).toBe(refusal);
  });
});

describe('what actually reaches the provider', () => {
  const firstRequest = async (
    agentState?: unknown
  ): Promise<{ request: Record<string, unknown>; systemText: string }> => {
    const task = makeTask(agentState);
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('thinking')], log);
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);
    await worker.run(task).catch(() => undefined);
    const request = log.modelRequests[0] ?? {};
    const messages = (request.messages ?? []) as Array<{ role: string; content: string }>;
    return {
      request,
      systemText: messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n')
    };
  };

  it('offers a compact core and a discovery path without guessing capabilities from prompt keywords', async () => {
    const { request } = await firstRequest();
    const tools = (request.tools ?? []) as Array<{
      function?: { name?: string; description?: string };
    }>;
    const names = tools.map((tool) => tool.function?.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual(
      expect.arrayContaining([
        'load_tools',
        'compact_context',
        'web_search',
        'memory_recall',
        'file_read',
        'file_patch',
        'shell',
        'process',
        'notify',
        'ask'
      ])
    );
    for (const group of [
      'code',
      'documents',
      'browser',
      'desktop',
      'media',
      'publishing',
      'connections'
    ])
      expect(
        tools.find((tool) => tool.function?.name === 'load_tools')?.function?.description
      ).toContain(group);
    for (const deferred of [
      'document_read',
      'image_read',
      'audio_read',
      'browser_snapshot',
      'generate_media',
      'project_update',
      'connector_action',
      'connector_list'
    ])
      expect(names).not.toContain(deferred);
  });

  it('describes only the connector actions the box can actually run', async () => {
    /*
     * The gate proved where it is paid for, not where it is written.
     *
     * `tool-catalogue.test.ts` proves `agentToolsFor` narrows the enum when it is told which kinds
     * are connected. That is a different claim from the one that matters, and this programme has
     * shipped the gap twice: a gate nothing passes an argument to is a function with a unit test.
     * So this reads the request that really left the process, on a box whose only connection is a
     * mailbox, and asserts the eleven actions `executeConnectorAction` would refuse for it are not
     * on the wire while all eight it would run are.
     */
    const withConnectors = async (
      connectors: Array<{ kind: string; enabled: boolean }>
    ): Promise<
      Array<{
        function?: {
          name?: string;
          parameters?: { properties?: { action?: { enum?: string[] } } };
        };
      }>
    > => {
      const task = makeTask();
      const probe = probeStore(() => task);
      const log: FetchLog = { calls: [], modelRequests: [] };
      installFetch(
        [
          toolFrame('load-connections', 'load_tools', { groups: ['connections'] }),
          textFrame('thinking')
        ],
        log
      );
      const store = {
        ...probe.store,
        listConnectors: async () =>
          connectors.map((connector, at) => ({
            id: `c${at}`,
            label: connector.kind,
            scopes: [],
            ...connector
          }))
      } as unknown as DataStore;
      await new AgentWorker(store, config(), masterKey, runnerSecret)
        .run(task)
        .catch(() => undefined);
      expect(
        (log.modelRequests[0]?.tools as Array<{ function: { name: string } }>).some(
          (tool) => tool.function.name === 'connector_action'
        )
      ).toBe(false);
      return (log.modelRequests[1]?.tools ?? []) as Array<{ function?: { name?: string } }>;
    };
    const tools = await withConnectors([
      { kind: 'imap', enabled: true },
      // Disabled, so it must not widen anything: the withdrawal above counts enabled connectors
      // and so must this.
      { kind: 'github', enabled: false }
    ]);
    const connector = tools.find((tool) => tool.function?.name === 'connector_action');
    // Present, because a mailbox IS connected - the all-or-nothing withdrawal above does not fire.
    expect(connector).toBeTruthy();
    expect(connector?.function?.parameters?.properties?.action?.enum).toEqual([
      'mail_list_mailboxes',
      'mail_search',
      'mail_read_message',
      'mail_read_attachment',
      'mail_mark',
      'mail_draft',
      'mail_send',
      'mail_reply'
    ]);
    // Named rather than counted, because the point is which actions are unavailable. Each is
    // refused by `executeConnectorAction` on a connector of kind `imap` before it reads a scope.
    const wire = JSON.stringify(connector);
    for (const gone of ['github_read_file', 'webdav_write', 'mcp_call_tool', 'calendar_list'])
      expect(wire, gone).not.toContain(gone);
    // And the saving is real on the request that left the process, measured against the same run
    // on a box that has connected all five kinds - which is the only comparison that isolates this
    // gate, because a box with nothing connected loses the whole tool to the withdrawal above.
    // The catalogue test owns the measured request budget.
    const connectedKinds = ['imap', 'caldav', 'github', 'webdav', 'mcp_http'];
    const everything = await withConnectors(
      connectedKinds.map((kind) => ({ kind, enabled: true }))
    );
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(everything)) - 2_400
    );
    // The other direction, and the one that fails quietly: a box that has connected everything is
    // sent everything. Nothing here is a capability withdrawal.
    const supported = Object.entries(connectorActions)
      .filter(([, action]) => action.kinds.some((kind) => connectedKinds.includes(kind)))
      .map(([name]) => name);
    expect(supported.length).toBeGreaterThan(0);
    expect(
      everything.find((tool) => tool.function?.name === 'connector_action')?.function?.parameters
        ?.properties?.action?.enum
    ).toEqual(supported);
  });

  it('puts the built-in skill library in front of the model', async () => {
    // Nineteen vetted skills were loadable, indexable and openable, and none of it had ever
    // reached a model - while the preamble told the model to consult that index.
    const { systemText } = await firstRequest();
    expect(systemText).toContain('Built-in skills (index only');
    expect(systemText).toContain('pdf-extraction:');
    expect(systemText).toContain('skill(action=view,id=...)');
  });

  it('tells the model what day it is, in the owner’s time zone', async () => {
    const { systemText } = await firstRequest();
    expect(systemText).toMatch(/- Current time: \w+ \d+ \w+ \d{4}, \d\d:\d\d in Europe\/London/);
    expect(systemText).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\dZ/);
  });

  it('carries exactly one operating contract, even from a window that had two', async () => {
    const doubled = {
      messages: [
        { role: 'system', content: 'You operate a persistent, private Linux cloud computer. Old.' },
        { role: 'system', content: 'You operate a persistent, private Linux cloud computer. Old.' },
        { role: 'user', content: 'Tidy the notes' }
      ],
      step: 0,
      credits: 0,
      turnToolResults: {}
    };
    const { systemText } = await firstRequest(doubled);
    expect(systemText.split(BASE_PROMPT_MARKER)).toHaveLength(2);
  });

  it('does not open with a plan the request never needed', async () => {
    // The generic three-step plan used to be published before the first model call on every task.
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('A haiku, then.')], log);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    expect(probe.events.filter((event) => event.kind === 'plan')).toEqual([]);
  });

  it('prices the opening step at full reasoning effort', async () => {
    const { request } = await firstRequest();
    expect(request.reasoning_effort).toBe('high');
  });
});

describe('what a delegated specialist is sent', () => {
  const specialistRequest = async (): Promise<Record<string, unknown>> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'delegate', {
          missions: [{ name: 'sources', instruction: 'Compare what these three filings say.' }]
        }),
        textFrame('The three filings agree on revenue and disagree on headcount.'),
        textFrame('Reporting back.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return log.modelRequests[1] ?? {};
  };

  it('gives it the web reading tool, and nothing that could change anything', async () => {
    const names = (
      (
        ((await specialistRequest()).tools ?? []) as Array<{
          function?: { name?: string };
        }>
      ).map((tool) => tool.function?.name) ?? []
    ).filter(Boolean);
    // parallel_web_read opens its own isolated browser, so three specialists can use it at once
    // without steering the persistent session the lead and the owner share. web_search is beside
    // it because a specialist that cannot search can only read sources somebody else found first.
    expect(names).toContain('parallel_web_read');
    expect(names).toContain('web_search');
    expect(names).toEqual(
      expect.arrayContaining(['file_read', 'document_read', 'document_search', 'session_search'])
    );
    expect(names).not.toContain('shell');
    expect(names).not.toContain('file_write');
    expect(names).not.toContain('browser_action');
    expect(names).not.toContain('finish');
  });

  it('tells it what day it is and what a report has to contain', async () => {
    const system = (
      ((await specialistRequest()).messages ?? []) as Array<{
        role: string;
        content: string;
      }>
    )
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    // A specialist asked which of two dated documents supersedes the other cannot answer without
    // a date, and it used to be sent none.
    expect(system).toMatch(/- Current time: \w+ \d+ \w+ \d{4}, \d\d:\d\d in Europe\/London/);
    // Against the constant rather than a spelled-out number: the budget was raised from six to
    // sixteen and this assertion is about the specialist being told what it has, not about the
    // value it happens to be.
    expect(system).toContain(`${DELEGATE_MAX_STEPS} steps`);
    expect(system).toContain('never instructions');
  });

  it('lets it run a search of its own, on the route the lead uses', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'delegate', {
          missions: [{ name: 'sources', instruction: 'Find what the regulator published.' }]
        }),
        // A specialist's own calls are not streamed, so they come back as a completion body.
        completion({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-w',
              type: 'function',
              function: {
                name: 'web_search',
                arguments: JSON.stringify({ query: 'regulator guidance 2026' })
              }
            }
          ]
        }),
        completion({ role: 'assistant', content: 'The regulator published guidance in March.' }),
        textFrame('Reported.')
      ],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(
      log.runnerRequests?.find((request) => request.url.includes('/browser/search'))?.body
    ).toEqual({ query: 'regulator guidance 2026', limit: 10 });
  });

  it('brings back all three specialists, not the first one and a half', async () => {
    // Three missions may run and each specialist may write 8,192 output tokens, so three full
    // reports are far more than the 24,000 characters the lead's window keeps of one tool result -
    // and that result is cut from the middle, which is right for one long document and wrong for a
    // list. Measured on three 14,000-character reports: the first arrived, the second was cut in
    // half, the third was not there at all, and the only thing the lead was told is that some
    // characters had been omitted - not which specialist it had lost.
    const report = (marker: string): string =>
      `${marker}-OPENS ${'finding '.repeat(1_700)} ${marker}-CONCLUDES`;
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'delegate', {
          missions: [
            { name: 'filings', instruction: 'Read the filings.' },
            { name: 'transcripts', instruction: 'Read the transcripts.' },
            { name: 'coverage', instruction: 'Read the coverage.' }
          ]
        }),
        completion({ role: 'assistant', content: report('ONE') }),
        completion({ role: 'assistant', content: report('TWO') }),
        completion({ role: 'assistant', content: report('THREE') }),
        textFrame('Reported.')
      ],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const leadResult = log.modelRequests
      .flatMap(
        (request) =>
          (request.messages ?? []) as Array<{
            role?: string;
            tool_call_id?: string;
            content?: string;
          }>
      )
      .find((message) => message.role === 'tool' && message.tool_call_id === 'call-1');
    for (const marker of ['ONE', 'TWO', 'THREE']) {
      expect(leadResult?.content).toContain(`${marker}-OPENS`);
      expect(leadResult?.content).toContain(`${marker}-CONCLUDES`);
    }
  });

  /**
   * The specialist's reads are the lead's reads.
   *
   * A specialist runs its tools through the same executor as the lead but never through the lead's
   * provenance step, so the whole delegate path used to be a way around the taint model: a mission
   * that read attacker-controlled pages returned their contents, restated by a model, into a window
   * the approval floor still believed had read nothing external.
   */
  it('taints the lead with what the specialist read, and raises the floor while it holds', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'delegate', {
          missions: [{ name: 'sources', instruction: 'Read what the vendor published.' }]
        }),
        completion({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-w',
              type: 'function',
              function: {
                name: 'web_search',
                arguments: JSON.stringify({ query: 'vendor pricing' })
              }
            }
          ]
        }),
        completion({ role: 'assistant', content: '{"answer":"The vendor lists three tiers."}' }),
        textFrame('Reported.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/browser/search')
            ? jsonResponse({
                results: [
                  {
                    url: 'https://vendor.test/pricing',
                    title: 'Pricing',
                    snippet: 'Three tiers.'
                  }
                ]
              })
            : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // The lead's own next request is where the notice has to land: it is attached to the tool
    // result that introduced the content, because a bare system message between an assistant's
    // tool call and its result is the one shape providers reject.
    const leadResult = log.modelRequests
      .flatMap(
        (request) =>
          (request.messages ?? []) as Array<{
            role?: string;
            tool_call_id?: string;
            content?: string;
          }>
      )
      .find((message) => message.role === 'tool' && message.tool_call_id === 'call-1');
    expect(leadResult?.content).toContain(UNTRUSTED_NOTICE_MARKER);
    expect(leadResult?.content).toContain('delegated specialist');
    expect(leadResult?.content).toContain('web search results');

    // And it is written down for the owner. A repeat origin across tasks is the strongest residual
    // attack against this design, and it is only visible if every transition is recorded.
    const transition = probe.events.find(
      (entry) => entry.kind === 'warning' && entry.summary.startsWith('Untrusted content entered')
    );
    expect(transition?.summary).toContain('delegated specialist');
    expect((transition?.payload as { taint?: { level?: string } } | undefined)?.taint?.level).toBe(
      'untrusted'
    );
  });
});

/**
 * The provider key, and which account's row is allowed to open it.
 *
 * The GCM tag proves the ciphertext and the AAD stored beside it were produced together; it does
 * not prove that AAD is the one the caller meant, so a row moved from one account to another
 * decrypts perfectly well unless somebody compares. The settings endpoint has always compared. The
 * worker - the side that actually spends the key - did not.
 */
describe('opening the stored inference credential', () => {
  const credentialRow = (aad: string | undefined) =>
    ({
      provider: 'inference',
      status: 'active',
      secretCiphertext: encryptJson(
        {
          provider: 'openai-compatible',
          baseUrl: PROVIDER_URL,
          apiKey: 'stored-key',
          enforceZeroDataRetention: false
        },
        masterKey,
        aad
      )
    }) as unknown as Awaited<ReturnType<DataStore['getManagedProviderCredential']>>;

  const runWithCredential = async (aad: string | undefined): Promise<FetchLog> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const store = {
      ...probe.store,
      listManagedProviderCredentials: async () => [credentialRow(aad)]
    } as unknown as DataStore;
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('thinking')], log);
    await new AgentWorker(store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return log;
  };

  it('spends a key sealed for this account', async () => {
    const log = await runWithCredential(`inference-provider:${userId}`);
    expect(log.modelRequests.length).toBeGreaterThan(0);
  });

  it('refuses one sealed for a different account rather than spending it', async () => {
    const other = '99999999-9999-4999-8999-999999999999';
    // Nothing reaches the provider at all: the run fails before the first request rather than
    // authenticating with a key this account was never meant to hold.
    expect((await runWithCredential(`inference-provider:${other}`)).modelRequests).toHaveLength(0);
  });

  it('still opens a row written before the binding existed', async () => {
    // Stripping the field off an envelope that was written with one makes the tag fail, so the only
    // envelopes reaching this branch are ones whose context was never recorded anywhere.
    expect((await runWithCredential(undefined)).modelRequests.length).toBeGreaterThan(0);
  });
});

/**
 * The read path's second half.
 *
 * The memory pack is chosen once from the opening request and frozen so the cached prefix survives
 * the task. Everything a task turned out to need and did not open with was unreachable: the store
 * could be read at task start and never asked a question again, however relevant its contents.
 */
describe('asking memory a question mid-task', () => {
  const memoryDocument = (title: string, body: string) =>
    encryptJson({ title, body, tags: ['ops'] }, dataKey, `memory-item:${workspaceId}`);

  it('answers from the store and leaves out what the frozen pack already printed', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const uses: Array<{ itemIds: string[] }> = [];
    const recallInputs: Array<Record<string, unknown>> = [];
    const store = {
      ...probe.store,
      // A pack this task already holds, so the run reuses its bytes rather than re-ranking - and
      // so the recall below has something to exclude.
      getMemoryPack: async () => ({
        taskId,
        workspaceId,
        briefVersion: null,
        bodyCiphertext: encryptJson({ body: 'PACKED' }, dataKey, `memory-pack:${taskId}`),
        sha256: 'pack-sha',
        itemIds: ['mem-packed'],
        tokensEst: 10,
        createdAt: '2026-07-01T00:00:00.000Z'
      }),
      recallMemoryCandidates: async (input: Record<string, unknown>) => {
        recallInputs.push(input);
        return [
          {
            id: 'mem-new',
            layer: 'item' as const,
            kind: 'fact' as const,
            trust: 'stated' as const,
            status: 'active' as const,
            observedAt: '2026-06-01T00:00:00.000Z',
            validFrom: '2026-06-01T00:00:00.000Z',
            validTo: null,
            subjectKey: null,
            predicate: null,
            tokensEst: 8,
            score: 0.9,
            documentCiphertext: memoryDocument('WAL archive', 'Backups land on the NAS at 02:00.')
          }
        ];
      },
      recordMemoryUse: async (input: { itemIds: string[] }) => {
        uses.push(input);
      }
    } as unknown as DataStore;
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'memory_recall', {
          query: 'where do the backups land',
          kinds: ['fact'],
          maxItems: 5
        }),
        textFrame('On the NAS at 02:00.')
      ],
      log
    );

    await new AgentWorker(store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const result = log.modelRequests
      .flatMap(
        (request) =>
          (request.messages ?? []) as Array<{
            role?: string;
            tool_call_id?: string;
            content?: string;
          }>
      )
      .find((message) => message.role === 'tool' && message.tool_call_id === 'call-1');
    expect(result?.content).toContain('Backups land on the NAS at 02:00.');
    // Told what it deliberately did not return, so an empty answer reads as "nothing further"
    // rather than "nothing at all" and the agent does not ask again in different words.
    expect(result?.content).toContain('mem-packed');
    // The recall itself: relevance order rather than the pack's byte-stable order, and the ids the
    // pack already printed excluded before any channel spends a slot on them.
    const asked = recallInputs.at(-1);
    expect(asked?.order).toBe('relevance');
    expect(asked?.excludeIds).toEqual(['mem-packed']);
    expect(asked?.kinds).toEqual(['fact']);
    // A row the agent went looking for and received is a row that was used, which is what salience
    // is computed from. Whether it helped is settled later; claiming it here would grade every
    // recall a success at the moment it was made.
    expect(uses.at(-1)?.itemIds).toEqual(['mem-new']);
  });
});

/**
 * Where this run's searches go, and what the model is therefore holding.
 *
 * The decision belongs to `resolveWebToolPlan` in @garden/contracts and to nothing else, so these
 * exercise the wiring rather than the verdict: that the worker asks once per run, offers the model
 * the same tools whichever answer it got, spends the provider's search only when the model calls
 * `web_search`, and never lets a mid-run credential edit move a task onto a route the owner was not
 * asked about.
 */
describe('the web route a run is pinned to', () => {
  const toolNames = (request: Record<string, unknown> | undefined): string[] =>
    ((request?.tools ?? []) as Array<{ type?: string; function?: { name?: string } }>)
      .map((tool) => tool.function?.name ?? tool.type)
      .filter((name): name is string => Boolean(name));

  /** An OpenRouter deployment with retention allowed, which is the only route that reaches server. */
  const serverConfig = config({
    AI_PROVIDER: 'openrouter',
    AI_REQUIRE_ZDR: false,
    AI_FORCE_INHOUSE_WEB: false,
    TASK_MAX_STEPS: 1
  });
  const openrouterModel: ModelRelease = { ...model, provider: 'openrouter' };
  const standardTask = (agentState?: unknown): TaskRecord => ({
    ...makeTask(agentState),
    privacyRoute: 'external'
  });

  const runOnce = async (
    task: TaskRecord,
    workerConfig: Omit<WorkerConfig, 'WORKER_HEALTH_PORT' | 'WORKER_HEALTH_HOST'>,
    catalog: ModelRelease[],
    /** One body, or a script of them: a search spends a provider call of its own between steps. */
    body: string | string[] = textFrame('thinking')
  ): Promise<{ log: FetchLog; probe: StoreProbe }> => {
    const probe = probeStore(() => task);
    const store = { ...probe.store, listModels: async () => catalog } as unknown as DataStore;
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(Array.isArray(body) ? body : [body], log);
    await new AgentWorker(store, workerConfig, masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return { log, probe };
  };

  it.each(['absent', 'available', 'disabled', 'unavailable', 'stale'] as const)(
    'completes ordinary work with identical main-model capability when decisions are %s',
    async (mode) => {
      const task = standardTask();
      const probe = probeStore(() => task);
      const decisionModel: ModelRelease = {
        ...openrouterModel,
        id: 'decision-model',
        providerModelId: 'typesafe/jev-fixture',
        displayName: 'Fast decision fixture',
        privacyRoute: 'external',
        capabilities: ['decisions'],
        providerAvailable: mode !== 'unavailable',
        inputUsdPerMillionTokens: 0.042,
        outputUsdPerMillionTokens: 0
      };
      const log: FetchLog = { calls: [], modelRequests: [] };
      const store = {
        ...probe.store,
        listModels: async () =>
          mode === 'absent' ? [openrouterModel] : [openrouterModel, decisionModel],
        getUserById: async () => ({ preferences: { decisionModelsEnabled: mode !== 'disabled' } })
      } as unknown as DataStore;
      installFetch(
        [
          ...(mode === 'stale' ? [toolFrame('old-decision', 'decide', {})] : []),
          toolFrame('load-code', 'load_tools', { groups: ['code'] }),
          toolFrame('read-note', 'file_read', { path: 'workspace/notes.txt' }),
          toolFrame('finish-note', 'finish', {
            summary: 'The note was read and the coding tools are ready.',
            answer: 'The note says: The coding work starts from this note.',
            verification: {
              status: 'verified',
              evidence: [{ claim: 'Read the note', source: 'tool_result', toolCallId: 'read-note' }]
            }
          })
        ],
        log,
        {
          route: (url) =>
            url.includes('/file?')
              ? new Response(
                  JSON.stringify({ content: 'The coding work starts from this note.' }),
                  { headers: { 'content-type': 'application/json' } }
                )
              : undefined
        }
      );
      await new AgentWorker(
        store,
        config({ ...serverConfig, TASK_MAX_STEPS: 8 }),
        masterKey,
        runnerSecret
      ).run(task);
      expect(log.modelRequests, JSON.stringify(probe.events)).toHaveLength(
        mode === 'stale' ? 4 : 3
      );
      expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(true);
      expect(probe.events.some((entry) => entry.kind === 'approval_requested')).toBe(false);
      expect(toolNames(log.modelRequests[mode === 'stale' ? 2 : 1])).toContain('code_search');
      if (mode === 'stale')
        expect(JSON.stringify(log.modelRequests[1]?.messages)).toContain(
          'Decision workflows are inactive. Complete this work with the main model.'
        );
      for (const request of log.modelRequests) {
        expect(request.model).toBe(openrouterModel.providerModelId);
        expect(toolNames(request)).toContain('file_read');
        expect(toolNames(request)).not.toContain('decide');
        expect(JSON.stringify(request)).not.toContain('Fast decision fixture');
        expect(JSON.stringify(request)).not.toContain('typesafe/jev-fixture');
      }
    }
  );

  /*
   * A brake that cannot answer stops the car.
   *
   * The guard's result used to be `.catch(() => null)`, and null meant "do not halt" - so one
   * transient database error removed the owner's daily ceiling for that step, silently, with
   * nothing written anywhere. The cap exists so an unattended overnight run cannot get away from
   * somebody who is asleep, and the only thing underneath it sits far above where anyone sets a
   * daily limit.
   */
  it('stops rather than spend when the spending guard cannot answer', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const updates: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      spendGuard: async () => {
        throw new Error('database is not accepting connections');
      },
      updateTask: async (input: Record<string, unknown>) => {
        updates.push(input);
        return task;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('should never be asked for')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // Nothing was bought.
    expect(log.modelRequests).toHaveLength(0);
    // And the owner is told why, in a state a reply can resume.
    expect(updates.some((update) => update.status === 'paused')).toBe(true);
    const stated = probe.events.find(
      (entry) =>
        (entry.payload as { blockedBy?: string } | undefined)?.blockedBy ===
        'spend_guard_unavailable'
    );
    expect(stated?.summary).toContain('could not check this against your spending caps');
    // The column that separates a pause the ceiling imposed from one the owner asked for. Every
    // consumer of the `spend_paused` notification reads it and neither of the two writes that
    // should set it ever did, so the whole kind - its query, its Settings switch, its notice - was
    // reachable by nothing.
    expect(updates.find((update) => update.status === 'paused')?.spendPausedAt).toBeInstanceOf(
      Date
    );
  });

  it('marks the pause a spending pause when a ceiling is what stopped it, and says it once', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const updates: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      spendGuard: async () => ({
        outcome: 'deny' as const,
        estimateUsd: 0.01,
        blockedBy: 'daily' as const,
        warnedBy: [],
        reason: null,
        windows: [
          {
            name: 'daily' as const,
            spentUsd: 5,
            pendingUsd: 0,
            capUsd: 5,
            warnAtUsd: 4,
            projectedUsd: 5.01,
            state: 'exceeded' as const,
            startsAt: '2026-07-01T00:00:00.000Z',
            endsAt: '2026-07-02T00:00:00.000Z'
          }
        ]
      }),
      claimSpendAlert: async () => true,
      updateTask: async (input: Record<string, unknown>) => {
        updates.push(input);
        return task;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('should never be asked for')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(log.modelRequests).toHaveLength(0);
    expect(updates.find((update) => update.status === 'paused')?.spendPausedAt).toBeInstanceOf(
      Date
    );
    /*
     * And exactly one notification, of the kind the pause actually is.
     *
     * The halt raises `spend_paused`, which has its own switch in Settings. Raising an
     * `agent_message` beside it for the same event made both switches lie: turning agent messages
     * off silenced spend-cap alerts, and the spending switch governed nothing the owner could see.
     */
    expect(probe.notifications.filter((entry) => entry.kind === 'agent_message')).toHaveLength(0);
  });

  it('keeps the whole web in house on an endpoint with no search service to offer', async () => {
    // Not a privacy refusal - a capability one. Sending a provider tool name to an endpoint that
    // has never heard of it is a request that fails, so an unrecognised endpoint arrives refused.
    const { log } = await runOnce(makeTask(), config({ TASK_MAX_STEPS: 1 }), [model]);
    const request = log.modelRequests[0];
    expect(toolNames(request)).toEqual(expect.arrayContaining(['web_search', 'load_tools']));
    expect(toolNames(request)).not.toContain('openrouter:web_search');
  });

  /**
   * The box this wave was written for.
   *
   * A credential that enforces zero data retention is the shipped default, and it used to take
   * provider-side search off the run - which on a server is the only search that works, because a
   * datacenter address is answered with an anti-bot challenge instead of results. The owner was
   * never offered that trade and it bought nothing: the retention promise covers inference routing
   * and says in terms that it does not cover tools, so the query sat outside it either way.
   *
   * What the run is held to instead is the disclosure, and both halves are asserted here - the
   * provider block that keeps the inference request zero-retention, and the sentence telling the
   * model its queries now leave this computer.
   */
  it('searches on the provider from a zero-retention box, and tells the run that it does', async () => {
    const { log, probe } = await runOnce(
      standardTask(),
      config({ AI_PROVIDER: 'openrouter', AI_REQUIRE_ZDR: true, TASK_MAX_STEPS: 1 }),
      [openrouterModel]
    );
    expect(toolNames(log.modelRequests[0])).toContain('web_search');
    expect(
      probe.events.find((entry) => entry.summary.includes("model provider's search service"))
    ).toBeDefined();
  });

  /**
   * The failure this whole arrangement was rebuilt to stop.
   *
   * The provider's search has no `function.name`, so no model can call it; it used to be sent in the
   * agent's own tools array with `web_search` withdrawn to make room. The model was told by its
   * operating contract to start research with a search, went looking for the search tool, and found
   * neither it nor any name for what had replaced it - so asked for three notable projects with
   * sources, it made no tool call at all and answered from memory with fabricated names, fabricated
   * dates and fabricated addresses.
   */
  it('offers the model the same catalogue on the provider route, and no tool it cannot call', async () => {
    const { log, probe } = await runOnce(standardTask(), serverConfig, [openrouterModel]);
    const names = toolNames(log.modelRequests[0]);
    // The two tools the four cross-referencing descriptions send the model to, present under the
    // names those descriptions use.
    expect(names).toContain('web_search');
    expect(names).toContain('load_tools');
    // And nothing the model has no way to invoke. A provider-side tool on this request would be a
    // second answerer for a question the model can already ask.
    expect(names).not.toContain('openrouter:web_search');
    expect(names).not.toContain('openrouter:web_fetch');
    expect(names).not.toContain('browser_action');
    expect(names).not.toContain('browser_snapshot');
    // The owner is told, in one sentence, where their queries now go.
    expect(
      probe.events.find((entry) => entry.summary.includes("model provider's search service"))
    ).toBeDefined();
    // So is the model. The operating contract is a byte-stable constant and cannot vary with the
    // route, so the runtime block is where a run learns that its queries now leave the computer.
    const systemText = (
      (log.modelRequests[0]?.messages ?? []) as Array<{ role: string; content: string }>
    )
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).toContain('answered by your model provider, which sees the query');
  });

  /**
   * The rule the fabricated answer broke, checked against the catalogue as it actually goes out.
   *
   * The descriptions are the only map the model has of this computer and they cross-reference
   * constantly - "hand the promising URLs to parallel_web_read", "use web_search to find that
   * address", "each specialist gets web_search and parallel_web_read". `tools.test.ts` already holds
   * every one of those names to something declared. What it cannot see is a run that then removes
   * the tool: four descriptions went on pointing at `web_search` and `parallel_web_read` after the
   * provider route withdrew them, and a model that trusts its own catalogue looked for a tool that
   * was not there and answered from memory instead.
   *
   * `connector_action` is the one name allowed to dangle, and only because what is missing there is
   * the capability itself rather than the tool - nothing is connected, every call would fail, and
   * `connector_list` names it in the course of being the call that says so.
   */
  it('keeps every referenced tool resident or explicitly discoverable', async () => {
    const { log } = await runOnce(standardTask(), serverConfig, [openrouterModel]);
    const sent = new Set(toolNames(log.modelRequests[0]));
    const declared = new Set(agentTools.map((tool) => tool.name));
    expect(sent.has('load_tools')).toBe(true);
    const discoverable = new Set<string>(
      Object.entries(TOOL_GROUPS)
        .filter(([group]) => group !== 'connections')
        .flatMap(([, tools]) => [...tools])
    );
    for (const tool of agentTools)
      if (sent.has(tool.name))
        for (const token of tool.description.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? [])
          if (declared.has(token) && token !== 'connector_action')
            expect(
              sent.has(token) || discoverable.has(token),
              `${tool.name} references ${token}, which is neither resident nor discoverable`
            ).toBe(true);
    expect(sent.has('connector_action')).toBe(false);
  });

  /** What the model was handed back for its last tool call, which is where a search result lands. */
  const lastToolResult = (request: Record<string, unknown> | undefined): string =>
    ((request?.messages ?? []) as Array<{ role: string; content: string }>)
      .filter((message) => message.role === 'tool')
      .map((message) => message.content)
      .at(-1) ?? '';

  /** A provider response to the search request garden builds, with the sources it retrieved. */
  const searched = (
    citations: Array<{ url: string; title?: string; content?: string }>,
    requests = 1
  ): string =>
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: citations.map((citation) => `${citation.title} ${citation.url}`).join('\n'),
            annotations: citations.map((citation) => ({
              type: 'url_citation',
              url_citation: citation
            }))
          }
        }
      ],
      usage: {
        prompt_tokens: 90,
        completion_tokens: 40,
        total_tokens: 130,
        server_tool_use: { web_search_requests: requests }
      }
    });

  it('answers a web_search call by spending the provider’s search on a request built for it', async () => {
    const { log } = await runOnce(
      standardTask(),
      config({ ...serverConfig, TASK_MAX_STEPS: 2 }),
      [openrouterModel],
      toolFrame('call-search', 'web_search', { query: 'agent frameworks released in 2026' })
    );
    // Three provider calls for one search: the step that asked, the search itself, the step that
    // reads it. The middle one is the whole mechanism - a provider-side tool can only be spent by a
    // request whose purpose is to spend it.
    const search = log.modelRequests[1] ?? {};
    expect(((search.tools ?? []) as Array<{ type?: string }>).map((tool) => tool.type)).toEqual([
      'openrouter:web_search'
    ]);
    // No function tools beside it. The gateway refuses this outright, so a regression here is a
    // failed run rather than a model quietly choosing between two answerers.
    expect(toolNames(search)).toEqual(['openrouter:web_search']);
    const asked = ((search.messages ?? []) as Array<{ role: string; content: string }>)
      .map((message) => message.content)
      .join('\n');
    expect(asked).toContain('agent frameworks released in 2026');
    // The query and nothing else. The conversation, the workspace and the user's own words stay on
    // this computer; what leaves it is what the disclosure says leaves it.
    expect(asked).not.toContain('Tidy the notes');
  });

  it('hands the search back as ranked rows and taints the turn with what it read', async () => {
    const { log, probe } = await runOnce(
      standardTask(),
      config({ ...serverConfig, TASK_MAX_STEPS: 2 }),
      [openrouterModel],
      [
        toolFrame('call-search', 'web_search', { query: 'rate decision' }),
        searched([
          { url: 'https://regulator.example/notice', title: 'Notice', content: 'Held at 4.25.' },
          { url: 'https://press.example/story', title: 'Story', content: 'Rates unchanged.' }
        ]),
        textFrame('Two sources say the rate held.')
      ]
    );
    const result = lastToolResult(log.modelRequests[2]);
    // The same shape the in-house search returns, because the model was given one description of
    // what a search returns and both routes have to keep it.
    expect(result).toContain('"rank":1');
    expect(result).toContain('https://regulator.example/notice');
    expect(result).toContain('"site":"press.example"');
    expect(result).toContain('Held at 4.25.');
    // A search is a read of pages nobody on this computer chose, so the floor rises exactly as it
    // does for an in-house search - the route may change who fetched, never what it counts as.
    const transition = probe.events.find(
      (entry) => entry.kind === 'warning' && entry.summary.startsWith('Untrusted content entered')
    );
    expect(transition?.summary).toContain('web search results');
    expect((transition?.payload as { tool?: string } | undefined)?.tool).toBe('web_search');
  });

  it('refuses to pass off a provider that never searched as a web with nothing on the subject', async () => {
    // The failure mode this route exists to remove, arriving one level down. A response with no
    // sources and no search spent is the provider answering from the model's memory; handing that
    // back as an empty result list would let the agent report "nothing found" about a search that
    // never happened, which is how the original fabrication looked from inside the model.
    const { log } = await runOnce(
      standardTask(),
      config({ ...serverConfig, TASK_MAX_STEPS: 2 }),
      [openrouterModel],
      [
        toolFrame('call-search', 'web_search', { query: 'rate decision' }),
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'I already know this.' } }],
          usage: { prompt_tokens: 90, completion_tokens: 5, total_tokens: 95 }
        }),
        textFrame('The search did not run.')
      ]
    );
    const result = lastToolResult(log.modelRequests[2]);
    expect(result).toContain('did not run a search');
    expect(result).toContain('not evidence that nothing exists');
  });

  it('keeps a run whose deployment forced the in-house route off the provider entirely', async () => {
    // The one switch that restores the old behaviour, asserted where it matters: not merely that no
    // provider tool is offered, but that a search actually goes to the runner instead.
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    const probe = probeStore(() => standardTask());
    const store = {
      ...probe.store,
      listModels: async () => [openrouterModel]
    } as unknown as DataStore;
    installFetch(
      [toolFrame('call-search', 'web_search', { query: 'rate decision' }), textFrame('Done.')],
      log
    );
    await new AgentWorker(
      store,
      config({ ...serverConfig, AI_FORCE_INHOUSE_WEB: true, TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(standardTask())
      .catch(() => undefined);

    expect(log.calls.some((call) => call.includes('/browser/search'))).toBe(true);
    for (const request of log.modelRequests)
      expect(toolNames(request)).not.toContain('openrouter:web_search');
  });

  it('finishes in house when it started in house, however the credential changed underneath', async () => {
    // The one direction that is pinned. Without it, turning zero retention off from the settings
    // page mid-run moves a task that began under the in-house promise onto the provider's search
    // without the owner ever being asked about that task.
    const pinned = standardTask({
      messages: [{ role: 'user', content: 'Tidy the notes' }],
      step: 0,
      credits: 0,
      turnToolResults: {},
      webToolMode: 'in_house'
    });
    const { log } = await runOnce(pinned, serverConfig, [openrouterModel]);
    const names = toolNames(log.modelRequests[0]);
    expect(names).toContain('web_search');
    expect(names).not.toContain('openrouter:web_search');
  });

  it('records the mode it ran under, so the next turn is held to it', async () => {
    const { probe } = await runOnce(standardTask(), serverConfig, [openrouterModel]);
    const modes = probe.checkpoints
      .flatMap((input) =>
        input.agentStateCiphertext
          ? [
              decryptJson<{ webToolMode?: string }>(
                input.agentStateCiphertext as Parameters<typeof decryptJson>[0],
                dataKey
              )
            ]
          : []
      )
      .map((state) => state.webToolMode);
    expect(modes.at(-1)).toBe('server');
  });

  /**
   * The hole a route change would otherwise have opened. On the provider route the search runs on
   * the provider's own infrastructure and its results reach the model inside the response - there
   * is no tool result for `untrustedOriginOfResult` to classify, and the two calls that used to
   * label the web have just been withdrawn from the catalogue.
   */
  it('taints the turn with what the provider fetched, which arrives without a tool result', async () => {
    const cited = `data: ${JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          delta: {
            content: 'The regulator published guidance in March.',
            annotations: [
              {
                type: 'url_citation',
                url_citation: {
                  url: 'https://regulator.example/notice',
                  title: 'Notice',
                  content: 'Guidance was published in March.'
                }
              }
            ]
          }
        }
      ]
    })}\n\ndata: [DONE]\n\n`;
    const { probe } = await runOnce(standardTask(), serverConfig, [openrouterModel], cited);
    const transition = probe.events.find(
      (entry) => entry.kind === 'warning' && entry.summary.startsWith('Untrusted content entered')
    );
    expect(transition?.summary).toContain('regulator.example');
    expect((transition?.payload as { tool?: string } | undefined)?.tool).toBe('provider_web');
  });
});

describe('a turn that runs out of steps', () => {
  it('tells the model the budget is nearly gone before it spends the last of it', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Still working.'), textFrame('Still working.')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const systemText = (
      (log.modelRequests[0]?.messages ?? []) as Array<{
        role: string;
        content: string;
      }>
    )
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).toContain('FINAL STEPS: 2 of this turn');
    expect(systemText).toContain('call finish');
    // Said once. A notice re-pushed every step would move the tail on every request.
    const second = ((log.modelRequests[1]?.messages ?? []) as Array<{ content: string }>).filter(
      (message) => message.content.startsWith('FINAL STEPS')
    );
    expect(second).toHaveLength(1);
  });

  const runToTheCeiling = async (
    handoffBody: string
  ): Promise<{ probe: StoreProbe; log: FetchLog; outcome: string | null }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Still working.'), textFrame('Still working.'), handoffBody], log);
    const outcome = await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .then(() => null)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    return { probe, log, outcome };
  };

  const handoffFinish = toolFrame('call-hand', 'finish', {
    summary: 'Two of five sections are drafted; the rest is outlined in workspace/report.md.',
    deliverables: ['workspace/report.md'],
    verification: { status: 'not_applicable', evidence: [] }
  });

  it('spends its last call on a handoff, on the catalogue every other step sent', async () => {
    const { log } = await runToTheCeiling(handoffFinish);

    // Three provider calls for a two-step budget: the budget bounds the work, and the harness
    // closing the turn is not one of the steps it bounds.
    expect(log.modelRequests).toHaveLength(3);
    const handoff = log.modelRequests[2] ?? {};
    /*
     * The catalogue is the head of the cached prefix, and this is the largest request the turn
     * makes. It used to be sent a two-tool list where the step before it sent forty, so the front
     * of the prompt moved and every byte behind it was re-billed at the write price - to buy
     * nothing, because what stops the model starting new work here is the denial the next test
     * exercises, not the shape of the list.
     */
    expect(JSON.stringify(handoff.tools)).toBe(JSON.stringify(log.modelRequests[1]?.tools));
    expect(
      ((handoff.tools ?? []) as Array<{ function?: { name?: string } }>).map(
        (tool) => tool.function?.name
      )
    ).toEqual(expect.arrayContaining(['set_plan', 'finish', 'shell', 'file_write']));
    const systemText = ((handoff.messages ?? []) as Array<{ role: string; content: string }>)
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).toContain('STEP BUDGET EXHAUSTED after 2 steps');
    expect(systemText).toContain('the exact words they can send back to carry on');
  });

  it('runs nothing but set_plan and finish on the handoff turn, whatever it is asked for', async () => {
    // The restriction the catalogue used to carry, where it has always actually lived: a call that
    // is neither of the two is answered with a denial and never reaches the runner.
    const { log } = await runToTheCeiling(
      toolFrame('call-hand', 'shell', { command: 'echo late', cwd: 'workspace' })
    );

    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
  });

  it('lands somewhere the owner can act on instead of a red failure', async () => {
    const { probe, outcome } = await runToTheCeiling(handoffFinish);

    // Before: throw step_limit_reached, status 'failed', no summary and no statement of where the
    // work got to - on a task the API has always let a reply resume.
    expect(outcome).toBeNull();
    expect(probe.events.some((entry) => entry.kind === 'error')).toBe(false);
    const completed = probe.events.find((entry) => entry.kind === 'completed');
    expect(completed?.summary).toBe('Stopped at the step limit with work outstanding');
    const payload = (completed?.payload ?? {}) as Record<string, unknown>;
    expect(payload.interrupted).toBe(true);
    expect(String(payload.summary)).toContain('Two of five sections');
    expect(payload.deliverables).toEqual(['workspace/report.md']);
    const ceiling = probe.events.find(
      (entry) => entry.kind === 'warning' && entry.summary.includes('whole step budget')
    );
    // Raised to the owner rather than filed: the turn stopped short of what they asked for and
    // only their reply starts it again.
    expect((ceiling?.payload as { owner?: boolean })?.owner).toBe(true);
    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    expect(saved?.messages.at(-1)?.content).toContain('PREVIOUS TURN STOPPED AT ITS STEP LIMIT');
    expect(saved?.messages.at(-1)?.content).toContain('do not restart finished work');
  });

  it('still reports the ceiling honestly when the handoff call itself cannot be made', async () => {
    // A provider outage during the one closing call must not also cost the record of where the
    // work stopped, so the carry-over note is persisted before the error is raised.
    const { probe, outcome } = await runToTheCeiling('data: {"error":{"message":"upstream"}}\n\n');

    expect(outcome).toContain('used all 2 of its steps');
    expect(outcome).toContain('reply to carry on');
    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    expect(saved?.messages.at(-1)?.content).toContain('PREVIOUS TURN STOPPED AT ITS STEP LIMIT');
  });
});

describe('what a finished turn tells memory about itself', () => {
  const packItem = 'aaaaaaaa-0000-4000-8000-000000000001';

  it('files a turn that ran out of steps as interrupted, and grades nothing on it', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    probe.recallPack([packItem]);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        textFrame('Still working.'),
        textFrame('Still working.'),
        toolFrame('call-hand', 'finish', {
          summary: 'Two of five sections are drafted; the rest is outlined in workspace/report.md.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // Before: "Outcome: ok", directly above the same episode's own account of what is unfinished -
    // and an 'ok' written against every item the pack injected, on a turn that proved nothing about
    // any of them. Nothing writes 'fail', so a pack graded on a run that never finished is a number
    // that can only ever go up.
    expect(probe.episodes).toHaveLength(1);
    expect(probe.episodes[0]).toContain('Outcome: interrupted');
    expect(probe.memoryUses).toEqual([]);
  });

  it('still files an ordinary finish as ok, and grades the pack it was given', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    probe.recallPack([packItem]);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'finish', {
          summary: 'The notes were already tidy, so there was nothing to change.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // `not_applicable` is the right status for an answer that needed no tools, which is why the
    // label keys off the interruption and never off the verification status.
    expect(probe.episodes).toHaveLength(1);
    expect(probe.episodes[0]).toContain('Outcome: ok');
    expect(probe.memoryUses).toEqual([{ itemIds: [packItem], outcome: 'ok' }]);
  });
});

describe('deciding to tell the owner something', () => {
  const twoNotices = (): string =>
    `data: ${JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-n1',
                function: {
                  name: 'notify',
                  arguments: JSON.stringify({
                    headline: 'The listing you are watching dropped to £412,000',
                    detail:
                      'It was £430,000 at 09:00. Snapshot saved to workspace/watch/latest.html.'
                  })
                }
              },
              {
                index: 1,
                id: 'call-n2',
                function: { name: 'notify', arguments: JSON.stringify({ headline: '' }) }
              }
            ]
          }
        }
      ]
    })}\n\ndata: [DONE]\n\n`;

  it('writes a durable notice the owner can be told about, and refuses an empty one', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([twoNotices(), textFrame('Told you.')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const notices = probe.events.filter((entry) => entry.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.summary).toBe('The listing you are watching dropped to £412,000');
    const notice = (notices[0]?.payload ?? {}) as Record<string, unknown>;
    expect(notice.headline).toBe('The listing you are watching dropped to £412,000');
    expect(String(notice.detail)).toContain('workspace/watch/latest.html');
    expect(notice.unattended).toBe(false);
    // And the headline alone is queued for the owner's devices, because that is what a lock screen
    // has room for; the detail waits in the conversation the notification opens.
    expect(probe.notifications).toEqual([
      { kind: 'agent_message', message: 'The listing you are watching dropped to £412,000' }
    ]);
    // Nothing reached the workspace, so nothing needed an undo point taken in front of it.
    expect(probe.undoPoints).toHaveLength(0);
    const refusal = decryptCheckpoints(probe.checkpoints)
      .at(-1)
      ?.messages.find((message) => message.toolCallId === 'call-n2');
    expect(refusal?.content).toContain('needs a headline');
  });

  it('stops one turn from becoming a stream', async () => {
    const notice = (id: string): string =>
      toolFrame(id, 'notify', { headline: `Something happened, number ${id}` });
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([notice('a'), notice('b'), notice('c'), notice('d'), textFrame('Done.')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 5 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(probe.events.filter((entry) => entry.kind === 'notice')).toHaveLength(
      MAX_NOTICES_PER_TURN
    );
    const messages = decryptCheckpoints(probe.checkpoints).at(-1)?.messages ?? [];
    expect(messages.find((message) => message.toolCallId === 'd')?.content).toContain(
      'which is the limit'
    );
  });

  it('gives the next turn its own three notices instead of silencing the conversation', async () => {
    // The bound is written as per-turn in the tool description, in the constant's name and in the
    // refusal the model reads - but the counter was carried into the next turn by the state spread,
    // so a watch that raised three notices could never reach the owner again for the life of the
    // conversation, and was told the current turn had already sent three.
    const first = makeTask();
    const probe = probeStore(() => first);
    const promoted: Array<Record<string, unknown>> = [];
    // Reading the queue does not consume it - `getNextQueuedTaskMessage` is a plain SELECT, and
    // promoting is what clears the row. The stub used to decrement on read, so any second reader
    // made the message vanish; the loop now checks for a correction at every step boundary, which
    // is exactly such a reader.
    let queuedPromoted = false;
    Object.assign(probe.store, {
      getNextQueuedTaskMessage: async () => {
        if (queuedPromoted) return null;
        return {
          id: 'message-1',
          taskId,
          userId,
          promptCiphertext: encryptJson(
            { prompt: 'Keep watching it' },
            dataKey,
            `task-message:${taskId}`
          ),
          modelId: model.id,
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 5,
          maxSpendUsd: null,
          resourceClass: 'task_compute',
          reservationKey: `task:${taskId}:2`,
          status: 'queued',
          createdAt: '2026-07-01T00:00:00.000Z',
          promotedAt: null
        };
      },
      promoteQueuedTaskMessage: async (input: Record<string, unknown>) => {
        queuedPromoted = true;
        promoted.push(input);
        return first;
      }
    });
    const notice = (id: string): string =>
      toolFrame(id, 'notify', { headline: `Something happened, number ${id}` });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([notice('a'), notice('b'), notice('c'), textFrame('Done.')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(first)
      .catch(() => undefined);

    expect(probe.events.filter((entry) => entry.kind === 'notice')).toHaveLength(
      MAX_NOTICES_PER_TURN
    );
    const handedOver = decryptJson<{ notices?: number }>(
      promoted[0]?.agentStateCiphertext as Parameters<typeof decryptJson>[0],
      dataKey
    );
    expect(handedOver.notices).toBe(0);

    // And the turn that resumes from that state can genuinely speak again.
    const second = makeTask(handedOver);
    const resumed = probeStore(() => second);
    installFetch([notice('d'), textFrame('Done.')], { calls: [], modelRequests: [] });
    await new AgentWorker(resumed.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(second)
      .catch(() => undefined);
    expect(resumed.events.filter((entry) => entry.kind === 'notice')).toHaveLength(1);
    expect(resumed.notifications).toHaveLength(1);
  });

  it('tells a scheduled run it is unattended, and stamps its notices as such', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    // The scheduler stamps its own id into the payload of the run's opening event; that marker is
    // the only durable record that this task was not started by someone sitting in front of it.
    (probe.store as unknown as { listTaskEventPage: () => unknown }).listTaskEventPage =
      async () => ({
        events: [
          {
            id: 'opening',
            taskId,
            sequence: 1,
            kind: 'task_created',
            summary: 'Encrypted task created event',
            payloadCiphertext: encryptJson(
              { summary: 'Scheduled run is preparing', payload: { scheduleId: 'schedule-7' } },
              dataKey,
              `task-event:${taskId}`
            ),
            createdAt: '2026-07-01T00:00:00.000Z'
          }
        ],
        hasMore: false,
        oldestSequence: 1,
        nextCursor: 1
      });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [toolFrame('call-n', 'notify', { headline: 'The page changed' }), textFrame('Done.')],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const systemText = (
      (log.modelRequests[0]?.messages ?? []) as Array<{
        role: string;
        content: string;
      }>
    )
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).toContain('started by a schedule');
    expect(probe.events.find((entry) => entry.kind === 'notice')?.payload).toMatchObject({
      unattended: true
    });
  });
});

describe('finding things on the internet', () => {
  it('searches through the runner route rather than by driving the browser at a search page', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        toolFrame('call-s', 'web_search', { query: 'garden board pack template', limit: 40 }),
        textFrame('Found them.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(log.calls.some((call) => call.includes('/browser/search'))).toBe(true);
    expect(log.calls.some((call) => call.includes('/browser/action'))).toBe(false);
    // The runner caps a page at ten results and rejects anything larger, so the worker clamps
    // rather than sending a request that would come back as a validation error.
    expect(
      log.runnerRequests?.find((request) => request.url.includes('/browser/search'))?.body
    ).toEqual({ query: 'garden board pack template', limit: 10 });
  });

  it('reads twelve pages at a twelfth of the window each, so all twelve come back', async () => {
    // Twelve pages at the 20,000 the model may ask for is 214,670 characters arriving through a
    // 24,000-character result that is cut from the middle: measured, page one came back and the
    // other eleven were gone along with their URLs, so the harness paid runner time and provider
    // bandwidth for eleven pages the model could never see and was never told were missing.
    const urls = Array.from({ length: 12 }, (_unused, index) => `https://source-${index}.test/doc`);
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        toolFrame('call-r', 'parallel_web_read', { urls, maxCharactersPerPage: 20_000 }),
        textFrame('Read them.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/browser/read-many')
            ? jsonResponse({ sources: urls.map((page) => ({ url: page, text: 'a page' })) })
            : undefined
      }
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const body = log.runnerRequests?.find((request) => request.url.includes('/browser/read-many'))
      ?.body as { urls: string[]; maxCharactersPerPage: number } | undefined;
    expect(body?.urls).toHaveLength(12);
    expect(body?.maxCharactersPerPage).toBe(1_500);
    expect(body!.maxCharactersPerPage * 12).toBeLessThanOrEqual(24_000);

    // And the model is told, because a page cut without a mark reads as a page that did not
    // mention the thing, and a model reasons from what a source does not say.
    const result = log.modelRequests
      .flatMap(
        (request) =>
          (request.messages ?? []) as Array<{
            role?: string;
            tool_call_id?: string;
            content?: string;
          }>
      )
      .find((message) => message.role === 'tool' && message.tool_call_id === 'call-r');
    expect(result?.content).toContain('1,500 characters');
    expect(result?.content).toContain('Read a URL on its own for more of it');
  });

  it('gives one page the whole allowance, because it is not sharing the window with anything', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        toolFrame('call-r', 'parallel_web_read', {
          urls: ['https://source.test/doc'],
          maxCharactersPerPage: 20_000
        }),
        textFrame('Read it.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(
      (
        log.runnerRequests?.find((request) => request.url.includes('/browser/read-many'))?.body as
          | { maxCharactersPerPage: number }
          | undefined
      )?.maxCharactersPerPage
    ).toBe(20_000);
    // Nothing was shortened, so there is nothing to say about it.
    expect(
      log.modelRequests
        .flatMap(
          (request) =>
            (request.messages ?? []) as Array<{
              role?: string;
              tool_call_id?: string;
              content?: string;
            }>
        )
        .find((message) => message.role === 'tool' && message.tool_call_id === 'call-r')?.content
    ).not.toContain('Read a URL on its own');
  });

  it('parks on a durable challenge handoff before further model calls', async () => {
    // The runner detects the wall and scopes it, but it has no database identity: nothing it can do
    // reaches the owner's phone. A wall hit three times used to reach it zero times.
    const walls = [
      'https://html.duckduckgo.com/html/?q=a',
      'https://html.duckduckgo.com/html/?q=b',
      'https://careers.example.com/apply'
    ];
    let served = 0;
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'web_search', { query: 'a' }),
        toolFrame('call-2', 'web_search', { query: 'b' }),
        toolFrame('call-3', 'web_search', { query: 'c' }),
        textFrame('Told you about the check.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/browser/search')
            ? new Response(
                JSON.stringify({
                  error: {
                    code: 'browser_bot_wall',
                    message: `Blocked by Cloudflare Turnstile: this page is showing an anti-bot challenge. Tab tab-2 is stopped and ${new URL(walls[served] ?? walls[0]!).hostname} is closed to you until the owner opens it.`,
                    requestId: 'req',
                    botWall: {
                      vendor: 'Cloudflare Turnstile',
                      url: walls[served++] ?? walls[0],
                      reason: 'challenge frame',
                      evidence: 'page',
                      tabId: 'tab-2'
                    }
                  }
                }),
                { status: 409, headers: { 'content-type': 'application/json' } }
              )
            : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const failures = probe.events.filter((entry) => entry.kind === 'error');
    expect(failures).toHaveLength(1);
    expect(log.modelRequests).toHaveLength(1);
    expect(decryptCheckpoints(probe.checkpoints).at(-1)?.question).toMatchObject({
      handoff: { kind: 'challenge', tabId: 'tab-2' }
    });
    expect(probe.events.filter((entry) => entry.kind === 'question_asked')).toHaveLength(1);
    // The pane renders the wall from the event, so it has to survive as fields rather than prose -
    // every field it reads, including the one that decides whether the banner says the challenge
    // may clear on its own.
    expect(failures[0]?.payload).toMatchObject({
      code: 'browser_bot_wall',
      botWall: {
        vendor: 'Cloudflare Turnstile',
        url: 'https://html.duckduckgo.com/html/?q=a',
        reason: 'challenge frame',
        evidence: 'page',
        tabId: 'tab-2'
      }
    });
    expect(probe.notifications).toHaveLength(1);
    expect(probe.notifications[0]).toMatchObject({ kind: 'takeover_needed' });
    // And the model is told what is still open to it, in the runner's own words.
    const messages = decryptCheckpoints(probe.checkpoints).at(-1)?.messages ?? [];
    expect(messages.find((message) => message.toolCallId === 'call-1')?.content).toContain(
      'is closed to you until the owner opens it'
    );
  });
});

/**
 * Every one of these queries exits rg 0 or 1, so the exit-code guard never fires: what the model
 * gets back is an empty match list, which reads as "not present in this repository".
 */
describe('searching code for something that is not a regular expression', () => {
  const searches = (log: FetchLog): string[][] =>
    (log.runnerRequests ?? [])
      .filter((request) => request.url.endsWith('/exec'))
      .map((request) => (request.body as { args?: string[] }).args ?? []);

  /** rg answers exit 1 for "searched, found nothing" and 0 with lines for a hit. */
  const found = (...lines: string[]): Response =>
    new Response(
      JSON.stringify({
        exitCode: lines.length > 0 ? 0 : 1,
        stdout: lines.join('\n'),
        stderr: '',
        durationMs: 3,
        timedOut: false
      }),
      { headers: { 'content-type': 'application/json' } }
    );

  const run = async (
    args: Record<string, unknown>,
    execResponses: Response[]
  ): Promise<{ log: FetchLog; result: Record<string, unknown> | undefined }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    let served = 0;
    installFetch([toolFrame('call-1', 'code_search', args), textFrame('Read it.')], log, {
      route: (url) => {
        if (!url.endsWith('/exec')) return undefined;
        const next = execResponses[Math.min(served, execResponses.length - 1)];
        served += 1;
        return next;
      }
    });
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    const event = probe.events.find((entry) => entry.kind === 'tool_result');
    return {
      log,
      result: (event?.payload as { result?: Record<string, unknown> } | undefined)?.result
    };
  };

  it('reads a query the regex engine found nothing in as text, and says that is what it did', async () => {
    // `$scope.value` as a regex anchors at end of line and matches nothing - the same silent empty
    // answer the removed symbol tool gave for `$scope`, arriving by a different route.
    const { log, result } = await run({ query: '$scope.value' }, [
      found(),
      found('app.js:12:3:$scope.value = 3;')
    ]);

    const [first, second] = searches(log);
    expect(first).not.toContain('--fixed-strings');
    expect(second).toContain('--fixed-strings');
    expect(result).toMatchObject({ literal: true, totalReturned: 1 });
  });

  it('leaves a query with no regex punctuation on one search', async () => {
    // A retry here could only return what the first search already did, and every ordinary search
    // would pay for it.
    const { log } = await run({ query: 'parseInvoice' }, [found()]);
    expect(searches(log)).toHaveLength(1);
  });

  it('takes the query literally without also demanding a whole word', async () => {
    // These were one flag, so the only way to search for `a[0]` as text was to also require word
    // boundaries around it - which is a different question, and often the wrong one.
    const { log } = await run({ query: 'a[0]', literal: true }, [
      found('t.ts:1:7:const a[0] = 1;')
    ]);
    const [first] = searches(log);
    expect(first).toContain('--fixed-strings');
    expect(first).not.toContain('--word-regexp');
  });

  it('ignores a glob the model filled in with the word for nothing', async () => {
    // `--glob none` matches no file, so the search is over before it starts and the empty result
    // looks like an answer about the repository.
    const { log } = await run({ query: 'parseInvoice', glob: 'none' }, [found()]);
    expect(searches(log)[0]).not.toContain('--glob');
  });
});

describe('handing a repository to a subscription coding CLI', () => {
  it('sends the sandbox policy to the runner, not only to itself', async () => {
    // The worker builds OPENCODE_PERMISSION and OPENCODE_AUTO_SHARE - a deny-list covering sudo,
    // git push, rm -rf and reads of .env, plus the opt-out from publishing the session - and the
    // only test that covered them asserted the builder returned them. It proved the policy existed,
    // not that it survived to the process, and for a while it did not: the background route the
    // feature uses filtered them out of the environment on the way past.
    const approved = {
      action: 'run',
      agent: 'opencode',
      prompt: 'Fix the failing test',
      cwd: 'workspace'
    };
    const task = {
      ...makeTask({
        messages: [
          { role: 'user', content: 'Hand it to OpenCode' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-c', name: 'coding_agent', arguments: approved }]
          }
        ],
        step: 1,
        credits: 0,
        pending: {
          approvalId: 'approval-1',
          toolCall: { id: 'call-c', name: 'coding_agent', arguments: approved }
        }
      }),
      // A zero-retention task refuses the hand-over outright, which is a different branch.
      privacyRoute: 'external' as const
    };
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      getApproval: async () => ({
        id: 'approval-1',
        status: 'approved',
        previewHash: approvalPreviewHash(dataKey, 'coding_agent', approved),
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    });
    const started: Array<{ url: string; body: Record<string, unknown> }> = [];
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Handed over.')], log);
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/processes/start') && typeof init?.body === 'string') {
        started.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return new Response(
          JSON.stringify({
            sessionId: 'proc_1',
            status: 'exited',
            exitCode: 0,
            stdout: '{"type":"text","part":{"text":"done","sessionID":"ses_1"}}',
            stderr: ''
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      return inner(input as string, init);
    }) as typeof fetch);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(started, 'the approved hand-over never reached the runner').toHaveLength(1);
    const environment = (started[0]?.body.env ?? {}) as Record<string, string>;
    expect(environment.OPENCODE_AUTO_SHARE).toBe('false');
    const permission = JSON.parse(environment.OPENCODE_PERMISSION ?? '{}') as {
      external_directory?: string;
      bash?: Record<string, string>;
    };
    expect(permission.external_directory).toBe('deny');
    expect(permission.bash?.['sudo *']).toBe('deny');
    expect(permission.bash?.['git push *']).toBe('deny');
  });

  it('reports why a hand-over failed, instead of that it did not finish', async () => {
    // Measured against the real CLI on the box: an unauthenticated run exits 1, writes its reason
    // as the last JSON record on stdout - "Not logged in - please run /login" - and leaves stderr
    // empty. Reading only stderr turned the one thing the owner has to do into "exited without
    // completing". The same record's is_error is honoured too, so a run that fails without failing
    // its exit code is not reported back as a finished piece of work.
    const approved = {
      action: 'run',
      agent: 'claude',
      prompt: 'Fix the failing test',
      cwd: 'workspace'
    };
    const task = {
      ...makeTask({
        messages: [
          { role: 'user', content: 'Hand it to Claude Code' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-c', name: 'coding_agent', arguments: approved }]
          }
        ],
        step: 1,
        credits: 0,
        pending: {
          approvalId: 'approval-1',
          toolCall: { id: 'call-c', name: 'coding_agent', arguments: approved }
        }
      }),
      privacyRoute: 'external' as const
    };
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      getApproval: async () => ({
        id: 'approval-1',
        status: 'approved',
        previewHash: approvalPreviewHash(dataKey, 'coding_agent', approved),
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Handed over.')], log);
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/processes/start') && typeof init?.body === 'string')
        return new Response(
          JSON.stringify({
            sessionId: 'proc_1',
            status: 'exited',
            exitCode: 1,
            stdout: JSON.stringify({
              type: 'result',
              subtype: 'success',
              is_error: true,
              result: 'Not logged in · Please run /login',
              session_id: 'ses_9'
            }),
            stderr: ''
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      return inner(input as string, init);
    }) as typeof fetch);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const messages = decryptCheckpoints(probe.checkpoints).at(-1)?.messages ?? [];
    const answer = messages.find((message) => message.toolCallId === 'call-c')?.content ?? '';
    expect(answer).toContain('Please run /login');
    expect(answer).not.toContain('exited without completing');
  });
});

describe('the review copy that goes out beside an editable file', () => {
  const publish = async (
    exec: (body: { executable?: string; args?: string[] }) => Response
  ): Promise<{
    conversions: Array<{ executable?: string; args?: string[] }>;
    events: Array<{ kind: string; summary: string; payload: unknown }>;
  }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      createArtifact: async (input: Record<string, unknown>) => ({ ...input, id: 'a1', version: 1 })
    });
    const conversions: Array<{ executable?: string; args?: string[] }> = [];
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-p', 'publish_artifact', {
          path: 'workspace/board-pack.docx',
          name: 'Board pack.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }),
        textFrame('Sent.')
      ],
      log
    );
    // The artifact path reads and writes bytes and runs one command, and the command's identity is
    // in the request body - which the shared `route` hook does not see - so both are intercepted
    // here, in front of the stub installFetch left behind.
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/exec') && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as { executable?: string; args?: string[] };
        conversions.push(body);
        return exec(body);
      }
      if (url.includes('/file?path='))
        return init?.method === 'PUT'
          ? new Response(JSON.stringify({ ok: true }), {
              headers: { 'content-type': 'application/json' }
            })
          : new Response('bytes');
      return inner(input as string, init);
    }) as typeof fetch);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return { conversions, events: probe.events };
  };

  const observation = (exitCode: number, stderr = ''): Response =>
    new Response(JSON.stringify({ exitCode, stdout: '', stderr, durationMs: 1, timedOut: false }), {
      headers: { 'content-type': 'application/json' }
    });

  it('converts through the wrapper that fails when the bytes are not there', async () => {
    // Bare `libreoffice --convert-to pdf` exits 0 having written nothing, picks the output name
    // itself from the input stem, and shares one user profile with any conversion a skill starts
    // at the same moment. The wrapper is the answer to all three, and it is the only route the
    // built-in procedures name - the worker was the one caller still going around it.
    const { conversions } = await publish(() => observation(0));
    const conversion = conversions.find((call) => call.executable === 'garden-office-convert');
    expect(conversion, 'the review copy did not go through garden-office-convert').toBeDefined();
    expect(conversion?.args?.[0]).toBe('workspace/board-pack.docx');
    expect(conversion?.args?.[1]).toMatch(/^workspace\/\.garden\/renders\/.+\.pdf$/);
    expect(conversions.some((call) => call.executable === 'libreoffice')).toBe(false);
  });

  it('still publishes the editable file when the conversion fails, and says so', async () => {
    const { events } = await publish(() => observation(1, 'LibreOffice produced no output'));
    expect(
      events.find((entry) => entry.kind === 'warning' && entry.summary.includes('review PDF'))
    ).toBeDefined();
    const result = events.find((entry) => entry.kind === 'tool_result');
    expect(
      (result?.payload as { result?: { preview?: unknown } })?.result?.preview
    ).toBeUndefined();
  });
});

describe('spending the owner’s money on generated media', () => {
  /** What the agent loop prices its own next step at before it has a measurement to go on. */
  const STEP_FLOOR_USD = 0.01;

  interface MediaProbe {
    readonly guarded: Array<Record<string, unknown>>;
    readonly billed: Array<Record<string, unknown>>;
    readonly generated: Array<Record<string, unknown>>;
    readonly written: string[];
    readonly failure: unknown;
    readonly events: Array<{ kind: string; summary: string; payload: unknown }>;
    readonly messages: Array<{ role: string; content: string; toolCallId?: string }>;
  }

  const generate = async (options: {
    deny?: boolean;
    failWrite?: boolean;
    spentUsd?: number;
    arguments?: Record<string, unknown>;
    /** A route the owner chose in Settings, sealed the way the API seals it. */
    imageRoute?: Record<string, unknown>;
    /** The same for speech, which is dispatched through its own arm and priced in its own unit. */
    audioRoute?: Record<string, unknown>;
    videoRoute?: Record<string, unknown>;
    /** A provider that will not serve the sealed route, which is what a withdrawn model looks like. */
    providerRefusesTheRoute?: boolean;
  }): Promise<MediaProbe> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const guarded: Array<Record<string, unknown>> = [];
    const billed: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      ...(options.imageRoute || options.audioRoute || options.videoRoute
        ? {
            listManagedProviderCredentials: async () => [
              {
                provider: 'inference',
                status: 'active',
                secretCiphertext: encryptJson(
                  {
                    provider: 'openai-compatible',
                    baseUrl: PROVIDER_URL,
                    apiKey: 'stored-key',
                    enforceZeroDataRetention: false,
                    mediaRoutes: {
                      ...(options.imageRoute ? { image: options.imageRoute } : {}),
                      ...(options.audioRoute ? { audio: options.audioRoute } : {}),
                      ...(options.videoRoute ? { video: options.videoRoute } : {})
                    }
                  },
                  masterKey,
                  `inference-provider:${userId}`
                )
              }
            ]
          }
        : {}),
      parkTaskForApproval: async () => true,
      mediaSpendForTask: async () => options.spentUsd ?? 0,
      recordUsage: async (input: Record<string, unknown>) => {
        if (String(input.resourceClass).startsWith('media:') && input.state === 'settled')
          billed.push(input);
      },
      spendGuard: async (input: Record<string, unknown>) => {
        // Every step of the loop asks the same question about its own next model call, priced at
        // the floor of a cent. Those are not what this describes: the media path is the one that
        // arrives carrying the catalogue's price for a generation.
        const media = Number(input.estimateUsd) !== STEP_FLOOR_USD;
        if (media) guarded.push(input);
        return options.deny && media
          ? {
              outcome: 'deny' as const,
              estimateUsd: Number(input.estimateUsd),
              blockedBy: 'daily' as const,
              warnedBy: [],
              reason: null,
              windows: [
                {
                  name: 'daily' as const,
                  spentUsd: 4,
                  pendingUsd: 0,
                  capUsd: 4,
                  warnAtUsd: 3,
                  projectedUsd: 4.02,
                  state: 'exceeded' as const,
                  startsAt: null,
                  endsAt: null
                }
              ]
            }
          : {
              outcome: 'allow' as const,
              estimateUsd: Number(input.estimateUsd),
              blockedBy: null,
              warnedBy: [],
              reason: null,
              windows: []
            };
      }
    });
    const written: string[] = [];
    const log: FetchLog = { calls: [], modelRequests: [], mediaRequests: [] };
    installFetch(
      [
        toolFrame('call-m', 'generate_media', {
          kind: 'image',
          prompt: 'A matte black kettle on a grey seamless background',
          width: 1024,
          height: 1024,
          ...options.arguments
        }),
        textFrame('Done.')
      ],
      log,
      {
        ...(options.providerRefusesTheRoute
          ? {
              media: () =>
                new Response(
                  JSON.stringify({ error: { message: 'No endpoints found for that model' } }),
                  { status: 404 }
                )
            }
          : {}),
        route: (url) => {
          if (!url.includes('/file?path=')) return undefined;
          const path = decodeURIComponent(url.split('path=')[1] ?? '');
          // Only what a generation produced. The turn also writes its own scaffolding through the
          // same route, and counting that would make every assertion here about the wrong file.
          const generated = /\.(png|mp3)$/.test(path);
          if (generated && options.failWrite)
            return new Response(JSON.stringify({ error: 'refused' }), { status: 403 });
          if (generated) written.push(path);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' }
          });
        }
      }
    );
    let failure: unknown;
    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 1 }),
      masterKey,
      runnerSecret,
      silentLogger,
      fixtureMediaRouting
    )
      .run(task)
      .catch((error: unknown) => {
        failure = error;
      });
    return {
      guarded,
      failure,
      billed,
      generated: log.mediaRequests ?? [],
      written,
      events: probe.events,
      messages: decryptCheckpoints(probe.checkpoints).at(-1)?.messages ?? []
    };
  };

  it('asks the spending limit before the provider is charged, and prices the request itself', async () => {
    // This was the one money-spending path with no guard on it at all: every model call consults
    // the cap, and a generation - the only call that bills a second provider - did not.
    const probe = await generate({ arguments: { estimatedCostUsd: 0 } });
    const expected = 0.014; // The explicit fixture route declares a flat per-image quote.
    expect(probe.guarded).toHaveLength(1);
    expect(probe.guarded[0]).toMatchObject({ taskId, estimateUsd: expected });
    // The model said it was free. Nothing read that.
    expect(probe.generated).toHaveLength(1);
  });

  it('writes the file in the call that asked for it and answers with its path', async () => {
    // The whole point of the change this replaced: the tool returns a file, not a receipt for one.
    const probe = await generate({});
    // The routing block is the OpenRouter-only part and is covered where it is built; this asks
    // that the request describes what was asked for.
    expect(probe.generated[0]).toMatchObject({
      model: managedMediaCatalog.image.modelId,
      size: '1024x1024'
    });
    expect(probe.generated[0]).not.toHaveProperty('output_format');
    expect(probe.written).toHaveLength(1);
    expect(probe.written[0]).toMatch(/^workspace\/generated\/.*\.png$/);
    const answer = probe.messages.find((message) => message.toolCallId === 'call-m')?.content ?? '';
    expect(answer).toContain(probe.written[0]!);
  });

  it('generates with the model the owner chose, and prices the request against it', async () => {
    /*
     * The whole of "we have no control over the image model" in one assertion.
     *
     * Settings resolves the choice and the API seals it beside the key; this is the only place
     * that reads it back. Before it was wired the picker stored a route, displayed it, and the
     * worker generated with the compiled-in constant anyway - so an owner could pick a model, be
     * shown it, and never once use it. The price travels with it because the cap and the approval
     * card are checked against this number, and quoting the default's figure for a route ten times
     * the price is how a spend ceiling stops meaning anything.
     */
    const probe = await generate({
      imageRoute: {
        id: 'someone/painter-xl',
        providerModelId: 'someone/painter-xl',
        displayName: 'Painter XL',
        provider: 'openai-compatible',
        modality: 'image',
        usdPerImage: 0.14,
        usdPerMillionCharacters: null,
        priceSource: 'provider',
        recommendationTags: [],
        updatedAt: new Date().toISOString()
      }
    });
    expect(probe.generated[0]).toMatchObject({ model: 'someone/painter-xl' });
    // This route publishes a flat per-image price.
    expect(probe.guarded[0]).toMatchObject({ estimateUsd: 0.14 });
    expect(probe.billed[0]).toMatchObject({
      providerRef: 'openai-compatible:someone/painter-xl'
    });
    // Not the reviewed default, which is the thing this used to do no matter what was chosen.
    expect(probe.generated[0]?.model).not.toBe(managedMediaCatalog.image.modelId);
  });

  it('refuses a malformed sealed route before calling a different model', async () => {
    // Nothing on this side validates the sealed blob: it is decrypted and cast, because the screen
    // that wrote it is the thing that parsed it. A route that resolved to a blank id would go to
    // the provider as a request with no model on it, and what happens then is the owner's bill.
    const probe = await generate({
      imageRoute: {
        id: '',
        providerModelId: '',
        displayName: 'Whatever the catalogue said',
        provider: 'openai-compatible',
        modality: 'image',
        // Deliberately under the approval threshold and deliberately not the default's figure, so
        // the generation runs without a card in front of it and the price still says which route
        // was used.
        usdPerImage: 0.02,
        usdPerMillionCharacters: null,
        priceSource: 'provider',
        recommendationTags: [],
        updatedAt: new Date().toISOString()
      }
    });
    expect(probe.generated).toHaveLength(0);
    expect(probe.guarded).toHaveLength(0);
    expect(probe.failure).toMatchObject({ code: 'media_route_unavailable' });
  });

  it('spends nothing and says so when the provider will not serve the chosen route', async () => {
    /*
     * The failure the picker makes possible.
     *
     * A route is resolved once, when the owner chooses it, and sealed beside the key - so a model
     * their provider later withdraws stays sealed until they open Settings again. The turn has to
     * survive that: the ledger is the only account of media spend there is, and a generation that
     * never happened must not appear in it, must not leave a half-written file, and must reach the
     * model as a tool result it can act on rather than as a dead turn.
     */
    const probe = await generate({
      providerRefusesTheRoute: true,
      imageRoute: {
        id: 'someone/withdrawn',
        providerModelId: 'someone/withdrawn',
        displayName: 'Withdrawn',
        provider: 'openai-compatible',
        modality: 'image',
        usdPerImage: 0.14,
        usdPerMillionCharacters: null,
        priceSource: 'provider',
        recommendationTags: [],
        updatedAt: new Date().toISOString()
      }
    });
    expect(probe.generated[0]).toMatchObject({ model: 'someone/withdrawn' });
    expect(probe.billed).toHaveLength(0);
    expect(probe.written).toHaveLength(0);
    const answer = probe.messages.find((message) => message.toolCallId === 'call-m')?.content ?? '';
    expect(answer).toContain('No endpoints found for that model');
  });

  it('speaks in the voice of the speech model the owner chose, and prices it by the character', async () => {
    /*
     * The other arm, which shares the resolver and nothing else.
     *
     * Speech is dispatched to a different endpoint, billed in a different unit, and is the only
     * modality that carries a voice - and a voice belongs to one model's own list, so the moment
     * the model became the owner's choice, sending the reviewed default's voice name to whatever
     * they picked became a request their provider has no way to honour. The image assertion above
     * cannot see any of that: it never sends a voice and its price is per image.
     */
    const probe = await generate({
      arguments: { kind: 'audio', prompt: 'Read the quarterly note aloud.' },
      audioRoute: {
        id: 'someone/reader-1',
        providerModelId: 'someone/reader-1',
        displayName: 'Reader One',
        provider: 'openai-compatible',
        modality: 'audio',
        usdPerImage: null,
        usdPerMillionCharacters: 40,
        priceSource: 'provider',
        defaultVoice: 'quiet',
        recommendationTags: [],
        updatedAt: new Date().toISOString()
      }
    });
    expect(probe.generated[0]).toMatchObject({ model: 'someone/reader-1', voice: 'quiet' });
    expect(probe.generated[0]?.model).not.toBe(managedMediaCatalog.audio.modelId);
    // The chosen route's own per-million rate over the thirty characters it was asked to speak.
    expect(probe.guarded[0]).toMatchObject({ estimateUsd: (30 * 40) / 1_000_000 });
    expect(probe.billed[0]).toMatchObject({ providerRef: 'openai-compatible:someone/reader-1' });
    expect(probe.written[0]).toMatch(/\.mp3$/);
  });

  it('honours a path the agent chose, so the file lands where the work expects it', async () => {
    const probe = await generate({ arguments: { path: 'workspace/hero.png' } });
    expect(probe.written).toEqual(['workspace/hero.png']);
  });

  it('puts a bare path in the workspace rather than paying for a write the runner will refuse', async () => {
    // The runner accepts writes only under workspace/, and the tool schema invites a plain name. A
    // model answering `hero.png` used to have the provider bill, the write refused, and the charge
    // lost - so the destination is resolved on this side before anything is spent.
    const probe = await generate({ arguments: { path: 'hero.png' } });
    expect(probe.written).toEqual(['workspace/hero.png']);
  });

  it('refuses a path that climbs out of the workspace before the provider is called', async () => {
    const probe = await generate({ arguments: { path: '../../etc/garden/control.env' } });
    expect(probe.generated).toHaveLength(0);
    expect(probe.billed).toHaveLength(0);
    expect(probe.messages.find((message) => message.toolCallId === 'call-m')?.content).toContain(
      'may not climb out'
    );
  });

  it('records the charge even when the file cannot be written afterwards', async () => {
    // The ledger is the only account of media spend there is now: it feeds the caps, the cumulative
    // approval card and the breakdown the owner reads. A write that fails after the provider has
    // billed must still leave the money visible, or a retry loop spends without ever being seen.
    const probe = await generate({ failWrite: true });
    expect(probe.generated).toHaveLength(1);
    expect(probe.billed).toHaveLength(1);
    expect(probe.billed[0]).toMatchObject({ resourceClass: 'media:image', costUsd: 0.0102 });
    expect(probe.written).toHaveLength(0);
  });

  it('settles the ledger on what the provider charged, not on the estimate', async () => {
    // The estimate is what the cap is checked against; the invoice is what the owner actually pays,
    // and the spend breakdown they read is built from these rows.
    const probe = await generate({});
    expect(probe.billed).toHaveLength(1);
    expect(probe.billed[0]).toMatchObject({
      resourceClass: 'media:image',
      state: 'settled',
      costUsd: 0.0102,
      providerRef: `openai-compatible:${managedMediaCatalog.image.modelId}`
    });
    // Not the estimate, which is a different number.
    expect(probe.billed[0]?.costUsd).not.toBe(
      managedMediaCatalog.image.estimate({ width: 1024, height: 1024 })
    );
  });

  it('refuses the generation when the limit is reached, and says nothing was charged', async () => {
    const probe = await generate({ deny: true });
    expect(probe.generated).toHaveLength(0);
    expect(probe.written).toHaveLength(0);
    expect(probe.billed).toHaveLength(0);
    const refusal =
      probe.messages.find((message) => message.toolCallId === 'call-m')?.content ?? '';
    expect(refusal).toContain('limit');
    expect(refusal).toContain('nothing was charged');
    expect(probe.events.some((entry) => entry.kind === 'error')).toBe(true);
  });

  it('requires per-job retention approval before submitting video', async () => {
    const probe = await generate({
      arguments: { kind: 'video', options: { duration: 4, size: '720x1280' } },
      videoRoute: {
        id: 'openai/video-fixture',
        providerModelId: 'video-fixture',
        displayName: 'Video fixture',
        provider: 'openai',
        apiProtocol: 'openai',
        modality: 'video',
        usdPerImage: null,
        usdPerMillionCharacters: null,
        usdPerMinute: null,
        usdPerSecond: 0.1,
        priceSource: 'provider',
        requiresRetentionApproval: true,
        zeroDataRetentionAvailable: false,
        recommendationTags: [],
        updatedAt: '2026-07-01T00:00:00.000Z'
      }
    });
    expect(probe.generated).toHaveLength(0);
    expect(probe.guarded).toHaveLength(0);
    expect(probe.events.some((event) => event.kind === 'approval_requested')).toBe(true);
  });
});

describe('reaching the built-in skill library', () => {
  const toolResult = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-1', 'skill', args)], log);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    const event = probe.events.find((entry) => entry.kind === 'tool_result');
    return (event?.payload as { result?: Record<string, unknown> })?.result ?? {};
  };

  it('lists the built-in skills beside the workspace ones', async () => {
    const result = await toolResult({ action: 'list' });
    const builtin = (result.builtinSkills ?? []) as Array<{ name: string }>;
    expect(builtin.length).toBeGreaterThan(15);
    expect(builtin.map((skill) => skill.name)).toContain('pdf-extraction');
  });

  it('opens a built-in procedure by name, with the binaries it assumes', async () => {
    // openSkill had no caller outside its own tests; skill(action=view) could only open skills the
    // agent had written itself.
    const result = await toolResult({ action: 'view', id: 'pdf-extraction' });
    expect(result.origin).toBe('builtin');
    expect(String(result.content)).toContain('<skill name="pdf-extraction"');
    expect(String(result.content)).toContain('## 1. Classify the PDF first');
    // The skill declares the binaries it assumes, and the answer names the ones this computer does
    // not have rather than a command for finding out - a procedure that opens with "run
    // build_deck.py" is confident, specific and wrong on a machine without python-pptx.
    expect(Array.isArray(result.requiredBinaries)).toBe(true);
    expect((result.requiredBinaries as string[]).length).toBeGreaterThan(0);
    // The probe is stubbed here and reports nothing missing, so the warning block stays out of the
    // procedure; a machine that really lacked one would carry it into the model's context.
    expect(result.missingBinaries).toBeUndefined();
    expect(String(result.content)).not.toContain('skill_missing_binaries');
  });

  it('sends the procedure once and a stub the second time, and records which are open', async () => {
    /*
     * `openSkill` has always taken an `active` list and answered a repeat view with a short
     * `state="already_open"` stub, and nothing ever supplied it - the only caller passed
     * `missingBinaries` and nothing else. So a model that viewed a skill at step 4 and viewed it
     * again at step 30 was handed the whole procedure a second time, up to five thousand tokens of
     * it, with nothing in the answer saying it was a duplicate. Its one test passed the option the
     * product never passed.
     */
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'skill', { action: 'view', id: 'untrusted-content' }),
        toolFrame('call-2', 'skill', { action: 'view', id: 'untrusted-content' }),
        textFrame('Read it.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const answers = toolMessages(probe);
    const first = answers.find((message) => message.toolCallId === 'call-1')?.content ?? '';
    const second = answers.find((message) => message.toolCallId === 'call-2')?.content ?? '';
    expect(first).toContain('untrusted-content');
    expect(first.length).toBeGreaterThan(1_000);
    expect(second).toContain('already_open');
    // The saving is the point, so it is asserted as a size and not only as a marker.
    expect(second.length).toBeLessThan(first.length / 4);

    const saved = decryptCheckpoints(probe.checkpoints).at(-1) as unknown as {
      openedSkills?: string[];
    };
    expect(saved.openedSkills).toEqual(['untrusted-content']);
  });

  it('sends the whole procedure again when the window no longer holds it', async () => {
    /*
     * The other half, and it is why the record is checked against the window rather than trusted.
     * A compaction drops whole messages, so the body of a skill opened twenty steps ago can be gone
     * while the state still says it is open - and `compactContext` names exactly those skills in
     * the running brief and tells the model to reopen them. Answering that reopen with a stub would
     * strand the turn on instructions nothing in its window holds.
     */
    const condensed = {
      messages: [
        { role: 'user', content: 'Summarise the page I saved' },
        {
          role: 'system',
          content:
            "CONDENSED HISTORY BRIEF\nInstructions no longer in the window: untrusted-content. Reopen a skill with skill(action: 'view') before relying on it again."
        }
      ],
      step: 0,
      credits: 0,
      turn: 0,
      openedSkills: ['untrusted-content']
    };
    const task = makeTask(condensed);
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [toolFrame('call-1', 'skill', { action: 'view', id: 'untrusted-content' }), textFrame('Ok.')],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const answer =
      toolMessages(probe).find((message) => message.toolCallId === 'call-1')?.content ?? '';
    expect(answer).not.toContain('already_open');
    expect(answer.length).toBeGreaterThan(1_000);
  });

  it('still reports an unknown skill as missing', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-1', 'skill', { action: 'view', id: 'no-such-skill' })], log);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    expect(probe.events.some((entry) => entry.kind === 'error')).toBe(true);
  });
});

/**
 * The completion contract as a contract rather than a receipt.
 *
 * Every gate before this one tested identity and ordering - that a cited call exists, succeeded and
 * came after the last change - which any read of the file just written satisfies. These tests are
 * about the harness running something that can fail on the work itself, and about the one way that
 * mechanism could be turned back into a receipt: a check chosen because it was already true.
 */
describe('what would prove the job is done', () => {
  const execResponse = (exitCode: number, stdout = ''): Response =>
    new Response(
      JSON.stringify({
        exitCode,
        stdout,
        stderr: exitCode === 0 ? '' : 'AssertionError: expected 3 rows, found 0',
        durationMs: 5,
        timedOut: false
      }),
      { headers: { 'content-type': 'application/json' } }
    );

  const execRoute =
    (...codes: number[]) =>
    (url: string): Response | undefined => {
      if (!url.includes('/exec')) return undefined;
      const code = codes.length > 1 ? (codes.shift() ?? 0) : (codes[0] ?? 0);
      return execResponse(code);
    };

  /**
   * The last thing this request actually said to the model. The runtime block sits at the very end
   * of every window - that is where its clock is free to change - so it is stepped over here rather
   * than in each assertion.
   */
  const lastMessage = (log: FetchLog, request: number): string => {
    const messages = (log.modelRequests[request]?.messages ?? []) as Array<{ content: string }>;
    return (
      [...messages].reverse().find((message) => !message.content.startsWith(RUNTIME_CONTEXT_MARKER))
        ?.content ?? ''
    );
  };

  const acceptanceState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    messages: [
      { role: 'user', content: 'Fix the importer' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-0', name: 'file_read', arguments: {} }]
      },
      { role: 'tool', toolCallId: 'call-0', content: 'ok' }
    ],
    step: 0,
    credits: 0,
    // A turn that has already changed something, with one earlier result available to cite: the
    // state a real finish arrives in. It is fixing an importer, so the change is code - which is
    // what puts it in front of the acceptance gate at all.
    mutated: true,
    mutatedBeyondProse: true,
    turnToolResults: { 'call-0': { name: 'file_read', success: true } },
    ...over
  });

  const finishCall = (id: string): string =>
    toolFrame(id, 'finish', {
      summary: 'The importer reads all three columns.',
      verification: {
        status: 'verified',
        evidence: [
          {
            claim: 'The importer reads all three columns',
            source: 'tool_result',
            toolCallId: 'call-0'
          }
        ],
        remainingRisks: []
      }
    });

  it('refuses a definition of done the harness can already satisfy', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'set_acceptance', {
          checks: [
            {
              kind: 'command',
              label: 'the workspace is there',
              executable: 'ls',
              args: ['workspace']
            }
          ]
        }),
        textFrame('Understood.')
      ],
      log,
      { route: execRoute(0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    expect(
      probe.events.some((entry) => entry.summary === 'Acceptance checks refused: they already pass')
    ).toBe(true);
    expect(lastMessage(log, 1)).toContain('every one of them already passes');
    // Not stored: a record that cannot fail must not become the thing the finish is judged against.
    const states = decryptCheckpoints(probe.checkpoints) as unknown as Array<{
      acceptance?: unknown;
    }>;
    expect(states.every((state) => state.acceptance === undefined)).toBe(true);
  });

  it('takes the record once the harness has watched a check fail, and says which one is the proof', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'set_acceptance', {
          checks: [
            {
              kind: 'command',
              label: 'the importer test passes',
              executable: 'pytest',
              args: ['-q']
            },
            {
              kind: 'command',
              label: 'the existing suite still passes',
              executable: 'ruff',
              args: ['check']
            }
          ]
        }),
        textFrame('Starting now.')
      ],
      log,
      { route: execRoute(1, 0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const baseline = probe.events.find((entry) => entry.summary.startsWith('Acceptance baseline:'));
    expect(baseline?.summary).toBe('Acceptance baseline: 1 of 2 already pass before the work');
    expect(probe.events.some((entry) => entry.summary === 'Acceptance checks declared')).toBe(true);
    const answer = lastMessage(log, 1);
    expect(answer).toContain('check-1 fails now');
    expect(answer).toContain('check-2 already passes');
    const states = decryptCheckpoints(probe.checkpoints) as unknown as Array<{
      acceptance?: { checks: unknown[] };
    }>;
    expect(states.some((state) => state.acceptance?.checks.length === 2)).toBe(true);
  });

  it('refuses the finish when the harness runs the checks and one fails', async () => {
    const task = makeTask(
      acceptanceState({
        acceptance: {
          checks: [
            {
              id: 'check-1',
              kind: 'command',
              label: 'the importer test passes',
              executable: 'pytest',
              args: ['-q'],
              cwd: 'workspace',
              expectExit: 0,
              timeoutSeconds: 300
            }
          ],
          revisions: 1,
          declaredAtStep: 0
        }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([finishCall('call-1'), textFrame('Looking at it.')], log, { route: execRoute(1) });
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    // Named, and a status rather than a warning: the model gets to fix this and finish, so a turn
    // that recovers used to carry a standing red line over its own "all passed" completion card.
    const refusal = probe.events.find((entry) => entry.summary.startsWith('Finish refused:'));
    expect(refusal?.kind).toBe('status');
    expect(refusal?.summary).toBe(
      'Finish refused: 1 of 1 acceptance check failed — the importer test passes'
    );
    // The turn did not complete. It ends at its step limit instead, which is the honest ending -
    // and what the model is told back is the harness's own observation rather than a verdict: an
    // exit code and the first lines of stderr are what turn "it does not work" into a next step.
    const ending = probe.events.find((entry) => entry.kind === 'completed');
    expect((ending?.payload as { interrupted?: boolean } | undefined)?.interrupted).toBe(true);
    const answer = lastMessage(log, 1);
    expect(answer).toContain('Finish refused (acceptance 1 of 4)');
    expect(answer).toContain('AssertionError: expected 3 rows');
    /*
     * And the prose it writes on the way back round is not published as a reply. Five paths refuse
     * a finish and send the model round again; its natural answer to "finish refused" is to restate
     * itself, and each restatement used to be another bubble. That is why one answer reached the
     * owner in pieces. The words still go into the window - the model needs them - they are just
     * not a new thing said to the owner.
     */
    // Exactly one thing reaches the owner. Five paths refuse a finish and send the model round
    // again, and its natural reply to "finish refused" is to restate itself; each restatement used
    // to be another bubble, which is why one answer arrived in pieces.
    expect(probe.events.filter((entry) => entry.kind === 'assistant_message')).toHaveLength(1);
  });

  /**
   * The hold exists so a turn that changed code says what would prove it. A report is a change too,
   * but nothing executable can prove it: the only check available is reading back the file just
   * written, which passes whatever the file says. Held anyway, a research task invents a check,
   * fails it, and is refused its own finish - which is what happened to a real one.
   */
  it('holds for acceptance on code but not on prose, on the extension alone', async () => {
    const heldFor = async (path: string): Promise<boolean> => {
      const task = makeTask();
      const probe = probeStore(() => task);
      const log: FetchLog = { calls: [], modelRequests: [] };
      installFetch(
        [
          toolFrame('call-1', 'file_write', { path, content: 'Some words.\n' }),
          // A read-only look at the result, so the finish below cites an observation ordered after
          // the change rather than the change itself. `ls` writes nothing, so it leaves the
          // prose/code question this test is about entirely to the extension.
          toolFrame('call-2', 'shell', { executable: 'ls', args: ['workspace'] }),
          toolFrame('call-3', 'finish', {
            summary: 'Wrote the file.',
            verification: {
              status: 'verified',
              evidence: [
                { claim: 'The file is on disk', source: 'tool_result', toolCallId: 'call-2' }
              ],
              remainingRisks: []
            }
          }),
          textFrame('Done.')
        ],
        log,
        { route: execRoute(0) }
      );
      const worker = new AgentWorker(
        probe.store,
        config({ TASK_MAX_STEPS: 8 }),
        masterKey,
        runnerSecret
      );

      await worker.run(task).catch(() => undefined);

      return probe.events.some((entry) => entry.summary === 'Asked for an acceptance record');
    };

    // The same turn, the same write, the same finish. Only the extension differs, so neither result
    // can be explained by anything else in the run.
    expect(await heldFor('workspace/notes.ts')).toBe(true);
    expect(await heldFor('workspace/notes.md')).toBe(false);
  });

  /**
   * A real task asked for a report file "and the gist in your reply". It wrote the report, published
   * it, and completed without an assistant message at all - the owner got a Result card and a
   * download. Nothing in the loop required the turn to say anything.
   */
  it('answers with the finish summary when the turn never said anything itself', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'shell', { executable: 'ls', args: ['workspace'] }),
        // A finish, with no prose in the same frame and none before it.
        toolFrame('call-2', 'finish', {
          summary: 'The workspace has three files in it.',
          verification: {
            status: 'verified',
            evidence: [
              { claim: 'Listed the workspace', source: 'tool_result', toolCallId: 'call-1' }
            ],
            remainingRisks: []
          }
        }),
        textFrame('Done.')
      ],
      log,
      { route: execRoute(0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 4 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    // Asked once, rather than completed in silence and papered over with the summary. The reply the
    // owner reads is then the model's own words, which is the thing they asked for.
    expect(probe.events.some((entry) => entry.summary === 'Asked for the answer itself')).toBe(
      true
    );
    const spoken = probe.events.filter((entry) => entry.kind === 'assistant_message');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.summary).toBe('Done.');
    // Before the completion, so the owner reads the answer above the card rather than under it.
    expect(probe.events.indexOf(spoken[0]!)).toBeLessThan(
      probe.events.findIndex((entry) => entry.kind === 'completed')
    );
  });

  /**
   * Pausing cleared the lease in the same statement that set the status, and every write this
   * worker makes is guarded by `lease_owner = workerId`. So the stand-down write - the one that
   * saves the agent state - matched zero rows every time, and a paused task quietly lost the work
   * it had done and resumed from the beginning. `updateTask` returns void, so nothing said so.
   */
  it('saves the work when the owner pauses, despite the pause having cleared the lease', async () => {
    const paused = { ...makeTask(), status: 'paused', leaseOwner: null } as TaskRecord;
    const probe = probeStore(() => paused);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Working on it.')], log);
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(paused).catch(() => undefined);

    const standDown = probe.checkpoints.find((write) => write.status === 'paused');
    expect(standDown).toBeDefined();
    // The point of the write: the turn's work survives the pause.
    expect(standDown?.agentStateCiphertext).toBeDefined();
    // And it is not guarded by an owner the pause already set to NULL, which is what made the
    // write a no-op. Reconciling to a status the owner set is not competing for the task.
    expect(standDown?.workerId).toBeUndefined();
  });

  /** The other half of the rule: a turn that answered is never asked to answer again. */
  it('says nothing to a turn that already spoke', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'shell', { executable: 'ls', args: ['workspace'] }),
        // Prose and the finish in the same frame, which is how a turn that behaves looks.
        `data: ${JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              delta: {
                content: 'There are three files in the workspace.',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-2',
                    function: {
                      name: 'finish',
                      arguments: JSON.stringify({
                        summary: 'Listed the workspace.',
                        verification: {
                          status: 'verified',
                          evidence: [
                            { claim: 'Listed it', source: 'tool_result', toolCallId: 'call-1' }
                          ],
                          remainingRisks: []
                        }
                      })
                    }
                  }
                ]
              }
            }
          ]
        })}\n\ndata: [DONE]\n\n`,
        textFrame('Done.')
      ],
      log,
      { route: execRoute(0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 4 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    expect(probe.events.some((entry) => entry.summary === 'Asked for the answer itself')).toBe(
      false
    );
    const spoken = probe.events.filter((entry) => entry.kind === 'assistant_message');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.summary).toBe('There are three files in the workspace.');
  });

  it('completes when the harness runs the checks and they pass', async () => {
    const task = makeTask(
      acceptanceState({
        acceptance: {
          checks: [
            {
              id: 'check-1',
              kind: 'command',
              label: 'the importer test passes',
              executable: 'pytest',
              args: ['-q'],
              cwd: 'workspace',
              expectExit: 0,
              timeoutSeconds: 300
            }
          ],
          revisions: 1,
          declaredAtStep: 0
        }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([finishCall('call-1')], log, { route: execRoute(0) });
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const completed = probe.events.find((entry) => entry.kind === 'completed');
    expect(completed).toBeDefined();
    // What the harness itself ran, kept apart from what the model claimed.
    expect((completed?.payload as { acceptance?: string[] }).acceptance).toEqual([
      'check-1: the importer test passes — ran pytest -q — exit 0'
    ]);
    // And the same line in the field a script reads first, under the source only the harness writes.
    const evidence = (completed?.payload as { verification?: { evidence?: unknown[] } })
      .verification?.evidence;
    expect(evidence).toContainEqual({
      claim: 'check-1: the importer test passes — ran pytest -q — exit 0',
      source: 'acceptance_check'
    });
  });

  const importerCheck = {
    id: 'check-1',
    kind: 'command',
    label: 'the importer test passes',
    executable: 'pytest',
    args: ['-q'],
    cwd: 'workspace',
    expectExit: 0,
    timeoutSeconds: 300
  };

  /**
   * A turn that ends with a check still failing has already been sent round three times to fix it.
   * That is what makes the observation worth keeping: not a command that failed once, but a route
   * the model could not open after four goes at it.
   */
  it('keeps the command the harness watched fail once the model has run out of repairs', async () => {
    const task = makeTask(
      acceptanceState({
        acceptance: { checks: [importerCheck], revisions: 1, declaredAtStep: 0 }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        finishCall('call-1'),
        finishCall('call-2'),
        finishCall('call-3'),
        finishCall('call-4'),
        textFrame('It still fails.'),
        finishCall('call-5')
      ],
      log,
      { route: execRoute(1) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 8 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    expect(probe.deadEnds).toHaveLength(1);
    const [written] = probe.deadEnds[0]?.wrote ?? [];
    // The command as a passing run would name it, the working directory, and what was actually
    // seen - the same three things the successful half is built out of.
    expect(written).toContain('pytest -q');
    expect(written).toContain('workspace');
    expect(written).toContain('AssertionError: expected 3 rows');
    // And it is written as one observation with a way out, not as a property of the command.
    expect(written).toContain('did not pass when the harness last ran it');
    expect(probe.deadEnds[0]?.retired).toEqual([]);
  });

  /**
   * The hardest case for this to stay quiet in, and the ordinary one: a check fails, the model is
   * told, it fixes the work, and the second run passes. Nothing about that turn is a dead end - and
   * the pass is what takes back any caution an earlier turn left behind.
   */
  it('keeps nothing about a check the same turn went back and fixed', async () => {
    const task = makeTask(
      acceptanceState({ acceptance: { checks: [importerCheck], revisions: 1, declaredAtStep: 0 } })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([finishCall('call-1'), textFrame('Fixed it.'), finishCall('call-2')], log, {
      route: execRoute(1, 0)
    });
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 4 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    expect(probe.events.some((entry) => entry.summary.startsWith('Finish refused:'))).toBe(true);
    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(true);
    expect(probe.deadEnds).toHaveLength(1);
    expect(probe.deadEnds[0]?.wrote).toEqual([]);
    expect(probe.deadEnds[0]?.retired).toHaveLength(1);
  });

  /**
   * The other way a guard like this fires on real work: the runner is unreachable, every check
   * comes back failed, and the box would learn that a perfectly good command does not work - a
   * belief it would then carry into turns that could have run it.
   */
  it('keeps nothing about a command it never managed to run', async () => {
    const task = makeTask(
      acceptanceState({
        acceptance: { checks: [importerCheck], revisions: 1, declaredAtStep: 0 }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        finishCall('call-1'),
        finishCall('call-2'),
        finishCall('call-3'),
        finishCall('call-4'),
        textFrame('The runner is down.'),
        finishCall('call-5')
      ],
      log,
      {
        route: (url: string) =>
          url.includes('/exec') ? new Response('no runner', { status: 502 }) : undefined
      }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 8 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    // The turn did end with the check counted as failed - this is not a test that nothing happened.
    const completed = probe.events.find((entry) => entry.kind === 'completed');
    const risks =
      (completed?.payload as { verification?: { remainingRisks?: string[] } } | undefined)
        ?.verification?.remainingRisks ?? [];
    expect(risks.join(' ')).toContain('could not run');
    expect(probe.deadEnds.flatMap((entry) => entry.wrote)).toEqual([]);
  });

  /**
   * The commands are the model's, and a page that steers it into declaring a check against the
   * wrong directory would otherwise get a standing caution out of the machine's own observation.
   * The same gate a fact and a procedure carry, for the entry that has the sharpest edge.
   */
  it('settles no caution on a turn that read somebody else’s words', async () => {
    const task = makeTask(
      acceptanceState({
        acceptance: { checks: [importerCheck], revisions: 1, declaredAtStep: 0 },
        taint: { level: 'untrusted', sources: ['example.com'], sinceStep: 0 }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        finishCall('call-1'),
        finishCall('call-2'),
        finishCall('call-3'),
        finishCall('call-4'),
        textFrame('It still fails.'),
        finishCall('call-5')
      ],
      log,
      { route: execRoute(1) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 8 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(true);
    expect(probe.deadEnds.flatMap((entry) => entry.wrote)).toEqual([]);
  });

  it('keeps the order garden did its own steps in out of the completion', async () => {
    const task = makeTask(acceptanceState());
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'set_acceptance', {
          checks: [
            {
              kind: 'command',
              label: 'the importer test passes',
              executable: 'pytest',
              args: ['-q']
            }
          ]
        }),
        finishCall('call-2')
      ],
      log,
      { route: execRoute(0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 3 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    // No baseline was possible: the turn had already changed things, so what passes now may be the
    // work or may always have been true. The checks still run and the tick is still earned.
    expect(probe.events.some((entry) => entry.summary.startsWith('Acceptance baseline:'))).toBe(
      false
    );
    const completed = probe.events.find((entry) => entry.kind === 'completed');
    const payload = completed?.payload as {
      acceptance?: string[];
      verification?: { remainingRisks: string[] };
    };
    expect(payload.acceptance).toEqual([
      'check-1: the importer test passes — ran pytest -q — exit 0'
    ]);
    /*
     * What the owner is not told is when the checks were written relative to the work, because that
     * is a fact about how this box sequences its own steps and not about the job it just finished.
     * The hold on finish is the only thing that asks for a record and it fires because something has
     * already changed, so the sentence appeared on very nearly every completed task; the owner read
     * it and asked what it meant. Matched on the words rather than on a constant, because the fix is
     * that no wording of it belongs here.
     */
    for (const risk of payload.verification?.remainingRisks ?? [])
      expect(risk).not.toMatch(/written after the work|before it/i);
    expect(payload.acceptance ?? []).not.toContainEqual(
      expect.stringMatching(/written after the work/i)
    );
  });

  it('will not let a later turn be proven by the checks an earlier one declared', async () => {
    const task = makeTask(
      acceptanceState({
        turn: 1,
        acceptanceTurn: 0,
        acceptance: {
          checks: [
            {
              id: 'check-1',
              kind: 'command',
              label: 'the importer test passes',
              executable: 'pytest',
              args: ['-q'],
              cwd: 'workspace',
              expectExit: 0,
              timeoutSeconds: 300
            }
          ],
          revisions: 1,
          declaredAtStep: 0
        }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([finishCall('call-1'), finishCall('call-2')], log, { route: execRoute(0) });
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 3 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    // Held once, because a record that was already green before this turn started cannot be
    // evidence of what this turn did - and then taken at its word, with the owner told which it is.
    expect(lastMessage(log, 1)).toContain('an earlier turn declared');
    const completed = probe.events.find((entry) => entry.kind === 'completed');
    const payload = completed?.payload as { verification?: { remainingRisks: string[] } };
    expect(payload.verification?.remainingRisks).toContain(ACCEPTANCE_EARLIER_TURN_CAVEAT);
  });

  it('will not let a turn cite the promise it made as the proof it kept it', async () => {
    const task = makeTask({
      messages: [{ role: 'user', content: 'Tidy the notes' }],
      step: 0,
      credits: 0,
      mutated: true,
      turnToolResults: { 'call-0': { name: 'set_acceptance', success: true } },
      acceptance: {
        checks: [
          {
            id: 'check-1',
            kind: 'artifact',
            label: 'the notes exist',
            path: 'workspace/notes.md',
            minBytes: 1
          }
        ],
        revisions: 1,
        declaredAtStep: 0
      }
    });
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'finish', {
          summary: 'Done.',
          verification: {
            status: 'verified',
            evidence: [
              { claim: 'The notes are tidy', source: 'tool_result', toolCallId: 'call-0' }
            ],
            remainingRisks: []
          }
        }),
        textFrame('Let me check the file.')
      ],
      log,
      { route: execRoute(0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const ending = probe.events.find((entry) => entry.kind === 'completed');
    expect((ending?.payload as { interrupted?: boolean } | undefined)?.interrupted).toBe(true);
    expect(lastMessage(log, 1)).toContain('Finish rejected');
  });

  const deckCheck = {
    id: 'check-1',
    kind: 'artifact',
    label: 'the deck is twelve slides with nothing cut off',
    path: 'workspace/deck.pptx',
    minBytes: 1_024,
    render: { expectPages: 12, marginPoints: 0 }
  };

  /** A workspace holding the deliverable, and a runner that answers for its rendered pages. */
  const deckRoute =
    (proof: () => Response) =>
    (url: string): Response | undefined => {
      if (url.includes('/document/render-proof')) return proof();
      if (url.includes('/files?path='))
        return new Response(
          JSON.stringify({ entries: [{ name: 'deck.pptx', type: 'file', sizeBytes: 48_000 }] }),
          { headers: { 'content-type': 'application/json' } }
        );
      return undefined;
    };

  const acceptanceResults = (probe: StoreProbe): Array<{ passed: boolean; detail: string }> =>
    (
      probe.events.find((entry) => entry.summary.startsWith('Acceptance checks:'))?.payload as
        | { acceptance?: Array<{ passed: boolean; detail: string }> }
        | undefined
    )?.acceptance ?? [];

  /**
   * The deliverable this product leads with, held against how it renders rather than how big it is.
   *
   * A deck whose text runs off slide four is comfortably past a byte floor, so a check that could
   * only weigh the file left the model that made it as the only witness to how it looks. What the
   * turn is refused on here is a measurement of the file as it stands at finish, and the sentence
   * the model is sent back with is the one the owner reads.
   */
  it('holds a deck on how its slides render, not on how many bytes it is', async () => {
    const task = makeTask(
      acceptanceState({ acceptance: { checks: [deckCheck], revisions: 1, declaredAtStep: 0 } })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch([finishCall('call-1'), textFrame('Fixing the overflow.')], log, {
      route: deckRoute(
        () =>
          new Response(
            JSON.stringify({
              passed: false,
              detail:
                'slide 4 of 12: “Attribution” runs 6.4pt past the right edge of the slide and is cut off there',
              pages: 12,
              words: 486,
              crossings: 1,
              blankPages: [],
              converted: true
            }),
            { headers: { 'content-type': 'application/json' } }
          )
      )
    });
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    // The measurement was asked for at all, of that file, with the count the owner named.
    expect(
      (log.runnerRequests ?? []).find((entry) => entry.url.includes('/document/render-proof'))?.body
    ).toMatchObject({ path: 'workspace/deck.pptx', expectPages: 12 });
    // Its finding is the check's verdict, and the check's detail is the finding's own sentence.
    expect(acceptanceResults(probe)[0]).toMatchObject({
      passed: false,
      detail:
        'slide 4 of 12: “Attribution” runs 6.4pt past the right edge of the slide and is cut off there'
    });
    expect(lastMessage(log, 1)).toContain('runs 6.4pt past the right edge');
  });

  /**
   * The failure that would be worst of all: a box with no renderer reporting the file as fine
   * because it is big enough. A refusal has to arrive as a check that did not pass, carrying why.
   */
  it('says a deck could not be measured rather than that it is fine', async () => {
    const task = makeTask(
      acceptanceState({ acceptance: { checks: [deckCheck], revisions: 1, declaredAtStep: 0 } })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch([finishCall('call-1'), textFrame('No renderer here.')], log, {
      route: deckRoute(
        () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'runner_request_failed',
                message:
                  'This computer has no PDF page reader, so nothing about the rendered pages can be measured and this check cannot say whether the document is right.',
                requestId: 'r1'
              }
            }),
            { status: 503, headers: { 'content-type': 'application/json' } }
          )
      )
    });
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const [result] = acceptanceResults(probe);
    expect(result?.passed).toBe(false);
    expect(result?.detail).toContain('has no PDF page reader');
  });

  /**
   * And the case it must not fire on: an artifact check with no render clause is the check it
   * always was, answered by the byte count and never by a render nobody asked for.
   */
  it('asks for no render on an artifact check that declared none', async () => {
    const task = makeTask(
      acceptanceState({
        acceptance: {
          checks: [{ ...deckCheck, render: undefined, path: 'workspace/deck.pptx' }],
          revisions: 1,
          declaredAtStep: 0
        }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch([finishCall('call-1'), textFrame('Done.')], log, {
      route: deckRoute(() => new Response('should never be asked', { status: 500 }))
    });
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    expect(log.calls.some((entry) => entry.includes('/document/render-proof'))).toBe(false);
    expect(acceptanceResults(probe)[0]).toMatchObject({
      passed: true,
      detail: '48000 bytes (needs at least 1024)'
    });
  });

  /**
   * The suite ran twice on a completing turn, and the test that covers the hold could not see it.
   *
   * The order is the whole defect: the expensive gate is asked before the free one. A turn that has
   * changed something and not spoken declares its checks, calls finish, has the suite run - a build
   * and a test run, up to fifteen minutes of the owner's computer - and is then held for the one
   * thing it costs nothing to ask, whether it has said anything to the user. It answers, finishes
   * again, and the same suite runs a second time against a workspace nothing has touched since.
   *
   * The existing case above (`answers with the finish summary when the turn never said anything
   * itself`) drives exactly this hold with no acceptance record at all, so the doubling has never
   * been in front of a test.
   */
  it('runs the acceptance suite once when the answer hold sends the same finish round again', async () => {
    const task = makeTask(
      acceptanceState({
        // Declared by this turn, so the finish gate reads it as evidence about this turn's work
        // rather than as an inherited record - which is the shape that reaches the suite at all.
        acceptanceTurn: 0,
        acceptance: {
          checks: [
            {
              id: 'check-1',
              kind: 'command',
              label: 'the importer test passes',
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
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        // A finish with no prose in the frame and none before it: the turn has done the work
        // through tools and said nothing, which is what the answer hold exists for.
        finishCall('call-1'),
        // The answer the hold asked for, and the same finish behind it.
        `${textFrame('The importer now reads all three columns.')}`,
        finishCall('call-2'),
        textFrame('Done.')
      ],
      log,
      { route: execRoute(0) }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // The hold really fired, so this is a test about the doubling rather than about a turn that
    // never reached it.
    expect(probe.events.some((entry) => entry.summary === 'Asked for the answer itself')).toBe(
      true
    );
    const suiteRuns = (log.runnerRequests ?? []).filter(
      (request) =>
        request.url.includes('/exec') &&
        (request.body as { executable?: string }).executable === 'pytest'
    );
    expect(suiteRuns).toHaveLength(1);
  });

  /**
   * At the size the record is allowed to be, which is the only size that measures anything.
   *
   * `MAX_ACCEPTANCE_CHECKS` is eight and `ACCEPTANCE_COMMAND_TIMEOUT_SECONDS` is 900, so eight
   * checks that each wedge compose to two hours of a turn nobody is watching - and every per-check
   * ceiling in the file is correct while that is true. A deadline test written with one check
   * measures the per-check timeout a second time and calls it a suite bound.
   */
  it('stops the suite at the aggregate deadline rather than letting eight checks compose', async () => {
    vi.useFakeTimers();
    const checks = Array.from({ length: 8 }, (_, index) => ({
      id: `check-${index + 1}`,
      kind: 'command' as const,
      label: `suite part ${index + 1}`,
      executable: 'pytest',
      args: [`--shard=${index + 1}`],
      cwd: 'workspace',
      expectExit: 0,
      timeoutSeconds: 900
    }));
    const task = makeTask(
      acceptanceState({
        acceptanceTurn: 0,
        acceptance: { checks, revisions: 1, declaredAtStep: 0 }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch([finishCall('call-1'), textFrame('Done.')], log, {
      route: (url: string): Response | undefined => {
        if (!url.includes('/exec')) return undefined;
        // Every check burns the whole per-check ceiling. Eight of them is two hours, which is the
        // composition the aggregate deadline exists to refuse.
        vi.setSystemTime(Date.now() + 900_000);
        return new Response(
          JSON.stringify({
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 900_000,
            timedOut: false
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
    });

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const attempted = (log.runnerRequests ?? []).filter((request) => request.url.includes('/exec'));
    // The first check may spend the whole budget; nothing after it may spend another.
    expect(attempted.length).toBeLessThan(8);
    const results = acceptanceResults(probe);
    expect(results).toHaveLength(8);
    expect(results.filter((result) => !result.passed).length).toBeGreaterThan(0);
    expect(results.at(-1)?.detail).toContain('the acceptance suite ran out of time');
  });
});

describe('how full the window is believed to be', () => {
  /**
   * A frame carrying the provider's own accounting for the request that produced it.
   * `stream_options.include_usage` is what puts it on the stream, and it is the number the
   * compaction trigger should be reading.
   */
  const usageFrame = (promptTokens: number, chars = 120_000): string =>
    [
      `data: ${JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            delta: {
              // Real bulk, so there is something to condense. It was 40,000 characters, which was
              // enough only while the tool catalogue was its old size: the catalogue is subtracted
              // from the input budget the trigger is a share of, so shrinking the catalogue by two
              // thousand tokens raised the threshold and the estimate stopped reaching it. That is
              // the right behaviour and the wrong calibration for a test about which *number* is
              // believed, so the fixture now clears the trigger with room rather than by a hair.
              content: 'x'.repeat(chars),
              tool_calls: [
                {
                  index: 0,
                  id: 'call-u',
                  function: { name: 'files_list', arguments: JSON.stringify({ path: 'workspace' }) }
                }
              ]
            }
          }
        ]
      })}`,
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: promptTokens, completion_tokens: 4, total_tokens: promptTokens + 4 }
      })}`,
      'data: [DONE]'
    ].join('\n\n') + '\n\n';

  /**
   * The listing the repeated call actually gets back.
   *
   * The default stub answers anything with `/file` in it with a 404, which a `files_list` URL
   * matches - so every step of these runs used to be a tool call that threw, sixty times over. That
   * is now a turn garden stops on its own, and rightly: a call that fails byte-identically is the
   * one shape the loop has no other bound for. These tests are about which number the compaction
   * trigger believes, so the workspace they run against has to work.
   */
  /*
   * A workspace that changes while the turn works in it, which is what one does.
   *
   * It answered the identical empty listing on every call, and that was load this suite could no
   * longer generate: the model side of this fixture emits the same `files_list` with the same
   * arguments on every step by design, so an unchanging listing made every step of the run a
   * byte-identical action with a byte-identical report - the exact shape `stationaryStepRun` was
   * added to stop, and it stopped it at step eight of the sixty this fixture needs. The load is what
   * was wrong, not the guard: a turn that lists the same directory sixty times and is told the same
   * thing sixty times has stopped working, and the tests below are about compaction rather than
   * about that.
   *
   * A growing listing is also the more honest fixture. It keeps the trajectory bulky, which is what
   * these tests need, and it is what the runner would really answer a turn that is writing files.
   */
  let listed = 0;
  // Reset per test, so what the runner reports is a function of the turn under test and not of how
  // many turns ran before it in this file.
  beforeEach(() => {
    listed = 0;
  });
  const listsTheWorkspace = (url: string): Response | undefined => {
    if (!url.includes('/files?')) return undefined;
    listed += 1;
    return new Response(
      JSON.stringify({
        path: 'workspace',
        entries: Array.from({ length: listed }, (_, at) => ({
          name: `note-${at}.md`,
          kind: 'file'
        }))
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  };

  // Every step answers with the same tool call and the same reported size, so the run builds the
  // history compaction needs (MIN_CONDENSED_MESSAGES is 6) and the trigger is asked the same
  // question each step. installFetch repeats its last body once the list runs out.
  const run = async (promptTokens: number) => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([usageFrame(promptTokens)], log, { route: listsTheWorkspace });
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 12 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return probe.events;
  };

  const compacted = (events: Array<{ summary: string }>): boolean =>
    events.some((entry) => entry.summary.includes('Condensed earlier work'));

  it('does not condense work the provider says is nowhere near the window', async () => {
    // The messages are bulky enough that characters-divided-by-four calls the window nearly full,
    // which is what used to force a compaction here. The provider says the request was 5k tokens.
    // Compaction is a durable, lossy edit to the trajectory, so making it on a guess that the
    // route's own accounting contradicts is work and context thrown away for nothing.
    expect(compacted(await run(5_000))).toBe(false);
  });

  it('still condenses on the estimate when the route reports no usage at all', async () => {
    // Zero is "this route told us nothing", not "the window is empty" - reading it as a real
    // measurement would switch compaction off entirely for every route that omits usage, which is
    // the failure that matters, because it ends in a refused request rather than a wasted one.
    expect(compacted(await run(0))).toBe(true);
  });

  it('condenses to a share of the same budget the trigger measured', async () => {
    /*
     * The two ends were reading different numbers. The check that decides to compact subtracts the
     * tool catalogue from the window; the target it then aims for did not, so it asked for a
     * verbatim tail that was a share of a budget nobody was working to. On a 64k model that made
     * the intended half into 0.725, and the run below shows what that costs: measured here, the old
     * arithmetic condensed once, freed a fifth of the window, and then never managed to condense
     * anything again for the rest of the task - each later attempt asking to keep a tail larger
     * than the conversation and returning nothing, while the trigger went on firing every step. The
     * same figure at both ends condenses four times and frees nearly twice as much the first time.
     *
     * A small window is the case that shows it because the catalogue is a larger share of it; the
     * fault is the same on every window.
     *
     * The bulk is the helper's own, and has to be: this ran on six thousand characters a step,
     * which is not enough to keep the window under pressure once the tool-output squeeze reaches
     * its two-thousand-character floor. Measured on that figure, the prepared request collapses
     * from 19,393 tokens to 10,808 at the step the floor bottoms out and then climbs about sixty a
     * step, so it never reaches the 20,719 trigger again and nothing is condensed for the rest of
     * the run - which is compaction correctly declining to spend a model call on a request sitting
     * at 46% of its budget, not the fault this test is about. It survived only while the catalogue
     * was a particular size, and a test that a fortieth tool can turn red is measuring the
     * catalogue. On the helper's default the prepared request stays pinned above the budget itself
     * for the whole run, which is the pressure the arithmetic below is meant to be read under.
     */
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([usageFrame(0)], log, { route: listsTheWorkspace });
    await new AgentWorker(
      {
        ...(probe.store as unknown as Record<string, unknown>),
        listModels: async () => [{ ...model, contextTokens: 64_000 }]
      } as unknown as DataStore,
      config({ TASK_MAX_STEPS: 60 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    const compactions = probe.events
      .filter((entry) => entry.summary.includes('Condensed earlier work'))
      .map(
        (entry) =>
          (
            entry.payload as {
              compaction: { estimatedTokensBefore: number; estimatedTokensAfter: number };
            }
          ).compaction
      );

    // It keeps being able to help. One compaction in sixty steps is the shape of the fault, not of
    // a task that had nothing more to condense.
    expect(compactions.length).toBeGreaterThanOrEqual(3);
    const first = compactions[0];
    expect(first).toBeDefined();
    // And the first one frees a third of the window rather than a fifth.
    expect(first!.estimatedTokensAfter).toBeLessThan(first!.estimatedTokensBefore * 0.7);
  });

  it('condenses a phase the agent declares finished on a window the budget never noticed', async () => {
    /*
     * The other trigger, and the one the budget-derived target was never sized for. An agent says a
     * phase is over when the work is over, so its declarations land far below the budget trigger -
     * anything above it was condensed before the model got its turn. Ten steps of bulk here put
     * about fifteen thousand tokens in front of a 128,000-token model whose budget-derived tail asks
     * to keep thirty thousand, so the whole window fitted under the tail and the tool answered the
     * declaration with "there is not enough superseded conversation to condense yet" - every time,
     * for the entire lower half of the range this trigger runs in. The provider reports zero prompt
     * tokens throughout, so the budget path cannot fire and nothing here is its work.
     */
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    // The first step reads somewhere nothing later touches, so what the episode remembers of it is
    // evidence about the compaction rather than about the steps that outlived it.
    const firstLook = `data: ${JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          delta: {
            content: 'x'.repeat(6_000),
            tool_calls: [
              {
                index: 0,
                id: 'call-early',
                function: {
                  name: 'files_list',
                  arguments: JSON.stringify({ path: 'workspace/early-notes' })
                }
              }
            ]
          }
        }
      ]
    })}\n\ndata: [DONE]\n\n`;
    installFetch(
      [
        firstLook,
        ...Array.from({ length: 9 }, () => usageFrame(0, 6_000)),
        toolFrame('call-declared', 'compact_context', {
          finishedPhase: 'The listing pass is finished; only the report is left.'
        }),
        textFrame('The listing pass is finished.')
      ],
      log,
      { route: listsTheWorkspace }
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 14 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const compaction = probe.events
      .filter((entry) => entry.summary.includes('Condensed a finished phase'))
      .map(
        (entry) =>
          (
            entry.payload as {
              compaction: {
                trigger: string;
                estimatedTokensBefore: number;
                estimatedTokensAfter: number;
              };
            }
          ).compaction
      )[0];
    expect(compaction).toBeDefined();
    if (!compaction) return;
    expect(compaction.trigger).toBe('agent');
    // The window really is under the budget-derived tail, or this is measuring the budget path
    // wearing the other trigger's name.
    const budget = modelInputBudget(model.contextTokens, 16_384, 0);
    expect(compaction.estimatedTokensBefore).toBeLessThan(compactionTargetTail(budget));
    expect(compaction.estimatedTokensAfter).toBeLessThan(compaction.estimatedTokensBefore * 0.8);
    // And the first step survives the taking. The paths a turn touched are read out of the window
    // when it ends, and this compaction deleted the message that first look lived on - so the
    // episode a later task recalls this run by would have had no record it ever happened.
    expect(probe.episodes.join('\n')).toContain('workspace/early-notes');
  });

  it('carries what the turn touched past a compaction the budget triggered', async () => {
    /*
     * The same claim as the test above against the other trigger, and it had none of its own:
     * deleting the capture that carries a turn's paths and commands forward turned exactly one test
     * red, the agent-declared one, so a budget compaction that stopped carrying them would have
     * shipped green. Both triggers reach the same code by different routes and only one was watched.
     *
     * The difference is who decides. Nothing is declared here - the window fills, the loop compacts
     * on its own, and the first step's listing is just as gone from it. The 64k model is the
     * helper's own pressure case, which is what keeps the window above the trigger for a whole run.
     */
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    // The first step reads somewhere no later step touches, so what the episode remembers of it is
    // evidence about the compaction rather than about the steps that outlived it.
    const firstLook = `data: ${JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          delta: {
            content: 'x'.repeat(6_000),
            tool_calls: [
              {
                index: 0,
                id: 'call-early',
                function: {
                  name: 'files_list',
                  arguments: JSON.stringify({ path: 'workspace/early-notes' })
                }
              }
            ]
          }
        }
      ]
    })}\n\ndata: [DONE]\n\n`;
    installFetch([firstLook, usageFrame(0)], log, { route: listsTheWorkspace });
    await new AgentWorker(
      {
        ...(probe.store as unknown as Record<string, unknown>),
        listModels: async () => [{ ...model, contextTokens: 64_000 }]
      } as unknown as DataStore,
      config({ TASK_MAX_STEPS: 30 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    // The budget path names itself differently from the declared one, and reading for the wrong
    // sentence is how this would pass while measuring nothing.
    const compaction = probe.events
      .filter((entry) => entry.summary.includes('Condensed earlier work'))
      .map((entry) => (entry.payload as { compaction: { trigger: string } }).compaction)[0];
    expect(compaction).toBeDefined();
    if (!compaction) return;
    expect(compaction.trigger).toBe('budget');
    expect(probe.episodes.join('\n')).toContain('workspace/early-notes');
  });
});

describe('a correction sent while the task is working', () => {
  it('places a denied reason in the first model request without allocating another turn', async () => {
    const call = { id: 'denied-copy', name: 'shell', arguments: { executable: 'cp', args: [] } };
    const task = makeTask({
      messages: [
        { role: 'user', content: 'Copy the file' },
        { role: 'assistant', content: '', toolCalls: [call] }
      ],
      step: 1,
      credits: 0,
      turn: 2,
      pending: { approvalId: 'denied-approval', toolCall: call }
    });
    task.reasoningEffort = 'auto';
    const probe = probeStore(() => task);
    let pending = true;
    const consumed: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      getApproval: async () => ({ status: 'denied', expiresAt: '2099-01-01T00:00:00.000Z' }),
      getNextQueuedTaskMessage: async () =>
        pending
          ? {
              id: 'denial-note',
              approvalId: 'denied-approval',
              taskId,
              userId,
              interrupt: true,
              promptCiphertext: encryptJson(
                {
                  prompt:
                    'I did not approve that shell request. Here is why:\n\nUse valid copy arguments.'
                },
                dataKey,
                `task-message:${taskId}`
              ),
              maxComputeCredits: 0,
              maxSpendUsd: null,
              reasoningEffort: 'low',
              modelId: 'stale',
              privacyRoute: 'external'
            }
          : null,
      consumeQueuedTaskMessageInTurn: async (input: Record<string, unknown>) => {
        consumed.push(input);
        pending = false;
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('finish-denial', 'finish', {
          summary: 'The refused copy was not run.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ additionalComputeCredits: 0 });
    expect(consumed[0]).not.toHaveProperty('additionalSpendUsd');
    const saved = decryptJson<{ messages: Array<{ role: string; content: string }>; turn: number }>(
      consumed[0]!.agentStateCiphertext as Parameters<typeof decryptJson>[0],
      dataKey,
      `task-state:${taskId}`
    );
    expect(saved.turn).toBe(2);
    expect(log.modelRequests.length).toBeGreaterThan(0);
    const messages = log.modelRequests[0]!.messages as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.role === 'tool' && m.content.includes('denied'))).toBe(true);
    expect(
      messages.find((m) => m.role === 'user' && m.content.includes('Use valid copy arguments.'))
        ?.content
    ).toContain('why:\n\nUse valid');
    expect(
      saved.messages.some(
        (m) => m.role === 'user' && m.content.includes('Use valid copy arguments.')
      )
    ).toBe(true);
    expect(task.reasoningEffort).toBe('auto');
    expect(log.calls.some((url) => url.includes('/exec'))).toBe(false);
  });

  it('joins the running turn instead of waiting for it to stop', async () => {
    // Until this existed, a message sent to a working task could only wait for it to finish. If
    // the agent had misread the request, the owner's choices were to watch it finish or cancel and
    // lose the work - the one channel for steering was unusable exactly when there was something
    // to steer.
    const task = makeTask();
    const probe = probeStore(() => task);
    const consumed: Array<Record<string, unknown>> = [];
    let pending = 1;
    Object.assign(probe.store, {
      getNextQueuedTaskMessage: async () => {
        if (pending <= 0) return null;
        pending -= 1;
        return {
          id: 'correction-1',
          taskId,
          userId,
          promptCiphertext: encryptJson(
            { prompt: 'Stop - use Postgres, not SQLite.', attachments: ['workspace/schema.sql'] },
            dataKey,
            `task-message:${taskId}`
          ),
          modelId: model.id,
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 5,
          maxSpendUsd: null,
          resourceClass: 'task_compute',
          reservationKey: 'r',
          status: 'queued',
          interrupt: true,
          createdAt: '2026-07-01T00:00:00.000Z',
          promotedAt: null
        };
      },
      consumeQueuedTaskMessageInTurn: async (input: Record<string, unknown>) => {
        consumed.push(input);
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'files_list', { path: 'workspace' }),
        toolFrame('call-2', 'files_list', { path: 'workspace' }),
        textFrame('Done.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // It was taken into the turn, and the credit ceiling was raised by what it reserved - without
    // that the loop trips its own budget on the very next iteration.
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ messageId: 'correction-1', additionalComputeCredits: 5 });
    expect(
      decryptJson(
        consumed[0]!.userMessageCiphertext as Parameters<typeof decryptJson>[0],
        dataKey,
        `task-event:${taskId}`
      )
    ).toMatchObject({
      messageId: 'correction-1',
      markdown: 'Stop - use Postgres, not SQLite.',
      attachments: ['workspace/schema.sql']
    });

    // And it reached the provider as the owner's own words, in the same turn.
    const sent = log.modelRequests.at(-1)?.messages as Array<{ role: string; content: string }>;
    expect(
      sent.some(
        (message) =>
          message.role === 'user' &&
          message.content.includes('use Postgres') &&
          message.content.includes('workspace/schema.sql')
      )
    ).toBe(true);
    // The turn was kept: the work done before the correction is still in the window.
    expect(sent.some((message) => message.role === 'tool')).toBe(true);
  });

  it('leaves an ordinary follow-up queued, because that is a different intention', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const consumed: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      getNextQueuedTaskMessage: async () => ({
        id: 'followup-1',
        taskId,
        userId,
        promptCiphertext: encryptJson(
          { prompt: 'Then deploy it' },
          dataKey,
          `task-message:${taskId}`
        ),
        modelId: model.id,
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 5,
        maxSpendUsd: null,
        resourceClass: 'task_compute',
        reservationKey: 'r',
        status: 'queued',
        interrupt: false,
        createdAt: '2026-07-01T00:00:00.000Z',
        promotedAt: null
      }),
      consumeQueuedTaskMessageInTurn: async (input: Record<string, unknown>) => {
        consumed.push(input);
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [toolFrame('call-1', 'files_list', { path: 'workspace' }), textFrame('Done.')],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    expect(consumed).toHaveLength(0);
  });
});

describe('queued message spending', () => {
  it('carries the approved spend cap into a queued follow-up turn', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const promoted: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      getNextQueuedTaskMessage: async () =>
        promoted.length
          ? null
          : {
              id: 'funded-followup',
              taskId,
              userId,
              promptCiphertext: encryptJson(
                { prompt: 'Check the saved result next.', attachments: ['workspace/result.csv'] },
                dataKey,
                `task-message:${taskId}`
              ),
              modelId: model.id,
              privacyRoute: 'provider_zdr',
              maxComputeCredits: 5,
              maxSpendUsd: 0.25,
              resourceClass: 'task_compute',
              reservationKey: 'funded-followup-reservation',
              status: 'queued',
              interrupt: false,
              createdAt: '2026-07-01T00:00:00.000Z',
              promotedAt: null
            },
      promoteQueuedTaskMessage: async (input: Record<string, unknown>) => {
        promoted.push(input);
        return task;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('finish-funded-turn', 'finish', {
          summary: 'The explanation is complete.',
          verification: {
            status: 'not_applicable',
            reason: 'An explanation requires no execution.'
          }
        })
      ],
      log
    );
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret).run(task);

    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      messageId: 'funded-followup',
      additionalComputeCredits: 5,
      additionalSpendUsd: 0.25
    });
    expect(
      decryptJson(
        promoted[0]!.userMessageCiphertext as Parameters<typeof decryptJson>[0],
        dataKey,
        `task-event:${taskId}`
      )
    ).toMatchObject({
      messageId: 'funded-followup',
      markdown: 'Check the saved result next.',
      attachments: ['workspace/result.csv']
    });
    const next = decryptJson<{
      reservationKey: string;
      messages: Array<{ role: string; content: string }>;
    }>(promoted[0]?.agentStateCiphertext as Parameters<typeof decryptJson>[0], dataKey);
    expect(next.reservationKey).toBe('funded-followup-reservation');
    expect(next.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(next.messages.at(-1)?.content).toContain('Check the saved result next.');
    expect(next.messages.at(-1)?.content).toContain('workspace/result.csv');
  });

  it.each([false, true])(
    'consumes an interrupt before checking spend while preserving an owner-wide cap: %s',
    async (ownerCapReached) => {
      const task = makeTask();
      const probe = probeStore(() => task);
      const order: string[] = [];
      let taskCap = 0.35;
      let consumed = false;
      Object.assign(probe.store, {
        getNextQueuedTaskMessage: async (_taskId: string, options?: { interruptOnly?: boolean }) =>
          consumed
            ? null
            : !options?.interruptOnly
              ? {
                  id: 'ordinary-followup-ahead',
                  taskId,
                  interrupt: false
                }
              : {
                  id: 'funded-correction',
                  taskId,
                  userId,
                  promptCiphertext: encryptJson(
                    { prompt: 'Run the existing tests and finish.' },
                    dataKey,
                    `task-message:${taskId}`
                  ),
                  modelId: model.id,
                  privacyRoute: 'provider_zdr',
                  maxComputeCredits: 5,
                  maxSpendUsd: 0.25,
                  resourceClass: 'task_compute',
                  reservationKey: 'funded-correction-reservation',
                  status: 'queued',
                  interrupt: true,
                  createdAt: '2026-07-01T00:00:00.000Z',
                  promotedAt: null
                },
        consumeQueuedTaskMessageInTurn: async (input: { additionalSpendUsd?: number }) => {
          order.push('consume');
          taskCap += input.additionalSpendUsd ?? 0;
          consumed = true;
          return true;
        },
        spendGuard: async (input: { estimateUsd: number }) => {
          order.push('spend');
          const blockedBy = ownerCapReached
            ? 'daily'
            : 0.34544265 + input.estimateUsd > taskCap
              ? 'task'
              : null;
          return {
            outcome: blockedBy ? 'deny' : 'allow',
            estimateUsd: input.estimateUsd,
            blockedBy,
            warnedBy: [],
            reason: null,
            windows: blockedBy
              ? [
                  {
                    name: blockedBy,
                    spentUsd: 0.34544265,
                    pendingUsd: 0,
                    capUsd: ownerCapReached ? 0.35 : taskCap,
                    warnAtUsd: 0.28,
                    projectedUsd: 0.34544265 + input.estimateUsd,
                    state: 'exceeded',
                    startsAt: null,
                    endsAt: null
                  }
                ]
              : []
          };
        }
      });
      const log: FetchLog = { calls: [], modelRequests: [] };
      installFetch(
        [
          toolFrame('finish-corrected-turn', 'finish', {
            summary: 'The requested explanation is complete.',
            verification: {
              status: 'not_applicable',
              reason: 'An explanation requires no execution.'
            }
          })
        ],
        log
      );
      await new AgentWorker(probe.store, config(), masterKey, runnerSecret).run(task);

      expect(order.slice(0, 2)).toEqual(['consume', 'spend']);
      expect(taskCap).toBeCloseTo(0.6);
      if (ownerCapReached) {
        expect(log.modelRequests).toHaveLength(0);
        expect(probe.checkpoints.some((entry) => entry.status === 'paused')).toBe(true);
      } else {
        expect(log.modelRequests.length).toBeGreaterThan(0);
        const messages = log.modelRequests[0]?.messages as Array<{ role: string; content: string }>;
        expect(messages).toContainEqual({
          role: 'user',
          content: 'Run the existing tests and finish.'
        });
      }
    }
  );
});

describe('a question the agent stops to ask', () => {
  /*
   * The operating contract has always told the model to ask when a missing choice materially
   * changes the result, and until now there was nowhere to ask: `awaiting_user` was written only by
   * the approval path, so a genuine blocker came back as a finish with a not_applicable
   * verification and landed as a completion card nobody could tell from finished work - and on an
   * unattended run the box then went silent until the owner next looked.
   */
  const parked = {
    question: 'Which mailbox should the invoice go from?',
    why: 'Two are connected and the reply address changes what the client sees.',
    options: ['work@', 'billing@']
  };

  it('parks the conversation, writes the question, and rings a device', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        // Something first: a turn that has looked at nothing may not ask, which is the guard against
        // an agent that asks instead of working.
        toolFrame('call-1', 'file_read', { path: 'workspace/invoice.md' }),
        `data: ${JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-2',
                    function: { name: 'ask', arguments: JSON.stringify(parked) }
                  },
                  {
                    index: 1,
                    id: 'call-3',
                    function: {
                      name: 'file_read',
                      arguments: JSON.stringify({ path: 'workspace/terms.md' })
                    }
                  }
                ]
              }
            }
          ]
        })}\n\ndata: [DONE]\n\n`,
        textFrame('Never reached.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/file?')
            ? new Response(JSON.stringify({ content: 'Invoice for March' }), {
                headers: { 'content-type': 'application/json' }
              })
            : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 6 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // The three things the approval path does, done the same way rather than a second mechanism.
    const asked = probe.events.filter((entry) => entry.kind === 'question_asked');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.payload).toMatchObject(parked);
    expect(probe.notifications).toEqual([{ kind: 'agent_message', message: parked.question }]);
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'awaiting_user', clearLease: true });

    // No approval was raised, and nothing about it is dressed as one: there is no decision to bind
    // arguments to and no yes or no that would answer "which mailbox".
    expect(probe.events.some((entry) => entry.kind === 'approval_requested')).toBe(false);
    // Nor did it finish. A blocker that lands as a completion card is the whole reason for this.
    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(false);

    const saved = decryptCheckpoints(probe.checkpoints).at(-1) as unknown as {
      question?: { question: string };
      questionsAsked?: number;
      messages: Array<{ role: string; toolCallId?: string; content: string }>;
    };
    expect(saved.question).toMatchObject({ question: parked.question });
    expect(saved.questionsAsked).toBe(1);
    // The call is answered before the park - a tool call with no result is a malformed window, and
    // this one is reloaded by whichever worker picks the conversation back up - and the read the
    // model proposed behind the question is deferred in writing rather than run.
    expect(saved.messages.find((message) => message.toolCallId === 'call-2')?.content).toContain(
      'waiting for the user'
    );
    expect(saved.messages.find((message) => message.toolCallId === 'call-3')?.content).toContain(
      'waiting for the user’s answer'
    );
    expect(log.calls.filter((entry) => entry.includes('terms.md'))).toHaveLength(0);
  });

  it('continues independent reads while a question is visible, then waits instead of completing', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('read-labels', 'file_read', { path: 'workspace/samples.txt' }),
        toolFrame('ask-control', 'ask', {
          ...parked,
          continueWith: 'Read the independent quality report.'
        }),
        toolFrame('read-quality', 'file_read', { path: 'workspace/quality.txt' }),
        toolFrame('finish-independent', 'finish', {
          summary: 'Independent quality review is done.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log,
      {
        route: (url) =>
          url.includes('/file?')
            ? new Response(JSON.stringify({ content: 'Quality: 98%' }), {
                headers: { 'content-type': 'application/json' }
              })
            : undefined
      }
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 6 }), masterKey, runnerSecret).run(
      task
    );
    expect(log.modelRequests).toHaveLength(4);
    expect(log.calls.some((value) => value.includes('quality.txt'))).toBe(true);
    expect(probe.events.filter((entry) => entry.kind === 'question_asked')).toHaveLength(1);
    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(false);
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'awaiting_user', clearLease: true });
    const pending = decryptCheckpoints(probe.checkpoints).at(-1) as unknown as AgentState;
    expect(pending.question).toMatchObject({
      question: parked.question,
      waiting: true,
      continueWith: 'Read the independent quality report.'
    });
    const during = log.modelRequests[2]!.messages as Array<{ content: string }>;
    expect(
      during.some((message) => message.content.includes('Pending owner question (not answered)'))
    ).toBe(true);
  });

  it('refuses a question from a turn that has looked at nothing, and keeps working', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [toolFrame('call-1', 'ask', parked), textFrame('Assumed the work address; say if not.')],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(probe.events.some((entry) => entry.kind === 'question_asked')).toBe(false);
    expect(probe.notifications).toHaveLength(0);
    expect(probe.checkpoints.some((entry) => entry.status === 'awaiting_user')).toBe(false);
    const refusal = decryptCheckpoints(probe.checkpoints)
      .at(-1)
      ?.messages.find((message) => message.toolCallId === 'call-1');
    expect(refusal?.content).toContain('has not looked at anything yet');
  });

  it('takes the answer back into the turn that asked, rather than starting a fresh one', async () => {
    const asking = {
      messages: [
        { role: 'user', content: 'Send the invoice' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-2', name: 'ask', arguments: parked }]
        },
        { role: 'tool', toolCallId: 'call-2', content: 'Asked. The conversation is parked.' }
      ],
      step: 2,
      credits: 0,
      turn: 0,
      question: { question: parked.question, askedAtStep: 2 },
      questionsAsked: 1,
      turnToolResults: { 'call-1': { name: 'files_list', success: true } }
    };
    const task = makeTask(asking);
    const probe = probeStore(() => task);
    const consumed: Array<Record<string, unknown>> = [];
    let pending = 1;
    Object.assign(probe.store, {
      getNextQueuedTaskMessage: async () => {
        if (pending <= 0) return null;
        pending -= 1;
        return {
          id: 'answer-1',
          taskId,
          userId,
          promptCiphertext: encryptJson(
            { prompt: 'billing@', attachments: ['workspace/invoice.pdf'] },
            dataKey,
            `task-message:${taskId}`
          ),
          modelId: model.id,
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 5,
          maxSpendUsd: null,
          resourceClass: 'task_compute',
          reservationKey: 'r',
          status: 'queued',
          // Deliberately not an interrupt. A correction has to be marked, because "do this next"
          // and "no, not that" cannot be told apart by timing; an answer needs no marking, because
          // the agent has stopped and said what it is waiting for.
          interrupt: false,
          createdAt: '2026-07-01T00:00:00.000Z',
          promotedAt: null
        };
      },
      consumeQueuedTaskMessageInTurn: async (input: Record<string, unknown>) => {
        consumed.push(input);
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Sent from billing@.')], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ messageId: 'answer-1', additionalComputeCredits: 5 });
    expect(
      decryptJson(
        consumed[0]!.userMessageCiphertext as Parameters<typeof decryptJson>[0],
        dataKey,
        `task-event:${taskId}`
      )
    ).toMatchObject({
      messageId: 'answer-1',
      markdown: 'billing@',
      attachments: ['workspace/invoice.pdf']
    });
    const sent = log.modelRequests.at(-1)?.messages as Array<{ role: string; content: string }>;
    // Their words, in their own role, in the same window as the question - so the turn carries on
    // with everything it had already established rather than re-deriving it from a new turn.
    expect(
      sent.some(
        (message) =>
          message.role === 'user' &&
          message.content.startsWith('billing@') &&
          message.content.includes('workspace/invoice.pdf')
      )
    ).toBe(true);
    expect(sent.some((message) => message.role === 'tool')).toBe(true);
    expect(decryptCheckpoints(probe.checkpoints).at(-1)).not.toHaveProperty('question');
  });

  it('goes back to waiting when it is re-leased before the answer arrives', async () => {
    // A worker restart, a sweep, an owner pressing Resume: whatever picks the conversation up, a
    // question with no answer yet has to return to waiting rather than carry on as though it had
    // been answered. It costs no model call at all.
    const task = makeTask({
      messages: [
        { role: 'user', content: 'Send the invoice' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-2', name: 'ask', arguments: parked }]
        },
        { role: 'tool', toolCallId: 'call-2', content: 'Asked. The conversation is parked.' }
      ],
      step: 2,
      credits: 0,
      turn: 0,
      question: { question: parked.question, askedAtStep: 2 }
    });
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Never reached.')], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(log.modelRequests).toHaveLength(0);
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'awaiting_user', clearLease: true });
  });
});

describe('an agent that asks the same question twice', () => {
  it('answers an identical read with a pointer instead of running it again', async () => {
    // A stuck agent re-runs the identical search, gets the identical answer, and spends the whole
    // step budget learning nothing. The step ceiling stops it eventually, but the run ends with the
    // work undone rather than at the point the agent should have tried something else.
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    const searches: string[] = [];
    installFetch(
      [
        toolFrame('call-1', 'code_search', { query: 'handleRequest', path: 'workspace' }),
        toolFrame('call-2', 'code_search', { query: 'handleRequest', path: 'workspace' }),
        textFrame('Done.')
      ],
      log,
      {
        route: (url) => {
          if (!url.includes('/exec')) return undefined;
          searches.push(url);
          return new Response(JSON.stringify({ stdout: '', stderr: '', exitCode: 1 }), {
            headers: { 'content-type': 'application/json' }
          });
        }
      }
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // The second identical search never reached the runner.
    expect(searches).toHaveLength(1);
    // And the model was told where the answer already is, rather than being refused silently.
    const messages = decryptCheckpoints(probe.checkpoints).at(-1)?.messages ?? [];
    const answer = messages.find((message) => message.toolCallId === 'call-2')?.content ?? '';
    expect(answer).toContain('call-1');
    expect(answer).toContain('same code_search call');
  });

  it('leaves polling alone, because repeating those is how they are meant to be used', async () => {
    // `process` is how the model is told to watch a build, and browser_snapshot takes no arguments
    // at all so every call looks identical. Deduplicating either would break the documented way to
    // use them.
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let snapshots = 0;
    installFetch(
      [
        toolFrame('call-1', 'files_list', { path: 'workspace' }),
        toolFrame('call-2', 'files_list', { path: 'workspace' }),
        textFrame('Done.')
      ],
      log,
      {
        route: (url) => {
          if (!url.includes('/files?path=')) return undefined;
          snapshots += 1;
          return new Response(JSON.stringify({ entries: [] }), {
            headers: { 'content-type': 'application/json' }
          });
        }
      }
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    // files_list is read-only but not in the set: listing a directory twice is how you notice
    // something appeared in it.
    expect(snapshots).toBe(2);
  });
});

describe('the prompt prefix a follow-up turn re-sends', () => {
  /** The messages of one recorded request, as the provider received them. */
  const requestMessages = (
    log: FetchLog,
    request: number
  ): Array<{ role: string; content: string }> =>
    (log.modelRequests[request]?.messages ?? []) as Array<{ role: string; content: string }>;

  /** How many leading messages two requests agree on, byte for byte. */
  const sharedPrefix = (
    left: Array<{ role: string; content: string }>,
    right: Array<{ role: string; content: string }>
  ): number => {
    let shared = 0;
    while (
      shared < left.length &&
      shared < right.length &&
      JSON.stringify(left[shared]) === JSON.stringify(right[shared])
    )
      shared += 1;
    return shared;
  };

  it('is byte-identical up to the point where the new turn starts talking', async () => {
    // Only the clock is faked. The run awaits real timers, and what this is about is what the
    // window looks like when a follow-up arrives some minutes after the turn before it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-01T09:12:00.000Z'));

    let task = makeTask();
    const probe = probeStore(() => task);
    const first: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Tidied.')], first);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    expect(saved?.messages.length).toBeGreaterThan(0);
    const followUp = startTurnState(saved as unknown as Record<string, unknown>, {
      prompt: 'Now archive last year’s notes too',
      turn: 1,
      reservationKey: 'reservation-2'
    });

    vi.setSystemTime(new Date('2026-07-01T09:17:00.000Z'));
    task = makeTask(followUp);
    const second: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Archived.')], second);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const opening = requestMessages(first, 0);
    const resumed = requestMessages(second, 0);
    const shared = sharedPrefix(opening, resumed);

    // The whole of the first turn's opening request is re-sent unchanged except its last message,
    // and that last message is the runtime block - the only thing in the window meant to change.
    // Every byte the provider cached for the first turn is still readable on the second.
    expect(shared).toBe(opening.length - 1);
    expect(opening.at(-1)?.content.startsWith(RUNTIME_CONTEXT_MARKER)).toBe(true);
    expect(resumed.at(-1)?.content.startsWith(RUNTIME_CONTEXT_MARKER)).toBe(true);
    // Vacuous if the clock had not moved: the point is that the volatile bytes DID change and the
    // prefix survived anyway.
    expect(resumed.at(-1)?.content).not.toBe(opening.at(-1)?.content);
    // And the first thing the second turn sends that the first did not is the first turn's own
    // reply, not a system block quietly reinserted ahead of the trajectory.
    expect(resumed[shared]?.role).not.toBe('system');
  });

  it('carries every installed system block ahead of the original request, and the runtime block behind everything', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Tidied.')], log);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const messages = requestMessages(log, 0);
    const goal = messages.findIndex((message) => message.role === 'user');
    // Every system block the harness installs belongs in front of the goal, because that is the
    // region `condensableStart` protects and the anchor breakpoint closes. The runtime block is the
    // one exception, and it is at the very end where rewriting it is free.
    expect(goal).toBeGreaterThan(0);
    expect(messages.slice(0, goal).every((message) => message.role === 'system')).toBe(true);
    expect(
      messages.slice(0, goal).some((message) => message.content.startsWith(RUNTIME_CONTEXT_MARKER))
    ).toBe(false);
    expect(messages.at(-1)?.content.startsWith(RUNTIME_CONTEXT_MARKER)).toBe(true);
  });

  it('renders the skill index in an order that opening a skill cannot change', async () => {
    /*
     * The store returns saved skills most-recently-updated first, and viewing one stamps that
     * column - so the owner opening a skill reordered this block and rewrote the front of the
     * prompt on their next turn, their own browsing paying the write premium on the whole window
     * behind it. What is rendered is an index rather than a ranking, and ids are written once and
     * never rewritten, so ordering by id costs the model nothing it was being told.
     */
    const skill = (id: string, name: string): Record<string, unknown> => ({
      id,
      enabled: true,
      status: 'active',
      pinned: false,
      documentCiphertext: encryptJson(
        { name, description: `How to ${name}` },
        dataKey,
        `workspace-skill:${workspaceId}`
      )
    });
    const rendered = async (order: Array<Record<string, unknown>>): Promise<string> => {
      const task = makeTask();
      const probe = probeStore(() => task);
      const store = {
        ...(probe.store as unknown as Record<string, unknown>),
        listWorkspaceSkills: async () => order
      } as unknown as DataStore;
      const log: FetchLog = { calls: [], modelRequests: [] };
      installFetch([textFrame('Tidied.')], log);
      await new AgentWorker(store, config(), masterKey, runnerSecret)
        .run(task)
        .catch(() => undefined);
      return (
        requestMessages(log, 0).find((message) =>
          message.content.startsWith('CURATED ENCRYPTED KNOWLEDGE')
        )?.content ?? ''
      );
    };

    const drafting = skill('skill-a', 'draft the weekly note');
    const filing = skill('skill-b', 'file the receipts');
    const before = await rendered([drafting, filing]);
    // The owner opens the second one, so the store hands it back first from here on.
    const after = await rendered([filing, drafting]);

    expect(before).toContain('draft the weekly note');
    expect(before.indexOf('skill-a')).toBeLessThan(before.indexOf('skill-b'));
    expect(after).toBe(before);
  });

  it('leaves the reviewed block where it is when a resume cannot rebuild the memory pack', async () => {
    /*
     * The two recalled blocks have a fixed order - what the owner approved, then what recall found -
     * and the pack's own comment says so. The knowledge block used to be spliced out of the window
     * and re-inserted at the end of the leading system run, which puts it *after* the pack; the
     * pack's injector happened to do the same dance a few lines later and put it back, so the two
     * moves cancelled and nothing showed. They stop cancelling the moment the pack cannot be
     * rebuilt - a store that is briefly unavailable on a follow-up, which is the one case that path
     * exists for - and then the two blocks swap for the rest of the task and every cached byte
     * behind them is written again. Replacing the block where it already sits removes the
     * dependence on one bug undoing another.
     */
    const item = {
      id: 'memory-item-1',
      layer: 'item' as const,
      kind: 'fact' as const,
      trust: 'stated' as const,
      status: 'active' as const,
      observedAt: '2026-06-01T00:00:00.000Z',
      validFrom: '2026-06-01T00:00:00.000Z',
      validTo: null,
      subjectKey: null,
      predicate: null,
      tokensEst: 20,
      score: 1,
      documentCiphertext: encryptJson(
        { title: 'Where notes live', body: 'Notes live under workspace/notes' },
        dataKey,
        memoryItemAad(workspaceId)
      )
    };
    let packRecord: Record<string, unknown> | null = null;
    let packReadable = true;
    let task = makeTask();
    const probe = probeStore(() => task);
    const store = {
      ...(probe.store as unknown as Record<string, unknown>),
      getMemoryPack: async () => {
        if (!packReadable) throw new Error('memory store unavailable');
        return packRecord;
      },
      recallMemoryCandidates: async () => [item],
      saveMemoryPack: async (input: Record<string, unknown>) => {
        packRecord = {
          ...input,
          itemIds: [...(input.itemIds as string[])],
          createdAt: '2026-07-01T00:00:00.000Z'
        };
        return packRecord;
      }
    } as unknown as DataStore;

    const first: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Tidied.')], first);
    await new AgentWorker(store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const opening = requestMessages(first, 0);
    const knowledgeAt = opening.findIndex((message) =>
      message.content.startsWith('CURATED ENCRYPTED KNOWLEDGE')
    );
    const packAt = opening.findIndex((message) => message.content.startsWith(MEMORY_PACK_MARKER));
    // Vacuous unless both blocks are actually there and in that order.
    expect(knowledgeAt).toBeGreaterThan(0);
    expect(packAt).toBe(knowledgeAt + 1);

    packReadable = false;
    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    task = makeTask(
      startTurnState(saved as unknown as Record<string, unknown>, {
        prompt: 'Now archive last year’s notes too',
        turn: 1,
        reservationKey: 'reservation-2'
      })
    );
    const second: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Archived.')], second);
    await new AgentWorker(store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const resumed = requestMessages(second, 0);
    expect(
      resumed.findIndex((message) => message.content.startsWith('CURATED ENCRYPTED KNOWLEDGE'))
    ).toBe(knowledgeAt);
    expect(resumed.findIndex((message) => message.content.startsWith(MEMORY_PACK_MARKER))).toBe(
      packAt
    );
    expect(sharedPrefix(opening, resumed)).toBeGreaterThan(packAt);
  });

  it('ranks the curated knowledge block once, so a follow-up does not reshuffle it', async () => {
    // Two entries the two requests would rank in opposite orders: the first shares a word with the
    // opening request, the second with the follow-up. The block says it is frozen for the run, and
    // this is what makes that true.
    const memory = (id: string, content: string): Record<string, unknown> => ({
      id,
      target: 'workspace',
      contentCiphertext: encryptJson({ content }, dataKey, `workspace-memory:${workspaceId}`),
      updatedAt: '2026-06-01T00:00:00.000Z'
    });
    let task = makeTask();
    const probe = probeStore(() => task);
    const store = {
      ...(probe.store as unknown as Record<string, unknown>),
      listWorkspaceMemories: async () => [
        memory('memory-notes', 'Notes live under workspace/notes'),
        memory('memory-archive', 'Archive anything older than a year into workspace/archive')
      ]
    } as unknown as DataStore;

    const first: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Tidied.')], first);
    await new AgentWorker(store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    task = makeTask(
      startTurnState(saved as unknown as Record<string, unknown>, {
        prompt: 'Now archive last year’s notes too',
        turn: 1,
        reservationKey: 'reservation-2'
      })
    );
    const second: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Archived.')], second);
    await new AgentWorker(store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const knowledge = (log: FetchLog): string =>
      requestMessages(log, 0).find((message) =>
        message.content.startsWith('CURATED ENCRYPTED KNOWLEDGE')
      )?.content ?? '';
    expect(knowledge(first)).toContain('workspace/notes');
    expect(knowledge(first)).toContain('workspace/archive');
    expect(knowledge(second)).toBe(knowledge(first));
  });
  it('freezes the reviewed block against the wall clock, not only against the ranking', async () => {
    /*
     * The header says "frozen for this run", and the ranking beneath it was anchored to
     * `task.createdAt` to make that true. The filter above the ranking was not: it took the wall
     * clock, so an entry whose `validUntil` fell between the task starting and the current step was
     * in the block on one request and gone from the next - the whole preamble rewritten mid-task by
     * a boundary nobody crossed on purpose, and every byte behind it re-billed. Two builds either
     * side of that instant, asserted byte-identical.
     */
    vi.useFakeTimers({ toFake: ['Date'] });
    const expiring = {
      id: 'memory-expiring',
      target: 'workspace',
      validUntil: '2026-07-01T06:00:00.000Z',
      contentCiphertext: encryptJson(
        {
          content: 'Tidy the notes into workspace/archive before the loan laptop goes back',
          validFrom: '2026-06-01T00:00:00.000Z',
          validUntil: '2026-07-01T06:00:00.000Z'
        },
        dataKey,
        `workspace-memory:${workspaceId}`
      ),
      updatedAt: '2026-06-01T00:00:00.000Z'
    };
    const knowledgeAt = async (wallClock: string): Promise<string> => {
      vi.setSystemTime(new Date(wallClock));
      const task = makeTask();
      const probe = probeStore(() => task);
      const store = {
        ...(probe.store as unknown as Record<string, unknown>),
        listWorkspaceMemories: async () => [expiring]
      } as unknown as DataStore;
      const log: FetchLog = { calls: [], modelRequests: [] };
      installFetch([textFrame('Tidied.')], log);
      await new AgentWorker(store, config(), masterKey, runnerSecret)
        .run(task)
        .catch(() => undefined);
      return (
        requestMessages(log, 0).find((message) =>
          message.content.startsWith('CURATED ENCRYPTED KNOWLEDGE')
        )?.content ?? ''
      );
    };

    // The task was created at 00:00 and the entry expires at 06:00, so these two straddle it.
    const before = await knowledgeAt('2026-07-01T05:59:00.000Z');
    const after = await knowledgeAt('2026-07-01T06:01:00.000Z');

    // Vacuous unless the entry reached the block at all at the anchored instant.
    expect(before).toContain('Tidy the notes into workspace/archive');
    expect(after).toBe(before);
  });

  it('survives the workspace brief being rewritten between turns, because the brief sits last', async () => {
    /*
     * The brief is a plain workspace file and any turn may write it - the agent keeping its own
     * journal is the commonest writer of all. It used to be spliced in as the FIRST preamble block,
     * ahead of the reviewed knowledge block and the memory pack, so one appended line to
     * `workspace/GARDEN.md` moved the divergence point to the second message of the prompt and
     * re-billed everything behind it at the write premium on the next turn. Those other two blocks
     * are frozen for the life of the task by design; the brief is the one preamble block that is
     * not, which is exactly why it belongs behind them.
     */
    let briefBody = '# Study\n- Notes live under workspace/notes\n';
    let task = makeTask();
    const probe = probeStore(() => task);
    probe.recallPack(['memory-item-1']);
    const route = (url: string): Response | undefined =>
      readPath(url) === 'workspace/GARDEN.md' ? jsonResponse({ content: briefBody }) : undefined;

    const first: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Tidied.')], first, { route });
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const opening = requestMessages(first, 0);
    const knowledgeAt = opening.findIndex((message) =>
      message.content.startsWith('CURATED ENCRYPTED KNOWLEDGE')
    );
    const packAt = opening.findIndex((message) => message.content.startsWith(MEMORY_PACK_MARKER));
    const briefAt = opening.findIndex((message) =>
      message.content.startsWith(WORKSPACE_BRIEF_MARKER)
    );
    // Vacuous unless all three blocks are in the window, with the brief behind the two frozen ones.
    expect(knowledgeAt).toBeGreaterThan(0);
    expect(packAt).toBeGreaterThan(knowledgeAt);
    expect(briefAt).toBeGreaterThan(packAt);

    // What the first turn did to it: appended a line, the way a turn keeping the journal does.
    briefBody = `${briefBody}- Receipts go in workspace/receipts\n`;
    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    task = makeTask(
      startTurnState(saved as unknown as Record<string, unknown>, {
        prompt: 'Now archive last year’s notes too',
        turn: 1,
        reservationKey: 'reservation-2'
      })
    );
    const second: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Archived.')], second, { route });
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const resumed = requestMessages(second, 0);
    // Vacuous unless the brief genuinely changed, which is the premise of the whole test.
    expect(resumed[briefAt]?.content).not.toBe(opening[briefAt]?.content);
    expect(resumed[briefAt]?.content).toContain('workspace/receipts');

    // The prefix the provider cached for the first turn still covers the operating contract, the
    // reviewed knowledge block and the memory pack, and stops exactly at the brief.
    const shared = sharedPrefix(opening, resumed);
    // Measured on this fixture: 3 messages and 14,999 of the opening request's 17,004 characters,
    // against 1 message and 12,353 characters with the brief spliced in first.
    expect(shared).toBe(briefAt);
    const cached = opening.slice(0, shared).map((message) => message.content);
    expect(cached.some((content) => content.startsWith('CURATED ENCRYPTED KNOWLEDGE'))).toBe(true);
    expect(cached.some((content) => content.startsWith(MEMORY_PACK_MARKER))).toBe(true);
    // Not merely still ahead of the brief - still at the same indices, so the bytes the provider
    // holds are addressed the same way on the second turn as on the first.
    expect(resumed.findIndex((message) => message.content.startsWith(MEMORY_PACK_MARKER))).toBe(
      packAt
    );
  });

  it('keeps the cached prefix across a republished plan, rather than shifting the trajectory', async () => {
    /*
     * `set_plan` is the tool the operating contract asks for most often - once per status change,
     * and the user watches those statuses live - so a republish is one of the commonest events in a
     * long turn. Republishing used to splice the old plan message out of wherever it sat in the
     * trajectory and push a new one at the tail, which moves every message behind the old position
     * by one and diverges the prompt there. Written over where it already sits, the divergence is
     * the plan message itself and nothing else.
     */
    let planVersion = 0;
    let planRecord: Record<string, unknown> | null = null;
    const task = makeTask();
    const probe = probeStore(() => task);
    const store = {
      ...(probe.store as unknown as Record<string, unknown>),
      getLatestTaskPlan: async () => planRecord,
      createTaskPlan: async (input: Record<string, unknown>) => {
        if (input.expectedVersion !== planVersion) throw new Error('plan_version_conflict');
        planVersion += 1;
        planRecord = {
          id: `plan-${planVersion}`,
          taskId,
          version: planVersion,
          branchName: input.branchName,
          stepsCiphertext: input.stepsCiphertext,
          createdBy: 'agent',
          createdAt: '2026-07-01T00:00:00.000Z'
        };
        return planRecord;
      }
    } as unknown as DataStore;
    const plan = (...steps: Array<[string, string]>): Record<string, unknown> => ({
      branchName: 'Main',
      steps: steps.map(([title, status]) => ({ title, status }))
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame(
          'call-1',
          'set_plan',
          plan(['Read the notes directory', 'in_progress'], ['File anything older', 'pending'])
        ),
        toolFrame('call-2', 'files_list', { path: 'workspace' }),
        toolFrame(
          'call-3',
          'set_plan',
          plan(['Read the notes directory', 'completed'], ['File anything older', 'in_progress'])
        ),
        toolFrame('call-4', 'files_list', { path: 'workspace/notes' }),
        toolFrame(
          'call-5',
          'set_plan',
          plan(['Read the notes directory', 'completed'], ['File anything older', 'completed'])
        ),
        toolFrame('call-6', 'files_list', { path: 'workspace/archive' }),
        textFrame('Filed.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/files?path=')
            ? jsonResponse({ entries: [{ name: 'march.md', kind: 'file', bytes: 120 }] })
            : undefined
      }
    );

    await new AgentWorker(store, config({ TASK_MAX_STEPS: 8 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // Vacuous unless the run got far enough to republish twice on top of the first publication.
    expect(planVersion).toBe(3);

    /** The header line of the plan block one request carried, or '' when it carried none. */
    const planHeader = (request: number): string =>
      requestMessages(log, request)
        .find((message) => message.content.startsWith('ACTIVE USER-VISIBLE PLAN'))
        ?.content.split('\n')[0] ?? '';
    const republished = log.modelRequests
      .map((_request, index) => index)
      .filter(
        (index) =>
          index > 0 && planHeader(index) !== '' && planHeader(index) !== planHeader(index - 1)
      );
    // The first arrival and the two republishes, found by the block's own version rather than by
    // counting steps - a fixture that silently stopped republishing would otherwise pass.
    expect(republished).toHaveLength(3);

    // One per step, in step order. The extra cost row with no context is the closing handoff call,
    // which prepares its own window and is not a step of the loop.
    const breakpoints = probe.events
      .filter((entry) => entry.kind === 'cost' && (entry.payload as { context?: unknown }).context)
      .map(
        (entry) =>
          (entry.payload as { context: { cacheBreakpoints: number } }).context.cacheBreakpoints
      );
    expect(breakpoints).toHaveLength(log.modelRequests.length - 1);
    for (const index of republished) {
      // A republish must not cost a breakpoint. Marking fewer prefixes on the one step whose prefix
      // just moved is how a cache stops being read at exactly the moment it matters.
      expect(breakpoints[index]).toBeGreaterThanOrEqual(breakpoints[index - 1] ?? 0);
      // And the divergence is at the plan message and nowhere ahead of it: everything the previous
      // request sent before the old plan block is re-sent byte for byte.
      const previous = requestMessages(log, index - 1);
      const planAt = previous.findIndex((message) =>
        message.content.startsWith('ACTIVE USER-VISIBLE PLAN')
      );
      if (planAt < 0) continue;
      expect(sharedPrefix(previous, requestMessages(log, index))).toBe(planAt);
    }
  });
});

/*
 * Measured on a live run: writing a two-line haiku produced a transcript whose visible content was
 * an amber "no undo point" card, a red "file_write failed" the agent had already recovered from,
 * and a cost line. The verse was third. Almost every warning the worker writes is a note to itself,
 * and the transcript now folds those into the work log - so the few that are genuinely the owner's
 * business have to say so at the site that raises them.
 */
describe('the warnings that are the owner’s business', () => {
  const ownerFlag = (entry: { payload: unknown } | undefined): unknown =>
    (entry?.payload as { owner?: unknown } | undefined)?.owner;

  it('raises an action that no longer matches what the owner approved', async () => {
    const approved = { executable: 'rm', args: ['-rf', 'workspace/old'] };
    const attempted = { executable: 'rm', args: ['-rf', 'workspace'] };
    const task = makeTask({
      messages: [
        { role: 'user', content: 'Clear the old folder' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-s', name: 'shell', arguments: attempted }]
        }
      ],
      step: 1,
      credits: 0,
      pending: {
        approvalId: 'approval-1',
        toolCall: { id: 'call-s', name: 'shell', arguments: attempted }
      }
    });
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      getApproval: async () => ({
        id: 'approval-1',
        status: 'approved',
        previewHash: approvalPreviewHash(dataKey, 'shell', approved),
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('I will not run that.')], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const refusal = probe.events.find((entry) =>
      entry.summary.startsWith('Refused: this action no longer matches')
    );
    expect(refusal?.kind).toBe('warning');
    expect(ownerFlag(refusal)).toBe(true);
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
  });

  it('raises the answer it will not continue, and not the ones it will', async () => {
    const cutOff = `data: ${JSON.stringify({
      choices: [{ finish_reason: 'length', delta: { content: 'and then, ' } }]
    })}\n\ndata: [DONE]\n\n`;
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([cutOff], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 5 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const continuing = probe.events.find((entry) => entry.summary.includes('is being continued'));
    const capped = probe.events.find((entry) =>
      entry.summary.includes('was not continued automatically')
    );
    // Continuing is the harness doing its job and the owner reads the finished answer either way.
    expect(continuing?.kind).toBe('warning');
    expect(ownerFlag(continuing)).toBeUndefined();
    // Stopping is an answer handed over incomplete, which nothing else in the transcript says.
    expect(capped?.kind).toBe('warning');
    expect(ownerFlag(capped)).toBe(true);
  });

  /** A worker whose journal can be read back, which is how the two tests below read it. */
  const journalled = (): { logger: Logger; lines: string[] } => {
    vi.stubEnv('JOURNAL_STREAM', undefined);
    const lines: string[] = [];
    return {
      logger: createLogger({ level: 'info', service: 'worker', write: (line) => lines.push(line) }),
      lines
    };
  };

  it('raises the reason a task stopped without doing what was asked', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret, silentLogger).fail(
      task,
      new Error('The workspace could not be reached')
    );

    const failure = probe.events.find((entry) => entry.kind === 'error');
    expect(failure?.summary).toBe('The workspace could not be reached');
    expect(ownerFlag(failure)).toBe(true);
  });

  /**
   * The other half of the same failure, and the half the owner can actually read. The event above
   * is encrypted for good reasons; this box's owner is also its operator, and an error that needs
   * the master key to read is one they cannot diagnose.
   */
  it('writes the failure to the journal, where the owner can read it without a key', async () => {
    const task = makeTask({ messages: [], step: 12, credits: 0, turn: 2 });
    const probe = probeStore(() => task);
    const journal = journalled();

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret, journal.logger).fail(
      task,
      new GardenError('model_timeout', 'The model provider did not respond within 900 seconds'),
      903_000
    );

    expect(JSON.parse(journal.lines[0]!)).toMatchObject({
      level: 'error',
      event: 'task.failed',
      taskId,
      turn: 2,
      step: 12,
      durationMs: 903_000,
      code: 'model_timeout'
    });
    // The sentence the model provider wrote is in the encrypted event and nowhere else.
    expect(journal.lines[0]).not.toContain('did not respond');
  });

  it('leaves that record behind even when the store is what failed', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      appendTaskEvent: async () => {
        throw new Error('database is not accepting connections');
      }
    });
    const journal = journalled();

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret, journal.logger)
      .fail(task, new GardenError('workspace_unreachable', 'The workspace could not be reached'))
      .catch(() => undefined);

    expect(journal.lines[0]).toContain('workspace_unreachable');
  });
});

/**
 * The owner typed a correction into a turn that was going wrong, was told the agent would pick it
 * up at its next step, and then the turn died. There was no next step. These are the three ways
 * that can end, and the only one of them that used to exist was the middle of the night.
 */
describe('a correction the turn it was sent to did not survive', () => {
  const ownerLines = (probe: ReturnType<typeof probeStore>): string[] =>
    probe.events
      .filter((entry) => (entry.payload as { owner?: unknown } | undefined)?.owner === true)
      .map((entry) => entry.summary);

  /** One message waiting, encrypted the way the API writes it. */
  const waiting = (prompt: string): Record<string, unknown> => ({
    id: 'message-1',
    taskId,
    userId,
    promptCiphertext: encryptJson({ prompt }, dataKey, `task-message:${taskId}`),
    modelId: model.id,
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 2,
    maxSpendUsd: null,
    resourceClass: 'medium',
    reservationKey: `task:${taskId}:message:message-1:reservation`,
    status: 'undelivered',
    interrupt: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    promotedAt: null
  });

  it('carries it into a fresh start rather than letting the failure end it', async () => {
    const task = makeTask({ messages: [], step: 4, credits: 0, turn: 1 });
    const probe = probeStore(() => task);
    const released: string[] = [];
    let requeued: Record<string, unknown> | null = null;
    Object.assign(probe.store, {
      requeueTaskForQueuedMessage: async (input: Record<string, unknown>) => {
        requeued = input;
        return { attempt: 1, queuedMessageCount: 1 };
      },
      transitionUsage: async (key: string) => {
        released.push(key);
      }
    });

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret, silentLogger).fail(
      task,
      new GardenError('model_timeout', 'The model provider did not respond within 900 seconds')
    );

    expect(requeued).toEqual({ id: taskId, workerId: 'worker-test' });
    // Not written off, so nothing here marks it finished or hands back the credits the next start
    // is about to spend.
    expect(probe.checkpoints).toEqual([]);
    expect(released).toEqual([]);
    expect(ownerLines(probe)).toEqual([
      'The model provider did not respond within 900 seconds',
      'This turn stopped before the message you sent could be started. It is still queued and this conversation is going back in the queue to carry on from where it stopped - start 2 of 6.'
    ]);
  });

  /**
   * The other end of the same bound. Nothing decides here that this particular failure is hopeless
   * - the box does not know that - it decides only that the queue has stopped handing this
   * conversation out, which it can read off the attempt count it already keeps.
   */
  it('refuses it out loud, in the owner’s own words, once nothing will start it again', async () => {
    // At the ceiling, which is where the store's refusal to requeue comes from in real life.
    const task = { ...makeTask({ messages: [], step: 4, credits: 0, turn: 1 }), attempt: 6 };
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      requeueTaskForQueuedMessage: async () => null,
      strandQueuedTaskMessages: async () => [waiting('No, leave the invoices alone')]
    });

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret, silentLogger).fail(
      task,
      new GardenError('model_timeout', 'The model provider did not respond within 900 seconds')
    );

    expect(probe.checkpoints).toMatchObject([{ status: 'failed', clearLease: true }]);
    expect(ownerLines(probe)[1]).toBe(
      'Your message was not started, and garden is not going to start it on its own. This conversation was started 6 times without finishing. What you sent was: "No, leave the invoices alone" Send it again to try.'
    );
    // Their words in the payload as well as the sentence, so sending it again need not mean
    // typing it again.
    expect(probe.events.at(-1)?.payload).toMatchObject({
      code: 'queued_message_undelivered',
      markdown: 'No, leave the invoices alone'
    });
  });

  /**
   * A provider wall is the one failure the box does know will repeat, and it is already paced by
   * the sweep that retries it. The message stays queued because on that path it really is still
   * waiting - so the count in the header is telling the truth and nothing here should touch it.
   */
  it('leaves a wall to the sweep that is already asking again', async () => {
    const task = makeTask({ messages: [], step: 4, credits: 0, turn: 1 });
    const probe = probeStore(() => task);
    let asked = 0;
    Object.assign(probe.store, {
      requeueTaskForQueuedMessage: async () => {
        asked += 1;
        return { attempt: 1, queuedMessageCount: 1 };
      },
      strandQueuedTaskMessages: async () => {
        asked += 1;
        return [waiting('Use the other account')];
      }
    });

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret, silentLogger).fail(
      task,
      new GardenError('provider_quota_exhausted', 'The provider is out of quota')
    );

    expect(asked).toBe(0);
    expect(probe.checkpoints).toMatchObject([{ status: 'awaiting_resource' }]);
  });
});

/**
 * The batch of reads a frontier model opens a task with.
 *
 * Every call in it used to wait for the one in front of it to cross to the runner and come back,
 * which is three round trips of nothing on a four-read batch. What must not change is anything the
 * loop decides: the stop check, the floor's verdict on each call, and above all the order the
 * results land in the window - a turn whose window depends on which read finished first is a turn
 * that cannot be reproduced.
 */
describe('reads proposed together', () => {
  const reads = (
    ...names: string[]
  ): Array<{ id: string; name: string; args: Record<string, unknown> }> =>
    names.map((name, index) => ({
      id: `call-${index + 1}`,
      name: 'file_read',
      args: { path: `workspace/${name}.txt` }
    }));

  it('holds all four open at once and still answers them in the declared order', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    const openers: Array<() => void> = [];
    let inFlight = 0;
    installFetch(
      [batchFrame(reads('alpha', 'bravo', 'charlie', 'delta')), textFrame('Read them.')],
      log,
      {
        route: (url) => {
          // Only the batch's own reads. The turn opens by looking for the workspace's durable
          // instructions, and holding that one would hang the run before the model is even asked.
          if (!url.includes('/file?') || !readPath(url).endsWith('.txt')) return undefined;
          const path = readPath(url);
          let open = (): void => undefined;
          const body = heldBody(
            JSON.stringify({ marker: path }),
            new Promise<void>((resolve) => {
              open = resolve;
            })
          );
          openers.push(open);
          inFlight += 1;
          // Nothing is answered until every read in the run has been dispatched, so this test can
          // only finish if they really were in flight together - and they are then answered
          // backwards, so a window that came out in the declared order cannot have got there by
          // following the order the runner happened to reply in.
          if (inFlight === 4) for (const release of [...openers].reverse()) release();
          return body;
        }
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(inFlight).toBe(4);
    const answered = toolMessages(probe);
    expect(answered.map((message) => message.toolCallId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
      'call-4'
    ]);
    for (const [index, name] of ['alpha', 'bravo', 'charlie', 'delta'].entries())
      expect(answered[index]?.content).toContain(`workspace/${name}.txt`);
    // And the timeline reads in the same order, because that is the record the owner scrolls.
    expect(
      probe.events
        .filter((entry) => entry.kind === 'tool_result')
        .map((entry) => (entry.payload as { toolCallId?: string }).toolCallId)
    ).toEqual(['call-1', 'call-2', 'call-3', 'call-4']);
    // Three state writes for the whole turn: one for the run, then the step's own and the closing
    // one. Four reads that would each have written twice had they been anything but reads now cost
    // a single point at which everything already fetched is durable.
    expect(probe.checkpoints.filter((input) => input.agentStateCiphertext).length).toBe(3);
  });

  it('keeps the answers that came back when one of the run throws', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [batchFrame(reads('alpha', 'missing', 'charlie')), textFrame('Two of three.')],
      log,
      {
        route: (url) => {
          if (!url.includes('/file?')) return undefined;
          const path = readPath(url);
          if (path.includes('missing'))
            return new Response(
              JSON.stringify({ error: { code: 'file_not_found', message: 'no such file' } }),
              { status: 404, headers: { 'content-type': 'application/json' } }
            );
          return new Response(JSON.stringify({ marker: path }), {
            headers: { 'content-type': 'application/json' }
          });
        }
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const answered = toolMessages(probe);
    expect(answered.map((message) => message.toolCallId)).toEqual(['call-1', 'call-2', 'call-3']);
    // The one that failed says so, in its own place, and the two that came back are still here -
    // a run that threw away three good reads because the second one was a typo would be a worse
    // loop than the one that ran them one at a time.
    expect(answered[0]?.content).toContain('workspace/alpha.txt');
    expect(answered[1]?.content).toContain('Tool failed');
    expect(answered[2]?.content).toContain('workspace/charlie.txt');
    expect(probe.events.filter((entry) => entry.kind === 'error')).toHaveLength(1);
  });

  it('runs the reads, then stops at the call the floor wants a card for', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const approvals: Array<Record<string, unknown>> = [];
    const store = {
      ...probe.store,
      parkTaskForApproval: async (input: Record<string, unknown>) => {
        approvals.push(input);
        await probe.store.updateTask({
          ...input,
          id: input.taskId,
          status: 'awaiting_user',
          clearLease: true
        } as Parameters<DataStore['updateTask']>[0]);
        return true;
      }
    } as unknown as DataStore;
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        batchFrame([
          ...reads('alpha', 'bravo'),
          {
            id: 'call-3',
            name: 'schedule',
            args: { action: 'create', title: 'Nightly', prompt: 'Check the feed', spec: {} }
          },
          { id: 'call-4', name: 'file_read', args: { path: 'workspace/delta.txt' } }
        ]),
        textFrame('Waiting on you.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/file?')
            ? new Response(JSON.stringify({ marker: readPath(url) }), {
                headers: { 'content-type': 'application/json' }
              })
            : undefined
      }
    );

    await new AgentWorker(store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(approvals).toHaveLength(1);
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'awaiting_user' });
    const answered = toolMessages(probe);
    // The two reads in front of the card are answered and kept: the turn parks on the approval
    // with its reading already done, not with it thrown away.
    expect(answered[0]?.content).toContain('workspace/alpha.txt');
    expect(answered[1]?.content).toContain('workspace/bravo.txt');
    // And the read behind the card is deferred in writing rather than run, exactly as it was when
    // every call went one at a time.
    expect(answered.find((message) => message.toolCallId === 'call-4')?.content).toContain(
      'Deferred because an earlier action requires user approval'
    );
    expect(log.calls.filter((entry) => entry.includes('delta.txt'))).toHaveLength(0);
  });

  it('loses nothing when the owner presses Stop with the run in flight', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let inFlight = 0;
    const never = new Promise<void>(() => undefined);
    installFetch([batchFrame(reads('alpha', 'bravo', 'charlie')), textFrame('Stopped.')], log, {
      route: (url, init) => {
        if (!url.includes('/file?') || !readPath(url).endsWith('.txt')) return undefined;
        inFlight += 1;
        // Stopped once the whole run is out on the wire, which is the moment this is about: three
        // requests the owner has already paid for, none of them answered yet.
        if (inFlight === 3) {
          task.status = 'paused';
          // A pause clears the lease in the same statement that sets the status, and the closing
          // write is the one that saves the trajectory - a probe that left the lease on would test
          // the disowned path instead.
          task.leaseOwner = null;
        }
        return heldBody('never arrives', never, init?.signal);
      }
    });

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(inFlight).toBe(3);
    // One poll of the cancellation watch reaches every request in the run, because they all
    // inherit its signal.
    const answered = toolMessages(probe);
    expect(answered.map((message) => message.toolCallId)).toEqual(['call-1', 'call-2', 'call-3']);
    for (const message of answered) expect(message.content).toContain('Tool failed');
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'paused', clearLease: true });
    expect(probe.events.some((entry) => entry.summary === 'Task paused by user')).toBe(true);
  });
});

/**
 * A turn that runs out of steps while the job is demonstrably unfinished and demonstrably moving.
 *
 * The ceiling used to end the turn and write a handoff saying the work continues "the moment the
 * user replies" - which on a scheduled run at three in the morning is eight hours away. These are
 * about the harness taking that decision itself, and about how much harder it is to get a yes than
 * a no: the acceptance record must exist, the harness itself must have just watched it fail, the
 * turn must still be changing things, and the owner must not have stopped it.
 */
describe('a turn that finishes the job rather than the budget', () => {
  const failingCheck = {
    checks: [
      {
        id: 'check-1',
        kind: 'command',
        label: 'the importer test passes',
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

  /** A turn mid-job: it declared its checks, and it has already changed something. */
  const workingState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    messages: [
      { role: 'user', content: 'Fix the importer' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-0', name: 'file_write', arguments: {} }]
      },
      { role: 'tool', toolCallId: 'call-0', content: 'ok' }
    ],
    step: 0,
    credits: 0,
    mutated: true,
    mutatedBeyondProse: true,
    turnToolResults: { 'call-0': { name: 'file_write', success: true, mutating: true } },
    acceptance: failingCheck,
    acceptanceTurn: 0,
    ...over
  });

  const exec = (exitCode: number) => (url: string) =>
    url.includes('/exec')
      ? new Response(
          JSON.stringify({
            exitCode,
            stdout: '',
            stderr: exitCode === 0 ? '' : 'AssertionError: expected 3 rows, found 0',
            durationMs: 5,
            timedOut: false
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      : undefined;

  it('renews its own budget when the harness watches its checks fail, and says so', async () => {
    const task = makeTask(workingState());
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        textFrame('Working.'),
        textFrame('Still working.'),
        textFrame('Carrying on.'),
        textFrame('Nearly there.'),
        toolFrame('call-hand', 'finish', {
          summary: 'The importer reads two of three columns; the third is still failing.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log,
      { route: exec(1) }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 1 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    // Two budgets of two steps, and then the one closing call - which the budget has never counted.
    expect(log.modelRequests).toHaveLength(5);
    const continued = probe.events.find((entry) =>
      entry.summary.startsWith('Continuing on its own')
    );
    expect(continued?.summary).toContain('(1 of 1)');
    expect(continued?.summary).toContain('1 of 1 acceptance check still fails after 2 steps');
    expect(continued?.payload).toMatchObject({ continuation: 1, step: 2, maxSteps: 4 });
    // The model is told what the harness saw, not that it was given more rope.
    const renewed = ((log.modelRequests[2]?.messages ?? []) as Array<{ content: string }>)
      .map((message) => message.content)
      .join('\n');
    expect(renewed).toContain('BUDGET RENEWED (1 of 1) after 2 steps');
    expect(renewed).toContain('AssertionError: expected 3 rows, found 0');
    expect(renewed).toContain('This is the last renewal there is');
    // ...and the wind-down it was given for the first budget is gone, replaced by one counting down
    // to the ceiling that is actually in force. Carrying the old one would leave the model holding a
    // standing instruction to stop starting work, which is exactly what it has just been told not to
    // do - and would cost the renewed budget any warning of its own ending.
    expect(renewed.split('FINAL STEPS').length - 1).toBe(1);
    expect(renewed).toContain("2 of this turn's 4 steps remain");
    // It still ends where the owner can act on it, with the ceiling it actually worked to.
    const ceiling = probe.events.find(
      (entry) => entry.kind === 'warning' && entry.summary.includes('whole step budget')
    );
    expect(ceiling?.payload).toMatchObject({ owner: true, maxSteps: 4, continuations: 1 });
  });

  it('stops the moment its own definition of done is satisfied', async () => {
    const task = makeTask(workingState());
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        textFrame('Working.'),
        textFrame('Still working.'),
        toolFrame('call-hand', 'finish', {
          summary: 'The importer reads all three columns.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log,
      { route: exec(0) }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    // The checks the model wrote before the work all pass, which is the strongest evidence this box
    // has that the job is done - so the budget is not renewed and the turn spends its closing call.
    expect(
      probe.events.some(
        (entry) => entry.summary === 'Stopping at the step limit: every acceptance check now passes'
      )
    ).toBe(true);
    expect(log.modelRequests).toHaveLength(3);
  });

  it('is stopped by the same Stop, on the last step of the budget it would have renewed', async () => {
    const task = makeTask(workingState());
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        textFrame('Working.'),
        () => {
          // Stop, pressed while the last step of the budget was still streaming. Nothing about a
          // turn that can renew itself may make it harder to stop than one that cannot: the same
          // button, at the same moment, has to end it.
          task.status = 'paused';
          task.leaseOwner = null;
          return textFrame('Still working.');
        },
        textFrame('This call must never be made.')
      ],
      log,
      { route: exec(1) }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    expect(probe.events.some((entry) => entry.summary.startsWith('Continuing on its own'))).toBe(
      false
    );
    // No renewal, and no closing call billed after the stop either.
    expect(log.modelRequests).toHaveLength(2);
    expect(probe.events.some((entry) => entry.summary === 'Task paused by user')).toBe(true);
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'paused', clearLease: true });
  });

  it('never renews a turn this worker no longer holds', async () => {
    /*
     * The lease moved while the budget was being spent, and this run stands down without saying a
     * word about it.
     *
     * This case used to reach the step ceiling and assert the refusal `renewStepBudget` writes
     * (`Stopping at the step limit: another worker holds the task`). Wave 7.2's #140 arm in
     * `honorUserControl` gets there first and deliberately gets there in silence: timeline events
     * carry no lease guard, so the refusal this test used to demand is itself the harm - the
     * owner's conversation would gain a stray line about a turn ending, from a worker that is no
     * longer running the task, beside the live output of the one that is. Standing down silently
     * is the repair, so the assertion moved with it.
     *
     * Silence here means about the turn's own ending. The two preamble events this run has already
     * written by the time the arm fires are written before the loop and before any ownership
     * question is asked - see the note in 7.2's report, which lists that preamble as a residue of
     * #140 rather than something this arm was asked to cover.
     *
     * The refusal arm inside `renewStepBudget` is still live and still tested, one level down in
     * `handoff.test.ts` - it guards the narrower window this test can no longer reach, where the
     * lease is lost after the last step boundary rather than before the first.
     */
    const task = makeTask(workingState());
    task.leaseOwner = 'worker-other';
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [textFrame('Working.'), textFrame('Still working.'), textFrame('Handing off.')],
      log,
      {
        route: exec(1)
      }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    // Not one line about how this turn ended, on a conversation another worker is writing.
    expect(
      probe.events.some((entry) => entry.summary.startsWith('Stopping at the step limit'))
    ).toBe(false);
    expect(probe.events.some((entry) => entry.summary.startsWith('Continuing on its own'))).toBe(
      false
    );
    // Nothing was run to work that out, either: who holds the task is a free read and it comes
    // before the checks, which can be a full build.
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
    // And nothing was billed. The old behaviour spent the whole budget first and only then noticed.
    expect(log.modelRequests).toHaveLength(0);
  });

  it('does not spend a check run establishing what the free reads already refused', async () => {
    const task = makeTask(
      // Nothing this turn changed: the acceptance record is inherited and the only successful call
      // was a read. Running the checks could only tell it what it is not allowed to act on anyway.
      workingState({
        turnToolResults: { 'call-0': { name: 'file_read', success: true } }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        textFrame('Reading.'),
        textFrame('Still reading.'),
        toolFrame('call-hand', 'finish', {
          summary: 'I could not work out what was wrong.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log,
      { route: exec(1) }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    expect(
      probe.events.some(
        (entry) =>
          entry.summary === 'Stopping at the step limit: this turn has not changed anything yet'
      )
    ).toBe(true);
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
  });

  it('will not renew itself on the checks an earlier turn declared', async () => {
    /*
     * The finish gate already refuses this record and says why: it was passing before this turn
     * began, so whatever this turn just did, that record is not evidence of it. The renewal has to
     * hold to the same rule, and the case for it is sharper - the renewal fires on a check
     * *failing*, and an inherited check that has started failing says this turn broke something an
     * earlier turn guaranteed. That is the owner's business, not another budget's.
     */
    const task = makeTask(workingState({ turn: 1 }));
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [textFrame('Working.'), textFrame('Still working.'), textFrame('Handing off.')],
      log,
      { route: exec(1) }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    expect(
      probe.events.some((entry) =>
        entry.summary.startsWith('Stopping at the step limit: the only acceptance checks on record')
      )
    ).toBe(true);
    expect(probe.events.some((entry) => entry.summary.startsWith('Continuing on its own'))).toBe(
      false
    );
    // Nothing was run to establish it: the turn a record belongs to is a free read, and it comes in
    // front of the checks, which can be a whole build.
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
  });
});

describe('what a tainted turn is charged for sending', () => {
  /**
   * The turn's novelty budget is the only bound on how much material can leave in a series of
   * addresses that are each individually innocent, and where it is charged decides whether it
   * bounds anything at all. Both halves below rested on a comment.
   *
   * The owner names the host, so reading it is ordinary and the second read of the same host is
   * inside every per-address bound - which is the case that has to be charged, not carded.
   */
  const OWNER_PROMPT = 'Read https://docs.example.test/guide and tell me what changed';

  const readingTask = (): TaskRecord => ({
    ...makeTask(),
    promptCiphertext: encryptJson({ prompt: OWNER_PROMPT }, dataKey, `task-prompt:${taskId}`)
  });

  /** What the runner answers a page read with, in the one field the taint and the origins are read from. */
  const pageRead = (url: string): Response =>
    new Response(
      JSON.stringify({
        sources: [{ url, requestedUrl: url, title: 'Guide', status: 200 }],
        pages: [{ url, text: 'Somebody else wrote this.' }]
      }),
      { headers: { 'content-type': 'application/json' } }
    );

  /** What the turn had spent when it was last written down, which is the running total itself. */
  const noveltySpent = (probe: StoreProbe): number | undefined =>
    probe.checkpoints
      .flatMap((input) =>
        input.agentStateCiphertext
          ? [
              decryptJson<{ turnNoveltyBytes?: number }>(
                input.agentStateCiphertext as Parameters<typeof decryptJson>[0],
                dataKey
              )
            ]
          : []
      )
      .at(-1)?.turnNoveltyBytes;

  it('charges a request that threw, because the request still went out', async () => {
    /*
     * Charging on the answer alone made stalling a free channel: a collector that accepts a request
     * and never replies produced `TOOL_REQUEST_TIMEOUT_MS`, left the total where it was, and the
     * next chunk was judged against the same figure again - so the per-turn bound bounded nothing
     * an attacker was willing to wait for. The hostname was resolved and the payload was in the
     * path before anything failed, and the only party who decides whether a request is answered is
     * the server being talked to.
     */
    const task = readingTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'parallel_web_read', { urls: ['https://docs.example.test/guide'] }),
        toolFrame('call-2', 'parallel_web_read', {
          urls: ['https://docs.example.test/guide/changelog']
        }),
        textFrame('The second page never answered.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/browser/read-many')
            ? log.calls.filter((call) => call.includes('/browser/read-many')).length > 1
              ? new Response(
                  JSON.stringify({
                    error: { code: 'runner_request_failed', message: 'the page never answered' }
                  }),
                  { status: 502, headers: { 'content-type': 'application/json' } }
                )
              : pageRead('https://docs.example.test/guide')
            : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // The call failed, and the turn was told so.
    expect(probe.events.some((entry) => entry.kind === 'error')).toBe(true);
    // `changelog` appears nowhere in the owner's words so it costs its length; `guide` was in the
    // address the first read landed on, so it costs the price of naming a piece the corpus already
    // holds rather than nothing. Asserted as the figure rather than as "more than nothing": a
    // charge of the whole URL would be a different bug wearing the same assertion.
    expect(noveltySpent(probe)).toBe('changelog'.length + MIN_TOKEN_BYTES);
  });

  it('charges nothing for an answer the harness wrote, because nothing was sent', async () => {
    /*
     * The other side of the same rule. A repeat the loop answers from an earlier call, a plan the
     * owner republished under a proposed call, arguments cut off mid-JSON: nothing was run and
     * nothing left the machine, so a budget that spends itself on those raises approval cards on
     * turns where nothing was sent at all.
     *
     * Driven through the plan case because it is the one that can carry addresses: the repeat set
     * is workspace reads, which reach no host to charge for.
     */
    const task = readingTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let read = false;
    let version = 0;
    // The owner is republishing the plan, so the version the loop reads is newer than the one the
    // step began with - which is what "changed after this tool call was proposed" is. Held back
    // until the first read has landed, so the turn is tainted and the budget is live when the
    // second call is skipped; without the taint neither branch charges anything and this would
    // pass on a bug.
    const store = {
      ...probe.store,
      getLatestTaskPlan: async () =>
        read
          ? {
              id: 'plan',
              taskId,
              version: (version += 1),
              parentVersion: null,
              branchName: 'Main',
              stepsCiphertext: encryptJson(
                { steps: [{ id: 'step-1', title: 'Read the guide', status: 'in_progress' }] },
                dataKey,
                `task-plan:${taskId}`
              ),
              createdBy: 'user' as const,
              createdAt: '2026-07-01T00:00:00.000Z'
            }
          : null
    } as unknown as DataStore;
    installFetch(
      [
        toolFrame('call-1', 'parallel_web_read', { urls: ['https://docs.example.test/guide'] }),
        toolFrame('call-2', 'parallel_web_read', {
          urls: ['https://docs.example.test/guide/changelog']
        }),
        textFrame('Replanning.')
      ],
      log,
      {
        route: (url) => {
          if (!url.includes('/browser/read-many')) return undefined;
          read = true;
          return pageRead('https://docs.example.test/guide');
        }
      }
    );

    await new AgentWorker(store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // One read reached the runner; the second call was answered by the harness instead.
    expect(log.calls.filter((call) => call.includes('/browser/read-many'))).toHaveLength(1);
    expect(
      probe.events.some(
        (entry) =>
          entry.kind === 'tool_result' &&
          JSON.stringify(entry.payload).includes('changed the active plan')
      )
    ).toBe(true);
    // Nothing was ever added, so the running total is still untouched rather than merely small.
    expect(noveltySpent(probe) ?? 0).toBe(0);
  });
});

/**
 * A call this side ended rather than one the model finished.
 *
 * The gateway keeps what was written, says what ended it, and marks the usage it had to work out
 * for itself because the frame carrying the real numbers is the one a cut stream never reaches.
 * Two things have to happen here: the prompt is billed from what this side sent, and the owner is
 * told why the answer they are looking at stops where it does.
 */
describe('a generation the box cut short', () => {
  /**
   * An answer that runs past the ceiling `maxTokens` implies - eight characters a token against a
   * 16,384-token cap - which is the one cutoff a test can provoke without spending the wall time
   * the other two are measured in.
   *
   * Every line differs, so what is measured is the ceiling rather than the repetition watch: a
   * hundred thousand characters of the same sentence is a degenerate repeat and would be stopped
   * long before the generation budget noticed anything.
   */
  const overrunningAnswer = ((): string => {
    const lines: string[] = [];
    for (let index = 0, length = 0; length < 140_000; index += 1) {
      const line = `Point ${index}: workspace/notes/${index}.md still wants a heading and a date.`;
      lines.push(line);
      length += line.length + 1;
    }
    return lines.join('\n');
  })();

  /** The stream as a cut one arrives: text, then nothing. No finish reason, and no usage frame. */
  const cutOffStream = `data: ${JSON.stringify({
    choices: [{ delta: { content: overrunningAnswer } }]
  })}\n\n`;

  /** Four characters to the token, which is what the gateway counts a cut-off answer at. */
  const estimatedOutput = Math.ceil(overrunningAnswer.length / 4);

  const finishFrame = toolFrame('call-1', 'finish', {
    summary: 'The answer was cut off, and what stands is in the reply above.',
    verification: { status: 'not_applicable', evidence: [] }
  });

  const run = async (
    bodies: string[]
  ): Promise<{ probe: StoreProbe; log: FetchLog; billed: Array<Record<string, unknown>> }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const billed: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      recordUsage: async (input: Record<string, unknown>) => {
        if (input.kind === 'model_inference') billed.push(input);
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(bodies, log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return { probe, log, billed };
  };

  it('bills the prompt it sent for a call whose usage never came back', async () => {
    const { probe, log, billed } = await run([cutOffStream, finishFrame]);

    // What the loop said it was sending, read back off its own cost event and off the catalogue on
    // the wire - the two halves of a request, and between them the whole of what a provider bills
    // as input. Nothing in the response carries either number: the usage frame never arrived.
    const cost = probe.events.find((entry) => entry.kind === 'cost');
    const messageTokens = (
      cost?.payload as { context: { estimatedInputTokens: number } } | undefined
    )?.context.estimatedInputTokens;
    const catalogue = (log.modelRequests[0]?.tools ?? []) as Array<{ function: unknown }>;
    const catalogueTokens = Math.ceil(
      JSON.stringify(catalogue.map((tool) => tool.function)).length / 4
    );

    expect(messageTokens).toBeGreaterThan(0);
    expect(billed[0]?.quantity).toBe(messageTokens! + catalogueTokens + estimatedOutput);
    // The ledger row is the one the owner's spend is added up from, so the failure this replaces is
    // not a rounding error: it filed the prompt at nothing and the output at the provider's silence.
    expect(billed[0]?.unit).toBe('tokens');
    expect(Number(billed[0]?.credits)).toBeGreaterThan(0);
  });

  it('says why the answer stops there, and does not ask for the rest of it', async () => {
    const { probe, log } = await run([cutOffStream, finishFrame]);

    const cut = probe.events.find((entry) =>
      entry.summary.startsWith('The answer was cut off before it finished')
    );
    expect(cut?.kind).toBe('warning');
    // An answer handed over incomplete is the owner's business, in the way a continuation is not.
    expect((cut?.payload as { owner?: unknown } | undefined)?.owner).toBe(true);
    expect((cut?.payload as { reason?: unknown } | undefined)?.reason).toBe('overrun');

    const windows = log.modelRequests.map((body) => JSON.stringify(body.messages));
    // The model is told, and told once. What it must not be told is to carry on: the gateway had
    // already decided this generation had stopped being productive, and continuing it buys the
    // same cut-off answer again at the same price.
    expect(windows.at(-1)).toContain('YOUR REPLY WAS CUT OFF');
    expect(windows.some((window) => window.includes('CONTINUE THE ANSWER'))).toBe(false);
    // Bounded: it fell through to the completion check, which ends the turn by completing it.
    expect(windows.at(-1)).toContain('COMPLETION CHECK');
    expect(log.modelRequests).toHaveLength(2);
    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(true);
  });
});

/**
 * The refusal that used to kill a conversation for good.
 *
 * A window larger than the route will take comes back 400, which is not retryable and was not a
 * wall either: the task was marked failed with the oversized trajectory saved. The owner replies,
 * the resumed turn rebuilds the identical window, sends the identical request and dies at the
 * identical step - for as long as they are willing to keep trying. Nothing anywhere recognised the
 * shape, though the file already carried the argument for it, written above the one other 400 it
 * does repair.
 */
describe('a window the route will not take', () => {
  const refusal = (): Response =>
    new Response(
      JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 40000 tokens, however you requested 214113 tokens"
        }
      }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );

  it('condenses the window to the size the route named and sends the step again', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let refused = 0;
    installFetch(
      [
        () => {
          refused += 1;
          return '';
        },
        textFrame('Carried on with a smaller window.'),
        toolFrame('call-1', 'finish', {
          summary: 'Finished after the window was condensed.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log
    );
    // The provider bodies above cannot express a status, so the refusal is served by hand for the
    // first inference call only and the stub answers everything after it.
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith(PROVIDER_URL) && url.includes('/chat/completions') && refused === 0) {
        refused = 1;
        if (typeof init?.body === 'string')
          log.modelRequests.push(JSON.parse(init.body) as Record<string, unknown>);
        return refusal();
      }
      return inner(input as string, init);
    }) as typeof fetch);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // Said to the owner, once, as the repair it is rather than as a failure.
    const said = probe.events.find((entry) => entry.summary.includes('too large for it'));
    expect(said?.kind).toBe('warning');
    expect((said?.payload as { contextLimitTokens?: number } | undefined)?.contextLimitTokens).toBe(
      40_000
    );
    // The step was sent again rather than the task being failed on a refusal it could answer.
    expect(log.modelRequests.length).toBeGreaterThanOrEqual(2);
    expect(probe.events.some((entry) => entry.kind === 'error')).toBe(false);
  });
});

/**
 * The generation this watch was written for, and what it costs.
 *
 * Twice in one evening a model answered correctly and then repeated one sentence until the
 * provider's own ceiling stopped it - seventeen thousand output tokens, a quarter of an hour, all
 * of it billed by the provider. The watch that stops it aborts the request, and the abort used to
 * take a `continue` straight past the whole billing block: no ledger row, no credit, no cost event,
 * and `state.lastStepUsd` left at the previous step's figure so the spend guard priced the next
 * step from a number it already knew was short. The one path that most needs a brake was the one
 * path that bypassed it.
 */
describe('a generation the repetition watch stopped', () => {
  /** The incident's own sentence, at a period long enough for `degenerateRepeat` to see it. */
  const repeatedSentence = 'The user is not watching the screen right now. ';

  /**
   * The repeat as it actually arrives: one frame at a time, on a connection that dies when the
   * request's signal aborts. A body handed over whole cannot be interrupted, and a stub that
   * ignores the signal cannot tell a request that was torn down from one that ran to its end -
   * which is the difference this test is entirely about.
   */
  const repeatingStream =
    (frames = 40) =>
    (init?: RequestInit): BodyInit =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          let settled = false;
          const tearDown = (): void => {
            if (settled) return;
            settled = true;
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          const signal = init?.signal;
          if (signal?.aborted) {
            tearDown();
            return;
          }
          signal?.addEventListener('abort', tearDown, { once: true });
          for (let index = 0; index < frames; index += 1)
            controller.enqueue(
              encode(
                `data: ${JSON.stringify({
                  choices: [{ delta: { content: repeatedSentence } }]
                })}\n\n`
              )
            );
          if (!settled) controller.close();
        }
      });

  const run = async (): Promise<{
    probe: StoreProbe;
    log: FetchLog;
    billed: Array<Record<string, unknown>>;
  }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const billed: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      recordUsage: async (input: Record<string, unknown>) => {
        if (input.kind === 'model_inference') billed.push(input);
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        repeatingStream(),
        toolFrame('call-1', 'finish', {
          summary: 'The repeat was stopped and the work stands.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return { probe, log, billed };
  };

  it('bills the tokens the stopped repeat had already generated', async () => {
    const { probe, log, billed } = await run();

    // The watch fired at all, which is the precondition for everything below it.
    const stopped = probe.events.find((entry) => entry.summary === 'Stopped a repeating answer');
    expect(stopped?.kind).toBe('warning');
    expect((stopped?.payload as { repeated?: string } | undefined)?.repeated).toContain(
      'not watching the screen'
    );
    // The turn carried on after the repeat rather than dying on it.
    expect(log.modelRequests.length).toBeGreaterThanOrEqual(2);

    // The provider billed every one of the stopped call's tokens, so the ledger has to carry its
    // own row for them. The row is keyed by step, which is what makes "the step is missing"
    // distinguishable from "the step was cheap" - the defect is the former.
    const row = billed.find((entry) => entry.idempotencyKey === `task:${taskId}:step:0`);
    expect(row, 'the stopped generation left no ledger row at all').toBeDefined();
    expect(Number(row?.costUsd)).toBeGreaterThan(0);
    expect(Number(row?.credits)).toBeGreaterThan(0);
    // Estimated, because the usage frame is the last frame of a stream this side cut short.
    expect(String(row?.unit)).toBe('tokens');

    // And the running total the compute ceiling is compared against actually moved, on the step
    // that spent it rather than only on the one after it.
    const cost = probe.events.find((entry) => entry.kind === 'cost');
    expect(cost?.summary).toBe('Step 1 completed');
    expect(
      Number((cost?.payload as { cumulativeCredits?: number } | undefined)?.cumulativeCredits)
    ).toBeGreaterThan(0);
  });

  it('supersedes the frames the owner watched arrive with one row that carries them', async () => {
    const { probe } = await run();

    // Without this the delta frames are kept and re-decrypted on every reopen of the conversation,
    // for ever: nothing else in the turn writes the row that replaces them.
    const closing = probe.events.filter(
      (entry) => entry.kind === 'assistant_message' && entry.replacesEarlierFrames
    );
    expect(closing).toHaveLength(1);
    expect(String((closing[0]?.payload as { markdown?: string } | undefined)?.markdown)).toContain(
      'not watching the screen'
    );
  });
});

/**
 * The five gates that decide whether a turn has been anywhere, and what stopping means.
 *
 * Every one of them was a control wired to something slightly wrong: a call garden answered
 * itself recorded as a call the computer answered, a call that never ran holding the key that
 * refuses the re-issue, a broker's "this is harmless" arriving as a card, Stop reaching every tool
 * except the one the owner was asked about, and a notice the model composed standing in as proof
 * that the work is done. None of the five had a test on either side of it.
 */
describe('what garden answered itself, and what the computer answered', () => {
  const readRoute = (path: string, content: string) => (url: string) =>
    url.includes('/file?') && readPath(url) === path ? jsonResponse({ content }) : undefined;

  it('refuses a finish that cites a call garden answered without running it', async () => {
    // The exact shape from the incident: a read is answered by the harness - here as an exact
    // repeat, in the field usually as arguments cut off at the output ceiling - and the same reply
    // finishes on it. Nothing ran, and the turn used to complete `status:'verified'` on it.
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        batchFrame([
          { id: 'call-1', name: 'file_read', args: { path: 'workspace/report.md' } },
          { id: 'call-2', name: 'file_read', args: { path: 'workspace/report.md' } },
          {
            id: 'call-3',
            name: 'finish',
            args: {
              summary: 'The report is written.',
              verification: {
                status: 'verified',
                evidence: [
                  {
                    claim: 'the report is written',
                    source: 'tool_result',
                    toolCallId: 'call-2'
                  }
                ],
                remainingRisks: []
              }
            }
          }
        ]),
        textFrame('Still working.')
      ],
      log,
      { route: readRoute('workspace/report.md', '# Report') }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const held = probe.events.find((entry) => entry.summary === 'Completion needs verification');
    expect(held, 'the finish was accepted on a call that never ran').toBeDefined();
    // Said as what it is. "Did not complete successfully" sends a model looking for a neighbour to
    // cite; "never ran" sends it to run the call.
    expect((held?.payload as { reason?: string } | undefined)?.reason).toContain('never ran');
    expect(
      toolMessages(probe).find((message) => message.toolCallId === 'call-3')?.content
    ).toContain('never ran');
  });

  it('refuses a finish that cites a notice the agent composed', async () => {
    // `notify` reaches the owner's lock screen with a sentence the model wrote. It carries nothing
    // back about the world, and the set that says so - `AGENT_SPEECH` - existed and was read in one
    // place only. Every "cite something that read the outcome back" refusal in the loop was one
    // notify call away from being satisfied.
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        batchFrame([
          { id: 'call-1', name: 'notify', args: { headline: 'The report is ready' } },
          {
            id: 'call-2',
            name: 'finish',
            args: {
              summary: 'The report is written.',
              verification: {
                status: 'verified',
                evidence: [
                  { claim: 'the report is ready', source: 'tool_result', toolCallId: 'call-1' }
                ],
                remainingRisks: []
              }
            }
          }
        ]),
        textFrame('Still working.')
      ],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const held = probe.events.find((entry) => entry.summary === 'Completion needs verification');
    expect(held, 'a delivered sentence was accepted as proof the work is done').toBeDefined();
    expect((held?.payload as { reason?: string } | undefined)?.reason).toContain(
      'something you said rather than something you observed'
    );
    // And it is not offered as a citation either, which is the same rule read from the front.
    expect(
      toolMessages(probe).find((message) => message.toolCallId === 'call-2')?.content
    ).toContain('No successful tool call this turn can be cited');
  });

  it('runs the re-issued read that the plan change told it to send again', async () => {
    /*
     * The owner edits the plan mid-step. Every call in flight is answered "replan before acting" -
     * none of them ran - and the agent does exactly what it was told: it replans and sends the same
     * read again. That re-issue used to come back "which already ran this turn and would return the
     * same result. Read that result again", pointing at a call whose only trace is the skip notice.
     */
    const task = makeTask();
    const probe = probeStore(() => task);
    let planVersion = 1;
    Object.assign(probe.store, {
      getLatestTaskPlan: async () => ({
        id: 'plan-1',
        taskId,
        version: planVersion,
        branchName: 'Main',
        stepsCiphertext: encryptJson(
          { steps: [{ id: 'step-1', title: 'Read the notes', status: 'in_progress' }] },
          dataKey,
          `task-plan:${taskId}`
        ),
        createdBy: 'user',
        createdAt: '2026-07-01T00:00:00.000Z'
      })
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    const read = { path: 'workspace/notes.md' };
    installFetch(
      [
        // Republished while the first reply is being generated, which is the only window in which
        // the gate below can fire: the plan is re-read at the step boundary and again per call.
        () => {
          planVersion = 2;
          return toolFrame('call-1', 'file_read', read);
        },
        toolFrame('call-2', 'file_read', read),
        textFrame('Read it.')
      ],
      log,
      { route: readRoute('workspace/notes.md', 'the notes as they stand') }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const answered = toolMessages(probe);
    expect(answered.find((message) => message.toolCallId === 'call-1')?.content).toContain(
      'changed the active plan'
    );
    const reissued = answered.find((message) => message.toolCallId === 'call-2')?.content ?? '';
    expect(
      reissued,
      'the re-issue was refused as a duplicate of a call that never ran'
    ).not.toContain('already ran this turn');
    expect(reissued).toContain('the notes as they stand');
  });

  it('lets Stop reach the one call the owner was asked about by name', async () => {
    // `#withCancellationWatch` exists for exactly this and was wired to the loop's own dispatch and
    // to the parallel run, and not to the approved resume - the one path where the owner has most
    // reason to expect Stop to work, because they were just asked about it. An approved shell runs
    // to the runner's ceiling, and nothing observed the stop until it returned.
    const approved = {
      executable: 'bash',
      args: ['-lc', 'sleep 3600'],
      cwd: 'workspace',
      timeoutSeconds: 3_600
    };
    const task = makeTask({
      messages: [
        { role: 'user', content: 'Run the importer' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'shell', arguments: approved }]
        }
      ],
      step: 1,
      credits: 0,
      pending: {
        approvalId: 'approval-1',
        toolCall: { id: 'call-1', name: 'shell', arguments: approved }
      }
    });
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      getApproval: async () => ({
        id: 'approval-1',
        status: 'approved',
        previewHash: approvalPreviewHash(dataKey, 'shell', approved),
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    const never = new Promise<void>(() => undefined);
    let started = 0;
    installFetch([textFrame('Stopped.')], log, {
      route: (url, init) => {
        if (!url.endsWith('/exec')) return undefined;
        started += 1;
        // Stopped with the approved command out on the wire and nothing to answer it. A pause
        // clears the lease in the same statement that sets the status.
        task.status = 'paused';
        task.leaseOwner = null;
        return heldBody('never arrives', never, init?.signal);
      }
    });

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(started).toBe(1);
    expect(
      toolMessages(probe).find((message) => message.toolCallId === 'call-1')?.content,
      'Stop never reached the running command'
    ).toContain('Tool failed');
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'paused', clearLease: true });
  });

  it('finishes a browser lookup from fresh observed evidence without creating acceptance artifacts', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('browse', 'browser_action', {
          action: 'navigate',
          url: 'https://example.test/',
          purpose: 'Read the heading'
        }),
        toolFrame('observe', 'browser_snapshot', {}),
        toolFrame('finish-lookup', 'finish', {
          summary: 'Read the heading',
          answer: 'The heading is Example Domain.',
          verification: {
            status: 'verified',
            evidence: [{ claim: 'The page heading', source: 'tool_result', toolCallId: 'observe' }]
          }
        })
      ],
      log,
      {
        route: (url) =>
          url.includes('/browser/preflight')
            ? jsonResponse({ consequential: false, sensitiveInput: false, preview: 'navigate' })
            : url.includes('/browser/action')
              ? jsonResponse({ ok: true, url: 'https://example.test/' })
              : url.includes('/browser/snapshot')
                ? jsonResponse({ text: 'Example Domain', url: 'https://example.test/' })
                : undefined
      }
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 5 }), masterKey, runnerSecret).run(
      task
    );
    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(true);
    expect(probe.events.filter((entry) => entry.kind === 'approval_requested')).toEqual([]);
    expect(probe.events.some((entry) => entry.summary === 'Asked for an acceptance record')).toBe(
      false
    );
    expect(log.modelRequests).toHaveLength(3);
  });

  it('raises no card when the browser broker says the action is harmless', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const raised: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      parkTaskForApproval: async (input: Record<string, unknown>) => {
        raised.push(input);
        await probe.store.updateTask({
          ...input,
          id: input.taskId,
          status: 'awaiting_user',
          clearLease: true
        } as Parameters<DataStore['updateTask']>[0]);
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'browser_action', {
          action: 'navigate',
          url: 'https://example.test/',
          purpose: 'Open the page'
        }),
        textFrame('Opened it.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/browser/preflight')
            ? jsonResponse({ consequential: false, sensitiveInput: false, preview: 'navigate' })
            : url.includes('/browser/action')
              ? jsonResponse({ ok: true, url: 'https://example.test/' })
              : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // `navigate` is on the hand-written list of verbs `ordinaryRequirement` refuses to card even in
    // Review, so there is no declared requirement for the broker to lighten - and a broker that
    // finds nothing may not invent one.
    expect(raised, 'a plain navigate raised an approval').toHaveLength(0);
    expect(probe.events.some((entry) => entry.kind === 'approval_requested')).toBe(false);
    expect(probe.checkpoints.some((entry) => entry.status === 'awaiting_user')).toBe(false);
    expect(log.calls.some((entry) => entry.includes('/browser/action'))).toBe(true);
  });

  it('still raises one when the broker calls the same shape consequential', async () => {
    // The same call, the same null declared requirement, and the opposite verdict from the page
    // itself: this is the half of the branch that has to keep working, and it is what makes the
    // test above a statement about the broker rather than about the browser being ungated.
    const task = makeTask();
    const probe = probeStore(() => task);
    const raised: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      parkTaskForApproval: async (input: Record<string, unknown>) => {
        raised.push(input);
        await probe.store.updateTask({
          ...input,
          id: input.taskId,
          status: 'awaiting_user',
          clearLease: true
        } as Parameters<DataStore['updateTask']>[0]);
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'browser_action', {
          action: 'click',
          selector: '#next',
          purpose: 'Continue'
        }),
        textFrame('Waiting on you.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/browser/preflight')
            ? jsonResponse({
                consequential: true,
                sensitiveInput: false,
                preview: 'Place order'
              })
            : url.includes('/browser/action')
              ? jsonResponse({ ok: true, url: 'https://shop.test/' })
              : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      action: 'browser_action',
      sideEffect: 'external_consequential'
    });
    expect(probe.events.some((entry) => entry.kind === 'approval_requested')).toBe(true);
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'awaiting_user', clearLease: true });
    expect(log.calls.some((entry) => entry.includes('/browser/action'))).toBe(false);
  });

  it('still confirms an ambiguous coordinate click the desktop broker calls harmless', async () => {
    /*
     * The decision the fix above forces, made here rather than left implicit.
     *
     * `classifyDesktopAction` relaxes a `click_at` that resolves to a named control to whatever
     * its label reads as, and the label list matches none of OK, Yes, Continue, Erase, Format or
     * Empty Trash - so the broker calls a click on "OK" in a "Discard unsaved changes?" dialog
     * harmless. Three documents and the tool description say an ambiguous coordinate action is
     * always confirmed. Both stay true, because the floor's own `click_at` rule is not conditional
     * on the security mode and the broker may only soften a requirement, never remove one: the
     * card still appears, and what the verdict buys is its severity.
     */
    const task = makeTask();
    const probe = probeStore(() => task);
    const raised: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      parkTaskForApproval: async (input: Record<string, unknown>) => {
        raised.push(input);
        await probe.store.updateTask({
          ...input,
          id: input.taskId,
          status: 'awaiting_user',
          clearLease: true
        } as Parameters<DataStore['updateTask']>[0]);
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'desktop_action', {
          action: 'click_at',
          x: 412,
          y: 288,
          purpose: 'Dismiss the dialog'
        }),
        textFrame('Waiting on you.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/desktop/preflight')
            ? jsonResponse({ consequential: false, sensitiveInput: false, preview: 'click OK' })
            : url.includes('/desktop/action')
              ? jsonResponse({ ok: true })
              : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(raised).toHaveLength(1);
    // Softened, not withdrawn: this is the whole of what the broker's verdict is allowed to do.
    expect(raised[0]).toMatchObject({
      action: 'desktop_action',
      sideEffect: 'external_reversible'
    });
    expect(log.calls.some((entry) => entry.includes('/desktop/action'))).toBe(false);
  });

  it('records the ninth origin that tainted the turn, and drops the first', async () => {
    /*
     * The record is the whole point of writing origins down: a repeat origin across tasks is the
     * strongest residual attack against a provenance model, and it is only visible if every
     * transition is written. `slice(0, 8)` kept the openers, so a turn that read eight ordinary
     * sources and then the attacker's recorded everything except the one that mattered - and the
     * length-based `changed` meant no warning was written for it either.
     */
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    const attachments = Array.from({ length: 9 }, (_unused, index) => `downloads/${index + 1}.pdf`);
    installFetch(
      [
        batchFrame(
          attachments.map((path, index) => ({
            id: `call-${index + 1}`,
            name: 'file_read',
            args: { path }
          }))
        ),
        textFrame('Read them.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/file?') ? jsonResponse({ content: 'a fetched page' }) : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const saved = decryptCheckpoints(probe.checkpoints).at(-1) as unknown as {
      taint?: { sources: string[] };
    };
    expect(saved.taint?.sources).toHaveLength(8);
    expect(saved.taint?.sources).toContain('downloaded file downloads/9.pdf');
    expect(saved.taint?.sources).not.toContain('downloaded file downloads/1.pdf');
    // And the arrival is on the timeline, which is the record the owner reads.
    expect(
      probe.events.some(
        (entry) =>
          entry.kind === 'warning' && entry.summary.includes('downloaded file downloads/9.pdf')
      )
    ).toBe(true);
  });
});

/**
 * The fifth ranking site, and the only one that chooses a model while the owner is asleep.
 *
 * Wave 4 landed the pre-flight price ceiling at the four sites an owner reaches by hand and proved
 * each by negative control. This one - the vision specialist an image is handed to when the lead
 * cannot see - was left open with the reason written down: spreading the ceiling in without a
 * refusal that names it recreates the defect the API's 402 removed, because an emptied pool falls
 * through to a sentence saying no specialist is available, which is true about the wrong setting.
 *
 * Both tests assert **membership** - what was offered - and never ordering. Wave 4 measured that an
 * assertion of the shape "the chosen model is under the ceiling" is green over a dead feature,
 * because `balanced` prefers the cheaper route unaided.
 */
describe('who reads a picture the lead model cannot', () => {
  /** A lead with no `vision` capability, which is what sends an image to a specialist at all. */
  const blindLead: ModelRelease = { ...model, capabilities: ['chat', 'tools', 'reasoning'] };

  const eyes = (
    id: string,
    displayName: string,
    inputUsdPerMillionTokens: number
  ): ModelRelease => ({
    ...model,
    id,
    providerModelId: `vendor/${id}`,
    displayName,
    capabilities: ['chat', 'vision'],
    modalities: ['text', 'image'],
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: inputUsdPerMillionTokens * 2
  });

  const dear = eyes('dear-eyes', 'Dear Eyes', 75);
  const cheap = eyes('cheap-eyes', 'Cheap Eyes', 0.5);

  /** A one-pixel PNG. Nothing reads the pixels; what matters is that the mime type is a picture. */
  const picture = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  const readAnImage = async (options: {
    catalog: ModelRelease[];
    /** The owner's price ceiling on input tokens, or null for a box that has never set one. */
    ceilingUsd: number | null;
  }): Promise<{ probe: StoreProbe; log: FetchLog; specialists: string[]; systemText: string }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      listModels: async () => options.catalog,
      effectiveSpendLimits: async () => ({
        dailyCapUsd: null,
        monthlyCapUsd: null,
        defaultTaskCapUsd: null,
        warnAtPercent: 80,
        timeZone: 'Europe/London',
        maxInputUsdPerMillionTokens: options.ceilingUsd,
        maxOutputUsdPerMillionTokens: null,
        updatedAt: '2026-07-01T00:00:00.000Z'
      })
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-i', 'image_read', { path: 'shots/button.png' }),
        completion({ role: 'assistant', content: 'A red button, top right.' }),
        textFrame('Described.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/image?')
            ? new Response(picture, { headers: { 'content-type': 'image/png' } })
            : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const state = decryptCheckpoints(probe.checkpoints).at(-1);
    return {
      probe,
      log,
      // Every model the provider was asked for that is not the lead: the whole of what the ceiling
      // is allowed to change.
      specialists: log.modelRequests
        .map((request) => String(request.model))
        .filter((id) => id !== blindLead.providerModelId),
      systemText: (state?.messages ?? [])
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n')
    };
  };

  it('does not offer a route priced above the owner’s ceiling, and names the ceiling when it refuses', async () => {
    // The control first: with no ceiling set, the $75/M route is the one the image goes to. Without
    // this arm the test below could pass because the apparatus never ran at all.
    const open = await readAnImage({ catalog: [blindLead, dear], ceilingUsd: null });
    expect(open.specialists).toEqual(['vendor/dear-eyes']);

    const capped = await readAnImage({ catalog: [blindLead, dear], ceilingUsd: 1 });
    // Membership, not ordering: the dear route is not offered. `dear` is the only vision route in
    // this catalogue, so nothing cheaper can make this green by being preferred unaided.
    expect(capped.specialists).toEqual([]);

    /*
     * And the refusal names the ceiling rather than saying no specialist is available. That
     * sentence is true about the wrong setting: an owner who reads it changes their privacy route,
     * or buys nothing, and every image keeps failing for a reason nothing on the box has named.
     */
    expect(capped.systemText).toContain('price ceiling');
    expect(capped.systemText).toContain('Dear Eyes');
    expect(capped.systemText).not.toContain('is currently available');
    // Told to the owner too, on the timeline, flagged as theirs to fix - a price ceiling is not
    // something the model can raise and a system message is not something the owner can read.
    const warning = capped.probe.events.find(
      (entry) => entry.summary === 'An image could not be read under your price ceiling'
    );
    expect(warning?.kind).toBe('warning');
    expect(warning?.payload).toMatchObject({
      owner: true,
      code: 'price_ceiling_blocked',
      cheapestAboveCeiling: 'dear-eyes'
    });
  });

  it('reads the picture on a cheaper route when the ceiling admits one, and says nothing', async () => {
    /*
     * The other half of the outcome, and the reason `blocked` is a verdict rather than an empty
     * list: a turn that cannot continue and a turn that picked something cheaper are different
     * things to have happened, and the owner is entitled to know which. Here the ceiling costs the
     * turn nothing, so it costs the owner no notice either.
     */
    const { specialists, systemText, probe } = await readAnImage({
      catalog: [blindLead, dear, cheap],
      ceilingUsd: 1
    });

    expect(specialists).toEqual(['vendor/cheap-eyes']);
    expect(systemText).toContain('VISION SPECIALIST HANDOFF');
    expect(systemText).not.toContain('price ceiling');
    expect(
      probe.events.some((entry) => entry.summary.includes('could not be read under your price'))
    ).toBe(false);
    // The handoff is on the timeline as the ordinary thing it is.
    expect(
      probe.events.some(
        (entry) => entry.summary === 'Vision handled by Cheap Eyes; returned to Model One'
      )
    ).toBe(true);
  });
});

/**
 * The turn that spent a step budget publishing the identical plan, driven end to end.
 *
 * Measured on the owner's box: a byte-identical `set_plan` twelve times running. Three guards could
 * see every one of those steps and none of them could say anything about it - `set_plan` is not in
 * `LOOP_ANSWERED_TOOLS` so each step zeroed the idle count, every call succeeded so the failure
 * counter never saw one, and the prose around each call differed so the repetition watch had nothing
 * to match. Only the step budget stopped it, at up to a hundred and twenty steps.
 *
 * `turn-bounds.test.ts` holds the three negative controls and the signature. This is the half that
 * cannot be unit tested: that the guard is wired into the loop, that it fires there, and that it
 * ends the turn the way the two guards beside it end one.
 */
describe('a turn that stopped changing', () => {
  const planCall = (id: string): string =>
    toolFrame(id, 'set_plan', {
      branchName: 'Main',
      steps: [
        { title: 'Read the brief', status: 'completed' },
        { title: 'Draft the importer', status: 'in_progress' }
      ]
    });

  it('stops the turn well short of the step budget, and says why where the owner reads why', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    // The last body is served for every request past the end of the list, so this is the incident:
    // the same call, forever, until something stops it.
    installFetch([planCall('call-1')], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 40 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const stopped = probe.events.find(
      (entry) => entry.summary === 'Stopped a turn that had stopped changing'
    );
    expect(stopped?.kind).toBe('warning');
    expect((stopped?.payload as { tools?: string[] } | undefined)?.tools).toEqual(['set_plan']);
    // The payload carries the signature and not the arguments: sixteen bytes prove the steps were
    // identical, and the arguments they were identical in are the owner's own writing.
    expect((stopped?.payload as { signature?: string } | undefined)?.signature).toMatch(
      /^[0-9a-f]{16}$/
    );
    expect(JSON.stringify(stopped?.payload)).not.toContain('Draft the importer');
    // Short of the budget by a wide margin, which is the whole point: the budget was the only thing
    // that used to stop this, at up to a hundred and twenty steps.
    expect(log.modelRequests.length).toBeLessThanOrEqual(
      stationaryStepsBeforeStop(MAX_STATIONARY_STEPS) + 2
    );
    expect(log.modelRequests.length).toBeGreaterThanOrEqual(
      stationaryStepsBeforeStop(MAX_STATIONARY_STEPS)
    );
  });

  it('tells the model once before it ends anything, and names the call in the sentence', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([planCall('call-1')], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 40 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const told = decryptCheckpoints(probe.checkpoints)
      .at(-1)
      ?.messages.filter((message) => message.content.startsWith('NOTHING HAS CHANGED FOR'));
    expect(told?.length).toBeGreaterThanOrEqual(1);
    expect(told?.[0]?.content).toContain('set_plan');
    // The marker the eval harness matches on, published from the file that writes the sentence.
    expect(told?.[0]?.content.startsWith(marker('stationary_stop'))).toBe(true);
  });

  it('leaves the owner the reason on the completion, not a red error', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([planCall('call-1')], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 40 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(probe.events.some((entry) => entry.kind === 'error')).toBe(false);
    const completed = probe.events.find((entry) => entry.kind === 'completed');
    expect(JSON.stringify(completed?.payload)).toContain('made the identical set_plan call');
  });

  /**
   * And it does not fire on a turn that is working, which is the expensive direction to be wrong in.
   * The same tool twice, then something else: a shape every healthy task has.
   */
  it('says nothing about a turn that repeats a call and then moves on', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        planCall('call-1'),
        planCall('call-2'),
        toolFrame('call-3', 'finish', {
          summary: 'The plan is published and the notes are tidy.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 40 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(
      probe.events.some((entry) => entry.summary === 'Stopped a turn that had stopped changing')
    ).toBe(false);
    expect(
      decryptCheckpoints(probe.checkpoints)
        .at(-1)
        ?.messages.some((message) => message.content.startsWith('NOTHING HAS CHANGED FOR'))
    ).toBe(false);
  });
});

/**
 * A response cut off mid-JSON at the output cap, and what answering it in the real history cost.
 *
 * The call is answered rather than dropped, because a tool call with no tool result is a malformed
 * turn the provider refuses on the next step. What was never done was taking the unparseable bytes
 * back out: `rawArguments` carries the whole of a half-written file, it is undeclared on
 * `ModelMessage.toolCalls` so the compiler never saw it, and nothing between the push and the
 * encrypted write ever dropped it.
 */
describe('a tool call that was cut off mid-argument', () => {
  /** The half-written file, at a size a real output cap produces. */
  const halfAFile = `{"path":"workspace/importer.py","content":"${'import pandas as pd\\n'.repeat(1_200)}`;

  /**
   * The frame as the provider actually sends it: arguments that are a prefix of valid JSON, and
   * `length` as the reason it stopped - which is what tells the adapter this was the output cap
   * rather than a model writing bad JSON.
   */
  const cutOffFrame = (id: string, name: string, rawArguments: string): string =>
    `data: ${JSON.stringify({
      choices: [
        {
          finish_reason: 'length',
          delta: { tool_calls: [{ index: 0, id, function: { name, arguments: rawArguments } }] }
        }
      ]
    })}\n\ndata: [DONE]\n\n`;

  const run = async (): Promise<{ probe: StoreProbe; log: FetchLog }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        cutOffFrame('call-1', 'file_write', halfAFile),
        toolFrame('call-2', 'finish', {
          summary: 'The write was too large to send in one piece.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return { probe, log };
  };

  it('answers it, and keeps no fragment of the bytes that would not parse', async () => {
    const { probe } = await run();

    const warned = probe.events.find((entry) => entry.summary.includes('cut off mid-argument'));
    expect(warned?.kind).toBe('warning');
    // The precondition: the turn really did see a truncated call rather than an ordinary one.
    expect((warned?.payload as { bytes?: number } | undefined)?.bytes).toBeGreaterThan(20_000);

    const state = decryptCheckpoints(probe.checkpoints).at(-1);
    const persisted = JSON.stringify(state);
    expect(persisted).not.toContain('import pandas as pd');
    expect(persisted).not.toContain('rawArguments');
    expect(persisted).not.toContain('parseFailed');
  });

  it('leaves a window a provider will still take: every call has a result', async () => {
    const { probe } = await run();

    const state = decryptCheckpoints(probe.checkpoints).at(-1);
    const answered = new Set(
      (state?.messages ?? [])
        .filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId)
    );
    const proposed = (state?.messages ?? []).flatMap(
      (message) =>
        (message as { toolCalls?: Array<{ id: string; name: string }> }).toolCalls?.map(
          (call) => call.id
        ) ?? []
    );
    expect(proposed).toContain('call-1');
    for (const id of proposed) expect(answered.has(id)).toBe(true);
    // And the reason string is untouched: it is #59's good half and it stays.
    expect(
      (state?.messages ?? []).some((message) =>
        message.content.includes("were cut off at the model's output limit")
      )
    ).toBe(true);
  });

  /**
   * The cost nobody had named. `estimatedTokens` in context.ts sizes an assistant message with
   * `JSON.stringify(message.toolCalls).length`, and that walked the whole half-written file - so one
   * cut-off write charged the window several thousand tokens the adapter would never send, and the
   * compaction trigger is derived from that number.
   */
  it('stops the window being sized from a payload the wire never carries', async () => {
    const { probe } = await run();

    const state = decryptCheckpoints(probe.checkpoints).at(-1);
    const cutOff = (state?.messages ?? [])
      .flatMap((message) => (message as { toolCalls?: Array<{ id: string }> }).toolCalls ?? [])
      .filter((call) => call.id === 'call-1');
    expect(cutOff).toHaveLength(1);
    // Three declared fields and an empty argument object, against twenty-five kilobytes.
    expect(JSON.stringify(cutOff).length).toBeLessThan(halfAFile.length / 100);
  });
});

/**
 * Which garden priced this.
 *
 * A cost line is the most-compared number the product emits - a baseline read back a year later, a
 * regression argued from two transcripts - and until now nothing on it said which build produced it,
 * so two figures that disagree could not be told apart from two builds that disagree. It is the
 * §6.2 credibility move's precondition: "this harness, this commit, this model, N runs" needs the
 * commit to be on the row.
 */
describe('the build that priced a step', () => {
  it('is on the cost event, on the ordinary step path', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'finish', {
          summary: 'The notes are tidy.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const cost = probe.events.find((entry) => entry.kind === 'cost');
    expect(cost).toBeTruthy();
    expect((cost?.payload as { build?: unknown } | undefined)?.build).toEqual(buildIdentity());
  });
});

/**
 * The tier that costs nothing until it fires, driven end to end.
 *
 * `rules/rules.test.ts` proves the matchers and `rules/wiring.test.ts` proves where the loop asks.
 * Neither proves the only thing that decides whether this mechanism is worth having: that the
 * correction actually reaches the provider when a rule fires, and that the request is byte-for-byte
 * what it would have been when none does. That is asserted here against the requests the run really
 * sent, on two turns that differ in one character of one path.
 */
describe('dormant rules on a real turn', () => {
  const messagesOf = (request: Record<string, unknown> | undefined): { content: string }[] =>
    (request?.messages ?? []) as { content: string }[];

  /** The same turn twice, differing only in the extension of the file it writes. */
  const turnWriting = async (path: string): Promise<FetchLog> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'file_write', { path, content: 'Some words.\n' }),
        toolFrame('call-2', 'files_list', { path: 'workspace' }),
        textFrame('Written.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return log;
  };

  it('puts the correction in front of the model on the step after the one that earned it', async () => {
    const log = await turnWriting('workspace/quarterly.docx');
    // Nothing on the request that earned it: this half never interrupts.
    expect(messagesOf(log.modelRequests[0]).some((m) => m.content.startsWith('HARNESS'))).toBe(
      false
    );
    const correction = messagesOf(log.modelRequests[1]).find((m) =>
      m.content.startsWith('HARNESS CORRECTION [office-render-proof]')
    );
    expect(correction?.content).toContain('garden-office-convert');
  });

  it('sends a request with no rule byte in it when nothing fired', async () => {
    const log = await turnWriting('workspace/quarterly.md');
    // A turn that made no request has no bytes in it to be clean of, and the loops below would
    // report that as a pass. The count is what the empty case has to answer for.
    let read = 0;
    for (const request of log.modelRequests)
      for (const message of messagesOf(request)) {
        read += 1;
        expect(message.content).not.toContain('HARNESS CORRECTION');
      }
    expect(read).toBeGreaterThan(0);
  });
});

/**
 * The conditional contract, proved where it is actually paid for.
 *
 * `context.test.ts` proves `baseSystemPrompt` gates on the capabilities it is handed, and that is a
 * different claim from the one that matters: for one wave the gate existed, was tested, and was
 * dead, because the single production caller invoked `ensureBasePrompt(state.messages)` with no
 * second argument and got the fully provisioned constant every time. A gate nothing passes an
 * argument to is not a saving, it is a function with a unit test.
 *
 * So this reads the request the run really sent. The arm is the one the worker already decides for
 * itself a few lines above the install - a box with no connector enabled withdraws `connector_action`
 * - and the assertion is that the contract in that request describes THAT box. It is also the only
 * enforcement of a cross-file dependency the withdrawal comment states in prose: it withdraws the
 * tool on the grounds that the contract still tells the model how to reach a mailbox without it.
 */
describe('the contract the run actually sends', () => {
  const contractOf = (log: FetchLog): string => {
    const messages = (log.modelRequests[0]?.messages ?? []) as { content: string }[];
    const head = messages.find((message) => message.content.startsWith(BASE_PROMPT_MARKER));
    if (!head) throw new Error('no operating contract on the request');
    return head.content;
  };

  /** `toolchain` is what the runner's probe answers; '' leaves the summary empty, as a dead probe does. */
  const turn = async (toolchain = ''): Promise<FetchLog> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Done.')], log, {
      route: (url) =>
        toolchain && new URL(url).pathname.endsWith('/toolchain')
          ? new Response(JSON.stringify({ ok: true, summary: toolchain }), {
              headers: { 'content-type': 'application/json' }
            })
          : undefined
    });
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return log;
  };

  /** Exactly how the runner words the absence; the gate matches on the opening of this sentence. */
  const NO_TOOLCHAIN =
    'No document toolchain is installed; install python3, typst and libreoffice to author documents here.';

  it('describes the box this run is on, not the fully provisioned one', async () => {
    const contract = contractOf(await turn());
    // No connector is enabled on this task, so the worker withdrew the tool. The contract has to
    // have followed it, or the model is reading a route it was not given.
    expect(contract).not.toContain(
      'Use connector_action for supported operations on connected accounts'
    );
  });

  it('drops the document facts on a box the runner says has no toolchain', async () => {
    const contract = contractOf(await turn(NO_TOOLCHAIN));
    // The pinned interpreter path is the single most expensive fact in the gated span and the one
    // that does most damage when it is wrong: it sends the model at a binary that is not there, and
    // it finds out one failed shell call at a time in front of the owner.
    expect(contract).not.toContain('/usr/local/lib/garden/python/bin/python3');
    expect(contract).toContain('The managed document toolchain is unavailable');
  });

  it('is smaller on a barer box than on a provisioned one', async () => {
    const bare = contractOf(await turn(NO_TOOLCHAIN));
    const provisioned = contractOf(await turn('python3 3.12, typst 0.12, garden-office-convert.'));
    // The whole claim of a conditional contract in one assertion: two boxes, two sizes. Before the
    // gate was wired these two were the same string, and the saving was a number in a report.
    expect(bare.length).toBeLessThan(provisioned.length);
  });

  it('is the contract this run\u2019s own facts build, to the byte', async () => {
    const log = await turn();
    const request = log.modelRequests[0];
    const sent = ((request?.tools ?? []) as { name: string }[]).map((tool) => tool.name);
    // Both gated facts are read back off the same request rather than restated here: the tool array
    // is what the request carried, and the toolchain is the line the runtime block states. Asserting
    // byte-identity against `baseSystemPrompt` fed from those two catches the whole failure class -
    // no capabilities passed, one of the two passed, or a stale copy of either passed - where a
    // sentence-by-sentence check catches only the arm somebody thought to write down.
    const runtime = ((request?.messages ?? []) as { content: string }[]).find((message) =>
      message.content.startsWith(RUNTIME_CONTEXT_MARKER)
    );
    const toolchain = /^- Document toolchain: (.*)$/m.exec(runtime?.content ?? '')?.[1] ?? '';
    expect(contractOf(log)).toBe(baseSystemPrompt({ tools: sent, toolchainSummary: toolchain }));
  });
});

/**
 * THE PRODUCTION CALL SITE for the machine block.
 *
 * `machineReport` and its route are proved in the runner's own suite, against real cgroup files.
 * What no case there can see is whether the sentence the runner produced ever reaches the model,
 * which is the join this repository has shipped a proof without three times. So this drives the
 * real `AgentWorker` against a stubbed runner and reads the line back off the request that went
 * out - and the negative arm is the one that matters most, because a probe that silently answers
 * nothing is exactly how a block stops carrying numbers without anything going red.
 */
describe('the machine the run tells the model it is on', () => {
  const runtimeBlockOf = (log: FetchLog): string => {
    const messages = (log.modelRequests[0]?.messages ?? []) as { content: string }[];
    const block = messages.find((message) => message.content.startsWith(RUNTIME_CONTEXT_MARKER));
    if (!block) throw new Error('no runtime block on the request');
    return block.content;
  };

  /** `summary` is what the runner's probe answers; `null` is a runner with no such route at all. */
  const turn = async (summary: string | null): Promise<FetchLog> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Done.')], log, {
      route: (url) =>
        summary !== null && new URL(url).pathname.endsWith('/machine')
          ? new Response(JSON.stringify({ ok: true, summary }), {
              headers: { 'content-type': 'application/json' }
            })
          : undefined
    });
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return log;
  };

  /** The owner's box, as `machineReport` words it. */
  const OWNER =
    '16 cores, 21.9 GiB memory per command, 730.1 GiB free disk. Size parallel work, memory and output to these rather than to a default.';

  it('carries the numbers, on the same request as the disk sentence they belong beside', async () => {
    const block = runtimeBlockOf(await turn(OWNER));
    expect(block).toContain(`- Machine: ${OWNER}`);
    // Beside, not instead of: the block still sends the agent to `df -h` for live capacity, and the
    // two lines have to arrive adjacent or the machine figure reads as an unrelated aside.
    const lines = block.split('\n');
    const machine = lines.findIndex((line) => line.startsWith('- Machine: '));
    expect(machine).toBeGreaterThan(-1);
    expect(lines[machine + 1] ?? '').toContain('df -h /home/garden');
  });

  /**
   * The case that fails if the block stops carrying the numbers.
   *
   * Named individually rather than by the whole sentence: what a model reads off this line is a
   * core count, a memory ceiling and a disk figure, and a plumbing change that dropped any one of
   * them while keeping the line would pass a `toContain` on the prose and fail the agent.
   */
  it('states a core count, a memory ceiling and a disk figure, each of them', async () => {
    const block = runtimeBlockOf(await turn(OWNER));
    expect(block).toMatch(/^- Machine: .*\b16 cores\b/m);
    expect(block).toMatch(/^- Machine: .*\b21\.9 GiB memory per command\b/m);
    expect(block).toMatch(/^- Machine: .*\b730\.1 GiB free disk\b/m);
  });

  it('says nothing at all when the runner has no such route', async () => {
    const block = runtimeBlockOf(await turn(null));
    expect(block).not.toContain('- Machine:');
    // And the rest of the block is untouched, which is what makes an unanswerable probe free.
    expect(block).toContain('- Check real capacity with `df -h /home/garden`');
  });

  /**
   * A runner that answers with an empty summary - every field unestablishable, which is what a box
   * whose cgroup cannot be read produces - has to look identical to no runner at all. Byte
   * identity rather than an absence check: this is the branch that decides whether a machine that
   * cannot describe itself costs the cached tail anything.
   */
  it('is byte-identical to a run with no probe when the runner establishes nothing', async () => {
    expect(runtimeBlockOf(await turn(''))).toBe(runtimeBlockOf(await turn(null)));
  });
});

/*
 * The whole loop, against the repair that replaced the `code_diagnostics` approval card.
 *
 * The finding behind that card is true: a repository cloned from anywhere is a repository whose
 * `Makefile`, `build.rs` and tests were written by somebody else, and nine of the fifteen commands
 * this tool can run are exactly those files. What the card did about it was wrong three measured
 * ways, and the third is the one a loop test can hold: the tool sat on `CHECKPOINT_EXEMPT_TOOLS`,
 * so a turn that ran a stranger's build recipe and nothing else took no undo point at all.
 *
 * So these two tests separate what the two used to: a diagnostic reaches the runner without parking
 * the turn, in either language, and the turn has something to rewind to when it does. Driving the
 * real loop rather than the floor is the point - `CHECKPOINT_EXEMPT_TOOLS` is consulted in
 * `agent.ts` and in `tool-recording.ts`, neither of which `approvalRequirement` can see.
 */
describe('diagnosing a repository whose build somebody else wrote', () => {
  const diagnose = async (entries: string[]) => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const raised: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      parkTaskForApproval: async (input: Record<string, unknown>) => {
        raised.push(input);
        await probe.store.updateTask({
          ...input,
          id: input.taskId,
          status: 'awaiting_user',
          clearLease: true
        } as Parameters<DataStore['updateTask']>[0]);
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'code_diagnostics', { path: 'workspace/cloned' }),
        textFrame('Checked it.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/files?path=')
            ? jsonResponse({ entries: entries.map((name) => ({ name })) })
            : url.endsWith('/exec')
              ? jsonResponse({
                  exitCode: 0,
                  signal: null,
                  stdout: '',
                  stderr: '',
                  durationMs: 4,
                  timedOut: false
                })
              : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    return { raised, probe, log, ran: log.calls.some((entry) => entry.includes('/exec')) };
  };

  /*
   * `go test ./...` compiles and runs the repository's own test files, which is the loudest case
   * the removed card was written for. It runs, and the owner keeps a way back from it: the
   * checkpoint is in front of the exec, not behind it, because a checkpoint taken afterwards holds
   * the state the owner is trying to get away from.
   */
  it('takes the undo point before a cloned repository’s test suite runs, and does not ask', async () => {
    const { raised, probe, log, ran } = await diagnose(['go.mod', 'main.go']);

    expect(raised, 'a diagnostic parked the turn').toHaveLength(0);
    expect(probe.checkpoints.some((entry) => entry.status === 'awaiting_user')).toBe(false);
    expect(ran, 'go test ./... never reached the runner').toBe(true);

    const checkpointCalls = log.calls.filter((entry) => entry.includes('/checkpoints'));
    expect(checkpointCalls, 'the build ran with no undo point').toHaveLength(1);
    expect(log.calls.indexOf(checkpointCalls[0]!)).toBeLessThan(
      log.calls.findIndex((entry) => entry.includes('/exec'))
    );
    expect(probe.undoPoints).toHaveLength(1);
    expect(probe.undoPoints[0]).toMatchObject({ workspaceId, taskId, turn: 0 });
  });

  /*
   * The owner's own project, and the half that decides whether any of this survives a working day.
   * A `tsc --noEmit` is the shape almost every real call to this tool has; it must cost no card -
   * and it takes the same undo point, because `tsc --noEmit` under `incremental` writes a
   * `.tsbuildinfo` and `python3 -I -m compileall` leaves `__pycache__`. The bound is the tool, not
   * a list of nine languages, and this is where that is visible.
   */
  it('takes it for an ordinary TypeScript check too, and still stops nobody', async () => {
    const { raised, probe, ran } = await diagnose(['package.json', 'tsconfig.json']);

    expect(raised, 'a tsc --noEmit raised an approval').toHaveLength(0);
    expect(probe.checkpoints.some((entry) => entry.status === 'awaiting_user')).toBe(false);
    expect(ran, 'the type check never reached the runner').toBe(true);
    expect(probe.undoPoints).toHaveLength(1);
  });
});

describe('owner effort reaches the paid request', () => {
  it.each(['low', 'max'] as const)(
    'keeps %s on the normal step and its closing handoff',
    async (effort) => {
      const task = { ...makeTask(), reasoningEffort: effort };
      const probe = probeStore(() => task);
      vi.spyOn(probe.store, 'listModels').mockResolvedValue([
        { ...model, reasoning: { mandatory: true, supportedEfforts: ['low', 'high', 'max'] } }
      ]);
      const log: FetchLog = { calls: [], modelRequests: [] };
      installFetch(
        [textFrame('Working through the notes.'), textFrame('The turn stopped at its step limit.')],
        log
      );
      const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);
      await worker.run(task);
      expect(log.modelRequests).toHaveLength(2);
      for (const request of log.modelRequests) expect(request.reasoning_effort).toBe(effort);
      const states = decryptCheckpoints(probe.checkpoints);
      expect(states.length).toBeGreaterThan(0);
      expect(states.at(-1)).toMatchObject({ ownerReasoningEffort: effort });
    }
  );
});

/**
 * Two providers connected at once, which is what a box could not do.
 *
 * The credential used to be chosen by the account — one row, one provider — and any model outside
 * its namespace was refused here, after the conversation had started. So connecting Ollama Cloud
 * took OpenRouter's models away and a conversation pinned to one of them stopped working. The
 * credential is now chosen by the model, and the refusal that remains is the one that matters: a
 * model no connection reaches must not be sent another provider's key.
 */
describe('an account holding more than one provider connection', () => {
  const aad = `inference-provider:${userId}`;
  const connection = (provider: string, apiKey: string, baseUrl = PROVIDER_URL) => ({
    userId,
    provider: `inference:${provider}`,
    status: 'active' as const,
    externalRef: 'self-hosted',
    monthlyLimitUsd: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    secretCiphertext: encryptJson(
      { provider, baseUrl, apiKey, enforceZeroDataRetention: false },
      masterKey,
      aad
    )
  });

  const runAgainst = async (
    connections: ReturnType<typeof connection>[],
    forModel: ModelRelease
  ): Promise<FetchLog> => {
    // The task names its model by id, so the fixture keeps `model.id` and only the namespace and
    // provider move - which is the axis these cases are about.
    const task = { ...makeTask(), modelId: forModel.id };
    const probe = probeStore(() => task);
    const store = {
      ...probe.store,
      listModels: async () => [forModel],
      listManagedProviderCredentials: async () => connections,
      rerouteTaskModel: async () => false,
      recordModelThroughputCeiling: async () => undefined,
      modelThroughputCeiling: async () => null,
      getManagedProviderCredential: async () => null
    } as unknown as DataStore;
    const log: FetchLog = { calls: [], modelRequests: [], modelAuthorizations: [] };
    installFetch([textFrame('thinking')], log);
    await new AgentWorker(store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return log;
  };

  it('reaches a custom-namespace model while OpenRouter is also connected', async () => {
    const log = await runAgainst(
      [connection('openrouter', 'openrouter-key'), connection('ollama-cloud', 'ollama-key')],
      model
    );
    expect(log.modelRequests.length).toBeGreaterThan(0);
  });

  it('reaches an OpenRouter model while a custom endpoint is also connected', async () => {
    const log = await runAgainst(
      [connection('openrouter', 'openrouter-key'), connection('ollama-cloud', 'ollama-key')],
      { ...model, id: 'openrouter/vendor/model-1', provider: 'openrouter' }
    );
    expect(log.modelRequests.length).toBeGreaterThan(0);
  });

  it.each([
    ['Ollama Cloud', 'ollama-key'],
    ['Configured endpoint', 'compatible-key']
  ])('uses the exact custom connection identified by %s', async (tag, expected) => {
    const log = await runAgainst(
      [
        connection('openrouter', 'openrouter-key'),
        connection('ollama-cloud', 'ollama-key'),
        connection('openai-compatible', 'compatible-key')
      ],
      { ...model, recommendationTags: [tag] }
    );
    expect(log.modelAuthorizations?.length).toBeGreaterThan(0);
    expect(log.modelAuthorizations?.every((header) => header === `Bearer ${expected}`)).toBe(true);
  });

  it('refuses an ambiguous legacy model and a removed explicit connection', async () => {
    const connections = [
      connection('ollama-cloud', 'ollama-key'),
      connection('openai-compatible', 'compatible-key')
    ];
    expect((await runAgainst(connections, model)).modelRequests).toHaveLength(0);
    expect(
      (await runAgainst(connections, { ...model, connectionId: 'removed-account' })).modelRequests
    ).toHaveLength(0);
  });

  it('refuses a model no connection reaches rather than spending another provider`s key', async () => {
    // Only OpenRouter is connected, and the model lives in the custom namespace. The old code would
    // also have refused; what matters is that it still does, and does not fall back to the key it
    // happens to hold.
    const log = await runAgainst([connection('openrouter', 'openrouter-key')], model);
    expect(log.modelRequests).toHaveLength(0);
  });
});

/**
 * A wall on one provider, and another provider sitting there answering.
 *
 * Parking behind the provider that refused was the only possible answer while an account could
 * hold one credential. It can now hold one per provider, so the sweep waiting up to a day for a
 * quota to reset is the wrong answer when a route the owner has already connected would take the
 * work now. What has to keep holding is the old behaviour on every path that has nowhere to go:
 * a re-route is an improvement on waiting, never a replacement for it.
 */
describe('a task walled on one provider while another is connected', () => {
  const aad = `inference-provider:${userId}`;
  const connection = (provider: string) => ({
    userId,
    provider: `inference:${provider}`,
    status: 'active' as const,
    externalRef: 'self-hosted',
    monthlyLimitUsd: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    secretCiphertext: encryptJson(
      {
        provider,
        baseUrl: PROVIDER_URL,
        apiKey: `${provider}-key`,
        enforceZeroDataRetention: false
      },
      masterKey,
      aad
    )
  });
  const elsewhere: ModelRelease = {
    ...model,
    id: 'openrouter/vendor/model-2',
    providerModelId: 'vendor/model-2',
    displayName: 'Model Two',
    provider: 'openrouter'
  };

  const walled = async (options: {
    on?: ModelRelease;
    catalogue?: ModelRelease[];
    connections?: string[];
    already?: string[];
  }) => {
    const task = {
      ...makeTask({
        messages: [],
        step: 2,
        credits: 3,
        turn: 1,
        ...(options.already ? { walledProviders: options.already } : {})
      }),
      modelId: (options.on ?? model).id
    };
    const probe = probeStore(() => task);
    const moves: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      listModels: async () => options.catalogue ?? [model, elsewhere],
      listManagedProviderCredentials: async () =>
        (options.connections ?? ['openrouter', 'ollama-cloud']).map(connection),
      rerouteTaskModel: async (input: Record<string, unknown>) => {
        moves.push(input);
        return true;
      }
    });
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret, silentLogger).fail(
      task,
      new GardenError('provider_quota_exhausted', 'The provider is out of quota')
    );
    return { probe, moves };
  };

  it('moves onto the provider that is answering instead of waiting a day for the one that is not', async () => {
    const { probe, moves } = await walled({});
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ modelId: elsewhere.id, workerId: 'worker-test' });
    // Not parked as well: the sweep would find a queued task and the owner would see it counted as
    // waiting on a resource it is no longer waiting for.
    expect(probe.checkpoints).toHaveLength(0);
    // The credits already spent travel with it, or the new route starts the task's budget again.
    expect(moves[0]?.actualComputeCredits).toBe(3);
    const told = probe.events
      .filter((entry) => (entry.payload as { owner?: unknown } | undefined)?.owner === true)
      .map((entry) => entry.summary);
    expect(told.at(-1)).toContain('Model Two');
  });

  it('carries the wall into the new state so the next one does not come straight back', async () => {
    const { moves } = await walled({});
    const state = decryptJson<{ walledProviders?: string[] }>(
      moves[0]?.agentStateCiphertext as never,
      dataKey
    );
    expect(state.walledProviders).toEqual(['custom']);
  });

  it('parks rather than returning to a provider that has already walled this turn', async () => {
    const { probe, moves } = await walled({ already: ['openrouter'] });
    expect(moves).toHaveLength(0);
    expect(probe.checkpoints).toMatchObject([{ status: 'awaiting_resource' }]);
  });

  it('parks when the only route this account reaches is the one that refused', async () => {
    const { probe, moves } = await walled({ catalogue: [model], connections: ['ollama-cloud'] });
    expect(moves).toHaveLength(0);
    expect(probe.checkpoints).toMatchObject([{ status: 'awaiting_resource' }]);
  });

  /**
   * Three providers refusing inside one turn is an outage, not a rate limit, and waiting is the
   * right answer to an outage. Without the bound a long task would rotate for as long as the
   * catalogue held routes, spending a request on each one to learn what the first one told it.
   */
  it('stops rotating once enough providers have refused', async () => {
    const { probe, moves } = await walled({ already: ['a', 'b', 'c'] });
    expect(moves).toHaveLength(0);
    expect(probe.checkpoints).toMatchObject([{ status: 'awaiting_resource' }]);
  });

  it('parks, as it always did, when the store will not move the task', async () => {
    const task = { ...makeTask({ messages: [], step: 2, credits: 0, turn: 1 }), modelId: model.id };
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      listModels: async () => [model, elsewhere],
      listManagedProviderCredentials: async () => [connection('openrouter')],
      // Another worker holds the lease. The wall below is still the truth about this task.
      rerouteTaskModel: async () => false,
      recordModelThroughputCeiling: async () => undefined,
      modelThroughputCeiling: async () => null
    });
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret, silentLogger).fail(
      task,
      new GardenError('provider_quota_exhausted', 'The provider is out of quota')
    );
    expect(probe.checkpoints).toMatchObject([{ status: 'awaiting_resource' }]);
  });
});

describe('the output-limit continuation ceiling', () => {
  const limited = (text: string) =>
    `data: ${JSON.stringify({ choices: [{ finish_reason: 'length', delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  it.each(['', 'The partial answer'])(
    'ends after the permitted continuations without adding completion retries: %j',
    async (text) => {
      const task = makeTask();
      const probe = probeStore(() => task);
      const log: FetchLog = { calls: [], modelRequests: [] };
      installFetch([limited(text)], log);
      await new AgentWorker(
        probe.store,
        config({ TASK_MAX_STEPS: 40 }),
        masterKey,
        runnerSecret
      ).run(task);
      expect(log.modelRequests).toHaveLength(MAX_TRUNCATED_CONTINUATIONS + 1);
      const capped = probe.events.filter(
        (event) =>
          event.kind === 'warning' &&
          (event.payload as { continued?: boolean })?.continued === false
      );
      expect(capped).toHaveLength(1);
      expect(capped[0]?.payload).toMatchObject({
        owner: true,
        continuation: MAX_TRUNCATED_CONTINUATIONS + 1
      });
      expect(
        probe.events.some((event) => event.summary === 'Answered without calling finish')
      ).toBe(false);
      const completion = probe.events.find((event) => event.kind === 'completed');
      expect(completion?.payload).toMatchObject({
        interrupted: true,
        verification: { remainingRisks: [expect.stringContaining('output limit')] }
      });
      if (!text) {
        expect((completion?.payload as { summary?: string })?.summary).toContain(
          'without a complete answer'
        );
        expect(JSON.stringify(log.modelRequests[1]?.messages)).toContain(
          'without returning an answer'
        );
        expect(JSON.stringify(log.modelRequests[1]?.messages)).not.toContain('mid-sentence');
      }
    }
  );

  it('continues an incomplete reply when the next response can finish', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        limited('The answer begins here.'),
        toolFrame('done', 'finish', {
          summary: 'The complete explanation.',
          verification: { status: 'not_applicable', reason: 'A conversational explanation.' }
        })
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 10 }), masterKey, runnerSecret).run(
      task
    );
    expect(log.modelRequests).toHaveLength(2);
    expect(JSON.stringify(log.modelRequests[1]?.messages)).toContain('The answer begins here.');
    expect(probe.events.find((event) => event.kind === 'completed')?.payload).not.toMatchObject({
      interrupted: true
    });
  });
});

describe('real runtime replay', () => {
  it.each([
    'finish',
    'parallel reads',
    'concurrent update conflict',
    'question',
    'approval',
    'approval resume',
    'failed verification',
    'provider retry',
    'interrupted stream',
    'question resume',
    'job wait',
    'failure handling'
  ])(
    'reconstructs %s without live calls',
    async (scenario) => {
      const task = makeTask();
      const probe = probeStore(() => task);
      const bodies: PrivateDiagnosticBody[] = [];
      let previous = DIAGNOSTIC_EMPTY_HASH;
      const fail = vi.fn(async () => undefined);
      Object.assign(probe.store, {
        getWorkspace: async () => workspace,
        readOwnerBlock: async () => null,
        recallMemoryCandidates: async () => [],
        saveMemoryPack: async (input: unknown) => input,
        diagnostics: {
          get: async () => ({
            status: { id: '55555555-5555-4555-8555-555555555555', state: 'recording' },
            workspaceId,
            epoch: 'epoch'
          }),
          fail,
          append: async (input: Parameters<DataStore['diagnostics']['append']>[0]) => {
            const sealed = input.seal(bodies.length + 1, previous);
            bodies.push(decryptJson<PrivateDiagnosticBody>(sealed, dataKey, sealed.aad));
            previous = diagnosticCipherHash(sealed);
            return true;
          }
        }
      });
      const finish = toolFrame('finish-replay', 'finish', {
        summary: 'The notes need no changes.',
        verification: { status: 'not_applicable', evidence: [] }
      });
      const read = toolFrame('read-replay', 'file_read', { path: 'workspace/notes.md' });
      const command = { executable: 'rm', args: ['-rf', 'workspace/old'] };
      let frames: Array<BodyInit | ((init?: RequestInit) => BodyInit)> = [finish];
      if (scenario === 'parallel reads')
        frames = [
          batchFrame(
            ['a', 'b', 'c'].map((name) => ({
              id: name,
              name: 'file_read',
              args: { path: `workspace/${name}.md` }
            }))
          ),
          finish
        ];
      if (scenario === 'concurrent update conflict')
        frames = [
          batchFrame(
            ['first', 'second'].map((content) => ({
              id: content,
              name: 'file_write',
              args: { path: 'workspace/shared.md', content }
            }))
          ),
          finish
        ];
      if (scenario === 'question')
        frames = [
          read,
          toolFrame('ask-replay', 'ask', {
            question: 'Which folder should contain the summary?',
            why: 'Two destinations are available.',
            options: ['Shared', 'Personal']
          })
        ];
      if (scenario === 'approval') frames = [toolFrame('shell-replay', 'shell', command)];
      if (scenario === 'approval resume') {
        const call = { id: 'shell-replay', name: 'shell', arguments: command };
        Object.assign(
          task,
          makeTask({
            messages: [
              { role: 'user', content: 'Clear the old folder' },
              { role: 'assistant', content: '', toolCalls: [call] }
            ],
            step: 1,
            credits: 0,
            pending: { approvalId: 'approval-1', toolCall: call }
          })
        );
        Object.assign(probe.store, {
          getApproval: async () => ({
            id: 'approval-1',
            status: 'approved',
            previewHash: approvalPreviewHash(dataKey, 'shell', command),
            expiresAt: '2099-01-01T00:00:00.000Z'
          })
        });
      }
      if (scenario === 'question resume') {
        Object.assign(
          task,
          makeTask({
            messages: [{ role: 'user', content: 'Choose a folder' }],
            step: 1,
            credits: 0,
            question: { question: 'Which folder?', askedAtStep: 1 }
          })
        );
        let answered = false;
        Object.assign(probe.store, {
          getNextQueuedTaskMessage: async () =>
            answered
              ? null
              : {
                  id: 'answer-replay',
                  interrupt: false,
                  promptCiphertext: encryptJson(
                    { prompt: 'Shared' },
                    dataKey,
                    `task-message:${task.id}`
                  ),
                  modelId: model.id,
                  privacyRoute: 'provider_zdr',
                  maxComputeCredits: 5,
                  maxSpendUsd: null
                },
          consumeQueuedTaskMessageInTurn: async () => {
            answered = true;
            return true;
          }
        });
      }
      if (scenario === 'job wait') {
        frames = [toolFrame('wait-replay', 'process', { action: 'wait', sessionId: 'job-replay' })];
        Object.assign(probe.store, {
          parkTaskForJobs: async (input: Record<string, unknown>) => {
            probe.checkpoints.push({ ...input, status: 'awaiting_resource' });
            return true;
          }
        });
      }
      if (scenario === 'failed verification')
        frames = [
          toolFrame('finish-invalid', 'finish', {
            summary: 'Done',
            verification: {
              status: 'verified',
              evidence: [{ toolCallId: 'invented', claim: 'Passed' }]
            }
          })
        ];
      if (scenario === 'interrupted stream')
        frames = [
          () => {
            let pull = 0;
            return new ReadableStream({
              pull(controller) {
                if (pull++ === 0)
                  controller.enqueue(
                    encode(
                      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial answer' } }] })}\n\n`
                    )
                  );
                else controller.error(new Error('Connection lost'));
              }
            });
          },
          finish
        ];
      const log: FetchLog = { calls: [], modelRequests: [] };
      Object.assign(probe.store, {
        parkTaskForApproval: async (input: Record<string, unknown>) => {
          probe.checkpoints.push({ ...input, status: 'awaiting_user' });
          return { id: input.id };
        }
      });
      let writes = 0;
      installFetch(frames, log, {
        route: (url, init) => {
          if (
            scenario === 'concurrent update conflict' &&
            url.includes('/file') &&
            init?.method === 'PUT'
          ) {
            writes++;
            return writes === 1
              ? jsonResponse({ ok: true })
              : new Response(
                  JSON.stringify({
                    error: {
                      code: 'file_changed',
                      message:
                        'Another conversation changed the file. Read it again before editing.'
                    }
                  }),
                  { status: 409, headers: { 'content-type': 'application/json' } }
                );
          }
          return scenario === 'question' && url.includes('/file?')
            ? jsonResponse({ content: 'Shared and personal destinations exist.' })
            : scenario === 'job wait' && url.includes('/processes/')
              ? jsonResponse({
                  sessionId: 'job-replay',
                  startedAt: '2026-09-27T00:00:00.000Z',
                  status: 'running',
                  lifetime: 'job'
                })
              : undefined;
        }
      });
      if (scenario === 'provider retry') {
        const installed = globalThis.fetch;
        let refused = false;
        vi.stubGlobal('fetch', (async (url: string | URL | Request, options?: RequestInit) => {
          if (
            !refused &&
            (url instanceof Request ? url.url : url.toString()).endsWith('/chat/completions')
          ) {
            refused = true;
            return new Response('Unavailable', { status: 503 });
          }
          return installed(url, options);
        }) as typeof fetch);
      }
      const worker = new AgentWorker(
        probe.store,
        config({ TASK_MAX_STEPS: 4 }),
        masterKey,
        runnerSecret
      );
      if (scenario === 'failure handling')
        await worker.fail(task, new GardenError('provider_unavailable', 'Provider offline'), 100);
      else
        await worker.run(task).catch((error) => {
          if (scenario !== 'interrupted stream') throw error;
        });
      if (scenario === 'job wait' || scenario === 'failure handling')
        expect(probe.checkpoints.at(-1)?.status).toBe('awaiting_resource');
      if (scenario === 'parallel reads')
        expect(log.calls.filter((row) => /[abc]\.md/.test(row))).toHaveLength(3);
      if (scenario === 'question resume')
        expect(JSON.stringify(log.modelRequests)).toContain('Shared');
      if (scenario === 'finish' || scenario === 'provider retry')
        expect(probe.events.some((row) => row.kind === 'completed')).toBe(true);
      if (scenario === 'approval' || scenario === 'question')
        expect(probe.checkpoints.at(-1)?.status).toBe('awaiting_user');
      if (scenario === 'failed verification') {
        const completed = probe.events.find((row) => row.kind === 'completed');
        expect(completed).toBeDefined();
        expect(completed?.payload).toMatchObject({ verification: { status: 'unverified' } });
      }
      if (scenario === 'approval resume')
        expect(log.calls.some((row) => row.includes('/exec'))).toBe(true);

      if (scenario === 'concurrent update conflict') {
        expect(writes).toBe(2);
        expect(JSON.stringify(log.modelRequests.at(-1))).toContain(
          'Another conversation changed the file'
        );
      }

      expect(fail).not.toHaveBeenCalled();
      const value = (row: PrivateDiagnosticBody) => (row.data as { value: unknown }).value;
      const start = bodies.find((row) => row.kind === 'runtime_start');
      const end = bodies.find((row) => row.kind === 'runtime_end');
      expect(start).toBeDefined();
      expect(end).toBeDefined();
      const segment: RuntimeSegment = {
        start: value(start!) as RuntimeSegment['start'],
        events: bodies
          .filter((row) => row.kind === 'runtime_event')
          .map((row) => value(row) as RuntimeSegment['events'][number]),
        end: value(end!) as RuntimeSegment['end']
      };
      expect(segment.events.length).toBeGreaterThan(0);
      expect(JSON.stringify(segment)).not.toContain('provider-key');
      const external = vi.fn(() => {
        throw new Error('Replay reached a live transport');
      });
      vi.stubGlobal('fetch', external);
      const result = await replayRuntime(segment);
      expect(result).toMatchObject({ complete: true, divergence: null });
      expect(external).not.toHaveBeenCalled();
      if (scenario === 'finish' || scenario === 'failure handling') {
        const captured = new CapturedRuntimeReplay();
        const rows: unknown[] = [];
        const accept = (row: unknown) => {
          rows.push(row);
          captured.accept(row);
        };
        const id = '55555555-5555-4555-8555-555555555555';
        accept({
          type: 'private_capture',
          format: 'garden-private-diagnostic',
          version: 1,
          id,
          taskId,
          workspaceId,
          through: bodies.length,
          status: {
            id,
            state: 'stopped',
            startedAt: bodies[0]!.at,
            stoppedAt: bodies.at(-1)!.at,
            records: bodies.length,
            bytes: JSON.stringify(bodies).length,
            limitBytes: DIAGNOSTIC_CAPTURE_BYTES,
            reason: null
          }
        });
        let hash = DIAGNOSTIC_EMPTY_HASH;
        for (const [index, body] of bodies.entries()) {
          const previousHash = hash;
          hash = diagnosticPlainHash(index + 1, previousHash, body);
          accept({ type: 'record', sequence: index + 1, previousHash, hash, body });
        }
        accept({ type: 'footer', records: bodies.length, hash, complete: true });
        expect(await captured.replay()).toMatchObject({
          available: true,
          complete: true,
          segments: 1
        });
        if (scenario === 'failure handling') {
          const directory = await mkdtemp(join(tmpdir(), 'garden-runtime-cli-'));
          try {
            const filename = join(directory, 'capture.jsonl');
            await writeFile(filename, rows.map((row) => JSON.stringify(row)).join('\n'));
            const result = await promisify(execFile)(
              process.execPath,
              [
                '--conditions=development',
                '--import',
                'tsx',
                fileURLToPath(new URL('./diagnostic-replay-cli.ts', import.meta.url)),
                filename
              ],
              { timeout: 15_000, env: { PATH: process.env.PATH } }
            );
            expect(JSON.parse(result.stdout)).toMatchObject({
              complete: true,
              runtime: { available: true, complete: true },
              semantic: { approvalDecisions: 0, requestDerivations: 0 }
            });
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
        const altered = structuredClone(segment);
        altered.events[0]!.name = 'unexpected';
        await expect(replayRuntime(altered)).rejects.toThrow('diverged');
        const missing = { ...segment, events: segment.events.slice(0, -1) };
        await expect(replayRuntime(missing)).rejects.toThrow('diverged');
        await expect(
          replayRuntime({ ...segment, events: [...segment.events, segment.events[0]!] })
        ).rejects.toThrow('diverged');
        expect(external).not.toHaveBeenCalled();
      }
    },
    20_000
  );
});
