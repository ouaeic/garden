import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EncryptedEnvelope } from './crypto.js';

export const PrivateDiagnosticKind = z.enum([
  'segment_start',
  'segment_end',
  'model_request',
  'model_attempt',
  'model_outcome',
  'model_end',
  'decision_request',
  'decision_outcome',
  'approval_decision',
  'request_derivation',
  'harness_event'
]);
export type PrivateDiagnosticKind = z.infer<typeof PrivateDiagnosticKind>;
export const PrivateDiagnosticBody = z
  .object({
    version: z.literal(1),
    kind: PrivateDiagnosticKind,
    at: z.iso.datetime(),
    data: z.unknown()
  })
  .strict();
export type PrivateDiagnosticBody = z.infer<typeof PrivateDiagnosticBody>;
export const DIAGNOSTIC_EMPTY_HASH = '0'.repeat(64);
export const diagnosticRecordAad = (id: string, sequence: number, previousHash: string) =>
  `private-diagnostic:${id}:${sequence}:${previousHash}`;
export const diagnosticCipherHash = (value: EncryptedEnvelope) =>
  createHash('sha256')
    .update(JSON.stringify([value.v, value.iv, value.tag, value.ciphertext, value.aad ?? null]))
    .digest('hex');

export interface PrivateDiagnosticSink {
  readonly active?: boolean;
  record(kind: PrivateDiagnosticKind, data: unknown): Promise<void>;
  fail?(reason: 'unsupported_record'): Promise<void>;
}
const recording = new AsyncLocalStorage<PrivateDiagnosticSink | undefined>();
export const withPrivateDiagnostics = <T>(
  sink: PrivateDiagnosticSink | undefined,
  work: () => T
): T => recording.run(sink, work);
export const privateDiagnostics = () => {
  const sink = recording.getStore();
  return sink?.active === false ? undefined : sink;
};

/** A diagnostic failure cannot change the task's execution or permission decision. */
export const recordPrivateDiagnostic = async (kind: PrivateDiagnosticKind, data: unknown) => {
  const sink = privateDiagnostics();
  if (!sink) return;
  try {
    await sink.record(kind, typeof data === 'function' ? (data as () => unknown)() : data);
  } catch {
    await sink.fail?.('unsupported_record').catch(() => undefined);
  }
};
