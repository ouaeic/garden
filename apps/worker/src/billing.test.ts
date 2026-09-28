import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '@garden/model-gateway';
import type { DataStore } from '@garden/data';
import { delegateBudget, recordModelStepUsage } from './billing.js';

it('records distinct provider generations at a resumed step while replaying one receipt idempotently', async () => {
  const recordUsage = vi.fn();
  const response = (generationId: string) =>
    ({
      metadata: { provider: 'openrouter', generationId }
    }) as ModelResponse;
  const usage = {
    userId: 'owner',
    taskId: 'task',
    kind: 'model_inference',
    resourceClass: 'light',
    quantity: 100,
    unit: 'tokens',
    credits: 0.01,
    state: 'settled',
    idempotencyKey: 'task:task:step:7',
    costUsd: 0.1
  } as Parameters<DataStore['recordUsage']>[0];
  await recordModelStepUsage({ recordUsage }, response('first'), usage);
  await recordModelStepUsage({ recordUsage }, response('second'), usage);
  await recordModelStepUsage({ recordUsage }, response('second'), {
    ...usage,
    idempotencyKey: 'task:task:step:8'
  });
  expect(recordUsage).toHaveBeenCalledTimes(3);
  const entries = recordUsage.mock.calls.map(([entry]) => entry as typeof usage);
  expect(entries[0]!.idempotencyKey).not.toBe(entries[1]!.idempotencyKey);
  expect(entries[1]!.idempotencyKey).toBe(entries[2]!.idempotencyKey);
  expect(new Map(entries.map((entry) => [entry.idempotencyKey, entry.costUsd])).size).toBe(2);
  await recordModelStepUsage(
    { recordUsage },
    { ...response('native'), nativeInputUsageRecorded: true },
    usage
  );
  expect(recordUsage).toHaveBeenCalledTimes(3);
});

describe('delegate budget', () => {
  it('gives a delegated mission a share of the parent budget', () => {
    expect(delegateBudget(20)).toBeCloseTo(5);
  });

  it('divides that share between the missions actually in flight', () => {
    // The share is of the whole task. The parameter existed and the call site never passed it, so
    // three specialists each checked the full quarter independently and could jointly spend three
    // quarters of the task's compute before the lead had done anything with their reports.
    expect(delegateBudget(20, 3)).toBeCloseTo(20 * 0.25 * (1 / 3));
    expect(delegateBudget(20, 3)).toBeLessThan(delegateBudget(20, 1));
  });

  it('never returns a zero or negative budget', () => {
    expect(delegateBudget(0)).toBeGreaterThan(0);
    expect(delegateBudget(-5)).toBeGreaterThan(0);
  });
});
