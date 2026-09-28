import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  createSelfSignedCertificate,
  deriveLabel,
  generateIdentityKeyPair,
  publicKeySpkiDer,
  rawEd25519FromSpki
} from '@garden/relay';

/**
 * The box's relay identity.
 *
 * The relay never accepts a label a box asks for - it derives one from the public key the box
 * proved it holds during the TLS handshake. So this key pair *is* the box's address: losing it
 * changes the hostname every enrolled client is pinned to, and leaking it lets someone else answer
 * for that hostname. It is written once, 0600, and never leaves the box.
 */
export interface RelayIdentity {
  /** PEM private key, for the mTLS client certificate. */
  readonly keyPem: string;
  /** PEM self-signed certificate. There is no CA: TLS 1.3 CertificateVerify is the whole proof. */
  readonly certPem: string;
  /** DER SubjectPublicKeyInfo, as it appears in the certificate. */
  readonly spkiDer: Buffer;
  /**
   * The bare 32-byte Ed25519 public key. This is what enrollment claims and what the relay checks
   * against the key that proved possession in the TLS handshake, so the two must be the same
   * encoding - sending the SPKI wrapper here reads to the relay as a different identity.
   */
  readonly rawPublicKey: Buffer;
  /**
   * The label this identity will be given on a particular relay.
   *
   * Derivation is domain-separated by the relay's own domain, so the same box has a different
   * address on every relay it enrolls with - two operators cannot correlate their registries, and
   * one cannot pre-compute the label a box would get somewhere else. Deriving it locally is also
   * how the box checks that a relay handed back the label the protocol says it must.
   */
  labelFor(relayDomain: string): string;
}

const KEY_FILE = 'relay-identity.key';
const CERT_FILE = 'relay-identity.crt';

const readIfPresent = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const identityFrom = (keyPem: string, certPem: string, spkiDer: Buffer): RelayIdentity => {
  const raw = rawEd25519FromSpki(spkiDer);
  // Only Ed25519 identities can be labelled, and only Ed25519 keys are ever generated here, so a
  // null means the file on disk is not the key this box wrote - worth failing loudly rather than
  // reconnecting forever against an identity the relay will never recognise.
  if (!raw) throw new Error('The relay identity key on disk is not an ed25519 key');
  return {
    keyPem,
    certPem,
    spkiDer,
    rawPublicKey: Buffer.from(raw),
    labelFor: (relayDomain: string) => deriveLabel(relayDomain, raw)
  };
};

const fromKeyPem = (keyPem: string, certPem: string): RelayIdentity =>
  identityFrom(keyPem, certPem, publicKeySpkiDer(createPrivateKey(keyPem)));

/**
 * Loads the box's identity, creating it on first use.
 *
 * Both halves are written before either is reported, so a crash mid-write cannot leave a key
 * without its certificate and silently re-derive a different label on the next start.
 */
export const loadOrCreateIdentity = async (directory: string): Promise<RelayIdentity> => {
  const keyPath = join(directory, KEY_FILE);
  const certPath = join(directory, CERT_FILE);
  const [existingKey, existingCert] = await Promise.all([
    readIfPresent(keyPath),
    readIfPresent(certPath)
  ]);
  if (existingKey && existingCert) return fromKeyPem(existingKey, existingCert);

  const pair = generateIdentityKeyPair();
  const spkiDer = publicKeySpkiDer(pair.privateKey);
  // The certificate's subject is cosmetic - the relay authenticates the key, never the name - and
  // it cannot be the label, because the label is not known until a relay domain is chosen.
  const certificate = createSelfSignedCertificate({
    privateKey: pair.privateKey,
    commonName: 'garden-box',
    dnsNames: ['garden-box']
  });

  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  await writeFile(keyPath, certificate.keyPem, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  await writeFile(certPath, certificate.certPem, { mode: 0o644 });
  return identityFrom(certificate.keyPem, certificate.certPem, spkiDer);
};
