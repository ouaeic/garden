/**
 * "The block that opens at line N", without a parser.
 *
 * `PUT 40*:` means replace the function, class, object or suite that begins on line 40, so the
 * model names one number instead of counting to the closing brace. Counting to the closing brace
 * is precisely what models get wrong, so the operation earns its place - but only if the harness
 * can find the same end the model meant.
 *
 * A real syntax tree would be exact. garden has no parser in the worker and adding one to test an
 * edit format would be building the expensive half first, so this uses two rules that between them
 * cover the languages garden actually edits:
 *
 *   - bracket depth, for anything with braces or parentheses: from the opening line, count
 *     `{[(` against `}])` until the depth returns to zero;
 *   - indentation, for anything without them: the block runs while the following lines are blank
 *     or indented further than the opening line.
 *
 * The honest limitation, stated because a measurement built on a silent approximation is worth
 * nothing: the bracket scanner skips string and character literals and `//`, `#` and `--` line
 * comments, but it does not understand nested template substitutions, regular-expression literals
 * containing brackets, or here-documents. Where it is wrong it is wrong by picking too late a
 * closing line, which the applier catches as an overlap or the model catches in the response - it
 * does not silently pick a plausible-but-wrong smaller range. `evals/edit/` measures the block
 * operation only on cases this can resolve, and says so.
 */

const OPENERS = '{[(';
const CLOSERS = '}])';

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Bracket depth after this line, ignoring literals and line comments.
 *
 * Returns the delta, so a caller accumulates it across lines. `inString` carries an unterminated
 * template or string across the newline, which is the only multi-line literal this handles.
 */
const scanLine = (line: string, state: { quote: string }): number => {
  let delta = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    if (state.quote) {
      if (character === '\\') index += 1;
      else if (character === state.quote) state.quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      state.quote = character;
      continue;
    }
    if (character === '/' && line[index + 1] === '/') break;
    if (character === '-' && line[index + 1] === '-') break;
    if (character === '#') break;
    if (OPENERS.includes(character)) delta += 1;
    else if (CLOSERS.includes(character)) delta -= 1;
  }
  // A single-quoted or double-quoted literal never spans a line; only a template does.
  if (state.quote === '"' || state.quote === "'") state.quote = '';
  return delta;
};

/**
 * The zero-based inclusive range of the block opening at `index`.
 *
 * A line that opens nothing and is followed by nothing more indented is its own block, which makes
 * `PUT N*:` degrade to `PUT N:` rather than to an error.
 */
export const blockAt = (
  lines: readonly string[],
  index: number
): { readonly from: number; readonly to: number; readonly closed: boolean } => {
  const opening = lines[index];
  if (opening === undefined) return { from: index, to: index, closed: false };

  const state = { quote: '' };
  let depth = scanLine(opening, state);
  if (depth > 0) {
    for (let line = index + 1; line < lines.length; line += 1) {
      depth += scanLine(lines[line] as string, state);
      if (depth <= 0) return { from: index, to: line, closed: true };
    }
    /*
     * Unbalanced to the end of what was handed in: the file is mid-edit, the scanner met something
     * it does not understand, or - the common case now - the lines handed in are a WINDOW and the
     * block runs off the end of it. Claiming the rest would be the destructive answer, so claim
     * nothing and say the block never closed. `apply.ts` turns that into a refusal that names the
     * line, rather than into a silent one-line replacement of the opening brace.
     */
    return { from: index, to: index, closed: false };
  }

  const base = indentOf(opening);
  let last = index;
  for (let line = index + 1; line < lines.length; line += 1) {
    const text = lines[line] as string;
    if (!text.trim()) continue;
    if (indentOf(text) <= base) break;
    last = line;
  }
  // An indented suite closes by dedent or by running out of lines, and both are a real end.
  return { from: index, to: last, closed: true };
};
