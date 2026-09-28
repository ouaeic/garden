import { describe, expect, it } from 'vitest';
import type { PendingDestinationRow } from '@garden/data';
import type { NotificationSubject } from '../model.js';
import { TransportError } from '../transport.js';
import { createTelegramTransport, newNonce } from './send.js';

const approvalId = '6f1a9d2e-4c3b-4e8a-9f0d-1b2c3d4e5f60';
const token = '1000:bot-secret-of-thirty-five-characters-x';

const row = (overrides: Partial<PendingDestinationRow> = {}): PendingDestinationRow => ({
  transport: 'telegram',
  id: 'destination-1',
  userId: 'owner',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  senderId: '4242',
  redact: true,
  config: { botToken: token, botUsername: 'garden_bot' },
  kind: 'approval_required',
  resourceId: approvalId,
  taskId: 'task-1',
  taskStatus: 'awaiting_user',
  eventAt: '2026-07-31T12:00:00.000Z',
  taskTitle: 'Reconcile the March invoices',
  message: null,
  ...overrides
});

const subject = (overrides: Partial<NotificationSubject> = {}): NotificationSubject => ({
  kind: 'approval_required',
  taskId: 'task-1',
  resourceId: approvalId,
  taskTitle: 'Reconcile the March invoices',
  taskStatus: 'awaiting_user',
  approvalAction: 'shell',
  approvalSideEffect: 'external_consequential',
  message: null,
  approvalExpired: false,
  spentUsd: null,
  capUsd: null,
  durationMs: null,
  ...overrides
});

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

/** A bot API that accepts everything and records it, or refuses with the envelope handed in. */
const harness = (refuse?: { status: number; envelope: Record<string, unknown> }) => {
  const sent: Sent[] = [];
  const warned: string[] = [];
  const asked: string[] = [];
  const transport = createTelegramTransport({
    baseUrl: 'https://bot-api.test',
    appUrl: 'https://ai.example.test',
    awaitingAnswer: async (item) => {
      asked.push(item.taskId);
      return true;
    },
    nonce: () => 'nonce-01',
    warn: (line) => void warned.push(line),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: input instanceof Request ? input.url : input.toString(),
        body:
          typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      });
      if (refuse)
        return new Response(JSON.stringify(refuse.envelope), {
          status: refuse.status,
          headers: { 'content-type': 'application/json' }
        });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 512 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch
  });
  return { transport, sent, warned, asked };
};

describe('the phone transport, outbound', () => {
  it('sends one message to the paired sender with previews off and forwarding protected, and hands back the message id and the nonce', async () => {
    const { transport, sent } = harness();
    const delivered = await transport.send(row(), subject(), undefined as never);
    expect(delivered).toEqual({ externalRef: '512', nonce: 'nonce-01' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://bot-api.test/bot${token}/sendMessage`);
    expect(sent[0]!.body).toMatchObject({
      chat_id: '4242',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      protect_content: true
    });
    // The buttons carry the approval and the nonce the ledger will hold, nothing else.
    const keyboard = (sent[0]!.body.reply_markup as { inline_keyboard: unknown[][] })
      .inline_keyboard;
    expect(keyboard[0]).toEqual([
      { text: 'Approve', callback_data: `a:${approvalId}:y:nonce-01` },
      { text: 'Deny', callback_data: `a:${approvalId}:n:nonce-01` }
    ]);
    expect(sent[0]!.body.disable_notification).toBeUndefined();
  });

  it('carries no nonce for anything but an approval, and lets a receipt arrive silently', async () => {
    const { transport, sent } = harness();
    const delivered = await transport.send(
      row({ kind: 'task_finished', resourceId: 'task-1', taskStatus: 'completed' }),
      subject({ kind: 'task_finished', resourceId: 'task-1', taskStatus: 'completed' }),
      undefined as never
    );
    expect(delivered).toEqual({ externalRef: '512' });
    expect(sent[0]!.body.disable_notification).toBe(true);
  });

  it('asks whether the conversation is waiting for words only for an agent notice, and then asks for a reply', async () => {
    const { transport, sent, asked } = harness();
    await transport.send(row(), subject(), undefined as never);
    expect(asked).toEqual([]);
    await transport.send(
      row({ kind: 'agent_message', resourceId: 'notice-1', message: 'Which account?' }),
      subject({ kind: 'agent_message', resourceId: 'notice-1', message: 'Which account?' }),
      undefined as never
    );
    expect(asked).toEqual(['task-1']);
    expect(sent[1]!.body.reply_markup).toMatchObject({ force_reply: true });
  });

  it('sends the title and the link only while redaction is on, and the body once it is off', async () => {
    const { transport, sent } = harness();
    const question = subject({
      kind: 'agent_message',
      resourceId: 'notice-1',
      message: 'Which account should the refund go to?'
    });
    const notice = row({
      kind: 'agent_message',
      resourceId: 'notice-1',
      message: question.message
    });
    await transport.send(notice, question, undefined as never);
    await transport.send({ ...notice, redact: false }, question, undefined as never);
    expect(String(sent[0]!.body.text)).not.toContain('refund');
    expect(String(sent[0]!.body.text)).toContain('Reconcile the March invoices');
    expect(String(sent[1]!.body.text)).toContain('refund');
  });

  it('refuses a row it cannot address without calling anything, and never a row for a device', async () => {
    const { transport, sent } = harness();
    await expect(
      transport.send(row({ config: null }), subject(), undefined as never)
    ).rejects.toThrow(TransportError);
    await expect(
      transport.send(row({ senderId: null }), subject(), undefined as never)
    ).rejects.toThrow(TransportError);
    await expect(
      transport.send(
        { ...row(), transport: 'push' } as unknown as PendingDestinationRow,
        subject(),
        undefined as never
      )
    ).rejects.toThrow(/device/);
    expect(sent).toEqual([]);
  });

  it('reads a rate limit as the wait the far end named, with the token in nothing it throws', async () => {
    const { transport } = harness({
      status: 429,
      envelope: {
        ok: false,
        error_code: 429,
        description: `Too Many Requests: retry after 7 at https://bot-api.test/bot${token}/sendMessage`,
        parameters: { retry_after: 7 }
      }
    });
    const failure: unknown = await transport
      .send(row(), subject(), undefined as never)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).statusCode).toBe(429);
    expect((failure as TransportError).retryAfterMs).toBe(7_000);
    expect((failure as Error).message).not.toContain(token);
  });
});

describe('newNonce', () => {
  it('is eight URL-safe characters and differs between calls', () => {
    const one = newNonce();
    expect(one).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(newNonce()).not.toBe(one);
  });
});
