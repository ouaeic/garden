import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle
} from 'node:fs/promises';
import path from 'node:path';
import {
  discloseUnseen,
  displayedLines,
  fileIdentity,
  lineEdit,
  recordDisplayedLines,
  rememberWrite,
  sayRanges,
  unseenWithin,
  type LineEdit,
  type Reader
} from './seen-lines.js';

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A file error the caller should answer with something other than "bad request". The runner's
 * error handler reads the status off it, so "there is already a folder called that" arrives as a
 * conflict the file browser can explain instead of a generic failure it cannot.
 */
export class WorkspaceFileError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'WorkspaceFileError';
  }
}

export const workspacePath = (root: string, workspaceId: string): string => {
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error('Invalid workspace ID');
  return path.join(path.resolve(root), workspaceId.toLowerCase());
};

/**
 * A step upwards is `..` on its own or `..` followed by a separator - it is not "the name begins
 * with two dots". `path.relative` answers `..gitignore` for a file of that name sitting in the
 * root, and reading that as an escape refused every top-level entry whose name happens to start
 * that way: `..backup`, a `cwd` called `..build`, `..gitignore` itself. The agent creates
 * `workspace/..backup/` from a shell command, asks to list it, and is told its path escapes the
 * workspace - an accusation instead of a correction, and `assertUserDataPath` runs this check
 * before the fold that exists precisely to stop the agent guessing at prefixes.
 */
export const resolveInside = (root: string, requested = '.'): string => {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Path escapes workspace');
  return resolved;
};

const ARTIFACTS = path.join('.garden', 'artifacts');

/**
 * The agent's `$HOME`, named once. `ensureWorkspace` below is what creates it and execution.ts's
 * `agentHome` is what puts it in a command's environment; while those were two literals, moving
 * one of them left the runner setting a `HOME` that nothing had made - which `bash` does not create
 * for itself and `python3 -m venv $HOME/venv` does not either.
 *
 * At the container root rather than inside `workspace/`, for the two reasons execution.ts's
 * `agentHome` sets out: `workspace/` is the checkpoint's content, and a bare name folds into
 * `workspace/`.
 */
export const AGENT_HOME = '.home';

const isUserData = (relative: string): boolean =>
  relative === 'workspace' ||
  relative.startsWith(`workspace${path.sep}`) ||
  relative === ARTIFACTS ||
  relative.startsWith(`${ARTIFACTS}${path.sep}`);

/**
 * The container's own directories, which are not the agent's and are never a bare name's meaning.
 * `.garden` holds the runner's private state - the browser profile among it - `.config` the
 * guest's settings, and `.home` the agent's `$HOME` (execution.ts `agentHome`), which holds the
 * coding CLIs' OAuth credentials and the `.bashrc` the owner's own terminal sources. `workspace`
 * is left out on purpose: a path already rooted there is user data and is accepted above before
 * this is consulted.
 *
 * `.home` is here for the fold rather than for the resolve. Nothing under the container root has
 * ever been reachable - `isUserData` admits `workspace/` and `.garden/artifacts` and nothing else,
 * so `.home/.bashrc` could only ever have become `workspace/.home/.bashrc`, an inert file. Naming
 * it says no outright instead, which is the honest answer and is also the answer that stays right
 * if `$HOME` is ever moved back under `workspace/`. It refuses no legitimate work: a real
 * `workspace/.home` is still reachable by writing that prefix, which the branch above accepts.
 */
const CONTAINER_ONLY = new Set(['.garden', '.config', AGENT_HOME]);

/**
 * Where a path the agent gave means what the agent meant by it.
 *
 * Commands run in `workspace/`, so an agent that has just listed its own directory and asks to
 * write `notes.md` means `workspace/notes.md`. This resolved against the container one level up
 * instead, where nothing of the agent's lives and nothing is writable, so the write was refused -
 * and the agent, told only that the path was wrong, guessed at prefixes and spent the owner's
 * money doing it. A plain relative name is therefore read the way the shell reads it.
 *
 * Only a plain one. A path that is absolute, that steps upwards through `..`, or that names one of
 * the container's own directories is resolved and checked exactly as before, and refused if it
 * lands outside the two roots. Folding those back inside would answer an attempt worth seeing with
 * a write worth nothing: an agent reaching for `.garden/browser/Cookies` should be told no, not
 * quietly handed `workspace/.garden/browser/Cookies`. This changes which directory a bare name
 * starts from, not what any path is allowed to reach.
 */
export const assertUserDataPath = (root: string, requested = 'workspace'): string => {
  const resolvedRoot = path.resolve(root);
  const asGiven = path.relative(resolvedRoot, resolveInside(root, requested));
  if (isUserData(asGiven)) return asGiven;
  const segments = requested.split(/[/\\]/).filter(Boolean);
  const bareName =
    !path.isAbsolute(requested) &&
    !segments.includes('..') &&
    !CONTAINER_ONLY.has(segments[0] ?? '');
  if (bareName) {
    const nested = path.relative(
      resolvedRoot,
      resolveInside(root, path.join('workspace', requested))
    );
    if (isUserData(nested)) return nested;
  }
  throw new Error('Only workspace files and published artifacts are accessible');
};

/**
 * Where a command's `cwd` means what the agent meant by it: the reading `assertUserDataPath` gives
 * a file name, applied to the one field a command reads a directory from.
 *
 * The obvious resolution - against the container root, as every other path here - puts a bare
 * `probe` one level above where `file_write('probe/x')` lands, so the two tools answer the same
 * string with two places and the agent, which cannot see either, writes `workspace/probe` into a
 * command that already runs in `workspace/` and creates `workspace/workspace/probe`. Measured on a
 * live box across six of ten tasks and a shadow tree that had stood for weeks. A bare name is
 * therefore read from `workspace/`, so `probe` and `workspace/probe` are one directory.
 *
 * Unlike the file fold this refuses nothing new and admits nothing new: `.garden`, the guest's
 * `.config` and the agent's home stay where they are, an absolute path resolves as written, and
 * `resolveInside` still refuses anything that steps out of the container. A command may run in
 * `.garden/artifacts` or in `$HOME`, which a file tool may not write, and that difference is the
 * runner's to keep - so this shares the container-only list and not the user-data check.
 *
 * And `.` is the container root, not a bare name. The document reader and the office converter
 * are both run from `.` with a `workspace/…` path on their command line, and each resolves that
 * path against its own working directory and refuses anything outside it - so a `.` read as
 * `workspace/` makes every document read spelt the way the catalogue spells paths, and every
 * document search that takes the default path, fail on a file that is there.
 */
export const resolveCommandDirectory = (root: string, requested = 'workspace'): string => {
  const segments = requested.split(/[/\\]/).filter((segment) => segment && segment !== '.');
  const bareName =
    segments.length > 0 &&
    !path.isAbsolute(requested) &&
    !segments.includes('..') &&
    segments[0] !== 'workspace' &&
    !CONTAINER_ONLY.has(segments[0] ?? '');
  return resolveInside(root, bareName ? path.join('workspace', requested) : requested);
};

const rejectSymlinkComponents = async (
  root: string,
  target: string,
  allowMissing = false
): Promise<void> => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  let current = path.resolve(root);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Symbolic links are not allowed');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
};

/**
 * Proves that the descriptor just opened is the file the path described, rather than one a
 * symbolic link swapped in between the check and the open.
 *
 * The walk above answers the question at the time it runs, and the kernel answers it again when
 * `open` resolves the path — and in between, every directory under `workspace/` is writable by the
 * agent's own account, so a component that passed can become a link into `.garden`, where the
 * browser profile the agent may not read lives. `O_NOFOLLOW` covers only the last component. These
 * two checks cover the rest: the walk again, which refuses a component that is a link now, and the
 * identity comparison, which refuses a descriptor that is not what the path names now. A swap has
 * to survive both at once, and one that has been put back no longer leads to the file the
 * descriptor is holding.
 */
export const assertOpenedInPlace = async (
  root: string,
  target: string,
  handle: FileHandle
): Promise<void> => {
  await rejectSymlinkComponents(root, target);
  const [opened, named] = await Promise.all([handle.stat(), lstat(target)]);
  if (opened.dev !== named.dev || opened.ino !== named.ino)
    throw new Error('The path changed while it was being opened');
};

/**
 * Agent commands run as a different Unix account than the runner, in a group both belong to, so
 * the home and the project tree are group-accessible and everything under `.garden` is not.
 * That single distinction is what keeps the browser profile - the cookie jar for every site the
 * owner has signed into - out of reach of a command, while leaving the agent free to work on its
 * own files. The parent directory carries the set-group-ID bit so the group is inherited by
 * everything created below, whichever account created it.
 */
const SHARED_MODE = 0o770;
const RUNNER_ONLY_MODE = 0o700;

/**
 * Linux creation is relative to an open directory, so swapping an ancestor cannot redirect mkdir
 * or O_CREAT before the descriptor identity check runs. Other hosts retain the checked-path
 * development behavior because their descriptor filesystem does not support directory traversal.
 */
export const withWorkspaceDirectory = async <T>(
  root: string,
  directory: string,
  create: boolean,
  work: (anchored: string, held?: FileHandle) => Promise<T>
): Promise<T> => {
  const target = resolveInside(root, directory);
  if (process.platform !== 'linux') {
    await rejectSymlinkComponents(root, target, create);
    if (create) await mkdir(target, { recursive: true, mode: SHARED_MODE });
    await rejectSymlinkComponents(root, target);
    return work(target);
  }
  let current = await open(
    path.resolve(root),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const relative = path.relative(path.resolve(root), target);
    for (const component of relative.split(path.sep).filter(Boolean)) {
      const child = path.join('/proc/self/fd', String(current.fd), component);
      if (create) {
        await mkdir(child, { mode: SHARED_MODE }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
      }
      const next = await open(
        child,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      const previous = current;
      current = next;
      await previous.close();
    }
    await assertOpenedInPlace(root, target, current);
    return await work(path.join('/proc/self/fd', String(current.fd)), current);
  } finally {
    await current.close();
  }
};

export const ensureWorkspace = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true, mode: SHARED_MODE });
  await mkdir(path.join(root, 'workspace'), { recursive: true, mode: SHARED_MODE });
  // The agent's own home, made by the runner rather than left to the first program that wants it:
  // `bash` does not create a missing `$HOME` and neither does `python3 -m venv $HOME/venv`, so a
  // home that appears only once something has already tried to write in it is a home half the
  // toolchain trips over. Shared with the agent account the same way `workspace/` is - both
  // accounts read and write these files through the group - and unlike `.garden`, which is the
  // runner's alone.
  await mkdir(path.join(root, AGENT_HOME), { recursive: true, mode: SHARED_MODE });
  await mkdir(path.join(root, '.garden', 'browser'), { recursive: true, mode: RUNNER_ONLY_MODE });
  await mkdir(path.join(root, '.garden', 'desktop'), { recursive: true, mode: RUNNER_ONLY_MODE });
  await mkdir(path.join(root, '.garden', 'artifacts'), {
    recursive: true,
    mode: RUNNER_ONLY_MODE
  });
};

export const listFiles = async (root: string, requested = '.'): Promise<unknown[]> => {
  const target = resolveInside(root, requested);
  await rejectSymlinkComponents(root, target);
  const entries = await readdir(target, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.name !== '.garden')
      .map(async (entry) => {
        const entryPath = path.join(target, entry.name);
        const details = await lstat(entryPath);
        /*
         * The one honest thing a folder can say about itself.
         *
         * `details.size` on a directory is the size of the directory record - 64 or 96 bytes on
         * APFS, 4096 on ext4 - so the file browser had nothing to print on a folder row and printed
         * the word "Folder". A count is one extra `readdir` per folder in the listing, alongside
         * the `lstat` each entry already costs, and it is bounded by what is on screen. A folder
         * the agent's account cannot read is left without a count rather than failing the listing
         * it appears in: the row is still real, it just says less.
         */
        const itemCount = entry.isDirectory()
          ? await readdir(entryPath).then(
              (names) => names.filter((name) => name !== '.garden').length,
              () => undefined
            )
          : undefined;
        return {
          name: entry.name,
          path: path.relative(root, entryPath),
          type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
          sizeBytes: details.size,
          modifiedAt: details.mtime.toISOString(),
          ...(itemCount === undefined ? {} : { itemCount })
        };
      })
  );
};

/** Big enough that an ordinary source file arrives in one read, small enough to cost nothing. */
const LINE_SCAN_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

/**
 * How much of a file a caller says it will put in front of a model, and therefore how much of it
 * this module will vouch for having been shown.
 *
 * Two numbers rather than one because the two failures are different: bytes bound what a result can
 * carry, and lines bound how many anchors a single read may authorise. A column of two-character
 * lines exhausts neither budget on its own.
 */
export type DisplayBudget = { maxBytes: number; maxLines: number };

/**
 * A display budget and the reader it is being spent on.
 *
 * `shownTo` is one field of the same object rather than an argument of its own because displaying
 * and recording are one act: the prefix that goes back over the wire is the prefix that is
 * recorded, and there is no way to ask for the one without saying who gets it. `undefined` is the
 * answer for a caller that is not a reader any record can be about - see `readerFor` - and it is
 * required rather than optional so that answering it is a decision somebody made rather than a line
 * nobody wrote.
 */
export type Display = DisplayBudget & { shownTo: Reader | undefined };

/** The longest prefix of `line` that is at most `limit` bytes and does not split a code point. */
const wholeCodePoints = (line: Buffer, limit: number): Buffer => {
  let end = Math.min(limit, line.length);
  // A continuation byte at the cut means the code point starts before it; step back off the run.
  while (end > 0 && ((line[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return line.subarray(0, end);
};

/**
 * The leading lines of a file that fit a display budget, counted the way `toLines` counts them.
 *
 * Lines are SEPARATED by newlines rather than terminated by them, so `a\nb\n` is three lines and the
 * third is empty - which is what `String.split('\n')` does on the worker side and therefore what the
 * numbers in a read mean. The loop below counts the same way on the bytes: it steps past a newline
 * to reach the next line, and the run of bytes after the last newline is a line too, including the
 * empty one at the end of a file that ends in a newline.
 *
 * `whole` is the load-bearing number. It is what gets recorded as displayed, and it counts only
 * lines that arrived entire: the one case where a line is delivered in half is a first line longer
 * than the whole budget, which cannot be served whole and must not be served empty - an answer of no
 * lines is a dead end the model cannot act on. That half-line is returned and is NOT counted, for
 * exactly the reason the ranged reader does not count its own: a record that vouched for the half
 * that never arrived is the blind anchor this whole module exists to refuse.
 */
export const displayablePrefix = (
  content: Buffer,
  display: DisplayBudget
): { prefix: Buffer; whole: number; partialLine: boolean } => {
  let offset = 0;
  let whole = 0;
  while (whole < display.maxLines) {
    const newline = content.indexOf(NEWLINE, offset);
    const end = newline === -1 ? content.length : newline + 1;
    if (end > display.maxBytes) break;
    offset = end;
    whole += 1;
    // Nothing follows the last run of bytes in the file, so that was the final line.
    if (newline === -1) break;
  }
  if (offset === content.length) return { prefix: content, whole, partialLine: false };
  if (whole === 0)
    return {
      prefix: wholeCodePoints(content, display.maxBytes),
      whole: 0,
      partialLine: content.length > 0
    };
  // Something is left, so the last counted line ended on a newline - and that newline separates it
  // from a line this read is not delivering, so it is not part of the answer.
  return { prefix: content.subarray(0, offset - 1), whole, partialLine: false };
};

/**
 * The whole file, and a display only when the caller says it is one.
 *
 * This route answers two callers that look identical on the wire and are opposites in meaning: an
 * unbounded `file_read`, which puts lines in front of the model, and the read-modify-write that
 * `file_patch` does one call before its write, which puts nothing in front of anybody. If this
 * recorded what it returned unconditionally, every patch would announce that the model had just seen
 * the whole file, and the seen-line guard below would be inert for the one tool it exists to guard.
 *
 * So the two are no longer identical on the wire. A caller that is about to DISPLAY what it gets
 * passes the budget it will display within, and gets back only that much of the file plus the whole
 * file's hash; that prefix, and nothing beyond it, is recorded as shown. A caller that passes no
 * budget gets the file and is recorded as having shown nothing, exactly as before.
 *
 * Handing back only the prefix is the point rather than an economy. The two ledgers - this one and
 * `apps/worker/src/edit/snapshots.ts` - disagreed for as long as the worker did the cutting after
 * the fact: an unwindowed read displayed lines 1-266 of a 600-line file and recorded 267-600 here,
 * so editing line 50, WHICH THE MODEL HAD BEEN SHOWN, was refused while editing line 400 was not.
 * A caller cannot display what it was never sent, so delivering the prefix is what makes the two
 * records the same set of lines by construction rather than by two implementations agreeing.
 */
export const readWorkspaceFile = async (
  root: string,
  requested: string,
  maxBytes: number,
  display?: Display
): Promise<{
  content: Buffer;
  sha256: string;
  /** Lines in the whole file, and how many of them the returned prefix carries whole. Display only. */
  totalLines?: number;
  displayedLines?: number;
  /** Whether one further line is included, cut short - the first line longer than the whole budget. */
  partialLine?: boolean;
}> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error('File read limit must be a nonnegative safe integer');
  const target = resolveInside(root, requested);
  await rejectSymlinkComponents(root, target);
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    await assertOpenedInPlace(root, target, handle);
    const details = await handle.stat();
    if (!details.isFile()) throw new Error('Requested path is not a regular file');
    if (details.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte read limit`);
    // Bound the reads themselves: a writable file can grow after its size was checked.
    const buffer = Buffer.alloc(Math.min(64 * 1024, details.size + 1));
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, details.size - bytes + 1),
        bytes
      );
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > details.size)
        throw new Error('The file changed while it was being read; read it again');
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat();
    await assertOpenedInPlace(root, target, handle);
    if (
      details.size !== after.size ||
      details.mtimeMs !== after.mtimeMs ||
      details.ctimeMs !== after.ctimeMs ||
      bytes !== after.size
    )
      throw new Error('The file changed while it was being read; read it again');
    const content = Buffer.concat(chunks, bytes);
    // The hash is of the FILE, not of what is returned: it is the caller's claim about what it is
    // replacing on a later write, and a digest of a prefix would be a claim about nothing.
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (!display) return { content, sha256 };
    const { prefix, whole, partialLine } = displayablePrefix(content, display);
    let totalLines = 1;
    for (let at = content.indexOf(NEWLINE); at !== -1; at = content.indexOf(NEWLINE, at + 1))
      totalLines += 1;
    // Recorded against the reader the bytes are going to, and not at all when the caller is not a
    // reader a record can be about: what a read proves is that one context window holds these
    // lines, and there is no such thing as a line the workspace has seen.
    if (whole >= 1 && display.shownTo)
      recordDisplayedLines(display.shownTo, target, fileIdentity(details), {
        start: 1,
        end: whole
      });
    return { content: prefix, sha256, totalLines, displayedLines: whole, partialLine };
  } finally {
    await handle.close();
  }
};

/**
 * A window of lines, read without the whole file ever being in memory.
 *
 * `readWorkspaceFile` is the right shape for a caller that needs every byte - a patch, an upload -
 * and the wrong one for a glance at a log. `file_read` asks for a few hundred lines and used to be
 * answered with the file: against the 2 GiB ceiling the installer sets, one look at a database
 * dump buffered a gigabyte inside a service the unit file caps at 80% of host memory, and the OOM
 * killer takes the runner down with every other tool on it. This walks the file in a fixed buffer,
 * keeps only the requested lines and only `maxBytes` of them, and stops as soon as it has them, so
 * what a read costs follows what was asked for rather than what the file happens to weigh.
 *
 * `totalLines` is therefore only there when the read reached the end of the file: counting the rest
 * would mean reading everything this exists to avoid, and `nextStartLine` and `sizeBytes` are what
 * the caller needs anyway. Lines are separated by newlines, not terminated by them, so a file
 * ending in one has a final empty line, exactly as splitting the whole string on newlines would.
 */
export const readWorkspaceFileLines = async (
  root: string,
  requested: string,
  window: {
    startLine: number;
    endLine: number;
    maxBytes: number;
    /**
     * Who these lines are being put in front of, or `undefined` for a caller no record can be about.
     * Required, because this arm always records what it delivered and a read that recorded against
     * nobody in particular is the defect this key exists to close.
     */
    shownTo: Reader | undefined;
  }
): Promise<{
  content: Buffer;
  startLine: number;
  endLine: number;
  totalLines?: number;
  nextStartLine?: number;
  truncated: boolean;
  /** Whether one further line is included, cut short by the byte budget. */
  partialLine: boolean;
  sizeBytes: number;
  /** Present only when the returned bytes contain the complete, unchanged file. */
  sha256?: string;
}> => {
  const target = resolveInside(root, requested);
  await rejectSymlinkComponents(root, target);
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    await assertOpenedInPlace(root, target, handle);
    const details = await handle.stat();
    if (!details.isFile()) throw new Error('Requested path is not a regular file');
    const buffer = Buffer.allocUnsafe(LINE_SCAN_BYTES);
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let line = 1;
    let lastKept = window.startLine;
    // Whether the newline that ended the last kept line was kept with it. It is a separator, so it
    // belongs to the answer only when another line follows it in the window.
    let lastKeptTerminated = false;
    let truncated = false;
    /*
     * Whether the budget stopped INSIDE a line rather than BETWEEN two of them, which is not the
     * same question as `truncated` and was being answered with it.
     *
     * A budget that runs out with one byte of the next line already taken delivered half a line,
     * and half a line was not displayed. A budget that runs out exactly as a line ends delivered
     * that line whole and simply had no room to start the next - `take` is zero, nothing of it
     * arrived, and the line before it is as displayed as any other. Both set `truncated`, so
     * reading the record off `truncated` marked the last whole line of the first kind of window
     * unseen. Measured through the shipped arm: of 947 tracked text files, nine paged end to end
     * following only this reader's own `nextStartLine` came out with a one-line hole in their
     * coverage, and the whole-file write the model had just earned was refused for it.
     */
    let partialLine = false;
    let position = 0;
    let eof = false;
    while (!truncated && line <= window.endLine) {
      const { bytesRead } = await handle.read(buffer, 0, LINE_SCAN_BYTES, position);
      if (bytesRead === 0) {
        eof = true;
        break;
      }
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let cursor = 0;
      while (cursor < bytesRead && !truncated && line <= window.endLine) {
        const newline = chunk.indexOf(NEWLINE, cursor);
        const end = newline === -1 ? bytesRead : newline + 1;
        if (line >= window.startLine) {
          const take = Math.min(end - cursor, Math.max(0, window.maxBytes - keptBytes));
          if (take > 0) {
            // The buffer is reused by the next read, so what is kept has to be a copy of it.
            kept.push(Buffer.from(chunk.subarray(cursor, cursor + take)));
            keptBytes += take;
            lastKept = line;
            lastKeptTerminated = newline !== -1 && take === end - cursor;
          }
          if (take < end - cursor) {
            truncated = true;
            // Something of this line arrived and the rest did not, so this line is the half-seen
            // one. Nothing of it arrived when `take` is zero, and then the line before it stands.
            partialLine = take > 0;
          }
        }
        cursor = end;
        if (newline !== -1) line += 1;
      }
    }
    // The final line of a file that ends in a newline is empty and holds no bytes, so nothing above
    // records it, and a whole-file read has to end where splitting the whole string would.
    if (eof && !truncated && line >= window.startLine && line <= window.endLine) {
      lastKept = line;
      lastKeptTerminated = false;
    }
    const content = Buffer.concat(kept);
    let sha256: string | undefined;
    if (eof && !truncated && window.startLine === 1 && !lastKeptTerminated) {
      const after = await handle.stat();
      await assertOpenedInPlace(root, target, handle);
      if (
        details.size !== after.size ||
        details.mtimeMs !== after.mtimeMs ||
        details.ctimeMs !== after.ctimeMs ||
        content.length !== after.size
      )
        throw new Error('The file changed while it was being read; read it again');
      sha256 = createHash('sha256').update(content).digest('hex');
    }
    /*
     * What this read actually put in front of its caller, remembered so a later write can be held
     * to it. A read cut short INSIDE a line stopped mid-line, and that line was not displayed:
     * counting it would vouch for the half that never arrived, which is precisely the kind of
     * half-seen text this record exists to refuse an edit on. A read cut short BETWEEN two lines
     * delivered the earlier one whole, and refusing to count it vouches for nothing - it only
     * withholds credit for text the caller is looking at.
     *
     * Against the reader that asked, and no record at all for a caller that is not one: the credit
     * belongs to the context window these lines arrived in, not to the file they came out of.
     */
    if (window.shownTo)
      recordDisplayedLines(window.shownTo, target, fileIdentity(details), {
        start: window.startLine,
        end: partialLine ? lastKept - 1 : lastKept
      });
    return {
      content: lastKeptTerminated ? content.subarray(0, content.length - 1) : content,
      startLine: window.startLine,
      endLine: lastKept,
      ...(eof ? { totalLines: line } : {}),
      // Where to carry on, whether the window ended or the budget did. A read that stopped on its
      // budget mid-line resumes AT that line rather than after it, so the half that did not fit is
      // not silently dropped - the caller reads it again whole with a larger budget or a narrower
      // window. The one case with nowhere to go is a single line longer than the whole budget:
      // resuming at it would return the same half forever, so that one advances past it and says so
      // through `truncated`, which is the only honest answer when one line cannot be delivered.
      ...(eof
        ? {}
        : truncated && !lastKeptTerminated
          ? { nextStartLine: lastKept === window.startLine ? lastKept + 1 : lastKept }
          : { nextStartLine: lastKept + 1 }),
      truncated,
      /*
       * Whether one further line is included, cut short - the same field and the same meaning the
       * whole-file display arm already returns, so a caller cutting the half-line off the end of
       * what it shows asks the same question of both arms. Read arms that answered it differently
       * are what let the two seen-line ledgers disagree about the same prefix of the same file.
       */
      partialLine,
      sizeBytes: details.size,
      ...(sha256 === undefined ? {} : { sha256 })
    };
  } finally {
    await handle.close();
  }
};

/** Where a file is copied to before the browser is given its name. Runner-owned, 0700. */
const UPLOAD_STAGING = path.join('.garden', 'uploads');

/**
 * A copy of a workspace file, in a directory only the runner can write, whose absolute path is
 * handed to the browser for an upload.
 *
 * The browser opens that path when the form is actually submitted, which can be minutes after this
 * call and is nowhere this module can guard. Handing it a name inside the agent's own tree meant
 * handing it a name the agent could still repoint at the cookie jar in the meantime; every
 * component of this one belongs to the runner. The file name is preserved exactly, because it is
 * what the site is told the attachment is called.
 */
export const stageUserFileForUpload = async (
  root: string,
  requested: string,
  maxBytes: number
): Promise<string> => {
  const relative = assertUserDataPath(root, requested);
  const { content } = await readWorkspaceFile(root, relative, maxBytes);
  const directory = path.join(root, UPLOAD_STAGING, randomUUID());
  await mkdir(directory, { recursive: true, mode: RUNNER_ONLY_MODE });
  const staged = path.join(directory, path.basename(relative));
  await writeFile(staged, content, { mode: 0o600 });
  return staged;
};

/** Staged copies live as long as the browser session that may still submit them, and no longer. */
export const clearStagedUploads = async (root: string): Promise<void> => {
  await rm(path.join(root, UPLOAD_STAGING), { recursive: true, force: true });
};

/**
 * Above this, a write is not held to the seen-line record: splitting the old file into an array of
 * strings costs several times its size in this process, and the read that feeds the guard is a read
 * the hash check would not otherwise have paid for. Comfortably larger than any file a model edits
 * by hand and far below the 2 GiB read ceiling the installer sets.
 */
const MAX_GUARDED_FILE_BYTES = 8 * 1024 ** 2;

/**
 * `expectSha256` is the caller's claim about what it is replacing, checked under the same open
 * descriptor that then does the writing.
 *
 * `file_write` is a read-modify-write with the read done in a previous step, and at least three
 * other writers share this tree: the agent's own shell, a second slot of the same worker, and the
 * owner in the file browser. Between the read and the write, any of them can land - and a whole-
 * file write does not fail, it silently discards what they wrote.
 *
 * `file_patch` reaches this same route and now claims its read too: it keeps the runner's hash from
 * the read it makes before matching `oldText` and passes it here. Until it did, the exactly-once
 * match on `oldText` proved the text it replaced was there and proved nothing about the file still
 * being the one it read.
 *
 * The hash rather than a modification time: it is exact, it says the content is what was read
 * rather than that nothing touched the inode, and both sides already compute it. Absent means the
 * caller is not claiming anything - creating a new file, or a caller that never read it - and the
 * write proceeds, because demanding it everywhere would break every first write.
 *
 * The hash answers "is this still the file you read". The seen-line guard beneath it answers the
 * question that survives a clean hash: "did you ever read the part of it you are changing". A
 * window read of lines 1-50 and a patch anchored at line 300 agree about every byte in the file and
 * still describe an edit made blind.
 *
 * `heldTo` is what makes that second question askable, and it is the reader it is asked about. The
 * agent's `file_write` after a WINDOWED read claims no hash - the ranged reader has no whole-file
 * digest to give it - so the guard rode on a claim that arm never makes, opened the file write-only,
 * and never ran: measured through the shipped tool on a 8,332-line file, `file_read` of lines 1-200
 * followed by a whole-file write was accepted and destroyed 8,132 lines. It is passed for writes
 * made under an agent capability and for nothing else, because "no hash" means two opposite things
 * depending on who said it - an agent editing from a window read, or an upload, a printed document,
 * the owner pressing Replace in the file browser, none of which claimed to have read anything and
 * none of which should meet a lecture about anchors.
 *
 * ONE ARGUMENT CARRIES BOTH "HELD" AND "WHO", and that is deliberate: they were two things, a
 * boolean and a resolved path, and the pair could disagree. It said this writer is held to reads and
 * then looked up the reads of whoever had last read that path - so a second task in the workspace
 * was held to a file it had never opened and, worse, credited with a file another task had. A
 * writer who is held but nameless is now unspellable.
 *
 * A hash on its own no longer opens the guard, for the same reason. `expectSha256` says "this is
 * the file I read" and does not say who read it; with a record that is about a reader there is
 * nothing for a nameless writer to be compared against, and the clause was answering with a record
 * belonging to somebody else - which for the owner's save was the record left by an agent's window
 * read of the same file, or by her own pane paging it. The agent, which is the caller this guard is
 * for, names itself on every write it makes here.
 */
const writeFileInWorkspace = async (
  root: string,
  requested: string,
  content: Buffer,
  maxBytes: number,
  options: { expectSha256?: string; heldTo?: Reader; exclusive?: boolean }
): Promise<{ sha256: string; sizeBytes: number }> => {
  const { expectSha256, heldTo, exclusive = false } = options;
  if (content.length > maxBytes) throw new Error(`File exceeds ${maxBytes} byte write limit`);
  const target = resolveInside(root, requested);
  await rejectSymlinkComponents(root, target, true);
  const changedAfterRead = (): WorkspaceFileError =>
    new WorkspaceFileError(
      'This file changed after you read it, so writing the whole file would discard that change. Read it again and reapply your edit, or use file_patch, which matches on the surrounding text.',
      409
    );
  // Deliberately not O_TRUNC: the descriptor is only known to be the intended file once it has
  // been checked, and truncating first would empty whatever a raced path led to before the check
  // could refuse it.
  // Read-write whenever something below has to look at the old bytes, so every check reads through
  // the very descriptor that then writes and no path swap can happen between them.
  const inspect = expectSha256 !== undefined || heldTo !== undefined;
  // A hash claims an existing file, including an empty one. Creating it during the check would
  // leave a file behind on refusal, or accept a deleted empty file as unchanged.
  const handle = await withWorkspaceDirectory(
    root,
    path.dirname(target),
    expectSha256 === undefined,
    (directory) =>
      open(
        path.join(directory, path.basename(target)),
        (inspect ? constants.O_RDWR : constants.O_WRONLY) |
          (expectSha256 === undefined ? constants.O_CREAT : 0) |
          (exclusive ? constants.O_EXCL : 0) |
          constants.O_NOFOLLOW,
        0o660
      )
  ).catch((error: unknown) => {
    if (expectSha256 !== undefined && (error as NodeJS.ErrnoException).code === 'ENOENT')
      throw changedAfterRead();
    throw error;
  });
  let edit: LineEdit | undefined;
  try {
    await assertOpenedInPlace(root, target, handle);
    // Read through the descriptor already proven to be the intended file, so nothing can swap the
    // path between the check and the write. One read serves both checks below.
    const details = inspect ? await handle.stat() : undefined;
    const existing = details === undefined ? undefined : await handle.readFile();
    if (expectSha256 !== undefined && existing !== undefined) {
      const actual = createHash('sha256').update(existing).digest('hex');
      if (actual !== expectSha256) throw changedAfterRead();
    }
    /*
     * The seen-line guard, and it runs second on purpose. A file that moved under the caller is a
     * different failure with a different answer - read it again - and answering it with a lecture
     * about anchors would send the model back to patch a version that no longer exists.
     *
     * It runs for a writer that named itself, and that is what keeps it aimed at editing. Everyone
     * else is left exactly as unguarded as before: an upload replacing a file, a printed document
     * landing on a name, the owner pressing Replace on a file the Files pane had paged through -
     * none of them claimed to have read anything, and refusing them for lines they never pretended
     * to have seen would put a lecture about anchors in front of a person who has no idea what one
     * is.
     *
     * And it is asked about THIS writer. The record is keyed by reader and file, so the answer is
     * what this task has been shown - not what the workspace has been shown, which is not a thing
     * that can be true. Where a second task in the same workspace had read the file, the old key
     * handed its reads over to whoever wrote next.
     *
     * Binary content is skipped for the same reason: lines are not what it is made of, and a file
     * with a zero byte in it has no anchors to have seen. A file too large to hold as lines is
     * skipped because the ceiling is about this process's memory - and the guard's whole discipline
     * is that losing the opinion is always allowed and losing the write never is.
     */
    if (
      heldTo !== undefined &&
      details !== undefined &&
      existing !== undefined &&
      details.size <= MAX_GUARDED_FILE_BYTES &&
      !existing.includes(0) &&
      !content.includes(0)
    ) {
      const seen = displayedLines(heldTo, target, fileIdentity(details));
      if (seen) {
        const before = existing.toString('utf8').split('\n');
        edit = lineEdit(before, content.toString('utf8').split('\n'));
        // One list of gaps across every span the write touched. A patch that changes two places is
        // asked about both of them and about nothing in between - see `lineEdit`.
        const unseen = edit.anchors.flatMap((anchor) => unseenWithin(anchor, seen));
        if (unseen.length) {
          const name = path.relative(root, target);
          const disclosure = discloseUnseen(before, unseen);
          if (!disclosure)
            throw new WorkspaceFileError(
              `This edit changes ${name} at line ${sayRanges(unseen)}, and no read has shown you those lines. That is too much unread file to hand back here. Read it with file_read using startLine and endLine over that range, then send the edit again.`,
              428
            );
          /*
           * The refusal is a display. Recording it is what stops the guard looping: the model is
           * shown the truth once and the same edit, sent again, applies. Only the lines that
           * actually fit in the message are recorded - a range the byte budget cut short was not
           * shown, and the next attempt is refused again with the rest of it, which terminates
           * because every round hands over more.
           */
          for (const range of disclosure.disclosed)
            recordDisplayedLines(heldTo, target, fileIdentity(details), range);
          throw new WorkspaceFileError(
            `This edit changes ${name} at line ${sayRanges(unseen)}, and no read has shown you those lines - so it is being made from memory of a file you have only seen part of. Here is what is actually there. Check your edit against it and send the same call again; these lines now count as read, so it will apply.\n\n${disclosure.text}`,
            428
          );
        }
      }
    }
    await handle.truncate(0);
    /*
     * Written at an offset this function names, because a descriptor carries a position and this
     * one has been read from.
     *
     * `handle.writeFile` writes at the descriptor's current position, and the compare-and-swap
     * above leaves that position at the end of the old file: every write that claimed a hash landed
     * after a hole, producing the old file's length in zero bytes followed by the new content. It
     * was invisible from the outside because a corrupted file still contains every string a test
     * looked for, and the two callers that claim a hash are the two that matter most - the owner
     * saving in the file browser, and every `file_patch` since the patch path started claiming its
     * read. The loop is not defensive dressing: a single `write` is allowed to take fewer bytes
     * than it was offered, and a partial write here is a truncated file.
     */
    for (let written = 0; written < content.length; ) {
      const { bytesWritten } = await handle.write(
        content,
        written,
        content.length - written,
        written
      );
      if (bytesWritten <= 0) throw new Error('The file could not be written in full');
      written += bytesWritten;
    }
    // The record follows the file across its own write, so a second edit in the same turn is still
    // held to what was read. This writer's record and no other: another task's record of the same
    // file is now stale, and it is that task's own identity check that must find it so - see
    // `rememberWrite`. A file with no record gains none.
    if (edit && heldTo) rememberWrite(heldTo, target, fileIdentity(await handle.stat()), edit);
  } finally {
    await handle.close();
  }
  return { sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length };
};

export const writeWorkspaceFile = (
  root: string,
  requested: string,
  content: Buffer,
  maxBytes: number,
  expectSha256?: string,
  heldTo?: Reader
): Promise<{ sha256: string; sizeBytes: number }> =>
  writeFileInWorkspace(root, requested, content, maxBytes, {
    ...(expectSha256 === undefined ? {} : { expectSha256 }),
    ...(heldTo === undefined ? {} : { heldTo })
  });

/** Publish a new artifact without replacing a concurrently created file. */
export const createWorkspaceFile = (
  root: string,
  requested: string,
  content: Buffer,
  maxBytes: number
): Promise<{ sha256: string; sizeBytes: number }> =>
  writeFileInWorkspace(root, requested, content, maxBytes, { exclusive: true });

export const deleteWorkspaceFile = async (root: string, requested: string): Promise<void> => {
  const target = resolveInside(root, requested);
  const protectedRoot = path.resolve(root, 'workspace');
  if (target === path.resolve(root) || target === protectedRoot)
    throw new Error('Workspace root cannot be deleted');
  await rejectSymlinkComponents(root, target);
  await rm(target, { recursive: true, force: true });
};

const assertNotWorkspaceRoot = (root: string, target: string, verb: string): void => {
  if (target === path.resolve(root) || target === path.resolve(root, 'workspace'))
    throw new WorkspaceFileError(`Workspace root cannot be ${verb}`, 400);
};

export const createWorkspaceFolder = async (
  root: string,
  requested: string
): Promise<{ path: string }> => {
  const target = resolveInside(root, requested);
  await rejectSymlinkComponents(root, target, true);
  const existing = await lstat(target).catch(() => null);
  if (existing && !existing.isDirectory())
    throw new WorkspaceFileError('A file already exists at that path', 409);
  await withWorkspaceDirectory(root, target, true, async () => undefined);
  return { path: path.relative(root, target) };
};

/**
 * Renaming never overwrites. A silent overwrite is the one outcome the file browser must not
 * produce: the owner asked for a new name, not for the file already using it to disappear.
 */
export const renameWorkspaceEntry = async (
  root: string,
  from: string,
  to: string
): Promise<{ path: string }> => {
  const source = resolveInside(root, from);
  const destination = resolveInside(root, to);
  assertNotWorkspaceRoot(root, source, 'renamed');
  assertNotWorkspaceRoot(root, destination, 'replaced');
  // Asked before the symlink walk, which would otherwise report a missing file as a failed stat.
  if (!(await lstat(source).catch(() => null)))
    throw new WorkspaceFileError('Workspace file not found', 404);
  await rejectSymlinkComponents(root, source);
  await rejectSymlinkComponents(root, destination, true);
  if (await lstat(destination).catch(() => null))
    throw new WorkspaceFileError('Something already exists at the new name', 409);
  await mkdir(path.dirname(destination), { recursive: true, mode: SHARED_MODE });
  await rename(source, destination);
  return { path: path.relative(root, destination) };
};

/**
 * Bytes actually on this disk under `root`. Symlinks are skipped, so nothing is counted twice.
 *
 * A directory the runner may not open is skipped rather than allowed to fail the whole figure.
 * The agent's own account owns part of this tree - `~/.cache` arrives at mode 0700 the first time
 * a GUI program runs, because GLib creates it that way - and refusing to report any number at all
 * because of it would take the storage reading away from the owner entirely. The host-level
 * measurement is what actually protects the disk; this figure is the per-workspace view.
 */
export const workspaceUsage = async (root: string): Promise<number> => {
  let total = 0;
  const unreadable = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    ['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '');
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (unreadable(error)) return null;
      throw error;
    });
    if (!entries) return;
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile())
        total += (
          await stat(target).catch((error: unknown) => {
            if (unreadable(error)) return { size: 0 };
            throw error;
          })
        ).size;
    }
  };
  await visit(root);
  return total;
};
