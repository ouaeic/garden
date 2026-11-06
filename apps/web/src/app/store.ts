import { useMemo, useSyncExternalStore } from 'react';
import type { OwnerMove, Task, Workspace } from '@garden/contracts';
import { ApiError, apiUrl, get, post, responseError } from '../client';
import type { Bootstrap } from '../model';
import { forgetDraftKey, recoverDeviceDrafts } from '../draft-storage';
import { readEventStream, type SseFrame } from '../stream';
import { toast } from './toast';

/**
 * Everything the desk shows, held once for the whole interface.
 *
 * One bootstrap and one list of moves. The desk's own stream keeps them current: a conversation
 * that changes is patched into the list in place, and a change the moves may show reads the moves
 * again. A full read happens on connecting and on coming back into view, because nothing is
 * replayed to a device that was away, and once a minute besides for what no stream carries -
 * schedules, usage, the machine's readings. Without the stream - an older server, a connection
 * that keeps dropping - the full read runs every fifteen seconds instead. A view never fetches
 * what is already here.
 */
export interface GardenState {
  bootstrap: Bootstrap | null;
  moves: OwnerMove[];
  error: unknown;
  signedOut: boolean;
  loadedAt: number;
}

const SIGNED_OUT = new Set(['authentication_required', 'session_expired', 'invalid_session']);
/** The full read's pace when no stream is keeping the desk current. */
const POLL_MS = 15_000;
/** The full read's pace while one is: only what no stream carries is read on this beat. */
const SAFETY_MS = 60_000;
const HEARTBEAT_MS = 60_000;
/** Hints arrive in bursts - a question and the status beside it - and one read answers them all. */
const MOVES_SETTLE_MS = 250;
/**
 * How long a hidden tab keeps its stream. Long enough for a glance at another app; past it the
 * server's slot is worth more to the device the owner is holding, and coming back reads afresh.
 */
export const DESK_HIDDEN_CLOSE_MS = 60_000;
const DESK_RETRY_MAX_MS = 30_000;
/** A stream that stayed up this long was not failing, so the next drop starts the backoff again. */
const DESK_STEADY_MS = 10_000;

let state: GardenState = { bootstrap: null, moves: [], error: null, signedOut: false, loadedAt: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<GardenState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

const hidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Two answers that serialise the same are the same answer, whatever objects carried them. */
const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * A draft sealed on this device wins over the server's copy of the same scope: it is the newer
 * of the two whenever it exists, because it is only kept until the server has caught up.
 */
let draftWarned = false;
async function withDeviceDrafts(bootstrap: Bootstrap): Promise<void> {
  try {
    const scope = (draft: Bootstrap['drafts'][number]) =>
      draft.taskId ?? `new:${draft.workspaceId}`;
    const merged = new Map(bootstrap.drafts.map((draft) => [scope(draft), draft]));
    for (const draft of await recoverDeviceDrafts(bootstrap.user.id))
      merged.set(scope(draft), draft);
    bootstrap.drafts = [...merged.values()];
  } catch {
    if (draftWarned) return;
    draftWarned = true;
    toast('Drafts kept on this device could not be opened. Reload to try again.');
  }
}

/**
 * The order things happened in on this page. A count rather than a clock: a frame and a read that
 * begin in the same millisecond still happen one after the other, and a clock that coarse - some
 * browsers round to the millisecond - would call them simultaneous and keep the wrong one.
 */
let order = 0;
const nextInOrder = (): number => (order += 1);

/**
 * The conversations something newer than a full read has said about: the stream, or the answer
 * to an action the owner took. A full read that began before one of these cannot know it, so it
 * keeps the newer copy, and lets go of the mark once a read that began after it has landed.
 */
const told = new Map<string, { task: Task | null; at: number }>();
const tell = (taskId: string, task: Task | null) => told.set(taskId, { task, at: nextInOrder() });

/** Keeps what has not changed as the same object, so a view selecting it is left alone. */
function shared(fresh: Bootstrap, previous: Bootstrap | null, startedAt: number): Bootstrap {
  const before = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
  const listed = new Set<string>();
  const tasks: Task[] = [];
  for (const task of fresh.tasks) {
    listed.add(task.id);
    const newer = told.get(task.id);
    const current = newer && newer.at > startedAt ? newer.task : task;
    if (!current) continue;
    const old = before.get(task.id);
    tasks.push(old && same(old, current) ? old : current);
  }
  // Conversations that began while this read was in flight, which it therefore could not list.
  const arrived: Task[] = [];
  for (const [taskId, newer] of told)
    if (newer.at > startedAt && newer.task && !listed.has(taskId))
      if (!newer.task.archivedAt && !newer.task.parentMissionId) arrived.push(newer.task);
  for (const [taskId, newer] of told) if (newer.at <= startedAt) told.delete(taskId);
  const merged = [...arrived, ...tasks];
  const next: Bootstrap = {
    ...fresh,
    tasks:
      previous &&
      merged.length === previous.tasks.length &&
      merged.every((task, index) => task === previous.tasks[index])
        ? previous.tasks
        : merged
  };
  if (!previous) return next;
  const record = next as unknown as Record<string, unknown>;
  const old = previous as unknown as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== 'tasks' && key in old && same(record[key], old[key])) record[key] = old[key];
  return next;
}

let movesAsked = 0;
let movesApplied = 0;
/** Moves answered out of order must not land out of order: the later question wins. */
function applyMoves(moves: OwnerMove[], asked: number): OwnerMove[] {
  if (asked < movesApplied) return state.moves;
  movesApplied = asked;
  return same(state.moves, moves) ? state.moves : moves;
}

let inFlight: Promise<void> | null = null;
let again = false;
let soon: ReturnType<typeof setTimeout> | undefined;
/** Where in `order` the latest full read began, and when, for the beat that paces the next. */
let refreshStartedAt = 0;
let refreshStartedTime = Number.NEGATIVE_INFINITY;

const signOutHere = () => {
  forgetDraftKey();
  closeDesk();
  set({ signedOut: true });
};

/** Reads the desk afresh. Overlapping calls share one read and queue at most one more. */
export function refresh(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      again = false;
      const startedAt = nextInOrder();
      refreshStartedAt = startedAt;
      refreshStartedTime = performance.now();
      const asked = (movesAsked += 1);
      try {
        const [bootstrap, moves] = await Promise.all([
          get<Bootstrap>('/v1/bootstrap'),
          get<OwnerMove[]>('/v1/moves')
        ]);
        await withDeviceDrafts(bootstrap);
        set({
          bootstrap: shared(bootstrap, state.bootstrap, startedAt),
          moves: applyMoves(moves, asked),
          error: null,
          signedOut: false,
          loadedAt: Date.now()
        });
      } catch (error) {
        if (error instanceof ApiError && SIGNED_OUT.has(error.code)) signOutHere();
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

let movesTimer: ReturnType<typeof setTimeout> | undefined;
let movesReading = false;
let movesAgain = false;
/**
 * The stream said the moves may have changed: read them once things settle. Not while hidden - a
 * hidden page reads nothing, and coming back into view reads everything anyway.
 */
function movesSoon(): void {
  if (hidden()) return;
  if (movesReading) {
    movesAgain = true;
    return;
  }
  if (movesTimer) return;
  movesTimer = setTimeout(() => {
    movesTimer = undefined;
    void readMoves();
  }, MOVES_SETTLE_MS);
}

async function readMoves(): Promise<void> {
  movesReading = true;
  const asked = (movesAsked += 1);
  try {
    const moves = applyMoves(await get<OwnerMove[]>('/v1/moves'), asked);
    if (moves !== state.moves) set({ moves });
  } catch (error) {
    // Anything else is the next full read's to put right.
    if (error instanceof ApiError && SIGNED_OUT.has(error.code)) signOutHere();
  } finally {
    movesReading = false;
    if (movesAgain) {
      movesAgain = false;
      movesSoon();
    }
  }
}

/** One conversation, as the stream or an action says it is now. */
function patchTask(task: Task): void {
  tell(task.id, task);
  if (!state.bootstrap) return;
  const tasks = state.bootstrap.tasks;
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) {
    if (same(tasks[index], task)) return;
    const next = tasks.slice();
    next[index] = task;
    set({ bootstrap: { ...state.bootstrap, tasks: next } });
    return;
  }
  // One the list does not hold joins it only if the bootstrap would list it there: never one
  // filed away, never a specialist's.
  if (!task.archivedAt && !task.parentMissionId)
    set({ bootstrap: { ...state.bootstrap, tasks: [task, ...tasks] } });
}

function dropTask(taskId: string): void {
  tell(taskId, null);
  if (!state.bootstrap?.tasks.some((task) => task.id === taskId)) return;
  set({
    bootstrap: {
      ...state.bootstrap,
      tasks: state.bootstrap.tasks.filter((task) => task.id !== taskId)
    }
  });
}

/** The little a frame must be to be applied; anything less is left to the next full read. */
const isTask = (value: unknown): value is Task => {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<Record<keyof Task, unknown>>;
  return (
    typeof task.id === 'string' &&
    typeof task.workspaceId === 'string' &&
    typeof task.title === 'string' &&
    typeof task.status === 'string' &&
    typeof task.createdAt === 'string' &&
    typeof task.updatedAt === 'string'
  );
};

function receive(frame: SseFrame): void {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(frame.data) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (frame.event === 'task') {
    if (isTask(value.task)) patchTask(value.task);
    if (value.moves === true) movesSoon();
  } else if (frame.event === 'removed') {
    if (typeof value.taskId === 'string') dropTask(value.taskId);
    movesSoon();
  } else if (frame.event === 'moves') movesSoon();
}

/**
 * The desk's stream: one per tab, ever. `desk` is the connection in hand, if there is one; every
 * way of opening one goes through `openDesk`, which refuses while another is open.
 */
let desk: { controller: AbortController; requestedAt: number } | null = null;
let live = false;
let deskFailures = 0;
let deskRetry: ReturnType<typeof setTimeout> | undefined;
let deskHidden: ReturnType<typeof setTimeout> | undefined;
/** A server that does not have the stream is polled for the rest of this page's life. */
let deskUnsupported = false;
let started = false;

/** Whether the desk's stream is open right now, so a view can leave its own re-reading to it. */
export const deskIsLive = (): boolean => live;

function closeDesk(): void {
  clearTimeout(deskRetry);
  deskRetry = undefined;
  const current = desk;
  desk = null;
  live = false;
  current?.controller.abort();
}

function openDesk(): void {
  if (!started || desk || deskUnsupported || state.signedOut || hidden()) return;
  clearTimeout(deskRetry);
  deskRetry = undefined;
  const opened = { controller: new AbortController(), requestedAt: nextInOrder() };
  desk = opened;
  void followDesk(opened);
}

async function followDesk(opened: { controller: AbortController; requestedAt: number }) {
  const { signal } = opened.controller;
  let connectedAt: number | null = null;
  let stop = false;
  try {
    const response = await fetch(apiUrl('/v1/events/stream'), {
      credentials: 'include',
      signal,
      headers: { Accept: 'text/event-stream' }
    });
    if (!response.ok) throw await responseError(response);
    // Let go of while it was connecting: the signal has already ended it.
    if (desk !== opened) return;
    connectedAt = performance.now();
    live = true;
    // The server subscribed before it answered, so a read that begins after this request covers
    // everything the stream will not. Opening and reading in that order is what lets the read
    // made on start and on coming back into view count for both.
    if (refreshStartedAt < opened.requestedAt) void refresh();
    await readEventStream(response, receive, signal);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      deskUnsupported = true;
      stop = true;
    } else if (cause instanceof ApiError && (cause.status === 401 || SIGNED_OUT.has(cause.code))) {
      stop = true;
      if (!inFlight) void refresh();
    }
  } finally {
    if (desk === opened) desk = null;
    // A connection that replaced this one keeps its own word on whether the desk is live.
    if (desk === null) live = false;
  }
  if (signal.aborted || stop) return;
  deskFailures =
    connectedAt !== null && performance.now() - connectedAt > DESK_STEADY_MS ? 1 : deskFailures + 1;
  deskRetry = setTimeout(
    () => {
      deskRetry = undefined;
      openDesk();
    },
    Math.min(1_000 * 2 ** Math.min(deskFailures - 1, 5), DESK_RETRY_MAX_MS)
  );
}

/** Starts the desk's stream, its fallback reads and the computer's keep-awake heartbeat, once. */
export function startGarden(): void {
  if (started) return;
  started = true;
  openDesk();
  void refresh();
  setInterval(() => {
    if (hidden() || state.signedOut) return;
    // A second of slack, so a beat that lands a moment early does not wait a whole beat more.
    if (performance.now() - refreshStartedTime >= (live ? SAFETY_MS : POLL_MS) - 1_000)
      void refresh();
  }, POLL_MS);
  setInterval(() => {
    const id = primaryWorkspace(state.bootstrap)?.id;
    if (id && !hidden()) void post(`/v1/workspaces/${id}/heartbeat`).catch(() => undefined);
  }, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => {
    clearTimeout(deskHidden);
    deskHidden = undefined;
    if (hidden()) {
      deskHidden = setTimeout(() => {
        deskHidden = undefined;
        if (hidden()) closeDesk();
      }, DESK_HIDDEN_CLOSE_MS);
      return;
    }
    // Coming back is not a failure, so it reconnects now rather than at the end of a backoff.
    if (!desk) {
      deskFailures = 0;
      openDesk();
    }
    void refresh();
  });
  if (typeof window !== 'undefined')
    window.addEventListener('online', () => {
      if (desk) return;
      deskFailures = 0;
      openDesk();
    });
}

export const signedIn = () => {
  set({ signedOut: false });
  openDesk();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useGarden = (): GardenState => useSyncExternalStore(subscribe, () => state);
export const gardenState = (): GardenState => state;

/**
 * The memo behind `useGardenSelector`: the selection is recomputed only when the state changes,
 * and kept as the same value while `isEqual` says it has not.
 */
export function gardenSlice<T>(
  selector: (state: GardenState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): () => T {
  let seen: GardenState | null = null;
  let value: T;
  return () => {
    if (seen === state) return value;
    const next = selector(state);
    if (seen === null || !isEqual(value, next)) value = next;
    seen = state;
    return value;
  };
}

/**
 * One slice of the desk, re-rendering only when that slice changes.
 *
 * The desk changes far more often than any one view's part of it - every conversation that moves,
 * every minute's machine readings - and `useGarden` re-renders on all of it. Select what is
 * stored, a task or a list, and the default identity check is enough, because what has not changed
 * keeps its object; select something built fresh each time and pass `isEqual`.
 */
export function useGardenSelector<T>(
  selector: (state: GardenState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  const snapshot = useMemo(() => gardenSlice(selector, isEqual), [selector, isEqual]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

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
  tell(task.id, task);
  if (!state.bootstrap) return;
  const tasks = state.bootstrap.tasks.some((item) => item.id === task.id)
    ? state.bootstrap.tasks.map((item) => (item.id === task.id ? task : item))
    : [task, ...state.bootstrap.tasks];
  set({ bootstrap: { ...state.bootstrap, tasks } });
}
