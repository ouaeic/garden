import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GardenError, withPrivateDiagnostics, type PrivateDiagnosticKind } from '@garden/core';
import { ModelGateway } from './gateway.js';
import { retainInterruptedResponse } from './interrupted-response.js';
import type { ModelAdapter, ModelRequest, ModelResponse } from './protocol.js';
const completion: ModelResponse = {
  text: 'private reply',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  metadata: { provider: 'test', model: 'test', latencyMs: 1, privacyRoute: 'provider_zdr' }
};
const request: ModelRequest = {
  model: 'test',
  messages: [{ role: 'user', content: 'private prompt' }],
  tools: [],
  temperature: 0.2
};
const fixture = (chat: ModelAdapter['chat']) =>
  new ModelGateway({
    retry: {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      maxRetryAfterMs: 0,
      random: () => 0,
      sleep: async () => {}
    }
  }).register('test', {
    provider: 'test',
    privacyRoute: 'provider_zdr',
    list: async () => [],
    chat
  });
const recorder = () => {
  const rows: { kind: PrivateDiagnosticKind; data: unknown }[] = [];
  return {
    rows,
    sink: {
      record: async (kind: PrivateDiagnosticKind, data: unknown) => {
        rows.push({ kind, data });
      }
    }
  };
};
describe('model diagnostic projections', () => {
  it('records each actual attempt, strips extra managed fields and preserves prompt content only in the private sink', async () => {
    let attempts = 0;
    const gateway = fixture(async () => {
      if (++attempts === 1)
        throw new GardenError('provider_unavailable', 'MANAGED_SECRET', 503, { status: 503 });
      return { ...completion, apiKey: 'MANAGED_SECRET' } as ModelResponse;
    });
    const capture = recorder();
    await withPrivateDiagnostics(capture.sink, () =>
      gateway.chat('test', {
        ...request,
        apiKey: 'MANAGED_SECRET',
        onTextDelta: () => {}
      } as ModelRequest)
    );
    expect(capture.rows.map((row) => row.kind)).toEqual([
      'model_request',
      'model_attempt',
      'model_outcome',
      'model_attempt',
      'model_outcome',
      'model_end'
    ]);
    expect(JSON.stringify(capture.rows)).not.toContain('MANAGED_SECRET');
    expect(JSON.stringify(capture.rows)).toContain('private prompt');
    expect(JSON.stringify(capture.rows)).toContain('private reply');
    const failing = {
      record: vi.fn(async () => {
        throw Error('capture failed');
      }),
      fail: vi.fn(async () => {})
    };
    await expect(
      withPrivateDiagnostics(failing, () => fixture(async () => completion).chat('test', request))
    ).resolves.toEqual({
      ...completion,
      metadata: { ...completion.metadata, requestId: expect.any(String) }
    });
    expect(failing.fail).toHaveBeenCalled();
  });
  it('records a partial interruption without replaying a paid request', async () => {
    const chat = vi.fn(async () => {
      const error = new GardenError('provider_unavailable', 'cut', 503);
      retainInterruptedResponse(error, completion);
      throw error;
    });
    const capture = recorder();
    await expect(
      withPrivateDiagnostics(capture.sink, () => fixture(chat).chat('test', request))
    ).rejects.toThrow('cut');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(capture.rows.at(-2)).toMatchObject({
      kind: 'model_outcome',
      data: { outcome: 'interrupted', response: { text: 'private reply' } }
    });
  });
  it('captures live decision input and answer without connection secrets', async () => {
    const capture = recorder();
    const gateway = fixture(async () => completion).registerDecisions('test', {
      decide: async () => ({
        answers: { gate: { type: 'noul', noul: 0.9 } },
        usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
        metadata: { model: 'decision', latencyMs: 1 }
      })
    });
    await withPrivateDiagnostics(capture.sink, () =>
      gateway.decide('test', {
        model: 'decision',
        state: 'private evidence',
        questions: { gate: { type: 'noul', instructions: 'Does the evidence meet the rule?' } },
        inputRate: 0,
        outputRate: 0,
        sessionId: randomUUID(),
        signal: new AbortController().signal
      })
    );
    expect(capture.rows.map((row) => row.kind)).toEqual(['decision_request', 'decision_outcome']);
    expect(capture.rows[1]).toMatchObject({
      data: { response: { answers: { gate: { noul: 0.9 } } } }
    });
  });
});
