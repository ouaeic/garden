# The arm-comparison rig

`pnpm eval:arms`

Two configurations of garden, the same work, and one difference between them. It exists because
every argument about garden's resident weight — the catalogue is too large, the skill index is
dead, the contract carries method it should not — has so far been settled by reading source and
forming a view. None of them has been measured, and none of them can be settled without an
instrument that can hold two configurations against the same sample honestly.

## What it does

Two halves, the same split `evals/context-quality` and `evals/agentdojo` settled on.

**Offline.** No key, no network, no model, deterministic to the byte. It prices what each arm
carries on every request: the catalogue as a provider receives it, the contract, the curated
knowledge block. It also prints a free diagnostic — the tools an arm's contract still names that
the arm no longer sends. It gates via `--ci` against `baseline.json`.

**Live.** A real model, one arm's wire, the fixtures' own requests, and a deterministic computer
behind every tool. Needs `OPENROUTER_API_KEY`. It reports success rate and mean output tokens on
the same row, always, and excludes ghost and unmetered rows from both.

The offline half cannot say whether an arm finishes the work, and it says so where it prints. A
scripted model is a function of what garden just said, so a smaller catalogue produces a
byte-identical reply and every arm would tie. A tie in that table means the instrument is blind
there, not that the candidate is free.

## The property that makes it a comparison

An arm does not carry a configuration. It carries the id of a sibling it inherits from and exactly
one field it changes; everything else — the sample, the tier, the tool oracle, the other axes — is
inherited and cannot be edited for one arm without being edited for both. `settingsFor` enforces
the one-field rule and throws. That is deliberately not a test: a rig whose honesty depends on
somebody running its test suite reports a confident wrong difference on the machine where the suite
was skipped.

## Reading a result

The pre-registered decision rules are in `arms.ts` and are printed above every table, including the
one that says which arm to read first. Read them before the numbers, not after.

`floor` is a calibration point and never a proposal. If a five-tool arm is within one task of the
shipped arm on the weak tier, the sample cannot resolve the tool axis and nothing ships from that
run.

## The edit axis

`pnpm eval:arms -- --edit`

One arm, `quoted-edit`, whose single difference is the editor. It is the gate
`docs/design/exec3/L2.md` named when it held the line-addressed format back at 61% fewer output
characters, because that figure is an upper bound available only to a model that spells the dialect
correctly every time, and nothing offline can say whether one does.

**It is now a rollback, and reading it any other way inverts the answer.** The format landed while
this rig was being built: `file_patch` IS the line dialect, so the arm called `shipped` is the
working tree and `quoted-edit` is the oldText/newText editor put back. The pre-registered rule is
printed unchanged above the table, with the direction stated beside it, exactly as `no-method` is
read once its own cut has landed. A loss for the line dialect is a reason to roll it back.

It is run apart from the general table, on its own sample, because a task that does not edit a file
cannot tell the two dialects apart and would print a tie — and a tie that means "the instrument is
blind here" prints exactly like a tie that means "the candidate is free".

- **The sample** is the twelve landing rows of `evals/edit/corpus.ts`, a corpus written by the wave
  arguing the other side of this question. The requests are derived from the corpus's declared
  changes, byte-identical across arms, and contain no dialect. The three drift and refusal rows are
  excluded: this world does not change a file under the model, and those are rows the candidate
  wins, so their absence understates it.
- **The world** holds both editors. The candidate is `applyEdit` and the snapshot ledger, imported
  and driven the way `apps/worker/src/tools/workspace.ts` drives them. The quoted editor is
  reconstructed here, because it is in no file of the working tree any more, and its catalogue
  entry is frozen in `wire.ts` and checked against the last revision that shipped it. A row is
  scored by the file afterwards, byte for byte, never by what the tool said about itself.
- **Offline** it prints the sample, the character bound over those same rows through both encoders,
  the read-side surcharge the bound does not include, and what a live run costs — in calls, in
  tokens, and in dollars at the provider's own current rates.
- **Live** it prints edit-success, output tokens, and the two columns the ship criterion is written
  against: `forgiven`, malformed emissions the harness absorbed with no round trip, and `unrecov`,
  refusals the model did not answer with a landed edit in the same turn.
- **Then it applies the rule**, as arithmetic, and will report a run as UNSETTLED rather than as a
  pass. One in twenty cannot be seen in twelve edit calls; the smallest non-zero rate that sample
  can print is one in twelve, which already fails, so a clean sweep on one seed settles nothing and
  the table says how many seeds it would take.

Two tiers, and it will not spend on one unasked. `AI_DEFAULT_MODEL` is the strong tier unless
`--strong` says otherwise, because a strong model hides a bad harness by paying turns for it: the
weak tier is where a correctness risk shows and the strong tier is where the saving does. `--model
<release id>` names the weak tier, and named explicitly it may run alone - the table then says it
informs and does not settle.

**The live half goes through garden's own gateway.** `edit-live.ts` builds the transport from
`evals/bench/provider.ts`'s credential and model-id rules and `packages/model-gateway`'s adapter,
so the request a row is scored on is the request the worker would have sent - same client, same
retry policy, same usage parsing. The key is `AI_API_KEY` or `OPENROUTER_API_KEY`, in that order,
and the gate that decides whether the run starts reads the same two in the same order. `--model`
takes a release id, `openrouter/<slug>`; the request is sent with the slug and the price is looked
up under it, so the money column is filled for the command below. The price is OpenRouter's
catalogue: a run routed elsewhere through `AI_API_KEY` and `AI_BASE_URL` is told, beside the
price, that the catalogue does not carry its route's rates. The command the first run was written
for:

```
OPENROUTER_API_KEY=… pnpm eval:arms -- --edit --live --yes --model openrouter/z-ai/glm-5.3-flash --seeds 3 --edit-json out.json
```

Beside `forgiven` and `unrecov`, the live table prints the anchored form's own five numbers per
arm and tier: how many edit calls carried the one `-` row the spec teaches, how many of those
corrected a miscounted number, how many were refused as ambiguous or absent, how many applied with
an anchor and still left the wrong file, and how many rows had a display prefix taken off. They are
read from the applier's notes and refusal kinds, never inferred from the file.

Nothing about this ships or unships the format. `--edit` costs nothing until `--live --yes`.

## The files

| file           | what it holds                                                    |
| -------------- | ---------------------------------------------------------------- |
| `arms.ts`      | the arms, the inheritance rule, the pre-registration             |
| `wire.ts`      | what each arm puts on the wire, sliced from garden's own sources |
| `tasks.ts`     | the sample, taken from `evals/fixtures.ts`                       |
| `measure.ts`   | the offline half                                                 |
| `live.ts`      | the judged half, and the key's three arms                        |
| `world.ts`     | the deterministic computer every tool is a window onto           |
| `edit-arm.ts`  | the edit axis: its sample, its world, both editors, its scoring  |
| `edit-live.ts` | the edit axis on the worker's own gateway, for the run that pays |
| `price.ts`     | the token arithmetic, the provider's rates, the break-even       |
| `report.ts`    | the tables and the baseline check                                |
| `selftest.ts`  | the checks running it cannot perform                             |

`NODE_OPTIONS=--conditions=development pnpm exec tsx evals/arms/selftest.ts`
