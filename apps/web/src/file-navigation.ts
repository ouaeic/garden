import { useEffect, useRef } from 'react';

const editors = new Set<() => void>();

/** Routing leaves an editor mounted until its owner saves or discards the pending changes. */
export function fileNavigationBlocked(): boolean {
  for (const notify of editors) notify();
  return editors.size > 0;
}

export function useFileNavigationGuard(blocked: boolean, notify: () => void): void {
  const callback = useRef(notify);
  callback.current = notify;
  useEffect(() => {
    if (!blocked) return;
    const explain = () => callback.current();
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    editors.add(explain);
    window.addEventListener('beforeunload', leave);
    return () => {
      editors.delete(explain);
      window.removeEventListener('beforeunload', leave);
    };
  }, [blocked]);
}
