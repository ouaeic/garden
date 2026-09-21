import { randomUUID } from 'node:crypto';
import { AthanorError, privateDiagnostics, recordPrivateDiagnostic } from '@athanor/core';
import {
  DiagnosticModelRequest,
  diagnosticModelResponse,
  diagnosticModelError
} from './model-diagnostics.js';
import type { ModelAdapter, ModelRequest, ModelResponse, ProviderModel } from './protocol.js';
import { defaultRetryPolicy, withRetry, type RetryPolicy } from './retry.js';
import { interruptedResponseOf } from './interrupted-response.js';
import type { DecisionAdapter, DecisionRequest, DecisionResponse } from './decisions.js';

export type { RetryPolicy } from './retry.js';
// The wall question, published beside the gateway that asks it: a caller deciding whether to park a
// task or fail it is asking the same thing the retry loop asks, and must not answer it from its own
// copy of the rule.
export { isProviderWall, isProviderWallStatus } from './retry.js';

export class ModelGateway {
  readonly #adapters = new Map<string, ModelAdapter>();
  readonly #decisions = new Map<string, DecisionAdapter>();
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

  registerDecisions(name: string, adapter: DecisionAdapter): this {
    this.#decisions.set(name, adapter);
    return this;
  }

  async decide(provider: string, request: DecisionRequest): Promise<DecisionResponse> {
    const adapter = this.#decisions.get(provider);
    if (!adapter)
      throw new AthanorError(
        'decision_route_unavailable',
        'The selected connection does not offer decision inference.',
        409
      );
    const trace = privateDiagnostics() ? randomUUID() : null;
    if (trace)
      await recordPrivateDiagnostic('decision_request', () => ({
        id: trace,
        provider,
        request: {
          model: request.model,
          state: request.state,
          questions: request.questions,
          inputRate: request.inputRate,
          outputRate: request.outputRate,
          sessionId: request.sessionId
        }
      }));
    try {
      const response = await adapter.decide(request);
      if (trace)
        await recordPrivateDiagnostic('decision_outcome', () => ({
          id: trace,
          outcome: 'completed',
          response: {
            answers: response.answers,
            usage: {
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              totalTokens: response.usage.totalTokens,
              ...(response.usage.costUsd === undefined ? {} : { costUsd: response.usage.costUsd })
            },
            metadata: {
              model: response.metadata.model,
              latencyMs: response.metadata.latencyMs,
              ...(response.metadata.generationId === undefined
                ? {}
                : { generationId: response.metadata.generationId }),
              ...(response.metadata.upstreamProvider === undefined
                ? {}
                : { upstreamProvider: response.metadata.upstreamProvider })
            }
          }
        }));
      return response;
    } catch (error) {
      if (trace)
        await recordPrivateDiagnostic('decision_outcome', {
          id: trace,
          outcome: 'failed',
          error: diagnosticModelError(error)
        });
      throw error;
    }
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
    const trace = privateDiagnostics() ? randomUUID() : null;
    if (trace)
      await recordPrivateDiagnostic('model_request', () => ({
        id: trace,
        provider,
        privacyRoute: adapter.privacyRoute,
        request: DiagnosticModelRequest.parse(request)
      }));
    let attempt = 0;
    try {
      const response = await withRetry(
        async () => {
          attempt++;
          if (trace) await recordPrivateDiagnostic('model_attempt', { id: trace, attempt });
          try {
            const response = await adapter.chat(attempted);
            if (trace)
              await recordPrivateDiagnostic('model_outcome', () => ({
                id: trace,
                attempt,
                outcome: 'completed',
                response: diagnosticModelResponse(response)
              }));
            return response;
          } catch (error) {
            const partial = interruptedResponseOf(error);
            if (partial) streamed = true;
            if (trace)
              await recordPrivateDiagnostic('model_outcome', () => ({
                id: trace,
                attempt,
                outcome: partial ? 'interrupted' : 'failed',
                error: diagnosticModelError(error),
                ...(partial ? { response: diagnosticModelResponse(partial) } : {})
              }));
            throw error;
          }
        },
        {
          policy: options?.retry === false ? { ...this.#retry, maxAttempts: 1 } : this.#retry,
          hasStreamed: () => streamed,
          ...(request.signal ? { signal: request.signal } : {})
        }
      );
      if (trace)
        await recordPrivateDiagnostic('model_end', {
          id: trace,
          attempts: attempt,
          outcome: 'completed'
        });
      return response;
    } catch (error) {
      if (trace)
        await recordPrivateDiagnostic('model_end', {
          id: trace,
          attempts: attempt,
          outcome: interruptedResponseOf(error) ? 'interrupted' : 'failed'
        });
      throw error;
    }
  }
}
