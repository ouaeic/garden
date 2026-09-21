import type { ServerToolUse, WebCitation } from '@athanor/contracts';
import { z } from 'zod';
import type { GenerationCutoff } from './generation-budget.js';
import { ReasoningEffort, ReasoningOptions } from './reasoning.js';
import { NativeContinuation } from './native-continuation.js';
import { NativeInputPart } from './native-input.js';

export const ModelMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  images: z.array(z.string()).optional(),
  nativeInputs: z.array(NativeInputPart).max(4).optional(),
  reasoning: z.string().optional(),
  reasoningDetails: z.array(z.unknown()).optional(),
  nativeContinuation: NativeContinuation.optional(),
  /** Generated numerical budget feedback, not task content; it need not survive native replay. */
  ephemeralNotice: z.boolean().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
        /**
         * Present because a caller storing a turn stores the `ModelToolCall` it was handed, and on
         * a call whose arguments would not parse that object carries the raw string as well - see
         * the note on `ModelToolCall.rawArguments` below. Declared here so the shape describes what
         * is actually held in a stored message rather than the subset that goes back on the wire:
         * the window is *measured* from these objects, and a field the type denied existed was
         * charging turns for bytes no provider would ever be sent. Nothing here serialises it into
         * a request - the payload builder writes `id`, `name` and `arguments` and reads nothing
         * else - so this is a description of what a caller holds, never an instruction to send it.
         */
        rawArguments: z.string().optional()
      })
    )
    .optional(),
  /**
   * Marks the end of a byte-stable prompt prefix. Routes that bill explicit cache breakpoints
   * (currently Anthropic and Google through OpenRouter) receive a `cache_control` marker here.
   * Routes that cache automatically ignore the hint, so it is always safe to set.
   */
  cacheBreakpoint: z.boolean().optional(),
  /**
   * Set by the owner-window bound when it truncated this message, so a later pass can tell a
   * message the harness cut from one that merely talks about being cut.
   *
   * It was a content test - the middle of the marker, searched for in the message body - and a
   * content test cannot tell those apart. The phrase appears in this repository's own test files,
   * so pasting athanor's source into athanor made a message uncuttable: two windows differing by
   * fifty-nine characters dropped nothing and then dropped thirty-six messages, taking 468,530
   * characters of the owner's corrections with them. Owner-authored text was being trusted as a
   * category when the fact wanted was about its source.
   *
   * Like `rawArguments` above, this describes what a caller holds and is never sent: the payload
   * builder writes role, content and tool fields and reads nothing else.
   */
  ownerCut: z.boolean().optional()
});
export type ModelMessage = z.infer<typeof ModelMessage>;

export const ModelTool = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown())
});
export type ModelTool = z.infer<typeof ModelTool>;

/**
 * A tool the provider runs on its own infrastructure rather than one this client implements.
 *
 * It is a separate field from `tools` because it is a different kind of thing on the wire and a
 * different kind of thing in the product: a function tool is a name the model calls and this box
 * answers, and a server tool is a name the provider answers without the request ever coming back
 * here. Keeping the two in one array would have made "which of these disclose the query to a third
 * party" a matter of inspecting each entry's shape, on the one decision where that must never be a
 * guess. Which tools may travel here is not this package's decision: `resolveWebToolPlan` in
 * @athanor/contracts is the only thing that answers it, and the adapter refuses a request that
 * contradicts it.
 */
export const ModelServerTool = z.object({
  type: z.string().min(1),
  parameters: z.record(z.string(), z.unknown())
});
export type ModelServerTool = z.infer<typeof ModelServerTool>;

export const ModelRequest = z.object({
  model: z.string(),
  inputModalities: z.array(z.enum(['text', 'image', 'audio', 'video'])).optional(),
  nativeInputRequestId: z.string().max(200).optional(),
  nativeInputCredentialBinding: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  nativeInputMaxPrice: z
    .object({ prompt: z.number().nonnegative(), completion: z.number().nonnegative() })
    .optional(),
  /** Exact text routing ceilings; providers must honor every requested generation parameter. */
  textPriceCeiling: z
    .object({
      prompt: z.number().finite().nonnegative(),
      completion: z.number().finite().nonnegative(),
      request: z.literal(0)
    })
    .optional(),
  /**
   * How to choose between the companies serving this model, in the aggregator's own fields.
   *
   * It serves one model from several independent operators at different prices and wildly
   * different speeds, and given no preference it picks among the cheapest weighted by the inverse
   * square of price - the wrong objective for an agent, whose turn is dozens of sequential calls.
   * Both fields are applied by the aggregator against figures taken across every request it has
   * ever served, and neither is readable from outside. @see providerPreferences in core, which
   * turns the owner's rule into them.
   *
   * `preferred_min_throughput` deprioritises rather than excludes, so it can never be the reason a
   * request fails.
   */
  providerPreferences: z
    .object({
      sort: z.enum(['price', 'throughput']).optional(),
      preferred_min_throughput: z.number().positive().optional(),
      ignore: z.array(z.string().min(1)).max(30).optional()
    })
    .optional(),
  nativeInputCreditLimit: z.number().nonnegative().optional(),
  nativeInputApprovedCostUsd: z.number().finite().nonnegative().optional(),
  messages: z.array(ModelMessage).min(1),
  tools: z.array(ModelTool).default([]),
  /**
   * Optional rather than defaulted, so a caller that has no business with provider-side tools -
   * which is every caller on a zero-retention route - says nothing about them at all.
   */
  serverTools: z.array(ModelServerTool).readonly().optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().max(262_144).optional(),
  /**
   * The most the route will write in one response, from the catalogue. `maxTokens` is clamped to it
   * rather than sent past it, because a route that rejects the number answers nothing at all.
   */
  maxOutputTokens: z.number().int().positive().optional(),
  reasoningEffort: ReasoningEffort.optional(),
  reasoningOptions: ReasoningOptions.optional(),
  /**
   * Whether the route accepts a reasoning effort. Left unset the effort is sent, which is what every
   * caller has always done; an explicit `false` withholds it, so a route that does not understand
   * the parameter is not asked to honour it.
   */
  supportsReasoningEffort: z.boolean().optional(),
  /**
   * How the route caches a repeated prefix, decided from the catalogue's pricing. Left unset the
   * adapter falls back to reading the slug, which cannot see past a vendor prefix.
   */
  promptCacheStyle: z.enum(['explicit', 'automatic', 'none']).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  onTextDelta: z
    .custom<(delta: string) => void | Promise<void>>((value) => typeof value === 'function')
    .optional(),
  /**
   * The reasoning as it arrives, on routes that produce any. Already parsed off the stream and
   * accumulated; this hands it out rather than keeping it until the response is complete, which is
   * the difference between watching a model think and watching a spinner.
   */
  onReasoningDelta: z
    .custom<(delta: string) => void | Promise<void>>((value) => typeof value === 'function')
    .optional(),
  signal: z.custom<AbortSignal>().optional()
});
export type ModelRequest = z.infer<typeof ModelRequest>;

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Set when the model's arguments would not parse, which in practice means the response was cut
   * off mid-JSON at the output cap. The call is carried rather than dropped so the loop can answer
   * it - a tool call with no tool result is a malformed turn - but `arguments` is empty and must
   * never be executed. The raw string is kept for the message that explains the refusal.
   */
  parseFailed?: true;
  /** True only when the provider says it stopped at the output limit; otherwise the JSON was bad. */
  argumentsTruncated?: true;
  /**
   * `| undefined` spelt out under `exactOptionalPropertyTypes`, so a call read back off a stored
   * `ModelMessage` is assignable here. Zod infers an optional field as `string | undefined` and this
   * interface is the target those objects are handed to; without it the two descriptions of one
   * object disagreed, and the disagreement is what a caller has to cast its way around.
   */
  rawArguments?: string | undefined;
}

export interface ModelResponse {
  /** Native spend is already settled or held durably; the step must not create a second charge. */
  nativeInputUsageRecorded?: boolean;
  /** Local accounting receipt; never sent to a provider or accepted from model output. */
  codingReservationId?: string;
  /**
   * The answer, and only the answer.
   *
   * A route that writes its deliberation between `<think>` tags inside the completion has it taken
   * out here and put in `reasoning`, because no caller can tell thinking from prose after the fact:
   * published as text it goes onto the owner's timeline, is stored as the assistant's own prior
   * turn, and is handed back to the model on every later step as something it already said.
   */
  text: string;
  /**
   * Everything the route produced that is not the answer, whichever of the three ways it said so:
   * `reasoning`, `reasoning_content`, or a leading `<think>…</think>` span inside the completion.
   * The adapter normalises all three; nothing downstream should have to know which arrived.
   */
  reasoning?: string;
  reasoningDetails?: unknown[];
  nativeContinuation?: NativeContinuation;
  toolCalls: ModelToolCall[];
  /**
   * The sources a provider-side tool grounded this answer in, when it attached any.
   *
   * Absent rather than empty when there are none, because that is every response on every in-house
   * route and a field on all of them would say nothing. It is stronger evidence than a tool call
   * id: a citation is the provider reporting a page it fetched, where a tool call id is the model
   * reporting that it asked for one. Nothing here is trusted content - a cited page is a page an
   * attacker can write - so it is evidence of provenance and never of truth.
   */
  citations?: WebCitation[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'cancelled' | 'error';
  /**
   * Present when this side ended the generation rather than the model finishing it: the stream went
   * quiet, ran past its deadline, or wrote past the ceiling the request asked for.
   *
   * The text, the reasoning and any tool call fragments are still in the response. That is the whole
   * point of the field. The tokens were spent whether or not anyone ever saw them, and a turn that
   * generated for a quarter of an hour and handed back an exception is the owner paying for work
   * and receiving an error.
   *
   * `finishReason` beside it is `length` only where carrying the answer on can actually finish it -
   * where the route was writing at a rate that says it had more to say rather than that it had
   * stopped saying anything. Where it was not, the reason is `stop`: what was written stands, and
   * the caller treats it as the end of an answer rather than asking a route that has run out of
   * momentum for the rest of it three more times at ten minutes a go. Either way this field is the
   * one that says the generation was ended here rather than by the model, and what ended it.
   */
  truncated?: { reason: GenerationCutoff; detail: string };
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd?: number;
    /**
     * Set when the counts here were worked out from the text rather than reported by the provider.
     *
     * A streamed request asks for usage and the route sends it in a final frame, which a stream that
     * was cut off never reaches - so a generation that ran for fifteen minutes recorded zero tokens
     * and zero cost, which is precisely what the owner saw and asked about. An estimate from the
     * characters actually generated is wrong by some percentage; zero is wrong by all of it.
     * `inputTokens` is not estimated here and stays zero: this side never saw the prompt.
     */
    estimated?: true;
    /** Input tokens the provider served from its prompt cache, billed at a reduced read rate. */
    cachedInputTokens?: number;
    /** Input tokens the provider charged to populate a new cache entry. */
    cacheWriteTokens?: number;
    /**
     * Provider-side tool calls this response spent, under the provider's own counter names. Billed
     * per request rather than per token, so it is the one part of a step's cost that the token
     * counts cannot account for.
     */
    serverToolUse?: ServerToolUse;
  };
  metadata: {
    provider: string;
    model: string;
    revision?: string;
    latencyMs: number;
    /**
     * Milliseconds until the model produced its first token, on a streamed turn. Published latency
     * for these routes is null everywhere it can be observed, so this is the measurement athanor
     * can actually make: over the owner's network, from the owner's box, on the owner's prompts.
     * Absent on a non-streamed turn, where there is no first token to time.
     */
    timeToFirstTokenMs?: number;
    privacyRoute: string;
    upstreamProvider?: string;
    /**
     * The aggregator's own handle on this generation, for asking it afterwards how the request
     * actually went. Its generation-stats route reports `generation_time`, the completion tokens
     * and the serving company - all its own measurements - and tokens over time is the per-endpoint
     * throughput figure it declares nowhere else. @see fetchGenerationThroughput.
     */
    generationId?: string;
  };
}

export interface ModelAdapter {
  readonly provider: string;
  readonly privacyRoute: string;
  list(signal?: AbortSignal): Promise<ProviderModel[]>;
  chat(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * A model a configured provider says it serves.
 *
 * It carried `sizeBytes` and `modifiedAt` for a local-weights arrangement this product does not
 * have: no adapter has ever set either, nothing has ever read either, and a catalogue field that
 * exists on neither side of the wire is an invitation to write code against a fact nobody supplies.
 */
export interface ProviderModel {
  id: string;
  provider: string;
  revision: string;
}
