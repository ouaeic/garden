import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { growth } from './life/growth';
import { Sprite } from './life/Sprite';

const idles = ['hop', 'flip', 'sprout', 'doze'] as const;
type Idle = (typeof idles)[number];
const lengths: Record<Idle, number> = { hop: 1400, flip: 1600, sprout: 4200, doze: 3600 };

/**
 * The wordmark, and only the word. Its letters power on when the app opens and ripple under the
 * pointer. In the masthead it is also alive: every half minute or so it does one small thing - the
 * letters hop in a wave, flip like LCD cells, grow a sprout from the d, or the r nods off and
 * springs back - and never while the page is hidden or motion is reduced.
 */
export default function Brand({ alive = false }: { alive?: boolean }) {
  const [idle, setIdle] = useState<Idle | null>(null);
  const last = useRef<Idle | null>(null);
  useEffect(() => {
    if (!alive || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = (first = false) => {
      timer = setTimeout(
        () => {
          if (document.visibilityState === 'visible') {
            const choices = idles.filter((item) => item !== last.current);
            const chosen = choices[Math.floor(Math.random() * choices.length)]!;
            last.current = chosen;
            setIdle(chosen);
            timer = setTimeout(() => {
              setIdle(null);
              next();
            }, lengths[chosen]);
            return;
          }
          next();
        },
        first ? 7000 + Math.random() * 5000 : 18000 + Math.random() * 22000
      );
    };
    next(true);
    return () => clearTimeout(timer);
  }, [alive]);
  return (
    <span className="brand" data-idle={idle ?? undefined}>
      <span className="sr-only">garden</span>
      <span className="brand-word" aria-hidden="true">
        {[...'garden'].map((letter, index) => (
          <span key={index} className="brand-letter" style={{ '--letter': index } as CSSProperties}>
            {letter}
            {idle === 'sprout' && index === 3 && (
              <Sprite frames={growth.sprout} fps={3} className="brand-sprout" />
            )}
          </span>
        ))}
      </span>
    </span>
  );
}
