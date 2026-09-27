import { afterEach, expect, it, vi } from 'vitest';
import type { VoiceConnection, VoiceSession, VoiceStartRequest } from '@athanor/contracts';
import {
  createVoiceSessionController,
  type VoiceCallbacks,
  type VoiceDependencies
} from './voice-session';
import type { VoiceAudioCallbacks, VoiceAudioDependencies } from './voice-audio';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const taskId = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const request: VoiceStartRequest = {
  modelId: 'voice',
  voice: 'marin',
  reasoningEffort: 'low',
  privacyRoute: 'provider_zdr',
  maxSpendUsd: 1,
  lifetimeSeconds: 600,
  expectedRouteProof: 'proof'
};
function session(status: VoiceSession['status'] = 'connecting'): VoiceSession {
  return {
    id,
    taskId,
    workspaceId: '00000000-0000-4000-8000-000000000003',
    provider: 'openai',
    providerModelId: 'voice',
    privacyRoute: 'provider_zdr',
    retention: 'zdr',
    voice: 'marin',
    reasoningEffort: 'low',
    status,
    createdAt: new Date().toISOString(),
    connectedAt: null,
    deadlineAt: new Date(Date.now() + 600000).toISOString(),
    endedAt: null,
    maxSpendUsd: 1,
    settledUsd: 0,
    pendingUsd: 1,
    inputSeconds: 0,
    outputSeconds: 0,
    currentResponseId: null,
    cleanupPending: false,
    errorCode: null,
    note: null
  };
}
function connection(): VoiceConnection {
  return {
    session: session('preparing'),
    ticket: 'one-use-ticket-that-must-not-reconnect',
    recoveryKey: 'browser-only-separate-recovery-key',
    socketPath: `/v1/voice-sessions/${id}/socket`,
    ticketExpiresAt: new Date(Date.now() + 60000).toISOString()
  };
}
class Socket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn<(data: string | ArrayBuffer) => void>();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  event(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});
function fixture(options: { ready?: Promise<void>; start?: Promise<VoiceConnection> } = {}) {
  const callbacks: VoiceCallbacks = {
    onSession: vi.fn(),
    onStatus: vi.fn(),
    onMuted: vi.fn(),
    onLevel: vi.fn(),
    onTranscript: vi.fn(),
    onProposal: vi.fn(),
    onError: vi.fn()
  };
  let audioCallbacks!: VoiceAudioCallbacks;
  const audio = {
    ready: options.ready ?? Promise.resolve(),
    stop: vi.fn(),
    setInput: vi.fn(),
    startOutput: vi.fn(),
    enqueue: vi.fn(),
    done: vi.fn(),
    flush: vi.fn(() => 480)
  };
  const socket = new Socket();
  const captureAuthorized = vi.fn();
  const dependencies: VoiceDependencies = {
    audio: vi.fn(
      (value: VoiceAudioCallbacks, _audio?: VoiceAudioDependencies, admission?: Promise<void>) => {
        audioCallbacks = value;
        if (admission) void admission.then(captureAuthorized);
        return audio;
      }
    ),
    start: vi.fn(() => options.start ?? Promise.resolve(connection())),
    reconnect: vi.fn(async () => ({
      ...connection(),
      session: session('listening'),
      ticket: 'fresh-reconnect-ticket-for-this-session'
    })),
    stop: vi.fn(async () => session('ended')),
    socket: vi.fn(() => socket as unknown as WebSocket)
  };
  const controller = createVoiceSessionController(taskId, callbacks, dependencies);
  cleanups.push(() => controller.stop());
  return {
    callbacks,
    dependencies,
    controller,
    audio,
    socket,
    captureAuthorized,
    captures: () => audioCallbacks,
    ready: () => {
      socket.event({
        type: 'ready',
        session: session('listening'),
        inputEpoch: 1,
        sampleRate: 24000
      });
      socket.event({ type: 'input', inputEpoch: 1, muted: false });
    }
  };
}

it('admits the exact session before microphone acquisition and stops unclaimed admission on cancellation', async () => {
  const ready = deferred<void>();
  const start = deferred<VoiceConnection>();
  const f = fixture({ ready: ready.promise, start: start.promise });
  const starting = f.controller.start(request);
  expect(f.dependencies.audio).toHaveBeenCalledOnce();
  expect(f.dependencies.start).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(f.captureAuthorized).not.toHaveBeenCalled();
  start.resolve(connection());
  await vi.waitFor(() => expect(f.captureAuthorized).toHaveBeenCalledOnce());
  expect(f.dependencies.socket).not.toHaveBeenCalled();
  await f.controller.stop();
  await starting;
  ready.resolve();
  expect(f.audio.stop).toHaveBeenCalledOnce();
  expect(f.dependencies.stop).toHaveBeenCalledExactlyOnceWith(taskId, id);
  expect(f.dependencies.socket).not.toHaveBeenCalled();
  expect(f.callbacks.onError).not.toHaveBeenCalled();
});

it('rejects unaffordable admission without authorizing microphone capture or claiming a ticket', async () => {
  const start = deferred<VoiceConnection>();
  const f = fixture({ start: start.promise });
  const starting = f.controller.start(request);
  const failure = Error('Voice needs $1.284 held capacity; task remaining is $0.20.');
  start.reject(failure);
  await starting;
  expect(f.captureAuthorized).not.toHaveBeenCalled();
  expect(f.dependencies.socket).not.toHaveBeenCalled();
  expect(f.dependencies.stop).not.toHaveBeenCalled();
  expect(f.audio.stop).toHaveBeenCalledOnce();
  expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(failure);
});

it('stops a late start response exactly once after owner cancellation without claiming its ticket', async () => {
  const start = deferred<VoiceConnection>();
  const f = fixture({ start: start.promise });
  const starting = f.controller.start(request);
  await vi.waitFor(() => expect(f.dependencies.start).toHaveBeenCalledOnce());
  await f.controller.stop();
  start.resolve(connection());
  await starting;
  await vi.waitFor(() => expect(f.dependencies.stop).toHaveBeenCalledExactlyOnceWith(taskId, id));
  expect(f.dependencies.socket).not.toHaveBeenCalled();
  expect(f.captureAuthorized).not.toHaveBeenCalled();
  expect(f.callbacks.onSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: 'ended' })
  );
});

it('keeps microphone transmission off until acknowledged readiness and uses only the same-origin one-use ticket', async () => {
  const f = fixture();
  await f.controller.start(request);
  expect(f.dependencies.socket).toHaveBeenCalledExactlyOnceWith(`/v1/voice-sessions/${id}/socket`);
  const frame = new ArrayBuffer(12);
  f.captures().onCapture(frame);
  expect(f.socket.send).not.toHaveBeenCalled();
  f.socket.open();
  expect(typeof f.socket.send.mock.calls[0]![0]).toBe('string');
  expect(JSON.parse(f.socket.send.mock.calls[0]![0] as string)).toEqual({
    type: 'ticket',
    ticket: connection().ticket
  });
  f.ready();
  expect(f.audio.setInput).toHaveBeenLastCalledWith(1, true);
  f.captures().onCapture(frame);
  expect(f.socket.send).toHaveBeenLastCalledWith(frame);
  f.controller.setMuted(true);
  f.captures().onCapture(frame);
  expect(f.audio.setInput).toHaveBeenLastCalledWith(1, false);
  expect(f.socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'mute' }));
  f.controller.setMuted(false);
  expect(f.audio.setInput).toHaveBeenLastCalledWith(1, false);
  f.socket.event({ type: 'input', inputEpoch: 2, muted: false });
  expect(f.audio.setInput).toHaveBeenLastCalledWith(2, true);
});

it('drops cumulative transcripts and playback acknowledgements from flushed or stale epochs', async () => {
  const f = fixture();
  await f.controller.start(request);
  f.socket.open();
  f.ready();
  const output = (epoch: number) =>
    f.socket.event({
      type: 'audio_start',
      epoch,
      sampleRate: 24000,
      itemId: 'item',
      responseId: 'response'
    });
  const text = (epoch: number, value: string) =>
    f.socket.event({ type: 'transcript', epoch, text: value, final: false });
  text(1, 'before audio');
  output(1);
  text(1, 'current');
  expect(f.callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(1, 'current', false);
  f.controller.interrupt();
  expect(f.audio.flush).toHaveBeenCalledExactlyOnceWith(1);
  text(1, 'late interrupted speech');
  f.captures().onPlayed(1, 960);
  f.socket.event({ type: 'audio_done', epoch: 1, totalSamples: 2400 });
  f.socket.event({ type: 'flush', epoch: 1, reason: 'owner' });
  expect(f.audio.done).not.toHaveBeenCalled();
  expect(f.socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: 'interrupt', epoch: 1, playedSamples: 480 })
  );
  output(2);
  text(1, 'stale final');
  text(2, 'next');
  expect(f.callbacks.onTranscript).toHaveBeenCalledTimes(2);
  expect(f.callbacks.onTranscript).toHaveBeenLastCalledWith(2, 'next', false);
  f.socket.event({ type: 'flush', epoch: 2, reason: 'speech_started' });
  text(2, 'late speech');
  expect(f.callbacks.onTranscript).toHaveBeenCalledTimes(2);
  expect(f.socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: 'playback', epoch: 2, playedSamples: 480 })
  );
});

it('closes both sides after failed socket stop/close and refuses a foreign cleanup response', async () => {
  const f = fixture();
  await f.controller.start(request);
  f.socket.open();
  f.ready();
  f.socket.send.mockImplementation(() => {
    throw Error('socket gone');
  });
  f.socket.close.mockImplementation(() => {
    throw Error('close failed');
  });
  vi.mocked(f.dependencies.stop).mockResolvedValue({ ...session('ended'), taskId: 'other' });
  await f.controller.stop();
  expect(f.audio.stop).toHaveBeenCalledOnce();
  expect(f.dependencies.stop).toHaveBeenCalledExactlyOnceWith(taskId, id);
  expect(f.socket.onopen).toBeNull();
  expect(f.socket.onmessage).toBeNull();
  expect(f.callbacks.onSession).not.toHaveBeenCalledWith(
    expect.objectContaining({ taskId: 'other' })
  );
  expect(f.callbacks.onError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining('could not confirm final cleanup') as unknown
    })
  );
});

it('stops on suspended readiness, terminal server state or handshake timeout without reconnecting', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.controller.start(request);
  f.socket.open();
  await vi.advanceTimersByTimeAsync(15001);
  expect(f.audio.stop).toHaveBeenCalledOnce();
  expect(f.dependencies.stop).toHaveBeenCalledOnce();
  expect(f.dependencies.socket).toHaveBeenCalledOnce();
  await f.controller.start(request);
  expect(f.dependencies.start).toHaveBeenCalledOnce();
  const terminal = fixture();
  await terminal.controller.start(request);
  terminal.socket.open();
  terminal.socket.event({
    type: 'ready',
    inputEpoch: 1,
    sampleRate: 24000,
    session: session('ended')
  });
  expect(terminal.audio.setInput).not.toHaveBeenCalled();
  expect(terminal.audio.stop).toHaveBeenCalledOnce();
  const stopping = fixture();
  await stopping.controller.start(request);
  stopping.socket.open();
  stopping.ready();
  stopping.socket.event({ type: 'session', session: session('stopping') });
  expect(stopping.audio.stop).toHaveBeenCalledOnce();
});

it('never connects to an advertised external socket or stops a session from another task', async () => {
  const f = fixture({
    start: Promise.resolve({ ...connection(), socketPath: 'wss://elsewhere.invalid/' })
  });
  await f.controller.start(request);
  await f.controller.stop();
  expect(f.dependencies.socket).not.toHaveBeenCalled();
  expect(f.dependencies.stop).toHaveBeenCalledOnce();
  const wrong = fixture({
    start: Promise.resolve({ ...connection(), session: { ...session(), taskId: 'other' } })
  });
  await wrong.controller.start(request);
  await wrong.controller.stop();
  expect(wrong.dependencies.stop).not.toHaveBeenCalled();
  expect(wrong.dependencies.socket).not.toHaveBeenCalled();
});

it('bounds ambiguous provider preparation and stops its late receipt without claiming a ticket', async () => {
  vi.useFakeTimers();
  const start = deferred<VoiceConnection>();
  const f = fixture({ start: start.promise });
  const starting = f.controller.start(request);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(30001);
  await starting;
  expect(f.audio.stop).toHaveBeenCalledOnce();
  expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      message: expect.stringContaining('could not be confirmed') as unknown
    })
  );
  expect(f.dependencies.socket).not.toHaveBeenCalled();
  start.resolve(connection());
  await vi.waitFor(() => expect(f.dependencies.stop).toHaveBeenCalledExactlyOnceWith(taskId, id));
  expect(f.dependencies.start).toHaveBeenCalledOnce();
  expect(f.dependencies.socket).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('settles start cancellation without waiting for a server response and never retries a failed cleanup as a fresh session', async () => {
  const start = deferred<VoiceConnection>();
  const f = fixture({ start: start.promise });
  const starting = f.controller.start(request);
  await vi.waitFor(() => expect(f.dependencies.start).toHaveBeenCalledOnce());
  await f.controller.stop();
  await starting;
  expect(f.dependencies.stop).not.toHaveBeenCalled();
  vi.mocked(f.dependencies.stop).mockRejectedValue(Error('network disappeared'));
  start.resolve(connection());
  await vi.waitFor(() => expect(f.callbacks.onError).toHaveBeenCalledOnce());
  expect(f.dependencies.stop).toHaveBeenCalledOnce();
  expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      message: expect.stringContaining('could not confirm final cleanup') as unknown
    })
  );
  await f.controller.start(request);
  expect(f.dependencies.start).toHaveBeenCalledOnce();
});

it.each(['connecting', 'ended', 'usage_uncertain'] as const)(
  'refuses microphone access when a replayed admission is already %s',
  async (status) => {
    const f = fixture({ start: Promise.resolve({ ...connection(), session: session(status) }) });
    await f.controller.start(request);
    await f.controller.stop();
    expect(f.captureAuthorized).not.toHaveBeenCalled();
    expect(f.dependencies.socket).not.toHaveBeenCalled();
    expect(f.dependencies.stop).toHaveBeenCalledExactlyOnceWith(taskId, id);
    expect(f.audio.stop).toHaveBeenCalledOnce();
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining('no longer available') as unknown
      })
    );
  }
);

it.each(['expired', 'invalid'] as const)(
  'refuses microphone access when the one-use ticket expiry is %s',
  async (expiry) => {
    const f = fixture({
      start: Promise.resolve({
        ...connection(),
        ticketExpiresAt: expiry === 'expired' ? new Date(Date.now() - 1).toISOString() : 'invalid'
      })
    });
    await f.controller.start(request);
    await f.controller.stop();
    expect(f.captureAuthorized).not.toHaveBeenCalled();
    expect(f.dependencies.socket).not.toHaveBeenCalled();
    expect(f.dependencies.stop).toHaveBeenCalledExactlyOnceWith(taskId, id);
    expect(f.audio.stop).toHaveBeenCalledOnce();
  }
);

it('does not claim a ticket that expires while microphone permission is pending', async () => {
  vi.useFakeTimers();
  const ready = deferred<void>();
  const f = fixture({
    ready: ready.promise,
    start: Promise.resolve({
      ...connection(),
      ticketExpiresAt: new Date(Date.now() + 1000).toISOString()
    })
  });
  const starting = f.controller.start(request);
  await vi.waitFor(() => expect(f.captureAuthorized).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(1001);
  ready.resolve();
  await starting;
  await f.controller.stop();
  expect(f.dependencies.socket).not.toHaveBeenCalled();
  expect(f.dependencies.stop).toHaveBeenCalledExactlyOnceWith(taskId, id);
  expect(f.audio.stop).toHaveBeenCalledOnce();
  expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: expect.stringContaining('ticket expired') as unknown })
  );
});

it('reconnects an acknowledged session with a fresh ticket and drops stale capture and playback', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.controller.start(request);
  f.socket.open();
  f.ready();
  f.socket.event({
    type: 'audio_start',
    epoch: 1,
    itemId: 'item',
    responseId: 'response',
    sampleRate: 24000
  });
  const oldHandler = f.socket.onmessage!;
  const next = new Socket();
  vi.mocked(f.dependencies.socket).mockReturnValue(next as unknown as WebSocket);
  f.socket.readyState = 3;
  f.socket.onclose?.({ code: 1006 });
  expect(f.audio.setInput).toHaveBeenLastCalledWith(1, false);
  expect(f.audio.flush).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.callbacks.onStatus).toHaveBeenLastCalledWith('reconnecting');
  const capturesBefore = f.socket.send.mock.calls.length;
  f.captures().onCapture(new ArrayBuffer(12));
  expect(f.socket.send.mock.calls).toHaveLength(capturesBefore);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.dependencies.reconnect).toHaveBeenCalledExactlyOnceWith(
    taskId,
    id,
    connection().recoveryKey
  );
  next.open();
  expect(JSON.parse(next.send.mock.calls[0]![0] as string)).toMatchObject({
    ticket: 'fresh-reconnect-ticket-for-this-session'
  });
  next.event({ type: 'ready', session: session('listening'), inputEpoch: 3, sampleRate: 24000 });
  expect(f.audio.setInput).toHaveBeenLastCalledWith(3, false);
  next.event({ type: 'input', inputEpoch: 4, muted: false });
  expect(f.audio.setInput).toHaveBeenLastCalledWith(4, true);
  oldHandler({ data: JSON.stringify({ type: 'error', message: 'stale socket' }) });
  expect(f.callbacks.onError).not.toHaveBeenCalled();
  expect(f.dependencies.start).toHaveBeenCalledOnce();
  expect(f.dependencies.stop).not.toHaveBeenCalled();
});

it('retains mute during recovery and cancels a late reconnect after Stop', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.controller.start(request);
  f.socket.open();
  f.ready();
  f.controller.setMuted(true);
  const pending = deferred<VoiceConnection>();
  vi.mocked(f.dependencies.reconnect).mockReturnValue(pending.promise);
  f.socket.readyState = 3;
  f.socket.onclose?.({ code: 1006 });
  await vi.advanceTimersByTimeAsync(500);
  await f.controller.stop();
  pending.resolve({ ...connection(), session: session('listening') });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.dependencies.socket).toHaveBeenCalledOnce();
  expect(f.dependencies.stop).toHaveBeenCalledOnce();
  expect(f.dependencies.start).toHaveBeenCalledOnce();
});

it('ends recovery at its deadline without starting another provider session', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.controller.start(request);
  f.socket.open();
  f.ready();
  vi.mocked(f.dependencies.reconnect).mockRejectedValue(new Error('offline'));
  f.socket.readyState = 3;
  f.socket.onclose?.({ code: 1006 });
  await vi.advanceTimersByTimeAsync(60_001);
  expect(f.dependencies.reconnect).toHaveBeenCalled();
  expect(f.dependencies.start).toHaveBeenCalledOnce();
  expect(f.dependencies.stop).toHaveBeenCalledOnce();
  expect(f.callbacks.onStatus).toHaveBeenLastCalledWith('stopped');
  expect(f.callbacks.onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('could not reconnect') as unknown })
  );
});

it('detects a silent broken connection and does not replay input while waiting for its new epoch', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.controller.start(request);
  f.socket.open();
  f.ready();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ping' }));
  f.socket.event({ type: 'pong' });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(f.callbacks.onStatus).toHaveBeenLastCalledWith('active');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.callbacks.onStatus).toHaveBeenLastCalledWith('reconnecting');
  expect(f.audio.setInput).toHaveBeenLastCalledWith(1, false);
  expect(f.dependencies.start).toHaveBeenCalledOnce();
});
