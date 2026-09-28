/**
 * The seam that puts a REAL model where `evals/harness.ts`'s script is, through garden's own
 * gateway - and the meter that says what the turn cost.
 *
 * WHY THIS FILE EXISTS. `score.ts` drives a real `AgentWorker` against a real box and scores it
 * with a command run in that box, and its own header says the one thing in it that is not real is
 * the model: `task.ts` writes the replies, so a run is billed nothing and its score says only that
 * the wire carries work end to end. Nothing here changes any of that machinery. What it changes is
 * where the reply comes from: `OpenAICompatibleAdapter`, through `ModelGateway`, against a
 * provider key the environment already holds for the worker.
 *
 * WHAT IS REAL AND WHAT IS NOT, before any number below is read:
 *
 *   real - the request. It is garden's OWN assembled body - the same messages, the same tool
 *          catalogue, the same cache markers the worker's adapter just built - taken off the wire
 *          rather than composed here. See `attach` for why it has to be taken and not composed.
 *   real - the client. `ModelGateway` and `OpenAICompatibleAdapter` are the objects the worker
 *          process runs, with their retry policy, their generation budget and their usage parsing.
 *   real - the money. Every figure in `ProviderTotals` is copied out of `ModelResponse.usage`,
 *          which is the frame the route sent. Nothing here multiplies tokens by a price.
 *   NOT  - the reply's shape on the way back in. A `ModelTurn` carries text, tool calls and a
 *          truncation flag and nothing else, so the reasoning channel is dropped between the real
 *          response and the harness's fabricated frames. A fixture about reasoning cannot be
 *          scored through this seam.
 *   NOT  - the cost line the WORKER records. `evals/harness.ts` fabricates the usage frame it
 *          hands back, so `apps/worker`'s own `cost` event prices this turn from the harness's
 *          four-characters-to-the-token estimate. The provider's own figures are here, in
 *          `totals()`, and a benchmark row must take its spend from here and from nowhere else.
 *
 * THE GAP THAT DECIDED THE DESIGN. A `ModelScript` is handed a `ScriptContext`, and a
 * `ScriptContext` carries message CONTENTS as bare strings: no roles, no tool calls, no tool
 * results and - the one that settles it - no tool catalogue. A script is all a fixture needs,
 * because a script already knows what it means to say. A model needs the window. Reconstructing
 * one from `ScriptContext` would mean sending a real provider a conversation with no tools on
 * offer and no call any tool result belongs to; it would answer in prose, every task would score
 * zero, and the rig would report that as garden's number. So this file does not reconstruct: it
 * reads the request the worker's own adapter put on the wire, and it REFUSES rather than send a
 * degraded one (see `script`).
 *
 * `runFixture` publishes no seam for that - `Fixture.workspaceUrl`'s own note records the author
 * hitting the same wall for the runner and closing it by adding a field to `evals/harness.ts` -
 * and this file may not edit that file. `attach` is the smallest thing that reaches it without
 * one, and it is explicit, reversible, and the caller's decision rather than an import side effect.
 *
 * NOTHING HERE RUNS BY ACCIDENT. `providerDriver` throws unless a provider key is in the
 * environment, a model id is named and both ceilings are given; no module-level code touches the
 * network; `provider.test.ts` supplies its own `fetch` and never a key. No existing file imports
 * this one, so `pnpm check` cannot reach a provider through it.
 */
import { ModelGateway } from '../../packages/model-gateway/src/gateway.js';
import { OpenAICompatibleAdapter } from '../../packages/model-gateway/src/openai-compatible.js';
import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelTool
} from '../../packages/model-gateway/src/protocol.js';
import type { ModelScript, ModelTurn, ScriptContext } from '../harness.js';

/* -------------------------------------------------------------------------------- the credential */

/**
 * Where the key comes from, in the order `apps/worker/src/agent.ts:460` reads it.
 *
 * `#inferenceCredential` prefers a credential the owner saved through the settings page and falls
 * back to `this.config.AI_API_KEY ?? this.config.OPENROUTER_API_KEY`. A benchmark run has no owner
 * and no store worth reading, so the environment half is the whole of it - and it is READ IN THAT
 * ORDER rather than in a nicer one, because a box configured with both must send a benchmark to
 * the same route it sends the owner's work to. Declared in `packages/contracts/src/env.ts` and
 * again in `apps/worker/src/config.ts`, both of which turn an empty string into absent.
 */
export const PROVIDER_KEY_VARIABLES = ['AI_API_KEY', 'OPENROUTER_API_KEY'] as const;

export type ProviderKeyVariable = (typeof PROVIDER_KEY_VARIABLES)[number];

export interface ProviderCredential {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Which variable answered, so a run can print the route it took without printing the secret. */
  readonly variable: ProviderKeyVariable;
  readonly provider: 'openrouter' | 'openai-compatible';
  readonly enforceZeroDataRetention: boolean;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** `''` is absent, which is what both env schemas already say with a `z.preprocess`. */
const present = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim() !== '' ? value : undefined;

/**
 * The credential this run would use, or `null` if the environment holds none.
 *
 * Every default here is the worker's own default rather than a plausible one:
 * `AI_BASE_URL` and `AI_PROVIDER` from `apps/worker/src/config.ts`, and `AI_REQUIRE_ZDR` which
 * defaults to on. Zero retention is applied only on the OpenRouter route, which is the same
 * condition `AgentWorker.#gateway` applies it under - a custom endpoint is sent no `provider`
 * block at all, because the block is OpenRouter's routing vocabulary and a route that does not
 * know it may reject the request.
 */
export const providerCredential = (env: Environment = process.env): ProviderCredential | null => {
  const apiKey = present(env.AI_API_KEY) ?? present(env.OPENROUTER_API_KEY);
  if (apiKey === undefined) return null;
  const variable: ProviderKeyVariable = present(env.AI_API_KEY)
    ? 'AI_API_KEY'
    : 'OPENROUTER_API_KEY';
  const provider = env.AI_PROVIDER === 'openai-compatible' ? 'openai-compatible' : 'openrouter';
  return {
    baseUrl: present(env.AI_BASE_URL) ?? 'https://openrouter.ai/api/v1',
    apiKey,
    variable,
    provider,
    enforceZeroDataRetention: provider === 'openrouter' && env.AI_REQUIRE_ZDR !== 'false'
  };
};

/* ------------------------------------------------------------------------------------ the bounds */

export interface ProviderBounds {
  /**
   * The most provider calls this driver will make across every task it is given.
   *
   * Counted per CALL and not per step, because a step is not one call: a compaction's brief, a
   * vision handoff and a delegated specialist's own steps each bill separately, and a ceiling that
   * counted steps would be quoted a number the invoice does not use.
   */
  readonly maxCalls: number;
  /**
   * The most the provider's own figures may add up to before this driver stops sending.
   *
   * Checked against `ProviderTotals.costUsd`, which is a sum of what the route reported. A route
   * that reports no cost therefore never advances this ceiling - see `ProviderTotals.unpricedCalls`,
   * which is the number that says so, and `maxCalls`, which is the ceiling that still bites.
   */
  readonly maxSpendUsd: number;
}

export interface ProviderTotals {
  readonly calls: number;
  readonly inputTokens: number;
  /** Of `inputTokens`, the part the route served from its prompt cache. */
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /**
   * Calls the route priced at nothing because it reported no cost at all.
   *
   * Kept apart from `calls` and never filled in from a price table. A benchmark row whose spend
   * came from multiplying tokens by a published rate is a row that reports what garden believes
   * the model costs, and the point of measuring on the wire is that those two numbers disagree -
   * over cache reads, over a provider's own routing, over a discount nobody's table has. If this
   * is non-zero the honest reading of `costUsd` is "at least this much".
   */
  readonly unpricedCalls: number;
  /**
   * Calls whose token counts the gateway worked out from the text because the route sent no usage
   * frame - a stream that was cut before its last frame. @see `ModelResponse.usage.estimated`.
   */
  readonly estimatedCalls: number;
}

export interface ProviderStop {
  readonly bound: 'calls' | 'spend';
  /** What to print. Carries both figures, because a ceiling report that omits either is a mystery. */
  readonly detail: string;
  /** How many calls had been made when it bit. */
  readonly atCall: number;
}

const EMPTY_TOTALS: ProviderTotals = {
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
  estimatedCalls: 0
};

/* ------------------------------------------------------------- reading an untyped request body */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

interface DecodedContent {
  readonly content: string;
  readonly images: readonly string[];
  readonly cacheBreakpoint: boolean;
}

/**
 * One message's content, whichever of the two shapes the adapter chose.
 *
 * A message the context layer marked as a cache breakpoint, and any message carrying an image,
 * travels as a block array rather than as a string - so reading `content` as a string alone drops
 * exactly the messages garden considers most important. The same trap `evals/harness.ts`'s
 * `contentOf` documents, on the same bodies.
 */
const decodeContent = (raw: unknown): DecodedContent => {
  if (typeof raw === 'string') return { content: raw, images: [], cacheBreakpoint: false };
  if (!Array.isArray(raw)) return { content: '', images: [], cacheBreakpoint: false };
  const texts: string[] = [];
  const images: string[] = [];
  let cacheBreakpoint = false;
  for (const entry of raw) {
    const block = asRecord(entry);
    if (!block) continue;
    if (asText(block.type) === 'image_url') {
      const url = asText(asRecord(block.image_url)?.url);
      if (url) images.push(url);
      continue;
    }
    texts.push(asText(block.text));
    if (asRecord(block.cache_control)) cacheBreakpoint = true;
  }
  return { content: texts.join(''), images, cacheBreakpoint };
};

const decodeToolCalls = (raw: unknown): ModelMessage['toolCalls'] => {
  if (!Array.isArray(raw)) return undefined;
  const calls = raw.flatMap((entry) => {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    if (!call || !fn) return [];
    // A stored call keeps its raw string when the model's JSON would not parse; the payload builder
    // writes `arguments` from the parsed object, so an unparseable one here means the assistant
    // turn being replayed was already malformed. Carried as an empty object rather than dropped:
    // a tool call with no matching result is a window a route will refuse.
    let args: Record<string, unknown> = {};
    try {
      args = asRecord(JSON.parse(asText(fn.arguments))) ?? {};
    } catch {
      args = {};
    }
    return [{ id: asText(call.id), name: asText(fn.name), arguments: args }];
  });
  return calls.length ? calls : undefined;
};

const decodeMessages = (raw: unknown): ModelMessage[] => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const message = asRecord(entry);
    if (!message) return [];
    const role = asText(message.role);
    if (!ROLES.has(role)) return [];
    const { content, images, cacheBreakpoint } = decodeContent(message.content);
    const toolCalls = decodeToolCalls(message.tool_calls);
    return [
      {
        role: role as ModelMessage['role'],
        content,
        ...(images.length ? { images: [...images] } : {}),
        ...(cacheBreakpoint ? { cacheBreakpoint: true } : {}),
        ...(asText(message.tool_call_id) ? { toolCallId: asText(message.tool_call_id) } : {}),
        ...(asText(message.reasoning) ? { reasoning: asText(message.reasoning) } : {}),
        ...(toolCalls ? { toolCalls } : {})
      }
    ];
  });
};

/**
 * The function tools on the request, and only those.
 *
 * A provider-side tool travels in the same `tools` array on the wire and is a different kind of
 * thing entirely - a name the provider answers without the request ever coming back to this box.
 * Which of those may be sent is not this rig's decision to make: `resolveWebToolPlan` in
 * @garden/contracts is the only thing that answers it, and it answers per task from the owner's
 * settings. So they are counted and left off, and the count travels into the run's report rather
 * than being silently dropped. On a bench run there are none - `evals/harness.ts` pins
 * `AI_FORCE_INHOUSE_WEB: true` - and this exists so that if that ever changes, the number moves
 * instead of the meaning.
 */
const decodeTools = (raw: unknown): { tools: ModelTool[]; serverToolsDropped: number } => {
  if (!Array.isArray(raw)) return { tools: [], serverToolsDropped: 0 };
  const tools: ModelTool[] = [];
  let serverToolsDropped = 0;
  for (const entry of raw) {
    const tool = asRecord(entry);
    const fn = asRecord(tool?.function);
    if (!tool) continue;
    if (asText(tool.type) !== 'function' || !fn) {
      serverToolsDropped += 1;
      continue;
    }
    tools.push({
      name: asText(fn.name),
      description: asText(fn.description),
      parameters: asRecord(fn.parameters) ?? {}
    });
  }
  return { tools, serverToolsDropped };
};

/**
 * The model id as the route wants it, from the id a release carries.
 *
 * A release is `openrouter/<providerModelId>` (`openrouter-catalog.ts:1038`) or `custom/<id>`, and
 * the route is sent the second half. Given a bare slug this leaves it alone, so both
 * `openrouter/z-ai/glm-5.3-flash` and `z-ai/glm-5.3-flash` name the same model.
 */
export const providerModelIdOf = (releaseId: string): string => {
  const [head, ...rest] = releaseId.split('/');
  return rest.length && (head === 'openrouter' || head === 'custom') ? rest.join('/') : releaseId;
};

/* -------------------------------------------------------------------------------- the driver */

export interface ProviderDriverOptions {
  /** The release id, e.g. `openrouter/z-ai/glm-5.3-flash`. @see `providerModelIdOf`. */
  readonly model: string;
  readonly bounds: ProviderBounds;
  /** Defaults to `process.env`. `provider.test.ts` passes its own so no key can be picked up. */
  readonly env?: Environment;
  /**
   * The wire. Defaults to whatever `globalThis.fetch` is when `attach` runs, which is the real one
   * - `runFixture` installs its stub AFTER this, and the adapter is handed this value rather than
   * reading the global, so the provider call cannot be answered by the harness's own stub.
   */
  readonly fetch?: typeof fetch;
  /** Named on every request, as `AgentWorker` names it. Only used for the referer headers. */
  readonly appUrl?: string;
}

export interface ProviderDriver {
  /**
   * The model, in the shape `evals/harness.ts` accepts: `ModelScript`.
   *
   * It hands back the turn the real model just produced. It does not call the provider itself -
   * by the time `runFixture` reaches it the answer is already in hand, which is the only reason a
   * synchronous seam can carry an asynchronous provider at all. @see `attach`.
   */
  readonly script: ModelScript;
  /** The release id this driver was built for, for the row's `model` column. */
  readonly model: string;
  /** The provider's own figures, summed. Never a price table. */
  totals(): ProviderTotals;
  /** The ceiling that stopped this driver, or `null` if neither has. */
  stopped(): ProviderStop | null;
  /** Provider-side tools left off a request. @see `decodeTools`. */
  serverToolsDropped(): number;
  /** Puts this driver on the wire. Must be called BEFORE `runFixture`. */
  attach(): void;
  /** Takes it off again, restoring whatever `globalThis.fetch` was when `attach` ran. */
  detach(): void;
}

/** Marks a request this driver has already seen, so the harness's own forward cannot loop. */
const FORWARDED = Symbol('garden.bench.provider.forwarded');

const isForwarded = (init: RequestInit | undefined): boolean =>
  init !== undefined && FORWARDED in (init as Record<PropertyKey, unknown>);

const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString();

/**
 * A driver, built and metered.
 *
 * Throws rather than degrades on every missing precondition, because the failure this guards
 * against is a run that reports a number nobody paid for. No key is the loudest of them: it is the
 * one that makes "off by default" true rather than intended.
 */
export const providerDriver = (options: ProviderDriverOptions): ProviderDriver => {
  const credential = providerCredential(options.env ?? process.env);
  if (!credential)
    throw new Error(
      `No provider key: set ${PROVIDER_KEY_VARIABLES.join(' or ')} in the environment. This rig calls a real provider and bills a real account, so it does not start without one.`
    );
  if (!options.model.trim())
    throw new Error('A model id is required: this driver names no default.');
  const { maxCalls, maxSpendUsd } = options.bounds;
  if (!Number.isInteger(maxCalls) || maxCalls <= 0)
    throw new Error(`maxCalls must be a positive integer; got ${String(maxCalls)}.`);
  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0)
    throw new Error(
      `maxSpendUsd must be a positive number of dollars; got ${String(maxSpendUsd)}.`
    );

  const providerName = credential.provider === 'openrouter' ? 'openrouter' : 'custom';
  const providerModelId = providerModelIdOf(options.model);

  let totals: ProviderTotals = EMPTY_TOTALS;
  let stop: ProviderStop | null = null;
  let serverToolsDropped = 0;
  /** The turn the wrapper has just fetched, waiting for the `script` call that will take it. */
  let pending: ModelTurn | null = null;

  let attached = false;
  let wireFetch: typeof fetch | null = null;
  let innerFetch: typeof fetch | null = null;
  let gateway: ModelGateway | null = null;

  const record = (usage: ModelResponse['usage']): void => {
    totals = {
      calls: totals.calls + 1,
      inputTokens: totals.inputTokens + usage.inputTokens,
      cachedInputTokens: totals.cachedInputTokens + (usage.cachedInputTokens ?? 0),
      outputTokens: totals.outputTokens + usage.outputTokens,
      // `?? 0` and a counter beside it, never an estimate. @see ProviderTotals.unpricedCalls.
      costUsd: totals.costUsd + (usage.costUsd ?? 0),
      unpricedCalls: totals.unpricedCalls + (usage.costUsd === undefined ? 1 : 0),
      estimatedCalls: totals.estimatedCalls + (usage.estimated ? 1 : 0)
    };
  };

  /** The ceiling, asked before a call is sent. Returns the turn to hand back instead, or `null`. */
  const ceilingHit = (): ModelTurn | null => {
    if (stop === null && totals.calls >= maxCalls)
      stop = {
        bound: 'calls',
        atCall: totals.calls,
        detail: `the benchmark call ceiling stopped this run: ${String(totals.calls)} provider calls made, ${String(maxCalls)} allowed`
      };
    if (stop === null && totals.costUsd >= maxSpendUsd)
      stop = {
        bound: 'spend',
        atCall: totals.calls,
        detail: `the benchmark spend ceiling stopped this run: $${totals.costUsd.toFixed(4)} spent over ${String(totals.calls)} provider calls, $${maxSpendUsd.toFixed(4)} allowed`
      };
    if (stop === null) return null;
    // Plain text and no tool call, so the loop ends the turn rather than being handed a `finish`
    // this driver has no evidence for. It travels into the transcript, which is where a reader
    // asking why a task scored zero will look first.
    return { text: `[bench] ${stop.detail}. No further model call was made.` };
  };

  const turnFrom = (response: ModelResponse): ModelTurn => ({
    ...(response.text ? { text: response.text } : {}),
    ...(response.toolCalls.length
      ? {
          calls: response.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            args: call.arguments
          }))
        }
      : {}),
    // `framesFor` writes `finish_reason: 'length'` from this, which is what the loop's output-limit
    // hold reads. The other cutoffs the gateway reports arrive as `stop` and are indistinguishable
    // here, because a `ModelTurn` has nowhere to put them.
    ...(response.finishReason === 'length' ? { truncated: true } : {})
  });

  const requestFrom = (
    body: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): ModelRequest => {
    const { tools, serverToolsDropped: dropped } = decodeTools(body.tools);
    serverToolsDropped += dropped;
    const messages = decodeMessages(body.messages);
    const maxTokens = asFiniteNumber(body.max_tokens) ?? asFiniteNumber(body.max_completion_tokens);
    const effort = asText(asRecord(body.reasoning)?.effort);
    // Whether garden decided this route bills explicit breakpoints is already recorded in the
    // body: a `cache_control` block is only ever written on the `explicit` style. Read back rather
    // than re-derived, so the request that goes out carries the markers the one that came in had.
    // Absent, the adapter falls back to reading the slug, which is its own documented default.
    const marked = messages.some((message) => message.cacheBreakpoint === true);
    return {
      model: providerModelId,
      messages,
      tools,
      temperature: asFiniteNumber(body.temperature) ?? 0.2,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(effort === 'low' || effort === 'medium' || effort === 'high'
        ? { reasoningEffort: effort }
        : {}),
      ...(marked ? { promptCacheStyle: 'explicit' as const } : {}),
      // Streamed, because that is what the worker does and because `stream_options.include_usage`
      // - and therefore every figure in `ProviderTotals` - is only set on a request that streams.
      // The deltas go nowhere: the owner-facing timeline belongs to the worker, and the worker is
      // reading the harness's fabricated frames, not this response.
      onTextDelta: () => undefined,
      ...(signal ? { signal } : {})
    };
  };

  const call = async (
    body: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<ModelTurn> => {
    const refusal = ceilingHit();
    if (refusal) return refusal;
    if (!gateway) throw new Error('The provider driver was used before attach().');
    const response = await gateway.chat(providerName, requestFrom(body, signal));
    record(response.usage);
    return turnFrom(response);
  };

  const wrapper = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const inner = innerFetch;
    const wire = wireFetch;
    if (!inner || !wire) throw new Error('The provider driver was used after detach().');
    /*
     * A request this wrapper has already handled goes straight to the wire, and that one line is
     * what makes every re-entry terminate.
     *
     * TWO of them exist and both are ordinary. `runFixture` saves `globalThis.fetch` at the start
     * of a run - which, with this driver attached, is this wrapper - and calls it again to forward
     * `Fixture.workspaceUrl` traffic to the real socket, so the runner request arrives back here.
     * And between two runs the saved value has been put back, so `innerFetch` IS this wrapper and
     * a request in that window is delegated to it. Unmarked, either one is delegated for ever and
     * the request never leaves the process - a hang, which is the worst shape for a rig to break
     * in. Marked, both take exactly one extra hop and then go out.
     */
    if (isForwarded(init)) return await wire(input, init);
    const forwarded = { ...init, [FORWARDED]: true } as RequestInit;
    const url = urlOf(input);
    const isChat =
      asText(init?.method).toUpperCase() === 'POST' && url.includes('/chat/completions');
    // Matched on the path rather than on the harness's private provider host: a media request and a
    // catalogue request travel to the same origin and neither is a turn. This is also why nothing
    // here restates `PROVIDER_URL` - a constant copied out of `evals/harness.ts` is a constant with
    // two spellings and no test that they agree.
    if (!isChat) return await inner(input, forwarded);
    if (typeof init?.body !== 'string') return await inner(input, forwarded);
    let body: Record<string, unknown> | null = null;
    try {
      body = asRecord(JSON.parse(init.body));
    } catch {
      body = null;
    }
    if (!body) return await inner(input, forwarded);
    // The await that makes the synchronous seam work: `runFixture` calls `fixture.model` from
    // inside its own fetch stub, so the answer has to be in hand before the stub runs. It is,
    // because this is the call the stub is about to answer.
    pending = await call(body, init?.signal ?? undefined);
    try {
      return await inner(input, forwarded);
    } finally {
      // A request the stub refused - a fixture's declared outage - never reaches `fixture.model`,
      // so the turn would otherwise be handed to the NEXT call and answer the wrong window.
      pending = null;
    }
  }) as typeof fetch;

  const script = (context: ScriptContext): ModelTurn => {
    const turn = pending;
    pending = null;
    if (turn) return turn;
    // Never a fabricated reply. A `ScriptContext` has no roles, no tool calls and no catalogue, so
    // anything composed here would be a different conversation from the one garden assembled, and
    // the score would belong to it. @see this file's header.
    throw new Error(
      `The provider driver was asked for step ${String(context.step)} (call ${String(context.index)}) with no answer in hand. attach() must run before runFixture, and only a request this driver forwarded can be answered: a ScriptContext carries no tool catalogue, so there is nothing honest to send.`
    );
  };

  return {
    script,
    model: options.model,
    totals: () => totals,
    stopped: () => stop,
    serverToolsDropped: () => serverToolsDropped,
    attach: (): void => {
      if (attached) throw new Error('The provider driver is already attached.');
      attached = true;
      // Unbound, exactly as `evals/harness.ts` saves and calls it: a bound copy is a different
      // function object, and `detach` puts back what it found rather than a copy of it.
      wireFetch = options.fetch ?? globalThis.fetch;
      innerFetch = wireFetch;
      gateway = new ModelGateway().register(
        providerName,
        new OpenAICompatibleAdapter({
          baseUrl: credential.baseUrl,
          apiKey: credential.apiKey,
          provider: providerName,
          // The two values `configured-catalog.ts:102` derives from the same flag. A row that says
          // `provider_zdr` and a request that did not ask for it is the one pair worth writing out.
          privacyRoute: credential.enforceZeroDataRetention ? 'provider_zdr' : 'external',
          appUrl: options.appUrl ?? 'http://localhost:5173',
          appTitle: 'garden',
          enforceZeroDataRetention: credential.enforceZeroDataRetention,
          // The wire, captured before `runFixture` replaces the global. The adapter would otherwise
          // read `globalThis.fetch` at construction and a driver built late would send garden's
          // request to garden's own stub, which answers it for nothing and looks like a free run.
          fetch: wireFetch
        })
      );
      /*
       * A property, not an assignment.
       *
       * `runFixture` overwrites `globalThis.fetch` for the duration of a run and restores it in a
       * `finally`, so a wrapper merely assigned here is gone by the first request. An accessor
       * survives both: the setter keeps whatever the harness installs, the getter keeps handing out
       * this wrapper, and every request the loop makes passes through here on its way to the stub.
       * Nothing about the stub changes - it still counts the call, prices the prompt, measures the
       * prefix and calls `fixture.model` - so every number `runFixture` reports is the number it
       * always reported.
       */
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        enumerable: true,
        get: () => wrapper,
        set: (value: typeof fetch) => {
          innerFetch = value;
        }
      });
    },
    detach: (): void => {
      if (!attached) return;
      attached = false;
      // `runFixture`'s `finally` assigns back the value it saved, which was this wrapper - so the
      // slot now holds the wrapper and restoring it would leave the trap in place with nothing
      // behind it. The wire is what was there before `attach`, and that is what goes back.
      const restored = innerFetch === wrapper || innerFetch === null ? wireFetch : innerFetch;
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: restored
      });
      wireFetch = null;
      innerFetch = null;
      gateway = null;
      pending = null;
    }
  };
};
