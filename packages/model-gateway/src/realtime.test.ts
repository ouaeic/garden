import { describe, expect, it, vi } from 'vitest';
import {
  assertRealtimeSessionAcknowledged,
  decodeVoiceFrame,
  encodeVoiceFrame,
  REALTIME_MAX_OUTPUT_TOKENS,
  REALTIME_MODELS,
  realtimeReservationUsd,
  realtimeSessionConfiguration,
  realtimeUsageReceipt
} from './realtime.js';
import { discoverRealtimeModels } from './realtime-catalog.js';
const model = REALTIME_MODELS[0]!;
const config = () =>
  realtimeSessionConfiguration({
    modelId: model.modelId,
    voice: 'marin',
    reasoningEffort: 'low',
    instructions: 'Only propose task work for owner review.'
  });
const usage = () => ({
  input_tokens: 110,
  output_tokens: 60,
  total_tokens: 170,
  input_token_details: {
    text_tokens: 100,
    audio_tokens: 10,
    cached_tokens: 50,
    cached_tokens_details: { text_tokens: 45, audio_tokens: 5 }
  },
  output_token_details: { text_tokens: 10, audio_tokens: 50 }
});
describe('bounded native realtime transport', () => {
  it('requires account discovery and the fixed official route without a modality fallback', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: model.modelId }, { id: 'tts-1' }, { id: 'unknown-realtime' }]
          })
        )
    );
    expect(
      await discoverRealtimeModels({ baseUrl: 'https://api.openai.com/v1', apiKey: 'owner', fetch })
    ).toEqual([model]);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ redirect: 'error', headers: { authorization: 'Bearer owner' } })
    );
    await expect(
      discoverRealtimeModels({ baseUrl: 'https://api.openai.com.evil/v1', apiKey: 'owner', fetch })
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('requires acknowledgement of limits, no automatic response, ASR, tracing or extra tools', () => {
    expect(() => assertRealtimeSessionAcknowledged(config(), config())).not.toThrow();
    const variants: Array<[string[], unknown]> = [
      [['max_output_tokens'], REALTIME_MAX_OUTPUT_TOKENS + 1],
      [['audio', 'input', 'turn_detection', 'create_response'], true],
      [['audio', 'input', 'transcription'], { model: 'whisper-1' }],
      [['tools'], [{ type: 'function', name: 'shell' }]],
      [['tracing'], 'auto'],
      [['truncation', 'token_limits', 'post_instructions'], 2049],
      [['parallel_tool_calls'], true]
    ];
    expect(variants.length).toBeGreaterThan(0);
    for (const [path, value] of variants) {
      const c = structuredClone(config());
      let row = c;
      for (const part of path.slice(0, -1)) row = row[part] as Record<string, unknown>;
      row[path.at(-1)!] = value;
      expect(() => assertRealtimeSessionAcknowledged(c, config())).toThrow();
    }
    const reordered = config();
    (reordered.tools as unknown[]).reverse();
    expect(() => assertRealtimeSessionAcknowledged(reordered, config())).not.toThrow();
  });
  it('prices exact modality/cache receipts and holds ambiguous breakdowns', () => {
    expect(realtimeUsageReceipt(usage(), model).costUsd).toBeCloseTo(
      (55 * 0.6 + 45 * 0.06 + 5 * 10 + 5 * 0.3 + 10 * 2.4 + 50 * 20) / 1_000_000
    );
    expect(realtimeReservationUsd(model)).toBeGreaterThanOrEqual(
      (model.contextTokens * model.price.inputAudio) / 1_000_000
    );
    expect(realtimeReservationUsd(model)).toBeGreaterThan(
      realtimeUsageReceipt(usage(), model).costUsd
    );
    const bad = usage();
    bad.input_token_details.audio_tokens++;
    expect(() => realtimeUsageReceipt(bad, model)).toThrow();
    const cache = usage();
    cache.input_token_details.cached_tokens_details.audio_tokens = 11;
    expect(() => realtimeUsageReceipt(cache, model)).toThrow();
    const excess = usage();
    excess.output_tokens = REALTIME_MAX_OUTPUT_TOKENS + 1;
    excess.output_token_details.audio_tokens = REALTIME_MAX_OUTPUT_TOKENS - 9;
    expect(() => realtimeUsageReceipt(excess, model)).toThrow();
    expect(() => realtimeReservationUsd({ ...model, contextTokens: -1 })).toThrow();
  });
  it('retains the model context after reserving instruction, tool and output capacity', () => {
    const c = config();
    const limits = (c.truncation as { token_limits: { post_instructions: number } }).token_limits;
    expect(limits.post_instructions).toBeGreaterThan(100_000);
    expect(limits.post_instructions + Number(c.max_output_tokens)).toBeLessThan(
      model.contextTokens
    );
    expect(realtimeReservationUsd(model)).toBeGreaterThanOrEqual(
      (model.contextTokens * model.price.inputAudio +
        REALTIME_MAX_OUTPUT_TOKENS * model.price.outputAudio) /
        1_000_000
    );
    const long = usage();
    long.output_tokens = 2_048;
    long.output_token_details.audio_tokens = 2_038;
    long.total_tokens = long.input_tokens + long.output_tokens;
    expect(realtimeUsageReceipt(long, model).outputTokens).toBe(2_048);
  });
  it('preserves exact PCM framing and refuses malformed, oversized or wrapping frames', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const decoded = decodeVoiceFrame(encodeVoiceFrame(2, 14, pcm));
    expect(decoded).toMatchObject({ epoch: 2, sampleOffset: 14 });
    expect([...decoded.pcm]).toEqual([...pcm]);
    for (const frame of [new Uint8Array(8), new Uint8Array(4809), new Uint8Array(12)])
      expect(() => decodeVoiceFrame(frame)).toThrow();
    expect(() => encodeVoiceFrame(1, 0xffffffff, pcm)).toThrow();
  });
});
