import type { ChildProcess } from 'node:child_process';
import { once, type EventEmitter } from 'node:events';

export type ProcessHandle = EventEmitter &
  Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>;

// A finished command can leave a grandchild holding the inherited pipes open, so
// 'close' may never arrive. Wait for the flush, but never longer than this.
export const DEFAULT_FLUSH_GRACE_MS = 1_000;

/**
 * Waits for the child to exit and for its stdout/stderr to drain. Resolving on 'exit'
 * alone drops whatever is still buffered in the pipes.
 *
 * The grace is a parameter because the two halves of this rule - the drain wins when output is
 * still in flight, and the bound wins when a grandchild holds the pipe open forever - are opposite
 * sides of the same timer, and a test cannot assert one of them against a deadline it does not
 * control. Asserting the drain against the shipped 1s meant racing a fixture's own wall clock
 * against it, which is a bet on how fast a loaded machine forks; that bet is what made the
 * background-process tests flaky. Nothing in production passes a value.
 */
export const awaitChildExit = async (
  child: ProcessHandle,
  flushGraceMs: number = DEFAULT_FLUSH_GRACE_MS
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> => {
  // Attached before the exit await so a spawn failure rejects here too instead of
  // surfacing as an unhandled rejection.
  const closed = once(child, 'close').then(
    () => undefined,
    () => undefined
  );
  const [exitCode, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      const grace = setTimeout(resolve, flushGraceMs);
      grace.unref();
    })
  ]);
  return { exitCode, signal };
};

/**
 * Signals the child's whole process group. Children are spawned detached so that a shell
 * or wrapper cannot orphan its own descendants when only the direct child is killed.
 */
export const killProcessTree = (child: ProcessHandle, signal: NodeJS.Signals): void => {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // No group remains, or the child never became a group leader; fall back to the child.
    child.kill(signal);
  }
};

/** Stop the whole group, allowing a short flush before escalation. */
export const stopProcessTree = (child: ProcessHandle): NodeJS.Timeout => {
  killProcessTree(child, 'SIGTERM');
  const escalation = setTimeout(() => killProcessTree(child, 'SIGKILL'), 2_000);
  escalation.unref();
  return escalation;
};
