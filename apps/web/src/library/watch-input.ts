import type { TaskScheduleSpec } from '@garden/contracts';
import { fieldValue, numberOrNull } from '../management.js';

export function watchInput(
  form: FormData,
  kind: TaskScheduleSpec['kind'],
  workspaceId: string,
  editing: boolean
) {
  let spec: TaskScheduleSpec;
  if (kind === 'once') spec = { kind, runAt: new Date(fieldValue(form, 'runAt')).toISOString() };
  else if (kind === 'interval') spec = { kind, everyMinutes: Number(form.get('everyMinutes')) };
  else if (kind === 'cron')
    spec = {
      kind,
      timeZone: fieldValue(form, 'timezone'),
      expression: fieldValue(form, 'expression')
    };
  else if (kind === 'daily')
    spec = { kind, timeZone: fieldValue(form, 'timezone'), localTime: fieldValue(form, 'time') };
  else {
    const weekdays = form.getAll('weekday').map(Number);
    if (!weekdays.length) throw new Error('Choose at least one weekday.');
    spec = {
      kind,
      timeZone: fieldValue(form, 'timezone'),
      localTime: fieldValue(form, 'time'),
      weekdays
    };
  }
  const spend = numberOrNull(form.get('spend'));
  const common = {
    title: fieldValue(form, 'title'),
    prompt: fieldValue(form, 'prompt'),
    spec,
    maxComputeCredits: Number(form.get('credits'))
  };
  if (editing) return { ...common, maxSpendUsd: spend };
  if (!workspaceId) throw new Error('Choose a computer before creating a watch.');
  return {
    ...common,
    workspaceId,
    ...(fieldValue(form, 'modelId') ? { modelId: fieldValue(form, 'modelId') } : {}),
    privacyRoute: fieldValue(form, 'privacyRoute'),
    ...(spend !== null ? { maxSpendUsd: spend } : {}),
    ...(kind !== 'once' && form.has('trigger')
      ? { trigger: { kind: 'webhook', minGapMinutes: Number(form.get('minGap')) } }
      : {})
  };
}
