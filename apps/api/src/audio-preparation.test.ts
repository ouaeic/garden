import { execFile } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { DICTATION_MAX_BYTES } from '@garden/contracts';
import {
  decodeDictationBase64,
  dictationDecoder,
  prepareDictationAudio
} from './audio-preparation.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { spawn } from 'node:child_process';
const wav = (seconds: number) => {
  const pcm = Buffer.alloc(Math.floor(seconds * 32_000)),
    h = Buffer.alloc(44);
  h.write('RIFF');
  h.writeUInt32LE(pcm.length + 36, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};
const executable = await dictationDecoder();
describe('bounded native dictation decoding', () => {
  it('rejects noncanonical and oversized audio before decoding', () => {
    for (const value of [
      'not base64',
      'YR==',
      '',
      Buffer.alloc(DICTATION_MAX_BYTES + 1).toString('base64')
    ])
      expect(() => decodeDictationBase64(value)).toThrow();
    expect(decodeDictationBase64(wav(1).toString('base64'))).toEqual(wav(1));
  });
  it.skipIf(!executable)(
    'measures decoded samples and confines the demuxer to pipes and a fixed container',
    async () => {
      const result = await prepareDictationAudio(wav(1.25), 'wav', new AbortController().signal);
      expect(result.seconds).toBe(1.25);
      expect(result.format).toBe('wav');
      expect(result.bytes).toEqual(wav(1.25));
      expect(spawn).toHaveBeenCalled();
      const [command, args, options] = vi.mocked(spawn).mock.calls.at(-1)!;
      expect(command).toBe(executable);
      expect(args).toEqual(
        expect.arrayContaining(['-protocol_whitelist', 'pipe', '-f', 'wav', '-i', 'pipe:0'])
      );
      expect(args).not.toContain('file');
      expect(options).toMatchObject({ shell: false, cwd: '/' });
    }
  );
  it.skipIf(!executable)(
    'rejects compressed silence beyond the duration limit without trusting compressed size',
    async () => {
      const { stdout } = await promisify(execFile)(
        executable!,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'anullsrc=r=16000:cl=mono',
          '-t',
          '301',
          '-c:a',
          'flac',
          '-f',
          'flac',
          'pipe:1'
        ],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 }
      );
      expect(stdout.length).toBeGreaterThan(0);
      expect(stdout.length).toBeLessThan(100_000);
      await expect(
        prepareDictationAudio(stdout, 'flac', new AbortController().signal).then(
          (result) => result.seconds
        )
      ).rejects.toMatchObject({ code: 'dictation_duration_limit' });
    }
  );
  it.skipIf(!executable)(
    'supports the actual browser WebM/Opus and fragmented MP4/AAC containers',
    async () => {
      const formats = [
        ['webm', 'libopus', 'webm'],
        ['m4a', 'aac', 'mp4']
      ] as const;
      expect(formats.length).toBeGreaterThan(0);
      for (const [format, codec, muxer] of formats) {
        const { stdout } = await promisify(execFile)(
          executable!,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=48000',
            '-t',
            '1',
            '-c:a',
            codec,
            ...(format === 'm4a' ? ['-movflags', 'frag_keyframe+empty_moov'] : []),
            '-f',
            muxer,
            'pipe:1'
          ],
          { encoding: 'buffer', maxBuffer: 1024 * 1024 }
        );
        const prepared = await prepareDictationAudio(stdout, format, new AbortController().signal);
        expect(prepared.seconds).toBeGreaterThan(0.9);
        expect(prepared.seconds).toBeLessThan(1.1);
        expect(prepared.bytes.toString('ascii', 8, 12)).toBe('WAVE');
      }
    }
  );
  it.skipIf(!executable)(
    'rejects malformed containers and cancelled input before a provider can read them',
    async () => {
      await expect(
        prepareDictationAudio(
          Buffer.from('#EXTM3U\nhttps://127.0.0.1/private\n'),
          'webm',
          new AbortController().signal
        )
      ).rejects.toMatchObject({ code: 'dictation_audio_invalid' });
      const signal = AbortSignal.abort();
      await expect(prepareDictationAudio(wav(1), 'wav', signal)).rejects.toThrow();
    }
  );
});
