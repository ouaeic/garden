import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredModelCatalog } from './catalog.js';
import { forgetListPrices, listPriceName, withListPrices } from './list-prices.js';

const feed = () =>
  new Response(
    JSON.stringify({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.5',
          pricing: {
            prompt: '0.000003',
            completion: '0.000015',
            input_cache_read: '0.0000003',
            input_cache_write: '0.00000375'
          }
        },
        { id: 'anthropic/claude-sonnet-4.5:thinking', pricing: { prompt: '1', completion: '1' } },
        { id: 'openai/gpt-5', pricing: { prompt: '0.00000125', completion: '0.00001' } },
        {
          id: 'meta-llama/llama-3.3-70b',
          pricing: { prompt: '0.0000001', completion: '0.0000003' }
        }
      ]
    })
  );

const rows = (ids: string[]) =>
  configuredModelCatalog(
    ids.map((id) => ({
      id,
      displayName: id,
      contextTokens: null,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      maxOutputTokens: null,
      supportsTools: null,
      supportsReasoningEffort: null,
      unknownFields: [],
      metadataSource: 'unknown' as const
    })),
    {
      privacyRoute: 'external',
      contextTokens: 128_000,
      capabilities: ['chat', 'tools'],
      modalities: ['text'],
      tag: 'Configured endpoint',
      connectionId: 'openai-compatible:test'
    }
  );

afterEach(() => forgetListPrices());

describe('list prices for a direct key', () => {
  it('reads one spelling for dated, dotted and suffixed names', () => {
    expect(listPriceName('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(listPriceName('claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
    expect(listPriceName('models/gemini-2.5-pro')).toBe('gemini-2-5-pro');
    expect(listPriceName('mistral-large-latest')).toBe('mistral-large');
  });

  it('prices a Claude model from its maker’s list price, cache rates included', async () => {
    const fetch = vi.fn(async () => feed());
    const [claude, unknown] = await withListPrices(
      rows(['claude-sonnet-4-5-20250929', 'claude-unreleased']),
      'https://api.anthropic.com/v1',
      fetch as typeof globalThis.fetch
    );
    expect(claude).toMatchObject({
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
      cacheReadUsdPerMillionTokens: 0.3,
      cacheWriteUsdPerMillionTokens: 3.75,
      usageClass: 'medium'
    });
    expect(claude!.recommendationTags).toContain('List price');
    // A name the list does not know stays unpriced rather than borrowing another model's price.
    expect(unknown!.inputUsdPerMillionTokens).toBeNull();
    // The request carries nothing of the owner's: no key, no header, just the public list.
    expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', expect.anything());
    expect(JSON.stringify(fetch.mock.calls)).not.toMatch(/authorization|bearer/i);
  });

  it('leaves a host of open models unpriced, and never blocks on an unreadable list', async () => {
    const fetch = vi.fn(async () => feed());
    const [llama] = await withListPrices(
      rows(['llama-3.3-70b']),
      'https://api.groq.com/openai/v1',
      fetch as typeof globalThis.fetch
    );
    expect(llama!.inputUsdPerMillionTokens).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const [gpt] = await withListPrices(
      rows(['gpt-5']),
      'https://api.openai.com/v1',
      (async () => new Response('down', { status: 503 })) as typeof globalThis.fetch
    );
    expect(gpt!.inputUsdPerMillionTokens).toBeNull();
  });
});
