import { describe, expect, it, vi } from 'vitest';
import { createModelAdapter } from './adapter.js';
import { ANTHROPIC_VERSION, toMessagesRequest } from './anthropic-bridge.js';
import { shapedFetch, vendorForEndpoint, vendorPreset, vendorPresets } from './vendors.js';

const sse = (events: object[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Split mid-frame, as a real connection does, so the re-framer has to hold partial lines.
        const text = events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('');
        for (let at = 0; at < text.length; at += 37)
          controller.enqueue(encoder.encode(text.slice(at, at + 37)));
        controller.close();
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );

describe('the Anthropic Messages bridge', () => {
  it('moves system prompts out, merges tool results into one user turn and replays signed thinking', () => {
    const request = toMessagesRequest({
      model: 'claude-test',
      max_tokens: 1_000,
      reasoning_effort: 'medium',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are careful.' },
        { role: 'user', content: 'List the files.' },
        {
          role: 'assistant',
          content: '',
          reasoning_details: [
            { type: 'anthropic.thinking', thinking: 'look first', signature: 'sig' }
          ],
          tool_calls: [
            { id: 'call-a', type: 'function', function: { name: 'ls', arguments: '{"path":"."}' } },
            { id: 'call-b', type: 'function', function: { name: 'pwd', arguments: '' } }
          ]
        },
        { role: 'tool', tool_call_id: 'call-a', content: 'a.txt' },
        { role: 'tool', tool_call_id: 'call-b', content: '/work' },
        { role: 'user', content: 'Thanks.' }
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'ls', description: 'List', parameters: { type: 'object' } }
        }
      ]
    });
    expect(request.system).toEqual([
      { type: 'text', text: 'You are careful.', cache_control: { type: 'ephemeral' } }
    ]);
    const messages = request.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1]!.content[0]).toEqual({
      type: 'thinking',
      thinking: 'look first',
      signature: 'sig'
    });
    expect(messages[1]!.content.slice(1)).toMatchObject([
      { type: 'tool_use', id: 'call-a', name: 'ls', input: { path: '.' } },
      { type: 'tool_use', id: 'call-b', name: 'pwd', input: {} }
    ]);
    expect(messages[2]!.content).toMatchObject([
      { type: 'tool_result', tool_use_id: 'call-a', content: [{ type: 'text', text: 'a.txt' }] },
      { type: 'tool_result', tool_use_id: 'call-b', content: [{ type: 'text', text: '/work' }] },
      { type: 'text', text: 'Thanks.' }
    ]);
    // Thinking is on: a budget, an output ceiling above it, and no temperature.
    expect(request.thinking).toEqual({ type: 'enabled', budget_tokens: 8_192 });
    expect(request.max_tokens).toBeGreaterThan(8_192);
    expect(request).not.toHaveProperty('temperature');
    expect(request.tools).toEqual([
      { name: 'ls', description: 'List', input_schema: { type: 'object' } }
    ]);
  });

  it('keeps the breakpoints a caller placed instead of adding its own', () => {
    const request = toMessagesRequest({
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'Rules.' },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Prefix', cache_control: { type: 'ephemeral' } }]
        },
        { role: 'assistant', content: 'Ok.' },
        { role: 'user', content: 'Next.' }
      ]
    });
    expect((request.system as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'cache_control'
    );
    const marked = JSON.stringify(request).match(/cache_control/g) ?? [];
    expect(marked).toHaveLength(1);
  });

  it('streams a Claude turn through the chat adapter with text, thinking, a tool call and cache usage', async () => {
    const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      });
      return sse([
        {
          type: 'message_start',
          message: {
            id: 'msg-1',
            model: 'claude-test',
            usage: {
              input_tokens: 40,
              cache_read_input_tokens: 900,
              cache_creation_input_tokens: 10
            }
          }
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Check first.' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-1' }
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Looking ' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'now.' } },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu-1', name: 'shell', input: {} }
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"command":' }
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '"ls"}' }
        },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } },
        { type: 'message_stop' }
      ]);
    });
    const adapter = createModelAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      provider: 'custom',
      privacyRoute: 'external',
      fetch
    });
    const deltas: string[] = [];
    const response = await adapter.chat({
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'What is here?' }
      ],
      tools: [{ name: 'shell', description: 'Run a command', parameters: { type: 'object' } }],
      temperature: 0.2,
      reasoningEffort: 'low',
      onTextDelta: (delta) => {
        deltas.push(delta);
      }
    });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(calls[0]!.headers.get('anthropic-version')).toBe(ANTHROPIC_VERSION);
    expect(calls[0]!.headers.get('authorization')).toBeNull();
    expect(calls[0]!.body).toMatchObject({
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 2_048 }
    });
    expect(deltas.join('')).toBe('Looking now.');
    expect(response.text).toBe('Looking now.');
    expect(response.reasoning).toBe('Check first.');
    expect(response.reasoningDetails).toEqual([
      { type: 'anthropic.thinking', thinking: 'Check first.', signature: 'sig-1' }
    ]);
    expect(response.toolCalls).toEqual([
      { id: 'toolu-1', name: 'shell', arguments: { command: 'ls' } }
    ]);
    expect(response.finishReason).toBe('tool_calls');
    expect(response.usage).toMatchObject({
      inputTokens: 950,
      outputTokens: 25,
      cachedInputTokens: 900,
      cacheWriteTokens: 10
    });
  });

  it('lists Claude models with their names and passes a refused key back as a refusal', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes('bad'))
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' }
          }),
          {
            status: 401
          }
        );
      return new Response(
        JSON.stringify({
          data: [
            { id: 'claude-test', display_name: 'Claude Test', created_at: '2026-01-01T00:00:00Z' }
          ],
          has_more: false
        }),
        { status: 200 }
      );
    });
    const adapter = createModelAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      provider: 'custom',
      privacyRoute: 'external',
      fetch
    });
    const described = await adapter.describe();
    expect(described).toHaveLength(1);
    expect(described[0]).toMatchObject({
      id: 'claude-test',
      displayName: 'Claude Test',
      inputModalities: ['text', 'image']
    });
    const refused = createModelAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'bad',
      provider: 'custom',
      privacyRoute: 'external',
      fetch: async (input) =>
        fetch(`${input instanceof Request ? input.url : input.toString()}?bad`)
    });
    await expect(refused.describe()).rejects.toThrow(/401/);
  });
});

describe('vendor presets', () => {
  it('names every preset by a distinct host and finds each from its own address', () => {
    expect(vendorPresets.length).toBeGreaterThan(5);
    for (const preset of vendorPresets)
      expect(vendorForEndpoint(`${preset.baseUrl}/`)?.id).toBe(preset.id);
    expect(new Set(vendorPresets.map((preset) => new URL(preset.baseUrl).hostname)).size).toBe(
      vendorPresets.length
    );
    expect(vendorForEndpoint('https://gateway.example/v1')).toBeNull();
  });

  it('leaves out the fields a strict vendor refuses and keeps effort only where it is understood', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const inner = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response('{}');
    });
    const mistral = shapedFetch(vendorPreset('mistral')!, inner);
    await mistral('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'mistral-large',
        session_id: 'task',
        stream_options: { include_usage: true },
        reasoning_effort: 'high',
        messages: [{ role: 'assistant', content: 'x', reasoning: 'hidden', reasoning_details: [] }]
      })
    });
    expect(seen[0]).toEqual({
      model: 'mistral-large',
      messages: [{ role: 'assistant', content: 'x' }]
    });
    const google = shapedFetch(vendorPreset('google')!, inner);
    await google('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-2.5-pro', reasoning_effort: 'high', messages: [] })
    });
    expect(seen[1]).toMatchObject({ reasoning_effort: 'high' });
  });
});
