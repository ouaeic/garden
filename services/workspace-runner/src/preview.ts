import { z } from 'zod';
import { connect } from 'node:net';
import { assertPublishablePort } from '@garden/core';

const PreviewPort = z.coerce.number().int().min(1024).max(65_535);

/**
 * Publishing a preview points the public internet at a loopback port, so the question is not
 * whether the port is the runner's own but whether garden is already serving something private
 * there. The reserved set is every port this installation binds - the API, the preview gateway,
 * the database, the service health endpoints - which the runner is told rather than guesses,
 * because they are all configurable. The gateway ahead of it applies the same set, so a preview
 * that skipped one layer still meets the other.
 */
export const previewPort = (value: unknown, reserved: ReadonlySet<number> = new Set()): number => {
  const port = PreviewPort.parse(value);
  assertPublishablePort(port, reserved);
  return port;
};

export const checkPreviewPort = async (
  value: unknown,
  reserved?: ReadonlySet<number>,
  timeoutMs = 1500
): Promise<boolean> => {
  const port = previewPort(value, reserved);
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (available: boolean) => {
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
};

export const previewTarget = (
  portValue: unknown,
  pathValue: unknown,
  rawUrl: string,
  reserved?: ReadonlySet<number>
): URL => {
  const port = previewPort(portValue, reserved);
  const path = typeof pathValue === 'string' ? pathValue : '';
  const target = new URL(`http://127.0.0.1:${port}/${path}`);
  target.search = new URL(rawUrl, 'http://workspace.invalid').search;
  return target;
};

const blockedHeaders = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

export const previewRequestHeaders = (
  headers: Record<string, string | string[] | undefined>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers)
      .filter(([name, value]) => value !== undefined && !blockedHeaders.has(name.toLowerCase()))
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)])
  );

export const previewResponseHeaders = (headers: Headers): Array<[string, string]> => {
  const result: Array<[string, string]> = [];
  for (const [name, value] of headers) {
    if (!blockedHeaders.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie')
      result.push([name, value]);
  }
  const cookies = headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) result.push(['set-cookie', cookie]);
  return result;
};
