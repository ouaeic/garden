import { retainInterruptedResponse, interruptedResponseOf } from './interrupted-response.js';
import { GardenError } from '@garden/core';
import { describe, expect, it } from 'vitest';
import { ModelGateway } from './gateway.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import type { ModelAdapter, ModelRequest, ModelResponse, ProviderModel } from './protocol.js';
import type { RetryPolicy } from './retry.js';

const instantPolicy = (waits: number[]): RetryPolicy => ({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  maxRetryAfterMs: 120_000,
  random: () => 0,
  sleep: async (ms) => {
    waits.push(ms);
  }
});

const stubAdapter = (chat: (input: ModelRequest) => Promise<ModelResponse>): ModelAdapter => ({
  provider: 'test',
  privacyRoute: 'provider_zdr',
  list: async (): Promise<ProviderModel[]> => [],
  chat
});

const completion = (text: string): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  metadata: {
    provider: 'test',
    model: 'test-model',
    latencyMs: 1,
    privacyRoute: 'provider_zdr'
  }
});

const baseRequest: ModelRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'Inspect the workspace' }],
  tools: [],
  temperature: 0.2
};

describe('ModelGateway.chat retries', () => {
  it('identifies separate requests even when a provider repeats its generation ID', async () => {
    const returned = {
      ...completion('same answer'),
      metadata: { ...completion('').metadata, generationId: 'reused-provider-id' }
    };
    const gateway = new ModelGateway().register(
      'test',
      stubAdapter(async (input) => {
        expect(input).toBe(baseRequest);
        expect(input).not.toHaveProperty('requestId');
        return returned;
      })
    );
    const first = await gateway.chat('test', baseRequest);
    const second = await gateway.chat('test', baseRequest);
    expect(first.metadata.requestId).toBeTruthy();
    expect(second.metadata.requestId).toBeTruthy();
    expect(first.metadata.requestId).not.toBe(second.metadata.requestId);
    expect(first.metadata.generationId).toBe(second.metadata.generationId);
    expect(returned.metadata).not.toHaveProperty('requestId');
  });
  it('can submit one reserved attempt without changing retries for later calls', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const gateway = new ModelGateway({ retry: instantPolicy(waits) }).register(
      'test',
      stubAdapter(async () => {
        attempts += 1;
        throw new GardenError('provider_unavailable', 'upstream down', 503);
      })
    );
    await expect(gateway.chat('test', baseRequest, { retry: false })).rejects.toThrow(
      'upstream down'
    );
    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
    await expect(gateway.chat('test', baseRequest)).rejects.toThrow('upstream down');
    expect(attempts).toBe(4);
  });
  it('rides out transient upstream faults with backoff instead of failing the task', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const gateway = new ModelGateway({ retry: instantPolicy(waits) }).register(
      'test',
      stubAdapter(async () => {
        attempts += 1;
        if (attempts === 1) throw new GardenError('provider_unavailable', 'upstream down', 503);
        if (attempts === 2) throw new GardenError('provider_quota_exhausted', 'rate limited', 429);
        return completion('recovered');
      })
    );

    await expect(gateway.chat('test', baseRequest)).resolves.toMatchObject({ text: 'recovered' });
    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 500]);
  });

  it('gives up when the attempt budget runs out', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const gateway = new ModelGateway({ retry: instantPolicy(waits) }).register(
      'test',
      stubAdapter(async () => {
        attempts += 1;
        throw new GardenError('provider_unavailable', 'upstream down', 503);
      })
    );

    await expect(gateway.chat('test', baseRequest)).rejects.toThrow('upstream down');
    expect(attempts).toBe(3);
  });

  it('never replays a request that already streamed text to the caller', async () => {
    const waits: number[] = [];
    const deltas: string[] = [];
    let attempts = 0;
    const gateway = new ModelGateway({ retry: instantPolicy(waits) }).register(
      'test',
      stubAdapter(async (input) => {
        attempts += 1;
        await input.onTextDelta?.('half an answer');
        throw new GardenError('provider_unavailable', 'stream cut', 503);
      })
    );

    await expect(
      gateway.chat('test', {
        ...baseRequest,
        onTextDelta: (delta) => {
          deltas.push(delta);
        }
      })
    ).rejects.toThrow('stream cut');
    expect(attempts).toBe(1);
    expect(deltas).toEqual(['half an answer']);
  });

  /*
   * The shape that got past the text-only watch: a high-effort step on a full window streams a
   * minute and a half of thinking - published to the owner's timeline frame by frame, live - and
   * then the socket drops before the first content token. No text delta ever ran, so the request
   * was replayed three more times: the owner watched the same reasoning appear four times, each
   * discarded attempt's reasoning tokens were billed by the provider and recorded nowhere, and the
   * sequence could eat most of the caller's deadline before the attempt that would have worked.
   */
  it('never replays a request that already streamed reasoning to the caller', async () => {
    const waits: number[] = [];
    const reasoning: string[] = [];
    let attempts = 0;
    const gateway = new ModelGateway({ retry: instantPolicy(waits) }).register(
      'test',
      stubAdapter(async (input) => {
        attempts += 1;
        await input.onReasoningDelta?.('weighing the two approaches');
        throw new GardenError('provider_unavailable', 'stream cut', 503);
      })
    );

    await expect(
      gateway.chat('test', {
        ...baseRequest,
        onTextDelta: () => {
          throw new Error('no content token ever arrived');
        },
        onReasoningDelta: (delta) => {
          reasoning.push(delta);
        }
      })
    ).rejects.toThrow('stream cut');
    expect(attempts).toBe(1);
    expect(reasoning).toEqual(['weighing the two approaches']);
  });

  it('does not retry a request the owner cancelled', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const gateway = new ModelGateway({ retry: instantPolicy([]) }).register(
      'test',
      stubAdapter(async () => {
        attempts += 1;
        controller.abort();
        throw new GardenError('provider_unavailable', 'cancelled mid-flight', 503);
      })
    );

    await expect(
      gateway.chat('test', { ...baseRequest, signal: controller.signal })
    ).rejects.toThrow('cancelled mid-flight');
    expect(attempts).toBe(1);
  });

  it('fails fast on a permanent provider rejection', async () => {
    let attempts = 0;
    const gateway = new ModelGateway({ retry: instantPolicy([]) }).register(
      'test',
      stubAdapter(async () => {
        attempts += 1;
        throw new GardenError('provider_request_failed', 'unknown model');
      })
    );

    await expect(gateway.chat('test', baseRequest)).rejects.toThrow('unknown model');
    expect(attempts).toBe(1);
  });

  it('replays a stream the connection dropped before any text reached the owner', async () => {
    let attempts = 0;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      provider: 'test',
      privacyRoute: 'provider_zdr',
      fetch: (async () => {
        attempts += 1;
        if (attempts === 1)
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new TypeError('terminated'));
              }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          );
        return new Response(
          'data: {"choices":[{"finish_reason":"stop","delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        );
      }) as typeof fetch
    });
    const deltas: string[] = [];
    const gateway = new ModelGateway({ retry: instantPolicy([]) }).register('test', adapter);

    await expect(
      gateway.chat('test', {
        ...baseRequest,
        onTextDelta: (delta) => {
          deltas.push(delta);
        }
      })
    ).resolves.toMatchObject({ text: 'recovered' });
    expect(attempts).toBe(2);
    expect(deltas).toEqual(['recovered']);
  });

  it('still rejects an unregistered provider without retrying', async () => {
    const gateway = new ModelGateway();
    await expect(gateway.chat('missing', baseRequest)).rejects.toThrow(
      'Provider missing is not configured'
    );
  });
});

describe('interrupted usage evidence', () => {
  it('does not replay a partial tool-only or unobserved response', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const failure = new GardenError('provider_unavailable', 'stream cut', 503);
    const partial = {
      ...completion(''),
      toolCalls: [{ id: 'pending', name: 'shell', arguments: { command: 'echo pending' } }]
    };
    retainInterruptedResponse(failure, partial);
    const gateway = new ModelGateway({ retry: instantPolicy(waits) }).register(
      'test',
      stubAdapter(async () => {
        attempts += 1;
        throw failure;
      })
    );
    await expect(gateway.chat('test', baseRequest)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
    expect(interruptedResponseOf(failure)).toMatchObject({
      finishReason: 'error',
      usage: partial.usage
    });
    expect(interruptedResponseOf(failure)?.metadata.requestId).toBeTruthy();
    expect(JSON.stringify(failure)).not.toContain('echo pending');
    expect(interruptedResponseOf({ response: partial })).toBeUndefined();
  });
});
