import type { ModelRelease } from '@garden/contracts';
import { decryptJson, inferenceCredentialAad, type EncryptedEnvelope } from './crypto.js';

export interface InferenceConnectionSecret {
  connectionId?: string;
  label?: string;
  provider: 'openrouter' | 'ollama-cloud' | 'openai-compatible';
  baseUrl: string;
  apiKey?: string;
  modelId?: string;
  enforceZeroDataRetention: boolean;
}

/** Named compatible endpoints retain the vendor protocol while owning an independent credential. */
export function inferenceConnectionProvider(
  id: string
): InferenceConnectionSecret['provider'] | null {
  if (id === 'openrouter' || id === 'ollama-cloud' || id === 'openai-compatible') return id;
  return /^openai-compatible:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ? 'openai-compatible'
    : null;
}

export interface InferenceConnectionRow {
  provider: string;
  status: string;
  secretCiphertext: EncryptedEnvelope;
}

export interface InferenceConnection<
  T extends InferenceConnectionSecret = InferenceConnectionSecret
> {
  secret: T;
  source: 'encrypted_database' | 'server_environment';
  record?: InferenceConnectionRow;
}

export interface InferenceEnvironment {
  AI_PROVIDER: InferenceConnectionSecret['provider'];
  AI_BASE_URL: string;
  AI_API_KEY?: string | undefined;
  AI_DEFAULT_MODEL?: string | undefined;
  AI_REQUIRE_ZDR: boolean;
  OPENROUTER_API_KEY?: string | undefined;
  OPENROUTER_BASE_URL: string;
}

export function environmentInferenceSecret(
  config: InferenceEnvironment
): InferenceConnectionSecret {
  const apiKey =
    config.AI_API_KEY ??
    (config.AI_PROVIDER === 'openrouter' ? config.OPENROUTER_API_KEY : undefined);
  return {
    provider: config.AI_PROVIDER,
    baseUrl: config.AI_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    ...(config.AI_DEFAULT_MODEL ? { modelId: config.AI_DEFAULT_MODEL } : {}),
    enforceZeroDataRetention: config.AI_REQUIRE_ZDR
  };
}

/** Rows are newest first. A saved connection never silently spends an environment credential. */
export function readInferenceConnections<T extends InferenceConnectionSecret>(input: {
  rows: readonly InferenceConnectionRow[];
  userId: string;
  masterKey: Uint8Array;
  environment: InferenceEnvironment;
  onUnreadable?: (connectionKey: string) => void;
}): Map<string, InferenceConnection<T>> {
  const connections = new Map<string, InferenceConnection<T>>();
  const claimed = new Set<string>();
  const active = input.rows.filter((row) => row.status === 'active');
  for (const row of active) {
    const keyedId = row.provider.startsWith('inference:')
      ? row.provider.slice('inference:'.length)
      : undefined;
    if (keyedId && claimed.has(keyedId)) continue;
    if (keyedId) claimed.add(keyedId);
    try {
      const opened =
        row.provider === 'openrouter'
          ? {
              ...decryptJson<T>(
                row.secretCiphertext,
                input.masterKey,
                inferenceCredentialAad(input.userId)
              ),
              provider: 'openrouter',
              baseUrl: input.environment.OPENROUTER_BASE_URL,
              enforceZeroDataRetention: true
            }
          : decryptJson<T>(
              row.secretCiphertext,
              input.masterKey,
              inferenceCredentialAad(input.userId)
            );
      const provider = opened.provider ?? (row.provider === 'inference' ? 'openrouter' : undefined);
      const secret = {
        ...opened,
        provider,
        baseUrl:
          opened.baseUrl ??
          (provider === 'openrouter'
            ? input.environment.OPENROUTER_BASE_URL
            : provider === 'ollama-cloud'
              ? 'https://ollama.com/v1'
              : undefined),
        enforceZeroDataRetention: opened.enforceZeroDataRetention !== false
      } as T;
      if (
        !['openrouter', 'ollama-cloud', 'openai-compatible'].includes(secret.provider) ||
        typeof secret.baseUrl !== 'string' ||
        !secret.baseUrl ||
        (keyedId && inferenceConnectionProvider(keyedId) !== secret.provider)
      )
        continue;
      const connectionId = keyedId ?? secret.provider;
      if (secret.connectionId && secret.connectionId !== connectionId) continue;
      if (connectionId !== secret.provider && secret.connectionId !== connectionId) continue;
      if (secret.provider !== 'openai-compatible' && !secret.apiKey) continue;
      if (!keyedId && claimed.has(connectionId)) continue;
      claimed.add(connectionId);
      if (!connections.has(connectionId))
        connections.set(connectionId, { secret, source: 'encrypted_database', record: row });
    } catch {
      input.onUnreadable?.(row.provider);
    }
  }
  if (active.length === 0) {
    const secret = environmentInferenceSecret(input.environment);
    if (secret.apiKey || (secret.provider === 'openai-compatible' && secret.modelId))
      connections.set(secret.provider, { secret: secret as T, source: 'server_environment' });
  }
  return connections;
}

/** A legacy row may be inferred only when its source identifies exactly one connection. */
export function modelConnectionId(
  model: Pick<ModelRelease, 'provider' | 'connectionId' | 'recommendationTags'>,
  connectionIds: Iterable<string>
): string | null {
  const ids = new Set(connectionIds);
  if (model.connectionId) return ids.has(model.connectionId) ? model.connectionId : null;
  if (model.provider === 'openrouter') return ids.has('openrouter') ? 'openrouter' : null;
  if (model.provider !== 'custom') return null;
  const tagged = [
    ...(model.recommendationTags.includes('Ollama Cloud') ? ['ollama-cloud'] : []),
    ...(model.recommendationTags.includes('Configured endpoint') ? ['openai-compatible'] : [])
  ];
  if (tagged.length) return tagged.length === 1 && ids.has(tagged[0]!) ? tagged[0]! : null;
  const compatible = [...ids].filter((id) => id !== 'openrouter');
  return compatible.length === 1 ? compatible[0]! : null;
}
