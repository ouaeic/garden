import type { ModelRelease } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import type { ModelAdapter } from '@garden/model-gateway';
import { usageCredit, estimatedInferenceCostUsd } from './billing.js';
import { nativeInputBound } from './native-input-gateway.js';
import { GardenError } from '@garden/core';

/** Ordinary tasks bypass this path; a family reserves each provider attempt before it is sent. */
export const codingMissionAdapter = (
  adapter: ModelAdapter,
  store: DataStore,
  task: TaskRecord,
  model: ModelRelease,
  workerId: string
): ModelAdapter => ({
  provider: adapter.provider,
  privacyRoute: adapter.privacyRoute,
  list: (signal) => adapter.list(signal),
  chat: async (request) => {
    if (!task.hasCodingFamily) return adapter.chat(request);
    // A text token cannot contain less than one UTF-8 byte. Images use the entire context bound.
    const nativeKinds = request.messages.flatMap(
      (message) => message.nativeInputs?.map((part) => part.kind) ?? []
    );
    const nativeBound = nativeKinds.length ? nativeInputBound(model, nativeKinds) : null;
    if (nativeBound && !request.nativeInputRequestId)
      throw new GardenError(
        'native_input_identity_missing',
        'A native request requires its durable source identity',
        400
      );
    const inputBound = request.messages.some(
      (message) => message.images?.length || message.nativeInputs?.length
    )
      ? model.contextTokens
      : Math.min(
          model.contextTokens,
          Buffer.byteLength(
            JSON.stringify({
              messages: request.messages,
              tools: request.tools,
              serverTools: request.serverTools
            }),
            'utf8'
          ) + 4_096
        );
    const reservation = await store.reserveCodingInference(
      task.id,
      workerId,
      // The reply names no length: the input is held, and the receipt settles the output.
      usageCredit(model, inputBound, 0),
      nativeBound?.usd ??
        estimatedInferenceCostUsd(model, inputBound, 0, { cacheWriteTokens: inputBound }),
      ...(nativeBound ? ([request.nativeInputRequestId] as const) : [])
    );
    try {
      const response = await adapter.chat(request);
      if (nativeBound && response.usage.estimated) {
        await store.settleCodingInference(reservation, null);
        return {
          ...response,
          usage: { ...response.usage, inputTokens: inputBound, costUsd: nativeBound.usd },
          codingReservationId: reservation,
          nativeInputUsageRecorded: true
        };
      }
      const nativeCost = nativeBound
        ? Math.max(
            estimatedInferenceCostUsd(
              nativeBound.model,
              response.usage.inputTokens || inputBound,
              response.usage.outputTokens,
              response.usage
            ),
            ((response.usage.inputTokens || inputBound) * nativeBound.inputRate * 1.25 +
              response.usage.outputTokens * nativeBound.outputRate) /
              1_000_000
          )
        : undefined;
      await store.settleCodingInference(
        reservation,
        usageCredit(model, response.usage.inputTokens || inputBound, response.usage.outputTokens),
        response.usage.costUsd ??
          nativeCost ??
          estimatedInferenceCostUsd(
            nativeBound?.model ?? model,
            response.usage.inputTokens || inputBound,
            response.usage.outputTokens,
            response.usage
          )
      );
      return {
        ...response,
        ...(nativeCost !== undefined && response.usage.costUsd === undefined
          ? { usage: { ...response.usage, costUsd: nativeCost } }
          : {}),
        codingReservationId: reservation
      };
    } catch (error) {
      // The provider may have accepted a request whose reply was lost; its reservation stays held.
      await store.settleCodingInference(reservation, null);
      throw error;
    }
  }
});
