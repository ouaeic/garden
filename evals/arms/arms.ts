/**
 * The arms, and the one property that makes a comparison between them worth reading.
 *
 * ── Why this file is a tree and not a list ──────────────────────────────────────────────────────
 *
 * Every previous argument about garden's resident weight - the catalogue is too big, the skill
 * index is dead, `## Doing the work well` is method that should not be carried - was settled by
 * reading source and forming a view. None of them was measured, because measuring them means
 * running two configurations against the same work and there was no way to state "the same work"
 * that a later edit could not quietly break. Two arms defined side by side drift the first time
 * somebody adds a task to one of them, and the drift is invisible in the result: the table still
 * prints two numbers and a difference.
 *
 * So an arm here does not carry a configuration. It carries the id of a sibling it derives from
 * and *one* field it changes. Everything else - the sample, the tier, the tool oracle, the other
 * two axes - is inherited, so it cannot be edited for one arm without being edited for both. The
 * comparison is honest by construction rather than by discipline, which is the only kind that
 * survives nine waves of other people's edits.
 *
 * `resolveArms` enforces the one-field rule in code and throws. That is deliberately not a test:
 * a rig whose honesty depends on somebody running its test suite is a rig that reports a confident
 * wrong difference on the machine where the suite was skipped.
 *
 * ── Why the arms are these arms ────────────────────────────────────────────────────────────────
 *
 * Three of them are live proposals somebody has argued for and one is a calibration point. The
 * calibration arm is not a proposal and must never be read as one: `full` versus `core` is a
 * 30 kB difference on a prompt whose prefix is already ~70 kB, and a difference that size can
 * easily be indistinguishable from provider noise. `floor` exists so that the reader can tell
 * "the axis has no signal" from "this candidate is free". If `floor` does not lose, nothing else
 * in the table is readable and no arm ships on this run.
 */
import { readFileSync } from 'node:fs';

/**
 * The axes an arm may move. Adding one is adding an experiment, not a setting.
 *
 * There were three, and the fourth was added deliberately and with a ruling behind it. `edit` is
 * the gate `docs/design/exec3/L2.md` named before it held a measured format back: an edit dialect
 * that is 61% cheaper in output characters, for a model that spells it correctly every time, and
 * no evidence at all about whether one does. That question cannot be asked by the three axes above
 * and it cannot be asked offline, so it is an axis, and it is the only one whose whole answer is
 * in the live half.
 */
export interface ArmSettings {
  /** Which slice of garden's own catalogue reaches the wire. */
  readonly tools: 'full' | 'core' | 'floor';
  /** Whether the curated knowledge block's skill index is in the window at all. */
  readonly skills: 'index' | 'none';
  /**
   * `full` is the shipped contract. `environment-only` removes the `## Doing the work well`
   * section - the largest single candidate in the delete list, 49% of the contract and, by the
   * residency rule, 100% method carried on every request of every task for ever.
   *
   * The section is *removed*, not rewritten, unless a replacement is supplied on the command line.
   * Guessing at somebody else's replacement prose and then certifying the guess would be a rig
   * measuring its own invention; `--contract-cut <file>` is the seam through which the actual
   * candidate is submitted for judgement.
   */
  readonly contract: 'full' | 'environment-only';
  /**
   * Which editor the arm holds: the line-addressed one in `apps/worker/src/edit/`, which is what
   * `file_patch` now is, or the quoted oldText/newText shape it replaced, which is in no file of
   * the working tree and is read back out of the last revision that declared it.
   *
   * A replacement and never an addition, in either direction. Shipping both would be two ways to
   * do one thing, and a model given two would spread its edits across them and make every number
   * here unreadable.
   */
  readonly edit: 'patch' | 'lines';
}

export interface Arm {
  readonly id: string;
  /** The question this arm asks, in one line, printed above its row. */
  readonly asks: string;
  /** The sibling it derives from. Exactly one arm may have none. */
  readonly inherits: string | null;
  /** Exactly one field, for every arm that inherits. Enforced below. */
  readonly change: Partial<ArmSettings>;
  /**
   * The pre-registered rule that would let this arm ship, written before the first call and
   * printed with every result. A decision rule chosen after the numbers are in is not a decision
   * rule, and the cheapest way to keep it honest is to make it impossible to read the table
   * without also reading the rule that was set before the table existed.
   */
  readonly ships: string;
}

export const ROOT_ARM = 'shipped';

/**
 * The arm on the edit axis, named once so nothing has to spell it.
 *
 * It is excluded from the general live run and included in the offline table, which is not an
 * inconsistency: its residency is knowable for nothing and is worth printing beside every other
 * arm's, and its outcome is only readable on a sample that edits files.
 *
 * It was called `line-edit` and it is called `quoted-edit`, because the thing it holds changed
 * sides. The dialect landed; the arm that is not the working tree is now the quoted editor. The
 * rename is deliberately loud - an arm called `line-edit` that sends oldText/newText is a table
 * that lies to anybody reading it quickly, and this axis has already produced one decision taken
 * on a tie that meant the opposite of what it looked like.
 */
export const EDIT_ARM = 'quoted-edit';

export const ARMS: readonly Arm[] = [
  {
    id: ROOT_ARM,
    asks: 'The current full tool catalogue, skill index and operating contract.',
    inherits: null,
    change: {},
    ships: 'Shipped. It is the comparison, not a candidate.'
  },
  {
    id: 'no-method',
    asks: 'Does the contract carrying method rather than environment facts change any outcome?',
    inherits: ROOT_ARM,
    change: { contract: 'environment-only' },
    ships:
      'Ships if success is within one task of shipped AND mean model calls within 5%, on BOTH tiers. Whatever it saves, it does not ship on the token column alone. Read the direction line above the table first: when the cut has already landed this arm is the one carrying the section, so a loss here is a reason to put it back rather than a reason to cut.'
  },
  {
    id: 'no-skills',
    asks: 'Does the resident skill index change any outcome, or only the bill?',
    inherits: ROOT_ARM,
    change: { skills: 'none' },
    ships:
      'Nothing ships on this arm alone. It is the selection question the published skill numbers deliberately do not ask: they measure a skill once relevance is given, and relevance here is what the index is for. A tie means the index is not buying selection on this sample; it does not mean the bodies are worthless.'
  },
  {
    id: 'core',
    asks: 'Are the twenty-one non-core tools doing work, or occupying prefix?',
    inherits: ROOT_ARM,
    change: { tools: 'core' },
    ships:
      'Ships nothing on its own. It is a research arm: it gives the slope of the tool axis, and it is the only result that would justify reopening the question of how tools reach the model at all.'
  },
  {
    id: EDIT_ARM,
    asks: 'Does a model emit the line-addressed edit dialect correctly, which is the only thing the measured 61% depends on?',
    inherits: ROOT_ARM,
    change: { edit: 'patch' },
    ships:
      'Ships as a REPLACEMENT for file_patch if edit-success is within one task of the shipped arm on the same sample and on BOTH tiers, and no more than one edit call in twenty is refused for a dialect error the model does not then recover from. Nothing ships on the 61%: that figure is an offline upper bound available only to a model that gets the spelling right every time, and a dialect the model has to learn is not paid for in output characters. A loss here is the cheapest possible way to have learned that the 61% was never available. THE DIRECTION HAS INVERTED and the criterion above is unchanged: the dialect landed between this rule being written and being run, so `shipped` is now the line-addressed arm and THIS arm is the quoted editor put back. Read "the shipped arm" in the rule as "the arm holding the quoted editor", which is this one, exactly as `no-method` is read once its cut has landed. A loss for the line dialect here is a reason to roll it back, not a reason to keep it.'
  },
  {
    id: 'floor',
    asks: 'CALIBRATION, not a proposal: with five tools, does the axis show any signal at all?',
    inherits: 'core',
    change: { tools: 'floor' },
    ships:
      'Never. Read it first: if `floor` is within one task of `shipped` on the weak tier, this sample cannot resolve the tool axis and no arm ships on this run.'
  }
];

/**
 * The rule, verbatim, before the first call.
 *
 * Exported rather than left in a README because `report.ts` prints it above every table it renders.
 * A pre-registration nobody sees is a pre-registration that gets edited.
 */
export const PRE_REGISTRATION = [
  'Pre-registered before the first model call, and printed with every result:',
  '  1. Read `floor` first. Within one task of `shipped` on the weak tier means the sample cannot',
  '     resolve this axis, and every other row is noise. Nothing ships from a run where that holds.',
  '  2. An arm ships only on BOTH tiers, on success AND on model calls. The token column is the',
  '     reason to look; it is never on its own the reason to cut.',
  '  3. Ghost runs - no output tokens, no tool call, no content - are excluded from every primary',
  '     metric and printed as a diagnostic. A provider that returned nothing is not a model that',
  '     failed the task, and folding the two together is how a bad hour becomes a finding.',
  '  4. Rows the provider did not meter are excluded from the token means for the same reason and',
  '     counted the same way. Token figures come from the provider’s own usage or from nowhere.',
  '  5. Every arm that dies is published, in the shape `tool-catalogue.test.ts` already uses for a',
  '     declined tool: what it cost, what it bought, and which of the two reasons actually decided.',
  '  6. The edit axis is read on its own sample and its own table (--edit), because a task that does',
  '     not edit a file cannot tell the two dialects apart and would print a tie. Edit-success there',
  '     is the file afterwards, never the tool own word for what it did, and it is printed beside',
  '     output tokens on the same row: a dialect that is cheaper and less often right is not a saving.'
].join('\n');

/* ------------------------------------------------------------------ resolution, enforced in code */

/**
 * The root arm: what garden sends today, and `edit` tracks the working tree rather than a wish.
 *
 * It said `patch` when this file was written, because that is what shipped. The line-addressed
 * dialect then landed, and leaving the constant alone would have made every arm in this table -
 * `core`, `floor`, `no-skills`, all of them - quietly send a rolled-back editor while answering a
 * question that has nothing to do with editing. Their byte counts would all have stayed plausible.
 *
 * It is not read from source, because a settings tree that reconfigured itself from the tree would
 * make `shipped` mean something different on two checkouts and both tables unreadable across a
 * commit. It is written down and CHECKED: `wire.ts:withEditDialect` throws when this claim and the
 * catalogue disagree, in either direction, rather than sending the other arm's entry.
 */
const SHIPPED: ArmSettings = {
  tools: 'full',
  skills: 'index',
  contract: 'full',
  edit: 'lines'
};

/**
 * An arm's settings, composed by walking to the root.
 *
 * Throws on a chain that does not terminate, on an unknown parent, and - the clause this file
 * exists for - on any inheriting arm that changes more or less than one field. Two changes in one
 * arm is two experiments sharing a row, and the row cannot say which of them moved the number.
 */
export const settingsFor = (id: string, arms: readonly Arm[] = ARMS): ArmSettings => {
  const byId = new Map(arms.map((arm) => [arm.id, arm]));
  const chain: Arm[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`arm inheritance is a cycle at "${cursor}"`);
    seen.add(cursor);
    const arm: Arm | undefined = byId.get(cursor);
    if (!arm) throw new Error(`arm "${cursor}" inherits from "${id}" but does not exist`);
    chain.unshift(arm);
    cursor = arm.inherits;
  }
  let settings = SHIPPED;
  for (const arm of chain) {
    const changed = Object.keys(arm.change);
    if (arm.inherits === null) {
      if (changed.length)
        throw new Error(`the root arm "${arm.id}" must inherit the shipped settings unchanged`);
      continue;
    }
    if (changed.length !== 1)
      throw new Error(
        `arm "${arm.id}" changes ${changed.length} fields (${changed.join(', ') || 'none'}); one arm is one difference, or its row cannot say which change moved the number`
      );
    settings = { ...settings, ...arm.change };
  }
  return settings;
};

export const armById = (id: string): Arm => {
  const arm = ARMS.find((one) => one.id === id);
  if (!arm) throw new Error(`no such arm: ${id}. Known: ${ARMS.map((one) => one.id).join(', ')}`);
  return arm;
};

/* ------------------------------------------------------------- the core set, read not transcribed */

/**
 * `coreToolNames` is module-private inside `tool-catalogue.ts`, and copying the twenty names here
 * would make this rig's `core` arm quietly stop being garden's core set the first time somebody
 * moves a tool between the two halves - while every number in the table stayed plausible.
 *
 * So it is read out of the source, the way `evals/fixtures.ts` reads the dispatch tables it must
 * not copy, and a rename is as loud as a deletion: the pattern stops matching and this throws.
 */
export const coreToolNamesFromSource = (
  sourcePath = new URL('../../apps/worker/src/tool-catalogue.ts', import.meta.url)
): readonly string[] => {
  const source = readFileSync(sourcePath, 'utf8');
  const block = /const coreToolNames = new Set\(\[([\s\S]*?)\]\);/.exec(source);
  if (!block?.[1])
    throw new Error(
      'coreToolNames could not be read from tool-catalogue.ts; the `core` arm is not garden’s core set and this rig must not pretend otherwise'
    );
  const names = [...block[1].matchAll(/^\s*'([a-z_]+)'/gm)].map((match) => match[1] as string);
  if (names.length < 10)
    throw new Error(`coreToolNames read as ${names.length} names; the pattern has gone stale`);
  return names;
};

/**
 * The calibration arm's five, written out because they are a deliberate hand reduction rather than
 * a slice of anything garden defines: one way to run something, one to read, two to write, one to
 * stop. It is the smallest set on which a general agent has ever been shown to do real work, and
 * its only job here is to be obviously worse. If it is not obviously worse, the instrument is not
 * measuring what it claims to.
 */
export const FLOOR_TOOL_NAMES: readonly string[] = [
  'shell',
  'file_read',
  'file_write',
  'file_patch',
  'finish'
];
