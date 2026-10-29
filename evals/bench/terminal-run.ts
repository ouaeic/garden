/**
 * The orchestration a Terminal-Bench score needs, and nothing else.
 *
 * `score.ts` drives one task through a real `AgentWorker` against the shim and takes its verdict
 * from the box. It deliberately does not know how a box comes to exist: `backend.ts` says the
 * container "is created by the benchmark's own task definition, which is the only thing that knows
 * the image, the network mode and the verifier's expectations". This file is that thing.
 *
 * Per task, in order: start a container from the image built for it, hand `scoreTask` a factory
 * that attaches a backend to it, stage the tests for the already-solved guard, take them out again
 * before the turn can see them, put them back for the verdict, and remove the container. The
 * staging dance is not tidiness - it is the only arrangement in which BOTH of the two rules hold.
 * @see the `staging` parameter of `scoreTask`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { dockerBackend, type WorkspaceBackend } from './backend.js';
import { scoreTask, type ScoredTask } from './score.js';
import type { LiveProvider } from '../harness.js';
import type { Arm } from './parity.js';
import {
  TERMINAL_BENCH_TEST_DIR,
  TERMINAL_BENCH_RUN_TESTS,
  type TerminalBenchTask
} from './terminal-bench.js';

const run = promisify(execFile);

/**
 * Docker on the box this runs on needs `sudo -n`: the `docker` group is empty there by decision,
 * and adding the operator to it is the operator's call and not this rig's. Taken as a parameter so
 * a machine where it is not needed does not acquire a dependency on sudo.
 */
export interface DockerOptions {
  readonly sudo: boolean;
  /** Seconds the container is kept alive. The task's own agent ceiling, plus room for the verifier. */
  readonly lifetimeSeconds: number;
  /**
   * What tells this process's container apart from another process's container for the SAME task.
   *
   * Several processes run disjoint (arm, run-index) pairs over one task set on one box, and they
   * all start at the same first task. A container named after the task alone is then one name for
   * four containers: the second `docker run` fails on the name, and worse, the `rm -f` each process
   * issues before it starts and after it finishes removes whichever container currently holds that
   * name - another process's, mid-turn. Required rather than defaulted, so a caller cannot forget to
   * say who it is.
   */
  readonly label: string;
}

/**
 * The container name for one task under one process, and a pure function so it can be held to its
 * two properties without a daemon: two labels never share a name, and the name is one Docker accepts.
 */
export const containerNameFor = (taskId: string, label: string): string =>
  `tb-run-${taskId}-${label}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 60);

const docker = async (
  sudo: boolean,
  args: readonly string[],
  timeoutMs = 600_000
): Promise<string> => {
  const argv = sudo ? ['-n', 'docker', ...args] : [...args];
  const { stdout } = await run(sudo ? 'sudo' : 'docker', argv, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
};

/** Best effort, and silent: a container that is already gone is the state this wanted. */
const removeQuietly = async (sudo: boolean, container: string): Promise<void> => {
  await docker(sudo, ['rm', '-f', container], 120_000).catch(() => '');
};

/**
 * One task, in its own container, scored.
 *
 * The container is removed in a `finally` whatever happens, including a throw out of `scoreTask` -
 * a benchmark that leaks a container per failed task fills a disk and then fails every task after
 * it for a reason that has nothing to do with the agent.
 */
export const scoreTerminalBenchTask = async (
  task: TerminalBenchTask,
  options: DockerOptions,
  live?: LiveProvider,
  /** The arm this task runs under; `scoreTask` derives the mode and the approver from it. */
  arm: Arm = 'shipped'
): Promise<ScoredTask> => {
  const container = containerNameFor(task.id, options.label);
  const image = `tb/${task.id}`;
  await removeQuietly(options.sudo, container);
  await docker(options.sudo, [
    'run',
    '-d',
    '--name',
    container,
    image,
    'sh',
    '-c',
    `sleep ${Math.max(60, Math.ceil(options.lifetimeSeconds))}`
  ]);
  try {
    const place = async (): Promise<void> => {
      for (const staged of task.stage)
        await docker(options.sudo, ['cp', staged.source, `${container}:${staged.containerPath}`]);
    };
    /*
     * `docker exec rm -rf`, not `docker cp` of an empty directory: the point is that the paths do
     * not exist while the turn runs, and an empty `/tests` is a path that exists. An agent reading
     * the box would find the shape of the check even with no files in it.
     */
    const remove = async (): Promise<void> => {
      const paths = task.stage.map((staged) => staged.containerPath);
      await docker(options.sudo, ['exec', container, 'rm', '-rf', ...paths]);
    };
    /*
     * The already-solved guard's own box: the same image, the tests staged into it, removed once
     * the guard has answered. @see the `staging` parameter of `scoreTask`.
     */
    const guardBox = async () => {
      const sibling = `${container}-guard`;
      await removeQuietly(options.sudo, sibling);
      await docker(options.sudo, [
        'run',
        '-d',
        '--name',
        sibling,
        image,
        'sh',
        '-c',
        `sleep ${Math.max(60, Math.ceil(options.lifetimeSeconds))}`
      ]);
      const dispose = () => removeQuietly(options.sudo, sibling);
      try {
        for (const staged of task.stage)
          await docker(options.sudo, ['cp', staged.source, `${sibling}:${staged.containerPath}`]);
        const backend = dockerBackend({
          container: sibling,
          sudo: options.sudo,
          workspaceRoot: task.workdir,
          isolatesNetwork: false
        });
        await backend.ensure();
        return { backend, dispose };
      } catch (cause) {
        await dispose();
        throw cause;
      }
    };
    const openBox = async (): Promise<WorkspaceBackend> =>
      dockerBackend({
        container,
        sudo: options.sudo,
        workspaceRoot: task.workdir,
        // The container is started on Docker's default bridge, which has egress. Claiming
        // otherwise would put "egress gated" in the artefact on the strength of nothing.
        isolatesNetwork: false
      });
    return await scoreTask(task, false, openBox, { place, remove, guardBox }, live, arm);
  } finally {
    await removeQuietly(options.sudo, container);
  }
};

/** Whether the image a task needs has been built. A missing image is a refusal, not a zero. */
export const imagesPresent = async (
  tasks: readonly TerminalBenchTask[],
  sudo: boolean
): Promise<{ readonly present: string[]; readonly missing: string[] }> => {
  const listed = await docker(sudo, ['images', '--format', '{{.Repository}}']).catch(() => '');
  const have = new Set(listed.split('\n').map((line) => line.trim()));
  const present: string[] = [];
  const missing: string[] = [];
  for (const task of tasks) (have.has(`tb/${task.id}`) ? present : missing).push(task.id);
  return { present, missing };
};

export const TERMINAL_BENCH_STAGE_PATHS = {
  tests: TERMINAL_BENCH_TEST_DIR,
  runTests: TERMINAL_BENCH_RUN_TESTS
} as const;

export const taskDirectoryOf = (root: string, id: string): string => path.join(root, id);
