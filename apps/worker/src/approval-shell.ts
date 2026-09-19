import { withTaskApproval } from './approval-grants.js';
/** Command effects, including destructive operations, publishing and network access. */
import { type SecurityMode } from '@athanor/contracts';
import { textValue } from './values.js';
import {
  commandInterpreters,
  commandCarriedIntoAnotherBox,
  commandsChangeDirectory,
  commandScript,
  commandText,
  consequentialExecutables,
  COMMAND_RUNNERS,
  destructionOperation,
  effectiveCommands,
  forcedGitPush,
  gitConfigRunsCode,
  gitRemovesAWorktree,
  gitSubcommand,
  insideCheckpointContent,
  isDestructiveScript,
  reachesAnUnreadableFarEnd,
  noEgressExecutables,
  outboundDestinations,
  packageInstallCommands,
  packageRemovalCommands,
  packageRemovalExecutables,
  publishingOperation,
  RELOCATING_EXECUTABLES,
  removalTargets,
  removesUncoveredFile,
  safeNetworkExecutables,
  scriptDestroysAStore,
  sendsDataOverNetwork,
  signalStopsThisComputer,
  type DestructionOperation
} from './command-classification.js';
import {
  type ApprovalContext,
  type ApprovalRequirement,
  SECURITY_MODE_FLOOR,
  DEFERRED_EXECUTION_ACTION,
  namedObjects,
  shellInvocation
} from './approval-common.js';

// Local inspection excludes helper execution and shell socket redirections.
const LOCAL_INSPECTION_EXECUTABLES = new Set([
  'ls',
  'cat',
  'cut',
  'tr',
  'uniq',
  'grep',
  'egrep',
  'fgrep',
  'sort',
  'head',
  'tail',
  'wc',
  'stat',
  'sha256sum',
  'sha512sum'
]);

const localInspectionCommand = (command: string, args: string[]): boolean => {
  if (!LOCAL_INSPECTION_EXECUTABLES.has(command)) return false;
  // sort can launch a compressor. Only fixed inspection options and literal operands qualify.
  return (
    command !== 'sort' ||
    args.every((argument) => {
      const value = argument.replace(/^['"]|['"]$/g, '');
      return (
        /^-[bdfghinMrsuVzcCm]+$/.test(value) ||
        ['--unique', '--reverse', '--numeric-sort', '--stable', '--help', '--version'].includes(
          value
        ) ||
        (!value.startsWith('-') && /^[\w./+]+$/.test(value))
      );
    })
  );
};

export const shellApprovalRequirement = (
  name: string,
  args: Record<string, unknown>,
  securityMode: SecurityMode,
  context: ApprovalContext
): ApprovalRequirement | undefined => {
  const destructiveCommand = (
    executable: string,
    commandArgs: string[],
    rebased = false
  ): {
    action: string;
    preview: string;
    recovery?: NonNullable<ApprovalRequirement['recovery']>;
  } | null => {
    const lowerArgs = commandArgs.map((argument) => argument.toLowerCase());
    const gitCommand = executable === 'git' ? gitSubcommand(commandArgs) : null;
    const unstageOnly =
      commandArgs.some((argument) => argument === '--staged' || argument === '-S') &&
      !commandArgs.some((argument) => argument === '--worktree' || argument === '-W');
    const gitDestructive =
      (gitCommand === 'clean' && lowerArgs.some((argument) => /^-[a-z]*f/.test(argument))) ||
      (gitCommand === 'reset' && lowerArgs.includes('--hard')) ||
      (gitCommand === 'restore' && !unstageOnly) ||
      (gitCommand === 'checkout' && lowerArgs.includes('--')) ||
      (executable === 'git' && gitRemovesAWorktree(commandArgs));
    const findDelete = executable === 'find' && lowerArgs.includes('-delete');
    const rsyncDelete = executable === 'rsync' && lowerArgs.includes('--delete');
    const wrapped =
      (COMMAND_RUNNERS.has(executable) ||
        (executable === 'find' &&
          lowerArgs.some((argument) => ['-exec', '-execdir', '-ok'].includes(argument)))) &&
      commandArgs.some((argument) => {
        const name = argument.split('/').pop() ?? '';
        return (
          consequentialExecutables.has(name) ||
          RELOCATING_EXECUTABLES.has(name) ||
          name.startsWith('mkfs')
        );
      });
    const packageRemoval =
      packageRemovalExecutables.has(executable) &&
      lowerArgs.some((argument) => packageRemovalCommands.has(argument));
    const destructiveScript =
      commandInterpreters.has(executable) && isDestructiveScript(commandScript(args), executable);
    if (signalStopsThisComputer(executable, commandArgs))
      return {
        action: `Stop this computer with ${executable}`,
        preview: `Run ${[executable, ...commandArgs].join(' ')}. PID 1 is this computer's init process and -1 is every process on it: signalling either ends everything running here, this turn included, and nothing on this computer starts it again.`
      };
    const relocation = RELOCATING_EXECUTABLES.has(executable);
    if (
      !(
        consequentialExecutables.has(executable) ||
        executable.startsWith('mkfs') ||
        relocation ||
        gitDestructive ||
        findDelete ||
        rsyncDelete ||
        wrapped ||
        packageRemoval ||
        destructiveScript
      )
    )
      return null;
    const removals = rebased
      ? null
      : removalTargets(
          executable,
          commandArgs,
          commandInterpreters.has(executable) ? commandScript(args) : ''
        );
    const workingDirectory = textValue(args.cwd) || 'workspace';
    const uncovered = context.undoPoint?.uncovered;
    if (
      context.undoPoint?.id &&
      uncovered !== undefined &&
      removals?.every(
        (target) =>
          insideCheckpointContent(target, workingDirectory) &&
          !removesUncoveredFile(target, workingDirectory, uncovered)
      )
    )
      return null;
    if (rebased && context.undoPoint?.id && context.undoPoint.uncovered !== undefined)
      return {
        action: relocation ? 'Review a file move' : 'Review a file removal',
        recovery: 'use_explicit_cwd',
        preview: `Run ${[executable, ...commandArgs].join(' ')}. The command changes its own working directory, so Garden cannot establish whether every affected file is covered by this turn's undo point. Use an explicit cwd and separate the directory change so the paths can be checked.`
      };
    if (relocation)
      return {
        action: `Move data out of reach with ${executable}`,
        preview: `Run ${[executable, ...commandArgs].join(' ')}. This empties the place it moves from, and that place is outside the turn's undo point - which covers workspace/ and .athanor/artifacts and nothing else - so rewinding this turn does not put it back. Nothing has to be deleted for this computer to lose the agent's own keys or its shell configuration this way.`
      };
    return {
      action: `Run ${executable}`,
      preview: `Run ${[executable, ...commandArgs].join(' ')}\n\nThis runs in the workspace and can remove or overwrite data.`
    };
  };
  const commandRequirement = (): ApprovalRequirement | null => {
    const executable = textValue(args.executable).split('/').pop() ?? '';
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const invocation = shellInvocation(args);
    const publishCard = ({
      kind,
      operation
    }: NonNullable<ReturnType<typeof publishingOperation>>): {
      action: string;
      preview: string;
    } => {
      if (kind === 'registry')
        return {
          action: `Publish to a package registry with ${operation}`,
          preview: `Run ${invocation}. This changes what anyone installing this package gets. A version that has reached a public registry cannot be taken back by this computer - npm allows an unpublish for 72 hours and crates.io does not allow one at all - and withdrawing or re-pointing one breaks every build that already resolved it.`
        };
      if (kind === 'publishes')
        return {
          action: `Publish online with ${operation}`,
          preview: `Run ${invocation}. This puts what is here on a hosted service, where anyone with the address can read it. What it replaces is held on that service and not on this computer, so this computer cannot put the previous version back, and anything already fetched from the old one stays fetched.`
        };
      return {
        action: `Change what is deployed with ${operation}`,
        preview: `Run ${invocation}. This changes what is running on infrastructure outside this computer. The state it overwrites lives on that infrastructure, so nothing here can restore it, and whatever depends on the running version sees the change immediately.`
      };
    };
    const commands = effectiveCommands(args);
    const rebased = commandsChangeDirectory(commands);
    const carried = commands
      .map((command) => commandCarriedIntoAnotherBox(command))
      .filter((inner): inner is NonNullable<typeof inner> => inner !== null);
    const destructive =
      destructiveCommand(executable, commandArgs, rebased) ??
      commands
        .map(([command = '', ...rest]) => destructiveCommand(command, rest, rebased))
        .find(Boolean);
    if (destructive) return { sideEffect: 'external_consequential', ...destructive };
    const inScript = scriptDestroysAStore(commandScript(args), executable);
    const inAnotherBox = carried
      .map(({ carrier, command }): DestructionOperation | null => {
        const found = destructionOperation(command);
        if (found) return { kind: 'carried', operation: `${carrier} ${found.operation}` };
        const [head = '', ...rest] = command;
        return destructiveCommand(head, rest, true)
          ? { kind: 'carried', operation: `${carrier} ${head}` }
          : null;
      })
      .find(Boolean);
    const destruction =
      commands.map((command) => destructionOperation(command)).find(Boolean) ??
      (commands.length === 0 && commandInterpreters.has(executable)
        ? destructionOperation(commandArgs)
        : null) ??
      (inScript ? ({ kind: 'store', operation: inScript } as const) : null) ??
      inAnotherBox;
    if (destruction)
      return {
        sideEffect: 'external_consequential',
        action:
          destruction.kind === 'store'
            ? `Destroy stored data with ${destruction.operation}`
            : destruction.kind === 'carried'
              ? `Destroy data in another container with ${destruction.operation}`
              : `Install work that outlives this turn with ${destruction.operation}`,
        preview:
          destruction.kind === 'store'
            ? `Run ${invocation}. What this removes is not in the workspace - a database, a cache, a bucket or a container volume all live outside it - so rewinding this turn does not put it back. The turn's undo point covers workspace/ and .athanor/artifacts and nothing else.`
            : destruction.kind === 'carried'
              ? `Run ${invocation}. This carries the command into another container or pod and runs it there. The turn's undo point covers workspace/ and .athanor/artifacts on this computer and nothing on the other side of that boundary, so rewinding this turn leaves whatever it did there done.`
              : `Run ${invocation}. This installs something that runs after this task and every card in it is over, under a process no approval here governs, and it is not inside the turn's undo point either - rewinding this turn leaves it running.`
      };
    const publishing =
      commands.map((command) => publishingOperation(command)).find(Boolean) ??
      (commands.length === 0 && commandInterpreters.has(executable)
        ? publishingOperation(commandArgs)
        : null);
    if (publishing) return { sideEffect: 'external_consequential', ...publishCard(publishing) };
    const gitConfigWrite = commands.find(
      ([command = '', ...rest]) => command === 'git' && gitConfigRunsCode(rest)
    );
    if (gitConfigWrite)
      return {
        sideEffect: 'external_consequential',
        action: DEFERRED_EXECUTION_ACTION,
        preview: `Run ${invocation}. git config writes .gitconfig without naming it, and what lands there - core.hooksPath, or an alias - is executed by every later git invocation on this computer, outside any approval this task could raise.`
      };
    const installer = commands.find(
      ([command = '', ...rest]) =>
        packageRemovalExecutables.has(command) &&
        rest.some((argument) => packageInstallCommands.has(argument.toLowerCase()))
    );
    if (installer && SECURITY_MODE_FLOOR[securityMode].asksBeforeInstallingSoftware)
      return withTaskApproval(
        {
          sideEffect: 'external_reversible',
          action: `Install or update software with ${installer[0]}`,
          preview: `Run ${invocation} inside the persistent Linux computer. Downloaded software and its publisher terms become part of this installation.`
        },
        name,
        args,
        'install'
      );
    const forced = commands.find((command) => forcedGitPush(command));
    if (forced)
      return {
        sideEffect: 'external_consequential',
        action: 'Overwrite history on a Git remote',
        preview: `Run ${invocation}. A forced push replaces what the remote has rather than adding to it, and the commits it discards live on that remote and not on this computer, so nothing here can put them back. Anyone who already fetched the old history keeps a copy this one no longer agrees with.`
      };
    if (
      securityMode !== 'autonomous' &&
      commands.some(
        ([command = '', ...rest]) => command === 'git' && gitSubcommand(rest) === 'push'
      )
    )
      return {
        sideEffect: 'external_reversible',
        action: 'Push Git changes',
        preview: `Run ${invocation}`
      };
    const sender = commands.find(([command = '', ...rest]) => sendsDataOverNetwork(command, rest));
    if (sender)
      return {
        sideEffect: 'external_reversible',
        action: `Send data using ${sender[0]}`,
        preview: `Run ${invocation} with outbound network access. This can change an external service or upload workspace data.`
      };
    return null;
  };
  if (name === 'desktop_launch') {
    const requirement = commandRequirement();
    if (requirement) return requirement;
  }
  if (name === 'shell') {
    const executable = textValue(args.executable).split('/').pop() ?? '';
    const commands = effectiveCommands(args);
    const requirement = commandRequirement();
    if (requirement) return requirement;
    const outbound = outboundDestinations(name, args, context.selfOrigins ?? []);
    const unreadable = reachesAnUnreadableFarEnd(args);
    const reachesOutside = outbound.length > 0 || unreadable;
    if (reachesOutside && !SECURITY_MODE_FLOOR[securityMode].asksBeforeReachingTheInternet) {
      const shellSocket = /\/dev\/(?:tcp|udp)\//.test(commandText(args));
      const computedValue = /\$\(|`/.test(commandText(args));
      const unlisted = commands.find(
        ([command = '', ...rest]) =>
          !(
            noEgressExecutables.has(command) ||
            (!shellSocket && localInspectionCommand(command, rest)) ||
            safeNetworkExecutables.has(command) ||
            command === 'gh'
          )
      );
      // Segment splitting can retain a URL's static prefix while losing its computed suffix.
      // Mixed network/substitution commands must be separated before local filters can clear them.
      if (unreadable || computedValue || unlisted || commands.length === 0)
        return withTaskApproval(
          {
            sideEffect: 'external_reversible',
            action: `Review network access for ${unlisted?.[0] || executable || 'command'}`,
            recovery: 'separate_network_steps',
            preview: `Garden cannot verify the network effects of ${unlisted?.[0] || executable || 'this command'}. Addresses referenced: ${outbound.length ? namedObjects([...new Set(outbound.map(({ host }) => host))]) : 'unresolved'}.\n\nCommand: ${shellInvocation(args)}`
          },
          name,
          args,
          'network'
        );
    }
    if (reachesOutside && SECURITY_MODE_FLOOR[securityMode].asksBeforeReachingTheInternet)
      return withTaskApproval(
        {
          sideEffect: 'external_reversible',
          action: `Allow internet access for ${executable || 'command'}`,
          preview: outbound.length
            ? `This command accesses ${namedObjects([...new Set(outbound.map(({ host }) => host))])}.\n\nCommand: ${shellInvocation(args)}`
            : `Garden could not determine this command's network destination.\n\nCommand: ${shellInvocation(args)}`
        },
        name,
        args,
        'network'
      );
  }
  return undefined;
};
