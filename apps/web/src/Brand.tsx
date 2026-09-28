import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { chirp } from './life/sound';

/*
 * What the word slowly becomes now and then. Each form is drawn on the word's own box (100 by 30,
 * baseline at 26) as strokes that grow along their length, with leaves and buds that open where
 * the growing tip passes them. `at` is how far along the growth each part appears, from 0 to 1.
 */
type Part =
  | { kind: 'stem'; d: string }
  | { kind: 'leaf'; x: number; y: number; angle: number; size: number; at: number }
  | { kind: 'bud'; x: number; y: number; r: number; at: number };
type Form = { name: string; parts: Part[] };

const leaf = (x: number, y: number, angle: number, at: number, size = 1): Part => ({
  kind: 'leaf',
  x,
  y,
  angle,
  size,
  at
});

/** A point on the frond's arch (M4 27 C 22 8, 62 2, 90 12), from its base at 0 to its tip at 1. */
const frondAt = (t: number): [number, number] => {
  const u = 1 - t;
  const along = (a: number, b: number, c: number, d: number) =>
    u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return [along(4, 22, 62, 90), along(27, 8, 2, 12)];
};

const forms: Form[] = [
  {
    // A vine runs along the baseline, curling at its tip, leaves opening either side.
    name: 'vine',
    parts: [
      {
        kind: 'stem',
        d: 'M3 26 C 14 16, 22 30, 34 22 S 56 12, 68 21 S 88 28, 95 16 c 2 -5 -4 -7 -5 -3'
      },
      leaf(14, 22, -120, 0.14),
      leaf(26, 24, 40, 0.28, 0.9),
      leaf(44, 17, -110, 0.45),
      leaf(60, 18, 30, 0.6, 0.9),
      leaf(76, 24, -140, 0.76),
      leaf(88, 23, 50, 0.88, 0.8)
    ]
  },
  {
    // Each letter becomes a seedling: a stem and a pair of seed leaves, heights varying.
    name: 'seedlings',
    parts: [8, 25, 42, 58, 75, 92].flatMap((x, index) => {
      const top = [12, 7, 14, 9, 6, 11][index]!;
      const at = index / 6;
      const lean = index % 2 ? 2 : -2;
      return [
        { kind: 'stem', d: `M${x} 27 Q ${x + lean} ${(27 + top) / 2}, ${x} ${top}` } as Part,
        leaf(x, top, -150, at + 0.08, 0.8),
        leaf(x, top, -30, at + 0.1, 0.8)
      ];
    })
  },
  {
    // A fern frond arches over the word, leaflets opening in pairs towards a curled tip.
    name: 'frond',
    parts: [
      { kind: 'stem', d: 'M4 27 C 22 8, 62 2, 90 12 c 5 2 5 8 0 8 c -3 0 -3 -4 0 -4' },
      ...[0.14, 0.28, 0.42, 0.56, 0.7].flatMap((t, index) => {
        // On the arch itself: the curve's point at t, and the way it is heading there.
        const [x, y] = frondAt(t);
        const [ahead, rise] = frondAt(t + 0.01);
        const heading = (Math.atan2(rise - y, ahead - x) * 180) / Math.PI;
        const size = 0.75 - index * 0.08;
        return [leaf(x, y, heading - 65, t, size), leaf(x, y, heading + 85, t + 0.03, size)];
      })
    ]
  },
  {
    // A sprig with a few round buds, the kind that closes again at night.
    name: 'buds',
    parts: [
      {
        kind: 'stem',
        d: 'M10 27 C 30 24, 48 16, 60 12 M34 21 C 38 14, 36 10, 32 7 M60 12 C 70 9, 80 12, 90 8'
      },
      leaf(22, 25, -130, 0.2, 0.9),
      leaf(47, 17, 40, 0.45, 0.9),
      leaf(72, 10, -120, 0.7, 0.8),
      { kind: 'bud', x: 32, y: 6, r: 2.2, at: 0.5 },
      { kind: 'bud', x: 60, y: 11, r: 1.8, at: 0.62 },
      { kind: 'bud', x: 91, y: 7, r: 2.4, at: 0.95 }
    ]
  }
];

/** Grow, rest, and grow back into the word: shares of the whole, in that order. */
const LENGTH = 11_000;
const GROW = 0.3;
const REST = 0.4;

/*
 * The plant is pixel art: the forms above are drawn once onto 80 by 24 cells - about one screen
 * pixel each, half a letter pixel - and each cell remembers when the growing tip reaches it, so the
 * plant grows a pixel at a time. Shade 3 is ink, 2 the muted shade, as the creatures use them.
 */
const COLS = 80;
const ROWS = 24;
const CELL = 100 / COLS;
type Pixel = { x: number; y: number; shade: 2 | 3; at: number };

function rasterize(form: Form): Pixel[] {
  const cells = new Map<string, Pixel>();
  const put = (x: number, y: number, shade: 2 | 3, at: number, over = false) => {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return;
    const key = `${cx},${cy}`;
    const held = cells.get(key);
    // Ink wins over the muted shade; the earliest arrival decides when a cell appears.
    if (over) cells.set(key, { x: cx, y: cy, shade, at: Math.min(at, held?.at ?? at) });
    else if (!held || shade > held.shade || (shade === held.shade && at < held.at))
      cells.set(key, { x: cx, y: cy, shade: held && held.shade > shade ? held.shade : shade, at });
  };
  // The browser measures the stems, so they can be written as ordinary path data.
  const scratch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  scratch.setAttribute('style', 'position:fixed;width:0;height:0;visibility:hidden');
  document.body.append(scratch);
  try {
    for (const part of form.parts) {
      if (part.kind === 'stem') {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', part.d);
        scratch.append(path);
        const length = path.getTotalLength();
        // The cells the stem passes through, in order, as a one-pixel line.
        const line: Array<{ x: number; y: number; at: number }> = [];
        for (let along = 0; along <= length; along += CELL / 3) {
          const point = path.getPointAtLength(along);
          const x = Math.floor(point.x / CELL);
          const y = Math.floor(point.y / CELL);
          const previous = line.at(-1);
          if (previous && previous.x === x && previous.y === y) continue;
          line.push({ x, y, at: along / length });
        }
        // Drop the corner of every step, so a curve is a clean staircase rather than a thick one.
        const clean: typeof line = [];
        for (const cell of line) {
          const [before, corner] = [clean.at(-2), clean.at(-1)];
          if (
            before &&
            corner &&
            Math.abs(before.x - cell.x) === 1 &&
            Math.abs(before.y - cell.y) === 1
          )
            clean.pop();
          clean.push(cell);
        }
        for (const cell of clean) put((cell.x + 0.5) * CELL, (cell.y + 0.5) * CELL, 3, cell.at);
      } else if (part.kind === 'leaf') {
        // A lens along its angle, solid ink with a lighter midrib, unfolding from the base outward.
        const reach = 10 * part.size;
        const half = 3 * part.size;
        const turn = (part.angle * Math.PI) / 180;
        const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
        const [left, top] = [
          Math.floor((part.x - reach) / CELL),
          Math.floor((part.y - reach) / CELL)
        ];
        for (let cx = left; cx <= left + (2 * reach) / CELL + 1; cx++)
          for (let cy = top; cy <= top + (2 * reach) / CELL + 1; cy++) {
            const [dx, dy] = [(cx + 0.5) * CELL - part.x, (cy + 0.5) * CELL - part.y];
            const u = dx * cos + dy * sin;
            const v = -dx * sin + dy * cos;
            if (u < 0 || u > reach || Math.abs(v) > half * Math.sin((Math.PI * u) / reach))
              continue;
            const rib = Math.abs(v) < CELL * 0.6 && u > reach * 0.25 && u < reach * 0.8;
            put(
              (cx + 0.5) * CELL,
              (cy + 0.5) * CELL,
              rib ? 2 : 3,
              part.at + (u / reach) * 0.05,
              rib
            );
          }
      } else {
        for (let dx = -part.r; dx <= part.r; dx += CELL / 3)
          for (let dy = -part.r; dy <= part.r; dy += CELL / 3) {
            const distance = Math.hypot(dx, dy);
            if (distance > part.r) continue;
            put(part.x + dx, part.y + dy, distance > part.r - CELL ? 3 : 2, part.at + 0.02);
          }
      }
    }
  } finally {
    scratch.remove();
  }
  return [...cells.values()];
}
const drawn = new Map<string, Pixel[]>();
const pixelsOf = (form: Form) => {
  let pixels = drawn.get(form.name);
  if (!pixels) drawn.set(form.name, (pixels = rasterize(form)));
  return pixels;
};

/**
 * The wordmark, and only the word. In the masthead, every few minutes, it slowly turns into
 * something growing - a vine, a row of seedlings, a frond, a budding sprig - drawn in pixels the
 * size of the letters' own, rests a moment and becomes the word again. Pointing at it grows the
 * vine, and a run that finishes well grows a budding sprig. Never while the page is hidden or motion is reduced.
 */
export default function Brand({ alive = false }: { alive?: boolean }) {
  const [growing, setGrowing] = useState<{ name: string; pixels: Pixel[] } | null>(null);
  const word = useRef<HTMLSpanElement>(null);
  const plant = useRef<SVGSVGElement>(null);
  const busy = useRef(false);
  const last = useRef<string | null>(null);
  const grow = useRef<(name?: string) => void>(() => undefined);

  useEffect(() => {
    if (!alive || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer: ReturnType<typeof setTimeout>;
    const begin = (name?: string) => {
      if (busy.current || document.visibilityState !== 'visible') return;
      const choices = forms.filter((entry) => entry.name !== last.current);
      const chosen =
        forms.find((entry) => entry.name === name) ??
        choices[Math.floor(Math.random() * choices.length)]!;
      last.current = chosen.name;
      busy.current = true;
      setGrowing({ name: chosen.name, pixels: pixelsOf(chosen) });
    };
    grow.current = begin;
    const next = (first = false) => {
      timer = setTimeout(
        () => {
          begin();
          next();
        },
        first ? 20_000 + Math.random() * 20_000 : 100_000 + Math.random() * 140_000
      );
    };
    next(true);
    const onBloom = () => {
      chirp('bloom');
      begin('buds');
    };
    // A named form on request, so one can be watched on purpose rather than waited for.
    const onGrow = (event: Event) => begin((event as CustomEvent<string>).detail);
    addEventListener('garden:bloom', onBloom);
    addEventListener('garden:grow', onGrow);
    return () => {
      grow.current = () => undefined;
      clearTimeout(timer);
      removeEventListener('garden:bloom', onBloom);
      removeEventListener('garden:grow', onGrow);
    };
  }, [alive]);

  useEffect(() => {
    if (!growing || !plant.current || !word.current) return;
    const running: Animation[] = [];
    const timing = { duration: LENGTH, fill: 'both' as const };
    const out = GROW + REST;
    /*
     * The letters fade in three steps, the way an LCD cell does, from left to right as the plant
     * reaches them, and come back in the same order.
     */
    const letters = [...word.current.querySelectorAll<HTMLElement>('.brand-letter')];
    letters.forEach((letter, index) => {
      const at = 0.02 + (index / letters.length) * GROW * 0.8;
      const back = out + (index / letters.length) * (1 - out) * 0.8;
      running.push(
        letter.animate(
          [
            { opacity: 1, offset: 0 },
            { opacity: 1, offset: at, easing: 'steps(3, end)' },
            { opacity: 0, offset: at + 0.06 },
            { opacity: 0, offset: back, easing: 'steps(3, end)' },
            { opacity: 1, offset: Math.min(1, back + 0.06) },
            { opacity: 1, offset: 1 }
          ],
          timing
        )
      );
    });
    // Each pixel lights as the tip reaches it and goes out tip first as the plant draws back.
    for (const cell of plant.current.querySelectorAll<SVGRectElement>('rect')) {
      const at = Math.min(0.99, Number(cell.dataset.at));
      const open = 0.02 + at * GROW * 0.95;
      const close = out + (1 - at) * (1 - out) * 0.9;
      running.push(
        cell.animate(
          [
            { opacity: 0, offset: 0 },
            { opacity: 0, offset: open },
            { opacity: 1, offset: open + 0.002 },
            { opacity: 1, offset: close },
            { opacity: 0, offset: close + 0.002 },
            { opacity: 0, offset: 1 }
          ],
          timing
        )
      );
    }
    let done = false;
    void running[0]?.finished
      .catch(() => undefined)
      .then(() => {
        if (done) return;
        busy.current = false;
        setGrowing(null);
      });
    return () => {
      done = true;
      busy.current = false;
      running.forEach((animation) => animation.cancel());
    };
  }, [growing]);

  return (
    // Pointing at the word grows the vine; one already growing simply carries on.
    <span
      className="brand"
      data-growing={growing?.name}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') grow.current('vine');
      }}
    >
      <span className="sr-only">garden</span>
      <span className="brand-word" aria-hidden="true" ref={word}>
        {[...'garden'].map((letter, index) => (
          <span key={index} className="brand-letter" style={{ '--letter': index } as CSSProperties}>
            {letter}
          </span>
        ))}
        {growing && (
          <svg
            ref={plant}
            className="brand-plant"
            viewBox={`0 0 ${COLS} ${ROWS}`}
            preserveAspectRatio="none"
            shapeRendering="crispEdges"
            aria-hidden="true"
          >
            {growing.pixels.map((cell) => (
              <rect
                key={`${cell.x},${cell.y}`}
                className={`life-s${cell.shade}`}
                x={cell.x}
                y={cell.y}
                width={1}
                height={1}
                data-at={cell.at}
              />
            ))}
          </svg>
        )}
      </span>
    </span>
  );
}
