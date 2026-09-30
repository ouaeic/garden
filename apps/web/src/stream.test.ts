import type { TaskEvent } from '@garden/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SSE_FRAME_CHARACTERS,
  loadEventPage,
  readEventStream,
  subscribeTaskEvents
} from './stream.js';
import type { EventPage, SseFrame } from './stream.js';

const taskId = 'd032e2d2-bebd-43d6-94bd-c7014c9df39d';
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const event = (sequence: number): TaskEvent => ({
  id: `event-${sequence}`,
  taskId,
  sequence,
  kind: 'status',
  summary: `State ${sequence}`,
  createdAt: '2026-09-06T00:00:00.000Z'
});
const frame = (sequence: number) => `id: ${sequence}\ndata: ${JSON.stringify(event(sequence))}\n\n`;
const page = (events: TaskEvent[], hasMore = false): EventPage => ({
  events,
  hasMore,
  oldestSequence: events[0]?.sequence ?? null,
  nextCursor: events.at(-1)?.sequence ?? 0
});
const streamResponse = (...chunks: Uint8Array[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      }
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  );
const textStream = (text: string) => streamResponse(new TextEncoder().encode(text));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SSE wire contract', () => {
  it('preserves UTF-8 and CRLF across chunk boundaries and combines data lines', async () => {
    const bytes = new TextEncoder().encode(
      ': heartbeat\r\nid: 7\r\ndata: Héllo\r\ndata: world\r\n\r\n'
    );
    const chunks = [...bytes].map((byte) => Uint8Array.of(byte));
    const received: SseFrame[] = [];
    await readEventStream(streamResponse(...chunks), (value) => received.push(value));
    expect(received).toEqual([{ event: 'message', id: '7', data: 'Héllo\nworld' }]);
  });

  it('refuses an unfinished frame beyond the stream memory bound', async () => {
    const body = `data: ${'x'.repeat(MAX_SSE_FRAME_CHARACTERS)}`;
    await expect(readEventStream(textStream(body), () => undefined)).rejects.toMatchObject({
      code: 'stream_frame_too_large'
    });
  });

  it('does not deliver a truncated event when the connection ends', async () => {
    const received: SseFrame[] = [];
    await readEventStream(textStream('data: incomplete\n'), (value) => received.push(value));
    expect(received).toEqual([]);
  });
});

describe('event history and reconnection', () => {
  it('requests the history envelope and passes its actual backward cursor', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page([event(8)], true)));
    vi.stubGlobal('fetch', fetcher);
    await expect(loadEventPage(taskId, { before: 9, limit: 1 })).resolves.toMatchObject({
      hasMore: true,
      oldestSequence: 8
    });
    const url = new URL(urlOf(fetcher.mock.calls[0]![0]), 'https://local.example');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('before')).toBe('9');
    expect(url.searchParams.get('limit')).toBe('1');
  });

  it('replays a dropped connection from the last delivered sequence without duplicates', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const delivered: number[] = [];
    let streams = 0;
    let pages = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.includes('/events/stream')) {
        streams += 1;
        return textStream(streams === 1 ? frame(1) : frame(2) + frame(3));
      }
      pages += 1;
      return Response.json(pages === 1 ? page([event(1), event(2)]) : page([]));
    });
    vi.stubGlobal('fetch', fetcher);
    subscribeTaskEvents(taskId, {
      after: 0,
      signal: controller.signal,
      onEvents(events) {
        delivered.push(...events.map((item) => item.sequence));
        if (delivered.includes(3)) controller.abort();
      }
    });
    await vi.advanceTimersByTimeAsync(1100);
    expect(delivered).toEqual([1, 2, 3]);
    const streamCalls = fetcher.mock.calls.filter(([input]) =>
      urlOf(input).includes('/events/stream')
    );
    expect(streamCalls).toHaveLength(2);
    expect(new Headers(streamCalls[1]![1]!.headers).get('Last-Event-ID')).toBe('2');
    expect(urlOf(streamCalls[1]![0])).toContain('after=2');
  });

  it('reads late worker rows after terminal and keeps checking until the task is closed', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const delivered: number[] = [];
    let pages = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.includes('/events/stream'))
        return textStream(frame(1) + 'event: terminal\ndata: {"status":"cancelled"}\n\n');
      if (url.includes('/events?')) {
        pages += 1;
        return Response.json(page(pages === 1 ? [event(2)] : pages === 3 ? [event(3)] : []));
      }
      return Response.json({ status: 'cancelled' });
    });
    vi.stubGlobal('fetch', fetcher);
    subscribeTaskEvents(taskId, {
      after: 0,
      signal: controller.signal,
      onEvents(events) {
        delivered.push(...events.map((item) => item.sequence));
        if (delivered.includes(3)) controller.abort();
      }
    });
    await vi.advanceTimersByTimeAsync(10_100);
    expect(delivered).toEqual([1, 2, 3]);
    expect(
      fetcher.mock.calls.filter(([input]) => urlOf(input).includes('/events/stream'))
    ).toHaveLength(1);
    const callsAtClose = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(callsAtClose);
  });

  it('reconnects an apparently open socket when a sleeping device returns online', async () => {
    vi.useFakeTimers();
    const windowTarget = Object.assign(new EventTarget(), {
      location: { origin: 'http://localhost' }
    });
    vi.stubGlobal('window', windowTarget);
    const controller = new AbortController();
    const delivered: number[] = [];
    let streams = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (!urlOf(input).includes('/events/stream')) return Response.json(page([]));
      streams += 1;
      if (streams > 1) return textStream(frame(2));
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode(frame(1)));
          }
        })
      );
    });
    vi.stubGlobal('fetch', fetcher);
    subscribeTaskEvents(taskId, {
      after: 0,
      signal: controller.signal,
      onEvents(events) {
        delivered.push(...events.map((item) => item.sequence));
        if (delivered.includes(2)) controller.abort();
      }
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([1]);
    windowTarget.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([1, 2]);
    expect(streams).toBe(2);
  });

  it('suspends hidden views and resumes from the last delivered cursor without duplicate events', async () => {
    vi.useFakeTimers();
    const visibility = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    vi.stubGlobal('document', visibility);
    const controller = new AbortController();
    const delivered: number[] = [];
    const errors: Error[] = [];
    let streams = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (!urlOf(input).includes('/events/stream')) return Response.json(page([]));
      streams += 1;
      if (streams > 1) {
        expect(urlOf(input)).toContain('after=1');
        expect(new Headers(init?.headers).get('Last-Event-ID')).toBe('1');
        return textStream(frame(1) + frame(2));
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode(frame(1)));
          }
        })
      );
    });
    vi.stubGlobal('fetch', fetcher);
    subscribeTaskEvents(taskId, {
      after: 0,
      signal: controller.signal,
      onEvents(events) {
        delivered.push(...events.map((item) => item.sequence));
        if (delivered.includes(2)) controller.abort();
      },
      onError: (error) => errors.push(error)
    });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetcher).not.toHaveBeenCalled();
    visibility.visibilityState = 'visible';
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([1]);
    visibility.visibilityState = 'hidden';
    visibility.dispatchEvent(new Event('visibilitychange'));
    const calls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    visibility.visibilityState = 'visible';
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([1, 2]);
    expect(errors).toEqual([]);
    expect(streams).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains every forward page and refuses a cursor that cannot progress', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const delivered: number[] = [];
    const errors: Error[] = [];
    let pages = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        if (urlOf(input).includes('/events/stream')) return textStream(frame(1));
        pages += 1;
        return Response.json(page(pages === 1 ? [event(2)] : [event(2)], true));
      })
    );
    subscribeTaskEvents(taskId, {
      after: 0,
      signal: controller.signal,
      onEvents: (events) => delivered.push(...events.map((item) => item.sequence)),
      onError(error) {
        errors.push(error);
        controller.abort();
      }
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([1, 2]);
    expect(pages).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'event_cursor_stalled' });
  });
});
