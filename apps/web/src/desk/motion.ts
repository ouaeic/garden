/**
 * Motion that says where things went. An opened result grows out of its card; a kept one flies to
 * the Library, so the owner's eye follows it and knows where to find it again. Transform and
 * opacity only, so it holds 60 frames a second, and nothing moves for someone who asked for less
 * motion.
 */
const still = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(0.22, 0.8, 0.16, 1)';

let origin: { id: string; rect: DOMRect } | null = null;

/** Notes where a card was, for the view it opens into. */
export function rememberOrigin(id: string, element: Element | null) {
  origin = element ? { id, rect: element.getBoundingClientRect() } : null;
}

/** Grows an element out of the card it was opened from, once. */
export function growFromOrigin(id: string, element: HTMLElement | null) {
  const from = origin?.id === id ? origin.rect : null;
  origin = null;
  if (!from || !element || still()) return;
  const to = element.getBoundingClientRect();
  if (!to.width || !to.height) return;
  element.animate(
    [
      {
        transformOrigin: 'top left',
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        opacity: 0.4
      },
      { transformOrigin: 'top left', transform: 'none', opacity: 1 }
    ],
    { duration: 340, easing: EASE }
  );
}

/** Sends a card to the Library in the top bar, and resolves when it has arrived. */
export function flyToLibrary(element: HTMLElement | null): Promise<void> {
  const target = document.querySelector('[data-nav="library"]');
  if (!element || !target || still()) return Promise.resolve();
  const from = element.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const animation = element.animate(
    [
      { transform: 'none', opacity: 1 },
      {
        transform: `translate(${dx * 0.35}px, ${dy * 0.2 - 24}px) scale(0.7)`,
        opacity: 0.9,
        offset: 0.35
      },
      { transform: `translate(${dx}px, ${dy}px) scale(0.06)`, opacity: 0 }
    ],
    { duration: 520, easing: EASE, fill: 'forwards' }
  );
  target.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
    { duration: 260, delay: 440, easing: EASE }
  );
  return animation.finished.then(
    () => undefined,
    () => undefined
  );
}
