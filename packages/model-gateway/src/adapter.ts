import { OpenAICompatibleAdapter, type CompatibleAdapterOptions } from './openai-compatible.js';
import { isNativeOpenAIEndpoint } from './openai-media-catalog.js';
import { OpenAIResponsesAdapter } from './openai-responses.js';

/** Endpoint identity selects a protocol; a provider label alone cannot redirect a connection. */
export function createModelAdapter(options: CompatibleAdapterOptions) {
  return isNativeOpenAIEndpoint(options.baseUrl)
    ? new OpenAIResponsesAdapter(options)
    : new OpenAICompatibleAdapter(options);
}
