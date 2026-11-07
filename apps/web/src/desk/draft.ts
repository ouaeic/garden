import { useSyncExternalStore } from 'react';

/**
 * What is being typed into the desk's ask, for the ghost that shows what it will come back as.
 * Kept out of React state so a keystroke redraws the ghost and nothing else on the desk.
 */
let text = '';
const listeners = new Set<() => void>();

export function publishDraft(next: string) {
  if (next === text) return;
  text = next;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useDraftText = () => useSyncExternalStore(subscribe, () => text);
