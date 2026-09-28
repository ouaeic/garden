import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import { reservedPreviewPorts, sha256 } from '@garden/core';
import type { DataStore, WorkspacePreviewRecord } from '@garden/data';
import type { ApiConfig } from './config.js';
import type { RunnerClient } from './runner-client.js';
import { HOST_SESSION_COOKIE, SESSION_COOKIE } from './session.js';
import { previewAccessExpiry, verifyPreviewAccess } from './preview-access.js';
import {
  PREVIEW_OPAQUE_SANDBOX,
  previewRequestOrigin,
  previewOriginFor,
  previewScopeFor
} from './preview-origin.js';

/**
 * `__Secure-`, not `__Host-`, because this cookie is deliberately scoped to one preview's path.
 *
 * The `__Host-` prefix requires `Path=/` exactly, and the browser rejects any cookie carrying it
 * that says otherwise - silently, as a malformed cookie rather than as an error. This one is set
 * with `Path=/__garden/preview/<slug>/` on purpose, so no browser ever stored it: the gateway
 * answered the tokenised link with a 303 and a Set-Cookie, the redirect came back with nothing
 * attached, and the owner was told to "open this preview from your authenticated garden
 * workspace" - which is what they had just done. Every private preview garden has ever published
 * was unopenable, including the link at the end of "build me something and give me a link".
 *
 * `__Secure-` carries the half of the guarantee that applies here - it may only be set over HTTPS -
 * and leaves the path alone, which is what keeps one preview's token off another preview's
 * requests.
 */
const productionAccessCookie = '__Secure-garden-preview-access';
/** Its predecessor, still read so a preview opened before this fix keeps working. */
const legacyProductionAccessCookie = '__Host-garden-preview-access';
const developmentAccessCookie = 'garden-preview-access';
/**
 * Cookies are not port-scoped. A separate preview origin on this hostname still receives the
 * owner's cookies, so generated applications must not receive or replace control-plane credentials.
 */
const gardenCookieNames = new Set(
  [
    SESSION_COOKIE,
    HOST_SESSION_COOKIE,
    developmentAccessCookie,
    productionAccessCookie,
    legacyProductionAccessCookie
  ].map((name) => name.toLowerCase())
);
const blockedHeaders = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const safeEqual = (actual: string, expectedHash: string): boolean => {
  const actualHash = Buffer.from(sha256(actual));
  const expected = Buffer.from(expectedHash);
  return actualHash.byteLength === expected.byteLength && timingSafeEqual(actualHash, expected);
};

const cookieName = (pair: string): string => {
  const separator = pair.indexOf('=');
  return (separator === -1 ? pair : pair.slice(0, separator)).trim().toLowerCase();
};

const previewHeaders = (request: FastifyRequest): Record<string, string> => {
  const headers = Object.fromEntries(
    Object.entries(request.headers)
      .filter(([name, value]) => value !== undefined && !blockedHeaders.has(name.toLowerCase()))
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)])
  );
  if (headers.cookie) {
    const cookies = headers.cookie
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value && !gardenCookieNames.has(cookieName(value)));
    if (cookies.length) headers.cookie = cookies.join('; ');
    else delete headers.cookie;
  }
  return headers;
};

const requestBody = (request: FastifyRequest): BodyInit | undefined => {
  if (['GET', 'HEAD'].includes(request.method) || request.body === undefined) return undefined;
  if (Buffer.isBuffer(request.body)) return Uint8Array.from(request.body).buffer;
  return typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
};

const websocketProtocols = (request: FastifyRequest): string[] =>
  request.headers['sec-websocket-protocol']
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => value && value !== 'garden-capability') ?? [];

const cleanSetCookie = (value: string): string | null => {
  if (gardenCookieNames.has(cookieName(value.split(';', 1)[0] ?? ''))) return null;
  return value.replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax');
};

export const buildPreviewGateway = async (
  store: DataStore,
  config: ApiConfig,
  runner: RunnerClient
) => {
  const accessKey = Buffer.from(config.DATA_MASTER_KEY ?? '', 'base64');
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  const previewBase = new URL(config.PREVIEW_BASE_URL);
  const previewPath = previewBase.pathname.replace(/\/+$/, '');
  const escapedPreviewPath = previewPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const appOrigin = new URL(config.PUBLIC_APP_URL).origin;
  const secure = previewBase.protocol === 'https:';
  const accessCookie = secure ? productionAccessCookie : developmentAccessCookie;
  /**
   * Checked here as well as where a preview is created, because this is the only place every
   * preview request passes through: the agent writes preview rows through the store rather than
   * through the API, so a check that lives only on the creation route does not cover it.
   */
  const reservedPorts = reservedPreviewPorts({
    ports: [config.API_PORT, config.PREVIEW_GATEWAY_PORT],
    urls: [config.WORKSPACE_RUNNER_URL, config.PUBLIC_RUNNER_URL, config.DATABASE_URL],
    additional: config.RESERVED_PREVIEW_PORTS
  });

  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false, xFrameOptions: false });
  await app.register(websocket);
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  const slugFor = (request: FastifyRequest): string | null => {
    if (previewPath) {
      const pathname = new URL(request.raw.url ?? '/', 'http://preview.invalid').pathname;
      return (
        pathname.match(new RegExp(`^${escapedPreviewPath}/([0-9a-f]{32})(?:/|$)`))?.[1] ?? null
      );
    }
    const hostname = request.hostname.toLowerCase();
    const suffix = `.${previewBase.hostname.toLowerCase()}`;
    if (!hostname.endsWith(suffix)) return null;
    const slug = hostname.slice(0, -suffix.length);
    return /^[0-9a-f]{32}$/.test(slug) ? slug : null;
  };

  app.addHook('onRequest', async (request, reply) => {
    const actual = previewRequestOrigin(request);
    const expected = previewOriginFor(previewBase, slugFor(request));
    const isolated = actual === expected && actual !== appOrigin;
    reply.header(
      'content-security-policy',
      `${isolated ? '' : `${PREVIEW_OPAQUE_SANDBOX}; `}frame-ancestors ${appOrigin}`
    );
    if (actual !== expected)
      return reply.status(421).type('text/plain').send('Use the configured preview address.');
  });

  const previewFor = async (request: FastifyRequest): Promise<WorkspacePreviewRecord> => {
    // The slug in the path is the only way in. A preview could once also be reached by a custom
    // domain, but nothing ever routed a foreign host here - one nginx server block matches every
    // name and only the preview path regex proxies to this gateway - so the lookup answered
    // requests that could not arrive, while the owner was handed a link that did not work.
    const slug = slugFor(request);
    const preview = slug ? await store.getWorkspacePreviewBySlug(slug) : null;
    if (
      !preview ||
      preview.status !== 'active' ||
      reservedPorts.has(preview.port) ||
      (preview.expiresAt !== null && new Date(preview.expiresAt).getTime() <= Date.now())
    )
      throw new Error('preview_unavailable');
    const workspace = await store.getWorkspace(preview.userId, preview.workspaceId);
    if (!workspace) throw new Error('preview_unavailable');
    /*
     * A live preview is a promise the owner made to whoever holds the link, so a sleeping computer
     * is woken rather than reported. This used to depend on a stored hosting mode, and it read the
     * wrong way round: the mode advertised as "always on" was the only one that answered 503 to a
     * visitor whenever the owner had put the box to sleep. There is one behaviour now, and it is
     * the one the link implies.
     */
    if (workspace.status === 'hibernated') {
      await runner.request({
        workspaceId: workspace.id,
        userId: preview.userId,
        role: 'control',
        scopes: ['workspace.manage'],
        path: `/v1/workspaces/${workspace.id}/resume`,
        method: 'POST',
        body: '{}',
        contentType: 'application/json'
      });
      await store.updateWorkspaceStatus(workspace.id, 'running');
    } else if (workspace.status !== 'running') {
      throw new Error('preview_workspace_sleeping');
    }
    return preview;
  };

  const hasAccess = (request: FastifyRequest, preview: WorkspacePreviewRecord): boolean => {
    if (preview.visibility === 'public') return true;
    const queryToken = new URL(request.raw.url ?? '/', 'http://preview.invalid').searchParams.get(
      'access'
    );
    const token =
      queryToken ?? request.cookies[accessCookie] ?? request.cookies[legacyProductionAccessCookie];
    return Boolean(
      token &&
      (safeEqual(token, preview.accessTokenHash) || verifyPreviewAccess(token, preview, accessKey))
    );
  };

  const runnerPath = (request: FastifyRequest, preview: WorkspacePreviewRecord): string => {
    const incoming = new URL(request.raw.url ?? '/', 'http://preview.invalid');
    incoming.searchParams.delete('access');
    let pathname = incoming.pathname;
    if (previewPath) {
      const prefix = `${previewPath}/${preview.slug}`;
      pathname = pathname.startsWith(prefix) ? pathname.slice(prefix.length) || '/' : pathname;
      if (!pathname.startsWith('/')) pathname = `/${pathname}`;
    }
    return `/v1/workspaces/${preview.workspaceId}/preview/${preview.port}${pathname}${incoming.search}`;
  };

  /**
   * The browser's copy of the preview's idle deadline. Scoped to this preview's own path so two
   * previews on the same origin cannot read each other's token.
   */
  const accessCookieOptions = (preview: WorkspacePreviewRecord, token: string) => ({
    path: previewPath ? `${previewPath}/${preview.slug}/` : '/',
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    maxAge: Math.max(
      1,
      Math.floor(
        (Math.min(
          preview.expiresAt ? new Date(preview.expiresAt).getTime() : Date.now() + 86_400_000,
          previewAccessExpiry(token) ?? Infinity
        ) -
          Date.now()) /
          1000
      )
    )
  });

  const proxyHttp = async (request: FastifyRequest, reply: FastifyReply) => {
    let preview: WorkspacePreviewRecord;
    try {
      preview = await previewFor(request);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'preview_unavailable';
      return reply
        .status(['preview_workspace_sleeping', 'preview_compute_limit'].includes(code) ? 503 : 404)
        .type('text/html; charset=utf-8')
        .send(
          code === 'preview_compute_limit'
            ? '<!doctype html><title>Site paused</title><h1>Site paused</h1><p>The workspace owner needs to add active compute time before this on-demand site can wake.</p>'
            : '<!doctype html><title>Preview unavailable</title><h1>Preview unavailable</h1><p>This preview expired, was revoked, or the computer serving it is asleep.</p>'
        );
    }
    if (!hasAccess(request, preview))
      return reply
        .status(401)
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><title>Private preview</title><h1>Private preview</h1><p>Open this preview from your authenticated garden workspace.</p>'
        );
    const incoming = new URL(request.raw.url ?? '/', 'http://preview.invalid');
    const queryToken = incoming.searchParams.get('access');
    if (preview.visibility === 'private' && queryToken) {
      incoming.searchParams.delete('access');
      reply.setCookie(accessCookie, queryToken, accessCookieOptions(preview, queryToken));
      return reply.redirect(`${incoming.pathname}${incoming.search}`, 303);
    }
    // The row's idle deadline moves forward on every visit, and the cookie carrying the token has
    // to move with it. Without this the browser forgets a preview the owner uses daily on the
    // thirtieth day, and they are sent back to the chat message to find the link again.
    const cookieToken =
      request.cookies[accessCookie] ?? request.cookies[legacyProductionAccessCookie];
    if (preview.visibility === 'private' && cookieToken)
      reply.setCookie(accessCookie, cookieToken, accessCookieOptions(preview, cookieToken));
    const headers = previewHeaders(request);
    headers['x-forwarded-host'] = request.hostname;
    headers['x-forwarded-proto'] = previewBase.protocol.slice(0, -1);
    const body = requestBody(request);
    const response = await runner.raw({
      workspaceId: preview.workspaceId,
      userId: preview.userId,
      role: 'user',
      scopes: [`preview:${preview.port}`],
      path: runnerPath(request, preview),
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      acceptAnyStatus: true,
      redirect: 'manual'
    });
    reply.status(response.status);
    const ignored = new Set([
      'connection',
      'content-length',
      'content-security-policy',
      'set-cookie',
      'service-worker-allowed',
      'transfer-encoding',
      'x-frame-options'
    ]);
    for (const [name, value] of response.headers) {
      if (!ignored.has(name.toLowerCase())) reply.header(name, value);
    }
    const cookies = (response.headers.getSetCookie?.() ?? [])
      .map((value) => cleanSetCookie(value))
      .filter((value): value is string => Boolean(value));
    if (cookies.length) reply.header('set-cookie', cookies);
    const location = response.headers.get('location');
    if (location) {
      const currentOrigin = `${previewBase.protocol}//${request.hostname}${previewBase.port ? `:${previewBase.port}` : ''}`;
      const publicBase = previewPath
        ? `${currentOrigin}${previewPath}/${preview.slug}/`
        : `${currentOrigin}/`;
      const rewritten = new URL(location, publicBase);
      if (['127.0.0.1', 'localhost'].includes(rewritten.hostname)) {
        const publicOrigin = new URL(currentOrigin);
        rewritten.protocol = publicOrigin.protocol;
        rewritten.hostname = publicOrigin.hostname;
        rewritten.port = publicOrigin.port;
      }
      if (
        previewPath &&
        rewritten.origin === currentOrigin &&
        !rewritten.pathname.startsWith(`${previewPath}/${preview.slug}/`)
      )
        rewritten.pathname = `${previewPath}/${preview.slug}${rewritten.pathname}`;
      reply.header('location', rewritten.toString());
    }
    reply
      .header('service-worker-allowed', previewScopeFor(previewBase, preview.slug))
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin');
    if (preview.visibility === 'private') reply.header('cache-control', 'private, no-store');
    await store.touchWorkspacePreview(preview.id);
    if (request.method === 'HEAD' || !response.body) return reply.send();
    return reply.send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
  };

  /**
   * A socket is authorized once, at the handshake, and can then stay open for hours. Revoking a
   * preview, letting it expire or rotating its access token has to end the streams it authorized as
   * well as refuse the next request, or "revoke" means nothing to whoever is already connected.
   */
  const REAUTHORIZE_INTERVAL_MS = 60_000;
  const stillAuthorized = async (
    request: FastifyRequest,
    preview: WorkspacePreviewRecord
  ): Promise<boolean> => {
    const current = await store.getWorkspacePreviewBySlug(preview.slug);
    return Boolean(
      current &&
      current.id === preview.id &&
      current.status === 'active' &&
      !reservedPorts.has(current.port) &&
      (current.expiresAt === null || new Date(current.expiresAt).getTime() > Date.now()) &&
      hasAccess(request, current)
    );
  };

  const proxySocket = async (socket: WebSocket, request: FastifyRequest) => {
    let preview: WorkspacePreviewRecord;
    try {
      preview = await previewFor(request);
      if (!hasAccess(request, preview)) throw new Error('forbidden');
    } catch {
      socket.close(1008, 'Preview unavailable');
      return;
    }
    const upstreamPath = runnerPath(request, preview);
    const target = `${runner.baseUrl.replace(/^http/, 'ws')}${upstreamPath}`;
    const headers = previewHeaders(request);
    headers.authorization = `Bearer ${runner.token(
      preview.workspaceId,
      preview.userId,
      'user',
      [`preview:${preview.port}`],
      120,
      { method: 'GET', path: upstreamPath }
    )}`;
    const protocols = websocketProtocols(request);
    const upstream = protocols.length
      ? new WebSocket(target, protocols, { headers })
      : new WebSocket(target, { headers });
    const recheck = setInterval(() => {
      void stillAuthorized(request, preview)
        .then((allowed) => {
          if (!allowed) socket.close(1008, 'Preview authorization ended');
        })
        // A database that cannot answer is not evidence the preview is still allowed.
        .catch(() => socket.close(1011, 'Preview service unavailable'));
    }, REAUTHORIZE_INTERVAL_MS);
    recheck.unref();
    const stopRechecking = () => clearInterval(recheck);
    upstream.on('message', (data, binary) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
    });
    upstream.on('close', (code, reason) => {
      stopRechecking();
      socket.close(code, reason.toString());
    });
    upstream.on('error', () => {
      stopRechecking();
      socket.close(1011, 'Preview service unavailable');
    });
    socket.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    });
    socket.on('close', () => {
      stopRechecking();
      upstream.close();
    });
    await store.touchWorkspacePreview(preview.id);
  };

  app.route({ method: 'GET', url: '/*', handler: proxyHttp, wsHandler: proxySocket });
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/*',
    handler: proxyHttp
  });
  app.setErrorHandler(
    (_error, _request, reply) =>
      void reply.status(502).send({
        error: { code: 'preview_gateway_failed', message: 'The preview could not be reached' }
      })
  );
  return app;
};
