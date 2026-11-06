import { useEffect, useSyncExternalStore } from 'react';
import { ApiError, get } from '../client';

export interface OutcomeFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  createdAt: string;
}

/**
 * What a goal came back with, as the desk shows it: the result in a line, what was checked, what
 * is the owner's call, and the files and previews that are the work itself. Served by
 * `GET /v1/outcomes` from the run's own final reply, so nothing here is a second model's guess.
 */
export interface Outcome {
  taskId: string;
  answer: string | null;
  headline: string | null;
  checked: string[];
  yourCall: string[];
  verification: string | null;
  risks: string[];
  files: OutcomeFile[];
  previews: { id: string; label: string; port?: number; createdAt?: string }[];
  at: string | null;
}

const empty = (taskId: string): Outcome => ({
  taskId,
  answer: null,
  headline: null,
  checked: [],
  yourCall: [],
  verification: null,
  risks: [],
  files: [],
  previews: [],
  at: null
});

/** The most one read asks for; the route refuses more. */
const BATCH = 24;

const held = new Map<string, { outcome: Outcome; stamp: string }>();
const wanted = new Map<string, string>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let unsupported = false;

const publish = () => {
  version += 1;
  listeners.forEach((listener) => listener());
};

async function flush() {
  timer = undefined;
  const batch = [...wanted].filter(([id]) => !inFlight.has(id)).slice(0, BATCH);
  if (!batch.length) return;
  for (const [id] of batch) {
    wanted.delete(id);
    inFlight.add(id);
  }
  try {
    const { outcomes } = unsupported
      ? { outcomes: [] as Outcome[] }
      : await get<{ outcomes: Outcome[] }>(
          `/v1/outcomes?ids=${batch.map(([id]) => encodeURIComponent(id)).join(',')}`
        );
    const byId = new Map(outcomes.map((outcome) => [outcome.taskId, outcome]));
    for (const [id, stamp] of batch) held.set(id, { outcome: byId.get(id) ?? empty(id), stamp });
  } catch (cause) {
    // A server from before this route says so once; the desk then draws from the goals alone.
    if (cause instanceof ApiError && cause.status === 404) unsupported = true;
    for (const [id, stamp] of batch) if (!held.has(id)) held.set(id, { outcome: empty(id), stamp });
  } finally {
    for (const [id] of batch) inFlight.delete(id);
    publish();
    if (wanted.size) timer = setTimeout(() => void flush(), 0);
  }
}

/** Asks for every outcome not held at this stamp; the reads are shared and batched. */
export function requestOutcomes(tasks: readonly { id: string; updatedAt: string }[]) {
  let added = false;
  for (const task of tasks) {
    if (held.get(task.id)?.stamp === task.updatedAt || inFlight.has(task.id)) continue;
    wanted.set(task.id, task.updatedAt);
    added = true;
  }
  if (added && !timer) timer = setTimeout(() => void flush(), 30);
}

export const outcomeOf = (taskId: string): Outcome | undefined => held.get(taskId)?.outcome;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The outcomes for these goals, read as they come into view and again when a goal changes. */
export function useOutcomes(tasks: readonly { id: string; updatedAt: string }[]): number {
  const key = tasks.map((task) => `${task.id}@${task.updatedAt}`).join('|');
  useEffect(() => {
    requestOutcomes(tasks);
    // The key is the dependency: the same goals at the same stamps need nothing new.
  }, [key]);
  return useSyncExternalStore(subscribe, () => version);
}
