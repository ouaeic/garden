import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StartAccountOAuthRequest, type Connector } from '@athanor/contracts';
import {
  AccountOAuth,
  AthanorError,
  accountConnectorBase,
  beginAccountOAuth,
  completeAccountOAuth,
  decryptJson,
  encryptJson,
  secureConnectorRequest,
  sha256
} from '@athanor/core';
import type { FastifyReply } from 'fastify';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export function registerAccountConnectorRoutes(
  context: RouteContext,
  helpers: {
    connectorScopes: (kind: Connector['kind'], scopes: Connector['scopes']) => Connector['scopes'];
    oauthPage: (
      reply: FastifyReply,
      ok: boolean,
      message: string,
      statusCode?: number,
      source?: string
    ) => FastifyReply;
  }
) {
  const { app, store, config, masterKey, requireRecentStepUp, idempotent, overrides } = context;
  const redirectUrl = new URL(
    '/v1/connectors/accounts/oauth/callback',
    config.PUBLIC_APP_URL
  ).toString();
  app.get('/v1/connectors/accounts/oauth/config', async () => ({ redirectUrl }));
  app.post('/v1/connectors/accounts/oauth/start', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = StartAccountOAuthRequest.parse(request.body);
      const scopes = helpers.connectorScopes(input.provider, input.scopes);
      const started = beginAccountOAuth({ ...input, scopes, redirectUrl });
      const id = randomUUID(),
        expiresAt = new Date(Date.now() + 10 * 60_000);
      await store.createConnectorOAuthAttempt({
        id,
        userId: user.id,
        label: input.label,
        baseUrl: accountConnectorBase(input.provider),
        scopes,
        stateHash: sha256(started.secret.pending!.state),
        secretCiphertext: encryptJson(
          { accountOAuth: started.secret },
          masterKey,
          `connector-oauth:${id}`
        ),
        expiresAt
      });
      return {
        connectorId: id,
        authorizationUrl: started.authorizationUrl,
        authorizationHost: new URL(started.authorizationUrl).hostname,
        expiresAt: expiresAt.toISOString()
      };
    });
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    '/v1/connectors/accounts/oauth/callback',
    async (request, reply) => {
      const page = (ok: boolean, message: string) =>
        helpers.oauthPage(reply, ok, message, ok ? 200 : 400, 'athanor-account-oauth');
      try {
        const state = z.string().min(32).max(128).parse(request.query.state);
        const attempt = await store.consumeConnectorOAuthAttempt(sha256(state));
        if (!attempt || attempt.secretCiphertext.aad !== `connector-oauth:${attempt.id}`)
          throw new AthanorError(
            'connector_oauth_attempt_invalid',
            'This connection link has expired or was already used. Start again from Connected services.'
          );
        if (request.query.error)
          return page(
            false,
            'Account access was not granted. You can close this window and try again.'
          );
        const sealed = decryptJson<{ accountOAuth: unknown }>(attempt.secretCiphertext, masterKey);
        const secret = AccountOAuth.parse(sealed.accountOAuth);
        if (
          secret.redirectUrl !== redirectUrl ||
          attempt.baseUrl !== accountConnectorBase(secret.provider)
        )
          throw new AthanorError(
            'connector_oauth_state_invalid',
            'The account callback does not match this connection attempt.'
          );
        const scopes = helpers.connectorScopes(secret.provider, attempt.scopes);
        const completed = await completeAccountOAuth({
          secret,
          state,
          code: z.string().min(1).max(8192).parse(request.query.code),
          transport: overrides.connectorTransport ?? secureConnectorRequest
        });
        const id = attempt.id;
        await store.createConnector({
          id,
          userId: attempt.userId,
          kind: completed.provider,
          authMode: 'oauth',
          label: attempt.label,
          baseUrl: accountConnectorBase(completed.provider),
          scopes,
          secretCiphertext: encryptJson(
            { accountOAuth: completed },
            masterKey,
            `connector:${attempt.userId}:${id}`
          )
        });
        await store.recordConnectorAudit({
          connectorId: id,
          userId: attempt.userId,
          operation: 'oauth_connection_verified',
          outcome: 'succeeded'
        });
        return page(true, `${attempt.label} is connected as ${completed.account!.address}.`);
      } catch (error) {
        request.log.warn(
          { code: error instanceof AthanorError ? error.code : 'connector_oauth_failed' },
          'Account connection was not completed'
        );
        return page(
          false,
          error instanceof AthanorError
            ? error.message
            : 'The connection could not be completed. Start again from Connected services.'
        );
      }
    }
  );
}
