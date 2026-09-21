import { describe, expect, it, vi } from 'vitest';
import { createModelAdapter } from './adapter.js';
import { ModelMessage, type ModelRequest } from './protocol.js';
import { responseMessage } from './native-continuation.js';
import { interruptedResponseOf } from './interrupted-response.js';
import { ModelGateway } from './gateway.js';

const model = 'gpt-6-astra';
const options = {
  baseUrl: 'https://api.openai.com/v1',
  provider: 'custom',
  privacyRoute: 'external',
  apiKey: 'test-key-never-persist'
};
const input = (): ModelRequest => ({
  model,
  messages: [
    { role: 'system', content: 'Use the available functions.' },
    { role: 'user', content: 'Analyze the project.' }
  ],
  tools: [
    {
      name: 'read_file',
      description: 'Read a project file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  ],
  temperature: 0.2,
  maxTokens: 2048,
  reasoningEffort: 'medium',
  sessionId: 'project-a'
});
const answer = (value = 'Done') => ({
  type: 'message',
  role: 'assistant',
  id: 'msg-1',
  status: 'completed',
  phase: 'final_answer',
  content: [{ type: 'output_text', text: value, annotations: [] }]
});
const reasoning = (id = '1') => ({
  type: 'reasoning',
  id: `rs-${id}`,
  summary: [{ type: 'summary_text', text: 'Inspecting evidence' }],
  encrypted_content: `opaque-${id}`
});
const call = (id = '1', args = '{"path":"workspace/data.json"}') => ({
  type: 'function_call',
  id: `fc-${id}`,
  call_id: `call-${id}`,
  name: 'read_file',
  arguments: args,
  status: 'completed'
});
const body = (output: unknown[] = [answer()], override: Record<string, unknown> = {}) => ({
  id: 'resp-1',
  model,
  status: 'completed',
  output,
  usage: {
    input_tokens: 120,
    output_tokens: 35,
    total_tokens: 155,
    input_tokens_details: { cached_tokens: 80 },
    output_tokens_details: { reasoning_tokens: 20 }
  },
  ...override
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const sse = (events: unknown[], split = false) => {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        if (split)
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        else controller.enqueue(bytes);
        controller.close();
      }
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  );
};

describe('native Responses requests and continuity', () => {
  it('preserves completed native items through two tool cycles and a serialized checkpoint', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const outputs = [
      [reasoning(), { ...answer('Reading'), phase: 'commentary' }, call()],
      [reasoning('2'), call('2')],
      [answer('Complete')]
    ];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(init?.redirect).toBe('error');
      requests.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return json(body(outputs[requests.length - 1]));
    });
    const adapter = createModelAdapter({ ...options, fetch: fetch as typeof globalThis.fetch });
    const request = input();
    for (let index = 0; index < 3; index++) {
      const result = await adapter.chat(request);
      expect(result.usage).toMatchObject({
        inputTokens: 120,
        outputTokens: 35,
        cachedInputTokens: 80
      });
      const message = ModelMessage.parse(
        JSON.parse(
          JSON.stringify({
            ...responseMessage(result),
            nativeContinuation: result.nativeContinuation
          })
        )
      );
      expect(JSON.stringify(message)).not.toContain(options.apiKey);
      request.messages.push(message);
      if (index < 2) {
        expect(result.toolCalls[0]?.id).toBe(`call-${index + 1}`);
        request.messages.push({
          role: 'tool',
          toolCallId: `call-${index + 1}`,
          content: `observation-${index + 1}`
        });
      }
    }
    expect(requests).toHaveLength(3);
    for (const sent of requests) {
      expect(sent).toMatchObject({
        store: false,
        service_tier: 'default',
        truncation: 'disabled',
        max_output_tokens: 2048,
        reasoning: { effort: 'medium' },
        tools: [{ type: 'function', name: 'read_file', strict: false }]
      });
      expect(sent).not.toHaveProperty('previous_response_id');
      expect(sent).not.toHaveProperty('temperature');
    }
    expect(requests[1]!.input).toEqual([
      ...input().messages,
      ...outputs[0]!,
      { type: 'function_call_output', call_id: 'call-1', output: 'observation-1' }
    ]);
    expect(requests[2]!.input).toEqual([
      ...(requests[1]!.input as unknown[]),
      ...outputs[1]!,
      { type: 'function_call_output', call_id: 'call-2', output: 'observation-2' }
    ]);
  });
  it.each([
    'credential',
    'model',
    'session',
    'privacy',
    'edited_message',
    'removed_prefix',
    'changed_observation',
    'compatible'
  ])('does not send an opaque envelope across %s', async (change) => {
    const request = input();
    const first = await createModelAdapter({
      ...options,
      fetch: (async () => json(body([reasoning(), call()]))) as typeof fetch
    }).chat(request);
    request.messages.push({
      ...responseMessage(first),
      nativeContinuation: first.nativeContinuation
    });
    request.messages.push({ role: 'tool', toolCallId: 'call-1', content: 'data' });
    if (change === 'model') request.model = 'gpt-5.6';
    if (change === 'session') request.sessionId = 'project-b';
    if (change === 'edited_message') request.messages[2]!.content = 'condensed';
    if (change === 'removed_prefix') request.messages.splice(0, 1);
    if (change === 'changed_observation') request.messages[1]!.content = 'a revised owner goal';
    let sent = '';
    const adapter = createModelAdapter({
      ...options,
      ...(change === 'credential' ? { apiKey: 'other-key' } : {}),
      ...(change === 'privacy' ? { privacyRoute: 'provider_zdr' } : {}),
      ...(change === 'compatible' ? { baseUrl: 'https://compatible.example/v1' } : {}),
      fetch: (async (_url, init) => {
        sent = init?.body as string;
        return change === 'compatible'
          ? json({
              choices: [{ finish_reason: 'stop', message: { content: 'Done' } }],
              usage: { prompt_tokens: 120, completion_tokens: 35 }
            })
          : json(body());
      }) as typeof fetch
    });
    await adapter.chat(request);
    expect(sent).not.toContain('opaque-1');
    expect(sent).not.toContain('encrypted_content');
  });
  it('keeps continuity across generated budget feedback that contains no task data', async () => {
    const request = input();
    request.messages.push({ role: 'system', content: '40% context left', ephemeralNotice: true });
    const first = await createModelAdapter({
      ...options,
      fetch: (async () => json(body([reasoning(), call()]))) as typeof fetch
    }).chat(request);
    request.messages.pop();
    request.messages.push(
      { ...responseMessage(first), nativeContinuation: first.nativeContinuation },
      { role: 'tool', toolCallId: 'call-1', content: 'result' },
      { role: 'system', content: '35% context left', ephemeralNotice: true }
    );
    let sent = '';
    await createModelAdapter({
      ...options,
      fetch: (async (_url, init) => {
        sent = init?.body as string;
        return json(body());
      }) as typeof fetch
    }).chat(request);
    expect(sent).toContain('opaque-1');
    expect(sent).toContain('35% context left');
    expect(sent).not.toContain('40% context left');
  });
  it('retains the compatible path for audio and selects by endpoint instead of provider name', async () => {
    const urls: string[] = [];
    const fetch = (async (url) => {
      urls.push(url as string);
      return json({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] });
    }) as typeof globalThis.fetch;
    await createModelAdapter({ ...options, fetch }).chat({
      ...input(),
      model: 'gpt-audio-1.5',
      supportsReasoningEffort: false,
      tools: []
    });
    await createModelAdapter({
      ...options,
      provider: 'openai',
      baseUrl: 'https://compatible.example/v1',
      fetch
    }).chat(input());
    expect(urls).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://compatible.example/v1/chat/completions'
    ]);
  });
});

describe('native stream outcomes', () => {
  it('carries permanent provider refusals and quota retry instructions without changing their meaning', async () => {
    for (const status of [401, 429]) {
      const adapter = createModelAdapter({
        ...options,
        fetch: (async () =>
          new Response(JSON.stringify({ error: { message: 'Account unavailable' } }), {
            status,
            headers: { 'retry-after': '42' }
          })) as typeof fetch
      });
      await expect(adapter.chat(input())).rejects.toMatchObject({
        statusCode: status,
        details: { retryAfter: '42' }
      });
    }
  });
  it('retains approved native web citations and accounts for the provider search', async () => {
    const response = body([
      {
        type: 'web_search_call',
        id: 'web-1',
        status: 'completed',
        action: { type: 'search', query: 'example' }
      },
      {
        ...answer('Sourced answer'),
        content: [
          {
            type: 'output_text',
            text: 'Sourced answer',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://example.org/source',
                title: 'Primary source',
                start_index: 0,
                end_index: 6
              }
            ]
          }
        ]
      }
    ]);
    const result = await createModelAdapter({
      ...options,
      fetch: (async () => json(response)) as typeof fetch
    }).chat({ ...input(), serverTools: [{ type: 'web_search', parameters: {} }] });
    expect(result.citations).toEqual([
      { url: 'https://example.org/source', title: 'Primary source' }
    ]);
    expect(result.usage.serverToolUse).toEqual({ web_search_requests: 1 });
  });
  it('withholds unapproved hosted tools before any request', async () => {
    const fetch = vi.fn();
    await expect(
      createModelAdapter({ ...options, fetch }).chat({
        ...input(),
        serverTools: [{ type: 'code_interpreter', parameters: {} }]
      })
    ).rejects.toThrow('only permits');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('normalizes interleaved parallel tool items, split Unicode, summaries, and repeated final records once', async () => {
    const first = call(),
      second = call('2', '{"path":"β.json"}');
    const response = body([reasoning(), answer('Ready β'), first, second]);
    const deltas: string[] = [],
      summaries: string[] = [];
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: { ...first, arguments: '', status: 'in_progress' }
      },
      {
        type: 'response.output_item.added',
        output_index: 3,
        item: { ...second, arguments: '', status: 'in_progress' }
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 3,
        item_id: second.id,
        delta: '{"path":'
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 2,
        item_id: first.id,
        delta: first.arguments
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 3,
        item_id: second.id,
        delta: '"β.json"}'
      },
      { type: 'response.output_text.delta', delta: 'Ready β' },
      { type: 'response.reasoning_summary_text.delta', delta: 'Inspecting evidence' },
      {
        type: 'response.function_call_arguments.done',
        output_index: 2,
        arguments: first.arguments
      },
      { type: 'response.output_item.done', output_index: 2, item: first },
      { type: 'response.output_item.done', output_index: 3, item: second },
      { type: 'response.completed', response }
    ];
    const result = await createModelAdapter({
      ...options,
      fetch: (async () => sse(events, true)) as typeof fetch
    }).chat({
      ...input(),
      onTextDelta: (v) => {
        deltas.push(v);
      },
      onReasoningDelta: (v) => {
        summaries.push(v);
      }
    });
    expect(deltas.join('')).toBe('Ready β');
    expect(summaries.join('')).toBe('Inspecting evidence');
    expect(result.text).toBe('Ready β');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((value) => value.arguments.path)).toEqual([
      'workspace/data.json',
      'β.json'
    ]);
    expect(result.nativeContinuation?.items).toEqual(response.output);
  });
  it.each(['malformed', 'incomplete'])('never executes %s function arguments', async (kind) => {
    const value = body(
      [call('1', kind === 'malformed' ? '{broken' : '{}')],
      kind === 'incomplete'
        ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
        : {}
    );
    const result = await createModelAdapter({
      ...options,
      fetch: (async () => json(value)) as typeof fetch
    }).chat(input());
    expect(result.toolCalls[0]?.parseFailed).toBe(true);
    expect(result.nativeContinuation).toBeUndefined();
    if (kind === 'incomplete') {
      expect(result.toolCalls[0]?.argumentsTruncated).toBe(true);
      expect(result.finishReason).toBe('length');
    }
  });
  it('keeps refusal text without inventing a tool', async () => {
    const value = body([
      { ...answer(), content: [{ type: 'refusal', refusal: 'I cannot complete that request.' }] }
    ]);
    const result = await createModelAdapter({
      ...options,
      fetch: (async () => json(value)) as typeof fetch
    }).chat(input());
    expect(result.text).toBe('I cannot complete that request.');
    expect(result.toolCalls).toEqual([]);
  });
  it('retains partial billing and prevents automatic replay after an incomplete stream', async () => {
    const fetch = vi.fn(async () =>
      sse([
        { type: 'response.output_text.delta', delta: 'Partial result' },
        { type: 'response.output_item.added', output_index: 0, item: call() }
      ])
    );
    const adapter = createModelAdapter({ ...options, fetch: fetch as typeof globalThis.fetch });
    const gateway = new ModelGateway().register('custom', adapter);
    let failure: unknown;
    try {
      await gateway.chat('custom', { ...input(), onTextDelta: () => undefined });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledOnce();
    const partial = interruptedResponseOf(failure);
    expect(partial?.text).toBe('Partial result');
    expect(partial?.toolCalls).toEqual([]);
    expect(partial?.usage.estimated).toBe(true);
    expect(partial!.usage.inputTokens).toBeGreaterThan(0);
    expect(partial!.usage.outputTokens).toBeGreaterThan(0);
  });
  it('cancels a blocked reader when stopped and retains visible progress', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetch = (async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","delta":"Started"}\n\n'
              )
            );
          },
          cancel
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )) as typeof globalThis.fetch;
    const result = await createModelAdapter({ ...options, fetch }).chat({
      ...input(),
      signal: controller.signal,
      onTextDelta: () => {
        controller.abort();
      }
    });
    expect(result.text).toBe('Started');
    expect(result.truncated?.reason).toBe('cancelled');
    expect(result.toolCalls).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('bounds a silent stream without requiring the test transport to implement abort', async () => {
    const cancel = vi.fn();
    const fetch = (async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { 'content-type': 'text/event-stream' }
      })) as typeof globalThis.fetch;
    const result = await createModelAdapter({ ...options, fetch, streamIdleTimeoutMs: 10 }).chat({
      ...input(),
      onTextDelta: () => undefined
    });
    expect(result.truncated?.reason).toBe('stalled');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('bounds terminal-only output and keeps provider-reported usage', async () => {
    const result = await createModelAdapter({
      ...options,
      generationMaxChars: 10,
      fetch: (async () =>
        sse([
          { type: 'response.completed', response: body([answer('x'.repeat(200))]) }
        ])) as typeof fetch
    }).chat(input());
    expect(result.truncated?.reason).toBe('overrun');
    expect(result.text).toHaveLength(10);
    expect(result.usage.outputTokens).toBe(35);
    expect(result.nativeContinuation).toBeUndefined();
  });
  it('rejects duplicate function identities and oversized opaque data', async () => {
    const adapter = createModelAdapter({
      ...options,
      fetch: (async () => json(body([call(), call()]))) as typeof fetch
    });
    await expect(adapter.chat(input())).rejects.toThrow('invalid');
    const oversized = createModelAdapter({
      ...options,
      fetch: (async () =>
        json(body([{ ...reasoning(), encrypted_content: 'x'.repeat(5_000_000) }]))) as typeof fetch
    });
    expect((await oversized.chat(input())).truncated?.reason).toBe('framing');
  });
});
