/**
 * The results on the desk, in the order it shows them, so a result opened from the desk can step
 * to the next one without going back - reviewing a morning's work is one key per result.
 */
let order: readonly string[] = [];

export const setReviewOrder = (ids: readonly string[]) => {
  order = ids;
};

export function neighbours(id: string): {
  previous: string | null;
  next: string | null;
  at: number;
  of: number;
} {
  const at = order.indexOf(id);
  if (at < 0) return { previous: null, next: null, at: 0, of: 0 };
  return {
    previous: order[at - 1] ?? null,
    next: order[at + 1] ?? null,
    at: at + 1,
    of: order.length
  };
}
