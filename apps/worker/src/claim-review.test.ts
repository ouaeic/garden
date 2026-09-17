import { describe, expect, it, vi } from 'vitest';
import type { ModelRelease } from '@athanor/contracts';
import type { ModelResponse, ModelRequest } from '@athanor/model-gateway';
import type { ToolContext } from './tool-dispatch.js';
import { parseClaimReview, reviewClaims, type ClaimSource } from './claim-review.js';

const sources: ClaimSource[] = [
  {
    id: 0,
    claim: 'The study established causation.',
    source: 'study.txt',
    text: 'This observational study found an association. Causation was not established.',
    quoteMatched: true
  }
];
const assessment = (overrides = {}) => ({
  claims: [
    {
      id: 0,
      claim: sources[0]!.claim,
      assessment: 'contradicted',
      kind: 'inference',
      explanation: 'The source explicitly does not establish causation.',
      support: [{ sourceId: 0, quote: 'Causation was not established.' }],
      conflicts: [],
      ...overrides
    }
  ],
  limitations: []
});
const model = {
  id: 'fixed',
  provider: 'custom',
  providerModelId: 'fixed',
  displayName: 'Selected model',
  usageClass: 'light',
  privacyRoute: 'provider_zdr',
  contextTokens: 128_000,
  inputUsdPerMillionTokens: 0.3,
  outputUsdPerMillionTokens: 0.5
} as ModelRelease;
function fixture() {
  const order: string[] = [];
  const recordUsage = vi.fn(async (input: { state: string }) => {
    order.push(input.state);
  });
  const chat = vi.fn<(provider?: string, request?: ModelRequest) => Promise<ModelResponse>>(
    async () => {
      order.push('provider');
      return {
        text: JSON.stringify(assessment()),
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 600, outputTokens: 300, totalTokens: 900, costUsd: 0.00033 },
        metadata: { provider: 'custom', model: 'fixed', latencyMs: 1, privacyRoute: 'provider_zdr' }
      };
    }
  );
  const taskClaim = vi.fn(async () => ({ status: 'running', leaseOwner: 'worker' }));
  const context = {
    task: { id: 'task', userId: 'owner', workspaceId: 'workspace' },
    config: { WORKER_ID: 'worker' },
    store: { recordUsage, taskClaim },
    gateway: vi.fn(async () => ({ gateway: { chat }, provider: 'custom' }))
  } as unknown as ToolContext;
  return { context, chat, taskClaim, recordUsage, order };
}
describe('bounded independent claim review', () => {
  it('reserves room for reasoning and uses only the selected model’s advertised effort', async () => {
    const f = fixture();
    await reviewClaims(
      f.context,
      {
        ...model,
        reasoning: { mandatory: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high' }
      },
      sources,
      'report',
      1,
      'turn:call'
    );
    expect(f.chat.mock.calls[0]?.[1]).toMatchObject({
      maxTokens: 8192,
      reasoningEffort: 'high',
      reasoningOptions: { supportedEfforts: ['low', 'high'] }
    });
    expect(f.recordUsage.mock.calls[0]![0]).toMatchObject({
      state: 'reserved',
      reserveAgainstCaps: true
    });
    expect(f.order).toEqual(['reserved', 'provider', 'settled']);
  });
  it('honors a smaller provider output bound and reports an exhausted response without accepting claims', async () => {
    const f = fixture();
    const response = await f.chat();
    f.chat.mockClear();
    f.chat.mockResolvedValue({ ...response, finishReason: 'length' });
    const limited = { ...model, maxOutputTokens: 4096 };
    const result = await reviewClaims(f.context, limited, sources, 'report', 1, 'turn:call');
    expect(f.chat.mock.calls[0]?.[1]?.maxTokens).toBe(4096);
    expect(result).toMatchObject({
      status: 'unavailable',
      claims: [],
      limitations: ['The review reached its output limit; no conclusion was accepted.']
    });
    expect(f.recordUsage.mock.calls.map(([entry]) => entry.state)).toEqual(['reserved', 'settled']);
  });
  it('does not accept a syntactically complete assessment from an interrupted response', async () => {
    const f = fixture();
    const response = await f.chat();
    f.chat.mockResolvedValue({
      ...response,
      truncated: { reason: 'framing', detail: 'Excess stream metadata' }
    });
    const result = await reviewClaims(f.context, model, sources, 'report', 1, 'turn:call');
    expect(result).toMatchObject({
      status: 'unavailable',
      claims: [],
      limitations: ['The review was interrupted: Excess stream metadata']
    });
  });
  it('keeps a real quotation distinct from an unsupported causal conclusion', async () => {
    const f = fixture();
    const result = await reviewClaims(
      f.context,
      model,
      sources,
      'The study established causation.',
      1,
      'turn:call'
    );
    expect(result).toMatchObject({
      status: 'reviewed',
      claims: [{ assessment: 'contradicted', kind: 'inference' }],
      usageCredits: 0.001
    });
    expect(f.order).toEqual(['reserved', 'provider', 'settled']);
    expect(f.recordUsage.mock.calls[1]![0]).toMatchObject({
      settleReservation: true,
      costUsd: 0.00033,
      quantity: 900,
      credits: 0.001
    });
    const args = f.chat.mock.calls[0] as unknown as [
      string,
      { messages: { role: string; content: string }[]; tools: unknown[]; signal: AbortSignal },
      { retry: boolean }
    ];
    expect(args[0]).toBe('custom');
    expect(args[1].messages).toHaveLength(2);
    expect(args[1].messages[0]!.content).toContain('Old figures cannot establish a current figure');
    expect(args[1].messages[0]!.content).toContain('Silence cannot establish a negative claim');
    expect(args[1].messages[1]!.content).toContain('Everything between the markers');
    expect(args[1].tools).toEqual([]);
    expect(args[2]).toEqual({ retry: false });
  });
  it.each(['supported', 'contradicted'] as const)(
    'does not accept %s without traceable supporting text',
    (value) => {
      expect(
        parseClaimReview(JSON.stringify(assessment({ assessment: value, support: [] })), sources)
          .claims[0]!.assessment
      ).toBe('insufficient');
      expect(() =>
        parseClaimReview(
          JSON.stringify(
            assessment({ support: [{ sourceId: 0, quote: 'The treatment cured every patient.' }] })
          ),
          sources
        )
      ).toThrow('outside the supplied evidence');
    }
  );
  it('retains contradictory sources as unresolved instead of choosing a positive verdict', () => {
    const conflicting = [
      ...sources,
      {
        id: 1,
        claim: 'The current rate is 12.',
        source: 'prices.txt',
        text: '2026 current rate: 10. The old rate of 12 ended in 2024.',
        quoteMatched: true
      }
    ];
    const output = assessment({ assessment: 'supported', conflicts: [1] });
    output.claims.push({
      id: 1,
      claim: conflicting[1]!.claim,
      assessment: 'contradicted',
      kind: 'inference',
      explanation: 'The quoted number is historical.',
      support: [{ sourceId: 1, quote: '2026 current rate: 10.' }],
      conflicts: []
    });
    expect(
      parseClaimReview(JSON.stringify(output), conflicting).claims.map((claim) => claim.assessment)
    ).toEqual(['insufficient', 'contradicted']);
  });
  it('rejects missing, duplicate and invented identities without accepting a partial result', () => {
    const outputs = [
      { claims: [], limitations: [] },
      assessment({ id: 9 }),
      assessment({ claim: 'The study did not establish causation.' }),
      { ...assessment(), claims: [...assessment().claims, ...assessment().claims] },
      assessment({ conflicts: [99] })
    ];
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs)
      expect(() => parseClaimReview(JSON.stringify(output), sources)).toThrow();
  });
  it('binds a review to the target claim rather than a different proposal in the background report', async () => {
    const f = fixture();
    const target = { ...sources[0]!, claim: 'The study did not establish causation.' };
    const result = await reviewClaims(
      f.context,
      model,
      [target],
      'Assess the proposal: The study established causation.',
      1,
      'binding'
    );
    expect(result.status).toBe('unavailable');
    expect(result.claims).toEqual([]);
    expect(f.recordUsage.mock.calls.map(([entry]) => entry.state)).toEqual(['reserved', 'settled']);
    const response = await f.chat();
    f.chat.mockResolvedValue({
      ...response,
      text: JSON.stringify(
        assessment({
          claim: target.claim,
          assessment: 'supported',
          kind: 'observation',
          explanation: 'The target preserves the source’s explicit negation.'
        })
      )
    });
    const corrected = await reviewClaims(
      f.context,
      model,
      [target],
      'Assess the proposal: The study established causation.',
      1,
      'binding-corrected'
    );
    expect(corrected).toMatchObject({
      status: 'reviewed',
      claims: [{ claim: target.claim, assessment: 'supported' }]
    });
    const prompt = f.chat.mock.calls[0]![1]!.messages[1]!.content;
    expect(prompt).toContain(
      '"targets":[{"id":0,"claim":"The study did not establish causation."}]'
    );
    expect(prompt).toContain('"background":');
  });
  it.each(['price', 'compute', 'context', 'cancelled', 'reservation', 'no-quotation'] as const)(
    'skips a review safely when %s prevents submission',
    async (condition) => {
      const f = fixture();
      if (condition === 'cancelled')
        f.taskClaim.mockResolvedValue({ status: 'cancelled', leaseOwner: 'worker' });
      if (condition === 'reservation') f.recordUsage.mockRejectedValue(new Error('cap reached'));
      const result = await reviewClaims(
        f.context,
        condition === 'price'
          ? ({ ...model, inputUsdPerMillionTokens: undefined } as unknown as ModelRelease)
          : condition === 'context'
            ? { ...model, contextTokens: 4000 }
            : model,
        condition === 'no-quotation' ? [{ ...sources[0]!, quoteMatched: false }] : sources,
        'report',
        condition === 'compute' ? 0 : 1,
        'turn:call'
      );
      expect(result.status).toBe('unavailable');
      expect(result.usageCredits).toBe(0);
      expect(f.chat).not.toHaveBeenCalled();
    }
  );
  it('holds a lost-response reservation and does not retry or fabricate an assessment', async () => {
    const f = fixture();
    f.chat.mockRejectedValue(new Error('connection lost'));
    const result = await reviewClaims(f.context, model, sources, 'report', 1, 'turn:call');
    expect(result.status).toBe('unavailable');
    expect(result.usageCredits).toBeGreaterThan(0);
    expect(f.chat).toHaveBeenCalledTimes(1);
    expect(f.recordUsage).toHaveBeenCalledTimes(1);
    expect(f.recordUsage.mock.calls[0]![0]).toMatchObject({
      state: 'reserved',
      reserveAgainstCaps: true
    });
  });
  it('records the charge for malformed output but does not accept its conclusion', async () => {
    const f = fixture();
    const original = await f.chat();
    f.chat.mockClear();
    f.chat.mockResolvedValue({ ...original, text: 'Absolutely verified!' });
    const result = await reviewClaims(f.context, model, sources, 'report', 1, 'turn:call');
    expect(result).toMatchObject({ status: 'unavailable', claims: [], usageCredits: 0.001 });
    expect(f.recordUsage.mock.calls.map(([call]) => call.state)).toEqual(['reserved', 'settled']);
  });
  it('retains a conservative charge for estimated usage', async () => {
    const f = fixture();
    const original = await f.chat();
    f.chat.mockResolvedValue({ ...original, usage: { ...original.usage, estimated: true } });
    const result = await reviewClaims(f.context, model, sources, 'report', 1, 'turn:call');
    expect(result.status).toBe('reviewed');
    expect(result.usageCredits).toBeGreaterThan(0.001);
    expect(f.recordUsage).toHaveBeenCalledTimes(1);
  });
  it('cancels an in-flight review when the task lease stops', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.chat.mockImplementation(
        async (_provider, request) =>
          new Promise((_resolve, reject) => {
            request?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true
            });
          })
      );
      const reviewing = reviewClaims(f.context, model, sources, 'report', 1, 'turn:call');
      await vi.advanceTimersByTimeAsync(1);
      expect(f.chat).toHaveBeenCalledTimes(1);
      f.taskClaim.mockResolvedValue({ status: 'cancelled', leaseOwner: 'worker' });
      await vi.advanceTimersByTimeAsync(3100);
      expect(await reviewing).toMatchObject({ status: 'unavailable', claims: [] });
      expect(f.recordUsage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('uses the coding-family reservation without creating a duplicate standalone reservation', async () => {
    const f = fixture();
    f.context.task.hasCodingFamily = true;
    const original = await f.chat();
    f.chat.mockResolvedValue({ ...original, codingReservationId: 'family-receipt' });
    const result = await reviewClaims(f.context, model, sources, 'report', 1, 'turn:call');
    expect(result.status).toBe('reviewed');
    expect(f.recordUsage).toHaveBeenCalledTimes(1);
    expect(f.recordUsage.mock.calls[0]![0]).toMatchObject({
      state: 'settled',
      codingReservationId: 'family-receipt'
    });
    expect(f.recordUsage.mock.calls[0]![0]).not.toHaveProperty('reserveAgainstCaps');
  });
});
