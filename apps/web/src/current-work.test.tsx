import { describe, expect, it } from 'vitest';
import type { TaskEvent, TaskPresentation, WorkSurfaceView } from '@garden/contracts';
import { currentWork } from './current-work';

const surface: WorkSurfaceView = {
  direction: { eventId: 'first', sequence: 1, text: 'Plan Japan', queued: false, truncated: false },
  directions: [
    { eventId: 'first', sequence: 1, text: 'Plan Japan', queued: false, truncated: false }
  ],
  currentResultIds: ['file'],
  sources: []
};
const presentation = {
  version: 1,
  taskId: 'task',
  eventCursor: 5,
  results: [],
  surface,
  progress: {
    kind: 'research',
    phases: [{ id: 'old', title: 'Old plan', status: 'completed' }],
    history: [],
    current: null,
    metrics: [],
    milestones: [],
    updatedAt: null
  }
} satisfies TaskPresentation;
describe('owner-directed work surface', () => {
  it('keeps the served app mounted while a direction arrives ahead of its projection', () => {
    const preview = {
      id: 'app',
      previewId: 'served',
      kind: 'preview' as const,
      title: 'Working app',
      status: 'ready' as const,
      url: null,
      accessPath: '/v1/previews/served/access',
      downloadUrl: null,
      evidenceEventIds: ['published']
    };
    const before = {
      ...presentation,
      results: [preview],
      surface: { ...surface, currentResultIds: ['app', 'file'] }
    };
    const next = currentWork(before, [
      {
        id: 'edit',
        taskId: 'task',
        sequence: 6,
        kind: 'user_message',
        payload: { markdown: 'Change the default.' },
        summary: 'Edit',
        createdAt: new Date(0).toISOString()
      }
    ])!;
    expect(next.surface?.currentResultIds).toEqual(['app']);
    expect(next.results[0]).toBe(preview);
    expect(next.progress.phases).toEqual([]);
  });
  it('removes the obsolete plan immediately when steering arrives before an API refresh', () => {
    const next = currentWork(presentation, [
      {
        id: 'next',
        taskId: 'task',
        sequence: 6,
        kind: 'queued_message',
        payload: { markdown: 'Now build a comparison website' },
        summary: 'Queued',
        createdAt: new Date().toISOString()
      }
    ] as TaskEvent[])!;
    expect(next.surface?.direction?.text).toBe('Now build a comparison website');
    expect(next.surface?.currentResultIds).toEqual([]);
    expect(next.progress.phases).toEqual([]);
    expect(next.surface?.directions[0]?.text).toBe('Plan Japan');
  });
  it('replaces a consumed queued direction by identity during the event-stream update', () => {
    const queued = {
      eventId: 'queued',
      messageId: 'message',
      sequence: 6,
      text: 'Plan Japan',
      queued: true,
      truncated: false
    };
    const before = {
      ...presentation,
      surface: { ...surface, direction: queued, directions: [...surface.directions, queued] }
    };
    const next = currentWork(before, [
      {
        id: 'consumed',
        taskId: 'task',
        sequence: 7,
        kind: 'user_message',
        payload: { markdown: 'Plan Japan', messageId: 'message' },
        summary: 'Owner direction',
        createdAt: new Date(0).toISOString()
      }
    ])!;
    expect(next.surface?.directions.map((direction) => direction.eventId)).toEqual([
      'first',
      'consumed'
    ]);
    expect(next.surface?.direction).toMatchObject({ messageId: 'message', queued: false });
    expect(next.surface?.directions.map((direction) => direction.text)).toEqual([
      'Plan Japan',
      'Plan Japan'
    ]);
  });
});
