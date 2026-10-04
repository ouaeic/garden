/*
 * The garden behind the screen: a clearing seen from under the trees. A canopy hangs across the
 * top, trunks stand at both edges and ferns and grass grow along the bottom, so the edges of the
 * screen - the space cards leave free - are always leaves and wood. Behind them the clearing opens
 * onto a meadow, groves at its edges, a forest and hills in haze, with light falling through.
 *
 * Distance is value. Far things are pale, dithered and undrawn; near things are dark and leafy.
 * Every mass is shaded the same way: lit from the top left, darker underneath, broken up by a leaf
 * texture, and dithered between the screen's four shades with an ordered pattern, as a 4-shade
 * screen would. The layout is seeded, so a window of a given size always grows the same garden.
 */

export type Shade = 0 | 1 | 2 | 3;
/** A grid of shades, one per dot; `EMPTY` lets what is behind show through. */
export interface Layer {
  w: number;
  h: number;
  px: Uint8Array;
}
export const EMPTY = 255;

/** Things that move on their own: a cloud drifting, or a leaf coming down. */
export interface Drifter {
  kind: 'cloud' | 'leaf';
  sprite: Layer;
  x: number;
  y: number;
}
export interface Scene {
  /** Sky, haze, forest, meadow and groves: still. */
  back: Layer;
  /** The trees and plants nearest the screen, in two positions a breeze moves between. */
  near: [Layer, Layer];
  drifters: Drifter[];
}

const layer = (w: number, h: number): Layer => ({ w, h, px: new Uint8Array(w * h).fill(EMPTY) });
const put = (l: Layer, x: number, y: number, shade: number) => {
  if (x >= 0 && y >= 0 && x < l.w && y < l.h) l.px[y * l.w + x] = shade;
};
const at = (l: Layer, x: number, y: number) =>
  x >= 0 && y >= 0 && x < l.w && y < l.h ? l.px[y * l.w + x]! : EMPTY;

const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hash = (x: number, y: number, seed: number) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** Smooth value noise in [0, 1]. */
function noise(x: number, y: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hash(xi, yi, seed) + (hash(xi + 1, yi, seed) - hash(xi, yi, seed)) * sx;
  const bottom =
    hash(xi, yi + 1, seed) + (hash(xi + 1, yi + 1, seed) - hash(xi, yi + 1, seed)) * sx;
  return top + (bottom - top) * sy;
}
const fbm = (x: number, y: number, seed: number) =>
  noise(x, y, seed) * 0.6 +
  noise(x * 2.1, y * 2.1, seed + 7) * 0.3 +
  noise(x * 4.3, y * 4.3, seed + 13) * 0.1;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x: number, y: number) => BAYER[(y & 3) * 4 + (x & 3)]!;
/** Picks one of `tones` for a value in [0, 1], dithering between neighbours. */
function dither(tones: readonly number[], value: number, x: number, y: number) {
  const scaled = Math.min(Math.max(value, 0), 0.9999) * (tones.length - 1);
  const low = Math.floor(scaled);
  return tones[Math.min(tones.length - 1, scaled - low > bayer(x, y) ? low + 1 : low)]!;
}

type Clump = { x: number; y: number; r: number; dx?: number };

/**
 * A mass of foliage: the union of clumps, later ones in front, its edge ragged with leaves. Each
 * clump is lit from the top left and shadowed underneath, with a leaf texture over it. `tones`
 * run from shadow to light. Holes open where the leaves are thinnest, so sky shows through.
 */
function foliage(
  l: Layer,
  clumps: readonly Clump[],
  tones: readonly number[],
  seed: number,
  { rag = 0.28, holes = 0, leaf = 2.4 }: { rag?: number; holes?: number; leaf?: number } = {}
) {
  if (!clumps.length) return;
  // Clumps are filed by the cells they cover, so each dot asks only the few that could hold it.
  const CELL = 16;
  const columns = Math.ceil(l.w / CELL);
  const cells = new Map<number, number[]>();
  clumps.forEach((c, i) => {
    const x = c.x + (c.dx ?? 0);
    const reach = c.r * (1 + rag);
    for (
      let cy = Math.max(0, Math.floor((c.y - reach) / CELL));
      cy <= Math.min(Math.ceil(l.h / CELL), (c.y + reach) / CELL);
      cy++
    )
      for (
        let cx = Math.max(0, Math.floor((x - reach) / CELL));
        cx <= Math.min(columns - 1, (x + reach) / CELL);
        cx++
      ) {
        const key = cy * columns + cx;
        const list = cells.get(key);
        if (list) list.push(i);
        else cells.set(key, [i]);
      }
  });
  for (const [key, list] of cells) {
    const cx = key % columns;
    const cy = (key - cx) / columns;
    for (let y = cy * CELL; y < Math.min(l.h, (cy + 1) * CELL); y++)
      for (let x = cx * CELL; x < Math.min(l.w, (cx + 1) * CELL); x++)
        for (let k = list.length - 1; k >= 0; k--) {
          const i = list[k]!;
          const c = clumps[i]!;
          // Texture and edge travel with the clump, so a breeze moves the leaves and not the light.
          const lx = x - (c.dx ?? 0);
          const nx = (lx + 0.5 - c.x) / c.r;
          const ny = (y + 0.5 - c.y) / c.r;
          const q = Math.sqrt(nx * nx + ny * ny);
          if (q > 1 + rag) continue;
          // The outline is lumpy all the way round, a leaf cluster's bumps a few dots across.
          const around = c.r / leaf;
          const edge =
            1 +
            rag *
              (noise(
                i * 17.3 + (nx / (q || 1)) * around,
                i * 5.1 + (ny / (q || 1)) * around,
                seed
              ) -
                0.5);
          if (q > edge) continue;
          if (
            holes &&
            q > 0.6 &&
            hash(Math.floor(lx / 3), Math.floor(y / 3), seed + i) < holes * (q - 0.6)
          )
            break;
          const toward = nx * 0.55 + ny * 0.83;
          let light = 0.52 - toward * 0.6;
          // A rim of shadow under and to the right of each cluster parts it from the one behind.
          if (q > edge - 0.14 && toward > -0.25) light = 0;
          // Leaf marks: a short dash in a few cells of a staggered grid.
          const row = Math.floor(y / 3);
          const col = Math.floor((lx + (row % 2) * 2) / 4);
          const mark = hash(col, row, seed + 3);
          if (mark > 0.55 && (lx + (row % 2) * 2) % 4 < 2 && y % 3 === 0)
            light += mark > 0.78 ? 0.3 : -0.3;
          put(l, x, y, dither(tones, light, x, y));
          break;
        }
  }
}

/** A trunk or limb along a polyline, tapering, lit on its left, with bark running along it. */
function wood(
  l: Layer,
  points: readonly [number, number][],
  from: number,
  to: number,
  tones: readonly number[],
  seed: number
) {
  const lengths = points
    .slice(1)
    .map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  let done = 0;
  const best = new Map<number, number>();
  points.slice(1).forEach((b, i) => {
    const a = points[i]!;
    const length = lengths[i]!;
    const steps = Math.ceil(length * 2) + 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = a[0] + (b[0] - a[0]) * t;
      const cy = a[1] + (b[1] - a[1]) * t;
      const r = (from + (to - from) * ((done + length * t) / total)) / 2;
      for (let y = Math.floor(cy - r); y <= cy + r; y++)
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          if (x < 0 || y < 0 || x >= l.w || y >= l.h) continue;
          const across = (x + 0.5 - cx) / r;
          if (Math.abs(across) > 1 || Math.abs(y + 0.5 - cy) > r) continue;
          const key = y * l.w + x;
          // Keep the reading nearest the limb's centre line, so overlapping steps agree.
          const prev = best.get(key);
          if (prev === undefined || Math.abs(across) < Math.abs(prev)) best.set(key, across);
        }
    }
    done += length;
  });
  for (const [key, across] of best) {
    const x = key % l.w;
    const y = (key - x) / l.w;
    let light = 0.55 - across * 0.45;
    if (across < -0.72) light = 0.95;
    if (Math.abs(across) > 0.9) light = 0.05;
    const grain = noise(x / 1.4, y / 7, seed);
    if (grain > 0.66) light = Math.min(light, 0.1);
    put(l, x, y, dither(tones, light, x, y));
  }
}

/** A fern: arching fronds from one root, each with leaflets shortening towards its tip. */
function fern(
  l: Layer,
  x: number,
  y: number,
  size: number,
  tone: number,
  next: () => number,
  sway: number
) {
  const fronds = 5 + Math.floor(next() * 3);
  for (let f = 0; f < fronds; f++) {
    const angle = -Math.PI / 2 + (f / (fronds - 1) - 0.5) * 2.4 + (next() - 0.5) * 0.3;
    const length = size * (0.7 + next() * 0.4) * (1 - Math.abs(f / (fronds - 1) - 0.5) * 0.5);
    const droop = 0.9 + next() * 0.5;
    let px = x;
    let py = y;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const a = angle + t * t * droop * Math.sign(Math.cos(angle) || 1);
      px += Math.cos(a) + sway * t * t * 0.3;
      py += Math.sin(a);
      put(l, Math.round(px), Math.round(py), tone);
      const leaflet = Math.round((1 - t) * size * 0.16 + 1);
      if (i % 2 === 0 && t > 0.1)
        for (let k = 1; k <= leaflet; k++) {
          put(
            l,
            Math.round(px - Math.sin(a) * k),
            Math.round(py + Math.cos(a) * k * 0.6 + k * 0.4),
            tone
          );
          put(
            l,
            Math.round(px + Math.sin(a) * k),
            Math.round(py - Math.cos(a) * k * 0.6 + k * 0.4),
            tone
          );
        }
    }
  }
}

/** A tuft of grass blades, each curving a little, leaning with the breeze. */
function grass(
  l: Layer,
  x: number,
  y: number,
  width: number,
  height: number,
  tone: number,
  next: () => number,
  sway: number
) {
  for (let b = 0; b < width; b += 1 + Math.floor(next() * 2)) {
    const h = height * (0.45 + next() * 0.55);
    const lean = (next() - 0.5) * 2.6;
    for (let i = 0; i < h; i++) {
      const t = i / h;
      put(l, Math.round(x + b + lean * t * t * 2.2 + sway * t * t * 1.6), Math.round(y - i), tone);
    }
  }
}

/** A flower on a stem: four petals round a centre. */
function flower(
  l: Layer,
  x: number,
  y: number,
  stem: number,
  petal: number,
  centre: number,
  tone: number,
  sway: number
) {
  for (let i = 0; i < stem; i++)
    put(l, x + Math.round((sway * i * i) / (stem * stem)), y - i, tone);
  const fx = x + sway;
  const fy = y - stem;
  for (const [dx, dy] of [
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1]
  ] as const)
    put(l, fx + dx, fy + dy, petal);
  put(l, fx, fy, centre);
}

/** A tree of the middle distance: one of three kinds, `height` dots tall, standing at x, y. */
function tree(
  l: Layer,
  kind: 'oak' | 'fir' | 'poplar',
  x: number,
  y: number,
  height: number,
  tones: readonly number[],
  next: () => number,
  seed: number
) {
  const trunkTones = [tones[0]!, tones[0]!, tones[1]!];
  if (kind === 'fir') {
    const width = height * (0.36 + next() * 0.1);
    wood(
      l,
      [
        [x, y],
        [x, y - height * 0.3]
      ],
      Math.max(2, height * 0.06),
      Math.max(1, height * 0.04),
      trunkTones,
      seed
    );
    const tiers = Math.max(3, Math.round(height / 9));
    const clumps: Clump[] = [];
    for (let t = 0; t < tiers; t++) {
      const k = t / (tiers - 1);
      const ty = y - height * 0.16 - k * height * 0.78;
      const half = (width / 2) * (1 - k * 0.82);
      for (let s = -1; s <= 1; s++)
        clumps.push({ x: x + s * half * 0.55, y: ty, r: Math.max(1.6, half * (s ? 0.55 : 0.62)) });
    }
    // Lower tiers in front, so each shadows the next one down.
    foliage(l, clumps.reverse(), tones, seed, { rag: 0.42, leaf: 1.6 });
    return;
  }
  const crownHeight = kind === 'poplar' ? height * 0.82 : height * 0.68;
  const crownWidth = kind === 'poplar' ? height * 0.3 : height * (0.62 + next() * 0.2);
  const top = y - height;
  wood(
    l,
    [
      [x, y],
      [x + (next() - 0.5) * 2, top + crownHeight * 0.6]
    ],
    Math.max(2, height * 0.08),
    Math.max(1.5, height * 0.05),
    trunkTones,
    seed
  );
  const clumps: Clump[] = [];
  const count = kind === 'poplar' ? 9 : 10 + Math.floor(next() * 6);
  for (let i = 0; i < count; i++) {
    const a = next() * Math.PI * 2;
    const d = Math.sqrt(next());
    clumps.push({
      x: x + Math.cos(a) * d * crownWidth * 0.36,
      y: top + crownHeight * 0.5 + Math.sin(a) * d * crownHeight * 0.34,
      r: (kind === 'poplar' ? crownWidth * 0.3 : crownWidth * 0.22) * (0.75 + next() * 0.5)
    });
  }
  clumps.sort((a, b) => a.y - b.y);
  foliage(l, clumps, tones, seed, { rag: 0.34, leaf: Math.max(1.6, height / 26) });
}

/** A puffy cloud with a flat underside, pale and edged in the next shade down. */
function cloud(width: number, next: () => number): Layer {
  const h = Math.round(width * 0.42) + 2;
  const l = layer(width, h);
  const base = h - 2;
  const puffs: Clump[] = [];
  for (let x = width * 0.18; x < width * 0.84; ) {
    const r = h * (0.22 + next() * 0.14);
    puffs.push({ x, y: base - r + 1, r });
    x += r * (1 + next() * 0.4);
  }
  puffs.push({
    x: width * (0.38 + next() * 0.24),
    y: base - h * 0.5,
    r: h * (0.38 + next() * 0.1)
  });
  for (let y = 0; y < base; y++)
    for (let x = 0; x < width; x++)
      if (puffs.some((p) => (x + 0.5 - p.x) ** 2 + (y + 0.5 - p.y) ** 2 <= p.r * p.r))
        put(l, x, y, 0);
  const filled = (x: number, y: number) => at(l, x, y) !== EMPTY;
  const outline: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < width; x++)
      if (
        filled(x, y) &&
        (!filled(x + 1, y) || !filled(x - 1, y) || !filled(x, y + 1) || !filled(x, y - 1))
      )
        outline.push(y * width + x);
  for (const i of outline) l.px[i] = 1;
  for (let x = 0; x < width; x++) if (at(l, x, base - 2) === 0 && x % 2) put(l, x, base - 2, 1);
  return l;
}

/** A falling leaf, one dot of stalk and three of blade. */
function fallingLeaf(): Layer {
  const l = layer(4, 3);
  for (const [x, y, s] of [
    [0, 0, 3],
    [1, 1, 2],
    [2, 1, 3],
    [3, 2, 3],
    [2, 2, 3],
    [1, 2, 2]
  ] as const)
    put(l, x, y, s);
  return l;
}

/** The garden for a screen `width` by `height` dots. */
export function compose(width: number, height: number): Scene {
  const W = width;
  const H = height;
  const seedOf = Math.round(W / 40) * 1000 + Math.round(H / 40);
  const next = random(seedOf);
  const u = Math.min(1.5, Math.max(0.5, Math.min(W, H * 1.6) / 720));
  const back = layer(W, H);
  const near: [Layer, Layer] = [layer(W, H), layer(W, H)];
  const drifters: Drifter[] = [];

  const meadow = (x: number) => H * 0.7 - H * 0.025 * Math.sin((x / W) * Math.PI * 2.2 + 0.8);

  // Clouds, each its own sprite so it can drift.
  for (let i = 0, n = Math.max(2, Math.round(W / 220)); i < n; i++) {
    const sprite = cloud(Math.round((34 + next() * 50) * u), next);
    drifters.push({
      kind: 'cloud',
      sprite,
      x: Math.round(((i + next() * 0.7) / n) * W),
      y: Math.round(H * (0.1 + next() * 0.24))
    });
  }

  // Hills in haze, then a forest along their foot, both pale and undrawn.
  for (let x = 0; x < W; x++) {
    const ridge =
      H * 0.5 -
      H * 0.07 * fbm(x / (W * 0.18), 0.5, seedOf + 3) -
      H * 0.02 * Math.sin((x / W) * Math.PI * 1.4);
    for (let y = Math.floor(ridge); y < H; y++) {
      const depth = (y - ridge) / (H * 0.2);
      if (bayer(x, y) < 0.22 + depth * 0.2) put(back, x, y, 1);
    }
  }
  for (let x = 0; x < W; x++) {
    const bumps = fbm(x / (5 * u), 1.5, seedOf + 5);
    const firTip =
      Math.max(0, 1 - Math.abs(((x / (4 * u)) % 2) - 1) * 2) *
      (noise(x / (9 * u), 3, seedOf) > 0.5 ? 1 : 0);
    const top =
      H * 0.6 - H * 0.03 * fbm(x / (W * 0.1), 2.5, seedOf + 9) - bumps * 8 * u - firTip * 6 * u;
    for (let y = Math.floor(top); y < H; y++) {
      const shade = (y - top) / (H * 0.12);
      put(back, x, y, shade > 0.55 && bayer(x, y) < (shade - 0.55) * 1.4 ? 2 : 1);
      if (y < top + 3 && x % 3 === 0 && (y + x) % 2 === 0 && bumps > 0.5) put(back, x, y, 0);
    }
  }

  // The meadow, whose grass grows larger and darker towards the screen.
  for (let x = 0; x < W; x++)
    for (let y = Math.floor(meadow(x)); y < H; y++) put(back, x, y, EMPTY);
  for (let x = 0; x < W; x++) put(back, x, Math.floor(meadow(x)), 1);

  // Groves at the edges of the clearing, nearer and larger towards the sides.
  const groves: { x: number; y: number; h: number; kind: 'oak' | 'fir' | 'poplar' }[] = [];
  for (const [centre, spread, count] of [
    [0.2, 0.1, 9],
    [0.8, 0.1, 9],
    [0.5, 0.08, 3]
  ] as const)
    for (let i = 0; i < Math.round(count * Math.min(1.4, W / 720) + 1); i++) {
      const x = W * (centre + (next() * 2 - 1) * spread);
      const y = meadow(x) + next() * H * 0.04 - 2;
      const roll = next();
      const kind = roll < 0.4 ? 'fir' : roll < 0.8 ? 'oak' : 'poplar';
      const toSide = Math.abs(x / W - 0.5) * 2;
      groves.push({
        x,
        y,
        h: (24 + toSide * 34 + next() * 20) * u * (centre === 0.5 ? 0.6 : 1),
        kind
      });
    }
  groves.sort((a, b) => a.y - b.y || a.h - b.h);
  for (const g of groves)
    tree(back, g.kind, g.x, g.y, g.h, [2, 2, 1, 1, 0], next, Math.round(g.x * 7 + g.y));

  for (let i = 0; i < W * 0.45; i++) {
    const t = next() ** 0.7;
    const x = Math.floor(next() * W);
    const y = Math.floor(meadow(x) + 4 + (H - meadow(x)) * t);
    if (next() < 0.82)
      grass(back, x, y, Math.round(2 + t * 5), Math.round(2 + t * 6), t < 0.55 ? 1 : 2, next, 0);
    else if (t > 0.3) flower(back, x, y, Math.round(2 + t * 3), 0, 2, 2, 0);
  }

  // Nearest the screen, drawn twice so the breeze can move between them.
  near.forEach((l, sway) => {
    const breeze = random(seedOf + 77);
    const canopySeed = seedOf + 11;
    // Trunks at both edges, the nearest partly beyond the screen.
    const trunks: [number, number, number][] = [
      [4 * u, 30 * u, -0.02],
      [W * 0.07, 12 * u, 0.04],
      [W - 6 * u, 36 * u, 0.01],
      [W - W * 0.075, 14 * u, -0.05]
    ];
    trunks.sort((a, b) => a[1] - b[1]);
    for (const [x, w, lean] of trunks) {
      const inward = x < W / 2 ? 1 : -1;
      const tones = [3, 2, 2, 1];
      wood(
        l,
        [
          [x, H + 4],
          [x + lean * H * 0.5, H * 0.5],
          [x + lean * H, 0]
        ],
        w * 1.25,
        w,
        tones,
        canopySeed + Math.round(x)
      );
      // Limbs leave the trunk and climb into the canopy.
      for (const [from, rise, length] of [
        [0.15, 0.7, 0.7],
        [0.07, 1, 0.45]
      ] as const) {
        const sx = x + lean * H * (1 - from);
        const sy = H * from;
        const ex = sx + inward * w * 3 * length * (1 + breeze() * 0.5);
        wood(
          l,
          [
            [sx, sy],
            [(sx + ex) / 2, sy - w * rise * 1.4],
            [ex, sy - w * rise * 2.4]
          ],
          w * 0.5,
          w * 0.2,
          tones,
          canopySeed + Math.round(sx)
        );
      }
    }

    // The canopy: deepest at the corners, a fringe across the middle, with sky between its leaves.
    // Each crown hangs over its trunk; between them only a ragged fringe, with sky in its gaps.
    const reach = (x: number) =>
      H *
      (0.07 * fbm(x / (W * 0.06), 4.5, seedOf) ** 2 +
        0.38 * Math.exp(-((x / (W * 0.19)) ** 2)) +
        0.34 * Math.exp(-(((W - x) / (W * 0.17)) ** 2)));
    const clumps: Clump[] = [];
    for (let x = -30 * u; x < W + 30 * u; x += (16 + breeze() * 14) * u) {
      const low = reach(x);
      if (low < 6 * u) continue;
      for (let y = -10 * u; y < low; y += (16 + breeze() * 12) * u) {
        const k = y / Math.max(1, low);
        const r = (16 + breeze() * 16) * u * (1 - k * 0.4);
        clumps.push({
          x: x + (breeze() - 0.5) * 8 * u,
          y: Math.min(y + r * 0.3, low - r * 0.5),
          r,
          dx: sway && k > 0.45 && breeze() < 0.6 ? (x < W / 2 ? 1 : -1) : 0
        });
      }
    }
    clumps.sort((a, b) => a.y - b.y);
    foliage(l, clumps, [3, 3, 2, 2, 1], canopySeed, { rag: 0.22, holes: 0.5, leaf: 2.6 });

    // The understorey: bushes heaped at the corners, ferns and grass, a few flowers.
    // On a narrow screen the heaps take their spread from its height, so they slope rather than drop.
    const spread = Math.max(W * 0.13, H * 0.16);
    const depthAt = (x: number) =>
      H *
      (0.035 +
        0.16 * Math.exp(-((x / spread) ** 2)) +
        0.14 * Math.exp(-(((W - x) / (spread * 0.92)) ** 2)));
    const bushes: Clump[] = [];
    for (let x = -20 * u; x < W + 20 * u; x += (8 + breeze() * 14) * u) {
      const top = H - depthAt(x);
      const r = (6 + breeze() * 6) * u + depthAt(x) * 0.35;
      bushes.push({
        x,
        y: top + r * 0.7 + breeze() * 6 * u,
        r,
        dx: sway && breeze() < 0.5 ? 1 : 0
      });
    }
    bushes.sort((a, b) => a.y - b.y);
    foliage(l, bushes, [3, 2, 2, 1], canopySeed + 5, { rag: 0.25, leaf: 2.2 });
    for (let x = -6; x < W; x += Math.round((10 + breeze() * 26) * u)) {
      const size = (10 + breeze() * 12) * u + depthAt(x) * 0.25;
      fern(l, x, H - 1, size, 3, breeze, sway ? 1 : 0);
    }
    for (let x = 0; x < W; x += Math.round((5 + breeze() * 9) * u)) {
      grass(
        l,
        x,
        H - 1,
        Math.round((5 + breeze() * 6) * u),
        Math.round((7 + breeze() * 10) * u),
        3,
        breeze,
        sway ? 1 : -0.4
      );
      if (breeze() < 0.16)
        flower(l, x + 2, H - 2, Math.round((8 + breeze() * 8) * u), 0, 2, 3, sway);
    }
  });

  for (let i = 0, n = Math.max(2, Math.round(W / 300)); i < n; i++)
    drifters.push({
      kind: 'leaf',
      sprite: fallingLeaf(),
      x: Math.round(W * (0.08 + next() * 0.84)),
      y: 0
    });

  return { back, near, drifters };
}

/** Converts a layer to pixels in the screen's shades. */
export function pixels(
  l: Layer,
  shades: readonly [number, number, number, number][]
): ImageData['data'] {
  const out = new Uint8ClampedArray(l.w * l.h * 4);
  for (let i = 0; i < l.px.length; i++) {
    const shade = l.px[i]!;
    if (shade === EMPTY) continue;
    const c = shades[shade]!;
    out.set(c, i * 4);
  }
  return out;
}

/**
 * The garden a tone nearer the screen's background - a step lighter by day, a step darker at
 * night - for a card that holds other cards: it lets the garden through, and the cards it holds
 * stand on it.
 */
export function toneNearer(
  scene: Scene,
  shades: readonly [number, number, number, number][],
  night: boolean
): ImageData['data'] {
  const { w, h } = scene.back;
  const out = new Uint8ClampedArray(w * h * 4);
  // By day the shades run background, tint, muted, text, lightest to darkest, and each moves a
  // step lighter; at night they are background, muted, tint, tint, and each moves a step darker.
  const toward = night ? [0, 2, 0, 0] : [0, 0, 1, 2];
  for (let i = 0; i < w * h; i++) {
    const near = scene.near[0].px[i]!;
    const shade = near === EMPTY ? scene.back.px[i]! : near;
    out.set(shades[toward[shade === EMPTY ? 0 : shade]!]!, i * 4);
  }
  return out;
}
