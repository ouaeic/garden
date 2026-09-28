import type { PrivacyRoute } from '@garden/contracts';
import { mediaRate, mediaRecord, type MediaCapabilities } from './media-capabilities.js';
import { decodeMediaBase64, mediaMimeType, readBoundedMediaBody } from './media-output.js';
import { OPENAI_VIDEO_RETIREMENT_AT } from './openai-media-catalog.js';

export interface VideoGenerationRequest {
  operation?: 'generate' | 'edit' | 'extend';
  sourceProviderId?: string;
  model: string;
  prompt: string;
  duration: number;
  resolution?: string;
  aspectRatio?: string;
  size?: string;
  generateAudio?: boolean;
  seed?: number;
  frameImages?: Array<{ image: string; frameType: 'first_frame' | 'last_frame' }>;
  inputReferences?: string[];
  characters?: Array<{ id: string }>;
  capabilities?: MediaCapabilities;
  providerEndpointTag?: string;
  signal?: AbortSignal;
}
export interface VideoGenerationJob {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
  progress?: number;
  costUsd?: number;
  generationId?: string;
  error?: string;
}
export class VideoSubmissionUncertainError extends Error {
  constructor(cause: unknown) {
    super(
      'The provider may have accepted the video job. Reconcile this submission before starting another.',
      { cause }
    );
    this.name = 'VideoSubmissionUncertainError';
  }
}
const jobId = (id: unknown): string => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(id))
    throw new Error('The provider returned an invalid video job ID');
  return id;
};
export const readVideoGenerationJob = (value: unknown): VideoGenerationJob => {
  if (!mediaRecord(value)) throw new Error('The provider returned no video job');
  const id = jobId(value.id);
  const status = value.status === 'queued' ? 'pending' : value.status;
  if (
    status !== 'pending' &&
    status !== 'in_progress' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'cancelled' &&
    status !== 'expired'
  )
    throw new Error('The provider returned an unknown video job state');
  const usage = mediaRecord(value.usage) ? value.usage : {};
  const costUsd = mediaRate(usage.cost);
  if (usage.cost !== undefined && usage.cost !== null && costUsd === null)
    throw new Error('The provider returned an invalid video cost');
  const error =
    typeof value.error === 'string'
      ? value.error
      : mediaRecord(value.error) && typeof value.error.message === 'string'
        ? value.error.message
        : undefined;
  return {
    id,
    status,
    ...(typeof value.progress === 'number' &&
    Number.isFinite(value.progress) &&
    value.progress >= 0 &&
    value.progress <= 100
      ? { progress: value.progress }
      : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(typeof value.generation_id === 'string'
      ? { generationId: value.generation_id.slice(0, 256) }
      : {}),
    ...(error ? { error: error.slice(0, 2000) } : {})
  };
};
const imageReference = (data: string): { bytes: Buffer; mimeType: string } => {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(data);
  if (!match) throw new Error('Video references must be prepared workspace image bytes');
  const bytes = decodeMediaBase64(match[2]!, 16 * 1024 * 1024);
  return { bytes, mimeType: mediaMimeType(bytes, match[1]!, 'image') };
};

/** One HTTP operation at a time. The caller owns job persistence, reservations and polling cadence. */
export class VideoClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      privacyRoute: PrivacyRoute;
      apiProtocol?: 'openrouter' | 'openai';
      fetch?: typeof fetch;
    }
  ) {}
  #url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/${path}`;
  }
  #request(path: string, init: RequestInit): Promise<Response> {
    return (this.options.fetch ?? globalThis.fetch)(this.#url(path), {
      ...init,
      redirect: 'error',
      headers: { authorization: `Bearer ${this.options.apiKey}`, ...init.headers }
    });
  }
  validate(input: VideoGenerationRequest): void {
    if (this.options.privacyRoute !== 'external')
      throw new Error('Video requires an approved temporary provider-retention route');
    if (
      !input.model ||
      !input.prompt.trim() ||
      input.prompt.length > 100_000 ||
      !Number.isInteger(input.duration) ||
      input.duration < 1 ||
      input.duration > 120
    )
      throw new Error('Choose a valid bounded video request');
    if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0))
      throw new Error('Choose a valid video seed');
    if ((input.frameImages?.length ?? 0) > 2 || (input.inputReferences?.length ?? 0) > 10)
      throw new Error('Too many video reference images');
    const seen = new Set<string>();
    let referenceBytes = 0;
    for (const frame of input.frameImages ?? []) {
      if (seen.has(frame.frameType))
        throw new Error('Each video frame position may be supplied once');
      seen.add(frame.frameType);
      referenceBytes += imageReference(frame.image).bytes.length;
    }
    for (const reference of input.inputReferences ?? [])
      referenceBytes += imageReference(reference).bytes.length;
    if (referenceBytes > 64 * 1024 * 1024)
      throw new Error('Video references exceed the total byte limit');
    const native = this.options.apiProtocol === 'openai';
    if (
      native &&
      /^sora-2(?:-|$)/.test(input.model) &&
      Date.now() >= Date.parse(OPENAI_VIDEO_RETIREMENT_AT)
    )
      throw new Error('The provider has retired this native video API');
    if (native && input.prompt.length > 32_000)
      throw new Error('Native video prompts are limited to 32000 characters');
    if (input.characters?.length) {
      if (!native || (input.operation ?? 'generate') !== 'generate' || input.characters.length > 2)
        throw new Error(
          'Native video generation supports at most two characters; edits and extensions do not accept them'
        );
      const ids = input.characters.map((character) => jobId(character.id));
      if (new Set(ids).size !== ids.length) throw new Error('Choose each character once');
    }
    if ((input.operation ?? 'generate') !== 'generate') {
      if (!native || !input.sourceProviderId)
        throw new Error('Video edits and extensions require a native source job');
      jobId(input.sourceProviderId);
      if (input.frameImages?.length || input.inputReferences?.length)
        throw new Error('Video edits and extensions do not accept image references');
      if (input.operation === 'extend' && input.duration > 20)
        throw new Error('A video extension adds at most twenty seconds');
    } else if (input.sourceProviderId)
      throw new Error('A new generation cannot include a source job');
    if (
      native &&
      (input.frameImages?.some((frame) => frame.frameType !== 'first_frame') ||
        (input.inputReferences?.length ?? 0) > 0 ||
        input.resolution ||
        input.aspectRatio ||
        input.generateAudio !== undefined ||
        input.seed !== undefined)
    )
      throw new Error(
        'This native video route requires an explicit size and an optional first-frame image'
      );
    const values: Record<string, unknown> = {
      duration: input.duration,
      resolution: input.resolution,
      aspect_ratio: input.aspectRatio,
      size: input.size,
      generate_audio: input.generateAudio,
      seed: input.seed
    };
    if (input.capabilities)
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined || (name === 'duration' && input.operation === 'edit')) continue;
        const parameter = input.capabilities.parameters[name];
        if (
          !parameter ||
          (parameter.type === 'enum' &&
            ((typeof value !== 'string' && typeof value !== 'number') ||
              !parameter.values.includes(String(value)))) ||
          (parameter.type === 'range' &&
            (typeof value !== 'number' || value < parameter.min || value > parameter.max))
        )
          throw new Error(`The selected video route does not support this ${name} value`);
      }
  }
  async submit(input: VideoGenerationRequest): Promise<VideoGenerationJob> {
    this.validate(input);
    const native = this.options.apiProtocol === 'openai';
    let body: string | FormData;
    const headers: Record<string, string> = {};
    const operation = input.operation ?? 'generate';
    if (native && operation !== 'generate') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({
        video: { id: input.sourceProviderId },
        prompt: input.prompt,
        ...(operation === 'extend' ? { seconds: String(input.duration) } : {})
      });
    } else if (native && input.characters?.length) {
      headers['content-type'] = 'application/json';
      const first = input.frameImages?.find((frame) => frame.frameType === 'first_frame');
      body = JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        seconds: String(input.duration),
        ...(input.size ? { size: input.size } : {}),
        characters: input.characters,
        ...(first ? { input_reference: { image_url: first.image } } : {})
      });
    } else if (native) {
      const form = new FormData();
      form.set('model', input.model);
      form.set('prompt', input.prompt);
      form.set('seconds', String(input.duration));
      if (input.size) form.set('size', input.size);
      const first = input.frameImages?.find((frame) => frame.frameType === 'first_frame');
      if (first) {
        const reference = imageReference(first.image);
        form.set(
          'input_reference',
          new Blob([new Uint8Array(reference.bytes)], { type: reference.mimeType }),
          `reference.${reference.mimeType.split('/')[1]}`
        );
      }
      body = form;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        duration: input.duration,
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.size ? { size: input.size } : {}),
        ...(input.generateAudio !== undefined ? { generate_audio: input.generateAudio } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.frameImages?.length
          ? {
              frame_images: input.frameImages.map((frame) => ({
                type: 'image_url',
                image_url: { url: frame.image },
                frame_type: frame.frameType
              }))
            }
          : {}),
        ...(input.inputReferences?.length
          ? {
              input_references: input.inputReferences.map((url) => ({
                type: 'image_url',
                image_url: { url }
              }))
            }
          : {}),
        provider: {
          zdr: false,
          data_collection: 'deny',
          ...(input.providerEndpointTag
            ? { only: [input.providerEndpointTag], allow_fallbacks: false }
            : {})
        }
      });
    }
    input.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await this.#request(
        operation === 'generate'
          ? 'videos'
          : operation === 'edit'
            ? 'videos/edits'
            : 'videos/extensions',
        {
          method: 'POST',
          headers,
          body,
          signal: input.signal
            ? AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
            : AbortSignal.timeout(120_000)
        }
      );
    } catch (error) {
      throw new VideoSubmissionUncertainError(error);
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408)
        throw new VideoSubmissionUncertainError(new Error(`Provider status ${response.status}`));
      throw new Error(`Video submission was refused (${response.status})`);
    }
    try {
      return readVideoGenerationJob(
        JSON.parse((await readBoundedMediaBody(response, 2 * 1024 * 1024)).toString('utf8'))
      );
    } catch (error) {
      throw new VideoSubmissionUncertainError(error);
    }
  }
  async poll(id: string, signal?: AbortSignal): Promise<VideoGenerationJob> {
    const expected = jobId(id);
    const response = await this.#request(`videos/${expected}`, {
      method: 'GET',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Video status could not be read (${response.status})`);
    const result = readVideoGenerationJob(
      JSON.parse((await readBoundedMediaBody(response, 2 * 1024 * 1024)).toString('utf8'))
    );
    if (result.id !== expected) throw new Error('The provider returned a different video job');
    return result;
  }
  async download(
    id: string,
    signal?: AbortSignal
  ): Promise<{ bytes: Buffer; mimeType: 'video/mp4'; filename: string }> {
    const checked = jobId(id);
    const response = await this.#request(`videos/${checked}/content`, {
      method: 'GET',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`Video content could not be downloaded (${response.status})`);
    const bytes = await readBoundedMediaBody(response, 256 * 1024 * 1024);
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (mime !== 'video/mp4' || bytes.toString('ascii', 4, 8) !== 'ftyp')
      throw new Error('The provider video bytes do not match MP4 content');
    return { bytes, mimeType: 'video/mp4', filename: `${checked}.mp4` };
  }
}
