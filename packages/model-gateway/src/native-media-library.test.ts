import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENAI_VIDEO_RETIREMENT_AT } from './openai-media-catalog.js';

// Protocol fixtures exercise the active route; retirement has a separate boundary case.
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse(OPENAI_VIDEO_RETIREMENT_AT) - 1));
afterEach(() => vi.restoreAllMocks());
import {
  NativeMediaLibraryClient,
  NativeMediaSubmissionUncertainError
} from './native-media-library.js';
const options = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'owner-key',
  privacyRoute: 'external' as const
};
const mp4 = Buffer.from('0000ftypisom0000');
describe('native media library operations', () => {
  it('pages the owner library without following response URLs or revealing prompts', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        has_more: true,
        data: [
          {
            id: 'video_1',
            status: 'completed',
            model: 'sora-2',
            seconds: '8',
            prompt: 'private',
            url: 'https://elsewhere.test',
            size: '1280x720'
          }
        ]
      })
    );
    const result = await new NativeMediaLibraryClient({ ...options, fetch }).listVideos({
      limit: 1
    });
    expect(result).toMatchObject({
      hasMore: true,
      nextAfter: 'video_1',
      videos: [{ id: 'video_1', seconds: 8 }]
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual([
      'https://api.openai.com/v1/videos?limit=1&order=desc',
      expect.objectContaining({ redirect: 'error', method: 'GET' })
    ]);
  });
  it('refuses traversal, endpoint switching and retained uploads on a ZDR route before HTTP', async () => {
    const fetch = vi.fn();
    expect(
      () => new NativeMediaLibraryClient({ ...options, baseUrl: 'https://proxy.test/v1', fetch })
    ).toThrow('native OpenAI');
    const client = new NativeMediaLibraryClient({
      ...options,
      privacyRoute: 'provider_zdr',
      fetch
    });
    await expect(client.listVideos({ after: '../secrets' })).rejects.toThrow(
      'valid provider media ID'
    );
    await expect(client.createCharacter({ name: 'Moss', bytes: mp4 })).rejects.toThrow(
      'provider-retention approval'
    );
    await expect(client.deleteVideo('video_1')).rejects.toThrow('explicit approval');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('deletes a completed library video only after checking state and confirming its exact ID', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === 'GET'
        ? Response.json({ id: 'video_1', status: 'completed' })
        : Response.json({ id: 'video_1', deleted: true })
    );
    expect(
      await new NativeMediaLibraryClient({ ...options, fetch }).deleteVideo('video_1')
    ).toEqual({ id: 'video_1', deleted: true, cancellationSupported: false });
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'DELETE']);
    const busy = vi.fn(async () => Response.json({ id: 'video_1', status: 'in_progress' }));
    await expect(
      new NativeMediaLibraryClient({ ...options, fetch: busy }).deleteVideo('video_1')
    ).rejects.toThrow('does not cancel processing');
    expect(busy).toHaveBeenCalledOnce();
  });
  it('uploads prepared MP4 bytes as a character and never replays an ambiguous submission', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get('name')).toBe('Moss');
      expect((init?.body as FormData).get('video')).toBeInstanceOf(Blob);
      return Response.json({ id: 'char_1', name: 'Moss' });
    });
    expect(
      await new NativeMediaLibraryClient({ ...options, fetch }).createCharacter({
        name: 'Moss',
        bytes: mp4
      })
    ).toEqual({ id: 'char_1', name: 'Moss' });
    expect(fetch).toHaveBeenCalledOnce();
    const lost = vi.fn(async () => {
      throw new Error('connection lost');
    });
    await expect(
      new NativeMediaLibraryClient({ ...options, fetch: lost }).createCharacter({
        name: 'Moss',
        bytes: mp4
      })
    ).rejects.toBeInstanceOf(NativeMediaSubmissionUncertainError);
    expect(lost).toHaveBeenCalledOnce();
  });
  it('checks a recovered character against its exact original-provider receipt', async () => {
    const fetch = vi.fn(async () => Response.json({ id: 'char_recovered', name: 'Moss' }));
    const client = new NativeMediaLibraryClient({ ...options, fetch });
    await expect(client.getCharacter('char_recovered')).resolves.toEqual({
      id: 'char_recovered',
      name: 'Moss'
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://api.openai.com/v1/videos/characters/char_recovered',
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    );
    await expect(client.getCharacter('char_other')).rejects.toThrow('different character');
  });
  it('uploads JSONL and creates video batches with a fixed endpoint and completion window', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (
        (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/files')
      ) {
        expect((init?.body as FormData).get('purpose')).toBe('batch');
        return Response.json({ id: 'file_1' });
      }
      expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
        input_file_id: 'file_1',
        endpoint: '/v1/videos',
        completion_window: '24h',
        output_expires_after: { anchor: 'created_at', seconds: 86400 }
      });
      return Response.json({ id: 'batch_1', input_file_id: 'file_1', status: 'validating' });
    });
    const client = new NativeMediaLibraryClient({ ...options, fetch });
    expect(
      await client.uploadBatch({
        jsonl: JSON.stringify({
          custom_id: 'shot1',
          method: 'POST',
          url: '/v1/videos',
          body: { model: 'sora-2', prompt: 'Moss', seconds: '8' }
        })
      })
    ).toEqual({ id: 'file_1' });
    expect(await client.submitBatch('file_1')).toMatchObject({
      id: 'batch_1',
      status: 'validating'
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(
      client.uploadBatch({
        jsonl: JSON.stringify({ custom_id: 'shot1', method: 'DELETE', url: '/v1/files', body: {} })
      })
    ).rejects.toThrow('video generation requests');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('native batch cancellation receipts', () => {
  it('reports the provider cancelling state without fabricating immediate cancellation', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ id: 'batch_1', status: 'cancelling', input_file_id: 'file_1' })
    );
    const result = await new NativeMediaLibraryClient({ ...options, fetch }).cancelBatch('batch_1');
    expect(result.status).toBe('cancelling');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://api.openai.com/v1/batches/batch_1/cancel',
      expect.objectContaining({ method: 'POST', redirect: 'error' })
    );
  });
});

it('refuses character and batch creation at the retirement boundary before HTTP', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(OPENAI_VIDEO_RETIREMENT_AT));
  const fetch = vi.fn();
  const client = new NativeMediaLibraryClient({ ...options, fetch });
  await expect(client.createCharacter({ name: 'Moss', bytes: mp4 })).rejects.toThrow('retired');
  await expect(client.submitBatch('file_1')).rejects.toThrow('retired');
  expect(fetch).not.toHaveBeenCalled();
});
