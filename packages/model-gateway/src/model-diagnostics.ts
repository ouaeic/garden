import { GardenError } from '@garden/core';
import { ModelRequest, type ModelResponse } from './protocol.js';

/** Connection objects, callbacks and abort signals never enter a private request projection. */
export const DiagnosticModelRequest = ModelRequest.omit({
  signal: true,
  onTextDelta: true,
  onReasoningDelta: true
});
export const diagnosticModelResponse = (response: ModelResponse) => ({
  text: response.text,
  ...(response.reasoning === undefined ? {} : { reasoning: response.reasoning }),
  ...(response.reasoningDetails === undefined
    ? {}
    : { reasoningDetails: response.reasoningDetails }),
  ...(response.nativeContinuation === undefined
    ? {}
    : { nativeContinuation: response.nativeContinuation }),
  toolCalls: response.toolCalls,
  ...(response.citations === undefined ? {} : { citations: response.citations }),
  finishReason: response.finishReason,
  ...(response.truncated === undefined ? {} : { truncated: response.truncated }),
  usage: {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    totalTokens: response.usage.totalTokens,
    ...(response.usage.costUsd === undefined ? {} : { costUsd: response.usage.costUsd }),
    ...(response.usage.estimated === undefined ? {} : { estimated: response.usage.estimated }),
    ...(response.usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: response.usage.cachedInputTokens }),
    ...(response.usage.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: response.usage.cacheWriteTokens }),
    ...(response.usage.serverToolUse === undefined
      ? {}
      : { serverToolUse: response.usage.serverToolUse })
  },
  metadata: {
    provider: response.metadata.provider,
    model: response.metadata.model,
    latencyMs: response.metadata.latencyMs,
    privacyRoute: response.metadata.privacyRoute,
    ...(response.metadata.revision === undefined ? {} : { revision: response.metadata.revision }),
    ...(response.metadata.timeToFirstTokenMs === undefined
      ? {}
      : { timeToFirstTokenMs: response.metadata.timeToFirstTokenMs }),
    ...(response.metadata.upstreamProvider === undefined
      ? {}
      : { upstreamProvider: response.metadata.upstreamProvider }),
    ...(response.metadata.generationId === undefined
      ? {}
      : { generationId: response.metadata.generationId })
  }
});
export const diagnosticModelError = (error: unknown) => ({
  code: error instanceof GardenError ? error.code : 'provider_failure',
  ...(error instanceof GardenError && typeof error.details?.status === 'number'
    ? { status: error.details.status }
    : {})
});
