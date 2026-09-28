import { randomBytes } from 'node:crypto';
import type { PendingDestinationRow } from '@garden/data';
import { notificationPayload } from '../payload.js';
import { TransportError, type Transport } from '../transport.js';
import { createTelegramClient } from './client.js';
import { renderMessage } from './render.js';

/** Eight URL-safe characters: 48 bits, which a tap has one chance at and a ledger row holds. */
export const newNonce = (): string => randomBytes(6).toString('base64url');

export interface TelegramTransportInput {
  baseUrl: string;
  appUrl: string;
  /**
   * Whether the conversation an agent notice belongs to is parked waiting for the owner's words
   * with no approval card standing - the one case where the message asks for a reply rather than
   * offering a link. Asked of the store by the caller, so this module can be tested without one.
   */
  awaitingAnswer: (row: PendingDestinationRow) => Promise<boolean>;
  fetch?: typeof fetch;
  warn?: (line: string) => void;
  nonce?: () => string;
}

/**
 * The phone transport's outbound half: one `sendMessage` per pending row, addressed to the sender
 * the owner paired, with previews off and forwarding protected on every send.
 */
export const createTelegramTransport = (input: TelegramTransportInput): Transport => ({
  kind: 'telegram',
  send: async (row, subject) => {
    if (row.transport !== 'telegram')
      throw new Error('The phone transport was handed a row for a device');
    // Both are checked by the sweep before it gets here; a throw is the honest answer if one slips
    // past, and neither is the far end's doing, so neither counts against it.
    if (!row.config)
      throw new TransportError('The destination configuration could not be read', {
        statusCode: 0
      });
    if (!row.senderId) throw new TransportError('The destination is not paired', { statusCode: 0 });
    const payload = notificationPayload(subject);
    const nonce = subject.kind === 'approval_required' ? (input.nonce ?? newNonce)() : undefined;
    const awaitingAnswer =
      subject.kind === 'agent_message' ? await input.awaitingAnswer(row) : false;
    const rendered = renderMessage({
      payload,
      appUrl: input.appUrl,
      redact: row.redact,
      ...(nonce ? { nonce } : {}),
      awaitingAnswer
    });
    const client = createTelegramClient({
      baseUrl: input.baseUrl,
      token: row.config.botToken,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.warn ? { warn: input.warn } : {})
    });
    const sent = await client.call<{ message_id: number }>('sendMessage', {
      // The private chat with the paired sender has the sender's own id. Nothing else is ever
      // sent to, which is also why a card can never land in a group.
      chat_id: row.senderId,
      text: rendered.text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      protect_content: true,
      reply_markup: rendered.reply_markup,
      ...(rendered.disable_notification ? { disable_notification: true } : {})
    });
    return { externalRef: String(sent.message_id), ...(nonce ? { nonce } : {}) };
  }
});
