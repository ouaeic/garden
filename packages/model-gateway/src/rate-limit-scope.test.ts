import { describe, expect, it } from 'vitest';
import { GardenError } from '@garden/core';
import { OpenAICompatibleAdapter, isModelScopedLimit } from './openai-compatible.js';

const refusal = (message: string) =>
  new Response(
    JSON.stringify({ error: { code: 429, message, metadata: { provider_name: 'Host' } } }),
    {
      status: 429
    }
  );

const refusedWith = async (message: string) => {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'key',
    provider: 'openrouter',
    privacyRoute: 'external',
    fetch: async () => refusal(message)
  });
  return adapter
    .chat({
      model: 'vendor/model',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      temperature: 0
    })
    .then(
      () => null,
      (error: unknown) => error
    );
};

describe('the scope of a rate limit', () => {
  it('names a limit on one model host so the task can step around that model', async () => {
    const error = await refusedWith(
      'vendor/model is temporarily rate-limited upstream. Please retry shortly.'
    );
    expect(error).toBeInstanceOf(GardenError);
    expect((error as GardenError).code).toBe('provider_quota_exhausted');
    expect((error as GardenError).details).toMatchObject({ limitScope: 'model' });
  });

  it('leaves an account limit unscoped, so the whole provider is treated as walled', async () => {
    const error = await refusedWith('Rate limit exceeded: free-models-per-day');
    expect((error as GardenError).code).toBe('provider_quota_exhausted');
    expect((error as GardenError).details?.limitScope).toBeUndefined();
    expect(isModelScopedLimit(503, 'rate-limited upstream')).toBe(false);
  });
});
