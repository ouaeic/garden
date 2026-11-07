import type { Task, TaskReasoningEffort } from '@garden/contracts';
import type { Bootstrap } from '../model';
import { effortLabel } from '../reasoning-options';

type ModelRelease = Bootstrap['models'][number];

export const KEYS: readonly [Task['securityMode'], string][] = [
  ['review', 'Ask about everything'],
  ['balanced', 'Ask first'],
  ['autonomous', 'May act as you']
];

export interface AskSettings {
  models: readonly ModelRelease[];
  modelId: string;
  automatic: boolean;
  efforts: readonly TaskReasoningEffort[];
  reasoningEffort: TaskReasoningEffort;
  cap: string;
  securityMode: Task['securityMode'];
  privacyRoute: 'external' | 'provider_zdr';
  privacyLocked: boolean;
  interrupt: boolean;
}

/** What the next send will use, in a line, when any of it differs from the defaults. */
export function settingsSummary(settings: AskSettings, defaultMode: Task['securityMode']): string {
  const model = settings.models.find((item) => item.id === settings.modelId);
  return [
    settings.automatic ? 'Model chosen for the work' : model?.displayName,
    settings.reasoningEffort !== 'auto' && `${effortLabel(settings.reasoningEffort)} effort`,
    settings.cap && `$${settings.cap} cap`,
    settings.securityMode !== defaultMode &&
      KEYS.find(([mode]) => mode === settings.securityMode)?.[1],
    settings.privacyRoute === 'external' && 'Providers may keep data'
  ]
    .filter(Boolean)
    .join(' · ');
}
