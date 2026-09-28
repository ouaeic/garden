import {
  ReasoningEffort,
  type ReasoningOptions,
  type TaskReasoningEffort
} from '@garden/contracts';
import { assertReasoningEffort } from '@garden/model-gateway';
import { GardenError } from '@garden/core';

/** Owner settings are stable; automatic settings stay inside the model's advertised vocabulary. */
export const taskReasoningEffort = (
  preference: TaskReasoningEffort | undefined,
  automatic: ReasoningEffort,
  options?: ReasoningOptions
): ReasoningEffort | undefined => {
  if (preference && preference !== 'auto') {
    if (options?.supportedEfforts === undefined)
      throw new GardenError(
        'reasoning_options_unknown',
        'The selected model no longer advertises reasoning controls. Choose Auto or a supported model.'
      );
    assertReasoningEffort(preference, options);
    return preference;
  }
  const supported = options?.supportedEfforts;
  if (!options || !Array.isArray(supported)) return automatic;
  const allowed = supported.filter((effort) => !(options.mandatory && effort === 'none'));
  if (allowed.includes(automatic)) return automatic;
  if (options.defaultEffort && allowed.includes(options.defaultEffort))
    return options.defaultEffort;
  const target = ReasoningEffort.options.indexOf(automatic);
  return [...allowed].sort(
    (a, b) =>
      Math.abs(ReasoningEffort.options.indexOf(a) - target) -
      Math.abs(ReasoningEffort.options.indexOf(b) - target)
  )[0];
};
