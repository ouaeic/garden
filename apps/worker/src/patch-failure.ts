/**
 * Explaining a patch that did not apply.
 *
 * A failed `file_patch` is one of the few tool failures the model can fix by itself, and only if it
 * is told the right thing: not "no match", but where the nearest candidates were and how the file
 * really reads there. Everything in this file is about producing that answer inside a bounded
 * number of characters, because the explanation goes into the window and a whole file would not.
 */
import { countOccurrences } from './values.js';

export interface PatchFailure {
  path: string;
  occurrences: number;
  reason: string;
  /** Named when the text is present but not byte-identical, which is the usual cause. */
  difference?: 'line endings' | 'leading whitespace' | 'inner whitespace';
  nearestMatch?: { startLine: number; endLine: number; text: string };
}

/** Comparison that ignores exactly what a stale patch usually differs by, and nothing else. */
const normalisedLine = (line: string): string => line.replace(/\s+/g, ' ').trim();

/** How many lines around the nearest match come back, so a retry needs no second read. */
const PATCH_CONTEXT_LINES = 10;
const MAX_PATCH_CONTEXT_CHARS = 2_400;
/** Bounds the search on a large file; a patch with hundreds of near-misses has no nearest match. */
const MAX_PATCH_CANDIDATES = 500;

const numberedRegion = (lines: string[], from: number, to: number): string =>
  lines
    .slice(from, to)
    .map((line, index) => `${from + index + 1}| ${line}`)
    .join('\n')
    .slice(0, MAX_PATCH_CONTEXT_CHARS);

/**
 * Explains a patch that did not apply, in terms the next attempt can act on.
 *
 * "expected oldText exactly once, found 0" distinguishes nothing: a trailing space, a CRLF file, a
 * re-indented block and a genuinely moved one all produce the same line, and the only recovery is
 * to read the whole file again. This finds where the text nearly matched, says what differs when
 * the difference is only whitespace or line endings, and hands back the current text of that
 * region with line numbers.
 */
export const patchFailure = (path: string, before: string, oldText: string): PatchFailure => {
  const occurrences = countOccurrences(before, oldText);
  const fileLines = before.split('\n');
  const patchLines = oldText.split('\n');
  if (occurrences > 1) {
    const seen: number[] = [];
    let cursor = 0;
    for (let index = 0; index < fileLines.length && seen.length < 5; index += 1) {
      if (fileLines[index] === patchLines[0]) seen.push(index + 1);
      cursor += 1;
    }
    return {
      path,
      occurrences,
      reason: `oldText appears ${occurrences} times in ${path}${
        seen.length ? ` (first lines ${seen.join(', ')})` : ''
      }, so the edit is ambiguous. Extend oldText with enough surrounding lines to make it unique, or send one patch per occurrence with different context.`,
      ...(cursor && seen[0]
        ? {
            nearestMatch: {
              startLine: Math.max(1, seen[0] - PATCH_CONTEXT_LINES),
              endLine: Math.min(
                fileLines.length,
                seen[0] + patchLines.length + PATCH_CONTEXT_LINES
              ),
              text: numberedRegion(
                fileLines,
                Math.max(0, seen[0] - 1 - PATCH_CONTEXT_LINES),
                Math.min(fileLines.length, seen[0] - 1 + patchLines.length + PATCH_CONTEXT_LINES)
              )
            }
          }
        : {})
    };
  }

  const normalFile = fileLines.map(normalisedLine);
  const normalPatch = patchLines.map(normalisedLine);
  // Candidate positions come from an index of the file's own lines, so only offsets where at least
  // one line of the patch already matches are scored. A patch whose first line is the changed one
  // still finds its place, and a large file costs one pass rather than a cross product.
  const positions = new Map<string, number[]>();
  normalFile.forEach((line, index) => {
    if (!line) return;
    const existing = positions.get(line);
    if (existing) existing.push(index);
    else positions.set(line, [index]);
  });
  const offsets = new Set<number>();
  normalPatch.forEach((line, index) => {
    if (!line || offsets.size >= MAX_PATCH_CANDIDATES) return;
    for (const found of positions.get(line) ?? []) {
      const offset = found - index;
      if (offset >= 0 && offsets.size < MAX_PATCH_CANDIDATES) offsets.add(offset);
    }
  });
  let best = { offset: -1, score: 0 };
  for (const offset of offsets) {
    let score = 0;
    for (let line = 0; line < normalPatch.length; line += 1)
      if (normalFile[offset + line] === normalPatch[line]) score += 1;
    if (score > best.score) best = { offset, score };
  }

  const whitespaceOnly = best.score === normalPatch.length && best.offset >= 0;
  const difference: PatchFailure['difference'] | undefined = !whitespaceOnly
    ? undefined
    : before.includes(oldText.replace(/\n/g, '\r\n'))
      ? 'line endings'
      : fileLines
            .slice(best.offset, best.offset + patchLines.length)
            .every((line, index) => line.trimStart() === (patchLines[index] ?? '').trimStart())
        ? 'leading whitespace'
        : 'inner whitespace';

  return {
    path,
    occurrences: 0,
    ...(difference ? { difference } : {}),
    reason: difference
      ? `The text is at ${path} line ${best.offset + 1}, but differs in ${difference}. Copy oldText from the region below exactly as it is written there.`
      : best.offset >= 0
        ? `oldText is not in ${path}. The closest region is line ${best.offset + 1}, where ${best.score} of ${normalPatch.length} lines still match; the file has moved on since you read it. Re-read that region and patch what is there now.`
        : `oldText is not in ${path}, and no part of it resembles anything in the file. Check the path, or read the file before patching it.`,
    ...(best.offset >= 0
      ? {
          nearestMatch: {
            startLine: Math.max(1, best.offset + 1 - PATCH_CONTEXT_LINES),
            endLine: Math.min(
              fileLines.length,
              best.offset + patchLines.length + PATCH_CONTEXT_LINES
            ),
            text: numberedRegion(
              fileLines,
              Math.max(0, best.offset - PATCH_CONTEXT_LINES),
              Math.min(fileLines.length, best.offset + patchLines.length + PATCH_CONTEXT_LINES)
            )
          }
        }
      : {})
  };
};
