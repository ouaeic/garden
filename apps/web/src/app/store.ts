import { useSyncExternalStore } from 'react';
import type { OwnerMove, Task, Workspace } from '@garden/contracts';
import { ApiError, get, post } from '../client';
import type { Bootstrap } from '../model';

/**
 * Everything the desk shows, held once for the whole interface.
 *
 * One bootstrap and one list of moves, refreshed together: on a timer while the page is visible,
 * at once when it becomes visible again, and shortly after anything the owner does. A view never
 * fetches what is already here.
 */
export interface GardenState {
  bootstrap: Bootstrap | null;
  moves: OwnerMove[];
  error: unknown;
  signedOut: boolean;
  loadedAt: number;
}

const SIGNED_OUT = new Set(['authentication_required', 'session_expired', 'invalid_session']);
const POLL_MS = 15_000;
const HEARTBEAT_MS = 60_000;

let state: GardenState = { bootstrap: null, moves: [], error: null, signedOut: false, loadedAt: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<GardenState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

let inFlight: Promise<void> | null = null;
let again = false;
let soon: ReturnType<typeof setTimeout> | undefined;

/** Reads the desk afresh. Overlapping calls share one read and queue at most one more. */
export function refresh(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      again = false;
      try {
        const [bootstrap, moves] = await Promise.all([
          get<Bootstrap>('/v1/bootstrap'),
          get<OwnerMove[]>('/v1/moves')
        ]);
        set({ bootstrap, moves, error: null, signedOut: false, loadedAt: Date.now() });
      } catch (error) {
        if (error instanceof ApiError && SIGNED_OUT.has(error.code)) set({ signedOut: true });
        else set({ error });
      }
    } while (again);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** After the owner acts: one read a moment later, however many actions arrive meanwhile. */
export function refreshSoon(delay = 400): void {
  clearTimeout(soon);
  soon = setTimeout(() => void refresh(), delay);
}

let started = false;
/** Starts the refresh loop and the computer's keep-awake heartbeat, once. */
export function startGarden(): void {
  if (started) return;
  started = true;
  void refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, POLL_MS);
  setInterval(() => {
    const id = primaryWorkspace(state.bootstrap)?.id;
    if (id && document.visibilityState === 'visible')
      void post(`/v1/workspaces/${id}/heartbeat`).catch(() => undefined);
  }, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
}

export const signedIn = () => set({ signedOut: false });

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useGarden = (): GardenState => useSyncExternalStore(subscribe, () => state);
export const gardenState = (): GardenState => state;

/** The computer the owner works on: the one they last had open, else the first running. */
export const primaryWorkspace = (bootstrap: Bootstrap | null): Workspace | null => {
  if (!bootstrap) return null;
  const place = (bootstrap.user.preferences?.place as { workspaceId?: string } | undefined)
    ?.workspaceId;
  return (
    bootstrap.workspaces.find((workspace) => workspace.id === place) ??
    bootstrap.workspaces.find((workspace) => workspace.status === 'running') ??
    bootstrap.workspaces[0] ??
    null
  );
};

/** Replaces one task in the desk's list as soon as an action returns it. */
export function putTask(task: Task): void {
  if (!state.bootstrap) return;
  const tasks = state.bootstrap.tasks.some((item) => item.id === task.id)
    ? state.bootstrap.tasks.map((item) => (item.id === task.id ? task : item))
    : [task, ...state.bootstrap.tasks];
  set({ bootstrap: { ...state.bootstrap, tasks } });
}
