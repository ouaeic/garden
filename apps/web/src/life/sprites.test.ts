import { describe, expect, it } from 'vitest';
import * as art from './sprites';
import { growth } from './growth';
import type { Frames } from './growth';

/** Every sprite in the garden, flattened to named frame lists. */
function catalogue() {
  const named: [string, Frames][] = [];
  const visit = (name: string, value: unknown) => {
    if (!Array.isArray(value)) {
      if (value && typeof value === 'object')
        for (const [key, inner] of Object.entries(value)) visit(`${name}.${key}`, inner);
      return;
    }
    named.push([name, (typeof value[0] === 'string' ? [value] : value) as Frames]);
  };
  for (const [name, value] of Object.entries({ ...art, growth })) visit(name, value);
  return named;
}

describe('garden sprites', () => {
  const sprites = catalogue();
  it('finds the whole catalogue', () => {
    expect(sprites.length).toBeGreaterThan(15);
  });
  it.each(sprites)(
    '%s keeps one size across its frames and uses only the four shades',
    (_, frames) => {
      expect(frames.length).toBeGreaterThan(0);
      const width = frames[0]![0]!.length;
      const height = frames[0]!.length;
      for (const frame of frames) {
        expect(frame).toHaveLength(height);
        for (const row of frame) {
          expect(row).toHaveLength(width);
          expect(row).toMatch(/^[.0-3]+$/);
        }
      }
    }
  );
});
