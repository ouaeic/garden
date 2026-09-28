import { describe, expect, it, vi } from 'vitest';
import type { ModelRelease } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import type { ModelAdapter, ModelRequest } from '@garden/model-gateway';
import { codingMissionAdapter } from './coding-mission-gateway.js';
const model = {
  id: 'test',
  usageClass: 'medium',
  contextTokens: 128000,
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 4
} as ModelRelease;
const request = {
  model: 'test',
  messages: [{ role: 'user', content: 'Edit the parser' }],
  maxTokens: 1000
} as ModelRequest;
const response = {
  text: 'done',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.00018 },
  metadata: { provider: 'custom', model: 'test' }
};
describe('coding inference reservations', () => {
  const fixture = (family = true, chosen = model) => {
    const order: string[] = [];
    const store = {
      reserveCodingInference: vi.fn(async () => {
        order.push('reserve');
        return 'reservation';
      }),
      settleCodingInference: vi.fn(async () => {
        order.push('settle');
      })
    };
    const adapter = {
      provider: 'custom',
      privacyRoute: 'provider_zdr',
      list: vi.fn(async () => []),
      chat: vi.fn(async (request: ModelRequest) => {
        void request;
        order.push('provider');
        return response;
      })
    };
    const wrapped = codingMissionAdapter(
      adapter as unknown as ModelAdapter,
      store as unknown as DataStore,
      { id: 'task', hasCodingFamily: family } as TaskRecord,
      chosen,
      'worker'
    );
    return { store, adapter, wrapped, order };
  };
  it('reserves before any provider call, settles actual dollars and attaches only a local ledger receipt', async () => {
    const f = fixture();
    const result = await f.wrapped.chat(request);
    expect(f.order).toEqual(['reserve', 'provider', 'settle']);
    expect(f.store.reserveCodingInference.mock.calls[0]).toHaveLength(4);
    expect(f.store.settleCodingInference).toHaveBeenCalledWith(
      'reservation',
      expect.any(Number),
      0.00018
    );
    expect(result.codingReservationId).toBe('reservation');
    expect(f.adapter.chat.mock.calls[0]![0]).not.toHaveProperty('codingReservationId');
  });
  it('never sends a denied attempt and retains an unknown provider acceptance as committed capacity', async () => {
    const denied = fixture();
    denied.store.reserveCodingInference.mockRejectedValue(new Error('ceiling'));
    await expect(denied.wrapped.chat(request)).rejects.toThrow('ceiling');
    expect(denied.adapter.chat).not.toHaveBeenCalled();
    const uncertain = fixture();
    uncertain.adapter.chat.mockRejectedValue(new Error('lost reply'));
    await expect(uncertain.wrapped.chat(request)).rejects.toThrow('lost reply');
    expect(uncertain.store.settleCodingInference).toHaveBeenCalledWith('reservation', null);
  });
  it('adds no reservation queries to an ordinary task', async () => {
    const f = fixture(false);
    expect(await f.wrapped.chat(request)).toBe(response);
    expect(f.store.reserveCodingInference).not.toHaveBeenCalled();
    expect(f.store.settleCodingInference).not.toHaveBeenCalled();
  });
  it('reserves native modality tariffs and keeps ambiguous family media exposure held', async () => {
    const route = {
      ...model,
      nativeInputPricing: { audioUsdPerMillionTokens: 20, videoUsdPerMillionTokens: 20 }
    };
    const f = fixture(true, route);
    const mediaRequest = {
      ...request,
      nativeInputRequestId: 'a'.repeat(64),
      messages: [
        {
          role: 'user' as const,
          content: 'listen',
          nativeInputs: [{ kind: 'audio' as const, mimeType: 'audio/wav' as const, data: 'AAAA' }]
        }
      ]
    };
    f.adapter.chat.mockResolvedValue({
      ...response,
      usage: { ...response.usage, estimated: true }
    } as typeof response);
    const result = await f.wrapped.chat(mediaRequest);
    const reservation = f.store.reserveCodingInference.mock.calls[0] as unknown as unknown[];
    expect(reservation).toHaveLength(5);
    expect(reservation[4]).toBe(mediaRequest.nativeInputRequestId);
    expect(Number(reservation[3])).toBeGreaterThanOrEqual((route.contextTokens * 20) / 1e6);
    expect(f.store.settleCodingInference).toHaveBeenCalledExactlyOnceWith('reservation', null);
    expect(result.nativeInputUsageRecorded).toBe(true);
    expect(result.usage.costUsd).toBe(Number(reservation[3]));
  });
});
