import { describe, expect, it, vi } from 'vitest';
import { MediaModelOption } from '@garden/contracts';
import { isNativeOpenAIEndpoint, refreshOpenAIMediaCatalog } from './openai-media-catalog.js';
import { quoteMediaPrice } from './media-capabilities.js';

describe('native account media discovery', () => {
  it('offers only account-listed implemented families, including current image, speech, transcription and video', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: [
          'gpt-image-2',
          'gpt-image-1.5',
          'gpt-4o-mini-tts',
          'tts-1-hd',
          'whisper-1',
          'gpt-transcribe',
          'gpt-4o-transcribe-diarize',
          'sora-2',
          'sora-2-pro',
          'unrecognized-model'
        ].map((id) => ({ id }))
      })
    );
    const models = await refreshOpenAIMediaCatalog({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'fixture',
      fetch,
      requireZeroDataRetention: true
    });
    expect(models).toHaveLength(9);
    for (const model of models) expect(MediaModelOption.safeParse(model).success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(models.some((m) => m.providerModelId === 'unrecognized-model')).toBe(false);
    expect(models.find((model) => model.providerModelId === 'gpt-transcribe')).toMatchObject({
      usdPerMinute: 0.0045,
      priceSource: 'provider'
    });
    const video = models.find((m) => m.providerModelId === 'sora-2-pro')!;
    expect(video).toMatchObject({
      apiProtocol: 'openai',
      zeroDataRetentionAvailable: false,
      requiresRetentionApproval: true
    });
    expect(quoteMediaPrice(video.pricing, { seconds: 20, variant: '1920x1080' })).toBe(14);
    const image = models.find((m) => m.providerModelId === 'gpt-image-2')!;
    expect(image).toMatchObject({ priceSource: 'provider', usdPerImage: null });
    expect(image.capabilities?.parameters).not.toHaveProperty('input_fidelity');
    expect(quoteMediaPrice(image.pricing, { width: 1024, height: 1024 })).toBeNull();
    expect(
      quoteMediaPrice(image.pricing, {
        tokens: { input_text: 100, input_image: 200, output_image: 1000 }
      })
    ).toBeCloseTo(0.0321, 8);
    expect(models.find((m) => m.providerModelId === 'tts-1-hd')?.usdPerMillionCharacters).toBe(30);
    expect(
      models.find((m) => m.providerModelId === 'gpt-4o-mini-tts')?.capabilities?.parameters
        .output_format
    ).toEqual({ type: 'enum', values: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] });
  });
  it('does not send an owner key to a lookalike endpoint or invent account availability', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [] }));
    expect(isNativeOpenAIEndpoint('https://api.openai.com.evil.example/v1')).toBe(false);
    await expect(
      refreshOpenAIMediaCatalog({
        baseUrl: 'https://api.openai.com.evil.example/v1',
        apiKey: 'fixture',
        fetch
      })
    ).rejects.toThrow('official');
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      refreshOpenAIMediaCatalog({ baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture', fetch })
    ).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('native video retirement boundary', () => {
  it('keeps retired models inspectable while refusing to offer new native generations', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-25T00:00:00Z'));
      const models = await refreshOpenAIMediaCatalog({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'fixture',
        fetch: async () => Response.json({ data: [{ id: 'sora-2' }, { id: 'gpt-image-2' }] })
      });
      expect(models).toHaveLength(2);
      expect(models.find((model) => model.modality === 'video')).toMatchObject({
        retirementAt: '2026-09-24T00:00:00.000Z'
      });
      expect(models.find((model) => model.modality === 'video')?.unavailableReason).toContain(
        'retired'
      );
      expect(models.find((model) => model.modality === 'image')?.unavailableReason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
