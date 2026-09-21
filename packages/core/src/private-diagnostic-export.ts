import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DiagnosticCaptureStatus } from '@athanor/contracts';
import { DIAGNOSTIC_EMPTY_HASH, PrivateDiagnosticBody } from './private-diagnostics.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PrivateDiagnosticExportRecord = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('private_capture'),
      format: z.literal('garden-private-diagnostic'),
      version: z.literal(1),
      id: z.uuid(),
      taskId: z.uuid(),
      workspaceId: z.uuid(),
      status: DiagnosticCaptureStatus,
      through: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      type: z.literal('record'),
      sequence: z.number().int().positive(),
      previousHash: hash,
      hash,
      body: PrivateDiagnosticBody
    })
    .strict(),
  z
    .object({
      type: z.literal('footer'),
      records: z.number().int().nonnegative(),
      hash,
      complete: z.boolean()
    })
    .strict()
]);
export type PrivateDiagnosticExportRecord = z.infer<typeof PrivateDiagnosticExportRecord>;
export const diagnosticPlainHash = (
  sequence: number,
  previous: string,
  body: PrivateDiagnosticBody
) =>
  createHash('sha256')
    .update(JSON.stringify([sequence, previous, body]))
    .digest('hex');

/** Validates a downloaded snapshot. Hashes detect corruption, not the identity of its author. */
export class PrivateDiagnosticReader {
  header: Extract<PrivateDiagnosticExportRecord, { type: 'private_capture' }> | undefined;
  #sequence = 0;
  #hash = DIAGNOSTIC_EMPTY_HASH;
  #footer = false;
  #complete = false;
  accept(input: unknown): PrivateDiagnosticBody | null {
    const row = PrivateDiagnosticExportRecord.parse(input);
    if (this.#footer) throw new Error('Data after diagnostic footer');
    if (row.type === 'private_capture') {
      if (this.header || row.id !== row.status.id || row.through !== row.status.records)
        throw new Error('Invalid diagnostic header');
      this.header = row;
      return null;
    }
    if (!this.header) throw new Error('Missing diagnostic header');
    if (row.type === 'footer') {
      if (row.records !== this.#sequence || row.hash !== this.#hash)
        throw new Error('Invalid diagnostic footer');
      this.#footer = true;
      this.#complete = row.complete && this.#sequence === this.header.through;
      return null;
    }
    if (
      row.sequence !== this.#sequence + 1 ||
      row.sequence > this.header.through ||
      row.previousHash !== this.#hash ||
      row.hash !== diagnosticPlainHash(row.sequence, this.#hash, row.body)
    )
      throw new Error('Diagnostic sequence or hash mismatch');
    this.#sequence = row.sequence;
    this.#hash = row.hash;
    return row.body;
  }
  result() {
    return { records: this.#sequence, complete: this.#footer && this.#complete };
  }
}
