/**
 * Driving the shipped floor over a scenario, twice per mode.
 *
 * `approvalRequirement` is imported from `apps/worker/src/tools.js` rather than from
 * `approval-policy.js` deliberately: `tools.ts` is the module agent.ts imports, so a re-export that
 * stopped re-exporting - or started re-exporting something else - is a change this rig would feel
 * rather than one it would step around. The rig is measuring the seam the product actually uses.
 *
 * Nothing here is stateful and nothing here is asynchronous. That is the whole reason this rig can
 * report a number the eval suite structurally cannot: a card parks the turn, so a run can observe
 * one of them, while the function that decides them can be asked about all seven calls in a row.
 */
import { untrustedOriginOfResult } from '../../apps/worker/src/provenance.js';
import { approvalRequirement } from '../../apps/worker/src/tools.js';
import {
  CONFINED,
  DESTROYS,
  EGRESS,
  FREE_PACKAGE_WORK,
  FREE_STORE_WORK,
  FREE_WORKSPACE_DELETES,
  PUBLISHES,
  READS,
  SINKS,
  STOPS_THE_COMPUTER,
  TAINTS,
  WRITES,
  egressCall,
  noEgressUncovered,
  type ConfinedWrite,
  type Egress,
  type Guard,
  type Sink,
  type Taint
} from './guards.js';
import { MODES, SCENARIOS, contextFor, type Call, type Mode, type Scenario } from './scenarios.js';

export interface CardRow {
  readonly step: string;
  readonly tool: string;
  readonly sideEffect: string;
  readonly action: string;
}

const cardsFor = (
  calls: readonly Call[],
  mode: Mode,
  context: Parameters<typeof approvalRequirement>[3]
): CardRow[] =>
  calls.flatMap((call) => {
    const requirement = approvalRequirement(call.name, call.arguments, mode, context);
    return requirement
      ? [
          {
            step: call.step,
            tool: call.name,
            sideEffect: requirement.sideEffect,
            action: requirement.action
          }
        ]
      : [];
  });

export interface ScenarioMeasurement {
  readonly scenarioId: string;
  readonly mode: Mode;
  readonly calls: number;
  readonly clean: readonly CardRow[];
  readonly tainted: readonly CardRow[];
}

export const measure = (scenario: Scenario, mode: Mode): ScenarioMeasurement => ({
  scenarioId: scenario.id,
  mode,
  calls: scenario.calls.length,
  clean: cardsFor(scenario.calls, mode, contextFor(scenario, false)),
  tainted: cardsFor(scenario.calls, mode, contextFor(scenario, true))
});

export const measureAll = (
  scenarios: readonly Scenario[] = SCENARIOS,
  modes: readonly Mode[] = MODES
): ScenarioMeasurement[] =>
  scenarios.flatMap((scenario) => modes.map((mode) => measure(scenario, mode)));

/* --------------------------------------------------------------- what provenance actually costs */

export interface ProvenanceFailure {
  readonly key: string;
  readonly detail: string;
}

/**
 * The rule behind this rig's headline claim, in both directions.
 *
 * Forward: a call that raises no card on a clean turn and raises one after the turn has read
 * untrusted content is provenance charging the owner a click. That is legitimate for a sink and
 * for nothing else, so every such call must be declared `sink: true` where it is written down. An
 * undeclared one is the regression this rig exists to catch - a change that starts making an
 * ordinary day more expensive because a page was read.
 *
 * Backward: a declared sink that the floor stops in no mode is a declaration silencing a check with
 * nothing behind it. Without this half, the forward rule could be satisfied for ever by marking
 * every call in the file. Only checked over the full matrix, because it is a statement about the
 * set of modes and `--mode` has deliberately taken most of them away.
 */
export const provenanceFailures = (
  scenarios: readonly Scenario[] = SCENARIOS,
  modes: readonly Mode[] = MODES
): ProvenanceFailure[] => {
  const failures: ProvenanceFailure[] = [];
  const declared = new Map<string, boolean>();
  for (const scenario of scenarios)
    for (const entry of scenario.calls)
      if (entry.sink) declared.set(`${scenario.id}/${entry.step}`, false);
  for (const scenario of scenarios)
    for (const mode of modes)
      for (const entry of scenario.calls) {
        const clean = approvalRequirement(
          entry.name,
          entry.arguments,
          mode,
          contextFor(scenario, false)
        );
        const tainted = approvalRequirement(
          entry.name,
          entry.arguments,
          mode,
          contextFor(scenario, true)
        );
        if (clean !== null || tainted === null) continue;
        declared.set(`${scenario.id}/${entry.step}`, true);
        if (!entry.sink)
          failures.push({
            key: `${scenario.id}/${mode}`,
            detail: `"${entry.step}" is free on a clean turn and costs a card ("${tainted.action}") once the turn has read untrusted content, and nothing in scenarios.ts declares it a sink`
          });
      }
  if (modes.length === MODES.length)
    for (const [key, stopped] of declared)
      if (!stopped)
        failures.push({
          key,
          detail:
            'is declared a provenance sink and the floor stops it in no mode, so either the rule has gone or the declaration is silencing a check with nothing behind it'
        });
  return failures;
};

/* ------------------------------------------------------------------------------- the guards */

export interface GuardFailure {
  readonly table:
    | 'writes'
    | 'reads'
    | 'sinks'
    | 'publishes'
    | 'free'
    | 'confined'
    | 'egress'
    | 'destroys'
    | 'free-store'
    | 'free-workspace-deletes'
    | 'stops-the-computer'
    | 'taints';
  readonly id: string;
  readonly detail: string;
}

const modesOf = (entry: Guard): readonly Mode[] => entry.modes ?? MODES;

/**
 * A turn that has an undo point, which is what every call after a turn's first one is.
 *
 * The destructive rule drops a card only when the caller has said a checkpoint exists for THIS
 * turn (`ApprovalContext.undoPoint`, approval-policy.ts): absent keeps the card, because a
 * workspace over `CHECKPOINT_MAX_FILES` makes taking the checkpoint throw and every delete inside
 * `workspace/` would otherwise be free on a turn nothing can rewind. The guard tables handed `{}`
 * were therefore measuring a turn with no undo point and reporting the floor as broken - `rm -rf
 * dist` carded in all three modes and every `FREE_WORKSPACE_DELETES` row failed at once.
 *
 * The id is a literal because nothing here reads it; only whether it is there. `uncovered` is the
 * empty list rather than omitted, and the difference is a whole table: it is the set of files the
 * checkpoint WALKED and did not HOLD - each over `CHECKPOINT_MAX_FILE_BYTES`, 2 GiB - and omitting
 * it means "nobody knows", which keeps the card on every delete and would satisfy every
 * `DESTROYS` row here for the wrong reason while failing every `FREE_WORKSPACE_DELETES` row. Empty
 * is what an ordinary workspace produces and it is the answer that makes both tables mean
 * something.
 *
 * This models every call of a turn, first one included. The undo point is taken in
 * `turn/dispatch.ts` immediately before the floor is asked, so there is no longer a first call the
 * fact is missing for - which is what it used to model around.
 */
const AFTER_THE_UNDO_POINT = {
  undoPoint: { id: 'checkpoint-for-this-turn', uncovered: [] }
} as const;

/**
 * The two directions, checked on every run rather than under a flag.
 *
 * A baseline regression is a decision somebody can accept in a commit. A write that stopped
 * carding is not a decision, and neither is a read that started: both mean the table above is
 * reporting a number about a floor that is no longer the floor.
 */
export const guardFailures = (
  writes: readonly Guard[] = WRITES,
  reads: readonly Guard[] = READS,
  sinks: readonly Sink[] = SINKS,
  publishes: readonly Guard[] = PUBLISHES,
  free: readonly Guard[] = FREE_PACKAGE_WORK,
  confined: readonly ConfinedWrite[] = CONFINED,
  egress: readonly Egress[] = EGRESS,
  /*
   * Injectable for the same reason the floor is in `declarationFailures`: on a healthy tree this
   * list is empty, so the shipped tables contain nothing that could plant a failure in it, and a
   * check with nothing left to catch is the shape that stops working without saying so.
   */
  uncovered: readonly string[] = noEgressUncovered(),
  destroys: readonly Guard[] = DESTROYS,
  freeStore: readonly Guard[] = FREE_STORE_WORK,
  freeWorkspaceDeletes: readonly Guard[] = FREE_WORKSPACE_DELETES,
  stopsTheComputer: readonly Guard[] = STOPS_THE_COMPUTER,
  taints: readonly Taint[] = TAINTS,
  /*
   * The taint reader, injectable for the reason the floor is in `declarationFailures`: the shipped
   * table is written to pass against the shipped reader, so nothing in it can plant a failure, and
   * `selftest.ts` hands this a reader with the estate cut out of it and requires the rows to say so.
   * The result handed to it is the shape the runner answers a shell call with; `shell` is judged on
   * its arguments, and a reader that started keying on the bytes instead would be a change these
   * rows feel rather than one they step around.
   */
  reader: typeof untrustedOriginOfResult = untrustedOriginOfResult
): GuardFailure[] => {
  const readOf = (call: { name: string; arguments: Record<string, unknown> }): string | null =>
    reader(
      { id: 'guard', name: call.name, arguments: call.arguments },
      { stdout: '', exitCode: 0 }
    );
  const failures: GuardFailure[] = [];
  for (const entry of publishes)
    for (const mode of modesOf(entry)) {
      const requirement = approvalRequirement(entry.call.name, entry.call.arguments, mode, {});
      if (!requirement)
        failures.push({
          table: 'publishes',
          id: entry.id,
          detail: `raises no card in ${mode} mode, so a version could reach a registry nobody can withdraw it from`
        });
    }
  for (const entry of free)
    for (const mode of modesOf(entry)) {
      const requirement = approvalRequirement(entry.call.name, entry.call.arguments, mode, {});
      if (requirement)
        failures.push({
          table: 'free',
          id: entry.id,
          detail: `cards in ${mode} mode as "${requirement.action}", and it publishes nothing`
        });
    }
  /*
   * Both halves of one claim, in one loop, so neither can be satisfied on its own. The confined
   * spelling must be silent because the write lands in `workspace/` where nothing executes it; the
   * shell spelling of the SAME file must card because `shell` is handed a path and a shell and
   * `~/.bashrc` there is the real one. A floor that lost the rule fails the second half; a floor
   * that went back to matching the name wherever it appears fails the first.
   */
  for (const entry of confined) {
    for (const mode of ['balanced', 'autonomous'] as const) {
      const requirement = approvalRequirement(
        entry.confined.name,
        entry.confined.arguments,
        mode,
        {}
      );
      if (requirement)
        failures.push({
          table: 'confined',
          id: entry.id,
          detail: `cards in ${mode} mode as "${requirement.action}" on a write the runner folds into workspace/, where no login shell, git or coding CLI reads it`
        });
    }
    for (const mode of MODES) {
      const requirement = approvalRequirement(
        entry.viaShell.name,
        entry.viaShell.arguments,
        mode,
        {}
      );
      if (!requirement)
        failures.push({
          table: 'confined',
          id: entry.id,
          detail: `the shell spelling "${entry.viaShell.step}" raises no card in ${mode} mode, so the rule that the row above narrows has gone rather than narrowed`
        });
    }
  }
  for (const entry of writes)
    for (const mode of modesOf(entry)) {
      const requirement = approvalRequirement(entry.call.name, entry.call.arguments, mode, {});
      if (!requirement)
        failures.push({
          table: 'writes',
          id: entry.id,
          detail: `raises no card in ${mode} mode, so this computer would run text nobody was shown`
        });
    }
  for (const entry of reads)
    for (const mode of modesOf(entry)) {
      const requirement = approvalRequirement(entry.call.name, entry.call.arguments, mode, {});
      if (requirement)
        failures.push({
          table: 'reads',
          id: entry.id,
          detail: `cards in ${mode} mode as "${requirement.action}", and it changes nothing`
        });
    }
  for (const entry of sinks) {
    const context = {
      knownOrigins: entry.knownOrigins ?? [],
      knownAddresses: [],
      ownerText: 'have a look at this and deal with it',
      selfOrigins: ['box.garden.invalid'],
      spentNoveltyBytes: 0
    };
    const clean = approvalRequirement(entry.call.name, entry.call.arguments, entry.mode, {
      ...context,
      taintSources: []
    });
    const tainted = approvalRequirement(entry.call.name, entry.call.arguments, entry.mode, {
      ...context,
      taintSources: ['a page this turn read']
    });
    if (clean)
      failures.push({
        table: 'sinks',
        id: entry.id,
        detail: `cards on a CLEAN turn in ${entry.mode} mode ("${clean.action}"), so provenance is being paid for whether or not anything hostile was read`
      });
    if (!tainted)
      failures.push({
        table: 'sinks',
        id: entry.id,
        detail: `raises no card in ${entry.mode} mode after the turn read untrusted content, so the provenance floor is not there`
      });
    /*
     * The loop closed. A shell sink row is a fetch - a read of the estate, or of a host nobody
     * named - and it is measured above on a turn whose taint is a literal. The product's turn has
     * no literal: it is tainted by the classifier recognising a read, and the read it has to
     * recognise is this one. Measured with `readsAnotherComputer` cut back to clearing the estate,
     * the four estate rows above passed unchanged - each carded on a turn that, in the product,
     * would never have become tainted by reaching it.
     */
    if (entry.call.name === 'shell' && readOf(entry.call) === null)
      failures.push({
        table: 'sinks',
        id: entry.id,
        detail: `is a read the taint reader does not recognise, so in the product the turn that reaches it never becomes the tainted turn this row is measured on, and the card above is measured on a turn that cannot occur`
      });
  }
  /*
   * Both directions of the autonomous network arm, on a clean turn.
   *
   * Autonomous and not the other two, because this is a claim about the arm the allowlist lives in
   * and the other two modes answer earlier for reasons of their own: review cards every shell call
   * by definition, and balanced's own sentence is that it asks before reaching an address outside
   * this computer and before installing software - so `npm install` and `curl https://example.com`
   * card there by design and would drown out what this table is measuring.
   *
   * The free rows were nine cards before the repair and the carding rows are what must survive it.
   * A table of things that must not card would be satisfied by deleting the arm; a table of things
   * that must card would be satisfied by carding everything. Held together, in one loop, neither is
   * reachable on its own.
   *
   * And every row twice: once declaring `network: true`, once with the field left out. That is not
   * a second copy of `declarationFailures`, which asks whether the two answers AGREE; this asks
   * whether each of them is the right answer. It matters here more than anywhere else in the file,
   * because the arm this table is about used to open on the declaration alone: measured on the
   * floor before the repair, the fourteen install lines carded nine times with the flag and not
   * once without it, so a table driving only the silent spelling would have passed unchanged on the
   * floor whose inversion it exists to describe.
   */
  for (const entry of egress)
    /*
     * Autonomous unless the row says otherwise, and the exception is not a convenience.
     *
     * Driving every row in one mode is what made this table unable to see the arm above it: with
     * `curl` on the allowlist, autonomous answers the same way whether the ordinary network arm
     * asks about the estate or only about the internet, so a row that says "a command reaching the
     * owner's own LAN must not card on a clean turn" is a fixture that does not exercise the path
     * unless it is also asked in balanced, where that arm is the one that answers. Measured:
     * widening `outboundDestinations` to the estate produced ZERO failures here until this loop
     * read `entry.modes`.
     */
    for (const mode of entry.modes ?? ['autonomous'])
      for (const declared of [false, true]) {
        const call = egressCall(entry);
        const args = declared ? { ...call.arguments, network: true } : call.arguments;
        const requirement = approvalRequirement(call.name, args, mode, {
          selfOrigins: ['box.garden.invalid']
        });
        if (entry.cards === Boolean(requirement)) continue;
        const spelling = declared ? 'declaring network: true' : 'with the network field left out';
        failures.push({
          table: 'egress',
          id: entry.id,
          detail: entry.cards
            ? `raises no card in ${mode} mode ${spelling}, and ${entry.why ?? 'it carries data to an address this computer can read'}`
            : `cards in ${mode} mode ${spelling} as "${requirement?.action}", on a clean turn, and nothing in it reaches anywhere the owner needs to decide about`
        });
      }
  /*
   * Where taint comes from, in both directions and with the limits written down.
   *
   * A table of reads that must taint is satisfied by a reader that taints everything, which would
   * mark every build on this computer and gate every sink on every turn; a table of reads that
   * must not is satisfied by deleting the reader. Held together, neither is reachable alone. The
   * rows with a `why` are the stated limits, and a limit row that starts tainting fails here with
   * the reason it was a limit - so coverage growing past a decision is a failure to re-make the
   * decision rather than a count nobody reads.
   */
  for (const entry of taints) {
    const origin = readOf(entry.call);
    if (entry.taints && origin === null)
      failures.push({
        table: 'taints',
        id: entry.id,
        detail: `raises no taint, so a turn that ran it would go on reporting itself clean and every sink after it stays free${entry.why ? ` (${entry.why})` : ''}`
      });
    if (!entry.taints && origin !== null)
      failures.push({
        table: 'taints',
        id: entry.id,
        detail: `taints the turn as "${origin}", and ${entry.why ?? 'it reads nothing anybody else wrote'}`
      });
  }
  /*
   * And that the allowlist rows still cover the allowlist. A name added to `noEgressExecutables`
   * with no row beside a fetch is a name nothing here would notice going wrong, in a list where
   * being wrongly present means a network card that stops firing.
   */
  /*
   * The stores and the schedules, in both directions and in one loop for the reason the egress
   * pair gives: a table of things that must card is satisfied by carding everything, and a table of
   * things that must not is satisfied by deleting the rule. `psql -c 'DROP DATABASE'` must stop and
   * `psql tracker -f migrations/001_init.sql` must not, and the second of those is a call the
   * owner's own scenario makes twice.
   *
   * Asked of a turn that HAS an undo point, which makes the claim stronger rather than kinder: a
   * table of deletes that must card is otherwise satisfied by the checkpoint fact simply being
   * absent, and would go on passing after the location rule was widened into an exemption for the
   * word `rm`. Every row here has to card while the turn is holding the very thing the rule below
   * drops cards for.
   */
  for (const entry of destroys)
    for (const mode of modesOf(entry)) {
      const requirement = approvalRequirement(
        entry.call.name,
        entry.call.arguments,
        mode,
        AFTER_THE_UNDO_POINT
      );
      if (!requirement)
        failures.push({
          table: 'destroys',
          id: entry.id,
          detail: `raises no card in ${mode} mode, and what it removes is outside CHECKPOINT_CONTENT, so rewinding the turn does not put it back`
        });
    }
  for (const entry of freeStore)
    for (const mode of modesOf(entry)) {
      const requirement = approvalRequirement(entry.call.name, entry.call.arguments, mode, {});
      if (requirement)
        failures.push({
          table: 'free-store',
          id: entry.id,
          detail: `cards in ${mode} mode as "${requirement.action}", and it destroys nothing the turn's undo point is not already holding`
        });
    }
  /*
   * Where a delete lands, in both directions and in one loop for the third time in this file - and
   * here it is not a stylistic echo. The location test drops a card when every path a command names
   * is strictly inside `CHECKPOINT_CONTENT`, and the way that rule fails is by widening into an
   * exemption for the word `rm`: every count in the table falls at once and the run reads like the
   * saving it is supposed to be. The second half of `DESTROYS` is what catches that, and it is
   * walked above; this is the half that catches the rule being reverted or never consulted.
   */
  for (const entry of freeWorkspaceDeletes)
    for (const mode of modesOf(entry)) {
      const requirement = approvalRequirement(
        entry.call.name,
        entry.call.arguments,
        mode,
        AFTER_THE_UNDO_POINT
      );
      if (requirement)
        failures.push({
          table: 'free-workspace-deletes',
          id: entry.id,
          detail: `cards in ${mode} mode as "${requirement.action}", and everything it removes is strictly inside CHECKPOINT_CONTENT, which the undo point this turn already took puts back`
        });
      /*
       * THE THIRD DIRECTION, and the one the other two cannot cover between them. The saving above
       * is bought entirely with "a rewind puts it back", so it is owed only on a turn that has a
       * rewind. `CHECKPOINT_MAX_FILES` = 250,000 makes taking the checkpoint throw on a workspace
       * that has just had a large dependency tree unpacked into it, and `#ensureTurnUndoPoint`
       * writes that into the timeline and carries on - so the turn where this exemption is least
       * affordable is exactly the turn it would otherwise be widest on. Same rows, same modes, one
       * fact removed: every one of them must card again.
       */
      if (!approvalRequirement(entry.call.name, entry.call.arguments, mode, {}))
        failures.push({
          table: 'free-workspace-deletes',
          id: entry.id,
          detail: `raises no card in ${mode} mode on a turn with NO undo point, so the exemption is being granted on a rewind that does not exist`
        });
    }
  for (const entry of stopsTheComputer)
    for (const mode of modesOf(entry)) {
      const requirement = approvalRequirement(entry.call.name, entry.call.arguments, mode, {});
      if (!requirement)
        failures.push({
          table: 'stops-the-computer',
          id: entry.id,
          detail: `raises no card in ${mode} mode, and it ends every process on this computer, the turn asking the question included`
        });
    }
  for (const name of uncovered)
    failures.push({
      table: 'egress',
      id: `noEgressExecutables: ${name}`,
      detail:
        'is on the no-socket allowlist and no row pairs it with a fetch, so nothing here consults it and a wrong entry would be silent'
    });
  return failures;
};

/* ------------------------------------------------- what declaring the network costs the model */

export interface DeclarationFailure {
  readonly key: string;
  readonly detail: string;
}

/**
 * The incentive, checked rather than described: telling the truth must never cost more than silence.
 *
 * `shell`'s `network` field is a declaration the runner ignores. `execution.ts` puts a command in
 * its own network namespace only when `policy.isolateNetwork && !request.network`, and
 * `ISOLATE_AGENT_NETWORK` ships false - because a namespace of one's own comes with a loopback of
 * one's own and published previews stop answering - so setting the flag and omitting it produce
 * byte-identical access. The floor nonetheless read it in three places, and measured over the
 * owner's own one-shot-app trajectory the same forty-seven calls cost six cards with the flag and
 * two without. The tool description tells the model to set it. So the product charged four cards
 * for an honest answer and refunded them for a quiet one, in a floor whose entire input is what the
 * model says.
 *
 * The rule is therefore stronger than "the flag should not matter": for every call this rig knows
 * about, in every mode, on a clean turn and on a tainted one, the requirement with `network: true`
 * must be the SAME requirement as without it. Equality rather than "no worse", because a floor that
 * paid a model to declare would be the same defect pointed the other way, and because equality is
 * the only version of this a test can hold without arguing about which direction is generous.
 */
export const declarationFailures = (
  scenarios: readonly Scenario[] = SCENARIOS,
  modes: readonly Mode[] = MODES,
  /*
   * The floor this drives, injectable for one reason: a check whose whole content is "these two
   * answers are equal" is indistinguishable, on a good day, from a check that has stopped asking.
   * The shipped floor no longer reads the flag anywhere, so there is no call left that could plant
   * a failure - which is the repair working and also the thing that would let this rot silently.
   * `selftest.ts` hands it a floor that does read the flag and requires it to report.
   */
  floor: typeof approvalRequirement = approvalRequirement
): DeclarationFailure[] => {
  const failures: DeclarationFailure[] = [];
  const shellCalls: Array<{ where: string; call: Call }> = [
    ...scenarios.flatMap((scenario) =>
      scenario.calls
        .filter((call) => call.name === 'shell' || call.name === 'desktop_launch')
        .map((call) => ({ where: `${scenario.id}/${call.step}`, call }))
    ),
    ...EGRESS.map((entry) => ({ where: `egress/${entry.id}`, call: egressCall(entry) })),
    ...[...WRITES, ...READS, ...PUBLISHES, ...FREE_PACKAGE_WORK]
      .filter((entry) => entry.call.name === 'shell')
      .map((entry) => ({ where: `guard/${entry.id}`, call: entry.call }))
  ];
  for (const { where, call } of shellCalls)
    for (const mode of modes)
      for (const tainted of [false, true]) {
        const context = {
          taintSources: tainted ? ['a page this turn read'] : [],
          knownOrigins: [],
          knownAddresses: [],
          ownerText: 'build the thing I asked for',
          selfOrigins: ['box.garden.invalid'],
          spentNoveltyBytes: 0
        };
        const { network: _declared, ...silent } = call.arguments;
        const declaring = floor(call.name, { ...silent, network: true }, mode, context);
        const staying = floor(call.name, silent, mode, context);
        if (declaring?.action === staying?.action && declaring?.sideEffect === staying?.sideEffect)
          continue;
        failures.push({
          key: `${where}/${mode}${tainted ? '/tainted' : ''}`,
          detail: `declaring network: true answers "${declaring?.action ?? 'nothing'}" and staying silent answers "${staying?.action ?? 'nothing'}" - the same command with the same access, so the floor is paying the model to leave a field out`
        });
      }
  return failures;
};
