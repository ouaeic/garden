import { z } from 'zod';

export const OutcomeArtifact = z
  .object({
    analysis: z
      .object({
        referenceSha256: z.string(),
        recordCount: z.number(),
        totalBases: z.number(),
        callableBases: z.number(),
        gcFraction: z.number().nullable(),
        records: z
          .array(
            z
              .object({
                ordinal: z.number().int(),
                id: z.string(),
                length: z.number(),
                callableBases: z.number(),
                gcBases: z.number()
              })
              .strict()
          )
          .max(1000)
      })
      .strict(),
    report: z
      .object({
        title: z.string().min(1),
        sections: z
          .array(z.object({ heading: z.string(), text: z.string().min(1) }).strict())
          .max(30),
        claims: z
          .array(
            z
              .object({
                id: z.string(),
                conclusion: z.string(),
                sourceId: z.string(),
                quote: z.string(),
                asOf: z.string()
              })
              .strict()
          )
          .max(50)
      })
      .strict()
  })
  .strict();
export type OutcomeArtifact = z.infer<typeof OutcomeArtifact>;

export const Oracle = z
  .object({
    version: z.literal(1),
    caseId: z.string().regex(/^[a-f0-9]{20}$/),
    revision: z.literal('outcome-contracts-v1'),
    classification: z.literal('development_calibration'),
    publicDigest: z.string().regex(/^[a-f0-9]{64}$/),
    receiptKey: z.string().regex(/^[a-f0-9]{64}$/),
    analysis: OutcomeArtifact.shape.analysis,
    report: z
      .object({
        requiredSections: z.array(z.string()).min(1),
        claims: z
          .array(
            z
              .object({
                id: z.string().min(1),
                conclusion: z.string().min(1),
                sourceId: z.string().min(1),
                sourceText: z.string().min(1),
                supportingQuote: z.string().min(1),
                asOf: z.string().min(1)
              })
              .strict()
          )
          .min(1)
          .max(50)
      })
      .strict(),
    form: z.record(z.string(), z.union([z.string(), z.boolean()]))
  })
  .strict();
export type Oracle = z.infer<typeof Oracle>;

export const Observation = z
  .object({
    version: z.literal(1),
    caseId: z.string().regex(/^[a-f0-9]{20}$/),
    publicDigest: z.string().regex(/^[a-f0-9]{64}$/),
    completed: z.boolean().nullable(),
    model: z.string().nullable(),
    provider: z.string().nullable(),
    costUsd: z.number().finite().nonnegative().nullable(),
    inputTokens: z.number().int().nonnegative().safe().nullable(),
    outputTokens: z.number().int().nonnegative().safe().nullable(),
    cachedInputTokens: z.number().int().nonnegative().safe().nullable(),
    elapsedMs: z.number().finite().nonnegative().nullable(),
    interventions: z
      .array(z.enum(['approval', 'direction', 'captcha', 'authentication', 'signature']))
      .nullable(),
    faults: z.array(
      z.enum(['response_lost_after_submission', 'runner_restart', 'provider_disconnect'])
    ),
    recovered: z.boolean().nullable(),
    submissions: z
      .array(
        z
          .object({
            id: z.string(),
            fields: z.record(z.string(), z.union([z.string(), z.boolean()]))
          })
          .strict()
      )
      .max(100)
  })
  .strict();
export type Observation = z.infer<typeof Observation>;

export const SignedObservation = z
  .object({
    payload: Observation,
    signature: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type SignedObservation = z.infer<typeof SignedObservation>;
