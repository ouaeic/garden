import { z } from 'zod';
import { GardenError, sha256 } from '@garden/core';
import { NativeAuthorizationProof, NativeAuthorizationStart } from '@garden/contracts';
import { NativeAuthorizationStore } from '@garden/data';
import type { RouteContext } from '../http/server-context.js';
import { requireUser } from '../http/auth-hook.js';
import { deviceLabel } from '../auth-routes.js';
import {
  SESSION_LIFETIME_SECONDS,
  STEP_UP_WINDOW_SECONDS,
  sessionCookieName,
  setSessionCookie
} from '../session.js';

export function registerNativeAuthorizationRoutes(context: RouteContext): void {
  const { app, database, store, config, secure, checkShareRate } = context;
  const authorizations = new NativeAuthorizationStore(database, STEP_UP_WINDOW_SECONDS);
  const serverOrigin = new URL(config.PUBLIC_APP_URL).origin;
  app.post('/v1/auth/native/start', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = NativeAuthorizationStart.parse(request.body);
    const token = request.cookies[sessionCookieName(secure)];
    if (request.apiToken)
      throw new GardenError('session_required', 'Use a signed-in device to authorize garden', 403);
    const authorization = await authorizations.start({
      ...input,
      serverOrigin,
      deviceLabel: deviceLabel(request.headers),
      ...(request.user ? { userId: request.user.id } : {}),
      ...(token ? { sessionHash: sha256(token) } : {})
    });
    return {
      ...authorization,
      verificationUri: `${serverOrigin}/#native-auth=${authorization.id}`,
      pollIntervalMs: 5000
    };
  });
  app.get<{ Params: { id: string } }>('/v1/auth/native/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return authorizations.inspect(
      z.uuid().parse(request.params.id),
      serverOrigin,
      requireUser(request.user).id
    );
  });
  app.post<{ Params: { id: string } }>('/v1/auth/native/:id/decision', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = requireUser(request.user);
    const token = request.cookies[sessionCookieName(secure)];
    if (!token || request.apiToken)
      throw new GardenError('session_required', 'Use your passkey to authorize this device', 403);
    const input = z
      .object({ userCode: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/), approve: z.boolean() })
      .strict()
      .parse(request.body);
    return authorizations.decide({
      ...input,
      id: z.uuid().parse(request.params.id),
      serverOrigin,
      userId: user.id,
      sessionHash: sha256(token)
    });
  });
  app.post('/v1/auth/native/redeem', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    checkShareRate(`native-authorization:${request.ip}`);
    if (request.apiToken)
      throw new GardenError('device_proof_required', 'Use the requesting garden device', 403);
    const input = NativeAuthorizationProof.parse(request.body);
    const token = request.cookies[sessionCookieName(secure)];
    const result = await authorizations.redeem({
      ...input,
      serverOrigin,
      ...(token ? { sessionHash: sha256(token) } : {}),
      sessionLifetimeSeconds: SESSION_LIFETIME_SECONDS
    });
    if (result.status !== 'authorized') return { status: result.status };
    const user = await store.getUserById(result.userId);
    if (!user) throw new GardenError('account_unavailable', 'This account is unavailable', 401);
    if (result.token && result.expiresAt)
      setSessionCookie(reply, result.token, secure, result.expiresAt);
    return {
      status: 'authorized',
      user: { id: user.id, username: user.username, displayName: user.displayName }
    };
  });
}
