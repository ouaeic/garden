import type { ReasoningOptions, TaskReasoningEffort } from '@garden/contracts';

const levels: TaskReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function effortChoices(reasoning?: ReasoningOptions): TaskReasoningEffort[] {
  if (reasoning?.supportedEfforts === undefined) return ['auto'];
  const supported = reasoning.supportedEfforts ?? levels;
  return [
    'auto',
    ...levels.filter(
      (level) =>
        supported.includes(level as Exclude<TaskReasoningEffort, 'auto'>) &&
        !(reasoning.mandatory && level === 'none')
    )
  ];
}

export const effortLabel = (effort: TaskReasoningEffort): string =>
  ({
    auto: 'Adaptive',
    none: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Maximum'
  })[effort];
