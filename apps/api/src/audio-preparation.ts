import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS } from '@garden/contracts';
import { GardenError } from '@garden/core';
import type { TranscriptionFormat } from './context.js';

const DEMUXERS: Record<TranscriptionFormat, string> = {
  wav: 'wav',
  mp3: 'mp3',
  flac: 'flac',
  m4a: 'mov',
  ogg: 'ogg',
  webm: 'matroska',
  aac: 'aac'
};
const SAMPLE_RATE = 16_000;
const MAX_PCM_BYTES = (DICTATION_MAX_SECONDS + 1) * SAMPLE_RATE * 2;

export const dictationDecoder = async (): Promise<string | null> => {
  for (const executable of [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg'
  ]) {
    if (
      await access(executable, constants.X_OK).then(
        () => true,
        () => false
      )
    )
      return executable;
  }
  return null;
};

export const decodeDictationBase64 = (data: string): Buffer => {
  if (
    !data ||
    data.length > Math.ceil(DICTATION_MAX_BYTES / 3) * 4 ||
    data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(data)
  )
    throw new GardenError('dictation_audio_invalid', 'Choose a bounded audio recording', 400);
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > DICTATION_MAX_BYTES || bytes.toString('base64') !== data)
    throw new GardenError(
      'dictation_audio_invalid',
      'The audio recording is malformed or too large',
      400
    );
  return bytes;
};

/** Decode a fixed container from stdin; the demuxer has no file or network protocol. */
export const prepareDictationAudio = async (
  bytes: Buffer,
  format: TranscriptionFormat,
  signal: AbortSignal
): Promise<{ bytes: Buffer; seconds: number; format: 'wav' }> => {
  const executable = await dictationDecoder();
  if (!executable)
    throw new GardenError(
      'dictation_decoder_unavailable',
      'This installation needs its native media tools before it can read recordings',
      503
    );
  signal.throwIfAborted();
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-max_alloc',
        '16777216',
        '-protocol_whitelist',
        'pipe',
        '-f',
        DEMUXERS[format],
        '-i',
        'pipe:0',
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-t',
        String(DICTATION_MAX_SECONDS + 1),
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-c:a',
        'pcm_s16le',
        '-f',
        's16le',
        'pipe:1'
      ],
      {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: '/',
        env: { PATH: '/usr/bin:/bin', LANG: 'C' }
      }
    );
    const chunks: Buffer[] = [];
    let size = 0,
      failure: Error | null = null;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () =>
      stop(new GardenError('dictation_cancelled', 'The recording was cancelled', 499));
    const timer = setTimeout(
      () =>
        stop(
          new GardenError(
            'dictation_decode_timeout',
            'The recording could not be prepared in time',
            422
          )
        ),
      20_000
    );
    timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PCM_BYTES)
        stop(
          new GardenError(
            'dictation_duration_limit',
            'Dictate a message of no more than five minutes',
            413
          )
        );
      else chunks.push(chunk);
    });
    // Decoder diagnostics can contain untrusted container strings; they never reach logs or UI.
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      failure ??= error;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || !size || size % 2 !== 0)
        reject(
          new GardenError(
            'dictation_audio_invalid',
            'The recording contains no readable audio',
            422
          )
        );
      else if (size > DICTATION_MAX_SECONDS * SAMPLE_RATE * 2)
        reject(
          new GardenError(
            'dictation_duration_limit',
            'Dictate a message of no more than five minutes',
            413
          )
        );
      else resolve(Buffer.concat(chunks, size));
    });
    child.stdin.end(bytes);
  });
  signal.throwIfAborted();
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return {
    bytes: Buffer.concat([header, pcm]),
    seconds: pcm.length / (SAMPLE_RATE * 2),
    format: 'wav'
  };
};
