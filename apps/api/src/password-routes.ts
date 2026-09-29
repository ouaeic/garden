import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GardenError, hashRecoveryCode, sha256, verifyRecoveryCode } from '@garden/core';
import type { DataStore, UserRecord } from '@garden/data';
import type { ApiConfig } from './config.js';
import { deviceLabel } from './auth-routes.js';
import { createSession, hasRecentStepUp, sessionCookieName } from './session.js';
import { recordSecurityEvent } from './security-events.js';

const passwordInput = z.string().min(1).max(1024);
const newPassword = passwordInput.refine((value) => [...value.normalize('NFKC')].length >= 15, {
  message: 'Use at least 15 characters. A few words work well.'
});
const publicUser = (user: UserRecord) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName
});

export function registerPasswordRoutes(
  app: FastifyInstance,
  store: DataStore,
  config: ApiConfig,
  requirePairing: (code: string | undefined) => Promise<void>
): void {
  const secure = config.PUBLIC_APP_URL.startsWith('https://');
  const dummyHash = hashRecoveryCode(randomBytes(32).toString('base64url'));
  const attempt = async () => {
    if (!(await store.claimPasswordAttempt()))
      throw new GardenError(
        'password_rate_limited',
        'Too many attempts. Try again in 15 minutes, or use a passkey.',
        429
      );
  };
  const failed = () => new GardenError('password_invalid', 'That password is not correct.', 401);
  const verify = async (user: UserRecord | null, password: string) => {
    await attempt();
    const hash = user ? await store.getPasswordHash(user.id) : null;
    const valid = await verifyRecoveryCode(password, hash ?? (await dummyHash));
    if (!user || !hash || !valid) throw failed();
    return hash;
  };

  app.post('/v1/auth/password/register', async (request, reply) => {
    if ((await store.countUsers()) > 0)
      throw new GardenError(
        'registration_closed',
        'This Garden already has an owner. Sign in instead.',
        403
      );
    const input = z
      .object({
        displayName: z.string().trim().min(1).max(80),
        pairingCode: z.string().min(20).max(200),
        password: newPassword
      })
      .parse(request.body);
    await requirePairing(input.pairingCode);
    const recoveryCode = randomBytes(18).toString('base64url');
    const user = await store.createOwner({
      displayName: input.displayName,
      passwordHash: await hashRecoveryCode(input.password),
      recoveryHash: await hashRecoveryCode(recoveryCode)
    });
    if (!user)
      throw new GardenError(
        'registration_closed',
        'This Garden already has an owner. Sign in instead.',
        403
      );
    await createSession(store, reply, user.id, secure, deviceLabel(request.headers), true);
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'password_created',
      outcome: 'completed'
    });
    return { user: publicUser(user), recoveryCode };
  });

  app.post('/v1/auth/password/login', async (request, reply) => {
    const { password } = z.object({ password: passwordInput }).parse(request.body);
    const user = await store.soleUser();
    const hash = await verify(user, password);
    await createSession(store, reply, user!.id, secure, deviceLabel(request.headers), true, hash);
    await store.clearPasswordAttempts();
    return { user: publicUser(user!) };
  });

  app.get('/v1/auth/password', async (request) => {
    if (!request.user) throw new GardenError('authentication_required', 'Sign in to continue', 401);
    return { configured: Boolean(await store.getPasswordHash(request.user.id)) };
  });

  app.post('/v1/auth/password/step-up', async (request) => {
    const { password } = z.object({ password: passwordInput }).parse(request.body);
    const hash = await verify(request.user, password);
    const cookie = request.cookies[sessionCookieName(secure)];
    if (!cookie || !(await store.markPasswordStepUp(request.user!.id, sha256(cookie), hash)))
      throw failed();
    await store.clearPasswordAttempts();
    return { verified: true };
  });

  app.post('/v1/auth/password', async (request, reply) => {
    const { password } = z.object({ password: newPassword }).parse(request.body);
    const user = request.user;
    if (!user) throw new GardenError('authentication_required', 'Sign in to continue', 401);
    if (!(await hasRecentStepUp(store, user.id, request.cookies[sessionCookieName(secure)])))
      throw new GardenError(
        'step_up_required',
        'Confirm your identity before changing your password.',
        403
      );
    const expected = await store.getPasswordHash(user.id);
    const hash = await hashRecoveryCode(password);
    if (
      !(await store.replacePassword({
        userId: user.id,
        passwordHash: hash,
        proof: { passwordHash: expected }
      }))
    )
      throw failed();
    await createSession(store, reply, user.id, secure, deviceLabel(request.headers), true, hash);
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'password_changed',
      outcome: 'completed'
    });
    return { user: publicUser(user) };
  });

  app.post('/v1/auth/password/recover', async (request, reply) => {
    const input = z
      .object({ code: z.string().min(1).max(200), password: newPassword })
      .parse(request.body);
    const user = await store.soleUser();
    const tokenHash = sha256(input.code.trim());
    const resetOwner = await store.findPasswordReset(tokenHash);
    // A host-issued grant must still recover an account whose password bucket is exhausted.
    if (!user || resetOwner !== user.id) await attempt();
    const recoveryValid = await verifyRecoveryCode(
      input.code.trim(),
      user?.recoveryHash ?? (await dummyHash)
    );
    if (!user || (resetOwner !== user.id && !(user.recoveryHash && recoveryValid)))
      throw new GardenError(
        'recovery_failed',
        'That recovery or setup code is invalid or expired.',
        401
      );
    const recoveryCode = randomBytes(18).toString('base64url');
    const newRecoveryHash = await hashRecoveryCode(recoveryCode);
    const hash = await hashRecoveryCode(input.password);
    const changed = await store.replacePassword({
      userId: user.id,
      passwordHash: hash,
      proof:
        resetOwner === user.id
          ? { tokenHash, newRecoveryHash }
          : { recoveryHash: user.recoveryHash!, newRecoveryHash }
    });
    if (!changed)
      throw new GardenError(
        'recovery_failed',
        'This code was already used. Request a new one.',
        401
      );
    await createSession(store, reply, user.id, secure, deviceLabel(request.headers), true, hash);
    await store.clearPasswordAttempts();
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'account_recovery',
      outcome: 'completed'
    });
    return { user: publicUser(user), recoveryCode };
  });
}
