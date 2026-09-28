import { createHash } from 'node:crypto';
import { LABEL_LENGTH } from './protocol.js';

/**
 * DER prefix of a SubjectPublicKeyInfo wrapping a raw Ed25519 public key:
 * SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING (0 unused) }.
 * Fixed length, so the raw key is simply the trailing 32 bytes.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_RAW_LENGTH = 32;

/** RFC 4648 base32, lowercased. Lowercase because DNS labels are case-insensitive. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const LABEL_DOMAIN_SEPARATOR = Buffer.from('garden-relay-label-v1\x00', 'latin1');

export const base32Lower = (input: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
};

export const spkiFromRawEd25519 = (raw: Uint8Array): Buffer => {
  if (raw.length !== ED25519_RAW_LENGTH) {
    throw new Error(`ed25519 public key must be ${ED25519_RAW_LENGTH} bytes`);
  }
  return Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]);
};

export const rawEd25519FromSpki = (spki: Uint8Array): Buffer | null => {
  const buf = Buffer.from(spki);
  if (buf.length !== ED25519_SPKI_PREFIX.length + ED25519_RAW_LENGTH) return null;
  if (!buf.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) return null;
  return buf.subarray(ED25519_SPKI_PREFIX.length);
};

/** Hex SHA-256 over the DER SubjectPublicKeyInfo. This is what the registry stores. */
export const spkiHash = (spki: Uint8Array): string =>
  createHash('sha256').update(spki).digest('hex');

/**
 * label = base32-lower-nopad(SHA256("garden-relay-label-v1\x00" || u8(len(domain)) || domain
 *                                   || raw_ed25519_pubkey))[0:26]
 *
 * The relay always derives this from the SPKI a peer actually presented; a box can never ask for a
 * label. Domain separation means the same identity key on two relays yields two unlinkable labels,
 * so an observer joining the two relays' Certificate Transparency entries learns nothing.
 *
 * The domain length is a single byte: DNS names cannot exceed 253 octets, and length-prefixing at
 * all is what stops ("a.example", key) and ("a", ".examplekey...") from colliding.
 */
export const deriveLabel = (relayDomain: string, rawPublicKey: Uint8Array): string => {
  const domain = Buffer.from(relayDomain.toLowerCase(), 'utf8');
  if (domain.length === 0 || domain.length > 255) {
    throw new Error('relay domain must be 1..255 bytes');
  }
  if (rawPublicKey.length !== ED25519_RAW_LENGTH) {
    throw new Error(`ed25519 public key must be ${ED25519_RAW_LENGTH} bytes`);
  }
  const digest = createHash('sha256')
    .update(LABEL_DOMAIN_SEPARATOR)
    .update(Buffer.from([domain.length]))
    .update(domain)
    .update(rawPublicKey)
    .digest();
  return base32Lower(digest).slice(0, LABEL_LENGTH);
};

const LABEL_PATTERN = new RegExp(`^[a-z2-7]{${LABEL_LENGTH}}$`);

export const isWellFormedLabel = (value: string): boolean => LABEL_PATTERN.test(value);

/** Extracts the label from `<label>.<relayDomain>`, case-insensitively. */
export const labelFromHostname = (hostname: string, relayDomain: string): string | null => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const suffix = `.${relayDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, host.length - suffix.length);
  return isWellFormedLabel(label) ? label : null;
};
