/**
 * The line-addressed edit format: how a file is shown, and how two versions of a line are compared.
 *
 * garden's editor used to be oldText/newText with an exactly-once guard. That guard is what made
 * it safe and also what made it expensive: to change one line inside a function that says
 * `return null;` eleven times, the model had to quote enough surrounding text to be unique and then
 * quote all of it back with one word different. The cost of an edit was set by how repetitive the
 * file is, not by how large the edit is. Measured over fifteen tasks on this repository's own
 * corpus, addressing by line number instead cost 61% fewer characters of tool arguments, winning
 * fourteen of the fourteen rows where both formats did what the task asked.
 *
 * Two decisions in this file are load-bearing.
 *
 * 1. NORMALISATION strips trailing spaces, tabs and carriage returns before any two lines are
 *    compared. A file written on a machine that ends lines with CRLF, or a line the model copied
 *    back through a display that trims, must not be a different line. Leading whitespace is
 *    indentation and is content; inner whitespace is content. Only the tail is invisible to a
 *    reader, and therefore only the tail may vary. Every comparison in `apply.ts` goes through
 *    `sameLine`, so this is not advice - there is no other way to compare lines here.
 *
 * 2. THERE IS NO TAG. The reference dialect this was measured against heads every read and every
 *    patch with a short whole-file hash, and its own harness carries a hand-maintained list of
 *    models that "drop the tag header" often enough to be routed to a lenient parser. A header the
 *    model can drop is a header the harness can do without: the path arrives in a JSON field the
 *    schema guarantees, and freshness is proved by comparing the harness's own record of what it
 *    displayed against the file as it reads now - which is strictly better evidence than sixteen
 *    bits of hash, because it can also say WHERE the lines went. The named failure mode is designed
 *    out rather than tolerated, which is the whole thesis of this lane.
 *
 *    Dropping it is also a read-side saving: a header line on every read is bytes on every read,
 *    and forcing a whole-file digest would make a windowed read of a two-gigabyte log walk to the
 *    end of the file. `services/workspace-runner/src/files.ts` reads a window in a fixed buffer and
 *    stops as soon as it has one, deliberately, after a database dump buffered a gigabyte and the
 *    OOM killer took the runner down with every other tool on it. Nothing here reopens that.
 */

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

/**
 * A file as the model is shown it: `LINE:TEXT`, one-based, no header.
 *
 * This is the whole read-side cost of the format and it is not hidden anywhere - it is the decimal
 * line number and one colon per line, and `docs/design/edit/BUILD.md` measures it on this
 * repository rather than asserting it.
 */
export const renderNumbered = (lines: readonly string[], startLine = 1): string =>
  lines.map((line, index) => `${startLine + index}:${line}`).join('\n');

/**
 * A numbered window of a file, clamped, for handing evidence back inside a refusal.
 *
 * Every refusal in `apply.ts` carries one of these. A refusal that costs a round trip is barely
 * better than the wrong edit it prevented: the model re-reads, re-derives the same patch, and the
 * owner pays for two turns to get one edit.
 */
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

/** `41` for a single line, `41-48` for a run - the spelling every message in this module uses. */
export const sayRange = (from: number, to: number): string =>
  from === to ? `${from}` : `${from}-${to}`;

/**
 * How many non-space characters an anchor needs before it can find a line on its own.
 *
 * Below this a `-` row is a lone brace, a `return;`, a blank - text that stands on a dozen lines
 * of any file - and matching it against the file would be matching nothing. Such an anchor is
 * still accepted, but only where the lines beside it also read as the ledger recorded them, which
 * is the one piece of evidence a short row cannot carry by itself.
 */
export const STRONG_ANCHOR_CHARS = 8;

/**
 * The characters a serialiser, a chat surface or a keyboard swaps for their ASCII neighbours.
 *
 * Curly quotes, the dash family and the no-break space render as the ASCII character they stand
 * in for, so a model that copied a line out of its own context cannot see that it sent a
 * different byte. They are folded on BOTH sides of an anchor comparison and never in a body: an
 * anchor only has to find a line, and a body is the text that lands.
 */
const LOOKALIKES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, '-'],
  [/\u00A0/g, ' ']
];

/**
 * A line as an anchor comparison sees it - and ONLY an anchor comparison.
 *
 * Trailing whitespace goes the way it goes everywhere here. Then the lookalikes above, and then the
 * whole run of leading whitespace collapses to one tab, so a `-` row retyped with spaces finds a
 * tab-indented line: leading whitespace is content in the file and stays content in every body
 * row, but a row whose only job is to say WHICH line is meant does not need to spell the
 * indentation right to say it. Nothing here is edit distance, and nothing here ever will be:
 * the field's measured record of fuzzy anchors is that they either never fire or corrupt files.
 */
export const foldAnchor = (line: string): string => {
  let out = normaliseLine(line);
  for (const [pattern, ascii] of LOOKALIKES) out = out.replace(pattern, ascii);
  return out.replace(/^[ \t]+/, '\t');
};

/** Whether an anchor is too short to find a line on its own. @see STRONG_ANCHOR_CHARS */
export const isWeakAnchor = (anchor: string): boolean =>
  foldAnchor(anchor).replace(/\s/g, '').length < STRONG_ANCHOR_CHARS;

/**
 * Whether `anchor` is the start of `line`, once both are folded.
 *
 * A prefix and not an equality, because the spec asks for the START of the line: a model that
 * quotes eight characters has said which line it means, and asking it to type the rest is asking
 * it to pay for the quoted editor this format replaced. A blank anchor matches only a blank line.
 */
export const anchorPrefixes = (anchor: string, line: string): boolean => {
  const wanted = foldAnchor(anchor);
  const folded = foldAnchor(line);
  return wanted === '' ? folded === '' : folded.startsWith(wanted);
};

/** Whether a line begins the way a numbered display begins: digits, then `:`, `|` or a tab. */
export const looksNumbered = (line: string): boolean => /^\d+(?::|\||\t)/.test(line);

/**
 * A row that begins with the display's own line number, and the text behind it.
 *
 * `12:    return null;` copied straight out of a read, or `12|` and `12<tab>` from the displays
 * other tools use. The prefix is only taken off when the number is the one the row was already
 * addressed at - `expected` - because then it says nothing the operation row did not say. A row
 * whose number disagrees is left byte for byte as it came: it may be a real line beginning with
 * digits, and a stripped prefix that moved an edit would be worse than any refusal.
 *
 * `standing` is what the file itself holds at that line, when the caller knows. A file whose line
 * 4 reads `4:00 lunch` - a schedule, a verse reference, a ratio table, a `4|` grid row - has
 * lines that begin the way a display begins, and a row copied from it is content that only looks
 * leaked. So a prefix is never taken off where the line it lands on already carries one: the
 * digits at the front of that line are evidence the digits at the front of the row are text.
 */
export const stripLeakedPrefix = (
  row: string,
  expected: number,
  standing?: string
): { readonly text: string; readonly stripped: boolean } => {
  const leaked = /^(\d+)(?::|\||\t)([\s\S]*)$/.exec(row);
  if (!leaked || Number(leaked[1]) !== expected) return { text: row, stripped: false };
  if (standing !== undefined && looksNumbered(standing)) return { text: row, stripped: false };
  return { text: leaked[2] as string, stripped: true };
};
