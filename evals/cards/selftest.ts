/**
 * The checks for the half of this rig that running it cannot exercise.
 *
 *   NODE_OPTIONS=--conditions=development pnpm exec tsx evals/cards/selftest.ts
 *
 * The run proves a good deal about itself every time: it drives the shipped classifier and prints
 * what it said, and a baseline catches the counts moving. What it cannot prove is that the table is
 * a measurement at all, and every failure in that class produces a plausible table rather than an
 * error:
 *
 *   - a tool name with a typo in it is a call the floor has no rule for, so the scenario quietly
 *     gets cheaper and the row still reads like a task;
 *   - the guard tables are assertions that pass by doing nothing on a good day, so a table that had
 *     stopped being consulted would be silent in exactly the same way as a table that held;
 *   - the sink declaration is the one piece of this rig that can be used to silence the rig, and
 *     both halves of the rule that stops that live in a branch nobody reaches on a good day;
 *   - `check` is the whole point of the committed baseline and it runs only under `--ci`, so a
 *     comparison that had stopped comparing would be discovered by a regression getting through;
 *   - a column where every row reads the same number is furniture: it would keep printing whatever
 *     it printed last if it had stopped looking at the classifier altogether.
 *
 * A plain script rather than a vitest file, for the reason `evals/arms/selftest.ts` gives: `evals/`
 * is not a workspace package, so nothing here is collected by `pnpm -r test`. It exits non-zero on
 * the first run that finds anything, and it is on the every-change gate in verify.yml beside the
 * other three.
 */
import { untrustedOriginOfResult } from '../../apps/worker/src/provenance.js';
import { approvalRequirement } from '../../apps/worker/src/tools.js';
import { agentToolsFor } from '../../apps/worker/src/tool-catalogue.js';
import { EGRESS, READS, SINKS, TAINTS, WRITES, egressCall } from './guards.js';
import { declarationFailures, guardFailures, measureAll, provenanceFailures } from './measure.js';
import { baselineFrom, check, rigIdentity, totals } from './report.js';
import { MODES, SCENARIOS, type Scenario } from './scenarios.js';

const failures: string[] = [];
const expect = (condition: boolean, what: string): void => {
  if (!condition) failures.push(what);
};

/* ----------------------------------------------- every call names a tool garden actually sends */

/*
 * The cheapest way for this rig to be wrong. `approvalRequirement` answers null for a name it has
 * no rule for, which is correct - the floor is not a spell-checker - so `file_wrote` or
 * `connector_action{mail_repy}` costs a scenario a card and reads exactly like a saving. Checked
 * against the catalogue the worker actually sends rather than a list kept here, because a list kept
 * here is one rename away from agreeing with nothing.
 */
const shipped = new Set(agentToolsFor().map((tool) => tool.name));
for (const scenario of SCENARIOS)
  for (const call of scenario.calls)
    expect(
      shipped.has(call.name),
      `${scenario.id} calls "${call.name}", which garden does not send: a name with a typo in it is a call the floor has no rule for, and the scenario silently gets cheaper`
    );
for (const entry of [...WRITES, ...READS])
  expect(
    shipped.has(entry.call.name),
    `the guard "${entry.id}" calls "${entry.call.name}", which garden does not send`
  );
for (const entry of SINKS)
  expect(
    shipped.has(entry.call.name),
    `the sink guard "${entry.id}" calls "${entry.call.name}", which garden does not send`
  );

/* ------------------------------------------------------- the guard tables are consulted at all */

/**
 * One planted table, and every other one empty - which is what every plant below meant and only
 * three of them said.
 *
 * `guardFailures` takes twelve tables positionally, each defaulting to the SHIPPED one. The plants
 * were written as they were added, so a plant for the fourth table passed three empty arrays and
 * stopped, and the remaining nine quietly fell back to the shipped rows. Every count below was
 * therefore `the planted failures + whatever the shipped tables report`, which is only the planted
 * number while the shipped tables report zero - exactly the state in which this file has nothing
 * left to catch. It is why one wave's break produced fourteen unrelated selftest failures and
 * nobody could tell which plant had actually moved.
 *
 * Named rather than positional, so a table added to `guardFailures` cannot silently re-enter these
 * counts: an unnamed table is `[]` here, and a plant that means to drive it has to say so.
 *
 * `uncovered` is the one that may legitimately be handed `undefined`. That is not "no table" - it
 * is "the shipped allowlist coverage", which is the whole of the check one plant below makes - so
 * it is passed through when the caller names it and defaulted to `[]` when it does not.
 */
type GuardTables = Parameters<typeof guardFailures>;
const plant = (tables: {
  writes?: GuardTables[0];
  reads?: GuardTables[1];
  sinks?: GuardTables[2];
  publishes?: GuardTables[3];
  free?: GuardTables[4];
  confined?: GuardTables[5];
  egress?: GuardTables[6];
  uncovered?: GuardTables[7];
  destroys?: GuardTables[8];
  freeStore?: GuardTables[9];
  freeWorkspaceDeletes?: GuardTables[10];
  stopsTheComputer?: GuardTables[11];
  taints?: GuardTables[12];
  /** The taint reader. Omitted is the shipped one, which is what the taint rows are written for. */
  reader?: GuardTables[13];
}): ReturnType<typeof guardFailures> =>
  guardFailures(
    tables.writes ?? [],
    tables.reads ?? [],
    tables.sinks ?? [],
    tables.publishes ?? [],
    tables.free ?? [],
    tables.confined ?? [],
    tables.egress ?? [],
    'uncovered' in tables ? tables.uncovered : [],
    tables.destroys ?? [],
    tables.freeStore ?? [],
    tables.freeWorkspaceDeletes ?? [],
    tables.stopsTheComputer ?? [],
    tables.taints ?? [],
    tables.reader
  );

/*
 * A planted entry of each kind, pushed through the real `guardFailures`. This is the mutation
 * discipline applied to the rig rather than to the product: a guard table that had been dropped
 * from the walk, or a comparison written the wrong way round, is silent on the shipped tables and
 * caught here in about a microsecond.
 */
const inertWrite = {
  id: 'planted: a call that writes nothing',
  call: { name: 'file_read', arguments: { path: 'workspace/notes.md' }, step: 'planted' }
};
expect(
  plant({ writes: [inertWrite] }).length === MODES.length,
  'the writes guard does not report a call that raises no card, so a genuine write going quiet would be silent'
);
/*
 * `.git/hooks/pre-commit` rather than `.bashrc`, and the swap is the deferred-execution rule being
 * narrowed rather than this plant being weakened. A `file_write('.bashrc')` no longer cards,
 * because `assertUserDataPath` folds it to `workspace/.bashrc` and no login shell reads that - the
 * `CONFINED` table now holds that claim from both sides. A hook written into the project directory
 * the agent works in is still run by git, so it is still a card and still a working plant.
 */
const cardingRead = {
  id: 'planted: a read that is really a write',
  call: {
    name: 'file_write',
    arguments: { path: '.git/hooks/pre-commit', content: 'x' },
    step: 'planted'
  },
  modes: ['balanced'] as const
};
expect(
  plant({ reads: [cardingRead] }).length === 1,
  'the reads guard does not report a call that cards, so the deferred-execution rule widening back over every read would be silent'
);
expect(
  plant({
    sinks: [
      {
        id: 'planted: not a sink at all',
        call: { name: 'file_read', arguments: { path: 'a.md' }, step: 'planted' },
        mode: 'balanced' as const
      }
    ]
  }).length === 1,
  'the sinks guard does not report a call the provenance floor never stops, so provenance switching off would be silent'
);
expect(
  plant({
    sinks: [
      {
        id: 'planted: cards whether or not anything was read',
        call: {
          name: 'publish_preview',
          arguments: { label: 'x', port: 1, reach: 'public' },
          step: 'planted'
        },
        mode: 'balanced' as const
      }
    ]
  }).length === 1,
  'the sinks guard does not report a call that cards on a clean turn, so it would accept provenance being paid for unconditionally'
);

/*
 * The three tables added with the registry-publish rule and the deferred-execution narrowing, each
 * planted the same way. `guardFailures` takes them after the three above, so every call here passes
 * the earlier ones empty and the shipped tables stay out of the count.
 */
expect(
  plant({
    publishes: [
      {
        // A call no mode cards, so all three count. Review cards every `shell` call by definition,
        // which would make a shell plant here a two rather than a three and hide the mode it missed.
        id: 'planted: a call that publishes nothing',
        call: { name: 'file_read', arguments: { path: 'workspace/notes.md' }, step: 'planted' }
      }
    ]
  }).length === MODES.length,
  'the publishes guard does not report a command that raises no card, so npm publish going quiet again would be silent'
);
expect(
  plant({
    free: [
      {
        id: 'planted: ordinary work that cards',
        call: {
          name: 'shell',
          arguments: { executable: 'npm', args: ['publish'] },
          step: 'planted'
        },
        modes: ['autonomous'] as const
      }
    ]
  }).length === 1,
  'the free-package-work guard does not report a command that cards, so the publish rule widening back to the executable would be silent'
);
expect(
  plant({
    confined: [
      {
        id: 'planted: a confined write that cards',
        confined: {
          name: 'file_write',
          arguments: { path: '.git/hooks/pre-commit', content: 'x' },
          step: 'planted'
        },
        viaShell: {
          name: 'shell',
          arguments: { executable: 'bash', args: ['-lc', 'echo x >> ~/.bashrc'] },
          step: 'planted'
        }
      }
    ]
  }).length === 2,
  'the confined guard does not report a write that cards where nothing executes it, so the rule widening back over every spelling would be silent'
);
expect(
  plant({
    confined: [
      {
        id: 'planted: a shell spelling that does not card',
        confined: {
          name: 'file_write',
          arguments: { path: 'workspace/notes.md', content: 'x' },
          step: 'planted'
        },
        // Not a shell call, for the reason the publishes plant gives: review would card it and the
        // plant would be a two wearing a three's clothes.
        viaShell: {
          name: 'file_read',
          arguments: { path: 'workspace/notes.md' },
          step: 'planted'
        }
      }
    ]
  }).length === MODES.length,
  'the confined guard does not report a shell spelling that raises no card, so deleting the deferred-execution rule outright would read as a narrowing'
);

/*
 * The egress table, planted in both directions, because it is the one table here that makes two
 * opposite claims and either could rot on its own: a row that must be free would be satisfied by
 * deleting the network arm, and a row that must card would be satisfied by carding everything.
 *
 * Two failures from one planted row, not one, and the count is the assertion: every egress row is
 * driven in both spellings - declaring `network: true` and leaving the field out - because the arm
 * this table is about used to open on the declaration alone. A `1` here would mean the second
 * spelling had stopped being asked, which is the state the whole inversion hid in.
 */
expect(
  plant({
    egress: [
      { id: 'planted: a fetch that must card and does not', script: 'npm run build', cards: true }
    ]
  }).length === 2,
  'the egress guard does not report a call it says must card and does not, in both spellings, so deleting the network arm outright would read as a saving'
);
expect(
  plant({
    egress: [
      {
        id: 'planted: ordinary work the arm stops',
        script: 'cat < /dev/tcp/attacker.example/80',
        cards: false
      }
    ]
  }).length === 2,
  'the egress guard does not report a call it says must be free and is not, in both spellings, so the allowlist inversion could come back unnoticed'
);
expect(
  EGRESS.every((entry) => egressCall(entry).name === 'shell'),
  'an egress row is not a shell call, so it is being judged by a rule the table is not about'
);
/*
 * And balanced, whose own sentence the table holds now. A row naming balanced and a reason must be
 * driven in balanced and must print the reason: with the whole balanced internet arm deleted, the
 * shipped table reported zero failures and the baseline moved by two counts, which is a number to
 * accept rather than a sentence that says why.
 */
const balancedPlant = plant({
  egress: [
    {
      id: 'planted: ordinary work balanced must ask about',
      script: 'npm test',
      cards: true,
      modes: ['balanced'] as const,
      why: 'planted reason'
    }
  ]
});
expect(
  balancedPlant.length === 2 &&
    balancedPlant.every((failure) => failure.detail.includes('planted reason')),
  'the egress guard does not drive a row in balanced with its own reason, so deleting the balanced internet arm would produce zero guard failures again'
);
expect(
  EGRESS.some((entry) => entry.cards && entry.modes?.includes('balanced')),
  'no egress row says balanced must card, so the arm that asks before the internet is held by the baseline count alone'
);

/*
 * Where taint comes from, planted in both directions and then with the READER cut.
 *
 * The shipped rows are written to pass against the shipped reader, so no row in the table can plant
 * a failure - which is exactly the state in which a table that had stopped being consulted would be
 * silent. The reader is therefore injected, as the floor is in the declaration check, and the plant
 * is the break this table exists for: the estate cleared, every private and estate-named address
 * judged as this computer's own output.
 */
expect(
  plant({
    taints: [
      {
        id: 'planted: a read that must taint and does not',
        call: { name: 'shell', arguments: { executable: 'npm', args: ['test'] }, step: 'planted' },
        taints: true
      }
    ]
  }).length === 1,
  'the taints guard does not report a read the classifier fails to recognise, so the taint reader going quiet would be silent'
);
expect(
  plant({
    taints: [
      {
        id: 'planted: a stated limit the reader has grown past',
        call: {
          name: 'shell',
          arguments: { executable: 'curl', args: ['-s', 'https://vendor.example/brief'] },
          step: 'planted'
        },
        taints: false,
        why: 'planted reason'
      }
    ]
  }).some((failure) => failure.table === 'taints' && failure.detail.includes('planted reason')),
  'the taints guard does not report a stated limit the reader has grown past, so coverage could grow past a decision without the decision being re-made'
);
const PRIVATE_ADDRESS =
  /\b(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)|\.(?:internal|local|home\.arpa)\b/;
const clearsTheEstate: typeof untrustedOriginOfResult = (call, result) =>
  PRIVATE_ADDRESS.test(JSON.stringify(call.arguments))
    ? null
    : untrustedOriginOfResult(call, result);
const estateCut = plant({ sinks: SINKS, taints: TAINTS, reader: clearsTheEstate });
expect(
  estateCut.some((failure) => failure.table === 'taints') &&
    estateCut.some((failure) => failure.table === 'sinks'),
  'with the estate cleared out of the taint reader, neither the taint rows nor the estate sink rows report it - which is the break that was invisible to every rig'
);
expect(
  plant({ sinks: SINKS, taints: TAINTS }).length === 0,
  'the shipped taint reader fails a shipped taint or sink row, so a row is wrong or the reader is'
);
expect(
  TAINTS.some((entry) => entry.taints) &&
    TAINTS.some((entry) => !entry.taints && entry.why === undefined) &&
    TAINTS.some((entry) => !entry.taints && entry.why !== undefined),
  'the taint table has lost a direction: it needs reads that must taint, reads that must not, and stated limits with their reasons'
);
/*
 * And the coverage half. `noEgressExecutables` is the list that decides which segments of a script
 * are not asked to be network clients, so a name wrongly on it is a card that stops firing - and on
 * a healthy tree every name has a row, which means nothing in the shipped tables can plant a
 * failure in this check. The uncovered list is therefore injected, exactly as the floor is in the
 * declaration check below.
 */
expect(
  plant({ uncovered: ['planted-allowlist-name'] }).length === 1,
  'the egress guard does not report an allowlist name with no row beside a fetch, so a name could be added to noEgressExecutables and never be consulted here'
);
expect(
  plant({ uncovered: undefined }).length === 0,
  'the coverage check reports the shipped allowlist, so a name is on noEgressExecutables that no row pairs with a fetch'
);

/*
 * The stores and the schedules, planted in both directions for the reason the egress pair gives.
 *
 * A table of acts that must card is satisfied by a floor that cards everything, and the
 * counterweight is a table of ordinary database, container and cache work that must not - which is
 * satisfied by deleting the rule. Neither plant is reachable from the shipped tables: on a healthy
 * tree both are empty, so each is injected as the only row.
 *
 * `dropdb` and `psql -f` rather than something invented, because the pair is the whole decision
 * this wave turned on: `psql` is not `psql -c "DROP DATABASE"`, and the owner's own scenario runs
 * the file form twice.
 */
expect(
  plant({
    destroys: [
      {
        id: 'planted: a drop the floor lets through',
        call: { name: 'file_read', arguments: { path: 'db/schema.sql' }, step: 'planted' }
      }
    ]
  }).length === MODES.length,
  'the destroys guard does not report an act that raises no card, so dropdb and FLUSHALL going quiet again would be silent'
);
expect(
  plant({
    freeStore: [
      {
        id: 'planted: a migration the floor stops',
        call: {
          name: 'shell',
          arguments: { executable: 'psql', args: ['-c', 'DROP DATABASE production'] },
          step: 'planted'
        },
        modes: ['balanced', 'autonomous'] as const
      }
    ]
  }).length === 2,
  'the free-store guard does not report ordinary database work that cards, so the destruction rule widening back to the executable would be silent'
);

/*
 * Where a delete lands, planted in both directions for the third time in this file and for the
 * reason the first two give. A table of deletes that must be free is satisfied by a floor with no
 * destructive rule left in it; a table of acts that must card is satisfied by a floor that cards
 * everything. Neither plant is reachable from the shipped tables: on a healthy tree both are empty.
 *
 * `rm -rf ~/.ssh` and `rm -rf dist` rather than something invented, because that pair is the whole
 * decision this wave turned on - `dist` is inside the undo point and `~/.ssh` is outside it, under
 * `HOME` at `<workspaceRoot>/.home`, which is what makes the difference invisible to a rule that
 * only asks whether a path is inside the root.
 */
expect(
  plant({
    freeWorkspaceDeletes: [
      {
        id: 'planted: a delete inside the undo point that cards',
        call: {
          name: 'shell',
          arguments: { executable: 'rm', args: ['-rf', '~/.ssh'] },
          step: 'planted'
        },
        modes: ['balanced', 'autonomous'] as const
      }
    ]
  }).length === 2,
  'the free-workspace-deletes guard does not report a recoverable delete that cards, so the location test could be reverted and the run would read as unchanged'
);

/*
 * The THIRD direction of the same table, planted separately because it is a separate claim and was
 * added long after the other two: the exemption is bought with "a rewind puts it back", so it is
 * owed only on a turn that HAS a rewind, and the guard asks the same rows again with the undo-point
 * fact taken away.
 *
 * `file_read` rather than a delete, and the choice is the whole plant. A delete cards in both
 * directions and would report through the loop above instead, which is a plant that proves the
 * check it is not aimed at. A call no mode cards is free with the fact and free without it, so the
 * only arm that can report it is the one being planted - three modes, one per mode.
 */
expect(
  plant({
    freeWorkspaceDeletes: [
      {
        id: 'planted: an exemption granted on a rewind that does not exist',
        call: { name: 'file_read', arguments: { path: 'workspace/notes.md' }, step: 'planted' }
      }
    ]
  }).length === MODES.length,
  'the free-workspace-deletes guard does not report a delete that stays free on a turn with no undo point, so the checkpoint fact could stop being read and the saving would look unchanged'
);
expect(
  plant({
    stopsTheComputer: [
      {
        // A call no mode cards, so all three count. Review cards every `shell` call by definition,
        // which would make a shell plant here a two wearing a three's clothes.
        id: 'planted: an act that stops nothing',
        call: { name: 'file_read', arguments: { path: 'workspace/notes.md' }, step: 'planted' }
      }
    ]
  }).length === MODES.length,
  'the stops-the-computer guard does not report an act that raises no card, so kill -9 1 and the shutdown family going quiet would be silent'
);

/* ------------------------------------------------- declaring the network cannot start costing */

/*
 * The plant here has to be a FLOOR and not a call, and the reason is the repair itself: nothing in
 * the shipped floor reads `args.network` any more, so no call in this rig can be made to answer
 * differently with the flag than without it. A check with nothing left to catch is exactly the
 * shape that stops being consulted and never says so, which is why `declarationFailures` takes the
 * floor it drives.
 */
const readsTheFlag: typeof approvalRequirement = (name, args, mode, context) =>
  args.network === true
    ? { sideEffect: 'external_reversible', action: 'Allow internet access', preview: 'planted' }
    : approvalRequirement(name, args, mode, context);
const oneShellCall: Scenario = {
  id: 'planted-declaration',
  ask: 'fetch the thing',
  origins: [],
  selfOrigins: [],
  taintedBy: 'a page',
  calls: [{ name: 'shell', arguments: { executable: 'pnpm', args: ['test'] }, step: 'planted' }]
};
// The guard tables are part of this check's corpus whatever scenarios it is handed, so the plant is
// read by its own key rather than by a total.
const plantedKeys = (failures: readonly { key: string }[]): number =>
  failures.filter((failure) => failure.key.startsWith('planted-declaration/')).length;
expect(
  plantedKeys(declarationFailures([oneShellCall], ['balanced'], readsTheFlag)) === 2,
  'the declaration check does not report a floor that answers differently when the flag is set, so a branch reading it could come back and the check would stay silent'
);
expect(
  plantedKeys(declarationFailures([oneShellCall], ['balanced'])) === 0,
  'the declaration check reports the shipped floor on a call it answers identically either way, so it would fail on everything and mean nothing'
);
expect(
  declarationFailures().length === 0,
  'a call in this rig answers differently when the model declares `network: true`, so the floor is charging for an honest answer'
);

/* ---------------------------------------------------- the sink declaration cannot silence itself */

const taintOnly: Scenario = {
  id: 'planted-undeclared',
  ask: 'have a look at this',
  origins: [],
  selfOrigins: [],
  taintedBy: 'a page',
  // Free on a clean turn, a card on a tainted one, and deliberately NOT marked.
  calls: [
    {
      name: 'memory',
      arguments: {
        action: 'add',
        target: 'workspace',
        content: 'x',
        validUntil: '2027-01-31'
      },
      step: 'planted'
    }
  ]
};
expect(
  provenanceFailures([taintOnly], MODES).length === MODES.length,
  'an undeclared call that only cards once the turn is tainted is not reported, so provenance could start charging for ordinary work and nothing would say so'
);

const deadDeclaration: Scenario = {
  ...taintOnly,
  id: 'planted-dead-declaration',
  calls: [{ name: 'file_read', arguments: { path: 'workspace/a.md' }, step: 'planted', sink: true }]
};
expect(
  provenanceFailures([deadDeclaration], MODES).length === 1,
  'a `sink: true` on a call the floor never stops is not reported, so the declaration could be sprinkled over the file until the forward rule had nothing left to catch'
);

/*
 * And the shipped file itself passes both halves. Stated here as well as in `run.ts` because the
 * two planted cases above prove the rule works on something invented; this proves it is being asked
 * about the ten scenarios anybody actually reads.
 */
expect(
  provenanceFailures().length === 0,
  'the shipped scenarios do not satisfy the provenance rule'
);

/* ------------------------------------------------------------ the baseline comparison compares */

const measurements = measureAll();
const good = baselineFrom(measurements);
expect(
  check(measurements, good).length === 0,
  'a run does not agree with its own accepted baseline'
);
expect(
  check(measurements, undefined).length === 1,
  'a missing baseline is not reported, so a rig with no baseline would gate on nothing'
);
const key = `${SCENARIOS[0]?.id}/balanced`;
const nudged = { ...good, [key]: { ...good[key]!, clean: (good[key]?.clean ?? 0) + 1 } };
expect(
  check(measurements, nudged).some((failure) => failure.startsWith(key)),
  'a moved card count is not reported by `check`, so the committed baseline gates on nothing'
);
const dropped = Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
expect(
  check(measurements, dropped).some((failure) => failure.includes('new row')),
  'a row absent from the baseline is not reported, so a scenario could be added without anybody accepting its number'
);
expect(
  check(measurements.slice(1), good).some((failure) => failure.includes('has gone')),
  'a row that has left the table is not reported, so a scenario could be quietly deleted'
);

/* ------------------------------------------------------------------ no column is furniture */

/*
 * Three statements about the table's shape, and each of them would still be true of a rig that had
 * stopped consulting the classifier and started printing a constant.
 */
expect(
  MODES.every((mode) => totals(measurements, mode).clean > 0),
  'some security mode raises no card at all across ten owner-shaped tasks, which is a floor that is not there'
);
expect(
  totals(measurements, 'review').clean > totals(measurements, 'balanced').clean &&
    totals(measurements, 'balanced').clean >= totals(measurements, 'autonomous').clean,
  'the three modes do not order review > balanced >= autonomous, so the mode argument is reaching nothing'
);
expect(
  SCENARIOS.some((scenario) =>
    measurements.some(
      (row) => row.scenarioId === scenario.id && row.mode === 'balanced' && row.clean.length === 0
    )
  ) &&
    SCENARIOS.some((scenario) =>
      measurements.some(
        (row) => row.scenarioId === scenario.id && row.mode === 'balanced' && row.clean.length > 0
      )
    ),
  'every scenario reads the same in balanced mode, so the column is measuring nothing a change could move'
);
expect(
  rigIdentity().rig !== 'unreadable',
  'the rig digest cannot be computed, so a committed baseline cannot say which rig produced it'
);

/* --------------------------------------------------------------------------------------------- */

for (const failure of failures) process.stderr.write(`SELFTEST: ${failure}\n`);
process.stdout.write(
  failures.length
    ? `${failures.length} check(s) failed.\n`
    : 'The cards rig measures something: every scenario names a shipped tool, all twelve guard tables report a planted failure in each direction they check - three of them for where a delete lands, which asks its rows again with the turn undo point taken away, and the taint rows again with the estate cut out of the reader - the no-socket allowlist is covered name by name, the sink declaration cannot silence itself, the baseline comparison compares, and no column is a constant.\n'
);
process.exit(failures.length ? 1 : 0);
