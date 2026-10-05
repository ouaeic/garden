import { useSyncExternalStore } from 'react';
import type { DirectionContext } from '@garden/contracts';

/**
 * What the owner has pointed at in a goal's work - comments pinned to the answer, a file, a view or
 * a live app - waiting to travel with the next thing they say to that goal.
 *
 * Held per goal outside both the work and the ask bar, because the two are on different parts of
 * the screen and either may be open without the other.
 */
const contexts = new Map<string, DirectionContext | null>();
const listeners = new Set<() => void>();

export const setDirection = (taskId: string, context: DirectionContext | null) => {
  contexts.set(taskId, context);
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useDirection = (taskId: string | null): DirectionContext | null =>
  useSyncExternalStore(subscribe, () => (taskId ? (contexts.get(taskId) ?? null) : null));
