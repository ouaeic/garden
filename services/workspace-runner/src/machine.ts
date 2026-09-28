/**
 * What machine this is, in the numbers an agent has to have before it can size a job.
 *
 * Nothing in the window said any of this. The runtime block named the disk and told the model to
 * run `df -h` for the rest, so a model choosing `make -j`, `cargo test -j`, `parallel -j` or a
 * JVM heap picked a habit - `-j 4`, `-Xmx4g` - on a box with sixteen cores and twenty-one
 * gigabytes it was allowed to use. A grep of the whole tree for `nproc` or `availableParallelism`
 * found one hit and it was a string in an rlimit argument.
 *
 * ── THE CGROUP IS THE ANSWER, NOT THE HARDWARE ────────────────────────────────────────────────
 *
 * Every number here is what this process may actually have, which on this box is never what the
 * hardware has. `infra/native/garden-runner.service` draws a control group around the runner and
 * every command it starts: `MemoryMax=80%` is a hard ceiling the kernel kills at, `MemoryHigh=60%`
 * throttles below it, and `commandLimits` puts a per-process RLIMIT_DATA at seven tenths of the
 * box inside both. A report built from `os.totalmem()` and `os.availableParallelism()` would say
 * 31.34 GiB on the owner's box where one command may commit 21.94, and would say sixteen cores
 * inside a container pinned to two. Both of those are worse than saying nothing, because a model
 * that is told a number does not go and check it.
 *
 * The reverse mistake is just as available and this file does not make it either: `CPUWeight=50`
 * on that same unit is a SHARE, not a quota. It changes how the scheduler splits a contended
 * processor and takes no core away, so it must not reduce the count. Only `cpu.max` - an actual
 * quota - and `cpuset.cpus.effective` - an actual pinning - can, and those are the only two CPU
 * facts read below.
 *
 * ── WHAT IT DOES WHEN IT CANNOT ───────────────────────────────────────────────────────────────
 *
 * Every field is dropped independently, and a field that cannot be established honestly is absent
 * rather than guessed. On Linux with a cgroup that cannot be read, the CPU count and the memory
 * ceiling are BOTH withheld even though `availableParallelism()` and the rlimit would both answer:
 * a quota this process cannot see is exactly the case where those two answers are wrong, and the
 * only safe reading of "there is a control group here and I cannot read it" is that it binds. A
 * host with no cgroup v2 at all - a developer's macOS laptop - is a different fact and is reported
 * from affinity and the rlimit, because there is no second ceiling to miss.
 *
 * "CANNOT BE READ" IS A PROPERTY OF EACH FILE, NOT ONLY OF THE HIERARCHY, and the first version of
 * this file said the paragraph above while doing the opposite one level down. Every read went
 * through a helper that caught every errno alike and answered `null`, and every consumer read that
 * `null` as "this level sets no limit". Driven against real cgroup files with the permissions
 * broken on individual ones: an unreadable `memory.max` reported the rlimit, `21.9 GiB` against a
 * ceiling of 2.0 - wrong by 10.9x; an unreadable `cpu.max` reported sixteen cores against a quota
 * of two; an unreadable `/proc/self/cgroup` reported a macOS laptop; and a leaf directory at mode
 * 000 got past the one guard that existed, because `access` was asked for existence where it
 * needed readability. Six shapes, one cause, and the type below is the shape of the repair: three
 * values per ceiling rather than two, so that "there is no limit here" and "there is one and I
 * cannot see it" stay apart all the way down to the sentence.
 *
 * With every field dropped the summary is the empty string, and the worker's runtime block then
 * carries no machine line at all. @see runtimeContext in `apps/worker/src/context.ts`.
 */
import { access, readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { hostStorage, hostStorageFloorBytes, type HostStorage } from './host-storage.js';

const GIB = 1024 ** 3;

/** Where the unified cgroup v2 hierarchy is mounted on every distribution garden supports. */
export const CGROUP_ROOT = '/sys/fs/cgroup';
/** The only file that says which cgroup this process is actually in. */
export const CGROUP_SELF = '/proc/self/cgroup';

/**
 * What the control group allows, or why it could not be asked.
 *
 * Three states rather than a nullable object, because "there is no cgroup" and "there is one and I
 * could not read it" lead to opposite decisions in `machineReport` and a single `null` would
 * collapse them into whichever one the writer happened to have in mind.
 */
export type CgroupReading =
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable' }
  | {
      readonly state: 'read';
      /** Cores this process may actually run on. @see CgroupCeiling for what the three mean. */
      readonly cpuCores: CgroupCeiling;
      /** The hard memory ceiling, read the same three ways. */
      readonly memoryMaxBytes: CgroupCeiling;
    };

/**
 * One ceiling the hierarchy was asked for: a number, `null` for a level that sets none, and
 * `'unknown'` for one that is THERE and would not answer.
 *
 * The same argument as `CgroupReading` above, one level down, and it belongs here because this is
 * where the distinction was being thrown away rather than where it is easiest to state. A single
 * `null` for both answers is the exact mistake the three states above exist to prevent, and it was
 * being made by every read in this file.
 *
 * `'unknown'` is contagious DOWN THE CHAIN and beats every number, because a chain with one level
 * that would not answer has no honest ceiling whatever the levels either side of it said. It is
 * not contagious ACROSS FIELDS: an unreadable `memory.max` withholds the memory and leaves the
 * cores the `cpu.max` beside it answered, which is what "every field is dropped independently"
 * means and is strictly more useful than withholding the line.
 */
export type CgroupCeiling = number | null | 'unknown';

/** The `0::/path` line of `/proc/self/cgroup`. A v1-only host has none and gets `null`. */
const unifiedPath = (text: string): string | null => {
  for (const line of text.split('\n')) {
    const parts = line.split(':');
    if (parts.length >= 3 && parts[0] === '0') return parts.slice(2).join(':').trim();
  }
  return null;
};

/**
 * Every cgroup directory from the hierarchy root down to this process's own, root first.
 *
 * A limit set on an ancestor binds a descendant that does not restate it, so the effective ceiling
 * is the minimum down the chain rather than whatever the leaf happens to say. `memory.max` on
 * `system.slice` is the shape that makes this matter: the unit's own directory can read `max` while
 * its parent holds the number that kills.
 */
const cgroupChain = (root: string, relative: string): string[] => {
  const chain = [root];
  let at = root;
  for (const segment of relative.split('/').filter(Boolean)) {
    at = `${at}/${segment}`;
    chain.push(at);
  }
  return chain;
};

/** The tighter of two ceilings, where "could not be established" is tighter than any number. */
const tighten = (running: CgroupCeiling, next: CgroupCeiling): CgroupCeiling => {
  if (running === 'unknown' || next === 'unknown') return 'unknown';
  if (running === null) return next;
  if (next === null) return running;
  return Math.min(running, next);
};

/**
 * `max` or an integer, per the cgroup v2 interface.
 *
 * `max` is an answer and means no ceiling. Anything else that will not parse is NOT an answer, and
 * the difference is the whole of this function: reading a malformed byte count as "no limit" puts
 * the hardware's number in the sentence, which is the one outcome worth more than saying nothing.
 */
const cgroupNumber = (raw: string): CgroupCeiling => {
  const value = raw.trim();
  if (value === 'max') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 'unknown';
};

/** `<quota> <period>` in microseconds, or `max <period>` for no quota at all. */
const cpuMaxCores = (raw: string): CgroupCeiling => {
  const [quota, period] = raw.trim().split(/\s+/);
  const numerator = cgroupNumber(quota ?? '');
  const denominator = cgroupNumber(period ?? '');
  if (numerator === 'unknown' || denominator === 'unknown') return 'unknown';
  // `max 100000` is the weight-without-quota case and it must stay a `null` rather than becoming
  // an unknown: a share takes no core away, and there is a case that fails if that ever changes.
  if (numerator === null || denominator === null) return null;
  // Floored, never below one. Half a core is a real quota and a job sized to zero threads is not a
  // job; a quota of 2.5 cores means two whole workers and a fraction nothing can schedule.
  return Math.max(1, Math.floor(numerator / denominator));
};

/** `0-3,8`, already resolved against every ancestor by the kernel. Empty means "not restricted". */
export const cpuSetCount = (raw: string): CgroupCeiling => {
  const value = raw.trim();
  // The one legitimately empty file in the interface - the hierarchy root's - and it means the
  // opposite of the malformed cases below: nothing is pinned here.
  if (value === '') return null;
  let total = 0;
  for (const part of value.split(',')) {
    const [from, to] = part.split('-');
    const start = Number(from);
    if (!Number.isInteger(start)) return 'unknown';
    if (to === undefined) {
      total += 1;
      continue;
    }
    const end = Number(to);
    if (!Number.isInteger(end) || end < start) return 'unknown';
    total += end - start + 1;
  }
  return total > 0 ? total : 'unknown';
};

/** One cgroup file: what it said, that there is none here, or that there is one and it will not. */
type CgroupFile = { readonly text: string } | 'missing' | 'unreadable';

/**
 * Read one file of the interface, keeping apart the two reasons it can fail to produce a string.
 *
 * `ENOENT` is a level setting no limit and is the ordinary case - the hierarchy root has no
 * `cpu.max` at all, and most levels set neither ceiling. EVERY OTHER ERRNO is a limit that is
 * there and will not answer: `EACCES` on a file inside a directory this process may not read,
 * `EISDIR` where a bind mount left a directory in a file's place, `EIO` on a masked `/proc`. The
 * helper this replaced returned `null` for all of them alike, which is how a ceiling that could
 * not be seen came out of this module as a ceiling that does not exist.
 */
const readCgroupFile = async (path: string): Promise<CgroupFile> => {
  try {
    return { text: await readFile(path, 'utf8') };
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
};

/** What one file of the chain contributes, in the three values a ceiling can take. */
const ceilingFrom = (file: CgroupFile, parse: (raw: string) => CgroupCeiling): CgroupCeiling =>
  file === 'missing' ? null : file === 'unreadable' ? 'unknown' : parse(file.text);

/**
 * The cgroup v2 ceilings that bind this process.
 *
 * `root`, `self` and `platform` are parameters so the parsing can be proved against real files in
 * a real directory rather than against a mock of the file system: the formats below - `max
 * 100000`, `0-3,8`, a bare byte count, the `0::` line - are the whole of what this can get wrong,
 * and a stub that returns pre-parsed objects would prove none of them. `platform` is here for one
 * case and one only: what a MISSING `/proc/self/cgroup` means is decided by which kernel is
 * underneath, and on the machine this ships to that case cannot otherwise be said.
 */
export const readCgroup = async (
  options: { root?: string; self?: string; platform?: NodeJS.Platform } = {}
): Promise<CgroupReading> => {
  const root = options.root ?? CGROUP_ROOT;
  const selfPath = options.self ?? CGROUP_SELF;
  const self = await readCgroupFile(selfPath);
  // A `/proc/self/cgroup` that is there and will not answer is a control group that binds and
  // cannot be seen, which is the whole of the unreadable state. A MISSING one is decided by the
  // kernel: off Linux there is no second ceiling to be wrong about, and on Linux there is no host
  // without this file - a process that cannot see it is one whose `/proc` has been masked, which
  // is a container, which is precisely where a quota binds and the hardware's numbers are lies. A
  // v1-only host has the file and no `0::` line and is unreadable too: v1 can carry a
  // `cpu.cfs_quota_us` this file does not look at.
  if (self === 'unreadable') return { state: 'unreadable' };
  if (self === 'missing')
    return (options.platform ?? process.platform) === 'linux'
      ? { state: 'unreadable' }
      : { state: 'absent' };
  const relative = unifiedPath(self.text);
  if (relative === null) return { state: 'unreadable' };
  const chain = cgroupChain(root, relative);
  const leaf = chain[chain.length - 1] ?? root;
  try {
    // Existence only, and deliberately: a leaf that is there but unreadable is caught one level
    // down, by the files inside it answering `unreadable` rather than `missing`. What this catches
    // is a path out of `/proc` that does not resolve under `root` at all, which is a hierarchy
    // nothing here can speak.
    await access(leaf);
  } catch {
    return { state: 'unreadable' };
  }
  let cpuCores: CgroupCeiling = null;
  let memoryMaxBytes: CgroupCeiling = null;
  for (const directory of chain) {
    cpuCores = tighten(
      cpuCores,
      ceilingFrom(await readCgroupFile(`${directory}/cpu.max`), cpuMaxCores)
    );
    memoryMaxBytes = tighten(
      memoryMaxBytes,
      ceilingFrom(await readCgroupFile(`${directory}/memory.max`), cgroupNumber)
    );
  }
  // Read at the leaf only, because the kernel already intersected it with every ancestor - that is
  // what the `.effective` suffix means, and walking the chain would only re-derive it less well.
  cpuCores = tighten(
    cpuCores,
    ceilingFrom(await readCgroupFile(`${leaf}/cpuset.cpus.effective`), cpuSetCount)
  );
  return { state: 'read', cpuCores, memoryMaxBytes };
};

export interface MachineReport {
  /** Cores a job may actually use, or null when nothing here could establish it honestly. */
  readonly cores: number | null;
  /** What one command may commit before it is refused or killed. */
  readonly memoryBytes: number | null;
  /** Disk this workspace may still write, above the floor the host guard refuses below. */
  readonly diskBytes: number | null;
  /** The one line the runtime block states, or '' when not one field could be established. */
  readonly summary: string;
}

/** One decimal, so 21.94 GiB does not print as 22 and a 1.5 GiB container does not print as 1. */
const gib = (bytes: number): string => (bytes / GIB).toFixed(1);

/**
 * The line the model reads, and the reason it is one line.
 *
 * Three numbers and their units. It is placed beside the disk sentence the block already carried
 * and it ends by saying what the numbers are for, because the failure being fixed is not that the
 * model cannot find `nproc` - it is that it never thinks to ask before typing `-j 4`.
 */
export const machineSummary = (report: Omit<MachineReport, 'summary'>): string => {
  const parts: string[] = [];
  if (report.cores !== null) parts.push(`${report.cores} cores`);
  if (report.memoryBytes !== null) parts.push(`${gib(report.memoryBytes)} GiB memory per command`);
  if (report.diskBytes !== null) parts.push(`${gib(report.diskBytes)} GiB free disk`);
  if (parts.length === 0) return '';
  return `${parts.join(', ')}. Size parallel work, memory and output to these rather than to a default.`;
};

/**
 * What this box can give one job, probed at the moment the run starts.
 *
 * `commandMemoryBytes` is the runner's own RLIMIT_DATA for an agent command - the number
 * `commandLimits` computed at startup and `commandLimitArguments` puts on every invocation - so
 * this reports the ceiling that is actually applied rather than a second derivation of it. The
 * cgroup's `memory.max` is taken as well and the smaller wins, because the two stops are set by
 * different mechanisms and either can be the one that fires first.
 */
export const machineReport = async (input: {
  root: string;
  commandMemoryBytes: number;
  /** The kernel seam, or nothing - production passes `undefined` and gets `readCgroup`. */
  readCgroupLimits?: (() => Promise<CgroupReading>) | undefined;
  parallelism?: () => number;
  storage?: (root: string) => Promise<HostStorage>;
}): Promise<MachineReport> => {
  const cgroup = await (input.readCgroupLimits ?? readCgroup)();
  const cores = ((): number | null => {
    if (cgroup.state === 'unreadable') return null;
    // `availableParallelism` honours `sched_setaffinity`, which is the other way a core is taken
    // away and the one no cgroup file reports.
    const affinity = Math.max(1, (input.parallelism ?? availableParallelism)());
    if (cgroup.state === 'absent') return affinity;
    // A quota that is there and could not be read withholds THIS number and leaves the memory
    // ceiling beside it alone, for the same reason the whole reading withholds both: affinity is
    // wrong exactly where a quota it cannot see is binding.
    if (cgroup.cpuCores === 'unknown') return null;
    return cgroup.cpuCores === null ? affinity : Math.min(affinity, cgroup.cpuCores);
  })();
  const memoryBytes = ((): number | null => {
    if (cgroup.state === 'unreadable') return null;
    if (cgroup.state === 'absent') return input.commandMemoryBytes;
    if (cgroup.memoryMaxBytes === 'unknown') return null;
    return cgroup.memoryMaxBytes === null
      ? input.commandMemoryBytes
      : Math.min(input.commandMemoryBytes, cgroup.memoryMaxBytes);
  })();
  const diskBytes = await (input.storage ?? hostStorage)(input.root)
    .then((storage) =>
      // The headroom the write guard will actually allow, not the headroom `df` prints: a write
      // that takes the filesystem below `hostStorageFloorBytes` is refused, so the floor is
      // already spent from the agent's point of view. @see assertHostStorageWrite.
      Math.max(
        0,
        storage.hostStorageAvailableBytes - hostStorageFloorBytes(storage.hostStorageTotalBytes)
      )
    )
    .catch(() => null);
  return {
    cores,
    memoryBytes,
    diskBytes,
    summary: machineSummary({ cores, memoryBytes, diskBytes })
  };
};
