import { describe, expect, it } from 'vitest';
import type { SpendWindow, TaskSpendBlock } from '@athanor/contracts';
import { spendBlockCopy, suggestedCeiling } from './SpendBlock';

const window: SpendWindow = {
  name: 'task',
  spentUsd: 1.17224,
  pendingUsd: 0,
  capUsd: 1.180226,
  warnAtUsd: null,
  projectedUsd: 1.18224,
  state: 'exceeded',
  startsAt: null,
  endsAt: null
};
const block: TaskSpendBlock = {
  taskId: '11111111-1111-4111-8111-111111111111',
  spendPausedAt: null,
  estimateSource: 'paused_step',
  blocked: true,
  unchosen: false,
  summary: 'The request exceeds the ceiling.',
  decision: {
    outcome: 'deny',
    estimateUsd: 0.01,
    blockedBy: 'task',
    warnedBy: [],
    reason: null,
    windows: [window]
  }
};

describe('spending decisions shown to the owner', () => {
  it('offers a small editable increase that covers the request and open work', () => {
    const suggested = suggestedCeiling(window);
    expect(suggested).toBeGreaterThanOrEqual(window.projectedUsd);
    expect(suggested - window.capUsd!).toBeLessThan(0.2);
    expect(suggestedCeiling({ ...window, pendingUsd: 3, projectedUsd: 4.18224 })).toBeGreaterThan(
      4.18224
    );
  });
  it('keeps suggestions within the allowed ceiling and rounds them to cents', () => {
    expect(suggestedCeiling({ ...window, capUsd: 9999, projectedUsd: 9999.5 })).toBe(10000);
    const small = suggestedCeiling({ ...window, spentUsd: 0, capUsd: 0, projectedUsd: 0.01 });
    expect(small).toBeGreaterThan(0.01);
    expect(small).toBeLessThan(1);
    const next = suggestedCeiling({ ...window, capUsd: 3.5, spentUsd: 3.37, projectedUsd: 3.51 });
    expect(Number(next.toFixed(2))).toBe(next);
  });

  it('does not promise the next request fits when its estimate is unknown', () => {
    expect(
      spendBlockCopy({ ...block, blocked: false, estimateSource: 'current_spend' }).description
    ).toContain('may pause again');
    expect(spendBlockCopy({ ...block, blocked: false }).description).toContain(
      'last recorded estimate'
    );
    expect(spendBlockCopy(block).description).toBe(block.summary);
  });
});
