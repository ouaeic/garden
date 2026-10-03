/** How a file is shown to the model, and how two versions of a line are compared. */

/**
 * Trailing space, tab and CR are dropped; nothing else is.
 *
 * `\r` is stripped along with the spaces rather than separately because a CRLF file whose lines
 * also have trailing spaces ends them `" \r"`, and a rule that only knew about `\r` would leave
 * the space behind and call the line different.
 */
export const normaliseLine = (line: string): string => line.replace(/[ \t\r]+$/, '');

/** Whether two lines are the same line, once the invisible tail is discounted. */
export const sameLine = (left: string, right: string): boolean =>
  normaliseLine(left) === normaliseLine(right);

/** Whether two runs of lines are the same run. */
export const sameLines = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((line, index) => sameLine(line, right[index] ?? ''));

/**
 * Splitting text into lines, once, in the one way the whole vertical agrees on.
 *
 * Lines are separated by newlines, not terminated by them, so a file ending in a newline has a
 * final empty line and a two-line file that ends in one reads as three. That is what
 * `String.split('\n')` does, what the runner's ranged reader does (it says so), and therefore what
 * the numbers in a read mean. Anything that trimmed it here would number the file differently from
 * the way the runner numbers it, and every edit near the end of a file would be off by one.
 */
export const toLines = (text: string): string[] => text.split('\n');

/** A file as the model is shown it: `LINE:TEXT`, one-based, no header. */
export const renderNumbered = (lines: readonly string[], startLine = 1): string =>
  lines.map((line, index) => `${startLine + index}:${line}`).join('\n');

/** A numbered, clamped window of a file. */
export const numberedWindow = (
  lines: readonly string[],
  around: { from: number; to: number },
  radius: number
): string => {
  const from = Math.max(1, around.from - radius);
  const to = Math.min(lines.length, around.to + radius);
  if (to < from) return '';
  return renderNumbered(lines.slice(from - 1, to), from);
};
