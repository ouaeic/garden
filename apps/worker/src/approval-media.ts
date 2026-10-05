/** Undefined continues the floor; null preserves an explicit read-only decision. */
import { AUDIO_READ_MAX_SECONDS } from '@garden/contracts';
import { mediaQuoteUsd, transcriptionEstimateUsd, MEDIA_APPROVAL_USD } from './media.js';
import { textValue } from './values.js';
import { mediaArguments, TranscriptionControls } from './media-controls.js';
import { type ApprovalContext, type ApprovalRequirement } from './approval-common.js';

export const mediaApprovalRequirement = (
  name: string,
  args: Record<string, unknown>,
  context: ApprovalContext
): ApprovalRequirement | null | undefined => {
  if (name === 'generate_media') {
    const mediaArgs = mediaArguments(args);
    if (mediaArgs.action === 'describe' || mediaArgs.action === 'status') return null;
    if (mediaArgs.action === 'batch') {
      const shots = Array.isArray(mediaArgs.shots) ? mediaArgs.shots : [];
      const quotes = shots.map((shot: Record<string, unknown>) =>
        mediaQuoteUsd({
          kind: 'video',
          duration: shot.duration,
          size: shot.size,
          ...(context.mediaModel ? { model: context.mediaModel } : {})
        })
      );
      const cost = quotes.every((quote) => quote !== null)
        ? quotes.reduce<number>((total, quote) => total + (quote ?? 0) / 2, 0)
        : null;
      return {
        sideEffect: 'external_reversible',
        action: 'Approve this video batch and temporary provider retention',
        preview: `Submit ${shots.length} video shots through the selected native provider's Batch API. ${cost === null ? `Reserve $${Number(mediaArgs.maxCostUsd || 0).toFixed(2)}; some prices are unresolved.` : `The published batch estimate is $${cost.toFixed(3)}.`} The prompts and references will be retained by the provider. This batch is not eligible for zero data retention. Processing may take up to 24 hours, and garden downloads each completed shot automatically. This approval applies only to these shots. Stopping local watching does not cancel provider processing or charges.`
      };
    }
    if (mediaArgs.action === 'library') {
      if (mediaArgs.operation === 'cancel_batch')
        return {
          sideEffect: 'external_consequential',
          action: 'Request cancellation of this provider video batch',
          preview: `Cancel garden batch ${textValue(mediaArgs.batchId)}. Provider cancellation can take up to ten minutes; completed shots still incur charges and will be delivered.`
        };
      if (mediaArgs.operation === 'delete_video')
        return {
          keys: ['remove'],
          sideEffect: 'external_consequential',
          action: 'Delete this completed video from the provider library',
          preview: `Permanently remove provider video ${textValue(mediaArgs.providerVideoId)} from this connected account. Download any copy you want to keep first. This removes provider storage only; it does not cancel processing or reverse charges.`
        };
      if (mediaArgs.operation === 'create_character')
        return {
          sideEffect: 'external_reversible',
          action: 'Create a retained reusable character asset',
          preview: `Upload ${textValue(mediaArgs.referencePath)} as “${textValue(mediaArgs.name)}” to the selected native video provider. The MP4 will be retained for reuse. This operation is not eligible for zero data retention. The provider publishes no separate upload price; reserve $${Number(mediaArgs.maxCostUsd || 0).toFixed(2)} until billing is reconciled. This approval applies only to this upload.`
        };
      return null;
    }
    const model = context.mediaModel;
    const quoteUsd = mediaQuoteUsd({
      kind: textValue(mediaArgs.kind),
      width: mediaArgs.width,
      height: mediaArgs.height,
      characterCount: textValue(mediaArgs.prompt).trim().length,
      count: mediaArgs.count,
      quality: mediaArgs.quality,
      resolution: mediaArgs.resolution,
      size: mediaArgs.size,
      duration: mediaArgs.duration,
      inputReferenceCount: Array.isArray(mediaArgs.inputReferences)
        ? mediaArgs.inputReferences.length
        : 0,
      ...(model ? { model } : {})
    });
    const estimateUsd = quoteUsd ?? 0;
    if (mediaArgs.kind === 'video')
      return {
        sideEffect: 'external_reversible',
        action: 'Approve this video job and temporary provider retention',
        preview: `${mediaArgs.operation === 'edit' ? 'Edit' : mediaArgs.operation === 'extend' ? 'Extend' : 'Generate'} a ${typeof mediaArgs.duration === 'number' ? mediaArgs.duration : textValue(mediaArgs.duration)} second video${typeof mediaArgs.sourceJobId === 'string' ? ` from garden job ${mediaArgs.sourceJobId}` : ''}${model ? ` with ${model.displayName}` : ''}. ${quoteUsd === null ? `The provider does not publish a complete price for these settings. Reserve $${Number(mediaArgs.maxCostUsd || 0).toFixed(2)}; final billing may differ.` : `The published estimate is $${quoteUsd.toFixed(3)}.`}\n\nThis job sends the prompt and any selected reference images to a provider that retains them temporarily. Video is not eligible for zero data retention. This approval applies only to this job; the task's other routing stays unchanged. Processing continues in the background. Stopping local watching does not cancel provider processing or charges.\n\n${textValue(mediaArgs.prompt).slice(0, 1000)}`
      };
    const committedUsd = Math.max(0, Number(context.mediaCommittedUsd) || 0);
    const unpriced = quoteUsd === null;
    if (unpriced || committedUsd + estimateUsd >= MEDIA_APPROVAL_USD)
      return {
        // A priced generation is spending, which the spend key lends within the goal's cap. An
        // unpriced one has no figure for the cap to hold, so it always asks.
        ...(unpriced ? {} : { keys: ['spend'] as const }),
        sideEffect: 'external_reversible',
        action: 'Approve continued provider spend on generated media',
        preview: `Generate ${textValue(mediaArgs.kind, 'media')}${model ? ` with ${model.displayName}` : ''} ${unpriced ? 'from the connected provider account. This model publishes no price garden can read, so the cost is only known once the provider bills it.' : `for about $${estimateUsd.toFixed(3)} from the connected provider account.`}${unpriced && typeof mediaArgs.maxCostUsd === 'number' && Number.isFinite(mediaArgs.maxCostUsd) ? ` Reserve $${mediaArgs.maxCostUsd.toFixed(2)} for this request; final billing may differ.` : ''}${committedUsd > 0 ? ` This task has already spent about $${committedUsd.toFixed(2)} generating media.` : ''}\n\nEvery further generation in this task asks again.`
      };
  }
  if (name === 'audio_read') {
    const native =
      args.options && typeof args.options === 'object' && 'action' in args.options
        ? args.options.action
        : undefined;
    if (native === 'describe') return null;
    if (native === 'native')
      return {
        sideEffect: 'external_reversible',
        action: 'Send native recording to the selected model',
        preview: `Send the exact bytes of ${textValue(args.path, 'a workspace recording')} once in the next normal model request${context.nativeInput ? ` to ${context.nativeInput.model}, reserving up to $${context.nativeInput.reservationUsd.toFixed(3)} for the full context and output bound (source SHA-256 ${context.nativeInput.sha256})` : ''}. This includes the recording’s audio or visual contents and embedded metadata. The task’s current provider and privacy route apply; the source must still match its inspected hash. Unknown modality prices refuse before submission.`
      };
    const controls = TranscriptionControls.parse(args.options ?? {});
    const model = context.mediaModel;
    const start = Math.max(0, Number(args.startSeconds) || 0);
    const end = Number(args.endSeconds);
    const seconds = Math.min(
      model?.transcriptionBound?.maxSeconds ?? AUDIO_READ_MAX_SECONDS,
      Number.isFinite(end) && end > start ? end - start : AUDIO_READ_MAX_SECONDS
    );
    const estimateUsd = transcriptionEstimateUsd(seconds, model ?? null);
    const committedUsd = Math.max(0, Number(context.mediaCommittedUsd) || 0);
    const nativeBound = model?.transcriptionBound;
    const external = controls.privacyRoute === 'external';
    if (
      external ||
      estimateUsd === null ||
      nativeBound ||
      committedUsd + estimateUsd >= MEDIA_APPROVAL_USD
    )
      return {
        // Only plain spending is a key's to lend: an unbounded price, or a recording leaving the
        // zero-retention route, is a different question and keeps its card.
        ...(!external && estimateUsd !== null ? { keys: ['spend'] as const } : {}),
        sideEffect: 'external_reversible',
        action: external
          ? 'Send this recording for external transcription'
          : 'Approve continued provider spend on reading recordings',
        preview: `Read up to ${seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`} of ${textValue(args.path, 'a recording')}${model ? ` with ${model.displayName}` : ''}. ${external ? 'This call sends recording contents and metadata outside the verified zero-retention route. A zero-retention routing guarantee is not applied to this request; the transcription provider may retain it under its terms. This exception covers only this reading; task and credential privacy stay unchanged. ' : ''}${estimateUsd === null ? 'This route has no verified whole-request cost bound. The recording will not be sent; choose a supported priced transcription model in Settings.' : nativeBound ? `Reserve up to $${estimateUsd.toFixed(3)} for the model’s full ${nativeBound.contextTokens}-token context and ${nativeBound.maxOutputTokens}-token output limit. Missing provider usage keeps this reservation held.` : external ? `Reserve up to $${estimateUsd.toFixed(3)} before submission. This is held capacity; the provider receipt determines the final charge, and missing usage keeps the reservation held.` : `That is about $${estimateUsd.toFixed(3)} from the connected provider account.`}${controls.maxCostUsd !== undefined ? ` The requested spending ceiling is $${controls.maxCostUsd.toFixed(2)}; it cannot replace a verified cost bound.` : ''}${committedUsd > 0 ? ` This task has already spent about $${committedUsd.toFixed(2)} on media.` : ''}\n\nEvery further reading in this task asks again.`
      };
  }
  return undefined;
};
