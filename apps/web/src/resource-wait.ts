import type { Task, TaskEvent } from '@athanor/contracts';
import { data, text } from './model';

const reasons = new Map([
  ['background_jobs', 'Background work is running'],
  ['provider_unavailable', 'Waiting for model provider'],
  ['provider_quota_exhausted', 'Provider limit reached'],
  ['provider_not_connected', 'Model connection needed']
]);

export function resourceWaitReason(
  events: TaskEvent[],
  failure?: Task['resourceWait']
): { label: string; detail: string } | null {
  if (failure !== undefined) {
    const label = failure && reasons.get(failure.code);
    return label && failure ? { label, detail: failure.summary } : null;
  }
  for (const event of [...events].reverse()) {
    if (!['warning', 'error'].includes(event.kind)) continue;
    const label = reasons.get(text(data(event.payload).code));
    if (label) return { label, detail: event.summary };
  }
  return null;
}
