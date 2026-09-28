import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { TLSSocket, connect as connectTls } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientHttp2Stream } from 'node:http2';
import { BoxHarness } from './box-harness.js';
import { parseRelayConfig, type RelayConfig } from './config.js';
import { deriveLabel, publicKeySpkiDer } from './index.js';
import { createLogger, silentLogger, type Logger } from './log.js';
import { METRIC_NAMES, Metrics } from './metrics.js';
import { CONTROL_ALPN, TLS_ALERT_UNRECOGNIZED_NAME, type BindFrame } from './protocol.js';
import { Registry } from './registry.js';
import { RelayServer } from './relay.js';
import { createSelfSignedCertificate, generateIdentityKeyPair } from './x509.js';

const RELAY_DOMAIN = 'relay.example';

interface Harness {
  server: RelayServer;
  registry: Registry;
  metrics: Metrics;
  config: RelayConfig;
  httpsPort: number;
  httpPort: number;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const startRelay = async (
  overrides: Record<string, unknown> = {},
  logger: Logger = silentLogger
): Promise<Harness> => {
  const directory = await mkdtemp(join(tmpdir(), 'garden-relay-'));
  const { privateKey } = generateIdentityKeyPair();
  const certificate = createSelfSignedCertificate({
    privateKey,
    commonName: RELAY_DOMAIN,
    dnsNames: [RELAY_DOMAIN, `*.${RELAY_DOMAIN}`]
  });
  const config = parseRelayConfig({
    relayDomain: RELAY_DOMAIN,
    listenHost: '127.0.0.1',
    httpsPort: 0,
    previewPort: 0,
    controlPort: 0,
    httpPort: 0,
    metricsPort: 0,
    tlsCertPath: 'unused',
    tlsKeyPath: 'unused',
    registryPath: join(directory, 'registry.json'),
    pingIntervalMs: 60_000,
    ...overrides
  });
  const registry = await Registry.open({
    path: config.registryPath,
    relayDomain: config.relayDomain,
    maxPeers: config.limits.global.maxPeers,
    registrationEnabled: config.registrationEnabled,
    defaultQuota: {
      monthlyBytes: config.defaultPeerQuota.monthlyBytes ?? config.limits.perPeer.monthlyBytes,
      maxConcurrentStreams:
        config.defaultPeerQuota.maxConcurrentStreams ?? config.limits.perPeer.concurrentStreams,
      rateBps: config.defaultPeerQuota.rateBps ?? config.limits.perPeer.rateBps
    },
    flushIntervalMs: 3_600_000
  });
  const metrics = new Metrics();
  const server = new RelayServer({
    config,
    registry,
    metrics,
    logger,
    tlsKey: certificate.keyPem,
    tlsCert: certificate.certPem
  });
  await server.listen();
  cleanups.push(async () => {
    await server.close();
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    server,
    registry,
    metrics,
    config,
    httpsPort: server.httpsPort ?? 0,
    httpPort: server.httpPort ?? 0
  };
};

interface Box {
  raw: Buffer;
  label: string;
  keyPem: string;
  certPem: string;
}

const makeBox = (): Box => {
  const { privateKey } = generateIdentityKeyPair();
  const raw = publicKeySpkiDer(privateKey).subarray(12);
  const label = deriveLabel(RELAY_DOMAIN, raw);
  const certificate = createSelfSignedCertificate({
    privateKey,
    commonName: 'garden',
    // One key pair for every path, so the client rule is always "pin the SPKI, not the certificate".
    dnsNames: [`${label}.${RELAY_DOMAIN}`]
  });
  return { raw, label, keyPem: certificate.keyPem, certPem: certificate.certPem };
};

/** Terminates TLS on the box side and echoes, proving the relay never sees plaintext. */
const boxOnBind =
  (box: Box, seen: BindFrame[]) =>
  (frame: BindFrame, stream: ClientHttp2Stream): void => {
    seen.push(frame);
    if (frame.port === 80) {
      const request: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => {
        request.push(chunk);
        const body = Buffer.concat(request).toString('utf8');
        if (!body.includes('\r\n\r\n')) return;
        const payload = `host=${/host: (\S+)/i.exec(body)?.[1] ?? ''}`;
        stream.write(
          `HTTP/1.1 200 OK\r\ncontent-length: ${payload.length}\r\nconnection: close\r\n\r\n${payload}`
        );
        stream.end();
      });
      // The harness hands the stream over paused; adding a 'data' listener does not resume a stream
      // that was explicitly paused, so start it reading.
      stream.resume();
      return;
    }
    const tlsSocket = new TLSSocket(stream as unknown as Socket, {
      isServer: true,
      key: box.keyPem,
      cert: box.certPem,
      ALPNProtocols: ['http/1.1']
    });
    tlsSocket.on('error', () => undefined);
    tlsSocket.on('secure', () => {
      tlsSocket.on('data', (chunk: Buffer) => tlsSocket.write(`echo:${chunk.toString('utf8')}`));
    });
  };

const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

interface ConnectedBox {
  harness: BoxHarness;
  binds: BindFrame[];
}

const connectBox = async (
  harness: Harness,
  box: Box,
  token: string | null,
  caps?: readonly string[]
): Promise<ConnectedBox> => {
  const binds: BindFrame[] = [];
  const client = new BoxHarness({
    host: '127.0.0.1',
    port: harness.server.controlPort ?? 0,
    controlHost: RELAY_DOMAIN,
    key: box.keyPem,
    cert: box.certPem,
    ...(caps ? { caps } : {}),
    onBind: boxOnBind(box, binds)
  });
  cleanups.push(async () => client.close());
  await client.ready();
  if (token !== null) {
    const response = await client.enroll(token, box.raw);
    expect(response.status).toBe(200);
    expect(response.body['label']).toBe(box.label);
  }
  const welcome = await client.start();
  expect(welcome.label).toBe(box.label);
  await waitFor(
    () => (harness.server.tunnelFor(box.label)?.parkedCount ?? 0) >= welcome.parkTarget
  );
  return { harness: client, binds };
};

/** Captures a genuine ClientHello so probes exercise the same path a browser would. */
const captureClientHello = (servername: string, alpn?: string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        socket.destroy();
        server.close();
        resolve(chunk);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address !== 'object') return;
      const client = connectTls({
        host: '127.0.0.1',
        port: address.port,
        servername,
        rejectUnauthorized: false,
        ...(alpn === undefined ? {} : { ALPNProtocols: alpn })
      });
      client.on('error', () => undefined);
    });
  });

/** Sends a ClientHello and returns everything the relay wrote back before closing. */
const probe = async (
  port: number,
  servername: string
): Promise<{ sent: number; received: Buffer }> => {
  const hello = await captureClientHello(servername);
  const received = await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(hello));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(Buffer.concat(chunks)));
  });
  return { sent: hello.length, received };
};

describe('isolated preview forwarding', () => {
  it('routes preview TLS with its own logical port and the box certificate', async () => {
    const relay = await startRelay();
    const box = makeBox();
    const { token } = relay.registry.createInvite('preview', 60_000);
    const connected = await connectBox(relay, box, token);
    expect(relay.server.previewPort).toBeGreaterThan(0);
    const client = connectTls({
      host: '127.0.0.1',
      port: relay.server.previewPort!,
      servername: `${box.label}.${RELAY_DOMAIN}`,
      rejectUnauthorized: false
    });
    cleanups.push(async () => {
      client.destroy();
    });
    await once(client, 'secureConnect');
    expect(client.getPeerX509Certificate()?.fingerprint256).toBe(
      new X509Certificate(box.certPem).fingerprint256
    );
    client.write('preview');
    const [reply] = (await once(client, 'data')) as [Buffer];
    expect(reply.toString()).toBe('echo:preview');
    expect(connected.binds).toHaveLength(1);
    expect(connected.binds[0]?.port).toBe(8443);
    expect(relay.metrics.read(METRIC_NAMES.bytesRelayed)).toBeGreaterThan(0);
  });

  it('refuses preview traffic to a box that only implements owner and HTTP listeners', async () => {
    const relay = await startRelay();
    const box = makeBox();
    const { token } = relay.registry.createInvite('legacy', 60_000);
    const connected = await connectBox(relay, box, token, ['http1', 'h2']);
    const tunnel = relay.server.tunnelFor(box.label)!;
    expect(tunnel.parkedCount).toBeGreaterThan(0);
    const parked = tunnel.parkedCount;
    const client = connectTls({
      host: '127.0.0.1',
      port: relay.server.previewPort!,
      servername: `${box.label}.${RELAY_DOMAIN}`,
      rejectUnauthorized: false
    });
    cleanups.push(async () => {
      client.destroy();
    });
    const outcome = await new Promise<string>((resolve) => {
      client.once('secureConnect', () => resolve('connected'));
      client.once('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
    expect(connected.binds).toHaveLength(0);
    expect(tunnel.parkedCount).toBe(parked);
    expect(tunnel.activeCount).toBe(0);
  });

  it('does not accept control connections on the preview listener', async () => {
    const relay = await startRelay();
    expect(relay.server.previewPort).toBeGreaterThan(0);
    const box = makeBox();
    const client = connectTls({
      host: '127.0.0.1',
      port: relay.server.previewPort!,
      servername: RELAY_DOMAIN,
      key: box.keyPem,
      cert: box.certPem,
      rejectUnauthorized: false,
      ALPNProtocols: [CONTROL_ALPN]
    });
    cleanups.push(async () => {
      client.destroy();
    });
    const outcome = await new Promise<string>((resolve) => {
      client.once('secureConnect', () => resolve('connected'));
      client.once('error', () => resolve('refused'));
    });
    expect(outcome).toBe('refused');
  });

  it('advertises absent previews when the operator disables the separate listener', async () => {
    const relay = await startRelay({ previewPort: null });
    const box = makeBox();
    const { token } = relay.registry.createInvite('disabled-preview', 60_000);
    const connected = await connectBox(relay, box, token);
    expect(relay.server.previewPort).toBeNull();
    const welcome = connected.harness.messages.find((message) => message.t === 'welcome');
    expect(welcome).toBeDefined();
    expect(welcome?.t === 'welcome' && welcome.caps).toEqual([]);
  });
});

describe('handshake and forwarding', () => {
  it('enrolls a box, derives its label and relays bytes end to end', async () => {
    const relay = await startRelay();
    const box = makeBox();
    const { token } = relay.registry.createInvite('dan-basement', 60_000);
    const connected = await connectBox(relay, box, token);

    expect(relay.server.onlineLabels).toEqual([box.label]);
    expect(
      relay.registry.peerBySpkiHash(relay.registry.listPeers()[0]?.spkiHash ?? '')?.label
    ).toBe(box.label);

    const client = connectTls({
      host: '127.0.0.1',
      port: relay.httpsPort,
      servername: `${box.label}.${RELAY_DOMAIN}`,
      rejectUnauthorized: false
    });
    cleanups.push(async () => {
      client.destroy();
    });
    await once(client, 'secureConnect');

    // The certificate the client sees is the box's own: TLS terminated past the relay, so the
    // relay moved ciphertext it could not read.
    expect(client.getPeerX509Certificate()?.fingerprint256).toBe(
      new X509Certificate(box.certPem).fingerprint256
    );

    client.write('ping');
    const [reply] = (await once(client, 'data')) as [Buffer];
    expect(reply.toString('utf8')).toBe('echo:ping');

    expect(connected.binds).toHaveLength(1);
    const frame = connected.binds[0];
    expect(frame?.l).toBe(box.label);
    expect(frame?.sni).toBe(`${box.label}.${RELAY_DOMAIN}`);
    expect(frame?.port).toBe(443);
    expect(frame?.cid).toHaveLength(16);
    expect(relay.metrics.read(METRIC_NAMES.connectionsBound)).toBe(1);
    expect(relay.metrics.read(METRIC_NAMES.bytesRelayed)).toBeGreaterThan(0);
  });

  it('replenishes the park pool so a second connection does not wait for a new stream', async () => {
    const relay = await startRelay();
    const box = makeBox();
    const { token } = relay.registry.createInvite('pool', 60_000);
    const connected = await connectBox(relay, box, token);
    const target = relay.config.parkTarget;

    const clients = await Promise.all(
      [0, 1, 2].map(async () => {
        const client = connectTls({
          host: '127.0.0.1',
          port: relay.httpsPort,
          servername: `${box.label}.${RELAY_DOMAIN}`,
          rejectUnauthorized: false
        });
        await once(client, 'secureConnect');
        return client;
      })
    );
    cleanups.push(async () => {
      for (const client of clients) client.destroy();
    });

    expect(connected.binds).toHaveLength(3);
    await waitFor(() => (relay.server.tunnelFor(box.label)?.parkedCount ?? 0) >= target);
  });

  it('reclaims a stream slot when a client vanishes without closing cleanly', async () => {
    const relay = await startRelay({ halfCloseLingerMs: 1000 });
    const box = makeBox();
    const { token } = relay.registry.createInvite('linger', 60_000);
    await connectBox(relay, box, token);

    const client = connectTls({
      host: '127.0.0.1',
      port: relay.httpsPort,
      servername: `${box.label}.${RELAY_DOMAIN}`,
      rejectUnauthorized: false
    });
    await once(client, 'secureConnect');
    client.write('ping');
    await once(client, 'data');
    expect(relay.server.tunnelFor(box.label)?.activeCount).toBe(1);

    // A vanishing client half-closes the relay's socket. The box's TLS stack has no reason to
    // finish its side, so without a linger the slot would be held until the tunnel itself died.
    client.destroy();
    await waitFor(() => relay.server.tunnelFor(box.label)?.activeCount === 0);
    // Only the box's own control connection is left.
    expect(relay.metrics.read(METRIC_NAMES.openConnections)).toBe(1);
  });

  it('routes the plaintext port on Host for the ACME HTTP-01 fallback', async () => {
    const relay = await startRelay();
    const box = makeBox();
    const { token } = relay.registry.createInvite('acme', 60_000);
    const connected = await connectBox(relay, box, token);

    const response = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      const socket = createConnection({ host: '127.0.0.1', port: relay.httpPort }, () => {
        socket.write(
          'GET /.well-known/acme-challenge/token HTTP/1.1\r\n' +
            `Host: ${box.label}.${RELAY_DOMAIN}\r\n\r\n`
        );
      });
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', () => undefined);
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    expect(response).toContain('200 OK');
    // The box saw the original request head, byte for byte, including the Host it was routed on.
    expect(response).toContain(`host=${box.label}.${RELAY_DOMAIN}`);
    expect(connected.binds.at(-1)?.port).toBe(80);
  });
});

describe('identity proof', () => {
  it('refuses an identity that is not in the registry', async () => {
    const relay = await startRelay();
    const stranger = makeBox();
    const client = new BoxHarness({
      host: '127.0.0.1',
      port: relay.server.controlPort ?? 0,
      controlHost: RELAY_DOMAIN,
      key: stranger.keyPem,
      cert: stranger.certPem
    });
    cleanups.push(async () => client.close());
    // The TLS handshake itself succeeds: the relay accepts any well-formed identity certificate and
    // decides afterwards, because rejecting inside the handshake would leak which keys it knows.
    await client.ready();
    await expect(client.start()).rejects.toThrow(/401|closed/);
    expect(relay.server.onlineLabels).toEqual([]);
    expect(relay.metrics.read(METRIC_NAMES.sessionsRejected)).toBeGreaterThan(0);
  });

  it('refuses an enrollment whose claimed key is not the one that signed the handshake', async () => {
    const relay = await startRelay();
    const box = makeBox();
    const impostor = makeBox();
    const { token } = relay.registry.createInvite('mismatch', 60_000);
    const client = new BoxHarness({
      host: '127.0.0.1',
      port: relay.server.controlPort ?? 0,
      controlHost: RELAY_DOMAIN,
      key: box.keyPem,
      cert: box.certPem
    });
    cleanups.push(async () => client.close());
    await client.ready();
    const response = await client.enroll(token, impostor.raw);
    expect(response.status).toBe(400);
    expect(response.body['error']).toBe('identity-mismatch');
    expect(relay.registry.peerCount).toBe(0);
  });

  it('burns an invite so a captured token cannot be replayed by a second box', async () => {
    const relay = await startRelay();
    const first = makeBox();
    const second = makeBox();
    const { token } = relay.registry.createInvite('single-use', 60_000);
    await connectBox(relay, first, token);

    const replay = new BoxHarness({
      host: '127.0.0.1',
      port: relay.server.controlPort ?? 0,
      controlHost: RELAY_DOMAIN,
      key: second.keyPem,
      cert: second.certPem
    });
    cleanups.push(async () => replay.close());
    await replay.ready();
    const response = await replay.enroll(token, second.raw);
    expect(response.status).toBe(403);
    expect(response.body['error']).toBe('token-used');
    expect(relay.registry.peerCount).toBe(1);
  });

  it('accepts an invite minted by the CLI while the relay is already running', async () => {
    const relay = await startRelay();
    const box = makeBox();

    // What `garden-relay invite` does: a separate process opens the same registry file, appends an
    // invite and closes. The running relay has never seen it.
    const cli = await Registry.open({
      path: relay.config.registryPath,
      relayDomain: RELAY_DOMAIN,
      maxPeers: relay.config.limits.global.maxPeers,
      registrationEnabled: true,
      defaultQuota: {
        monthlyBytes: relay.config.limits.perPeer.monthlyBytes,
        maxConcurrentStreams: relay.config.limits.perPeer.concurrentStreams,
        rateBps: relay.config.limits.perPeer.rateBps
      },
      flushIntervalMs: 3_600_000
    });
    const { token } = cli.createInvite('minted-while-running', 60_000);
    await cli.close();

    await connectBox(relay, box, token);
    expect(relay.server.onlineLabels).toEqual([box.label]);

    // And the enrollment it just recorded survives the relay's own next write.
    await relay.registry.flush(true);
    const persisted = JSON.parse(await readFile(relay.config.registryPath, 'utf8')) as unknown as {
      peers: { label: string }[];
      invites: { usedAt: number | null }[];
    };
    expect(persisted.peers.map((peer) => peer.label)).toEqual([box.label]);
    expect(persisted.invites.every((invite) => invite.usedAt !== null)).toBe(true);
  });

  it('drops a live session when a peer is revoked in the registry file', async () => {
    const relay = await startRelay();
    const box = makeBox();
    const { token } = relay.registry.createInvite('external-revoke', 60_000);
    await connectBox(relay, box, token);
    await relay.registry.flush(true);

    const cli = await Registry.open({
      path: relay.config.registryPath,
      relayDomain: RELAY_DOMAIN,
      maxPeers: relay.config.limits.global.maxPeers,
      registrationEnabled: true,
      defaultQuota: {
        monthlyBytes: relay.config.limits.perPeer.monthlyBytes,
        maxConcurrentStreams: relay.config.limits.perPeer.concurrentStreams,
        rateBps: relay.config.limits.perPeer.rateBps
      },
      flushIntervalMs: 3_600_000
    });
    expect(cli.revoke(box.label)).toBe(true);
    await cli.close();

    await relay.registry.syncFromDisk();
    await waitFor(() => relay.server.onlineLabels.length === 0);
    expect(relay.registry.peerByLabel(box.label)).toBeUndefined();
  });

  it('rejects a byte-for-byte replay of a recorded control connection', async () => {
    const relay = await startRelay();
    const box = makeBox();
    const { token } = relay.registry.createInvite('replay', 60_000);

    // A tap in front of the relay that records everything the box sends towards it.
    const recorded: Buffer[] = [];
    const tap = createServer((downstream) => {
      const upstream = createConnection({
        host: '127.0.0.1',
        port: relay.server.controlPort ?? 0
      });
      downstream.on('data', (chunk: Buffer) => {
        recorded.push(chunk);
        upstream.write(chunk);
      });
      upstream.on('data', (chunk: Buffer) => downstream.write(chunk));
      downstream.on('error', () => undefined);
      upstream.on('error', () => undefined);
      downstream.on('close', () => upstream.destroy());
      upstream.on('close', () => downstream.destroy());
    });
    await new Promise<void>((resolve) => tap.listen(0, '127.0.0.1', () => resolve()));
    const tapAddress = tap.address();
    const tapPort = tapAddress !== null && typeof tapAddress === 'object' ? tapAddress.port : 0;
    cleanups.push(async () => {
      tap.close();
    });

    const client = new BoxHarness({
      host: '127.0.0.1',
      port: tapPort,
      controlHost: RELAY_DOMAIN,
      key: box.keyPem,
      cert: box.certPem
    });
    cleanups.push(async () => client.close());
    await client.ready();
    expect((await client.enroll(token, box.raw)).status).toBe(200);
    await client.start();
    expect(relay.server.onlineLabels).toEqual([box.label]);

    const rejectedBefore = relay.metrics.read(METRIC_NAMES.sessionsRejected);
    const tunnelBefore = relay.server.tunnelFor(box.label);
    const captured = Buffer.concat(recorded);
    expect(captured.length).toBeGreaterThan(0);

    // Replay the exact bytes, including the ClientHello, the client Certificate and the
    // CertificateVerify. TLS 1.3 signs the handshake transcript, which includes the relay's fresh
    // ServerHello random and key share, so the recording is worthless against a new session.
    const closed = await new Promise<boolean>((resolve) => {
      const socket = createConnection(
        { host: '127.0.0.1', port: relay.server.controlPort ?? 0 },
        () => socket.write(captured)
      );
      // Drain: a socket that never reads would not observe the close behind the relay's response.
      socket.on('data', () => undefined);
      socket.on('error', () => undefined);
      socket.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 10_000);
    });

    // Refused, and the TCP socket underneath goes with it rather than lingering.
    expect(closed).toBe(true);
    expect(relay.metrics.read(METRIC_NAMES.sessionsRejected)).toBeGreaterThan(rejectedBefore);
    // The strongest available statement that the replay never authenticated: a session that had
    // authenticated would have displaced the live tunnel for this label, and it did not.
    expect(relay.server.onlineLabels).toEqual([box.label]);
    expect(relay.server.tunnelFor(box.label)).toBe(tunnelBefore);
  }, 20_000);

  it('drops a peer immediately on revoke', async () => {
    const relay = await startRelay();
    const box = makeBox();
    const { token } = relay.registry.createInvite('revoke', 60_000);
    await connectBox(relay, box, token);

    expect(relay.server.revoke(box.label)).toBe(true);
    await waitFor(() => relay.server.onlineLabels.length === 0);
    const { received } = await probe(relay.httpsPort, `${box.label}.${RELAY_DOMAIN}`);
    expect(received.equals(TLS_ALERT_UNRECOGNIZED_NAME)).toBe(true);
  });
});

describe('abuse resistance', () => {
  it('is not an open proxy: an arbitrary SNI is refused, not dialled', async () => {
    const relay = await startRelay();
    const { sent, received } = await probe(relay.httpsPort, 'example.com');
    expect(received.equals(TLS_ALERT_UNRECOGNIZED_NAME)).toBe(true);
    // Seven bytes out for a full ClientHello in: no amplification to be had here.
    expect(received.length).toBeLessThan(sent);
    expect(relay.metrics.read(METRIC_NAMES.unknownLabel)).toBe(1);
  });

  it('answers an unknown but well formed label with unrecognized_name', async () => {
    const relay = await startRelay();
    const stranger = makeBox();
    const { received } = await probe(relay.httpsPort, `${stranger.label}.${RELAY_DOMAIN}`);
    expect(received.equals(TLS_ALERT_UNRECOGNIZED_NAME)).toBe(true);
  });

  it('closes a connection that never sends a ClientHello', async () => {
    const relay = await startRelay({ handshakeTimeoutMs: 500 });
    const started = Date.now();
    const socket = createConnection({ host: '127.0.0.1', port: relay.httpsPort });
    socket.on('error', () => undefined);
    await once(socket, 'close');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(relay.metrics.read(METRIC_NAMES.handshakeTimeouts)).toBe(1);
  });

  it('rate limits new connections per source address', async () => {
    const relay = await startRelay({
      handshakeTimeoutMs: 5000,
      limits: { perSourceIp: { newConnPerMinute: 2, burst: 2 } }
    });
    const sockets = Array.from({ length: 6 }, () => {
      const socket = createConnection({ host: '127.0.0.1', port: relay.httpsPort });
      socket.on('error', () => undefined);
      return socket;
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
    });
    await waitFor(() => relay.metrics.read(METRIC_NAMES.rateLimited) >= 4);
    expect(relay.metrics.read(METRIC_NAMES.rateLimited)).toBe(4);
    expect(relay.metrics.read(METRIC_NAMES.connectionsAccepted)).toBe(2);
  });

  it('caps connections that are waiting for a ClientHello', async () => {
    const relay = await startRelay({
      handshakeTimeoutMs: 5000,
      limits: { global: { halfOpenPreSni: 16 } }
    });
    const sockets = Array.from({ length: 20 }, () => {
      const socket = createConnection({ host: '127.0.0.1', port: relay.httpsPort });
      socket.on('error', () => undefined);
      return socket;
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
    });
    await waitFor(() => relay.metrics.read(METRIC_NAMES.connectionsRejected) >= 4);
    expect(relay.metrics.read(METRIC_NAMES.connectionsAccepted)).toBe(16);
  });

  it('refuses more peers than maxPeers', async () => {
    const relay = await startRelay({ limits: { global: { maxPeers: 1 } } });
    const first = makeBox();
    const second = makeBox();
    await connectBox(relay, first, relay.registry.createInvite('a', 60_000).token);

    const client = new BoxHarness({
      host: '127.0.0.1',
      port: relay.server.controlPort ?? 0,
      controlHost: RELAY_DOMAIN,
      key: second.keyPem,
      cert: second.certPem
    });
    cleanups.push(async () => client.close());
    await client.ready();
    const response = await client.enroll(
      relay.registry.createInvite('b', 60_000).token,
      second.raw
    );
    expect(response.status).toBe(403);
    expect(response.body['error']).toBe('peer-limit-reached');
  });

  it('refuses enrollment entirely when registration is closed', async () => {
    const relay = await startRelay({ registrationEnabled: false });
    const box = makeBox();
    const client = new BoxHarness({
      host: '127.0.0.1',
      port: relay.server.controlPort ?? 0,
      controlHost: RELAY_DOMAIN,
      key: box.keyPem,
      cert: box.certPem
    });
    cleanups.push(async () => client.close());
    await client.ready();
    const response = await client.enroll('arly1_whatever', box.raw);
    expect(response.status).toBe(403);
    expect(response.body['error']).toBe('registration-disabled');
  });
});

describe('quotas', () => {
  it('shapes at 100% and refuses new connections at 150%', async () => {
    const relay = await startRelay({ defaultPeerQuota: { monthlyBytes: 1024 * 1024 } });
    const box = makeBox();
    const { token } = relay.registry.createInvite('quota', 60_000);
    const connected = await connectBox(relay, box, token);
    const tunnel = relay.server.tunnelFor(box.label);
    expect(tunnel?.state).toBe('ok');

    relay.registry.recordUsage(box.label, 1024 * 1024);
    const shaped = connectTls({
      host: '127.0.0.1',
      port: relay.httpsPort,
      servername: `${box.label}.${RELAY_DOMAIN}`,
      rejectUnauthorized: false
    });
    cleanups.push(async () => {
      shaped.destroy();
    });
    await once(shaped, 'secureConnect');
    expect(tunnel?.state).toBe('shaped');
    await waitFor(() =>
      connected.harness.messages.some(
        (message) => message.t === 'quota' && message.state === 'shaped'
      )
    );

    // Past 150% the peer stops accepting new connections altogether.
    relay.registry.recordUsage(box.label, 1024 * 1024);
    const { received } = await probe(relay.httpsPort, `${box.label}.${RELAY_DOMAIN}`);
    expect(received.equals(TLS_ALERT_UNRECOGNIZED_NAME)).toBe(true);
    expect(tunnel?.state).toBe('blocked');
    expect(relay.metrics.read(METRIC_NAMES.quotaBlocked)).toBe(1);
  });

  it('refuses every peer once the relay itself is out of budget', async () => {
    const relay = await startRelay({ limits: { global: { monthlyBytes: 1024 * 1024 } } });
    const box = makeBox();
    const { token } = relay.registry.createInvite('global', 60_000);
    await connectBox(relay, box, token);

    relay.registry.recordUsage(box.label, 2 * 1024 * 1024);
    const { received } = await probe(relay.httpsPort, `${box.label}.${RELAY_DOMAIN}`);
    expect(received.equals(TLS_ALERT_UNRECOGNIZED_NAME)).toBe(true);
    expect(relay.metrics.read(METRIC_NAMES.quotaBlocked)).toBe(1);
  });

  it('caps concurrent relayed streams per peer', async () => {
    const relay = await startRelay({
      parkTarget: 8,
      limits: { perPeer: { concurrentStreams: 2 } }
    });
    const box = makeBox();
    const { token } = relay.registry.createInvite('streams', 60_000);
    await connectBox(relay, box, token);

    const opened: TLSSocket[] = [];
    for (let index = 0; index < 2; index += 1) {
      const client = connectTls({
        host: '127.0.0.1',
        port: relay.httpsPort,
        servername: `${box.label}.${RELAY_DOMAIN}`,
        rejectUnauthorized: false
      });
      await once(client, 'secureConnect');
      opened.push(client);
    }
    cleanups.push(async () => {
      for (const client of opened) client.destroy();
    });
    expect(relay.server.tunnelFor(box.label)?.activeCount).toBe(2);

    const { received } = await probe(relay.httpsPort, `${box.label}.${RELAY_DOMAIN}`);
    expect(received.equals(TLS_ALERT_UNRECOGNIZED_NAME)).toBe(true);
    expect(relay.metrics.read(METRIC_NAMES.rateLimited)).toBeGreaterThan(0);
  });

  it('rate limits how fast a peer can be handed new streams', async () => {
    const relay = await startRelay({ limits: { perPeer: { newStreamsPerMinute: 1 } } });
    const box = makeBox();
    const { token } = relay.registry.createInvite('stream-rate', 60_000);
    await connectBox(relay, box, token);

    const first = connectTls({
      host: '127.0.0.1',
      port: relay.httpsPort,
      servername: `${box.label}.${RELAY_DOMAIN}`,
      rejectUnauthorized: false
    });
    cleanups.push(async () => {
      first.destroy();
    });
    await once(first, 'secureConnect');

    const { received } = await probe(relay.httpsPort, `${box.label}.${RELAY_DOMAIN}`);
    expect(received.equals(TLS_ALERT_UNRECOGNIZED_NAME)).toBe(true);
  });
});

describe('client address logging', () => {
  const captureLogs = (): { logger: Logger; lines: Record<string, unknown>[] } => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        lines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
        callback();
      }
    });
    return { logger: createLogger({ level: 'info', stream }), lines };
  };

  const relayOnce = async (logClientIps: boolean): Promise<Record<string, unknown>[]> => {
    const capture = captureLogs();
    const relay = await startRelay({ logClientIps }, capture.logger);
    const box = makeBox();
    await connectBox(relay, box, relay.registry.createInvite('logs', 60_000).token);
    const client = connectTls({
      host: '127.0.0.1',
      port: relay.httpsPort,
      servername: `${box.label}.${RELAY_DOMAIN}`,
      rejectUnauthorized: false
    });
    cleanups.push(async () => {
      client.destroy();
    });
    await once(client, 'secureConnect');
    return capture.lines;
  };

  it('keeps client addresses out of the log by default', async () => {
    const lines = await relayOnce(false);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain('127.0.0.1');
    expect(lines.some((line) => line['msg'] === 'relayed')).toBe(false);
  });

  it('records the bind at info level when the operator opts in, so `abuse` can use it', async () => {
    const lines = await relayOnce(true);
    const relayed = lines.find((line) => line['msg'] === 'relayed');
    expect(relayed).toBeDefined();
    expect(relayed?.['ip']).toBe('127.0.0.1');
    expect(typeof relayed?.['cid']).toBe('string');
    expect(relayed?.['level']).toBe('info');
  });
});

describe('metrics', () => {
  it('exposes counters on the localhost-only port', async () => {
    const relay = await startRelay();
    const port = relay.server.metricsPort ?? 0;
    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.write('GET /metrics HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      });
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', () => undefined);
    });
    expect(body).toContain(METRIC_NAMES.connectionsAccepted);
    expect(body).toContain(METRIC_NAMES.peersRegistered);
  });
});
