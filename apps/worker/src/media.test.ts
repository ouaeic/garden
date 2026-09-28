import { describe, expect, it } from 'vitest';
import { AUDIO_READ_MAX_SECONDS, type MediaModelOption } from '@garden/contracts';
import {
  mediaDimension,
  mediaImageDimensions,
  mediaQuoteUsd,
  resolvedMediaModel,
  resolvedTranscriptionRoute,
  transcriptionEstimateUsd,
  transcriptionRate,
  transcriptionRateFromReading,
  transcriptionWindow
} from './media.js';

const option = (overrides: Partial<MediaModelOption> = {}): MediaModelOption => ({
  id: 'native/transcription',
  providerModelId: 'gpt-4o-transcribe',
  displayName: 'Transcription',
  provider: 'openai',
  apiProtocol: 'openai',
  modality: 'transcription',
  usdPerImage: null,
  usdPerMillionCharacters: null,
  usdPerMinute: null,
  priceSource: 'provider',
  recommendationTags: [],
  updatedAt: '2026-09-06T00:00:00.000Z',
  ...overrides
});
const native = (overrides: Partial<MediaModelOption> = {}) =>
  option({
    pricing: [
      { billable: 'input_tokens', unit: 'token', costUsd: 0.0000025 },
      { billable: 'output_tokens', unit: 'token', costUsd: 0.00001 }
    ],
    ...overrides
  });
const resolve = (route: MediaModelOption, connection = true) =>
  resolvedTranscriptionRoute({ transcription: route }, connection);

it('prices the same model-specific image default used by execution and rejects undersized requests', () => {
  const model = resolvedMediaModel('image', {
    image: option({
      providerModelId: 'bytedance-seed/seedream-4.5',
      modality: 'image',
      pricing: [{ billable: 'output_image', unit: 'megapixel', costUsd: 0.01 }]
    })
  });
  const request = { kind: 'image', model };
  expect(mediaImageDimensions(request)).toEqual({ width: 2048, height: 2048 });
  expect(mediaQuoteUsd(request)).toBe(0.04194304);
  expect(mediaQuoteUsd({ ...request, resolution: '4K' })).toBe(0.16777216);
  expect(() => mediaQuoteUsd({ ...request, width: 1024, height: 1024 })).toThrow('pixels');
});

describe('complete recording request cost evidence', () => {
  it('rounds a published duration quote up to the billing minute', () => {
    const model = resolve(option({ usdPerMinute: 0.006 }));
    expect(transcriptionEstimateUsd(61, model)).toBeCloseTo(0.012);
    expect(transcriptionEstimateUsd(0, model)).toBe(0);
    expect(transcriptionRate(model).source).toBe('published');
  });
  it('requires complete pricing lines and ignores indicative duration on token routes', () => {
    const model = resolve(native({ usdPerMinute: 0.006 }));
    expect(transcriptionRate(model)).toEqual({ usdPerMinute: null, source: 'unknown' });
    expect(transcriptionEstimateUsd(1, model)).toBeCloseTo(0.06);
    expect(transcriptionEstimateUsd(300, model)).toBeCloseTo(0.06);
    expect(
      transcriptionEstimateUsd(
        60,
        resolve(
          native({
            pricing: [
              ...native().pricing!,
              { billable: 'input_audio', unit: 'minute', costUsd: 0.006 }
            ]
          })
        )
      )
    ).toBeNull();
  });
  it('does not turn an unknown price or a third-party model limit into a bound', () => {
    expect(transcriptionEstimateUsd(60, resolve(native({ priceSource: 'unknown' })))).toBeNull();
    expect(transcriptionEstimateUsd(60, resolve(native(), false))).toBeNull();
    expect(
      transcriptionEstimateUsd(60, resolve(native({ providerModelId: 'future-transcribe' })))
    ).toBeNull();
    expect(transcriptionEstimateUsd(60, null)).toBeNull();
  });
  it('treats measured rates as reporting data, never duration authority', () => {
    const reading = { costUsd: 0.02, billedSeconds: 60, costFromProvider: true };
    expect(transcriptionRateFromReading(reading, 60)).toBeCloseTo(0.02);
    const unresolved = resolve(option({ priceSource: 'unknown' }));
    expect(transcriptionRate(unresolved)).toEqual({ usdPerMinute: null, source: 'unknown' });
    expect(transcriptionEstimateUsd(5400, unresolved)).toBeNull();
    expect(transcriptionRateFromReading({ ...reading, costFromProvider: false }, 60)).toBeNull();
    expect(transcriptionRateFromReading({ ...reading, billedSeconds: 0 }, 0)).toBeNull();
  });
  it('clips native requests without expanding short caller windows', () => {
    expect(transcriptionWindow({ startSeconds: 60, endSeconds: 5400, maxSeconds: 300 })).toEqual({
      endSeconds: 360,
      limited: true
    });
    expect(transcriptionWindow({ startSeconds: 60, endSeconds: 70, maxSeconds: 300 })).toEqual({
      endSeconds: 70,
      limited: false
    });
    expect(transcriptionWindow({ startSeconds: 60, maxSeconds: 30 })).toEqual({
      endSeconds: 90,
      limited: true
    });
    expect(transcriptionWindow({ startSeconds: 60, maxSeconds: AUDIO_READ_MAX_SECONDS })).toEqual({
      endSeconds: 5460,
      limited: false
    });
  });
});

describe('the bound applied to a dimension before anything is priced', () => {
  /*
   * The standing negative control for `mediaDimension`, which had none.
   *
   * `clamp` guards on `Number.isFinite` before it clamps, and deleting that one line left all
   * 1,178 tests in this package green while `mediaDimension('12px')` started returning NaN and
   * `mediaDimension(Infinity)` started returning the 4,096 ceiling. That is the incident named at
   * the top of media.ts wearing new clothes: a number the model wrote, never checked, arriving as
   * NaN and reaching pricing - except that this time it is the size rather than the estimate, and
   * a NaN dimension prices a generation at NaN, which compares false against every spending limit
   * there is.
   *
   * So the assertion is on the arithmetic and not on the happy path: a value that is not a finite
   * number must come back as the stated default, and every result must be a number the ceiling can
   * actually be compared against. `Math.min(max, Math.max(min, NaN))` is NaN, so a test that only
   * checked the range would pass on the mutant too.
   */
  // Labelled rather than stringified: half of these are the shapes that have no useful `String`,
  // which is the whole reason they reach `clamp` as something other than a number.
  const notNumbers: readonly (readonly [string, unknown])[] = [
    ['a string with units', '12px'],
    ['a word', 'abc'],
    ['an object', {}],
    ['an array', [1, 2]],
    ['null', null],
    ['omitted', undefined],
    ['NaN itself', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY]
  ];

  it('turns anything that is not a finite number into the stated default', () => {
    for (const [label, written] of notNumbers) expect(mediaDimension(written), label).toBe(1_024);
  });

  it('never hands pricing a value a spending limit would compare false against', () => {
    const priced: readonly (readonly [string, unknown])[] = [
      ...notNumbers,
      ['above the ceiling', 8_192],
      ['below the floor', -5],
      ['a numeric string', '2048'],
      ['an ordinary number', 300]
    ];
    for (const [label, written] of priced)
      expect(Number.isFinite(mediaDimension(written)), label).toBe(true);
  });

  it('still clamps a finite number to the range generate_media declares', () => {
    // The empty string is here and not above on purpose: it coerces to a finite 0, so it is a
    // number out of range rather than a non-number, and the floor is the right answer for it.
    expect(mediaDimension('')).toBe(256);
    expect(mediaDimension('2048')).toBe(2_048);
    expect(mediaDimension(8_192)).toBe(4_096);
    expect(mediaDimension(-5)).toBe(256);
  });
});
