import { z } from 'zod';
import { GardenError } from '@garden/core';

export const NATIVE_INPUT_MAX_BYTES = 8 * 1024 * 1024;
export const NATIVE_INPUT_MAX_PARTS = 4;
export const NativeInputPart = z
  .object({
    kind: z.enum(['audio', 'video']),
    mimeType: z.enum(['audio/wav', 'audio/mpeg', 'video/mp4', 'video/webm']),
    data: z
      .string()
      .min(1)
      .max(Math.ceil(NATIVE_INPUT_MAX_BYTES / 3) * 4)
  })
  .strict();
export type NativeInputPart = z.infer<typeof NativeInputPart>;

export const nativeInputMime = (
  bytes: Uint8Array,
  kind: 'audio' | 'video'
): NativeInputPart['mimeType'] => {
  const data = Buffer.from(bytes);
  if (kind === 'audio') {
    if (
      data.length >= 44 &&
      data.toString('ascii', 0, 4) === 'RIFF' &&
      data.toString('ascii', 8, 12) === 'WAVE'
    )
      return 'audio/wav';
    if (
      data.length >= 4 &&
      (data.toString('ascii', 0, 3) === 'ID3' || (data[0] === 255 && (data[1]! & 0xe0) === 0xe0))
    )
      return 'audio/mpeg';
  } else {
    if (
      data.length >= 24 &&
      data.toString('ascii', 4, 8) === 'ftyp' &&
      /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V )$/.test(data.toString('ascii', 8, 12))
    )
      return 'video/mp4';
    if (
      data.length >= 16 &&
      data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      data.subarray(0, 4096).includes(Buffer.from('webm'))
    )
      return 'video/webm';
  }
  throw new GardenError(
    'native_input_format_unsupported',
    'Native reading accepts WAV/MP3 audio or MP4/WebM video with matching file bytes. Convert other formats explicitly first.',
    400
  );
};

export type NativeInputBlock =
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } }
  | { type: 'video_url'; video_url: { url: string }; processing: 'static' };

/** Native inputs are never converted, remotely fetched, or silently dropped by the transport. */
export const nativeInputBlocks = (
  parts: readonly NativeInputPart[],
  provider: string,
  modalities: readonly string[] | undefined
): NativeInputBlock[] => {
  if (parts.length > NATIVE_INPUT_MAX_PARTS)
    throw new GardenError(
      'native_input_too_large',
      'Too many native media parts for one request',
      413
    );
  let bytes = 0;
  return parts.map((raw) => {
    const part = NativeInputPart.parse(raw);
    if (!modalities?.includes(part.kind) || (part.kind === 'video' && provider !== 'openrouter'))
      throw new GardenError(
        'native_input_unsupported',
        'The selected model and provider protocol do not declare this native input modality',
        400
      );
    const decoded = Buffer.from(part.data, 'base64');
    if (decoded.toString('base64') !== part.data)
      throw new GardenError(
        'native_input_invalid',
        'Native input must contain canonical base64 file bytes',
        400
      );
    bytes += decoded.byteLength;
    if (bytes > NATIVE_INPUT_MAX_BYTES)
      throw new GardenError(
        'native_input_too_large',
        'Native media exceeds the combined request byte limit',
        413
      );
    if (nativeInputMime(decoded, part.kind) !== part.mimeType)
      throw new GardenError(
        'native_input_invalid',
        'Native input MIME does not match its bytes',
        400
      );
    return part.kind === 'audio'
      ? {
          type: 'input_audio',
          input_audio: { data: part.data, format: part.mimeType === 'audio/wav' ? 'wav' : 'mp3' }
        }
      : {
          type: 'video_url',
          video_url: { url: `data:${part.mimeType};base64,${part.data}` },
          processing: 'static'
        };
  });
};
