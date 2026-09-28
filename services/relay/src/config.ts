import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PREVIEW_HTTPS_PORT } from './protocol.js';

const GIB = 1024 * 1024 * 1024;

/**
 * Default quotas. These are calibrated so a hobbyist running this on a ~EUR 4 VPS with a 20 TB
 * traffic allowance is not surprised by a bill: 25 GiB/peer/month is "control plane plus roughly
 * half an hour of desktop preview a day", and the global ceiling sits under a 20 TB plan with
 * headroom. The relay is a control path, not a media path, and the defaults say so.
 */
const PerPeerLimits = z.object({
  concurrentStreams: z.coerce.number().int().min(1).max(1024).default(64),
  newStreamsPerMinute: z.coerce.number().int().min(1).default(300),
  rateBps: z.coerce
    .number()
    .int()
    .min(8192)
    .default(10 * 1024 * 1024),
  burstBytes: z.coerce
    .number()
    .int()
    .min(8192)
    .default(50 * 1024 * 1024),
  monthlyBytes: z.coerce
    .number()
    .int()
    .min(1024 * 1024)
    .default(25 * GIB)
});

const GlobalLimits = z.object({
  maxPeers: z.coerce.number().int().min(1).max(100_000).default(256),
  monthlyBytes: z.coerce
    .number()
    .int()
    .min(1024 * 1024)
    .default(15_000_000_000_000),
  /** Rate applied to every peer once the relay passes `shapeAtFraction` of its monthly budget. */
  shapedRateBps: z.coerce
    .number()
    .int()
    .min(8192)
    .default(1024 * 1024),
  shapeAtFraction: z.coerce.number().min(0.1).max(1).default(0.9),
  halfOpenPreSni: z.coerce.number().int().min(16).default(2048),
  /** Concurrent authenticated-but-unregistered sessions allowed to attempt enrollment. */
  enrollingSessions: z.coerce.number().int().min(1).default(32)
});

const PerSourceIpLimits = z.object({
  newConnPerMinute: z.coerce.number().int().min(1).default(120),
  burst: z.coerce.number().int().min(1).default(60),
  /** Bound on the limiter's own memory; oldest entry is evicted when full. */
  maxTrackedSources: z.coerce.number().int().min(256).default(20_000)
});

const PeerQuotaOverrides = z
  .object({
    monthlyBytes: z.coerce
      .number()
      .int()
      .min(1024 * 1024),
    maxConcurrentStreams: z.coerce.number().int().min(1).max(1024),
    rateBps: z.coerce.number().int().min(8192)
  })
  .partial();

export const RelayConfigSchema = z
  .object({
    /** Apex the relay owns. Labels live at `<label>.<relayDomain>`. */
    relayDomain: z.string().min(1).max(253),
    /** SNI a box uses for its control connection. Defaults to `relayDomain`. */
    controlHost: z.string().min(1).max(253).optional(),
    listenHost: z.string().default('0.0.0.0'),
    httpsPort: z.coerce.number().int().min(0).max(65535).default(443),
    /**
     * Where boxes dial in. Defaulting to the same port as client traffic is deliberate: the tunnel is
     * then indistinguishable from ordinary HTTPS to a hostile network or a CGNAT operator. Set it
     * differently only if something in the path cannot cope with the demultiplexing.
     */
    controlPort: z.coerce.number().int().min(0).max(65535).default(443),
    /** Exists only for ACME HTTP-01 fallback and HTTP->HTTPS redirects. `null` disables it. */
    httpPort: z.coerce.number().int().min(0).max(65535).nullable().default(80),
    /** Separate TLS listener for generated apps. Null disables preview forwarding. */
    previewPort: z.coerce.number().int().min(0).max(65535).nullable().default(PREVIEW_HTTPS_PORT),
    metricsPort: z.coerce.number().int().min(0).max(65535).nullable().default(9095),
    /** Metrics must not be reachable from the internet; they leak per-label traffic volumes. */
    metricsHost: z.string().default('127.0.0.1'),
    tlsCertPath: z.string().min(1),
    tlsKeyPath: z.string().min(1),
    registryPath: z.string().min(1).default('/var/lib/garden-relay/registry.json'),
    /** When false, `/v1/enroll` is refused outright even with a valid invite token. */
    registrationEnabled: z.boolean().default(true),
    /**
     * Client IPs are not logged by default. Turning this on is for abuse investigations and it
     * changes what the operator retains about their users; say so before flipping it.
     */
    logClientIps: z.boolean().default(false),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    parkTarget: z.coerce.number().int().min(1).max(64).default(8),
    /** 3s: long enough for a bad mobile link to complete, short enough to drop junk quickly. */
    handshakeTimeoutMs: z.coerce.number().int().min(500).max(30_000).default(3000),
    /** How long an authenticated but unregistered peer may hold a session to enroll. */
    enrollTimeoutMs: z.coerce.number().int().min(1000).max(120_000).default(10_000),
    /** CGNAT mappings expire at 60-120s and sometimes less, so ping well under that. */
    pingIntervalMs: z.coerce.number().int().min(1000).default(20_000),
    pingTimeoutMs: z.coerce.number().int().min(500).default(10_000),
    /** Upper bound on the jittered reconnect delay handed out in a shutdown GOAWAY. */
    goawayJitterMs: z.coerce.number().int().min(0).default(30_000),
    /**
     * How long a half-closed relayed connection may linger before the relay tears it down.
     *
     * Half-close has to be preserved - it is ordinary TCP, and ACME HTTP-01 over :80 depends on it -
     * but a client that simply vanishes leaves the relay holding a socket and one of the peer's
     * concurrent-stream slots until the box happens to notice. Boxes are not trusted to notice.
     */
    halfCloseLingerMs: z.coerce.number().int().min(1000).default(120_000),
    invite: z
      .object({
        defaultTtlMs: z.coerce
          .number()
          .int()
          .min(60_000)
          .default(24 * 3600 * 1000)
      })
      .prefault({}),
    limits: z
      .object({
        perPeer: PerPeerLimits.prefault({}),
        global: GlobalLimits.prefault({}),
        perSourceIp: PerSourceIpLimits.prefault({})
      })
      .prefault({}),
    /** Applied to newly enrolled peers; existing peers keep whatever the registry recorded. */
    defaultPeerQuota: PeerQuotaOverrides.prefault({})
  })
  .superRefine((config, context) => {
    const listeners = [
      'httpsPort',
      'controlPort',
      'httpPort',
      'previewPort',
      'metricsPort'
    ] as const;
    for (const [index, key] of listeners.entries()) {
      const port = config[key];
      if (!port) continue;
      for (const previous of listeners.slice(0, index)) {
        if (key === 'controlPort' && previous === 'httpsPort') continue;
        if (config[previous] === port)
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `Listener conflicts with ${previous}.`
          });
      }
    }
  });

export type RelayConfig = z.infer<typeof RelayConfigSchema>;
export type PerPeerLimitConfig = z.infer<typeof PerPeerLimits>;

export const resolveControlHost = (config: RelayConfig): string =>
  (config.controlHost ?? config.relayDomain).toLowerCase();

export const parseRelayConfig = (input: unknown): RelayConfig => RelayConfigSchema.parse(input);

export const loadRelayConfigFile = async (path: string): Promise<RelayConfig> => {
  const raw = await readFile(path, 'utf8');
  return parseRelayConfig(JSON.parse(raw));
};

/**
 * Parses `30s`, `15m`, `24h`, `7d` or a bare millisecond count. Used by `invite --ttl`.
 */
export const parseDuration = (value: string): number => {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error(`invalid duration: ${value}`);
  const amount = Number.parseInt(match[1] ?? '0', 10);
  const unit = match[2] ?? 'ms';
  const scale: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * (scale[unit] ?? 1);
};
