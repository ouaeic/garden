import { describe, expect, it } from 'vitest';
import { ComputationWire } from './computation-wire.js';

describe('computation output framing', () => {
  it('preserves arbitrary Unicode output and split packet boundaries', () => {
    const text: string[] = [],
      packets: string[] = [];
    const wire = new ComputationWire(
      'garden:secret:',
      (value) => text.push(value),
      (value) => packets.push(value)
    );
    for (const chunk of [
      'α😀βgar',
      'den:sec',
      'ret:{"kind":"ready"}\nplain',
      'garden:secret:{"kind":"done"}\n',
      '🙂'
    ])
      wire.push(chunk);
    expect(text.join('')).toBe('α😀βplain🙂');
    expect(packets).toEqual(['{"kind":"ready"}', '{"kind":"done"}']);
  });
  it('streams large output without a newline while still bounding protocol packets', () => {
    let bytes = 0;
    const packets: string[] = [];
    const wire = new ComputationWire(
      'garden:secret:',
      (value) => {
        bytes += Buffer.byteLength(value);
      },
      (value) => packets.push(value)
    );
    const chunk = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 8; index++) wire.push(chunk);
    wire.push('garden:secret:{"kind":"done"}\n');
    expect(bytes).toBe(8 * 1024 * 1024);
    expect(packets).toEqual(['{"kind":"done"}']);
    const plotPacket = JSON.stringify({
      artifacts: Array.from({ length: 4 }, () => ({
        base64: Buffer.alloc(2 * 1024 * 1024).toString('base64')
      }))
    });
    wire.push('garden:secret:' + plotPacket + '\n');
    expect(packets.at(-1)).toBe(plotPacket);
    expect(() => wire.push('garden:secret:' + chunk.repeat(13))).toThrow('exceeded limit');
  });
  it('returns a false prefix to ordinary output and does not reinterpret packet content', () => {
    const text: string[] = [],
      packets: string[] = [];
    const wire = new ComputationWire(
      'garden:secret:',
      (value) => text.push(value),
      (value) => packets.push(value)
    );
    wire.push('garden:sec');
    wire.push('tion\ngarden:secret:{"text":"garden:secret: in data"}\n');
    expect(text.join('')).toBe('garden:section\n');
    expect(packets).toEqual(['{"text":"garden:secret: in data"}']);
  });
});
