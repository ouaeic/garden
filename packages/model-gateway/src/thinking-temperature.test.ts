import { expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { ModelRequest } from './protocol.js';

/** The body the adapter put on the wire for one request. */
const sent = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
  let body: Record<string, unknown> = {};
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return Response.json({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
  });
  const adapter = new OpenAICompatibleAdapter({
    provider: 'custom',
    privacyRoute: 'external',
    baseUrl: 'https://models.example/v1',
    fetch
  });
  await adapter.chat(
    ModelRequest.parse({
      model: 'thinker',
      messages: [{ role: 'user', content: 'work' }],
      ...request
    })
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  return body;
};

it('sends a thinking request no temperature, and a plain one the temperature it was given', async () => {
  const thinking = await sent({ reasoningEffort: 'medium', temperature: 0.2 });
  expect(thinking.reasoning_effort).toBe('medium');
  expect(thinking).not.toHaveProperty('temperature');

  const plain = await sent({ temperature: 0.2 });
  expect(plain).not.toHaveProperty('reasoning_effort');
  expect(plain.temperature).toBe(0.2);

  // A route that says it takes no effort is not asked to think, so it keeps its temperature.
  const declined = await sent({
    reasoningEffort: 'medium',
    supportsReasoningEffort: false,
    temperature: 0.2
  });
  expect(declined).not.toHaveProperty('reasoning_effort');
  expect(declined.temperature).toBe(0.2);
});
