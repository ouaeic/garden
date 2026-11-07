import type { OwnerMove, Task } from '@garden/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StoreModule from './store';

vi.mock('../draft-storage', () => ({
  recoverDeviceDrafts: async () => [],
  forgetDraftKey: () => undefined
}));

/** A fresh copy per test: the store is module state, and every test starts a garden of its own. */
type Store = typeof StoreModule;

const conversation = (id: string, patch: Partial<Task> = {}): Task =>
  ({
    id,
    workspaceId: 'workspace',
    scheduleId: null,
    title: `Goal ${id}`,
    status: 'running',
    modelId: 'model',
    privacyRoute: 'provider_zdr',
    securityMode: 'balanced',
    lentKeys: [],
    maxComputeCredits: 1,
    actualComputeCredits: 0,
    maxSpendUsd: null,
    spentUsd: 0,
    spendPausedAt: null,
    completedAt: null,
    queuedMessageCount: 0,
    shareCount: 0,
    rewind: null,
    restoredCheckpointId: null,
    pinned: false,
    archivedAt: null,
    createdAt: '2026-11-06T09:00:00.000Z',
    updatedAt: '2026-11-06T09:00:00.000Z',
    ...patch
  }) as Task;

const bootstrapWith = (tasks: Task[]) => ({
  user: { id: 'owner' },
  workspaces: [],
  tasks,
  tasksCursor: null,
  scheduleRunCounts: {},
  schedules: [],
  drafts: [],
  models: [],
  instance: { mode: 'self_hosted', providerConfigured: true, enforceZeroDataRetention: false },
  usage: { consumedCredits: 0, reservedCredits: 0, storageBytes: 0, storageLimitBytes: 1 }
});

/** A desk stream the test writes frames into, and can see being let go of. */
const deskStream = () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      controller = stream;
    },
    cancel() {
      cancelled = true;
    }
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    send: (event: string, data: unknown) =>
      controller?.enqueue(
        new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      ),
    end: () => controller?.close(),
    cancelled: () => cancelled
  };
};

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

let store: Store;
let reads: string[];
let streams: Array<ReturnType<typeof deskStream>>;
let streamStatus: number;
let tasks: Task[];
let moves: OwnerMove[];
/** When set, the next bootstrap waits for the test to let it answer. */
let holdBootstrap: Promise<void> | null;
let visibility: EventTarget & { visibilityState: DocumentVisibilityState };

const count = (path: string) => reads.filter((read) => read === path).length;
const settle = () => vi.advanceTimersByTimeAsync(0);
const show = (state: DocumentVisibilityState) => {
  visibility.visibilityState = state;
  visibility.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance']
  });
  visibility = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState
  });
  vi.stubGlobal('document', visibility);
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { location: { origin: 'http://localhost' } })
  );
  reads = [];
  streams = [];
  streamStatus = 200;
  tasks = [conversation('a'), conversation('b')];
  moves = [];
  holdBootstrap = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(urlOf(input), 'http://localhost').pathname;
      reads.push(path);
      if (path === '/v1/events/stream') {
        if (streamStatus !== 200)
          return Response.json({ error: { code: 'not_found' } }, { status: streamStatus });
        const stream = deskStream();
        streams.push(stream);
        return stream.response;
      }
      if (path === '/v1/bootstrap') {
        const answer = bootstrapWith(structuredClone(tasks));
        const held = holdBootstrap;
        holdBootstrap = null;
        if (held) await held;
        return Response.json(answer);
      }
      if (path === '/v1/moves') return Response.json(structuredClone(moves));
      return Response.json({});
    })
  );
  store = await import('./store');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a live desk', () => {
  it('patches the one conversation a frame names, and reads nothing else for it', async () => {
    store.startGarden();
    await settle();
    expect(count('/v1/bootstrap')).toBe(1);
    expect(count('/v1/events/stream')).toBe(1);
    const before = store.gardenState().bootstrap!.tasks;

    streams[0]!.send('task', { task: conversation('a', { status: 'completed' }), moves: false });
    await settle();
    const after = store.gardenState().bootstrap!.tasks;
    expect(after.map((task) => [task.id, task.status])).toEqual([
      ['a', 'completed'],
      ['b', 'running']
    ]);
    // The conversation nothing was said about is the same object, so nothing selecting it renders.
    expect(after[1]).toBe(before[1]);
    expect(count('/v1/bootstrap')).toBe(1);
    expect(count('/v1/moves')).toBe(1);

    // A new conversation goes on the desk; one filed away or a specialist's never arrives there.
    streams[0]!.send('task', { task: conversation('c'), moves: false });
    streams[0]!.send('task', {
      task: conversation('d', { archivedAt: '2026-11-06T09:30:00.000Z' }),
      moves: false
    });
    streams[0]!.send('task', { task: conversation('e', { parentMissionId: 'x' }), moves: false });
    streams[0]!.send('removed', { taskId: 'b' });
    await settle();
    expect(store.gardenState().bootstrap!.tasks.map((task) => task.id)).toEqual(['c', 'a']);
  });

  it('reads the moves once for a burst of hints, and not at all for frames without one', async () => {
    store.startGarden();
    await settle();
    const before = count('/v1/moves');
    streams[0]!.send('task', { task: conversation('a', { updatedAt: 'later' }), moves: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count('/v1/moves')).toBe(before);

    moves = [{ kind: 'spend', taskId: 'a' } as unknown as OwnerMove];
    streams[0]!.send('task', { task: conversation('a', { status: 'awaiting_user' }), moves: true });
    streams[0]!.send('moves', { taskId: 'a-specialist' });
    streams[0]!.send('removed', { taskId: 'b' });
    await vi.advanceTimersByTimeAsync(100);
    expect(count('/v1/moves')).toBe(before);
    await vi.advanceTimersByTimeAsync(200);
    expect(count('/v1/moves')).toBe(before + 1);
    expect(store.gardenState().moves).toEqual(moves);
  });

  it('reads the desk in full once a minute while live, and every fifteen seconds without it', async () => {
    store.startGarden();
    await settle();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(count('/v1/bootstrap')).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(count('/v1/bootstrap')).toBe(2);
    // An unchanged answer leaves the list as it was: the minute's read re-renders nothing in it.
    const listed = store.gardenState().bootstrap!.tasks;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count('/v1/bootstrap')).toBe(3);
    expect(store.gardenState().bootstrap!.tasks).toBe(listed);
  });

  it('falls back to the old beat on a server without the stream, and stops asking for it', async () => {
    streamStatus = 404;
    store.startGarden();
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count('/v1/bootstrap')).toBe(3);
    expect(count('/v1/events/stream')).toBe(1);
    expect(store.deskIsLive()).toBe(false);
  });

  it('reads the desk in full when the stream comes back, after a backoff', async () => {
    store.startGarden();
    await settle();
    expect(store.deskIsLive()).toBe(true);
    streams[0]!.end();
    await settle();
    expect(store.deskIsLive()).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(count('/v1/events/stream')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count('/v1/events/stream')).toBe(2);
    // Nothing is replayed to a device that was away, so the reconnect reads everything once.
    expect(count('/v1/bootstrap')).toBe(2);
    expect(store.deskIsLive()).toBe(true);
  });

  it('keeps one stream per tab, however it is woken', async () => {
    store.startGarden();
    store.startGarden();
    await settle();
    for (let wake = 0; wake < 4; wake += 1) {
      window.dispatchEvent(new Event('online'));
      show('visible');
      store.signedIn();
    }
    await settle();
    expect(count('/v1/events/stream')).toBe(1);
  });

  it('lets go of the stream after a minute hidden, reads nothing, and reconnects on return', async () => {
    store.startGarden();
    await settle();
    const quietFrom = reads.length;
    show('hidden');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(streams[0]!.cancelled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(streams[0]!.cancelled()).toBe(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(reads.slice(quietFrom)).toEqual([]);

    show('visible');
    await settle();
    // One stream and one full read: the read made for coming back is the one the stream needs.
    expect(reads.slice(quietFrom).sort()).toEqual([
      '/v1/bootstrap',
      '/v1/events/stream',
      '/v1/moves'
    ]);
  });

  it('keeps what a frame said over a full read that began before it', async () => {
    store.startGarden();
    await settle();
    let answer: () => void = () => undefined;
    holdBootstrap = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const reading = store.refresh();
    await settle();
    streams[0]!.send('task', { task: conversation('a', { status: 'completed' }), moves: false });
    streams[0]!.send('task', { task: conversation('z'), moves: false });
    await settle();
    answer();
    await reading;
    const listed = store.gardenState().bootstrap!.tasks;
    expect(listed.find((task) => task.id === 'a')?.status).toBe('completed');
    expect(listed.map((task) => task.id)).toContain('z');

    // A read that began after the frame is the server's word again.
    tasks = [conversation('a', { status: 'failed' }), conversation('b')];
    await store.refresh();
    expect(
      store
        .gardenState()
        .bootstrap!.tasks.map((task) => [task.id, task.status])
        .sort()
    ).toEqual([
      ['a', 'failed'],
      ['b', 'running']
    ]);
  });

  it('keeps a selection as the same value while its part of the desk is unchanged', async () => {
    store.startGarden();
    await settle();
    const pick = store.gardenSlice((state) =>
      state.bootstrap?.tasks.find((task) => task.id === 'b')
    );
    const first = pick();
    expect(first?.id).toBe('b');
    streams[0]!.send('task', { task: conversation('a', { status: 'paused' }), moves: false });
    await settle();
    expect(pick()).toBe(first);
    streams[0]!.send('task', { task: conversation('b', { status: 'paused' }), moves: false });
    await settle();
    expect(pick()).not.toBe(first);
    expect(pick()?.status).toBe('paused');

    // Built afresh each time, a selection holds still only through its equality check.
    const ids = store.gardenSlice(
      (state) => state.bootstrap?.tasks.map((task) => task.id) ?? [],
      (a, b) => a.join() === b.join()
    );
    const listed = ids();
    streams[0]!.send('task', { task: conversation('a', { status: 'running' }), moves: false });
    await settle();
    expect(ids()).toBe(listed);
  });
});
