import { describe, expect, it } from 'vitest';
import { assertPublishablePort, reservedPreviewPorts } from './preview-ports.js';

describe('reserved preview ports', () => {
  const reserved = reservedPreviewPorts({
    ports: [4100, 4400, undefined],
    urls: ['http://127.0.0.1:4300', 'postgres://garden:pw@127.0.0.1:5432/garden', ''],
    additional: '4201, 4202,4203,not-a-port,'
  });

  it('collects every port this server binds, however it is configured', () => {
    expect([...reserved].sort((left, right) => left - right)).toEqual([
      4100, 4201, 4202, 4203, 4300, 4400, 5432
    ]);
  });

  it('refuses to publish a port belonging to garden itself', () => {
    for (const port of [4100, 4300, 4400, 5432])
      expect(() => assertPublishablePort(port, reserved)).toThrow(
        `Port ${port} belongs to this server's own services`
      );
    expect(() => assertPublishablePort(3000, reserved)).not.toThrow();
    expect(() => assertPublishablePort(8080, reserved)).not.toThrow();
  });
});
