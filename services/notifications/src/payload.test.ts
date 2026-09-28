import { describe, expect, it } from 'vitest';
import { approvalPhrase, type NotificationSubject } from './model.js';
import { notificationPayload } from './payload.js';
import { pushConfigured } from './config.js';

const subject = (overrides: Partial<NotificationSubject> = {}): NotificationSubject => ({
  kind: 'task_finished',
  taskId: '22222222-2222-4222-8222-222222222222',
  resourceId: '11111111-1111-4111-8111-111111111111',
  taskTitle: 'Reconcile the March invoices',
  taskStatus: 'completed',
  approvalAction: null,
  approvalSideEffect: null,
  message: null,
  approvalExpired: false,
  spentUsd: 0.31,
  capUsd: 5,
  durationMs: 6 * 60_000,
  ...overrides
});

describe('notificationPayload', () => {
  it('names the conversation and says what happened to it', () => {
    const payload = notificationPayload(subject());
    expect(payload.title).toBe('Reconcile the March invoices');
    expect(payload.body).toBe('Finished in 6 min · $0.31.');
    expect(payload.url).toBe('/?task=22222222-2222-4222-8222-222222222222');
    expect(payload.tag).toBe('task-11111111-1111-4111-8111-111111111111');
    expect(payload.actions).toBeUndefined();
  });

  it('distinguishes a failure and a cancellation from a success', () => {
    expect(notificationPayload(subject({ taskStatus: 'failed' })).body).toBe(
      'Stopped with an error in 6 min · $0.31.'
    );
    expect(notificationPayload(subject({ taskStatus: 'cancelled' })).body).toBe(
      'Cancelled in 6 min · $0.31.'
    );
  });

  it('drops whichever half of the receipt is unknown rather than inventing it', () => {
    expect(notificationPayload(subject({ spentUsd: 0, durationMs: null })).body).toBe('Finished.');
    expect(notificationPayload(subject({ spentUsd: null })).body).toBe('Finished in 6 min.');
    expect(notificationPayload(subject({ durationMs: null })).body).toBe('Finished $0.31.');
  });

  it('falls back to a readable title rather than an id when the title is unavailable', () => {
    expect(notificationPayload(subject({ taskTitle: null })).title).toBe('Untitled conversation');
    expect(notificationPayload(subject({ taskTitle: '   ' })).title).toBe('Untitled conversation');
  });

  it('gives an approval its side effect, both buttons, and the id they answer', () => {
    const payload = notificationPayload(
      subject({
        kind: 'approval_required',
        approvalAction: 'connector_action',
        approvalSideEffect: 'external_consequential',
        spentUsd: null,
        capUsd: null,
        durationMs: null
      })
    );
    expect(payload.body).toBe('Waiting for you: it wants to use one of your connected accounts.');
    expect(payload.actions).toEqual([
      { action: 'approve', title: 'Approve' },
      { action: 'deny', title: 'Deny' }
    ]);
    expect(payload.approvalId).toBe('11111111-1111-4111-8111-111111111111');
    expect(payload.requireInteraction).toBe(true);
  });

  it('says what a spend pause costs and who can clear it', () => {
    const payload = notificationPayload(
      subject({ kind: 'spend_paused', spentUsd: 5, capUsd: 5, taskStatus: 'paused' })
    );
    expect(payload.body).toBe(
      'Paused at your $5.00 limit after spending $5.00. Only you can raise it.'
    );
    expect(payload.tag).toBe('spend-11111111-1111-4111-8111-111111111111');
    expect(payload.requireInteraction).toBe(true);
    expect(payload.actions).toBeUndefined();
  });

  it('still reports a spend pause when the figures are missing', () => {
    expect(
      notificationPayload(subject({ kind: 'spend_paused', spentUsd: null, capUsd: null })).body
    ).toBe('Paused at your spending limit. Only you can raise it.');
  });

  it('sends the agent’s own sentence, with no house style wrapped around it', () => {
    const payload = notificationPayload(
      subject({
        kind: 'agent_message',
        message: 'The permit page listed three new slots for September.',
        taskStatus: null
      })
    );
    expect(payload.body).toBe('The permit page listed three new slots for September.');
    expect(payload.title).toBe('Reconcile the March invoices');
    expect(payload.tag).toBe('agent-11111111-1111-4111-8111-111111111111');
    // The receipt belongs to a finished conversation; this one is still working.
    expect(payload.requireInteraction).toBeUndefined();
  });

  it('keeps a message worth acting on even when its text could not be decrypted', () => {
    expect(notificationPayload(subject({ kind: 'agent_message', message: null })).body).toBe(
      'Something you asked to be told about happened.'
    );
  });

  it('says a takeover is stopped work and keeps it on screen until it is dealt with', () => {
    const payload = notificationPayload(
      subject({
        kind: 'takeover_needed',
        message: 'A bot check on tickets.example is blocking the booking.',
        taskStatus: null
      })
    );
    expect(payload.body).toBe('A bot check on tickets.example is blocking the booking.');
    expect(payload.tag).toBe('takeover-11111111-1111-4111-8111-111111111111');
    expect(payload.requireInteraction).toBe(true);
    expect(payload.actions).toBeUndefined();
  });

  it('names where to go when a takeover arrives without its own sentence', () => {
    expect(notificationPayload(subject({ kind: 'takeover_needed', message: null })).body).toBe(
      'Stopped at a check only you can clear. Open the Computer and take control.'
    );
  });

  it('tells an expired approval apart from a takeover, and names what went unanswered', () => {
    const payload = notificationPayload(
      subject({
        kind: 'takeover_needed',
        approvalExpired: true,
        approvalAction: 'shell',
        approvalSideEffect: null,
        message: null,
        taskStatus: 'paused'
      })
    );
    expect(payload.body).toBe(
      'Gave up waiting: nobody answered its request to run a command on your computer. It is paused - open it to ask again.'
    );
    // The wrong sentence is the whole point of the flag: there is nothing left to take control of.
    expect(payload.body).not.toContain('Open the Computer');
    expect(payload.requireInteraction).toBe(true);
  });

  it('still says something true when the expired approval names no tool it recognises', () => {
    expect(
      notificationPayload(
        subject({ kind: 'takeover_needed', approvalExpired: true, approvalAction: null })
      ).body
    ).toBe(
      'Gave up waiting: nobody answered its request to do something it needs your permission for. It is paused - open it to ask again.'
    );
  });

  it('leaves an agent-raised takeover alone even when it carries no sentence', () => {
    expect(
      notificationPayload(
        subject({ kind: 'takeover_needed', approvalExpired: false, approvalAction: 'shell' })
      ).body
    ).toBe('Stopped at a check only you can clear. Open the Computer and take control.');
  });

  it('formats long and short runs without lying about precision', () => {
    expect(notificationPayload(subject({ durationMs: 4_000, spentUsd: null })).body).toBe(
      'Finished in 4s.'
    );
    expect(notificationPayload(subject({ durationMs: 3 * 3_600_000, spentUsd: null })).body).toBe(
      'Finished in 3h.'
    );
    expect(
      notificationPayload(subject({ durationMs: 3 * 3_600_000 + 12 * 60_000, spentUsd: null })).body
    ).toBe('Finished in 3h 12m.');
  });
});

describe('approvalPhrase', () => {
  it('names the side effect for every tool that can ask for one', () => {
    expect(approvalPhrase('shell', 'external_consequential')).toBe(
      'run a command on your computer'
    );
    expect(approvalPhrase('connector_action', 'external_consequential')).toBe(
      'use one of your connected accounts'
    );
    expect(approvalPhrase('secure_input_handoff', 'external_consequential')).toBe(
      'hand control back so you can type something private'
    );
  });

  it('falls back to the side-effect class for a tool it has never met', () => {
    expect(approvalPhrase('some_future_tool', 'external_consequential')).toBe(
      'do something outside this computer that cannot be undone'
    );
    // `http_request` had a case of its own and has never been a tool in this catalogue, so the
    // phrase was unreachable. It goes down the same road as any other name nothing publishes.
    expect(approvalPhrase('http_request', 'external_consequential')).toBe(
      'do something outside this computer that cannot be undone'
    );
    expect(approvalPhrase(null, 'workspace_write')).toBe('change something in your workspace');
    expect(approvalPhrase(null, null)).toBe('do something it needs your permission for');
  });
});

describe('optional Web Push configuration', () => {
  const base = {
    DATABASE_DRIVER: 'postgres' as const,
    DATABASE_URL: 'postgres://x',
    PGLITE_PATH: '.garden/postgres',
    NOTIFICATION_POLL_MS: 2000,
    NOTIFICATION_BATCH_SIZE: 100,
    NOTIFICATION_HEALTH_PORT: 4203,
    TELEGRAM_API_BASE_URL: 'https://api.telegram.org',
    NOTIFICATION_INBOUND_POLL_TIMEOUT_S: 50,
    PUBLIC_APP_URL: 'http://localhost:5173',
    API_HOST: '127.0.0.1',
    API_PORT: 4100
  };

  it('treats a fully configured key set as enabled', () => {
    expect(
      pushConfigured({
        ...base,
        PUSH_VAPID_SUBJECT: 'mailto:owner@example.com',
        PUSH_VAPID_PUBLIC_KEY: 'p'.repeat(87),
        PUSH_VAPID_PRIVATE_KEY: 'q'.repeat(43)
      })
    ).toBe(true);
  });

  it('treats absent or partial keys as simply off, never as a reason to fail', () => {
    // A crash here becomes a permanently failing systemd unit for a feature the owner may not
    // even want, which is why every one of these has to read as "disabled" rather than "broken".
    expect(pushConfigured(base)).toBe(false);
    expect(pushConfigured({ ...base, PUSH_VAPID_SUBJECT: 'mailto:owner@example.com' })).toBe(false);
    expect(
      pushConfigured({
        ...base,
        PUSH_VAPID_SUBJECT: 'mailto:owner@example.com',
        PUSH_VAPID_PUBLIC_KEY: 'p'.repeat(87)
      })
    ).toBe(false);
  });
});
