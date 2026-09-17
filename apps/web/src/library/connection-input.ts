import { fieldValue, rawFieldValue } from '../management.js';

export const secretValue = rawFieldValue;

export function connectionInput(form: FormData, kind: string, allowedScopes: readonly string[]) {
  const scopes = form.getAll('scope').map(String);
  if (!scopes.length) throw new Error('Choose the access this connection needs.');
  if (scopes.some((scope) => !allowedScopes.includes(scope)))
    throw new Error('The access choices changed. Choose this service’s permissions again.');
  const common = { kind, label: fieldValue(form, 'label'), scopes };
  if (kind === 'google' || kind === 'microsoft')
    return {
      ...common,
      clientId: fieldValue(form, 'clientId'),
      clientSecret: secretValue(form, 'clientSecret')
    };
  if (kind === 'github') return { ...common, token: secretValue(form, 'token') };
  if (kind === 'mcp_http')
    return {
      ...common,
      baseUrl: fieldValue(form, 'baseUrl'),
      ...(secretValue(form, 'token') ? { token: secretValue(form, 'token') } : {})
    };
  return {
    ...common,
    baseUrl: fieldValue(form, 'baseUrl'),
    username: fieldValue(form, 'username'),
    password: secretValue(form, 'password'),
    ...(kind === 'imap'
      ? {
          fromAddress: fieldValue(form, 'fromAddress'),
          ...(fieldValue(form, 'fromName') ? { fromName: fieldValue(form, 'fromName') } : {}),
          smtpHost: fieldValue(form, 'smtpHost'),
          smtpPort: Number(form.get('smtpPort'))
        }
      : kind === 'caldav'
        ? { address: fieldValue(form, 'address') }
        : {})
  };
}

export function oauthCompletion(
  event: { origin: string; source: unknown; data: unknown },
  popup: unknown,
  origin: string
): { ok: boolean; message?: string } | null {
  if (!popup || event.source !== popup || event.origin !== origin) return null;
  if (!event.data || typeof event.data !== 'object') return null;
  const data = event.data as Record<string, unknown>;
  if (
    !['athanor-mcp-oauth', 'athanor-account-oauth'].includes(String(data.source)) ||
    typeof data.ok !== 'boolean'
  )
    return null;
  return { ok: data.ok, ...(typeof data.message === 'string' ? { message: data.message } : {}) };
}
