import { describe, expect, it } from 'vitest';
import { evidenceProgressKey, turnEvidenceCount } from './progress.js';
import { mayRenewStepBudget } from './acceptance.js';

describe('observed research progress', () => {
  it('deduplicates the same source bytes despite changing transport metadata', () => {
    const call = {
      id: 'one',
      name: 'parallel_web_read',
      arguments: { url: 'https://example.org/paper' }
    };
    const a = evidenceProgressKey(call, { text: 'Observed result', receivedAt: 1 });
    const b = evidenceProgressKey(
      { ...call, id: 'two' },
      { text: 'Observed result', receivedAt: 2 }
    );
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(
      turnEvidenceCount({
        a: { name: call.name, success: true, progressKey: a! },
        b: { name: call.name, success: true, progressKey: b! }
      })
    ).toBe(1);
    expect(
      evidenceProgressKey({ ...call, name: 'set_plan' }, { text: 'New plan' })
    ).toBeUndefined();
    expect(evidenceProgressKey(call, { receivedAt: 3 })).toBeUndefined();
  });
  it('counts page observations without counting failures or transport changes', () => {
    const call = {
      id: 'read',
      name: 'parallel_web_read',
      arguments: { urls: ['https://example.org/a', 'https://example.org/b'] }
    };
    const pages = [
      { url: 'https://example.org/a', text: 'A result' },
      { url: 'https://example.org/b', text: 'B result' }
    ];
    const key = evidenceProgressKey(call, { pages });
    expect(key).toBeTruthy();
    expect(evidenceProgressKey(call, { pages: [...pages].reverse(), observedAt: 9 })).toBe(key);
    expect(
      evidenceProgressKey(call, { pages: [{ error: 'timeout', text: 'diagnostic only' }] })
    ).toBeUndefined();
  });
  it('continues read-only work without requiring a manufactured file or check', () => {
    const input = {
      hasAcceptance: false,
      acceptanceIsThisTurn: true,
      writes: 0,
      evidence: 3,
      continuationsUsed: 0,
      continuationCeiling: 5,
      credits: 1,
      maxCredits: 10,
      refusalsExhausted: false,
      awaitingApproval: false
    };
    expect(mayRenewStepBudget(input)).toEqual({ ok: true });
    expect(mayRenewStepBudget({ ...input, mark: { atStep: 120, writes: 0, evidence: 3 } }).ok).toBe(
      false
    );
    expect(
      mayRenewStepBudget({ ...input, evidence: 4, mark: { atStep: 120, writes: 0, evidence: 3 } })
        .ok
    ).toBe(true);
    expect(mayRenewStepBudget({ ...input, awaitingApproval: true }).ok).toBe(false);
    expect(mayRenewStepBudget({ ...input, credits: 9.5 }).ok).toBe(false);
    expect(mayRenewStepBudget({ ...input, writes: 1 }).ok).toBe(false);
  });
});
