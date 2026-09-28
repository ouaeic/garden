import type { MediaModelOption } from '@garden/contracts';

/** Published native model limits bound one unchunked transcription request. */
const nativeLimits: Readonly<Record<string, { context: number; output: number; seconds: number }>> =
  {
    'gpt-4o-transcribe': { context: 16000, output: 2000, seconds: 300 },
    'gpt-4o-mini-transcribe': { context: 16000, output: 2000, seconds: 300 },
    'gpt-4o-mini-transcribe-2025-12-15': { context: 16000, output: 2000, seconds: 300 },
    'gpt-4o-transcribe-diarize': { context: 16000, output: 2000, seconds: 30 }
  };

export interface TranscriptionBound {
  reservationUsd: number;
  maxSeconds: number;
  contextTokens: number;
  maxOutputTokens: number;
}

export function nativeTranscriptionBound(
  route: MediaModelOption | null | undefined
): TranscriptionBound | null {
  if (
    !route ||
    route.modality !== 'transcription' ||
    route.apiProtocol !== 'openai' ||
    route.priceSource === 'unknown'
  )
    return null;
  const limits = nativeLimits[route.providerModelId];
  if (!limits || route.pricing?.length !== 2) return null;
  const input = route.pricing.find((line) => line.billable === 'input_tokens');
  const output = route.pricing.find((line) => line.billable === 'output_tokens');
  if (
    !input ||
    !output ||
    [input, output].some(
      (line) =>
        line.unit !== 'token' ||
        line.variant !== undefined ||
        !Number.isFinite(line.costUsd) ||
        line.costUsd < 0
    )
  )
    return null;
  const reservationUsd = limits.context * input.costUsd + limits.output * output.costUsd;
  if (!Number.isFinite(reservationUsd)) return null;
  return {
    reservationUsd,
    maxSeconds: limits.seconds,
    contextTokens: limits.context,
    maxOutputTokens: limits.output
  };
}
