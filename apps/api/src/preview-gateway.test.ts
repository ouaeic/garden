import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@garden/core';
import type { DataStore, WorkspacePreviewRecord, WorkspaceRecord } from '@garden/data';
import type { ApiConfig } from './config.js';
import { buildPreviewGateway } from './preview-gateway.js';
import { RunnerClient } from './runner-client.js';
import { issuePreviewAccess } from './preview-access.js';

const accessToken = 'preview-access-token';
const slug = 'a'.repeat(32);
const previewHost = `${slug}.preview.localhost:4400`;
const now = new Date().toISOString();

const preview: WorkspacePreviewRecord = {
  id: 'preview-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  label: 'Agent app',
  port: 3000,
  slug,
  accessTokenHash: sha256(accessToken),
  entryPath: null,
  visibility: 'private',
  status: 'active',
  expiresAt: null,
  lastAccessedAt: null,
  createdAt: now,
  updatedAt: now
};

const workspace: WorkspaceRecord = {
  id: 'workspace-1',
  userId: 'user-1',
  name: 'Agent computer',
  status: 'running',
  storageBytes: 0,
  storageLimitBytes: 1_000_000,
  imageRevision: 'dev',
  region: 'self-hosted',
  keyProtection: 'hosted',
  securityMode: 'balanced',
  runnerRef: null,
  computeMeteredAt: null,
  createdAt: now,
  updatedAt: now
};

let servedPreview: WorkspacePreviewRecord = preview;
let servedWorkspace: WorkspaceRecord = workspace;
let statusWrites: Array<[string, string]> = [];

const store = {
  getWorkspacePreviewBySlug: async (candidate: string) =>
    candidate === slug ? servedPreview : null,
  getWorkspacePreviewByCustomDomain: async () => null,
  getWorkspace: async () => servedWorkspace,
  updateWorkspaceStatus: async (id: string, status: string) => {
    statusWrites.push([id, status]);
    servedWorkspace = { ...servedWorkspace, status };
  },
  touchWorkspacePreview: async () => undefined
} as unknown as DataStore;

const config = {
  DATA_MASTER_KEY: Buffer.alloc(32, 8).toString('base64'),
  PREVIEW_BASE_URL: 'http://preview.localhost:4400',
  PUBLIC_APP_URL: 'http://localhost:5173',
  API_PORT: 4100,
  PREVIEW_GATEWAY_PORT: 4400,
  WORKSPACE_RUNNER_URL: 'http://127.0.0.1:4300',
  PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
  DATABASE_URL: 'postgres://garden:unused@127.0.0.1:5432/garden',
  RESERVED_PREVIEW_PORTS: '4201,4203'
} as unknown as ApiConfig;

const upstreamCookies = ['workspace_app_session=opaque; Path=/', '__Host-garden_session=forged'];

const buildGateway = async (
  gatewayConfig: ApiConfig = config
): Promise<{
  gateway: Awaited<ReturnType<typeof buildPreviewGateway>>;
  forwarded: () => Headers;
}> => {
  let forwarded = new Headers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      forwarded = new Headers(init?.headers);
      const headers = new Headers({
        'content-type': 'text/html; charset=utf-8',
        'service-worker-allowed': '/'
      });
      for (const value of upstreamCookies) headers.append('set-cookie', value);
      return new Response('<!doctype html><title>Agent app</title>', { status: 200, headers });
    })
  );
  const runner = new RunnerClient(
    'http://workspace-manager.test',
    'runner-secret-with-at-least-32-characters'
  );
  return {
    gateway: await buildPreviewGateway(store, gatewayConfig, runner),
    forwarded: () => forwarded
  };
};

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  servedPreview = preview;
  servedWorkspace = workspace;
  statusWrites = [];
  vi.unstubAllGlobals();
});

describe('the cookie that carries a private preview\u2019s access', () => {
  /*
   * A browser silently discards a `__Host-` cookie whose Path is not `/`. This one is scoped to a
   * single preview on purpose, so the prefix and the path could never both hold - and every
   * private preview garden published was therefore unopenable: the tokenised link answered with a
   * 303 and a Set-Cookie the browser threw away, the redirect arrived carrying nothing, and the
   * owner was told to open the preview from the workspace they had just opened it from. Nothing
   * caught it, because the tests here only ever checked which cookies are stripped on the way out.
   */
  it('is one a browser will actually keep', async () => {
    // The path layout, which is what the installer ships: the cookie is then scoped to one
    // preview's path, and that is exactly the case the prefix forbids. A subdomain layout puts it
    // at the root and hides the bug.
    const secureConfig = {
      ...config,
      PREVIEW_BASE_URL: 'https://app.example.test/__garden/preview'
    } as unknown as ApiConfig;
    const runner = new RunnerClient(
      'http://workspace-manager.test',
      'runner-secret-with-at-least-32-characters'
    );
    const gateway = await buildPreviewGateway(store, secureConfig, runner);
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: `/__garden/preview/${slug}/?access=${accessToken}`,
      headers: { host: 'app.example.test', 'x-forwarded-proto': 'https' }
    });

    expect(response.statusCode).toBe(303);
    const setCookie = [response.headers['set-cookie'] ?? []]
      .flat()
      .map((value) => String(value))
      .find((value) => value.toLowerCase().includes('preview-access'));
    expect(setCookie, 'the redirect has to hand the browser the token').toBeTruthy();
    const path = /;\s*path=([^;]+)/i.exec(setCookie ?? '')?.[1]?.trim();
    if (setCookie?.startsWith('__Host-')) expect(path).toBe('/');
    // Whatever prefix it carries, it must be confined to this preview or set at the root - never
    // scoped in a way the prefix forbids.
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(path === '/' || path?.includes(slug)).toBe(true);
  });
});

describe('preview origin isolation', () => {
  const isolated = {
    ...config,
    PUBLIC_APP_URL: 'https://app.example.test',
    PREVIEW_BASE_URL: 'https://app.example.test:8443/__garden/preview'
  };
  const path = `/__garden/preview/${slug}/`;

  it('serves a functional isolated origin and confines service workers to its preview', async () => {
    const { gateway } = await buildGateway(isolated);
    disposers.push(() => gateway.close());
    const response = await gateway.inject({
      method: 'GET',
      url: path,
      headers: {
        host: 'app.example.test:8443',
        'x-forwarded-proto': 'https',
        cookie: `__Secure-garden-preview-access=${accessToken}`
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toBe(
      'frame-ancestors https://app.example.test'
    );
    expect(response.headers['service-worker-allowed']).toBe(path);
  });

  it('adds the comment bridge to an app page only when garden frames it', async () => {
    const { gateway } = await buildGateway(isolated);
    disposers.push(() => gateway.close());
    const open = (dest: string) =>
      gateway.inject({
        method: 'GET',
        url: path,
        headers: {
          host: 'app.example.test:8443',
          'x-forwarded-proto': 'https',
          'sec-fetch-dest': dest,
          cookie: `__Secure-garden-preview-access=${accessToken}`
        }
      });
    const framed = await open('iframe');
    expect(framed.statusCode).toBe(200);
    expect(framed.body).toContain("window.__gardenFrame='app'");
    expect(framed.body).toContain('export function anchorAt');
    expect(framed.body.endsWith('<title>Agent app</title>')).toBe(true);
    expect(framed.headers.vary).toContain('sec-fetch-dest');
    const direct = await open('document');
    expect(direct.body).toBe('<!doctype html><title>Agent app</title>');
  });

  it.each([
    { host: 'app.example.test', 'x-forwarded-proto': 'https' },
    { host: 'app.example.test:8444', 'x-forwarded-proto': 'https' },
    { host: 'app.example.test:8443' },
    { host: 'other.example.test:8443', 'x-forwarded-proto': 'https' },
    { host: 'app.example.test:8443', 'x-forwarded-proto': 'https, http' }
  ])('refuses a request served on a different actual origin: %j', async (headers) => {
    const { gateway } = await buildGateway(isolated);
    disposers.push(() => gateway.close());
    const response = await gateway.inject({ method: 'GET', url: path, headers });
    expect(response.statusCode).toBe(421);
    expect(response.headers['content-security-policy']).toMatch(/^sandbox /);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the opaque sandbox if explicitly built on the owner origin', async () => {
    const { gateway } = await buildGateway({
      ...isolated,
      PREVIEW_BASE_URL: 'https://app.example.test/__garden/preview'
    });
    disposers.push(() => gateway.close());
    const response = await gateway.inject({
      method: 'GET',
      url: path,
      headers: {
        host: 'app.example.test',
        'x-forwarded-proto': 'https',
        cookie: `__Secure-garden-preview-access=${accessToken}`
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toBe(
      'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals; frame-ancestors https://app.example.test'
    );
  });
});

describe('preview gateway credential isolation', () => {
  it('never forwards garden session, preview access or authorization credentials', async () => {
    const { gateway, forwarded } = await buildGateway();
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: '/',
      headers: {
        host: previewHost,
        authorization: 'Bearer caller-supplied-token',
        cookie: [
          '__Host-garden_session=host-session-secret',
          'garden_session=plain-session-secret',
          `garden-preview-access=${accessToken}`,
          '__Host-garden-preview-access=production-access-secret',
          'workspace_app_session=opaque'
        ].join('; ')
      }
    });

    expect(response.statusCode).toBe(200);
    const cookie = forwarded().get('cookie');
    expect(cookie).toBe('workspace_app_session=opaque');
    expect(cookie).not.toContain('session-secret');
    expect(cookie).not.toContain(accessToken);
    expect(forwarded().get('authorization')).not.toBe('Bearer caller-supplied-token');
    expect(forwarded().get('authorization')).toMatch(/^Bearer /);
  });

  it('drops the cookie header entirely when only garden cookies are present', async () => {
    const { gateway, forwarded } = await buildGateway();
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: '/',
      headers: {
        host: previewHost,
        cookie: `garden-preview-access=${accessToken}; __Host-garden_session=host-session-secret`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(forwarded().has('cookie')).toBe(false);
  });

  it('refuses to relay a session cookie set by the workspace application', async () => {
    const { gateway } = await buildGateway();
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: '/',
      headers: { host: previewHost, cookie: `garden-preview-access=${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('workspace_app_session=opaque');
    expect(setCookie).not.toContain('__Host-garden_session');
  });

  /**
   * The agent writes preview rows through the store rather than through the API, so this is the
   * only place a published port is checked on every request rather than only when it was created.
   */
  it('refuses to proxy a preview pointed at one of this server own services', async () => {
    for (const port of [4100, 4201, 4300, 4400, 5432]) {
      servedPreview = { ...preview, port };
      const { gateway } = await buildGateway();
      const response = await gateway.inject({
        method: 'GET',
        url: '/',
        headers: { host: previewHost, cookie: `garden-preview-access=${accessToken}` }
      });
      await gateway.close();
      expect(response.statusCode, `port ${port}`).toBe(404);
      expect(response.body).toContain('Preview unavailable');
    }
  });
});

/**
 * A live link is a promise the owner made to whoever holds it, so a sleeping computer is woken
 * rather than reported. This used to depend on a stored hosting mode and read the wrong way round:
 * the mode sold as "always on" was the only one that answered 503 to a visitor whenever the owner
 * had put the box to sleep. There is one behaviour now, and this is it.
 */
describe('a preview opened while the computer is asleep', () => {
  it('wakes a hibernated computer and serves the page', async () => {
    servedWorkspace = { ...workspace, status: 'hibernated' };
    const { gateway } = await buildGateway();
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: '/',
      headers: { host: previewHost, cookie: `garden-preview-access=${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(statusWrites).toEqual([[workspace.id, 'running']]);
  });

  it('does not claim to wake a computer that is not merely hibernated', async () => {
    servedWorkspace = { ...workspace, status: 'provisioning' };
    const { gateway } = await buildGateway();
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: '/',
      headers: { host: previewHost, cookie: `garden-preview-access=${accessToken}` }
    });

    expect(response.statusCode).toBe(503);
    expect(statusWrites).toEqual([]);
  });
});

describe('independent owner preview access', () => {
  it('keeps two owner devices and the original published link open at the same time', async () => {
    const { gateway } = await buildGateway();
    disposers.push(() => gateway.close());
    const key = Buffer.from(config.DATA_MASTER_KEY!, 'base64');
    const tokens = [
      issuePreviewAccess(preview, key),
      issuePreviewAccess(preview, key),
      accessToken
    ];
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens) {
      const opened = await gateway.inject({
        method: 'GET',
        url: `/?access=${encodeURIComponent(token)}`,
        headers: { host: previewHost }
      });
      expect(opened.statusCode).toBe(303);
      const cookie = opened.cookies.find((entry) => entry.name === 'garden-preview-access');
      expect(cookie).toBeDefined();
      expect(
        (
          await gateway.inject({
            method: 'GET',
            url: '/',
            headers: { host: previewHost, cookie: `garden-preview-access=${cookie!.value}` }
          })
        ).statusCode
      ).toBe(200);
    }
  });
  it('invalidates owner grants when access is explicitly rotated or the preview is revoked', async () => {
    const { gateway } = await buildGateway();
    disposers.push(() => gateway.close());
    const token = issuePreviewAccess(preview, Buffer.from(config.DATA_MASTER_KEY!, 'base64'));
    servedPreview = { ...preview, accessTokenHash: sha256('new-secret') };
    expect(
      (
        await gateway.inject({
          method: 'GET',
          url: `/?access=${token}`,
          headers: { host: previewHost }
        })
      ).statusCode
    ).toBe(401);
    servedPreview = { ...preview, status: 'revoked' };
    expect(
      (
        await gateway.inject({
          method: 'GET',
          url: `/?access=${token}`,
          headers: { host: previewHost }
        })
      ).statusCode
    ).toBe(404);
  });
});
