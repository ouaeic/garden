import { describe, expect, it } from 'vitest';
import type { DataStore } from '@garden/data';
import { notificationSubject, ownerPresent, ownerSettings, type PendingRow } from './context.js';

const now = new Date('2026-07-31T12:00:00.000Z');

const task = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  userId: 'owner',
  workspaceId: 'workspace-1',
  status: 'completed',
  legacyTitle: null,
  spentUsd: 0.31,
  maxSpendUsd: 5,
  createdAt: '2026-07-31T11:54:00.000Z',
  updatedAt: '2026-07-31T12:00:00.000Z',
  ...overrides
});

const store = (parts: Record<string, unknown>): DataStore =>
  ({
    effectiveSpendLimits: async () => ({ timeZone: 'UTC' }),
    listSessions: async () => [],
    listApprovals: async () => [],
    getApproval: async () => null,
    getTask: async () => null,
    notificationSettings: async () => null,
    ...parts
  }) as unknown as DataStore;

const row = (overrides: Partial<PendingRow> = {}): PendingRow =>
  ({
    id: 'subscription-1',
    userId: 'owner',
    endpoint: 'https://push.example/1',
    p256dh: 'p',
    auth: 'a',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    kind: 'task_finished',
    resourceId: 'task-1',
    taskId: 'task-1',
    taskStatus: 'completed',
    eventAt: '2026-07-31T12:00:00.000Z',
    taskTitle: null,
    message: null,
    ...overrides
  }) as PendingRow;

describe('ownerPresent', () => {
  it('is true while a session was touched inside the window', async () => {
    const recent = store({
      listSessions: async () => [{ lastSeenAt: '2026-07-31T11:59:30.000Z' }]
    });
    expect(await ownerPresent(recent, 'owner', now)).toBe(true);
  });

  it('is false once every session has gone quiet', async () => {
    const stale = store({
      listSessions: async () => [
        { lastSeenAt: '2026-07-31T11:50:00.000Z' },
        { lastSeenAt: '2026-07-30T09:00:00.000Z' }
      ]
    });
    expect(await ownerPresent(stale, 'owner', now)).toBe(false);
  });

  it('fails open: an unreadable session list must not silence a notification', async () => {
    const broken = store({
      listSessions: async () => {
        throw new Error('database unavailable');
      }
    });
    expect(await ownerPresent(broken, 'owner', now)).toBe(false);
  });
});

describe('ownerSettings', () => {
  it('takes the owner’s day from the spending caps rather than storing a second copy', async () => {
    const settings = await ownerSettings(
      store({ effectiveSpendLimits: async () => ({ timeZone: 'Europe/London' }) }),
      'owner'
    );
    expect(settings.timeZone).toBe('Europe/London');
  });

  it('keeps every kind on when the stored preferences cannot be read', async () => {
    // A settings row that will not load must not be able to silence a kind the owner never
    // switched off, so both the absent row and the failed read land on the same defaults.
    for (const notificationSettings of [
      async () => null,
      async () => {
        throw new Error('database unavailable');
      }
    ]) {
      const settings = await ownerSettings(store({ notificationSettings }), 'owner');
      expect(settings.kinds).toEqual({
        approval_required: true,
        task_finished: true,
        spend_paused: true,
        agent_message: true,
        takeover_needed: true
      });
      expect(settings.quietHours).toBeNull();
    }
  });

  it('uses stored preferences but never a second time zone', async () => {
    const settings = await ownerSettings(
      store({
        effectiveSpendLimits: async () => ({ timeZone: 'Europe/London' }),
        notificationSettings: async () => ({
          kinds: { approval_required: true, task_finished: false, spend_paused: true },
          quietHours: { startMinute: 1320, endMinute: 420 },
          quietHoursAllowApprovals: false,
          timeZone: 'America/New_York'
        })
      }),
      'owner'
    );
    expect(settings.kinds.task_finished).toBe(false);
    // A row missing a kind keeps that kind's default rather than arriving undefined and being read
    // as "the owner turned this off".
    expect(settings.kinds.agent_message).toBe(true);
    expect(settings.kinds.takeover_needed).toBe(true);
    expect(settings.quietHours).toEqual({ startMinute: 1320, endMinute: 420 });
    expect(settings.timeZone).toBe('Europe/London');
  });
});

describe('notificationSubject', () => {
  it('prices and times a finished conversation from the task itself', async () => {
    const { subject, eventAt } = await notificationSubject(
      store({ getTask: async () => task() }),
      row()
    );
    expect(subject.spentUsd).toBe(0.31);
    expect(subject.durationMs).toBe(6 * 60_000);
    expect(subject.taskStatus).toBe('completed');
    expect(eventAt.toISOString()).toBe('2026-07-31T12:00:00.000Z');
  });

  it('prefers the title the data layer decrypted over the legacy plaintext one', async () => {
    const { subject } = await notificationSubject(
      store({ getTask: async () => task({ legacyTitle: 'old plaintext title' }) }),
      row({ taskTitle: 'Reconcile the March invoices' })
    );
    expect(subject.taskTitle).toBe('Reconcile the March invoices');
  });

  it('names the approval’s tool and side effect, and leaves money out of it', async () => {
    const { subject, eventAt } = await notificationSubject(
      store({
        getTask: async () => task({ status: 'awaiting_user' }),
        listApprovals: async () => [
          {
            id: 'approval-9',
            action: 'connector_action',
            sideEffect: 'external_consequential',
            createdAt: '2026-07-31T11:58:00.000Z'
          }
        ]
      }),
      row({
        kind: 'approval_required',
        resourceId: 'approval-9',
        taskStatus: null,
        eventAt: '2026-07-31T11:58:00.000Z'
      })
    );
    expect(subject.approvalAction).toBe('connector_action');
    expect(subject.approvalSideEffect).toBe('external_consequential');
    expect(subject.spentUsd).toBeNull();
    expect(subject.durationMs).toBeNull();
    expect(eventAt.toISOString()).toBe('2026-07-31T11:58:00.000Z');
  });

  it('still produces a subject when the task row cannot be read at all', async () => {
    const { subject } = await notificationSubject(
      store({
        getTask: async () => {
          throw new Error('database unavailable');
        }
      }),
      row()
    );
    expect(subject.taskTitle).toBeNull();
    expect(subject.taskStatus).toBe('completed');
    expect(subject.durationMs).toBeNull();
  });

  it('prices a spend pause from the task’s own ceiling only when that is the ceiling it reached', async () => {
    const { subject } = await notificationSubject(
      store({ getTask: async () => task({ status: 'paused', spentUsd: 5, maxSpendUsd: 5 }) }),
      row({ kind: 'spend_paused', taskStatus: 'paused', eventAt: '2026-07-31T12:00:00.000Z' })
    );
    expect(subject.spentUsd).toBe(5);
    expect(subject.capUsd).toBe(5);
  });

  it('names no figure for a pause the household caps caused, rather than naming the wrong one', async () => {
    // Three different things stop a task at a ceiling: its own cap, the daily or monthly cap, and
    // a spending guard that would not answer. Only the first is the pair of numbers on the task
    // row, and the row does not say which it was - so a task 31 cents into a $5 ceiling, stopped
    // by a $20 daily cap, would have read "Paused at your $5.00 limit after spending $0.31". A
    // sentence about the owner's money has to be true or absent.
    const { subject } = await notificationSubject(
      store({ getTask: async () => task({ status: 'paused', spentUsd: 0.31, maxSpendUsd: 5 }) }),
      row({ kind: 'spend_paused', taskStatus: 'paused', eventAt: '2026-07-31T12:00:00.000Z' })
    );
    expect(subject.spentUsd).toBeNull();
    expect(subject.capUsd).toBeNull();
  });

  it('carries the agent’s own sentence and the moment it raised it', async () => {
    const { subject, eventAt } = await notificationSubject(
      store({ getTask: async () => task({ status: 'running' }) }),
      row({
        kind: 'agent_message',
        resourceId: 'notification-3',
        taskStatus: null,
        eventAt: '2026-07-31T11:45:00.000Z',
        message: 'The permit page listed three new slots for September.'
      })
    );
    expect(subject.message).toBe('The permit page listed three new slots for September.');
    // The task was last written when the run started; the notification is what happened at 11:45,
    // and the staleness horizon has to be measured from that rather than from the task row.
    expect(eventAt.toISOString()).toBe('2026-07-31T11:45:00.000Z');
  });
  it('reads the approval row to tell an expired approval from an agent takeover', async () => {
    const { subject } = await notificationSubject(
      store({
        getTask: async () => task({ status: 'paused' }),
        getApproval: async () => ({
          id: 'approval-9',
          userId: 'owner',
          taskId: 'task-1',
          action: 'connector_action',
          status: 'expired',
          previewHash: 'hash',
          expiresAt: '2026-07-31T11:00:00.000Z'
        })
      }),
      row({
        kind: 'takeover_needed',
        resourceId: 'approval-9',
        taskStatus: 'paused',
        eventAt: '2026-07-31T11:00:00.000Z'
      })
    );
    expect(subject.approvalExpired).toBe(true);
    expect(subject.approvalAction).toBe('connector_action');
    // A decision to go and make, not a bill. Money beside it reads as the thing being reported.
    expect(subject.spentUsd).toBeNull();
    expect(subject.capUsd).toBeNull();
    expect(subject.durationMs).toBeNull();
  });

  it('leaves an agent-raised takeover alone: no approval row answers to its resource id', async () => {
    const { subject } = await notificationSubject(
      store({ getTask: async () => task({ status: 'running' }) }),
      row({ kind: 'takeover_needed', resourceId: 'notification-4', taskStatus: null })
    );
    expect(subject.approvalExpired).toBe(false);
    expect(subject.approvalAction).toBeNull();
  });

  it('does not claim an approval expired when the row belongs to somebody else', async () => {
    const { subject } = await notificationSubject(
      store({
        getTask: async () => task({ status: 'paused' }),
        getApproval: async () => ({ id: 'approval-9', userId: 'stranger', status: 'expired' })
      }),
      row({ kind: 'takeover_needed', resourceId: 'approval-9' })
    );
    expect(subject.approvalExpired).toBe(false);
  });

  it('fails soft when the approval cannot be read at all', async () => {
    const { subject } = await notificationSubject(
      store({
        getTask: async () => task({ status: 'paused' }),
        getApproval: async () => {
          throw new Error('database unavailable');
        }
      }),
      row({ kind: 'takeover_needed', resourceId: 'approval-9' })
    );
    // The general sentence, which is wrong for this row - and a notification that arrives saying
    // roughly the right thing beats one this service threw away because a read failed.
    expect(subject.approvalExpired).toBe(false);
  });
});
