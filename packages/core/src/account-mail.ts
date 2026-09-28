import { z } from 'zod';
import { type AccountApi, accountResourceId } from './account-api.js';
import { GardenError } from './errors.js';
import { htmlToText } from './mime.js';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const pageInput = z.object({
  query: z.string().max(2000).default(''),
  limit: z.number().int().min(1).max(50).default(25),
  cursor: z.string().max(16384).optional()
});
const messageFields =
  'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview';
const attachmentFields = 'id,name,contentType,size,isInline';
const records = z.array(z.record(z.string(), z.unknown()));
const nextLink = z.string().min(1).max(8192).optional();
const partId = (kind: 'attachment' | 'part', id: string) =>
  `${kind}:${Buffer.from(id).toString('base64url')}`;

function base64Bytes(encoded: unknown, maximum: number): Buffer {
  if (typeof encoded !== 'string')
    throw new GardenError('mail_content_invalid', 'The mailbox omitted the requested content.');
  const value = encoded;
  if (!/^[A-Za-z0-9_+/-]*={0,2}$/.test(value) || value.length > Math.ceil(maximum / 3) * 4)
    throw new GardenError(
      'mail_content_invalid',
      'The mailbox returned invalid or oversized encoded content.'
    );
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > maximum)
    throw new GardenError(
      'mail_content_too_large',
      'The mailbox content exceeds the requested size.'
    );
  return bytes;
}

function headers(payload: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    list(payload.headers)
      .slice(0, 200)
      .map((value) => {
        const header = object(value);
        return [text(header.name).toLowerCase(), text(header.value).slice(0, 16384)];
      })
  );
}

function gmailParts(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new GardenError('mail_content_invalid', 'The mailbox omitted the message structure.');
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || found.length >= 200)
      throw new GardenError('mail_structure_too_large', 'This message has too many nested parts.');
    const part = object(value);
    found.push(part);
    for (const child of list(part.parts)) visit(child, depth + 1);
  };
  visit(payload, 0);
  return found;
}

function requireIdentity(message: Record<string, unknown>, expected: string) {
  if (message.id !== expected)
    throw new GardenError(
      'mail_response_invalid',
      'The mailbox returned a different message or attachment.'
    );
  return message;
}

function gmailAttachment(part: Record<string, unknown>, bodyFile = false) {
  const body = object(part.body),
    providerId = text(body.attachmentId),
    localId = text(part.partId);
  return {
    partId: partId(providerId ? 'attachment' : 'part', providerId || localId),
    filename:
      text(part.filename) ||
      (bodyFile ? (part.mimeType === 'text/html' ? 'message.html' : 'message.txt') : 'attachment'),
    contentType: text(part.mimeType).toLowerCase(),
    sizeBytes: body.size
  };
}

function gmailSummary(value: Record<string, unknown>) {
  const fields = headers(object(value.payload));
  return {
    id: value.id,
    threadId: value.threadId,
    subject: fields.subject ?? '',
    from: fields.from ?? '',
    to: fields.to ?? '',
    date: fields.date ?? '',
    messageId: fields['message-id'] ?? null,
    labels: list(value.labelIds).filter((label) => typeof label === 'string'),
    snippet: text(value.snippet),
    sizeBytes: value.sizeEstimate
  };
}

export async function listAccountMessages(api: AccountApi, input: z.input<typeof pageInput>) {
  const parsed = pageInput.parse(input);
  if (api.secret.provider === 'microsoft') {
    const collection = api.url('graph', 'messages', {
      $select: messageFields,
      $top: String(parsed.limit),
      ...(parsed.query ? { $search: JSON.stringify(parsed.query) } : {})
    });
    const page = await api.json(api.pageUrl(collection, parsed.cursor));
    const values = records.parse(page.value);
    if (values.length > parsed.limit)
      throw new GardenError('mail_page_invalid', 'The provider exceeded the requested page size.');
    return {
      messages: values.map((value) => ({ ...value, id: accountResourceId.parse(value.id) })),
      nextCursor: api.nextCursor(collection, nextLink.parse(page['@odata.nextLink']))
    };
  }
  const collection = api.url('gmail', 'messages', {
    q: parsed.query,
    maxResults: String(parsed.limit)
  });
  const page = await api.json(api.pageUrl(collection, parsed.cursor));
  const ids = records.parse(page.messages ?? []).map((value) => accountResourceId.parse(value.id));
  if (ids.length > parsed.limit)
    throw new GardenError('mail_page_invalid', 'The provider exceeded the requested page size.');
  const messages: ReturnType<typeof gmailSummary>[] = [];
  for (let offset = 0; offset < ids.length; offset += 4) {
    const batch = await Promise.allSettled(
      ids
        .slice(offset, offset + 4)
        .map(async (id) =>
          gmailSummary(
            requireIdentity(
              await api.json(
                api.url('gmail', `messages/${encodeURIComponent(id)}`, { format: 'metadata' }),
                { maxBytes: 256_000 }
              ),
              id
            )
          )
        )
    );
    const failed = batch.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    messages.push(
      ...batch.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    );
  }
  const token = nextLink.parse(page.nextPageToken);
  const next = token ? new URL(collection) : null;
  if (token) next?.searchParams.set('pageToken', token);
  return {
    messages,
    nextCursor: api.nextCursor(collection, next?.toString()),
    estimatedTotal: page.resultSizeEstimate
  };
}

export async function listAccountAttachments(api: AccountApi, id: string, cursor?: string) {
  accountResourceId.parse(id);
  if (api.secret.provider === 'google') {
    if (cursor)
      throw new GardenError(
        'connector_cursor_invalid',
        'This message has no attachment page cursor.'
      );
    const message = requireIdentity(
      await api.json(api.url('gmail', `messages/${encodeURIComponent(id)}`, { format: 'full' }), {
        maxBytes: 4_000_000
      }),
      id
    );
    const attachments = gmailParts(message.payload).flatMap((part) => {
      const type = text(part.mimeType).toLowerCase(),
        body = object(part.body);
      const bodyFile = !part.filename && ['text/plain', 'text/html'].includes(type);
      if (
        part.filename ||
        (!type.startsWith('multipart/') && !bodyFile) ||
        (bodyFile && body.attachmentId)
      )
        return [gmailAttachment(part, bodyFile)];
      return [];
    });
    return { attachments, nextCursor: null };
  }
  const collection = api.url('graph', `messages/${encodeURIComponent(id)}/attachments`, {
    $select: attachmentFields,
    $top: '50'
  });
  const result = await api.json(api.pageUrl(collection, cursor));
  const entries = records.max(50).parse(result.value);
  return {
    attachments: entries.map((entry) => {
      return {
        partId: accountResourceId.parse(entry.id),
        filename: entry.name,
        contentType: entry.contentType,
        sizeBytes: entry.size,
        inline: entry.isInline,
        kind: entry['@odata.type']
      };
    }),
    nextCursor: api.nextCursor(collection, nextLink.parse(result['@odata.nextLink']))
  };
}

export async function readAccountMessage(
  api: AccountApi,
  input: { id: string; maxCharacters?: number }
) {
  const id = accountResourceId.parse(input.id);
  const maximum = z
    .number()
    .int()
    .min(500)
    .max(200_000)
    .parse(input.maxCharacters ?? 20_000);
  if (api.secret.provider === 'microsoft') {
    const message = requireIdentity(
      await api.json(
        api.url('graph', `messages/${encodeURIComponent(id)}`, {
          $select: `${messageFields},body,replyTo,internetMessageHeaders`
        })
      ),
      id
    );
    if (!message.body || typeof message.body !== 'object')
      throw new GardenError('mail_content_invalid', 'The mailbox omitted the requested body.');
    const body = object(message.body),
      content = text(body.content);
    const plain = text(body.contentType).toLowerCase() === 'html' ? htmlToText(content) : content;
    // Inline attachments do not set Graph's hasAttachments flag.
    const attachments = await listAccountAttachments(api, id);
    return {
      ...message,
      body: plain.slice(0, maximum),
      bodyTruncated: plain.length > maximum,
      bodyNotice: undefined,
      ...attachments
    };
  }
  const message = requireIdentity(
    await api.json(api.url('gmail', `messages/${encodeURIComponent(id)}`, { format: 'full' }), {
      maxBytes: 4_000_000
    }),
    id
  );
  const plain: string[] = [],
    html: string[] = [],
    attachments = [];
  let missingBody = false;
  let remainingBodyBytes = 3_000_000;
  for (const part of gmailParts(message.payload)) {
    const body = object(part.body),
      filename = text(part.filename),
      mimeType = text(part.mimeType).toLowerCase();
    if (
      filename ||
      (!mimeType.startsWith('multipart/') && !['text/plain', 'text/html'].includes(mimeType))
    ) {
      attachments.push(gmailAttachment(part));
      continue;
    }
    let data = body.data;
    if (!data && body.attachmentId) {
      const providerId = accountResourceId.parse(body.attachmentId);
      if (typeof body.size !== 'number' || body.size > remainingBodyBytes) {
        missingBody = true;
        attachments.push({
          partId: partId('attachment', providerId),
          filename: mimeType === 'text/html' ? 'message.html' : 'message.txt',
          contentType: mimeType,
          sizeBytes: body.size
        });
        continue;
      }
      data = (
        await api.json(
          api.url(
            'gmail',
            `messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(providerId)}`
          ),
          { maxBytes: Math.ceil((remainingBodyBytes * 4) / 3) + 4096 }
        )
      ).data;
    }
    if (!data) continue;
    const charset =
      /charset\s*=\s*"?([^";\s]+)/i.exec(headers(part)['content-type'] ?? '')?.[1] ?? 'utf-8';
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charset);
    } catch {
      decoder = new TextDecoder('utf-8');
    }
    const bytes = base64Bytes(data, remainingBodyBytes);
    remainingBodyBytes -= bytes.length;
    const decoded = decoder.decode(bytes);
    if (mimeType === 'text/plain') plain.push(decoded);
    if (mimeType === 'text/html') html.push(htmlToText(decoded));
  }
  const body = (plain.length ? plain : html).join('\n');
  return {
    ...gmailSummary(message),
    body: body.slice(0, maximum),
    bodyTruncated: missingBody || body.length > maximum,
    ...(missingBody
      ? {
          bodyNotice:
            'Some large body parts were not loaded. They are listed as downloadable message attachments.'
        }
      : {}),
    bodyFromHtml: !plain.length && !!html.length,
    attachments,
    nextCursor: null
  };
}

export async function readAccountAttachment(
  api: AccountApi,
  input: { id: string; partId: string; maxBytes?: number }
) {
  const id = accountResourceId.parse(input.id),
    selected = accountResourceId.parse(input.partId);
  const maximum = z
    .number()
    .int()
    .min(1000)
    .max(25_000_000)
    .parse(input.maxBytes ?? 5_000_000);
  if (api.secret.provider === 'microsoft') {
    const path = `messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(selected)}`;
    const metadata = requireIdentity(
      await api.json(api.url('graph', path, { $select: attachmentFields })),
      selected
    );
    if (
      !['#microsoft.graph.fileAttachment', '#microsoft.graph.itemAttachment'].includes(
        text(metadata['@odata.type'])
      )
    )
      throw new GardenError(
        'mail_attachment_unsupported',
        'This attachment is a link; open its destination through the governed browser instead.'
      );
    if (typeof metadata.size === 'number' && metadata.size > maximum)
      throw new GardenError('mail_content_too_large', 'The attachment exceeds maxBytes.');
    const response = await api.request(api.url('graph', `${path}/$value`), { maxBytes: maximum });
    return {
      filename: text(metadata.name) || 'attachment',
      contentType: text(metadata.contentType) || 'application/octet-stream',
      contentBase64: response.body.toString('base64'),
      sizeBytes: response.body.length
    };
  }
  const match = /^(attachment|part):([A-Za-z0-9_-]*)$/.exec(selected);
  if (!match)
    throw new GardenError('mail_attachment_invalid', 'Use a partId returned by this message.');
  const providerId = Buffer.from(match[2]!, 'base64url').toString('utf8');
  const message = requireIdentity(
    await api.json(api.url('gmail', `messages/${encodeURIComponent(id)}`, { format: 'full' }), {
      maxBytes: 4_000_000
    }),
    id
  );
  const part = gmailParts(message.payload).find((value) =>
    match[1] === 'attachment'
      ? object(value.body).attachmentId === providerId
      : value.partId === providerId
  );
  if (!part)
    throw new GardenError(
      'mail_attachment_invalid',
      'The attachment no longer belongs to this message.'
    );
  const body = object(part.body);
  if (typeof body.size === 'number' && body.size > maximum)
    throw new GardenError('mail_content_too_large', 'The attachment exceeds maxBytes.');
  const data =
    match[1] === 'attachment'
      ? await api.json(
          api.url(
            'gmail',
            `messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(providerId)}`
          ),
          { maxBytes: Math.ceil((maximum * 4) / 3) + 4096 }
        )
      : body;
  const bytes = base64Bytes(data.data, maximum);
  return {
    filename: text(part.filename) || 'attachment',
    contentType: text(part.mimeType) || 'application/octet-stream',
    contentBase64: bytes.toString('base64'),
    sizeBytes: bytes.length
  };
}
