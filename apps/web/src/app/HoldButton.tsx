import { useRef, useState, type ReactNode } from 'react';

/**
 * A button that has to be held, for the few things that should never happen on a stray tap.
 * Keyboard users hold Enter or Space; letting go early does nothing and says so.
 */
export default function HoldButton({
  children,
  onHeld,
  className = '',
  ms = 1200
}: {
  children: ReactNode;
  onHeld: () => void;
  className?: string;
  ms?: number;
}) {
  const [progress, setProgress] = useState(0);
  const [hint, setHint] = useState(false);
  const frame = useRef(0);
  const start = useRef(0);
  const done = useRef(false);
  const begin = () => {
    if (frame.current) return;
    done.current = false;
    start.current = performance.now();
    const step = (now: number) => {
      const value = Math.min(1, (now - start.current) / ms);
      setProgress(value);
      if (value >= 1) {
        done.current = true;
        frame.current = 0;
        setProgress(0);
        onHeld();
        return;
      }
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };
  const end = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (!done.current && progress > 0) setHint(true);
    setProgress(0);
  };
  return (
    <button
      type="button"
      className={`hold ${className}`}
      style={{ '--hold': progress } as React.CSSProperties}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        begin();
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
          event.preventDefault();
          begin();
        }
      }}
      onKeyUp={end}
      onBlur={end}
    >
      <span className="hold-fill" aria-hidden="true" />
      <span className="hold-label">{children}</span>
      {hint && (
        <span className="sr-only" role="status">
          Keep holding until the bar fills.
        </span>
      )}
    </button>
  );
}
