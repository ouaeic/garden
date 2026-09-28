import {
  readInferenceConnections,
  type InferenceConnectionRow,
  type InferenceConnectionSecret
} from '@garden/core';
import type { ModelRelease } from '@garden/contracts';

export interface CatalogCredential extends InferenceConnectionSecret {
  source: 'environment' | 'owner';
  catalogDefaults?: Pick<ModelRelease, 'contextTokens' | 'capabilities' | 'modalities'>;
}

export interface CredentialSource {
  soleUser(): Promise<{ id: string } | null>;
  listManagedProviderCredentials(userId: string): Promise<InferenceConnectionRow[]>;
}

export interface CatalogCredentialInput {
  store: CredentialSource;
  masterKey: Uint8Array | null;
  /** An explicitly separate account for refreshing OpenRouter, without replacing other vendors. */
  environmentKey?: string | undefined;
  environmentProvider?:
    | {
        provider: string;
        baseUrl?: string | undefined;
        modelId?: string | undefined;
        apiKey?: string | undefined;
        enforceZeroDataRetention?: boolean | undefined;
      }
    | undefined;
}

/** Uses the same credential precedence and decoding as the API and worker. */
export async function catalogCredentials(
  input: CatalogCredentialInput
): Promise<CatalogCredential[]> {
  const configured = input.environmentProvider;
  const provider =
    configured?.provider === 'openai-compatible' || configured?.provider === 'ollama-cloud'
      ? configured.provider
      : 'openrouter';
  const owner = input.masterKey ? await input.store.soleUser() : null;
  let unreadable = false;
  const connections = readInferenceConnections<CatalogCredential>({
    rows: owner ? await input.store.listManagedProviderCredentials(owner.id) : [],
    userId: owner?.id ?? '',
    masterKey: input.masterKey ?? Buffer.alloc(32),
    environment: {
      AI_PROVIDER: provider,
      AI_BASE_URL: configured?.baseUrl ?? 'https://openrouter.ai/api/v1',
      AI_DEFAULT_MODEL: configured?.modelId,
      AI_API_KEY: configured?.apiKey,
      AI_REQUIRE_ZDR: configured?.enforceZeroDataRetention ?? true,
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1'
    },
    onUnreadable: () => {
      unreadable = true;
    }
  });
  if (unreadable && !connections.size && !input.environmentKey)
    throw new Error('Saved model connections could not be opened');
  const credentials = [...connections.values()].map(({ secret, source }) => ({
    ...secret,
    source: source === 'encrypted_database' ? ('owner' as const) : ('environment' as const)
  }));
  if (!input.environmentKey) return credentials;
  return [
    {
      provider: 'openrouter',
      apiKey: input.environmentKey,
      baseUrl: 'https://openrouter.ai/api/v1',
      enforceZeroDataRetention: true,
      source: 'environment'
    },
    ...credentials.filter((entry) => entry.provider !== 'openrouter')
  ];
}

export async function catalogCredential(
  input: CatalogCredentialInput
): Promise<CatalogCredential | null> {
  return (await catalogCredentials(input))[0] ?? null;
}
