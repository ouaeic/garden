import path from 'node:path';
import { textValue } from '../values.js';

/**
 * The one sentence a missing-file error cannot carry on its own: that the shell is already in
 * `workspace/`.
 *
 * A command runs in `workspace/` and a file tool folds a bare name into `workspace/`, so the same
 * spelling names one file to `file_write` and, written into a command, the directory
 * `workspace/workspace/`. The kernel answers that with ENOENT and the tool prints "No such file or
 * directory", which reads as "the file is not there" - and a model that has just written the file
 * goes looking for it with `find /`. Measured live: six of ten tasks, a third of the tool calls on
 * the turns it touched, one correctly captured screenshot lost into the shadow tree.
 *
 * Appended to the result rather than described in the catalogue, because it costs nothing until
 * it fires and fires only where it is true. Three things have to hold: the command's own stderr
 * names a missing path, that path begins with `workspace/`, and the command was run from a
 * directory the runner reads inside `workspace/`. An ENOENT for any other path stays silent -
 * nothing here knows why `/etc/missing` is missing - and so does a command run from
 * `.garden/artifacts`, where the sentence would be false.
 *
 * The spelling the note offers is computed against the directory the shell is actually in. From
 * `probe` - which the runner reads as `workspace/probe` - the file `workspace/probe/data.txt` is
 * `data.txt`, and a note that said `probe/data.txt` would walk the model into a second miss one
 * directory deeper than the first.
 */

/**
 * A path token as a tool prints it, bounded by the quotes and punctuation error messages use. A
 * bare `workspace` counts, because `cd workspace` from the catalogue's default cwd is the first
 * thing a model that believes it is at the root writes; `workspaces/x` and `/workspace/x` do not.
 */
const NAMED_WORKSPACE_PATH = /(?:^|[\s:'"`=([])(workspace(?:\/[^\s:'"`)\]]*)?)(?=$|[\s:'"`)\]])/;

/**
 * The directory a command runs in, as the runner reads `cwd`, spelt from the container root: a
 * bare name and a `workspace/` prefix both land inside `workspace/`. Null where the runner does
 * not put the shell inside `workspace/` and the sentence would be false - `.` is the container
 * root, so are the container's own directories, an absolute path resolves as written, and a cwd
 * carrying a step upwards is read literally from the root.
 */
const workspaceDirectory = (cwd: string): string | null => {
  if (cwd.startsWith('/')) return null;
  const segments = cwd.split(/[/\\]/).filter((segment) => segment && segment !== '.');
  const first = segments[0];
  if (first === undefined || segments.includes('..') || first.startsWith('.')) return null;
  return (first === 'workspace' ? segments : ['workspace', ...segments]).join('/');
};

const missingWorkspacePath = (stderr: string): string | null => {
  for (const line of stderr.split('\n')) {
    if (!line.includes('No such file or directory')) continue;
    const named = NAMED_WORKSPACE_PATH.exec(line)?.[1];
    if (named) return named;
  }
  return null;
};

export const WORKSPACE_PREFIX_NOTE = (missing: string, directory: string): string => {
  const here = path.posix.relative(directory, missing) || '.';
  return directory === 'workspace'
    ? `The shell already runs inside workspace/, so write that path without the prefix: ${missing} is ${here} here.`
    : `The shell already runs inside ${directory}/, so write that path relative to it: ${missing} is ${here} here.`;
};

/**
 * The exec result as the model should read it: unchanged, or with one `note` when the command
 * tripped over the `workspace/` prefix and the result would otherwise say only that a file is
 * missing.
 */
export const withWorkspacePrefixNote = <Result>(
  execution: Record<string, unknown>,
  result: Result
): Result & { note?: string } => {
  const unchanged = result as Result & { note?: string };
  if (!result || typeof result !== 'object') return unchanged;
  const stderr = (result as { stderr?: unknown }).stderr;
  if (typeof stderr !== 'string') return unchanged;
  const directory = workspaceDirectory(
    execution.cwd === undefined ? 'workspace' : textValue(execution.cwd)
  );
  if (!directory) return unchanged;
  const command = [
    textValue(execution.executable),
    ...(Array.isArray(execution.args) ? execution.args.map(String) : [])
  ].join(' ');
  if (!NAMED_WORKSPACE_PATH.test(command)) return unchanged;
  const missing = missingWorkspacePath(stderr);
  if (!missing) return unchanged;
  return { ...result, note: WORKSPACE_PREFIX_NOTE(missing, directory) };
};
