/**
 * The activity stream, over a real socket: how fast it delivers, what it does when full, and what
 * it delivers to a device that dropped and came back.
 *
 * Everything else in this suite runs against `app.inject`, which cannot exercise a hijacked
 * response. These tests bind a real listener and read the real server-sent event stream with a real
 * client, because everything measured here - when the first character of a reply reaches the
 * screen, what a send blocks on, which frames survive a reconnect, and what happens to a
 * connection the server ends underneath itself - exists only in the socket's lifecycle.
 *
 * The provider is scripted with a deliberate 300 ms first byte so the latency numbers below are
 * athanor's own overhead and not the model's.
 *
 * Two shapes of fixture live here. The short one answers in a sentence and produces four delta
 * frames, which is enough to time a first paint and nothing else: a four-frame stream is over
 * before a reconnect or an eviction can land in the middle of it. The long one (`LONG_ANSWER`,
 * `deltaChars`, `frameGapMs`) streams a couple of thousand frames over some twenty seconds, so
 * "drop the connection mid-reply" and "evict this stream while it is writing" become questions
 * that can be asked at all.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { seedModels } from '@athanor/model-gateway';
import type { ApiConfig } from './config.js';
import { buildServer } from './server.js';

const MODEL_ID = 'openrouter/deepseek/deepseek-v4-flash';

/**
 * A long reply that never says the same thing twice.
 *
 * The numbering is not decoration. A fixture built by repeating one sentence is, as far as the
 * agent is concerned, a model that has started looping, and `degenerateRepeat` cuts the generation
 * off after a few seconds - which the first version of this fixture did, silently, leaving a test
 * that thought it was measuring a long stream and was measuring an aborted one. Every sentence
 * carries its own index so no tail of it tiles.
 */
const answerOf = (sentences: number): string =>
  Array.from(
    { length: sentences },
    (_sentence, index) =>
      `Step ${index}: I opened the file it named, followed the ${index} references inside it, ` +
      `and wrote down what I found there before moving on to the next one. `
  ).join('');

/**
 * Twenty-seven kilobytes of it. At `deltaChars: 10` the provider fixture cuts this into 2,733 delta
 * frames; the agent's 120 ms flusher then collapses those into one timeline event roughly every
 * eighth of a second, so what reaches the client is 167 `assistant_delta` frames over about twenty
 * seconds. Both numbers matter: the provider count is what makes the fixture the
 * shape of a real reply, and the timeline count is what a reconnect has to stitch back together
 * without a duplicate or a hole.
 */
const LONG_ANSWER = answerOf(190);

/** The `code` a Node stream error carries, which is the part worth reading in a failure. */
const codeOf = (error: Error): string => (error as Error & { code?: string }).code ?? error.message;

/** Captured before any test stubs the global: the stub cannot reach the listener under test. */
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.unstubAllGlobals();
});

interface LatencyHarness {
  origin: string;
  cookie: string;
  workspaceId: string;
  runnerCalls: () => string[];
  send: (prompt: string) => Promise<string>;
  get: (path: string) => Promise<{ statusCode: number }>;
  /** The trajectory as the database holds it: what a stream is answerable against. */
  events: (taskId: string) => Promise<Array<{ sequence: number; kind: string }>>;
  /**
   * Hold the agent-disk walk open until `releaseWalk`, so "this response did not wait for it" is an
   * ordering fact rather than a stopwatch reading. Anything that waits on the walk cannot answer at
   * all while it is held.
   */
  holdWalk: () => void;
  releaseWalk: () => void;
  /**
   * Park every event read the way a loaded database parks one, so "this stream was evicted while
   * it was mid-write" is an ordering fact rather than a race the test wins some of the time.
   *
   * Every open stream re-reads the table on every event, so arming this and waiting for the count
   * to reach the number of open connections leaves all of them suspended at exactly the line the
   * eviction path interrupts.
   */
  holdEventReads: () => void;
  heldEventReads: () => number;
  releaseEventReads: () => void;
  /**
   * How many rows each parked read returned once it was let go. A zero everywhere means the streams
   * woke up with nothing to write and the test proved nothing, so it is asserted rather than
   * assumed.
   */
  heldReadRows: () => number[];
  readSizes: () => number[];
  appendReplay: (taskId: string, count: number) => Promise<void>;
  /**
   * Turn the server's half of one connection into a peer that accepts nothing: every byte handed
   * to the socket from that point on is buffered and never completes.
   *
   * That is what a phone asleep with the tab open looks like from this side, and it is the state
   * that decides whether a write onto an already-ended response is visible at all: a response whose
   * `end()` cannot flush stays attached to its socket with `destroyed` still false, and a stray
   * write onto it emits `'error'` instead of being dropped in silence. Reaching that by volume
   * means outrunning the peer's buffers - about two megabytes on this machine - which one task's
   * reply cannot do, because the model gateway caps a generation at `maxTokens` times eight
   * characters and the whole fixture here is under a megabyte. So the state is arranged rather
   * than approached.
   */
  stall: (clientPort: number) => void;
  /**
   * Every error emitted on a response, which is the only place a write onto a finished one is
   * visible. Node rejects such a write with `false` and then emits, so nothing the client sees and
   * nothing the route's own `try`/`catch` catches records that it happened.
   */
  responseErrors: () => string[];
}

const start = async (
  answer: string,
  options: {
    firstByteMs?: number;
    workerPollMs?: number;
    usageDelayMs?: number;
    frameGapMs?: number;
    /** Characters per provider delta frame. Smaller means more frames over a longer wall clock. */
    deltaChars?: number;
  } = {}
): Promise<LatencyHarness> => {
  const directory = await mkdtemp(join(tmpdir(), 'athanor-latency-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const runnerCalls: string[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let heldWalk: Promise<void> | null = null;
  let openWalkGate = (): void => undefined;

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
        if (path.endsWith('/project-execution')) {
          if (init?.method !== 'POST' || typeof init.body !== 'string')
            throw Error('Expected a JSON project preparation request');
          const body = JSON.parse(init.body) as {
            taskId: string;
            workspaceId: string;
            paths: string[];
            kind: string;
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
        if (path.endsWith('/project-inputs')) return json({ sources: [] });
        if (/^\/v1\/workspaces\/[0-9a-f-]{36}\/projects\/[0-9a-f-]{36}\/updates$/.test(path))
          return json({
            head: null,
            updates: [],
            revisions: [],
            nextCursor: null,
            observedAt: new Date().toISOString()
          });
        if (path.endsWith('/usage')) {
          // The real runner walks the whole tree here. This is that walk, on a modest project -
          // or, while a test holds it, a walk that has not finished at all yet.
          if (heldWalk) await heldWalk;
          else await sleep(options.usageDelayMs ?? 700);
          return json({
            storageBytes: 2_048,
            hostStorageTotalBytes: 1_000_000_000,
            hostStorageAvailableBytes: 900_000_000
          });
        }
        if (path.endsWith('/exec'))
          return json({
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
            durationMs: 1,
            timedOut: false
          });
        return json({ ok: true });
      }
      if (url.endsWith('/endpoints/zdr'))
        return json({
          data: seedModels().map((m) => ({ model_id: m.providerModelId, status: 0 }))
        });
      if (url.endsWith('/models'))
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
        const frames: string[] = [];
        const width = options.deltaChars ?? 24;
        for (let index = 0; index < answer.length; index += width)
          frames.push(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: answer.slice(index, index + width) } }]
            })}\n\n`
          );
        frames.push(
          `data: ${JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-finish',
                      function: {
                        name: 'finish',
                        arguments: JSON.stringify({
                          summary: 'Answered.',
                          verification: {
                            status: 'not_applicable',
                            evidence: [],
                            remainingRisks: []
                          }
                        })
                      }
                    }
                  ]
                }
              }
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0001 }
          })}\n\n`
        );
        frames.push('data: [DONE]\n\n');
        // A real model does not hand over a finished answer: it arrives token by token, which is
        // the only shape in which "when did the first character appear" is a question at all.
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            await sleep(options.firstByteMs ?? 300);
            for (const frame of frames) {
              controller.enqueue(encoder.encode(frame));
              await sleep(options.frameGapMs ?? 150);
            }
            controller.close();
          }
        });
        return new Response(body, {
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
    REGISTRATION_BOOTSTRAP_TOKEN: 'latency-pairing-token-with-20-characters',
    REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
    PUBLIC_APP_URL: 'http://localhost:5173',
    PREVIEW_BASE_URL: 'http://preview.localhost:4400',
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    PREVIEW_GATEWAY_HOST: '127.0.0.1',
    PREVIEW_GATEWAY_PORT: 0,
    DATABASE_DRIVER: 'pglite',
    DATABASE_URL: 'postgres://unused',
    PGLITE_PATH: join(directory, 'database'),
    DATA_MASTER_KEY: Buffer.alloc(32, 13).toString('base64'),
    SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
    RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
    WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
    PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
    WORKSPACE_IMAGE_REVISION: 'dev',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'athanor Test',
    WEBAUTHN_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_DEV_AUTH: true,
    WORKER_ID: 'latency-worker',
    // The production default. Before the queue signal, this was up to a second of the wait.
    WORKER_POLL_MS: options.workerPollMs ?? 1_000,
    SCHEDULER_POLL_MS: 60_000,
    TASK_MAX_STEPS: 8,
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
    RESERVED_PREVIEW_PORTS: '4201,4203',
    WORKER_CONCURRENCY: 1,
    LOG_LEVEL: 'silent',
    PUSH_VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
    PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com'
  };

  const { app, previewApp, store, database } = await buildServer(config);
  // Keyed by the client's port, which is the only handle a test has on which connection is which.
  const serverSockets = new Map<number, net.Socket>();
  app.server.on('connection', (socket) => {
    if (socket.remotePort !== undefined) serverSockets.set(socket.remotePort, socket);
  });
  const responseErrors: string[] = [];
  // Reading only. Fastify already keeps an `'error'` listener on every reply - `onResFinished`,
  // registered beside the `'finish'` one and not removed by `reply.hijack()` - so this adds a
  // second reader and changes nothing about what an emitted error does.
  app.server.on('request', (_request, response) => {
    response.on('error', (error: Error) => responseErrors.push(codeOf(error)));
  });
  /**
   * The stream route reads the table through this method on every event, so replacing it is the
   * only seam that can suspend a live connection at the exact line eviction interrupts. It is the
   * same trick as `holdWalk` above, one layer down: the route looks the property up on each call,
   * so an own property shadowing the prototype takes effect for connections already open.
   */
  const readTaskEvents = store.listTaskEvents.bind(store);
  const readTaskEventPage = store.listTaskEventPage.bind(store);
  const readSizes: number[] = [];
  let parkedReads: Array<() => void> | null = null;
  const parkedReadRows: number[] = [];
  store.listTaskEvents = async (taskId, after) => {
    const queue = parkedReads;
    const rows = await readTaskEvents(taskId, after);
    readSizes.push(rows.length);
    if (!queue) return rows;
    // Only a read that has something to write is worth holding. A stream parked on an empty read
    // wakes up, writes nothing, and would make the test below green for no reason at all.
    if (rows.length === 0) return rows;
    parkedReadRows.push(rows.length);
    await new Promise<void>((resolve) => queue.push(resolve));
    return rows;
  };
  store.listTaskEventPage = async (taskId, options) => {
    const queue = parkedReads;
    const page = await readTaskEventPage(taskId, options);
    readSizes.push(page.events.length);
    if (queue && page.events.length) {
      parkedReadRows.push(page.events.length);
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    return page;
  };
  disposers.push(async () => {
    await app.close().catch(() => undefined);
    await previewApp.close().catch(() => undefined);
    await database.close().catch(() => undefined);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('The API did not bind a port');
  const origin = `http://127.0.0.1:${address.port}`;

  // The stubbed global fetch cannot reach the listener, so the test client is the undici request
  // the stub replaced. Keeping a handle to it is the only way to speak real HTTP here.
  const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
  if (!cookie) throw new Error('dev sign-in returned no session cookie');
  const created = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: { cookie, 'idempotency-key': 'latency-workspace-1' },
    payload: { name: 'Latency' }
  });
  const workspaceId = created.json<{ id: string }>().id;
  runnerCalls.length = 0;

  let nextKey = 0;
  return {
    origin,
    cookie,
    workspaceId,
    runnerCalls: () => runnerCalls,
    holdWalk: () => {
      heldWalk = new Promise<void>((resolve) => {
        openWalkGate = () => resolve();
      });
    },
    releaseWalk: () => {
      heldWalk = null;
      openWalkGate();
    },
    holdEventReads: () => {
      parkedReads = [];
      parkedReadRows.length = 0;
    },
    heldEventReads: () => parkedReads?.length ?? 0,
    releaseEventReads: () => {
      const waiting = parkedReads ?? [];
      parkedReads = null;
      for (const resolve of waiting) resolve();
    },
    heldReadRows: () => [...parkedReadRows],
    readSizes: () => [...readSizes],
    appendReplay: async (taskId, count) => {
      for (let index = 0; index < count; index += 1)
        await store.appendTaskEvent({
          taskId,
          kind: 'status',
          summary: `Replay record ${index}: ${'synthetic '.repeat(30)}`
        });
      readSizes.length = 0;
    },
    responseErrors: () => [...responseErrors],
    stall: (clientPort) => {
      const socket = serverSockets.get(clientPort);
      if (!socket) throw new Error(`no server-side socket for client port ${clientPort}`);
      socket.write = (() => false) as typeof socket.write;
      // Popped before the disposer that closes the app, which would otherwise wait on a connection
      // that can no longer finish anything.
      disposers.push(async () => {
        socket.destroy();
      });
    },
    get: (path) => app.inject({ method: 'GET', url: path, headers: { cookie } }),
    events: async (taskId) => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${taskId}/events`,
        headers: { cookie }
      });
      if (response.statusCode !== 200) throw new Error(`events failed: ${response.body}`);
      return response.json<Array<{ sequence: number; kind: string }>>();
    },
    send: async (prompt) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { cookie, 'idempotency-key': `latency-task-${(nextKey += 1)}` },
        payload: {
          workspaceId,
          prompt,
          modelId: MODEL_ID,
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 20
        }
      });
      if (response.statusCode !== 200) throw new Error(`send failed: ${response.body}`);
      const task = response.json<{ id: string; workspaceId: string; status: string }>();
      expect(task.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(task.workspaceId).not.toBe(workspaceId);
      expect(task.status).not.toBe('awaiting_resource');
      return task.id;
    }
  };
};

interface StreamFrame {
  /**
   * The SSE `id:` line, which is the sequence a reconnecting client resumes from. Null on the
   * terminal frame, which carries no id because there is nothing after it to resume at.
   */
  id: number | null;
  kind: string;
  atMs: number;
}

interface OpenStream {
  status: number;
  /** Filled as frames arrive, so a test can wait on the stream rather than on a clock. */
  frames: StreamFrame[];
  /** The sequences this connection delivered, in the order it delivered them. */
  ids: () => number[];
  /** Resolves when the connection ends, whichever side ended it. */
  ended: Promise<void>;
  abort: () => void;
}

/**
 * Opens a live SSE stream over real HTTP and parses it as it arrives, stamping every frame with
 * how long after the send it landed. Nothing is buffered until the end: the tests below need to
 * act - drop the socket, open a sixth connection - part-way through a reply that is still being
 * written.
 *
 * `lastEventId` sends the header a browser's own EventSource sends on reconnect, which is the
 * whole replay contract: it is the last sequence this client actually parsed, not the last one the
 * server wrote, and anything the server sent into a socket the client had already stopped reading
 * has to come back.
 */
const connect = async (
  harness: LatencyHarness,
  taskId: string,
  options: { lastEventId?: number; after?: number; sentAt?: number } = {}
): Promise<OpenStream> => {
  const controller = new AbortController();
  const sentAt = options.sentAt ?? performance.now();
  const query = options.after === undefined ? '' : `?after=${options.after}`;
  const response = await realFetch(`${harness.origin}/v1/tasks/${taskId}/events/stream${query}`, {
    headers: {
      cookie: harness.cookie,
      accept: 'text/event-stream',
      ...(options.lastEventId === undefined ? {} : { 'last-event-id': String(options.lastEventId) })
    },
    signal: controller.signal
  });
  const frames: StreamFrame[] = [];
  const reader = response.body!.getReader();
  const ended = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader
        .read()
        .catch(() => ({ done: true, value: undefined }) as ReadableStreamReadResult<Uint8Array>);
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const lines = block.split('\n');
        const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
        const rawId = lines.find((line) => line.startsWith('id: '))?.slice(4);
        if (data) {
          const parsed = JSON.parse(data) as { kind?: string; status?: string };
          frames.push({
            id: rawId === undefined ? null : Number(rawId),
            kind: parsed.kind ?? `terminal:${parsed.status ?? ''}`,
            atMs: performance.now() - sentAt
          });
        }
        split = buffer.indexOf('\n\n');
      }
    }
  })();
  return {
    status: response.status,
    frames,
    ids: () => frames.flatMap((frame) => (frame.id === null ? [] : [frame.id])),
    ended,
    abort: () => controller.abort()
  };
};

/**
 * A device that opened the stream and then stopped reading from it - a phone that went to sleep
 * with the tab open, which is the exact situation the eviction path exists to clear up.
 *
 * A raw socket rather than `fetch`, because what matters is that nothing drains this connection.
 * The response headers are read, which is proof the route hijacked the reply and registered the
 * stream and so makes this reliably the oldest connection; then the client stops reading and the
 * server's half is told to accept nothing, which is the state the sleeping phone eventually
 * reaches and the one the eviction defect turns on.
 */
const connectStalled = async (
  harness: LatencyHarness,
  taskId: string
): Promise<{ destroy: () => void }> => {
  const origin = new URL(harness.origin);
  const socket = net.connect(Number(origin.port), origin.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject);
    socket.once('connect', () => {
      socket.write(
        `GET /v1/tasks/${taskId}/events/stream HTTP/1.1\r\n` +
          `Host: ${origin.host}\r\n` +
          `Cookie: ${harness.cookie}\r\n` +
          `Accept: text/event-stream\r\n\r\n`
      );
      socket.once('data', () => {
        socket.pause();
        resolve();
      });
    });
  });
  socket.removeAllListeners('error');
  socket.on('error', () => undefined);
  const clientPort = socket.localPort;
  if (clientPort === undefined) throw new Error('the stalled client never bound a port');
  harness.stall(clientPort);
  return { destroy: () => socket.destroy() };
};

/**
 * Reads a stream to the end. Read to the end deliberately: stopping at the first interesting frame
 * would tear the database down under a mid-turn agent.
 */
const readStream = async (
  harness: LatencyHarness,
  taskId: string,
  sentAt: number,
  timeoutMs = 20_000
): Promise<StreamFrame[]> => {
  const stream = await connect(harness, taskId, { sentAt });
  const timer = setTimeout(() => stream.abort(), timeoutMs);
  try {
    await stream.ended;
    return stream.frames;
  } finally {
    clearTimeout(timer);
    stream.abort();
  }
};

/** Polls a condition the server controls, so a test waits on the event rather than on a duration. */
const waitFor = async (
  condition: () => boolean,
  what: string,
  timeoutMs = 60_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const withTimeout = async (work: Promise<void>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`still open after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
};

describe('how long the owner waits', () => {
  test('the first character of a reply arrives without a poll interval in front of it', async () => {
    const harness = await start(
      'I will check the agent computer, read what is there, and report back with what I find in it.'
    );
    const sentAt = performance.now();
    const taskId = await harness.send('Say something');
    const frames = await readStream(harness, taskId, sentAt);
    const firstText = frames.find(
      (frame) => frame.kind === 'assistant_delta' || frame.kind === 'assistant_message'
    );
    expect(firstText).toBeDefined();
    /**
     * Measured before this change, with the same 300 ms first byte: the first text reached the
     * client at 2087 ms, and every later frame landed on a one-second boundary, because the worker
     * polled the queue at 1 Hz and the stream re-read the table at 1 Hz. What is left is the
     * provider's own 300 ms plus the agent's flush window.
     */
    expect(firstText!.atMs).toBeLessThan(1_500);
    /**
     * The lumpiness is the other half of the complaint: before this, visible updates were either
     * simultaneous or a full second apart, never anything between. Two frames landing more than
     * 900 ms apart while text is still arriving means delivery is back on a clock.
     */
    const textFrames = frames.filter((frame) => frame.kind === 'assistant_delta');
    const gaps = textFrames.slice(1).map((frame, index) => frame.atMs - textFrames[index]!.atMs);
    expect(gaps.filter((gap) => gap > 900)).toEqual([]);
  }, 30_000);

  test('neither a send nor a first paint waits for the agent disk to be walked', async () => {
    /**
     * Measured before this was fixed, with the runner stubbed at 700 ms: bootstrap 716 ms median
     * and POST /v1/tasks 716 ms median - the walk was essentially the whole response time. On a
     * 29,000-file tree it takes 684-1279 ms.
     *
     * The property is that neither response waits for it, and that used to be checked with a
     * millisecond budget - which measures the machine as much as the server, and fails on a loaded
     * one while the property still holds. So the walk is held open across both requests instead: if
     * either one waits on it, nothing answers and this test times out. There is no threshold left
     * to be unlucky against.
     */
    const harness = await start('Answered.');
    const sentAt = performance.now();
    let taskId: string;
    harness.holdWalk();
    try {
      const bootstrap = await harness.get('/v1/bootstrap');
      expect(bootstrap.statusCode).toBe(200);
      taskId = await harness.send('Do something');
    } finally {
      harness.releaseWalk();
    }
    // Let the turn finish rather than tearing the database out from under it.
    await readStream(harness, taskId, sentAt);
  }, 30_000);
});

describe('when several devices are already watching', () => {
  test('a sixth stream takes the place of the oldest instead of being refused', async () => {
    /**
     * Five is not many for a product reachable from every device: a laptop, a phone, a tablet and
     * two tabs reach it, and a sleeping phone can hold a half-open connection well past the point
     * the owner opens the laptop. Refusing the newest connection made the device in front of them
     * the one that stopped updating, silently, because an EventSource treats a 429 as fatal.
     */
    const harness = await start('Answered.', { firstByteMs: 5_000 });
    const taskId = await harness.send('Say something');
    const opened: OpenStream[] = [];
    for (let index = 0; index < 6; index += 1) opened.push(await connect(harness, taskId));
    try {
      expect(opened.map((stream) => stream.status)).toEqual([200, 200, 200, 200, 200, 200]);
      // The oldest is closed by the server, not by the client: nobody had to notice.
      await expect(withTimeout(opened[0]!.ended, 5_000)).resolves.toBeUndefined();
      const stillOpen = await Promise.race([
        opened[5]!.ended.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('open'), 500))
      ]);
      expect(stillOpen).toBe('open');
    } finally {
      for (const stream of opened) stream.abort();
    }
  }, 30_000);
});

describe('when a device drops and comes back', () => {
  test('a reconnect with Last-Event-ID resumes with no duplicate and no hole', async () => {
    /**
     * The stated promise is replay-safe events across devices, and until this test there was
     * nothing in the tree that opened a stream, cut it, and opened it again. The two halves of
     * that promise fail in opposite directions and neither one announces itself: a cursor that
     * resumes one frame early repeats a frame, and because the client appends `assistant_delta`
     * fragments rather than replacing them, a repeat is not a flicker - it duplicates a sentence
     * in the middle of the reply. A cursor that resumes one frame late drops one, and the owner
     * reads a sentence with a hole in it and no sign that anything went missing.
     */
    const harness = await start(LONG_ANSWER, { deltaChars: 10, frameGapMs: 6 });
    const sentAt = performance.now();
    const taskId = await harness.send('Write something long');
    const first = await connect(harness, taskId, { sentAt });

    // Cut it while the reply is still being written. A stream dropped between turns has nothing to
    // resume, which is exactly why the four-frame fixture above cannot ask this question.
    await waitFor(() => first.ids().length >= 20, 'the first connection to carry twenty frames');
    first.abort();
    await first.ended;
    const beforeDrop = first.ids();
    // The last sequence this client actually parsed - not the last one the server wrote. Anything
    // the server pushed into a socket the client had already stopped reading has to come back.
    const resumeFrom = beforeDrop[beforeDrop.length - 1]!;

    const second = await connect(harness, taskId, { lastEventId: resumeFrom, sentAt });
    await withTimeout(second.ended, 60_000);
    const afterDrop = second.ids();

    // The seam itself: the reconnect resumed at the sequence immediately after the last one this
    // client had read, so nothing was repeated and nothing was skipped over the drop.
    expect(afterDrop[0]).toBe(resumeFrom + 1);
    expect(afterDrop.filter((id) => beforeDrop.includes(id))).toEqual([]);
    expect(afterDrop.length).toBeGreaterThan(0);

    /*
     * And the whole reply, across both connections, is one unbroken run from the first sequence to
     * the row that settles it.
     *
     * Only up to that row, because `appendTaskEvent` deletes every `assistant_delta` below an
     * `assistant_message` in the same transaction that writes it - the settled row carries the
     * complete text, so the fragments it was assembled from stop existing the instant it lands.
     * That is also why the table cannot be the authority for what a live stream delivered: by the
     * time the turn is over, the hundred and sixty-odd rows checked here are gone from it.
     */
    const delivered = [...first.frames, ...second.frames].filter((frame) => frame.id !== null);
    const settled = delivered.findIndex((frame) => frame.kind === 'assistant_message');
    expect(settled).toBeGreaterThan(0);
    const streamed = delivered.slice(0, settled).map((frame) => frame.id!);
    expect(streamed[0]).toBe(1);
    expect(streamed).toEqual(streamed.map((_id, index) => streamed[0]! + index));

    /*
     * The fixture is asserted too, because the fixture is the part that rots quietly. Against the
     * short reply above there is no such thing as "read twenty frames, then drop": the whole
     * exchange is four frames wide and over before a device could plausibly lose its connection in
     * the middle of it. Measured here: 2,733 provider delta frames, which the agent's 120 ms
     * flusher collapses into 167 timeline frames over about twenty seconds. The bar is set well
     * under that because the collapse ratio is a wall-clock measurement and the machine gets a
     * vote; what it catches is the answer or the cadence being shortened back to the four-frame
     * shape, which would leave everything above passing vacuously.
     */
    const deltas = delivered.filter((frame) => frame.kind === 'assistant_delta');
    expect(deltas.length).toBeGreaterThan(100);

    /*
     * The other half of replay safety, and the reason the deletion above is safe: a device that
     * comes back *after* the reply settled is not owed the fragments, because one row now carries
     * the text all of them added up to. So the trajectory it replays is short, and the fragments
     * are not in it.
     */
    const recorded = await harness.events(taskId);
    expect(recorded.filter((event) => event.kind === 'assistant_delta')).toEqual([]);
    expect(recorded.filter((event) => event.kind === 'assistant_message').length).toBe(1);
  }, 90_000);
});

describe('bounded event replay', () => {
  test('rejects malformed reconnect cursors instead of restarting the entire history', async () => {
    const harness = await start('The requested result is ready.');
    const taskId = await harness.send('Give a brief answer.');
    for (const cursor of ['not-a-sequence', 'Infinity', '-1', '1.5']) {
      const response = await realFetch(`${harness.origin}/v1/tasks/${taskId}/events/stream`, {
        headers: { cookie: harness.cookie, 'last-event-id': cursor },
        signal: AbortSignal.timeout(5000)
      });
      expect(response.status).toBe(400);
      await response.body?.cancel();
    }
    const stream = await connect(harness, taskId);
    await withTimeout(stream.ended, 30_000);
  }, 40_000);

  test('replays a long completed history in bounded reads without gaps or duplicates', async () => {
    const harness = await start('The requested result is ready.');
    const taskId = await harness.send('Give a brief answer.');
    const initial = await connect(harness, taskId);
    await withTimeout(initial.ended, 30_000);
    await harness.appendReplay(taskId, 1250);
    const replay = await connect(harness, taskId);
    await withTimeout(replay.ended, 30_000);
    const sizes = harness.readSizes();
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.some((size) => size > 0)).toBe(true);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(250);
    const recorded = await harness.events(taskId);
    expect(recorded.length).toBeGreaterThan(1250);
    expect(replay.ids()).toEqual(recorded.map((event) => event.sequence));
    expect(new Set(replay.ids()).size).toBe(replay.ids().length);
  }, 60_000);
});

describe('when a stream is evicted while events are flowing', () => {
  test('a sleeping device that loses its slot is not written to again', async () => {
    /**
     * Eviction ends a connection the server still believes is open: `close()` calls
     * `reply.raw.end()` precisely because the client has not hung up and the slot is being handed
     * to a newer device. The write loop underneath re-checks nothing, so a stream suspended in
     * `store.listTaskEvents` when another request's handler closes it wakes up and writes into a
     * finished response.
     *
     * What Node does about that was asserted rather than measured, so it was measured, on v24.18.1.
     * `write()` after `end()` never throws - it returns `false` - and what happens next depends
     * entirely on whether the ended response has finished flushing:
     *
     *   - the peer is draining: `end()` completes, the response detaches its socket and `destroyed`
     *     turns true, and the stray write is dropped in silence. Detachment happens in the tick
     *     `end()` ran in, before even a `nextTick` callback, so anything reached through an `await`
     *     is already too late to be dangerous.
     *   - the peer is not draining: `end()` cannot flush, the socket stays attached and `destroyed`
     *     stays false, and the write emits `'error'` on the response one tick later. Nothing
     *     listens, so it becomes an uncaught exception - and because that emit is a tick late, the
     *     `try`/`catch` wrapped around the write loop never sees it. In production
     *     `installProcessGuards` turns that into `process.exit(1)`: five devices watching one task,
     *     and the sixth one opening the page takes the whole API down.
     *
     * So the dangerous case is the one eviction was written for. A phone asleep with the tab open
     * drains nothing, and freeing its slot for the laptop in front of the owner is what kills the
     * server for every other device at once. Both halves of the two-line repair are in play here:
     * the `closed` re-check inside the write loop stops the write happening at all, and the
     * `'error'` listener makes the writes still left after the awaits in the same function
     * survivable rather than fatal.
     *
     * The listener registered here is so that a regression is an assertion rather than a dead
     * runner.
     */
    const uncaught: Error[] = [];
    const record = (error: Error): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', record);
    try {
      const harness = await start(LONG_ANSWER, { deltaChars: 10, frameGapMs: 6 });
      const sentAt = performance.now();
      const taskId = await harness.send('Write something long');

      // Oldest first, so this is the connection the eviction loop takes.
      const sleeping = await connectStalled(harness, taskId);
      // A device that is awake, to show the plane still works once the eviction has happened.
      const witness = await connect(harness, taskId, { sentAt });
      // Three more to fill the five slots, cursored past the end so they cost a socket and nothing
      // else - they read no rows, so the gate below never holds them.
      const fillers: OpenStream[] = [];
      for (let index = 0; index < 3; index += 1)
        fillers.push(await connect(harness, taskId, { sentAt, after: 999_999_999 }));
      await waitFor(
        () => witness.ids().length >= 5,
        'the stream to be carrying frames before anything is evicted'
      );

      // Suspend the streams that have something to write inside their event read, so the eviction
      // lands between the read and the writes it feeds rather than somewhere near it. Leaving that
      // to chance would make this a test that passes most of the time for the wrong reason.
      harness.holdEventReads();
      await waitFor(
        () => harness.heldEventReads() >= 2,
        'the sleeping and awake streams to be suspended in their event reads'
      );
      const evictor = await connect(harness, taskId, { sentAt, after: 999_999_999 });
      harness.releaseEventReads();

      // Without this the test proves nothing: a stream that woke to an empty read never reaches the
      // write, and the assertion below would be green on a connection that was never in danger.
      await waitFor(
        () => harness.heldReadRows().filter((rows) => rows > 0).length >= 2,
        'the held reads to have had rows to write when they were let go'
      );
      const carried = witness.ids().length;
      await waitFor(
        () => witness.ids().length > carried,
        'the surviving devices to keep receiving frames'
      );
      /*
       * The write the fix removes. Before it, this reads `['ERR_STREAM_WRITE_AFTER_END']`: the
       * evicted stream woke from its read holding one row and wrote it onto a response that had
       * already been ended, on a socket still attached because the sleeping peer could not take it.
       */
      expect(harness.responseErrors()).toEqual([]);
      /*
       * And the audit's claim about the consequence, which this is the first thing in the tree to
       * check. It does not hold: `reply.hijack()` leaves Fastify's own `onResFinished` listening
       * for `'error'` on the raw response, so the emit lands there instead of reaching
       * `uncaughtException` and the process guard's `exit(1)`. The stray write costs one frame to
       * one already-evicted device, not the server. This assertion is what would notice if that
       * ever stopped being true.
       */
      expect(uncaught.map(codeOf)).toEqual([]);
      expect(evictor.status).toBe(200);

      // Let the turn finish rather than tearing the database out from under it.
      await withTimeout(witness.ended, 60_000);
      sleeping.destroy();
      for (const stream of [...fillers, evictor]) stream.abort();
    } finally {
      process.off('uncaughtException', record);
    }
  }, 90_000);
});
