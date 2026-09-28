/**
 * Terminal-Bench's own task directories, read into the `WireTask` shape `task.ts` already defines.
 *
 * WHY THIS IS A LOADER AND NOT AN ADAPTER. `task.ts` says outright that its task shape is
 * Terminal-Bench's own - a prompt, a starting box, and a command run in the box afterwards whose
 * exit code is the whole verdict - so nothing here translates anything. It reads four files off
 * disk and refuses the directory if any of them is missing. Every judgement this file makes that
 * could be wrong is stated as a field the caller can read (`workdirSource`, `oracle.kind`,
 * `TERMINAL_BENCH_DROPS`) rather than folded into a value that looks measured.
 *
 * WHAT WAS MEASURED, on the live VPS corpus of 241 tasks on 2026-09-03, and what follows from it:
 *
 *   241 task.yaml, all with `instruction`, all `parser_name: pytest`. 236 have a Dockerfile;
 *   238 have `tests/`; all 241 have `run-tests.sh`. So five tasks have no image and three have no
 *   tests, and both are refused below rather than half-run.
 *   233 carry `solution.sh`; the other 8 carry `solution.yaml`, which is a PACED TMUX KEYSTROKE
 *   SCRIPT (`command`, `min_timeout_sec`, `block: true|false`, `append_enter`) and not a shell
 *   script. Their oracle is refused by name. The TASK still loads - its prompt and its tests are
 *   whole - because `solution.sh` is not something a solver needs. @see `TerminalBenchOracle`.
 *   Run whole on 2026-09-03 this loads 233 of the 241, refuses 8 by name, and of the 233 it hands
 *   back 226 runnable oracles and 7 refused ones (the eighth solution.yaml task, `extract-safely`,
 *   is one of the five with no Dockerfile and never gets that far). It reads a working directory
 *   out of 148 Dockerfiles and assumes `/app` for the other 85.
 *   142 Dockerfiles state `WORKDIR /app` and every one that states no WORKDIR at all is built on a
 *   laude-institute base image; `docker inspect -f '{{.Config.WorkingDir}}'` on both of those
 *   (ubuntu-24-04:20250624, python-3-13:20250620) answers `/app`. That is where the `/app` fallback
 *   comes from, and it is recorded as an assumption in `workdirSource` rather than presented as
 *   read.
 *   The verdict is `run-tests.sh`'s exit code and nothing else. PROVED on `csv-to-parquet` on
 *   2026-09-02: the script exits non-zero before the oracle runs and 0 after it. Its last command
 *   is `uv run pytest`, so pytest's own all-or-nothing exit code is the script's, and this rig
 *   never parses a test report - which is why `parser_name` is carried below and never acted on.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It does not build an image, start a container, copy the
 * tests in, or bound the run. `backend.ts` is explicit that the benchmark's own task definition
 * owns the container's life and `dockerBackend` only attaches to it by name, so a loader that
 * shelled out to `docker` would be a second owner of that life. What it does instead is state the
 * paths the caller has to satisfy - `stage`, `oracle.containerPath`, `verify.call.cwd` - so the
 * staging is a caller's step that can be got visibly wrong rather than an assumption buried here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ModelScript } from '../harness.js';

import type { WireTask } from './task.js';

/**
 * Where `run-tests.sh` and the tests have to be in the box, and where the task's own work happens.
 *
 * These are Terminal-Bench's own paths, not this rig's choices: `docker-compose.yaml` passes
 * `TEST_DIR=${T_BENCH_TEST_DIR}` into the container and 227 of the 241 run-tests.sh scripts run
 * `uv run pytest $TEST_DIR/test_outputs.py`. `/tests` and `/run-tests.sh` are the values the
 * 2026-09-02 `csv-to-parquet` proof used, so they are the values a caller has to stage to.
 */
export const TERMINAL_BENCH_TEST_DIR = '/tests';
export const TERMINAL_BENCH_RUN_TESTS = '/run-tests.sh';
export const TERMINAL_BENCH_SOLUTION = '/solution.sh';
/** The laude-institute base images' own `Config.WorkingDir`, measured. @see this file's header. */
export const TERMINAL_BENCH_BASE_WORKDIR = '/app';

/**
 * Bounds Terminal-Bench does not state, so they are this rig's and are named as this rig's.
 *
 * The benchmark bounds a task in SECONDS (`max_agent_timeout_sec`) and never in steps, so no honest
 * step ceiling can be derived from a task.yaml: steps are not seconds and a conversion between them
 * would be a fabricated number sitting in the `task_max_steps` column of a parity row. These two
 * are round, generous, and overridable, and a run that hits one is a bounded run whose bound is
 * printed - which is the whole of what this rig can say about them.
 */
export const TERMINAL_BENCH_MAX_STEPS = 50;
export const TERMINAL_BENCH_MAX_CREDITS = 500;

/**
 * What running this task set through this rig does NOT reproduce about Terminal-Bench, in the shape
 * `score.ts`'s `LOCAL_DROPS` is written in, so a caller can put it in the row's `declaredDrops`.
 *
 * The first is the sharp one. Terminal-Bench copies `tests/` into the container only AFTER the
 * agent has stopped, so the agent cannot read the tests it will be judged by. `score.ts` runs its
 * verifier BEFORE the turn as well - the guard that catches a task which starts already solved -
 * and that guard needs `run-tests.sh` and `tests/` present before the turn starts. Both cannot hold
 * at once with what is written today. Either the caller stages, verifies, removes and re-stages
 * around the turn, or it accepts that the tests are readable and declares this drop. Nothing in
 * this file can choose between those, so it names both.
 */
export const TERMINAL_BENCH_DROPS: readonly string[] = [
  'the tests are staged before the turn (score.ts verifies before it runs), where Terminal-Bench stages them after the agent stops',
  'run-tests.sh installs uv over the network, so the container it runs in cannot be started without one',
  'the agent and the verifier share one container, so a task solved by breaking the box is not detected',
  'no per-task time bound is enforced: max_agent_timeout_sec is exposed and the caller has to apply it',
  "score.ts's runVerifier hardcodes timeoutSeconds: 120, which is below the max_test_timeout_sec 232 of the 241 tasks declare"
];

/** A file or directory the caller has to copy into the box before the verifier can run. */
export interface TerminalBenchStaged {
  /** Absolute path on this machine. */
  readonly source: string;
  /** Absolute path in the box. */
  readonly containerPath: string;
  readonly kind: 'file' | 'directory';
}

/**
 * The benchmark's own solution, which is a measuring instrument and never a score.
 *
 * The only honest use of it is the one `score.ts`'s before/after guard already demands: run the
 * verifier, watch it fail, run the oracle, watch it pass. That proves the verifier is real. It says
 * nothing whatever about an agent, and `terminalBenchOracleModel` below is named so that a row
 * produced by it cannot be mistaken for one.
 *
 * `refused` is the 8 tasks carrying `solution.yaml`. That file is a list of terminal commands with
 * `min_timeout_sec` pacing and `block: false` entries typed without waiting for the previous one -
 * a tmux session, not a shell script. Flattening it into `sh -c` would run a DIFFERENT solution
 * from the benchmark's and would then report whatever that did as the oracle's verdict, which is
 * the exact shape of lie this directory exists to catch. So it is refused by name and the task
 * loads without an oracle.
 */
export type TerminalBenchOracle =
  | { readonly kind: 'script'; readonly source: string; readonly containerPath: string }
  | { readonly kind: 'refused'; readonly source: string; readonly why: string }
  | { readonly kind: 'absent' };

export interface TerminalBenchTask extends WireTask {
  /** Absolute path of the task directory this was read from. */
  readonly directory: string;
  readonly dockerfile: string;
  /** `docker-compose.yaml` where the task ships one, for a caller that starts the box with it. */
  readonly compose: string | null;
  /**
   * The directory in the box the verifier runs in, and whether it was READ or ASSUMED.
   *
   * It is not decoration. `run-tests.sh` opens with `if [ "$PWD" = "/" ]` and exits 1 with "No
   * working directory set", and `dockerExecArgv` always passes `--workdir` - so a caller that let
   * this default to the box root would get a clean exit 1 from every task and read it as 241 failed
   * tasks rather than as one wrong path.
   */
  readonly workdir: string;
  readonly workdirSource: 'dockerfile' | 'base-image-default' | 'caller';
  /** Copied into the box before the verifier runs. @see `TERMINAL_BENCH_DROPS` on when. */
  readonly stage: readonly TerminalBenchStaged[];
  readonly oracle: TerminalBenchOracle;
  /** The benchmark's own ceiling on the agent, in seconds. Exposed; not enforced here. */
  readonly maxAgentTimeoutSeconds: number | null;
  /**
   * The benchmark's own ceiling on the test run, in seconds.
   *
   * Read this before running one of these against `score.ts`: `runVerifier` there hardcodes
   * `timeoutSeconds: 120`, and 232 of the 241 tasks declare a larger `max_test_timeout_sec` - the
   * corpus runs from 60 seconds to 28,800. A verifier killed at 120 seconds reports `timedOut` with
   * a null exit code and scores the task 0, which is indistinguishable in the row from an agent
   * that failed it. Whatever wires this loader in has to carry this number through to that call.
   */
  readonly maxTestTimeoutSeconds: number | null;
  readonly difficulty: string | null;
  readonly category: string | null;
  /**
   * Carried for the record and never acted on: this rig's verdict is `run-tests.sh`'s exit code,
   * so it never parses a test report and a task with a different parser would still be scored
   * correctly. Recorded so that a reader can check that claim rather than take it.
   */
  readonly parserName: string | null;
}

export interface TerminalBenchOptions {
  /**
   * The model that drives the turn. There is no default that could be right: a scripted solution to
   * somebody else's benchmark task is not a solution, it is the answer key. @see `defaultModel`.
   */
  readonly model?: ModelScript;
  readonly maxSteps?: number;
  readonly maxCredits?: number;
  /** Overrides the Dockerfile scan, for a task whose working directory is set somewhere this
   * loader cannot see - a base image of the task's own, or an entrypoint that cds. */
  readonly workdir?: string;
}

/* --------------------------------------------------------------------------------------------- *
 * task.yaml
 *
 * WHY THERE IS A READER HERE AND NOT A DEPENDENCY. This monorepo has NO YAML parser: `js-yaml`,
 * `yaml` and every spelling of them are absent from all fourteen package.json files (grepped
 * 2026-09-03). Adding the repository's first one to read six scalar keys out of one file would put
 * a new package through `pnpm license:check` and into every install, for a job whose whole surface
 * is written below in under a hundred lines. So: a reader for the exact subset the corpus uses,
 * which is top-level keys only, one literal block scalar, plain and quoted scalars, and one
 * sequence (`tags`) that nothing reads.
 *
 * IT IS NOT A YAML PARSER and must not grow into one. It is checked against PyYAML 6.0.3 over all
 * 241 task.yaml in the corpus - same `instruction`, byte for byte - and anything outside the subset
 * it was written for is REFUSED rather than approximated. The one case that actually occurs is the
 * folded scalar `>`: zero tasks use it, and a task that did would have every line break in its
 * prompt turned into a space by a reader that guessed. @see `readTaskYaml`.
 * --------------------------------------------------------------------------------------------- */

/** `key:`, `key: value`, `key: |-` - at column zero, which is the only depth this reads. */
const KEY = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t](.*))?$/;
/** `|`, `|-`, `|+`, `|2`, `|2-`, and the `>` forms this refuses. */
const BLOCK = /^([|>])([1-9]?)([-+]?)$/;

const blank = (line: string): boolean => line.trim() === '';
const indented = (line: string): boolean => /^[ \t]/.test(line);

/** A quoted scalar, unwrapped. Anything else is its own text and is returned as it stands. */
const unquote = (value: string): string => {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  return value;
};

/**
 * A multi-line PLAIN scalar, folded the way YAML folds one: a single line break becomes a space and
 * k consecutive breaks become k-1 newlines.
 *
 * One task in the corpus needs this (`mlflow-register`, whose instruction is two paragraphs written
 * with no block indicator) and getting it wrong would join its paragraphs with a space. The
 * benchmark's wording is the benchmark, so it is folded properly or not at all.
 */
const fold = (raw: readonly string[]): string => {
  const lines = raw.map((line) => line.trim());
  let out = '';
  let started = false;
  let breaks = 0;
  for (const line of lines) {
    if (line === '') {
      if (started) breaks += 1;
      continue;
    }
    if (!started) {
      out = line;
      started = true;
      continue;
    }
    out += breaks > 0 ? '\n'.repeat(breaks) : ' ';
    out += line;
    breaks = 0;
  }
  return unquote(out);
};

/**
 * The top-level scalar keys of one task.yaml, by name.
 *
 * `where` is the file's path and travels into every refusal, because a reader that says "bad block
 * scalar" over a corpus of 241 directories has told you nothing.
 */
export const readTaskYaml = (text: string, where: string): ReadonlyMap<string, string> => {
  const lines = text.split('\n');
  const found = new Map<string, string>();
  let index = 0;
  /** Every following line that belongs to the value just started: blank, or indented. */
  const body = (): readonly string[] => {
    const start = index;
    while (index < lines.length && (blank(lines[index] ?? '') || indented(lines[index] ?? '')))
      index += 1;
    return lines.slice(start, index);
  };
  while (index < lines.length) {
    const line = lines[index] ?? '';
    index += 1;
    // A comment, a blank, or a line belonging to a construct this reader stepped over (the `tags`
    // sequence is the only one in the corpus).
    if (blank(line) || line.startsWith('#') || indented(line)) continue;
    const key = KEY.exec(line);
    const name = key?.[1];
    if (name === undefined) continue;
    const head = (key?.[2] ?? '').trim();

    const block = BLOCK.exec(head);
    if (block) {
      if (block[1] === '>')
        throw new Error(
          `${where}: key "${name}" is a folded block scalar (">"), which this reader refuses rather than folds. None of the 241 tasks measured on 2026-09-03 used one; a task that does needs a reader written for it, because guessing here rewrites the prompt.`
        );
      const raw = body();
      const explicit = block[2] === undefined || block[2] === '' ? 0 : Number(block[2]);
      const first = raw.find((entry) => !blank(entry));
      // The indentation indicator where the task gave one - `pcap-to-netflow` does, because its
      // block opens with an empty line and there is nothing to detect from - and otherwise the
      // indentation of the first non-empty line, which is what YAML detects.
      const indent =
        explicit > 0
          ? explicit
          : first === undefined
            ? 0
            : (/^[ \t]*/.exec(first)?.[0].length ?? 0);
      // Sliced by LENGTH and never by `blank`, and that distinction is worth the sentence: a line
      // of four spaces inside a block indented by two is not an empty line, it is two spaces of
      // content, and treating it as empty silently shortens the prompt. Thirteen of the 241 tasks
      // carry such a line, and this reader disagreed with PyYAML on every one of them until the
      // check over the whole corpus said so.
      const content = raw.map((entry) => (entry.length <= indent ? '' : entry.slice(indent)));
      let value = content.length === 0 ? '' : `${content.join('\n')}\n`;
      // Chomping. `-` strips every trailing newline (212 tasks), `+` keeps them all (1), and the
      // default clips to exactly one (25). A block that is nothing but blank lines is empty.
      if (block[3] === '-') value = value.replace(/\n+$/, '');
      else if (block[3] !== '+') value = value.replace(/\n+$/, '\n');
      if (block[3] !== '+' && value.replaceAll('\n', '') === '') value = '';
      found.set(name, value);
      continue;
    }

    if (head !== '') {
      // A plain or quoted scalar that starts on this line. It may continue onto the following
      // indented lines, and YAML folds those into it.
      found.set(name, fold([head, ...body()]));
      continue;
    }

    const rest = body();
    const first = rest.find((entry) => !blank(entry));
    if (first === undefined) {
      // `expert_time_estimate_min:` with nothing after it - a null, which reads here as absent.
      found.set(name, '');
      continue;
    }
    // A sequence. `tags` is the only one in the corpus and nothing here reads it, so it is stepped
    // over rather than modelled: a list this file cannot represent must not arrive as a string.
    if (first.trim().startsWith('- ')) continue;
    found.set(name, fold(rest));
  }
  return found;
};

/** A `max_*_sec` value as a number. A key that is absent, empty or unparseable reads as null. */
const seconds = (fields: ReadonlyMap<string, string>, key: string): number | null => {
  const raw = fields.get(key);
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
};

const text = (fields: ReadonlyMap<string, string>, key: string): string | null => {
  const raw = fields.get(key);
  return raw === undefined || raw.trim() === '' ? null : raw.trim();
};

/**
 * The working directory the FINAL image ends in, read from the Dockerfile.
 *
 * Only the WORKDIRs after the last `FROM`. Two tasks in the corpus are multi-stage
 * (`FROM ... AS target`), and taking the file's last WORKDIR would hand back a build stage's
 * directory that does not exist in the image that actually runs. A relative or variable WORKDIR
 * reads as absent, because resolving one needs the base image this loader cannot open.
 */
const workdirOf = (dockerfile: string): string | null => {
  const lines = readFileSync(dockerfile, 'utf8').split('\n');
  let found: string | null = null;
  for (const line of lines) {
    if (/^\s*FROM\s/i.test(line)) found = null;
    const workdir = /^\s*WORKDIR\s+(\S.*?)\s*$/i.exec(line);
    const value = workdir?.[1];
    if (value !== undefined && value.startsWith('/')) found = value;
  }
  return found;
};

/**
 * The verifier command: the task's own `run-tests.sh`, run in the box.
 *
 * NOT a reimplementation of pytest, and not a rewrite of the script. Two environment variables are
 * set inside the command string rather than passed as environment, and that is forced rather than
 * chosen: `runVerifier` in `score.ts` sends `env: { PATH, LC_ALL }` and nothing else, so `TEST_DIR`
 * - which every one of these scripts reads - has no other way in. `HOME` is defaulted for the same
 * reason: the scripts `source $HOME/.local/bin/env` to put `uv` on the path, and with `HOME` unset
 * that reads `/.local/bin/env` and every task fails at the same line for a reason that has nothing
 * to do with the task. `/root` is what `docker exec` supplies for these images and what the
 * 2026-09-02 `csv-to-parquet` proof ran under; `:=` leaves a container that sets its own alone.
 */
const verifierArgs = (): readonly string[] => [
  '-c',
  [
    `TEST_DIR=${TERMINAL_BENCH_TEST_DIR}`,
    'export TEST_DIR',
    ': "${HOME:=/root}"',
    'export HOME',
    `exec bash ${TERMINAL_BENCH_RUN_TESTS}`
  ].join('; ')
];

/**
 * The model a task carries when the caller supplies none: one that refuses to run.
 *
 * A placeholder that answered with prose would let a whole scored run complete, score 0 on every
 * task, and read exactly like an agent that found 241 tasks hard. This throws on the first call
 * instead, so the missing provider is the error and not the result. `harness.ts:291` -
 * "a model, as a function of what garden just said to it" - is the seam a real provider goes
 * through, and `TerminalBenchOptions.model` is where it goes in.
 */
const defaultModel =
  (id: string): ModelScript =>
  () => {
    throw new Error(
      `terminal-bench task "${id}" has no model: it is an external benchmark task and this rig will not script an answer to one. Pass a model through TerminalBenchOptions.model - a provider through the harness.ts ModelScript seam to measure an agent, or terminalBenchOracleModel(task) to measure the verifier.`
    );
  };

const isFile = (target: string): boolean => existsSync(target) && statSync(target).isFile();
const isDirectory = (target: string): boolean =>
  existsSync(target) && statSync(target).isDirectory();

/**
 * One Terminal-Bench task directory, or a refusal naming everything that was missing.
 *
 * Synchronous, and the choice is deliberate. Every caller of this builds its task list before a run
 * starts - `TASKS` in `task.ts` is a plain array and `score.ts` iterates it - so an async loader
 * would thread a promise through all of them to save nothing: four `readFileSync` calls on files of
 * a few kilobytes, once per task, against a task that then runs for minutes in a container. The
 * refusal is also worth more as a throw at the call site than as a rejected promise a caller might
 * forget to await, because a suite that quietly loaded 233 of 241 tasks is a changed denominator.
 *
 * The return type is a `TerminalBenchTask`, which IS a `WireTask` - every field the rig reads is
 * there and unchanged - with the benchmark's own facts added beside them. A caller that only wants
 * the `WireTask` gets one; a caller that needs the image, the working directory or the oracle does
 * not have to open task.yaml a second time to find them.
 */
export const loadTerminalBenchTask = (
  dir: string,
  options: TerminalBenchOptions = {}
): TerminalBenchTask => {
  const directory = path.resolve(dir);
  const id = path.basename(directory);
  if (!isDirectory(directory))
    throw new Error(`terminal-bench task "${id}" is refused: ${directory} is not a directory.`);

  const yamlPath = path.join(directory, 'task.yaml');
  const dockerfile = path.join(directory, 'Dockerfile');
  const testsDir = path.join(directory, 'tests');
  const runTests = path.join(directory, 'run-tests.sh');

  // Every missing part, not the first one: a caller fixing a directory should be told what is wrong
  // with it once rather than four times.
  const missing: string[] = [];
  if (!isFile(yamlPath)) missing.push('task.yaml');
  if (!isFile(dockerfile)) missing.push('Dockerfile (no image, so there is no box to run it in)');
  if (!isDirectory(testsDir)) missing.push('tests/');
  else if (readdirSync(testsDir).length === 0) missing.push('tests/ (present but empty)');
  if (!isFile(runTests)) missing.push('run-tests.sh (the verifier)');

  const fields = isFile(yamlPath)
    ? readTaskYaml(readFileSync(yamlPath, 'utf8'), yamlPath)
    : new Map<string, string>();
  const instruction = fields.get('instruction') ?? '';
  // Checked against the untrimmed text but reported as an empty key: `instruction: |-` followed by
  // nothing is a task with no prompt, and a prompt of whitespace is not a prompt.
  if (isFile(yamlPath) && instruction.trim() === '')
    missing.push('a non-empty task.yaml "instruction" (the prompt)');

  if (missing.length > 0)
    throw new Error(
      `terminal-bench task "${id}" is refused rather than guessed at - ${directory} is missing: ${missing.join('; ')}.`
    );

  // Three sources, told apart rather than collapsed, because only one of them is a fact about the
  // task: what the Dockerfile says, what the caller overrode it with, and the base image's `/app`
  // that this loader cannot see and is assuming.
  const stated = workdirOf(dockerfile);
  const workdir = options.workdir ?? stated ?? TERMINAL_BENCH_BASE_WORKDIR;
  const workdirSource: TerminalBenchTask['workdirSource'] =
    options.workdir !== undefined
      ? 'caller'
      : stated === null
        ? 'base-image-default'
        : 'dockerfile';
  const compose = path.join(directory, 'docker-compose.yaml');
  const solutionSh = path.join(directory, 'solution.sh');
  const solutionYaml = path.join(directory, 'solution.yaml');
  const oracle: TerminalBenchOracle = isFile(solutionSh)
    ? { kind: 'script', source: solutionSh, containerPath: TERMINAL_BENCH_SOLUTION }
    : isFile(solutionYaml)
      ? {
          kind: 'refused',
          source: solutionYaml,
          why: `"${id}" ships solution.yaml, which is a paced tmux keystroke script (command / min_timeout_sec / block / append_enter) and not a shell script. Running its commands through sh would run a different solution from the benchmark's and report the result as the oracle's, so this oracle is refused. The task itself is unaffected: its prompt and its tests are whole. 8 of the 241 tasks measured on 2026-09-03 are in this position.`
        }
      : { kind: 'absent' };

  return {
    id,
    // Verbatim, and nothing is prepended, appended or reworded. The benchmark's wording IS the
    // benchmark: a prompt this rig improved would make every number it produced incomparable with
    // every published one.
    request: instruction,
    // Empty, and it has to be. A Terminal-Bench task's starting state is its IMAGE - the Dockerfile
    // copies the data in, installs the broken package, breaks the permissions - so a `seed` here
    // would be this rig adding files the benchmark never puts in the box.
    seed: {},
    model: options.model ?? defaultModel(id),
    verify: {
      label: `${id}: its own tests, run by run-tests.sh with TEST_DIR=${TERMINAL_BENCH_TEST_DIR} in ${workdir}`,
      call: {
        executable: '/bin/sh',
        args: verifierArgs(),
        // ABSOLUTE, and that is the point. `dockerExecArgv` computes the workdir as
        // `posix.resolve(workspaceRoot, '..', cwd)`, so a relative `cwd` here would land somewhere
        // that depends on where the caller put the workspace root - and `.` in particular resolves
        // to the box ROOT, which is the one value `run-tests.sh` explicitly exits 1 on. An absolute
        // path resolves to itself whatever the caller chose.
        cwd: workdir
      }
    },
    // Somebody else's shell scripts, which is exactly what `WireTask.origin` is for: `score.ts`
    // refuses to run this on the local backend without `--trust-local`, because the local backend
    // is not a sandbox and these scripts run `apt-get install` and `curl | sh`.
    origin: 'external',
    maxSteps: options.maxSteps ?? TERMINAL_BENCH_MAX_STEPS,
    maxCredits: options.maxCredits ?? TERMINAL_BENCH_MAX_CREDITS,
    directory,
    dockerfile,
    compose: isFile(compose) ? compose : null,
    workdir,
    workdirSource,
    // The oracle is NOT in this list. Staging `solution.sh` beside the tests would put the answer in
    // the box the agent can reach, and a task solved by reading the answer scores the same as one
    // that was solved. A caller running the oracle proof stages `oracle.containerPath` on purpose.
    stage: [
      { source: testsDir, containerPath: TERMINAL_BENCH_TEST_DIR, kind: 'directory' },
      { source: runTests, containerPath: TERMINAL_BENCH_RUN_TESTS, kind: 'file' }
    ],
    oracle,
    maxAgentTimeoutSeconds: seconds(fields, 'max_agent_timeout_sec'),
    maxTestTimeoutSeconds: seconds(fields, 'max_test_timeout_sec'),
    difficulty: text(fields, 'difficulty'),
    category: text(fields, 'category'),
    parserName: text(fields, 'parser_name')
  };
};

/** Every directory under `root` that looks like a task, by name, in the order a listing gives. */
export const terminalBenchTaskIds = (root: string): readonly string[] => {
  const base = path.resolve(root);
  if (!isDirectory(base)) throw new Error(`terminal-bench corpus root ${base} is not a directory.`);
  return readdirSync(base)
    .filter((entry) => isDirectory(path.join(base, entry)))
    .sort();
};

export interface TerminalBenchRefusal {
  readonly id: string;
  readonly why: string;
}

/**
 * Which tasks under `root` this loader will not load, and why - without throwing.
 *
 * The way a caller finds out what its denominator would be before it commits to one. Run over the
 * measured corpus on 2026-09-03 it names 8 of the 241: `conda-env-conflict-resolution`,
 * `extract-safely`, `simple-sheets-put`, `simple-web-scraper` and `tmux-advanced-workflow` have no
 * Dockerfile, and `swe-bench-astropy-1`, `swe-bench-astropy-2` and `swe-bench-langcodes` have no
 * `tests/`. 233 load.
 */
export const terminalBenchRefusals = (
  root: string,
  ids?: readonly string[]
): readonly TerminalBenchRefusal[] => {
  const base = path.resolve(root);
  const wanted = ids ?? terminalBenchTaskIds(base);
  const refusals: TerminalBenchRefusal[] = [];
  for (const id of wanted) {
    try {
      loadTerminalBenchTask(path.join(base, id));
    } catch (cause) {
      refusals.push({ id, why: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return refusals;
};

/**
 * A suite, and a REFUSAL rather than a quietly smaller one.
 *
 * Called with no `ids` this loads every directory under `root`, and if any of them is unloadable it
 * throws ONE error naming all of them. It does not skip them, and the reason is the only thing in
 * this file worth arguing about: silently returning 228 tasks from a 241-task corpus changes the
 * denominator of every score computed from it, and a denominator nobody declared is how a benchmark
 * number stops meaning anything. A caller that genuinely wants a subset says so - with `ids`, from
 * `terminalBenchRefusals` - and then the subset is a decision in its code rather than an accident
 * in this one.
 *
 * With `ids`, a refusal is still a refusal: the caller named a task and it cannot be run.
 */
export const loadTerminalBenchSuite = (
  root: string,
  ids?: readonly string[],
  options: TerminalBenchOptions = {}
): readonly TerminalBenchTask[] => {
  const base = path.resolve(root);
  const wanted = ids ?? terminalBenchTaskIds(base);
  if (wanted.length === 0)
    throw new Error(`terminal-bench: no task directories under ${base}, so there is no suite.`);
  const loaded: TerminalBenchTask[] = [];
  const refused: string[] = [];
  for (const id of wanted) {
    try {
      loaded.push(loadTerminalBenchTask(path.join(base, id), options));
    } catch (cause) {
      refused.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (refused.length > 0)
    throw new Error(
      `terminal-bench: ${refused.length} of ${wanted.length} task(s) under ${base} cannot be loaded, and a suite that quietly dropped them would change the denominator of every score taken from it. Name the tasks you want with the ids argument (terminalBenchRefusals lists these), or fix them.\n${refused.map((why) => `  - ${why}`).join('\n')}`
    );
  return loaded;
};

/**
 * The benchmark's own solution, as a model that runs it.
 *
 * WHAT IT MEASURES: the environment, and nothing else. It proves the image builds, the tests are
 * where the verifier looks for them, the working directory is right, and the verifier can tell a
 * solved box from an unsolved one - which is exactly `score.ts`'s before/after guard, and exactly
 * the shape of the 2026-09-02 `csv-to-parquet` proof. A row produced by this run says nothing about
 * an agent, in the same way `task.ts`'s scripted model says nothing about one, and harder: the
 * model here is handed the answer.
 *
 * The acceptance hold is answered with the task's OWN verifier command rather than a second check
 * written here. It costs a full `run-tests.sh` inside the turn - minutes, and a network install -
 * which is the honest price of not having a second definition of what solved means.
 */
export const terminalBenchOracleModel = (task: TerminalBenchTask): ModelScript => {
  if (task.oracle.kind !== 'script')
    throw new Error(
      task.oracle.kind === 'refused'
        ? task.oracle.why
        : `terminal-bench task "${task.id}" ships no solution.sh, so there is no oracle to run.`
    );
  const oracle = task.oracle.containerPath;
  const ran = `Ran the benchmark's own solution, ${oracle}, in ${task.workdir}.`;
  return (context) => {
    // As `task.ts` does: a compaction's brief, a specialist's step and a vision handoff are not
    // this turn's steps, and answering them with a tool call gets a brief that says nothing.
    if (context.summarising || context.delegated || context.vision) return { text: ran };
    if (context.lastMessage.includes('Finish held: this turn changed'))
      return {
        calls: [
          {
            id: 'call-acceptance',
            name: 'set_acceptance',
            args: {
              checks: [
                {
                  kind: 'command',
                  label: task.verify.label,
                  executable: task.verify.call.executable,
                  args: [...task.verify.call.args]
                }
              ]
            }
          }
        ]
      };
    if (context.step === 0)
      return {
        calls: [
          {
            id: 'call-oracle',
            name: 'shell',
            // `cd` in the command rather than trusting the tool's own working directory: the
            // solutions are written against the task's WORKDIR and several of them use relative
            // paths.
            args: {
              executable: '/bin/sh',
              args: ['-c', `cd ${task.workdir} && exec bash ${oracle}`]
            }
          }
        ]
      };
    return {
      text: ran,
      calls: [
        {
          id: 'call-finish',
          name: 'finish',
          args: {
            summary: ran,
            verification: {
              status: 'verified',
              evidence: [
                {
                  claim: "The benchmark's own solution script ran to completion in the box",
                  source: 'tool_result',
                  toolCallId: 'call-oracle'
                }
              ],
              remainingRisks: [
                'This turn was handed the answer. It measures the environment and the verifier, never an agent.'
              ]
            }
          }
        }
      ]
    };
  };
};
