#!/usr/bin/env node
import { checkMemoryLibrary } from './browser-memory.mjs';
import { checkPreviewStart } from './browser-preview-start.mjs';
import { checkDesk } from './browser-desk.mjs';
import { checkWorkspaceNavigation } from './browser-workspace.mjs';
import { checkProjectHistory } from './browser-project-history.mjs';
import { checkAppearance } from './browser-appearance.mjs';
import { checkPermissionModes } from './browser-permissions.mjs';
import { checkRunningQuestion } from './browser-questions.mjs';
import { checkHumanInterventions } from './browser-interventions.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processFixture, checkProjectProcesses } from './browser-processes.mjs';
import { directoryFixture, checkProjectDirectories } from './browser-directories.mjs';
import { checkProjectConversations } from './browser-project-conversations.mjs';
import { checkTaskRecovery } from './browser-task-recovery.mjs';
import { checkArtifactLinks } from './browser-artifact-links.mjs';

// Local fixtures exercise browser interactions; API and runner suites own authorization and delivery.
const requireRunner = createRequire(
  new URL('../services/workspace-runner/package.json', import.meta.url)
);
const { chromium } = requireRunner('playwright-core');
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'apps/web/dist');
await readFile(resolve(dist, 'index.html'));
const ownedReport = !process.env.GARDEN_UI_REPORT;
const report = process.env.GARDEN_UI_REPORT || (await mkdtemp(resolve(tmpdir(), 'garden-ui-')));
await mkdir(report, { recursive: true });
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === `/v1/tasks/${task.id}/diagnostics`) {
      assert.equal(request.method, 'GET');
      response.setHeader('content-type', 'application/x-ndjson');
      response.setHeader('content-disposition', 'attachment; filename="garden-diagnostic.ndjson"');
      response.end('{"fixture":"content_omitted"}\n');
      return;
    }

    if (pathname.endsWith('/download')) {
      response.setHeader('content-type', 'text/html');
      response.setHeader('content-disposition', 'attachment; filename="index.html"');
      response.end(previewHtml);
      return;
    }
    const path = resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    assert(path.startsWith(dist + sep));
    response.setHeader('content-type', mime[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const previewServer = createServer((request, response) => {
  if (request.url.endsWith('/echo')) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ready: true }));
  } else {
    response.setHeader('content-type', 'text/html');
    response.end(
      previewHtml +
        `<script>
      try { localStorage.setItem('garden-app-check', 'stored'); document.body.dataset.storage = localStorage.getItem('garden-app-check'); }
      catch { document.body.dataset.storage = 'blocked'; }
      fetch('./echo').then(r => r.json()).then(r => document.body.dataset.request = String(r.ready)).catch(() => document.body.dataset.request = 'blocked');
    </script>`
    );
  }
});
await new Promise((done) => previewServer.listen(0, '127.0.0.1', done));
const isolatedPreviewOrigin = `http://127.0.0.1:${previewServer.address().port}`;
const browser = await chromium.launch({ headless: true });
const time = '2026-09-06T00:00:00Z';
const workspace = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'My computer',
  status: 'running',
  securityMode: 'balanced',
  region: 'local',
  storageBytes: 0,
  storageLimitBytes: 10000000000,
  createdAt: time,
  updatedAt: time
};
const task = {
  projectId: '20000000-0000-4000-8000-000000000002',
  id: '20000000-0000-4000-8000-000000000002',
  workspaceId: workspace.id,
  title:
    'Build an interactive maze with keyboard controls, a playable preview, and portable source files',
  status: 'completed',
  modelId: 'fixture/model',
  privacyRoute: 'provider_zdr',
  securityMode: 'balanced',
  reasoningEffort: 'auto',
  spentUsd: 0.01,
  maxSpendUsd: null,
  queuedMessageCount: 0,
  archived: false,
  pinned: false,
  createdAt: time,
  updatedAt: time
};
const event = {
  id: '30000000-0000-4000-8000-000000000003',
  taskId: task.id,
  kind: 'completed',
  sequence: 3,
  summary: 'The maze is ready to open.',
  payload: {
    summary: 'The maze is ready to open. Use the arrow keys to play.',
    verification: { status: 'verified' }
  },
  createdAt: time
};
const milestones = [
  {
    id: 'change',
    sequence: 1,
    kind: 'change',
    title: 'Created maze/index.html',
    status: 'observed',
    createdAt: time
  },
  {
    id: 'check',
    sequence: 2,
    kind: 'check',
    title: 'Verified keyboard controls',
    status: 'passed',
    createdAt: time
  }
];
const presentation = {
  version: 1,
  taskId: task.id,
  eventCursor: 3,
  results: [
    {
      id: 'preview',
      kind: 'preview',
      title: 'Playable maze',
      status: 'ready',
      accessPath: '/v1/previews/fixture/access',
      url: origin + '/__garden/preview/fixture/',
      downloadUrl: null,
      evidenceEventIds: [event.id]
    },
    {
      id: 'source',
      kind: 'file',
      title: 'index.html',
      path: 'workspace/maze/index.html',
      status: 'ready',
      url: null,
      accessPath: null,
      downloadUrl: `/v1/workspaces/${workspace.id}/download?path=workspace%2Fmaze%2Findex.html`,
      evidenceEventIds: [event.id]
    }
  ],
  progress: {
    kind: 'build',
    phases: [
      { id: 'build', title: 'Build the maze and keyboard controls', status: 'completed' },
      {
        id: 'verify',
        title: 'Verify the playable result and deliver its source',
        status: 'completed'
      }
    ],
    current: null,
    history: [],
    metrics: [{ key: 'checks', label: 'Checks passed', value: 1 }],
    milestones,
    updatedAt: time
  }
};
const project = {
  id: task.projectId,
  workspaceId: workspace.id,
  parentWorkspaceId: workspace.id,
  title: 'Maze project',
  brief: 'Build a playable maze.',
  securityMode: 'balanced',
  revision: 1,
  pinned: false,
  archivedAt: null,
  createdAt: time,
  updatedAt: time,
  conversationCount: 1,
  activeCount: 0,
  attentionCount: 0,
  spentUsd: task.spentUsd,
  latestTaskId: task.id
};
const bootstrap = {
  user: { id: '40000000-0000-4000-8000-000000000004', username: 'owner' },
  workspaces: [workspace],
  tasks: [task],
  projects: [project],
  projectsCursor: null,
  tasksCursor: null,
  scheduleRunCounts: {},
  schedules: [],
  drafts: [],
  models: [
    {
      id: task.modelId,
      providerModelId: 'model',
      displayName: 'Fixture reasoning model',
      provider: 'fixture',
      availability: 'available',
      privacyRoute: 'provider_zdr',
      reasoning: { supportedEfforts: ['low', 'medium', 'high', 'max'], mandatory: true }
    }
  ],
  instance: {
    mode: 'native',
    providerConfigured: true,
    enforceZeroDataRetention: true,
    webSearch: {}
  },
  usage: {
    providerSpend: null,
    consumedCredits: 0,
    reservedCredits: 0,
    storageBytes: 0,
    storageLimitBytes: workspace.storageLimitBytes
  }
};
const previewHtml =
  '<!doctype html><title>Playable fixture</title><button onclick="this.textContent=Number(this.textContent)+1">0</button>';
async function revealPromptSettings(surface) {
  const settings = surface.getByRole('button', { name: 'Prompt settings', exact: true });
  await settings.waitFor();
  if ((await settings.getAttribute('aria-expanded')) === 'false') await settings.click();
}
async function openNewProject(page) {
  const trigger = page
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'Projects', exact: true });
  await trigger.waitFor();
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await page
    .getByRole('dialog', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'New project', exact: true })
    .click();
}

const errors = [];
let draft;
const modelDrafts = new Map();
const draftReceipts = new Map();
const draftRevisions = new Map();
let draftOffline = false,
  loseDraftAcknowledgement = false,
  loseSendAcknowledgement = false;
const taskReceipts = new Map();
let lostDraftAcknowledgement;
let taskCreations = 0;
let projectChoices = {},
  projectRevision = 0,
  defaultChoices = {
    decisions: { automatic: false, preference: 'balanced', modelId: 'openrouter/typesafe/jev-test' }
  };
let failModelSave = false,
  createdModelRequest;
let generationChoices = {};
const providerConnections = new Map([
  [
    'openrouter',
    {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: null,
      hasApiKey: true,
      enforceZeroDataRetention: true
    }
  ],
  [
    'ollama-cloud',
    {
      provider: 'ollama-cloud',
      baseUrl: 'https://ollama.com/v1',
      modelId: null,
      hasApiKey: true,
      enforceZeroDataRetention: true
    }
  ],
  [
    'openai-compatible',
    {
      provider: 'openai-compatible',
      baseUrl: 'https://compatible.example/v1',
      modelId: 'shared/model',
      hasApiKey: true,
      enforceZeroDataRetention: true,
      contextTokens: 98304,
      capabilities: ['chat', 'tools'],
      modalities: ['text']
    }
  ]
]);
let primaryProvider = 'openrouter';
const providerWrites = [];
const providerResponse = () => {
  const connections = [...providerConnections].map(([connectionId, entry]) => ({
    ...entry,
    connectionId,
    configured: true,
    source: 'encrypted_database'
  }));
  return { ...connections.find((entry) => entry.connectionId === primaryProvider), connections };
};
const generationModel = {
  id: 'fixture/image-studio',
  provider: 'fixture',
  providerModelId: 'image-studio',
  displayName: 'Image Studio',
  modality: 'image',
  usdPerImage: 0.05,
  usdPerMinute: null,
  usdPerSecond: null,
  usdPerMillionCharacters: null,
  unavailableReason: null
};
const generationSurface = () => ({
  approvalThresholdUsd: 1,
  modalities: [
    {
      modality: 'image',
      available: true,
      choice: generationChoices.image ?? { automatic: true, preference: 'balanced', modelId: '' },
      effective: generationModel,
      options: [generationModel],
      reason: null
    }
  ]
});
const modelCatalog = [
  ...bootstrap.models.map((model) => ({ ...model, contextTokens: 128000 })),
  ...Array.from({ length: 80 }, (_, index) => ({
    ...bootstrap.models[0],
    id: `openrouter/${index % 2 ? 'beta' : 'alpha'}/model-${index}`,
    providerModelId: `${index % 2 ? 'beta' : 'alpha'}/model-${index}`,
    provider: 'openrouter',
    displayName: `Research model ${index}`,
    contextTokens: 200000,
    inputUsdPerMillionTokens: 0.25,
    outputUsdPerMillionTokens: 1,
    modalities: ['text', 'image'],
    capabilities: ['chat', 'tools', 'reasoning']
  })),
  {
    ...bootstrap.models[0],
    id: 'retired/model',
    displayName: 'Retired research model',
    contextTokens: 128000,
    availability: 'unavailable'
  }
];
let decisionModelsEnabled = true;
let failDecisionSave = false;
const modelSurface = (project) => ({
  decisionModelsEnabled,
  projectTaskId: project ? task.id : '',
  revision: project ? projectRevision : 0,
  choices: project ? projectChoices : defaultChoices,
  purposes: [
    'main',
    'specialist',
    'coding',
    'decisions',
    'summarise',
    'title',
    'image',
    'audio',
    'transcription',
    'video'
  ].map((purpose) => {
    const choice = (project && projectChoices[purpose]) ||
      defaultChoices[purpose] || { automatic: true, preference: 'balanced', modelId: '' };
    if (purpose === 'decisions')
      return {
        purpose,
        choice,
        source: 'global',
        disabled: true,
        options: [],
        effective: null,
        available: false,
        reason: decisionModelsEnabled
          ? 'Decision models are not in use. All features work without one.'
          : 'Decision models are turned off in Settings → Models.'
      };
    return {
      purpose,
      source:
        project && projectChoices[purpose]
          ? 'project'
          : defaultChoices[purpose]
            ? 'global'
            : 'automatic',
      choice,
      options: ['image', 'audio', 'transcription', 'video'].includes(purpose) ? [] : modelCatalog,
      effective: modelCatalog.find((model) => model.id === choice.modelId) ?? modelCatalog[0],
      available: true,
      reason: null
    };
  })
});
let missions = [];
let mediaJobs = [];
let mediaAssets = [];
let reviewedSubmission;
let recoveredVideo;
let recordedReceipt;
let childQuestion = null,
  childAnswer = null;
const childWorkspace = {
  ...workspace,
  id: '10000000-0000-4000-8000-000000000009',
  name: 'Isolated controls workspace'
};
const childTask = {
  ...task,
  id: '20000000-0000-4000-8000-000000000009',
  title: 'Implement keyboard controls',
  workspaceId: childWorkspace.id,
  parentTaskId: task.id,
  parentMissionId: '50000000-0000-4000-8000-000000000005'
};
const mission = {
  id: childTask.parentMissionId,
  parentTaskId: task.id,
  taskId: childTask.id,
  workspaceId: childWorkspace.id,
  name: 'Keyboard controls',
  state: 'ready',
  sourceRoot: 'workspace/maze',
  outputPaths: ['workspace/controls.ts'],
  allocatedCredits: 1,
  usedCredits: 0.01,
  reservedCredits: 0,
  pendingApprovals: 0,
  changedFiles: 1,
  conflicts: 0,
  generation: 3,
  createdAt: time,
  updatedAt: time,
  detail: null
};
const missionReview = {
  mission,
  digest: 'fixture-reviewed-content',
  canIntegrate: true,
  detail: 'One file is ready to apply.',
  changes: [
    {
      path: 'workspace/controls.ts',
      kind: 'modified',
      bytes: 20,
      baseHash: 'before',
      resultHash: 'after',
      conflict: false,
      permitted: true,
      binary: false,
      diffOmitted: false,
      diff: '@@ -1 +1 @@\n-oldControl()\n+newControl()'
    }
  ]
};
const inspectedFiles = new Map([
  [`${childWorkspace.id}/workspace/controls.ts`, { text: 'newControl()\n', sha: 'after' }],
  [
    `${workspace.id}/workspace/main.py`,
    { text: 'answer = 40\nprint(answer)\n', sha: 'current-source-hash' }
  ]
]);
const sourceWrites = [];
let failReviewRefresh = false;
const computation = {
  sessionId: 'kernel-60000000-0000-4000-8000-000000000006',
  taskId: task.id,
  workspaceId: workspace.id,
  name: 'Sequence analysis',
  language: 'python',
  cwd: 'workspace',
  state: 'busy',
  createdAt: time,
  deadlineAt: '2026-09-07T00:00:00Z',
  stateRetained: true,
  variables: [{ name: 'samples', type: 'DataFrame', preview: '20 rows, 4 columns' }]
};
const computationHistoryRequests = [];
const projectEventRequests = [];
let recordedReply = null;
const historyEvent = (sequence, kind, payload) => ({
  ...event,
  id: `history-${sequence}`,
  sequence,
  kind,
  payload
});
const historyStart = (sequence, cellId, code) =>
  historyEvent(sequence, 'tool_started', {
    toolCallId: cellId,
    tool: 'process',
    arguments: {
      action: 'compute',
      sessionId: computation.sessionId,
      options: { action: 'cell', cellId, code }
    }
  });
const computationManifest = {
  format: 'garden-computation-manifest-1',
  capturedAt: time,
  requestSha256: 'a'.repeat(64),
  sourceSha256: 'b'.repeat(64),
  predecessorCellId: 'cell-earlier',
  runtime: { version: '3.14.2', platform: 'linux', architecture: 'x86_64' },
  inputs: [
    { path: 'workspace/input.csv', status: 'hashed', bytes: 128, sha256: 'c'.repeat(64) },
    { path: 'workspace/large-input.csv', status: 'unavailable', reason: 'too_large' }
  ],
  coverage: 'declared_inputs_before_execution'
};
const historyReceipt = (sequence, cellId, state, stdout) =>
  historyEvent(sequence, 'tool_result', {
    toolCallId: cellId,
    result: {
      sessionId: computation.sessionId,
      latestCell: {
        cellId,
        state,
        startedAt: time,
        stdout,
        stderr: '',
        artifacts: [],
        ...(state === 'failed'
          ? { error: 'Fixture cell failure', manifest: computationManifest }
          : {})
      }
    }
  });
const computationHistoryPages = [
  [
    historyStart(10, 'cell-earlier', 'earlier_total = 2 + 2'),
    historyReceipt(11, 'cell-earlier', 'completed', '4')
  ],
  [
    historyStart(220, 'cell-latest', 'raise ValueError("fixture")'),
    historyReceipt(221, 'cell-latest', 'failed', 'partial output')
  ]
];
const debugSession = {
  sessionId: 'debug-80000000-0000-4000-8000-000000000008',
  taskId: task.id,
  workspaceId: workspace.id,
  language: 'python',
  program: 'workspace/main.py',
  cwd: 'workspace',
  state: 'stopped',
  createdAt: time,
  updatedAt: time,
  deadlineAt: '2026-09-07T00:00:00Z',
  stopEpoch: 3,
  reason: 'breakpoint',
  frames: [
    { id: 1, name: 'main', path: 'workspace/main.py', line: 2, column: 1, sourceHash: 'hash' }
  ],
  variables: [{ name: 'answer', value: '40', type: 'int', variablesReference: 0 }],
  excludedFrames: 0,
  output: 'ready',
  note: null
};
const debugControls = [];
let computationControls = [];
let mediaBatches = [];
const nativeAuthorization = {
  id: '70000000-0000-4000-8000-000000000007',
  purpose: 'sign_in',
  status: 'pending',
  serverOrigin: origin,
  userCode: 'ABCD-2345',
  deviceLabel: 'garden app on Android',
  expiresAt: new Date(Date.now() + 600000).toISOString()
};
let nativeStepUp, nativeDecision;
let approvals = [];
const approvalRequests = [];
let taskPermissions = [];
let approvalFailures = [];
let transcriptions = [];
const dictationOptions = {
  available: true,
  reason: null,
  routeId: 'dictation-route',
  routeProof: 'reviewed-route-proof',
  modelId: 'dictation-model',
  displayName: 'Reviewed transcriber',
  provider: 'Native provider',
  privacyRoutes: ['external'],
  defaultPrivacyRoute: 'external',
  requiresExternalConsent: true,
  requiresMaxCostUsd: true,
  pricing: [],
  usdPerMinute: null,
  reservationUsd: 0.03,
  maxDurationSeconds: 300,
  maxBytes: 14000000
};
const voiceSession = {
  id: '80000000-0000-4000-8000-000000000008',
  taskId: task.id,
  workspaceId: workspace.id,
  provider: 'openai',
  providerModelId: 'voice-fixture',
  privacyRoute: 'external',
  retention: 'Provider terms',
  voice: 'marin',
  reasoningEffort: 'low',
  status: 'usage_uncertain',
  createdAt: time,
  connectedAt: time,
  deadlineAt: time,
  endedAt: time,
  maxSpendUsd: 0.5,
  settledUsd: 0.01,
  pendingUsd: 0.03,
  inputSeconds: 2,
  outputSeconds: 3,
  currentResponseId: null,
  cleanupPending: false,
  errorCode: null,
  note: 'Final usage pending'
};
const voiceProposal = {
  id: '90000000-0000-4000-8000-000000000009',
  digest: 'exact-voice-proposal-digest',
  sessionId: voiceSession.id,
  taskId: task.id,
  prompt: 'Add a quiet mode to the maze.',
  modelId: task.modelId,
  privacyRoute: task.privacyRoute,
  maxSpendUsd: task.maxSpendUsd,
  status: 'pending',
  createdAt: time,
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  messageId: null
};
const autonomyChanges = [];
let currentPlan = {
  id: 'plan-1',
  taskId: task.id,
  version: 1,
  branchName: 'Main',
  createdAt: time,
  createdBy: 'user',
  steps: [{ id: 'first-step', title: 'Original plan step', status: 'pending' }]
};
const planWrites = [];
const processUi = processFixture(workspace.id, task.id);
const directoryUi = directoryFixture(workspace.id);
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce'
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === isolatedPreviewOrigin) return route.continue();
    if (url.origin !== origin) return route.abort();
    const path = url.pathname;
    const json = (body) => route.fulfill({ json: body });
    // No worker: an empty one registered through a routed response stalls headless navigations
    // that start while requests are still in flight. The worker has its own unit suite.
    if (path === '/sw.js') return route.fulfill({ status: 404, body: '' });
    if (path.startsWith('/__garden/preview/'))
      return route.fulfill({ contentType: 'text/html', body: previewHtml });
    if (!path.startsWith('/v1/')) return route.continue();
    if (path === '/v1/tasks' && route.request().method() === 'GET')
      return json({ tasks: [task], nextCursor: null });
    if (path === '/v1/shares' || path === '/v1/schedules') return json([]);
    if (
      [
        `/v1/workspaces/${workspace.id}/memories`,
        `/v1/workspaces/${workspace.id}/memory-items`,
        `/v1/workspaces/${workspace.id}/skills`
      ].includes(path)
    )
      return json([]);
    if (path === `/v1/workspaces/${workspace.id}/memory-library`)
      return json({ items: [], nextCursor: null });
    if (path === `/v1/workspaces/${workspace.id}/memory-review`)
      return json({ procedures: [], disputed: [], proposals: [] });
    if (path === '/v1/account/memory-block')
      return json({ text: '', bytes: 0, limit: 4096, version: 1, updatedAt: null });
    if (path === '/v1/bootstrap')
      return json({ ...bootstrap, models: modelCatalog, drafts: [...modelDrafts.values()] });
    if (path.endsWith('/updates') && path.startsWith('/v1/projects/'))
      return json({
        head: null,
        updates: [],
        revisions: [],
        nextCursor: null,
        observedAt: new Date().toISOString()
      });
    if (path.endsWith('/sessions') && path.startsWith('/v1/projects/'))
      return json({ sessions: [], unavailableWorkspaces: 0, observedAt: time });
    if (path.endsWith('/intervention')) return json(null);
    if (path.endsWith('/notes') && path.startsWith('/v1/projects/'))
      return json({ notes: [], nextCursor: null });
    if (path === '/v1/projects') return json({ projects: [project], nextCursor: null });
    if (path === `/v1/projects/${project.id}`) {
      if (route.request().method() === 'PATCH') {
        const input = route.request().postDataJSON();
        assert.equal(input.expectedRevision, project.revision);
        Object.assign(project, input, { revision: project.revision + 1 });
      }
      return json(project);
    }
    if (path === `/v1/projects/${project.id}/conversations`)
      return json({ tasks: [task], nextCursor: null });
    if (path === '/v1/drafts/device-key')
      return json({
        userId: bootstrap.user.id,
        sessionId: 'fixture-session',
        key: Buffer.alloc(32, 7).toString('base64')
      });
    if (path === '/v1/workspace-model-preferences') return json(modelSurface(false));
    if (path.endsWith('/model-preferences')) {
      if (route.request().method() === 'PUT') {
        const input = route.request().postDataJSON();
        if (failModelSave) {
          failModelSave = false;
          return route.fulfill({
            status: 503,
            json: { error: { message: 'Model storage is temporarily unavailable' } }
          });
        }
        if (input.expectedRevision !== projectRevision)
          return route.fulfill({
            status: 409,
            json: { error: { message: 'Model choices changed on another device' } }
          });
        projectChoices = input.choices;
        projectRevision++;
      }
      return json(modelSurface(true));
    }
    if (path === '/v1/models') return json(modelCatalog);
    if (path === '/v1/providers') {
      if (route.request().method() === 'PUT') {
        const input = route.request().postDataJSON();
        providerWrites.push(input);
        const connectionId = input.connectionId ?? input.provider;
        providerConnections.set(connectionId, {
          ...providerConnections.get(connectionId),
          ...input,
          apiKey: undefined,
          hasApiKey:
            Boolean(input.apiKey) || providerConnections.get(connectionId)?.hasApiKey || false,
          modelId: input.modelId ?? null
        });
        primaryProvider = connectionId;
      }
      if (route.request().method() === 'DELETE') {
        const selected = url.searchParams.get('connectionId');
        assert(selected, 'The settings interface must remove only the chosen connection');
        providerConnections.delete(selected);
        primaryProvider = providerConnections.keys().next().value;
        return json({ deleted: true });
      }
      return json(providerResponse());
    }
    if (path === '/v1/media/models') {
      if (route.request().method() === 'PUT') generationChoices = route.request().postDataJSON();
      return json(generationSurface());
    }
    if (path === '/v1/account/preferences') {
      if (route.request().method() === 'PUT') {
        const input = route.request().postDataJSON();
        if (input.model && failModelSave) {
          failModelSave = false;
          return route.fulfill({
            status: 503,
            json: { error: { message: 'Model defaults could not be saved' } }
          });
        }
        if (typeof input.decisionModelsEnabled === 'boolean') {
          if (failDecisionSave) {
            failDecisionSave = false;
            return route.fulfill({
              status: 503,
              json: { error: { message: 'Decision preference could not be saved' } }
            });
          }
          decisionModelsEnabled = input.decisionModelsEnabled;
        }
        if (input.model) defaultChoices.main = input.model;
        if (input.modelPurposes) defaultChoices = { ...defaultChoices, ...input.modelPurposes };
      }
      return json({
        preferences: {
          model: defaultChoices.main,
          modelPurposes: Object.fromEntries(
            Object.entries(defaultChoices).filter(([purpose]) => purpose !== 'main')
          )
        }
      });
    }
    if (path === '/v1/tasks' && route.request().method() === 'POST') {
      const key = route.request().headers()['idempotency-key'];
      assert(key);
      if (taskReceipts.has(key)) return json(taskReceipts.get(key));
      if (route.request().headers()['idempotency-replay-only'] === 'true')
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'operation_receipt_unavailable',
              message: 'The original receipt is unavailable'
            }
          }
        });
      createdModelRequest = route.request().postDataJSON();
      projectChoices = createdModelRequest.modelChoices ?? {};
      projectRevision++;
      taskCreations++;
      taskReceipts.set(key, task);
      if (loseSendAcknowledgement) {
        loseSendAcknowledgement = false;
        return route.abort('connectionclosed');
      }
      return json(task);
    }
    if (path === '/v1/audio/transcriptions/options') return json(dictationOptions);
    if (path === '/v1/voice/models')
      return json({
        options: [
          {
            id: 'native-voice-route',
            provider: 'openai',
            providerModelId: 'voice-fixture',
            displayName: 'Native live voice',
            available: true,
            reason: null,
            routeProof: 'voice-reviewed-route',
            privacyRoutes: ['external'],
            requiresExternalConsent: true,
            supportedEfforts: ['minimal', 'low', 'medium'],
            defaultEffort: 'low',
            voices: ['marin', 'cedar'],
            defaultVoice: 'marin',
            pricing: [{ billable: 'audio_input', unit: 'token', costUsd: 0.00001 }],
            priceUpdatedAt: time,
            minimumReservationUsd: 0.02,
            maxDurationSeconds: 1800,
            maxInputSegmentSeconds: 10
          }
        ],
        reason: null
      });
    if (path === `/v1/tasks/${task.id}/voice-sessions`) {
      assert.equal(
        route.request().method(),
        'GET',
        'Opening voice or reviewing a proposal must not start a paid session'
      );
      return json([voiceSession]);
    }
    if (path === `/v1/tasks/${task.id}/voice-discussion`) return json(null);
    if (path === '/v1/voice-sessions') return json([voiceSession]);
    if (path === '/v1/audio/transcriptions/receipts') return json([]);
    if (path === `/v1/voice-sessions/${voiceSession.id}/proposals`) return json([voiceProposal]);
    if (path === `/v1/voice-sessions/${voiceSession.id}/receipts`)
      return json(
        voiceSession.pendingUsd
          ? [
              {
                id: 'voice-receipt',
                providerResponseId: 'provider-response',
                reservedUsd: 0.03,
                createdAt: time
              }
            ]
          : []
      );
    if (path === '/v1/audio/transcriptions') {
      transcriptions.push(route.request().postDataJSON());
      assert.match(route.request().headers()['idempotency-key'], /^[0-9a-f-]{36}$/i);
      return json({ text: 'Keep the controls easy to reach.' });
    }
    if (path.endsWith('/heartbeat')) return json({ ok: true });
    if (path === `/v1/tasks/${task.id}/security-mode`) {
      assert.equal(route.request().method(), 'PATCH');
      const { securityMode } = route.request().postDataJSON();
      autonomyChanges.push(securityMode);
      await new Promise((resolve) => setTimeout(resolve, 100));
      task.securityMode = securityMode;
      return json(task);
    }
    if (path === '/v1/approvals') return json(approvals);
    if (path === `/v1/approvals/tasks/${task.id}/permissions`) return json(taskPermissions);
    if (
      path.startsWith(`/v1/approvals/tasks/${task.id}/permissions/`) &&
      path.endsWith('/revoke')
    ) {
      assert.equal(route.request().method(), 'POST');
      assert.deepEqual(route.request().postDataJSON(), {});
      taskPermissions = taskPermissions.filter((permission) => !path.includes(permission.id));
      return json({ ok: true });
    }

    const approvalAction = path.match(/^\/v1\/approvals\/([^/]+)\/(approve|deny)$/);
    if (approvalAction) {
      const request = route.request();
      assert.equal(request.method(), 'POST');
      assert.match(request.headers()['idempotency-key'], /^[0-9a-f-]{36}$/i);
      approvalRequests.push({
        id: approvalAction[1],
        action: approvalAction[2],
        body: request.postDataJSON()
      });
      const failure = approvalFailures.shift();
      if (failure) return route.fulfill({ status: failure.status, json: { error: failure } });
      if (approvalAction[2] === 'approve' && request.postDataJSON().scope === 'run') {
        const source = approvals.find((approval) => approval.id === approvalAction[1]);
        assert(source?.preview?.taskGrant?.description);
        taskPermissions.push({
          id: source.id,
          description: source.preview.taskGrant.description,
          createdAt: time
        });
      }
      approvals = approvals.filter((approval) => approval.id !== approvalAction[1]);
      return json({ ok: true });
    }
    if (path.endsWith('/artifacts')) return json([]);
    if (path.endsWith('/browser-token'))
      return route.fulfill({
        status: 503,
        json: { error: { message: 'No browser session in this fixture.' } }
      });
    if (path.endsWith('/media-jobs')) return json(path.includes(childTask.id) ? [] : mediaJobs);
    if (path.endsWith('/media-assets')) return json(path.includes(childTask.id) ? [] : mediaAssets);
    if (path.endsWith('/media-batches'))
      return json(path.includes(childTask.id) ? [] : mediaBatches);
    if (path === '/v1/media/batches/batch-fixture/cancel') {
      assert.deepEqual(route.request().postDataJSON(), {});
      mediaBatches[0].cancelRequested = true;
      mediaBatches[0].providerStatus = 'cancelling';
      return json(mediaBatches[0]);
    }
    if (path === `/v1/auth/native/${nativeAuthorization.id}`) return json(nativeAuthorization);
    if (path === '/v1/auth/step-up/options') {
      nativeStepUp = route.request().postDataJSON();
      return json({ verified: true });
    }
    if (path === `/v1/auth/native/${nativeAuthorization.id}/decision`) {
      nativeDecision = route.request().postDataJSON();
      nativeAuthorization.status = 'approved';
      return json(nativeAuthorization);
    }
    if (path.endsWith('/coding-missions'))
      return json({ missions: path.includes(childTask.id) ? [] : missions });
    if (path === `/v1/workspaces/${childWorkspace.id}`) return json(childWorkspace);
    if (path === `/v1/coding-missions/${mission.id}/review`) {
      if (failReviewRefresh) {
        failReviewRefresh = false;
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Review temporarily unavailable' } }
        });
      }
      const file = inspectedFiles.get(`${childWorkspace.id}/workspace/controls.ts`);
      missionReview.digest = `reviewed-${file.sha}`;
      missionReview.changes[0].resultHash = file.sha;
      missionReview.changes[0].diff = `@@ -1 +1 @@\n-oldControl()\n+${file.text.trim()}`;
      return json(missionReview);
    }
    if (path.endsWith('/file')) {
      const key = `${path.split('/')[3]}/${url.searchParams.get('path')}`;
      const file = inspectedFiles.get(key);
      assert(file, `Unexpected source file ${key}`);
      if (route.request().method() === 'PUT') {
        sourceWrites.push({ key, expected: url.searchParams.get('expectSha256') });
        if (url.searchParams.get('expectSha256') !== file.sha)
          return route.fulfill({
            status: 409,
            json: { error: { code: 'file_changed', message: 'File changed on disk' } }
          });
        file.text = route.request().postData();
        file.sha = createHash('sha256').update(file.text).digest('hex');
        return json({ ok: true });
      }
      return route.fulfill({
        contentType: 'text/plain',
        headers: {
          'x-content-sha256': file.sha,
          'x-truncated': 'false',
          'x-end-line': String(file.text.trimEnd().split('\n').length)
        },
        body: file.text
      });
    }
    if (path === `/v1/coding-missions/${mission.id}/integrate`) {
      reviewedSubmission = route.request().postDataJSON();
      mission.state = 'integrated';
      return json(mission);
    }
    if (path === '/v1/media/jobs/video-fixture/reconcile') {
      recoveredVideo = route.request().postDataJSON();
      mediaJobs[0].status = 'in_progress';
      return json(mediaJobs[0]);
    }
    if (path === '/v1/media/assets/character-fixture/reconcile') {
      recordedReceipt = route.request().postDataJSON();
      mediaAssets[0].costUsd = recordedReceipt.costUsd;
      mediaAssets[0].status = 'completed';
      return json(mediaAssets[0]);
    }
    if (path.endsWith('/files')) return json({ entries: [] });
    if (/^\/v1\/projects\/[^/]+\/changes$/.test(path))
      return json([
        {
          taskId: task.id,
          status: 'ready',
          measurement: {
            added: 160,
            removed: 12,
            changedFiles: 3,
            unmeasuredFiles: 0,
            truncated: false
          }
        }
      ]);
    if (await processUi.handle(route, path)) return;
    if (await directoryUi.handle(route, path)) return;
    if (path.endsWith('/computation')) return json({ sessions: [computation] });
    if (path.endsWith('/debugger'))
      return json({ sessions: [debugSession], available: { python: true, javascript: true } });
    if (path.endsWith(`/debugger/${debugSession.sessionId}/control`)) {
      const control = JSON.parse(route.request().postData() ?? '{}');
      debugControls.push(control);
      debugSession.state = 'terminated';
      return json(debugSession);
    }
    if (path.endsWith(`/computation/${computation.sessionId}/control`)) {
      const control = route.request().postDataJSON();
      computationControls.push(control);
      computation.state = control.action === 'interrupt' ? 'interrupted' : 'stopped';
      if (control.action === 'stop') computation.stateRetained = false;
      return json(computation);
    }
    if (path.endsWith('/download')) return route.continue();
    if (path === '/v1/previews/fixture/access') return json({ url: presentation.results[0].url });
    if (path === '/v1/drafts') {
      if (draftOffline) return route.abort('internetdisconnected');
      if (route.request().method() === 'GET') {
        const key = url.searchParams.get('taskId') ?? `new:${url.searchParams.get('workspaceId')}`;
        return json(
          modelDrafts.get(key) ?? {
            workspaceId: workspace.id,
            taskId: url.searchParams.get('taskId'),
            body: '',
            attachments: [],
            revision: draftRevisions.get(key) ?? 0
          }
        );
      }
      draft = route.request().postDataJSON();
      const operation = route.request().headers()['idempotency-key'];
      assert(operation, 'draft saves need an idempotency key');
      if (draftReceipts.has(operation)) return json(draftReceipts.get(operation));
      const key = draft.taskId ?? `new:${draft.workspaceId}`;
      const current = draftRevisions.get(key) ?? 0;
      if (draft.expectedRevision !== current)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'draft_conflict', message: 'Draft revision changed' } }
        });
      draft.revision = current + 1;
      draft.updatedAt = new Date().toISOString();
      draftRevisions.set(key, draft.revision);
      modelDrafts.set(key, draft);
      const receipt = { revision: draft.revision, updatedAt: draft.updatedAt };
      draftReceipts.set(operation, receipt);
      if (loseDraftAcknowledgement) {
        loseDraftAcknowledgement = false;
        lostDraftAcknowledgement?.();
        return route.abort('connectionclosed');
      }
      return json(receipt);
    }
    if (path.endsWith('/presentation'))
      return json(
        path.includes(childTask.id)
          ? { ...presentation, taskId: childTask.id, results: [] }
          : presentation
      );
    if (path.endsWith('/plans')) return json([currentPlan]);
    if (path.endsWith('/plan')) {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        planWrites.push(body);
        if (body.expectedVersion !== currentPlan.version)
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: 'plan_conflict',
                message: 'Plan revision changed. Your draft has not been saved.'
              }
            }
          });
        currentPlan = { ...currentPlan, ...body, version: currentPlan.version + 1 };
      }
      return json(currentPlan);
    }
    if (
      path === `/v1/tasks/${task.id}/events` &&
      url.searchParams.has('before') &&
      url.searchParams.get('limit') === '200'
    ) {
      assert.equal(route.request().method(), 'GET');
      const before = Number(url.searchParams.get('before'));
      computationHistoryRequests.push(before);
      const events = computationHistoryPages[before > 220 ? 1 : 0];
      return json({
        events,
        hasMore: before > 220,
        oldestSequence: events[0].sequence,
        nextCursor: events.at(-1).sequence
      });
    }
    if (path === `/v1/tasks/${task.id}/diagnostics`) return route.continue();
    if (path === `/v1/tasks/${task.id}/events` && url.searchParams.get('limit') === '250') {
      const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null;
      projectEventRequests.push(before);
      const earlier = before === event.sequence;
      return json({
        events: earlier
          ? [
              {
                ...event,
                id: 'opening-activity',
                sequence: 1,
                summary: 'Earlier project direction.',
                kind: 'user_message',
                payload: {
                  markdown: 'Earlier project direction.',
                  attachments: ['workspace/uploads/' + 'long attachment name '.repeat(8) + '.txt']
                }
              }
            ]
          : recordedReply
            ? [
                {
                  ...event,
                  id: 'recorded-answer',
                  sequence: 2,
                  kind: 'assistant_message',
                  payload: { markdown: 'Progress commentary must not replace the final answer.' }
                },
                {
                  ...event,
                  payload: { ...event.payload, answer: recordedReply, answerChannel: 'final' }
                }
              ]
            : [event],
        hasMore: !earlier,
        oldestSequence: earlier ? 1 : event.sequence,
        nextCursor: earlier ? 1 : event.sequence
      });
    }
    if (path.endsWith('/events'))
      return json({
        events: path.includes(childTask.id) ? (childQuestion ? [childQuestion] : []) : [event],
        hasMore: false,
        oldestSequence: 3,
        nextCursor: 3
      });
    if (path === `/v1/tasks/${childTask.id}/answer`) {
      childAnswer = route.request().postDataJSON();
      assert.match(route.request().headers()['idempotency-key'], /^[0-9a-f-]{36}$/i);
      childTask.status = 'queued';
      return json(childTask);
    }
    if (path.endsWith('/events/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
    if (path === `/v1/tasks/${task.id}`) return json(task);
    if (path === `/v1/tasks/${childTask.id}`) return json(childTask);
    errors.push(`Unspecified UI fixture: ${route.request().method()} ${path}`);
    return route.fulfill({ status: 501, json: { error: { message: 'Unspecified UI fixture' } } });
  });
  if (!process.env.GARDEN_UI_FOCUS || process.env.GARDEN_UI_FOCUS === 'desk')
    await checkDesk({ context, origin, task, bootstrap, project, report, directoryUi, processUi });
  if (process.env.GARDEN_UI_FOCUS === 'workspace') {
    await checkWorkspaceNavigation({ context, origin, task, report });
    await checkHumanInterventions({ context, origin, task, report });
    await checkRunningQuestion({ context, origin, bootstrap, task, report });
  }
  if (!process.env.GARDEN_UI_FOCUS || process.env.GARDEN_UI_FOCUS === 'history')
    await checkProjectHistory({ context, origin, task, presentation, report });
  if (process.env.GARDEN_UI_FOCUS === 'memory')
    await checkMemoryLibrary({ context, origin, workspace, project, task, report });
  if (process.env.GARDEN_UI_FOCUS === 'appearance')
    await checkAppearance({ context, origin, bootstrap, project, task, report });
  if (process.env.GARDEN_UI_FOCUS === 'previews')
    await checkPreviewStart({ context, origin, task, presentation, report, errors });
  if (process.env.GARDEN_UI_FOCUS === 'files-jobs') {
    await checkTaskRecovery({ context, origin, bootstrap, task, report, errors });
    await checkArtifactLinks({ context, origin, task, workspace, presentation, report, errors });
    await checkProjectDirectories({
      context,
      origin,
      taskId: task.id,
      workspaceId: workspace.id,
      fixture: directoryUi,
      report,
      errors
    });
    await checkProjectProcesses({
      context,
      origin,
      taskId: task.id,
      fixture: processUi,
      report,
      errors
    });
  }
  if (process.env.GARDEN_UI_FOCUS === 'conversations') {
    await checkProjectConversations({
      context,
      origin,
      bootstrap,
      task,
      workspace,
      presentation,
      models: modelCatalog,
      modelSurface: () => modelSurface(true),
      report,
      errors
    });
  }
  if (
    ![
      'memory',
      'desk',
      'drafts',
      'models',
      'appearance',
      'workspace',
      'history',
      'files-jobs',
      'previews',
      'conversations'
    ].includes(process.env.GARDEN_UI_FOCUS)
  ) {
    if (process.env.GARDEN_UI_FOCUS !== 'journeys') {
      await checkPermissionModes({ context, origin, bootstrap, task, project, workspace, report });
      await checkHumanInterventions({ context, origin, task, report });
      await checkRunningQuestion({ context, origin, bootstrap, task, report });
      await checkProjectConversations({
        context,
        origin,
        bootstrap,
        task,
        workspace,
        presentation,
        models: modelCatalog,
        modelSurface: () => modelSurface(true),
        report,
        errors
      });
      await checkTaskRecovery({ context, origin, bootstrap, task, report, errors });
      await checkArtifactLinks({ context, origin, task, workspace, presentation, report, errors });
      await checkProjectDirectories({
        context,
        origin,
        taskId: task.id,
        workspaceId: workspace.id,
        fixture: directoryUi,
        report,
        errors
      });
      await checkProjectProcesses({
        context,
        origin,
        taskId: task.id,
        fixture: processUi,
        report,
        errors
      });
    }
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/?task=${task.id}`);
    assert.equal(
      await page.locator('link[rel="manifest"]').count(),
      1,
      'Browser installation requires a linked web manifest'
    );
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    assert(manifestHref, 'Browser installation requires a linked web manifest');
    const manifestResponse = await context.request.get(new URL(manifestHref, origin).href);
    assert(manifestResponse.ok(), 'The installation manifest must be served');
    const manifest = await manifestResponse.json();
    assert.equal(manifest.name, 'garden');
    assert(manifest.icons.length > 0, 'Installation icons must exist');
    for (const icon of manifest.icons) {
      const response = await context.request.get(new URL(icon.src, origin).href);
      assert(response.ok(), 'An installation icon must be served');
      assert.equal((await response.body()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
    await page.getByRole('button', { name: 'Open app', exact: true }).waitFor();
    await page.locator('.garden-preview-frame').waitFor();
    assert.equal(await page.locator('.garden-result-map').count(), 0);
    assert(
      await page.evaluate(
        () =>
          document.querySelector('.project-view-nav').getBoundingClientRect().top <
          document.querySelector('.run-summary').getBoundingClientRect().top
      ),
      'Project tools must precede the running work'
    );
    await page.getByRole('button', { name: /^Continue this conversation/ }).click();
    assert(projectEventRequests.length > 0, 'Opening a project must load its event page');
    assert.equal(projectEventRequests[0], null, 'Open the most recent page without a sentinel');
    await page
      .locator(
        'body:has(.project-panel[open]) .project-panel[open] .project-view-nav, body:not(:has(.project-panel[open])) .project-workspace-bar .project-view-nav'
      )
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    await page.getByRole('button', { name: 'Full activity', exact: true }).click();
    const activity = page.getByRole('dialog', { name: 'Activity and directions', exact: true });
    await activity.getByText('Troubleshooting', { exact: true }).click();
    const diagnosticLink = activity.getByRole('link', {
      name: 'Download diagnostics',
      exact: true
    });
    assert.equal(await diagnosticLink.getAttribute('href'), `/v1/tasks/${task.id}/diagnostics`);
    const diagnosticPromise = page.waitForEvent('download');
    await diagnosticLink.click();
    const diagnostic = await diagnosticPromise;
    assert.equal(diagnostic.suggestedFilename(), 'garden-diagnostic.ndjson');
    assert.deepEqual(JSON.parse(await readFile(await diagnostic.path(), 'utf8')), {
      fixture: 'content_omitted'
    });
    await activity.getByText('Troubleshooting', { exact: true }).click();

    await activity.getByRole('button', { name: 'Earlier activity', exact: true }).click();
    await activity.getByText('Earlier project direction.', { exact: true }).waitFor();
    await activity.getByRole('button', { name: 'Details', exact: true }).click();
    const messageDetails = page.getByRole('dialog', { name: 'user message', exact: true });
    const attachment = messageDetails
      .getByRole('list', { name: 'Attached files' })
      .getByRole('link');
    await attachment.waitFor();
    assert.match(await attachment.getAttribute('href'), /workspace%2Fuploads%2Flong%20attachment/);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = await attachment.evaluate((element) => {
        const link = element.getBoundingClientRect(),
          list = element.closest('ul').getBoundingClientRect(),
          text = element.querySelector('span').getBoundingClientRect();
        return {
          fits: link.left >= list.left && link.right <= list.right + 1,
          padded: text.left > link.left && text.right < link.right,
          overflow: element.scrollWidth > element.clientWidth + 1
        };
      });
      assert(
        bounds.fits && bounds.padded && !bounds.overflow,
        'Long attachment names must wrap inside padded links'
      );
    }
    await page.screenshot({ path: resolve(report, 'message-attachment-phone.png') });
    await messageDetails.getByRole('button', { name: 'Close user message', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });

    assert.equal(
      projectEventRequests.at(-1),
      event.sequence,
      'Earlier activity uses its oldest cursor'
    );
    await activity.getByRole('button', { name: 'Latest', exact: true }).click();
    await activity.getByText(event.summary, { exact: true }).waitFor();
    assert.equal(
      await activity.getByText('Earlier project direction.', { exact: true }).count(),
      0
    );
    await activity
      .getByRole('button', { name: 'Close Activity and directions', exact: true })
      .click();
    await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
    const planDialog = page.getByRole('dialog', { name: 'The plan', exact: true });
    await planDialog
      .getByRole('textbox', { name: 'Step 1', exact: true })
      .fill('My unsaved plan step');
    currentPlan = {
      ...currentPlan,
      id: 'plan-2',
      version: 2,
      steps: [{ id: 'first-step', title: 'Concurrent server plan step', status: 'pending' }]
    };
    const refreshedPlan = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/tasks/${task.id}/plan` &&
        response.request().method() === 'GET'
    );
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await (await refreshedPlan).finished();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const conflictResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/tasks/${task.id}/plan` &&
        response.request().method() === 'POST'
    );
    await planDialog.getByRole('button', { name: 'Save plan', exact: true }).click();
    await conflictResponse;
    assert.equal(
      planWrites.at(-1).expectedVersion,
      1,
      'An open draft must keep its original version when server metadata refreshes'
    );
    await planDialog
      .getByText('Plan revision changed. Your draft has not been saved.', { exact: true })
      .waitFor();
    assert.equal(
      await planDialog.getByRole('textbox', { name: 'Step 1', exact: true }).inputValue(),
      'My unsaved plan step',
      'A save conflict must preserve the owner draft'
    );
    assert.equal(currentPlan.steps[0].title, 'Concurrent server plan step');
    await page.setViewportSize({ width: 390, height: 844 });
    await planDialog
      .getByText('A newer plan is available. Your draft is still based on version 1.', {
        exact: true
      })
      .waitFor();
    await page.screenshot({ path: resolve(report, 'plan-conflict-phone.png') });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'Plan conflict controls must fit on a phone'
    );
    await planDialog
      .getByRole('button', { name: 'Discard draft and load latest plan', exact: true })
      .click();
    assert.equal(
      await planDialog.getByRole('textbox', { name: 'Step 1', exact: true }).inputValue(),
      'Concurrent server plan step'
    );
    await planDialog
      .getByRole('textbox', { name: 'Step 1', exact: true })
      .fill('Revised latest plan step');
    const saveLatest = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/tasks/${task.id}/plan` &&
        response.request().method() === 'POST'
    );
    await planDialog.getByRole('button', { name: 'Save plan', exact: true }).click();
    assert.equal((await saveLatest).status(), 200);
    assert.equal(planWrites.at(-1).expectedVersion, 2);
    assert.equal(currentPlan.steps[0].title, 'Revised latest plan step');
    await planDialog
      .getByRole('textbox', { name: 'Step 1', exact: true })
      .fill('Second saved revision');
    const saveAgain = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/tasks/${task.id}/plan` &&
        response.request().method() === 'POST'
    );
    await planDialog.getByRole('button', { name: 'Save plan', exact: true }).click();
    assert.equal((await saveAgain).status(), 200);
    assert.equal(
      planWrites.at(-1).expectedVersion,
      3,
      'A successful save advances the draft version'
    );
    await planDialog.getByRole('button', { name: 'Close The plan', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.project-panel[open] > .dialog-heading > button').click();
    await page.locator('.project-panel[open]').waitFor({ state: 'hidden' });
    await revealPromptSettings(page);
    const autonomy = page.getByRole('combobox', { name: 'Approvals for this prompt', exact: true });
    await autonomy.selectOption('autonomous');
    assert.equal(
      autonomyChanges.length,
      0,
      'A completed task selection must not mutate the project'
    );
    assert.equal(await page.locator('.garden-top-tools select').count(), 0);
    for (const [width, height] of [
      [1440, 1000],
      [1024, 900],
      [768, 900],
      [720, 500],
      [390, 844],
      [375, 812],
      [320, 600]
    ]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => {
        const box = (selector) => {
          const b = document.querySelector(selector).getBoundingClientRect();
          return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height };
        };
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          main: box('.garden-main'),
          scroll: box('.garden-task-scroll'),
          composer: box('.garden-task-composer'),
          textarea: box('.intent-editor > textarea'),
          toolbar: box('.intent-toolbar'),
          viewportHeight: innerHeight
        };
      });
      assert.equal(layout.document, width, 'The page must not scroll sideways');
      assert(
        layout.textarea.bottom <= layout.toolbar.top,
        'Prompt actions must never overlap the text input'
      );
      assert(
        layout.scroll.bottom <= layout.composer.top + 1,
        `The composer must not overlap the work: ${JSON.stringify(layout)}`
      );
      assert(
        layout.composer.bottom <= layout.viewportHeight + 1,
        'The composer must stay inside the viewport'
      );
      assert(
        layout.scroll.height > 0 && layout.composer.height > 0,
        'The scroll areas must remain usable'
      );
      await page.screenshot({ path: resolve(report, `task-${width}.png`) });
    }
    await page
      .getByRole('navigation', { name: 'Workspace navigation' })
      .getByRole('button', { name: 'Projects', exact: true })
      .click();
    const projectPanel = page.getByRole('dialog', { name: 'Projects', exact: true });
    await projectPanel.waitFor();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      assert(
        await page.evaluate(() => Boolean(document.activeElement.closest('.desk-sheet-projects'))),
        'Project navigation must contain keyboard focus'
      );
    }
    await page.keyboard.press('Escape');
    await projectPanel.waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(
      await page.locator('.garden-status-footer').count(),
      0,
      'Routine work must not reserve a footer for repeated slogans'
    );
    assert.equal(
      await page.getByRole('button', { name: /^Switch to .* mode$/, includeHidden: true }).count(),
      0,
      'Appearance is available in Settings without duplicate navigation controls'
    );
    const alignment = await page.evaluate(() => {
      const header = document.querySelector('.garden-masthead').getBoundingClientRect();
      const brand = document.querySelector('.garden-masthead .brand').getBoundingClientRect();
      return Math.abs((header.top + header.bottom) / 2 - (brand.top + brand.bottom) / 2);
    });
    assert(alignment < 3, 'The wordmark must align vertically with its toolbar');
    const directionInput = page.getByRole('textbox', {
      name: 'Add direction to this work',
      exact: true
    });
    await directionInput.fill('');
    const initialHeight = await directionInput.evaluate((element) => element.clientHeight);
    await directionInput.fill(
      Array.from({ length: 7 }, (_, i) => `Direction line ${i}`).join('\n')
    );
    assert(
      (await directionInput.evaluate((element) => element.clientHeight)) > initialHeight,
      'The direction grows automatically with its text'
    );
    await directionInput.fill('A longer direction.\n'.repeat(80));
    assert(
      await directionInput.evaluate(
        (element) => element.clientHeight <= 180 && element.scrollHeight > element.clientHeight
      ),
      'Long directions stop growing and scroll inside their bound'
    );
    assert.equal(
      await directionInput.evaluate((element) => getComputedStyle(element).resize),
      'none'
    );
    await directionInput.fill('Keep this direction while adjusting options.');
    assert.equal(
      await directionInput.evaluate((element) => element.clientHeight),
      initialHeight,
      'Removing text shrinks the direction editor'
    );
    await page.setViewportSize({ width: 320, height: 600 });
    await revealPromptSettings(page);
    const limit = page.getByRole('spinbutton', {
      name: 'Additional spend limit in USD',
      exact: true
    });
    await limit.fill('0.2');
    await limit.press('Enter');
    assert.equal(
      await directionInput.inputValue(),
      'Keep this direction while adjusting options.',
      'Editing an option must not submit or clear the direction'
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    const effort = page.getByRole('combobox', { name: 'Model reasoning effort' });
    await effort.selectOption('max');
    const savedChoice = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/drafts' &&
        response.request().postDataJSON()?.body === 'Keep this draft and its effort choice.' &&
        response.request().postDataJSON()?.controls?.reasoningEffort === 'max'
    );
    await page.locator(`#intent-${task.id}`).fill('Keep this draft and its effort choice.');
    assert((await savedChoice).ok());
    assert.equal(
      draft.controls.reasoningEffort,
      'max',
      'The effort choice must travel with the saved draft'
    );
    assert.equal(draft.controls.securityMode, 'autonomous');
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value) => {
            window.copiedResultLink = value;
          }
        }
      })
    );
    // Prompt settings float above the work; close them before reaching for a result's controls.
    const closePromptSettings = page.getByRole('button', {
      name: 'Close prompt settings',
      exact: true
    });
    if (await closePromptSettings.isVisible()) await closePromptSettings.click();
    await page.getByRole('button', { name: 'Copy link', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Link copied.' }).waitFor();
    assert.equal(await page.evaluate(() => window.copiedResultLink), presentation.results[0].url);
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('Clipboard unavailable');
          }
        }
      })
    );
    await page.getByRole('button', { name: 'Copy link', exact: true }).click();
    const manualResultLink = page.getByRole('textbox', { name: 'Copy this link', exact: true });
    await manualResultLink.waitFor();
    assert.equal(await manualResultLink.inputValue(), presentation.results[0].url);
    await manualResultLink.focus();
    assert(
      await manualResultLink.evaluate(
        (input) => input.selectionStart === 0 && input.selectionEnd === input.value.length
      ),
      'Clipboard refusal must retain a selectable result link'
    );
    const nativePageCount = page.context().pages().length;
    await page.evaluate(() => {
      window.nativePreviewCalls = [];
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          window.nativePreviewCalls.push({ command, args });
        }
      };
    });
    await page.getByRole('button', { name: 'Open app', exact: true }).click();
    await page.waitForFunction(() => window.nativePreviewCalls.length > 0);
    assert.deepEqual(await page.evaluate(() => window.nativePreviewCalls), [
      { command: 'open_preview_browser', args: { url: presentation.results[0].url } }
    ]);
    assert.equal(
      page.context().pages().length,
      nativePageCount,
      'The native action must use the system browser command without a webview popup'
    );
    await page.evaluate(() => delete window.__TAURI_INTERNALS__);
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Open app', exact: true }).click();
    const popup = await popupPromise;
    await popup.getByRole('button', { name: '0', exact: true }).click();
    assert.equal(await popup.getByRole('button').textContent(), '1');
    await popup.close();
    await page.getByRole('button', { name: 'Close embedded preview' }).click();
    await page.getByRole('button', { name: 'View here', exact: true }).click();
    assert.equal(
      (await page.locator('.garden-preview-frame').getAttribute('sandbox')).includes(
        'allow-same-origin'
      ),
      false,
      'A shared owner-origin preview must stay opaque'
    );
    await page
      .frameLocator('.garden-preview-frame')
      .getByRole('button', { name: '0', exact: true })
      .click();
    await page.getByRole('button', { name: 'Expand', exact: true }).click();
    assert.equal(
      await page.frameLocator('.garden-preview-frame').getByRole('button').textContent(),
      '1',
      'Expanding must preserve the running preview'
    );
    await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download source', exact: true }).click();
    const download = await downloadPromise;
    assert.equal(await readFile(await download.path(), 'utf8'), previewHtml);
    await page.evaluate(() =>
      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value: undefined
      })
    );
    await page.getByRole('button', { name: 'Expand', exact: true }).click();
    assert.equal(
      await page.frameLocator('.garden-preview-frame').getByRole('button').textContent(),
      '1',
      'Fallback expansion must preserve the running preview'
    );
    assert.equal(await page.locator('.garden-output-primary.expanded').count(), 1);
    await page.getByRole('button', { name: 'Exit full screen', exact: true }).focus();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      assert(
        await page.evaluate(() =>
          Boolean(document.activeElement.closest('.garden-output-primary.expanded'))
        ),
        'Expanded previews must contain keyboard focus'
      );
    }
    await page.getByRole('button', { name: 'Close embedded preview' }).click();
    assert.equal(
      await page.locator('.garden-output-primary.expanded').count(),
      0,
      'Closing the preview must leave expanded mode'
    );
    presentation.results[0].url =
      isolatedPreviewOrigin + '/__garden/preview/' + 'a'.repeat(32) + '/';
    await page.getByRole('button', { name: 'View here', exact: true }).click();
    assert.equal(
      (await page.locator('.garden-preview-frame').getAttribute('sandbox')).includes(
        'allow-same-origin'
      ),
      true,
      'A separate preview origin must support ordinary app storage and requests'
    );
    const isolatedFrame = page.frameLocator('.garden-preview-frame');
    await isolatedFrame.locator('body[data-storage="stored"][data-request="true"]').waitFor();
    await isolatedFrame.getByRole('button', { name: '0', exact: true }).click();
    assert.equal(await isolatedFrame.getByRole('button').textContent(), '1');
    await page.getByRole('button', { name: 'Close embedded preview' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('light');
    await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Settings', exact: true })
      .waitFor({ state: 'detached' });
    await page.screenshot({ path: resolve(report, 'task-light.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
    await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Settings', exact: true })
      .waitFor({ state: 'detached' });
    recordedReply = 'harbor-cobalt-46';
    await page.reload();
    await page
      .getByRole('navigation', { name: 'Output views' })
      .getByRole('button', { name: 'Summary', exact: true })
      .click();
    await page.locator('.garden-answer').getByText('harbor-cobalt-46', { exact: true }).waitFor();
    await page
      .locator(
        'body:has(.project-panel[open]) .project-panel[open] .project-view-nav, body:not(:has(.project-panel[open])) .project-workspace-bar .project-view-nav'
      )
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    await page
      .locator('.completion-record .badge')
      .getByText('Completion recorded', { exact: true })
      .waitFor();
    await page
      .locator('.completion-record')
      .getByText(event.payload.summary, { exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator('.garden-answer')
        .getByText(event.payload.summary, { exact: true })
        .count(),
      0,
      'A timeline receipt must not replace the actual answer'
    );
    const previousVerification = event.payload.verification;
    event.payload.verification = {
      status: 'verified',
      evidence: [
        { claim: 'The output source was read', source: 'tool_result' },
        { claim: 'The verifier passed: python3 verify.py — exit 0', source: 'acceptance_check' }
      ]
    };
    event.payload.acceptance = ['The verifier passed: python3 verify.py — exit 0'];
    await page.reload();
    const completionRecord = page.locator('.completion-record');
    await completionRecord.getByText('1 check passed', { exact: true }).waitFor();
    await completionRecord.getByText('Evidence and checks', { exact: true }).click();
    await completionRecord.getByText('Executed check', { exact: true }).waitFor();
    await completionRecord.getByText('Cited tool result', { exact: true }).waitFor();
    assert.equal(
      await completionRecord.locator('.completion-acceptance li').textContent(),
      event.payload.acceptance[0]
    );
    assert.equal(await completionRecord.locator('pre').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await completionRecord.evaluate((node) => node.scrollWidth > node.clientWidth + 1),
      false
    );
    await page.screenshot({ path: resolve(report, 'completion-checks-phone.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    event.payload.verification = previousVerification;
    delete event.payload.acceptance;
    recordedReply = null;
    presentation.results = [];
    await page.reload();
    await page.getByText('Recorded activity · latest 2 actions', { exact: true }).click();
    assert.equal(await page.locator('.garden-recorded-actions strong').count(), 2);
    assert.equal(
      await page.locator('.garden-recorded-actions strong').first().textContent(),
      'Created maze/index.html'
    );
    await page.screenshot({ path: resolve(report, 'recorded-trace.png') });
    await page.locator('.project-panel[open] > .dialog-heading > button').click();
    await page.locator('.project-panel[open]').waitFor({ state: 'hidden' });
    task.deliveryStatus = 'pending';
    task.pendingDeliveryCount = 1;
    presentation.delivery = { status: 'pending', pendingJobs: 1, failedJobs: 0, completedJobs: 0 };
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('.run-summary')?.textContent.includes('Generating media')
    );
    assert.equal(
      await page.locator('.desk-updates .desk-update-row .status-sprite.stage-bloom').count(),
      0,
      'The project list must not show pending output as finished'
    );
    assert(
      (await page.locator('.desk-updates .desk-update-row .status-sprite.stage-sprout').count()) >
        0,
      'Pending output reads as still growing'
    );
    missions = [mission];
    mediaJobs = [
      {
        id: 'video-fixture',
        taskId: task.id,
        workspaceId: workspace.id,
        operation: 'generate',
        status: 'submission_uncertain',
        modelId: 'Video fixture',
        progress: null,
        watching: true,
        reservationUsd: 0.1,
        costUsd: null,
        costSource: 'unresolved',
        artifactId: null,
        error: 'The provider response was interrupted.',
        createdAt: time,
        updatedAt: time
      }
    ];
    mediaAssets = [
      {
        id: 'character-fixture',
        taskId: task.id,
        workspaceId: workspace.id,
        name: 'Reference character',
        providerAssetId: 'char_recorded',
        status: 'submission_uncertain',
        reservationUsd: 0.02,
        costUsd: null,
        createdAt: time,
        updatedAt: time
      }
    ];
    mediaBatches = [
      {
        id: 'batch-fixture',
        taskId: task.id,
        workspaceId: workspace.id,
        status: 'pending',
        total: 3,
        completed: 1,
        failed: 0,
        reservationUsd: 0.6,
        watching: true,
        cancelRequested: false,
        providerStatus: 'in_progress',
        reconciliation: null,
        cancellationSupported: true,
        error: null,
        createdAt: time,
        updatedAt: time
      }
    ];
    await page.reload();
    const batchCard = page.getByRole('article', { name: 'Video batch', exact: true });
    await batchCard.getByRole('button', { name: 'Cancel batch', exact: true }).click();
    await batchCard.getByText('The provider is cancelling this batch.', { exact: false }).waitFor();
    assert.equal(await batchCard.locator('.badge').textContent(), 'Rendering');
    assert.equal(await batchCard.getByText('Cancelled', { exact: true }).count(), 0);
    await page
      .locator(
        'body:has(.project-panel[open]) .project-panel[open] .project-view-nav, body:not(:has(.project-panel[open])) .project-workspace-bar .project-view-nav'
      )
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    await page.getByRole('button', { name: 'Review changes', exact: true }).click();
    const reviewDialog = page.getByRole('dialog', {
      name: 'Review Keyboard controls',
      exact: true
    });
    await reviewDialog.locator('summary').click();
    assert.match(
      await reviewDialog.locator('.garden-mission-diff').textContent(),
      /\+newControl\(\)/
    );
    await reviewDialog.getByRole('button', { name: 'Inspect proposed file' }).click();
    const source = reviewDialog.getByRole('region', {
      name: 'Source workspace/controls.ts',
      exact: true
    });
    const sourceInput = source.getByRole('textbox', {
      name: 'Contents of workspace/controls.ts',
      exact: true
    });
    await sourceInput.fill('revisedControl()\n');
    assert.equal(
      await reviewDialog.getByRole('button', { name: 'Apply reviewed changes' }).isDisabled(),
      true
    );
    await reviewDialog.getByRole('button', { name: 'Close review', exact: true }).click();
    await reviewDialog
      .getByText('Save or discard the file edits before closing this review.', { exact: true })
      .waitFor();
    const proposed = inspectedFiles.get(`${childWorkspace.id}/workspace/controls.ts`);
    proposed.text = 'externalControl()\n';
    proposed.sha = 'external-version';
    await source.getByRole('button', { name: 'Save changes', exact: true }).click();
    await source.getByText('File changed on disk', { exact: true }).waitFor();
    assert.equal(
      await sourceInput.inputValue(),
      'revisedControl()\n',
      'A conflict must preserve local edits'
    );
    assert.equal(proposed.text, 'externalControl()\n', 'A conflict must preserve the other writer');
    await source.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await source.getByRole('button', { name: 'Reload file', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Contents of workspace/controls.ts"]')?.value ===
        'externalControl()\n'
    );
    await sourceInput.fill('revisedControl()\n');
    failReviewRefresh = true;
    await source.getByRole('button', { name: 'Save changes', exact: true }).click();
    await reviewDialog.getByText('Review temporarily unavailable', { exact: true }).waitFor();
    assert.equal(proposed.text, 'revisedControl()\n');
    assert.equal(
      await reviewDialog.getByRole('button', { name: 'Apply reviewed changes' }).isDisabled(),
      true,
      'An unrefreshed review cannot apply an edited file'
    );
    await reviewDialog.getByRole('button', { name: 'Refresh review', exact: true }).click();
    await reviewDialog
      .getByText('@@ -1 +1 @@\n-oldControl()\n+revisedControl()', { exact: true })
      .waitFor();
    assert.equal(
      await reviewDialog.getByText('Review temporarily unavailable', { exact: true }).count(),
      0,
      'A refreshed review clears its previous error'
    );
    assert.deepEqual(sourceWrites, [
      { key: `${childWorkspace.id}/workspace/controls.ts`, expected: 'after' },
      { key: `${childWorkspace.id}/workspace/controls.ts`, expected: 'external-version' }
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'The source review must fit a phone'
    );
    await page.screenshot({ path: resolve(report, 'source-review-phone.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await reviewDialog.getByRole('button', { name: 'Apply reviewed changes' }).click();
    await page.getByText('Changes applied', { exact: true }).waitFor();
    assert.deepEqual(
      reviewedSubmission,
      { digest: missionReview.digest, generation: 3 },
      'Integration must carry the inspected digest and generation'
    );
    await page.getByRole('button', { name: 'Open work', exact: true }).click();
    await page.getByRole('button', { name: 'Return to parent work', exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('task'), childTask.id);
    await page
      .getByRole('navigation', { name: 'Workspace navigation' })
      .getByRole('button', { name: 'Projects', exact: true })
      .click();
    assert(
      !(await page.getByRole('dialog', { name: 'Projects', exact: true }).textContent()).includes(
        childWorkspace.name
      ),
      'Internal specialist workspaces must not become projects'
    );
    await page.getByRole('button', { name: 'Close Projects', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Projects', exact: true })
      .waitFor({ state: 'detached' });
    await page
      .locator(
        'body:has(.project-panel[open]) .project-panel[open] .project-view-nav, body:not(:has(.project-panel[open])) .project-workspace-bar .project-view-nav'
      )
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await page.locator('.computer.panel').waitFor();
    assert.equal(
      await page.locator('.computer.panel').getAttribute('aria-label'),
      `${childWorkspace.name} computer`,
      'Computer controls must remain scoped to the selected specialist workspace'
    );
    await page.goBack();
    await page.getByRole('button', { name: 'Return to parent work', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('combobox', { name: 'Model reasoning effort' }).count(),
      0,
      'An allocated specialist must not offer a new model allocation'
    );
    childTask.status = 'awaiting_user';
    mission.state = 'paused';
    childQuestion = {
      ...event,
      id: '30000000-0000-4000-8000-000000000009',
      taskId: childTask.id,
      kind: 'question_asked',
      sequence: 4,
      summary: 'Choose the movement keys',
      payload: { question: 'Which keys should move the player?', options: ['Arrow keys', 'WASD'] }
    };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByLabel('Your answer').waitFor();
    await page.getByLabel('Your answer').fill('Use both arrow keys and WASD.');
    const encryptedAnswers = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('garden-private-drafts', 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      let rows = [];
      const deadline = Date.now() + 5000;
      while (!rows.length && Date.now() < deadline) {
        rows = await new Promise((resolve) => {
          const request = db.transaction('answers').objectStore('answers').getAll();
          request.onsuccess = () => resolve(request.result);
        });
        if (!rows.length) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      db.close();
      sessionStorage.clear();
      return rows;
    });
    assert(encryptedAnswers.length > 0, 'Question answer must reach durable device storage');
    assert(
      !JSON.stringify(encryptedAnswers).includes('Use both arrow keys and WASD.'),
      'Question drafts must not persist plaintext'
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByLabel('Your answer').waitFor();
    assert.equal(
      await page.getByLabel('Your answer').inputValue(),
      'Use both arrow keys and WASD.',
      'Pending question drafts survive a reload'
    );
    await page.getByRole('button', { name: 'Answer and continue', exact: true }).click();
    await page
      .getByRole('button', { name: 'Answer and continue', exact: true })
      .waitFor({ state: 'detached' });
    assert.deepEqual(
      childAnswer,
      { questionId: childQuestion.id, prompt: 'Use both arrow keys and WASD.' },
      'A specialist answer must preserve its existing allocation and model'
    );
    await page.getByRole('button', { name: 'Return to parent work', exact: true }).click();
    await page.getByText('Recover an uncertain submission', { exact: true }).click();
    await page.getByLabel('Provider video ID', { exact: true }).fill('video_existing');
    await page.getByRole('button', { name: 'Recover video', exact: true }).click();
    await page.getByText('in progress', { exact: true }).waitFor();
    assert.deepEqual(recoveredVideo, { providerJobId: 'video_existing' });
    await page.getByText('Record provider receipt', { exact: true }).click();
    assert.equal(await page.getByLabel('Provider character ID').inputValue(), 'char_recorded');
    await page.getByLabel('Final provider charge (USD)').fill('0.0125');
    await page.getByRole('button', { name: 'Record receipt', exact: true }).click();
    await page.getByText('Provider charge $0.01', { exact: true }).waitFor();
    assert.deepEqual(recordedReceipt, { providerCharacterId: 'char_recorded', costUsd: 0.0125 });
    await page.getByRole('button', { name: 'Stats', exact: true }).click();
    await page.getByRole('button', { name: 'All computer work', exact: true }).click();
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('button', { name: 'View execution history', exact: true }).click();
    const history = page.getByRole('region', { name: 'Execution history', exact: true });
    await history.getByText('cell-latest', { exact: true }).click();
    await history.getByText('raise ValueError("fixture")', { exact: true }).waitFor();
    await history.getByText('Fixture cell failure', { exact: true }).waitFor();
    await history.getByText('Source and input record', { exact: true }).click();
    await history.getByText('workspace/input.csv', { exact: true }).waitFor();
    await history.getByText('Hash unavailable: too large.', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await history.getByText('Source and input record', { exact: true }).scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Input hashes must wrap on a phone'
    );
    await page.screenshot({ path: resolve(report, 'computation-manifest-phone.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const historyDownloadPromise = page.waitForEvent('download');
    await history.getByRole('button', { name: 'Export this history page', exact: true }).click();
    const historyDownload = await historyDownloadPromise;
    const exportedHistory = JSON.parse(await readFile(await historyDownload.path(), 'utf8'));
    assert.equal(exportedHistory.entries.length, 1);
    assert.equal(exportedHistory.entries[0].receipt.state, 'failed');
    assert.deepEqual(exportedHistory.entries[0].receipt.manifest, computationManifest);
    assert.deepEqual(exportedHistory.coverage, {
      olderEventsAvailable: true,
      newerEventsAvailable: false,
      oldestSequence: 220,
      newestSequence: 221,
      eventCount: 2
    });
    await history.getByRole('button', { name: 'Earlier history', exact: true }).click();
    await history.getByText('cell-earlier', { exact: true }).click();
    await history.getByText('earlier_total = 2 + 2', { exact: true }).waitFor();
    assert.equal(
      await history.getByText('cell-latest', { exact: true }).count(),
      0,
      'History must release the previous page'
    );
    await history.getByRole('button', { name: 'Newer history', exact: true }).click();
    await history.getByText('cell-latest', { exact: true }).waitFor();
    assert.deepEqual(computationHistoryRequests, [
      Number.MAX_SAFE_INTEGER,
      220,
      Number.MAX_SAFE_INTEGER
    ]);
    assert.deepEqual(
      computationControls,
      [],
      'Inspecting and exporting history must never execute or interrupt a cell'
    );
    await page.getByRole('button', { name: 'Hide execution history', exact: true }).click();
    await page.getByRole('button', { name: 'Interrupt cell', exact: true }).click();
    await page.getByText('Python · interrupted', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'End session…', exact: true }).click();
    await page.getByRole('button', { name: 'Keep session', exact: true }).click();
    assert.deepEqual(
      computationControls,
      [{ action: 'interrupt' }],
      'Keeping a session must preserve its state'
    );
    await page.getByRole('button', { name: 'End session…', exact: true }).click();
    await page.getByRole('button', { name: 'End session', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Job views' })
      .getByRole('button', { name: /^History / })
      .click();
    await page.getByText('Python · stopped', { exact: true }).waitFor();
    assert.deepEqual(computationControls, [{ action: 'interrupt' }, { action: 'stop' }]);
    await page.getByText('Debug a program', { exact: true }).click();
    await page.getByText('workspace/main.py:2', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'workspace/main.py:2', exact: true }).click();
    const debugSource = page.getByRole('region', { name: 'Source workspace/main.py', exact: true });
    await debugSource
      .getByText(
        'This file has changed since the recorded source. The contents below are current.',
        { exact: true }
      )
      .waitFor();
    const debugInput = debugSource.getByRole('textbox', { name: 'Contents of workspace/main.py' });
    assert.equal(
      await debugInput.evaluate((input) =>
        input.value.slice(input.selectionStart, input.selectionEnd)
      ),
      'print(answer)',
      'The paused source line must be selected'
    );
    assert.deepEqual(debugControls, [], 'Source inspection must not run or resume the program');
    await page.getByRole('button', { name: 'Close source', exact: true }).click();
    await page.getByRole('button', { name: 'End debug session…', exact: true }).click();
    await page.getByRole('button', { name: 'Keep debugging', exact: true }).click();
    assert.deepEqual(debugControls, [], 'Keeping a debug session must preserve the paused program');
    await page.getByRole('button', { name: 'End debug session…', exact: true }).click();
    await page.getByRole('button', { name: 'End session', exact: true }).click();
    await page.getByText('Python · terminated', { exact: true }).waitFor();
    assert.deepEqual(debugControls, [{ action: 'stop' }]);
    const authorizationPage = await context.newPage();
    authorizationPage.on('pageerror', (error) => errors.push(error.message));
    await authorizationPage.goto(`${origin}/#native-auth=${nativeAuthorization.id}`);
    const authorizeDialog = authorizationPage.getByRole('dialog', {
      name: 'Authorize your garden app',
      exact: true
    });
    const authorizeButton = authorizeDialog.getByRole('button', {
      name: 'Verify passkey and authorize',
      exact: true
    });
    await authorizeButton.waitFor();
    assert.equal(
      await authorizeButton.isEnabled(),
      false,
      'Authorization requires explicit code confirmation'
    );
    assert.equal(nativeDecision, undefined);
    await authorizeDialog.getByRole('checkbox').check();
    await authorizeButton.click();
    await authorizationPage
      .getByText('Your garden app can now continue. Return to it on your device.')
      .waitFor();
    assert.deepEqual(
      nativeStepUp,
      { force: true },
      'Device approval must force fresh passkey verification'
    );
    assert.deepEqual(nativeDecision, { userCode: 'ABCD-2345', approve: true });
    await authorizationPage.screenshot({ path: resolve(report, 'device-authorization.png') });
    await authorizationPage.close();
    const dictationPage = await context.newPage();
    dictationPage.on('pageerror', (error) => errors.push(error.message));
    await dictationPage.addInitScript(() => {
      window.dictationFixture = { requests: 0, stops: 0, deferred: false, release: null };
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: () => {
            window.dictationFixture.requests++;
            const stream = { getTracks: () => [{ stop: () => window.dictationFixture.stops++ }] };
            return window.dictationFixture.deferred
              ? new Promise((resolve) => {
                  window.dictationFixture.release = () => resolve(stream);
                })
              : Promise.resolve(stream);
          }
        }
      });
      window.MediaRecorder = class {
        state = 'inactive';
        mimeType = 'audio/webm';
        start() {
          this.state = 'recording';
        }
        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob(['fixture audio'], { type: this.mimeType }) });
          this.onstop?.();
        }
      };
    });
    await dictationPage.goto(`${origin}/?task=${task.id}`);
    await dictationPage.locator('.garden-task-composer').waitFor();
    if (
      await dictationPage.getByRole('button', { name: /^Continue this conversation/ }).isVisible()
    )
      await dictationPage.getByRole('button', { name: /^Continue this conversation/ }).click();
    await dictationPage.getByRole('button', { name: 'Dictate direction', exact: true }).click();
    let dictationDialog = dictationPage.getByRole('dialog', {
      name: 'Dictate a direction',
      exact: true
    });
    await dictationDialog.getByText('Reviewed transcriber', { exact: true }).waitFor();
    assert.equal(
      await dictationPage.evaluate(() => window.dictationFixture.requests),
      0,
      'Preflight must precede microphone permission'
    );
    const recordButton = dictationDialog.getByRole('button', {
      name: 'Start recording',
      exact: true
    });
    assert.equal(
      await recordButton.isEnabled(),
      false,
      'This retained route requires consent and an explicit limit'
    );
    await dictationDialog.getByRole('spinbutton').fill('0.04');
    assert.equal(
      await recordButton.isEnabled(),
      false,
      'A cost limit does not grant retention consent'
    );
    await dictationDialog.getByRole('checkbox').check();
    await recordButton.click();
    await dictationPage.getByRole('button', { name: 'Stop dictation', exact: true }).click();
    const dictatedBody = dictationPage.getByRole('textbox', {
      name: 'Add direction to this work',
      exact: true
    });
    await dictationPage.waitForFunction(() =>
      document
        .querySelector('.intent-editor textarea')
        ?.value.includes('Keep the controls easy to reach.')
    );
    assert((await dictatedBody.inputValue()).includes('Keep the controls easy to reach.'));
    assert.equal(transcriptions.length, 1);
    assert.deepEqual(transcriptions[0], {
      data: Buffer.from('fixture audio').toString('base64'),
      format: 'webm',
      expectedRouteId: 'dictation-route',
      expectedModelId: 'dictation-model',
      expectedRouteProof: 'reviewed-route-proof',
      privacyRoute: 'external',
      externalConsent: true,
      maxCostUsd: 0.04
    });
    assert.equal(
      await dictationPage.evaluate(() => window.dictationFixture.stops),
      1,
      'A completed recording must release its microphone'
    );
    await dictationPage.evaluate(() => {
      window.dictationFixture.deferred = true;
    });
    await dictationPage.getByRole('button', { name: 'Dictate direction', exact: true }).click();
    dictationDialog = dictationPage.getByRole('dialog', {
      name: 'Dictate a direction',
      exact: true
    });
    await dictationDialog.getByRole('spinbutton').fill('0.04');
    await dictationDialog.getByRole('checkbox').check();
    await dictationDialog.getByRole('button', { name: 'Start recording', exact: true }).click();
    await dictationPage.getByRole('button', { name: 'Cancel dictation', exact: true }).click();
    await dictationPage.evaluate(() => window.dictationFixture.release());
    await dictationPage.waitForFunction(() => window.dictationFixture.stops === 2);
    assert.equal(
      transcriptions.length,
      1,
      'Cancelled late microphone permission must not submit audio'
    );
    dictationOptions.usdPerMinute = 0.006;
    dictationOptions.reservationUsd = null;
    dictationOptions.requiresMaxCostUsd = false;
    await dictationPage.getByRole('button', { name: 'Dictate direction', exact: true }).click();
    dictationDialog = dictationPage.getByRole('dialog', {
      name: 'Dictate a direction',
      exact: true
    });
    await dictationDialog.getByText('Reviewed transcriber', { exact: true }).waitFor();
    const durationQuote = await dictationDialog.textContent();
    assert.match(durationQuote, /per minute is held before submission/);
    assert.match(durationQuote, /provider receipt determines the final charge/);
    assert.equal(await dictationPage.evaluate(() => window.dictationFixture.requests), 2);
    await dictationPage.close();
    const approvalPage = await context.newPage();
    approvalPage.on('pageerror', (error) => errors.push(error.message));
    await approvalPage.setViewportSize({ width: 390, height: 844 });
    const showApproval = async (index, expired = false, samePage = false) => {
      approvals = [
        {
          id: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          taskId: task.id,
          status: 'pending',
          action: 'Run a command',
          sideEffect: 'workspace',
          origin: null,
          createdAt: time,
          expiresAt: new Date(Date.now() + (expired ? -60000 : 600000)).toISOString(),
          preview: {
            tool: 'shell',
            command: 'python3 check.py',
            reason: `Check the result. ${index}`
          }
        }
      ];
      if (samePage) {
        await approvalPage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      } else
        await approvalPage.goto(`${origin}/?task=${task.id}`, { waitUntil: 'domcontentloaded' });
      await approvalPage
        .locator('.decision-card')
        .getByText(`Check the result. ${index}`, { exact: true })
        .waitFor();
      return approvals[0].id;
    };
    await showApproval(90);
    const card = approvalPage.locator('.decision-card');
    await card.getByText('Add a reason for denying', { exact: true }).click();
    const note = card.getByRole('textbox', { name: 'Reason for denying (optional)', exact: true });
    await note.fill('This belongs only to the first request.');
    const denialId = await showApproval(1, false, true);
    assert.equal(
      await note.isVisible(),
      false,
      'Replacing a mounted decision must reset its disclosure'
    );
    await card.getByText('Add a reason for denying', { exact: true }).click();
    assert.equal(
      await note.inputValue(),
      '',
      'A new decision must never inherit another decision’s reason'
    );
    await note.focus();
    await approvalPage.keyboard.insertText('n'.repeat(610));
    assert.equal((await note.inputValue()).length, 600, 'The reason must be bounded while typing');
    const reason = 'Keep the output in the task folder.\nThen check the saved file.';
    await note.fill(reason);
    for (const theme of ['dark', 'light']) {
      await approvalPage.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const colors = await card.evaluate((element) => {
        const styles = getComputedStyle(element);
        const luminance = (color) => {
          const channels = color
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const component = value / 255;
              return component <= 0.04045
                ? component / 12.92
                : ((component + 0.055) / 1.055) ** 2.4;
            });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const background = luminance(styles.backgroundColor);
        const foreground = luminance(styles.color);
        return {
          background,
          contrast:
            (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
          overflow: element.scrollWidth > element.clientWidth + 1
        };
      });
      assert(colors.contrast >= 4.5, 'Approval text must remain readable in each theme');
      if (theme === 'dark')
        assert(colors.background < 0.1, 'Dark approval cards must use a dark surface');
      assert.equal(colors.overflow, false, 'An expanded denial reason must fit a phone');
      assert.equal(
        await approvalPage.evaluate(() => document.documentElement.scrollWidth),
        390,
        'The approval must not widen the page'
      );
      await card.getByRole('button', { name: 'Deny', exact: true }).scrollIntoViewIfNeeded();
      const actionsFit = await card.locator('.decision-actions').evaluate((element) => {
        const scroll = document.querySelector('.garden-task-scroll').getBoundingClientRect();
        const buttons = [...element.querySelectorAll('button')];
        return (
          buttons.length === 2 &&
          buttons.every((button) => {
            const box = button.getBoundingClientRect();
            return (
              box.left >= 0 &&
              box.right <= innerWidth &&
              box.top >= scroll.top &&
              box.bottom <= scroll.bottom
            );
          })
        );
      });
      assert(actionsFit, 'Approval actions must remain visible in the conversation scroll area');
      await card.screenshot({ path: resolve(report, `approval-reason-${theme}-phone.png`) });
    }
    approvalFailures = [
      { status: 503, code: 'temporarily_unavailable', message: 'Please retry this decision.' }
    ];
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    await card.getByRole('alert').filter({ hasText: 'Please retry this decision.' }).waitFor();
    assert.equal(await note.inputValue(), reason, 'A failed submission must retain the reason');
    approvalFailures = [{ status: 403, code: 'step_up_required', message: 'Authenticate again.' }];
    nativeStepUp = undefined;
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    await card.waitFor({ state: 'hidden' });
    assert.deepEqual(
      nativeStepUp,
      {},
      'An authentication refusal must actually run step-up before retrying'
    );
    assert.deepEqual(
      approvalRequests,
      Array.from({ length: 3 }, () => ({ id: denialId, action: 'deny', body: { note: reason } })),
      'Manual and authentication retries must preserve the exact denial reason'
    );
    const approveId = await showApproval(2);
    await card.getByText('Add a reason for denying', { exact: true }).click();
    await note.fill('This reason must never be sent with an approval.');
    await card.getByRole('button', { name: 'Approve once', exact: true }).click();
    await card.waitFor({ state: 'hidden' });
    assert.deepEqual(approvalRequests.at(-1), { id: approveId, action: 'approve', body: {} });
    const plainDenyId = await showApproval(3);
    await card.getByText('Add a reason for denying', { exact: true }).click();
    await note.fill('   ');
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    await card.waitFor({ state: 'hidden' });
    assert.deepEqual(
      approvalRequests.at(-1),
      { id: plainDenyId, action: 'deny', body: {} },
      'A blank reason must preserve plain denial'
    );
    await showApproval(4, true);
    await card.getByText('Add a reason for denying', { exact: true }).click();
    assert.equal(await note.isEnabled(), false);
    assert.equal(await card.getByRole('button', { name: 'Deny', exact: true }).isEnabled(), false);
    assert.equal(
      await card.getByRole('button', { name: 'Expired', exact: true }).isEnabled(),
      false
    );
    assert.equal(approvalRequests.length, 5, 'Expired decisions must not submit');
    const longCommand = "python3 - <<'PY'\n" + 'print("download fixture")\n'.repeat(150) + 'PY';
    approvals = [
      {
        ...approvals[0],
        id: 'a0000000-0000-4000-8000-000000000091',
        action: 'Allow this command to unpkg.com',
        origin: 'workspace file pocket-watch/shot-exploded.png',
        sideEffect: 'external_reversible',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        preview: {
          tool: 'shell',
          securityMode: 'autonomous',
          taskGrant: {
            description: 'Network commands · using python3 · referencing https://unpkg.com'
          },
          addresses: ['unpkg.com'],
          preview: 'This turn has read untrusted content.\n\nRun ' + longCommand,
          arguments: { executable: 'bash', args: ['-lc', longCommand] }
        }
      }
    ];
    await approvalPage.goto(`${origin}/?task=${task.id}`);
    await card
      .getByRole('heading', { name: 'Allow this command to unpkg.com', exact: true })
      .waitFor();
    for (const width of [320, 1440]) {
      await approvalPage.setViewportSize({ width, height: 1000 });
      await card
        .getByRole('button', { name: 'Approve once', exact: true })
        .waitFor({ state: 'visible' });
      assert.equal(await card.locator('.decision-detail').getAttribute('open'), null);
      const visible = await card
        .locator(':scope > p, :scope > h3, :scope > .eyebrow, :scope > dl')
        .allTextContents()
        .then((parts) => parts.join('\n'));
      assert(visible.toLowerCase().includes('autonomous · needs approval'));
      assert(!visible.includes('This turn has'));
      assert(!visible.includes('python3'));
      assert(!visible.includes('shot-exploded.png'));
      assert.equal(await card.locator('.decision-detail pre').isVisible(), false);
      assert.equal(
        await card.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        false
      );
      assert.equal(
        await card.getByRole('button', { name: 'Allow for this run', exact: true }).isEnabled(),
        true
      );
      assert(
        (await card.locator('.decision-permission').innerText()).includes('https://unpkg.com')
      );
      await card.locator('.decision-actions').scrollIntoViewIfNeeded();
      const approvalLayout = await card.locator('.decision-actions').evaluate((element) => ({
        area: document.querySelector('.garden-task-scroll').getBoundingClientRect().toJSON(),
        buttons: [...element.querySelectorAll('button')].map((button) =>
          button.getBoundingClientRect().toJSON()
        ),
        viewport: { width: innerWidth, height: innerHeight }
      }));
      assert(
        await card.locator('.decision-actions').evaluate((element) => {
          const area = document.querySelector('.garden-task-scroll').getBoundingClientRect();
          const buttons = [...element.querySelectorAll('button')];
          return (
            buttons.length === 3 &&
            buttons.every((button) => {
              const box = button.getBoundingClientRect();
              return (
                box.height > 0 &&
                area.height > 0 &&
                box.top >= area.top - 1 &&
                box.bottom <= area.bottom + 1 &&
                box.left >= 0 &&
                box.right <= innerWidth
              );
            })
          );
        }),
        `All three approval actions must be reachable inside the conversation: ${JSON.stringify(approvalLayout)}`
      );
      await card.screenshot({ path: resolve(report, `approval-compact-${width}.png`) });
      await card.getByText('Inspect full action', { exact: true }).click();
      const detail = await card.locator('.decision-detail').innerText();
      assert(detail.includes('python3'));
      assert(detail.includes('shot-exploded.png'));
      assert.equal((detail.match(/download fixture/g) ?? []).length, 300);
      assert.equal(
        await card.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        false
      );
      await card.getByText('Inspect full action', { exact: true }).click();
    }
    const scopeId = approvals[0].id;
    approvalFailures = [{ status: 403, code: 'step_up_required', message: 'Authenticate again.' }];
    await card.getByRole('button', { name: 'Allow for this run', exact: true }).click();
    await card.waitFor({ state: 'hidden' });
    assert.deepEqual(
      approvalRequests.slice(-2),
      [
        { id: scopeId, action: 'approve', body: { scope: 'run' } },
        { id: scopeId, action: 'approve', body: { scope: 'run' } }
      ],
      'The selected scope must survive authentication retry'
    );
    assert.equal(taskPermissions.length, 1);
    await approvalPage.reload();
    await approvalPage.getByRole('button', { name: 'Work options', exact: true }).click();
    const permissionPanel = approvalPage.getByRole('region', { name: 'Run permissions' });
    await permissionPanel.getByRole('button', { name: 'Revoke', exact: true }).waitFor();
    assert((await permissionPanel.innerText()).includes('https://unpkg.com'));
    await permissionPanel.getByRole('button', { name: 'Revoke', exact: true }).click();
    await permissionPanel
      .getByText('No reusable permissions in this run.', { exact: true })
      .waitFor();
    assert.equal(taskPermissions.length, 0);
    await approvalPage.reload();
    await approvalPage.getByRole('button', { name: 'Work options', exact: true }).click();
    await approvalPage.getByText('No reusable permissions in this run.', { exact: true }).waitFor();
    await approvalPage.close();
    approvals = [];
  }
  if (
    ![
      'memory',
      'desk',
      'drafts',
      'appearance',
      'workspace',
      'history',
      'files-jobs',
      'previews',
      'conversations',
      'journeys'
    ].includes(process.env.GARDEN_UI_FOCUS)
  ) {
    const revealDefaults = async () => {
      await modelsPage.getByRole('region', { name: 'Main agent', exact: true }).waitFor();
      for (const label of [
        'Advanced model choices',
        'Decision model preference',
        'Manage model connections'
      ]) {
        const details = modelsPage.locator('details').filter({
          has: modelsPage.locator('summary').filter({ hasText: new RegExp(`^${label}$`) })
        });
        if ((await details.count()) && (await details.getAttribute('open')) === null)
          await details.locator(':scope > summary').click();
      }
    };
    const modelsPage = await context.newPage();
    await modelsPage.goto(`${origin}/?task=${task.id}`);
    await modelsPage.locator('.garden-task-composer').waitFor();
    if (await modelsPage.getByRole('button', { name: /^Continue this conversation/ }).isVisible())
      await modelsPage.getByRole('button', { name: /^Continue this conversation/ }).click();
    await revealPromptSettings(modelsPage);
    await modelsPage
      .getByRole('button', { name: 'Model choices for this direction', exact: true })
      .click();
    const advanced = modelsPage.getByRole('dialog', { name: 'Model choices', exact: true });
    await advanced.getByText('Advanced model choices', { exact: true }).click();
    await advanced.getByRole('region', { name: 'Coding agents', exact: true }).waitFor();
    assert.equal(await advanced.locator('.model-choice-card').count(), 10);
    const pick = async (surface, label, modelId) => {
      const advancedOptions = surface.locator('details.advanced-model-choices');
      if (
        label !== 'Main agent' &&
        (await advancedOptions.count()) &&
        (await advancedOptions.getAttribute('open')) === null
      )
        await advancedOptions.locator('summary').click();
      await surface.getByRole('button', { name: new RegExp(`^${label}:`) }).click();
      const search = modelsPage.getByRole('combobox', { name: 'Search models', exact: true });
      await search.fill(modelId);
      await search.press('Enter');
    };
    await pick(advanced, 'Coding agents', 'openrouter/beta/model-79');
    failModelSave = true;
    await advanced.getByRole('button', { name: 'Save conversation choices', exact: true }).click();
    await advanced
      .getByRole('alert')
      .filter({ hasText: 'Model storage is temporarily unavailable' })
      .waitFor();
    assert.equal(projectChoices.coding, undefined, 'A failed save must not change saved choices');
    assert.match(
      await advanced.getByRole('region', { name: 'Coding agents', exact: true }).textContent(),
      /Research model 79/
    );
    await advanced.getByRole('button', { name: 'Save conversation choices', exact: true }).click();
    await advanced.getByText('Conversation model choices saved', { exact: true }).waitFor();
    assert.equal(projectChoices.coding.modelId, 'openrouter/beta/model-79');
    await modelsPage.screenshot({ path: resolve(report, 'models-project-desktop.png') });
    await advanced.getByRole('button', { name: 'Close Model choices', exact: true }).click();
    await modelsPage.reload();
    await modelsPage.getByRole('button', { name: 'Work options', exact: true }).click();
    await modelsPage.getByRole('button', { name: 'Models', exact: true }).click();
    const projectModels = modelsPage.getByRole('dialog', {
      name: 'Conversation models',
      exact: true
    });
    await projectModels.getByText('Advanced model choices', { exact: true }).click();
    await projectModels
      .getByRole('button', { name: 'Coding agents: Research model 79', exact: true })
      .waitFor();
    await projectModels
      .getByRole('button', { name: 'Close Conversation models', exact: true })
      .click();

    if (await modelsPage.getByRole('button', { name: /^Continue this conversation/ }).isVisible())
      await modelsPage.getByRole('button', { name: /^Continue this conversation/ }).click();
    await revealPromptSettings(modelsPage);
    await modelsPage.getByRole('button', { name: /^Model for this direction:/ }).click();
    const modelSearch = modelsPage.getByRole('combobox', { name: 'Search models', exact: true });
    await modelsPage
      .getByRole('combobox', { name: 'Filter models by provider', exact: true })
      .selectOption({ label: 'Beta' });
    // The picker groups by who made a model; filtering to one maker leaves only its models.
    assert((await modelsPage.getByRole('option').filter({ hasText: 'beta/model-' }).count()) > 0);
    assert.equal(
      await modelsPage.getByRole('option').filter({ hasText: 'alpha/model-' }).count(),
      0
    );
    await modelSearch.fill('model-79');
    await modelsPage.screenshot({ path: resolve(report, 'model-browser-desktop.png') });
    await modelSearch.press('Enter');
    await modelsPage
      .getByRole('button', { name: 'Model for this direction: Research model 79', exact: true })
      .waitFor();
    assert(
      await modelsPage
        .getByRole('button', { name: 'Model for this direction: Research model 79', exact: true })
        .evaluate((element) => element === document.activeElement),
      'Model selection must restore keyboard focus'
    );
    await revealPromptSettings(modelsPage);
    await modelsPage.getByRole('button', { name: /^Model for this direction:/ }).click();
    await modelsPage.getByRole('option', { name: 'Fixture reasoning model', exact: true }).click();
    await modelsPage
      .getByRole('button', {
        name: 'Model for this direction: Fixture reasoning model',
        exact: true
      })
      .waitFor();

    await openNewProject(modelsPage);
    const newWork = modelsPage.getByRole('dialog', { name: 'Begin something new', exact: true });
    const openPromptModels = async () => {
      await newWork.getByRole('button', { name: /^Model for this direction:/ }).click();
      await modelsPage.getByRole('button', { name: 'Model roles', exact: true }).click();
      await advanced.getByRole('button', { name: /^Main agent:/ }).waitFor();
    };
    await openPromptModels();
    const openDialogs = await modelsPage.locator('dialog[open]').count();
    assert(openDialogs > 0);
    await advanced.getByRole('button', { name: /^Coding agents:/ }).click();
    assert.equal(
      await modelsPage.locator('dialog[open]').count(),
      openDialogs,
      'Editing a role must stay in the same dialog'
    );
    await advanced.getByRole('combobox', { name: 'Search models', exact: true }).press('Escape');
    assert(
      await advanced
        .getByRole('button', { name: /^Coding agents:/ })
        .evaluate((element) => element === document.activeElement),
      'Returning from the model list must restore focus to its role'
    );
    await advanced.getByRole('button', { name: /^Coding agents:/ }).click();
    await advanced.getByRole('option', { name: /^Automatic\s/ }).click();
    await advanced.getByRole('combobox', { name: 'Coding agents preference' }).selectOption('fast');
    await pick(advanced, 'Main agent', 'openrouter/alpha/model-78');
    await pick(advanced, 'Research specialists', 'openrouter/beta/model-79');
    assert.equal(await advanced.getByRole('button', { name: /^Decisions:/ }).count(), 0);
    await advanced.getByText('Inactive roles', { exact: true }).click();
    await advanced
      .getByText('Decision models are not in use. All features work without one.', {
        exact: true
      })
      .waitFor();
    await advanced.getByText('Inactive roles', { exact: true }).click();
    await advanced.locator('.prompt-model-roles').evaluate((element) => {
      element.scrollTop = 0;
    });
    await modelsPage.screenshot({ path: resolve(report, 'prompt-model-roles-desktop.png') });
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 568 }
    ]) {
      await modelsPage.setViewportSize(viewport);
      await modelsPage.waitForFunction(() => {
        const dialog = document.querySelector('.prompt-model-dialog');
        return dialog && dialog.getBoundingClientRect().bottom <= innerHeight;
      });
      const bounds = await advanced.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const footer = element.querySelector('.prompt-model-footer').getBoundingClientRect();
        return {
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          bottom: bounds.bottom,
          viewportHeight: window.innerHeight,
          footerBottom: footer.bottom
        };
      });
      assert(
        bounds.scrollWidth <= bounds.clientWidth + 1 &&
          bounds.bottom <= bounds.viewportHeight &&
          bounds.footerBottom <= bounds.bottom,
        `Model choices must fit the viewport and keep their footer visible: ${JSON.stringify(bounds)}`
      );
      await modelsPage.screenshot({
        path: resolve(report, `prompt-model-roles-${viewport.width}.png`)
      });
    }
    await advanced.getByRole('button', { name: /^Main agent:/ }).click();
    await advanced.getByRole('combobox', { name: 'Search models', exact: true }).waitFor();
    await modelsPage.screenshot({ path: resolve(report, 'prompt-model-picker-phone.png') });
    await advanced.getByRole('button', { name: 'Back to model roles', exact: true }).click();
    await modelsPage.setViewportSize({ width: 1440, height: 1000 });
    await advanced.getByRole('button', { name: 'Close Model choices', exact: true }).click();
    await newWork.getByRole('status', { name: 'Draft synced', exact: true }).waitFor();
    assert.equal(modelDrafts.get(`new:${workspace.id}`).body, '');
    assert.equal(
      modelDrafts.get(`new:${workspace.id}`).controls.modelChoices.specialist.modelId,
      'openrouter/beta/model-79'
    );
    await modelsPage.reload();
    await openNewProject(modelsPage);
    await openPromptModels();
    assert.equal(
      await advanced.getByRole('combobox', { name: 'Coding agents preference' }).inputValue(),
      'fast',
      'Automatic routing preferences must persist with the new prompt'
    );
    await advanced.getByRole('button', { name: /^Coding agents:/ }).click();
    await advanced.getByRole('option', { name: /^Use Settings default\s/ }).click();
    assert.equal(
      await advanced.getByRole('combobox', { name: 'Coding agents preference' }).count(),
      0
    );
    await advanced.getByRole('button', { name: 'Done', exact: true }).click();
    await newWork
      .getByRole('button', { name: 'Model for this direction: Research model 78', exact: true })
      .waitFor();
    await newWork
      .getByLabel('Describe what you want to do')
      .fill('A longer prompt should remain fully readable as it wraps across lines. '.repeat(40));
    await modelsPage.setViewportSize({ width: 390, height: 844 });
    assert(
      await newWork.evaluate((element) => {
        const input = element.querySelector('textarea').getBoundingClientRect();
        const toolbar = element.querySelector('.intent-toolbar').getBoundingClientRect();
        return input.bottom <= toolbar.top && element.scrollWidth <= element.clientWidth;
      }),
      'A long prompt must keep the send button outside the input on a phone'
    );
    await modelsPage.screenshot({ path: resolve(report, 'prompt-long-phone.png') });
    await modelsPage.setViewportSize({ width: 1440, height: 1000 });
    await newWork
      .getByLabel('Describe what you want to do')
      .fill('Use my saved project model choices.');
    await newWork.getByRole('button', { name: 'Start', exact: true }).click();
    await newWork.waitFor({ state: 'detached' });
    assert.equal(createdModelRequest.modelChoices.main.modelId, 'openrouter/alpha/model-78');
    assert.equal(createdModelRequest.modelChoices.specialist.modelId, 'openrouter/beta/model-79');
    assert.equal(createdModelRequest.modelChoices.decisions, undefined);
    assert.equal(
      modelDrafts.get(`new:${workspace.id}`).body,
      '',
      'Successful delivery must clear the saved draft while retaining its revision'
    );

    await modelsPage.getByRole('button', { name: 'garden · Home', exact: true }).waitFor();
    if (
      (await modelsPage
        .getByRole('button', { name: 'Settings', exact: true })
        .getAttribute('aria-expanded')) !== 'true'
    )
      await modelsPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await modelsPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Models', exact: true })
      .click();
    await revealDefaults();
    await modelsPage.getByRole('heading', { name: 'Model defaults', exact: true }).waitFor();
    await pick(modelsPage, 'Condensing long work', 'openrouter/alpha/model-78');
    // Connected providers are rows; a row opens that connection's settings.
    await modelsPage.getByRole('button', { name: 'Compatible endpoint', exact: true }).click();
    await modelsPage.getByLabel('Endpoint URL', { exact: true }).waitFor();
    const accessibility = await context.newCDPSession(modelsPage);
    const tree = await accessibility.send('Accessibility.getFullAXTree');
    assert(tree.nodes.length > 0, 'The browser must expose an accessibility tree');
    const restriction = tree.nodes.filter(
      (node) => node.role?.value === 'textbox' && node.name?.value === 'Restrict to model ID'
    );
    assert.equal(
      restriction.length,
      1,
      'A field must have its concise visible label as its accessible name'
    );
    assert.equal(
      restriction[0].description?.value,
      'Optional. Leave empty to discover every model this endpoint offers.',
      'Supporting text must be exposed as a description separately from the field name'
    );
    await accessibility.detach();
    await modelsPage.locator('.field > label', { hasText: 'Restrict to model ID' }).click();
    assert(
      await modelsPage
        .getByRole('textbox', { name: 'Restrict to model ID', exact: true })
        .evaluate((element) => element === document.activeElement),
      'Activating a visible field label must focus its control'
    );
    assert.equal(
      await modelsPage.getByLabel('Endpoint URL', { exact: true }).inputValue(),
      'https://compatible.example/v1'
    );
    assert.equal(await modelsPage.getByLabel(/^Restrict to model ID/).inputValue(), 'shared/model');
    assert.equal(
      await modelsPage.getByLabel('Context window in tokens', { exact: true }).inputValue(),
      '98304'
    );
    assert.equal(await modelsPage.getByLabel(/^API key/).inputValue(), '');
    // Across to another connection and back, which opens each one's own form in turn.
    await modelsPage.getByRole('button', { name: 'Ollama Cloud', exact: true }).click();
    assert.equal(await modelsPage.getByLabel('Endpoint URL', { exact: true }).count(), 0);
    await modelsPage.getByRole('button', { name: 'Compatible endpoint', exact: true }).click();
    await modelsPage.getByLabel(/^Restrict to model ID/).fill('');
    await modelsPage.getByLabel('Context window in tokens', { exact: true }).fill('65536');
    await modelsPage.getByRole('button', { name: 'Verify and save', exact: true }).click();
    await modelsPage
      .getByText('Connection and routing verified and saved', { exact: true })
      .waitFor();
    assert.equal(providerWrites.length, 1);
    assert.equal(providerWrites[0].provider, 'openai-compatible');
    assert.equal(providerWrites[0].contextTokens, 65536);
    assert.equal(providerWrites[0].apiKey, undefined);
    assert.equal(providerWrites[0].modelId, undefined);
    await modelsPage
      .getByRole('button', { name: 'Condensing long work: Research model 78', exact: true })
      .waitFor();
    assert.notEqual(
      await modelsPage.locator('details.advanced-model-choices').getAttribute('open'),
      null,
      'Saving a connection preserves open settings and unsaved model choices'
    );

    await pick(modelsPage, 'Condensing long work', 'openrouter/alpha/model-78');
    await pick(modelsPage, 'Naming a conversation', 'openrouter/beta/model-79');
    assert.equal(await modelsPage.getByRole('button', { name: /^Decisions:/ }).count(), 0);
    failModelSave = true;
    await modelsPage.getByRole('button', { name: 'Save model defaults', exact: true }).click();
    await modelsPage
      .getByRole('alert')
      .filter({ hasText: 'Model defaults could not be saved' })
      .waitFor();
    assert.equal(
      defaultChoices.title,
      undefined,
      'A failed default save must retain the previous server preferences'
    );
    await modelsPage.getByRole('button', { name: 'Save model defaults', exact: true }).click();
    await modelsPage.getByText('Model defaults saved', { exact: true }).waitFor();
    assert.equal(defaultChoices.decisions.modelId, 'openrouter/typesafe/jev-test');
    await revealDefaults();
    const decisionToggle = modelsPage.getByRole('checkbox', { name: 'Allow decision models' });
    assert.equal(await decisionToggle.isChecked(), true);
    failDecisionSave = true;
    await decisionToggle.click();
    await modelsPage
      .getByRole('alert')
      .filter({ hasText: 'Decision preference could not be saved' })
      .waitFor();
    assert.equal(await decisionToggle.isChecked(), true);
    assert.equal(decisionModelsEnabled, true);
    await decisionToggle.click();
    await modelsPage.getByText('Decision models disabled', { exact: true }).waitFor();
    await modelsPage
      .getByText('Decision models are turned off in Settings → Models.', { exact: true })
      .waitFor();
    assert.equal(decisionModelsEnabled, false);
    assert.equal(await modelsPage.getByRole('button', { name: /^Decisions:/ }).count(), 0);
    await modelsPage.reload();
    await modelsPage.getByRole('button', { name: 'garden · Home', exact: true }).waitFor();
    if (
      (await modelsPage
        .getByRole('button', { name: 'Settings', exact: true })
        .getAttribute('aria-expanded')) !== 'true'
    )
      await modelsPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await modelsPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Models', exact: true })
      .click();
    await revealDefaults();
    assert.equal(await decisionToggle.isChecked(), false);
    await decisionToggle.click();
    await modelsPage.getByText('Decision models allowed', { exact: true }).waitFor();
    await modelsPage
      .getByText('Decision models are not in use. All features work without one.', {
        exact: true
      })
      .waitFor();
    assert.equal(await modelsPage.getByRole('button', { name: /^Decisions:/ }).count(), 0);
    assert.equal(defaultChoices.decisions.modelId, 'openrouter/typesafe/jev-test');
    await pick(modelsPage, 'image model', 'fixture/image-studio');
    await modelsPage.getByRole('button', { name: 'Save generation choices', exact: true }).click();
    await modelsPage.getByText('Generation choices saved', { exact: true }).waitFor();
    assert.equal(generationChoices.image.modelId, 'fixture/image-studio');
    await modelsPage.reload();
    await modelsPage.getByRole('button', { name: 'garden · Home', exact: true }).waitFor();
    if (
      (await modelsPage
        .getByRole('button', { name: 'Settings', exact: true })
        .getAttribute('aria-expanded')) !== 'true'
    )
      await modelsPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await modelsPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Models', exact: true })
      .click();
    await revealDefaults();
    await modelsPage
      .getByRole('button', { name: 'Naming a conversation: Research model 79', exact: true })
      .waitFor();
    await modelsPage
      .getByRole('button', { name: 'Condensing long work: Research model 78', exact: true })
      .waitFor();
    await modelsPage
      .getByRole('button', { name: 'image model: Image Studio', exact: true })
      .waitFor();
    // Settings open with every connection closed; the saved endpoint is one row away.
    assert.equal(await modelsPage.getByLabel('Endpoint URL', { exact: true }).count(), 0);
    await modelsPage.getByRole('button', { name: 'Compatible endpoint', exact: true }).click();
    assert.equal(
      await modelsPage.getByLabel('Endpoint URL', { exact: true }).inputValue(),
      'https://compatible.example/v1'
    );
    assert.equal(
      await modelsPage.getByLabel('Context window in tokens', { exact: true }).inputValue(),
      '65536'
    );
    assert.equal(await modelsPage.getByLabel(/^Restrict to model ID/).inputValue(), '');
    await modelsPage.screenshot({ path: resolve(report, 'model-defaults-desktop.png') });
    await modelsPage.setViewportSize({ width: 390, height: 844 });
    await modelsPage
      .getByRole('button', { name: 'Naming a conversation: Research model 79', exact: true })
      .click();
    await modelsPage.getByRole('combobox', { name: 'Search models', exact: true }).fill('retired');
    assert.equal(
      await modelsPage
        .getByRole('option', { name: /Retired research model/ })
        .getAttribute('aria-disabled'),
      'true'
    );
    await modelsPage.getByRole('combobox', { name: 'Search models', exact: true }).press('Enter');
    assert.equal(defaultChoices.title.modelId, 'openrouter/beta/model-79');
    await modelsPage.screenshot({ path: resolve(report, 'model-browser-phone.png') });
    assert.equal(await modelsPage.evaluate(() => document.documentElement.scrollWidth), 390);
    await modelsPage.getByRole('combobox', { name: 'Search models', exact: true }).press('Escape');
    await modelsPage
      .getByRole('dialog', { name: 'Choose naming a conversation', exact: true })
      .waitFor({ state: 'detached' });
    await modelsPage.getByLabel('Endpoint URL', { exact: true }).scrollIntoViewIfNeeded();
    await modelsPage.screenshot({ path: resolve(report, 'model-connections-phone.png') });
    assert.equal(await modelsPage.evaluate(() => document.documentElement.scrollWidth), 390);
    await modelsPage.getByRole('button', { name: 'Remove saved connection', exact: true }).click();
    const removeConnection = modelsPage.getByRole('dialog', {
      name: 'Remove saved connection',
      exact: true
    });
    await removeConnection
      .getByRole('button', { name: 'Remove saved connection', exact: true })
      .click();
    await removeConnection.waitFor({ state: 'detached' });
    assert.deepEqual([...providerConnections.keys()], ['openrouter', 'ollama-cloud']);

    const namedConnections = [];
    for (const [label, host] of [
      ['Work models', 'work-models.example'],
      ['Research models', 'research-models.example']
    ]) {
      await modelsPage.getByRole('button', { name: 'Add a provider', exact: true }).click();
      await modelsPage.getByRole('button', { name: 'Other endpoint', exact: true }).click();
      await modelsPage.getByLabel('Connection name', { exact: true }).fill(label);
      await modelsPage.getByLabel('Endpoint URL', { exact: true }).fill(`https://${host}/v1`);
      await modelsPage.getByLabel('API key', { exact: true }).fill('synthetic-account-key');
      await modelsPage.getByRole('button', { name: 'Verify and save', exact: true }).click();
      await modelsPage.getByRole('button', { name: label, exact: true }).waitFor();
      const saved = providerWrites.at(-1);
      assert.match(saved.connectionId, /^openai-compatible:[0-9a-f-]{36}$/);
      assert.equal(saved.provider, 'openai-compatible');
      assert.equal(saved.label, label);
      const model = {
        ...modelCatalog[0],
        id: `custom/${saved.connectionId}/shared-model`,
        providerModelId: 'shared-model',
        provider: 'custom',
        connectionId: saved.connectionId,
        connectionLabel: label,
        displayName: 'Shared endpoint model'
      };
      modelCatalog.push(model);
      namedConnections.push({ connectionId: saved.connectionId, label, host, model });
    }
    assert.notEqual(namedConnections[0].connectionId, namedConnections[1].connectionId);
    await modelsPage.reload();
    await modelsPage.getByRole('button', { name: 'garden · Home', exact: true }).waitFor();
    if (
      (await modelsPage
        .getByRole('button', { name: 'Settings', exact: true })
        .getAttribute('aria-expanded')) !== 'true'
    )
      await modelsPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await modelsPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Models', exact: true })
      .click();
    await revealDefaults();
    await modelsPage.getByRole('button', { name: 'Work models', exact: true }).click();
    assert.equal(
      await modelsPage.getByLabel('Endpoint URL', { exact: true }).inputValue(),
      'https://work-models.example/v1'
    );
    assert.equal(await modelsPage.getByLabel('API key', { exact: true }).inputValue(), '');
    await pick(modelsPage, 'Condensing long work', namedConnections[0].model.id);
    await modelsPage.getByRole('button', { name: 'Save model defaults', exact: true }).click();
    await modelsPage.getByText('Model defaults saved', { exact: true }).waitFor();
    assert.equal(defaultChoices.decisions.modelId, 'openrouter/typesafe/jev-test');
    await modelsPage.reload();
    await modelsPage.getByRole('button', { name: 'garden · Home', exact: true }).waitFor();
    if (
      (await modelsPage
        .getByRole('button', { name: 'Settings', exact: true })
        .getAttribute('aria-expanded')) !== 'true'
    )
      await modelsPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await modelsPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Models', exact: true })
      .click();
    await revealDefaults();
    await modelsPage
      .getByRole('button', {
        name: 'Condensing long work: Shared endpoint model · Work models',
        exact: true
      })
      .waitFor();
    assert.equal(defaultChoices.summarise.modelId, namedConnections[0].model.id);
    await modelsPage.getByRole('button', { name: 'Work models', exact: true }).click();
    await modelsPage.getByLabel('Endpoint URL', { exact: true }).scrollIntoViewIfNeeded();
    await modelsPage.screenshot({ path: resolve(report, 'named-connections-phone.png') });
    assert.equal(await modelsPage.evaluate(() => document.documentElement.scrollWidth), 390);
    await pick(modelsPage, 'Condensing long work', 'openrouter/alpha/model-78');
    await modelsPage.getByRole('button', { name: 'Save model defaults', exact: true }).click();
    await modelsPage.getByText('Model defaults saved', { exact: true }).waitFor();
    assert.equal(defaultChoices.decisions.modelId, 'openrouter/typesafe/jev-test');
    for (const connection of namedConnections) {
      await modelsPage.getByRole('button', { name: connection.label, exact: true }).click();
      await modelsPage
        .getByRole('button', { name: 'Remove saved connection', exact: true })
        .click();
      const dialog = modelsPage.getByRole('dialog', {
        name: 'Remove saved connection',
        exact: true
      });
      await dialog.getByRole('button', { name: 'Remove saved connection', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(providerConnections.has(connection.connectionId), false);
      const index = modelCatalog.findIndex((model) => model.id === connection.model.id);
      assert(index >= 0);
      modelCatalog.splice(index, 1);
    }
    assert.deepEqual([...providerConnections.keys()], ['openrouter', 'ollama-cloud']);

    await modelsPage.close();
  }

  if (
    ![
      'memory',
      'desk',
      'appearance',
      'workspace',
      'history',
      'files-jobs',
      'previews',
      'conversations',
      'models',
      'journeys'
    ].includes(process.env.GARDEN_UI_FOCUS)
  ) {
    let draftPage = await context.newPage();
    const openDraft = async () => {
      await draftPage.goto(`${origin}/?task=${task.id}`);
      await openNewProject(draftPage);
      await draftPage.getByRole('dialog', { name: 'Begin something new', exact: true }).waitFor();
    };
    let draftDialog = draftPage.getByRole('dialog', { name: 'Begin something new', exact: true });
    let draftInput = draftDialog.getByLabel('Describe what you want to do');
    const draftKey = `new:${workspace.id}`;
    const beforeOffline = taskCreations;
    await openDraft();
    draftOffline = true;
    await draftInput.fill('PRIVATE OFFLINE DRAFT — retain this across a closed tab.');
    await draftDialog
      .getByRole('status', { name: 'Saved on this device · waiting to sync', exact: true })
      .waitFor();
    const ciphertext = await draftPage.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('garden-private-drafts');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve, reject) => {
        const request = db.transaction('drafts').objectStore('drafts').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return JSON.stringify(rows);
    });
    assert(ciphertext.includes('ciphertext'), 'The offline draft must reach IndexedDB');
    assert(
      !ciphertext.includes('PRIVATE OFFLINE DRAFT'),
      'Device storage must not contain prompt plaintext'
    );
    await draftPage.close();
    draftPage = await context.newPage();
    draftDialog = draftPage.getByRole('dialog', { name: 'Begin something new', exact: true });
    draftInput = draftDialog.getByLabel('Describe what you want to do');
    await openDraft();
    await draftInput.waitFor();
    assert.equal(
      await draftInput.inputValue(),
      'PRIVATE OFFLINE DRAFT — retain this across a closed tab.'
    );
    assert.equal(taskCreations, beforeOffline, 'Reload must not submit a recovered draft');
    draftOffline = false;
    await draftPage.evaluate(() => window.dispatchEvent(new Event('online')));
    await draftDialog.getByRole('status', { name: 'Draft synced', exact: true }).waitFor();
    assert.equal(taskCreations, beforeOffline, 'Reconnection must synchronize drafts only');

    const draftCommit = new Promise((resolve) => {
      lostDraftAcknowledgement = resolve;
    });
    loseDraftAcknowledgement = true;
    await draftInput.fill('Save committed, acknowledgement lost.');
    await draftDialog
      .getByRole('status', { name: 'Saved on this device · waiting to sync', exact: true })
      .waitFor();
    // Wait for the request to commit, not merely for the immediate local persistence status.
    await draftCommit;
    const committedRevision = draftRevisions.get(draftKey);
    assert.equal(modelDrafts.get(draftKey).body, 'Save committed, acknowledgement lost.');
    await draftPage.reload();
    await openNewProject(draftPage);
    await draftDialog.getByRole('status', { name: 'Draft synced', exact: true }).waitFor();
    assert.equal(await draftInput.inputValue(), 'Save committed, acknowledgement lost.');
    assert.equal(
      draftRevisions.get(draftKey),
      committedRevision,
      'An unanswered save must replay the same revision'
    );

    modelDrafts.set(draftKey, {
      ...modelDrafts.get(draftKey),
      body: 'A draft from another device.',
      revision: committedRevision + 1
    });
    draftRevisions.set(draftKey, committedRevision + 1);
    await draftInput.fill('My conflicting local edit.');
    await draftDialog
      .getByText('A newer draft exists on another device.', { exact: true })
      .waitFor();
    assert.equal(modelDrafts.get(draftKey).body, 'A draft from another device.');
    await draftDialog.getByRole('button', { name: 'Use other draft', exact: true }).click();
    await draftPage.waitForFunction(() =>
      [...document.querySelectorAll('textarea')].some(
        (element) => element.value === 'A draft from another device.'
      )
    );

    loseSendAcknowledgement = true;
    await draftInput.fill('Create this task exactly once.');
    await draftDialog.getByRole('button', { name: 'Start', exact: true }).click();
    await draftDialog.getByRole('button', { name: 'Retry send', exact: true }).waitFor();
    assert.equal(taskCreations, beforeOffline + 1);
    await draftPage.reload();
    await openNewProject(draftPage);
    await draftDialog.getByRole('button', { name: 'Retry send', exact: true }).waitFor();
    assert.equal(await draftInput.inputValue(), 'Create this task exactly once.');
    await draftDialog.getByRole('button', { name: 'Retry send', exact: true }).click();
    await draftDialog.waitFor({ state: 'detached' });
    assert.equal(
      taskCreations,
      beforeOffline + 1,
      'Recovered send must replay its receipt without creating another task'
    );
    await draftPage.close();
  }

  assert.deepEqual(errors, [], 'The browser must not report uncaught errors');
  console.log(
    process.env.GARDEN_UI_FOCUS === 'memory'
      ? 'Memory Library checks passed: search, scope, pagination, full reads and card scrolling.'
      : process.env.GARDEN_UI_FOCUS === 'history'
        ? 'Project history checks passed: scrolling, persistent collapse controls, response context and responsive layout.'
        : process.env.GARDEN_UI_FOCUS === 'previews'
          ? 'Preview restart, reload recovery, readiness, attention and retry checks passed.'
          : process.env.GARDEN_UI_FOCUS === 'desk'
            ? 'Desk browser checks passed.'
            : process.env.GARDEN_UI_FOCUS === 'conversations'
              ? 'Project conversations and checked updates passed.'
              : process.env.GARDEN_UI_FOCUS === 'workspace'
                ? 'Workspace navigation and human intervention checks passed.'
                : process.env.GARDEN_UI_FOCUS === 'appearance'
                  ? 'Appearance checks passed: inverse LCD palettes, text contrast, local fonts, responsive layouts, prompt disclosure and mode persistence.'
                  : process.env.GARDEN_UI_FOCUS === 'models'
                    ? 'Model and draft browser checks passed: prompt, conversation and settings persistence, responsive controls, connection handling and draft recovery.'
                    : process.env.GARDEN_UI_FOCUS === 'drafts'
                      ? 'Draft browser checks passed: encrypted IndexedDB, close and reopen, offline recovery without auto-send, lost save acknowledgement, conflict choice, and interrupted send receipt replay.'
                      : 'Browser checks passed: encrypted draft recovery, viewport layout, phone focus, effort drafts, playable links, downloads, state-preserving expansion, recorded evidence, mission review, media recovery, analysis sessions, device authorization, dictation consent, model selection persistence, and denial feedback with authentication retry.'
  );
} catch (error) {
  console.error(error);
  console.error(errors);
  for (const [index, page] of browser
    .contexts()
    .flatMap((context) => context.pages())
    .entries()) {
    if (page.isClosed()) continue;
    console.error(
      (
        await page
          .locator('body')
          .innerText({ timeout: 2000 })
          .catch(() => '(page unavailable)')
      ).slice(0, 8000)
    );
    await page
      .screenshot({ path: resolve(report, `failure-${index}.png`), timeout: 3000 })
      .catch(() => undefined);
  }
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await new Promise((done) => previewServer.close(done));
  if (ownedReport) await rm(report, { recursive: true, force: true });
}
