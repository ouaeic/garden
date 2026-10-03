import { describe, expect, it } from 'vitest';
import { DirectionContext } from '@garden/contracts';
import { directionPrompt } from './direction-context';

const selected = {
  kind: 'analysis' as const,
  workspaceId: '10000000-0000-4000-8000-000000000001',
  manifestPath: 'workspace/runs/counts.json',
  sha256: 'a'.repeat(64),
  runId: '20000000-0000-4000-8000-000000000002',
  name: 'Counts "quoted"\nreference'
};
describe('directions with retained references', () => {
  it('keeps the owner request and selected run identity without embedding recorded commands', () => {
    const prompt = directionPrompt('Use a minimum length of 20.', selected, selected.workspaceId);
    expect(prompt.startsWith('Use a minimum length of 20.')).toBe(true);
    const reference = prompt.split('as a separate run that keeps the original: ')[1];
    expect(reference).toBeDefined();
    expect(JSON.parse(reference!)).toEqual(selected);
  });
  it('refuses references from another execution directory and oversized combined messages', () => {
    expect(() => directionPrompt('Run it', selected, 'other')).toThrow(
      'different execution directory'
    );
    expect(() =>
      directionPrompt(
        'x'.repeat(199_999),
        { kind: 'selection', text: 'details' },
        selected.workspaceId
      )
    ).toThrow('too long');
    expect(directionPrompt('  hello  ', null, selected.workspaceId)).toBe('hello');
  });
  it('bounds and validates persisted reference paths without interpreting selection text as a run', () => {
    expect(DirectionContext.parse(selected)).toEqual(selected);
    const invalid = [
      '/etc/passwd',
      'workspace/../secret',
      'workspace/./run.json',
      'workspace//run.json',
      'workspace/a\\b',
      'workspace/a\nrun.json'
    ];
    expect(invalid.length).toBeGreaterThan(0);
    for (const manifestPath of invalid)
      expect(DirectionContext.safeParse({ ...selected, manifestPath }).success).toBe(false);
    const selection = { kind: 'selection' as const, text: JSON.stringify(selected) };
    expect(directionPrompt('Explain', selection, selected.workspaceId)).not.toContain(
      'Rerun this recorded analysis'
    );
  });
});

describe('comments on a result', () => {
  it('says where each comment points in the content’s own words, numbered as pinned', () => {
    const prompt = directionPrompt(
      '',
      {
        kind: 'notes',
        notes: [
          {
            on: 'the answer',
            anchor: { kind: 'text', quote: 'Aster  lasts\nlongest' },
            note: 'By how much?'
          },
          {
            on: 'comparison.html',
            anchor: {
              kind: 'point',
              path: 'div.bar:nth-of-type(2)',
              label: 'Brook 64%',
              context: 'Three laptops compared',
              x: 0.3,
              y: 0.5
            },
            note: ''
          },
          {
            on: 'results.csv',
            anchor: { kind: 'cell', row: 11, column: 'p_value', value: '0.03' },
            note: 'Is this corrected?'
          },
          {
            on: 'report.pdf',
            anchor: { kind: 'page', page: 3, x: 0.5, y: 0.25, text: 'Figure 2' },
            note: 'Bigger'
          },
          { on: 'old.html', quote: 'legacy', note: 'still reads' }
        ]
      },
      selected.workspaceId
    );
    expect(prompt).toBe(
      'My comments, numbered as I pinned them:\n' +
        '1. the answer on “Aster lasts longest”: By how much?\n' +
        '2. comparison.html at “Brook 64%” under “Three laptops compared” (div.bar:nth-of-type(2)): (look at this)\n' +
        '3. results.csv at row 12, column “p_value” (“0.03”): Is this corrected?\n' +
        '4. report.pdf on page 3 near “Figure 2” (50% across, 25% down): Bigger\n' +
        '5. old.html on “legacy”: still reads'
    );
  });
});
