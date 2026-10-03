import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * One answer to "is this address out on the internet, or is it something of ours". Every fetch the
 * server or the agent makes on behalf of untrusted input has to ask it - a connector endpoint, a
 * page the agent was told to read, a browser navigation - and answering it in three places is how
 * one of them ends up missing 169.254.0.0/16 and handing out the instance credentials.
 *
 * Everything reserved is refused rather than only the obviously local ranges: documentation and
 * benchmarking blocks are not routable, so a name resolving to one is a redirection trick rather
 * than a destination.
 */
const isPublicIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [a = 0, b = 0, c = 0] = parts;
  return !(
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast and reserved
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, where cloud metadata lives
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) || // IETF protocol assignments and TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) // TEST-NET-3
  );
};

/**
 * Global unicast, decided by subnet arithmetic rather than by how the address is spelled.
 *
 * Allowed by inclusion: 2000::/3 is the internet and nothing else is, so listing the bad prefixes
 * instead would leave every block IANA has not yet assigned reachable until somebody remembered to
 * add it. That part was already right; how it was decided was not. `startsWith('2')` is a test on
 * text, and `2::1` - which is 0002:: and nowhere near 2000::/3 - passes it.
 */
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet('2000::', 3, 'ipv6');

/**
 * Inside global unicast and still not a destination.
 *
 * 6to4 and Teredo are the ones that matter, and they are the exact thing this file exists to stop:
 * both carry an IPv4 address in their own bits, so `2002:a9fe:a9fe::` is a spelling of
 * 169.254.169.254 - the cloud metadata service - that walks through a check looking only at the
 * front of the string. A relay that honours them turns one refused address into a reachable one.
 */
const RESERVED_WITHIN_UNICAST = new BlockList();
RESERVED_WITHIN_UNICAST.addSubnet('2001::', 32, 'ipv6'); // Teredo, carries an IPv4 address
RESERVED_WITHIN_UNICAST.addSubnet('2002::', 16, 'ipv6'); // 6to4, carries an IPv4 address
RESERVED_WITHIN_UNICAST.addSubnet('2001:db8::', 32, 'ipv6'); // documentation, not routable
RESERVED_WITHIN_UNICAST.addSubnet('2001:10::', 28, 'ipv6'); // ORCHID, not routable
RESERVED_WITHIN_UNICAST.addSubnet('2001:2::', 48, 'ipv6'); // benchmarking

export const isPublicInternetAddress = (raw: string): boolean => {
  const address = raw.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicIpv4(mapped);
  return GLOBAL_UNICAST.check(address, 'ipv6') && !RESERVED_WITHIN_UNICAST.check(address, 'ipv6');
};

/**
 * Which of these suffixes the host actually sits under, or null when none does - the longest one
 * when several match, because a name under both `example.com` and `docs.example.com` adds nothing
 * beyond the second and charging it for `docs` would be charging it twice.
 *
 * The egress classifier needs the answer rather than a yes or no: it measures what a hostname adds
 * beyond the part that was already allowed, and a fourth private idea of what `example.com` covers
 * is exactly the drift this file exists to prevent.
 */
export const matchingHostSuffix = (host: string, suffixes: readonly string[]): string | null =>
  suffixes
    .map((suffix) => suffix.trim().toLowerCase().replace(/^\./, ''))
    .filter((suffix) => suffix.length > 0 && (host === suffix || host.endsWith(`.${suffix}`)))
    .sort((left, right) => right.length - left.length)[0] ?? null;

/**
 * "Is this host one the deployment allows" - the suffix match every connector asks before it lets
 * a credential leave. It lives here beside the address checks so that mail, WebDAV and MCP cannot
 * drift into three subtly different ideas of what `example.com` covers.
 */
export const hostMatchesSuffix = (host: string, suffixes: string[]): boolean =>
  matchingHostSuffix(host, suffixes) !== null;

/** Names that resolve inside the machine or the estate even though they are not IP literals. */
const isInternalHostname = (host: string): boolean =>
  !host ||
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  host === 'metadata.google.internal' ||
  host.endsWith('.local') ||
  host.endsWith('.internal') ||
  host.endsWith('.home.arpa');

/**
 * The IPv4 address inside an IPv4-mapped IPv6 one, in either spelling, or null.
 *
 * Both spellings, because only one of them survives a `URL`. `new URL('http://[::ffff:127.0.0.1]/')`
 * reports its hostname as `[::ffff:7f00:1]` - the same address written in hex - so a reader that
 * only knows the dotted form is a reader that never sees the form its own callers hand it. That is
 * how `::ffff:127.0.0.1` was recognised as loopback in a unit test and not in the browser.
 */
const mappedIpv4 = (host: string): string | null => {
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted?.[1]) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = Number.parseInt(hex[1] ?? '', 16);
  const low = Number.parseInt(hex[2] ?? '', 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
};

/**
 * This process's own output, and nothing else.
 *
 * Held apart from `isInternalHostname` because the two answer opposite questions. That one asks
 * "could this resolve somewhere off the public internet", a wide set where being generous is safe.
 * This asks "is this address this very computer", a tiny set where being generous is the whole
 * hole: the owner's NAS, their router and the cloud metadata service are all reachable without
 * leaving the estate, and every one of them is somebody else's machine.
 *
 * 127.0.0.0/8 entire, not 127.0.0.1 alone - a resolver stub on 127.0.0.53 is still this computer -
 * and the IPv4-mapped spelling is unwrapped first so `::ffff:127.0.0.1` cannot walk past it.
 */
const isLoopbackHost = (host: string): boolean => {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(mappedIpv4(host) ?? host) || host === '::1';
};

/**
 * Where an address is, relative to this computer. Three answers, because with two the middle one
 * is given the wrong half of the pair.
 *
 * `isPublicHttpUrl` answers "is this out on the internet", which is not "is this somewhere data can
 * go" or "is this somebody else's machine". It is false for loopback and equally false for all of
 * RFC1918, carrier-grade NAT, link-local, `*.local`, `*.internal` and `*.home.arpa` - so
 * `http://192.168.1.50/notes` and `http://127.0.0.1:5173/health` get the same answer from it, and
 * on a self-hosted box the first is the owner's NAS and the second is this process talking to
 * itself.
 *
 * - `self` is loopback: this process's own output, which is not a destination and not a source of
 *   anybody else's bytes.
 * - `estate` is everything reserved that is not loopback, plus a name that resolves inside the
 *   estate: another computer, reachable without leaving the building, and where an unauthenticated
 *   admin interface lives.
 * - `internet` is the public unicast address space.
 *
 * FAILS TOWARDS `estate`, deliberately. An address that will not parse, or that carries a scheme
 * this cannot reason about, is not this computer and is not known to be the internet - and of the
 * three answers `estate` is the one whose callers charge for it rather than clear it.
 */
export type NetworkReach = 'self' | 'estate' | 'internet';

export const reachOfHttpUrl = (raw: string): NetworkReach => {
  let host: string;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return 'estate';
    host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return 'estate';
  }
  /*
   * A name that ends in the DNS root label is the same name, and this is the one place that fact
   * can be held for every caller at once.
   *
   * `getaddrinfo` accepts `localhost.` and answers 127.0.0.1, so the two spellings reach one host -
   * and `isPublicHttpUrl` said TRUE for `http://localhost./`, `http://wiki.internal./x` and
   * `http://metadata.google.internal./x`, because a trailing dot walks past every suffix test
   * below it. `assertPublicHttpUrl` catches that on the resolving path, but `agentReachablePage` -
   * the synchronous check the browser makes on the page it is about to read back - does not, so
   * one character turned the browser's destination guard off for the estate. Two other files had
   * already grown their own copy of this normalisation for the same measured reason; this is where
   * it belongs.
   */
  if (host.length > 1 && host.endsWith('.')) host = host.slice(0, -1);
  if (isLoopbackHost(host)) return 'self';
  if (isInternalHostname(host)) return 'estate';
  return !isIP(host) || isPublicInternetAddress(host) ? 'internet' : 'estate';
};

/**
 * Rejects `file:`, `chrome:` and every other scheme before the host is even considered: a reader
 * that only guards addresses still hands over /etc/passwd.
 *
 * One arm of `reachOfHttpUrl` rather than a second walk of the same lists, so that the question
 * every SSRF caller asks and the question the egress budget asks cannot drift apart - which is the
 * drift this whole file exists to prevent, and which had already happened inside it once.
 */
export const isPublicHttpUrl = (raw: string): boolean => reachOfHttpUrl(raw) === 'internet';

/**
 * The unspecified address, in every spelling that reaches a bind call: `0.0.0.0`, `::`, the padded
 * IPv6 forms, and the IPv4-mapped `::ffff:0.0.0.0`. An empty operand is here too because a bind
 * argument that was never given is the same request - `--bind` with nothing after it, and the
 * servers whose default is every interface, both arrive as "no address stated".
 */
const isUnspecifiedAddress = (host: string): boolean => {
  if (host === '' || host === '*') return true;
  const unwrapped = mappedIpv4(host) ?? host;
  if (unwrapped === '0.0.0.0') return true;
  return isIP(unwrapped) === 6 && /^[0:]+$/.test(unwrapped) && unwrapped.includes(':');
};

/**
 * Who can reach a socket this computer is about to open, which is NOT `reachOfHttpUrl` with the
 * arrow turned round.
 *
 * The two questions share the address space and nothing else, and the difference is the whole
 * reason this exists separately. Outbound, `0.0.0.0` is a malformed destination and the safe way
 * to be wrong is to call an unreadable address `estate` and charge for it. Inbound, `0.0.0.0` is
 * the WIDEST answer available - every interface the box has, which on a self-hosted install is a
 * public one - and the safe way to be wrong is `internet`. So this fails towards `internet` where
 * its outbound twin fails towards `estate`: for an address that will not parse, and for the
 * unspecified address that `isPublicInternetAddress` calls non-public because as a destination it
 * means "this network".
 *
 * That last clause is the measured defect. A service was declared with `--bind 0.0.0.0`, and the
 * only reach vocabulary in the tree answered `estate` for it, because 0.0.0.0/8 is reserved.
 * The port was open to the internet on a box with no firewall.
 *
 * - `self` is a loopback bind: only this computer, which is what a preview is for. The preview
 *   proxy connects to `127.0.0.1` (services/workspace-runner/src/preview.ts), so loopback is not
 *   merely safe here, it is the binding that the publishing path is built on.
 * - `estate` is a bind to one reserved, non-loopback address: reachable from the building.
 * - `internet` is a public address, a name this cannot resolve, or every interface at once.
 */
export const reachOfBindAddress = (raw: string): NetworkReach => {
  let host = raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (host.length > 1 && host.endsWith('.')) host = host.slice(0, -1);
  if (isUnspecifiedAddress(host)) return 'internet';
  if (isLoopbackHost(host)) return 'self';
  if (isInternalHostname(host)) return 'estate';
  return !isIP(host) || isPublicInternetAddress(host) ? 'internet' : 'estate';
};

/**
 * The syntactic check plus the one it cannot make: a name the caller controls can point anywhere,
 * so every address it resolves to has to be public before the request is allowed to leave. Callers
 * that then make the request themselves must pin these addresses or re-check after redirects -
 * resolving twice is a race an attacker gets to win.
 */
export const assertPublicHttpUrl = async (raw: string): Promise<void> => {
  if (!isPublicHttpUrl(raw)) throw new Error('Address is not a public HTTP(S) URL');
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicInternetAddress(address)))
    throw new Error('Address resolves to a private, reserved, or local address');
};
