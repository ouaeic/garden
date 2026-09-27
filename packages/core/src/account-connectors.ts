import { AccountMailComposition, composeAccountMail } from './account-mail-compose.js';
import {
  AccountCalendarUpdate,
  AccountCalendarDelete,
  mutateAccountCalendarEvent,
  readAccountCalendarEvent
} from './account-calendar-mutation.js';
import { AccountCalendarCreate, createAccountCalendarEvent } from './account-calendar-write.js';
import { z } from 'zod';
import type {
  ConnectorDefinition,
  ConnectorExecutionInput,
  ConnectorExecutionResult,
  ConnectorTransport
} from './connectors.js';
import { AccountApi, accountResourceId } from './account-api.js';
import { AccountOAuth, type AccountProvider, refreshAccountOAuth } from './account-oauth.js';
import {
  listAccountMessages,
  readAccountMessage,
  readAccountAttachment,
  listAccountAttachments
} from './account-mail.js';
import { listAccountCalendars, readAccountCalendarRange } from './account-calendar.js';
import { AthanorError } from './errors.js';
import { decryptJson, encryptJson, type EncryptedEnvelope } from './crypto.js';

export const isAccountConnectorKind = (kind: string): kind is AccountProvider =>
  kind === 'google' || kind === 'microsoft';
export const accountConnectorBase = (provider: AccountProvider) =>
  provider === 'google' ? 'https://gmail.googleapis.com' : 'https://graph.microsoft.com';
const read = (scope: 'mail:mailbox.read' | 'calendar:calendars.read') => ({
  kinds: ['google', 'microsoft'] as const,
  scope,
  sideEffect: 'read' as const
});
export const accountConnectorActions = {
  account_mail_draft: {
    kinds: ['google', 'microsoft'] as const,
    scope: 'mail:message.write' as const,
    sideEffect: 'write' as const
  },
  account_mail_send: {
    kinds: ['google', 'microsoft'] as const,
    scope: 'mail:message.send' as const,
    sideEffect: 'delete' as const
  },
  account_mail_search: read('mail:mailbox.read'),
  account_mail_read: read('mail:mailbox.read'),
  account_mail_attachments: read('mail:mailbox.read'),
  account_mail_attachment: read('mail:mailbox.read'),
  account_calendar_read: read('calendar:calendars.read'),
  account_calendar_update: {
    kinds: ['google'] as const,
    scope: 'calendar:events.edit' as const,
    sideEffect: 'write' as const
  },
  account_calendar_delete: {
    kinds: ['google'] as const,
    scope: 'calendar:events.delete' as const,
    sideEffect: 'delete' as const
  },
  account_calendar_list: read('calendar:calendars.read'),
  account_calendar_range: read('calendar:calendars.read'),
  account_calendar_create: {
    kinds: ['google', 'microsoft'] as const,
    scope: 'calendar:events.write' as const,
    sideEffect: 'write' as const
  }
};
const page = {
  limit: z.number().int().min(1).max(50).default(25),
  cursor: z.string().max(16384).optional()
};
export const accountConnectorInputs = [
  AccountMailComposition.safeExtend({ action: z.literal('account_mail_draft') }),
  AccountMailComposition.safeExtend({ action: z.literal('account_mail_send') }),
  z
    .object({
      action: z.literal('account_calendar_read'),
      eventId: accountResourceId,
      calendarId: accountResourceId.optional()
    })
    .strict(),
  AccountCalendarUpdate.extend({ action: z.literal('account_calendar_update') }),
  AccountCalendarDelete.extend({ action: z.literal('account_calendar_delete') }),
  AccountCalendarCreate.safeExtend({ action: z.literal('account_calendar_create') }),
  z.object({
    action: z.literal('account_mail_search'),
    query: z.string().max(2000).default(''),
    ...page
  }),
  z.object({
    action: z.literal('account_mail_read'),
    messageId: accountResourceId,
    maxCharacters: z.number().int().min(500).max(200_000).default(20_000)
  }),
  z.object({
    action: z.literal('account_mail_attachments'),
    messageId: accountResourceId,
    cursor: page.cursor
  }),
  z.object({
    action: z.literal('account_mail_attachment'),
    messageId: accountResourceId,
    partId: accountResourceId,
    maxBytes: z.number().int().min(1000).max(25_000_000).default(5_000_000)
  }),
  z.object({ action: z.literal('account_calendar_list'), ...page }),
  z.object({
    action: z.literal('account_calendar_range'),
    calendarId: accountResourceId.optional(),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    ...page
  })
] as const;
const actionInput = z.discriminatedUnion('action', accountConnectorInputs);
export const parseAccountConnectorAction = (input: unknown) => actionInput.parse(input);

export const accountConnectorCatalog: ConnectorDefinition[] = (
  ['google', 'microsoft'] as const
).map((kind) => ({
  kind,
  name: kind === 'google' ? 'Google mail and calendar' : 'Microsoft mail and calendar',
  description:
    kind === 'google'
      ? 'Read and compose mail with attachments, and manage calendar events with separately granted access.'
      : 'Read and compose mail with attachments, read calendars, and create events through the account API.',
  dataAccess: 'Only the selected account and granted mail or calendar access are used.',
  tokenLocation:
    'Authorization and refresh tokens are encrypted on your Garden server and never sent to a model.',
  providerLogging: 'The account provider handles API activity under its own account policy.',
  requirements:
    'Register an OAuth web application with the provider, then choose the account during sign-in.',
  scopes: [
    { id: 'mail:message.write', label: 'Create mail drafts and attachments', sideEffect: 'write' },
    { id: 'mail:message.send', label: 'Send mail', sideEffect: 'delete' },
    { id: 'mail:mailbox.read', label: 'Read mail and attachments', sideEffect: 'read' },
    { id: 'calendar:calendars.read', label: 'Read calendars', sideEffect: 'read' },
    { id: 'calendar:events.write', label: 'Create calendar events', sideEffect: 'write' },
    ...(kind === 'google'
      ? [
          {
            id: 'calendar:events.edit' as const,
            label: 'Edit calendar events',
            sideEffect: 'write' as const
          },
          {
            id: 'calendar:events.delete' as const,
            label: 'Delete calendar events',
            sideEffect: 'delete' as const
          }
        ]
      : [])
  ]
}));

/** Used inside the database's connector lock; rotated credentials must commit before API use. */
export async function authorizeAccountConnector(
  connector: { id: string; userId: string; kind: string; secretCiphertext: EncryptedEnvelope },
  masterKey: Uint8Array,
  transport: ConnectorTransport
) {
  const aad = `connector:${connector.userId}:${connector.id}`;
  if (!isAccountConnectorKind(connector.kind) || connector.secretCiphertext.aad !== aad)
    throw new AthanorError(
      'connector_secret_context',
      'The account authorization does not match this connection.'
    );
  const stored = decryptJson<{ accountOAuth: unknown }>(connector.secretCiphertext, masterKey);
  const current = AccountOAuth.parse(stored.accountOAuth);
  if (current.provider !== connector.kind)
    throw new AthanorError('connector_secret_context', 'The account provider does not match.');
  const refreshed = await refreshAccountOAuth(current, transport);
  const secret = { accountOAuth: refreshed };
  return {
    value: secret,
    ...(JSON.stringify(current) !== JSON.stringify(refreshed)
      ? { secretCiphertext: encryptJson(secret, masterKey, aad) }
      : {})
  };
}

export async function executeAccountConnector(
  input: ConnectorExecutionInput,
  transport: ConnectorTransport
): Promise<ConnectorExecutionResult> {
  const action = actionInput.parse(input.action);
  const definition = accountConnectorActions[action.action];
  if (!input.scopes.includes(definition.scope))
    throw new AthanorError(
      'connector_scope_denied',
      `Connector has not granted ${definition.scope}`
    );
  const api = new AccountApi(
    AccountOAuth.parse(input.secret.accountOAuth),
    transport,
    input.operation?.signal
  );
  if (
    api.secret.provider !== input.kind ||
    input.baseUrl !== accountConnectorBase(api.secret.provider)
  )
    throw new AthanorError(
      'connector_secret_context',
      'The account does not match this connection.'
    );
  let result: unknown;
  switch (action.action) {
    case 'account_mail_draft':
    case 'account_mail_send':
      if (!input.operation)
        throw new AthanorError(
          'connector_operation_required',
          'Mail changes need a durable operation receipt.'
        );
      result = await composeAccountMail(
        api,
        Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'action')),
        action.action === 'account_mail_send' ? 'send' : 'draft',
        input.operation,
        input.scopes
      );
      break;
    case 'account_mail_search':
      result = await listAccountMessages(api, action);
      break;
    case 'account_mail_read':
      result = await readAccountMessage(api, {
        id: action.messageId,
        maxCharacters: action.maxCharacters
      });
      break;
    case 'account_mail_attachments':
      result = await listAccountAttachments(api, action.messageId, action.cursor);
      break;
    case 'account_mail_attachment':
      result = await readAccountAttachment(api, {
        id: action.messageId,
        partId: action.partId,
        maxBytes: action.maxBytes
      });
      break;
    case 'account_calendar_read':
      result = await readAccountCalendarEvent(api, action);
      break;
    case 'account_calendar_update':
    case 'account_calendar_delete':
      if (!input.operation)
        throw new AthanorError(
          'connector_operation_required',
          'Calendar changes need a durable operation receipt.'
        );
      result = await mutateAccountCalendarEvent(
        api,
        action.action === 'account_calendar_update'
          ? { ...action, action: 'update' }
          : { ...action, action: 'delete' },
        input.operation,
        input.scopes
      );
      break;
    case 'account_calendar_create':
      if (!input.operation)
        throw new AthanorError(
          'connector_operation_required',
          'Calendar changes need a durable operation receipt.'
        );
      result = await createAccountCalendarEvent(api, action, input.operation, input.scopes);
      break;
    case 'account_calendar_list':
      result = await listAccountCalendars(api, action);
      break;
    case 'account_calendar_range':
      result = await readAccountCalendarRange(api, action);
      break;
  }
  return { action: action.action, result, ...api.metrics };
}
