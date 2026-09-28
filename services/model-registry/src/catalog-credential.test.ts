import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptJson, inferenceCredentialAad, type EncryptedEnvelope } from '@garden/core';
import { catalogCredential, type CredentialSource } from './catalog-credential.js';

const masterKey = randomBytes(32);
const OWNER = 'ffffffff-1111-4111-8111-ffffffffffff';

const source = (rows: Record<string, { provider: string; status: string; secret: unknown }>) =>
  ({
    soleUser: async () => ({ id: OWNER }),
    listManagedProviderCredentials: async (userId: string) =>
      userId !== OWNER
        ? []
        : Object.values(rows).map((row) => ({
            provider: row.provider,
            status: row.status,
            secretCiphertext: row.secret as EncryptedEnvelope
          }))
  }) satisfies CredentialSource;

const inferenceRow = (secret: Record<string, unknown>, status = 'active') => ({
  provider: 'inference',
  status,
  secret: encryptJson(secret, masterKey, inferenceCredentialAad(OWNER))
});

describe('catalogCredential', () => {
  it('uses the owner saved provider key, which is the only key a shipped box has', async () => {
    const credential = await catalogCredential({
      store: source({
        inference: inferenceRow({
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-owner'
        })
      }),
      masterKey
    });
    expect(credential).toMatchObject({
      apiKey: 'sk-owner',
      baseUrl: 'https://openrouter.ai/api/v1',
      provider: 'openrouter',
      source: 'owner'
    });
  });

  it('lets an operator key win, so a deliberately separate account is not overridden', async () => {
    const credential = await catalogCredential({
      store: source({ inference: inferenceRow({ provider: 'openrouter', apiKey: 'sk-owner' }) }),
      masterKey,
      environmentKey: 'sk-operator'
    });
    expect(credential).toMatchObject({
      apiKey: 'sk-operator',
      provider: 'openrouter',
      source: 'environment'
    });
  });

  it('reads the legacy openrouter row, which carries no provider and no context', async () => {
    const credential = await catalogCredential({
      store: source({
        openrouter: {
          provider: 'openrouter',
          status: 'active',
          secret: encryptJson({ apiKey: 'sk-legacy' }, masterKey)
        }
      }),
      masterKey
    });
    expect(credential).toMatchObject({
      apiKey: 'sk-legacy',
      provider: 'openrouter',
      source: 'owner'
    });
  });

  /*
   * The contract here has not changed and the assertion has. It used to be `null`, because refusing
   * to answer was the only way this file had of keeping an Ollama Cloud key away from a request to
   * OpenRouter - and the price of it was that such an owner's catalogue was written once and then
   * frozen for the life of the box. Naming the provider keeps the key where it belongs and lets the
   * pass ask the owner's own endpoint instead, which is the whole of what "openrouter etc." asked
   * for. What must stay true is that nothing here can route that key to OpenRouter, and what the
   * caller branches on is this field.
   */
  it('names the provider a key belongs to rather than sending it to OpenRouter', async () => {
    for (const provider of ['ollama-cloud', 'openai-compatible']) {
      const credential = await catalogCredential({
        store: source({
          inference: inferenceRow({
            provider,
            apiKey: 'sk-elsewhere',
            baseUrl: 'https://x.test/v1',
            modelId: 'served-model',
            enforceZeroDataRetention: true
          })
        }),
        masterKey
      });
      expect(credential).toMatchObject({
        apiKey: 'sk-elsewhere',
        baseUrl: 'https://x.test/v1',
        provider,
        modelId: 'served-model',
        enforceZeroDataRetention: true,
        source: 'owner'
      });
    }
  });

  /*
   * An endpoint on the owner's own network commonly has no key at all. Requiring one was what took
   * those boxes down the frozen path; requiring one for OpenRouter is still right, because a
   * request to OpenRouter without a key answers nothing to build a catalogue from.
   */
  it('accepts a keyless endpoint and still refuses a keyless OpenRouter row', async () => {
    expect(
      await catalogCredential({
        store: source({
          inference: inferenceRow({
            provider: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:11434/v1'
          })
        }),
        masterKey
      })
    ).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      source: 'owner'
    });
    expect(
      await catalogCredential({
        store: source({ inference: inferenceRow({ provider: 'openrouter' }) }),
        masterKey
      })
    ).toBeNull();
  });

  it('answers null rather than throwing on the ordinary reasons there is no key', async () => {
    const saved = source({
      inference: inferenceRow({ provider: 'openrouter', apiKey: 'sk-owner' })
    });
    expect(await catalogCredential({ store: saved, masterKey: null })).toBeNull();
    expect(
      await catalogCredential({
        store: { ...saved, soleUser: async () => null },
        masterKey
      })
    ).toBeNull();
    expect(await catalogCredential({ store: source({}), masterKey })).toBeNull();
    expect(
      await catalogCredential({
        store: source({
          inference: inferenceRow({ provider: 'openrouter', apiKey: 'sk-owner' }, 'revoked')
        }),
        masterKey
      })
    ).toBeNull();
    expect(
      await catalogCredential({
        store: source({ inference: inferenceRow({ provider: 'openrouter' }) }),
        masterKey
      })
    ).toBeNull();
  });

  /*
   * The third and last shape a box can be pointed at a provider in, and the one that refreshed
   * nothing at all: an operator who set AI_PROVIDER and AI_BASE_URL in control.env got a single
   * `custom/AI_DEFAULT_MODEL` row written when the API started and no process ever asked that
   * endpoint another question for the life of the box.
   */
  it('refreshes the endpoint an operator configured in control.env, which nothing ever asked again', async () => {
    expect(
      await catalogCredential({
        store: source({}),
        masterKey,
        environmentProvider: {
          provider: 'openai-compatible',
          baseUrl: 'https://vllm.internal/v1',
          modelId: 'served-model'
        }
      })
    ).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'https://vllm.internal/v1',
      modelId: 'served-model',
      source: 'environment'
    });
  });

  /*
   * Order matters and is argued rather than incidental. `OPENROUTER_REGISTRY_KEY` wins over
   * everything because an operator who deliberately points the catalogue at a separate account must
   * not have that overridden by Settings. A key the owner saved wins over `AI_PROVIDER`, because it
   * is the later and more specific statement of where this computer's work should go. The shipped
   * default of `AI_PROVIDER=openrouter` names no endpoint of its own and is not a credential.
   */
  it('ranks the registry key above a saved key, a saved key above control.env, and ignores the shipped default', async () => {
    const configured = {
      provider: 'openai-compatible' as const,
      baseUrl: 'https://vllm.internal/v1'
    };
    const saved = source({
      inference: inferenceRow({ provider: 'openrouter', apiKey: 'sk-owner' })
    });
    expect(
      await catalogCredential({
        store: saved,
        masterKey,
        environmentKey: 'sk-operator',
        environmentProvider: configured
      })
    ).toMatchObject({ apiKey: 'sk-operator', provider: 'openrouter' });
    expect(
      await catalogCredential({ store: saved, masterKey, environmentProvider: configured })
    ).toMatchObject({ apiKey: 'sk-owner', provider: 'openrouter', source: 'owner' });
    expect(
      await catalogCredential({
        store: source({}),
        masterKey,
        environmentProvider: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }
      })
    ).toBeNull();
  });

  it('throws on a credential it cannot open, which is a key that stopped matching', async () => {
    await expect(
      catalogCredential({
        store: source({ inference: inferenceRow({ provider: 'openrouter', apiKey: 'sk-owner' }) }),
        masterKey: randomBytes(32)
      })
    ).rejects.toThrow();
  });

  it('refuses a credential sealed for a different account', async () => {
    const stolen = encryptJson(
      { provider: 'openrouter', apiKey: 'sk-somebody-else' },
      masterKey,
      inferenceCredentialAad('00000000-0000-4000-8000-000000000000')
    );
    await expect(
      catalogCredential({
        store: source({ inference: { provider: 'inference', status: 'active', secret: stolen } }),
        masterKey
      })
    ).rejects.toThrow('could not be opened');
  });
});
