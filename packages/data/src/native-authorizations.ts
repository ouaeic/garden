import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify
} from 'node:crypto';
import { GardenError, sha256 } from '@garden/core';
import {
  nativeAuthorizationMessage,
  type NativeAuthorization,
  type NativeAuthorizationProof,
  type NativeAuthorizationStart
} from '@garden/contracts';
import type { Database } from './database.js';

type Row = Record<string, unknown> & {
  id: string;
  purpose: NativeAuthorization['purpose'];
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  server_origin: string;
  native_origin: string;
  challenge: string;
  device_public_key: string;
  device_label: string;
  user_code: string;
  user_id: string | null;
  target_session_hash: string | null;
  approving_session_hash: string | null;
  created_at: string | Date;
  expires_at: string | Date;
};
const unavailable = () =>
  new GardenError(
    'native_authorization_unavailable',
    'This device authorization is unavailable or has expired. Start again in garden.',
    409
  );
const iso = (value: string | Date) => new Date(value).toISOString();
const present = (row: Row): NativeAuthorization => ({
  id: row.id,
  purpose: row.purpose,
  status: new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : row.status,
  serverOrigin: row.server_origin,
  deviceLabel: row.device_label,
  userCode: row.user_code,
  expiresAt: iso(row.expires_at)
});
export function validateNativeOrigin(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== 'localhost' || !url.port || url.origin !== value)
    throw new GardenError(
      'invalid_native_origin',
      'Device authorization requires an exact local garden address',
      400
    );
}
export function nativeDevicePublicKey(value: string) {
  try {
    const key = createPublicKey({
      key: Buffer.from(value, 'base64url'),
      format: 'der',
      type: 'spki'
    });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      throw new Error();
    if (key.export({ format: 'der', type: 'spki' }).toString('base64url') !== value)
      throw new Error();
    return key;
  } catch {
    throw new GardenError('invalid_device_key', 'The device authorization key is invalid', 400);
  }
}
function prove(row: Row, input: NativeAuthorizationProof, serverOrigin: string) {
  const challenge = createHash('sha256').update(input.verifier).digest('base64url');
  if (
    row.server_origin !== serverOrigin ||
    row.native_origin !== input.nativeOrigin ||
    challenge.length !== row.challenge.length ||
    !timingSafeEqual(Buffer.from(challenge), Buffer.from(row.challenge)) ||
    !verify(
      'sha256',
      Buffer.from(
        nativeAuthorizationMessage({
          id: row.id,
          serverOrigin,
          nativeOrigin: row.native_origin,
          purpose: row.purpose,
          challenge: row.challenge,
          action: input.action
        })
      ),
      { key: nativeDevicePublicKey(row.device_public_key), dsaEncoding: 'ieee-p1363' },
      Buffer.from(input.signature, 'base64url')
    )
  )
    throw new GardenError(
      'invalid_device_proof',
      'This authorization belongs to a different device or server',
      403
    );
}

/** Authorization creates a native session; no existing browser cookie leaves its origin. */
export class NativeAuthorizationStore {
  constructor(
    private readonly database: Database,
    private readonly stepUpWindowSeconds: number
  ) {}

  async start(
    input: NativeAuthorizationStart & {
      serverOrigin: string;
      deviceLabel: string;
      userId?: string;
      sessionHash?: string;
    }
  ): Promise<NativeAuthorization> {
    validateNativeOrigin(input.nativeOrigin);
    nativeDevicePublicKey(input.devicePublicKey);
    if (input.purpose === 'step_up' && (!input.userId || !input.sessionHash))
      throw new GardenError('authentication_required', 'Sign in before verifying this device', 401);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(randomBytes(8), (value) => alphabet[value % alphabet.length]).join('');
    return this.database.transaction(async (db) => {
      await db.query('DELETE FROM native_authorizations WHERE expires_at < NOW()');
      if (
        Number(
          (await db.query('SELECT COUNT(*) AS count FROM native_authorizations')).rows[0]?.count
        ) >= 1000
      )
        throw new GardenError(
          'native_authorization_busy',
          'Device authorization is temporarily busy. Try again shortly.',
          503
        );
      if (input.purpose === 'step_up') {
        const session = await db.query(
          'SELECT 1 FROM sessions WHERE id_hash=$1 AND user_id=$2 AND expires_at>NOW() FOR UPDATE',
          [input.sessionHash, input.userId]
        );
        if (!session.rowCount) throw unavailable();
      }
      const result = await db.query<Row>(
        `INSERT INTO native_authorizations
        (id,purpose,server_origin,native_origin,challenge,device_public_key,device_label,user_code,user_id,target_session_hash,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()+INTERVAL '10 minutes') RETURNING *`,
        [
          randomUUID(),
          input.purpose,
          input.serverOrigin,
          input.nativeOrigin,
          input.challenge,
          input.devicePublicKey,
          input.deviceLabel,
          `${code.slice(0, 4)}-${code.slice(4)}`,
          input.purpose === 'step_up' ? input.userId : null,
          input.purpose === 'step_up' ? input.sessionHash : null
        ]
      );
      return present(result.rows[0]!);
    });
  }

  async inspect(id: string, serverOrigin: string, userId: string): Promise<NativeAuthorization> {
    const row = (
      await this.database.query<Row>(
        'SELECT * FROM native_authorizations WHERE id=$1 AND server_origin=$2',
        [id, serverOrigin]
      )
    ).rows[0];
    if (!row || (row.user_id !== null && row.user_id !== userId)) throw unavailable();
    return present(row);
  }

  async decide(input: {
    id: string;
    serverOrigin: string;
    userId: string;
    sessionHash: string;
    userCode: string;
    approve: boolean;
  }): Promise<NativeAuthorization> {
    return this.database.transaction(async (db) => {
      const row = (
        await db.query<Row>(
          'SELECT * FROM native_authorizations WHERE id=$1 AND server_origin=$2 FOR UPDATE',
          [input.id, input.serverOrigin]
        )
      ).rows[0];
      if (
        !row ||
        row.status !== 'pending' ||
        new Date(row.expires_at).getTime() <= Date.now() ||
        (row.user_id !== null && row.user_id !== input.userId)
      )
        throw unavailable();
      if (row.user_code !== input.userCode)
        throw new GardenError(
          'device_code_mismatch',
          'Confirm the code displayed by your garden app',
          400
        );
      const session = await db.query(
        `SELECT 1 FROM sessions WHERE id_hash=$1 AND user_id=$2 AND expires_at>NOW()
        AND ($3::boolean=FALSE OR (step_up_at >= (SELECT created_at FROM native_authorizations WHERE id=$4) AND step_up_at >= NOW()-make_interval(secs => $5))) FOR UPDATE`,
        [input.sessionHash, input.userId, input.approve, row.id, this.stepUpWindowSeconds]
      );
      if (!session.rowCount)
        throw new GardenError(
          'fresh_passkey_required',
          'Verify your passkey for this device request',
          403
        );
      const result = await db.query<Row>(
        `UPDATE native_authorizations SET status=$2,user_id=$3,approving_session_hash=$4 WHERE id=$1 RETURNING *`,
        [row.id, input.approve ? 'approved' : 'denied', input.userId, input.sessionHash]
      );
      await db.query(
        `INSERT INTO security_events(id,user_id,kind,outcome,metadata) VALUES($1,$2,'native_authorization',$3,$4::jsonb)`,
        [
          randomUUID(),
          input.userId,
          input.approve ? 'approved' : 'denied',
          JSON.stringify({ authorizationId: row.id, purpose: row.purpose })
        ]
      );
      return present(result.rows[0]!);
    });
  }

  async redeem(
    input: NativeAuthorizationProof & {
      serverOrigin: string;
      sessionHash?: string;
      sessionLifetimeSeconds: number;
    }
  ): Promise<
    | { status: 'pending' | 'denied'; authorization: NativeAuthorization }
    | { status: 'authorized'; userId: string; token: string | null; expiresAt: Date | null }
  > {
    return this.database.transaction(async (db) => {
      const row = (
        await db.query<Row>('SELECT * FROM native_authorizations WHERE id=$1 FOR UPDATE', [
          input.id
        ])
      ).rows[0];
      if (!row || new Date(row.expires_at).getTime() <= Date.now() || row.status === 'consumed')
        throw unavailable();
      prove(row, input, input.serverOrigin);
      if (row.purpose === 'step_up' && input.sessionHash !== row.target_session_hash)
        throw new GardenError(
          'native_session_mismatch',
          'Verify the same garden session that requested authorization',
          403
        );
      if (input.action === 'cancel') {
        await db.query("UPDATE native_authorizations SET status='denied' WHERE id=$1", [row.id]);
        return { status: 'denied', authorization: { ...present(row), status: 'denied' } };
      }
      if (row.status !== 'approved') return { status: row.status, authorization: present(row) };
      if (!row.user_id || !row.approving_session_hash) throw unavailable();
      const owner = await db.query(
        `SELECT 1 FROM sessions WHERE id_hash=$1 AND user_id=$2 AND expires_at>NOW()
        AND step_up_at >= (SELECT created_at FROM native_authorizations WHERE id=$3) AND step_up_at >= NOW()-make_interval(secs => $4) FOR UPDATE`,
        [row.approving_session_hash, row.user_id, row.id, this.stepUpWindowSeconds]
      );
      if (!owner.rowCount) throw unavailable();
      let token: string | null = null,
        expiresAt: Date | null = null;
      if (row.purpose === 'step_up') {
        const updated = await db.query(
          'UPDATE sessions SET step_up_at=NOW(),last_seen_at=NOW() WHERE id_hash=$1 AND user_id=$2 AND expires_at>NOW()',
          [row.target_session_hash, row.user_id]
        );
        if (updated.rowCount !== 1) throw unavailable();
      } else {
        token = randomBytes(32).toString('base64url');
        expiresAt = new Date(Date.now() + input.sessionLifetimeSeconds * 1000);
        await db.query(
          `INSERT INTO sessions(id_hash,user_id,expires_at,public_id,device_label,step_up_at) VALUES($1,$2,$3,$4,$5,NOW())`,
          [sha256(token), row.user_id, expiresAt.toISOString(), randomUUID(), row.device_label]
        );
      }
      await db.query(
        "UPDATE native_authorizations SET status='consumed',consumed_at=NOW() WHERE id=$1",
        [row.id]
      );
      await db.query(
        `INSERT INTO security_events(id,user_id,kind,outcome,metadata) VALUES($1,$2,'native_authorization','completed',$3::jsonb)`,
        [
          randomUUID(),
          row.user_id,
          JSON.stringify({ authorizationId: row.id, purpose: row.purpose })
        ]
      );
      return { status: 'authorized', userId: row.user_id, token, expiresAt };
    });
  }
}
