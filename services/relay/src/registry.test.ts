import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveLabel, spkiFromRawEd25519, spkiHash } from './label.js';
import { Registry, monthStart, type RegistryOptions } from './registry.js';

const RELAY_DOMAIN = 'relay.example';

let directory: string;

const identity = (fill: number): { raw: Buffer; hash: string } => {
  const raw = Buffer.alloc(32, fill);
  return { raw, hash: spkiHash(spkiFromRawEd25519(raw)) };
};

const options = (overrides: Partial<RegistryOptions> = {}): RegistryOptions => ({
  path: join(directory, 'registry.json'),
  relayDomain: RELAY_DOMAIN,
  maxPeers: 4,
  registrationEnabled: true,
  defaultQuota: { monthlyBytes: 1024 * 1024, maxConcurrentStreams: 8, rateBps: 1_000_000 },
  flushIntervalMs: 3_600_000,
  ...overrides
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'garden-relay-registry-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('invites', () => {
  it('enrolls a peer at its derived label', async () => {
    const registry = await Registry.open(options());
    const { token } = registry.createInvite('dan-basement', 60_000);
    const box = identity(1);
    const result = registry.redeemInvite(token, box.raw, box.hash);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.peer.label).toBe(deriveLabel(RELAY_DOMAIN, box.raw));
    expect(result.peer.note).toBe('dan-basement');
    // The registry stores the SPKI hash, never the key itself.
    expect(JSON.stringify(result.peer)).not.toContain(box.raw.toString('base64'));
    await registry.close();
  });

  it('burns the token so a captured invite cannot be replayed', async () => {
    const registry = await Registry.open(options());
    const { token } = registry.createInvite('first', 60_000);
    const first = identity(1);
    const second = identity(2);
    expect(registry.redeemInvite(token, first.raw, first.hash).ok).toBe(true);
    const replay = registry.redeemInvite(token, second.raw, second.hash);
    expect(replay).toEqual({ ok: false, reason: 'token-used' });
    expect(registry.peerCount).toBe(1);
    await registry.close();
  });

  it('survives a restart, so the replay is still refused after a reboot', async () => {
    const registry = await Registry.open(options());
    const { token } = registry.createInvite('first', 60_000);
    const first = identity(1);
    registry.redeemInvite(token, first.raw, first.hash);
    await registry.close();

    const reopened = await Registry.open(options());
    const second = identity(2);
    expect(reopened.redeemInvite(token, second.raw, second.hash)).toEqual({
      ok: false,
      reason: 'token-used'
    });
    expect(reopened.peerBySpkiHash(first.hash)?.label).toBe(deriveLabel(RELAY_DOMAIN, first.raw));
    await reopened.close();
  });

  it('refuses an expired token', async () => {
    const registry = await Registry.open(options());
    const { token } = registry.createInvite('stale', 60_000, 0);
    const box = identity(3);
    expect(registry.redeemInvite(token, box.raw, box.hash, 60_001)).toEqual({
      ok: false,
      reason: 'token-expired'
    });
    await registry.close();
  });

  it('refuses an unknown token', async () => {
    const registry = await Registry.open(options());
    const box = identity(3);
    expect(registry.redeemInvite('arly1_nope', box.raw, box.hash)).toEqual({
      ok: false,
      reason: 'unknown-token'
    });
    await registry.close();
  });

  it('refuses enrollment entirely when registration is disabled', async () => {
    const registry = await Registry.open(options({ registrationEnabled: false }));
    const { token } = registry.createInvite('nope', 60_000);
    const box = identity(3);
    expect(registry.redeemInvite(token, box.raw, box.hash)).toEqual({
      ok: false,
      reason: 'registration-disabled'
    });
    await registry.close();
  });

  it('caps the number of peers', async () => {
    const registry = await Registry.open(options({ maxPeers: 1 }));
    const a = identity(1);
    const b = identity(2);
    registry.redeemInvite(registry.createInvite('a', 60_000).token, a.raw, a.hash);
    expect(registry.redeemInvite(registry.createInvite('b', 60_000).token, b.raw, b.hash)).toEqual({
      ok: false,
      reason: 'peer-limit-reached'
    });
    await registry.close();
  });

  it('treats re-enrollment of a known identity as a no-op instead of burning a token', async () => {
    const registry = await Registry.open(options());
    const box = identity(1);
    registry.redeemInvite(registry.createInvite('a', 60_000).token, box.raw, box.hash);
    const second = registry.createInvite('b', 60_000);
    const again = registry.redeemInvite(second.token, box.raw, box.hash);
    expect(again.ok && again.alreadyEnrolled).toBe(true);
    // The second token is untouched and still usable by a different box.
    const other = identity(2);
    expect(registry.redeemInvite(second.token, other.raw, other.hash).ok).toBe(true);
    await registry.close();
  });
});

describe('usage accounting', () => {
  it('tracks per-peer and global bytes and rolls over on the first of the month', async () => {
    const registry = await Registry.open(options());
    const box = identity(1);
    const result = registry.redeemInvite(
      registry.createInvite('a', 60_000).token,
      box.raw,
      box.hash
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const label = result.peer.label;

    const january = Date.UTC(2026, 0, 15);
    registry.recordUsage(label, 5000, january);
    expect(registry.peerUsage(label, january)?.bytes).toBe(5000);
    expect(registry.globalUsage(january).bytes).toBe(5000);

    const february = Date.UTC(2026, 1, 2);
    expect(registry.peerUsage(label, february)?.bytes).toBe(0);
    expect(registry.peerUsage(label, february)?.periodStartMs).toBe(monthStart(february));
    expect(registry.globalUsage(february).bytes).toBe(0);
    await registry.close();
  });
});

describe('revocation and persistence', () => {
  it('removes a peer and persists the removal atomically', async () => {
    const registry = await Registry.open(options());
    const box = identity(1);
    const result = registry.redeemInvite(
      registry.createInvite('a', 60_000).token,
      box.raw,
      box.hash
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(registry.revoke(result.peer.label)).toBe(true);
    expect(registry.revoke(result.peer.label)).toBe(false);
    await registry.close();

    const raw = await readFile(join(directory, 'registry.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ v: 1, peers: [] });
    const reopened = await Registry.open(options());
    expect(reopened.peerBySpkiHash(box.hash)).toBeUndefined();
    await reopened.close();
  });
});
