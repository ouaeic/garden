import type { PickerModel } from './ModelPicker.js';

/**
 * Who made a model, and which connection it travels through, are two different questions once more
 * than one provider is connected: the same Claude can arrive through OpenRouter and through an
 * Anthropic key. The picker groups by the first and badges the second.
 *
 * Aggregator slugs name the maker outright; a direct or self-hosted endpoint lists bare model names,
 * so those are read from the family name the model ships under.
 */
const SLUGS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'x-ai': 'xAI',
  xai: 'xAI',
  mistralai: 'Mistral',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  'deepseek-ai': 'DeepSeek',
  qwen: 'Qwen',
  moonshotai: 'Moonshot AI',
  'meta-llama': 'Meta',
  meta: 'Meta',
  cohere: 'Cohere',
  microsoft: 'Microsoft',
  nvidia: 'NVIDIA',
  amazon: 'Amazon',
  'z-ai': 'Z.ai',
  zhipuai: 'Z.ai',
  minimax: 'MiniMax',
  perplexity: 'Perplexity',
  nousresearch: 'Nous Research'
};

const FAMILIES: Array<[RegExp, string]> = [
  [/^claude/, 'Anthropic'],
  [/^(gpt|chatgpt|o[1-9]\b|o[1-9]-|codex|dall-e|whisper|tts-|text-embedding)/, 'OpenAI'],
  [/^(gemini|gemma|imagen|veo)/, 'Google'],
  [/^grok/, 'xAI'],
  [/^(mistral|mixtral|codestral|magistral|devstral|ministral|pixtral|voxtral)/, 'Mistral'],
  [/^deepseek/, 'DeepSeek'],
  [/^(qwen|qwq)/, 'Qwen'],
  [/^(kimi|moonshot)/, 'Moonshot AI'],
  [/^(llama|meta-llama)/, 'Meta'],
  [/^(command|c4ai)/, 'Cohere'],
  [/^phi-/, 'Microsoft'],
  [/^(nemotron|nvidia)/, 'NVIDIA'],
  [/^(glm|chatglm)/, 'Z.ai'],
  [/^minimax/, 'MiniMax']
];

/** The service used for inference, independent of who made the model or named the account. */
export const providerOf = (model: PickerModel): string =>
  model.connectionProvider ||
  (model.provider === 'openrouter'
    ? 'OpenRouter'
    : model.provider === 'ollama-cloud'
      ? 'Ollama Cloud'
      : model.provider === 'custom'
        ? model.connectionLabel || 'Your endpoint'
        : model.provider);

/** The owner-named account, with its service visible when the names differ. */
export const routeOf = (model: PickerModel): string => {
  const provider = providerOf(model);
  return model.connectionLabel && model.connectionLabel !== provider
    ? `${provider} · ${model.connectionLabel}`
    : provider;
};

export const makerOf = (model: PickerModel): string => {
  const parts = model.id.split('/');
  if (model.provider === 'openrouter' && parts.length > 2) {
    const slug = parts[1]!.toLowerCase();
    return SLUGS[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
  }
  // Everything after the connection prefix is the vendor's own id, which may carry an org of its own.
  let own = (model.provider === 'custom' && parts.length > 2 ? parts.slice(2) : parts.slice(-1))
    .join('/')
    .toLowerCase();
  try {
    own = decodeURIComponent(own);
  } catch {
    // A malformed escape is still a usable name to match against.
  }
  own = own.replace(/^accounts\/[^/]+\/models\//, '');
  const [org, ...rest] = own.split('/');
  if (rest.length && SLUGS[org!]) return SLUGS[org!]!;
  const name = rest.length ? rest.join('/') : own;
  return FAMILIES.find(([pattern]) => pattern.test(name))?.[1] ?? routeOf(model);
};

/** A route badge only says something when the catalogue has more than one route in it. */
export const routeCount = (models: readonly PickerModel[]): number =>
  new Set(models.map(routeOf)).size;
