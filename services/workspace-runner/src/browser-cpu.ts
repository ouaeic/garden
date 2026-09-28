/**
 * Making the session browser yield to the work it is meant to be serving.
 *
 * The box has no GPU, so a headful Chromium on Xvfb runs its GPU process on SwiftShader - software
 * GL - and any page that animates pins it. Measured on this installation twice: ~1,270% CPU, about
 * thirteen of sixteen cores, held for as long as the page stayed open, including for the twenty
 * minutes after the task that opened it had finished. Killing it took the box from 79% busy to
 * 99.4% idle with the published preview still serving, because a preview is an HTTP port and does
 * not need a browser at all.
 *
 * **Niceness rather than a quota, deliberately.** `garden-runner.service` already argues this in
 * its own unit file - "a quota would slow legitimate work even on an idle machine, while a weight
 * gives the agent the whole processor when nothing else wants it" - and that reasoning holds here.
 * What it does not do on its own is help, because the browser lives *inside* the runner's cgroup:
 * the weight makes the runner yield to Postgres and the API, and does nothing about the browser
 * starving the agent's own shell commands. A per-process niceness is the same idea one level down,
 * and it is the level the problem is on.
 *
 * A cgroup would be the tidier instrument and is not available: cgroup v2 refuses to let a cgroup
 * hold processes once a controller is enabled for its children, so putting the browser in
 * `garden-runner.service/browser` means moving the runner itself into a sibling first - a fight
 * with systemd over a tree it owns, for a bound `setPriority` already gives.
 *
 * Everything here is best-effort and silent on failure. A browser that could not be niced is a
 * browser that runs exactly as it did before this file existed; it is never a reason to fail a
 * launch or a sweep.
 */
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';

/** What dampening needs, injected so the walk can be tested without a /proc to read. */
export interface BrowserCpuDeps {
  readonly listProcessIds: () => Promise<number[]>;
  readonly commandLineOf: (pid: number) => Promise<string>;
  readonly setPriority: (pid: number, priority: number) => void;
  readonly currentPriority: (pid: number) => number;
}

/**
 * Chromium's own processes all carry the profile directory on their command line - the browser, the
 * zygotes, the renderers and the GPU process that is the one actually burning the machine. Matching
 * on it is what lets this reach the whole tree without knowing Playwright's process shape, which it
 * does not expose for a persistent context.
 */
const belongsToProfile = (commandLine: string, profileDir: string): boolean =>
  commandLine.includes(`--user-data-dir=${profileDir}`);

export const linuxBrowserCpuDeps: BrowserCpuDeps = {
  listProcessIds: async () =>
    (await readdir('/proc').catch(() => [] as string[]))
      .map((entry) => Number(entry))
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  // NUL-separated, and read as latin1 so a non-UTF-8 argument cannot throw the walk.
  commandLineOf: async (pid) =>
    (await readFile(`/proc/${pid}/cmdline`, 'latin1').catch(() => '')).replaceAll('\0', ' '),
  setPriority: (pid, priority) => os.setPriority(pid, priority),
  currentPriority: (pid) => os.getPriority(pid)
};

/**
 * Lowers the scheduling priority of every Chromium process serving one workspace profile.
 *
 * Re-applied rather than done once, because Chromium spawns processes for the life of the session -
 * a renderer per tab, a fresh GPU process after a crash - and a child forked before this ran keeps
 * the priority it inherited. The sweep that retires idle sessions already runs every minute, which
 * is the right cadence for this too: a process that arrived in the last minute is niced in the next
 * pass, and one that is already at the target is skipped without a syscall.
 *
 * Returns how many processes it moved, for the caller that wants to log the first pass.
 */
export const dampenBrowserCpu = async (
  deps: BrowserCpuDeps,
  profileDir: string,
  niceness: number
): Promise<number> => {
  if (niceness <= 0 || !profileDir) return 0;
  let moved = 0;
  for (const pid of await deps.listProcessIds()) {
    const commandLine = await deps.commandLineOf(pid);
    if (!belongsToProfile(commandLine, profileDir)) continue;
    try {
      // Never raise: `setPriority` towards zero needs privileges the runner does not have, and a
      // process somebody has deliberately pushed further down is not this function's to pull back.
      if (deps.currentPriority(pid) >= niceness) continue;
      deps.setPriority(pid, niceness);
      moved += 1;
    } catch {
      // A process that exited between the listing and the call, or one this account may not touch.
    }
  }
  return moved;
};
