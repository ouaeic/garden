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

const notify = () => listeners.forEach((listener) => listener());

export const setDirection = (taskId: string, context: DirectionContext | null) => {
  contexts.set(taskId, context);
  notify();
};

/**
 * Restores what a saved draft was pointing at, unless this tab has already said otherwise. Safe to
 * call while rendering: the change is announced after the render that made it.
 */
export const seedDirection = (taskId: string, context: DirectionContext | null | undefined) => {
  if (contexts.has(taskId) || !context) return;
  contexts.set(taskId, context);
  queueMicrotask(notify);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useDirection = (taskId: string | null): DirectionContext | null =>
  useSyncExternalStore(subscribe, () => (taskId ? (contexts.get(taskId) ?? null) : null));

/**
 * A recorded analysis, handed to the ask bar to be rerun with changes as a new goal: the record is
 * checked again when the goal is planted, so a run that changed since it was opened is refused.
 */
export const rerunAnalysis = (selection: Extract<DirectionContext, { kind: 'analysis' }>) => {
  setDirection(NEW_GOAL, selection);
  dispatchEvent(new CustomEvent('garden:rerun-analysis'));
};

/** The direction slot for a goal that is not planted yet. */
export const NEW_GOAL = 'new';
