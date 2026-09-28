import type { ModelRelease } from '@garden/contracts';
import { sha256 } from '@garden/core';
import { resolveTaskPurposeModel } from './purpose-model.js';
import type { ToolContext } from './tool-dispatch.js';

type Context = Pick<ToolContext, 'store' | 'masterKey' | 'connectedModels'>;
export interface DecisionRoute {
  model: ModelRelease;
  binding: string;
}

/** Automatic auxiliary inference remains on the connection already serving this task. */
export async function resolveDecisionRoute(
  context: Context,
  task: ToolContext['task']
): Promise<DecisionRoute | null> {
  const catalog = (await context.store.listModels()) as ModelRelease[];
  const main = catalog.find((model) => model.id === task.modelId);
  if (!main) return null;
  const connection = main.connectionId ?? main.provider;
  const compatible = catalog.filter(
    (model) =>
      (model.connectionId ?? model.provider) === connection && model.provider === 'openrouter'
  );
  const model = await resolveTaskPurposeModel(context, task, 'decisions', compatible).catch(
    () => null
  );
  if (
    !model ||
    (model.connectionId ?? model.provider) !== connection ||
    !model.capabilities.includes('decisions') ||
    model.availability !== 'available' ||
    model.providerAvailable === false ||
    (task.privacyRoute === 'provider_zdr' &&
      (model.privacyRoute !== 'provider_zdr' || model.zeroDataRetentionAvailable !== true))
  )
    return null;
  return {
    model,
    binding: sha256(
      JSON.stringify([
        task.id,
        connection,
        model.id,
        model.revision,
        model.privacyRoute,
        task.privacyRoute,
        model.inputUsdPerMillionTokens,
        model.outputUsdPerMillionTokens
      ])
    )
  };
}
