import { describe, expect, it } from 'vitest';
import { Task, type TaskEvent } from '@athanor/contracts';
import type { Bootstrap } from './model.js';
import {
  activeQuestion,
  answerIsStreaming,
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
  it('keeps paused fragments readable without claiming that the model is writing', () => {
    const events = [event(1, 'assistant_delta', { markdown: 'Checking the result.' })];
    expect(answerIsStreaming(events, 'running')).toBe(true);
    expect(answerIsStreaming(events, 'planning')).toBe(true);
    for (const status of [
      'paused',
      'awaiting_user',
      'awaiting_resource',
      'queued',
      'failed',
      'cancelled',
      'completed'
    ] as const) {
      expect(answerIsStreaming(events, status), status).toBe(false);
      expect(surfaceAnswer(events).markdown).toBe('Checking the result.');
    }
    events.push(event(2, 'tool_started', { tool: 'shell' }));
    expect(answerIsStreaming(events, 'running')).toBe(false);
    events.push(event(3, 'assistant_delta', { markdown: 'The check passed.' }));
    expect(answerIsStreaming(events, 'running')).toBe(true);
    events.push(event(4, 'cost', {}));
    expect(answerIsStreaming(events, 'running')).toBe(false);
    events.push(event(5, 'assistant_delta', { markdown: 'Finishing.' }), event(6, 'status', {}));
    expect(answerIsStreaming(events, 'running')).toBe(false);
  });
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

  it('separates responses while preserving chunks, reasoning interleaving and empty heartbeats', () => {
    const events = [
      event(1, 'assistant_delta', { markdown: 'Check', streamId: 'one' }),
      event(2, 'assistant_reasoning', { markdown: 'Thinking' }),
      event(3, 'assistant_delta', { markdown: 'ing.', streamId: 'one' }),
      event(4, 'assistant_delta', { markdown: '', streamId: 'one', heartbeat: true }),
      event(5, 'cost', {}),
      event(6, 'assistant_delta', { markdown: 'Ready.', streamId: 'two' })
    ];
    expect(surfaceAnswer(events).markdown).toBe('Checking.\n\nReady.');
    const recorded = [
      event(1, 'assistant_delta', { markdown: 'First.' }),
      event(2, 'tool_started', {}),
      event(3, 'assistant_delta', { markdown: 'Second.' })
    ];
    expect(surfaceAnswer(recorded).markdown).toBe('First.\n\nSecond.');
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

describe('questions while work continues', () => {
  it('marks project-list attention without changing a working task into a paused one', () => {
    const running = { ...task, status: 'running' as const, hasOpenQuestion: true };
    expect(hasOngoingWork(running)).toBe(true);
    expect(needsAttention(running)).toBe(true);
    expect(taskStatusLabel(running)).toBe('Working · answer requested');
  });

  it('keeps a direction visible while running and closes only on its own answer', () => {
    const question = event(1, 'question_asked', {
      question: 'Which sample?',
      continueWith: 'Quality checks'
    });
    const running = { ...task, status: 'running' as const };
    expect(activeQuestion([question], running)).toBe(question);
    const unrelated = event(2, 'user_message', { markdown: 'Also report lengths.' });
    expect(activeQuestion([question, unrelated], running)).toBe(question);
    const otherAnswer = event(3, 'queued_message', {
      questionId: crypto.randomUUID(),
      markdown: 'Sample B'
    });
    expect(activeQuestion([question, unrelated, otherAnswer], running)).toBe(question);
    const answer = event(4, 'queued_message', { questionId: question.id, markdown: 'Sample A' });
    expect(activeQuestion([question, unrelated, otherAnswer, answer], running)).toBeUndefined();
    expect(activeQuestion([question], { ...task, status: 'cancelled' })).toBeUndefined();
  });
});

describe('completion wording follows recorded outcome', () => {
  const ended = { ...task, status: 'completed' as const };
  const activity = {
    currentStep: null,
    stepsCompleted: 1,
    stepsSkipped: 1,
    stepsTotal: 2,
    latest: '',
    eventId: null,
    observedAt: null
  };
  it('does not describe an ended worker as a successful request without evidence', () => {
    expect(taskStatusLabel(ended)).toBe('Run ended');
    expect(taskStatusLabel({ ...ended, activity: { ...activity, stepsSkipped: 0 } })).toBe(
      'Stopped with 1 step open'
    );
    expect(
      taskStatusLabel({
        ...ended,
        activity: { ...activity, ending: { interrupted: true, verification: 'verified' } }
      })
    ).toBe('Interrupted · review needed');
    expect(
      taskStatusLabel({
        ...ended,
        activity: { ...activity, ending: { interrupted: false, verification: 'unverified' } }
      })
    ).toBe('Needs review');
    expect(
      taskStatusLabel({
        ...ended,
        activity: { ...activity, ending: { interrupted: false, verification: 'verified' } }
      })
    ).toBe('Completed');
  });
});
