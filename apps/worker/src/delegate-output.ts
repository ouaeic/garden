import { asRecord, textValue } from './values.js';

const clip = (value: unknown, maximum: number): string => {
  const text = textValue(value);
  if (text.length <= maximum) return text;
  const side = Math.max(0, Math.floor((maximum - 5) / 2));
  return `${text.slice(0, side)} […] ${side ? text.slice(-side) : ''}`;
};
const entries = (value: unknown, maximum: number) =>
  (Array.isArray(value) ? value : []).slice(0, maximum).map((entry) => asRecord(entry) ?? {});

/** Preserve each mission's adverse findings before allocating space to report prose. */
export function delegateOutputSummary(
  result: unknown,
  maximum: number,
  recovery: { path: string } | null | undefined
): string | null {
  const root = asRecord(result);
  if (!root || !Array.isArray(root.reports) || !root.reports.length || root.reports.length > 3)
    return null;
  const reports = entries(root.reports, 3).map((report) => {
    const review = asRecord(report.claimReview);
    const citations = asRecord(report.citations);
    return {
      name: clip(report.name, 80),
      model: clip(report.model, 80),
      schemaValid: report.schemaValid === true,
      unverified: clip(report.unverified, 700),
      ...(citations ? { citations: { checked: citations.checked, cited: citations.cited } } : {}),
      evidenceChecks: entries(report.evidenceChecks, 2).map((check) => ({
        claim: clip(check.claim, 200),
        source: clip(check.source, 400),
        quoteMatched: check.quoteMatched === true,
        reread: check.reread === true,
        detail: clip(check.detail, 180)
      })),
      ...(review
        ? {
            claimReview: {
              status: clip(review.status, 40),
              claims: entries(review.claims, 2).map((claim) => ({
                id: claim.id,
                assessment: clip(claim.assessment, 24),
                kind: clip(claim.kind, 24),
                explanation: clip(claim.explanation, 400),
                support: entries(claim.support, 2).map((support) => ({
                  sourceId: support.sourceId,
                  quote: clip(support.quote, 300)
                })),
                conflicts: Array.isArray(claim.conflicts) ? claim.conflicts.slice(0, 4) : []
              })),
              limitations: (Array.isArray(review.limitations) ? review.limitations : [])
                .slice(0, 3)
                .map((item) => clip(item, 200))
            }
          }
        : {}),
      report: ''
    };
  });
  const output = {
    reports,
    usageCredits: root.usageCredits,
    isolation: clip(root.isolation, 200),
    abbreviated: true,
    fullResult:
      recovery ??
      'The full result could not be spilled. Ask for the missing material as a narrower mission.'
  };
  const base = JSON.stringify(output).length;
  if (base > maximum) return null;
  const share = Math.floor((maximum - base) / reports.length);
  for (const [index, report] of reports.entries()) {
    const original = textValue(asRecord(root.reports[index])?.report);
    let low = 0;
    let high = Math.min(original.length, share);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(clip(original, middle)).length - 2 <= share) low = middle;
      else high = middle - 1;
    }
    report.report = low ? clip(original, low) : '';
  }
  return JSON.stringify(output);
}
