import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { AUDIO_READ_MAX_SECONDS } from '@garden/contracts';
import { hostSearchPath } from './execution.js';
import { resolveExecutable } from './command-policy.js';
import { assertOpenedInPlace, resolveInside, WorkspaceFileError } from './files.js';
import { awaitChildExit, killProcessTree } from './subprocess.js';

/**
 * What a recording on this computer actually is, and a bounded, uploadable slice of it.
 *
 * Nothing here transcribes anything. This is the half of listening that belongs on the owner's own
 * machine: what the file is, how long it runs, and one window of it re-encoded small enough to
 * cross a wire. The provider call happens in the worker, on bytes that were already cut to the
 * length the owner is about to be billed for - which is the only order that lets the cost be stated
 * before it is incurred rather than after.
 */

/**
 * The upload ceiling, well under what a transcription endpoint will take. At the bitrate below a
 * full window weighs about eleven megabytes, so reaching this means the encode went wrong rather
 * than that the recording was long, and a refusal is the honest answer.
 */
const MAX_PREPARED_BYTES = 24 * 1024 * 1024;

const PROBE_TIMEOUT_MS = 30_000;

/** Generous: a ninety-minute window is re-encoded far faster than real time, but not instantly. */
const ENCODE_TIMEOUT_MS = 15 * 60_000;

export const AUDIO_SOURCE_MAX_BYTES = 8 * 1024 * 1024 * 1024;
export const AUDIO_SOURCE_HASH_TIMEOUT_MS = 60_000;

/** Only the inherited recording may be read, including by demuxers that follow references. */
export const audioInputOptions = (): string[] => ['-protocol_whitelist', 'fd', '-fd', '3'];

export interface AudioSourceReceipt {
  sourceSha256: string;
  sourceBytes: number;
}

const sameSource = (before: BigIntStats, after: BigIntStats): boolean =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs;

const sourceChanged = () =>
  new WorkspaceFileError('The recording changed after inspection; review its source again', 409);

/** Hash the held original, never a re-encoded container whose metadata can vary between runs. */
const hashAudioSource = async (
  handle: FileHandle,
  signal?: AbortSignal
): Promise<{ receipt: AudioSourceReceipt; identity: BigIntStats }> => {
  signal?.throwIfAborted();
  const identity = await handle.stat({ bigint: true });
  if (!identity.isFile()) throw new WorkspaceFileError('That path is not a regular file', 400);
  if (identity.size <= 0n || identity.size > BigInt(AUDIO_SOURCE_MAX_BYTES))
    throw new WorkspaceFileError(
      'Choose a nonempty recording within the source inspection limit; create a local clip of a larger source',
      413
    );
  const started = performance.now();
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const size = Number(identity.size);
  let position = 0;
  while (position < size) {
    signal?.throwIfAborted();
    if (performance.now() - started >= AUDIO_SOURCE_HASH_TIMEOUT_MS)
      throw new WorkspaceFileError('Source inspection timed out; create a smaller local clip', 408);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position
    );
    if (!bytesRead) throw sourceChanged();
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  signal?.throwIfAborted();
  if (performance.now() - started >= AUDIO_SOURCE_HASH_TIMEOUT_MS)
    throw new WorkspaceFileError('Source inspection timed out; create a smaller local clip', 408);
  if (!sameSource(identity, await handle.stat({ bigint: true }))) throw sourceChanged();
  return { receipt: { sourceSha256: hash.digest('hex'), sourceBytes: size }, identity };
};

export const inspectAudioSource = async (
  root: string,
  requested: string,
  signal?: AbortSignal
): Promise<AudioSourceReceipt> => {
  const target = resolveInside(root, requested);
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    await assertOpenedInPlace(root, target, handle);
    const { receipt } = await hashAudioSource(handle, signal);
    await assertOpenedInPlace(root, target, handle);
    return receipt;
  } finally {
    await handle.close();
  }
};

export interface AudioSource {
  /** Absent when the container declares no duration, which a stream-copied recording can do. */
  durationSeconds: number | null;
  container: string | null;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  /** False when the file has no audio stream at all, which is the one refusal worth its own words. */
  hasAudio: boolean;
}

export interface PreparedAudio {
  bytes: Buffer;
  /** The container the bytes are in, in the vocabulary a transcription request uses. */
  format: 'ogg';
  source: AudioSource;
  startSeconds: number;
  /** What was actually cut, measured from the encoder's own output rather than from the request. */
  preparedSeconds: number;
  /** True when the recording continues past this window, so the caller can say where to resume. */
  more: boolean;
  sourceReceipt?: AudioSourceReceipt;
}

/**
 * ffprobe's JSON, read for the five facts that decide anything.
 *
 * Split out from the call so the parsing is testable without a media file: every field here is
 * optional in the real output - a stream-copied recording declares no duration, a raw stream
 * declares no container - and the difference between "no audio track" and "a track ffprobe could
 * not measure" is the difference between refusing and carrying on.
 */
export const parseAudioProbe = (json: string): AudioSource => {
  const parsed = JSON.parse(json) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      duration?: string;
    }>;
  };
  const track = (parsed.streams ?? []).find((stream) => stream.codec_type === 'audio');
  const number = (value: string | number | undefined): number | null => {
    const parsedValue = typeof value === 'string' ? Number.parseFloat(value) : value;
    return typeof parsedValue === 'number' && Number.isFinite(parsedValue) && parsedValue > 0
      ? parsedValue
      : null;
  };
  return {
    durationSeconds: number(parsed.format?.duration) ?? number(track?.duration),
    container: parsed.format?.format_name ?? null,
    codec: track?.codec_name ?? null,
    sampleRate: number(track?.sample_rate),
    channels: track?.channels ?? null,
    hasAudio: track !== undefined
  };
};

/**
 * The window this call will prepare, from what was asked and what the file holds.
 *
 * A request for more than the ceiling is cut to it rather than refused: a two-hour recording is a
 * normal thing for an owner to point at, and the useful answer is the first ninety minutes plus the
 * sentence saying where the rest starts. An end before the start is the same as no end at all.
 */
export const audioWindow = (
  requested: { startSeconds?: number | undefined; endSeconds?: number | undefined },
  durationSeconds: number | null
): { startSeconds: number; seconds: number } => {
  const start = Math.max(0, Math.floor(requested.startSeconds ?? 0));
  const remaining = durationSeconds === null ? null : Math.max(0, durationSeconds - start);
  const asked =
    requested.endSeconds !== undefined && requested.endSeconds > start
      ? Math.floor(requested.endSeconds) - start
      : (remaining ?? AUDIO_READ_MAX_SECONDS);
  return {
    startSeconds: start,
    seconds: Math.min(AUDIO_READ_MAX_SECONDS, Math.max(1, Math.ceil(asked)))
  };
};

/**
 * Mono, sixteen kilohertz, sixteen kilobits of Opus.
 *
 * Speech recognition resamples to sixteen kilohertz and mixes to mono whatever it is handed, so
 * sending a stereo forty-eight kilohertz phone recording ships several times the bytes for a
 * transcript that cannot differ. Opus is the codec every freely-licensed ffmpeg build carries -
 * which matters, because the distribution table offers `ffmpeg-free` on one of the four families
 * garden installs on - and Ogg is a container the transcription request already names.
 *
 * `-ss` before `-i` seeks the input rather than decoding and discarding everything before the mark,
 * which is the difference between a few seconds and several minutes on an hour-long file. `-vn`
 * with an explicit audio map is what makes the audio track of a screen recording work: the video is
 * simply not read.
 */
export const encodeArguments = (input: { startSeconds: number; seconds: number }): string[] => [
  '-nostdin',
  '-v',
  'error',
  '-ss',
  String(input.startSeconds),
  ...audioInputOptions(),
  '-i',
  'fd:',
  '-t',
  String(input.seconds),
  '-vn',
  '-map',
  '0:a:0',
  '-ac',
  '1',
  '-ar',
  '16000',
  '-c:a',
  'libopus',
  '-b:a',
  '16k',
  '-f',
  'ogg',
  'pipe:1'
];

interface RunResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
}

/**
 * One child, reading the recording through an inherited descriptor rather than through its name.
 *
 * The descriptor is opened here with `O_NOFOLLOW` and proved to be the file the path named before
 * anything is spawned, and the child receives that descriptor through the fd protocol. A pathname
 * would be reopened minutes later on a long encode, in a tree the agent's own shell
 * can write - which is the swap `assertOpenedInPlace` exists to refuse everywhere else.
 */
const run = async (
  executable: string,
  args: string[],
  file: number,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal
): Promise<RunResult> => {
  signal?.throwIfAborted();
  const child = spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe', file],
    shell: false,
    detached: true,
    cwd: '/',
    env: { PATH: hostSearchPath, LANG: 'C', LC_ALL: 'C' }
  });
  const abort = () => killProcessTree(child, 'SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const chunks: Buffer[] = [];
  let total = 0;
  let overflowed = false;
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > maxBytes) {
      overflowed = true;
      killProcessTree(child, 'SIGKILL');
      return;
    }
    chunks.push(chunk);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(0, 4_000);
  });
  const timer = setTimeout(() => killProcessTree(child, 'SIGKILL'), timeoutMs);
  timer.unref();
  let exitCode: number | null;
  try {
    ({ exitCode } = await awaitChildExit(child));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  signal?.throwIfAborted();
  if (overflowed)
    throw new WorkspaceFileError(
      'The prepared audio grew past the upload limit before the recording ended',
      413
    );
  return { stdout: Buffer.concat(chunks), stderr, exitCode };
};

const missing = (name: string): WorkspaceFileError =>
  new WorkspaceFileError(
    `This computer has no ${name}, so a recording cannot be read. Installing the media capability - apt-get install -y ffmpeg, or the equivalent for this distribution - is what provides it.`,
    503
  );

const unsupportedSourceIsolation = (stderr: string) => {
  if (/Option not found|Protocol not found|Unrecognized option/u.test(stderr))
    throw new WorkspaceFileError(
      'The installed FFmpeg cannot confine recording reads to a held file descriptor. Install a current FFmpeg build with the fd protocol.',
      503
    );
};

/**
 * A recording in the workspace, measured and cut to one uploadable window.
 *
 * Both refusals it can produce are ones the agent can act on: a file with no audio track in it, and
 * a computer with no ffmpeg on it. Everything else - a container ffmpeg does not know, a truncated
 * download - arrives as the encoder's own first line of standard error, which says more about the
 * file than any sentence written here could.
 */
export const prepareAudio = async (
  root: string,
  requested: string,
  window: {
    startSeconds?: number | undefined;
    endSeconds?: number | undefined;
    expectedSourceSha256?: string | undefined;
  },
  // The system directories and no others, because both binaries below are spawned by the runner's
  // own account rather than through the sandbox: resolving them the way an agent command resolves
  // its own would let a file the agent wrote called `ffprobe` be executed unconfined. Overridable
  // for the same reason `findRenderTools` hands its result to its caller - so the round trip can be
  // measured against a real encoder that is somewhere else, which on a developer's laptop it always
  // is. The route in `server.ts` passes three arguments, so nothing off the wire reaches this.
  searchPath: string = hostSearchPath,
  signal?: AbortSignal
): Promise<PreparedAudio> => {
  signal?.throwIfAborted();
  const [ffprobe, ffmpeg] = await Promise.all([
    resolveExecutable('ffprobe', searchPath, root),
    resolveExecutable('ffmpeg', searchPath, root)
  ]);
  signal?.throwIfAborted();
  if (!ffprobe || !ffmpeg) throw missing(ffprobe ? 'ffmpeg' : 'ffprobe');
  const target = resolveInside(root, requested);
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    await assertOpenedInPlace(root, target, handle);
    const identity = await handle.stat({ bigint: true });
    if (!identity.isFile()) throw new WorkspaceFileError('That path is not a regular file', 400);
    const inspected =
      window.expectedSourceSha256 === undefined ? null : await hashAudioSource(handle, signal);
    if (inspected && inspected.receipt.sourceSha256 !== window.expectedSourceSha256)
      throw sourceChanged();
    const probed = await run(
      ffprobe,
      [
        '-v',
        'error',
        ...audioInputOptions(),
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        'fd:'
      ],
      handle.fd,
      PROBE_TIMEOUT_MS,
      4 * 1024 * 1024,
      signal
    );
    if (probed.exitCode !== 0) {
      unsupportedSourceIsolation(probed.stderr);
      throw new WorkspaceFileError(
        `That file could not be read as a recording: ${probed.stderr.split('\n')[0] || 'the container was not recognised'}`,
        415
      );
    }
    const source = parseAudioProbe(probed.stdout.toString('utf8'));
    if (!source.hasAudio)
      throw new WorkspaceFileError(
        'That file holds no audio track, so there is nothing in it to listen to',
        415
      );
    const cut = audioWindow(window, source.durationSeconds);
    // The fd protocol shares its cursor with the inherited descriptor. Encoding needs a fresh
    // cursor after probing, with the reopened descriptor proved against the held original.
    const encodingSource = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    let encoded: RunResult;
    try {
      await assertOpenedInPlace(root, target, encodingSource);
      if (!sameSource(inspected?.identity ?? identity, await encodingSource.stat({ bigint: true })))
        throw sourceChanged();
      encoded = await run(
        ffmpeg,
        encodeArguments(cut),
        encodingSource.fd,
        ENCODE_TIMEOUT_MS,
        MAX_PREPARED_BYTES,
        signal
      );
      if (!sameSource(inspected?.identity ?? identity, await encodingSource.stat({ bigint: true })))
        throw sourceChanged();
    } finally {
      await encodingSource.close();
    }
    if (encoded.exitCode !== 0 || !encoded.stdout.length) {
      unsupportedSourceIsolation(encoded.stderr);
      throw new WorkspaceFileError(
        `That recording could not be converted for reading: ${encoded.stderr.split('\n')[0] || 'the encoder produced nothing'}`,
        415
      );
    }
    // What the file holds, not what was asked for: a window that runs past the end of a recording
    // produces a shorter encode, and the caller is billed for - and told about - the shorter one.
    const preparedSeconds =
      source.durationSeconds === null
        ? cut.seconds
        : Math.max(0, Math.min(cut.seconds, source.durationSeconds - cut.startSeconds));
    if (inspected) {
      if (!sameSource(inspected.identity, await handle.stat({ bigint: true })))
        throw sourceChanged();
      await assertOpenedInPlace(root, target, handle);
    }
    return {
      bytes: encoded.stdout,
      format: 'ogg',
      source,
      startSeconds: cut.startSeconds,
      preparedSeconds,
      ...(inspected ? { sourceReceipt: inspected.receipt } : {}),
      more:
        source.durationSeconds !== null &&
        source.durationSeconds > cut.startSeconds + preparedSeconds + 1
    };
  } finally {
    await handle.close();
  }
};
