/**
 * The edit axis on garden's own wire: a transport built from the worker's gateway.
 *
 * `live.ts` posts to one route with a bare `fetch`, which is right for the general half - it is
 * measuring what an arm carries, and the client is not the thing under test. The edit axis is
 * different: what it measures is whether a model emits a dialect the WORKER will accept, and the
 * worker reaches its model through `ModelGateway` and `OpenAICompatibleAdapter`, with their retry
 * policy, their generation budget and their usage parsing. A row taken through a different client
 * is a row about a different request. So this transport puts those two objects where the bare
 * fetch was, and nothing about the loop that reads the answer changes.
 *
 * The credential and the model id come from `evals/bench/provider.ts` and only from there, so the
 * route a benchmark takes and the route this run takes are decided in one place: `AI_API_KEY` or
 * `OPENROUTER_API_KEY`, in that order, and a release id `openrouter/<slug>` cut down to the slug the
 * route wants. Nothing here touches the network at import time; `gatewayTransport` throws without
 * a key rather than building a transport that cannot send.
 *
 *   OPENROUTER_API_KEY=... pnpm eval:arms -- --edit --live --yes --model openrouter/z-ai/glm-5.3-flash --seeds 3 --edit-json out.json
 */
import { ModelGateway } from '../../packages/model-gateway/src/gateway.js';
import { OpenAICompatibleAdapter } from '../../packages/model-gateway/src/openai-compatible.js';
import type { ModelMessage, ModelTool } from '../../packages/model-gateway/src/protocol.js';
import {
  PROVIDER_KEY_VARIABLES,
  providerCredential,
  providerModelIdOf
} from '../bench/provider.js';
import { MAX_OUTPUT_TOKENS, type Transport, type WireTool } from './live.js';

type Environment = Readonly<Record<string, string | undefined>>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * The loop's messages, which are kept in the wire shape `live.ts` posts, read back into the
 * gateway's own. A tool call's arguments travel as a JSON string on the wire and as an object in
 * a `ModelMessage`; one that will not parse is carried as an empty object rather than dropped,
 * because a call with no result is a window a route refuses.
 */
const decodeMessages = (raw: readonly unknown[]): ModelMessage[] =>
  raw.flatMap((entry) => {
    const message = asRecord(entry);
    if (!message) return [];
    const role = asText(message.role);
    if (!ROLES.has(role)) return [];
    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls.flatMap((one) => {
          const call = asRecord(one);
          const fn = asRecord(call?.function);
          if (!call || !fn) return [];
          let args: Record<string, unknown> = {};
          try {
            args = asRecord(JSON.parse(asText(fn.arguments))) ?? {};
          } catch {
            args = {};
          }
          return [{ id: asText(call.id), name: asText(fn.name), arguments: args }];
        })
      : [];
    return [
      {
        role: role as ModelMessage['role'],
        content: asText(message.content),
        ...(asText(message.tool_call_id) ? { toolCallId: asText(message.tool_call_id) } : {}),
        ...(calls.length ? { toolCalls: calls } : {})
      }
    ];
  });

const decodeTools = (tools: readonly WireTool[]): ModelTool[] =>
  tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }));

/**
 * A transport through the worker's gateway, or a throw naming the variable that was not set.
 *
 * The `apiKey` the loop hands over is ignored on purpose: the credential is resolved here from
 * the same two variables the worker reads, in the same order, so a box configured with both
 * sends this run to the route it sends the owner's work to.
 */
export const gatewayTransport = (env: Environment = process.env): Transport => {
  const credential = providerCredential(env);
  if (!credential)
    throw new Error(
      `No provider key: set ${PROVIDER_KEY_VARIABLES.join(' or ')} in the environment. The edit axis bills a real account and does not start without one.`
    );
  const providerName = credential.provider === 'openrouter' ? 'openrouter' : 'custom';
  const gateway = new ModelGateway().register(
    providerName,
    new OpenAICompatibleAdapter({
      baseUrl: credential.baseUrl,
      apiKey: credential.apiKey,
      provider: providerName,
      privacyRoute: credential.enforceZeroDataRetention ? 'provider_zdr' : 'external',
      appUrl: 'http://localhost:5173',
      appTitle: 'garden',
      enforceZeroDataRetention: credential.enforceZeroDataRetention,
      fetch: globalThis.fetch
    })
  );
  return async (_apiKey, model, messages, tools) => {
    const response = await gateway.chat(providerName, {
      model: providerModelIdOf(model),
      messages: decodeMessages(messages),
      tools: decodeTools(tools),
      temperature: 0,
      maxTokens: MAX_OUTPUT_TOKENS,
      // Streamed, because usage - and therefore every token figure on the row - only arrives on a
      // request that streams. The deltas go nowhere; the row reads the finished response.
      onTextDelta: () => undefined
    });
    // A usage frame the gateway had to estimate is not the provider's figure, and the row is
    // marked unmetered exactly as `live.ts` marks a route that sent none.
    const usage = response.usage.estimated
      ? null
      : {
          prompt_tokens: response.usage.inputTokens,
          completion_tokens: response.usage.outputTokens
        };
    return {
      choice: {
        message: {
          content: response.text || null,
          tool_calls: response.toolCalls.map((call) => ({
            id: call.id,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) }
          }))
        }
      },
      usage
    };
  };
};
