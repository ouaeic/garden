/**
 * The checks the artefacts cannot make about themselves, run on every invocation rather than
 * behind a flag.
 *
 * This programme has found seven saturated assertions, so every check below is written to be
 * breakable: it drives a real shim over a real temporary directory and asserts an outcome that a
 * plausible-looking wrong implementation would not produce. Two of them assert a REFUSAL, which is
 * the only kind of check that can prove a gate exists - a gate is invisible while nothing hits it.
 *
 * Every loop over a collection asserts the collection is non-empty first. This repository has
 * shipped a proof that ran zero times and reported a guarantee it was not making.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dockerExecArgv, localBackend } from './backend.js';
import {
  BYTES_PER_TOKEN,
  benchmarkBoxCatalogueBytes,
  catalogueWeights,
  surfaceGatedToolNames
} from './catalogue.js';
import { readFile } from './files.js';
import {
  aggregate,
  ARM_SECURITY_MODE,
  COLUMNS,
  rowFrom,
  scoreOf,
  type Arm,
  type RowInput,
  type RunRecord,
  type TaskResult
} from './parity.js';
import { SWEEP_SURFACES } from './observe.js';
import {
  ABSENT_ROUTES,
  canonicalRoute,
  coverageOf,
  IMPLEMENTED_ROUTES,
  type RouteObservation
} from './routes.js';
import { scoreTask } from './score.js';
import { createShim } from './shim.js';
import { EXPECTED_TOTAL, SUM_TASK } from './task.js';
import { wiringChecks } from './wiring.js';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';

/**
 * One request per implemented route, chosen so the route can actually do its work.
 *
 * The point is not that each returns 200 - a 404 for a file that is not there is a correct answer.
 * The point is that none of them comes back a MISS, because a route declared in
 * `IMPLEMENTED_ROUTES` with no arm behind it in the switch is recorded as a miss by `shim.ts` and
 * is the same silence to the loop as a route nobody declared. That is this rig's own version of
 * the computed-and-unwired defect and it is the reason this table exists.
 */
const EXERCISE: ReadonlyArray<{
  readonly route: string;
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}> = [
  { route: 'PUT /v1/workspaces/:workspaceId', method: 'PUT', url: `/v1/workspaces/${WORKSPACE}` },
  { route: 'GET /v1/workspaces/:workspaceId', method: 'GET', url: `/v1/workspaces/${WORKSPACE}` },
  {
    route: 'POST /v1/workspaces/:workspaceId/exec',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/exec`,
    body: { executable: '/bin/echo', args: ['hello'] }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/files',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/files?path=workspace`
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/file',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/notes.txt')}`
  },
  {
    route: 'PUT /v1/workspaces/:workspaceId/file',
    method: 'PUT',
    url: `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/notes.txt')}`,
    body: 'one\ntwo\nthree\n'
  },
  {
    route: 'DELETE /v1/workspaces/:workspaceId/file',
    method: 'DELETE',
    url: `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/gone.txt')}`
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/files/folder',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/files/folder`,
    body: { path: 'workspace/src' }
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/files/rename',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/files/rename`,
    body: { from: 'workspace/notes.txt', to: 'workspace/renamed.txt' }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/toolchain',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/toolchain`
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/toolchain/probe',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/toolchain/probe`,
    body: { binaries: ['sh', 'this-binary-does-not-exist'] }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/machine',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/machine`
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/surfaces',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/surfaces`
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/usage',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/usage`
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/processes/start',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/processes/start`,
    body: { executable: '/bin/echo', args: ['background'] }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/processes',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/processes`
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/processes/stop-owner',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/processes/stop-owner`,
    body: {}
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/processes/:id',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/processes/proc_${'a'.repeat(32)}`,
    body: { action: 'poll' }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/preview-check/:port',
    method: 'GET',
    // A port nothing on a fresh box listens on, so the honest answer is `available: false`.
    url: `/v1/workspaces/${WORKSPACE}/preview-check/48211`
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/checkpoints',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/checkpoints`,
    body: { checkpointId: 'cp-1', turn: 1 }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/checkpoints',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/checkpoints`
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/json-proof',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/json-proof`,
    // A file the exercise wrote earlier in this list is not guaranteed to be JSON, so the honest
    // answer for a path that is not there is the runner's own 404.
    body: { path: 'workspace/proof-not-there.json', json: { equals: { '/a': 1 } } }
  },
  {
    route: 'POST /v1/workspaces/:workspaceId/acceptance/inspect',
    method: 'POST',
    url: `/v1/workspaces/${WORKSPACE}/acceptance/inspect`,
    // An assertion that cannot fail, which is the one thing the inspection exists to name.
    body: { executable: 'python3', args: ['-c', 'assert True'] }
  },
  {
    route: 'GET /v1/workspaces/:workspaceId/image',
    method: 'GET',
    url: `/v1/workspaces/${WORKSPACE}/image?path=${encodeURIComponent('workspace/logo.png')}`
  }
];

const bodyOf = (value: unknown): Buffer =>
  value === undefined
    ? Buffer.alloc(0)
    : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

const threw = async (what: () => unknown): Promise<string | null> => {
  try {
    await what();
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
};

/** A task result with every optional number absent, for the checks that are about one field. */
const emptyTask = (taskId: string): TaskResult => ({
  taskId,
  resolved: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  steps: null,
  wallSeconds: null,
  compactions: null,
  approvalCardsFired: null,
  infraFailure: false
});

const baseRow = (): RowInput => ({
  benchmark: 'terminal-bench-2.0',
  taskSet: 'selftest',
  taskSetSha: 'x',
  nTasks: 4,
  model: 'm',
  modelRoute: 'r',
  provider: 'p',
  harness: 'garden',
  harnessVersion: '0.1.1',
  harnessCommit: 'x',
  arm: 'shipped',
  securityMode: 'balanced',
  approvalsAutoAnswered: 0,
  taskMaxSteps: 120,
  selfContinuations: 2,
  maxComputeCredits: null,
  maxSpendUsd: null,
  catalogueBytes: 0,
  catalogueTokensPerCall: 0,
  surfaces: { browser: 'absent', desktop: 'absent' },
  backend: 'local',
  isolatesNetwork: false,
  verifierEnv: 'separate',
  networkMode: 'none',
  declaredDrops: [],
  shimMisses: [],
  absentRequests: 7,
  runs: [{ startedAt: 'now', tasks: [] }] as readonly RunRecord[]
});

export const selfTest = async (observation: RouteObservation | null): Promise<string[]> => {
  const problems: string[] = [];

  /* --------------------------------------------------- the canonicaliser, in both directions */
  if (
    canonicalRoute('GET', `/v1/workspaces/${WORKSPACE}/file?path=a%2Fb`) !==
    'GET /v1/workspaces/:workspaceId/file'
  )
    problems.push('a workspace id or a query string is not being taken out of a route name');
  if (
    canonicalRoute('POST', `/v1/workspaces/${WORKSPACE}/toolchain/probe`) !==
    'POST /v1/workspaces/:workspaceId/toolchain/probe'
  )
    // The other direction, and it matters more: a canonicaliser that collapsed a LITERAL segment
    // would report the shim as implementing routes it does not, which is the whole failure.
    problems.push('a literal path segment is being collapsed into an id');
  if (
    canonicalRoute('POST', `/v1/workspaces/${WORKSPACE}/processes/proc_${'b'.repeat(32)}`) !==
    'POST /v1/workspaces/:workspaceId/processes/:id'
  )
    problems.push('a runner-minted session id is not being recognised as an id');
  if (
    canonicalRoute('POST', `/v1/workspaces/${WORKSPACE}/processes/bg-started`) !==
    'POST /v1/workspaces/:workspaceId/processes/:id'
  )
    // A session id the model made up. The runner's route takes any segment and answers not
    // found; a fold that kept it literal turned that answer into a miss and voided a whole arm.
    problems.push('a session id the model made up is not being read as the id the route takes');
  if (
    canonicalRoute('GET', `/v1/workspaces/${WORKSPACE}/preview-check/8080`) !==
    'GET /v1/workspaces/:workspaceId/preview-check/:port'
  )
    problems.push('a preview port is not being read as the parameter the route takes');
  if (
    canonicalRoute('POST', `/v1/workspaces/${WORKSPACE}/processes/start`) !==
    'POST /v1/workspaces/:workspaceId/processes/start'
  )
    problems.push('the literal `start` under processes is being folded into an id');

  /* ----------------------------------------------------------------- the shim, over a real box */
  if (IMPLEMENTED_ROUTES.length === 0) {
    problems.push('IMPLEMENTED_ROUTES is empty, so nothing below ran');
    return problems;
  }
  if (EXERCISE.length !== IMPLEMENTED_ROUTES.length)
    problems.push(
      `${EXERCISE.length} routes are exercised and ${IMPLEMENTED_ROUTES.length} are declared: a declared route with no exercise is a route nothing has ever driven`
    );

  const backend = await localBackend();
  try {
    await backend.ensure();
    const shim = createShim({ backend });
    for (const step of EXERCISE) {
      const answer = await shim.handle(step.method, step.url, bodyOf(step.body));
      if (answer.status === 501)
        problems.push(`${step.route} answered 501, so it is declared with no handler behind it`);
      if (answer.status >= 500 && answer.status !== 501)
        problems.push(
          `${step.route} failed in the box: ${answer.body.toString('utf8').slice(0, 200)}`
        );
    }
    if (shim.misses.length > 0)
      problems.push(`exercising the declared routes produced misses: ${shim.misses.join(', ')}`);

    /* ------------------------------------------------------- the hard failure, actually driven */
    const seenByMiss: string[] = [];
    const strict = createShim({ backend, onMiss: (route) => seenByMiss.push(route) });
    const refused = await strict.handle(
      'GET',
      `/v1/workspaces/${WORKSPACE}/browser/snapshot`,
      Buffer.alloc(0)
    );
    if (refused.status !== 501)
      problems.push(`an unimplemented route answered ${refused.status} rather than 501`);
    if (strict.misses.length !== 1 || seenByMiss.length !== 1)
      problems.push(
        'an unimplemented route was not recorded as a miss, so nothing would void the run'
      );
    // The 501 is for a human. THIS is the guard: `apps/worker/src/agent.ts` catches three of these
    // into a shrug, so a status code alone would let the run finish and be scored.
    const voided = await threw(() =>
      rowFrom({ ...baseRow(), shimMisses: strict.misses }, (value) => value)
    );
    if (voided === null)
      problems.push('a row was emitted for a run that reached a route the shim does not implement');

    /* ------------------------------------------------------------------- files, round-tripped */
    const written = 'alpha\nbeta\ngamma\n';
    await shim.handle(
      'PUT',
      `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/round.txt')}`,
      Buffer.from(written, 'utf8')
    );
    const back = await readFile(backend, 'workspace/round.txt');
    if (back === null || back.toString('utf8') !== written)
      problems.push('a file written through the shim did not read back byte for byte');
    // The command sees the same file. Without this the file half and the exec half could be two
    // different boxes and every test above would still pass.
    const seesIt = await shim.handle(
      'POST',
      `/v1/workspaces/${WORKSPACE}/exec`,
      bodyOf({ executable: '/bin/cat', args: ['round.txt'] })
    );
    const execResult = JSON.parse(seesIt.body.toString('utf8')) as {
      exitCode: number;
      stdout: string;
    };
    if (execResult.exitCode !== 0 || execResult.stdout !== written)
      problems.push(
        `a command run through the shim cannot see a file written through it: exit ${String(execResult.exitCode)}`
      );
    // The three read shapes are three different answers, which is what `file_patch` and the read
    // ledger both depend on. A shim that answered the whole file to all three would pass every
    // other check in this file.
    const window = await shim.handle(
      'GET',
      `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/round.txt')}&maxBytes=6&startLine=1&endLine=99`,
      Buffer.alloc(0)
    );
    if (window.headers['x-start-line'] !== '1' || window.body.toString('utf8') !== 'alpha')
      problems.push(
        `a line window returned ${JSON.stringify(window.body.toString('utf8'))} rather than the first line that fits`
      );
    const whole = await shim.handle(
      'GET',
      `/v1/workspaces/${WORKSPACE}/file?path=${encodeURIComponent('workspace/round.txt')}`,
      Buffer.alloc(0)
    );
    if (!whole.headers['x-content-sha256'])
      problems.push(
        'the whole-file read carried no x-content-sha256, so no line-addressed edit could land'
      );

    /* ------------------------------------------------------------------ the listing sees a file */
    const listed = await shim.handle(
      'GET',
      `/v1/workspaces/${WORKSPACE}/files?path=workspace`,
      Buffer.alloc(0)
    );
    const entries = (
      JSON.parse(listed.body.toString('utf8')) as {
        entries: Array<{ path: string; sizeBytes: number }>;
      }
    ).entries;
    const row = entries.find((entry) => entry.path === 'workspace/round.txt');
    if (!row) problems.push('a file written through the shim does not appear in its own listing');
    else if (row.sizeBytes !== Buffer.byteLength(written, 'utf8'))
      problems.push(
        `the listing reported ${row.sizeBytes} bytes for a ${written.length}-byte file`
      );
  } finally {
    await backend.dispose();
  }

  /* --------------------------------------------------------------- the container argv, with no daemon */
  const argv = dockerExecArgv({
    container: 'tb-task',
    sudo: true,
    workspaceRoot: '/workspace',
    call: {
      executable: 'pytest',
      args: ['-q'],
      cwd: 'workspace/src',
      env: { CI: '1' },
      timeoutSeconds: 60,
      network: false,
      maxOutputBytes: 4_096
    }
  });
  if (argv.executable !== 'sudo' || argv.args[0] !== '-n' || argv.args[1] !== 'docker')
    problems.push(
      'the sudo form of docker exec is not `sudo -n docker`, which will prompt and hang'
    );
  if (!argv.args.includes('--workdir') || !argv.args.includes('/workspace/src'))
    problems.push('a relative cwd is not resolved against the box workspace root');
  if (argv.args.includes('-i'))
    problems.push('docker exec attached stdin for a call with no stdin, which hangs a reader');
  if (argv.args.at(-2) !== 'pytest' || argv.args.at(-1) !== '-q')
    problems.push('the command and its arguments are not last, so docker would read them as flags');

  /* ----------------------------------------------------------------- the aggregation discipline */
  const one = aggregate([0.4]);
  if (one.std !== null)
    problems.push(
      'a single run reported a standard deviation, which is the most flattering lie here'
    );
  const three = aggregate([0, 0.5, 1]);
  if (Math.abs(three.mean - 0.5) > 1e-9 || Math.abs((three.std ?? 0) - 0.5) > 1e-9)
    problems.push(`mean/std over [0, 0.5, 1] came back ${three.mean}/${String(three.std)}`);
  // Missing scores 0. Two of four tasks resolved, one verdict-less, one never mentioned at all.
  const partial: RunRecord = {
    startedAt: 'now',
    tasks: [
      {
        taskId: 'a',
        resolved: true,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        steps: null,
        wallSeconds: null,
        compactions: null,
        approvalCardsFired: null,
        infraFailure: false
      },
      {
        taskId: 'b',
        resolved: true,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        steps: null,
        wallSeconds: null,
        compactions: null,
        approvalCardsFired: null,
        infraFailure: false
      },
      {
        taskId: 'c',
        resolved: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        steps: null,
        wallSeconds: null,
        compactions: null,
        approvalCardsFired: null,
        infraFailure: true
      }
    ]
  };
  if (scoreOf(partial, 4) !== 0.5)
    problems.push(`a missing result did not score 0: 2 of 4 came back ${scoreOf(partial, 4)}`);

  /* ------------------------------------------------------------------------- the arm discipline */
  const fabricated = await threw(() =>
    rowFrom({ ...baseRow(), approvalsAutoAnswered: 3, arm: 'shipped' }, (value) => value)
  );
  if (fabricated === null)
    problems.push('a row with auto-answered approvals was emitted under an arm that declares none');
  const mislabelled = await threw(() =>
    rowFrom({ ...baseRow(), arm: 'unattended', securityMode: 'balanced' }, (value) => value)
  );
  if (mislabelled === null)
    problems.push('an "unattended" row was emitted for a run that was not autonomous');
  /*
   * AND THE FLATTERING DIRECTION, which the guard above did not cover for the life of this file.
   *
   * The check was one-way: `unattended` had to be autonomous, and nothing constrained the other two
   * arms at all. `shipped` is the arm that is supposed to cost points - a card that fires with
   * nobody at the keyboard parks the task at 0 - so a row labelled `shipped` and actually measured
   * under `autonomous` prints a smaller gap between the arms than exists. That gap is the one
   * number this artefact is for, and shrinking it flatters garden, which is the direction a rig
   * has no business being blind in.
   *
   * Every arm, driven off `ARM_SECURITY_MODE` itself rather than off three hand-written cases, so
   * an arm added to the ladder is covered without this check being edited. Both directions per arm:
   * the wrong mode must refuse and the right one must not, or a `rowFrom` that refused everything
   * would satisfy this.
   */
  const arms = Object.entries(ARM_SECURITY_MODE) as ReadonlyArray<
    [Arm, 'review' | 'balanced' | 'autonomous']
  >;
  if (arms.length === 0) problems.push('ARM_SECURITY_MODE is empty, so no arm was checked');
  for (const [arm, mode] of arms) {
    const wrong = mode === 'balanced' ? 'autonomous' : 'balanced';
    const flattered = await threw(() =>
      rowFrom({ ...baseRow(), arm, securityMode: wrong }, (value) => value)
    );
    if (flattered === null)
      problems.push(`a row labelled "${arm}" was emitted for a run measured under ${wrong}`);
    const right = await threw(() =>
      rowFrom(
        // `unattended` needs its auto-approver declared as well, or the check below refuses it for
        // the other reason and this one proves nothing.
        {
          ...baseRow(),
          arm,
          securityMode: mode,
          approvalsAutoAnswered: arm === 'unattended' ? 1 : 0
        },
        (value) => value
      )
    );
    if (right !== null) problems.push(`an honest "${arm}" row was refused: ${right}`);
  }
  /*
   * The auto-approver that was never attached: cards fired, none answered, arm says `unattended`.
   *
   * That run is `autonomous` wearing the `unattended` label, and it flatters in the same direction
   * as the mismatch above - the gap between `shipped` and `unattended` reads smaller than it is,
   * so the approval floor looks cheaper than it is. The negative control beside it matters as much:
   * an `unattended` row with NO cards fired is honest, because a task set that never reaches the
   * floor has nothing to auto-answer, and refusing it would refuse a row for having had no work.
   */
  const unanswered: RunRecord = {
    startedAt: 'now',
    tasks: [{ ...emptyTask('a'), resolved: true, approvalCardsFired: 2 }]
  };
  const unapproved = await threw(() =>
    rowFrom(
      {
        ...baseRow(),
        arm: 'unattended',
        securityMode: 'autonomous',
        approvalsAutoAnswered: 0,
        runs: [unanswered]
      },
      (value) => value
    )
  );
  if (unapproved === null)
    problems.push(
      'an "unattended" row was emitted for a run where cards fired and nothing auto-answered them'
    );
  const noCards = await threw(() =>
    rowFrom(
      {
        ...baseRow(),
        arm: 'unattended',
        securityMode: 'autonomous',
        approvalsAutoAnswered: 0,
        runs: [{ startedAt: 'now', tasks: [{ ...emptyTask('a'), resolved: true }] }]
      },
      (value) => value
    )
  );
  if (noCards !== null)
    problems.push(`an "unattended" run where no card ever fired was refused: ${noCards}`);
  // And the other direction: an honest row must actually come out, or every refusal above is
  // satisfied by a function that refuses everything.
  const honest = await threw(() => rowFrom(baseRow(), (value) => value));
  if (honest !== null) problems.push(`an honest row was refused: ${honest}`);

  /* ------------------------------------------- the row against the header it will be printed under */
  /*
   * `rowFrom` returns a positional array and `COLUMNS` is a hand-kept list of names beside it.
   * Nothing joined the two until this check, and the refusals above are all satisfied by a
   * `rowFrom` that emits the wrong number in every cell.
   *
   * Measured on 2026-09-02, both breaks green before this existed: deleting `input.taskSetSha`
   * from the returned array shifted every later value one column left - `model` published under
   * `task_set_sha`, `score_mean` under `aggregator` - and `pnpm eval:bench` said "clean" and
   * exited 0. So did replacing `String(round(score.mean, 4))` with a hard-coded `0.99`. This is
   * the published number, so it is checked by NAME rather than by count: a length check alone
   * passes a row with two columns transposed, and the transposition that matters here is between
   * two columns of the same width.
   *
   * The sentinels are distinct strings so no cell can satisfy another cell's assertion, and
   * `score_mean` is derived rather than declared - 2 of a declared 4 - so a scorer that returns a
   * constant fails here as well as in the `scoreOf` check above.
   *
   * EVERY COLUMN, and it did not used to be. This map covered 35 of the 44 and left the nine
   * AGGREGATE numbers - the two costs, the two token counts, the two step figures, the wall, the
   * compactions and the approval cards - pinned by nothing, because every task in the sentinel run
   * carried `null` for all of them and every one of those cells therefore read `0`. Nine cells that
   * are all the same value are nine cells that cannot tell each other apart. MEASURED 2026-09-02:
   * transposing the `input_tokens_mean` and `output_tokens_mean` lines of `rowFrom` published
   * `input_tokens_mean=26, output_tokens_mean=65569` into `parity-wire.csv`, and `pnpm eval:bench`
   * said "clean" and `--score` exited 0. Those two cells are the ones this lane's own measurement
   * of the acceptance loop is quoted from, so they were the published numbers with no check under
   * them at all. The tasks now carry distinct figures and each aggregate lands on a value no other
   * cell in the row holds.
   *
   * `arm` and `security_mode` used to be the same word, and `surfaces_browser` and
   * `surfaces_desktop` were both `absent`; a transposition inside either pair was invisible. Both
   * pairs now differ. What is still not pinned: `score_std` and `cost_usd_std`, which are both
   * empty because a single run has no standard deviation - a transposition between two empty cells
   * changes nothing a reader could read. What would change it: a sentinel with two runs.
   */
  const resolvedTask = (
    taskId: string,
    numbers: {
      readonly costUsd: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly steps: number;
      readonly wallSeconds: number;
      readonly compactions: number;
      readonly approvalCardsFired: number;
    }
  ): TaskResult => ({
    taskId,
    resolved: true,
    ...numbers,
    // Both, so `infra_failures_advisory` reads 2 rather than 0 or 1 and cannot be confused with
    // `n_runs`. It is advisory and does not void a row, which is why a resolved task may carry it.
    infraFailure: true
  });
  const sentinel: RowInput = {
    ...baseRow(),
    benchmark: 'benchmark-sentinel',
    taskSet: 'task-set-sentinel',
    taskSetSha: 'task-set-sha-sentinel',
    model: 'model-sentinel',
    modelRoute: 'model-route-sentinel',
    provider: 'provider-sentinel',
    harnessVersion: 'harness-version-sentinel',
    harnessCommit: 'harness-commit-sentinel',
    // `unattended` against an `autonomous` mode, so the two cells hold different words and a
    // transposition between them is visible. The auto-approver has to be declared with it or the
    // `unattended` refusal above fires instead and this check never runs.
    arm: 'unattended',
    securityMode: 'autonomous',
    approvalsAutoAnswered: 5,
    nTasks: 4,
    taskMaxSteps: 111,
    selfContinuations: 222,
    maxComputeCredits: 555,
    maxSpendUsd: 6.5,
    catalogueBytes: 333,
    catalogueTokensPerCall: 444,
    // Different from each other, so the two surface cells cannot be swapped unnoticed.
    surfaces: { browser: 'available', desktop: 'absent' },
    backend: 'backend-sentinel',
    verifierEnv: 'same',
    networkMode: 'network-mode-sentinel',
    declaredDrops: ['declared-drops-sentinel'],
    runs: [
      {
        startedAt: 'started-at-sentinel',
        tasks: [
          resolvedTask('a', {
            costUsd: 0.5,
            inputTokens: 700,
            outputTokens: 30,
            steps: 9,
            wallSeconds: 2,
            compactions: 6,
            approvalCardsFired: 8
          }),
          resolvedTask('b', {
            costUsd: 1.75,
            inputTokens: 900,
            outputTokens: 50,
            steps: 13,
            wallSeconds: 3,
            compactions: 12,
            approvalCardsFired: 16
          })
        ]
      }
    ]
  };
  const sentinelRow = rowFrom(sentinel, () => 'digest-sentinel');
  if (sentinelRow.length !== COLUMNS.length)
    problems.push(
      `rowFrom emitted ${sentinelRow.length} cells under a ${COLUMNS.length}-column header, so every column past the first difference would be published under the wrong name`
    );
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['benchmark', 'benchmark-sentinel'],
    ['task_set', 'task-set-sentinel'],
    ['n_tasks', '4'],
    ['task_set_sha', 'task-set-sha-sentinel'],
    ['model', 'model-sentinel'],
    ['model_route', 'model-route-sentinel'],
    ['provider', 'provider-sentinel'],
    ['harness', 'garden'],
    ['harness_version', 'harness-version-sentinel'],
    ['harness_commit', 'harness-commit-sentinel'],
    ['arm', 'unattended'],
    ['n_runs', '1'],
    ['aggregator', 'mean'],
    // 2 resolved of a DECLARED 4, so this cell also fails for a scorer that ignores `nTasks`.
    ['score_mean', '0.5'],
    // Empty because one run has no sample standard deviation, which is the honest cell and the
    // reason this pair is the one thing the map cannot position-pin. See the note above.
    ['score_std', ''],
    ['resolved_ids_sha', 'digest-sentinel'],
    // The nine aggregates. Each is DERIVED from the two tasks rather than declared, and each lands
    // on a value no other cell in this row holds - so a transposition between any two of them, or
    // between one of them and any other column, changes a value this list names.
    ['cost_usd_mean', '2.25'],
    ['cost_usd_std', ''],
    ['input_tokens_mean', '1600'],
    ['output_tokens_mean', '80'],
    // The mean of 9 and 13, beside the 95th percentile of the same two, which is 13. Distinct on
    // purpose: a row that printed the mean twice would pass a check that expected the same number.
    ['steps_mean', '11'],
    ['steps_p95', '13'],
    ['wall_seconds_mean', '2.5'],
    ['compaction_events_mean', '9'],
    ['approval_cards_fired_mean', '12'],
    ['catalogue_bytes', '333'],
    ['catalogue_tokens_per_call', '444'],
    ['approvals_auto_answered', '5'],
    ['security_mode', 'autonomous'],
    ['task_max_steps', '111'],
    ['self_continuations', '222'],
    ['max_compute_credits', '555'],
    ['max_spend_usd', '6.5'],
    ['surfaces_browser', 'available'],
    ['surfaces_desktop', 'absent'],
    // Distinct from every other numeric sentinel, so a column shifted onto it is a wrong VALUE and
    // not a coincidence. It must not void the row: a declared absence answered as declared is the
    // shim working, which is what separates it from `shimMisses`.
    ['absent_route_requests', '7'],
    ['backend', 'backend-sentinel'],
    ['isolates_network', 'false'],
    ['verifier_env', 'same'],
    ['network_mode', 'network-mode-sentinel'],
    ['infra_failures_advisory', '2'],
    ['declared_drops', 'declared-drops-sentinel'],
    ['run_started_at', 'started-at-sentinel'],
    ['garden_commit', 'harness-commit-sentinel']
  ];
  /*
   * The map has to reach EVERY column, or a column added later arrives unpinned and this check
   * quietly covers less than a reader assumes. That is how the nine aggregates came to be
   * published with nothing under them: they were never removed from the check, they were never put
   * in it. `score_std` and `cost_usd_std` are in the list holding empty strings, which pins their
   * position against any cell that is not also empty and is the most this can do at one run.
   */
  const unpinned = COLUMNS.filter((column) => !expected.some(([named]) => named === column));
  if (unpinned.length > 0)
    problems.push(
      `${unpinned.length} column(s) are published under no positional check: ${unpinned.join(', ')}. A transposition involving one of them would print a wrong number under a right name.`
    );
  if (expected.length === 0) problems.push('the column map is empty, so nothing below ran');
  for (const [column, value] of expected) {
    const index = COLUMNS.indexOf(column);
    if (index < 0) {
      problems.push(`the column map names "${column}", which is not in COLUMNS`);
      continue;
    }
    if (sentinelRow[index] !== value)
      problems.push(
        `column "${column}" carried ${JSON.stringify(sentinelRow[index])} rather than ${JSON.stringify(value)}, so a published row would say it under the wrong name`
      );
  }

  /* ------------------------------------- the seam this rig added to a file it does not own */
  // `evals/harness.ts` grew `observedRoutes` for this rig, and its comment there claims no
  // committed baseline row can move because of it. That claim is only true while `report.ts` -
  // which owns `check` and `baselineFrom` - never reads the field. Asserted rather than believed,
  // because a false comment is a defect ranked with a code defect here and the harness comment
  // points at this check by name.
  const reportSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'report.ts'),
    'utf8'
  );
  if (reportSource.includes('observedRoutes'))
    problems.push(
      'evals/report.ts now reads observedRoutes, so the harness comment claiming no committed row can move because of it is false'
    );

  /* ------------------------------------------------- the catalogue figure the artefact prints */
  // Measured through the production function on every run rather than typed into a column. The
  // ceiling this checks against is the one `apps/worker/src/tool-catalogue.test.ts:749` already
  // commits to for a bare box, so if the catalogue grows past it, this rig fails alongside that
  // test rather than quietly publishing a stale number in a CSV somebody will cite.
  const weights = catalogueWeights();
  if (weights.length === 0) problems.push('no catalogue weights were measured');
  const bare = benchmarkBoxCatalogueBytes();
  const provisioned = weights[0]?.bytes ?? 0;
  if (bare <= 0) problems.push('the benchmark box catalogue measured as zero bytes');
  if (bare >= provisioned)
    problems.push(
      `a box with no browser, no screen and no connections carries ${bare} bytes against a provisioned box's ${provisioned}, so nothing is being withdrawn`
    );
  // The README's table (section 3) prints whatever this file's own `catalogueWeights` measured on
  // the day it was last re-derived; 55,290 bytes is the anchor that table was first written
  // against, on 2026-09-03, and the README names it as the anchor. Nothing else commits to it -
  // `tool-catalogue.test.ts:402` holds the default catalogue under 55,700, and the 44,000 assertion
  // later in that file is over a bare box, not this one. If the catalogue moves, the table is
  // stale - so the figure is checked here, not trusted. The band is 2%, roughly one added tool
  // description and well inside the 55,700 ceiling the catalogue test holds. (BYTES_PER_TOKEN no
  // longer hangs off this number; see catalogue.ts for why it is four.)
  // One constant, read into both the comparison and the message, so a message cannot say a
  // different number than the one that was checked.
  const anchorBytes = 55_290;
  if (Math.abs(provisioned - anchorBytes) / anchorBytes > 0.02)
    problems.push(
      `the fully provisioned catalogue now weighs ${provisioned} bytes against the ${anchorBytes} the README table is anchored on, so the table and every token figure this rig prints (at ${BYTES_PER_TOKEN.toFixed(1)} bytes a token) are stale`
    );
  if (bare >= 44_000)
    problems.push(
      `the benchmark box catalogue is ${bare} bytes, past the 44,000 bare-box ceiling apps/worker/src/tool-catalogue.test.ts:749 commits to`
    );

  /* ------------------------------------------- the constant that restates another file's answer */
  // A false comment is a defect ranked with a code defect here, and `observe.ts`'s SWEEP_SURFACES
  // is a restatement of a line in a file this lane does not own. Re-read rather than trusted, so a
  // change to the harness's `/surfaces` answer fails this rig instead of silently making every
  // committed observation describe a box the sweep did not run on.
  const harnessSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness.ts'),
    'utf8'
  );
  const surfaceLine = /\/surfaces'\)\)\s*return json\(\{([^}]*)\}\)/.exec(harnessSource)?.[1] ?? '';
  if (surfaceLine.trim() === '')
    problems.push(
      'the /surfaces answer could not be found in evals/harness.ts, so SWEEP_SURFACES vouches for nothing'
    );
  else
    for (const [surface, presence] of Object.entries(SWEEP_SURFACES))
      if (!new RegExp(`${surface}:\\s*'${presence}'`).test(surfaceLine))
        problems.push(
          `observe.ts says the sweep runs with ${surface}: '${presence}' and evals/harness.ts answers ${surfaceLine.trim()}`
        );

  /* --------------------------------- the surface excuse, spent only on the surface it belongs to */
  /*
   * A CONSTRUCTED OBSERVATION, because the committed one cannot go red here.
   *
   * `coverageOf` excuses a surface-gated route the sweep reached but a bare benchmark box cannot.
   * It decided that from `surfaces.browser` alone and applied the answer to the three DESKTOP
   * routes as well - which the committed artefact can never show, because its sweep box has both
   * surfaces and the two spellings agree there. So the box that tells them apart has to be built:
   * a browser and no screen, and a desktop route in the observed set.
   *
   * `agentToolsFor` gates the two families in two separate clauses
   * (`apps/worker/src/tool-catalogue.ts:1866-1867`), so a box with a browser and no screen reaches
   * the browser routes and cannot reach the desktop ones. A desktop route observed on that box is
   * therefore a real finding about the gate and must arrive as a MISS, and the browser route beside
   * it must still be excused - both directions, or a `coverageOf` that excused nothing would pass.
   */
  const mixedBox: RouteObservation = {
    recordedAt: 'now',
    garden: 'selftest',
    fixtures: ['constructed'],
    observed: [
      { route: 'POST /v1/workspaces/:workspaceId/browser/snapshot', fixtures: 1 },
      { route: 'POST /v1/workspaces/:workspaceId/desktop/snapshot', fixtures: 1 }
    ],
    unstubbed: [],
    declaredButUnobserved: [],
    surfaces: { browser: 'available', desktop: 'absent' }
  };
  const mixed = coverageOf(mixedBox);
  if (!mixed.gatedOut.includes('POST /v1/workspaces/:workspaceId/browser/snapshot'))
    problems.push(
      'a browser route reached on a box WITH a browser was not excused, so a real miss and a surface difference are being reported the same way'
    );
  if (!mixed.missing.includes('POST /v1/workspaces/:workspaceId/desktop/snapshot'))
    problems.push(
      'a desktop route reached on a box with NO screen was excused by the browser surface, so the gate was never asked about the surface the route needs'
    );

  /* ------------------------------------------------------- the committed observation, if there is one */
  if (observation === null) problems.push('no committed route observation: run --observe');
  else if (observation.observed.length === 0)
    problems.push(
      'the committed route observation is empty, so its coverage check asserts nothing'
    );
  else {
    const coverage = coverageOf(observation);
    if (coverage.missing.length > 0)
      problems.push(
        `garden asked for ${coverage.missing.length} route(s) this shim does not implement: ${coverage.missing.join(', ')}`
      );
    // The excuse has to be spendable only where it applies. A `gatedOut` list that grew to cover a
    // route the catalogue gate does not withdraw would be this rig excusing its own gaps, which is
    // the exact failure it exists to prevent - so the two sets are checked against each other.
    for (const route of coverage.gatedOut)
      if (Object.prototype.hasOwnProperty.call(ABSENT_ROUTES, route))
        problems.push(
          `${route} is both surface-gated and declared absent, which cannot both be true`
        );
  }

  /* ----------------------------- the join, driven by garden's own client over a real socket */
  // Every request above was composed by this rig and parsed by this rig. See wiring.ts for why
  // that is not enough on its own.
  problems.push(...(await wiringChecks()));

  /* ------------------------------------ the whole join: a turn, a box, a verifier and a score */
  /*
   * THE CHECK THIS DIRECTORY EXISTED WITHOUT. `wiring.ts` proves the wire between garden's client
   * and this shim; it does not run a turn. Everything else here proves a part. This drives a REAL
   * `AgentWorker` - the same object the worker process runs - against this shim, against a real
   * temporary directory, and lets a command in that directory decide whether the work was done.
   *
   * On every invocation and not behind a flag, for the reason the header of this file gives and for
   * one more: the join is the thing this rig was three times found not to have, and a check that
   * only runs when somebody remembers a flag is a check that is not running when it breaks. It
   * costs about 0.4 s of the ~2 s this command takes.
   *
   * The model is a script, so this says nothing about garden's ability at anything. It says the
   * loop can carry work into a box and that the box can disagree with it.
   */
  const scored = await scoreTask(SUM_TASK, false);
  if (scored.result.resolved !== true)
    problems.push(
      `the end-to-end task did not resolve: status ${scored.status}, verifier exit ${String(scored.verifierExit)} ${scored.verifierStderr}${scored.error === null ? '' : `, error ${scored.error}`}`
    );
  if (scored.status !== 'completed')
    problems.push(`the end-to-end turn ended ${scored.status} rather than completed`);
  /*
   * The turn's own account of its evidence, asserted BESIDE the verdict and never instead of it.
   *
   * Measured on 2026-09-02, and it is the reason `score.ts` takes the verdict from the box: break
   * the solution so the total is the LINE COUNT rather than the sum, and this run reports
   * `status=completed verification=verified` - identically to the correct run - while the file
   * holds 7 instead of 1260. The turn's own acceptance check ran in the box and failed four times
   * (`MAX_ACCEPTANCE_FAILURES`, `apps/worker/src/turn-bounds.ts:360`), the failures were appended
   * to `remainingRisks` by `apps/worker/src/turn/finish.ts:320`, and the status field was left as
   * the model declared it. So neither of garden's two top-line signals separates a solved task
   * from a knowingly unsolved one, and a benchmark adapter reading either would have scored that
   * run 1. Only the verifier told them apart.
   */
  if (scored.verification !== 'verified')
    problems.push(
      `the end-to-end turn reported verification "${scored.verification}", so its finish was not grounded in the read it cited`
    );
  if (scored.misses.length > 0)
    problems.push(
      `a real turn against this shim reached ${scored.misses.length} route(s) it does not implement: ${scored.misses.join(', ')}`
    );
  if (scored.observedRoutes.length === 0)
    problems.push('a real turn against this shim recorded no runner route at all');
  /*
   * The acceptance check ran IN THE BOX, rather than being declared and believed.
   *
   * The scripted model makes exactly two `shell` calls, so a third command is the loop running the
   * check the turn declared - through the real shim, against the real directory. Two would mean
   * the acceptance hold was answered and the check never carried out, which is the shape where a
   * turn reports itself verified on the strength of a sentence.
   */
  if (scored.commandsRun < 3)
    problems.push(
      `the turn ran ${scored.commandsRun} command(s) in the box; two are the model's own, so its acceptance check was never carried out`
    );
  /*
   * AND THE SURFACE GATE, OBSERVED AT LAST.
   *
   * `routes.ts` states as its honest limit that this rig had never watched a run under
   * `absent, absent` surfaces and seen the seven surface tools not appear - it read the gate's own
   * unit test and the single production line that applies it. This shim answers `/surfaces` with
   * exactly that box, so the catalogue the loop offered on its last request is the observation.
   * The names are DERIVED through `agentToolsFor` rather than copied, so a tool added to either
   * surface set is covered without this file being edited.
   */
  /*
   * The local backend is not a sandbox, and a task definition from somewhere else may not run on it
   * without the caller saying so.
   *
   * `backend.ts` has promised this in prose since it was written and nothing implemented it: the
   * flag it named, `--trust-local`, existed nowhere in the repository. A comment describing a guard
   * that is not there is worse than no comment, because the next person builds on it. The guard is
   * in `score.ts` now and this is the check that it fires. The other direction is the run above:
   * `SUM_TASK` is `builtin` and ran with `trustLocal` false.
   */
  const untrusted = await threw(() => scoreTask({ ...SUM_TASK, origin: 'external' }, false));
  if (untrusted === null)
    problems.push(
      'an external task definition ran on the local backend with no --trust-local, so a downloaded shell script would run as this user'
    );

  /*
   * A task that starts solved is not a task, and this is the one hole the verifier alone leaves.
   *
   * MEASURED 2026-09-02 with the guard removed: a `seed` that already carries the answer file and a
   * solution script replaced by `true` produced `resolved`, `score_mean 1` in `parity-wire.csv`,
   * exit 0, and this self-test saying "clean" - while the turn did nothing. Every other signal read
   * identically to the honest run, including `commandsRun`, because the agent's own acceptance
   * check passed against the seeded answer. Only a verifier run BEFORE the turn tells them apart.
   *
   * The other direction runs on every invocation immediately above: `SUM_TASK`'s own seed does not
   * satisfy its verifier, and the run scores 1 on the strength of the turn.
   */
  const preSolved = await threw(() =>
    scoreTask(
      {
        ...SUM_TASK,
        seed: { ...SUM_TASK.seed, 'workspace/total.txt': `${String(EXPECTED_TOTAL)}\n` }
      },
      false
    )
  );
  if (preSolved === null)
    problems.push(
      'a task whose seed already satisfies its own verifier was scored, so an agent that did nothing would have earned a point'
    );

  const gatedTools = surfaceGatedToolNames();
  if (gatedTools.length === 0)
    problems.push('no surface-gated tools were derived, so the gate check below asserted nothing');
  if (scored.catalogue.length === 0)
    problems.push('the end-to-end turn offered no catalogue at all, so the gate check saw nothing');
  const survived = gatedTools.filter((tool) => scored.catalogue.includes(tool));
  if (survived.length > 0)
    problems.push(
      `a turn on a box answering absent/absent was still offered ${survived.join(', ')}, so the catalogue gate did not hold`
    );
  // The other withdrawal the benchmark-box figure depends on, from a different production line
  // (`apps/worker/src/turn/claim.ts`): no connectors, no `connector_action`, which is about 6.6 kB.
  if (scored.catalogue.includes('connector_action'))
    problems.push(
      'a turn on a box with nothing connected was offered connector_action, so catalogue.ts overstates what the benchmark box withdraws'
    );

  /* ------------------------------------------- a declared absence is a refusal the model can read */
  const absentBackend = await localBackend();
  try {
    await absentBackend.ensure();
    const shim = createShim({ backend: absentBackend });
    const routes = Object.keys(ABSENT_ROUTES);
    if (routes.length === 0) problems.push('ABSENT_ROUTES is empty, so nothing below ran');
    for (const route of routes) {
      const [method, pathname] = route.split(' ');
      const answer = await shim.handle(
        method ?? 'POST',
        (pathname ?? '').replace(':workspaceId', WORKSPACE),
        bodyOf({})
      );
      if (answer.status !== 503)
        problems.push(`${route} answered ${answer.status} rather than a named 503 absence`);
      if (!answer.body.toString('utf8').includes('capability_absent'))
        problems.push(`${route} did not name itself as an absent capability`);
    }
    if (shim.misses.length > 0)
      problems.push(`a declared absence was recorded as a miss: ${shim.misses.join(', ')}`);
    if (shim.absentRequests !== routes.length)
      problems.push(
        `${routes.length} absent routes were asked for and ${shim.absentRequests} were counted, so the artefact would understate them`
      );
  } finally {
    await absentBackend.dispose();
  }

  return problems;
};
