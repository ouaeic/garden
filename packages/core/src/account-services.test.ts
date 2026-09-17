import { describe, expect, it, vi } from 'vitest';
import { AccountApi } from './account-api.js';
import type { AccountOAuth } from './account-oauth.js';
import type { ConnectorTransport } from './connectors.js';
import {
  listAccountMessages,
  readAccountMessage,
  readAccountAttachment,
  listAccountAttachments
} from './account-mail.js';
import { listAccountCalendars, readAccountCalendarRange } from './account-calendar.js';

const response = (body: unknown) => ({
  status: 200,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
  durationMs: 1
});
const connect = (provider: 'google' | 'microsoft', transport: ConnectorTransport) =>
  new AccountApi(
    {
      version: 1,
      provider,
      clientId: 'client',
      clientSecret: 'secret',
      redirectUrl: 'https://garden.example/callback',
      requestedScopes: ['read'],
      tokens: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3600_000,
        scopes: ['read']
      },
      account: { id: 'owner', address: 'owner@example.org' }
    } satisfies AccountOAuth,
    transport
  );
const encode = (text: string) => Buffer.from(text).toString('base64url');
const gmailMessage = {
  id: 'mail-1',
  threadId: 'thread',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'Subject', value: 'Meeting' }],
    parts: [
      { partId: '0', mimeType: 'text/plain', body: { attachmentId: 'external-body', size: 5 } },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: '../report.pdf',
        body: { attachmentId: 'file-pdf', size: 9 }
      }
    ]
  }
};

describe('native mailbox reads', () => {
  it('returns Gmail search metadata and a usable next page without putting attachment data in the transcript', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockResolvedValueOnce(
        response({ messages: [{ id: 'mail-1' }], nextPageToken: 'next', resultSizeEstimate: 2 })
      )
      .mockResolvedValueOnce(response(gmailMessage))
      .mockResolvedValueOnce(response({ messages: [], resultSizeEstimate: 2 }));
    const api = connect('google', transport);
    const page = await listAccountMessages(api, { query: 'from:owner@example.org', limit: 1 });
    expect(page.messages).toMatchObject([{ id: 'mail-1', subject: 'Meeting' }]);
    expect(transport.mock.calls[1]![0].url.searchParams.get('format')).toBe('metadata');
    expect(page.nextCursor).toBeTruthy();
    expect(
      (
        await listAccountMessages(api, {
          query: 'from:owner@example.org',
          limit: 1,
          cursor: page.nextCursor!
        })
      ).nextCursor
    ).toBeNull();
    expect(transport.mock.calls[2]![0].url.searchParams.get('pageToken')).toBe('next');
    expect(JSON.stringify(page)).not.toContain('contentBase64');
  });

  it('loads an external Gmail body, fetches only a selected attachment, and retains its original metadata', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockResolvedValueOnce(response(gmailMessage))
      .mockResolvedValueOnce(response({ data: encode('Hello') }))
      .mockResolvedValueOnce(response(gmailMessage))
      .mockResolvedValueOnce(response({ data: encode('%PDF-test') }));
    const api = connect('google', transport);
    const message = await readAccountMessage(api, { id: 'mail-1' });
    expect(message).toMatchObject({
      body: 'Hello',
      bodyTruncated: false,
      attachments: [{ filename: '../report.pdf', sizeBytes: 9 }]
    });
    const attachment = (message.attachments as Array<{ partId: string }>)[0]!;
    expect(transport).toHaveBeenCalledTimes(2);
    const file = await readAccountAttachment(api, { id: 'mail-1', partId: attachment.partId });
    expect(Buffer.from(file.contentBase64, 'base64').toString()).toBe('%PDF-test');
    expect(file.filename).toBe('../report.pdf');
    expect(transport.mock.calls[3]![0].url.pathname).toBe(
      '/gmail/v1/users/me/messages/mail-1/attachments/file-pdf'
    );
    expect(JSON.stringify(message)).not.toContain('%PDF-test');
  });

  it('exposes oversized body parts as downloads rather than claiming the message was empty', async () => {
    const transport = vi.fn<ConnectorTransport>().mockResolvedValue(
      response({
        ...gmailMessage,
        payload: { mimeType: 'text/plain', body: { size: 4_000_000, attachmentId: 'large-body' } }
      })
    );
    const result = await readAccountMessage(connect('google', transport), { id: 'mail-1' });
    expect(result).toMatchObject({
      bodyTruncated: true,
      attachments: [{ filename: 'message.txt', sizeBytes: 4_000_000 }]
    });
    expect(result.bodyNotice).toContain('not loaded');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('finds Graph inline attachments even when hasAttachments is false and keeps paging on the same message', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockResolvedValueOnce(
        response({
          id: 'mail-1',
          body: { contentType: 'html', content: '<p>Hello <b>world</b></p>' },
          hasAttachments: false
        })
      )
      .mockResolvedValueOnce(
        response({
          value: [
            {
              id: 'inline',
              name: 'image.png',
              isInline: true,
              '@odata.type': '#microsoft.graph.fileAttachment'
            }
          ],
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/me/messages/mail-1/attachments?$skiptoken=next'
        })
      )
      .mockResolvedValueOnce(response({ value: [] }));
    const api = connect('microsoft', transport);
    const result = await readAccountMessage(api, { id: 'mail-1' });
    expect(result.body).toContain('Hello world');
    expect(result.attachments).toMatchObject([{ partId: 'inline', inline: true }]);
    expect(result.nextCursor).toBeTruthy();
    await listAccountAttachments(api, 'mail-1', result.nextCursor!);
    expect(transport.mock.calls[2]![0].url.searchParams.get('$skiptoken')).toBe('next');
  });

  it('refuses to follow reference attachments or download a different Gmail message part', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockResolvedValueOnce(
        response({
          id: 'link',
          '@odata.type': '#microsoft.graph.referenceAttachment',
          sourceUrl: 'https://attacker.invalid/file'
        })
      )
      .mockResolvedValueOnce(response(gmailMessage));
    await expect(
      readAccountAttachment(connect('microsoft', transport), { id: 'mail', partId: 'link' })
    ).rejects.toThrow('governed browser');
    await expect(
      readAccountAttachment(connect('google', transport), {
        id: 'mail-1',
        partId: `attachment:${encode('other-file')}`
      })
    ).rejects.toThrow('no longer belongs');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('lists Gmail parts without fetching their external bodies and rejects an unrelated cursor', async () => {
    const transport = vi.fn<ConnectorTransport>().mockResolvedValue(response(gmailMessage));
    const api = connect('google', transport);
    const result = await listAccountAttachments(api, 'mail-1');
    expect(result.attachments).toMatchObject([
      { filename: 'message.txt', sizeBytes: 5 },
      { filename: '../report.pdf', sizeBytes: 9 }
    ]);
    expect(result.nextCursor).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(listAccountAttachments(api, 'mail-1', 'other-page')).rejects.toThrow('cursor');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not turn malformed pages, mismatched messages or missing attachment bytes into success', async () => {
    const transport = vi.fn<ConnectorTransport>().mockResolvedValue(response({}));
    await expect(listAccountMessages(connect('microsoft', transport), {})).rejects.toThrow();
    await expect(
      listAccountAttachments(connect('microsoft', transport), 'mail-1')
    ).rejects.toThrow();
    transport.mockResolvedValue(response({ ...gmailMessage, id: 'other-message' }));
    await expect(
      readAccountMessage(connect('google', transport), { id: 'mail-1' })
    ).rejects.toThrow('different message');
    transport
      .mockResolvedValueOnce(response(gmailMessage))
      .mockResolvedValueOnce(response({ size: 9 }));
    await expect(
      readAccountAttachment(connect('google', transport), {
        id: 'mail-1',
        partId: `attachment:${encode('file-pdf')}`
      })
    ).rejects.toThrow('omitted');
  });

  it('waits for an in-flight metadata batch before reporting its failed member', async () => {
    let finish: (() => void) | undefined;
    const transport = vi.fn<ConnectorTransport>(async ({ url }) => {
      if (url.pathname.endsWith('/messages'))
        return response({ messages: [{ id: 'bad' }, { id: 'slow' }] });
      if (url.pathname.endsWith('/bad')) throw new Error('Metadata failed');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return response({ ...gmailMessage, id: 'slow' });
    });
    let settled = false;
    const result = listAccountMessages(connect('google', transport), {}).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(settled).toBe(false);
    finish!();
    expect(String(await result)).toContain('Metadata failed');
    expect(settled).toBe(true);
  });
});

describe('native calendar reads', () => {
  it.each(['google', 'microsoft'] as const)(
    'preserves %s dates, zones and recurring instances across a DST range and opaque pages',
    async (provider) => {
      const event =
        provider === 'google'
          ? {
              id: 'event-1',
              summary: 'DST',
              start: { date: '2026-10-25' },
              end: { date: '2026-10-26' }
            }
          : {
              id: 'event-1',
              subject: 'DST',
              start: { dateTime: '2026-10-25T01:30:00', timeZone: 'UTC' },
              end: { dateTime: '2026-10-25T02:30:00', timeZone: 'UTC' },
              seriesMasterId: 'series'
            };
      const transport = vi
        .fn<ConnectorTransport>()
        .mockResolvedValueOnce(
          response(
            provider === 'google'
              ? { items: [event], nextPageToken: 'next', timeZone: 'Europe/Berlin' }
              : {
                  value: [event],
                  '@odata.nextLink':
                    'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=next'
                }
          )
        )
        .mockResolvedValueOnce(response(provider === 'google' ? { items: [] } : { value: [] }));
      const api = connect(provider, transport),
        input = { start: '2026-10-25T01:00:00+02:00', end: '2026-10-25T04:00:00+01:00', limit: 1 };
      const first = await readAccountCalendarRange(api, input);
      expect(first.events).toEqual([event]);
      expect(first.range).toEqual({ start: input.start, end: input.end });
      const url = transport.mock.calls[0]![0].url;
      expect(url.searchParams.get(provider === 'google' ? 'timeMin' : 'startDateTime')).toBe(
        input.start
      );
      expect(url.searchParams.get(provider === 'google' ? 'timeMax' : 'endDateTime')).toBe(
        input.end
      );
      expect(
        (await readAccountCalendarRange(api, { ...input, cursor: first.nextCursor! })).events
      ).toEqual([]);
      expect(
        transport.mock.calls[1]![0].url.searchParams.get(
          provider === 'google' ? 'pageToken' : '$skiptoken'
        )
      ).toBe('next');
    }
  );

  it('refuses ambiguous or backwards time ranges before making a request', async () => {
    const transport = vi.fn<ConnectorTransport>(),
      api = connect('google', transport);
    await expect(
      readAccountCalendarRange(api, { start: '2026-10-25T01:30:00', end: '2026-10-25T04:00:00Z' })
    ).rejects.toThrow();
    await expect(
      readAccountCalendarRange(api, { start: '2026-10-25T04:00:00Z', end: '2026-10-25T01:00:00Z' })
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('lists calendar identities without silently dropping another page', async () => {
    const transport = vi.fn<ConnectorTransport>().mockResolvedValue(
      response({
        items: [{ id: 'owner@example.org', summary: 'Owner', timeZone: 'Europe/Berlin' }],
        nextPageToken: 'later'
      })
    );
    const result = await listAccountCalendars(connect('google', transport));
    expect(result.calendars).toHaveLength(1);
    expect(result.nextCursor).toBeTruthy();
  });
});
