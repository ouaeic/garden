import { ModelRelease } from '@athanor/contracts';
import {
  AthanorError,
  modelConnectionId,
  priceCeilingFields,
  readRoutingMetadata
} from '@athanor/core';
import { createModelAdapter, isNativeOpenAIEndpoint } from '@athanor/model-gateway';
import { ownerPriceCeiling, type InferenceSecret } from './context.js';
import type { ServerBase } from './http/server-context.js';
import { providerWalls } from './maintenance/provider-walls.js';
import { TITLE_SYSTEM_PROMPT, type TaskTitlerDeps } from './task-titles.js';
import { selectTitleRoute } from './title-route.js';

export const createTitleCompletion =
  (
    { store, config }: Pick<ServerBase, 'store' | 'config'>,
    inferenceConnections: (userId: string) => Promise<Map<string, { secret: InferenceSecret }>>
  ): TaskTitlerDeps['complete'] =>
  async (input) => {
    const connections = await inferenceConnections(input.userId);
    if (!connections.size) return null;
    const privacy = input.privacyRoute;
    if (privacy !== 'provider_zdr' && privacy !== 'external') return { skipped: true };
    const eligible = new Map(
      [...connections].filter(
        ([, { secret }]) =>
          (secret.provider === 'openrouter' || isNativeOpenAIEndpoint(secret.baseUrl)) &&
          (privacy !== 'provider_zdr' || secret.enforceZeroDataRetention)
      )
    );
    const route = selectTitleRoute(
      (await store.listModels())
        .map((record) => ({
          ...ModelRelease.parse(record),
          ...readRoutingMetadata(record)
        }))
        .filter((model) => modelConnectionId(model, [...eligible.keys()]) !== null),
      {
        ...(input.choice ? { choice: input.choice } : {}),
        inputText: `${TITLE_SYSTEM_PROMPT}\n${input.prompt}`,
        privacyRoute: privacy,
        ceiling: priceCeilingFields(
          ownerPriceCeiling(await store.effectiveSpendLimits(input.userId))
        )
      }
    );
    if (!route) return { skipped: true };
    const model = route.model;
    const connectionId = modelConnectionId(model, [...eligible.keys()]);
    const connection = connectionId ? eligible.get(connectionId) : undefined;
    if (!connection) return { skipped: true };
    const { secret } = connection;
    const native = isNativeOpenAIEndpoint(secret.baseUrl);
    let submitted = false;
    const adapter = createModelAdapter({
      baseUrl: secret.baseUrl,
      ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
      provider: model.provider,
      privacyRoute: model.privacyRoute,
      appUrl: config.PUBLIC_APP_URL,
      appTitle: 'garden',
      enforceZeroDataRetention: secret.provider === 'openrouter' && secret.enforceZeroDataRetention,
      fetch: async (url, init) => {
        if (init?.method === 'POST') {
          if (submitted)
            throw new AthanorError(
              'title_already_submitted',
              'This title request has already been submitted',
              409
            );
          init.signal?.throwIfAborted();
          await input.beforeSubmit?.({
            costUsd: route.maxCostUsd,
            providerRef: `${model.provider}:${model.providerModelId}`,
            modelId: model.id
          });
          init.signal?.throwIfAborted();
          submitted = true;
        }
        return globalThis.fetch(url, init);
      }
    });
    const response = await adapter
      .chat({
        model: model.providerModelId,
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          { role: 'user', content: input.prompt }
        ],
        tools: [],
        temperature: 0.2,
        maxTokens: route.maxTokens,
        ...(route.reasoningEffort
          ? { reasoningEffort: route.reasoningEffort, reasoningOptions: model.reasoning }
          : {}),
        textPriceCeiling: route.maxPrice,
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000)
      })
      .catch((error: unknown) => {
        if (error instanceof AthanorError && error.code in providerWalls) return null;
        throw error;
      });
    if (!response) return null;
    const reported = response.usage.costUsd;
    const costUsd =
      typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
        ? reported
        : native && response.usage.inputTokens > 0 && !response.usage.estimated
          ? (response.usage.inputTokens * route.maxPrice.prompt +
              response.usage.outputTokens * route.maxPrice.completion) /
            1_000_000
          : null;
    return {
      text: response.finishReason === 'length' ? '' : response.text,
      costUsd,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      providerRef: `${model.provider}:${model.providerModelId}`,
      resourceClass: 'model:task-title'
    };
  };
