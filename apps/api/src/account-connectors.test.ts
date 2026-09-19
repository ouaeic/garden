import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  decryptJson,
  encryptJson,
  type AccountOAuth,
  type ConnectorTransport
} from '@athanor/core';
import type { Connector } from '@athanor/contracts';
import { buildServer } from './server.js';
import type { ApiConfig } from './config.js';

describe('native account authorization routes', () => {
  let server: Awaited<ReturnType<typeof buildServer>>,
    directory: string,
    cookie: string,
    userId: string;
  const masterKey = Buffer.alloc(32, 9);
  let scopes = '',
    refreshes = 0;
  const transport = vi.fn<ConnectorTransport>(async (request) => {
    const body = new URLSearchParams(request.body ? Buffer.from(request.body).toString() : '');
    const value = request.url.pathname.endsWith('/token')
      ? (() => {
          if (body.get('grant_type') === 'refresh_token') {
            expect(body.get('refresh_token')).toBe('REFRESH_CANARY');
            refreshes += 1;
          }
          return {
            access_token: 'ACCESS_CANARY',
            token_type: 'Bearer',
            refresh_token:
              body.get('grant_type') === 'refresh_token' ? 'ROTATED_CANARY' : 'REFRESH_CANARY',
            expires_in: 3600,
            scope: scopes
          };
        })()
      : request.url.hostname === 'openidconnect.googleapis.com'
        ? { sub: 'google-owner', email: 'owner@example.org', email_verified: true }
        : request.url.hostname === 'graph.microsoft.com'
          ? { id: 'graph-owner', mail: 'owner@example.org' }
          : (() => {
              throw new Error(
                `Unexpected fixture endpoint: ${request.url.origin}${request.url.pathname}`
              );
            })();
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)), durationMs: 1 };
  });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'garden-account-api-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: [] }))
    );
    server = await buildServer(isolatedConfig(directory), {
      connectorTransport: transport,
      masterKey
    });
    const login = await server.app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
    const setCookie = login.headers['set-cookie'];
    cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';', 1)[0]!;
    expect(cookie).toBeTruthy();
    userId = (
      await server.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })
    ).json<{ user: { id: string } }>().user.id;
  });
  afterAll(async () => {
    await server?.app.close();
    await server?.previewApp.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });
  const start = (provider: 'google' | 'microsoft', key: string, write = false) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/connectors/accounts/oauth/start',
      headers: { cookie, 'idempotency-key': key },
      payload: {
        provider,
        label: `${provider} owner`,
        clientId: 'owner-client',
        clientSecret: 'CLIENT_SECRET_CANARY',
        scopes: [
          'mail:mailbox.read',
          'calendar:calendars.read',
          ...(write ? ['calendar:events.write'] : [])
        ]
      }
    });

  it.each(['google', 'microsoft'] as const)(
    'binds %s to the owner and callback, consumes the state once, seals credentials and clears them on disconnect',
    async (provider) => {
      const response = await start(
        provider,
        `account-start-${provider}-0001`,
        provider === 'microsoft'
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain('CLIENT_SECRET_CANARY');
      const url = new URL(response.json<{ authorizationUrl: string }>().authorizationUrl);
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:5173/v1/connectors/accounts/oauth/callback'
      );
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      scopes = url.searchParams.get('scope')!;
      expect(scopes).not.toMatch(/Mail.Send|gmail.send/);
      if (provider === 'microsoft') expect(scopes).toContain('Calendars.ReadWrite');
      else expect(scopes).not.toMatch(/calendar.events|Calendars.ReadWrite/);
      const pending = await server.database.query(
        'SELECT state_hash,secret_ciphertext FROM connector_oauth_attempts'
      );
      expect(pending.rows).toHaveLength(1);
      expect(JSON.stringify(pending.rows)).not.toContain('CLIENT_SECRET_CANARY');
      const callback = `/v1/connectors/accounts/oauth/callback?code=one-use-code&state=${url.searchParams.get('state')!}`;
      const completed = await server.app.inject({ method: 'GET', url: callback });
      expect(completed.statusCode, completed.body).toBe(200);
      expect(completed.headers['cache-control']).toBe('no-store');
      expect(completed.body).toContain('athanor-account-oauth');
      expect(completed.body).toContain('owner@example.org');
      expect(completed.body).not.toContain('CANARY');
      expect((await server.app.inject({ method: 'GET', url: callback })).statusCode).toBe(400);
      const listed = await server.app.inject({
        method: 'GET',
        url: '/v1/connectors',
        headers: { cookie }
      });
      expect(listed.body).not.toMatch(/CANARY|secretCiphertext/);
      const connection = listed
        .json<Connector[]>()
        .find((value) => value.kind === provider && value.enabled)!;
      expect(connection).toBeTruthy();
      expect(connection.authMode).toBe('oauth');
      expect(connection.scopes.includes('calendar:events.write')).toBe(provider === 'microsoft');
      const stored = (await server.store.getConnector(userId, connection.id))!;
      const saved = decryptJson<{ accountOAuth: AccountOAuth }>(stored.secretCiphertext, masterKey);
      expect(saved.accountOAuth.account?.address).toBe('owner@example.org');
      saved.accountOAuth.tokens!.expiresAt = 1;
      await server.store.updateConnectorSecret(
        userId,
        connection.id,
        encryptJson(saved, masterKey, `connector:${userId}:${connection.id}`)
      );
      const before = refreshes;
      const checks = await Promise.all(
        [1, 2].map(() =>
          server.app.inject({
            method: 'POST',
            url: `/v1/connectors/${connection.id}/test`,
            headers: { cookie }
          })
        )
      );
      expect(checks).toHaveLength(2);
      for (const checked of checks) {
        expect(checked.statusCode, checked.body).toBe(200);
        expect(checked.json()).toMatchObject({ ok: true, accountLabel: 'owner@example.org' });
      }
      expect(refreshes - before).toBe(1);
      const rotated = (await server.store.getConnector(userId, connection.id))!;
      expect(
        decryptJson<{ accountOAuth: AccountOAuth }>(rotated.secretCiphertext, masterKey)
          .accountOAuth.tokens!.refreshToken
      ).toBe('ROTATED_CANARY');
      const disconnected = await server.app.inject({
        method: 'DELETE',
        url: `/v1/connectors/${connection.id}`,
        headers: { cookie, 'idempotency-key': `disconnect-${connection.id}` }
      });
      expect(disconnected.statusCode, disconnected.body).toBe(200);
      expect(await server.store.getConnector(userId, connection.id)).toBeNull();
      const tombstone = await server.database.query(
        'SELECT secret_ciphertext FROM connectors WHERE id=$1',
        [connection.id]
      );
      expect(tombstone.rows[0]!.secret_ciphertext).toMatchObject({ ciphertext: '', tag: '' });
    }
  );

  it('requires the owner and a recent confirmation before initiating new account access', async () => {
    expect(
      (await server.app.inject({ method: 'GET', url: '/v1/connectors/accounts/oauth/config' }))
        .statusCode
    ).toBe(401);
    await server.database.query("UPDATE sessions SET step_up_at=NOW()-INTERVAL '10 minutes'");
    const blocked = await start('google', 'account-expired-step-up-0001');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
    await server.database.query('UPDATE sessions SET step_up_at=NOW()');
  });
});

const isolatedConfig = (directory: string): ApiConfig => ({
  DEPLOYMENT_MODE: 'development',
  MODEL_CATALOG_SCOPE: 'provider_catalog',
  CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
  ATHANOR_STATE_PATH: directory,
  RELAY_STATE_DIR: join(directory, 'relay'),
  RELAY_LOCAL_HOST: '127.0.0.1',
  RELAY_LOCAL_PORT: 443,
  RELAY_LOCAL_HTTP_PORT: 80,
  RELAY_LOCAL_PREVIEW_PORT: 8443,
  PUBLIC_APP_URL: 'http://localhost:5173',
  PREVIEW_BASE_URL: 'http://preview.localhost:4400',
  API_HOST: '127.0.0.1',
  API_PORT: 4101,
  PREVIEW_GATEWAY_HOST: '127.0.0.1',
  PREVIEW_GATEWAY_PORT: 4401,
  RESERVED_PREVIEW_PORTS: '4201,4203',
  DATABASE_DRIVER: 'pglite',
  DATABASE_URL: 'postgres://athanor:unused@127.0.0.1:5432/athanor',
  PGLITE_PATH: join(directory, 'database'),
  DATA_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
  RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
  WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
  PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
  WORKSPACE_IMAGE_REVISION: 'dev',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'athanor Test',
  WEBAUTHN_ORIGIN: 'http://localhost:5173',
  ALLOW_INSECURE_DEV_AUTH: true,
  WORKER_ID: 'authorization-test-worker',
  // No agent runs behind these: they assert the API's own answers, not the agent's.
  EMBEDDED_WORKER: false,
  WORKER_CONCURRENCY: 2,
  WORKER_POLL_MS: 60_000,
  SCHEDULER_POLL_MS: 60_000,
  TASK_MAX_STEPS: 3,
  // Off: every expectation in this file describes a turn that stops at its step ceiling.
  TASK_MAX_SELF_CONTINUATIONS: 0,
  SECURITY_EVENT_RETENTION_DAYS: 30,
  LOG_LEVEL: 'silent',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_PROVIDER: 'openrouter',
  AI_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_REQUIRE_ZDR: true,
  AI_FORCE_INHOUSE_WEB: false,
  ALLOW_INSECURE_PROVIDER_URLS: false,
  CONNECTOR_ALLOWED_HOST_SUFFIXES: '',
  PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com',
  TELEGRAM_API_BASE_URL: 'https://bot-api.test'
});
