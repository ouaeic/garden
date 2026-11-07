import { describe, expect, it } from 'vitest';
import { kindOf } from './kinds';

describe('which shelf a file sits on', () => {
  it('reads the extension first, then the declared type, then calls it a file', () => {
    expect(kindOf('brief.pdf').id).toBe('doc');
    expect(kindOf('deck.pptx').id).toBe('slides');
    expect(kindOf('Revenue by SKU (CSV)', 'text/csv').id).toBe('data');
    expect(kindOf('Weekly report', 'text/markdown; charset=utf-8').id).toBe('doc');
    expect(kindOf('Landing page', 'text/html').id).toBe('site');
    expect(kindOf('Crumb & Co — bakery one-pager', 'application/octet-stream').id).toBe('other');
  });
});
