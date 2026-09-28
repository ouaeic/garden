import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ConnectorScope } from '@garden/contracts';
import type { ConnectorTransport } from './connectors.js';
import { GardenError } from './errors.js';

export const AccountProvider = z.enum(['google', 'microsoft']);
export type AccountProvider = z.infer<typeof AccountProvider>;

const token = z
  .string()
  .min(1)
  .max(16384)
  .refine((value) => !/[\r\n\0]/.test(value));
export const AccountOAuth = z.object({
  version: z.literal(1),
  provider: AccountProvider,
  clientId: z.string().min(1).max(1024),
  clientSecret: z.string().min(1).max(8192),
  redirectUrl: z.string().url().max(2048),
  requestedScopes: z.array(z.string().max(512)).min(1).max(16),
  pending: z
    .object({ state: z.string().min(32).max(128), verifier: z.string().min(43).max(128) })
    .optional(),
  tokens: z
    .object({
      accessToken: token,
      refreshToken: token,
      expiresAt: z.number().int().positive(),
      scopes: z.array(z.string().max(512)).max(32)
    })
    .optional(),
  account: z
    .object({ id: z.string().min(1).max(512), address: z.string().min(1).max(320) })
    .optional()
});
export type AccountOAuth = z.infer<typeof AccountOAuth>;

const routes = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    identity: 'https://openidconnect.googleapis.com/v1/userinfo',
    identityScopes: ['openid', 'email'],
    scopes: {
      'mail:mailbox.read': 'https://www.googleapis.com/auth/gmail.readonly',
      'mail:message.write': 'https://www.googleapis.com/auth/gmail.modify',
      'mail:message.send': 'https://www.googleapis.com/auth/gmail.send',
      'calendar:calendars.read': 'https://www.googleapis.com/auth/calendar.readonly',
      'calendar:events.write': 'https://www.googleapis.com/auth/calendar.events',
      'calendar:events.edit': 'https://www.googleapis.com/auth/calendar.events',
      'calendar:events.delete': 'https://www.googleapis.com/auth/calendar.events'
    }
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    identity: 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName',
    identityScopes: ['offline_access', 'User.Read'],
    scopes: {
      'mail:mailbox.read': 'Mail.Read',
      'mail:message.write': 'Mail.ReadWrite',
      'mail:message.send': 'Mail.Send',
      'calendar:calendars.read': 'Calendars.Read',
      'calendar:events.write': 'Calendars.ReadWrite'
    }
  }
} as const;

export function accountOAuthScopes(
  provider: AccountProvider,
  capabilities: readonly ConnectorScope[]
): string[] {
  if (!capabilities.length)
    throw new GardenError('connector_scope_invalid', 'Choose mail or calendar capabilities.');
  const allowed: Readonly<Record<string, string>> = routes[provider].scopes;
  const selected = capabilities.map((scope) => {
    const result = allowed[scope];
    if (!result)
      throw new GardenError(
        'connector_scope_invalid',
        'This account only supports mail and calendar capabilities.'
      );
    return result;
  });
  return [...new Set([...routes[provider].identityScopes, ...selected])];
}

export function beginAccountOAuth(input: {
  provider: AccountProvider;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scopes: readonly ConnectorScope[];
}): { authorizationUrl: string; secret: AccountOAuth } {
  const redirect = new URL(input.redirectUrl);
  if (
    redirect.username ||
    redirect.password ||
    redirect.hash ||
    redirect.search ||
    (redirect.protocol !== 'https:' &&
      !(
        redirect.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
      ))
  )
    throw new GardenError(
      'connector_redirect_invalid',
      'Use the Garden HTTPS callback or a loopback development callback.'
    );
  const verifier = randomBytes(32).toString('base64url');
  const secret = AccountOAuth.parse({
    version: 1,
    provider: input.provider,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    redirectUrl: redirect.toString(),
    requestedScopes: accountOAuthScopes(input.provider, input.scopes),
    pending: { state: randomBytes(32).toString('base64url'), verifier }
  });
  const url = new URL(routes[input.provider].authorize);
  url.search = new URLSearchParams({
    client_id: secret.clientId,
    redirect_uri: secret.redirectUrl,
    response_type: 'code',
    scope: secret.requestedScopes.join(' '),
    state: secret.pending!.state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: input.provider === 'google' ? 'select_account consent' : 'select_account',
    ...(input.provider === 'google' ? { access_type: 'offline' } : { response_mode: 'query' })
  }).toString();
  return { authorizationUrl: url.toString(), secret };
}

function responseObject(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Provider bodies may contain credentials; never include them in an error. */
  }
  throw new GardenError(
    'connector_oauth_response_invalid',
    'The account provider returned an unreadable authorization response.'
  );
}

function canonicalScope(provider: AccountProvider, scope: string): string {
  if (provider === 'google')
    return scope === 'https://www.googleapis.com/auth/userinfo.email' ? 'email' : scope;
  return scope.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase();
}

async function exchange(
  secret: AccountOAuth,
  fields: Record<string, string>,
  transport: ConnectorTransport,
  now: number
): Promise<AccountOAuth> {
  const url = new URL(routes[secret.provider].token);
  const body = Buffer.from(
    new URLSearchParams({
      client_id: secret.clientId,
      client_secret: secret.clientSecret,
      ...fields
    }).toString()
  );
  const response = await transport({
    url,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    allowedHostSuffixes: [url.hostname],
    timeoutMs: 20_000,
    maxResponseBytes: 65536
  });
  if (response.status !== 200) {
    let code: unknown;
    try {
      code = responseObject(response.body).error;
    } catch {
      /* Preserve a bounded status-only error. */
    }
    throw new GardenError(
      code === 'invalid_grant' ? 'connector_reauthorization_required' : 'connector_oauth_failed',
      code === 'invalid_grant'
        ? 'Account authorization expired or was revoked. Connect this account again.'
        : 'The account provider did not accept the authorization request.',
      400
    );
  }
  const result = responseObject(response.body);
  const parsed = z
    .object({
      access_token: token,
      token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
      refresh_token: token.optional(),
      expires_in: z.number().int().positive().max(31_536_000),
      scope: z.string().max(16384).optional()
    })
    .safeParse(result);
  if (!parsed.success)
    throw new GardenError(
      'connector_oauth_response_invalid',
      'The account provider omitted required token information.'
    );
  const value = parsed.data;
  const refreshToken = value.refresh_token ?? secret.tokens?.refreshToken;
  if (!refreshToken)
    throw new GardenError(
      'connector_reauthorization_required',
      'The provider did not grant offline access. Connect again and grant the requested access.'
    );
  const scopes =
    value.scope?.split(/\s+/).filter(Boolean) ?? secret.tokens?.scopes ?? secret.requestedScopes;
  const granted = new Set(scopes.map((scope) => canonicalScope(secret.provider, scope)));
  const missing = secret.requestedScopes.filter(
    (scope) => scope !== 'offline_access' && !granted.has(canonicalScope(secret.provider, scope))
  );
  if (missing.length)
    throw new GardenError(
      'connector_scope_denied',
      'The provider did not grant every selected capability. Reconnect with fewer capabilities or grant the requested access.'
    );
  const { pending: _pending, ...rest } = secret;
  return AccountOAuth.parse({
    ...rest,
    tokens: {
      accessToken: value.access_token,
      refreshToken,
      scopes,
      expiresAt: now + Math.min(value.expires_in, 86400) * 1000
    }
  });
}

export async function completeAccountOAuth(input: {
  secret: AccountOAuth;
  state: string;
  code: string;
  transport: ConnectorTransport;
  now?: number;
}): Promise<AccountOAuth> {
  const secret = AccountOAuth.parse(input.secret);
  if (!secret.pending || input.state !== secret.pending.state)
    throw new GardenError(
      'connector_oauth_state_invalid',
      'This authorization response does not match the connection attempt.'
    );
  const code = z.string().min(1).max(8192).parse(input.code);
  const connected = await exchange(
    secret,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: secret.redirectUrl,
      code_verifier: secret.pending.verifier
    },
    input.transport,
    input.now ?? Date.now()
  );
  return verifyAccountOAuthIdentity(connected, input.transport);
}

export async function verifyAccountOAuthIdentity(
  connected: AccountOAuth,
  transport: ConnectorTransport
): Promise<AccountOAuth> {
  const url = new URL(routes[connected.provider].identity);
  const response = await transport({
    url,
    method: 'GET',
    headers: {
      authorization: `Bearer ${connected.tokens!.accessToken}`,
      accept: 'application/json'
    },
    allowedHostSuffixes: [url.hostname],
    timeoutMs: 20_000,
    maxResponseBytes: 65536
  });
  if (response.status !== 200)
    throw new GardenError(
      'connector_identity_unavailable',
      'The provider could not confirm which account was connected.'
    );
  const identity = responseObject(response.body);
  const account =
    connected.provider === 'google'
      ? { id: identity.sub, address: identity.email }
      : { id: identity.id, address: identity.mail || identity.userPrincipalName };
  if (connected.provider === 'google' && identity.email_verified !== true)
    throw new GardenError(
      'connector_identity_unavailable',
      'The provider did not confirm a verified account email address.'
    );
  const verified = AccountOAuth.safeParse({ ...connected, account });
  if (!verified.success)
    throw new GardenError(
      'connector_identity_unavailable',
      'The provider returned an incomplete account identity.'
    );
  if (connected.account && connected.account.id !== verified.data.account!.id)
    throw new GardenError(
      'connector_identity_changed',
      'The provider returned a different account. Connect it explicitly.'
    );
  return verified.data;
}

/** The caller holds the connector's secret lock and persists a rotated token before releasing it. */
export async function refreshAccountOAuth(
  secret: AccountOAuth,
  transport: ConnectorTransport,
  now = Date.now()
): Promise<AccountOAuth> {
  const current = AccountOAuth.parse(secret);
  if (current.pending || !current.tokens || !current.account)
    throw new GardenError(
      'connector_reauthorization_required',
      'Connect this account before using it.'
    );
  if (current.tokens.expiresAt > now + 90_000) return current;
  return exchange(
    current,
    {
      grant_type: 'refresh_token',
      refresh_token: current.tokens.refreshToken,
      ...(current.provider === 'microsoft' ? { scope: current.requestedScopes.join(' ') } : {})
    },
    transport,
    now
  );
}
