import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { awaitChildExit, killProcessTree, stopProcessTree } from './subprocess.js';

export class ProjectGitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null
  ) {
    super(message);
    this.name = 'ProjectGitError';
  }
}

/** Only Garden-owned repositories reach this adapter; workspace config is never inherited. */
export async function projectGitCommand(
  directory: string,
  args: string[],
  input?: string | Readable,
  options: {
    env?: Record<string, string>;
    signal?: AbortSignal;
    maxBytes?: number;
    readFd?: number;
  } = {}
): Promise<string> {
  options.signal?.throwIfAborted();
  const child = spawn(
    '/usr/bin/git',
    [
      '--no-replace-objects',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'gc.auto=0',
      '-c',
      'core.fsync=committed,reference',
      '-c',
      'core.fsyncMethod=fsync',
      '-c',
      'maintenance.auto=false',
      '-c',
      'transfer.fsckObjects=true',
      '-c',
      'fetch.fsckObjects=true',
      ...args
    ],
    {
      cwd: directory,
      stdio: ['pipe', 'pipe', 'pipe', ...(options.readFd === undefined ? [] : [options.readFd])],
      detached: true,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
        ...options.env
      }
    }
  );
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let size = 0,
    errorSize = 0,
    overflow = false;
  let escalation: NodeJS.Timeout | undefined;
  const stop = () => {
    escalation ??= stopProcessTree(child);
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  child.stdout!.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > (options.maxBytes ?? 1_048_576)) {
      overflow = true;
      stop();
    } else stdout.push(chunk);
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    errorSize += chunk.length;
    if (errorSize <= 8192) stderr.push(chunk);
  });
  const finished = awaitChildExit(child)
    .then(({ exitCode: code }) => {
      options.signal?.throwIfAborted();
      if (overflow)
        throw Error('Repository metadata exceeds the display limit. Narrow the selection.');
      else if (code !== 0)
        throw new ProjectGitError(
          `Git operation failed: ${Buffer.concat(stderr).toString('utf8').slice(0, 2000)}`,
          code
        );
    })
    .finally(() => {
      options.signal?.removeEventListener('abort', stop);
      if (escalation) clearTimeout(escalation);
      // A transport helper must not outlive its managed command, even after the parent exits.
      killProcessTree(child, 'SIGKILL');
      child.stdin!.destroy();
      child.stdout!.destroy();
      child.stderr!.destroy();
    });
  const write =
    typeof input === 'object'
      ? pipeline(input, child.stdin!)
      : new Promise<void>((resolve, reject) => {
          child.stdin!.once('error', reject);
          child.stdin!.end(input ?? '', () => resolve());
        });
  const outcomes = await Promise.allSettled([
    finished,
    write.catch((error: unknown) => {
      stop();
      throw error;
    })
  ]);
  const failed = outcomes.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return Buffer.concat(stdout).toString('utf8');
}

export async function projectGitIsAncestor(
  directory: string,
  ancestor: string,
  descendant: string
) {
  try {
    await projectGitCommand(directory, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof ProjectGitError && error.exitCode === 1) return false;
    throw error;
  }
}
