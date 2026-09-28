import { ModelRelease } from '@garden/contracts';
import {
  refreshOpenRouterCatalog,
  seedModels,
  type ModelCatalogScope
} from '@garden/model-gateway';
import {
  catalogCredentials,
  type CatalogCredentialInput,
  type CredentialSource
} from './catalog-credential.js';
import { implausibleReplacement } from './catalog-plausibility.js';
import { refreshConfiguredCatalog, type ConfiguredCatalogInput } from './configured-catalog.js';
import { refreshFailureReason } from './refresh-log.js';

/**
 * One pass of the refresh loop, lifted out of it.
 *
 * It was the body of a `while (running)` block, which meant the four states this service can end a
 * pass in - it refreshed, it seeded a new box, it has no key and a catalogue it cannot refresh, it
 * failed - were reachable only by running the loop, and so were tested by nothing at all. The one
 * that mattered most had already cost the owner their picker once (see `!existing.length` below).
 *
 * Naming the outcome is also what lets the pass be *said* and *written down* rather than only
 * done: the journal line and the timestamp `garden doctor` reads are both built from this value.
 */
export interface CatalogStore extends CredentialSource {
  listModels(): Promise<Array<Record<string, unknown>>>;
  replaceModelCatalog(models: Array<Record<string, unknown>>): Promise<unknown>;
  upsertModels(models: Array<Record<string, unknown>>): Promise<void>;
}

/**
 * The refresh stated in this service's own terms rather than the gateway's, so a pass can be
 * exercised without a provider and without knowing the shape of a catalogue row.
 * `refreshOpenRouterCatalog` satisfies it.
 */
export type CatalogRefresh = (
  allowlist: ModelRelease[],
  options: {
    baseUrl: string;
    apiKey: string;
    scope: ModelCatalogScope;
    previous: ModelRelease[];
  }
) => Promise<Array<Record<string, unknown>>>;

export interface RefreshOutcome {
  /**
   * `refreshed` - a provider answered and the whole catalogue was replaced.
   * `seeded` - no key and an empty catalogue, so the built-in list was written to fill it.
   * `frozen` - no key and a catalogue already in the database, which is therefore staying exactly
   * as it is until a key appears. This is an ordinary state on a box whose owner runs their own
   * endpoint, and it is also what a revoked key looks like, which is why it is said out loud.
   * `failed` - the attempt threw; the catalogue already in the database stays in use.
   * `refused` - a provider answered, and what it answered no longer describes models the way the
   * catalogue already here does. The replace was not performed. This is its own state and not a
   * `frozen` or a `failed` because it is neither: a request succeeded, there is a key, and the
   * thing that went wrong is upstream of this box and will not fix itself. Saying `frozen` here
   * would send the owner to Settings to save a key they already have.
   */
  state: 'refreshed' | 'seeded' | 'frozen' | 'failed' | 'refused';
  /**
   * What the catalogue holds after this pass, for the journal line and for `doctor`. On a `failed`
   * pass it is what the pass managed to read before it threw, so it is zero when the failure came
   * before the catalogue was listed at all - an unopenable credential, say.
   */
  models: number;
  /**
   * Why the pass did not leave a fresh catalogue behind. For `failed` it is what threw, bounded and
   * flattened to one line by `refreshFailureReason`; for `refused` it is the plausibility gate's
   * own sentence. Null for the three states where nothing is wrong.
   */
  reason: string | null;
}

export const refreshOnce = async (input: {
  store: CatalogStore;
  masterKey: Uint8Array | null;
  environmentKey?: string | undefined;
  /** Passed straight through; see `catalogCredential` for why it ranks where it does. */
  environmentProvider?: CatalogCredentialInput['environmentProvider'];
  baseUrl: string;
  scope: ModelCatalogScope;
  refreshCatalog?: CatalogRefresh;
  /** The same seam as `refreshCatalog`, for the endpoint a non-OpenRouter provider answers on. */
  configuredCatalog?: (input: ConfiguredCatalogInput) => Promise<Array<Record<string, unknown>>>;
  seed?: () => ModelRelease[];
}): Promise<RefreshOutcome> => {
  const refreshCatalog = input.refreshCatalog ?? refreshOpenRouterCatalog;
  const configuredCatalog = input.configuredCatalog ?? refreshConfiguredCatalog;
  const seed = input.seed ?? seedModels;
  // Carried out of the try so a failure can still say how many models the picker is living on.
  let existingCount = 0;
  try {
    // The default scope offers whatever the owner's own provider account can reach, so a model
    // released after this build still appears without a code change. `reviewed_open_weight`
    // restores the stricter allowlist. A refresh failure preserves the previous catalog rather
    // than weakening privacy requirements or emptying the model picker.
    const credentials = await catalogCredentials({
      store: input.store,
      masterKey: input.masterKey,
      environmentKey: input.environmentKey,
      environmentProvider: input.environmentProvider
    });
    const existing = await input.store.listModels();
    existingCount = existing.length;
    if (credentials.length) {
      const failures: string[] = [];
      let refused = false;
      for (const credential of credentials) {
        try {
          const connectionId = credential.connectionId ?? credential.provider;
          // Unscoped legacy rows belong only to the default account for their protocol.
          const replacing = existing.filter(
            (model) =>
              model.connectionId === connectionId ||
              (connectionId === credential.provider &&
                (!model.connectionId || model.connectionId === model.provider) &&
                (model.provider === credential.provider ||
                  (credential.provider !== 'openrouter' &&
                    model.provider === 'custom' &&
                    Array.isArray(model.recommendationTags) &&
                    model.recommendationTags.includes(
                      credential.provider === 'ollama-cloud'
                        ? 'Ollama Cloud'
                        : 'Configured endpoint'
                    ))))
          );
          // A real refresh, and a replace rather than an upsert: a model the provider has withdrawn
          // should leave the picker rather than sit in it until somebody tries to use it.
          const live =
            credential.provider === 'openrouter'
              ? await refreshCatalog(seed(), {
                  baseUrl: credential.baseUrl ?? input.baseUrl,
                  apiKey: credential.apiKey ?? '',
                  scope: input.scope,
                  /*
                   * What the catalogue said an hour ago, so one failing request cannot withdraw the
                   * owner's private routes. Zero-retention is a fact about live endpoints and it
                   * arrives on its own request; when that request alone fails, the answer carried
                   * forward is the last one this box actually observed rather than "not verified",
                   * which the privacy projection would read as a reason to take every private model
                   * out of the picker.
                   */
                  previous: replacing.flatMap((model) => {
                    const parsed = ModelRelease.safeParse(model);
                    return parsed.success ? [parsed.data] : [];
                  })
                })
              : /*
                 * The other half of "openrouter etc.". Until this line the etc. was nothing: a
                 * credential for any other provider answered null above, the pass reported `frozen`,
                 * and the journal told the one owner it was about to save a provider key they had
                 * already saved. `configuredCatalog` asks the endpoint the same question the save path
                 * asks it and hands back rows in the same shape, so everything below - the gate, the
                 * per-provider prune, the record `doctor` reads - is shared rather than duplicated.
                 */
                await configuredCatalog({
                  provider: credential.provider,
                  baseUrl: credential.baseUrl ?? input.baseUrl,
                  apiKey: credential.apiKey,
                  modelId: credential.modelId,
                  enforceZeroDataRetention: credential.enforceZeroDataRetention,
                  connectionId,
                  ...(credential.catalogDefaults ? { defaults: credential.catalogDefaults } : {}),
                  previous: replacing
                });
          /*
           * The last thing between a provider's answer and deleting the owner's catalogue.
           *
           * Nothing used to stand here. The replace ran on whatever came back, and because every field
           * the importer reads is optional on the way in, an answer that had stopped describing models
           * - one renamed field upstream - was written whole, reported `refreshed`, and left the box
           * unable to pick a model for any piece of work, with `doctor` calling the catalogue current.
           * `implausibleReplacement` says what is wrong in a sentence; the pass carries it out to the
           * journal and to the record `doctor` reads, and the catalogue already here goes on serving.
           *
           * Compared against the same slice `replaceModelCatalog` would delete - the rows belonging to
           * the providers this answer actually covers - because those are the rows at risk and the only
           * ones an answer can be judged against. A catalogue holding both an OpenRouter set and a
           * configured one must not have either judged by the other's shape.
           */
          const scoped = live.map((model) => ({ ...model, connectionId }));
          const refusal = implausibleReplacement({ previous: replacing, live: scoped });
          if (refusal) {
            refused = true;
            failures.push(refusal);
            continue;
          }
          await input.store.replaceModelCatalog(scoped);
          if (live.length) existingCount += live.length - replacing.length;
        } catch (error) {
          failures.push(refreshFailureReason(error));
        }
      }
      return {
        state: failures.length ? (refused ? 'refused' : 'failed') : 'refreshed',
        models: existingCount,
        reason: failures.length ? failures.join('; ') : null
      };
    }

    if (!existingCount) {
      /*
       * No key, so there is nothing to refresh from — but an empty catalogue still needs something
       * in it, and this is the only thing that puts it there on a new box.
       *
       * It used to write the seed on every pass regardless. No shipped path sets a registry key, so
       * within an hour of finishing setup the static seed landed on top of the catalogue the API
       * had enriched from the owner's own provider account: the curated models went back to
       * availability 'review' and lost their prices, which took them out of the picker and made any
       * task or schedule pinned to one fail with model_unavailable. The owner's fix was to re-save
       * their provider key, and an hour later it happened again.
       */
      const models = seed();
      await input.store.upsertModels(models);
      return { state: 'seeded', models: models.length, reason: null };
    }
    return { state: 'frozen', models: existingCount, reason: null };
  } catch (error) {
    return { state: 'failed', models: existingCount, reason: refreshFailureReason(error) };
  }
};
