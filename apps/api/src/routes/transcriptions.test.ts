import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MediaModelOption } from '@garden/contracts';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import type * as AudioPreparation from '../audio-preparation.js';
import type { InferenceSecret } from '../context.js';
import type { RouteContext } from '../http/server-context.js';
import { createIdempotentOperation } from '../http/idempotency.js';
import { registerTranscriptionRoutes } from './transcriptions.js';
import { prepareDictationAudio } from '../audio-preparation.js';

vi.mock('../audio-preparation.js', async (original) => {
  const actual = await original<typeof AudioPreparation>();
  return {
    ...actual,
    dictationDecoder: vi.fn(async () => '/usr/bin/ffmpeg'),
    prepareDictationAudio: vi.fn(async (bytes: Buffer) => ({
      bytes,
      seconds: 2,
      format: 'wav' as const
    }))
  };
});
const recording = Buffer.from('RIFF fixture WAVE owner private audio').toString('base64');
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const route = (): MediaModelOption => ({
  id: 'openai/whisper-1',
  providerModelId: 'whisper-1',
  displayName: 'Whisper',
  provider: 'openai',
  modality: 'transcription',
  apiProtocol: 'openai',
  usdPerMinute: 0.006,
  usdPerImage: null,
  usdPerMillionCharacters: null,
  priceSource: 'provider',
  defaultVoice: null,
  recommendationTags: [],
  updatedAt: new Date().toISOString(),
  zeroDataRetentionAvailable: true,
  pricing: [{ billable: 'input_audio', unit: 'minute', costUsd: 0.006 }]
});

describe('dictation provider authority, atomic accounting and sealed retries', () => {
  const masterKey = Buffer.alloc(32, 19);
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
    store = new DataStore(database);
  const apps: FastifyInstance[] = [];
  beforeAll(async () => migrateDatabase(database));
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  afterAll(async () => database.close());
  async function fixture() {
    const owner = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
    const secret: InferenceSecret = {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'owner-secret',
      enforceZeroDataRetention: true,
      mediaRoutes: { transcription: route() }
    };
    const app = Fastify();
    apps.push(app);
    app.decorateRequest('user', null);
    app.decorateRequest('apiToken', null);
    app.addHook('onRequest', async (request) => {
      request.user = request.headers['x-no-owner'] ? null : owner;
      request.apiToken = request.headers['x-api-token'] ? ({} as never) : null;
    });
    app.setErrorHandler((error, _request, reply) => {
      const e = error as { statusCode?: number; code?: string; message: string };
      void reply.status(e.statusCode ?? 400).send({ error: { code: e.code, message: e.message } });
    });
    const mediaSettings = vi.fn(async () => ({
      modalities: [{ modality: 'transcription', effective: secret.mediaRoutes!.transcription }]
    }));
    registerTranscriptionRoutes({
      app,
      store,
      config: { PUBLIC_APP_URL: 'https://garden.example' },
      masterKey,
      inferenceCredential: async () => ({ secret }),
      mediaSettings,
      idempotent: createIdempotentOperation({ store, database, masterKey })
    } as unknown as RouteContext);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({ text: 'A private transcript', usage: { seconds: 2.4, cost: 0.004 } })
        )
    );
    vi.stubGlobal('fetch', fetch);
    const post = (
      key = randomUUID(),
      extra: Record<string, unknown> = {},
      headers: Record<string, string> = {}
    ) =>
      app.inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        headers: { 'idempotency-key': key, ...headers },
        payload: { data: recording, format: 'wav', ...extra }
      });
    const ledger = async () =>
      (
        await database.query(
          'SELECT state,cost_usd,quantity,provider_ref,model_id FROM usage_entries WHERE user_id=$1',
          [owner.id]
        )
      ).rows;
    return { app, owner, secret, fetch, post, ledger, mediaSettings };
  }
  it('publishes exact options without credentials and reserves before native multipart submission', async () => {
    const f = await fixture();
    const options = await f.app.inject('/v1/audio/transcriptions/options');
    expect(options.statusCode).toBe(200);
    expect(options.json()).toMatchObject({
      available: true,
      modelId: 'whisper-1',
      privacyRoutes: ['provider_zdr'],
      requiresMaxCostUsd: false,
      maxDurationSeconds: 300,
      maxBytes: 14_000_000
    });
    expect(options.body).not.toContain('owner-secret');
    f.fetch.mockImplementationOnce(async (url, init) => {
      expect(url instanceof Request ? url.url : url.toString()).toBe(
        'https://api.openai.com/v1/audio/transcriptions'
      );
      expect(await f.ledger()).toEqual([
        expect.objectContaining({ state: 'reserved', cost_usd: 0.006 })
      ]);
      expect(init?.redirect).toBe('error');
      expect(init?.body).toBeInstanceOf(FormData);
      const body = init!.body as FormData;
      expect(body.get('model')).toBe('whisper-1');
      expect(body.has('provider')).toBe(false);
      return new Response(
        JSON.stringify({ text: 'A private transcript', usage: { seconds: 2.4, cost: 0.004 } })
      );
    });
    const result = await f.post();
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      text: 'A private transcript',
      model: 'whisper-1',
      privacyRoute: 'provider_zdr',
      usage: { cost: 0.004, costSource: 'provider' }
    });
    expect(await f.ledger()).toEqual([
      expect.objectContaining({
        state: 'settled',
        cost_usd: 0.004,
        quantity: 2.4,
        model_id: 'whisper-1'
      })
    ]);
  });
  it('requires reviewed external consent for OpenRouter despite saved private metadata and settles the priced route', async () => {
    const f = await fixture();
    f.secret.provider = 'openrouter';
    f.secret.baseUrl = 'https://openrouter.ai/api/v1';
    Object.assign(f.secret.mediaRoutes!.transcription!, {
      id: 'openrouter/openai/whisper-1',
      providerModelId: 'openai/whisper-1',
      provider: 'openrouter',
      apiProtocol: 'openrouter',
      zeroDataRetentionAvailable: true
    });
    const options = (await f.app.inject('/v1/audio/transcriptions/options')).json<{
      routeId: string;
      modelId: string;
      routeProof: string;
    }>();
    expect(options).toMatchObject({
      available: true,
      privacyRoutes: ['external'],
      defaultPrivacyRoute: 'external',
      requiresExternalConsent: true,
      usdPerMinute: 0.006
    });
    const selection = {
      expectedRouteId: options.routeId,
      expectedModelId: options.modelId,
      expectedRouteProof: options.routeProof,
      privacyRoute: 'external'
    };
    expect((await f.post()).statusCode).toBe(409);
    expect((await f.post(randomUUID(), selection)).json()).toMatchObject({
      error: { code: 'transcription_consent_required' }
    });
    expect(
      (await f.post(randomUUID(), { privacyRoute: 'external', externalConsent: true })).statusCode
    ).toBe(409);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.ledger()).toEqual([]);
    const accepted = await f.post(randomUUID(), {
      ...selection,
      externalConsent: true,
      maxCostUsd: 0.006
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ privacyRoute: 'external', usage: { cost: 0.004 } });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.secret.enforceZeroDataRetention).toBe(true);
    const entries = await f.ledger();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe('settled');
    expect(Number(entries[0]!.cost_usd)).toBe(0.004);
  });
  it('revalidates stored OpenRouter availability and refuses a credential switch after external consent', async () => {
    const f = await fixture();
    f.secret.provider = 'openrouter';
    f.secret.baseUrl = 'https://openrouter.ai/api/v1';
    Object.assign(f.secret.mediaRoutes!.transcription!, { apiProtocol: 'openrouter' });
    const reviewed = (await f.app.inject('/v1/audio/transcriptions/options')).json<{
      routeId: string;
      modelId: string;
      routeProof: string;
    }>();
    f.secret.apiKey = 'changed-owner-secret';
    const result = await f.post(randomUUID(), {
      privacyRoute: 'external',
      externalConsent: true,
      expectedRouteId: reviewed.routeId,
      expectedModelId: reviewed.modelId,
      expectedRouteProof: reviewed.routeProof
    });
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({ error: { code: 'dictation_selection_changed' } });
    f.mediaSettings.mockResolvedValueOnce({
      modalities: [
        {
          modality: 'transcription',
          effective: {
            ...f.secret.mediaRoutes!.transcription!,
            priceSource: 'unknown',
            usdPerMinute: null,
            pricing: [],
            unavailableReason: 'Unknown endpoint unit'
          }
        }
      ]
    });
    expect((await f.app.inject('/v1/audio/transcriptions/options')).json()).toMatchObject({
      available: false,
      reason: 'Unknown endpoint unit'
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('holds an admitted external duration reservation when the provider returns no actual cost', async () => {
    const f = await fixture();
    f.secret.provider = 'openrouter';
    f.secret.baseUrl = 'https://openrouter.ai/api/v1';
    Object.assign(f.secret.mediaRoutes!.transcription!, { apiProtocol: 'openrouter' });
    f.fetch.mockResolvedValueOnce(
      Response.json({ text: 'Transcribed without a receipt', usage: { seconds: 2 } })
    );
    const reviewed = (await f.app.inject('/v1/audio/transcriptions/options')).json<{
      routeId: string;
      modelId: string;
      routeProof: string;
    }>();
    const result = await f.post(randomUUID(), {
      privacyRoute: 'external',
      externalConsent: true,
      expectedRouteId: reviewed.routeId,
      expectedModelId: reviewed.modelId,
      expectedRouteProof: reviewed.routeProof
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      usage: { cost: null, costSource: 'unresolved', reservationUsd: 0.006 }
    });
    const entries = await f.ledger();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe('reserved');
    expect(Number(entries[0]!.cost_usd)).toBe(0.006);
  });
  it('replays the same result with no new provider work and keeps transcript plaintext out of PostgreSQL', async () => {
    const f = await fixture(),
      key = randomUUID();
    const first = await f.post(key),
      second = await f.post(key);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const stored = await database.query(
      'SELECT response_body,response_ciphertext FROM api_operations WHERE user_id=$1',
      [f.owner.id]
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain('A private transcript');
    expect(stored.rows[0]!.response_body).toBeNull();
    expect(stored.rows[0]!.response_ciphertext).toMatchObject({
      v: 1
    });
  });
  it('uses the reviewed external OpenRouter model and prepared audio', async () => {
    const f = await fixture();
    f.secret.provider = 'openrouter';
    f.secret.baseUrl = 'https://openrouter.ai/api/v1';
    Object.assign(f.secret.mediaRoutes!.transcription!, {
      id: 'openrouter/vendor/ears',
      providerModelId: 'vendor/ears',
      provider: 'openrouter',
      apiProtocol: 'openrouter'
    });
    const options = (await f.app.inject('/v1/audio/transcriptions/options')).json<{
      routeId: string;
      modelId: string;
      routeProof: string;
    }>();
    const result = await f.post(randomUUID(), {
      privacyRoute: 'external',
      externalConsent: true,
      expectedRouteId: options.routeId,
      expectedModelId: options.modelId,
      expectedRouteProof: options.routeProof
    });
    expect(result.statusCode, result.body).toBe(200);
    const init = f.fetch.mock.calls[0]![1]!;
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'vendor/ears',
      input_audio: { format: 'wav', data: recording }
    });
    expect(JSON.parse(init.body as string)).not.toHaveProperty('provider');
    expect(f.mediaSettings).toHaveBeenCalled();
  });
  it('rejects a reviewed route or credential changed during recording before decoding or sending', async () => {
    const f = await fixture();
    const reviewed = (await f.app.inject('/v1/audio/transcriptions/options')).json<{
      routeId: string;
      modelId: string;
      routeProof: string;
    }>();
    const expected = {
      expectedRouteId: reviewed.routeId,
      expectedModelId: reviewed.modelId,
      expectedRouteProof: reviewed.routeProof
    };
    f.secret.apiKey = 'a-different-owner-key';
    const rejected = await f.post(randomUUID(), expected);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { code: 'dictation_selection_changed' } });
    expect(prepareDictationAudio).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    const current = (await f.app.inject('/v1/audio/transcriptions/options')).json<{
      routeProof: string;
    }>();
    expect(current.routeProof).not.toBe(reviewed.routeProof);
    expect(
      (await f.post(randomUUID(), { ...expected, expectedRouteProof: current.routeProof }))
        .statusCode
    ).toBe(200);
  });
  it('rechecks reviewed connection authority after asynchronous audio preparation before reserving or uploading', async () => {
    const f = await fixture();
    const started = deferred<void>();
    const prepared = deferred<{ bytes: Buffer; seconds: number; format: 'wav' }>();
    vi.mocked(prepareDictationAudio).mockImplementationOnce(async () => {
      started.resolve();
      return prepared.promise;
    });
    const reviewed = (await f.app.inject('/v1/audio/transcriptions/options')).json<{
      routeId: string;
      modelId: string;
      routeProof: string;
    }>();
    const pending = f
      .post(randomUUID(), {
        expectedRouteId: reviewed.routeId,
        expectedModelId: reviewed.modelId,
        expectedRouteProof: reviewed.routeProof
      })
      .then((response) => response);
    await started.promise;
    f.secret.apiKey = 'changed-while-decoding';
    prepared.resolve({ bytes: Buffer.from(recording, 'base64'), seconds: 2, format: 'wav' });
    const result = await pending;
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({ error: { code: 'dictation_selection_changed' } });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.ledger()).toEqual([]);
  });
  it('requires explicit external retention and cannot accept credential or route overrides', async () => {
    const f = await fixture();
    f.secret.enforceZeroDataRetention = false;
    expect((await f.post()).statusCode).toBe(409);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      (await f.post(randomUUID(), { apiKey: 'forged', privacyRoute: 'external' })).statusCode
    ).toBe(400);
    expect(f.fetch).not.toHaveBeenCalled();
    const options = (await f.app.inject('/v1/audio/transcriptions/options')).json<{
      routeId: string;
      modelId: string;
      routeProof: string;
    }>();
    const accepted = await f.post(randomUUID(), {
      privacyRoute: 'external',
      externalConsent: true,
      expectedRouteId: options.routeId,
      expectedModelId: options.modelId,
      expectedRouteProof: options.routeProof
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ privacyRoute: 'external' });
  });
  it('refuses unbounded token-priced or unpriced routes even with an arbitrarily small owner cap', async () => {
    const f = await fixture();
    const selected = f.secret.mediaRoutes!.transcription!;
    selected.usdPerMinute = null;
    selected.pricing = [{ billable: 'input_tokens', unit: 'token', costUsd: 0.00001 }];
    expect((await f.app.inject('/v1/audio/transcriptions/options')).json()).toMatchObject({
      available: false,
      requiresMaxCostUsd: false
    });
    expect((await f.post(randomUUID(), { maxCostUsd: 0.0001 })).statusCode).toBe(409);
    selected.pricing = [];
    selected.priceSource = 'unknown';
    expect((await f.post(randomUUID(), { maxCostUsd: 100 })).statusCode).toBe(409);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.ledger()).toEqual([]);
  });
  it('admits a known native token model only against its full request bound and settles actual usage once', async () => {
    const f = await fixture();
    Object.assign(f.secret.mediaRoutes!.transcription!, {
      id: 'openai/gpt-4o-transcribe',
      providerModelId: 'gpt-4o-transcribe',
      usdPerMinute: null,
      pricing: [
        { billable: 'input_tokens', unit: 'token', costUsd: 0.0000025 },
        { billable: 'output_tokens', unit: 'token', costUsd: 0.00001 }
      ]
    });
    expect((await f.app.inject('/v1/audio/transcriptions/options')).json()).toMatchObject({
      available: true,
      usdPerMinute: null,
      reservationUsd: 0.06,
      maxDurationSeconds: 300
    });
    expect((await f.post(randomUUID(), { maxCostUsd: 0.001 })).statusCode).toBe(402);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.ledger()).toEqual([]);
    f.fetch.mockImplementationOnce(async (_url, init) => {
      expect(await f.ledger()).toEqual([
        expect.objectContaining({ state: 'reserved', cost_usd: 0.06 })
      ]);
      expect((init!.body as FormData).has('chunking_strategy')).toBe(false);
      return Response.json({
        text: 'A native token transcript',
        usage: { type: 'tokens', input_tokens: 200, output_tokens: 30, total_tokens: 230 }
      });
    });
    const result = await f.post(randomUUID(), { maxCostUsd: 0.06 });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      text: 'A native token transcript',
      usage: { cost: 0.0008, costSource: 'quote' }
    });
    expect(await f.ledger()).toEqual([
      expect.objectContaining({ state: 'settled', cost_usd: 0.0008 })
    ]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds diarized dictation to one block and refuses hidden provider chunking before reservation', async () => {
    const f = await fixture();
    Object.assign(f.secret.mediaRoutes!.transcription!, {
      id: 'openai/gpt-4o-transcribe-diarize',
      providerModelId: 'gpt-4o-transcribe-diarize',
      usdPerMinute: null,
      pricing: [
        { billable: 'input_tokens', unit: 'token', costUsd: 0.0000025 },
        { billable: 'output_tokens', unit: 'token', costUsd: 0.00001 }
      ]
    });
    expect((await f.app.inject('/v1/audio/transcriptions/options')).json()).toMatchObject({
      available: true,
      reservationUsd: 0.06,
      maxDurationSeconds: 30
    });
    vi.mocked(prepareDictationAudio).mockResolvedValueOnce({
      bytes: Buffer.from('bounded audio'),
      seconds: 31,
      format: 'wav'
    });
    const result = await f.post(randomUUID(), { maxCostUsd: 0.06 });
    expect(result.statusCode, result.body).toBe(413);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.ledger()).toEqual([]);
    vi.mocked(prepareDictationAudio).mockResolvedValueOnce({
      bytes: Buffer.from('bounded audio'),
      seconds: 30,
      format: 'wav'
    });
    expect((await f.post(randomUUID(), { maxCostUsd: 0.06 })).statusCode).toBe(200);
    expect((f.fetch.mock.calls[0]![1]!.body as FormData).has('chunking_strategy')).toBe(false);
  });
  it('keeps submitted uncertainty held and never resubmits it under a retry key', async () => {
    const f = await fixture(),
      key = randomUUID();
    f.fetch.mockRejectedValueOnce(new Error('Connection lost'));
    const failed = await f.post(key);
    expect(failed.statusCode).toBe(503);
    expect(await f.ledger()).toEqual([expect.objectContaining({ state: 'reserved' })]);
    expect((await f.post(key)).statusCode).toBe(409);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('recovers a held dictation from an exact owner invoice and seals its reference without contacting the provider', async () => {
    const f = await fixture();
    f.fetch.mockRejectedValueOnce(new Error('Lost response'));
    expect((await f.post()).statusCode).toBe(503);
    const rows = (await f.app.inject('/v1/audio/transcriptions/receipts')).json<
      Array<{ id: string; state: string; reservationUsd: number }>
    >();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'reserved', reservationUsd: 0.006 });
    const other = await fixture();
    expect(
      (
        await other.app.inject({
          method: 'POST',
          url: `/v1/audio/transcriptions/${rows[0]!.id}/reconcile`,
          headers: { 'idempotency-key': randomUUID() },
          payload: { costUsd: 0.005, providerReceiptRef: 'invoice-private-73' }
        })
      ).statusCode
    ).toBe(409);
    const send = () =>
      f.app.inject({
        method: 'POST',
        url: `/v1/audio/transcriptions/${rows[0]!.id}/reconcile`,
        headers: { 'idempotency-key': 'invoice-reconcile-73' },
        payload: { costUsd: 0.005, providerReceiptRef: 'invoice-private-73' }
      });
    const result = await send();
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ state: 'settled', costUsd: 0.005, reservationUsd: 0 });
    expect((await send()).headers['idempotency-replayed']).toBe('true');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(other.fetch).not.toHaveBeenCalled();
    const audit = await database.query(
      "SELECT metadata FROM security_events WHERE user_id=$1 AND kind='dictation_receipt_reconciled'",
      [f.owner.id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain('invoice-private-73');
    expect(await f.ledger()).toEqual([
      expect.objectContaining({ state: 'settled', cost_usd: 0.005 })
    ]);
  });
  it('does not reconcile while the original provider request can still return a receipt', async () => {
    const f = await fixture(),
      started = deferred<void>(),
      provider = deferred<Response>();
    f.fetch.mockImplementationOnce(async () => {
      started.resolve();
      return provider.promise;
    });
    const pending = f.post().then((response) => response);
    await started.promise;
    try {
      const rows = (await f.app.inject('/v1/audio/transcriptions/receipts')).json<
        Array<{ id: string }>
      >();
      expect(rows).toHaveLength(1);
      const denied = await f.app.inject({
        method: 'POST',
        url: `/v1/audio/transcriptions/${rows[0]!.id}/reconcile`,
        headers: { 'idempotency-key': randomUUID() },
        payload: { costUsd: 0.002, providerReceiptRef: 'too-early' }
      });
      expect(denied.statusCode).toBe(409);
      expect(denied.json()).toMatchObject({ error: { code: 'dictation_active' } });
    } finally {
      provider.resolve(Response.json({ text: 'Done', usage: { cost: 0.003 } }));
    }
    expect((await pending).statusCode).toBe(200);
  });
  it('releases only a confirmed rejection, while accounting for empty charged output', async () => {
    const f = await fixture();
    f.fetch.mockResolvedValueOnce(new Response('Denied', { status: 400 }));
    expect((await f.post()).statusCode).toBe(422);
    expect(await f.ledger()).toEqual([expect.objectContaining({ state: 'released', cost_usd: 0 })]);
    f.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: '', usage: { cost: 0.003 } }))
    );
    expect((await f.post()).statusCode).toBe(422);
    expect(await f.ledger()).toHaveLength(2);
    expect(await f.ledger()).toContainEqual(
      expect.objectContaining({ state: 'settled', cost_usd: 0.003 })
    );
  });
  it('rejects absent owner, bearer token, malformed data, unavailable route and exceeded reservation before provider work', async () => {
    const f = await fixture();
    expect((await f.post(randomUUID(), {}, { 'x-no-owner': '1' })).json()).toMatchObject({
      error: { code: 'authentication_required' }
    });
    expect((await f.post(randomUUID(), {}, { 'x-api-token': '1' })).statusCode).toBe(403);
    expect((await f.post(randomUUID(), { data: 'not-base64' })).statusCode).toBe(400);
    expect((await f.post(randomUUID(), { maxCostUsd: 0.001 })).statusCode).toBe(402);
    f.secret.mediaRoutes!.transcription!.unavailableReason = 'Retired route';
    expect((await f.post()).statusCode).toBe(409);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.ledger()).toHaveLength(0);
  });
  it('honors the owner cap through the actual atomic reservation path', async () => {
    const f = await fixture();
    await database.query(
      'INSERT INTO spend_limits(user_id,daily_cap_usd) VALUES ($1,0.001) ON CONFLICT(user_id) DO UPDATE SET daily_cap_usd=0.001',
      [f.owner.id]
    );
    expect((await f.post()).statusCode).toBe(402);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.ledger()).toHaveLength(0);
  });
  it('does not send audio when decoding rejects or the owner aborts preparation', async () => {
    const f = await fixture();
    vi.mocked(prepareDictationAudio).mockRejectedValueOnce(new Error('Unreadable container'));
    expect((await f.post()).statusCode).toBe(400);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.ledger()).toHaveLength(0);
  });
});
