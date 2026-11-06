import { useSyncExternalStore } from 'react';

/**
 * What the owner has just asked from Home, newest first, for this visit only.
 *
 * An ask answers where it was asked: its card stays under the input until the owner dismisses it
 * or opens it, so a quick question never sends anyone to another screen to read one word.
 */
const LIMIT = 3;
let asked: readonly string[] = [];
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((listener) => listener());

export function addAsked(taskId: string): void {
  asked = [taskId, ...asked.filter((id) => id !== taskId)].slice(0, LIMIT);
  publish();
}

export function dismissAsked(taskId: string): void {
  asked = asked.filter((id) => id !== taskId);
  publish();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useAsked = (): readonly string[] => useSyncExternalStore(subscribe, () => asked);

const FOCUS = 'garden:focus-ask';

/** Puts the cursor in the ask on Home, from anywhere: the rail's New, the phone's plus, Cmd-J. */
export function focusAsk(): void {
  // After the view has had a frame to mount the input.
  requestAnimationFrame(() => dispatchEvent(new Event(FOCUS)));
}

export const onFocusAsk = (listener: () => void) => {
  addEventListener(FOCUS, listener);
  return () => removeEventListener(FOCUS, listener);
};
