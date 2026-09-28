import { createHash } from 'node:crypto';
import {
  connect as connectHttp2,
  type ClientHttp2Session,
  type ClientHttp2Stream
} from 'node:http2';
import { createConnection, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import {
  CONTROL_ALPN,
  MAX_BIND_FRAME_BYTES,
  NdjsonReader,
  PARK_READY_MARKER,
  PATH_CONTROL,
  PATH_ENROLL,
  PATH_PARK,
  PROTOCOL_VERSION,
  PREVIEW_HTTPS_CAPABILITY,
  decodeCbor,
  type BindFrame,
  type RelayToBoxMessage,
  type WelcomeMessage
} from '@garden/relay';
import { reconnectDelayMs } from './backoff.js';
import { localPortForBind, relayIsUsable, type RelayClientConfig } from './config.js';
import type { RelayIdentity } from './identity.js';

export type RelayState = 'off' | 'connecting' | 'online' | 'waiting' | 'revoked';

export interface RelayStatus {
  readonly state: RelayState;
  readonly label: string | null;
  /** Hostname clients should use, once the relay has confirmed the label. */
  readonly hostname: string | null;
  readonly previewPort?: number | null;
  readonly openStreams: number;
  readonly usedBytes: number;
  readonly quota: 'ok' | 'warn' | 'shaped' | 'blocked' | null;
  readonly lastError: string | null;
  readonly nextAttemptAtMs: number | null;
}

export type RelayLogger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>
) => void;

export interface RelayConnectionOptions {
  readonly config: RelayClientConfig;
  readonly identity: RelayIdentity;
  readonly logger?: RelayLogger;
  readonly onStatus?: (status: RelayStatus) => void;
  /** Opens one of the box's own listeners. Injected in tests; otherwise a plain TCP connection. */
  readonly connectLocal?: (port: number) => Socket;
  readonly random?: () => number;
}

const spkiSha256 = (der: Buffer): string => createHash('sha256').update(der).digest('base64');

/** Said in one place because the dial gate and the pre-dial gate have to say the same thing. */
const UNPINNED_REASON =
  'this box has no pinned key for its relay; enroll again to record one, or switch the relay off';

/**
 * Dials a relay and answers for this box.
 *
 * The relay is a byte mover: TLS terminates here, on the box, so what a parked stream carries is a
 * client's own ClientHello and nothing in the middle can read it. That is the whole reason the
 * protocol parks idle streams rather than opening one per request - the box has to be able to
 * answer a new client with no round trip to set anything up.
 */
export class RelayConnection {
  readonly #options: RelayConnectionOptions;
  readonly #log: RelayLogger;
  #socket: TLSSocket | undefined;
  #session: ClientHttp2Session | undefined;
  #stopped = true;
  #attempt = 0;
  /**
   * Increments on every dial. Tearing a connection down makes its own socket and session emit
   * `error` and `close`, and those handlers call `#retry` - so without a generation to compare
   * against, one lost connection schedules a reconnect, whose teardown schedules another, and the
   * box dials in a tight loop instead of backing off.
   */
  #generation = 0;
  #parkTarget = 0;
  #parked = 0;
  #open = 0;
  #timer: NodeJS.Timeout | undefined;
  #status: RelayStatus;

  constructor(options: RelayConnectionOptions) {
    this.#options = options;
    this.#log = options.logger ?? (() => undefined);
    this.#status = {
      state: 'off',
      label: options.config.label,
      hostname: this.#hostname(options.config.label),
      openStreams: 0,
      previewPort: null,
      usedBytes: 0,
      quota: null,
      lastError: null,
      nextAttemptAtMs: null
    };
  }

  get status(): RelayStatus {
    return this.#status;
  }

  #hostname(label: string | null): string | null {
    const host = this.#options.config.host;
    return label && host ? `${label}.${host}` : null;
  }

  #publish(patch: Partial<RelayStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#options.onStatus?.(this.#status);
  }

  start(): void {
    if (!relayIsUsable(this.#options.config)) {
      // An enrollment with everything but the pin is the one half-configured state that looks
      // complete from the outside - the box has an address it could print - so it says why rather
      // than going quiet, which an owner reads as "I turned it off".
      const { config } = this.#options;
      const unpinned =
        config.enabled &&
        config.host !== null &&
        config.label !== null &&
        config.pinnedRelaySpkiSha256 === null;
      this.#publish({
        state: 'off',
        nextAttemptAtMs: null,
        lastError: unpinned ? UNPINNED_REASON : this.#status.lastError
      });
      return;
    }
    this.#stopped = false;
    this.#dial();
  }

  stop(): void {
    this.#stopped = true;
    // Retiring the generation first means the teardown below cannot re-enter #retry through its
    // own close events and schedule a reconnect after the caller asked to stop.
    this.#generation += 1;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#teardown();
    this.#publish({ state: 'off', openStreams: 0, nextAttemptAtMs: null });
  }

  #teardown(): void {
    this.#status = { ...this.#status, previewPort: null };
    this.#session?.destroy();
    this.#socket?.destroy();
    this.#session = undefined;
    this.#socket = undefined;
    this.#parked = 0;
    this.#open = 0;
  }

  /**
   * Schedules the next attempt. `requestedMs` carries a GOAWAY's own floor; a revoked box is not
   * rescheduled at all, because retrying a revoked identity is a reconnect loop that can never
   * succeed and looks like an attack from the relay's side.
   */
  #retry(
    reason: string,
    requestedMs?: number,
    revoked = false,
    generation = this.#generation
  ): void {
    if (generation !== this.#generation) return;
    this.#generation += 1;
    this.#teardown();
    if (this.#stopped) return;
    if (revoked) {
      this.#log('error', 'relay revoked this box; not reconnecting', { reason });
      this.#publish({ state: 'revoked', lastError: reason, nextAttemptAtMs: null });
      return;
    }
    const delay = reconnectDelayMs({
      attempt: this.#attempt,
      ...(requestedMs === undefined ? {} : { requestedMs }),
      ...(this.#options.random ? { random: this.#options.random } : {})
    });
    this.#attempt += 1;
    this.#publish({
      state: 'waiting',
      lastError: reason,
      openStreams: 0,
      nextAttemptAtMs: Date.now() + delay
    });
    this.#log('warn', 'relay connection lost, will retry', { reason, delayMs: delay });
    this.#timer = setTimeout(() => this.#dial(), delay);
    this.#timer.unref();
  }

  /**
   * Stops for good without calling it a revocation.
   *
   * `#retry` has two endings and neither fits a box that is misconfigured rather than unwelcome:
   * scheduling an attempt would dial a relay this box has already decided it cannot trust, and
   * `revoked` would tell `garden doctor` to send the owner to the relay operator for a fresh
   * invite when the operator has done nothing wrong.
   */
  #refuse(reason: string, generation: number): void {
    if (generation !== this.#generation) return;
    this.#generation += 1;
    this.#teardown();
    this.#log('error', reason);
    this.#publish({ state: 'off', lastError: reason, openStreams: 0, nextAttemptAtMs: null });
  }

  #dial(): void {
    const { config, identity } = this.#options;
    if (!config.host) return;
    const generation = this.#generation;
    this.#publish({ state: 'connecting' });

    const socket = connectTls({
      host: config.address ?? config.host,
      port: config.port,
      // The relay demultiplexes :443 on SNI, so the name has to be the relay's, even when the
      // connection is opened at a pinned address.
      servername: config.host,
      key: identity.keyPem,
      cert: identity.certPem,
      // There is no CA here by design: the relay is authenticated by the key pinned at enrollment,
      // checked below. Leaving this true would only mean trusting whichever public CA the relay
      // operator happened to use, which is a weaker statement than the pin.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      ALPNProtocols: [CONTROL_ALPN]
    });
    this.#socket = socket;
    socket.setKeepAlive(true, 30_000);
    socket.on('error', (error: Error) => this.#retry(error.message, undefined, false, generation));

    socket.once('secureConnect', () => {
      const presented = socket.getPeerX509Certificate();
      if (!presented) {
        this.#retry('relay presented no certificate', undefined, false, generation);
        return;
      }
      const fingerprint = spkiSha256(
        Buffer.from(presented.publicKey.export({ type: 'spki', format: 'der' }))
      );
      if (!config.pinnedRelaySpkiSha256) {
        // Reached only if something dialled past `relayIsUsable`. Skipping the check when there is
        // no pin - which is what this used to do - turns the strongest gate in the client into a
        // no-op in exactly the state where it is the only thing standing between the box's identity
        // key and whoever currently answers for the hostname. A retry cannot help: nothing changes
        // until the settings do, and every settings change builds a new connection.
        this.#refuse(UNPINNED_REASON, generation);
        return;
      }
      if (config.pinnedRelaySpkiSha256 !== fingerprint) {
        // Refusing here is the point of pinning: whoever now controls the hostname is not who this
        // box enrolled with, and continuing would hand them every client connection.
        this.#retry(
          'relay key does not match the one pinned at enrollment',
          undefined,
          false,
          generation
        );
        return;
      }
      this.#openSession(generation);
    });
  }

  #openSession(generation: number): void {
    const socket = this.#socket;
    const host = this.#options.config.host;
    if (!socket || !host) return;

    const session = connectHttp2(`https://${host}`, {
      createConnection: () => socket,
      // Node defaults to a 10 MB credit-based session limit that starts rejecting new streams once
      // exceeded, which surfaces as unexplained stream failures rather than an error.
      maxSessionMemory: 256,
      peerMaxConcurrentStreams: 128,
      settings: { initialWindowSize: 262_144, maxFrameSize: 65_536, enablePush: false }
    });
    this.#session = session;
    session.setTimeout(0);
    session.on('error', (error: Error) => this.#retry(error.message, undefined, false, generation));
    session.on('close', () => this.#retry('session closed', undefined, false, generation));

    const control = session.request({ ':method': 'POST', ':path': PATH_CONTROL });
    control.setTimeout(0);
    control.write(
      `${JSON.stringify({
        t: 'hello',
        proto: PROTOCOL_VERSION,
        role: 'primary',
        agent: 'garden/1',
        caps: ['http1', 'h2', PREVIEW_HTTPS_CAPABILITY]
      })}\n`
    );

    control.on('response', (headers) => {
      const status = Number(headers[':status'] ?? 0);
      if (status !== 200)
        this.#retry(`control rejected with ${status}`, undefined, status === 403, generation);
    });

    const reader = new NdjsonReader();
    control.on('data', (chunk: Buffer) => {
      try {
        for (const value of reader.push(chunk)) {
          if (value === null || typeof value !== 'object' || Array.isArray(value))
            throw new Error('invalid control frame');
          this.#handle(value as RelayToBoxMessage, generation);
        }
      } catch {
        this.#retry('relay sent an invalid control frame', undefined, false, generation);
      }
    });
    control.on('error', (error: Error) => this.#retry(error.message, undefined, false, generation));
  }

  #handle(message: RelayToBoxMessage, generation: number): void {
    if (generation !== this.#generation) return;
    switch (message.t) {
      case 'welcome': {
        if (
          !Number.isInteger(message.parkTarget) ||
          message.parkTarget < 1 ||
          message.parkTarget > 64 ||
          message.label !== this.#options.config.label
        ) {
          this.#retry('relay sent an invalid welcome', undefined, false, generation);
          return;
        }
        this.#attempt = 0;
        this.#parkTarget = message.parkTarget;
        this.#onWelcome(message);
        this.#replenish();
        return;
      }
      case 'need_park':
        this.#replenish();
        return;
      case 'quota':
        this.#publish({ usedBytes: message.usedBytes, quota: message.state });
        return;
      case 'goaway':
        this.#retry(
          `relay sent goaway (${message.reason})`,
          message.reconnectAfterMs,
          message.reason === 'revoked',
          generation
        );
        return;
    }
  }

  #onWelcome(message: WelcomeMessage): void {
    this.#log('info', 'relay connected', { label: message.label });
    const previewPort =
      Array.isArray(message.caps) &&
      message.caps.includes(PREVIEW_HTTPS_CAPABILITY) &&
      typeof message.previewPort === 'number' &&
      Number.isInteger(message.previewPort) &&
      message.previewPort > 0 &&
      message.previewPort <= 65535
        ? message.previewPort
        : null;
    this.#publish({
      state: 'online',
      label: message.label,
      hostname: this.#hostname(message.label),
      previewPort,
      lastError:
        previewPort !== null
          ? null
          : 'This relay does not serve isolated app previews. Its operator must enable the preview listener before app links can be opened through it.',
      nextAttemptAtMs: null
    });
  }

  #replenish(): void {
    while (!this.#stopped && this.#session && this.#parked < this.#parkTarget) this.#park();
  }

  /**
   * Parks one stream. A parked stream is an already-open HTTP/2 stream the relay can hand a client
   * to with no setup, which is why a first request over the relay is not slower than a direct one.
   */
  #park(): void {
    const session = this.#session;
    if (!session) return;
    const stream = session.request({ ':method': 'POST', ':path': PATH_PARK });
    stream.setTimeout(0);
    this.#parked += 1;
    stream.write(Buffer.from([PARK_READY_MARKER]));

    let buffered = Buffer.alloc(0);
    let bound = false;

    const onData = (chunk: Buffer): void => {
      if (bound) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32BE(0);
      if (length > MAX_BIND_FRAME_BYTES) {
        stream.destroy(new Error('bind frame too large'));
        return;
      }
      if (buffered.length < 4 + length) return;
      bound = true;
      this.#parked -= 1;
      let frame: BindFrame;
      try {
        const decoded = decodeCbor(buffered.subarray(4, 4 + length));
        if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
          throw new Error('bind frame must be an object');
        frame = decoded as unknown as BindFrame;
      } catch {
        stream.close();
        this.#log('warn', 'relay stream refused: invalid bind frame');
        this.#replenish();
        return;
      }
      const rest = buffered.subarray(4 + length);
      stream.removeListener('data', onData);
      stream.pause();
      // Everything after the frame is already the client's own first bytes. Pushing it back keeps
      // the stream an unbroken pipe starting at the ClientHello, which is what lets TLS terminate
      // here rather than anywhere in the middle.
      if (rest.length > 0) stream.unshift(rest);
      this.#forward(frame, stream);
      this.#replenish();
    };

    stream.on('data', onData);
    const release = (): void => {
      if (!bound) {
        bound = true;
        this.#parked -= 1;
      }
    };
    stream.on('error', release);
    stream.on('close', release);
  }

  /** Splices a bound stream onto the box's own listener. */
  #forward(frame: BindFrame, stream: ClientHttp2Stream): void {
    const port = localPortForBind(this.#options.config, frame.port);
    if (port === null) {
      this.#log('warn', 'relay stream refused: unsupported listener', { port: frame.port });
      stream.close();
      return;
    }
    const local =
      this.#options.connectLocal?.(port) ??
      createConnection({ host: this.#options.config.localHost, port });
    this.#open += 1;
    this.#publish({ openStreams: this.#open });

    const done = (): void => {
      if (!stream.destroyed) stream.destroy();
      if (!local.destroyed) local.destroy();
      this.#open = Math.max(0, this.#open - 1);
      this.#publish({ openStreams: this.#open });
    };

    // `frame.ip` looks authoritative and is not: a compromised relay can put anything there, so it
    // is only ever logged, never used to authorize, allowlist or bind a session.
    this.#log('info', 'relay stream bound', { sni: frame.sni, port: frame.port });

    local.on('error', done);
    stream.on('error', done);
    local.on('close', done);
    stream.on('close', done);
    stream.pipe(local);
    local.pipe(stream);
    stream.resume();
  }
}

export interface EnrollmentResult {
  readonly label: string;
  readonly hostname: string;
  readonly pinnedRelaySpkiSha256: string;
}

/**
 * Redeems an enrollment token.
 *
 * This is the only moment the box learns which relay it belongs to, so it is also the moment the
 * relay's key is pinned. Doing both in one step means a later hostname takeover cannot re-enroll
 * an existing box, and it keeps the owner's part down to pasting one token.
 */
export const enroll = async (
  config: Pick<RelayClientConfig, 'host' | 'port'> & { readonly address?: string | null },
  identity: RelayIdentity,
  token: string
): Promise<EnrollmentResult> => {
  if (!config.host) throw new Error('A relay hostname is required before enrolling');
  const host = config.host;

  const socket = connectTls({
    host: config.address ?? host,
    port: config.port,
    servername: host,
    key: identity.keyPem,
    cert: identity.certPem,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
    ALPNProtocols: [CONTROL_ALPN]
  });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', () => resolve());
      socket.once('error', reject);
    });
    const presented = socket.getPeerX509Certificate();
    if (!presented) throw new Error('The relay presented no certificate');
    const pinnedRelaySpkiSha256 = spkiSha256(
      Buffer.from(presented.publicKey.export({ type: 'spki', format: 'der' }))
    );

    const session = connectHttp2(`https://${host}`, {
      createConnection: () => socket,
      maxSessionMemory: 256
    });
    try {
      const stream = session.request({ ':method': 'POST', ':path': PATH_ENROLL });
      stream.end(JSON.stringify({ token, identityPub: identity.rawPublicKey.toString('base64') }));
      const { status, body } = await new Promise<{ status: number; body: Record<string, unknown> }>(
        (resolve, reject) => {
          const chunks: Buffer[] = [];
          let code = 0;
          stream.on('response', (headers) => {
            code = Number(headers[':status'] ?? 0);
          });
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: code,
              body: text ? (JSON.parse(text) as Record<string, unknown>) : {}
            });
          });
          stream.on('error', reject);
        }
      );
      if (status !== 200) {
        throw new Error(
          typeof body.error === 'string'
            ? `The relay refused this enrollment: ${body.error}`
            : `The relay refused this enrollment (${status})`
        );
      }
      const expected = identity.labelFor(host);
      const label = typeof body.label === 'string' ? body.label : expected;
      // The relay derives the label from the key it just verified, so a different answer means it
      // is not deriving it the way the protocol says. Refuse rather than adopt an address the box
      // cannot reproduce offline.
      if (label !== expected) {
        throw new Error('The relay returned a label that does not match this box’s identity');
      }
      return { label, hostname: `${label}.${host}`, pinnedRelaySpkiSha256 };
    } finally {
      session.destroy();
    }
  } finally {
    socket.destroy();
  }
};
