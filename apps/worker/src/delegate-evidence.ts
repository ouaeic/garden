import type { ModelRelease, ParallelWebReadResult } from '@athanor/contracts';
import type { TaskRecord } from '@athanor/data';
import type { AgentState } from './agent-state.js';
import {
  quotedSpanMatchesSource,
  type DelegateEvidenceCheck,
  type DelegateReport
} from './completion.js';
import { chargeNovelty, classifyDestination, type DestinationContext } from './egress.js';
import type { ToolContext } from './tool-dispatch.js';
import {
  CLAIM_REVIEW_SOURCES,
  CLAIM_REVIEW_SOURCE_CHARS,
  reviewClaims,
  type ClaimReview,
  type ClaimSource
} from './claim-review.js';
import { untrustedOriginOfResult } from './provenance.js';

export async function assessEvidenceReport(
  context: ToolContext,
  model: ModelRelease,
  report: DelegateReport | null,
  destinations: DestinationContext,
  state: AgentState,
  reachedAddresses: readonly string[],
  remainingCredits: number,
  requestId: string,
  question: string
) {
  const evidence = report?.evidence.length
    ? await verifyDelegateEvidence(
        context,
        context.task,
        report.evidence,
        destinations,
        state,
        reachedAddresses
      )
    : { checks: [], sources: [] };
  const untrustedSources = new Set<string>();
  for (const source of evidence.sources) {
    const origin = untrustedOriginOfResult(
      {
        id: 'citation-reread',
        name: /^https?:\/\//i.test(source.source) ? 'parallel_web_read' : 'file_read',
        arguments: { path: source.source }
      },
      { sources: [{ url: source.source }] }
    );
    if (origin) untrustedSources.add(origin);
  }
  const claimReview =
    evidence.sources.length && report
      ? await reviewClaims(
          context,
          model,
          evidence.sources,
          report.answer,
          remainingCredits,
          requestId,
          question
        )
      : undefined;
  return {
    evidenceChecks: evidence.checks,
    claimReview,
    unverified: unverifiedNotice(report, evidence.checks, claimReview),
    untrustedSources: [...untrustedSources]
  };
}

/** Citation addresses remain subject to the same egress floor as the specialist's own reads. */
export async function verifyDelegateEvidence(
  context: ToolContext,
  task: TaskRecord,
  evidence: ReadonlyArray<{ claim: string; source: string; quotedSpan: string }>,
  destinations: DestinationContext,
  state: AgentState,
  reachedAddresses: readonly string[]
): Promise<{ checks: DelegateEvidenceCheck[]; sources: ClaimSource[] }> {
  const checks: DelegateEvidenceCheck[] = [];
  const sources: ClaimSource[] = [];
  for (const [id, item] of evidence.slice(0, CLAIM_REVIEW_SOURCES).entries()) {
    try {
      let body: string;
      if (/^https?:\/\//i.test(item.source)) {
        // Charge synchronously before awaiting: sibling missions share the same turn counter.
        const spent = state.turnNoveltyBytes ?? 0;
        const verdict = classifyDestination(item.source, {
          ...destinations,
          knownAddresses: [...(destinations.knownAddresses ?? []), ...reachedAddresses],
          spentNoveltyBytes: spent
        });
        if (verdict.sink) {
          checks.push({
            claim: item.claim,
            source: item.source,
            quoteMatched: false,
            reread: false,
            detail: `the harness did not fetch this source, so the span was not checked either way: ${verdict.reason}`
          });
          continue;
        }
        state.turnNoveltyBytes = chargeNovelty(spent, [verdict]);
        const read = await context.runner.call<ParallelWebReadResult>(
          task.workspaceId,
          task.id,
          'browser.read',
          `/v1/workspaces/${task.workspaceId}/browser/read-many`,
          { urls: [item.source], maxCharactersPerPage: CLAIM_REVIEW_SOURCE_CHARS }
        );
        const source = read.sources?.[0];
        if (!source || source.error !== undefined || typeof source.text !== 'string')
          throw new Error(source?.error || 'The web reader returned no source text.');
        body = source.text;
      } else {
        body = await context.runner.readFile(task.workspaceId, task.id, item.source);
      }
      body = body.slice(0, CLAIM_REVIEW_SOURCE_CHARS);
      const quoteMatched = quotedSpanMatchesSource(body, item.quotedSpan);
      checks.push({
        claim: item.claim,
        source: item.source,
        quoteMatched,
        reread: true,
        detail: quoteMatched
          ? 'the quoted span is present in the source'
          : 'the quoted span is not present in the source as read by the harness'
      });
      sources.push({ id, claim: item.claim, source: item.source, text: body, quoteMatched });
    } catch (error) {
      checks.push({
        claim: item.claim,
        source: item.source,
        quoteMatched: false,
        reread: false,
        detail: `the source could not be re-read: ${error instanceof Error ? error.message : 'unknown error'}`
      });
    }
  }
  return { checks, sources };
}

export function unverifiedNotice(
  structured: DelegateReport | null,
  checks: ReadonlyArray<DelegateEvidenceCheck>,
  review?: ClaimReview
): string {
  if (!structured)
    return 'Nothing in this report was checked: it did not arrive in the shape the harness re-reads citations from. Treat its claims as leads to follow rather than as findings.';
  const cited = structured.evidence.length;
  if (!cited)
    return 'Nothing in this report was checked: the specialist cited no sources. Treat its claims as leads to follow rather than as findings.';
  const reread = checks.filter((check) => check.reread);
  const matched = reread.filter((check) => check.quoteMatched);
  if (!reread.length)
    return 'Nothing in this report was checked: the harness could not open the sources it spot-checked. Treat its claims as leads to follow rather than as findings.';
  if (!matched.length)
    return `The harness re-read ${reread.length} of the ${cited} cited sources and found the quoted span in none of them. Treat its claims as leads to follow rather than as findings.`;
  const coverage = `The harness re-read ${reread.length} of the ${cited} cited sources; ${matched.length} quoted spans matched.${reread.length < cited ? ` The other ${cited - reread.length} ${cited - reread.length === 1 ? 'was' : 'were'} not re-read at all.` : ''}`;
  if (review?.status === 'reviewed') {
    const supported = review.claims.filter((claim) => claim.assessment === 'supported').length;
    return `${coverage} Independent review assessed ${supported} of ${review.claims.length} sampled claims as supported. Read claimReview for contradictions, inferences and limitations. Quotation matches do not establish claims; this sample does not establish the whole report or the truth of its sources.`;
  }
  return `${coverage} Claim support has not been independently assessed. Quotation matches do not establish claims. Treat its claims as leads to follow rather than as findings.`;
}
