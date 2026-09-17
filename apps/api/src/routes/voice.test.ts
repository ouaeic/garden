import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, DataStore, migrateDatabase, VoiceStore } from '@athanor/data';
import { encryptJson, sha256, wrapDataKey } from '@athanor/core';
import type {
  VoiceConnection,
  VoiceModels,
  VoiceSession,
  VoiceWorkProposal
} from '@athanor/contracts';
import { encodeVoiceFrame } from '@athanor/model-gateway';
import type { RouteContext } from '../http/server-context.js';
import { registerVoiceRoutes } from './voice.js';
class Provider extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit('close'));
  }
  terminate() {
    this.close();
  }
  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }
  event(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)), false);
  }
}
const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
  store = new DataStore(database),
  voice = new VoiceStore(database),
  masterKey = Buffer.alloc(32, 9),
  key = Buffer.alloc(32, 7),
  apps: FastifyInstance[] = [];
beforeAll(async () => migrateDatabase(database));
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllGlobals();
});
afterAll(async () => database.close());
async function fixture() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' }),
    workspaceId = randomUUID(),
    token = randomUUID();
  await store.createSession(user.id, sha256(token), new Date(Date.now() + 60_000));
  await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Work',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: wrapDataKey(key, masterKey, workspaceId)
  });
  await store.updateWorkspaceStatus(workspaceId, 'running');
  const sealed = encryptJson({ prompt: 'Begin' }, key, 'test');
  const task = await store.createTask({
    userId: user.id,
    workspaceId,
    modelId: 'task-model',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 4,
    maxSpendUsd: 5,
    titleCiphertext: sealed,
    promptCiphertext: sealed,
    nameIndex: { nameTokens: '', openingTokens: '' }
  });
  await database.query("UPDATE tasks SET status='running' WHERE id=$1", [task.id]);
  const secret = {
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'owner-native-key',
    enforceZeroDataRetention: true
  };
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ data: [{ id: 'gpt-realtime-2.1-mini' }] }))
  );
  vi.stubGlobal('fetch', fetch);
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  app.decorateRequest('user', null);
  app.decorateRequest('apiToken', null);
  app.addHook('onRequest', async (request) => {
    request.user = request.cookies.athanor_session === token ? user : null;
    request.apiToken = request.headers['x-token'] ? ({} as never) : null;
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as { statusCode?: number; code?: string; message: string };
    void reply.status(e.statusCode ?? 400).send({ error: { code: e.code, message: e.message } });
  });
  const providers: Provider[] = [];
  const context = {
    app,
    store,
    database,
    masterKey,
    secure: false,
    config: { PUBLIC_APP_URL: 'https://garden.example', TASK_MAX_STEPS: 20 },
    inferenceCredential: async () => ({ secret }),
    modelsForUser: async () => [
      {
        id: 'task-model',
        displayName: 'Task model',
        usageClass: 'medium',
        availability: 'available',
        privacyRoute: 'provider_zdr'
      }
    ],
    privateTaskResponse: async (value: unknown) => value,
    computeAllowanceFor: () => 50
  } as unknown as RouteContext;
  await registerVoiceRoutes(context, {
    providerFactory: () => {
      const provider = new Provider();
      providers.push(provider);
      queueMicrotask(() => provider.open());
      return provider as unknown as WebSocket;
    }
  });
  await app.ready();
  const headers = { cookie: `athanor_session=${token}`, origin: 'https://garden.example' };
  const models = (await app.inject({ url: '/v1/voice/models', headers })).json<VoiceModels>();
  const selection = {
    modelId: models.options[0]!.id,
    voice: 'marin',
    reasoningEffort: 'low',
    privacyRoute: 'provider_zdr',
    maxSpendUsd: 3,
    lifetimeSeconds: 60,
    expectedRouteProof: models.options[0]!.routeProof
  };
  const start = (
    requestKey = randomUUID(),
    body: unknown = selection,
    customHeaders: Record<string, string> = headers
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.id}/voice-sessions`,
      headers: { ...customHeaders, 'idempotency-key': requestKey },
      payload: body as never
    });
  const connect = async (connection: VoiceConnection) => {
    const socket = await app.injectWS(connection.socketPath, { headers });
    const events: Record<string, unknown>[] = [],
      binary: Buffer[] = [];
    socket.on('message', (data, isBinary) => {
      if (isBinary) binary.push(Buffer.from(data as Buffer));
      else
        events.push(
          JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as Record<string, unknown>
        );
    });
    socket.send(JSON.stringify({ type: 'ticket', ticket: connection.ticket }));
    await vi.waitFor(() => expect(providers).toHaveLength(1));
    const provider = providers[0]!;
    await vi.waitFor(() => expect(provider.sent[0]?.type).toBe('session.update'));
    provider.event({ type: 'session.updated', session: provider.sent[0]!.session });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'ready')).toBe(true));
    return { socket, provider, events, binary };
  };
  return {
    app,
    user,
    task,
    token,
    headers,
    models,
    selection,
    secret,
    start,
    connect,
    providers,
    fetch
  };
}
const created = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const result = await f.start();
  expect(result.statusCode, result.body).toBe(200);
  return result.json<VoiceConnection>();
};
async function begin(
  connection: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['connect']>>
) {
  const previous = connection.provider.sent.filter((e) => e.type === 'input_audio_buffer.append');
  const offset = previous.reduce(
    (n, e) => n + Buffer.from(e.audio as string, 'base64').length / 2,
    0
  );
  connection.socket.send(encodeVoiceFrame(1, offset, new Uint8Array(480)));
  await vi.waitFor(() =>
    expect(
      connection.provider.sent.filter((e) => e.type === 'input_audio_buffer.append')
    ).toHaveLength(previous.length + 1)
  );
  connection.provider.event({ type: 'input_audio_buffer.committed' });
  await vi.waitFor(() =>
    expect(connection.provider.sent.some((e) => e.type === 'response.create')).toBe(true)
  );
  connection.provider.event({ type: 'response.created', response: { id: 'resp_one' } });
}
const usage = {
  input_tokens: 100,
  output_tokens: 10,
  total_tokens: 110,
  input_token_details: {
    text_tokens: 90,
    audio_tokens: 10,
    cached_tokens: 0,
    cached_tokens_details: { text_tokens: 0, audio_tokens: 0 }
  },
  output_token_details: { text_tokens: 2, audio_tokens: 8 }
};
describe('live voice owner route and provider loop', () => {
  it('rechecks a lost POST response replay without creating another ticket or bypassing current headroom', async () => {
    const f = await fixture(),
      requestKey = randomUUID();
    const initial = await f.start(requestKey);
    expect(initial.statusCode).toBe(200);
    const connection = initial.json<VoiceConnection>();
    await database.query('UPDATE tasks SET max_spend_usd=0.25 WHERE id=$1', [f.task.id]);
    const denied = await f.start(requestKey);
    expect(denied.statusCode).toBe(402);
    expect(denied.json()).toMatchObject({ error: { code: 'voice_budget_unavailable' } });
    expect(f.providers).toHaveLength(0);
    expect((await voice.list(f.user.id, f.task.id)).map((session) => session.id)).toEqual([
      connection.session.id
    ]);
    expect(
      (await database.query('SELECT id FROM usage_entries WHERE user_id=$1', [f.user.id])).rows
    ).toEqual([]);
    await database.query('UPDATE tasks SET max_spend_usd=5 WHERE id=$1', [f.task.id]);
    f.secret.apiKey = 'rotated-after-prepare';
    const replay = await f.start(requestKey);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(connection);
  });
  it('rejects an unaffordable task or account before issuing a ticket or opening the provider', async () => {
    const f = await fixture();
    await database.query('UPDATE tasks SET max_spend_usd=0.25 WHERE id=$1', [f.task.id]);
    const denied = await f.start();
    expect(denied.statusCode).toBe(402);
    expect(denied.json()).toMatchObject({
      error: {
        code: 'voice_budget_unavailable'
      }
    });
    expect(denied.json<{ error: { message: string } }>().error.message).toMatch(
      /held capacity.*0\.2500 is available.*task and its related work/
    );
    expect(f.providers).toHaveLength(0);
    expect(await voice.list(f.user.id, f.task.id)).toEqual([]);
    expect(
      (await database.query('SELECT id FROM usage_entries WHERE user_id=$1', [f.user.id])).rows
    ).toEqual([]);
    expect((await store.getTask(f.user.id, f.task.id))?.maxSpendUsd).toBe(0.25);
    await database.query('UPDATE tasks SET max_spend_usd=5 WHERE id=$1', [f.task.id]);
    await store.setSpendLimits({ userId: f.user.id, monthlyCapUsd: 1 });
    const accountDenied = await f.start();
    expect(accountDenied.statusCode).toBe(402);
    expect(accountDenied.json()).toMatchObject({
      error: {
        code: 'voice_budget_unavailable'
      }
    });
    expect(accountDenied.json<{ error: { message: string } }>().error.message).toContain(
      'monthly account window'
    );
    expect(f.providers).toHaveLength(0);
    expect(await voice.list(f.user.id, f.task.id)).toEqual([]);
  });
  it('rechecks current headroom after asynchronous authority reads and before opening the provider socket', async () => {
    const f = await fixture(),
      connection = await created(f);
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = store.getSession.bind(store);
    const auth = vi.spyOn(store, 'getSession').mockImplementationOnce(async (...args) => {
      entered();
      await blocked;
      return original(...args);
    });
    try {
      const socket = await f.app.injectWS(connection.socketPath, { headers: f.headers });
      const events: Array<{ type: string; code?: string; message?: string }> = [];
      socket.on('message', (data) =>
        events.push(
          JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as {
            type: string;
            code?: string;
            message?: string;
          }
        )
      );
      socket.send(JSON.stringify({ type: 'ticket', ticket: connection.ticket }));
      await observed;
      await database.query('UPDATE tasks SET max_spend_usd=0.25 WHERE id=$1', [f.task.id]);
      release();
      await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
      expect(f.providers).toHaveLength(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'error',
          code: 'voice_budget_unavailable'
        })
      );
      expect(events.find((event) => event.code === 'voice_budget_unavailable')?.message).toContain(
        '0.2500 is available'
      );
      expect(events.some((event) => event.type === 'ready')).toBe(false);
      expect(await voice.pending(f.user.id, connection.session.id)).toEqual([]);
    } finally {
      release();
      auth.mockRestore();
    }
  });
  it('replays one sealed ticket before credential discovery and blocks changed selections and automation tokens', async () => {
    const f = await fixture(),
      idempotencyKey = randomUUID(),
      first = await f.start(idempotencyKey);
    expect(first.statusCode, first.body).toBe(200);
    const connection = first.json<VoiceConnection>();
    f.secret.apiKey = 'rotated';
    const retry = await f.start(idempotencyKey);
    expect(retry.json()).toEqual(connection);
    expect(f.providers).toHaveLength(0);
    expect((await f.start(idempotencyKey, { ...f.selection, voice: 'cedar' })).statusCode).toBe(
      409
    );
    expect(
      (await f.start(randomUUID(), f.selection, { ...f.headers, 'x-token': 'yes' })).statusCode
    ).toBe(403);
    const rows = await database.query(
      'SELECT configuration,connection FROM voice_sessions WHERE id=$1',
      [connection.session.id]
    );
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toContain('owner-native-key');
    expect(JSON.stringify(rows.rows)).not.toContain(connection.ticket);
  });
  it('requires matching price/retention review, caps and the exact browser ticket before opening the provider', async () => {
    const f = await fixture();
    expect(
      (await f.start(randomUUID(), { ...f.selection, expectedRouteProof: 'wrong' })).statusCode
    ).toBe(409);
    expect(
      (await f.start(randomUUID(), { ...f.selection, privacyRoute: 'external' })).statusCode
    ).toBe(409);
    expect((await f.start(randomUUID(), { ...f.selection, maxSpendUsd: 0.0001 })).statusCode).toBe(
      402
    );
    const connection = await created(f),
      socket = await f.app.injectWS(connection.socketPath, {
        headers: { ...f.headers, origin: 'https://other.example' }
      });
    socket.send(JSON.stringify({ type: 'ticket', ticket: connection.ticket }));
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
    expect(f.providers).toHaveLength(0);
    expect((await voice.get(f.user.id, connection.session.id))?.session.status).toBe('preparing');
  });
  it('waits for configuration acknowledgment then reserves before response, settles exact usage and ends cleanly', async () => {
    const f = await fixture(),
      connection = await created(f),
      c = await f.connect(connection);
    expect(c.events[0]).toMatchObject({
      type: 'ready',
      session: { status: 'listening' },
      inputEpoch: 1
    });
    c.socket.send(encodeVoiceFrame(1, 0, new Uint8Array(480)));
    await vi.waitFor(() =>
      expect(c.provider.sent.some((e) => e.type === 'input_audio_buffer.append')).toBe(true)
    );
    await begin(c);
    await vi.waitFor(async () =>
      expect(await voice.pending(f.user.id, connection.session.id)).toEqual([
        expect.objectContaining({ providerResponseId: 'resp_one' })
      ])
    );
    c.provider.event({
      type: 'response.output_audio.delta',
      response_id: 'resp_one',
      item_id: 'item_one',
      delta: Buffer.alloc(480).toString('base64')
    });
    c.provider.event({
      type: 'response.output_audio_transcript.delta',
      response_id: 'resp_one',
      item_id: 'item_one',
      delta: 'Hello'
    });
    c.provider.event({
      type: 'response.output_audio_transcript.delta',
      response_id: 'resp_one',
      item_id: 'item_one',
      delta: ' owner'
    });
    c.provider.event({ type: 'response.done', response: { id: 'resp_one', usage } });
    await vi.waitFor(() =>
      expect(c.events.filter((e) => e.type === 'transcript').at(-1)).toMatchObject({
        text: 'Hello owner'
      })
    );
    expect(c.binary).toHaveLength(1);
    await vi.waitFor(async () =>
      expect((await voice.get(f.user.id, connection.session.id))?.session).toMatchObject({
        status: 'listening',
        pendingUsd: 0
      })
    );
    const ended = await f.app.inject({
      method: 'POST',
      url: `/v1/tasks/${f.task.id}/voice-sessions/${connection.session.id}/stop`,
      headers: f.headers
    });
    expect(ended.json<VoiceSession>()).toMatchObject({ status: 'ended', cleanupPending: false });
    expect(c.provider.readyState).toBe(WebSocket.CLOSED);
  });
  it('creates a sealed proposal without enqueuing and confirms its exact prompt and unchanged task budget once', async () => {
    const f = await fixture(),
      connection = await created(f),
      c = await f.connect(connection);
    await begin(c);
    c.provider.event({
      type: 'response.function_call_arguments.done',
      response_id: 'resp_one',
      name: 'request_task_work',
      call_id: 'call_one',
      arguments: JSON.stringify({ prompt: 'Review the current result' })
    });
    await vi.waitFor(() => expect(c.events.some((e) => e.type === 'proposal')).toBe(true));
    const proposal = c.events.find((e) => e.type === 'proposal')!.proposal as VoiceWorkProposal;
    expect(
      (await database.query('SELECT id FROM task_message_queue WHERE task_id=$1', [f.task.id])).rows
    ).toHaveLength(0);
    const url = `/v1/voice-sessions/${connection.session.id}/proposals/${proposal.id}/confirm`;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: f.headers,
          payload: { digest: 'wrong' }
        })
      ).statusCode
    ).toBe(404);
    const result = await f.app.inject({
      method: 'POST',
      url,
      headers: f.headers,
      payload: { digest: proposal.digest }
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json<VoiceWorkProposal>()).toMatchObject({
      status: 'confirmed',
      prompt: 'Review the current result'
    });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: f.headers,
          payload: { digest: proposal.digest }
        })
      ).json()
    ).toEqual(result.json());
    const queued = (
      await database.query(
        'SELECT max_compute_credits,max_spend_usd FROM task_message_queue WHERE task_id=$1',
        [f.task.id]
      )
    ).rows;
    expect(queued).toEqual([{ max_compute_credits: 0, max_spend_usd: null }]);
    const stored = await database.query('SELECT ciphertext FROM voice_proposals WHERE id=$1', [
      proposal.id
    ]);
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain(proposal.prompt);
  });
  it('streams a detailed answer and interrupts before any late proposal or output', async () => {
    const f = await fixture(),
      connection = await created(f),
      c = await f.connect(connection);
    await begin(c);
    for (let batch = 0; batch < 6; batch++) {
      c.provider.event({
        type: 'response.output_audio.delta',
        response_id: 'resp_one',
        item_id: 'item_one',
        delta: Buffer.alloc(24_000 * 5 * 2).toString('base64')
      });
      await vi.waitFor(() => expect(c.binary).toHaveLength((batch + 1) * 50));
    }
    expect(c.events.some((event) => event.type === 'flush')).toBe(false);
    expect(c.provider.sent.some((event) => event.type === 'response.cancel')).toBe(false);
    c.socket.send(JSON.stringify({ type: 'interrupt', epoch: 1, playedSamples: 24_000 * 8 }));
    await vi.waitFor(() =>
      expect(c.provider.sent).toContainEqual(
        expect.objectContaining({ type: 'conversation.item.truncate', audio_end_ms: 8_000 })
      )
    );
    c.provider.event({
      type: 'response.function_call_arguments.done',
      response_id: 'resp_one',
      name: 'request_task_work',
      call_id: 'cancelled-proposal',
      arguments: JSON.stringify({ prompt: 'This late proposal must not be saved.' })
    });
    c.provider.event({
      type: 'response.output_audio.delta',
      response_id: 'resp_one',
      item_id: 'late-item',
      delta: Buffer.alloc(480).toString('base64')
    });
    const detailedUsage = {
      ...usage,
      output_tokens: 2_048,
      total_tokens: 2_148,
      output_token_details: { text_tokens: 48, audio_tokens: 2_000 }
    };
    c.provider.event({ type: 'response.done', response: { id: 'resp_one', usage: detailedUsage } });
    await vi.waitFor(async () =>
      expect((await voice.get(f.user.id, connection.session.id))?.session).toMatchObject({
        status: 'listening',
        pendingUsd: 0
      })
    );
    expect(await voice.proposals(f.user.id, connection.session.id)).toEqual([]);
    expect(c.binary).toHaveLength(300);
    expect(c.provider.sent.filter((event) => event.type === 'response.create')).toHaveLength(1);
  });
  it('cancels an interrupted reserved response even when its provider id arrives after speech starts', async () => {
    const f = await fixture(),
      connection = await created(f),
      c = await f.connect(connection);
    c.socket.send(encodeVoiceFrame(1, 0, new Uint8Array(480)));
    await vi.waitFor(() =>
      expect(c.provider.sent.some((e) => e.type === 'input_audio_buffer.append')).toBe(true)
    );
    c.provider.event({ type: 'input_audio_buffer.committed' });
    await vi.waitFor(() =>
      expect(c.provider.sent.some((e) => e.type === 'response.create')).toBe(true)
    );
    c.provider.event({ type: 'input_audio_buffer.speech_started' });
    c.provider.event({ type: 'response.created', response: { id: 'late-response' } });
    await vi.waitFor(() =>
      expect(c.provider.sent).toContainEqual({
        type: 'response.cancel',
        response_id: 'late-response'
      })
    );
    c.provider.event({ type: 'response.done', response: { id: 'late-response', usage } });
    await vi.waitFor(async () =>
      expect(await voice.pending(f.user.id, connection.session.id)).toEqual([])
    );
    expect(c.provider.sent.filter((event) => event.type === 'response.create')).toHaveLength(1);
    expect(c.events.filter((event) => event.type === 'audio_start')).toEqual([]);
  });
  it('flushes only the played prefix, holds a lost receipt and recovers it from an owner invoice without another provider call', async () => {
    const f = await fixture(),
      connection = await created(f),
      c = await f.connect(connection);
    await begin(c);
    c.provider.event({
      type: 'response.output_audio.delta',
      response_id: 'resp_one',
      item_id: 'item_one',
      delta: Buffer.alloc(480).toString('base64')
    });
    await vi.waitFor(() => expect(c.binary).toHaveLength(1));
    c.socket.send(JSON.stringify({ type: 'interrupt', epoch: 1, playedSamples: 120 }));
    await vi.waitFor(() =>
      expect(
        c.provider.sent.some((e) => e.type === 'conversation.item.truncate' && e.audio_end_ms === 5)
      ).toBe(true)
    );
    c.provider.close();
    await vi.waitFor(async () =>
      expect((await voice.get(f.user.id, connection.session.id))?.session).toMatchObject({
        status: 'usage_uncertain',
        cleanupPending: false
      })
    );
    const receipt = (await voice.pending(f.user.id, connection.session.id))[0]!;
    const result = await f.app.inject({
      method: 'POST',
      url: `/v1/voice-sessions/${connection.session.id}/reconcile`,
      headers: f.headers,
      payload: { receiptId: receipt.id, costUsd: 0.003, providerReceiptRef: 'invoice-private' }
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ status: 'ended', settledUsd: 0.003, pendingUsd: 0 });
    expect(f.providers).toHaveLength(1);
    const rows = await database.query('SELECT receipt FROM voice_responses WHERE id=$1', [
      receipt.id
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toContain('invoice-private');
  });
  it('rejects a provider configuration that can respond without a reservation before enabling the microphone', async () => {
    const f = await fixture(),
      connection = await created(f),
      socket = await f.app.injectWS(connection.socketPath, { headers: f.headers });
    const events: string[] = [];
    socket.on('message', (data) => events.push(Buffer.from(data as Buffer).toString('utf8')));
    socket.send(JSON.stringify({ type: 'ticket', ticket: connection.ticket }));
    await vi.waitFor(() => expect(f.providers[0]?.sent[0]?.type).toBe('session.update'));
    const provider = f.providers[0]!,
      session = structuredClone(provider.sent[0]!.session) as Record<string, unknown>;
    session.max_output_tokens = 'inf';
    provider.event({ type: 'session.updated', session });
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
    expect(events.some((event) => (JSON.parse(event) as { type: string }).type === 'ready')).toBe(
      false
    );
    expect(provider.sent.filter((event) => event.type === 'response.create')).toHaveLength(0);
    expect((await voice.get(f.user.id, connection.session.id))?.session).toMatchObject({
      status: 'lost',
      pendingUsd: 0
    });
  });
  it('refuses browser provider controls and stale input frames without forwarding them', async () => {
    const f = await fixture(),
      connection = await created(f),
      c = await f.connect(connection);
    c.socket.send(
      JSON.stringify({ type: 'session.update', session: { tools: [{ name: 'shell' }] } })
    );
    await vi.waitFor(() => expect(c.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 3000 });
    expect(c.provider.sent.filter((event) => event.type === 'session.update')).toHaveLength(1);
    expect(c.provider.sent.some((event) => event.type === 'response.create')).toBe(false);
    const next = await created(f),
      second = await f.app.injectWS(next.socketPath, { headers: f.headers });
    second.send(JSON.stringify({ type: 'ticket', ticket: next.ticket }));
    await vi.waitFor(() => expect(f.providers).toHaveLength(2));
    const provider = f.providers[1]!;
    await vi.waitFor(() => expect(provider.sent[0]?.type).toBe('session.update'));
    provider.event({ type: 'session.updated', session: provider.sent[0]!.session });
    await vi.waitFor(async () =>
      expect((await voice.get(f.user.id, next.session.id))?.session.status).toBe('listening')
    );
    second.send(encodeVoiceFrame(99, 0, new Uint8Array(480)));
    await vi.waitFor(() => expect(second.readyState).toBe(WebSocket.CLOSED));
    expect(provider.sent.some((event) => event.type === 'input_audio_buffer.append')).toBe(false);
  });
  it('refuses another response after cookie revocation and keeps a malformed charge held', async () => {
    const f = await fixture(),
      connection = await created(f),
      c = await f.connect(connection);
    await begin(c);
    c.provider.event({
      type: 'response.done',
      response: { id: 'resp_one', usage: { ...usage, input_tokens: 101 } }
    });
    await vi.waitFor(() => expect(c.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 3000 });
    expect((await voice.get(f.user.id, connection.session.id))?.session.status).toBe(
      'usage_uncertain'
    );
    expect(await voice.pending(f.user.id, connection.session.id)).toHaveLength(1);
    const g = await fixture(),
      other = await created(g),
      d = await g.connect(other);
    d.socket.send(encodeVoiceFrame(1, 0, new Uint8Array(480)));
    await vi.waitFor(() =>
      expect(d.provider.sent.some((e) => e.type === 'input_audio_buffer.append')).toBe(true)
    );
    await database.query('DELETE FROM sessions WHERE id_hash=$1', [sha256(g.token)]);
    d.provider.event({ type: 'input_audio_buffer.committed' });
    await vi.waitFor(() => expect(d.socket.readyState).toBe(WebSocket.CLOSED));
    expect(d.provider.sent.some((event) => event.type === 'response.create')).toBe(false);
  });
  it('ignores no authority from unsolicited provider turns and stops a continuous input segment before the excess append', async () => {
    const f = await fixture(),
      connection = await created(f),
      c = await f.connect(connection);
    c.provider.event({ type: 'input_audio_buffer.committed' });
    await vi.waitFor(() => expect(c.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 3000 });
    expect(c.provider.sent.some((e) => e.type === 'response.create')).toBe(false);
    const started = await f.start(randomUUID(), { ...f.selection, lifetimeSeconds: 600 });
    expect(started.statusCode, started.body).toBe(200);
    const second = started.json<VoiceConnection>(),
      socket = await f.app.injectWS(second.socketPath, { headers: f.headers });
    socket.send(JSON.stringify({ type: 'ticket', ticket: second.ticket }));
    await vi.waitFor(() => expect(f.providers).toHaveLength(2));
    const provider = f.providers[1]!;
    await vi.waitFor(() => expect(provider.sent[0]?.type).toBe('session.update'));
    provider.event({ type: 'session.updated', session: provider.sent[0]!.session });
    await vi.waitFor(async () =>
      expect((await voice.get(f.user.id, second.session.id))?.session.status).toBe('listening')
    );
    const realNow = Date.now,
      clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
    try {
      for (let batch = 0; batch < 6; batch++) {
        for (let i = batch * 100; i < (batch + 1) * 100; i++)
          socket.send(encodeVoiceFrame(1, i * 2400, new Uint8Array(4800)));
        await vi.waitFor(() =>
          expect(provider.sent.filter((e) => e.type === 'input_audio_buffer.append')).toHaveLength(
            (batch + 1) * 100
          )
        );
      }
      socket.send(encodeVoiceFrame(1, 600 * 2400, new Uint8Array(4800)));
      await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
      expect(provider.sent.filter((e) => e.type === 'input_audio_buffer.append')).toHaveLength(600);
      expect((await voice.get(f.user.id, second.session.id))?.session).toMatchObject({
        errorCode: 'voice_input_segment_limit',
        inputSeconds: 60,
        pendingUsd: 0
      });
    } finally {
      clock.mockRestore();
    }
  });
  it('drains the final cancellation receipt before closing the provider instead of fabricating a refund', async () => {
    const f = await fixture(),
      connection = await created(f),
      c = await f.connect(connection);
    await begin(c);
    const stopping = f.app.inject({
      method: 'POST',
      url: `/v1/tasks/${f.task.id}/voice-sessions/${connection.session.id}/stop`,
      headers: f.headers
    });
    await vi.waitFor(() =>
      expect(c.provider.sent.some((e) => e.type === 'response.cancel')).toBe(true)
    );
    c.provider.event({ type: 'response.done', response: { id: 'resp_one', usage } });
    const result = await stopping;
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json<VoiceSession>()).toMatchObject({
      status: 'ended',
      pendingUsd: 0,
      cleanupPending: false
    });
    expect(result.json<VoiceSession>().settledUsd).toBeGreaterThan(0);
  });
  it('mutes before pending cleanup and never publishes stale readiness after a stop races its database read', async () => {
    const f = await fixture(),
      connection = await created(f),
      socket = await f.app.injectWS(connection.socketPath, { headers: f.headers });
    const events: Array<{ type: string; muted?: boolean }> = [];
    socket.on('message', (data) =>
      events.push(
        JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as {
          type: string;
          muted?: boolean;
        }
      )
    );
    socket.send(JSON.stringify({ type: 'ticket', ticket: connection.ticket }));
    await vi.waitFor(() => expect(f.providers[0]?.sent[0]?.type).toBe('session.update'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const get = VoiceStore.prototype.get.bind(voice),
      spy = vi.spyOn(VoiceStore.prototype, 'get').mockImplementationOnce(async function (
        this: VoiceStore,
        ...args: Parameters<typeof get>
      ) {
        const result = await get(...args);
        entered = true;
        await gate;
        return result;
      });
    try {
      f.providers[0]!.event({ type: 'session.updated', session: f.providers[0]!.sent[0]!.session });
      await vi.waitFor(() => expect(entered).toBe(true));
      const stopping = f.app.inject({
        method: 'POST',
        url: `/v1/tasks/${f.task.id}/voice-sessions/${connection.session.id}/stop`,
        headers: f.headers
      });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === 'input' && event.muted === true)).toBe(true)
      );
      expect(events.some((event) => event.type === 'ready')).toBe(false);
      release();
      expect((await stopping).statusCode).toBe(200);
      expect(events.some((event) => event.type === 'ready')).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
  });
});
