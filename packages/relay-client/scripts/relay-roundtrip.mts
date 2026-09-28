/**
 * End-to-end proof that a client reaches this box through a relay.
 *
 * It runs a real relay, enrolls a real identity, dials it with the real client, then behaves like a
 * phone: TLS to the relay's public port with the box's hostname in SNI. The handshake completes
 * against the box's own certificate, which is the property that matters - the relay moves bytes and
 * never holds a key for the box.
 *
 * This lives outside vitest because the suite's cross-package module runner wedges when it loads
 * the relay server's HTTP/2 and TLS code from another workspace package. The check is real either
 * way: `pnpm test` in this package runs it, and a non-zero exit fails the build.
 */
import { mkdtemp } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, connect as connectTls } from 'node:tls';
import {
  Metrics,
  Registry,
  RelayServer,
  createSelfSignedCertificate,
  generateIdentityKeyPair,
  parseRelayConfig,
  silentLogger
} from '@garden/relay';
import {
  RelayClientConfigSchema,
  RelayConnection,
  enroll,
  loadOrCreateIdentity
} from '../src/index.js';

process.on('uncaughtException', (e) => {
  console.error('FAILED, uncaught:', e);
  process.exit(3);
});
process.on('unhandledRejection', (e) => {
  console.error('FAILED, unhandled rejection:', e);
  process.exit(4);
});

const RELAY_DOMAIN = 'relay.example';
const dir = await mkdtemp(join(tmpdir(), 'relay-repro-'));
const { privateKey } = generateIdentityKeyPair();
const cert = createSelfSignedCertificate({
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
  tlsCertPath: 'x',
  tlsKeyPath: 'x',
  registryPath: join(dir, 'r.json'),
  pingIntervalMs: 60000
});
const registry = await Registry.open({
  path: config.registryPath,
  relayDomain: config.relayDomain,
  maxPeers: config.limits.global.maxPeers,
  registrationEnabled: config.registrationEnabled,
  defaultQuota: {
    monthlyBytes: config.limits.perPeer.monthlyBytes,
    maxConcurrentStreams: config.limits.perPeer.concurrentStreams,
    rateBps: config.limits.perPeer.rateBps
  }
});
const server = new RelayServer({
  config,
  registry,
  metrics: new Metrics(),
  logger: silentLogger,
  tlsCert: cert.certPem,
  tlsKey: cert.keyPem
});
await server.listen();
console.log('relay up: control', server.controlPort, 'https', server.httpsPort);

const identity = await loadOrCreateIdentity(dir);
const { token } = registry.createInvite('t', 600000);
const enrollment = await enroll(
  { host: RELAY_DOMAIN, address: '127.0.0.1', port: server.controlPort! },
  identity,
  token
);
console.log('enrolled:', enrollment.hostname);

const boxCert = createSelfSignedCertificate({
  privateKey: generateIdentityKeyPair().privateKey,
  commonName: enrollment.hostname,
  dnsNames: [enrollment.hostname]
});
const box = createTlsServer({ key: boxCert.keyPem, cert: boxCert.certPem }, (s) =>
  s.on('data', (c) => s.write(c.toString().toUpperCase()))
);
await new Promise<void>((r) => box.listen(0, '127.0.0.1', r));
const boxPort = (box.address() as any).port;

// The box's plaintext :80, which in a real installation is nginx serving the ACME challenge root
// and redirecting everything else. Relayed :80 has to land here and not on the TLS listener above.
const boxHttp = createHttpServer((request, response) => {
  response.setHeader('content-type', 'text/plain');
  response.end(`box-http ${request.url}`);
});
await new Promise<void>((r) => boxHttp.listen(0, '127.0.0.1', r));
const boxHttpPort = (boxHttp.address() as any).port;

const boxPreview = createTlsServer({ key: boxCert.keyPem, cert: boxCert.certPem }, (socket) =>
  socket.on('data', (chunk) => socket.write(`PREVIEW:${chunk.toString()}`))
);
await new Promise<void>((resolve) => boxPreview.listen(0, '127.0.0.1', resolve));
const boxPreviewPort = (boxPreview.address() as any).port;

const conn = new RelayConnection({
  config: RelayClientConfigSchema.parse({
    enabled: true,
    host: RELAY_DOMAIN,
    address: '127.0.0.1',
    port: server.controlPort!,
    label: enrollment.label,
    pinnedRelaySpkiSha256: enrollment.pinnedRelaySpkiSha256,
    localHost: '127.0.0.1',
    localPort: boxPort,
    localHttpPort: boxHttpPort,
    localPreviewPort: boxPreviewPort
  }),
  identity,
  logger: (l, m, f) => console.log('[relay-client]', l, m, JSON.stringify(f ?? {}))
});
conn.start();
for (let i = 0; i < 200 && conn.status.state !== 'online'; i++)
  await new Promise((r) => setTimeout(r, 50));
console.log('state:', conn.status.state, 'label:', conn.status.label);

const client = connectTls({
  host: '127.0.0.1',
  port: server.httpsPort!,
  servername: enrollment.hostname,
  rejectUnauthorized: false
});
const reply = await new Promise<string>((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), 8000);
  client.on('error', rej);
  client.once('secureConnect', () => client.write('hello through the relay'));
  client.once('data', (c) => {
    clearTimeout(t);
    res(c.toString());
  });
});
if (reply !== 'HELLO THROUGH THE RELAY') {
  console.error('FAILED: relay did not carry the bytes through, got', JSON.stringify(reply));
  process.exit(1);
}
console.log('ok: a real TLS client reached the box through the relay');

if (conn.status.lastError !== null)
  throw new Error(`Preview capability was not accepted: ${conn.status.lastError}`);
if (conn.status.previewPort !== server.previewPort)
  throw new Error('The negotiated preview port must match the actual public listener');
const previewClient = connectTls({
  host: '127.0.0.1',
  port: server.previewPort!,
  servername: enrollment.hostname,
  rejectUnauthorized: false
});
const previewReply = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('preview timeout')), 8000);
  previewClient.on('error', reject);
  previewClient.once('secureConnect', () => previewClient.write('a generated app'));
  previewClient.once('data', (chunk) => {
    clearTimeout(timer);
    resolve(chunk.toString());
  });
});
if (previewReply !== 'PREVIEW:a generated app')
  throw new Error(`Preview reached the wrong listener: ${previewReply}`);
previewClient.destroy();
console.log('ok: preview TLS reaches only the separate box preview listener');

// ACME HTTP-01 arrives this way: plaintext, on the relay's :80, routed on Host rather than SNI.
const challengePath = '/.well-known/acme-challenge/roundtrip';
const httpSocket = createConnection({ host: '127.0.0.1', port: server.httpPort! });
const httpReply = await new Promise<string>((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), 8000);
  const chunks: Buffer[] = [];
  httpSocket.on('error', rej);
  httpSocket.on('connect', () =>
    httpSocket.write(
      `GET ${challengePath} HTTP/1.1\r\nHost: ${enrollment.hostname}\r\nConnection: close\r\n\r\n`
    )
  );
  httpSocket.on('data', (c) => chunks.push(c));
  httpSocket.on('end', () => {
    clearTimeout(t);
    res(Buffer.concat(chunks).toString());
  });
});
if (!httpReply.includes(`box-http ${challengePath}`)) {
  console.error(
    'FAILED: relayed :80 did not reach the box HTTP listener, got',
    JSON.stringify(httpReply)
  );
  process.exit(2);
}
console.log('ok: a plaintext :80 request reached the box HTTP listener through the relay');

// A box going away is the ordinary case - `systemctl restart garden@api` does it - and the relay
// has to survive it for every other peer. Draining parked streams from inside nghttp2's own receive
// callback used to wedge the event loop right here: one restart pegged a core, climbed past a
// gigabyte resident in seconds, and took the relay down for everyone. The check is whether the
// process is still running afterwards, because that is exactly what stopped being true.
let ticks = 0;
const heartbeat = setInterval(() => {
  ticks += 1;
}, 20);
conn.stop();
await new Promise((resolve) => setTimeout(resolve, 500));
clearInterval(heartbeat);
if (ticks < 5) {
  console.error('FAILED: the relay wedged when the box disconnected; event loop ticks:', ticks);
  process.exit(6);
}
if (conn.status.state !== 'off') {
  console.error('FAILED: stopping left the connection in state', conn.status.state);
  process.exit(5);
}
console.log('ok: the relay survived the box disconnecting, and the connection is off');

client.destroy();
httpSocket.destroy();
if (conn.status.previewPort !== null)
  throw new Error('Stopped relay must not advertise a preview port');
box.close();
boxHttp.close();
boxPreview.close();
await server.close();
console.log('ok: clean shutdown');
process.exit(0);
