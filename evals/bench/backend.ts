/**
 * The box a benchmark task runs in, behind one interface with two implementations.
 *
 * The interface is deliberately almost nothing: ensure the box, run a command in it, throw it
 * away. Every file operation the runner protocol offers is built ON TOP of `exec` in `files.ts`,
 * and that is the load-bearing decision in this rig. It means the file path proved by the local
 * backend on this laptop is the same code the container backend runs, with only the exec
 * transport different - so a shim that passes its tests here is not a shim that has only ever
 * been tested here. The alternative, a filesystem implementation per backend, would have given
 * the tested one and the shipped one nothing in common but a type.
 *
 * WHAT THIS COSTS, said plainly: a file read is a `base64` shell-out rather than a `read(2)`, so
 * the local backend is slower than `node:fs` by roughly a process spawn per call. That is
 * irrelevant against a benchmark task's own runtime and it buys the property above.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * One command, in the runner's own request shape.
 *
 * @see services/workspace-runner/src/execution.ts:45-90, which is the whole schema. All eight
 * fields are here and none is quietly dropped: `network` and `maxOutputBytes` in particular are
 * fields the research's first draft omitted, and a shim that ignores `network` gives the agent
 * unconditional egress on a box where garden would have gated it - which is a difference in what
 * was measured, not a detail.
 */
export interface ExecCall {
  readonly executable: string;
  readonly args: readonly string[];
  /** Relative to the box's workspace root, exactly as the runner treats it. Defaults `workspace`. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
  readonly stdin?: string | undefined;
  /** Whether this call is allowed off the box. See `WorkspaceBackend.isolatesNetwork`. */
  readonly network: boolean;
  readonly maxOutputBytes: number;
}

/** @see services/workspace-runner/src/execution.ts:954-960 for the shape the client parses. */
export interface ExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface WorkspaceBackend {
  /** `local` or `docker`. Travels into the parity row, because it is part of what was measured. */
  readonly name: string;
  /**
   * Whether a call with `network: false` is actually cut off from the network.
   *
   * FALSE ON THE LOCAL BACKEND AND IT CANNOT BE OTHERWISE: a child process on this laptop shares
   * the host's network namespace and nothing in this rig can take that away. It is not papered
   * over. `shim.ts` records it and `parity.ts` prints it as a declared drop, so a row measured on
   * the local backend cannot be read as a row measured under garden's egress gate.
   */
  readonly isolatesNetwork: boolean;
  /** Absolute path, inside the box, of the workspace root a relative `cwd` resolves against. */
  readonly workspaceRoot: string;
  ensure(): Promise<void>;
  exec(call: ExecCall): Promise<ExecResult>;
  dispose(): Promise<void>;
}

/**
 * Head, tail, and a count of what went between - the runner's own answer to a command that talks
 * too much, reproduced rather than approximated.
 *
 * A plain tail would drop the beginning, which is where a build says what it is about to do. This
 * is a simplification of `boundedCollector` at `services/workspace-runner/src/execution.ts:99`:
 * the same 62/38 split and the same marker sentence, over a whole buffer rather than streaming.
 * It differs in one way worth naming - the real one counts bytes as they arrive and so bounds
 * memory, this one holds the whole output first. A benchmark command that produces gigabytes on
 * stdout would be held in this process's heap. What would change it: a task that does that.
 */
export const bounded = (whole: Buffer, limit: number, stream: string): string => {
  if (whole.length <= limit) return whole.toString('utf8');
  const headLimit = Math.floor(limit * 0.62);
  const head = whole.subarray(0, headLimit);
  const tail = whole.subarray(whole.length - (limit - headLimit));
  const omitted = whole.length - head.length - tail.length;
  return `${head.toString('utf8')}\n[… ${omitted} bytes omitted from ${stream}; beginning and end preserved …]\n${tail.toString('utf8')}`;
};

/** Spawn, wait, bound the output, and report a timeout as a timeout rather than as a signal. */
const runProcess = async (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutSeconds: number;
    readonly stdin?: string | undefined;
    readonly maxOutputBytes: number;
  }
): Promise<ExecResult> => {
  const started = Date.now();
  return await new Promise<ExecResult>((resolve) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      // Never a shell. The runner does not give the agent one either: `executable` and `args` are
      // separate fields the whole way down, and collapsing them into a string here would make
      // every quoting bug in this rig look like a model that cannot write a command line.
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill('SIGKILL');
      },
      Math.max(1, options.timeoutSeconds) * 1_000
    );
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    const finish = (exitCode: number | null, extraStderr = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: bounded(Buffer.concat(out), options.maxOutputBytes, 'stdout'),
        stderr: bounded(
          Buffer.concat([...err, Buffer.from(extraStderr, 'utf8')]),
          options.maxOutputBytes,
          'stderr'
        ),
        durationMs: Date.now() - started,
        timedOut
      });
    };
    // A command that could not be started at all is an exit code the caller can read, not a
    // rejected promise: the runner answers `exitCode: null` for the same case, and a shim that
    // threw here would surface a missing binary as a shim crash.
    child.on('error', (cause: Error) => finish(null, `\n${cause.message}`));
    child.on('close', (code) => finish(code));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
};

/**
 * A box that is a temporary directory on this machine.
 *
 * THE POINT OF IT: a shim that can only be run where Docker is installed is a shim nobody runs.
 * This backend needs no daemon, no image and no privilege, so the whole protocol - every route,
 * every file operation, the hard failure - is exercisable on a laptop and in CI.
 *
 * WHAT IT IS NOT. It is not a sandbox and it does not pretend to be one. Commands run as this
 * user, with this user's network and this user's filesystem, bounded only by `cwd`. It must never
 * be used to run a benchmark task written by someone else, so `score.ts` refuses a task whose
 * `origin` is not `builtin` on this backend unless the caller passes `--trust-local`, because the
 * difference between "run my own test" and "run a downloaded task" is the difference between a rig
 * and a foothold.
 *
 * That sentence named `shim.ts` and a flag that existed NOWHERE IN THIS REPOSITORY until the
 * `--score` driver was written: the guard was described and never built, which is the shape this
 * whole directory exists to catch, wearing a comment's clothes. `selftest.ts` now drives an
 * external-origin task at the local backend and asserts the refusal, so the sentence has a check
 * under it rather than a reader's good faith.
 */
export const localBackend = async (root?: string): Promise<WorkspaceBackend> => {
  const base = root ?? (await mkdtemp(path.join(tmpdir(), 'garden-bench-')));
  const workspaceRoot = path.join(base, 'workspace');
  const owned = root === undefined;
  return {
    name: 'local',
    isolatesNetwork: false,
    workspaceRoot,
    async ensure() {
      await runProcess('/bin/mkdir', ['-p', workspaceRoot], {
        env: {},
        timeoutSeconds: 30,
        maxOutputBytes: 4_096
      });
    },
    async exec(call) {
      return await runProcess(call.executable, call.args, {
        cwd: path.resolve(workspaceRoot, '..', call.cwd),
        env: call.env,
        timeoutSeconds: call.timeoutSeconds,
        stdin: call.stdin,
        maxOutputBytes: call.maxOutputBytes
      });
    },
    async dispose() {
      // Only a directory this backend made. A caller that named its own root keeps it, because
      // deleting a path somebody handed in is how a test rig eats a working tree.
      if (owned) await rm(base, { recursive: true, force: true });
    }
  };
};

/**
 * The argv for one `docker exec`, as a pure function so it can be proved with no Docker present.
 *
 * Everything about the container backend that can be wrong without a daemon is wrong HERE: the
 * flag order, the working directory, the environment, the interactive flag stdin needs, and which
 * of the two ways to reach the daemon is used. `selftest.ts` asserts this argv rather than
 * asserting that a container ran, which is the only assertion this machine can make about it.
 */
export const dockerExecArgv = (options: {
  readonly container: string;
  readonly sudo: boolean;
  readonly workspaceRoot: string;
  readonly call: ExecCall;
}): { readonly executable: string; readonly args: string[] } => {
  const inner = [
    'exec',
    // stdin is attached only when there is stdin to send. `-i` on every call leaves the child
    // holding an open pipe and a command that reads stdin waits for a close that never comes.
    ...(options.call.stdin === undefined ? [] : ['-i']),
    '--workdir',
    path.posix.resolve(options.workspaceRoot, '..', options.call.cwd),
    ...Object.entries(options.call.env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    options.container,
    options.call.executable,
    ...options.call.args
  ];
  // `sudo -n`, never a prompt. The VPS measurement of 2026-09-02 found `administrator` holds
  // `(ALL) NOPASSWD: ALL` while the `docker` group is empty, so `sudo docker` is the reachable
  // door there and an interactive prompt would hang a benchmark run for hours before anyone
  // noticed. A box where the invoking user is in the `docker` group runs this with `sudo: false`.
  return options.sudo
    ? { executable: 'sudo', args: ['-n', 'docker', ...inner] }
    : { executable: 'docker', args: inner };
};

/**
 * A box that is a container.
 *
 * NOT EXERCISED ANYWHERE IN THIS REPOSITORY'S TESTS, and that is stated rather than hidden: there
 * is no container runtime on the machine this was written on. What IS proved here is
 * `dockerExecArgv` above, which is every decision this backend makes that does not require a
 * daemon. The first run against a real container is a step the owner takes, and `README.md` gives
 * the command.
 *
 * The container is not created here and is not destroyed here. It is created by the benchmark's
 * own task definition, which is the only thing that knows the image, the network mode and the
 * verifier's expectations; this backend attaches to it by name. That also means
 * `isolatesNetwork` is a claim about how the caller started the container and cannot be checked
 * from inside, so it is taken as a parameter rather than assumed - a shim that assumed `none`
 * would put "egress gated" in the artefact on the strength of nothing.
 */
export const dockerBackend = (options: {
  readonly container: string;
  readonly sudo: boolean;
  readonly workspaceRoot?: string;
  readonly isolatesNetwork: boolean;
}): WorkspaceBackend => {
  const workspaceRoot = options.workspaceRoot ?? '/workspace';
  return {
    name: 'docker',
    isolatesNetwork: options.isolatesNetwork,
    workspaceRoot,
    async ensure() {
      const argv = dockerExecArgv({
        container: options.container,
        sudo: options.sudo,
        workspaceRoot,
        call: {
          /*
           * The runner's protocol names everything from one directory above `workspace/`: a call's
           * default cwd is `workspace` and every file path starts with it. A task whose root has
           * another name - Terminal-Bench's `/app` - would resolve both to a `/workspace` that does
           * not exist, and the agent's first command on every task failed to start until the model
           * worked around it. So `workspace` beside the root is made to name the root.
           */
          executable: 'sh',
          args: [
            '-c',
            'mkdir -p "$1" && { [ "$(basename "$1")" = workspace ] || [ -e workspace ] || ln -s "$1" workspace; }',
            'sh',
            workspaceRoot
          ],
          cwd: '.',
          env: {},
          timeoutSeconds: 30,
          network: false,
          maxOutputBytes: 4_096
        }
      });
      const result = await runProcess(argv.executable, argv.args, {
        env: process.env as Record<string, string>,
        timeoutSeconds: 30,
        maxOutputBytes: 4_096
      });
      // A container that is not there must not be discovered halfway through a scored run. This
      // is the one place the backend refuses loudly rather than answering.
      if (result.exitCode !== 0)
        throw new Error(
          `container ${options.container} did not answer: exit ${String(result.exitCode)} ${result.stderr.trim()}`
        );
    },
    async exec(call) {
      // A call that asks for the network on a container started without one is refused with a
      // result the model can read, not granted. The reverse - a container with a network serving
      // a `network: false` call - cannot be fixed from here at all, which is why the caller has to
      // declare `isolatesNetwork` and why the artefact prints it.
      if (call.network && options.isolatesNetwork)
        return {
          exitCode: null,
          stdout: '',
          stderr:
            'This command asked for the network and this computer was started without one, so it was not run.',
          durationMs: 0,
          timedOut: false
        };
      const argv = dockerExecArgv({
        container: options.container,
        sudo: options.sudo,
        workspaceRoot,
        call
      });
      return await runProcess(argv.executable, argv.args, {
        env: process.env as Record<string, string>,
        timeoutSeconds: call.timeoutSeconds,
        stdin: call.stdin,
        maxOutputBytes: call.maxOutputBytes
      });
    },
    async dispose() {
      // Nothing. The benchmark owns the container's life; stopping it here would destroy the
      // environment the verifier is about to inspect.
    }
  };
};
