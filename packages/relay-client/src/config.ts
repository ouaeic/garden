import { z } from 'zod';
import { PREVIEW_HTTPS_PORT } from '@garden/relay';

/**
 * Relay settings for one box.
 *
 * `enabled` is false and there is no default host, deliberately. A box that has never been told to
 * use a relay makes no outbound connection, registers nowhere, and appears in no operator's
 * registry - turning it on is two explicit acts (a hostname and an enrollment token), and there is
 * no vendor relay to fall back to. The direct-IP and dynamic-DNS paths stay first class.
 */
export const RelayClientConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * The relay's own hostname, e.g. `relay.example`. This is the name presented in SNI, the name the
     * label is derived under, and the suffix of the box's public address - not necessarily where the
     * connection is opened.
     */
    host: z.string().min(1).nullable().default(null),
    /**
     * Where to actually open the connection, when that differs from `host`: a pinned address for a
     * relay whose DNS the owner does not trust, or an internal address on a private network. The
     * relay still routes on SNI, so `host` is what it sees either way.
     */
    address: z.string().min(1).nullable().default(null),
    port: z.number().int().min(1).max(65_535).default(443),
    /**
     * Pinned SPKI hash of the relay, recorded at enrollment. Trust-on-first-use: after enrollment a
     * relay presenting a different key is refused rather than silently accepted, so an operator who
     * loses control of the hostname cannot become a man in the middle for an already-enrolled box.
     */
    pinnedRelaySpkiSha256: z.string().nullable().default(null),
    /** Where the box terminates TLS for its own traffic. The relay only moves bytes. */
    localPort: z.number().int().min(1).max(65_535).default(443),
    /**
     * Where a connection the relay accepted on its own :80 is delivered.
     *
     * The relay marks those binds `port: 80` and they are plaintext HTTP, not TLS, so sending them to
     * `localPort` would hand a TLS listener an HTTP request line and produce nothing but a closed
     * connection. That path exists for ACME HTTP-01 and for the redirect to HTTPS, both of which live
     * on the box's own :80.
     */
    localHttpPort: z.number().int().min(1).max(65_535).default(80),
    /** Preview-only TLS listener; it must be distinct from the owner listener. */
    localPreviewPort: z.number().int().min(1).max(65_535).default(PREVIEW_HTTPS_PORT),
    localHost: z.string().min(1).default('127.0.0.1'),
    /** Label the relay assigned at enrollment, kept so the box can show its address while offline. */
    label: z.string().nullable().default(null)
  })
  .refine(
    (config) =>
      config.localPreviewPort !== config.localPort &&
      config.localPreviewPort !== config.localHttpPort,
    { message: 'Preview traffic requires a separate local listener.', path: ['localPreviewPort'] }
  );

export type RelayClientConfig = z.infer<typeof RelayClientConfigSchema>;

export const disabledRelayConfig = (): RelayClientConfig => RelayClientConfigSchema.parse({});

/**
 * A relay is only usable once it has somewhere to dial, an identity the relay has accepted, and a
 * key it recorded for that relay. Treating a half-configured relay as off is what keeps a failed
 * enrollment from turning into a reconnect loop against a host that will never answer.
 *
 * The pin is part of "configured" and not an optional extra, because the dial deliberately carries
 * no CA check: the box authenticates the relay by the key it pinned at enrollment and by nothing
 * else. A settings file with a host and a label but no pin - one written by a build that predates
 * pinning, hand-edited through the `jq` path in `scripts/garden`, or produced by any future writer
 * that forgets the field - parses cleanly and would otherwise dial, present the private key that is
 * this box's address, and accept whatever certificate answered for the name.
 */
export const relayIsUsable = (config: RelayClientConfig): boolean =>
  config.enabled &&
  config.host !== null &&
  config.label !== null &&
  config.pinnedRelaySpkiSha256 !== null;

/**
 * Which of the box's own listeners a bound stream belongs to.
 *
 * Split out so it can be checked without a relay: getting it wrong is invisible until an owner
 * renews a certificate over the relay months later and the challenge silently fails.
 */
export const localPortForBind = (config: RelayClientConfig, relayPort: number): number | null => {
  if (relayPort === 80) return config.localHttpPort;
  if (relayPort === 443) return config.localPort;
  if (
    relayPort === PREVIEW_HTTPS_PORT &&
    config.localPreviewPort !== config.localPort &&
    config.localPreviewPort !== config.localHttpPort
  )
    return config.localPreviewPort;
  return null;
};
