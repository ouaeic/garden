import { z } from 'zod';
import type { ConnectorScope } from '@garden/contracts';
import type { ConnectorTransport, ConnectorRequestResult } from './connectors.js';
import { AccountOAuth, type AccountProvider } from './account-oauth.js';
import { GardenError } from './errors.js';

export const accountResourceId = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !['.', '..'].includes(value) && !/[\r\n\0]/.test(value));
const endpoints = {
  gmail: {
    provider: 'google',
    origin: 'https://gmail.googleapis.com',
    prefix: '/gmail/v1/users/me/'
  },
  googleCalendar: {
    provider: 'google',
    origin: 'https://www.googleapis.com',
    prefix: '/calendar/v3/'
  },
  graph: { provider: 'microsoft', origin: 'https://graph.microsoft.com', prefix: '/v1.0/me/' }
} as const;
type Service = keyof typeof endpoints;
type PageCursor = {
  version: 1;
  provider: AccountProvider;
  account: string;
  collection: string;
  url: string;
};

export const accountResponseObject = (
  response: ConnectorRequestResult
): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(response.body.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Do not put upstream bodies or credentials into surfaced errors. */
  }
  throw new GardenError(
    'connector_response_invalid',
    'The account provider returned an unreadable response.'
  );
};

/** Fixed provider endpoints, bounded requests and cursors confined to their original collection. */
export class AccountApi {
  readonly secret: AccountOAuth;
  readonly metrics = { requestBytes: 0, responseBytes: 0, durationMs: 0, statusCode: 0 };
  constructor(
    secret: AccountOAuth,
    private readonly transport: ConnectorTransport,
    private readonly signal?: AbortSignal
  ) {
    this.secret = AccountOAuth.parse(secret);
    if (!this.secret.tokens || !this.secret.account || this.secret.pending)
      throw new GardenError(
        'connector_reauthorization_required',
        'Connect this account before using it.'
      );
    if (this.secret.tokens.expiresAt <= Date.now())
      throw new GardenError(
        'connector_authorization_expired',
        'Refresh the account authorization before using it.'
      );
  }

  url(service: Service, path: string, query: Record<string, string | undefined> = {}): URL {
    const endpoint = endpoints[service];
    if (
      endpoint.provider !== this.secret.provider ||
      !path ||
      path.startsWith('/') ||
      /[?#\\\0]/.test(path)
    )
      throw new GardenError(
        'connector_resource_invalid',
        'The resource does not belong to this account service.'
      );
    const url = new URL(endpoint.prefix + path, endpoint.origin);
    if (!url.pathname.startsWith(endpoint.prefix))
      throw new GardenError('connector_resource_invalid', 'The resource is outside this account.');
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, value);
    return url;
  }

  requireScope(scopes: readonly ConnectorScope[], required: ConnectorScope): void {
    if (!scopes.includes(required))
      throw new GardenError('connector_scope_denied', `Connector has not granted ${required}`);
  }

  private assertUrl(url: URL): void {
    if (
      url.username ||
      url.password ||
      url.hash ||
      !Object.values(endpoints).some(
        (endpoint) =>
          endpoint.provider === this.secret.provider &&
          url.origin === endpoint.origin &&
          url.pathname.startsWith(endpoint.prefix)
      )
    )
      throw new GardenError(
        'connector_resource_invalid',
        'The request is outside this account service.'
      );
  }

  async request(
    url: URL,
    options: {
      method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: unknown;
      maxBytes?: number;
      headers?: Record<string, string>;
    } = {}
  ): Promise<ConnectorRequestResult> {
    this.signal?.throwIfAborted();
    this.assertUrl(url);
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const maxBytes = options.maxBytes ?? 2_000_000;
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 40_000_000 ||
      (body?.length ?? 0) > 40_000_000
    )
      throw new GardenError(
        'connector_size_invalid',
        'The account request exceeds its transfer limit.'
      );
    const response = await this.transport({
      url,
      method: options.method ?? 'GET',
      headers: {
        ...options.headers,
        authorization: `Bearer ${this.secret.tokens!.accessToken}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(this.secret.provider === 'microsoft'
          ? { prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' }
          : {})
      },
      ...(body ? { body } : {}),
      allowedHostSuffixes: [url.hostname],
      timeoutMs: 20_000,
      ...(this.signal ? { signal: this.signal } : {}),
      maxRequestBytes: 40_000_000,
      maxResponseBytes: maxBytes
    });
    this.metrics.requestBytes += body?.length ?? 0;
    this.metrics.responseBytes += response.body.length;
    this.metrics.durationMs += response.durationMs;
    this.metrics.statusCode = response.status;
    if (response.body.length > maxBytes)
      throw new GardenError(
        'connector_response_too_large',
        'The account response exceeds its transfer limit.'
      );
    if (response.status < 200 || response.status >= 300) {
      const [code, message] =
        response.status === 401
          ? [
              'connector_reauthorization_required',
              'The account authorization is no longer valid. Reconnect the account.'
            ]
          : response.status === 403
            ? [
                'connector_scope_denied',
                'The account provider refused this capability. Check the granted access.'
              ]
            : response.status === 404
              ? [
                  'connector_resource_not_found',
                  'The account resource is unavailable or has moved.'
                ]
              : response.status === 429
                ? [
                    'connector_rate_limited',
                    'The account provider is rate limiting requests. Wait before trying again.'
                  ]
                : [
                    'connector_request_failed',
                    `The account provider returned HTTP ${response.status}.`
                  ];
      const retryAfter = response.headers['retry-after'];
      const seconds =
        retryAfter && /^\d+$/.test(retryAfter) ? Math.min(Number(retryAfter), 86400) : undefined;
      throw new GardenError(code, message, 400, {
        statusCode: response.status,
        ...(seconds === undefined ? {} : { retryAfterSeconds: seconds })
      });
    }
    return response;
  }

  async json(
    url: URL,
    options?: Parameters<AccountApi['request']>[1]
  ): Promise<Record<string, unknown>> {
    return accountResponseObject(await this.request(url, options));
  }

  /** Upload capabilities come only from Graph and never receive the account bearer token. */
  async uploadMailRange(value: string, bytes: Buffer, offset: number, total: number) {
    let url: URL;
    try {
      url = new URL(value);
      if (
        this.secret.provider !== 'microsoft' ||
        url.origin !== 'https://outlook.office.com' ||
        url.username ||
        url.password ||
        url.hash ||
        !/^\/api\/(?:v1\.0|v2\.0|gv1\.0)\/users\('[^/]+?'\)\/messages\('[^/]+?'\)\/attachmentsessions\('[^/]+?'\)$/i.test(
          url.pathname
        ) ||
        !url.searchParams.get('authtoken') ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(total) ||
        total < 1 ||
        total > 10_000_000 ||
        bytes.length < 1 ||
        bytes.length > 3 * 1024 * 1024 ||
        offset + bytes.length > total
      )
        throw new Error('invalid upload');
    } catch {
      throw new GardenError(
        'connector_upload_invalid',
        'The mail upload capability or byte range is invalid.'
      );
    }
    this.signal?.throwIfAborted();
    let response: ConnectorRequestResult;
    try {
      response = await this.transport({
        url,
        method: 'PUT',
        body: bytes,
        headers: {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${offset}-${offset + bytes.length - 1}/${total}`
        },
        allowedHostSuffixes: ['outlook.office.com'],
        maxRequestBytes: 3 * 1024 * 1024,
        maxResponseBytes: 100_000,
        timeoutMs: 60_000,
        ...(this.signal ? { signal: this.signal } : {})
      });
    } catch {
      throw new GardenError(
        'connector_upload_interrupted',
        'The mail attachment upload was interrupted.'
      );
    }
    this.metrics.requestBytes += bytes.length;
    this.metrics.responseBytes += response.body.length;
    this.metrics.durationMs += response.durationMs;
    this.metrics.statusCode = response.status;
    if (![200, 201].includes(response.status) || response.body.length > 100_000)
      throw new GardenError(
        'connector_upload_failed',
        'The mail attachment upload needs reconciliation.'
      );
    return response;
  }

  pageUrl(collection: URL, cursor?: string): URL {
    this.assertUrl(collection);
    if (!cursor) return collection;
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(z.string().max(16384).parse(cursor), 'base64url').toString('utf8')
      );
      const value = z
        .object({
          version: z.literal(1),
          provider: z.enum(['google', 'microsoft']),
          account: z.string(),
          collection: z.string(),
          url: z.string().max(8192)
        })
        .parse(parsed);
      if (
        value.provider !== this.secret.provider ||
        value.account !== this.secret.account!.id ||
        value.collection !== collection.toString()
      )
        throw new Error('wrong collection');
      const url = new URL(value.url);
      this.assertUrl(url);
      if (url.origin !== collection.origin || url.pathname !== collection.pathname)
        throw new Error('wrong collection');
      return url;
    } catch {
      throw new GardenError(
        'connector_cursor_invalid',
        'Use the next page cursor with the same account and search.'
      );
    }
  }

  nextCursor(collection: URL, nextUrl?: string): string | null {
    if (!nextUrl) return null;
    const value: PageCursor = {
      version: 1,
      provider: this.secret.provider,
      account: this.secret.account!.id,
      collection: collection.toString(),
      url: nextUrl
    };
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
    this.pageUrl(collection, encoded);
    return encoded;
  }
}
