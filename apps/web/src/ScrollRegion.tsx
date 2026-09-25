/* eslint jsx-a11y/no-noninteractive-tabindex: ["error", {"roles": ["region"]}] -- Overflowing lists must be keyboard-scrollable. */
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Short lists stay in the flow; overflowing lists support keyboard and touch scrolling. */
export default function ScrollRegion({
  label,
  children,
  resetKey,
  className = ''
}: {
  label: string;
  children: ReactNode;
  resetKey?: string;
  className?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const region = viewport.current!,
      body = content.current!;
    const measure = () => setOverflow(region.scrollHeight > region.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    observer.observe(body);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [resetKey]);
  return (
    <div
      ref={viewport}
      className={`scroll-region ${className}`}
      role="region"
      aria-label={label}
      tabIndex={overflow ? 0 : undefined}
      data-overflow={overflow || undefined}
    >
      <div ref={content} className="scroll-region-content">
        {children}
      </div>
    </div>
  );
}
