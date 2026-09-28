import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConnectorScope } from '@garden/contracts';
import { type AccountApi, accountResourceId } from './account-api.js';
import type { AccountOperation } from './account-operation.js';
import { GardenError } from './errors.js';
import { composeMessage } from './mime.js';
import { attachAccountMailFiles } from './account-mail-upload.js';

const header = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => !/[\r\n\0]/.test(value));
const person = z.object({ address: z.email().max(320), name: header(200).optional() }).strict();
export const AccountMailComposition = z
  .object({
    to: z.array(person).max(50).default([]),
    cc: z.array(person).max(50).default([]),
    bcc: z.array(person).max(50).default([]),
    subject: header(500),
    text: z.string().max(200_000),
    messageId: accountResourceId.optional(),
    attachments: z
      .array(
        z
          .object({
            filename: header(200).min(1),
            contentType: header(200).default('application/octet-stream'),
            contentBase64: z
              .string()
              .max(14_000_000)
              .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
          })
          .strict()
      )
      .max(10)
      .default([])
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.to.length && !value.cc.length && !value.bcc.length)
      context.addIssue({ code: 'custom', message: 'Name at least one recipient.' });
    if (
      value.attachments.reduce(
        (sum, file) => sum + Buffer.byteLength(file.contentBase64, 'base64'),
        0
      ) > 10_000_000
    )
      context.addIssue({
        code: 'custom',
        path: ['attachments'],
        message: 'Attachments exceed the mail transfer limit.'
      });
  });
export type AccountMailComposition = z.infer<typeof AccountMailComposition>;
export const MailCheckpoint = z
  .object({
    version: z.literal(1),
    kind: z.literal('mail_composition'),
    operationId: z.uuid(),
    digest: z.string().length(64),
    mode: z.enum(['draft', 'send']),
    phase: z.enum(['prepared', 'creating', 'attachments', 'attaching', 'sending']),
    draftId: accountResourceId.optional(),
    attachment: z.number().int().min(0).max(10).default(0),
    upload: z
      .object({
        url: z.string().max(16384),
        expiresAt: z.string(),
        offset: z.number().int().min(0),
        pending: z.boolean()
      })
      .optional()
  })
  .strict();
export type MailCheckpoint = z.infer<typeof MailCheckpoint>;
const Receipt = z
  .object({
    status: z.enum(['drafted', 'accepted']),
    operationId: z.uuid(),
    messageId: accountResourceId,
    draftId: accountResourceId.optional(),
    recovered: z.boolean(),
    message: z.string()
  })
  .strict();
const object = z.record(z.string(), z.unknown());
const rows = (value: unknown) => z.array(object).parse(value ?? []);
export const mailUncertain = (operationId: string) => ({
  status: 'uncertain' as const,
  operationId,
  message:
    'The mail operation needs reconciliation. Retry this same action to inspect its saved receipt; no uncertain send will be repeated.'
});
const property = 'String {8b67d872-679e-46d5-a742-6e30f513f61a} Name GardenOperation';
const missing = (error: unknown) =>
  error instanceof GardenError && error.code === 'connector_resource_not_found';
const address = (entry: z.infer<typeof person>) => ({
  emailAddress: { address: entry.address, ...(entry.name ? { name: entry.name } : {}) }
});

async function reply(api: AccountApi, id?: string) {
  if (!id) return {};
  if (api.secret.provider === 'microsoft') {
    const source = await api.json(
      api.url('graph', `messages/${encodeURIComponent(id)}`, {
        $select: 'id,internetMessageId,subject'
      })
    );
    if (source.id !== id || typeof source.internetMessageId !== 'string')
      throw new GardenError('mail_reply_invalid', 'The original message identity is unavailable.');
    return {
      inReplyTo: header(2048).parse(source.internetMessageId),
      subject: z.string().parse(source.subject ?? '')
    };
  }
  const source = await api.json(
    api.url('gmail', `messages/${encodeURIComponent(id)}`, { format: 'metadata' })
  );
  if (source.id !== id)
    throw new GardenError('mail_reply_invalid', 'The provider returned a different message.');
  const headers = rows(object.parse(source.payload).headers);
  const find = (name: string) =>
    headers.find((row) => String(row.name).toLowerCase() === name)?.value;
  return {
    inReplyTo: header(2048).parse(find('message-id')),
    references: header(10000)
      .parse(find('references') ?? '')
      .split(/\s+/)
      .filter(Boolean),
    threadId: accountResourceId.parse(source.threadId),
    subject: z.string().parse(find('subject') ?? '')
  };
}

/** The encrypted operation is written before every mutation; uncertainty never retries a send. */
export async function composeAccountMail(
  api: AccountApi,
  value: unknown,
  mode: 'draft' | 'send',
  operation: AccountOperation,
  scopes: readonly ConnectorScope[]
) {
  const input = AccountMailComposition.parse(value);
  api.requireScope(scopes, mode === 'send' ? 'mail:message.send' : 'mail:message.write');
  api.requireScope(scopes, 'mail:mailbox.read');
  if (api.secret.provider === 'microsoft') api.requireScope(scopes, 'mail:message.write');
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        input,
        mode,
        provider: api.secret.provider,
        account: api.secret.account!.id
      })
    )
    .digest('hex');
  let state = operation.recovery ? MailCheckpoint.parse(operation.recovery) : null;
  if (
    state &&
    (state.operationId !== operation.id || state.digest !== digest || state.mode !== mode)
  )
    throw new GardenError(
      'connector_operation_mismatch',
      'The saved mail operation belongs to different content or an account.'
    );
  if (operation.completed) {
    if (!state)
      throw new GardenError(
        'connector_operation_mismatch',
        'The mail receipt has no matching intent.'
      );
    const receipt = Receipt.parse(operation.result);
    if (receipt.operationId !== operation.id)
      throw new GardenError(
        'connector_operation_mismatch',
        'The saved mail receipt belongs to another operation.'
      );
    return receipt;
  }
  const recovered = state !== null;
  const finish = async (messageId: string, draftId?: string) => {
    const receipt = Receipt.parse({
      status: mode === 'draft' ? 'drafted' : 'accepted',
      operationId: operation.id,
      messageId,
      ...(draftId ? { draftId } : {}),
      recovered,
      message:
        mode === 'draft'
          ? 'The draft is saved in the connected account. Nothing was sent.'
          : 'The mail provider accepted the message. This is not confirmation of recipient delivery.'
    });
    await operation.complete(receipt);
    return receipt;
  };
  const checkpoint = async (next: MailCheckpoint) => {
    await operation.checkpoint(next);
    state = next;
  };
  const rejected = async (error: unknown, phase: 'prepared' | 'attachments' = 'prepared') => {
    if (
      error instanceof GardenError &&
      [400, 401, 403, 404, 413, 422, 429].includes(Number(error.details?.statusCode))
    ) {
      await checkpoint(
        phase === 'prepared'
          ? { ...state!, phase, draftId: undefined, upload: undefined, attachment: 0 }
          : { ...state!, phase }
      );
      throw error;
    }
    return mailUncertain(operation.id);
  };
  const internetId = `<${operation.id}@${api.secret.account!.address.split('@')[1]}>`;
  if (api.secret.provider === 'google') {
    if (state && state.phase !== 'prepared') {
      const collection = mode === 'draft' ? 'drafts' : 'messages';
      const result = await api.json(
        api.url('gmail', collection, {
          q: `rfc822msgid:${internetId}${mode === 'send' ? ' in:sent' : ''}`,
          maxResults: '2',
          includeSpamTrash: 'true'
        })
      );
      const found = rows(result[collection]);
      if (found.length !== 1 || result.nextPageToken) return mailUncertain(operation.id);
      const match = found[0]!;
      return mode === 'draft'
        ? finish(
            accountResourceId.parse(object.parse(match.message).id),
            accountResourceId.parse(match.id)
          )
        : finish(accountResourceId.parse(match.id));
    }
    const source = await reply(api, input.messageId);
    const raw = composeMessage({
      from: { address: api.secret.account!.address, name: null },
      to: input.to.map((p) => ({ address: p.address, name: p.name ?? null })),
      cc: input.cc.map((p) => ({ address: p.address, name: p.name ?? null })),
      bcc: input.bcc.map((p) => ({ address: p.address, name: p.name ?? null })),
      includeBcc: true,
      messageId: internetId,
      subject: input.subject,
      text: input.text,
      ...(source.inReplyTo
        ? {
            inReplyTo: source.inReplyTo,
            references: [...(source.references ?? []), source.inReplyTo]
          }
        : {}),
      attachments: input.attachments.map((file) => ({
        filename: file.filename,
        contentType: file.contentType,
        content: Buffer.from(file.contentBase64, 'base64')
      }))
    }).raw;
    const sameSubject =
      input.subject.replace(/^re:\s*/i, '') === source.subject?.replace(/^re:\s*/i, '');
    const message = {
      raw: raw.toString('base64url'),
      ...(source.threadId && sameSubject ? { threadId: source.threadId } : {})
    };
    await checkpoint({
      version: 1,
      kind: 'mail_composition',
      operationId: operation.id,
      digest,
      mode,
      phase: 'creating',
      attachment: 0
    });
    let result;
    try {
      result = await api.json(api.url('gmail', mode === 'draft' ? 'drafts' : 'messages/send'), {
        method: 'POST',
        body: mode === 'draft' ? { message } : message
      });
    } catch (error) {
      return rejected(error);
    }
    return mode === 'draft'
      ? finish(
          accountResourceId.parse(object.parse(result.message).id),
          accountResourceId.parse(result.id)
        )
      : finish(accountResourceId.parse(result.id));
  }
  if (state?.phase === 'creating') {
    const result = await api.json(
      api.url('graph', 'messages', {
        $filter: `singleValueExtendedProperties/Any(p: p/id eq '${property}' and p/value eq '${operation.id}')`,
        $select: 'id,isDraft',
        $top: '2'
      })
    );
    const found = rows(result.value);
    if (found.length !== 1 || result['@odata.nextLink'] || found[0]!.isDraft !== true)
      return mailUncertain(operation.id);
    await checkpoint({
      ...state,
      phase: 'attachments',
      draftId: accountResourceId.parse(found[0]!.id)
    });
  }
  if (!state || state.phase === 'prepared') {
    await reply(api, input.messageId);
    const body = {
      subject: input.subject,
      body: { contentType: 'Text', content: input.text },
      toRecipients: input.to.map(address),
      ccRecipients: input.cc.map(address),
      bccRecipients: input.bcc.map(address),
      singleValueExtendedProperties: [{ id: property, value: operation.id }]
    };
    await checkpoint({
      version: 1,
      kind: 'mail_composition',
      operationId: operation.id,
      digest,
      mode,
      phase: 'creating',
      attachment: 0
    });
    let result;
    try {
      result = await api.json(
        api.url(
          'graph',
          input.messageId
            ? `messages/${encodeURIComponent(input.messageId)}/createReply`
            : 'messages'
        ),
        { method: 'POST', body: input.messageId ? { message: body } : body }
      );
    } catch (error) {
      return rejected(error);
    }
    await checkpoint({
      ...state!,
      phase: 'attachments',
      draftId: accountResourceId.parse(result.id)
    });
  }
  if (state!.phase === 'sending') {
    try {
      const message = await api.json(
        api.url('graph', `messages/${encodeURIComponent(state!.draftId!)}`, {
          $select: 'id,isDraft,sentDateTime'
        })
      );
      if (
        message.id === state!.draftId &&
        message.isDraft === false &&
        typeof message.sentDateTime === 'string'
      )
        return finish(state!.draftId!);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return mailUncertain(operation.id);
  }
  if (!state)
    throw new GardenError('mail_intent_missing', 'The saved mail operation is unavailable.');
  const attached = await attachAccountMailFiles(api, input.attachments, state, checkpoint);
  if (!attached) return mailUncertain(operation.id);
  if (mode === 'draft') return finish(state.draftId!, state.draftId);
  const draft = await api.json(
    api.url('graph', `messages/${encodeURIComponent(state.draftId!)}`, {
      $select: 'id,isDraft,subject,body,toRecipients,ccRecipients,bccRecipients'
    })
  );
  const recipients = (value: unknown) =>
    rows(value)
      .map((row) => z.string().parse(object.parse(row.emailAddress).address).toLowerCase())
      .sort();
  const sameRecipients = (value: unknown, expected: z.infer<typeof person>[]) =>
    JSON.stringify(recipients(value)) ===
    JSON.stringify(expected.map((p) => p.address.toLowerCase()).sort());
  if (
    draft.id !== state.draftId ||
    draft.isDraft !== true ||
    draft.subject !== input.subject ||
    String(object.parse(draft.body).contentType).toLowerCase() !== 'text' ||
    String(object.parse(draft.body).content).replace(/\r\n/g, '\n') !==
      input.text.replace(/\r\n/g, '\n') ||
    !sameRecipients(draft.toRecipients, input.to) ||
    !sameRecipients(draft.ccRecipients, input.cc) ||
    !sameRecipients(draft.bccRecipients, input.bcc)
  )
    throw new GardenError(
      'mail_draft_changed',
      'The provider draft differs from the requested message. Inspect it before sending.'
    );
  await checkpoint({ ...state, phase: 'sending' });
  try {
    const response = await api.request(
      api.url('graph', `messages/${encodeURIComponent(state.draftId!)}/send`),
      { method: 'POST' }
    );
    if (response.status !== 202) return mailUncertain(operation.id);
  } catch (error) {
    return rejected(error, 'attachments');
  }
  return finish(state.draftId!);
}
