import { describe, expect, it } from 'vitest';
import { approvalArgumentsMatch, approvalOutcome, approvalPreviewHash } from './approval-state.js';

describe('approved arguments', () => {
  const key = Buffer.alloc(32, 7);

  it('accepts the exact arguments the user approved', () => {
    const approved = { executable: 'rm', args: ['-rf', 'workspace/output'] };
    expect(
      approvalArgumentsMatch(approvalPreviewHash(key, 'shell', approved), key, 'shell', approved)
    ).toBe(true);
  });

  it('ignores key order, which a round trip through encrypted state can change', () => {
    expect(approvalPreviewHash(key, 'shell', { a: 1, b: { c: 2, d: [3, 4] } })).toBe(
      approvalPreviewHash(key, 'shell', { b: { d: [3, 4], c: 2 }, a: 1 })
    );
  });

  it('refuses arguments swapped between approval and execution', () => {
    const approved = approvalPreviewHash(key, 'shell', {
      executable: 'rm',
      args: ['workspace/tmp']
    });
    expect(
      approvalArgumentsMatch(approved, key, 'shell', { executable: 'rm', args: ['workspace'] })
    ).toBe(false);
  });

  it('refuses a hash that was never stored or cannot be read', () => {
    expect(approvalArgumentsMatch('', key, 'file_write', { path: 'workspace' })).toBe(false);
    expect(approvalArgumentsMatch('not-a-hash', key, 'file_write', { path: 'workspace' })).toBe(
      false
    );
  });

  /**
   * The tool name, pinned in the hash. `file_write` and `file_patch` both take a `path`;
   * `coding_agent` and `process` both take an `{action}`. A hash that saw only the arguments would
   * let an approval granted for one cover a call to the other.
   */
  it('refuses the same arguments presented under a different tool', () => {
    const approved = approvalPreviewHash(key, 'file_write', { path: 'workspace/report.md' });
    expect(
      approvalArgumentsMatch(approved, key, 'file_write', { path: 'workspace/report.md' })
    ).toBe(true);
    expect(
      approvalArgumentsMatch(approved, key, 'file_patch', { path: 'workspace/report.md' })
    ).toBe(false);
  });

  it('refuses a hash made with another workspace key', () => {
    const approved = approvalPreviewHash(Buffer.alloc(32, 9), 'file_write', { path: 'workspace' });
    expect(approvalArgumentsMatch(approved, key, 'file_write', { path: 'workspace' })).toBe(false);
  });
});

describe('approval outcome on resume', () => {
  const hour = 3_600_000;

  it('keeps waiting while the request is still live', () => {
    expect(
      approvalOutcome({
        status: 'pending',
        expiresAt: new Date(Date.now() + hour).toISOString()
      })
    ).toBe('waiting');
  });

  it('expires a request past its deadline before any sweep rewrites the row', () => {
    // Until this is judged here the task returns to awaiting_user on every lease and never
    // releases its compute reservation.
    expect(
      approvalOutcome({
        status: 'pending',
        expiresAt: new Date(Date.now() - hour).toISOString()
      })
    ).toBe('expired');
  });

  it('reads a decision that was already recorded', () => {
    expect(approvalOutcome({ status: 'expired' })).toBe('expired');
    expect(approvalOutcome({ status: 'approved' })).toBe('approved');
    expect(approvalOutcome({ status: 'denied' })).toBe('denied');
  });

  it('waits when the row cannot be read at all', () => {
    expect(approvalOutcome(null)).toBe('waiting');
  });
});
