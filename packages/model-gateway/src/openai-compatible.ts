import { performance } from 'node:perf_hooks';
import { MAX_STREAM_LINE_CHARS, streamLimits } from './stream-limits.js';
import { duplicatedWebCapabilities, serverToolUseFrom, webCitationsFrom } from '@garden/contracts';
import { GardenError } from '@garden/core';
import type {
  ModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ProviderModel
} from './protocol.js';
import { isProviderWallStatus } from './retry.js';
import { retainInterruptedResponse } from './interrupted-response.js';
import { assertReasoningEffort, readReasoningOptions, type ReasoningOptions } from './reasoning.js';
import { describeNativeOpenAIInput } from './openai-native-input-catalog.js';
import { isNativeOpenAIEndpoint } from './openai-media-catalog.js';
import {
  nativeInputBlocks,
  NATIVE_INPUT_MAX_BYTES,
  NATIVE_INPUT_MAX_PARTS,
  type NativeInputBlock
} from './native-input.js';
import {
  MAX_CACHE_BREAKPOINTS,
  promptCacheStyle,
  readCacheUsage,
  type CacheUsageFields
} from './prompt-cache.js';
import {
  DEFAULT_GENERATION_TIMEOUT_MS,
  describeCutoff,
  estimatedOutputTokens,
  generationCharCeiling,
  startGenerationBudget,
  streamIdleTimeoutFor,
  worthContinuing,
  type GenerationBudget,
  type GenerationCutoff
} from './generation-budget.js';

/**
 * How long a streamed response may go without a single byte before the provider counts as stalled.
 * The caller's own deadline is a total budget, so on its own it cannot tell a turn that is still
 * producing tokens from one that died silently: a stall used to hold this worker's only slot until
 * the whole budget ran out. Two minutes is far longer than any gap between tokens - including the
 * quiet stretch while a reasoning model thinks, which still arrives as keep-alive bytes.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * Bytes the assembled request body may reach before this side stops sending it.
 *
 * A different quantity from every other bound on a request, and the only one nothing was watching.
 * The window is bounded in tokens, and an attached image is *estimated* at a flat sixteen hundred
 * of them however large it is - which is the right estimate, because a vision model bills a picture
 * by its area and not by its bytes. It means the token arithmetic that decides a request fits
 * cannot see this at all: the images ride as base64 data URLs and are bounded only by count, so
 * four full-screen stills and a window capture are six thousand four hundred estimated tokens and
 * upwards of twenty megabytes on the wire. That is a request the model budget calls small and a
 * transport refuses - or worse, accepts and drops halfway through, which arrives here as a socket
 * that died for no stated reason.
 *
 * Sixteen mebibytes, which is far above any window this product can assemble out of text alone - a
 * 200k-token conversation is under a megabyte - and below the body limit of every route this
 * adapter is pointed at. It is a transport bound, not a cost bound; the cost bounds are elsewhere
 * and they still apply.
 */
export const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/**
 * What the model is told in place of an image that could not be sent.
 *
 * Written into the message the image was attached to, because that is the only place the model
 * will look for it, and written to be acted on rather than merely apologised for: the picture is
 * still on disk and the tool that reads it is still in the catalogue, so the recovery is one call
 * away from wherever the model notices the gap.
 */
const shedImageNotice = (count: number, ceilingBytes: number): string =>
  `[${count === 1 ? 'one image was' : `${count} images were`} dropped from this message: the assembled request was over the ${ceilingBytes}-byte transport ceiling and the oldest attachments went first. Read the file again if this step needs to see it.]`;

export interface CompatibleAdapterOptions {
  baseUrl: string;
  apiKey?: string;
  provider: string;
  privacyRoute: string;
  fetch?: typeof fetch;
  appUrl?: string;
  appTitle?: string;
  enforceZeroDataRetention?: boolean;
  /** Zero disables the idle deadline; only tests that drive the reader by hand should do that. */
  streamIdleTimeoutMs?: number;
  /** Zero disables the generation deadline. An escape hatch for an unusual route, not a setting. */
  generationTimeoutMs?: number;
  /** Overrides the ceiling derived from the request's own output cap. Zero disables it. */
  generationMaxChars?: number;
  /** Overrides the assembled-body byte ceiling. Zero disables it. */
  maxRequestBytes?: number;
}

interface CompletionBody {
  id?: string;
  model?: string;
  error?: unknown;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning?: string | null;
      /**
       * What DeepSeek's own API and vLLM's reasoning parsers call the same field. OpenRouter
       * normalises it to `reasoning`; nothing normalises it on a directly configured endpoint, and
       * this file names that family by name three hundred lines down.
       */
      reasoning_content?: string | null;
      reasoning_details?: unknown[];
      /** Where a provider attaches the sources a server-side search or fetch grounded the answer in. */
      annotations?: unknown[];
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  provider?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    /** Per-request counters for the tools the provider ran itself, which tokens cannot account for. */
    server_tool_use?: unknown;
  } & CacheUsageFields;
}

/** Content blocks are only used when a message needs a cache breakpoint or carries images. */
type ContentBlock =
  | NativeInputBlock
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Array content is well defined for these roles in the OpenAI-compatible schema. An assistant
 * message that also carries `tool_calls` stays a plain string so no provider has to reconcile
 * two representations of the same turn.
 */
const BLOCK_CONTENT_ROLES = new Set<ModelMessage['role']>(['system', 'user', 'tool']);

interface StreamChunk {
  id?: string;
  model?: string;
  provider?: string;
  error?: unknown;
  choices?: Array<{
    finish_reason?: string | null;
    /**
     * Some routes stream annotations as deltas and others attach the finished list to a `message`
     * on the last chunk. Both are read, because reading one of them drops every citation on the
     * routes that use the other.
     */
    message?: { annotations?: unknown[] };
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      /** See the note on the non-streamed message above: the same field, one token at a time. */
      reasoning_content?: string | null;
      reasoning_details?: unknown[];
      annotations?: unknown[];
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: CompletionBody['usage'];
}

/** A completion assembled from a stream, plus what the stream itself cost and how it ended. */
interface StreamedBody extends CompletionBody {
  generatedChars: number;
  failure?: Error;
  cutoff?: { reason: GenerationCutoff; detail: string };
  /**
   * How many `data:` frames parsed as JSON. Zero is the whole of the diagnosis for a reply that was
   * not a stream at all, and it is the only thing that distinguishes one from a stream whose every
   * frame happened to be empty - the synthesised `choices` array below looks identical either way.
   */
  frames: number;
  /**
   * The reply's own bytes, kept only while no frame has parsed, for the one recovery attempt. A
   * route that honoured `stream: true` never fills this in.
   */
  unstreamed?: string;
}

/**
 * How much of a reply that ignored `stream: true` is held back for that one recovery parse. A JSON
 * completion carrying a whole file inside a `file_write` call runs to a few hundred kilobytes; past
 * this the reply is not a completion, and holding more of it only spends the worker's memory.
 */
const MAX_UNSTREAMED_RECOVERY_CHARS = 1_000_000;

/**
 * The tags an unparsed reasoning route writes its deliberation between, inside `content`.
 *
 * Routes in the R1 family emit these as ordinary content tokens unless the endpoint was started
 * with a reasoning parser in front of them. Read as prose - which is what happens when nothing
 * looks for them - the model's private planning is published to the owner's timeline as the
 * answer, stored as the assistant's own prior turn, and handed back to the model on every
 * subsequent step as something it already said. That is the recorded incident: a turn that streamed
 * a thousand deltas and made no tool call, with its own operating contract in the reading column.
 */
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * How much whitespace may sit in front of an opening `<think>` before the answer is taken at its
 * word and passed through untouched.
 *
 * A bound rather than `trimStart` because this runs on a stream: everything held back waiting to
 * find out whether it is the start of a tag is an answer the owner is not yet reading. Two or three
 * newlines is what the chat templates put there; eight is past every one of them and still short
 * enough that nobody sees the delay.
 */
const MAX_THINK_LEAD_WHITESPACE = 8;

/** How much of `text` is a whitespace run at the front. */
const leadingWhitespaceOf = (text: string): number => text.length - text.trimStart().length;

/**
 * Splits a leading `<think>…</think>` span off a **complete** answer.
 *
 * Both tags are required. On a finished string the whole answer is in hand, so an opening tag with
 * no closing one is not a span - it is prose that happens to start with an angle bracket - and it
 * is left exactly where the model put it. The streamed splitter below cannot make that check and
 * deliberately decides the other way; see the note there.
 *
 * Whitespace immediately after the closing tag goes with the span rather than with the answer: the
 * templates that emit these tags put a blank line after them, and it is framing, not content.
 */
export const splitLeadingThinkSpan = (text: string): { text: string; reasoning?: string } => {
  const lead = leadingWhitespaceOf(text);
  if (lead > MAX_THINK_LEAD_WHITESPACE || !text.startsWith(THINK_OPEN, lead)) return { text };
  const close = text.indexOf(THINK_CLOSE, lead + THINK_OPEN.length);
  if (close < 0) return { text };
  return {
    text: text.slice(close + THINK_CLOSE.length).trimStart(),
    reasoning: text.slice(lead + THINK_OPEN.length, close)
  };
};

/** The longest suffix of `text` that is also a proper prefix of `tag`, so a split tag is not missed. */
const straddledPrefixOf = (text: string, tag: string): number => {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length -= 1)
    if (text.endsWith(tag.slice(0, length))) return length;
  return 0;
};

/** One content delta, routed to the channel it belongs in. Either half may be empty. */
interface ThinkSplitDelta {
  text: string;
  reasoning: string;
}

/**
 * The same split, incrementally, over a stream whose tags arrive in pieces.
 *
 * Three phases, and the whole design is about what may be held back. While *deciding*, only a
 * prefix of `<think>` (after at most `MAX_THINK_LEAD_WHITESPACE` characters of whitespace) is held,
 * so an answer that does not start like the tag is passed through delta for delta, byte for byte,
 * exactly as it was before this existed - that identity is the guard that keeps this from being a
 * content change. While *thinking*, at most seven characters are held - one short of `</think>` -
 * which is what it takes to recognise a closing tag split across two frames. Afterwards nothing is
 * held at all.
 *
 * A stream that ends still inside the span commits what it has to the reasoning channel. That is
 * the one place this disagrees with the complete-string version above, and it is not a choice: the
 * fragments were handed to `onReasoningDelta` as they arrived and the owner has already seen them
 * in the thinking column. Publishing the same words again as the answer is the defect this closes.
 */
const createThinkSplitter = (): {
  push: (delta: string) => ThinkSplitDelta;
  finish: () => ThinkSplitDelta;
} => {
  let phase: 'deciding' | 'thinking' | 'answering' = 'deciding';
  let pending = '';
  const drainThinking = (): ThinkSplitDelta => {
    const close = pending.indexOf(THINK_CLOSE);
    if (close < 0) {
      const held = straddledPrefixOf(pending, THINK_CLOSE);
      const reasoning = pending.slice(0, pending.length - held);
      pending = pending.slice(pending.length - held);
      return { text: '', reasoning };
    }
    const reasoning = pending.slice(0, close);
    phase = 'answering';
    const text = pending.slice(close + THINK_CLOSE.length).trimStart();
    pending = '';
    return { text, reasoning };
  };
  return {
    push: (delta: string): ThinkSplitDelta => {
      if (phase === 'answering') return { text: delta, reasoning: '' };
      pending += delta;
      if (phase === 'deciding') {
        const lead = leadingWhitespaceOf(pending);
        const rest = pending.slice(lead);
        // The whitespace bound is checked on both arms, not only on the one that holds back. A
        // single delta can arrive carrying more leading whitespace than was ever held, and the two
        // splitters have to agree about what counts as a leading span or the same answer is read
        // one way streamed and the other way buffered.
        if (lead <= MAX_THINK_LEAD_WHITESPACE && rest.startsWith(THINK_OPEN)) {
          phase = 'thinking';
          pending = rest.slice(THINK_OPEN.length);
        } else if (lead <= MAX_THINK_LEAD_WHITESPACE && THINK_OPEN.startsWith(rest)) {
          // Still could become the tag - `rest` is empty when nothing but whitespace has arrived.
          return { text: '', reasoning: '' };
        } else {
          phase = 'answering';
          const text = pending;
          pending = '';
          return { text, reasoning: '' };
        }
      }
      return drainThinking();
    },
    finish: (): ThinkSplitDelta => {
      const held = pending;
      pending = '';
      if (phase === 'thinking') return { text: '', reasoning: held };
      return { text: held, reasoning: '' };
    }
  };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/**
 * A reply read as an ordinary completion, or `null` when it is not one. Deliberately strict: an
 * object carrying neither `choices` nor `error` is some gateway's interstitial or health page, and
 * treating it as a completion is how a 200 became a turn with nothing in it.
 */
const completionFromJson = (text: string): CompletionBody | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  return Array.isArray(record.choices) || record.error !== undefined
    ? (record as CompletionBody)
    : null;
};

/** Gateways put the upstream status in `code` as often as in `status`, and sometimes as a string. */
const httpStatusLike = (value: unknown): number | undefined => {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  return Number.isInteger(numeric) && numeric >= 400 && numeric <= 599 ? numeric : undefined;
};

const retryAfterOf = (metadata: unknown): string | undefined => {
  const headers = asRecord(asRecord(metadata)?.headers);
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers))
    if (
      name.toLowerCase() === 'retry-after' &&
      (typeof value === 'string' || typeof value === 'number')
    )
      return String(value);
  return undefined;
};

/**
 * Whether a refusal is the provider saying the window it was sent will not fit.
 *
 * Read the way the signed-reasoning refusal above it is read: two matches on the body rather than
 * one, and ungated on provider name, because OpenRouter proxies each upstream's own wording
 * verbatim and there are as many spellings of this sentence as there are vendors. The first half is
 * what the complaint is about and the second is what the complaint is - either alone matches
 * ordinary refusals that have nothing to do with size.
 *
 * It matters because this refusal has the same property the signed-reasoning one does, and nothing
 * anywhere recognised it: the same bytes fail identically for ever, and because a refused request
 * appends nothing the window never advances past the message that overflowed it. A resumed task
 * rebuilds the identical window, sends the identical request and dies at the identical step, for as
 * long as the owner is willing to keep replying.
 */
const isContextOverflowText = (text: string): boolean =>
  /context|prompt|input|window|token/i.test(text) &&
  /context[_ ]?length|context window|maximum.{0,24}tokens|too many tokens|too long|reduce the (length|number|size)/i.test(
    text
  );

/**
 * The sizes the refusal named, when it named any.
 *
 * The canonical sentence carries both - "maximum context length is 200000 tokens, however you
 * requested 214113 tokens" - and the smaller of the two is the ceiling by construction. It is worth
 * having because it is the one honest number in the exchange: the catalogue's window is what the
 * provider published for the model and this is what the route that answered will actually take.
 */
const contextOverflowSizes = (
  text: string
): { contextLimitTokens?: number; requestedTokens?: number } => {
  const numbers = [...text.matchAll(/\d[\d,_]{2,}/g)]
    .map((match) => Number(match[0].replace(/[,_]/g, '')))
    .filter((value) => Number.isFinite(value) && value >= 1_000);
  if (!numbers.length) return {};
  const limit = Math.min(...numbers);
  const requested = Math.max(...numbers);
  return {
    contextLimitTokens: limit,
    ...(requested > limit ? { requestedTokens: requested } : {})
  };
};

/**
 * A gateway that has already answered with 200 reports a later fault as an `error` object - in an
 * SSE frame, or in the body of a non-streamed reply - never as a status. Reading only `choices`
 * turned that into a successful turn carrying half a sentence and no usage, which the agent then
 * recorded as the model's finished answer. `502` when the payload names no status of its own: the
 * request was accepted and the upstream failed after that, which an identical retry can survive.
 */
const providerFault = (
  value: unknown
): { status: number; message: string; retryAfter?: string } | null => {
  if (typeof value === 'string')
    return value.trim() ? { status: 502, message: value.trim() } : null;
  const error = asRecord(value);
  if (!error) return null;
  const status =
    httpStatusLike(error.code) ??
    httpStatusLike(error.status) ??
    httpStatusLike(asRecord(error.metadata)?.status) ??
    502;
  const retryAfter = retryAfterOf(error.metadata);
  return {
    status,
    message:
      typeof error.message === 'string' && error.message.trim()
        ? error.message.trim()
        : 'the provider gave no detail',
    ...(retryAfter ? { retryAfter } : {})
  };
};

/**
 * One name for a walled provider.
 *
 * Every non-429 refusal used to leave here as `provider_request_failed`, whatever the status. The
 * retry loop still read the status and retried the 5xx four times, which was right; what escaped
 * afterwards was a code nothing above recognised as a wall, so a 503 "no instance available" - a
 * routine, minutes-long gateway condition - failed the task outright, released its reservation and
 * stranded the follow-up message, while *connection refused* - the same outage one layer lower -
 * came back `provider_unavailable`, parked the task and was retried for a day. Two expressions of
 * one fault with opposite outcomes, and the harder-failing one is the commoner.
 *
 * 400s keep the terminal name. A rejected prompt, an unknown model or a malformed tool schema fails
 * identically however often it is asked, and calling that a wall would park a task behind a
 * condition that never lifts.
 */
/**
 * Whether a rate limit belongs to one model's host rather than to the account.
 *
 * An aggregator answers 429 for both, and they need opposite responses: an account that is out of
 * quota meets the same wall on every model it asks for, while a model whose only eligible host is
 * saturated - a new release behind a single zero-retention endpoint, say - is one model the task
 * can step around. The aggregator says which in its own sentence, so that is what is read.
 */
export const isModelScopedLimit = (status: number, complaint: string): boolean =>
  status === 429 && /rate[- ]limited upstream|upstream (provider|rate)/i.test(complaint);

const providerFaultCode = (status: number): string =>
  status === 429
    ? 'provider_quota_exhausted'
    : isProviderWallStatus(status)
      ? 'provider_unavailable'
      : 'provider_request_failed';

/**
 * A request for more output than the route will write is refused outright by some gateways and
 * silently truncated by others, and the caller has no way to tell the two apart. Where the
 * catalogue published the limit, the ask is clamped to it instead.
 */
const maxTokensFor = (input: ModelRequest): number | undefined =>
  input.maxTokens === undefined
    ? undefined
    : input.maxOutputTokens === undefined
      ? input.maxTokens
      : Math.min(input.maxTokens, input.maxOutputTokens);

const isAbort = (error: unknown): boolean => {
  const record = asRecord(error);
  return record?.name === 'AbortError' || record?.code === 'ABORT_ERR';
};

/** `TypeError: terminated` on its own says nothing; the undici cause names the actual socket fault. */
const transportDetail = (error: unknown): string => {
  const record = asRecord(error);
  const message =
    typeof record?.message === 'string' && record.message ? record.message : 'the connection ended';
  const cause = asRecord(record?.cause);
  return typeof cause?.code === 'string' ? `${message} (${cause.code})` : message;
};

/**
 * Provider declarations from discovery or exact official documentation. Unknown routes require
 * explicit selection because absent metadata cannot establish a meaningful automatic ranking.
 */
export interface ConfiguredModelDescription {
  readonly id: string;
  readonly displayName: string;
  readonly contextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly inputUsdPerMillionTokens: number | null;
  readonly outputUsdPerMillionTokens: number | null;
  readonly supportsTools: boolean | null;
  readonly supportsReasoningEffort: boolean | null;
  readonly reasoning?: ReasoningOptions;
  readonly inputModalities?: Array<'text' | 'image' | 'audio' | 'video'>;
  readonly nativeInputPricing?: {
    audioUsdPerMillionTokens: number | null;
    videoUsdPerMillionTokens: number | null;
  };
  /** Fields absent from both discovery and supported official documentation. */
  readonly unknownFields: readonly string[];
  readonly metadataSource: 'declared' | 'unknown';
}

/**
 * Which of two private routes to measure a request against: the one that accepts more of what an
 * agent turn actually carries. Tools outrank everything - a route that cannot call them cannot run
 * the task at all - and the rest are counted.
 */
const PREFERRED_PARAMETERS = [
  'tools',
  'temperature',
  'reasoning',
  'max_tokens',
  'max_completion_tokens'
] as const;
const routeScore = (declared: ReadonlySet<string>): number =>
  (declared.has('tools') ? 100 : 0) +
  PREFERRED_PARAMETERS.filter((parameter) => declared.has(parameter)).length;
const richerRoute = (candidate: ReadonlySet<string>, held: ReadonlySet<string>): boolean =>
  routeScore(candidate) > routeScore(held);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const positiveIntegerFrom = (
  record: Record<string, unknown>,
  keys: readonly string[]
): number | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
};

/** Prices are published per token by every endpoint that publishes them at all. */
const pricePerMillionFrom = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): number | null => {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    const parsed =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed * 1_000_000 * 1e6) / 1e6;
  }
  return null;
};

const describeConfiguredModel = (entry: Record<string, unknown>): ConfiguredModelDescription => {
  const id = typeof entry.id === 'string' ? entry.id : '';
  const pricing = isRecord(entry.pricing) ? entry.pricing : undefined;
  const parameters = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters.filter((value): value is string => typeof value === 'string')
    : null;
  const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
  const contextTokens = positiveIntegerFrom(entry, [
    'context_length',
    'context_window',
    'max_model_len',
    'max_context_length'
  ]);
  const maxOutputTokens =
    positiveIntegerFrom(entry, ['max_completion_tokens', 'max_output_tokens']) ??
    (topProvider ? positiveIntegerFrom(topProvider, ['max_completion_tokens']) : null);
  const inputUsdPerMillionTokens = pricePerMillionFrom(pricing, ['prompt', 'input']);
  const outputUsdPerMillionTokens = pricePerMillionFrom(pricing, ['completion', 'output']);
  const unknownFields = [
    ...(contextTokens === null ? ['contextTokens'] : []),
    ...(maxOutputTokens === null ? ['maxOutputTokens'] : []),
    ...(inputUsdPerMillionTokens === null ? ['inputUsdPerMillionTokens'] : []),
    ...(outputUsdPerMillionTokens === null ? ['outputUsdPerMillionTokens'] : []),
    ...(parameters === null ? ['supportedParameters'] : [])
  ];
  return {
    id,
    displayName: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
    ...(isRecord(entry.architecture) && Array.isArray(entry.architecture.input_modalities)
      ? {
          inputModalities: entry.architecture.input_modalities.filter(
            (kind): kind is 'text' | 'image' | 'audio' | 'video' =>
              typeof kind === 'string' && ['text', 'image', 'audio', 'video'].includes(kind)
          )
        }
      : {}),
    nativeInputPricing: {
      audioUsdPerMillionTokens: pricePerMillionFrom(pricing, ['audio']),
      videoUsdPerMillionTokens: null
    },
    contextTokens,
    maxOutputTokens,
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    supportsTools: parameters === null ? null : parameters.includes('tools'),
    supportsReasoningEffort: parameters === null ? null : parameters.includes('reasoning_effort'),
    ...(readReasoningOptions(entry.reasoning)
      ? { reasoning: readReasoningOptions(entry.reasoning)! }
      : {}),
    unknownFields,
    metadataSource: unknownFields.length === 5 ? 'unknown' : 'declared'
  };
};

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly provider: string;
  readonly privacyRoute: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #appUrl: string | undefined;
  readonly #appTitle: string | undefined;
  readonly #enforceZeroDataRetention: boolean;
  readonly #streamIdleTimeoutMs: number;
  readonly #generationTimeoutMs: number;
  readonly #generationMaxChars: number | undefined;
  readonly #maxRequestBytes: number;
  #parameterCache: Promise<Map<string, ReadonlySet<string>>> | undefined;

  constructor(options: CompatibleAdapterOptions) {
    this.provider = options.provider;
    this.privacyRoute = options.privacyRoute;
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#appUrl = options.appUrl;
    this.#appTitle = options.appTitle;
    this.#enforceZeroDataRetention = options.enforceZeroDataRetention ?? false;
    this.#streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.#generationTimeoutMs = options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
    this.#generationMaxChars = options.generationMaxChars;
    this.#maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  }

  /** Turns a payload's own `error` object into the throw the caller's retry logic can reason about. */
  #fault(frame: unknown, where: string): GardenError | null {
    const fault = providerFault(frame);
    if (!fault) return null;
    return new GardenError(
      providerFaultCode(fault.status),
      `${this.provider} reported an error ${where} (${fault.status}): ${fault.message}`,
      fault.status,
      {
        ...(fault.retryAfter ? { retryAfter: fault.retryAfter } : {}),
        ...(isModelScopedLimit(fault.status, fault.message) ? { limitScope: 'model' } : {})
      }
    );
  }

  /**
   * Which parameters a zero-retention route on this endpoint says it accepts, cached for the life
   * of the process's interest in it.
   *
   * This exists because of a combination that fails silently in testing and completely in
   * production. Under zero data retention the request tells the provider to honour every parameter
   * it is given - anything less and a provider could quietly drop `tools` and leave an agent
   * unable to act. But OpenRouter reads that demand against the declared parameter list of the
   * endpoint it would route to, and an endpoint that never declared `temperature` is then not a
   * route at all: the request comes back 404, no endpoint found, for a model the catalogue
   * correctly listed as available. Zero data retention is what a fresh install turns on, so this
   * was every task on every new box.
   *
   * The list has to come from the zero-retention endpoints themselves. The model-level list is the
   * union across every endpoint including the ones this posture refuses, so it says `temperature`
   * is fine on a model whose only private route has never accepted one.
   *
   * Where a model has several private routes, the one that accepts the most of what we would send
   * is the one measured against - it is the route the request will land on, and holding every
   * route to the poorest of them would give up capability nothing asked us to give up.
   */
  async #zeroRetentionParameters(model: string): Promise<ReadonlySet<string> | null> {
    if (!this.#parameterCache) {
      this.#parameterCache = (async () => {
        const map = new Map<string, ReadonlySet<string>>();
        try {
          const response = await this.#fetch(`${this.#baseUrl}/endpoints/zdr`, {
            headers: this.#headers(),
            signal: AbortSignal.timeout(15_000)
          });
          if (!response.ok) return map;
          const body = (await response.json()) as {
            data?: Array<{ model_id?: unknown; status?: unknown; supported_parameters?: unknown }>;
          };
          for (const endpoint of body.data ?? []) {
            if (typeof endpoint.model_id !== 'string') continue;
            if (endpoint.status !== undefined && endpoint.status !== 0) continue;
            if (!Array.isArray(endpoint.supported_parameters)) continue;
            const declared = new Set(
              endpoint.supported_parameters.filter((v): v is string => typeof v === 'string')
            );
            const held = map.get(endpoint.model_id);
            if (!held || richerRoute(declared, held)) map.set(endpoint.model_id, declared);
          }
          return map;
          // An endpoint that will not describe itself is left alone rather than stripped bare:
          // filtering on an answer we do not have would break every route that publishes nothing.
        } catch {
          return map;
        }
      })();
    }
    return (await this.#parameterCache).get(model) ?? null;
  }

  #headers(): HeadersInit {
    return {
      'content-type': 'application/json',
      ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
      ...(this.#appUrl ? { 'http-referer': this.#appUrl } : {}),
      ...(this.#appTitle ? { 'x-title': this.#appTitle } : {})
    };
  }

  async list(signal?: AbortSignal): Promise<ProviderModel[]> {
    const response = await this.#fetch(`${this.#baseUrl}/models`, {
      headers: this.#headers(),
      ...(signal ? { signal } : {})
    });
    if (!response.ok)
      throw new GardenError('provider_unavailable', `${this.provider} returned ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id: string; owned_by?: string }> };
    return (body.data ?? []).map((model) => ({
      id: model.id,
      provider: this.provider,
      revision: model.owned_by ?? 'provider-managed'
    }));
  }

  /** Discovery is the authority for account availability, including documented native models. */
  async describe(signal?: AbortSignal): Promise<ConfiguredModelDescription[]> {
    const response = await this.#fetch(`${this.#baseUrl}/models`, {
      headers: this.#headers(),
      ...(isNativeOpenAIEndpoint(this.#baseUrl) ? { redirect: 'error' as const } : {}),
      ...(signal ? { signal } : {})
    });
    if (!response.ok)
      throw new GardenError('provider_unavailable', `${this.provider} returned ${response.status}`);
    const body = (await response.json()) as { data?: unknown };
    const entries = Array.isArray(body.data) ? body.data : [];
    const described = entries
      .filter(isRecord)
      .map((entry) => describeNativeOpenAIInput(this.#baseUrl, describeConfiguredModel(entry)));
    const endpoint = new URL(this.#baseUrl);
    if (endpoint.origin !== 'https://ollama.com') return described;
    // Ollama's OpenAI model list omits capabilities; its native metadata endpoint supplies them.
    for (let offset = 0; offset < described.length; offset += 4) {
      await Promise.all(
        described.slice(offset, offset + 4).map(async (model) => {
          // Both halves of /api/show are read every time a model is missing either, so a
          // catalogue written by an older build that only knew thinking is repaired by the same
          // loop that repairs one that knows nothing.
          if (model.reasoning?.supportedEfforts !== undefined && model.inputModalities) return;
          try {
            const timeout = AbortSignal.timeout(5_000);
            const response = await this.#fetch(`${endpoint.origin}/api/show`, {
              method: 'POST',
              headers: this.#headers(),
              redirect: 'error',
              body: JSON.stringify({ model: model.id }),
              signal: signal ? AbortSignal.any([signal, timeout]) : timeout
            });
            if (!response.ok) return;
            const body: unknown = await response.json();
            if (!isRecord(body) || !Array.isArray(body.capabilities)) return;
            const capabilities = body.capabilities.filter(
              (entry): entry is string => typeof entry === 'string'
            );
            const thinking = capabilities.includes('thinking');
            const gptOss = /^gpt-oss(?::|$)/.test(model.id);
            // Vision is a capability the native endpoint publishes and the OpenAI-shaped list
            // never did; the modality list is what every image-input gate reads, so the
            // capability is translated at the edge rather than read again downstream.
            const modalities = capabilities.includes('vision')
              ? (['text', 'image'] as const)
              : (['text'] as const);
            Object.assign(model, {
              inputModalities: [...modalities],
              supportsReasoningEffort: thinking,
              ...(thinking
                ? {
                    reasoning: {
                      mandatory: gptOss,
                      // https://docs.ollama.com/capabilities/thinking
                      supportedEfforts: gptOss
                        ? ['low', 'medium', 'high']
                        : ['none', 'low', 'medium', 'high', 'max']
                    }
                  }
                : {})
            });
          } catch {
            // Metadata failure must not remove an otherwise reachable model from the catalogue.
            if (signal?.aborted) signal.throwIfAborted();
          }
        })
      );
    }
    return described;
  }

  /**
   * Translates portable cache breakpoints into `cache_control` markers for routes that bill them,
   * newest first so the most valuable prefix still gets a marker when a request carries more
   * breakpoints than the provider accepts.
   */
  #cacheBreakpointIndexes(input: ModelRequest): Set<number> {
    // OpenAI's explicit format differs from cache_control. A stored catalogue hint must not
    // override the route's wire contract; automatic caching remains available without markers.
    if (
      this.provider === 'openrouter' &&
      input.model.toLowerCase().replace(/^~/, '').startsWith('openai/')
    )
      return new Set();
    const style = input.promptCacheStyle ?? promptCacheStyle(input.model);
    if (style !== 'explicit') return new Set();
    const eligible: number[] = [];
    input.messages.forEach((message, index) => {
      // A message carrying images already needs block content for the image itself; leaving it
      // out keeps one marker per block list and avoids guessing where a provider expects the
      // marker among mixed blocks.
      if (
        message.cacheBreakpoint &&
        BLOCK_CONTENT_ROLES.has(message.role) &&
        !message.images?.length &&
        !message.nativeInputs?.length
      )
        eligible.push(index);
    });
    return new Set(eligible.slice(-MAX_CACHE_BREAKPOINTS));
  }

  /**
   * The provider-side tools, in the shape they travel in, or a refusal.
   *
   * A server tool is a type and the settings that type takes, flat, which is how both of the
   * vendors whose tools arrive through this route express theirs - it is not a function tool and
   * must not be wrapped as one, because `{type:'function'}` is precisely the claim that this box
   * will answer the call. `type` is written after the settings so a parameter bag that carries a
   * `type` of its own cannot rename the tool being requested.
   *
   * The check below is a refusal rather than a repair, and it is here rather than only at the call
   * site because this is the last code that runs before the request leaves the machine. A catalogue
   * that still offers the in-house tool the provider one stands in for hands the model two
   * descriptions of one capability. That is not a wire error - the provider would accept it - so
   * nothing downstream would ever report it; it would surface as a model that sometimes searches one
   * way and sometimes the other, which is the shape of failure nobody traces back to a tools array.
   *
   * A second refusal used to stand beside it: server tools on a connection that enforces zero data
   * retention. It was reasoning from the true half of a fact. Zero-retention enforcement covers
   * inference routing and explicitly does not cover tools - which means a search query is outside
   * that guarantee however this request is built, so refusing to send the tools never protected the
   * query. It only ensured that a box configured the shipped way could not search, since the flag
   * ships on. Where a query may go is now settled once, by the plan in @garden/contracts, and
   * disclosed to the owner in the words that plan hands back; a request arriving here with both is
   * the ordinary case on a zero-retention box, not a caller's bug.
   */
  #serverToolPayload(input: ModelRequest): Array<Record<string, unknown>> {
    const serverTools = input.serverTools ?? [];
    if (serverTools.length === 0) return [];
    const requested = serverTools.map((tool) => tool.type).join(', ');
    const duplicated = duplicatedWebCapabilities(
      serverTools,
      input.tools.map((tool) => tool.name)
    );
    if (duplicated.length > 0)
      throw new GardenError(
        'web_tool_catalogue_conflict',
        `${requested} was sent while ${duplicated.join(', ')} stayed in the tool catalogue, which offers the model two ways to do one thing`
      );
    return serverTools.map((tool) => ({ ...tool.parameters, type: tool.type }));
  }

  /**
   * Whether a 400 is the provider refusing signed reasoning it can no longer verify. Read from a
   * clone so the caller's error path still has the body to quote.
   */
  async #isSignedReasoningRefusal(response: Response): Promise<boolean> {
    const text = await response
      .clone()
      .text()
      .catch(() => '');
    if (!/thinking|reasoning/i.test(text)) return false;
    return /signature|cannot be modified|must remain|invalid.*block/i.test(text);
  }

  /**
   * The one recovery attempt on a reply to a streamed request that was not a stream. A completion
   * is kept and used; anything else is a fault rather than the silent empty turn it used to be.
   * `502` because the request was accepted and the thing that answered it is not what was asked
   * for - a different instance, or the same one without the proxy in front of it, may well work.
   */
  #unstreamedCompletion(text: string): CompletionBody {
    const body = completionFromJson(text);
    if (body) return body;
    throw new GardenError(
      'provider_stream_unparsed',
      `${this.provider} answered a streamed request with ${
        text.trim() ? 'neither a stream nor a completion' : 'an empty body'
      }`,
      502
    );
  }

  async chat(input: ModelRequest): Promise<ModelResponse> {
    assertReasoningEffort(input.reasoningEffort, input.reasoningOptions);
    const nativeParts = input.messages.flatMap((message) => message.nativeInputs ?? []);
    if (
      nativeParts.length > NATIVE_INPUT_MAX_PARTS ||
      nativeParts.reduce((sum, part) => sum + Buffer.byteLength(part.data, 'base64'), 0) >
        NATIVE_INPUT_MAX_BYTES
    )
      throw new GardenError(
        'native_input_too_large',
        'Native media exceeds the combined request limit',
        413
      );
    const nativeBlocks = new Map<number, NativeInputBlock[]>();
    for (const [index, message] of input.messages.entries()) {
      if (!message.nativeInputs?.length) continue;
      if (message.role !== 'user')
        throw new GardenError(
          'native_input_role_invalid',
          'Native media is only accepted as user input data',
          400
        );
      nativeBlocks.set(
        index,
        nativeInputBlocks(message.nativeInputs, this.provider, input.inputModalities)
      );
    }
    const started = performance.now();
    const serverTools = this.#serverToolPayload(input);
    const cacheBreakpoints = this.#cacheBreakpointIndexes(input);
    // Only consulted where it can change the outcome: the demand that every parameter be honoured
    // is sent under zero data retention and nowhere else, so nowhere else can a declared-parameter
    // list turn a live model into a 404.
    const nativeOpenAI = isNativeOpenAIEndpoint(this.#baseUrl);
    const declared =
      this.#enforceZeroDataRetention && !nativeOpenAI
        ? await this.#zeroRetentionParameters(input.model)
        : null;
    const sends = (parameter: string): boolean => !declared || declared.has(parameter);
    // Whether this request asks the route to think, which decides the effort field and the
    // temperature together.
    const thinking = Boolean(
      input.reasoningEffort &&
      input.supportsReasoningEffort !== false &&
      sends(this.provider === 'openrouter' ? 'reasoning' : 'reasoning_effort')
    );
    /**
     * The same cap under whichever name the route declared. A route that takes only
     * `max_completion_tokens` still gets an output ceiling rather than none, which is what keeps a
     * long task inside its budget and its context window.
     */
    const outputCap = ((): Record<string, number> => {
      const value = maxTokensFor(input);
      if (value === undefined) return {};
      if (input.textPriceCeiling && nativeOpenAI) return { max_completion_tokens: value };
      if (sends('max_tokens')) return { max_tokens: value };
      if (declared?.has('max_completion_tokens')) return { max_completion_tokens: value };
      if (input.textPriceCeiling)
        throw new GardenError(
          'provider_output_limit_unsupported',
          'This route cannot enforce the title output limit',
          409
        );
      return {};
    })();
    if (
      input.textPriceCeiling &&
      input.reasoningEffort &&
      !sends(this.provider === 'openrouter' ? 'reasoning' : 'reasoning_effort')
    )
      throw new GardenError(
        'provider_reasoning_control_unsupported',
        'This route cannot disable reasoning for a title',
        409
      );
    const payload = (withReasoningDetails: boolean, shedImages: ReadonlySet<number>): string =>
      JSON.stringify({
        model: input.model,
        ...(nativeOpenAI ? { store: false, service_tier: 'default' } : {}),
        ...(nativeOpenAI && nativeParts.length ? { modalities: ['text'] } : {}),
        messages: input.messages.map((message, index) => ({
          role: message.role,
          content: ((): string | ContentBlock[] => {
            const media = nativeBlocks.get(index);
            if (media)
              return [
                { type: 'text', text: message.content },
                ...media,
                ...(message.images ?? []).map(
                  (url): ContentBlock => ({ type: 'image_url', image_url: { url } })
                )
              ];
            // Shed first, and as plain text with no marker: only a message that carries images can
            // be in this set, and `#cacheBreakpointIndexes` never marks one of those - so this
            // message had no breakpoint to keep, exactly as it had none when its images were still
            // attached. Writing the branch the other way round would be writing a marker this
            // request was not built with, on the one path where the prefix has just changed.
            if (shedImages.has(index))
              return `${message.content}\n\n${shedImageNotice(
                message.images?.length ?? 0,
                this.#maxRequestBytes
              )}`;
            if (message.images?.length)
              return [
                { type: 'text', text: message.content },
                ...message.images.map(
                  (url): ContentBlock => ({ type: 'image_url', image_url: { url } })
                )
              ];
            if (!cacheBreakpoints.has(index)) return message.content;
            return [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }];
          })(),
          ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
          ...(message.reasoning ? { reasoning: message.reasoning } : {}),
          ...(withReasoningDetails && message.reasoningDetails?.length
            ? { reasoning_details: message.reasoningDetails }
            : {}),
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) }
                }))
              }
            : {})
        })),
        tools: [
          ...input.tools.map((tool) => ({ type: 'function', function: tool })),
          ...serverTools
        ],
        /*
         * A thinking request is sent no temperature, as the Responses adapter and the Anthropic
         * bridge already send none: the route's own default is what its thinking was tuned at.
         * Well below it, reasoning models fall into loops - DeepSeek's guidance for its own names
         * endless repetition as the reason - and measured on live runs the thinking channel looped
         * on one short sentence until the output ceiling.
         */
        ...(sends('temperature') && !thinking && input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
        ...(thinking
          ? this.provider === 'openrouter'
            ? { reasoning: { effort: input.reasoningEffort } }
            : { reasoning_effort: input.reasoningEffort }
          : {}),
        ...(input.sessionId && !nativeOpenAI ? { session_id: input.sessionId } : {}),
        ...outputCap,
        ...(input.onTextDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
        /*
         * Which of the companies serving this model gets the work.
         *
         * `preferred_min_throughput` and `sort` are both applied by the aggregator, against
         * throughput figures taken across every request it has ever served. Nothing on this side
         * could do the comparison: those per-endpoint figures are readable by no API client at all,
         * which is why the floor arrives as a number and the ranking as a name.
         *
         * The floor deprioritises rather than excludes, so it cannot fail a request, and it
         * composes with `sort`: the threshold partitions the field and the sort orders inside each
         * part. `require_parameters` is separate and not a preference - a company that drops the
         * tool list does not fail, it answers in prose while the harness waits for a call.
         */
        ...((this.#enforceZeroDataRetention && !nativeOpenAI) ||
        ((nativeParts.length || input.textPriceCeiling || input.providerPreferences) &&
          this.provider === 'openrouter')
          ? {
              provider: {
                ...(this.#enforceZeroDataRetention
                  ? { zdr: true, data_collection: 'deny', require_parameters: true }
                  : {}),
                ...(input.providerPreferences && this.provider === 'openrouter'
                  ? { ...input.providerPreferences, require_parameters: true }
                  : {}),
                allow_fallbacks: nativeParts.length || input.textPriceCeiling ? false : true,
                ...(input.textPriceCeiling
                  ? { require_parameters: true, max_price: input.textPriceCeiling }
                  : {}),
                ...(nativeParts.length && input.nativeInputMaxPrice
                  ? { max_price: input.nativeInputMaxPrice }
                  : {})
              }
            }
          : {})
      });
    // What the last assembled body measured. Read by the clocks below: the deadline a stream is
    // held to is scaled to the size of the request that started it, and this is the only place that
    // size is known rather than estimated.
    let requestBytes = 0;
    /*
     * The body, measured, and brought under the byte ceiling if it can be.
     *
     * Oldest attachment first, because the newest picture is the one the current step is reasoning
     * about and the oldest is the one the window would have aged out next anyway. Re-serialised
     * rather than measured piecewise: escaping is what a data URL costs on the wire, and a
     * subtraction that guessed at it would be measuring something other than the thing the
     * transport counts.
     *
     * The refusal reuses `provider_context_overflow` deliberately. It is not a token overflow and
     * the message says so - but the caller has exactly one repair for "this request is too big",
     * which is to condense and try again, and it is keyed on that code. Minting a second code here
     * would take the one refusal on this path that has a working repair and give it none. By the
     * time it is raised every image is already gone, so what is left is text, which is precisely
     * what condensing shrinks.
     */
    const assemble = (withReasoningDetails: boolean): { body: string; bytes: number } => {
      const attachments = input.messages.flatMap((message, index) =>
        message.images?.length && !message.nativeInputs?.length ? [index] : []
      );
      const shed = new Set<number>();
      for (;;) {
        const body = payload(withReasoningDetails, shed);
        const bytes = Buffer.byteLength(body, 'utf8');
        if (this.#maxRequestBytes <= 0 || bytes <= this.#maxRequestBytes) return { body, bytes };
        const oldest = attachments.find((index) => !shed.has(index));
        if (oldest === undefined)
          throw new GardenError(
            nativeParts.length ? 'native_input_too_large' : 'provider_context_overflow',
            `${this.provider} was not sent this request: the assembled body is ${bytes} bytes, past the ${this.#maxRequestBytes}-byte ceiling this side holds, and there is nothing left to leave out`,
            413,
            { requestBytes: bytes, maxRequestBytes: this.#maxRequestBytes }
          );
        shed.add(oldest);
      }
    };
    const send = async (withReasoningDetails: boolean): Promise<Response> => {
      // Assembled outside the try on purpose: a refusal this side raised must not be caught by the
      // catch below and reported as a provider that could not be reached. One is a fault the caller
      // can repair and retry into; the other is an outage.
      const assembled = assemble(withReasoningDetails);
      requestBytes = assembled.bytes;
      try {
        return await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.#headers(),
          ...(input.signal ? { signal: input.signal } : {}),
          body: assembled.body
        });
      } catch {
        throw new GardenError('provider_unavailable', `${this.provider} could not be reached`, 503);
      }
    };
    let response = await send(true);
    // A thinking block is signed against the whole turn it was produced in, so anything that
    // reshapes the window - compaction, middle-truncation, the ageing-out of older details -
    // invalidates the signature, and the model refuses the replay with a 400. That is not
    // retryable: the same bytes fail forever, and because the refusal appends nothing the window
    // never advances past the offending message, so a resumed task dies at the same step for good.
    // The one repair is to stop replaying the signed material. It is dropped from this request
    // only, never from the stored trajectory - editing that would poison every future turn.
    // Not gated on provider name: OpenRouter proxies the upstream's wording verbatim.
    if (
      !nativeParts.length &&
      response.status === 400 &&
      (await this.#isSignedReasoningRefusal(response))
    ) {
      response = await send(false);
    }
    if (!response.ok) {
      // The provider's own account of what it disliked, which is the whole of the diagnosis when a
      // request is refused. A bare "(400)" says a request was malformed without saying which part,
      // and the body is the only thing that does. Bounded, because this is an error path.
      const body = await response.text().catch(() => '');
      /*
       * What the provider actually said, unwrapped from whatever it wrapped it in.
       *
       * Read once and used twice, and the unwrapping is load-bearing rather than tidy: matching the
       * refusal against the raw body means matching against the envelope's own field names, and
       * `{"error":{"message":"tool name is too long"}}` reads as a complaint about a message being
       * too long. The sentence is the evidence; the JSON around it is not.
       */
      const complaint = ((): string => {
        try {
          const parsed: unknown = body.trim().startsWith('{') ? JSON.parse(body) : body;
          return providerFault(asRecord(parsed)?.error ?? parsed)?.message ?? body.trim();
        } catch {
          return body.trim();
        }
      })();
      const explanation = complaint ? `: ${complaint.slice(0, 400)}` : '';
      /*
       * The window will not fit, said in the provider's own words.
       *
       * Named separately from every other refusal because it is the only 400 the caller can repair:
       * everything else at this status fails identically however it is re-sent, and this one stops
       * failing the moment the window is smaller. It travels with the sizes the provider named so
       * the repair is aimed at the number the route actually enforces rather than at the one the
       * catalogue published for the model - those differ, and it is the difference that puts a
       * request over the line. Still non-retryable: the identical bytes are refused identically, so
       * the repair has to happen a layer up, before the next attempt exists.
       */
      // The signed-reasoning repair above has already had its one shot at this response, so a body
      // that reaches here is not that refusal however it reads.
      if (
        (response.status === 400 || response.status === 413) &&
        isContextOverflowText(complaint)
      ) {
        const sizes = contextOverflowSizes(complaint);
        throw new GardenError(
          'provider_context_overflow',
          `${this.provider} refused the request because the window is larger than the route will take (${response.status})${explanation}`,
          response.status,
          sizes
        );
      }
      // The status has to travel with the error. Without it every 5xx inherits GardenError's
      // default of 400, `isRetryableError` reads that as a client mistake, and a task that has run
      // for hours dies on one upstream blip that a single retry would have absorbed.
      throw new GardenError(
        providerFaultCode(response.status),
        `${this.provider} request failed (${response.status})${explanation}`,
        response.status,
        {
          retryAfter: response.headers.get('retry-after') ?? undefined,
          ...(isModelScopedLimit(response.status, complaint) ? { limitScope: 'model' } : {})
        }
      );
    }
    // Nothing publishes a usable latency for these routes, so the only honest number is the one
    // measured here: on this owner's network, from this box, on this owner's prompts.
    const firstToken: { at?: number } = {};
    /*
     * One generation budget, started here, for whichever way the answer arrives.
     *
     * It used to live inside the stream reader, so five of this product's seven model call sites -
     * the delegate step, the provider web search, the compaction summariser, the vision specialist
     * and the API titler, none of which stream - had no idle clock, no generation deadline, no
     * character ceiling, no `truncated` marking and no estimated usage. A specialist mission is
     * sixteen model calls, each able to hold a worker for the caller's whole fifteen minutes
     * against a provider that has gone quiet, inside one unanswered tool call of a lead whose own
     * step is bounded to ten. Every bound written for the fifteen-minute incident applied to the
     * cheap path only.
     *
     * Started from the response headers rather than from the request, which is what the comment on
     * the constant has always said: a route that is slow to accept the connection is not charged
     * for the waiting.
     */
    const budget = startGenerationBudget({
      timeoutMs: this.#generationTimeoutMs,
      maxChars: this.#generationMaxChars ?? generationCharCeiling(maxTokensFor(input))
    });
    /**
     * A whole-body read held to the same deadline the streamed path is held to. The body is torn
     * down rather than left outstanding: a socket the provider is still writing into holds this
     * worker's slot for as long as it feels like writing.
     */
    const withinBudget = async <T>(read: () => Promise<T>): Promise<T> => {
      // Zero, negative or non-finite all mean the same thing here in different words: a deadline of
      // `Infinity` is the escape hatch for an unusual route and is the only one that waits.
      const remainingMs = Math.max(0, budget.remainingMs());
      const pending = read();
      if (!Number.isFinite(remainingMs)) return pending;
      pending.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = Symbol('expired');
      const outcome = await Promise.race([
        pending,
        new Promise<typeof expired>((resolve) => {
          timer = setTimeout(() => resolve(expired), remainingMs);
          timer.unref();
        })
      ]).finally(() => clearTimeout(timer));
      if (outcome !== expired) return outcome as T;
      await response.body?.cancel().catch(() => undefined);
      throw new GardenError(
        'provider_stream_stalled',
        `${this.provider} accepted the request and then sent nothing back for ${Math.round(
          budget.elapsedMs() / 1000
        )} seconds, so the response was abandoned`,
        504
      );
    };
    /*
     * `stream: true` is a request, not a guarantee.
     *
     * A buffering proxy - LiteLLM, a corporate egress gateway - answers it with an ordinary JSON
     * completion, and the SSE reader discards every line of it because none begins with `data:`.
     * Since the reader synthesises a `choices` array whatever it read, that came back as a
     * *success* carrying no text, no tool calls and no usage: the turn completed with nothing in
     * it, the loop's completion nag fired its three times, and the ledger recorded $0.00 for every
     * call the provider billed. The catalogue path has carried a defence against this exact shape
     * since `provider_catalog_empty` - an empty list is an outage wearing a 200 - and the inference
     * path had none.
     *
     * A reply that declares itself JSON is read as JSON. Anything else, including a reply that
     * declares nothing, is still read as a stream, because that is what every honouring route sends
     * and a route with an unusual content type must not lose its answer to this check; the frame
     * count below catches it either way.
     */
    const contentType = response.headers.get('content-type') ?? '';
    const declaredJson = /\bjson\b/i.test(contentType) && !/event-stream/i.test(contentType);
    let streamed: StreamedBody | undefined;
    let body: CompletionBody;
    if (input.onTextDelta && !declaredJson) {
      const reply = await this.#streamCompletion(
        response,
        budget,
        streamIdleTimeoutFor(this.#streamIdleTimeoutMs, requestBytes),
        input.onTextDelta,
        firstToken,
        input.onReasoningDelta,
        input.signal
      );
      // Not one frame parsed, so nothing about this reply was a stream. It is read once as an
      // ordinary completion before it is called a fault: the gateway that buffered the stream away
      // gave a perfectly good answer, and throwing it away is what made a billed call an empty turn.
      if (reply.frames > 0) {
        streamed = reply;
        body = reply;
      } else body = this.#unstreamedCompletion(reply.unstreamed ?? '');
    } else if (input.onTextDelta) {
      body = this.#unstreamedCompletion(await withinBudget(() => response.text()));
    } else {
      body = (await withinBudget(() => response.json())) as CompletionBody;
    }
    // Hoisted above `choices`, which used to gate it: `#streamCompletion` returns a `choices` array
    // of length one however the stream went, so on the streamed path this guard was unreachable -
    // and the streamed path is where a 200 carrying only an `error` object most often arrives.
    const fault = this.#fault(body.error, 'in its response');
    if (fault) throw fault;
    const choice = body.choices?.[0];
    // A failed parse used to become `{}` and run anyway: `file_write` cut off mid-JSON was
    // dispatched with no path and no content, failed on a validation error that named neither the
    // truncation nor the remedy, and the turn spent its remaining steps rewriting the same file.
    // The call is marked instead, and the loop refuses it with an explanation.
    /*
     * Two different failures wore one name. A call whose arguments will not parse was always
     * reported as having been cut off at the output limit, and a smaller model writing malformed
     * JSON - which it does far more often - was told to send a shorter payload, which is no help at
     * all. The provider says which it was: `length` is the only finish reason that means truncation.
     */
    const stoppedAtLimit = choice?.finish_reason === 'length';
    const toolCalls = (choice?.message?.tool_calls ?? []).map((call) => {
      try {
        return {
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments) as Record<string, unknown>
        };
      } catch {
        return {
          id: call.id,
          name: call.function.name,
          arguments: {},
          parseFailed: true as const,
          ...(stoppedAtLimit ? { argumentsTruncated: true as const } : {}),
          rawArguments: call.function.arguments
        };
      }
    });
    /*
     * A streamed request asks for usage and the route sends it in one frame at the end, so a stream
     * that was cut off - or one from a route that simply never sends the frame - leaves this side
     * with nothing to bill. It used to record zero, which is how a quarter of an hour of generation
     * came to sit on the timeline under a price that never moved while the owner watched it. The
     * characters were counted on the way past; four to the token is the same rough conversion the
     * window is estimated with, and it travels marked as an estimate so nothing downstream mistakes
     * it for the provider's own number. The prompt is not estimated: this side never saw it.
     */
    const reportedOutputTokens = body.usage?.completion_tokens;
    const countedOutputTokens = streamed ? estimatedOutputTokens(streamed.generatedChars) : 0;
    // A route that reports usage on every chunk rather than only at the end reports a count that
    // stops where the cut did, so on a cutoff the provider's own number is not final either and the
    // larger of the two stands. A stream that ran to its end keeps whatever the provider said,
    // however the estimate compares: nothing here estimates over the top of a finished count.
    const estimated =
      streamed?.failure !== undefined ||
      (countedOutputTokens > 0 &&
        (reportedOutputTokens === undefined ||
          (streamed?.cutoff !== undefined && countedOutputTokens > reportedOutputTokens)));
    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = estimated
      ? Math.max(countedOutputTokens, reportedOutputTokens ?? 0)
      : (reportedOutputTokens ?? 0);
    const citations = webCitationsFrom(choice?.message?.annotations);
    const serverToolUse = serverToolUseFrom(body.usage?.server_tool_use);
    /*
     * The two ways a route hands back its thinking, and the third way it fails to.
     *
     * A stream has already been through the splitter by the time it reaches here, so `inline` is a
     * no-op on that path and this is the non-streamed reply's only chance. Both are read because a
     * route that answers `stream: false` - the title and memory workloads do - takes exactly the
     * same detour through its own deliberation, and there is nothing downstream that can tell
     * thinking from prose after the fact.
     *
     * If a route ever sends both, neither is dropped: the span was removed from the answer, so
     * throwing it away would lose text nothing else carries.
     */
    const inline = splitLeadingThinkSpan(choice?.message?.content ?? '');
    const wireReasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
    // Concatenated only where there is something to concatenate. With no inline span - which is
    // every reply this route has ever produced until one of them has one - the field is handed
    // through exactly as it arrived, unread and uncoerced, which is what keeps this half of the
    // change provably content-neutral.
    const reasoning = inline.reasoning
      ? `${inline.reasoning}${wireReasoning ?? ''}`
      : wireReasoning;
    const result: ModelResponse = {
      text: inline.text,
      ...(reasoning ? { reasoning } : {}),
      ...(choice?.message?.reasoning_details?.length
        ? { reasoningDetails: choice.message.reasoning_details }
        : {}),
      toolCalls,
      ...(citations.length > 0 ? { citations } : {}),
      finishReason: toolCalls.length
        ? 'tool_calls'
        : choice?.finish_reason === 'length'
          ? 'length'
          : 'stop',
      ...(streamed?.cutoff ? { truncated: streamed.cutoff } : {}),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: estimated
          ? inputTokens + outputTokens
          : (body.usage?.total_tokens ?? inputTokens + outputTokens),
        ...(estimated ? { estimated: true as const } : {}),
        ...(!estimated && typeof body.usage?.cost === 'number' ? { costUsd: body.usage.cost } : {}),
        ...(serverToolUse ? { serverToolUse } : {}),
        ...readCacheUsage(body.usage)
      },
      metadata: {
        provider: this.provider,
        model: body.model ?? input.model,
        latencyMs: Math.round(performance.now() - started),
        ...(firstToken.at === undefined
          ? {}
          : { timeToFirstTokenMs: Math.round(firstToken.at - started) }),
        privacyRoute: this.privacyRoute,
        ...(body.provider ? { upstreamProvider: body.provider } : {}),
        ...(body.id ? { generationId: body.id } : {})
      }
    };
    if (streamed?.failure) {
      retainInterruptedResponse(streamed.failure, result);
      throw streamed.failure;
    }
    return result;
  }

  /**
   * One read, bounded by two clocks that measure different things.
   *
   * The idle clock restarts on every read, so a turn that keeps producing runs as long as it needs
   * to and only a genuinely silent provider trips it. The generation clock does not restart, and it
   * is here for the read that is still outstanding when the whole generation runs out of time -
   * the caller's loop reads the same clock for itself between chunks, because a read that resolves
   * from bytes already buffered wins this race every time and a race alone is not a bound.
   *
   * Neither throws. Which clock ran out is returned, because both leave text on the floor and the
   * decision about what that partial answer is worth is not made in here.
   */
  async #readWithin(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    remainingMs: number,
    /** This request's own idle deadline, scaled to its size by `chat`; zero still disables it. */
    streamIdleTimeoutMs: number
  ): Promise<
    { outcome: 'chunk'; read: ReadableStreamReadResult<Uint8Array> } | { outcome: GenerationCutoff }
  > {
    const idleMs = streamIdleTimeoutMs > 0 ? streamIdleTimeoutMs : Number.POSITIVE_INFINITY;
    const deadlineMs = Math.min(idleMs, Math.max(0, remainingMs));
    const cutoff: GenerationCutoff = remainingMs <= idleMs ? 'timeout' : 'stalled';
    if (!Number.isFinite(deadlineMs)) return { outcome: 'chunk', read: await reader.read() };
    const pending = reader.read();
    // The deadline can win the race and leave this read outstanding; the caller cancels the reader
    // straight after, but a socket that errors in the same tick would otherwise reject with nobody
    // listening and take the process down with it.
    pending.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.then((read) => ({ outcome: 'chunk', read }) as const),
        new Promise<{ outcome: GenerationCutoff }>((resolve) => {
          timer = setTimeout(() => resolve({ outcome: cutoff }), deadlineMs);
          timer.unref();
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #streamCompletion(
    response: Response,
    /** Started by `chat` from the response headers, so both ways of reading a reply share one. */
    budget: GenerationBudget,
    /** Scaled to the size of the request that started it; see `streamIdleTimeoutFor`. */
    streamIdleTimeoutMs: number,
    onTextDelta: (delta: string) => void | Promise<void>,
    firstToken: { at?: number } = {},
    onReasoningDelta?: (delta: string) => void | Promise<void>,
    /**
     * The caller's own signal, so an abort it raised itself can be told apart from a socket that
     * died. What the caller does about it is the caller's business; what this side owes it is the
     * text and the token count, which is the difference between a stopped generation costing what
     * it cost and costing nothing at all.
     */
    signal?: AbortSignal
  ): Promise<StreamedBody> {
    if (!response.body)
      throw new GardenError('provider_request_failed', `${this.provider} returned no stream`);
    let cutoff: GenerationCutoff | undefined;
    let failure: Error | undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<
      number,
      { id: string; function: { name: string; arguments: string } }
    >();
    let buffer = '';
    let frames = 0;
    const limits = streamLimits(budget.maxChars());
    let terminal = false;
    let retainedMetadata = 0;
    let eventData: string[] = [];
    let eventChars = 0;
    // Held back only until the first frame parses, and only to a bound. A route that honoured
    // `stream: true` never reads this; a route that ignored it wrote its whole answer in here.
    let unstreamed = '';
    let content = '';
    let reasoning = '';
    const think = createThinkSplitter();
    const reasoningDetails: unknown[] = [];
    // Kept raw and deduplicated once at the end: a route that resends the whole list on each chunk
    // would otherwise be deduplicated against a growing list on every frame of a long answer.
    const annotations: unknown[] = [];
    let finishReason: string | undefined;
    let outputLimit = false;
    let model: string | undefined;
    let upstreamProvider: string | undefined;
    /*
     * The aggregator's own handle on this generation.
     *
     * Its generation-stats route answers with `generation_time`, the completion token count and the
     * company that served the request - all measured by the aggregator - and tokens over time is
     * the throughput figure it will not publish per endpoint. That is the one number a relative
     * speed rule needs, and this id is the only way to ask for it.
     */
    let generationId: string | undefined;
    let usage: CompletionBody['usage'];
    const consume = async (line: string): Promise<void> => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        terminal = true;
        return;
      }
      if (!payload) return;
      let chunk: StreamChunk;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (!isRecord(parsed)) return;
        chunk = parsed as StreamChunk;
      } catch {
        return;
      }
      frames += 1;
      // One frame proves the reply is a stream, so the bytes kept for the recovery parse are of no
      // further use and the memory goes back.
      if (frames === 1) unstreamed = '';
      model = chunk.model ?? model;
      upstreamProvider = chunk.provider ?? upstreamProvider;
      generationId = chunk.id ?? generationId;
      usage = chunk.usage ?? usage;
      const fault = this.#fault(chunk.error, 'mid-response');
      if (fault) {
        // Some routes report a truncated tool call as an error frame. Preserve its partial
        // arguments so the normal truncation recovery can request a smaller, complete call.
        if (
          [400, 502].includes(fault.statusCode) &&
          /\bTool calls cutoff by max_tokens\.?\s*$/i.test(fault.message)
        ) {
          finishReason = 'length';
          outputLimit = true;
          return;
        }
        throw fault;
      }
      const choice = chunk.choices?.[0];
      finishReason = choice?.finish_reason ?? finishReason;
      const delta = choice?.delta;
      // `reasoning_content` first, because a route that sends it is a route that means it; the
      // OpenRouter-normalised spelling is the fallback. No route sends both, and if one ever does
      // the one it named itself wins.
      const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
      // Reasoning counts: it is the first token the model produced, and on a reasoning route it is
      // most of the wait. The callback runs after, so the reading is not charged for our own work.
      if (firstToken.at === undefined && (delta?.content || reasoningDelta))
        firstToken.at = performance.now();
      if (delta?.content) {
        // Split before publishing, never after. Once a `<think>` fragment has gone out over
        // `onTextDelta` it is on the owner's screen and in the timeline, and no repair afterwards
        // can take it back - which is exactly how deliberation came to be published as an answer.
        const split = think.push(delta.content);
        if (split.text) {
          content += split.text;
          await onTextDelta(split.text);
        }
        if (split.reasoning) {
          reasoning += split.reasoning;
          if (onReasoningDelta) await onReasoningDelta(split.reasoning);
        }
        // Handed over first, then counted. The characters are already on the owner's screen, and a
        // ceiling that swallowed the fragment that crossed it would be hiding its own evidence.
        //
        // Counted at the delta's full length rather than at the two halves' - the tags and anything
        // still held back included. The model generated them, the provider billed them, and a route
        // that never closes its span would otherwise generate forever against a count that never
        // moves. This is also what keeps the ceiling byte-identical to what it was before the split.
        if (budget.produced(delta.content.length)) cutoff ??= 'overrun';
      }
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        if (onReasoningDelta) await onReasoningDelta(reasoningDelta);
        // Thinking counts against the ceiling as well: it is generated, it is billed as output, and
        // a route that loops inside its own reasoning produces no content at all to measure.
        if (budget.produced(reasoningDelta.length)) cutoff ??= 'overrun';
      }
      for (const [items, destination] of [
        [delta?.reasoning_details, reasoningDetails],
        [delta?.annotations, annotations],
        [choice?.message?.annotations, annotations]
      ] as const) {
        if (!Array.isArray(items) || !items.length) continue;
        if (limits.metadata(JSON.stringify(items).length)) {
          cutoff ??= 'framing';
          break;
        }
        for (const item of items) destination.push(item);
        retainedMetadata += items.length;
      }
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? toolCalls.size;
        const current = toolCalls.get(index) ?? {
          id: fragment.id ?? `call-${index}`,
          function: { name: '', arguments: '' }
        };
        if (fragment.id) current.id = fragment.id;
        if (fragment.function?.name) current.function.name += fragment.function.name;
        if (fragment.function?.arguments) current.function.arguments += fragment.function.arguments;
        toolCalls.set(index, current);
        // A call's arguments are generated output like any other, and on this product they are
        // where the volume is: a file_write carries the whole file inside them. Uncounted, a route
        // writing a runaway file passed the ceiling without touching it, and the call that spent
        // twenty-four thousand characters on it was handed back billed as nothing at all.
        const generated =
          (fragment.function?.name?.length ?? 0) + (fragment.function?.arguments?.length ?? 0);
        if (generated && budget.produced(generated)) cutoff ??= 'overrun';
      }
    };
    const consumeLine = async (line: string): Promise<void> => {
      if (line.startsWith('data:') || line === 'data') {
        eventChars += line.length + 1;
        if (eventChars > MAX_STREAM_LINE_CHARS) {
          cutoff ??= 'framing';
          return;
        }
        eventData.push(line.slice(5).replace(/^ /, ''));
        return;
      }
      if (line === '' && eventData.length) {
        const before = budget.characters(),
          metadataBefore = retainedMetadata;
        await consume(`data:${eventData.join('\n')}`);
        if (
          limits.line(
            eventChars + 1,
            budget.characters() > before || retainedMetadata > metadataBefore
          )
        )
          cutoff ??= 'framing';
        eventData = [];
        eventChars = 0;
      } else if (limits.line(line.length + 1, false)) cutoff ??= 'framing';
    };
    try {
      for (;;) {
        const step = await this.#readWithin(reader, budget.remainingMs(), streamIdleTimeoutMs);
        if (step.outcome !== 'chunk') {
          cutoff = step.outcome;
          break;
        }
        const { done, value } = step.read;
        const text = decoder.decode(value, { stream: !done });
        if (frames === 0 && unstreamed.length < MAX_UNSTREAMED_RECOVERY_CHARS)
          unstreamed += text.slice(0, MAX_UNSTREAMED_RECOVERY_CHARS - unstreamed.length);
        buffer += text;
        // Consume one line at a time so network coalescing cannot bypass the output bound.
        let offset = 0;
        for (;;) {
          const boundary = /[\r\n]/g;
          boundary.lastIndex = offset;
          const newline = boundary.exec(buffer)?.index ?? -1;
          if (newline < 0 || (!done && buffer[newline] === '\r' && newline === buffer.length - 1))
            break;
          const length = newline - offset;
          if (length > MAX_STREAM_LINE_CHARS) {
            cutoff ??= 'framing';
            break;
          }
          await consumeLine(buffer.slice(offset, newline));
          offset = newline + (buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1);
          if (outputLimit || cutoff || terminal) break;
        }
        buffer = buffer.slice(offset);
        if (!terminal && buffer.length + eventChars > MAX_STREAM_LINE_CHARS) cutoff ??= 'framing';
        if (done || cutoff || outputLimit || terminal) break;
        /*
         * The clock is read again here, and not only raced against the read above, because a race
         * is not a bound.
         *
         * A read that finds bytes already buffered - which is most reads on a route that is keeping
         * the socket busy - resolves as a settled promise, and a settled promise runs ahead of any
         * timer however short. So the deadline lost every race it was entered into and a stream
         * that never had to wait for the network ran forty-three times past it under test, stopped
         * in the end by the character ceiling and reported as an overrun. Read here, the deadline
         * holds whoever wins: the frame in hand is kept, and the next one is not asked for.
         */
        if (budget.remainingMs() <= 0) {
          cutoff = 'timeout';
          break;
        }
      }
      if (!cutoff && !outputLimit && !terminal) {
        if (buffer.trim()) await consumeLine(buffer);
        if (!cutoff) await consumeLine('');
      }
      if (!cutoff && !outputLimit && !terminal && !finishReason && frames > 0) {
        failure = new GardenError(
          'provider_unavailable',
          `${this.provider} ended the response stream before its completion marker`,
          503
        );
        if (!budget.characters() && !toolCalls.size && !reasoningDetails.length) throw failure;
      }
      // Every cutoff leaves the socket open and the provider still writing into it, so the read side
      // is torn down here rather than left to garbage collection.
      if (cutoff || outputLimit || terminal) await reader.cancel().catch(() => undefined);
    } catch (cause) {
      await reader.cancel().catch(() => undefined);
      const generated =
        budget.characters() > 0 ||
        toolCalls.size > 0 ||
        reasoningDetails.length > 0 ||
        (usage?.total_tokens ?? 0) > 0;
      if (!(cause instanceof GardenError) && isAbort(cause) && signal?.aborted && generated)
        cutoff = 'cancelled';
      else {
        const fault =
          cause instanceof GardenError || (isAbort(cause) && cause instanceof Error)
            ? cause
            : new GardenError(
                'provider_unavailable',
                `${this.provider} dropped the response stream: ${transportDetail(cause)}`,
                503
              );
        if (!generated) throw fault;
        failure = fault;
      }
    }
    /*
     * Whatever the splitter was still holding when the stream ended, however it ended.
     *
     * Placed after the catch and not inside the loop deliberately: a stall, a deadline, an overrun
     * and the owner pressing Stop all leave the reader here, and every one of them can land in the
     * middle of a held-back fragment. Losing those few characters would be a silent truncation of
     * the answer on exactly the paths that already have the least to show.
     */
    const held = think.finish();
    if (held.text) {
      content += held.text;
      await onTextDelta(held.text);
    }
    if (held.reasoning) {
      reasoning += held.reasoning;
      if (onReasoningDelta) await onReasoningDelta(held.reasoning);
    }
    /*
     * A cutoff with nothing to show for it is a different fault from a cutoff with an answer in it,
     * and only one of them is this side's to keep.
     *
     * Nothing generated means nothing was lost and nothing was billed, so it is reported as the
     * provider fault it is - retryable, and the gateway's retry actually engages, because no text
     * reached the caller to be duplicated by a second attempt. Once a single character has been
     * generated the opposite holds on both counts: replaying costs the owner the same quarter of an
     * hour for a request that has already shown how it behaves, and the words are the owner's. So it
     * returns, cut off and labelled, and the caller decides.
     */
    if (cutoff && !content && !reasoning && toolCalls.size === 0)
      throw new GardenError(
        'provider_stream_stalled',
        `${this.provider} accepted the request and then wrote nothing for ${Math.round(budget.elapsedMs() / 1000)} seconds, so the response was abandoned`,
        504
      );
    return {
      ...(model ? { model } : {}),
      ...(generationId ? { id: generationId } : {}),
      ...(upstreamProvider ? { provider: upstreamProvider } : {}),
      generatedChars: budget.characters(),
      ...(failure ? { failure } : {}),
      frames,
      ...(frames === 0 ? { unstreamed } : {}),
      ...(cutoff
        ? { cutoff: { reason: cutoff, detail: describeCutoff(this.provider, cutoff, budget) } }
        : {}),
      choices: [
        {
          /*
           * `length` is what a cut-off answer is called, and two callers read it for two different
           * reasons. One marks a tool call whose JSON stopped mid-object, which is true of every
           * cutoff that assembled one. The other asks the model to carry straight on from where it
           * stopped, and repeats that up to three times - which is the right answer for a long
           * reply that ran out of room and precisely the wrong one for a route that has stopped
           * being productive, where it buys the same ten minutes over again and ends up cut off
           * anyway. So the second reading is only claimed when the rate says continuing can finish
           * the answer; otherwise this is an ordinary stop and what was written stands where it is.
           */
          ...(cutoff
            ? {
                finish_reason:
                  toolCalls.size > 0 || worthContinuing(cutoff, budget) ? 'length' : 'stop'
              }
            : finishReason
              ? { finish_reason: finishReason }
              : {}),
          message: {
            content,
            ...(reasoning ? { reasoning } : {}),
            ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
            ...(annotations.length ? { annotations } : {}),
            ...(toolCalls.size
              ? {
                  tool_calls: [...toolCalls.entries()]
                    .sort(([a], [b]) => a - b)
                    .map(([, call]) => call)
                }
              : {})
          }
        }
      ],
      ...(usage ? { usage } : {})
    };
  }
}
