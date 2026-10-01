import { describe, expect, it } from 'vitest';
import type { TaskEvent, TaskPlan, TaskResult } from '@garden/contracts';
import { projectWorkSurface } from './work-surface-projection.js';

const event = (sequence: number, kind: TaskEvent['kind'], payload: unknown): TaskEvent => ({
  id: `event-${sequence}`,
  taskId: 'task',
  sequence,
  kind,
  payload,
  summary: kind,
  createdAt: new Date(sequence * 1000).toISOString()
});
describe('current work presentation', () => {
  it('switches immediately to new owner steering while retaining previous directions and results', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Build an app' }),
      event(3, 'preview', { previewId: 'preview' }),
      event(4, 'plan', {
        presentation: {
          directionEventId: 'event-1',
          content: { title: 'App', acknowledgment: 'I will build it.', blocks: [] }
        }
      }),
      event(5, 'queued_message', { markdown: 'Compare the options instead' })
    ];
    const plan = {
      presentation: {
        directionEventId: 'event-1',
        content: { title: 'App', acknowledgment: 'I will build it.', blocks: [] }
      },
      id: 'plan',
      taskId: 'task',
      version: 1,
      parentVersion: null,
      branchName: 'Main',
      steps: [{ id: 'step', title: 'Work', status: 'pending' }],
      createdBy: 'agent',
      createdAt: new Date(0).toISOString()
    } satisfies TaskPlan;
    const results = [{ id: 'preview', evidenceEventIds: ['event-3'] }] as TaskResult[];
    const projected = projectWorkSurface(events, plan, results);
    expect(projected.direction).toMatchObject({ eventId: 'event-5', queued: true });
    expect(projected.report).toBeNull();
    expect(projected.currentResultIds).toEqual([]);
    expect(projected.directions).toHaveLength(2);
    expect(projected.directions[0]?.acknowledgment).toBe('I will build it.');
    expect(results).toHaveLength(1);
  });
  it('collapses only consumed queue identities and acknowledges a direction from its actual plan', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Check it again' }),
      event(2, 'queued_message', { markdown: 'Check it again', messageId: 'first-repeat' }),
      event(3, 'user_message', { markdown: 'Check it again', messageId: 'first-repeat' }),
      event(4, 'plan', {
        directionEventId: 'event-3',
        steps: [{ title: 'Recheck the reported totals' }]
      }),
      event(5, 'queued_message', { markdown: 'Check it again', messageId: 'second-repeat' }),
      event(6, 'queued_message', { markdown: 'Keep this legacy correction' }),
      event(7, 'user_message', { markdown: 'Keep this legacy correction', messageId: 'event-6' }),
      event(8, 'plan', { directionEventId: 'event-3', steps: [{ title: 'Obsolete direction' }] }),
      event(9, 'queued_message', { markdown: 'Unlinked repeated words' }),
      event(10, 'user_message', { markdown: 'Unlinked repeated words' })
    ];
    const projected = projectWorkSurface(events, null, []);
    expect(projected.directions.map((direction) => direction.eventId)).toEqual([
      'event-1',
      'event-3',
      'event-5',
      'event-7',
      'event-9',
      'event-10'
    ]);
    expect(
      projected.directions.filter((direction) => direction.text === 'Check it again')
    ).toHaveLength(3);
    expect(projected.directions.find((direction) => direction.eventId === 'event-3')).toMatchObject(
      {
        queued: false,
        messageId: 'first-repeat',
        acknowledgment: 'Recheck the reported totals'
      }
    );
    expect(
      projected.directions.find((direction) => direction.eventId === 'event-7')?.acknowledgment
    ).toBeUndefined();
    expect(projected.direction?.eventId).toBe('event-10');
  });
  it('deduplicates discovered/read sources and never calls a search snippet a read page', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Research' }),
      event(2, 'tool_started', { toolCallId: 'search', tool: 'web_search' }),
      event(3, 'tool_result', {
        toolCallId: 'search',
        result: { results: [{ url: 'https://example.test/a' }, { url: 'https://example.test/b' }] }
      }),
      event(4, 'tool_started', { toolCallId: 'read', tool: 'parallel_web_read' }),
      event(5, 'tool_result', {
        toolCallId: 'read',
        result: {
          sources: [
            { url: 'https://example.test/a', text: 'Full page' },
            { url: 'https://example.test/b', error: 'Denied' }
          ]
        }
      })
    ];
    expect(
      projectWorkSurface(events, null, []).sources.map(({ url, state }) => ({ url, state }))
    ).toEqual([
      { url: 'https://example.test/a', state: 'read' },
      { url: 'https://example.test/b', state: 'discovered' }
    ]);
  });
  it('only resolves chart values and safe source links from actual tool receipts', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Analyze' }),
      event(2, 'tool_result', { toolCallId: 'measure', result: { count: 17 } })
    ];
    const plan = {
      presentation: {
        directionEventId: 'event-1',
        content: {
          title: 'Counts',
          acknowledgment: 'I will compare the counts.',
          blocks: [
            {
              kind: 'chart',
              title: 'Sample',
              unit: 'reads',
              points: [
                { label: 'A', value: { toolCallId: 'measure', pointer: '/count' } },
                { label: 'B', value: { toolCallId: 'absent', pointer: '/count' } }
              ]
            }
          ]
        }
      },
      id: 'plan',
      taskId: 'task',
      version: 1,
      parentVersion: null,
      branchName: 'Main',
      steps: [{ id: 'step', title: 'Work', status: 'pending' }],
      createdBy: 'agent',
      createdAt: new Date(0).toISOString()
    } satisfies TaskPlan;
    const projected = projectWorkSurface(events, plan, []);
    expect(projected.references).toEqual([
      {
        toolCallId: 'measure',
        pointer: '/count',
        value: 17,
        eventId: 'event-2',
        sequence: 2,
        label: 'tool_result'
      }
    ]);
    expect(projected.unavailableReferences).toBe(1);
  });
});

/**
 * What survives a follow-up.
 *
 * A direction opens a new epoch and results from before it stop being "current", which is right for
 * a written answer - the owner asked for something else, and the previous reply is history. It was
 * wrong for a published app. Nothing unpublished it, the URL still serves, and the owner's own
 * follow-up was what took it off the project view: measured on one real run, three publications each
 * disappeared from the served area the moment the next direction landed.
 */
describe('results that outlast the direction that made them', () => {
  const preview = (sequence: number, previewId: string): TaskEvent =>
    event(sequence, 'preview', { previewId });
  /** A whole result, so a fixture cannot pass by being too small to disagree with the contract. */
  const result = (over: Partial<TaskResult> & Pick<TaskResult, 'id' | 'kind'>): TaskResult => ({
    title: 'Result',
    status: 'ready',
    url: null,
    downloadUrl: null,
    accessPath: null,
    evidenceEventIds: [],
    ...over
  });

  it('keeps a live preview current across a later direction', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Build a site' }),
      preview(2, 'preview-one'),
      event(3, 'user_message', { markdown: 'Now add a scoreboard' })
    ];
    const results = [
      result({
        id: 'result-one',
        kind: 'preview',
        previewId: 'preview-one',
        evidenceEventIds: ['event-2']
      })
    ];
    expect(projectWorkSurface(events, null, results).currentResultIds).toEqual(['result-one']);
  });

  it('keeps a published artifact current across a later direction', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Write the report' }),
      event(2, 'artifact', { artifactId: 'artifact-one' }),
      event(3, 'user_message', { markdown: 'Now summarise it' })
    ];
    const results = [
      result({
        id: 'result-one',
        kind: 'artifact',
        artifactId: 'artifact-one',
        evidenceEventIds: ['event-2']
      })
    ];
    expect(projectWorkSurface(events, null, results).currentResultIds).toEqual(['result-one']);
  });

  it('keeps only the latest download for a confirmed source while retaining distinct sources with the same name', () => {
    const publish = (sequence: number, path: string, id: string) => [
      event(sequence, 'tool_started', {
        tool: 'publish_artifact',
        toolCallId: id,
        arguments: { path }
      }),
      event(sequence + 1, 'tool_result', { toolCallId: id, result: { artifactId: id } }),
      event(sequence + 2, 'artifact', { artifactId: id, name: 'app.html' })
    ];
    const events = [
      event(1, 'user_message', { markdown: 'Build the app' }),
      ...publish(2, 'app.html', 'old'),
      event(5, 'user_message', { markdown: 'Change its default' }),
      ...publish(6, 'workspace/app.html', 'current'),
      ...publish(9, 'other/app.html', 'distinct')
    ];
    const results = ['old', 'current', 'distinct'].map((id, index) =>
      result({
        id,
        kind: 'artifact',
        artifactId: id,
        title: 'app.html',
        evidenceEventIds: [`event-${[4, 8, 11][index]}`]
      })
    );
    expect(projectWorkSurface(events, null, results).currentResultIds).toEqual([
      'current',
      'distinct'
    ]);
    expect(results.map((item) => item.id)).toEqual(['old', 'current', 'distinct']);
    const explanation = [...events, event(12, 'user_message', { markdown: 'Explain the result' })];
    expect(projectWorkSurface(explanation, null, results).currentResultIds).toEqual([
      'current',
      'distinct'
    ]);
    expect(projectWorkSurface(events.slice(0, 6), null, results).currentResultIds).toContain('old');
    const refused = [
      ...events,
      event(12, 'tool_started', {
        tool: 'publish_artifact',
        toolCallId: 'refused',
        arguments: { path: 'app.html' }
      }),
      event(13, 'tool_result', {
        toolCallId: 'refused',
        result: { error: 'Publication failed', artifactId: 'distinct' }
      })
    ];
    expect(projectWorkSurface(refused, null, results).currentResultIds).toEqual([
      'current',
      'distinct'
    ]);
  });

  it('still drops an ordinary result from a previous direction', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Answer this' }),
      event(2, 'assistant_message', { markdown: 'Here it is' }),
      event(3, 'user_message', { markdown: 'Now answer that' })
    ];
    const results = [result({ id: 'result-one', kind: 'file', evidenceEventIds: ['event-2'] })];
    expect(projectWorkSurface(events, null, results).currentResultIds).toEqual([]);
  });

  it('does not resurrect a result whose publication this task never recorded', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Build a site' }),
      event(3, 'user_message', { markdown: 'Now add a scoreboard' })
    ];
    const results = [result({ id: 'result-one', kind: 'preview', previewId: 'preview-elsewhere' })];
    expect(projectWorkSurface(events, null, results).currentResultIds).toEqual([]);
  });
});
