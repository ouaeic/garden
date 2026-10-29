/**
 * Every file operation the runner protocol offers, built out of `exec` and nothing else.
 *
 * One implementation over both backends. A container and a temporary directory differ in how a
 * command is started and in nothing else this file can see, so the local backend proves the exact
 * code the container backend will run. That is the whole reason these are not `node:fs` calls.
 *
 * PORTABILITY, and where it stops. Everything below is POSIX `sh` plus `base64`, `stat`, `du`,
 * `tar` and `find` - present in a Debian or Alpine benchmark image and on macOS. `stat` is the one
 * that genuinely differs between GNU and BSD, so every call tries the GNU spelling and falls back
 * to the BSD one; a box with neither reports the entry without a size rather than failing the
 * listing, which is what the real runner does for a folder it cannot count.
 *
 * WHAT IS NOT SUPPORTED, said rather than discovered: a path containing a newline. Names travel
 * back base64-encoded so quoting and spaces are safe, but the line-per-entry framing is not. The
 * real runner has no such limit. What would change it: a benchmark task whose fixture ships one.
 */
import type { ExecCall, ExecResult, WorkspaceBackend } from './backend.js';

/** The workspace-relative root every path in this protocol is stated against. */
export const WORKSPACE_PREFIX = 'workspace';

const call = (script: string, argv: readonly string[] = [], stdin?: string): ExecCall => ({
  executable: '/bin/sh',
  args: ['-c', script, 'sh', ...argv],
  // `.` - the box's root, one above `workspace/`, which is the frame every path in the runner
  // protocol is written in. Resolving a listing of `workspace/src` from inside `workspace` would
  // silently look at `workspace/workspace/src`.
  cwd: '.',
  env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
  timeoutSeconds: 120,
  stdin,
  // A file operation is this rig talking to the box, not the agent reaching the internet. It is
  // gated closed regardless of what the agent's own call asked for.
  network: false,
  maxOutputBytes: 32 * 1024 * 1024
});

const refuse = (what: string, result: ExecResult): never => {
  // Loudly, and never a plausible empty answer. A file operation that half worked and returned an
  // empty listing is indistinguishable from an empty directory, and an agent told its workspace is
  // empty will rewrite the task from scratch and score 0 with no error anywhere.
  throw new Error(
    `${what} failed in the box: exit ${String(result.exitCode)} ${result.stderr.trim().slice(0, 400)}`
  );
};

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const unb64 = (text: string): string => Buffer.from(text, 'base64').toString('utf8');

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink';
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

/**
 * One directory, in the runner's own row shape.
 *
 * @see services/workspace-runner/src/files.ts:212, whose fields these are exactly - `name`,
 * `path` relative to the workspace ROOT (so `workspace/notes.txt`, not `notes.txt`), `type`,
 * `sizeBytes`, `modifiedAt`. An artifact acceptance check reads three of those off the row, so a
 * listing shaped any other way makes every artifact check report the file missing.
 */
export const listFiles = async (
  backend: WorkspaceBackend,
  requested: string
): Promise<FileEntry[]> => {
  const target = requested.trim() === '' ? WORKSPACE_PREFIX : requested;
  const script = `
set -u
dir=$(printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D)
[ -d "$dir" ] || exit 3
for entry in "$dir"/* "$dir"/.[!.]*; do
  [ -e "$entry" ] || continue
  case "\${entry##*/}" in .garden) continue ;; esac
  if [ -L "$entry" ]; then kind=symlink
  elif [ -d "$entry" ]; then kind=directory
  else kind=file
  fi
  meta=$(stat -c '%s %Y' "$entry" 2>/dev/null || stat -f '%z %m' "$entry" 2>/dev/null || printf '0 0')
  printf '%s %s %s\\n' "$kind" "$meta" "$(printf '%s' "$entry" | base64 | tr -d '\\n')"
done
`;
  const result = await backend.exec(call(script, [b64(target)]));
  // A directory that is not there is an empty listing and not an error, which is what `readdir`
  // on a fresh workspace does. Any other non-zero exit is a real failure and refuses.
  if (result.exitCode === 3) return [];
  if (result.exitCode !== 0) refuse(`listing ${target}`, result);
  return result.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [kind, size, mtime, name] = line.split(' ');
      const full = unb64(name ?? '');
      return {
        name: full.split('/').filter(Boolean).pop() ?? full,
        path: full.replace(/^\.\//, ''),
        type: kind === 'directory' || kind === 'symlink' ? kind : 'file',
        sizeBytes: Number(size) || 0,
        modifiedAt: new Date((Number(mtime) || 0) * 1_000).toISOString()
      };
    });
};

/** The exact bytes of one file, or null when it is not there. Base64 on the wire, so binary-safe. */
export const readFile = async (
  backend: WorkspaceBackend,
  requested: string
): Promise<Buffer | null> => {
  const script = `
set -u
file=$(printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D)
[ -f "$file" ] || exit 3
base64 < "$file" | tr -d '\\n'
`;
  const result = await backend.exec(call(script, [b64(requested)]));
  if (result.exitCode === 3) return null;
  if (result.exitCode !== 0) refuse(`reading ${requested}`, result);
  return Buffer.from(result.stdout.trim(), 'base64');
};

/**
 * One file written, through stdin.
 *
 * TEXT ONLY, AND IT REFUSES RATHER THAN CORRUPTS. `ExecCall.stdin` is a string in the runner's own
 * schema (`execution.ts:61`), so bytes that are not valid UTF-8 cannot cross this seam intact. The
 * agent's own writes are source, patches and prose and none of them are affected; a picture would
 * be, and a picture arrives only through the media tools, which this shim's `/surfaces` answer
 * withdraws. Silently writing mangled bytes would be a file the verifier reads as wrong work.
 */
export const writeFile = async (
  backend: WorkspaceBackend,
  requested: string,
  bytes: Buffer
): Promise<void> => {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes))
    throw new Error(
      `refusing to write ${requested}: this shim carries file contents as UTF-8 text through the exec seam and these bytes are not UTF-8`
    );
  const script = `
set -u
file=$(printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D)
mkdir -p "$(dirname "$file")"
cat > "$file"
`;
  const result = await backend.exec(call(script, [b64(requested)], text));
  if (result.exitCode !== 0) refuse(`writing ${requested}`, result);
};

export const removeFile = async (backend: WorkspaceBackend, requested: string): Promise<void> => {
  const script = `
set -u
file=$(printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D)
rm -rf -- "$file"
`;
  const result = await backend.exec(call(script, [b64(requested)]));
  if (result.exitCode !== 0) refuse(`deleting ${requested}`, result);
};

export const makeFolder = async (backend: WorkspaceBackend, requested: string): Promise<void> => {
  const script = `
set -u
dir=$(printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D)
mkdir -p "$dir"
`;
  const result = await backend.exec(call(script, [b64(requested)]));
  if (result.exitCode !== 0) refuse(`creating ${requested}`, result);
};

export const renamePath = async (
  backend: WorkspaceBackend,
  from: string,
  to: string
): Promise<void> => {
  const script = `
set -u
src=$(printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D)
dst=$(printf '%s' "$2" | base64 -d 2>/dev/null || printf '%s' "$2" | base64 -D)
[ -e "$src" ] || exit 3
mkdir -p "$(dirname "$dst")"
mv -- "$src" "$dst"
`;
  const result = await backend.exec(call(script, [b64(from), b64(to)]));
  if (result.exitCode === 3) throw new Error(`refusing to rename ${from}: it is not there`);
  if (result.exitCode !== 0) refuse(`renaming ${from}`, result);
};

/**
 * What this workspace is using, in bytes.
 *
 * `du -sk`, so it is disk blocks rounded to a kilobyte rather than the sum of file sizes. The real
 * runner sums `lstat` sizes. The difference is a few kilobytes on a source tree and it is stated
 * because the number reaches the model: a workspace figure that disagreed with what a file listing
 * adds up to would be read as a bug in the listing.
 */
export const storageBytes = async (backend: WorkspaceBackend): Promise<number> => {
  const result = await backend.exec(call('du -sk workspace 2>/dev/null | head -1 | cut -f1'));
  if (result.exitCode !== 0) refuse('measuring storage', result);
  return (Number(result.stdout.trim()) || 0) * 1_024;
};

export interface Checkpoint {
  readonly id: string;
  readonly mechanism: 'archive';
  readonly createdAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly storedBytes: number;
  readonly changedFileCount: number;
  readonly uncoveredFileCount: number;
  readonly durationMs: number;
  readonly pruned: readonly string[];
}

/**
 * A turn checkpoint that is a real archive of the workspace, not an acknowledgement.
 *
 * The real runner's is content-addressed and cheap on a second call; this one is a `tar` and costs
 * a full copy every time. It is a real copy on purpose: a checkpoint route that answered
 * `{ id, ok: true }` would let a rollback report success having restored nothing, and a benchmark
 * whose agent rolled back would be scored on the state it was trying to abandon.
 *
 * `mechanism: 'archive'` rather than the runner's `'content'`, because it is a different mechanism
 * and saying `content` would be a false statement about what protects the work.
 */
export const createCheckpoint = async (
  backend: WorkspaceBackend,
  checkpointId: string
): Promise<Checkpoint> => {
  const started = Date.now();
  const script = `
set -u
id=$(printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D)
mkdir -p .garden-bench/checkpoints
tar -cf ".garden-bench/checkpoints/$id.tar" -C workspace . 2>/dev/null || exit 4
files=$(find workspace -type f 2>/dev/null | wc -l)
total=$(du -sk workspace 2>/dev/null | head -1 | cut -f1)
stored=$(du -sk ".garden-bench/checkpoints/$id.tar" 2>/dev/null | head -1 | cut -f1)
printf '%s %s %s\\n' "$files" "$total" "$stored"
`;
  const result = await backend.exec(call(script, [b64(checkpointId)]));
  if (result.exitCode !== 0) refuse(`checkpointing ${checkpointId}`, result);
  const [files, total, stored] = result.stdout.trim().split(/\s+/);
  return {
    id: checkpointId,
    mechanism: 'archive',
    createdAt: new Date().toISOString(),
    fileCount: Number(files) || 0,
    totalBytes: (Number(total) || 0) * 1_024,
    storedBytes: (Number(stored) || 0) * 1_024,
    // Not computed, and reported as not computed. A diff against the previous archive is a second
    // full extraction per turn, and nothing in the loop reads this field to make a decision - it
    // is displayed. Zero here means "this shim does not count them", which is why the comment is
    // load-bearing: a reader who took it for "nothing changed" would be reading a lie.
    changedFileCount: 0,
    uncoveredFileCount: 0,
    durationMs: Date.now() - started,
    pruned: []
  };
};

export const listCheckpoints = async (backend: WorkspaceBackend): Promise<string[]> => {
  const result = await backend.exec(
    call('ls .garden-bench/checkpoints 2>/dev/null | sed "s/\\.tar$//"')
  );
  if (result.exitCode !== 0) return [];
  return result.stdout.split('\n').filter((line) => line.trim() !== '');
};

/**
 * The three numbers `GET /machine` answers with, read from inside the box.
 *
 * @see services/workspace-runner/src/machine.ts:270-300 for the shape and the summary sentence,
 * which is reproduced here word for word because the worker folds `summary` straight into the
 * frozen runtime block and a different wording would be a different prompt.
 *
 * Read from inside the box rather than from `node:os`, for the same reason the real route is a
 * route: this process is not the process the container's limits bind. `nproc` and `/proc/meminfo`
 * are what a Linux container answers with; on a Mac they are absent and every field comes back
 * null, which produces the empty summary the worker already handles.
 */
export const machineReport = async (
  backend: WorkspaceBackend
): Promise<{
  cores: number | null;
  memoryBytes: number | null;
  diskBytes: number | null;
  summary: string;
}> => {
  const script = `
cores=$(nproc 2>/dev/null || printf '')
mem=$(awk '/MemTotal/ {print $2 * 1024; exit}' /proc/meminfo 2>/dev/null || printf '')
disk=$(df -k workspace 2>/dev/null | awk 'NR==2 {print $4 * 1024; exit}' || printf '')
printf '%s|%s|%s\\n' "$cores" "$mem" "$disk"
`;
  const result = await backend.exec(call(script));
  const [cores, memory, disk] = (result.exitCode === 0 ? result.stdout.trim() : '||').split('|');
  const number = (value: string | undefined): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const report = {
    cores: number(cores),
    memoryBytes: number(memory),
    diskBytes: number(disk)
  };
  const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
  const parts: string[] = [];
  if (report.cores !== null) parts.push(`${report.cores} cores`);
  if (report.memoryBytes !== null) parts.push(`${gib(report.memoryBytes)} GiB memory per command`);
  if (report.diskBytes !== null) parts.push(`${gib(report.diskBytes)} GiB free disk`);
  return {
    ...report,
    summary: parts.join(', ')
  };
};

/**
 * Which of a set of binaries this box has.
 *
 * `command -v` and nothing cleverer, which is what `probeBinaries` does. A benchmark task's skills
 * name binaries and the loop warns the model off a procedure it cannot run; a probe that answered
 * everything-present would send the agent to use a tool that is not there and the failure would
 * arrive as a command that did not exist.
 */
export const probeBinaries = async (
  backend: WorkspaceBackend,
  binaries: readonly string[]
): Promise<{ present: string[]; missing: string[] }> => {
  if (binaries.length === 0) return { present: [], missing: [] };
  const script = `
set -u
for encoded in "$@"; do
  name=$(printf '%s' "$encoded" | base64 -d 2>/dev/null || printf '%s' "$encoded" | base64 -D)
  if command -v "$name" >/dev/null 2>&1; then printf 'y %s\\n' "$encoded"; else printf 'n %s\\n' "$encoded"; fi
done
`;
  const result = await backend.exec(call(script, binaries.map(b64)));
  if (result.exitCode !== 0) refuse('probing binaries', result);
  const present: string[] = [];
  const missing: string[] = [];
  for (const line of result.stdout.split('\n').filter((row) => row.trim() !== '')) {
    const [flag, encoded] = line.split(' ');
    (flag === 'y' ? present : missing).push(unb64(encoded ?? ''));
  }
  return { present, missing };
};
