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
    const reference = prompt.split('Selected analysis reference: ')[1];
    expect(reference).toBeDefined();
    expect(JSON.parse(reference!)).toEqual(selected);
    expect(prompt).toContain('Preserve the original scripts, inputs and outputs');
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
      'Rerun the selected analysis'
    );
  });
});
