import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '@garden/contracts';
import { doneWhen, notesFrom, outcome } from './timeline';

let sequence = 0;
const event = (
  kind: TaskEvent['kind'],
  payload: Record<string, unknown> = {},
  summary = kind
): TaskEvent =>
  ({
    id: `e${++sequence}`,
    taskId: 't',
    kind,
    sequence,
    summary,
    payload,
    createdAt: `2026-10-05T10:${String(sequence).padStart(2, '0')}:00.000Z`
  }) as TaskEvent;

describe('the notes a goal keeps', () => {
  it('keeps words written beside the work, and leaves the answer to the work', () => {
    const notes = notesFrom([
      event('user_message', { markdown: 'Reanalyse the RNA-seq data' }),
      event('assistant_message', { markdown: 'Two samples ran on another platform.' }),
      event('tool_started', { tool: 'shell' }),
      event('tool_result', { tool: 'shell' }),
      event('assistant_message', { markdown: 'Here is the reanalysis.' }),
      event('completed', { verification: { status: 'verified' }, summary: 'Done' })
    ]);
    expect(notes.map((note) => [note.kind, note.title])).toEqual([
      ['checked', 'Checked: every declared check passed'],
      ['note', 'Two samples ran on another platform.'],
      ['you', 'Reanalyse the RNA-seq data']
    ]);
  });

  it('never makes a tool call a note', () => {
    expect(notesFrom([event('tool_started', { tool: 'shell' }), event('tool_result')])).toEqual([]);
  });

  it('reads the agreed check from the deal the goal was planted with', () => {
    const planted = event('user_message', {
      markdown: 'Deal agreed.\nGoal: Taxes. A return.\nDone when: It passes validation.'
    });
    expect(doneWhen([planted])).toBe('It passes validation.');
    expect(notesFrom([planted])[0]).toMatchObject({ kind: 'deal', title: 'Deal agreed' });
    expect(doneWhen([event('user_message', { markdown: 'Just do it' })])).toBeNull();
  });

  it('says what came of a finished goal in its last completion’s words', () => {
    expect(
      outcome([
        event('completed', { summary: 'A first draft.' }),
        event('user_message', { markdown: 'Again, shorter' }),
        event('completed', { summary: 'A return ready to file.' })
      ])
    ).toBe('A return ready to file.');
    expect(outcome([event('assistant_message', { markdown: 'Working' })])).toBeNull();
  });
});
