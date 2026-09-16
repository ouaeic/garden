/**
 * What the API promises the things around it.
 *
 * `packages/contracts` is the only written agreement between this server and every client that
 * talks to it, and until now nothing checked that the server actually produces those shapes - the
 * schemas were imported by the clients and never by the code that answers them, so a field renamed
 * here and a field read there could disagree indefinitely and nothing would fail.
 *
 * The other two suites are about the edges of the same agreement: an identifier that cannot name a
 * record, and the process shutting down while the worker inside it is still holding one.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { z } from 'zod';
import {
  AgentNotification,
  ApiError,
  ApiToken,
  Approval,
  Artifact,
  Connector,
  ConnectorAuditEvent,
  ModelRelease,
  Task,
  TaskEvent,
  TaskPage,
  TaskPlan,
  TaskRewindPreview,
  TaskSchedule,
  UsageSummary,
  Workspace,
  WorkspacePreview,
  WorkspaceSnapshot
} from '@athanor/contracts';
import { seedModels } from '@athanor/model-gateway';
import type { ApiConfig } from './config.js';
import { buildServer } from './server.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.unstubAllGlobals();
});

const MODEL_ID = 'openrouter/deepseek/deepseek-v4-flash';

/** A completion the agent can read: some prose, then a finish it is allowed to accept. */
const completionFrames = (): string =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Nothing to do.' } }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-finish',
                function: {
                  name: 'finish',
                  arguments: JSON.stringify({
                    summary: 'Nothing to do.',
                    verification: { status: 'not_applicable', evidence: [], remainingRisks: [] }
                  })
                }
              }
            ]
          }
        }
      ]
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ finish_reason: 'tool_calls', delta: {} }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, cost: 0.0001 }
    })}\n\n`,
    'data: [DONE]\n\n'
  ].join('');

/**
 * Enough of a provider and a runner to get through bootstrap.
 *
 * `holdModel` is how the shutdown test gets a turn that is genuinely in flight: the completion does
 * not come back until the test lets it, so `app.close()` is called while the worker is inside a
 * turn rather than between two of them.
 */
const stubUpstreams = (holdModel?: { reached: () => void; release: Promise<void> }): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' }
        });
      if (url.includes('workspace-manager.test')) {
        const path = new URL(url).pathname;
        if (path.endsWith('/project-inputs')) return json({ sources: [] });
        if (/^\/v1\/workspaces\/[0-9a-f-]{36}\/projects\/[0-9a-f-]{36}\/updates$/.test(path))
          return json({
            head: null,
            updates: [],
            revisions: [],
            nextCursor: null,
            observedAt: new Date().toISOString()
          });
        if (path.endsWith('/project-execution')) {
          if (init?.method !== 'POST' || typeof init.body !== 'string')
            throw Error('Expected a JSON project preparation request');
          const body = JSON.parse(init.body) as {
            taskId: string;
            workspaceId: string;
            kind: string;
            paths: string[];
          };
          expect(body).toEqual({
            taskId: expect.any(String) as unknown,
            workspaceId: expect.any(String) as unknown,
            kind: 'new',
            paths: ['workspace/AGENTS.md', 'workspace/ATHANOR.md', 'workspace/OPEN_CLOUD.md']
          });
          return json({
            status: 'ready',
            sourceWorkspaceId: path.split('/')[3],
            workspaceId: body.workspaceId,
            taskId: body.taskId,
            bytes: 0
          });
        }
        if (path.endsWith('/usage')) return json({ storageBytes: 2_048 });
        return json({ ok: true });
      }
      if (url.endsWith('/endpoints/zdr'))
        return json({
          data: seedModels().map((model) => ({ model_id: model.providerModelId, status: 0 }))
        });
      if (url.endsWith('/models'))
        return json({
          data: seedModels().map((model) => ({
            id: model.providerModelId,
            context_length: model.contextTokens,
            architecture: { input_modalities: model.modalities },
            supported_parameters: ['tools', 'reasoning']
          }))
        });
      if (url.includes('/benchmarks')) return json({ data: [] });
      if (url.endsWith('/chat/completions')) {
        if (!holdModel) return json({ error: { message: 'no provider' } }, 502);
        holdModel.reached();
        await holdModel.release;
        return new Response(completionFrames(), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        });
      }
      return json({ error: { message: `unhandled ${url}` } }, 502);
    })
  );
};

const configFor = (directory: string, overrides: Partial<ApiConfig> = {}): ApiConfig => ({
  DEPLOYMENT_MODE: 'development',
  MODEL_CATALOG_SCOPE: 'reviewed_open_weight',
  CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
  ATHANOR_STATE_PATH: directory,
  RELAY_STATE_DIR: join(directory, 'relay'),
  RELAY_LOCAL_HOST: '127.0.0.1',
  RELAY_LOCAL_PORT: 443,
  RELAY_LOCAL_HTTP_PORT: 80,
  RELAY_LOCAL_PREVIEW_PORT: 8443,
  REGISTRATION_BOOTSTRAP_TOKEN: 'contract-pairing-token-with-20-characters',
  REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
  PUBLIC_APP_URL: 'http://localhost:5173',
  PREVIEW_BASE_URL: 'http://preview.localhost:4400',
  API_HOST: '127.0.0.1',
  API_PORT: 4113,
  PREVIEW_GATEWAY_HOST: '127.0.0.1',
  PREVIEW_GATEWAY_PORT: 4413,
  DATABASE_DRIVER: 'pglite',
  DATABASE_URL: 'postgres://unused',
  PGLITE_PATH: join(directory, 'database'),
  DATA_MASTER_KEY: Buffer.alloc(32, 11).toString('base64'),
  SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
  RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
  WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
  PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
  WORKSPACE_IMAGE_REVISION: 'dev',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'athanor Test',
  WEBAUTHN_ORIGIN: 'http://localhost:5173',
  ALLOW_INSECURE_DEV_AUTH: true,
  WORKER_ID: 'contract-worker',
  WORKER_POLL_MS: 25,
  SCHEDULER_POLL_MS: 60_000,
  TASK_MAX_STEPS: 2,
  // Off: every expectation in this file describes a turn that stops at its step ceiling.
  TASK_MAX_SELF_CONTINUATIONS: 0,
  SECURITY_EVENT_RETENTION_DAYS: 30,
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_PROVIDER: 'openrouter',
  AI_BASE_URL: 'https://openrouter.ai/api/v1',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  AI_REQUIRE_ZDR: true,
  AI_FORCE_INHOUSE_WEB: false,
  ALLOW_INSECURE_PROVIDER_URLS: false,
  CONNECTOR_ALLOWED_HOST_SUFFIXES: 'webdav.example',
  RESERVED_PREVIEW_PORTS: '4113,4413',
  WORKER_CONCURRENCY: 1,
  LOG_LEVEL: 'silent',
  PUSH_VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
  PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com',
  ...overrides
});

const start = async (
  overrides: Partial<ApiConfig> = {},
  holdModel?: { reached: () => void; release: Promise<void> }
) => {
  const directory = await mkdtemp(join(tmpdir(), 'athanor-contract-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  stubUpstreams(holdModel);
  const built = await buildServer(configFor(directory, overrides));
  disposers.push(async () => {
    await built.app.close().catch(() => undefined);
    await built.previewApp.close().catch(() => undefined);
    await built.database.close().catch(() => undefined);
  });
  const login = await built.app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
  const header = login.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : header)?.split(';', 1)[0];
  if (!cookie) throw new Error('dev sign-in returned no session cookie');
  return { ...built, cookie };
};

describe('the shapes the clients are promised', () => {
  test('every read surface answers in the shape packages/contracts declares', async () => {
    const { app, cookie } = await start();
    const get = async (url: string): Promise<unknown> => {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
      return response.json();
    };
    /** The label rides in the message, so a failure names the promise rather than a line number. */
    const conforms = (label: string, schema: z.ZodType, value: unknown): void => {
      const result = schema.safeParse(value);
      expect(
        result.success
          ? []
          : result.error.issues.map((issue) => `${label}.${issue.path.join('.')}: ${issue.message}`)
      ).toEqual([]);
    };

    // Bootstrap is what provisions the owner's computer on a fresh install.
    const bootstrap = (await get('/v1/bootstrap')) as {
      usage: unknown;
      workspaces: Array<{ id: string }>;
    };
    const workspaceId = bootstrap.workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { cookie, 'idempotency-key': 'contract-task-1' },
      payload: {
        workspaceId,
        prompt: 'Say hello and stop',
        modelId: MODEL_ID,
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 5
      }
    });
    expect(created.statusCode).toBe(200);
    conforms('Task', Task, created.json());
    const taskId = created.json<{ id: string }>().id;

    // Let the embedded worker take the task and turn away from the absent provider, so the event
    // list under test carries real encrypted payloads rather than being empty.
    //
    // `awaiting_resource` is where a box with no provider connected now lands, and that is the
    // point of the change that put it there: the wall has a notice, a Settings switch and a sweep
    // that resumes everything parked behind it the moment a key is saved. It used to be `failed`,
    // because the worker threw a code the wall table had never heard of.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const current = await get(`/v1/tasks/${taskId}`);
      if (
        ['completed', 'failed', 'cancelled', 'awaiting_resource'].includes(
          (current as { status: string }).status
        )
      )
        break;
      if (Date.now() > deadline) throw new Error('the task never reached a terminal state');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const events = (await get(`/v1/tasks/${taskId}/events`)) as unknown[];
    expect(events.length).toBeGreaterThan(0);

    conforms('Workspace[]', Workspace.array(), await get('/v1/workspaces'));
    conforms('Task', Task, await get(`/v1/tasks/${taskId}`));
    conforms('TaskPage', TaskPage, await get('/v1/tasks?limit=5'));
    conforms('TaskEvent[]', TaskEvent.array(), events);
    conforms('TaskPlan', TaskPlan.nullable(), await get(`/v1/tasks/${taskId}/plan`));
    conforms('ModelRelease[]', ModelRelease.array(), await get('/v1/models'));
    conforms('UsageSummary', UsageSummary, bootstrap.usage);
    conforms('Artifact[]', Artifact.array(), await get(`/v1/workspaces/${workspaceId}/artifacts`));
    conforms(
      'WorkspaceSnapshot[]',
      WorkspaceSnapshot.array(),
      await get(`/v1/workspaces/${workspaceId}/snapshots`)
    );
    conforms(
      'TaskRewindPreview',
      TaskRewindPreview,
      await get(`/v1/tasks/${taskId}/rewind-preview`)
    );
    conforms(
      'WorkspacePreview[]',
      WorkspacePreview.array(),
      await get(`/v1/workspaces/${workspaceId}/previews`)
    );
    conforms('Approval[]', Approval.array(), await get('/v1/approvals'));
    conforms('Connector[]', Connector.array(), await get('/v1/connectors'));
    conforms(
      'ConnectorAuditEvent[]',
      ConnectorAuditEvent.array(),
      await get('/v1/connectors/audit')
    );
    /*
     * A row, so the shape is actually checked.
     *
     * `TaskSchedule.array()` over an empty list conforms to anything, which is how a schema and the
     * route that answers it can disagree indefinitely - the exact failure this whole suite exists to
     * catch. It matters now because `TaskSchedule` gained a required `prompt`: the standing
     * instruction the box acts on unattended, which the owner previously could not read at all.
     */
    const schedule = await app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: { cookie, 'idempotency-key': 'contract-schedule' },
      payload: {
        workspaceId,
        prompt: 'Check the overnight logs',
        modelId: MODEL_ID,
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        spec: { kind: 'interval', everyMinutes: 60 }
      }
    });
    expect(schedule.statusCode, schedule.body).toBe(201);
    conforms('TaskSchedule', TaskSchedule, schedule.json());
    const schedules = await get('/v1/schedules');
    expect(schedules as unknown[]).toHaveLength(1);
    conforms('TaskSchedule[]', TaskSchedule.array(), schedules);
    conforms('ApiToken[]', ApiToken.array(), await get('/v1/api-tokens'));
    conforms(
      'AgentNotification[]',
      AgentNotification.array(),
      await get('/v1/notifications/agent')
    );
  }, 60_000);

  test('an identifier that cannot name a record is a 404, not a server fault', async () => {
    const { app, cookie } = await start();
    /**
     * Every path identifier is a UUID column, and PostgreSQL answers a malformed one by raising
     * 22P02 rather than returning nothing - which used to leave the route throwing an unrecognised
     * error, so a stale link produced a 500 and "The request could not be completed".
     */
    const cases = [
      { url: '/v1/tasks/not-a-task', code: 'task_not_found' },
      { url: '/v1/tasks/page', code: 'task_not_found' },
      { url: '/v1/tasks/00000000-0000-0000-0000-00000000000/events', code: 'task_not_found' },
      { url: '/v1/workspaces/not-a-workspace/artifacts', code: 'workspace_not_found' },
      { url: '/v1/workspaces/undefined/files?path=.', code: 'workspace_not_found' },
      { url: '/v1/workspaces/nope/memories', code: 'workspace_not_found' }
    ];
    for (const { url, code } of cases) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      const body = response.json<unknown>();
      const parsed = ApiError.safeParse(body);
      expect({ url, status: response.statusCode }).toEqual({ url, status: 404 });
      // The refusal has to arrive in the shape the clients branch on, not only with the right code.
      expect({ url, conforms: parsed.success }).toEqual({ url, conforms: true });
      expect({ url, code: parsed.success ? parsed.data.error.code : null }).toEqual({ url, code });
    }
  }, 60_000);
});

describe('the embedded worker and the process it lives in', () => {
  test('waits for the turn in flight before closing the database under it', async () => {
    let modelReached = (): void => undefined;
    const reachedModel = new Promise<void>((resolve) => {
      modelReached = resolve;
    });
    let releaseModel = (): void => undefined;
    const modelReleased = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const { app, cookie } = await start(
      { WORKER_POLL_MS: 25 },
      {
        reached: () => modelReached(),
        release: modelReleased
      }
    );

    const bootstrap = await app.inject({
      method: 'GET',
      url: '/v1/bootstrap',
      headers: { cookie }
    });
    const workspaceId = bootstrap.json<{ workspaces: Array<{ id: string }> }>().workspaces[0]!.id;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { cookie, 'idempotency-key': 'shutdown-task-1' },
      payload: {
        workspaceId,
        prompt: 'Anything at all',
        modelId: MODEL_ID,
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 5
      }
    });
    expect(created.statusCode, created.body).toBe(200);
    const task = created.json<{ workspaceId: string; status: string }>();
    expect(task.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.workspaceId).not.toBe(workspaceId);
    expect(task.status).not.toBe('awaiting_resource');
    // The worker has leased the task and is inside the model call.
    await reachedModel;

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Shutdown used to return here, and `database.close()` landed on a turn that was still writing.
    expect(closed).toBe(false);

    releaseModel();
    await closing;
    expect(closed).toBe(true);
  }, 60_000);

  test('shutdown wakes an idle worker rather than waiting out its poll interval', async () => {
    const { app } = await start({ WORKER_POLL_MS: 5_000 });
    // Far enough in that the loop has found nothing to do and settled into its wait.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await app.close();
    // Waiting for the loop is only tolerable because the loop is woken; left to time out, every
    // restart on an idle box would pay a full poll interval before the process could exit.
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 60_000);
});
