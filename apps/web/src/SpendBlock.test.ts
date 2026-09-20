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
