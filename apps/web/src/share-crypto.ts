import type { ShareBlob, ShareSnapshot } from '@garden/contracts';

export const SHARE_BOUNDS = {
  snapshotBytes: 8 * 1024 * 1024,
  artifactBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  artifacts: 50
} as const;
const compressedSnapshotLimit = SHARE_BOUNDS.snapshotBytes + 64 * 1024;

export interface ShareKey {
  token: string;
  key: CryptoKey;
  context: string;
}
export interface OpenedShare {
  snapshot: ShareSnapshot;
  blob: ShareBlob;
  access: ShareKey;
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('This link contains an invalid encrypted snapshot.');
  return value as Record<string, unknown>;
};

const decode = (value: unknown, maximum: number): Uint8Array<ArrayBuffer> => {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 + 4)
    throw new Error('The encrypted content exceeds its size limit.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('The encrypted content is malformed.');
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('The encrypted content is malformed.');
  }
  if (bytes.length > maximum) throw new Error('The encrypted content exceeds its size limit.');
  return bytes;
};

export const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

export async function readShareKey(pathname: string, fragment: string): Promise<ShareKey> {
  const token = /^\/v1\/shares\/([A-Za-z0-9_-]{22})\/?$/.exec(pathname)?.[1];
  const encoded = /^#1\.([A-Za-z0-9_-]{43})$/.exec(fragment)?.[1];
  if (!token || !encoded)
    throw new Error('This link is incomplete. Ask for the full link, including the part after #.');
  const bytes = decode(encoded.replace(/-/g, '+').replace(/_/g, '/') + '=', 32);
  if (bytes.length !== 32) throw new Error('The key in this link is invalid.');
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
  bytes.fill(0);
  return { token, key, context: `share:${await sha256Hex(new TextEncoder().encode(token))}` };
}

export async function readBoundedBytes(
  response: Response,
  maximum: number
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maximum) throw new Error('This content exceeds the share size limit.');
  if (!response.body) throw new Error('This shared content is empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > maximum) throw new Error('This content exceeds the share size limit.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function openEnvelope(
  envelope: unknown,
  ciphertext: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  context: string
): Promise<Uint8Array<ArrayBuffer>> {
  const fields = record(envelope);
  if (fields.v !== 1 || (fields.aad !== undefined && fields.aad !== context))
    throw new Error('This encrypted content does not belong to this link.');
  const iv = decode(fields.iv, 12);
  const tag = decode(fields.tag, 16);
  if (iv.length !== 12 || tag.length !== 16) throw new Error('The encrypted content is malformed.');
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext);
  sealed.set(tag, ciphertext.length);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, tagLength: 128, additionalData: new TextEncoder().encode(context) },
        key,
        sealed
      )
    );
  } catch {
    throw new Error(
      'This link could not be decrypted. Its key or encrypted content may be incomplete.'
    );
  }
}

const eventKinds = new Set([
  'user_message',
  'assistant_message',
  'assistant_reasoning',
  'plan',
  'status',
  'tool_started',
  'tool_result',
  'question_asked',
  'approval_requested',
  'approval_resolved',
  'notice',
  'warning',
  'error',
  'completed'
]);

const validateSnapshot = (value: unknown): ShareSnapshot => {
  const source = record(value);
  if (
    source.v !== 1 ||
    typeof source.title !== 'string' ||
    typeof source.createdAt !== 'string' ||
    !Array.isArray(source.events) ||
    !Array.isArray(source.artifacts) ||
    source.artifacts.length > SHARE_BOUNDS.artifacts
  )
    throw new Error('This shared snapshot has an unsupported format.');
  for (const item of source.events) {
    const event = record(item);
    if (
      typeof event.kind !== 'string' ||
      !eventKinds.has(event.kind) ||
      typeof event.at !== 'string' ||
      typeof event.text !== 'string'
    )
      throw new Error('This shared snapshot contains an invalid event.');
  }
  const seen = new Set<number>();
  let bytes = 0;
  for (const item of source.artifacts) {
    const artifact = record(item);
    if (
      typeof artifact.n !== 'number' ||
      !Number.isSafeInteger(artifact.n) ||
      artifact.n < 0 ||
      seen.has(artifact.n) ||
      typeof artifact.name !== 'string' ||
      typeof artifact.mimeType !== 'string' ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      typeof artifact.sizeBytes !== 'number' ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes < 0 ||
      artifact.sizeBytes > SHARE_BOUNDS.artifactBytes
    )
      throw new Error('This shared snapshot contains an invalid file.');
    seen.add(artifact.n);
    bytes += artifact.sizeBytes;
  }
  if (bytes > SHARE_BOUNDS.totalBytes) throw new Error('The files exceed the share size limit.');
  return source as ShareSnapshot;
};

export async function decryptShare(blob: unknown, access: ShareKey): Promise<OpenedShare> {
  const source = record(blob);
  const envelope = record(source.envelope);
  if (
    !Number.isSafeInteger(source.version) ||
    Number(source.version) < 1 ||
    !Array.isArray(source.manifest) ||
    source.manifest.length > SHARE_BOUNDS.artifacts
  )
    throw new Error('This encrypted snapshot has an unsupported format.');
  const zipped = await openEnvelope(
    envelope,
    decode(envelope.ciphertext, compressedSnapshotLimit),
    access.key,
    access.context
  );
  const inflated = new Response(
    new Blob([zipped]).stream().pipeThrough(new DecompressionStream('gzip'))
  );
  const plaintext = await readBoundedBytes(inflated, SHARE_BOUNDS.snapshotBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown;
  } catch {
    throw new Error('This shared snapshot could not be read.');
  }
  const snapshot = validateSnapshot(value);
  const seen = new Set<number>();
  for (const item of source.manifest) {
    const entry = record(item);
    const artifact = snapshot.artifacts.find((file) => file.n === entry.n);
    if (!artifact || seen.has(artifact.n) || entry.sizeBytes !== artifact.sizeBytes)
      throw new Error('The shared file manifest does not match the snapshot.');
    record(entry.envelope);
    seen.add(artifact.n);
  }
  if (
    seen.size !== snapshot.artifacts.length ||
    plaintext.length + snapshot.artifacts.reduce((sum, file) => sum + file.sizeBytes, 0) >
      SHARE_BOUNDS.totalBytes
  )
    throw new Error('The shared file manifest is incomplete or exceeds its size limit.');
  return { snapshot, blob: source as unknown as ShareBlob, access };
}

async function publicFetch(path: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(path, {
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    ...(signal ? { signal } : {})
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'This server is busy. Please try the link again shortly.'
        : 'This link is unavailable. It may have expired or been closed.'
    );
  return response;
}

export async function loadShare(
  pathname: string,
  fragment: string,
  signal?: AbortSignal
): Promise<OpenedShare> {
  const access = await readShareKey(pathname, fragment);
  const response = await publicFetch(`/v1/shares/${access.token}/blob`, signal);
  const bytes = await readBoundedBytes(response, 12 * 1024 * 1024);
  return decryptShare(JSON.parse(new TextDecoder().decode(bytes)) as unknown, access);
}

export async function decryptShareArtifact(
  opened: OpenedShare,
  index: number,
  ciphertext: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const file = opened.snapshot.artifacts.find((artifact) => artifact.n === index);
  const manifest = opened.blob.manifest.find((artifact) => artifact.n === index);
  if (!file || !manifest || ciphertext.length !== file.sizeBytes)
    throw new Error('This shared file is incomplete.');
  const bytes = await openEnvelope(
    manifest.envelope,
    ciphertext,
    opened.access.key,
    `${opened.access.context}:artifact:${index}`
  );
  if (bytes.length !== file.sizeBytes || (await sha256Hex(bytes)) !== file.sha256)
    throw new Error('This shared file did not pass its integrity check.');
  return bytes;
}

export async function loadShareArtifact(
  opened: OpenedShare,
  index: number,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  const file = opened.snapshot.artifacts.find((artifact) => artifact.n === index);
  if (!file) throw new Error('This file is not part of the shared snapshot.');
  const response = await publicFetch(
    `/v1/shares/${opened.access.token}/artifacts/${index}`,
    signal
  );
  return decryptShareArtifact(opened, index, await readBoundedBytes(response, file.sizeBytes));
}
