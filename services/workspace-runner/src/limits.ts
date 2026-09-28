import { constants } from 'node:fs';
import { access } from 'node:fs/promises';

export interface CommandLimits {
  memoryBytes: number;
  processes: number;
  openFiles: number;
}

const GIB = 1024 ** 3;

/**
 * Where one command's own memory ceiling sits inside the cgroup the unit file draws around all of
 * them. Floored at 1 GiB so a small box still gets a usable ceiling rather than one no build could
 * run under.
 *
 * It was half the box, and the comment said that was so one command could not take memory the
 * database and the API also need. RLIMIT_DATA cannot make that promise: it is per process, so
 * sixty-four children of `parallel -j 64` get sixty-four allowances of it, and the aggregate the
 * sentence is about is bounded by the unit's cgroup and by nothing here. What the per-process
 * number does bind is exactly one shape - a single large single-process job, which is to say an
 * assembler or an aligner - and on the owner's 31.34 GiB box half-the-box put 9.4 GiB of the RAM
 * the cgroup already allows out of reach of any single command, for a promise it was not keeping.
 *
 * SEVEN TENTHS, and it is derived rather than picked: it is the midpoint of the two percentages
 * the unit file already states, `MemoryHigh=60%` and `MemoryMax=80%`, and it has to lie strictly
 * between them for two different reasons.
 *
 * ABOVE the throttle, because the unit says in as many words that crossing `MemoryHigh` should
 * mean a heavy build finishes slowly rather than dying. A single-process job that wants more than
 * 60% of the box is the exact shape this wave exists for, and a per-command ceiling at or below
 * the throttle refuses what the cgroup was deliberately written to allow.
 *
 * BELOW the kill, because these two stops are not equally legible and only one of them can be
 * reported. RLIMIT_DATA makes an allocation fail, so the program says so in its own words -
 * `MemoryError`, `std::bad_alloc`, "cannot allocate" - on the stderr the result carries. The
 * cgroup's stop is SIGKILL: no exit code, no message, nothing on either stream, and from the
 * agent's side indistinguishable from a crash it should retry. So the per-process limit is worth
 * keeping reachable even though the aggregate one is the real protection, and it is only reachable
 * if it is under the number the cgroup kills at.
 *
 * It was four fifths for one commit, which is `MemoryMax` exactly, and measured against the
 * owner's box that put it 2,457 bytes ABOVE the cgroup ceiling - so the cgroup, which counts the
 * runner and every command together and therefore reaches any total first, could never be beaten
 * to it. Every single-process memory death on that box turned from a sentence the program wrote
 * into a mute SIGKILL, and one command could drive the whole unit into reclaim, which at half the
 * box it could not. On the 31.34 GiB box seven tenths is 21.94 GiB: 6.27 GiB more than the old
 * half, and 3.13 GiB clear of the throttle below and the kill above alike.
 *
 * What would change it: either percentage moving in `infra/native/garden-runner.service`. Those
 * two numbers and this fraction are one decision, and `scripts/check-repository.mjs` compares them
 * rather than trusting this paragraph to be re-read.
 */
export const defaultMemoryLimitBytes = (totalMemoryBytes: number): number =>
  Math.max(GIB, Math.floor((totalMemoryBytes * 7) / 10));

export const commandLimits = (
  config: {
    COMMAND_MEMORY_LIMIT_BYTES?: number | undefined;
    COMMAND_PROCESS_LIMIT: number;
    COMMAND_OPEN_FILE_LIMIT: number;
  },
  totalMemoryBytes: number
): CommandLimits => ({
  memoryBytes: config.COMMAND_MEMORY_LIMIT_BYTES ?? defaultMemoryLimitBytes(totalMemoryBytes),
  processes: config.COMMAND_PROCESS_LIMIT,
  openFiles: config.COMMAND_OPEN_FILE_LIMIT
});

/**
 * RLIMIT_DATA rather than RLIMIT_AS: since Linux 4.7 it also covers anonymous mmap, so it bounds
 * the memory a command actually commits. RLIMIT_AS would additionally count the multi-gigabyte
 * address-space reservations V8 and the Go runtime make before they allocate anything, and would
 * kill node and every Go binary on the box on sight.
 *
 * RLIMIT_NPROC counts every process of the runner's user, so it is deliberately well above what
 * ordinary work needs: it exists to make a fork bomb fail inside the offending command while the
 * runner itself, whose own limit is the higher one systemd sets, can still fork.
 *
 * NO RLIMIT_FSIZE. There was one, at 4 GiB, and it was the first ceiling in this system the
 * owner's own work reached: a 40 GB alignment reaches it in under a minute, and what it does there
 * is the reason it is gone rather than raised. The kernel raises SIGXFSZ, which the runner reports
 * as `signal: "SIGXFSZ"` with an empty stderr and a file on disk that `ls` says is present and is
 * silently truncated at the ceiling - and when the writer is not the last stage of a `bash -lc`
 * pipeline, which is the idiom the tool catalogue itself tells the model to use, the outer shell
 * exits 0 and the whole thing is reported as success.
 *
 * It was not protecting this box. A runaway write is stopped by the host-disk floor, which both
 * execution paths poll while the command runs, and which covers what RLIMIT_FSIZE cannot see at
 * all - ten thousand files of 3 GiB each. Nor was it a rule the box believes in: the owner's own
 * terminal spawns its pty straight through `sandboxedShell` with no limiter (server.ts), so the
 * same account on the same box could always write a 700 GB file by hand and only the agent could
 * not. What would bring it back: a limiter that can bound a write per workspace rather than per
 * file, which is a quota and not an rlimit.
 */
export const commandLimitArguments = (limits: CommandLimits): string[] => [
  '--core=0',
  `--data=${limits.memoryBytes}`,
  `--nproc=${limits.processes}`,
  `--nofile=${limits.openFiles}`
];

export interface Invocation {
  executable: string;
  args: string[];
}

export const limitedInvocation = (
  invocation: Invocation,
  limits: CommandLimits | undefined,
  limiter: string | undefined
): Invocation =>
  limits && limiter
    ? {
        executable: limiter,
        args: [...commandLimitArguments(limits), '--', invocation.executable, ...invocation.args]
      }
    : invocation;

/**
 * prlimit ships with util-linux, which is an essential package on Debian and Ubuntu, so the
 * limiter is present on a stock host without anything extra being installed. Development machines
 * that are not Linux have no equivalent, and there the runner deliberately runs unlimited rather
 * than refusing to start.
 */
export const resolveCommandLimiter = async (candidate: string): Promise<string | undefined> => {
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
};
