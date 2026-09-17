import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  accountOAuthScopes,
  beginAccountOAuth,
  completeAccountOAuth,
  refreshAccountOAuth,
  verifyAccountOAuthIdentity,
  type AccountOAuth,
  type AccountProvider
} from './account-oauth.js';
import type { ConnectorTransport } from './connectors.js';

const start = (provider: AccountProvider = 'google') =>
  beginAccountOAuth({
    provider,
    clientId: 'owner-client',
    clientSecret: 'CLIENT_SECRET_CANARY',
    redirectUrl: 'https://garden.example/v1/connectors/accounts/oauth/callback',
    scopes: ['mail:mailbox.read', 'calendar:calendars.read']
  });
const response = (value: unknown, status = 200) => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(value)),
  durationMs: 1
});
const tokens = (secret: AccountOAuth, extra = {}) => ({
  access_token: 'ACCESS_TOKEN_CANARY',
  token_type: 'Bearer',
  refresh_token: 'REFRESH_TOKEN_CANARY',
  expires_in: 3600,
  scope: secret.requestedScopes.join(' '),
  ...extra
});

describe('curated account authorization', () => {
  it.each(['google', 'microsoft'] as const)(
    'binds %s consent to selected capabilities, state, PKCE and the owner callback',
    async (provider) => {
      const begun = start(provider),
        url = new URL(begun.authorizationUrl);
      expect(url.searchParams.get('state')).toBe(begun.secret.pending!.state);
      expect(url.searchParams.get('code_challenge')).toBe(
        createHash('sha256').update(begun.secret.pending!.verifier).digest('base64url')
      );
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('redirect_uri')).toBe(begun.secret.redirectUrl);
      expect(begun.authorizationUrl).not.toContain('CLIENT_SECRET_CANARY');
      expect(begun.authorizationUrl).not.toContain(begun.secret.pending!.verifier);
      expect(url.searchParams.get('scope')).not.toMatch(/Mail\.Send|gmail\.send|Drive/);
      const transport = vi
        .fn<ConnectorTransport>()
        .mockResolvedValueOnce(response(tokens(begun.secret)))
        .mockResolvedValueOnce(
          response(
            provider === 'google'
              ? { sub: 'account-1', email: 'owner@example.org', email_verified: true }
              : { id: 'account-1', mail: 'owner@example.org' }
          )
        );
      const result = await completeAccountOAuth({
        secret: begun.secret,
        state: begun.secret.pending!.state,
        code: 'one-use-code',
        transport,
        now: 1_000_000
      });
      expect(result.account).toEqual({ id: 'account-1', address: 'owner@example.org' });
      expect(result.pending).toBeUndefined();
      expect(result.tokens!.expiresAt).toBe(4_600_000);
      expect(transport).toHaveBeenCalledTimes(2);
      const exchange = transport.mock.calls[0]![0];
      expect(exchange.url.search).toBe('');
      const fields = new URLSearchParams(exchange.body!.toString());
      expect(fields.get('client_secret')).toBe('CLIENT_SECRET_CANARY');
      expect(fields.get('code_verifier')).toBe(begun.secret.pending!.verifier);
      expect(fields.get('redirect_uri')).toBe(begun.secret.redirectUrl);
      const identity = transport.mock.calls[1]![0];
      expect(identity.headers.authorization).toBe('Bearer ACCESS_TOKEN_CANARY');
      expect(identity.allowedHostSuffixes).toEqual([identity.url.hostname]);
      expect(exchange.allowedHostSuffixes).toEqual([exchange.url.hostname]);
    }
  );

  it('refuses unrelated capabilities and callback destinations before beginning authorization', () => {
    expect(() => accountOAuthScopes('google', ['github:profile.read'])).toThrow(
      'mail and calendar'
    );
    expect(() => accountOAuthScopes('microsoft', [])).toThrow('Choose mail or calendar');
    for (const redirectUrl of [
      'http://remote.example/callback',
      'https://user:secret@remote.example/callback',
      'https://garden.example/callback#secret',
      'https://garden.example/callback?forward=evil'
    ]) {
      expect(() =>
        beginAccountOAuth({
          provider: 'google',
          clientId: 'id',
          clientSecret: 'secret',
          redirectUrl,
          scopes: ['mail:mailbox.read']
        })
      ).toThrow();
    }
  });

  it('rejects mismatched and already-completed states without a token request', async () => {
    const secret = start().secret,
      transport = vi.fn<ConnectorTransport>();
    await expect(
      completeAccountOAuth({ secret, state: 'wrong-state', code: 'code', transport })
    ).rejects.toThrow('does not match');
    const { pending: _pending, ...completed } = secret;
    await expect(
      completeAccountOAuth({
        secret: completed,
        state: secret.pending!.state,
        code: 'code',
        transport
      })
    ).rejects.toThrow('does not match');
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not accept partial grants or a missing offline token', async () => {
    const secret = start().secret;
    for (const body of [
      tokens(secret, { scope: 'openid email' }),
      tokens(secret, { refresh_token: undefined })
    ]) {
      const transport = vi.fn<ConnectorTransport>().mockResolvedValue(response(body));
      await expect(
        completeAccountOAuth({ secret, state: secret.pending!.state, code: 'code', transport })
      ).rejects.toThrow();
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects redirects and keeps provider error payloads out of surfaced errors', async () => {
    const secret = start().secret;
    for (const status of [302, 400, 500]) {
      const transport = vi.fn<ConnectorTransport>().mockResolvedValue(
        response(
          {
            error: 'bad_request',
            error_description: 'ACCESS_TOKEN_CANARY REFRESH_TOKEN_CANARY CLIENT_SECRET_CANARY'
          },
          status
        )
      );
      const error: unknown = await completeAccountOAuth({
        secret,
        state: secret.pending!.state,
        code: 'code',
        transport
      }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('CANARY');
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
});

describe('account token refresh', () => {
  function connected(provider: AccountProvider = 'microsoft'): AccountOAuth {
    const { pending: _pending, ...secret } = start(provider).secret;
    return {
      ...secret,
      account: { id: 'account-1', address: 'owner@example.org' },
      tokens: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 2_000_000,
        scopes: secret.requestedScopes
      }
    };
  }
  it('uses an unexpired token without a network request', async () => {
    const secret = connected(),
      transport = vi.fn<ConnectorTransport>();
    expect(await refreshAccountOAuth(secret, transport, 1_000_000)).toEqual(secret);
    expect(transport).not.toHaveBeenCalled();
  });
  it('returns rotated refresh credentials for durable replacement', async () => {
    const secret = connected();
    const transport = vi.fn<ConnectorTransport>().mockResolvedValue(
      response(
        tokens(secret, {
          scope:
            'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Calendars.Read',
          refresh_token: 'new-refresh'
        })
      )
    );
    const fresh = await refreshAccountOAuth(secret, transport, 1_950_000);
    expect(fresh.tokens!.refreshToken).toBe('new-refresh');
    expect(fresh.account).toEqual(secret.account);
    expect(
      new URLSearchParams(transport.mock.calls[0]![0].body!.toString()).get('refresh_token')
    ).toBe('old-refresh');
    expect(secret.tokens!.refreshToken).toBe('old-refresh');
  });
  it('retains the current refresh token when a provider does not rotate it', async () => {
    const secret = connected('google');
    const transport = vi.fn<ConnectorTransport>().mockResolvedValue(
      response(
        tokens(secret, {
          refresh_token: undefined,
          scope:
            'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly'
        })
      )
    );
    expect((await refreshAccountOAuth(secret, transport, 1_950_000)).tokens!.refreshToken).toBe(
      'old-refresh'
    );
  });
  it('requires reconnect after revoked access and never retries the token request', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockResolvedValue(response({ error: 'invalid_grant' }, 400));
    await expect(refreshAccountOAuth(connected(), transport, 1_950_000)).rejects.toMatchObject({
      code: 'connector_reauthorization_required'
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('refuses an account identity change and unverified Google email during connection checks', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockResolvedValue(response({ id: 'different-account', mail: 'other@example.org' }));
    await expect(verifyAccountOAuthIdentity(connected(), transport)).rejects.toThrow(
      'different account'
    );
    transport.mockResolvedValue(
      response({ sub: 'account-1', email: 'owner@example.org', email_verified: false })
    );
    await expect(verifyAccountOAuthIdentity(connected('google'), transport)).rejects.toThrow(
      'verified account'
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
