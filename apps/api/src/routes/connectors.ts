import { registerAccountConnectorRoutes } from './account-connectors.js';
/**
 * Accounts the agent is allowed to act in: mailboxes, calendars, and MCP servers.
 *
 * Every endpoint a connector names is checked against the deployment host list before anything is
 * stored, and re-checked when the connection is tested, because the address is attacker-influenced
 * input the moment a connector is created from a catalogue entry.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { CreateConnectorRequest, StartMcpOAuthRequest } from '@athanor/contracts';
import type {
  Connector,
  ConnectorTestResult,
  StartConnectorOAuthResponse
} from '@athanor/contracts';
import {
  AthanorError,
  authorizeAccountConnector,
  isAccountConnectorKind,
  secureConnectorRequest,
  assertConnectorUrl,
  beginMcpOAuth,
  completeMcpOAuth,
  connectorCatalog,
  decryptJson,
  encryptJson,
  parseImapEndpoint,
  redactText,
  sha256,
  verifyConnector
} from '@athanor/core';
import type { ConnectorSecret } from '@athanor/core';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerConnectorRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    masterKey,
    connectorAllowedHosts,
    connectorResponse,
    config,
    overrides,
    requireRecentStepUp,
    idempotent
  } = context;
  app.get('/v1/connectors/catalog', async () => connectorCatalog);

  app.get('/v1/connectors', async (request) => {
    const user = requireUser(request.user);
    return (await store.listConnectors(user.id)).map(connectorResponse);
  });

  app.get<{ Querystring: { limit?: string } }>('/v1/connectors/audit', async (request) => {
    const user = requireUser(request.user);
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(request.query.limit);
    return store.listConnectorAudit(user.id, limit);
  });

  const connectorScopes = (
    kind: Connector['kind'],
    requested: Connector['scopes']
  ): Connector['scopes'] => {
    const definition = connectorCatalog.find((entry) => entry.kind === kind);
    if (!definition) throw new AthanorError('connector_kind_invalid', 'Connector is unavailable');
    const allowedScopes = new Set(definition.scopes.map((scope) => scope.id));
    if (requested.some((scope) => !allowedScopes.has(scope)))
      throw new AthanorError(
        'connector_scope_invalid',
        'One or more capabilities do not belong to this connector'
      );
    return [...new Set(requested)];
  };

  const connectorOAuthPage = (
    reply: FastifyReply,
    ok: boolean,
    message: string,
    statusCode = ok ? 200 : 400,
    source = 'athanor-mcp-oauth'
  ) => {
    const appUrl = new URL(config.PUBLIC_APP_URL);
    const targetOrigin = appUrl.origin;
    const event = JSON.stringify({ source, ok, message }).replaceAll('<', '\\u003c');
    const origin = JSON.stringify(targetOrigin).replaceAll('<', '\\u003c');
    const home = appUrl.toString().replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const title = ok ? 'Connection ready' : 'Connection not completed';
    const safeMessage = message
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    return reply
      .code(statusCode)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header(
        'content-security-policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
      )
      .type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08090b;color:#eef0f4;font:16px system-ui,sans-serif}.card{max-width:32rem;margin:2rem;padding:2rem;border:1px solid #5d626d;border-radius:1rem;background:#101217}h1{font-size:1.25rem}p{color:#c6c9d0;line-height:1.5}a{color:#fff}</style>
<main class="card"><h1>${title}</h1><p>${safeMessage}</p><a href="${home}">Return to athanor</a></main>
<script>if(window.opener){window.opener.postMessage(${event},${origin});setTimeout(()=>window.close(),500)}</script>
</html>`);
  };

  registerAccountConnectorRoutes(context, { connectorScopes, oauthPage: connectorOAuthPage });

  app.get('/v1/connectors/mcp/oauth/client-metadata', async (_request, reply) => {
    const clientId = new URL(
      '/v1/connectors/mcp/oauth/client-metadata',
      config.PUBLIC_APP_URL
    ).toString();
    const redirectUrl = new URL(
      '/v1/connectors/mcp/oauth/callback',
      config.PUBLIC_APP_URL
    ).toString();
    return reply.header('cache-control', 'public, max-age=3600').send({
      client_id: clientId,
      client_name: 'athanor',
      client_uri: config.PUBLIC_APP_URL,
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });
  });

  app.post('/v1/connectors/mcp/oauth/start', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = StartMcpOAuthRequest.parse(request.body);
      const scopes = connectorScopes('mcp_http', input.scopes);
      const baseUrl = new URL(input.baseUrl);
      const allowedHostSuffixes = connectorAllowedHosts('mcp_http', baseUrl.toString());
      assertConnectorUrl(baseUrl, allowedHostSuffixes);
      const state = randomBytes(32).toString('base64url');
      const attemptId = randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const redirectUrl = new URL('/v1/connectors/mcp/oauth/callback', config.PUBLIC_APP_URL);
      const clientMetadataUrl = new URL(
        '/v1/connectors/mcp/oauth/client-metadata',
        config.PUBLIC_APP_URL
      );
      const started = await beginMcpOAuth({
        baseUrl: baseUrl.toString(),
        redirectUrl: redirectUrl.toString(),
        state,
        ...(input.oauthScopes.length ? { scope: input.oauthScopes.join(' ') } : {}),
        ...(input.registration === 'static'
          ? {
              clientId: input.clientId,
              ...(input.clientSecret ? { clientSecret: input.clientSecret } : {})
            }
          : {}),
        ...(input.registration === 'dynamic' && clientMetadataUrl.protocol === 'https:'
          ? { clientMetadataUrl: clientMetadataUrl.toString() }
          : {}),
        allowedHostSuffixes,
        ...(overrides.connectorTransport ? { transport: overrides.connectorTransport } : {})
      });
      await store.createConnectorOAuthAttempt({
        id: attemptId,
        userId: user.id,
        label: input.label,
        baseUrl: baseUrl.toString(),
        scopes,
        stateHash: sha256(state),
        secretCiphertext: encryptJson(started.secret, masterKey, `connector-oauth:${attemptId}`),
        expiresAt
      });
      return {
        connectorId: attemptId,
        authorizationUrl: started.authorizationUrl,
        authorizationHost: new URL(started.authorizationUrl).hostname,
        expiresAt: expiresAt.toISOString()
      } satisfies StartConnectorOAuthResponse;
    });
  });

  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
  }>('/v1/connectors/mcp/oauth/callback', async (request, reply) => {
    try {
      const state = z.string().min(20).max(2048).parse(request.query.state);
      const attempt = await store.consumeConnectorOAuthAttempt(sha256(state));
      if (!attempt)
        throw new AthanorError(
          'connector_oauth_attempt_invalid',
          'This authorization link is invalid or has expired',
          400
        );
      if (request.query.error)
        return connectorOAuthPage(
          reply,
          false,
          'The MCP service did not grant access. You can safely close this window and try again.'
        );
      const authorizationCode = z.string().min(1).max(8192).parse(request.query.code);
      if (attempt.secretCiphertext.aad !== `connector-oauth:${attempt.id}`)
        throw new AthanorError(
          'connector_oauth_secret_context',
          'The authorization secret context is invalid'
        );
      const secret = decryptJson<ConnectorSecret>(attempt.secretCiphertext, masterKey);
      if (secret.mcpOAuth?.state !== state)
        throw new AthanorError(
          'connector_oauth_state_invalid',
          'The authorization state does not match'
        );
      const baseUrl = new URL(attempt.baseUrl);
      const allowedHostSuffixes = connectorAllowedHosts('mcp_http', baseUrl.toString());
      const completed = await completeMcpOAuth({
        baseUrl: baseUrl.toString(),
        secret,
        authorizationCode,
        allowedHostSuffixes,
        ...(overrides.connectorTransport ? { transport: overrides.connectorTransport } : {})
      });
      await verifyConnector({
        kind: 'mcp_http',
        baseUrl: baseUrl.toString(),
        secret: completed,
        allowedHostSuffixes,
        ...(overrides.connectorTransport ? { transport: overrides.connectorTransport } : {})
      });
      const id = attempt.id;
      const connector = await store.createConnector({
        id,
        userId: attempt.userId,
        kind: 'mcp_http',
        authMode: 'oauth',
        label: attempt.label,
        baseUrl: baseUrl.toString(),
        scopes: attempt.scopes,
        secretCiphertext: encryptJson(completed, masterKey, `connector:${attempt.userId}:${id}`)
      });
      await store.recordConnectorAudit({
        connectorId: connector.id,
        userId: attempt.userId,
        operation: 'oauth_connection_verified',
        outcome: 'succeeded'
      });
      return connectorOAuthPage(
        reply,
        true,
        `${attempt.label} is connected. This window will close automatically.`
      );
    } catch (error) {
      request.log.warn(
        {
          code: error instanceof AthanorError ? error.code : 'connector_oauth_callback_failed'
        },
        'MCP OAuth callback failed'
      );
      return connectorOAuthPage(
        reply,
        false,
        'The secure connection could not be completed. Close this window and try again.'
      );
    }
  });

  app.post('/v1/connectors', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = CreateConnectorRequest.parse(request.body);
      const scopes = connectorScopes(input.kind, input.scopes);
      const baseUrl =
        input.kind === 'github' ? 'https://api.github.com' : new URL(input.baseUrl).toString();
      /**
       * A mailbox address is not an HTTPS URL, so it cannot be checked like one: `imaps://host:993`
       * fails `assertConnectorUrl` on both the scheme and the port. `parseImapEndpoint` is the same
       * check written for the protocol that is actually spoken, and it is given the deployment list
       * alone rather than the list plus this connector's own host - for mail and calendar the list
       * is a statement about which providers this install may talk to at all, and an install that
       * has set one means it. Empty, which is the default, leaves the owner's own choice standing.
       *
       * A calendar needs no check here: the connector layer applies the same deployment binding and
       * the same HTTPS shape check while building its request context, which happens before the
       * password is put on a header. The other kinds keep their existing shape - the owner names an
       * HTTPS host and it is allowed because they named it.
       */
      const allowedHostSuffixes = connectorAllowedHosts(input.kind, baseUrl);
      if (input.kind === 'imap') parseImapEndpoint(baseUrl, allowedHostSuffixes);
      else if (input.kind === 'webdav' || input.kind === 'mcp_http')
        assertConnectorUrl(new URL(baseUrl), allowedHostSuffixes);
      const connectorSecret = (): ConnectorSecret => {
        switch (input.kind) {
          case 'github':
            return { token: input.token };
          case 'webdav':
            return { username: input.username, password: input.password };
          case 'imap':
            return {
              mail: {
                version: 1,
                username: input.username,
                password: input.password,
                fromAddress: input.fromAddress,
                ...(input.fromName ? { fromName: input.fromName } : {}),
                smtpHost: input.smtpHost,
                smtpPort: input.smtpPort
              }
            };
          case 'caldav':
            return {
              calendar: {
                version: 1,
                username: input.username,
                password: input.password,
                address: input.address
              }
            };
          default:
            return { ...(input.token ? { token: input.token } : {}) };
        }
      };
      const secret = connectorSecret();
      try {
        // Verification runs before anything is stored, and for a mailbox it exercises both halves:
        // an IMAP login and listing, then an SMTP submission login. Discovering at the moment of an
        // approval that sending was never going to work is the worst possible time to discover it.
        await verifyConnector({
          kind: input.kind,
          baseUrl,
          secret,
          allowedHostSuffixes,
          ...(overrides.connectorTransport ? { transport: overrides.connectorTransport } : {}),
          ...(overrides.mailSocketFactory ? { mailSocketFactory: overrides.mailSocketFactory } : {})
        });
      } catch (error) {
        if (error instanceof AthanorError) throw error;
        throw new AthanorError(
          'connector_connection_failed',
          error instanceof Error ? error.message : 'Connector could not be verified',
          400
        );
      }
      const id = randomUUID();
      const connector = await store.createConnector({
        id,
        userId: user.id,
        kind: input.kind,
        // Every kind but MCP carries a stored credential; MCP is the only one that can be reached
        // with a bearer token or with nothing at all.
        authMode: input.kind !== 'mcp_http' ? 'secret' : input.token ? 'bearer' : 'none',
        label: input.label,
        baseUrl,
        scopes,
        secretCiphertext: encryptJson(secret, masterKey, `connector:${user.id}:${id}`)
      });
      await store.recordConnectorAudit({
        connectorId: connector.id,
        userId: user.id,
        operation: 'connection_verified',
        outcome: 'succeeded'
      });
      return connectorResponse({ ...connector, lastUsedAt: new Date().toISOString() });
    });
  });

  /**
   * Ask a connected account whether it still works.
   *
   * A mailbox is verified once, when it is added, and then trusted for as long as it exists - so a
   * changed password, a moved server or an expired authorization is discovered by the agent, mid
   * task, as a failure the owner has to read backwards from. This is the same verification the
   * connect route runs, against the stored credential, on demand.
   *
   * It answers 200 whether or not the account replied: "does this still work" is a question, and
   * "no, the submission host refused the login" is a successful answer to it. There is no step-up
   * here, because nothing is revealed and nothing changes - except an MCP authorization, which is
   * refreshed and re-sealed exactly as it is when the agent uses one, so re-checking an expired
   * token is also how it is renewed.
   */
  app.post<{ Params: { connectorId: string } }>(
    '/v1/connectors/:connectorId/test',
    async (request) => {
      const user = requireUser(request.user);
      const connector = await store.getConnector(user.id, request.params.connectorId);
      if (!connector) throw new AthanorError('connector_not_found', 'Connector not found', 404);
      if (connector.secretCiphertext.aad !== `connector:${user.id}:${connector.id}`)
        throw new AthanorError(
          'connector_secret_context',
          'Connector secret encryption context is invalid'
        );
      const checkedAt = new Date().toISOString();
      try {
        const secret = isAccountConnectorKind(connector.kind)
          ? await store.withConnectorAuthorization(user.id, connector.id, (current) =>
              authorizeAccountConnector(
                current,
                masterKey,
                overrides.connectorTransport ?? secureConnectorRequest
              )
            )
          : decryptJson<ConnectorSecret>(connector.secretCiphertext, masterKey);
        const verified = await verifyConnector({
          kind: connector.kind,
          baseUrl: connector.baseUrl,
          secret,
          allowedHostSuffixes: connectorAllowedHosts(connector.kind, connector.baseUrl),
          onSecretUpdated: async (updated) => {
            const saved = await store.updateConnectorSecret(
              user.id,
              connector.id,
              encryptJson(updated, masterKey, `connector:${user.id}:${connector.id}`)
            );
            if (!saved)
              throw new AthanorError(
                'connector_secret_update_failed',
                'The refreshed connector authorization could not be saved'
              );
          },
          ...(overrides.connectorTransport ? { transport: overrides.connectorTransport } : {}),
          ...(overrides.mailSocketFactory ? { mailSocketFactory: overrides.mailSocketFactory } : {})
        });
        await store.recordConnectorAudit({
          connectorId: connector.id,
          userId: user.id,
          operation: 'connection_rechecked',
          outcome: 'succeeded',
          statusCode: verified.statusCode
        });
        return {
          connectorId: connector.id,
          ok: true,
          accountLabel: verified.accountLabel,
          checkedAt,
          failure: null
        } satisfies ConnectorTestResult;
      } catch (error) {
        /**
         * Scrubbed here rather than on the way out.
         *
         * This route is documented above as answering 200 whether or not the account replied, so
         * the failure never travels through the error handler - and the error handler is the only
         * other place a message built from an upstream response gets `redactText` run over it. The
         * text on this arm is written by the mailbox, the CalDAV host or the MCP server: an IMAP
         * greeting, a chain error, a URL the connector was configured with - and a URL is the one
         * shape that carries a whole credential in it (`URL_CREDENTIALS`). The slice is the same
         * bound `/v1/relay/enrollment` puts on the same class of borrowed text.
         */
        const failureMessage = (message: string): string => redactText(message).slice(0, 200);
        const failure =
          error instanceof AthanorError
            ? { code: error.code, message: failureMessage(error.message) }
            : {
                code: 'connector_connection_failed',
                message:
                  error instanceof Error
                    ? failureMessage(error.message)
                    : 'The account did not answer'
              };
        await store.recordConnectorAudit({
          connectorId: connector.id,
          userId: user.id,
          operation: 'connection_rechecked',
          outcome: 'failed'
        });
        request.log.warn({ connectorId: connector.id, code: failure.code }, 'connector.recheck');
        return {
          connectorId: connector.id,
          ok: false,
          accountLabel: null,
          checkedAt,
          failure
        } satisfies ConnectorTestResult;
      }
    }
  );

  app.delete<{ Params: { connectorId: string } }>(
    '/v1/connectors/:connectorId',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const connector = await store.getConnector(user.id, request.params.connectorId);
        if (!connector) throw new AthanorError('connector_not_found', 'Connector not found', 404);
        const revoked = await store.revokeConnector(user.id, connector.id);
        if (revoked)
          await store.recordConnectorAudit({
            connectorId: connector.id,
            userId: user.id,
            operation: 'revoke',
            outcome: 'succeeded'
          });
        return { revoked };
      });
    }
  );
};
