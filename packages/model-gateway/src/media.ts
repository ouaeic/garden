import { imageCapabilities, resolveImageDimensions } from './image-dimensions.js';
import {
  decodeMediaBase64,
  downloadMedia,
  MAX_MEDIA_JSON_BYTES,
  mediaMimeType,
  readBoundedMediaBody
} from './media-output.js';
import {
  quoteMediaPrice,
  type MediaCapabilities,
  type MediaPriceLine
} from './media-capabilities.js';
import { MAX_IMAGE_MASK_BYTES, validateImageMask } from './image-mask.js';
import { isNativeOpenAIEndpoint } from './openai-media-catalog.js';
import { isOpenRouterEndpoint } from './openrouter-transcription.js';

/**
 * Generated media, fetched the same way as any other provider call.
 *
 * This used to be a service. A job row was written, a second process leased it, generated, wrote
 * the file and marked the row done, and the agent polled a `media_status` tool until it saw the
 * result. None of that bought asynchrony: the poll blocked the turn anyway, so the only thing the
 * queue added was a second tool call, a second runner client, two encrypted columns and a spend
 * reconciliation that existed purely because a queued job had not billed yet. An image takes about
 * ten seconds and speech about five, on a computer where `shell` blocks for up to an hour, so the
 * generation is just a request now and the file exists when it returns.
 */

const validCost = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('The provider returned an invalid media cost');
  return value;
};
const providerError = async (response: Response): Promise<string> => {
  try {
    return (await readBoundedMediaBody(response, 64 * 1024)).toString('utf8').slice(0, 2000);
  } catch {
    return 'The provider returned no bounded error detail';
  }
};

export class MediaProviderRejectionError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'MediaProviderRejectionError';
  }
}
export class TranscriptionEmptyError extends Error {
  constructor() {
    super('The provider returned no speech from that recording');
    this.name = 'TranscriptionEmptyError';
  }
}
const rejection = (message: string, status: number): Error =>
  status >= 400 && status < 500 && status !== 408
    ? new MediaProviderRejectionError(message, status)
    : new Error(message);

export interface GeneratedMedia {
  filename: string;
  bytes: Buffer;
  mimeType: string;
}

export interface GeneratedMediaResult {
  outputs: GeneratedMedia[];
  costUsd: number;
  costFromProvider?: boolean;
  costKnown?: boolean;
  providerGenerationId?: string;
}

export interface MediaRequest {
  /** Names the output files, so a caller can tell one generation's files from another's. */
  id: string;
  kind: 'image' | 'audio';
  model: string;
  prompt: string;
  width: number;
  height: number;
  seed: number;
  /**
   * The voice to speak in, when the chosen route names its voices.
   *
   * Sent only when the caller supplies one. This used to be a constant, and the constant belonged
   * to one specific speech model - so the moment the model became the owner's choice, every other
   * speech route would have been asked for a voice from a different model's list. A route whose
   * voices garden does not know is asked without one, and the provider's own answer says what it
   * needs, which is better than this side inventing a name for it.
   */
  voice?: string;
  speed?: number;
  outputFormat?: 'png' | 'jpeg' | 'webp' | 'mp3' | 'pcm' | 'opus' | 'aac' | 'flac' | 'wav';
  instructions?: string;
  outputCompression?: number;
  mask?: string;
  moderation?: 'auto' | 'low';
  quality?: 'auto' | 'low' | 'medium' | 'high';
  aspectRatio?: string;
  resolution?: string;
  background?: 'auto' | 'transparent' | 'opaque';
  count?: number;
  inputReferences?: string[];
  capabilities?: MediaCapabilities;
  pricing?: MediaPriceLine[];
  inputImageMegapixels?: number[];
  providerEndpointTag?: string;
  signal?: AbortSignal;
  onBeforeSubmit?: () => Promise<void>;
  onUsage?: (receipt: Omit<GeneratedMediaResult, 'outputs'>) => Promise<void>;
  /**
   * What the caller believes this route costs, used only when the provider does not say.
   *
   * Both are per the unit the modality is billed in and both may be absent. Every response path
   * below prefers the provider's own figure; these exist so that a route garden has measured
   * still prices its own generations rather than borrowing the price of whatever model happened to
   * be compiled in.
   */
  usdPerImage?: number | null;
  usdPerMillionCharacters?: number | null;
}

/**
 * A recording to be read back as text, already cut and re-encoded by the computer that holds it.
 *
 * The bytes arrive prepared rather than raw on purpose: transcription is billed by duration, so the
 * length of what is sent is the size of the bill, and the only place that can be decided honestly
 * is before the request rather than inside it.
 */
export interface TranscriptionRequest {
  model: string;
  privacyRoute?: 'provider_zdr' | 'external';
  externalConsent?: boolean;
  audio: Buffer;
  /** The container the bytes are in, as the endpoint names containers. */
  format: 'ogg' | 'wav' | 'mp3' | 'flac' | 'm4a' | 'webm' | 'aac';
  pricing?: MediaPriceLine[];
  onBeforeSubmit?: () => Promise<void>;
  onUsage?: (receipt: Omit<TranscriptionResult, 'text' | 'segments'>) => Promise<void>;
  keywords?: string[];
  languages?: string[];
  /** What the caller believes the route costs per minute, used only when the provider is silent. */
  usdPerMinute?: number | null;
  /** How long the prepared audio runs, for pricing a provider that reports no duration of its own. */
  seconds: number;
  signal?: AbortSignal;
  language?: string;
  prompt?: string;
  responseFormat?: 'json' | 'verbose_json' | 'diarized_json';
}

export interface TranscriptionResult {
  text: string;
  costKnown: boolean;
  segments?: Array<{ text: string; start: number; end: number; speaker?: string }>;
  /** The duration the provider says it billed, where it says one. */
  billedSeconds: number | null;
  costUsd: number;
  /** True when the figure above is the provider's own rather than this side's arithmetic. */
  costFromProvider: boolean;
}

/** The same zero-retention policy the inference adapter sends, because it is the same account. */
const PROVIDER_POLICY = {
  zdr: true,
  data_collection: 'deny',
  require_parameters: true,
  allow_fallbacks: true
} as const;

export class MediaClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey?: string;
      appUrl: string;
      timeoutSeconds?: number;
      /** False for an OpenAI-compatible endpoint that would reject OpenRouter's routing block. */
      openRouter?: boolean;
      apiProtocol?: 'openrouter' | 'openai';
    }
  ) {}

  #headers(): Record<string, string> {
    return {
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      'http-referer': this.options.appUrl,
      'x-title': 'garden',
      'content-type': 'application/json'
    };
  }

  #endpoint(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/${path}`;
  }

  #routing(tag?: string): Record<string, unknown> {
    return this.options.apiProtocol === 'openai' || this.options.openRouter === false
      ? {}
      : {
          provider: { ...PROVIDER_POLICY, ...(tag ? { only: [tag], allow_fallbacks: false } : {}) }
        };
  }

  #signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout((this.options.timeoutSeconds ?? 180) * 1_000);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  #validate(input: MediaRequest): void {
    if (!input.prompt.trim() || input.prompt.length > 100_000)
      throw new Error('A bounded media prompt is required');
    if (
      input.kind === 'image' &&
      (!Number.isInteger(input.width) ||
        !Number.isInteger(input.height) ||
        input.width < 1 ||
        input.height < 1 ||
        input.width > 8192 ||
        input.height > 8192)
    )
      throw new Error('Choose valid image dimensions');
    if (input.kind === 'image') resolveImageDimensions(input);
    if (
      input.count !== undefined &&
      (!Number.isInteger(input.count) || input.count < 1 || input.count > 10)
    )
      throw new Error('Choose one to ten images');
    if (
      input.speed !== undefined &&
      (!Number.isFinite(input.speed) || input.speed < 0.25 || input.speed > 4)
    )
      throw new Error('Choose a valid speech speed');
    const formats =
      input.kind === 'image'
        ? ['png', 'jpeg', 'webp']
        : ['mp3', 'pcm', 'opus', 'aac', 'flac', 'wav'];
    if (input.outputFormat && !formats.includes(input.outputFormat))
      throw new Error('The output format does not match the media kind');
    if (
      input.outputCompression !== undefined &&
      (!Number.isInteger(input.outputCompression) ||
        input.outputCompression < 0 ||
        input.outputCompression > 100 ||
        !['jpeg', 'webp'].includes(input.outputFormat ?? 'png'))
    )
      throw new Error('Compression requires JPEG or WebP and an integer from zero to one hundred');
    if (input.background === 'transparent' && input.outputFormat === 'jpeg')
      throw new Error('Transparent images require PNG or WebP');
    if (
      input.instructions !== undefined &&
      (input.kind !== 'audio' || input.instructions.length > 10_000)
    )
      throw new Error('Choose bounded speech instructions');
    const native = this.options.apiProtocol === 'openai' || this.options.openRouter === false;
    if (native && input.kind === 'image' && input.model.startsWith('gpt-image-2')) {
      const area = input.width * input.height;
      if (
        Math.max(input.width, input.height) > 3840 ||
        input.width % 16 ||
        input.height % 16 ||
        Math.max(input.width, input.height) / Math.min(input.width, input.height) > 3 ||
        area < 655_360 ||
        area > 8_294_400
      )
        throw new Error('This image model requires valid dimensions, aspect ratio and pixel area');
    }
    if (input.mask) {
      if (!native || !input.inputReferences?.length)
        throw new Error('An image mask requires a native image edit with a reference');
      const match = /^data:image\/png;base64,(.+)$/.exec(input.mask);
      if (!match) throw new Error('Choose a prepared PNG image mask');
      const reference = /^data:image\/(?:png|jpeg|webp);base64,(.+)$/.exec(
        input.inputReferences[0]!
      );
      if (!reference) throw new Error('Image references must be prepared workspace image bytes');
      validateImageMask(
        decodeMediaBase64(match[1]!, MAX_IMAGE_MASK_BYTES),
        decodeMediaBase64(reference[1]!, 16 * 1024 * 1024)
      );
    }
    if (input.inputReferences) {
      if (input.kind !== 'image' || input.inputReferences.length > 10)
        throw new Error('Choose at most ten image references');
      let referenceBytes = 0;
      for (const reference of input.inputReferences) {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(reference);
        if (!match) throw new Error('Image references must be prepared workspace image bytes');
        const bytes = decodeMediaBase64(match[2]!, 16 * 1024 * 1024);
        referenceBytes += bytes.length;
        if (referenceBytes > 64 * 1024 * 1024)
          throw new Error('Image references exceed the total byte limit');
        mediaMimeType(bytes, match[1]!, 'image');
      }
    }
    const values: Record<string, unknown> = {
      quality: input.quality,
      instructions: input.instructions,
      output_compression: input.outputCompression,
      mask: input.mask,
      moderation: input.moderation,
      aspect_ratio: input.aspectRatio,
      resolution: input.resolution,
      background: input.background,
      n: input.count,
      voice: input.voice,
      speed: input.speed,
      output_format: input.outputFormat,
      input_references: input.inputReferences?.length,
      ...(native && input.kind === 'image' && input.capabilities?.parameters.size
        ? { size: `${input.width}x${input.height}` }
        : {})
    };
    const capabilities =
      input.kind === 'image' && input.capabilities
        ? imageCapabilities(input.model, input.capabilities)
        : input.capabilities;
    if (capabilities)
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue;
        const parameter = capabilities.parameters[key];
        if (
          !parameter ||
          (parameter.type === 'enum' &&
            ((typeof value !== 'string' && typeof value !== 'number') ||
              !parameter.values.includes(String(value)))) ||
          (parameter.type === 'range' &&
            (typeof value !== 'number' || value < parameter.min || value > parameter.max))
        )
          throw new Error(`The selected media route does not support this ${key} value`);
      }
    input.signal?.throwIfAborted();
    if (
      (this.options.apiProtocol === 'openai' || this.options.openRouter === false) &&
      (input.aspectRatio !== undefined || input.resolution !== undefined)
    )
      throw new Error('Choose pixel dimensions for the selected native image route');
  }

  async generate(input: MediaRequest): Promise<GeneratedMediaResult> {
    this.#validate(input);
    input.signal?.throwIfAborted();
    await input.onBeforeSubmit?.();
    input.signal?.throwIfAborted();
    return input.kind === 'image' ? this.#image(input) : this.#speech(input);
  }

  /** Discover recording-to-text models from the configured provider's current catalogue. */
  async transcriptionModels(): Promise<string[]> {
    const url = new URL(this.#endpoint('models'));
    url.searchParams.set('output_modalities', 'transcription');
    url.searchParams.set('sort', 'top-weekly');
    const response = await fetch(url, { headers: this.#headers(), signal: this.#signal() });
    if (!response.ok)
      throw new Error(`The transcription catalogue could not be read (${response.status})`);
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  /**
   * OpenRouter transcription requires explicit external consent because this endpoint does not
   * enforce chat routing policy. Only actual provider cost settles its aggregate reservation.
   * Native requests retain their verified route policy and distinguish receipts from quotes.
   */
  async transcribe(input: TranscriptionRequest): Promise<TranscriptionResult> {
    const native =
      !isOpenRouterEndpoint(this.options.baseUrl) &&
      (this.options.apiProtocol === 'openai' || this.options.openRouter === false);
    if (
      !(native && isNativeOpenAIEndpoint(this.options.baseUrl)) &&
      (input.privacyRoute !== 'external' || input.externalConsent !== true)
    )
      throw new Error('This transcription endpoint requires explicit external retention consent');
    if (input.privacyRoute === 'external' && input.externalConsent !== true)
      throw new Error('Confirm external retention before sending this recording');
    if (!native && input.responseFormat === 'diarized_json')
      throw new Error('OpenRouter transcription supports json or verbose_json');
    if (!native && input.prompt && input.model !== 'openai/whisper-1')
      throw new Error('This transcription model has no verified provider prompt option');
    if (
      !input.audio.length ||
      input.audio.length > 25 * 1024 * 1024 ||
      !Number.isFinite(input.seconds) ||
      input.seconds <= 0
    )
      throw new Error('Choose nonempty prepared audio within the 25 MB transcription limit');
    const diarized = native && input.model.includes('transcribe-diarize');
    const responseFormat = input.responseFormat ?? (diarized ? 'diarized_json' : 'json');
    if (
      native &&
      ((responseFormat === 'diarized_json' && !diarized) ||
        (responseFormat === 'verbose_json' && input.model !== 'whisper-1'))
    )
      throw new Error('This native transcription model does not support that response format');
    if (diarized && input.prompt)
      throw new Error('This diarization model does not support a prompt');
    if (
      (input.keywords?.length || input.languages?.length) &&
      (!native || input.model !== 'gpt-transcribe')
    )
      throw new Error(
        'Keyword and multiple-language hints require the selected GPT Transcribe route'
      );
    const headers = this.#headers();
    let body: string | FormData;
    if (native) {
      const form = new FormData();
      form.set('model', input.model);
      form.set(
        'file',
        new Blob([new Uint8Array(input.audio)], {
          type: `audio/${input.format === 'mp3' ? 'mpeg' : input.format === 'm4a' ? 'mp4' : input.format}`
        }),
        `recording.${input.format}`
      );
      if (input.language) form.set('language', input.language);
      if (input.prompt) form.set('prompt', input.prompt);
      form.set('response_format', responseFormat);
      if (diarized && input.seconds > 30) form.set('chunking_strategy', 'auto');
      for (const keyword of input.keywords ?? []) form.append('keywords[]', keyword);
      for (const language of input.languages ?? []) form.append('languages[]', language);
      delete headers['content-type'];
      body = form;
    } else
      body = JSON.stringify({
        model: input.model,
        input_audio: { data: input.audio.toString('base64'), format: input.format },
        temperature: 0,
        ...(input.language ? { language: input.language } : {}),
        ...(input.prompt ? { provider: { options: { openai: { prompt: input.prompt } } } } : {}),
        ...(input.responseFormat ? { response_format: input.responseFormat } : {})
      });
    input.signal?.throwIfAborted();
    await input.onBeforeSubmit?.();
    input.signal?.throwIfAborted();
    const response = await fetch(this.#endpoint('audio/transcriptions'), {
      method: 'POST',
      headers,
      signal: this.#signal(input.signal),
      redirect: 'error',
      body
    });
    if (!response.ok)
      throw rejection(
        `Transcription failed (${response.status}): ${await providerError(response)}`,
        response.status
      );
    const result = JSON.parse(
      (await readBoundedMediaBody(response, 8 * 1024 * 1024)).toString('utf8')
    ) as {
      text?: string;
      duration?: number;
      usage?: { seconds?: number; cost?: number; input_tokens?: number; output_tokens?: number };
      segments?: Array<{ text?: unknown; start?: unknown; end?: unknown; speaker?: unknown }>;
    };
    const text = (typeof result.text === 'string' ? result.text : '').trim();
    const billedSeconds =
      typeof result.usage?.seconds === 'number' &&
      Number.isFinite(result.usage.seconds) &&
      result.usage.seconds >= 0
        ? result.usage.seconds
        : typeof result.duration === 'number' &&
            Number.isFinite(result.duration) &&
            result.duration >= 0
          ? result.duration
          : null;
    const providerCost = validCost(result.usage?.cost);
    // A load-balanced endpoint's aggregate quote bounds admission; it is not a charge receipt.
    const quote = !native
      ? null
      : input.pricing?.length
        ? quoteMediaPrice(input.pricing, {
            seconds: billedSeconds ?? input.seconds,
            tokens: {
              ...(result.usage?.input_tokens === undefined
                ? {}
                : { input_tokens: result.usage.input_tokens }),
              ...(result.usage?.output_tokens === undefined
                ? {}
                : { output_tokens: result.usage.output_tokens })
            }
          })
        : input.usdPerMinute == null
          ? null
          : ((billedSeconds ?? input.seconds) / 60) * input.usdPerMinute;
    const receipt = {
      billedSeconds,
      costUsd: providerCost ?? quote ?? 0,
      costFromProvider: providerCost !== null,
      costKnown: providerCost !== null || quote !== null
    };
    await input.onUsage?.(receipt);
    if (!text) throw new TranscriptionEmptyError();
    return {
      text,
      ...receipt,
      ...(Array.isArray(result.segments)
        ? {
            segments: result.segments.flatMap((segment) =>
              typeof segment.text === 'string' &&
              typeof segment.start === 'number' &&
              Number.isFinite(segment.start) &&
              segment.start >= 0 &&
              typeof segment.end === 'number' &&
              Number.isFinite(segment.end) &&
              segment.end >= segment.start
                ? [
                    {
                      text: segment.text,
                      start: segment.start,
                      end: segment.end,
                      ...(typeof segment.speaker === 'string' ? { speaker: segment.speaker } : {})
                    }
                  ]
                : []
            )
          }
        : {})
    };
  }

  async #image(input: MediaRequest): Promise<GeneratedMediaResult> {
    const format = input.outputFormat ?? 'png';
    const native = this.options.apiProtocol === 'openai' || this.options.openRouter === false;
    const headers = this.#headers();
    const fields = {
      model: input.model,
      prompt: input.prompt,
      size: `${input.width}x${input.height}`,
      ...(input.outputFormat ? { output_format: input.outputFormat } : {}),
      ...(this.options.apiProtocol === 'openai' || this.options.openRouter === false
        ? {}
        : { seed: input.seed }),
      ...(input.quality ? { quality: input.quality } : {}),
      ...(input.outputCompression === undefined
        ? {}
        : { output_compression: input.outputCompression }),
      ...(input.moderation ? { moderation: input.moderation } : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.background ? { background: input.background } : {}),
      ...(input.count ? { n: input.count } : {}),
      ...(input.inputReferences?.length
        ? {
            input_references: input.inputReferences.map((url) => ({
              type: 'image_url',
              image_url: { url }
            }))
          }
        : {}),
      ...this.#routing(input.providerEndpointTag)
    };
    let body: string | FormData = JSON.stringify(fields);
    const editing = native && Boolean(input.inputReferences?.length);
    if (editing) {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields))
        if (key !== 'input_references' && value !== undefined)
          form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      for (const [index, reference] of (input.inputReferences ?? []).entries()) {
        const comma = reference.indexOf(',');
        const mimeType = reference.slice(5, reference.indexOf(';'));
        form.append(
          'image[]',
          new Blob([new Uint8Array(decodeMediaBase64(reference.slice(comma + 1)))], {
            type: mimeType
          }),
          `reference-${index}.${mimeType.split('/')[1]}`
        );
      }
      if (input.mask)
        form.set(
          'mask',
          new Blob(
            [new Uint8Array(decodeMediaBase64(input.mask.slice(input.mask.indexOf(',') + 1)))],
            { type: 'image/png' }
          ),
          'mask.png'
        );
      delete headers['content-type'];
      body = form;
    }
    const response = await fetch(
      this.#endpoint(native ? (editing ? 'images/edits' : 'images/generations') : 'images'),
      { method: 'POST', headers, signal: this.#signal(input.signal), redirect: 'error', body }
    );
    if (!response.ok)
      throw rejection(
        `Image generation failed (${response.status}): ${await providerError(response)}`,
        response.status
      );
    const result = JSON.parse(
      (await readBoundedMediaBody(response, MAX_MEDIA_JSON_BYTES)).toString('utf8')
    ) as {
      data?: Array<{ b64_json?: string; url?: string; media_type?: string }>;
      usage?: { cost?: number };
    };
    const usage = result.usage as
      | {
          cost?: number;
          output_tokens?: unknown;
          input_tokens_details?: {
            image_tokens?: unknown;
            text_tokens?: unknown;
            cached_tokens?: unknown;
          };
        }
      | undefined;
    const tokenValues = [
      usage?.input_tokens_details?.text_tokens,
      usage?.input_tokens_details?.image_tokens,
      usage?.output_tokens
    ];
    const tokens =
      tokenValues.every(
        (value) =>
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= 100_000_000
      ) && !usage?.input_tokens_details?.cached_tokens
        ? {
            input_text: Number(tokenValues[0]),
            input_image: Number(tokenValues[1]),
            output_image: Number(tokenValues[2])
          }
        : undefined;
    const reported = validCost(result.usage?.cost);
    const quoted = input.pricing?.length
      ? quoteMediaPrice(input.pricing, {
          width: input.width,
          height: input.height,
          count: Array.isArray(result.data) ? result.data.length : (input.count ?? 1),
          inputImageCount: input.inputReferences?.length ?? 0,
          ...(tokens ? { tokens } : {}),
          characters: input.prompt.length,
          ...(input.quality ? { variant: input.quality } : {}),
          ...(input.inputImageMegapixels
            ? { inputImageMegapixels: input.inputImageMegapixels }
            : {})
        })
      : input.usdPerImage === undefined || input.usdPerImage === null
        ? null
        : input.usdPerImage *
          (Array.isArray(result.data) ? result.data.length : (input.count ?? 1));
    await input.onUsage?.({
      costUsd: reported ?? quoted ?? 0,
      costFromProvider: reported !== null,
      costKnown: reported !== null || quoted !== null
    });
    const outputs: GeneratedMedia[] = [];
    if (!Array.isArray(result.data) || result.data.length > (input.count ?? 1))
      throw new Error('The provider returned an unexpected image count');
    for (const [index, item] of result.data.entries()) {
      const name = `${input.id}-${index + 1}.${format}`;
      if (item.b64_json)
        outputs.push({
          filename: name,
          bytes: decodeMediaBase64(item.b64_json),
          mimeType:
            item.media_type ??
            (input.outputFormat ? `image/${input.outputFormat}` : 'application/octet-stream')
        });
      else if (item.url)
        outputs.push({
          filename: name,
          ...(await downloadMedia(item.url, this.#signal(input.signal)))
        });
    }
    if (!outputs.length) throw new Error('The provider returned no generated images');
    for (const output of outputs) {
      output.mimeType = mediaMimeType(output.bytes, output.mimeType, 'image');
      output.filename = output.filename.replace(/\.[^.]+$/, `.${output.mimeType.split('/')[1]}`);
    }

    return {
      outputs,
      costFromProvider: reported !== null,
      costKnown: reported !== null || quoted !== null,
      costUsd: reported ?? quoted ?? 0
    };
  }

  async #speech(input: MediaRequest): Promise<GeneratedMediaResult> {
    const response = await fetch(this.#endpoint('audio/speech'), {
      method: 'POST',
      headers: this.#headers(),
      signal: this.#signal(input.signal),
      redirect: 'error',
      body: JSON.stringify({
        model: input.model,
        input: input.prompt,
        ...(input.voice ? { voice: input.voice } : {}),
        response_format: input.outputFormat ?? 'mp3',
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...this.#routing(input.providerEndpointTag)
      })
    });
    if (!response.ok)
      throw rejection(
        `Speech generation failed (${response.status}): ${await providerError(response)}`,
        response.status
      );
    const quoted = input.pricing?.length
      ? quoteMediaPrice(input.pricing, { characters: input.prompt.length })
      : input.usdPerMillionCharacters == null
        ? null
        : (input.prompt.length * input.usdPerMillionCharacters) / 1_000_000;
    await input.onUsage?.({
      costUsd: quoted ?? 0,
      costFromProvider: false,
      costKnown: quoted !== null
    });
    const bytes = await readBoundedMediaBody(response);
    const mimeType = mediaMimeType(
      bytes,
      response.headers.get('content-type') ?? 'audio/mpeg',
      'audio',
      input.outputFormat === 'pcm'
    );
    const expectedMime: Record<string, string> = {
      mp3: 'audio/mpeg',
      pcm: 'audio/pcm',
      wav: 'audio/wav',
      opus: 'audio/ogg',
      flac: 'audio/flac',
      aac: 'audio/aac'
    };
    if (mimeType !== expectedMime[input.outputFormat ?? 'mp3'])
      throw new Error('The provider did not return the requested audio format');

    return {
      outputs: [{ filename: `${input.id}.${input.outputFormat ?? 'mp3'}`, bytes, mimeType }],
      costFromProvider: false,
      ...(response.headers.get('x-generation-id')
        ? { providerGenerationId: response.headers.get('x-generation-id')! }
        : {}),
      costKnown: quoted !== null,
      costUsd: quoted ?? 0
    };
  }
}
