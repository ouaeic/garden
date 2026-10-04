import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveExecutable } from './command-policy.js';
import { hostSearchPath } from './execution.js';
import { readWorkspaceFile, WorkspaceFileError } from './files.js';
import { awaitChildExit, killProcessTree } from './subprocess.js';

/**
 * What a generated document looks like when this computer renders it, measured rather than claimed.
 *
 * Every acceptance check that could be written about a deck, a CV or a chart was "the file exists
 * and is at least this many bytes", and a deck whose text runs off slide four is comfortably past
 * four kilobytes. So the only witness to how the deliverable actually looks was the model that made
 * it, which is the shape of failure this codebase keeps finding: an assertion standing in for
 * evidence.
 *
 * Two things are measured here, and they were chosen because they are the two failures that are
 * both common in generated documents and provable from the render without a model looking at it:
 *
 * - **How many pages it is.** A one-page CV that renders two, a twelve-slide deck that renders
 *   nine, a report with a trailing empty page from a stray page break. It is one number, it is
 *   exactly what the owner asked for in their own words, and it cannot be wrong in a way that is
 *   arguable.
 * - **Whether any text crosses the edge of its page.** A PowerPoint text box does not grow; it
 *   clips, silently, with nothing anywhere reporting an error, and the overflow is drawn running
 *   off the slide. Poppler reports the box of every word it finds, so a word that reaches past the
 *   page is arithmetic on numbers the renderer produced.
 *
 * What this cannot see, said here because a check whose reach is misunderstood is worse than none:
 * poppler keeps a glyph only when the pen that drew it was on the page, so text pushed *entirely*
 * past an edge is not in the render to be found. This measures text the render had to cut, not
 * text that fell off. The page count is what catches the paginated form of the same failure - a
 * document that overflows downwards makes another page rather than losing a line.
 *
 * Deliberately not here: text overlapping other text. It is the same family and it is the check
 * most likely to fire on work that is fine - a draft watermark sits under every line of the page
 * it stamps, and a caption over a photograph overlaps nothing but is scored as an overlap by any
 * cheap box test. A guard that fires on real work is worse than the failure it prevents.
 *
 * Nothing here needs a model to look at anything, and nothing here is a second chance to act: the
 * only thing this writes is a temporary copy of the file it was asked about, in a directory it
 * removes before it answers.
 */

/** The extensions that have a rendered page at all. Anything else is refused rather than guessed. */
export const RENDERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.odt',
  '.odp',
  '.ods',
  '.doc',
  '.ppt',
  '.xls',
  '.rtf'
]);

/** The ones whose pages a person calls slides, so the sentence the owner reads uses their word. */
const PRESENTATION_EXTENSIONS: ReadonlySet<string> = new Set(['.pptx', '.ppt', '.odp']);

/**
 * How far past an edge a word has to reach before it is called a crossing.
 *
 * Poppler drops the glyphs that fall entirely outside the page and keeps the ones that start
 * inside it, so a word that is cut off at the edge is reported reaching a fraction of a character
 * past it - never far past it. That makes the observation reliable and the magnitude small, which
 * is why the tolerance is a hair rather than a margin: a design that means to end exactly at the
 * edge lands on it, and only something the renderer had to cut lands beyond it.
 */
export const EDGE_TOLERANCE_POINTS = 1;

/** Below this fraction of pixels darker than {@link INK_LEVEL} there is nothing on the page. */
export const BLANK_INK_FRACTION = 0.0002;
/** Anything lighter than this is paper, including the grey fringe of antialiasing. */
const INK_LEVEL = 250;

/**
 * Coarse on purpose. This raster answers one question - is there anything at all on this page -
 * and at 20 dots per inch a sheet of A4 is under forty thousand pixels, which is a few milliseconds
 * of poppler and no measurable memory.
 */
const BLANK_PROBE_DPI = 20;

/**
 * How many pages with no text on them this will render to see whether they are blank.
 *
 * A generated document has none, so in the normal case nothing is rasterised at all. A scan with no
 * text layer has every page, and rendering all of them would turn a check into a job - so past this
 * many the check says it cannot answer rather than answering for the ones it looked at.
 *
 * A twenty-page scan is an ordinary thing to be handed, and a limit below it would answer that the
 * document could not be vouched for. That sentence is true and it is not what the owner needed,
 * because the limit it would be reporting is this constant rather than anything about their file.
 * At the measured 52ms a page this covers a long scan for about three seconds against a 30s probe
 * budget, so what is left past it is genuinely a job rather than a document.
 */
export const MAX_BLANK_PROBE_PAGES = 64;

const BBOX_TIMEOUT_MS = 60_000;
const BLANK_PROBE_TIMEOUT_MS = 30_000;
const CONVERT_TIMEOUT_SECONDS = 120;
const CONVERT_TIMEOUT_MS = (CONVERT_TIMEOUT_SECONDS + 20) * 1_000;

/** A generated deliverable is kilobytes to a few megabytes; past this it is not one of these. */
export const RENDER_SOURCE_MAX_BYTES = 96 * 1024 * 1024;
/** Word boxes for a very long document. Past it the answer is "too large", not a partial reading. */
const MAX_BBOX_BYTES = 16 * 1024 * 1024;

export interface RenderedWord {
  readonly text: string;
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
}

export interface RenderedPage {
  readonly width: number;
  readonly height: number;
  readonly words: readonly RenderedWord[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
};

const decodeText = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x')
        ? Number.parseInt(body.slice(2), 16)
        : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });

const attribute = (tag: string, name: string): number => {
  const found = new RegExp(`\\b${name}="(-?[0-9.]+)"`).exec(tag);
  return found?.[1] === undefined ? Number.NaN : Number(found[1]);
};

const PAGE_PATTERN = /<page\b([^>]*)>([\s\S]*?)<\/page>/g;
const WORD_PATTERN = /<word\b([^>]*)>([\s\S]*?)<\/word>/g;

/**
 * Poppler's `-bbox` output, which is where every measurement below comes from.
 *
 * Read with expressions rather than an XML parser because that is all this shape needs and a
 * dependency to read six attributes would be a poor trade. Coordinates are in points from the top
 * left of the page, which is why the vertical comparisons read the way they do.
 */
export const parseRenderedPages = (xhtml: string): RenderedPage[] => {
  const pages: RenderedPage[] = [];
  for (const page of xhtml.matchAll(PAGE_PATTERN)) {
    const width = attribute(page[1] ?? '', 'width');
    const height = attribute(page[1] ?? '', 'height');
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    const words: RenderedWord[] = [];
    for (const word of (page[2] ?? '').matchAll(WORD_PATTERN)) {
      const text = decodeText(word[2] ?? '').trim();
      const box = {
        xMin: attribute(word[1] ?? '', 'xMin'),
        yMin: attribute(word[1] ?? '', 'yMin'),
        xMax: attribute(word[1] ?? '', 'xMax'),
        yMax: attribute(word[1] ?? '', 'yMax')
      };
      if (!text || Object.values(box).some((value) => !Number.isFinite(value))) continue;
      words.push({ text, ...box });
    }
    pages.push({ width, height, words });
  }
  return pages;
};

export interface EdgeCrossing {
  /** One-based, so it is the page number the owner would count to. */
  readonly page: number;
  readonly word: string;
  readonly edge: 'left' | 'right' | 'top' | 'bottom';
  readonly overshootPoints: number;
}

/**
 * Every word that reaches past the edge it should have stayed inside, worst first.
 *
 * `marginPoints` moves the boundary inward from the page edge, for a job that was given one - a CV
 * asked for with an inch of white around it. It defaults to zero, the edge itself, because a margin
 * is a claim about what was intended and this file only measures what is there: a full-bleed slide
 * with a word deliberately touching the edge is not a defect, and a check that called it one would
 * be refusing correct work.
 */
export const edgeCrossings = (
  pages: readonly RenderedPage[],
  marginPoints = 0,
  tolerancePoints = EDGE_TOLERANCE_POINTS
): EdgeCrossing[] => {
  const crossings: EdgeCrossing[] = [];
  for (const [index, page] of pages.entries()) {
    for (const word of page.words) {
      const overshoots = [
        { edge: 'left' as const, by: marginPoints - word.xMin },
        { edge: 'right' as const, by: word.xMax - (page.width - marginPoints) },
        { edge: 'top' as const, by: marginPoints - word.yMin },
        { edge: 'bottom' as const, by: word.yMax - (page.height - marginPoints) }
      ];
      // One finding per word, not per edge: a line pushed off the bottom right corner is one
      // defect, and reporting it twice would make the count read like two.
      const worst = overshoots.reduce((left, right) => (right.by > left.by ? right : left));
      if (worst.by > tolerancePoints)
        crossings.push({
          page: index + 1,
          word: word.text,
          edge: worst.edge,
          overshootPoints: worst.by
        });
    }
  }
  return crossings.sort((left, right) => right.overshootPoints - left.overshootPoints);
};

/**
 * How much of a rendered page is not paper, from poppler's own greyscale raster.
 *
 * Returns nothing rather than a guess when the bytes are not the one format this reads, so a
 * poppler built to emit something else makes the check say it could not tell instead of saying the
 * page was blank.
 */
export const inkFraction = (raster: Buffer): number | undefined => {
  if (!raster.subarray(0, 2).equals(Buffer.from('P5'))) return undefined;
  let cursor = 2;
  const fields: number[] = [];
  while (fields.length < 3 && cursor < raster.length) {
    const byte = raster[cursor] ?? 0;
    if (byte === 0x23) {
      while (cursor < raster.length && raster[cursor] !== 0x0a) cursor += 1;
      continue;
    }
    if (byte <= 0x20) {
      cursor += 1;
      continue;
    }
    let value = 0;
    while (cursor < raster.length && (raster[cursor] ?? 0) > 0x20) {
      const digit = (raster[cursor] ?? 0) - 0x30;
      if (digit < 0 || digit > 9) return undefined;
      value = value * 10 + digit;
      cursor += 1;
    }
    fields.push(value);
  }
  const [width, height, maximum] = fields;
  if (!width || !height || maximum !== 255) return undefined;
  const pixels = raster.subarray(cursor + 1);
  if (pixels.length < width * height) return undefined;
  let dark = 0;
  for (let index = 0; index < width * height; index += 1)
    if ((pixels[index] ?? 255) < INK_LEVEL) dark += 1;
  return dark / (width * height);
};

interface ToolResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly overflowed: boolean;
}

/**
 * One child, detached so a converter that forks is killed with its children rather than orphaning
 * them. Nothing here is given a workspace path: every argument is inside the temporary directory
 * this module made, so there is no name for the agent's own account to swap underneath it.
 */
const run = async (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maxBytes: number,
  deadlineAt: number,
  signal?: AbortSignal
): Promise<ToolResult> => {
  const remaining = Math.min(timeoutMs, deadlineAt - Date.now());
  if (signal?.aborted || remaining <= 0)
    throw new WorkspaceFileError(
      'Render verification is incomplete: cancelled or out of time.',
      408
    );
  const child = spawn(executable, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: true
  });
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
  let stopped = false;
  const stop = () => {
    stopped = true;
    killProcessTree(child, 'SIGKILL');
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(stop, remaining);
  timer.unref();
  let exitCode: number | null;
  try {
    ({ exitCode } = await awaitChildExit(child));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
  if (stopped || Date.now() >= deadlineAt)
    throw new WorkspaceFileError(
      'Render verification is incomplete: cancelled or out of time.',
      408
    );
  return { stdout: Buffer.concat(chunks), stderr, exitCode, overflowed };
};

/**
 * The tools this needs, resolved against the system directories and no others.
 *
 * Not the way an agent command resolves them. All three are spawned by the runner's own account,
 * outside the sandbox, so resolving them on `agentSearchPath` would let a file the agent had
 * written called `pdftotext` be the one that ran on the owner's document.
 * @see hostSearchPath.
 *
 * Held as a value the caller passes in so the measurement can be exercised against a poppler that
 * is somewhere else - which on a developer's laptop it always is.
 */
export interface RenderTools {
  readonly pdftotext: string | undefined;
  readonly pdftoppm: string | undefined;
  readonly officeConvert: string | undefined;
}

export const findRenderTools = async (root: string): Promise<RenderTools> => {
  const [pdftotext, pdftoppm, officeConvert] = await Promise.all([
    resolveExecutable('pdftotext', hostSearchPath, root),
    resolveExecutable('pdftoppm', hostSearchPath, root),
    resolveExecutable('garden-office-convert', hostSearchPath, root)
  ]);
  return { pdftotext, pdftoppm, officeConvert };
};

export interface RenderProofRequest {
  readonly path: string;
  readonly deadlineAt?: number | undefined;
  /** The exact number of pages the job asked for, when it asked for one. */
  readonly expectPages?: number | undefined;
  readonly marginPoints?: number | undefined;
}

export interface RenderProofResult {
  readonly passed: boolean;
  /** What the harness saw, in the sentence the owner reads on the acceptance record. */
  readonly detail: string;
  readonly pages: number;
  readonly words: number;
  readonly crossings: number;
  readonly blankPages: readonly number[];
  /** True when the pages measured came from a render this computer made just now. */
  readonly converted: boolean;
}

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`;

const rounded = (value: number): string => value.toFixed(1);

/**
 * The whole finding as one sentence, which is the only form of it the owner ever sees.
 *
 * Written to be read by someone who did not ask for a check and does not know what poppler is: the
 * page they would count to, the words that are cut, and - when the file measured was rendered here
 * rather than being a PDF already - that the pages are this computer's render of their file and not
 * the one their own machine would draw.
 */
export const describeRenderProof = (input: {
  readonly pages: number;
  readonly unit: 'page' | 'slide';
  readonly expectPages?: number | undefined;
  readonly marginPoints: number;
  readonly crossings: readonly EdgeCrossing[];
  readonly blankPages: readonly number[];
  /** Pages with no text that this computer could not render, so their state is unknown. */
  readonly unreadablePages: readonly number[];
  /** Pages with no text that were past the probe ceiling, so nothing was asked about them. */
  readonly unprobedPages: number;
  readonly words: number;
  readonly renderedFrom?: string | undefined;
}): { passed: boolean; detail: string } => {
  const source = input.renderedFrom
    ? ` (measured on the PDF this computer rendered from ${input.renderedFrom})`
    : '';
  const faults: string[] = [];
  if (input.expectPages !== undefined && input.expectPages !== input.pages)
    faults.push(
      `it renders ${plural(input.pages, input.unit)}, not the ${plural(input.expectPages, input.unit)} asked for`
    );
  for (const page of input.blankPages)
    faults.push(
      `${input.unit} ${page} of ${input.pages} has no text and no ink on it: it renders blank`
    );
  for (const page of input.unreadablePages)
    faults.push(
      `${input.unit} ${page} of ${input.pages} has no text on it and this computer could not render it to see whether anything else is`
    );
  if (input.unprobedPages > 0)
    faults.push(
      `${input.unprobedPages} of its ${input.pages} ${input.unit}s carry no text at all, which is more than this check renders, so it cannot say whether they are blank`
    );
  const [worst, ...rest] = input.crossings;
  if (worst) {
    const boundary =
      input.marginPoints > 0
        ? `${rounded(input.marginPoints)}pt margin`
        : `${worst.edge} edge of the ${input.unit}`;
    const alsoOn = [...new Set(rest.map((crossing) => crossing.page))].slice(0, 6);
    faults.push(
      `${input.unit} ${worst.page} of ${input.pages}: “${worst.word.slice(0, 40)}” runs ${rounded(worst.overshootPoints)}pt past the ${boundary} and is cut off there${
        rest.length
          ? `, and ${plural(rest.length, 'other word')} ${rest.length === 1 ? 'crosses' : 'cross'} an edge on ${input.unit}${alsoOn.length === 1 ? '' : 's'} ${alsoOn.join(', ')}`
          : ''
      }`
    );
  }
  if (faults.length) return { passed: false, detail: `${faults.join('; ')}${source}` };
  const inside =
    input.marginPoints > 0
      ? `every word inside the ${rounded(input.marginPoints)}pt margin`
      : `no text crossing a ${input.unit} edge`;
  return {
    passed: true,
    detail: `${plural(input.pages, input.unit)}, ${plural(input.words, 'word')} placed, ${inside}, none blank${source}`
  };
};

const missingTool = (what: string, install: string): WorkspaceFileError =>
  new WorkspaceFileError(
    `This computer has no ${what}, so nothing about the rendered pages can be measured and this check cannot say whether the document is right. Installing it - ${install} - is what provides it.`,
    503
  );

/**
 * Renders the file if it is not already a PDF, measures its pages, and says what it found.
 *
 * The conversion is the point rather than an inconvenience: the deliverable the owner receives is
 * the .pptx, so a check that measured a PDF the model rendered earlier would be proving something
 * about whichever render happened to be lying in the workspace. Rendering it here, from the bytes
 * on disk at the moment finish is called, is what makes a stale proof impossible.
 */
export const proveRender = async (
  root: string,
  request: RenderProofRequest,
  tools: RenderTools,
  maxSourceBytes = RENDER_SOURCE_MAX_BYTES,
  signal?: AbortSignal
): Promise<RenderProofResult> => {
  const deadlineAt = Math.min(
    request.deadlineAt ?? Infinity,
    Date.now() +
      CONVERT_TIMEOUT_MS +
      BBOX_TIMEOUT_MS +
      MAX_BLANK_PROBE_PAGES * BLANK_PROBE_TIMEOUT_MS
  );
  const boundedRun = (
    executable: string,
    args: readonly string[],
    timeout: number,
    bytes: number
  ) => run(executable, args, timeout, bytes, deadlineAt, signal);
  if (signal?.aborted || deadlineAt <= Date.now())
    throw new WorkspaceFileError(
      'Render verification is incomplete: cancelled or out of time.',
      408
    );
  const extension = path.extname(request.path).toLowerCase();
  if (!RENDERABLE_EXTENSIONS.has(extension))
    throw new WorkspaceFileError(
      `${path.basename(request.path)} has no rendered page, so there is nothing here to measure. This check is for a PDF or an Office document.`,
      415
    );
  if (!tools.pdftotext) throw missingTool('PDF page reader', 'apt-get install -y poppler-utils');
  const converting = extension !== '.pdf';
  if (converting && !tools.officeConvert)
    throw missingTool(
      'Office converter',
      'apt-get install -y libreoffice-writer libreoffice-impress libreoffice-calc'
    );
  const source = await readWorkspaceFile(root, request.path, maxSourceBytes);
  const scratch = await mkdtemp(path.join(tmpdir(), 'garden-render-proof-'));
  try {
    const sourcePath = path.join(scratch, `source${extension}`);
    await writeFile(sourcePath, source.content, { mode: 0o600 });
    let pdfPath = sourcePath;
    if (converting && tools.officeConvert) {
      pdfPath = path.join(scratch, 'render.pdf');
      const converted = await boundedRun(
        tools.officeConvert,
        [sourcePath, pdfPath, '--timeout', String(CONVERT_TIMEOUT_SECONDS)],
        CONVERT_TIMEOUT_MS,
        1024 * 1024
      );
      if (converted.exitCode !== 0)
        throw new WorkspaceFileError(
          `${path.basename(request.path)} could not be rendered on this computer, so how it looks is unknown: ${
            converted.stderr.trim().split('\n').pop() ?? 'the converter produced nothing'
          }`,
          422
        );
    }
    const measured = await boundedRun(
      tools.pdftotext,
      ['-bbox', pdfPath, '-'],
      BBOX_TIMEOUT_MS,
      MAX_BBOX_BYTES
    );
    if (measured.overflowed)
      throw new WorkspaceFileError(
        `${path.basename(request.path)} has more text on it than this check can measure, so it says nothing about how it looks.`,
        413
      );
    if (measured.exitCode !== 0)
      throw new WorkspaceFileError(
        `${path.basename(request.path)} could not be read as a rendered document: ${
          measured.stderr.trim().split('\n')[0] ?? 'no reason given'
        }`,
        422
      );
    const pages = parseRenderedPages(measured.stdout.toString('utf8'));
    if (!pages.length)
      throw new WorkspaceFileError(
        `${path.basename(request.path)} rendered to no pages at all, so there is nothing to measure.`,
        422
      );
    const marginPoints = request.marginPoints ?? 0;
    const crossings = edgeCrossings(pages, marginPoints);
    const empty = pages
      .map((page, index) => ({ page, number: index + 1 }))
      .filter((entry) => entry.page.words.length === 0);
    const blankPages: number[] = [];
    const unreadablePages: number[] = [];
    for (const entry of empty.slice(0, MAX_BLANK_PROBE_PAGES)) {
      const ink = tools.pdftoppm
        ? await boundedRun(
            tools.pdftoppm,
            [
              '-gray',
              '-r',
              String(BLANK_PROBE_DPI),
              '-f',
              String(entry.number),
              '-l',
              String(entry.number),
              pdfPath
            ],
            BLANK_PROBE_TIMEOUT_MS,
            8 * 1024 * 1024
          ).then((result) => (result.exitCode === 0 ? inkFraction(result.stdout) : undefined))
        : undefined;
      if (ink === undefined) unreadablePages.push(entry.number);
      else if (ink < BLANK_INK_FRACTION) blankPages.push(entry.number);
    }
    const words = pages.reduce((total, page) => total + page.words.length, 0);
    const described = describeRenderProof({
      pages: pages.length,
      unit: PRESENTATION_EXTENSIONS.has(extension) ? 'slide' : 'page',
      expectPages: request.expectPages,
      marginPoints,
      crossings,
      blankPages,
      unreadablePages,
      // Past the ceiling nothing is claimed about the pages that were not looked at: from the text
      // alone a document that is all pictures and one that is all empty are the same document.
      unprobedPages: Math.max(0, empty.length - MAX_BLANK_PROBE_PAGES),
      words,
      ...(converting ? { renderedFrom: path.basename(request.path) } : {})
    });
    if (signal?.aborted || Date.now() >= deadlineAt)
      throw new WorkspaceFileError(
        'Render verification is incomplete: cancelled or out of time.',
        408
      );
    return {
      ...described,
      pages: pages.length,
      words,
      crossings: crossings.length,
      blankPages,
      converted: converting
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
};
