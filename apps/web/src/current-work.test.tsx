import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskEvent, TaskPresentation, WorkSurfaceView } from '@garden/contracts';
import { currentWork } from './current-work';
import { WorkDirections } from './WorkDirections';
import WorkTrace from './WorkTrace';

const surface: WorkSurfaceView = {
  direction: { eventId: 'first', sequence: 1, text: 'Plan Japan', queued: false, truncated: false },
  directions: [
    { eventId: 'first', sequence: 1, text: 'Plan Japan', queued: false, truncated: false }
  ],
  report: {
    directionEventId: 'first',
    content: {
      title: 'A quiet week',
      acknowledgment: 'I will compare the quieter stops.',
      blocks: [
        {
          kind: 'table',
          title: 'Stops',
          columns: ['Place', 'Character'],
          rows: [{ cells: ['Kyoto', 'Temples and gardens'] }]
        }
      ]
    }
  },
  references: [],
  currentResultIds: ['file'],
  sources: [],
  unavailableReferences: 0
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
  it('removes obsolete report and plan immediately when steering arrives before an API refresh', () => {
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
    expect(next.surface?.report).toBeNull();
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
  it('renders meaningful model-composed content and the actual acknowledgment without an empty evidence column', () => {
    const html = renderToStaticMarkup(
      <>
        <WorkDirections surface={surface} onRevisit={() => undefined} />
        <WorkTrace
          progress={presentation.progress}
          surface={surface}
          onEvidence={() => undefined}
        />
      </>
    );
    expect(html).toContain('Plan Japan');
    expect(html).toContain('I will compare the quieter stops.');
    expect(html).toContain('Temples and gardens');
    expect(html).not.toContain('<th>Evidence</th>');
    expect(html).toContain('Edit / revisit');
  });
});
