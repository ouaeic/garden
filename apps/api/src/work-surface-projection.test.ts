import { describe, expect, it } from 'vitest';
import type { TaskEvent, TaskResult } from '@garden/contracts';
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
  it('switches immediately to new owner steering while retaining previous directions', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Build an app' }),
      event(3, 'preview', { previewId: 'preview' }),
      event(5, 'queued_message', { markdown: 'Compare the options instead' })
    ];
    const results = [{ id: 'preview', evidenceEventIds: ['event-3'] }] as TaskResult[];
    const projected = projectWorkSurface(events, results);
    expect(projected.direction).toMatchObject({ eventId: 'event-5', queued: true });
    expect(projected.currentResultIds).toEqual([]);
    expect(projected.directions).toHaveLength(2);
  });
  it('collapses only consumed queue identities', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Check it again' }),
      event(2, 'queued_message', { markdown: 'Check it again', messageId: 'first-repeat' }),
      event(3, 'user_message', { markdown: 'Check it again', messageId: 'first-repeat' }),
      event(5, 'queued_message', { markdown: 'Check it again', messageId: 'second-repeat' }),
      event(6, 'queued_message', { markdown: 'Keep this legacy correction' }),
      event(7, 'user_message', { markdown: 'Keep this legacy correction', messageId: 'event-6' }),
      event(9, 'queued_message', { markdown: 'Unlinked repeated words' }),
      event(10, 'user_message', { markdown: 'Unlinked repeated words' })
    ];
    const projected = projectWorkSurface(events, []);
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
      { queued: false, messageId: 'first-repeat' }
    );
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
      projectWorkSurface(events, []).sources.map(({ url, state }) => ({ url, state }))
    ).toEqual([
      { url: 'https://example.test/a', state: 'read' },
      { url: 'https://example.test/b', state: 'discovered' }
    ]);
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
    expect(projectWorkSurface(events, results).currentResultIds).toEqual(['result-one']);
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
    expect(projectWorkSurface(events, results).currentResultIds).toEqual(['result-one']);
  });

  it('keeps the highest confirmed source version current without tool receipts and preserves distinct same-name sources', () => {
    const events = [
      event(1, 'artifact', { artifactId: 'old' }),
      event(2, 'artifact', { artifactId: 'current' }),
      event(3, 'artifact', { artifactId: 'distinct' }),
      event(4, 'user_message', { markdown: 'Explain the app' })
    ];
    const results = ['current', 'old', 'distinct', 'legacy', 'unconfirmed'].map((id) =>
      result({
        id,
        kind: 'artifact',
        artifactId: id,
        title: 'app.html',
        version: id === 'current' ? 2 : id === 'unconfirmed' ? 3 : 1,
        evidenceEventIds: ['event-1']
      })
    );
    const sources = new Map([
      ['old', 'workspace:app'],
      ['current', 'workspace:app'],
      ['distinct', 'other-workspace:app'],
      ['unconfirmed', 'workspace:app']
    ]);
    expect(projectWorkSurface(events, results, sources).currentResultIds).toEqual([
      'current',
      'distinct'
    ]);
    expect(projectWorkSurface(events, [...results].reverse(), sources).currentResultIds).toEqual([
      'distinct',
      'current'
    ]);
    expect(results).toHaveLength(5);
    expect(projectWorkSurface(events, results).currentResultIds).toContain('old');
    const legacy = [...events, event(5, 'artifact', { artifactId: 'legacy' })];
    expect(projectWorkSurface(legacy, results, sources).currentResultIds).toContain('legacy');
  });

  it('still drops an ordinary result from a previous direction', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Answer this' }),
      event(2, 'assistant_message', { markdown: 'Here it is' }),
      event(3, 'user_message', { markdown: 'Now answer that' })
    ];
    const results = [result({ id: 'result-one', kind: 'file', evidenceEventIds: ['event-2'] })];
    expect(projectWorkSurface(events, results).currentResultIds).toEqual([]);
  });

  it('does not resurrect a result whose publication this task never recorded', () => {
    const events = [
      event(1, 'user_message', { markdown: 'Build a site' }),
      event(3, 'user_message', { markdown: 'Now add a scoreboard' })
    ];
    const results = [result({ id: 'result-one', kind: 'preview', previewId: 'preview-elsewhere' })];
    expect(projectWorkSurface(events, results).currentResultIds).toEqual([]);
  });
});
