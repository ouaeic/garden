import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nativeAuthorizationMessage, type NativeAuthorizationProof } from '@garden/contracts';
import { sha256 } from '@garden/core';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore } from './store.js';
import { NativeAuthorizationStore } from './native-authorizations.js';

describe('device-bound browser authorization', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database),
    auth = new NativeAuthorizationStore(database, 300);
  const origin = 'https://garden.example',
    nativeOrigin = 'http://localhost:49152';
  let userId = '',
    otherUserId = '';
  beforeAll(async () => {
    await migrateDatabase(database);
    userId = (await store.createUser({ username: 'native-owner', displayName: 'Owner' })).id;
    otherUserId = (
      await store.createUser({ username: 'other-native-owner', displayName: 'Other owner' })
    ).id;
  });
  beforeEach(async () => {
    await database.exec('DELETE FROM native_authorizations; DELETE FROM sessions');
  });
  afterAll(() => database.close());
  async function request(purpose: 'sign_in' | 'step_up' = 'sign_in') {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const sessionHash = sha256('native-existing-session');
    if (purpose === 'step_up')
      await store.createSession(userId, sessionHash, new Date(Date.now() + 60_000));
    const authorization = await auth.start({
      purpose,
      nativeOrigin,
      challenge,
      devicePublicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      serverOrigin: origin,
      deviceLabel: 'garden app on Android',
      ...(purpose === 'step_up' ? { userId, sessionHash } : {})
    });
    const proof = (action: 'redeem' | 'cancel' = 'redeem'): NativeAuthorizationProof => ({
      id: authorization.id,
      verifier,
      action,
      nativeOrigin,
      signature: sign(
        'sha256',
        Buffer.from(
          nativeAuthorizationMessage({
            id: authorization.id,
            serverOrigin: origin,
            nativeOrigin,
            purpose,
            challenge,
            action
          })
        ),
        { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }
      ).toString('base64url')
    });
    return { authorization, proof, sessionHash };
  }
  async function approve(value: Awaited<ReturnType<typeof request>>, approve = true) {
    const sessionHash = sha256('browser-owner-session');
    await store.createSession(
      userId,
      sessionHash,
      new Date(Date.now() + 60_000),
      undefined,
      'Owner browser',
      true
    );
    return auth.decide({
      id: value.authorization.id,
      serverOrigin: origin,
      userId,
      sessionHash,
      userCode: value.authorization.userCode,
      approve
    });
  }
  const redeem = (
    value: Awaited<ReturnType<typeof request>>,
    change: Partial<NativeAuthorizationProof> = {}
  ) =>
    auth.redeem({
      ...value.proof(),
      ...change,
      serverOrigin: origin,
      sessionHash: value.sessionHash,
      sessionLifetimeSeconds: 60
    });

  it('requires both device proofs and fresh browser authorization before creating one native session', async () => {
    const value = await request();
    expect((await redeem(value)).status).toBe('pending');
    await approve(value);
    const results = await Promise.allSettled([redeem(value), redeem(value)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const success = results.find((result) => result.status === 'fulfilled');
    expect(success?.status === 'fulfilled' && success.value.status).toBe('authorized');
    const sessions = await database.query('SELECT device_label FROM sessions WHERE user_id=$1', [
      userId
    ]);
    expect(sessions.rows).toHaveLength(2);
    expect(sessions.rows.some((row) => row.device_label === 'garden app on Android')).toBe(true);
  });
  it.each(['verifier', 'signature', 'nativeOrigin'] as const)(
    'rejects a different %s without consuming approval',
    async (field) => {
      const value = await request();
      await approve(value);
      const changed =
        field === 'nativeOrigin'
          ? 'http://localhost:49153'
          : field === 'signature'
            ? randomBytes(64).toString('base64url')
            : randomBytes(32).toString('base64url');
      await expect(redeem(value, { [field]: changed })).rejects.toMatchObject({
        code: 'invalid_device_proof'
      });
      expect((await redeem(value)).status).toBe('authorized');
    }
  );
  it('binds signatures to their action, request and server', async () => {
    const value = await request(),
      other = await request();
    await approve(value);
    await expect(redeem(value, { action: 'cancel' })).rejects.toMatchObject({
      code: 'invalid_device_proof'
    });
    await expect(redeem(value, { id: other.authorization.id })).rejects.toMatchObject({
      code: 'invalid_device_proof'
    });
    await expect(
      auth.redeem({
        ...value.proof(),
        serverOrigin: 'https://different.example',
        sessionLifetimeSeconds: 60
      })
    ).rejects.toMatchObject({ code: 'invalid_device_proof' });
    expect((await redeem(value)).status).toBe('authorized');
  });
  it('requires a passkey newer than the device request and confirmation of its visible code', async () => {
    const value = await request();
    const sessionHash = sha256('stale-browser');
    await store.createSession(
      userId,
      sessionHash,
      new Date(Date.now() + 60_000),
      undefined,
      'Browser',
      true
    );
    await database.query(
      "UPDATE sessions SET step_up_at=NOW()-INTERVAL '1 minute' WHERE id_hash=$1",
      [sessionHash]
    );
    const input = {
      id: value.authorization.id,
      serverOrigin: origin,
      userId,
      sessionHash,
      userCode: value.authorization.userCode,
      approve: true
    };
    await expect(auth.decide(input)).rejects.toMatchObject({ code: 'fresh_passkey_required' });
    await store.markSessionStepUp(userId, sessionHash);
    await expect(auth.decide({ ...input, userCode: 'WRNG-CODE' })).rejects.toMatchObject({
      code: 'device_code_mismatch'
    });
    expect((await auth.decide(input)).status).toBe('approved');
  });
  it.each(['deny', 'expire', 'revoke_browser', 'cancel'] as const)(
    'does not issue a session after %s',
    async (action) => {
      const value = await request();
      await approve(value, action !== 'deny');
      if (action === 'expire')
        await database.query(
          "UPDATE native_authorizations SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
          [value.authorization.id]
        );
      if (action === 'revoke_browser') await store.deleteSession(sha256('browser-owner-session'));
      if (action === 'cancel')
        await auth.redeem({
          ...value.proof('cancel'),
          serverOrigin: origin,
          sessionLifetimeSeconds: 60
        });
      const result = await redeem(value).catch(() => null);
      expect(result?.status).not.toBe('authorized');
      expect(
        (await database.query("SELECT 1 FROM sessions WHERE device_label='garden app on Android'"))
          .rowCount
      ).toBe(0);
    }
  );
  it('steps up only the bound native session and refuses another browser owner', async () => {
    const value = await request('step_up');
    await expect(auth.inspect(value.authorization.id, origin, otherUserId)).rejects.toThrow();
    await store.createSession(
      otherUserId,
      sha256('other-session'),
      new Date(Date.now() + 60_000),
      undefined,
      'Other browser',
      true
    );
    await expect(
      auth.decide({
        id: value.authorization.id,
        serverOrigin: origin,
        userId: otherUserId,
        sessionHash: sha256('other-session'),
        userCode: value.authorization.userCode,
        approve: true
      })
    ).rejects.toThrow();
    await approve(value);
    await expect(
      auth.redeem({
        ...value.proof(),
        serverOrigin: origin,
        sessionHash: sha256('another-native-session'),
        sessionLifetimeSeconds: 60
      })
    ).rejects.toMatchObject({ code: 'native_session_mismatch' });
    const result = await redeem(value);
    expect(result.status).toBe('authorized');
    expect(result.status === 'authorized' && result.token).toBeNull();
    expect(await store.hasRecentSessionStepUp(userId, value.sessionHash)).toBe(true);
  });
  it('rolls back session creation if the authorization cannot be consumed', async () => {
    const value = await request();
    await approve(value);
    await database.exec(`CREATE FUNCTION fail_native_auth_consume() RETURNS trigger AS $$ BEGIN IF NEW.status='consumed' THEN RAISE EXCEPTION 'consume write failed'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_native_auth BEFORE UPDATE ON native_authorizations FOR EACH ROW EXECUTE FUNCTION fail_native_auth_consume();`);
    try {
      await expect(redeem(value)).rejects.toThrow('consume write failed');
    } finally {
      await database.exec(
        'DROP TRIGGER fail_native_auth ON native_authorizations; DROP FUNCTION fail_native_auth_consume()'
      );
    }
    expect(
      (await database.query("SELECT 1 FROM sessions WHERE device_label='garden app on Android'"))
        .rowCount
    ).toBe(0);
    expect((await redeem(value)).status).toBe('authorized');
  });
  it.each(['decision', 'redemption'] as const)(
    'retains database timestamp precision at %s freshness checks',
    async (stage) => {
      const value = await request();
      const sessionHash = sha256('browser-owner-session');
      if (stage === 'redemption') await approve(value);
      else
        await store.createSession(
          userId,
          sessionHash,
          new Date(Date.now() + 60_000),
          undefined,
          'Owner browser',
          true
        );
      await database.query(
        "UPDATE native_authorizations SET created_at=date_trunc('milliseconds',NOW())+INTERVAL '800 microseconds' WHERE id=$1",
        [value.authorization.id]
      );
      await database.query(
        "UPDATE sessions SET step_up_at=(SELECT created_at-INTERVAL '100 microseconds' FROM native_authorizations WHERE id=$2) WHERE id_hash=$1",
        [sessionHash, value.authorization.id]
      );
      expect(
        (
          await database.query(
            'SELECT s.step_up_at < a.created_at AS older FROM sessions s CROSS JOIN native_authorizations a WHERE s.id_hash=$1 AND a.id=$2',
            [sessionHash, value.authorization.id]
          )
        ).rows
      ).toEqual([{ older: true }]);
      const act = () =>
        stage === 'redemption'
          ? redeem(value)
          : auth.decide({
              id: value.authorization.id,
              serverOrigin: origin,
              userId,
              sessionHash,
              userCode: value.authorization.userCode,
              approve: true
            });
      await expect(act()).rejects.toMatchObject({
        code: stage === 'redemption' ? 'native_authorization_unavailable' : 'fresh_passkey_required'
      });
      await database.query(
        "UPDATE sessions SET step_up_at=(SELECT created_at+INTERVAL '100 microseconds' FROM native_authorizations WHERE id=$2) WHERE id_hash=$1",
        [sessionHash, value.authorization.id]
      );
      expect((await act()).status).toBe(stage === 'redemption' ? 'authorized' : 'approved');
    }
  );
});
