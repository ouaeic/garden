/**
 * The desk's stream, over a real socket: what reaches a device when one of the owner's
 * conversations changes, how often, and what never does.
 *
 * Like `event-stream.test.ts`, this binds a real listener, because a hijacked response is out of
 * `app.inject`'s reach. Unlike it, nothing here runs a model: the embedded worker is off, and every
 * change is written through the store exactly as the worker and the routes write it, so each test
 * can say precisely which write it is waiting to hear about.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@garden/contracts';
import { encryptJson, sha256, unwrapDataKey, wrapDataKey } from '@garden/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ApiConfig } from './config.js';
import { maxDeskStreamsPerUser } from './context.js';
import { DESK_FRAME_INTERVAL_MS } from './routes/desk-events.js';
import { buildServer } from './server.js';

/** Captured before any test stubs the global: the stub cannot reach the listener under test. */
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface DeskFrame {
  event: string;
  data: Record<string, unknown>;
  atMs: number;
}

interface OpenDesk {
  status: number;
  frames: DeskFrame[];
  /** The summaries this connection delivered for one conversation, in order. */
  tasks: (taskId: string) => Array<{ task: Task; moves: boolean; atMs: number }>;
  ended: Promise<void>;
  abort: () => void;
}

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Resolves to whether the promise settled within the time, without rejecting either way. */
const settlesWithin = (work: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    work.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
  ]);

const harness = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'garden-desk-stream-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  // The runner and the model feed are the only network this server reaches for, and nothing here
  // needs either to answer anything in particular.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
  );
  const config: ApiConfig = {
    DEPLOYMENT_MODE: 'development',
    MODEL_CATALOG_SCOPE: 'reviewed_open_weight',
    CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
    GARDEN_STATE_PATH: directory,
    RELAY_STATE_DIR: join(directory, 'relay'),
    RELAY_LOCAL_HOST: '127.0.0.1',
    RELAY_LOCAL_PORT: 443,
    RELAY_LOCAL_HTTP_PORT: 80,
    RELAY_LOCAL_PREVIEW_PORT: 8443,
    REGISTRATION_BOOTSTRAP_TOKEN: 'desk-stream-pairing-token-with-20-characters',
    REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
    PUBLIC_APP_URL: 'http://localhost:5173',
    PREVIEW_BASE_URL: 'http://preview.localhost:4400',
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    PREVIEW_GATEWAY_HOST: '127.0.0.1',
    PREVIEW_GATEWAY_PORT: 0,
    RESERVED_PREVIEW_PORTS: '4201,4203',
    DATABASE_DRIVER: 'pglite',
    DATABASE_URL: 'postgres://unused',
    PGLITE_PATH: join(directory, 'database'),
    DATA_MASTER_KEY: MASTER_KEY,
    SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
    RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
    WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
    PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
    WORKSPACE_IMAGE_REVISION: 'dev',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'garden Test',
    WEBAUTHN_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_DEV_AUTH: true,
    WORKER_ID: 'desk-stream-worker',
    // Off: every change in this file is a write the test makes itself, at a moment it chooses.
    EMBEDDED_WORKER: false,
    WORKER_CONCURRENCY: 1,
    WORKER_POLL_MS: 60_000,
    SCHEDULER_POLL_MS: 600_000,
    TASK_MAX_STEPS: 3,
    TASK_MAX_SELF_CONTINUATIONS: 0,
    SECURITY_EVENT_RETENTION_DAYS: 30,
    LOG_LEVEL: 'silent',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    AI_PROVIDER: 'openrouter',
    AI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    AI_REQUIRE_ZDR: true,
    AI_FORCE_INHOUSE_WEB: false,
    ALLOW_INSECURE_PROVIDER_URLS: false,
    CONNECTOR_ALLOWED_HOST_SUFFIXES: 'webdav.example',
    PUSH_VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
    PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com'
  };
  const { app, previewApp, store, database } = await buildServer(config);
  disposers.push(async () => {
    await app.close().catch(() => undefined);
    await previewApp.close().catch(() => undefined);
    await database.close().catch(() => undefined);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('The API did not bind a port');
  const origin = `http://127.0.0.1:${address.port}`;

  const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
  if (!cookie) throw new Error('dev sign-in returned no session cookie');
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
  const userId = me.json<{ user: { id: string } }>().user.id;
  const created = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: { cookie, 'idempotency-key': 'desk-stream-workspace-1' },
    payload: { name: 'Desk' }
  });
  if (created.statusCode !== 200) throw new Error(`workspace: ${created.body}`);
  const workspaceId = created.json<{ id: string }>().id;
  const workspace = (await store.listWorkspaces(userId)).find((row) => row.id === workspaceId);
  if (!workspace?.wrappedKey) throw new Error('the new workspace has no wrapped key');
  const key = unwrapDataKey(workspace.wrappedKey, Buffer.from(MASTER_KEY, 'base64'), workspaceId);

  /** A conversation on the owner's computer, named so its frames can be told apart. */
  const conversation = async (title: string, owner = { userId, workspaceId, key }) => {
    const task = await store.createTask({
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      titleCiphertext: encryptJson({ title }, owner.key, `task-title:${owner.workspaceId}`),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson(
        { prompt: title },
        owner.key,
        `task-prompt:${owner.workspaceId}`
      )
    });
    return task.id;
  };

  /** Somebody else on the same box, with a computer and a conversation of their own. */
  const stranger = async () => {
    const other = await store.createUser({ username: 'stranger', displayName: 'Stranger' });
    const id = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf9';
    const otherKey = Buffer.alloc(32, 4);
    await store.createWorkspace({
      id,
      userId: other.id,
      name: 'Elsewhere',
      storageLimitBytes: 1e9,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: wrapDataKey(otherKey, Buffer.from(MASTER_KEY, 'base64'), id)
    });
    return conversation('Not yours', { userId: other.id, workspaceId: id, key: otherKey });
  };

  const opened: OpenDesk[] = [];
  disposers.push(async () => {
    for (const desk of opened) desk.abort();
  });

  /** Opens the desk's stream over real HTTP and parses frames as they arrive. */
  const connect = async (headers: Record<string, string> = { cookie }): Promise<OpenDesk> => {
    const controller = new AbortController();
    const openedAt = performance.now();
    const response = await realFetch(`${origin}/v1/events/stream`, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: controller.signal
    });
    const frames: DeskFrame[] = [];
    const ended = (async () => {
      if (!response.body) return;
      const reader = response.body.getReader();
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
          const lines = buffer.slice(0, split).split('\n');
          buffer = buffer.slice(split + 2);
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
          const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
          if (data)
            frames.push({
              event,
              data: JSON.parse(data) as Record<string, unknown>,
              atMs: performance.now() - openedAt
            });
          split = buffer.indexOf('\n\n');
        }
      }
    })();
    const desk: OpenDesk = {
      status: response.status,
      frames,
      tasks: (taskId) =>
        frames.flatMap((frame) => {
          const task = frame.data.task as Task | undefined;
          return frame.event === 'task' && task?.id === taskId
            ? [{ task, moves: frame.data.moves === true, atMs: frame.atMs }]
            : [];
        }),
      ended,
      abort: () => controller.abort()
    };
    opened.push(desk);
    return desk;
  };

  return {
    app,
    store,
    database,
    origin,
    cookie,
    userId,
    workspaceId,
    conversation,
    stranger,
    connect,
    /** The conversation exactly as the bootstrap lists it, for comparing a frame against. */
    listed: async (taskId: string): Promise<Task | undefined> => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/bootstrap',
        headers: { cookie }
      });
      if (response.statusCode !== 200) throw new Error(`bootstrap: ${response.body}`);
      return response.json<{ tasks: Task[] }>().tasks.find((task) => task.id === taskId);
    },
    token: async (scopes: Array<'tasks:read' | 'workspaces:read'>): Promise<string> => {
      const token = `oc_live_${randomBytes(32).toString('base64url')}`;
      await store.createApiToken({
        userId,
        label: scopes.join(' '),
        tokenHash: sha256(token),
        prefix: token.slice(0, 12),
        scopes,
        expiresAt: new Date(Date.now() + 600_000)
      });
      return `Bearer ${token}`;
    }
  };
};

describe('what reaches the desk', () => {
  test('a change arrives as the summary the bootstrap lists, without a poll in front of it', async () => {
    const desk = await harness();
    const taskId = await desk.conversation('Tax return');
    const stream = await desk.connect();
    expect(stream.status).toBe(200);

    const wroteAt = performance.now();
    await desk.store.appendTaskEvent({ taskId, kind: 'status', summary: 'Agent started work' });
    await waitFor(() => stream.tasks(taskId).length > 0, 'the first frame');
    const [first] = stream.tasks(taskId);
    // A poll would put up to its whole interval between the write and the device; what is left is
    // the stream's own settle and one read.
    expect(performance.now() - wroteAt).toBeLessThan(1_500);
    // The first word about a conversation always says the moves may have moved with it: this
    // stream cannot know what the device last read.
    expect(first!.moves).toBe(true);
    expect(first!.task).toEqual(await desk.listed(taskId));
    expect(first!.task.title).toBe('Tax return');
  }, 30_000);

  test('a streamed reply does not flood it, and the last write still arrives', async () => {
    const desk = await harness();
    const taskId = await desk.conversation('Long answer');
    const stream = await desk.connect();
    await desk.store.leaseNextTask('desk-stream-worker');

    // Deltas change nothing a list shows; the checkpoints between them do, each one a different
    // credit count. Both arrive faster than a frame is allowed to. The count, not the timestamp,
    // is what tells the frames apart: `updatedAt` is kept to the second.
    const startedAt = performance.now();
    let credits = 0;
    for (let index = 0; index < 60; index += 1) {
      await desk.store.appendTaskEvent({
        taskId,
        kind: 'assistant_delta',
        summary: `Part ${index}`
      });
      if (index % 6 === 0)
        await desk.store.updateTask({
          id: taskId,
          workerId: 'desk-stream-worker',
          status: 'running',
          actualComputeCredits: (credits += 0.25)
        });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const writingMs = performance.now() - startedAt;
    await waitFor(
      () => stream.tasks(taskId).at(-1)?.task.actualComputeCredits === credits,
      'the frame carrying the last write'
    );
    const frames = stream.tasks(taskId);
    expect(frames.length).toBeGreaterThan(1);
    // Ten status writes and sixty deltas, and at most one frame per window: the bound is the
    // window count, not the write count.
    expect(frames.length).toBeLessThanOrEqual(Math.ceil(writingMs / DESK_FRAME_INTERVAL_MS) + 2);
    const gaps = frames.slice(1).map((frame, index) => frame.atMs - frames[index]!.atMs);
    // A little under the window, for timer slack on a loaded machine; two frames inside one
    // window would be a gap near zero.
    expect(Math.min(...gaps)).toBeGreaterThan(DESK_FRAME_INTERVAL_MS * 0.8);
  }, 30_000);

  test('a status written after the last event still reaches it', async () => {
    const desk = await harness();
    const taskId = await desk.conversation('Finishing');
    const stream = await desk.connect();
    await desk.store.leaseNextTask('desk-stream-worker');
    await desk.store.updateTask({ id: taskId, workerId: 'desk-stream-worker', status: 'running' });
    // The worker's order: the event that says it finished, and only then the status.
    await desk.store.appendTaskEvent({ taskId, kind: 'completed', summary: 'Task completed' });
    await waitFor(() => stream.tasks(taskId).length > 0, 'the frame for the completed event');
    await new Promise((resolve) => setTimeout(resolve, DESK_FRAME_INTERVAL_MS));
    expect(stream.tasks(taskId).at(-1)?.task.status).toBe('running');
    await desk.store.completeTaskIfNoQueued({
      id: taskId,
      workerId: 'desk-stream-worker',
      actualComputeCredits: 0,
      agentStateCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    await waitFor(
      () => stream.tasks(taskId).at(-1)?.task.status === 'completed',
      'the frame that says it finished'
    );
  }, 30_000);

  test('says the moves may have changed only when what the moves read has', async () => {
    const desk = await harness();
    const taskId = await desk.conversation('Asks');
    const stream = await desk.connect();
    const next = async (write: () => Promise<unknown>): Promise<boolean> => {
      const before = stream.tasks(taskId).length;
      await write();
      await waitFor(() => stream.tasks(taskId).length > before, 'the next frame');
      // Past the window, so the next write's frame cannot be folded into this one.
      await new Promise((resolve) => setTimeout(resolve, DESK_FRAME_INTERVAL_MS + 50));
      return stream.tasks(taskId).at(-1)!.moves;
    };
    const status = (value: string) => () => desk.store.updateTask({ id: taskId, status: value });
    const pin = (pinned: boolean) => () =>
      desk.store.updateTaskFiling(desk.userId, taskId, { pinned });

    expect(await next(status('running'))).toBe(true);
    // Running and pinned or not, nothing here is waiting on the owner.
    expect(await next(pin(true))).toBe(false);
    expect(await next(status('awaiting_user'))).toBe(true);
    // Filing it does not change what it is asking.
    expect(await next(pin(false))).toBe(false);
    expect(await next(status('running'))).toBe(true);
  }, 30_000);
});

describe('what never reaches the desk', () => {
  test('another owner’s conversation is neither sent nor asked about twice', async () => {
    const desk = await harness();
    const theirs = await desk.stranger();
    const mine = await desk.conversation('Mine');
    const asked: string[] = [];
    const read = desk.store.getTaskListing.bind(desk.store);
    // The route looks the method up on every read, so an own property sees every one of them.
    desk.store.getTaskListing = async (userId, taskId) => {
      asked.push(taskId);
      return read(userId, taskId);
    };
    const stream = await desk.connect();

    // Spaced past the window, so only the stream's memory of whose it is can save the re-reads.
    for (let index = 0; index < 4; index += 1) {
      await desk.store.appendTaskEvent({
        taskId: theirs,
        kind: 'status',
        summary: `Theirs ${index}`
      });
      await new Promise((resolve) => setTimeout(resolve, DESK_FRAME_INTERVAL_MS + 50));
    }
    // A change of the owner's own, as the fence: once it has arrived, so has anything before it.
    await desk.store.appendTaskEvent({ taskId: mine, kind: 'status', summary: 'Mine' });
    await waitFor(() => stream.tasks(mine).length > 0, 'the owner’s own frame');

    expect(asked.filter((taskId) => taskId === theirs)).toHaveLength(1);
    expect(JSON.stringify(stream.frames)).not.toContain(theirs);
  }, 30_000);

  test('a conversation that is deleted is reported gone, once', async () => {
    const desk = await harness();
    const taskId = await desk.conversation('Short-lived');
    const stream = await desk.connect();
    await desk.store.appendTaskEvent({ taskId, kind: 'status', summary: 'Here' });
    await waitFor(() => stream.tasks(taskId).length > 0, 'the frame before deletion');
    expect(await desk.store.deleteTask(desk.userId, taskId)).toBe(true);
    await waitFor(
      () => stream.frames.some((frame) => frame.event === 'removed'),
      'the frame that says it is gone'
    );
    expect(stream.frames.filter((frame) => frame.event === 'removed')).toEqual([
      expect.objectContaining({ data: { taskId } })
    ]);
  }, 30_000);
});

describe('who may hold it, and how many', () => {
  test('a full house closes the oldest desk and leaves the transcript streams alone', async () => {
    const desk = await harness();
    const taskId = await desk.conversation('Watched');
    const watching = new AbortController();
    // Popped before the server closes, which would otherwise wait on this connection for ever.
    disposers.push(async () => watching.abort());
    const transcript = await realFetch(`${desk.origin}/v1/tasks/${taskId}/events/stream`, {
      headers: { cookie: desk.cookie, accept: 'text/event-stream' },
      signal: watching.signal
    });
    expect(transcript.status).toBe(200);
    const transcriptEnded = (async () => {
      const reader = transcript.body!.getReader();
      for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
    })();

    const desks: OpenDesk[] = [];
    for (let index = 0; index <= maxDeskStreamsPerUser; index += 1)
      desks.push(await desk.connect());
    expect(desks.map((stream) => stream.status)).toEqual(
      Array.from({ length: maxDeskStreamsPerUser + 1 }, () => 200)
    );
    // The server closes the oldest; nobody had to notice it was asleep.
    expect(await settlesWithin(desks[0]!.ended, 5_000)).toBe(true);
    expect(await settlesWithin(desks.at(-1)!.ended, 300)).toBe(false);
    expect(await settlesWithin(transcriptEnded, 300)).toBe(false);
    // And the newest still hears the desk.
    await desk.store.appendTaskEvent({ taskId, kind: 'status', summary: 'Still here' });
    await waitFor(() => desks.at(-1)!.tasks(taskId).length > 0, 'a frame on the newest desk');
  }, 30_000);

  test('a bearer token reads it under the scope the transcript stream asks for', async () => {
    const desk = await harness();
    const taskId = await desk.conversation('Scoped');
    const reader = await desk.token(['tasks:read']);
    const outsider = await desk.token(['workspaces:read']);
    for (const path of ['/v1/events/stream', `/v1/tasks/${taskId}/events/stream`]) {
      const refused = await realFetch(`${desk.origin}${path}`, {
        headers: { authorization: outsider }
      });
      expect(refused.status).toBe(403);
      await refused.body?.cancel();
    }
    const stream = await desk.connect({ authorization: reader });
    expect(stream.status).toBe(200);
    await desk.store.appendTaskEvent({ taskId, kind: 'status', summary: 'Heard' });
    await waitFor(() => stream.tasks(taskId).length > 0, 'a frame for the token');
  }, 30_000);

  test('a session signed out elsewhere stops hearing the desk', async () => {
    const desk = await harness();
    const taskId = await desk.conversation('Private');
    const stream = await desk.connect();
    await desk.store.appendTaskEvent({ taskId, kind: 'status', summary: 'Before' });
    await waitFor(() => stream.tasks(taskId).length > 0, 'a frame while signed in');
    const before = stream.frames.length;

    const signedOut = await desk.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: desk.cookie, origin: 'http://localhost:5173' }
    });
    expect(signedOut.statusCode).toBeLessThan(300);
    // Only the clock is moved, so the recheck is due on the next change rather than in half a
    // minute; the timers that pace the stream stay real.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31_000 });
    await desk.store.appendTaskEvent({ taskId, kind: 'status', summary: 'After' });
    expect(await settlesWithin(stream.ended, 5_000)).toBe(true);
    expect(stream.frames).toHaveLength(before);
  }, 30_000);
});
