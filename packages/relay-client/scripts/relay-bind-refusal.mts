/** A pinned relay can still send untrusted bind frames; none may open arbitrary local ports. */
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer as createHttp2Server,
  type ServerHttp2Session,
  type ServerHttp2Stream
} from 'node:http2';
import { mkdtemp, rm } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import {
  CONTROL_ALPN,
  encodeCbor,
  createSelfSignedCertificate,
  generateIdentityKeyPair
} from '@garden/relay';
import { RelayClientConfigSchema, RelayConnection, loadOrCreateIdentity } from '../src/index.js';

const directory = await mkdtemp(join(tmpdir(), 'garden-relay-bind-'));
const certificate = createSelfSignedCertificate({
  privateKey: generateIdentityKeyPair().privateKey,
  commonName: 'relay.example',
  dnsNames: ['relay.example']
});
const fingerprint = createHash('sha256')
  .update(
    new X509Certificate(certificate.certPem).publicKey.export({ type: 'spki', format: 'der' })
  )
  .digest('base64');
const bodies = [
  encodeCbor({ port: 22 }),
  encodeCbor({ port: 4400 }),
  encodeCbor({ port: '443' }),
  encodeCbor(null),
  Buffer.from([0xff])
];
assert.ok(bodies.length > 0);
let closed = 0;
let index = 0;
let localDials = 0;
let refusals = 0;
let controlStream: ServerHttp2Stream | undefined;
const sessions = new Set<ServerHttp2Session>();
const h2 = createHttp2Server();
h2.on('session', (session) => {
  sessions.add(session);
  session.on('error', () => {});
  session.on('close', () => sessions.delete(session));
});
h2.on('stream', (stream, headers) => {
  stream.on('error', () => {});
  stream.respond({ ':status': 200 });
  if (headers[':path'] === '/v1/control') {
    controlStream = stream;
    stream.on('data', () => {});
    // Malformed capabilities must be treated as unavailable without crashing the control client.
    stream.write(
      `${JSON.stringify({ t: 'welcome', label: 'fixture', caps: {}, previewPort: 8443, parkTarget: 1, serverTimeMs: Date.now(), limits: {} })}\n`
    );
    return;
  }
  assert.equal(headers[':path'], '/v1/park');
  const body = bodies[index++];
  stream.once('data', () => {
    if (!body) return;
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    stream.once('close', () => {
      closed += 1;
    });
    stream.write(Buffer.concat([header, body]));
  });
});
const tls = createTlsServer(
  { key: certificate.keyPem, cert: certificate.certPem, ALPNProtocols: [CONTROL_ALPN] },
  (socket) => h2.emit('connection', socket)
);
let connection: RelayConnection | undefined;
try {
  tls.listen(0, '127.0.0.1');
  await once(tls, 'listening');
  const address = tls.address();
  assert.ok(address && typeof address === 'object');
  connection = new RelayConnection({
    config: RelayClientConfigSchema.parse({
      enabled: true,
      host: 'relay.example',
      address: '127.0.0.1',
      port: address.port,
      label: 'fixture',
      pinnedRelaySpkiSha256: fingerprint
    }),
    identity: await loadOrCreateIdentity(directory),
    connectLocal: () => {
      localDials += 1;
      return new Socket();
    },
    logger: (_level, message) => {
      if (message.startsWith('relay stream refused:')) refusals += 1;
    }
  });
  connection.start();
  const deadline = Date.now() + 8000;
  while (closed < bodies.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(localDials, 0, 'untrusted bind frames must not dial any local listener');
  assert.equal(
    closed,
    bodies.length,
    'each invalid bind must be closed without ending the control connection'
  );
  assert.equal(refusals, bodies.length);
  assert.equal(connection.status.state, 'online');
  assert.match(connection.status.lastError ?? '', /does not serve isolated app previews/);
  assert.equal(connection.status.previewPort, null);
  assert.ok(controlStream);
  controlStream.write('null\n');
  const invalidDeadline = Date.now() + 2000;
  while (connection.status.state === 'online' && Date.now() < invalidDeadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(connection.status.state, 'waiting');
  assert.equal(connection.status.lastError, 'relay sent an invalid control frame');

  console.log(
    'ok: malformed and unknown bind frames are refused; legacy relay preview limitation is visible'
  );
} finally {
  connection?.stop();
  for (const session of sessions) session.destroy();
  h2.close();
  await new Promise<void>((resolve) => tls.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
