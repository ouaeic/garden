import { z } from 'zod';
import { GardenError } from '@garden/core';

export const TranscriptionControls = z
  .object({
    privacyRoute: z
      .enum(['provider_zdr', 'external'])
      .describe(
        'External handling requires approval for this reading only; task and credential privacy remain unchanged.'
      )
      .optional(),
    maxCostUsd: z.number().positive().max(10_000).optional(),
    language: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
    prompt: z.string().max(10_000).optional(),
    responseFormat: z.enum(['json', 'verbose_json', 'diarized_json']).optional(),
    keywords: z.array(z.string().min(1).max(200)).max(100).optional(),
    languages: z
      .array(z.string().regex(/^[a-z]{2}$/))
      .max(20)
      .optional()
  })
  .strict();
export const GenerationControls = z.object({
  instructions: z.string().max(10_000).optional(),
  outputCompression: z.number().int().min(0).max(100).optional(),
  mask: z.string().min(1).max(1000).optional(),
  moderation: z.enum(['auto', 'low']).optional(),
  outputFormat: z
    .enum(['png', 'jpeg', 'webp', 'mp3', 'pcm', 'opus', 'aac', 'flac', 'wav'])
    .optional(),
  count: z.number().int().min(1).max(10).optional(),
  quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
  aspectRatio: z
    .string()
    .regex(/^\d{1,3}:\d{1,3}$/)
    .optional(),
  resolution: z.string().max(32).optional(),
  background: z.enum(['auto', 'opaque', 'transparent']).optional(),
  voice: z.string().min(1).max(200).optional(),
  speed: z.number().min(0.25).max(4).optional(),
  inputReferences: z.array(z.string().min(1).max(1000)).max(10).optional()
});
export const VideoToolInput = z.object({
  operation: z.enum(['generate', 'edit', 'extend']).optional(),
  sourceJobId: z.string().uuid().optional(),
  characterAssetIds: z.array(z.string().uuid()).max(2).optional(),
  modelId: z.string().min(1).max(300),
  prompt: z.string().trim().min(1).max(100_000),
  duration: z.number().int().min(1).max(120),
  resolution: z.string().max(32).optional(),
  aspectRatio: z
    .string()
    .regex(/^\d{1,3}:\d{1,3}$/)
    .optional(),
  size: z
    .string()
    .regex(/^\d{2,4}x\d{2,4}$/)
    .optional(),
  generateAudio: z.boolean().optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
  frameImages: z
    .array(
      z.object({
        path: z.string().min(1).max(1000),
        frameType: z.enum(['first_frame', 'last_frame'])
      })
    )
    .max(2)
    .optional(),
  inputReferences: z.array(z.string().min(1).max(1000)).max(10).optional(),
  maxCostUsd: z.number().positive().max(10_000).optional(),
  path: z.string().max(1000).optional()
});

export const LibraryControls = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('cancel_batch'), batchId: z.string().uuid() }),
  z.object({
    operation: z.literal('list_videos'),
    after: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,256}$/)
      .optional(),
    limit: z.number().int().min(1).max(100).optional()
  }),
  z.object({
    operation: z.literal('delete_video'),
    providerVideoId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
  }),
  z.object({ operation: z.literal('list_characters') }),
  z.object({
    operation: z.literal('create_character'),
    referencePath: z.string().min(1).max(1000),
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => ![...value].some((character) => character.charCodeAt(0) < 32)),
    maxCostUsd: z.number().positive().max(10_000)
  })
]);

const MediaOptions = GenerationControls.extend(
  VideoToolInput.omit({ prompt: true, path: true }).partial().shape
).strict();
export const VideoBatchControls = z
  .object({
    modelId: z.string().min(1).max(300),
    shots: z
      .array(VideoToolInput.omit({ modelId: true, operation: true, sourceJobId: true }))
      .min(1)
      .max(100),
    maxCostUsd: z.number().positive().max(10_000).optional()
  })
  .strict();
/** Options are validated before both the approval quote and provider dispatch. */
export const mediaArguments = (args: Record<string, unknown>): Record<string, unknown> => {
  if (args.options === undefined) return args;
  const options =
    args.action === 'library'
      ? LibraryControls.parse(args.options)
      : args.action === 'batch'
        ? VideoBatchControls.parse(args.options)
        : MediaOptions.parse(args.options);
  for (const key of Object.keys(options))
    if (
      args[key] !== undefined &&
      JSON.stringify(args[key]) !== JSON.stringify((options as Record<string, unknown>)[key])
    )
      throw new GardenError('media_options_conflict', `Choose one value for ${key}`, 400);
  const { options: _options, ...top } = args;
  return { ...top, ...options };
};
export const describeMediaControls = () => ({
  options: z.toJSONSchema(MediaOptions),
  transcription: z.toJSONSchema(TranscriptionControls),
  library: z.toJSONSchema(LibraryControls),
  batch: z.toJSONSchema(VideoBatchControls),
  providerParameterNames: {
    outputFormat: 'output_format',
    count: 'n',
    aspectRatio: 'aspect_ratio',
    inputReferences: 'input_references',
    generateAudio: 'generate_audio',
    frameImages: 'frame_images'
  },
  instruction:
    'Put advanced controls in options. Use only settings supported by the selected route. Omit image width/height to use its imageDimensions defaults. Video requires options.modelId and options.duration. Native edit/extend also require options.sourceJobId and the unchanged source size; edit uses the full source duration, extend uses the added seconds. Unknown pricing requires options.maxCostUsd. Reference paths must be inside this workspace.'
});
