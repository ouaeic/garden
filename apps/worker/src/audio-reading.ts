import { AUDIO_READ_MAX_SECONDS } from '@garden/contracts';
import { GardenError } from '@garden/core';
import {
  MediaClient,
  isNativeOpenAIEndpoint,
  MediaProviderRejectionError,
  type ModelToolCall
} from '@garden/model-gateway';
import { type ToolContext } from './tool-dispatch.js';
import { TranscriptionControls } from './media-controls.js';
import {
  resolvedTranscriptionRoute,
  transcriptionEstimateUsd,
  transcriptionRate,
  transcriptionRateFromReading,
  transcriptionWindow
} from './media.js';
import {
  currentTranscriptionCredential,
  transcriptionPrivacy,
  requireTranscriptionApproval,
  transcriptionBinding
} from './transcription-approval.js';
import { currentRunnerAbortSignal } from './runner-client.js';
import { haltReason } from './turn-lifecycle.js';
import { textValue } from './values.js';
import { clampNumber, finiteNumber } from './tools/numbers.js';

export const transcribeRecording = async (
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> => {
  const { task, state } = context,
    secret = await currentTranscriptionCredential(await context.inferenceCredential(task, true));
  const controls = TranscriptionControls.parse(call.arguments.options ?? {});
  const path = textValue(call.arguments.path).trim();
  if (!path || path.split('/').includes('..'))
    throw new GardenError(
      'transcription_path_invalid',
      'Choose a recording inside this workspace',
      400
    );
  const startSeconds = clampNumber(call.arguments.startSeconds, {
    min: 0,
    max: 86_400,
    fallback: 0,
    integer: true
  });
  const endSeconds = finiteNumber(call.arguments.endSeconds);
  const maxCharacters = clampNumber(call.arguments.maxCharacters, {
    min: 1_000,
    max: 200_000,
    fallback: 40_000
  });
  const route = secret.mediaRoutes?.transcription,
    chosen = resolvedTranscriptionRoute(
      secret.mediaRoutes,
      secret.provider !== 'openrouter' && isNativeOpenAIEndpoint(secret.baseUrl)
    );
  const client = new MediaClient({
    baseUrl: secret.baseUrl,
    ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
    appUrl: context.config.PUBLIC_APP_URL,
    openRouter: secret.provider === 'openrouter'
  });
  const modelId = chosen?.modelId ?? '';
  if (!modelId || route?.unavailableReason)
    throw new GardenError(
      'transcription_route_unavailable',
      'Choose an available transcription model in Settings',
      503
    );
  const privacyRoute = transcriptionPrivacy(secret, call);
  if (privacyRoute === 'external' && !context.consequentialApproved)
    throw new GardenError(
      'transcription_approval_required',
      'Approve external handling for this exact recording before sending it',
      409
    );
  const rate = transcriptionRate(chosen);
  const bound = chosen?.transcriptionBound;
  if (transcriptionEstimateUsd(60, chosen) === null)
    throw new GardenError(
      'transcription_price_unbounded',
      'This route has no verified whole-request cost bound. Choose a supported priced transcription model in Settings.',
      400
    );
  if (rate.usdPerMinute === null && !context.consequentialApproved)
    throw new GardenError(
      'transcription_approval_required',
      'Approve the full model-bound transcription reservation before sending this recording',
      409
    );
  const proof = context.consequentialApproved
    ? requireTranscriptionApproval(context, call, secret)
    : undefined;
  const signal = currentRunnerAbortSignal();
  const assertActive = async () => {
    signal?.throwIfAborted();
    if (haltReason(await context.store.taskClaim(task.id), context.config.WORKER_ID))
      throw new GardenError(
        'transcription_task_inactive',
        'This task no longer has authority to send a recording',
        409
      );
    signal?.throwIfAborted();
  };
  const maxSeconds = bound?.maxSeconds ?? AUDIO_READ_MAX_SECONDS;
  const readingWindow = transcriptionWindow({
    startSeconds,
    ...(endSeconds !== null && endSeconds > startSeconds ? { endSeconds } : {}),
    maxSeconds
  });
  const prepared = await context.runner.prepareAudio(task.workspaceId, task.id, {
    path,
    startSeconds,
    endSeconds: readingWindow.endSeconds,
    ...(proof ? { expectedSourceSha256: proof.sourceSha256 } : {})
  });
  if (
    !Number.isFinite(prepared.preparedSeconds) ||
    prepared.preparedSeconds <= 0 ||
    prepared.preparedSeconds > maxSeconds ||
    prepared.preparedSeconds > readingWindow.endSeconds - startSeconds
  )
    throw new GardenError(
      'transcription_window_invalid',
      'The prepared recording exceeds its approved request window',
      400
    );
  if (
    proof &&
    (prepared.sourceSha256 !== proof.sourceSha256 || prepared.sourceBytes !== proof.sourceBytes)
  )
    throw new GardenError(
      'transcription_source_changed',
      'The recording no longer matches its approved source receipt',
      409
    );
  const estimateUsd = transcriptionEstimateUsd(prepared.preparedSeconds, chosen)!;
  if (controls.maxCostUsd !== undefined && estimateUsd > controls.maxCostUsd)
    throw new GardenError(
      'transcription_reservation_exceeded',
      'The selected recording window exceeds its spending reservation',
      402
    );
  const usage = {
    userId: task.userId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    kind: 'model_inference',
    resourceClass: 'media:transcription',
    quantity: Math.max(1, Math.ceil(prepared.preparedSeconds)),
    unit: 'second',
    credits: 0,
    idempotencyKey: `transcription:${task.id}:${call.id}:${modelId}`,
    providerRef: `${secret.provider}:${modelId}`
  };
  let reserved = false,
    settled = false,
    uploadAdmitted = false;
  const reading = await client
    .transcribe({
      model: modelId,
      privacyRoute,
      externalConsent: privacyRoute === 'external' && context.consequentialApproved,
      ...(signal ? { signal } : {}),
      audio: prepared.bytes,
      format: prepared.format,
      seconds: prepared.preparedSeconds,
      usdPerMinute: rate.usdPerMinute,
      ...(route?.pricing?.length ? { pricing: route.pricing } : {}),
      ...(controls.language ? { language: controls.language } : {}),
      ...(controls.prompt ? { prompt: controls.prompt } : {}),
      ...(controls.responseFormat ? { responseFormat: controls.responseFormat } : {}),
      ...(controls.keywords ? { keywords: controls.keywords } : {}),
      ...(controls.languages ? { languages: controls.languages } : {}),
      onBeforeSubmit: async () => {
        await assertActive();
        const latest = await currentTranscriptionCredential(
          await context.inferenceCredential(task, true)
        );
        if (
          transcriptionBinding(context.key, task, state, call, latest) !==
          transcriptionBinding(context.key, task, state, call, secret)
        )
          throw new GardenError(
            'transcription_approval_changed',
            'The transcription route or credential changed during preparation; request a new approval',
            409
          );
        await assertActive();
        if (proof) {
          requireTranscriptionApproval(context, call, secret);
          delete state.transcriptionApprovals?.[call.id];
        }
        await context.store.recordUsage({
          ...usage,
          costUsd: estimateUsd,
          state: 'reserved',
          reserveAgainstCaps: true
        });
        reserved = true;
        await assertActive();
        uploadAdmitted = true;
      },
      onUsage: async (receipt) => {
        if (receipt.costKnown && !settled) {
          await context.store.recordUsage({
            ...usage,
            ...(receipt.billedSeconds !== null ? { quantity: receipt.billedSeconds } : {}),
            costUsd: receipt.costUsd,
            state: 'settled',
            settleReservation: true
          });
          settled = true;
        }
      }
    })
    .catch(async (error: unknown) => {
      if (reserved && !settled && (!uploadAdmitted || error instanceof MediaProviderRejectionError))
        await context.store.recordUsage({
          ...usage,
          costUsd: 0,
          state: 'released',
          settleReservation: true
        });
      if (error instanceof GardenError) throw error;
      throw new GardenError(
        'audio_read_failed',
        error instanceof Error ? error.message : 'The recording could not be read'
      );
    });
  const measured = transcriptionRateFromReading(reading, prepared.preparedSeconds);
  if (measured !== null)
    state.transcriptionRates = { ...(state.transcriptionRates ?? {}), [modelId]: measured };
  const transcriptPath = `${path}${prepared.startSeconds > 0 ? `.from-${prepared.startSeconds}s` : ''}.transcript.txt`;
  // A receipt is settled before file delivery; failed writes must not advertise a transcript path.
  await context.runner.writeFile(task.workspaceId, task.id, transcriptPath, reading.text);
  const segmentsPath = reading.segments?.length ? transcriptPath.replace(/\.txt$/, '.json') : null;
  if (segmentsPath)
    await context.runner.writeFile(
      task.workspaceId,
      task.id,
      segmentsPath,
      JSON.stringify({ text: reading.text, segments: reading.segments }, null, 2)
    );
  const text = reading.text.slice(0, maxCharacters);
  return {
    path,
    transcriptPath,
    startSeconds: prepared.startSeconds,
    secondsRead: Math.round(prepared.preparedSeconds),
    ...(prepared.durationSeconds === null
      ? {}
      : { durationSeconds: Math.round(prepared.durationSeconds) }),
    ...(prepared.more
      ? { nextStartSeconds: prepared.startSeconds + Math.round(prepared.preparedSeconds) }
      : {}),
    characters: reading.text.length,
    truncated: reading.text.length > text.length,
    modelId,
    costUsd: reading.costKnown ? reading.costUsd : null,
    costSource: reading.costFromProvider ? 'provider' : reading.costKnown ? 'quote' : 'unresolved',
    ...(!reading.costKnown
      ? {
          reservationUsd: estimateUsd,
          billedBy: 'Provider charge is unresolved; the spending reservation remains held'
        }
      : {
          billedBy: reading.costFromProvider ? 'connected provider' : 'published route price'
        }),
    ...(segmentsPath
      ? {
          segmentsPath,
          segmentCount: reading.segments!.length,
          segments: reading.segments!.slice(0, 40)
        }
      : {}),
    ...(readingWindow.limited && prepared.more
      ? {
          pricing: `This reading was limited to ${maxSeconds} seconds by the selected model’s verified request bound. Continue from nextStartSeconds to read more with another approved reservation.`
        }
      : {}),
    text,
    ...(reading.text.length > text.length
      ? {
          instruction: `The whole transcript is at ${transcriptPath}; read it there without transcribing again.`
        }
      : {})
  };
};
