import { ReasoningEffort, type ReasoningOptions } from '@garden/contracts';
export { ReasoningEffort, ReasoningOptions } from '@garden/contracts';

/** A missing list hides selection; null means the gateway accepts its complete vocabulary. */
export const readReasoningOptions = (value: unknown): ReasoningOptions | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const levels = row.supported_efforts;
  const defaultEffort = ReasoningEffort.safeParse(row.default_effort);
  return {
    mandatory: row.mandatory === true,
    ...(levels === null
      ? { supportedEfforts: null }
      : Array.isArray(levels)
        ? {
            supportedEfforts: [
              ...new Set(
                levels.flatMap((level) => {
                  const parsed = ReasoningEffort.safeParse(level);
                  return parsed.success ? [parsed.data] : [];
                })
              )
            ]
          }
        : {}),
    ...(defaultEffort.success ? { defaultEffort: defaultEffort.data } : {}),
    ...(typeof row.default_enabled === 'boolean' ? { defaultEnabled: row.default_enabled } : {}),
    ...(typeof row.supports_max_tokens === 'boolean'
      ? { supportsMaxTokens: row.supports_max_tokens }
      : {})
  };
};

export const assertReasoningEffort = (
  effort: ReasoningEffort | undefined,
  options: ReasoningOptions | undefined
): void => {
  if (effort === undefined || options === undefined) return;
  if (effort === 'none' && options.mandatory)
    throw new Error('The selected model requires reasoning and cannot turn it off');
  if (Array.isArray(options.supportedEfforts) && !options.supportedEfforts.includes(effort))
    throw new Error(`The selected model does not support ${effort} reasoning effort`);
};
