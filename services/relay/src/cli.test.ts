import { describe, expect, it } from 'vitest';
import { applyCliOverrides, parseArgs } from './cli.js';
import { parseDuration, parseRelayConfig } from './config.js';

const baseConfig = parseRelayConfig({
  relayDomain: 'relay.example',
  tlsCertPath: '/etc/tls/cert.pem',
  tlsKeyPath: '/etc/tls/key.pem'
});

describe('parseArgs', () => {
  it('separates positionals, valued flags and bare booleans', () => {
    const args = parseArgs(['invite', '--note', 'dan-basement', '--ttl', '24h']);
    expect(args.positional).toEqual(['invite']);
    expect(args.flags.get('note')).toBe('dan-basement');
    expect(args.flags.get('ttl')).toBe('24h');
    expect(args.booleans.size).toBe(0);
  });

  it('treats a flag followed by another flag as a boolean', () => {
    const args = parseArgs(['serve', '--no-registration', '--config', '/etc/garden-relay.json']);
    expect(args.booleans.has('no-registration')).toBe(true);
    expect(args.flags.get('config')).toBe('/etc/garden-relay.json');
  });

  it('treats a trailing flag as a boolean', () => {
    expect(parseArgs(['serve', '--no-registration']).booleans.has('no-registration')).toBe(true);
  });
});

describe('applyCliOverrides', () => {
  it('closes registration without touching the config file', () => {
    expect(baseConfig.registrationEnabled).toBe(true);
    const closed = applyCliOverrides(baseConfig, parseArgs(['serve', '--no-registration']));
    expect(closed.registrationEnabled).toBe(false);
    // The rest of the configuration is untouched.
    expect(closed.relayDomain).toBe(baseConfig.relayDomain);
    expect(closed.limits).toEqual(baseConfig.limits);
  });

  it('leaves the config alone when the flag is absent', () => {
    expect(applyCliOverrides(baseConfig, parseArgs(['serve']))).toBe(baseConfig);
  });
});

describe('config defaults', () => {
  it('ships the documented quotas', () => {
    expect(baseConfig.limits.global.maxPeers).toBe(256);
    expect(baseConfig.limits.perPeer.monthlyBytes).toBe(25 * 1024 * 1024 * 1024);
    expect(baseConfig.limits.perPeer.concurrentStreams).toBe(64);
    expect(baseConfig.limits.perSourceIp.newConnPerMinute).toBe(120);
    expect(baseConfig.limits.global.halfOpenPreSni).toBe(2048);
    expect(baseConfig.handshakeTimeoutMs).toBe(3000);
    // Registration is open to invite holders but there is no way in without one.
    expect(baseConfig.registrationEnabled).toBe(true);
    // Control shares :443 with client traffic so a tunnel looks like ordinary HTTPS.
    expect(baseConfig.controlPort).toBe(baseConfig.httpsPort);
    // Metrics leak per-label traffic volumes, so they must not default to a public interface.
    expect(baseConfig.metricsHost).toBe('127.0.0.1');
  });

  it('keeps a null httpPort null rather than coercing it to zero', () => {
    expect(parseRelayConfig({ ...baseConfig, httpPort: null }).httpPort).toBeNull();
  });
});

describe('preview listener config', () => {
  it('allows disabling previews and separate ephemeral listeners', () => {
    expect(parseRelayConfig({ ...baseConfig, previewPort: null }).previewPort).toBeNull();
    expect(parseRelayConfig({ ...baseConfig, httpsPort: 0, previewPort: 0 }).previewPort).toBe(0);
  });
  it.each(['httpsPort', 'controlPort', 'httpPort', 'metricsPort'])(
    'refuses sharing preview and %s',
    (key) => {
      expect(() =>
        parseRelayConfig({ ...baseConfig, previewPort: baseConfig[key as keyof typeof baseConfig] })
      ).toThrow(/conflict/i);
    }
  );
});

describe('parseDuration', () => {
  it('accepts the suffixes the CLI documents', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('1000')).toBe(1000);
  });

  it('rejects anything else instead of silently returning NaN', () => {
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
    expect(() => parseDuration('-5m')).toThrow(/invalid duration/);
  });
});
