/**
 * The owner themselves: who they are signed in as, what else is signed in, their API tokens, and
 * the two ways to end it all.
 *
 * Deleting the account and minting a fresh recovery code both sit behind a step-up, because a
 * borrowed unlocked laptop is exactly the threat they answer.
 */

import { randomBytes } from 'node:crypto';
import { CreateApiTokenRequest, OwnerPreferences } from '@garden/contracts';
import { GardenError, hashRecoveryCode, sha256 } from '@garden/core';
import type { ApiTokenRecord } from '@garden/data';
import { z } from 'zod';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { recordSecurityEvent } from '../security-events.js';
import { sessionCookieName } from '../session.js';
import { removeCodingMissionFamily } from '../coding-mission-cleanup.js';

export const registerAccountRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    runner,
    secure,
    meterWorkspace,
    apiTokenResponse,
    requireRecentStepUp,
    idempotent
  } = context;
  /**
   * Who this request is signed in as.
   *
   * Not the whole `UserRecord`, because `UserRecord` carries `recoveryHash` - the
   * scrypt hash of the account recovery code, which is the credential that reassigns the account
   * when every passkey is gone. Handing it to the browser puts it in every heap dump, devtools tab
   * and error report the page can produce, and it is offline-crackable at whatever cost scrypt was
   * configured with rather than at the rate `POST /v1/auth/recover` will answer. Nothing needs it
   * from here: the only readers of `recoveryHash` anywhere in this repository are the two recovery
   * routes in auth-routes.ts, which read it from the store.
   *
   * The reach is the browser and nothing else - `requiredApiTokenScope` has no entry for
   * `/v1/auth`, so a bearer token is refused this route outright - which is why a field leaked here
   * leaks into the page rather than into an automation.
   *
   * Named fields rather than a delete, so a field added to `UserRecord` later is not published by
   * default; a client that needs the new one asks for it here.
   */
  app.get('/v1/auth/me', async (request) => {
    const user = requireUser(request.user);
    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        preferences: user.preferences,
        createdAt: user.createdAt
      }
    };
  });

  app.get('/v1/sessions', async (request) => {
    const user = requireUser(request.user);
    const currentHash = request.cookies[sessionCookieName(secure)]
      ? sha256(request.cookies[sessionCookieName(secure)]!)
      : null;
    const sessions = await store.listSessions(user.id);
    if (!currentHash) return sessions;
    const currentId = await store.getSessionPublicId(user.id, currentHash);
    return sessions.map((session) => ({ ...session, current: session.id === currentId }));
  });

  /**
   * A fresh recovery code for an owner who still has a passkey but has lost the paper.
   *
   * Step-up first and always: a recovery code is a permanent way back into the account from any
   * device, so anyone who could reach an unlocked browser could otherwise mint themselves one. The
   * code is shown once - nothing here can read it back, only replace it again.
   */
  app.post('/v1/auth/recovery-code', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const recoveryCode = randomBytes(18).toString('base64url');
    const replaced = await store.setRecoveryHash(user.id, await hashRecoveryCode(recoveryCode));
    if (!replaced) throw new GardenError('user_not_found', 'Account not found', 404);
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'recovery_code_reissued',
      outcome: 'completed'
    });
    return { recoveryCode };
  });

  app.get('/v1/api-tokens', async (request) => {
    const user = requireUser(request.user);
    return (await store.listApiTokens(user.id)).map(apiTokenResponse);
  });

  app.post('/v1/api-tokens', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const input = CreateApiTokenRequest.parse(request.body);
    const value = `oc_live_${randomBytes(32).toString('base64url')}`;
    let created: ApiTokenRecord;
    try {
      created = await store.createApiToken({
        userId: user.id,
        label: input.label,
        tokenHash: sha256(value),
        prefix: value.slice(0, 16),
        scopes: [...new Set(input.scopes)],
        expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1_000)
      });
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'api_token_limit')
        throw new GardenError(
          'api_token_limit',
          'Revoke an existing API token before creating another',
          409
        );
      throw cause;
    }
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'api_token_create',
      outcome: 'completed',
      metadata: { tokenId: created.id, scopes: created.scopes }
    });
    return { apiToken: apiTokenResponse(created), token: value };
  });

  app.delete<{ Params: { tokenId: string } }>('/v1/api-tokens/:tokenId', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const tokenId = z.string().uuid().parse(request.params.tokenId);
    const revoked = await store.revokeApiToken(user.id, tokenId);
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'api_token_revoke',
      outcome: revoked ? 'completed' : 'not_found',
      metadata: { tokenId }
    });
    return { revoked };
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const sessionId = z.string().uuid().parse(request.params.sessionId);
        const deletedHash = await store.deleteSessionForUser(user.id, sessionId);
        const token = request.cookies[sessionCookieName(secure)];
        const current = Boolean(token && deletedHash && sha256(token) === deletedHash);
        if (current)
          // `lax`, matching `SAME_SITE` in session.ts. A clearing header whose attributes differ
          // from the ones the cookie was set with is a header a browser is entitled to treat as
          // being about a different cookie.
          reply.clearCookie(sessionCookieName(secure), {
            path: '/',
            httpOnly: true,
            secure,
            sameSite: 'lax'
          });
        return { revoked: Boolean(deletedHash), current };
      });
    }
  );

  /**
   * The stored preferences, for a caller that is not the browser.
   *
   * The browser never needed this - it is handed the whole object in the bootstrap - so the write
   * route below shipped without a read beside it. That was survivable while nothing on the server
   * read the preferences either; it is not now that an automatic model pick honours them, because a
   * headless client was then governed by a setting it had no way to see.
   *
   * A bearer token gets the `model` key and nothing else. The scope this route sits under is
   * `models:read` (see `requiredApiTokenScope`), and `place` names the conversation and computer the
   * owner last had open, which is `tasks:read` by any honest reading. The session caller is the
   * owner at their own keyboard and gets the row.
   */
  app.get('/v1/account/preferences', async (request) => {
    const user = requireUser(request.user);
    const preferences = request.apiToken
      ? { ...(user.preferences.model === undefined ? {} : { model: user.preferences.model }) }
      : user.preferences;
    return { preferences };
  });

  app.put('/v1/account/preferences', async (request) => {
    const user = requireUser(request.user);
    const patch = OwnerPreferences.parse(request.body ?? {});
    return { preferences: await store.mergeUserPreferences(user.id, patch) };
  });

  app.delete<{ Body: { confirmUsername: string } }>('/v1/account', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = z.object({ confirmUsername: z.string() }).parse(request.body);
      if (input.confirmUsername.toLowerCase() !== user.username.toLowerCase())
        throw new GardenError(
          'confirmation_failed',
          'Type the exact username to delete the account'
        );
      const workspaces = await store.listWorkspaceMetadata(user.id);
      for (const workspace of workspaces)
        await store.updateWorkspaceStatus(workspace.id, 'deleting');
      const tasks = (
        await Promise.all(workspaces.map((workspace) => store.listTasks(user.id, workspace.id)))
      ).flat();
      for (const task of tasks) await store.cancelTaskAndReleaseReservations(user.id, task.id);
      for (const task of tasks)
        if (task.hasCodingFamily && !task.parentMissionId)
          await removeCodingMissionFamily(context, task);
      for (const workspace of workspaces) await meterWorkspace(workspace);
      // Cancellation waits for an allocating mission's parent lock before native roots are read.
      const deletionRoots = await store.listWorkspaceMetadata(user.id);
      deletionRoots.sort(
        (left, right) =>
          Number(Boolean(right.parentWorkspaceId)) - Number(Boolean(left.parentWorkspaceId))
      );
      for (const workspace of deletionRoots) {
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['workspace.manage'],
          path: `/v1/workspaces/${workspace.id}`,
          method: 'DELETE'
        });
      }
      await store.deleteUser(user.id);
      /**
       * The same attributes the cookie was set with, because a `Set-Cookie` is only a deletion if
       * the browser accepts it. On a deployment the name is `__Host-garden_session`, and the
       * `__Host-` prefix rules require `Secure` and `Path=/` with no `Domain` - without `Secure`
       * the whole header is discarded and the cookie stays where it is. `preview-gateway.ts`
       * records what a prefix mismatch cost this project once already.
       */
      reply.clearCookie(sessionCookieName(secure), {
        path: '/',
        httpOnly: true,
        secure,
        sameSite: 'lax'
      });
      return {
        deleted: true,
        volumeDeletionRequested: true,
        applicationKeyRecordsDeleted: true,
        backupExpiry: 'according_to_deployment_retention_policy'
      };
    });
  });
};
