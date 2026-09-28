import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnnexBAccessUnitReader,
  DisplayEncoder,
  DisplayFrameQueue,
  JpegFrameReader,
  agentImageGeometry,
  align16,
  avcCodecString,
  cvtReducedBlankingMode,
  decodeDisplayMessage,
  displayEncoderArguments,
  encodeVideoAccessUnit,
  newModeArguments,
  parseRandrState,
  resolveTargetGeometry,
  shouldApplyGeometry,
  stillCaptureArguments,
  type DisplayEncoderConfig,
  type DisplayEncoderProcess,
  type DisplayStreamFrame
} from './desktop-stream.js';

const nal = (type: number, ...payload: number[]): Buffer =>
  Buffer.concat([Buffer.from([0, 0, 0, 1, type]), Buffer.from(payload)]);

// first_mb_in_slice is ue(v); a leading 1 bit means zero, so 0x80 starts a picture and
// 0x40 is a continuation slice of the same picture.
const FIRST_SLICE = 0x80;
const NEXT_SLICE = 0x40;

const streamFrame = (overrides: Partial<DisplayStreamFrame> = {}): DisplayStreamFrame => ({
  data: Buffer.from([1, 2, 3]),
  keyframe: false,
  sequence: 1,
  captureUs: 0n,
  generation: 1,
  ...overrides
});

describe('capturing one rectangle instead of the whole screen', () => {
  // The still is the whole display reduced to fit a bounded image, so a small control arrives a few
  // pixels across and clicking it is a guess. Cropping asks x11grab for those pixels at their own
  // size, which is the same screenshot path with two more arguments.
  const base = {
    display: ':91',
    geometry: { width: 1920, height: 1080 },
    image: { width: 1440, height: 810 },
    quality: 3
  };

  it('crops rather than scaling when a region is asked for', () => {
    const args = stillCaptureArguments({
      ...base,
      region: { x: 100, y: 50, width: 320, height: 200 }
    });
    expect(args.join(' ')).toContain('crop=320:200:100:50');
    // A region that fits the image is sent at its own size, which is the entire point of a zoom.
    expect(args.join(' ')).not.toContain('scale=');
  });

  /**
   * The bound the `scale=` filter did not carry, because it sat in the `else` below the region
   * branch and therefore never ran for a region at all. A zoom of the whole of a 2560x1600 display
   * came back at 4.1 megapixels: three times the box the full screenshot of that display is reduced
   * into, and a closer look larger than the picture it is a closer look at.
   */
  it('reduces a region larger than the image instead of sending it at native density', () => {
    const args = stillCaptureArguments({
      ...base,
      region: { x: 0, y: 0, width: 1920, height: 1080 }
    });
    // Cropped first and reduced after, in one filter chain: the crop is what makes it a zoom and
    // the scale is what stops it being bigger than a screenshot.
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=1920:1080:0:0,scale=1440:810:flags=lanczos');
  });

  it('clamps a region that runs off the screen instead of failing the capture', () => {
    // x11grab refuses a rectangle outside the display, so a region a pixel too wide would turn a
    // closer look into a broken screenshot.
    const args = stillCaptureArguments({
      ...base,
      region: { x: 1900, y: 1060, width: 4000, height: 4000 }
    });
    // Clamped to the display at one end and to the image at the other; before the second of those
    // this read `crop=1920:1080:0:0` and nothing else, and passed.
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=1920:1080:0:0,scale=1440:810:flags=lanczos');
  });

  it('still scales the whole screen when no region is asked for', () => {
    expect(stillCaptureArguments(base).join(' ')).toContain('scale=1440:810');
  });
});

describe('annex-b access unit reader', () => {
  const idrUnit = Buffer.concat([
    nal(7, 0x42, 0xe0, 0x20),
    nal(8, 0xce),
    nal(5, FIRST_SLICE, 0x11)
  ]);
  const deltaUnit = Buffer.concat([nal(1, FIRST_SLICE, 0x22)]);
  const secondDelta = Buffer.concat([nal(1, FIRST_SLICE, 0x33)]);

  it('splits access units and keeps the parameter sets with their keyframe', () => {
    const reader = new AnnexBAccessUnitReader();
    const frames = reader.push(Buffer.concat([idrUnit, deltaUnit, secondDelta]));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.keyframe).toBe(true);
    expect(frames[0]?.data.equals(idrUnit)).toBe(true);
    expect(frames[1]?.keyframe).toBe(false);
    expect(frames[1]?.data.equals(deltaUnit)).toBe(true);
  });

  it('is independent of how the pipe chunks the stream', () => {
    const stream = Buffer.concat([idrUnit, deltaUnit, secondDelta]);
    const reader = new AnnexBAccessUnitReader();
    const frames = [];
    for (const byte of stream) frames.push(...reader.push(Buffer.from([byte])));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.data.equals(idrUnit)).toBe(true);
    expect(frames[1]?.data.equals(deltaUnit)).toBe(true);
  });

  it('keeps multi-slice pictures in one access unit', () => {
    const sliced = Buffer.concat([nal(1, FIRST_SLICE, 0x01), nal(1, NEXT_SLICE, 0x02)]);
    const reader = new AnnexBAccessUnitReader();
    const frames = reader.push(Buffer.concat([sliced, deltaUnit]));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data.equals(sliced)).toBe(true);
  });

  it('releases the last access unit when the encoder goes quiet', () => {
    const reader = new AnnexBAccessUnitReader();
    // A difference-gated encoder watching a still desktop emits exactly this and stops.
    expect(reader.push(idrUnit)).toHaveLength(0);
    const pending = reader.flushPending();
    expect(pending?.keyframe).toBe(true);
    expect(pending?.data.equals(idrUnit)).toBe(true);
    expect(reader.flushPending()).toBeNull();
    // The reader stays usable once the screen changes again.
    expect(reader.push(Buffer.concat([deltaUnit, secondDelta]))).toHaveLength(1);
  });

  it('never emits parameter sets on their own as a picture', () => {
    const reader = new AnnexBAccessUnitReader();
    reader.push(Buffer.concat([nal(7, 0x42, 0xe0, 0x20), nal(8, 0xce)]));
    expect(reader.flushPending()).toBeNull();
  });

  it('accepts three byte start codes and leading garbage', () => {
    const threeByte = Buffer.from([0, 0, 1, 5, FIRST_SLICE]);
    const reader = new AnnexBAccessUnitReader();
    const frames = reader.push(
      Buffer.concat([Buffer.from([0xaa, 0xbb]), threeByte, deltaUnit, secondDelta])
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]?.keyframe).toBe(true);
    expect(frames[0]?.data.equals(threeByte)).toBe(true);
  });
});

describe('jpeg frame reader', () => {
  it('splits a concatenated mjpeg pipe into whole images', () => {
    const first = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    const second = Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]);
    const reader = new JpegFrameReader();
    expect(reader.push(Buffer.concat([first, second.subarray(0, 3)]))).toHaveLength(1);
    const rest = reader.push(second.subarray(3));
    expect(rest).toHaveLength(1);
    expect(rest[0]?.data.equals(second)).toBe(true);
    expect(rest[0]?.keyframe).toBe(true);
  });
});

describe('bounded frame queue', () => {
  it('bounds memory and refuses deltas the client can no longer decode', () => {
    const queue = new DisplayFrameQueue(2);
    queue.push(streamFrame({ sequence: 1, keyframe: true }));
    queue.push(streamFrame({ sequence: 2 }));
    expect(queue.size).toBe(2);
    expect(queue.starved).toBe(false);
    queue.push(streamFrame({ sequence: 3 }));
    expect(queue.size).toBe(2);
    expect(queue.dropped).toBe(1);
    expect(queue.starved).toBe(true);
    queue.shift();
    queue.shift();
    // A slot is free again but the stream is broken, so further deltas are still refused.
    queue.push(streamFrame({ sequence: 4 }));
    expect(queue.size).toBe(0);
    expect(queue.dropped).toBe(2);
  });

  it('lets a keyframe supersede everything pending', () => {
    const queue = new DisplayFrameQueue(2);
    queue.push(streamFrame({ sequence: 1 }));
    queue.push(streamFrame({ sequence: 2 }));
    queue.push(streamFrame({ sequence: 3 }));
    expect(queue.starved).toBe(true);
    queue.push(streamFrame({ sequence: 4, keyframe: true }));
    expect(queue.size).toBe(1);
    expect(queue.starved).toBe(false);
    expect(queue.shift()?.sequence).toBe(4);
  });
});

describe('display wire framing', () => {
  it('round-trips an access unit header', () => {
    const message = encodeVideoAccessUnit(
      streamFrame({
        data: Buffer.from([9, 9, 9]),
        keyframe: true,
        sequence: 4_294_967_295,
        captureUs: 1_234_567_890_123n,
        generation: 7
      })
    );
    const decoded = decodeDisplayMessage(message);
    expect(decoded).toMatchObject({
      type: 0x10,
      sequence: 4_294_967_295,
      captureUs: 1_234_567_890_123n,
      keyframe: true,
      generation: 7
    });
    expect(decoded.payload.equals(Buffer.from([9, 9, 9]))).toBe(true);
  });
});

describe('display geometry', () => {
  it('produces cvt reduced blanking timings that match cvt -r', () => {
    expect(cvtReducedBlankingMode(1920, 1080)).toEqual({
      name: 'garden-1920x1080',
      clockMhz: 138.5,
      horizontal: [1920, 1968, 2000, 2080],
      vertical: [1080, 1083, 1088, 1111],
      flags: ['+hsync', '-vsync']
    });
    expect(cvtReducedBlankingMode(1280, 800)).toMatchObject({
      clockMhz: 71,
      horizontal: [1280, 1328, 1360, 1440],
      vertical: [800, 803, 809, 823]
    });
    expect(newModeArguments(cvtReducedBlankingMode(1280, 800))).toEqual([
      '--newmode',
      'garden-1280x800',
      '71.00',
      '1280',
      '1328',
      '1360',
      '1440',
      '800',
      '803',
      '809',
      '823',
      '+hsync',
      '-vsync'
    ]);
  });

  it('aligns the viewport to macroblocks and clamps to the xvfb ceiling', () => {
    const limits = {
      ceiling: { width: 3840, height: 2160 },
      maximum: { width: 2560, height: 1600 },
      minimum: { width: 640, height: 400 }
    };
    expect(
      resolveTargetGeometry(
        { cssWidth: 1367, cssHeight: 769, devicePixelRatio: 2, mode: 'css' },
        limits
      )
    ).toEqual({ width: 1360, height: 768 });
    expect(
      resolveTargetGeometry(
        { cssWidth: 1200, cssHeight: 769, devicePixelRatio: 2, mode: 'native' },
        limits
      )
    ).toEqual({ width: 2400, height: 1536 });
    expect(
      resolveTargetGeometry(
        { cssWidth: 3440, cssHeight: 1440, devicePixelRatio: 3, mode: 'native' },
        limits
      )
    ).toEqual({ width: 2560, height: 1600 });
    expect(
      resolveTargetGeometry(
        { cssWidth: 320, cssHeight: 200, devicePixelRatio: 1, mode: 'css' },
        limits
      )
    ).toEqual({ width: 640, height: 400 });
    expect(align16(1367)).toBe(1360);
  });

  it('ignores resizes inside the hysteresis band', () => {
    expect(shouldApplyGeometry({ width: 1280, height: 800 }, { width: 1280, height: 800 })).toBe(
      false
    );
    expect(shouldApplyGeometry({ width: 1280, height: 800 }, { width: 1296, height: 800 })).toBe(
      false
    );
    expect(shouldApplyGeometry({ width: 1280, height: 800 }, { width: 1360, height: 800 })).toBe(
      true
    );
    expect(shouldApplyGeometry({ width: 1280, height: 800 }, { width: 1280, height: 768 })).toBe(
      true
    );
  });

  it('reads the output name, current size and leaked garden modes from xrandr', () => {
    const output = [
      'Screen 0: minimum 1 x 1, current 1280 x 800, maximum 3840 x 2160',
      'screen connected 1280x800+0+0 (normal left inverted right x axis y axis) 0mm x 0mm',
      '   1280x800      59.98*+',
      '   garden-1280x800  59.81',
      '   garden-2560x1600  59.94'
    ].join('\n');
    expect(parseRandrState(output)).toEqual({
      output: 'screen',
      current: { width: 1280, height: 800 },
      maximum: { width: 3840, height: 2160 },
      gardenModes: ['garden-1280x800', 'garden-2560x1600']
    });
    expect(parseRandrState('nonsense')).toBeNull();
  });

  it('bounds the agent still to the coordinate space the action contract accepts', () => {
    expect(agentImageGeometry({ width: 1280, height: 800 }, { width: 1440, height: 900 })).toEqual({
      width: 1280,
      height: 800,
      scale: 1
    });
    const reduced = agentImageGeometry({ width: 2560, height: 1600 }, { width: 1440, height: 900 });
    expect(reduced.scale).toBeCloseTo(0.5625, 6);
    expect(reduced).toMatchObject({ width: 1440, height: 900 });
  });
});

describe('encoder command line', () => {
  const config: DisplayEncoderConfig = {
    display: ':90',
    geometry: { width: 1280, height: 800 },
    codec: 'avc1',
    framerate: 30,
    crf: 26,
    maxBitrateKbps: 6_000,
    jpegQuality: 5,
    border: { color: '0xF0A32B', thickness: 3 },
    generation: 3
  };

  const pairs = (args: string[]): string[] =>
    args.map((value, index) => `${args[index - 1] ?? ''} ${value}`);

  it('encodes with an infinite gop, no b-frames and a frame-difference gate', () => {
    const args = displayEncoderArguments(config);
    expect(pairs(args)).toContain('-bf 0');
    expect(pairs(args)).toContain('-g 2147483647');
    expect(pairs(args)).toContain('-keyint_min 2147483647');
    expect(pairs(args)).toContain('-video_size 1280x800');
    expect(pairs(args)).toContain('-x264-params repeat-headers=1');
    expect(args.join(' ')).toContain('mpdecimate=hi=1:lo=1:frac=0');
    // Without passthrough the dropped duplicates are re-inserted and the gate does nothing.
    expect(pairs(args)).toContain('-vsync 0');
    expect(args).not.toContain('-fps_mode:v');
    expect(args.join(' ')).toContain('drawbox=x=0:y=0:w=iw:h=ih:color=0xF0A32B:t=3');
    expect(args).not.toContain('-frames:v');
  });

  it('falls back to whole jpeg frames for clients without webcodecs', () => {
    const args = displayEncoderArguments({ ...config, codec: 'jpeg' });
    expect(pairs(args)).toContain('-c:v mjpeg');
    expect(args).not.toContain('libx264');
  });

  it('reports the h264 level the geometry actually needs', () => {
    expect(avcCodecString({ width: 1280, height: 800 }, 30)).toBe('avc1.42E020');
    expect(avcCodecString({ width: 2560, height: 1600 }, 30)).toBe('avc1.42E032');
  });

  it('captures agent stills as a single downscaled frame', () => {
    const args = stillCaptureArguments({
      display: ':90',
      geometry: { width: 2560, height: 1600 },
      image: { width: 1440, height: 900 },
      quality: 3
    });
    expect(pairs(args)).toContain('-frames:v 1');
    expect(args.join(' ')).toContain('scale=1440:900:flags=lanczos');
    expect(args.join(' ')).not.toContain('mpdecimate');
    expect(args.join(' ')).not.toContain('drawbox');
  });
});

class FakeEncoderProcess extends EventEmitter implements DisplayEncoderProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit('exit', null);
    return true;
  }
}

describe('display encoder supervisor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const harness = (clock: () => number) => {
    const spawned: Array<{ args: readonly string[]; child: FakeEncoderProcess }> = [];
    const frames: DisplayStreamFrame[] = [];
    const encoder = new DisplayEncoder({
      executable: '/usr/bin/ffmpeg',
      spawn: (_executable, args) => {
        const child = new FakeEncoderProcess();
        spawned.push({ args, child });
        return child;
      },
      onFrame: (frame) => frames.push(frame),
      clock
    });
    return { encoder, spawned, frames };
  };

  const config: DisplayEncoderConfig = {
    display: ':90',
    geometry: { width: 1280, height: 800 },
    codec: 'avc1',
    framerate: 30,
    crf: 26,
    maxBitrateKbps: 6_000,
    jpegQuality: 5,
    border: null,
    generation: 1
  };

  it('runs one encoder and ignores a repeated identical configuration', () => {
    const { encoder, spawned } = harness(() => 0);
    encoder.apply(config);
    encoder.apply(config);
    expect(spawned).toHaveLength(1);
    expect(encoder.running).toBe(true);
  });

  it('restarts on resize and discards output from the replaced encoder', () => {
    const { encoder, spawned, frames } = harness(() => 0);
    encoder.apply(config);
    const first = spawned[0]!.child;
    encoder.apply({ ...config, geometry: { width: 1440, height: 900 }, generation: 2 });
    expect(spawned).toHaveLength(2);
    expect(first.killed).toBe(true);
    first.stdout.write(Buffer.concat([nal(5, FIRST_SLICE), nal(1, FIRST_SLICE)]));
    spawned[1]!.child.stdout.write(
      Buffer.concat([nal(5, FIRST_SLICE), nal(1, FIRST_SLICE), nal(1, FIRST_SLICE)])
    );
    expect(frames.map((frame) => frame.generation)).toEqual([2, 2]);
    expect(frames.map((frame) => frame.sequence)).toEqual([1, 2]);
    expect(frames[0]?.keyframe).toBe(true);
  });

  it('delivers the keyframe of a completely static desktop', () => {
    vi.useFakeTimers();
    const { encoder, spawned, frames } = harness(() => 0);
    encoder.apply(config);
    spawned[0]!.child.stdout.write(
      Buffer.concat([nal(7, 0x42), nal(8, 0xce), nal(5, FIRST_SLICE)])
    );
    expect(frames).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.keyframe).toBe(true);
  });

  it('rate-limits keyframe requests because ffmpeg can only make an idr by restarting', () => {
    vi.useFakeTimers();
    let now = 0;
    const { encoder, spawned } = harness(() => now);
    encoder.apply(config);
    now = 1_500;
    encoder.requestKeyframe();
    expect(spawned).toHaveLength(2);
    encoder.requestKeyframe();
    encoder.requestKeyframe();
    expect(spawned).toHaveLength(2);
    now = 2_500;
    vi.advanceTimersByTime(1_000);
    expect(spawned).toHaveLength(3);
  });

  it('stops for good when the session stops it', () => {
    vi.useFakeTimers();
    const { encoder, spawned } = harness(() => 0);
    encoder.apply(config);
    encoder.stop();
    expect(encoder.running).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(spawned).toHaveLength(1);
  });

  it('restarts after an unexpected exit', () => {
    vi.useFakeTimers();
    const failures: Error[] = [];
    const spawned: Array<FakeEncoderProcess> = [];
    const encoder = new DisplayEncoder({
      executable: '/usr/bin/ffmpeg',
      spawn: () => {
        const child = new FakeEncoderProcess();
        spawned.push(child);
        return child;
      },
      onFrame: () => undefined,
      onFailure: (error) => failures.push(error),
      clock: () => 0
    });
    encoder.apply(config);
    spawned[0]!.stderr.write('x11grab: bad geometry\n');
    spawned[0]!.emit('exit', 1);
    expect(failures[0]?.message).toContain('x11grab: bad geometry');
    vi.advanceTimersByTime(500);
    expect(spawned).toHaveLength(2);
  });
});
