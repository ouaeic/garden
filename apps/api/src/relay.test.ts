import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { RelayStatus } from '@athanor/relay-client';
import type { ApiConfig } from './config.js';
import { silentLogger } from './log.js';
import {
  RelaySupervisor,
  readRelaySettings,
  withRelayEndpoint,
  type RelayLink,
  type RelaySupervisorOptions
} from './relay.js';
import { buildServer } from './server.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
});

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

/**
 * Waits until the supervisor's reaction to a status is actually on disk.
 *
 * The supervisor is told about a status through a callback that returns `void` - `relay.ts` does
 * `void this.#onStatus(status)` - so a caller has no promise to await, and the reaction is three
 * awaited filesystem operations deep: an mkdir, a writeFile and a rename, in `#recordRevocation`
 * and again in `#publishStatus`. This waits for the result of that work rather than for a fixed
 * number of ticks, and it also waits for the atomic writes' temporary files to be gone, because a
 * `.tmp` still in flight when `afterEach` removes the directory is what produced the second half
 * of the failure ("ENOTEMPTY: directory not empty").
 */
const settled = async (
  directory: string,
  done: (settings: Awaited<ReturnType<typeof readRelaySettings>>) => boolean
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const pending = (await readdir(directory).catch(() => [])).some((name) =>
      name.endsWith('.tmp')
    );
    if (!pending && done(await readRelaySettings(directory))) return;
    if (Date.now() > deadline)
      throw new Error('the supervisor never wrote the revocation to the settings file');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** A dialer that records what it was asked to do instead of opening a connection. */
class FakeLink implements RelayLink {
  started = 0;
  stopped = 0;
  status: RelayStatus;
  readonly #onStatus: (status: RelayStatus) => void;
  readonly #settle: () => Promise<void>;

  constructor(
    label: string | null,
    host: string | null,
    onStatus: (status: RelayStatus) => void = () => undefined,
    settle: () => Promise<void> = async () => undefined
  ) {
    this.#onStatus = onStatus;
    this.#settle = settle;
    this.status = {
      state: 'off',
      label,
      hostname: label && host ? `${label}.${host}` : null,
      openStreams: 0,
      usedBytes: 0,
      quota: null,
      previewPort: null,
      lastError: null,
      nextAttemptAtMs: null
    };
  }

  start(): void {
    this.started += 1;
    this.status = { ...this.status, state: 'online' };
  }

  stop(): void {
    this.stopped += 1;
    this.status = { ...this.status, state: 'off' };
  }

  /**
   * What a real dialer reports when the relay answers `goaway reason=revoked`: the operator has
   * dropped this box, so the connection is gone and is deliberately never retried.
   */
  async revoke(): Promise<void> {
    this.status = {
      ...this.status,
      state: 'revoked',
      lastError: 'relay sent goaway (revoked)',
      nextAttemptAtMs: null
    };
    this.#onStatus(this.status);
    /*
     * This used to be one `setTimeout(…, 0)`, under a comment saying it gave the supervisor's file
     * writes "a turn". One macrotask is not a turn: the write is two filesystem round trips past
     * where the tick returns, so the assertion below it read the settings file before the
     * revocation reached it. On an idle machine the write happened to win the race and the suite
     * was green; run beside the other eleven packages it lost, and the red read as "the supervisor
     * does not persist a revocation" - a defect in shipped code - rather than as "the test looked
     * too early". Reproduced deliberately by putting eight writer processes on the same temporary
     * filesystem, which fails it every time.
     */
    await this.#settle();
  }
}

const supervisorOn = (
  directory: string,
  links: FakeLink[],
  overrides: Partial<RelaySupervisorOptions> = {}
): RelaySupervisor =>
  new RelaySupervisor({
    directory,
    localHost: '127.0.0.1',
    localPort: 8443,
    localHttpPort: 8080,
    localPreviewPort: 8444,
    log: silentLogger,
    createLink: async (config, onStatus) => {
      const link = new FakeLink(config.label, config.host, onStatus, () =>
        settled(directory, (settings) => settings.revokedAt !== null)
      );
      links.push(link);
      return link;
    },
    redeemToken: async (request) => ({
      label: `label-for-${request.host}`,
      pinnedRelaySpkiSha256: 'pinned-relay-key'
    }),
    ...overrides
  });

describe('a box ships with no relay', () => {
  test('makes no connection and advertises no relay address until it is told to', async () => {
    const directory = await temporaryDirectory('athanor-relay-off-');
    const links: FakeLink[] = [];
    const relay = supervisorOn(directory, links);
    await relay.start();

    expect(relay.report().enabled).toBe(false);
    expect(relay.report().host).toBeNull();
    expect(relay.publicHostname()).toBeNull();
    // Nothing dialled, and nothing registered anywhere: this is the shipped state.
    expect(links).toHaveLength(0);
    expect(relay.status.state).toBe('off');
  });

  test('reads a torn or hand-edited settings file as off rather than as a live relay', async () => {
    const directory = await temporaryDirectory('athanor-relay-torn-');
    await writeFile(join(directory, 'settings.json'), '{"enabled": true, "host": ');
    const links: FakeLink[] = [];
    const relay = supervisorOn(directory, links);
    await relay.start();
    expect(relay.report().enabled).toBe(false);
    expect(links).toHaveLength(0);
  });

  test('will not dial an enrollment that carries no pinned relay key', async () => {
    const directory = await temporaryDirectory('athanor-relay-unpinned-');
    // Exactly what a settings file written before pinning existed, or edited by hand through the
    // `jq` path in `scripts/athanor`, parses to: enabled, addressable, and trusting nobody.
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({ enabled: true, host: 'relay.example.com', label: 'abc' })
    );
    const links: FakeLink[] = [];
    const relay = supervisorOn(directory, links);
    await relay.start();

    // The identity key is this box's address. Presenting it to whoever currently answers for the
    // hostname, with no CA and no pin, hands that party every client connection.
    expect(links).toHaveLength(0);
    expect(relay.status.state).toBe('off');
    // And nothing is advertised, because nothing is connected.
    expect(relay.publicHostname()).toBeNull();
  });
});

describe('turning the relay on', () => {
  test.each([undefined, 9445])(
    'starts an existing enrollment with runtime listener options despite stored preview port %s',
    async (storedPreviewPort) => {
      const directory = await temporaryDirectory('garden-relay-preview-upgrade-');
      await writeFile(
        join(directory, 'settings.json'),
        JSON.stringify({
          enabled: true,
          host: 'relay.example',
          label: 'enrolled',
          pinnedRelaySpkiSha256: 'pinned-relay-key',
          localPort: 8443,
          localHttpPort: 8080,
          localPreviewPort: storedPreviewPort
        })
      );
      const links: FakeLink[] = [];
      const seen: unknown[] = [];
      const relay = supervisorOn(directory, links, {
        localPreviewPort: 9444,
        createLink: async (config, onStatus) => {
          seen.push(config);
          const link = new FakeLink(config.label, config.host, onStatus);
          links.push(link);
          return link;
        }
      });
      await relay.start();
      expect(links).toHaveLength(1);
      expect(links[0]?.started).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        localPort: 8443,
        localHttpPort: 8080,
        localPreviewPort: 9444,
        enabled: true,
        label: 'enrolled',
        pinnedRelaySpkiSha256: 'pinned-relay-key'
      });
      expect(relay.publicHostname()).toBe('enrolled.relay.example');
      relay.close();
    }
  );

  test('records the label and the pinned relay key, and dials', async () => {
    const directory = await temporaryDirectory('athanor-relay-on-');
    const links: FakeLink[] = [];
    const relay = supervisorOn(directory, links);
    await relay.start();

    const report = await relay.enroll({ host: 'relay.example.com', token: 'arly1_token' });
    expect(report.enabled).toBe(true);
    expect(report.label).toBe('label-for-relay.example.com');
    expect(report.hostname).toBe('label-for-relay.example.com.relay.example.com');
    // The pin is the whole defence against the relay's hostname changing hands later.
    expect(report.pinnedRelaySpkiSha256).toBe('pinned-relay-key');
    expect(report.enrolledAt).not.toBeNull();
    expect(links).toHaveLength(1);
    expect(links[0]!.started).toBe(1);

    const persisted = await readRelaySettings(directory);
    expect(persisted.enabled).toBe(true);
    expect(persisted.label).toBe('label-for-relay.example.com');
    expect(persisted.pinnedRelaySpkiSha256).toBe('pinned-relay-key');
    // The local ports come from this server's own configuration, never from the request body.
    expect(persisted.localPort).toBe(8443);
    expect(persisted.localHttpPort).toBe(8080);
  });

  test('comes back on after a restart without being told again', async () => {
    const directory = await temporaryDirectory('athanor-relay-restart-');
    const first = supervisorOn(directory, []);
    await first.start();
    await first.enroll({ host: 'relay.example.com', token: 'arly1_token' });
    first.close();

    const links: FakeLink[] = [];
    const second = supervisorOn(directory, links);
    await second.start();
    expect(links).toHaveLength(1);
    expect(links[0]!.started).toBe(1);
    expect(second.publicHostname()).toBe('label-for-relay.example.com.relay.example.com');
  });

  test('writes the live state where a root shell can read it', async () => {
    const directory = await temporaryDirectory('athanor-relay-status-');
    const relay = supervisorOn(directory, []);
    await relay.start();
    await relay.enroll({ host: 'relay.example.com', token: 'arly1_token' });
    const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')) as {
      state: string;
      hostname: string;
    };
    // `athanor doctor` has no session and still has to be able to say what the relay is doing.
    expect(status.state).toBe('online');
    expect(status.hostname).toBe('label-for-relay.example.com.relay.example.com');
  });
});

describe('turning the relay off', () => {
  test('closes the connection and stops advertising the address', async () => {
    const directory = await temporaryDirectory('athanor-relay-off-again-');
    const links: FakeLink[] = [];
    const relay = supervisorOn(directory, links);
    await relay.start();
    await relay.enroll({ host: 'relay.example.com', token: 'arly1_token' });

    const report = await relay.disable();
    expect(report.enabled).toBe(false);
    expect(links[0]!.stopped).toBe(1);
    expect(relay.status.state).toBe('off');
    // Advertising an address that no longer answers costs every client a failed attempt.
    expect(relay.publicHostname()).toBeNull();
    expect(withRelayEndpoint(['https://203.0.113.9'], relay.publicHostname())).toEqual([
      'https://203.0.113.9'
    ]);
    // The enrollment is kept, so turning it back on does not need another token.
    expect(report.label).toBe('label-for-relay.example.com');
    expect((await readRelaySettings(directory)).enabled).toBe(false);

    const back = await relay.enable();
    expect(back.enabled).toBe(true);
    expect(links).toHaveLength(2);
  });

  test('applies two changes one at a time rather than leaving a connection adrift', async () => {
    const directory = await temporaryDirectory('athanor-relay-race-');
    const links: FakeLink[] = [];
    const relay = supervisorOn(directory, links);
    await relay.start();
    await relay.enroll({ host: 'relay.example.com', token: 'arly1_token' });

    await Promise.all([relay.disable(), relay.enable()]);

    // Whichever order they land in, every connection but the last has been stopped. Two changes
    // running at once could otherwise each start one and leave the loser dialling unheld - a relay
    // the owner switched off that carries on answering.
    const live = links.filter((link) => link.started > link.stopped);
    expect(live).toHaveLength(relay.settings.enabled ? 1 : 0);
  });

  test('a revoked enrollment stops being advertised, on disk as well as in memory', async () => {
    const directory = await temporaryDirectory('athanor-relay-revoked-');
    const links: FakeLink[] = [];
    const relay = supervisorOn(directory, links);
    await relay.start();
    await relay.enroll({ host: 'relay.example.com', token: 'arly1_token' });
    expect(relay.publicHostname()).toBe('label-for-relay.example.com.relay.example.com');

    await links[0]!.revoke();

    // The relay has dropped this box and the dialer will never retry, so every client that tries
    // the relay address pays a connection attempt for a name that cannot answer again.
    expect(relay.status.state).toBe('revoked');
    expect(relay.publicHostname()).toBeNull();
    expect(withRelayEndpoint(['https://203.0.113.9'], relay.publicHostname())).toEqual([
      'https://203.0.113.9'
    ]);

    // `athanor-network-refresh` reads the settings file and nothing else, so a revocation that
    // lived only in memory would leave the address in the connection manifest anyway.
    expect((await readRelaySettings(directory)).revokedAt).not.toBeNull();
    // And it survives a restart: the status file has not been read yet at that point, so without
    // the settings file the box would advertise the dead address until the first goaway arrived.
    const restarted = supervisorOn(directory, []);
    await restarted.start();
    expect(restarted.publicHostname()).toBeNull();

    // `athanor doctor` still has to be able to say revoked rather than "off, and that is fine",
    // and that branch is only reached while the settings say the relay is switched on.
    expect(restarted.report().enabled).toBe(true);
    expect(restarted.report().label).toBe('label-for-relay.example.com');
  });

  test('enrolling again with a fresh token clears the revocation', async () => {
    const directory = await temporaryDirectory('athanor-relay-reenroll-');
    const links: FakeLink[] = [];
    const relay = supervisorOn(directory, links);
    await relay.start();
    await relay.enroll({ host: 'relay.example.com', token: 'arly1_token' });
    await links[0]!.revoke();
    expect(relay.publicHostname()).toBeNull();

    // A fresh token is the operator putting this box back in the registry, so the address it hands
    // out is live again and refusing to advertise it would strand the owner.
    await relay.enroll({ host: 'relay.example.com', token: 'arly1_second_token' });
    expect(relay.publicHostname()).toBe('label-for-relay.example.com.relay.example.com');
    expect((await readRelaySettings(directory)).revokedAt).toBeNull();
  });

  test('forgetting the relay clears the host, the label and the pin', async () => {
    const directory = await temporaryDirectory('athanor-relay-forget-');
    const relay = supervisorOn(directory, []);
    await relay.start();
    await relay.enroll({ host: 'relay.example.com', token: 'arly1_token' });

    const report = await relay.forget();
    expect(report.host).toBeNull();
    expect(report.label).toBeNull();
    expect(report.pinnedRelaySpkiSha256).toBeNull();
    expect((await readRelaySettings(directory)).host).toBeNull();
  });
});

describe('what the box advertises', () => {
  test('advertises only an online negotiated preview listener on its enrolled hostname', async () => {
    const directory = await temporaryDirectory('garden-relay-preview-origin-');
    const links: FakeLink[] = [];
    const relay = supervisorOn(directory, links);
    await relay.start();
    expect(relay.publicPreviewOrigin()).toBeNull();
    await relay.enroll({ host: 'relay.example.com', token: 'arly1_token' });
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(relay.publicPreviewOrigin()).toBeNull();
    link.status = { ...link.status, previewPort: 9443 };
    expect(relay.publicPreviewOrigin()).toBe(
      'https://label-for-relay.example.com.relay.example.com:9443'
    );
    for (const port of [null, 0, 80, 443, 65_536, 1.5, NaN]) {
      link.status = { ...link.status, previewPort: port };
      expect(relay.publicPreviewOrigin(), `port ${port}`).toBeNull();
    }
    for (const state of ['off', 'connecting', 'waiting', 'revoked'] as const) {
      link.status = { ...link.status, state, previewPort: 9443 };
      expect(relay.publicPreviewOrigin(), state).toBeNull();
    }
    link.status = { ...link.status, state: 'online', previewPort: 9443 };
    await relay.disable();
    expect(relay.publicPreviewOrigin()).toBeNull();
  });

  test('offers the relay last, and only once', () => {
    const direct = ['https://box.example.net', 'https://203.0.113.9'];
    expect(withRelayEndpoint(direct, 'abc.relay.example.com')).toEqual([
      ...direct,
      'https://abc.relay.example.com'
    ]);
    expect(
      withRelayEndpoint([...direct, 'https://abc.relay.example.com'], 'abc.relay.example.com')
    ).toEqual([...direct, 'https://abc.relay.example.com']);
    expect(withRelayEndpoint(direct, null)).toEqual(direct);
  });
});

const testConfig = (directory: string): ApiConfig => ({
  DEPLOYMENT_MODE: 'development',
  MODEL_CATALOG_SCOPE: 'provider_catalog',
  CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
  ATHANOR_STATE_PATH: directory,
  RELAY_STATE_DIR: join(directory, 'relay'),
  RELAY_LOCAL_HOST: '127.0.0.1',
  RELAY_LOCAL_PORT: 8443,
  RELAY_LOCAL_HTTP_PORT: 8080,
  RELAY_LOCAL_PREVIEW_PORT: 8444,
  PUBLIC_APP_URL: 'http://localhost:5173',
  PREVIEW_BASE_URL: 'http://preview.localhost:4400',
  API_HOST: '127.0.0.1',
  API_PORT: 4131,
  PREVIEW_GATEWAY_HOST: '127.0.0.1',
  PREVIEW_GATEWAY_PORT: 4431,
  RESERVED_PREVIEW_PORTS: '4131,4431',
  DATABASE_DRIVER: 'pglite',
  DATABASE_URL: 'postgres://unused',
  PGLITE_PATH: join(directory, 'database'),
  DATA_MASTER_KEY: Buffer.alloc(32, 13).toString('base64'),
  SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
  RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
  WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
  PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
  WORKSPACE_IMAGE_REVISION: 'dev',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'athanor Test',
  WEBAUTHN_ORIGIN: 'http://localhost:5173',
  ALLOW_INSECURE_DEV_AUTH: true,
  WORKER_ID: 'relay-test-worker',
  // No agent runs behind these: they assert the API's own answers, not the agent's.
  EMBEDDED_WORKER: false,
  WORKER_CONCURRENCY: 1,
  WORKER_POLL_MS: 60_000,
  SCHEDULER_POLL_MS: 600_000,
  TASK_MAX_STEPS: 3,
  // Off: every expectation in this file describes a turn that stops at its step ceiling.
  TASK_MAX_SELF_CONTINUATIONS: 0,
  SECURITY_EVENT_RETENTION_DAYS: 30,
  LOG_LEVEL: 'silent',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_PROVIDER: 'openrouter',
  AI_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_REQUIRE_ZDR: true,
  AI_FORCE_INHOUSE_WEB: false,
  ALLOW_INSECURE_PROVIDER_URLS: false,
  CONNECTOR_ALLOWED_HOST_SUFFIXES: '',
  PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com'
});

describe('the relay routes an owner uses', () => {
  test('enroll, appear in a device ticket, then disappear when switched off', async () => {
    const directory = await temporaryDirectory('athanor-relay-api-');
    await writeFile(
      join(directory, 'connection.json'),
      JSON.stringify({ endpoints: ['https://203.0.113.9'], identity: 'sha256/box' })
    );
    const relay = supervisorOn(join(directory, 'relay'), []);
    const { app, previewApp, database } = await buildServer(testConfig(directory), { relay });
    disposers.push(async () => {
      await app.close().catch(() => undefined);
      await previewApp.close().catch(() => undefined);
      await database.close().catch(() => undefined);
    });

    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';', 1)[0]!;

    const before = await app.inject({ method: 'GET', url: '/v1/relay', headers: { cookie } });
    expect(before.json<{ enabled: boolean }>().enabled).toBe(false);

    // Turning it on before there is an enrollment has nothing to dial, so it is refused rather
    // than left half-configured and reconnecting at a host that will never answer.
    const premature = await app.inject({
      method: 'PATCH',
      url: '/v1/relay',
      headers: { cookie },
      payload: { enabled: true }
    });
    expect(premature.statusCode).toBe(422);
    expect(premature.json<{ error: { code: string } }>().error.code).toBe('relay_not_enrolled');

    const enrolled = await app.inject({
      method: 'POST',
      url: '/v1/relay/enrollment',
      headers: { cookie, 'idempotency-key': 'relay-enrollment-0001' },
      payload: { host: 'relay.example.com', token: 'arly1_token' }
    });
    expect(enrolled.statusCode).toBe(200);
    expect(enrolled.json<{ hostname: string }>().hostname).toBe(
      'label-for-relay.example.com.relay.example.com'
    );

    const ticketOn = await app.inject({
      method: 'POST',
      url: '/v1/devices/enrollments',
      headers: { cookie, 'idempotency-key': 'relay-device-0001' },
      payload: { label: 'Phone' }
    });
    const decode = (uri: string): Record<string, unknown> =>
      JSON.parse(
        Buffer.from(uri.replace(/^(?:garden|athanor):\/\/pair\//, ''), 'base64url').toString('utf8')
      ) as Record<string, unknown>;
    const ticket = decode(ticketOn.json<{ uri: string }>().uri);
    expect(ticket.endpoints).toEqual([
      'https://203.0.113.9',
      'https://label-for-relay.example.com.relay.example.com'
    ]);
    /**
     * The client refuses a ticket whose version it does not know, and refuses one carrying a field
     * it has never heard of. This one used to be version 1 with the code under a name of its own
     * and no expiry, so the QR code the settings screen draws could not be imported by anything.
     * Asserted field by field, because every one of them is a rule on the other side.
     */
    expect(Object.keys(ticket).sort()).toEqual([
      'discovery',
      'endpoints',
      'expiresAt',
      'identity',
      'pairingCode',
      'version'
    ]);
    expect(ticket.version).toBe(2);
    expect(ticket.identity).toBe('sha256/box');
    expect(ticket.discovery).toEqual({ mdnsService: '_athanor._tcp.local', mdnsPort: 443 });
    // Between 20 and 128 characters of base64url, which is the code the client will accept.
    expect(ticket.pairingCode).toMatch(/^[A-Za-z0-9_-]{20,128}$/);
    // Whole seconds since the epoch, and still in the future, so the client can say "expired"
    // itself instead of finding out from the server.
    expect(Number.isInteger(ticket.expiresAt)).toBe(true);
    expect(ticket.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const off = await app.inject({
      method: 'PATCH',
      url: '/v1/relay',
      headers: { cookie },
      payload: { enabled: false }
    });
    expect(off.json<{ enabled: boolean }>().enabled).toBe(false);

    const ticketOff = await app.inject({
      method: 'POST',
      url: '/v1/devices/enrollments',
      headers: { cookie, 'idempotency-key': 'relay-device-0002' },
      payload: { label: 'Phone' }
    });
    // Switching the relay off has to stop the box handing the address out, in the same act.
    expect(decode(ticketOff.json<{ uri: string }>().uri).endpoints).toEqual([
      'https://203.0.113.9'
    ]);

    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/relay/enrollment',
      headers: { cookie, 'idempotency-key': 'relay-enrollment-0002' },
      payload: { host: '203.0.113.10', token: 'arly1_token' }
    });
    // A relay is reached by name: the label lives under its domain and the certificate is for a
    // name, so an address here could never work.
    expect(rejected.statusCode).toBe(400);
    // Builds a database and a whole API of its own, so it gets the same generous timeout the other
    // suites that do give theirs.
  }, 30_000);
});
