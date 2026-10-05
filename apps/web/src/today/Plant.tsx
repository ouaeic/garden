import { useLayoutEffect, useRef, useState } from 'react';

/**
 * A goal, drawn as what it is doing.
 *
 * A leaf per step of its plan: an outline while the step is in hand, filled once it is done. The
 * stem grows to the highest leaf; a flower opens when the goal is ready, and a drop of dew hangs at
 * the tip while it needs the owner. The curve comes from the goal's id, so a plant keeps its shape
 * from one visit to the next.
 */
export interface PlantProps {
  seed: string;
  total: number;
  done: number;
  current: boolean;
  bloom: boolean;
  needs: boolean;
  className?: string;
}

const curveFor = (seed: string) => {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const pick = (shift: number) => (((hash >>> shift) & 63) / 63) * 52 - 26;
  const [a, b, c] = [pick(0), pick(6), pick(12)];
  return `M80 172 C ${80 + a} 132, ${80 + b} 92, ${80 + c * 0.4} 60 S ${80 + c} 26, ${80 + c * 0.5} 16`;
};

interface Leaf {
  x: number;
  y: number;
  angle: number;
  side: 1 | -1;
  at: number;
  scale: number;
}

export default function Plant({ seed, total, done, current, bloom, needs, className }: PlantProps) {
  const stem = useRef<SVGPathElement>(null);
  const [layout, setLayout] = useState<{ leaves: Leaf[]; samples: DOMPoint[] } | null>(null);
  const d = curveFor(seed);

  useLayoutEffect(() => {
    const path = stem.current;
    if (!path) return;
    const length = path.getTotalLength();
    const leaves: Leaf[] = Array.from({ length: total }, (_, i) => {
      const at = 0.16 + (i / Math.max(total - 1, 1)) * 0.7;
      const p = path.getPointAtLength(at * length);
      const q = path.getPointAtLength(Math.min(length, at * length + 1));
      const side = i % 2 ? 1 : -1;
      return {
        x: p.x,
        y: p.y,
        angle: (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI + side * 62,
        side,
        at,
        scale: 1 - i * 0.05
      };
    });
    const samples = Array.from({ length: 51 }, (_, i) => path.getPointAtLength((i / 50) * length));
    setLayout({ leaves, samples });
  }, [d, total]);

  const shown = done + (current ? 1 : 0);
  const tip = bloom
    ? 1
    : Math.min(1, Math.max(0.1, shown ? (layout?.leaves[shown - 1]?.at ?? 0) + 0.1 : 0.1));
  const crown = layout?.samples[Math.round(tip * 50)];

  return (
    <svg
      className={`plant ${bloom ? 'is-bloom' : ''} ${needs ? 'is-needs' : ''} ${className ?? ''}`}
      viewBox="0 0 160 178"
      aria-hidden="true"
    >
      <ellipse className="plant-soil" cx="80" cy="173" rx="38" ry="4.5" />
      <g className="plant-sway" style={{ animationDelay: `-${(seed.charCodeAt(0) % 7) * 0.9}s` }}>
        <path
          ref={stem}
          className="plant-stem"
          d={d}
          pathLength={1}
          style={{ strokeDashoffset: 1 - tip }}
        />
        {layout?.leaves.map((leaf, i) => (
          <g
            key={i}
            className={`plant-leaf ${i < done ? 'is-done' : i === done && current ? 'is-drafted' : ''}`}
            transform={`translate(${leaf.x.toFixed(1)},${leaf.y.toFixed(1)}) rotate(${leaf.angle.toFixed(1)}) scale(${leaf.scale.toFixed(2)},${leaf.side})`}
          >
            <g className="plant-blade">
              <path className="plant-blade-fill" d="M0 0 C7 -10 22 -12 34 -2 C23 7 8 7 0 0Z" />
              <path className="plant-rib" d="M2 0 C12 -3 22 -3 31 -2" />
            </g>
          </g>
        ))}
        {crown && (
          <g
            className="plant-crown"
            style={{ transform: `translate(${crown.x.toFixed(1)}px, ${crown.y.toFixed(1)}px)` }}
          >
            <circle className="plant-bud" r="3.2" cy="-1" />
            <g className="plant-flower">
              {[0, 72, 144, 216, 288].map((r) => (
                <ellipse key={r} rx="5.2" ry="10" cy="-9" transform={`rotate(${r})`} />
              ))}
              <circle r="3.6" />
            </g>
            <circle className="plant-dew" r="4.6" cy="-2" />
          </g>
        )}
      </g>
    </svg>
  );
}
