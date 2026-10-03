/**
 * What a live row's token columns are summed over, driven against a provider that is a local
 * socket rather than a script.
 *
 * The claim under test: the input, cached and output token sums on `RunOutcome` cover the same
 * calls `modelCalls` counts and `providerCostUsd` prices - every request the loop sent to the
 * provider - and not only the ones the loop writes a `cost` event for. A lead step and the closing
 * handoff write one; a compaction's summariser, a vision handoff, a delegated specialist's steps
 * and a provider search record a usage row and write nothing. A delegated specialist is the
 * cheapest of those to drive deterministically: the lead delegates, the specialist answers in one
 * call, the lead finishes. Three requests, three usage rows, two cost events.
 *
 * The provider here answers with the wire's own shapes - a streamed completion with its usage
 * frame before `[DONE]`, a plain completion with usage on the body - and puts a different prompt
 * count and price on every response, so a sum that skipped one is caught by the arithmetic and
 * not by a count alone.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { runFixture, usageFrameOf, type Fixture } from '../harness.js';

interface Answer {
  readonly text?: string;
  readonly calls?: ReadonlyArray<{ id: string; name: string; args: unknown }>;
}

/** The provider's usage for the n-th response it sends, distinct per call on purpose. */
const usageFor = (n: number) => ({
  prompt_tokens: 1_000 * n + 100,
  completion_tokens: 10 * n + 1,
  total_tokens: 1_000 * n + 100 + 10 * n + 1,
  prompt_tokens_details: { cached_tokens: 100 * n },
  cost: 0.001 * n
});

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const streamed = (answer: Answer, n: number, withUsage = true): string =>
  [
    sse({
      choices: [
        {
          finish_reason: answer.calls?.length ? 'tool_calls' : 'stop',
          delta: {
            ...(answer.text === undefined ? {} : { content: answer.text }),
            ...(answer.calls?.length
              ? {
                  tool_calls: answer.calls.map((call, index) => ({
                    index,
                    id: call.id,
                    function: { name: call.name, arguments: JSON.stringify(call.args) }
                  }))
                }
              : {})
          }
        }
      ]
    }),
    ...(withUsage ? [sse({ choices: [], usage: usageFor(n) })] : []),
    'data: [DONE]\n\n'
  ].join('');

const plain = (answer: Answer, n: number, withUsage = true): string =>
  JSON.stringify({
    choices: [
      {
        finish_reason: answer.calls?.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: answer.text ?? '',
          ...(answer.calls?.length
            ? {
                tool_calls: answer.calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) }
                }))
              }
            : {})
        }
      }
    ],
    ...(withUsage ? { usage: usageFor(n) } : {})
  });

interface FakeProvider {
  readonly baseUrl: string;
  readonly responses: number;
  readonly requests: string[];
  close(): Promise<void>;
}

/**
 * A provider on a local socket. Which answer it sends is decided by the request's own catalogue,
 * the way the harness's scripted branch decides it: a catalogue with `finish` is the lead, one
 * without it is a specialist, none at all is a summariser.
 */
const fakeProvider = async (
  /** The ordinal of one response to send with no usage frame at all, as a cut stream would. */
  frameless?: number
): Promise<FakeProvider> => {
  let responses = 0;
  let leadCalls = 0;
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      if (!(request.url ?? '').endsWith('/chat/completions')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      const body = JSON.parse(raw) as {
        stream?: boolean;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const names = (body.tools ?? []).map((tool) => tool.function?.name ?? '');
      const kind = names.includes('shell') ? 'lead' : names.length ? 'specialist' : 'summariser';
      requests.push(kind);
      let answer: Answer;
      if (kind === 'lead') {
        leadCalls += 1;
        answer =
          leadCalls === 1
            ? {
                calls: [
                  {
                    id: 'call-1',
                    name: 'delegate',
                    args: {
                      missions: [
                        {
                          name: 'survey',
                          instruction: 'Say in one line what workspace/notes.txt is about.'
                        }
                      ]
                    }
                  }
                ]
              }
            : { text: 'Done.' };
      } else {
        answer = { text: 'The notes are a one-line placeholder.' };
      }
      responses += 1;
      const n = responses;
      const withUsage = n !== frameless;
      if (body.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(streamed(answer, n, withUsage));
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(plain(answer, n, withUsage));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    get responses() {
      return responses;
    },
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
};

const providers: FakeProvider[] = [];
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
});

describe('usageFrameOf', () => {
  it('reads the frame off a stream, off a body, and nothing off a cut stream', () => {
    expect(usageFrameOf(streamed({ text: 'hi' }, 3))).toEqual({
      inputTokens: 3_100,
      cachedTokens: 300,
      outputTokens: 31,
      costUsd: 0.003
    });
    expect(usageFrameOf(plain({ text: 'hi' }, 2))).toEqual({
      inputTokens: 2_100,
      cachedTokens: 200,
      outputTokens: 21,
      costUsd: 0.002
    });
    // A cut stream: deltas and then nothing. No frame, so no number - not zero.
    expect(usageFrameOf(sse({ choices: [{ delta: { content: 'partial' } }] }))).toBeNull();
    expect(usageFrameOf('')).toBeNull();
    // The other spelling of a cache read, and a route that does not price its calls.
    expect(
      usageFrameOf(
        JSON.stringify({
          usage: { prompt_tokens: 5, completion_tokens: 1, cache_read_input_tokens: 4 }
        })
      )
    ).toEqual({ inputTokens: 5, cachedTokens: 4, outputTokens: 1, costUsd: null });
  });
});

describe('a live run sums its provider usage over every call', () => {
  it('counts the specialist the cost events do not', async () => {
    const provider = await fakeProvider();
    providers.push(provider);
    const fixture: Fixture = {
      id: 'live-usage-delegated',
      shape: 'research',
      request: 'Have a specialist tell me what workspace/notes.txt is about.',
      why: 'Drives the live branch against a local provider so every provider call is a counted, priced and summed call.',
      runner: { files: { 'workspace/notes.txt': 'A placeholder.\n' } },
      // Never consulted: every request under `live.baseUrl` is forwarded to the socket.
      model: () => ({ text: 'unreachable' }),
      live: {
        baseUrl: provider.baseUrl,
        apiKey: 'test-key',
        provider: 'openai-compatible',
        providerModelId: 'fake/model',
        contextTokens: 200_000
      },
      expect: {}
    };
    const outcome = await runFixture(fixture);
    expect(outcome.error).toBeNull();
    expect(outcome.status).toBe('completed');
    // Lead, specialist, lead: three requests left the process and three answers came back.
    expect(provider.requests).toEqual(['lead', 'specialist', 'lead']);
    expect(outcome.modelCalls).toBe(3);
    // (`delegatedCalls` is classified by the scripted branch, which a live run never enters.)
    expect(outcome.providerCalls).toBe(3);
    // The loop wrote a cost event for the two lead steps and none for the specialist - which is
    // exactly why the sums cannot come from the events.
    expect(outcome.events.filter((event) => event.kind === 'cost')).toHaveLength(2);
    // Summed over all three responses, by the provider's own numbers.
    const frames = [1, 2, 3].map(usageFor);
    const sum = (key: 'prompt_tokens' | 'completion_tokens' | 'cost'): number =>
      frames.reduce((total, frame) => total + frame[key], 0);
    expect(outcome.providerInputTokens).toBe(sum('prompt_tokens'));
    expect(outcome.promptTokens).toBe(sum('prompt_tokens'));
    expect(outcome.providerOutputTokens).toBe(sum('completion_tokens'));
    expect(outcome.providerCachedTokens).toBe(
      frames.reduce((total, frame) => total + frame.prompt_tokens_details.cached_tokens, 0)
    );
    // The route's own price off every frame, and nothing had to be read off the ledger.
    expect(outcome.providerCostUsd).toBeCloseTo(sum('cost'), 9);
    expect(outcome.providerUsageFallbacks).toBe(0);
  }, 60_000);

  it('prices a response with no frame from the ledger, and says that it did', async () => {
    /*
     * The third response - the lead's closing call - goes out with no usage frame, which is what
     * a stream cut before its last data frame looks like. The gateway then estimates the output
     * and the loop bills its own input estimate; the harness has no provider number for that call
     * and must not drop it (a call that cost money would vanish from the cost column) nor zero it
     * (a call that cost money would be summed as free). It falls back to the ledger row the loop
     * wrote for that call, and the outcome says one call did.
     */
    const provider = await fakeProvider(3);
    providers.push(provider);
    const fixture: Fixture = {
      id: 'live-usage-frameless',
      shape: 'research',
      request: 'Have a specialist tell me what workspace/notes.txt is about.',
      why: 'One answered response carries no usage frame; its cost and tokens come from the ledger, counted as a fallback.',
      runner: { files: { 'workspace/notes.txt': 'A placeholder.\n' } },
      model: () => ({ text: 'unreachable' }),
      live: {
        baseUrl: provider.baseUrl,
        apiKey: 'test-key',
        provider: 'openai-compatible',
        providerModelId: 'fake/model',
        contextTokens: 200_000
      },
      expect: {}
    };
    const outcome = await runFixture(fixture);
    expect(outcome.error).toBeNull();
    expect(outcome.status).toBe('completed');
    expect(outcome.modelCalls).toBe(3);
    // Still three calls: the frameless one is counted, not dropped - and counted as a fallback.
    expect(outcome.providerCalls).toBe(3);
    expect(outcome.providerUsageFallbacks).toBe(1);
    // The loop's own figures for that call, off the cost event its step wrote: an estimated
    // output count, and the price the ledger row was written with.
    const costEvents = outcome.events.filter((event) => event.kind === 'cost');
    expect(costEvents).toHaveLength(2);
    const estimated = (costEvents[1]?.payload as {
      costUsd: number;
      usage: { estimated?: boolean; outputTokens: number };
      context: { estimatedInputTokens: number };
    }) ?? { costUsd: 0, usage: { outputTokens: 0 }, context: { estimatedInputTokens: 0 } };
    expect(estimated.usage.estimated).toBe(true);
    const frames = [1, 2].map(usageFor);
    expect(outcome.providerCostUsd).toBeCloseTo(
      frames.reduce((total, frame) => total + frame.cost, 0) + estimated.costUsd,
      9
    );
    expect(outcome.providerOutputTokens).toBe(
      frames.reduce((total, frame) => total + frame.completion_tokens, 0) +
        estimated.usage.outputTokens
    );
    // The frameless call's input is the loop's billed estimate: at least the window it prepared.
    const framed = frames.reduce((total, frame) => total + frame.prompt_tokens, 0);
    expect(outcome.providerInputTokens - framed).toBeGreaterThanOrEqual(
      estimated.context.estimatedInputTokens
    );
    expect(outcome.promptTokens).toBe(outcome.providerInputTokens);
  }, 60_000);
});
