import type {
  MediaCapabilities,
  MediaModelOption,
  MediaParameter,
  MediaPriceLine
} from '@garden/contracts';
import { readBoundedMediaBody } from './media-output.js';
import { mediaRecord } from './media-capabilities.js';
import type { MediaCatalogOptions } from './media-catalog.js';

export const OPENAI_VIDEO_RETIREMENT_AT = '2026-09-24T00:00:00.000Z';

const choices = (...values: string[]): MediaParameter => ({ type: 'enum', values });
const range = (min: number, max: number): MediaParameter => ({ type: 'range', min, max });
export const isNativeOpenAIEndpoint = (baseUrl: string): boolean => {
  try {
    const url = new URL(baseUrl);
    return (
      url.origin === 'https://api.openai.com' &&
      /^\/v1\/?$/.test(url.pathname) &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};

/** Account discovery supplies availability; documented model families supply endpoint controls. */
export const refreshOpenAIMediaCatalog = async (
  options: MediaCatalogOptions
): Promise<MediaModelOption[]> => {
  if (!isNativeOpenAIEndpoint(options.baseUrl))
    throw new Error('Native media discovery requires the official OpenAI API endpoint');
  const response = await (options.fetch ?? globalThis.fetch)(
    `${options.baseUrl.replace(/\/$/, '')}/models`,
    {
      headers: { authorization: `Bearer ${options.apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    }
  );
  if (!response.ok) throw new Error(`The native model catalogue returned ${response.status}`);
  const body: unknown = JSON.parse(
    (await readBoundedMediaBody(response, 16 * 1024 * 1024)).toString('utf8')
  );
  if (!mediaRecord(body) || !Array.isArray(body.data))
    throw new Error('The native model catalogue is invalid');
  const ids = [
    ...new Set(
      body.data
        .filter(mediaRecord)
        .map((row) => row.id)
        .filter(
          (id): id is string =>
            typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id)
        )
    )
  ];
  const updatedAt = (options.now ?? new Date()).toISOString();
  return ids.flatMap((id): MediaModelOption[] => {
    let modality: MediaModelOption['modality'];
    let parameters: MediaCapabilities['parameters'];
    let pricing: MediaPriceLine[] = [];
    let defaultVoice: string | null = null;
    let usdPerMillionCharacters: number | null = null;
    let usdPerMinute: number | null = null;
    if (/^gpt-image-(?:2|1\.5|1-mini|1)(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
      modality = 'image';
      const rates = id.startsWith('gpt-image-2')
        ? [5, 8, 30]
        : id.startsWith('gpt-image-1.5')
          ? [5, 8, 32]
          : id.startsWith('gpt-image-1-mini')
            ? [2, 2.5, 8]
            : [5, 10, 40];
      pricing = ['input_text', 'input_image', 'output_image'].map((billable, index) => ({
        billable,
        unit: 'token',
        costUsd: rates[index]! / 1_000_000
      }));
      parameters = {
        quality: choices('auto', 'low', 'medium', 'high'),
        output_format: choices('png', 'jpeg', 'webp'),
        background: choices('auto', 'opaque', 'transparent'),
        n: range(1, 10),
        input_references: range(0, 10),
        output_compression: range(0, 100),
        mask: { type: 'boolean' },
        moderation: choices('auto', 'low')
      };
      if (!id.startsWith('gpt-image-2'))
        parameters.size = choices('1024x1024', '1536x1024', '1024x1536');
    } else if (/^(?:tts-1(?:-hd)?(?:-\d{4})?|gpt-4o-mini-tts(?:-\d{4}-\d{2}-\d{2})?)$/.test(id)) {
      modality = 'audio';
      defaultVoice = id.startsWith('gpt-4o-mini') ? 'marin' : 'alloy';
      const voices = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];
      if (id.startsWith('gpt-4o-mini')) voices.push('ballad', 'verse', 'marin', 'cedar');
      parameters = {
        voice: choices(...voices),
        speed: range(0.25, 4),
        output_format: choices('mp3', 'opus', 'aac', 'flac', 'wav', 'pcm')
      };
      if (id.startsWith('gpt-4o-mini')) parameters.instructions = { type: 'boolean' };
      else {
        usdPerMillionCharacters = id.startsWith('tts-1-hd') ? 30 : 15;
        pricing = [
          {
            billable: 'input_text',
            unit: 'character',
            costUsd: usdPerMillionCharacters / 1_000_000
          }
        ];
      }
    } else if (
      /^(?:whisper-1|gpt-transcribe|gpt-4o(?:-mini)?-transcribe(?:-diarize)?(?:-\d{4}-\d{2}-\d{2})?)$/.test(
        id
      )
    ) {
      modality = 'transcription';
      parameters = {
        response_format: id.includes('diarize')
          ? choices('json', 'diarized_json')
          : id === 'whisper-1'
            ? choices('json', 'verbose_json')
            : choices('json')
      };
      if (id === 'whisper-1' || id === 'gpt-transcribe') {
        usdPerMinute = id === 'gpt-transcribe' ? 0.0045 : 0.006;
        pricing = [{ billable: 'input_audio', unit: 'minute', costUsd: usdPerMinute }];
      } else {
        const mini = id.startsWith('gpt-4o-mini');
        pricing = [
          { billable: 'input_tokens', unit: 'token', costUsd: (mini ? 1.25 : 2.5) / 1_000_000 },
          { billable: 'output_tokens', unit: 'token', costUsd: (mini ? 5 : 10) / 1_000_000 }
        ];
      }
      parameters.language = { type: 'boolean' };
      if (!id.includes('diarize')) parameters.prompt = { type: 'boolean' };
      if (id === 'gpt-transcribe') {
        parameters.languages = { type: 'range', min: 0, max: 20 };
        parameters.keywords = { type: 'range', min: 0, max: 100 };
      }
    } else if (/^sora-2(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
      modality = 'video';
      const pro = id.startsWith('sora-2-pro');
      const sizes = [
        '1280x720',
        '720x1280',
        ...(pro ? ['1792x1024', '1024x1792', '1920x1080', '1080x1920'] : [])
      ];
      parameters = { duration: choices('4', '8', '12', '16', '20'), size: choices(...sizes) };
      pricing = sizes.map((size) => ({
        billable: 'output_video',
        unit: 'second',
        variant: size,
        costUsd: !pro ? 0.1 : size.includes('1080') ? 0.7 : size.includes('1024') ? 0.5 : 0.3
      }));
    } else return [];
    return [
      {
        id: `openai/${id}`,
        providerModelId: id,
        displayName: id,
        provider: 'openai',
        modality,
        apiProtocol: 'openai',
        usdPerImage: null,
        usdPerMillionCharacters,
        usdPerMinute,
        priceSource: pricing.length ? 'provider' : 'unknown',
        pricing,
        defaultVoice,
        capabilities: { parameters, supportsStreaming: false },
        metadataVerifiedAt: updatedAt,
        updatedAt,
        zeroDataRetentionAvailable: modality !== 'video',
        ...(modality === 'video'
          ? {
              requiresRetentionApproval: true,
              retirementAt: OPENAI_VIDEO_RETIREMENT_AT,
              ...(Date.now() >= Date.parse(OPENAI_VIDEO_RETIREMENT_AT)
                ? {
                    unavailableReason:
                      'The provider has retired this native video API. Existing receipts remain available for recovery.'
                  }
                : {})
            }
          : {}),
        recommendationTags: [
          pricing.length ? 'Published provider pricing' : 'Token-priced; exact request cost varies',
          ...(options.requireZeroDataRetention && modality !== 'video'
            ? ['Requires account-level zero data retention']
            : [])
        ]
      }
    ];
  });
};
