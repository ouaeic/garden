import type { MediaModelOption, MediaModelSelection } from '@garden/contracts';
import { sha256 } from '@garden/core';
import { resolveMediaModel, seedMediaModels } from './catalog.js';
import { describeOpenRouterImageModel, refreshOpenRouterMediaCatalog } from './media-catalog.js';
import { quoteMediaPrice } from './media-capabilities.js';
import { isNativeOpenAIEndpoint, refreshOpenAIMediaCatalog } from './openai-media-catalog.js';

export interface MediaRouteCredential {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  enforceZeroDataRetention: boolean;
  mediaModels?: MediaModelSelection;
}

export type ResolvedMediaRoutes = Partial<
  Record<'image' | 'audio' | 'transcription' | 'video', MediaModelOption>
>;

/** Shared catalogue and endpoint policy for the picker, approval and provider submission. */
export class MediaRouteResolver {
  readonly #catalogues = new Map<string, { expiresAt: number; options: MediaModelOption[] }>();
  readonly #images = new Map<string, { expiresAt: number; route: MediaModelOption }>();
  readonly #ttlMs = 5 * 60_000;

  constructor(private readonly options: { fetch?: typeof fetch; now?: () => number } = {}) {}

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #key(secret: MediaRouteCredential): string {
    return `${secret.provider}|${secret.baseUrl}|${sha256(secret.apiKey ?? '')}|${secret.enforceZeroDataRetention}`;
  }

  async catalog(secret: MediaRouteCredential): Promise<MediaModelOption[]> {
    const native = secret.provider !== 'openrouter' && isNativeOpenAIEndpoint(secret.baseUrl);
    if ((!native && secret.provider !== 'openrouter') || !secret.apiKey) return [];
    const key = this.#key(secret);
    const cached = this.#catalogues.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached.options;
    try {
      const models = await (native ? refreshOpenAIMediaCatalog : refreshOpenRouterMediaCatalog)({
        baseUrl: secret.baseUrl,
        apiKey: secret.apiKey,
        requireZeroDataRetention: secret.enforceZeroDataRetention,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {})
      });
      const options = models.map((model) =>
        model.modality === 'video' && model.requiresRetentionApproval
          ? { ...model, unavailableReason: null }
          : model
      );
      if (this.#catalogues.size >= 32) this.#catalogues.clear();
      this.#catalogues.set(key, { expiresAt: this.#now() + this.#ttlMs, options });
      return options;
    } catch {
      return (cached?.options ?? (native ? [] : seedMediaModels())).map((model) => ({
        ...model,
        unavailableReason:
          'The provider catalogue could not be verified. Try again when the connection is available.'
      }));
    }
  }

  async #image(secret: MediaRouteCredential, model: MediaModelOption): Promise<MediaModelOption> {
    if (model.unavailableReason || secret.provider !== 'openrouter' || !secret.apiKey) return model;
    const key = `${this.#key(secret)}|${model.id}`;
    const cached = this.#images.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached.route;
    try {
      const routes = await describeOpenRouterImageModel(model, {
        baseUrl: secret.baseUrl,
        apiKey: secret.apiKey,
        requireZeroDataRetention: true,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {})
      });
      const cost = (route: MediaModelOption) =>
        quoteMediaPrice(route.pricing, { width: 1024, height: 1024, count: 1 }) ?? Infinity;
      routes.sort(
        (a, b) =>
          cost(a) - cost(b) ||
          (a.providerEndpointTag ?? '').localeCompare(b.providerEndpointTag ?? '')
      );
      const route = routes[0];
      if (!route) throw new Error('No private image endpoint');
      if (this.#images.size >= 32) this.#images.clear();
      this.#images.set(key, { expiresAt: this.#now() + this.#ttlMs, route });
      return route;
    } catch {
      return {
        ...model,
        unavailableReason:
          'The selected image endpoint could not be verified. Choose a model or try again.'
      };
    }
  }

  async resolve(
    secret: MediaRouteCredential,
    selection = secret.mediaModels
  ): Promise<{
    options: MediaModelOption[];
    routes: ResolvedMediaRoutes;
  }> {
    const options = await this.catalog(secret);
    const routes: ResolvedMediaRoutes = {};
    for (const kind of ['image', 'audio', 'transcription', 'video'] as const) {
      const choice = selection?.[kind];
      const chosen = resolveMediaModel(options, choice, kind);
      if (chosen) routes[kind] = kind === 'image' ? await this.#image(secret, chosen) : chosen;
    }
    return {
      options: options.map((option) =>
        option.modality === 'image' && routes.image?.id === option.id ? routes.image : option
      ),
      routes
    };
  }
}
