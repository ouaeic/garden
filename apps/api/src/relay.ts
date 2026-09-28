import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RelayClientConfigSchema,
  RelayConnection,
  enroll,
  loadOrCreateIdentity,
  relayIsUsable,
  type RelayClientConfig,
  type RelayStatus
} from '@garden/relay-client';
import { z } from 'zod';
import { errorFields, type LogFields, type LogValue, type Logger } from './log.js';

/**
 * Turns the dialer's free-form log line into this server's shape: a stable event name and fields
 * that go through the same allowlist as everything else, so nothing the relay says can widen what
 * this process is willing to print.
 */
const relayEvent = (message: string): string =>
  `relay.${message
    .toLowerCase()
    .replace(/^relay /, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')}`;

const relayFields = (fields: Record<string, unknown> | undefined): LogFields => {
  const entries: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      entries[key] = value;
  }
  return entries;
};

/**
 * Everything this box knows about its relay.
 *
 * This is the client config the dialer needs plus the one fact only the box cares about - when the
 * enrollment happened - so the whole of the relay's state is one file an owner can read. There is
 * no default host and `enabled` is false, so a box that was never told to use a relay makes no
 * outbound connection and appears in no operator's registry.
 */
export const RelaySettingsSchema = RelayClientConfigSchema.safeExtend({
  enrolledAt: z.string().nullable().default(null),
  /**
   * When the relay operator dropped this box, or null.
   *
   * The dialer learns this from a `goaway reason=revoked` and deliberately never retries, but it
   * only ever knew it in memory. `garden-network-refresh` reads this file and nothing else, so
   * without the fact written down the relay hostname stayed in the connection manifest and in every
   * pairing ticket handed out, and every client on every device paid a connection attempt to a name
   * that could not answer again - until the owner noticed and ran `garden relay off`. It is also
   * what closes the window after a restart, where nothing has dialled yet and the status file still
   * describes the last run.
   */
  revokedAt: z.string().nullable().default(null)
});

export type RelaySettings = z.infer<typeof RelaySettingsSchema>;

export const defaultRelaySettings = (): RelaySettings => RelaySettingsSchema.parse({});

const SETTINGS_FILE = 'settings.json';
const STATUS_FILE = 'status.json';

/** The settings file is also the off switch, so a torn or hand-edited one has to read as "off". */
type LocalRelayListeners = Pick<
  RelayClientConfig,
  'localHost' | 'localPort' | 'localHttpPort' | 'localPreviewPort'
>;

export const readRelaySettings = async (
  directory: string,
  listeners?: LocalRelayListeners
): Promise<RelaySettings> => {
  const defaults = RelaySettingsSchema.parse(listeners ?? {});
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, SETTINGS_FILE), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    const result = RelaySettingsSchema.safeParse({ ...parsed, ...listeners });
    return result.success ? result.data : defaults;
  } catch {
    return defaults;
  }
};

/**
 * Replaces the settings file in one step.
 *
 * `garden-network-refresh` reads this file to decide whether the box advertises a relay address,
 * and it runs on netlink events at any moment. A half-written file would be read as "off" by the
 * rule above, which would drop a working endpoint out of the connection manifest for no reason.
 */
const writeJsonAtomically = async (path: string, value: unknown): Promise<void> => {
  // A name of its own per write. Two writes in flight sharing one temporary file would have the
  // second rename find that the first had already moved it away.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

export const writeRelaySettings = async (
  directory: string,
  settings: RelaySettings
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeJsonAtomically(join(directory, SETTINGS_FILE), settings);
};

/**
 * The endpoints a client should try, with the relay appended when there is one.
 *
 * The relay goes last and only while it is switched on. It is the slowest path, it is the only one
 * that puts a third party in the way, and most owners never need it - so a box that has one still
 * offers its own addresses first. Passing `null` is how turning the relay off stops the box
 * advertising an address that no longer answers.
 */
export const withRelayEndpoint = (
  endpoints: readonly string[],
  relayHostname: string | null
): string[] => {
  if (!relayHostname) return [...endpoints];
  const endpoint = `https://${relayHostname}`;
  return endpoints.includes(endpoint) ? [...endpoints] : [...endpoints, endpoint];
};

/** What the settings screen and `garden doctor` are shown. */
export interface RelayReport {
  readonly enabled: boolean;
  readonly host: string | null;
  readonly address: string | null;
  readonly port: number;
  readonly label: string | null;
  /** Where clients reach this box over the relay, or null when there is no enrollment. */
  readonly hostname: string | null;
  /** Public key hash of the relay this box enrolled with; a different key is refused. */
  readonly pinnedRelaySpkiSha256: string | null;
  readonly enrolledAt: string | null;
  readonly status: RelayStatus;
}

/** Minimal view of a dialer, so the supervisor can be driven in tests without a relay. */
export interface RelayLink {
  readonly status: RelayStatus;
  start(): void;
  stop(): void;
}

export interface RelayEnrollmentRequest {
  readonly host: string;
  readonly token: string;
  readonly address?: string | null;
  readonly port?: number;
}

export interface RelaySupervisorOptions {
  /** Durable directory holding the identity key and the settings. Created by the installer. */
  readonly directory: string;
  /** Where the box terminates TLS for its own traffic - in a native install, nginx. */
  readonly localHost: string;
  readonly localPort: number;
  /** The box's plaintext listener, where the relay's own :80 is delivered. */
  readonly localHttpPort: number;
  readonly localPreviewPort?: number;
  readonly log: Logger;
  readonly createLink?: (
    config: RelayClientConfig,
    onStatus: (status: RelayStatus) => void
  ) => Promise<RelayLink>;
  /** Enrollment as a seam, so a test can exercise the settings path without a real relay. */
  readonly redeemToken?: (
    request: RelayEnrollmentRequest
  ) => Promise<{ label: string; pinnedRelaySpkiSha256: string }>;
}

const offStatus = (settings: RelaySettings): RelayStatus => ({
  state: 'off',
  label: settings.label,
  hostname: settings.label && settings.host ? `${settings.label}.${settings.host}` : null,
  openStreams: 0,
  usedBytes: 0,
  quota: null,
  previewPort: null,
  lastError: null,
  nextAttemptAtMs: null
});

/**
 * Owns the box's relay: the settings, the identity, and at most one connection.
 *
 * Turning the relay off has to mean the tunnel is gone, not that the interface stopped mentioning
 * it - a box whose owner switched the relay off must not still be answering on the relay hostname.
 * So every settings change goes through here, the connection is torn down before the new settings
 * are published, and the address is dropped from what this box advertises in the same step.
 */
export class RelaySupervisor {
  readonly #options: RelaySupervisorOptions;
  #settings: RelaySettings = defaultRelaySettings();
  #link: RelayLink | null = null;
  #status: RelayStatus = offStatus(defaultRelaySettings());
  /** Serialises settings changes; see `apply`. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RelaySupervisorOptions) {
    this.#options = options;
  }

  get settings(): RelaySettings {
    return this.#settings;
  }

  get status(): RelayStatus {
    return this.#link?.status ?? this.#status;
  }

  report(): RelayReport {
    return {
      enabled: this.#settings.enabled,
      host: this.#settings.host,
      address: this.#settings.address,
      port: this.#settings.port,
      label: this.#settings.label,
      hostname: this.publicHostname(),
      pinnedRelaySpkiSha256: this.#settings.pinnedRelaySpkiSha256,
      enrolledAt: this.#settings.enrolledAt,
      status: this.status
    };
  }

  /**
   * The address this box may advertise, or null.
   *
   * Null the moment the relay is switched off, before anything is dialled or torn down, because an
   * endpoint that is advertised but unreachable costs every client a connection attempt.
   */
  publicHostname(): string | null {
    if (!relayIsUsable(this.#settings)) return null;
    // A revoked enrollment is a complete one - host, label and pin are all still there - so the
    // settings alone cannot tell it apart from a working relay. The operator has dropped this box
    // and the dialer will never retry, so the address is now exactly the unreachable endpoint this
    // rule exists to keep out.
    if (this.#settings.revokedAt !== null || this.status.state === 'revoked') return null;
    return `${this.#settings.label}.${this.#settings.host}`;
  }

  publicPreviewOrigin(): string | null {
    const hostname = this.publicHostname();
    const status = this.status;
    const port = status.previewPort;
    if (
      !hostname ||
      status.state !== 'online' ||
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      port === 80 ||
      port === 443
    )
      return null;
    try {
      const url = new URL(`https://${hostname}`);
      if (
        url.hostname !== hostname.toLowerCase() ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        return null;
      url.port = String(port);
      return url.origin;
    } catch {
      return null;
    }
  }

  /** Reads what is on disk and dials if it says to. Called once while the server is built. */
  async start(): Promise<void> {
    this.#settings = await readRelaySettings(this.#options.directory, this.#localListeners());
    await this.#reconcile();
  }

  async enroll(request: RelayEnrollmentRequest): Promise<RelayReport> {
    const port = request.port ?? 443;
    const address = request.address ?? null;
    const redeem =
      this.#options.redeemToken ??
      (async (input: RelayEnrollmentRequest) => {
        const identity = await loadOrCreateIdentity(this.#options.directory);
        const result = await enroll({ host: input.host, port, address }, identity, input.token);
        return { label: result.label, pinnedRelaySpkiSha256: result.pinnedRelaySpkiSha256 };
      });
    const { label, pinnedRelaySpkiSha256 } = await redeem({ ...request, port, address });
    return this.apply({
      ...this.#settings,
      enabled: true,
      host: request.host,
      address,
      port,
      label,
      pinnedRelaySpkiSha256,
      enrolledAt: new Date().toISOString(),
      // A fresh token is the operator putting this box back in the registry, so whatever the last
      // enrollment ended as, this one starts clean and the address may be advertised again.
      revokedAt: null
    });
  }

  /** Keeps the enrollment but stops using it, so turning it back on needs no new token. */
  async disable(): Promise<RelayReport> {
    return this.apply({ ...this.#settings, enabled: false });
  }

  async enable(): Promise<RelayReport> {
    return this.apply({ ...this.#settings, enabled: true });
  }

  /**
   * Drops the enrollment entirely. The identity key stays: it is this box's address on every relay
   * it has ever enrolled with, and re-enrolling on the same relay with a fresh key would hand the
   * owner a new hostname and invalidate the one their clients already hold.
   */
  async forget(): Promise<RelayReport> {
    return this.apply({
      ...defaultRelaySettings(),
      localHost: this.#settings.localHost,
      localPort: this.#settings.localPort,
      localHttpPort: this.#settings.localHttpPort,
      localPreviewPort: this.#settings.localPreviewPort
    });
  }

  /**
   * Applies a settings change, one at a time.
   *
   * Two changes running at once would each tear down the connection they knew about and start one
   * of their own, and whichever finished first would leave its connection dialling with nothing
   * holding it - a relay the owner switched off that keeps answering.
   */
  apply(next: RelaySettings): Promise<RelayReport> {
    const run = (): Promise<RelayReport> => this.#applyNow(next);
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #localListeners(): LocalRelayListeners {
    return {
      localHost: this.#options.localHost,
      localPort: this.#options.localPort,
      localHttpPort: this.#options.localHttpPort,
      localPreviewPort: this.#options.localPreviewPort ?? 8443
    };
  }

  async #applyNow(next: RelaySettings): Promise<RelayReport> {
    const settings = RelaySettingsSchema.parse({ ...next, ...this.#localListeners() });
    // Torn down before the file changes: if the write fails, the connection is still gone, which is
    // the safe direction for an owner who has just asked for the relay to stop.
    this.#closeLink();
    this.#settings = settings;
    await writeRelaySettings(this.#options.directory, settings);
    await this.#reconcile();
    return this.report();
  }

  /** Stops dialling without changing what the settings say. Used when the process is shutting down. */
  close(): void {
    this.#closeLink();
  }

  #closeLink(): void {
    this.#link?.stop();
    this.#link = null;
    this.#status = offStatus(this.#settings);
  }

  async #reconcile(): Promise<void> {
    if (!relayIsUsable(this.#settings)) {
      this.#status = offStatus(this.#settings);
      await this.#publishStatus();
      return;
    }
    const create =
      this.#options.createLink ??
      (async (config: RelayClientConfig, onStatus: (status: RelayStatus) => void) => {
        const identity = await loadOrCreateIdentity(this.#options.directory);
        return new RelayConnection({
          config,
          identity,
          onStatus,
          logger: (level, message, fields) =>
            this.#options.log[level](relayEvent(message), relayFields(fields))
        });
      });
    const link = await create(this.#settings, (status) => {
      void this.#onStatus(status);
    });
    this.#link = link;
    link.start();
    await this.#publishStatus();
  }

  async #onStatus(status: RelayStatus): Promise<void> {
    // `openStreams` moves with every client connection and says nothing an operator reads later, so
    // it is deliberately not a reason to rewrite the file.
    const previous = this.#status;
    this.#status = status;
    await this.#recordRevocation(status);
    const unchanged =
      previous.state === status.state &&
      previous.label === status.label &&
      previous.usedBytes === status.usedBytes &&
      previous.quota === status.quota &&
      previous.previewPort === status.previewPort &&
      previous.lastError === status.lastError;
    if (!unchanged) await this.#publishStatus();
  }

  /**
   * Writes a revocation, and the end of one, into the settings file.
   *
   * Only `online` clears it: a revoked box that is switched off and on again goes through
   * `connecting` on its way to being told `revoked` a second time, and advertising the address for
   * the length of that doomed attempt is the thing this is here to stop. The write is deliberately
   * not routed through `apply`, which tears the connection down - reacting to a status by dropping
   * the connection that reported it would take a box offline every time the relay pinged it.
   */
  async #recordRevocation(status: RelayStatus): Promise<void> {
    const revokedAt =
      status.state === 'revoked'
        ? (this.#settings.revokedAt ?? new Date().toISOString())
        : status.state === 'online'
          ? null
          : this.#settings.revokedAt;
    if (revokedAt === this.#settings.revokedAt) return;
    this.#settings = { ...this.#settings, revokedAt };
    try {
      await writeRelaySettings(this.#options.directory, this.#settings);
    } catch (error) {
      this.#options.log.warn('relay.revocation_not_recorded', errorFields(error));
    }
  }

  /**
   * Records the live state where a root shell can read it. `garden doctor` runs with no session
   * and must still be able to say whether the relay is working, or say honestly that it is off.
   */
  async #publishStatus(): Promise<void> {
    try {
      await mkdir(this.#options.directory, { recursive: true, mode: 0o700 });
      await writeJsonAtomically(join(this.#options.directory, STATUS_FILE), {
        ...this.status,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      this.#options.log.warn('relay.status_not_recorded', errorFields(error));
    }
  }
}
