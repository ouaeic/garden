/**
 * The acceptance record: what would prove this job is done, written before the work and run by the
 * harness after it.
 *
 * The completion contract that existed before this file checked provenance - that a cited tool call
 * exists, succeeded, and came after the last change. Every one of those is a check on identity and
 * ordering; none of them reads the result, and the harness never executed anything of its own. So
 * the cheapest way to finish a build was to read back a file you had just written and cite it, and
 * "the service starts and serves /health" citing a file_read was accepted.
 *
 * That is exactly the setting the published record says does not work: a model asserting its own
 * correctness in its own context with no external signal (Huang et al., ICLR 2024). The same models
 * do correct themselves once a tool supplies the critique (CRITIC), and the harness mechanism that
 * carries long-horizon benchmarks is a verifier that runs after the agent says done and resumes the
 * session with its output.
 *
 * The division of labour is the whole design, and it is what keeps this from becoming a task mold:
 * the model writes the checks, in its own words, for whatever the job turns out to be - the harness
 * only insists that "done" means something it can execute, and executes it.
 */

import {
  COMMAND_RUNNERS,
  commandInterpreters,
  effectiveCommands,
  inlineScriptBody,
  isDestructiveScript
} from './command-classification.js';
import { textValue } from './values.js';
import { JsonProof } from '@garden/contracts';

/** A command the harness runs itself, with the arguments fixed before the work started. */
export interface AcceptanceCommandCheck {
  readonly id: string;
  readonly kind: 'command';
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly expectExit: number;
  readonly expectStdoutContains?: string;
  readonly timeoutSeconds: number;
}

/**
 * What the harness measures on the pages of a document, rather than on the bytes of a file.
 *
 * A byte count is the whole vocabulary an artifact check had, and every visual deliverable this
 * product leads with - the deck that must not overflow its slide, the CV that must stay one page -
 * was proved by being bigger than four kilobytes. A deck with text spilling off slide four passes
 * that comfortably, so the only witness to how it looks was the model that made it.
 *
 * Two measurements, chosen because they are the failures that are both common in a generated
 * document and provable from the render without anything looking at it: how many pages it comes to,
 * and whether any text was cut off at the edge of its page. The runner renders the file as it
 * stands at the moment finish is called - the .pptx itself, not a proof PDF from earlier in the
 * turn - so a stale render cannot pass this.
 */
export interface AcceptanceRenderClause {
  /** The exact page count the job asked for. Absent when nobody asked for one. */
  readonly expectPages?: number;
  /** How far inside the page edge text has to stay; the edge itself by default. */
  readonly marginPoints: number;
}

/**
 * Every extension that has a rendered page at all.
 *
 * The runner is the authority and refuses anything it cannot render, in its own words. This list
 * exists so the refusal arrives when the model declares the check rather than at finish, which is
 * the difference between a correction that costs a sentence and one that costs the whole turn.
 */
const RENDERABLE_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'odt',
  'odp',
  'ods',
  'doc',
  'ppt',
  'xls',
  'rtf'
]);

/** A file that must exist, and optionally be at least this big, when the turn claims to be done. */
export interface AcceptanceArtifactCheck {
  readonly id: string;
  readonly kind: 'artifact';
  readonly label: string;
  readonly path: string;
  readonly minBytes: number;
  /** Present when the file is a document and the claim is about its pages, not its size. */
  readonly render?: AcceptanceRenderClause;
  readonly json?: JsonProof;
}

export type AcceptanceCheck = AcceptanceCommandCheck | AcceptanceArtifactCheck;

export interface AcceptanceRecord {
  readonly checks: readonly AcceptanceCheck[];
  /** Every version the model has declared, oldest first, so weakening a test is visible. */
  readonly revisions: number;
  readonly declaredAtStep: number;
}

export interface AcceptanceResult {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  /** What the harness saw: an exit code, a size, or the reason the check could not run at all. */
  readonly detail: string;
  /**
   * The command that was run, for a command check, so the record says what was proved and not
   * only what the model called it. A label is free text; `passed: true` beside it is the harness
   * vouching for the command, and an owner reading "54 data rows (30 months x 3 products) passed"
   * can only tell which half of that the computer checked if the command is printed beside it.
   */
  readonly command?: string;
}

/**
 * What the harness actually learned from one check, which is three answers rather than the two
 * `passed` can hold.
 *
 * `passed: false` is written for two different facts and they are not the same news. A command that
 * exited 1 is the computer answering: the harness ran the check and the check says no. A command
 * that timed out, or that never started because the runner refused or the suite's own clock ran
 * out, is the harness failing to observe anything at all - and the post-edit diagnostics work in
 * this tree settled the rule for that case already: a check that could not run reads as silence,
 * not as health, and not as a verdict either.
 *
 * Both are still failures for the purpose of refusing a finish, and nothing here changes that: a
 * job whose proof cannot be run is not a proven job. The distinction is for what the completion
 * then *says*, where "your test failed" and "garden never got to run your test" are different
 * things to tell an owner.
 *
 * Read off `detail`, because that is the only place the difference exists. Adding a field to
 * `AcceptanceResult` would be the honest shape and it needs `acceptance-runner.ts`, which writes
 * every one of these; this reads what that file already writes, and the two openings below are
 * exactly its two "I never saw an answer" branches.
 */
export type AcceptanceObservation = 'passed' | 'failed' | 'did_not_run';

/**
 * The two openings `acceptance-runner.ts` writes when it never got an answer.
 *
 * Exported so the coupling is one grep rather than a guess, and pinned by a test in
 * `acceptance.test.ts` that drives the real `acceptanceChecks` over a refusing runner, a wedged
 * command and a suite past its deadline. That test is the thing that keeps this from rotting: a
 * reworded detail in the runner turns this classifier's answer from `did_not_run` into `failed`
 * silently, and silence is the failure mode the whole three-way split exists to remove.
 *
 * @see acceptanceChecks in `acceptance-runner.ts`, the sole writer of `AcceptanceResult.detail`.
 */
export const ACCEPTANCE_NEVER_RAN_PREFIX = 'the check could not run: ';
export const ACCEPTANCE_TIMED_OUT_PREFIX = 'timed out after ';

/**
 * The three-way reading of one result.
 *
 * Deliberately NOT `detail.startsWith('exit ')`, which is the rule `turn/finish.ts` used to carry
 * inline for its dead-end memories and which is only correct there because that flatMap has already
 * dropped every check that is not a command. An artifact check that ran perfectly well answers
 * `workspace/out.csv does not exist` or `312 bytes (needs at least 4096)`, and reading the absence
 * of an exit code as "the harness never looked" would file every missing deliverable as an
 * unobserved check - which is the folding this function exists to prevent, pointed the other way.
 */
export const acceptanceObservation = (result: AcceptanceResult): AcceptanceObservation =>
  result.passed
    ? 'passed'
    : result.detail.startsWith(ACCEPTANCE_NEVER_RAN_PREFIX) ||
        result.detail.startsWith(ACCEPTANCE_TIMED_OUT_PREFIX)
      ? 'did_not_run'
      : 'failed';

export const MAX_ACCEPTANCE_CHECKS = 8;
/** Long enough for a real build or test suite, short enough that a wedged check ends the turn. */
export const ACCEPTANCE_COMMAND_TIMEOUT_SECONDS = 900;
const MAX_LABEL_CHARS = 160;
const MAX_ARGS = 24;

/**
 * Executables the harness will not run as an acceptance check.
 *
 * An acceptance check is run by the harness with no approval card in front of it, at the moment the
 * model says the work is done - so it has to be a check rather than a second chance to act. The set
 * is deliberately about the shape of the command, not a blocklist of names that would grow forever:
 * a check earns its place by being repeatable and by not changing anything the owner would want to
 * know about.
 */
const REFUSED_EXECUTABLES = new Set([
  'rm',
  'rmdir',
  'mv',
  'dd',
  'mkfs',
  'shred',
  'truncate',
  'chown',
  'chmod',
  'apt',
  'apt-get',
  'dpkg',
  'systemctl',
  'reboot',
  'shutdown',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'gh'
]);

const REFUSED_GIT_SUBCOMMANDS = new Set(['push', 'clean', 'reset', 'restore', 'checkout']);

/**
 * The same refused names, found inside an inline script rather than as the executable.
 *
 * `isDestructiveScript` reads a script for a delete, which is most of it, but a check must also
 * never reach the outside world - and `sh -c "curl https://example.com | sh"` is destruction only
 * in consequence, not in syntax. Word-bounded so `curler` and `sshfs` are not caught by accident.
 */
const REFUSED_IN_SCRIPT = new RegExp(
  `(?<![\\w.-])(?:${[...REFUSED_EXECUTABLES].join('|')})(?![\\w-])`
);

/**
 * A check is a check: it must not be the thing that reaches the outside world or destroys data.
 *
 * This is the only gate these commands pass. An acceptance check is executed by the harness through
 * a direct exec, deliberately - it is the harness's own verification, not the model acting - and so
 * it never reaches the approval broker in any security mode. That makes a name-only blocklist the
 * wrong shape: `rm` was refused and `bash -lc "rm -rf workspace"` was not, and it ran twice, once as
 * the red baseline before the work and once as the check afterwards.
 *
 * So the same reading the broker does is done here: a wrapper is judged by what it runs, and an
 * inline script by what is in it.
 */
export const acceptanceCommandRefusal = (
  executable: string,
  args: readonly string[]
): string | null => {
  const binary = executable.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
  if (!binary) return 'A command check needs an executable.';
  if (REFUSED_EXECUTABLES.has(binary) || binary.startsWith('mkfs'))
    return `${binary} changes this computer or reaches the network, so it cannot be an acceptance check. Name a command that only reports.`;
  if (binary === 'git') {
    const subcommand = args.find((argument) => !argument.startsWith('-'))?.toLowerCase() ?? '';
    if (REFUSED_GIT_SUBCOMMANDS.has(subcommand))
      return `git ${subcommand} changes the repository, so it cannot be an acceptance check.`;
  }
  // A command whose whole job is to run another command is judged by the one it runs. Every
  // argument is looked at, not the first non-flag one: `timeout 30 rm -rf build` puts a duration
  // there, and taking the first token would have read the duration as the command.
  if (COMMAND_RUNNERS.has(binary)) {
    const refused = args
      .map((argument) => argument.split('/').filter(Boolean).pop()?.toLowerCase() ?? '')
      .find((name) => REFUSED_EXECUTABLES.has(name) || name.startsWith('mkfs'));
    if (refused)
      return `${binary} ${refused} changes this computer or reaches the network, so it cannot be an acceptance check. Name a command that only reports.`;
  }
  // An interpreter handed a script inline is judged by the script. Both halves are needed: the
  // shared destructive reading catches a delete however it is written, and the refused-name scan
  // catches reaching the network, which a check must never do and which nothing else here sees.
  if (commandInterpreters.has(binary)) {
    const body = inlineScriptBody(args);
    if (body && isDestructiveScript(body))
      return `this ${binary} script changes this computer, so it cannot be an acceptance check. Name a command that only reports.`;
    const named = body && REFUSED_IN_SCRIPT.exec(body)?.[0];
    if (named)
      return `this ${binary} script runs ${named}, which changes this computer or reaches the network, so it cannot be an acceptance check. Name a command that only reports.`;
  }
  return null;
};

/**
 * Executables whose exit status and whose output are decided by their own arguments and by nothing
 * else on this computer.
 *
 * Membership is that sentence rather than a list of names somebody disliked, and it is checkable:
 * no state of the workspace can change what any of these six does. `pwd`, `date`, `uname` and
 * `whoami` are deliberately NOT here - they read the box, so a check on what they print is at least
 * a check on something.
 */
const CONSTANT_EXECUTABLES = new Set(['true', 'false', ':', 'echo', 'printf', 'yes']);

/**
 * A pattern the filesystem answers rather than the command. `[` is a character class.
 *
 * Not `{`: brace expansion is done by the shell out of the brace alone and never reads a directory,
 * so `echo {a,b}` prints `a b` on every computer there is and is constant in exactly the sense this
 * file means.
 */
const GLOB_METACHARACTER = /[*?[]/;

/**
 * The token with every quoted span removed, so only text the shell would still act on is left.
 *
 * The tokens `effectiveCommands` returns keep their quotes - measured: the script `echo 'ok*'` comes
 * back as `["echo", "'ok*'"]` - which is the only reason the distinction below is available at all.
 * A backslash-escaped `\*` is NOT understood and reads as a live glob, so it is treated as expanded;
 * that errs toward accepting the check, which is the side to err on, because a false refusal here is
 * an outage on honest work and a false acceptance is only this bound not firing.
 */
const unquotedText = (token: string): string =>
  token.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');

/**
 * Whether anything reads this call's arguments before the command is handed them.
 *
 * A glob is only a question for the filesystem when something expands it, and for an acceptance
 * check that is a shell or nothing: the runner spawns one with `shell: false`
 * (services/workspace-runner/src/execution.ts:846), so the bare declaration
 * `{executable: 'echo', args: ['workspace/*.png']}` hands `echo` the pattern itself and prints it
 * back on every computer there is. That check is constant in exactly the sense this file means and
 * is refused; `bash -lc 'echo workspace/*.png'` is expanded before `echo` runs and is not. Without
 * this question the two were read as one, which put the same untrue sentence in front of the model
 * that the glob case was repaired to take out of it.
 *
 * The wrapped spelling is asked too, because `timeout 30 bash -lc …` still runs a shell. The set is
 * the one `effectiveCommands` uses to decide a script was read at all, so it also says yes to
 * `python` and `node`, which do not glob - overbroad in the direction of accepting the check, and
 * unreachable in practice, because a constant head only ever comes out of a script this reads as
 * shell.
 */
const expandedBeforeItRan = (executable: string, args: readonly string[]): boolean => {
  const name = (token: string): string =>
    token.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
  const head = name(executable);
  return (
    commandInterpreters.has(head) ||
    (COMMAND_RUNNERS.has(head) && args.some((argument) => commandInterpreters.has(name(argument))))
  );
};

/**
 * A check that no state of this computer can fail, refused at the moment it is declared.
 *
 * The red baseline in `declareAcceptance` is the only thing in garden that ever falsifies a check -
 * it runs the record against the job before the work and refuses one where nothing fails - and it
 * is asked only `if (!state.mutated)`. The hold that demands a record at all fires on
 * `state.mutatedBeyondProse`. So on the ordinary coding turn, where the model writes the code and is
 * then held for a definition of done, the record is declared after the change and no baseline runs
 * against it: `echo` was refused when declared first and accepted in silence when declared second.
 * This asks the same question the baseline asks without running anything, so it reaches both paths.
 *
 * It is the declaration-side half of the SWE-bench 5.0.0 grading fix, which the standing research
 * records as "a patch can no longer pass by printing its own PASSED lines"
 * (docs/design/research-2026-08-25/benchmarks.md §10). That is the evidence the shape is real rather
 * than imagined: it was live in the most-cited grader in the field until 2026-08-17.
 *
 * WHAT IT DOES NOT DO, because a reader will assume otherwise. It does not decide whether a check is
 * a good check; only whether the workspace has any say in the answer. It reads the shell, so
 * `python -c "print('ok')"` and `node -e "console.log('ok')"` are NOT caught - reading those needs a
 * second language, and the shell is the spelling the catalogue tells the model to reach for. And it
 * is not a security boundary: a model that wants to fake a check can write the same echo into a file
 * and name the file. What it catches is the cheapest way to satisfy the gate, which is the one a
 * model takes when it is not trying to cheat so much as trying to be done.
 *
 * Every command the call will really run has to be constant for the refusal to fire, so the honest
 * shape that reads most like this one - `bash -lc "test -f workspace/out.pdf && echo ok"` - is
 * accepted, because `test` is where the answer comes from and `echo` only reports it. A call whose
 * script `effectiveCommands` cannot read comes back as no commands at all, and that is treated as
 * unknown rather than as constant: this refuses only what it can name.
 *
 * An unquoted glob is the same case wearing a different coat, and it used to be refused wrongly.
 * `echo workspace/out/*.png` prints the file names when the thumbnails are there and the literal
 * pattern when they are not, so the workspace does decide the answer - the shell read it before the
 * command ever ran - and the sentence this function returns was false in a case it reached. It was
 * also refusing `echo workspace/*.jpg` while accepting
 * `for f in workspace/*.jpg; do echo "$f"; done`, which is the same check in two spellings. So an
 * argument carrying a live glob turns the refusal off - live meaning there is a shell to expand it,
 * which is a question this asks rather than assumes. That widens the evasion by one spelling -
 * `bash -lc "echo ok*"` now walks past, while `echo 'ok*'` is still refused because the quotes
 * survive tokenisation - and that is accepted in a rule this comment already says is not a security
 * boundary.
 */
export const acceptanceVacuousRefusal = (
  executable: string,
  args: readonly string[]
): string | null => {
  const commands = effectiveCommands({ executable, args: [...args] });
  if (!commands.length) return null;
  // Lowered here because the sibling refusal this one is chained to lowers its own binary, and two
  // adjacent guards disagreeing about the same token is how the next reader introduces a bug: with
  // the head read as written, `ECHO ok` was accepted and `echo ok` refused. Never a false pass on a
  // Linux workspace - `ECHO` is not on PATH, so the check would exit 127 - which is why it was a
  // spelling inconsistency rather than a hole, and it is fixed as one.
  const heads = commands.map(([head = '']) => head.toLowerCase());
  if (!heads.every((head) => CONSTANT_EXECUTABLES.has(head))) return null;
  // The shell, not the command, is what read the workspace when an argument is a live glob - so this
  // is off unless a shell is what runs the check. See the paragraph above for what it opens and why
  // that is the right side to be wrong on.
  if (
    expandedBeforeItRan(executable, args) &&
    commands.some((command) =>
      command.slice(1).some((token) => GLOB_METACHARACTER.test(unquotedText(token)))
    )
  )
    return null;
  const named = heads[0] ?? '';
  return `${named} answers the same way whatever is in the workspace, so this check cannot tell the finished job from the one nobody started. Name a check the work decides: the command that builds or tests it, the extraction that shows the file says what it should, or an artifact check on the file that has to be there.`;
};

const normalisedCwd = (value: unknown): string => {
  const cwd = textValue(value, 'workspace').trim() || 'workspace';
  return cwd.slice(0, 400);
};

const checkId = (index: number, kind: string): string => `${kind}-${index + 1}`;

/** The command a check runs, in the spelling the owner reads it in everywhere it is shown. */
export const acceptanceCommandText = (check: AcceptanceCommandCheck): string =>
  [check.executable, ...check.args].join(' ');

/** The field a result carries for a command check, and nothing for an artifact. */
export const resultCommand = (check: AcceptanceCheck): Pick<AcceptanceResult, 'command'> =>
  check.kind === 'command' ? { command: acceptanceCommandText(check) } : {};

/**
 * A number a label claims: a count, standing on its own.
 *
 * Read as one only when nothing touches it but whitespace, a bracket, a quote or the punctuation
 * of a sentence. A digit run wearing anything else is not a count and is not read: a letter makes
 * a name (`utf8`, `py3`, `sha256`), a second number joined by `-`, `/`, `:` or `.` makes a date, a
 * fraction, a time or a version (`2026-09-03`, `3/4`, `12:30`, `v2.1`, `1.2.3`), and a symbol makes
 * a measurement or an id (`100%`, `3x` and `3×` alike, `#3`, `$5`, `30°`). Each of those is the
 * model describing the work, and none is the quantity a command compares a count against, which is
 * the only claim this rule holds a label to. A leading minus is part of the number when nothing
 * precedes it, so `check-2` claims nothing and `-5 degrees` claims minus five; a decimal is one
 * token; a thousands separator is kept, so `1,000` is one claim and the misprint `1,0000` is none.
 */
const CLAIMED_NUMBER = /(?<=^|[\s("'[])-?\d+(?:,\d{3})*(?:\.\d+)?(?=$|[\s)"'\]]|[,;:.!?](?!\d))/g;

/**
 * A number the check text tests, read permissively: any digit run that is not the tail of a name.
 *
 * `python3`, `sha256sum`, `utf8` and `workspace/run3/` are names, and a name in the command is not
 * the command testing anything, so a digit run glued to a word character on its left is passed
 * over - except behind a short option, where `-n54` is how a tool is told 54. Everything else
 * counts: `=54`, `$3`, `3s`, `3.0`. That includes a number the command only mentions - `grep -m 3`
 * supplies a 3 without comparing one - because telling a mention from a comparison means parsing
 * the shell, and this side is deliberately the one that is wrong towards acceptance.
 */
const TESTED_NUMBER =
  /(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?(?![\d,]?\d)|(?<=(?:^|\s)-[A-Za-z])\d+(?:\.\d+)?/g;

const numberValue = (spelling: string): number => Number(spelling.replace(/,/g, ''));

/**
 * The numbers a label claims that the command it is attached to never tests.
 *
 * A check is a label plus a command, and the label is what the owner reads: it is the line in
 * "Acceptance checks: N of M passed" and the line in the completion's evidence, stamped by the
 * harness. Nothing else holds the label to what the command proved, so a label that states a
 * derived quantity beside the one the command counts - "54 rows (30 months x 3 products)" over a
 * command that compares a row count with 54 - goes to the owner as verified with an untested claim
 * in it, and did, in a PDF that carried the arithmetic refuting its own subtitle.
 *
 * The rule is deliberately the narrowest thing that catches that: every count the label claims
 * must be a number the text the harness compares - the command, the expected output, and the
 * expected exit code - also holds. Matched by value and not by digits, so `3` is not found inside
 * `30` or `3.5` and is found in `3.0`, and `1,000` in `1000`. What is caught is the bare number
 * nothing in the check so much as spells. What walks past, each on purpose and each a cost on
 * honest work if it did not: a count written in words ("three products"); a number wearing a
 * unit, a symbol, a date or a ratio (see `CLAIMED_NUMBER`); a number the command mentions without
 * comparing (see `TESTED_NUMBER`); and every artifact check, where a path and a size are not a
 * command and the label is held to nothing - `12 slides` beside a page count of 10 is not read.
 * A false refusal is an outage on honest work; a false acceptance is only this bound not firing.
 */
export const untestedLabelNumbers = (label: string, tested: string): string[] => {
  const claimed = [...new Set(label.match(CLAIMED_NUMBER) ?? [])];
  if (!claimed.length) return [];
  const held = new Set((tested.match(TESTED_NUMBER) ?? []).map(numberValue));
  return claimed.filter((number) => !held.has(numberValue(number)));
};

/** The list the refusal names: `30`, `30 and 3`, `30, 3 and 90`. */
const namedNumbers = (numbers: readonly string[]): string =>
  numbers.length <= 1
    ? (numbers[0] ?? '')
    : `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;

/**
 * Why a command check's label cannot stand, or null when every number in it is one the command
 * tests. Returned at declaration, where a correction costs a sentence, rather than at finish.
 */
export const acceptanceLabelRefusal = (
  label: string,
  check: Pick<AcceptanceCommandCheck, 'executable' | 'args' | 'expectExit' | 'expectStdoutContains'>
): string | null => {
  const tested = [
    acceptanceCommandText(check as AcceptanceCommandCheck),
    check.expectStdoutContains ?? '',
    `exit ${check.expectExit}`
  ].join('\n');
  const untested = untestedLabelNumbers(label, tested);
  if (!untested.length) return null;
  return `the label claims ${namedNumbers(untested)} and the command never tests ${untested.length === 1 ? 'it' : 'them'}. Either make the command test the number - compare a count against it, or put it in expectStdoutContains - or drop it from the label. The label is what the user is shown as proved, so it may claim only what the command checks.`;
};

/** The largest page count worth naming; past it the number is a mistake rather than a document. */
const MAX_EXPECTED_PAGES = 5_000;
/** A margin wider than this is most of a slide, so it is a typo rather than a layout. */
const MAX_MARGIN_POINTS = 200;

/**
 * Reads a render clause, or says why this file cannot have one.
 *
 * A clause with neither field is still worth declaring and is accepted: it says the file renders,
 * that nothing on it was cut off at an edge, and that no page of it came out blank, which is three
 * facts a byte count does not carry.
 */
const parseRenderClause = (
  value: unknown,
  filePath: string
): { ok: true; render?: AcceptanceRenderClause } | { ok: false; reason: string } => {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'object' || Array.isArray(value))
    return { ok: false, reason: 'render must be an object.' };
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (!filePath.includes('.') || !RENDERABLE_EXTENSIONS.has(extension))
    return {
      ok: false,
      reason: `${filePath} has no rendered page, so there is nothing on it to measure. Drop render, or name the PDF or Office document you produce from it.`
    };
  const record = value as Record<string, unknown>;
  const pages = record.expectPages;
  if (pages !== undefined && (!Number.isInteger(pages) || Number(pages) < 1))
    return { ok: false, reason: 'render.expectPages must be a whole number of pages, at least 1.' };
  const margin = Number(record.marginPoints ?? 0);
  if (!Number.isFinite(margin) || margin < 0)
    return { ok: false, reason: 'render.marginPoints must be a distance in points, or left out.' };
  return {
    ok: true,
    render: {
      ...(pages === undefined ? {} : { expectPages: Math.min(MAX_EXPECTED_PAGES, Number(pages)) }),
      marginPoints: Math.min(MAX_MARGIN_POINTS, margin)
    }
  };
};

/**
 * Reads the model's declaration into checks the harness can run, or says exactly what is wrong.
 *
 * Refusals are returned rather than thrown because the caller answers them as a tool result: a
 * malformed acceptance record has to teach the model the shape, not end the turn.
 */
export const parseAcceptanceChecks = (
  value: unknown
): { ok: true; checks: AcceptanceCheck[] } | { ok: false; reason: string } => {
  if (!Array.isArray(value) || !value.length)
    return { ok: false, reason: 'checks must be a non-empty array.' };
  if (value.length > MAX_ACCEPTANCE_CHECKS)
    return {
      ok: false,
      reason: `At most ${MAX_ACCEPTANCE_CHECKS} checks. Name the ones that would actually fail if the work were wrong.`
    };
  const checks: AcceptanceCheck[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object')
      return { ok: false, reason: `Check ${index + 1} is not an object.` };
    const record = raw as Record<string, unknown>;
    const kind = textValue(record.kind);
    const label = textValue(record.label).trim().slice(0, MAX_LABEL_CHARS);
    if (!label)
      return { ok: false, reason: `Check ${index + 1} needs a label saying what it proves.` };
    if (kind === 'command') {
      const executable = textValue(record.executable).trim();
      const args = Array.isArray(record.args)
        ? record.args.slice(0, MAX_ARGS).map((argument) => textValue(argument))
        : [];
      // Two questions, asked in cost order: whether this command may be run at all, and whether
      // running it could tell anybody anything. The second is here rather than at finish for the
      // same reason the render clause is - a refusal at declaration costs a sentence, and the same
      // refusal at finish costs the whole turn.
      const refusal =
        acceptanceCommandRefusal(executable, args) ?? acceptanceVacuousRefusal(executable, args);
      if (refusal) return { ok: false, reason: `Check ${index + 1}: ${refusal}` };
      const expectExit = Number.isFinite(Number(record.expectExit))
        ? Math.trunc(Number(record.expectExit))
        : 0;
      const contains = textValue(record.expectStdoutContains).trim().slice(0, 400);
      // Third question, asked last because it is about the label rather than the command: a
      // number the label claims is a number the owner will read as proved.
      const labelRefusal = acceptanceLabelRefusal(label, {
        executable,
        args,
        expectExit,
        ...(contains ? { expectStdoutContains: contains } : {})
      });
      if (labelRefusal) return { ok: false, reason: `Check ${index + 1}: ${labelRefusal}` };
      checks.push({
        id: checkId(index, 'check'),
        kind: 'command',
        label,
        executable,
        args,
        cwd: normalisedCwd(record.cwd),
        expectExit,
        ...(contains ? { expectStdoutContains: contains } : {}),
        timeoutSeconds: Math.min(
          ACCEPTANCE_COMMAND_TIMEOUT_SECONDS,
          Math.max(1, Math.trunc(Number(record.timeoutSeconds)) || 300)
        )
      });
      continue;
    }
    if (kind === 'artifact') {
      const path = textValue(record.path).trim().slice(0, 400);
      if (!path) return { ok: false, reason: `Check ${index + 1} needs the path it expects.` };
      const render = parseRenderClause(record.render, path);
      if (!render.ok) return { ok: false, reason: `Check ${index + 1}: ${render.reason}` };
      const json = record.json === undefined ? undefined : JsonProof.safeParse(record.json);
      if (json && !json.success)
        return {
          ok: false,
          reason: `Check ${index + 1}: supply bounded equals, lengths or uniqueBy JSON assertions using JSON Pointers.`
        };
      if (json && render.render)
        return {
          ok: false,
          reason: `Check ${index + 1}: JSON assertions and page rendering need separate checks.`
        };
      checks.push({
        id: checkId(index, 'check'),
        kind: 'artifact',
        label,
        path,
        minBytes: Math.max(1, Math.trunc(Number(record.minBytes)) || 1),
        ...(json?.success ? { json: json.data } : {}),
        ...(render.render ? { render: render.render } : {})
      });
      continue;
    }
    return {
      ok: false,
      reason: `Check ${index + 1} has kind "${kind || 'none'}"; use "command" or "artifact".`
    };
  }
  return { ok: true, checks };
};

/**
 * The identity of a command, so "has garden already run exactly this?" is a lookup.
 *
 * Executable, arguments and working directory and nothing else: two calls that differ in any of
 * them are different commands, and the whole value of this is that a match means a match.
 */
export const commandFingerprint = (input: {
  executable: string;
  args: readonly string[];
  cwd: string;
}): string =>
  JSON.stringify([
    input.executable.trim(),
    input.args.map((argument) => String(argument)),
    input.cwd.trim() || 'workspace'
  ]);

/**
 * A check the harness has already run itself, after the last change, and watched pass.
 *
 * The acceptance record exists because a model asserting its own correctness proves nothing and an
 * external check does. That argument is about who ran the command, not about how many times: when
 * the model checks its own work through `shell` - which is how most of them check anything - the
 * process garden started is the same process, with the same arguments, in the same directory, on a
 * computer nothing has changed since. Running it a second time at finish observes the identical
 * fact and charges the owner a second build or a second test suite for it.
 *
 * Deliberately narrow, in three ways. Only an exact command match counts, so a check that differs
 * from what ran by one flag is run. Only a run at or after the evidence floor counts - the same
 * floor the completion contract uses, which is what "nothing has changed since" means here. And
 * only a pass is reused: a check that failed after the last change is worth one more look before it
 * refuses the turn, because a wrong refusal costs a whole further loop and a flake costs one
 * command. A check with an expected output is always run, because the output was not kept.
 */
export const acceptanceAlreadyObserved = (
  check: AcceptanceCheck,
  observed: ReadonlyMap<string, number>
): AcceptanceResult | null => {
  if (check.kind !== 'command' || check.expectStdoutContains) return null;
  const exitCode = observed.get(
    commandFingerprint({ executable: check.executable, args: check.args, cwd: check.cwd })
  );
  if (exitCode === undefined || exitCode !== check.expectExit) return null;
  return {
    id: check.id,
    label: check.label,
    passed: true,
    detail: `exit ${exitCode}, from garden running this same command after the last change`,
    command: acceptanceCommandText(check)
  };
};

/**
 * What a render clause promises, in the words the owner reads it in.
 *
 * Deliberately says what was measured rather than that it was measured: "no text past the page
 * edge" is a claim this computer can stand behind from the render, and "it looks right" is not.
 */
export const describeRenderClause = (render: AcceptanceRenderClause): string =>
  [
    render.expectPages === undefined
      ? 'renders'
      : `renders as exactly ${render.expectPages} page${render.expectPages === 1 ? '' : 's'}`,
    render.marginPoints > 0
      ? `with every word inside a ${render.marginPoints}pt margin`
      : 'with no text cut off at a page edge',
    'and no page blank'
  ].join(' ');

export const describeAcceptanceCheck = (check: AcceptanceCheck): string =>
  check.kind === 'command'
    ? `${check.id} (${check.label}): ${[check.executable, ...check.args].join(' ')}${
        check.expectStdoutContains ? ` — stdout must contain "${check.expectStdoutContains}"` : ''
      }`
    : `${check.id} (${check.label}): ${check.path} exists and is at least ${check.minBytes} bytes${
        check.render ? `, and ${describeRenderClause(check.render)}` : ''
      }${check.json ? `, JSON assertions ${JSON.stringify(check.json)}` : ''}`;

/** What the window is told after a declaration, so the model knows what it will be held to. */
export const acceptanceAcceptedResult = (record: AcceptanceRecord): string =>
  JSON.stringify({
    accepted: true,
    revision: record.revisions,
    checks: record.checks.map(describeAcceptanceCheck),
    note: 'The harness runs these itself when you call finish. finish is refused while any of them fails, so a check you cannot pass has to be changed in front of the user rather than ignored.'
  });

/**
 * The tool result a failing acceptance run pushes back into the window.
 *
 * It carries the command and the harness's own observation rather than a verdict, because the model
 * has to be able to act on it: an exit code and the first lines of stderr are what turn "it does not
 * work" into a next step.
 */
export const acceptanceFailureMessage = (
  results: readonly AcceptanceResult[],
  attempt: number,
  ceiling: number
): string => {
  const failed = results.filter((result) => !result.passed);
  return [
    `Finish refused (acceptance ${attempt} of ${ceiling}): ${failed.length} of ${results.length} of your own acceptance checks did not pass when the harness ran them.`,
    ...failed.map((result) => `- ${result.id} (${result.label}): ${result.detail}`),
    'Fix the work and call finish again. If a check was wrong, call set_acceptance again with the corrected checks - the user sees that you changed it.'
  ].join('\n');
};

/**
 * One line per check for the completion record, with the command in it where there was one: the
 * owner reads what was run beside what it was called, so a label can no longer stand for more
 * than its command proved.
 */
export const acceptancePassedEvidence = (results: readonly AcceptanceResult[]): string[] =>
  results.map(
    (result) =>
      `${result.id}: ${result.label} — ${result.command ? `ran ${result.command} — ` : ''}${result.detail}`
  );

/**
 * Whether a turn that has used its step budget may give itself another one instead of stopping.
 *
 * A turn ends at the step ceiling and hands back to the owner, and the handoff it writes says in as
 * many words that "the user can reply and you continue on this same computer with a fresh budget".
 * So a box with electricity, a saved window, an open plan and a machine-checkable definition of done
 * stops for no reason other than the interaction model saying a turn is a reply. On unattended work
 * - the kind the ceiling actually bites on - there is nobody to send that reply for hours.
 *
 * What makes continuing safe rather than runaway is that the harness, not the model, decides. The
 * acceptance record was written before the work and is executed by the harness, so "not done yet" is
 * a fact this function can be handed rather than the model's opinion of itself. Everything here is a
 * refusal; the caller supplies the facts and gets one sentence back saying which one stopped it, so
 * a turn that did not continue can always say why.
 *
 * The checks are ordered by what they cost the caller to establish, cheapest first, because the
 * expensive one - running the acceptance record again - is worth paying for only if everything free
 * has already said yes.
 */
export interface ContinuationInput {
  /** Whether the model ever declared what would prove this job done. No record, no continuation. */
  readonly hasAcceptance: boolean;
  /**
   * Whether that record was declared by this turn rather than carried in from an earlier one.
   *
   * The finish gate already refuses an inherited record, in as many words: it was passing before
   * this turn began, so whatever this turn just did, it is not evidence of it. The same is true
   * here and the consequence is worse - the renewal fires on the record *failing*, and an inherited
   * check that has started failing says this turn broke something an earlier one guaranteed, which
   * is a reason to stop and tell the owner rather than to hand the model another whole budget.
   */
  readonly acceptanceIsThisTurn: boolean;
  readonly continuationsUsed: number;
  readonly continuationCeiling: number;
  /** Successful tool calls this turn that changed something, counted with `turnWriteCount`. */
  readonly writes: number;
  readonly evidence?: number;
  /** What was true at the last ceiling this turn was let past; absent before the first one. */
  readonly mark?:
    | { readonly atStep: number; readonly writes: number; readonly evidence?: number }
    | undefined;
  readonly credits: number;
  readonly maxCredits: number;
  /**
   * Whether the harness has already spent its refusals on this turn - the finish it could not
   * ground, or the acceptance checks it could not pass. Computed by the caller because the ceilings
   * live with the loop that enforces them.
   */
  readonly refusalsExhausted: boolean;
  /** A turn parked on an approval card is the owner's move, not the machine's. */
  readonly awaitingApproval: boolean;
}

export type ContinuationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * How much of the task's compute allowance must remain before a turn renews its own step budget.
 *
 * A continuation buys steps, not money. Nothing about it raises `maxComputeCredits`, which the API
 * sizes at one step budget's worth of credits for the model actually chosen, so a self-continuing
 * turn is bounded by exactly the same allowance as one that stopped - it simply gets to spend the
 * remainder rather than leaving it. Renewing with almost none of that left would announce a
 * continuation and then hand off two steps later on the credit ceiling, which is worse for the owner
 * to read than stopping cleanly, so the renewal has to be worth having before it is taken.
 */
export const CONTINUATION_CREDIT_HEADROOM = 0.1;

export const turnWriteCount = (
  results: Readonly<Record<string, { success: boolean; mutating?: boolean }>> | undefined
): number =>
  Object.values(results ?? {}).filter((result) => result.success && result.mutating).length;

export const mayRenewStepBudget = (input: ContinuationInput): ContinuationVerdict => {
  if (input.continuationCeiling <= 0) return { ok: false, reason: 'continuing is switched off' };
  if (input.continuationsUsed >= input.continuationCeiling)
    return {
      ok: false,
      reason: `it has already renewed its own budget ${input.continuationsUsed} times`
    };
  const observedProgress = (input.evidence ?? 0) > (input.mark?.evidence ?? 0);
  if (!input.hasAcceptance && !(input.writes === 0 && observedProgress))
    return {
      ok: false,
      reason:
        'this turn never declared what would prove the job done, so nothing but the model could say it is unfinished'
    };
  if (input.hasAcceptance && !input.acceptanceIsThisTurn)
    return {
      ok: false,
      reason:
        'the only acceptance checks on record were declared by an earlier turn, so a failing one says this turn broke something rather than that it has not finished'
    };
  if (input.awaitingApproval)
    return { ok: false, reason: 'it is waiting on a decision only the user can make' };
  if (input.refusalsExhausted)
    return {
      ok: false,
      reason: 'the harness has already refused this turn as many times as it refuses anything'
    };
  // Both file changes and new observed evidence advance a task. Repeated reads do not.
  if (input.writes <= (input.mark?.writes ?? 0) && !observedProgress)
    return {
      ok: false,
      reason: input.mark
        ? `nothing has changed on this computer since step ${input.mark.atStep}`
        : 'this turn has not changed anything yet'
    };
  if (input.credits >= input.maxCredits * (1 - CONTINUATION_CREDIT_HEADROOM))
    return {
      ok: false,
      reason: 'too little of the task’s compute allowance is left to be worth it'
    };
  return { ok: true };
};

/**
 * What the window is told when the harness renews the budget rather than ending the turn.
 *
 * It carries the failing checks because that is the whole justification for spending more of the
 * owner's money: the model gets the harness's own observation of what is still not done, which is
 * the same feedback a refused finish gets and the only thing that makes the next budget different
 * from a repeat of the last one. The closing line is what stops a renewed turn treating the budget
 * as endless - the last one says so.
 */
export const stepBudgetRenewedNote = (input: {
  results: readonly AcceptanceResult[];
  continuation: number;
  ceiling: number;
  steps: number;
}): string => {
  const failed = input.results.filter((result) => !result.passed);
  const last = input.continuation >= input.ceiling;
  return [
    // Deliberately not "STEP BUDGET ...". The budget notices are recognised in the window by their
    // opening words so a step is never billed for a notice it already carries, and a renewal that
    // began with the same two words would be mistaken for one - which would silently cost the
    // renewed budget the wind-down warning of its own ending.
    input.results.length
      ? `BUDGET RENEWED (${input.continuation} of ${input.ceiling}) after ${input.steps} steps. You did not stop, because the harness has just run your own acceptance checks and ${failed.length} of ${input.results.length} still ${failed.length === 1 ? 'fails' : 'fail'}:`
      : `BUDGET RENEWED (${input.continuation} of ${input.ceiling}) after ${input.steps} steps because new source evidence was observed. Continue toward the requested outcome; repeated reads do not renew the budget.`,
    ...failed.map((result) => `- ${result.id} (${result.label}): ${result.detail}`),
    'This is the same turn on the same computer under the same spending caps, and the user has not been asked anything - carry straight on from the first thing that is not done. Do not restart finished work and do not re-plan from the beginning.',
    last
      ? 'This is the last renewal there is. If the job will not fit in it, spend the end of it finishing one thing properly, saving anything unfinished to a workspace file, and saying plainly what is left.'
      : ''
  ]
    .filter(Boolean)
    .join('\n');
};
