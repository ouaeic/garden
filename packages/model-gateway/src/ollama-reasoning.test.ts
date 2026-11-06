import { expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { configuredModelCatalog } from './catalog.js';
import { ModelRequest } from './protocol.js';

it('discovers Ollama thinking support and carries the selected effort into the request', async () => {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/models'))
      return Response.json({
        data: [{ id: 'gpt-oss:120b' }, { id: 'qwen3.5:397b' }, { id: 'plain' }]
      });
    expect(typeof init?.body).toBe('string');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/api/show')) {
      return Response.json({
        capabilities: body.model === 'plain' ? ['completion'] : ['completion', 'thinking']
      });
    }
    expect(body).toMatchObject({ model: 'gpt-oss:120b', reasoning_effort: 'high' });
    return Response.json({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
  });
  const adapter = new OpenAICompatibleAdapter({
    provider: 'custom',
    privacyRoute: 'external',
    baseUrl: 'https://ollama.com/v1',
    fetch
  });
  const described = await adapter.describe();
  const catalog = configuredModelCatalog(described, {
    privacyRoute: 'external',
    contextTokens: 32000,
    capabilities: ['chat', 'tools'],
    modalities: ['text'],
    tag: 'Ollama Cloud'
  });
  expect(catalog).toHaveLength(3);
  expect(catalog[0]).toMatchObject({
    supportsReasoningEffort: true,
    reasoning: { mandatory: true, supportedEfforts: ['low', 'medium', 'high'] }
  });
  expect(catalog[1]).toMatchObject({
    supportsReasoningEffort: true,
    reasoning: { mandatory: false, supportedEfforts: ['none', 'low', 'medium', 'high', 'max'] }
  });
  expect(catalog[2]).toMatchObject({ supportsReasoningEffort: false });
  await adapter.chat(
    ModelRequest.parse({
      model: catalog[0]!.providerModelId,
      messages: [{ role: 'user', content: 'work' }],
      reasoningEffort: 'high',
      reasoningOptions: catalog[0]!.reasoning,
      supportsReasoningEffort: catalog[0]!.supportsReasoningEffort
    })
  );
  expect(fetch).toHaveBeenCalledTimes(5);
});

it('keeps available models when metadata fails, and never probes other endpoints as Ollama', async () => {
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/models'))
      return Response.json({ data: [{ id: 'gpt-oss:120b' }] });
    return new Response('', { status: 503 });
  });
  for (const baseUrl of ['https://ollama.com/v1', 'https://ollama.com.example/v1']) {
    const adapter = new OpenAICompatibleAdapter({
      provider: 'custom',
      privacyRoute: 'external',
      baseUrl,
      fetch
    });
    const models = await adapter.describe();
    expect(models).toHaveLength(1);
    expect(models[0]?.reasoning).toBeUndefined();
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("reads an Ollama model's window and tool support, so a new model is known rather than skipped", async () => {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/models'))
      return Response.json({ data: [{ id: 'deepseek-v4.1-flash:1017' }, { id: 'bare' }] });
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return Response.json(
      body.model === 'bare'
        ? { capabilities: ['completion'] }
        : {
            capabilities: ['completion', 'tools', 'thinking'],
            model_info: { 'deepseek4.context_length': 163840, 'general.architecture': 'deepseek4' }
          }
    );
  });
  const adapter = new OpenAICompatibleAdapter({
    provider: 'custom',
    privacyRoute: 'external',
    baseUrl: 'https://ollama.com/v1',
    fetch
  });
  const [known, bare] = await adapter.describe();
  expect(known).toMatchObject({
    contextTokens: 163840,
    supportsTools: true,
    metadataSource: 'declared'
  });
  expect(known?.unknownFields).not.toContain('contextTokens');
  expect(bare).toMatchObject({
    contextTokens: null,
    supportsTools: false,
    metadataSource: 'declared'
  });
});
