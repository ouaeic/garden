import { interruptedResponseOf } from './interrupted-response.js';
import { resolveWebToolPlan } from '@garden/contracts';
import { GardenError } from '@garden/core';
import { describe, expect, it, vi } from 'vitest';
import { HUGE_REQUEST_TOKENS } from './generation-budget.js';
import { ModelGateway } from './gateway.js';
import { DEFAULT_MAX_REQUEST_BYTES, OpenAICompatibleAdapter } from './openai-compatible.js';
import { isProviderWall, isRetryableError, retryAfterMsOf } from './retry.js';

describe('OpenAICompatibleAdapter', () => {
  it('calls a managed OpenRouter model with tools and fail-closed privacy routing', async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.2', owned_by: 'z-ai' }] }), {
          status: 200
        });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer managed-key');
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      expect(JSON.parse(init.body)).toMatchObject({
        model: 'z-ai/glm-5.2',
        session_id: 'opaque-task-session',
        reasoning: { effort: 'high' },
        messages: [
          { role: 'assistant', content: '', reasoning: 'encrypted prior reasoning' },
          { role: 'user', content: 'Inspect the workspace' }
        ],
        provider: {
          zdr: true,
          data_collection: 'deny',
          require_parameters: true,
          allow_fallbacks: true
        }
      });
      return new Response(
        JSON.stringify({
          model: 'z-ai/glm-5.2',
          provider: 'inference.net',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                reasoning: 'inspect before acting',
                reasoning_details: [{ type: 'reasoning.text', text: 'inspect before acting' }],
                tool_calls: [
                  {
                    id: 'call-1',
                    function: { name: 'shell', arguments: '{"command":"pwd"}' }
                  }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.004 }
        }),
        { status: 200 }
      );
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: request as typeof fetch
    });

    await expect(adapter.list()).resolves.toEqual([
      { id: 'z-ai/glm-5.2', provider: 'openrouter', revision: 'z-ai' }
    ]);
    await expect(
      adapter.chat({
        model: 'z-ai/glm-5.2',
        messages: [
          { role: 'assistant', content: '', reasoning: 'encrypted prior reasoning' },
          { role: 'user', content: 'Inspect the workspace' }
        ],
        tools: [{ name: 'shell', description: 'Run a command', parameters: {} }],
        temperature: 0.2,
        reasoningEffort: 'high',
        sessionId: 'opaque-task-session'
      })
    ).resolves.toMatchObject({
      toolCalls: [{ id: 'call-1', name: 'shell', arguments: { command: 'pwd' } }],
      reasoning: 'inspect before acting',
      reasoningDetails: [{ type: 'reasoning.text', text: 'inspect before acting' }],
      finishReason: 'tool_calls',
      usage: { costUsd: 0.004 },
      metadata: {
        provider: 'openrouter',
        upstreamProvider: 'inference.net',
        model: 'z-ai/glm-5.2'
      }
    });
  });

  it('streams visible text while reconstructing reasoning and tool calls', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      expect(JSON.parse(init.body)).toMatchObject({
        stream: true,
        stream_options: { include_usage: true }
      });
      const frames = [
        {
          model: 'z-ai/glm-5.2',
          provider: 'inference.net',
          choices: [
            {
              delta: {
                content: 'I will ',
                reasoning: 'inspect ',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-2',
                    function: { name: 'shell', arguments: '{"executable":' }
                  }
                ]
              }
            }
          ]
        },
        {
          choices: [
            {
              finish_reason: 'tool_calls',
              delta: {
                content: 'check.',
                reasoning: 'first',
                tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }]
              }
            }
          ],
          usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14, cost: 0.002 }
        }
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join('')
        .concat('data: [DONE]\n\n');
      return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      fetch: request as typeof fetch
    });
    const deltas: string[] = [];
    const result = await adapter.chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'Check the workspace' }],
      tools: [{ name: 'shell', description: 'Run a command', parameters: {} }],
      temperature: 0.2,
      onTextDelta: (delta) => {
        deltas.push(delta);
      }
    });

    expect(deltas).toEqual(['I will ', 'check.']);
    expect(result).toMatchObject({
      text: 'I will check.',
      reasoning: 'inspect first',
      toolCalls: [{ id: 'call-2', name: 'shell', arguments: { executable: 'pwd' } }],
      finishReason: 'tool_calls',
      usage: { totalTokens: 14, costUsd: 0.002 }
    });
  });

  const cachingAdapter = (capture: { body?: unknown }, usage?: Record<string, unknown>) =>
    new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'external',
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        capture.body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
            usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, ...usage }
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });

  it('marks cache breakpoints as content blocks for routes that bill them', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'anthropic/claude-opus-5',
      messages: [
        { role: 'system', content: 'contract', cacheBreakpoint: true },
        { role: 'user', content: 'go' },
        { role: 'tool', toolCallId: 'call-1', content: 'result', cacheBreakpoint: true }
      ],
      tools: [],
      temperature: 0.2
    });

    expect((capture.body as { messages: unknown[] }).messages).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 'contract', cache_control: { type: 'ephemeral' } }]
      },
      { role: 'user', content: 'go' },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: [{ type: 'text', text: 'result', cache_control: { type: 'ephemeral' } }]
      }
    ]);
  });

  it('never sends a cache field to routes that cache automatically', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'openai/gpt-6',
      messages: [
        { role: 'system', content: 'contract', cacheBreakpoint: true },
        { role: 'user', content: 'go', cacheBreakpoint: true }
      ],
      tools: [],
      temperature: 0.2
    });

    expect((capture.body as { messages: unknown[] }).messages).toEqual([
      { role: 'system', content: 'contract' },
      { role: 'user', content: 'go' }
    ]);
  });

  it('keeps at most four breakpoints and prefers the newest prefixes', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'anthropic/claude-opus-5',
      messages: Array.from({ length: 6 }, (_unused, index) => ({
        role: 'user' as const,
        content: `turn-${index}`,
        cacheBreakpoint: true
      })),
      tools: [],
      temperature: 0.2
    });

    const messages = (capture.body as { messages: Array<{ content: unknown }> }).messages;
    expect(messages.map((message) => typeof message.content === 'string')).toEqual([
      true,
      true,
      false,
      false,
      false,
      false
    ]);
  });

  it('leaves an image message as plain image blocks rather than guessing a marker position', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'anthropic/claude-opus-5',
      messages: [
        {
          role: 'user',
          content: 'look',
          images: ['data:image/png;base64,AA'],
          cacheBreakpoint: true
        }
      ],
      tools: [],
      temperature: 0.2
    });

    expect((capture.body as { messages: unknown[] }).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }
        ]
      }
    ]);
  });

  const byteCeilingAdapter = (
    capture: { body?: unknown; calls: number },
    maxRequestBytes?: number
  ): OpenAICompatibleAdapter =>
    new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'external',
      ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        capture.calls += 1;
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        capture.body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] }),
          { status: 200 }
        );
      }) as typeof fetch
    });

  /** A base64 data URL of a stated size, which is the shape a screenshot reaches this adapter in. */
  const still = (bytes: number): string => `data:image/png;base64,${'A'.repeat(bytes)}`;

  it('sheds the oldest attachments to bring an over-large request under the byte ceiling', async () => {
    // Four stills of a hundred thousand bytes each against a ceiling of a quarter of a million.
    // The images dominate the body by three orders of magnitude, so which two have to go is
    // arithmetic rather than a coincidence of envelope sizes.
    const capture: { body?: unknown; calls: number } = { calls: 0 };
    await byteCeilingAdapter(capture, 250_000).chat({
      // A route that bills explicit cache breakpoints, so the marked prefix below is really marked.
      model: 'anthropic/claude-opus-5',
      messages: [
        { role: 'system', content: 'contract', cacheBreakpoint: true },
        ...Array.from({ length: 4 }, (_unused, index) => ({
          role: 'user' as const,
          content: `screenshot ${index}`,
          images: [still(100_000)]
        }))
      ],
      tools: [],
      temperature: 0.2
    });

    const messages = (capture.body as { messages: Array<{ content: unknown }> }).messages;
    // The cached prefix is untouched by the shedding that happens after it. Shedding rewrites
    // messages, and a rewrite that moved or dropped a breakpoint would invalidate the prefix this
    // request shares with every other step of the turn - paying for the images twice over.
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'contract', cache_control: { type: 'ephemeral' } }
    ]);
    // Array content is what an image message travels as, so this reads which messages kept theirs:
    // the two newest, because the two oldest went first.
    expect(messages.slice(1).map((message) => Array.isArray(message.content))).toEqual([
      false,
      false,
      true,
      true
    ]);
    // The model is told, in the message it happened to, rather than left to wonder why it cannot
    // see the picture it asked for.
    expect(messages[1]?.content).toContain('screenshot 0');
    expect(messages[1]?.content).toMatch(/one image was dropped from this message/);
    expect(messages[2]?.content).toMatch(/read the file again/i);
    expect(Buffer.byteLength(JSON.stringify(capture.body))).toBeLessThanOrEqual(250_000);
    expect(capture.calls).toBe(1);
  });

  it('refuses a request still over the ceiling with nothing left to shed, and names bytes', async () => {
    const capture: { body?: unknown; calls: number } = { calls: 0 };
    const failure = await byteCeilingAdapter(capture, 10_000)
      .chat({
        model: 'z-ai/glm-5.2',
        messages: [{ role: 'user', content: 'x'.repeat(40_000) }],
        tools: [],
        temperature: 0.2
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GardenError);
    expect((failure as GardenError).code).toBe('provider_context_overflow');
    expect((failure as GardenError).statusCode).toBe(413);
    // The whole point of this ceiling is that it is a different quantity from the one the token
    // arithmetic bounds, so a refusal that talked about tokens would send the repair to the wrong
    // number.
    expect((failure as GardenError).message).toMatch(/bytes/);
    expect((failure as GardenError).message).not.toMatch(/token/i);
    expect((failure as GardenError).details).toMatchObject({ maxRequestBytes: 10_000 });
    expect(Number((failure as GardenError).details?.requestBytes)).toBeGreaterThan(40_000);
    // Refused here, so nothing was put on the wire and nothing was billed.
    expect(capture.calls).toBe(0);
  });

  it('enforces the shipped ceiling when none was configured and leaves an ordinary request alone', async () => {
    const capture: { body?: unknown; calls: number } = { calls: 0 };
    const failure = await byteCeilingAdapter(capture)
      .chat({
        model: 'z-ai/glm-5.2',
        messages: [{ role: 'user', content: 'x'.repeat(DEFAULT_MAX_REQUEST_BYTES + 1) }],
        tools: [],
        temperature: 0.2
      })
      .catch((error: unknown) => error);
    expect((failure as GardenError).code).toBe('provider_context_overflow');
    expect(capture.calls).toBe(0);

    await byteCeilingAdapter(capture).chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'go', images: [still(64)] }],
      tools: [],
      temperature: 0.2
    });
    expect(capture.calls).toBe(1);
    expect(
      (capture.body as { messages: Array<{ content: unknown }> }).messages[0]?.content
    ).toEqual([
      { type: 'text', text: 'go' },
      { type: 'image_url', image_url: { url: still(64) } }
    ]);
  });

  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

  const streamingAdapter = (
    body: BodyInit,
    options: {
      streamIdleTimeoutMs?: number;
      generationTimeoutMs?: number;
      generationMaxChars?: number;
    } = {}
  ): OpenAICompatibleAdapter =>
    new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      ...options,
      fetch: (async () =>
        new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
    });

  const streamRequest = (adapter: OpenAICompatibleAdapter, deltas: string[]): Promise<unknown> =>
    adapter.chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'Summarise the workspace' }],
      tools: [],
      temperature: 0.2,
      onTextDelta: (delta) => {
        deltas.push(delta);
      }
    });

  it('preserves nested cache read and write counters from the final streaming usage frame', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":1,"total_tokens":101,"prompt_tokens_details":{"cached_tokens":64,"cache_write_tokens":30}}}\n\n',
      'data: [DONE]\n\n'
    ].join('');
    await expect(streamRequest(streamingAdapter(frames), [])).resolves.toMatchObject({
      usage: { inputTokens: 100, cachedInputTokens: 64, cacheWriteTokens: 30 }
    });
  });

  it('raises a mid-stream error frame instead of returning a truncated turn as a success', async () => {
    const deltas: string[] = [];
    const frames = [
      'data: {"choices":[{"delta":{"content":"Working on "}}],"usage":{"prompt_tokens":40,"completion_tokens":1,"total_tokens":41,"cost":0.00001}}\n\n',
      'data: {"error":{"code":429,"message":"rate limited mid-stream","metadata":{"headers":{"Retry-After":"120"}}}}\n\n'
    ].join('');

    const failure = await streamRequest(streamingAdapter(frames), deltas).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(GardenError);
    expect((failure as GardenError).code).toBe('provider_quota_exhausted');
    expect((failure as GardenError).statusCode).toBe(429);
    expect((failure as GardenError).message).toContain('rate limited mid-stream');
    expect(retryAfterMsOf(failure)).toBe(120_000);
    expect(interruptedResponseOf(failure)).toMatchObject({
      text: 'Working on ',
      finishReason: 'error',
      usage: { inputTokens: 40, outputTokens: 3, totalTokens: 43, estimated: true }
    });
    expect(interruptedResponseOf(failure)?.usage.costUsd).toBeUndefined();
    expect(deltas).toEqual(['Working on ']);
  });

  it.each([400, 502])(
    'recovers an explicit tool output cutoff reported as error %s',
    async (code) => {
      const partial = '{"path":"workspace/report.py","content":"unfinished';
      const body = [
        {
          id: 'generation-cutoff',
          provider: 'Upstream',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'write-1', function: { name: 'file_write', arguments: partial } }
                ]
              }
            }
          ]
        },
        {
          error: {
            code,
            message: 'Upstream error: HttpError: HTTP 400: Tool calls cutoff by max_tokens.'
          }
        }
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join('');
      await expect(streamRequest(streamingAdapter(body), [])).resolves.toMatchObject({
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'write-1',
            name: 'file_write',
            arguments: {},
            parseFailed: true,
            argumentsTruncated: true,
            rawArguments: partial
          }
        ],
        usage: { estimated: true },
        metadata: { generationId: 'generation-cutoff', upstreamProvider: 'Upstream' }
      });
    }
  );

  it('keeps reasoning and length recovery when the provider withholds truncated tool fragments', async () => {
    const body = [
      { choices: [{ delta: { reasoning: 'Prepare a smaller script in separate files.' } }] },
      {
        error: { code: 502, message: 'Tool calls cutoff by max_tokens' },
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      }
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join('');
    await expect(streamRequest(streamingAdapter(body), [])).resolves.toMatchObject({
      finishReason: 'length',
      toolCalls: [],
      reasoning: 'Prepare a smaller script in separate files.',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    });
  });

  it('does not turn quota errors or ordinary text into output-limit recovery', async () => {
    await expect(
      streamRequest(
        streamingAdapter(
          'data: {"error":{"code":429,"message":"Tool calls cutoff by max_tokens"}}\n\n'
        ),
        []
      )
    ).rejects.toMatchObject({ code: 'provider_quota_exhausted' });
    await expect(
      streamRequest(
        streamingAdapter(
          'data: {"choices":[{"delta":{"content":"Tool calls cutoff by max_tokens"},"finish_reason":"stop"}]}\n\n'
        ),
        []
      )
    ).resolves.toMatchObject({ finishReason: 'stop', text: 'Tool calls cutoff by max_tokens' });
  });

  it('treats an unnumbered mid-stream fault as a retryable upstream failure', async () => {
    const failure = await streamRequest(
      streamingAdapter('data: {"error":{"message":"upstream model crashed"}}\n\n'),
      []
    ).catch((error: unknown) => error);

    // Deliberately moved from `provider_request_failed`. A 502 is the provider turning the work
    // away, and the name it leaves under is the one the layers above park a task behind; the old
    // name was retried inside the step and then failed the whole task, which is the opposite
    // outcome to the same outage arriving as a dropped socket.
    expect((failure as GardenError).code).toBe('provider_unavailable');
    expect((failure as GardenError).statusCode).toBe(502);
    expect(isRetryableError(failure)).toBe(true);
    expect(isProviderWall(failure)).toBe(true);
  });

  it('raises an error object that arrives in an otherwise successful body', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: 503, message: 'no instances available' } }), {
          status: 200
        })) as typeof fetch
    });

    await expect(
      adapter.chat({
        model: 'z-ai/glm-5.2',
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        temperature: 0.2
      })
    ).rejects.toThrow('no instances available');
  });

  it('classifies a connection dropped mid-stream as retryable, like one dropped before it', async () => {
    const deltas: string[] = [];
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(encode('data: {"choices":[{"delta":{"content":"Half an "}}]}\n\n'));
          return;
        }
        controller.error(
          Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } })
        );
      }
    });

    const failure = await streamRequest(streamingAdapter(body), deltas).catch(
      (error: unknown) => error
    );

    expect((failure as GardenError).code).toBe('provider_unavailable');
    expect((failure as GardenError).statusCode).toBe(503);
    expect((failure as GardenError).message).toContain('UND_ERR_SOCKET');
    expect(isRetryableError(failure)).toBe(true);
    expect(deltas).toEqual(['Half an ']);
    expect(interruptedResponseOf(failure)).toMatchObject({
      text: 'Half an ',
      finishReason: 'error',
      usage: { outputTokens: 2, estimated: true }
    });
    expect(JSON.stringify(failure)).not.toContain('Half an ');
  });

  it.each([
    { content: 'Unfinished answer' },
    {
      tool_calls: [
        {
          index: 0,
          id: 'unfinished-tool',
          function: { name: 'shell', arguments: '{"command":"echo pending"}' }
        }
      ]
    }
  ])('refuses an unfinished response even when the socket closes cleanly: %j', async (delta) => {
    const failure: unknown = await streamRequest(
      streamingAdapter(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`),
      []
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'provider_unavailable', statusCode: 503 });
    const partial = interruptedResponseOf(failure);
    expect(partial).toBeDefined();
    expect(partial?.finishReason).toBe('error');
    expect(partial?.usage.estimated).toBe(true);
    expect(partial?.usage.outputTokens).toBeGreaterThan(0);
  });

  it('keeps what a stream had written when it goes silent, rather than losing it with the error', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"Thinking"}}]}\n\n'));
      }
    });

    const result = await streamRequest(streamingAdapter(body, { streamIdleTimeoutMs: 25 }), deltas);

    expect(result).toMatchObject({
      text: 'Thinking',
      finishReason: 'length',
      truncated: { reason: 'stalled' },
      // The provider's usage frame never arrived, so it is estimated from what was generated rather
      // than recorded as the zero the owner watched for a quarter of an hour.
      usage: { outputTokens: 2, estimated: true }
    });
    expect(deltas).toEqual(['Thinking']);
  });

  it('gives a large request a longer idle deadline than an ordinary one', async () => {
    /*
     * The same route, going quiet for three hundred milliseconds after its first frame, asked twice.
     * Against the base deadline that is a stall and the answer is cut where it stopped; on a request
     * past the huge rung it is a route still reading the prompt, the deadline doubles, and the rest
     * of the answer arrives. Nothing about the provider differs between the two calls - only the
     * size of what it was asked to read, which is the whole claim.
     */
    const quiet = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode('data: {"choices":[{"delta":{"content":"Thinking"}}]}\n\n'));
          setTimeout(() => {
            try {
              controller.enqueue(
                encode(
                  'data: {"choices":[{"finish_reason":"stop","delta":{"content":" done"}}]}\n\n'
                )
              );
              controller.close();
            } catch {
              // The reader was already let go by the deadline on the first of the two calls, which
              // is exactly what that call is asserting.
            }
          }, 300).unref();
        }
      });
    const ask = (content: string): Promise<unknown> =>
      streamingAdapter(quiet(), { streamIdleTimeoutMs: 200 }).chat({
        model: 'z-ai/glm-5.2',
        messages: [{ role: 'user', content }],
        tools: [],
        temperature: 0.2,
        onTextDelta: () => {}
      });

    await expect(ask('brief')).resolves.toMatchObject({
      text: 'Thinking',
      truncated: { reason: 'stalled' }
    });
    // Four hundred thousand bytes of prompt is a hundred thousand estimated tokens: the huge rung.
    const large = await ask('x'.repeat(HUGE_REQUEST_TOKENS * 4));
    expect(large).toMatchObject({ text: 'Thinking done' });
    expect((large as { truncated?: unknown }).truncated).toBeUndefined();
  });

  it('reports a stream that goes silent before it says anything as the retryable provider fault it is', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Headers, then nothing at all: no text reached the caller, so a second attempt costs the
        // owner nothing they have already paid for and may well land on a working instance.
      }
    });

    const failure = await streamRequest(
      streamingAdapter(body, { streamIdleTimeoutMs: 25 }),
      deltas
    ).catch((error: unknown) => error);

    expect((failure as GardenError).code).toBe('provider_stream_stalled');
    expect((failure as GardenError).statusCode).toBe(504);
    expect(isRetryableError(failure)).toBe(true);
    expect(deltas).toEqual([]);
  });

  /*
   * `stream: true` is a request, not a guarantee, and the four shapes below are what came back from
   * a route that did not honour it. Every one of them used to return `{text: '', toolCalls: [],
   * finishReason: 'stop', usage: {0, 0, 0}}` as a success, because the SSE reader discards every
   * line that does not begin with `data:` and then synthesises a `choices` array whatever it read.
   * An owner behind a buffering proxy got a completed task with no answer in it and a ledger
   * reading $0.00 for every call the provider billed, and nothing anywhere was an error.
   */
  const unstreamedAdapter = (body: BodyInit, contentType: string): OpenAICompatibleAdapter =>
    new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      streamIdleTimeoutMs: 200,
      fetch: (async () =>
        new Response(body, { headers: { 'content-type': contentType } })) as typeof fetch
    });

  const bufferedCompletion = JSON.stringify({
    model: 'z-ai/glm-5.2',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: 'Listing the workspace.',
          tool_calls: [
            { id: 'call-7', function: { name: 'shell', arguments: '{"executable":"ls"}' } }
          ]
        }
      }
    ],
    usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138, cost: 0.004 }
  });

  it('keeps the answer a gateway gave when it buffered the stream away and replied as JSON', async () => {
    const deltas: string[] = [];

    const result = await streamRequest(
      unstreamedAdapter(bufferedCompletion, 'application/json'),
      deltas
    );

    expect(result).toMatchObject({
      text: 'Listing the workspace.',
      toolCalls: [{ id: 'call-7', name: 'shell', arguments: { executable: 'ls' } }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 120, outputTokens: 18, totalTokens: 138, costUsd: 0.004 }
    });
    // Nothing was streamed, so nothing was handed out delta by delta - but the turn is the turn the
    // provider billed for, not an empty one.
    expect(deltas).toEqual([]);
  });

  it('recovers a completion from a reply that called itself a stream and sent none', async () => {
    const deltas: string[] = [];

    const result = await streamRequest(
      unstreamedAdapter(bufferedCompletion, 'text/event-stream'),
      deltas
    );

    expect(result).toMatchObject({
      text: 'Listing the workspace.',
      usage: { costUsd: 0.004 }
    });
    expect(deltas).toEqual([]);
  });

  it('raises an error object a streamed request was answered with at 200', async () => {
    const failure = await streamRequest(
      unstreamedAdapter(
        JSON.stringify({ error: { code: 503, message: 'no instances available' } }),
        'application/json'
      ),
      []
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GardenError);
    expect((failure as GardenError).message).toContain('no instances available');
    expect((failure as GardenError).statusCode).toBe(503);
    expect(isRetryableError(failure)).toBe(true);
  });

  it('refuses a stream that closed cleanly without sending one frame', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    });

    const failure = await streamRequest(unstreamedAdapter(body, 'text/event-stream'), []).catch(
      (error: unknown) => error
    );

    expect((failure as GardenError).code).toBe('provider_stream_unparsed');
    expect((failure as GardenError).statusCode).toBe(502);
  });

  it('refuses a stream whose only frame was the end-of-stream marker', async () => {
    const failure = await streamRequest(
      unstreamedAdapter('data: [DONE]\n\n', 'text/event-stream'),
      []
    ).catch((error: unknown) => error);

    expect((failure as GardenError).code).toBe('provider_stream_unparsed');
    expect((failure as GardenError).statusCode).toBe(502);
  });

  /*
   * The measured failure. A stream that never goes quiet for long enough to look stalled, produces
   * a trickle, and would keep producing it until the caller's fifteen-minute deadline. The idle
   * clock cannot see this - every read returns - so the generation clock is what ends it, and it
   * ends it with the answer in hand.
   */
  it('cuts a generation that streams forever without finishing, and hands back what it wrote', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"and on "}}]}\n\n'));
      }
    });

    const result = (await streamRequest(
      streamingAdapter(body, { streamIdleTimeoutMs: 500, generationTimeoutMs: 60 }),
      deltas
    )) as { text: string; truncated?: { reason: string; detail: string } };

    expect(result.truncated?.reason).toBe('timeout');
    expect(result.truncated?.detail).toContain('still writing');
    expect(result.text.startsWith('and on ')).toBe(true);
    expect(deltas.length).toBeGreaterThan(1);
  });

  it('stops a route that writes past the output ceiling the request asked for', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"0123456789"}}]}\n\n'));
      }
    });

    // The clock is set as well, and deliberately much later: a route with no ceiling on it would be
    // cut by the deadline eventually, and this has to show the ceiling doing the cutting.
    const result = (await streamRequest(
      streamingAdapter(body, { generationMaxChars: 25, generationTimeoutMs: 300 }),
      deltas
    )) as { text: string; truncated?: { reason: string } };

    expect(result.truncated?.reason).toBe('overrun');
    expect(result.text.length).toBeGreaterThan(25);
    expect(result.text.length).toBeLessThan(60);
  });

  it('leaves an answer that finishes inside its budget completely alone', async () => {
    const deltas: string[] = [];
    const paragraph = 'The importer reads all three columns. '.repeat(40);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const sentence of paragraph.split('. ').filter(Boolean))
          controller.enqueue(
            encode(`data: {"choices":[{"delta":{"content":"${sentence}. "}}]}\n\n`)
          );
        controller.enqueue(
          encode(
            'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":900,"completion_tokens":380}}\n\n'
          )
        );
        controller.close();
      }
    });

    const result = (await streamRequest(streamingAdapter(body), deltas)) as {
      finishReason: string;
      truncated?: unknown;
      usage: { outputTokens: number; estimated?: true };
    };

    expect(result.finishReason).toBe('stop');
    expect(result.truncated).toBeUndefined();
    // The provider's own count stands; nothing here estimates over the top of it.
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 380, totalTokens: 1280 });
  });

  /*
   * The largest thing this product generates is not prose - it is the content of a file, and that
   * travels inside a tool call's arguments. Those characters were once counted by nothing: the
   * ceiling could not see them, so a route writing a runaway file ran to the clock, and the answer
   * came back billed at zero for twenty-four thousand characters of generation.
   */
  it('counts what a runaway tool call writes, and bills for it', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        controller.enqueue(
          encode(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        function: { name: 'file_write', arguments: 'x'.repeat(200) }
                      }
                    ]
                  }
                }
              ]
            })}\n\n`
          )
        );
      }
    });

    // The clock is set as well, and deliberately later than the ceiling, so that a run which stops
    // counting these characters fails on the reason rather than by hanging until vitest gives up.
    const result = (await streamRequest(
      streamingAdapter(body, { generationMaxChars: 400, generationTimeoutMs: 300 }),
      deltas
    )) as {
      finishReason: string;
      truncated?: { reason: string };
      usage: { outputTokens: number; estimated?: true };
      toolCalls: { rawArguments?: string }[];
    };

    expect(result.truncated?.reason).toBe('overrun');
    // A cut-off call is still a call the loop has to refuse rather than run, and `length` is how it
    // is told the arguments were cut rather than malformed.
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(100);
    expect(result.toolCalls[0]?.rawArguments?.length).toBeGreaterThanOrEqual(400);
  });

  /*
   * A cut-off answer is only worth continuing if continuing it can finish it, and the loop upstream
   * continues one three times before giving up. At the rate the measured failure produced - ten
   * characters a second - those three continuations buy half an hour and end up cut off anyway, so
   * this is reported as the end of an answer rather than as one to carry on from.
   */
  it('does not ask a route that has stopped being productive to carry on', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Ten characters a second, which is the rate the incident was measured at.
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
      }
    });

    const result = (await streamRequest(
      streamingAdapter(body, { streamIdleTimeoutMs: 500, generationTimeoutMs: 250 }),
      deltas
    )) as { text: string; finishReason: string; truncated?: { reason: string } };

    expect(result.truncated?.reason).toBe('timeout');
    expect(result.finishReason).toBe('stop');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('asks a long answer that was still being written to carry on', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.enqueue(
          encode(`data: {"choices":[{"delta":{"content":"${'a'.repeat(200)}"}}]}\n\n`)
        );
      }
    });

    const result = (await streamRequest(
      streamingAdapter(body, { streamIdleTimeoutMs: 500, generationTimeoutMs: 200 }),
      deltas
    )) as { finishReason: string; truncated?: { reason: string } };

    expect(result.truncated?.reason).toBe('timeout');
    expect(result.finishReason).toBe('length');
  });

  /*
   * The deadline has to hold against a route that keeps the socket busy, and racing it against the
   * read is not enough to make it: a read that finds bytes already buffered resolves as a settled
   * promise, and a settled promise runs ahead of any timer. Measured before the loop read the clock
   * for itself, a stream like this one ran forty-three times past its deadline and was stopped in
   * the end by the character ceiling - the wrong bound, under the wrong name.
   */
  it('holds the deadline against a stream that never makes it wait', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          encode(`data: {"choices":[{"delta":{"content":"${'c'.repeat(100)}"}}]}\n\n`)
        );
      }
    });

    /*
     * The ceiling is put out of reach on purpose. Both bounds can stop this stream, and with them
     * anywhere near each other the test is a race between them: on an idle machine the 5ms clock
     * wins, and under the load of the whole repo's suites running at once the reader gets through
     * enough chunks first and the answer comes back `overrun`. That failed exactly once, in
     * `pnpm check` and never in the package alone, which is the worst way for a test to be wrong.
     *
     * Five million characters is roughly fifty thousand chunks, each of them parsed. Nothing
     * reaches that in five milliseconds, so the only bound that can fire here is the clock - which
     * is the whole claim: a stream that never makes the reader wait is stopped by the loop reading
     * the time itself, not by a promise racing a timer that a settled read would always beat.
     */
    const result = (await streamRequest(
      streamingAdapter(body, { generationTimeoutMs: 5, generationMaxChars: 5_000_000 }),
      deltas
    )) as { truncated?: { reason: string } };

    expect(result.truncated?.reason).toBe('timeout');
    // Far below the ceiling, so a regression that let the ceiling do the stopping still fails here.
    expect(deltas.join('').length).toBeLessThan(500_000);
  });

  /*
   * A route that reports usage on every chunk rather than only at the end reports a count that
   * stops where the cut did. Trusting it is the same zero the owner was shown, one decimal place
   * along, so the larger of the two numbers stands.
   */
  it('will not bill a cut-off answer at the count a half-finished usage frame carried', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        controller.enqueue(
          encode(
            `data: {"choices":[{"delta":{"content":"${'b'.repeat(100)}"}}],"usage":{"prompt_tokens":900,"completion_tokens":1}}\n\n`
          )
        );
      }
    });

    const result = (await streamRequest(
      streamingAdapter(body, { generationTimeoutMs: 120 }),
      deltas
    )) as { usage: { inputTokens: number; outputTokens: number; estimated?: true } };

    expect(result.usage.estimated).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(50);
    // The prompt was reported by the provider and is not estimated over.
    expect(result.usage.inputTokens).toBe(900);
  });

  it('lets a slow but productive stream run past the idle window', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const part of ['one ', 'two ', 'three']) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          controller.enqueue(encode(`data: {"choices":[{"delta":{"content":"${part}"}}]}\n\n`));
        }
        controller.enqueue(encode('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n'));
        controller.close();
      }
    });

    await expect(
      streamRequest(streamingAdapter(body, { streamIdleTimeoutMs: 40 }), deltas)
    ).resolves.toMatchObject({ text: 'one two three', finishReason: 'stop' });
    expect(deltas).toEqual(['one ', 'two ', 'three']);
  });

  it('reports cache accounting back to usage', async () => {
    const capture: { body?: unknown } = {};
    const result = await cachingAdapter(capture, {
      prompt_tokens_details: { cached_tokens: 64 },
      cache_creation_input_tokens: 30
    }).chat({
      model: 'anthropic/claude-opus-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2
    });

    expect(result.usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 64,
      cacheWriteTokens: 30
    });
  });

  it('takes the cache style from the catalogue when the caller supplies it', async () => {
    const marked: { body?: unknown } = {};
    await cachingAdapter(marked).chat({
      model: 'vendor/explicit-cache-model',
      promptCacheStyle: 'explicit',
      messages: [{ role: 'system', content: 'contract', cacheBreakpoint: true }],
      tools: [],
      temperature: 0.2
    });
    expect((marked.body as { messages: unknown[] }).messages).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 'contract', cache_control: { type: 'ephemeral' } }]
      }
    ]);

    // ...and a route the catalogue says does not cache is sent nothing, whatever its vendor is.
    const plain: { body?: unknown } = {};
    await cachingAdapter(plain).chat({
      model: 'anthropic/claude-opus-5',
      promptCacheStyle: 'none',
      messages: [{ role: 'system', content: 'contract', cacheBreakpoint: true }],
      tools: [],
      temperature: 0.2
    });
    expect((plain.body as { messages: unknown[] }).messages).toEqual([
      { role: 'system', content: 'contract' }
    ]);
  });

  it('keeps OpenAI automatic caching compatible with a stored explicit-cache hint', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: '~openai/model-latest',
      promptCacheStyle: 'explicit',
      messages: [{ role: 'system', content: 'contract', cacheBreakpoint: true }],
      tools: [],
      temperature: 0.2
    });
    expect((capture.body as { messages: unknown[] }).messages).toEqual([
      { role: 'system', content: 'contract' }
    ]);
  });

  it('clamps the output ask to what the route will write, and withholds an unsupported effort', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2,
      maxTokens: 120_000,
      maxOutputTokens: 64_000,
      reasoningEffort: 'high',
      supportsReasoningEffort: false
    });
    const body = capture.body as { max_tokens?: number; reasoning?: unknown };
    expect(body.max_tokens).toBe(64_000);
    expect(body.reasoning).toBeUndefined();
  });

  it('sends a zero-retention route only the parameters it declared, and still demands they hold', async () => {
    // The failure this locks out: under zero data retention the request asks the provider to
    // honour every parameter it receives, and OpenRouter reads that against each endpoint's own
    // declared list. A route that never declared `temperature` was then no route at all - 404, no
    // endpoint found, for a model the catalogue listed as available. Since zero data retention is
    // what a fresh install turns on, that was every task on every new box.
    const capture: { body?: unknown } = {};
    const requested: string[] = [];
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested.push(url);
        if (url.endsWith('/endpoints/zdr'))
          return new Response(
            JSON.stringify({
              data: [
                // The shape a real private route takes: tools and reasoning, no temperature, and
                // the output cap under its other name.
                {
                  model_id: 'openai/gpt-5.6-luna',
                  status: 0,
                  supported_parameters: [
                    'tools',
                    'tool_choice',
                    'reasoning',
                    'reasoning_effort',
                    'max_completion_tokens'
                  ]
                },
                // A poorer route for the same model, which must not be the one measured against.
                { model_id: 'openai/gpt-5.6-luna', status: 0, supported_parameters: ['seed'] }
              ]
            }),
            { status: 200 }
          );
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        capture.body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });
    const ask = {
      model: 'openai/gpt-5.6-luna',
      messages: [{ role: 'user' as const, content: 'go' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxTokens: 512,
      reasoningEffort: 'high' as const
    };
    await adapter.chat(ask);
    const body = capture.body as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    // Reasoning survives, because this route does take it.
    expect(body.reasoning).toEqual({ effort: 'high' });
    // The cap survives too, under the name the route declared, rather than being dropped.
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(512);
    // Tools are never withheld: a route that cannot call them has to fail rather than answer as
    // though the agent had none.
    expect((body.tools as unknown[]).length).toBe(1);
    expect(body.provider).toMatchObject({ zdr: true, require_parameters: true });

    // The declared list is fetched once and reused, not re-read for every turn of a task.
    await adapter.chat(ask);
    expect(requested.filter((url) => url.endsWith('/endpoints/zdr'))).toHaveLength(1);
  });

  it('leaves the output ask alone when the catalogue never published a limit', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2,
      maxTokens: 8_000,
      reasoningEffort: 'high'
    });
    const body = capture.body as { max_tokens?: number; reasoning?: unknown };
    expect(body.max_tokens).toBe(8_000);
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('times the first token, because nothing publishes a latency for these routes', async () => {
    const deltas: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(encode('data: {"choices":[{"delta":{"content":" rest"}}]}\n\n'));
        controller.enqueue(encode('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n'));
        controller.close();
      }
    });
    const result = (await streamRequest(streamingAdapter(body), deltas)) as {
      metadata: { latencyMs: number; timeToFirstTokenMs?: number };
    };
    expect(result.metadata.timeToFirstTokenMs).toBeGreaterThan(0);
    expect(result.metadata.timeToFirstTokenMs).toBeLessThanOrEqual(result.metadata.latencyMs);
  });

  it('reports no first-token time on a turn that was never streamed', async () => {
    const capture: { body?: unknown } = {};
    const result = await cachingAdapter(capture).chat({
      model: 'anthropic/claude-opus-5',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2
    });
    expect(result.metadata.timeToFirstTokenMs).toBeUndefined();
  });

  it('reports what a configured endpoint declares about itself, and what it does not', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://127.0.0.1:8000/v1',
      provider: 'openai-compatible',
      privacyRoute: 'external',
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'qwen3-32b', max_model_len: 131_072, owned_by: 'vllm' },
              {
                id: 'gpt-5.6-sol',
                name: 'GPT-5.6 Sol',
                context_length: 400_000,
                top_provider: { max_completion_tokens: 128_000 },
                pricing: { prompt: '0.000001', completion: '0.000006' },
                supported_parameters: ['tools', 'reasoning_effort']
              },
              { id: 'mystery-model' }
            ]
          }),
          { status: 200 }
        )) as typeof fetch
    });

    const described = await adapter.describe();
    expect(described[0]).toMatchObject({
      id: 'qwen3-32b',
      contextTokens: 131_072,
      metadataSource: 'declared'
    });
    expect(described[0]?.unknownFields).toEqual([
      'maxOutputTokens',
      'inputUsdPerMillionTokens',
      'outputUsdPerMillionTokens',
      'supportedParameters'
    ]);
    expect(described[1]).toMatchObject({
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      contextTokens: 400_000,
      maxOutputTokens: 128_000,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 6,
      supportsTools: true,
      supportsReasoningEffort: true,
      metadataSource: 'declared'
    });
    // An endpoint that publishes nothing is recorded as unknown rather than given invented numbers.
    expect(described[2]).toMatchObject({ id: 'mystery-model', metadataSource: 'unknown' });
    expect(described[2]?.contextTokens).toBeNull();
  });

  const providerSearchPlan = resolveWebToolPlan({ provider: 'openrouter' });

  it('sends a provider-side tool unwrapped, in the tools array it shares with none', async () => {
    const capture: { body?: unknown } = {};
    await cachingAdapter(capture).chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'Query: what changed in the rules this week?' }],
      // Empty, because this is the request garden builds to spend one provider search and nothing
      // else. A function tool here would be a second answerer for the same question.
      tools: [],
      serverTools: providerSearchPlan.serverTools,
      temperature: 0.2
    });

    // A server tool wrapped as `{type:'function'}` would be a claim that this box answers the call.
    expect((capture.body as { tools: unknown[] }).tools).toEqual([
      { type: 'openrouter:web_search', engine: 'auto', max_results: 10, max_uses: 2 }
    ]);
  });

  it('sends nothing extra when the plan withheld the provider tools', async () => {
    const capture: { body?: unknown } = {};
    const inHouse = resolveWebToolPlan({ provider: 'openrouter', forceInHouse: true });
    await cachingAdapter(capture).chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'web_search', description: 'Search the internet', parameters: {} }],
      serverTools: inHouse.serverTools,
      temperature: 0.2
    });

    expect((capture.body as { tools: unknown[] }).tools).toEqual([
      {
        type: 'function',
        function: { name: 'web_search', description: 'Search the internet', parameters: {} }
      }
    ]);
  });

  /**
   * This used to be a refusal, and the refusal was the bug.
   *
   * Zero-retention enforcement covers inference routing and says in terms that it does not cover
   * tools - so a search query sits outside that guarantee whether the tools are sent or withheld,
   * and withholding them protected nothing. What it did do was take search off every box configured
   * the shipped way, because the flag ships on, and this adapter is the last code before the wire:
   * an owner who reached this point had already been told by the plan and by the settings page that
   * their searches would be answered by the provider, and then got an error instead.
   *
   * So the connection carries both, and both halves are asserted here: the provider block that
   * makes the inference request zero-retention, and the search tools it never covered.
   */
  it('sends provider search on a zero-retention connection, which the flag never covered', async () => {
    const capture: { body?: unknown } = {};
    const request = vi.fn(async (_url: string, init: { body: string }) => {
      capture.body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200
      });
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: request as unknown as typeof fetch
    });

    await adapter.chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      serverTools: providerSearchPlan.serverTools,
      temperature: 0.2
    });

    const body = capture.body as { tools: Array<{ type: string }>; provider: unknown };
    expect(body.tools.map((tool) => tool.type)).toEqual(['openrouter:web_search']);
    expect(body.provider).toMatchObject({ zdr: true, data_collection: 'deny' });
  });

  it('refuses a search request that also offers the model a search tool of its own', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 200 }));
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'external',
      fetch: request as unknown as typeof fetch
    });

    const failure = await adapter
      .chat({
        model: 'z-ai/glm-5.2',
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'web_search', description: 'Search the internet', parameters: {} }],
        serverTools: providerSearchPlan.serverTools,
        temperature: 0.2
      })
      .catch((error: unknown) => error);

    expect((failure as GardenError).code).toBe('web_tool_catalogue_conflict');
    expect((failure as GardenError).message).toContain('web_search');
    expect(request).not.toHaveBeenCalled();
  });

  it('carries the sources and the per-request counters back from a provider-side search', async () => {
    const capture: { body?: unknown } = {};
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'external',
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        capture.body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: 'The rate was held at 4.25 per cent.',
                  annotations: [
                    {
                      type: 'url_citation',
                      url_citation: {
                        url: 'https://example.invalid/decision',
                        title: 'Rate decision',
                        content: 'held at 4.25 per cent'
                      }
                    },
                    { type: 'url_citation', url_citation: { title: 'no address' } }
                  ]
                }
              }
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              server_tool_use: { web_search_requests: 2 }
            }
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });

    const result = await adapter.chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'What did they decide?' }],
      tools: [],
      serverTools: providerSearchPlan.serverTools,
      temperature: 0.2
    });

    expect(result.citations).toEqual([
      {
        url: 'https://example.invalid/decision',
        title: 'Rate decision',
        excerpt: 'held at 4.25 per cent'
      }
    ]);
    expect(result.usage.serverToolUse).toEqual({ web_search_requests: 2 });
  });

  it('collects citations from a streamed answer, however the route spells them', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Held.","annotations":[{"type":"url_citation","url_citation":{"url":"https://example.invalid/a","title":"A"}}]}}]}\n\n',
      // The same annotation again, which is what a route that resends the whole list looks like.
      'data: {"choices":[{"delta":{"annotations":[{"type":"url_citation","url_citation":{"url":"https://example.invalid/a","title":"A"}}]}}]}\n\n',
      // And a route that attaches the finished list to a message on the closing chunk instead.
      'data: {"choices":[{"finish_reason":"stop","delta":{},"message":{"annotations":[{"url":"https://example.invalid/b"}]}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"server_tool_use":{"web_search_requests":1}}}\n\n',
      'data: [DONE]\n\n'
    ].join('');

    const result = (await streamRequest(streamingAdapter(frames), [])) as {
      citations?: Array<{ url: string }>;
      usage: { serverToolUse?: Record<string, number> };
    };

    expect(result.citations?.map((citation) => citation.url)).toEqual([
      'https://example.invalid/a',
      'https://example.invalid/b'
    ]);
    expect(result.usage.serverToolUse).toEqual({ web_search_requests: 1 });
  });

  it('leaves both fields off a response that never used a provider tool', async () => {
    const capture: { body?: unknown } = {};
    const result = await cachingAdapter(capture).chat({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2
    });

    expect(result.citations).toBeUndefined();
    expect(result.usage.serverToolUse).toBeUndefined();
    // No `serverTools` at all, rather than an empty array nobody asked for.
    expect((capture.body as { tools: unknown[] }).tools).toEqual([]);
  });
  /*
   * A response cut off at the output cap ends mid-JSON. The arguments used to be swallowed into an
   * empty object and the call run anyway, so `file_write` arrived with no path and no content and
   * failed on a validation error that named neither the truncation nor the way out of it.
   */
  it.each([
    ['whole', false],
    ['streamed', true]
  ])(
    'marks a %s tool call whose arguments were cut off, rather than emptying them',
    async (_name, streaming) => {
      const truncated = '{"path":"report.md","content":"lorem ipsum dolor';
      const request = vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith('/models'))
          return new Response(
            JSON.stringify({ data: [{ id: 'z-ai/glm-5.2', owned_by: 'z-ai' }] }),
            {
              status: 200
            }
          );
        if (streaming) {
          const frames = [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        function: { name: 'file_write', arguments: truncated }
                      }
                    ]
                  }
                }
              ]
            })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ finish_reason: 'length', delta: {} }] })}\n\n`,
            'data: [DONE]\n\n'
          ].join('');
          return new Response(frames, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          });
        }
        return new Response(
          JSON.stringify({
            model: 'z-ai/glm-5.2',
            choices: [
              {
                finish_reason: 'length',
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'file_write', arguments: truncated }
                    }
                  ]
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      });
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'managed-key',
        provider: 'openrouter',
        privacyRoute: 'provider_zdr',
        enforceZeroDataRetention: true,
        fetch: request as typeof fetch
      });
      const result = streaming
        ? await adapter.chat({
            model: 'z-ai/glm-5.2',
            messages: [{ role: 'user', content: 'Write the report' }],
            tools: [{ name: 'file_write', description: 'Write a file', parameters: {} }],
            temperature: 0.2,
            onTextDelta: (): void => undefined
          })
        : await adapter.chat({
            model: 'z-ai/glm-5.2',
            messages: [{ role: 'user', content: 'Write the report' }],
            tools: [{ name: 'file_write', description: 'Write a file', parameters: {} }],
            temperature: 0.2
          });
      const call = result.toolCalls[0];
      expect(call?.name).toBe('file_write');
      expect(call?.parseFailed).toBe(true);
      // The raw text is kept so the refusal can say how much was cut off.
      expect(call?.rawArguments).toBe(truncated);
      // And crucially it is NOT a plausible-looking empty call.
      expect(call?.arguments).toEqual({});
    }
  );
  /*
   * A thinking block is signed against the whole turn that produced it, so compaction or truncation
   * invalidates it and the replay is refused with a 400. Nothing about that is retryable - the same
   * bytes fail forever - and since a refusal appends nothing, a resumed task would die at the same
   * step for good. The one repair is to stop replaying the signed material.
   */
  it("drops replayed reasoning once when the provider refuses its signature, and keeps the caller's messages intact", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/models'))
        return new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.2', owned_by: 'z-ai' }] }), {
          status: 200
        });
      if (!url.includes('/chat/completions'))
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      bodies.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
      );
      if (bodies.length === 1)
        return new Response(
          JSON.stringify({
            error: {
              message:
                'messages.1: thinking blocks cannot be modified; the signature must remain as they were'
            }
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      return new Response(
        JSON.stringify({
          model: 'z-ai/glm-5.2',
          choices: [{ finish_reason: 'stop', message: { content: 'carried on' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: request as typeof fetch
    });
    const messages = [
      {
        role: 'assistant' as const,
        content: 'thinking out loud',
        reasoningDetails: [{ type: 'reasoning.text', text: 'signed', signature: 'abc' }]
      },
      { role: 'user' as const, content: 'carry on' }
    ];
    await expect(
      adapter.chat({
        model: 'z-ai/glm-5.2',
        messages,
        tools: [],
        temperature: 0.2
      })
    ).resolves.toMatchObject({ text: 'carried on' });

    expect(bodies).toHaveLength(2);
    const sent = (index: number): Array<Record<string, unknown>> =>
      (bodies[index]?.messages ?? []) as Array<Record<string, unknown>>;
    // First attempt replays the signed reasoning; the repair does not.
    expect(sent(0)[0]?.reasoning_details).toBeDefined();
    expect(sent(1)[0]?.reasoning_details).toBeUndefined();
    // Everything else is identical - the repair drops one field, it does not rebuild the window.
    expect(sent(1)[0]?.content).toBe('thinking out loud');
    expect(sent(1)).toHaveLength(2);
    // And the caller's own messages were never edited: persisting a stripped trajectory would make
    // every later turn replay the damage.
    expect(messages[0]?.reasoningDetails).toEqual([
      { type: 'reasoning.text', text: 'signed', signature: 'abc' }
    ]);
  });

  /*
   * Every bound written for the fifteen-minute incident lived inside the stream reader, so the five
   * call sites that do not stream - the delegate step, the provider web search, the compaction
   * summariser, the vision specialist and the API titler - had none of them.
   */
  describe('bounds that used to apply to the streamed path only', () => {
    it('stops waiting on a non-streamed reply that never arrives', async () => {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'managed-key',
        provider: 'openrouter',
        privacyRoute: 'provider_zdr',
        generationTimeoutMs: 40,
        fetch: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                // Headers, then silence. Without a deadline on this read the worker's slot is held
                // for the caller's whole fifteen minutes, sixteen times over inside one delegate.
                controller.enqueue(encode('{"choices":[{"message":{"content":"'));
              }
            }),
            { headers: { 'content-type': 'application/json' } }
          )) as typeof fetch
      });

      const failure = await adapter
        .chat({
          model: 'z-ai/glm-5.2',
          messages: [{ role: 'user', content: 'Summarise this' }],
          tools: [],
          temperature: 0.2
        })
        .catch((error: unknown) => error);

      expect((failure as GardenError).code).toBe('provider_stream_stalled');
      // A wall rather than a client mistake, so the layers above wait rather than fail the task.
      expect(isProviderWall(failure)).toBe(true);
    });

    it('stops a stream that sends bytes without ever sending a line', async () => {
      // Measured before the cap: 4 KB of newline-free bytes per pull against a ceiling of fifty
      // characters read 593 chunks and 2.4 MB in four hundred milliseconds, with the ceiling never
      // once consulted - `budget.produced` is only reached from a parsed line.
      const deltas: string[] = [];
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(encode('x'.repeat(200_000)));
        }
      });

      const result = (await streamRequest(
        streamingAdapter(body, { generationTimeoutMs: 30_000, generationMaxChars: 5_000_000 }),
        deltas
      ).catch((error: unknown) => error)) as GardenError;

      // Nothing was generated, so it is the provider fault it is rather than a partial answer.
      expect(result.code).toBe('provider_stream_stalled');
      // Bounded by the megabyte rather than by the clock or by V8's string length.
      expect(pulls).toBeLessThan(12);
    });

    it('stops a stream that sends frames without ever sending an answer', async () => {
      // The other half the character ceiling cannot see: every line parses, none of them carries a
      // token, so nothing is ever counted as produced and the stream runs until the clock.
      const deltas: string[] = [];
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(encode('data: {"choices":[{"delta":{}}]}\n\n'.repeat(500)));
        }
      });

      const result = (await streamRequest(
        streamingAdapter(body, { generationTimeoutMs: 30_000, generationMaxChars: 200 }),
        deltas
      ).catch((error: unknown) => error)) as GardenError;

      expect(result.code).toBe('provider_stream_stalled');
      // 200 characters of answer allowed, sixteen times that in envelope: a few hundred frames.
      expect(pulls).toBeLessThan(5);
    });
  });

  it('does not re-send on a 400 that is not about a reasoning signature', async () => {
    let calls = 0;
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/models'))
        return new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.2', owned_by: 'z-ai' }] }), {
          status: 200
        });
      if (!url.includes('/chat/completions'))
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'unknown model' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: request as typeof fetch
    });
    await expect(
      adapter.chat({
        model: 'z-ai/glm-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        temperature: 0.2
      })
    ).rejects.toThrow('unknown model');
    expect(calls).toBe(1);
  });

  /**
   * The other 400 with the signed-reasoning refusal's property: the same bytes fail identically for
   * ever, and a refused request appends nothing, so the window never advances past the message that
   * overflowed it. Nothing anywhere recognised it, and a resumed task died at the same step until
   * the owner stopped replying.
   */
  const refusingWith = (status: number, message: string): OpenAICompatibleAdapter =>
    new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      provider: 'openrouter',
      privacyRoute: 'external',
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message } }), {
          status,
          headers: { 'content-type': 'application/json' }
        })) as typeof fetch
    });

  const refusal = async (adapter: OpenAICompatibleAdapter): Promise<GardenError> =>
    (await adapter
      .chat({
        model: 'z-ai/glm-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        temperature: 0.2
      })
      .catch((error: unknown) => error)) as GardenError;

  it('names a window the route will not take, and the sizes it named', async () => {
    const failure = await refusal(
      refusingWith(
        400,
        "This model's maximum context length is 200000 tokens, however you requested 214113 tokens"
      )
    );

    expect(failure.code).toBe('provider_context_overflow');
    // The route's own ceiling, not the catalogue's number for the model: those differ, and it is
    // the difference that puts a request over the line.
    expect(failure.details).toMatchObject({
      contextLimitTokens: 200_000,
      requestedTokens: 214_113
    });
    // Repairable, but never by sending the identical bytes again.
    expect(isRetryableError(failure)).toBe(false);
    expect(isProviderWall(failure)).toBe(false);
  });

  it("recognises the same refusal at 413 and in another vendor's wording", async () => {
    expect(
      (await refusal(refusingWith(413, 'prompt is too long: 214113 tokens > 200000'))).code
    ).toBe('provider_context_overflow');
    expect(
      (await refusal(refusingWith(400, 'input length exceeds context window; reduce the length')))
        .code
    ).toBe('provider_context_overflow');
  });

  it('leaves an ordinary refusal terminal under its own name', async () => {
    // Both halves of the match have to hold: "too long" about something that is not a window is
    // still an ordinary refusal, and a request the provider disliked for any other reason must not
    // start a compaction that throws away the owner's transcript.
    expect((await refusal(refusingWith(400, 'unknown model'))).code).toBe(
      'provider_request_failed'
    );
    expect((await refusal(refusingWith(400, 'tool name is too long'))).code).toBe(
      'provider_request_failed'
    );
  });

  /*
   * Reasoning fields, on the endpoint family this adapter names by name.
   *
   * The recorded incident is a turn that streamed 1,015 `assistant_delta` frames and made no tool
   * call, where the model's deliberation was published as the answer and its own operating contract
   * came back into the reading column. A route that puts its thinking somewhere this file does not
   * read is that defect's supply line: `reasoning_content` is what DeepSeek's own API and vLLM's
   * reasoning parsers send, and a `<think>` span inline in `content` is what every unparsed
   * self-hosted R1-family route sends.
   */
  describe('reasoning fields', () => {
    /** Drives one stream and reports both channels separately, which is the whole question here. */
    const splitStream = async (
      body: BodyInit,
      options: { generationMaxChars?: number; generationTimeoutMs?: number } = {}
    ): Promise<{
      text: string;
      reasoning?: string;
      textDeltas: string[];
      reasoningDeltas: string[];
    }> => {
      const textDeltas: string[] = [];
      const reasoningDeltas: string[] = [];
      const result = (await streamingAdapter(body, options).chat({
        model: 'deepseek/deepseek-r1',
        messages: [{ role: 'user', content: 'Summarise the workspace' }],
        tools: [],
        temperature: 0.2,
        onTextDelta: (delta) => {
          textDeltas.push(delta);
        },
        onReasoningDelta: (delta) => {
          reasoningDeltas.push(delta);
        }
      })) as { text: string; reasoning?: string };
      return { ...result, textDeltas, reasoningDeltas };
    };

    const framesOf = (...frames: unknown[]): string =>
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';

    const jsonAdapter = (body: unknown): OpenAICompatibleAdapter =>
      new OpenAICompatibleAdapter({
        baseUrl: 'https://vllm.internal/v1',
        provider: 'self-hosted',
        privacyRoute: 'local',
        fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
      });

    const jsonAnswer = (
      message: Record<string, unknown>
    ): Promise<{ text: string; reasoning?: string }> =>
      jsonAdapter({
        choices: [{ finish_reason: 'stop', message }],
        usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 }
      }).chat({
        model: 'deepseek-r1',
        messages: [{ role: 'user', content: 'Summarise the workspace' }],
        tools: [],
        temperature: 0.2
      }) as Promise<{ text: string; reasoning?: string }>;

    it('reads reasoning a route streams as reasoning_content rather than dropping it', async () => {
      const result = await splitStream(
        framesOf(
          { choices: [{ delta: { reasoning_content: 'deliberating hard' } }] },
          { choices: [{ finish_reason: 'stop', delta: { content: 'answer' } }] }
        )
      );

      expect(result.text).toBe('answer');
      expect(result.reasoning).toBe('deliberating hard');
      expect(result.reasoningDeltas).toEqual(['deliberating hard']);
      expect(result.textDeltas).toEqual(['answer']);
    });

    it('sends a leading think span to the reasoning channel instead of publishing it as the answer', async () => {
      const result = await splitStream(
        framesOf({
          choices: [
            { finish_reason: 'stop', delta: { content: '<think>secret plan</think>final' } }
          ]
        })
      );

      expect(result.text).toBe('final');
      expect(result.reasoning).toBe('secret plan');
      expect(result.textDeltas).toEqual(['final']);
      expect(result.reasoningDeltas).toEqual(['secret plan']);
    });

    it('recognises a think span whose tags are split across stream frames', async () => {
      const result = await splitStream(
        framesOf(
          { choices: [{ delta: { content: '<thi' } }] },
          { choices: [{ delta: { content: 'nk>step one' } }] },
          { choices: [{ delta: { content: ' step two</thi' } }] },
          { choices: [{ finish_reason: 'stop', delta: { content: 'nk>the answer' } }] }
        )
      );

      expect(result.text).toBe('the answer');
      expect(result.reasoning).toBe('step one step two');
      expect(result.textDeltas.join('')).toBe('the answer');
    });

    it('leaves a think-free streamed answer byte-identical, delta for delta', async () => {
      const result = await splitStream(
        framesOf(
          { choices: [{ delta: { content: 'I will ' } }] },
          { choices: [{ delta: { content: 'check.' } }] },
          { choices: [{ finish_reason: 'stop', delta: {} }] }
        )
      );

      expect(result.textDeltas).toEqual(['I will ', 'check.']);
      expect(result.text).toBe('I will check.');
      expect(result.reasoning).toBeUndefined();
      expect(result.reasoningDeltas).toEqual([]);
    });

    it('leaves markup that only starts like a think tag alone', async () => {
      // `<p>` shares a first character with `<think>` and nothing else. The answer has to come back
      // whole: a hold-back that guesses wrong here eats the beginning of every HTML reply.
      const result = await splitStream(
        framesOf(
          { choices: [{ delta: { content: '<p' } }] },
          { choices: [{ finish_reason: 'stop', delta: { content: '>hello</p>' } }] }
        )
      );

      expect(result.text).toBe('<p>hello</p>');
      expect(result.reasoning).toBeUndefined();
    });

    it('leaves a think tag that is not at the start of the answer where the model put it', async () => {
      const result = await splitStream(
        framesOf({
          choices: [{ finish_reason: 'stop', delta: { content: 'here: <think>x</think>' } }]
        })
      );

      expect(result.text).toBe('here: <think>x</think>');
      expect(result.reasoning).toBeUndefined();
    });

    it('counts reasoning_content against the generation ceiling like any other output', async () => {
      // Row one of the measured probe: thinking that is never read is thinking no bound can see, so
      // a route that loops inside its own deliberation runs to the clock rather than to the ceiling.
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          controller.enqueue(
            encode('data: {"choices":[{"delta":{"reasoning_content":"0123456789"}}]}\n\n')
          );
        }
      });

      const result = (await splitStream(body, {
        generationMaxChars: 25,
        generationTimeoutMs: 300
      })) as { reasoning?: string } & { truncated?: { reason: string } };

      expect((result as { truncated?: { reason: string } }).truncated?.reason).toBe('overrun');
      expect(result.reasoning?.length ?? 0).toBeGreaterThan(25);
    });

    it('reads reasoning_content off a non-streamed message too', async () => {
      await expect(
        jsonAnswer({ content: 'answer', reasoning_content: 'deliberating hard' })
      ).resolves.toMatchObject({ text: 'answer', reasoning: 'deliberating hard' });
    });

    it('splits a leading think span out of a non-streamed answer', async () => {
      await expect(
        jsonAnswer({ content: '<think>secret plan</think>final' })
      ).resolves.toMatchObject({ text: 'final', reasoning: 'secret plan' });
    });

    it('keeps an unterminated think span in the thinking column rather than reopening it as prose', async () => {
      // The stream ended inside the span. The fragments went out over `onReasoningDelta` as they
      // arrived and the owner has already read them there; publishing the same words a second time
      // as the answer is the whole of the defect. What is held back when the reader stops has to
      // land, though - a silent truncation on the paths that already have the least to show would
      // be a worse trade than the one being made.
      const result = await splitStream(
        framesOf(
          { choices: [{ delta: { content: '<think>halfway through a plan' } }] },
          { choices: [{ finish_reason: 'stop', delta: { content: ' and then</thi' } }] }
        )
      );

      expect(result.text).toBe('');
      expect(result.reasoning).toBe('halfway through a plan and then</thi');
      expect(result.textDeltas).toEqual([]);
    });

    it('leaves an unterminated think tag in a complete answer exactly where the model put it', async () => {
      // The opposite ruling to the streamed one above, and deliberately: the whole answer is in
      // hand here, so an opening tag with no closing one is prose, not a span.
      await expect(jsonAnswer({ content: '<think>this never closes' })).resolves.toMatchObject({
        text: '<think>this never closes'
      });
    });

    it('drops the blank line the templates put after the closing tag', async () => {
      await expect(
        jsonAnswer({ content: '<think>planning</think>\n\nThe answer.' })
      ).resolves.toMatchObject({ text: 'The answer.', reasoning: 'planning' });
    });

    it('reads a span the model opened after a newline, and not one buried behind an indent', async () => {
      await expect(
        jsonAnswer({ content: '\n<think>planning</think>answer' })
      ).resolves.toMatchObject({ text: 'answer', reasoning: 'planning' });
      // Nine spaces is past the bound on both splitters, so the two agree that this is prose.
      const streamed = await splitStream(
        framesOf({
          choices: [{ finish_reason: 'stop', delta: { content: '         <think>x</think>y' } }]
        })
      );
      expect(streamed.text).toBe('         <think>x</think>y');
      await expect(jsonAnswer({ content: '         <think>x</think>y' })).resolves.toMatchObject({
        text: '         <think>x</think>y'
      });
    });

    it('still refuses to replay a turn whose every delta went to the thinking column', async () => {
      // The retry rule refuses to replay a request whose words the owner has already seen, and it
      // learns that from the two delta callbacks. Routing a leading think span away from
      // `onTextDelta` must not quietly make a turn replayable that was not replayable before - the
      // owner would watch the same deliberation arrive twice, and every discarded attempt's
      // reasoning tokens were billed by the provider and recorded nowhere.
      let attempts = 0;
      let textDeltas = 0;
      const reasoningDeltas: string[] = [];
      const gateway = new ModelGateway({
        retry: {
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          maxRetryAfterMs: 0,
          random: () => 0,
          sleep: async () => undefined
        }
      }).register('self-hosted', {
        provider: 'self-hosted',
        privacyRoute: 'local',
        list: async () => [],
        chat: async (request) => {
          attempts += 1;
          let delivered = false;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!delivered) {
                delivered = true;
                controller.enqueue(
                  encode('data: {"choices":[{"delta":{"content":"<think>deliberating hard"}}]}\n\n')
                );
                return;
              }
              controller.error(
                Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } })
              );
            }
          });
          return streamingAdapter(body).chat(request);
        }
      });

      const failure = await gateway
        .chat('self-hosted', {
          model: 'deepseek-r1',
          messages: [{ role: 'user', content: 'go' }],
          tools: [],
          temperature: 0.2,
          onTextDelta: () => {
            textDeltas += 1;
          },
          onReasoningDelta: (delta) => {
            reasoningDeltas.push(delta);
          }
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GardenError);
      expect(reasoningDeltas.join('')).toBe('deliberating hard');
      // Nothing at all reached the text channel, so `attempts` is the reasoning watch on its own.
      expect(textDeltas).toBe(0);
      expect(attempts).toBe(1);
    });

    it('splits the span out of a stream a buffering proxy turned back into JSON', async () => {
      // The third way into the assembly, and the one that is easy to forget: a proxy that swallowed
      // `stream: true` answers with an ordinary completion body, no frame parses, and the reply is
      // read once as a completion rather than thrown away. Nothing was published delta by delta on
      // that path, so this is the only chance the span gets.
      const textDeltas: string[] = [];
      const answer = (await new OpenAICompatibleAdapter({
        baseUrl: 'https://litellm.internal/v1',
        provider: 'self-hosted',
        privacyRoute: 'local',
        fetch: (async () =>
          new Response(
            JSON.stringify({
              choices: [
                { finish_reason: 'stop', message: { content: '<think>secret plan</think>final' } }
              ],
              usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )) as typeof fetch
      }).chat({
        model: 'deepseek-r1',
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        temperature: 0.2,
        onTextDelta: (delta) => {
          textDeltas.push(delta);
        }
      })) as { text: string; reasoning?: string };

      expect(answer.text).toBe('final');
      expect(answer.reasoning).toBe('secret plan');
      expect(textDeltas).toEqual([]);
    });

    it('leaves a think-free non-streamed answer byte-identical', async () => {
      const answer = await jsonAnswer({ content: 'The importer reads all three columns.' });
      expect(answer.text).toBe('The importer reads all three columns.');
      expect(answer.reasoning).toBeUndefined();
    });
  });
});

/**
 * Which of the companies serving a model gets the work.
 *
 * The aggregator serves one model from several at different prices and wildly different speeds,
 * and given no preference it picks among the cheapest weighted by the inverse square of price -
 * the wrong objective for an agent, whose turn is dozens of sequential calls. The comparison is
 * asked of the aggregator rather than attempted here: its throughput figures come from every
 * request it has ever served, where a single box only ever sees the endpoints it was already
 * routed to.
 */
describe('the operator an agent request asks for', () => {
  const capture = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/models'))
        return new Response(JSON.stringify({ data: [{ id: 'vendor/model' }] }), { status: 200 });
      // Only the call that carries the request. The zero-data-retention route probes
      // `/endpoints/zdr` first, and a capture that took every body would report that GET's empty
      // one as the request and quietly pass every assertion below against nothing.
      if (!url.includes('/chat/completions'))
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = typeof init?.body === 'string' ? init.body : '{}';
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          model: 'vendor/model',
          provider: 'Novita',
          choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        }),
        { status: 200 }
      );
    });
    return { bodies, request };
  };
  const ask = async (
    over: Record<string, unknown>,
    options: { zdr?: boolean; provider?: string } = {}
  ) => {
    const { bodies, request } = capture();
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      provider: options.provider ?? 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: options.zdr ?? false,
      fetch: request as typeof fetch
    });
    await adapter.chat({
      model: 'vendor/model',
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      temperature: 0.2,
      ...over
    });
    return bodies[0]!;
  };
  const rule = { sort: 'price' as const, preferred_min_throughput: 56 };

  it('asks for the cheapest company clearing a floor the aggregator checks itself', async () => {
    const body = await ask({ providerPreferences: rule });
    expect(body.provider).toMatchObject({ sort: 'price', preferred_min_throughput: 56 });
  });

  /*
   * Not a preference, and never traded against one. An endpoint that drops the tool list does not
   * fail - it answers in prose while the harness waits for a call, which reads as the model having
   * become stupid rather than as a routing fault.
   */
  it('never accepts an operator that would drop the tool list', async () => {
    const body = await ask({ providerPreferences: rule });
    expect(body.provider).toMatchObject({ require_parameters: true });
  });

  /*
   * The floor deprioritises rather than excludes, so it can never fail a request on its own - but a
   * route that also turned fallbacks off would fail on one busy company, and would trade the whole
   * point of an aggregator for a speed preference.
   */
  it('keeps falling back when every preferred operator is busy', async () => {
    expect(await ask({ providerPreferences: rule })).toHaveProperty(
      'provider.allow_fallbacks',
      true
    );
  });

  it('sends nothing at all when this computer has no preference', async () => {
    expect(await ask({})).not.toHaveProperty('provider');
  });

  it('does not send an aggregator’s routing block to a route with no operators to choose', async () => {
    const body = await ask({ providerPreferences: rule }, { provider: 'ollama-cloud' });
    expect(body).not.toHaveProperty('provider');
  });

  /*
   * The privacy floor is not a routing preference and is never weakened by one: a request that
   * enforces zero data retention still says so with a speed rule beside it.
   */
  it('keeps the data-retention refusal alongside the speed rule', async () => {
    const body = await ask({ providerPreferences: rule }, { zdr: true });
    expect(body.provider).toMatchObject({
      sort: 'price',
      preferred_min_throughput: 56,
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: true
    });
  });

  it('passes on an operator the owner struck off', async () => {
    const body = await ask({ providerPreferences: { ...rule, ignore: ['novita'] } });
    expect(body.provider).toMatchObject({ ignore: ['novita'] });
  });
});
