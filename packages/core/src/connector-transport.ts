import { lookup as resolveDns } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { AthanorError } from './errors.js';
import { hostMatchesSuffix, isPublicInternetAddress } from './network-scope.js';

export interface ConnectorRequestInput {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  allowedHostSuffixes: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  signal?: AbortSignal;
}

export interface ConnectorRequestResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  durationMs: number;
}

export type ConnectorTransport = (input: ConnectorRequestInput) => Promise<ConnectorRequestResult>;

/**
 * A connector endpoint is a public internet host by the same definition everything else here uses;
 * kept as a named export because that is what the connector error messages talk about.
 */
export const isPublicConnectorAddress = isPublicInternetAddress;

export const assertConnectorUrl = (url: URL, allowedHostSuffixes: string[]): void => {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !hostMatchesSuffix(url.hostname.toLowerCase(), allowedHostSuffixes)
  ) {
    throw new AthanorError(
      'connector_url_not_allowed',
      'Connector endpoints must use an approved, credential-free HTTPS host on port 443'
    );
  }
};

/** The deadline covers DNS and the complete response, including a peer that keeps sending data. */
export const secureConnectorRequest: ConnectorTransport = async (input) => {
  assertConnectorUrl(input.url, input.allowedHostSuffixes);
  const body = input.body ? Buffer.from(input.body) : undefined;
  const maxRequestBytes = input.maxRequestBytes ?? 1_000_000;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 40_000_000)
    throw new AthanorError('connector_request_invalid', 'Invalid connector transfer bounds');
  if (body && body.byteLength > maxRequestBytes)
    throw new AthanorError(
      'connector_request_too_large',
      'Connector request exceeds its transfer limit'
    );
  const timeoutMs = input.timeoutMs ?? 15_000;
  const maxResponseBytes = input.maxResponseBytes ?? 1_000_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1
  )
    throw new AthanorError('connector_request_invalid', 'Invalid connector transfer bounds');
  const started = Date.now();
  return new Promise<ConnectorRequestResult>((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    const cleanup = () => {
      clearTimeout(deadline);
      input.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      request?.destroy();
      response?.destroy();
      reject(
        error instanceof Error
          ? error
          : new AthanorError('connector_request_failed', 'Connector request failed')
      );
    };
    const abort = () =>
      fail(new AthanorError('connector_aborted', 'Connector request was cancelled'));
    const deadline = setTimeout(
      () => fail(new AthanorError('connector_timeout', 'Connector request timed out')),
      timeoutMs
    );
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) {
      abort();
      return;
    }
    void (async () => {
      const addresses = await resolveDns(input.url.hostname, { all: true, verbatim: true });
      // DNS lookup itself cannot be cancelled; its late result must never start a request.
      if (settled) return;
      if (!addresses.length || addresses.some((entry) => !isPublicConnectorAddress(entry.address)))
        throw new AthanorError(
          'connector_address_not_allowed',
          'Connector host did not resolve exclusively to public internet addresses'
        );
      const pinnedLookup = ((
        _hostname: string,
        options: { all?: boolean },
        callback: (...values: unknown[]) => void
      ) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      }) as unknown as LookupFunction;
      request = httpsRequest(
        input.url,
        {
          method: input.method,
          headers: {
            ...input.headers,
            ...(body ? { 'content-length': String(body.byteLength) } : {})
          },
          lookup: pinnedLookup,
          servername: input.url.hostname
        },
        (incoming) => {
          response = incoming;
          if (settled) {
            incoming.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            if (settled) return;
            size += chunk.byteLength;
            if (size > maxResponseBytes) {
              fail(
                new AthanorError(
                  'connector_response_too_large',
                  `Connector response exceeds ${maxResponseBytes} bytes`
                )
              );
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('error', fail);
          incoming.on('aborted', () =>
            fail(
              new AthanorError(
                'connector_response_incomplete',
                'Connector response ended before completion'
              )
            )
          );
          incoming.on('end', () => {
            if (settled) return;
            if (!incoming.complete) {
              fail(
                new AthanorError(
                  'connector_response_incomplete',
                  'Connector response ended before completion'
                )
              );
              return;
            }
            const status = incoming.statusCode ?? 502;
            if (status >= 300 && status < 400) {
              fail(
                new AthanorError(
                  'connector_redirect_blocked',
                  'Connector redirects are blocked to prevent credential forwarding'
                )
              );
              return;
            }
            const headers = Object.fromEntries(
              Object.entries(incoming.headers).map(([name, value]) => [
                name,
                Array.isArray(value) ? value.join(', ') : String(value ?? '')
              ])
            );
            settled = true;
            cleanup();
            resolve({
              status,
              headers,
              body: Buffer.concat(chunks),
              durationMs: Date.now() - started
            });
          });
        }
      );
      request.on('error', fail);
      if (body) request.write(body);
      request.end();
    })().catch(fail);
  });
};
