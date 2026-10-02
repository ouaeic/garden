/**
 * Exact-text replacement: each `oldText` must occur once in the file (or `replaceAll`), and the
 * replacements apply in order, each to the result of the one before, so a batch is one atomic write.
 */
import type { LineChange } from './snapshots.js';

export interface TextReplacement {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll?: boolean;
}

export type ReplaceResult =
  | { ok: true; text: string; changed: LineChange[]; replaced: number }
  | { ok: false; reason: string };

const occurrences = (text: string, needle: string): number[] => {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length))
    found.push(at);
  return found;
};

/** A quote copied from file_read's `N:` display carries the numbers; the file does not. */
const withoutLineNumbers = (quote: string): string | null => {
  const lines = quote.split('\n');
  if (!lines.every((line) => /^\d+:/.test(line))) return null;
  return lines.map((line) => line.replace(/^\d+:/, '')).join('\n');
};

/** The file's own spelling of a quote that differs from it only in trailing whitespace. */
const ignoringLineEnds = (text: string, quote: string): string | null => {
  const pattern = quote
    .split('\n')
    .map((line) => line.replace(/[ \t\r]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[ \\t\\r]*\\n');
  const matches = [...text.matchAll(new RegExp(`${pattern}[ \\t\\r]*(?=\\n|$)`, 'g'))];
  return matches.length === 1 ? matches[0]![0] : null;
};

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** The nearest line to a missed quote, so the retry can be one corrected quote rather than a read. */
const nearest = (text: string, quote: string): string => {
  const first = quote
    .split('\n')
    .find((line) => line.trim().length >= 4)
    ?.trim();
  if (!first) return '';
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.includes(first));
  return index < 0 ? '' : ` Its first line appears at line ${index + 1}: ${lines[index]!.trim()}`;
};

export const applyReplacements = (
  path: string,
  replacements: readonly TextReplacement[],
  original: string
): ReplaceResult => {
  let text = original;
  let replaced = 0;
  for (const [index, replacement] of replacements.entries()) {
    const label = replacements.length > 1 ? `Replacement ${index + 1} for ${path}` : path;
    let { oldText } = replacement;
    if (!oldText) return { ok: false, reason: `${label}: oldText is empty.` };
    if (oldText === replacement.newText)
      return { ok: false, reason: `${label}: oldText and newText are identical.` };
    let at = occurrences(text, oldText);
    if (!at.length) {
      const respelled = [withoutLineNumbers(oldText) ?? oldText]
        .flatMap((quote) => [quote, ignoringLineEnds(text, quote)])
        .find((quote): quote is string => Boolean(quote) && occurrences(text, quote!).length > 0);
      if (respelled) {
        oldText = respelled;
        at = occurrences(text, oldText);
      }
    }
    if (!at.length)
      return {
        ok: false,
        reason: `${label}: oldText was not found. Quote the current text exactly, including whitespace.${nearest(text, oldText)}`
      };
    if (at.length > 1 && !replacement.replaceAll)
      return {
        ok: false,
        reason: `${label}: oldText occurs ${at.length} times (lines ${at
          .slice(0, 6)
          .map((position) => lineOf(text, position))
          .join(', ')}). Include more surrounding text, or set replaceAll.`
      };
    text = replacement.replaceAll
      ? text.split(oldText).join(replacement.newText)
      : text.slice(0, at[0]) + replacement.newText + text.slice(at[0]! + oldText.length);
    replaced += at.length;
  }
  return { ok: true, text, changed: changedSpan(original, text), replaced };
};

/** The one span of lines that differs between two versions, found from both ends. */
const changedSpan = (before: string, after: string): LineChange[] => {
  const old = before.split('\n');
  const next = after.split('\n');
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head += 1;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail += 1;
  if (head === old.length && head === next.length) return [];
  return [
    {
      oldFrom: head + 1,
      oldTo: old.length - tail,
      newFrom: head + 1,
      newTo: next.length - tail
    }
  ];
};
