import { hkdfSync } from 'node:crypto';

export interface DataMasterKeyConfig {
  DATA_MASTER_KEY?: string | undefined;
}

/**
 * Said by every entrypoint, because a service started by hand with a half-written environment is
 * where this is reached. "Required" on its own left the owner hunting for which file the value
 * belongs in, and worse, invited inventing one - a new key boots fine and seals off everything the
 * old one wrote.
 */
export const DATA_MASTER_KEY_REQUIRED =
  'DATA_MASTER_KEY is required: it lives in /etc/garden/control.env, which the installer writes on a first install. Recover the original if you have one - a key that did not encrypt this database cannot read it back.';

const decodeMasterKey = (value: string): Buffer => {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 32) throw new Error('DATA_MASTER_KEY must decode to exactly 32 bytes');
  return decoded;
};

export const resolveDataMasterKey = async (
  config: DataMasterKeyConfig
): Promise<{ key: Buffer; mode: 'hosted' }> => {
  if (!config.DATA_MASTER_KEY) throw new Error(DATA_MASTER_KEY_REQUIRED);
  return { key: decodeMasterKey(config.DATA_MASTER_KEY), mode: 'hosted' };
};

export const deriveServiceSecret = (
  masterKey: Uint8Array,
  purpose: 'session-signing' | 'runner-capabilities' | 'api-operation-receipts' | 'device-drafts'
): string => {
  if (masterKey.byteLength !== 32) throw new Error('Service derivation requires 32 bytes');
  return Buffer.from(
    hkdfSync(
      'sha256',
      masterKey,
      Buffer.from('garden-service-secrets:v1', 'utf8'),
      Buffer.from(purpose, 'utf8'),
      32
    )
  ).toString('base64url');
};
