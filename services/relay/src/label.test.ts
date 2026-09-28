import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32Lower,
  deriveLabel,
  isWellFormedLabel,
  labelFromHostname,
  rawEd25519FromSpki,
  spkiFromRawEd25519,
  spkiHash
} from './label.js';
import { LABEL_LENGTH } from './protocol.js';

const key = (fill: number): Buffer => Buffer.alloc(32, fill);

describe('base32Lower', () => {
  it('matches RFC 4648 base32 lowercased and unpadded', () => {
    expect(base32Lower(Buffer.from('foobar', 'utf8'))).toBe('mzxw6ytboi');
    expect(base32Lower(Buffer.from([]))).toBe('');
  });
});

describe('deriveLabel', () => {
  it('produces a 26 character DNS-safe label', () => {
    const label = deriveLabel('relay.example', key(1));
    expect(label).toHaveLength(LABEL_LENGTH);
    expect(isWellFormedLabel(label)).toBe(true);
  });

  it('is domain separated so the same box on two relays is not correlatable', () => {
    expect(deriveLabel('relay.example', key(1))).not.toBe(deriveLabel('other.example', key(1)));
  });

  it('is case insensitive in the domain, since DNS is', () => {
    expect(deriveLabel('Relay.Example', key(7))).toBe(deriveLabel('relay.example', key(7)));
  });

  it('separates the key from the domain with a length prefix', () => {
    // Without the length prefix, ("ab", "c…") and ("abc", "…") would hash identically.
    expect(deriveLabel('ab.example', key(2))).not.toBe(deriveLabel('ab.exampl', key(2)));
  });

  it('follows the documented construction exactly', () => {
    const domain = Buffer.from('relay.example', 'utf8');
    const expected = createHash('sha256')
      .update(Buffer.from('garden-relay-label-v1\x00', 'latin1'))
      .update(Buffer.from([domain.length]))
      .update(domain)
      .update(key(9))
      .digest();
    expect(deriveLabel('relay.example', key(9))).toBe(base32Lower(expected).slice(0, LABEL_LENGTH));
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => deriveLabel('relay.example', Buffer.alloc(31))).toThrow(/32 bytes/);
  });
});

describe('spki helpers', () => {
  it('round trips a raw ed25519 key through SubjectPublicKeyInfo', () => {
    const raw = key(3);
    const spki = spkiFromRawEd25519(raw);
    expect(spki).toHaveLength(44);
    expect(rawEd25519FromSpki(spki)?.equals(raw)).toBe(true);
  });

  it('rejects an SPKI that is not ed25519', () => {
    expect(rawEd25519FromSpki(Buffer.alloc(44, 9))).toBeNull();
    expect(rawEd25519FromSpki(Buffer.alloc(91))).toBeNull();
  });

  it('hashes the SPKI, not the raw key', () => {
    const raw = key(4);
    expect(spkiHash(spkiFromRawEd25519(raw))).not.toBe(
      createHash('sha256').update(raw).digest('hex')
    );
  });
});

describe('labelFromHostname', () => {
  const label = deriveLabel('relay.example', key(5));

  it('extracts a registered-shape label', () => {
    expect(labelFromHostname(`${label}.relay.example`, 'relay.example')).toBe(label);
    expect(labelFromHostname(`${label.toUpperCase()}.RELAY.EXAMPLE.`, 'relay.example')).toBe(label);
  });

  it('rejects anything that is not a well formed label under the relay domain', () => {
    expect(labelFromHostname('www.relay.example', 'relay.example')).toBeNull();
    expect(labelFromHostname(`${label}.evil.example`, 'relay.example')).toBeNull();
    expect(labelFromHostname(`sub.${label}.relay.example`, 'relay.example')).toBeNull();
    expect(labelFromHostname('relay.example', 'relay.example')).toBeNull();
  });
});
