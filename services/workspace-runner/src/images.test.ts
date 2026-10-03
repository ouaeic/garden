import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceFileError } from './files.js';
import {
  CONVERTED_IMAGE_MAX_SIDE,
  conversionTargetFor,
  convertImageForModel,
  imageConvertArguments,
  IMAGE_CONTENT_TYPES,
  MODEL_IMAGE_TYPES
} from './images.js';

const scripts: string[] = [];
afterEach(async () => {
  while (scripts.length) await rm(scripts.pop()!, { recursive: true, force: true });
});

/**
 * The refusal a call produced, as the error it is.
 *
 * What these assert is the sentence the owner reads, and a pattern matched against a rejection is
 * not that sentence - it passes on any error whose text happens to contain the word.
 */
const refusalFrom = async (call: Promise<unknown>): Promise<WorkspaceFileError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof WorkspaceFileError) return error;
    throw error;
  }
  throw new Error('the call was expected to be refused and was not');
};

/** A stand-in for the host's converter, so what this file asserts does not need ImageMagick. */
const stubConverter = async (body: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'garden-convert-'));
  scripts.push(directory);
  const script = path.join(directory, 'magick');
  await writeFile(script, `#!/bin/sh\n${body}\n`);
  await chmod(script, 0o755);
  return script;
};

describe('the pictures this computer can name', () => {
  /*
   * The one that started this. A phone photograph had no entry here, so it was answered as
   * `application/octet-stream` and the reader refused it - the owner could see the file in the
   * Files pane and was told the computer could not open it.
   */
  it('names a phone photograph, a scan and a saved web image', () => {
    expect(IMAGE_CONTENT_TYPES['.heic']).toBe('image/heic');
    expect(IMAGE_CONTENT_TYPES['.heif']).toBe('image/heif');
    expect(IMAGE_CONTENT_TYPES['.tiff']).toBe('image/tiff');
    expect(IMAGE_CONTENT_TYPES['.tif']).toBe('image/tiff');
    expect(IMAGE_CONTENT_TYPES['.bmp']).toBe('image/bmp');
    expect(IMAGE_CONTENT_TYPES['.avif']).toBe('image/avif');
  });

  /*
   * The two limits this change exists to keep apart. Everything above can be read off a disk;
   * only these four can go in a request. Widening the second set is not this repository's to do,
   * and a format outside it that is passed through fails at a provider instead of here.
   */
  it('keeps what a model accepts narrower than what a disk can hold', () => {
    for (const type of ['image/heic', 'image/tiff', 'image/bmp', 'image/avif', 'image/svg+xml'])
      expect(MODEL_IMAGE_TYPES.has(type)).toBe(false);
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
      expect(MODEL_IMAGE_TYPES.has(type)).toBe(true);
  });

  it('turns every picture it can name into one a model takes', () => {
    // The table of types this box will name is the collection, and emptying it satisfies every
    // loop in this file at once. That is not hypothetical: it is how the conversion guard below
    // was found to be checking nothing at all.
    expect(Object.keys(IMAGE_CONTENT_TYPES).length).toBeGreaterThan(0);
    for (const type of Object.values(IMAGE_CONTENT_TYPES))
      expect(MODEL_IMAGE_TYPES.has(conversionTargetFor(type) ?? '')).toBe(true);
  });
});

describe('the conversion a photograph gets', () => {
  it('reads the named coder from stdin and writes a bounded JPEG to stdout', () => {
    const args = imageConvertArguments('image/heic') ?? [];
    expect(args).toContain('heic:-');
    expect(args.at(-1)).toBe('jpeg:-');
    expect(args).toContain(`${CONVERTED_IMAGE_MAX_SIDE}x${CONVERTED_IMAGE_MAX_SIDE}>`);
    // Orientation lives in metadata on a phone, and the metadata is stripped on the way out.
    expect(args).toContain('-auto-orient');
    expect(args).toContain('-strip');
    // A Live Photo is a sequence; several JPEGs end to end is not a file anything can open.
    expect(args.join(' ')).toContain('-delete 1--1');
  });

  /*
   * The path never reaches the converter. ImageMagick reads a trailing `[0]` in a filename as a
   * frame selector and a leading `@` as a file to take the argument from, and a workspace folder
   * is the owner's to name - a holiday album called `holiday[2]` must not be a different command.
   */
  it('never puts the file in the argument list', () => {
    // Counted, not merely iterated. This is the guard that keeps a filename out of an argument
    // vector, and it is satisfied both by an empty type table and by a `conversionTargetFor` that
    // started answering nothing - so the number of conversions actually inspected is the
    // assertion, and it is checked after the loop rather than assumed before it.
    let inspected = 0;
    for (const type of Object.keys(IMAGE_CONTENT_TYPES).map((key) => IMAGE_CONTENT_TYPES[key]!)) {
      const args = imageConvertArguments(type);
      if (!args) continue;
      inspected += 1;
      expect(args.filter((argument) => argument.endsWith(':-'))).toHaveLength(2);
      expect(args.some((argument) => argument.includes('/'))).toBe(false);
    }
    expect(inspected).toBeGreaterThan(0);
  });

  /*
   * A drawing is line art, and JPEG's ringing eats the thin strokes and small text that are the
   * whole of what a diagram says. The renderer is garden's own rather than the delegate, because
   * the delegate resolves external references and a downloaded SVG could point one at this network.
   */
  it('rasterises a drawing to PNG with a renderer that fetches nothing', () => {
    const args = imageConvertArguments('image/svg+xml') ?? [];
    expect(args).toContain('msvg:-');
    expect(args).not.toContain('svg:-');
    expect(args.at(-1)).toBe('png:-');
    expect(args.join(' ')).toContain('-density 150');
  });

  /*
   * The branch a phone photograph actually takes. A JPEG needs no conversion to be accepted, but a
   * JPEG is what a camera roll, a message and a download all produce, with where it was taken,
   * when, and on which body still written into it. The strip is on this pass and on no other, so
   * the format most likely to be carrying all three has to take it.
   */
  it('strips a JPEG, which is what a photograph off a phone is', () => {
    const args = imageConvertArguments('image/jpeg') ?? [];
    expect(args).toContain('jpeg:-');
    expect(args.at(-1)).toBe('jpeg:-');
    expect(args).toContain('-strip');
    expect(args).toContain('-auto-orient');
  });

  /* Whatever a model would have taken as it stood is the set that skipped the strip entirely. */
  it('leaves no picture a model accepts without a pass that strips it', () => {
    expect(MODEL_IMAGE_TYPES.size).toBeGreaterThan(0);
    for (const type of MODEL_IMAGE_TYPES) expect(imageConvertArguments(type)).toContain('-strip');
  });

  /* A lossless WebP and a flat-colour GIF both survive PNG; neither survives a guess at a quality. */
  it('answers a WebP and a GIF as PNG', () => {
    expect(conversionTargetFor('image/webp')).toBe('image/png');
    expect(conversionTargetFor('image/gif')).toBe('image/png');
  });

  it('gives a file that was never a picture no conversion at all', () => {
    expect(imageConvertArguments('application/pdf')).toBeUndefined();
    expect(imageConvertArguments('text/markdown')).toBeUndefined();
  });

  it('hands back the converter output under the type it was asked for', async () => {
    const converter = await stubConverter('cat');
    const result = await convertImageForModel(converter, 'image/heic', Buffer.from('photo-bytes'));
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.content.toString()).toBe('photo-bytes');
  });

  /*
   * What comes out of a converter missing a delegate is a sentence about a coder. The owner
   * attached a photograph, so the failure says so and says what would fix it.
   */
  it('says the host has no converter rather than repeating a spawn error', async () => {
    const refusal = await refusalFrom(
      convertImageForModel('/nonexistent/magick', 'image/heic', Buffer.from('photo'))
    );
    expect(refusal.status).toBe(503);
    expect(refusal.message).toContain('imagemagick');
  });

  it('names the format when the converter cannot read it', async () => {
    const converter = await stubConverter('exit 1');
    const refusal = await refusalFrom(
      convertImageForModel(converter, 'image/avif', Buffer.from('photo'))
    );
    expect(refusal.status).toBe(415);
    expect(refusal.message).toContain('image/avif');
  });

  /* A converter that exits cleanly having produced nothing is a failure, not an empty picture. */
  it('refuses an empty result from a converter that claimed success', async () => {
    const converter = await stubConverter('exit 0');
    const refusal = await refusalFrom(
      convertImageForModel(converter, 'image/tiff', Buffer.from('scan'))
    );
    expect(refusal.status).toBe(415);
  });

  /* A converter that never reads stdin leaves the write with nowhere to go; EPIPE is not the news. */
  it('reports the exit rather than the broken pipe when the converter ignores its input', async () => {
    const converter = await stubConverter('exit 3');
    const refusal = await refusalFrom(
      convertImageForModel(converter, 'image/heic', Buffer.alloc(4 * 1024 * 1024, 1))
    );
    expect(refusal.status).toBe(415);
  });
});
