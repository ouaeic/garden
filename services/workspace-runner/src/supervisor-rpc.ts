import { request as httpRequest } from 'node:http';

const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

/** A disconnected request must never determine the lifetime of the work it observes. */
export function supervisorRequest<T>(
  socket: string,
  secret: string,
  endpoint: '/rpc' | '/computation',
  input: unknown
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const body = JSON.stringify(input);
    const request = httpRequest(
      {
        socketPath: socket,
        path: endpoint,
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('Execution controller response exceeds limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              result?: T;
              error?: string;
            };
            if (response.statusCode !== 200)
              reject(new Error(result.error ?? 'Execution controller refused the request'));
            else resolve(result.result as T);
          } catch (cause) {
            reject(
              cause instanceof Error
                ? cause
                : new Error('Invalid execution controller response', { cause })
            );
          }
        });
      }
    );
    request.setTimeout(120_000, () =>
      request.destroy(new Error('Execution controller did not respond'))
    );
    request.on('error', reject);
    request.end(body);
  });
}
