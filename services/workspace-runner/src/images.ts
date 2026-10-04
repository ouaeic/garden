import { spawn } from 'node:child_process';
import { WorkspaceFileError } from './files.js';

/**
 * Every picture format this computer can name from a file's extension.
 *
 * A phone photograph is HEIC, a scan is TIFF, a screenshot pasted out of an older tool is BMP, and
 * a page saved from the web is increasingly AVIF. Left out of this table, all four would fall into
 * `application/octet-stream` - "some bytes" - and the image reader would refuse them for not being
 * pictures. Naming them is what separates a picture the runner has to convert from a file that was
 * never a picture at all, and the separation has to exist before either can be handled.
 */
export const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp'
};

/**
 * What a model will actually accept as the picture part of a request.
 *
 * This is the second of the two limits that get confused here. The first is what garden can read
 * off a disk, which is the table above and is wide. This one is narrow and is not garden's to
 * widen: the gateway sends one `image_url` data URL, and no route behind it takes HEIC, TIFF, BMP,
 * AVIF or SVG. A format outside this set has to be converted before the request is built, because
 * passing it through only moves the refusal to a provider whose error will not say which file.
 */
export const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);

/**
 * How each format garden can read is re-encoded on its way out, and by which reader.
 *
 * The coder is named rather than inferred. ImageMagick will otherwise choose one by looking at the
 * bytes, and some of the coders it can choose that way execute what they read; a picture that
 * reached this workspace as a download is not a thing to hand an interpreter. Naming the coder
 * confines the file to the format its extension already claimed.
 *
 * Photographs and scans become JPEG because that is what they are and the alternative triples the
 * bytes on the wire for nothing. Line art becomes PNG, where JPEG's ringing eats thin strokes and
 * small text - which for a diagram is the entire content.
 *
 * The four formats a model already accepts are in this table too, and they are most of the point of
 * it. The strip below lives on this pass and nowhere else, so a picture sent as it sits on disk
 * leaves carrying where it was taken, when, and on which camera body. JPEG is what every photo off
 * a camera roll, out of a message or off a download is, so passing those four through would strip
 * the formats that rarely hold coordinates and send the one that almost always does. WebP and GIF
 * become PNG rather than themselves because either can have been lossless where it came from and
 * neither encoder can be asked to match a source nobody measured; PNG is lossless for both.
 *
 * `msvg` is ImageMagick's own renderer rather than the delegate it would otherwise reach for. The
 * delegate resolves external references, and an SVG holding an `href` to somewhere inside this
 * network would make looking at a downloaded drawing into a request the owner never made.
 */
const CONVERSIONS: Readonly<Record<string, { coder: string; target: 'image/jpeg' | 'image/png' }>> =
  {
    'image/jpeg': { coder: 'jpeg', target: 'image/jpeg' },
    'image/png': { coder: 'png', target: 'image/png' },
    'image/webp': { coder: 'webp', target: 'image/png' },
    'image/gif': { coder: 'gif', target: 'image/png' },
    'image/heic': { coder: 'heic', target: 'image/jpeg' },
    'image/heif': { coder: 'heif', target: 'image/jpeg' },
    'image/avif': { coder: 'avif', target: 'image/jpeg' },
    'image/tiff': { coder: 'tiff', target: 'image/jpeg' },
    'image/bmp': { coder: 'bmp', target: 'image/jpeg' },
    'image/svg+xml': { coder: 'msvg', target: 'image/png' }
  };

/**
 * The longest side a converted picture keeps.
 *
 * A vision model reads an image in tiles and stops gaining from resolution well below what a phone
 * camera produces, so a 48-megapixel photograph re-encoded at full size buys nothing and costs the
 * owner both the upload and the tokens. Nothing sharp is given up by applying it to a screenshot
 * too: a picture larger than this is resampled to about this size at the other end regardless, so
 * the only difference is which machine pays for the pixels nobody reads.
 */
export const CONVERTED_IMAGE_MAX_SIDE = 1568;

const JPEG_QUALITY = 82;

/** Beyond this a converted picture is not a picture, and reading it would be the failure. */
export const IMAGE_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The whole conversion, as one argument list, so it can be read and tested without a host that has
 * ImageMagick on it.
 *
 * The limits come first because ImageMagick applies them in order and a decompression bomb is
 * decoded by the time a later flag is parsed - a 100x100 file can declare a canvas of a hundred
 * million pixels, and the runner is the process that would die for it.
 *
 * Both ends are `-`, so the file never appears in the argument list. A workspace path is the
 * owner's to name, and ImageMagick reads a trailing `[0]` in a filename as a frame selector and a
 * leading `@` as a file to read the argument from; a photograph in a folder called `holiday[2]`
 * should not be a different command.
 */
export const imageConvertArguments = (contentType: string): string[] | undefined => {
  const conversion = CONVERSIONS[contentType];
  if (!conversion) return undefined;
  return [
    '-limit',
    'memory',
    '256MiB',
    '-limit',
    'map',
    '512MiB',
    '-limit',
    'disk',
    '1GiB',
    '-limit',
    'time',
    '20',
    // An SVG has no pixels of its own, so without this it rasterises at whatever the drawing
    // happens to declare, which for an icon is a thumbnail nobody can read.
    '-density',
    '150',
    `${conversion.coder}:-`,
    // A Live Photo and a multi-page scan both arrive as a sequence. Written to one stream that
    // becomes several images end to end, which is not a file any reader can open, so the first
    // frame is the picture and the rest are dropped.
    '-delete',
    '1--1',
    // Phones record orientation in metadata rather than in the pixels, so without this a
    // photograph taken sideways arrives sideways.
    '-auto-orient',
    '-resize',
    `${CONVERTED_IMAGE_MAX_SIDE}x${CONVERTED_IMAGE_MAX_SIDE}>`,
    ...(conversion.target === 'image/jpeg'
      ? // JPEG has no transparency, and a cut-out saved as HEIC would otherwise come out on black.
        ['-background', 'white', '-flatten', '-quality', String(JPEG_QUALITY)]
      : ['-background', 'none']),
    // Location and camera metadata are not what was asked to be looked at, and this picture is
    // about to leave the owner's computer for a provider.
    '-strip',
    `${conversion.target === 'image/jpeg' ? 'jpeg' : 'png'}:-`
  ];
};

/** What a converted picture will be, before anything has been spent converting it. */
export const conversionTargetFor = (contentType: string): string | undefined =>
  CONVERSIONS[contentType]?.target;

/**
 * Re-encodes one picture into something a model will take.
 *
 * Failure is answered with the format's name rather than with the converter's output. What comes
 * back from a missing delegate is a sentence about a coder, and the owner attached a photograph.
 */
export const convertImageForModel = async (
  executable: string,
  contentType: string,
  source: Buffer,
  timeoutMs = 30_000
): Promise<{ mimeType: string; content: Buffer }> => {
  const args = imageConvertArguments(contentType);
  const target = conversionTargetFor(contentType);
  if (!args || !target)
    throw new WorkspaceFileError(`${contentType} is not a picture this computer can convert`, 415);

  // Diagnostics are discarded rather than buffered: nothing reads them, and a converter that
  // complains about every frame of a long animation would otherwise fill a pipe nobody drains and
  // hang the read it was supposed to serve.
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  timer.unref();
  // A converter that dies before it has read the file leaves this write with nowhere to go, and an
  // EPIPE here is the same failure the exit code is about to report properly.
  child.stdin.on('error', () => {});
  child.stdin.end(source);

  try {
    const code = await finished.catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        throw new WorkspaceFileError(
          `This computer has no image converter installed, so a ${contentType} picture cannot be looked at. Installing the imagemagick package restores it.`,
          503
        );
      throw error;
    });
    const content = Buffer.concat(chunks);
    if (code !== 0 || content.length === 0)
      throw new WorkspaceFileError(
        `This computer could not read the ${contentType} picture. Its image toolchain was built without support for that format.`,
        415
      );
    return { mimeType: target, content };
  } finally {
    clearTimeout(timer);
  }
};
