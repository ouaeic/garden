import { runtimeUUID } from '@athanor/core';

import { AthanorError, decryptJson, encryptJson, sha256 } from '@athanor/core';
import {
  NativeMediaLibraryClient,
  NativeMediaProviderRejectionError
} from '@athanor/model-gateway';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { InferenceCredential } from './agent-state.js';
import type { ToolContext } from './tool-dispatch.js';
import { LibraryControls, mediaArguments } from './media-controls.js';
export const mediaAssetAad = (id: string) => `provider-media-asset:${id}`;
export const mediaAccountHash = (secret: Pick<InferenceCredential, 'baseUrl' | 'apiKey'>): string =>
  sha256(`${secret.baseUrl.replace(/\/$/, '')}\0${secret.apiKey ?? ''}`);
export interface StoredCharacter {
  id: string;
  name: string;
}
export const executeMediaLibrary = async (
  context: ToolContext,
  call: ModelToolCall,
  secret: InferenceCredential
): Promise<unknown> => {
  const input = LibraryControls.parse(mediaArguments(call.arguments));
  if (!secret.apiKey || secret.mediaRoutes?.video?.apiProtocol !== 'openai')
    throw new AthanorError(
      'media_library_unavailable',
      'Choose a native OpenAI video route before opening its library',
      409
    );
  const writing =
    input.operation === 'delete_video' ||
    input.operation === 'create_character' ||
    input.operation === 'cancel_batch';
  if (writing && !context.consequentialApproved)
    throw new AthanorError(
      'media_library_approval_required',
      'Approve this retained provider asset operation first',
      409
    );
  const client = new NativeMediaLibraryClient({
    baseUrl: secret.baseUrl,
    apiKey: secret.apiKey,
    privacyRoute: writing || context.task.privacyRoute === 'external' ? 'external' : 'provider_zdr'
  });
  const providerHash = mediaAccountHash(secret);
  if (input.operation === 'cancel_batch') {
    const batch = await context.store.getMediaBatch(context.task.userId, input.batchId);
    if (!batch || batch.workspaceId !== context.task.workspaceId)
      throw new AthanorError('media_batch_not_found', 'Batch not found in this workspace', 404);
    const saved = await context.store.requestMediaBatchCancel(context.task.userId, batch.id);
    if (!saved)
      throw new AthanorError(
        'media_batch_not_cancellable',
        'Reconcile an uncertain submission before cancelling; delivered batches are already terminal',
        409
      );
    return {
      mediaBatchId: saved.id,
      status: saved.status,
      cancelRequested: true,
      instruction:
        'Cancellation is requested. It can take up to ten minutes at the provider; completed work is still billed and delivered.'
    };
  }
  if (input.operation === 'list_videos')
    return client.listVideos({
      ...(input.after ? { after: input.after } : {}),
      ...(input.limit ? { limit: input.limit } : {})
    });
  if (input.operation === 'delete_video') return client.deleteVideo(input.providerVideoId);
  if (input.operation === 'list_characters') {
    const assets = await context.store.listMediaAssets(
      context.task.userId,
      context.task.workspaceId,
      providerHash
    );
    return {
      characters: assets.map((asset) => {
        const request = decryptJson<{ name: string }>(
          asset.requestCiphertext,
          context.key,
          mediaAssetAad(asset.id)
        );
        return {
          assetId: asset.id,
          name: request.name,
          status: asset.status,
          costUsd: null,
          reservationUsd: asset.reservationUsd
        };
      })
    };
  }
  const path = input.referencePath;
  if (/^[a-z]+:/i.test(path) || path.startsWith('/') || path.split('/').includes('..'))
    throw new AthanorError(
      'media_asset_path_invalid',
      'Choose an MP4 character reference inside this workspace',
      400
    );
  const file = await context.runner.readBytes(
    context.task.workspaceId,
    context.task.id,
    path,
    64 * 1024 * 1024
  );
  if (file.bytes.length < 12 || file.bytes.toString('ascii', 4, 8) !== 'ftyp')
    throw new AthanorError(
      'media_asset_format_invalid',
      'Choose a valid MP4 character reference',
      400
    );
  const id = runtimeUUID();
  await context.store.createMediaAsset({
    id,
    userId: context.task.userId,
    workspaceId: context.task.workspaceId,
    taskId: context.task.id,
    providerHash,
    requestKey: `character:${context.task.id}:${call.id}`,
    requestHash: sha256(JSON.stringify(call.arguments)),
    requestCiphertext: encryptJson(
      {
        name: input.name,
        path,
        sha256: sha256(file.bytes),
        provider: { baseUrl: secret.baseUrl, apiKey: secret.apiKey }
      },
      context.key,
      mediaAssetAad(id)
    ),
    reservationUsd: input.maxCostUsd,
    retentionApproved: true
  });
  try {
    const character = await client.createCharacter({ name: input.name, bytes: file.bytes });
    const saved = await context.store.finishMediaAsset({
      id,
      userId: context.task.userId,
      status: 'completed',
      resultCiphertext: encryptJson(character, context.key, mediaAssetAad(id))
    });
    if (!saved) throw new Error('The asset receipt could not be persisted');
    return {
      assetId: id,
      name: character.name,
      status: 'completed',
      costUsd: null,
      reservationUsd: input.maxCostUsd,
      instruction:
        'Use this garden asset ID in options.characterAssetIds and mention its name verbatim in the video prompt. The provider publishes no separate upload price; its spending reservation remains until billing is reconciled.'
    };
  } catch (error) {
    const refused = error instanceof NativeMediaProviderRejectionError;
    await context.store.finishMediaAsset({
      id,
      userId: context.task.userId,
      status: refused ? 'failed' : 'submission_uncertain',
      refused,
      resultCiphertext: encryptJson(
        {
          message:
            error instanceof Error ? error.message : 'The character submission needs reconciliation'
        },
        context.key,
        mediaAssetAad(id)
      )
    });
    throw new AthanorError(
      refused ? 'media_asset_refused' : 'media_asset_submission_uncertain',
      refused
        ? 'The provider refused the character upload. Its reservation was released.'
        : `The provider may have accepted character asset ${id}. Reconcile it before uploading again.`,
      409
    );
  }
};
