/**
 * The few things other parts of the interface ask of the ask bar, and the goal it is waiting on.
 *
 * A goal just sent is watched until it either proposes a deal, which opens the deal, or answers,
 * which opens the answer - so asking never leaves the owner looking at nothing.
 */
type Listener = (text: string) => void;
const listeners = new Set<Listener>();

export const EXAMPLE =
  'Every Monday morning, read my starred email from the week and give me a one-page brief of what still needs me.';

export const onAskText = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const askWith = (text: string) => listeners.forEach((listener) => listener(text));
export const askExample = () => askWith(EXAMPLE);

let watched: { taskId: string; since: number } | null = null;
export const watchSent = (taskId: string) => {
  watched = { taskId, since: Date.now() };
};
export const watching = () => watched;
export const stopWatching = () => {
  watched = null;
};
