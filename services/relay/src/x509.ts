import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomFillSync,
  sign,
  type KeyObject
} from 'node:crypto';

/**
 * A minimal DER/X.509 v3 builder for self-signed Ed25519 certificates.
 *
 * Two reasons this exists rather than shelling out to `openssl`:
 *  - the relay must be runnable with nothing but a Node runtime, including `garden-relay dev-cert`
 *    for a local smoke test;
 *  - it pins, in code, the exact certificate shape a box presents as its identity credential, which
 *    is the thing the relay authenticates against.
 *
 * Ed25519 makes this tractable: no algorithm parameters, and the signature is a raw 64-byte value.
 */

const OID_ED25519 = '1.3.101.112';
const OID_COMMON_NAME = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const OID_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';

const encodeLength = (length: number): Buffer => {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag: number, content: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);

const derSequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const derSet = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const derBoolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const derOctetString = (value: Buffer): Buffer => tlv(0x04, value);
const derUtf8String = (value: string): Buffer => tlv(0x0c, Buffer.from(value, 'utf8'));
const derBitString = (value: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
const derExplicit = (index: number, content: Buffer): Buffer => tlv(0xa0 | index, content);

const derInteger = (value: Buffer): Buffer => {
  const first = value[0] ?? 0;
  return tlv(0x02, (first & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), value]) : value);
};

const derOid = (oid: string): Buffer => {
  const parts = oid.split('.').map((part) => Number.parseInt(part, 10));
  const bytes: number[] = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
  for (const component of parts.slice(2)) {
    const chunks: number[] = [component & 0x7f];
    let remaining = component >>> 7;
    while (remaining > 0) {
      chunks.unshift((remaining & 0x7f) | 0x80);
      remaining >>>= 7;
    }
    bytes.push(...chunks);
  }
  return tlv(0x06, Buffer.from(bytes));
};

const two = (value: number): string => value.toString().padStart(2, '0');

/** X.509 requires UTCTime through 2049 and GeneralizedTime from 2050 (RFC 5280 4.1.2.5). */
const derTime = (date: Date): Buffer => {
  const year = date.getUTCFullYear();
  const stamp =
    two(date.getUTCMonth() + 1) +
    two(date.getUTCDate()) +
    two(date.getUTCHours()) +
    two(date.getUTCMinutes()) +
    two(date.getUTCSeconds()) +
    'Z';
  if (year >= 1950 && year <= 2049) {
    return tlv(0x17, Buffer.from(two(year % 100) + stamp, 'ascii'));
  }
  return tlv(0x18, Buffer.from(String(year) + stamp, 'ascii'));
};

const derName = (commonName: string): Buffer =>
  derSequence(derSet(derSequence(derOid(OID_COMMON_NAME), derUtf8String(commonName))));

const derExtension = (oid: string, critical: boolean, value: Buffer): Buffer =>
  critical
    ? derSequence(derOid(oid), derBoolean(true), derOctetString(value))
    : derSequence(derOid(oid), derOctetString(value));

const ALGORITHM_IDENTIFIER = derSequence(derOid(OID_ED25519));

const toPem = (der: Buffer, label: string): string => {
  const base64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
};

const randomSerial = (): Buffer => {
  const buf = randomFillSync(Buffer.alloc(16));
  // Keep it positive and non-zero so no leading pad byte is needed.
  buf[0] = ((buf[0] ?? 0) & 0x7f) | 0x01;
  return buf;
};

export interface Ed25519KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export const generateIdentityKeyPair = (): Ed25519KeyPair => generateKeyPairSync('ed25519');

export const privateKeyToPem = (key: KeyObject): string =>
  key.export({ type: 'pkcs8', format: 'pem' }).toString();

export const publicKeySpkiDer = (key: KeyObject): Buffer =>
  Buffer.from(createPublicKey(key).export({ type: 'spki', format: 'der' }));

export interface SelfSignedCertificateOptions {
  readonly privateKey: KeyObject;
  readonly commonName: string;
  readonly dnsNames: readonly string[];
  readonly notBefore?: Date;
  readonly validForDays?: number;
}

export interface SelfSignedCertificate {
  readonly certPem: string;
  readonly keyPem: string;
  readonly der: Buffer;
}

/**
 * Builds a self-signed Ed25519 certificate. There is no CA and no chain: the relay authenticates
 * peers purely on the SubjectPublicKeyInfo, and TLS 1.3's CertificateVerify is what proves the peer
 * holds the matching private key.
 */
export const createSelfSignedCertificate = (
  options: SelfSignedCertificateOptions
): SelfSignedCertificate => {
  const privateKey =
    options.privateKey.type === 'private'
      ? options.privateKey
      : createPrivateKey(options.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('identity certificates must use an ed25519 key');
  }

  // Deriving the public half here means a caller cannot hand us a mismatched pair.
  const spki = publicKeySpkiDer(privateKey);
  const notBefore = options.notBefore ?? new Date(Date.now() - 60_000);
  const notAfter = new Date(notBefore.getTime() + (options.validForDays ?? 3650) * 86_400_000);
  const sanEntries = options.dnsNames.map((name) => tlv(0x82, Buffer.from(name, 'ascii')));

  const tbs = derSequence(
    derExplicit(0, tlv(0x02, Buffer.from([0x02]))),
    derInteger(randomSerial()),
    ALGORITHM_IDENTIFIER,
    derName(options.commonName),
    derSequence(derTime(notBefore), derTime(notAfter)),
    derName(options.commonName),
    spki,
    derExplicit(
      3,
      derSequence(
        derExtension(OID_BASIC_CONSTRAINTS, true, derSequence()),
        // digitalSignature only: this key signs handshakes, it does not certify anything.
        derExtension(OID_KEY_USAGE, true, derBitString(Buffer.from([0x07, 0x80]))),
        derExtension(
          OID_EXT_KEY_USAGE,
          false,
          derSequence(derOid(OID_SERVER_AUTH), derOid(OID_CLIENT_AUTH))
        ),
        derExtension(OID_SUBJECT_ALT_NAME, false, derSequence(...sanEntries))
      )
    )
  );

  const signature = sign(null, tbs, privateKey);
  const der = derSequence(tbs, ALGORITHM_IDENTIFIER, derBitString(signature));

  return { der, certPem: toPem(der, 'CERTIFICATE'), keyPem: privateKeyToPem(privateKey) };
};
