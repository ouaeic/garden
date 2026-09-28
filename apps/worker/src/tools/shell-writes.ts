import path from 'node:path';
import { GardenError } from '@garden/core';
import { type AgentState } from '../agent-state.js';
import {
  commandInterpreters,
  commandScript,
  effectiveCommands
} from '../command-classification.js';
import { displayedRanges, firstUnshownLine } from '../edit/index.js';
import { textValue } from '../values.js';

/**
 * The shell forms of `file_write`, held to the record `file_write` is held to.
 *
 * `file_write` of a file the turn has read part of is refused until the reads cover it, because a
 * whole-file write after a window read is an edit made from memory of lines that were never on
 * screen - see the write arm in `workspace.ts`. `bash -lc 'echo x > app.ts'` is that write with the
 * same source of content, the model's own text, and nothing held it to anything: measured on a
 * real workspace, a reader shown lines 1-50 of a 400-line file ran it and the file was one line
 * afterwards, with no read, no card and no refusal on the way. The runner's own seen-line ledger
 * cannot see it either - a redirect reaches the disk without passing through the write route the
 * ledger guards - so the worker, which is the one process that has both the command and the read
 * record in front of it, is where the two meet.
 *
 * WHAT COUNTS AS A REPLACEMENT is deliberately the narrow thing: the forms that put whole content
 * over the file, the way `file_write` does. A truncating redirect, `tee` without `-a`, the
 * destination of `cp`, `mv`, `install` and a forced `ln`, `truncate`, `dd of=`, and sed's own `w`
 * command. An in-place transform - `sed -i`, `perl -pi` - reproduces none of the file from
 * memory, the pattern decides what changes, and the write arm itself sends the file no read can
 * cover to "a program from the shell"; so a program, and a transform, stay outside this, and
 * `shell-writes.test.ts` states that as a case that fails the day it stops being true. So does a
 * restore from the file's own backup or its own temporary: `mv app.ts.tmp app.ts` at the end of
 * `sed … app.ts > app.ts.tmp` is the transform idiom, and `cp app.ts.orig app.ts` puts back bytes
 * nobody typed - unless the same script wrote that temporary from a literal, which is the memory
 * write wearing two commands.
 *
 * It is a refusal to the model and not a card to the owner, for the same reason the write arm's is:
 * the recovery is one the model can perform - read the rest, or patch the lines it was shown - and
 * the approval floor already prices a write inside checkpointed content as something a rewind puts
 * back. Nothing here changes what the floor asks.
 */

/** One file a command would replace whole, and the words of the command that would do it. */
export type ShellReplacement = {
  /** The target as the command spelled it, before any resolution against the cwd. */
  readonly target: string;
  /** The fragment of the command that names the replacement, for the refusal to quote. */
  readonly by: string;
};

/** A token that is a redirection operator on its own, whose target is the token after it. */
const REDIRECT_OPERATOR = /^(?:\d|&)?[<>]{1,2}\|?$/;
/** A token that is a redirection with its target attached: `>app.ts`, `2>&1`, `<in`. */
const ATTACHED_REDIRECT = /^(?:\d|&)?[<>]/;
/** A truncating redirect operator: `>`, `>|`, `&>`, `2>` - and not `>>`, `<`, `<>`. */
const TRUNCATING_OPERATOR = /^(?:\d|&)?>\|?$/;

/**
 * A shell word with its quoting taken off the way the shell takes it off: `app''.ts`, `"app".ts`,
 * `app\.ts` and `$'app.ts'` are all `app.ts` once the shell has read them, and each of the four
 * reached the runner while the target was read up to its first quote.
 */
const unquote = (token: string): string => token.replace(/\$(?=['"])/g, '').replace(/['"\\]/g, '');

/**
 * The words of a script as a shell would split them: on whitespace and on the operators that end a
 * word, with a quoted span kept inside its word and its quotes kept on. The point of doing this
 * rather than scanning the text for `>` is that a `>` inside quotes is text and not a redirect -
 * `git commit -am "… > app.ts"`, `awk '$1 > "app.ts"'`, `rg -n "> app.ts" scripts/` - and a
 * `\>` is a literal too. Each of those was refused as a whole-file write of a file that
 * happened to be named inside a string.
 */
const shellWords = (script: string): string[] => {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  const end = (): void => {
    if (word) words.push(word);
    word = '';
  };
  for (let at = 0; at < script.length; at += 1) {
    const character = script[at] ?? '';
    if (quote) {
      word += character;
      if (character === quote) quote = null;
      else if (character === '\\' && quote === '"') {
        word += script[at + 1] ?? '';
        at += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      word += character;
      continue;
    }
    if (character === '\\') {
      word += character + (script[at + 1] ?? '');
      at += 1;
      continue;
    }
    if (/\s/.test(character)) {
      end();
      continue;
    }
    // `>|` is one operator, the redirect that forces past noclobber, and not a redirect and a pipe.
    if (character === '|' && word.endsWith('>')) {
      word += character;
      continue;
    }
    if (';|&()\n'.includes(character)) {
      end();
      words.push(character);
      continue;
    }
    word += character;
  }
  end();
  return words;
};

/** The words that end one command and begin the next. */
const SEGMENT_BREAK = new Set([';', '|', '&', '(', ')', '\n']);

/**
 * Every truncating redirect in a script, with the head of the command it belongs to, read from
 * the shell's own words so that quoting decides what is an operator and what is text.
 */
const truncatingRedirects = (script: string): Array<ShellReplacement & { head: string }> => {
  const found: Array<ShellReplacement & { head: string }> = [];
  const words = shellWords(script);
  let head = '';
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? '';
    if (SEGMENT_BREAK.has(word)) {
      head = '';
      continue;
    }
    if (!head && !ATTACHED_REDIRECT.test(word) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
      head = unquote(word).split('/').pop() ?? '';
    // A quoted word handed to an interpreter is a script of its own, and its redirects are real:
    // `sh -c "echo x > app.ts"` writes the file as surely as the bare form does.
    if (commandInterpreters.has(head) && /^\$?["']/.test(word)) {
      found.push(...truncatingRedirects(word.replace(/^\$?["']/, '').replace(/["']$/, '')));
      continue;
    }
    if (TRUNCATING_OPERATOR.test(word)) {
      const next = words[at + 1] ?? '';
      if (next && !next.startsWith('&') && !SEGMENT_BREAK.has(next)) {
        found.push({ target: unquote(next), by: `${word} ${unquote(next)}`, head });
        at += 1;
      }
      continue;
    }
    const attached = /^((?:\d|&)?>\|?)(?![>&])(.+)$/.exec(word);
    if (attached) {
      const target = unquote(attached[2] ?? '');
      if (target) found.push({ target, by: `${attached[1] ?? '>'} ${target}`, head });
    }
  }
  return found;
};

/**
 * A command's operands with the redirections taken out, so `cp a b > log` has `b` as its last
 * operand and not `log`. The redirect targets are read separately, over the whole script.
 */
const withoutRedirects = (tokens: readonly string[]): string[] => {
  const kept: string[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] ?? '';
    if (REDIRECT_OPERATOR.test(token)) {
      at += 1;
      continue;
    }
    if (ATTACHED_REDIRECT.test(token)) continue;
    kept.push(unquote(token));
  }
  return kept;
};

const isFlag = (token: string): boolean => token.startsWith('-') && token !== '-';

/** The commands whose redirected output is text the model authored rather than a program's. */
const AUTHORING_HEADS = new Set(['echo', 'printf', 'cat', 'tee']);

/**
 * Whether a copy or move restores the target from a file derived from it - its backup, its
 * original, its temporary - rather than replacing it with something else. Named after the target,
 * and not written from a literal by this same script.
 */
const restoresFromItsOwn = (
  source: string,
  target: string,
  authored: ReadonlySet<string>
): boolean => {
  const sourceName = source.split('/').pop() ?? '';
  const targetName = target.split('/').pop() ?? '';
  return (
    sourceName.length > targetName.length &&
    sourceName.startsWith(targetName) &&
    !authored.has(source)
  );
};

/**
 * The files a command would replace whole, in the words the command used.
 *
 * Read from the same view of the call every other classifier reads - `effectiveCommands` takes the
 * wrappers, prefixes and nested interpreters off - and from the script's own words for the
 * redirects, because a redirect is not an operand of anything.
 */
export const shellReplacements = (args: Record<string, unknown>): ShellReplacement[] => {
  const found: ShellReplacement[] = [];
  const redirects = truncatingRedirects(commandScript(args));
  const authored = new Set(
    redirects.filter((redirect) => AUTHORING_HEADS.has(redirect.head)).map((r) => r.target)
  );
  for (const { target, by } of redirects) found.push({ target, by });
  for (const [executable = '', ...rest] of effectiveCommands(args)) {
    const name = executable.toLowerCase();
    const operands = withoutRedirects(rest);
    if (name === 'tee') {
      if (operands.some((token) => token === '--append' || /^-[a-zA-Z]*a/.test(token))) continue;
      for (const target of operands.filter((token) => !isFlag(token)))
        found.push({ target, by: `tee ${target}` });
      continue;
    }
    if (name === 'cp' || name === 'mv' || name === 'install' || name === 'ln') {
      // `-t DIR` puts every operand on the source side, and `-n` refuses to replace anything. A
      // link replaces its target only when forced.
      if (
        operands.some(
          (token) =>
            token === '-t' ||
            token.startsWith('--target-directory') ||
            token === '--no-clobber' ||
            /^-[a-zA-Z]*n/.test(token)
        )
      )
        continue;
      if (
        name === 'ln' &&
        !operands.some((token) => token === '--force' || /^-[a-zA-Z]*f/.test(token))
      )
        continue;
      const files = operands.filter((token) => !isFlag(token));
      if (files.length < 2) continue;
      const target = files[files.length - 1] ?? '';
      const source = files[files.length - 2] ?? '';
      if (
        (name === 'cp' || name === 'mv') &&
        files.length === 2 &&
        restoresFromItsOwn(source, target, authored)
      )
        continue;
      found.push({ target, by: `${name} … ${target}` });
      continue;
    }
    if (name === 'truncate') {
      for (let at = 0; at < operands.length; at += 1) {
        const token = operands[at] ?? '';
        if (token === '-s' || token === '--size' || token === '-r' || token === '--reference') {
          at += 1;
          continue;
        }
        if (!isFlag(token)) found.push({ target: token, by: `truncate ${token}` });
      }
      continue;
    }
    if (name === 'dd') {
      for (const token of operands)
        if (token.startsWith('of=') && token.length > 3)
          found.push({ target: token.slice(3), by: `dd ${token}` });
      continue;
    }
    if (name === 'sed') {
      // sed's `w file` command, alone or closing a substitution, truncates the file it names. The
      // script arrives as whitespace-split tokens with their quotes on, so it is read joined.
      const text = rest.map(unquote).join(' ');
      for (const match of text.matchAll(/(?:^|[\s;/])w\s+([^\s;]+)/g)) {
        const target = match[1] ?? '';
        if (target) found.push({ target, by: `sed w ${target}` });
      }
    }
  }
  return found;
};

/**
 * The two spellings of a workspace file, folded the way the runner folds them.
 *
 * `assertUserDataPath` in the runner reads `app.ts` and `workspace/app.ts` as one file: a bare name
 * is placed under `workspace/`, and a name whose first segment is one of the container's own
 * directories is left where it is. The read record is keyed by the spelling the model used, so the
 * recorded key is folded with that rule, and a shell target is resolved against the cwd the call
 * named - which the runner reads relative to the container root, not to `workspace/`.
 */
const CONTAINER_ONLY = new Set(['.garden', '.config', '.home']);

const foldRecorded = (recorded: string): string | undefined => {
  const normal = path.posix.normalize(recorded.replace(/\\/g, '/'));
  if (!normal || normal === '.' || normal.startsWith('/') || normal.startsWith('..'))
    return undefined;
  const first = normal.split('/')[0] ?? '';
  return first === 'workspace' || CONTAINER_ONLY.has(first) ? normal : `workspace/${normal}`;
};

/**
 * Where a shell target lands, or `undefined` for one the floor cannot name: absolute, home-relative,
 * climbing out of the container, or something the shell would expand before it became a path.
 *
 * The cwd is read as the runner reads it - `resolveInside(root, cwd)` - so `''` is the container
 * root and not `workspace/`, and `workspace/..` and `workspace/src/..` are the directories they
 * normalise to. Read any other way the floor named a file the command does not touch and missed
 * the one it does: `cwd: ''` with `> app.ts` writes `<root>/app.ts`, and was refused as the
 * workspace file; `cwd: 'workspace/src/..'` with `> app.ts` writes the workspace file, and ran.
 */
const resolveTarget = (target: string, cwd: string): string | undefined => {
  if (!target || /^[/~]/.test(target) || /[$*?[\]{}]/.test(target)) return undefined;
  if (/^[/~]/.test(cwd)) return undefined;
  const base = path.posix.normalize(cwd || '.');
  if (base.startsWith('..')) return undefined;
  const resolved = path.posix.normalize(path.posix.join(base === '.' ? '' : base, target));
  return resolved.startsWith('..') ? undefined : resolved;
};

/**
 * Whether a script changes directory, which re-bases every path after it. `cd` is what a script
 * writes; `pushd` is the other spelling. A script that does either is not resolved at all, because
 * the alternative is refusing a file the command does not touch.
 */
const changesDirectory = (args: Record<string, unknown>): boolean =>
  effectiveCommands(args).some(
    ([executable = '']) => executable === 'cd' || executable === 'pushd'
  );

/**
 * Refuses a shell command that would replace, whole, a file this window has been shown only part
 * of.
 *
 * The question is the one the write arm asks, of the same record: `partialReads` names the files
 * the window's reads have not been shown to reach the end of, and `firstUnshownLine` says where
 * the shown lines stop. A file read whole, or never read, has no entry and is not asked about -
 * the first write to a file nobody has read lands, exactly as it must, and a shell command is held
 * to nothing more than `file_write` is. `reader` is whose record: the task for the lead, and the
 * window's own name for a specialist.
 */
export const refuseShellReplacementOfUnread = (
  reader: string,
  state: AgentState,
  args: Record<string, unknown>
): void => {
  const outstanding = Object.entries(state.partialReads ?? {});
  if (!outstanding.length) return;
  const replacements = shellReplacements(args);
  if (!replacements.length || changesDirectory(args)) return;
  // The runner's own default when the call names no cwd; a cwd the call did name is read as it
  // was written, `''` included.
  const cwd = args.cwd === undefined ? 'workspace' : textValue(args.cwd);
  for (const [recorded, atLeast] of outstanding) {
    const key = foldRecorded(recorded);
    if (key === undefined) continue;
    const hit = replacements.find((candidate) => resolveTarget(candidate.target, cwd) === key);
    if (!hit) continue;
    const unshownFrom = firstUnshownLine(displayedRanges(reader, recorded), atLeast);
    if (unshownFrom === undefined) continue;
    throw new GardenError(
      'write_unread',
      /*
       * The same two sentences the write arm uses, because it is the same refusal. One outstanding
       * line is the file with no newlines in it, whose only route through is a program - and this
       * floor leaves a program alone on purpose, so naming that recovery is naming one that works.
       */
      atLeast === 1
        ? `\`${hit.by}\` would replace ${recorded} whole, and ${recorded} is a single line too long to be delivered in one read, so you have been shown only the start of it and replacing it would discard the rest. Transform it with a program from the shell instead - read the file, change it, write it back - so nothing depends on you having seen all of it.`
        : `\`${hit.by}\` would replace ${recorded} whole, the way file_write does, and ${recorded} has at least ${atLeast} lines of which line ${unshownFrom} onwards has never been shown to you - so the part you have not read would be discarded by a command nothing checks. Either read from line ${unshownFrom} with file_read using startLine and endLine and then run this command again, or change only the lines you were shown with file_patch, which leaves the rest of the file exactly as it is.`
    );
  }
};
