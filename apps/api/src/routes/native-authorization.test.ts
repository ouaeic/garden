import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nativeAuthorizationMessage, type NativeAuthorization } from '@garden/contracts';
import { sha256 } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { registerAuthHooks } from '../http/auth-hook.js';
import { registerErrorHandler } from '../http/errors.js';
import { registerAuthRoutes } from '../auth-routes.js';
import { silentLogger } from '../log.js';
import { sessionCookieName } from '../session.js';
import type { RouteContext } from '../http/server-context.js';
import { registerNativeAuthorizationRoutes } from './native-authorization.js';

const origin = 'https://garden.example',
  nativeOrigin = 'http://localhost:49152';
describe('native authorization HTTP boundary', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database),
    app = Fastify();
  const throttled: string[] = [],
    polled: string[] = [];
  let ownerId = '';
  const token = randomBytes(32).toString('base64url');
  const browserHeaders = { cookie: `${sessionCookieName(true)}=${token}`, origin };
  beforeAll(async () => {
    await migrateDatabase(database);
    ownerId = (await store.createUser({ username: 'browser-owner', displayName: 'Owner' })).id;
    await store.addPasskey({
      userId: ownerId,
      credentialId: 'device-credential',
      publicKey: 'AA',
      counter: 0,
      transports: [],
      deviceType: 'singleDevice',
      backedUp: false
    });
    await app.register(cookie);
    app.decorateRequest('user', null);
    app.decorateRequest('apiToken', null);
    const context = {
      app,
      database,
      store,
      secure: true,
      log: silentLogger,
      requestStarted: new WeakMap(),
      checkAuthRate: (key: string) => throttled.push(key),
      checkShareRate: (key: string) => polled.push(key),
      config: {
        PUBLIC_APP_URL: origin,
        WEBAUTHN_ORIGIN: origin,
        WEBAUTHN_RP_ID: 'garden.example',
        WEBAUTHN_RP_NAME: 'garden'
      }
    } as unknown as RouteContext;
    registerErrorHandler(context);
    registerAuthHooks(context);
    registerAuthRoutes(app, store, context.config);
    registerNativeAuthorizationRoutes(context);
    app.get('/v1/probe/who', (request) => ({ userId: request.user?.id }));
  });
  beforeEach(async () => {
    await database.exec(
      'DELETE FROM native_authorizations; DELETE FROM sessions; DELETE FROM security_events'
    );
    await store.createSession(
      ownerId,
      sha256(token),
      new Date(Date.now() + 86400000),
      undefined,
      'Owner browser',
      true
    );
    throttled.length = 0;
    polled.length = 0;
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });
  async function start(extra: Record<string, unknown> = {}) {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const payload = {
      purpose: 'sign_in',
      nativeOrigin,
      challenge,
      devicePublicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      ...extra
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/native/start',
      headers: { origin, 'x-garden-client': 'garden-android/0.1.1' },
      payload
    });
    const authorization = response.json<NativeAuthorization & { verificationUri: string }>();
    const proof = (action: 'redeem' | 'cancel' = 'redeem') => ({
      id: authorization.id,
      verifier,
      nativeOrigin,
      action,
      signature: sign(
        'sha256',
        Buffer.from(
          nativeAuthorizationMessage({
            id: authorization.id,
            serverOrigin: origin,
            nativeOrigin,
            purpose: 'sign_in',
            challenge,
            action
          })
        ),
        { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }
      ).toString('base64url')
    });
    return { response, authorization, proof };
  }
  it('only the proven device receives its own HttpOnly cookie after a fresh owner decision', async () => {
    const value = await start();
    expect(value.response.statusCode).toBe(200);
    expect(value.response.headers['cache-control']).toBe('no-store');
    expect(value.authorization.deviceLabel).toBe('garden app on Android');
    expect(value.authorization.verificationUri).toBe(
      `${origin}/#native-auth=${value.authorization.id}`
    );
    expect(value.response.headers['set-cookie']).toBeUndefined();
    expect(throttled).toEqual(['127.0.0.1:/v1/auth/native/start']);
    const decision = () =>
      app.inject({
        method: 'POST',
        url: `/v1/auth/native/${value.authorization.id}/decision`,
        headers: browserHeaders,
        payload: { userCode: value.authorization.userCode, approve: true }
      });
    await database.query(
      "UPDATE sessions SET step_up_at=NOW()-INTERVAL '1 second' WHERE id_hash=$1",
      [sha256(token)]
    );
    expect((await decision()).statusCode).toBe(403);
    await database.query('UPDATE sessions SET step_up_at=NOW() WHERE id_hash=$1', [sha256(token)]);
    expect((await decision()).statusCode).toBe(200);
    const redeemed = await app.inject({
      method: 'POST',
      url: '/v1/auth/native/redeem',
      headers: { origin },
      payload: value.proof()
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toEqual({
      status: 'authorized',
      user: { id: ownerId, username: 'browser-owner', displayName: 'Owner' }
    });
    expect(redeemed.body).not.toContain(token);
    const minted = redeemed.cookies.find((item) => item.name === sessionCookieName(true));
    expect(minted?.value).toBeTruthy();
    expect(minted?.value).not.toBe(token);
    expect(minted).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/probe/who',
          headers: { cookie: `${minted!.name}=${minted!.value}` }
        })
      ).json()
    ).toEqual({ userId: ownerId });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/native/redeem',
          headers: { origin },
          payload: value.proof()
        })
      ).statusCode
    ).toBe(409);
    expect(polled).toHaveLength(2);
    const audit = await database.query(
      'SELECT kind,outcome,metadata FROM security_events ORDER BY created_at'
    );
    expect(audit.rows.map((row) => row.outcome)).toEqual(['approved', 'completed']);
    expect(JSON.stringify(audit.rows)).not.toContain(value.proof().verifier);
    expect(JSON.stringify(audit.rows)).not.toContain(token);
  });
  it('keeps anonymous inspection, cross-origin decisions and bearer tokens outside session authorization', async () => {
    const value = await start();
    expect(
      (await app.inject({ method: 'GET', url: `/v1/auth/native/${value.authorization.id}` }))
        .statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/auth/native/${value.authorization.id}/decision`,
          headers: { ...browserHeaders, origin: 'https://different.example' },
          payload: { userCode: value.authorization.userCode, approve: true }
        })
      ).statusCode
    ).toBeGreaterThanOrEqual(400);
    const bearer = `oc_live_${randomBytes(32).toString('base64url')}`;
    await store.createApiToken({
      userId: ownerId,
      label: 'Automation',
      tokenHash: sha256(bearer),
      prefix: bearer.slice(0, 12),
      scopes: ['tasks:write', 'workspaces:write'],
      expiresAt: new Date(Date.now() + 86400000)
    });
    for (const url of [
      '/v1/auth/native/start',
      '/v1/auth/native/redeem',
      `/v1/auth/native/${value.authorization.id}/decision`
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { authorization: `Bearer ${bearer}` },
            payload: {}
          })
        ).statusCode
      ).toBe(403);
    }
    expect((await database.query('SELECT COUNT(*) AS count FROM sessions')).rows[0]?.count).toBe(1);
  });
  it('rejects callback addresses and undeclared scope fields before creating a grant', async () => {
    for (const input of [
      { redirectUri: 'https://outside.example' },
      { nativeOrigin: 'https://outside.example' },
      { nativeOrigin: 'http://localhost:49152/path' },
      { purpose: 'step_up' }
    ]) {
      expect((await start(input)).response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(
      (await database.query('SELECT COUNT(*) AS count FROM native_authorizations')).rows[0]?.count
    ).toBe(0);
  });
  it('forces a new challenge even when the browser already has a recent step-up', async () => {
    const ordinary = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/options',
      headers: browserHeaders,
      payload: {}
    });
    expect(ordinary.json()).toEqual({ verified: true });
    const forced = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/options',
      headers: browserHeaders,
      payload: { force: true }
    });
    expect(forced.statusCode).toBe(200);
    const body = forced.json<{
      challengeId: string;
      options: { rpId: string; userVerification: string };
    }>();
    expect(body.challengeId).toEqual(expect.any(String));
    expect(body.options.rpId).toBe('garden.example');
    expect(body.options.userVerification).toBe('required');
  });
});
