import { describe, expect, it } from 'vitest';
import { delegateOutputSummary } from './delegate-output.js';

describe('parallel research report delivery', () => {
  it('preserves adverse assessments for every mission within the window, with a pointer to the full evidence', () => {
    const reports = Array.from({ length: 3 }, (_, id) => ({
      name: `mission-${id}`,
      model: 'model',
      schemaValid: true,
      report: `conclusion-${id}: ${'\\"\n🙂'.repeat(10_000)} ending-${id}`,
      unverified: 'Claims remain provisional.',
      citations: { checked: 2, cited: 8 },
      evidenceChecks: [
        {
          claim: 'current rate',
          source: 'https://example.com',
          quoteMatched: true,
          reread: true,
          detail: 'Quote present.'
        }
      ],
      claimReview: {
        status: 'reviewed',
        claims: [
          {
            id: 0,
            assessment: 'contradicted',
            kind: 'observation',
            explanation: 'This is the stale rate.',
            support: [{ sourceId: 0, quote: 'Current rate: 10.' }],
            conflicts: []
          }
        ],
        limitations: ['Unreviewed sources remain.']
      }
    }));
    const result = { reports, usageCredits: 0.3, isolation: 'read-only' };
    const before = JSON.stringify(result);
    const recovery = { path: 'workspace/downloads/full-result.txt' };
    const text = delegateOutputSummary(result, 24_000, recovery)!;
    expect(text.length).toBeLessThanOrEqual(24_000);
    const output = JSON.parse(text) as typeof result & { fullResult: { path: string } };
    expect(output.reports).toHaveLength(3);
    expect(output.fullResult).toEqual(recovery);
    expect(JSON.stringify(result)).toBe(before);
    for (const [id, report] of output.reports.entries()) {
      expect(report.name).toBe(`mission-${id}`);
      expect(report.claimReview.claims[0]!.assessment).toBe('contradicted');
      expect(report.report).toContain(`conclusion-${id}`);
      expect(report.report).toContain(`ending-${id}`);
      expect(report.citations).toEqual({ checked: 2, cited: 8 });
    }
  });
  it('does not invent a recovery file or silently remove all reports', () => {
    expect(delegateOutputSummary({ reports: [] }, 24_000, null)).toBeNull();
    const text = delegateOutputSummary(
      { reports: [{ name: 'review', report: 'text' }] },
      24_000,
      null
    )!;
    expect((JSON.parse(text) as { fullResult: string }).fullResult).toContain(
      'could not be spilled'
    );
    expect(delegateOutputSummary({ reports: [{ report: 'text' }] }, 10, null)).toBeNull();
  });
});
