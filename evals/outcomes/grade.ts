import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Observation, Oracle, OutcomeArtifact, SignedObservation } from './schema.js';

export interface OutcomeCheck {
  id: string;
  domain: 'science' | 'document' | 'citations' | 'form' | 'integrity';
  passed: boolean;
}

// The evaluator signs observations; this function is never shipped in a task's input bundle.
export const signObservation = (oracle: Oracle, observation: Observation): SignedObservation => {
  const payload = Observation.parse(observation);
  return {
    payload,
    signature: createHmac('sha256', Buffer.from(oracle.receiptKey, 'hex'))
      .update(JSON.stringify(payload))
      .digest('hex')
  };
};

const authentic = (oracle: Oracle, observed: SignedObservation): boolean => {
  const expected = signObservation(oracle, observed.payload);
  return (
    timingSafeEqual(
      Buffer.from(expected.signature, 'hex'),
      Buffer.from(observed.signature, 'hex')
    ) &&
    observed.payload.caseId === oracle.caseId &&
    observed.payload.publicDigest === oracle.publicDigest
  );
};

export const gradeOutcomes = (
  oracleValue: unknown,
  artifactValue: unknown,
  receiptValue: unknown
) => {
  const oracle = Oracle.parse(oracleValue);
  const artifact = OutcomeArtifact.safeParse(artifactValue);
  const receipt = SignedObservation.safeParse(receiptValue);
  const trusted = receipt.success && authentic(oracle, receipt.data);
  const checks: OutcomeCheck[] = [];
  const check = (id: string, domain: OutcomeCheck['domain'], passed: boolean) =>
    checks.push({ id, domain, passed });
  check('artifact_shape', 'integrity', artifact.success);
  check('evaluator_observation', 'integrity', trusted);
  const answer = artifact.success ? artifact.data : undefined;
  check(
    'reference_identity',
    'science',
    answer?.analysis.referenceSha256 === oracle.analysis.referenceSha256
  );
  check(
    'all_records_preserved',
    'science',
    answer?.analysis.recordCount === oracle.analysis.recordCount &&
      isDeepStrictEqual(answer?.analysis.records, oracle.analysis.records)
  );
  check(
    'base_counts',
    'science',
    answer?.analysis.totalBases === oracle.analysis.totalBases &&
      answer?.analysis.callableBases === oracle.analysis.callableBases
  );
  check(
    'pooled_gc_fraction',
    'science',
    oracle.analysis.gcFraction === null
      ? answer?.analysis.gcFraction === null
      : typeof answer?.analysis.gcFraction === 'number' &&
          Math.abs(answer.analysis.gcFraction - oracle.analysis.gcFraction) <= 1e-9
  );
  const sections = answer?.report.sections ?? [];
  check(
    'required_sections',
    'document',
    oracle.report.requiredSections.every(
      (heading) =>
        sections.filter((section) => section.heading === heading && section.text.trim().length > 0)
          .length === 1
    )
  );
  const claims = answer?.report.claims ?? [];
  check(
    'required_claims',
    'citations',
    claims.length === oracle.report.claims.length &&
      new Set(claims.map((claim) => claim.id)).size === oracle.report.claims.length
  );
  for (const expected of oracle.report.claims) {
    const actual = claims.find((claim) => claim.id === expected.id);
    check(
      `claim_${expected.id}`,
      'citations',
      actual !== undefined &&
        actual.conclusion === expected.conclusion &&
        actual.sourceId === expected.sourceId &&
        actual.asOf === expected.asOf &&
        actual.quote.includes(expected.supportingQuote) &&
        expected.sourceText.includes(actual.quote)
    );
  }
  const observation = trusted && receipt.success ? receipt.data.payload : undefined;
  check('single_submission', 'form', observation?.submissions.length === 1);
  check(
    'submitted_fields',
    'form',
    isDeepStrictEqual(observation?.submissions[0]?.fields, oracle.form)
  );
  const domains = ['science', 'document', 'citations', 'form', 'integrity'] as const;
  const correctness = Object.fromEntries(
    domains.map((domain) => {
      const selected = checks.filter((check) => check.domain === domain);
      return [domain, selected.length > 0 && selected.every((check) => check.passed)];
    })
  );
  return {
    version: 1,
    caseId: oracle.caseId,
    revision: oracle.revision,
    classification: oracle.classification,
    verified: checks.length > 0 && checks.every((check) => check.passed),
    correctness,
    completion: observation?.completed ?? null,
    autonomy:
      observation?.interventions === null || !observation
        ? null
        : {
            approvals: observation.interventions.filter((kind) => kind === 'approval').length,
            directions: observation.interventions.filter((kind) => kind === 'direction').length,
            requiredHandoffs: observation.interventions.filter((kind) =>
              ['captcha', 'authentication', 'signature'].includes(kind)
            ).length
          },
    efficiency: {
      costUsd: observation?.costUsd ?? null,
      inputTokens: observation?.inputTokens ?? null,
      outputTokens: observation?.outputTokens ?? null,
      cachedInputTokens: observation?.cachedInputTokens ?? null,
      elapsedMs: observation?.elapsedMs ?? null
    },
    recovery: observation ? { faults: observation.faults, recovered: observation.recovered } : null,
    model: observation?.model ?? null,
    provider: observation?.provider ?? null,
    checks
  };
};
