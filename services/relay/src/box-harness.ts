import {
  connect as connectHttp2,
  type ClientHttp2Session,
  type ClientHttp2Stream
} from 'node:http2';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { decodeCbor } from './cbor.js';
import { NdjsonReader } from './ndjson.js';
import {
  CONTROL_ALPN,
  MAX_BIND_FRAME_BYTES,
  PARK_READY_MARKER,
  PATH_CONTROL,
  PATH_ENROLL,
  PATH_PARK,
  PROTOCOL_VERSION,
  PREVIEW_HTTPS_CAPABILITY,
  type BindFrame,
  type RelayToBoxMessage,
  type WelcomeMessage
} from './protocol.js';

/**
 * A minimal box-side tunnel client.
 *
 * This is the executable specification of the box half of the protocol: it is what this package's
 * tests drive the relay with, and it is the reference the real client in `packages/relay-client`
 * should behave identically to. It is deliberately small - the whole point of building on TLS 1.3
 * and HTTP/2 is that the box side is a few hundred lines of built-in Node modules.
 */

export interface BoxHarnessOptions {
  readonly host: string;
  readonly port: number;
  readonly controlHost: string;
  readonly key: string;
  readonly cert: string;
  readonly caps?: readonly string[];
  readonly onBind?: (frame: BindFrame, stream: ClientHttp2Stream) => void;
  readonly onMessage?: (message: RelayToBoxMessage) => void;
}

export interface EnrollResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export class BoxHarness {
  private readonly options: BoxHarnessOptions;
  private readonly socket: TLSSocket;
  private readonly session: ClientHttp2Session;
  private readonly received: RelayToBoxMessage[] = [];
  private parkTarget = 0;
  private parked = 0;
  private closed = false;

  constructor(options: BoxHarnessOptions) {
    this.options = options;
    this.socket = connectTls({
      host: options.host,
      port: options.port,
      servername: options.controlHost,
      key: options.key,
      cert: options.cert,
      // The box pins the relay's SPKI at enrollment (TOFU) rather than trusting a CA; the harness
      // has no pin store, so it accepts whatever the relay presents.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      ALPNProtocols: [CONTROL_ALPN]
    });
    this.socket.on('error', () => this.close());
    this.session = connectHttp2(`https://${options.controlHost}`, {
      createConnection: () => this.socket,
      // Node's default is 10 MB and it is a credit-based limit that rejects new streams once
      // exceeded, which shows up as mysterious stream failures rather than an error.
      maxSessionMemory: 256,
      peerMaxConcurrentStreams: 128,
      settings: { initialWindowSize: 262144, maxFrameSize: 65536, enablePush: false }
    });
    this.session.setTimeout(0);
    this.session.on('error', () => this.close());
  }

  get messages(): readonly RelayToBoxMessage[] {
    return this.received;
  }

  get parkedCount(): number {
    return this.parked;
  }

  /** Waits for the TLS handshake, or rejects if the relay refuses the identity outright. */
  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) {
        reject(new Error('socket destroyed'));
        return;
      }
      this.socket.once('secureConnect', () => resolve());
      this.socket.once('error', reject);
      this.socket.once('close', () => reject(new Error('closed before handshake')));
    });
  }

  async enroll(token: string, identityPub: Buffer): Promise<EnrollResponse> {
    const stream = this.session.request({ ':method': 'POST', ':path': PATH_ENROLL });
    stream.end(JSON.stringify({ token, identityPub: identityPub.toString('base64') }));
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let status = 0;
      stream.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status,
          body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}
        });
      });
      stream.on('error', reject);
    });
  }

  /** Opens the control stream, says hello and resolves on `welcome`. */
  start(): Promise<WelcomeMessage> {
    const stream = this.session.request({ ':method': 'POST', ':path': PATH_CONTROL });
    stream.setTimeout(0);
    stream.write(
      `${JSON.stringify({
        t: 'hello',
        proto: PROTOCOL_VERSION,
        role: 'primary',
        agent: 'garden-relay-harness/1',
        caps: this.options.caps ?? ['http1', 'h2', PREVIEW_HTTPS_CAPABILITY]
      })}\n`
    );
    const reader = new NdjsonReader();
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        for (const value of reader.push(chunk)) {
          const message = value as RelayToBoxMessage;
          this.received.push(message);
          this.options.onMessage?.(message);
          if (message.t === 'welcome') {
            this.parkTarget = message.parkTarget;
            this.replenish();
            resolve(message);
          } else if (message.t === 'need_park') {
            this.replenish();
          }
        }
      });
      stream.on('error', reject);
      stream.on('close', () => reject(new Error('control stream closed')));
      stream.on('response', (headers) => {
        const status = Number(headers[':status'] ?? 0);
        if (status !== 200) reject(new Error(`control rejected with ${status}`));
      });
    });
  }

  private replenish(): void {
    while (!this.closed && this.parked < this.parkTarget) this.park();
  }

  private park(): void {
    const stream = this.session.request({ ':method': 'POST', ':path': PATH_PARK });
    stream.setTimeout(0);
    this.parked += 1;
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
      this.parked -= 1;
      const frame = decodeCbor(buffered.subarray(4, 4 + length)) as unknown as BindFrame;
      const rest = buffered.subarray(4 + length);
      stream.removeListener('data', onData);
      stream.pause();
      // Whatever followed the frame is the client's first bytes; give them back to the stream so
      // the consumer sees an unbroken byte pipe starting at the client's ClientHello.
      //
      // The stream is handed over PAUSED and the consumer must start it reading (pipe it, resume
      // it, or wrap it in a TLSSocket, which resumes it itself). Adding a 'data' listener is not
      // enough: Node will not resume a stream that was explicitly paused.
      if (rest.length > 0) stream.unshift(rest);
      this.options.onBind?.(frame, stream);
      this.replenish();
    };

    stream.on('data', onData);
    stream.on('error', () => {
      if (!bound) this.parked -= 1;
    });
    stream.on('close', () => {
      if (!bound) {
        this.parked -= 1;
        bound = true;
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.destroy();
    this.socket.destroy();
  }
}
