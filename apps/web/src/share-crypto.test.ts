import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShareBlob, ShareSnapshot } from '@garden/contracts';
import {
  SHARE_BOUNDS,
  decryptShare,
  decryptShareArtifact,
  loadShare,
  readBoundedBytes,
  readShareKey
} from './share-crypto.js';

interface SealedSnapshot {
  id: string;
  key: Buffer;
  lookupHash: string;
  envelope: ShareBlob['envelope'];
  artifacts: Array<{
    n: number;
    sizeBytes: number;
    ciphertext: Buffer;
    envelopeMeta: ShareBlob['manifest'][number]['envelope'];
  }>;
}
// Production wire conformance crosses separate TypeScript root directories, so load the server at runtime.
const serverPath = fileURLToPath(new URL('../../api/src/share-snapshot.ts', import.meta.url));
const corePath = fileURLToPath(new URL('../../../packages/core/src/crypto.ts', import.meta.url));
const { sealShareSnapshot, shareUrl } = (await import(serverPath)) as {
  sealShareSnapshot: (input: {
    snapshot: ShareSnapshot;
    artifacts: Array<{ entry: ShareSnapshot['artifacts'][number]; bytes: Buffer }>;
  }) => SealedSnapshot;
  shareUrl: (id: string, key: Uint8Array) => string;
};
const { encryptBytes } = (await import(corePath)) as {
  encryptBytes: (plaintext: Uint8Array, key: Uint8Array, aad: string) => ShareBlob['envelope'];
};

const artifactBytes = Buffer.from('<!doctype html><h1>A real saved result</h1>');
const snapshot: ShareSnapshot = {
  v: 1,
  title: 'A scientific result',
  createdAt: '2026-09-06T00:00:00.000Z',
  events: [
    { kind: 'assistant_message', at: '2026-09-06T00:00:00.000Z', text: 'A result with $x^2$.' }
  ],
  artifacts: [
    {
      n: 0,
      name: 'result.html',
      mimeType: 'text/html',
      sizeBytes: artifactBytes.length,
      sha256: createHash('sha256').update(artifactBytes).digest('hex')
    }
  ]
};
const fixture = () => {
  const sealed = sealShareSnapshot({
    snapshot,
    artifacts: [{ entry: snapshot.artifacts[0]!, bytes: artifactBytes }]
  });
  const url = new URL(shareUrl(sealed.id, sealed.key), 'https://share.example');
  return {
    sealed,
    url,
    blob: {
      version: 1,
      envelope: sealed.envelope,
      manifest: sealed.artifacts.map((file) => ({
        n: file.n,
        sizeBytes: file.sizeBytes,
        envelope: file.envelopeMeta
      }))
    }
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('the public viewer and the server encryption contract', () => {
  it('opens bytes sealed by the production server and verifies a real artifact', async () => {
    const { sealed, url, blob } = fixture();
    expect(sealed.artifacts.length).toBeGreaterThan(0);
    const access = await readShareKey(url.pathname, url.hash);
    const opened = await decryptShare(blob, access);
    expect(opened.snapshot).toEqual(snapshot);
    await expect(
      decryptShareArtifact(opened, 0, new Uint8Array(sealed.artifacts[0]!.ciphertext))
    ).resolves.toEqual(new Uint8Array(artifactBytes));
  });

  it('never sends the fragment key, owner credentials, or a referrer in public reads', async () => {
    const { url, blob } = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(blob));
    vi.stubGlobal('fetch', fetcher);
    await loadShare(url.pathname, url.hash);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`${url.pathname}/blob`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(url.hash);
  });

  it('rejects another link context even with the same encryption key', async () => {
    const { sealed, blob } = fixture();
    const other = new URL(
      shareUrl(randomBytes(16).toString('base64url'), sealed.key),
      'https://share.example'
    );
    await expect(
      decryptShare(blob, await readShareKey(other.pathname, other.hash))
    ).rejects.toThrow('does not belong');
  });

  it('rejects altered ciphertext and refuses an artifact that fails its committed digest', async () => {
    const { sealed, url, blob } = fixture();
    const opened = await decryptShare(blob, await readShareKey(url.pathname, url.hash));
    const corrupted = new Uint8Array(sealed.artifacts[0]!.ciphertext);
    corrupted[0] = corrupted[0]! ^ 1;
    await expect(decryptShareArtifact(opened, 0, corrupted)).rejects.toThrow(
      'could not be decrypted'
    );
    const changed = {
      ...opened,
      snapshot: {
        ...opened.snapshot,
        artifacts: [{ ...opened.snapshot.artifacts[0]!, sha256: '0'.repeat(64) }]
      }
    };
    await expect(
      decryptShareArtifact(changed, 0, new Uint8Array(sealed.artifacts[0]!.ciphertext))
    ).rejects.toThrow('integrity check');
  });

  it('refuses a manifest that omits or duplicates the snapshot files', async () => {
    const { url, blob } = fixture();
    const access = await readShareKey(url.pathname, url.hash);
    await expect(decryptShare({ ...blob, manifest: [] }, access)).rejects.toThrow('incomplete');
    await expect(
      decryptShare({ ...blob, manifest: [...blob.manifest, ...blob.manifest] }, access)
    ).rejects.toThrow('does not match');
  });

  it('enforces the plaintext bound after decompressing authenticated ciphertext', async () => {
    const { sealed, url } = fixture();
    const envelope = encryptBytes(
      gzipSync(Buffer.alloc(SHARE_BOUNDS.snapshotBytes + 1, 32)),
      sealed.key,
      `share:${sealed.lookupHash}`
    );
    await expect(
      decryptShare(
        { version: 1, envelope, manifest: [] },
        await readShareKey(url.pathname, url.hash)
      )
    ).rejects.toThrow('size limit');
  });

  it('bounds streamed content even when the peer omits or understates its length', async () => {
    const make = (length?: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(5));
            controller.enqueue(new Uint8Array(5));
            controller.close();
          }
        }),
        { headers: length ? { 'content-length': length } : {} }
      );
    await expect(readBoundedBytes(make(), 8)).rejects.toThrow('size limit');
    await expect(readBoundedBytes(make('1'), 8)).rejects.toThrow('size limit');
    await expect(readBoundedBytes(make('10'), 8)).rejects.toThrow('size limit');
  });
});
