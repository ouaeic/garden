import type { TaskEvent } from '@garden/contracts';
import { ApiError, apiUrl, get, responseError } from './client.js';

export interface EventPage {
  events: TaskEvent[];
  hasMore: boolean;
  oldestSequence: number | null;
  nextCursor: number;
}
export interface EventPageOptions {
  after?: number;
  before?: number;
  limit?: number;
  signal?: AbortSignal;
}

export async function loadEventPage(
  taskId: string,
  options: EventPageOptions = {}
): Promise<EventPage> {
  const query = new URLSearchParams({ page: '1', limit: String(options.limit ?? 200) });
  if (options.after !== undefined) query.set('after', String(options.after));
  if (options.before !== undefined) query.set('before', String(options.before));
  const result = await get<EventPage | TaskEvent[]>(
    `/v1/tasks/${encodeURIComponent(taskId)}/events?${query}`,
    options.signal ? { signal: options.signal } : {}
  );
  if (!Array.isArray(result)) return result;
  return {
    events: result,
    hasMore: false,
    oldestSequence: result[0]?.sequence ?? null,
    nextCursor: result.at(-1)?.sequence ?? options.after ?? 0
  };
}

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/** A broken connection must not accumulate an unfinished event indefinitely. */
export const MAX_SSE_FRAME_CHARACTERS = 8 * 1024 * 1024;

export async function readEventStream(
  response: Response,
  receive: (frame: SseFrame) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!response.body) throw new ApiError('stream_unavailable', 'The event stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let event = 'message';
  let id: string | undefined;
  let frameCharacters = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  const line = (value: string) => {
    if (!value) {
      if (data.length)
        receive({ event, data: data.join('\n'), ...(id === undefined ? {} : { id }) });
      data = [];
      event = 'message';
      id = undefined;
      frameCharacters = 0;
      return;
    }
    frameCharacters += value.length;
    if (frameCharacters > MAX_SSE_FRAME_CHARACTERS)
      throw new ApiError('stream_frame_too_large', 'The server sent an event too large to display');
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    const raw = colon < 0 ? '' : value.slice(colon + 1);
    const content = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'data') data.push(content);
    if (field === 'event') event = content;
    if (field === 'id' && !content.includes('\0')) id = content;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        if (!done && buffer[end] === '\r' && end === buffer.length - 1) break;
        const length = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + length);
      }
      if (buffer.length + frameCharacters > MAX_SSE_FRAME_CHARACTERS)
        throw new ApiError(
          'stream_frame_too_large',
          'The server sent an event too large to display'
        );
      if (done) break;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type StreamConnection = 'connecting' | 'connected' | 'reconnecting' | 'idle' | 'closed';
export interface SubscribeOptions {
  after?: number;
  onEvents: (events: TaskEvent[]) => void;
  onStatus?: (status: string) => void;
  onConnection?: (state: StreamConnection) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const isEvent = (value: unknown, taskId: string): value is TaskEvent => {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<TaskEvent>;
  return (
    event.taskId === taskId &&
    typeof event.sequence === 'number' &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    typeof event.id === 'string' &&
    typeof event.kind === 'string' &&
    typeof event.summary === 'string' &&
    typeof event.createdAt === 'string'
  );
};

/**
 * A terminal event changes to reconciliation, because cancellation can precede late worker rows.
 * The cursor belongs to delivered events; an interrupted fetch never advances it.
 */
export function subscribeTaskEvents(taskId: string, options: SubscribeOptions): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  let cursor = options.after ?? 0;
  let terminal = false;
  let wake: (() => void) | undefined;
  let activeConnection: AbortController | undefined;
  let reconnectForWake = false;
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const stop = () => controller.abort();
  const onWake = () => {
    wake?.();
    if (activeConnection) {
      reconnectForWake = true;
      activeConnection.abort();
    }
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  if (typeof window !== 'undefined') window.addEventListener('online', onWake);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onWake);
  const delay = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      wake = finish;
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    });
  const untilVisible = (): Promise<void> =>
    new Promise((resolve) => {
      const finish = () => {
        signal.removeEventListener('abort', finish);
        wake = undefined;
        resolve();
      };
      wake = finish;
      if (signal.aborted || !hidden()) finish();
      else signal.addEventListener('abort', finish, { once: true });
    });
  const visibleRead = async <T>(read: (readSignal: AbortSignal) => Promise<T>): Promise<T> => {
    const connection = new AbortController();
    activeConnection = connection;
    const abortConnection = () => connection.abort();
    signal.addEventListener('abort', abortConnection, { once: true });
    try {
      if (signal.aborted || hidden()) connection.abort();
      return await read(connection.signal);
    } finally {
      signal.removeEventListener('abort', abortConnection);
      if (activeConnection === connection) activeConnection = undefined;
    }
  };
  const deliver = (events: TaskEvent[]) => {
    if (signal.aborted) return;
    const fresh = events
      .filter((event) => isEvent(event, taskId) && event.sequence > cursor)
      .sort((a, b) => a.sequence - b.sequence)
      .filter((event, index, all) => event.sequence !== all[index - 1]?.sequence);
    if (!fresh.length) return;
    options.onEvents(fresh);
    cursor = fresh.at(-1)!.sequence;
  };
  const reconcile = async (): Promise<void> => {
    while (!signal.aborted && !hidden()) {
      const before = cursor;
      const page = await visibleRead((readSignal) =>
        loadEventPage(taskId, { after: cursor, signal: readSignal })
      );
      deliver(page.events);
      if (!page.hasMore) return;
      if (cursor <= before)
        throw new ApiError(
          'event_cursor_stalled',
          'The server could not continue this event history'
        );
    }
  };
  const run = async () => {
    let failures = 0;
    let initial = options.after === undefined;
    try {
      while (!signal.aborted) {
        try {
          if (hidden()) {
            options.onConnection?.('idle');
            await untilVisible();
            if (signal.aborted) return;
          }
          if (initial) {
            const page = await visibleRead((readSignal) =>
              loadEventPage(taskId, { signal: readSignal })
            );
            deliver(page.events);
            initial = false;
          }
          if (hidden()) continue;
          if (terminal) {
            /*
             * The stream closed on a terminal status, but the worker can still write after it -
             * the closing `status` and `error` of a task cancelled under a tool call land after
             * the frame that said the task was over. They arrive out of order: `terminal` is
             * emitted the moment status reads terminal, while the rows that explain it are still
             * being appended. So this branch reads the backlog one more time (rows written before
             * and right after the close), then falls through to re-open the stream on the next
             * tick - whose own open-time reconcile picks up whatever landed in between. The task
             * status is only polled to confirm the close, so a finished task does not pay a GET
             * burst; an unfinished one is re-announced and the stream resumed for the rest of it.
             */
            await reconcile();
            if (hidden()) continue;
            const task = await visibleRead((readSignal) =>
              get<{ status: string }>(`/v1/tasks/${encodeURIComponent(taskId)}`, {
                signal: readSignal
              })
            );
            if (signal.aborted) return;
            options.onStatus?.(task.status);
            terminal = terminalStatuses.has(task.status);
            if (terminal) {
              options.onConnection?.('idle');
              await delay(10_000);
              continue;
            }
          }
          options.onConnection?.(failures ? 'reconnecting' : 'connecting');
          const connection = new AbortController();
          activeConnection = connection;
          const abortConnection = () => connection.abort();
          signal.addEventListener('abort', abortConnection, { once: true });
          try {
            const response = await fetch(
              apiUrl(`/v1/tasks/${encodeURIComponent(taskId)}/events/stream?after=${cursor}`),
              {
                credentials: 'include',
                signal: connection.signal,
                headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(cursor) }
              }
            );
            if (!response.ok) throw await responseError(response);
            options.onConnection?.('connected');
            await readEventStream(
              response,
              (frame) => {
                let value: unknown;
                try {
                  value = JSON.parse(frame.data) as unknown;
                } catch {
                  throw new ApiError('invalid_event', 'The server sent an unreadable event');
                }
                if (frame.event === 'terminal') {
                  const status = (value as { status?: unknown } | null)?.status;
                  if (typeof status === 'string' && terminalStatuses.has(status)) {
                    terminal = true;
                    options.onStatus?.(status);
                  }
                } else if (isEvent(value, taskId)) deliver([value]);
              },
              connection.signal
            );
          } finally {
            signal.removeEventListener('abort', abortConnection);
            activeConnection = undefined;
          }
          await reconcile();
          failures = 0;
          if (!terminal) await delay(1000);
        } catch (cause) {
          if (signal.aborted) return;
          if (reconnectForWake) {
            reconnectForWake = false;
            failures = 0;
            continue;
          }
          const error =
            cause instanceof Error ? cause : new Error('The live connection was interrupted');
          options.onError?.(error);
          if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return;
          failures += 1;
          options.onConnection?.('reconnecting');
          await delay(Math.min(1000 * 2 ** Math.min(failures - 1, 5), 30_000));
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', stop);
      if (typeof window !== 'undefined') window.removeEventListener('online', onWake);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onWake);
      options.onConnection?.('closed');
    }
  };
  void run().catch((cause: unknown) => {
    if (!signal.aborted)
      options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
  });
  return stop;
}
