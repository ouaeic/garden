import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  constants as http2,
  createServer as createHttp2Server,
  type Http2Server,
  type ServerHttp2Session,
  type ServerHttp2Stream
} from 'node:http2';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import {
  createServer as createTlsServer,
  type Server as TlsServer,
  type TLSSocket
} from 'node:tls';
import { MAX_CLIENT_HELLO_BYTES, parseClientHello } from './clienthello.js';
import { resolveControlHost, type RelayConfig } from './config.js';
import { MAX_HTTP_HEAD_BYTES, parseHttpHead } from './http-head.js';
import { labelFromHostname, rawEd25519FromSpki, spkiHash } from './label.js';
import { Semaphore, SourceRateLimiter } from './limits.js';
import { createLogger, type Logger } from './log.js';
import { METRIC_NAMES, Metrics } from './metrics.js';
import {
  CONTROL_ALPN,
  PREVIEW_HTTPS_PORT,
  PATH_CONTROL,
  PATH_ENROLL,
  PATH_PARK,
  TLS_ALERT_UNRECOGNIZED_NAME
} from './protocol.js';
import type { Registry } from './registry.js';
import { TunnelSession, type TunnelSessionDeps } from './session.js';

export interface RelayServerOptions {
  readonly config: RelayConfig;
  readonly registry: Registry;
  readonly tlsKey: string | Buffer;
  readonly tlsCert: string | Buffer;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

interface SessionContext {
  readonly spkiHash: string;
  readonly rawPublicKey: Buffer;
  tunnel: TunnelSession | null;
  enrolling: boolean;
  enrollTimer: NodeJS.Timeout | null;
}

const ENROLL_BODY_LIMIT = 4096;
const SOURCE_SWEEP_MS = 60_000;
/** :80 is a fallback path only, so it gets a quarter of the :443 per-source allowance. */
const HTTP_RATE_DIVISOR = 4;
/** Grace for a fatal alert to drain after a failed handshake before the socket is cut. */
const FAILED_HANDSHAKE_LINGER_MS = 1000;

interface EnrollRequest {
  readonly token?: unknown;
  readonly identityPub?: unknown;
}

/**
 * The relay.
 *
 * Two things it structurally cannot do, and both are properties of this file rather than promises
 * in a README: it never dials an address a client supplied (the only destinations are labels
 * registered by an authenticated peer), and it writes nothing to an unrouted client beyond a
 * seven-byte TLS alert, so it cannot be used for amplification.
 */
export class RelayServer {
  private readonly config: RelayConfig;
  private readonly registry: Registry;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly controlHost: string;

  private readonly tlsServer: TlsServer;
  private readonly h2Server: Http2Server;
  private readonly httpsListener: NetServer;
  private readonly previewListener: NetServer | null;
  private readonly controlListener: NetServer | null;
  private readonly httpListener: NetServer | null;
  private readonly metricsServer: HttpServer | null;

  private readonly sessions = new Map<ServerHttp2Session, SessionContext>();
  /**
   * Every client-facing socket the relay has accepted. Tracking them costs a Set entry next to a
   * socket - noise - and buys a bounded shutdown: `net.Server.close()` alone waits for connections
   * to drain, and a relay's connections are long-lived by design, so `systemctl stop` would hang.
   */
  private readonly clientSockets = new Set<Socket>();
  private readonly tunnels = new Map<string, TunnelSession>();
  private readonly halfOpen: Semaphore;
  private readonly enrollSlots: Semaphore;
  private readonly sourceLimiter: SourceRateLimiter;
  private readonly httpSourceLimiter: SourceRateLimiter;
  private readonly sweepTimer: NodeJS.Timeout;
  private closing = false;

  constructor(options: RelayServerOptions) {
    this.config = options.config;
    this.registry = options.registry;
    this.logger = options.logger ?? createLogger({ level: options.config.logLevel });
    this.metrics = options.metrics ?? new Metrics();
    this.controlHost = resolveControlHost(options.config);

    const { global: globalLimits, perSourceIp } = options.config.limits;
    this.halfOpen = new Semaphore(globalLimits.halfOpenPreSni);
    this.enrollSlots = new Semaphore(globalLimits.enrollingSessions);
    this.sourceLimiter = new SourceRateLimiter(
      perSourceIp.newConnPerMinute,
      perSourceIp.burst,
      perSourceIp.maxTrackedSources
    );
    this.httpSourceLimiter = new SourceRateLimiter(
      Math.max(1, Math.floor(perSourceIp.newConnPerMinute / HTTP_RATE_DIVISOR)),
      Math.max(1, Math.floor(perSourceIp.burst / HTTP_RATE_DIVISOR)),
      perSourceIp.maxTrackedSources
    );

    this.tlsServer = createTlsServer({
      key: options.tlsKey,
      cert: options.tlsCert,
      // TLS 1.3 only. CertificateVerify then signs the full handshake transcript, including our
      // ServerHello random and key share, which is what makes the box's identity proof
      // non-replayable without a bespoke challenge protocol - and 1.3 encrypts the client
      // Certificate message, so a passive observer never sees which box is connecting.
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      requestCert: true,
      // The chain is ignored on purpose: identity certificates are self-signed and authenticated by
      // SubjectPublicKeyInfo, not by any CA.
      rejectUnauthorized: false,
      ALPNProtocols: [CONTROL_ALPN],
      handshakeTimeout: options.config.handshakeTimeoutMs * 2
    });
    this.tlsServer.on('secureConnection', (socket: TLSSocket) => {
      this.h2Server.emit('connection', socket);
    });
    this.tlsServer.on('tlsClientError', (_error: Error, socket: TLSSocket) => {
      this.metrics.counter(METRIC_NAMES.sessionsRejected);
      // The TLS wrapper is finished but the TCP socket underneath is not, because this server was
      // handed an already-accepted socket rather than owning the listener. Left alone it would sit
      // there, which is a free way for anyone to hold sockets open with junk handshakes.
      //
      // destroySoon first so the fatal alert still reaches the peer - but a peer that never reads
      // would leave the flush pending forever, so back it with a hard deadline.
      socket.destroySoon();
      const backstop = setTimeout(() => socket.destroy(), FAILED_HANDSHAKE_LINGER_MS);
      backstop.unref();
      socket.once('close', () => clearTimeout(backstop));
    });

    this.h2Server = createHttp2Server({
      settings: {
        initialWindowSize: 262144,
        maxFrameSize: 65536,
        enablePush: false,
        maxConcurrentStreams: options.config.limits.perPeer.concurrentStreams + 64,
        maxHeaderListSize: 8192
      },
      // Bounds inbound buffering per peer. Node's default is 10 MB; the worst case here is
      // concurrentStreams * initialWindowSize, and in practice far less because the relay drains
      // into the client socket and backpressure propagates through HTTP/2 flow control.
      maxSessionMemory: 24,
      maxHeaderListPairs: 32
    });
    this.h2Server.on('session', (session) => this.onSession(session));
    this.h2Server.on('stream', (stream, headers) => {
      const path = headers[http2.HTTP2_HEADER_PATH];
      this.onStream(stream, typeof path === 'string' ? path : undefined);
    });
    this.h2Server.on('sessionError', () => this.metrics.counter(METRIC_NAMES.sessionsRejected));

    const sameListener = options.config.controlPort === options.config.httpsPort;
    this.httpsListener = createNetServer({ allowHalfOpen: true }, (socket) => {
      this.onTlsSocket(socket, sameListener);
    });
    this.controlListener = sameListener
      ? null
      : createNetServer({ allowHalfOpen: true }, (socket) => this.onTlsSocket(socket, true, true));
    this.previewListener =
      options.config.previewPort === null
        ? null
        : createNetServer({ allowHalfOpen: true }, (socket) =>
            this.onTlsSocket(socket, false, false, PREVIEW_HTTPS_PORT)
          );
    this.httpListener =
      options.config.httpPort === null
        ? null
        : createNetServer({ allowHalfOpen: true }, (socket) => this.onHttpSocket(socket));
    this.metricsServer =
      options.config.metricsPort === null
        ? null
        : createHttpServer((request, response) => {
            if (request.url !== '/metrics') {
              response.statusCode = 404;
              response.end();
              return;
            }
            response.setHeader('content-type', 'text/plain; version=0.0.4');
            response.end(this.metrics.render());
          });

    // `garden-relay revoke` edits the registry file; a running relay must drop the session too.
    this.registry.setPeersRemovedListener((labels) => {
      for (const label of labels) {
        this.logger.info('peer revoked externally', { label });
        this.tunnels.get(label)?.close('revoked', true);
      }
    });

    this.registerMetrics();
    this.sweepTimer = setInterval(() => {
      this.sourceLimiter.sweep();
      this.httpSourceLimiter.sweep();
    }, SOURCE_SWEEP_MS);
    this.sweepTimer.unref();
  }

  private registerMetrics(): void {
    for (const name of [
      METRIC_NAMES.connectionsAccepted,
      METRIC_NAMES.connectionsRejected,
      METRIC_NAMES.connectionsBound,
      METRIC_NAMES.handshakeTimeouts,
      METRIC_NAMES.unknownLabel,
      METRIC_NAMES.quotaBlocked,
      METRIC_NAMES.rateLimited,
      METRIC_NAMES.enrollSucceeded,
      METRIC_NAMES.enrollRejected,
      METRIC_NAMES.sessionsRejected,
      METRIC_NAMES.bytesRelayed
    ]) {
      this.metrics.declareCounter(name);
    }
    this.metrics.gauge(METRIC_NAMES.peersOnline, () => this.tunnels.size);
    this.metrics.gauge(METRIC_NAMES.peersRegistered, () => this.registry.peerCount);
    this.metrics.gauge(METRIC_NAMES.parkedStreams, () =>
      [...this.tunnels.values()].reduce((total, tunnel) => total + tunnel.parkedCount, 0)
    );
    this.metrics.gauge(METRIC_NAMES.activeStreams, () =>
      [...this.tunnels.values()].reduce((total, tunnel) => total + tunnel.activeCount, 0)
    );
    this.metrics.gauge(METRIC_NAMES.openConnections, () => this.clientSockets.size);
  }

  async listen(): Promise<void> {
    const { config } = this;
    await listenOn(this.httpsListener, config.httpsPort, config.listenHost);
    if (this.controlListener !== null) {
      await listenOn(this.controlListener, config.controlPort, config.listenHost);
    }
    if (this.previewListener !== null && config.previewPort !== null) {
      await listenOn(this.previewListener, config.previewPort, config.listenHost);
    }
    if (this.httpListener !== null && config.httpPort !== null) {
      await listenOn(this.httpListener, config.httpPort, config.listenHost);
    }
    if (this.metricsServer !== null && config.metricsPort !== null) {
      await listenOn(this.metricsServer, config.metricsPort, config.metricsHost);
    }
    this.logger.info('relay listening', {
      domain: config.relayDomain,
      https: this.httpsPort ?? -1,
      preview: this.previewPort ?? -1,
      control: this.controlPort ?? -1,
      http: this.httpPort ?? -1,
      peers: this.registry.peerCount
    });
  }

  get httpsPort(): number | null {
    return portOf(this.httpsListener);
  }

  get previewPort(): number | null {
    return this.previewListener === null ? null : portOf(this.previewListener);
  }

  get controlPort(): number | null {
    return this.controlListener === null ? this.httpsPort : portOf(this.controlListener);
  }

  get httpPort(): number | null {
    return this.httpListener === null ? null : portOf(this.httpListener);
  }

  get metricsPort(): number | null {
    return this.metricsServer === null ? null : portOf(this.metricsServer);
  }

  get onlineLabels(): readonly string[] {
    return [...this.tunnels.keys()];
  }

  tunnelFor(label: string): TunnelSession | undefined {
    return this.tunnels.get(label);
  }

  /** Revokes a peer and evicts its live session immediately. */
  revoke(label: string): boolean {
    const removed = this.registry.revoke(label);
    this.tunnels.get(label)?.close('revoked', true);
    return removed;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.sweepTimer);
    for (const tunnel of [...this.tunnels.values()]) tunnel.close('restart', true);
    for (const session of [...this.sessions.keys()]) session.destroy();
    this.sessions.clear();
    for (const socket of [...this.clientSockets]) socket.destroy();
    this.clientSockets.clear();
    await Promise.all([
      closeServer(this.httpsListener),
      this.previewListener === null ? Promise.resolve() : closeServer(this.previewListener),
      this.controlListener === null ? Promise.resolve() : closeServer(this.controlListener),
      this.httpListener === null ? Promise.resolve() : closeServer(this.httpListener),
      this.metricsServer === null ? Promise.resolve() : closeServer(this.metricsServer)
    ]);
    this.h2Server.close();
    this.tlsServer.close();
    await this.registry.flush(true);
  }

  // ---------------------------------------------------------------- client-facing data plane

  private track(socket: Socket): void {
    this.clientSockets.add(socket);
    socket.once('close', () => this.clientSockets.delete(socket));
  }

  private onTlsSocket(
    socket: Socket,
    allowControl: boolean,
    controlOnly = false,
    port: 443 | typeof PREVIEW_HTTPS_PORT = 443
  ): void {
    if (!this.halfOpen.tryAcquire()) {
      this.metrics.counter(METRIC_NAMES.connectionsRejected);
      socket.destroy();
      return;
    }
    if (!this.sourceLimiter.allow(socket.remoteAddress ?? '')) {
      this.halfOpen.release();
      this.metrics.counter(METRIC_NAMES.rateLimited);
      socket.destroy();
      return;
    }
    this.metrics.counter(METRIC_NAMES.connectionsAccepted);
    this.track(socket);
    socket.setNoDelay(true);
    // A backstop under the HTTP/2 PING keepalive, for paths where the tunnel is idle but the NAT
    // mapping is not.
    socket.setKeepAlive(true, 30_000);

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      socket.removeListener('data', onData);
      socket.pause();
      this.halfOpen.release();
      return true;
    };

    const deadline = setTimeout(() => {
      if (!settle()) return;
      this.metrics.counter(METRIC_NAMES.handshakeTimeouts);
      socket.destroy();
    }, this.config.handshakeTimeoutMs);
    deadline.unref();

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > MAX_CLIENT_HELLO_BYTES) {
        if (settle()) socket.destroy();
        return;
      }
      const buffered = Buffer.concat(chunks);
      const result = parseClientHello(buffered);
      if (result.status === 'need-more') return;
      if (!settle()) return;
      if (result.status === 'invalid') {
        this.metrics.counter(METRIC_NAMES.connectionsRejected);
        socket.destroy();
        return;
      }
      this.routeTls(socket, buffered, result.info.serverName, result.info.alpnProtocols, {
        allowControl,
        controlOnly,
        port
      });
    };

    socket.on('data', onData);
    socket.on('error', () => {
      settle();
      socket.destroy();
    });
    socket.on('close', () => settle());
  }

  private routeTls(
    socket: Socket,
    buffered: Buffer,
    serverName: string | null,
    alpn: readonly string[],
    mode: { allowControl: boolean; controlOnly: boolean; port: 443 | typeof PREVIEW_HTTPS_PORT }
  ): void {
    const isControl =
      serverName === this.controlHost &&
      alpn.includes(CONTROL_ALPN) &&
      mode.allowControl &&
      !this.closing;
    if (isControl) {
      // Hand the untouched ClientHello back so Node's TLS stack sees a pristine stream.
      socket.unshift(buffered);
      this.tlsServer.emit('connection', socket);
      return;
    }
    if (mode.controlOnly) {
      this.rejectTls(socket, 'not-control');
      return;
    }

    const label =
      serverName === null ? null : labelFromHostname(serverName, this.config.relayDomain);
    if (label === null) {
      this.metrics.counter(METRIC_NAMES.unknownLabel);
      this.rejectTls(socket, 'no-route');
      return;
    }
    this.bindToTunnel(socket, buffered, label, serverName ?? '', mode.port);
  }

  private bindToTunnel(
    socket: Socket,
    buffered: Buffer,
    label: string,
    sni: string,
    port: 443 | 80 | typeof PREVIEW_HTTPS_PORT
  ): void {
    const tunnel = this.tunnels.get(label);
    if (tunnel === undefined || !tunnel.isReady) {
      this.metrics.counter(METRIC_NAMES.unknownLabel);
      if (port !== 80) this.rejectTls(socket, 'offline');
      else this.rejectHttp(socket, 502, 'server offline');
      return;
    }
    const result = tunnel.bind({ socket, initial: buffered, sni, port });
    if (result.ok) {
      const record = { cid: result.cid, label, port };
      if (this.config.logClientIps) {
        // Emitted at info, not debug: this record is the only thing `garden-relay abuse` has to
        // work from, and an operator who turned address logging on should not also have to turn on
        // debug logging for the whole relay to get it.
        this.logger.info('relayed', {
          ...record,
          ip: socket.remoteAddress ?? '',
          sport: socket.remotePort ?? 0
        });
      } else {
        this.logger.debug('relayed', record);
      }
      return;
    }
    if (result.reason === 'quota-blocked') this.metrics.counter(METRIC_NAMES.quotaBlocked);
    else this.metrics.counter(METRIC_NAMES.rateLimited);
    if (port !== 80) this.rejectTls(socket, result.reason);
    else this.rejectHttp(socket, 503, result.reason);
  }

  /**
   * Refuses a client with a TLS `unrecognized_name` alert rather than a bare RST.
   *
   * Seven bytes out for a ClientHello in: the pre-authorization amplification ratio stays far below
   * one, which is the whole reason there is no UDP listener either.
   */
  private rejectTls(socket: Socket, reason: string): void {
    this.metrics.counter(METRIC_NAMES.connectionsRejected);
    this.logger.debug('refused', { reason });
    socket.end(TLS_ALERT_UNRECOGNIZED_NAME);
    socket.destroySoon();
  }

  private rejectHttp(socket: Socket, status: number, reason: string): void {
    this.metrics.counter(METRIC_NAMES.connectionsRejected);
    const body = `${reason}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Unavailable'}\r\n` +
        'connection: close\r\n' +
        'content-type: text/plain\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    );
    socket.destroySoon();
  }

  private onHttpSocket(socket: Socket): void {
    if (!this.halfOpen.tryAcquire()) {
      this.metrics.counter(METRIC_NAMES.connectionsRejected);
      socket.destroy();
      return;
    }
    if (!this.httpSourceLimiter.allow(socket.remoteAddress ?? '')) {
      this.halfOpen.release();
      this.metrics.counter(METRIC_NAMES.rateLimited);
      socket.destroy();
      return;
    }
    this.metrics.counter(METRIC_NAMES.connectionsAccepted);
    this.track(socket);
    socket.setNoDelay(true);

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      socket.removeListener('data', onData);
      socket.pause();
      this.halfOpen.release();
      return true;
    };
    const deadline = setTimeout(() => {
      if (!settle()) return;
      this.metrics.counter(METRIC_NAMES.handshakeTimeouts);
      socket.destroy();
    }, this.config.handshakeTimeoutMs);
    deadline.unref();

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > MAX_HTTP_HEAD_BYTES) {
        if (settle()) socket.destroy();
        return;
      }
      const buffered = Buffer.concat(chunks);
      const result = parseHttpHead(buffered);
      if (result.status === 'need-more') return;
      if (!settle()) return;
      if (result.status === 'invalid') {
        this.metrics.counter(METRIC_NAMES.connectionsRejected);
        socket.destroy();
        return;
      }
      const host = result.head.host;
      const label = host === null ? null : labelFromHostname(host, this.config.relayDomain);
      if (label === null) {
        this.metrics.counter(METRIC_NAMES.unknownLabel);
        this.rejectHttp(socket, 404, 'no such server');
        return;
      }
      this.bindToTunnel(socket, buffered, label, host ?? '', 80);
    };

    socket.on('data', onData);
    socket.on('error', () => {
      settle();
      socket.destroy();
    });
    socket.on('close', () => settle());
  }

  // ---------------------------------------------------------------- control plane

  private sessionDeps(): TunnelSessionDeps {
    return {
      config: this.config,
      registry: this.registry,
      logger: this.logger,
      metrics: this.metrics,
      onClosed: (tunnel) => {
        if (this.tunnels.get(tunnel.label) === tunnel) this.tunnels.delete(tunnel.label);
      },
      globalShaping: () => this.globalShaping(),
      globalBlocked: () => this.globalBlocked(),
      previewPort: () => this.previewPort
    };
  }

  private globalShaping(): boolean {
    const { monthlyBytes, shapeAtFraction } = this.config.limits.global;
    return this.registry.globalUsage().bytes >= monthlyBytes * shapeAtFraction;
  }

  private globalBlocked(): boolean {
    return this.registry.globalUsage().bytes >= this.config.limits.global.monthlyBytes;
  }

  private onSession(session: ServerHttp2Session): void {
    const socket = session.socket as TLSSocket | undefined;
    const certificate = socket?.getPeerX509Certificate?.();
    if (certificate === undefined) {
      this.metrics.counter(METRIC_NAMES.sessionsRejected);
      session.destroy();
      return;
    }
    const spki = Buffer.from(certificate.publicKey.export({ type: 'spki', format: 'der' }));
    const rawPublicKey = rawEd25519FromSpki(spki);
    if (rawPublicKey === null) {
      this.logger.warn('identity certificate is not ed25519');
      this.metrics.counter(METRIC_NAMES.sessionsRejected);
      session.destroy();
      return;
    }

    const hash = spkiHash(spki);
    const peer = this.registry.peerBySpkiHash(hash);
    const context: SessionContext = {
      spkiHash: hash,
      rawPublicKey,
      tunnel: null,
      enrolling: false,
      enrollTimer: null
    };

    if (peer !== undefined) {
      const existing = this.tunnels.get(peer.label);
      // A box that reconnects after a network blip must win; the stale session is the dead one.
      if (existing !== undefined) existing.close('replaced', false);
      const tunnel = new TunnelSession(this.sessionDeps(), session, peer);
      context.tunnel = tunnel;
      this.tunnels.set(peer.label, tunnel);
    } else {
      if (!this.enrollSlots.tryAcquire()) {
        this.metrics.counter(METRIC_NAMES.sessionsRejected);
        session.destroy();
        return;
      }
      context.enrolling = true;
      context.enrollTimer = setTimeout(() => {
        this.logger.debug('enrollment window expired');
        session.destroy();
      }, this.config.enrollTimeoutMs);
      context.enrollTimer.unref();
    }

    this.sessions.set(session, context);
    session.on('close', () => this.releaseSession(session));
    session.on('error', () => this.releaseSession(session));
  }

  private releaseSession(session: ServerHttp2Session): void {
    const context = this.sessions.get(session);
    if (context === undefined) return;
    this.sessions.delete(session);
    if (context.enrollTimer !== null) clearTimeout(context.enrollTimer);
    if (context.enrolling) this.enrollSlots.release();
  }

  private onStream(stream: ServerHttp2Stream, path: string | undefined): void {
    const context = this.sessions.get(stream.session as ServerHttp2Session);
    if (context === undefined) {
      stream.close(http2.NGHTTP2_REFUSED_STREAM);
      return;
    }
    switch (path) {
      case PATH_ENROLL:
        this.handleEnroll(stream, context);
        return;
      case PATH_CONTROL:
        if (context.tunnel === null) {
          this.refuseUnknownIdentity(stream);
          return;
        }
        context.tunnel.attachControl(stream);
        return;
      case PATH_PARK:
        if (context.tunnel === null) {
          this.refuseUnknownIdentity(stream);
          return;
        }
        context.tunnel.attachPark(stream);
        return;
      default:
        stream.respond({ ':status': 404 }, { endStream: true });
    }
  }

  /**
   * An authenticated peer whose SPKI is not in the registry may do exactly one thing: enroll.
   * Everything else gets 401 and the session is torn down.
   */
  private refuseUnknownIdentity(stream: ServerHttp2Stream): void {
    this.metrics.counter(METRIC_NAMES.sessionsRejected);
    this.logger.warn('unknown identity attempted control');
    stream.respond({ ':status': 401 }, { endStream: true });
    stream.session?.close();
  }

  private handleEnroll(stream: ServerHttp2Stream, context: SessionContext): void {
    if (context.tunnel !== null) {
      // Already registered; nothing to do, and re-running enrollment must not burn a token.
      this.respondJson(stream, 200, { label: context.tunnel.label, alreadyEnrolled: true });
      return;
    }
    if (!this.config.registrationEnabled) {
      this.metrics.counter(METRIC_NAMES.enrollRejected);
      this.respondJson(stream, 403, { error: 'registration-disabled' });
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > ENROLL_BODY_LIMIT) {
        stream.close(http2.NGHTTP2_ENHANCE_YOUR_CALM);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      void this.completeEnroll(stream, context, Buffer.concat(chunks));
    });
  }

  private async completeEnroll(
    stream: ServerHttp2Stream,
    context: SessionContext,
    raw: Buffer
  ): Promise<void> {
    let body: EnrollRequest;
    try {
      body = JSON.parse(raw.toString('utf8')) as EnrollRequest;
    } catch {
      this.metrics.counter(METRIC_NAMES.enrollRejected);
      this.respondJson(stream, 400, { error: 'invalid-body' });
      return;
    }
    if (typeof body.token !== 'string' || typeof body.identityPub !== 'string') {
      this.metrics.counter(METRIC_NAMES.enrollRejected);
      this.respondJson(stream, 400, { error: 'invalid-body' });
      return;
    }
    // The claimed public key must be the one that just proved possession in the TLS handshake.
    const claimed = Buffer.from(body.identityPub, 'base64');
    if (claimed.length !== context.rawPublicKey.length || !claimed.equals(context.rawPublicKey)) {
      this.metrics.counter(METRIC_NAMES.enrollRejected);
      this.respondJson(stream, 400, { error: 'identity-mismatch' });
      return;
    }

    // Pick up any invite the operator minted with the CLI since this process started.
    await this.registry.syncFromDisk();
    const outcome = this.registry.redeemInvite(body.token, context.rawPublicKey, context.spkiHash);
    if (!outcome.ok) {
      this.metrics.counter(METRIC_NAMES.enrollRejected);
      this.logger.warn('enrollment refused', { reason: outcome.reason });
      this.respondJson(stream, 403, { error: outcome.reason });
      return;
    }

    if (context.enrollTimer !== null) {
      clearTimeout(context.enrollTimer);
      context.enrollTimer = null;
    }
    if (context.enrolling) {
      context.enrolling = false;
      this.enrollSlots.release();
    }
    const session = stream.session as ServerHttp2Session;
    const tunnel = new TunnelSession(this.sessionDeps(), session, outcome.peer);
    context.tunnel = tunnel;
    this.tunnels.get(outcome.peer.label)?.close('replaced', false);
    this.tunnels.set(outcome.peer.label, tunnel);

    this.metrics.counter(METRIC_NAMES.enrollSucceeded);
    this.logger.info('enrolled', { label: outcome.peer.label });
    await this.registry.flush();
    this.respondJson(stream, 200, {
      label: outcome.peer.label,
      host: `${outcome.peer.label}.${this.config.relayDomain}`,
      alreadyEnrolled: outcome.alreadyEnrolled,
      quota: outcome.peer.quota
    });
  }

  private respondJson(stream: ServerHttp2Stream, status: number, body: unknown): void {
    if (stream.destroyed) return;
    stream.respond({ ':status': status, 'content-type': 'application/json' });
    stream.end(JSON.stringify(body));
  }
}

const listenOn = (server: NetServer | HttpServer, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

const closeServer = (server: NetServer | HttpServer): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const portOf = (server: NetServer | HttpServer): number | null => {
  const address = server.address();
  return address !== null && typeof address === 'object' ? address.port : null;
};
