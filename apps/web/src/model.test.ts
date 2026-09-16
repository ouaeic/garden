import { describe, expect, it } from 'vitest';
import { Task, type TaskEvent } from '@athanor/contracts';
import type { Bootstrap } from './model.js';
import {
  activeQuestion,
  hasOngoingWork,
  needsAttention,
  taskStatusLabel,
  mergeTaskRefresh,
  surfaceAnswer
} from './model.js';

const id = '11111111-1111-4111-8111-111111111111';
const time = '2026-09-06T00:00:00.000Z';
const task = Task.parse({
  id,
  workspaceId: id,
  title: 'A real direction',
  status: 'awaiting_user',
  modelId: 'configured',
  privacyRoute: 'external',
  maxComputeCredits: 100,
  actualComputeCredits: 0,
  createdAt: time,
  updatedAt: time
});
const event = (sequence: number, kind: TaskEvent['kind'], payload: unknown): TaskEvent => ({
  id: crypto.randomUUID(),
  taskId: id,
  sequence,
  kind,
  payload,
  summary: 'Event',
  createdAt: time
});
const bootstrap = (tasks: Task[], cursor: string | null): Bootstrap => ({
  user: { id },
  tasks,
  tasksCursor: cursor,
  scheduleRunCounts: {},
  schedules: [],
  workspaces: [],
  drafts: [],
  models: [],
  instance: {
    mode: 'self_hosted',
    providerConfigured: true,
    enforceZeroDataRetention: false,
    webSearch: null
  },
  usage: {
    providerSpend: null,
    consumedCredits: 0,
    reservedCredits: 0,
    storageBytes: 0,
    storageLimitBytes: 0,
    plan: null
  }
});

describe('the current work surface', () => {
  it('keeps delivery in progress visible and brings failed delivery back to attention', () => {
    const pending = { ...task, status: 'completed' as const, deliveryStatus: 'pending' as const };
    expect(hasOngoingWork(pending)).toBe(true);
    expect(taskStatusLabel(pending)).toBe('Generating media');
    expect(needsAttention(pending)).toBe(false);
    const failed = { ...pending, deliveryStatus: 'incomplete' as const };
    expect(needsAttention(failed)).toBe(true);
    expect(taskStatusLabel(failed)).toBe('Delivery needs attention');
    expect(hasOngoingWork(failed)).toBe(false);
    expect(needsAttention({ ...pending, deliveryStatus: 'ready' })).toBe(false);
  });
  it('replaces stream fragments with the final answer and isolates a new direction', () => {
    const events = [
      event(1, 'user_message', { markdown: 'First direction' }),
      event(2, 'assistant_delta', { markdown: 'Frag' }),
      event(3, 'assistant_delta', { markdown: 'ment' })
    ];
    expect(surfaceAnswer(events)).toEqual({ markdown: 'Fragment', partial: true, previous: false });
    events.push(
      event(4, 'assistant_message', { markdown: 'Final answer' }),
      event(5, 'completed', { summary: 'Final answer' })
    );
    expect(surfaceAnswer(events)).toEqual({
      markdown: 'Final answer',
      partial: false,
      previous: false
    });
    events.push(event(6, 'user_message', { markdown: 'Second direction' }));
    expect(surfaceAnswer(events)).toEqual({
      markdown: 'Final answer',
      partial: false,
      previous: true
    });
    events.push(event(7, 'assistant_delta', { markdown: 'Next answer' }));
    expect(surfaceAnswer(events)).toEqual({
      markdown: 'Next answer',
      partial: true,
      previous: false
    });
  });

  it('uses an explicit final answer independently of its short completion receipt', () => {
    const events = [
      event(1, 'user_message', { markdown: 'What is my current stored report label?' }),
      event(2, 'assistant_message', { markdown: 'harbor-cobalt-46' }),
      event(3, 'completed', {
        summary: 'Read current stored owner memory; one active entry supplies the report label.',
        answer: 'harbor-cobalt-46',
        answerChannel: 'final',
        verification: { status: 'verified' }
      })
    ];
    expect(surfaceAnswer(events).markdown).toBe('harbor-cobalt-46');
    events[2] = event(3, 'completed', { summary: 'Stopped without finish', interrupted: true });
    expect(surfaceAnswer(events).markdown).toBe('Stopped without finish');
  });

  it('does not promote progress or a repair message over a newer completion', () => {
    const events = [
      event(1, 'assistant_message', { markdown: 'Published; resubmitting the finish request.' }),
      event(2, 'completed', { summary: 'The analysis is ready.' })
    ];
    expect(surfaceAnswer(events)).toEqual({
      markdown: 'The analysis is ready.',
      partial: false,
      previous: false
    });
    events.push(event(3, 'user_message', { markdown: 'Explore a different hypothesis.' }));
    expect(surfaceAnswer(events).previous).toBe(true);
  });

  it('uses the receipt when this completion has no reply, without borrowing an earlier answer', () => {
    const events = [
      event(1, 'assistant_message', { markdown: 'An earlier answer' }),
      event(2, 'completed', { summary: 'Earlier completion' }),
      event(3, 'user_message', { markdown: 'A new direction' }),
      event(4, 'completed', { summary: 'Completed the new direction' })
    ];
    expect(surfaceAnswer(events).markdown).toBe('Completed the new direction');
    expect(surfaceAnswer([events[3]!]).markdown).toBe('Completed the new direction');
  });

  it('never resurfaces an answered question while a different approval waits', () => {
    const question = event(1, 'question_asked', { question: 'Which format?' });
    expect(activeQuestion([question], task)).toBe(question);
    expect(
      activeQuestion(
        [
          question,
          event(2, 'user_message', { markdown: 'PDF' }),
          event(3, 'approval_requested', {})
        ],
        task
      )
    ).toBeUndefined();
    expect(activeQuestion([question], { ...task, status: 'running' })).toBeUndefined();
  });
});

describe('background task refresh', () => {
  it('retains loaded history and its cursor while applying current task state', () => {
    const older = { ...task, id: '22222222-2222-4222-8222-222222222222', archivedAt: time };
    const current = bootstrap([task, older], 'page-three');
    const fresh = bootstrap([{ ...task, status: 'completed' }], 'page-two');
    const merged = mergeTaskRefresh(current, fresh, true);
    expect(merged.tasks).toHaveLength(2);
    expect(merged.tasks.find((item) => item.id === id)?.status).toBe('completed');
    expect(merged.tasks.find((item) => item.id === older.id)).toEqual(older);
    expect(merged.tasksCursor).toBe('page-three');
    expect(mergeTaskRefresh(current, fresh, false).tasksCursor).toBe('page-two');
  });

  it('keeps a newer state against an old response and respects explicit deletion', () => {
    const latest = { ...task, status: 'completed' as const, updatedAt: '2026-09-06T00:01:00.000Z' };
    const current = bootstrap([latest], null);
    const stale = bootstrap([task], null);
    expect(mergeTaskRefresh(current, stale, false).tasks).toEqual([latest]);
    expect(mergeTaskRefresh(current, stale, false, new Set([task.id])).tasks).toEqual([]);
  });

  it('never carries a previous account task into a new session', () => {
    const current = bootstrap([task], null);
    const fresh = { ...bootstrap([], null), user: { id: 'another-owner' } };
    expect(mergeTaskRefresh(current, fresh, true)).toBe(fresh);
  });
});
