import { describe, expect, it } from 'vitest';
import { openingCalls } from './opening.js';

const reads = (request: string): string[] =>
  openingCalls([{ role: 'user', content: request }], 1).map((call) =>
    call.name === 'files_list' && !call.arguments.path
      ? 'LIST'
      : `${call.name}:${String(call.arguments.path)}`
  );

describe('the reads a turn opens with', () => {
  it('lists the working directory even when the request names nothing', () => {
    expect(reads('Make the tests pass.')).toEqual(['LIST']);
  });

  it('reads the files a request names by path or by a text-file name', () => {
    expect(reads('Fix /app/run.py using notes.md, then check `data/input.csv`.')).toEqual([
      'LIST',
      'file_read:/app/run.py',
      'file_read:notes.md',
      'file_read:data/input.csv'
    ]);
  });

  it('lists a folder the request points at', () => {
    expect(reads('The examples are in /app/examples/ticket-4471/.')).toEqual([
      'LIST',
      'files_list:/app/examples/ticket-4471/'
    ]);
  });

  it('does not take a dotted name in prose for a file', () => {
    expect(reads('Entries are np.float64; call os.path.join; see example.com.')).toEqual(['LIST']);
  });

  it('leaves binary outputs to the model', () => {
    expect(reads('Save the chart to /app/revenue.png.')).toEqual(['LIST']);
  });
});
