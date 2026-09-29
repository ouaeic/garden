/**
 * The strip beside CPU and RAM, and the two ways it has been wrong.
 *
 * `/api/v1/credits` and `/api/v1/key` are different OpenRouter routes with different field names,
 * and the reader asked the first for the second's — `usage` and `limit` against a body that
 * publishes `total_credits` and `total_usage`. Both were optional, so every response parsed and
 * produced two nulls, and the balance was never shown to anybody. Nothing failed; the strip simply
 * rendered a dash. These fixtures are the real response shapes, so the next rename fails here
 * rather than in front of an owner.
 */
import { describe, expect, it } from 'vitest';
import { planUsageFor } from './plan-usage.js';

const respond = (body: unknown, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body
  }) as unknown as Response;

/** Answers each OpenRouter route with its own documented shape. */
const openRouterFetch = (credits: unknown, key: unknown, keyOk = true) =>
  (async (input: string) => {
    if (input.endsWith('/key')) return respond(key, keyOk);
    return respond(credits);
  }) as unknown as typeof fetch;

describe('what an OpenRouter account has left', () => {
  it('reads the balance from the fields /credits actually publishes', async () => {
    const usage = await planUsageFor(
      'openrouter',
      'key',
      openRouterFetch({ data: { total_credits: 25, total_usage: 4 } }, { data: {} })
    );
    expect(usage?.windows[0]).toMatchObject({
      label: 'Credit balance',
      used: 4,
      limit: 25,
      unit: 'usd'
    });
  });

  it('adds the key ceiling only when the key has one', async () => {
    const withLimit = await planUsageFor(
      'openrouter',
      'key',
      openRouterFetch(
        { data: { total_credits: 25, total_usage: 4 } },
        { data: { limit: 10, limit_remaining: 7, usage: 3 } }
      )
    );
    expect(withLimit?.windows.map((window) => window.label)).toEqual([
      'Credit balance',
      'Key limit'
    ]);
    // The key's limit is measured against the key's own spend, not the account's.
    expect(withLimit?.windows[1]).toMatchObject({ used: 3, limit: 10, unit: 'usd' });

    const unlimited = await planUsageFor(
      'openrouter',
      'key',
      openRouterFetch({ data: { total_credits: 25, total_usage: 4 } }, { data: { limit: null } })
    );
    expect(unlimited?.windows.map((window) => window.label)).toEqual(['Credit balance']);
  });

  it('still reports the balance when the key route will not answer', async () => {
    const usage = await planUsageFor(
      'openrouter',
      'key',
      openRouterFetch({ data: { total_credits: 25, total_usage: 4 } }, null, false)
    );
    expect(usage?.windows).toHaveLength(1);
    expect(usage?.windows[0]?.limit).toBe(25);
  });

  it('says nothing rather than nought when the account route publishes no figures', async () => {
    const usage = await planUsageFor(
      'openrouter',
      'key',
      openRouterFetch({ data: {} }, { data: {} })
    );
    expect(usage?.windows[0]).toMatchObject({ used: null, limit: null });
  });
});

describe('what an Ollama Cloud plan has left', () => {
  it('reports its windows as fractions, which is the unit it publishes', async () => {
    const usage = await planUsageFor('ollama-cloud', 'key', (async () =>
      respond({
        activity: { period: { ending_at: '2026-09-10T00:00:00.000Z' } },
        limits: { session: { usage: 0.25 }, weekly: { usage: 0.5 } }
      })) as unknown as typeof fetch);
    expect(usage?.windows).toEqual([
      {
        label: 'Session window',
        used: 0.25,
        limit: 1,
        unit: 'fraction',
        resetsAt: '2026-09-10T00:00:00.000Z'
      },
      {
        label: 'Weekly window',
        used: 0.5,
        limit: 1,
        unit: 'fraction',
        resetsAt: '2026-09-10T00:00:00.000Z'
      }
    ]);
  });
});

describe('balances from a model company’s own account endpoint', () => {
  it('shows a DeepSeek dollar balance and ignores other currencies', async () => {
    const answer = (infos: unknown) => async () =>
      new Response(JSON.stringify({ is_available: true, balance_infos: infos }));
    const usd = await planUsageFor(
      'openai-compatible',
      'key',
      answer([
        { currency: 'CNY', total_balance: '80.00' },
        { currency: 'USD', total_balance: '12.50' }
      ]) as typeof fetch,
      'https://api.deepseek.com/v1'
    );
    expect(usd?.windows).toEqual([
      expect.objectContaining({ label: 'Credit balance', remaining: 12.5, unit: 'usd' })
    ]);
    const yuanOnly = await planUsageFor(
      'openai-compatible',
      'key',
      answer([{ currency: 'CNY', total_balance: '80.00' }]) as typeof fetch,
      'https://api.deepseek.com/v1'
    );
    expect(yuanOnly).toBeNull();
  });

  it('shows a Moonshot balance, and nothing for a company that publishes none', async () => {
    const moonshot = await planUsageFor(
      'openai-compatible',
      'key',
      (async () =>
        new Response(
          JSON.stringify({ code: 0, data: { available_balance: 4.2 } })
        )) as typeof fetch,
      'https://api.moonshot.ai/v1'
    );
    expect(moonshot?.windows[0]).toMatchObject({ remaining: 4.2 });
    let asked = false;
    const anthropic = await planUsageFor(
      'openai-compatible',
      'key',
      (async () => {
        asked = true;
        return new Response('{}');
      }) as typeof fetch,
      'https://api.anthropic.com/v1'
    );
    expect(anthropic).toBeNull();
    expect(asked).toBe(false);
  });
});
