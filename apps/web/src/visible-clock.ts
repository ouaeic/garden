import { useEffect, useState } from 'react';

type Visibility = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

/** Display clocks consume no timers while their page is hidden. */
export function observeVisibleClock(
  tick: (time: number) => void,
  intervalMs: number,
  visibility: Visibility = document
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const sync = () => {
    clearInterval(timer);
    timer = undefined;
    if (visibility.visibilityState !== 'visible') return;
    tick(Date.now());
    timer = setInterval(() => tick(Date.now()), intervalMs);
  };
  visibility.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    clearInterval(timer);
    visibility.removeEventListener('visibilitychange', sync);
  };
}

export function useVisibleClock(active: boolean, intervalMs: number, observation?: string) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    setClock(Date.now());
  }, [observation]);
  useEffect(() => {
    if (active) return observeVisibleClock(setClock, intervalMs);
  }, [active, intervalMs]);
  return clock;
}
