import { OpenAICompatibleAdapter, type CompatibleAdapterOptions } from './openai-compatible.js';
import { isNativeOpenAIEndpoint } from './openai-media-catalog.js';
import { OpenAIResponsesAdapter } from './openai-responses.js';
import { vendorFetch } from './vendors.js';

/**
 * Endpoint identity selects a protocol; a provider label alone cannot redirect a connection.
 *
 * OpenAI's own endpoint speaks Responses. Every other route speaks chat completions through one
 * adapter, with the vendor's transport underneath it: Anthropic's endpoint through the Messages
 * bridge, strict vendors through a fetch that leaves out the fields they refuse. @see vendors.ts
 */
export function createModelAdapter(options: CompatibleAdapterOptions) {
  if (isNativeOpenAIEndpoint(options.baseUrl)) return new OpenAIResponsesAdapter(options);
  const transport = vendorFetch(options.baseUrl, options.fetch);
  return new OpenAICompatibleAdapter({ ...options, ...(transport ? { fetch: transport } : {}) });
}
