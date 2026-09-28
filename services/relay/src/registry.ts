import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { base32Lower, deriveLabel } from './label.js';
import { INVITE_PREFIX } from './protocol.js';

export interface PeerQuota {
  monthlyBytes: number;
  maxConcurrentStreams: number;
  rateBps: number;
}

export interface PeerUsage {
  periodStartMs: number;
  bytes: number;
}

export interface PeerRecord {
  label: string;
  /**
   * SHA-256 of the DER SubjectPublicKeyInfo, not the key itself. At-rest blinding is free here.
   * Be honest about what it buys: the relay sees the public key on every connection and the label
   * is public in Certificate Transparency, so this only protects a leaked registry file.
   */
  spkiHash: string;
  createdAt: number;
  note: string;
  quota: PeerQuota;
  usage: PeerUsage;
  lastSeenAt: number | null;
}

export interface InviteRecord {
  tokenHash: string;
  note: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByLabel: string | null;
}

export interface RegistryFile {
  v: 1;
  peers: PeerRecord[];
  invites: InviteRecord[];
  global: PeerUsage;
}

export type RedeemFailure =
  | 'registration-disabled'
  | 'unknown-token'
  | 'token-expired'
  | 'token-used'
  | 'identity-mismatch'
  | 'peer-limit-reached';

export type RedeemResult =
  | { ok: true; peer: PeerRecord; alreadyEnrolled: boolean }
  | { ok: false; reason: RedeemFailure };

export interface RegistryOptions {
  path: string;
  relayDomain: string;
  defaultQuota: PeerQuota;
  maxPeers: number;
  registrationEnabled: boolean;
  /** Byte counters are flushed on this cadence; a crash loses at most this much accounting. */
  flushIntervalMs?: number;
}

const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** Start of the current UTC calendar month. Quotas reset on the 1st, which is what operators expect. */
export const monthStart = (now: number): number => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

export const monthEnd = (now: number): number => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
};

export const generateInviteToken = (): string => `${INVITE_PREFIX}${base32Lower(randomBytes(32))}`;

const emptyFile = (now: number): RegistryFile => ({
  v: 1,
  peers: [],
  invites: [],
  global: { periodStartMs: monthStart(now), bytes: 0 }
});

/**
 * The whole registry is one JSON file: a few hundred rows that the operator can read and edit with
 * a text editor, which is the right affordance for this component. Writes are temp + fsync +
 * rename so a power cut cannot leave a half-written registry behind.
 */
export class Registry {
  private readonly options: RegistryOptions;
  private file: RegistryFile;
  private byLabel = new Map<string, PeerRecord>();
  private bySpkiHash = new Map<string, PeerRecord>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** Signature of the file as this process last read or wrote it, for change detection. */
  private diskSignature: DiskSignature | null = null;
  /** Labels and invites that were on disk at that moment, to tell "new here" from "deleted there". */
  private persistedLabels = new Set<string>();
  private persistedInvites = new Set<string>();
  private peersRemovedListener: ((labels: readonly string[]) => void) | null = null;

  private constructor(options: RegistryOptions, file: RegistryFile) {
    this.options = options;
    this.file = file;
    this.reindex();
  }

  static async open(options: RegistryOptions): Promise<Registry> {
    const now = Date.now();
    let file: RegistryFile;
    try {
      const raw = await readFile(options.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      file = Registry.normalise(parsed, now);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      file = emptyFile(now);
    }
    const registry = new Registry(options, file);
    registry.diskSignature = await readSignature(options.path);
    registry.rememberPersisted();
    const interval = options.flushIntervalMs ?? 5000;
    registry.flushTimer = setInterval(() => {
      void registry.tick();
    }, interval);
    registry.flushTimer.unref();
    return registry;
  }

  /**
   * Called when a peer disappears from the file underneath us, which is how `garden-relay revoke`
   * reaches a running relay.
   */
  setPeersRemovedListener(listener: (labels: readonly string[]) => void): void {
    this.peersRemovedListener = listener;
  }

  private rememberPersisted(): void {
    this.persistedLabels = new Set(this.file.peers.map((peer) => peer.label));
    this.persistedInvites = new Set(this.file.invites.map((invite) => invite.tokenHash));
  }

  private async tick(): Promise<void> {
    await this.syncFromDisk();
    await this.flush();
  }

  /**
   * Reconciles with the file on disk.
   *
   * The CLI writes this same file - `invite` mints a token, `revoke` deletes a peer - and it has no
   * way to reach a running relay. Without this, an invite minted while the relay is up would be
   * invisible to it and then destroyed by the relay's next flush, which is precisely the documented
   * workflow. Disk wins for anything an operator edits; counters take whichever side is further
   * along, since they only ever increase.
   */
  async syncFromDisk(): Promise<readonly string[]> {
    const signature = await readSignature(this.options.path);
    if (signature === null) return [];
    if (
      this.diskSignature !== null &&
      signature.mtimeMs === this.diskSignature.mtimeMs &&
      signature.size === this.diskSignature.size
    ) {
      return [];
    }

    let disk: RegistryFile;
    try {
      disk = Registry.normalise(JSON.parse(await readFile(this.options.path, 'utf8')), Date.now());
    } catch {
      // A half-written or hand-mangled file must not take the relay down; keep serving what we have.
      return [];
    }

    const removed = this.mergeFromDisk(disk);
    this.diskSignature = signature;
    this.rememberPersisted();
    this.reindex();
    if (removed.length > 0) this.peersRemovedListener?.(removed);
    return removed;
  }

  private mergeFromDisk(disk: RegistryFile): string[] {
    const mine = new Map(this.file.peers.map((peer) => [peer.label, peer]));
    const merged: PeerRecord[] = disk.peers.map((diskPeer) => {
      const memory = mine.get(diskPeer.label);
      if (memory === undefined) return diskPeer;
      mine.delete(diskPeer.label);
      return {
        ...diskPeer,
        usage: laterUsage(diskPeer.usage, memory.usage),
        lastSeenAt: Math.max(diskPeer.lastSeenAt ?? 0, memory.lastSeenAt ?? 0) || null
      };
    });
    const removed: string[] = [];
    for (const [label, peer] of mine) {
      // On disk before and gone now means an external revoke; never seen on disk means we enrolled
      // it since the last write and it is ours to keep.
      if (this.persistedLabels.has(label)) removed.push(label);
      else merged.push(peer);
    }

    const diskInvites = new Map(disk.invites.map((invite) => [invite.tokenHash, invite]));
    for (const invite of this.file.invites) {
      const onDisk = diskInvites.get(invite.tokenHash);
      if (onDisk === undefined) {
        if (!this.persistedInvites.has(invite.tokenHash)) diskInvites.set(invite.tokenHash, invite);
        continue;
      }
      // A token spent on either side is spent.
      if (invite.usedAt !== null && onDisk.usedAt === null)
        diskInvites.set(invite.tokenHash, invite);
    }

    this.file = {
      v: 1,
      peers: merged,
      invites: [...diskInvites.values()],
      global: laterUsage(disk.global, this.file.global)
    };
    this.dirty = true;
    return removed;
  }

  private static normalise(parsed: unknown, now: number): RegistryFile {
    if (typeof parsed !== 'object' || parsed === null) return emptyFile(now);
    const candidate = parsed as Partial<RegistryFile>;
    return {
      v: 1,
      peers: Array.isArray(candidate.peers) ? candidate.peers : [],
      invites: Array.isArray(candidate.invites) ? candidate.invites : [],
      global: candidate.global ?? { periodStartMs: monthStart(now), bytes: 0 }
    };
  }

  private reindex(): void {
    this.byLabel = new Map(this.file.peers.map((peer) => [peer.label, peer]));
    this.bySpkiHash = new Map(this.file.peers.map((peer) => [peer.spkiHash, peer]));
  }

  get peerCount(): number {
    return this.file.peers.length;
  }

  listPeers(): readonly PeerRecord[] {
    return this.file.peers;
  }

  listInvites(): readonly InviteRecord[] {
    return this.file.invites;
  }

  peerByLabel(label: string): PeerRecord | undefined {
    return this.byLabel.get(label);
  }

  peerBySpkiHash(hash: string): PeerRecord | undefined {
    return this.bySpkiHash.get(hash);
  }

  createInvite(
    note: string,
    ttlMs: number,
    now: number = Date.now()
  ): { token: string; record: InviteRecord } {
    const token = generateInviteToken();
    const record: InviteRecord = {
      tokenHash: hashToken(token),
      note,
      createdAt: now,
      expiresAt: now + ttlMs,
      usedAt: null,
      usedByLabel: null
    };
    this.file.invites.push(record);
    this.pruneInvites(now);
    this.dirty = true;
    return { token, record };
  }

  /**
   * Redeems an invite for the identity that presented `rawPublicKey`.
   *
   * Single use is enforced here and is the relay's replay defence at the enrollment layer: the
   * transport layer's replay resistance comes from TLS 1.3 binding CertificateVerify to the
   * handshake transcript, but a captured enrollment token is a bearer credential and must burn.
   */
  redeemInvite(
    token: string,
    rawPublicKey: Uint8Array,
    spkiHashHex: string,
    now: number = Date.now()
  ): RedeemResult {
    if (!this.options.registrationEnabled) return { ok: false, reason: 'registration-disabled' };

    const label = deriveLabel(this.options.relayDomain, rawPublicKey);
    const existing = this.byLabel.get(label);
    if (existing !== undefined) {
      // Re-enrolling an identity that is already registered is a no-op, not a token burn: it is
      // what a box does after losing its local state, and failing it would strand the operator.
      if (existing.spkiHash !== spkiHashHex) return { ok: false, reason: 'identity-mismatch' };
      return { ok: true, peer: existing, alreadyEnrolled: true };
    }

    const invite = this.findInvite(token);
    if (invite === undefined) return { ok: false, reason: 'unknown-token' };
    if (invite.usedAt !== null) return { ok: false, reason: 'token-used' };
    if (invite.expiresAt <= now) return { ok: false, reason: 'token-expired' };
    if (this.file.peers.length >= this.options.maxPeers) {
      return { ok: false, reason: 'peer-limit-reached' };
    }

    invite.usedAt = now;
    invite.usedByLabel = label;
    const peer: PeerRecord = {
      label,
      spkiHash: spkiHashHex,
      createdAt: now,
      note: invite.note,
      quota: { ...this.options.defaultQuota },
      usage: { periodStartMs: monthStart(now), bytes: 0 },
      lastSeenAt: now
    };
    this.file.peers.push(peer);
    this.byLabel.set(label, peer);
    this.bySpkiHash.set(spkiHashHex, peer);
    this.dirty = true;
    return { ok: true, peer, alreadyEnrolled: false };
  }

  /** Constant-time hash comparison so a token cannot be recovered by timing the lookup. */
  private findInvite(token: string): InviteRecord | undefined {
    const wanted = Buffer.from(hashToken(token), 'hex');
    for (const invite of this.file.invites) {
      const candidate = Buffer.from(invite.tokenHash, 'hex');
      if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) return invite;
    }
    return undefined;
  }

  private pruneInvites(now: number): void {
    // Keep used invites for a while so `peers` can explain where a label came from, but do not let
    // the file grow without bound.
    const cutoff = now - 30 * 86_400_000;
    this.file.invites = this.file.invites.filter(
      (invite) => invite.expiresAt > now || (invite.usedAt !== null && invite.usedAt > cutoff)
    );
  }

  revoke(label: string): boolean {
    const peer = this.byLabel.get(label);
    if (peer === undefined) return false;
    this.file.peers = this.file.peers.filter((candidate) => candidate.label !== label);
    this.byLabel.delete(label);
    this.bySpkiHash.delete(peer.spkiHash);
    this.dirty = true;
    return true;
  }

  markSeen(label: string, now: number = Date.now()): void {
    const peer = this.byLabel.get(label);
    if (peer === undefined) return;
    peer.lastSeenAt = now;
    this.dirty = true;
  }

  private rollPeriod(usage: PeerUsage, now: number): PeerUsage {
    const start = monthStart(now);
    if (usage.periodStartMs !== start) {
      usage.periodStartMs = start;
      usage.bytes = 0;
      this.dirty = true;
    }
    return usage;
  }

  peerUsage(label: string, now: number = Date.now()): PeerUsage | undefined {
    const peer = this.byLabel.get(label);
    return peer === undefined ? undefined : this.rollPeriod(peer.usage, now);
  }

  globalUsage(now: number = Date.now()): PeerUsage {
    return this.rollPeriod(this.file.global, now);
  }

  recordUsage(label: string, bytes: number, now: number = Date.now()): void {
    if (bytes <= 0) return;
    const peer = this.byLabel.get(label);
    if (peer !== undefined) this.rollPeriod(peer.usage, now).bytes += bytes;
    this.rollPeriod(this.file.global, now).bytes += bytes;
    this.dirty = true;
  }

  setQuota(label: string, quota: Partial<PeerQuota>): boolean {
    const peer = this.byLabel.get(label);
    if (peer === undefined) return false;
    peer.quota = { ...peer.quota, ...quota };
    this.dirty = true;
    return true;
  }

  /** Serialises writes so two overlapping flushes cannot interleave on the temp file. */
  async flush(force = false): Promise<void> {
    if (!this.dirty && !force) return;
    this.dirty = false;
    const snapshot = `${JSON.stringify(this.file, null, 2)}\n`;
    this.writing = this.writing.then(async () => {
      await writeAtomic(this.options.path, snapshot);
      this.diskSignature = await readSignature(this.options.path);
      this.rememberPersisted();
    });
    await this.writing;
  }

  async close(): Promise<void> {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.syncFromDisk();
    await this.flush(true);
  }
}

interface DiskSignature {
  readonly mtimeMs: number;
  readonly size: number;
}

const readSignature = async (path: string): Promise<DiskSignature | null> => {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
};

/** Counters only ever increase, so the further-along side is the true one. */
const laterUsage = (a: PeerUsage, b: PeerUsage): PeerUsage => {
  if (a.periodStartMs !== b.periodStartMs) {
    return a.periodStartMs > b.periodStartMs ? a : b;
  }
  return a.bytes >= b.bytes ? a : b;
};

const isMissingFile = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

/**
 * write temp + fsync + rename. The fsync is the point: rename is atomic, but without the fsync the
 * renamed file can still contain garbage after a power loss.
 */
export const writeAtomic = async (path: string, contents: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
};
