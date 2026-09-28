import type { CSSProperties } from 'react';
import type { Frame, Frames } from './growth';

const shades = ['life-s0', 'life-s1', 'life-s2', 'life-s3'] as const;

/** One path per shade, with each horizontal run of pixels drawn as a single rectangle. */
function paths(frames: Frames) {
  const width = frames[0]![0]!.length;
  const out: string[] = ['', '', '', ''];
  frames.forEach((frame, index) => {
    frame.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const shade = row[x]!;
        let end = x + 1;
        while (end < row.length && row[end] === shade) end++;
        if (shade >= '0' && shade <= '3')
          out[Number(shade)] += `M${index * width + x} ${y}h${end - x}v1h${x - end}z`;
        x = end;
      }
    });
  });
  return out;
}

const cache = new WeakMap<Frames, string[]>();
let still: boolean | undefined;
const prefersStill = () =>
  (still ??=
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

/**
 * A sprite drawn as crisp SVG rectangles. Several frames are laid out side by side and stepped
 * through with a CSS animation, so an animated sprite costs no script once it is on screen.
 */
export function Sprite({
  frames,
  scale = 2,
  fps = 4,
  play = true,
  flip = false,
  once = false,
  className = '',
  style
}: {
  frames: Frames | Frame;
  scale?: number;
  fps?: number;
  play?: boolean;
  flip?: boolean;
  /** Play the frames through once and rest on the last. */
  once?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const all: Frames = typeof frames[0] === 'string' ? [frames as Frame] : (frames as Frames);
  // With motion reduced, a sprite that grows once is simply shown grown.
  const list: Frames = once && prefersStill() ? [all.at(-1)!] : all;
  let drawn = cache.get(list);
  if (!drawn) {
    drawn = paths(list);
    cache.set(list, drawn);
  }
  const width = list[0]![0]!.length;
  const height = list[0]!.length;
  const count = list.length;
  const animated = play && count > 1;
  const travel = once ? count - 1 : count;
  return (
    <span
      aria-hidden="true"
      className={`life-sprite ${flip ? 'is-flipped' : ''} ${className}`}
      style={{ width: width * scale, height: height * scale, ...style }}
    >
      <svg
        viewBox={`0 0 ${width * count} ${height}`}
        width={width * count * scale}
        height={height * scale}
        shapeRendering="crispEdges"
        className={animated ? 'life-strip' : undefined}
        style={
          animated
            ? ({
                '--life-strip': `${-width * travel * scale}px`,
                animationDuration: `${travel / fps}s`,
                animationTimingFunction: `steps(${travel}, end)`,
                ...(once ? { animationIterationCount: 1, animationFillMode: 'forwards' } : {})
              } as CSSProperties)
            : undefined
        }
      >
        {drawn.map((d, shade) => (d ? <path key={shade} className={shades[shade]} d={d} /> : null))}
      </svg>
    </span>
  );
}
