import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaClient } from './media.js';

afterEach(() => vi.unstubAllGlobals());

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bQAAAABJRU5ErkJggg==',
  'base64'
);
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]);

const client = () =>
  new MediaClient({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'managed-key',
    appUrl: 'https://garden.example'
  });

describe('managed media generation', () => {
  it('requires ZDR and data-collection denial for image generation', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      expect(body).toMatchObject({
        model: 'black-forest-labs/flux.2-klein-4b',
        provider: { zdr: true, data_collection: 'deny', allow_fallbacks: true }
      });
      return new Response(
        JSON.stringify({
          data: [{ b64_json: PNG.toString('base64') }],
          usage: { cost: 0.014 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', request);
    await expect(
      client().generate({
        id: 'gen-2',
        kind: 'image',
        model: 'black-forest-labs/flux.2-klein-4b',
        prompt: 'A private image',
        width: 1024,
        height: 1024,
        seed: 2
      })
    ).resolves.toMatchObject({ costUsd: 0.014, outputs: [{ filename: 'gen-2-1.png' }] });
  });

  it('uses the commercially reviewed Kokoro route and voice for speech', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      expect(body).toMatchObject({
        model: 'hexgrad/kokoro-82m',
        voice: 'af_heart',
        provider: { zdr: true, data_collection: 'deny' }
      });
      return new Response(MP3, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      });
    });
    vi.stubGlobal('fetch', request);
    await expect(
      client().generate({
        id: 'gen-3',
        kind: 'audio',
        model: 'hexgrad/kokoro-82m',
        prompt: 'Private speech',
        width: 0,
        height: 0,
        seed: 3,
        voice: 'af_heart'
      })
    ).resolves.toMatchObject({ outputs: [{ filename: 'gen-3.mp3' }] });
  });

  it('sends no voice to a speech route whose voices garden does not know', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as object) : {};
      expect(body).not.toHaveProperty('voice');
      return new Response(MP3, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      });
    });
    vi.stubGlobal('fetch', request);
    await expect(
      client().generate({
        id: 'gen-6',
        kind: 'audio',
        model: 'some-other/speech-model',
        prompt: 'Private speech',
        width: 0,
        height: 0,
        seed: 6,
        usdPerMillionCharacters: 2
      })
    ).resolves.toMatchObject({ costUsd: (14 * 2) / 1_000_000 });
  });

  it('prices an image from the chosen route rather than from the compiled-in default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    );
    await expect(
      client().generate({
        id: 'gen-7',
        kind: 'image',
        model: 'some-other/image-model',
        prompt: 'A private image',
        width: 1000,
        height: 1000,
        seed: 7,
        usdPerImage: 0.09
      })
    ).resolves.toMatchObject({ costUsd: 0.09 });
  });
  it('settles a silent provider from typed area pricing and leaves unknown charges identified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
      )
    );
    const input = {
      id: 'area',
      kind: 'image' as const,
      model: 'vendor/draw',
      prompt: 'A private image',
      width: 4096,
      height: 4096,
      seed: 1
    };
    await expect(
      client().generate({
        ...input,
        pricing: [{ billable: 'output_image', unit: 'megapixel', costUsd: 0.014 }]
      })
    ).resolves.toMatchObject({ costUsd: 0.234881024, costFromProvider: false, costKnown: true });
    await expect(client().generate(input)).resolves.toMatchObject({ costUsd: 0, costKnown: false });
    await expect(client().generate({ ...input, width: -1 })).rejects.toThrow('dimensions');
  });

  it('refuses to fetch an output the provider offered over plain HTTP', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/images'))
        return new Response(JSON.stringify({ data: [{ url: 'http://cdn.example/img.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      throw new Error('the download should never have been attempted');
    });
    vi.stubGlobal('fetch', request);
    await expect(
      client().generate({
        id: 'gen-4',
        kind: 'image',
        model: 'black-forest-labs/flux.2-klein-4b',
        prompt: 'A private image',
        width: 1024,
        height: 1024,
        seed: 4
      })
    ).rejects.toThrow('unsafe download URL');
  });

  it('carries the provider error body, so a refusal says why', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no such model', { status: 404 }))
    );
    await expect(
      client().generate({
        id: 'gen-5',
        kind: 'image',
        model: 'black-forest-labs/flux.2-klein-4b',
        prompt: 'A private image',
        width: 1024,
        height: 1024,
        seed: 5
      })
    ).rejects.toThrow('no such model');
  });
});

describe('reading a recording back as text', () => {
  it('rejects missing or private external consent before reservation or upload, including compatible aliases', async () => {
    const fetch = vi.fn(),
      before = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const input = {
      model: 'openai/whisper-1',
      audio: Buffer.from('ogg'),
      format: 'ogg' as const,
      seconds: 2,
      onBeforeSubmit: before
    };
    for (const adapter of [
      client(),
      new MediaClient({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiProtocol: 'openai',
        openRouter: false,
        appUrl: 'https://garden.example'
      })
    ]) {
      await expect(adapter.transcribe(input)).rejects.toThrow('external retention consent');
      await expect(
        adapter.transcribe({ ...input, privacyRoute: 'provider_zdr', externalConsent: true })
      ).rejects.toThrow('external retention consent');
      await expect(adapter.transcribe({ ...input, privacyRoute: 'external' })).rejects.toThrow(
        'external retention consent'
      );
    }
    expect(before).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('routes supported vocabulary hints through provider options and rechecks cancellation after reservation', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(typeof init?.body).toBe('string');
      expect(JSON.parse(init!.body as string)).toMatchObject({
        provider: { options: { openai: { prompt: 'garden' } } }
      });
      return Response.json({ text: 'garden', usage: { cost: 0.001 } });
    });
    vi.stubGlobal('fetch', fetch);
    const input = {
      model: 'openai/whisper-1',
      audio: Buffer.from('ogg'),
      format: 'ogg' as const,
      seconds: 2,
      privacyRoute: 'external' as const,
      externalConsent: true,
      prompt: 'garden'
    };
    await client().transcribe(input);
    await expect(
      client().transcribe({
        ...input,
        signal: controller.signal,
        onBeforeSubmit: async () => {
          controller.abort();
        }
      })
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('sends approved external audio without unsupported routing policy claims', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      expect(body).toMatchObject({
        model: 'a-transcription-route',
        input_audio: { data: Buffer.from('ogg-bytes').toString('base64'), format: 'ogg' },
        temperature: 0
      });
      expect(body).not.toHaveProperty('provider');
      return new Response(
        JSON.stringify({ text: '  the meeting starts now  ', usage: { seconds: 61, cost: 0.007 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', request);
    await expect(
      client().transcribe({
        privacyRoute: 'external',
        externalConsent: true,
        model: 'a-transcription-route',
        audio: Buffer.from('ogg-bytes'),
        format: 'ogg',
        seconds: 60,
        usdPerMinute: 0.02
      })
    ).resolves.toEqual({
      text: 'the meeting starts now',
      costKnown: true,
      billedSeconds: 61,
      // The provider's own figure, not the per-minute arithmetic: a duration price is quoted per
      // minute and rounded in ways this side cannot see, so a derived number in the ledger would be
      // a guess sitting where a billed amount belongs.
      costUsd: 0.007,
      costFromProvider: true
    });
  });

  it('preserves uncertain OpenRouter charges when the routed provider omits its receipt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ text: 'two minutes of talking' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    );
    await expect(
      client().transcribe({
        privacyRoute: 'external',
        externalConsent: true,
        model: 'a-transcription-route',
        audio: Buffer.from('ogg-bytes'),
        format: 'ogg',
        seconds: 120,
        usdPerMinute: 0.006
      })
    ).resolves.toMatchObject({
      billedSeconds: null,
      costUsd: 0,
      costKnown: false,
      costFromProvider: false
    });
  });

  it('refuses an answer with no speech in it rather than reporting an empty reading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ text: '   ' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    );
    await expect(
      client().transcribe({
        privacyRoute: 'external',
        externalConsent: true,
        model: 'a-transcription-route',
        audio: Buffer.from('ogg-bytes'),
        format: 'ogg',
        seconds: 30
      })
    ).rejects.toThrow(/no speech/i);
  });

  it('asks the provider which models read recordings, and only for those', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe('/api/v1/models');
      expect(url.searchParams.get('output_modalities')).toBe('transcription');
      return new Response(JSON.stringify({ data: [{ id: 'one' }, {}, { id: 'two' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', request);
    await expect(client().transcriptionModels()).resolves.toEqual(['one', 'two']);
  });
});

describe('curated media controls and native protocols', () => {
  const request = {
    id: 'controlled',
    kind: 'image' as const,
    model: 'vendor/image',
    prompt: 'An informative diagram',
    width: 1024,
    height: 1024,
    seed: 7
  };
  const imageResponse = () =>
    new Response(
      JSON.stringify({
        data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }],
        usage: { cost: 0.02 }
      })
    );
  it('sends prepared reference images and chosen controls on the approved provider endpoint', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toMatchObject({
        quality: 'low',
        background: 'transparent',
        input_references: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` }
          }
        ],
        provider: { only: ['selected-endpoint'], allow_fallbacks: false, zdr: true }
      });
      return imageResponse();
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      client().generate({
        ...request,
        quality: 'low',
        background: 'transparent',
        inputReferences: [`data:image/png;base64,${PNG.toString('base64')}`],
        providerEndpointTag: 'selected-endpoint'
      })
    ).resolves.toMatchObject({ costUsd: 0.02, costFromProvider: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects unsupported choices and remote references before provider spend', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      client().generate({
        ...request,
        count: 2,
        capabilities: {
          parameters: { n: { type: 'range', min: 1, max: 1 } },
          supportsStreaming: false
        }
      })
    ).rejects.toThrow('does not support');
    await expect(
      client().generate({
        ...request,
        inputReferences: ['https://untrusted.example/reference.png']
      })
    ).rejects.toThrow('workspace image bytes');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses native image generation and multipart edit routes with no routing extension', async () => {
    const native = new MediaClient({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'fixture-key',
      appUrl: 'https://garden.example',
      apiProtocol: 'openai'
    });
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if ((url instanceof Request ? url.url : String(url)).endsWith('/images/edits')) {
        expect(init?.body).toBeInstanceOf(FormData);
        if (!(init?.body instanceof FormData)) throw new Error('Expected multipart body');
        expect(init.body.get('image[]')).toBeInstanceOf(Blob);
        expect(init.body.get('provider')).toBeNull();
        expect(new Headers(init.headers).has('content-type')).toBe(false);
      } else {
        expect(url instanceof Request ? url.url : String(url)).toBe(
          'https://api.openai.com/v1/images/generations'
        );
        expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).not.toHaveProperty(
          'provider'
        );
      }
      return imageResponse();
    });
    vi.stubGlobal('fetch', fetch);
    await native.generate(request);
    await native.generate({
      ...request,
      inputReferences: [`data:image/png;base64,${PNG.toString('base64')}`]
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map(([url]) => (url instanceof Request ? url.url : String(url)))
    ).toEqual([
      'https://api.openai.com/v1/images/generations',
      'https://api.openai.com/v1/images/edits'
    ]);
  });
  it('uploads native transcription as multipart and preserves timed speaker segments', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      if (!(init?.body instanceof FormData)) throw new Error('Expected multipart body');
      expect(init.body.get('file')).toBeInstanceOf(Blob);
      expect(init.body.get('response_format')).toBe('diarized_json');
      return new Response(
        JSON.stringify({
          text: 'Hello',
          duration: 2,
          segments: [{ text: 'Hello', start: 0, end: 2, speaker: 'speaker_1' }]
        })
      );
    });
    vi.stubGlobal('fetch', fetch);
    const native = new MediaClient({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'fixture-key',
      appUrl: 'https://garden.example',
      apiProtocol: 'openai'
    });
    await expect(
      native.transcribe({
        model: 'gpt-4o-transcribe-diarize',
        audio: MP3,
        format: 'mp3',
        seconds: 2,
        responseFormat: 'diarized_json'
      })
    ).resolves.toMatchObject({
      text: 'Hello',
      billedSeconds: 2,
      segments: [{ text: 'Hello', start: 0, end: 2, speaker: 'speaker_1' }]
    });
  });
});

describe('transcription receipt and native hint contracts', () => {
  it('reserves before upload and settles reported token usage before inspecting transcript content', async () => {
    const before = vi.fn(async () => undefined),
      usage = vi.fn(async () => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        expect(before).toHaveBeenCalledOnce();
        return Response.json({ text: '', usage: { input_tokens: 200, output_tokens: 100 } });
      })
    );
    await expect(
      new MediaClient({
        baseUrl: 'https://api.openai.com/v1',
        appUrl: 'https://garden.example',
        apiProtocol: 'openai'
      }).transcribe({
        model: 'token-transcriber',
        audio: Buffer.from('ogg'),
        format: 'ogg',
        seconds: 60,
        pricing: [
          { billable: 'input_tokens', unit: 'token', costUsd: 0.0000025 },
          { billable: 'output_tokens', unit: 'token', costUsd: 0.00001 }
        ],
        onBeforeSubmit: before,
        onUsage: usage
      })
    ).rejects.toThrow('no speech');
    expect(usage).toHaveBeenCalledExactlyOnceWith({
      billedSeconds: null,
      costUsd: 0.0015,
      costKnown: true,
      costFromProvider: false
    });
  });
  it('requires diarization chunking for longer files and serializes supported multilingual hints as native multipart arrays', async () => {
    const native = new MediaClient({
      baseUrl: 'https://api.openai.com/v1',
      appUrl: 'https://garden.example',
      apiProtocol: 'openai'
    });
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      return Response.json({ text: 'Hello' });
    });
    vi.stubGlobal('fetch', fetch);
    await native.transcribe({
      model: 'gpt-4o-transcribe-diarize',
      audio: Buffer.from('ogg'),
      format: 'ogg',
      seconds: 60
    });
    const diarization = fetch.mock.calls[0]![1]!.body as FormData;
    expect(diarization.get('chunking_strategy')).toBe('auto');
    expect(diarization.get('response_format')).toBe('diarized_json');
    await native.transcribe({
      model: 'gpt-transcribe',
      audio: Buffer.from('ogg'),
      format: 'ogg',
      seconds: 60,
      keywords: ['BRCA1'],
      languages: ['en', 'fr']
    });
    const hints = fetch.mock.calls[1]![1]!.body as FormData;
    expect(hints.getAll('keywords[]')).toEqual(['BRCA1']);
    expect(hints.getAll('languages[]')).toEqual(['en', 'fr']);
    await expect(
      native.transcribe({
        model: 'whisper-1',
        audio: Buffer.from('ogg'),
        format: 'ogg',
        seconds: 60,
        keywords: ['BRCA1']
      })
    ).rejects.toThrow('Keyword');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('refuses over-size prepared audio before reserving or making a paid request and distinguishes unknown cost', async () => {
    const before = vi.fn(async () => undefined),
      fetch = vi.fn(async () => Response.json({ text: 'Unknown charge' }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      client().transcribe({
        privacyRoute: 'external',
        externalConsent: true,
        model: 'unknown',
        audio: Buffer.alloc(25 * 1024 * 1024 + 1),
        format: 'ogg',
        seconds: 60,
        onBeforeSubmit: before
      })
    ).rejects.toThrow('25 MB');
    expect(before).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      client().transcribe({
        privacyRoute: 'external',
        externalConsent: true,
        model: 'unknown',
        audio: Buffer.from('ogg'),
        format: 'ogg',
        seconds: 60
      })
    ).resolves.toMatchObject({ costKnown: false, costUsd: 0 });
  });
});
