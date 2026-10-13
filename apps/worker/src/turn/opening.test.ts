import { describe, expect, it } from 'vitest';
import { openingCalls } from './opening.js';

const reads = (request: string): string[] =>
  openingCalls([{ role: 'user', content: request }], 1).map((call) =>
    call.arguments.path === undefined ? 'LIST' : `${call.name}:${call.arguments.path as string}`
  );

describe('the listing a turn opens with', () => {
  it('lists the working directory even when the request names nothing', () => {
    expect(reads('Make the tests pass.')).toEqual(['LIST']);
  });

  it('lists a folder the request points at', () => {
    expect(reads('The examples are in /app/examples/ticket-4471/.')).toEqual([
      'LIST',
      'files_list:/app/examples/ticket-4471/'
    ]);
  });

  it('leaves the files a request names to the model', () => {
    expect(reads('Fix /app/run.py using notes.md, then check `data/input.csv`.')).toEqual(['LIST']);
  });
});
