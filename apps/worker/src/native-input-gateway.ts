import { GardenError, pricesAtPromptSize, readRoutingMetadata } from '@garden/core';
import type { ModelRelease } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import { nativeInputBlocks, type ModelAdapter, type ModelRequest } from '@garden/model-gateway';
import { estimatedInferenceCostUsd, usageCredit } from './billing.js';

/**
 * What a native reading is held to before it is sent: the whole window at the dearest input rate.
 * The reply names no length, so its output is not held; the receipt settles it.
 */
export const nativeInputBound = (model: ModelRelease, kinds: readonly ('audio' | 'video')[]) => {
  if (
    model.provider === 'openrouter' &&
    ['openrouter/auto', 'openrouter/free', 'openrouter/bodybuilder'].includes(model.providerModelId)
  )
    throw new GardenError(
      'native_input_pricing_unknown',
      'Choose a fixed, priced model for native recordings',
      400
    );
  const prices = kinds.map((kind) =>
    kind === 'audio'
      ? model.nativeInputPricing?.audioUsdPerMillionTokens
      : model.nativeInputPricing?.videoUsdPerMillionTokens
  );
  const rates = [...prices, model.inputUsdPerMillionTokens, model.outputUsdPerMillionTokens];
  if (rates.some((price) => typeof price !== 'number' || !Number.isFinite(price) || price < 0))
    throw new GardenError(
      'native_input_pricing_unknown',
      'The selected model has no complete native input price. Choose a route with published modality pricing before sending this recording.',
      400
    );
  const tiered = pricesAtPromptSize(
    { ...model, ...readRoutingMetadata(model) },
    model.contextTokens
  );
  const maxInputRate = Math.max(
    ...(prices as number[]),
    model.inputUsdPerMillionTokens!,
    tiered.input ?? 0
  );
  const outputRate = Math.max(model.outputUsdPerMillionTokens!, tiered.output ?? 0);
  const priced = {
    ...model,
    inputUsdPerMillionTokens: Math.max(maxInputRate, model.inputUsdPerMillionTokens!)
  };
  const usd = Math.max(
    estimatedInferenceCostUsd(priced, model.contextTokens, 0, {
      cacheWriteTokens: model.contextTokens
    }),
    (model.contextTokens * maxInputRate * 1.25) / 1_000_000
  );
  if (!Number.isFinite(usd))
    throw new GardenError(
      'native_input_pricing_unknown',
      'Native input reservation could not be priced',
      400
    );
  return {
    usd,
    credits: usageCredit(model, model.contextTokens, 0),
    model: priced,
    inputRate: maxInputRate,
    outputRate
  };
};

/** One normal generation; ambiguous provider completion retains the entire reserved exposure. */
export const nativeInputAdapter = (
  adapter: ModelAdapter,
  store: DataStore,
  task: TaskRecord,
  model: ModelRelease,
  credentialBinding: string,
  currentBinding: () => Promise<string>,
  workerId: string
): ModelAdapter => ({
  provider: adapter.provider,
  privacyRoute: adapter.privacyRoute,
  list: (signal) => adapter.list(signal),
  chat: async (request: ModelRequest) => {
    const parts = request.messages.flatMap((message) => message.nativeInputs ?? []);
    if (!parts.length) return adapter.chat(request);
    if (request.model !== model.providerModelId)
      throw new GardenError(
        'native_input_route_changed',
        'The native request no longer targets its selected model',
        409
      );
    nativeInputBlocks(parts, adapter.provider, model.modalities);
    if (request.signal?.aborted)
      throw new GardenError(
        'native_input_cancelled',
        'The recording request was cancelled before submission',
        409
      );
    const current = (await store.listModels()).find((entry) => entry.id === model.id);
    if (
      !current ||
      JSON.stringify(current.nativeInputPricing) !== JSON.stringify(model.nativeInputPricing) ||
      JSON.stringify(current.modalities) !== JSON.stringify(model.modalities) ||
      current.availability !== 'available' ||
      current.providerAvailable === false ||
      (task.privacyRoute === 'provider_zdr' &&
        (current.privacyRoute !== 'provider_zdr' || current.zeroDataRetentionAvailable === false))
    )
      throw new GardenError(
        'native_input_route_changed',
        'Native input routing changed; refresh the task before sending this recording',
        409
      );
    if (
      request.nativeInputCredentialBinding !== credentialBinding ||
      (await currentBinding()) !== credentialBinding
    )
      throw new GardenError(
        'native_input_route_changed',
        'The provider credential changed; read the recording again with the current account',
        409
      );
    const claim = await store.taskClaim(task.id);
    if (claim?.status !== 'running' || claim.leaseOwner !== workerId)
      throw new GardenError(
        'native_input_cancelled',
        'This worker no longer owns the recording request',
        409
      );
    const bound = nativeInputBound(
      model,
      parts.map((part) => part.kind)
    );
    const liveBound = nativeInputBound(
      current as unknown as ModelRelease,
      parts.map((part) => part.kind)
    );
    if (
      liveBound.usd !== bound.usd ||
      liveBound.credits !== bound.credits ||
      current.contextTokens !== model.contextTokens
    )
      throw new GardenError(
        'native_input_route_changed',
        'The native input price or context allowance changed; refresh this task',
        409
      );
    if (
      request.nativeInputApprovedCostUsd === undefined ||
      !Number.isFinite(request.nativeInputApprovedCostUsd) ||
      bound.usd > request.nativeInputApprovedCostUsd
    )
      throw new GardenError(
        'native_input_approved_cost_exceeded',
        'The native request exceeds its approved price',
        409
      );
    if (
      request.nativeInputCreditLimit === undefined ||
      bound.credits > request.nativeInputCreditLimit
    )
      throw new GardenError(
        'native_input_credit_limit',
        'The conservative native input bound exceeds the task’s remaining compute allowance',
        402
      );
    const prepared = {
      ...request,
      inputModalities: model.modalities,
      nativeInputMaxPrice: { prompt: bound.inputRate, completion: bound.outputRate }
    };
    if (task.hasCodingFamily) return adapter.chat(prepared);
    if (!request.nativeInputRequestId)
      throw new GardenError(
        'native_input_identity_missing',
        'A native request requires its durable source identity',
        400
      );
    const usage = {
      userId: task.userId,
      taskId: task.id,
      workspaceId: task.workspaceId,
      kind: 'model_inference',
      resourceClass: 'media:native-input',
      quantity: model.contextTokens,
      unit: 'tokens',
      credits: bound.credits,
      costUsd: bound.usd,
      idempotencyKey: `native-input:${task.id}:${request.nativeInputRequestId}`,
      providerRef: `${model.provider}:${model.providerModelId}`
    };
    await store.recordUsage({ ...usage, state: 'reserved', reserveAgainstCaps: true });
    const response = await adapter.chat(prepared);
    const inputTokens = response.usage.inputTokens || model.contextTokens;
    const costUsd =
      response.usage.costUsd ??
      Math.max(
        estimatedInferenceCostUsd(
          bound.model,
          inputTokens,
          response.usage.outputTokens,
          response.usage
        ),
        (inputTokens * bound.inputRate * 1.25 + response.usage.outputTokens * bound.outputRate) /
          1_000_000
      );
    if (!response.usage.estimated)
      await store.settleNativeInputUsage({
        userId: task.userId,
        idempotencyKey: usage.idempotencyKey,
        costUsd,
        credits: usageCredit(model, inputTokens, response.usage.outputTokens),
        quantity: inputTokens + response.usage.outputTokens
      });
    return {
      ...response,
      usage: {
        ...response.usage,
        inputTokens,
        costUsd: response.usage.estimated ? bound.usd : costUsd
      },
      nativeInputUsageRecorded: true
    };
  }
});
