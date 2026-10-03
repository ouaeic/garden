import { describe, expect, it } from 'vitest';
import {
  hostMatchesSuffix,
  isPublicHttpUrl,
  isPublicInternetAddress,
  matchingHostSuffix,
  reachOfHttpUrl,
  reachOfBindAddress
} from './network-scope.js';

describe('public internet addresses', () => {
  it('accepts routable addresses and refuses everything reserved', () => {
    expect(isPublicInternetAddress('93.184.216.34')).toBe(true);
    expect(isPublicInternetAddress('2606:4700:4700::1111')).toBe(true);
    for (const address of [
      '0.0.0.0',
      '10.0.0.2',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.5',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.4',
      '203.0.113.8',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
      // Not assigned to anyone. Global unicast is 2000::/3, so this is reachable only through a
      // list of known-bad prefixes that has to be maintained; it is refused by not being allowed.
      '4000::1',
      '0100::1'
    ])
      expect({ address, public: isPublicInternetAddress(address) }).toEqual({
        address,
        public: false
      });
  });
});

describe('IPv6 that is spelled like the internet and is not', () => {
  /*
   * A check like `startsWith('2') || startsWith('3')` is a test on text rather than on the
   * address. Two ways that is wrong, and one of them is the thing this file exists to stop.
   */
  it('refuses transition addresses that carry an IPv4 address inside them', () => {
    // 2002:a9fe:a9fe:: IS 169.254.169.254 - the cloud metadata service - written as 6to4. A relay
    // that honours it turns the one address every SSRF guard blocks into a reachable one.
    expect(isPublicInternetAddress('2002:a9fe:a9fe::')).toBe(false);
    expect(isPublicInternetAddress('2002:7f00:1::')).toBe(false); // 127.0.0.1
    expect(isPublicInternetAddress('2002:c0a8:1::')).toBe(false); // 192.168.0.1
    // Teredo does the same thing with a different prefix.
    expect(isPublicInternetAddress('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(false);
  });

  it('refuses an address that merely starts with the right digit', () => {
    // 2::1 is 0002:: and nowhere near 2000::/3, but it begins with a 2.
    expect(isPublicInternetAddress('2::1')).toBe(false);
    expect(isPublicInternetAddress('3::1')).toBe(false);
  });

  it('still allows ordinary global unicast, including blocks not yet assigned', () => {
    expect(isPublicInternetAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicInternetAddress('2a00:1450:4009:81f::200e')).toBe(true);
    // Allowed by inclusion, so an unassigned block inside 2000::/3 stays reachable rather than
    // waiting for somebody to remember to add it.
    expect(isPublicInternetAddress('3fff::1')).toBe(true);
  });

  it('still refuses documentation, benchmarking and the non-routable blocks', () => {
    expect(isPublicInternetAddress('2001:db8::1')).toBe(false);
    expect(isPublicInternetAddress('2001:2::1')).toBe(false);
    expect(isPublicInternetAddress('2001:10::1')).toBe(false);
    expect(isPublicInternetAddress('fe80::1')).toBe(false);
    expect(isPublicInternetAddress('::1')).toBe(false);
  });
});

describe('public HTTP URLs', () => {
  it('refuses local schemes, local names and loopback literals', () => {
    expect(isPublicHttpUrl('https://docs.example.com/research')).toBe(true);
    for (const url of [
      'file:///etc/passwd',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'http://localhost:3000/private',
      'http://127.0.0.1:4100/v1/legal',
      'http://[::1]/internal',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'https://metadata.google.internal/computeMetadata/v1',
      'http://box.local/admin',
      'http://api.internal/keys',
      'http://gateway.home.arpa/',
      'not a url'
    ])
      expect({ url, public: isPublicHttpUrl(url) }).toEqual({ url, public: false });
  });

  /*
   * One character walked past every name test in this file.
   *
   * `getaddrinfo` accepts a trailing root label and answers for the same host - `localhost.`
   * resolves to 127.0.0.1 on the box this was measured on - but `isInternalHostname` compares
   * suffixes, and `localhost.` is neither `localhost` nor a `.localhost`. Measured before this was
   * normalised here: `isPublicHttpUrl` answered TRUE for `http://localhost./`,
   * `http://wiki.internal./x`, `http://nas.local./x` and `http://metadata.google.internal./x`.
   *
   * `assertPublicHttpUrl` caught it on the resolving path, but `agentReachablePage` - the
   * synchronous check the session browser makes on the page it is about to read back - is this
   * predicate alone, so a page that moved itself to `http://localhost./admin` was readable.
   */
  it('refuses a local name spelled with the DNS root label on the end', () => {
    for (const url of [
      'http://localhost./',
      'http://sub.localhost./x',
      'http://wiki.internal./runbook',
      'http://nas.local./share',
      'http://gateway.home.arpa./',
      'http://metadata.google.internal./computeMetadata/v1'
    ])
      expect({ url, public: isPublicHttpUrl(url) }).toEqual({ url, public: false });
    // And the same normalisation must not cost a real host its answer.
    expect(isPublicHttpUrl('https://docs.example.com./research')).toBe(true);
    // A hostname that is only the root label names nothing and must not become the empty string,
    // which `URL` discards silently.
    expect(isPublicHttpUrl('http://./x')).toBe(true);
  });
});

/*
 * Three answers, and the middle one is the one two answers cannot give.
 *
 * A caller that wants "is this somewhere data can go" or "is this somebody else's machine" cannot
 * read `isPublicHttpUrl`, which answers neither: it is false for loopback and equally false for the
 * entire estate. Read that way, the owner's NAS and this process talking to itself get one verdict,
 * and the egress budget charges both of them nothing.
 */
describe('where an address is, relative to this computer', () => {
  it('calls loopback this computer, in every spelling that reaches it', () => {
    for (const url of [
      'http://localhost:5173/api/health',
      'http://localhost./api/health',
      'http://tracker.localhost:5173/',
      'http://127.0.0.1:8080/',
      // 127.0.0.0/8 entire: a resolver stub on 127.0.0.53 is still this computer.
      'http://127.0.0.53:5353/',
      'http://[::1]:3000/',
      'http://[::ffff:127.0.0.1]:3000/'
    ])
      expect({ url, reach: reachOfHttpUrl(url) }).toEqual({ url, reach: 'self' });
  });

  it('calls the private ranges and the internal names another computer', () => {
    for (const url of [
      'http://192.168.1.50/notes',
      'http://10.0.0.5/x',
      'http://172.16.4.4/x',
      'http://100.64.0.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://[fe80::1]/x',
      'http://[fd00::1]/x',
      'http://198.18.0.1/x',
      'http://203.0.113.8/x',
      'http://wiki.internal/runbook',
      'http://nas.local/share',
      'http://router.home.arpa/admin',
      'http://metadata.google.internal/computeMetadata/v1/'
    ])
      expect({ url, reach: reachOfHttpUrl(url) }).toEqual({ url, reach: 'estate' });
  });

  it('calls the public unicast space the internet', () => {
    for (const url of [
      'https://docs.example.com/research',
      'http://93.184.216.34/',
      'http://[2606:4700:4700::1111]/'
    ])
      expect({ url, reach: reachOfHttpUrl(url) }).toEqual({ url, reach: 'internet' });
  });

  /*
   * Fails towards the estate rather than towards the internet, and the direction is the point: of
   * the three answers, `estate` is the one whose callers charge for it. An address nobody can read
   * must not come back as this computer's own output, and it must not come back cleared.
   */
  it('answers estate for anything it cannot read, rather than self or internet', () => {
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'not a url', ''])
      expect({ url, reach: reachOfHttpUrl(url) }).toEqual({ url, reach: 'estate' });
  });

  /*
   * The equivalence that lets the SSRF callers keep one predicate. `isPublicHttpUrl` is now an arm
   * of this, so a spelling that walks past one of them cannot walk past only one of them.
   */
  it('agrees with the public-internet predicate on every address either of them answers', () => {
    for (const url of [
      'https://docs.example.com/research',
      'https://docs.example.com./research',
      'http://localhost/',
      'http://localhost./',
      'http://192.168.1.50/notes',
      'http://169.254.169.254/',
      'http://wiki.internal./x',
      'file:///etc/passwd',
      'not a url'
    ])
      expect({ url, public: isPublicHttpUrl(url) }).toEqual({
        url,
        public: reachOfHttpUrl(url) === 'internet'
      });
  });
});

describe('which suffix a host sits under', () => {
  it('answers with the longest match, so nothing is charged for a label twice', () => {
    expect(matchingHostSuffix('docs.example.com', ['example.com', 'docs.example.com'])).toBe(
      'docs.example.com'
    );
    expect(matchingHostSuffix('eu.api.example.com', [' .Example.com ', ''])).toBe('example.com');
    expect(matchingHostSuffix('example.com.evil.invalid', ['example.com'])).toBeNull();
    expect(matchingHostSuffix('anything', [''])).toBeNull();
  });

  it('still answers the yes-or-no question every connector asks', () => {
    expect(hostMatchesSuffix('mail.example.com', ['example.com'])).toBe(true);
    expect(hostMatchesSuffix('notexample.com', ['example.com'])).toBe(false);
  });
});

/*
 * The inbound half, which is not the outbound half backwards.
 *
 * A service declared `--bind 0.0.0.0` cannot be judged with `reachOfHttpUrl`: 0.0.0.0/8 is
 * reserved, so the one address that means EVERY interface would come back `estate`, the middle
 * answer, on a box whose interfaces include a public one.
 */
describe('reachOfBindAddress', () => {
  it('calls every spelling of the unspecified address the internet', () => {
    for (const address of [
      '0.0.0.0',
      '0.0.0.0:8099',
      '::',
      '[::]',
      '[::]:8080',
      '::0',
      '0:0:0:0:0:0:0:0',
      '::ffff:0.0.0.0',
      '*',
      ''
    ])
      expect({ address, reach: reachOfBindAddress(address) }).toEqual({
        address,
        reach: 'internet'
      });
  });

  it('calls a loopback bind this computer only', () => {
    for (const address of ['127.0.0.1', '127.0.0.53', '::1', '[::1]', 'localhost', 'localhost.'])
      expect({ address, reach: reachOfBindAddress(address) }).toEqual({ address, reach: 'self' });
  });

  it('calls a reserved non-loopback bind the estate', () => {
    for (const address of ['192.168.1.50', '10.0.0.5', '172.16.4.4', 'fe80::1', 'nas.local'])
      expect({ address, reach: reachOfBindAddress(address) }).toEqual({ address, reach: 'estate' });
  });

  /*
   * Fails towards `internet` where its outbound twin fails towards `estate`, and the inversion is
   * the whole reason the two are separate functions. Outbound, the expensive mistake is clearing
   * an address nobody can read; inbound, it is calling an open socket private.
   */
  it('fails towards the internet for a name it cannot place', () => {
    for (const address of ['not an address', 'srv-07', 'deploy-target'])
      expect({ address, reach: reachOfBindAddress(address) }).toEqual({
        address,
        reach: 'internet'
      });
  });

  it('calls a public unicast bind the internet', () => {
    for (const address of ['93.184.216.34', '::ffff:93.184.216.34', '2606:4700:4700::1111'])
      expect({ address, reach: reachOfBindAddress(address) }).toEqual({
        address,
        reach: 'internet'
      });
  });

  it('disagrees with the outbound reader on the address that caused this', () => {
    expect(reachOfBindAddress('0.0.0.0')).toBe('internet');
    expect(reachOfHttpUrl('http://0.0.0.0:8099/')).toBe('estate');
  });
});
