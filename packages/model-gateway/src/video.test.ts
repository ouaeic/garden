import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENAI_VIDEO_RETIREMENT_AT } from './openai-media-catalog.js';

// Protocol fixtures exercise the active route; retirement has a separate boundary case.
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse(OPENAI_VIDEO_RETIREMENT_AT) - 1));
afterEach(() => vi.restoreAllMocks());
import { VideoClient, VideoSubmissionUncertainError } from './video.js';

const input = {
  model: 'vendor/video',
  prompt: 'A seedling opening in morning light',
  duration: 5,
  resolution: '720p'
};
const options = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'fixture-key',
  privacyRoute: 'external' as const
};
describe('durable video provider operations', () => {
  it('refuses zero-retention submission without making any provider request', async () => {
    const fetch = vi.fn();
    await expect(
      new VideoClient({ ...options, privacyRoute: 'provider_zdr', fetch }).submit(input)
    ).rejects.toThrow('approved temporary provider-retention');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('submits once, returns a durable ID and polls independently without generating again', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      if (init?.method === 'POST') {
        expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toMatchObject({
          duration: 5,
          resolution: '720p',
          provider: { zdr: false, data_collection: 'deny' }
        });
        return new Response(
          JSON.stringify({
            id: 'job-1',
            status: 'pending',
            polling_url: 'https://untrusted.example/steal'
          }),
          { status: 202 }
        );
      }
      expect(url instanceof Request ? url.url : String(url)).toBe(
        'https://provider.example/v1/videos/job-1'
      );
      return new Response(
        JSON.stringify({
          id: 'job-1',
          status: 'completed',
          progress: 100,
          usage: { cost: 0.25 },
          unsigned_urls: ['https://untrusted.example/steal']
        })
      );
    });
    const client = new VideoClient({ ...options, fetch });
    await expect(client.submit(input)).resolves.toEqual({ id: 'job-1', status: 'pending' });
    await expect(client.poll('job-1')).resolves.toEqual({
      id: 'job-1',
      status: 'completed',
      progress: 100,
      costUsd: 0.25
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('marks a lost submit response as uncertain and never retries billable creation', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('lost connection after upload');
    });
    await expect(new VideoClient({ ...options, fetch }).submit(input)).rejects.toBeInstanceOf(
      VideoSubmissionUncertainError
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects unsupported duration and reference URLs before submission', async () => {
    const fetch = vi.fn();
    const client = new VideoClient({ ...options, fetch });
    await expect(
      client.submit({
        ...input,
        capabilities: {
          parameters: { duration: { type: 'enum', values: ['10'] } },
          supportsStreaming: false
        }
      })
    ).rejects.toThrow('does not support');
    await expect(
      client.submit({
        ...input,
        frameImages: [{ image: 'https://untrusted.example/image', frameType: 'first_frame' }]
      })
    ).rejects.toThrow('workspace image bytes');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the native multipart video protocol and normalizes queue state', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get('seconds')).toBe('8');
      expect((init?.body as FormData).get('provider')).toBeNull();
      return new Response(JSON.stringify({ id: 'video_1', status: 'queued', progress: 0 }), {
        status: 202
      });
    });
    await expect(
      new VideoClient({ ...options, apiProtocol: 'openai', fetch }).submit({
        model: 'sora-2',
        prompt: 'A seedling opens',
        duration: 8,
        size: '1280x720'
      })
    ).resolves.toEqual({ id: 'video_1', status: 'pending', progress: 0 });
  });
  it('downloads only authenticated same-provider MP4 content and rejects mismatched job IDs', async () => {
    const mp4 = Buffer.from([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0
    ]);
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-key');
      if ((url instanceof Request ? url.url : String(url)).endsWith('/content'))
        return new Response(mp4, { headers: { 'content-type': 'video/mp4' } });
      return new Response(JSON.stringify({ id: 'some-other-job', status: 'completed' }));
    });
    const client = new VideoClient({ ...options, fetch });
    await expect(client.download('job-1')).resolves.toEqual({
      bytes: mp4,
      mimeType: 'video/mp4',
      filename: 'job-1.mp4'
    });
    await expect(client.poll('job-1')).rejects.toThrow('different video job');
    await expect(client.download('../credential')).rejects.toThrow('invalid video job ID');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['edit', 'extend'] as const)(
    'submits native %s jobs with source identity and no regenerated model fields',
    async (operation) => {
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(url instanceof Request ? url.url : String(url)).toBe(
          `https://provider.example/v1/videos/${operation === 'edit' ? 'edits' : 'extensions'}`
        );
        expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
          video: { id: 'video_original' },
          prompt: 'Continue the scene',
          ...(operation === 'extend' ? { seconds: '8' } : {})
        });
        return Response.json({ id: 'video_derived', status: 'queued' });
      });
      await expect(
        new VideoClient({ ...options, apiProtocol: 'openai', fetch }).submit({
          operation,
          sourceProviderId: 'video_original',
          model: 'sora-2',
          prompt: 'Continue the scene',
          duration: 8,
          size: '1280x720'
        })
      ).resolves.toMatchObject({ id: 'video_derived', status: 'pending' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
  it('refuses foreign protocols and invalid source IDs before a derived job is submitted', async () => {
    const fetch = vi.fn();
    const derived = {
      operation: 'extend' as const,
      sourceProviderId: 'video_original',
      model: 'sora-2',
      prompt: 'Continue',
      duration: 8
    };
    await expect(new VideoClient({ ...options, fetch }).submit(derived)).rejects.toThrow(
      'native source'
    );
    await expect(
      new VideoClient({ ...options, apiProtocol: 'openai', fetch }).submit({
        ...derived,
        sourceProviderId: '../another-account'
      })
    ).rejects.toThrow('invalid video job ID');
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('refuses new native video at the retirement boundary before HTTP', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(OPENAI_VIDEO_RETIREMENT_AT));
  const fetch = vi.fn();
  await expect(
    new VideoClient({
      ...options,
      baseUrl: 'https://api.openai.com/v1',
      apiProtocol: 'openai',
      fetch
    }).submit({
      model: 'sora-2',
      prompt: 'A seedling',
      duration: 8,
      size: '1280x720'
    })
  ).rejects.toThrow('retired');
  expect(fetch).not.toHaveBeenCalled();
});
