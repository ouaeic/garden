/**
 * The tasks `--score` can drive, and the verifier that decides whether one was solved.
 *
 * WHAT A TASK IS HERE, and why the shape is the benchmark's rather than this rig's: a prompt, some
 * files seeded into the box before the turn, and a COMMAND RUN IN THE BOX AFTERWARDS whose exit
 * code is the whole verdict. That is Terminal-Bench's own shape, so a real task set drops into it
 * without this rig learning a second idea of what "solved" means. Nothing here inspects the turn's
 * transcript to decide a score: a task is resolved when the box says it is.
 *
 * WHY THE MODEL IS A SCRIPT AND WHY THAT IS STILL A REAL JOIN. A benchmark task whose solution is
 * a fixed sequence of shell commands is exactly the shape a scripted model can drive, and driving
 * it exercises everything between the model and the box that a paid run would: the turn loop, the
 * tool catalogue, the approval floor, the acceptance hold, the runner protocol, the shim, and a
 * real filesystem. What it does NOT exercise is the model - no provider is called, nothing is
 * billed, and the score below says nothing whatever about how good garden is at anything. It says
 * the wire carries work end to end. That distinction is why `--score` writes `parity-wire.csv` and
 * not `parity.csv`; see README.md.
 *
 * THE SCRIPT REACTS RATHER THAN COUNTS. It is written against the loop's own pushback markers
 * (`PUSHBACK_MARKERS`, published from `apps/worker/src/turn-bounds.ts`), not against a step number,
 * for the reason `evals/harness.ts`'s header gives: a fixed list of replies cannot tell "the loop
 * held the finish and the model complied" from "the next reply happened to be next". A script that
 * reads what garden just said can, and the step count it produces is then the measured price of
 * the holds rather than an arrangement of this file.
 */
import type { Fixture, LiveProvider, ModelScript, ScriptContext } from '../harness.js';

import type { ExecCall } from './backend.js';

/** A command run in the box after the turn, whose exit code is the verdict. */
export interface Verifier {
  /** What the check is, in the words a reader of the row needs. */
  readonly label: string;
  readonly call: Pick<ExecCall, 'executable' | 'args' | 'cwd'>;
  /**
   * How long the check may take, or nothing for this rig's own default.
   *
   * A borrowed task set brings its own ceiling and it is routinely far larger than ours: of the 241
   * Terminal-Bench tasks, 232 declare a `max_test_timeout_sec` above the 120 seconds `score.ts`
   * used to hardcode, running to 28,800. A verifier killed at 120 reports a non-zero exit that is
   * indistinguishable from a failed solution, so the score comes out LOW and looks like the agent's
   * fault. That is the worst failure available to a benchmark: not a refused row, but a wrong
   * number in the flattering-to-nobody direction, produced silently.
   */
  readonly timeoutSeconds?: number;
}

export interface WireTask {
  readonly id: string;
  /** The owner's words, as they would arrive. */
  readonly request: string;
  /**
   * Files placed in the box before the turn starts, keyed by path in the runner's own frame -
   * `workspace/input.txt`, not `input.txt`. @see files.ts, whose paths are root-relative.
   */
  readonly seed: Readonly<Record<string, string>>;
  readonly model: ModelScript;
  readonly verify: Verifier;
  /**
   * Where the task's commands come from, which decides whether the local backend may run them.
   *
   * `builtin` is a task written in this repository and reviewed with it. `external` is a task
   * definition from a benchmark, which is somebody else's shell script: `score.ts` refuses to run
   * one on the local backend without `--trust-local`, because the local backend is not a sandbox
   * (see `backend.ts`) and the difference between running your own test and running a downloaded
   * one is the difference between a rig and a foothold.
   */
  readonly origin: 'builtin' | 'external';
  /** The step ceiling this task runs under, which travels into the row as `task_max_steps`. */
  readonly maxSteps: number;
  /** The compute ceiling in force, which travels into the row as `max_compute_credits`. */
  readonly maxCredits: number;
}

/** PATH is set explicitly on every verifier call: the box's own environment is not this rig's. */
export const VERIFIER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * The seven numbers the built-in task sums, and the answer.
 *
 * Chosen so that the three plausible wrong answers are all different from the right one: the count
 * of the lines is 7, the largest entry is 1000, and the sum of the positives is 1270. A verifier
 * that passed on any of those would be a verifier agreeing with a broken solution, which is the
 * failure this whole rig is about. The negatives are there so that a solution which reads the file
 * as unsigned text lands somewhere else again.
 */
const NUMBERS = [137, 42, -9, 1000, 3, 88, -1] as const;
export const EXPECTED_TOTAL = NUMBERS.reduce((total, value) => total + value, 0);

/**
 * The solution, as one POSIX `sh` script with NO EXTERNAL COMMANDS IN IT.
 *
 * `shell` sends `executable` and `args` to the runner as separate fields and the shim spawns them
 * with the environment the call carried, which for a tool call is empty - so a script that reached
 * for `awk` would be measuring whether the box's shell has a compiled-in default PATH rather than
 * whether garden's loop can drive a box. `read`, arithmetic expansion and `echo` are shell
 * builtins everywhere this can run. An absolute `executable` for the same reason.
 */
const SUM_SCRIPT =
  'total=0; while read -r n; do total=$((total + n)); done < input.txt; echo "$total" > total.txt';

/**
 * Whether garden's LAST word carries one of the loop's own pushback markers.
 *
 * The last one and not the window, and the difference cost this script four steps on its first
 * run. A hold's message stays in the window for the rest of the turn, so a script that asked
 * `messages.some(...)` answered the acceptance hold on every step after it - four times over with
 * byte-identical arguments. The loop's stationary watch caught it and said so
 * ("NOTHING HAS CHANGED FOR 3 STEPS. Every one of them made the same call - set_acceptance - with
 * byte-identical arguments"), which is the mechanism working; the script was the thing that was
 * wrong. `lastMessage` steps over the runtime block, so it is what garden just said and nothing
 * else. @see evals/harness.ts's ScriptContext.
 */
const said = (context: ScriptContext, marker: string): boolean =>
  context.lastMessage.includes(marker);

/**
 * The scripted model for the summing task.
 *
 * Five replies at most, and which one is sent is decided by what the loop said back rather than by
 * the step number. The acceptance hold is answered with a REAL command check - the same script the
 * turn already ran - so the loop runs it against the real box through the real shim, which is one
 * more production mechanism the join exercises for free.
 */
const sumModel: ModelScript = (context) => {
  // A compaction's brief, a specialist's step and a vision handoff are not this turn's steps. None
  // of them should happen on a turn this short; answering with prose rather than a tool call means
  // that if one ever does, it degrades into a summary and not into a mystery tool call.
  if (context.summarising || context.delegated || context.vision)
    return { text: 'Summed the integers in workspace/input.txt into workspace/total.txt.' };

  if (said(context, 'Finish held: this turn changed'))
    return {
      calls: [
        {
          id: 'call-acceptance',
          name: 'set_acceptance',
          args: {
            checks: [
              {
                kind: 'command',
                label: 'the total in workspace/total.txt is the sum of the inputs',
                executable: '/bin/sh',
                args: [
                  '-c',
                  `read -r got < total.txt; [ "$got" = "${String(EXPECTED_TOTAL)}" ] || exit 1`
                ]
              }
            ]
          }
        }
      ]
    };

  const finish = {
    text: `The total is ${String(EXPECTED_TOTAL)}, written to workspace/total.txt.`,
    calls: [
      {
        id: 'call-finish',
        name: 'finish',
        args: {
          summary: 'Summed the integers into workspace/total.txt.',
          verification: {
            status: 'verified',
            evidence: [
              {
                claim: 'The file was read back after the write and holds the total',
                source: 'tool_result',
                toolCallId: 'call-read'
              }
            ],
            remainingRisks: []
          }
        }
      }
    ]
  };

  switch (context.step) {
    case 0:
      return {
        calls: [
          {
            id: 'call-sum',
            name: 'shell',
            args: { executable: '/bin/sh', args: ['-c', SUM_SCRIPT] }
          }
        ]
      };
    case 1:
      return {
        calls: [
          {
            id: 'call-read',
            name: 'shell',
            args: { executable: '/bin/cat', args: ['total.txt'] }
          }
        ]
      };
    default:
      return finish;
  }
};

/**
 * The built-in task: write a file, run a command, check the output, exactly as the brief for this
 * lane asked for. It is small on purpose - one earned row is worth more than a hundred columns of
 * machinery - and everything it touches is real except the model.
 */
export const SUM_TASK: WireTask = {
  id: 'sum-integers',
  request:
    'workspace/input.txt has one integer per line. Add them up and write the total, on its own line, to workspace/total.txt.',
  seed: { 'workspace/input.txt': `${NUMBERS.join('\n')}\n` },
  model: sumModel,
  verify: {
    label: `workspace/total.txt holds ${String(EXPECTED_TOTAL)}`,
    call: {
      executable: '/bin/sh',
      // No `cat`, no `test` binary, no PATH lookup: the same discipline the solution script runs
      // under, so a verifier can never fail for a reason the solution could not have failed for.
      args: [
        '-c',
        `[ -f workspace/total.txt ] || exit 1; read -r got < workspace/total.txt; [ "$got" = "${String(EXPECTED_TOTAL)}" ] || exit 1`
      ],
      cwd: '.'
    }
  },
  origin: 'builtin',
  // Twelve, which is `evals/harness.ts`'s own default and enough for the five replies above plus
  // the closing handoff. A ceiling this task cannot reach is a ceiling that measures nothing; one
  // it can is a step_budget hold, which is a different fixture's subject.
  maxSteps: 12,
  maxCredits: 50
};

export const TASKS: readonly WireTask[] = [SUM_TASK];

/**
 * The task as `runFixture` wants it, pointed at a real workspace.
 *
 * `expect` is required by the `Fixture` type and read by `evals/report.ts`, never by `runFixture` -
 * the checking in this rig is the verifier in the box, not an expectation table - so it is empty
 * and says so rather than carrying assertions nothing evaluates.
 */
export const fixtureFor = (
  task: WireTask,
  workspaceUrl: string,
  live?: LiveProvider,
  /**
   * The arm, as the harness takes it: the mode the task is minted under and whether an approver
   * answers its cards. Absent, the fixture is minted the way every offline fixture is - `balanced`,
   * nobody answering - which is the `shipped` arm.
   */
  arm?: {
    readonly securityMode: 'review' | 'balanced' | 'autonomous';
    readonly autoApprove: boolean;
  }
): Fixture => ({
  ...(live === undefined ? {} : { live }),
  ...(arm === undefined ? {} : { securityMode: arm.securityMode, autoApprove: arm.autoApprove }),
  id: `bench-${task.id}`,
  shape: 'files',
  request: task.request,
  why: 'Drives a real AgentWorker against the benchmark shim over a real socket, and scores it by a command run in the box.',
  model: task.model,
  maxSteps: task.maxSteps,
  maxCredits: task.maxCredits,
  workspaceUrl,
  expect: {}
});
