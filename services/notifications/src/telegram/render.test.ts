import { describe, expect, it } from 'vitest';
import { notificationPayload } from '../payload.js';
import type { NotificationSubject } from '../model.js';
import {
  callbackData,
  cleanText,
  escapeHtml,
  outcomeLabel,
  outcomeMarkup,
  parseCallbackData,
  renderMessage,
  MAX_TEXT_CHARS
} from './render.js';

const approvalId = '6f1a9d2e-4c3b-4e8a-9f0d-1b2c3d4e5f60';

const subject = (overrides: Partial<NotificationSubject> = {}): NotificationSubject => ({
  kind: 'approval_required',
  taskId: 'task-1',
  resourceId: approvalId,
  taskTitle: 'Reconcile <the> March & April invoices',
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

const appUrl = 'https://ai.example.test';

describe('renderMessage', () => {
  it('sends the title and the link and nothing else when redacted, keeping the decision buttons', () => {
    const rendered = renderMessage({
      payload: notificationPayload(subject()),
      appUrl,
      redact: true,
      nonce: 'abcdefgh'
    });
    // The body - what the agent wants to do - stays on this box. The buttons carry an id and a
    // nonce and no content, so answering from the phone survives redaction.
    expect(rendered.text).toBe('<b>Reconcile &lt;the&gt; March &amp; April invoices</b>');
    expect(rendered.text).not.toContain('run a command');
    expect(rendered.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: `a:${approvalId}:y:abcdefgh` },
          { text: 'Deny', callback_data: `a:${approvalId}:n:abcdefgh` }
        ],
        [{ text: 'Open in garden', url: `${appUrl}/?task=task-1` }]
      ]
    });
    expect(rendered.disable_notification).toBe(false);
  });

  it('carries the body when not redacted, escaped for the HTML parse mode', () => {
    const rendered = renderMessage({
      payload: notificationPayload(
        subject({ kind: 'agent_message', message: 'Build <red> & failing: see > logs' })
      ),
      appUrl,
      redact: false
    });
    expect(rendered.text).toBe(
      '<b>Reconcile &lt;the&gt; March &amp; April invoices</b>\nBuild &lt;red&gt; &amp; failing: see &gt; logs'
    );
    expect(rendered.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Open in garden', url: `${appUrl}/?task=task-1` }]]
    });
  });

  it('asks for a reply, with the link in the text, when the conversation is waiting for words', () => {
    const rendered = renderMessage({
      payload: notificationPayload(subject({ kind: 'agent_message', message: 'Which account?' })),
      appUrl,
      redact: false,
      awaitingAnswer: true
    });
    expect(rendered.reply_markup).toEqual({
      force_reply: true,
      input_field_placeholder: 'Your answer'
    });
    expect(rendered.text).toContain(`<a href="${appUrl}/?task=task-1">Open in garden</a>`);
  });

  it('lets a receipt arrive silently and everything else make a sound', () => {
    const receipt = renderMessage({
      payload: notificationPayload(subject({ kind: 'task_finished', taskStatus: 'completed' })),
      appUrl,
      redact: true
    });
    expect(receipt.disable_notification).toBe(true);
    const pause = renderMessage({
      payload: notificationPayload(subject({ kind: 'spend_paused', taskStatus: 'paused' })),
      appUrl,
      redact: true
    });
    expect(pause.disable_notification).toBe(false);
  });

  it('keeps the button data under the 64-byte ceiling for a real UUID', () => {
    const data = callbackData(approvalId, 'y', 'abcdefgh');
    expect(Buffer.byteLength(data)).toBeLessThan(64);
    expect(parseCallbackData(data)).toEqual({ approvalId, decision: 'approve', nonce: 'abcdefgh' });
    expect(parseCallbackData(callbackData(approvalId, 'n', 'abcdefgh'))?.decision).toBe('deny');
    // Anything else is not a decision: a different prefix, a shortened id, an extra field.
    expect(parseCallbackData(`b:${approvalId}:y:abcdefgh`)).toBeNull();
    expect(parseCallbackData(`a:${approvalId.slice(1)}:y:abcdefgh`)).toBeNull();
    expect(parseCallbackData(`a:${approvalId}:y:abcdefgh:extra`)).toBeNull();
  });

  it('folds whitespace, strips invisible characters and caps the text', () => {
    expect(cleanText('  a\n\n\tb​‮c  ')).toBe('a bc');
    const long = renderMessage({
      payload: notificationPayload(subject({ kind: 'agent_message', message: 'x'.repeat(10_000) })),
      appUrl,
      redact: false
    });
    expect(long.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 100);
    // Escaping grows the text; the cap is on what is sent.
    const amps = renderMessage({
      payload: notificationPayload(subject({ kind: 'agent_message', message: '&'.repeat(5_000) })),
      appUrl,
      redact: false
    });
    expect(amps.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 100);
    expect(escapeHtml('&<>')).toBe('&amp;&lt;&gt;');
  });
});

describe('the outcome a decided card is left with', () => {
  it('names the decision and where it was taken, and keeps only the link', () => {
    const at = new Date('2026-07-31T12:31:00.000Z');
    expect(outcomeLabel('approved', 'phone', at)).toBe('✅ Approved from your phone at 12:31');
    expect(outcomeLabel('denied', 'elsewhere', at)).toBe('❌ Denied in garden at 12:31');
    expect(outcomeLabel('expired', 'elsewhere', at)).toBe('⌛ Expired unanswered');
    const markup = outcomeMarkup('https://ai.example.test/?task=task-1', 'done');
    expect(markup.inline_keyboard.flat().some((button) => 'callback_data' in button)).toBe(false);
  });
});
