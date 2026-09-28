import { VOICE_SAMPLE_RATE, VOICE_MAX_SESSION_SECONDS } from './audio-constants';
import type {
  VoiceConnection,
  VoiceServerEvent,
  VoiceSession,
  VoiceStartRequest,
  VoiceWorkProposal
} from '@garden/contracts';
import { ApiError, post } from '../client';
import { createVoiceAudio } from './voice-audio';

export interface VoiceCallbacks {
  onSession: (session: VoiceSession) => void;
  onStatus: (status: 'starting' | 'connecting' | 'reconnecting' | 'active' | 'stopped') => void;
  onMuted: (muted: boolean) => void;
  onLevel: (level: number) => void;
  onTranscript: (epoch: number, text: string, final: boolean) => void;
  onProposal: (proposal: VoiceWorkProposal) => void;
  onError: (error: unknown) => void;
}
export interface VoiceDependencies {
  audio: typeof createVoiceAudio;
  start: (taskId: string, request: VoiceStartRequest, key: string) => Promise<VoiceConnection>;
  reconnect: (taskId: string, sessionId: string, recoveryKey: string) => Promise<VoiceConnection>;
  stop: (taskId: string, sessionId: string) => Promise<VoiceSession>;
  socket: (path: string) => WebSocket;
}
const defaults: VoiceDependencies = {
  audio: createVoiceAudio,
  start: (taskId, request, key) =>
    post(`/v1/tasks/${taskId}/voice-sessions`, request, { idempotencyKey: key, retry: 1 }),
  reconnect: (taskId, sessionId, recoveryKey) =>
    post(
      `/v1/tasks/${taskId}/voice-sessions/${sessionId}/reconnect`,
      { recoveryKey },
      { retry: 0 }
    ),
  stop: (taskId, sessionId) =>
    post(`/v1/tasks/${taskId}/voice-sessions/${sessionId}/stop`, {}, { retry: 1, keepalive: true }),
  socket: (path) =>
    new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`)
};
const uint = (value: number, positive = false) =>
  Number.isInteger(value) && value >= (positive ? 1 : 0) && value <= 0xffffffff;

export function createVoiceSessionController(
  taskId: string,
  callbacks: VoiceCallbacks,
  dependencies: VoiceDependencies = defaults
) {
  let begun = false;
  let stopped = false;
  let connected = false;
  let acknowledged = false;
  let recovering = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryDeadline: ReturnType<typeof setTimeout> | undefined;
  let recoveryAttempt = 0;
  let recoveryKey = '';
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastPong = 0;
  let session: VoiceSession | null = null;
  let audio: ReturnType<typeof createVoiceAudio> | undefined;
  let socket: WebSocket | undefined;
  let inputEpoch = 0;
  let outputEpoch = 0;
  let flushedEpoch = 0;
  let muted = false;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopRequest: Promise<void> | undefined;
  let cancelSetup: () => void = () => undefined;
  const cancelled = new Promise<null>((resolve) => {
    cancelSetup = () => resolve(null);
  });
  const send = (value: object) => {
    if (socket?.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(value));
    } catch (cause) {
      fail(cause);
    }
  };
  const stop = () => {
    if (!stopped) {
      stopped = true;
      connected = false;
      clearTimeout(handshake);
      clearTimeout(deadline);
      clearTimeout(recoveryTimer);
      clearTimeout(recoveryDeadline);
      clearInterval(heartbeat);
      cancelSetup();
      try {
        audio?.stop();
      } catch {
        // Server cleanup must still run when a browser audio resource has already gone away.
      }
      send({ type: 'stop' });
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close(1000, 'Owner ended voice');
        } catch {
          // The independent stop request settles the server side of a failed socket close.
        }
      }
      callbacks.onStatus('stopped');
    }
    if (session && !stopRequest) {
      const id = session.id;
      stopRequest = Promise.resolve()
        .then(() => dependencies.stop(taskId, id))
        .then(acceptSession)
        .catch((cause: unknown) =>
          callbacks.onError(
            new Error(
              'Audio has stopped. The server could not confirm final cleanup; its session deadline still applies.',
              { cause }
            )
          )
        );
    }
    return stopRequest ?? Promise.resolve();
  };
  const fail = (cause: unknown) => {
    if (stopped) return;
    callbacks.onError(cause);
    void stop();
  };
  const acceptSession = (next: VoiceSession) => {
    if (
      !session ||
      next.id !== session.id ||
      next.taskId !== taskId ||
      next.workspaceId !== session.workspaceId
    )
      throw new Error('The voice response belongs to another session.');
    session = next;
    callbacks.onSession(next);
  };
  const receive = (event: VoiceServerEvent) => {
    switch (event.type) {
      case 'pong':
        if (!connected) throw new Error('Voice heartbeat arrived before readiness');
        lastPong = Date.now();
        return;
      case 'ready':
        if (
          connected ||
          event.sampleRate !== VOICE_SAMPLE_RATE ||
          !uint(event.inputEpoch, true) ||
          !['listening', 'responding'].includes(event.session.status)
        )
          throw new Error('Invalid voice readiness response.');
        acceptSession(event.session);
        connected = true;
        acknowledged = true;
        recovering = false;
        recoveryAttempt = 0;
        clearTimeout(recoveryTimer);
        clearTimeout(recoveryDeadline);
        clearTimeout(handshake);
        inputEpoch = event.inputEpoch;
        audio?.setInput(inputEpoch, false);
        send({ type: muted ? 'mute' : 'unmute' });
        lastPong = Date.now();
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          if (!connected || stopped) return;
          if (Date.now() - lastPong >= 15_000) reconnect();
          else send({ type: 'ping' });
        }, 5_000);
        callbacks.onStatus('active');
        return;
      case 'input':
        if (
          !connected ||
          !uint(event.inputEpoch, true) ||
          event.inputEpoch < inputEpoch ||
          typeof event.muted !== 'boolean'
        )
          throw new Error('Invalid voice microphone state.');
        inputEpoch = event.inputEpoch;
        audio?.setInput(inputEpoch, !muted && !event.muted);
        callbacks.onMuted(muted || event.muted);
        return;
      case 'session':
        acceptSession(event.session);
        if (
          ['stopping', 'ended', 'expired', 'lost', 'usage_uncertain'].includes(event.session.status)
        )
          void stop();
        return;
      case 'audio_start':
        if (
          !connected ||
          !uint(event.epoch, true) ||
          event.epoch <= outputEpoch ||
          event.sampleRate !== VOICE_SAMPLE_RATE
        )
          throw new Error('Invalid voice playback epoch.');
        outputEpoch = event.epoch;
        audio?.startOutput(event.epoch);
        return;
      case 'audio_done':
        if (!uint(event.epoch, true) || !uint(event.totalSamples))
          throw new Error('Invalid voice playback length.');
        if (event.epoch !== outputEpoch || event.epoch <= flushedEpoch) return;
        audio?.done(event.epoch, event.totalSamples);
        return;
      case 'flush': {
        if (!uint(event.epoch, true)) throw new Error('Invalid voice interruption epoch.');
        if (event.epoch !== outputEpoch || event.epoch <= flushedEpoch) return;
        flushedEpoch = event.epoch;
        const heard = audio?.flush(event.epoch) ?? 0;
        send({ type: 'playback', epoch: event.epoch, playedSamples: heard });
        return;
      }
      case 'transcript':
        if (
          !uint(event.epoch, true) ||
          typeof event.text !== 'string' ||
          event.text.length > 16000 ||
          typeof event.final !== 'boolean'
        )
          throw new Error('Invalid voice transcript.');
        if (!connected || event.epoch !== outputEpoch || event.epoch <= flushedEpoch) return;
        callbacks.onTranscript(event.epoch, event.text, event.final);
        return;
      case 'proposal':
        if (
          !event.proposal ||
          event.proposal.sessionId !== session?.id ||
          event.proposal.taskId !== taskId ||
          typeof event.proposal.prompt !== 'string' ||
          event.proposal.prompt.length > 12000
        )
          throw new Error('Invalid voice work proposal.');
        callbacks.onProposal(event.proposal);
        return;
      case 'error':
        throw new Error(
          typeof event.message === 'string'
            ? event.message.slice(0, 2000)
            : 'The voice service could not continue.'
        );
      default:
        throw new Error('The server sent an unsupported voice event.');
    }
  };
  const discardTransport = () => {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* Reconnection does not reuse the old transport. */
    }
    socket = undefined;
  };
  const reconnect = () => {
    if (stopped) return;
    if (!acknowledged || !session) {
      fail(new Error('Voice disconnected before it became ready. Please start again.'));
      return;
    }
    if (!recovering) {
      recovering = true;
      recoveryAttempt = 0;
      recoveryDeadline = setTimeout(
        () =>
          fail(
            new Error('Voice could not reconnect. Audio has stopped; please start a new session.')
          ),
        60_000
      );
    }
    connected = false;
    clearInterval(heartbeat);
    clearTimeout(handshake);
    clearTimeout(recoveryTimer);
    audio?.setInput(inputEpoch, false);
    if (outputEpoch > flushedEpoch) {
      flushedEpoch = outputEpoch;
      audio?.flush(outputEpoch);
    }
    callbacks.onLevel(0);
    callbacks.onStatus('reconnecting');
    discardTransport();
    recoveryTimer = setTimeout(
      () => {
        if (stopped || !session) return;
        void Promise.race([dependencies.reconnect(taskId, session.id, recoveryKey), cancelled])
          .then((value) => {
            if (stopped || !value) return;
            if (
              value.session.id !== session?.id ||
              value.session.taskId !== taskId ||
              value.session.workspaceId !== session.workspaceId ||
              !['preparing', 'listening', 'responding'].includes(value.session.status)
            )
              throw new Error('This voice session can no longer reconnect.');
            openTransport(value);
          })
          .catch((cause: unknown) => {
            if (stopped) return;
            if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status))
              fail(cause);
            else reconnect();
          });
      },
      Math.min(500 * 2 ** recoveryAttempt++, 3_000)
    );
  };
  const openTransport = (connection: VoiceConnection) => {
    const path = `/v1/voice-sessions/${session!.id}/socket`;
    if (
      connection.socketPath !== path ||
      !Number.isFinite(Date.parse(connection.ticketExpiresAt)) ||
      Date.parse(connection.ticketExpiresAt) <= Date.now()
    )
      throw new Error('The voice connection is no longer available.');
    const transport = dependencies.socket(path);
    socket = transport;
    transport.binaryType = 'arraybuffer';
    transport.onopen = () => {
      if (!stopped && socket === transport) send({ type: 'ticket', ticket: connection.ticket });
    };
    transport.onmessage = (message) => {
      if (stopped || socket !== transport) return;
      try {
        if (message.data instanceof ArrayBuffer) {
          if (!connected || !outputEpoch)
            throw new Error('Voice audio arrived before its playback header.');
          audio?.enqueue(message.data);
        } else if (typeof message.data === 'string' && message.data.length <= 65536)
          receive(JSON.parse(message.data) as VoiceServerEvent);
        else throw new Error('Invalid voice message.');
      } catch (cause) {
        fail(cause);
      }
    };
    transport.onerror = () => {
      if (socket === transport) reconnect();
    };
    transport.onclose = (event) => {
      if (stopped || socket !== transport) return;
      if (event.code === 1000 || event.code === 1008)
        fail(new Error('Live voice ended. Audio has stopped.'));
      else reconnect();
    };
    handshake = setTimeout(() => {
      if (socket === transport) reconnect();
    }, 15_000);
  };
  return {
    async start(request: VoiceStartRequest) {
      if (begun || stopped) return;
      begun = true;
      callbacks.onStatus('starting');
      try {
        let admitCapture: () => void = () => undefined;
        const captureAfter = new Promise<void>((resolve) => {
          admitCapture = resolve;
        });
        audio = dependencies.audio(
          {
            onCapture: (frame) => {
              if (!connected || muted || stopped) return;
              if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 96000)
                throw new Error(
                  'The connection cannot keep up with microphone audio. Voice has stopped.'
                );
              socket.send(frame);
            },
            onPlayed: (epoch, samples) => {
              if (!stopped && epoch === outputEpoch && epoch > flushedEpoch)
                send({ type: 'playback', epoch, playedSamples: samples });
            },
            onLevel: callbacks.onLevel,
            onError: fail
          },
          undefined,
          captureAfter
        );
        // AudioContext resume belongs to the owner gesture; microphone access waits for admission.
        void audio.ready.catch(fail);
        if (stopped) return;
        handshake = setTimeout(
          () =>
            fail(
              new Error(
                'Voice setup could not be confirmed. Audio has stopped; any server reservation remains bounded by its deadline.'
              )
            ),
          30000
        );
        const pending = dependencies
          .start(taskId, request, crypto.randomUUID())
          .then(async (value) => {
            const next = value.session;
            if (next.taskId !== taskId || !/^[0-9a-f-]{36}$/i.test(next.id))
              throw new Error('Invalid voice session ownership.');
            session = next;
            if (stopped) {
              await stop();
              return null;
            }
            return value;
          });
        const connection = await Promise.race([pending, cancelled]);
        if (!connection || stopped) return;
        clearTimeout(handshake);
        session = connection.session;
        recoveryKey = connection.recoveryKey;
        if (typeof recoveryKey !== 'string' || recoveryKey.length < 20 || recoveryKey.length > 128)
          throw new Error('Invalid voice recovery key.');
        callbacks.onSession(session);
        const path = `/v1/voice-sessions/${session.id}/socket`;
        if (connection.socketPath !== path)
          throw new Error('The voice connection must stay on this garden server.');
        const remaining = Date.parse(session.deadlineAt) - Date.now();
        if (
          !Number.isFinite(remaining) ||
          remaining <= 0 ||
          remaining > VOICE_MAX_SESSION_SECONDS * 1000 + 5000
        )
          throw new Error('Invalid voice session deadline.');
        const ticketExpiresAt = Date.parse(connection.ticketExpiresAt);
        if (
          session.status !== 'preparing' ||
          !Number.isFinite(ticketExpiresAt) ||
          ticketExpiresAt <= Date.now()
        )
          throw new Error('This voice connection is no longer available. Start a new session.');
        deadline = setTimeout(() => void stop(), remaining);
        admitCapture();
        const ready = await Promise.race([audio.ready.then(() => true), cancelled]);
        if (!ready || stopped) return;
        if (ticketExpiresAt <= Date.now())
          throw new Error('The voice ticket expired during microphone setup. Start a new session.');
        callbacks.onStatus('connecting');
        openTransport(connection);
      } catch (cause) {
        fail(cause);
      }
    },
    stop,
    setMuted(value: boolean) {
      if (stopped) return;
      muted = value;
      if (value) audio?.setInput(inputEpoch, false);
      send({ type: value ? 'mute' : 'unmute' });
      callbacks.onMuted(value);
    },
    interrupt() {
      if (stopped || !outputEpoch || outputEpoch <= flushedEpoch) return;
      flushedEpoch = outputEpoch;
      const heard = audio?.flush(outputEpoch) ?? 0;
      send({ type: 'interrupt', epoch: outputEpoch, playedSamples: heard });
    }
  };
}
