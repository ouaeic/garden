# The read-cost rig

```
pnpm eval:read                # instrument: trajectories + the whole fixture corpus, ~9s
pnpm eval:read -- --ci        # floor: the declared trajectories only, ~1.8s. On pnpm eval:rigs,
                              # and therefore on pnpm check
```

Offline, no key, no network, no model. Three consecutive `--ci` runs produce byte-identical output.

## The number

**Displayed lines per landed edit.** Rows of file text a `file_read` rendered into a tool result,
divided by the edits that reached disk in the same turn.

It is the number the whole edit-format economic case turns on and garden measured nowhere. The
line dialect buys output characters per edit and pays for them in input: the numbering is charged on
every request after a read for as long as that file stays in the window. `evals/arms/price.ts`
computes the break-even as a number of **edits per turn** and has to assume how many lines a turn
reads to land one — `MIN_CALLS_PER_EDIT = 3`, read then edit then finish, one whole file per edit.
Nothing measured that. This does.

| what                | how it is counted                                                         |
| ------------------- | ------------------------------------------------------------------------- |
| numerator           | rows of `content` in each `file_read` result — what `renderNumbered` sent |
| denominator         | `file_patch` hunks that applied, plus `file_write` calls that returned    |
| a refused patch     | in neither: it displays nothing and lands nothing                         |
| a turn with no edit | **no quotient.** Counted in its own column, never `Infinity`, never 0     |
| the patch echo      | its own column, beside the numerator and never inside it                  |

It is read off the `tool_result` event stream, so it counts what garden **chose to display**, not
what survived a later squeeze. That second question is `evals/context-quality`'s and measuring it
here would silently answer a different one.

## Two modes, and why they are not the same rig

**Without `--ci` it is an instrument.** It runs the trajectories and all 73 fixtures, prints the
number for both, and does not care what the number is. Run it before and after any change to
`apps/worker/src/tools/workspace.ts` or `apps/worker/src/edit/`.

**With `--ci` it is a floor**, and a deliberately narrow one: the six declared trajectories only,
held one-sidedly to `baseline.json`. Displaying **more** lines per landed edit fails. Displaying
fewer passes, because that is the improvement this lane exists for and a gate against it would be a
gate against the work.

The corpus is **not** in the baseline. Those rows are already gated one-sidedly by
`evals/report.ts` inside `pnpm eval`, which CONTRIBUTING keeps out of `pnpm check` on purpose —
a change to a fixture is a decision to make, not a build to fix. Committing them here as well would
put one set of rows behind two gates, one of them a build gate, and would move `pnpm eval` into
`pnpm check` without anyone deciding to.

## What the run says today

```
row                                                             displayed  edits  lines/edit
a-whole-file-read-for-a-one-line-edit                                 400      1      400.00
narrow-reads-and-an-edit-each-time                                     40      4       10.00
a-second-edit-after-one-read-needs-no-second-read                     400      2      200.00
a-file-written-from-nothing-displays-no-lines                           0      1        0.00
a-file-past-the-display-bound-shows-only-what-the-bound-allows         800      1      800.00
a-read-that-lands-no-edit-is-not-averaged-in                          400      0     no edit
```

Same agent, same loop, same tools, same file: **40x** between reading everything for one edit and
reading a window for each of four. The instrument moves.

The general fixture corpus scores **2.47**, n=14 turns that landed an edit — and that figure is a
fact about the corpus, which the report says on the line beneath it. The largest file any of the 73
fixtures puts in a workspace is 11 lines, 1 of 32 reads takes the windowed path, and 7 of the 15
landed edits are `file_patch`.

## What it found

The eval harness's runner stub answered the **display read** — the one `readFileForDisplay` makes,
carrying `displayBytes` and `displayLines` — by handing back the whole file with no display headers.
That is the shape a runner one release behind the worker produces, and the shipped runner cannot
produce it. Measured through the shipped `readWorkspaceFile` on 9,000 lines of two characters: 800
rows, 2,399 bytes. Through the stub: 9,000 rows.

All 72 fixtures stayed green over it, and so did the 105 unit tests in `workspace.test.ts` and
`edit/`, because the unit fakes are honest and the corpus has no file big enough for the difference
to appear. `a-file-past-the-display-bound-shows-only-what-the-bound-allows` is the only row in any
rig that reaches that bound.

The fix is in `harness.fileDisplay`, and it **imports** `displayablePrefix` from
`services/workspace-runner/src/files.ts` rather than modelling it a second time. `fileWindow` beside
it is modelled, and says why — the real ranged reader walks a file descriptor and this stub's
workspace is a map of strings. That reason does not apply to a pure function of a Buffer and a
budget, so the fake cannot drift from the thing it fakes.

## The gates, and which of them a baseline cannot replace

A committed baseline can only ever say "this is what it did last time", which is exactly the check
that cannot tell a working instrument from one that has stopped reading its input. So there are
three kinds of failure here and they are independent.

1. **The declaration.** Every trajectory states, before it runs, the lines it will display and the
   edits it will land, derived from its own declared steps. A row that measures anything else fails
   whether or not a baseline exists. `selftest.ts` checks those declarations against the files by
   arithmetic, so a window running past the end of a file cannot quietly declare lines that are not
   there.

   One read declares no number: the one the display bound cuts short. That bound is a constant in
   `workspace.ts` this directory cannot import, and a copy of it here would fail on the day somebody
   **lowered** the cap. So that row declares the property — the read was cut short, and it showed
   some of the file and not all of it — and the baseline holds the number one-sidedly.

2. **The separation gate.** `a-whole-file-read-for-a-one-line-edit` must score at least ten times
   `narrow-reads-and-an-edit-each-time`. A counter that has gone flat satisfies a baseline perfectly
   and fails this. Two coverage gates sit beside it: some trajectory must take the windowed read
   path, and some trajectory must reach the display bound.

3. **The baseline.** `--ci` only. It catches the case the declaration cannot: a trajectory that
   starts reading more widely, with its own declaration moved to match.

`selftest.ts` runs on every invocation, not behind a flag, and re-measures every trajectory in
reverse to find out whether any row depends on what ran before it — the snapshot store in
`apps/worker/src/edit/snapshots.ts` is process-global and every fixture in this harness shares one
task id.

`--accept` refuses a run that failed any of the three. It is for re-accepting a number that moved on
purpose, not for silencing a rig that has stopped reading its input.

## Attacked

Each defect introduced, watched red, restored, watched green. `docs/design/holes/RIG.md` has the
table and the exit codes, including what `pnpm eval` and the unit suites said about the same defect.

## The files

| file              | what it holds                                                         |
| ----------------- | --------------------------------------------------------------------- |
| `trajectories.ts` | the workspace, the declared steps, and the script generated from them |
| `measure.ts`      | one run to one `Measurement`, and the roll-up                         |
| `report.ts`       | the table, the stamp, the baseline, and the gates on the rig itself   |
| `selftest.ts`     | the checks the table cannot perform                                   |
| `run.ts`          | the entry point                                                       |

The counter itself is `readLedgerOf` in `evals/harness.ts`, beside the event stream it reads, so
`evals/report.ts` and this directory count the same thing by construction rather than by agreement.
`harness.ts` is in this rig's digest for that reason: a change to how a displayed line is counted has
to move the stamp, or the stamp would vouch for an instrument that had been rebuilt underneath it.
