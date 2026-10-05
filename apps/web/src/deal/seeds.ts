/**
 * The seeds a planted deal sends into the bed: one glowing point per goal, from its row in the deal
 * to its card on the desk. Decoration only - the cards are already there - so a card that is not on
 * screen, or a viewer who asked for less motion, simply gets no flight.
 */
export function flySeeds(from: (DOMRect | null)[], taskIds: readonly string[]): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  requestAnimationFrame(() =>
    taskIds.forEach((id, index) => {
      const start = from[index];
      const card = document.querySelector<HTMLElement>(
        `[data-goal-id="${CSS.escape(id)}"] .goal-plant`
      );
      if (!start || !card) return;
      const end = card.getBoundingClientRect();
      const [fx, fy] = [start.left + 30, start.top + start.height / 2];
      const [tx, ty] = [end.left + end.width / 2, end.bottom - 18];
      const seed = document.createElement('div');
      seed.className = 'seed-flight';
      document.body.append(seed);
      void seed
        .animate(
          [
            { transform: `translate(${fx}px, ${fy}px) scale(1)` },
            {
              transform: `translate(${(fx + tx) / 2}px, ${Math.min(fy, ty) - 140}px) scale(1.4)`,
              offset: 0.5
            },
            { transform: `translate(${tx}px, ${ty}px) scale(0.5)`, opacity: 0.8 }
          ],
          { duration: 1050 + index * 140, easing: 'cubic-bezier(.5,0,.2,1)', fill: 'forwards' }
        )
        .finished.finally(() => seed.remove());
    })
  );
}
