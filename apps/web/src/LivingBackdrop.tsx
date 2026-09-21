import { useEffect, useRef } from 'react';
import './living-backdrop.css';

/** Soft edges are painted into gradients; only transforms change while the cells move. */
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
      <i />
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}
