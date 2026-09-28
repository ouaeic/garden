/**
 * The checks for the half of this rig that running it cannot exercise.
 *
 *   NODE_OPTIONS=--conditions=development pnpm exec tsx evals/arms/selftest.ts
 *
 * The offline run proves a good deal about itself every time it runs: it prints real bytes and a
 * baseline catches them moving. What it cannot prove is that the comparison it is printing is a
 * comparison at all, and every failure in that class produces a plausible table rather than an
 * error:
 *
 *   - the one-difference rule is the entire claim to honesty and it lives in a `throw` nobody
 *     reaches on a good day, so a deliberately bad arm is pushed through it here;
 *   - `core` reads garden's own core set out of source, and a pattern that has gone stale would
 *     make that arm a set of names this file invented while every byte count stayed plausible;
 *   - the contract cut removes a section by string surgery, and surgery that took one byte too
 *     many or landed on the wrong heading is invisible in a byte count that only ever goes down;
 *   - ghosts and unmetered rows are excluded from the primary metrics, and an exclusion that
 *     silently stopped working would raise or lower a success rate rather than erroring;
 *   - the tool oracle must be substitutable, or the arms are being scored on which of them the
 *     rig happened to model rather than on what the model could do.
 *
 * A plain script rather than a vitest file, for the reason `evals/context-quality/selftest.ts`
 * gives: `evals/` is not a workspace package, so nothing here is collected by `pnpm -r test`. It
 * exits non-zero on the first run that finds anything.
 */
import { BASE_SYSTEM_PROMPT } from '../../apps/worker/src/context.js';
import { TASKS as CORPUS, fileText, type EditTask } from '../edit/corpus.js';
import {
  ARMS,
  EDIT_ARM,
  FLOOR_TOOL_NAMES,
  ROOT_ARM,
  coreToolNamesFromSource,
  settingsFor,
  type Arm
} from './arms.js';
import {
  EDIT_TASKS,
  EXCLUDED_CORPUS_IDS,
  EditWorld,
  characterBound,
  encodeCandidate,
  encodeIncumbent,
  runEditOne,
  scoreEdit,
  unrecoveredIn,
  type EditArmTask
} from './edit-arm.js';
import { MAX_STEPS, resolveKey, runOne, type RunRow } from './live.js';
import { measureArm } from './measure.js';
import { renderEditVerdict, scoreArms, scoreEditArms } from './report.js';
import { cost, dollars, estimateArm, ratesFor, type Rate } from './price.js';
import { PROVIDER_KEY_VARIABLES } from '../bench/provider.js';
import { TASKS, sampleOf, type ArmTask } from './tasks.js';
import {
  EDIT_TOOL,
  METHOD_HEADING,
  contractFor,
  danglingToolMentions,
  dialectOf,
  fullCatalogue,
  incumbentEntry,
  methodAxis,
  toolsFor,
  withEditDialect
} from './wire.js';
import { answer, resetWorld } from './world.js';

const failures: string[] = [];
const expect = (condition: boolean, what: string): void => {
  if (!condition) failures.push(what);
};
const throws = (run: () => unknown, what: string): void => {
  try {
    run();
    failures.push(what);
  } catch {
    // The throw is the pass.
  }
};

/* ------------------------------------------------- the rule that makes this a comparison at all */

const root: Arm = {
  id: 'r',
  asks: '',
  inherits: null,
  change: {},
  ships: ''
};

throws(
  () =>
    settingsFor('two', [
      root,
      { id: 'two', asks: '', inherits: 'r', change: { tools: 'core', skills: 'none' }, ships: '' }
    ]),
  'an arm that changes two fields must be refused: its row cannot say which change moved the number'
);
throws(
  () => settingsFor('none', [root, { id: 'none', asks: '', inherits: 'r', change: {}, ships: '' }]),
  'an arm that changes nothing must be refused: it is a duplicate of its parent wearing a second name'
);
throws(
  () =>
    settingsFor('bad-root', [
      { id: 'bad-root', asks: '', inherits: null, change: { tools: 'core' }, ships: '' }
    ]),
  'the root arm must be the shipped settings unchanged, or every delta in both tables is measured against a fiction'
);
throws(
  () =>
    settingsFor('a', [
      { id: 'a', asks: '', inherits: 'b', change: { tools: 'core' }, ships: '' },
      { id: 'b', asks: '', inherits: 'a', change: { skills: 'none' }, ships: '' }
    ]),
  'a cycle in the inheritance must be refused rather than looping'
);
throws(
  () =>
    settingsFor('orphan', [
      root,
      { id: 'orphan', asks: '', inherits: 'gone', change: {}, ships: '' }
    ]),
  'an arm inheriting from an arm that does not exist must be refused'
);

// Inheritance has to actually carry. `floor` derives from `core`, so the two axes it does not
// touch must be the root's - if they were re-stated per arm, this would still pass and the
// property would be a coincidence rather than a mechanism.
const floor = settingsFor('floor');
expect(
  floor.tools === 'floor' && floor.skills === 'index' && floor.contract === 'full',
  'the calibration arm must inherit both untouched axes from the root rather than re-declaring them'
);
expect(
  settingsFor(ROOT_ARM).tools === 'full' &&
    settingsFor(ROOT_ARM).skills === 'index' &&
    settingsFor(ROOT_ARM).contract === 'full',
  'the root arm is what garden ships today'
);
for (const arm of ARMS)
  expect(arm.ships.length > 20, `arm ${arm.id} has no pre-registered rule for shipping it`);

/* ----------------------------------------------- the core set is garden's, not this file's copy */

const core = coreToolNamesFromSource();
const catalogue = fullCatalogue().map((tool) => tool.name);
expect(core.length >= 18, `coreToolNames read as ${core.length} names; the pattern has gone stale`);
for (const name of core)
  expect(
    catalogue.includes(name),
    `coreToolNames names "${name}", which is not a tool on the wire`
  );
for (const name of FLOOR_TOOL_NAMES)
  expect(
    catalogue.includes(name),
    `the calibration arm names "${name}", which garden does not define`
  );
expect(
  toolsFor(settingsFor('core')).length === core.length + 1,
  'the core arm must send exactly garden own core set plus compact_context'
);
expect(
  toolsFor(settingsFor('floor')).length === FLOOR_TOOL_NAMES.length,
  'the calibration arm must send exactly five tools'
);
expect(
  toolsFor(settingsFor(ROOT_ARM)).length === catalogue.length,
  'the root arm must send the whole catalogue'
);

/* ------------------------------------------------------------ the contract surgery, both halves */

const shippedContract = contractFor(settingsFor(ROOT_ARM));
expect(
  shippedContract === BASE_SYSTEM_PROMPT,
  'the root arm must send the contract byte-for-byte as shipped'
);

/*
 * The method axis, both ways round.
 *
 * The rig was written expecting the section to be in the shipped contract and the candidate arm to
 * remove it. It landed cut instead, mid-build, and the arm was briefly measuring nothing - so the
 * property checked here is the one that holds in either world: the two contracts differ by exactly
 * the method section and by nothing else, whichever of them is carrying it.
 */
const axis = methodAxis();
const otherContract = contractFor(settingsFor('no-method'));
expect(axis.bytes > 2_000, `the method axis read as ${axis.bytes} bytes; that is not the section`);
expect(
  axis.section.includes(METHOD_HEADING),
  'the method axis must be the whole section, heading included'
);
if (axis.direction === 'cut') {
  expect(
    !otherContract.includes(METHOD_HEADING),
    'with the section shipped, the candidate arm must not carry it'
  );
  expect(
    otherContract.length < BASE_SYSTEM_PROMPT.length,
    'the candidate arm is not smaller than the shipped contract; the cut did nothing'
  );
} else {
  expect(
    otherContract.includes(METHOD_HEADING),
    'with the section already cut, the candidate arm must be the one that carries it - otherwise both arms are identical and the table prints a tie that means nothing'
  );
  expect(
    otherContract.length > BASE_SYSTEM_PROMPT.length,
    'restoring the section must make the contract larger'
  );
  expect(
    otherContract.indexOf(METHOD_HEADING) < otherContract.indexOf('## Safety floor'),
    'the section must go back where it was, in front of the safety floor: moving it changes the prompt in a second way and the arm stops being one difference'
  );
}
// Every other heading has to survive either operation. A slice that swallowed the section after it
// would report a larger difference and a worse arm, and both halves of that error point one way.
for (const heading of BASE_SYSTEM_PROMPT.match(/^## .+$/gm) ?? [])
  expect(otherContract.includes(heading), `the method axis also moved "${heading}"`);
// The safety floor is the one section that must never be a casualty of a byte hunt.
expect(
  otherContract.includes('## Safety floor') && otherContract.includes('Never claim a tool'),
  'the safety floor must survive every edit this rig can make'
);
expect(
  Math.abs(otherContract.length - BASE_SYSTEM_PROMPT.length) > 2_000,
  'the two contracts differ by less than the section does; one of the two arms is not what it says'
);

const noSkills = contractFor(settingsFor('no-skills'));
expect(
  !noSkills.includes('- Skills come in two tiers'),
  'the no-skills arm must also drop the sentence pointing at the index: a window with no index whose contract still describes one is a broken configuration, not an absent feature, and it would lose turns for a reason that has nothing to do with the question'
);
expect(
  noSkills.includes(METHOD_HEADING) === BASE_SYSTEM_PROMPT.includes(METHOD_HEADING),
  'the skills axis must leave the method section exactly where it found it; that is a different arm'
);
expect(
  measureArm('no-skills').knowledgeBytes < measureArm(ROOT_ARM).knowledgeBytes,
  'the no-skills arm must actually remove the index from the knowledge block'
);

/* ------------------------------------------------------------- the free diagnostic, both signs */

expect(
  danglingToolMentions(shippedContract, toolsFor(settingsFor(ROOT_ARM))).length === 0,
  'the shipped arm cannot have a dangling tool mention: it sends every tool it names'
);
expect(
  measureArm('floor').dangling.length > 0,
  'a five-tool arm running the whole contract must show holes, or the diagnostic is not reading the contract'
);

/* ------------------------------------------ ghosts and unmetered rows leave the primary metrics */

const row = (over: Partial<RunRow>): RunRow => ({
  armId: 'x',
  taskId: 't',
  shape: 'files',
  tier: 'weak',
  seed: 0,
  completed: true,
  modelCalls: 3,
  tokensIn: 1000,
  tokensOut: 100,
  metered: true,
  toolsCalled: [],
  ghost: false,
  ranOut: false,
  ...over
});

const scored = scoreArms([
  row({ completed: true }),
  row({ completed: false }),
  row({ ghost: true, completed: false, tokensOut: 0, metered: false }),
  row({ error: 'provider refused', completed: false, metered: false }),
  row({ completed: true, metered: false, tokensOut: 0 })
])[0];
expect(scored !== undefined, 'the scorer produced no row at all');
expect(
  scored?.counted === 3,
  `ghosts and errored rows must leave the denominator: counted ${scored?.counted ?? 'nothing'}, expected 3`
);
expect(
  scored?.successRate === 66.7,
  `success is over rows that ran: got ${scored?.successRate ?? 'nothing'}, expected 66.7`
);
expect(
  scored?.meanTokensOut === 100,
  `an unmetered row must not drag the token mean toward zero: got ${scored?.meanTokensOut ?? 'nothing'}`
);
expect(
  scored?.ghosts === 1 && scored?.errors === 1 && scored?.unmetered === 1,
  'the diagnostics are wrong'
);

// "recovered" is the column the whole programme turns on, so both sides of it are pinned.
const recovery = scoreArms([
  row({ armId: ROOT_ARM, taskId: 'q', modelCalls: 3 }),
  row({ armId: 'candidate', taskId: 'q', modelCalls: 5 }),
  row({ armId: ROOT_ARM, taskId: 'r', modelCalls: 4 }),
  row({ armId: 'candidate', taskId: 'r', modelCalls: 4 })
]).find((score) => score.armId === 'candidate');
expect(
  recovery?.recovered === 1,
  `recovered counts completions that cost more turns than the shipped arm needed: got ${recovery?.recovered ?? 'nothing'}, expected 1`
);

/* --------------------------------------------------------------- the key, and its three arms */

const withoutKey = { OPENROUTER_API_KEY: '' } as NodeJS.ProcessEnv;
const withKey = { OPENROUTER_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;
const inCi = { OPENROUTER_API_KEY: '', GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv;

expect(
  resolveKey(false, withoutKey).apiKey === null && !resolveKey(false, withoutKey).fatal,
  'a run that did not ask for the live half must not fail for want of a key'
);
expect(
  resolveKey(false, withoutKey).note.includes('cannot say whether an arm finishes the work'),
  'a run without the live half has to say what the offline table is worth, every time'
);
expect(
  resolveKey(true, withKey).apiKey === 'sk-test',
  'OPENROUTER_API_KEY is the variable scripts/live-drill.mjs takes; nothing else is read'
);
expect(
  resolveKey(true, withoutKey).apiKey === null && !resolveKey(true, withoutKey).fatal,
  'asked for on a developer machine with no key, the live half explains and continues'
);
expect(
  resolveKey(true, inCi).fatal,
  'asked for on a CI runner with no key, the live half fails - an optional check that skips silently has stopped running'
);
/*
 * The edit axis sends through the worker's gateway, which reads the worker's two variables in the
 * worker's order, so the gate that decides whether it starts reads the same two: a box with only
 * `AI_API_KEY` set is a box the worker runs on, and it must not be told it has no key.
 */
const workerWay = { AI_API_KEY: 'sk-ai', OPENROUTER_API_KEY: '' } as NodeJS.ProcessEnv;
const bothWays = { AI_API_KEY: 'sk-ai', OPENROUTER_API_KEY: 'sk-or' } as NodeJS.ProcessEnv;
expect(
  resolveKey(true, workerWay).apiKey === null,
  'the general half posts to one route with a bare fetch and reads only the variable that route takes'
);
expect(
  resolveKey(true, workerWay, PROVIDER_KEY_VARIABLES).apiKey === 'sk-ai' &&
    resolveKey(true, workerWay, PROVIDER_KEY_VARIABLES).note.includes('AI_API_KEY found'),
  "told the worker's variables, the gate accepts AI_API_KEY alone and names it"
);
expect(
  resolveKey(true, bothWays, PROVIDER_KEY_VARIABLES).apiKey === 'sk-ai',
  'with both set, the gate passes on the same variable the transport bills through - AI_API_KEY first'
);
expect(
  resolveKey(true, withoutKey, PROVIDER_KEY_VARIABLES).note.includes(
    'AI_API_KEY or OPENROUTER_API_KEY is not set'
  ),
  'refused for want of a key, the gate names every variable that would have answered'
);

/* ------------------------------------------- the live loop, against a provider that is not real */

/*
 * The half nobody can run.
 *
 * `runOne` needs a key, so on every machine in this repository it is unreachable - which is exactly
 * the shape of code that rots: it typechecks for months, somebody finally buys a run, and it turns
 * out the loop never terminated on `finish` or never read `usage` and the money is spent. So the
 * provider is stubbed here and the loop is driven for real: three scripted replies, a tool call, a
 * finish, and the counts checked against what the script did.
 *
 * The stub is a plain `fetch` replacement rather than a mock library, for the reason
 * `evals/harness.ts` gives about its own two stubs: the seam that needs replacing is one function,
 * and replacing one function is a change somebody can read.
 */
const realFetch = globalThis.fetch;
const reply = (calls: unknown[] | null, content: string | null, usage: unknown): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content, ...(calls ? { tool_calls: calls } : {}) } }],
      ...(usage ? { usage } : {})
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

const script: Array<() => Response> = [
  () =>
    reply(
      [{ id: 'c1', function: { name: 'file_read', arguments: '{"path":"workspace/notes.txt"}' } }],
      null,
      { prompt_tokens: 8000, completion_tokens: 40 }
    ),
  () =>
    reply([{ id: 'c2', function: { name: 'finish', arguments: '{}' } }], 'Renewal is 14 March.', {
      prompt_tokens: 8200,
      completion_tokens: 60
    })
];
let sent = 0;
globalThis.fetch = (async () => {
  const next = script[sent];
  sent += 1;
  if (!next) throw new Error('the loop asked for more replies than the script has');
  return next();
}) as typeof fetch;

const completedRow = await runOne('sk-test', 'stub', ROOT_ARM, TASKS[0] as ArmTask, 0);
expect(completedRow.completed, 'the loop must end when the model calls finish');
expect(
  completedRow.modelCalls === 2,
  `the loop must count provider round trips: got ${completedRow.modelCalls}, expected 2`
);
expect(
  completedRow.tokensIn === 16_200 && completedRow.tokensOut === 100,
  `tokens come from the provider usage block and are summed across the turn: got ${completedRow.tokensIn}/${completedRow.tokensOut}`
);
expect(completedRow.metered, 'a row the provider metered on every call is metered');
expect(
  completedRow.toolsCalled.join(',') === 'file_read,finish',
  `the names are recorded in order: got ${completedRow.toolsCalled.join(',')}`
);
expect(
  !completedRow.ghost && !completedRow.ranOut,
  'a completed row is neither a ghost nor capped'
);

// A provider that returns nothing at all. Not a failure of the arm, and it must not be scored as one.
sent = 0;
script.length = 0;
script.push(() => reply(null, null, { prompt_tokens: 8000, completion_tokens: 0 }));
const ghostRow = await runOne('sk-test', 'stub', ROOT_ARM, TASKS[0] as ArmTask, 0);
expect(
  ghostRow.ghost && !ghostRow.completed,
  'no content, no call and no output tokens is a ghost run, not a failed task'
);

// A provider that does not meter. The row runs; it just cannot enter a token mean.
sent = 0;
script.length = 0;
script.push(() => reply([{ id: 'c1', function: { name: 'finish', arguments: '{}' } }], null, null));
const unmeteredRow = await runOne('sk-test', 'stub', ROOT_ARM, TASKS[0] as ArmTask, 0);
expect(
  unmeteredRow.completed && !unmeteredRow.metered,
  'a completed row the provider did not meter must still count as completed, and must not be metered'
);
/*
 * And it must carry nothing where the count would have been.
 *
 * Written after a mutation drill found the gap: replacing the `?? 0` fallback with an invented
 * figure left every assertion above green, because "unmetered" was checked and the numbers were
 * not. That is the precise failure the pre-registration's fourth rule is about - the arms differ
 * in how much of the request is tool schema, so any estimate stood in for a missing count is wrong
 * by a different factor per arm, which is a fabricated difference with a decimal point on it. The
 * exclusion downstream is not enough on its own: the row itself must not carry a number nobody
 * measured, because the next reader of the raw JSON has no way to tell one from the other.
 */
expect(
  unmeteredRow.tokensIn === 0 && unmeteredRow.tokensOut === 0,
  `an unmetered row must carry no token figure at all: got ${unmeteredRow.tokensIn}/${unmeteredRow.tokensOut}. A number nobody measured is worse than a blank.`
);

// The step ceiling, which is the difference between "could not" and "was not allowed to".
sent = 0;
script.length = 0;
for (let index = 0; index < MAX_STEPS + 2; index += 1)
  script.push(() =>
    reply([{ id: 'c', function: { name: 'files_list', arguments: '{}' } }], null, {
      prompt_tokens: 100,
      completion_tokens: 10
    })
  );
const cappedRow = await runOne('sk-test', 'stub', ROOT_ARM, TASKS[0] as ArmTask, 0);
expect(
  cappedRow.ranOut && !cappedRow.completed && cappedRow.modelCalls === MAX_STEPS,
  `a run that hits the ceiling must say so rather than reading as a refusal: calls ${cappedRow.modelCalls}, ranOut ${cappedRow.ranOut}`
);

// A provider that refuses. Recorded as an error, and errors never enter a primary metric.
sent = 0;
globalThis.fetch = (async () => new Response('upstream is angry', { status: 503 })) as typeof fetch;
const erroredRow = await runOne('sk-test', 'stub', ROOT_ARM, TASKS[0] as ArmTask, 0);
expect(
  erroredRow.error !== undefined && !erroredRow.completed && !erroredRow.ghost,
  'a provider refusal is an error on the row, not a ghost and not a failure of the arm'
);

globalThis.fetch = realFetch;

/* ------------------------------------------------------------------- the oracle, substitutable */

resetWorld();
const throughReader = answer('file_read', { path: 'workspace/notes.txt' }).content;
const throughShell = answer('shell', { command: 'cat workspace/notes.txt' }).content;
expect(
  throughReader === throughShell && throughReader.includes('14 March 2027'),
  'the same fact must be reachable through shell and through a reader, or the tool arms are scored on which of them this rig happened to model'
);
expect(
  answer('document_search', { query: 'terminate' }).content.includes('60 days'),
  'the index must find what the documents contain'
);
expect(
  answer('shell', { command: "grep -n 'terminate' workspace/contract.pdf" }).content.includes(
    '60 days'
  ),
  'and grep must find the same thing, in more calls'
);
expect(answer('finish', {}).terminal, 'finish must end the run');
expect(
  !answer('image_read', {}).terminal && answer('image_read', {}).content.includes('not modelled'),
  'a tool this rig does not model must refuse honestly rather than return a plausible success an arm could complete on'
);
expect(
  answer('file_read', { path: 'workspace/notes.txt' }).content ===
    answer('file_read', { path: 'workspace/notes.txt' }).content,
  'a result must be a function of the call alone'
);

/* -------------------------------------------------------------------------------- the sample */

expect(
  TASKS.length > 60,
  `the sample is ${TASKS.length} tasks; it should be the fixtures bar one shape`
);
expect(!TASKS.some((task) => task.shape === 'schema'), 'a claim about the catalogue is not a job');
expect(
  TASKS.some((task) => task.shape === 'refusal'),
  'the awkward shapes stay in: dropping the ones an author expects to go badly is how a sample becomes an argument'
);
expect(
  TASKS.every((task) => task.request.trim().length > 0),
  'every task must carry the owner words'
);
const twelve = sampleOf(12);
expect(twelve.length === 12, `sampleOf(12) returned ${twelve.length}`);
expect(
  new Set(twelve.map((task) => task.shape)).size >= 6,
  'a subset somebody is paying for has to keep the shape mix, or it is the first twelve fixtures wearing the name of a sample'
);
expect(
  sampleOf(10_000).length === TASKS.length,
  'asking for more than there is returns everything'
);

/* ----------------------------------------------------------------------------- the edit axis */

/*
 * The arm whose whole answer is in the half that costs money, checked in the half that does not.
 *
 * Everything here is a way of being wrong that would still print a table. An arm that quietly sent
 * the same catalogue twice prints a tie; a world whose appliers cannot land a correct edit prints
 * zero for both arms and reads as "models cannot do this"; a sample whose intended text is the
 * text it started with passes without an edit ever being made. So: both dialects are driven
 * through the real appliers on every row, by a scripted model that gets them right, and the row
 * must come out byte-correct. If it does not, the instrument is broken and no live run should be
 * bought.
 *
 * ONE THING HERE IS NEW AND IS THE MOST IMPORTANT CHECK IN THE FILE. The dialect landed while this
 * rig was being written, so the arm and the root swapped sides, and the failure that produces is
 * silent in every direction: the root arm sending a rolled-back editor, the candidate arm sending
 * the working tree under a second name, the verdict comparing the mirror image of the question. So
 * the direction is asserted, both catalogues are asserted to be different shapes of `file_patch`,
 * and the verdict is driven on a fabricated table whose answer is known.
 */

const shippedEditTool = fullCatalogue().find((tool) => tool.name === EDIT_TOOL);
expect(
  shippedEditTool !== undefined,
  `garden no longer ships a tool called ${EDIT_TOOL}; this axis is measuring an editor that is not there`
);
expect(
  shippedEditTool !== undefined && dialectOf(shippedEditTool) === settingsFor(ROOT_ARM).edit,
  `the root arm claims to hold the "${settingsFor(ROOT_ARM).edit}" editor and the catalogue ships the "${shippedEditTool ? dialectOf(shippedEditTool) : 'missing'}" one; every arm in the table would be sending an editor garden does not, while every byte count stayed plausible`
);
expect(
  settingsFor(EDIT_ARM).edit !== settingsFor(ROOT_ARM).edit &&
    settingsFor(EDIT_ARM).tools === 'full' &&
    settingsFor(EDIT_ARM).skills === 'index' &&
    settingsFor(EDIT_ARM).contract === 'full',
  'the edit arm must differ from shipped by the edit tool and nothing else'
);

const editTools = toolsFor(settingsFor(EDIT_ARM));
const rootTools = toolsFor(settingsFor(ROOT_ARM));
const editEntry = editTools.find((tool) => tool.name === EDIT_TOOL);
const rootEntry = rootTools.find((tool) => tool.name === EDIT_TOOL);
expect(
  editEntry !== undefined &&
    rootEntry !== undefined &&
    dialectOf(editEntry) !== dialectOf(rootEntry),
  'the two edit arms must send different shapes of file_patch: an arm that sent the same entry as its parent would print a perfect tie, and a tie reads as "the dialect is free"'
);
expect(
  editTools.length === rootTools.length,
  'a replacement changes no tool count; a count that moved means an entry was dropped rather than swapped'
);
expect(
  JSON.stringify(editTools.filter((tool) => tool.name !== EDIT_TOOL)) ===
    JSON.stringify(rootTools.filter((tool) => tool.name !== EDIT_TOOL)),
  'the two edit arms must differ in the edit entry and in nothing else on the wire'
);
/*
 * The swap has to find the thing it replaces. Every arm sends `file_patch` - it is in the core set
 * and in the hand-written floor - so the way this guard is reached is a rename in
 * `tool-catalogue.ts`, and the failure it prevents is silent.
 */
throws(
  () =>
    withEditDialect(
      fullCatalogue().filter((tool) => tool.name !== EDIT_TOOL),
      settingsFor(EDIT_ARM)
    ),
  'the edit axis must throw when there is no file_patch to place either arm against: an arm that silently kept the shipped catalogue would print a tie'
);
/*
 * And the rollback has to be the quoted editor at its best.
 *
 * `incumbentEntry` throws on its own when the frozen value and the repository's history disagree,
 * so what is left to check here is the shape: the OTHER dialect, and `moveAfter` present. That
 * last one is the trap. `moveAfter` was the quoted editor's final improvement and it took a move
 * from 777 characters to 397; a rollback that reached one revision too far back would drop it,
 * every number in the bound would still look plausible, and the candidate would be measured
 * against an incumbent that had been made worse for the occasion.
 *
 * It also has to say whether the check happened. A depth-1 clone has no revision to compare
 * against, and the difference between "checked" and "could not be checked" must reach the reader
 * rather than being absorbed into a source line that looks the same either way.
 */
const rollback = incumbentEntry();
expect(
  dialectOf(rollback.tool) === 'patch',
  `the rollback entry read from ${rollback.source} is not the quoted editor`
);
expect(
  JSON.stringify(rollback.tool.parameters).includes('moveAfter'),
  `the rollback entry from ${rollback.source} has no moveAfter, so the walk went back past the quoted editor's own last improvement and would measure it at its second best`
);
expect(
  rollback.source !== 'the shipped catalogue',
  'the rollback is being read from the working tree, which means the dialect has not landed and this rig is measuring a candidate against itself'
);
expect(
  rollback.source.includes('checked against') || rollback.source.includes('UNCHECKED'),
  `the rollback must say whether history could confirm it; "${rollback.source}" says neither, so a reader cannot tell a verified entry from an unverifiable one`
);

/* The sample: real edits, no dialect in the request, and nothing that passes without an edit. */
expect(
  EDIT_TASKS.length > 10,
  `the edit sample is ${EDIT_TASKS.length} rows; the corpus has fifteen`
);
expect(
  EXCLUDED_CORPUS_IDS.length === 3,
  `${EXCLUDED_CORPUS_IDS.length} corpus rows excluded; the drift and refusal rows are three`
);
for (const task of EDIT_TASKS) {
  expect(
    task.wanted !== fileText(task.path) || task.renamedTo !== undefined,
    `${task.corpusId}: the text a correct edit produces is the text it started with, so the row would score correct with no edit made at all`
  );
  expect(
    !/\bPUT \b|\bCUT \b|oldText|newText/.test(task.request),
    `${task.corpusId}: the request contains a dialect, so the sample is teaching one of the two arms its own answer`
  );
}

/*
 * A model that gets it right, on every row, through both dialects and both appliers.
 *
 * This is what makes the encoders trustworthy. The candidate's encoder is written in this rig
 * because the one in `evals/edit` predates the shipped spelling, and an encoder nobody checks is a
 * rig quoting a saving on a dialect the parser would refuse. Here every emission goes through the
 * real `parseEdit`/`applyEdit` and the file is compared byte for byte afterwards, so an encoder
 * that drifted from the parser fails here rather than printing a smaller number.
 */
let landed = 0;
for (const task of EDIT_TASKS) {
  const corpus = CORPUS.find((one) => one.id === task.corpusId);
  if (!corpus) {
    failures.push(`${task.corpusId}: no longer in the corpus this sample is derived from`);
    continue;
  }
  const read = fileText(corpus.path);

  const incumbent = new EditWorld('patch');
  incumbent.answer('file_read', { path: corpus.path });
  const quoted = encodeIncumbent(corpus, read);
  incumbent.answer(quoted.tool, quoted.args as Record<string, unknown>);
  expect(
    scoreEdit(incumbent, task).correct,
    `${task.corpusId}: the quoted editor, given the best encoding of this edit, does not leave the file as the task asked - this world is scoring the rig, not the model`
  );

  const candidate = new EditWorld('lines');
  const rendered = candidate.answer('file_read', { path: corpus.path }).content;
  expect(
    /^1:/.test(rendered),
    `${task.corpusId}: the candidate's read is not numbered, so the dialect has nothing to address`
  );
  const byLine = encodeCandidate(corpus);
  candidate.answer(byLine.tool, byLine.args as Record<string, unknown>);
  expect(
    scoreEdit(candidate, task).correct,
    `${task.corpusId}: the by-line encoding of this edit does not leave the file as the task asked`
  );
  if (scoreEdit(candidate, task).correct && scoreEdit(incumbent, task).correct) landed += 1;
}
expect(
  landed === EDIT_TASKS.length,
  `${landed} of ${EDIT_TASKS.length} rows land through both dialects; a rig that cannot land its own sample cannot measure a model against it`
);

/*
 * The bound is a bound, and it is a bound over rows that both dialects really do.
 *
 * A negative or absent saving on a row would mean the encoders disagree about what the task is,
 * and the total is the figure the whole ruling has been argued against, so it is checked rather
 * than printed on trust.
 */
const bound = characterBound();
expect(
  bound.length === EDIT_TASKS.length &&
    bound.every((row) => row.quoted > 0 && row.lineAddressed > 0),
  'every row of the sample must have a measured cost in both dialects'
);
expect(
  bound.reduce((sum, row) => sum + row.lineAddressed, 0) <
    bound.reduce((sum, row) => sum + row.quoted, 0),
  'the line dialect must be cheaper in total over this sample, or the premise of the whole axis is gone and no live run is worth buying'
);

/* An anchor no read has shown. The record of what was displayed is the format's safety story. */
const fabricated = new EditWorld('lines');
fabricated.answer('file_patch', {
  patches: [{ path: 'src/queue.ts', edit: 'PUT 11:\n+    return undefined;' }]
});
expect(
  fabricated.editCalls === 1 && fabricated.editApplied === 0,
  'an edit against a file this turn never read must be refused and counted as a refused call, or the applied column is a fiction'
);
expect(
  !scoreEdit(fabricated, EDIT_TASKS[1] as EditArmTask).correct,
  'a refused edit must not score correct'
);

/* And a quote that is not unique, which is the quoted editor's own failure mode. */
const ambiguous = new EditWorld('patch');
ambiguous.answer('file_patch', {
  patches: [
    { path: 'src/queue.ts', oldText: '    return null;\n', newText: '    return undefined;\n' }
  ]
});
expect(
  ambiguous.editApplied === 0 && ambiguous.refusals[0]?.kind === 'no_unique_match',
  'a quote that appears six times must be refused by the quoted editor here exactly as it was refused when it shipped'
);

/*
 * The two numbers the ship criterion is written against, which nothing else in this repository
 * computes and which a plausible wrong answer is available for at every step.
 */
expect(
  unrecoveredIn([
    { applied: false, refusedAs: 'parse', notes: [] },
    { applied: true, notes: [] }
  ]) === 0,
  'a refusal the model answers with a landed edit in the same turn is recovered, and costs a round trip rather than the task'
);
expect(
  unrecoveredIn([
    { applied: true, notes: [] },
    { applied: false, refusedAs: 'parse', notes: [] }
  ]) === 1,
  'a refusal with nothing after it is the failure the criterion is about, even in a turn that landed an earlier edit'
);
expect(
  unrecoveredIn([{ applied: true, notes: ['your anchor was off by 1'] }]) === 0,
  'a malformed emission the harness forgave is not a refusal at all: it costs no round trip, which is the entire thesis under test'
);
const forgiving = new EditWorld('lines');
forgiving.answer('file_read', { path: 'src/queue.ts' });
forgiving.answer('file_patch', {
  patches: [{ path: 'src/queue.ts', edit: '[src/queue.ts#3f9a]\nput 11:\n+    return undefined;' }]
});
expect(
  forgiving.editApplied === 1 && forgiving.editForgiven === 1 && forgiving.unrecovered === 0,
  `a malformed emission the shipped applier absorbs must be counted as applied AND as forgiven: applied=${forgiving.editApplied} forgiven=${forgiving.editForgiven}. Counting it as a clean call would report the harness's forgiveness as the model's accuracy, which is the one thing this lane exists to tell apart`
);

/*
 * The verdict, driven on tables whose answer is known, because a decision rule that has never been
 * executed is a paragraph. The unresolved case is checked first and hardest: a run that cannot see
 * one in twenty must not report a pass, and twelve edit calls cannot see it.
 */
const fakeScore = (
  armId: string,
  tier: string,
  correct: number,
  calls: number,
  unrecovered: number
) => ({
  armId,
  tier,
  counted: 12,
  correct,
  nearly: 0,
  editCalls: calls,
  editApplied: calls - unrecovered,
  editForgiven: 0,
  unrecovered,
  anchorPresent: 0,
  corrected: 0,
  refusedAmbiguous: 0,
  echoMiss: 0,
  prefixStripped: 0,
  meanTokensOut: 100,
  meanTokensIn: 9000,
  meanModelCalls: 3,
  refusals: [],
  ghosts: 0,
  unmetered: 0,
  errors: 0
});
const lineArm = settingsFor(ROOT_ARM).edit === 'lines' ? ROOT_ARM : EDIT_ARM;
const quotedArm = lineArm === ROOT_ARM ? EDIT_ARM : ROOT_ARM;
const twoTiers = (line: number, quotedCorrect: number, calls: number, unrecovered: number) =>
  ['weak', 'strong'].flatMap((tier) => [
    fakeScore(lineArm, tier, line, calls, unrecovered),
    fakeScore(quotedArm, tier, quotedCorrect, calls, 0)
  ]);
expect(
  renderEditVerdict(twoTiers(12, 12, 12, 0)).includes('NOT SETTLED'),
  'twelve edit calls cannot resolve one in twenty, and a clean sweep on twelve must be reported as unsettled rather than as a pass'
);
expect(
  renderEditVerdict(twoTiers(12, 12, 40, 0)).includes('the rule is met on every tier that ran'),
  'forty clean edit calls on both tiers, tied on success, is the run that meets the rule'
);
expect(
  renderEditVerdict(twoTiers(9, 12, 40, 0)).includes('does not ship') ||
    renderEditVerdict(twoTiers(9, 12, 40, 0)).includes('NOT met'),
  'three tasks behind is more than one task behind, and must fail however cheap the dialect is'
);
expect(
  renderEditVerdict(twoTiers(12, 12, 40, 4)).includes('NOT met'),
  'four unrecovered refusals in forty calls is one in ten, which is twice the ceiling and must fail'
);
expect(
  renderEditVerdict([
    fakeScore(lineArm, 'weak', 12, 40, 0),
    fakeScore(quotedArm, 'weak', 12, 40, 0)
  ]).includes('NOT SETTLED'),
  'one tier cannot settle a rule that says both tiers, and must not print a pass'
);

/*
 * The price. Every figure has to be positive, ordered, and reachable without a key; the money must
 * be absent rather than invented when the provider cannot be asked.
 */
const editEstimate = estimateArm(measureArm(EDIT_ARM), 1);
const rootEstimate = estimateArm(measureArm(ROOT_ARM), 1);
expect(
  editEstimate.callsFloor === EDIT_TASKS.length * 3 &&
    editEstimate.callsCeiling > editEstimate.callsFloor,
  'a perfect row is read, edit, finish, and the ceiling is the step limit'
);
expect(
  editEstimate.promptTokensFloor > 0 &&
    editEstimate.promptTokensCeiling > editEstimate.promptTokensFloor &&
    editEstimate.outputTokensCeiling > editEstimate.outputTokensFloor,
  'the floor must be under the ceiling in every column, or the two are not a range'
);
expect(
  rootEstimate.outputTokensFloor < editEstimate.outputTokensFloor,
  `the line dialect must emit fewer output tokens on a perfect run than the quoted editor - ${rootEstimate.outputTokensFloor} against ${editEstimate.outputTokensFloor} - or the offline bound and the price disagree about the same sample`
);
/*
 * And the comparison must survive being converted into money. Over twelve small tasks the two arms
 * differ by a fraction of a cent, so a cost function that rounded to the cent before subtracting
 * would print "the dialect is free" - which is the exact conclusion this rig exists to test rather
 * than assume, arrived at by a rounding mode.
 */
const cent: Rate = { model: 'stub', inPerMillion: 0.4, outPerMillion: 1.6 };
const lineCost = cost(
  estimateArm(measureArm(lineArm), 1).promptTokensFloor,
  estimateArm(measureArm(lineArm), 1).outputTokensFloor,
  cent
);
const quotedCost = cost(
  estimateArm(measureArm(quotedArm), 1).promptTokensFloor,
  estimateArm(measureArm(quotedArm), 1).outputTokensFloor,
  cent
);
expect(
  lineCost !== quotedCost,
  'the two arms must differ in cost before rounding, or the money column is reporting a rounding mode rather than a measurement'
);
expect(
  dollars(1, 0, cent) === 0 && cost(1, 0, cent) > 0,
  'rounding belongs at the point of printing: dollars() may round a total to the cent, cost() must not round at all'
);

const noRates = await ratesFor(['openai/gpt-4.1-mini'], (async () => {
  throw new Error('no network in this check');
}) as unknown as typeof fetch);
expect(
  noRates.rates.length === 0 &&
    noRates.missing.length === 1 &&
    noRates.note.includes('could not be reached'),
  'a provider that cannot be reached must yield no rate and say so; a fallback constant here would be the only unmeasured figure on the page and it would be wrong in the cheap direction'
);
const madeUp = await ratesFor(
  ['a/b', 'c/d'],
  (async () =>
    new Response(
      JSON.stringify({
        data: [{ id: 'a/b', pricing: { prompt: '0.0000004', completion: '0.0000016' } }]
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    )) as unknown as typeof fetch
);
expect(
  madeUp.rates.length === 1 &&
    madeUp.rates[0]?.inPerMillion === 0.4 &&
    madeUp.rates[0]?.outPerMillion === 1.6 &&
    madeUp.missing.includes('c/d'),
  'per-token prices must be read as published and converted per million, and a tier the catalogue does not carry must be named rather than dropped'
);
/*
 * `--model` names a tier by its release id, `openrouter/<slug>`, and the catalogue lists the
 * model under the slug alone - the cut the request itself is sent with. Looked up under the
 * release id, the documented command prints tokens and no price.
 */
const byReleaseId = await ratesFor(
  ['openrouter/a/b'],
  (async () =>
    new Response(
      JSON.stringify({
        data: [{ id: 'a/b', pricing: { prompt: '0.0000004', completion: '0.0000016' } }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as unknown as typeof fetch
);
expect(
  byReleaseId.rates.length === 1 &&
    byReleaseId.rates[0]?.model === 'openrouter/a/b' &&
    byReleaseId.rates[0]?.inPerMillion === 0.4 &&
    byReleaseId.missing.length === 0,
  'a tier named by its release id is priced under the slug the route bills, and the row keeps the release id it was named by'
);

/*
 * The edit loop end to end, against the same stubbed provider, because `runEditOne` is as
 * unreachable on this machine as `runOne` is and rots the same way.
 */
const editTask = EDIT_TASKS.find((task) => task.corpusId === 'repeated-statement') as EditArmTask;
const editCorpus = CORPUS.find((one) => one.id === 'repeated-statement') as EditTask;
const liveArm = settingsFor(ROOT_ARM).edit === 'lines' ? ROOT_ARM : EDIT_ARM;
const editScript: Array<() => Response> = [
  () =>
    reply(
      [
        {
          id: 'e1',
          function: { name: 'file_read', arguments: JSON.stringify({ path: editCorpus.path }) }
        }
      ],
      null,
      { prompt_tokens: 9000, completion_tokens: 20 }
    ),
  () =>
    reply(
      [
        {
          id: 'e2',
          function: {
            name: 'file_patch',
            arguments: JSON.stringify(encodeCandidate(editCorpus).args)
          }
        }
      ],
      null,
      { prompt_tokens: 9400, completion_tokens: 30 }
    ),
  () =>
    reply([{ id: 'e3', function: { name: 'finish', arguments: '{}' } }], 'Done.', {
      prompt_tokens: 9600,
      completion_tokens: 10
    })
];
let editSent = 0;
globalThis.fetch = (async () => {
  const next = editScript[editSent];
  editSent += 1;
  if (!next) throw new Error('the edit loop asked for more replies than the script has');
  return next();
}) as typeof fetch;

const editRow = await runEditOne('sk-test', 'stub', liveArm, editTask, 0);
globalThis.fetch = realFetch;
expect(
  editRow.completed && editRow.correct && editRow.editCalls === 1 && editRow.editApplied === 1,
  `the edit loop must run a correct row end to end: completed=${editRow.completed} correct=${editRow.correct} calls=${editRow.editCalls} applied=${editRow.editApplied}`
);
expect(
  editRow.unrecovered === 0 && editRow.editForgiven === 0,
  'a clean row must carry no unrecovered refusal and no forgiveness, or those two columns cannot be read on a dirty one'
);
expect(
  editRow.tokensOut === 60 && editRow.modelCalls === 3,
  `the edit row must carry the provider own usage: ${editRow.tokensOut} out over ${editRow.modelCalls} calls`
);

const editScores = scoreEditArms([editRow]);
expect(
  editScores.length === 1 && editScores[0]?.correct === 1 && editScores[0]?.editApplied === 1,
  'the edit table must score a correct row as correct, with output tokens on the same row'
);

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write(
  'arms selftest: the one-difference rule, the core set read from source, both halves of the contract surgery, the ghost and unmetered exclusions, the recovered column, the key arms, the live loop against a stubbed provider, the oracle substitutability, the sample, and the edit axis - which way round it is, the rollback read out of git and checked for the shape the quoted editor really had, the two catalogues differing in the edit entry and nothing else, both dialects landing every row of its sample through the shipped appliers, both failure modes failing closed, the forgiveness column telling a leniency apart from an accurate model, the ship criterion executed against tables whose answer is known including the one it must refuse to settle, and the price refusing to invent a rate - behave as documented.\n'
);
