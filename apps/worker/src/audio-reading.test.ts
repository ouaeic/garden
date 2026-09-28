/* eslint-disable @typescript-eslint/unbound-method -- The runner methods here are spies; assertions never invoke a detached method. */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encryptJson } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { transcribeRecording } from './audio-reading.js';
import {
  currentTranscriptionCredential,
  pinTranscriptionApproval
} from './transcription-approval.js';
import { withRunnerAbort } from './runner-client.js';
import type { ToolContext } from './tool-dispatch.js';
import type { InferenceCredential } from './agent-state.js';

const key = Buffer.alloc(32, 21);
const secret: InferenceCredential = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'owner-key',
  enforceZeroDataRetention: true,
  mediaRoutes: {
    transcription: {
      id: 'openai/gpt-transcribe',
      providerModelId: 'gpt-transcribe',
      displayName: 'GPT Transcribe',
      provider: 'openai',
      modality: 'transcription',
      apiProtocol: 'openai',
      usdPerImage: null,
      usdPerMillionCharacters: null,
      usdPerMinute: 0.0045,
      pricing: [{ billable: 'input_audio', unit: 'minute', costUsd: 0.0045 }],
      priceSource: 'provider',
      zeroDataRetentionAvailable: true,
      recommendationTags: [],
      updatedAt: new Date().toISOString()
    }
  }
};
const call = (options?: Record<string, unknown>) => ({
  id: randomUUID(),
  name: 'audio_read',
  arguments: { path: 'workspace/meeting.ogg', ...(options ? { options } : {}) }
});
describe('atomic recording transcription and delivery', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
    store = new DataStore(database);
  let userId = '',
    workspaceId = '';
  beforeAll(async () => {
    await migrateDatabase(database);
    userId = (await store.createUser({ username: 'listener-owner', displayName: 'Owner' })).id;
    workspaceId = (
      await store.createWorkspace({
        userId,
        name: 'Recordings',
        storageLimitBytes: 100_000_000,
        imageRevision: 'test',
        region: 'local',
        wrappedKey: 'fixture'
      })
    ).id;
  });
  afterAll(async () => database.close());
  afterEach(() => vi.unstubAllGlobals());
  const context = async (limit = 1, priced = true) => {
    const ctx = {
      store,
      key,
      state: {},
      consequentialApproved: true,
      config: { PUBLIC_APP_URL: 'https://garden.example', WORKER_ID: 'transcription-worker' },
      task: await store.createTask({
        userId,
        workspaceId,
        titleCiphertext: encryptJson({ title: 'Meeting' }, key, 'title'),
        promptCiphertext: encryptJson({ prompt: 'Read' }, key, 'prompt'),
        modelId: 'test/model',
        nameIndex: { nameTokens: 'meeting', openingTokens: 'read' },
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        maxSpendUsd: limit,
        securityMode: 'balanced'
      }),
      inferenceCredential: async () =>
        priced
          ? secret
          : {
              ...secret,
              mediaRoutes: {
                transcription: {
                  ...secret.mediaRoutes!.transcription!,
                  providerModelId: 'gpt-4o-transcribe',
                  apiProtocol: 'openai',
                  usdPerMinute: null,
                  pricing: [
                    { billable: 'input_tokens', unit: 'token', costUsd: 0.0000025 },
                    { billable: 'output_tokens', unit: 'token', costUsd: 0.00001 }
                  ],
                  priceSource: 'provider'
                }
              }
            },
      runner: {
        inspectAudioSource: vi.fn(async () => ({
          sourceSha256: 'a'.repeat(64),
          sourceBytes: 2048
        })),
        prepareAudio: vi.fn(async () => ({
          sourceSha256: 'a'.repeat(64),
          sourceBytes: 2048,
          bytes: Buffer.from('OggS audio'),
          format: 'ogg',
          startSeconds: 0,
          preparedSeconds: 60,
          durationSeconds: 60,
          more: false
        })),
        writeFile: vi.fn(async () => undefined)
      }
    } as unknown as ToolContext;
    await database.query(
      "UPDATE tasks SET status='running', lease_owner='transcription-worker' WHERE id=$1",
      [ctx.task.id]
    );
    return ctx;
  };
  const read = async (ctx: ToolContext, request: ReturnType<typeof call>) => {
    if (ctx.consequentialApproved)
      await pinTranscriptionApproval(
        ctx,
        request,
        await currentTranscriptionCredential(await ctx.inferenceCredential(ctx.task))
      );
    return transcribeRecording(ctx, request);
  };
  it('reserves under the owner lock before HTTP and refuses a concurrent call over the same cap', async () => {
    const ctx = await context(0.005),
      fetch = vi.fn(async () => {
        expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.0045);
        return Response.json({ text: 'Meeting opened', usage: { seconds: 60 } });
      });
    vi.stubGlobal('fetch', fetch);
    const results = await Promise.allSettled([read(ctx, call()), read(ctx, call())]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.0045);
    expect(ctx.runner.writeFile).toHaveBeenCalledOnce();
  });
  it('requires the proven native reservation, keeps unknown charges held, and prevents replay of the same call', async () => {
    const ctx = await context(1, false),
      fetch = vi.fn(async (_url: string, request: RequestInit) => {
        expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.06);
        expect((request.body as FormData).get('model')).toBe('gpt-4o-transcribe');
        expect((request.body as FormData).has('chunking_strategy')).toBe(false);
        return Response.json({ text: 'No cost receipt' });
      });
    vi.stubGlobal('fetch', fetch);
    const request = call({ maxCostUsd: 1 });
    await expect(read({ ...ctx, consequentialApproved: false }, request)).rejects.toMatchObject({
      code: 'transcription_approval_required'
    });
    await expect(read(ctx, request)).resolves.toMatchObject({
      costUsd: null,
      costSource: 'unresolved',
      reservationUsd: 0.06
    });
    await expect(read(ctx, request)).rejects.toMatchObject({
      code: 'media_submission_exists'
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(ctx.runner.prepareAudio).toHaveBeenCalledWith(
      ctx.task.workspaceId,
      ctx.task.id,
      expect.objectContaining({ endSeconds: 300 })
    );
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.06);
    const rows = await database.query(
      'SELECT state,cost_usd FROM usage_entries WHERE task_id=$1 AND resource_class=$2',
      [ctx.task.id, 'media:transcription']
    );
    expect(rows.rows).toEqual([{ state: 'reserved', cost_usd: 0.06 }]);
  });
  it('settles a known charge before malformed output or failed file delivery, releases only proven provider refusals', async () => {
    const ctx = await context(1, false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ text: '', usage: { cost: 0.02 } }))
    );
    await expect(read(ctx, call({ maxCostUsd: 0.1 }))).rejects.toMatchObject({
      code: 'audio_read_failed'
    });
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.02);
    expect(ctx.runner.writeFile).not.toHaveBeenCalled();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('refused', { status: 400 }))
    );
    await expect(read(ctx, call({ maxCostUsd: 0.1 }))).rejects.toMatchObject({
      code: 'audio_read_failed'
    });
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.02);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('lost receipt');
      })
    );
    await expect(read(ctx, call({ maxCostUsd: 0.1 }))).rejects.toMatchObject({
      code: 'audio_read_failed'
    });
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.08);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ text: 'Paid transcript', usage: { cost: 0.01 } }))
    );
    const failed = {
      ...ctx,
      runner: {
        ...ctx.runner,
        writeFile: vi.fn(async () => {
          throw new Error('workspace full');
        })
      }
    } as unknown as ToolContext;
    await expect(read(failed, call({ maxCostUsd: 0.1 }))).rejects.toThrow('workspace full');
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.09);
  });
  it('refuses unknown token routes despite an arbitrary allowance or a prior measured invoice', async () => {
    let ctx = await context(1, false);
    const native = await ctx.inferenceCredential(ctx.task);
    ctx = {
      ...ctx,
      inferenceCredential: async () => ({
        ...native,
        mediaRoutes: {
          transcription: {
            ...native.mediaRoutes!.transcription!,
            providerModelId: 'unverified-transcribe'
          }
        }
      })
    };
    ctx.state.transcriptionRates = { 'unverified-transcribe': 0.00001 };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(read(ctx, call({ maxCostUsd: 1000 }))).rejects.toMatchObject({
      code: 'transcription_price_unbounded'
    });
    expect(ctx.runner.prepareAudio).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.mediaSpendForTask(ctx.task.id)).toBe(0);
  });
  it('uses the actual connection for native limits and refuses a smaller allowance before HTTP', async () => {
    let ctx = await context(1, false);
    const native = await ctx.inferenceCredential(ctx.task),
      fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(read(ctx, call({ maxCostUsd: 0.01 }))).rejects.toMatchObject({
      code: 'transcription_reservation_exceeded'
    });
    ctx = {
      ...ctx,
      inferenceCredential: async () => ({ ...native, baseUrl: 'https://unverified.example/v1' })
    };
    await expect(
      read(ctx, call({ maxCostUsd: 1, privacyRoute: 'external' }))
    ).rejects.toMatchObject({
      code: 'transcription_price_unbounded'
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.mediaSpendForTask(ctx.task.id)).toBe(0);
  });
  it('clips diarization to one block and refuses an oversized prepared response before reservation', async () => {
    let ctx = await context(1, false);
    const native = await ctx.inferenceCredential(ctx.task),
      fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    ctx = {
      ...ctx,
      inferenceCredential: async () => ({
        ...native,
        mediaRoutes: {
          transcription: {
            ...native.mediaRoutes!.transcription!,
            providerModelId: 'gpt-4o-transcribe-diarize'
          }
        }
      })
    };
    await expect(read(ctx, call())).rejects.toMatchObject({
      code: 'transcription_window_invalid'
    });
    expect(ctx.runner.prepareAudio).toHaveBeenCalledWith(
      ctx.task.workspaceId,
      ctx.task.id,
      expect.objectContaining({ startSeconds: 0, endSeconds: 30 })
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.mediaSpendForTask(ctx.task.id)).toBe(0);
  });

  it.each(['openrouter', 'openai-compatible'] as const)(
    'requires explicit external consent for actual OpenRouter even through %s configuration',
    async (provider) => {
      const ctx = await context();
      const routed = {
        ...secret,
        provider,
        baseUrl: 'https://openrouter.ai/api/v1',
        mediaRoutes: {
          transcription: {
            ...secret.mediaRoutes!.transcription!,
            providerModelId: 'openai/whisper-1',
            apiProtocol: 'openrouter' as const,
            zeroDataRetentionAvailable: true,
            usdPerMinute: 0.00001
          }
        }
      };
      const changed = { ...ctx, inferenceCredential: async () => routed };
      let uploads = 0;
      const fetch = vi.fn(async (url: string) => {
        if (url.endsWith('/audio/transcriptions')) {
          uploads++;
          return Response.json({ text: 'External transcript', usage: { cost: 0.003 } });
        }
        expect(url).toBe('https://openrouter.ai/api/v1/models/openai/whisper-1/endpoints');
        return Response.json({
          data: {
            id: 'openai/whisper-1',
            endpoints: [
              {
                model_id: 'openai/whisper-1',
                tag: 'openai',
                pricing: { prompt: '0.006', completion: '0' }
              }
            ]
          }
        });
      });
      vi.stubGlobal('fetch', fetch);
      await expect(transcribeRecording(changed, call())).rejects.toMatchObject({
        code: 'transcription_external_consent_required'
      });
      await expect(
        transcribeRecording(
          { ...changed, consequentialApproved: false },
          call({ privacyRoute: 'external' })
        )
      ).rejects.toMatchObject({ code: 'transcription_approval_required' });
      expect(uploads).toBe(0);
      expect(ctx.runner.prepareAudio).not.toHaveBeenCalled();
      await expect(read(changed, call({ privacyRoute: 'external' }))).resolves.toMatchObject({
        text: 'External transcript',
        costUsd: 0.003
      });
      expect(uploads).toBe(1);
      expect(ctx.task.privacyRoute).toBe('provider_zdr');
      expect(routed.enforceZeroDataRetention).toBe(true);
      expect(routed.mediaRoutes.transcription.zeroDataRetentionAvailable).toBe(true);
      expect(ctx.runner.prepareAudio).toHaveBeenCalledWith(
        ctx.task.workspaceId,
        ctx.task.id,
        expect.objectContaining({ expectedSourceSha256: 'a'.repeat(64) })
      );
    }
  );

  it('refuses unconfigured native retention and invalid external consent values', async () => {
    const ctx = await context();
    const changed = {
      ...ctx,
      inferenceCredential: async () => ({ ...secret, enforceZeroDataRetention: false })
    };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(transcribeRecording(changed, call())).rejects.toMatchObject({
      code: 'transcription_external_consent_required'
    });
    await expect(transcribeRecording(ctx, call({ privacyRoute: true }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.runner.prepareAudio).not.toHaveBeenCalled();
  });

  it('cannot reuse a spend-only approval with no recording and route proof', async () => {
    const ctx = await context();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      transcribeRecording(ctx, call({ privacyRoute: 'external' }))
    ).rejects.toMatchObject({ code: 'transcription_approval_changed' });
    expect(ctx.runner.prepareAudio).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['credential', 'model', 'price', 'options', 'turn', 'task'] as const)(
    'refuses changed %s after an external recording approval',
    async (field) => {
      let ctx = await context();
      const request = call({ privacyRoute: 'external' });
      await pinTranscriptionApproval(ctx, request, secret);
      if (field === 'credential')
        ctx = {
          ...ctx,
          inferenceCredential: async () => ({ ...secret, apiKey: 'changed-owner-key' })
        };
      if (field === 'model')
        ctx = {
          ...ctx,
          inferenceCredential: async () => ({
            ...secret,
            mediaRoutes: {
              transcription: {
                ...secret.mediaRoutes!.transcription!,
                providerModelId: 'another-model'
              }
            }
          })
        };
      if (field === 'price')
        ctx = {
          ...ctx,
          inferenceCredential: async () => ({
            ...secret,
            mediaRoutes: {
              transcription: {
                ...secret.mediaRoutes!.transcription!,
                pricing: [{ billable: 'input_audio', unit: 'minute', costUsd: 0.5 }]
              }
            }
          })
        };
      if (field === 'options')
        request.arguments.options = { privacyRoute: 'external', language: 'fr' };
      if (field === 'turn') ctx.state.turn = 2;
      if (field === 'task') ctx = { ...ctx, task: { ...ctx.task, id: randomUUID() } };
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(transcribeRecording(ctx, request)).rejects.toMatchObject({
        code: 'transcription_approval_changed'
      });
      expect(ctx.runner.prepareAudio).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it('rejects changed or missing source receipts before any reservation', async () => {
    const ctx = await context();
    const request = call({ privacyRoute: 'external' });
    await pinTranscriptionApproval(ctx, request, secret);
    const prepared = await ctx.runner.prepareAudio(ctx.task.workspaceId, ctx.task.id, {
      path: 'workspace/meeting.ogg'
    });
    vi.mocked(ctx.runner.prepareAudio).mockResolvedValue({
      ...prepared,
      sourceSha256: 'b'.repeat(64)
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(transcribeRecording(ctx, request)).rejects.toMatchObject({
      code: 'transcription_source_changed'
    });
    const missingReceipt = { ...prepared };
    delete missingReceipt.sourceSha256;
    vi.mocked(ctx.runner.prepareAudio).mockResolvedValue(missingReceipt);
    await expect(transcribeRecording(ctx, request)).rejects.toMatchObject({
      code: 'transcription_source_changed'
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.mediaSpendForTask(ctx.task.id)).toBe(0);
  });

  it('rechecks credentials after preparation and before the upload reservation', async () => {
    const base = await context();
    let current = secret;
    const ctx = { ...base, inferenceCredential: async () => current };
    const request = call({ privacyRoute: 'external' });
    await pinTranscriptionApproval(ctx, request, secret);
    const prepared = await ctx.runner.prepareAudio(ctx.task.workspaceId, ctx.task.id, {
      path: 'workspace/meeting.ogg'
    });
    vi.mocked(ctx.runner.prepareAudio).mockImplementation(async () => {
      current = { ...secret, apiKey: 'changed-during-encode' };
      return prepared;
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(transcribeRecording(ctx, request)).rejects.toMatchObject({
      code: 'transcription_approval_changed'
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.mediaSpendForTask(ctx.task.id)).toBe(0);
  });

  it.each(['cancelled', 'lease'] as const)(
    'refuses upload after task %s changes during preparation',
    async (kind) => {
      const ctx = await context();
      const request = call({ privacyRoute: 'external' });
      await pinTranscriptionApproval(ctx, request, secret);
      const prepared = await ctx.runner.prepareAudio(ctx.task.workspaceId, ctx.task.id, {
        path: 'workspace/meeting.ogg'
      });
      vi.mocked(ctx.runner.prepareAudio).mockImplementation(async () => {
        await database.query(
          kind === 'cancelled'
            ? "UPDATE tasks SET status='cancelled' WHERE id=$1"
            : "UPDATE tasks SET lease_owner='another-worker' WHERE id=$1",
          [ctx.task.id]
        );
        return prepared;
      });
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(transcribeRecording(ctx, request)).rejects.toMatchObject({
        code: 'transcription_task_inactive'
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(await store.mediaSpendForTask(ctx.task.id)).toBe(0);
    }
  );

  it('propagates active cancellation and releases a reservation aborted before upload', async () => {
    const ctx = await context();
    const request = call({ privacyRoute: 'external' });
    await pinTranscriptionApproval(ctx, request, secret);
    const controller = new AbortController();
    const record = store.recordUsage.bind(store);
    const spy = vi.spyOn(store, 'recordUsage').mockImplementation(async (input) => {
      const result = await record(input);
      if (input.state === 'reserved') controller.abort();
      return result;
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(
        withRunnerAbort(controller.signal, () => transcribeRecording(ctx, request))
      ).rejects.toMatchObject({ code: 'audio_read_failed' });
      expect(fetch).not.toHaveBeenCalled();
      expect(await store.mediaSpendForTask(ctx.task.id)).toBe(0);
      expect(spy.mock.calls.some(([input]) => input.state === 'released')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('passes the active turn cancellation signal to an in-flight transcription upload', async () => {
    const ctx = await context();
    const request = call({ privacyRoute: 'external' });
    await pinTranscriptionApproval(ctx, request, secret);
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, input: RequestInit) => {
      controller.abort();
      input.signal?.throwIfAborted();
      return Response.json({ text: 'Continued after cancel' });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      withRunnerAbort(controller.signal, () => transcribeRecording(ctx, request))
    ).rejects.toMatchObject({ code: 'audio_read_failed' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(await store.mediaSpendForTask(ctx.task.id)).toBeCloseTo(0.0045);
    expect(ctx.runner.writeFile).not.toHaveBeenCalled();
  });

  it('settles measured provider seconds alongside the actual charge', async () => {
    const ctx = await context();
    const spy = vi.spyOn(store, 'recordUsage');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ text: 'Measured reading', usage: { cost: 0.001, seconds: 12.5 } })
      )
    );
    try {
      await expect(read(ctx, call())).resolves.toMatchObject({ secondsRead: 60, costUsd: 0.001 });
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'settled',
          quantity: 12.5,
          unit: 'second',
          costUsd: 0.001
        })
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('consumes the exact recording proof before upload and refuses another use', async () => {
    const ctx = await context();
    const request = call({ privacyRoute: 'external' });
    await pinTranscriptionApproval(ctx, request, secret);
    const fetch = vi.fn(async () => {
      expect(ctx.state.transcriptionApprovals?.[request.id]).toBeUndefined();
      return Response.json({ text: 'Approved reading', usage: { cost: 0.004 } });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(transcribeRecording(ctx, request)).resolves.toMatchObject({
      text: 'Approved reading'
    });
    await expect(transcribeRecording(ctx, request)).rejects.toMatchObject({
      code: 'transcription_approval_changed'
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
