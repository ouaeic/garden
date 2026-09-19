import { z } from 'zod';

export const CLAIM_REVIEW_SOURCES = 2;
export const CLAIM_REVIEW_CLAIMS = 8;
export const CLAIM_REVIEW_SOURCE_CHARS = 20_000;
export const CLAIM_REVIEW_CLAIM_CHARS = 1600;

/** Explicit lead claims use the same bounded source reread as specialist reports. */
export const DirectClaims = z
  .array(
    z
      .object({
        claim: z.string().trim().min(1).max(CLAIM_REVIEW_CLAIM_CHARS),
        source: z.string().trim().min(1).max(2048),
        quotedSpan: z.string().trim().min(1).max(1600)
      })
      .strict()
  )
  .min(1)
  .max(CLAIM_REVIEW_CLAIMS);
export type DirectClaims = z.infer<typeof DirectClaims>;
