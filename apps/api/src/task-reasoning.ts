import type { ModelRelease, TaskReasoningEffort } from '@garden/contracts';
import { GardenError } from '@garden/core';
import { assertReasoningEffort } from '@garden/model-gateway';

/** Validate an owner choice before creating work or reserving its spend. */
export const validateTaskReasoning = (
  preference: TaskReasoningEffort,
  model: Pick<ModelRelease, 'reasoning'>
): TaskReasoningEffort => {
  if (preference === 'auto') return preference;
  if (model.reasoning?.supportedEfforts === undefined)
    throw new GardenError(
      'reasoning_options_unknown',
      'This model does not advertise selectable reasoning effort. Choose Auto.'
    );
  try {
    assertReasoningEffort(preference, model.reasoning);
  } catch (error) {
    throw new GardenError(
      'reasoning_effort_unsupported',
      error instanceof Error ? error.message : 'Unsupported reasoning effort'
    );
  }
  return preference;
};
