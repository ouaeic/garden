/**
 * How long a foreground command that named no timeout holds the turn before the model hears it is
 * still running. The runner stops such a command at five minutes, and until then the model could do
 * nothing about a query scanning an unindexed table or a program waiting on input; on a task of
 * fifteen minutes two of those were ten of them. Past this the command keeps running as the job the
 * runner already made it, so work that is merely long costs one `process wait` and nothing else.
 * The shell tool's schema states it, so the model can plan around it rather than meet it.
 */
export const UNTIMED_COMMAND_WAIT_SECONDS = 120;

/** The exact deferred command is shared by approval evaluation and runner dispatch. */
export const checkpointInvocation = (
  args: Record<string, unknown>
): Record<string, unknown> | null => {
  const command = args.checkpointResumeCommand;
  if (command === undefined) return null;
  if (typeof command !== 'string' || !command.trim() || command.length > 100_000)
    throw new Error('checkpointResumeCommand must be a nonempty checkpoint-aware command');
  return {
    executable: 'bash',
    args: ['-lc', command],
    ...Object.fromEntries(
      ['cwd', 'env', 'network', 'maxOutputBytes', 'pty']
        .filter((key) => args[key] !== undefined)
        .map((key) => [key, args[key]])
    )
  };
};

export const shellJobExecution = (args: Record<string, unknown>): Record<string, unknown> => {
  if (args.checkpointResume !== undefined)
    throw new Error(
      'Use checkpointResumeCommand to declare an approved checkpoint recovery command'
    );
  if (
    args.job !== undefined &&
    (typeof args.job !== 'string' || !args.job.trim() || args.job.length > 120)
  )
    throw new Error('job must name the finite background work');
  if (args.job !== undefined && (args.background !== true || args.service !== undefined))
    throw new Error('A finite job requires background=true and cannot also be a service');
  const checkpoint = checkpointInvocation(args);
  if (checkpoint && !args.job) throw new Error('checkpointResumeCommand requires a finite job');
  const execution = { ...args };
  delete execution.background;
  delete execution.checkpointResumeCommand;
  if (checkpoint) execution.checkpointResume = checkpoint;
  return execution;
};
