import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './openai-compatible.js';

const encode = (text: string) => new TextEncoder().encode(text);
const frame = (delta: unknown, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({
    id: 'gen-independent-stream-fixture',
    object: 'chat.completion.chunk',
    created: 1789612800,
    model: 'fixture-model',
    provider: 'fixture-provider',
    system_fingerprint: 'fp_stream_contract',
    obfuscation: 'padding-for-small-deltas',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: null }],
    ...extra
  })}\n\n`;
const run = (body: ReadableStream<Uint8Array>, maxChars: number) => {
  const deltas: string[] = [];
  const adapter = new OpenAICompatibleAdapter({
    provider: 'fixture',
    privacyRoute: 'external',
    baseUrl: 'https://fixture.invalid/v1',
    generationMaxChars: maxChars,
    fetch: vi.fn(async () => new Response(body)) as typeof fetch
  });
  const result = adapter.chat({
    model: 'fixture-model',
    messages: [{ role: 'user', content: 'Test the stream contract' }],
    tools: [],
    temperature: 0.2,
    onTextDelta: (text) => {
      deltas.push(text);
    }
  });
  return { result, deltas };
};

describe('provider stream framing', () => {
  it.each(['\n', '\r', '\r\n'])(
    'handles multiline events and byte-split Unicode with %j separators',
    async (separator) => {
      const text = [
        ': keep alive',
        'data: {"choices": [',
        'data: {"delta": {"content": "分析 🧬"}, "finish_reason": "stop"}',
        'data: ]}',
        '',
        'data: [DONE]',
        '',
        ''
      ].join(separator);
      const bytes = encode(text);
      let offset = 0;
      const { result } = run(
        new ReadableStream({
          pull(controller) {
            if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset));
            else controller.close();
          }
        }),
        200
      );
      const answer = await result;
      expect(answer.text).toBe('分析 🧬');
      expect(answer.truncated).toBeUndefined();
    }
  );

  it('accepts a large valid tool argument split over small transport chunks', async () => {
    const value = 'x'.repeat(100_000);
    const text =
      frame(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call-long',
              function: { name: 'write', arguments: JSON.stringify({ value }) }
            }
          ]
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-long',
                    function: { name: 'write', arguments: JSON.stringify({ value }) }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        }
      ) + 'data: [DONE]\n\n';
    let offset = 0;
    const { result } = run(
      new ReadableStream({
        pull(controller) {
          if (offset >= text.length) {
            controller.close();
            return;
          }
          controller.enqueue(encode(text.slice(offset, (offset += 127))));
        }
      }),
      110_000
    );
    const answer = await result;
    expect(answer.toolCalls).toEqual([{ id: 'call-long', name: 'write', arguments: { value } }]);
    expect(answer.truncated).toBeUndefined();
  });

  it('bounds retained opaque reasoning independently of text output', async () => {
    let pulls = 0;
    const cancelled = vi.fn();
    const { result } = run(
      new ReadableStream({
        pull(controller) {
          pulls += 1;
          controller.enqueue(
            encode(
              frame({
                content: 'x',
                reasoning_details: [{ type: 'reasoning.encrypted', data: 'a'.repeat(500_000) }]
              })
            )
          );
        },
        cancel: cancelled
      }),
      20_000
    );
    const answer = await result;
    expect(answer.truncated?.reason).toBe('framing');
    expect(answer.truncated?.detail).toContain('metadata limit');
    expect(JSON.stringify(answer.reasoningDetails).length).toBeLessThan(4_000_000);
    expect(answer.reasoningDetails?.length).toBeGreaterThan(0);
    expect(pulls).toBeLessThan(12);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each([true, false])('bounds an oversized SSE event, terminated=%s', async (terminated) => {
    const cancelled = vi.fn();
    const { result } = run(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encode(
              frame({ content: 'kept' }) +
                'data: ' +
                'a'.repeat(1_100_000) +
                (terminated ? '\n\n' : '')
            )
          );
        },
        cancel: cancelled
      }),
      20_000
    );
    const answer = await result;
    expect(answer.text).toBe('kept');
    expect(answer.truncated?.reason).toBe('framing');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('bounds a multiline event with no terminating separator', async () => {
    let pulls = 0;
    const { result } = run(
      new ReadableStream({
        pull(controller) {
          pulls += 1;
          controller.enqueue(
            encode(pulls === 1 ? frame({ content: 'kept' }) : `data: ${'a'.repeat(100_000)}\n`)
          );
        }
      }),
      20_000
    );
    const answer = await result;
    expect(answer.text).toBe('kept');
    expect(answer.truncated?.reason).toBe('framing');
    expect(pulls).toBeLessThan(15);
  });

  it('ignores non-object event data without mistaking it for an answer', async () => {
    const { result } = run(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encode(
              'data: null\n\ndata: 12\n\ndata: []\n\n' +
                frame({ content: 'valid' }) +
                'data: [DONE]\n\n'
            )
          );
          controller.close();
        }
      }),
      100
    );
    expect((await result).text).toBe('valid');
  });

  it.each([1, 4])(
    'retains complete output and final usage with %i-character provider deltas',
    async (size) => {
      const expected = 'text'.repeat(250);
      expect(frame({ content: 'x' }).length).toBeLessThan(512);
      const packets: string[] = [];
      for (let start = 0; start < expected.length; start += size)
        packets.push(frame({ content: expected.slice(start, start + size) }));
      packets.push(
        frame(
          {},
          {
            choices: [],
            usage: { prompt_tokens: 91, completion_tokens: 250, total_tokens: 341, cost: 0.002 }
          }
        ),
        'data: [DONE]\n\n'
      );
      const { result, deltas } = run(
        new ReadableStream({
          pull(controller) {
            const packet = packets.shift();
            if (packet) controller.enqueue(encode(packet));
            else controller.close();
          }
        }),
        1100
      );
      const answer = await result;
      expect(answer.text).toBe(expected);
      expect(deltas.join('')).toBe(expected);
      expect(answer.truncated).toBeUndefined();
      expect(answer.usage).toMatchObject({ inputTokens: 91, outputTokens: 250, costUsd: 0.002 });
      expect(answer.usage.estimated).toBeUndefined();
    }
  );

  it('stops within a coalesced network chunk at the generated-output bound', async () => {
    const cancelled = vi.fn();
    const { result, deltas } = run(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encode(Array.from({ length: 1000 }, () => frame({ content: 'abcdefgh' })).join(''))
          );
        },
        cancel: cancelled
      }),
      32
    );
    const answer = await result;
    expect(answer.truncated?.reason).toBe('overrun');
    expect(answer.text).toBe('abcdefgh'.repeat(5));
    expect(deltas).toHaveLength(5);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('finishes at the terminal marker even when the transport stays open', async () => {
    const cancelled = vi.fn();
    const { result } = run(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encode(
              frame(
                { content: 'done' },
                { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }
              ) +
                frame(
                  {},
                  {
                    choices: [],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
                  }
                ) +
                'data: [DONE]\n\n' +
                frame({ content: 'must not appear' })
            )
          );
        },
        cancel: cancelled
      }),
      100
    );
    const answer = await result;
    expect(answer.text).toBe('done');
    expect(answer.truncated).toBeUndefined();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
