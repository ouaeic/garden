# The external-benchmark instrument

```
pnpm eval:bench                        self-test, THE END-TO-END JOIN, catalogue weights, coverage  (~2.5 s, offline)
pnpm eval:bench --score [--arm A]      drive a real AgentWorker against the shim and score it       (~2 s, offline)
pnpm eval:bench --observe              re-sweep all 73 fixtures, rewrite routes.json                (~10 s, offline)
pnpm eval:bench --routes               print the committed observation and coverage
pnpm eval:bench --terminal-bench ...   THE PAID RUN: real model, real containers, one record per task (section 5)
pnpm eval:bench --assemble ...         build a parity row from the records and upsert it into parity.csv (offline)
```

Everything but `--terminal-bench` is offline: no key, no network, no provider, no Docker. The paid
path refuses to start without a key and without every bound named on the command line. Not part of
`pnpm check`, like every other rig in `evals/`.

Benchmark results are recorded in [`parity.csv`](parity.csv). Each row identifies its model,
source revision, task set, run count and approval arm. Read those fields together: historical rows
are evidence about the recorded revisions, and do not establish the quality of the current checkout.
The arm ladder and its interpretation are described below.

`parity-wire.csv` is the other file here with a row in it, and it is **not a score**: see section
2.5. It is one task, solved by a scripted model, verified by a command in a real directory. Its
`model` column says `scripted-no-provider` in every row it will ever have.

---

## 1. The route-fidelity instrument, which is the point

### The failure it exists to prevent

garden's loop reaches its workspace through one client, constructed once from one global
`WORKSPACE_RUNNER_URL` (`apps/worker/src/agent.ts:291`). Point that URL at a shim over a benchmark
container and the whole loop - catalogue, approval floor, compaction, tools - runs against the task
with no change to `apps/` or `packages/`. That seam is not new; `evals/harness.ts` already
intercepts it for all 73 fixtures.

The trap in that design is that **a shim missing a route garden needs does not throw.** Three
production sites swallow the miss deliberately:

| site                                                 | what it does                     | what it costs a benchmark row                                                        |
| ---------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/worker/src/agent.ts:1301` `#toolchainSummary`  | `.catch(() => null)`             | the runtime block loses the line saying what the box can do with documents           |
| `apps/worker/src/agent.ts:1327` `#machineSummary`    | `.catch(() => null)`             | the block loses the three numbers that decide how a job is sized                     |
| `apps/worker/src/agent.ts:1354` `#workspaceSurfaces` | falls back to `UNKNOWN_SURFACES` | **the full catalogue**, about 11.7 kB per request, on a box that has neither surface |

Each is the right decision for a product: a task that will not start is worse than a task missing a
line. Each is fatal to a benchmark row, and the third is worst - it silently changes which
configuration was measured. The run completes, the score is real, and the row's declared arm is a
different box than the one that ran.

That is the same failure shape the design research rejected `BaseInstalledAgent` for. It is just as
available inside the design that replaced it, which is why this instrument was built first.

### What it does

`evals/harness.ts` grew one field - `RunOutcome.observedRoutes` - recording every runner route a
fixture reaches, modelled or not. That is a four-line additive change: a `string[]` on the stub's
state, one `push` at the top of `runnerResponse`, the field on the outcome, and the empty default.
Nothing in `evals/report.ts` reads it and no committed baseline row can move because of it.

(That is the first of two changes to `evals/harness.ts` this directory has needed. The second is
`Fixture.workspaceUrl`, and it is in section 2.5.)

**Why the harness had to be touched at all.** `RunnerState.unstubbed` already existed, but it is the
_complement_ of this list: it records only routes the stub does not model, and a shim built from it
would implement nothing, because that stub answers everything these fixtures reach. `runnerResponse`
is module-private, and `runFixture` installs its own `globalThis.fetch` for the duration of a run,
so an outer wrapper never sees runner traffic. There is no exported seam. The change is the
smallest one that reaches it.

### What it found, on the first run

**15 distinct routes across 73 fixtures.** The full artefact is `routes.json`.

```
  71  GET  /file          71  GET  /machine       71  GET  /surfaces     71  GET  /toolchain
  32  POST /checkpoints   27  POST /exec          25  GET  /usage        20  PUT  /file
  12  GET  /files          5  POST /browser/read-many                     4  GET  /image
   4  POST /toolchain/probe    2 POST /browser/search
   1  POST /browser/snapshot   1 POST /desktop/snapshot
```

Three findings, none of which a route list read off the runner's source would have produced:

1. **`GET /machine` is unstubbed in `evals/harness.ts` at `8d701a0`.** The route was added to the
   loop in `89185c6` and the fixture stub never grew an answer, so 71 of 73 fixtures currently
   measure a 404 on it. `evals/report.ts:165` catches it only because that rig has an explicit
   never-declarable assertion on `unstubbedRoutes`. **This is not this lane's to fix** - the fix
   moves committed baseline rows - but it is exactly the defect this instrument was built to find,
   and it was live in the tree before the instrument existed.
2. **`GET /image` is reachable on a box with no browser and no screen.** `image_read` is not one of
   the seven tools the catalogue gate withdraws (`apps/worker/src/tool-catalogue.test.ts:688-700`),
   so a benchmark container can still be asked to look at a PNG the task shipped. A shim built from
   the research's fourteen-route list would have been missing it.
3. **`web_search` and `parallel_web_read` survive a bare box too.** The comment at
   `tool-catalogue.test.ts:700` says so outright. So `POST /browser/search` and
   `POST /browser/read-many` are reachable on a container with no Chromium.

### The three categories, and why a shim needs all three

|                            | what it means                                                             | what the shim does                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **implemented** (21)       | the loop asks and the box can answer                                      | answers for real, over the backend                                                                                                                |
| **declared absent** (3)    | the loop can legitimately ask and this box genuinely lacks the capability | HTTP 503 with a message the _model_ reads: "This computer has no browser". Counted, and the count reaches the artefact as `absent_route_requests` |
| **miss** (everything else) | the loop asked for something nobody modelled                              | recorded in `shim.misses`, **and `parity.ts` refuses to emit a row for the run**                                                                  |

The middle category needs its own defence, because "answer it with an error" is the shape of every
bad shim. The difference is that a declared absence is a _statement the model can act on_, and a
miss is _silence it works around_. The seven surface-gated routes stay misses on purpose: on a box
answering `absent, absent` the catalogue gate withdraws their tools, so reaching one means the gate
did not hold, and that is a finding worth voiding a run for.

**The 501 status is not the guard.** `agent.ts` catches three of those into a shrug. `shim.misses`
is the guard, and `selftest.ts` proves it by driving an unimplemented route and then watching
`rowFrom` refuse.

### The honest limits of the observed set

- **It is a floor.** It is what these 73 scripted fixtures happened to drive. `routes.json` also
  carries `declaredButUnobserved` - paths `apps/worker/src` can build that no fixture reached
  (`/audio/prepare`, `/processes/stop-owner`) - and that scan is a text scan, advisory in both
  directions, because several call sites build their suffix from a variable.
- **It was taken on the wrong box, and the artefact says so.** `evals/harness.ts:1123` answers
  `/surfaces` with **both surfaces available**. A Terminal-Bench container has neither, so the
  observed set contains two routes a benchmark box cannot reach. `routes.json` records the sweep's
  surfaces and `coverageOf` subtracts the gated seven only when the sweep's box differed.
- **The subtraction is read, not measured.** This rig has not observed a run under
  `absent, absent` and watched those routes fail to appear. It reads the gate's own test and the
  single production line that applies it (`apps/worker/src/turn/claim.ts:245`). Doing better means
  changing the `/surfaces` answer every row in `evals/baseline.json` was measured under.

---

## 2. The shim

`shim.ts` speaks garden's runner protocol; `backend.ts` turns it into commands in a box.

**Two backends behind one three-method interface** (`ensure`, `exec`, `dispose`):

- **`local`** - a `mktemp` directory on this machine. No daemon, no image, no privilege. This is
  what makes the shim testable here and in CI. It is **not a sandbox**: commands run as this user
  with this user's network.
- **`docker`** - `docker exec` into a container the benchmark's own task definition created. Not
  exercised anywhere in this repository, because there is no container runtime on the machine it
  was written on. What _is_ proved is `dockerExecArgv`, a pure function holding every decision the
  backend makes that does not need a daemon: flag order, `--workdir`, `--env`, `sudo -n` (never a
  prompt), and that stdin is attached only when there is stdin.

### The join is driven, not assumed

`wiring.ts` constructs **`AgentRunnerClient` from `apps/worker/src/runner-client.ts`** - the
production class `apps/worker/src/agent.ts:291` builds and every tool call goes through - points it
at the shim's listening port and calls its real methods. `selftest.ts`'s route table sends requests
_this rig composed_ to answers _this rig parses_; if the shim's answers were shaped for the rig
rather than for garden, every check in that table would still pass. That is the
computed-and-unwired shape, and it is the one this programme keeps finding.

It earned its place on the first run: it was written expecting a five-line file to report five
lines, and garden's client said six. `services/workspace-runner/src/files.ts:376` counts
`1 + newlines`, so a file ending in a newline has an empty last line. `file_read` prints that
number to the model and `file_patch` addresses lines by it. A route table could not have found
that, because the rig would have been agreeing with itself.

It does not prove a whole turn on its own. That is section 2.5, which does.

**Every file operation is built on `exec`** rather than on `node:fs`. That is the load-bearing
choice: the file code proved by the local backend on a laptop is byte-identical to the code the
container backend runs. The alternative would have given the tested implementation and the shipped
one nothing in common but a type.

### What this shim necessarily drops

These belong in the artefact beside any score, and `parity.csv` has a `declared_drops` column for
them:

- **The capability token.** The real runner verifies a signed token per request
  (`services/workspace-runner/src/auth.ts:36`). This one binds loopback and verifies nothing.
- **The Landlock sandbox and the rlimits.** `execute()` applies both; this shim applies neither.
- **Per-call egress gating, on the local backend.** A child process here shares the host's network
  namespace and nothing in this rig can take that away. `isolates_network` is a column, and it is
  `false` for every local-backend row. On the docker backend it is a property of how the caller
  started the container, so it is a **parameter**, not an assumption: a shim that assumed `--network
none` would print "egress gated" on the strength of nothing.
- **Binary file writes.** `ExecCall.stdin` is a string in the runner's own schema, so the shim
  refuses a non-UTF-8 write by name rather than writing mangled bytes the verifier would read as
  wrong work.
- **Stopping background work.** `processes/stop-owner` answers honestly that it stopped nothing.
- **The EXIF strip on `/image`.** The real runner re-encodes; this one passes through a type the
  gateway already accepts and refuses anything else by name.

---

## 2.5 The join, whole: `--score`

Everything above this line was proved in isolation. `wiring.ts` drove garden's own client over the
socket, which is the wire; **no `AgentWorker` had ever run against this shim**, so the loop, the
tool dispatch, the approval floor, the acceptance hold and the score were each argued for and never
joined. That is the computed-and-unwired shape this programme has now shipped three times.
`score.ts` is the line that was never written.

```
pnpm eval:bench --score
```

builds the real `AgentWorker` the way `evals/harness.ts` builds it, points `WORKSPACE_RUNNER_URL` at
this shim's listening port, runs one task to completion against a real temporary directory, and
lets **a command in that directory** decide whether it was solved. It is also part of
`pnpm eval:bench` itself, as a self-test check rather than behind a flag: the join is the thing this
directory was three times found not to have, and a check that runs only when somebody remembers a
flag is a check that is not running when it breaks. It costs about 0.4 s.

**Real:** `AgentWorker.run`, the catalogue, the tool dispatch, the plan and acceptance holds, the
approval floor, compaction, the runner protocol, the shim, the box, the files, the verifier.
**Not real:** the model. It is a script, so no provider is called and nothing is billed. A benchmark
task whose solution is a fixed sequence of shell commands is exactly the shape a script can drive.

**So the row is not a score.** It goes to `parity-wire.csv`, never to `parity.csv`, through the same
`rowFrom` and the same 44 columns and the same refusals. `model` reads `scripted-no-provider`. The
file is rewritten by every `--score`, and `run_started_at` and `wall_seconds_mean` move each time -
it is a record of the last run, like `routes.json` is of the last sweep, not a tracked baseline.

### The one harness seam it needed

`Fixture.workspaceUrl` in `evals/harness.ts`. `runFixture` installs its own `globalThis.fetch` for
the duration of a run, so an outer wrapper never sees a runner request, and `WORKSPACE_RUNNER_URL`
was a module constant - there was no way to ask for the loop's runner traffic to leave the process.
The field is one config value and one branch, forwarding only URLs that start with it. Every fixture
in `evals/fixtures.ts` leaves it absent and is byte-for-byte unaffected: measured by running
`--observe --filter files-helper-script-then-run` against `HEAD`'s harness and against this one, and
diffing the output. Identical. `pnpm eval:gate --filter files-helper-script-then-run` passes.
`RunOutcome.approvalsRaised` was published beside it, because `askedOwner` is a boolean and
`approval_cards_fired_mean` is a column.

### What the join taught us, which is the point of building it

1. **Neither `status` nor `verification` separates a solved task from a knowingly unsolved one.**
   Break the solution so it writes the LINE COUNT (7) instead of the sum (1260) and the run reports
   `status=completed verification=verified`, **identically to the correct run**. The turn's own
   acceptance check ran in the box and failed, four times
   (`MAX_ACCEPTANCE_FAILURES`, `apps/worker/src/turn-bounds.ts:360`); past the ceiling
   `apps/worker/src/turn/finish.ts:320` appends the failures to `remainingRisks` and leaves the
   status the model declared. That is a defensible product decision - the owner reads the risks -
   and it means **a benchmark adapter that scored on either field would have scored that run 1**.
   The verifier in the box was the only thing that told them apart. It is the whole argument for
   taking the verdict from the box, and it is now measured rather than asserted.
2. **The surface gate is observed at last, not read.** `routes.ts` stated as its honest limit that
   nothing here had ever watched a run under `absent, absent` and seen the seven surface tools gone.
   The scored turn is that run, and `selftest.ts` asserts the catalogue it was offered - names
   derived through `agentToolsFor`, never listed. Point the runner back at the fixture stub, whose
   `/surfaces` says both available, and all seven reappear.
3. **The holds cost three steps on a wrong answer and one on a right one.** Re-measured on this
   checkout, 2026-09-03. Right answer: 5 model calls, **65,197 prompt tokens**, one
   `acceptance_hold` - the row `parity-wire.csv` holds, its own `input_tokens_mean`. Wrong answer
   (the solution broken to write the line count, 7): 8 calls, **106,823 prompt tokens**, one
   `acceptance_hold` and three `acceptance_failed`, driven through the same `scoreTask`. So
   discovering the work was wrong cost **41,626 tokens, 64% again on top of the whole task** -
   which on a paid run is real money, and which no other harness in this field pays or reports. It
   is also, on a benchmark, entirely wasted: the task scores 0 either way. That is the
   `shipped`-arm tax made concrete. (The same broken turn now reports `verification=checks_failed`
   where the 2026-09-02 measurement in item 1 saw `verified`; `status` still reads `completed` for
   both. The verdict is still the verifier's, for the reason item 1 gives.)
4. **The catalogue is 73% of what a short task's prompt weighs.** 65,197 prompt tokens over 5 calls,
   of which 9,474 per call is catalogue: the benchmark box's catalogue plus the `type: function`
   envelope each tool is sent in, **37,896 bytes on the wire**, over four (the rule section 3
   explains) - 47,370 of 65,197. On the _benchmark_ box, after the withdrawals; the provisioned box
   would be worse.
5. **The stationary watch caught this rig's own bug.** The first script read the whole window for a
   hold marker rather than the last message, so it answered the acceptance hold four times with
   byte-identical arguments. `NOTHING HAS CHANGED FOR 3 STEPS. Every one of them made the same call
   - set_acceptance - with byte-identical arguments.` The mechanism worked; the script was wrong.
6. **A missing route is a refused run, driven live.** Remove `POST /exec` from `IMPLEMENTED_ROUTES`
   and the real turn burns all 12 steps, hits `STEP BUDGET EXHAUSTED`, reports its acceptance check
   as "could not run" - and `rowFrom` refuses the row. `parity-wire.csv` is left with its header and
   nothing else, so a voided run cannot leave a stale row behind. Exit 1.

### What `--score` can do now, and still cannot

- **All three arms.** `Fixture.securityMode` mints the task under the arm's own mode and
  `Fixture.autoApprove` attaches the auto-approver for `unattended` (section 5 says exactly what it
  does and does not answer). `--arm` refuses anything outside the ladder rather than printing a row
  that names a configuration it was not measured under. The built-in task raises no card, so the
  three arms produce the same wire row; the arms differ on a task set that reaches the floor, which
  is what the paid ladder is for.
- **One task, and its solution is written here.** It measures the wire, not the agent.
- **`local` backend only.** The docker backend is exercised by the paid path (section 5) and not
  here, and `score.ts` refuses a task whose `origin` is not `builtin` on the local backend without
  `--trust-local` - a guard `backend.ts` had promised in prose since it was written and which
  existed nowhere in the repository until the join was built.

---

## 3. The counter-argument, and what garden should report

**The case against benchmarking garden at all.** Every design commitment it has is a cost on a
leaderboard, and the costs are garden's own and measurable:

- **The catalogue.** 36,926 bytes on every request of every turn on a benchmark box, measured
  below. A scaffold built only to solve coding tasks sends a fraction of that.
- **The approval floor.** garden stops for what the computer cannot take back even in
  `autonomous` (`apps/worker/src/approval-policy.ts:692`), and a card that fires with nobody at
  the keyboard parks the task in `awaiting_user`, which scores 0.
- **Compaction and the sandbox.** Both cost tokens and steps that a benchmark rewards nobody for.

The reference figures the design research quotes for other harnesses -
`docs/design/research-2026-08-25/benchmarks.md` - are **recorded there and not verified here**, and
this rig fetched nothing from the network. Two of them carry the argument if they hold: that the
published harness adapters run unsupervised by default, so **every leaderboard number in this field
is an unsupervised number**, and that the highest published scores came from a configuration with
no sandbox, no approval and no compaction. That configuration is a model under near-ideal harness
conditions. It is not a product anyone installs.

So: does garden benchmark the product, or a stripped configuration that is not the product?

**Both, and the resolution is to refuse to publish one number.** `parity.csv` carries an `arm`
column and the run refuses to emit a row whose arm is unset:

- **`shipped`** - `balanced`, nobody answering. A card that fires ends that task at 0. **This is
  what the owner installs.**
- **`autonomous`** - `autonomous`, still nobody answering. The irreducible floor still fires.
- **`unattended`** - autonomous plus an auto-approver. **This is what every other number in the
  field already is**, and the only arm comparable to a leaderboard.

**The gap between `shipped` and `unattended` is the price of the approval floor in benchmark points,
and nobody in this field publishes it.** That number is more interesting than garden's rank.
Publishing `unattended` alone would be dishonest; publishing `shipped` alone would be a number
nobody can compare to anything. A row with `approvals_auto_answered > 0` under any arm but
`unattended` is refused as fabricated.

### The catalogue charge, measured rather than repeated

The design research put the tax at 12,508 tokens per call and 39.9% of every prompt token the eval
suite bills. That is a real measurement of the **wrong box**: the eval harness answers `/surfaces`
with both surfaces available, and `claim.ts:212` withdraws `connector_action` outright on a box with
no connections. `catalogue.ts` measures the real thing through the production function, printed on
every run of this rig. Re-measured on this checkout, 2026-09-03:

|      bytes |    tokens | box                                                                                 |
| ---------: | --------: | ----------------------------------------------------------------------------------- |
|     55,363 |    13,841 | fully provisioned, all five connector kinds                                         |
|     48,722 |    12,181 | a browser and a screen, nothing connected - **what `evals/baseline.json` measures** |
|     39,172 |     9,793 | no browser, no screen, one connection                                               |
| **36,926** | **9,232** | no browser, no screen, nothing connected - **the benchmark box**                    |

Two corrections to what this table used to say, both found by re-deriving rather than re-reading:

- **The eval suite measures the second row, not the first.** `evals/harness.ts` answers
  `listConnectors` with nothing, so `connector_action` is withdrawn on its box exactly as it is on
  the benchmark box. The suite's own wire carries the catalogue resident at **49,903 bytes** (the
  figure `pnpm eval` prints on this checkout), which is this table's second row plus the `type: function` envelope
  each tool is sent in.
- **The token column is bytes over four, because that is what the baseline bills.** The suite
  counts catalogue tokens as `ceil(bytes / 4)` per request, and its maximum is **12,462** per call
  (`catalogueTokens / modelCalls`; 62 of the 73 rows sit exactly at it, every fixture whose calls
  all carry the catalogue) - not 12,508, which no row carries. The
  previous ratio, 55,673 over 12,508, divided the provisioned box's bytes by a different box's
  bytes-over-four and printed every token figure here 11% under the rule the suite uses. Four is
  the rule, so this table and the baseline agree on the box they share to within the catalogue's own
  drift: 49,903 / 4 = 12,476 on this checkout against the committed 12,462, which was accepted at
  `c0545ed` when the same wire carried 49,830 bytes (every tool description moves both numbers
  together, and `pnpm eval:bench` prints the current ones). It is still not a tokeniser: a paid row now carries the provider's
  own input count per call, and a whole-prompt ratio can be measured from it, but no provider
  counts the catalogue apart.

`selftest.ts` holds the top row within 2% of 55,290 (its anchor; 55,363 is inside the band), so a
catalogue that moves more than a description's worth fails this rig rather than leaving the table
stale. The four figures above are what `pnpm eval:bench` printed on 2026-09-03; the row a paid run
declares is measured again by that run, never copied from here.

So garden already withdraws about **18 kB, roughly a third of the catalogue**, before a benchmark
run starts - and it does it without being asked, because connectors and surfaces are gated per box.
The honest residual charge is **36,926 bytes, about 9,200 tokens per call, of non-withdrawable core
tooling**, which a purpose-built coding scaffold does not carry. Still a real charge. It does not
need the overstatement, and the arm ladder does not need a fourth `lean` rung - see the comment on
`Arm` in `parity.ts` for why that rung would have measured nothing.

**What garden should report: all three arms, with the knobs as columns.** An instrument that hides
its own configuration is the thing the research criticises the whole field for, and the columns
`security_mode`, `task_max_steps`, `self_continuations`, `max_compute_credits`, `surfaces_*`,
`catalogue_bytes`, `isolates_network`, `verifier_env` and `declared_drops` exist so that a reader
never has to go and find a default in a Python file.

---

## 4. The parity CSV

44 columns. Rows are **upserted**, never overwritten: a row with the same benchmark, task-set
digest, arm, model, build and run count replaces the old one, every other row is kept, and the
file is ordered by arm - shipped, autonomous, unattended - so the ladder reads top to bottom
(`results.ts`, `upsertRow`). The self-test re-renders the file every run to exercise the header and
keeps whatever rows it holds. Four disciplines are **enforced in code**, not documented:

1. **The aggregator is `mean` and it is a column.** `Max` over n attempts silently turns pass^1 into
   pass@k. `aggregate()` has no other mode.
2. **A missing result scores 0, never dropped.** `scoreOf` divides by the _declared_ `n_tasks`, not
   by what the run produced.
3. **Infra-failure classification is advisory and never moves the denominator.** It is its own
   column so a reader can discount the row themselves.
4. **A task that starts solved is not a task.** `scoreTask` runs the verifier _before_ the turn and
   refuses the run if it passes. Measured 2026-09-02 without it: a `seed` carrying the answer and a
   solution replaced by `true` scored 1, exited 0, and the self-test said "clean" - every other
   signal, `commandsRun` included, read exactly as on the honest run. This is the guard the
   Terminal-Bench loader will need on its first day, because a leaked answer arrives as a free
   point and looks like a score.

`score_std` is a **sample** standard deviation and is empty below two runs - a zero standard
deviation from one run is the most flattering lie available here. Three runs is the floor for a
credible row.

---

## 5. The paid command

Nothing above costs anything. Here is what does, as it is actually run.

### The command, as run

```
# on administrator@85.190.100.211
cd /home/administrator/tb/garden && \
NODE_OPTIONS=--conditions=development OPENROUTER_API_KEY=... ./node_modules/.bin/tsx evals/bench/run.ts \
    --terminal-bench --root /home/administrator/tb/terminal-bench/original-tasks \
    --model openrouter/z-ai/glm-5.3-flash \
    --max-spend-usd 20 --max-calls 50 \
    --results /home/administrator/tb/results --arm shipped --run-index 0 \
    --tasks <the 20 ids> --sudo
```

Prerequisites, all in place on that box: Docker (`sudo -n docker`, which is why `--sudo`), one
image per task built as `tb/<id>` from the benchmark's own Dockerfile (a missing image is a
refusal, never a zero), a provider key in the environment, and this checkout on Node 24.

**What each bound is.** `--max-spend-usd` is checked between tasks against the key's own running
total as the provider reports it, so a task under way is never cut and a half-run task is never
counted as a failure; with several processes on one key it is a **global** ceiling, every process
stops when the key as a whole reaches it. `--max-calls` is the step ceiling every task runs under,
and it is what the row's `task_max_steps` column then says - it used to be accepted and read by
nothing, so the first run said `--max-calls 120` and ran under the loader's own 50. Pass **50** for
the ladder so the rows are comparable with the first one. A step is one model call however many
tools it uses, and under `unattended` that includes the call a card was raised on: each re-entry
after an answered card is built one step shorter, so the ceiling bounds the model calls of the
whole task on every arm alike (see the auto-approver, item 4 below). The one call outside it on
every arm is the closing handoff a turn at its ceiling makes.

### The first reading, and what it cost

Terminal-Bench, 20 stratified tasks, GLM 5.3 Flash, arm `shipped`, garden `fbd5888`:

|                          |                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| score                    | **0.250**, 5 of 20 resolved                                                                  |
| cost, provider's account | **$0.4885** for the run                                                                      |
| steps                    | mean **19**, p95 **49** (the ceiling was 50; see `--max-calls` above)                        |
| wall clock               | **417 s** per task, sequential                                                               |
| how the 15 were lost     | **11 parked on a single approval card** with nobody at the keyboard, 1 upstream 504, 3 wrong |

The eleven cards are the floor doing its job, exactly as the comment on `Arm` in `parity.ts` said
it would, and they are the reason the ladder is the artefact and not the rank. Two defects in that
row were fixed on the way to this one: `backend` said `local` while every task ran in a container
(read off the backend now, `ScoredTask.ranIn`), and `input_tokens_mean` said 0 because the
harness's live branch never priced the request (the provider's own input count is now read off every
response's usage frame - the lead steps, the summariser, a specialist's steps, all of them, the same
calls `steps` counts and the per-call cost prices - and the cached share beside it).

**Cost per step, derived from that run.** GLM 5.3 Flash on this route is $0.075 per million input
tokens, $0.25 per million output and $0.015 per million cache reads, and the run saw **66-73% of
input tokens served from cache**. Over the 380 steps of the run (20 × 19) the $0.4885 is **$0.0013
a step on average**; the longer tasks, where the window has grown, cost **$0.0015-0.0020 a step**.
That is the figure to plan from, and it is why the README's earlier "$17, call it $40" was wrong by
35×: it assumed every task would run to a 120-step ceiling, and the measured mean was 19.

### The arm ladder: 3 runs × 3 arms × 20 tasks, from those figures

|              | per (arm, run)                                                                                                        | × 3 runs   |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| `shipped`    | $0.49 measured; 11 tasks park early and are cheap                                                                     | ~$1.50     |
| `autonomous` | the floor still fires on some of the 11; guess $0.50-1.00                                                             | ~$1.50-3   |
| `unattended` | every card answered, so the 11 run to a finish or the 50-step ceiling: up to 50 × $0.002 × 11 ≈ $1.10 on top of $0.49 | ~$3-5      |
| **total**    |                                                                                                                       | **~$6-10** |

Call it **$10, ceiling $20 per process**, which is what `--max-spend-usd 20` already says. Wall
clock is the real cost: 417 s × 20 tasks is **2.3 h per (arm, run)**, and `unattended` will be
longer because nothing parks early. Nine (arm, run) pairs sequential in one process is **~21 h**.

**Sequential within a process, parallel across processes.** `runFixture` installs its own
`globalThis.fetch` for the duration of a run, so one process runs one task at a time and two would
measure each other. Parallelism is several processes on **disjoint (arm, run-index) pairs**:

```
--arm shipped    --run-index 0 | 1 | 2
--arm autonomous --run-index 0 | 1 | 2
--arm unattended --run-index 0 | 1 | 2
```

nine processes on the 16-vCPU box, each with its own containers (the container name carries the
task id, so two processes must not share a task - which disjoint pairs guarantee), finishing in
**3-5 h** instead of a day. The key is shared, which is why cost had to stop being an account delta.

### Records and assembly: why the row is not written by the run

The run writes **one JSON per task as it finishes**, to `--results DIR/<arm>/run-<i>/<id>.json`,
with the loop's own events beside it in `<id>.events.jsonl` (the edit-format lane wanted the
`file_edit` refusals a real turn produces, and they are in the events and nowhere else). It writes
**no row**. A task whose record already exists is **skipped and printed as such**, so the same
command re-run after a crash resumes from where it stopped and a dead process loses one task, not
twenty. The row is built afterwards:

```
pnpm eval:bench --assemble --results DIR --arm A --runs 3 --tasks <the 20 ids> --root <task dir>
```

`results.ts` reads every record under `DIR/A/run-0..2`, puts a task with no record into its run at
`resolved: null` so `scoreOf` scores it 0 against the declared denominator **and prints which**,
refuses records from two boxes, two builds or two models (one box, one build, one model per row -
a single `backend`, `garden_commit` and `model` column cannot be true of a mixture), recomputes the
task-set digest from `--root` and refuses if the tasks on disk are not the tasks that were run, and
then hands the same `RowInput` the offline path builds to the same `rowFrom` with the same refusals.
The row is **upserted** into `parity.csv` by its key; the ladder's three rows sit in one file.

**Cost, twice.** The per-task figure printed and stored is the **provider's own per-call cost**,
read by the harness off a copy of every answered response's usage frame - the `cost` the route
puts beside `prompt_tokens` and `completion_tokens` - and summed (`RunOutcome.providerCostUsd`).
The input, cached and output token columns are read off the **same frames**, so the four columns
describe one set of calls: every request the loop sent, the compaction summariser, a vision
handoff and a delegated specialist's steps included, and not only the lead steps the loop writes a
`cost` event for (a live turn that compacted twice used to count 52 calls and sum the tokens of
50). A response with no frame - a stream cut before its last data frame - or a frame with no price
falls back to the ledger row the loop wrote for that call, and the task record says how many did
(`providerUsageFallbacks`; the per-task line prints it when it is not zero). That number belongs to
the task whatever else is running on the key. The account's running total is read when the process
opens and closes and printed as the whole-process check **with the discrepancy** - other processes
on the key, the provider's rounding, or a call the route did not price - and between tasks it is
the ceiling.

### The unattended arm: exactly what the auto-approver does

`unattended` is `autonomous` plus **an approver that answers every card approved with nobody
reading it, which is what every published leaderboard adapter is**. `Fixture.autoApprove` in
`evals/harness.ts` plays the owner's half of the production approval flow, step for step:

1. The turn parks as it does in production: `parkForApproval` creates the card with the argument
   hash, saves the trajectory, writes the task `awaiting_user` with its lease cleared, and
   `AgentWorker.run` returns. The harness's store stub now records the card as a row and answers
   `getApproval` with it - a pending row, which is what production returns for a card nobody has
   answered, so an offline fixture that parks is unchanged.
2. The harness marks the newest pending card **approved**, and claims the task back as `running`
   under its own worker id with a lease in the future. In production the API sets `queued` and a
   worker's poll makes it `running`; the harness has no poll loop, so it performs the claim itself.
3. `AgentWorker.run` is entered again, through the same construction. `claimTurn` decrypts the saved
   state, `resumeParkedTurn` finds the approval, checks the argument hash against the call, and
   executes the approved call before the loop goes on. `approvals_auto_answered` counts each
   re-entry; `approval_cards_fired_mean` keeps counting every card.
4. **The bound is model calls, counted by the harness, against `--max-calls`.** The loop's step
   counter advances only when a step completes, and a step that cards never does - so a resumed
   turn re-runs the same step number, the worker's own `TASK_MAX_STEPS` bounds nothing across
   entries, and a turn that carded on every call could have made the ceiling's worth of calls
   _and_ the ceiling's worth of re-entries (measured: ceiling 4, five model calls, all at step 0).
   A request the provider refused and the loop retried is a call no step number records either.
   So the harness re-enters only while its own count of every request that left the process is
   below the ceiling, and each re-entry is built with a ceiling one lower per card answered, so
   that a single entry cannot spend steps earlier entries already parked on. `task_max_steps` is
   then a true ceiling on provider calls under this arm exactly as under the others (plus the
   closing handoff a turn at its ceiling makes, which every arm pays). Reaching it is recorded on
   the task (`autoApproveCapReached`) rather than swallowed - a task that ends on its cap ends
   parked on the card it could not afford to answer. Measured in `approver.test.ts`: ceiling 4,
   four calls, three answered; ceiling 3 with the opening request refused, three calls, one
   answered.

**What it does not answer: a question.** `ask` parks the task `awaiting_user` too, but creates no
approval row - the answer is the owner's next message, not a yes. The harness answers only a
pending card, so a question park stays parked and that task scores what it scores. An auto-approver
is not an auto-owner, and a rig that typed an answer would be measuring its own prose.

`evals/bench/approver.test.ts` drives all of this through the real loop: a push that cards under
`autonomous` is answered once, the approved shell runs on the re-entry, and the turn finishes; with
nobody answering the same turn parks; a question is left parked.

### The arm ladder results

Measured 4 September 2026: `openrouter/z-ai/glm-5.3-flash`, the 20-task stratified subset
(task set sha `4cba057d3438a4bf`), step ceiling 50, one container per task, nine processes on
disjoint (arm, run-index) pairs on the 16-vCPU box, 3 runs per arm. The rows are in `parity.csv`
and were assembled from the records with `--assemble`; `score_std` is the sample standard
deviation over the three runs.

| arm          | n_runs | score_mean | score_std | cost_usd_mean | steps_mean | steps_p95 | wall_s_mean | cards_fired_mean | auto_answered | task_max_steps | garden_commit |
| ------------ | ------ | ---------- | --------- | ------------- | ---------- | --------- | ----------- | ---------------- | ------------- | -------------- | ------------- |
| `shipped`    | 3      | **0.200**  | 0.050     | 0.356         | 15.7       | 51        | 280         | 0.68             | 0             | 50             | 9f842f1       |
| `autonomous` | 3      | **0.317**  | 0.058     | 0.506         | 20.2       | 51        | 425         | 0.55             | 0             | 50             | bbc3a3e       |
| `unattended` | 3      | **0.467**  | 0.076     | 0.742         | 32.2       | 51        | 694         | 2.58             | 154           | 50             | bbc3a3e       |

**The gap between the first and the last row - 0.27 of a point - is the price of the approval
floor in benchmark points.** It is the number this instrument exists to publish, and the third row
is the only one comparable to a published leaderboard figure, because every published adapter runs
with its approval prompts switched off. Tasks resolved in every one of the three runs: 2 under
`shipped`, 4 under `autonomous`, 5 under `unattended`; nine tasks resolved in some runs and not
others, which is what a sample deviation of 0.08 looks like at n=3. Two `unattended` task-runs
ended on an infrastructure failure (an upstream timeout mid-response) and are scored 0, as
discipline 2 requires; the advisory column says so.

The whole ladder cost **$4.9** by the provider's own account - the first estimate of $6-10 above
was right to within its own range, and the earlier "$17, call it $40" for a single run was wrong
by an order of magnitude. Two of the nine (arm, run) pairs were first refused by the route-fidelity
guard: a model polled `processes/bg-started`, a session id nobody minted, and a task that started a
server had the loop ask `preview-check/8080`; both were shim gaps the runner would have answered,
fixed in `bbc3a3e`, and only those two tasks were re-run - which is why two rows name that commit
and one names its parent, and why the assembler accepts records from commits whose `apps`,
`packages` and `services` are byte-identical.

What the ladder also measured, from the events every record carries: the loop's repeated-failure
bound on `file_patch` ("has failed 3 times the same way") fired 9 times across the 180 task-runs,
on the editor as it stood before the anchored form shipped. The next ladder, on the build that
carries it, is the measurement of that change.

### After the ladder

**The parity row.** The same task set and the same model, run through the reference harness the
leaderboard names, 3 runs. At this model and these step counts that is a few dollars, not the
hundreds the earlier estimate said; the cost is the wall clock and the second harness's own setup.
Do not start at SWE-bench Verified: 500 instances at 3 runs is a different order of wall clock.

## Why this is not a gate

`pnpm eval:bench` exits non-zero on a self-test failure, on a route garden asks for that the shim
does not implement, or on the end-to-end task failing its verifier; `--score` exits non-zero when a
task does not resolve or when `rowFrom` refuses the row. So it is usable in CI on its own schedule.

It is deliberately not in `pnpm check`. The default run is about 2.5 s and drives one real turn;
`--observe` sweeps all 73 fixtures through the real `AgentWorker` and takes minutes. A suite that
blocks every commit is a suite somebody deletes the first week it is wrong about something - and
this one is deliberately coupled to the loop's own holds, which move for good reasons.
