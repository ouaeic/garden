import type { EncryptedEnvelope } from '@athanor/core';
import { randomUUID } from 'node:crypto';
import type { Database } from '../database.js';
import type { ApiTokenRecord, PasskeyRecord, UserRecord } from '../types.js';
import { iso, json, mapApiToken, mapUser, optionalText } from './rows.js';

/**
 * Who the owner is, and what is currently allowed to speak for them: the one user row, the passkeys
 * that prove it, the sessions and device enrolments a passkey opens, the API tokens a client holds
 * instead of a session, and the idempotency ledger that stops a retried write happening twice.
 *
 * Lifted out of `store.ts` whole in Wave 6.3, method text unchanged - so every statement here is
 * the statement that was there. `DataStore` holds one of these and forwards to it under the same
 * public names, which is why nothing outside this package moved.
 */
export class IdentityStore {
  constructor(private readonly database: Database) {}

  async createUser(input: {
    username: string;
    displayName: string;
    recoveryHash?: string;
  }): Promise<UserRecord> {
    const result = await this.database.query(
      `INSERT INTO users(id, username, display_name, recovery_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [randomUUID(), input.username.toLowerCase(), input.displayName, input.recoveryHash ?? null]
    );
    return mapUser(result.rows[0]!);
  }

  async countUsers(): Promise<number> {
    const result = await this.database.query('SELECT COUNT(*) AS count FROM users');
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * The only account on this box, when there is exactly one - which is the shape athanor is for.
   *
   * `LIMIT 2` rather than `LIMIT 1` so one query answers "exactly one" instead of "at least one":
   * the caller needs to know there is nothing to disambiguate, not merely that somebody exists.
   */
  async soleUser(): Promise<UserRecord | null> {
    const result = await this.database.query('SELECT * FROM users LIMIT 2');
    return result.rows.length === 1 && result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const result = await this.database.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const result = await this.database.query('SELECT * FROM users WHERE username = $1', [
      username.toLowerCase()
    ]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async createChallenge(input: {
    username?: string;
    challenge: string;
    kind: 'registration' | 'authentication' | 'step_up' | 'recovery' | 'passkey_add';
    ttlSeconds?: number;
    expectedOrigin?: string;
    rpId?: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO auth_challenges(
        id, username, challenge, kind, expires_at, expected_origin, rp_id
      )
       VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 second'), $6, $7)`,
      [
        id,
        input.username?.toLowerCase() ?? null,
        input.challenge,
        input.kind,
        input.ttlSeconds ?? 300,
        input.expectedOrigin ?? null,
        input.rpId ?? null
      ]
    );
    return id;
  }

  async consumeChallenge(
    id: string,
    kind: string
  ): Promise<{
    username: string | null;
    challenge: string;
    expectedOrigin: string | null;
    rpId: string | null;
  } | null> {
    const result = await this.database.query(
      `DELETE FROM auth_challenges
       WHERE id = $1 AND kind = $2 AND expires_at > NOW()
       RETURNING username, challenge, expected_origin, rp_id`,
      [id, kind]
    );
    const row = result.rows[0];
    return row
      ? {
          username: optionalText(row.username),
          challenge: String(row.challenge),
          expectedOrigin: optionalText(row.expected_origin),
          rpId: optionalText(row.rp_id)
        }
      : null;
  }

  async addPasskey(input: Omit<PasskeyRecord, 'id' | 'createdAt'>): Promise<PasskeyRecord> {
    const id = randomUUID();
    const result = await this.database.query(
      `INSERT INTO passkeys(
        id, user_id, credential_id, public_key, counter, transports, device_type, backed_up
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
      [
        id,
        input.userId,
        input.credentialId,
        input.publicKey,
        input.counter,
        JSON.stringify(input.transports),
        input.deviceType,
        input.backedUp
      ]
    );
    const row = result.rows[0]!;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      credentialId: String(row.credential_id),
      publicKey: String(row.public_key),
      counter: Number(row.counter),
      transports: json<string[]>(row.transports),
      deviceType: String(row.device_type),
      backedUp: Boolean(row.backed_up),
      createdAt: iso(row.created_at)
    };
  }

  /**
   * Replaces the recovery code outright, for an owner who is already signed in and stepped up.
   *
   * Unconditional on the old hash, unlike the recovery path: this is not "prove you hold the old
   * code", it is "I have lost it, give me another", and the proof was the passkey ceremony that
   * had to happen first.
   */
  async setRecoveryHash(userId: string, hash: string): Promise<boolean> {
    const result = await this.database.query(
      'UPDATE users SET recovery_hash=$2,updated_at=NOW() WHERE id=$1',
      [userId, hash]
    );
    return result.rowCount === 1;
  }

  async replacePasskeysForRecovery(input: {
    userId: string;
    username: string;
    expectedRecoveryHash: string;
    newRecoveryHash: string;
    passkey: Omit<PasskeyRecord, 'id' | 'userId' | 'createdAt'>;
  }): Promise<PasskeyRecord> {
    return this.database.transaction(async (tx) => {
      const rotated = await tx.query(
        `UPDATE users SET recovery_hash=$3,updated_at=NOW()
         WHERE id=$1 AND recovery_hash=$2 RETURNING id`,
        [input.userId, input.expectedRecoveryHash, input.newRecoveryHash]
      );
      if (rotated.rowCount !== 1) throw new Error('Recovery code has already been rotated');
      await tx.query('DELETE FROM passkeys WHERE user_id=$1', [input.userId]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [input.userId]);
      await tx.query("DELETE FROM auth_challenges WHERE username=$1 AND kind='recovery'", [
        input.username.toLowerCase()
      ]);
      const id = randomUUID();
      const result = await tx.query(
        `INSERT INTO passkeys(
          id,user_id,credential_id,public_key,counter,transports,device_type,backed_up
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
        [
          id,
          input.userId,
          input.passkey.credentialId,
          input.passkey.publicKey,
          input.passkey.counter,
          JSON.stringify(input.passkey.transports),
          input.passkey.deviceType,
          input.passkey.backedUp
        ]
      );
      const row = result.rows[0]!;
      return {
        id: String(row.id),
        userId: String(row.user_id),
        credentialId: String(row.credential_id),
        publicKey: String(row.public_key),
        counter: Number(row.counter),
        transports: json<string[]>(row.transports),
        deviceType: String(row.device_type),
        backedUp: Boolean(row.backed_up),
        createdAt: iso(row.created_at)
      };
    });
  }

  async listPasskeys(userId: string): Promise<PasskeyRecord[]> {
    const result = await this.database.query('SELECT * FROM passkeys WHERE user_id = $1', [userId]);
    return result.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      credentialId: String(row.credential_id),
      publicKey: String(row.public_key),
      counter: Number(row.counter),
      transports: json<string[]>(row.transports),
      deviceType: String(row.device_type),
      backedUp: Boolean(row.backed_up),
      createdAt: iso(row.created_at)
    }));
  }

  async getPasskeyByCredentialId(credentialId: string): Promise<PasskeyRecord | null> {
    const result = await this.database.query('SELECT * FROM passkeys WHERE credential_id = $1', [
      credentialId
    ]);
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          userId: String(row.user_id),
          credentialId: String(row.credential_id),
          publicKey: String(row.public_key),
          counter: Number(row.counter),
          transports: json<string[]>(row.transports),
          deviceType: String(row.device_type),
          backedUp: Boolean(row.backed_up),
          createdAt: iso(row.created_at)
        }
      : null;
  }

  async deletePasskeyForUser(
    userId: string,
    passkeyId: string
  ): Promise<'deleted' | 'not_found' | 'last_passkey'> {
    return this.database.transaction(async (tx) => {
      const locked = await tx.query(
        'SELECT id FROM passkeys WHERE user_id=$1 ORDER BY created_at FOR UPDATE',
        [userId]
      );
      if (!locked.rows.some((row) => String(row.id) === passkeyId)) return 'not_found';
      if (locked.rows.length <= 1) return 'last_passkey';
      const deleted = await tx.query('DELETE FROM passkeys WHERE user_id=$1 AND id=$2', [
        userId,
        passkeyId
      ]);
      return deleted.rowCount === 1 ? 'deleted' : 'not_found';
    });
  }

  async updatePasskeyCounter(id: string, counter: number): Promise<void> {
    await this.database.query('UPDATE passkeys SET counter = $2 WHERE id = $1', [id, counter]);
  }

  async createSession(
    userId: string,
    idHash: string,
    expiresAt: Date,
    publicId = randomUUID(),
    deviceLabel = 'Unknown device',
    steppedUp = false
  ): Promise<string> {
    await this.database.query(
      `INSERT INTO sessions(id_hash,user_id,expires_at,public_id,device_label,step_up_at)
       VALUES ($1,$2,$3,$4,$5,CASE WHEN $6 THEN NOW() ELSE NULL END)`,
      [idHash, userId, expiresAt.toISOString(), publicId, deviceLabel, steppedUp]
    );
    return publicId;
  }

  /**
   * Resolves a session and slides its expiry.
   *
   * A fixed window signs an actively-used device out on a schedule, which is the behaviour people
   * recognise as "it keeps asking me to log in again". Renewing once the session is past halfway
   * through its window keeps an in-use device signed in indefinitely while an abandoned one still
   * lapses on time, and the halfway test means the common request writes no new expiry.
   * `renewedExpiresAt` is returned only when it moved, so the caller can refresh the cookie then
   * and not on every request.
   */
  async getSession(
    idHash: string,
    lifetimeSeconds: number
  ): Promise<{ user: UserRecord; renewedExpiresAt: Date | null } | null> {
    const result = await this.database.query(
      // The pre-update expiry is read in a CTE because RETURNING only exposes the new row, and
      // "did the CASE fire" cannot be recovered from the new value alone.
      `WITH previous AS (
         SELECT id_hash, expires_at
         FROM sessions
         WHERE id_hash = $1 AND expires_at > NOW()
       )
       UPDATE sessions s
         SET last_seen_at = NOW(),
             expires_at = CASE
               WHEN previous.expires_at < NOW() + make_interval(secs => $2 / 2.0)
                 THEN NOW() + make_interval(secs => $2)
               ELSE previous.expires_at
             END
       FROM previous
       WHERE s.id_hash = previous.id_hash
       RETURNING s.user_id, s.expires_at,
                 (previous.expires_at < NOW() + make_interval(secs => $2 / 2.0)) AS renewed`,
      [idHash, lifetimeSeconds]
    );
    const row = result.rows[0];
    const userId = optionalText(row?.user_id);
    if (!userId) return null;
    const user = await this.getUserById(userId);
    if (!user) return null;
    return {
      user,
      renewedExpiresAt: row?.renewed === true ? new Date(String(row.expires_at)) : null
    };
  }

  async createDeviceEnrollment(input: {
    userId: string;
    tokenHash: string;
    label: string;
    issuedBySession?: string;
    expiresAt: Date;
  }): Promise<{ id: string; expiresAt: string }> {
    const id = randomUUID();
    const result = await this.database.query(
      `INSERT INTO device_enrollments(id,user_id,token_hash,label,issued_by_session,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,expires_at`,
      [
        id,
        input.userId,
        input.tokenHash,
        input.label,
        input.issuedBySession ?? null,
        input.expiresAt.toISOString()
      ]
    );
    return { id, expiresAt: iso(result.rows[0]!.expires_at) };
  }

  /**
   * Redeems an enrollment exactly once. The consumed_at guard is inside the UPDATE so two devices
   * racing the same QR code cannot both succeed: the second matches no row.
   */
  /**
   * Whether this grant is still good, without spending it.
   *
   * The registration ceremony needs to know whose account it is building options for before the
   * authenticator has done anything, and that question used to be asked by consuming the grant. A
   * biometric prompt the owner dismissed - or an authenticator that timed out, or a phone that rang
   * mid-tap - therefore burned the link permanently, and the only way forward was to walk back to a
   * device that is already signed in and mint another one behind a passkey confirmation. Reading it
   * here and spending it in `consumeDeviceEnrollment` once a credential actually exists keeps the
   * same single-use guarantee: the UPDATE is still the only thing that marks it spent, so a second
   * device racing for the same link still loses.
   */
  async findDeviceEnrollment(tokenHash: string): Promise<{ userId: string } | null> {
    const result = await this.database.query(
      `SELECT user_id FROM device_enrollments
       WHERE token_hash = $1
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash]
    );
    const userId = optionalText(result.rows[0]?.user_id);
    return userId ? { userId } : null;
  }

  async consumeDeviceEnrollment(tokenHash: string): Promise<{ userId: string } | null> {
    const result = await this.database.query(
      `UPDATE device_enrollments SET consumed_at = NOW()
       WHERE token_hash = $1
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > NOW()
       RETURNING user_id`,
      [tokenHash]
    );
    const userId = optionalText(result.rows[0]?.user_id);
    return userId ? { userId } : null;
  }

  async listDeviceEnrollments(userId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT id,label,created_at,expires_at,consumed_at,revoked_at
       FROM device_enrollments
       WHERE user_id=$1 AND created_at > NOW() - INTERVAL '7 days'
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      status: row.revoked_at
        ? 'revoked'
        : row.consumed_at
          ? 'used'
          : new Date(String(row.expires_at)).getTime() <= Date.now()
            ? 'expired'
            : 'pending'
    }));
  }

  async revokeDeviceEnrollment(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE device_enrollments SET revoked_at = NOW()
       WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL
       RETURNING id`,
      [id, userId]
    );
    return Boolean(result.rows[0]);
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.database.query('DELETE FROM sessions WHERE id_hash = $1', [idHash]);
  }

  async listSessions(userId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT public_id,device_label,created_at,last_seen_at,expires_at
       FROM sessions WHERE user_id=$1 AND public_id IS NOT NULL AND expires_at>NOW()
       ORDER BY last_seen_at DESC`,
      [userId]
    );
    return result.rows.map((row) => ({
      id: String(row.public_id),
      deviceLabel: optionalText(row.device_label) ?? 'Unknown device',
      createdAt: iso(row.created_at),
      lastSeenAt: iso(row.last_seen_at),
      expiresAt: iso(row.expires_at)
    }));
  }

  async getSessionPublicId(userId: string, idHash: string): Promise<string | null> {
    const result = await this.database.query(
      'SELECT public_id FROM sessions WHERE user_id=$1 AND id_hash=$2 AND expires_at>NOW()',
      [userId, idHash]
    );
    return optionalText(result.rows[0]?.public_id);
  }

  async markSessionStepUp(userId: string, idHash: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE sessions SET step_up_at=NOW(),last_seen_at=NOW()
       WHERE user_id=$1 AND id_hash=$2 AND expires_at>NOW()`,
      [userId, idHash]
    );
    return result.rowCount === 1;
  }

  async hasRecentSessionStepUp(
    userId: string,
    idHash: string,
    maxAgeSeconds = 300
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
    const result = await this.database.query(
      `SELECT 1 FROM sessions WHERE user_id=$1 AND id_hash=$2 AND expires_at>NOW()
       AND step_up_at >= $3`,
      [userId, idHash, cutoff]
    );
    return result.rowCount === 1;
  }

  async deleteSessionForUser(userId: string, publicId: string): Promise<string | null> {
    const result = await this.database.query(
      'DELETE FROM sessions WHERE user_id=$1 AND public_id=$2 RETURNING id_hash',
      [userId, publicId]
    );
    return result.rows[0] ? String(result.rows[0].id_hash) : null;
  }

  async createApiToken(input: {
    userId: string;
    label: string;
    tokenHash: string;
    prefix: string;
    scopes: ApiTokenRecord['scopes'];
    expiresAt: Date;
  }): Promise<ApiTokenRecord> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const count = await tx.query(
        `SELECT COUNT(*) AS count FROM api_tokens
         WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW()`,
        [input.userId]
      );
      if (Number(count.rows[0]?.count ?? 0) >= 10) throw new Error('api_token_limit');
      const result = await tx.query(
        `INSERT INTO api_tokens(id,user_id,label,token_hash,token_prefix,scopes,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
        [
          randomUUID(),
          input.userId,
          input.label,
          input.tokenHash,
          input.prefix,
          JSON.stringify(input.scopes),
          input.expiresAt.toISOString()
        ]
      );
      return mapApiToken(result.rows[0]!);
    });
  }

  async authenticateApiToken(
    tokenHash: string
  ): Promise<{ token: ApiTokenRecord; user: UserRecord } | null> {
    const result = await this.database.query(
      `UPDATE api_tokens SET last_used_at=NOW()
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>NOW()
       RETURNING *`,
      [tokenHash]
    );
    if (!result.rows[0]) return null;
    const token = mapApiToken(result.rows[0]);
    const user = await this.getUserById(token.userId);
    return user ? { token, user } : null;
  }

  async listApiTokens(userId: string): Promise<ApiTokenRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM api_tokens
       WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW()
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map(mapApiToken);
  }

  async revokeApiToken(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE api_tokens SET revoked_at=NOW()
       WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL`,
      [userId, id]
    );
    return result.rowCount === 1;
  }

  async beginOperation(input: {
    userId: string;
    idempotencyKey: string;
    method: string;
    path: string;
    requestHash: string;
    ttlHours?: number;
    replayOnly?: boolean;
  }): Promise<{
    state: string;
    method: string;
    path: string;
    requestHash: string;
    responseStatus: number | null;
    responseCiphertext: EncryptedEnvelope | null;
  } | null> {
    if (!input.replayOnly) {
      const inserted = await this.database.query(
        `INSERT INTO api_operations(user_id,idempotency_key,method,path,request_hash,state,expires_at)
       VALUES ($1,$2,$3,$4,$5,'running',NOW()+($6 * INTERVAL '1 hour'))
       ON CONFLICT(user_id,idempotency_key) DO NOTHING
       RETURNING state`,
        [
          input.userId,
          input.idempotencyKey,
          input.method,
          input.path,
          input.requestHash,
          input.ttlHours ?? 24
        ]
      );
      if (inserted.rowCount === 1) return null;
    }
    const existing = await this.database.query(
      `SELECT state,method,path,request_hash,response_status,response_ciphertext FROM api_operations
       WHERE user_id=$1 AND idempotency_key=$2`,
      [input.userId, input.idempotencyKey]
    );
    const row = existing.rows[0];
    return row
      ? {
          state: String(row.state),
          method: String(row.method),
          path: String(row.path),
          requestHash: String(row.request_hash),
          responseStatus: row.response_status === null ? null : Number(row.response_status),
          responseCiphertext:
            row.response_ciphertext === null ? null : json(row.response_ciphertext)
        }
      : null;
  }

  async completeOperation(
    userId: string,
    idempotencyKey: string,
    status: number,
    body: EncryptedEnvelope
  ): Promise<void> {
    await this.database.query(
      `UPDATE api_operations SET state='completed',response_status=$3,response_body=NULL,response_ciphertext=$4::jsonb,updated_at=NOW()
       WHERE user_id=$1 AND idempotency_key=$2 AND state <> 'completed'`,
      [userId, idempotencyKey, status, JSON.stringify(body)]
    );
  }

  async failOperation(userId: string, idempotencyKey: string): Promise<void> {
    await this.database.query(
      `UPDATE api_operations SET state='failed',updated_at=NOW() WHERE user_id=$1 AND idempotency_key=$2 AND state='running'`,
      [userId, idempotencyKey]
    );
  }

  async recordSecurityEvent(input: {
    userId?: string;
    kind: string;
    outcome: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO security_events(id,user_id,kind,outcome,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        randomUUID(),
        input.userId ?? null,
        input.kind,
        input.outcome,
        JSON.stringify(input.metadata ?? {})
      ]
    );
  }
}
