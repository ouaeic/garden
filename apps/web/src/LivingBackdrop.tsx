import { useEffect, useRef } from 'react';
import './living-backdrop.css';

/** Independent CSS motion and focus cycles keep depth off the JavaScript render loop. */
export default function LivingBackdrop() {
  const field = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    let inView = false;
    const update = () => {
      element.dataset.moving = String(inView && !document.hidden);
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return (
    <div className="garden-living-field" ref={field} aria-hidden="true">
      <i>
        <span />
      </i>
      <i>
        <span />
      </i>
      <i>
        <span />
      </i>
      <i>
        <span />
      </i>
      <i>
        <span />
      </i>
    </div>
  );
}
