import { useEffect, useReducer } from 'react';
import type { ComputationSession, ProcessList } from '@garden/contracts';
import { get } from './client';
import { observeVisiblePoll } from './visible-poll';

/*
 * One reader per list of runs. The run lines in a conversation, the project's jobs link and the
 * processes panel can all be on screen at once and all want the same list; each asking on its own
 * timer tripled the requests for one answer. They subscribe here instead: one request at a time,
 * at the pace the runner asks for, or faster while a subscriber needs it (a busy kernel), and only
 * while the page is visible.
 */

interface Feed {
  list: ProcessList | null;
  error: unknown;
  loading: boolean;
  /** When the list was last read, so a view opened on an old one reads again. */
  readAt: number;
  listeners: Set<() => void>;
  /** The fastest pace each subscriber wants, beside the runner's own. */
  paces: Map<symbol, number>;
  /** Whether any subscriber wants the computer's notebook kernels read with its runs. */
  kernels: Map<symbol, boolean>;
  stop?: (() => void) | undefined;
}

const feeds = new Map<string, Feed>();
const feedFor = (endpoint: string): Feed => {
  let feed = feeds.get(endpoint);
  if (!feed) {
    feed = {
      list: null,
      error: null,
      loading: false,
      readAt: 0,
      listeners: new Set(),
      paces: new Map(),
      kernels: new Map()
    };
    feeds.set(endpoint, feed);
  }
  return feed;
};
const notify = (feed: Feed) => feed.listeners.forEach((listener) => listener());

const workspaceOf = (endpoint: string) =>
  /^\/v1\/workspaces\/([^/]+)\/processes$/.exec(endpoint)?.[1];

async function read(endpoint: string, feed: Feed, signal: AbortSignal) {
  feed.loading = true;
  notify(feed);
  try {
    const workspace = workspaceOf(endpoint);
    const kernels = workspace && [...feed.kernels.values()].some(Boolean);
    const [list, computations] = await Promise.all([
      get<ProcessList>(endpoint, { signal }),
      kernels
        ? get<{ sessions: ComputationSession[] }>(`/v1/workspaces/${workspace}/computation`, {
            signal
          }).catch(() => null)
        : Promise.resolve(undefined)
    ]);
    if (computations !== undefined) {
      list.computationSessions = computations?.sessions ?? [];
      if (!computations) list.unavailableComputationWorkspaces = 1;
    }
    if (signal.aborted) return;
    feed.list = list;
    feed.error = null;
    feed.readAt = Date.now();
  } finally {
    if (!signal.aborted) {
      feed.loading = false;
      notify(feed);
    }
  }
}

function start(endpoint: string, feed: Feed) {
  feed.stop?.();
  feed.stop = observeVisiblePoll(
    (signal) => read(endpoint, feed, signal),
    () => Math.min(Math.max(60_000, feed.list?.refreshAfterMs ?? 120_000), ...feed.paces.values()),
    (cause) => {
      feed.error = cause;
      feed.loading = false;
      notify(feed);
    }
  );
}

/** Reads now, for a subscriber that has just changed something the list reflects. */
export function refreshProcesses(endpoint: string): void {
  const feed = feeds.get(endpoint);
  if (feed?.listeners.size) start(endpoint, feed);
}

/**
 * The runs at an endpoint, kept current while the view showing them is mounted and visible.
 * `paceMs` asks for reads at least that often; `kernels` adds the computer's notebook kernels to a
 * computer-wide list.
 */
export function useProcessFeed(
  endpoint: string | null,
  { paceMs, kernels = false }: { paceMs?: number | undefined; kernels?: boolean } = {}
) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!endpoint) return;
    const feed = feedFor(endpoint);
    const token = Symbol(endpoint);
    feed.listeners.add(rerender);
    feed.kernels.set(token, kernels);
    if (paceMs) feed.paces.set(token, paceMs);
    if (
      feed.listeners.size === 1 ||
      Date.now() - feed.readAt > 15_000 ||
      (kernels && !feed.list?.computationSessions)
    )
      start(endpoint, feed);
    else rerender();
    return () => {
      feed.listeners.delete(rerender);
      feed.paces.delete(token);
      feed.kernels.delete(token);
      if (!feed.listeners.size) {
        feed.stop?.();
        feed.stop = undefined;
      }
    };
  }, [endpoint, paceMs, kernels]);
  const feed = endpoint ? feeds.get(endpoint) : undefined;
  return {
    list: feed?.list ?? null,
    error: feed?.error ?? null,
    loading: feed?.loading ?? false
  };
}
