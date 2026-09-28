import { createHash, timingSafeEqual } from 'node:crypto';
import type { DataStore, NotificationDestinationConfig } from '@garden/data';
import type { EndpointHealth } from '../retry.js';
import { transportFailure } from '../transport.js';
import type { TelegramClient } from './client.js';
import { escapeHtml, openUrl, outcomeLabel, outcomeMarkup, parseCallbackData } from './render.js';

/*
 * The shapes read off an update. Only the fields this handler looks at are named; the service
 * sends far more, and none of it is trusted beyond what is checked here.
 */
export interface TelegramUser {
  id: number;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/**
 * How many refusals in a row are written to the owner's security record before they are counted
 * rather than recorded, and how quickly the allowance comes back. The bot is findable by its
 * username by anyone on the service, so this is the one inbound surface open to everyone; without
 * a ceiling a stranger sending `/start` in a loop appends to the owner's record, the database and
 * the journal for as long as they care to. Twenty is more than an owner produces by fumbling a
 * pairing, and one every five minutes keeps a flood that never stops under three hundred rows a
 * day. Nothing here changes what is refused - every refusal is still refused.
 */
export const REJECTION_BURST = 20;
export const REJECTION_REFILL_MS = 5 * 60_000;

interface RejectionBudget {
  tokens: number;
  refilledAt: number;
  /** Refusals since the last one that was written, carried onto the next that is. */
  suppressed: number;
}

/**
 * The destination as the poller holds it. `senderId` is a snapshot, written here on a successful
 * pairing so the very next tap from that phone is accepted without waiting for the supervisor to
 * re-read - and it is only ever the first gate. Every decision is also checked against the sender
 * the row holds at that moment, because a snapshot is what a replaced phone would still pass.
 */
export interface DestinationState {
  id: string;
  userId: string;
  senderId: string | null;
  config: NotificationDestinationConfig;
  rejections?: RejectionBudget;
}

export interface InboundInput {
  store: DataStore;
  client: TelegramClient;
  destination: DestinationState;
  /** Opens the paired sender on the rows the store hands back; it is sealed like the token. */
  masterKey: Uint8Array;
  appUrl: string;
  /** The box's own API on loopback, for posting an answer to the route the web client uses. */
  apiBaseUrl: string;
  fetch?: typeof fetch;
  warn?: (line: string) => void;
  now?: () => Date;
}

export type InboundOutcome =
  | 'decided'
  | 'already_decided'
  | 'paired'
  | 'answered'
  | 'failed'
  | 'rejected'
  | 'ignored';

const bestEffort = (work: Promise<unknown>): Promise<void> =>
  work.then(
    () => undefined,
    () => undefined
  );

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Equal length and equal bytes, in constant time; anything else is simply not equal. */
const sameSecret = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The longest prompt the task message route accepts. */
const MAX_ANSWER_CHARS = 200_000;

interface OutcomeInput {
  store: DataStore;
  client: TelegramClient;
  appUrl: string;
  destinationId: string;
  chatId: number | string;
  messageId: number | string;
  /** The card's current text, when the update carried it; the outcome is appended to it. */
  text?: string | undefined;
  taskId: string;
  resourceId: string;
  status: string;
  source: 'phone' | 'elsewhere';
  now: Date;
}

/**
 * The decision, written onto the card itself: the Approve and Deny buttons go, and the outcome
 * takes their place as the one button that remains. This is the same edit whichever way the
 * decision arrived - a tap on the phone, a click in the web client, the command line, the
 * deadline - so a card can never be tapped twice and never shows a question that has been
 * answered. The ledger row is marked once the edit is made, and only then.
 */
export const writeCardOutcome = async (input: OutcomeInput): Promise<void> => {
  const label = outcomeLabel(input.status, input.source, input.now);
  const url = openUrl(input.appUrl, `/?task=${encodeURIComponent(input.taskId)}`);
  const replyMarkup = outcomeMarkup(url, label);
  const edited =
    input.text !== undefined
      ? await input.client
          .call('editMessageText', {
            chat_id: input.chatId,
            message_id: input.messageId,
            text: `${escapeHtml(input.text)}\n\n${label}`,
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: replyMarkup
          })
          .then(
            () => true,
            () => false
          )
      : false;
  if (!edited)
    await input.client.call('editMessageReplyMarkup', {
      chat_id: input.chatId,
      message_id: input.messageId,
      reply_markup: replyMarkup
    });
  await input.store.markDestinationDeliveryOutcome(
    input.destinationId,
    'approval_required',
    input.resourceId
  );
};

/**
 * Cards on the phone whose approval was decided somewhere else, each written back once. This is
 * the half of the outcome edit that does not start from a tap.
 *
 * It runs inside the same loop pass as the send sweep and ahead of the next one, so a bot API
 * that is refusing is consulted here through the same wait the send keeps: a destination inside
 * its backoff is skipped without a call, and a refusal here starts or extends that wait exactly as
 * a refused send does. Without that, every decided card cost one full call timeout per pass while
 * the far end was down, serialised in front of every push notification on the box.
 */
export const sweepCardOutcomes = async (input: {
  store: DataStore;
  masterKey: Uint8Array;
  appUrl: string;
  clientFor: (destinationId: string) => TelegramClient | null;
  endpoints: EndpointHealth;
  warn?: (line: string) => void;
  now?: () => Date;
}): Promise<number> => {
  const warn = input.warn ?? ((line: string) => void process.stderr.write(line));
  const clock = input.now ?? (() => new Date());
  const rows = await input.store
    .listDestinationDeliveriesAwaitingOutcome(100, input.masterKey)
    .catch(() => []);
  let written = 0;
  for (const row of rows) {
    const client = input.clientFor(row.destinationId);
    // No poller holds this destination - unreadable configuration, or a destination switched off
    // since the card was sent. The row waits; nothing is marked that was not written.
    if (!client || !row.externalRef || !row.senderId || !row.taskId || !row.approvalStatus)
      continue;
    if (input.endpoints.waiting(row.destinationId, clock())) continue;
    try {
      await writeCardOutcome({
        store: input.store,
        client,
        appUrl: input.appUrl,
        destinationId: row.destinationId,
        chatId: row.senderId,
        messageId: row.externalRef,
        taskId: row.taskId,
        resourceId: row.resourceId,
        status: row.approvalStatus,
        source: 'elsewhere',
        now: clock()
      });
      written += 1;
      input.endpoints.succeeded(row.destinationId);
    } catch (error) {
      const { statusCode, retryAfterMs } = transportFailure(error);
      const reason = error instanceof Error ? error.message : String(error);
      if (statusCode === 400) {
        // The far end answered, and the answer is about this message rather than about the
        // service: deleted on the phone, or already showing what was to be written. Nothing more
        // can reach it, so the row is closed rather than tried again every pass for a fortnight,
        // and the destination is held to nothing.
        await bestEffort(
          input.store.markDestinationDeliveryOutcome(
            row.destinationId,
            'approval_required',
            row.resourceId
          )
        );
        warn(
          `garden-notifications: notification.destination_outcome_unwritable destination=${row.destinationId} the card cannot be edited and will not be tried again: ${reason}\n`
        );
        continue;
      }
      input.endpoints.failed(row.destinationId, statusCode, clock(), retryAfterMs);
      warn(
        `garden-notifications: notification.destination_outcome_failed destination=${row.destinationId} ${reason}\n`
      );
    }
  }
  return written;
};

/**
 * One update from the phone, and what became of it.
 *
 * Three things can arrive: a tap on an approval card, the `/start` that completes a pairing, and
 * a reply to a question the agent asked. Everything is checked against the sender the owner
 * paired - the numeric `from.id`, never a username and never the chat - and refused otherwise,
 * with the refusal written to the owner's own security record. A decision that passes runs the
 * same three store calls the API's approval route runs, in the same order, so the two doors
 * cannot disagree about what a decision is or about which one wins.
 */
export const handleUpdate = async (
  input: InboundInput,
  update: TelegramUpdate
): Promise<InboundOutcome> => {
  if (update.callback_query) return handleCallback(input, update.callback_query);
  if (update.message) return handleMessage(input, update);
  return 'ignored';
};

/**
 * Whether this refusal is written to the owner's record, or only counted. The budget lives on the
 * destination for as long as its poller does, refilling on the clock; once it is spent, refusals
 * are still refused and the next one that is written says how many went unrecorded before it.
 */
const admitRejection = (input: InboundInput): { record: boolean; suppressed: number } => {
  const { destination } = input;
  const now = (input.now ?? (() => new Date()))().getTime();
  const budget = (destination.rejections ??= {
    tokens: REJECTION_BURST,
    refilledAt: now,
    suppressed: 0
  });
  const refill = Math.floor((now - budget.refilledAt) / REJECTION_REFILL_MS);
  if (refill > 0) {
    budget.tokens = Math.min(REJECTION_BURST, budget.tokens + refill);
    budget.refilledAt += refill * REJECTION_REFILL_MS;
  }
  if (budget.tokens === 0) {
    budget.suppressed += 1;
    return { record: false, suppressed: budget.suppressed };
  }
  budget.tokens -= 1;
  const suppressed = budget.suppressed;
  budget.suppressed = 0;
  return { record: true, suppressed };
};

const reject = async (
  input: InboundInput,
  reason: string,
  metadata: Record<string, unknown> = {}
): Promise<InboundOutcome> => {
  const warn = input.warn ?? ((line: string) => void process.stderr.write(line));
  const admitted = admitRejection(input);
  if (!admitted.record) {
    if (admitted.suppressed === 1)
      warn(
        `garden-notifications: notification.destination_inbound_flood destination=${input.destination.id} refusals are arriving faster than they are worth recording; they are still refused, and counted on the next one written\n`
      );
    return 'rejected';
  }
  await bestEffort(
    input.store.recordSecurityEvent({
      userId: input.destination.userId,
      kind: 'destination_inbound_rejected',
      outcome: 'failure',
      metadata: {
        reason,
        destinationId: input.destination.id,
        ...metadata,
        ...(admitted.suppressed ? { unrecordedBefore: admitted.suppressed } : {})
      }
    })
  );
  return 'rejected';
};

/**
 * The row's own sender against the one who sent this, once the row has been read. The poller's
 * snapshot was the first gate; this is the one that holds after the owner mints a new pairing
 * link, which unpairs at the row immediately and reaches the snapshot only on the next re-read.
 * The snapshot is brought into line while we are here, so the next attempt fails at the gate.
 */
const pairedAtRow = (input: InboundInput, rowSenderId: string | null, fromId: number): boolean => {
  if (rowSenderId !== null && rowSenderId === String(fromId)) return true;
  input.destination.senderId = rowSenderId;
  return false;
};

const handleCallback = async (
  input: InboundInput,
  query: TelegramCallbackQuery
): Promise<InboundOutcome> => {
  const { store, client, destination } = input;
  const now = (input.now ?? (() => new Date()))();
  // Answered first, before anything is looked up: the phone shows a spinner until this is called,
  // and the query id expires in about ten seconds. The answer says nothing; the card will.
  await bestEffort(client.call('answerCallbackQuery', { callback_query_id: query.id }));
  const message = query.message;
  if (!message || message.chat.type !== 'private')
    return reject(input, 'not_private_chat', { chatType: message?.chat.type ?? null });
  if (!destination.senderId || String(query.from.id) !== destination.senderId)
    return reject(input, 'unpaired_sender', { fromId: query.from.id });
  const parsed = parseCallbackData(query.data ?? '');
  if (!parsed) return reject(input, 'malformed_callback');
  const ledger = await store.getDestinationDelivery(
    destination.id,
    'approval_required',
    parsed.approvalId,
    input.masterKey
  );
  if (!ledger) return reject(input, 'bad_nonce', { approvalId: parsed.approvalId });
  if (!pairedAtRow(input, ledger.senderId, query.from.id))
    return reject(input, 'unpaired_sender', { fromId: query.from.id });
  if (!ledger.nonce || !sameSecret(ledger.nonce, parsed.nonce))
    return reject(input, 'bad_nonce', { approvalId: parsed.approvalId });

  // Settlement uses the same atomic decision as the browser route.
  const approval = await store.getApproval(parsed.approvalId);
  if (!approval || approval.userId !== destination.userId)
    return reject(input, 'foreign_approval', { approvalId: parsed.approvalId });
  const changed = await store.resolveApproval(
    destination.userId,
    parsed.approvalId,
    parsed.decision === 'approve' ? 'approved' : 'denied'
  );
  const outcome = {
    store,
    client,
    appUrl: input.appUrl,
    destinationId: destination.id,
    chatId: message.chat.id,
    messageId: message.message_id,
    text: message.text,
    taskId: String(approval.taskId),
    resourceId: parsed.approvalId,
    now
  };
  if (!changed) {
    // Decided already - on the phone a moment ago, at the keyboard, or by the deadline. Nothing
    // is written to the task; the card is brought up to date and the tap is told so.
    //
    // An approval past its deadline is refused by the store whether or not the expiry sweep has
    // reached it yet, and until it has the row still reads 'pending'. That is the deadline's
    // decision and not the owner's, and the card says so: it is closed as expired here rather
    // than left for the sweep, which would only write the same words onto it a second time.
    const current = await store.getApproval(parsed.approvalId).catch(() => null);
    const status = typeof current?.status === 'string' ? current.status : 'decided';
    const lapsed =
      status === 'pending' &&
      typeof current?.expiresAt === 'string' &&
      Date.parse(current.expiresAt) <= now.getTime();
    await bestEffort(
      client.call('answerCallbackQuery', {
        callback_query_id: query.id,
        text: lapsed ? 'Expired unanswered' : 'Already decided',
        show_alert: true
      })
    );
    await bestEffort(
      writeCardOutcome({
        ...outcome,
        status: lapsed ? 'expired' : status,
        source: 'elsewhere'
      })
    );
    return 'already_decided';
  }
  await bestEffort(
    writeCardOutcome({
      ...outcome,
      status: parsed.decision === 'approve' ? 'approved' : 'denied',
      source: 'phone'
    })
  );
  return 'decided';
};

const START = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{16,64}))?$/;

const handleMessage = async (
  input: InboundInput,
  update: TelegramUpdate
): Promise<InboundOutcome> => {
  const message = update.message!;
  const warn = input.warn ?? ((line: string) => void process.stderr.write(line));
  if (message.chat.type !== 'private')
    return reject(input, 'not_private_chat', { chatType: message.chat.type });
  const text = (message.text ?? '').trim();
  const start = START.exec(text);
  if (start) return completePairing(input, message, start[1]);
  const { destination } = input;
  if (!message.from || !destination.senderId || String(message.from.id) !== destination.senderId)
    return reject(input, 'unpaired_sender', { fromId: message.from?.id ?? null });
  const replyTo = message.reply_to_message?.message_id;
  if (replyTo !== undefined && text) return answerQuestion(input, update, message, replyTo, text);
  warn(
    `garden-notifications: notification.destination_ignored destination=${destination.id} a message that is neither a pairing nor a reply to a question\n`
  );
  return 'ignored';
};

/**
 * `/start <secret>`: the one message accepted from a sender nobody has paired yet. The secret is
 * hashed and compared in constant time against the hash minted in Settings, and the row is
 * claimed by a single UPDATE whose WHERE is the whole defence against a replayed link.
 */
const completePairing = async (
  input: InboundInput,
  message: TelegramMessage,
  secret: string | undefined
): Promise<InboundOutcome> => {
  const { store, client, destination } = input;
  const warn = input.warn ?? ((line: string) => void process.stderr.write(line));
  if (!secret || !message.from) {
    warn(
      `garden-notifications: notification.destination_ignored destination=${destination.id} /start without a pairing secret\n`
    );
    return 'ignored';
  }
  // Re-read rather than trusted from the poller's snapshot: the secret was minted after the
  // poller started, and an owner who taps the link within seconds must not be refused for it.
  const fresh = await store.getNotificationDestinationById(destination.id);
  if (!fresh?.pairingHash || !fresh.pairingPending)
    return reject(input, 'no_pairing_pending', { fromId: message.from.id });
  const hash = sha256(secret);
  if (!sameSecret(hash, fresh.pairingHash))
    return reject(input, 'bad_pairing_secret', { fromId: message.from.id });
  const claimed = await store.completeDestinationPairing(
    destination.id,
    hash,
    String(message.from.id),
    input.masterKey
  );
  if (claimed !== 1) return reject(input, 'pairing_replayed', { fromId: message.from.id });
  destination.senderId = String(message.from.id);
  await bestEffort(
    store.recordSecurityEvent({
      userId: destination.userId,
      kind: 'destination_paired',
      outcome: 'completed',
      metadata: { destinationId: destination.id }
    })
  );
  await bestEffort(
    client.call('sendMessage', {
      chat_id: message.chat.id,
      text: 'Paired. This chat now receives notifications from garden, and approvals can be answered here.',
      protect_content: true
    })
  );
  return 'paired';
};

/**
 * A reply to a question the agent asked, posted to the task message route over loopback with the
 * owner's own API token. The route's ownership check, its status check and its idempotency are
 * therefore the ones that apply, rather than a second copy of them kept here.
 */
const answerQuestion = async (
  input: InboundInput,
  update: TelegramUpdate,
  message: TelegramMessage,
  replyTo: number,
  text: string
): Promise<InboundOutcome> => {
  const { store, client, destination } = input;
  const warn = input.warn ?? ((line: string) => void process.stderr.write(line));
  const say = (line: string) =>
    bestEffort(
      client.call('sendMessage', {
        chat_id: message.chat.id,
        text: line,
        protect_content: true,
        reply_parameters: { message_id: message.message_id }
      })
    );
  const ledger = await store.findDestinationDeliveryByExternalRef(
    destination.id,
    String(replyTo),
    input.masterKey
  );
  if (!ledger?.taskId) {
    warn(
      `garden-notifications: notification.destination_ignored destination=${destination.id} a reply to a message that was not a question\n`
    );
    return 'ignored';
  }
  if (!message.from || !pairedAtRow(input, ledger.senderId, message.from.id))
    return reject(input, 'unpaired_sender', { fromId: message.from?.id ?? null });
  const task = await store.getTask(destination.userId, ledger.taskId).catch(() => null);
  if (!task || task.status !== 'awaiting_user') {
    await say('That conversation is not waiting for an answer. Open garden to continue it.');
    return 'ignored';
  }
  if (!destination.config.apiToken) {
    warn(
      `garden-notifications: notification.destination_answer_failed destination=${destination.id} paired without an API token; unpair and pair again to answer questions from the phone\n`
    );
    await say('garden could not take that answer from here. Open garden to reply.');
    return 'failed';
  }
  const doFetch = input.fetch ?? fetch;
  let status = 0;
  try {
    const response = await doFetch(
      `${input.apiBaseUrl}/v1/tasks/${encodeURIComponent(ledger.taskId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${destination.config.apiToken}`,
          'content-type': 'application/json',
          // The update id, so a poll that is replayed after a crash posts the same message once.
          'idempotency-key': `phone-${destination.id}-${update.update_id}`
        },
        body: JSON.stringify({ prompt: Array.from(text).slice(0, MAX_ANSWER_CHARS).join('') }),
        signal: AbortSignal.timeout(15_000)
      }
    );
    status = response.status;
    if (response.ok) {
      await say('Sent to garden.');
      return 'answered';
    }
  } catch (error) {
    warn(
      `garden-notifications: notification.destination_answer_failed destination=${destination.id} ${error instanceof Error ? error.message : String(error)}\n`
    );
    await say('garden could not take that answer right now. Open garden to reply.');
    return 'failed';
  }
  warn(
    `garden-notifications: notification.destination_answer_failed destination=${destination.id} the API answered ${status}\n`
  );
  await say(`garden did not take that answer (${status}). Open garden to reply.`);
  return 'failed';
};
