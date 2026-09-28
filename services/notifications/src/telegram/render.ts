import type { PushPayload } from '../payload.js';

/**
 * The most text one message carries. The service allows 4,096 characters after parsing; this
 * leaves room for the title line, the outcome line an edit appends later, and HTML escaping.
 */
export const MAX_TEXT_CHARS = 3_500;

/** HTML parse mode escapes three characters and nothing else, which is why it is used. */
export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Characters that change how text reads without being seen: zero-width joiners and spaces,
 * bidirectional overrides and isolates, and the byte-order mark. A sentence an agent wrote - or
 * that a page the agent read wrote into it - is shown on a phone exactly as it would be on the
 * screen, and none of these have a place in it.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Invisible characters out, whitespace folded to one space, ends trimmed. */
export const cleanText = (text: string): string =>
  text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

/** Cut to a number of code points, not UTF-16 units, so an emoji is never halved. */
const cap = (text: string, limit: number): string => {
  const points = Array.from(text);
  return points.length > limit ? `${points.slice(0, Math.max(0, limit - 1)).join('')}…` : text;
};

/**
 * The button payload for a decision: the approval, the answer, and a nonce the ledger holds. A
 * UUID and an eight-character nonce come to 49 bytes, under the service's 64-byte ceiling.
 */
export const callbackData = (approvalId: string, decision: 'y' | 'n', nonce: string): string =>
  `a:${approvalId}:${decision}:${nonce}`;

const CALLBACK = /^a:([0-9a-f-]{36}):(y|n):([A-Za-z0-9_-]{4,16})$/;

export const parseCallbackData = (
  data: string
): { approvalId: string; decision: 'approve' | 'deny'; nonce: string } | null => {
  const match = CALLBACK.exec(data);
  if (!match) return null;
  return {
    approvalId: match[1]!,
    decision: match[2] === 'y' ? 'approve' : 'deny',
    nonce: match[3]!
  };
};

/** The payload's relative link made absolute against the box's public address. */
export const openUrl = (appUrl: string, path: string): string => new URL(path, appUrl).toString();

export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
}

export interface ForceReplyMarkup {
  force_reply: true;
  input_field_placeholder?: string;
}

export interface RenderedMessage {
  /** HTML, escaped, cleaned and capped. */
  text: string;
  reply_markup: InlineKeyboardMarkup | ForceReplyMarkup;
  /** A receipt arrives silently; everything else is allowed to make a sound. */
  disable_notification: boolean;
}

export interface RenderInput {
  payload: PushPayload;
  appUrl: string;
  /**
   * Title and link only. The service in between is not end-to-end encrypted, so this is the
   * default; what is withheld is the body - the tool class an approval names, the sentence an
   * agent wrote - and not the buttons, which carry an id and a nonce and no content.
   */
  redact: boolean;
  /** Present exactly when the card is an approval with buttons; bound into the button data. */
  nonce?: string;
  /**
   * True when the notice belongs to a conversation parked waiting for the owner's words and no
   * approval card is standing for it - the one case where a reply on the phone is the answer.
   */
  awaitingAnswer?: boolean;
}

const OPEN = 'Open in garden';

/**
 * One message from one payload: the same title and body the lock screen gets, in the shape the
 * bot API takes.
 */
export const renderMessage = (input: RenderInput): RenderedMessage => {
  const { payload } = input;
  const url = openUrl(input.appUrl, payload.url);
  const title = escapeHtml(cap(cleanText(payload.title), 200));
  const lines = [`<b>${title}</b>`];
  if (!input.redact) {
    let body = cap(cleanText(payload.body), MAX_TEXT_CHARS);
    // Escaping can only grow the text, and a body that is all ampersands grows fivefold; the cap
    // is on what is sent, so it is re-applied to the escaped form until it fits.
    while (escapeHtml(body).length > MAX_TEXT_CHARS)
      body = cap(body, Math.floor(body.length * 0.8));
    if (body) lines.push(escapeHtml(body));
  }
  const open = { text: OPEN, url };
  let replyMarkup: InlineKeyboardMarkup | ForceReplyMarkup = { inline_keyboard: [[open]] };
  if (payload.kind === 'approval_required' && payload.approvalId && input.nonce) {
    replyMarkup = {
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: callbackData(payload.approvalId, 'y', input.nonce) },
          { text: 'Deny', callback_data: callbackData(payload.approvalId, 'n', input.nonce) }
        ],
        [open]
      ]
    };
  } else if (payload.kind === 'agent_message' && input.awaitingAnswer) {
    // A reply prompt cannot carry buttons, so the link travels as text. Previews are disabled on
    // every send, so a link in the text unfurls nothing.
    lines.push(`<a href="${escapeHtml(url)}">${OPEN}</a>`);
    replyMarkup = { force_reply: true, input_field_placeholder: 'Your answer' };
  }
  return {
    text: lines.join('\n'),
    reply_markup: replyMarkup,
    disable_notification: payload.kind === 'task_finished'
  };
};

/** How the outcome reads on the card once it is decided, wherever it was decided. */
export const outcomeLabel = (
  status: string,
  source: 'phone' | 'elsewhere',
  at: Date,
  timeZone = 'UTC'
): string => {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(at);
  const where = source === 'phone' ? 'from your phone' : 'in garden';
  switch (status) {
    case 'approved':
      return `✅ Approved ${where} at ${clock}`;
    case 'denied':
      return `❌ Denied ${where} at ${clock}`;
    case 'expired':
      return `⌛ Expired unanswered`;
    default:
      return `Decided ${where} at ${clock}`;
  }
};

/** The keyboard a decided card is left with: the decision itself, as the one button that remains. */
export const outcomeMarkup = (url: string, label: string): InlineKeyboardMarkup => ({
  inline_keyboard: [[{ text: label, url }]]
});
