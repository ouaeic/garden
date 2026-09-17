import type { ModelResponse } from './protocol.js';

// Partial output may contain private data. Keep it out of serializable error details and logs.
const interrupted = new WeakMap<Error, ModelResponse>();

export function retainInterruptedResponse(error: Error, response: ModelResponse): void {
  interrupted.set(error, { ...response, finishReason: 'error' });
}

/** Usage evidence only: the request still failed and its tools must not be dispatched. */
export function interruptedResponseOf(error: unknown): ModelResponse | undefined {
  return error instanceof Error ? interrupted.get(error) : undefined;
}
