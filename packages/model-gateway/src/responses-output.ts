import { performance } from 'node:perf_hooks';
import { GardenError } from '@garden/core';
import { webCitationsFrom } from '@garden/contracts';
import { z } from 'zod';
import type { ModelRequest, ModelResponse, ModelToolCall } from './protocol.js';
import {
  NativeResponseItem,
  canonicalInputDigest,
  canonicalMessageDigest,
  responseMessage
} from './native-continuation.js';
import {
  estimatedOutputTokens,
  describeCutoff,
  worthContinuing,
  type GenerationCutoff,
  type GenerationBudget
} from './generation-budget.js';
import { MAX_STREAM_METADATA_CHARS, streamLimits } from './stream-limits.js';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = z.number().int().nonnegative();
const ResponseBody = z.object({
  id: z.string().max(512),
  model: z.string().max(512).optional(),
  status: z.enum(['completed', 'incomplete', 'failed', 'cancelled', 'in_progress', 'queued']),
  output: z.array(NativeResponseItem).max(4096),
  error: z.unknown().optional(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  usage: z
    .object({
      input_tokens: count,
      output_tokens: count,
      total_tokens: count,
      input_tokens_details: z.object({ cached_tokens: count.optional() }).nullish()
    })
    .nullish()
});
type ResponseBody = z.infer<typeof ResponseBody>;

export function responseFault(
  status: number,
  body: unknown,
  retryAfter?: string | null
): GardenError {
  const value = record(body);
  const error = record(value?.error) ?? value;
  const message =
    typeof error?.message === 'string'
      ? error.message.slice(0, 400)
      : 'The provider could not complete the request';
  const context = error?.code === 'context_length_exceeded';
  return new GardenError(
    context
      ? 'provider_context_overflow'
      : status === 429
        ? 'provider_quota_exhausted'
        : status >= 500 || status === 408
          ? 'provider_unavailable'
          : 'provider_request_failed',
    `OpenAI Responses (${status}): ${message}`,
    status,
    retryAfter ? { retryAfter } : {}
  );
}

/** Interpret only completed native calls; partial data remains available for accounting and recovery. */
export function responseAccumulator(
  input: ModelRequest,
  {
    provider,
    privacyRoute,
    binding,
    started,
    bytes,
    budget
  }: {
    provider: string;
    privacyRoute: string;
    binding: string;
    started: number;
    bytes: number;
    budget: GenerationBudget;
  }
) {
  let cutoff: GenerationCutoff | undefined;
  let accepted = false;
  let firstToken: number | undefined;
  let text = '',
    summary = '';
  let body: ResponseBody | undefined;
  let responseId: string | undefined;
  const partialItems = new Map<number, Record<string, unknown>>();
  const limits = streamLimits(budget.maxChars());
  const produced = (characters: number) => {
    if (characters && firstToken === undefined) firstToken = performance.now();
    if (budget.produced(characters)) {
      cutoff = 'overrun';
      throw Error('Native output exceeded its limit');
    }
  };
  const finish = (failure = false): ModelResponse => {
    const items = body?.output ?? [];
    const calls: ModelToolCall[] = [];
    const annotations: unknown[] = [];
    let completeText = '',
      completeReasoning = '';
    for (const item of items) {
      if (item.type === 'message')
        for (const part of item.content) {
          completeText += part.type === 'output_text' ? part.text : part.refusal;
          if (part.type === 'output_text') annotations.push(...(part.annotations ?? []));
        }
      if (item.type === 'reasoning')
        completeReasoning += item.summary.map((part) => part.text).join('\n');
      if (item.type === 'function_call') {
        const call: ModelToolCall = { id: item.call_id, name: item.name, arguments: {} };
        try {
          const value: unknown = JSON.parse(item.arguments);
          if (
            !record(value) ||
            failure ||
            cutoff ||
            body?.status !== 'completed' ||
            (item.status !== undefined && item.status !== 'completed')
          )
            throw Error('Incomplete function call');
          call.arguments = value as Record<string, unknown>;
        } catch {
          call.parseFailed = true;
          call.rawArguments = item.arguments;
          if (body?.incomplete_details?.reason === 'max_output_tokens')
            call.argumentsTruncated = true;
        }
        calls.push(call);
      }
    }
    const reported = body?.usage;
    const estimated = failure || !reported;
    const inputTokens = reported?.input_tokens ?? (accepted ? Math.ceil(bytes / 4) : 0);
    const outputTokens = Math.max(
      reported?.output_tokens ?? 0,
      estimated ? estimatedOutputTokens(budget.characters()) : 0
    );
    const citations = webCitationsFrom(annotations);
    const result: ModelResponse = {
      text: (body ? completeText : text).slice(
        0,
        budget.maxChars() > 0 ? budget.maxChars() : undefined
      ),
      ...((body ? completeReasoning : summary)
        ? {
            reasoning: (body ? completeReasoning : summary).slice(
              0,
              budget.maxChars() > 0
                ? Math.max(0, budget.maxChars() - (body ? completeText.length : text.length))
                : undefined
            )
          }
        : {}),
      toolCalls: failure || cutoff ? [] : calls,
      finishReason: cutoff
        ? cutoff === 'cancelled'
          ? 'cancelled'
          : worthContinuing(cutoff, budget)
            ? 'length'
            : 'stop'
        : body?.incomplete_details?.reason === 'max_output_tokens'
          ? 'length'
          : body?.status === 'failed' || failure
            ? 'error'
            : calls.length
              ? 'tool_calls'
              : 'stop',
      ...(cutoff
        ? { truncated: { reason: cutoff, detail: describeCutoff(provider, cutoff, budget) } }
        : {}),
      ...(citations.length ? { citations } : {}),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: estimated ? inputTokens + outputTokens : reported.total_tokens,
        ...(estimated ? { estimated: true as const } : {}),
        ...(reported?.input_tokens_details?.cached_tokens === undefined
          ? {}
          : { cachedInputTokens: reported.input_tokens_details.cached_tokens }),
        ...(items.some((item) => item.type === 'web_search_call')
          ? {
              serverToolUse: {
                web_search_requests: items.filter((item) => item.type === 'web_search_call').length
              }
            }
          : {})
      },
      metadata: {
        provider: provider,
        model: input.model,
        latencyMs: performance.now() - started,
        privacyRoute: privacyRoute,
        ...(body?.id || responseId ? { generationId: body?.id ?? responseId! } : {}),
        ...(body?.model ? { revision: body.model } : {}),
        ...(firstToken === undefined ? {} : { timeToFirstTokenMs: firstToken - started })
      }
    };
    if (
      !failure &&
      !cutoff &&
      body?.status === 'completed' &&
      calls.every((call) => !call.parseFailed)
    )
      result.nativeContinuation = {
        protocol: 'openai-responses-v1',
        binding,
        inputDigest: canonicalInputDigest(input.messages),
        messageDigest: canonicalMessageDigest(responseMessage(result)),
        items
      };
    return result;
  };
  const completed = (value: unknown) => {
    body = ResponseBody.parse(value);
    const calls = body.output.filter((item) => item.type === 'function_call');
    if (new Set(calls.map((item) => item.call_id)).size !== calls.length)
      throw Error('Duplicate native function call identity');
    if (Buffer.byteLength(JSON.stringify(body.output)) > MAX_STREAM_METADATA_CHARS) {
      cutoff = 'framing';
      throw Error('Native output metadata exceeded its limit');
    }
    const characters = body.output.reduce(
      (total, item) =>
        total +
        (item.type === 'message'
          ? item.content.reduce(
              (n, part) =>
                n + (part.type === 'output_text' ? part.text.length : part.refusal.length),
              0
            )
          : item.type === 'function_call'
            ? item.arguments.length
            : item.type === 'reasoning'
              ? item.summary.reduce((n, part) => n + part.text.length, 0)
              : 0),
      0
    );
    produced(Math.max(0, characters - budget.characters()));
    if (body.status === 'failed') throw responseFault(502, body);
  };
  const event = async (value: unknown) => {
    const frame = record(value);
    if (!frame || typeof frame.type !== 'string') throw Error('Malformed native stream event');
    if (frame.type === 'error') throw responseFault(502, frame);
    const receipt = record(frame.response);
    if (typeof receipt?.id === 'string' && receipt.id.length <= 512) responseId = receipt.id;
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(frame.type)) {
      completed(frame.response);
      return;
    }
    let delta = '';
    if (typeof frame.delta === 'string') {
      delta = frame.delta;
      if (frame.type === 'response.output_text.delta' || frame.type === 'response.refusal.delta') {
        produced(delta.length);
        text += delta;
        await input.onTextDelta?.(delta);
      } else if (frame.type === 'response.reasoning_summary_text.delta') {
        produced(delta.length);
        summary += delta;
        await input.onReasoningDelta?.(delta);
      } else if (frame.type === 'response.function_call_arguments.delta') {
        const index = z.number().int().min(0).max(4095).parse(frame.output_index);
        const previous = partialItems.get(index);
        if (previous?.id !== undefined && previous.id !== frame.item_id)
          throw Error('Native function argument identity changed');
        produced(delta.length);
      } else delta = '';
    }
    if (frame.type === 'response.output_item.added' || frame.type === 'response.output_item.done') {
      const index = z.number().int().min(0).max(4095).parse(frame.output_index);
      const item = record(frame.item);
      if (!item) throw Error('Malformed native output item');
      const previous = partialItems.get(index);
      if (previous?.id !== undefined && previous.id !== item.id)
        throw Error('Native item identity changed');
      partialItems.set(index, item);
      if (JSON.stringify([...partialItems.values()]).length > MAX_STREAM_METADATA_CHARS) {
        cutoff = 'framing';
        throw Error('Native stream metadata exceeded its limit');
      }
    }
    if (
      limits.line(
        JSON.stringify(frame).length,
        delta.length > 0 ||
          frame.type === 'response.output_item.done' ||
          frame.type === 'response.output_item.added'
      )
    ) {
      cutoff = 'framing';
      throw Error('Native stream made no bounded progress');
    }
  };

  return {
    event,
    completed,
    finish,
    get body() {
      return body;
    },
    get cutoff() {
      return cutoff;
    },
    set cutoff(value: GenerationCutoff | undefined) {
      cutoff = value;
    },
    get accepted() {
      return accepted;
    },
    set accepted(value: boolean) {
      accepted = value;
    }
  };
}
