# The context-quality gate

`evals/harness.ts` asserts `modelCalls`, `delegatedCalls`, `tools`, `proposed`, `finalCatalogue`,
`status`, `verification`, `askedOwner`, `commandsRun`, `minCachePrefix`, `compactions`,
`minBriefSections`, `ownerMessageIntact`, `minToolResultFloor`, `holds`, `untrusted` and `replies`.
Every one of those is a count. None of them is an answer, and structurally none of them can be —
the model in that rig is a function of what garden just said, so a change that cuts the model's
recent window by 75% produces the identical scripted reply and reports 49/49.

That makes every change to `apps/worker/src/context.ts` unfalsifiable by the suite that guards it.
"49/49 still pass" measures step counts and token counts, not whether the agent can still find the
thing it needed four tool results ago.

This directory measures the other axis. It takes a long-running trajectory, compresses its earlier
portion through garden's own production path — `compactContext`, the squeeze, the floor,
`prepareModelContext`, `markCacheBreakpoints` — at a named configuration, and then asks questions
that can only be answered from the part that was compressed.

## Running it

```
pnpm eval:context                 # the whole matrix, deterministic, no key
pnpm eval:context -- --ci         # and check the committed baseline; exit 1 on a regression
```

| flag                | effect                                                      |
| ------------------- | ----------------------------------------------------------- |
| `--config a,b`      | only these configurations (see `configurations.ts`)         |
| `--trajectory 131k` | only trajectories whose id contains this                    |
| `--ci`              | check the committed baseline; exit non-zero on a regression |
| `--judge`           | also run the graded half; needs `OPENROUTER_API_KEY`        |
| `--yes`             | confirm the judged half's estimated spend                   |
| `--accept`          | rewrite `baseline.json` from this run                       |
| `--json out.json`   | also write the raw measurements                             |

The whole matrix is five trajectories against thirteen configurations and takes about fifty seconds,
almost all of it the 600-step trajectory. It needs
no key, no network and no model: the half of this that can gate is the half that always runs. Three
consecutive `--ci` runs produce byte-identical output, which is the property the baseline check
depends on and is worth re-establishing after any change here.

Every run opens with two provenance lines: which garden and which rig are running, and which
accepted the committed numbers. `--accept` writes that pair into `baseline.json` under `$stamp` —
the version and short revision from `buildIdentity()`, the same pair the box reports to its owner,
plus a digest of the six source files here that decide every number printed. The digest moves on any
edit to a probe, a trajectory, a configuration or the measurement, which is the point: a baseline
accepted under a different digest was accepted by a different instrument. That prints as a note and
never as a failure — adding a probe legitimately moves it, and the answer is `--accept` in the same
commit with the new figure quoted in the message.

Typechecking is wired: `evals/tsconfig.json` includes `context-quality/*.ts`, so `pnpm check`
compiles this directory. The run itself is deliberately not part of `pnpm check`, for the reason
`evals/run.ts` gives about itself. The self-checks for the judged half run separately:

```
NODE_OPTIONS=--conditions=development pnpm exec tsx evals/context-quality/selftest.ts
```

## The fourth trajectory, and the counter it exists to move

Three of the four trajectories carry exactly one mid-task owner message, of 600 characters, at step 13. That is the right fixture for the axis they were written for, and it is precisely why they
could not see the largest thing wrong with compaction on real work.

`planCompaction` may never condense a `user` message — the owner's corrections are the only
steering channel a running task has, and the text least able to correct a model is that model's own
account of it. So what the owner types accumulates for the life of the task, and once
`owner tokens > targetTailTokens − head tokens − OWNER_WINDOW_RESERVE_TOKENS` the region compaction
may touch holds nothing else and it returns `null` with **zero** candidates. A window that has been
compacted once is `[goal][brief][the owner's accumulated turns][recent work]`, because everything
else above the tail was condensed away last time — which is why the state is absorbing rather than
transient, and why a bound applied at the refusal cannot get out of it.

Replayed through this repository's own production path on a real 8,159-step Claude Code session
recorded on this checkout, with the owner's own text on it scaled ×2 to 171,196 characters:
**888 attempts, 237 successes, 651 refusals**, every refusal with no candidate at all. At ×3 it is
2,194 refusals of 2,667, the soft pass fires on 690 steps and the window sits over its own budget
on 11 of them. Unscaled — 95,192 characters, the most this owner has typed into one session — the
same replay makes 75 compactions and refuses none, which is the honest statement of where the
cliff is rather than where it was assumed to be.

Two additive changes make that visible here:

- **`compactionRefusals`** — the count of `compactContext` returning `null`. The loop used to write
  `if (outcome) { … }` and count only successes, so a run in which compaction was attempted 6,621
  times and worked 1,214 was indistinguishable from one in which it worked perfectly. It prints as
  the `refuse` column, `refused/attempted`, and `check` treats it as an exact ceiling: a refusal is
  never progress.
- **`pool-migration-131k-owner`** — thirteen pasted corrections of 14,000 characters, 182,000
  characters of owner text over sixty steps, which crosses that line around step 40. The phase is
  never declared, so every compaction is the budget trigger.

`owner-unbounded` is the bound on that accumulation switched off — its floor raised past any
window, which is the same thing. On the new trajectory it reads **5/10 refused against 0/2**, and
3,655,632 tokens per task against 3,471,774. On the other three it is byte-identical to `shipped`,
because there are only two owner messages there and both are reserved — which is the honest way
round: the row costs nothing where the mechanism is not exercised.

It also reads **4.41 availability against 4.12**, and that direction is not a defect in the bound.
`owner-earliest-middle` is the probe the bound removes by design; the unbounded row keeps it and
pays with 5 refusals in 10 attempts, which is the trade this rig exists to show rather than to
hide.

Three probes price what the bound costs and what it keeps, at the three positions a middle-out cut
distinguishes:

| probe                    | bound on | bound off | what it says                                          |
| ------------------------ | -------- | --------- | ----------------------------------------------------- |
| `owner-earliest-opening` | 5.0      | 5.0       | a cut keeps the head, so the opening survives         |
| `owner-earliest-middle`  | **0.0**  | 5.0       | the middle is what the bound removes — its whole cost |
| `owner-newest`           | 5.0      | 5.0       | the newest correction is never a candidate            |

`recall-owner-constraint` — the goal — stays at 5.0 in every configuration of every trajectory,
including this one, which is what makes it the control it is described as below.

## The four probe kinds

| kind         | what it asks                                             |
| ------------ | -------------------------------------------------------- |
| recall       | one specific fact stated once, early, and never repeated |
| artifact     | which files did we modify, and how                       |
| continuation | can the agent correctly resume the next step             |
| decision     | a choice made early, with the reason it was made for     |

The published work this design follows grades those 0–5 with a judge blinded to which method
produced the answer, and reports artifact tracking as the worst of the four — 2.45/5 even for the
winning method, with the stated conclusion that it "may need dedicated state tracking beyond
summarization". That is the conclusion garden took: the `ARTIFACTS WRITTEN` block is dedicated
state tracking, it is fed from where a write lands rather than from a summary, and the artifact
column reads 5.00 on every trajectory with it and 2.50 without — see "where the artifact loss
actually is" below for both numbers and what each mechanism is doing.

## What the deterministic score is, and what it is not

Each probe declares the literal spans that must survive into the prepared window for the question
to be answerable **at all**. The deterministic run checks those with `String.includes` and reports
the share retained, scaled onto the judge's 0–5 scale so both halves print in one column.

**That number is an upper bound on the judged score, not a quality score.** If the bytes are gone
the model cannot answer and the judged score is 0. If the bytes are present the model still has to
find them among a hundred thousand tokens, and may not. Availability is necessary and not
sufficient, and calling it quality would repeat the exact error this directory exists to correct.

What it is genuinely good for: availability is the axis a context configuration _moves_. Changing
`RECENT_DETAIL_MESSAGES` cannot make a model better at finding a fact; it can only decide whether
the fact is in the request at all. So the deterministic run measures the whole of the effect a
context change has, and the judge measures how much of it the model converts.

## Tokens per task, not tokens per request

A configuration that saves 20% per request and forces three more round trips is a loss. The
`tokens/task` column is every request's prompt summed, plus a stated model of what re-obtaining a
lost fact costs: one extra round trip at that step's whole prompt, plus the re-read result.

It is charged **only** for losses a tool call can repair. A decision the model reasoned its way to
and no longer has is not a re-read at any price; those are counted in the `unrec` column and no
token figure is allowed to imply they were paid for.

## The judged half

`--judge` asks a real model each probe from each compressed window, then has a second model grade
the answers under opaque labels in a seeded shuffle. The judge is never told which configuration
produced which answer, how many configurations exist, or that a comparison is happening.

The key is `OPENROUTER_API_KEY`, from the environment, exactly as `scripts/live-drill.mjs` takes
it. Nothing here invents a second credential path and nothing is committed. Missing on a
developer's machine, it explains and continues; missing on a CI runner where `--judge` was asked
for, it fails — the `GITHUB_ACTIONS` arm from `scripts/check-repository.mjs:115-120`, for the same
reason it exists there. An optional check that skips silently is a check that has stopped running
and nobody has noticed.

## The arithmetic this found, which is the reason the rig exists

`RECENT_DETAIL_MESSAGES` is counted in messages from the tail, and at request time the tail is not
the assistant turn. `refreshRuntimeContext` (agent.ts:9144, called at agent.ts:9798) re-pushes the
runtime block last on every step; `refreshActivePlan` pushes the plan block whenever its version
changed; `#noteStepBudget` pushes a notice twice a turn. So the assistant turn from `k` steps ago
survives only while `N >= 3 + 2k`, one more on a plan step and one more again on a budget-notice
step:

| `RECENT_DETAIL_MESSAGES` | ordinary step      | plan step          | budget-notice step |
| ------------------------ | ------------------ | ------------------ | ------------------ |
| 8 (shipped)              | 2 turns back       | 2 turns back       | 1 turn back        |
| 6                        | 1                  | 1                  | 1                  |
| 5                        | 1                  | 0 (this turn only) | 0                  |
| 4                        | 0 (this turn only) | 0                  | gone               |
| 2                        | gone               | gone               | gone               |

At 2 the model takes its next step having had the thoughts that produced the last one deleted from
the request, on every step. Nothing breaks — `openai-compatible.ts:781-793` already carries a
fallback for the inverse case — and no counter anywhere else in this repository moves.

## Six things that keep the rig honest

Each of these fails the run loudly and separately from the baseline check, and each exists because
the corresponding defect produces a plausible number rather than an error.

`configuration-fidelity` is the shipped constants written back explicitly, so it goes through the
whole patch-and-reimport path in `configurations.ts` and must land on identical numbers to
`shipped`, which imports the module directly. If a rename upstream made the substitution stop
matching, every configuration would secretly become the shipped one and every row would agree with
every other row — which reads like a finding.

`recall-owner-constraint` asks for the owner's own goal message, which every pass in
`prepareModelContext` protects by name. A configuration that loses it means the driver is broken,
not that a design decision was made. It survives even `starved`, which is what makes it worth
reading on the rows in between.

`degenerateConfigurations` refuses a control that has become a copy of `shipped`. A control on the
shipped value is byte-identical to shipped on every row and prints a reassuring `+0.00` that is an
identity rather than a measurement, so when the tree moves onto a control's value the run says so
instead of reporting agreement.
It only reads constants, and it deliberately exempts any row carrying edits, because whether an
edit still differs from the tree is a question about `context.ts` that only `patch` can answer.

**`patch`'s anchor count** is that answer, and it is the guard for the same drift in an edit row. An
edit whose anchor no longer occurs exactly once throws, and the whole run stops rather than printing
a row. This is also not hypothetical: `reasoning-in-transcript` proposed one line of `transcriptLine`
and that exact line then shipped, so the anchor vanished from the tree and the next run refused to
start. The error names a missing anchor rather than a shipped mechanism, so read it in that order —
"the tree has moved past this row", then "the anchor has a typo". The row was inverted to
`reasoning-dropped` rather than deleted, so the cost of the shipped line keeps being measured.

`compactionRefusals` refuses a run in which compaction was attempted and freed nothing more often
than the accepted numbers allow. It is the counter above, and it is here because it is the one
failure this rig structurally could not report: a window held up entirely by the deterministic
passes in `prepareModelContext` still produces a plausible availability score and a plausible token
count, and reads as a configuration choice rather than as a mechanism that has stopped.

The **frozen-column check** refuses a probe kind that scores the same in every configuration of
every trajectory. A column nothing can move is indistinguishable from a probe that has stopped
reading the window. `starved` — every character bound at its destructive end, never a candidate —
is what gives each kind something that genuinely takes its material away. Run without it, the
artifact column fails this check, which is how it was calibrated — and it is why `starved` gained
`ANCHOR_INDEX_CHARS: 0` when the anchor index landed, `ARTIFACT_LEDGER_ROWS: 0` when the ledger
did, and `OWNER_WINDOW_RESERVE_TOKENS: 1_000_000` when the bound on the owner's accumulated text
did. Each
was a new mechanism the row did not reach, and each saturated the column at 5.00 the day it
shipped.

## Where the artifact loss actually is, and what now holds it

The artifact probes ask for the five paths this task wrote, and for one fact about one of them that
exists in exactly one place.

A written path enters the window twice: in the head of the `file_write` call's arguments, and in the
head of the tool result (`{"ok":true,"path":…`). `truncateMiddle` keeps 62% of the remaining budget
as head. So every ordinary cut in this codebase — the recency bound, the descending older-output
floor, the compacted-argument bound — keeps the path, and the artifact column cannot be moved by the
squeeze at any value anyone would ship. It moves only when a bound is set low enough that the head
is shorter than the path itself (200/120/40, which is `starved`), or when a **compaction replaces
the message outright**.

Two mechanisms now carry a path across that compaction, and they are not the same kind of thing.

The **anchor index** harvests exact identifiers out of the span a compaction is about to drop and
appends them to the brief section after its own bound. It is opportunistic: it carries whatever
happens to look like an identifier, it carries nothing about what was done to the file, and it is
switched off by `ANCHOR_INDEX_CHARS: 0`. On this fixture it holds all five paths on its own, which
is why `artifact-files-touched` reads 5.00 everywhere except `starved` — and why the `anchorless`
row exists, since without it no shipped row can say anything about the second mechanism.

The **artifact ledger** is state. `ARTIFACTS WRITTEN` is re-rendered at the tail of the window on
every step from a durable per-turn record, and each row is written where the write lands — after
`runner.writeFile` has answered, with the byte count the workspace itself reported. It carries, per
path, the path, whether the whole file was replaced or named lines were edited, the bytes it last
weighed, and the step it last changed on. It is bounded at twelve paths and ninety-six characters of
path, and at the bound the oldest row is evicted and counted rather than the newest dropped.

Measured on this rig, at the commit that wired the block in, shipped configuration:

| trajectory                        | artifact column | tokens/task | prefix | own-think |
| --------------------------------- | --------------- | ----------- | ------ | --------- |
| `pool-migration-131k`, no block   | 2.50            | 2,981,016   | 75.6%  | 59/60     |
| `pool-migration-131k`, with block | **5.00**        | 2,978,862   | 76.8%  | 59/60     |
| `pool-migration-1m`, no block     | 2.50            | 3,687,561   | 78.9%  | 59/60     |
| `pool-migration-1m`, with block   | **5.00**        | 3,685,407   | 80.1%  | 59/60     |

And on `anchorless`, where the block is the only thing left carrying the set:
`artifact-files-touched` 3.00 → 5.00 (three of the five paths, then five), the artifact column
1.50 → 5.00, and 57,513 rework tokens → 0 on the small window, 84,806 → 0 on the large one.

It costs one message at the tail on every step after the turn's first write. That is nil at the
shipped `RECENT_DETAIL_MESSAGES = 8` and nil at 5 and 6, and it is 59/60 → 54/60 at `detail-4`,
which is a fact about a four-message reasoning window rather than about the block: the boundary is
counted from the tail, and the tail is now one longer. The table above under "the arithmetic this
found" should be read as `N >= 4 + 2k` once a turn has written anything.

The evidence that a re-rendered block is the right shape for this was already in the fixture before
the block existed: `continuation-plan-order`, a plan narrated in the agent's prose, scores 0.0 in
every configuration of `pool-migration-131k` and `pool-migration-1m`, and 5.0 in every configuration
of the other three. `continuation-plan-block`, the identical fact carried by the re-rendered plan
block, scores 5.0 in every configuration of every trajectory including `starved`.
`artifact-ledger-row` is the third member of that family — 5.00 everywhere, 0.00 exactly where the
block is switched off.

**Read the prose row as conditional and the block row as unconditional, and never write the prose
row down as "0.0 wherever compaction runs".** It was written down that way once, and it is wrong:
all five trajectories compact. The step of every successful compaction, printed through the shipped
module, is 30 on `pool-migration-131k` and on `pool-migration-1m` (their declared step, and nowhere
else), 52 on `-uncompacted`, 34 and 47 on `-owner`, and fifty-six times from step 34 on
`-owner-long`. The probe plants the plan at step 7 and asks for it at step 30, and the declared pass
runs before the window is read on the step it fires. So the two trajectories that read 0.0 are the
two whose compaction lands inside the probe's span, and the three that read 5.0 are the three whose
first compaction lands after the question was already answered.

That is a claim about scheduling, and it is testable rather than inferred: give `-owner` a
`declaredCompactionStep: 30` and its `continuation-plan-order` falls 5.0 → 0.0 while `-owner-long`,
untouched in the same run, stays at 5.0. The column is conditional, not saturated.

So what is measured here is not "prose is always lost" but "prose is lost whenever a compaction
crosses it, and a block never is". That asymmetry is the argument, and it is stronger than the
quantifier it replaced: nothing schedules a compaction to miss the fact you needed, and a fixture
whose compactions happen to fall late is not a design that keeps prose.

The design and the attacks are in `docs/design/ranked/LEDGER.md`.

## What the summariser is handed, and the pass this rig was asked to price

`evals/harness.ts` cannot falsify a change to `context.ts`. This directory can — but only up to the
summariser. Both halves of it compact with `extractiveSummariser`; `--judge` replaces the model that
_answers_ a probe and the model that _grades_ the answer, and nothing replaces the model that writes
the brief. So a change to `compactionRequest` — its instructions, what it asks to be preserved, the
lookup-terms line it demands — moves no number printed here. That is a real limit of the instrument
and it was previously written down the other way round.

What the rig can see is the summariser's **input**, and `summ-in` now counts it, through the
production `compactionRequest`, on every row. It is deliberately outside `tokens/task`: a different
model on a different route at a different price. It was the blind spot in the only cost figure this
directory published — compaction is the one stage here that spends a model call, and none of it was
counted.

| trajectory                        | compactions | `summ-in` | share of `tokens/task` |
| --------------------------------- | ----------- | --------- | ---------------------- |
| `pool-migration-131k`             | 1           | 15,181    | 0.51%                  |
| `pool-migration-1m`               | 1           | 14,285    | 0.39%                  |
| `pool-migration-131k-uncompacted` | 1           | 20,643    | 0.68%                  |
| `pool-migration-131k-owner`       | 2           | 37,273    | 1.07%                  |
| `pool-migration-131k-owner-long`  | 56          | 1,108,699 | 2.67%                  |

The compaction counts are the count of successful compactions, which is the denominator of the
`refuse` column on any row that refused nothing - `report.ts` renders `refused/attempted`, and
`owner-unbounded` at 389/550 is the row where the two part company. Every trajectory here
compacts, `-uncompacted` included: it declares no phase, so its one compaction is the budget
trigger, at step 52.

It earns its place on the first run: `owner-unbounded` on the 600-step trajectory spends **2,098,485**
summariser tokens against shipped's 1,108,699 — 1.89× the compaction bill for its 389 refusals, because
the inversion guard at the end of `compactContext` refuses _after_ the model call is already spent.
No other column said that. The ratio was 2.06× before `transcriptLine` carried reasoning, and both
sides of that are measured rather than remembered: the same configuration with the reasoning line
taken back out spends 1,919,565, so this row's own bill rose 9.3% where shipped's rose 19.2%.

**The multiple shrank and the waste did not move.** The waste is what this row spends over shipped,
and it went 989,181 → 989,786, which is +605 tokens on a bill of nearly a million. The row's own
+178,920 is the growth of the whole bill, refused calls and useful ones together, and it is not a
figure about waste at all - quoting it as one overstates the change by three hundred times. The
2.06× → 1.89× move is the denominator growing, not the bound getting cheaper. Why the two rates
differ is not measured here - the plausible reading is that an `owner-unbounded` transcript is
mostly owner text and owner messages carry no reasoning channel, and this rig has not been asked to
confirm that. The 1,919,565 was measured by running `owner-unbounded`'s constant and
`reasoning-dropped`'s edit as one temporary row and then removing it, which is the only way this
matrix can ask a two-mechanism question: every row here carries one mechanism.

### The pass, and why it is not built

Terminus 2 runs three agents at a context boundary: a summariser, a fresh-context questioner that has
seen no history and is told to ask at least five questions the summary does not answer, and a third
agent with the full history that answers them. The stated insight is that a summariser cannot know
what it forgot and a fresh reader can, because it can feel the gaps.

Priced against the figures above under a stated model — the questioner gets a system prompt, the goal
and the summary just written, so about a tenth of a summariser call; the answerer gets a system
prompt, the questions, and the transcript a **second** time, which is 57% to 94% of a summariser call
on these trajectories because the carried brief is the rest of it — the pass is **3 calls and 1.7× to
2.1× the tokens per compaction**. On the base that held when it was priced — a summariser stage at
0.26–2.24% of a task's prompt tokens — that put the pass at 0.55–4.7%. The base has since moved to
0.39–2.67%, because `transcriptLine` now carries the reasoning channel; the multiplier has not been
re-derived on the larger transcript, so treat 0.55–4.7% as the figure the decision was taken on and
not as a current one. See "The channel a compaction could not see, and now can" below. That is not a
tripling of anything, and the cost is not what decides it. Three things do.

1. **The gap it closes is mostly closed already, and closed by mechanisms that cannot forget.**
   Terminus 2 has one carrier across a boundary: the summariser's four headings. A compaction here
   writes nine — the summary body and the lookup-terms line, both model-written, and then the spill
   index, the anchor index, the citable-id footer and the reopen-these-skills line, plus the
   re-pushed artifact ledger, plan block and acceptance record. Seven of the nine are deterministic:
   they are harvested or re-rendered from state, so they carry what they carry whether or not anyone
   thought to ask. A fresh reader's five questions can simply fail to be asked.
2. **The rig has already run the head-to-head the pass would have to win.** `continuation-plan-order`
   — a plan narrated in the agent's prose — reads 0.0 in every configuration of the two trajectories
   whose compaction lands between the step it is narrated at (7) and the step it is asked about
   (30), and 5.0 in every configuration of the three whose first compaction lands at 34 or later.
   `continuation-plan-block`, the identical fact carried by a re-rendered block, reads 5.0 in every
   configuration of every trajectory including `starved`. Same fact, same trajectory, same step. The
   prose row is conditional on when the compaction lands and the block row is not conditional on
   anything, which is the whole of the asymmetry: the interrogation pass is a better summariser, and
   a block is not a summariser. Anything a long task must not lose belongs in a block, and that costs
   no calls at all.

   **This reason was first written down as "reads 0.0 in every compacted configuration", which the
   rig's own output contradicts, and it is reason 2 of the 3 that decline the pass — so it is worth
   being explicit about what survived the correction and what did not.** The quantifier did not
   survive: two of the three trajectories that read 5.0 do compact, twice and fifty-six times. The
   conclusion does, and the corrected form is the stronger one, because the block row has no
   condition on it at all while the prose row has one that no scheduler respects. An interrogation
   pass would have to beat a carrier that never depends on timing, using questions asked of a
   summary written at exactly the moment prose is at risk. The decline stands on the corrected
   sentence. Anyone re-opening it should re-open it on reason 1 or reason 3, not on this one.

3. **It cannot reach the one class that is genuinely lost, because that class never reaches the
   summariser stage at all.** See below. This is the finding, and it is not what was expected.

### The channel a compaction could not see, and now can

**This section used to describe a defect. The line has shipped, and the row is now inverted.**

`transcriptLine` used to render each condensed message from `content` and `toolCalls` alone, so the
agent's working out was discarded **before** a summarising model was called — while the summariser
was instructed to preserve "decisions taken and the reason for them, including approaches that were
tried and rejected", and garden's own preamble told the model to put exactly that material where
the summariser would not see it: "Working out - options weighed, what to try next, talking yourself
through it - goes in the reasoning channel, or nowhere." The harness was hiding the answer and then
asking for it.

Terminus 2's third agent is given the **full history**, so its advantage over its own summariser is
access, not attention. Ported faithfully here it would carry reasoning; ported as three calls over
the same `plan.transcript`, it would carry nothing new. The sharper statement of the research's
insight, on garden's terms, is that a summariser cannot summarise what it was never shown — and the
cheap answer to that is one line, not two more agents.

`transcriptLine` now appends ` [reasoned: ...]`, bounded by the same per-message limit as the
content. `trajectorySummary` deliberately does **not**: its output goes straight into the window
under a 12,000-character cap with no model in between, so every byte of reasoning there displaces
prose one for one. A summariser outage therefore still loses the reasoning, and still loses the tool
call arguments with it.

`reasoning-dropped` is that one line taken back out of a patched copy of `context.ts`, by the same
technique every other row uses. It is inverted rather than deleted for the reason `owner-unbounded`
and `anchorless` are switched off rather than removed: a cost written into prose stops being
re-measured the day it is written. It also makes a revert loud, which nothing else here would —
`summ-in` is checked as a ceiling and never as a floor, so putting `transcriptLine` back would lower
every bill and pass `--ci` in silence, but it would take this row's anchor out of the tree and
`patch` would refuse to run at all. So the shipped column below is now the left-hand one:

| trajectory                        | `summ-in` shipped | `reasoning-dropped` | what the line costs | availability |
| --------------------------------- | ----------------- | ------------------- | ------------------- | ------------ |
| `pool-migration-131k`             | 15,181            | 10,329              | +47.0%              | ±0.00        |
| `pool-migration-1m`               | 14,285            | 9,736               | +46.7%              | ±0.00        |
| `pool-migration-131k-uncompacted` | 20,643            | 18,718              | +10.3%              | ±0.00        |
| `pool-migration-131k-owner`       | 37,273            | 25,446              | +46.5%              | ±0.00        |
| `pool-migration-131k-owner-long`  | 1,108,699         | 930,384             | +19.2%              | ±0.00        |

Measured against the shipped tree rather than against a configuration edit, and every one of the ten
figures is what the configuration-edit measurement predicted, to the token — which is the check that
what landed is the line that was priced. Nothing else moved: availability, tokens per task,
unrecoverable losses, refusals, cache read share, prefix stability and own-think are identical on
both rows of all five trajectories.

**That is a statement about one run, and it is not what the committed diff of `baseline.json`
shows.** Do not read that diff as this line's footprint. The baseline it replaces was accepted at
`fb93b40`, so re-accepting here also absorbed everything the tree did between that commit and
`aa06ff6` and the worker edits still uncommitted beside this one: `tokensPerTask` moved on all sixty
pre-existing rows, `cacheReadShare` on eleven, and `compactionRefusals` fell 390 → 389 on
`pool-migration-131k-owner-long/owner-unbounded`. The largest of the token moves is 0.96%, which is
why the 2% band never fired and a baseline ten commits stale kept passing `--ci` - the re-accept is
what makes those moves visible, and it makes them visible all at once. None of them is the reasoning
line: shipped and `reasoning-dropped` agree on every one of those fields in the same run, and
`owner-unbounded` measured with the line taken back out still reads 389/550 refusals and the same
72,140,712 tokens per task. Availability, newest-reasoning steps and unrecoverable losses are
unchanged on all sixty rows against both references.

**`-uncompacted`'s +10.3% is the odd one out and it is not a cheaper trajectory — it is a clipped
measurement.** `compactionTranscript` bounds the whole transcript at 80,000 characters after
bounding each message, and that trajectory's single compaction is the only one in the matrix that
reaches the bound. Measured at the summariser call: 72,299 characters without the reasoning and
exactly 80,000 with it, so the entire +1,925 tokens is transcript and everything past the cap was
cut out of the middle by `truncateMiddle` instead of being billed. How much was cut is not something
this rig measures. The other four stay under: `131k` goes 38,746 → 58,154, `-owner` 50,104 → 79,216
at its first compaction and 42,201 → 60,396 at its second, and none of `-owner-long`'s fifty-six
reaches the cap. `-owner` at 79,216 is 784 characters from it.

So the honest reading of the cost is that four trajectories pay it in tokens and one pays it in
transcript. Availability did not move on any of them, which says the material displaced on
`-uncompacted` was not material a probe asked for — on this fixture. It does not say a cap that
starts binding is free.

As a share of a task's prompt tokens the summariser stage went from 0.26–2.24% to **0.39–2.67%**,
which is +0.06 to +0.43 percentage points per trajectory. The `1.7× to 2.1×` multiplier quoted above for the
three-pass design was derived on the pre-reasoning transcript and has **not** been re-derived here,
so the 0.55–4.7% projection that used it is now a projection from the wrong base; rescaling it
without re-deriving the multiplier would be arithmetic dressed as a measurement.

**Read the availability column as a null result about the instrument, not about the mechanism.**
`extractiveSummariser` keeps the front of every transcript line and the reasoning is appended at the
end of it, so this row moves the summariser's input and structurally cannot move its output. Whether
a real summarising model keeps the material is the question, and answering it needs the judged half
to compact with a real summariser — which it does not do. Do not quote the ±0.00 as evidence that
reasoning does not matter; quote it as evidence that this rig cannot yet tell. What decided the line
was not this column: it was that the harness had been asking for something it was itself hiding.

The production-side counterpart is `apps/worker/src/compaction.test.ts`, which pins the fact at the
production call site: sentinels planted in `content` and in `reasoning` on the same assistant
message, on the model path and on the deterministic one. Its assertions were written to fail loudly
when the line landed rather than to be quietly deleted, and they were inverted in the same commit.
