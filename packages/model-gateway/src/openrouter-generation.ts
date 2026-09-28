import { GardenError } from '@garden/core';

/**
 * How fast the company that served one request actually was, in the aggregator's own numbers.
 *
 * This route is the only way a client ever learns a throughput figure. The endpoints catalogue
 * declares `throughput_last_30m` per company and returns null for it on every endpoint of every
 * model - with a valid API key as much as without one - and the aggregator's own site reads those
 * columns from a session-authenticated route that answers an API key with "signed_out". What is
 * available is this: for a request it has already served, `generation_time`, the completion token
 * count and the company that served it, all measured on their side.
 *
 * Tokens over generation time is tokens per second. Asked of a request the aggregator itself routed
 * by throughput, that is a measurement of the fastest company serving the model - which is the one
 * number a relative speed rule needs and cannot otherwise obtain.
 *
 * The generation phase and not the round trip: `latency` includes the queue and the prefill, and a
 * rate computed from it would call a long prompt a slow company.
 */
export interface GenerationThroughput {
  readonly provider: string;
  readonly tokensPerSecond: number;
}

const numberIn = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const fetchGenerationThroughput = async (options: {
  baseUrl: string;
  apiKey: string;
  generationId: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<GenerationThroughput | null> => {
  const request = options.fetch ?? globalThis.fetch;
  try {
    const response = await request(
      `${options.baseUrl.replace(/\/$/, '')}/generation?id=${encodeURIComponent(options.generationId)}`,
      {
        headers: { authorization: `Bearer ${options.apiKey}` },
        signal: options.signal ?? AbortSignal.timeout(8_000)
      }
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: Record<string, unknown> };
    const data = body.data ?? {};
    const provider = typeof data.provider_name === 'string' ? data.provider_name : null;
    const tokens = numberIn(data.native_tokens_completion) ?? numberIn(data.tokens_completion);
    const ms = numberIn(data.generation_time);
    if (!provider || tokens === null || ms === null || ms <= 0) return null;
    /*
     * A short answer is almost entirely overhead however fast the machine is, so a company judged
     * on one would look slow everywhere - and this figure becomes the ceiling every other company
     * is measured against, so an understated one drags the whole floor down with it.
     */
    if (tokens < 64) return null;
    return { provider, tokensPerSecond: tokens / (ms / 1000) };
  } catch (error) {
    // Never a reason a turn fails: this runs after the answer the owner is waiting for has already
    // been delivered, and its only purpose is to make the next turn's routing better informed.
    if (error instanceof GardenError) return null;
    return null;
  }
};
