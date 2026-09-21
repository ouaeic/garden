import { z } from 'zod';
import { deliveryFilePath } from './delivery-path.js';

const pointer = z
  .string()
  .max(512)
  .refine(
    (value) => (value === '' || value.startsWith('/')) && !/~(?:[^01]|$)/.test(value),
    'Use a JSON Pointer with ~0 and ~1 escapes'
  );

/** Exact assertions, interpreted by the runner rather than generated executable code. */
export const JsonProof = z
  .object({
    equals: z.record(pointer, z.json()).optional(),
    lengths: z.record(pointer, z.number().int().nonnegative()).optional(),
    uniqueBy: z.record(pointer, z.string().min(1).max(160)).optional()
  })
  .strict()
  .refine((value) => {
    const count = Object.values(value).reduce(
      (sum, group) => sum + Object.keys(group ?? {}).length,
      0
    );
    return count > 0 && count <= 64 && JSON.stringify(value).length <= 32_768;
  }, 'Supply one to 64 bounded JSON assertions');
export type JsonProof = z.infer<typeof JsonProof>;

export const JsonProofRequest = z
  .object({
    path: z
      .string()
      .refine((value) => deliveryFilePath(value) !== null, 'Use a workspace file path'),
    json: JsonProof
  })
  .strict();

export interface JsonProofResult {
  passed: boolean;
  detail: string;
  sha256: string;
  assertions: number;
  failures: string[];
}
