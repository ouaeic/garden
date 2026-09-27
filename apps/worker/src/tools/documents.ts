import { runtimeUUID } from '@athanor/core';
import { randomInt } from 'node:crypto';
import { AthanorError } from '@athanor/core';
import {
  MediaClient,
  MediaProviderRejectionError,
  type ModelToolCall
} from '@athanor/model-gateway';
import { type ExecObservation } from '../agent-state.js';
import { requireMediaGenerationApproval } from '../media-approval.js';
import { currentRunnerAbortSignal } from '../runner-client.js';
import { spendHalt } from '../turn-bounds.js';
import { textValue } from '../values.js';
import {
  mediaDimension,
  mediaImageDimensions,
  mediaQuoteUsd,
  resolvedMediaModel
} from '../media.js';
import { type ToolContext } from '../tool-dispatch.js';
import { clampNumber } from './numbers.js';
import { GenerationControls, mediaArguments, describeMediaControls } from '../media-controls.js';
import { prepareMediaReferences, queueVideoGeneration } from '../media-generation.js';
import { executeMediaLibrary } from '../media-library.js';
import { queueVideoBatch } from '../media-batches.js';
import { transcribeRecording } from '../audio-reading.js';
import { stageNativeInput } from '../native-input.js';

/**
 * The document tools: reading what the owner has stored, and making new media from it.
 *
 * `generate_media` and `audio_read` sit beside the readers because they are billed the same way -
 * they are the two arms in this file that put a line on the owner's provider bill, and both write
 * their own ledger row rather than leaving it to the turn.
 */
export async function executeDocumentTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task } = context;
  const root = `/v1/workspaces/${task.workspaceId}`;
  switch (call.name) {
    case 'document_read': {
      const path = textValue(call.arguments.path);
      const startPage = clampNumber(call.arguments.startPage, { min: 1, max: 10_000, fallback: 1 });
      const endPage = clampNumber(call.arguments.endPage, {
        min: startPage,
        max: 10_000,
        fallback: startPage + 19
      });
      const maxCharacters = clampNumber(call.arguments.maxCharacters, {
        min: 1_000,
        max: 200_000,
        fallback: 80_000
      });
      const result = await context.runner.call<ExecObservation>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/documents`,
        { action: 'read', path, startPage, endPage, maxCharacters }
      );
      if (result.exitCode !== 0)
        throw new AthanorError(
          'document_read_failed',
          result.stderr || 'Document extraction failed'
        );
      return JSON.parse(result.stdout) as unknown;
    }
    case 'audio_read':
      if (
        call.arguments.options &&
        typeof call.arguments.options === 'object' &&
        'action' in call.arguments.options
      )
        return stageNativeInput(context, call);
      return transcribeRecording(context, call);
    case 'document_search': {
      const query = textValue(call.arguments.query).trim();
      if (!query) throw new AthanorError('document_query_empty', 'Document search needs a query');
      const rawAlternatives =
        call.arguments.alternatives === undefined ? [] : call.arguments.alternatives;
      if (
        !Array.isArray(rawAlternatives) ||
        rawAlternatives.length > 4 ||
        rawAlternatives.some(
          (value) => typeof value !== 'string' || !value.trim() || value.length > 500
        )
      )
        throw new AthanorError(
          'document_alternatives_invalid',
          'Document search accepts up to four nonempty alternatives of 500 characters each'
        );
      const alternatives = [
        ...new Set(rawAlternatives.map((value: string) => value.trim()))
      ].filter((value) => value !== query);
      const path = textValue(call.arguments.path, 'workspace');
      const maxFiles = clampNumber(call.arguments.maxFiles, { min: 1, max: 2_000, fallback: 500 });
      const fileOffset = clampNumber(call.arguments.fileOffset, {
        min: 0,
        max: 1_000_000,
        fallback: 0
      });
      const maxResults = clampNumber(call.arguments.maxResults, { min: 1, max: 50, fallback: 12 });
      const maxPages = clampNumber(call.arguments.maxPages, { min: 1, max: 10_000, fallback: 500 });
      const result = await context.runner.call<ExecObservation>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/documents`,
        { action: 'search', path, query, alternatives, maxFiles, fileOffset, maxResults, maxPages }
      );
      if (result.exitCode !== 0)
        throw new AthanorError('document_search_failed', result.stderr || 'Document search failed');
      return JSON.parse(result.stdout) as unknown;
    }
    case 'generate_media': {
      // Resolved first because it is the same lookup the old assertion made, and asking for it
      // up front means an unconfigured provider is reported as one rather than as a spend refusal.
      const args = mediaArguments(call.arguments);
      const secret = await context.inferenceCredential(
        task,
        !['status', 'library'].includes(textValue(args.action))
      );
      if (
        args.action !== undefined &&
        (typeof args.action !== 'string' ||
          !['describe', 'status', 'generate', 'library', 'batch'].includes(args.action))
      )
        throw new AthanorError(
          'media_action_invalid',
          'Choose generate, describe, status or library',
          400
        );
      const kind = textValue(args.kind);
      if (args.action === 'library') return executeMediaLibrary(context, call, secret);
      if (args.action === 'batch') return queueVideoBatch(context, call, secret);
      if (args.action === 'describe')
        return {
          routes: secret.mediaRoutes ?? {},
          controls: describeMediaControls()
        };
      if (args.action === 'status') {
        const job = await context.store.getMediaJob(task.userId, textValue(args.jobId));
        if (!job || job.taskId !== task.id)
          throw new AthanorError('media_job_not_found', 'Video job not found', 404);
        return {
          mediaJobId: job.id,
          operation: job.operation,
          durationSeconds: job.durationSeconds,
          extensionCount: job.extensionCount,
          sourceJobId: job.sourceJobId,
          status: job.status,
          progress: job.progress,
          path: job.status === 'completed' ? job.outputPath : null,
          artifactId: job.artifactId,
          costUsd: job.costUsd
        };
      }
      if (kind === 'video') {
        requireMediaGenerationApproval(context.key, task, context.state, call, secret);
        return queueVideoGeneration(context, call, secret);
      }
      if (kind !== 'image' && kind !== 'audio')
        throw new AthanorError('media_kind_invalid', 'Choose image or audio');
      const media = resolvedMediaModel(kind, secret.mediaRoutes);
      const controls = GenerationControls.parse(args);
      const voice = controls.voice ?? media.voice;
      const references = await prepareMediaReferences(context, controls.inputReferences ?? []);
      if (!media.route || media.route.unavailableReason)
        throw new AthanorError(
          'media_route_unavailable',
          'Choose an available route for this modality in Settings',
          409
        );
      requireMediaGenerationApproval(context.key, task, context.state, call, secret);
      const preparedMask = controls.mask
        ? (await prepareMediaReferences(context, [controls.mask]))[0]
        : undefined;
      const modelId = media.modelId;
      const prompt = textValue(args.prompt).trim();
      if (!prompt) throw new AthanorError('media_prompt_empty', 'A media prompt is required');
      const { width, height } =
        kind === 'image'
          ? mediaImageDimensions({
              kind,
              width: args.width,
              height: args.height,
              resolution: controls.resolution,
              model: media
            })
          : { width: mediaDimension(args.width), height: mediaDimension(args.height) };
      const quotedUsd = mediaQuoteUsd({
        kind,
        width,
        height,
        characterCount: prompt.length,
        count: controls.count,
        quality: controls.quality,
        resolution: controls.resolution,
        inputReferenceCount: references.length,
        model: media
      });
      const explicitLimit =
        typeof args.maxCostUsd === 'number' &&
        Number.isFinite(args.maxCostUsd) &&
        args.maxCostUsd > 0 &&
        args.maxCostUsd <= 10_000
          ? args.maxCostUsd
          : null;
      if (quotedUsd === null && explicitLimit === null)
        throw new AthanorError(
          'media_reservation_required',
          'This route has no complete request price. Include options.maxCostUsd in the approval.',
          400
        );
      const estimateUsd = quotedUsd ?? explicitLimit!;
      if (explicitLimit !== null && estimateUsd > explicitLimit)
        throw new AthanorError(
          'media_reservation_exceeded',
          'The media quote exceeds the selected spending reservation',
          402
        );
      const generation = runtimeUUID();
      // Where it will be written, decided before a penny is spent. The runner accepts writes only
      // under `workspace/` (and the artifact store), so a model that answers this parameter with
      // `logo.png` or `generated/logo.png` - which the schema's wording invites - would have had
      // its file refused after the provider had already billed for it. Resolving the destination
      // first turns that into a free refusal, and a bare name into the obvious thing.
      //
      // `assertUserDataPath` reads a bare name the same way, so this predicts the runner rather
      // than departing from it. It stays because prediction is the point: the check has to happen
      // on this side of the provider's invoice, not at the write.
      const extension = controls.outputFormat ?? (kind === 'image' ? 'png' : 'mp3');
      const requested = textValue(args.path).trim().replace(/^\.\//, '');
      if (requested.split('/').includes('..'))
        throw new AthanorError(
          'media_path_invalid',
          'A generated file goes in the workspace; the path may not climb out of it'
        );
      const base = !requested
        ? `workspace/generated/${generation}.${extension}`
        : requested.startsWith('workspace/') || requested.startsWith('.athanor/')
          ? requested
          : `workspace/${requested}`;
      const decision = await context.store.spendGuard({
        userId: task.userId,
        taskId: task.id,
        estimateUsd,
        includeOpenCommitments: true
      });
      if (decision.outcome === 'deny')
        throw new AthanorError(
          'spend_cap_reached',
          `${spendHalt(decision)} Nothing was generated and nothing was charged; say so and carry on with the work that costs nothing.`
        );
      const usage = {
        userId: task.userId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        kind: 'model_inference',
        resourceClass: `media:${kind}`,
        quantity: 1,
        unit: 'generation',
        credits: 0,
        idempotencyKey: `media:${task.id}:${call.id}`,
        providerRef: `${secret.provider}:${modelId}`
      };
      let reserved = false;
      let settled = false;
      const seed = Number.isSafeInteger(args.seed) ? Number(args.seed) : randomInt(0, 2 ** 31 - 1);
      const generated = await new MediaClient({
        baseUrl: secret.baseUrl,
        ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
        appUrl: context.config.PUBLIC_APP_URL,
        openRouter: secret.provider === 'openrouter'
      })
        .generate({
          id: generation,
          ...(currentRunnerAbortSignal() ? { signal: currentRunnerAbortSignal()! } : {}),
          kind,
          model: modelId,
          prompt,
          width,
          height,
          seed,
          ...Object.fromEntries(
            Object.entries(controls).filter(
              ([name]) => name !== 'inputReferences' && name !== 'mask'
            )
          ),
          ...(references.length ? { inputReferences: references } : {}),
          ...(preparedMask ? { mask: preparedMask } : {}),
          ...(media.route?.pricing ? { pricing: media.route.pricing } : {}),
          ...(media.route?.capabilities ? { capabilities: media.route.capabilities } : {}),
          ...(media.route?.providerEndpointTag
            ? { providerEndpointTag: media.route.providerEndpointTag }
            : {}),
          // Only when the resolved route names one: a voice belongs to a specific speech model's
          // own list, and sending one model's voice name to another is a request the provider
          // has no way to honour.
          ...(voice ? { voice } : {}),
          onBeforeSubmit: async () => {
            currentRunnerAbortSignal()?.throwIfAborted();
            const latest = await context.inferenceCredential(task, true);
            requireMediaGenerationApproval(context.key, task, context.state, call, latest);
            const claim = await context.store.taskClaim(task.id);
            if (claim?.status !== 'running' || claim.leaseOwner !== context.config.WORKER_ID)
              throw new AthanorError(
                'media_task_changed',
                'This worker no longer owns the media request',
                409
              );
            currentRunnerAbortSignal()?.throwIfAborted();
            await context.store.recordUsage({
              ...usage,
              costUsd: estimateUsd,
              state: 'reserved',
              reserveAgainstCaps: true
            });
            reserved = true;
            currentRunnerAbortSignal()?.throwIfAborted();
          },
          onUsage: async (receipt) => {
            if (receipt.costKnown && !settled) {
              await context.store.recordUsage({
                ...usage,
                costUsd: receipt.costUsd,
                state: 'settled',
                settleReservation: true
              });
              settled = true;
            }
          },
          usdPerImage: media.usdPerImage,
          usdPerMillionCharacters: media.usdPerMillionCharacters
        })
        .catch(async (error: unknown) => {
          if (!reserved && error instanceof AthanorError) throw error;
          if (reserved && !settled && error instanceof MediaProviderRejectionError)
            await context.store.recordUsage({
              ...usage,
              costUsd: 0,
              state: 'released',
              settleReservation: true
            });
          throw new AthanorError(
            'media_generation_failed',
            error instanceof Error ? error.message : 'Media generation failed'
          );
        });

      // One output is the ordinary case, so the resolved path is used as it stands; a provider
      // that returned several gets them numbered beside it rather than overwriting itself.
      const written = generated.outputs.map((output, index) => ({
        path: (index === 0 ? base : base.replace(/(\.[^./]+)?$/, `-${index + 1}$1`)).replace(
          /\.[^./]+$/,
          `.${output.filename.split('.').at(-1)}`
        ),
        bytes: output.bytes
      }));
      for (const output of written)
        await context.runner.writeBytes(task.workspaceId, task.id, output.path, output.bytes);
      const paths = written.map((output) => output.path);
      const storageUsage = await context.runner.call<{ storageBytes: number }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/usage`
      );
      await context.store.setWorkspaceStorage(
        task.userId,
        task.workspaceId,
        storageUsage.storageBytes
      );
      return {
        kind,
        modelId,
        paths,
        costUsd: generated.costKnown === false ? null : generated.costUsd,
        costSource: generated.costFromProvider
          ? 'provider'
          : generated.costKnown
            ? 'quote'
            : 'unresolved',
        billedBy: 'connected provider',
        instruction:
          kind === 'image'
            ? 'The file exists now. Look at it with image_read before publishing it.'
            : 'The file exists now.'
      };
    }
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
