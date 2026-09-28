import { anthropicBridge, isNativeAnthropicEndpoint } from './anthropic-bridge.js';

/**
 * The model companies an owner can connect to directly with their own key.
 *
 * Each is a named connection like any other compatible endpoint - its own credential, its own
 * catalogue rows, its own label in the picker - so several can be connected at once and a model is
 * always sent through the connection that listed it. What a preset adds is knowing the address, the
 * wire protocol and the request fields the vendor refuses, so the owner pastes a key and nothing
 * else. Anthropic speaks its own Messages protocol through `anthropicBridge`; OpenAI's own endpoint
 * is already served by the Responses adapter; the rest speak chat completions.
 */
export interface VendorPreset {
  id: string;
  /** What the owner sees, and the connection's default name. */
  label: string;
  /** The company whose models these are, which is how the picker groups them. */
  maker: string;
  baseUrl: string;
  /** Where the owner creates a key. */
  keyUrl: string;
  /** The context window assumed for a model the vendor's list does not describe. */
  contextTokens: number;
  /**
   * Request fields this endpoint rejects or misreads, removed before the request leaves. The
   * adapter adds some fields for routes that understand them (an aggregator's routing block, a
   * session id, a reasoning effort); a strict endpoint answers an unknown field with a 400.
   */
  drops: readonly string[];
  /** Models on this endpoint that do accept `reasoning_effort`, when the vendor accepts it at all. */
  reasoningModels?: RegExp;
}

export const vendorPresets: readonly VendorPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    maker: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    contextTokens: 200_000,
    drops: []
  },
  {
    id: 'openai',
    label: 'OpenAI',
    maker: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    contextTokens: 128_000,
    drops: []
  },
  {
    id: 'google',
    label: 'Google Gemini',
    maker: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    contextTokens: 1_000_000,
    drops: ['session_id', 'provider'],
    reasoningModels: /gemini-(2\.5|[3-9])/
  },
  {
    id: 'xai',
    label: 'xAI',
    maker: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    contextTokens: 128_000,
    drops: ['session_id', 'provider'],
    reasoningModels: /grok-3-mini/
  },
  {
    id: 'mistral',
    label: 'Mistral',
    maker: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    contextTokens: 128_000,
    drops: ['session_id', 'provider', 'stream_options']
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    maker: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    contextTokens: 64_000,
    drops: ['session_id', 'provider']
  },
  {
    id: 'groq',
    label: 'Groq',
    maker: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    contextTokens: 128_000,
    drops: ['session_id', 'provider', 'stream_options']
  },
  {
    id: 'together',
    label: 'Together AI',
    maker: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    contextTokens: 128_000,
    drops: ['session_id', 'provider']
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    maker: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    contextTokens: 128_000,
    drops: ['session_id', 'provider']
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    maker: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyUrl: 'https://cloud.cerebras.ai',
    contextTokens: 128_000,
    drops: ['session_id', 'provider', 'stream_options']
  },
  {
    id: 'moonshot',
    label: 'Moonshot AI',
    maker: 'Moonshot AI',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    contextTokens: 128_000,
    drops: ['session_id', 'provider']
  },
  {
    id: 'qwen',
    label: 'Alibaba Qwen',
    maker: 'Qwen',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://modelstudio.console.alibabacloud.com',
    contextTokens: 128_000,
    drops: ['session_id', 'provider']
  }
];

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** The preset an endpoint belongs to, decided by its host - never by a label the owner typed. */
export const vendorForEndpoint = (baseUrl: string): VendorPreset | null => {
  const host = hostOf(baseUrl);
  return host ? (vendorPresets.find((preset) => hostOf(preset.baseUrl) === host) ?? null) : null;
};

export const vendorPreset = (id: string | undefined): VendorPreset | null =>
  vendorPresets.find((preset) => preset.id === id) ?? null;

/**
 * A `fetch` that removes the fields a vendor refuses from each chat request, and keeps a
 * reasoning effort only for the models that take one.
 */
export const shapedFetch =
  (preset: VendorPreset, inner: typeof fetch = fetch): typeof fetch =>
  (resource, init = {}) => {
    const url = resource instanceof Request ? resource.url : String(resource);
    if (!url.endsWith('/chat/completions') || typeof init.body !== 'string')
      return inner(resource, init);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return inner(resource, init);
    }
    for (const field of preset.drops) delete body[field];
    if (
      'reasoning_effort' in body &&
      !(
        preset.reasoningModels &&
        preset.reasoningModels.test(typeof body.model === 'string' ? body.model : '')
      )
    )
      delete body.reasoning_effort;
    delete body.reasoning;
    // Replayed deliberation is an aggregator's field; a strict endpoint rejects it on a message.
    if (Array.isArray(body.messages))
      body.messages = (body.messages as unknown[]).map((message) => {
        if (typeof message !== 'object' || message === null) return message;
        const {
          reasoning: _reasoning,
          reasoning_details: _details,
          ...rest
        } = message as Record<string, unknown>;
        return rest;
      });
    return inner(resource, { ...init, body: JSON.stringify(body) });
  };

/** The transport a connection's adapter should use for its endpoint. */
export const vendorFetch = (baseUrl: string, inner?: typeof fetch): typeof fetch | undefined => {
  if (isNativeAnthropicEndpoint(baseUrl)) return anthropicBridge(inner);
  const preset = vendorForEndpoint(baseUrl);
  if (!preset || !preset.drops.length) return inner;
  return shapedFetch(preset, inner);
};
