import { describe, expect, it } from 'vitest';
import { reservedPreviewPorts } from '@garden/core';
import { previewPort, previewRequestHeaders, previewTarget } from './preview.js';

describe('workspace preview proxy policy', () => {
  it('targets only a validated loopback port', () => {
    expect(previewTarget('3000', 'assets/app.js', '/assets/app.js?v=1').toString()).toBe(
      'http://127.0.0.1:3000/assets/app.js?v=1'
    );
    expect(() => previewPort(80)).toThrow();
    expect(() => previewPort(65_536)).toThrow();
  });

  it('refuses to publish any port garden itself is serving on', () => {
    // Publishing points the public internet at a loopback port. Refusing only the runner's own
    // port left the API, the preview gateway, the database and the service health endpoints
    // selectable by a tool call the agent chooses the argument for.
    const reserved = reservedPreviewPorts({
      ports: [4300, 4100, 4201, 4202, 4203],
      urls: ['postgres://garden@127.0.0.1:5432/garden', 'http://127.0.0.1:4400']
    });
    for (const port of [4300, 4100, 4400, 5432, 4201, 4202, 4203])
      expect(() => previewPort(port, reserved)).toThrow('belongs to this server');
    expect(() => previewTarget(4100, '', '/', reserved)).toThrow('belongs to this server');
    expect(previewPort(3000, reserved)).toBe(3000);
  });

  it('never forwards the runner capability or websocket handshake secret', () => {
    expect(
      previewRequestHeaders({
        authorization: 'Bearer runner-secret',
        host: 'runner.internal',
        cookie: 'app_session=user-cookie',
        accept: 'text/html',
        'sec-websocket-protocol': 'garden-capability, secret'
      })
    ).toEqual({ cookie: 'app_session=user-cookie', accept: 'text/html' });
  });
});
