import { randomUUID } from 'node:crypto';
import type { EncryptedEnvelope } from '@garden/core';
import type { Database } from '../database.js';
import type { TaskShareArtifactRecord, TaskShareRecord } from '../types.js';
import { iso, json, optionalText } from './rows.js';

/**
 * Share links: the rows behind `/v1/shares/<id>#<key>`.
 *
 * Nothing in this file can read a share. The envelope on the row was sealed under a key the API
 * generated, returned once inside the link, and discarded; the lookup hash is the SHA-256 of a
 * path segment the box never stores. What this store does is find a row for a hash, count views,
 * and keep the owner's list - and refuse to answer for a row that is revoked or expired, in the
 * same statement that finds it, so that "not live" and "not there" are one answer.
 */

/** A row is live when the owner has not revoked it and its expiry, if it has one, is ahead. */
const LIVE = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())';

const mapShare = (row: Record<string, unknown>): TaskShareRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  taskId: String(row.task_id),
  workspaceId: String(row.workspace_id),
  lookupHash: String(row.lookup_hash),
  envelope: json<EncryptedEnvelope>(row.envelope),
  manifest: json<Array<{ n: number; sizeBytes: number }>>(row.manifest ?? '[]'),
  snapshotBytes: Number(row.snapshot_bytes ?? 0),
  version: Number(row.version ?? 1),
  expiresAt: row.expires_at ? iso(row.expires_at) : null,
  viewCount: Number(row.view_count ?? 0),
  lastViewedAt: row.last_viewed_at ? iso(row.last_viewed_at) : null,
  revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

/**
 * `bytea` comes back as a `Buffer` from PostgreSQL and as a `Uint8Array` from the embedded
 * database; one shape leaves this file. A driver that handed the column back as its hex text is
 * decoded from that, and anything else is treated as no bytes rather than as a string.
 */
const bytes = (value: unknown): Buffer =>
  Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : typeof value === 'string'
        ? Buffer.from(value.replace(/^\\x/, ''), 'hex')
        : Buffer.alloc(0);

export class ShareStore {
  constructor(private readonly database: Database) {}

  /**
   * One link, whole: the row and every artifact it carries, in one transaction, so a link that
   * exists always has every byte it promises.
   */
  async createShare(input: {
    userId: string;
    taskId: string;
    workspaceId: string;
    lookupHash: string;
    envelope: EncryptedEnvelope;
    manifest: Array<{ n: number; sizeBytes: number }>;
    snapshotBytes: number;
    expiresAt: Date | null;
    version?: number;
    artifacts: Array<{
      n: number;
      envelopeMeta: Omit<EncryptedEnvelope, 'ciphertext'>;
      ciphertext: Uint8Array;
      sizeBytes: number;
    }>;
  }): Promise<TaskShareRecord> {
    return this.database.transaction(async (tx) => {
      const id = randomUUID();
      const result = await tx.query(
        `INSERT INTO task_shares(
           id,user_id,task_id,workspace_id,lookup_hash,envelope,manifest,snapshot_bytes,version,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10) RETURNING *`,
        [
          id,
          input.userId,
          input.taskId,
          input.workspaceId,
          input.lookupHash,
          JSON.stringify(input.envelope),
          JSON.stringify(input.manifest),
          input.snapshotBytes,
          input.version ?? 1,
          input.expiresAt
        ]
      );
      for (const artifact of input.artifacts) {
        await tx.query(
          `INSERT INTO task_share_artifacts(share_id,n,envelope_meta,ciphertext,size_bytes)
           VALUES ($1,$2,$3::jsonb,$4,$5)`,
          [
            id,
            artifact.n,
            JSON.stringify(artifact.envelopeMeta),
            Buffer.from(artifact.ciphertext),
            artifact.sizeBytes
          ]
        );
      }
      return mapShare(result.rows[0]!);
    });
  }

  async listSharesForTask(userId: string, taskId: string): Promise<TaskShareRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM task_shares WHERE user_id=$1 AND task_id=$2 ORDER BY created_at DESC, id`,
      [userId, taskId]
    );
    return result.rows.map(mapShare);
  }

  async listShares(userId: string): Promise<TaskShareRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM task_shares WHERE user_id=$1 ORDER BY created_at DESC, id LIMIT 500`,
      [userId]
    );
    return result.rows.map(mapShare);
  }

  async getShareForOwner(userId: string, shareId: string): Promise<TaskShareRecord | null> {
    const result = await this.database.query(
      `SELECT * FROM task_shares WHERE id=$1 AND user_id=$2`,
      [shareId, userId]
    );
    return result.rows[0] ? mapShare(result.rows[0]) : null;
  }

  /**
   * Revocation is immediate and takes the bytes with it. The row stays, marked, so the owner's
   * list can still say a link existed and when it was closed; the artifact rows are the only part
   * of a share that is large, and nothing will ever serve them again.
   */
  async revokeShare(userId: string, shareId: string): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE task_shares SET revoked_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`,
        [shareId, userId]
      );
      if (!result.rows[0]) return false;
      await tx.query('DELETE FROM task_share_artifacts WHERE share_id=$1', [shareId]);
      return true;
    });
  }

  /** Every live link the owner has, or every live link on one conversation. Returns how many. */
  async revokeAllShares(userId: string, taskId?: string): Promise<number> {
    return this.database.transaction(async (tx) => {
      const result = await tx.query(
        taskId
          ? `UPDATE task_shares SET revoked_at=NOW(), updated_at=NOW()
             WHERE user_id=$1 AND task_id=$2 AND revoked_at IS NULL RETURNING id`
          : `UPDATE task_shares SET revoked_at=NOW(), updated_at=NOW()
             WHERE user_id=$1 AND revoked_at IS NULL RETURNING id`,
        taskId ? [userId, taskId] : [userId]
      );
      for (const row of result.rows)
        await tx.query('DELETE FROM task_share_artifacts WHERE share_id=$1', [String(row.id)]);
      return result.rowCount;
    });
  }

  /**
   * The public lookup. One statement answers "is there a link this hash names, and is it still
   * open" - a revoked row, an expired row and a missing row all come back as null, so the route
   * above has exactly one branch to take for all three.
   */
  async findLiveShareByHash(lookupHash: string): Promise<TaskShareRecord | null> {
    const result = await this.database.query(
      `SELECT * FROM task_shares WHERE lookup_hash=$1 AND ${LIVE}`,
      [lookupHash]
    );
    return result.rows[0] ? mapShare(result.rows[0]) : null;
  }

  /** A view is a count and a time. Nothing about who. */
  async recordView(shareId: string): Promise<void> {
    await this.database.query(
      `UPDATE task_shares SET view_count=view_count+1, last_viewed_at=NOW() WHERE id=$1`,
      [shareId]
    );
  }

  /** The public half of every artifact envelope on a share, in manifest order. */
  async listShareArtifactEnvelopes(
    shareId: string
  ): Promise<
    Array<{ n: number; sizeBytes: number; envelopeMeta: Omit<EncryptedEnvelope, 'ciphertext'> }>
  > {
    const result = await this.database.query(
      `SELECT n, size_bytes, envelope_meta FROM task_share_artifacts WHERE share_id=$1 ORDER BY n`,
      [shareId]
    );
    return result.rows.map((row) => ({
      n: Number(row.n),
      sizeBytes: Number(row.size_bytes),
      envelopeMeta: json<Omit<EncryptedEnvelope, 'ciphertext'>>(row.envelope_meta)
    }));
  }

  async getShareArtifact(shareId: string, n: number): Promise<TaskShareArtifactRecord | null> {
    const result = await this.database.query(
      `SELECT * FROM task_share_artifacts WHERE share_id=$1 AND n=$2`,
      [shareId, n]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      shareId: String(row.share_id),
      n: Number(row.n),
      envelopeMeta: json<Omit<EncryptedEnvelope, 'ciphertext'>>(row.envelope_meta),
      ciphertext: bytes(row.ciphertext),
      sizeBytes: Number(row.size_bytes)
    };
  }

  /** Live links on one conversation, which is what the badge on it shows. */
  async countSharesForTask(taskId: string): Promise<number> {
    const result = await this.database.query(
      `SELECT COUNT(*) AS count FROM task_shares WHERE task_id=$1 AND ${LIVE}`,
      [taskId]
    );
    return Number(optionalText(result.rows[0]?.count) ?? 0);
  }
}
