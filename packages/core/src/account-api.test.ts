import { describe, expect, it, vi } from 'vitest';
import { AccountApi } from './account-api.js';
import type { AccountOAuth } from './account-oauth.js';
import type { ConnectorTransport } from './connectors.js';

const secret = (provider: 'google' | 'microsoft' = 'google'): AccountOAuth => ({
  version: 1,
  provider,
  clientId: 'client',
  clientSecret: 'CLIENT_SECRET_CANARY',
  redirectUrl: 'https://garden.example/callback',
  requestedScopes: ['read'],
  account: { id: 'one-owner', address: 'owner@example.org' },
  tokens: {
    accessToken: 'ACCESS_TOKEN_CANARY',
    refreshToken: 'REFRESH_TOKEN_CANARY',
    expiresAt: Date.now() + 3600_000,
    scopes: ['read']
  }
});
const response = (status = 200, body: unknown = {}) => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
  durationMs: 7
});

describe('curated account API transport', () => {
  it('uses fixed service endpoints and never follows another account or origin through a cursor', async () => {
    const transport = vi.fn<ConnectorTransport>().mockResolvedValue(response());
    const api = new AccountApi(secret(), transport);
    const collection = api.url('gmail', 'messages', { q: 'from:someone@example.org' });
    const next = new URL(collection);
    next.searchParams.set('pageToken', 'opaque-token');
    const cursor = api.nextCursor(collection, next.toString())!;
    expect(api.pageUrl(collection, cursor).toString()).toBe(next.toString());
    expect(() => api.pageUrl(api.url('gmail', 'messages', { q: 'different' }), cursor)).toThrow(
      'same account and search'
    );
    const other = secret();
    other.account!.id = 'another-owner';
    expect(() => new AccountApi(other, transport).pageUrl(collection, cursor)).toThrow(
      'same account and search'
    );
    for (const url of [
      'https://attacker.example/messages',
      'https://gmail.googleapis.com/gmail/v1/users/other/messages',
      'https://gmail.googleapis.com/gmail/v1/users/me/settings/forwardingAddresses'
    ])
      expect(() => api.nextCursor(collection, url)).toThrow('same account and search');
    expect(() => api.url('graph', 'messages')).toThrow('does not belong');
    await expect(
      api.request(
        new URL('https://gmail.googleapis.com.attacker.example/gmail/v1/users/me/messages')
      )
    ).rejects.toThrow('outside');
    await expect(
      api.request(new URL('https://user:pass@gmail.googleapis.com/gmail/v1/users/me/messages'))
    ).rejects.toThrow('outside');
    expect(transport).not.toHaveBeenCalled();
  });

  it('sends the access token only in headers, requests immutable IDs, and counts transferred bytes', async () => {
    const transport = vi.fn<ConnectorTransport>().mockResolvedValue(response(200, { value: [] }));
    const api = new AccountApi(secret('microsoft'), transport);
    await api.json(api.url('graph', 'messages', { $top: '25' }));
    const request = transport.mock.calls[0]![0];
    expect(request.headers.authorization).toBe('Bearer ACCESS_TOKEN_CANARY');
    expect(request.headers.prefer).toContain('ImmutableId');
    expect(request.allowedHostSuffixes).toEqual(['graph.microsoft.com']);
    expect(request.timeoutMs).toBe(20_000);
    expect(request.url.toString()).not.toContain('CANARY');
    expect(JSON.stringify(request.body)).toBeUndefined();
    expect(api.metrics).toEqual({
      requestBytes: 0,
      responseBytes: Buffer.byteLength('{"value":[]}'),
      durationMs: 7,
      statusCode: 200
    });
  });

  it.each([301, 401, 403, 404, 429, 500])(
    'never retries status %s or exposes provider bodies',
    async (status) => {
      const transport = vi
        .fn<ConnectorTransport>()
        .mockResolvedValue(response(status, { error: 'UPSTREAM_SECRET_CANARY' }));
      const api = new AccountApi(secret(), transport);
      await expect(api.json(api.url('gmail', 'messages'))).rejects.toThrow();
      try {
        await api.json(api.url('gmail', 'messages'));
      } catch (error) {
        expect(String(error)).not.toContain('CANARY');
      }
      expect(transport).toHaveBeenCalledTimes(2);
    }
  );

  it('rejects expired credentials, denied capabilities, invalid JSON and transfer bounds', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockResolvedValue({ ...response(), body: Buffer.from('not json PRIVATE_CANARY') });
    const expired = secret();
    expired.tokens!.expiresAt = 1;
    expect(() => new AccountApi(expired, transport)).toThrow('Refresh');
    const api = new AccountApi(secret(), transport);
    expect(() => api.requireScope(['mail:mailbox.read'], 'mail:message.send')).toThrow(
      'has not granted'
    );
    await expect(
      api.request(api.url('gmail', 'messages'), { maxBytes: 40_000_001 })
    ).rejects.toThrow('limit');
    expect(transport).not.toHaveBeenCalled();
    await expect(api.json(api.url('gmail', 'messages'))).rejects.toThrow('unreadable response');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('enforces the requested response size even if a transport returns too many bytes', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockResolvedValue(response(200, { private: 'BODY_CANARY' }));
    const api = new AccountApi(secret(), transport);
    await expect(api.json(api.url('gmail', 'messages'), { maxBytes: 4 })).rejects.toThrow(
      'transfer limit'
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
