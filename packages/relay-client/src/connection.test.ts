import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconnectDelayMs } from './backoff.js';
import { RelayClientConfigSchema, localPortForBind, relayIsUsable } from './config.js';
import { RelayConnection } from './connection.js';
import { loadOrCreateIdentity } from './identity.js';

const RELAY_DOMAIN = 'relay.example';
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'garden-relay-client-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

describe('relay is off unless it is deliberately turned on', () => {
  it('ships disabled with nowhere to dial', () => {
    const config = RelayClientConfigSchema.parse({});
    expect(config.enabled).toBe(false);
    expect(config.host).toBeNull();
    expect(relayIsUsable(config)).toBe(false);
  });

  it('treats a half-configured relay as off rather than reconnecting at a host that will not answer', () => {
    expect(
      relayIsUsable(RelayClientConfigSchema.parse({ enabled: true, host: 'relay.example' }))
    ).toBe(false);
    expect(
      relayIsUsable(
        RelayClientConfigSchema.parse({
          enabled: true,
          host: 'relay.example',
          label: 'abc',
          pinnedRelaySpkiSha256: 'a-relay-key'
        })
      )
    ).toBe(true);
  });

  it('treats an enrollment with no pinned relay key as off, because there is nothing to trust', () => {
    // A settings file written by a build that predates pinning, or hand-edited by the `jq` path in
    // `scripts/garden`, parses cleanly with a host, a label and a null pin. Dialling on that means
    // presenting the private key that is this box's address to whoever now answers for the name.
    expect(
      relayIsUsable(
        RelayClientConfigSchema.parse({ enabled: true, host: 'relay.example', label: 'abc' })
      )
    ).toBe(false);
  });

  it('refuses to dial an enrollment with no pinned relay key, and says why', () => {
    const connection = new RelayConnection({
      config: RelayClientConfigSchema.parse({
        enabled: true,
        host: 'relay.example',
        label: 'abc'
      }),
      identity: {
        keyPem: '',
        certPem: '',
        spkiDer: Buffer.alloc(0),
        rawPublicKey: Buffer.alloc(0),
        labelFor: () => 'abc'
      }
    });
    connection.start();
    cleanups.push(() => connection.stop());
    expect(connection.status.state).toBe('off');
    // Off with no reason reads as "the owner turned it off". This one needs a new enrollment.
    expect(connection.status.lastError).toMatch(/enroll/i);
    expect(connection.status.nextAttemptAtMs).toBeNull();
  });

  it('makes no connection at all when it is off', () => {
    const connection = new RelayConnection({
      config: RelayClientConfigSchema.parse({}),
      identity: {
        keyPem: '',
        certPem: '',
        spkiDer: Buffer.alloc(0),
        rawPublicKey: Buffer.alloc(0),
        labelFor: () => 'unused'
      }
    });
    connection.start();
    expect(connection.status.state).toBe('off');
  });
});

describe('which listener a bound stream reaches', () => {
  it('maps each advertised listener explicitly', () => {
    const config = RelayClientConfigSchema.parse({
      localPort: 9443,
      localHttpPort: 8080,
      localPreviewPort: 9444
    });
    // A relayed :80 connection is plaintext HTTP. Delivering it to the TLS listener would look
    // like a working relay right up to the first certificate renewal over it.
    expect(localPortForBind(config, 80)).toBe(8080);
    expect(localPortForBind(config, 443)).toBe(9443);
    expect(localPortForBind(config, 8443)).toBe(9444);
  });

  it('defaults to the ports a box actually serves on', () => {
    const config = RelayClientConfigSchema.parse({});
    expect(localPortForBind(config, 443)).toBe(443);
    expect(localPortForBind(config, 80)).toBe(80);
    expect(localPortForBind(config, 8443)).toBe(8443);
  });
});

describe('preview listener authority', () => {
  it.each([0, 22, 4400, 65535, -1, NaN, Infinity])('refuses unadvertised bind port %s', (port) => {
    expect(localPortForBind(RelayClientConfigSchema.parse({}), port)).toBeNull();
  });
  it.each([443, 80])('refuses a preview listener shared with owner or HTTP port %s', (port) => {
    expect(RelayClientConfigSchema.safeParse({ localPreviewPort: port }).success).toBe(false);
    // Typed callers can still provide an object without parsing it; forwarding must fail closed.
    expect(
      localPortForBind({ ...RelayClientConfigSchema.parse({}), localPreviewPort: port }, 8443)
    ).toBeNull();
  });
});

describe('identity', () => {
  it('creates one key pair and keeps returning it', async () => {
    const directory = await temporaryDirectory();
    const first = await loadOrCreateIdentity(directory);
    const second = await loadOrCreateIdentity(directory);
    expect(second.spkiDer.toString('base64')).toBe(first.spkiDer.toString('base64'));
    // The identity is the box's address on the relay; regenerating it would silently change the
    // hostname every enrolled client is pinned to.
    expect(second.labelFor(RELAY_DOMAIN)).toBe(first.labelFor(RELAY_DOMAIN));
  });

  it('writes the private key unreadable to anyone else', async () => {
    const directory = await temporaryDirectory();
    await loadOrCreateIdentity(directory);
    const mode = (await stat(join(directory, 'relay-identity.key'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('gives the same box a different label on each relay', async () => {
    const directory = await temporaryDirectory();
    const identity = await loadOrCreateIdentity(directory);
    // Domain separation is what stops two relay operators correlating their registries.
    expect(identity.labelFor('a.example')).not.toBe(identity.labelFor('b.example'));
  });
});

describe('reconnect pacing', () => {
  it('spreads a fleet out instead of reconnecting them all at once', () => {
    // Full jitter: the delay is a draw from [0, exponential), so two boxes that lost the same relay
    // in the same millisecond do not come back in the same millisecond.
    expect(reconnectDelayMs({ attempt: 3, random: () => 0 })).toBe(0);
    expect(reconnectDelayMs({ attempt: 3, random: () => 0.999 })).toBeLessThan(8_000);
  });

  it('never exceeds the cap however long the outage runs', () => {
    expect(reconnectDelayMs({ attempt: 40, random: () => 0.999 })).toBeLessThanOrEqual(60_000);
  });

  it('honours a relay that asked for a longer wait', () => {
    // Ignoring reconnectAfterMs is how a restarting relay gets knocked over by its own fleet.
    expect(reconnectDelayMs({ attempt: 0, requestedMs: 300_000, random: () => 0 })).toBe(300_000);
    expect(
      reconnectDelayMs({ attempt: 0, requestedMs: 300_000, random: () => 0.5 })
    ).toBeGreaterThan(300_000);
  });
});
