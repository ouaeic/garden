import type { DataStore, TaskRecord } from '@garden/data';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptanceAlreadyObserved,
  acceptanceObservation,
  acceptancePassedEvidence,
  commandFingerprint,
  describeAcceptanceCheck,
  parseAcceptanceChecks,
  type AcceptanceCheck,
  type AcceptanceObservation,
  type AcceptanceRecord,
  type AcceptanceResult
} from './acceptance.js';
import {
  ACCEPTANCE_SUITE_DEADLINE_SECONDS,
  acceptanceChecks,
  type AcceptanceRunnerDeps
} from './acceptance-runner.js';
import type { AgentRunnerClient } from './runner-client.js';
import { agentTools } from './tools.js';

const parse = (check: Record<string, unknown>) => parseAcceptanceChecks([check]);

const artifact = {
  kind: 'artifact',
  label: 'The deck is twelve slides and none of them is cut off',
  path: 'workspace/board/deck.pptx',
  minBytes: 20_000
};

describe('an artifact check that is about the pages rather than the bytes', () => {
  it('keeps what the job asked for and defaults the margin to the page edge itself', () => {
    const parsed = parse({ ...artifact, render: { expectPages: 12 } });
    expect(parsed.ok && parsed.checks[0]).toMatchObject({
      kind: 'artifact',
      path: 'workspace/board/deck.pptx',
      minBytes: 20_000,
      render: { expectPages: 12, marginPoints: 0 }
    });
  });

  it('leaves a check that did not ask for a render exactly as it was', () => {
    const parsed = parse(artifact);
    // Named rather than inferred from a matcher: a size check that quietly grew a render clause
    // would be a measurement the model never declared and the owner was never shown.
    expect(parsed.ok && 'render' in parsed.checks[0]!).toBe(false);
  });

  it('refuses a render clause on a file that has no rendered page', () => {
    for (const path of ['workspace/notes.md', 'workspace/report', 'workspace/data.csv']) {
      const parsed = parse({ ...artifact, path, render: {} });
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.reason).toContain('has no rendered page');
    }
  });

  it('accepts a clause that names nothing, because it still says the pages are intact', () => {
    const parsed = parse({ ...artifact, path: 'workspace/cv.pdf', render: {} });
    expect(parsed.ok && parsed.checks[0]).toMatchObject({ render: { marginPoints: 0 } });
  });

  it('refuses a page count that is not a number of pages', () => {
    for (const expectPages of [0, -3, 1.5, 'one']) {
      const parsed = parse({ ...artifact, render: { expectPages } });
      expect(!parsed.ok && parsed.reason).toContain('whole number of pages');
    }
  });

  /**
   * The half that decides whether any of the above is reachable at all.
   *
   * `set_acceptance` declares `additionalProperties: false`, so a clause this file parses but the
   * catalogue does not offer is a measurement no model can ask for - the whole thing inert, with
   * the parser and the description reading exactly as though it worked. Held against the schema
   * the model is actually sent, and against the fields the parser actually reads.
   */
  it('is a clause the model is offered, not only one this file can read', () => {
    const declared = agentTools.find((tool) => tool.name === 'set_acceptance');
    const properties = (
      declared?.parameters as {
        properties: { checks: { items: { properties: Record<string, unknown> } } };
      }
    ).properties.checks.items.properties;
    expect(Object.keys(properties)).toContain('render');
    expect(Object.keys((properties.render as { properties: object }).properties)).toEqual([
      'expectPages',
      'marginPoints'
    ]);
  });
});

describe('what the owner is shown before the work starts', () => {
  it('says what will be measured, in pages and words rather than in tools', () => {
    const parsed = parse({ ...artifact, render: { expectPages: 12 } });
    expect(parsed.ok && describeAcceptanceCheck(parsed.checks[0]!)).toBe(
      'check-1 (The deck is twelve slides and none of them is cut off): workspace/board/deck.pptx exists and is at least 20000 bytes, and renders as exactly 12 pages with no text cut off at a page edge and no page blank'
    );
  });

  it('names the margin when the job was given one', () => {
    const parsed = parse({
      ...artifact,
      path: 'workspace/cv.pdf',
      render: { expectPages: 1, marginPoints: 36 }
    });
    expect(parsed.ok && describeAcceptanceCheck(parsed.checks[0]!)).toContain(
      'renders as exactly 1 page with every word inside a 36pt margin and no page blank'
    );
  });

  it('describes a plain size check the way it always did', () => {
    const parsed = parse({
      kind: 'artifact',
      label: 'The report exists',
      path: 'workspace/out.txt'
    });
    expect(parsed.ok && describeAcceptanceCheck(parsed.checks[0]!)).toBe(
      'check-1 (The report exists): workspace/out.txt exists and is at least 1 bytes'
    );
  });
});

/*
 * The red baseline is the only thing that ever falsifies a check, and it runs only `if
 * (!state.mutated)` while the hold that asks for a record at all fires on `mutatedBeyondProse`. So
 * the ordinary coding turn declares its record after the change and nothing runs against it. Every
 * case below goes through `parseAcceptanceChecks`, which is what `declareAcceptance` calls on both
 * paths, so what is pinned is the refusal the model actually meets rather than the predicate.
 */
describe('a check no state of the workspace can fail', () => {
  const command = { kind: 'command', label: 'the build is green' };

  it('refuses a command whose answer its own arguments already decide', () => {
    for (const [executable, args] of [
      ['echo', ['all tests pass']],
      ['echo', []],
      ['true', []],
      ['printf', ['ok\n']],
      // The wrapper comes off first, so a duration in front of it does not buy the check anything.
      ['timeout', ['30', 'echo', 'ok']],
      // And so does the interpreter, which is the spelling the shell tool tells the model to write.
      ['bash', ['-lc', 'echo BUILD OK']],
      ['sh', ['-c', 'true']],
      ['bash', ['-lc', 'echo one; echo two']]
    ] as Array<[string, string[]]>) {
      const parsed = parse({ ...command, executable, args });
      expect(parsed.ok, `${executable} ${args.join(' ')}`).toBe(false);
      expect(!parsed.ok && parsed.reason).toContain('answers the same way whatever is in the');
    }
  });

  /*
   * Both spellings of the same command, because for a while only one of them was refused.
   *
   * `effectiveCommands` returns the head as written; `acceptanceCommandRefusal`, the refusal this
   * one is chained to, lowers its binary before the set lookup. So `ECHO ok` was accepted and
   * `echo ok` refused - never a false pass on a Linux workspace, where `ECHO` is not on PATH and the
   * check would exit 127, but two adjacent guards reading the same token two ways. Held on the
   * wrapped spelling too, because that is the one the shell catalogue tells the model to write.
   */
  it('reads the command name the same way its sibling refusal does, in either case', () => {
    for (const [executable, args] of [
      ['ECHO', ['ok']],
      ['Echo', ['ok']],
      ['bash', ['-lc', 'ECHO ok']],
      ['bash', ['-lc', 'TRUE']],
      ['/bin/ECHO', ['ok']]
    ] as Array<[string, string[]]>) {
      const parsed = parse({ ...command, executable, args });
      expect(parsed.ok, `${executable} ${args.join(' ')}`).toBe(false);
      expect(!parsed.ok && parsed.reason).toContain('answers the same way whatever is in the');
    }
  });

  /*
   * A glob the refusal must accept, and the two quoted spellings it must still refuse.
   *
   * `echo workspace/out/*.png` prints the file names when the thumbnails are there and the literal
   * pattern when they are not: the shell read the workspace before echo ran, so the check can fail
   * and can pass, and refusing it would tell the model something untrue about why. The wordier
   * equivalent `for f in workspace/*.jpg; do echo "$f"; done` is pinned as accepted in the row
   * below, so the two are the same check in two spellings.
   *
   * Two things keep this from being a blanket hole, and both are pinned below. Quoting: the tokens
   * keep their quotes, so a `*` inside them is text and the check is still refused. And a shell:
   * the runner spawns a check with `shell: false`, so the bare declaration
   * `{executable: 'echo', args: ['workspace/*.jpg']}` prints the pattern back unchanged on every
   * computer there is and is refused, while the same characters after `bash -lc` are not.
   */
  it('leaves a glob alone when a shell is there to expand it, and not otherwise', () => {
    for (const [executable, args] of [
      ['bash', ['-lc', 'echo workspace/out/*.png']],
      ['bash', ['-lc', 'printf "%s\\n" workspace/out/*.png']],
      ['bash', ['-lc', 'echo workspace/report-?.pdf']],
      ['bash', ['-lc', 'echo workspace/[abc].txt']],
      // The wrapper does not take the shell away, so neither does it take this away.
      ['timeout', ['30', 'bash', '-lc', 'echo workspace/out/*.png']]
    ] as Array<[string, string[]]>)
      expect(parse({ ...command, executable, args }).ok, `${executable} ${args.join(' ')}`).toBe(
        true
      );

    for (const [executable, args] of [
      // Quoted, so the shell that is there has nothing to expand.
      ['bash', ['-lc', "echo 'ok*'"]],
      ['bash', ['-lc', 'echo "ok*"']],
      ['bash', ['-lc', "printf '%s' 'thumb-*.png'"]],
      // Unquoted, and no shell: `execFile`-shaped, so the argument reaches echo as it was written.
      ['echo', ['workspace/*.jpg']],
      ['echo', ['*']],
      ['printf', ['%s\\n', 'workspace/out/*.png']]
    ] as Array<[string, string[]]>) {
      const parsed = parse({ ...command, executable, args });
      expect(parsed.ok, `${executable} ${args.join(' ')}`).toBe(false);
      expect(!parsed.ok && parsed.reason).toContain('answers the same way whatever is in the');
    }
  });

  it('refuses it whatever the check claims to expect, because the claim is in the command', () => {
    const parsed = parse({
      ...command,
      executable: 'bash',
      args: ['-lc', 'echo PASSED'],
      expectStdoutContains: 'PASSED'
    });
    expect(parsed.ok).toBe(false);
  });

  /*
   * The arm that matters. An acceptance gate that refuses honest work is an outage, and the shape
   * that reads most like the one above is honest: `test` decides the answer and the echo only
   * reports it. Every row here is a check a real turn declares - including
   * `bash workspace/rename-scans.sh`, which is `files-helper-script-then-run` in `evals/fixtures.ts`
   * and which the house prices as "the shape half the owner's work takes".
   */
  it('leaves every check the workspace decides exactly as it was', () => {
    for (const [executable, args] of [
      ['pytest', ['-q', 'test_retry.py']],
      ['pnpm', ['build']],
      ['bash', ['-lc', 'test -f workspace/out.pdf && echo ok']],
      ['bash', ['-lc', 'pnpm build && echo done']],
      ['bash', ['workspace/rename-scans.sh']],
      ['python', ['workspace/compute.py']],
      ['grep', ['-c', 'PASS', 'workspace/results.txt']],
      ['bash', ['-lc', 'for f in workspace/*.jpg; do echo "$f"; done']],
      ['node', ['--test']],
      ['ls', ['workspace']]
    ] as Array<[string, string[]]>) {
      const parsed = parse({ ...command, executable, args });
      expect(parsed.ok, `${executable} ${args.join(' ')}`).toBe(true);
      expect(parsed.ok && parsed.checks[0]).toMatchObject({ kind: 'command', executable, args });
    }
  });

  it('says plainly that the interpreted spellings are not caught, so nobody reads more into it', () => {
    // Not a wish: `effectiveCommands` reads the shell, and a print statement in another language is
    // a word-shaped token to it. Pinned so the day someone teaches it Python this row fails and the
    // comment above `acceptanceVacuousRefusal` is corrected rather than left lying.
    expect(parse({ ...command, executable: 'python', args: ['-c', "print('ok')"] }).ok).toBe(true);
    expect(parse({ ...command, executable: 'node', args: ['-e', "console.log('ok')"] }).ok).toBe(
      true
    );
  });

  /*
   * A regression pin on the older refusal, and deliberately NOT a proof about the order of the two.
   *
   * This row was once claimed as evidence that the destructive refusal is asked first. No input can
   * show that: `REFUSED_EXECUTABLES` and `CONSTANT_EXECUTABLES` share no member, so no command
   * exists for which both could fire and swapping the two operands changes nothing observable.
   * Measured, not reasoned: with the vacuity refusal unwired entirely, `rm -rf workspace` was still
   * refused with 'changes this computer' and this row stayed green - which is the definition of a
   * row that is not testing the join. What it does pin is worth keeping: adding a second refusal in
   * front of the first did not swallow it, and the reason the model reads still names the worse
   * fact rather than the emptier one.
   */
  it('still names the destructive fact, so the newer refusal did not swallow the older one', () => {
    const parsed = parse({ ...command, executable: 'bash', args: ['-lc', 'rm -rf workspace'] });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain('changes this computer');
  });
});

/**
 * The three-way reading of a result, and the coupling that keeps it true.
 *
 * `AcceptanceResult` has one boolean for two different facts: the check said no, and the harness
 * never got an answer. `acceptanceObservation` separates them by reading the two openings
 * `acceptance-runner.ts` writes, which is a string coupling across a file boundary - so half of
 * this block is unit cases and the other half drives the REAL `acceptanceChecks` and reads the
 * detail it actually produces. Without the second half a reworded runner would turn every
 * `did_not_run` into `failed` with the whole suite green.
 */
describe('a check that could not run, told apart from one that failed', () => {
  const result = (passed: boolean, detail: string): AcceptanceResult => ({
    id: 'c1',
    label: 'the suite passes',
    passed,
    detail
  });

  it('reads a pass as a pass whatever the detail says', () => {
    expect(acceptanceObservation(result(true, 'exit 0'))).toBe('passed');
    expect(
      acceptanceObservation(
        result(true, 'exit 0, from garden running this same command after the last change')
      )
    ).toBe('passed');
  });

  it('reads an answer the harness got back as a failure, commands and artifacts alike', () => {
    for (const detail of [
      'exit 1 (expected 0): 3 tests failed',
      'exit 0, but the output does not contain "OK": nothing',
      'workspace/out.csv does not exist',
      'workspace/out.csv is a directory, not a file',
      '312 bytes (needs at least 4096)',
      'renders as 4 pages, expected 3'
    ])
      expect(acceptanceObservation(result(false, detail)), detail).toBe('failed');
  });

  /**
   * The half `detail.startsWith('exit ')` would get silently wrong. An artifact check never writes
   * an exit code, so that rule reads every missing deliverable as a check the harness had not run -
   * which is the same folding this function exists to prevent, pointed the other way.
   */
  it('does not read a missing exit code as a check that never ran', () => {
    expect(acceptanceObservation(result(false, 'workspace/report.pdf does not exist'))).not.toBe(
      'did_not_run'
    );
  });

  it('reads the harness failing to observe as neither', () => {
    for (const detail of [
      'the check could not run: runner refused (503)',
      'the check could not run: the acceptance suite ran out of time after 900s',
      'timed out after 900s running pytest'
    ])
      expect(acceptanceObservation(result(false, detail)), detail).toBe('did_not_run');
  });
});

/**
 * The same classifier held against the file that actually writes the strings.
 *
 * `acceptanceChecks` is the sole writer of `AcceptanceResult.detail`. This drives it over the four
 * shapes that matter with a stubbed runner, and asserts what `acceptanceObservation` makes of what
 * comes back - so the day somebody rewords a detail in `acceptance-runner.ts`, this goes red rather
 * than the completion status quietly changing what it means.
 */
describe('what the runner actually writes, read by the classifier', () => {
  const key = new Uint8Array(32).fill(7);
  const task = {
    id: '22222222-2222-4222-8222-222222222222',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    userId: '33333333-3333-4333-8333-333333333333'
  } as unknown as TaskRecord;

  const record = (checks: readonly AcceptanceCheck[]): AcceptanceRecord => ({
    checks,
    revisions: 1,
    declaredAtStep: 1
  });

  const commandCheck = (id: string): AcceptanceCheck => ({
    id,
    kind: 'command',
    label: `command ${id}`,
    executable: 'pytest',
    args: ['-q'],
    cwd: 'workspace',
    expectExit: 0,
    timeoutSeconds: 900
  });

  /** The runner and the store, with `call` answering however the case needs it to. */
  const deps = (call: (path: string) => unknown): AcceptanceRunnerDeps =>
    ({
      store: {
        appendTaskEvent: async () => ({ id: 'event' })
      } as unknown as DataStore,
      runner: {
        call: async (
          _workspaceId: string,
          _taskId: string,
          _scope: string | string[],
          path: string
        ) => call(path)
      } as unknown as AgentRunnerClient,
      withLeaseRenewal: async (_task: TaskRecord, operation: () => Promise<unknown>) => operation(),
      withCancellationWatch: async (_task: TaskRecord, operation: () => Promise<unknown>) =>
        operation()
    }) as unknown as AcceptanceRunnerDeps;

  const observe = async (
    checks: readonly AcceptanceCheck[],
    call: (path: string) => unknown
  ): Promise<AcceptanceObservation[]> =>
    (await acceptanceChecks(deps(call), task, key, record(checks), { purpose: 'finish' })).map(
      acceptanceObservation
    );

  it('publishes the command beside the label for a command check, and nothing for an artifact', async () => {
    const exec = () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false });
    const results = await acceptanceChecks(deps(exec), task, key, record([commandCheck('c1')]), {
      purpose: 'finish'
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.command).toBe('pytest -q');
    const missing = await acceptanceChecks(
      deps(() => {
        throw new Error('no such file');
      }),
      task,
      key,
      record([{ id: 'a1', kind: 'artifact', label: 'the file', path: 'workspace/x', minBytes: 1 }]),
      { purpose: 'finish' }
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.command).toBeUndefined();
  });

  it('reads a command the computer answered as passed or failed', async () => {
    const exec = (exitCode: number) => () => ({
      exitCode,
      stdout: '',
      stderr: '3 tests failed',
      durationMs: 1,
      timedOut: false
    });
    expect(await observe([commandCheck('c1')], exec(0))).toEqual(['passed']);
    expect(await observe([commandCheck('c1')], exec(1))).toEqual(['failed']);
  });

  it('reads a runner that refused the request as a check that never ran', async () => {
    expect(
      await observe([commandCheck('c1')], () => {
        throw new Error('runner request failed (503)');
      })
    ).toEqual(['did_not_run']);
  });

  it('reads a wedged command as a check that never ran, not as one that said no', async () => {
    expect(
      await observe([commandCheck('c1')], () => ({
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 900_000,
        timedOut: true
      }))
    ).toEqual(['did_not_run']);
  });

  /**
   * The artifact side, which is the case the `startsWith('exit ')` rule got wrong: the harness
   * looked, the file is not there, and that is an observation about the job rather than about the
   * computer.
   */
  it('reads a deliverable that is not there as a failure the harness observed', async () => {
    const missing: AcceptanceCheck = {
      id: 'a1',
      kind: 'artifact',
      label: 'the report exists',
      path: 'workspace/report.md',
      minBytes: 10
    };
    expect(await observe([missing], () => ({ entries: [] }))).toEqual(['failed']);
  });

  it('reads the suite running out of its own clock as a check that never ran', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00Z'));
    try {
      const observations = await observe([commandCheck('c1'), commandCheck('c2')], () => {
        // The first check spends the whole suite deadline, so the second one never starts.
        vi.setSystemTime(Date.now() + (ACCEPTANCE_SUITE_DEADLINE_SECONDS + 1) * 1_000);
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
      });
      expect(observations).toEqual(['passed', 'did_not_run']);
    } finally {
      vi.useRealTimers();
    }
  });
});

/*
 * A label is free text the model writes, and it is what the owner is shown as proved: it is the
 * line in `Acceptance checks: N of M passed` and the line in the completion's evidence. A live run
 * declared the label below over a command that only counted rows, the row count was right, and a
 * sentence whose own arithmetic is wrong (30 x 3 is not 54) went to the owner stamped verified
 * inside the PDF it described. Every number a label claims has to be a number the command tests.
 */
describe('a label that claims a number the command never tests', () => {
  const command = (label: string, script: string, extra: Record<string, unknown> = {}) =>
    parse({ kind: 'command', label, executable: 'bash', args: ['-lc', script], ...extra });
  const countsRows = '[ "$(tail -n +2 workspace/data.csv | wc -l)" -eq 54 ]';
  const reasonOf = (parsed: ReturnType<typeof parse>): string => (parsed.ok ? '' : parsed.reason);

  it('refuses the label that was stamped verified over a command testing one of its three numbers', () => {
    const parsed = command(
      'data.csv has header plus exactly 54 data rows (30 months \u00d7 3 products)',
      countsRows
    );
    expect(parsed.ok).toBe(false);
    const reason = reasonOf(parsed);
    // Names the numbers the command does not test, and only those.
    expect(reason).toContain('claims 30 and 3');
    expect(reason).not.toMatch(/\b54\b/);
    // And says what to do about it: test it, or take it out of the label.
    expect(reason).toContain('test');
    expect(reason).toContain('drop it from the label');
  });

  it('accepts a label whose every number the command tests, and a label with none', () => {
    expect(command('data.csv has header plus exactly 54 data rows', countsRows).ok).toBe(true);
    expect(command('the data file has the rows the report describes', countsRows).ok).toBe(true);
  });

  it('matches by value, so 3 is not inside 30, 1.5 is not inside 11.5 and -5 is not 5', () => {
    expect(reasonOf(command('3 products', '[ "$(wc -l < x)" -eq 30 ]'))).toContain('claims 3');
    expect(command('30 products', '[ "$(wc -l < x)" -eq 30 ]').ok).toBe(true);
    for (const seen of ['11.5', '1', '15'])
      expect(reasonOf(command('1.5 seconds', `[ "$(cat t)" = ${seen} ]`)), seen).toContain(
        'claims 1.5'
      );
    // The same quantity in another spelling is the same quantity.
    for (const seen of ['1.5', '1.50'])
      expect(command('1.5 seconds', `[ "$(cat t)" = ${seen} ]`).ok).toBe(true);
    for (const seen of ['5', '-50', '15'])
      expect(reasonOf(command('-5 degrees', `[ "$(cat t)" = ${seen} ]`)), seen).toContain(
        'claims -5'
      );
    expect(command('-5 degrees', '[ "$(cat t)" = -5 ]').ok).toBe(true);
  });

  it('reads a count by value, so 3 is found in 3.0 and in 3s, and 1,000 in 1000', () => {
    expect(command('3 seconds', 'sleep 3.0').ok).toBe(true);
    expect(command('3 seconds', 'sleep 3s').ok).toBe(true);
    expect(command('1,000 rows', '[ "$(wc -l < x)" -eq 1000 ]').ok).toBe(true);
  });

  it('leaves a date, a percentage, an issue number, a fraction, a multiplier and a time alone, because none is a count', () => {
    expect(command('report dated 2026-09-03 exists', 'test -f workspace/report.pdf').ok).toBe(true);
    expect(command('100% of tests pass', 'pytest -q').ok).toBe(true);
    expect(command('issue #3 is fixed', 'pytest -q').ok).toBe(true);
    expect(command('3/4 of the fixtures pass', 'pytest -q').ok).toBe(true);
    expect(command('the run starts at 12:30', 'make check').ok).toBe(true);
    // One reading for the letter and the sign: a multiplier is a measurement in either spelling.
    expect(command('3x faster than the baseline', './bench.sh').ok).toBe(true);
    expect(command('3\u00d7 faster than the baseline', './bench.sh').ok).toBe(true);
    // A misprint is not a claim of 0000.
    expect(command('1,0000 rows', '[ "$(wc -l < x)" -eq 1000 ]').ok).toBe(true);
  });

  it('does not let a name in the command stand for a count in the label', () => {
    const named = (label: string, executable: string, args: string[]) =>
      reasonOf(parse({ kind: 'command', label, executable, args }));
    const countsRowsInPython = ['-c', 'import sys; sys.exit(open("x").read().count("\\n") != 54)'];
    // The interpreter's own name is not the command testing 3; the 54 it does test is not named.
    const refusal = named('54 data rows (3 products)', 'python3', countsRowsInPython);
    expect(refusal).toContain('claims 3');
    expect(refusal).not.toMatch(/\b54\b/);
    expect(named('256 hashes match', 'sha256sum', ['-c', 'sums'])).toContain('claims 256');
    expect(named('run 3 finished', 'grep', ['-q', 'done', 'workspace/run3/log'])).toContain(
      'claims 3'
    );
    // A number behind a short option is the tool being told it, and counts.
    expect(
      parse({ kind: 'command', label: '54 lines', executable: 'head', args: ['-n54', 'f'] }).ok
    ).toBe(true);
  });

  it('counts the expected output and the expected exit as tested, because the harness compares them', () => {
    expect(
      parse({
        kind: 'command',
        label: 'the count is 54',
        executable: 'wc',
        args: ['-l', 'workspace/data.csv'],
        expectStdoutContains: '54'
      }).ok
    ).toBe(true);
    expect(
      parse({
        kind: 'command',
        label: 'the linter exits 2',
        executable: 'eslint',
        args: ['.'],
        expectExit: 2
      }).ok
    ).toBe(true);
  });

  it('reads a number glued to a word as a name, not a claim, and a thousands separator as one number', () => {
    expect(command('the utf8 build of v2.1 on py3 passes', 'make check').ok).toBe(true);
    expect(command('1,000 rows', '[ "$(wc -l < x)" -eq 1000 ]').ok).toBe(true);
  });

  it('leaves artifact checks alone, because a path and a size are not a command', () => {
    expect(
      parse({
        kind: 'artifact',
        label: 'the deck is 12 slides',
        path: 'workspace/deck.pptx',
        minBytes: 1
      }).ok
    ).toBe(true);
  });
});

describe('what the owner is shown as proved carries the command beside the label', () => {
  const check = {
    id: 'check-2',
    kind: 'command' as const,
    label: 'data.csv has header plus exactly 54 data rows',
    executable: 'bash',
    args: ['-lc', '[ "$(tail -n +2 workspace/data.csv | wc -l)" -eq 54 ]'],
    cwd: 'workspace',
    expectExit: 0,
    timeoutSeconds: 300
  };
  const ran = 'bash -lc [ "$(tail -n +2 workspace/data.csv | wc -l)" -eq 54 ]';

  it('in the completion evidence line', () => {
    const [line] = acceptancePassedEvidence([
      { id: check.id, label: check.label, passed: true, detail: 'exit 0', command: ran }
    ]);
    expect(line).toContain(check.label);
    expect(line).toContain(ran);
    expect(line).toContain('exit 0');
  });

  it('in a result answered from a run garden already watched', () => {
    const observed = new Map([[commandFingerprint(check), 0]]);
    expect(acceptanceAlreadyObserved(check, observed)?.command).toBe(ran);
  });
});
