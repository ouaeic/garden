import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AccountApi } from './account-api.js';
import { executeAccountConnector } from './account-connectors.js';
import { composeAccountMail, MailCheckpoint } from './account-mail-compose.js';
import type { AccountOperation } from './account-operation.js';
import type { ConnectorTransport } from './connector-transport.js';
import type { ConnectorScope } from '@athanor/contracts';

const response = (body: unknown, status = 200) => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
  durationMs: 1
});
const scopes: ConnectorScope[] = ['mail:mailbox.read', 'mail:message.write', 'mail:message.send'];
const input = {
  to: [{ address: 'recipient@example.org' }],
  cc: [{ address: 'copy@example.org' }],
  bcc: [{ address: 'private@example.org' }],
  subject: 'Plans',
  text: 'Here are the plans.'
};
const uploadUrl =
  "https://outlook.office.com/api/v2.0/Users('owner')/Messages('draft')/AttachmentSessions('upload')?authtoken=PRIVATE_UPLOAD_TOKEN";
function fixture(provider: 'google' | 'microsoft', transport: ConnectorTransport) {
  const state: { recovery: unknown; result: unknown; completed: boolean } = {
    recovery: null,
    result: null,
    completed: false
  };
  const operation: AccountOperation = {
    id: randomUUID(),
    signal: new AbortController().signal,
    get recovery() {
      return state.recovery;
    },
    get result() {
      return state.result;
    },
    get completed() {
      return state.completed;
    },
    checkpoint: vi.fn(async (value) => {
      state.recovery = structuredClone(value);
    }),
    complete: vi.fn(async (value) => {
      state.result = structuredClone(value);
      state.completed = true;
    })
  };
  const api = new AccountApi(
    {
      version: 1,
      provider,
      clientId: 'client',
      clientSecret: 'CLIENT_CANARY',
      redirectUrl: 'https://garden.example/callback',
      requestedScopes: ['mail'],
      tokens: {
        accessToken: 'ACCESS_CANARY',
        refreshToken: 'REFRESH_CANARY',
        expiresAt: Date.now() + 3600000,
        scopes: ['mail']
      },
      account: { id: 'owner', address: 'owner@example.org' }
    },
    transport,
    operation.signal
  );
  return {
    state,
    operation,
    api,
    run: (value: unknown = input, mode: 'draft' | 'send' = 'send', access = scopes) =>
      composeAccountMail(api, value, mode, operation, access)
  };
}
function remoteDraft(body: Record<string, unknown>) {
  return {
    ...body,
    id: 'draft',
    isDraft: true,
    body: { contentType: 'text', content: input.text }
  };
}

describe('recoverable native mail composition', () => {
  it.each(['account_mail_draft', 'account_mail_send'] as const)(
    'routes %s through the granted account and requires durable receipts',
    async (action) => {
      const transport = vi
        .fn<ConnectorTransport>()
        .mockResolvedValue(
          response(
            action === 'account_mail_draft'
              ? { id: 'draft', message: { id: 'message' } }
              : { id: 'message' }
          )
        );
      const f = fixture('google', transport);
      const request = {
        kind: 'google' as const,
        baseUrl: 'https://gmail.googleapis.com',
        scopes,
        secret: { accountOAuth: f.api.secret },
        action: { ...input, action },
        allowedHostSuffixes: []
      };
      await expect(executeAccountConnector(request, transport)).rejects.toThrow(
        'durable operation receipt'
      );
      expect(transport).not.toHaveBeenCalled();
      await expect(
        executeAccountConnector({ ...request, operation: f.operation }, transport)
      ).resolves.toMatchObject({
        action,
        result: { status: action === 'account_mail_send' ? 'accepted' : 'drafted' }
      });
      expect(transport).toHaveBeenCalledOnce();
    }
  );

  it.each(['draft', 'send'] as const)(
    'submits a Gmail %s with stable identity, Bcc and MIME attachments, then reuses its receipt',
    async (mode) => {
      const transport = vi.fn<ConnectorTransport>(async (request) => {
        expect(f.state.recovery).toMatchObject({ operationId: f.operation.id, phase: 'creating' });
        const body = JSON.parse(Buffer.from(request.body!).toString()) as {
          raw: string;
          message: { raw: string };
          contentId: string;
          contentBytes: string;
        };
        const raw = Buffer.from(
          mode === 'draft' ? body.message.raw : body.raw,
          'base64url'
        ).toString();
        expect(raw).toContain(`Message-ID: <${f.operation.id}@example.org>`);
        expect(raw).toContain('Bcc: private@example.org');
        expect(raw).toContain('filename="plans.txt"');
        expect(raw).toContain(Buffer.from('attachment').toString('base64'));
        return response(
          mode === 'draft' ? { id: 'draft', message: { id: 'message' } } : { id: 'message' }
        );
      });
      const f = fixture('google', transport);
      const value = {
        ...input,
        attachments: [
          { filename: 'plans.txt', contentBase64: Buffer.from('attachment').toString('base64') }
        ]
      };
      const result = await f.run(value, mode);
      expect(result.status).toBe(mode === 'draft' ? 'drafted' : 'accepted');
      await expect(f.run(value, mode)).resolves.toEqual(result);
      expect(transport).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toMatch(/CANARY|attachment/);
    }
  );

  it.each(['draft', 'send'] as const)(
    'recovers a Gmail %s after a lost acknowledgment without another POST',
    async (mode) => {
      const transport = vi
        .fn<ConnectorTransport>()
        .mockRejectedValueOnce(new Error('lost reply'))
        .mockImplementation(async (request) => {
          expect(request.method).toBe('GET');
          expect(request.url.searchParams.get('q')).toContain(
            `rfc822msgid:<${f.operation.id}@example.org>`
          );
          return response(
            mode === 'draft'
              ? { drafts: [{ id: 'draft', message: { id: 'message' } }] }
              : { messages: [{ id: 'message' }] }
          );
        });
      const f = fixture('google', transport);
      await expect(f.run(input, mode)).resolves.toMatchObject({ status: 'uncertain' });
      await expect(f.run(input, mode)).resolves.toMatchObject({
        recovered: true,
        messageId: 'message'
      });
      expect(transport.mock.calls.map(([call]) => call.method)).toEqual(['POST', 'GET']);
    }
  );

  it('does not repeat an uncertain Gmail send when search is empty, or reuse intent for changed recipients', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockRejectedValueOnce(new Error('lost reply'))
      .mockResolvedValue(response({ messages: [] }));
    const f = fixture('google', transport);
    await f.run();
    await expect(f.run()).resolves.toMatchObject({ status: 'uncertain' });
    await expect(f.run({ ...input, to: [{ address: 'different@example.org' }] })).rejects.toThrow(
      'different content'
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(f.operation.complete).not.toHaveBeenCalled();
  });

  it('retries a definitively rejected Gmail request after surfacing its provider error', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockResolvedValueOnce(response({}, 429))
      .mockResolvedValueOnce(response({ id: 'accepted' }));
    const f = fixture('google', transport);
    await expect(f.run()).rejects.toMatchObject({ code: 'connector_rate_limited' });
    expect(MailCheckpoint.parse(f.state.recovery).phase).toBe('prepared');
    await expect(f.run()).resolves.toMatchObject({ status: 'accepted' });
    expect(transport.mock.calls.map(([call]) => call.method)).toEqual(['POST', 'POST']);
  });

  it('requires all granted capabilities before opening a mailbox', async () => {
    const transport = vi.fn<ConnectorTransport>();
    const f = fixture('microsoft', transport);
    await expect(f.run(input, 'send', ['mail:message.send'])).rejects.toThrow('mail:mailbox.read');
    await expect(f.run(input, 'send', ['mail:message.send', 'mail:mailbox.read'])).rejects.toThrow(
      'mail:message.write'
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('creates and sends a Microsoft draft only after checking exact recipients and body', async () => {
    let draft: Record<string, unknown>;
    const transport = vi.fn<ConnectorTransport>(async (request) => {
      expect(request.headers.prefer).toContain('ImmutableId');
      if (request.method === 'POST' && request.url.pathname.endsWith('/messages')) {
        draft = remoteDraft(
          JSON.parse(Buffer.from(request.body!).toString()) as Record<string, unknown>
        );
        expect(draft.bccRecipients).toEqual([{ emailAddress: { address: 'private@example.org' } }]);
        expect(f.state.recovery).toMatchObject({ phase: 'creating' });
        return response(draft, 201);
      }
      if (request.method === 'GET') return response(draft);
      expect(request.url.pathname).toMatch(/\/draft\/send$/);
      expect(f.state.recovery).toMatchObject({ phase: 'sending' });
      return response({}, 202);
    });
    const f = fixture('microsoft', transport);
    const result = await f.run();
    expect(result).toMatchObject({ status: 'accepted', messageId: 'draft' });
    await expect(f.run()).resolves.toEqual(result);
    expect(transport.mock.calls.map(([call]) => call.method)).toEqual(['POST', 'GET', 'POST']);
  });

  it('recovers Microsoft creation by operation property and a lost send by immutable message identity', async () => {
    let draft: Record<string, unknown>;
    let sent = false;
    const transport = vi.fn<ConnectorTransport>(async (request) => {
      if (request.method === 'POST') {
        if (request.url.pathname.endsWith('/send')) sent = true;
        else
          draft = remoteDraft(
            JSON.parse(Buffer.from(request.body!).toString()) as Record<string, unknown>
          );
        throw new Error('lost mutation reply');
      }
      if (request.url.searchParams.has('$filter')) {
        expect(request.url.searchParams.get('$filter')).toContain(f.operation.id);
        return response({ value: [draft] });
      }
      return response(
        sent ? { id: 'draft', isDraft: false, sentDateTime: '2026-09-27T12:00:00Z' } : draft
      );
    });
    const f = fixture('microsoft', transport);
    await expect(f.run()).resolves.toMatchObject({ status: 'uncertain' });
    await expect(f.run()).resolves.toMatchObject({ status: 'uncertain' });
    await expect(f.run()).resolves.toMatchObject({ status: 'accepted', recovered: true });
    expect(transport.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(2);
  });

  it('refuses to send a provider draft with changed recipients', async () => {
    let draft: Record<string, unknown>;
    const transport = vi.fn<ConnectorTransport>(async (request) => {
      if (request.method === 'POST') {
        draft = remoteDraft(
          JSON.parse(Buffer.from(request.body!).toString()) as Record<string, unknown>
        );
        return response(draft, 201);
      }
      return response({
        ...draft,
        toRecipients: [{ emailAddress: { address: 'unexpected@example.org' } }]
      });
    });
    const f = fixture('microsoft', transport);
    await expect(f.run()).rejects.toThrow('differs from the requested message');
    expect(
      transport.mock.calls.filter(([call]) => call.url.pathname.endsWith('/send'))
    ).toHaveLength(0);
  });

  it.each([10, 3_200_000])(
    'attaches %i bytes to a Microsoft draft with bounded provider uploads',
    async (length) => {
      const bytes = Buffer.alloc(length, 42);
      let uploaded = 0;
      const transport = vi.fn<ConnectorTransport>(async (request) => {
        if (request.url.pathname.endsWith('/messages')) return response({ id: 'draft' }, 201);
        expect(f.state.recovery).toMatchObject({ phase: 'attaching', attachment: 0 });
        if (request.url.pathname.endsWith('/createUploadSession'))
          return response(
            { uploadUrl, expirationDateTime: new Date(Date.now() + 3600000).toISOString() },
            201
          );
        if (request.method === 'PUT') {
          expect(request.headers.authorization).toBeUndefined();
          expect(
            Buffer.from(request.body!).equals(
              bytes.subarray(uploaded, uploaded + request.body!.length)
            )
          ).toBe(true);
          expect(request.headers['content-range']).toBe(
            `bytes ${uploaded}-${uploaded + request.body!.length - 1}/${length}`
          );
          uploaded += request.body!.length;
          return response(
            uploaded === length ? {} : { nextExpectedRanges: [String(uploaded)] },
            uploaded === length ? 201 : 200
          );
        }
        const body = JSON.parse(Buffer.from(request.body!).toString()) as {
          raw: string;
          message: { raw: string };
          contentId: string;
          contentBytes: string;
        };
        expect(body.contentId).toBe(`${f.operation.id}.0@garden`);
        expect(Buffer.from(body.contentBytes, 'base64')).toEqual(bytes);
        return response({ id: 'file' }, 201);
      });
      const f = fixture('microsoft', transport);
      const result = await f.run(
        {
          ...input,
          attachments: [{ filename: 'data.bin', contentBase64: bytes.toString('base64') }]
        },
        'draft'
      );
      expect(result.status).toBe('drafted');
      expect(JSON.stringify(result)).not.toContain('PRIVATE_UPLOAD_TOKEN');
      expect(MailCheckpoint.parse(f.state.recovery)).toMatchObject({
        attachment: 1,
        phase: 'attachments'
      });
      if (length >= 3_000_000) expect(uploaded).toBe(length);
    }
  );

  it('reconciles an attachment after a lost final reply using its content identity and bytes', async () => {
    const bytes = Buffer.from('file content');
    const transport = vi.fn<ConnectorTransport>(async (request) => {
      if (request.url.pathname.endsWith('/messages')) return response({ id: 'draft' }, 201);
      if (request.method === 'POST') throw new Error('lost attachment reply');
      if (request.url.pathname.endsWith('/$value')) return { ...response({}), body: bytes };
      return response({ value: [{ id: 'file', contentId: `${f.operation.id}.0@garden` }] });
    });
    const f = fixture('microsoft', transport);
    const value = {
      ...input,
      attachments: [{ filename: 'file.txt', contentBase64: bytes.toString('base64') }]
    };
    await expect(f.run(value, 'draft')).resolves.toMatchObject({ status: 'uncertain' });
    await expect(f.run(value, 'draft')).resolves.toMatchObject({ status: 'drafted' });
    expect(transport.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(2);
  });

  it('rejects upload capabilities outside the fixed Microsoft endpoint without leaking them', async () => {
    const transport = vi.fn<ConnectorTransport>();
    const f = fixture('microsoft', transport);
    for (const value of [
      uploadUrl.replace('outlook.office.com', 'evil.example'),
      uploadUrl.replace('/Messages', '/Events'),
      `${uploadUrl}#secret`
    ])
      await expect(f.api.uploadMailRange(value, Buffer.from('x'), 0, 1)).rejects.toThrow(
        'capability or byte range'
      );
    expect(transport).not.toHaveBeenCalled();
  });
});
