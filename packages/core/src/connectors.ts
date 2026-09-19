import {
  secureConnectorRequest,
  assertConnectorUrl,
  type ConnectorTransport,
  type ConnectorRequestResult
} from './connector-transport.js';
export {
  secureConnectorRequest,
  assertConnectorUrl,
  isPublicConnectorAddress,
  type ConnectorTransport,
  type ConnectorRequestInput,
  type ConnectorRequestResult
} from './connector-transport.js';
import {
  accountConnectorActions,
  accountConnectorInputs,
  accountConnectorCatalog,
  accountConnectorBase,
  isAccountConnectorKind,
  executeAccountConnector
} from './account-connectors.js';
import { AccountOAuth, verifyAccountOAuthIdentity } from './account-oauth.js';
import type { ConnectorKind, ConnectorScope } from '@athanor/contracts';
import {
  auth as authorizeMcp,
  type OAuthClientProvider,
  type OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { AthanorError } from './errors.js';
import {
  executeMailConnectorAction,
  mailConnectorActionInputs,
  mailConnectorActions,
  mailConnectorCatalog,
  mailConnectorKinds,
  verifyMailConnector,
  type MailConnectorKind,
  type MailConnectorScope
} from './mail-connectors.js';
import type {
  CalendarAccountSecret,
  MailAccountSecret,
  MailSocketFactory
} from './mail-protocol.js';

export interface ConnectorSecret {
  accountOAuth?: AccountOAuth;
  token?: string;
  username?: string;
  password?: string;
  mcpOAuth?: McpOAuthState;
  mail?: MailAccountSecret;
  calendar?: CalendarAccountSecret;
}

/**
 * The catalogue and the action table carry mail and calendar before the shared contract enum does,
 * so these unions are what the connector layer reasons about. Once ConnectorKind names them the
 * unions collapse to it on their own and nothing here has to change.
 */
export type AnyConnectorKind = ConnectorKind | MailConnectorKind;
export type AnyConnectorScope = ConnectorScope | MailConnectorScope;

export const isMailConnectorKind = (kind: AnyConnectorKind): kind is MailConnectorKind =>
  (mailConnectorKinds as readonly string[]).includes(kind);

export interface McpOAuthState {
  version: 1;
  redirectUrl: string;
  state?: string;
  scope?: string;
  clientMetadataUrl?: string;
  clientMetadata: OAuthClientMetadata;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface ConnectorDefinition {
  kind: AnyConnectorKind;
  name: string;
  description: string;
  dataAccess: string;
  tokenLocation: string;
  providerLogging: string;
  /** What the owner must already have for this connector to work at all, in plain words. */
  requirements?: string;
  scopes: Array<{ id: AnyConnectorScope; label: string; sideEffect: 'read' | 'write' | 'delete' }>;
}

export const connectorCatalog: ConnectorDefinition[] = [
  {
    kind: 'github',
    name: 'GitHub',
    description: 'Read repositories and, when explicitly granted, create issues or pull requests.',
    dataAccess: 'Only the selected account and repository capabilities are sent to GitHub.',
    tokenLocation:
      'Encrypted in the athanor control-plane secret store; never placed in a model prompt.',
    providerLogging:
      'GitHub may retain API metadata and content under the connected account policy.',
    scopes: [
      { id: 'github:profile.read', label: 'Read profile', sideEffect: 'read' },
      { id: 'github:repository.read', label: 'Read repositories and files', sideEffect: 'read' },
      { id: 'github:issues.read', label: 'Read issues', sideEffect: 'read' },
      { id: 'github:issues.write', label: 'Create issues', sideEffect: 'write' },
      { id: 'github:pull_requests.write', label: 'Create pull requests', sideEffect: 'write' }
    ]
  },
  {
    kind: 'webdav',
    name: 'WebDAV',
    description: 'Use a user-owned cloud file service through a deployment-approved HTTPS host.',
    dataAccess:
      'Only paths selected by the task are read or changed on the connected WebDAV service.',
    tokenLocation: 'Username and app password are encrypted in the control-plane secret store.',
    providerLogging: 'The WebDAV provider may retain request metadata and changed file content.',
    scopes: [
      { id: 'webdav:files.read', label: 'List and read files', sideEffect: 'read' },
      { id: 'webdav:files.write', label: 'Create or replace files', sideEffect: 'write' },
      { id: 'webdav:files.delete', label: 'Delete files', sideEffect: 'delete' }
    ]
  },
  {
    kind: 'mcp_http',
    name: 'MCP tool server',
    description:
      'Discover and run tools from a remote Model Context Protocol server over Streamable HTTP.',
    dataAccess:
      'The selected MCP server receives only tool arguments explicitly approved for a task.',
    tokenLocation:
      'OAuth refresh tokens or an optional bearer token are encrypted in athanor and never placed in a model prompt.',
    providerLogging:
      'The MCP server operator controls its own content and request retention policy.',
    scopes: [
      { id: 'mcp:tools.read', label: 'Discover tools', sideEffect: 'read' },
      {
        id: 'mcp:tools.execute',
        label: 'Run tools with confirmation',
        sideEffect: 'write'
      }
    ]
  },
  ...mailConnectorCatalog,
  ...accountConnectorCatalog
];

export const connectorActions = {
  github_list_repositories: {
    kinds: ['github'],
    scope: 'github:repository.read',
    sideEffect: 'read'
  },
  github_read_file: { kinds: ['github'], scope: 'github:repository.read', sideEffect: 'read' },
  github_list_issues: { kinds: ['github'], scope: 'github:issues.read', sideEffect: 'read' },
  github_create_issue: { kinds: ['github'], scope: 'github:issues.write', sideEffect: 'write' },
  github_create_pull_request: {
    kinds: ['github'],
    scope: 'github:pull_requests.write',
    sideEffect: 'write'
  },
  webdav_list: { kinds: ['webdav'], scope: 'webdav:files.read', sideEffect: 'read' },
  webdav_read: { kinds: ['webdav'], scope: 'webdav:files.read', sideEffect: 'read' },
  webdav_write: { kinds: ['webdav'], scope: 'webdav:files.write', sideEffect: 'write' },
  webdav_delete: { kinds: ['webdav'], scope: 'webdav:files.delete', sideEffect: 'delete' },
  mcp_list_tools: { kinds: ['mcp_http'], scope: 'mcp:tools.read', sideEffect: 'read' },
  mcp_call_tool: {
    kinds: ['mcp_http'],
    scope: 'mcp:tools.execute',
    sideEffect: 'delete'
  },
  ...mailConnectorActions,
  ...accountConnectorActions
} as const satisfies Record<
  string,
  {
    kinds: readonly AnyConnectorKind[];
    scope: AnyConnectorScope;
    sideEffect: 'read' | 'write' | 'delete';
  }
>;

export type ConnectorAction = keyof typeof connectorActions;
export const connectorActionSupportsKind = (
  action: ConnectorAction,
  kind: AnyConnectorKind
): boolean => (connectorActions[action].kinds as readonly AnyConnectorKind[]).includes(kind);

/**
 * What content read through each connector *is*, in one word, for the label that travels with it.
 *
 * Everything a connector returns was written by somebody who is not the owner: a mail body, a
 * calendar invitation, a GitHub issue, a file on a shared drive, an MCP server's response — and an
 * MCP tool *description* too, which is model-visible context, so a changed description is a changed
 * instruction. That makes this the same fact for every kind, and the only thing that varies is what
 * to call it when the owner is told where something came from.
 *
 * It lives beside the catalogue, and it is a total map rather than a lookup with a fallback, so a
 * connector cannot be added to `ConnectorKind` without this file failing to compile until somebody
 * has said what reading through it means. That is the property worth having: the previous version
 * of this rule lived as a chain of ternaries next to the code that used it, covered mail and
 * calendar, and returned the raw enum for everything else — which is how GitHub, WebDAV and MCP
 * results came back with no provenance at all for as long as they did.
 */
export const connectorContentOrigins = {
  github: 'github',
  webdav: 'webdav share',
  mcp_http: 'mcp server',
  imap: 'mailbox',
  caldav: 'calendar',
  google: 'google account',
  microsoft: 'microsoft account'
} as const satisfies Record<AnyConnectorKind, string>;

/**
 * The word for one kind, tolerating a kind this build has never heard of.
 *
 * A box can be newer than the code reading it, and an unnamed origin is still an origin: naming it
 * by its own enum is worse writing than the table above and better than dropping the label, which
 * is the one outcome that changes what the agent is allowed to do next.
 */
export const connectorContentOrigin = (kind: string): string =>
  (connectorContentOrigins as Record<string, string | undefined>)[kind] ?? String(kind);

const repositoryName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);
const connectorPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'));
const connectorActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('github_list_repositories'),
    limit: z.number().int().min(1).max(100).default(30)
  }),
  z.object({
    action: z.literal('github_read_file'),
    owner: repositoryName,
    repository: repositoryName,
    path: connectorPath,
    ref: z.string().min(1).max(256).optional()
  }),
  z.object({
    action: z.literal('github_list_issues'),
    owner: repositoryName,
    repository: repositoryName,
    state: z.enum(['open', 'closed', 'all']).default('open'),
    limit: z.number().int().min(1).max(100).default(30)
  }),
  z.object({
    action: z.literal('github_create_issue'),
    owner: repositoryName,
    repository: repositoryName,
    title: z.string().min(1).max(256),
    body: z.string().max(65_536).default('')
  }),
  z.object({
    action: z.literal('github_create_pull_request'),
    owner: repositoryName,
    repository: repositoryName,
    title: z.string().min(1).max(256),
    body: z.string().max(65_536).default(''),
    head: z.string().min(1).max(256),
    base: z.string().min(1).max(256),
    draft: z.boolean().default(false)
  }),
  z.object({ action: z.literal('webdav_list'), path: connectorPath.default('/') }),
  z.object({ action: z.literal('webdav_read'), path: connectorPath }),
  z.object({
    action: z.literal('webdav_write'),
    path: connectorPath,
    content: z.string().max(1_000_000),
    contentType: z.string().min(1).max(256).default('text/plain; charset=utf-8')
  }),
  z.object({ action: z.literal('webdav_delete'), path: connectorPath }),
  z.object({ action: z.literal('mcp_list_tools') }),
  z.object({
    action: z.literal('mcp_call_tool'),
    tool: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.unknown()).default({})
  }),
  ...mailConnectorActionInputs,
  ...accountConnectorInputs
]);

const apiPath = (parts: string[]): string =>
  parts.map((part) => encodeURIComponent(part)).join('/');

const webdavUrl = (baseUrl: string, path: string): URL => {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, '');
  const requested = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  base.pathname = `${basePath}/${requested}`.replace(/\/{2,}/g, '/');
  base.search = '';
  return base;
};

const jsonBody = <T>(response: ConnectorRequestResult): T => {
  try {
    return JSON.parse(response.body.toString('utf8')) as T;
  } catch {
    throw new AthanorError('connector_invalid_response', 'Connector returned invalid JSON');
  }
};

const requireSuccess = (response: ConnectorRequestResult, allowed: number[] = []): void => {
  if ((response.status < 200 || response.status >= 300) && !allowed.includes(response.status))
    throw new AthanorError(
      'connector_request_failed',
      `Connector request failed with status ${response.status}`
    );
};

interface McpMetrics {
  statusCode: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
}

const requestHeaders = (headers: HeadersInit | undefined): Record<string, string> => {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
};

const requestBody = async (body: BodyInit | null | undefined): Promise<Uint8Array | undefined> => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new AthanorError('connector_request_invalid', 'Unsupported MCP request body');
};

const oauthUrl = (value: string, code: string, label: string): URL => {
  try {
    return new URL(value);
  } catch {
    throw new AthanorError(code, `${label} is not a valid URL`);
  }
};

class StoredMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  readonly clientMetadataUrl?: string;

  constructor(private readonly data: McpOAuthState) {
    if (data.clientMetadataUrl) this.clientMetadataUrl = data.clientMetadataUrl;
  }

  get redirectUrl(): string {
    return this.data.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.data.clientMetadata;
  }

  state(): string {
    if (!this.data.state)
      throw new AthanorError(
        'connector_oauth_state_invalid',
        'The MCP authorization state is missing'
      );
    return this.data.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.data.clientInformation = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.data.tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.data.codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier)
      throw new AthanorError(
        'connector_oauth_state_invalid',
        'The MCP authorization verifier is missing'
      );
    return this.data.codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.data.discoveryState = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.data.discoveryState;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') delete this.data.clientInformation;
    if (scope === 'all' || scope === 'tokens') delete this.data.tokens;
    if (scope === 'all' || scope === 'verifier') delete this.data.codeVerifier;
    if (scope === 'all' || scope === 'discovery') delete this.data.discoveryState;
  }
}

const connectorFetch =
  (
    baseUrl: URL,
    allowedHostSuffixes: string[],
    metrics: McpMetrics,
    connectorTransport: ConnectorTransport,
    oauth: boolean
  ): FetchLike =>
  async (target, init) => {
    const url = new URL(target);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (
      method === 'GET' &&
      url.origin === baseUrl.origin &&
      url.pathname.replace(/\/+$/, '') === baseUrl.pathname.replace(/\/+$/, '')
    ) {
      // Server-to-client SSE is optional. athanor uses bounded request/response calls and does not
      // keep an unbounded connector stream open between tasks.
      return new Response(null, { status: 405, statusText: 'SSE stream disabled' });
    }
    const body = await requestBody(init?.body);
    const hosts = [
      ...new Set([...allowedHostSuffixes, baseUrl.hostname, ...(oauth ? [url.hostname] : [])])
    ];
    const response = await connectorTransport({
      url,
      method,
      headers: requestHeaders(init?.headers),
      ...(body ? { body } : {}),
      allowedHostSuffixes: hosts,
      timeoutMs: 120_000,
      maxResponseBytes: 1_000_000
    });
    metrics.statusCode = response.status;
    metrics.requestBytes += body?.byteLength ?? 0;
    metrics.responseBytes += response.body.byteLength;
    metrics.durationMs += response.durationMs;
    return new Response(new Uint8Array(response.body), {
      status: response.status,
      headers: response.headers
    });
  };

export const beginMcpOAuth = async (input: {
  baseUrl: string;
  redirectUrl: string;
  state: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  clientMetadataUrl?: string;
  allowedHostSuffixes?: string[];
  transport?: ConnectorTransport;
}): Promise<{ authorizationUrl: string; secret: ConnectorSecret }> => {
  const baseUrl = oauthUrl(
    input.baseUrl,
    'connector_oauth_server_invalid',
    'The MCP server address'
  );
  const redirectUrl = oauthUrl(
    input.redirectUrl,
    'connector_oauth_redirect_invalid',
    'The MCP callback address'
  );
  if (input.state.length < 32 || input.state.length > 512)
    throw new AthanorError(
      'connector_oauth_state_invalid',
      'MCP OAuth state must contain 32 to 512 characters'
    );
  assertConnectorUrl(baseUrl, [baseUrl.hostname, ...(input.allowedHostSuffixes ?? [])]);
  const loopbackRedirect =
    redirectUrl.protocol === 'http:' &&
    (redirectUrl.hostname === 'localhost' ||
      redirectUrl.hostname === '127.0.0.1' ||
      redirectUrl.hostname === '[::1]');
  if (
    (redirectUrl.protocol !== 'https:' && !loopbackRedirect) ||
    redirectUrl.username ||
    redirectUrl.password ||
    redirectUrl.hash
  )
    throw new AthanorError(
      'connector_oauth_redirect_invalid',
      'MCP OAuth requires a credential-free HTTPS callback URL'
    );
  if (input.clientMetadataUrl) {
    const metadataUrl = oauthUrl(
      input.clientMetadataUrl,
      'connector_oauth_client_metadata_invalid',
      'The MCP client metadata address'
    );
    if (
      metadataUrl.protocol !== 'https:' ||
      metadataUrl.username ||
      metadataUrl.password ||
      metadataUrl.hash ||
      metadataUrl.pathname === '/'
    )
      throw new AthanorError(
        'connector_oauth_client_metadata_invalid',
        'MCP client metadata must use a credential-free HTTPS URL with a path'
      );
  }
  const oauth: McpOAuthState = {
    version: 1,
    redirectUrl: redirectUrl.toString(),
    state: input.state,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(!input.clientId && input.clientMetadataUrl
      ? { clientMetadataUrl: input.clientMetadataUrl }
      : {}),
    clientMetadata: {
      redirect_uris: [redirectUrl.toString()],
      token_endpoint_auth_method: input.clientSecret ? 'client_secret_basic' : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'athanor',
      software_id: 'org.athanor.ai',
      software_version: '0.1.0',
      ...(input.scope ? { scope: input.scope } : {})
    },
    ...(input.clientId
      ? {
          clientInformation: {
            client_id: input.clientId,
            ...(input.clientSecret ? { client_secret: input.clientSecret } : {})
          }
        }
      : {})
  };
  const provider = new StoredMcpOAuthProvider(oauth);
  const metrics: McpMetrics = {
    statusCode: 0,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 0
  };
  const result = await authorizeMcp(provider, {
    serverUrl: baseUrl,
    ...(input.scope ? { scope: input.scope } : {}),
    fetchFn: connectorFetch(
      baseUrl,
      input.allowedHostSuffixes ?? [],
      metrics,
      input.transport ?? secureConnectorRequest,
      true
    )
  });
  if (result !== 'REDIRECT' || !provider.authorizationUrl)
    throw new AthanorError(
      'connector_oauth_flow_invalid',
      'The MCP server did not begin an interactive authorization flow'
    );
  if (!oauth.discoveryState?.resourceMetadata)
    throw new AthanorError(
      'connector_oauth_resource_metadata_missing',
      'The MCP server does not publish required protected-resource metadata'
    );
  const pkceMethods =
    oauth.discoveryState.authorizationServerMetadata?.code_challenge_methods_supported;
  if (!pkceMethods?.includes('S256'))
    throw new AthanorError(
      'connector_oauth_pkce_unsupported',
      'The MCP authorization server does not advertise required S256 PKCE support'
    );
  const authorizationUrl = provider.authorizationUrl;
  if (
    authorizationUrl.protocol !== 'https:' ||
    authorizationUrl.username ||
    authorizationUrl.password ||
    authorizationUrl.hash
  )
    throw new AthanorError(
      'connector_oauth_authorization_invalid',
      'The MCP server returned an unsafe authorization address'
    );
  return {
    authorizationUrl: authorizationUrl.toString(),
    secret: { mcpOAuth: oauth }
  };
};

export const completeMcpOAuth = async (input: {
  baseUrl: string;
  secret: ConnectorSecret;
  authorizationCode: string;
  allowedHostSuffixes?: string[];
  transport?: ConnectorTransport;
}): Promise<ConnectorSecret> => {
  if (!input.secret.mcpOAuth)
    throw new AthanorError(
      'connector_oauth_state_invalid',
      'The MCP authorization state is missing'
    );
  const baseUrl = oauthUrl(
    input.baseUrl,
    'connector_oauth_server_invalid',
    'The MCP server address'
  );
  const provider = new StoredMcpOAuthProvider(input.secret.mcpOAuth);
  const metrics: McpMetrics = {
    statusCode: 0,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 0
  };
  const result = await authorizeMcp(provider, {
    serverUrl: baseUrl,
    authorizationCode: input.authorizationCode,
    ...(input.secret.mcpOAuth.scope ? { scope: input.secret.mcpOAuth.scope } : {}),
    fetchFn: connectorFetch(
      baseUrl,
      input.allowedHostSuffixes ?? [],
      metrics,
      input.transport ?? secureConnectorRequest,
      true
    )
  });
  if (result !== 'AUTHORIZED' || !input.secret.mcpOAuth.tokens?.access_token)
    throw new AthanorError(
      'connector_oauth_exchange_failed',
      'The MCP authorization code did not produce an access token'
    );
  delete input.secret.mcpOAuth.codeVerifier;
  delete input.secret.mcpOAuth.state;
  return input.secret;
};

const withMcpClient = async <T>(
  baseUrl: string,
  secret: ConnectorSecret,
  allowedHostSuffixes: string[],
  connectorTransport: ConnectorTransport,
  operation: (client: Client) => Promise<T>,
  onSecretUpdated?: (secret: ConnectorSecret) => Promise<void>
): Promise<{ value: T; serverName: string; metrics: McpMetrics }> => {
  const url = new URL(baseUrl);
  const effectiveAllowedHosts = [...new Set([...allowedHostSuffixes, url.hostname])];
  assertConnectorUrl(url, effectiveAllowedHosts);
  const metrics: McpMetrics = {
    statusCode: 0,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 0
  };
  const client = new Client({ name: 'athanor', version: '0.1.0' });
  const oauthProvider = secret.mcpOAuth ? new StoredMcpOAuthProvider(secret.mcpOAuth) : undefined;
  const secretBefore = JSON.stringify(secret);
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: connectorFetch(
      url,
      effectiveAllowedHosts,
      metrics,
      connectorTransport,
      Boolean(oauthProvider)
    ),
    requestInit: {
      headers: secret.token ? { authorization: `Bearer ${secret.token}` } : {}
    },
    ...(oauthProvider ? { authProvider: oauthProvider } : {}),
    reconnectionOptions: {
      maxReconnectionDelay: 1_000,
      initialReconnectionDelay: 250,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0
    }
  });
  try {
    // The SDK's optional sessionId field conflicts with exactOptionalPropertyTypes even though
    // StreamableHTTPClientTransport is its own Transport implementation.
    await client.connect(transport as Parameters<Client['connect']>[0], { timeout: 30_000 });
    const value = await operation(client);
    return {
      value,
      serverName: client.getServerVersion()?.name ?? url.hostname,
      metrics
    };
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
    if (onSecretUpdated && JSON.stringify(secret) !== secretBefore) {
      await onSecretUpdated(secret);
    }
  }
};

const githubHeaders = (secret: ConnectorSecret): Record<string, string> => {
  if (!secret.token) throw new AthanorError('connector_secret_invalid', 'GitHub token is missing');
  return {
    authorization: `Bearer ${secret.token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'athanor-AI-Workspace',
    'x-github-api-version': '2022-11-28'
  };
};

const webdavHeaders = (secret: ConnectorSecret): Record<string, string> => {
  if (!secret.username || !secret.password)
    throw new AthanorError('connector_secret_invalid', 'WebDAV credentials are missing');
  return {
    authorization: `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString('base64')}`
  };
};

export interface ConnectorExecutionInput {
  kind: AnyConnectorKind;
  baseUrl: string;
  scopes: AnyConnectorScope[];
  secret: ConnectorSecret;
  action: unknown;
  allowedHostSuffixes: string[];
  transport?: ConnectorTransport;
  /** Test seam for the mail connectors, which speak TLS sockets rather than HTTPS requests. */
  mailSocketFactory?: MailSocketFactory;
  onSecretUpdated?: (secret: ConnectorSecret) => Promise<void>;
}

export interface ConnectorExecutionResult {
  action: ConnectorAction;
  result: unknown;
  statusCode: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
}

export const verifyConnector = async (
  input: Omit<ConnectorExecutionInput, 'action' | 'scopes'>
): Promise<{ accountLabel: string; statusCode: number }> => {
  const transport = input.transport ?? secureConnectorRequest;
  if (isAccountConnectorKind(input.kind)) {
    const secret = AccountOAuth.parse(input.secret.accountOAuth);
    if (secret.provider !== input.kind || input.baseUrl !== accountConnectorBase(secret.provider))
      throw new AthanorError('connector_secret_context', 'The account provider does not match.');
    const verified = await verifyAccountOAuthIdentity(secret, transport);
    return { accountLabel: verified.account!.address, statusCode: 200 };
  }
  if (isMailConnectorKind(input.kind))
    return verifyMailConnector({
      kind: input.kind,
      baseUrl: input.baseUrl,
      secret: input.secret,
      allowedHostSuffixes: input.allowedHostSuffixes,
      transport,
      ...(input.mailSocketFactory ? { socketFactory: input.mailSocketFactory } : {})
    });
  if (input.kind === 'github') {
    const response = await transport({
      url: new URL('/user', 'https://api.github.com'),
      method: 'GET',
      headers: githubHeaders(input.secret),
      allowedHostSuffixes: ['api.github.com'],
      maxResponseBytes: 256_000
    });
    requireSuccess(response);
    const account = jsonBody<{ login?: unknown }>(response);
    if (typeof account.login !== 'string')
      throw new AthanorError('connector_invalid_response', 'GitHub account identity is missing');
    return { accountLabel: account.login, statusCode: response.status };
  }
  if (input.kind === 'mcp_http') {
    const connected = await withMcpClient(
      input.baseUrl,
      input.secret,
      input.allowedHostSuffixes,
      input.transport ?? secureConnectorRequest,
      (client) => client.listTools({}, { timeout: 30_000 }),
      input.onSecretUpdated
    );
    return {
      accountLabel: connected.serverName,
      statusCode: connected.metrics.statusCode || 200
    };
  }
  const response = await transport({
    url: webdavUrl(input.baseUrl, '/'),
    method: 'PROPFIND',
    headers: { ...webdavHeaders(input.secret), depth: '0' },
    body: Buffer.from(
      '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><displayname/></prop></propfind>'
    ),
    allowedHostSuffixes: input.allowedHostSuffixes,
    maxResponseBytes: 256_000
  });
  requireSuccess(response, [207]);
  return { accountLabel: new URL(input.baseUrl).hostname, statusCode: response.status };
};

export const executeConnectorAction = async (
  input: ConnectorExecutionInput
): Promise<ConnectorExecutionResult> => {
  const parsed = connectorActionInput.parse(input.action);
  const definition = connectorActions[parsed.action];
  if (!connectorActionSupportsKind(parsed.action, input.kind))
    throw new AthanorError('connector_action_invalid', 'Action does not match this connector');
  if (!input.scopes.includes(definition.scope))
    throw new AthanorError(
      'connector_scope_denied',
      `Connector has not granted ${definition.scope}`
    );
  if (isAccountConnectorKind(input.kind))
    return executeAccountConnector(input, input.transport ?? secureConnectorRequest);
  if (isMailConnectorKind(input.kind)) {
    const executed = await executeMailConnectorAction({
      kind: input.kind,
      baseUrl: input.baseUrl,
      secret: input.secret,
      action: parsed as Parameters<typeof executeMailConnectorAction>[0]['action'],
      allowedHostSuffixes: input.allowedHostSuffixes,
      transport: input.transport ?? secureConnectorRequest,
      ...(input.mailSocketFactory ? { socketFactory: input.mailSocketFactory } : {})
    });
    return { action: parsed.action, ...executed };
  }
  if (input.kind === 'mcp_http') {
    const executed =
      parsed.action === 'mcp_list_tools'
        ? await withMcpClient(
            input.baseUrl,
            input.secret,
            input.allowedHostSuffixes,
            input.transport ?? secureConnectorRequest,
            (client) =>
              client.listTools({}, { timeout: 30_000 }).then((response) => ({
                tools: response.tools.map((tool) => ({
                  name: tool.name,
                  title: tool.title,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  annotations: tool.annotations
                }))
              })),
            input.onSecretUpdated
          )
        : parsed.action === 'mcp_call_tool'
          ? await withMcpClient(
              input.baseUrl,
              input.secret,
              input.allowedHostSuffixes,
              input.transport ?? secureConnectorRequest,
              (client) =>
                client.callTool(
                  {
                    name: parsed.tool,
                    arguments: parsed.arguments
                  },
                  undefined,
                  { timeout: 120_000, maxTotalTimeout: 120_000 }
                ),
              input.onSecretUpdated
            )
          : null;
    if (!executed)
      throw new AthanorError('connector_action_invalid', 'Action does not match this connector');
    return {
      action: parsed.action,
      result: executed.value,
      statusCode: executed.metrics.statusCode || 200,
      requestBytes: executed.metrics.requestBytes,
      responseBytes: executed.metrics.responseBytes,
      durationMs: executed.metrics.durationMs
    };
  }
  const transport = input.transport ?? secureConnectorRequest;
  let url: URL;
  let method = 'GET';
  let headers: Record<string, string>;
  let body: Buffer | undefined;

  if (input.kind === 'github') {
    headers = githubHeaders(input.secret);
    const github = new URL('https://api.github.com');
    switch (parsed.action) {
      case 'github_list_repositories':
        github.pathname = '/user/repos';
        github.searchParams.set('per_page', String(parsed.limit));
        github.searchParams.set('sort', 'updated');
        break;
      case 'github_read_file':
        github.pathname = `/repos/${apiPath([parsed.owner, parsed.repository])}/contents/${parsed.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
        if (parsed.ref) github.searchParams.set('ref', parsed.ref);
        break;
      case 'github_list_issues':
        github.pathname = `/repos/${apiPath([parsed.owner, parsed.repository])}/issues`;
        github.searchParams.set('state', parsed.state);
        github.searchParams.set('per_page', String(parsed.limit));
        break;
      case 'github_create_issue':
        github.pathname = `/repos/${apiPath([parsed.owner, parsed.repository])}/issues`;
        method = 'POST';
        body = Buffer.from(JSON.stringify({ title: parsed.title, body: parsed.body }));
        headers['content-type'] = 'application/json';
        break;
      case 'github_create_pull_request':
        github.pathname = `/repos/${apiPath([parsed.owner, parsed.repository])}/pulls`;
        method = 'POST';
        body = Buffer.from(
          JSON.stringify({
            title: parsed.title,
            body: parsed.body,
            head: parsed.head,
            base: parsed.base,
            draft: parsed.draft
          })
        );
        headers['content-type'] = 'application/json';
        break;
      default:
        throw new AthanorError('connector_action_invalid', 'Unsupported GitHub action');
    }
    url = github;
  } else {
    headers = webdavHeaders(input.secret);
    switch (parsed.action) {
      case 'webdav_list':
        url = webdavUrl(input.baseUrl, parsed.path);
        method = 'PROPFIND';
        headers.depth = '1';
        body = Buffer.from(
          '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><displayname/><getcontentlength/><getcontenttype/><getetag/></prop></propfind>'
        );
        headers['content-type'] = 'application/xml; charset=utf-8';
        break;
      case 'webdav_read':
        url = webdavUrl(input.baseUrl, parsed.path);
        break;
      case 'webdav_write':
        url = webdavUrl(input.baseUrl, parsed.path);
        method = 'PUT';
        body = Buffer.from(parsed.content, 'utf8');
        headers['content-type'] = parsed.contentType;
        break;
      case 'webdav_delete':
        url = webdavUrl(input.baseUrl, parsed.path);
        method = 'DELETE';
        break;
      default:
        throw new AthanorError('connector_action_invalid', 'Unsupported WebDAV action');
    }
  }

  const response = await transport({
    url,
    method,
    headers,
    ...(body ? { body } : {}),
    allowedHostSuffixes: input.kind === 'github' ? ['api.github.com'] : input.allowedHostSuffixes
  });
  requireSuccess(response, parsed.action === 'webdav_list' ? [207] : []);
  let result: unknown = { ok: true };
  if (parsed.action === 'github_list_repositories') {
    result = jsonBody<Array<Record<string, unknown>>>(response).map((repository) => ({
      name: repository.name,
      fullName: repository.full_name,
      private: repository.private,
      url: repository.html_url,
      defaultBranch: repository.default_branch
    }));
  } else if (parsed.action === 'github_read_file') {
    const file = jsonBody<{ content?: unknown; encoding?: unknown; sha?: unknown; size?: unknown }>(
      response
    );
    if (file.encoding !== 'base64' || typeof file.content !== 'string')
      throw new AthanorError(
        'connector_invalid_response',
        'GitHub file response is not base64 content'
      );
    const content = Buffer.from(file.content.replaceAll('\n', ''), 'base64');
    if (content.byteLength > 512_000)
      throw new AthanorError('connector_response_too_large', 'GitHub file exceeds 512 KB');
    result = { content: content.toString('utf8'), sha: file.sha, size: file.size };
  } else if (parsed.action === 'github_list_issues') {
    result = jsonBody<Array<Record<string, unknown>>>(response).map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
      pullRequest: Boolean(issue.pull_request)
    }));
  } else if (
    parsed.action === 'github_create_issue' ||
    parsed.action === 'github_create_pull_request'
  ) {
    const created = jsonBody<Record<string, unknown>>(response);
    result = {
      number: created.number,
      title: created.title,
      state: created.state,
      url: created.html_url
    };
  } else if (parsed.action === 'webdav_list') {
    const xml = response.body.toString('utf8');
    result = {
      paths: [...xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]+)<\//gi)]
        .slice(0, 500)
        .map((match) => {
          try {
            return decodeURIComponent(match[1] ?? '');
          } catch {
            return match[1] ?? '';
          }
        })
    };
  } else if (parsed.action === 'webdav_read') {
    result = {
      content: response.body.toString('utf8'),
      contentType: response.headers['content-type'] ?? 'application/octet-stream',
      etag: response.headers.etag ?? null
    };
  }
  return {
    action: parsed.action,
    result,
    statusCode: response.status,
    requestBytes: body?.byteLength ?? 0,
    responseBytes: response.body.byteLength,
    durationMs: response.durationMs
  };
};
