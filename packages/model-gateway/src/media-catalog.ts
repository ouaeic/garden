import { GardenError } from '@garden/core';
import { seedMediaModels } from './catalog.js';
import { imageCapabilities } from './image-dimensions.js';
import { readBoundedMediaBody } from './media-output.js';
import { refreshOpenRouterTranscriptionModel } from './openrouter-transcription.js';
import {
  mediaRate,
  mediaRecord,
  readMediaCapabilities,
  readMediaPricing,
  type CatalogMediaModel,
  type MediaPriceLine
} from './media-capabilities.js';

export interface MediaCatalogOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  now?: Date;
  requireZeroDataRetention?: boolean;
}
const json = async (request: typeof fetch, url: string, apiKey: string): Promise<unknown> => {
  const response = await request(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`The media catalogue returned ${response.status}`);
  return JSON.parse(
    (await readBoundedMediaBody(response, 16 * 1024 * 1024)).toString('utf8')
  ) as unknown;
};
const rowsOf = (value: unknown): Record<string, unknown>[] =>
  mediaRecord(value) && Array.isArray(value.data) ? value.data.filter(mediaRecord) : [];
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9._:/~-]{0,299}$/.test(value) &&
  !value.split('/').includes('..');

export const refreshOpenRouterMediaCatalog = async (
  options: MediaCatalogOptions
): Promise<CatalogMediaModel[]> => {
  const request = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/$/, '');
  const paths = [
    'images/models',
    'models?output_modalities=speech',
    'models?output_modalities=transcription',
    'videos/models',
    'endpoints/zdr'
  ];
  const results = await Promise.allSettled(
    paths.map((path) => json(request, `${base}/${path}`, options.apiKey))
  );
  const bodies = results.map((result) =>
    result.status === 'fulfilled' ? result.value : undefined
  );
  if (!bodies.slice(0, 4).some((body) => rowsOf(body).length))
    throw new GardenError(
      'provider_catalog_empty',
      'The provider listed no media models, so the catalogue was left as it was',
      502
    );
  const zdrKnown = results[4]?.status === 'fulfilled';
  const zdrModels = new Set(
    rowsOf(bodies[4])
      .filter((row) => row.status === undefined || row.status === 0)
      .map((row) => row.model_id)
      .filter(validId)
  );
  const updatedAt = (options.now ?? new Date()).toISOString();
  const live = new Map<string, CatalogMediaModel>();
  const add = (raw: Record<string, unknown>, modality: CatalogMediaModel['modality']): void => {
    if (!validId(raw.id)) return;
    const pricing = mediaRecord(raw.pricing) ? raw.pricing : {};
    const speechRate = modality === 'audio' ? mediaRate(pricing.prompt) : null;
    const priceLines: MediaPriceLine[] =
      speechRate === null
        ? []
        : [{ billable: 'input_text', unit: 'character', costUsd: speechRate }];
    if (modality === 'video' && mediaRecord(raw.pricing_skus))
      for (const [sku, rate] of Object.entries(raw.pricing_skus)) {
        const costUsd = mediaRate(rate);
        const match = /^(?:duration_seconds|per-video-second)(?:[-_](.+))?$/.exec(sku);
        if (match && costUsd !== null)
          priceLines.push({
            billable: 'output_video',
            unit: 'second',
            costUsd,
            ...(match[1] ? { variant: match[1] } : {})
          });
      }
    let capabilities = readMediaCapabilities(raw.supported_parameters, raw.supports_streaming);
    if (modality === 'image') capabilities = imageCapabilities(raw.id, capabilities);
    if (modality === 'video') {
      const parameters: Record<string, unknown> = {};
      for (const [key, field] of [
        ['resolution', 'supported_resolutions'],
        ['aspect_ratio', 'supported_aspect_ratios'],
        ['size', 'supported_sizes']
      ] as const)
        parameters[key] = { type: 'enum', values: raw[field] };
      if (Array.isArray(raw.supported_durations))
        parameters.duration = {
          type: 'enum',
          values: raw.supported_durations
            .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
            .map(String)
        };
      if (raw.generate_audio === true) parameters.generate_audio = { type: 'boolean' };
      if (raw.seed === true) parameters.seed = { type: 'boolean' };
      capabilities = readMediaCapabilities(parameters, false);
    }
    const unknownUnit =
      modality === 'image'
        ? 'per-image'
        : modality === 'audio'
          ? 'per-character'
          : modality === 'video'
            ? 'per-second'
            : 'per-minute';
    live.set(`${modality}:${raw.id}`, {
      id: `openrouter/${raw.id}`,
      providerModelId: raw.id,
      displayName: typeof raw.name === 'string' ? raw.name : raw.id,
      provider: 'openrouter',
      modality,
      usdPerImage: null,
      usdPerMillionCharacters: speechRate === null ? null : speechRate * 1_000_000,
      usdPerMinute: null,
      ...(modality === 'video'
        ? {
            usdPerSecond:
              priceLines.length === 1 && !priceLines[0]?.variant ? priceLines[0]!.costUsd : null
          }
        : {}),
      priceSource: priceLines.length ? 'provider' : 'unknown',
      defaultVoice: null,
      apiProtocol: 'openrouter',
      capabilities,
      ...(priceLines.length ? { pricing: priceLines } : {}),
      recommendationTags: priceLines.length
        ? ['Provider pricing']
        : [`No ${unknownUnit} price published`],
      updatedAt,
      ...(modality === 'video' || modality === 'transcription'
        ? { zeroDataRetentionAvailable: false, requiresRetentionApproval: true }
        : zdrKnown
          ? { zeroDataRetentionAvailable: zdrModels.has(raw.id) }
          : {})
    });
  };
  for (const body of bodies.slice(0, 3))
    for (const row of rowsOf(body)) {
      const architecture = mediaRecord(row.architecture) ? row.architecture : {};
      const outputs = Array.isArray(architecture.output_modalities)
        ? architecture.output_modalities
        : [];
      if (outputs.includes('image')) add(row, 'image');
      if (outputs.includes('speech') || (outputs.includes('audio') && !outputs.includes('text')))
        add(row, 'audio');
      if (outputs.includes('transcription')) add(row, 'transcription');
    }
  for (const row of rowsOf(bodies[3]))
    if (Array.isArray(row.supported_durations) && row.supported_durations.length) add(row, 'video');
  const seeds = seedMediaModels(options.now).map((seed): CatalogMediaModel => {
    const found = live.get(`${seed.modality}:${seed.providerModelId}`);
    if (found) {
      live.delete(`${seed.modality}:${seed.providerModelId}`);
      return {
        ...seed,
        ...found,
        defaultVoice: seed.defaultVoice,
        recommendationTags: [...seed.recommendationTags, ...found.recommendationTags]
      };
    }
    return {
      ...seed,
      unavailableReason: 'this provider account does not list it',
      ...(zdrKnown ? { zeroDataRetentionAvailable: zdrModels.has(seed.providerModelId) } : {})
    };
  });
  const models = await Promise.all(
    [...seeds, ...live.values()].map(async (model) =>
      model.modality === 'transcription' && !model.unavailableReason
        ? refreshOpenRouterTranscriptionModel(model, options)
        : model.modality === 'transcription'
          ? { ...model, zeroDataRetentionAvailable: false, requiresRetentionApproval: true }
          : model
    )
  );
  return models.map((model) =>
    options.requireZeroDataRetention &&
    model.modality !== 'transcription' &&
    model.zeroDataRetentionAvailable === false &&
    !model.unavailableReason
      ? {
          ...model,
          unavailableReason:
            model.modality === 'video'
              ? 'Video requires approval for temporary provider retention'
              : 'no verified private route'
        }
      : model
  );
};

/** Fetch endpoint details only when a model is chosen; catalogue browsing never fans out per model. */
export const describeOpenRouterImageModel = async (
  model: CatalogMediaModel,
  options: MediaCatalogOptions
): Promise<CatalogMediaModel[]> => {
  if (model.modality !== 'image' || !validId(model.providerModelId))
    throw new Error('Choose a valid image model');
  const path = model.providerModelId.split('/').map(encodeURIComponent).join('/');
  const body = await json(
    options.fetch ?? globalThis.fetch,
    `${options.baseUrl.replace(/\/$/, '')}/images/models/${path}/endpoints`,
    options.apiKey
  );
  if (!mediaRecord(body) || !Array.isArray(body.endpoints))
    throw new Error('The provider returned no image endpoints');
  const privateTags = options.requireZeroDataRetention
    ? new Set(
        rowsOf(
          await json(
            options.fetch ?? globalThis.fetch,
            `${options.baseUrl.replace(/\/$/, '')}/endpoints/zdr`,
            options.apiKey
          )
        )
          .filter(
            (row) =>
              row.model_id === model.providerModelId &&
              (row.status === undefined || row.status === 0)
          )
          .map((row) => row.tag)
          .filter((tag): tag is string => typeof tag === 'string')
      )
    : undefined;
  return body.endpoints.filter(mediaRecord).flatMap((endpoint) => {
    if (typeof endpoint.provider_tag !== 'string' || !endpoint.provider_tag) return [];
    if (privateTags && !privateTags.has(endpoint.provider_tag)) return [];
    const pricing = readMediaPricing(endpoint.pricing);
    return [
      {
        ...model,
        providerEndpointTag: endpoint.provider_tag,
        metadataVerifiedAt: (options.now ?? new Date()).toISOString(),
        ...(privateTags ? { zeroDataRetentionAvailable: true } : {}),
        capabilities: imageCapabilities(
          model.providerModelId,
          readMediaCapabilities(endpoint.supported_parameters, endpoint.supports_streaming)
        ),
        pricing,
        priceSource: pricing.length ? ('provider' as const) : ('unknown' as const),
        usdPerImage:
          pricing.length === 1 &&
          pricing[0]?.billable === 'output_image' &&
          pricing[0].unit === 'image' &&
          !pricing[0].variant
            ? pricing[0].costUsd
            : null
      }
    ];
  });
};
