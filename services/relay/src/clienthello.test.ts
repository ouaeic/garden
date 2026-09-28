import { createServer } from 'node:net';
import { connect } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { parseClientHello } from './clienthello.js';

/** Captures a genuine ClientHello produced by Node's TLS stack. */
const captureClientHello = (servername: string | null, alpn?: string[]): Promise<Buffer> =>
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
      const client = connect({
        host: '127.0.0.1',
        port: address.port,
        rejectUnauthorized: false,
        // Node omits SNI entirely when no servername is given and the host is an IP literal.
        ...(servername === null ? {} : { servername }),
        ...(alpn === undefined ? {} : { ALPNProtocols: alpn })
      });
      client.on('error', () => undefined);
    });
  });

describe('parseClientHello', () => {
  it('reads SNI and ALPN from a real ClientHello', async () => {
    const hello = await captureClientHello('label.relay.example', ['garden-relay/1']);
    const result = parseClientHello(hello);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.info.serverName).toBe('label.relay.example');
    expect(result.info.alpnProtocols).toEqual(['garden-relay/1']);
  });

  it('lowercases the SNI so routing is case insensitive', async () => {
    const hello = await captureClientHello('LABEL.Relay.Example');
    const result = parseClientHello(hello);
    expect(result.status === 'ok' && result.info.serverName).toBe('label.relay.example');
  });

  it('reassembles a ClientHello delivered one byte at a time', async () => {
    const hello = await captureClientHello('label.relay.example', ['h2']);
    let buffered = Buffer.alloc(0);
    let needMore = 0;
    for (const byte of hello) {
      buffered = Buffer.concat([buffered, Buffer.from([byte])]);
      const result = parseClientHello(buffered);
      if (result.status === 'need-more') {
        needMore += 1;
        continue;
      }
      expect(result.status).toBe('ok');
    }
    // It really was incomplete for almost the whole stream, i.e. the test is not trivially passing.
    expect(needMore).toBeGreaterThan(hello.length - 5);
    const final = parseClientHello(buffered);
    expect(final.status === 'ok' && final.info.serverName).toBe('label.relay.example');
  });

  it('reassembles a handshake message split across two TLS records', async () => {
    const hello = await captureClientHello('label.relay.example');
    const body = hello.subarray(5);
    const split = Math.floor(body.length / 2);
    const record = (payload: Buffer): Buffer => {
      const header = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00]);
      header.writeUInt16BE(payload.length, 3);
      return Buffer.concat([header, payload]);
    };
    const fragmented = Buffer.concat([
      record(body.subarray(0, split)),
      record(body.subarray(split))
    ]);
    // One record alone is not enough; both together are.
    expect(parseClientHello(record(body.subarray(0, split))).status).toBe('need-more');
    const result = parseClientHello(fragmented);
    expect(result.status === 'ok' && result.info.serverName).toBe('label.relay.example');
  });

  it('reports a ClientHello with no SNI rather than guessing', async () => {
    const hello = await captureClientHello(null);
    const result = parseClientHello(hello);
    expect(result.status === 'ok' && result.info.serverName).toBeNull();
  });

  it('ignores the compatibility ChangeCipherSpec that follows a TLS 1.3 ClientHello', async () => {
    const hello = await captureClientHello('label.relay.example');
    // RFC 8446 D.4: a TLS 1.3 client emits a dummy CCS right after the ClientHello, and a sender is
    // free to put it in the same TCP segment. Refusing that would break real clients at random.
    const changeCipherSpec = Buffer.from([0x14, 0x03, 0x03, 0x00, 0x01, 0x01]);
    const result = parseClientHello(Buffer.concat([hello, changeCipherSpec]));
    expect(result.status === 'ok' && result.info.serverName).toBe('label.relay.example');
  });

  it('rejects traffic that is not a TLS handshake', () => {
    expect(parseClientHello(Buffer.from('GET / HTTP/1.1\r\n')).status).toBe('invalid');
    const bogus = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]);
    expect(parseClientHello(bogus).status).toBe('invalid');
  });

  it('rejects an implausible record length instead of buffering for it', () => {
    expect(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff, 0x01])).status).toBe(
      'invalid'
    );
  });
});
