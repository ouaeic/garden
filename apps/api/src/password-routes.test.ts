import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { hashRecoveryCode, sha256 } from '@garden/core';
import { registerAuthHooks } from './http/auth-hook.js';
import { registerErrorHandler } from './http/errors.js';
import { registerAuthRoutes } from './auth-routes.js';
import { silentLogger } from './log.js';
import type { RouteContext } from './http/server-context.js';

const origin = 'https://garden.example';
const password = 'a private garden on the hillside';
const nextPassword = 'another private garden by the river';
const pairingCode = 'installer-code-with-enough-entropy';

describe('password and remembered-device workflows', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database);
  const app = Fastify();
  const rateLimited: string[] = [];
  const headers = { origin, 'user-agent': 'Chrome/123 Macintosh' };
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers['set-cookie']).split(';')[0]!;
  const post = (url: string, payload: unknown, cookieValue?: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...(cookieValue ? { cookie: cookieValue } : {}) },
      payload: payload as Record<string, unknown>
    });
  const register = () =>
    post('/v1/auth/password/register', { displayName: 'Owner', pairingCode, password });
  beforeAll(async () => {
    await migrateDatabase(database);
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
      checkAuthRate: (key: string) => rateLimited.push(key),
      checkShareRate: () => {},
      config: {
        PUBLIC_APP_URL: origin,
        WEBAUTHN_ORIGIN: origin,
        WEBAUTHN_RP_ID: 'garden.example',
        WEBAUTHN_RP_NAME: 'Garden',
        REGISTRATION_BOOTSTRAP_TOKEN: pairingCode,
        REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 3600
      }
    } as unknown as RouteContext;
    registerErrorHandler(context);
    registerAuthHooks(context);
    registerAuthRoutes(app, store, context.config);
    app.get('/v1/probe/owner', (request) => ({ id: request.user?.id }));
  });
  beforeEach(async () => {
    await database.exec(
      'TRUNCATE users CASCADE; DELETE FROM password_attempts; DELETE FROM auth_challenges'
    );
    rateLimited.length = 0;
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('claims the server with a password, remembers two devices and revokes one independently', async () => {
    const created = await register();
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json<{ user: Record<string, unknown> }>().user).not.toHaveProperty(
      'recoveryHash'
    );
    expect(created.json<{ user: Record<string, unknown> }>().user).not.toHaveProperty(
      'passwordHash'
    );
    const owner = (await store.soleUser())!;
    expect(await store.getPasswordHash(owner.id)).not.toBe(password);
    expect(await store.listPasskeys(owner.id)).toEqual([]);
    const first = cookieOf(created);
    expect(String(created.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(created.headers['set-cookie'])).toContain('Secure');
    expect(String(created.headers['set-cookie'])).toContain('SameSite=Lax');
    const second = await post('/v1/auth/password/login', { password });
    expect(second.statusCode, second.body).toBe(200);
    const devices = await store.listSessions(owner.id);
    expect(devices).toHaveLength(2);
    expect(devices[0]?.deviceLabel).toBe('Chrome on macOS');
    expect(new Date(String(devices[0]?.expiresAt)).getTime()).toBeGreaterThan(
      Date.now() + 365 * 86400000
    );
    const firstId = await store.getSessionPublicId(owner.id, sha256(first.split('=')[1]!));
    await store.deleteSessionForUser(owner.id, firstId!);
    expect(
      (await app.inject({ url: '/v1/probe/owner', headers: { cookie: first } })).statusCode
    ).toBe(401);
    expect(
      (await app.inject({ url: '/v1/probe/owner', headers: { cookie: cookieOf(second) } }))
        .statusCode
    ).toBe(200);
    expect((await register()).statusCode).toBe(403);
    expect(await store.countUsers()).toBe(1);
  });

  it('confirms sensitive changes with a password and invalidates old sessions after changing it', async () => {
    const created = await register();
    const first = cookieOf(created);
    const second = cookieOf(await post('/v1/auth/password/login', { password }));
    expect((await post('/v1/auth/step-up/options', {}, first)).json()).toEqual({ verified: true });
    await database.query("UPDATE sessions SET step_up_at=NOW()-INTERVAL '1 hour'");
    expect((await post('/v1/auth/step-up/options', {}, first)).json()).toEqual({
      method: 'password'
    });
    expect((await post('/v1/auth/password', { password: nextPassword }, first)).statusCode).toBe(
      403
    );
    expect((await post('/v1/auth/password/step-up', { password: 'wrong' }, first)).statusCode).toBe(
      401
    );
    expect((await post('/v1/auth/password/step-up', { password }, first)).statusCode).toBe(200);
    const changed = await post('/v1/auth/password', { password: nextPassword }, first);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(
      (await app.inject({ url: '/v1/probe/owner', headers: { cookie: second } })).statusCode
    ).toBe(401);
    expect((await post('/v1/auth/password/login', { password })).statusCode).toBe(401);
    expect((await post('/v1/auth/password/login', { password: nextPassword })).statusCode).toBe(
      200
    );
  });

  it('recovers without WebAuthn, consumes the recovery code once and retires previous credentials', async () => {
    const created = await register();
    const user = (await store.soleUser())!;
    await store.addPasskey({
      userId: user.id,
      credentialId: 'old-key',
      publicKey: 'AA',
      counter: 0,
      transports: [],
      deviceType: 'singleDevice',
      backedUp: false
    });
    await store.createApiToken({
      userId: user.id,
      label: 'Old automation',
      tokenHash: 'old-api-hash',
      prefix: 'oc_live_',
      scopes: ['tasks:read'],
      expiresAt: new Date(Date.now() + 3600000)
    });
    await store.createDeviceEnrollment({
      userId: user.id,
      tokenHash: 'old-device',
      label: 'Other device',
      expiresAt: new Date(Date.now() + 3600000)
    });
    const recovered = await post('/v1/auth/password/recover', {
      code: created.json<{ recoveryCode: string }>().recoveryCode,
      password: nextPassword
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json<{ recoveryCode: string }>().recoveryCode).not.toBe(
      created.json<{ recoveryCode: string }>().recoveryCode
    );
    expect(await store.listPasskeys(user.id)).toEqual([]);
    expect(await store.authenticateApiToken('old-api-hash')).toBeNull();
    expect(await store.findDeviceEnrollment('old-device')).toBeNull();
    expect(
      (await app.inject({ url: '/v1/probe/owner', headers: { cookie: cookieOf(created) } }))
        .statusCode
    ).toBe(401);
    expect(
      (
        await post('/v1/auth/password/recover', {
          code: created.json<{ recoveryCode: string }>().recoveryCode,
          password
        })
      ).statusCode
    ).toBe(401);
    expect((await post('/v1/auth/password/login', { password: nextPassword })).statusCode).toBe(
      200
    );
  });

  it('lets the host owner issue one expiring setup grant without changing access until redemption', async () => {
    const user = await store.createUser({
      username: 'owner',
      displayName: 'Owner',
      recoveryHash: await hashRecoveryCode('old-code')
    });
    const token = randomBytes(32).toString('base64url');
    await store.createPasswordReset(user.id, sha256(token));
    expect(await store.getPasswordHash(user.id)).toBeNull();
    const result = await post('/v1/auth/password/recover', { code: token, password });
    expect(result.statusCode, result.body).toBe(200);
    expect(
      (await post('/v1/auth/password/recover', { code: token, password: nextPassword })).statusCode
    ).toBe(401);
    await store.createPasswordReset(user.id, sha256(token));
    await database.query("UPDATE password_reset_tokens SET expires_at=NOW()-INTERVAL '1 second'");
    expect(
      (await post('/v1/auth/password/recover', { code: token, password: nextPassword })).statusCode
    ).toBe(401);
    expect((await post('/v1/auth/password/login', { password })).statusCode).toBe(200);
  });

  it('rejects wrong origins, pairing codes, unauthenticated changes and concurrent owner claims', async () => {
    expect(
      (
        await post('/v1/auth/password/register', {
          displayName: 'Owner',
          pairingCode: 'x'.repeat(32),
          password
        })
      ).statusCode
    ).toBe(403);
    const responses = await Promise.all([register(), register()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 403]);
    expect(await store.countUsers()).toBe(1);
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/login',
      headers: { origin: 'https://elsewhere.example' },
      payload: { password }
    });
    expect(crossOrigin.statusCode).toBe(400);
    expect((await post('/v1/auth/password', { password: nextPassword })).statusCode).toBe(401);
    expect((await post('/v1/auth/password/step-up', { password })).statusCode).toBe(401);
  });

  it('bounds password guesses across addresses, including after route reinitialization', async () => {
    await register();
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/login',
        remoteAddress: `192.0.2.${attempt + 1}`,
        payload: { password: 'wrong' }
      });
      expect(result.statusCode).toBe(401);
    }
    expect((await post('/v1/auth/password/login', { password })).statusCode).toBe(429);
    expect(await new DataStore(database).claimPasswordAttempt()).toBe(false);
    expect(rateLimited.length).toBeGreaterThan(0);
    expect(rateLimited).toContain('127.0.0.1:/v1/auth/password/register');
    await database.query("UPDATE password_attempts SET resets_at=NOW()-INTERVAL '1 second'");
    expect((await post('/v1/auth/password/login', { password })).statusCode).toBe(200);
  });

  it('accepts a valid host recovery grant even while password guesses are throttled', async () => {
    await register();
    const owner = (await store.soleUser())!;
    for (let attempt = 0; attempt < 20; attempt++) await store.claimPasswordAttempt();
    expect((await post('/v1/auth/password/login', { password })).statusCode).toBe(429);
    const token = randomBytes(32).toString('base64url');
    await store.createPasswordReset(owner.id, sha256(token));
    const result = await post('/v1/auth/password/recover', { code: token, password: nextPassword });
    expect(result.statusCode, result.body).toBe(200);
    expect((await post('/v1/auth/password/login', { password: nextPassword })).statusCode).toBe(
      200
    );
  });

  it('allows the last passkey to be removed only when a password remains', async () => {
    await register();
    const user = (await store.soleUser())!;
    const key = await store.addPasskey({
      userId: user.id,
      credentialId: 'optional',
      publicKey: 'AA',
      counter: 0,
      transports: [],
      deviceType: 'singleDevice',
      backedUp: false
    });
    expect(await store.deletePasskeyForUser(user.id, key.id)).toBe('deleted');
    const last = await store.addPasskey({
      userId: user.id,
      credentialId: 'last',
      publicKey: 'AA',
      counter: 0,
      transports: [],
      deviceType: 'singleDevice',
      backedUp: false
    });
    await database.query('UPDATE users SET password_hash=NULL WHERE id=$1', [user.id]);
    expect(await store.deletePasskeyForUser(user.id, last.id)).toBe('last_passkey');
  });

  it('does not accept a stale password proof after recovery rotates the credential', async () => {
    await register();
    const user = (await store.soleUser())!;
    const oldHash = (await store.getPasswordHash(user.id))!;
    await store.replacePassword({
      userId: user.id,
      passwordHash: await hashRecoveryCode(nextPassword),
      proof: { passwordHash: oldHash }
    });
    await expect(
      store.createSession(
        user.id,
        'stale-session',
        new Date(Date.now() + 3600000),
        undefined,
        'Browser',
        true,
        oldHash
      )
    ).rejects.toThrow('Password changed');
    expect(await store.markPasswordStepUp(user.id, 'stale-session', oldHash)).toBe(false);
    expect(await store.listSessions(user.id)).toEqual([]);
  });
});
