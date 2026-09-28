import { expect, it } from 'vitest';
import type { TaskEvent } from '@garden/contracts';
import { resourceWaitReason } from './resource-wait';

const notice = (sequence: number, code: string, summary: string): TaskEvent => ({
  id: `event-${sequence}`,
  taskId: 'task',
  sequence,
  kind: 'warning',
  summary,
  payload: { code },
  createdAt: '2026-09-14T00:00:00Z'
});

it('shows the latest provider hold without interpreting it as an account balance', () => {
  expect(
    resourceWaitReason([
      notice(1, 'provider_quota_exhausted', 'Earlier limit'),
      notice(2, 'provider_unavailable', 'Upstream tool call was cut off'),
      notice(3, 'unrelated_warning', 'Unrelated notice')
    ])
  ).toEqual({ label: 'Waiting for model provider', detail: 'Upstream tool call was cut off' });
  expect(
    resourceWaitReason([notice(4, 'provider_not_connected', 'Save a model connection')])
  ).toEqual({ label: 'Model connection needed', detail: 'Save a model connection' });
  expect(
    resourceWaitReason([notice(5, 'provider_quota_exhausted', 'Provider rate limit')])
  ).toEqual({ label: 'Provider limit reached', detail: 'Provider rate limit' });
  expect(resourceWaitReason([])).toBeNull();
});

it('uses the server failure when it is outside the visible activity page', () => {
  const old = [notice(1, 'provider_quota_exhausted', 'Earlier limit')];
  expect(
    resourceWaitReason([], { code: 'provider_unavailable', summary: 'Current provider error' })
  ).toEqual({ label: 'Waiting for model provider', detail: 'Current provider error' });
  expect(resourceWaitReason(old, null)).toBeNull();
  expect(resourceWaitReason(old, { code: '__proto__', summary: 'Unknown cause' })).toBeNull();
  expect(resourceWaitReason([notice(2, 'constructor', 'Unknown cause')])).toBeNull();
  expect(
    resourceWaitReason(old, { code: 'different_failure', summary: 'Different cause' })
  ).toBeNull();
});
