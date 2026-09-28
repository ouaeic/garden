import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadRelayConfigFile, parseDuration, type RelayConfig } from './config.js';
import { createLogger } from './log.js';
import { Registry } from './registry.js';
import { RelayServer } from './relay.js';
import { createSelfSignedCertificate, generateIdentityKeyPair } from './x509.js';

const USAGE = `garden-relay <command> [options]

Commands:
  serve [--no-registration]          run the relay
  invite --note <text> [--ttl 24h]   mint a single-use enrollment token
  peers                              list registered peers and their usage
  revoke <label>                     delete a peer (its session is dropped immediately)
  abuse --at <time> --client-ip <ip> [--window 300] --log <file>
                                     map an abuse report back to a label
  dev-cert --host <name> --out <dir> write a self-signed relay certificate for local testing

Options:
  --config <path>   configuration file (default: $GARDEN_RELAY_CONFIG or /etc/garden-relay.json)
`;

export interface Args {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

export const parseArgs = (argv: readonly string[]): Args => {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      booleans.add(name);
    } else {
      flags.set(name, next);
      index += 1;
    }
  }
  return { positional, flags, booleans };
};

const configPath = (args: Args): string =>
  args.flags.get('config') ?? process.env.GARDEN_RELAY_CONFIG ?? '/etc/garden-relay.json';

const openRegistry = async (config: RelayConfig): Promise<Registry> =>
  Registry.open({
    path: config.registryPath,
    relayDomain: config.relayDomain,
    maxPeers: config.limits.global.maxPeers,
    registrationEnabled: config.registrationEnabled,
    defaultQuota: {
      monthlyBytes: config.defaultPeerQuota.monthlyBytes ?? config.limits.perPeer.monthlyBytes,
      maxConcurrentStreams:
        config.defaultPeerQuota.maxConcurrentStreams ?? config.limits.perPeer.concurrentStreams,
      rateBps: config.defaultPeerQuota.rateBps ?? config.limits.perPeer.rateBps
    }
  });

/**
 * Command line overrides for `serve`. `--no-registration` closes enrollment without editing the
 * config file, which is what an operator reaches for when a relay is being abused.
 */
export const applyCliOverrides = (config: RelayConfig, args: Args): RelayConfig =>
  args.booleans.has('no-registration') ? { ...config, registrationEnabled: false } : config;

const serve = async (args: Args): Promise<number> => {
  const config = applyCliOverrides(await loadRelayConfigFile(configPath(args)), args);
  const registry = await openRegistry(config);
  const logger = createLogger({ level: config.logLevel });
  const [tlsKey, tlsCert] = await Promise.all([
    readFile(config.tlsKeyPath),
    readFile(config.tlsCertPath)
  ]);
  const server = new RelayServer({ config, registry, tlsKey, tlsCert, logger });
  await server.listen();

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down');
    // Peers are told to come back after a random delay so a restart does not bring every box back
    // in the same second.
    void server
      .close()
      .then(() => registry.close())
      .then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return -1;
};

const invite = async (args: Args): Promise<number> => {
  const config = await loadRelayConfigFile(configPath(args));
  const registry = await openRegistry(config);
  const note = args.flags.get('note') ?? '';
  const ttl = args.flags.get('ttl');
  const ttlMs = ttl === undefined ? config.invite.defaultTtlMs : parseDuration(ttl);
  const { token, record } = registry.createInvite(note, ttlMs);
  await registry.close();
  process.stdout.write(`${token}\n`);
  process.stderr.write(
    `single use, expires ${new Date(record.expiresAt).toISOString()}${note ? ` (${note})` : ''}\n`
  );
  return 0;
};

const peers = async (args: Args): Promise<number> => {
  const config = await loadRelayConfigFile(configPath(args));
  const registry = await openRegistry(config);
  const rows = registry.listPeers().map((peer) => ({
    label: peer.label,
    host: `${peer.label}.${config.relayDomain}`,
    note: peer.note,
    usedMiB: Math.round((registry.peerUsage(peer.label)?.bytes ?? 0) / (1024 * 1024)),
    quotaMiB: Math.round(peer.quota.monthlyBytes / (1024 * 1024)),
    lastSeen: peer.lastSeenAt === null ? 'never' : new Date(peer.lastSeenAt).toISOString()
  }));
  await registry.close();
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  return 0;
};

const revoke = async (args: Args): Promise<number> => {
  const label = args.positional[1];
  if (label === undefined) {
    process.stderr.write('revoke needs a label\n');
    return 2;
  }
  const config = await loadRelayConfigFile(configPath(args));
  const registry = await openRegistry(config);
  const removed = registry.revoke(label);
  await registry.close();
  process.stderr.write(removed ? `revoked ${label}\n` : `no such label: ${label}\n`);
  return removed ? 0 : 1;
};

/**
 * Maps an abuse report back to a label.
 *
 * This only works if the operator enabled `logClientIps`, which is off by default. That trade is
 * the point: the relay cannot inspect content, so revocation is the only lever, and the ability to
 * pull that lever costs the operator's users their address privacy.
 */
const abuse = async (args: Args): Promise<number> => {
  const at = args.flags.get('at');
  const clientIp = args.flags.get('client-ip');
  const logPath = args.flags.get('log');
  if (at === undefined || clientIp === undefined || logPath === undefined) {
    process.stderr.write('abuse needs --at, --client-ip and --log\n');
    return 2;
  }
  const windowSeconds = Number.parseInt(args.flags.get('window') ?? '300', 10);
  const target = /^\d+$/.test(at) ? Number.parseInt(at, 10) : Date.parse(at);
  if (Number.isNaN(target)) {
    process.stderr.write(`unparseable timestamp: ${at}\n`);
    return 2;
  }

  const matches: unknown[] = [];
  const input = createInterface({ input: createReadStream(logPath) });
  for await (const line of input) {
    if (!line.includes(clientIp)) continue;
    let record: { t?: unknown; ip?: unknown; label?: unknown; cid?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (record.ip !== clientIp || typeof record.t !== 'string') continue;
    if (Math.abs(Date.parse(record.t) - target) > windowSeconds * 1000) continue;
    matches.push({ t: record.t, label: record.label, cid: record.cid });
  }
  process.stdout.write(`${JSON.stringify(matches, null, 2)}\n`);
  return matches.length > 0 ? 0 : 1;
};

const devCert = async (args: Args): Promise<number> => {
  const host = args.flags.get('host');
  const out = args.flags.get('out') ?? '.';
  if (host === undefined) {
    process.stderr.write('dev-cert needs --host\n');
    return 2;
  }
  const { privateKey } = generateIdentityKeyPair();
  const certificate = createSelfSignedCertificate({
    privateKey,
    commonName: host,
    dnsNames: [host, `*.${host}`],
    validForDays: 365
  });
  await writeFile(join(out, 'relay-key.pem'), certificate.keyPem, { mode: 0o600 });
  await writeFile(join(out, 'relay-cert.pem'), certificate.certPem);
  process.stderr.write(
    `wrote relay-key.pem and relay-cert.pem for ${host}\n` +
      'this certificate is for local testing only - browsers will not trust it\n'
  );
  return 0;
};

export const run = async (argv: readonly string[]): Promise<number> => {
  const args = parseArgs(argv);
  switch (args.positional[0]) {
    case 'serve':
      return serve(args);
    case 'invite':
      return invite(args);
    case 'peers':
      return peers(args);
    case 'revoke':
      return revoke(args);
    case 'abuse':
      return abuse(args);
    case 'dev-cert':
      return devCert(args);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
};

// `import.meta.main` is Node 24; guards the CLI from running when the module is imported by tests.
if (import.meta.main) {
  const code = await run(process.argv.slice(2));
  if (code >= 0) process.exit(code);
}
