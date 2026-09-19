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
            claim: 'current rate',
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
      expect(report.claimReview.claims[0]!.claim).toBe('current rate');
      expect(report.report).toContain(`conclusion-${id}`);
      expect(report.report).toContain(`ending-${id}`);
      expect(report.citations).toEqual({ checked: 2, cited: 8 });
    }
  });
  it('preserves usable source addresses and labels shortened claims as previews', () => {
    const source = `https://example.com/${'long-directory/'.repeat(40)}source.txt`;
    const claim = 'A long claim with qualifications. '.repeat(30);
    const result = JSON.parse(
      delegateOutputSummary(
        {
          reports: [
            {
              evidenceChecks: [{ source, claim, reread: true, quoteMatched: true }],
              claimReview: {
                status: 'reviewed',
                claims: [{ id: 0, claim, assessment: 'supported' }]
              }
            }
          ]
        },
        24_000,
        { path: 'workspace/full-review.json' }
      )!
    ) as {
      reports: Array<{
        evidenceChecks: Array<{ source: string; claim?: string; claimPreview: string }>;
        claimReview: { claims: Array<{ claim?: string; claimPreview: string }> };
      }>;
      fullResult: { path: string };
    };
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0]!;
    expect(report.evidenceChecks[0]!.source).toBe(source);
    for (const entry of [report.evidenceChecks[0]!, report.claimReview.claims[0]!]) {
      expect(entry.claim).toBeUndefined();
      expect(entry.claimPreview).toContain(' […] ');
      expect(entry.claimPreview.length).toBeLessThanOrEqual(200);
    }
    expect(result.fullResult.path).toBe('workspace/full-review.json');
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

  it('keeps every verdict when expanded claim sets require a compact evidence summary', () => {
    const reports = Array.from({ length: 3 }, (_, mission) => ({
      name: `mission-${mission}`,
      report: 'Background '.repeat(12000),
      evidenceChecks: Array.from({ length: 8 }, (_, id) => ({
        claim: `target-${mission}-${id}`,
        source: `workspace/${'nested/'.repeat(200)}source.txt`,
        reread: true,
        quoteMatched: true
      })),
      claimReview: {
        status: 'reviewed',
        claims: Array.from({ length: 8 }, (_, id) => ({
          id,
          claim: `target-${mission}-${id}`,
          assessment: id === 7 ? 'contradicted' : 'supported',
          kind: 'observation',
          explanation: 'A substantive finding. '.repeat(100),
          support: [{ sourceId: 0, quote: 'Source passage. '.repeat(100) }],
          conflicts: []
        })),
        limitations: ['A bounded review.']
      }
    }));
    const text = delegateOutputSummary({ reports }, 24000, { path: 'workspace/full.json' });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(24000);
    const result = JSON.parse(text!) as {
      reports: Array<{
        name: string;
        evidenceCheckCounts: { checked: number };
        claimReview: { claims: Array<{ id: number; claimPreview: string; assessment: string }> };
      }>;
      fullResult: { path: string };
      omitted: string;
    };
    expect(result.reports).toHaveLength(3);
    expect(result.fullResult.path).toBe('workspace/full.json');
    expect(result.omitted).toContain('Every reviewed claim verdict is retained');
    for (const [mission, report] of result.reports.entries()) {
      expect(report.evidenceCheckCounts.checked).toBe(8);
      expect(report.claimReview.claims).toHaveLength(8);
      expect(report.claimReview.claims.map((claim) => claim.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(report.claimReview.claims[7]).toEqual(
        expect.objectContaining({ claimPreview: `target-${mission}-7`, assessment: 'contradicted' })
      );
    }
  });
});
