import { performance } from 'node:perf_hooks';
import { AthanorError } from '@athanor/core';
import { duplicatedWebCapabilities } from '@athanor/contracts';
import type { ModelAdapter, ModelRequest, ModelResponse } from './protocol.js';
import {
  OpenAICompatibleAdapter,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  type CompatibleAdapterOptions
} from './openai-compatible.js';
import { continuationBinding, responseInputs } from './native-continuation.js';
import { assertReasoningEffort } from './reasoning.js';
import { responseAccumulator, responseFault } from './responses-output.js';
import { retainInterruptedResponse } from './interrupted-response.js';
import {
  DEFAULT_GENERATION_TIMEOUT_MS,
  generationCharCeiling,
  startGenerationBudget,
  streamIdleTimeoutFor
} from './generation-budget.js';
import { MAX_STREAM_LINE_CHARS, MAX_STREAM_METADATA_CHARS, streamLimits } from './stream-limits.js';

/** Stateless native text/image transport. The compatible catalogue and native audio path stay shared. */
export class OpenAIResponsesAdapter implements ModelAdapter {
  readonly provider: string;
  readonly privacyRoute: string;
  readonly #options: CompatibleAdapterOptions;
  readonly #catalogue: OpenAICompatibleAdapter;
  constructor(options: CompatibleAdapterOptions) {
    this.#options = { ...options };
    this.provider = options.provider;
    this.privacyRoute = options.privacyRoute;
    this.#catalogue = new OpenAICompatibleAdapter(options);
  }
  list(signal?: AbortSignal) {
    return this.#catalogue.list(signal);
  }
  describe(signal?: AbortSignal) {
    return this.#catalogue.describe(signal);
  }

  async chat(input: ModelRequest): Promise<ModelResponse> {
    if (
      input.messages.some((message) => message.nativeInputs?.length) ||
      /(?:^gpt-audio|audio-preview)/.test(input.model)
    )
      return this.#catalogue.chat(input);
    assertReasoningEffort(input.reasoningEffort, input.reasoningOptions);
    const tools = input.serverTools ?? [];
    if (tools.some((tool) => !['web_search', 'web_search_preview'].includes(tool.type)))
      throw new AthanorError(
        'provider_tool_unsupported',
        'This native route only permits approved web search and Garden function tools'
      );
    if (
      duplicatedWebCapabilities(
        tools,
        input.tools.map((tool) => tool.name)
      ).length
    )
      throw new AthanorError(
        'web_tool_catalogue_conflict',
        'The request contains duplicate web tools'
      );
    const started = performance.now();
    const baseUrl = this.#options.baseUrl.replace(/\/$/, '');
    const binding = continuationBinding(baseUrl, this.#options.apiKey, input, this.privacyRoute);
    const maxTokens =
      input.maxTokens === undefined
        ? input.maxOutputTokens
        : Math.min(input.maxTokens, input.maxOutputTokens ?? input.maxTokens);
    const reasoning =
      input.supportsReasoningEffort !== false &&
      !!(
        input.reasoningEffort ||
        input.reasoningOptions ||
        /^(?:o[1-9]|gpt-[56](?:[.-]|$))/.test(input.model)
      );
    const payloadFor = (messages: ModelRequest['messages']) =>
      JSON.stringify({
        model: input.model,
        store: false,
        service_tier: 'default',
        truncation: 'disabled',
        input: responseInputs(messages, binding),
        tools: [
          ...input.tools.map((tool) => ({ type: 'function', ...tool, strict: false })),
          ...tools.map((tool) => ({ ...tool.parameters, type: tool.type }))
        ],
        ...(reasoning
          ? {
              reasoning: {
                ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
                ...(input.onReasoningDelta ? { summary: 'auto' } : {})
              }
            }
          : { temperature: input.temperature }),
        ...(maxTokens === undefined ? {} : { max_output_tokens: maxTokens }),
        ...(input.onTextDelta || input.onReasoningDelta ? { stream: true } : {})
      });
    const maxBytes = this.#options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    let messages = input.messages;
    let payload = payloadFor(messages);
    let bytes = Buffer.byteLength(payload);
    while (maxBytes > 0 && bytes > maxBytes) {
      const oldest = messages.findIndex((message) => message.images?.length);
      if (oldest < 0)
        throw new AthanorError(
          'provider_context_overflow',
          'The native request exceeds the transport size limit; condense its context',
          413,
          { requestBytes: bytes, maxRequestBytes: maxBytes }
        );
      messages = messages.map((message, index) =>
        index !== oldest
          ? message
          : {
              ...message,
              images: [],
              content:
                message.content +
                '\n[Earlier images omitted to fit the transport limit. Read their source again if this step needs them.]'
            }
      );
      payload = payloadFor(messages);
      bytes = Buffer.byteLength(payload);
    }
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const budget = startGenerationBudget({
      timeoutMs: this.#options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
      maxChars: this.#options.generationMaxChars ?? generationCharCeiling(maxTokens)
    });
    const idleMs = streamIdleTimeoutFor(
      this.#options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      bytes
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const collector = responseAccumulator(
      { ...input, messages },
      {
        provider: this.provider,
        privacyRoute: this.privacyRoute,
        binding,
        started,
        bytes,
        budget
      }
    );
    const arm = () => {
      clearTimeout(timer);
      const remaining = budget.remainingMs();
      const delay = Math.min(remaining, idleMs > 0 ? idleMs : Infinity);
      if (Number.isFinite(delay))
        timer = setTimeout(
          () => {
            collector.cutoff = remaining <= idleMs || idleMs <= 0 ? 'timeout' : 'stalled';
            controller.abort();
          },
          Math.max(0, delay)
        );
    };
    arm();
    try {
      const response = await (this.#options.fetch ?? fetch)(`${baseUrl}/responses`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(this.#options.apiKey ? { authorization: `Bearer ${this.#options.apiKey}` } : {})
        },
        body: payload
      });
      collector.accepted = response.ok;
      if (!response.body)
        throw responseFault(response.status || 502, { message: 'The provider returned no body' });
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const streamed =
        response.ok && (response.headers.get('content-type') ?? '').includes('text/event-stream');
      const framing = streamLimits(budget.maxChars());
      let buffer = '',
        raw = '',
        data: string[] = [],
        dataChars = 0;
      const flush = async () => {
        if (!data.length) return;
        const payload = data.join('\n');
        data = [];
        dataChars = 0;
        if (payload === '[DONE]') return;
        await collector.event(JSON.parse(payload));
      };
      try {
        for (;;) {
          if (signal.aborted) throw signal.reason;
          if (budget.remainingMs() <= 0) {
            collector.cutoff = 'timeout';
            throw Error('Native response deadline elapsed');
          }
          arm();
          const pending = reader.read();
          const part = await new Promise<ReadableStreamReadResult<Uint8Array>>(
            (resolve, reject) => {
              const abort = () =>
                reject(
                  signal.reason instanceof Error ? signal.reason : Error('Native request cancelled')
                );
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
              pending
                .then(resolve, reject)
                .finally(() => signal.removeEventListener('abort', abort));
            }
          );
          const decoded = decoder.decode(part.value, { stream: !part.done });
          if (!streamed) {
            raw += decoded;
            if (raw.length > (response.ok ? MAX_STREAM_METADATA_CHARS : 16_384)) {
              collector.cutoff = 'framing';
              throw Error('Native response body exceeded its limit');
            }
          } else {
            buffer += decoded;
            for (;;) {
              const end = buffer.indexOf('\n');
              if (end < 0) break;
              const line = buffer.slice(0, end).replace(/\r$/, '');
              buffer = buffer.slice(end + 1);
              if (line.length > MAX_STREAM_LINE_CHARS) {
                collector.cutoff = 'framing';
                throw Error('Native stream line exceeded its limit');
              }
              if (!line) await flush();
              else if (line.startsWith('data:')) {
                const value = line.slice(5).trimStart();
                dataChars += value.length;
                data.push(value);
              } else if (framing.line(line.length, false)) {
                collector.cutoff = 'framing';
                throw Error('Native framing exceeded its limit');
              }
              if (dataChars > MAX_STREAM_LINE_CHARS) {
                collector.cutoff = 'framing';
                throw Error('Native stream event exceeded its limit');
              }
              if (collector.body) break;
            }
            if (buffer.length > MAX_STREAM_LINE_CHARS && !collector.body) {
              collector.cutoff = 'framing';
              throw Error('Native stream line exceeded its limit');
            }
          }
          if (collector.body || part.done) break;
        }
        if (!response.ok) {
          let error: unknown;
          try {
            error = JSON.parse(raw);
          } catch {
            error = { message: raw.slice(0, 400) };
          }
          throw responseFault(response.status, error, response.headers.get('retry-after'));
        }
        if (!streamed) {
          collector.completed(JSON.parse(raw));
        }
        if (!collector.body || !['completed', 'incomplete'].includes(collector.body.status))
          throw responseFault(
            502,
            collector.body ?? { message: 'The native stream ended before a final response' }
          );
        const result = collector.finish();
        // Some gateways return JSON even when streaming was requested.
        if (!streamed) {
          if (result.text) await input.onTextDelta?.(result.text);
          if (result.reasoning) await input.onReasoningDelta?.(result.reasoning);
        }
        return result;
      } finally {
        void reader.cancel().catch(() => undefined);
      }
    } catch (cause) {
      if (input.signal?.aborted) collector.cutoff = 'cancelled';
      if (collector.cutoff && collector.accepted) return collector.finish();
      const error =
        cause instanceof AthanorError
          ? cause
          : new AthanorError(
              'provider_unavailable',
              'The native model response was interrupted or invalid',
              502
            );
      if (collector.accepted) retainInterruptedResponse(error, collector.finish(true));
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
