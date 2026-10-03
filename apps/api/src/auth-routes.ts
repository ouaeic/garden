import { registerPasswordRoutes } from './password-routes.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
import { z } from 'zod';
import { hashRecoveryCode, GardenError, sha256, verifyRecoveryCode } from '@garden/core';
import type { DataStore } from '@garden/data';
import type { ApiConfig } from './config.js';
import { recordSecurityEvent } from './security-events.js';
import {
  createSession,
  destroySession,
  hasRecentStepUp,
  sessionCookieName,
  STEP_UP_WINDOW_SECONDS
} from './session.js';

const b64 = (value: Uint8Array): string => Buffer.from(value).toString('base64url');

const internalUsername = (name: string | undefined): string => {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length >= 3 ? slug : 'owner';
};

const validDisplayName = (value: string | undefined): string => {
  const displayName = value?.trim();
  if (!displayName || displayName.length > 80)
    throw new Error('Enter the name you want garden to use');
  return displayName;
};

/**
 * The packaged clients, named from what they say they are rather than from the webview they are.
 *
 * A Tauri shell renders in the platform webview and forwards its User-Agent unchanged, so the
 * macOS app was labelled "Safari on macOS" - byte-identical to the owner's real Safari in the
 * Devices list, which is also the revoke-a-session control. The shell now stamps
 * `x-garden-client: garden-<platform>/<version>` on every request it proxies
 * (`apps/desktop/src-tauri/src/proxy.rs`).
 *
 * Matched against a closed list rather than echoed. Any caller can set a header, and a device
 * label that can be dictated is one that can be made to read like somebody else's row on the
 * screen the owner uses to decide what to sign out.
 */
const NATIVE_CLIENT_PLATFORMS: Record<string, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android'
};

const nativeClientLabel = (value: string | string[] | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const platform = /^garden-([a-z]{3,10})\/[0-9A-Za-z.+-]{1,32}$/.exec(value.trim())?.[1];
  const named = platform ? NATIVE_CLIENT_PLATFORMS[platform] : undefined;
  return named ? `garden app on ${named}` : undefined;
};

export const deviceLabel = (headers: {
  'user-agent'?: string | undefined;
  'x-garden-client'?: string | string[] | undefined;
}): string => {
  const native = nativeClientLabel(headers['x-garden-client']);
  if (native) return native;
  const value = headers['user-agent'] ?? '';
  const browser = value.includes('Firefox/')
    ? 'Firefox'
    : value.includes('Edg/')
      ? 'Edge'
      : value.includes('Chrome/')
        ? 'Chrome'
        : value.includes('Safari/')
          ? 'Safari'
          : 'Browser';
  const platform = /iPhone|iPad/.test(value)
    ? 'iOS'
    : value.includes('Android')
      ? 'Android'
      : value.includes('Macintosh')
        ? 'macOS'
        : value.includes('Windows')
          ? 'Windows'
          : value.includes('Linux')
            ? 'Linux'
            : 'unknown OS';
  return `${browser} on ${platform}`;
};

export const registerAuthRoutes = (
  app: FastifyInstance,
  store: DataStore,
  config: ApiConfig
): void => {
  const secure = config.PUBLIC_APP_URL.startsWith('https://');
  /**
   * Two conditions, not one. `/v1/auth/dev` signs anybody in as anybody by name and marks the
   * session already stepped up, so a stray `ALLOW_INSECURE_DEV_AUTH=true` left in an environment
   * file must not be enough on its own to open it on a machine anyone else can reach.
   */
  const devAuthEnabled = config.ALLOW_INSECURE_DEV_AUTH && config.DEPLOYMENT_MODE === 'development';
  /**
   * Hashed once at startup so an unknown username costs the same as a known one. Awaited lazily
   * because route registration is synchronous and the derivation is now off-thread.
   */
  const dummyRecoveryHash = hashRecoveryCode(randomBytes(18).toString('base64url'));
  const recoveryAttempts = new Map<string, { count: number; resetAt: number }>();
  const webauthnContext = (
    nativeOrigin: string | undefined
  ): { expectedOrigin: string; rpId: string } => {
    if (!nativeOrigin) {
      return { expectedOrigin: config.WEBAUTHN_ORIGIN, rpId: config.WEBAUTHN_RP_ID };
    }
    let parsed: URL;
    try {
      parsed = new URL(nativeOrigin);
    } catch {
      throw new GardenError('invalid_native_origin', 'The native client origin is invalid', 400);
    }
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== 'localhost' ||
      !parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== nativeOrigin
    ) {
      throw new GardenError(
        'invalid_native_origin',
        'Native passkeys require an exact http://localhost:<port> origin',
        400
      );
    }
    return { expectedOrigin: parsed.origin, rpId: 'localhost' };
  };
  const pendingContext = (pending: {
    expectedOrigin: string | null;
    rpId: string | null;
  }): { expectedOrigin: string; rpId: string } => ({
    expectedOrigin: pending.expectedOrigin ?? config.WEBAUTHN_ORIGIN,
    rpId: pending.rpId ?? config.WEBAUTHN_RP_ID
  });
  const pairingMatches = (candidate: string | undefined): boolean => {
    if (!candidate || !config.REGISTRATION_BOOTSTRAP_TOKEN) return false;
    const expected = Buffer.from(sha256(config.REGISTRATION_BOOTSTRAP_TOKEN), 'hex');
    const actual = Buffer.from(sha256(candidate.trim()), 'hex');
    return timingSafeEqual(expected, actual);
  };

  const requireFirstOwnerPairing = async (pairingCode: string | undefined): Promise<void> => {
    if ((await store.countUsers()) > 0) return;
    if (
      config.REGISTRATION_BOOTSTRAP_EXPIRES_AT &&
      config.REGISTRATION_BOOTSTRAP_EXPIRES_AT <= Math.floor(Date.now() / 1000)
    )
      throw new GardenError(
        'pairing_expired',
        'The installer pairing code expired. Run sudo garden pairing-code on the server.',
        403
      );
    if (!pairingMatches(pairingCode))
      throw new GardenError(
        'pairing_required',
        'Enter the one-time pairing code printed by the garden installer',
        403
      );
  };

  const checkRecoveryRate = (key: string): void => {
    const now = Date.now();
    const current = recoveryAttempts.get(key);
    if (!current || current.resetAt <= now) {
      if (recoveryAttempts.size >= 10_000) {
        for (const [candidate, attempt] of recoveryAttempts) {
          if (attempt.resetAt <= now) recoveryAttempts.delete(candidate);
        }
        if (recoveryAttempts.size >= 10_000) {
          throw new GardenError(
            'recovery_rate_limited',
            'Recovery is temporarily busy; try again later',
            429
          );
        }
      }
      recoveryAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
      return;
    }
    current.count += 1;
    if (current.count > 5) {
      throw new GardenError(
        'recovery_rate_limited',
        'Too many recovery attempts; try again later',
        429
      );
    }
  };

  const requireRecentStepUp = async (request: {
    user: { id: string } | null;
    cookies: Record<string, string | undefined>;
  }): Promise<{ id: string }> => {
    const user = request.user;
    if (!user) throw new GardenError('authentication_required', 'Sign in to continue', 401);
    if (!(await hasRecentStepUp(store, user.id, request.cookies[sessionCookieName(secure)]))) {
      throw new GardenError('step_up_required', 'Confirm your identity to continue', 403);
    }
    return user;
  };

  registerPasswordRoutes(app, store, config, requireFirstOwnerPairing);

  app.post<{
    Body: {
      username?: string;
      displayName?: string;
      pairingCode?: string;
      nativeOrigin?: string;
    };
  }>('/v1/auth/register/options', async (request) => {
    // One owner, always. An open registration mode would turn a single-owner box into one anybody
    // could claim an account on.
    if ((await store.countUsers()) > 0)
      throw new GardenError(
        'registration_closed',
        'This garden server already has an owner. Sign in, or add this device from one that is already signed in.',
        403
      );
    await requireFirstOwnerPairing(request.body.pairingCode);
    const displayName = validDisplayName(request.body.displayName ?? request.body.username);
    let username = internalUsername(displayName);
    if (await store.getUserByUsername(username)) {
      username = `${username.slice(0, 43)}-${randomBytes(2).toString('hex')}`;
    }
    const context = webauthnContext(request.body.nativeOrigin);
    const options = await generateRegistrationOptions({
      rpName: config.WEBAUTHN_RP_NAME,
      rpID: context.rpId,
      userName: username,
      userDisplayName: displayName,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
    });
    const challengeId = await store.createChallenge({
      username,
      challenge: options.challenge,
      kind: 'registration',
      expectedOrigin: context.expectedOrigin,
      rpId: context.rpId
    });
    return { challengeId, options };
  });

  app.post<{
    Body: {
      username?: string;
      displayName?: string;
      challengeId: string;
      pairingCode?: string;
      response: Parameters<typeof verifyRegistrationResponse>[0]['response'];
    };
  }>('/v1/auth/register/verify', async (request, reply) => {
    if ((await store.countUsers()) > 0)
      throw new GardenError('registration_closed', 'This garden server already has an owner.', 403);
    await requireFirstOwnerPairing(request.body.pairingCode);
    const pending = await store.consumeChallenge(request.body.challengeId, 'registration');
    if (!pending?.username) throw new Error('Registration challenge expired');
    const context = pendingContext(pending);
    const verification = await verifyRegistrationResponse({
      response: request.body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpId,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo)
      throw new Error('Passkey verification failed');
    const recoveryCode = randomBytes(18).toString('base64url');
    const user = await store.createOwner({
      username: pending.username,
      displayName: request.body.displayName?.trim() || pending.username,
      recoveryHash: await hashRecoveryCode(recoveryCode)
    });
    if (!user)
      throw new GardenError('registration_closed', 'This Garden already has an owner.', 403);
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await store.addPasskey({
      userId: user.id,
      credentialId: credential.id,
      publicKey: b64(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp
    });
    await createSession(store, reply, user.id, secure, deviceLabel(request.headers), true);
    return { user, recoveryCode };
  });

  app.post<{ Body: { username?: string; nativeOrigin?: string } }>(
    '/v1/auth/login/options',
    async (request) => {
      /*
       * The same answer for everybody, because this route has no session behind it.
       *
       * If naming a username changed the reply - a real one answered with that account's credential
       * ids and their transports, an invented one with an empty list - anyone who could reach the
       * sign-in page could ask whether a given owner existed on this box and, when they did, learn
       * how many authenticators they had and whether any was a phone or a security key - which is a
       * shopping list for whoever wants to be standing next to them.
       *
       * Nothing is lost by refusing to say. Registration and enrollment both force
       * `residentKey: 'required'`, so every credential this box has ever issued is discoverable,
       * and `login/verify` resolves the account from the credential the authenticator returns
       * rather than from anything claimed here. A username in the body is ignored.
       */
      const context = webauthnContext(request.body.nativeOrigin);
      const options = await generateAuthenticationOptions({
        rpID: context.rpId,
        userVerification: 'required'
      });
      const challengeId = await store.createChallenge({
        challenge: options.challenge,
        kind: 'authentication',
        expectedOrigin: context.expectedOrigin,
        rpId: context.rpId
      });
      return { challengeId, options };
    }
  );

  app.post<{
    Body: {
      challengeId: string;
      response: Parameters<typeof verifyAuthenticationResponse>[0]['response'];
    };
  }>('/v1/auth/login/verify', async (request, reply) => {
    const pending = await store.consumeChallenge(request.body.challengeId, 'authentication');
    if (!pending) throw new Error('Authentication challenge expired');
    const key = await store.getPasskeyByCredentialId(request.body.response.id);
    const user = key ? await store.getUserById(key.userId) : null;
    if (!user || !key || (pending.username && pending.username !== user.username))
      throw new Error('Passkey is not registered');
    const context = pendingContext(pending);
    const verification = await verifyAuthenticationResponse({
      response: request.body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpId,
      credential: {
        id: key.credentialId,
        publicKey: Buffer.from(key.publicKey, 'base64url'),
        counter: key.counter,
        transports: key.transports as AuthenticatorTransport[]
      },
      requireUserVerification: true
    });
    if (!verification.verified) throw new Error('Passkey verification failed');
    await store.updatePasskeyCounter(key.id, verification.authenticationInfo.newCounter);
    await createSession(store, reply, user.id, secure, deviceLabel(request.headers), true);
    return { user };
  });

  app.post<{ Body: { username: string; recoveryCode: string; nativeOrigin?: string } }>(
    '/v1/auth/recover/options',
    async (request) => {
      /*
       * On a box with one owner the name is not a question worth asking.
       *
       * Asking would mean the display name typed once during setup - months later, on the worst day
       * the owner will have with this software, with the recovery code in front of them and no
       * passkey left. Guessing it wrong would answer "the username or recovery code is not valid",
       * which reads as the code being wrong, and the code is the thing that cannot be guessed
       * again. There is nothing to disambiguate here: one account, one code, and the code is the
       * secret. The rate limit keys on the account that was actually resolved, so a wrong name
       * cannot spend somebody else's budget or dodge its own.
       */
      const sole = await store.soleUser();
      const user = sole ?? (await store.getUserByUsername(internalUsername(request.body.username)));
      checkRecoveryRate(
        `${request.ip}:${user?.username ?? internalUsername(request.body.username)}`
      );
      const verified = await verifyRecoveryCode(
        request.body.recoveryCode,
        user?.recoveryHash ?? (await dummyRecoveryHash)
      );
      if (!user?.recoveryHash || !verified) {
        throw new GardenError(
          'recovery_failed',
          sole ? 'That recovery code is not valid' : 'The username or recovery code is not valid',
          401
        );
      }
      const passkeys = await store.listPasskeys(user.id);
      const context = webauthnContext(request.body.nativeOrigin);
      const options = await generateRegistrationOptions({
        rpName: config.WEBAUTHN_RP_NAME,
        rpID: context.rpId,
        userName: user.username,
        userDisplayName: user.displayName,
        attestationType: 'none',
        excludeCredentials: passkeys.map((key) => ({
          id: key.credentialId,
          transports: key.transports as AuthenticatorTransport[]
        })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      });
      const challengeId = await store.createChallenge({
        // The account this actually resolved to, which on a single-owner box is the only one and
        // not whatever was typed. `recover/verify` reads the name back off this challenge.
        username: user.username,
        challenge: options.challenge,
        kind: 'recovery',
        ttlSeconds: 300,
        expectedOrigin: context.expectedOrigin,
        rpId: context.rpId
      });
      return { challengeId, options };
    }
  );

  app.post<{
    Body: {
      challengeId: string;
      recoveryCode: string;
      response: Parameters<typeof verifyRegistrationResponse>[0]['response'];
    };
  }>('/v1/auth/recover/verify', async (request, reply) => {
    const pending = await store.consumeChallenge(request.body.challengeId, 'recovery');
    if (!pending?.username)
      throw new GardenError('recovery_failed', 'Recovery challenge expired', 401);
    // Throttled on its own account, not only through the /options route that issued the challenge:
    // this route derives the same memory-hard hash, and a challenge is reusable until it is spent.
    checkRecoveryRate(`${request.ip}:${pending.username}`);
    const user = await store.getUserByUsername(pending.username);
    const verifiedCode = await verifyRecoveryCode(
      request.body.recoveryCode,
      user?.recoveryHash ?? (await dummyRecoveryHash)
    );
    if (!user?.recoveryHash || !verifiedCode) {
      throw new GardenError('recovery_failed', 'The username or recovery code is not valid', 401);
    }
    const context = pendingContext(pending);
    const verification = await verifyRegistrationResponse({
      response: request.body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpId,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new GardenError('recovery_failed', 'New passkey verification failed', 401);
    }
    const newRecoveryCode = randomBytes(18).toString('base64url');
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await store.replacePasskeysForRecovery({
      userId: user.id,
      username: user.username,
      expectedRecoveryHash: user.recoveryHash,
      newRecoveryHash: await hashRecoveryCode(newRecoveryCode),
      passkey: {
        credentialId: credential.id,
        publicKey: b64(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp
      }
    });
    await createSession(store, reply, user.id, secure, deviceLabel(request.headers), true);
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'account_recovery',
      outcome: 'completed'
    });
    return { user, recoveryCode: newRecoveryCode };
  });

  app.get('/v1/auth/passkeys', async (request) => {
    const user = request.user;
    if (!user) throw new GardenError('authentication_required', 'Sign in to continue', 401);
    return (await store.listPasskeys(user.id)).map((key) => ({
      id: key.id,
      deviceType: key.deviceType,
      backedUp: key.backedUp,
      transports: key.transports,
      createdAt: key.createdAt
    }));
  });

  app.post<{ Body: { nativeOrigin?: string } }>('/v1/auth/passkeys/options', async (request) => {
    const user = await requireRecentStepUp(request);
    const fullUser = await store.getUserById(user.id);
    if (!fullUser) throw new GardenError('authentication_required', 'Sign in to continue', 401);
    const passkeys = await store.listPasskeys(fullUser.id);
    const context = webauthnContext(request.body.nativeOrigin);
    const options = await generateRegistrationOptions({
      rpName: config.WEBAUTHN_RP_NAME,
      rpID: context.rpId,
      userName: fullUser.username,
      userDisplayName: fullUser.displayName,
      attestationType: 'none',
      excludeCredentials: passkeys.map((key) => ({
        id: key.credentialId,
        transports: key.transports as AuthenticatorTransport[]
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
    });
    const challengeId = await store.createChallenge({
      username: fullUser.username,
      challenge: options.challenge,
      kind: 'passkey_add',
      expectedOrigin: context.expectedOrigin,
      rpId: context.rpId
    });
    return { challengeId, options };
  });

  app.post<{
    Body: {
      challengeId: string;
      response: Parameters<typeof verifyRegistrationResponse>[0]['response'];
    };
  }>('/v1/auth/passkeys/verify', async (request, reply) => {
    const user = await requireRecentStepUp(request);
    const fullUser = await store.getUserById(user.id);
    const pending = await store.consumeChallenge(request.body.challengeId, 'passkey_add');
    if (!fullUser || !pending || pending.username !== fullUser.username) {
      throw new GardenError('passkey_add_failed', 'Passkey challenge expired', 401);
    }
    const context = pendingContext(pending);
    const verification = await verifyRegistrationResponse({
      response: request.body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpId,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new GardenError('passkey_add_failed', 'New passkey verification failed', 401);
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const added = await store.addPasskey({
      userId: fullUser.id,
      credentialId: credential.id,
      publicKey: b64(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp
    });
    await recordSecurityEvent(store, {
      userId: fullUser.id,
      kind: 'passkey_added',
      outcome: 'completed',
      metadata: { passkeyId: added.id }
    });
    reply.status(201);
    return {
      id: added.id,
      deviceType: added.deviceType,
      backedUp: added.backedUp,
      transports: added.transports,
      createdAt: added.createdAt
    };
  });

  /**
   * Enrolling a second device.
   *
   * The installer's pairing code claims the server and is then spent; it must never become a
   * standing credential, so adding a device months later cannot reuse it. Instead an
   * already-authenticated device mints a short-lived single-use grant, and the new device redeems
   * it to register a passkey of its own. The grant authorises exactly one thing — adding a
   * credential to this one account — and the redeeming device still has to complete a WebAuthn
   * ceremony, so a leaked token alone does not produce a usable session on the attacker's machine
   * unless they also complete registration before the legitimate device does, within the window.
   */
  const enrollmentTokenHash = (token: string): string => sha256(token.trim());

  app.post<{ Body: { token?: string; displayName?: string; nativeOrigin?: string } }>(
    '/v1/auth/enroll/options',
    async (request) => {
      const token = z.string().min(20).max(200).parse(request.body?.token);
      // Read, not spent. The grant is spent in enroll/verify, once an authenticator has actually
      // produced a credential, so dismissing the biometric prompt costs nothing but the tap.
      const enrollment = await store.findDeviceEnrollment(enrollmentTokenHash(token));
      if (!enrollment)
        throw new GardenError(
          'enrollment_invalid',
          'This device link has expired or was already used. Create a new one from a device that is already signed in.',
          403
        );
      const owner = await store.getUserById(enrollment.userId);
      if (!owner) throw new GardenError('enrollment_invalid', 'Enrollment target is gone', 403);
      const context = webauthnContext(request.body?.nativeOrigin);
      const options = await generateRegistrationOptions({
        rpName: config.WEBAUTHN_RP_NAME,
        rpID: context.rpId,
        userName: owner.username,
        userDisplayName: owner.displayName,
        attestationType: 'none',
        // Excluding the credentials already on the account stops an authenticator that is already
        // enrolled from silently creating a duplicate for the same account.
        excludeCredentials: (await store.listPasskeys(owner.id)).map((passkey) => ({
          id: passkey.credentialId
        })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      });
      const challengeId = await store.createChallenge({
        username: owner.username,
        challenge: options.challenge,
        kind: 'passkey_add',
        expectedOrigin: context.expectedOrigin,
        rpId: context.rpId
      });
      return { challengeId, options };
    }
  );

  app.post<{
    Body: {
      challengeId: string;
      token?: string;
      deviceLabel?: string;
      response: Parameters<typeof verifyRegistrationResponse>[0]['response'];
    };
  }>('/v1/auth/enroll/verify', async (request, reply) => {
    const token = z.string().min(20).max(200).parse(request.body?.token);
    const pending = await store.consumeChallenge(request.body.challengeId, 'passkey_add');
    if (!pending?.username)
      throw new GardenError('enrollment_invalid', 'Enrollment challenge expired', 401);
    const owner = await store.getUserByUsername(pending.username);
    if (!owner) throw new GardenError('enrollment_invalid', 'Enrollment target is gone', 403);
    const context = pendingContext(pending);
    const verification = await verifyRegistrationResponse({
      response: request.body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpId,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo)
      throw new GardenError('enrollment_invalid', 'New device verification failed', 401);
    // Spent here, now that an authenticator has actually produced a credential. The UPDATE is
    // atomic and still guarded on `consumed_at IS NULL`, so a second device racing the same link
    // finds nothing and exactly one passkey is ever created from it. The owner check matters
    // because the challenge and the grant arrive as two separate claims about who this is, and
    // agreeing on the account is the only thing that makes them one claim.
    const enrollment = await store.consumeDeviceEnrollment(enrollmentTokenHash(token));
    if (!enrollment || enrollment.userId !== owner.id)
      throw new GardenError(
        'enrollment_invalid',
        'This device link has expired or was already used. Create a new one from a device that is already signed in.',
        403
      );
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const added = await store.addPasskey({
      userId: owner.id,
      credentialId: credential.id,
      publicKey: b64(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp
    });
    await recordSecurityEvent(store, {
      userId: owner.id,
      kind: 'device_enrolled',
      outcome: 'completed',
      metadata: { passkeyId: added.id }
    });
    // The ceremony proved possession of a fresh authenticator, which is a stronger signal than the
    // token alone, so the new device is signed in immediately and stepped up.
    await createSession(
      store,
      reply,
      owner.id,
      config.PUBLIC_APP_URL.startsWith('https://'),
      deviceLabel(request.headers),
      true
    );
    reply.status(201);
    return { id: owner.id, username: owner.username, displayName: owner.displayName };
  });

  app.delete<{ Params: { passkeyId: string } }>('/v1/auth/passkeys/:passkeyId', async (request) => {
    const user = await requireRecentStepUp(request);
    const passkeyId = z.string().uuid().parse(request.params.passkeyId);
    const result = await store.deletePasskeyForUser(user.id, passkeyId);
    if (result === 'last_passkey') {
      throw new GardenError(
        'last_passkey',
        'Add another passkey before removing the final sign-in method',
        409
      );
    }
    if (result === 'deleted') {
      await recordSecurityEvent(store, {
        userId: user.id,
        kind: 'passkey_revoked',
        outcome: 'completed',
        metadata: { passkeyId }
      });
    }
    return { revoked: result === 'deleted' };
  });

  app.post<{ Body: { nativeOrigin?: string; force?: boolean } }>(
    '/v1/auth/step-up/options',
    async (request) => {
      const user = request.user;
      if (!user) throw new GardenError('authentication_required', 'Sign in to continue', 401);
      /*
       * A ceremony that already happened, inside the window, is the answer.
       *
       * Registration, sign-in, recovery and device enrolment each complete a WebAuthn ceremony with
       * `userVerification: 'required'` against the very authenticator this route would challenge, and
       * each opens the step-up window (`createSession(..., steppedUp)`). Every route behind
       * `requireRecentStepUp` already accepts that proof for the next five minutes without asking
       * again — but this route never consulted it, so it minted a challenge regardless and the client
       * ran it. The result was a fingerprint per sensitive action for the first five minutes after
       * first run, each one re-proving a fact the server was about to accept anyway. Nothing is
       * granted here that the window did not already grant; the floor that must always ask still
       * asks, because that floor is enforced where the action happens, on the same window.
       *
       * `step_up_at` is deliberately not touched. The window is anchored to the last real ceremony,
       * and refreshing it from a route that proves nothing would let whoever holds the cookie hold
       * the window open indefinitely by polling.
       */
      const sessionToken = request.cookies[sessionCookieName(secure)];
      if (
        request.body.force !== true &&
        sessionToken &&
        (await store.hasRecentSessionStepUp(user.id, sha256(sessionToken), STEP_UP_WINDOW_SECONDS))
      ) {
        return { verified: true };
      }
      if (await store.getPasswordHash(user.id)) return { method: 'password' as const };
      const passkeys = await store.listPasskeys(user.id);
      if (!passkeys.length) {
        // Step-up exists to prove a person is present. On a real deployment there is nothing to fall
        // back to when no passkey is registered, so this fails closed; only a developer machine,
        // which has no passkeys at all, takes the shortcut.
        if (devAuthEnabled) {
          const token = request.cookies[sessionCookieName(secure)];
          if (!token || !(await store.markSessionStepUp(user.id, sha256(token)))) {
            throw new GardenError(
              'step_up_failed',
              'The current development session is unavailable',
              401
            );
          }
          return { verified: true };
        }
        throw new GardenError('passkey_required', 'Register a passkey to continue', 403);
      }
      const context = webauthnContext(request.body.nativeOrigin);
      const options = await generateAuthenticationOptions({
        rpID: context.rpId,
        userVerification: 'required',
        allowCredentials: passkeys.map((key) => ({
          id: key.credentialId,
          transports: key.transports as AuthenticatorTransport[]
        }))
      });
      const challengeId = await store.createChallenge({
        username: user.username,
        challenge: options.challenge,
        kind: 'step_up',
        expectedOrigin: context.expectedOrigin,
        rpId: context.rpId
      });
      return { challengeId, options };
    }
  );

  app.post<{
    Body: {
      challengeId: string;
      response: Parameters<typeof verifyAuthenticationResponse>[0]['response'];
    };
  }>('/v1/auth/step-up/verify', async (request) => {
    const user = request.user;
    if (!user) throw new GardenError('authentication_required', 'Sign in to continue', 401);
    const pending = await store.consumeChallenge(request.body.challengeId, 'step_up');
    if (!pending || pending.username !== user.username)
      throw new GardenError('step_up_failed', 'Passkey challenge expired', 401);
    const key = await store.getPasskeyByCredentialId(request.body.response.id);
    if (!key || key.userId !== user.id)
      throw new GardenError('step_up_failed', 'Passkey is not registered', 401);
    const context = pendingContext(pending);
    const verification = await verifyAuthenticationResponse({
      response: request.body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpId,
      credential: {
        id: key.credentialId,
        publicKey: Buffer.from(key.publicKey, 'base64url'),
        counter: key.counter,
        transports: key.transports as AuthenticatorTransport[]
      },
      requireUserVerification: true
    });
    if (!verification.verified)
      throw new GardenError('step_up_failed', 'Passkey verification failed', 401);
    await store.updatePasskeyCounter(key.id, verification.authenticationInfo.newCounter);
    const token = request.cookies[sessionCookieName(secure)];
    if (!token || !(await store.markSessionStepUp(user.id, sha256(token)))) {
      throw new GardenError('step_up_failed', 'The current session is unavailable', 401);
    }
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'passkey_step_up',
      outcome: 'completed'
    });
    return { verified: true };
  });

  app.post<{ Body: { username?: string; displayName?: string } }>(
    '/v1/auth/dev',
    async (request, reply) => {
      if (!devAuthEnabled) throw new Error('Development authentication is disabled');
      const username = request.body.username?.trim().toLowerCase() || 'local';
      const user =
        (await store.getUserByUsername(username)) ??
        (await store.createUser({
          username,
          displayName: request.body.displayName?.trim() || 'Local User'
        }));
      await createSession(store, reply, user.id, secure, deviceLabel(request.headers), true);
      return { user, warning: 'Development authentication is enabled' };
    }
  );

  app.post('/v1/auth/logout', async (request, reply) => {
    await destroySession(store, reply, request.cookies[sessionCookieName(secure)], secure);
    return { ok: true };
  });
};
