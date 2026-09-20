/**
 * End-to-end tests for the whole task loop.
 *
 * The unit suites cover pieces in isolation; nothing until now exercised the path a real user takes
 * - sign in, create a workspace, send a prompt, watch the agent call tools and finish - against a
 * real database, the real API, the real embedded worker and the real agent loop. Only the provider
 * and the workspace runner are scripted, because those are the two things a test cannot own.
 *
 * The provider script is fixed per test, so a failure here is athanor's behaviour changing rather
 * than a model saying something different today.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { seedModels } from '@athanor/model-gateway';
import type { ApiConfig } from './config.js';
import { buildServer } from './server.js';

const MODEL_ID = 'openrouter/deepseek/deepseek-v4-flash';

interface ScriptedTurn {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** Serve this HTTP status instead of a completion, to exercise the failure paths. */
  status?: number;
  /** Hold the completion open, so a test can act while the agent is genuinely mid-turn. */
  delayMs?: number;
}

/** Only the recorded fields these end-to-end contracts inspect. */
interface TaskEventRow {
  readonly kind?: string;
  readonly summary?: string;
  readonly sequence: number;
  readonly payload?: {
    verification?: { status?: string; remainingRisks?: unknown[] };
    attempts?: number;
  };
}

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>['app'];
  cookie: string;
  workspaceId: string;
  /** The agent's own turns. A retry that nothing else reports shows up here as a bill. */
  completions: () => number;
  /** Calls spent naming the conversation, which is one per conversation and not agent work. */
  titleCompletions: () => number;
  runnerCalls: () => string[];
  createTask: (prompt: string) => Promise<string>;
  settle: (taskId: string, until?: string[]) => Promise<string>;
  events: (taskId: string) => Promise<TaskEventRow[]>;
  status: (taskId: string) => Promise<string>;
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.unstubAllGlobals();
});

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args
});

/** A finish whose evidence cites a successful tool call from the same turn, as the loop requires. */
const groundedFinish = (summary: string, cite: string | null) =>
  toolCall('call-finish', 'finish', {
    summary,
    verification: cite
      ? {
          status: 'verified',
          evidence: [{ claim: summary, source: 'tool_result', toolCallId: cite }],
          remainingRisks: []
        }
      : { status: 'not_applicable', evidence: [], remainingRisks: [] }
  });

const start = async (
  script: ScriptedTurn[],
  options: {
    maxSteps?: number;
    onRunnerCall?: (path: string) => unknown;
    /** Dollar ceiling applied to every task this harness creates. */
    taskSpendCapUsd?: number;
  } = {}
): Promise<Harness> => {
  const directory = await mkdtemp(join(tmpdir(), 'athanor-e2e-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));

  let served = 0;
  let titleCalls = 0;
  const runnerCalls: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' }
        });

      if (url.includes('workspace-manager.test')) {
        const path = new URL(url).pathname;
        runnerCalls.push(path);
        const scripted = options.onRunnerCall?.(path);
        if (scripted !== undefined) return json(scripted);
        // Each route has to answer in the shape the worker parses. A generic {ok:true} reads as a
        // failed tool, which then fails verification - a real-looking failure with a fake cause.
        if (path.endsWith('/project-inputs')) return json({ sources: [] });
        if (path.endsWith('/checkpoints')) {
          if (init?.method !== 'POST' || typeof init.body !== 'string')
            throw Error('Expected a JSON checkpoint request');
          const body = JSON.parse(init.body) as { checkpointId: string };
          expect(body.checkpointId).toEqual(expect.any(String));
          return json({
            id: body.checkpointId,
            mechanism: 'content',
            createdAt: new Date().toISOString(),
            fileCount: 0,
            totalBytes: 0,
            storedBytes: 0,
            changedFileCount: 0,
            uncoveredFileCount: 0,
            uncoveredPaths: [],
            uncoveredPathsTruncated: false,
            durationMs: 1,
            pruned: []
          });
        }
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
        if (path.endsWith('/exec'))
          return json({
            exitCode: 0,
            signal: null,
            stdout: 'hello\n',
            stderr: '',
            durationMs: 4,
            timedOut: false
          });
        if (path.endsWith('/usage')) return json({ storageBytes: 2_048 });
        if (path.endsWith('/file')) return new Response('file contents', { status: 200 });
        return json({ ok: true });
      }
      if (url.endsWith('/endpoints/zdr'))
        return json({
          data: seedModels().map((m) => ({ model_id: m.providerModelId, status: 0 }))
        });
      if (url.split('?')[0]!.endsWith('/models'))
        return json({
          data: seedModels().map((m) => ({
            id: m.providerModelId,
            context_length: m.contextTokens,
            architecture: { input_modalities: m.modalities },
            supported_parameters: ['tools', 'reasoning']
          }))
        });
      if (url.includes('/benchmarks')) return json({ data: [] });

      if (url.endsWith('/chat/completions')) {
        /**
         * The agent always offers tools; nothing else this server calls a model for does. That is
         * what separates a turn of work from the one short call that names the conversation once
         * it has answered - which must not consume a scripted turn, and must not be counted in the
         * budget these tests assert, because it is neither a retry nor a step.
         */
        const body =
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as { tools?: unknown[] })
            : ({} as { tools?: unknown[] });
        if (!Array.isArray(body.tools) || body.tools.length === 0) {
          titleCalls += 1;
          return new Response(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: 'A named conversation' } }]
            })}\n\ndata: ${JSON.stringify({
              choices: [{ finish_reason: 'stop', delta: {} }],
              usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44, cost: 0.00001 }
            })}\n\ndata: [DONE]\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } }
          );
        }
        const turn = script[Math.min(served, script.length - 1)] ?? {};
        served += 1;
        if (turn.delayMs) await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
        if (turn.status) return json({ error: { message: 'upstream fault' } }, turn.status);
        // The worker always streams, so a scripted turn has to arrive as server-sent events. A
        // plain JSON body parses as a reply with no tool calls, which the loop reads as "the model
        // never finished" - the failure mode this suite exists to catch, not one to reproduce.
        const frames: string[] = [];
        const text = turn.content ?? '';
        for (let index = 0; index < text.length; index += 24) {
          frames.push(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: text.slice(index, index + 24) } }]
            })}\n\n`
          );
        }
        turn.toolCalls?.forEach((call, index) => {
          frames.push(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index,
                        id: call.id,
                        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
                      }
                    ]
                  }
                }
              ]
            })}\n\n`
          );
        });
        frames.push(
          `data: ${JSON.stringify({
            choices: [{ finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop', delta: {} }],
            usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960, cost: 0.0002 }
          })}\n\n`
        );
        frames.push('data: [DONE]\n\n');
        return new Response(frames.join(''), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        });
      }
      return json({ error: { message: `unhandled ${url}` } }, 404);
    })
  );

  const config: ApiConfig = {
    DEPLOYMENT_MODE: 'development',
    MODEL_CATALOG_SCOPE: 'reviewed_open_weight',
    CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
    ATHANOR_STATE_PATH: directory,
    RELAY_STATE_DIR: join(directory, 'relay'),
    RELAY_LOCAL_HOST: '127.0.0.1',
    RELAY_LOCAL_PORT: 443,
    RELAY_LOCAL_HTTP_PORT: 80,
    RELAY_LOCAL_PREVIEW_PORT: 8443,
    REGISTRATION_BOOTSTRAP_TOKEN: 'e2e-pairing-token-with-at-least-20-characters',
    REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
    PUBLIC_APP_URL: 'http://localhost:5173',
    PREVIEW_BASE_URL: 'http://preview.localhost:4400',
    API_HOST: '127.0.0.1',
    API_PORT: 4111,
    PREVIEW_GATEWAY_HOST: '127.0.0.1',
    PREVIEW_GATEWAY_PORT: 4411,
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
    WORKER_ID: 'e2e-worker',
    WORKER_POLL_MS: 25,
    SCHEDULER_POLL_MS: 60_000,
    TASK_MAX_STEPS: options.maxSteps ?? 24,
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
    RESERVED_PREVIEW_PORTS: '4111,4411',
    WORKER_CONCURRENCY: 1,
    LOG_LEVEL: 'silent',
    PUSH_VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
    PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com'
  };

  const { app, previewApp, database } = await buildServer(config);
  disposers.push(async () => {
    // Closing the app already closes the database it owns, so a second close throws and would
    // otherwise replace whatever the test actually failed on.
    await app.close().catch(() => undefined);
    await previewApp.close().catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
  if (!cookie) throw new Error('dev sign-in returned no session cookie');

  const created = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: { cookie, 'idempotency-key': 'e2e-workspace-0001' },
    payload: { name: 'End to end' }
  });
  const workspaceId = created.json<{ id: string }>().id;

  const status = async (taskId: string): Promise<string> => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie }
    });
    return response.json<{ status: string }>().status;
  };

  let nextKey = 0;
  return {
    app,
    cookie,
    workspaceId,
    completions: () => served,
    titleCompletions: () => titleCalls,
    runnerCalls: () => runnerCalls,
    status,
    createTask: async (prompt) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { cookie, 'idempotency-key': `e2e-task-${(nextKey += 1)}` },
        payload: {
          workspaceId,
          prompt,
          modelId: MODEL_ID,
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 20,
          ...(options.taskSpendCapUsd === undefined ? {} : { maxSpendUsd: options.taskSpendCapUsd })
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      const task = response.json<{ id: string; workspaceId: string; status: string }>();
      expect(task.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(task.workspaceId).not.toBe(workspaceId);
      expect(task.status).not.toBe('awaiting_resource');
      return task.id;
    },
    settle: async (taskId, until = ['completed', 'failed', 'cancelled', 'awaiting_user']) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const current = await status(taskId);
        if (until.includes(current)) return current;
        if (Date.now() > deadline) throw new Error(`Task stayed ${current} for 20s`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    events: async (taskId) => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${taskId}/events`,
        headers: { cookie }
      });
      const body = response.json<TaskEventRow[] | { events?: TaskEventRow[] }>();
      return Array.isArray(body) ? body : (body.events ?? []);
    }
  };
};

/**
 * Each of these builds a database, an API and a worker of its own and then waits for a real polling
 * loop to settle, so the generous per-test timeout is the honest cost of an end-to-end test rather
 * than slack: under vitest's five-second default they fail on a loaded machine and pass on an idle
 * one, which is worse than useless.
 */
describe('a task from prompt to completion', () => {
  test('plans, calls a tool, and finishes with grounded evidence', async () => {
    const harness = await start([
      {
        toolCalls: [
          toolCall('call-1', 'set_plan', {
            steps: [{ title: 'Do the work', status: 'in_progress' }]
          })
        ]
      },
      { toolCalls: [toolCall('call-2', 'shell', { executable: 'echo', args: ['hello'] })] },
      {
        content: 'Done.',
        // Closing the plan in the same turn as the finish, which is what a well-behaved agent does:
        // the harness refuses a finish that leaves steps open rather than marking them done itself,
        // so the plan the owner watched stays true.
        toolCalls: [
          toolCall('call-3', 'set_plan', {
            steps: [{ title: 'Do the work', status: 'completed' }]
          }),
          groundedFinish('Ran the command and read its output.', 'call-2')
        ]
      }
    ]);

    const taskId = await harness.createTask('Say hello');
    expect(await harness.settle(taskId)).toBe('completed');
    // Three turns of work means exactly three of the agent's own completions. A regression that
    // retries invisibly shows up here as a bill, which is the only place the owner would otherwise
    // notice it - so naming the conversation is counted separately rather than folded in.
    expect(harness.completions()).toBe(3);
    // This catalogue has no published prices, so auxiliary naming cannot buy an unbounded call.
    expect(harness.titleCompletions()).toBe(0);
    expect(harness.runnerCalls().some((path) => path.includes('/exec'))).toBe(true);
  }, 30_000);

  test('will not let a finish quietly abandon the plan the owner is watching', async () => {
    // The harness used to mark every outstanding step completed on the way out, so a plan that was
    // never finished reported itself finished. It now spends one turn asking for the truth instead.
    const harness = await start([
      {
        toolCalls: [
          toolCall('call-1', 'set_plan', {
            steps: [
              { title: 'Do the work', status: 'in_progress' },
              { title: 'Check it', status: 'pending' }
            ]
          })
        ]
      },
      { toolCalls: [toolCall('call-2', 'shell', { executable: 'echo', args: ['hello'] })] },
      { content: 'Done.', toolCalls: [groundedFinish('Ran the command.', 'call-2')] }
    ]);
    const taskId = await harness.createTask('Do two things');
    expect(await harness.settle(taskId)).toBe('completed');
    const summaries = (await harness.events(taskId)).map((event) => event.summary ?? '');
    expect(summaries).toContain('Plan steps are still open');
  }, 30_000);

  test('does not hold a finish against the plan the harness wrote for itself', async () => {
    /*
     * When no plan is declared the harness writes one - three boilerplate lines beginning "Inspect
     * the request, inputs, and current workspace state" - and it used to hold the finish against
     * its own boilerplate. Measured on one research task: the answer was written, and six of the
     * ten model turns came after it, this hold among them. The hold above still applies to a plan
     * somebody chose to write, which is the one the owner is actually watching.
     */
    // `mkdir` rather than `echo`: the fallback plan is only written once the turn has changed
    // something, and a command that changes nothing never reaches the case this covers.
    const harness = await start([
      { toolCalls: [toolCall('call-1', 'shell', { executable: 'mkdir', args: ['-p', 'out'] })] },
      { content: 'Done.', toolCalls: [groundedFinish('Made the directory.', 'call-1')] }
    ]);
    const taskId = await harness.createTask('Just do the thing');
    expect(await harness.settle(taskId)).toBe('completed');
    const summaries = (await harness.events(taskId)).map((event) => event.summary ?? '');
    // The harness did write itself a plan - that is the precondition this test is about.
    expect(summaries).toContain('Initial execution plan');
    expect(summaries).not.toContain('Plan steps are still open');
  }, 30_000);

  test('a conversational answer with no tools completes without inventing evidence', async () => {
    const harness = await start([
      {
        content: 'Fibonacci is a sequence.',
        toolCalls: [groundedFinish('Answered from knowledge.', null)]
      }
    ]);
    const taskId = await harness.createTask('Explain fibonacci');
    expect(await harness.settle(taskId)).toBe('completed');
    expect(harness.completions()).toBe(1);
  }, 30_000);
});

describe('a completion that cannot be grounded', () => {
  test('finishes with the doubt recorded rather than throwing the work away', async () => {
    // Verification has its own retry bound: exhausting it must preserve the work and its
    // uncertainty without spending the entire task budget on the same malformed evidence.
    const harness = await start(
      [
        { toolCalls: [toolCall('call-1', 'shell', { executable: 'echo', args: ['work'] })] },
        {
          content: 'Done.',
          toolCalls: [
            toolCall('call-finish', 'finish', {
              summary: 'All done.',
              verification: { status: 'verified', evidence: [{ claim: 'I did it' }] }
            })
          ]
        }
      ],
      { maxSteps: 40 }
    );

    const taskId = await harness.createTask('Do some work');
    expect(await harness.settle(taskId)).toBe('completed');
    // Subsequent plan and acceptance holds must also settle within a bounded number of calls.
    expect(harness.completions()).toBeLessThanOrEqual(10);

    const events = await harness.events(taskId);
    const warnings = events.filter((event) => event.kind === 'warning');
    const completed = events.filter((event) => event.kind === 'completed');
    expect(warnings).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(warnings[0]!.payload?.attempts).toBeGreaterThan(0);
    expect(warnings[0]!.sequence).toBeLessThan(completed[0]!.sequence);
    expect(completed[0]!.payload?.verification?.status).toBe('unverified');
    expect((completed[0]!.payload?.verification?.remainingRisks ?? []).length).toBeGreaterThan(0);
  }, 30_000);
});

describe('a task the model never completes', () => {
  test('keeps the answer when the model never calls finish, and says it did not', async () => {
    // The model answers, forever, and never calls finish. Nagging used to consume every remaining
    // step - one billed call each - so the bound stays. What changed is the ending: it used to be
    // FAILED, and that threw away work that was often correct. Asked what the top story on a news
    // site was, the agent searched, opened the page and wrote the right headline with its address
    // five times over - a reply cut off at the output limit is continued, and each continuation is
    // another answer without a finish - and all five were binned.
    const harness = await start([{ content: 'Here is my answer, but I will never call finish.' }], {
      maxSteps: 40
    });
    const taskId = await harness.createTask('Answer something');
    expect(await harness.settle(taskId)).toBe('completed');
    expect(harness.completions()).toBeLessThanOrEqual(8);
    const summaries = (await harness.events(taskId)).map((event) => event.summary ?? '');
    expect(summaries.some((line) => line.includes('without calling finish'))).toBe(true);
  }, 30_000);
});

describe('money', () => {
  test('pauses a task at its dollar ceiling instead of running past it', async () => {
    // The compute-credit budget is not a money budget: a credit is worth cents on one model and
    // dollars on another. This is the ceiling denominated in what the owner actually pays, and it
    // has to stop the task before the step that crosses it, not after.
    const harness = await start(
      [
        { toolCalls: [toolCall('call-1', 'shell', { executable: 'echo', args: ['work'] })] },
        { toolCalls: [toolCall('call-2', 'shell', { executable: 'echo', args: ['more'] })] },
        { toolCalls: [toolCall('call-3', 'shell', { executable: 'echo', args: ['still more'] })] },
        { content: 'Done.', toolCalls: [groundedFinish('Ran the commands.', 'call-1')] }
      ],
      { maxSteps: 40, taskSpendCapUsd: 0.0003 }
    );

    const taskId = await harness.createTask('Do a lot of work');
    expect(await harness.settle(taskId, ['paused', 'completed', 'failed'])).toBe('paused');
    // Paused, not failed: the work is intact and raising the ceiling carries on from here.
    const summaries = (await harness.events(taskId)).map((event) => event.summary ?? '');
    expect(summaries.some((line) => line.startsWith('Paused at'))).toBe(true);
    expect(harness.completions()).toBeLessThanOrEqual(4);
  }, 30_000);
});

describe('provider faults', () => {
  test('a 500 is retried rather than killing a task that has already done work', async () => {
    const harness = await start([
      { toolCalls: [toolCall('call-1', 'shell', { executable: 'echo', args: ['work'] })] },
      { status: 500 },
      { content: 'Done.', toolCalls: [groundedFinish('Ran the command.', 'call-1')] }
    ]);
    const taskId = await harness.createTask('Do some work');
    expect(await harness.settle(taskId)).toBe('completed');
  }, 30_000);
});

describe('user control', () => {
  test('cancelling stops the remaining calls in a batch from running', async () => {
    // The model proposes several actions at once. Cancel has to stop the ones that have not run,
    // or an irreversible side effect happens after the interface says the task stopped.
    const harness = await start([
      {
        toolCalls: [
          toolCall('call-1', 'shell', { executable: 'echo', args: ['first'] }),
          toolCall('call-2', 'shell', { executable: 'echo', args: ['second'] }),
          toolCall('call-3', 'shell', { executable: 'echo', args: ['third'] })
        ]
      },
      { content: 'Done.', toolCalls: [groundedFinish('Ran the commands.', 'call-1')] }
    ]);

    const taskId = await harness.createTask('Run three things');
    await harness.settle(taskId, ['running', 'planning', 'completed', 'failed']);
    await harness.app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/cancel`,
      headers: { cookie: harness.cookie, 'idempotency-key': 'e2e-cancel-1' },
      payload: {}
    });
    const settled = await harness.settle(taskId, ['cancelled', 'completed', 'failed']);
    expect(['cancelled', 'completed']).toContain(settled);
  }, 30_000);
});

describe('stopping and picking the same conversation back up', () => {
  test('a follow-up after Stop continues the stopped conversation instead of starting a new one', async () => {
    /**
     * Stop tells the owner the work so far is kept and that the next message continues from here.
     * That sentence was false: a stopped conversation refused every follow-up, so the client fell
     * through to creating a new task and the transcript being read was replaced by an empty one.
     */
    const harness = await start([
      { toolCalls: [toolCall('call-1', 'shell', { executable: 'echo', args: ['first'] })] },
      {
        delayMs: 3_000,
        toolCalls: [toolCall('call-2', 'shell', { executable: 'echo', args: ['second'] })]
      },
      { content: 'Done.', toolCalls: [groundedFinish('Ran the command.', 'call-1')] }
    ]);

    const taskId = await harness.createTask('Start something long');
    // The first turn has to land before Stop, or there is no conversation state to continue from.
    const deadline = Date.now() + 15_000;
    while (!harness.runnerCalls().some((path) => path.endsWith('/exec'))) {
      if (Date.now() > deadline) throw new Error('the agent never ran its first tool');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const stopped = await harness.app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/cancel`,
      headers: { cookie: harness.cookie, 'idempotency-key': 'e2e-stop-continue-1' },
      payload: {}
    });
    expect(stopped.statusCode).toBe(200);
    expect(await harness.status(taskId)).toBe('cancelled');

    const followUp = await harness.app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/messages`,
      headers: { cookie: harness.cookie, 'idempotency-key': 'e2e-stop-continue-2' },
      payload: { prompt: 'Actually, do it this way instead', maxComputeCredits: 20 }
    });
    expect(followUp.statusCode, followUp.body).toBe(200);
    // The same conversation, not a new one: this is the whole promise the notice makes.
    expect(followUp.json<{ id: string }>().id).toBe(taskId);
    expect(followUp.json<{ status: string }>().status).toBe('queued');
  }, 40_000);
});
