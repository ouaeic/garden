import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { isPublicHttpUrl, isPublicInternetAddress } from '@garden/core';

export const MAX_MEDIA_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_MEDIA_JSON_BYTES = 96 * 1024 * 1024;
const MAX_MEDIA_REDIRECTS = 4;

export const readBoundedMediaBody = async (
  response: Response,
  maxBytes = MAX_MEDIA_OUTPUT_BYTES
): Promise<Buffer> => {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > maxBytes) {
    await response.body?.cancel();
    throw new Error('The provider media output exceeds the download limit');
  }
  if (!response.body) throw new Error('The provider returned an empty media body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new Error('The provider media output exceeds the download limit');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error('The provider returned an empty media body');
  return Buffer.concat(chunks, total);
};

export const decodeMediaBase64 = (value: string, maxBytes = MAX_MEDIA_OUTPUT_BYTES): Buffer => {
  if (
    !value ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(value)
  )
    throw new Error('Invalid or oversized base64 media');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value)
    throw new Error('The provider media output exceeds the download limit');
  return bytes;
};

/** Pinned DNS keeps a provider-supplied URL from resolving differently when the socket opens. */
export const downloadMedia = async (
  rawUrl: string,
  signal: AbortSignal,
  redirects = 0
): Promise<{ bytes: Buffer; mimeType: string }> => {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !isPublicHttpUrl(url.href) || url.username || url.password)
    throw new Error('Media output used an unsafe download URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicInternetAddress(address)))
    throw new Error('Media output resolves to a private or reserved address');
  signal.throwIfAborted();
  const first = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        signal,
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, addresses);
          else callback(null, first.address, first.family);
        }
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          const location = response.headers.location;
          if (!location || redirects >= MAX_MEDIA_REDIRECTS) {
            reject(new Error('Media output exceeded the redirect limit'));
            return;
          }
          downloadMedia(new URL(location, url).href, signal, redirects + 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          reject(new Error(`Could not download generated media (${status})`));
          return;
        }
        if (Number(response.headers['content-length']) > MAX_MEDIA_OUTPUT_BYTES) {
          response.destroy();
          reject(new Error('The provider media output exceeds the download limit'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_MEDIA_OUTPUT_BYTES) {
            response.destroy(new Error('The provider media output exceeds the download limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          total
            ? resolve({
                bytes: Buffer.concat(chunks, total),
                mimeType: response.headers['content-type'] ?? 'application/octet-stream'
              })
            : reject(new Error('The provider returned an empty media body'))
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
};

const starts = (bytes: Buffer, prefix: number[]): boolean =>
  prefix.every((value, index) => bytes[index] === value);
export const mediaMimeType = (
  bytes: Buffer,
  declared: string,
  kind: 'image' | 'audio',
  pcm = false
): string => {
  const rawMime = declared.split(';')[0]!.trim().toLowerCase();
  const mime =
    (
      {
        'audio/x-wav': 'audio/wav',
        'audio/x-flac': 'audio/flac',
        'audio/opus': 'audio/ogg'
      } as Record<string, string>
    )[rawMime] ?? rawMime;
  let detected: string | undefined;
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) detected = 'image/png';
  else if (starts(bytes, [0xff, 0xd8, 0xff])) detected = 'image/jpeg';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    detected = 'image/webp';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE')
    detected = 'audio/wav';
  else if (bytes.toString('ascii', 0, 4) === 'fLaC') detected = 'audio/flac';
  else if (
    bytes.toString('ascii', 0, 4) === 'OggS' &&
    bytes.subarray(0, 128).includes(Buffer.from('OpusHead'))
  )
    detected = 'audio/ogg';
  else if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0) detected = 'audio/aac';
  else if (
    bytes.toString('ascii', 0, 3) === 'ID3' ||
    (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
  )
    detected = 'audio/mpeg';
  else if (
    pcm &&
    ['audio/pcm', 'application/octet-stream'].includes(mime) &&
    bytes.length > 0 &&
    bytes.length % 2 === 0
  )
    detected = 'audio/pcm';
  if (
    !detected ||
    !detected.startsWith(`${kind}/`) ||
    (mime !== 'application/octet-stream' && mime !== detected)
  )
    throw new Error('The provider media bytes do not match their declared format');
  return detected;
};
