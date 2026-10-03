import type { DesktopHolder } from '@garden/contracts';

/**
 * Display transport for the private Linux desktop.
 *
 * One long-lived encoder per session, rather than an `ffmpeg -frames:v 1` spawned per frame, whose
 * output is split into H.264 access units (or whole JPEGs on the fallback path) and handed to
 * bounded per-subscriber queues, so a stalled client drops frames instead of growing the runner's
 * heap.
 *
 * Everything here is deliberately free of X11 and process-management side effects except
 * `DisplayEncoder`, which takes its spawn function as a parameter - the parsers, the queue
 * policy and the RandR geometry maths are the parts that have to be right, and they are all
 * directly testable.
 */

export type DisplayCodec = 'avc1' | 'jpeg';

export interface DisplayGeometry {
  width: number;
  height: number;
}

export interface DisplayFrame {
  readonly data: Buffer;
  readonly keyframe: boolean;
}

export interface DisplayStreamFrame extends DisplayFrame {
  readonly sequence: number;
  readonly captureUs: bigint;
  readonly generation: number;
}

/** Binary wire protocol spoken over the desktop WebSocket. JSON payloads travel inside
 *  binary frames so the client has exactly one parse path. */
export const DISPLAY_PROTOCOL = 'garden.display.v1';

export const DisplayMessageType = {
  videoConfig: 0x02,
  videoAccessUnit: 0x10,
  jpegFrame: 0x11
} as const;

const VIDEO_AU_HEADER_BYTES = 18;
const JPEG_HEADER_BYTES = 21;

/** `0x10 [u32 seq][u64 captureUs][u8 flags][u32 generation]` then the Annex-B access unit. */
export const encodeVideoAccessUnit = (frame: DisplayStreamFrame): Buffer => {
  const header = Buffer.alloc(VIDEO_AU_HEADER_BYTES);
  header.writeUInt8(DisplayMessageType.videoAccessUnit, 0);
  header.writeUInt32BE(frame.sequence >>> 0, 1);
  header.writeBigUInt64BE(frame.captureUs, 5);
  header.writeUInt8(frame.keyframe ? 1 : 0, 13);
  header.writeUInt32BE(frame.generation >>> 0, 14);
  return Buffer.concat([header, frame.data]);
};

/** `0x11 [u16 x][u16 y][u16 w][u16 h][u32 generation][u64 captureUs]` then the JPEG.
 *  Phase 1 has no damage rectangles, so every tile is the whole screen. */
export const encodeJpegFrame = (frame: DisplayStreamFrame, geometry: DisplayGeometry): Buffer => {
  const header = Buffer.alloc(JPEG_HEADER_BYTES);
  header.writeUInt8(DisplayMessageType.jpegFrame, 0);
  header.writeUInt16BE(0, 1);
  header.writeUInt16BE(0, 3);
  header.writeUInt16BE(Math.min(0xffff, geometry.width), 5);
  header.writeUInt16BE(Math.min(0xffff, geometry.height), 7);
  header.writeUInt32BE(frame.generation >>> 0, 9);
  header.writeBigUInt64BE(frame.captureUs, 13);
  return Buffer.concat([header, frame.data]);
};

export interface DisplayVideoConfig {
  codec: string;
  format: 'annexb' | 'jpeg';
  width: number;
  height: number;
  framerate: number;
  generation: number;
}

export const encodeVideoConfig = (config: DisplayVideoConfig): Buffer =>
  Buffer.concat([
    Buffer.from([DisplayMessageType.videoConfig]),
    Buffer.from(JSON.stringify(config), 'utf8')
  ]);

/** Reads back a header this module wrote; the browser client mirrors this decoder. */
export const decodeDisplayMessage = (
  message: Buffer
): {
  type: number;
  sequence: number;
  captureUs: bigint;
  keyframe: boolean;
  generation: number;
  payload: Buffer;
} => {
  const type = message.readUInt8(0);
  if (type === DisplayMessageType.videoAccessUnit)
    return {
      type,
      sequence: message.readUInt32BE(1),
      captureUs: message.readBigUInt64BE(5),
      keyframe: message.readUInt8(13) === 1,
      generation: message.readUInt32BE(14),
      payload: message.subarray(VIDEO_AU_HEADER_BYTES)
    };
  if (type === DisplayMessageType.jpegFrame)
    return {
      type,
      sequence: 0,
      captureUs: message.readBigUInt64BE(13),
      keyframe: true,
      generation: message.readUInt32BE(9),
      payload: message.subarray(JPEG_HEADER_BYTES)
    };
  return {
    type,
    sequence: 0,
    captureUs: 0n,
    keyframe: false,
    generation: 0,
    payload: message.subarray(1)
  };
};

const startCodeLength = (nal: Buffer): number => (nal.length > 2 && nal[2] === 1 ? 3 : 4);

const findStartCode = (buffer: Buffer, from: number): number => {
  for (let index = Math.max(0, from); index + 2 < buffer.length; index += 1)
    if (buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 1)
      return index > 0 && buffer[index - 1] === 0 ? index - 1 : index;
  return -1;
};

/**
 * Splits a raw Annex-B byte stream into access units.
 *
 * ffmpeg writes one access unit per `write()`, but a pipe read can split or coalesce those
 * writes arbitrarily, so boundaries have to come from the bitstream itself: an access unit
 * ends when a NAL arrives that can only begin the next one (AUD/SPS/SEI, or a slice whose
 * `first_mb_in_slice` is zero). That costs one frame of latency - the unit is only released
 * once the following unit starts - which is the price of driving ffmpeg instead of libx264
 * directly, and it disappears with the Rust `displayd` of the design's phase 2.
 */
export class AnnexBAccessUnitReader {
  #buffer: Buffer = Buffer.alloc(0);
  #searchFrom = 0;
  #synchronised = false;
  #unit: Buffer[] = [];
  #hasSlice = false;
  #keyframe = false;
  #headNalType = -1;

  push(chunk: Buffer): DisplayFrame[] {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const frames: DisplayFrame[] = [];
    if (!this.#synchronised) {
      const first = findStartCode(this.#buffer, 0);
      if (first < 0) {
        this.#buffer = this.#buffer.subarray(Math.max(0, this.#buffer.length - 3));
        return frames;
      }
      this.#buffer = this.#buffer.subarray(first);
      this.#synchronised = true;
      this.#searchFrom = startCodeLength(this.#buffer);
    }
    for (;;) {
      // The boundary decision needs only the next NAL's two header bytes, so it is made as
      // soon as they arrive. Waiting for the whole NAL would leave the finished access unit
      // sitting in the buffer for an extra frame.
      if (this.#headNalType < 0) {
        const header = startCodeLength(this.#buffer);
        const type = this.#buffer[header];
        const slice = this.#buffer[header + 1];
        if (type === undefined || slice === undefined) break;
        this.#headNalType = type & 0x1f;
        if (this.#startsNewUnit(this.#headNalType, (slice & 0x80) !== 0)) {
          const completed = this.#flushUnit();
          if (completed) frames.push(completed);
        }
      }
      const boundary = findStartCode(this.#buffer, this.#searchFrom);
      if (boundary < 0) {
        this.#searchFrom = Math.max(startCodeLength(this.#buffer), this.#buffer.length - 3);
        break;
      }
      this.#unit.push(this.#buffer.subarray(0, boundary));
      if (this.#headNalType === 1 || this.#headNalType === 5) this.#hasSlice = true;
      if (this.#headNalType === 5) this.#keyframe = true;
      this.#buffer = this.#buffer.subarray(boundary);
      this.#headNalType = -1;
      this.#searchFrom = startCodeLength(this.#buffer);
    }
    return frames;
  }

  /**
   * Releases the access unit that is still waiting for its successor.
   *
   * An access unit is normally closed by the start of the next one, but a difference-gated
   * encoder watching a still desktop produces exactly one unit and then nothing at all - so a
   * client joining a static screen would wait forever for its first keyframe. The caller
   * arms this only after the pipe has been quiet long enough that a half-written unit is not
   * a credible explanation for the silence.
   */
  flushPending(): DisplayFrame | null {
    if (this.#headNalType >= 0 && this.#buffer.length > startCodeLength(this.#buffer)) {
      this.#unit.push(this.#buffer);
      if (this.#headNalType === 1 || this.#headNalType === 5) this.#hasSlice = true;
      if (this.#headNalType === 5) this.#keyframe = true;
    }
    this.#buffer = Buffer.alloc(0);
    this.#searchFrom = 0;
    this.#synchronised = false;
    this.#headNalType = -1;
    // Parameter sets on their own are not a picture; keep them for the unit that follows.
    if (!this.#hasSlice) return null;
    return this.#flushUnit();
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
    this.#searchFrom = 0;
    this.#synchronised = false;
    this.#unit = [];
    this.#hasSlice = false;
    this.#keyframe = false;
    this.#headNalType = -1;
  }

  #startsNewUnit(type: number, firstMacroblockIsZero: boolean): boolean {
    if (!this.#hasSlice) return false;
    if (type === 9 || type === 7 || type === 6) return true;
    return (type === 1 || type === 5) && firstMacroblockIsZero;
  }

  #flushUnit(): DisplayFrame | null {
    if (!this.#unit.length) return null;
    const frame: DisplayFrame = { data: Buffer.concat(this.#unit), keyframe: this.#keyframe };
    this.#unit = [];
    this.#hasSlice = false;
    this.#keyframe = false;
    return frame;
  }
}

/** Splits a concatenated MJPEG pipe into whole JPEGs. Entropy-coded data is byte-stuffed,
 *  so FFD9 only ever appears as the end-of-image marker. */
export class JpegFrameReader {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DisplayFrame[] {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const frames: DisplayFrame[] = [];
    for (;;) {
      const start = this.#buffer.indexOf('ffd8', 0, 'hex');
      if (start < 0) {
        this.#buffer = this.#buffer.subarray(Math.max(0, this.#buffer.length - 1));
        break;
      }
      const end = this.#buffer.indexOf('ffd9', start + 2, 'hex');
      if (end < 0) {
        this.#buffer = this.#buffer.subarray(start);
        break;
      }
      frames.push({ data: this.#buffer.subarray(start, end + 2), keyframe: true });
      this.#buffer = this.#buffer.subarray(end + 2);
    }
    return frames;
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
  }
}

/**
 * Per-subscriber bounded ring.
 *
 * A keyframe supersedes everything pending, so it clears the queue. Dropping a delta strands
 * the decoder until the next keyframe, so once one is dropped the queue refuses further
 * deltas and reports `starved` - the session turns that into a keyframe request instead of
 * shipping frames the client cannot decode.
 */
export class DisplayFrameQueue {
  readonly #frames: DisplayStreamFrame[] = [];
  #dropped = 0;
  #starved = false;

  constructor(private readonly capacity: number = 3) {}

  push(frame: DisplayStreamFrame): void {
    if (frame.keyframe) {
      this.#frames.length = 0;
      this.#frames.push(frame);
      this.#starved = false;
      return;
    }
    if (this.#starved || this.#frames.length >= this.capacity) {
      this.#dropped += 1;
      this.#starved = true;
      return;
    }
    this.#frames.push(frame);
  }

  shift(): DisplayStreamFrame | undefined {
    return this.#frames.shift();
  }

  clear(): void {
    this.#frames.length = 0;
  }

  get size(): number {
    return this.#frames.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  /** True when a delta was dropped and only a fresh keyframe can restore the client. */
  get starved(): boolean {
    return this.#starved;
  }
}

export const HOLDER_BORDER_COLORS: Readonly<Record<DesktopHolder, string>> = {
  agent: '0xF0A32B',
  user: '0x3DD8C4',
  secure_input: '0xE5484D'
};

export const align16 = (value: number): number => Math.max(16, Math.floor(value / 16) * 16);

const align2 = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

export interface DisplayViewport {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  mode: 'native' | 'css';
}

export interface DisplayGeometryLimits {
  /** Xvfb's boot size: RandR cannot exceed it, ever. */
  ceiling: DisplayGeometry;
  /** Policy cap, so an ultrawide client does not ask for a 3440-wide encode. */
  maximum: DisplayGeometry;
  minimum: DisplayGeometry;
}

/** Client viewport -> a display size H.264 can encode: dpr applied, aligned to macroblocks,
 *  clamped to both the policy cap and Xvfb's immovable boot ceiling. */
export const resolveTargetGeometry = (
  viewport: DisplayViewport,
  limits: DisplayGeometryLimits
): DisplayGeometry => {
  const ratio =
    viewport.mode === 'native' ? Math.min(Math.max(viewport.devicePixelRatio, 1), 2) : 1;
  const width = align16(
    Math.min(
      Math.max(viewport.cssWidth * ratio, limits.minimum.width),
      limits.maximum.width,
      limits.ceiling.width
    )
  );
  const height = align16(
    Math.min(
      Math.max(viewport.cssHeight * ratio, limits.minimum.height),
      limits.maximum.height,
      limits.ceiling.height
    )
  );
  return { width, height };
};

/** Dragging a browser window emits dozens of resize events a second and each RandR change
 *  relayouts every window and forces a keyframe, so ignore anything inside a 2% band. */
export const shouldApplyGeometry = (
  current: DisplayGeometry,
  target: DisplayGeometry,
  tolerance = 0.02
): boolean => {
  if (current.width === target.width && current.height === target.height) return false;
  return (
    Math.abs(target.width - current.width) / current.width >= tolerance ||
    Math.abs(target.height - current.height) / current.height >= tolerance
  );
};

export interface RandrState {
  output: string;
  current: DisplayGeometry;
  maximum: DisplayGeometry;
  gardenModes: string[];
}

export const GARDEN_MODE_PREFIX = 'garden-';

export const displayModeName = (geometry: DisplayGeometry): string =>
  `${GARDEN_MODE_PREFIX}${geometry.width}x${geometry.height}`;

export const parseRandrState = (output: string): RandrState | null => {
  const screen = /current\s+(\d+)\s*x\s*(\d+),\s*maximum\s+(\d+)\s*x\s*(\d+)/.exec(output);
  const connected = /^(\S+)\s+connected/m.exec(output);
  if (!screen || !connected) return null;
  const modes = [...output.matchAll(/^\s+(garden-\d+x\d+)\s/gm)].map((match) => match[1] ?? '');
  return {
    output: connected[1] ?? 'screen',
    current: { width: Number(screen[1]), height: Number(screen[2]) },
    maximum: { width: Number(screen[3]), height: Number(screen[4]) },
    gardenModes: modes.filter(Boolean)
  };
};

export interface DisplayMode {
  name: string;
  clockMhz: number;
  horizontal: [number, number, number, number];
  vertical: [number, number, number, number];
  flags: string[];
}

const CVT_RB_MIN_VBLANK_US = 460;
const CVT_RB_H_BLANK = 160;
const CVT_RB_H_SYNC = 32;
const CVT_RB_V_FRONT_PORCH = 3;
const CVT_MIN_V_BACK_PORCH = 6;
const CVT_CLOCK_STEP_KHZ = 250;

const verticalSyncWidth = (width: number, height: number): number => {
  if (height % 3 === 0 && (height * 4) / 3 === width) return 4;
  if (height % 9 === 0 && (height * 16) / 9 === width) return 5;
  if (height % 10 === 0 && (height * 16) / 10 === width) return 6;
  if (height % 4 === 0 && (height * 5) / 4 === width) return 7;
  if (height % 9 === 0 && (height * 15) / 9 === width) return 7;
  return 10;
};

/**
 * CVT 1.2 reduced-blanking timings, matching `cvt -r`.
 *
 * Xvfb never scans anything out so the timings are fictional, but `xrandr --newmode` still
 * validates the modeline it is handed, so it has to be arithmetically coherent.
 */
export const cvtReducedBlankingMode = (
  width: number,
  height: number,
  refreshHz = 60
): DisplayMode => {
  const horizontalPixels = Math.max(8, Math.round(width / 8) * 8);
  const lines = Math.max(1, Math.round(height));
  const horizontalPeriodUs = (1_000_000 / refreshHz - CVT_RB_MIN_VBLANK_US) / lines;
  const sync = verticalSyncWidth(horizontalPixels, lines);
  const blankingLines = Math.max(
    Math.ceil(CVT_RB_MIN_VBLANK_US / horizontalPeriodUs),
    CVT_RB_V_FRONT_PORCH + sync + CVT_MIN_V_BACK_PORCH
  );
  const horizontalTotal = horizontalPixels + CVT_RB_H_BLANK;
  const clockKhz =
    Math.round((horizontalTotal * 1000) / horizontalPeriodUs / CVT_CLOCK_STEP_KHZ) *
    CVT_CLOCK_STEP_KHZ;
  const syncStart = horizontalPixels + CVT_RB_H_BLANK / 2 - CVT_RB_H_SYNC;
  return {
    name: displayModeName({ width, height }),
    clockMhz: clockKhz / 1000,
    horizontal: [horizontalPixels, syncStart, syncStart + CVT_RB_H_SYNC, horizontalTotal],
    vertical: [
      lines,
      lines + CVT_RB_V_FRONT_PORCH,
      lines + CVT_RB_V_FRONT_PORCH + sync,
      lines + blankingLines
    ],
    flags: ['+hsync', '-vsync']
  };
};

export const newModeArguments = (mode: DisplayMode): string[] => [
  '--newmode',
  mode.name,
  mode.clockMhz.toFixed(2),
  ...mode.horizontal.map(String),
  ...mode.vertical.map(String),
  ...mode.flags
];

const AVC_LEVELS: ReadonlyArray<{
  level: number;
  macroblocks: number;
  macroblocksPerSecond: number;
}> = [
  { level: 0x1e, macroblocks: 1620, macroblocksPerSecond: 40_500 },
  { level: 0x1f, macroblocks: 3600, macroblocksPerSecond: 108_000 },
  { level: 0x20, macroblocks: 5120, macroblocksPerSecond: 216_000 },
  { level: 0x28, macroblocks: 8192, macroblocksPerSecond: 245_760 },
  { level: 0x2a, macroblocks: 8704, macroblocksPerSecond: 522_240 },
  { level: 0x32, macroblocks: 22_080, macroblocksPerSecond: 589_824 },
  { level: 0x33, macroblocks: 36_864, macroblocksPerSecond: 983_040 },
  { level: 0x34, macroblocks: 36_864, macroblocksPerSecond: 2_073_600 }
];

/** Constrained-baseline codec string with the level the geometry actually needs; the client
 *  hands this straight to `VideoDecoder.configure`. */
export const avcCodecString = (geometry: DisplayGeometry, framerate: number): string => {
  const macroblocks = Math.ceil(geometry.width / 16) * Math.ceil(geometry.height / 16);
  const perSecond = macroblocks * framerate;
  const chosen =
    AVC_LEVELS.find(
      (candidate) =>
        macroblocks <= candidate.macroblocks && perSecond <= candidate.macroblocksPerSecond
    ) ?? AVC_LEVELS[AVC_LEVELS.length - 1];
  const level = chosen?.level ?? 0x34;
  return `avc1.42E0${level.toString(16).toUpperCase().padStart(2, '0')}`;
};

export interface DisplayEncoderConfig {
  display: string;
  geometry: DisplayGeometry;
  codec: DisplayCodec;
  framerate: number;
  crf: number;
  maxBitrateKbps: number;
  jpegQuality: number;
  /** Burned-in control indicator, so who holds the desktop is visible even to a client that
   *  has not implemented the overlay. */
  border: { color: string; thickness: number } | null;
  generation: number;
}

const INFINITE_GOP = '2147483647';

export const displayEncoderArguments = (config: DisplayEncoderConfig): string[] => {
  const filters = [
    // Frame-difference gate: identical frames never reach the encoder, so an idle desktop
    // costs no bitrate and almost no CPU. Real XDamage gating arrives with displayd.
    'mpdecimate=hi=1:lo=1:frac=0'
  ];
  if (config.border)
    filters.push(
      `drawbox=x=0:y=0:w=iw:h=ih:color=${config.border.color}:t=${config.border.thickness}`
    );
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'x11grab',
    '-draw_mouse',
    '1',
    '-framerate',
    String(config.framerate),
    '-video_size',
    `${config.geometry.width}x${config.geometry.height}`,
    '-i',
    config.display,
    '-vf',
    filters.join(','),
    // Passthrough, or ffmpeg re-duplicates exactly the frames mpdecimate just removed. Spelt
    // '-vsync' rather than '-fps_mode' because Ubuntu 22.04 still ships ffmpeg 4.4, which has
    // no '-fps_mode'; the deprecation notice newer builds print is below our log level.
    '-vsync',
    '0'
  ];
  if (config.codec === 'jpeg')
    return [
      ...args,
      '-c:v',
      'mjpeg',
      '-pix_fmt',
      'yuvj420p',
      '-q:v',
      String(config.jpegQuality),
      '-f',
      'image2pipe',
      'pipe:1'
    ];
  return [
    ...args,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-profile:v',
    'baseline',
    '-pix_fmt',
    'yuv420p',
    '-bf',
    '0',
    // Infinite GOP: keyframes are produced on demand (join, resize, decoder starvation) by
    // restarting the encoder, never on a timer - a periodic IDR is pure bandwidth on a
    // reliable transport.
    '-g',
    INFINITE_GOP,
    '-keyint_min',
    INFINITE_GOP,
    '-sc_threshold',
    '0',
    '-crf',
    String(config.crf),
    '-maxrate',
    `${config.maxBitrateKbps}k`,
    '-bufsize',
    `${config.maxBitrateKbps}k`,
    // SPS/PPS before every IDR, or a client that joins mid-stream has no parameter sets.
    '-x264-params',
    'repeat-headers=1',
    '-f',
    'h264',
    'pipe:1'
  ];
};

export interface StillCaptureRequest {
  display: string;
  geometry: DisplayGeometry;
  image: DisplayGeometry;
  quality: number;
  /**
   * A region of the display to capture instead of the whole of it, in display pixels.
   *
   * The agent's still is reduced to fit a bounded image, so a small control arrives a few pixels
   * across and a model asked to click it is guessing. Cropping to the region and sending those
   * pixels at full size is the cheapest accuracy there is on this surface - it is the same
   * screenshot path with two more ffmpeg arguments, and the measured gain on small targets is the
   * largest single improvement available here.
   *
   * "At full size" holds only while the region fits `image`; a region larger than that is reduced
   * into it, for the reason written below.
   */
  region?: { x: number; y: number; width: number; height: number };
}

export const prepareStillCapture = (
  request: StillCaptureRequest
): { args: string[]; region: StillCaptureRequest['region'] } => {
  let region: StillCaptureRequest['region'];
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'x11grab',
    '-draw_mouse',
    '1',
    '-video_size',
    `${request.geometry.width}x${request.geometry.height}`,
    '-i',
    request.display,
    '-frames:v',
    '1'
  ];
  if (request.region) {
    // Clamped to the display rather than trusted: x11grab fails outright on a rectangle that runs
    // off the screen, and a region a pixel too wide would turn a zoom into a broken capture.
    const width = Math.max(16, Math.min(request.region.width, request.geometry.width));
    const height = Math.max(16, Math.min(request.region.height, request.geometry.height));
    const x = Math.max(0, Math.min(request.region.x, request.geometry.width - width));
    const y = Math.max(0, Math.min(request.region.y, request.geometry.height - height));
    region = { x, y, width, height };
    /*
     * And bounded at the far end too, which the clamp above does not do. Without `scale=` here a
     * zoom of the whole of a 2560x1600 display would come back at 4.1 megapixels - three times the
     * 1440x900 box the full screenshot of that same display is reduced into, and a "closer look"
     * that is larger than the picture it was supposed to be a closer look at.
     *
     * Nothing was bought with those pixels. `CONVERTED_IMAGE_MAX_SIDE` in `images.ts` writes the
     * same rule down for every other picture this runner sends a model: past about 1568 on the
     * long side an image is resampled to about that size at the far end regardless, so the only
     * question the extra pixels settle is which machine pays to carry them.
     *
     * A region that already fits is cropped and never scaled, which is the entire point of a zoom:
     * this bound only ever fires on a rectangle asking for more than a whole screenshot's worth.
     */
    const bound = agentImageGeometry({ width, height }, request.image);
    const crop = `crop=${width}:${height}:${x}:${y}`;
    args.push(
      '-vf',
      bound.scale < 1 ? `${crop},scale=${bound.width}:${bound.height}:flags=lanczos` : crop
    );
  } else if (
    request.image.width !== request.geometry.width ||
    request.image.height !== request.geometry.height
  )
    args.push('-vf', `scale=${request.image.width}:${request.image.height}:flags=lanczos`);
  return {
    region,
    args: [
      ...args,
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-pix_fmt',
      'yuvj420p',
      '-q:v',
      String(request.quality),
      'pipe:1'
    ]
  };
};

export const stillCaptureArguments = (request: StillCaptureRequest): string[] =>
  prepareStillCapture(request).args;

export interface AgentImage extends DisplayGeometry {
  /** Uniform factor the display was reduced by; 1 when the display already fits. */
  scale: number;
}

/**
 * The agent works in image space and the display in display pixels. Bounding the image to
 * the coordinate space the action contract accepts keeps a single unambiguous rule - the
 * agent's coordinates always mean "pixels in the screenshot I was given" - and the runner,
 * never the model, does the arithmetic.
 */
export const agentImageGeometry = (
  geometry: DisplayGeometry,
  limits: DisplayGeometry
): AgentImage => {
  const scale = Math.min(1, limits.width / geometry.width, limits.height / geometry.height);
  if (scale >= 1) return { width: geometry.width, height: geometry.height, scale: 1 };
  return {
    width: align2(geometry.width * scale),
    height: align2(geometry.height * scale),
    scale
  };
};

export interface DisplayEncoderProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  /**
   * Declared because node emits it and the supervisor has to be listening.
   *
   * `spawn` does not throw when the executable is missing - it returns a child and reports ENOENT
   * asynchronously on `'error'` - so the `try` around the spawn call catches nothing, and an
   * `'error'` with no listener is the one event node re-raises as an uncaught exception. On a host
   * without `/usr/bin/ffmpeg` the first viewer to open the Computer pane therefore took the whole
   * runner process down, killing every command, terminal and turn on the box, because a video
   * encoder was not installed.
   */
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type DisplayEncoderSpawn = (
  executable: string,
  args: readonly string[]
) => DisplayEncoderProcess;

export interface DisplayEncoderOptions {
  executable: string;
  spawn: DisplayEncoderSpawn;
  onFrame: (frame: DisplayStreamFrame) => void;
  onFailure?: (error: Error) => void;
  clock?: () => number;
  /** ffmpeg cannot emit an IDR on demand, so a keyframe request is an encoder restart.
   *  Rate-limit it or a congested client restarts the encoder continuously. */
  minRestartIntervalMs?: number;
  /** First wait after a failure. Each consecutive failure doubles it, up to `maxRestartDelayMs`. */
  restartDelayMs?: number;
  /**
   * The ceiling that wait backs off to.
   *
   * A failure that will not clear - no ffmpeg on the host, a display that is gone - would otherwise
   * be retried twice a second for as long as anybody was watching, each attempt spawning a process
   * and writing a line. Backing off means a transient failure still recovers within a frame or
   * two and a permanent one costs a poll a minute instead of a hundred and twenty.
   */
  maxRestartDelayMs?: number;
  /** Quiet period after which a still-pending access unit is released anyway. */
  idleFlushMs?: number;
}

const configKey = (config: DisplayEncoderConfig): string =>
  JSON.stringify([
    config.display,
    config.geometry.width,
    config.geometry.height,
    config.codec,
    config.framerate,
    config.crf,
    config.maxBitrateKbps,
    config.jpegQuality,
    config.border?.color ?? null,
    config.border?.thickness ?? null,
    config.generation
  ]);

/** Supervises the single long-lived ffmpeg per session: start, restart on reconfiguration or
 *  keyframe request, and restart after an unexpected exit. */
export class DisplayEncoder {
  #config: DisplayEncoderConfig | null = null;
  #child: DisplayEncoderProcess | null = null;
  #token = 0;
  #sequence = 0;
  #annexB = new AnnexBAccessUnitReader();
  #jpeg = new JpegFrameReader();
  #startedAt = 0;
  #keyframeTimer: NodeJS.Timeout | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  /** Consecutive failures with no frame in between; reset by the first frame that arrives. */
  #failures = 0;

  constructor(private readonly options: DisplayEncoderOptions) {}

  get running(): boolean {
    return this.#child !== null;
  }

  get config(): DisplayEncoderConfig | null {
    return this.#config;
  }

  /** Starts the encoder, or restarts it when anything the command line depends on changed. */
  apply(config: DisplayEncoderConfig): void {
    if (this.#child && this.#config && configKey(this.#config) === configKey(config)) return;
    this.#config = config;
    this.#spawn();
  }

  stop(): void {
    this.#config = null;
    // Nobody is watching, so the next `apply` is a fresh start rather than a continuation of
    // whatever was failing when the last viewer left.
    this.#failures = 0;
    this.#clearTimers();
    this.#kill();
  }

  /** How long the next restart waits, in the ms the caller configured. */
  get retryDelayMs(): number {
    const base = this.options.restartDelayMs ?? 500;
    const ceiling = this.options.maxRestartDelayMs ?? 30_000;
    return Math.min(ceiling, base * 2 ** Math.max(0, this.#failures - 1));
  }

  requestKeyframe(): void {
    if (!this.#config || this.#keyframeTimer) return;
    const interval = this.options.minRestartIntervalMs ?? 1_000;
    const elapsed = this.#now() - this.#startedAt;
    if (elapsed >= interval) {
      this.#spawn();
      return;
    }
    this.#keyframeTimer = setTimeout(() => {
      this.#keyframeTimer = undefined;
      if (this.#config) this.#spawn();
    }, interval - elapsed);
    this.#keyframeTimer.unref();
  }

  #now(): number {
    return (this.options.clock ?? Date.now)();
  }

  #clearTimers(): void {
    if (this.#keyframeTimer) clearTimeout(this.#keyframeTimer);
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#keyframeTimer = undefined;
    this.#restartTimer = undefined;
  }

  #kill(): void {
    const child = this.#child;
    this.#child = null;
    this.#token += 1;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    if (child) child.kill('SIGKILL');
  }

  #emit(config: DisplayEncoderConfig, frames: readonly DisplayFrame[]): void {
    const captureUs = BigInt(Math.round(this.#now())) * 1000n;
    // A frame is the only evidence the encoder is working, so it is what clears the backoff. An
    // encoder that starts, emits and then dies is a transient failure and gets the short wait
    // again; one that dies before producing anything keeps doubling.
    if (frames.length > 0) this.#failures = 0;
    for (const frame of frames) {
      this.#sequence += 1;
      this.options.onFrame({
        data: frame.data,
        keyframe: frame.keyframe,
        sequence: this.#sequence,
        captureUs,
        generation: config.generation
      });
    }
  }

  #spawn(): void {
    const config = this.#config;
    if (!config) return;
    this.#kill();
    this.#annexB.reset();
    this.#jpeg.reset();
    this.#startedAt = this.#now();
    const token = this.#token;
    let child: DisplayEncoderProcess;
    try {
      child = this.options.spawn(this.options.executable, displayEncoderArguments(config));
    } catch (cause) {
      this.options.onFailure?.(cause instanceof Error ? cause : new Error('Encoder failed'));
      return;
    }
    this.#child = child;
    // Attached before anything else can be, because `'error'` may already be queued: node reports
    // a missing executable asynchronously, and an `'error'` with no listener is re-raised as an
    // uncaught exception that ends the process.
    child.on('error', (cause: Error) => {
      if (token !== this.#token) return;
      this.#child = null;
      this.#fail(cause);
    });
    let diagnostics = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-2_048);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (token !== this.#token) return;
      if (config.codec === 'jpeg') {
        this.#emit(config, this.#jpeg.push(chunk));
        return;
      }
      this.#emit(config, this.#annexB.push(chunk));
      if (this.#idleTimer) clearTimeout(this.#idleTimer);
      this.#idleTimer = setTimeout(() => {
        this.#idleTimer = undefined;
        if (token !== this.#token) return;
        const pending = this.#annexB.flushPending();
        if (pending) this.#emit(config, [pending]);
      }, this.options.idleFlushMs ?? 120);
      this.#idleTimer.unref();
    });
    child.on('exit', (code) => {
      if (token !== this.#token) return;
      this.#child = null;
      this.#fail(
        new Error(
          `Desktop encoder exited with ${code ?? 'signal'}${diagnostics ? `: ${diagnostics.trim()}` : ''}`
        )
      );
    });
  }

  /**
   * Reports one failure and schedules the retry, for both the ways an encoder can fail.
   *
   * Shared so a child that never started is handled exactly like one that died: the caller hears
   * about it, and the wait before the next attempt grows while the failures keep coming.
   */
  #fail(cause: Error): void {
    if (!this.#config) return;
    this.#failures += 1;
    this.options.onFailure?.(cause);
    if (this.#restartTimer) return;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (this.#config) this.#spawn();
    }, this.retryDelayMs);
    this.#restartTimer.unref();
  }
}
