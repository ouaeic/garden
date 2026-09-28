/**
 * The context configurations under comparison, and how a configuration is made to exist.
 *
 * The three constants this wave is arguing about - `RECENT_DETAIL_MESSAGES`,
 * `RECENT_TOOL_OUTPUT_MESSAGES` and `CACHE_CHECKPOINT_STRIDE` - are module-private integer
 * literals in `apps/worker/src/context.ts`. There is no option to pass and no export to override,
 * which is correct for shipped code and leaves a measurement rig with one honest choice: run the
 * real module with one integer changed.
 *
 * So a variant is the production source, verbatim, written to a scratch directory with the named
 * literals substituted and its two bare specifiers rewritten to absolute paths. Nothing is
 * reimplemented, which matters more here than anywhere: a hand-rolled copy of the squeeze would
 * measure the copy, and the copy is what a reader would then have to be persuaded is faithful.
 * `apps/worker/src/context.test.ts` reached the same conclusion for its own sweep and did it with
 * a Node loader hook; this is that technique with the patch written down instead of installed.
 *
 * The substitution asserts it matched exactly once. A rename upstream would otherwise turn every
 * variant into a silent copy of the shipped configuration, and every row in the report would agree
 * with every other row - which reads like a finding and is a broken harness.
 *
 * `configuration-fidelity` exists for the same reason from the other side: it names the shipped
 * values explicitly, so it goes through the whole patch path and must come out identical to
 * `shipped`, which imports the module directly. If those two ever disagree the rig is wrong and
 * every other number in the report is worthless.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as shippedContext from '../../apps/worker/src/context.js';

export type ContextModule = typeof shippedContext;

/**
 * One exact-text substitution in the copy of `context.ts` a configuration runs against.
 *
 * Constants cover every question this rig was built to ask, because every mechanism it compares was
 * already reachable by moving an integer. Some are not: the change that admits the agent's
 * reasoning to the compaction transcript is a line of code, and the choice was to measure it here
 * or to argue about it in prose. Argued in prose, it would be the only claim in this directory with
 * no row behind it.
 *
 * Held to the same discipline as a constant and for the same reason: `find` must match exactly once
 * and must differ from `replace`, so a rename upstream fails the run loudly instead of producing a
 * variant that is quietly the shipped module. That failure mode is not hypothetical here - see the
 * note on `contextModuleFor` about the shortcut that used to key on constants alone.
 */
export interface ContextEdit {
  /** Exact source text, matched once. Not a regex: a pattern that drifts is a silent copy. */
  readonly find: string;
  readonly replace: string;
}

export interface ContextConfiguration {
  readonly id: string;
  readonly label: string;
  readonly why: string;
  /** Integer literals substituted into a copy of `context.ts`. Empty means the shipped module. */
  readonly constants: Readonly<Record<string, number>>;
  /** Source substitutions, for a mechanism no integer reaches. Empty on every row but one. */
  readonly edits?: readonly ContextEdit[];
}

/** Named separately so the report can say which row is the one the tree currently ships. */
export const SHIPPED = 'shipped';

/**
 * The row that goes through the whole patch path to land on the shipped numbers. Named here rather
 * than spelled out at each use: it is the one configuration that is ALLOWED to be a copy of
 * `shipped`, so every check that exempts it has to be exempting the same string.
 */
export const FIDELITY = 'configuration-fidelity';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const contextSource = path.join(repositoryRoot, 'apps/worker/src/context.ts');

/**
 * The value a constant currently holds in the shipped source.
 *
 * Read rather than written down, because `configuration-fidelity` has to stay equal to `shipped`
 * across the very change this rig exists to argue about. Hard-coding 8 here would turn the day
 * step 3.1 lands `RECENT_DETAIL_MESSAGES = 2` into a fidelity failure that says the loader is
 * broken when what actually happened is that the tree moved.
 */
export const shippedConstant = (name: string): number => {
  const match = new RegExp(`const ${name} = (\\d[\\d_]*);`).exec(
    readFileSync(contextSource, 'utf8')
  );
  if (!match?.[1]) throw new Error(`context.ts no longer declares \`const ${name} = <integer>;\``);
  return Number(match[1].replaceAll('_', ''));
};

export const CONFIGURATIONS: readonly ContextConfiguration[] = [
  {
    id: SHIPPED,
    label: 'shipped',
    why: 'The tree as it stands. Every other row is this row with one integer changed.',
    constants: {}
  },
  {
    id: FIDELITY,
    label: 'shipped, via the patch path',
    why: 'The shipped values written back explicitly. Must equal `shipped` or the rig is lying.',
    constants: {
      RECENT_DETAIL_MESSAGES: shippedConstant('RECENT_DETAIL_MESSAGES'),
      RECENT_TOOL_OUTPUT_MESSAGES: shippedConstant('RECENT_TOOL_OUTPUT_MESSAGES')
    }
  },
  {
    id: 'detail-2',
    label: 'RECENT_DETAIL_MESSAGES 8 -> 2',
    why: "Step 3.1's candidate (a). Wave 0 priced it at cache-read 75.8 -> 86.4% on the large window.",
    constants: { RECENT_DETAIL_MESSAGES: 2 }
  },
  {
    id: 'tool-2',
    label: 'RECENT_TOOL_OUTPUT_MESSAGES 8 -> 2',
    why: "Step 3.1's candidate (b), and the plan's original headline. Wave 0 priced it at +0.1 points.",
    constants: { RECENT_TOOL_OUTPUT_MESSAGES: 2 }
  },
  {
    id: 'detail-4',
    label: 'RECENT_DETAIL_MESSAGES 8 -> 4',
    why: 'The middle this comparison exists to find: half the reasoning window rather than a quarter.',
    constants: { RECENT_DETAIL_MESSAGES: 4 }
  },
  {
    /**
     * The derived floor, not a guess.
     *
     * At request time the newest assistant message sits three from the tail on an ordinary step
     * (assistant, tool, runtime block) and four on a step where the plan version changed, and
     * `#noteStepBudget` can push one more twice a turn. The boundary is `index < length - N`, so
     * the assistant turn from k steps ago survives only while `N >= 3 + 2k` - four rather than
     * three on a plan step, five once the budget notice has landed.
     *
     * At N = 4 the current turn's own thinking is in the request on an ordinary step and on a plan
     * step, and out of it on a step carrying the budget notice. N = 5 is the tightest window that
     * carries it on every step of every turn, which is what this row is. At N = 2, measured rather
     * than reasoned about, it is absent on all sixty steps of all three trajectories.
     */
    id: 'detail-5',
    label: 'RECENT_DETAIL_MESSAGES 8 -> 5',
    why: "The tightest reasoning window that still carries the current turn's own thinking on every step.",
    constants: { RECENT_DETAIL_MESSAGES: 5 }
  },
  {
    id: 'detail-6',
    label: 'RECENT_DETAIL_MESSAGES 8 -> 6',
    why: 'One step of history above the floor, which is what a decision made on the previous step needs.',
    constants: { RECENT_DETAIL_MESSAGES: 6 }
  },
  {
    id: 'both-2',
    label: 'both windows 8 -> 2',
    why: 'Landing (a) and (b) together, which is what a wave that takes both recommendations ships.',
    constants: { RECENT_DETAIL_MESSAGES: 2, RECENT_TOOL_OUTPUT_MESSAGES: 2 }
  },
  {
    /**
     * The noise control, and the incident that moved it.
     *
     * A control has to be a configuration the tree does NOT ship. This row was `stride-4` while the
     * tree shipped stride 8; step 3.1 then landed stride 4, and the control silently became a copy
     * of `shipped` - byte-identical on all 27 rows, reporting a reassuring `+0.00` that was an
     * identity rather than a measurement. Wave 3's gate caught it (WAVE-3-GATE.md section 7, Q-1).
     * It now names 8, the value the tree shipped until 3.1, so the arm is a genuinely different
     * configuration again and its quality delta is once more a statement about noise in the rig.
     *
     * `degenerateConfigurations` below is the part that means this cannot happen a third time
     * quietly: the next time the tree moves onto a control's value, the run says so and fails.
     */
    id: 'stride-8',
    label: 'CACHE_CHECKPOINT_STRIDE 4 -> 8',
    why: 'The stride the tree shipped before step 3.1 halved it. Content-neutral, so this row is the control: any quality movement here is noise in the rig.',
    constants: { CACHE_CHECKPOINT_STRIDE: 8 }
  },
  {
    /**
     * The bound on the owner's accumulated text switched off, which is the tree as it stood before
     * that bound existed.
     *
     * It is here for the reason `anchorless` is: a mechanism whose absence the rig cannot show is
     * a mechanism nobody can price. `planCompaction` may not condense a `user` message, so once
     * the owner's own accumulated turns fill the space between the protected head and the tail it
     * has promised to keep, the region it may touch holds nothing else and it returns null with no
     * candidate at all - on a recorded trajectory carrying 128,151 characters of owner text, 651
     * of 888 attempts. The window then climbs past its own budget and the deterministic passes
     * replace two thirds of it with one-line stubs.
     *
     * Switched off by raising the bound's own floor past any window rather than by deleting a
     * line: the floor is what `ownerWindowChars` returns when the derived budget is smaller, so a
     * floor larger than the trajectory is the bound never binding. The three original trajectories
     * cannot show any of this - they carry one mid-task owner message of 600 characters, so the
     * bound never fires on them and this row is byte-identical to `shipped` there.
     * `pool-migration-131k-owner` is the trajectory that can, and the `refuse` column is where it
     * shows.
     */
    id: 'owner-unbounded',
    label: 'OWNER_WINDOW_FLOOR_CHARS 8,000 -> 100,000,000 (the bound off)',
    why: 'The tree before the owner-text bound: what compaction does on a task where the owner keeps typing. The `refuse` column is the whole of this row.',
    constants: { OWNER_WINDOW_FLOOR_CHARS: 100_000_000 }
  },
  {
    /**
     * The witness that the probes discriminate at all, and the answer to "a probe that always
     * returns 5.00 is measuring nothing".
     *
     * Every other row narrows one window by a step or two, which is the range worth arguing about
     * and is also a range in which the artifact probe does not move at all: it reads 3.00 in every
     * compacted configuration and 5.00 in every uncompacted one, so on the axis this rig exists to
     * measure that column was a constant. A constant column is indistinguishable from a probe that
     * has stopped reading the window, and a rig one wave old should not be trusted on the strength
     * of a number nothing has ever been able to move.
     *
     * This row is deliberately outside the arguable range and nobody should ever ship it. It takes
     * every character bound the window has down to a value that keeps a marker and little else, so
     * each probe kind can be shown to fall when its material is genuinely gone. `rigFailures` in
     * run.ts is the assertion that uses it: if a probe kind stops moving even here, that column is
     * furniture and the run says so.
     *
     * The four constants are the four mechanisms that can take a written path away, and which one
     * does the work is the finding this row produced. A path is written into the head of the tool
     * result (`{"ok":true,"path":...`) AND into the head of the `file_write` call's arguments, and
     * `truncateMiddle` keeps 62% of what is left as head - so every ordinary cut in this codebase
     * keeps the path and the artifact probe is unmovable by the squeeze at any sane bound. Only two
     * things remove one: a compaction that replaces the message outright, and a bound low enough
     * that the head itself is shorter than the path. Hence 200/120/40 rather than a gentle nudge,
     * and hence the ledger's ARTIFACTS WRITTEN block - the loss is structural, not a tuning error.
     */
    id: 'starved',
    label: 'every character bound at its destructive end',
    why: 'Not a candidate: the destructive end of every window mechanism at once, so each probe kind can be shown to fall when its material is actually gone. It also holds the owner-goal control at 5.00, which is what makes that control worth reading elsewhere.',
    constants: {
      TOOL_OUTPUT_SQUEEZE_FLOOR_CHARS: 200,
      OLDER_TOOL_OUTPUT_CHARS: 120,
      COMPACTED_TOOL_ARGUMENT_CHARS: 40,
      RECENT_TOOL_OUTPUT_CHARS: 300,
      MAX_BRIEF_SECTION_CHARS: 400,
      /*
       * Added when the anchor index landed, and the rig's own furniture guard is why.
       *
       * The anchor index is a model-free regex harvest of exact identifiers out of the span a
       * compaction is about to drop, appended to the brief section AFTER its bound - deliberately,
       * so a long summary can never crowd the identifiers out. That means no bound this row
       * already sets can reach it, and with the paths surviving everywhere the artifact column
       * read 5.00 in every configuration of every trajectory: a saturated column, which the guard
       * in run.ts correctly refuses to accept as evidence, because a column that cannot move looks
       * identical whether the mechanism works or the probe has stopped reading the window.
       *
       * This row is "the destructive end of every window mechanism at once", and a new mechanism
       * arrived that it did not touch. Zeroing the budget is that end for this one. It restores
       * the contrast the column is read for - 5.00 against 3.00 on both compacted trajectories.
       */
      ANCHOR_INDEX_CHARS: 0,
      /*
       * Added when the owner-text bound landed, for the reason the two entries either side of it
       * were: this row is "the destructive end of every window mechanism at once", and a bound
       * derived from the room a compaction actually needs is not at its destructive end. Reserving
       * more tokens than any tail holds makes the derived budget zero, so the class falls to
       * `OWNER_WINDOW_FLOOR_CHARS` on every window, which is what lets the owner columns fall here
       * and nowhere else.
       */
      OWNER_WINDOW_RESERVE_TOKENS: 1_000_000,
      /*
       * Added when the artifact ledger landed, for exactly the reason `ANCHOR_INDEX_CHARS` above
       * was: this row is "the destructive end of every window mechanism at once", and the ledger is
       * a new mechanism it did not touch. The block is re-rendered at the tail from durable state on
       * every step, so no character bound in `context.ts` can reach it and no compaction boundary
       * can cross it - with it on, the artifact column read 5.00 in every configuration of every
       * trajectory and the frozen-column guard in run.ts correctly refused the run.
       *
       * Zero rows is this mechanism's destructive end: `recordArtifactWrite` evicts every row it is
       * given and `artifactLedgerBlock` renders nothing, which is the same window this rig measured
       * before the block existed.
       */
      ARTIFACT_LEDGER_ROWS: 0
    }
  },
  {
    /**
     * The one mechanism that carried a written path through a compaction before the ledger did, off
     * and nothing else changed.
     *
     * The anchor index is a model-free regex harvest of exact identifiers out of the span a
     * compaction is about to drop, appended to the brief section after its own bound - so on this
     * fixture it has been holding all five written paths on its own, and `artifact-files-touched`
     * reads 5.00 everywhere except `starved`. That makes the shipped rows unable to say anything
     * about whether the ledger works, because nothing on them is lost for it to hold.
     *
     * This row is the isolation. Measured on both compacted trajectories at the commit that wired
     * the block in: with the ledger switched off as well, `artifact-files-touched` reads 3.00 here
     * and two of the five paths are gone; with the ledger on it reads 5.00. That is the whole of
     * the ledger's effect on this rig's own axis, and it is a row rather than a sentence so it is
     * re-measured on every run.
     */
    id: 'anchorless',
    label: 'ANCHOR_INDEX_CHARS 700 -> 0',
    why: 'The anchor index off and nothing else, which is the only shipped mechanism that carried a written path through a compaction before the ledger did.',
    constants: { ANCHOR_INDEX_CHARS: 0 }
  },
  {
    /**
     * The one channel a compaction could not see, taken back out of the transcript the summariser
     * reads. This row used to run the other way round and it is the reason the line shipped.
     *
     * `transcriptLine` now renders a condensed message from `content`, `toolCalls` AND `reasoning`.
     * Before it did, the agent's working out was discarded BEFORE any model was asked to
     * summarise, while `compactionRequest` instructed that summariser to preserve "decisions taken
     * and the reason for them, including approaches that were tried and rejected" and garden's own
     * preamble told the model to put exactly that material in the reasoning channel: "Working out -
     * options weighed, what to try next, talking yourself through it - goes in the reasoning
     * channel, or nowhere." The harness was hiding the answer and then asking for it.
     *
     * That is the garden-shaped reading of Terminus 2's summarise-interrogate-answer pass. Their
     * third agent is given the full history and can therefore reach what their summariser dropped;
     * garden's summariser cannot be given a third agent's advantage by asking it better questions,
     * because the advantage is access rather than attention. One line of source bought the access.
     *
     * The row is inverted rather than deleted, for the reason `owner-unbounded` and `anchorless`
     * are switched off rather than removed: a mechanism whose absence the rig cannot show is a
     * mechanism nobody can price, and a cost written into prose stops being re-measured the day it
     * is written. Inverted, the `summ-in` delta on this row IS what the shipped line costs, taken
     * fresh on every run. Do not read the delta's sign as the direction of the change: this row is
     * the tree before the line landed, so a NEGATIVE delta here is the shipped line's positive cost.
     *
     * Inverting it also makes a REVERT loud, which nothing else here would. `summariserTokens` is
     * checked as a ceiling and never as a floor, so putting `transcriptLine` back the way it was
     * would drop every row's bill and pass `--ci` in silence. It would not pass this row: the anchor
     * below is the shipped code, so a revert removes it and `patch` throws the way it did the day
     * this row still asked for the edit that had just shipped.
     *
     * On `pool-migration-131k-uncompacted` that cost reads +10.3% against +47% elsewhere, and the
     * reason is a bound rather than the fixture: `compactionTranscript` caps the whole transcript at
     * 80,000 characters, and that trajectory's single compaction is the only one in the matrix that
     * reaches it - 72,299 characters on this row and exactly 80,000 on `shipped`, measured at the
     * summariser call. Everything past the cap is cut out of the middle instead of being billed, so
     * that row's cost is clipped and this rig does not measure by how much.
     *
     * `trajectorySummary` is deliberately not part of the inversion, because it is not part of the
     * shipped line either: its output goes straight into the window under a 12,000-character cap
     * with no model in between, so reasoning there displaces prose one for one. It still renders
     * content and tool NAMES only.
     *
     * READ THE ROW AS A COST, NOT AS A GAIN. This rig scores what reaches the prepared window, and
     * what reaches the window is whatever the summariser kept. The summariser here is
     * `extractiveSummariser`, which keeps the front of every transcript line - and the reasoning is
     * appended at the END of the line, so this row moves the summariser's INPUT and cannot move its
     * output. The availability column therefore says nothing about whether a real summarising model
     * would keep the material, and the honest measurement of that needs the judged half to compact
     * with a real summariser, which it does not do today. @see measure.ts on `extractiveSummariser`.
     */
    id: 'reasoning-dropped',
    label: "transcriptLine drops the agent's reasoning (the tree before that line)",
    why: 'The shipped compaction transcript carries the channel garden tells the model to reason in. This row is that line taken back out, so what it costs is re-measured rather than remembered; it cannot show what it buys.',
    constants: {},
    edits: [
      {
        find: [
          '  const thought = message.reasoning',
          "    ? truncateMiddle(message.reasoning.replace(/\\s+/g, ' ').trim(), limit, 'condensed reasoning')",
          "    : '';",
          "  return `- ${message.role === 'user' ? 'User' : 'Agent'}${calls ? ` called ${calls}` : ''}: ${",
          "    content || 'no prose response'",
          "  }${thought ? ` [reasoned: ${thought}]` : ''}`;"
        ].join('\n'),
        replace: [
          "  return `- ${message.role === 'user' ? 'User' : 'Agent'}${calls ? ` called ${calls}` : ''}: ${",
          "    content || 'no prose response'",
          '  }`;'
        ].join('\n')
      }
    ]
  }
];

/**
 * Configurations that have quietly become copies of the shipped one.
 *
 * A row whose constants all name the values the tree already ships is byte-identical to `shipped`
 * on every measurement, and its delta is `+0.00` by construction rather than by measurement. That
 * is not a null result, it is an identity, and it reads exactly like a reassuring one - which is
 * what happened to `stride-4` when step 3.1 landed stride 4 and nothing in this directory noticed
 * for a whole wave. `configuration-fidelity` is exempt because being that copy is its entire job.
 *
 * THIS FUNCTION ONLY CHECKS CONSTANTS. It cannot see the same drift in a row carrying edits, and it
 * is not the guard that catches one. An edit row goes stale the way `reasoning-in-transcript` did
 * when its edit shipped verbatim into `transcriptLine`: the tree stopped containing the anchor, so
 * `patch` counted zero occurrences and threw, and the whole run stopped rather than printing a row.
 * That is the guard here, and it is loud, immediate and unmissable - but it names a missing anchor
 * rather than a shipped mechanism, so read that error as "the tree has moved past this row" before
 * you read it as "the anchor string has a typo". The self-replace check below `patch`'s occurrence
 * count covers only the narrower case where somebody edits a row to replace its anchor with itself.
 */
export const degenerateConfigurations = (): readonly string[] =>
  CONFIGURATIONS.filter(
    (configuration) =>
      configuration.id !== SHIPPED &&
      configuration.id !== FIDELITY &&
      // A row carrying edits is never degenerate on its constants alone, and this function has no
      // way to judge its edits: whether an edit still differs from the tree is a question about
      // `context.ts`, which only `patch` reads. `patch` answers it - an anchor that no longer
      // occurs, or one replaced by itself, throws there. See the note above this function.
      !configuration.edits?.length &&
      Object.keys(configuration.constants).length > 0 &&
      Object.entries(configuration.constants).every(
        ([name, value]) => shippedConstant(name) === value
      )
  ).map(
    (configuration) =>
      `${configuration.id} names the values context.ts already ships, so its row is a copy of ${SHIPPED} and its delta is +0.00 by construction. Move it to a value the tree does not ship, or delete it.`
  );

/**
 * Every specifier `context.ts` imports at runtime, and where each one really lives.
 *
 * A variant lives outside the workspace, so neither kind of specifier reaches its target from
 * there: package resolution does not find `@garden/*`, and a relative path resolves against the
 * scratch directory, which holds one file. Both are rewritten to the file they would have resolved
 * to under the `development` condition this rig already runs with, and a rewritten module then
 * resolves its OWN imports from its real directory, so only what `context.ts` names belongs here.
 *
 * The `includes` check below is the drift guard, and it is why this list is worth keeping by hand:
 * an import that is renamed or dropped fails the rig loudly instead of producing a variant that
 * cannot be loaded three configurations later.
 */
const SPECIFIERS: ReadonlyArray<readonly [string, string]> = [
  ['@garden/model-gateway', 'packages/model-gateway/src/index.ts'],
  ['@garden/data', 'packages/data/src/index.ts'],
  ['./output-spill.js', 'apps/worker/src/output-spill.ts'],
  ['@garden/contracts/permission-policy', 'packages/contracts/src/permission-policy.ts']
];

let scratch: string | undefined;
const scratchDirectory = (): string => {
  scratch ??= mkdtempSync(path.join(tmpdir(), 'garden-context-quality-'));
  // Outside the repository, so nothing here can be committed by accident, and the copy needs its
  // own module declaration because the directory it lands in has no package.json above it.
  writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');
  return scratch;
};

const loaded = new Map<string, Promise<ContextModule>>();

const patch = (configuration: ContextConfiguration): string => {
  let source = readFileSync(contextSource, 'utf8');
  for (const [specifier, target] of SPECIFIERS) {
    const quoted = `'${specifier}'`;
    if (!source.includes(quoted))
      throw new Error(
        `context.ts no longer imports ${specifier}; the variant loader in evals/context-quality/configurations.ts needs updating`
      );
    source = source.replaceAll(
      quoted,
      JSON.stringify(pathToFileURL(path.join(repositoryRoot, target)).href)
    );
  }
  for (const [name, value] of Object.entries(configuration.constants)) {
    const pattern = new RegExp(`const ${name} = \\d[\\d_]*;`, 'g');
    const matches = source.match(pattern) ?? [];
    if (matches.length !== 1)
      throw new Error(
        `expected exactly one \`const ${name} = <integer>;\` in context.ts, found ${matches.length}. A silent miss here would make every configuration identical.`
      );
    source = source.replace(pattern, `const ${name} = ${value};`);
  }
  for (const edit of configuration.edits ?? []) {
    const occurrences = source.split(edit.find).length - 1;
    if (occurrences !== 1)
      throw new Error(
        `expected exactly one occurrence of the anchor for ${configuration.id} in context.ts, found ${occurrences}. A silent miss here would make this row a copy of ${SHIPPED}.`
      );
    if (edit.find === edit.replace)
      throw new Error(
        `${configuration.id} replaces its anchor with itself, so its row is a copy of ${SHIPPED} and its delta is +0.00 by construction.`
      );
    source = source.replace(edit.find, edit.replace);
  }
  return source;
};

/**
 * The module a configuration runs against. `shipped` is the real import rather than a patched copy
 * of itself, so at least one row in every report is unambiguously the code that ships.
 *
 * The shortcut asks about edits as well as constants. Keyed on constants alone - which is what it
 * used to be, because constants were the only kind of variant there was - a row carrying only edits
 * would have been handed the shipped module and printed a `+0.00` that was an identity rather than
 * a measurement. That is the exact failure `degenerateConfigurations` above exists to refuse, and
 * it would have arrived through the loader instead of through a value.
 */
export const contextModuleFor = (configuration: ContextConfiguration): Promise<ContextModule> => {
  if (!Object.keys(configuration.constants).length && !configuration.edits?.length)
    return Promise.resolve(shippedContext);
  const existing = loaded.get(configuration.id);
  if (existing) return existing;
  const directory = scratchDirectory();
  const file = path.join(directory, `context-${configuration.id}.ts`);
  writeFileSync(file, patch(configuration));
  const started = import(pathToFileURL(file).href) as Promise<ContextModule>;
  loaded.set(configuration.id, started);
  return started;
};
