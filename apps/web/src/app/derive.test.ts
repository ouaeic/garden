import { describe, expect, it } from 'vitest';
import type { OwnerMove, Task } from '@garden/contracts';
import { beds, goalLine, growth, leaves, money, verdict } from './derive';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const task = (over: Partial<Task>): Task =>
  ({
    id: over.id ?? 'task',
    workspaceId: 'w',
    scheduleId: null,
    title: 'A goal',
    status: 'running',
    modelId: 'm',
    privacyRoute: 'provider_zdr',
    securityMode: 'balanced',
    maxComputeCredits: 1,
    actualComputeCredits: 0,
    maxSpendUsd: null,
    spentUsd: 0,
    spendPausedAt: null,
    completedAt: null,
    queuedMessageCount: 0,
    shareCount: 0,
    rewind: null,
    restoredCheckpointId: null,
    pinned: false,
    archivedAt: null,
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T11:00:00.000Z',
    ...over
  }) as Task;
const approval = (taskId: string): OwnerMove => ({
  kind: 'approval',
  taskId,
  taskTitle: 'A goal',
  at: '2026-10-05T11:30:00.000Z',
  approvalId: '00000000-0000-4000-8000-000000000001',
  action: 'Send the email',
  detail: '',
  tool: 'connector_action',
  sideEffect: 'external_consequential',
  expiresAt: '2026-10-06T11:30:00.000Z'
});

describe('what a goal looks like from the desk', () => {
  it('needs the owner whenever anything about it is waiting on them, whatever its status says', () => {
    expect(growth(task({ status: 'running' }), [approval('task')])).toBe('needs');
    expect(growth(task({ status: 'paused', spendPausedAt: '2026-10-05T11:00:00.000Z' }), [])).toBe(
      'needs'
    );
    expect(growth(task({ status: 'awaiting_user' }), [])).toBe('needs');
  });

  it('is ready once finished, and accepted once filed away', () => {
    expect(growth(task({ status: 'completed' }), [])).toBe('ready');
    expect(growth(task({ status: 'completed', archivedAt: '2026-10-05T11:00:00.000Z' }), [])).toBe(
      'done'
    );
  });

  it('puts what needs the owner first in the bed, and keeps a schedule’s quiet runs out of it', () => {
    const { growing, ready } = beds(
      [
        task({ id: 'working' }),
        task({ id: 'waiting', status: 'awaiting_user' }),
        task({ id: 'quiet-run', scheduleId: 's', status: 'running' }),
        task({ id: 'done', status: 'completed', completedAt: '2026-10-05T09:00:00.000Z' }),
        task({ id: 'old', status: 'completed', completedAt: '2026-09-01T09:00:00.000Z' })
      ],
      [],
      NOW
    );
    expect(growing.map((item) => item.id)).toEqual(['waiting', 'working']);
    expect(ready.map((item) => item.id)).toEqual(['done']);
  });

  it('grows a leaf per plan step, and draws a seedling for a goal with no plan yet', () => {
    expect(
      leaves(
        task({
          activity: {
            currentStep: 'Drafting',
            stepsCompleted: 2,
            stepsTotal: 5,
            latest: '',
            eventId: null,
            observedAt: null
          }
        })
      )
    ).toEqual({ total: 5, done: 2, current: true });
    expect(leaves(task({}))).toEqual({ total: 3, done: 0, current: true });
  });

  it('says what the goal needs before what it is doing', () => {
    expect(goalLine(task({}), [approval('task')])).toBe('Asking before: Send the email');
    expect(goalLine(task({ status: 'queued' }), [])).toBe('Thinking it through');
  });

  it('opens with the verdict, and says so when nothing needs the owner', () => {
    const line = verdict(
      'Dan',
      [task({ status: 'completed', completedAt: '2026-10-05T11:00:00.000Z' })],
      [],
      new Date(NOW)
    );
    expect(line.line).toBe('One is ready. Nothing needs you.');
    expect(verdict('Dan', [], [], new Date(NOW)).line).toMatch(/^Nothing is growing yet/);
  });

  it('writes money as a person would: whole dollars bare, cents only when there are some', () => {
    expect(money(12)).toBe('$12');
    expect(money(6)).toBe('$6');
    expect(money(4.1)).toBe('$4.10');
    expect(money(0.04)).toBe('$0.04');
    expect(money(142.6)).toBe('$143');
  });
});
