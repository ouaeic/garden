import { AthanorError } from '@athanor/core';
import type { ModelAdapter, ModelRequest, ModelResponse, ProviderModel } from './protocol.js';
import { defaultRetryPolicy, withRetry, type RetryPolicy } from './retry.js';
import { interruptedResponseOf } from './interrupted-response.js';

export type { RetryPolicy } from './retry.js';
// The wall question, published beside the gateway that asks it: a caller deciding whether to park a
// task or fail it is asking the same thing the retry loop asks, and must not answer it from its own
// copy of the rule.
export { isProviderWall, isProviderWallStatus } from './retry.js';

export class ModelGateway {
  readonly #adapters = new Map<string, ModelAdapter>();
  readonly #retry: RetryPolicy;

  constructor(options: { retry?: RetryPolicy } = {}) {
    this.#retry = options.retry ?? defaultRetryPolicy;
  }

  register(name: string, adapter: ModelAdapter): this {
    this.#adapters.set(name, adapter);
    return this;
  }

  has(name: string): boolean {
    return this.#adapters.has(name);
  }

  async list(): Promise<ProviderModel[]> {
    const results = await Promise.allSettled(
      [...this.#adapters.values()].map((adapter) => adapter.list())
    );
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }

  async chat(
    provider: string,
    request: ModelRequest,
    options?: { retry?: boolean }
  ): Promise<ModelResponse> {
    const adapter = this.#adapters.get(provider);
    if (!adapter)
      throw new AthanorError('provider_not_configured', `Provider ${provider} is not configured`);
    // A long-running task must not die on one transient upstream fault, but replaying a request
    // whose output the owner has already seen would duplicate it, so streaming is watched here
    // rather than trusted to the adapter.
    //
    // Both channels count. Reasoning is published to the timeline delta by delta exactly as text
    // is, so watching only text meant a high-effort step that streamed ninety seconds of thinking
    // and then lost the socket was replayed three more times: the owner watched the same reasoning
    // appear four times, every discarded attempt's reasoning tokens were billed by the provider and
    // recorded nowhere, and the sequence could spend most of the caller's deadline before the
    // attempt that would have worked.
    let streamed = false;
    const onTextDelta = request.onTextDelta;
    const onReasoningDelta = request.onReasoningDelta;
    const attempted: ModelRequest =
      onTextDelta || onReasoningDelta
        ? {
            ...request,
            ...(onTextDelta
              ? {
                  onTextDelta: async (delta: string): Promise<void> => {
                    streamed = true;
                    await onTextDelta(delta);
                  }
                }
              : {}),
            ...(onReasoningDelta
              ? {
                  onReasoningDelta: async (delta: string): Promise<void> => {
                    streamed = true;
                    await onReasoningDelta(delta);
                  }
                }
              : {})
          }
        : request;
    return withRetry(
      () =>
        adapter.chat(attempted).catch((error: unknown) => {
          if (interruptedResponseOf(error)) streamed = true;
          throw error;
        }),
      {
        policy: options?.retry === false ? { ...this.#retry, maxAttempts: 1 } : this.#retry,
        hasStreamed: () => streamed,
        ...(request.signal ? { signal: request.signal } : {})
      }
    );
  }
}
