import { describe, expect, it } from 'vitest';
import { compose, EMPTY, toneNearer, type Layer } from './garden-scene';

const sizes: [number, number][] = [
  [720, 450],
  [960, 540],
  [195, 422],
  [512, 384]
];
const filled = (l: Layer, x0: number, y0: number, x1: number, y1: number) => {
  let count = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) if (l.px[y * l.w + x] !== EMPTY) count++;
  return count / ((x1 - x0) * (y1 - y0));
};

describe('the garden scene', () => {
  it.each(sizes)('grows the same garden every time for %i by %i dots', (w, h) => {
    const a = compose(w, h);
    const b = compose(w, h);
    expect(a.back.px).toEqual(b.back.px);
    expect(a.near[0].px).toEqual(b.near[0].px);
    expect([a.back.w, a.back.h, a.near[1].w, a.near[1].h]).toEqual([w, h, w, h]);
  });

  it.each(sizes)('uses only the four shades at %i by %i', (w, h) => {
    const { back, near, drifters } = compose(w, h);
    expect(drifters.length).toBeGreaterThan(0);
    let stray = 0;
    for (const l of [back, ...near, ...drifters.map((d) => d.sprite)])
      for (const shade of l.px) if (shade !== EMPTY && shade > 3) stray++;
    expect(stray).toBe(0);
  });

  // The gutters cards leave are where the garden is seen, so leaves and wood must fill them.
  it.each(sizes)('fills the edges of a %i by %i screen with the near garden', (w, h) => {
    const { near } = compose(w, h);
    expect(filled(near[0], 0, Math.round(h * 0.1), 8, Math.round(h * 0.9))).toBeGreaterThan(0.7);
    expect(filled(near[0], w - 8, Math.round(h * 0.1), w, Math.round(h * 0.9))).toBeGreaterThan(
      0.7
    );
    expect(filled(near[0], 0, h - 6, w, h)).toBeGreaterThan(0.7);
  });

  it("moves something between the breeze's two poses", () => {
    const { near } = compose(720, 450);
    let moved = 0;
    for (let i = 0; i < near[0].px.length; i++) if (near[0].px[i] !== near[1].px[i]) moved++;
    expect(moved).toBeGreaterThan(500);
  });

  it('moves every shade a step nearer the background, lighter by day and darker at night', () => {
    const scene = compose(195, 422);
    const day: [number, number, number, number][] = [
      [0, 0, 0, 255],
      [1, 1, 1, 255],
      [2, 2, 2, 255],
      [3, 3, 3, 255]
    ];
    const seen = (night: boolean) => {
      const out = toneNearer(scene, day, night);
      const shades = new Set<number>();
      for (let i = 0; i < out.length; i += 4) shades.add(out[i]!);
      return shades;
    };
    // By day nothing is left in the darkest shade; at night nothing in the brightest.
    expect([...seen(false)].sort()).toEqual([0, 1, 2]);
    expect([...seen(true)].sort()).toEqual([0, 2]);
  });
});
