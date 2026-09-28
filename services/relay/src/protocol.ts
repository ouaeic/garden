/**
 * Wire protocol constants and message shapes for garden-relay v1.
 *
 * Everything on the wire is TLS 1.3 + HTTP/2 + NDJSON + one CBOR header, deliberately, so that
 * the relay is swappable for a different implementation without touching the box.
 */

/** ALPN offered by a box on its control connection. Also how :443 is demultiplexed. */
export const CONTROL_ALPN = 'garden-relay/1';

/** Protocol major version carried in `hello`. A box speaking a different one is refused. */
export const PROTOCOL_VERSION = 1;

/** Dedicated TLS data plane; never delivered to the owner application listener. */
export const PREVIEW_HTTPS_PORT = 8443;
export const PREVIEW_HTTPS_CAPABILITY = 'preview-https';

export const PATH_CONTROL = '/v1/control';
export const PATH_PARK = '/v1/park';
export const PATH_ENROLL = '/v1/enroll';

/**
 * First byte a box writes on a parked stream. It exists so the relay can distinguish "the stream
 * exists" from "the box has actually finished setting it up and is reading", which matters because
 * HTTP/2 HEADERS arrive before the box's own handlers are attached.
 */
export const PARK_READY_MARKER = 0x01;

/** Length of a derived label in base32 characters (26 * 5 = 130 bits). */
export const LABEL_LENGTH = 26;

/** Enrollment tokens are `arly1_` + base32 of 32 random bytes. */
export const INVITE_PREFIX = 'arly1_';

/** TLS alert record sent to a client whose SNI does not resolve. A bare RST gives no diagnosis. */
export const TLS_ALERT_UNRECOGNIZED_NAME = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x70]);

export type PeerRole = 'primary' | 'aux';

export interface HelloMessage {
  readonly t: 'hello';
  readonly proto: number;
  readonly role: PeerRole;
  readonly agent: string;
  readonly caps: readonly string[];
}

export interface QuotaLimits {
  readonly maxConcurrentStreams: number;
  readonly rateBps: number;
  readonly monthlyBytes: number;
  readonly periodEndMs: number;
}

export interface WelcomeMessage {
  readonly t: 'welcome';
  /** Absent on peers that do not provide a separate preview listener. */
  readonly caps?: readonly string[];
  /** Public TLS listener for app previews, available only with the preview capability. */
  readonly previewPort?: number | null;
  readonly label: string;
  readonly serverTimeMs: number;
  readonly parkTarget: number;
  readonly limits: QuotaLimits;
}

export interface NeedParkMessage {
  readonly t: 'need_park';
  readonly n: number;
}

export type QuotaState = 'ok' | 'warn' | 'shaped' | 'blocked';

export interface QuotaMessage {
  readonly t: 'quota';
  readonly usedBytes: number;
  readonly state: QuotaState;
}

export type GoawayReason = 'restart' | 'revoked' | 'quota' | 'protocol' | 'replaced';

export interface GoawayMessage {
  readonly t: 'goaway';
  readonly reason: GoawayReason;
  readonly reconnectAfterMs: number;
}

export interface PongStatsMessage {
  readonly t: 'pong_stats';
  readonly openStreams: number;
}

export type RelayToBoxMessage = WelcomeMessage | NeedParkMessage | QuotaMessage | GoawayMessage;
export type BoxToRelayMessage = HelloMessage | PongStatsMessage;

/**
 * The bind frame prefixed to a parked stream's response body when a client is attached.
 *
 * `ip`/`sport` are ADVISORY ONLY. A malicious or compromised relay can put anything here, so the
 * box must never use them for authorization, allowlisting or session binding - display and coarse
 * rate-limiting heuristics only. The field looks authoritative, which is exactly the trap.
 */
export interface BindFrame {
  readonly cid: Uint8Array;
  readonly l: string;
  readonly sni: string;
  readonly port: number;
  readonly ip: string;
  readonly sport: number;
  readonly t: number;
}

/** Maximum bind frame size a box should be willing to buffer. Ours are ~90 bytes. */
export const MAX_BIND_FRAME_BYTES = 4096;
