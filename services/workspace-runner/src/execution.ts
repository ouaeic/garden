import { assertMissionWorkspaceOpen, trackMissionInvocation } from './mission-processes.js';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { z } from 'zod';
import {
  binaryName,
  packageManagerInvocation,
  privilegeEscalationBinary,
  privilegedHelperInvocation,
  resolveExecutable
} from './command-policy.js';
import { AGENT_HOME, resolveCommandDirectory } from './files.js';
import {
  belowHostStorageFloor,
  hostStorage as probeHostStorage,
  type HostStorage
} from './host-storage.js';
import { limitedInvocation, type CommandLimits } from './limits.js';
import { isCodingMissionWorkspace, sandboxedInvocation, type AgentSandbox } from './sandbox.js';
import { awaitChildExit, killProcessTree, stopProcessTree } from './subprocess.js';
export { stopProcessTree } from './subprocess.js';

/** Native commands share the owner's workspace, resource ceilings and approval floor. */

export const ExecRequest = z
  .object({
    executable: z.string().min(1).max(4096),
    /*
     * CHOSEN at 8,192, which is a count no ordinary command approaches and a scatter-gather does.
     * It was 256, undeclared in the catalogue and refused with a raw schema failure, so `samtools
     * merge` over three thousand per-contig shards - 3,002 arguments, an ordinary shape in the
     * work this box is for - could not be spelled at all. Nothing here was protecting anything:
     * the real bound on an argument list is the kernel's own ARG_MAX, which reports E2BIG, and the
     * body carrying them is bounded before this by Fastify's `bodyLimit`. What would change it: a
     * host whose ARG_MAX is smaller than what this allows, which no Linux this runs on has.
     */
    args: z.array(z.string().max(100_000)).max(8_192).default([]),
    cwd: z.string().default('workspace'),
    env: z.record(z.string(), z.string()).default({}),
    timeoutSeconds: z.number().int().positive().max(86_400).default(300),
    stdin: z.string().max(10_000_000).optional(),
    pty: z.boolean().optional(),
    network: z.boolean().default(false),
    maxOutputBytes: z
      .number()
      .int()
      .min(4_096)
      .max(20 * 1024 * 1024)
      .default(1024 * 1024),
    /*
     * Declared here only so that naming one can be refused.
     *
     * `service` belongs to the background route. Arriving on this one it was an unknown key, which
     * a plain object schema strips: the command ran in the foreground for five minutes and came
     * back as an ordinary result, with no error, no service and no record - and a model that had
     * been told a service was what it just started. A silent wrong outcome for a corrected call is
     * the cheapest trade in the runner.
     */
    service: z.string().min(1).max(120).optional()
  })
  .superRefine((value, context) => {
    if (value.pty)
      context.addIssue({
        code: 'custom',
        path: ['pty'],
        message:
          'A terminal requires managed execution; system package installation cannot use a terminal'
      });
    if (value.service !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['service'],
        message:
          'Naming a service needs background: true, because a service is a process this computer keeps running after the turn ends'
      });
  });

/**
 * Head, tail and a count of what went between them.
 *
 * Exported because the background path needs exactly this and had its own copy that did not do it:
 * `appendBounded` kept the last N bytes and said nothing, so one poll of a long analysis returned
 * a log whose beginning - the command line, the version banner, the first warning, which is where
 * a six-hour run says what it is about to do - had already been discarded, with no marker to say
 * any of it was missing. A background job is the one that runs long enough to overflow this.
 */
export const boundedCollector = (limit: number) => {
  const headLimit = Math.floor(limit * 0.62);
  const tailLimit = limit - headLimit;
  const head: Buffer[] = [];
  const exact: Buffer[] = [];
  let headBytes = 0;
  let tail = Buffer.alloc(0);
  let totalBytes = 0;
  let overflowed = false;

  return {
    push(chunk: Buffer) {
      totalBytes += chunk.length;
      if (!overflowed) {
        if (totalBytes <= limit) exact.push(chunk);
        else {
          overflowed = true;
          exact.length = 0;
        }
      }
      if (headBytes < headLimit) {
        const keep = chunk.subarray(0, Math.min(chunk.length, headLimit - headBytes));
        if (keep.length) head.push(keep);
        headBytes += keep.length;
      }
      const combined = Buffer.concat([tail, chunk]);
      tail = combined.subarray(Math.max(0, combined.length - tailLimit));
    },
    /** Everything this stream has produced, including what was dropped. Monotonic. */
    get bytes() {
      return totalBytes;
    },
    text(stream: string) {
      const beginning = Buffer.concat(head);
      if (!overflowed) return Buffer.concat(exact).toString('utf8');
      const omitted = Math.max(0, totalBytes - beginning.length - tail.length);
      return `${beginning.toString('utf8')}\n[… ${omitted} bytes omitted from ${stream}; beginning and end preserved …]\n${tail.toString('utf8')}`;
    }
  };
};

/**
 * The only environment a caller may put in front of an agent command. PATH, HOME and LANG belong
 * to the runner - they are how a command is confined to the workspace - and everything else here
 * is a locale, terminal or policy setting a caller named deliberately.
 *
 * OPENCODE_AUTO_SHARE and OPENCODE_PERMISSION are on the list because they are safety controls
 * rather than conveniences: one turns off the share link that would publish the owner's session,
 * the other carries the deny-list that stops the coding CLI running sudo, pushing a branch or
 * reading a .env. One declaration, read by the foreground and the background path alike, because
 * when this list existed twice the background path - the only one that carries these keys - was
 * the copy that did not have them.
 */
export const SAFE_ENV_KEYS =
  /^(?:LANG|LC_[A-Z_]+|TERM|NO_COLOR|FORCE_COLOR|CI|TZ|PYTHONUNBUFFERED|OPENCODE_AUTO_SHARE|OPENCODE_PERMISSION)$/;

/**
 * Refuses rather than filters. A dropped variable is invisible, and the caller goes on believing a
 * policy is in force that never reached the process - which for a deny-list is the difference
 * between a guard and the belief in one. Saying so costs one failed call and nothing else.
 */
/**
 * Where the agent's `$HOME` is: `.home` at the container root, beside `workspace/` and not inside
 * it. It used to be the container root itself, which is why every dotfile a toolchain wrote landed
 * in the same directory as `workspace/` and `.athanor`.
 *
 * IT IS NOT INSIDE THE UNDO POINT, and nothing here claims it is. `CHECKPOINT_CONTENT` is
 * `['workspace', '.athanor/artifacts']` (checkpoints.ts), so a rewind puts the project tree back
 * and leaves the toolchain caches and the coding CLIs' OAuth state exactly as the failed run left
 * them. That is deliberate. A home under `workspace/` would be walked and hashed on EVERY turn and
 * counted against `CHECKPOINT_MAX_FILES` = 250,000: measured for scale on the lead's machine, a
 * Rust toolchain alone is 88,021 files (`~/.rustup` 66,157, `~/.cargo` 21,864) before a conda
 * environment, which is routinely 30,000-60,000. Crossing that ceiling throws
 * `CheckpointRefusedError` and the turn loses its rewind point - so a home inside the checkpoint
 * costs the checkpoint, which is the thing it was supposed to protect. Rolling a CLI's OAuth state
 * back to yesterday morning would also sign the agent out mid-task, which is the exact harm
 * checkpoints.ts already excludes `.athanor/browser` to avoid.
 *
 * IT IS ALSO OUT OF THE STORAGE FIGURE, and that is a cost as well as a consequence: server.ts's
 * `storageUsage` walks `workspace`, `.athanor/artifacts` and `.athanor/browser`, so a per-workspace
 * limit does not bound what a task writes into its `$HOME`. Decided rather than inherited, with the
 * argument written out at `storageUsage` itself; the host-disk floor is what stops a `$HOME` filling
 * the box.
 *
 * Being outside `workspace/` means the Landlock ruleset has to name it, and it does:
 * `scripts/athanor-sandbox` grants `$ROOT/.home` the write verbs beside `$ROOT/workspace`, because
 * a confined command may otherwise write only in `workspace/`, `/tmp`, `/var/tmp` and `/dev/shm` -
 * and a boundary that refuses `pip install` is an outage rather than a boundary. `$ROOT/.athanor`
 * is granted nowhere and remains unreachable.
 *
 * The other reason for the container root: files.ts's `assertUserDataPath` folds a bare relative
 * name into `workspace/`, so with `$HOME` at `workspace/.home` a `file_write('.home/.bashrc')`
 * would have written the real login-shell startup file - and the owner's own interactive terminal
 * below runs with this same `HOME`, so that file would then be sourced by the owner's shell.
 * Here the fold cannot reach it: `.home/.bashrc` folds to `workspace/.home/.bashrc`, a file no
 * shell reads. `.home` is in files.ts's `CONTAINER_ONLY` so the fold does not even happen quietly.
 *
 * A dotted name so it does not appear in an `ls` of the project the agent is working on, and one
 * declaration because the runner sets it in three places - here, the owner's terminal, and the
 * directory the workspace is prepared with - and two of them would eventually disagree.
 */
export const agentHome = (workspaceRoot: string): string => path.join(workspaceRoot, AGENT_HOME);

export const agentEnvironment = (
  workspaceRoot: string,
  searchPath: string,
  requested: Record<string, string>
): Record<string, string> => {
  const refused = Object.keys(requested)
    .filter((key) => !SAFE_ENV_KEYS.test(key))
    .sort();
  if (refused.length)
    throw new Error(
      `The workspace runtime sets the environment of an agent command itself and does not accept ${refused.join(', ')}`
    );
  return {
    PATH: searchPath,
    HOME: agentHome(workspaceRoot),
    LANG: 'C.UTF-8',
    ...requested
  };
};

/**
 * Free space is re-read this often while a command runs. The pre-flight check only proves the
 * disk was healthy at the start; a `dd` reaches the last free byte in the seconds after that.
 *
 * Exported because the background path polls on the same rule. When these two intervals were
 * separate declarations the background one did not exist at all.
 */
export const DISK_FLOOR_POLL_MS = 5_000;

/**
 * Why a command stopped, said on the command's own stderr so the reason travels with the result:
 * a process that dies on a signal otherwise reads to the model as an unexplained crash it should
 * retry, and retrying is the one thing that must not happen here. One declaration, read by the
 * foreground and the background path alike.
 */
export const HOST_DISK_FLOOR_NOTE =
  '[stopped: this command was using the last of the host disk, which the database and the rest of the computer also need]';

/**
 * The same sentence, for the other stop that was mute.
 *
 * Four things can end an agent command here, and until this existed only two of them said so. The
 * disk floor and the owner's cancel each append their reason to the command's own stderr; a
 * timeout appended nothing, so a six-hour job killed at its deadline came back as `timedOut: true`
 * beside an empty stderr and an exit code of null - which names neither the bound that was hit,
 * nor the number it was set to, nor the fact that a longer run has somewhere else to go. A model
 * reading that has no way to tell a deadline from a crash, and the cheapest wrong move is to start
 * the whole thing again.
 *
 * Both numbers, because they are different facts: what the caller asked for is what the model
 * believes it set, and the ceiling is what the box actually allows. A run stopped at its own
 * requested deadline should not be told to go and ask for more.
 */
export const timedOutNote = (
  deadlineSeconds: number,
  ceilingSeconds: number,
  background: boolean
) =>
  `[stopped: this command hit its ${deadlineSeconds}s timeout and was killed. What it had already written to a file, or printed above, is all there is; work still in progress is gone. ${
    deadlineSeconds >= ceilingSeconds
      ? background
        ? `${ceilingSeconds}s is this computer's ceiling for a background command; work that needs longer than that belongs in a service.`
        : `${ceilingSeconds}s is this computer's ceiling for a command run in the foreground. Start a long job with background: true, which allows far longer, and watch it with process(poll).`
      : 'Ask for a longer timeoutSeconds, or start it with background: true and watch it with process(poll), if the work genuinely needs it.'
  }]`;

/**
 * The fifth stop, and the one this file did not know it had.
 *
 * Four stops were named above and the wave that named them created a fifth by moving a number: a
 * command killed outright by the kernel. On a host with the unit file that is overwhelmingly the
 * cgroup's out-of-memory kill, and it is the only stop here that no code in this process performs
 * - nothing sets a flag, nothing appends a sentence, and what comes back is `exitCode: null`,
 * `signal: "SIGKILL"` and two empty streams. That is byte-for-byte what a segfaulting binary looks
 * like, and the two want opposite responses: a crash is worth reporting, a memory kill is worth
 * retrying with fewer threads, and a model that cannot tell them apart re-runs the same 64-way job
 * unchanged and is killed again at the same point.
 *
 * Hedged rather than asserted, because this signal is not proof of a cause: a script that runs
 * `kill -9` on itself, or a host-level OOM killer choosing this process, arrives identically. It
 * names the likely reason and the move that follows from it and claims nothing else.
 *
 * Only reached when none of the four flags is set, so a timeout, an owner's cancel and the disk
 * floor - all three of which end in SIGKILL by way of `stopProcessTree` - keep their own sentences.
 */
export const KILLED_NOTE =
  '[stopped: this command was killed outright by the computer rather than exiting on its own. Nothing it held in memory was written; files it had already finished writing are still there. On this box that is almost always the memory ceiling: run it again asking for less at once - fewer threads or parallel jobs, a smaller batch or chunk size, streaming instead of loading a whole file - rather than repeating it unchanged.]';

/**
 * The sixth thing that can go wrong, and the one the filesystem boundary itself created: a command
 * refused by the Landlock ruleset rather than by the file it named.
 *
 * The kernel answers a rule violation with EACCES, which every tool on the box prints as the same
 * `Permission denied` it prints for a file mode, a missing directory it may not create, or a file
 * that is not there at all under some shells. Measured in the real-kernel drill for this boundary:
 * `cat: /home/athanor/<other>/workspace/notes.md: Permission denied` and `mv: cannot move ... :
 * Permission denied`, with nothing in either to distinguish policy from a broken path. A model
 * reading that retries with sudo, or retries the same path, or concludes the file does not exist
 * and writes around it - three wrong moves, all cheaper to make than to diagnose.
 *
 * IT GUESSES, and it says so in the sentence it appends. There is no errno on the result: this
 * reads the command's own stderr, which is text a program chose, in whatever words it chose. What
 * makes the guess narrow rather than wide is the second half - the message must also name an
 * absolute path that lies outside EVERY hierarchy the ruleset names, the read list as much as the
 * write list. A denial inside `workspace/` is an ordinary Unix mode and gets no sentence, which is
 * the case that would otherwise be told a lie.
 *
 * WHAT IT DOES NOT DO: it does not fire on a box that is not confining the filesystem, on a command
 * that exited zero, on a message in a language other than the one the C locale produces, or on a
 * tool that reports a denial without naming the path. All four are silences rather than wrong
 * answers. Both execution paths reach it through `unclaimedStopNote` below, so a background command
 * refused by the ruleset gets the same sentence a foreground one does.
 */

/**
 * Every hierarchy scripts/athanor-sandbox names in a rule, spelled here the way it spells them,
 * and the reason the read half is in the list at all.
 *
 * The write half is obvious. The read half is the one that was wrong: while this held only the
 * writable directories, `cat: /etc/shadow: Permission denied` on a confined box got the sentence -
 * and `/etc` is granted for reading, so that denial is a mode bit and the sentence was a lie that
 * contradicted itself in its own next clause, which offers "may read the system directories" as
 * the reason the path is out of reach. The same shape arrives far more often through an
 * interpreter, which names its own path ahead of the file it could not open:
 * `/usr/bin/python3: can't open file '<workspace>/build.py': ... Permission denied` matched
 * `/usr/bin/python3` first and told the reader the sandbox refused a file the sandbox grants.
 *
 * Adding the read list costs a silence in one direction: a genuine ruleset refusal to WRITE in
 * `/etc` or `/var` says nothing now. That costs nothing measurable, because the agent account is
 * unprivileged and ordinary Unix permissions refuse those writes with or without Landlock - the
 * VPS drill for this boundary recorded `/etc` unwritable at the same exit status with the ruleset
 * removed. What the boundary actually took away is named nowhere here and still gets the sentence:
 * `/home`, and with it every other task's workspace, and the container root that holds `.athanor`.
 */
const GRANTED_OUTSIDE_WORKSPACE = [
  '/tmp',
  '/var/tmp',
  '/dev/shm',
  '/dev',
  '/usr',
  '/bin',
  '/lib',
  '/lib64',
  '/sbin',
  '/opt',
  '/etc',
  '/var',
  '/srv',
  '/run',
  '/proc',
  '/sys'
];

const confinementNote = (
  stderr: string,
  workspaceRoot: string,
  confined: boolean
): string | undefined => {
  if (!confined) return undefined;
  const granted = [
    path.join(workspaceRoot, 'workspace'),
    agentHome(workspaceRoot),
    ...GRANTED_OUTSIDE_WORKSPACE
  ];
  const denied = stderr
    .split('\n')
    .filter((line) => /permission denied|operation not permitted/i.test(line))
    // Anything that starts at the root and runs to a delimiter a message would use around a path.
    // Over-matching is harmless here: a token that is not really a path is simply one more string
    // that fails the grant test below, and one that trails a quote or a colon still starts with the
    // hierarchy it belongs to, which is what the test asks about.
    .flatMap((line) => line.match(/\/[^\s'"`,)\]]*/g) ?? [])
    .map((candidate) => candidate.replace(/[:.'"`]+$/, ''))
    .find(
      (candidate) =>
        candidate.length > 1 &&
        !granted.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))
    );
  if (!denied) return undefined;
  return `[the sandbox on this computer probably refused that, rather than the file: ${denied} is outside what a command here may touch. This task may write in its own workspace, in $HOME and in /tmp, and may read the system directories; everything else on the box - including other tasks' files - is refused with the same "Permission denied" a missing file would give. Nothing is wrong with the path and nothing here can be escalated: do the work inside the workspace instead.]`;
};

/**
 * The one seam both execution paths ask about how a command ended when this process did not end it.
 *
 * Four of the six endings are performed here - the deadline, the owner's cancel, the host-disk
 * floor, and a refusal before the command ever starts - and each of them sets a flag and writes its
 * own sentence at the moment it acts. The remaining two are read off the corpse: the kernel's
 * SIGKILL, and a ruleset refusal that arrives as nothing but the word "denied" in the command's own
 * stderr. Those two are what this function decides.
 *
 * IT IS A FUNCTION BECAUSE THE TWO PATHS KEPT DISAGREEING. `execute` had the SIGKILL branch and
 * then grew the confinement branch beside it; `ProcessManager.settle` had a hand-written copy of
 * the SIGKILL branch and did not grow the second, so a background command refused by the ruleset
 * got a bare "Permission denied" while a foreground one got the sentence - and the background path
 * is the one that runs for an hour, where a boundary is most likely to be met and least likely to
 * be diagnosed by rerunning. A line added to `settle` would have closed that instance and left the
 * next one open; asking both paths the same question closes the shape.
 *
 * `claimed` is the caller saying one of its own four stops already spoke. `cancelled` is separate
 * from it only because the foreground path can carry a cancel that did not change any other flag:
 * an owner who stopped the command knows why it stopped, and telling them the memory ceiling
 * probably did it would be a guess about an ending nobody was guessing at.
 *
 * Ordered SIGKILL first. Both can be true at once - a command killed by the cgroup after printing a
 * denial - and the kill is the ending, while the denial is something that happened on the way.
 *
 * `stderr` arrives as a function because the background path does not have one: a session's log
 * lives in a `boundedCollector` and is assembled into a string on demand, up to the 20 MB a caller
 * may ask for. Every question above is answered from flags, and on most boxes the last one is not
 * asked at all, so a plain string parameter would have built that log at the end of every
 * background command on every host - including the ones that confine nothing and can never use it.
 */
export const unclaimedStopNote = (
  outcome: {
    stderr: () => string;
    exitCode: number | null;
    signal: string | null;
    /** One of this process's own stops already fired and wrote its own sentence. */
    claimed: boolean;
    /** The owner asked for this to stop, so its ending needs no explaining. */
    cancelled: boolean;
  },
  workspaceRoot: string,
  confined: boolean
): string | undefined => {
  if (outcome.claimed) return undefined;
  if (!outcome.cancelled && outcome.signal === 'SIGKILL') return KILLED_NOTE;
  if (!confined) return undefined;
  // A command killed by a signal has no exit code, and one that exited zero has nothing to explain.
  if (outcome.exitCode === null || outcome.exitCode === 0) return undefined;
  return confinementNote(outcome.stderr(), workspaceRoot, confined);
};

export interface ExecutionGuards {
  limits?: CommandLimits | undefined;
  /** Absolute path to prlimit, or undefined on a host that has no equivalent. */
  limiter?: string | undefined;
  /** Overridable so the floor can be exercised without filling a real filesystem. */
  hostStorage?: ((root: string) => Promise<HostStorage>) | undefined;
  hostStoragePollMs?: number | undefined;
}

/**
 * The two operations the approved helper performs, and how each family spells them.
 *
 * This computer installs on four distribution families, and the reader of a package command knew
 * one of them: it took the first argument that was not a flag and required it to be `update` or
 * `install`, which is apt's grammar and nobody else's. `dnf install -y nmap` yielded `install` and
 * was rewritten onto a helper that ran `apt-get`, so on a Fedora or Rocky host the owner approved
 * an install and got exit 127; `pacman -S nmap` yielded `nmap` and was refused one step earlier
 * with a sentence about apt, so on an Arch host the owner approved an install and was told their
 * package name was an unsupported operation. Two wrong answers, two different messages, both after
 * the owner had already said yes.
 *
 * Left out on purpose: a whole-system rewrite. `dnf upgrade`, `apt-get upgrade` and `pacman -Syu`
 * are not what an install approval was granted for, and rounding them down to an index refresh
 * would report success for something the owner asked for and did not get. Left out for the same
 * reason: `emerge`, `rpm`, `rpm-ostree` and `yay`, which either build from source, take a local
 * file rather than a repository name, rewrite the whole image, or refuse to run as root at all.
 * They are still package management as far as the approval card and the desktop refusal are
 * concerned - they are just not something this helper can carry out.
 *
 * The helper's own argument list stays `update` / `install PACKAGE...`: which manager runs on this
 * host is the helper's question, answered where the install already knows the answer, and not a
 * fourteen-way guess made by a process that cannot see the host's release file.
 *
 * pacman has a row here even though its parse is the branch below rather than these two verbs.
 * Membership of this table is what decides whether a manager can be carried out at all, and
 * `HELPER_PACKAGE_MANAGERS` in `apps/worker/src/turn-bounds.ts` is a copy of that membership on
 * the far side of a package boundary the worker cannot import across. A pacman that was handled
 * in code but absent from the table made the two lists uncomparable, so `check-repository.mjs`
 * could not hold them together; with the row present it can, and does.
 *
 * `assent` is how the family spells "do not ask me", and it is here rather than at the two call
 * sites for the same reason the verbs are: it is the third thing that differs per family, and the
 * toolchain report needs it to tell an agent a command it can actually run.
 */
const PACKAGE_OPERATIONS: Record<string, { update: string; install: string; assent: string }> = {
  // apk needs no assent flag: it is non-interactive already, and `apk add -y` is an error.
  apk: { update: 'update', install: 'add', assent: '' },
  apt: { update: 'update', install: 'install', assent: '-y' },
  'apt-get': { update: 'update', install: 'install', assent: '-y' },
  aptitude: { update: 'update', install: 'install', assent: '-y' },
  dnf: { update: 'makecache', install: 'install', assent: '-y' },
  dnf5: { update: 'makecache', install: 'install', assent: '-y' },
  microdnf: { update: 'makecache', install: 'install', assent: '-y' },
  pacman: { update: '-Sy', install: '-S', assent: '--noconfirm' },
  yum: { update: 'makecache', install: 'install', assent: '-y' },
  zypper: { update: 'refresh', install: 'install', assent: '-y' }
};

/**
 * How to say "install these" to this host's package manager, for advice an agent can run.
 *
 * The toolchain report used to name `apt-get install -y` whatever the host was, so on a Fedora,
 * Rocky, Arch or openSUSE box the one sentence telling an agent how to close a gap named a binary
 * that host has never had. It is built from the table above rather than beside it, so the command
 * the report suggests and the command this file will accept are the same fact.
 */
export const packageInstallCommandLine = (
  manager: string,
  packages: readonly string[]
): string | undefined => {
  const spelling = PACKAGE_OPERATIONS[manager];
  if (!spelling || !packages.length) return undefined;
  return [manager, spelling.install, spelling.assent, ...packages].filter(Boolean).join(' ');
};

/** The short spellings zypper accepts, which a model that knows zypper will use. */
const ZYPPER_ALIASES: Record<string, string> = { ref: 'refresh', in: 'install' };

/**
 * Assent flags. The helper supplies its own - it runs unattended by construction - so these are
 * the only arguments dropped rather than refused. Everything else survives into the package list
 * and is answered by the name check, which is what keeps `-o APT::Update::Pre-Invoke::=id` from
 * being read as a package.
 */
const PACKAGE_ASSENT_FLAGS = new Set([
  '-y',
  '--yes',
  '--assume-yes',
  '--assumeyes',
  '--noconfirm',
  '--needed',
  '--non-interactive',
  '--no-install-recommends'
]);

/**
 * What this invocation asks the helper to do, or undefined when it asks for something else.
 *
 * pacman is read by its operation flag rather than by a verb, because that is how pacman is
 * written: `-S` with names is an install, `-Sy` with none is an index refresh, and anything
 * carrying `u` is a system upgrade and is refused above.
 */
const packageOperation = (
  manager: string,
  args: string[]
): { operation: 'update' | 'install'; packages: string[] } | undefined => {
  const spelling = PACKAGE_OPERATIONS[manager];
  if (!spelling) return undefined;
  if (manager === 'pacman') {
    const sync = args.find((argument) => /^-[A-Za-z]*S[A-Za-z]*$/.test(argument));
    if (!sync || sync.includes('u')) return undefined;
    const packages = args.filter(
      (argument) => argument !== sync && !PACKAGE_ASSENT_FLAGS.has(argument)
    );
    if (packages.length) return { operation: 'install', packages };
    return sync.includes('y') ? { operation: 'update', packages: [] } : undefined;
  }
  const verbIndex = args.findIndex((argument) => !argument.startsWith('-'));
  if (verbIndex === -1) return undefined;
  const verb =
    (manager === 'zypper' ? ZYPPER_ALIASES[args[verbIndex] ?? ''] : undefined) ??
    args[verbIndex] ??
    '';
  const operands = args.filter(
    (argument, index) => index !== verbIndex && !PACKAGE_ASSENT_FLAGS.has(argument)
  );
  // An index refresh takes no operands. One here means the model meant an operation this helper
  // does not have, and running the refresh instead would answer it with silence.
  if (verb === spelling.update)
    return operands.length ? undefined : { operation: 'update', packages: [] };
  // An install with nothing to install would be discovered by the helper, as root, which is the
  // wrong place to find out that an argument list was empty.
  if (verb === spelling.install)
    return operands.length ? { operation: 'install', packages: operands } : undefined;
  return undefined;
};

export interface ExecutionOptions {
  maximumSeconds: number;
  isolateNetwork?: boolean;
  allowSystemPackages?: boolean;
  systemPackageHelper?: string | undefined;
  /** Absent on a host that cannot drop to a separate account, such as a developer's laptop. */
  sandbox?: AgentSandbox | undefined;
  /**
   * Aborts when the caller goes away - which is what a cancelled task looks like from here. Without
   * it a `Cancel` only stopped the worker waiting for the result; the command itself kept running
   * to completion on the box, still writing files and still reaching the network.
   */
  abortSignal?: AbortSignal | undefined;
  guards?: ExecutionGuards;
}

/**
 * The PATH every agent command runs with, and therefore the one a policy check must resolve in.
 *
 * `$HOME/.local/bin` and `$HOME/bin` are on it because without them there was nowhere under `$HOME`
 * an agent could put an executable and then reach it: `shell` performs no expansion, so a command
 * cannot say `~/.local/bin/...` and have it mean anything, and `agentEnvironment` above refuses a
 * caller-supplied `PATH` by name rather than merging it. So an install could report success, leave
 * the file on the disk, and every later invocation still answer "command not found" with no
 * recovery available to the agent that had just done the installing.
 *
 * `pip install --user` is the usual reason a login shell carries these two, and it is NOT the route
 * here: measured on the owner's box, the system interpreter has no `pip` module and is marked
 * EXTERNALLY-MANAGED, so PEP 668 refuses a `--user` install before it writes anything. The route
 * that works is `python3 -m venv`, which brings its own pip - and these entries do not on their own
 * make one runnable, because a venv's executables live in its own `<prefix>/bin`, which is not on
 * this list and is not meant to be. What they give it is somewhere to put the symlink: the last
 * step of such an install is to link the entry points into `$HOME/.local/bin`, and before these two
 * entries that link led nowhere either. `skills/scientific-computing` is where the agent is told so.
 *
 * They sit ahead of the system directories for the reason every login shell puts them there - the
 * owner-installed copy is meant to win over a stale packaged one - and behind the workspace's own
 * `node_modules/.bin`, which already led the list.
 *
 * WHAT THIS DOES NOT DO is serve as the list the RUNNER finds its own helpers on. Its first three
 * entries are all directories the agent can write: index 0 is inside `$ROOT/workspace` and indices
 * 1 and 2 are inside `$ROOT/.home`, and the confine loop in `scripts/athanor-sandbox` grants write
 * on both of those roots. A helper resolved here and then spawned by the runner's own account -
 * outside the sandbox, outside the limiter - would therefore run whatever an agent had left under
 * that name. `hostSearchPath` below is the list for that, and `prepareAudio`, `findRenderTools` and
 * `probeFonts` resolve against it rather than against this.
 *
 * `probeBinaries` in `toolchain.ts` stays on this one on purpose, and so does `surfaces.ts`: both
 * answer "would this name resolve for the agent", which is a question only this list can answer,
 * and neither spawns what it resolves.
 */
export const agentSearchPath = (workspaceRoot: string): string =>
  [
    path.join(workspaceRoot, 'workspace', '.athanor', 'tools', 'node_modules', '.bin'),
    path.join(agentHome(workspaceRoot), '.local', 'bin'),
    path.join(agentHome(workspaceRoot), 'bin'),
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin'
  ].join(path.delimiter);

/**
 * The PATH the runner resolves ITS OWN helpers against, before spawning them as itself.
 *
 * System directories and nothing else, and no workspace root, because nothing on this list depends
 * on one. That is the whole difference from `agentSearchPath` above and it is a privilege boundary:
 * the three entries that list adds ahead of these are all agent-writable, and the helpers that
 * resolve here are then run by the runner's account rather than through `scripts/athanor-sandbox`.
 * `prepareAudio` (ffprobe, ffmpeg), `findRenderTools` (pdftotext, pdftoppm, athanor-office-convert)
 * and `probeFonts` (fc-list) are those helpers - six names, spawned with `shell: false` and no
 * sandboxed invocation - and they are the callers of this.
 *
 * Not a new list: `desktop.ts` has always written exactly these six directories inline for the
 * spawns of its own session, and now reads this instead, so a host that ever needs a seventh has
 * one place to gain it rather than two that drift.
 *
 * WHAT THIS DOES NOT DO is decide where the pinned interpreter comes from. `ATHANOR_PYTHON` is an
 * absolute path and `resolveExecutable` short-circuits any name holding a separator, so no search
 * path is consulted for it and moving `probePythonModules` here would change nothing.
 *
 * It also does not confine what it finds. A helper found on this list still runs unsandboxed as the
 * runner; what this removes is the agent's ability to choose which file that is.
 */
export const hostSearchPath = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin'
].join(path.delimiter);

/** The command as the kernel will receive it, after every refusal, the sandbox and the limiter. */
export interface PreparedInvocation {
  processTreeLease?: string;
  executable: string;
  args: string[];
  cwd: string;
  /** Empty when the sandbox helper is in front, because it installs the environment itself. */
  env: Record<string, string>;
}

/**
 * The part of a run request the refusals read. Both route schemas are supersets of it, which is
 * why the checks below can be stated once instead of once per schema.
 */
export interface InvocationRequest {
  /** Runner-selected lifecycle containment; never copied from a command request body. */
  superviseProcessTree?: boolean;
  /** Runner-selected lifetime for managed jobs; never accepted from command input. */
  retainProcessTree?: boolean;
  /** Curated native capability restriction; never copied from a command request body. */
  requireNetworkIsolation?: boolean;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  network: boolean;
}

/**
 * How the foreground and the background path differ, said as data.
 *
 * These checks were written twice, and the two copies drifted the way copies do: the background one
 * has never known about the system-package helper, and no test on that side ever named it. Stating
 * the difference as a field rather than as a second function means the next reader sees the whole
 * of it at once instead of diffing two hundred lines of near-identical code to find the one clause
 * that is not the same.
 *
 * `mode: 'refused'` is the background rule: a package manager is not rewritten onto the approved
 * helper, it is refused outright, because an install is an approval the owner gave for a command
 * they are watching and a process that outlives the turn is by construction not that.
 *
 * `helper` sits outside that choice, on both arms, and that placement is the whole of a live
 * privilege gap. It was once carried only by the arm that rewrites onto it, so the refusing path
 * could not name it - and naming it is exactly what the refusal below needs, because a command may
 * not invoke the helper itself. The helper's location is a fact about the host, not about what
 * this path does with a package manager, so both arms state it.
 */
export type SystemPackagePolicy =
  | { mode: 'refused'; helper: string | undefined }
  | { mode: 'approved'; allowed: boolean; helper: string | undefined };

export interface InvocationPolicy {
  isolateNetwork: boolean;
  /** Absent on a host that cannot drop to a separate account, such as a developer's laptop. */
  sandbox?: AgentSandbox | undefined;
  limits?: CommandLimits | undefined;
  /** Absolute path to prlimit, or undefined on a host that has no equivalent. */
  limiter?: string | undefined;
  systemPackages: SystemPackagePolicy;
}

/**
 * Every refusal the runner applies to a command, and the wrapping that follows them, in one place.
 *
 * Read as a sequence: the environment is settled first so a caller that believes it is applying a
 * policy is told otherwise before anything runs; the executable is then resolved the way the kernel
 * will resolve it, so a symbolic link cannot present a basename the checks do not recognise; the
 * refusals are asked against both spellings; and only then is the survivor wrapped in the sandbox
 * and the resource limiter. Nothing here spawns - that is the caller's, because the foreground path
 * awaits its child and the background path files it away, and those two lifecycles have nothing in
 * common but the arguments computed here.
 */
export const prepareInvocation = async (
  workspaceRoot: string,
  request: InvocationRequest,
  policy: InvocationPolicy
): Promise<PreparedInvocation> => {
  assertMissionWorkspaceOpen(workspaceRoot);
  const mission = await isCodingMissionWorkspace(workspaceRoot);
  const requireNetworkIsolation = mission || request.requireNetworkIsolation === true;
  if (requireNetworkIsolation && request.network)
    throw new Error('This isolated native capability cannot enable network access');
  if (
    requireNetworkIsolation &&
    (!policy.sandbox?.confineFilesystem || policy.sandbox.networkIsolation !== true)
  )
    throw new Error('This native capability requires measured filesystem and network isolation');
  const packagePolicy: SystemPackagePolicy = requireNetworkIsolation
    ? { mode: 'refused', helper: policy.systemPackages.helper }
    : policy.systemPackages;
  const searchPath = agentSearchPath(workspaceRoot);
  // Asked first, so a policy the caller believes it is applying is refused before anything runs.
  const environment = agentEnvironment(workspaceRoot, searchPath, request.env);
  // Read from workspace/ for a bare name, as a file path is, so the shell and the file tools cannot
  // answer one spelling with two directories.
  const cwd = resolveCommandDirectory(workspaceRoot, request.cwd);
  // Checked as the kernel will read it as well as as it was written, so a symbolic link or a
  // relative name cannot present a basename the checks below do not recognise.
  const resolved = await resolveExecutable(request.executable, searchPath, cwd);
  const asResolved = resolved ? { executable: resolved, args: request.args } : request;
  // Both paths contribute the package helper, because both refuse a command that names it. This
  // list used to be built from the rewriting arm alone, which left the background path holding
  // only the sandbox's elevator - and nothing at all on a host with AGENT_SANDBOX_HELPER unset,
  // a configuration config.ts documents as supported. The helper reaches root through NOPASSWD
  // sudo, so on that host a background start could name it directly and get there.
  const privilegedHelpers = [policy.systemPackages.helper, policy.sandbox?.helper];
  let executable = request.executable;
  let args = request.args;
  let sandbox = policy.sandbox;
  const requestedPackage = await packageManagerInvocation(request);
  const packageManager =
    requestedPackage ??
    (resolved && binaryName(resolved) !== binaryName(request.executable)
      ? await packageManagerInvocation(asResolved)
      : undefined);

  if (packagePolicy.mode === 'refused') {
    // One sentence for the whole family: on this path none of them is rewritten onto anything, so
    // there is no second outcome to distinguish and no reason to make the caller read six.
    if (
      privilegeEscalationBinary(request) ??
      privilegeEscalationBinary(asResolved) ??
      packageManager ??
      privilegedHelperInvocation(request, privilegedHelpers) ??
      privilegedHelperInvocation(asResolved, privilegedHelpers)
    ) {
      const reason = requireNetworkIsolation
        ? 'Privilege and system-package operations cannot run in an isolated native capability'
        : 'Privilege and system-package operations cannot run as background processes';
      throw new Error(
        packageManager && !requireNetworkIsolation
          ? `${reason}. Use shell with the package manager as executable, its supported update/install arguments, and no wrapper, PTY or background. Ordinary commands may yield into managed processes automatically.`
          : reason
      );
    }
  } else {
    if (privilegeEscalationBinary(request) ?? privilegeEscalationBinary(asResolved)) {
      throw new Error(
        "Direct privilege escalation is disabled; install packages with this computer's own package manager so Athanor can apply the approval policy"
      );
    }
    if (
      privilegedHelperInvocation(request, privilegedHelpers) ??
      privilegedHelperInvocation(asResolved, privilegedHelpers)
    ) {
      throw new Error(
        "Athanor's own privileged helpers are reached by the runner after an approval, not by a command"
      );
    }
    // A wrapped package run cannot be rewritten onto the approved helper, so it never executes.
    if (packageManager === 'wrapped') {
      throw new Error(
        'Host-native package management supports approved update and install only, named directly rather than through a wrapper'
      );
    }
    if (packageManager === 'direct') {
      const { allowed, helper } = packagePolicy;
      if (!allowed || !helper) {
        throw new Error('An approved system-packages capability is required');
      }
      // Whichever spelling matched is the manager: `packageManagerInvocation` answers `direct` only
      // for the executable's own basename, and the resolved form is the one the kernel will run.
      const manager =
        requestedPackage === 'direct'
          ? binaryName(request.executable)
          : binaryName(asResolved.executable);
      const asked = packageOperation(manager, request.args);
      if (!asked) {
        throw new Error(
          `Host-native package management supports approved update and install only, and this ${manager} command is neither`
        );
      }
      if (
        asked.packages.some(
          (packageName) => !/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9_-]*)?$/i.test(packageName)
        )
      ) {
        throw new Error('Package names may not contain options, paths, or hook configuration');
      }
      executable = helper;
      args = asked.operation === 'update' ? ['update'] : ['install', ...asked.packages];
      // The approved package install is the one command that has to keep the runner's own identity:
      // it reaches root through sudo, which the sandbox deliberately makes impossible.
      sandbox = undefined;
    }
  }

  // The limiter wraps the sandbox rather than the other way round: resource limits are inherited
  // across exec, so setting them outermost applies them to everything underneath.
  const sandboxed = sandbox
    ? await sandboxedInvocation(
        { executable, args },
        environment,
        sandbox,
        requireNetworkIsolation || (policy.isolateNetwork && !request.network),
        // The workspace this command belongs to, which is the one directory tree a confined
        // command may write in. Named here rather than derived inside the helper's caller
        // because this is the only place that knows it, and both execution paths - the
        // foreground command and the background session - arrive at this line.
        workspaceRoot,
        cwd,
        request.superviseProcessTree === true,
        request.retainProcessTree === true
      )
    : { executable, args };
  const limited = limitedInvocation(sandboxed, policy.limits, policy.limiter);
  return {
    ...('processTreeLease' in sandboxed ? { processTreeLease: sandboxed.processTreeLease } : {}),
    executable: limited.executable,
    args: limited.args,
    // Where the process is started matters as much as what it is handed when the process is
    // sudo: its journal line records the directory it was started from, and started from the
    // directory the agent chose it wrote `workspace/acme-lawsuit-discovery` - a name used inside
    // the task - there for every command, beside the modes. So a sandboxed command starts sudo
    // from the container root, which the line already names as the workspace, and the helper
    // enters the directory it was asked for from the spec, after sudo has written its line.
    cwd: sandbox ? workspaceRoot : cwd,
    // The sandbox helper installs the environment itself, from the spec, because sudo resets it.
    env: sandbox ? {} : environment
  };
};

/**
 * One foreground command, run to completion under every guard the runner puts around it: the
 * bounded collectors, the deadline, the caller's abort, and the host-disk floor.
 *
 * Deliberately not shared with the background path, and this is the note that says why so the next
 * reader does not try again. There the collectors are the session's own buffers and keep only the
 * tail; the deadline mutates a session row rather than a local flag, and is absent entirely for a
 * declared service; the floor retires a supervised service before it stops the process, or the
 * supervisor puts the thing that filled the disk straight back into it; and there is no abort at
 * all, because `processes/start` has already answered by the time a task is cancelled. Four of the
 * five guards differ in what they do, not in how they are wired, so a shared version would be five
 * callbacks around a `spawn` - more surface than the duplication it removed.
 */
const startGuardedChild = async (
  workspaceRoot: string,
  prepared: PreparedInvocation,
  options: {
    stdin: string | undefined;
    maxOutputBytes: number;
    timeoutMs: number;
    abortSignal: AbortSignal | undefined;
    guards: ExecutionGuards;
  }
): Promise<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  diskExhausted: boolean;
}> => {
  const { abortSignal, guards } = options;
  const child = spawn(prepared.executable, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Leads its own process group so a timeout reaches grandchildren too.
    detached: true,
    shell: false
  });
  trackMissionInvocation(workspaceRoot, prepared, child);

  const output = boundedCollector(options.maxOutputBytes);
  const errors = boundedCollector(options.maxOutputBytes);
  child.stdout.on('data', (chunk: Buffer) => {
    output.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errors.push(chunk);
  });
  if (options.stdin) child.stdin.end(options.stdin);
  else child.stdin.end();

  let timedOut = false;
  let cancelled = false;
  let diskExhausted = false;
  let escalation: NodeJS.Timeout | undefined;
  const stopTree = () => {
    escalation = stopProcessTree(child);
  };
  // A command that keeps writing past the floor is stopped rather than allowed to reach the last
  // free byte: PostgreSQL shares this filesystem, and a full disk stops the database, the
  // interface and every other task, not just the command that caused it.
  const storageProbe = guards.hostStorage ?? probeHostStorage;
  let probing = false;
  const diskFloor = setInterval(() => {
    if (probing || diskExhausted) return;
    probing = true;
    void storageProbe(workspaceRoot)
      .then((storage) => {
        if (!belowHostStorageFloor(storage)) return;
        diskExhausted = true;
        stopTree();
      })
      .catch(() => undefined)
      .finally(() => {
        probing = false;
      });
  }, guards.hostStoragePollMs ?? DISK_FLOOR_POLL_MS);
  diskFloor.unref();
  const onAbort = () => {
    cancelled = true;
    stopTree();
  };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    stopTree();
  }, options.timeoutMs);
  timeout.unref();

  const { exitCode, signal } = await awaitChildExit(child);
  clearTimeout(timeout);
  clearInterval(diskFloor);
  if (escalation) clearTimeout(escalation);
  abortSignal?.removeEventListener('abort', onAbort);
  // The wrapper may have died on SIGTERM while its descendants kept running.
  if (timedOut || cancelled || diskExhausted) killProcessTree(child, 'SIGKILL');
  return {
    exitCode,
    signal,
    stdout: output.text('stdout'),
    stderr: errors.text('stderr'),
    timedOut,
    // Returned, not just held, because the note for a SIGKILL nobody here performed can only be
    // written by ruling out the three this process does perform - and all three end in SIGKILL.
    cancelled,
    diskExhausted
  };
};

/**
 * Refuses a run that could never last as long as it just asked to.
 *
 * `Math.min(request.timeoutSeconds, maximumSeconds)` is the enforcement on both paths, and a clamp
 * is silent by construction: a command asked for six hours, killed at one, reports the same shape
 * as one that asked for an hour. Six hours of a genome pipeline die at the one-hour mark with
 * nothing in the result naming either number. Refusing before anything starts costs the caller a
 * round trip and tells it exactly which field to change; clamping costs it the hour.
 *
 * Read from the RAW request rather than the parsed one, deliberately. The schema defaults
 * `timeoutSeconds`, and a host may be configured with a ceiling below that default - every runner
 * test on this repository runs at 30 - so refusing the parsed value would refuse commands whose
 * caller never named a timeout at all. Only a number somebody actually wrote is answered for.
 */
export const refuseUnreachableTimeout = (
  value: unknown,
  maximumSeconds: number,
  background: boolean
): void => {
  const named = (value as { timeoutSeconds?: unknown } | null | undefined)?.timeoutSeconds;
  if (typeof named !== 'number' || named <= maximumSeconds) return;
  throw new Error(
    background
      ? `This computer stops a background command after ${maximumSeconds}s and you asked for ${named}s, so it would have been killed part-way through rather than run. Ask for ${maximumSeconds}s or less, or declare it as a service if it is meant to keep running.`
      : `This computer stops a foreground command after ${maximumSeconds}s and you asked for ${named}s, so it would have been killed part-way through rather than run. Start it with background: true, which allows much longer, and watch it with process(poll).`
  );
};

export const execute = async (
  workspaceRoot: string,
  value: unknown,
  options: ExecutionOptions
): Promise<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stoppedReason?: 'host_disk_floor';
}> => {
  const {
    maximumSeconds,
    isolateNetwork = false,
    allowSystemPackages = false,
    systemPackageHelper,
    sandbox,
    abortSignal,
    guards = {}
  } = options;
  const request = ExecRequest.parse(value);
  refuseUnreachableTimeout(value, maximumSeconds, false);
  const prepared = await prepareInvocation(workspaceRoot, request, {
    isolateNetwork,
    sandbox,
    limits: guards.limits,
    limiter: guards.limiter,
    systemPackages: { mode: 'approved', allowed: allowSystemPackages, helper: systemPackageHelper }
  });
  // Started after the refusals, so a PATH resolution the caller never sees is not billed to the
  // command as time it spent running.
  const started = performance.now();
  const allowedSeconds = Math.min(request.timeoutSeconds, maximumSeconds);
  const run = await startGuardedChild(workspaceRoot, prepared, {
    stdin: request.stdin,
    maxOutputBytes: request.maxOutputBytes,
    timeoutMs: allowedSeconds * 1_000,
    abortSignal,
    guards
  });
  // Every stop this path can perform says which one it was, on the stream the result carries. The
  // two it does not perform - the kernel's kill and the ruleset's refusal - are decided in
  // `unclaimedStopNote`, which the background path asks the same question, and are asked for only
  // when none of the stops above happened: a command killed at its deadline is not also told about
  // the filesystem boundary.
  const unclaimed = unclaimedStopNote(
    {
      stderr: () => run.stderr,
      exitCode: run.exitCode,
      signal: run.signal,
      claimed: run.diskExhausted || run.timedOut,
      cancelled: run.cancelled
    },
    workspaceRoot,
    Boolean(sandbox?.confineFilesystem)
  );
  const stderr = run.diskExhausted
    ? `${run.stderr}\n${HOST_DISK_FLOOR_NOTE}`
    : run.timedOut
      ? `${run.stderr}\n${timedOutNote(allowedSeconds, maximumSeconds, false)}`
      : unclaimed
        ? `${run.stderr}\n${unclaimed}`
        : run.stderr;
  return {
    exitCode: run.exitCode,
    signal: run.signal,
    stdout: run.stdout,
    stderr,
    durationMs: Math.round(performance.now() - started),
    timedOut: run.timedOut,
    ...(run.diskExhausted ? { stoppedReason: 'host_disk_floor' as const } : {})
  };
};
