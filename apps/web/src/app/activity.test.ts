import { describe, expect, it } from 'vitest';
import { doingText } from './activity';

describe('what a run is doing, said plainly', () => {
  it('names a tool by what it does and leaves other lines as they were written', () => {
    expect(doingText('Running parallel_web_read')).toBe('Reading pages');
    expect(doingText('Running shell npm test')).toBe('Running a command npm test');
    expect(doingText('Running some_new_tool')).toBe('Running some_new_tool');
    expect(doingText('Recomputing clusters')).toBe('Recomputing clusters');
    expect(doingText('shell')).toBe('Running a command');
  });
});
