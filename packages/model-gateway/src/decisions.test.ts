import { describe, expect, it, vi } from 'vitest';
import {
  OpenRouterDecisionAdapter,
  validateDecisionInput,
  validateDecisionAnswers
} from './decisions.js';
import { ModelGateway } from './gateway.js';
import { refreshOpenRouterCatalog } from './openrouter-catalog.js';

const input = {
  state: 'The experiment measured association, not causation.',
  questions: {
    support: {
      type: 'choice' as const,
      instructions: 'Does this establish causation?',
      criteria: {
        yes: 'Causation established',
        no: 'Causation not established',
        unknown: 'Insufficient evidence'
      }
    },
    relevance: {
      type: 'score' as const,
      instructions: 'Rate relevance to causal evidence.',
      criteria: ['irrelevant', 'related', 'direct']
    },
    association: { type: 'noul' as const, instructions: 'Was an association measured?' }
  }
};
const answers = {
  support: { type: 'choice', choice: 'no', confidence: 0.8 },
  relevance: { type: 'score', score: 1.8 },
  association: { type: 'noul', noul: 0.99 }
};
const response = {
  model: 'typesafe/jev-version',
  answers,
  id: 'decision-generation',
  provider: 'TypeSafe',
  usage: { input_tokens: 100, output_tokens: 30, cost: 0.0000042 }
};
const request = {
  ...input,
  model: 'typesafe/jev',
  inputRate: 0.042,
  outputRate: 0,
  sessionId: 'task:decision',
  signal: AbortSignal.timeout(10_000)
};

describe('decision protocol', () => {
  it('sends independent questions immediately on the separate route, preserving privacy and prices', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response)));
    const gateway = new ModelGateway().registerDecisions(
      'openrouter',
      new OpenRouterDecisionAdapter({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'fixture',
        enforceZeroDataRetention: true,
        fetch: transport
      })
    );
    const result = await gateway.decide('openrouter', request);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe('https://openrouter.ai/api/alpha/decisions');
    const init = transport.mock.calls[0]![1]!;
    expect(init.redirect).toBe('error');
    expect(typeof init.body).toBe('string');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      ...input,
      session_id: 'task:decision',
      provider: { zdr: true, data_collection: 'deny', max_price: { prompt: 0.042, completion: 0 } }
    });
    expect(body.messages).toBeUndefined();
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      costUsd: 0.0000042
    });
    expect(validateDecisionAnswers(input, result.answers)).toEqual(answers);
    await expect(
      gateway.chat('openrouter', { model: 'typesafe/jev', messages: [], tools: [], temperature: 0 })
    ).rejects.toThrow(/not configured/);
  });

  it.each([
    {},
    { ...answers, extra: answers.support },
    { ...answers, support: { type: 'choice', choice: 'invented' } },
    { ...answers, support: { type: 'choice', choice: 'no', confidence: 1.1 } },
    { ...answers, relevance: { type: 'score', score: 3 } },
    { ...answers, association: { type: 'noul', noul: -0.1 } },
    { ...answers, support: { type: 'noul', noul: 1 } }
  ])('rejects incomplete, invented or out-of-range answers', (value) => {
    expect(() => validateDecisionAnswers(input, value)).toThrow();
  });

  it('rejects empty and degenerate questions before any network call', () => {
    expect(() => validateDecisionInput({ ...input, questions: {} })).toThrow();
    expect(() =>
      validateDecisionInput({
        ...input,
        questions: { one: { type: 'choice', instructions: 'Select', criteria: { yes: 'Yes' } } }
      })
    ).toThrow();
  });

  it('retains usage for invalid answers and does not retry a failed attempt', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...response, answers: {} })))
      .mockResolvedValue(new Response('unavailable', { status: 503 }));
    const adapter = new OpenRouterDecisionAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'fixture',
      enforceZeroDataRetention: true,
      fetch: transport
    });
    const result = await adapter.decide(request);
    expect(result.usage.inputTokens).toBe(100);
    expect(() => validateDecisionAnswers(input, result.answers)).toThrow();
    await expect(adapter.decide(request)).rejects.toThrow(/503/);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not forward the key to an unrelated endpoint', async () => {
    const transport = vi.fn<typeof fetch>();
    const adapter = new OpenRouterDecisionAdapter({
      baseUrl: 'https://unrelated.invalid/api/v1',
      apiKey: 'fixture',
      enforceZeroDataRetention: true,
      fetch: transport
    });
    await expect(adapter.decide(request)).rejects.toThrow(/does not offer/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('discovers decision output without presenting it as chat, tools or a media generator', async () => {
    const transport = vi.fn<typeof fetch>(
      async (url) =>
        new Response(
          JSON.stringify(
            (url instanceof Request ? url.url : url.toString()).includes('/models?')
              ? {
                  data: [
                    {
                      id: 'typesafe/jev',
                      context_length: 32000,
                      architecture: {
                        input_modalities: ['text'],
                        output_modalities: ['decisions']
                      },
                      supported_parameters: ['tools'],
                      pricing: { prompt: '0.000000042', completion: '0' }
                    }
                  ]
                }
              : { data: [{ model_id: 'typesafe/jev', status: 0 }] }
          )
        )
    );
    const catalog = await refreshOpenRouterCatalog([], {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'fixture',
      fetch: transport
    });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      providerModelId: 'typesafe/jev',
      capabilities: ['decisions'],
      inputUsdPerMillionTokens: 0.042,
      outputUsdPerMillionTokens: 0,
      zeroDataRetentionAvailable: true
    });
    const called = transport.mock.calls[0]![0];
    expect(called instanceof Request ? called.url : called.toString()).toContain(
      'output_modalities=all'
    );
  });
});
