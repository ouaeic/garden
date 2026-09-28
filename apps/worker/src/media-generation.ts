import { runtimeUUID } from '@garden/core';

import { GardenError, decryptJson, encryptJson, sha256 } from '@garden/core';
import type { ModelToolCall, VideoGenerationRequest } from '@garden/model-gateway';
import { VideoClient } from '@garden/model-gateway';
import type { InferenceCredential } from './agent-state.js';
import { VideoToolInput, mediaArguments } from './media-controls.js';
import { mediaQuoteUsd, resolvedMediaModel } from './media.js';
import { mediaJobAad, type StoredVideoRequest } from './media-job-domain.js';
import type { ToolContext } from './tool-dispatch.js';
import { mediaAccountHash, mediaAssetAad, type StoredCharacter } from './media-library.js';

export const prepareMediaReferences = async (
  context: ToolContext,
  paths: string[]
): Promise<string[]> => {
  const prepared: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    if (/^[a-z]+:/i.test(path) || path.startsWith('/') || path.split('/').includes('..'))
      throw new GardenError(
        'media_reference_invalid',
        'Choose image references inside this workspace',
        400
      );
    const image = await context.runner.readImage(context.task.workspaceId, context.task.id, path);
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) ||
      image.base64.length > Math.ceil((16 * 1024 * 1024) / 3) * 4
    )
      throw new GardenError(
        'media_reference_invalid',
        'Choose a bounded PNG, JPEG or WebP reference',
        400
      );
    bytes += Buffer.byteLength(image.base64, 'base64');
    if (bytes > 64 * 1024 * 1024)
      throw new GardenError(
        'media_reference_invalid',
        'The references exceed the total byte limit',
        400
      );
    prepared.push(`data:${image.mimeType};base64,${image.base64}`);
  }
  return prepared;
};
export const prepareVideoGeneration = async (
  context: ToolContext,
  call: ModelToolCall,
  secret: InferenceCredential
) => {
  if (!context.consequentialApproved)
    throw new GardenError(
      'media_retention_approval_required',
      'This video job needs its own approval for temporary provider retention',
      409
    );
  const input = VideoToolInput.parse(mediaArguments(call.arguments));
  const media = resolvedMediaModel('video', secret.mediaRoutes),
    route = media.route;
  if (!route || route.modality !== 'video' || !route.providerModelId || route.unavailableReason)
    throw new GardenError(
      'media_route_unavailable',
      'Choose a video model in Settings before generating a clip',
      409
    );
  if (input.modelId !== route.id && input.modelId !== route.providerModelId)
    throw new GardenError(
      'media_route_changed',
      'The selected video model changed. Describe the route and request approval again.',
      409
    );
  if (!secret.apiKey)
    throw new GardenError(
      'provider_setup_required',
      'Connect a provider credential before generating a clip',
      409
    );
  const operation = input.operation ?? 'generate';
  let sourceProviderId: string | undefined;
  let durationSeconds = input.duration;
  let extensionCount = 0;
  if (operation !== 'generate') {
    if (!input.sourceJobId || route.apiProtocol !== 'openai')
      throw new GardenError(
        'media_source_invalid',
        'Choose a completed native video as the source',
        400
      );
    const source = await context.store.getMediaJob(context.task.userId, input.sourceJobId);
    if (
      !source ||
      source.workspaceId !== context.task.workspaceId ||
      source.status !== 'completed' ||
      !source.providerJobId ||
      !source.durationSeconds
    )
      throw new GardenError(
        'media_source_invalid',
        'Choose a completed video in this workspace',
        409
      );
    const original = decryptJson<StoredVideoRequest>(
      source.requestCiphertext,
      context.key,
      mediaJobAad(source.id)
    );
    if (
      original.provider.apiProtocol !== 'openai' ||
      original.provider.baseUrl.replace(/\/$/, '') !== secret.baseUrl.replace(/\/$/, '') ||
      sha256(original.provider.apiKey) !== sha256(secret.apiKey) ||
      original.input.model !== route.providerModelId
    )
      throw new GardenError(
        'media_source_provider_changed',
        'Video edits and extensions must use the original provider account and model',
        409
      );
    if (
      input.size !== original.input.size ||
      input.resolution ||
      input.aspectRatio ||
      input.frameImages?.length ||
      input.inputReferences?.length ||
      input.generateAudio !== undefined ||
      input.seed !== undefined ||
      input.characterAssetIds?.length
    )
      throw new GardenError(
        'media_source_controls_invalid',
        'Keep the source size; edits and extensions accept only the source, prompt and duration',
        400
      );
    if (operation === 'edit' && input.duration !== source.durationSeconds)
      throw new GardenError(
        'media_source_duration_invalid',
        'An edit keeps the full source duration',
        400
      );
    durationSeconds =
      operation === 'extend' ? source.durationSeconds + input.duration : source.durationSeconds;
    extensionCount = source.extensionCount + (operation === 'extend' ? 1 : 0);
    if (
      input.duration > (operation === 'extend' ? 20 : 120) ||
      durationSeconds > 120 ||
      extensionCount > 6
    )
      throw new GardenError(
        'media_extension_limit',
        'A clip permits at most six extensions and one hundred twenty total seconds',
        400
      );
    sourceProviderId = source.providerJobId;
  } else if (input.sourceJobId)
    throw new GardenError(
      'media_source_invalid',
      'Use edit or extend when choosing a source video',
      400
    );
  const quoteUsd = mediaQuoteUsd({
    kind: 'video',
    duration: input.duration,
    resolution: input.resolution,
    size: input.size,
    inputReferenceCount: (input.inputReferences?.length ?? 0) + (input.frameImages?.length ?? 0),
    model: media
  });
  const reservationUsd = quoteUsd ?? input.maxCostUsd;
  if (reservationUsd === undefined || reservationUsd <= 0)
    throw new GardenError(
      'media_reservation_required',
      'This route needs a positive spending reservation shown in its approval',
      400
    );
  if (quoteUsd !== null && input.maxCostUsd !== undefined && quoteUsd > input.maxCostUsd)
    throw new GardenError(
      'media_reservation_exceeded',
      'The provider quote exceeds the requested video spending limit',
      402
    );
  const id = runtimeUUID();
  const named = input.path?.replace(/^\.\//, '') || `generated/${id}.mp4`;
  if (
    named.startsWith('/') ||
    /^[a-z]+:/i.test(named) ||
    named.split('/').includes('..') ||
    !named.endsWith('.mp4')
  )
    throw new GardenError(
      'media_path_invalid',
      'Choose an MP4 destination inside this workspace',
      400
    );
  const outputPath = named.startsWith('workspace/') ? named : `workspace/${named}`;
  const references = await prepareMediaReferences(context, input.inputReferences ?? []);
  const characters: Array<{ id: string }> = [];
  for (const assetId of input.characterAssetIds ?? []) {
    if (operation !== 'generate' || route.apiProtocol !== 'openai')
      throw new GardenError(
        'media_character_route_invalid',
        'Characters require a new native video generation',
        400
      );
    const asset = await context.store.getMediaAsset(context.task.userId, assetId);
    if (
      !asset ||
      asset.workspaceId !== context.task.workspaceId ||
      asset.providerHash !== mediaAccountHash(secret) ||
      asset.status !== 'completed' ||
      !asset.resultCiphertext
    )
      throw new GardenError(
        'media_character_unavailable',
        'Choose a completed character asset from this workspace and provider account',
        409
      );
    const character = decryptJson<StoredCharacter>(
      asset.resultCiphertext,
      context.key,
      mediaAssetAad(asset.id)
    );
    if (!input.prompt.includes(character.name))
      throw new GardenError(
        'media_character_name_missing',
        'Mention each selected character name verbatim in the video prompt',
        400
      );
    characters.push({ id: character.id });
  }
  const frames: NonNullable<VideoGenerationRequest['frameImages']> = [];
  for (const frame of input.frameImages ?? []) {
    const prepared = await prepareMediaReferences(context, [frame.path]);
    frames.push({ image: prepared[0]!, frameType: frame.frameType });
  }
  const request: StoredVideoRequest = {
    provider: {
      baseUrl: secret.baseUrl,
      apiKey: secret.apiKey,
      apiProtocol: route.apiProtocol ?? (secret.provider === 'openrouter' ? 'openrouter' : 'openai')
    },
    input: {
      operation,
      ...(sourceProviderId ? { sourceProviderId } : {}),
      model: route.providerModelId,
      prompt: input.prompt,
      duration: input.duration,
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.size ? { size: input.size } : {}),
      ...(input.seed === undefined ? {} : { seed: input.seed }),
      ...(input.generateAudio === undefined ? {} : { generateAudio: input.generateAudio }),
      ...(frames.length ? { frameImages: frames } : {}),
      ...(references.length ? { inputReferences: references } : {}),
      ...(characters.length ? { characters } : {}),
      ...(route.capabilities ? { capabilities: route.capabilities } : {}),
      ...(route.providerEndpointTag ? { providerEndpointTag: route.providerEndpointTag } : {})
    },
    quoteUsd
  };
  new VideoClient({ ...request.provider, privacyRoute: 'external' }).validate(request.input);
  const intent: Parameters<ToolContext['store']['createMediaJob']>[0] = {
    id,
    userId: context.task.userId,
    workspaceId: context.task.workspaceId,
    taskId: context.task.id,
    requestKey: `video:${context.task.id}:${call.id}`,
    requestHash: sha256(JSON.stringify(call.arguments)),
    requestCiphertext: encryptJson(request, context.key, mediaJobAad(id)),
    modelId: `${secret.provider}:${route.providerModelId}`,
    reservationUsd,
    operation,
    ...(input.sourceJobId ? { sourceJobId: input.sourceJobId } : {}),
    durationSeconds,
    extensionCount,
    privacyRoute: 'external',
    retentionApproved: true,
    outputPath
  };
  return { intent, request };
};

export const queueVideoGeneration = async (
  context: ToolContext,
  call: ModelToolCall,
  secret: InferenceCredential
) => {
  const { intent } = await prepareVideoGeneration(context, call, secret);
  const job = await context.store.createMediaJob(intent);
  return {
    kind: 'video',
    operation: job.operation,
    sourceJobId: job.sourceJobId,
    mediaJobId: job.id,
    status: job.status,
    path: job.outputPath,
    reservationUsd: job.reservationUsd,
    instruction:
      'The durable video job is queued. Garden will follow provider progress and deliver a downloadable artifact automatically. Continue other useful work; do not repeatedly poll or submit another generation.'
  };
};
