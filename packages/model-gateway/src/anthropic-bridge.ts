/**
 * Claude over Anthropic's own Messages API, spoken through the chat-completions adapter.
 *
 * Everything that makes a turn safe - the stream deadlines, the output ceilings, keeping an
 * interrupted answer, reading tool calls that were cut off mid-JSON - lives in
 * `OpenAICompatibleAdapter` and is written against the chat-completions wire shape. Rather than a
 * second adapter that would have to grow every one of those guards again, this is a `fetch` that
 * the adapter is handed: it takes the chat-completions request the adapter built, sends the
 * equivalent Messages request, and gives back the reply - streamed or whole - in the shape the
 * adapter already reads. What is Anthropic-specific stays here, at the edge:
 *
 * - the key travels as `x-api-key` with a pinned `anthropic-version`, never as a bearer token;
 * - system prompts move to the top-level `system` field and tool results become `tool_result`
 *   blocks inside a user turn, with neighbouring turns of the same role merged as the API requires;
 * - a reasoning effort becomes an extended-thinking budget, and the signed thinking blocks travel
 *   back out as `reasoning_details` so the next turn can hand them back exactly as received;
 * - cache breakpoints the caller placed are kept, and when it placed none the system prompt and
 *   the conversation so far are marked, because a direct Claude route bills cache writes and a
 *   request without markers caches nothing.
 */

export const ANTHROPIC_VERSION = '2023-06-01';

/** Endpoint identity selects the protocol, the same way the native OpenAI route is chosen. */
export const isNativeAnthropicEndpoint = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
};

type Json = Record<string, unknown>;
/** A field that should be text, or nothing when the payload put something else there. */
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Thinking budgets for each effort. The API wants a token budget rather than a word; these sit
 * inside the output ceiling the request asks for, which is raised to fit when it would not.
 */
const THINKING_BUDGET: Record<string, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_000,
  max: 32_000
};
const DEFAULT_MAX_TOKENS = 16_384;
const MAX_BREAKPOINTS = 4;

type Block = Json & { type: string };

const imageBlock = (url: string): Block => {
  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return inline
    ? { type: 'image', source: { type: 'base64', media_type: inline[1], data: inline[2] } }
    : { type: 'image', source: { type: 'url', url } };
};

/** One chat-completions content value as Messages blocks. */
const blocksOf = (content: unknown): Block[] => {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): Block[] => {
    if (!isRecord(part)) return [];
    if (part.type === 'text' && typeof part.text === 'string') {
      if (!part.text) return [];
      return [
        {
          type: 'text',
          text: part.text,
          ...(isRecord(part.cache_control) ? { cache_control: { type: 'ephemeral' } } : {})
        }
      ];
    }
    if (
      part.type === 'image_url' &&
      isRecord(part.image_url) &&
      typeof part.image_url.url === 'string'
    )
      return [imageBlock(part.image_url.url)];
    // Audio and video attachments have no Messages equivalent; say so rather than drop them silently.
    return [{ type: 'text', text: '[An attachment this model cannot receive was left out.]' }];
  });
};

/** Signed thinking handed back verbatim, first in the assistant turn, as the API requires. */
const thinkingOf = (details: unknown): Block[] =>
  Array.isArray(details)
    ? details.flatMap((entry): Block[] => {
        if (!isRecord(entry)) return [];
        if (entry.type === 'anthropic.thinking' && typeof entry.signature === 'string')
          return [
            { type: 'thinking', thinking: textOf(entry.thinking), signature: entry.signature }
          ];
        if (entry.type === 'anthropic.redacted_thinking' && typeof entry.data === 'string')
          return [{ type: 'redacted_thinking', data: entry.data }];
        return [];
      })
    : [];

const parseArguments = (text: unknown): Json => {
  if (typeof text !== 'string' || !text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** The chat-completions request the adapter built, as a Messages request. */
export const toMessagesRequest = (body: Json): Json => {
  const system: Block[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  const push = (role: 'user' | 'assistant', content: Block[]) => {
    if (!content.length) return;
    const last = turns.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else turns.push({ role, content: [...content] });
  };
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(message)) continue;
    if (message.role === 'system') system.push(...blocksOf(message.content));
    else if (message.role === 'user') push('user', blocksOf(message.content));
    else if (message.role === 'tool')
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: textOf(message.tool_call_id),
          content: blocksOf(message.content).filter((block) => block.type === 'text')
        }
      ]);
    else if (message.role === 'assistant') {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      push('assistant', [
        ...thinkingOf(message.reasoning_details),
        ...blocksOf(message.content),
        ...calls.filter(isRecord).map(
          (call): Block => ({
            type: 'tool_use',
            id: textOf(call.id),
            name: String(isRecord(call.function) ? call.function.name : ''),
            input: parseArguments(isRecord(call.function) ? call.function.arguments : undefined)
          })
        )
      ]);
    }
  }
  if (turns[0]?.role === 'assistant')
    turns.unshift({ role: 'user', content: [{ type: 'text', text: '(continued)' }] });

  // Keep the caller's markers; when it set none, cache the instructions and the conversation so far.
  const all = [...system, ...turns.flatMap((turn) => turn.content)];
  let marks = all.filter((block) => isRecord(block.cache_control)).length;
  if (marks === 0) {
    const lastSystem = system.at(-1);
    if (lastSystem) {
      lastSystem.cache_control = { type: 'ephemeral' };
      marks++;
    }
    // The last block before the newest user turn: everything up to it repeats on the next step.
    const newestUser = turns.map((turn) => turn.role).lastIndexOf('user');
    const prior = turns.slice(0, Math.max(0, newestUser)).at(-1)?.content.at(-1);
    if (prior && marks < MAX_BREAKPOINTS) prior.cache_control = { type: 'ephemeral' };
  } else if (marks > MAX_BREAKPOINTS) {
    for (const block of all
      .filter((entry) => isRecord(entry.cache_control))
      .slice(0, marks - MAX_BREAKPOINTS))
      delete block.cache_control;
  }

  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter(isRecord)
    .filter((tool) => tool.type === 'function' && isRecord(tool.function))
    .map((tool) => {
      const fn = tool.function as Json;
      return {
        name: textOf(fn.name),
        description: textOf(fn.description),
        input_schema: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} }
      };
    });
  const effort =
    typeof body.reasoning_effort === 'string'
      ? body.reasoning_effort
      : isRecord(body.reasoning) && typeof body.reasoning.effort === 'string'
        ? body.reasoning.effort
        : undefined;
  const budget = effort ? THINKING_BUDGET[effort] : undefined;
  const requested =
    typeof body.max_tokens === 'number'
      ? body.max_tokens
      : typeof body.max_completion_tokens === 'number'
        ? body.max_completion_tokens
        : DEFAULT_MAX_TOKENS;
  const maxTokens = budget ? Math.max(requested, budget + 4_096) : requested;
  const toolChoice =
    body.tool_choice === 'required'
      ? { type: 'any' }
      : body.tool_choice === 'none'
        ? { type: 'none' }
        : isRecord(body.tool_choice) && isRecord(body.tool_choice.function)
          ? { type: 'tool', name: textOf(body.tool_choice.function.name) }
          : undefined;
  const stop =
    typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop : undefined;
  return {
    model: body.model,
    max_tokens: maxTokens,
    ...(system.length ? { system } : {}),
    messages: turns,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice && tools.length ? { tool_choice: toolChoice } : {}),
    // Extended thinking runs at a fixed temperature, and the API refuses any other.
    ...(budget
      ? { thinking: { type: 'enabled', budget_tokens: budget } }
      : typeof body.temperature === 'number'
        ? { temperature: Math.min(1, body.temperature) }
        : {}),
    ...(stop?.length ? { stop_sequences: stop } : {}),
    ...(body.stream === true ? { stream: true } : {})
  };
};

const finishReason = (stop: unknown): string =>
  stop === 'tool_use'
    ? 'tool_calls'
    : stop === 'max_tokens'
      ? 'length'
      : stop === 'refusal'
        ? 'content_filter'
        : 'stop';

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
const usageOf = (usage: Usage) => ({
  prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
  completion_tokens: usage.output,
  total_tokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
  prompt_tokens_details: { cached_tokens: usage.cacheRead },
  cache_read_input_tokens: usage.cacheRead,
  cache_creation_input_tokens: usage.cacheWrite
});
const readUsage = (target: Usage, source: unknown) => {
  if (!isRecord(source)) return;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  target.input = count(source.input_tokens) ?? target.input;
  target.output = count(source.output_tokens) ?? target.output;
  target.cacheRead = count(source.cache_read_input_tokens) ?? target.cacheRead;
  target.cacheWrite = count(source.cache_creation_input_tokens) ?? target.cacheWrite;
};

/** A whole Messages reply as a chat completion. */
export const fromMessagesResponse = (message: Json): Json => {
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  readUsage(usage, message.usage);
  const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => textOf(block.text))
    .join('');
  const reasoning = blocks
    .filter((block) => block.type === 'thinking')
    .map((block) => textOf(block.thinking))
    .join('');
  const details = blocks.flatMap((block): Json[] =>
    block.type === 'thinking'
      ? [{ type: 'anthropic.thinking', thinking: block.thinking, signature: block.signature }]
      : block.type === 'redacted_thinking'
        ? [{ type: 'anthropic.redacted_thinking', data: block.data }]
        : []
  );
  const calls = blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
    }));
  return {
    id: message.id,
    object: 'chat.completion',
    model: message.model,
    choices: [
      {
        index: 0,
        finish_reason: finishReason(message.stop_reason),
        message: {
          role: 'assistant',
          content: text,
          ...(reasoning ? { reasoning } : {}),
          ...(details.length ? { reasoning_details: details } : {}),
          ...(calls.length ? { tool_calls: calls } : {})
        }
      }
    ],
    usage: usageOf(usage)
  };
};

/** A Messages event stream, re-framed as a chat-completions event stream as it arrives. */
export const fromMessagesStream = (
  source: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let id = '';
  let model = '';
  let stopReason: unknown = null;
  let toolCount = 0;
  const tools = new Map<number, number>();
  const thinking = new Map<number, { thinking: string; signature: string }>();
  const redacted = new Map<number, string>();
  let buffer = '';
  const frame = (delta: Json, extra: Json = {}) =>
    encoder.encode(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
        ...extra
      })}\n\n`
    );
  const handle = (event: Json, emit: (chunk: Uint8Array) => void) => {
    const index = typeof event.index === 'number' ? event.index : -1;
    switch (event.type) {
      case 'message_start': {
        const message = isRecord(event.message) ? event.message : {};
        id = textOf(message.id);
        model = textOf(message.model);
        readUsage(usage, message.usage);
        emit(frame({ role: 'assistant', content: '' }));
        return;
      }
      case 'content_block_start': {
        const block = isRecord(event.content_block) ? event.content_block : {};
        if (block.type === 'tool_use') {
          const call = toolCount++;
          tools.set(index, call);
          emit(
            frame({
              tool_calls: [
                {
                  index: call,
                  id: block.id,
                  type: 'function',
                  function: { name: block.name, arguments: '' }
                }
              ]
            })
          );
        } else if (block.type === 'thinking') {
          thinking.set(index, { thinking: textOf(block.thinking), signature: '' });
        } else if (block.type === 'redacted_thinking') {
          redacted.set(index, textOf(block.data));
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          emit(frame({ content: block.text }));
        }
        return;
      }
      case 'content_block_delta': {
        const delta = isRecord(event.delta) ? event.delta : {};
        if (delta.type === 'text_delta') emit(frame({ content: textOf(delta.text) }));
        else if (delta.type === 'input_json_delta' && tools.has(index))
          emit(
            frame({
              tool_calls: [
                {
                  index: tools.get(index),
                  function: { arguments: textOf(delta.partial_json) }
                }
              ]
            })
          );
        else if (delta.type === 'thinking_delta') {
          const held = thinking.get(index);
          if (held) held.thinking += textOf(delta.thinking);
          emit(frame({ reasoning: textOf(delta.thinking) }));
        } else if (delta.type === 'signature_delta') {
          const held = thinking.get(index);
          if (held) held.signature += textOf(delta.signature);
        }
        return;
      }
      case 'content_block_stop': {
        const held = thinking.get(index);
        if (held) emit(frame({ reasoning_details: [{ type: 'anthropic.thinking', ...held }] }));
        if (redacted.has(index))
          emit(
            frame({
              reasoning_details: [
                { type: 'anthropic.redacted_thinking', data: redacted.get(index) }
              ]
            })
          );
        return;
      }
      case 'message_delta': {
        const delta = isRecord(event.delta) ? event.delta : {};
        if (delta.stop_reason !== undefined) stopReason = delta.stop_reason;
        readUsage(usage, event.usage);
        return;
      }
      case 'message_stop': {
        emit(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason(stopReason) }],
              usage: usageOf(usage)
            })}\n\ndata: [DONE]\n\n`
          )
        );
        return;
      }
      case 'error': {
        const error = isRecord(event.error) ? event.error : {};
        emit(
          encoder.encode(
            `data: ${JSON.stringify({ error: { message: error.message, type: error.type } })}\n\n`
          )
        );
        return;
      }
      default:
        return;
    }
  };
  const decoder = new TextDecoder();
  const drain = (emit: (chunk: Uint8Array) => void, final = false) => {
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = final ? '' : (parts.pop() ?? '');
    for (const part of final ? parts.concat(buffer) : parts) {
      const data = part
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        const event: unknown = JSON.parse(data);
        if (isRecord(event)) handle(event, emit);
      } catch {
        // A frame that is not JSON carries nothing the adapter could use.
      }
    }
  };
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        drain((out) => controller.enqueue(out));
      },
      flush(controller) {
        buffer += decoder.decode();
        drain((out) => controller.enqueue(out), true);
      }
    })
  );
};

/** Anthropic's error body, in the shape the adapter reads a refusal from. */
const errorResponse = async (response: Response): Promise<Response> => {
  const text = await response.text();
  let message = text;
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string')
      message = body.error.message;
  } catch {
    // Not JSON; the text itself is the message.
  }
  const headers = new Headers({ 'content-type': 'application/json' });
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) headers.set('retry-after', retryAfter);
  return new Response(JSON.stringify({ error: { message } }), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

/**
 * The `fetch` a chat-completions adapter is given for an Anthropic endpoint. It answers the two
 * routes the adapter calls - `/models` and `/chat/completions` - and passes anything else through.
 */
export const anthropicBridge = (inner: typeof fetch = fetch): typeof fetch => {
  const maxima = new Map<string, number>();
  const publishedMaxTokens = async (
    model: string,
    read: () => Promise<number | null>
  ): Promise<number | null> => {
    const known = maxima.get(model);
    if (known) return known;
    const value = await read().catch(() => null);
    if (value) maxima.set(model, value);
    return value;
  };
  return async (resource, init = {}) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource));
    const incoming = new Headers(init.headers);
    const key =
      incoming.get('x-api-key') ?? incoming.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(key ? { 'x-api-key': key } : {})
    };
    const base = url.pathname.replace(/\/(models|chat\/completions)\/?$/, '');
    const passthrough = {
      ...(init.signal ? { signal: init.signal } : {}),
      redirect: 'error' as const
    };
    if (url.pathname.endsWith('/models') && (init.method ?? 'GET') === 'GET') {
      const models: Json[] = [];
      let after: string | undefined;
      for (let page = 0; page < 10; page++) {
        const response = await inner(
          `${url.origin}${base}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`,
          { headers, ...passthrough }
        );
        if (!response.ok) return errorResponse(response);
        const body: unknown = await response.json();
        const data = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : [];
        for (const model of data)
          models.push({
            id: model.id,
            name: typeof model.display_name === 'string' ? model.display_name : model.id,
            // Every current Claude model reads images; the list does not say so, the model card does.
            architecture: { input_modalities: ['text', 'image'] },
            ...(typeof model.max_input_tokens === 'number'
              ? { context_length: model.max_input_tokens }
              : {}),
            ...(typeof model.max_tokens === 'number'
              ? { max_completion_tokens: model.max_tokens }
              : {})
          });
        if (!(isRecord(body) && body.has_more === true && typeof body.last_id === 'string')) break;
        after = body.last_id;
      }
      return new Response(JSON.stringify({ object: 'list', data: models }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.pathname.endsWith('/chat/completions') && init.method === 'POST') {
      const request = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Json;
      // The Messages API requires a length. Where the caller named none, it is the model's own
      // maximum, as Anthropic publishes it for that model.
      if (
        typeof request.max_tokens !== 'number' &&
        typeof request.max_completion_tokens !== 'number' &&
        typeof request.model === 'string'
      ) {
        const published = await publishedMaxTokens(request.model, async () => {
          const response = await inner(
            `${url.origin}${base}/models/${encodeURIComponent(String(request.model))}`,
            { headers, ...passthrough }
          );
          const body: unknown = response.ok ? await response.json() : null;
          return isRecord(body) && typeof body.max_tokens === 'number' ? body.max_tokens : null;
        });
        if (published) request.max_tokens = published;
      }
      const response = await inner(`${url.origin}${base}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(toMessagesRequest(request)),
        ...passthrough
      });
      if (!response.ok) return errorResponse(response);
      if (request.stream === true && response.body)
        return new Response(fromMessagesStream(response.body), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        });
      return new Response(JSON.stringify(fromMessagesResponse((await response.json()) as Json)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return inner(resource, init);
  };
};
