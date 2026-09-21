import { z } from 'zod';

export const DIAGNOSTIC_CAPTURE_BYTES = 128 * 1024 * 1024;
export const DIAGNOSTIC_RECORD_BYTES = 16 * 1024 * 1024;
export const DiagnosticCaptureReason = z.enum([
  'record_too_large',
  'storage_limit',
  'write_failed',
  'unsupported_record'
]);
export const DiagnosticCaptureStatus = z.object({
  id: z.uuid(),
  state: z.enum(['recording', 'stopped', 'failed']),
  startedAt: z.iso.datetime(),
  stoppedAt: z.iso.datetime().nullable(),
  records: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  limitBytes: z.literal(DIAGNOSTIC_CAPTURE_BYTES),
  reason: DiagnosticCaptureReason.nullable()
});
export type DiagnosticCaptureStatus = z.infer<typeof DiagnosticCaptureStatus>;
export const DiagnosticCaptureControl = z
  .object({
    id: z.uuid(),
    action: z.enum(['start', 'stop', 'delete'])
  })
  .strict();
