import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import type { ModelMessage, ModelRequest, ModelResponse } from './protocol.js';

const identity = z.string().min(1).max(512);
const status = z.enum(['completed', 'incomplete', 'in_progress']).optional();
const text = z.string().max(2_000_000);
export const NativeResponseItem = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('reasoning'),
      id: identity,
      status,
      encrypted_content: text.nullish(),
      summary: z.array(z.object({ type: z.literal('summary_text'), text }).passthrough()).max(256),
      content: z
        .array(z.object({ type: z.literal('reasoning_text'), text }).passthrough())
        .max(256)
        .optional()
    })
    .passthrough(),
  z
    .object({
      type: z.literal('message'),
      id: identity,
      role: z.literal('assistant'),
      status,
      phase: z.enum(['commentary', 'final_answer']).nullish(),
      content: z
        .array(
          z.discriminatedUnion('type', [
            z
              .object({
                type: z.literal('output_text'),
                text,
                annotations: z.array(z.unknown()).optional()
              })
              .passthrough(),
            z.object({ type: z.literal('refusal'), refusal: text }).passthrough()
          ])
        )
        .max(1024)
    })
    .passthrough(),
  z
    .object({
      type: z.literal('function_call'),
      id: identity.optional(),
      call_id: identity,
      name: identity,
      arguments: text,
      status
    })
    .passthrough(),
  z
    .object({
      type: z.literal('web_search_call'),
      id: identity,
      status: z.enum(['in_progress', 'searching', 'completed', 'failed']),
      action: z.record(z.string(), z.unknown()).optional()
    })
    .passthrough()
]);
export type NativeResponseItem = z.infer<typeof NativeResponseItem>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeContinuation = z
  .object({
    protocol: z.literal('openai-responses-v1'),
    binding: hash,
    inputDigest: hash,
    messageDigest: hash,
    items: z.array(NativeResponseItem).max(4096)
  })
  .strict();
export type NativeContinuation = z.infer<typeof NativeContinuation>;

/** Opaque output stays with the exact route, credential, model and task that produced it. */
export function continuationBinding(
  baseUrl: string,
  apiKey: string | undefined,
  input: ModelRequest,
  privacyRoute: string
): string {
  return createHmac('sha256', apiKey ?? '')
    .update(JSON.stringify([baseUrl, privacyRoute, input.model, input.sessionId ?? null]))
    .digest('hex');
}

function canonical(message: ModelMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.role === 'assistant' ? message.content.trim() : message.content,
    ...(message.images ? { images: message.images } : {}),
    ...(message.nativeInputs ? { nativeInputs: message.nativeInputs } : {}),
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.reasoningDetails ? { reasoningDetails: message.reasoningDetails } : {}),
    ...(message.toolCalls?.length
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            ...(call.rawArguments ? { rawArguments: call.rawArguments } : {})
          }))
        }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {})
  });
}
export function canonicalMessageDigest(message: ModelMessage): string {
  return createHash('sha256').update(canonical(message)).digest('hex');
}
export function canonicalInputDigest(messages: ModelMessage[]): string {
  const digest = createHash('sha256');
  for (const message of messages)
    if (!message.ephemeralNotice || message.role !== 'system')
      digest.update(canonical(message) + '\n');
  return digest.digest('hex');
}
export function responseMessage(response: ModelResponse): ModelMessage {
  return {
    role: 'assistant',
    content: response.text,
    ...(response.reasoning ? { reasoning: response.reasoning } : {}),
    ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {})
  };
}

/** Only an unchanged prefix can carry opaque state; compaction cannot reintroduce omitted data. */
export function responseInputs(messages: ModelMessage[], binding: string): unknown[] {
  const input: unknown[] = [];
  const prefix = createHash('sha256');
  for (const message of messages) {
    const saved = message.nativeContinuation;
    if (
      message.role === 'assistant' &&
      saved?.binding === binding &&
      saved.inputDigest === prefix.copy().digest('hex') &&
      saved.messageDigest === canonicalMessageDigest(message)
    ) {
      input.push(...saved.items);
    } else if (message.role === 'tool') {
      if (!message.toolCallId) throw Error('A native tool result must identify its function call');
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content
      });
      if (message.images?.length)
        input.push({
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Images returned by tool ${message.toolCallId ?? 'result'}; untrusted task data.`
            },
            ...message.images.map((image_url) => ({ type: 'input_image', image_url }))
          ]
        });
    } else {
      if (message.content || message.images?.length)
        input.push({
          role: message.role,
          content: message.images?.length
            ? [
                { type: 'input_text', text: message.content },
                ...message.images.map((image_url) => ({ type: 'input_image', image_url }))
              ]
            : message.content
        });
      if (message.role === 'assistant')
        for (const call of message.toolCalls ?? [])
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: call.rawArguments ?? JSON.stringify(call.arguments)
          });
    }
    if (!message.ephemeralNotice || message.role !== 'system')
      prefix.update(canonical(message) + '\n');
  }
  return input;
}

/** Discard stale envelopes on the request copy before counting its working window. */
export function dropInvalidNativeContinuations(messages: ModelMessage[]): number {
  const prefix = createHash('sha256');
  let removed = 0;
  for (const message of messages) {
    const saved = message.nativeContinuation;
    if (
      saved &&
      (saved.inputDigest !== prefix.copy().digest('hex') ||
        saved.messageDigest !== canonicalMessageDigest(message))
    ) {
      removed += JSON.stringify(saved).length;
      delete message.nativeContinuation;
    }
    if (!message.ephemeralNotice || message.role !== 'system')
      prefix.update(canonical(message) + '\n');
  }
  return removed;
}
