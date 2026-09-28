import { randomUUID } from 'node:crypto';
import {
  GardenError,
  diagnosticCipherHash,
  diagnosticRecordAad,
  type EncryptedEnvelope
} from '@garden/core';
import {
  DIAGNOSTIC_CAPTURE_BYTES,
  DIAGNOSTIC_RECORD_BYTES,
  DiagnosticCaptureReason,
  DiagnosticCaptureStatus
} from '@garden/contracts';
import type { Database } from '../database.js';
import { iso, json } from './rows.js';

export interface DiagnosticCaptureRecord {
  epoch: string;
  status: DiagnosticCaptureStatus;
  userId: string;
  taskId: string;
  workspaceId: string;
  lastHash: string;
  activeSegment: string | null;
}
export interface DiagnosticStoredRecord {
  sequence: number;
  previousHash: string;
  hash: string;
  envelope: EncryptedEnvelope;
}
const record = (row: Record<string, unknown>): DiagnosticCaptureRecord => ({
  epoch: String(row.epoch),
  userId: String(row.user_id),
  taskId: String(row.task_id),
  workspaceId: String(row.workspace_id),
  lastHash: String(row.last_hash),
  activeSegment: typeof row.active_segment === 'string' ? row.active_segment : null,
  status: DiagnosticCaptureStatus.parse({
    id: row.id,
    state: row.state,
    startedAt: iso(row.started_at),
    stoppedAt: row.stopped_at ? iso(row.stopped_at) : null,
    records: Number(row.last_sequence),
    bytes: Number(row.stored_bytes),
    limitBytes: DIAGNOSTIC_CAPTURE_BYTES,
    reason: row.reason ?? null
  })
});

export class DiagnosticCaptureStore {
  constructor(private readonly database: Database) {}

  async get(userId: string, taskId: string): Promise<DiagnosticCaptureRecord | null> {
    const result = await this.database.query(
      `SELECT c.* FROM diagnostic_captures c JOIN tasks t ON t.id=c.task_id
       WHERE c.user_id=$1 AND c.task_id=$2 AND t.user_id=c.user_id`,
      [userId, taskId]
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  async control(userId: string, taskId: string, id: string, action: 'start' | 'stop' | 'delete') {
    return this.database.transaction(async (db) => {
      const task = (
        await db.query('SELECT workspace_id FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE', [
          taskId,
          userId
        ])
      ).rows[0];
      if (!task) throw new GardenError('task_not_found', 'Conversation not found', 404);
      const row = (
        await db.query('SELECT * FROM diagnostic_captures WHERE task_id=$1 FOR UPDATE', [taskId])
      ).rows[0];
      if (row && row.id !== id)
        throw new GardenError(
          'diagnostic_changed',
          'The recording changed. Refresh before continuing.',
          409
        );
      if (action === 'delete') {
        if (row) await db.query('DELETE FROM diagnostic_captures WHERE id=$1', [id]);
        return null;
      }
      if (!row) {
        if (action !== 'start')
          throw new GardenError('diagnostic_not_found', 'Recording not found', 404);
        const inserted = await db.query(
          `INSERT INTO diagnostic_captures(id,user_id,task_id,workspace_id,epoch) VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [id, userId, taskId, task.workspace_id, randomUUID()]
        );
        return record(inserted.rows[0]!).status;
      }
      if (row.workspace_id !== task.workspace_id)
        throw new GardenError(
          'diagnostic_workspace_changed',
          'The working area changed. Download and delete this recording before starting another.',
          409
        );
      if (action === 'start' && row.state === 'failed')
        throw new GardenError(
          'diagnostic_incomplete',
          'Download and delete the incomplete recording before starting another.',
          409
        );
      if (action === 'start' && row.state === 'recording') return record(row).status;
      const updated = await db.query(
        `UPDATE diagnostic_captures SET state=$2,active_segment=NULL,writer_id=NULL,epoch=$3,
         stopped_at=CASE WHEN $2='recording' THEN NULL ELSE COALESCE(stopped_at,NOW()) END
         WHERE id=$1 RETURNING *`,
        [
          id,
          action === 'start' ? 'recording' : row.state === 'failed' ? 'failed' : 'stopped',
          randomUUID()
        ]
      );
      return record(updated.rows[0]!).status;
    });
  }

  async append(input: {
    epoch: string;
    id: string;
    taskId: string;
    workerId: string;
    segmentId: string;
    begin?: boolean;
    final?: boolean;
    seal: (sequence: number, previousHash: string) => EncryptedEnvelope;
  }): Promise<boolean> {
    return this.database.transaction(async (db) => {
      await db.query("SET LOCAL statement_timeout = '2000ms'");
      const task = (
        await db.query(
          `SELECT user_id,workspace_id,lease_owner,lease_expires_at>NOW() AS held FROM tasks
         WHERE id=$1 FOR UPDATE`,
          [input.taskId]
        )
      ).rows[0];
      if (
        !task ||
        (!(task.lease_owner === input.workerId && task.held === true) &&
          !(!input.begin && task.lease_owner === null))
      )
        return false;
      const row = (
        await db.query(
          `SELECT * FROM diagnostic_captures WHERE id=$1 AND task_id=$2 AND state='recording'
         AND user_id=$3 AND workspace_id=$4 FOR UPDATE`,
          [input.id, input.taskId, task.user_id, task.workspace_id]
        )
      ).rows[0];
      if (!row || row.epoch !== input.epoch) return false;
      if (input.begin) {
        if (input.final) throw new Error('A diagnostic segment cannot begin and end together');
        await db.query(
          'UPDATE diagnostic_captures SET active_segment=$2,writer_id=$3 WHERE id=$1',
          [input.id, input.segmentId, input.workerId]
        );
      } else if (row.active_segment !== input.segmentId || row.writer_id !== input.workerId)
        return false;
      const sequence = Number(row.last_sequence) + 1,
        previousHash = String(row.last_hash);
      const envelope = input.seal(sequence, previousHash);
      if (envelope.aad !== diagnosticRecordAad(input.id, sequence, previousHash))
        throw new Error('Diagnostic record encryption context mismatch');
      const body = JSON.stringify(envelope),
        bytes = Buffer.byteLength(body);
      const reason =
        bytes > DIAGNOSTIC_RECORD_BYTES
          ? 'record_too_large'
          : Number(row.stored_bytes) + bytes > DIAGNOSTIC_CAPTURE_BYTES
            ? 'storage_limit'
            : null;
      if (reason) {
        await db.query(
          "UPDATE diagnostic_captures SET state='failed',reason=$2,stopped_at=NOW() WHERE id=$1",
          [input.id, reason]
        );
        return false;
      }
      const hash = diagnosticCipherHash(envelope);
      await db.query(
        `INSERT INTO diagnostic_capture_records(capture_id,sequence,previous_hash,hash,body_ciphertext)
         VALUES($1,$2,$3,$4,$5::jsonb)`,
        [input.id, sequence, previousHash, hash, body]
      );
      await db.query(
        `UPDATE diagnostic_captures SET last_sequence=$2,last_hash=$3,stored_bytes=stored_bytes+$4,
         active_segment=CASE WHEN $5 THEN NULL ELSE active_segment END,
         writer_id=CASE WHEN $5 THEN NULL ELSE writer_id END WHERE id=$1`,
        [input.id, sequence, hash, bytes, input.final ?? false]
      );
      return true;
    });
  }

  async fail(
    id: string,
    taskId: string,
    workerId: string,
    segmentId: string,
    reason: unknown,
    epoch?: string
  ): Promise<void> {
    const code = DiagnosticCaptureReason.parse(reason);
    await this.database.query(
      `UPDATE diagnostic_captures c SET state='failed',reason=$5,stopped_at=NOW() FROM tasks t
       WHERE c.id=$1 AND c.task_id=$2 AND c.state='recording' AND t.id=c.task_id
         AND t.workspace_id=c.workspace_id AND t.user_id=c.user_id
         AND ((c.active_segment=$4 AND c.writer_id=$3 AND (t.lease_owner=$3 AND t.lease_expires_at>NOW() OR t.lease_owner IS NULL))
           OR (c.active_segment IS NULL AND c.writer_id IS NULL AND c.epoch=$6 AND t.lease_owner=$3 AND t.lease_expires_at>NOW()))`,
      [id, taskId, workerId, segmentId, code, epoch ?? null]
    );
  }

  async page(
    userId: string,
    taskId: string,
    id: string,
    after: number,
    through: number
  ): Promise<DiagnosticStoredRecord[]> {
    const result = await this.database.query(
      `SELECT r.* FROM diagnostic_capture_records r JOIN diagnostic_captures c ON c.id=r.capture_id
       JOIN tasks t ON t.id=c.task_id WHERE c.id=$1 AND c.task_id=$2 AND c.user_id=$3 AND t.user_id=c.user_id
       AND r.sequence>$4 AND r.sequence<=$5 ORDER BY r.sequence LIMIT 4`,
      [id, taskId, userId, after, through]
    );
    return result.rows.map((row) => ({
      sequence: Number(row.sequence),
      previousHash: String(row.previous_hash),
      hash: String(row.hash),
      envelope: json<EncryptedEnvelope>(row.body_ciphertext)
    }));
  }
}
